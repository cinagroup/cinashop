const assert = require("node:assert/strict");
const { PgDialect } = require("drizzle-orm/pg-core");
const schema = require("./notValidSchema.cjs");
const { matchesDatabaseError } = require("./constraintNameAudit.cjs");
const marked = ["nv_amount_ck", "nv_message_ck", "nv_child_fk", "nv_tenant_amount_ck", "nv_tenant_fk"].sort();
const persist = value => JSON.parse(JSON.stringify(value));

module.exports = async function audit({ api, db, format }) {
  const snapshot = mode => persist(api.generateDrizzleJson(schema(mode)));
  const empty = persist(api.generateDrizzleJson({}));
  const baseline = snapshot("baseline");
  const target = snapshot("not-valid");
  // Keep the semicolon-bearing CHECK marked: upstream ordinary CHECK transport
  // predates this extension and cannot round-trip that expression. This fixture
  // promotes only the amount CHECK, without pretending to fix unrelated SQL.
  const validated = persist(target);
  delete validated.tables["public.nv_child"].checkConstraints.nv_amount_ck.notValid;
  const initial = await api.generateMigration(empty, target);
  const upgrade = await api.generateMigration(baseline, target);
  const definitions = Object.values(target.tables).flatMap(t => [...Object.values(t.checkConstraints), ...Object.values(t.foreignKeys)]);
  assert.deepEqual(definitions.filter(c => c.notValid).map(c => c.name).sort(), marked);
  assert.equal(definitions.find(c => c.name === "nv_ceiling_ck").notValid, undefined);
  assert.equal(initial.filter(s => / NOT VALID;$/.test(s)).length, 5);
  assert.equal(upgrade.length, 5);
  assert.ok(upgrade.every(s => /^ALTER TABLE /.test(s) && / NOT VALID;$/.test(s)));
  assert.ok(initial.filter(s => /^CREATE TABLE /.test(s)).every(s => !/NOT VALID/.test(s)));
  const uniqueAt = initial.findIndex(s => s.startsWith('CREATE UNIQUE INDEX "nv_parent_ref_uq"'));
  assert.ok(uniqueAt >= 0);
  assert.ok(initial.every((s, i) => !/FOREIGN KEY/.test(s) || i > uniqueAt));
  assert.ok(initial.some(s => s.includes('ALTER TABLE "nv_tenant"."nv_child" ADD CONSTRAINT "nv_tenant_amount_ck"')));
  assert.deepEqual(await api.generateMigration(target, snapshot("not-valid")), []);
  for (const value of [false, "true", 1, null]) {
    const malformed = persist(target);
    malformed.tables["public.nv_child"].checkConstraints.nv_amount_ck.notValid = value;
    await assert.rejects(api.generateMigration(empty, malformed));
    malformed.tables["public.nv_child"].checkConstraints.nv_amount_ck.notValid = true;
    malformed.tables["public.nv_child"].foreignKeys.nv_child_fk.notValid = value;
    await assert.rejects(api.generateMigration(empty, malformed));
  }
  const rows = async sql => (await db.query(sql)).rows;
  const constraints = () => rows(`SELECT ns.nspname AS schema, rel.relname AS table, con.conname AS name,
    con.convalidated AS validated, pg_get_constraintdef(con.oid, false) AS definition,
    con.oid::text, con.conindid::text
    FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
    JOIN pg_namespace ns ON ns.oid=rel.relnamespace
    WHERE ns.nspname IN ('public','nv_tenant') AND rel.relname IN ('nv_parent','nv_child')
    AND con.contype <> 'n' ORDER BY ns.nspname, rel.relname, con.conname`);
  const objects = () => rows(`SELECT ns.nspname AS schema,c.relname,c.oid::text,c.relfilenode::text
    FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE ns.nspname IN ('public','nv_tenant') AND c.relname LIKE 'nv_%' ORDER BY 1,2`);
  const data = () => rows("SELECT * FROM public.nv_child ORDER BY id");
  const rejection = async (sql, code, name) => assert.rejects(db.exec(sql), e => matchesDatabaseError(e, code, name));
  const shape = async () => {
    const actual = await constraints();
    assert.deepEqual(actual.filter(c => !c.validated).map(c => c.name).sort(), marked);
    for (const c of actual) assert.equal(/ NOT VALID$/.test(c.definition), !c.validated, c.name);
    assert.equal(actual.find(c => c.name === "nv_ceiling_ck").validated, true);
    return actual;
  };
  const writes = async () => {
    await db.exec("INSERT INTO public.nv_parent VALUES (1,'a',10)");
    await db.exec("INSERT INTO public.nv_child(id,corp,external,amount,message) VALUES (10,'a',10,2,'normal'),(11,'a',10,NULL,NULL)");
    await db.exec("INSERT INTO nv_tenant.nv_child VALUES (10,'a',10,2)");
    await rejection("INSERT INTO public.nv_child(id,corp,external,amount) VALUES (12,'a',10,-1)", "23514", "nv_amount_ck");
    await rejection("INSERT INTO public.nv_child(id,corp,external,amount,message) VALUES (12,'a',10,1,'forbidden;token')", "23514", "nv_message_ck");
    await rejection("INSERT INTO public.nv_child(id,corp,external,amount) VALUES (12,'other',10,1)", "23503", "nv_child_fk");
    await rejection("INSERT INTO nv_tenant.nv_child VALUES (12,'other',10,1)", "23503", "nv_tenant_fk");
    await rejection("INSERT INTO nv_tenant.nv_child VALUES (12,'a',10,-1)", "23514", "nv_tenant_amount_ck");
    await rejection("UPDATE public.nv_child SET amount=-1 WHERE id=10", "23514", "nv_amount_ck");
    await rejection("UPDATE public.nv_child SET external=999 WHERE id=10", "23503", "nv_child_fk");
    await db.exec("UPDATE public.nv_parent SET external=20 WHERE id=1");
    assert.deepEqual(await rows("SELECT external FROM public.nv_child WHERE id=10"), [{ external: 20 }]);
    assert.deepEqual(await rows("SELECT external FROM nv_tenant.nv_child WHERE id=10"), [{ external: 20 }]);
    await db.exec("DELETE FROM public.nv_parent WHERE id=1");
    assert.deepEqual(await rows("SELECT id FROM public.nv_child WHERE id IN (10,11)"), []);
    assert.deepEqual(await rows("SELECT id FROM nv_tenant.nv_child WHERE id=10"), []);
  };
  await db.exec("BEGIN");
  await db.exec(initial.join("\n"));
  const freshShape = (await shape()).map(({ oid, conindid, ...c }) => c);
  // Error probes need savepoints when the fixture itself lives in a transaction.
  await db.exec("COMMIT");
  await writes();
  // These exact self-created fixture objects live only in a disposable database.
  await db.exec('DROP TABLE nv_tenant.nv_child; DROP SCHEMA nv_tenant; DROP TABLE public.nv_child; DROP TABLE public.nv_parent;');
  await db.exec((await api.generateMigration(empty, baseline)).join("\n"));
  await db.exec(`INSERT INTO public.nv_parent VALUES (2,'old',30);
    INSERT INTO public.nv_child(id,corp,external,amount,message) VALUES
      (1,'old',30,-1,'normal'), (2,'old',30,1,'forbidden;token'), (3,'orphan',30,1,'normal');
    INSERT INTO nv_tenant.nv_child VALUES (1,'orphan',30,-1);`);
  const oldRows = await data();
  const oldTenantRows = await rows("SELECT * FROM nv_tenant.nv_child ORDER BY id");
  const oldObjects = await objects();
  const oldConstraints = await constraints();
  const eager = await api.generateMigration(baseline, validated);
  assert.equal(eager.find(s => /ADD CONSTRAINT "nv_amount_ck"/.test(s)).includes("NOT VALID"), false);
  await db.exec("BEGIN");
  await assert.rejects(db.exec(eager.join("\n")), e => e.code === "23514");
  await db.exec("ROLLBACK");
  assert.deepEqual(await constraints(), oldConstraints);
  assert.deepEqual(await objects(), oldObjects);
  assert.deepEqual(await data(), oldRows);
  assert.deepEqual(await rows("SELECT * FROM nv_tenant.nv_child ORDER BY id"), oldTenantRows);
  await db.exec("BEGIN");
  await db.exec(upgrade.join("\n"));
  await db.exec("COMMIT");
  const upgraded = await shape();
  assert.deepEqual(upgraded.map(({ oid, conindid, ...c }) => c), freshShape);
  assert.deepEqual(await data(), oldRows);
  assert.deepEqual(await rows("SELECT * FROM nv_tenant.nv_child ORDER BY id"), oldTenantRows);
  assert.deepEqual(await objects(), oldObjects);
  for (const c of oldConstraints) assert.deepEqual(upgraded.find(n => n.oid === c.oid), c);
  await rejection("UPDATE public.nv_child SET memo='changed' WHERE id=1", "23514", "nv_amount_ck");
  await rejection("UPDATE public.nv_child SET memo='changed' WHERE id=2", "23514", "nv_message_ck");
  // PostgreSQL permits an unrelated update to a pre-existing orphan FK row.
  await db.exec("UPDATE public.nv_child SET memo='orphan retained' WHERE id=3");
  for (const [table, name, code] of [["public.nv_child", "nv_amount_ck", "23514"],
    ["public.nv_child", "nv_message_ck", "23514"], ["public.nv_child", "nv_child_fk", "23503"],
    ["nv_tenant.nv_child", "nv_tenant_amount_ck", "23514"], ["nv_tenant.nv_child", "nv_tenant_fk", "23503"]]) {
    await rejection(`ALTER TABLE ${table} VALIDATE CONSTRAINT "${name}"`, code, name);
  }
  assert.deepEqual(await constraints(), upgraded);
  await writes();
  // Raw generators may propose DROP/ADD for changed definitions or validation.
  // These are proposals, NOT safe business upgrades; never auto-apply them.
  const changed = persist(target);
  changed.tables["public.nv_child"].checkConstraints.nv_amount_ck.value = '"nv_child"."amount" >= 1';
  const changedSql = await api.generateMigration(target, changed);
  assert.equal(changedSql.filter(s => /ADD CONSTRAINT "nv_amount_ck".* NOT VALID;/.test(s)).length, 1);
  assert.ok(changedSql.some(s => /DROP CONSTRAINT "nv_amount_ck"/.test(s)));
  await db.exec("BEGIN");
  await db.exec(changedSql.join("\n"));
  assert.equal((await constraints()).find(c => c.name === "nv_amount_ck").validated, false);
  await db.exec("ROLLBACK");
  assert.deepEqual(await constraints(), upgraded);
  const changedFk = persist(target);
  changedFk.tables["nv_tenant.nv_child"].foreignKeys.nv_tenant_fk.onDelete = "no action";
  const changedFkSql = await api.generateMigration(target, changedFk);
  assert.ok(changedFkSql.some(s => s.includes('ALTER TABLE "nv_tenant"."nv_child" ADD CONSTRAINT "nv_tenant_fk"')
    && s.includes('REFERENCES "public"."nv_parent"') && s.includes("ON DELETE no action") && s.endsWith(" NOT VALID;")));
  await db.exec("BEGIN");
  await db.exec(changedFkSql.join("\n"));
  await db.exec("INSERT INTO nv_tenant.nv_child VALUES (20,'old',30,1)");
  await rejection("DELETE FROM public.nv_parent WHERE id=2", "23503", "nv_tenant_fk");
  await db.exec("ROLLBACK");
  assert.deepEqual(await constraints(), upgraded);
  assert.deepEqual(await rows("SELECT * FROM nv_tenant.nv_child ORDER BY id"), oldTenantRows);
  const promoting = await api.generateMigration(target, validated);
  await db.exec("BEGIN");
  await assert.rejects(db.exec(promoting.join("\n")), e => ["23514", "23503"].includes(e.code));
  await db.exec("ROLLBACK");
  assert.deepEqual(await constraints(), upgraded);
  assert.deepEqual(await objects(), oldObjects);
  assert.deepEqual(await api.generateMigration(persist(target), snapshot("not-valid")), []);
  const introspectionQueries = [];
  const dialect = new PgDialect();
  const exit = process.exit;
  const log = console.error;
  const diagnostics = [];
  try {
    // The upstream progress renderer exits on an introspection rejection. Trap
    // only that exit in this disposable test process, never in application code.
    process.exit = code => { assert.equal(code, 1); throw new Error("expected introspection exit"); };
    console.error = (...args) => { diagnostics.push(args.join(" ")); };
    await assert.rejects(api.pushSchema(schema("not-valid"), { execute: async query => {
      const text = dialect.sqlToQuery(query).sql;
      assert.ok(/^\s*(SELECT|WITH)\b/i.test(text), "Introspection must not mutate the database");
      introspectionQueries.push(text);
      return db.query(text);
    } }, ["public", "nv_tenant"]), /expected introspection exit/);
  } finally { process.exit = exit; console.error = log; }
  assert.ok(diagnostics.some(message => message.includes("NOT VALID introspection is unsupported")));
  assert.ok(introspectionQueries.some(q => q.includes("AND NOT con.convalidated")));
  assert.deepEqual(await constraints(), upgraded);
  console.log(`DB-009E2A ${format}: 5 NOT VALID constraints, fresh/additive/persisted/no-op, invalid old rows, strict new writes, cascades, rollback and read-only introspection refusal passed`);
  return { initialStatements: initial.length, upgradeStatements: upgrade.length, markedConstraints: marked,
    freshAndUpgradeMatched: true, oldRowsPreserved: 4, oldObjectIdentitiesPreserved: true,
    validationRefusals: 5, nullChecksPreserved: true, crossSchemaCascadeConfirmed: true,
    invalidMetadataRejections: 8, noOpConfirmed: true, introspectionRefusedReadOnly: true };
};
