// Runs only inside the freshly created, isolated database owned by the caller.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async function auditLegacyQueryIndexes({ db, read, objects, dependencies, format }) {
  const manifest = JSON.parse(readFileSync(join(__dirname, "../../audit/orm-extra-index-reconciliation.json"), "utf8"));
  const entries = manifest.entries.filter((entry) => entry.decision === "restore-missing-legacy-query-index");
  assert.equal(entries.length, 28);
  const sql = readFileSync(join(__dirname, "../../migrations/0136_legacy_query_index_alignment.sql"), "utf8");
  const ident = (value) => '"' + value.replaceAll('"', '""') + '"';
  const names = entries.map((entry) => entry.catalog.name);
  const drops = entries.map((entry) => `DROP INDEX public.${ident(entry.catalog.name)};`).join("\n");
  const rows = async () => (await db.query(`SELECT to_jsonb(t) AS row FROM user_money t ORDER BY id`)).rows;
  const capture = async () => ({ catalog: await read(), objects: await objects(), dependencies: await dependencies(), rows: await rows() });
  // The duplicate pair is intentional: this is an ordinary, not a unique, index.
  await db.exec(`INSERT INTO user_money(type,link_id,number) VALUES('index_fixture','same',1.25),('index_fixture','same',2.50)`);
  const before = await capture();
  await db.exec("BEGIN");
  try {
    await db.exec(drops);
    const missing = await read();
    assert.equal(missing.indexes.length, before.catalog.indexes.length - 28);
    assert.ok(entries.every((entry) => !missing.indexes.some((row) => row.key === entry.key)));
    await db.exec(sql);
    const restored = await capture();
    assert.deepEqual(restored.catalog, before.catalog);
    assert.deepEqual(restored.rows, before.rows);
    assert.deepEqual(restored.dependencies, before.dependencies);
    assert.deepEqual(restored.objects.filter((row) => !names.includes(row.relname)), before.objects.filter((row) => !names.includes(row.relname)));
    for (const entry of entries) assert.deepEqual(restored.catalog.indexes.find((row) => row.key === entry.key), entry.catalog, entry.key);
    await db.exec(sql);
    assert.deepEqual(await capture(), restored); // Idempotence must retain even index OIDs.
    await db.exec("COMMIT");
  } catch (error) { await db.exec("ROLLBACK"); throw error; }
  const restored = await capture();
  // Only within each rolled-back negative fixture, distinguish the duplicate
  // pair so uniqueness itself (not duplicate-data failure) can be rejected.
  const cases = [
    ["unique", "UPDATE user_money SET link_id=id::text; CREATE UNIQUE INDEX um_type_link ON user_money (type, link_id)"],
    ["reversed", "CREATE INDEX um_type_link ON user_money (link_id, type)"],
    ["descending", "CREATE INDEX um_type_link ON user_money (type DESC, link_id)"],
    ["predicate", "CREATE INDEX um_type_link ON user_money (type, link_id) WHERE status=1"],
    ["include", "CREATE INDEX um_type_link ON user_money (type, link_id) INCLUDE (status)"],
    ["wrong-table", "CREATE INDEX um_type_link ON community (type)"],
    ["relation-name", "CREATE TABLE um_type_link (fixture integer)"],
    ["constraint-owner", "UPDATE user_money SET link_id=id::text; ALTER TABLE user_money ADD CONSTRAINT um_type_link UNIQUE (type, link_id)"],
    ["expression", "CREATE INDEX um_type_link ON user_money ((type::text), link_id)"],
    ["missing-table", "ALTER TABLE user_money RENAME TO missing_fixture_table"],
    ["missing-schema", "SET LOCAL search_path TO absent_legacy_index_fixture"],
  ];
  for (const [name, fixture] of cases) {
    await db.exec("BEGIN");
    try {
      await db.exec(drops);
      await db.exec(fixture);
      const expected = name === "missing-table" ? /0136 expected permanent table user_money is missing/
        : name === "missing-schema" ? /0136 target schema is missing/ : /0136 index definition drift: user_money.um_type_link/;
      await assert.rejects(db.exec(sql), expected, name);
    } finally { await db.exec("ROLLBACK"); }
    // Includes restoration of the earlier 27 indexes and all preexisting OIDs.
    assert.deepEqual(await capture(), restored, name);
  }
  // Explicit non-public schema with pg_temp before public: neither public nor
  // temporary same-name objects may be inspected, modified or counted as targets.
  await db.exec("BEGIN");
  try {
    await db.exec("CREATE SCHEMA legacy_query_fixture");
    for (const table of new Set(entries.map((entry) => entry.catalog.table))) {
      await db.exec(`CREATE TABLE legacy_query_fixture.${ident(table)} (LIKE public.${ident(table)})`);
    }
    await db.exec(`CREATE TEMP TABLE community (fixture integer); CREATE TEMP TABLE c_type (fixture integer);
      INSERT INTO pg_temp.community VALUES(7); INSERT INTO pg_temp.c_type VALUES(8);
      SET LOCAL search_path TO legacy_query_fixture,pg_temp,public`);
    await db.exec(sql);
    const scoped = (await db.query(`SELECT pg_get_indexdef(c.oid) AS definition FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='legacy_query_fixture' AND c.relkind='i' ORDER BY c.relname`)).rows;
    assert.equal(scoped.length, 28);
    for (const entry of entries) {
      const definition = `CREATE INDEX ${ident(entry.catalog.name)} ON legacy_query_fixture.${ident(entry.catalog.table)} USING btree (${entry.columns.map(ident).join(", ")})`;
      // PostgreSQL quotes only identifiers that require quotes; resolve exact SQL
      // with the same identifier rules rather than normalizing catalog strings.
      const expected = (await db.query(`SELECT format('CREATE INDEX %I ON legacy_query_fixture.%I USING btree (%s)',
        '${entry.catalog.name}', '${entry.catalog.table}',
        (SELECT string_agg(quote_ident(c), ', ' ORDER BY ordinal) FROM unnest(ARRAY[${entry.columns.map((c) => `'${c}'`).join(",")}]) WITH ORDINALITY AS cols(c,ordinal))) AS definition`)).rows[0];
      assert.ok(scoped.some((row) => row.definition === expected.definition), definition);
    }
    assert.deepEqual((await db.query("SELECT * FROM pg_temp.community")).rows, [{ fixture: 7 }]);
    assert.deepEqual((await db.query("SELECT * FROM pg_temp.c_type")).rows, [{ fixture: 8 }]);
    await db.exec("SET LOCAL search_path TO public,pg_temp");
    assert.deepEqual(await capture(), restored);
  } finally { await db.exec("ROLLBACK"); }
  assert.deepEqual(await capture(), restored);
  console.log(`DB-009D2b3a ${format}: 28 restored, 11 rejection rollbacks, duplicate rows/OIDs/FK dependencies preserved, idempotence and schema isolation passed`);
  return { restoredIndexes: 28, rejectionCases: cases.map(([name]) => name), rollbackConfirmed: true,
    duplicateRowsPreserved: true, nonTargetObjectsAndDependenciesPreserved: true, idempotent: true, schemaIsolationConfirmed: true };
};
