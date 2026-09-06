// Complete old-ORM sequence path. Local PGlite or identity-checked CI PG16 only.
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");
const {PGlite}=require("@electric-sql/pglite");
const {readCatalog}=require("tsx/cjs/api").require("../../scripts/data-migration/postgres-catalog-audit.ts",__filename);
const root=join(__dirname,"../.."),key="public.kefu_visitor_uid_seq";
const sql=readFileSync(join(root,"migrations/0145_kefu_sequence_alignment.sql"),"utf8");
const manifest=JSON.parse(readFileSync(join(root,"audit/orm-kefu-sequence-reconciliation.json"),"utf8"));
assert.equal(manifest.entries.length,1);
const {previousSnapshot,snapshot:targetSnapshot}=manifest.entries[0];
const oldCatalog=JSON.parse(readFileSync(join(root,"audit/orm-ddl-catalog-baseline.json"),"utf8"))
  .records.find(r=>r.comparison==="externalVsOrm"&&r.category==="sequences"&&r.value.key==="kefu_visitor_uid_seq").value;
const insert=(slot,uid)=>`INSERT INTO public.kefu_visitor_session(session_id,${uid===undefined?"":"visitor_uid,"}service_id,kefu_uid,token_hash,created_at,expires_at,last_seen_at)
  VALUES ('sequence-audit-${slot}',${uid===undefined?"":uid+","}1,1,'${slot.toString(16).padStart(64,"0")}',1,100,1);`;
const sorted=rows=>rows.map(r=>JSON.stringify(r)).sort();

module.exports=async function auditKefuSequence({api,models,format,database}) {
  const started=Date.now(),snapshot=api.generateDrizzleJson(models),old=structuredClone(snapshot),target=structuredClone(snapshot);
  // Require the actual business model, not a synthesized target substituted for it.
  assert.deepEqual(snapshot.sequences[key],targetSnapshot,"Business model must declare exact integer type and owning column");
  assert.deepEqual(manifest.entries[0].catalog,oldCatalog.reference);
  assert.deepEqual(manifest.entries[0].previousCatalog,oldCatalog.candidate);
  const modelAligned=true;
  old.sequences[key]=previousSnapshot;target.sequences[key]=targetSnapshot;
  const initial=await api.generateMigration(api.generateDrizzleJson({}),old);
  const proposal=await api.generateMigration(old,target);
  assert.equal(proposal.length,2);
  assert.ok(proposal.every(s=>s.startsWith('ALTER SEQUENCE "public"."kefu_visitor_uid_seq" ')));
  assert.ok(proposal.every(s=>! /\b(DROP|RESTART|setval|nextval)\b/i.test(s)));
  const db=database??new PGlite();
  const query=async s=>(await db.query(s)).rows;
  const read=()=>readCatalog(query);
  const counter=async()=> (await query("SELECT last_value::text AS value,is_called,log_cnt::text AS log FROM public.kefu_visitor_uid_seq"))[0];
  const capture=async()=>({
    catalog:await read(),
    classes:await query("SELECT c.oid,to_jsonb(c) AS metadata FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.oid"),
    attributes:await query("SELECT a.attrelid,a.attnum,to_jsonb(a) AS metadata FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY a.attrelid,a.attnum"),
    indexes:await query("SELECT i.indexrelid,to_jsonb(i) AS metadata FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY i.indexrelid"),
    constraints:await query("SELECT c.oid,to_jsonb(c) AS metadata FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY c.oid"),
    defaults:await query("SELECT a.oid,to_jsonb(a) AS metadata FROM pg_attrdef a JOIN pg_class c ON c.oid=a.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY a.oid"),
    triggers:await query("SELECT t.oid,to_jsonb(t) AS metadata FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY t.oid"),
    functions:await query("SELECT p.oid,to_jsonb(p) AS metadata FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.oid"),
    dependencies:await query("SELECT d.* FROM pg_depend d WHERE (d.refclassid='pg_class'::regclass AND d.refobjid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')) OR (d.classid='pg_class'::regclass AND d.objid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')) ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype"),
    shared:await query("SELECT d.* FROM pg_shdepend d WHERE d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.deptype"),
    comments:await query("SELECT d.* FROM pg_description d WHERE d.classoid='pg_class'::regclass AND d.objoid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') ORDER BY d.objoid,d.objsubid"),
    sequences:await query("SELECT s.seqrelid,to_jsonb(s) AS metadata FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY s.seqrelid"),
    rows:await query("SELECT to_jsonb(s) AS row FROM public.kefu_visitor_session s ORDER BY session_id"),
    counter:await counter(),
  });
  let sequenceOid,tableOid,columnNumber,relationClass;
  const expectAligned=(after,before)=>{
    const expected=structuredClone(before);
    expected.catalog.sequences=expected.catalog.sequences.map(s=>s.key===oldCatalog.reference.key?oldCatalog.reference:s);
    const c=expected.classes.find(c=>String(c.oid)===sequenceOid),actual=after.classes.find(c=>String(c.oid)===sequenceOid);
    assert.notEqual(String(actual.metadata.relfilenode),String(c.metadata.relfilenode),"Only target sequence storage is rewritten");
    c.metadata.relfilenode=actual.metadata.relfilenode;
    const s=expected.sequences.find(s=>String(s.seqrelid)===sequenceOid);
    s.metadata.seqtypid=typeof s.metadata.seqtypid==="string"?"23":23;
    expected.dependencies.push({classid:relationClass,objid:Number(sequenceOid),objsubid:0,refclassid:relationClass,
      refobjid:Number(tableOid),refobjsubid:Number(columnNumber),deptype:"a"});
    assert.deepEqual(sorted(after.dependencies),sorted(expected.dependencies),"Only exact AUTO owning-column dependency is added");
    expected.dependencies=after.dependencies;
    assert.equal(after.counter.value,before.counter.value);assert.equal(after.counter.is_called,before.counter.is_called);
    // AS alone leaves explicit bounds/options and existing WAL prelog count intact.
    // The raw generator's redundant option clauses would reset log_cnt; don't apply them here.
    assert.equal(after.counter.log,before.counter.log);
    assert.deepEqual(after,expected,"Original rows/OIDs/ACL/roles/comments and every non-target object are preserved");
  };
  const savepoint=async fn=>{await db.exec("SAVEPOINT sequence_probe");try{return await fn();}finally{await db.exec("ROLLBACK TO SAVEPOINT sequence_probe; RELEASE SAVEPOINT sequence_probe");}};
  const refusals=[];let lockVerification=null;
  try {
    await db.exec(initial.join("\n"));
    const ids=(await query("SELECT 'public.kefu_visitor_uid_seq'::regclass::oid AS seq,'public.kefu_visitor_session'::regclass::oid AS tbl,'pg_class'::regclass::oid AS cls,(SELECT attnum FROM pg_attribute WHERE attrelid='public.kefu_visitor_session'::regclass AND attname='visitor_uid') AS col"))[0];
    sequenceOid=String(ids.seq);tableOid=String(ids.tbl);columnNumber=ids.col;relationClass=ids.cls;
    assert.deepEqual((await read()).sequences.find(s=>s.key===oldCatalog.candidate.key),oldCatalog.candidate);
    await db.exec(insert(1)+insert(2)+"COMMENT ON SEQUENCE public.kefu_visitor_uid_seq IS 'keep sequence comment'; GRANT USAGE,SELECT ON SEQUENCE public.kefu_visitor_uid_seq TO PUBLIC;");
    const committed=await capture();
    assert.equal(committed.rows.length,2);assert.equal(committed.counter.value,"1000000001");assert.equal(committed.counter.is_called,true);
    if(database?.withPeer) {
      lockVerification=await database.withPeer(async peer=>{
        await peer.exec("BEGIN; SELECT nextval('public.kefu_visitor_uid_seq')");
        const start=Date.now();
        try {await assert.rejects(db.exec(sql),{code:"55P03"});}
        finally {await peer.exec("ROLLBACK");}
        const waitMs=Date.now()-start;
        assert.equal((await counter()).value,"1000000002","A peer's allocated number is not reclaimed by rollback");
        const before=await capture();
        await db.exec("BEGIN");
        try {
          await db.exec(sql);
          await peer.exec("SET lock_timeout='250ms'");
          for(const statement of ["SELECT nextval('public.kefu_visitor_uid_seq')","SELECT setval('public.kefu_visitor_uid_seq',1000000000)",insert(77)])
            await assert.rejects(peer.exec(statement),{code:"55P03"});
        }finally{await db.exec("ROLLBACK");}
        assert.deepEqual(await capture(),before,"Migration rollback preserves allocated peer counter and old catalog");
        return {waitRefused:true,waitMs,directNextvalSetvalAndTableWriterBlocked:true,peerNextvalNotRolledBack:true,ddlRollbackConfirmed:true};
      });
    }
    const fixture=await capture();
    await db.exec("BEGIN");
    try {
      for(const [name,setup,codes=["P0001"]] of [
        ["increment","ALTER SEQUENCE public.kefu_visitor_uid_seq INCREMENT BY 2"],
        ["minimum","ALTER SEQUENCE public.kefu_visitor_uid_seq MINVALUE 2"],
        ["maximum","ALTER SEQUENCE public.kefu_visitor_uid_seq MAXVALUE 2147483646"],
        ["start","ALTER SEQUENCE public.kefu_visitor_uid_seq START WITH 1000000002"],
        ["cache","ALTER SEQUENCE public.kefu_visitor_uid_seq CACHE 2"],
        ["cycle","ALTER SEQUENCE public.kefu_visitor_uid_seq CYCLE"],
        ["integer-unowned","ALTER SEQUENCE public.kefu_visitor_uid_seq AS integer"],
        ["bigint-owned","ALTER SEQUENCE public.kefu_visitor_uid_seq OWNED BY public.kefu_visitor_session.visitor_uid"],
        ["wrong-owning-column","ALTER SEQUENCE public.kefu_visitor_uid_seq OWNED BY public.kefu_visitor_session.service_id"],
        ["wrong-owning-table","CREATE TABLE public.sequence_other(uid integer); ALTER SEQUENCE public.kefu_visitor_uid_seq OWNED BY public.sequence_other.uid",["0A000","P0001"]],
        ["owner-role","ALTER SEQUENCE public.kefu_visitor_uid_seq OWNER TO pg_read_all_data"],
        ["missing-default","ALTER TABLE public.kefu_visitor_session ALTER COLUMN visitor_uid DROP DEFAULT"],
        ["wrong-default","ALTER TABLE public.kefu_visitor_session ALTER COLUMN visitor_uid SET DEFAULT 1000000000"],
        ["nullable","ALTER TABLE public.kefu_visitor_session ALTER COLUMN visitor_uid DROP NOT NULL"],
        ["column-type","ALTER TABLE public.kefu_visitor_session ALTER COLUMN visitor_uid TYPE bigint"],
        ["missing-unique","ALTER TABLE public.kefu_visitor_session DROP CONSTRAINT kefu_visitor_session_visitor_uid_key"],
        ["wrong-unique-name","ALTER TABLE public.kefu_visitor_session RENAME CONSTRAINT kefu_visitor_session_visitor_uid_key TO sequence_other_unique"],
        ["rls","ALTER TABLE public.kefu_visitor_session ENABLE ROW LEVEL SECURITY"],
        ["inheritance","CREATE TABLE public.sequence_child() INHERITS(public.kefu_visitor_session)"],
        ["unlogged","ALTER TABLE public.kefu_visitor_session SET UNLOGGED"],
        ["extra-sequence-consumer","CREATE VIEW public.sequence_consumer AS SELECT nextval('public.kefu_visitor_uid_seq')"],
        ["counter-before-range","ALTER SEQUENCE public.kefu_visitor_uid_seq RESTART WITH 999999999"],
        ["uncalled-counter-overlaps-row","ALTER SEQUENCE public.kefu_visitor_uid_seq RESTART WITH 1000000001"],
        ["row-beyond-counter",insert(55,1000001000)],
        ["missing-schema","SET LOCAL search_path TO sequence_absent"],
        ["missing-table","ALTER TABLE public.kefu_visitor_session RENAME TO sequence_old_table"],
        ["missing-sequence","ALTER SEQUENCE public.kefu_visitor_uid_seq RENAME TO sequence_old_seq"],
        ["unprivileged-role","SET LOCAL ROLE pg_read_all_data",["42501"]],
        ["ddl-event-hook","CREATE FUNCTION public.sequence_event_hook() RETURNS event_trigger LANGUAGE plpgsql AS 'BEGIN RETURN; END'; CREATE EVENT TRIGGER sequence_event_hook ON ddl_command_end EXECUTE FUNCTION public.sequence_event_hook()"],
      ]) {
        await savepoint(async()=>{await db.exec(setup);await assert.rejects(db.exec(sql),e=>codes.includes(e.code),name);});
        assert.deepEqual(await capture(),fixture,name+" failure rollback");refusals.push(name);
      }
      const mutation="EXECUTE pg_catalog.format('ALTER SEQUENCE %I.kefu_visitor_uid_seq AS INTEGER OWNED BY %I.kefu_visitor_session.visitor_uid',target_schema,target_schema);";
      assert.equal(sql.split(mutation).length,2);
      await savepoint(()=>assert.rejects(db.exec(sql.replace(mutation,mutation+" PERFORM 1/0;")),{code:"22012"}));
      assert.deepEqual(await capture(),fixture,"Failure after real AS/OWNED BY rolls back storage and dependencies");
      await savepoint(async()=>{
        await db.exec("ALTER TABLE public.kefu_visitor_session ALTER COLUMN visitor_uid DROP DEFAULT");
        await assert.rejects(db.exec(sql.replace(mutation,mutation+" PERFORM 1/0;")),{code:"P0001"});
      });
      await db.exec("CREATE TEMP TABLE kefu_visitor_session(id integer); CREATE TEMP SEQUENCE kefu_visitor_uid_seq; SET LOCAL search_path TO public,pg_temp");
      await db.exec(sql);expectAligned(await capture(),fixture);
      const aligned=await capture();await db.exec(sql);assert.deepEqual(await capture(),aligned,"Repeated aligned migration does not rewrite storage or WAL bookkeeping");
      assert.equal((await query("SELECT to_regclass('pg_temp.kefu_visitor_uid_seq') IS NOT NULL AS kept"))[0].kept,true);
      await savepoint(async()=>{
        await db.exec("ALTER TABLE public.kefu_visitor_session DROP COLUMN visitor_uid");
        assert.equal((await query("SELECT to_regclass('public.kefu_visitor_uid_seq') AS seq"))[0].seq,null);
      });
      assert.deepEqual(await capture(),aligned,"Ownership deletion and rollback recover exact state");
    }finally {await db.exec("ROLLBACK");}
    assert.deepEqual(await capture(),fixture);
    await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {await assert.rejects(db.exec(sql),{code:"P0001"});refusals.push("repeatable-read");}
    finally {await db.exec("ROLLBACK");}
    assert.deepEqual(await capture(),fixture);
    await db.exec("BEGIN");
    try {
      await db.exec(`CREATE SCHEMA "sequence""scope";
        CREATE SEQUENCE "sequence""scope".kefu_visitor_uid_seq AS bigint START WITH 1000000000 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
        CREATE TABLE "sequence""scope".kefu_visitor_session(LIKE public.kefu_visitor_session INCLUDING ALL);
        ALTER TABLE "sequence""scope".kefu_visitor_session ALTER COLUMN visitor_uid SET DEFAULT nextval('"sequence""scope".kefu_visitor_uid_seq');
        SET LOCAL search_path TO "sequence""scope",pg_temp,public;`);
      const pathBefore=(await query("SHOW search_path"))[0].search_path;
      await db.exec(sql);await db.exec(sql);
      assert.equal((await query("SHOW search_path"))[0].search_path,pathBefore);
      const scoped=(await query('SELECT last_value::text AS value,is_called FROM "sequence""scope".kefu_visitor_uid_seq'))[0];
      assert.deepEqual(scoped,{value:"1000000000",is_called:false},"Uncalled first value is preserved in a quoted non-public schema");
      assert.equal((await query(`SELECT nextval('"sequence""scope".kefu_visitor_uid_seq')::text AS value`))[0].value,"1000000000");
      await db.exec("SET LOCAL search_path TO public,pg_temp");
      assert.deepEqual(await capture(),fixture,"Scoped alignment does not touch public objects or counters");
    }finally {await db.exec("ROLLBACK");}
    assert.deepEqual(await capture(),fixture);
    await db.exec(sql);expectAligned(await capture(),fixture);
    const aligned=await capture();await db.exec(sql);assert.deepEqual(await capture(),aligned);
    await db.exec(insert(3));
    const issued=(await query("SELECT visitor_uid FROM public.kefu_visitor_session WHERE session_id='sequence-audit-3'"))[0].visitor_uid;
    assert.equal(issued,Number(fixture.counter.value)+1);
    if(database?.withPeer) {
      await database.withPeer(async peer=>{
        const statement="SELECT nextval('public.kefu_visitor_uid_seq')::text AS value FROM generate_series(1,8)";
        const results=await Promise.all([query(statement),peer.exec(statement)]);
        const values=results.flat().map(r=>Number(r.value)).sort((a,b)=>a-b);
        assert.deepEqual(values,Array.from({length:16},(_,i)=>issued+1+i),"Concurrent connections allocate sixteen distinct sequential numbers");
        assert.equal((await counter()).value,String(issued+16));
        lockVerification.concurrentDistinctNumbers=16;
      });
    }
    await db.exec("BEGIN");
    try {
      // Transactional RESTART exists only in isolated boundary fixtures, never in the migration.
      await db.exec("ALTER SEQUENCE public.kefu_visitor_uid_seq RESTART WITH 2147483647");
      await db.exec(sql);
      assert.equal((await query("SELECT nextval('public.kefu_visitor_uid_seq')::text AS value"))[0].value,"2147483647");
      await savepoint(()=>assert.rejects(db.exec("SELECT nextval('public.kefu_visitor_uid_seq')"),{code:"2200H"}));
      const exhausted=await counter();await db.exec(sql);assert.deepEqual(await counter(),exhausted,"Exhaustion is preserved, never reset");
    }finally {await db.exec("ROLLBACK");}
    await db.exec("DELETE FROM public.kefu_visitor_session WHERE session_id IN ('sequence-audit-1','sequence-audit-2','sequence-audit-3')");
    assert.equal((await query("SELECT count(*)::int AS n FROM public.kefu_visitor_session"))[0].n,0);
    assert.equal(refusals.length,30);
    const finalCatalog=await read();assert.deepEqual(finalCatalog.sequences.find(s=>s.key===oldCatalog.reference.key),oldCatalog.reference);
    if(!database) {
      const fresh=new PGlite();
      try {await fresh.exec((await api.generateMigration(api.generateDrizzleJson({}),target)).join("\n"));
        assert.deepEqual(await readCatalog(async q=>(await fresh.query(q)).rows),finalCatalog,"Complete fresh/old-upgraded catalogs match");
      }finally{await fresh.close();}
    }
    const report={initialStatements:initial.length,guardedStatements:1,generatedProposalStatements:proposal.length,modelAligned,
      changedSequenceStorageFiles:1,originalOidsRowsAclRolesCommentsAndNonTargetObjectsPreserved:true,
      committedOldRowsPreserved:2,originalCounterPreserved:true,driftRefusals:refusals,
      failureAfterAlterRollbackConfirmed:true,allPreflightBeforeTypeMutationConfirmed:true,
      noOpStorageAndCounterConfirmed:true,tempIsolationConfirmed:true,quotedNonPublicSchemaIsolationConfirmed:true,uncalledFirstValuePreserved:true,ownershipDeletionRollbackConfirmed:true,
      newDefaultWriteConfirmed:true,upperBoundAndExhaustionConfirmed:true,lockVerification,syntheticRowsCleanupConfirmed:true};
    console.log("KEFU_SEQUENCE_AUDIT "+JSON.stringify({format,...report,durationMs:Date.now()-started}));
    return report;
  }finally {if(!database)await db.close();}
};
