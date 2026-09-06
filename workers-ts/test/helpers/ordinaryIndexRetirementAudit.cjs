// Generated DROP probes run only in the caller's newly-created isolated database.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async function auditOrdinaryRetirement({ api, models, previous, db, read, objects, dependencies, format }) {
  const { generateDrizzleJson, generateMigration } = api;
  const manifest = JSON.parse(readFileSync(join(__dirname, "../../audit/orm-ordinary-index-reconciliation.json"), "utf8"));
  const entries = manifest.entries.filter((entry) => entry.decision === "remove-redundant-orm-declaration");
  assert.deepEqual(entries.map((entry) => entry.key), ["store_order.so_order_id", "system_supplier.supplier_admin_id"]);
  const target = generateDrizzleJson(models, previous.id);
  const delta = await generateMigration(previous, target);
  assert.deepEqual([...delta].sort(), entries.map((entry) => `DROP INDEX "${entry.catalog.name}";`).sort()); // No CASCADE.
  const names = entries.map((entry) => entry.catalog.name);
  const data = async () => (await db.query(`SELECT 'order' AS source,to_jsonb(t) AS row FROM store_order t
    UNION ALL SELECT 'supplier',to_jsonb(t) FROM system_supplier t ORDER BY source,row`)).rows;
  const capture = async () => ({ catalog: await read(), objects: await objects(), dependencies: await dependencies(), rows: await data() });
  const shape = async (name) => (await db.query(`SELECT i.indrelid,i.indkey::text,i.indclass::text,i.indcollation::text,i.indoption::text,
    i.indnatts,i.indnkeyatts,i.indexprs::text,i.indpred::text,am.amname
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
    WHERE c.oid='public.${name}'::regclass`)).rows[0];
  const incoming = async (name) => (await db.query(`SELECT classid,objid,objsubid,deptype FROM pg_depend
    WHERE refclassid='pg_class'::regclass AND refobjid='public.${name}'::regclass ORDER BY classid,objid,objsubid,deptype`)).rows;
  const before = await capture();
  for (const entry of entries) {
    assert.deepEqual(before.catalog.indexes.find((row) => row.key === entry.key), entry.catalog);
    assert.deepEqual(before.catalog.indexes.find((row) => row.key === entry.replacementCatalog.key), entry.replacementCatalog);
    assert.deepEqual(await shape(entry.catalog.name), await shape(entry.replacementCatalog.name));
    assert.deepEqual(await incoming(entry.catalog.name), []); // Check, never assume from non-uniqueness.
  }
  const expectRemoved = (actual, baseline) => {
    assert.deepEqual(actual.catalog, { ...baseline.catalog, indexes: baseline.catalog.indexes.filter((row) => !entries.some((entry) => entry.key === row.key)) });
    assert.deepEqual(actual.objects, baseline.objects.filter((row) => !names.includes(row.relname)));
    assert.deepEqual(actual.dependencies, baseline.dependencies);
    assert.deepEqual(actual.rows, baseline.rows);
  };
  await db.exec("BEGIN");
  try {
    await db.exec(`INSERT INTO store_order(order_id,"unique",uid) VALUES('index-fixture-a','index-key-a',7),('index-fixture-b','index-key-b',8);
      INSERT INTO system_supplier(admin_id,supplier_name) VALUES(700,'index-supplier-a'),(701,'index-supplier-b');
      CREATE TABLE ordinary_index_fk_fixture(order_id varchar(64),admin_id integer,
        CONSTRAINT ordinary_index_order_fk FOREIGN KEY(order_id) REFERENCES store_order(order_id),
        CONSTRAINT ordinary_index_supplier_fk FOREIGN KEY(admin_id) REFERENCES system_supplier(admin_id));
      INSERT INTO ordinary_index_fk_fixture VALUES('index-fixture-a',700)`);
    const fixture = await capture();
    for (const [constraint, index] of [["ordinary_index_order_fk", "so_order_id_uq"], ["ordinary_index_supplier_fk", "supplier_admin_id_uq"]]) {
      assert.equal((await db.query(`SELECT conindid='public.${index}'::regclass AS exact FROM pg_constraint WHERE conname='${constraint}'`)).rows[0].exact, true);
    }
    for (const entry of entries) {
      await db.exec("SAVEPOINT retirement_probe");
      await db.exec(`CREATE VIEW ordinary_index_dependent_view AS SELECT 'public.${entry.catalog.name}'::regclass AS referenced_index`);
      assert.ok((await incoming(entry.catalog.name)).length > 0);
      await assert.rejects(db.exec(delta.join("\n")), { code: "2BP01" });
      await db.exec("ROLLBACK TO SAVEPOINT retirement_probe; RELEASE SAVEPOINT retirement_probe");
      assert.deepEqual(await capture(), fixture);
    }
    await db.exec("SAVEPOINT retirement_probe");
    await db.exec(delta[0]);
    await assert.rejects(db.exec("SELECT 1/0"), { code: "22012" });
    await db.exec("ROLLBACK TO SAVEPOINT retirement_probe; RELEASE SAVEPOINT retirement_probe");
    assert.deepEqual(await capture(), fixture);
    await db.exec(delta.join("\n"));
    expectRemoved(await capture(), fixture);
    for (const [query, code] of [
      ["INSERT INTO store_order(order_id) VALUES('index-fixture-a')", "23505"],
      ["INSERT INTO system_supplier(admin_id) VALUES(700)", "23505"],
      ["INSERT INTO ordinary_index_fk_fixture(order_id) VALUES('absent-fixture')", "23503"],
      ["INSERT INTO ordinary_index_fk_fixture(admin_id) VALUES(999999)", "23503"],
    ]) {
      await db.exec("SAVEPOINT retirement_probe");
      await assert.rejects(db.exec(query), { code });
      await db.exec("ROLLBACK TO SAVEPOINT retirement_probe; RELEASE SAVEPOINT retirement_probe");
    }
    assert.deepEqual((await db.query("SELECT order_id FROM store_order WHERE order_id='index-fixture-a'")).rows, [{ order_id: "index-fixture-a" }]);
    assert.deepEqual((await db.query("SELECT supplier_name FROM system_supplier WHERE admin_id=700")).rows, [{ supplier_name: "index-supplier-a" }]);
    // This proves the retained indexes can serve the exact equality lookups,
    // not a claim about production plans, cost or measured speed.
    await db.exec("SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off");
    for (const [query, index] of [["SELECT * FROM store_order WHERE order_id='index-fixture-a'", "so_order_id_uq"],
      ["SELECT * FROM system_supplier WHERE admin_id=700", "supplier_admin_id_uq"]]) {
      const plan = (await db.query(`EXPLAIN (FORMAT JSON,COSTS OFF) ${query}`)).rows[0]["QUERY PLAN"];
      const found = [];
      const visit = (node) => { if (node && typeof node === "object") { if (node["Index Name"]) found.push(node["Index Name"]); for (const value of Object.values(node)) visit(value); } };
      visit(plan);
      assert.ok(found.includes(index), JSON.stringify(plan));
    }
    expectRemoved(await capture(), fixture);
  } finally { await db.exec("ROLLBACK"); }
  assert.deepEqual(await capture(), before);
  await db.exec("BEGIN");
  try { await db.exec(delta.join("\n")); await db.exec("COMMIT"); }
  catch (error) { await db.exec("ROLLBACK"); throw error; }
  expectRemoved(await capture(), before);
  assert.deepEqual(await generateMigration(target, generateDrizzleJson(models, target.id)), []);
  console.log(`DB-009D2b3b ${format}: 2 exact ORM removals, restrictive dependencies, rollback, unique/query/FK preservation, no-op passed`);
  return { statements: delta.length, removedIndexes: entries.map((entry) => entry.key), dependentObjectRejections: 2,
    failureRollbackConfirmed: true, uniqueIndexesAndForeignKeysPreserved: true, fixtureRowsPreserved: 4,
    nonTargetOidsPreserved: true, equalityIndexPlansConfirmed: true, noOpConfirmed: true };
};
