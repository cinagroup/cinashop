// Shared by network-denied CJS/ESM probes and the isolated loopback PG16 auditor.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

module.exports = async function auditIndexDefinitions({ api, models, snapshot, format, database }) {
  const { generateDrizzleJson, generateMigration } = api;
  const { readCatalog, compareCatalogs, assertIndexContracts } = require("tsx/cjs/api").require("../../scripts/data-migration/postgres-catalog-audit.ts", __filename);
  const manifest = JSON.parse(readFileSync(join(__dirname, "../../audit/orm-index-definition-reconciliation.json"), "utf8"));
  const priorContracts = JSON.parse(readFileSync(join(__dirname, "../../audit/orm-query-index-reconciliation.json"), "utf8"));
  const legacyContracts = JSON.parse(readFileSync(join(__dirname, "../../audit/orm-extra-index-reconciliation.json"), "utf8"))
    .entries.filter((entry) => entry.decision === "restore-missing-legacy-query-index");
  const ordinaryManifest = JSON.parse(readFileSync(join(__dirname, "../../audit/orm-ordinary-index-reconciliation.json"), "utf8"));
  const retired = ordinaryManifest.entries.filter((entry) => entry.decision === "remove-redundant-orm-declaration");
  const { extendOrdinaryIndexContracts, assertRetiredIndexesAbsent } = require("tsx/cjs/api").require("../../scripts/data-migration/ordinary-index-contracts.ts", __filename);
  const keys = manifest.entries.map((entry) => entry.key).sort();
  assert.equal(keys.length, 57);
  const old = structuredClone(snapshot);
  for (const entry of manifest.entries) {
    old.tables[`public.${entry.catalog.table}`].indexes[entry.catalog.name] = structuredClone(entry.previousSnapshotIndex);
  }
  const target = generateDrizzleJson(models, old.id);
  // Preserve the two old ordinary declarations through the 57-definition phase;
  // their separate generated delta is tested with restrictive dependencies below.
  for (const entry of retired) for (const state of [old, target]) {
    assert.equal(state.tables[`public.${entry.catalog.table}`].indexes[entry.catalog.name], undefined);
    state.tables[`public.${entry.catalog.table}`].indexes[entry.catalog.name] = structuredClone(entry.previousSnapshotIndex);
  }
  const delta = await generateMigration(old, target);
  assert.equal(delta.length, 114);
  const drops = delta.filter((statement) => /^DROP INDEX /.test(statement));
  const creates = delta.filter((statement) => /^CREATE INDEX /.test(statement));
  assert.equal(drops.length, 57);
  assert.equal(creates.length, 57);
  const names = manifest.entries.map((entry) => entry.catalog.name).sort();
  assert.deepEqual(drops.map((statement) => {
    const match = statement.match(/^DROP INDEX "([a-z0-9_]+)";$/);
    assert.ok(match, statement); // No CASCADE, other schema or unreviewed DDL.
    return match[1];
  }).sort(), names);
  assert.deepEqual(creates.map((statement) => statement.match(/^CREATE INDEX "([a-z0-9_]+)" ON /)?.[1]).sort(), names);
  for (const name of names) {
    assert.ok(delta.findIndex((s) => s.startsWith(`CREATE INDEX "${name}"`)) > delta.indexOf(`DROP INDEX "${name}";`));
  }
  const initial = await generateMigration(generateDrizzleJson({}), old);
  const db = database ?? new PGlite();
  const read = () => readCatalog(async (query) => (await db.query(query)).rows);
  const rows = async () => (await db.query(`SELECT 'agreement' AS source, to_jsonb(t) AS row FROM agreement t
    UNION ALL SELECT 'visitor', to_jsonb(t) FROM kefu_visitor_session t
    UNION ALL SELECT 'cart', to_jsonb(t) FROM store_order_cart_info t ORDER BY source, row`)).rows;
  const objects = async () => (await db.query(`SELECT c.oid, c.relname, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.oid`)).rows;
  const dependencies = async () => (await db.query(`SELECT c.oid, c.conname, c.conindid, d.classid, d.objid, d.objsubid,
    d.refclassid, d.refobjid, d.refobjsubid, d.deptype FROM pg_constraint c
    LEFT JOIN pg_depend d ON d.classid='pg_constraint'::regclass AND d.objid=c.oid
    WHERE c.contype='f' ORDER BY c.oid, d.refclassid, d.refobjid, d.refobjsubid, d.deptype`)).rows;
  try {
    await db.exec(initial.join("\n"));
    await db.exec(`INSERT INTO agreement(type,title,sort) VALUES(11,'low fixture',1),(12,'high fixture',9);
      INSERT INTO kefu_visitor_session(session_id,service_id,kefu_uid,token_hash,created_at,expires_at,last_seen_at,revoked_at)
        VALUES('active-fixture',1,7,repeat('a',64),1,100,1,0),('revoked-fixture',1,7,repeat('b',64),1,100,1,5);
      INSERT INTO store_order_cart_info(oid,"unique",old_cart_id) VALUES(1,'empty-fixture',''),(1,'linked-fixture','parent-fixture');`);
    const before = await read(), data = await rows(), objectIds = await objects(), foreignKeys = await dependencies();
    assert.ok(foreignKeys.length > 0);
    for (const entry of manifest.entries) assert.deepEqual(before.indexes.find((row) => row.key === entry.key), entry.previousCatalog, entry.key);
    assert.throws(() => assertIndexContracts({ ...before, indexes: manifest.entries.map((entry) => entry.catalog) }, before, keys), /Index contract drift/);
    // Inject a real SQL failure after a generated DROP; rollback must restore its OID and dependencies.
    await db.exec("BEGIN");
    await db.exec(drops[0]);
    await assert.rejects(db.exec("SELECT 1/0"), { code: "22012" });
    await db.exec("ROLLBACK");
    assert.deepEqual(await read(), before);
    assert.deepEqual(await rows(), data);
    assert.deepEqual(await objects(), objectIds);
    assert.deepEqual(await dependencies(), foreignKeys);
    await db.exec("BEGIN");
    await db.exec(delta.join("\n"));
    await db.exec("COMMIT");
    const after = await read();
    const base = [...priorContracts.entries, ...manifest.entries, ...legacyContracts];
    const contracts = extendOrdinaryIndexContracts(base.map((entry) => entry.key), ordinaryManifest);
    const available = [...base.map((entry) => entry.catalog),
      ...ordinaryManifest.entries.filter((entry) => entry.decision === "restore-worker-query-index").map((entry) => entry.catalog),
      ...retired.map((entry) => entry.replacementCatalog)];
    const allEntries = contracts.keys.map((key) => ({ key, catalog: available.find((row) => row.key === key) }));
    for (const entry of allEntries) assert.deepEqual(after.indexes.find((row) => row.key === entry.key), entry.catalog, entry.key);
    assertIndexContracts({ ...after, indexes: allEntries.map((entry) => entry.catalog) }, after, allEntries.map((entry) => entry.key));
    const diff = compareCatalogs(before, after);
    assert.deepEqual(diff.indexes.changed.map((entry) => entry.key), keys);
    assert.ok(diff.indexes.changed.every((entry) => JSON.stringify(entry.fields) === '["definition"]'));
    for (const [kind, changes] of Object.entries(diff)) {
      for (const [change, values] of Object.entries(changes)) if (kind !== "indexes" || change !== "changed") assert.deepEqual(values, [], `${kind}.${change}`);
    }
    assert.deepEqual(await rows(), data);
    assert.deepEqual((await objects()).filter((row) => !names.includes(row.relname)), objectIds.filter((row) => !names.includes(row.relname)));
    assert.deepEqual(await dependencies(), foreignKeys);
    assert.deepEqual((await db.query("SELECT title FROM agreement WHERE status=1 ORDER BY sort DESC")).rows, [{ title: "high fixture" }, { title: "low fixture" }]);
    assert.deepEqual((await db.query("SELECT session_id FROM kefu_visitor_session WHERE kefu_uid=7 AND revoked_at=0 AND expires_at>10")).rows, [{ session_id: "active-fixture" }]);
    assert.deepEqual((await db.query("SELECT old_cart_id FROM store_order_cart_info WHERE old_cart_id<>''")).rows, [{ old_cart_id: "parent-fixture" }]);
    const legacyQueryIndexes = await require("./legacyQueryIndexAudit.cjs")({ db, read, objects, dependencies, format });
    const ordinaryQueryIndexes = await require("./legacyQueryIndexAudit.cjs")({ db, read, objects, dependencies, format, alignment: "worker" });
    const retirement = await require("./ordinaryIndexRetirementAudit.cjs")({ api, models, previous: target, db, read, objects, dependencies, format });
    const final = await read();
    assertIndexContracts({ ...final, indexes: allEntries.map((entry) => entry.catalog) }, final, contracts.keys);
    assertRetiredIndexesAbsent(final, contracts.retiredKeys);
    console.log(`DB-009D2b2 ${format}: 57 exact replacements, rollback, rows/OIDs/FK dependencies preserved, ${allEntries.length} contracts, no-op passed`);
    return { initialStatements: initial.length, upgradeStatements: delta.length + retirement.statements, definitionUpgradeStatements: delta.length, reconciledIndexes: 57,
      verifiedContracts: allEntries.length, rollbackConfirmed: true, rowsAndDependenciesPreserved: true, legacyQueryIndexes,
      ordinaryQueryIndexes: { ...ordinaryQueryIndexes, retirement } };
  } finally { if (!database) await db.close(); }
};
