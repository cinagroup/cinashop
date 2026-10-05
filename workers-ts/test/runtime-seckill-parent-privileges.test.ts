import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { auditRuntimeBusinessPrivileges, inspectRuntimeBusinessProfileInTransaction } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { runSeckillScheduleRuntimeUpgrade } from '../src/migrations/runSeckillScheduleRuntimeUpgrade';
import { installSeckillParentRuntimeUpgradeInTransaction, runSeckillParentRuntimeUpgrade } from '../src/migrations/runSeckillParentRuntimeUpgrade';
import { inspectSeckillParentRuntimeSequence } from '../src/migrations/seckillParentRuntimeCatalog';
import { SECKILL_SCHEDULE_LOCK_BOUNDARY as boundary } from '../src/migrations/runtimeSeckillScheduleLockBoundary';
import { removePromotionGiftFixtureGrants } from './helpers/runtimeHistoricalProfile';

type Peer=SequenceRunnerPeer & {role:string};
type Target={database:string;maintenance:string;app:string;admin:string};
const native=process.env.TEST_FINANCE_POSTGRES_URL?describe:describe.skip;
async function denied(work:Promise<unknown>) {
  let error=await work.then(()=>null,e=>e);expect(error).not.toBeNull();
  for(let n=0;n<8 && error && typeof error==='object';n++) {
    if('code' in error){expect(error.code).toBe('42501');return;}
    error='cause' in error?error.cause:undefined;
  }
  throw Error('Expected PostgreSQL 42501 refusal');
}

native('fixed Admin parent forward after app schedule authority (real LOGIN)',()=>{
  let f:Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async()=>{
    f=await refundRuntimeFixture();
    await f.exec("INSERT INTO public.store_activity(id,name,time_id) VALUES(7,'preserved parent','7');INSERT INTO public.store_seckill_time(id,title,start_time,end_time) VALUES(7,'preserved slot','08:00','09:00')");
  },60_000);
  afterEach(async()=>{await f?.close();},30_000);
  async function profiles(run:(app:Peer,admin:Peer,target:Target)=>Promise<void>) {
    await f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
      const [r]=await f.exec('SELECT current_database() AS database');
      const target={database:String(r.database),maintenance:'finance_test',app:app.role,admin:admin.role};
      await runRuntimeBusinessCommissioning(f.db,{...target,pricingOwner:f.pricingOwner});
      await removePromotionGiftFixtureGrants(f.exec,target);
      // Actual historical schema/profile, not current with hidden new grants.
      await f.exec('DROP TABLE public.store_coupon_template_issue;DROP TABLE public.store_coupon_template');
      await f.exec(`REVOKE INSERT,UPDATE ON public.store_activity FROM "${admin.role}";REVOKE USAGE ON SEQUENCE public.store_activity_id_seq FROM "${admin.role}"`);
      expect(await f.db.transaction(async tx=>({
        app:await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,'seckill-schedule'),
        admin:await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,'seckill-schedule'),
      }))).toMatchObject({app:{ready:true},admin:{ready:true}});
      await run(app,admin,target);
    }));
  }
  const catalog=()=>f.exec(`SELECT 'relation' AS kind,oid::text,relowner::text AS owner,relacl::text AS acl,NULL::text AS definition
    FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,proowner::text,proacl::text,prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace
    UNION ALL SELECT 'trigger',oid::text,NULL,NULL,pg_get_triggerdef(oid) FROM pg_trigger
      WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
    UNION ALL SELECT 'column',c.oid::text||'.'||a.attnum::text,NULL,a.attacl::text,NULL FROM pg_class c
      JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.relnamespace='public'::regnamespace
        AND a.attnum>0 AND NOT a.attisdropped ORDER BY kind,oid`);
  async function allRows() {
    const tables=await f.exec("SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname");
    expect(tables).toHaveLength(280);
    for(const row of tables)expect(String(row.name)).toMatch(/^[a-z_][a-z_0-9]*$/);
    return f.exec(tables.map(row=>`SELECT '${row.name}' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${row.name}" t`).join(' UNION ALL ')+' ORDER BY name');
  }
  it('changes only the parent table and serial ACLs, preserves all existing objects/rows, and repeats without churn',async()=>{
    await profiles(async(app,admin,target)=>{
      expect((await auditRuntimeBusinessPrivileges(admin.db,'admin',target)).ready).toBe(false);
      await denied(admin.exec('SELECT id FROM public.store_activity FOR SHARE'));
      const before=await catalog(),data=await allRows();
      expect(await runSeckillParentRuntimeUpgrade(f.db,target)).toMatchObject({applied:true,parentGrantsApplied:true,profileStage:'pre-coupon-templates'});
      const after=await catalog();expect(after).toHaveLength(before.length);
      const changed=before.filter(row=>after.some(r=>r.kind===row.kind && r.oid===row.oid && JSON.stringify(r)!==JSON.stringify(row)));
      expect(changed).toHaveLength(2);expect(changed.every(r=>r.kind==='relation')).toBe(true);
      expect(await allRows()).toEqual(data);
      for(const [kind,peer] of [['app',app],['admin',admin]] as const) {
        expect(await f.db.transaction(tx=>inspectRuntimeBusinessProfileInTransaction(tx,kind,target,'pre-coupon-templates'))).toMatchObject({ready:true,failures:[]});
        expect((await auditRuntimeBusinessPrivileges(peer.db,kind,target)).ready).toBe(false);
      }
      expect(await runSeckillParentRuntimeUpgrade(f.db,target)).toMatchObject({applied:false,parentGrantsApplied:false});
      expect(await runSeckillScheduleRuntimeUpgrade(f.db,target)).toMatchObject({applied:false,profileStage:'pre-coupon-templates'});
      expect(await catalog()).toEqual(after);expect(await allRows()).toEqual(data);
    });
  },60_000);
  it('permits actual Admin parent insertion/update/soft deletion but denies physical deletion and all app semantic DML',async()=>{
    await profiles(async(app,admin,target)=>{
      await runSeckillParentRuntimeUpgrade(f.db,target);
      const [inserted]=await admin.exec("INSERT INTO public.store_activity(name) VALUES('actual Admin parent') RETURNING id");
      expect(Number(inserted.id)).toBeGreaterThan(0);
      expect(await admin.exec(`UPDATE public.store_activity SET status=1,is_del=1 WHERE id=${Number(inserted.id)} RETURNING status,is_del`))
        .toEqual([{status:1,is_del:1}]);
      await admin.exec('SELECT id FROM public.store_activity FOR SHARE');
      await denied(admin.exec(`DELETE FROM public.store_activity WHERE id=${Number(inserted.id)}`));
      for(const statement of ['UPDATE public.store_activity SET id=id+1000',"UPDATE public.store_activity SET name='app changed'",
        "INSERT INTO public.store_activity(name) VALUES('app parent')",'DELETE FROM public.store_activity'])await denied(app.exec(statement));
      const [acl]=await f.exec(`SELECT has_table_privilege('${admin.role}','public.store_activity','INSERT') AS insert,
        has_table_privilege('${admin.role}','public.store_activity','UPDATE') AS update,
        has_table_privilege('${admin.role}','public.store_activity','DELETE') AS delete,
        has_table_privilege('${admin.role}','public.store_activity','INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') AS delegate,
        has_sequence_privilege('${admin.role}','public.store_activity_id_seq','USAGE') AS usage,
        has_sequence_privilege('${admin.role}','public.store_activity_id_seq','SELECT,UPDATE,USAGE WITH GRANT OPTION') AS sequence_extra`);
      expect(acl).toEqual({insert:true,update:true,delete:false,delegate:false,usage:true,sequence_extra:false});
    });
  },60_000);
  it('requires the explicit first schedule forward instead of widening an exact old profile in one operation',async()=>{
    await profiles(async(app,_admin,target)=>{
      await f.exec(`REVOKE UPDATE(id) ON public.store_activity,public.store_seckill_time FROM "${app.role}";
        DROP TRIGGER ${boundary} ON public.store_activity;DROP TRIGGER ${boundary} ON public.store_seckill_time;DROP FUNCTION public.${boundary}()`);
      const before=await catalog();
      await expect(runSeckillParentRuntimeUpgrade(f.db,target)).rejects.toThrow('exact schedule');expect(await catalog()).toEqual(before);
      expect(await runSeckillScheduleRuntimeUpgrade(f.db,target)).toMatchObject({applied:true,profileStage:'seckill-schedule'});
      expect(await runSeckillParentRuntimeUpgrade(f.db,target)).toMatchObject({applied:true,profileStage:'pre-coupon-templates'});
    });
  },60_000);
  it('refuses partial parent grants, delegated authority and additional DELETE without repairing the existing profile',async()=>{
    await profiles(async(_app,admin,target)=>{
      for(const command of [
        `GRANT INSERT ON public.store_activity TO "${admin.role}"`,
        `GRANT INSERT,UPDATE ON public.store_activity TO "${admin.role}"`,
        `GRANT USAGE ON SEQUENCE public.store_activity_id_seq TO "${admin.role}"`,
        `GRANT UPDATE ON public.store_activity TO "${admin.role}" WITH GRANT OPTION`,
        `GRANT DELETE ON public.store_activity TO "${admin.role}"`,
      ]) {
        const before=await catalog();
        await expect(f.db.transaction(async tx=>{
          await tx.execute(sql.raw(command));
          await expect(installSeckillParentRuntimeUpgradeInTransaction(tx,target)).rejects.toThrow('exact schedule');
          throw Error('rollback partial parent fixture');
        })).rejects.toThrow('rollback partial parent fixture');expect(await catalog()).toEqual(before);
      }
    });
  },60_000);
  it.each([
    'ALTER SEQUENCE public.store_activity_id_seq OWNED BY NONE',
    'ALTER TABLE public.store_activity ALTER COLUMN id SET DEFAULT 0',
  ])('refuses serial source drift: %s',async command=>{
    await profiles(async(_app,_admin,target)=>{
      await f.exec(command);const before=await catalog();
      expect((await inspectSeckillParentRuntimeSequence(f.db,target.maintenance)).ready).toBe(false);
      await expect(runSeckillParentRuntimeUpgrade(f.db,target)).rejects.toThrow('exact serial');expect(await catalog()).toEqual(before);
    });
  },60_000);
  it('rolls back the complete parent grant on a late failure and refuses wrong identities/isolation or a busy maintenance gate',async()=>{
    await profiles(async(app,_admin,target)=>{
      const before=await catalog(),data=await allRows();
      await expect(f.db.transaction(async tx=>{
        expect(await installSeckillParentRuntimeUpgradeInTransaction(tx,target)).toMatchObject({applied:true});
        throw Error('late parent fixture failure');
      })).rejects.toThrow('late parent fixture failure');
      expect(await catalog()).toEqual(before);expect(await allRows()).toEqual(data);
      await expect(runSeckillParentRuntimeUpgrade(f.db,{...target,database:'wrong_database'})).rejects.toThrow('database requires review');
      await expect(runSeckillParentRuntimeUpgrade(app.db,target)).rejects.toThrow('requires review');
      await expect(f.db.transaction(tx=>installSeckillParentRuntimeUpgradeInTransaction(tx,target),{isolationLevel:'repeatable read'}))
        .rejects.toThrow('requires review');
      await f.withPeer!(async peer=>{
        await peer.exec('BEGIN;SELECT pg_advisory_xact_lock(731626,4)');
        try{await expect(runSeckillParentRuntimeUpgrade(f.db,target)).rejects.toThrow('busy');}
        finally{await peer.exec('ROLLBACK');}
      });
      expect(await catalog()).toEqual(before);expect(await allRows()).toEqual(data);
    });
  },60_000);
});
