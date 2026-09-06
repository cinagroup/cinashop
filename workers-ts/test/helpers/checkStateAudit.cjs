// Independent full old-ORM CHECK path; local PGlite or identity-checked CI PostgreSQL 16.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const tsx = require("tsx/cjs/api");
const { readCatalog } = tsx.require("../../scripts/data-migration/postgres-catalog-audit.ts", __filename);
const { assertCheckStatesAligned } = tsx.require("../../scripts/data-migration/check-state-contracts.ts", __filename);
const { matchesDatabaseError } = require("./constraintNameAudit.cjs");
const f = require("./checkStateFixtures.cjs"), q=f.quote, l=f.literal;
const root=join(__dirname,"../..");
const manifest=JSON.parse(readFileSync(join(root,"audit/orm-check-state-reconciliation.json"),"utf8"));
const sql=readFileSync(join(root,"migrations/0144_check_state_alignment.sql"),"utf8");
const entries=manifest.entries, tables=[...new Set(entries.map(e=>e.catalog.table))].sort();
const alter=(e,tail,schema="public")=>"ALTER TABLE "+q(schema)+"."+q(e.catalog.table)+" "+tail+";";
const replace=(e,definition)=>alter(e,"DROP CONSTRAINT "+q(e.catalog.name))+alter(e,"ADD CONSTRAINT "+q(e.catalog.name)+" "+definition);
const target=(e,schema="public")=>alter(e,"DROP CONSTRAINT "+q(e.catalog.name),schema)+alter(e,"ADD "+e.targetSource.sql,schema);
const normalized=(rows)=>rows.map(row=>JSON.stringify(row)).sort();
// This is an internal node-tree comparison, not normalization of catalog SQL.
const withoutLocations=tree=>tree.replace(/ :location -?[0-9]+(?=[ )}])/g," :location -1");

module.exports=async function auditCheckStates({api,models,format,database}) {
  const started=Date.now(),snapshot=api.generateDrizzleJson(models),old=structuredClone(snapshot);
  for(const e of entries) {
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot.tables["public."+e.catalog.table].checkConstraints[e.catalog.name])),e.snapshot);
    old.tables["public."+e.catalog.table].checkConstraints[e.catalog.name]=e.previousSnapshot;
  }
  const proposal=await api.generateMigration(old,api.generateDrizzleJson(models,old.id));
  assert.equal(proposal.length,18);
  assert.equal(proposal.filter(s=>s.includes(" DROP CONSTRAINT ")).length,9);
  assert.equal(proposal.filter(s=>s.includes(" ADD CONSTRAINT ")).length,9);
  const initial=await api.generateMigration(api.generateDrizzleJson({}),old);
  const db=database??new PGlite();
  let constraintClass;
  const locationOnlyExpressionChanges=new Set();
  const read=()=>readCatalog(async query=>(await db.query(query)).rows);
  const capture=async()=>({
    catalog:await read(),
    objects:(await db.query("SELECT c.oid,to_jsonb(c) AS metadata FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.oid")).rows,
    constraints:(await db.query("SELECT c.oid,to_jsonb(c) AS metadata,pg_get_constraintdef(c.oid,false) AS definition,obj_description(c.oid,'pg_constraint') AS comment FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY c.oid")).rows,
    indexes:(await db.query("SELECT i.indexrelid,to_jsonb(i) AS metadata FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY i.indexrelid")).rows,
    triggers:(await db.query("SELECT t.oid,to_jsonb(t) AS metadata FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY t.oid")).rows,
    functions:(await db.query("SELECT p.oid,to_jsonb(p) AS metadata FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.oid")).rows,
    dependencies:(await db.query("SELECT d.* FROM pg_depend d WHERE (d.refclassid='pg_class'::regclass AND d.refobjid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')) OR (d.classid='pg_constraint'::regclass AND d.objid IN (SELECT c.oid FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public')) OR (d.refclassid='pg_constraint'::regclass AND d.refobjid IN (SELECT c.oid FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public')) ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype")).rows,
    rows:(await db.query(tables.map(t=>"SELECT "+l(t)+" AS source,to_jsonb(t) AS row FROM public."+q(t)+" t").join(" UNION ALL ")+" ORDER BY source,row")).rows,
  });
  const expectAligned=(after,before)=>{
    const expected=structuredClone(before), replacements=[];
    expected.catalog.constraints=before.catalog.constraints.map(c=>entries.find(e=>e.key===c.key)?.catalog??c);
    for(const e of entries) {
      const a=after.constraints.find(c=>c.metadata.conname===e.catalog.name),b=before.constraints.find(c=>c.metadata.conname===e.catalog.name);
      assert.ok(a&&b,e.key);
      const aligned=b.definition===e.catalog.definition&&b.metadata.convalidated===e.catalog.validated;
      if(aligned) assert.deepEqual(a,b,e.key+" no-op preserves identity");
      else {
        assert.notEqual(String(a.oid),String(b.oid),e.key+" target OID must change");
        const omit=c=>{const result={...c.metadata};delete result.oid;delete result.conbin;delete result.convalidated;return result;};
        assert.deepEqual(omit(a),omit(b),e.key+" all other CHECK metadata");
        assert.equal(a.comment,b.comment,e.key+" comment");
        assert.equal(a.definition,e.catalog.definition);
        assert.equal(a.metadata.convalidated,e.catalog.validated);
        if(!e.catalog.validated) {
          assert.equal(withoutLocations(a.metadata.conbin),withoutLocations(b.metadata.conbin),
            e.key+" all parsed expression fields except source character offsets");
          if(a.metadata.conbin!==b.metadata.conbin)locationOnlyExpressionChanges.add(e.key);
        }
        replacements.push([b.oid,a.oid]);
      }
      expected.constraints[expected.constraints.findIndex(c=>String(c.oid)===String(b.oid))]=a;
    }
    expected.constraints.sort((a,b)=>Number(a.oid)-Number(b.oid));
    for(const d of expected.dependencies) {
      const changed=replacements.find(([oid])=>String(oid)===String(d.objid));
      if(changed&&String(d.classid)===String(constraintClass))d.objid=changed[1];
    }
    assert.deepEqual(normalized(after.dependencies),normalized(expected.dependencies),"Only target constraint dependency object IDs may change");
    expected.dependencies=after.dependencies;
    assert.deepEqual(after,expected,"No row/table/file/index/trigger/function/non-target constraint change");
    assertCheckStatesAligned(after.catalog,manifest);
    return replacements.length;
  };
  const savepoint=async operation=>{
    await db.exec("SAVEPOINT check_state_probe");
    try{return await operation();}finally{await db.exec("ROLLBACK TO SAVEPOINT check_state_probe; RELEASE SAVEPOINT check_state_probe");}
  };
  const rejectWrite=(e,statement)=>assert.rejects(db.exec(statement),error=>matchesDatabaseError(error,"23514",e.catalog.name));
  const rejectionCases=[],rawProposalReplacements=[];
  let invalidInsertContracts=0,invalidUpdateContracts=0,validBoundaryContracts=0,nullColumns=0,committedOldRows=0,lockVerification=null;
  try {
    await db.exec(initial.join("\n"));
    constraintClass=(await db.query("SELECT 'pg_catalog.pg_constraint'::regclass::oid AS classid")).rows[0].classid;
    assert.ok(constraintClass);
    const initialState=await capture();
    const engine=Number((await db.query("SELECT current_setting('server_version_num') AS version")).rows[0].version);
    assert.ok([16,18].includes(Math.floor(engine/10000)));
    // Exercise the exact SQL offset comparison even on PG18, which writes -1.
    const tree=initialState.constraints.find(c=>c.metadata.conname==="da_status_ck").metadata.conbin;
    assert.match(tree,/ :location -?[0-9]+(?=[ )}])/);
    assert.ok(!tree.includes("'"));
    const shifted=tree.replace(/ :location -?[0-9]+(?=[ )}])/g," :location 12345");
    const engineNormalize=async value=>(await db.query("SELECT pg_catalog.regexp_replace("+l(value)+",' :location -?[0-9]+(?=[ )}])',' :location -1','g') AS tree")).rows[0].tree;
    const normalizedTree=await engineNormalize(tree);
    assert.equal(await engineNormalize(shifted),normalizedTree);
    assert.equal(withoutLocations(shifted),normalizedTree);
    for(const [pattern,value] of [[/:boolop and/,":boolop or"],[/:opno [0-9]+/,":opno 99999"],
      [/:opfuncid [0-9]+/,":opfuncid 99999"],[/:varattno [0-9]+/,":varattno 999"],
      [/:consttype [0-9]+/,":consttype 999"],[/:constisnull false/,":constisnull true"],
      [/:constvalue ([0-9]+) \[ [0-9]+/,":constvalue $1 [ 99"]]) {
      const drift=shifted.replace(pattern,value);
      assert.notEqual(drift,shifted);
      assert.notEqual(await engineNormalize(drift),normalizedTree,"Source-position exception cannot conceal semantic node drift");
    }
    for(const e of entries)assert.deepEqual(initialState.catalog.constraints.find(c=>c.key===e.key),e.previousCatalog);
    if(database?.withPeer) {
      lockVerification=await database.withPeer(async peer=>{
        await peer.exec("BEGIN; LOCK TABLE public.division_apply IN ACCESS SHARE MODE");
        const start=Date.now();
        try {await assert.rejects(db.exec(sql),{code:"55P03"});}
        finally {await peer.exec("ROLLBACK");}
        const lockRefusalMs=Date.now()-start;
        assert.deepEqual(await capture(),initialState,"Lock contention leaves all objects and rows unchanged");
        await db.exec("BEGIN");
        try {
          await db.exec(sql);
          await peer.exec("SET lock_timeout='250ms'");
          await assert.rejects(peer.exec(f.insert("division_apply",f.row("division_apply",500))),{code:"55P03"});
        }finally{await db.exec("ROLLBACK");}
        assert.deepEqual(await capture(),initialState,"Concurrent writer cannot see or use a DROP/ADD gap");
        return {lockWaitRefused:true,lockRefusalMs,concurrentWriterBlockedUntilTransactionEnd:true,rollbackConfirmed:true};
      });
    }
    await db.exec("BEGIN");
    try {
      for(const table of tables)await db.exec(f.insert(table,f.row(table)));
      for(const e of entries)await db.exec("COMMENT ON CONSTRAINT "+q(e.catalog.name)+" ON public."+q(e.catalog.table)+" IS "+l("审计 ' keep "+e.key));
      await db.exec("CREATE VIEW check_state_view AS SELECT status FROM division_apply; CREATE FUNCTION check_state_row_probe() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'; CREATE TRIGGER check_state_row_probe BEFORE UPDATE ON division_apply FOR EACH ROW EXECUTE FUNCTION check_state_row_probe()");
      const fixture=await capture();
      const mutationPoint='target_schema,target."table",target.name);';
      await savepoint(async()=>{
        await db.exec(alter(entries.at(-1),"DROP CONSTRAINT "+q(entries.at(-1).catalog.name)));
        await assert.rejects(db.exec(sql.replace(mutationPoint,mutationPoint+"\n        PERFORM 1/0;")),
          error=>error.code==="P0001"&&error.message.includes(entries.at(-1).catalog.name));
      });
      assert.deepEqual(await capture(),fixture,"Last missing CHECK is detected before the first DROP");
      const rejectDrift=async(name,setup)=>{
        await savepoint(async()=>{await db.exec(setup);await assert.rejects(db.exec(sql),error=>(assert.equal(error.code,"P0001"),assert.match(error.message,/0144/),true),name);});
        assert.deepEqual(await capture(),fixture,name+" rollback");rejectionCases.push(name);
      };
      for(const e of entries) {
        await rejectDrift("missing:"+e.key,alter(e,"DROP CONSTRAINT "+q(e.catalog.name)));
        await rejectDrift("definition:"+e.key,replace(e,"CHECK (true)"));
        const originalClause=e.targetSource.sql.replace("CONSTRAINT "+q(e.catalog.name),"CONSTRAINT check_state_alias").replace(/ NOT VALID$/,"");
        await rejectDrift("duplicate:"+e.key,alter(e,"ADD "+originalClause));
        await rejectDrift("no-inherit:"+e.key,replace(e,e.previousCatalog.definition+" NO INHERIT"));
      }
      const outbox=entries.find(e=>e.catalog.validated);
      await rejectDrift("outbox-not-valid",replace(outbox,outbox.catalog.definition+" NOT VALID"));
      for(const e of entries.filter(e=>!e.catalog.validated)) {
        await rejectDrift("wrong-unvalidated:"+e.key,replace(e,"CHECK (true) NOT VALID"));
      }
      for(const [name,setup] of [
        ["nullable","ALTER TABLE division_apply ALTER COLUMN status DROP NOT NULL"],
        ["type","DROP VIEW public.check_state_view; ALTER TABLE division_apply ALTER COLUMN status TYPE integer"],
        ["default","ALTER TABLE division_apply ALTER COLUMN status SET DEFAULT 1"],
        ["collation",'ALTER TABLE store_order_outbox ALTER COLUMN event_type TYPE varchar(64) COLLATE "C"'],
        ["missing-column","ALTER TABLE division_apply RENAME COLUMN status TO old_status"],
        ["missing-table","ALTER TABLE division_apply RENAME TO old_division_apply"],
        ["missing-schema","SET LOCAL search_path TO check_state_absent"],
        ["inherited","CREATE TABLE check_state_inherited() INHERITS(division_apply)"],
        ["unlogged","ALTER TABLE division_apply SET UNLOGGED"],
        ["function-dependency","CREATE FUNCTION check_state_custom(smallint) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT $1 BETWEEN 0 AND 2';"+replace(entries[0],"CHECK (check_state_custom(status))")],
      ])await rejectDrift(name,setup);
      // Real unguarded generator proposal is executable but discards comments/identity.
      for(const e of entries) {
        const drop=proposal.find(s=>s.startsWith("ALTER TABLE "+q(e.catalog.table)+" DROP CONSTRAINT "+q(e.catalog.name)));
        const add=proposal.find(s=>s.startsWith("ALTER TABLE "+q(e.catalog.table)+" ADD CONSTRAINT "+q(e.catalog.name)));
        assert.ok(drop&&add,e.key+" raw proposal");
        await savepoint(async()=>{
          await db.exec(drop);await db.exec(add);
          const after=await capture(),a=after.constraints.find(c=>c.metadata.conname===e.catalog.name),b=fixture.constraints.find(c=>c.metadata.conname===e.catalog.name);
          assert.notEqual(String(a.oid),String(b.oid));assert.equal(a.comment,null);
          assert.deepEqual(after.catalog.constraints.find(c=>c.key===e.key),e.catalog);
          rawProposalReplacements.push(e.key);
        });
        assert.deepEqual(await capture(),fixture);
      }
      for(const point of [
        "target_schema,target.\"table\",target.name);",
        "target_schema,target.\"table\",target.clause);",
      ]) {
        assert.equal(sql.split(point).length,2);
        await savepoint(()=>assert.rejects(db.exec(sql.replace(point,point+"\n        PERFORM 1/0;")),{code:"22012"}));
        assert.deepEqual(await capture(),fixture,"Actual DROP/ADD failure rolls back identity, comments and rows");
      }
      assert.equal(expectAligned((await db.exec(sql),await capture()),fixture),9);
      const aligned=await capture();await db.exec(sql);assert.deepEqual(await capture(),aligned);
    }finally{await db.exec("ROLLBACK");}
    assert.deepEqual(await capture(),initialState);
    // Each field is tested separately; CHECK errors must name the intended constraint.
    for(const phase of ["old","aligned"]) {
      await db.exec("BEGIN");
      try {
        if(phase==="aligned")await db.exec(sql);
        for(const e of entries)await savepoint(async()=>{
          await db.exec(f.insert(e.catalog.table,f.row(e.catalog.table)));
          for(const col of e.columns) {
            const allowed=col.name==="event_type"?f.events:f.bounds[col.name].filter(v=>v!==null);
            const bad=col.name==="event_type"?["unknown.event","ORDER.PAID","order.paid "]:
              [f.bounds[col.name][0]-(col.type.startsWith("numeric")?0.01:1),...(f.bounds[col.name][1]===null?[]:[f.bounds[col.name][1]+1])];
            for(const value of allowed)await savepoint(async()=>{
              await db.exec(f.update(e.catalog.table,{[col.name]:value}));
              await db.exec(f.insert(e.catalog.table,{...f.row(e.catalog.table,2),[col.name]:value}));
              validBoundaryContracts++;
            });
            for(const value of bad) {
              await savepoint(()=>rejectWrite(e,f.update(e.catalog.table,{[col.name]:value})));invalidUpdateContracts++;
              await savepoint(()=>rejectWrite(e,f.insert(e.catalog.table,{...f.row(e.catalog.table,2),[col.name]:value})));invalidInsertContracts++;
            }
            for(const statement of [f.update(e.catalog.table,{[col.name]:null}),f.insert(e.catalog.table,{...f.row(e.catalog.table,2),[col.name]:null})])
              await savepoint(()=>assert.rejects(db.exec(statement),error=>error.code==="23502"&&(error.column===col.name||String(error.message).includes('"'+col.name+'"'))));
            nullColumns++;
          }
        });
      }finally{await db.exec("ROLLBACK");}
      assert.deepEqual(await capture(),initialState);
    }
    await db.exec("BEGIN");
    try {
      await db.exec(target(entries[0]));
      const mixed=await capture();
      await db.exec("CREATE TEMP TABLE division_apply(id integer); SET LOCAL search_path TO public,pg_temp");
      // Temp is not part of capture's public namespace.
      await db.exec(sql);assert.equal(expectAligned(await capture(),mixed),8);
      assert.equal((await db.query("SELECT to_regclass('pg_temp.division_apply') IS NOT NULL AS kept")).rows[0].kept,true);
    }finally{await db.exec("ROLLBACK");}
    assert.deepEqual(await capture(),initialState);
    await db.exec("BEGIN");
    try {
      await db.exec("CREATE SCHEMA check_state_scope");
      for(const table of tables)await db.exec("CREATE TABLE check_state_scope."+q(table)+" (LIKE public."+q(table)+" INCLUDING ALL)");
      const publicState=await capture();
      await db.exec("CREATE TEMP TABLE division_apply(id integer); SET LOCAL search_path TO check_state_scope,pg_temp,public,pg_catalog");
      await db.exec(sql);await db.exec(sql);
      assert.equal((await db.query("SHOW search_path")).rows[0].search_path,"check_state_scope, pg_temp, public, pg_catalog");
      await db.exec("SET LOCAL search_path TO pg_catalog,check_state_scope,pg_temp,public");
      const scoped=await readCatalog(async query=>(await db.query(query.replaceAll("n.nspname='public'","n.nspname='check_state_scope'"))).rows);
      assertCheckStatesAligned(scoped,manifest);
      await db.exec("SET LOCAL search_path TO public,pg_temp");assert.deepEqual(await capture(),publicState);
    }finally{await db.exec("ROLLBACK");}
    assert.deepEqual(await capture(),initialState);
    // Existing canonical NOT VALID constraints may legitimately contain committed bad rows.
    // Create only synthetic bad rows while the check is absent, then commit its NOT VALID form.
    await db.exec("BEGIN");
    try {
      for(const e of entries.filter(e=>!e.catalog.validated)) {
        const col=e.columns[0],value=f.bounds[col.name][0]-1;
        await db.exec(alter(e,"DROP CONSTRAINT "+q(e.catalog.name)));
        await db.exec(f.insert(e.catalog.table,{...f.row(e.catalog.table,10+committedOldRows),[col.name]:value}));
        await db.exec(alter(e,"ADD "+e.targetSource.sql));committedOldRows++;
      }
      await db.exec("COMMIT");
    }catch(error){await db.exec("ROLLBACK");throw error;}
    const committed=await capture();
    await db.exec(sql);assert.equal(expectAligned(await capture(),committed),1);
    const final=await capture();await db.exec(sql);assert.deepEqual(await capture(),final);
    await db.exec("BEGIN");
    try {
      for(const [index,e] of entries.filter(e=>!e.catalog.validated).entries()) {
        await savepoint(()=>rejectWrite(e,alter(e,"VALIDATE CONSTRAINT "+q(e.catalog.name))));
        const col=e.columns[0],value=f.bounds[col.name][0]-1;
        const key=e.catalog.table==="user"?"uid":"id";
        await savepoint(()=>rejectWrite(e,f.update(e.catalog.table,{[col.name]:value})+" WHERE "+q(key)+"="+(2012000010+index)));
        await savepoint(()=>rejectWrite(e,f.insert(e.catalog.table,{...f.row(e.catalog.table,100),[col.name]:value})));
      }
    }finally{await db.exec("ROLLBACK");}
    assert.deepEqual(await capture(),final);
    // Remove only synthetic keys created above so other path probes start with empty tables.
    await db.exec("BEGIN");
    try {
      for(const table of tables)await db.exec("DELETE FROM public."+q(table)+" WHERE "+q(table==="user"?"uid":"id")+" BETWEEN 2012000010 AND 2012000017");
      await db.exec("COMMIT");
    }catch(error){await db.exec("ROLLBACK");throw error;}
    assert.equal((await capture()).rows.length,0);
    assert.deepEqual(await api.generateMigration(snapshot,api.generateDrizzleJson(models,snapshot.id)),[]);
    assert.equal(rejectionCases.length,55);
    assert.equal(invalidInsertContracts,58);assert.equal(invalidUpdateContracts,58);
    assert.equal(validBoundaryContracts,70);assert.equal(nullColumns,32);assert.equal(committedOldRows,8);
    assert.deepEqual([...locationOnlyExpressionChanges].sort(),
      engine<170000?entries.filter(e=>!e.catalog.validated).map(e=>e.key).sort():[]);
    console.log("DB-009E4 "+format+": 9 CHECKs aligned; "+rejectionCases.length+" drift refusals; "+invalidInsertContracts+" invalid insert/update pairs; "+(Date.now()-started)+"ms");
    return {initialStatements:initial.length,guardedStatements:1,generatedProposalStatements:proposal.length,
      alignedKeys:entries.map(e=>e.key),rejectionCases,rawProposalReplacements,
      changedTargetConstraintOids:9,targetDependencyObjectIdsChanged:true,commentsPreserved:true,
      expressionComparison:{ignoredInternalFields:["location"],semanticDriftRefusals:7,
        locationOnlyChangedKeys:[...locationOnlyExpressionChanges].sort(),rawCatalogSqlUnmodified:true},
      invalidInsertContracts,invalidUpdateContracts,validBoundaryContracts,nullColumns,
      committedInvalidRowsPreserved:committedOldRows,committedInvalidInsertUpdateAndValidationRefusals:8,
      nonTargetObjectsRowsFilesIndexesTriggersFunctionsPreserved:true,
      fullCohortPreflightBeforeFirstMutationConfirmed:true,lockVerification,
      failureAfterDropAndAddRollbackConfirmed:true,noOpConfirmed:true,mixedStateAndTempIsolationConfirmed:true,
      nonPublicSchemaIsolationConfirmed:true,syntheticRowsCleanupConfirmed:true};
  }finally{if(!database)await db.close();}
};
