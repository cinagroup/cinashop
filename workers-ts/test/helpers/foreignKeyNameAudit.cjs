// Independent full old-ORM FK-name upgrade; never extends the index/constraint-add children.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const tsx = require("tsx/cjs/api");
const { readCatalog } = tsx.require("../../scripts/data-migration/postgres-catalog-audit.ts", __filename);
const { assertForeignKeyNamesAligned } = tsx.require("../../scripts/data-migration/foreign-key-name-contracts.ts", __filename);
const { matchesDatabaseError } = require("./constraintNameAudit.cjs");
const f = require("./foreignKeyNameFixtures.cjs"), q = f.quote;
const root = join(__dirname, "../..");
const manifest = JSON.parse(readFileSync(join(root, "audit/orm-foreign-key-name-reconciliation.json"), "utf8"));
const sql = readFileSync(join(root, "migrations/0143_foreign_key_name_alignment.sql"), "utf8");
const entries = manifest.entries;
const tables = [...new Set(entries.flatMap(e => [e.catalog.table,e.reference.table]))].sort();
const renamedCatalog = catalog => ({ ...catalog, constraints: catalog.constraints.map(c => {
  const e = entries.find(e => e.previousKey === c.key); return e ? e.catalog : c;
}).sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) });

async function auditForeignKeyNames({ api, models, format, database }) {
  const started = Date.now(), snapshot = api.generateDrizzleJson(models), old = structuredClone(snapshot);
  for (const e of entries) {
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot.tables["public."+e.catalog.table].foreignKeys[e.catalog.name])),e.snapshot);
    delete old.tables["public."+e.catalog.table].foreignKeys[e.catalog.name];
    old.tables["public."+e.catalog.table].foreignKeys[e.previousSnapshot.name]=e.previousSnapshot;
  }
  const proposal = await api.generateMigration(old,api.generateDrizzleJson(models,old.id));
  assert.equal(proposal.length,24);
  assert.equal(proposal.filter(s => s.includes(" DROP CONSTRAINT ")).length,12);
  assert.equal(proposal.filter(s => s.includes(" ADD CONSTRAINT ")).length,12);
  const initial = await api.generateMigration(api.generateDrizzleJson({}),old);
  const db = database ?? new PGlite();
  const read = () => readCatalog(async query => (await db.query(query)).rows);
  const capture = async () => ({
    catalog: await read(),
    objects: (await db.query("SELECT c.oid,c.relname,c.relkind,c.relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.oid")).rows,
    constraints: (await db.query("SELECT c.oid,to_jsonb(c) AS metadata FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY c.oid")).rows,
    indexes: (await db.query("SELECT i.indexrelid,to_jsonb(i) AS metadata FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY i.indexrelid")).rows,
    triggers: (await db.query("SELECT t.oid,to_jsonb(t) AS metadata FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY t.oid")).rows,
    dependencies: (await db.query(`SELECT d.* FROM pg_depend d WHERE
      (d.refclassid='pg_class'::regclass AND d.refobjid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'))
      OR (d.classid='pg_constraint'::regclass AND d.objid IN (SELECT c.oid FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'))
      OR (d.classid='pg_trigger'::regclass AND d.objid IN (SELECT t.oid FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'))
      ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype`)).rows,
    rows: (await db.query(tables.map(t => `SELECT '${t}' AS source,to_jsonb(t) AS row FROM public.${q(t)} t`).join(" UNION ALL ")+" ORDER BY source,row")).rows,
  });
  const expectAligned = (after,before) => {
    const expected = structuredClone(before);
    expected.catalog = renamedCatalog(before.catalog);
    for (const c of expected.constraints) {
      const oldRow = before.catalog.constraints.find(row => row.name===c.metadata.conname);
      const entry = oldRow && entries.find(e => e.previousKey===oldRow.key);
      if (entry) c.metadata.conname=entry.catalog.name;
    }
    assert.deepEqual(after,expected,"Only conname and logical constraint keys may change, not OIDs/files/indexes/triggers/dependencies/rows");
    assertForeignKeyNamesAligned(after.catalog,manifest);
  };
  const savepoint = async operation => {
    await db.exec("SAVEPOINT fk_name_probe");
    try { return await operation(); }
    finally { await db.exec("ROLLBACK TO SAVEPOINT fk_name_probe; RELEASE SAVEPOINT fk_name_probe"); }
  };
  const reject = (e,statement,code="23503") => assert.rejects(db.exec(statement),error => matchesDatabaseError(error,code,e.catalog.name));
  const alter = (e,tail) => `ALTER TABLE public.${q(e.catalog.table)} ${tail};`;
  const replace = (e,definition) => alter(e,`DROP CONSTRAINT ${q(e.previousCatalog.name)}`)+alter(e,`ADD CONSTRAINT ${q(e.previousCatalog.name)} ${definition}`);
  const rejectionCases=[], proposalLongNamesTruncated=[], proposalIdentityReplacements=[];
  try {
    await db.exec(initial.join("\n"));
    const initialState=await capture();
    for (const e of entries) assert.deepEqual(initialState.catalog.constraints.find(c=>c.key===e.previousKey),e.previousCatalog);
    const version=Number((await db.query("SELECT current_setting('server_version_num') AS version")).rows[0].version);
    assert.ok(Math.floor(version/10000)===16 || Math.floor(version/10000)===18,"Only reviewed PG16/PGlite18 semantics");
    await db.exec("BEGIN");
    try {
      await f.seedAll(db,tables);
      await db.exec(`CREATE VIEW fk_name_event_view AS SELECT id FROM city_delivery_callback_event;
        CREATE VIEW fk_name_outbox_view AS SELECT event_id FROM city_delivery_callback_outbox;
        CREATE FUNCTION fk_name_row_probe() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
        CREATE TRIGGER fk_name_row_probe BEFORE UPDATE ON city_delivery_callback_outbox FOR EACH ROW EXECUTE FUNCTION fk_name_row_probe()`);
      const fixture=await capture();
      const rejectDrift=async (name,setup) => {
        await savepoint(async()=>{await db.exec(setup);await assert.rejects(db.exec(sql),error=>(assert.equal(error.code,"P0001"),assert.match(error.message,/0143/),true));});
        assert.deepEqual(await capture(),fixture,name+" rollback");rejectionCases.push(name);
      };
      for(const e of entries) {
        await rejectDrift("missing:"+e.key,alter(e,`DROP CONSTRAINT ${q(e.previousCatalog.name)}`));
        await rejectDrift("both-names:"+e.key,alter(e,`ADD CONSTRAINT ${q(e.catalog.name)} ${e.catalog.definition}`));
        await rejectDrift("unknown-alias:"+e.key,alter(e,`ADD CONSTRAINT fk_name_unknown ${e.catalog.definition}`));
        await rejectDrift("validation:"+e.key,replace(e,e.catalog.definition+" NOT VALID"));
        await rejectDrift("definition:"+e.key,replace(e,"CHECK (true)"));
        await rejectDrift("delete-action:"+e.key,replace(e,e.catalog.definition.replace(/ON DELETE (RESTRICT|CASCADE)/,m=>m.endsWith("CASCADE")?"ON DELETE RESTRICT":"ON DELETE CASCADE")));
        await rejectDrift("deferred:"+e.key,alter(e,`ALTER CONSTRAINT ${q(e.previousCatalog.name)} DEFERRABLE INITIALLY DEFERRED`));
        await rejectDrift("child-triggers:"+e.key,alter(e,"DISABLE TRIGGER ALL"));
        await rejectDrift("parent-triggers:"+e.key,`ALTER TABLE ${q(e.reference.table)} DISABLE TRIGGER ALL`);
        const constraint=fixture.constraints.find(c=>c.metadata.conname===e.previousCatalog.name);
        const trigger=fixture.triggers.find(t=>String(t.metadata.tgconstraint)===String(constraint.oid)&&t.metadata.tgtype===9);
        assert.ok(trigger,e.key+" parent delete trigger");
        await rejectDrift("one-always-trigger:"+e.key,`ALTER TABLE ${q(e.reference.table)} ENABLE ALWAYS TRIGGER ${q(trigger.metadata.tgname)}`);
        await rejectDrift("wrong-parent:"+e.key,`CREATE TABLE fk_name_other_parent (LIKE public.${q(e.reference.table)} INCLUDING ALL);
          INSERT INTO fk_name_other_parent SELECT * FROM public.${q(e.reference.table)};`+
          replace(e,e.catalog.definition.replace(`REFERENCES ${e.reference.table}(`,"REFERENCES fk_name_other_parent(")));
      }
      for(const [name,setup] of [
        ["nullable-child","ALTER TABLE city_delivery_callback_outbox ALTER COLUMN event_id DROP NOT NULL"],
        ["nullable-contract","ALTER TABLE payment_reconciliation_case ALTER COLUMN callback_event_id SET NOT NULL"],
        ["column-type","ALTER TABLE data_migration_checkpoint ALTER COLUMN run_id TYPE varchar(65)"],
        ["missing-column","ALTER TABLE city_delivery_callback_watermark RENAME COLUMN last_event_id TO previous_event"],
        ["missing-table","ALTER TABLE wechat_callback_watermark RENAME TO previous_watermark"],
        ["missing-schema","SET LOCAL search_path TO fk_name_absent"],
        ["parent-key-name","ALTER TABLE city_delivery_callback_event RENAME CONSTRAINT city_delivery_callback_event_pkey TO unknown_parent_key"],
        ["inherited","CREATE TABLE fk_name_inherited() INHERITS(city_delivery_callback_outbox)"],
        ["unlogged","ALTER TABLE city_delivery_callback_outbox SET UNLOGGED"],
      ]) await rejectDrift(name,setup);
      for(const e of entries) {
        const drop=proposal.find(s=>s===`ALTER TABLE ${q(e.catalog.table)} DROP CONSTRAINT ${q(e.previousSnapshot.name)};\n`);
        const add=proposal.find(s=>s.startsWith(`ALTER TABLE ${q(e.catalog.table)} ADD CONSTRAINT ${q(e.catalog.name)} `));
        assert.ok(drop&&add,e.key+" exact raw generator proposal");
        await savepoint(async()=>{
          if(e.previousSnapshot.name!==e.previousCatalog.name) {
            assert.match(e.previousSnapshot.name,/^[a-z0-9_]+$/);
            assert.equal(e.previousSnapshot.name.slice(0,63),e.previousCatalog.name);
            proposalLongNamesTruncated.push(e.key);
          }
          const previous=fixture.constraints.find(c=>c.metadata.conname===e.previousCatalog.name);
          await db.exec(drop);await db.exec(add);
          const after=await capture(),current=after.constraints.find(c=>c.metadata.conname===e.catalog.name);
          assert.notEqual(String(current.oid),String(previous.oid),"DROP/ADD replaces the actual constraint");
          const oldTriggers=fixture.triggers.filter(t=>String(t.metadata.tgconstraint)===String(previous.oid));
          const newTriggers=after.triggers.filter(t=>String(t.metadata.tgconstraint)===String(current.oid));
          assert.equal(oldTriggers.length,4);assert.equal(newTriggers.length,4);
          assert.ok(newTriggers.every(t=>!oldTriggers.some(old=>String(old.oid)===String(t.oid))));
          proposalIdentityReplacements.push(e.key);
        });
        assert.deepEqual(await capture(),fixture);
      }
      const point='target_schema,target."table",target."previousName",target.name);';
      assert.equal(sql.split(point).length,2);
      await savepoint(()=>assert.rejects(db.exec(sql.replace(point,point+"\n        PERFORM 1/0;")),{code:"22012"}));
      assert.deepEqual(await capture(),fixture,"First actual rename rollback");
      await db.exec(sql);expectAligned(await capture(),fixture);
      const aligned=await capture();await db.exec(sql);assert.deepEqual(await capture(),aligned,"No-op including all internal/user triggers");
    } finally { await db.exec("ROLLBACK"); }
    assert.deepEqual(await capture(),initialState);
    console.log(`DB-009E3 ${format} ${rejectionCases.length} drift refusals / 12 raw proposal hazards: ${Date.now()-started}ms`);
    // Each FK has an isolated business-row contract, avoiding another child's error masking it.
    await db.exec("BEGIN");
    try {
      await db.exec(sql);
      for(const e of entries) await savepoint(async()=>{
        await f.seedParents(db,e.catalog.table);
        await db.exec(f.insert(e.catalog.table,f.row(e.catalog.table,1)));
        const bad=e.columns[0].name==="run_id"?"absent_fk_run":2011000999;
        await savepoint(()=>reject(e,f.update(e.catalog.table,{[e.columns[0].name]:bad})));
        await savepoint(()=>reject(e,f.insert(e.catalog.table,{...f.row(e.catalog.table,2),[e.columns[0].name]:bad})));
        const parentValue=e.reference.columns[0].name==="run_id"?f.run(1):f.id(1);
        const predicate=` WHERE ${q(e.reference.columns[0].name)}=${f.literal(parentValue)}`;
        await savepoint(()=>reject(e,`UPDATE ${q(e.reference.table)} SET ${q(e.reference.columns[0].name)}=${f.literal(bad)}`+predicate));
        if(e.previousSnapshot.onDelete==="cascade") {
          await db.exec(`DELETE FROM ${q(e.reference.table)}`+predicate);
          assert.equal((await db.query(`SELECT count(*)::integer AS n FROM ${q(e.catalog.table)}`)).rows[0].n,0);
        } else await savepoint(()=>reject(e,`DELETE FROM ${q(e.reference.table)}`+predicate,version>=180000?"23001":"23503"));
        if(!e.columns[0].notNull) await db.exec(f.update(e.catalog.table,{[e.columns[0].name]:null}));
      });
    } finally { await db.exec("ROLLBACK"); }
    assert.deepEqual(await capture(),initialState);
    await db.exec("BEGIN");
    try {
      const e=entries[0];await db.exec(alter(e,`RENAME CONSTRAINT ${q(e.previousCatalog.name)} TO ${q(e.catalog.name)}`));
      await db.exec("CREATE TEMP TABLE city_delivery_callback_outbox(id integer); SET LOCAL search_path TO public,pg_temp");
      await db.exec(sql);expectAligned(await capture(),initialState);
      assert.equal((await db.query("SELECT to_regclass('pg_temp.city_delivery_callback_outbox') IS NOT NULL AS kept")).rows[0].kept,true);
    } finally { await db.exec("ROLLBACK"); }
    assert.deepEqual(await capture(),initialState);
    await db.exec("BEGIN");
    try {
      await db.exec("CREATE SCHEMA fk_name_scope");
      for(const table of tables) await db.exec(`CREATE TABLE fk_name_scope.${q(table)} (LIKE public.${q(table)} INCLUDING ALL)`);
      for(const e of entries) await db.exec(`ALTER TABLE fk_name_scope.${q(e.catalog.table)} ADD CONSTRAINT ${q(e.previousCatalog.name)} FOREIGN KEY (${q(e.columns[0].name)}) REFERENCES fk_name_scope.${q(e.reference.table)} (${q(e.reference.columns[0].name)}) ON DELETE ${e.previousSnapshot.onDelete}`);
      const scopedFixture=await capture();
      await db.exec("CREATE TEMP TABLE city_delivery_callback_outbox(id integer); SET LOCAL search_path TO fk_name_scope,pg_temp,public,pg_catalog");
      await db.exec(sql);await db.exec(sql);
      assert.equal((await db.query("SHOW search_path")).rows[0].search_path,"fk_name_scope, pg_temp, public, pg_catalog");
      await db.exec("SET LOCAL search_path TO pg_catalog,fk_name_scope,pg_temp,public");
      const scoped=await readCatalog(async query=>(await db.query(query.replaceAll("n.nspname='public'","n.nspname='fk_name_scope'"))).rows);
      assertForeignKeyNamesAligned(scoped,manifest);
      assert.equal((await db.query("SELECT count(*)::integer AS n FROM pg_constraint c JOIN pg_class p ON p.oid=c.confrelid JOIN pg_namespace n ON n.oid=p.relnamespace WHERE c.connamespace='fk_name_scope'::regnamespace AND c.contype='f' AND n.nspname='fk_name_scope'")).rows[0].n,12);
      await db.exec("SET LOCAL search_path TO public,pg_temp");assert.deepEqual(await capture(),scopedFixture);
    } finally { await db.exec("ROLLBACK"); }
    assert.deepEqual(await capture(),initialState);
    await db.exec(sql);expectAligned(await capture(),initialState);
    const final=await capture();await db.exec(sql);assert.deepEqual(await capture(),final);
    assert.deepEqual(await api.generateMigration(snapshot,api.generateDrizzleJson(models,snapshot.id)),[]);
    console.log(`DB-009E3 ${format}: 12 foreign keys renamed; writes/parent actions/NULL/OIDs/triggers/rows/dependencies/rollback/no-op/schema isolation passed`);
    return { initialStatements:initial.length,guardedStatements:1,generatedProposalStatements:proposal.length,
      renamedKeys:entries.map(e=>e.key),rejectionCases,proposalLongNamesTruncated,proposalIdentityReplacements,
      exactInvalidInsertAndUpdateContracts:12,noActionParentUpdates:12,restrictParentDeletes:11,cascadeParentDeletes:1,nullableReferences:2,
      originalConstraintAndTriggerOidsPreserved:true,rowsIndexesFilesAndDependenciesPreserved:true,
      failureRollbackConfirmed:true,noOpConfirmed:true,mixedStateAndTempIsolationConfirmed:true,nonPublicSchemaIsolationConfirmed:true };
  } finally { if(!database) await db.close(); }
}
module.exports=auditForeignKeyNames;
