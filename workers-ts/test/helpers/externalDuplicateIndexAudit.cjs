// Only called with a fresh isolated engine. Never reads a connection environment variable.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const root = join(__dirname, "../..");
const manifest = JSON.parse(readFileSync(join(root, "audit/external-duplicate-index-reconciliation.json"), "utf8"));
const sql = readFileSync(join(root, "migrations/0140_external_duplicate_index_retirement.sql"), "utf8");
const entries = manifest.entries;
const { matchesDatabaseError } = require("./constraintNameAudit.cjs");

module.exports = async function auditExternalDuplicates({ db, read, format }) {
  assert.equal(entries.length, 5);
  const names = entries.map(e => e.catalog.name);
  const incoming = async name => (await db.query(`SELECT classid,objid,objsubid,deptype FROM pg_depend
    WHERE refclassid='pg_class'::regclass AND refobjid='public.${name}'::regclass ORDER BY classid,objid,objsubid,deptype`)).rows;
  const capture = async () => ({
    catalog: await read(),
    objects: (await db.query(`SELECT c.oid,c.relname,c.relkind,c.relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' ORDER BY c.oid`)).rows,
    constraints: (await db.query(`SELECT c.oid,c.conname,c.conindid,c.conrelid,c.confrelid FROM pg_constraint c
      JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY c.oid`)).rows,
    triggers: (await db.query(`SELECT t.oid,to_jsonb(t) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY t.oid`)).rows,
    dependencies: (await db.query(`SELECT d.classid::regclass::text AS class,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype FROM pg_depend d
      WHERE (d.classid='pg_class'::regclass AND d.objid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'))
        OR (d.refclassid='pg_class'::regclass AND d.refobjid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'))
        OR (d.classid='pg_constraint'::regclass AND d.objid IN (SELECT c.oid FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'))
      ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype`)).rows,
    rows: (await db.query(`SELECT 'refund' AS source,to_jsonb(t) AS row FROM store_order_refund t
      UNION ALL SELECT 'recharge',to_jsonb(t) FROM user_recharge t UNION ALL SELECT 'wechat',to_jsonb(t) FROM wechat_user t ORDER BY source,row`)).rows,
  });
  const expectRemoved = (after, before, removed = names) => {
    const oids = before.objects.filter(row => removed.includes(row.relname)).map(row => row.oid);
    assert.deepEqual(after.catalog, { ...before.catalog, indexes: before.catalog.indexes.filter(row => !removed.includes(row.name)) });
    assert.deepEqual(after.objects, before.objects.filter(row => !oids.includes(row.oid)));
    assert.deepEqual(after.constraints, before.constraints);
    assert.deepEqual(after.triggers, before.triggers);
    assert.deepEqual(after.dependencies, before.dependencies.filter(row => !(row.class === "pg_class" && oids.includes(row.objid))));
    assert.deepEqual(after.rows, before.rows);
  };
  const before = await capture();
  for (const e of entries) {
    assert.deepEqual(before.catalog.indexes.find(r => r.key === e.key), e.catalog);
    assert.deepEqual(before.catalog.indexes.find(r => r.key === e.retainedKey), e.retainedCatalog);
    assert.deepEqual(await incoming(e.catalog.name), []); // Evidence from this engine, not inferred from matching definitions.
  }
  let refusals = 0;
  const reject = async (setup, expected = /0140 .*?(drift|missing|dependencies)/) => {
    const baseline = await capture();
    await db.exec("SAVEPOINT duplicate_probe");
    try {
      await db.exec(setup);
      await assert.rejects(db.exec(sql), expected);
      refusals++;
    } finally { await db.exec("ROLLBACK TO SAVEPOINT duplicate_probe; RELEASE SAVEPOINT duplicate_probe"); }
    assert.deepEqual(await capture(), baseline);
  };
  await db.exec("BEGIN");
  try {
    // Explicit identifiers avoid sequence advancement (nextval is not rolled back).
    await db.exec(`INSERT INTO store_order_refund(id,store_order_id,order_id) VALUES(2000000101,77,'dup-refund-a'),(2000000102,77,'dup-refund-b');
      INSERT INTO user_recharge(id,uid,order_id) VALUES(2000000101,77,'dup-recharge-a'),(2000000102,77,'dup-recharge-b');
      INSERT INTO wechat_user(id,uid,unionid,openid) VALUES(2000000101,77,'dup-union','dup-open-a'),(2000000102,77,'dup-union','dup-open-b');`);
    for (const e of entries) await reject(`CREATE VIEW duplicate_index_view AS SELECT 'public.${e.catalog.name}'::regclass AS referenced_index`);
    // Bind the FK to the old unique index while it is the only qualifying index.
    const unique = entries[2];
    await reject(`DROP INDEX public.wu_openid_uq RESTRICT;
      CREATE TABLE duplicate_index_child(openid varchar(100), CONSTRAINT duplicate_index_old_fk FOREIGN KEY(openid) REFERENCES wechat_user(openid));
      ${unique.retainedSource.sql}
      DO $probe$ BEGIN IF (SELECT conindid FROM pg_constraint WHERE conname='duplicate_index_old_fk') <> 'public.wu_openid_uq_idx'::regclass THEN
        RAISE EXCEPTION 'wrong fixture FK binding'; END IF; END $probe$;`);
    // Exact shape refusals for each side, including cases that look equivalent by prefix alone.
    for (const name of [entries[0].catalog.name, entries[0].retainedCatalog.name]) {
      for (const clause of ["(uid)", "(store_order_id DESC)", "(store_order_id) WHERE store_order_id>0",
        "((store_order_id+1))", "(store_order_id) INCLUDE (uid)", "(store_order_id) WITH (fillfactor=80)"]) {
        await reject(`DROP INDEX public.${name} RESTRICT; CREATE INDEX ${name} ON store_order_refund ${clause}`);
      }
      await reject(`ALTER INDEX public.${name} RENAME TO duplicate_saved_index; CREATE TABLE public.${name}(id integer)`);
      await reject(`DROP INDEX public.${name} RESTRICT; CREATE INDEX ${name} ON user_recharge(uid)`);
      await reject(`ALTER TABLE store_order_refund CLUSTER ON ${name}`);
    }
    for (const name of [unique.catalog.name, unique.retainedCatalog.name]) {
      await reject(`DROP INDEX public.${name} RESTRICT; CREATE INDEX ${name} ON wechat_user(openid)`);
      await reject(`ALTER TABLE wechat_user ADD CONSTRAINT ${name} UNIQUE USING INDEX ${name}`);
      await reject(`ALTER TABLE wechat_user REPLICA IDENTITY USING INDEX ${name}`);
    }
    await reject("DROP INDEX public.sor_store_order_id RESTRICT");
    await reject("DROP INDEX public.sor_store_order_id_idx RESTRICT; DROP INDEX public.sor_store_order_id RESTRICT");
    await reject("ALTER TABLE user_recharge RENAME TO duplicate_saved_table");
    await reject("SET LOCAL search_path TO missing_duplicate_schema");
    // Inject a failure into the real DO body immediately after its first physical removal.
    const fixture = await capture();
    await db.exec("SAVEPOINT duplicate_probe");
    const drop = "EXECUTE format('DROP INDEX %I.%I RESTRICT',target_schema,item.old_name);";
    assert.ok(sql.includes(drop));
    await assert.rejects(db.exec(sql.replace(drop, drop + "\n      PERFORM 1/0;")), { code: "22012" });
    await db.exec("ROLLBACK TO SAVEPOINT duplicate_probe; RELEASE SAVEPOINT duplicate_probe");
    assert.deepEqual(await capture(), fixture);
    // The retained index may own real FK dependencies; they must survive without rebinding.
    await db.exec(`DROP INDEX public.wu_openid_uq_idx RESTRICT;
      CREATE TABLE duplicate_index_child(openid varchar(100), CONSTRAINT duplicate_index_retained_fk FOREIGN KEY(openid)
        REFERENCES wechat_user(openid) ON UPDATE CASCADE ON DELETE CASCADE);
      INSERT INTO duplicate_index_child VALUES('dup-open-a'); ${unique.source.sql}
      CREATE VIEW duplicate_retained_view AS SELECT 'public.wu_openid_uq'::regclass AS retained_index`);
    assert.equal((await db.query("SELECT conindid='public.wu_openid_uq'::regclass AS exact FROM pg_constraint WHERE conname='duplicate_index_retained_fk'")).rows[0].exact, true);
    const withFk = await capture();
    await db.exec(sql);
    expectRemoved(await capture(), withFk);
    await db.exec(sql);
    expectRemoved(await capture(), withFk);
    assert.deepEqual((await db.query("SELECT openid FROM duplicate_index_child")).rows, [{ openid: "dup-open-a" }]);
    for (const [query, code, constraint] of [
      ["INSERT INTO wechat_user(id,openid) VALUES(2000000103,'dup-open-a')", "23505", "wu_openid_uq"],
      ["INSERT INTO duplicate_index_child VALUES('absent-openid')", "23503", "duplicate_index_retained_fk"],
    ]) {
      await db.exec("SAVEPOINT duplicate_probe");
      await assert.rejects(db.exec(query), error => matchesDatabaseError(error, code, constraint));
      await db.exec("ROLLBACK TO SAVEPOINT duplicate_probe; RELEASE SAVEPOINT duplicate_probe");
    }
    for (const [table, column, value, count] of [["store_order_refund","store_order_id","77",2],["user_recharge","uid","77",2],
      ["wechat_user","uid","77",2],["wechat_user","unionid","'dup-union'",2],["wechat_user","openid","'dup-open-a'",1]]) {
      assert.equal(Number((await db.query(`SELECT count(*) AS count FROM ${table} WHERE ${column}=${value}`)).rows[0].count), count);
    }
    await db.exec("UPDATE wechat_user SET openid='dup-open-updated' WHERE openid='dup-open-a'");
    assert.deepEqual((await db.query("SELECT openid FROM duplicate_index_child")).rows, [{ openid: "dup-open-updated" }]);
    await db.exec("DELETE FROM wechat_user WHERE openid='dup-open-updated'");
    assert.deepEqual((await db.query("SELECT * FROM duplicate_index_child")).rows, []);
  } finally { await db.exec("ROLLBACK"); }
  assert.deepEqual(await capture(), before);
  // Mixed already-retired state and hostile same-name temp tables must not redirect DDL.
  await db.exec("BEGIN");
  try {
    await db.exec(`DROP INDEX public.sor_store_order_id_idx RESTRICT; DROP INDEX public.ur_uid_idx RESTRICT;
      CREATE TEMP TABLE wechat_user(id integer); CREATE TEMP TABLE wu_openid_uq_idx(id integer); SET LOCAL search_path TO public,pg_temp`);
    const mixed = await capture();
    await db.exec(sql);
    expectRemoved(await capture(), mixed, names.slice(2));
    assert.equal((await db.query("SELECT to_regclass('pg_temp.wu_openid_uq_idx') IS NOT NULL AS kept")).rows[0].kept, true);
    await db.exec(sql);
    expectRemoved(await capture(), mixed, names.slice(2));
  } finally { await db.exec("ROLLBACK"); }
  assert.deepEqual(await capture(), before);
  await db.exec("BEGIN");
  try { await db.exec(sql); await db.exec("COMMIT"); }
  catch (error) { await db.exec("ROLLBACK"); throw error; }
  expectRemoved(await capture(), before);
  await db.exec(sql);
  expectRemoved(await capture(), before);
  console.log(`DB-009D2b3e ${format}: 5 guarded duplicate removals, ${refusals} dependency/drift refusals, retained OIDs/files/FK/unique/cascade/rows, rollback/mixed-state/no-op passed`);
  return { removedIndexes: entries.map(e => e.key), retainedIndexes: entries.map(e => e.retainedKey), dependencyAndDriftRefusals: refusals,
    dependentViewRefusals: 5, oldUniqueFkRefused: true, retainedFkOidsAndTriggersPreserved: true,
    failureRollbackConfirmed: true, nonTargetOidsAndFilesPreserved: true, fixtureRowsPreserved: 6,
    equalityLookupsConfirmed: true, uniqueAndCascadeEnforcementConfirmed: true, mixedStateAndTempIsolationConfirmed: true, noOpConfirmed: true };
};
