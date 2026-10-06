import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { inspectRuntimeSeckillScheduleLockBoundary, installRuntimeSeckillScheduleLockBoundaryInTransaction,
  SECKILL_SCHEDULE_LOCK_BOUNDARY as boundary } from '../src/migrations/runtimeSeckillScheduleLockBoundary';
import { auditRuntimeBusinessPrivileges, inspectRuntimeBusinessProfileInTransaction } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { installSeckillScheduleRuntimeUpgradeInTransaction, runSeckillScheduleRuntimeUpgrade } from '../src/migrations/runSeckillScheduleRuntimeUpgrade';
import { runSeckillParentRuntimeUpgrade } from '../src/migrations/runSeckillParentRuntimeUpgrade';
import type { RuntimeBusinessProfileVersion } from '../src/migrations/runtimeBusinessPrivilegePlan';
import { removePromotionGiftFixtureGrants } from './helpers/runtimeHistoricalProfile';

type Peer=SequenceRunnerPeer & {role:string};
const native=process.env.TEST_FINANCE_POSTGRES_URL?describe:describe.skip;
const names=(app:Peer,admin:Peer)=>({app:app.role,admin:admin.role,maintenance:'finance_test'});
function code(error:unknown):unknown {
  for(let n=0;n<8 && error && typeof error==='object';n++) {
    if('code' in error)return error.code;
    error='cause' in error?error.cause:undefined;
  }
  return undefined;
}
async function denied(work:Promise<unknown>,expected='42501') {
  const error=await work.then(()=>null,e=>e);expect(error).not.toBeNull();expect(code(error)).toBe(expected);
}

native('independent seckill schedule invoker boundary (real restricted LOGIN)',()=>{
  let f:Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async()=>{
    f=await sequenceRunnerDatabase();
    await f.exec(`CREATE TABLE public.store_activity(id integer PRIMARY KEY,name text NOT NULL);
      CREATE TABLE public.store_seckill_time(id integer PRIMARY KEY,name text NOT NULL);
      INSERT INTO public.store_activity VALUES(1,'parent');INSERT INTO public.store_seckill_time VALUES(1,'slot')`);
  });
  afterEach(async()=>{await f?.close();});
  async function roles(run:(app:Peer,admin:Peer)=>Promise<void>) {
    await f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
      await f.exec(`GRANT SELECT ON public.store_activity,public.store_seckill_time TO "${app.role}","${admin.role}"`);
      await run(app,admin);
    }));
  }
  const rows=()=>f.exec(`SELECT 'parent' AS kind,to_jsonb(t)::text AS row FROM public.store_activity t
    UNION ALL SELECT 'slot',to_jsonb(t)::text FROM public.store_seckill_time t ORDER BY kind,row`);
  const catalog=()=>f.exec(`SELECT 'function' AS kind,p.oid::text,p.proacl::text AS acl,p.prosrc AS definition
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
    UNION ALL SELECT 'trigger',t.oid::text,NULL,pg_get_triggerdef(t.oid) FROM pg_trigger t
    WHERE t.tgrelid IN ('public.store_activity'::regclass,'public.store_seckill_time'::regclass)
    UNION ALL SELECT 'column',c.oid::text||'.'||a.attnum::text,a.attacl::text,NULL
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.relnamespace='public'::regnamespace
      AND a.attnum>0 AND NOT a.attisdropped ORDER BY kind,oid`);
  async function install(app:Peer,admin:Peer) {
    return f.db.transaction(tx=>installRuntimeSeckillScheduleLockBoundaryInTransaction(tx,names(app,admin)));
  }
  it('reproduces SELECT-only FOR SHARE denial on both fixed tables before any repair',async()=>{
    await roles(async(app,admin)=>{
      const before=await rows();
      for(const table of ['store_activity','store_seckill_time']) {
        expect(await app.exec(`SELECT * FROM public.${table}`)).toHaveLength(1);
        await denied(app.exec(`SELECT * FROM public.${table} FOR SHARE`));
      }
      expect((await inspectRuntimeSeckillScheduleLockBoundary(f.db,names(app,admin))).absent).toBe(true);
      expect(await rows()).toEqual(before);
    });
  });
  it('allows row locks with only UPDATE(id), rejects semantic changes and preserves Admin slot editing',async()=>{
    await roles(async(app,admin)=>{
      const before=await rows();await install(app,admin);
      // Explicit owned fixture grants; the boundary installer itself grants nothing.
      await f.exec(`GRANT UPDATE(id) ON public.store_activity,public.store_seckill_time TO "${app.role}";
        GRANT UPDATE ON public.store_seckill_time TO "${admin.role}"`);
      for(const table of ['store_activity','store_seckill_time']) {
        expect(await app.exec(`SELECT * FROM public.${table} FOR SHARE`)).toHaveLength(1);
        expect(await app.exec(`UPDATE public.${table} SET id=id RETURNING id`)).toEqual([{id:1}]);
        for(const statement of [`UPDATE public.${table} SET id=2`,`UPDATE public.${table} SET name='changed'`,
          `INSERT INTO public.${table} VALUES(2,'new')`,`DELETE FROM public.${table}`])await denied(app.exec(statement));
        const [acl]=await f.exec(`SELECT has_table_privilege('${app.role}','public.${table}','UPDATE') AS whole,
          has_column_privilege('${app.role}','public.${table}','id','UPDATE') AS id,
          has_column_privilege('${app.role}','public.${table}','id','UPDATE WITH GRANT OPTION') AS delegate,
          has_column_privilege('${app.role}','public.${table}','name','UPDATE') AS name`);
        expect(acl).toEqual({whole:false,id:true,delegate:false,name:false});
      }
      expect(await rows()).toEqual(before);
      expect(await admin.exec("UPDATE public.store_seckill_time SET name='admin edited' RETURNING name")).toEqual([{name:'admin edited'}]);
    });
  });
  it('keeps the actual runtime identity, denies bypass and does not require trigger EXECUTE authority',async()=>{
    await roles(async(app,admin)=>{
      await install(app,admin);
      await f.exec(`GRANT UPDATE(id) ON public.store_activity TO "${app.role}"`);
      for(const statement of [`SET ROLE finance_test`,`SET session_replication_role=replica`,
        `ALTER TABLE public.store_activity DISABLE TRIGGER ${boundary}`,`SELECT public.${boundary}()`])
        await denied(app.exec(statement));
      await app.exec('RESET ROLE');
      expect(await app.exec(`SELECT current_user='${app.role}' AND session_user=current_user AS same`)).toEqual([{same:true}]);
      expect(await app.exec('SELECT id FROM public.store_activity FOR SHARE')).toEqual([{id:1}]);
      expect((await inspectRuntimeSeckillScheduleLockBoundary(app.db,names(app,admin))).ready).toBe(true);
    });
  });
  it('repeats without replacing OIDs or ACLs and rolls back an installation plus fixture grant on late failure',async()=>{
    await roles(async(app,admin)=>{
      const before=await catalog(),data=await rows();
      await expect(f.db.transaction(async tx=>{
        await installRuntimeSeckillScheduleLockBoundaryInTransaction(tx,names(app,admin));
        await tx.execute(sql.raw(`GRANT UPDATE(id) ON public.store_activity TO "${app.role}"`));
        throw Error('owned fixture late failure');
      })).rejects.toThrow('owned fixture late failure');
      expect(await catalog()).toEqual(before);expect(await rows()).toEqual(data);
      expect(await install(app,admin)).toMatchObject({applied:true,ready:true});
      const installed=await catalog();expect(await install(app,admin)).toMatchObject({applied:false,ready:true});
      expect(await catalog()).toEqual(installed);expect(await rows()).toEqual(data);
    });
  });
  it.each([
    `ALTER TABLE public.store_activity DISABLE TRIGGER ${boundary}`,
    `ALTER FUNCTION public.${boundary}() SECURITY DEFINER`,
    `GRANT EXECUTE ON FUNCTION public.${boundary}() TO PUBLIC`,
    `CREATE FUNCTION public.${boundary}(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1'`,
    `CREATE TABLE public.fixture_extra(id integer);CREATE TRIGGER fixture_extra BEFORE UPDATE ON public.fixture_extra FOR EACH ROW EXECUTE FUNCTION public.${boundary}()`,
  ])('fails closed on exact catalog drift: %s',async command=>{
    await roles(async(app,admin)=>{
      await install(app,admin);await f.exec(command);const before=await catalog();
      expect((await inspectRuntimeSeckillScheduleLockBoundary(f.db,names(app,admin))).ready).toBe(false);
      await expect(install(app,admin)).rejects.toThrow('catalog drift');expect(await catalog()).toEqual(before);
    });
  });
  it('rejects a later BEFORE UPDATE trigger rewriting NEW even through an otherwise allowed id=id update',async()=>{
    await roles(async(app,admin)=>{
      await install(app,admin);await f.exec(`GRANT UPDATE(id) ON public.store_activity TO "${app.role}"`);
      await f.exec(`CREATE FUNCTION public.fixture_late_rewrite() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
        AS 'BEGIN NEW.name=''unreviewed overwrite'';RETURN NEW;END';
        CREATE TRIGGER z_fixture_late_rewrite BEFORE UPDATE ON public.store_activity FOR EACH ROW EXECUTE FUNCTION public.fixture_late_rewrite()`);
      const before=await rows();
      expect((await inspectRuntimeSeckillScheduleLockBoundary(f.db,names(app,admin))).tablesSafe).toBe(false);
      await expect(install(app,admin)).rejects.toThrow('catalog drift');
      await denied(app.exec('UPDATE public.store_activity SET id=id'));expect(await rows()).toEqual(before);
    });
  });
  it('retains legitimate internal FK triggers while refusing unknown user UPDATE triggers',async()=>{
    await roles(async(app,admin)=>{
      await f.exec('CREATE TABLE public.fixture_fk(parent_id integer REFERENCES public.store_activity(id));INSERT INTO public.fixture_fk VALUES(1)');
      expect(await install(app,admin)).toMatchObject({applied:true,ready:true});
      await f.exec(`GRANT UPDATE(id) ON public.store_activity TO "${app.role}"`);
      expect(await app.exec('UPDATE public.store_activity SET id=id RETURNING id')).toEqual([{id:1}]);
      expect((await inspectRuntimeSeckillScheduleLockBoundary(f.db,names(app,admin))).ready).toBe(true);
    });
  });
  it('refuses root/autocommit, wrong identities, non-RC, readonly and busy table/advisory inputs without grants',async()=>{
    await roles(async(app,admin)=>{
      const before=await catalog();
      await expect(installRuntimeSeckillScheduleLockBoundaryInTransaction(f.db,names(app,admin))).rejects.toThrow('existing transaction');
      await expect(f.db.transaction(tx=>installRuntimeSeckillScheduleLockBoundaryInTransaction(tx,{...names(app,admin),maintenance:app.role})))
        .rejects.toThrow('Distinct');
      await expect(f.db.transaction(tx=>installRuntimeSeckillScheduleLockBoundaryInTransaction(tx,names(app,admin)),{isolationLevel:'repeatable read'}))
        .rejects.toThrow('requires review');
      await expect(f.db.transaction(tx=>installRuntimeSeckillScheduleLockBoundaryInTransaction(tx,names(app,admin)),{accessMode:'read only'}))
        .rejects.toThrow('requires review');
      await expect(app.db.transaction(tx=>installRuntimeSeckillScheduleLockBoundaryInTransaction(tx,names(app,admin))))
        .rejects.toThrow('requires review');
      await f.withPeer!(async peer=>{
        await peer.exec('BEGIN;LOCK TABLE public.store_activity IN ROW EXCLUSIVE MODE');
        try{await denied(install(app,admin),'55P03');}finally{await peer.exec('ROLLBACK');}
      });
      expect(await catalog()).toEqual(before);
    });
  });
  it('retains stricter caller deadlines and caps unbounded maintenance timeouts',async()=>{
    await roles(async(app,admin)=>{
      await f.db.transaction(async tx=>{
        await tx.execute(sql`SELECT set_config('statement_timeout','2500',true),set_config('lock_timeout','400',true),
          set_config('idle_in_transaction_session_timeout','3000',true)`);
        await installRuntimeSeckillScheduleLockBoundaryInTransaction(tx,names(app,admin));
        const [r]=await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,
          current_setting('idle_in_transaction_session_timeout') AS idle`);
        expect(r).toEqual({statement:'2500ms',lock:'400ms',idle:'3s'});
      });
      await f.db.transaction(async tx=>{
        await tx.execute(sql`SELECT set_config('statement_timeout','0',true),set_config('lock_timeout','0',true),
          set_config('idle_in_transaction_session_timeout','0',true)`);
        await installRuntimeSeckillScheduleLockBoundaryInTransaction(tx,names(app,admin));
        const [r]=await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,
          current_setting('idle_in_transaction_session_timeout') AS idle`);
        expect(r).toEqual({statement:'5s',lock:'1s',idle:'5s'});
      });
    });
  });
});

native('fixed forward for an existing exact whole-shop profile',()=>{
  let f:Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async()=>{
    f=await refundRuntimeFixture();
    await f.exec(`INSERT INTO public.store_activity(id,name,start_day,end_day,start_time,end_time,time_id,status)
      VALUES(7,'forward preserved parent',1780243200,1780329600,800,900,'7',1);
      INSERT INTO public.store_seckill_time(id,title,start_time,end_time,status) VALUES(7,'forward preserved slot','08:00','09:00',1)`);
  },60_000);
  afterEach(async()=>{await f?.close();},30_000);
  const catalog=()=>f.exec(`SELECT 'relation' AS kind,oid::text,relowner::text AS owner,relacl::text AS acl,NULL::text AS definition
    FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,proowner::text,proacl::text,prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace
    UNION ALL SELECT 'trigger',oid::text,NULL,NULL,pg_get_triggerdef(oid) FROM pg_trigger
      WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
    UNION ALL SELECT 'column',c.oid::text||'.'||a.attnum::text,NULL,a.attacl::text,NULL FROM pg_class c
      JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.relnamespace='public'::regnamespace
        AND a.attnum>0 AND NOT a.attisdropped ORDER BY kind,oid`);
  async function profiles(run:(app:Peer,admin:Peer,target:ReturnType<typeof names>&{database:string})=>Promise<void>) {
    await f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
      const [r]=await f.exec('SELECT current_database() AS database');const target={...names(app,admin),database:String(r.database)};
      await runRuntimeBusinessCommissioning(f.db,{...target,pricingOwner:f.pricingOwner});
      await removePromotionGiftFixtureGrants(f.exec,target);
      await f.exec('DROP TABLE public.store_coupon_template_issue;DROP TABLE public.store_coupon_template');
      // Produce the previously reviewed exact profile by removing only this
      // forward's new objects/ACLs. Its equality is checked before upgrading.
      await f.exec(`REVOKE UPDATE(id) ON public.store_activity,public.store_seckill_time FROM "${app.role}";
        REVOKE INSERT,UPDATE ON public.store_activity FROM "${admin.role}";
        REVOKE USAGE ON SEQUENCE public.store_activity_id_seq FROM "${admin.role}";
        DROP TRIGGER ${boundary} ON public.store_activity;DROP TRIGGER ${boundary} ON public.store_seckill_time;
        DROP FUNCTION public.${boundary}()`);
      await run(app,admin,target);
    }));
  }
  const profile=(target:ReturnType<typeof names>,version:RuntimeBusinessProfileVersion)=>f.db.transaction(async tx=>({
    app:await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,version),
    admin:await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,version),
  }));
  async function allRows() {
    const tables=await f.exec("SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname");
    expect(tables).toHaveLength(280);
    for(const row of tables)expect(String(row.name)).toMatch(/^[a-z_][a-z_0-9]*$/);
    return f.exec(tables.map(row=>`SELECT '${row.name}' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${row.name}" t`).join(' UNION ALL ')+' ORDER BY name');
  }
  it('upgrades only two column ACLs and three new objects; retains every old OID/ACL/body and business row',async()=>{
    await profiles(async(app,admin,target)=>{
      expect(await profile(target,'legacy-seckill-schedule')).toMatchObject({app:{ready:true},admin:{ready:true}});
      await denied(app.exec('SELECT id FROM public.store_activity FOR SHARE'));
      await denied(app.exec('SELECT id FROM public.store_seckill_time FOR SHARE'));
      const before=await catalog(),data=await allRows();
      expect(await runSeckillScheduleRuntimeUpgrade(f.db,target)).toMatchObject({applied:true,columnGrantsApplied:true});
      const after=await catalog();
      const changed=before.filter(row=>after.some(r=>r.kind===row.kind && r.oid===row.oid && JSON.stringify(r)!==JSON.stringify(row)));
      expect(changed).toHaveLength(2);expect(changed.every(r=>r.kind==='column')).toBe(true);
      expect(after.length-before.length).toBe(3);
      expect(await allRows()).toEqual(data);
      expect(await profile(target,'seckill-schedule')).toMatchObject({app:{ready:true},admin:{ready:true}});
      expect((await auditRuntimeBusinessPrivileges(app.db,'app',target)).ready).toBe(false);
      expect((await auditRuntimeBusinessPrivileges(admin.db,'admin',target)).ready).toBe(false);
      expect(await runSeckillScheduleRuntimeUpgrade(f.db,target)).toMatchObject({applied:false,profileStage:'seckill-schedule'});
      expect(await catalog()).toEqual(after);
      await runSeckillParentRuntimeUpgrade(f.db,target);
      expect(await profile(target,'pre-coupon-templates')).toMatchObject({app:{ready:true},admin:{ready:true}});
      expect((await auditRuntimeBusinessPrivileges(admin.db,'admin',target)).ready).toBe(false);
      const final=await catalog();expect(await allRows()).toEqual(data);
      await app.exec('SELECT id FROM public.store_activity FOR SHARE');await app.exec('SELECT id FROM public.store_seckill_time FOR SHARE');
      await expect(runRuntimeBusinessCommissioning(f.db,{...target,pricingOwner:f.pricingOwner})).rejects.toThrow('Coupon template commissioning exact catalog required');
      expect(await runSeckillScheduleRuntimeUpgrade(f.db,target)).toMatchObject({applied:false,columnGrantsApplied:false});
      expect(await catalog()).toEqual(final);
    });
  },60_000);
  it('rejects an incomplete legacy grant, partial new authority, delegated column grant and new trigger drift without repair',async()=>{
    await profiles(async(app,_admin,target)=>{
      for(const command of [
        `REVOKE SELECT ON public.store_product FROM "${app.role}"`,
        `GRANT UPDATE(id) ON public.store_activity TO "${app.role}"`,
        `GRANT UPDATE(id) ON public.store_activity TO "${app.role}" WITH GRANT OPTION`,
      ]) {
        const original=await catalog();
        await expect(f.db.transaction(async tx=>{
          await tx.execute(sql.raw(command));
          await expect(installSeckillScheduleRuntimeUpgradeInTransaction(tx,target)).rejects.toThrow('exact legacy');
          throw Error('rollback injected drift');
        })).rejects.toThrow('rollback injected drift');expect(await catalog()).toEqual(original);
      }
      await runSeckillScheduleRuntimeUpgrade(f.db,target);
      await f.exec(`ALTER TABLE public.store_seckill_time DISABLE TRIGGER ${boundary}`);const before=await catalog();
      await expect(runSeckillScheduleRuntimeUpgrade(f.db,target)).rejects.toThrow('exact legacy');expect(await catalog()).toEqual(before);
    });
  },60_000);
  it('rolls back both column grants and the boundary on a failure after final verification',async()=>{
    await profiles(async(_app,_admin,target)=>{
      const before=await catalog(),data=await allRows();
      await expect(f.db.transaction(async tx=>{
        expect(await installSeckillScheduleRuntimeUpgradeInTransaction(tx,target)).toMatchObject({applied:true});
        throw Error('late forward failure');
      })).rejects.toThrow('late forward failure');
      expect(await catalog()).toEqual(before);expect(await allRows()).toEqual(data);
      expect(await runSeckillScheduleRuntimeUpgrade(f.db,target)).toMatchObject({applied:true});
    });
  },60_000);
  it('bounds maintenance, rejects wrong database/runtime invocation and handles advisory contention without ACL changes',async()=>{
    await profiles(async(app,_admin,target)=>{
      const before=await catalog();
      await expect(runSeckillScheduleRuntimeUpgrade(f.db,{...target,database:'wrong_database'})).rejects.toThrow('database requires review');
      await expect(runSeckillScheduleRuntimeUpgrade(app.db,target)).rejects.toThrow('requires review');
      await f.withPeer!(async peer=>{
        await peer.exec('BEGIN;SELECT pg_advisory_xact_lock(731626,3)');
        try{await expect(runSeckillScheduleRuntimeUpgrade(f.db,target)).rejects.toThrow('busy');}
        finally{await peer.exec('ROLLBACK');}
      });
      expect(await catalog()).toEqual(before);
    });
  },60_000);
});
