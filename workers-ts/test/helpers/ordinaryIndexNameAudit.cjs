// Four isolated catalog paths use the guarded rename; raw generator churn is never applied as the upgrade.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async function auditIndexNames({ api, models, previous, db, read, objects, dependencies, format }) {
  const manifest = JSON.parse(readFileSync(join(__dirname, "../../audit/orm-index-name-reconciliation.json"), "utf8"));
  const entries = manifest.entries;
  assert.equal(entries.length, 44);
  const sql = readFileSync(join(__dirname, "../../migrations/0138_ordinary_index_name_alignment.sql"), "utf8");
  const target = api.generateDrizzleJson(models, previous.id);
  // Keep the independently audited two retirements for the next phase.
  const retirements = JSON.parse(readFileSync(join(__dirname, "../../audit/orm-ordinary-index-reconciliation.json"), "utf8"))
    .entries.filter((entry) => entry.decision === "remove-redundant-orm-declaration");
  for (const entry of retirements) target.tables[`public.${entry.catalog.table}`].indexes[entry.catalog.name] = structuredClone(entry.previousSnapshotIndex);
  for (const entry of entries) {
    assert.deepEqual(previous.tables[`public.${entry.catalog.table}`].indexes[entry.previousCatalog.name], entry.previousSnapshotIndex);
    assert.deepEqual(JSON.parse(JSON.stringify(target.tables[`public.${entry.catalog.table}`].indexes[entry.catalog.name])), { ...entry.previousSnapshotIndex, name: entry.catalog.name });
  }
  const proposed = await api.generateMigration(previous, target);
  const drops = proposed.filter((query) => query.startsWith("DROP INDEX "));
  const creates = proposed.filter((query) => query.startsWith("CREATE INDEX "));
  assert.equal(proposed.length, 88);
  assert.equal(drops.length, 44);
  assert.equal(creates.length, 44);
  assert.deepEqual([...drops].sort(), entries.map((entry) => `DROP INDEX "${entry.previousCatalog.name}";`).sort());
  assert.deepEqual(creates.map((query) => query.match(/^CREATE INDEX "([A-Za-z0-9_]+)" ON /)?.[1]).sort(), entries.map((entry) => entry.catalog.name).sort());
  const ident = (name) => '"' + name.replaceAll('"', '""') + '"';
  const rows = async () => (await db.query(`SELECT 'user' AS source,to_jsonb(t) AS row FROM "user" t
    UNION ALL SELECT 'cart',to_jsonb(t) FROM store_cart t UNION ALL SELECT 'order',to_jsonb(t) FROM store_order t ORDER BY source,row`)).rows;
  const storage = async () => (await db.query(`SELECT c.oid,c.relfilenode,c.reltablespace,pg_relation_filenode(c.oid) AS node,
    pg_relation_filepath(c.oid) AS file FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='i' ORDER BY c.oid`)).rows;
  const indexDependencies = async () => (await db.query(`SELECT d.* FROM pg_depend d WHERE
    (d.classid='pg_class'::regclass AND d.objid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='i')) OR
    (d.refclassid='pg_class'::regclass AND d.refobjid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='i')) OR
    (d.classid='pg_rewrite'::regclass AND d.objid IN (SELECT r.oid FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class WHERE c.relname LIKE 'index_name_dependency_%'))
    ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype`)).rows;
  const rules = async () => (await db.query(`SELECT r.* FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class
    WHERE c.relname LIKE 'index_name_dependency_%' ORDER BY r.oid`)).rows;
  const capture = async () => ({ catalog: await read(), objects: await objects(), storage: await storage(), foreignKeys: await dependencies(),
    dependencies: await indexDependencies(), rules: await rules(), rows: await rows() });
  const before = await capture();
  for (const entry of entries) assert.deepEqual(before.catalog.indexes.find((row) => row.key === entry.previousKey), entry.previousCatalog);
  const expectedAfter = (baseline) => ({ ...baseline,
    catalog: { ...baseline.catalog, indexes: baseline.catalog.indexes.map((row) => entries.find((entry) => entry.previousKey === row.key)?.catalog ?? row)
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) },
    objects: baseline.objects.map((row) => ({ ...row, relname: entries.find((entry) => entry.previousCatalog.name === row.relname)?.catalog.name ?? row.relname })),
  });
  await db.exec("BEGIN");
  try {
    await db.exec(`INSERT INTO "user"(account,phone) VALUES('name-fixture','phone-a'),('name-fixture','phone-b');
      INSERT INTO store_cart(uid,product_id) VALUES(7,11),(7,11);
      INSERT INTO store_order(order_id,"unique",uid) VALUES('name-order-a','name-key-a',7),('name-order-b','name-key-b',7)`);
    for (const [index, entry] of entries.entries()) await db.exec(`CREATE VIEW index_name_dependency_${index}
      AS SELECT 'public.${ident(entry.previousCatalog.name)}'::regclass AS referenced_index`);
    const fixture = await capture();
    assert.equal(fixture.rules.length, 44);
    // Every individual DROP and the real complete generator output must reject
    // dependent views. Never use CASCADE to make the generator pass.
    for (const query of [...drops, proposed.join("\n")]) {
      await db.exec("SAVEPOINT index_name_probe");
      await assert.rejects(db.exec(query), { code: "2BP01" });
      await db.exec("ROLLBACK TO SAVEPOINT index_name_probe; RELEASE SAVEPOINT index_name_probe");
    }
    assert.deepEqual(await capture(), fixture);
    await db.exec(sql);
    assert.deepEqual(await capture(), expectedAfter(fixture));
    for (const [index, entry] of entries.entries()) {
      const oid = fixture.objects.find((row) => row.relname === entry.previousCatalog.name).oid;
      assert.deepEqual((await db.query(`SELECT referenced_index::oid AS oid FROM index_name_dependency_${index}`)).rows, [{ oid }]);
    }
    await db.exec(sql);
    assert.deepEqual(await capture(), expectedAfter(fixture));
  } finally { await db.exec("ROLLBACK"); }
  assert.deepEqual(await capture(), before);
  const last = entries.at(-1), old = ident(last.previousCatalog.name), canonical = ident(last.catalog.name);
  assert.equal(last.previousKey, "user_money.um_uid");
  const removeOld = `DROP INDEX public.${old};`;
  const cases = [
    ["missing-both", removeOld, /0138 reviewed index is missing/],
    ["both-names", `CREATE INDEX ${canonical} ON user_money(uid)`, /0138 ambiguous index names/],
    ["source-unique", `${removeOld} UPDATE user_money SET uid=id+100; CREATE UNIQUE INDEX ${old} ON user_money(uid)`, /0138 index definition drift/],
    ["source-descending", `${removeOld} CREATE INDEX ${old} ON user_money(uid DESC)`, /0138 index definition drift/],
    ["source-predicate", `${removeOld} CREATE INDEX ${old} ON user_money(uid) WHERE status=1`, /0138 index definition drift/],
    ["source-include", `${removeOld} CREATE INDEX ${old} ON user_money(uid) INCLUDE(id)`, /0138 index definition drift/],
    ["source-expression", `${removeOld} CREATE INDEX ${old} ON user_money((uid::text))`, /0138 index definition drift/],
    ["source-wrong-table", `${removeOld} CREATE INDEX ${old} ON community(type)`, /0138 index definition drift/],
    ["source-constraint", `${removeOld} UPDATE user_money SET uid=id+100; ALTER TABLE user_money ADD CONSTRAINT ${old} UNIQUE(uid)`, /0138 index definition drift/],
    ["target-wrong-shape", `${removeOld} CREATE INDEX ${canonical} ON user_money(uid DESC)`, /0138 index definition drift/],
    ["missing-table", "ALTER TABLE user_money RENAME TO name_missing_fixture", /0138 expected permanent ordinary table/],
    ["missing-schema", "SET LOCAL search_path TO absent_index_name_fixture", /0138 target schema is missing/],
  ];
  for (const [name, fixture, error] of cases) {
    await db.exec("BEGIN");
    try { await db.exec(fixture); await assert.rejects(db.exec(sql), error, name); }
    finally { await db.exec("ROLLBACK"); }
    assert.deepEqual(await capture(), before, name); // Also undoes the earlier 43 renames.
  }
  const renameStatement = "EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', target_schema, item.old_name, item.target_name);";
  assert.equal(sql.split(renameStatement).length, 2);
  await db.exec("BEGIN");
  try { await assert.rejects(db.exec(sql.replace(renameStatement, renameStatement + "\nPERFORM 1/0;")), { code: "22012" }); }
  finally { await db.exec("ROLLBACK"); }
  assert.deepEqual(await capture(), before);
  await db.exec("BEGIN");
  try {
    for (const entry of entries.slice(0, 22)) await db.exec(`ALTER INDEX public.${ident(entry.previousCatalog.name)} RENAME TO ${ident(entry.catalog.name)}`);
    await db.exec(sql);
    assert.deepEqual(await capture(), expectedAfter(before));
  } finally { await db.exec("ROLLBACK"); }
  assert.deepEqual(await capture(), before);
  await db.exec("BEGIN");
  try {
    await db.exec("CREATE SCHEMA index_name_fixture");
    for (const table of new Set(entries.map((entry) => entry.catalog.table))) await db.exec(`CREATE TABLE index_name_fixture.${ident(table)} (LIKE public.${ident(table)})`);
    for (const entry of entries) await db.exec(`CREATE INDEX ${ident(entry.previousCatalog.name)} ON index_name_fixture.${ident(entry.catalog.table)} (${entry.columns.map(ident).join(",")})`);
    await db.exec(`CREATE TEMP TABLE sc_product_id(fixture integer); CREATE TEMP TABLE sc_product_id_idx(fixture integer);
      INSERT INTO pg_temp.sc_product_id VALUES(7); INSERT INTO pg_temp.sc_product_id_idx VALUES(8);
      SET LOCAL search_path TO index_name_fixture,pg_temp,public`);
    const scoped = async () => (await db.query(`SELECT c.oid,c.relname,c.relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='index_name_fixture' AND c.relkind='i' ORDER BY c.oid`)).rows;
    const oldScoped = await scoped();
    await db.exec(sql);
    assert.deepEqual(await scoped(), oldScoped.map((row) => ({ ...row, relname: entries.find((entry) => entry.previousCatalog.name === row.relname).catalog.name })));
    await db.exec(sql);
    assert.equal((await scoped()).length, 44);
    assert.deepEqual((await db.query("SELECT * FROM pg_temp.sc_product_id")).rows, [{ fixture: 7 }]);
    assert.deepEqual((await db.query("SELECT * FROM pg_temp.sc_product_id_idx")).rows, [{ fixture: 8 }]);
    await db.exec("SET LOCAL search_path TO public,pg_temp");
    assert.deepEqual(await capture(), before);
  } finally { await db.exec("ROLLBACK"); }
  assert.deepEqual(await capture(), before);
  await db.exec("BEGIN");
  try { await db.exec(sql); await db.exec("COMMIT"); }
  catch (error) { await db.exec("ROLLBACK"); throw error; }
  assert.deepEqual(await capture(), expectedAfter(before));
  await db.exec(sql);
  assert.deepEqual(await capture(), expectedAfter(before));
  console.log(`DB-009D2b3c ${format}: 44 guarded renames, OIDs/files/44 dependent views preserved, 45 destructive proposals rejected, 12 drift rollbacks, mixed-state/schema-isolation/idempotence passed`);
  return { targetSnapshot: target, verification: { guardedStatements: 1, renamedIndexes: 44, generatorProposedStatements: 88,
    generatorAppliedAsUpgrade: false, destructiveDependencyRejections: 45, dependentViewsPreserved: 44, fixtureRowsPreserved: 6,
    indexOidsAndFilesPreserved: true, foreignKeysAndDependenciesPreserved: true, rejectionCases: cases.map(([name]) => name),
    failureRollbackConfirmed: true, mixedStateConfirmed: true, schemaIsolationConfirmed: true, idempotent: true } };
};
