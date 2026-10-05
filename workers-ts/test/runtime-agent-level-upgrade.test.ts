import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { sql } from 'drizzle-orm';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { removeAgentLevelFixtureGrants } from './helpers/runtimeHistoricalProfile';
import { auditRuntimeBusinessPrivileges,inspectRuntimeBusinessProfileInTransaction } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { inspectAgentLevelRuntimeCatalog } from '../src/migrations/agentLevelRuntimeCatalog';
import { AGENT_LEVEL_CATALOG_FENCE,AGENT_LEVEL_ROW_GUARD,inspectRuntimeAgentLevelCatalogBoundary } from '../src/migrations/runtimeAgentLevelCatalogBoundary';
import { installAgentLevelRuntimeUpgradeInTransaction,runAgentLevelRuntimeUpgrade } from '../src/migrations/runAgentLevelRuntimeUpgrade';
import { runSignDayConfigRuntimeUpgrade } from '../src/migrations/runSignDayConfigRuntimeUpgrade';
import { runPromotionGiftRuntimeUpgrade } from '../src/migrations/runPromotionGiftRuntimeUpgrade';
import { runCouponTemplateRuntimeUpgrade } from '../src/migrations/runCouponTemplateRuntimeUpgrade';
import { runSeckillParentRuntimeUpgrade } from '../src/migrations/runSeckillParentRuntimeUpgrade';
import { runSeckillScheduleRuntimeUpgrade } from '../src/migrations/runSeckillScheduleRuntimeUpgrade';
import type { SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

type Peer=SequenceRunnerPeer & {role:string};
type Target={database:string;maintenance:string;app:string;admin:string};
const native=process.env.TEST_FINANCE_POSTGRES_URL?describe:describe.skip;
async function sqlState(promise:Promise<unknown>,code:string) {
  let error=await promise.then(()=>null,error=>error);expect(error).not.toBeNull();
  for(let n=0;n<8 && error && typeof error==='object';n++) {
    if('code' in error){expect(error.code).toBe(code);return;}error='cause' in error?error.cause:undefined;
  }
  throw Error('Expected PostgreSQL refusal '+code);
}
native('complete PG16 distributor catalog commissioning and exact forward',()=>{
  let f:Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async()=>{f=await refundRuntimeFixture();},60_000);
  afterEach(async()=>{await f?.close();},30_000);
  async function roles(run:(app:Peer,admin:Peer,target:Target)=>Promise<void>,previous=true) {
    await f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
      const [row]=await f.exec('SELECT current_database() AS database');
      const target={database:String(row.database),maintenance:'finance_test',app:app.role,admin:admin.role};
      expect(await inspectAgentLevelRuntimeCatalog(f.db,target.maintenance,target)).toMatchObject({ready:true,catalogReady:true,ownerReady:true,sequenceReady:true,columnsReady:true,indexesReady:true,constraintsReady:true});
      await runRuntimeBusinessCommissioning(f.db,{...target,pricingOwner:f.pricingOwner});
      if(previous)await removeAgentLevelFixtureGrants(f.exec,target);
      await run(app,admin,target);
    }));
  }
  const profile=(peer:Peer,kind:'app'|'admin',target:Target,version:'pre-agent-levels'|'current')=>
    peer.db.transaction(tx=>inspectRuntimeBusinessProfileInTransaction(tx,kind,target,version));
  const catalog=()=>f.exec(`SELECT 'relation' AS kind,c.oid::text AS key,c.relname AS name,c.relowner::text AS owner,c.relacl::text AS acl,
      c.relkind::text||':'||c.relpersistence::text||':'||c.relrowsecurity::text||':'||c.relforcerowsecurity::text AS definition
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'column',c.oid::text||'.'||a.attnum::text,c.relname||'.'||a.attname,NULL,a.attacl::text,
      format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,proname,proowner::text,proacl::text,pg_get_functiondef(oid)
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind IN('f','p')
    UNION ALL SELECT 'constraint',c.oid::text,c.conname,NULL,NULL,pg_get_constraintdef(c.oid)
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relnamespace='public'::regnamespace
    UNION ALL SELECT 'index',i.indexrelid::text,c.relname,NULL,NULL,pg_get_indexdef(i.indexrelid)
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'sequence',s.seqrelid::text,c.relname,NULL,NULL,
      concat_ws(':',s.seqtypid,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle)
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'trigger',g.oid::text,g.tgname,NULL,NULL,pg_get_triggerdef(g.oid)||':'||g.tgenabled::text
    FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT g.tgisinternal
    ORDER BY kind,key`);
  async function rows() {
    const tables=await f.exec("SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname");
    expect(tables).toHaveLength(282);
    return f.exec(tables.map(({name})=>{
      expect(name).toMatch(/^[a-z_][a-z_0-9]*$/);
      return `SELECT '${name}' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${name}" t`;
    }).join(' UNION ALL ')+' ORDER BY name');
  }
  const forwards=[runSeckillScheduleRuntimeUpgrade,runSeckillParentRuntimeUpgrade,
    runCouponTemplateRuntimeUpgrade,runPromotionGiftRuntimeUpgrade,runSignDayConfigRuntimeUpgrade];
  it('changes only two invoker routines/four triggers, one old guard body and the exact Admin ACL delta, preserving all 282 tables and historical forwards',async()=>{
    await roles(async(app,admin,target)=>{
      await f.exec("INSERT INTO agent_level_task_record(uid,level_id,task_id,status) VALUES(41,1,51,0),(41,1,51,0)");
      expect(await inspectAgentLevelRuntimeCatalog(f.db,target.maintenance,target)).toMatchObject({ready:true});
      expect(await profile(app,'app',target,'pre-agent-levels')).toMatchObject({ready:true,tableCount:282});
      expect(await profile(admin,'admin',target,'pre-agent-levels')).toMatchObject({ready:true,tableCount:282});
      for(const forward of forwards) {
        const before=await catalog();expect(await forward(f.db,target)).toMatchObject({applied:false,profileStage:'pre-agent-levels'});
        expect(await catalog()).toEqual(before);
      }
      const before=await catalog(),data=await rows();
      expect(await runAgentLevelRuntimeUpgrade(f.db,target)).toMatchObject({applied:true,profileStage:'current'});
      const after=await catalog(),added=after.filter(row=>!before.some(old=>old.kind===row.kind && old.key===row.key));
      expect(added).toHaveLength(6);
      expect(added.filter(row=>row.kind==='function').map(row=>row.name).sort()).toEqual([AGENT_LEVEL_CATALOG_FENCE,AGENT_LEVEL_ROW_GUARD].sort());
      expect(added.filter(row=>row.kind==='trigger')).toHaveLength(4);
      const changed=before.filter(old=>after.some(row=>old.kind===row.kind && old.key===row.key && JSON.stringify(old)!==JSON.stringify(row)));
      expect(changed.map(row=>row.name).sort()).toEqual(['cinashop_runtime_lock_only_v1','agent_level','agent_level_id_seq',
        ...['name','image','color','one_brokerage','two_brokerage','grade','status','is_del'].map(col=>'agent_level.'+col)].sort());
      expect(after.filter(row=>!added.includes(row) && !changed.some(old=>old.kind===row.kind && old.key===row.key)))
        .toEqual(before.filter(row=>!changed.includes(row)));
      expect(await rows()).toEqual(data);
      for(const kind of ['app','admin'] as const)expect(await auditRuntimeBusinessPrivileges(kind==='app'?app.db:admin.db,kind,target))
        .toMatchObject({ready:true,failures:[],tableCount:282});
      expect(await runAgentLevelRuntimeUpgrade(f.db,target)).toMatchObject({applied:false,profileStage:'current'});
      for(const forward of forwards)expect(await forward(f.db,target)).toMatchObject({applied:false,profileStage:'current'});
      expect(await catalog()).toEqual(after);expect(await rows()).toEqual(data);
    });
  },60_000);
  it('fresh commissioning has the current guard, narrow columns and no application editing/hard deletion/creation-time mutation',async()=>{
    await roles(async(app,admin,target)=>{
      expect(await inspectRuntimeAgentLevelCatalogBoundary(f.db,target)).toMatchObject({ready:true,absent:false});
      const [rights]=await admin.exec(`SELECT has_table_privilege(current_user,'agent_level','UPDATE') AS wide,
        has_table_privilege(current_user,'agent_level','DELETE') AS hard,has_column_privilege(current_user,'agent_level','add_time','UPDATE') AS time`);
      expect(rights).toEqual({wide:false,hard:false,time:false});
      await admin.exec("UPDATE agent_level SET name='commissioned',status=0 WHERE id=1");
      await sqlState(admin.exec('UPDATE agent_level SET id=id+900 WHERE id=1'),'42501');
      await sqlState(admin.exec('UPDATE agent_level SET add_time=42 WHERE id=1'),'42501');
      await sqlState(admin.exec('DELETE FROM agent_level WHERE id=1'),'42501');
      await sqlState(app.exec("UPDATE agent_level SET name='denied' WHERE id=1"),'42501');
      await sqlState(app.exec('INSERT INTO agent_level DEFAULT VALUES'),'42501');
      await app.exec('UPDATE agent_level SET id=id WHERE id=1');
      await app.db.transaction(tx=>tx.execute(sql`SELECT id FROM agent_level WHERE id=1 FOR SHARE`));
      for(const role of [app,admin])await sqlState(role.exec(`SELECT public.${AGENT_LEVEL_ROW_GUARD}()`),'42501');
    },false);
  },60_000);
  it('rolls back the complete forward with its caller transaction',async()=>{
    await roles(async(_app,_admin,target)=>{
      const before=await catalog(),data=await rows();
      await expect(f.db.transaction(async tx=>{await installAgentLevelRuntimeUpgradeInTransaction(tx,target);throw Error('abort caller');}))
        .rejects.toThrow('abort caller');
      expect(await catalog()).toEqual(before);expect(await rows()).toEqual(data);
    });
  },60_000);
  it('refuses an actual runtime table holder without waiting while preserving the frozen profile',async()=>{
    await roles(async(app,_admin,target)=>{
      const before=await catalog(),data=await rows();
      let release!:()=>void;
      const held=new Promise<void>(resolve=>{release=resolve;});
      let ready!:()=>void;
      const started=new Promise<void>(resolve=>{ready=resolve;});
      const holder=app.db.transaction(async tx=>{
        await tx.execute(sql`SELECT id FROM agent_level WHERE id=1 FOR SHARE`);
        ready();await held;
      });
      try{
        await started;
        await sqlState(runAgentLevelRuntimeUpgrade(f.db,target),'55P03');
      }finally{release();await holder;}
      expect(await catalog()).toEqual(before);expect(await rows()).toEqual(data);
      expect(await profile(app,'app',target,'pre-agent-levels')).toMatchObject({ready:true});
      expect(await runAgentLevelRuntimeUpgrade(f.db,target)).toMatchObject({applied:true,profileStage:'current'});
    });
  },60_000);
  it.each([
    ['columns','ALTER TABLE agent_level ADD COLUMN drift integer'],
    ['index','CREATE INDEX agent_level_drift_idx ON agent_level(grade)'],
    ['constraint','ALTER TABLE agent_level ADD CONSTRAINT drift CHECK(grade>=0)'],
    ['sequence','ALTER SEQUENCE agent_level_id_seq INCREMENT 2'],
    ['global guard',"CREATE OR REPLACE FUNCTION public.cinashop_runtime_lock_only_v1() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$"],
  ])('refuses %s drift without grants, data or in-place repair',async(_name,ddl)=>{
    await roles(async(_app,_admin,target)=>{
      await f.exec(ddl);const before=await catalog(),data=await rows();
      await expect(runAgentLevelRuntimeUpgrade(f.db,target)).rejects.toThrow();
      expect(await catalog()).toEqual(before);expect(await rows()).toEqual(data);
    });
  },60_000);
  it('refuses changed installed guard ACL/body/trigger rather than replacing it',async()=>{
    await roles(async(_app,_admin,target)=>{
      await f.exec(`GRANT EXECUTE ON FUNCTION public.${AGENT_LEVEL_CATALOG_FENCE}() TO PUBLIC`);
      const before=await catalog();expect(await inspectRuntimeAgentLevelCatalogBoundary(f.db,target)).toMatchObject({ready:false});
      await expect(runAgentLevelRuntimeUpgrade(f.db,target)).rejects.toThrow('exact catalog');expect(await catalog()).toEqual(before);
    },false);
  },60_000);
  it('requires the exact database, maintenance identity and read-committed caller transaction',async()=>{
    await roles(async(app,_admin,target)=>{
      const before=await catalog();
      await expect(runAgentLevelRuntimeUpgrade(f.db,{...target,database:'wrong_database'})).rejects.toThrow('requires review');
      await expect(runAgentLevelRuntimeUpgrade(app.db,target)).rejects.toThrow('requires review');
      await expect(installAgentLevelRuntimeUpgradeInTransaction(f.db,target)).rejects.toThrow('existing transaction');
      await expect(f.db.transaction(tx=>installAgentLevelRuntimeUpgradeInTransaction(tx,target),{isolationLevel:'repeatable read'})).rejects.toThrow('requires review');
      expect(await catalog()).toEqual(before);
    });
  },60_000);
});
