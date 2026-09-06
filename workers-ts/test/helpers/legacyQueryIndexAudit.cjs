// Runs only inside the freshly created, isolated database owned by the caller.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async function auditLegacyQueryIndexes({ db, read, objects, dependencies, format, alignment = "legacy" }) {
  assert.ok(alignment === "legacy" || alignment === "worker");
  const legacy = alignment === "legacy";
  const config = legacy
    ? { manifest: "orm-extra-index-reconciliation.json", decision: "restore-missing-legacy-query-index", count: 28,
      migration: "0136_legacy_query_index_alignment.sql", number: "0136", tag: "DB-009D2b3a" }
    : { manifest: "orm-ordinary-index-reconciliation.json", decision: "restore-worker-query-index", count: 20,
      migration: "0137_worker_query_index_alignment.sql", number: "0137", tag: "DB-009D2b3b" };
  const manifest = JSON.parse(readFileSync(join(__dirname, "../../audit", config.manifest), "utf8"));
  const entries = manifest.entries.filter((entry) => entry.decision === config.decision);
  assert.equal(entries.length, config.count);
  const sql = readFileSync(join(__dirname, "../../migrations", config.migration), "utf8");
  const ident = (value) => '"' + value.replaceAll('"', '""') + '"';
  const names = entries.map((entry) => entry.catalog.name);
  const drops = entries.map((entry) => `DROP INDEX public.${ident(entry.catalog.name)};`).join("\n");
  const last = entries.at(-1), table = last.catalog.table, name = last.catalog.name;
  const [first, second] = last.columns;
  assert.equal(last.columns.length, 2);
  const status = legacy ? "status" : "is_read";
  const distinguish = `UPDATE ${table} SET ${second}=id${legacy ? "::text" : ""};`;
  const rows = async () => (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows;
  const capture = async () => ({ catalog: await read(), objects: await objects(), dependencies: await dependencies(), rows: await rows() });
  // The duplicate pair is intentional: this is an ordinary, not a unique, index.
  await db.exec(legacy ? `INSERT INTO user_money(type,link_id,number) VALUES('index_fixture','same',1.25),('index_fixture','same',2.50)`
    : "INSERT INTO user_message(uid,message_id,is_read) VALUES(7,11,0),(7,11,1)");
  const before = await capture();
  await db.exec("BEGIN");
  try {
    await db.exec(drops);
    const missing = await read();
    assert.equal(missing.indexes.length, before.catalog.indexes.length - config.count);
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
    ["unique", `${distinguish} CREATE UNIQUE INDEX ${name} ON ${table} (${first}, ${second})`],
    ["reversed", `CREATE INDEX ${name} ON ${table} (${second}, ${first})`],
    ["descending", `CREATE INDEX ${name} ON ${table} (${first} DESC, ${second})`],
    ["predicate", `CREATE INDEX ${name} ON ${table} (${first}, ${second}) WHERE ${status}=1`],
    ["include", `CREATE INDEX ${name} ON ${table} (${first}, ${second}) INCLUDE (${status})`],
    ["wrong-table", `CREATE INDEX ${name} ON community (type)`],
    ["relation-name", `CREATE TABLE ${name} (fixture integer)`],
    ["constraint-owner", `${distinguish} ALTER TABLE ${table} ADD CONSTRAINT ${name} UNIQUE (${first}, ${second})`],
    ["expression", `CREATE INDEX ${name} ON ${table} ((${first}::text), ${second})`],
    ["missing-table", `ALTER TABLE ${table} RENAME TO missing_fixture_table`],
    ["missing-schema", "SET LOCAL search_path TO absent_legacy_index_fixture"],
  ];
  for (const [name, fixture] of cases) {
    await db.exec("BEGIN");
    try {
      await db.exec(drops);
      await db.exec(fixture);
      const expected = new RegExp(name === "missing-table" ? `${config.number} expected permanent table ${table} is missing`
        : name === "missing-schema" ? `${config.number} target schema is missing` : `${config.number} index definition drift: ${last.key.replace(".", "\\.")}`);
      await assert.rejects(db.exec(sql), expected, name);
    } finally { await db.exec("ROLLBACK"); }
    // Includes restoration of every earlier index and all preexisting OIDs.
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
    const shadow = ident(entries[0].catalog.name);
    await db.exec(`CREATE TEMP TABLE community (fixture integer); CREATE TEMP TABLE ${shadow} (fixture integer);
      INSERT INTO pg_temp.community VALUES(7); INSERT INTO pg_temp.${shadow} VALUES(8);
      SET LOCAL search_path TO legacy_query_fixture,pg_temp,public`);
    await db.exec(sql);
    const scoped = (await db.query(`SELECT pg_get_indexdef(c.oid) AS definition FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='legacy_query_fixture' AND c.relkind='i' ORDER BY c.relname`)).rows;
    assert.equal(scoped.length, config.count);
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
    assert.deepEqual((await db.query(`SELECT * FROM pg_temp.${shadow}`)).rows, [{ fixture: 8 }]);
    await db.exec("SET LOCAL search_path TO public,pg_temp");
    assert.deepEqual(await capture(), restored);
  } finally { await db.exec("ROLLBACK"); }
  assert.deepEqual(await capture(), restored);
  console.log(`${config.tag} ${format}: ${config.count} restored, 11 rejection rollbacks, duplicate rows/OIDs/FK dependencies preserved, idempotence and schema isolation passed`);
  return { restoredIndexes: config.count, rejectionCases: cases.map(([name]) => name), rollbackConfirmed: true,
    duplicateRowsPreserved: true, nonTargetObjectsAndDependenciesPreserved: true, idempotent: true, schemaIsolationConfirmed: true };
};
