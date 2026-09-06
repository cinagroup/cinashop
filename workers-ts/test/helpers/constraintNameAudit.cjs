// Real generator and engine probes in caller-created isolated databases only.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const manifest = JSON.parse(readFileSync(join(__dirname, "../../audit/orm-constraint-name-reconciliation.json"), "utf8"));
const entries = manifest.entries;
const ident = (name) => '"' + name.replaceAll('"', '""') + '"';

function matchesDatabaseError(error, code, constraint) {
  assert.equal(error.code, code);
  if (constraint) {
    // PGlite uses constraint; postgres.js names protocol field n constraint_name.
    const names = [error.constraint, error.constraint_name].filter((name) => name !== undefined);
    assert.ok(names.length > 0, "Missing database constraint error field");
    for (const name of names) assert.equal(name, constraint);
  }
  return true;
}

function holdOldNames(snapshot) {
  for (const e of entries) {
    const group = snapshot.tables[`public.${e.catalog.table}`][e.snapshotField];
    assert.deepEqual(group[e.catalog.name], { ...e.previousSnapshotConstraint, name: e.catalog.name });
    assert.equal(group[e.previousCatalog.name], undefined);
    delete group[e.catalog.name];
    group[e.previousCatalog.name] = structuredClone(e.previousSnapshotConstraint);
  }
  return snapshot;
}

async function auditConstraintNames({ api, models, previous, db, read, objects, format }) {
  assert.equal(entries.length, 3);
  const sql = readFileSync(join(__dirname, "../../migrations/0139_constraint_name_alignment.sql"), "utf8");
  const generated = api.generateDrizzleJson(models, previous.id);
  // Keep earlier independently audited ordinary index phases unchanged. Only
  // these three constraints advance to their actual current model definitions.
  const target = structuredClone(previous);
  target.id = generated.id; target.prevId = previous.id;
  for (const e of entries) {
    const group = target.tables[`public.${e.catalog.table}`][e.snapshotField];
    assert.deepEqual(group[e.previousCatalog.name], e.previousSnapshotConstraint);
    delete group[e.previousCatalog.name];
    group[e.catalog.name] = generated.tables[`public.${e.catalog.table}`][e.snapshotField][e.catalog.name];
    assert.deepEqual(group[e.catalog.name], { ...e.previousSnapshotConstraint, name: e.catalog.name });
  }
  const proposed = await api.generateMigration(previous, target);
  const drops = proposed.filter((s) => s.includes(" DROP CONSTRAINT "));
  const additions = proposed.filter((s) => s.includes(" ADD CONSTRAINT "));
  assert.equal(proposed.length, 6); assert.equal(additions.length, 3);
  assert.deepEqual([...drops].sort(), entries.map((e) => `ALTER TABLE ${ident(e.catalog.table)} DROP CONSTRAINT ${ident(e.previousCatalog.name)};`).sort());
  assert.deepEqual(additions.map((s) => s.match(/ADD CONSTRAINT "([a-z0-9_]+)"/)?.[1]).sort(), entries.map((e) => e.catalog.name).sort());
  const capture = async () => ({ catalog: await read(), objects: await objects(),
    constraints: (await db.query(`SELECT c.* FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY c.oid`)).rows,
    storage: (await db.query(`SELECT c.oid,c.relfilenode,c.reltablespace,pg_relation_filepath(c.oid) AS file FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='i' ORDER BY c.oid`)).rows,
    dependencies: (await db.query(`SELECT d.* FROM pg_depend d WHERE
      (d.classid='pg_class'::regclass AND d.objid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')) OR
      (d.refclassid='pg_class'::regclass AND d.refobjid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')) OR
      (d.classid='pg_constraint'::regclass AND d.objid IN (SELECT c.oid FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public')) OR
      (d.refclassid='pg_constraint'::regclass AND d.refobjid IN (SELECT c.oid FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'))
      ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype`)).rows,
    triggers: (await db.query(`SELECT g.* FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY g.oid`)).rows,
    rows: (await db.query(`SELECT 'run' AS source,to_jsonb(t) AS row FROM data_migration_run t UNION ALL SELECT 'checkpoint',to_jsonb(t) FROM data_migration_checkpoint t UNION ALL SELECT 'visitor',to_jsonb(t) FROM kefu_visitor_session t ORDER BY source,row`)).rows,
  });
  const after = (baseline) => { const catalog = { ...baseline.catalog };
    for (const kind of ["indexes", "constraints"]) catalog[kind] = catalog[kind].map((row) => {
      const e = entries.find((e) => e.previousKey === row.key); return e ? (kind === "indexes" ? e.catalog : e.constraint) : row;
    }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const rename = (name) => entries.find((e) => e.previousCatalog.name === name)?.catalog.name ?? name;
    return { ...baseline, catalog, objects: baseline.objects.map((row) => ({ ...row, relname: rename(row.relname) })),
      constraints: baseline.constraints.map((row) => ({ ...row, conname: rename(row.conname) })) };
  };
  const before = await capture();
  for (const e of entries) {
    assert.deepEqual(before.catalog.indexes.find((r) => r.key === e.previousKey), e.previousCatalog);
    assert.deepEqual(before.catalog.constraints.find((r) => r.key === e.previousKey), e.previousConstraint);
  }
  const reject = async (query, code, constraint) => { await db.exec("SAVEPOINT constraint_probe");
    await assert.rejects(db.exec(query), (error) => matchesDatabaseError(error, code, constraint));
    await db.exec("ROLLBACK TO SAVEPOINT constraint_probe; RELEASE SAVEPOINT constraint_probe"); };
  await db.exec("BEGIN");
  try {
    await db.exec(`INSERT INTO data_migration_run(run_id,manifest_version,source_fingerprint) VALUES('constraint-fixture','test',repeat('f',64));
      INSERT INTO data_migration_checkpoint(run_id,table_name) VALUES('constraint-fixture','table-a'),('constraint-fixture','table-b');
      INSERT INTO kefu_visitor_session(session_id,visitor_uid,service_id,kefu_uid,token_hash,created_at,expires_at,last_seen_at)
      VALUES('constraint-visitor-a',1300000001,1,7,repeat('d',64),1,20,1),('constraint-visitor-b',1300000002,1,7,repeat('e',64),1,20,1);
      CREATE TABLE constraint_fk_fixture(run_id varchar(64),table_name varchar(64),token_hash varchar(64),visitor_uid integer,
        CONSTRAINT constraint_checkpoint_fk FOREIGN KEY(run_id,table_name) REFERENCES data_migration_checkpoint(run_id,table_name) ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT constraint_token_fk FOREIGN KEY(token_hash) REFERENCES kefu_visitor_session(token_hash) ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT constraint_visitor_fk FOREIGN KEY(visitor_uid) REFERENCES kefu_visitor_session(visitor_uid) ON DELETE CASCADE ON UPDATE CASCADE);
      INSERT INTO constraint_fk_fixture VALUES('constraint-fixture','table-a',repeat('d',64),1300000001)`);
    for (const [i,e] of entries.entries()) await db.exec(`CREATE VIEW constraint_name_view_${i} AS SELECT 'public.${ident(e.previousCatalog.name)}'::regclass AS referenced_index`);
    const fixture = await capture();
    const child = (await db.query("SELECT * FROM constraint_fk_fixture")).rows;
    for (const [i,e] of entries.entries()) {
      const fk = ["constraint_checkpoint_fk", "constraint_token_fk", "constraint_visitor_fk"][i];
      assert.equal(fixture.constraints.find((c) => c.conname === fk).conindid, fixture.objects.find((r) => r.relname === e.previousCatalog.name).oid);
      await reject(`DROP INDEX public.${ident(e.previousCatalog.name)}`, "2BP01");
    }
    for (const query of [...drops, proposed.join("\n")]) await reject(query, "2BP01");
    assert.deepEqual(await capture(), fixture);
    await db.exec(sql); assert.deepEqual(await capture(), after(fixture));
    for (const [i,e] of entries.entries()) assert.equal((await db.query(`SELECT referenced_index::oid AS oid FROM constraint_name_view_${i}`)).rows[0].oid, fixture.objects.find((r) => r.relname === e.previousCatalog.name).oid);
    for (const [query,name] of [
      ["INSERT INTO data_migration_checkpoint(run_id,table_name) VALUES('constraint-fixture','table-a')",entries[0].catalog.name],
      ["UPDATE kefu_visitor_session SET token_hash=repeat('d',64) WHERE session_id='constraint-visitor-b'",entries[1].catalog.name],
      ["UPDATE kefu_visitor_session SET visitor_uid=1300000001 WHERE session_id='constraint-visitor-b'",entries[2].catalog.name],
    ]) await reject(query,"23505",name);
    for (const assignment of ["table_name='absent'", "token_hash=repeat('f',64)", "visitor_uid=1399999999"]) await reject(`UPDATE constraint_fk_fixture SET ${assignment}`, "23503");
    for (const query of ["DELETE FROM data_migration_checkpoint WHERE run_id='constraint-fixture' AND table_name='table-a'", "DELETE FROM kefu_visitor_session WHERE session_id='constraint-visitor-a'"]) {
      await db.exec("SAVEPOINT constraint_probe"); await db.exec(query);
      assert.deepEqual((await db.query("SELECT * FROM constraint_fk_fixture")).rows, []);
      await db.exec("ROLLBACK TO SAVEPOINT constraint_probe; RELEASE SAVEPOINT constraint_probe");
    }
    for (const [query,field,value] of [
      ["UPDATE data_migration_checkpoint SET table_name='renamed' WHERE run_id='constraint-fixture' AND table_name='table-a'","table_name","renamed"],
      ["UPDATE kefu_visitor_session SET token_hash=repeat('f',64) WHERE session_id='constraint-visitor-a'","token_hash","f".repeat(64)],
      ["UPDATE kefu_visitor_session SET visitor_uid=1300000003 WHERE session_id='constraint-visitor-a'","visitor_uid",1300000003],
    ]) { await db.exec("SAVEPOINT constraint_probe"); await db.exec(query);
      assert.deepEqual((await db.query("SELECT * FROM constraint_fk_fixture")).rows,[{ ...child[0], [field]:value }]);
      await db.exec("ROLLBACK TO SAVEPOINT constraint_probe; RELEASE SAVEPOINT constraint_probe"); }
    assert.deepEqual((await db.query("SELECT * FROM constraint_fk_fixture")).rows,child);
    assert.deepEqual(await capture(), after(fixture)); await db.exec(sql); assert.deepEqual(await capture(), after(fixture));
  } finally { await db.exec("ROLLBACK"); }
  assert.deepEqual(await capture(), before);
  const last=entries.at(-1), old=ident(last.previousCatalog.name), canonical=ident(last.catalog.name);
  const drop=`ALTER TABLE kefu_visitor_session DROP CONSTRAINT ${old};`;
  const cases=[
    ["missing-pair",drop], ["index-without-constraint",`${drop} CREATE UNIQUE INDEX ${old} ON kefu_visitor_session(visitor_uid)`],
    ["target-index-collision",`CREATE INDEX ${canonical} ON kefu_visitor_session(visitor_uid)`],
    ["both-constraints",`ALTER TABLE kefu_visitor_session ADD CONSTRAINT ${canonical} UNIQUE(visitor_uid)`],
    ["wrong-columns",`${drop} ALTER TABLE kefu_visitor_session ADD CONSTRAINT ${old} UNIQUE(token_hash)`],
    ["deferrable",`${drop} ALTER TABLE kefu_visitor_session ADD CONSTRAINT ${old} UNIQUE(visitor_uid) DEFERRABLE INITIALLY DEFERRED`],
    ["nulls-not-distinct",`${drop} ALTER TABLE kefu_visitor_session ADD CONSTRAINT ${old} UNIQUE NULLS NOT DISTINCT(visitor_uid)`],
    ["include",`${drop} ALTER TABLE kefu_visitor_session ADD CONSTRAINT ${old} UNIQUE(visitor_uid) INCLUDE(session_id)`],
    ["wrong-type",`${drop} ALTER TABLE kefu_visitor_session ADD CONSTRAINT ${old} CHECK(visitor_uid>0)`],
    ["target-wrong-columns",`${drop} ALTER TABLE kefu_visitor_session ADD CONSTRAINT ${canonical} UNIQUE(token_hash)`],
    ["missing-table","ALTER TABLE kefu_visitor_session RENAME TO constraint_missing_fixture"],
    ["missing-schema","SET LOCAL search_path TO absent_constraint_fixture"],
  ];
  for (const [name,fixture] of cases) {
    await db.exec("BEGIN"); try { await db.exec(fixture); await assert.rejects(db.exec(sql), /0139 /, name); }
    finally { await db.exec("ROLLBACK"); } assert.deepEqual(await capture(),before,name);
  }
  const rename="EXECUTE format('ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I',target_schema,item.table_name,item.old_name,item.target_name);";
  assert.equal(sql.split(rename).length,2);
  await db.exec("BEGIN"); try { await assert.rejects(db.exec(sql.replace(rename,rename+"\nPERFORM 1/0;")),{code:"22012"}); }
  finally { await db.exec("ROLLBACK"); } assert.deepEqual(await capture(),before);
  await db.exec("BEGIN"); try {
    const e=entries[0]; await db.exec(`ALTER TABLE public.${ident(e.catalog.table)} RENAME CONSTRAINT ${ident(e.previousCatalog.name)} TO ${ident(e.catalog.name)}`);
    await db.exec(sql); assert.deepEqual(await capture(),after(before));
  } finally { await db.exec("ROLLBACK"); } assert.deepEqual(await capture(),before);
  await db.exec("BEGIN"); try {
    await db.exec("CREATE SCHEMA constraint_name_fixture");
    for(const table of new Set(entries.map(e=>e.catalog.table))) await db.exec(`CREATE TABLE constraint_name_fixture.${ident(table)} (LIKE public.${ident(table)})`);
    for(const e of entries) await db.exec(`ALTER TABLE constraint_name_fixture.${ident(e.catalog.table)} ADD CONSTRAINT ${ident(e.previousCatalog.name)} ${e.constraint.definition}`);
    await db.exec(`CREATE TEMP TABLE ${ident(entries[0].previousCatalog.name)}(fixture integer); CREATE TEMP TABLE ${ident(entries[0].catalog.name)}(fixture integer);
      INSERT INTO pg_temp.${ident(entries[0].previousCatalog.name)} VALUES(7); INSERT INTO pg_temp.${ident(entries[0].catalog.name)} VALUES(8);
      SET LOCAL search_path TO constraint_name_fixture,pg_temp,public`);
    const scoped=async()=>(await db.query(`SELECT c.oid,c.conname,c.conindid,x.relname,x.relfilenode FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace JOIN pg_class x ON x.oid=c.conindid WHERE n.nspname='constraint_name_fixture' ORDER BY c.oid`)).rows;
    const prior=await scoped(); await db.exec(sql);
    const expected=prior.map(row=>{const name=entries.find(e=>e.previousCatalog.name===row.conname).catalog.name;return {...row,conname:name,relname:name};});
    assert.deepEqual(await scoped(),expected); await db.exec(sql); assert.deepEqual(await scoped(),expected);
    for(const [name,value] of [[entries[0].previousCatalog.name,7],[entries[0].catalog.name,8]]) assert.deepEqual((await db.query(`SELECT * FROM pg_temp.${ident(name)}`)).rows,[{fixture:value}]);
    await db.exec("SET LOCAL search_path TO public,pg_temp"); assert.deepEqual(await capture(),before);
  } finally { await db.exec("ROLLBACK"); } assert.deepEqual(await capture(),before);
  await db.exec(sql); assert.deepEqual(await capture(),after(before)); await db.exec(sql); assert.deepEqual(await capture(),after(before));
  console.log(`DB-009D2b3d ${format}: 3 owning constraints renamed, OIDs/files/3 FKs/3 views preserved, 7 destructive refusals, 12 drift rollbacks, unique/FK/cascade/no-op passed`);
  return { targetSnapshot:target, verification:{guardedStatements:1,renamedConstraints:3,renamedIndexes:3,generatorProposedStatements:6,generatorAppliedAsUpgrade:false,
    destructiveDependencyRejections:7,dependentForeignKeysPreserved:3,dependentViewsPreserved:3,fixtureRowsPreserved:5,foreignKeyRowsPreserved:1,
    constraintAndIndexOidsAndFilesPreserved:true,dependenciesAndTriggersPreserved:true,uniqueAndForeignKeyEnforcementConfirmed:true,canonicalErrorNamesConfirmed:true,updateAndDeleteCascadesConfirmed:true,
    rejectionCases:cases.map(([name])=>name),failureRollbackConfirmed:true,mixedStateConfirmed:true,schemaIsolationConfirmed:true,idempotent:true} };
}
module.exports = auditConstraintNames;
module.exports.holdOldNames = holdOldNames;
module.exports.matchesDatabaseError = matchesDatabaseError;
