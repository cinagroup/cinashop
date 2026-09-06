// Full-schema default upgrade, separated from the existing six-stage index probe.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const root = join(__dirname, "../..");
const manifest = JSON.parse(readFileSync(join(root, "audit/orm-column-default-reconciliation.json"), "utf8"));
const sql = readFileSync(join(root, "migrations/0141_column_default_alignment.sql"), "utf8");
const entries = manifest.entries;
const { readCatalog, compareCatalogs } = require("tsx/cjs/api").require("../../scripts/data-migration/postgres-catalog-audit.ts", __filename);
const q = name => '"' + name.replaceAll('"', '""') + '"';
const targetNames = entries.map(e => e.key);

function matchesNullViolation(error, column) {
  assert.equal(error.code, "23502");
  const names = [error.column, error.column_name].filter(name => name !== undefined);
  assert.ok(names.length > 0 && names.every(name => name === column), "Missing or inconsistent NOT NULL column name");
  return true;
}

function insert(e, expression) {
  const extra = expression === undefined ? "" : `,${q(e.catalog.name)}`;
  const value = expression === undefined ? "" : `,${expression}`;
  let columns = "id", values = "2010000090";
  if (e.catalog.table === "store_order_outbox") { columns += ",event_key,aggregate_id,event_type"; values += ",'default-probe-key',7,'order.paid'"; }
  if (e.catalog.table === "system_queue_dead_letter") { columns += ",queue_name,message_id,body_sha256"; values += ",'default-probe-queue','default-probe-message',repeat('a',64)"; }
  return `INSERT INTO public.${q(e.catalog.table)}(${columns}${extra}) VALUES(${values}${value}) RETURNING ${q(e.catalog.name)} AS value,
    ${q(e.catalog.name)} IS NULL AS sql_null,pg_typeof(${q(e.catalog.name)})::text AS type`;
}

async function verifyDefaultWrites(db) {
  await db.exec("BEGIN");
  const run = async (e, expression, expected, code) => {
    await db.exec("SAVEPOINT default_write");
    try {
      if (code) await assert.rejects(db.query(insert(e, expression)), error => code === "23502" ? matchesNullViolation(error, e.catalog.name) : (assert.equal(error.code, code), true));
      else assert.deepEqual((await db.query(insert(e, expression))).rows, [{ value: expected, sql_null: false, type: e.catalog.type.startsWith("numeric") ? "numeric" : e.catalog.type }]);
    } finally { await db.exec("ROLLBACK TO SAVEPOINT default_write; RELEASE SAVEPOINT default_write"); }
  };
  try {
    for (const e of entries) {
      const expected = e.catalog.type === "jsonb" ? {} : e.catalog.type === "text" ? "" : "0.00";
      await run(e, undefined, expected);
      await run(e, "DEFAULT", expected);
      await run(e, "NULL", undefined, "23502");
      const explicit = e.catalog.type === "jsonb" ? `'{"nested":{"null":null,"list":[1,"two"]}}'::jsonb`
        : e.catalog.type === "text" ? "repeat('1,',100)" : "12.345";
      const value = e.catalog.type === "jsonb" ? { nested: { null: null, list: [1, "two"] } } : e.catalog.type === "text" ? "1,".repeat(100) : "12.35";
      await run(e, explicit, value);
      await db.exec("SAVEPOINT default_write");
      await db.exec(insert(e, explicit));
      const updated = await db.query(`UPDATE public.${q(e.catalog.table)} SET ${q(e.catalog.name)}=DEFAULT WHERE id=2010000090 RETURNING ${q(e.catalog.name)} AS value`);
      assert.deepEqual(updated.rows, [{ value: expected }]);
      await db.exec("ROLLBACK TO SAVEPOINT default_write; RELEASE SAVEPOINT default_write");
      if (e.catalog.type === "jsonb") await run(e, "'null'::jsonb", null); // JSON null is not SQL NULL; preserve existing DB semantics.
      if (e.catalog.type.startsWith("numeric")) {
        await run(e, "9999999999.99", "9999999999.99");
        await run(e, "10000000000", undefined, "22003");
      }
    }
  } finally { await db.exec("ROLLBACK"); }
  return { omittedDefaults: 4, explicitDefaults: 4, explicitValues: 4, sqlNullRejections: 4, updateDefaults: 4,
    jsonNullPreserved: 2, numericRoundingAndBoundsConfirmed: true, textLengthPreserved: true };
}

async function auditColumnDefaults({ api, models, format, database }) {
  const snapshot = api.generateDrizzleJson(models), old = structuredClone(snapshot);
  for (const e of entries) {
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot.tables[`public.${e.catalog.table}`].columns[e.catalog.name])), e.snapshotColumn);
    assert.deepEqual({ ...e.previousSnapshotColumn, default: e.snapshotColumn.default }, e.snapshotColumn);
    old.tables[`public.${e.catalog.table}`].columns[e.catalog.name] = structuredClone(e.previousSnapshotColumn);
  }
  const target = api.generateDrizzleJson(models, old.id);
  const generated = await api.generateMigration(old, target);
  assert.deepEqual([...generated].sort(), entries.map(e => `ALTER TABLE ${q(e.catalog.table)} ALTER COLUMN ${q(e.catalog.name)} SET DEFAULT ${e.catalog.default};`).sort());
  const initial = await api.generateMigration(api.generateDrizzleJson({}), old);
  const db = database ?? new PGlite();
  const read = () => readCatalog(async query => (await db.query(query)).rows);
  const capture = async () => ({
    catalog: await read(),
    objects: (await db.query(`SELECT c.oid,c.relname,c.relkind,c.relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.oid`)).rows,
    constraints: (await db.query(`SELECT c.oid,c.conname,c.conrelid,c.conindid,c.confrelid FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY c.oid`)).rows,
    defaults: (await db.query(`SELECT d.oid,d.adrelid,d.adnum,t.relname||'.'||a.attname AS key,pg_get_expr(d.adbin,d.adrelid) AS expression
      FROM pg_attrdef d JOIN pg_class t ON t.oid=d.adrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE n.nspname='public' ORDER BY d.oid`)).rows,
    dependencies: (await db.query(`SELECT d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype FROM pg_depend d
      WHERE d.refclassid='pg_class'::regclass AND d.refobjid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')
      AND NOT (d.classid='pg_attrdef'::regclass AND d.objid IN (SELECT x.oid FROM pg_attrdef x JOIN pg_class t ON t.oid=x.adrelid JOIN pg_attribute a ON a.attrelid=x.adrelid AND a.attnum=x.adnum
        WHERE (t.relname,a.attname) IN (('store_order_outbox','payload'),('store_seckill','time_id'),('system_queue_dead_letter','body'),('user_brokerage_frozen','price'))))
      ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype`)).rows,
    triggers: (await db.query(`SELECT t.oid,to_jsonb(t) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY t.oid`)).rows,
    rows: (await db.query(`SELECT 'outbox' AS source,to_jsonb(t) AS row FROM store_order_outbox t UNION ALL SELECT 'dead-letter',to_jsonb(t) FROM system_queue_dead_letter t
      UNION ALL SELECT 'seckill',to_jsonb(t) FROM store_seckill t UNION ALL SELECT 'frozen',to_jsonb(t) FROM user_brokerage_frozen t ORDER BY source,row`)).rows,
  });
  const alignedCatalog = catalog => ({ ...catalog, columns: catalog.columns.map(row => entries.find(e => e.key === row.key)?.catalog ?? row) });
  const expectAligned = (after, before) => {
    assert.deepEqual(after.catalog, alignedCatalog(before.catalog));
    for (const key of ["objects", "constraints", "dependencies", "triggers", "rows"]) assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(after.defaults.filter(e => !targetNames.includes(e.key)), before.defaults.filter(e => !targetNames.includes(e.key)));
    for (const e of entries) assert.equal(after.defaults.find(d => d.key === e.key)?.expression, e.catalog.default);
  };
  const rejectionCases = [];
  try {
    await db.exec(initial.join("\n"));
    const initialState = await capture();
    for (const e of entries) assert.deepEqual(initialState.catalog.columns.find(c => c.key === e.key), e.previousCatalog);
    await db.exec("BEGIN");
    try {
      for (const e of entries.filter(e => e.catalog.type === "jsonb")) {
        await db.exec("SAVEPOINT default_probe");
        await assert.rejects(db.query(insert(e)), error => matchesNullViolation(error, e.catalog.name));
        await db.exec("ROLLBACK TO SAVEPOINT default_probe; RELEASE SAVEPOINT default_probe");
      }
      // SET DEFAULT NULL is normalized by the engine to no pg_attrdef entry.
      // It is the known old state, not a distinct unknown expression to reject.
      await db.exec("ALTER TABLE system_queue_dead_letter ALTER COLUMN body SET DEFAULT NULL");
      assert.equal((await db.query(`SELECT count(*)::integer AS count FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
        WHERE a.attrelid='public.system_queue_dead_letter'::regclass AND a.attname='body'`)).rows[0].count, 0);
      assert.deepEqual(await capture(), initialState);
      await db.exec(`INSERT INTO store_order_outbox(id,event_key,aggregate_id,event_type,payload) VALUES
        (2010000001,'default-existing-a',7,'order.paid','{"orderId":7,"orderNo":"old-a"}'),(2010000002,'default-existing-b',8,'order.paid','{"orderId":8,"orderNo":"old-b"}');
        INSERT INTO system_queue_dead_letter(id,queue_name,message_id,body,body_sha256) VALUES
        (2010000001,'default-existing','a','{"test":[1,null]}',repeat('a',64)),(2010000002,'default-existing','b','{"test":"b"}',repeat('b',64));
        INSERT INTO store_seckill(id,time_id) VALUES(2010000001,'1,2'),(2010000002,'7');
        INSERT INTO user_brokerage_frozen(id,price) VALUES(2010000001,12.345),(2010000002,9999999999.99);
        CREATE SEQUENCE default_evaluation_probe MINVALUE 0 START WITH 0`);
      const reject = async (name, setup) => {
        const before = await capture();
        await db.exec("SAVEPOINT default_probe");
        try { await db.exec(setup); await assert.rejects(db.exec(sql), /0141/, name); rejectionCases.push(name); }
        finally { await db.exec("ROLLBACK TO SAVEPOINT default_probe; RELEASE SAVEPOINT default_probe"); }
        assert.deepEqual(await capture(), before);
      };
      for (const [name, setup] of [
        ["json-unknown-default", "ALTER TABLE store_order_outbox ALTER COLUMN payload SET DEFAULT '{\"unknown\":1}'::jsonb"],
        ["json-null-literal-default", "ALTER TABLE system_queue_dead_letter ALTER COLUMN body SET DEFAULT 'null'::jsonb"],
        ["text-missing-default", "ALTER TABLE store_seckill ALTER COLUMN time_id DROP DEFAULT"],
        ["numeric-missing-default", "ALTER TABLE user_brokerage_frozen ALTER COLUMN price DROP DEFAULT"],
        ["numeric-nonzero-default", "ALTER TABLE user_brokerage_frozen ALTER COLUMN price SET DEFAULT 1"],
        ["nullable", "ALTER TABLE user_brokerage_frozen ALTER COLUMN price DROP NOT NULL"],
        ["generated-column", "ALTER TABLE store_order_outbox DROP COLUMN payload; ALTER TABLE store_order_outbox ADD COLUMN payload jsonb GENERATED ALWAYS AS ('{}'::jsonb) STORED NOT NULL"],
        ["wrong-precision", "ALTER TABLE user_brokerage_frozen ALTER COLUMN price TYPE numeric(14,2)"],
        ["wrong-collation", "ALTER TABLE store_seckill ALTER COLUMN time_id TYPE text COLLATE \"C\""],
        ["missing-column", "ALTER TABLE user_brokerage_frozen RENAME COLUMN price TO old_price"],
        ["missing-table", "ALTER TABLE user_brokerage_frozen RENAME TO old_frozen"],
        ["missing-schema", "SET LOCAL search_path TO missing_default_schema"],
        ["inherited-table", "CREATE TABLE default_inherited_child() INHERITS(user_brokerage_frozen)"],
        ["unknown-default-not-evaluated", "ALTER TABLE user_brokerage_frozen ALTER COLUMN price SET DEFAULT nextval('default_evaluation_probe')"],
      ]) await reject(name, setup);
      assert.deepEqual((await db.query("SELECT last_value::text,is_called FROM default_evaluation_probe")).rows, [{ last_value: "0", is_called: false }]);
      // Real column views and ID foreign keys cannot be removed/rebuilt by default alignment.
      for (const [i, e] of entries.entries()) await db.exec(`CREATE VIEW default_view_${i} AS SELECT id,${q(e.catalog.name)} FROM public.${q(e.catalog.table)};
        CREATE TABLE default_child_${i}(parent_id integer REFERENCES public.${q(e.catalog.table)}(id)); INSERT INTO default_child_${i} VALUES(2010000001)`);
      const fixture = await capture();
      const alter = "EXECUTE format('ALTER TABLE ONLY %I.%I ALTER COLUMN %I SET DEFAULT %s',target_schema,item.table_name,item.column_name,item.target_default);";
      assert.ok(sql.includes(alter));
      await db.exec("SAVEPOINT default_probe");
      await assert.rejects(db.exec(sql.replace(alter, alter + "\n      PERFORM 1/0;")), { code: "22012" });
      await db.exec("ROLLBACK TO SAVEPOINT default_probe; RELEASE SAVEPOINT default_probe");
      assert.deepEqual(await capture(), fixture);
      // Execute the actual generator proposal as a separately rolled-back equivalence proof.
      await db.exec("SAVEPOINT default_probe");
      await db.exec(generated.join("\n"));
      expectAligned(await capture(), fixture);
      await db.exec("ROLLBACK TO SAVEPOINT default_probe; RELEASE SAVEPOINT default_probe");
      assert.deepEqual(await capture(), fixture);
      await db.exec(sql);
      expectAligned(await capture(), fixture);
      for (const [i, e] of entries.entries()) {
        assert.equal((await db.query(`SELECT count(*)::integer AS count FROM default_view_${i}`)).rows[0].count, 2);
        assert.deepEqual((await db.query(`SELECT * FROM default_child_${i}`)).rows, [{ parent_id: 2010000001 }]);
        await db.exec("SAVEPOINT default_probe");
        await assert.rejects(db.exec(`INSERT INTO default_child_${i} VALUES(2010000999)`), { code: "23503" });
        await db.exec("ROLLBACK TO SAVEPOINT default_probe; RELEASE SAVEPOINT default_probe");
      }
      const aligned = await capture();
      await db.exec(sql);
      assert.deepEqual(await capture(), aligned); // Includes every pg_attrdef OID on a no-op.
    } finally { await db.exec("ROLLBACK"); }
    assert.deepEqual(await capture(), initialState);
    await db.exec("BEGIN");
    try {
      await db.exec("CREATE SCHEMA default_scope; CREATE TEMP TABLE store_order_outbox(id integer)");
      for (const e of entries) await db.exec(`CREATE TABLE default_scope.${q(e.catalog.table)}(${q(e.catalog.name)} ${e.catalog.type} NOT NULL
        ${e.previousCatalog.default === null ? "" : `DEFAULT ${e.previousCatalog.default}`})`);
      await db.exec("SET LOCAL search_path TO default_scope,pg_temp,public");
      await db.exec(sql);
      assert.deepEqual((await db.query(`SELECT t.relname||'.'||a.attname AS key,pg_get_expr(d.adbin,d.adrelid) AS value
        FROM pg_attrdef d JOIN pg_class t ON t.oid=d.adrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.adnum WHERE n.nspname='default_scope' ORDER BY key`)).rows,
      entries.map(e => ({ key: e.key, value: e.catalog.default })));
      await db.exec(sql);
      await db.exec("SET LOCAL search_path TO public,pg_temp");
      assert.deepEqual(await capture(), initialState);
    } finally { await db.exec("ROLLBACK"); }
    assert.deepEqual(await capture(), initialState);
    await db.exec("BEGIN");
    try {
      await db.exec(generated[0]); // Mixed old/canonical defaults.
      await db.exec("CREATE TEMP TABLE store_order_outbox(id integer); SET LOCAL search_path TO public,pg_temp");
      await db.exec(sql);
      assert.deepEqual((await read()).columns, alignedCatalog(initialState.catalog).columns);
      assert.equal((await db.query("SELECT to_regclass('pg_temp.store_order_outbox') IS NOT NULL AS kept")).rows[0].kept, true);
    } finally { await db.exec("ROLLBACK"); }
    assert.deepEqual(await capture(), initialState);
    await db.exec("BEGIN");
    try { await db.exec(sql); await db.exec("COMMIT"); }
    catch (error) { await db.exec("ROLLBACK"); throw error; }
    expectAligned(await capture(), initialState);
    const aligned = await capture();
    await db.exec(sql);
    assert.deepEqual(await capture(), aligned);
    const writes = await verifyDefaultWrites(db);
    assert.deepEqual(await capture(), aligned);
    assert.deepEqual(await api.generateMigration(target, api.generateDrizzleJson(models, target.id)), []);
    const diff = compareCatalogs(initialState.catalog, await read());
    for (const [kind, changes] of Object.entries(diff)) for (const [change, rows] of Object.entries(changes)) {
      if (kind === "columns" && change === "changed") assert.deepEqual(rows.map(row => [row.key, row.fields]), entries.map(e => [e.key, ["default"]]));
      else assert.deepEqual(rows, []);
    }
    console.log(`DB-009E1 ${format}: 4 default-only alignments, ${rejectionCases.length} drift refusals, 8 rows/4 views/4 FKs/OIDs/files preserved, omitted/default/null/explicit writes, rollback/no-op passed`);
    return { initialStatements: initial.length, guardedStatements: 1, generatedDefaultStatements: generated.length, defaultsAligned: targetNames,
      rejectionCases, oldJsonOmissionsRejected: 2, fixtureRowsPreserved: 8, dependentViewsPreserved: 4, foreignKeysAndTriggersPreserved: 4,
      nonTargetOidsAndFilesPreserved: true, unknownDefaultsNotEvaluated: true, nullDefaultNormalizedToAbsence: true, failureRollbackConfirmed: true,
      generatedProposalMatchesGuardedResult: true, mixedStateAndTempIsolationConfirmed: true, nonPublicSchemaIsolationConfirmed: true, noOpIncludesDefaultOids: true, writes };
  } finally { if (!database) await db.close(); }
}
module.exports = auditColumnDefaults;
module.exports.verifyDefaultWrites = verifyDefaultWrites;
module.exports.matchesNullViolation = matchesNullViolation;
