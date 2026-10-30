import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin } from '@/models/schema';
import { md5 } from '@/utils/jwt';
import { AdminProfileService } from '@/services/admin/AdminProfileService';
import { runAdminProfileUpgrade } from '@/migrations/runAdminProfileUpgrade';
import { assertAdminProfileReady, inspectAdminProfile } from '@/migrations/adminProfile';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { inspectAdminAuthorityMaintenanceSnapshot } from '@/migrations/adminAuthorityOperationMaintenance';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { outcome } from './helpers/financePeers';

function sqlCode(value: unknown): string {
  for (let i=0; i<6 && value && typeof value==='object'; i++) {
    if ('code' in value && typeof value.code==='string') return value.code;
    value = 'cause' in value ? value.cause : undefined;
  }
  return '';
}
/** The real CREATE/GRANT statements execute before the injected exception.
 * Original SQL results, callbacks, COMMIT/ROLLBACK and roles are not replaced. */
function failAfterGrant(db: DbClient, observed: { reached: boolean }): DbClient {
  const dialect = new PgDialect();
  return new Proxy(db, { get(target, property) {
    const method: unknown = Reflect.get(target,property);
    if (typeof method!=='function') return method;
    if (property!=='transaction') return method.bind(target);
    return (callback: (tx: Pick<DbClient,'execute'>)=>Promise<unknown>, options: unknown) => target.transaction(async tx => {
      const port = new Proxy(tx, { get(current,key) {
        const fn: unknown = Reflect.get(current,key);
        if (typeof fn!=='function') return fn;
        if (key!=='execute') return fn.bind(current);
        return async (query: Parameters<typeof tx.execute>[0]) => {
          const text = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql;
          const result = await tx.execute(query);
          if (text.startsWith('GRANT SELECT, INSERT ON TABLE public.admin_profile_operation,')) {
            observed.reached=true; throw Error('Owned profile interruption after actual append grants');
          }
          return result;
        };
      } });
      return callback(port);
    }, options as Parameters<typeof target.transaction>[1]);
  } });
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin profile explicit addon on independently authenticated isolated PG16 LOGINs', () => {
  afterEach(()=>vi.restoreAllMocks());
  it('rolls back interrupted commissioning, installs only private append grants, verifies real LOGIN ACLs and lock refusals, then replays without changes', async () => {
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Native Admin profile addon acceptance forbids provider I/O'));
    const whole = await refundRuntimeFixture();
    try {
      if (!whole.withRuntimeRole || !whole.withPeer) throw Error('Independent PG16 LOGIN and lock peers required');
      await whole.withRuntimeRole(async app => whole.withRuntimeRole!(async admin => {
        const [identity] = await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance,
          current_setting('server_version_num')::integer/10000 AS major`);
        expect(identity.major).toBe(16);
        const target={ database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role };
        await runRuntimeBusinessCommissioning(whole.db,{ ...target,pricingOwner:whole.pricingOwner });
        const password='owned-profile-native-hash';
        await whole.db.insert(systemAdmin).values({id:900,account:'owned_profile',pwd:password,realName:'Original',phone:'13800000900',
          roles:'',level:1,status:1,isDel:0,adminType:1,relationId:0});
        const inspect = async () => ({ app:await auditRuntimeBusinessPrivileges(app.db,'app',target),admin:await auditRuntimeBusinessPrivileges(admin.db,'admin',target) });
        const full = async () => ({
          whole:await whole.db.transaction(tx=>inspectAdminAuthorityMaintenanceSnapshot(tx,{wholeData:true}), {isolationLevel:'repeatable read',accessMode:'read only'}),
          sequences:Array.from(await whole.db.execute(sql`SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`), r=>({...r})),
        });
        expect(await inspect()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
        await expect(assertAdminProfileReady(admin.db)).rejects.toMatchObject({code:503});
        const before=await full(), trace={reached:false};
        await expect(runAdminProfileUpgrade(failAfterGrant(whole.db,trace),target)).rejects.toThrow('Owned profile interruption');
        expect(trace.reached).toBe(true); expect(await full()).toEqual(before);
        expect(await inspectAdminProfile(whole.db,target)).toBe(false);
        expect(await inspect()).toMatchObject({app:{ready:true},admin:{ready:true}});
        expect(await runAdminProfileUpgrade(whole.db,target)).toEqual({operation:'admin-self-profile-v1',applied:true});
        expect(await inspectAdminProfile(whole.db,target)).toBe(true); await expect(assertAdminProfileReady(admin.db)).resolves.toBeUndefined();
        expect(await inspect()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
        const installed=await full(), priorNames=new Set(before.whole.data.map(row=>row.name));
        expect(installed.whole.tableCount).toBe(before.whole.tableCount+2);
        expect(installed.whole.data.filter(row=>priorNames.has(row.name))).toEqual(before.whole.data);
        expect(installed.sequences).toEqual(before.sequences);
        expect(installed.whole.data.filter(row=>!priorNames.has(row.name)).map(row=>({name:row.name,rows:row.rows}))).toEqual([
          {name:'admin_profile_avatar',rows:'0'},{name:'admin_profile_operation',rows:'0'},
        ]);
        // Verify actual authenticated identities, not SET ROLE on the owner.
        for (const peer of [app,admin]) {
          const [row]=await peer.db.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
            (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super`);
          expect(row).toMatchObject({role:peer.role,session:peer.role,pid:peer.pid,super:false});
          await peer.exec('RESET ROLE'); const [reset]=await peer.db.execute(sql`SELECT current_user AS role`); expect(reset.role).toBe(peer.role);
        }
        for (const name of ['admin_profile_operation','admin_profile_avatar']) {
          await expect(app.exec(`SELECT * FROM public.${name}`)).rejects.toMatchObject({code:'42501'});
          await expect(app.exec(`INSERT INTO public.${name} DEFAULT VALUES`)).rejects.toMatchObject({code:'42501'});
          await expect(admin.exec(`SELECT * FROM public.${name} LIMIT 0`)).resolves.toBeDefined();
          for (const mutation of [`DELETE FROM public.${name}`,`TRUNCATE public.${name}`,`ALTER TABLE public.${name} ADD COLUMN forbidden integer`]) {
            await expect(admin.exec(mutation)).rejects.toMatchObject({code:'42501'});
          }
        }
        await expect(admin.exec('UPDATE public.admin_profile_operation SET actor_id=900')).rejects.toMatchObject({code:'42501'});
        await expect(admin.exec('UPDATE public.admin_profile_avatar SET actor_id=900')).rejects.toMatchObject({code:'42501'});
        await expect(admin.exec('SELECT public.admin_profile_immutable_v1()')).rejects.toMatchObject({code:'42501'});
        expect(await full()).toEqual(installed);
        // A true low-role Admin can use the service's append-only evidence. The
        // actual profile update and exact UUID receipt share the transaction.
        const actor={id:900,authVersion:md5(password),expiresAt:Math.floor(Date.now()/1000)+3600};
        const service=new AdminProfileService(createContainerFromDb(admin.db),{APP_KEY:'owned-profile-native-binding'} as Env);
        const info=await service.info(actor),input={operation_id:crypto.randomUUID(),operation:'name',revision:info.revision,payload:{real_name:'Changed'}};
        const result=await service.commit(input,actor); expect(result).toMatchObject({actor_id:900,operation:'name',state:'committed'});
        expect((await service.info(actor)).real_name).toBe('Changed');
        const committed=await full(); expect(await service.commit(input,actor)).toEqual(result);
        expect(await service.receipt(input.operation_id,'name',actor)).toEqual(result); expect(await full()).toEqual(committed);
        await expect(assertAdminProfileReady(app.db)).rejects.toMatchObject({code:503});
        await expect(runAdminProfileUpgrade(admin.db,target)).rejects.toThrow(); expect(await full()).toEqual(committed);
        for (const lock of [
          'LOCK TABLE ONLY public.system_admin IN SHARE ROW EXCLUSIVE MODE',
          'LOCK TABLE ONLY public.admin_profile_operation IN ACCESS SHARE MODE',
        ]) await whole.withPeer!(async peer=>{
          await peer.exec('BEGIN');
          try {
            await peer.exec(lock); const result=await outcome(runAdminProfileUpgrade(whole.db,target));
            if(result.ok)throw Error('Conflicting independent table lock was ignored'); expect(sqlCode(result.error)).toBe('55P03');
          } finally { await peer.exec('ROLLBACK'); }
        });
        await whole.withPeer!(async peer=>{
          await peer.exec('BEGIN');
          try { await peer.exec('SELECT pg_advisory_xact_lock(731626,13)'); await expect(runAdminProfileUpgrade(whole.db,target)).rejects.toThrow('busy'); }
          finally { await peer.exec('ROLLBACK'); }
        });
        expect(await full()).toEqual(committed);
        expect(await runAdminProfileUpgrade(whole.db,target)).toEqual({operation:'admin-self-profile-v1',applied:false});
        expect(await full()).toEqual(committed);
        expect(await inspect()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
      }));
      expect(fetch).not.toHaveBeenCalled();
    } finally { await whole.close(); }
  },180000);
});
