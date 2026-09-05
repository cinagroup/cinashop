// Isolated real API probes; no database URL is consumed. Preload denies sockets.
const assert = require("node:assert/strict");
const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { PGlite } = require("@electric-sql/pglite");
const { pgTable, text, integer, serial, uniqueIndex, unique, foreignKey } = require("drizzle-orm/pg-core");

async function main() {
  const format = process.argv[2];
  assert.ok(format === "cjs" || format === "esm");
  const api = format === "cjs" ? require("drizzle-kit/api")
    : await import(pathToFileURL(join(dirname(require.resolve("drizzle-kit")), "api.mjs")).href);
  const { generateDrizzleJson, generateMigration } = api;

  for (const keyKind of ["index", "constraint"]) {
    const parent = (key) => pgTable("audit_parent", {
      id: serial().primaryKey(), corp: text().notNull(), external: integer().notNull(),
    }, (t) => key ? [(keyKind === "index" ? uniqueIndex("audit_parent_key") : unique("audit_parent_key")).on(t.corp, t.external)] : []);
    const child = (name, ref) => pgTable(name, {
      id: serial().primaryKey(), corp: text().notNull(), external: integer().notNull(),
    }, (t) => ref ? [foreignKey({ name: `${name}_fk`, columns: [t.corp, t.external], foreignColumns: [ref.corp, ref.external] }).onDelete("cascade")] : []);
    const oldParent = parent(false);
    const baseline = generateDrizzleJson({ parent: oldParent, child: child("audit_child") });
    const newParent = parent(true);
    const target = generateDrizzleJson({ parent: newParent, child: child("audit_child", newParent), newChild: child("audit_new_child", newParent) }, baseline.id);
    const db = new PGlite();
    try {
      await db.exec((await generateMigration(generateDrizzleJson({}), baseline)).join("\n"));
      await db.exec("INSERT INTO audit_parent(corp,external) VALUES ('corp_a',1); INSERT INTO audit_child(corp,external) VALUES ('corp_a',1);");
      const delta = await generateMigration(baseline, target);
      const keyAt = delta.findIndex((sql) => keyKind === "index" ? sql.startsWith('CREATE UNIQUE INDEX "audit_parent_key"') : sql.includes('ADD CONSTRAINT "audit_parent_key" UNIQUE'));
      assert.ok(keyAt >= 0);
      for (const name of ["audit_child", "audit_new_child"]) {
        assert.ok(delta.findIndex((sql) => sql.includes(`ADD CONSTRAINT "${name}_fk"`)) > keyAt);
      }
      await db.exec(delta.join("\n"));
      assert.equal((await db.query("SELECT * FROM audit_child")).rows.length, 1);
      for (const name of ["audit_child", "audit_new_child"]) {
        await db.exec(`INSERT INTO ${name}(corp,external) VALUES ('corp_a',1)`);
        await assert.rejects(db.exec(`INSERT INTO ${name}(corp,external) VALUES ('corp_b',1)`), { code: "23503" });
      }
      const constraints = (await db.query("SELECT conname FROM pg_constraint WHERE conname='audit_parent_key'")).rows;
      assert.equal(constraints.length, keyKind === "index" ? 0 : 1);
      const stable = await generateMigration(target, { ...target, prevId: target.id, id: "00000000-0000-0000-0000-000000000002" });
      assert.deepEqual(stable, []); // Must not DROP a live index or convert it to a constraint.
      await db.exec("DELETE FROM audit_parent");
      assert.equal((await db.query("SELECT * FROM audit_child")).rows.length, 0);
      assert.equal((await db.query("SELECT * FROM audit_new_child")).rows.length, 0);
    } finally {
      await db.close();
    }
  }
  // Real declarations retain all standalone indexes across snapshot upgrades.
  const models = require("tsx/cjs/api").require("../../src/models/schema/index.ts", __filename);
  const previous = generateDrizzleJson(models);
  assert.equal(Object.keys(previous.tables).length, 263);
  assert.ok(previous.tables["public.store_pink"]);
  assert.equal(previous.tables["public.store_pink_full"], undefined);
  for (const [table, key] of [["work_member_current", "wmc_corp_id_uq"], ["work_client_current", "wcc_corp_external_userid_uq"], ["work_group_chat_current", "wgcc_corp_chat_id_uq"]]) {
    assert.equal(previous.tables[`public.${table}`].indexes[key].isUnique, true);
    assert.equal(previous.tables[`public.${table}`].uniqueConstraints[key], undefined);
  }
  assert.deepEqual(await generateMigration(previous, generateDrizzleJson(models, previous.id)), []);
  console.log(`DB-008 ${format}: initial, index/constraint upgrades, tenant FK, full-model no-op passed`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
