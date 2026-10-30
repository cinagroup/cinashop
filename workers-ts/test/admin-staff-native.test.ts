import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin, systemAttachment, systemStoreStaff, storeOrder, user } from '@/models/schema';
import { md5 } from '@/utils/jwt';
import { AdminStaffSupportService } from '@/services/admin/AdminStaffSupportService';
import { AdminStaffAuthorService } from '@/services/admin/AdminStaffAuthorService';
import { staffActionHash } from '@/services/admin/AdminStaffAuthorInput';
import { readStoreManagerIdentities } from '@/services/store/StoreManagerScope';
import { runAdminStaffUpgrade } from '@/migrations/runAdminStaffUpgrade';
import { assertAdminStaffOperationReady, inspectAdminStaffOperation } from '@/migrations/adminStaffOperation';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { inspectAdminAuthorityMaintenanceSnapshot } from '@/migrations/adminAuthorityOperationMaintenance';
import { newStaffValues, type StaffAction, type StaffOperation } from '../../view/common/staffAuthor';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { outcome } from './helpers/financePeers';

function interrupted(db: DbClient, trace: { reached: boolean }): DbClient {
  const dialect = new PgDialect();
  return new Proxy(db, { get(target, key) {
    const method: unknown = Reflect.get(target, key); if (typeof method !== 'function') return method;
    if (key !== 'transaction') return method.bind(target);
    return (callback: (tx: Pick<DbClient, 'execute'>) => Promise<unknown>, options: unknown) => target.transaction(async tx => {
      const port = new Proxy(tx, { get(current, property) {
        const member: unknown = Reflect.get(current, property); if (typeof member !== 'function') return member;
        if (property !== 'execute') return member.bind(current);
        return async (query: Parameters<typeof tx.execute>[0]) => {
          const text = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql, result = await tx.execute(query);
          if (text.startsWith('GRANT SELECT, INSERT ON TABLE public.admin_staff_operation TO ')) { trace.reached = true; throw Error('Owned store interruption after real receipt grant'); }
          return result;
        };
      } });
      return callback(port);
    }, options as Parameters<typeof target.transaction>[1]);
  } });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

function pauseFirstStaffRead(db: DbClient, seen: ReturnType<typeof deferred>, resume: ReturnType<typeof deferred>): DbClient {
  let paused = false;
  function builder(target: object, isStore = false): object {
    return new Proxy(target, { get(value, key) {
      if (key === 'then') return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(value).then(async rows => { if (isStore && !paused) { paused = true; seen.resolve(); await resume.promise; } return rows; }).then(resolve, reject);
      const member: unknown = Reflect.get(value, key);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(member, value, args), store = isStore || key === 'from' && args[0] === systemStoreStaff;
        return result && typeof result === 'object' && 'then' in result ? builder(result, store) : result;
      };
    } });
  }
  return new Proxy(db, { get(target, key) {
    const member: unknown = Reflect.get(target, key); if (typeof member !== 'function') return member;
    if (key !== 'select') return member.bind(target);
    return (...args: unknown[]) => builder(Reflect.apply(member, target, args) as object);
  } });
}

async function withReader<T>(peer: { role: string; connectionString: string; pid: number }, database: string,
  run: (reader: { db: DbClient; pid: number; exec: (text: string) => Promise<unknown> }) => Promise<T>) {
  const url = new URL(peer.connectionString);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(database)
    || url.pathname !== `/${database}` || decodeURIComponent(url.username) !== peer.role || url.search || url.hash) throw Error('Unexpected owned store reader target');
  const client = postgres(url.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
    connection: { options: '-c search_path=public -c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=15000' } });
  try {
    const [identity] = await client`SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num')::integer/10000 AS major`;
    if (identity.database !== database || identity.role !== peer.role || identity.session !== peer.role || identity.pid === peer.pid || identity.major !== 16) throw Error('Reader is not an independent owned PG16 LOGIN');
    return await run({ db: drizzle(client) as unknown as DbClient, pid: Number(identity.pid), exec: text => client.unsafe(text) });
  } finally { await client.end({ timeout: 2 }); }
}


describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('staff explicit addon and independent native LOGIN with actual old manager read race',()=>{
 afterEach(()=>vi.restoreAllMocks());
 it('commissions atomically and preserves staff/store/user contracts with old App readers',async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Native staff author forbids provider I/O'));
  const whole=await refundRuntimeFixture();
  try{
   if(!whole.withRuntimeRole||!whole.withPeer)throw Error('Independent native LOGIN and peers required');
   await whole.withRuntimeRole(async app=>whole.withRuntimeRole!(async admin=>{
    const[identity]=await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance,current_setting('server_version_num')::integer/10000 AS major`);
    expect(identity.major).toBe(16);
    const target={database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role};
    await runRuntimeBusinessCommissioning(whole.db,{...target,pricingOwner:whole.pricingOwner});
    const pwd='owned-staff-native-password';await whole.db.insert(systemAdmin).values({id:900,account:'owned_staff',pwd,level:0,status:1});
    const audit=async()=>({app:await auditRuntimeBusinessPrivileges(app.db,'app',target),admin:await auditRuntimeBusinessPrivileges(admin.db,'admin',target)});
    const snapshot=async()=>({whole:await whole.db.transaction(tx=>inspectAdminAuthorityMaintenanceSnapshot(tx,{wholeData:true}),{isolationLevel:'repeatable read',accessMode:'read only'}),sequences:Array.from(await whole.db.execute(sql`SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`),r=>({...r}))});
    expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    await expect(admin.db.transaction(tx=>assertAdminStaffOperationReady(tx))).rejects.toMatchObject({code:503});
    const before=await snapshot(),trace={reached:false};
    await expect(runAdminStaffUpgrade(interrupted(whole.db,trace),target)).rejects.toThrow('Owned store interruption');
    expect(trace.reached).toBe(true);expect(await snapshot()).toEqual(before);expect(await inspectAdminStaffOperation(whole.db,target)).toBe(false);
    expect(await runAdminStaffUpgrade(whole.db,target)).toEqual({operation:'admin-staff-operation-v1',applied:true});
    const installed=await snapshot(),old=new Set(before.whole.data.map(r=>r.name));
    expect(installed.whole.tableCount).toBe(before.whole.tableCount+1);expect(installed.whole.data.filter(r=>old.has(r.name))).toEqual(before.whole.data);expect(installed.sequences).toEqual(before.sequences);
    expect(installed.whole.data.filter(r=>!old.has(r.name))).toEqual([expect.objectContaining({name:'admin_staff_operation',rows:'0'})]);
    await expect(admin.db.transaction(tx=>assertAdminStaffOperationReady(tx))).resolves.toBeUndefined();
    for(const q of ['SELECT * FROM public.admin_staff_operation','INSERT INTO public.admin_staff_operation DEFAULT VALUES',"UPDATE public.system_store_staff SET status=0"])await expect(app.exec(q)).rejects.toMatchObject({code:'42501'});
    for(const q of ['UPDATE public.admin_staff_operation SET actor_id=1','DELETE FROM public.admin_staff_operation','TRUNCATE public.admin_staff_operation','ALTER TABLE public.admin_staff_operation ADD COLUMN forbidden integer','SELECT public.admin_staff_operation_immutable_v1()'])await expect(admin.exec(q)).rejects.toMatchObject({code:'42501'});
    // The deployed store table deliberately has no optional city-delivery pair.
    const storeId=990101,uid=990111,otherUid=990112,staffId=990201;
    await whole.exec(`INSERT INTO public.system_store(id,name,is_show,is_store,bank_code) VALUES(${storeId},'Native staff store',1,1,'preserved-bank')`);
    await whole.db.insert(user).values([{uid,account:'native-staff-manager',pwd:'user-private',nickname:'Native manager',avatar:'https://native.test/manager.png'},{uid:otherUid,account:'native-staff-other',pwd:'other-private',nickname:'Native other',avatar:'/api/assets/900001'}]);
    await whole.db.insert(systemAttachment).values({attId:900001,type:3,relationId:otherUid,moduleType:3,fileType:1,imageType:8,attDir:'/api/assets/900001',sattDir:'/api/assets/900001',name:`attachments/user/${otherUid}/2026/10/avatar.png`,attType:'image/png'});
    await whole.db.insert(systemStoreStaff).values({id:staffId,storeId,uid,account:'legacy-manager',pwd:'legacy-private-hash',roles:'legacy-role',lastIp:'10.1.2.3',loginCount:9,staffName:'Native staff',phone:'123456',avatar:'https://native.test/manager.png',verifyStatus:1,isManager:1,isCashier:1,notify:1,status:1});
    await whole.exec("SELECT setval(pg_get_serial_sequence('public.system_store_staff','id'),(SELECT max(id)+1 FROM public.system_store_staff),false)");
    const actor={id:900,authVersion:md5(pwd),expiresAt:Math.floor(Date.now()/1000)+3600},env={APP_KEY:'owned-staff-native-key'} as Env;
    const service=new AdminStaffAuthorService(createContainerFromDb(admin.db),env),support=new AdminStaffSupportService(createContainerFromDb(admin.db),env),query=new URLSearchParams();
    const intent=async(operation:StaffOperation,target_id:number,payload:Record<string,unknown>={}):Promise<StaffAction>=>{const a={operation_id:crypto.randomUUID(),actor_id:900,operation,target_id,revision:(await service.catalog(query,actor)).revision,payload};return{...a,payload_hash:staffActionHash(a)};};
    const original=(await whole.db.select().from(systemStoreStaff).where(eq(systemStoreStaff.id,staffId)))[0];
    const update=await intent('update',staffId,{...newStaffValues((await service.catalog(query,actor)).list.find(r=>r.id===staffId)),staff_name:'Renamed only'}),updated=await service.mutate(update,actor);
    expect((await whole.db.select().from(systemStoreStaff).where(eq(systemStoreStaff.id,staffId)))[0]).toEqual({...original,staffName:'Renamed only'});
    expect((await readStoreManagerIdentities(app.db,uid)).stores).toMatchObject([{store_id:storeId,staff_id:staffId}]);
    // Pause AFTER the existing consumer's real joined staff SELECT, holding its
    // AccessShareLock through the ordinary App transaction and controlled order
    // INSERT. This is catalog concurrency evidence, not a full order API test.
    for(const operation of ['status','delete'] as const){
     const action=await intent(operation,staffId,operation==='status'?{status:0}:{}),frozen=await snapshot(),number=`staff-${crypto.randomUUID().replaceAll('-','').slice(0,24)}`;
     await withReader(app,target.database,async reader=>{
      const seen=deferred(),resume=deferred();
      const work=reader.db.transaction(async tx=>{const scope=await readStoreManagerIdentities(pauseFirstStaffRead(tx as unknown as DbClient,seen,resume),uid);expect(scope.stores).toMatchObject([{store_id:storeId,staff_id:staffId}]);await tx.insert(storeOrder).values({orderId:number,unique:number,uid,storeId,status:0,shippingType:2});});
      try{await Promise.race([seen.promise,work.then(()=>{throw Error('Manager consumer finished without actual staff SELECT');})]);const[held]=await whole.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${reader.pid} AND relation='public.system_store_staff'::regclass AND mode='AccessShareLock' AND granted) AS held`);expect(held.held).toBe(true);const refused=await outcome(service.mutate(action,actor));if(refused.ok)throw Error('Staff author bypassed old App reader');expect(refused.error).toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(frozen);}finally{resume.resolve();await work;}
     });
     expect((await whole.db.select().from(storeOrder).where(eq(storeOrder.orderId,number)))[0]).toMatchObject({storeId,status:0});
    }
    const off=await intent('status',staffId,{status:0}),offReceipt=await service.mutate(off,actor);expect((await readStoreManagerIdentities(app.db,uid)).stores).toEqual([]);
    await service.mutate(await intent('status',staffId,{status:1}),actor);
    const picked=(await support.users(new URLSearchParams('keyword='+otherUid),actor)).list.find(r=>r.uid===otherUid)!;
    expect(picked.preview).toMatch(/^\/api\/assets\/900001\?expires=/);
    const creation=await intent('create',0,{...newStaffValues(),uid:otherUid,avatar:picked.avatar,store_id:storeId,staff_name:'Selected user',phone:'010-12345678',user_selection:picked.selection}),made=await service.mutate(creation,actor);
    expect((await whole.db.select().from(systemStoreStaff).where(eq(systemStoreStaff.id,made.result.id)))[0]).toMatchObject({uid:otherUid,pwd:'',roles:'',isManager:0,isAdmin:0,isCashier:0,avatar:'/api/assets/900001'});
    const stable=await snapshot();for(const[a,r]of [[update,updated],[off,offReceipt],[creation,made]] as const){expect(await service.mutate(a,actor)).toEqual(r);expect(await service.receipt(a.operation_id,query,actor)).toEqual(r);}expect(await snapshot()).toEqual(stable);
    // All shared lock ports refuse early. User and selected attachment rows use
    // real independent FOR UPDATE peers and the immutable current snapshot.
    for(const lock of ['SELECT pg_advisory_xact_lock(731745,1)','SELECT pg_advisory_xact_lock(8214001,0)','LOCK TABLE ONLY public.system_store IN ACCESS EXCLUSIVE MODE'])await whole.withPeer!(async peer=>{const a=await intent('delete',staffId),b=await snapshot();await peer.exec('BEGIN');try{await peer.exec(lock);await expect(service.mutate(a,actor)).rejects.toMatchObject({httpStatus:409});}finally{await peer.exec('ROLLBACK');}expect(await snapshot()).toEqual(b);});
    // A newly selected user is not yet referenced by any staff source row;
    // its own current row must still be locked independently before granting.
    await whole.db.insert(user).values({uid:otherUid+1,account:'native-staff-third',nickname:'Third user',avatar:'https://native.test/third.png'});
    const third=(await support.users(new URLSearchParams('keyword='+(otherUid+1)),actor)).list.find(r=>r.uid===otherUid+1)!;
    const selectedAction=await intent('create',0,{...newStaffValues(),uid:third.uid,avatar:third.avatar,store_id:storeId,staff_name:'Locked selected',phone:'12345',user_selection:third.selection});
    await whole.withPeer!(async peer=>{const b=await snapshot();await peer.exec('BEGIN');try{await peer.exec(`SELECT uid FROM public."user" WHERE uid=${third.uid} FOR UPDATE`);await expect(service.mutate(selectedAction,actor)).rejects.toMatchObject({httpStatus:409});}finally{await peer.exec('ROLLBACK');}expect(await snapshot()).toEqual(b);});
    await whole.db.insert(systemAttachment).values({attId:900002,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,attDir:'/api/assets/900002',sattDir:'/api/assets/900002',name:'attachments/admin/1/2026/10/avatar.png',attType:'image/png'});
    const assetAction=await intent('update',made.result.id,{...newStaffValues((await service.catalog(query,actor)).list.find(r=>r.id===made.result.id)),avatar:'/api/assets/900002'});
    await whole.withPeer!(async peer=>{const b=await snapshot();await peer.exec('BEGIN');try{await peer.exec('SELECT att_id FROM public.system_attachment WHERE att_id=900002 FOR UPDATE');await expect(service.mutate(assetAction,actor)).rejects.toMatchObject({httpStatus:409});}finally{await peer.exec('ROLLBACK');}expect(await snapshot()).toEqual(b);});
    await whole.exec("CREATE FUNCTION public.owned_staff_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.pwd='forged'; RETURN NEW; END$$; CREATE TRIGGER owned_staff_failure BEFORE UPDATE ON public.system_store_staff FOR EACH ROW EXECUTE FUNCTION public.owned_staff_failure()");
    try{const a=await intent('update',staffId,{...newStaffValues((await service.catalog(query,actor)).list.find(r=>r.id===staffId)),staff_name:'Must rollback'}),b=await snapshot();await expect(service.mutate(a,actor)).rejects.toThrow(/回读/);expect(await snapshot()).toEqual(b);await expect(service.receipt(a.operation_id,query,actor)).rejects.toThrow(/未知/);}finally{await whole.exec('DROP TRIGGER owned_staff_failure ON public.system_store_staff; DROP FUNCTION public.owned_staff_failure()');}
    const deletion=await intent('delete',staffId),deleted=await service.mutate(deletion,actor);expect(deleted.state).toBe('committed');expect((await readStoreManagerIdentities(app.db,uid)).stores).toEqual([]);expect((await whole.db.select().from(systemStoreStaff).where(eq(systemStoreStaff.id,staffId)))[0]).toEqual({...original,staffName:'Renamed only',isDel:1,status:0,verifyStatus:0,notify:0});
    const unknown=await intent('delete',made.result.id),sealed=await service.resolve(unknown,actor),sealedSnapshot=await snapshot();expect(sealed.state).toBe('not_applied');await expect(service.mutate(unknown,actor)).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(sealedSnapshot);
    await whole.withPeer!(async peer=>{await peer.exec('BEGIN');try{await peer.exec('SELECT pg_advisory_xact_lock(731626,19)');await expect(runAdminStaffUpgrade(whole.db,target)).rejects.toThrow('busy');await expect(admin.db.transaction(tx=>assertAdminStaffOperationReady(tx))).rejects.toMatchObject({code:503});}finally{await peer.exec('ROLLBACK');}});
    await whole.exec('GRANT SELECT ON public.admin_staff_operation TO PUBLIC');try{expect((await audit()).admin.ready).toBe(false);await expect(runAdminStaffUpgrade(whole.db,target)).rejects.toThrow('exact existing runtime profiles');}finally{await whole.exec('REVOKE SELECT ON public.admin_staff_operation FROM PUBLIC');}
    const final=await snapshot();expect(await runAdminStaffUpgrade(whole.db,target)).toEqual({operation:'admin-staff-operation-v1',applied:false});expect(await snapshot()).toEqual(final);expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    for(const q of ['UPDATE public.admin_staff_operation SET actor_id=1','DELETE FROM public.admin_staff_operation','TRUNCATE public.admin_staff_operation'])await expect(whole.exec(q)).rejects.toMatchObject({code:'42501'});
   }));
   expect(fetch).not.toHaveBeenCalled();
  }finally{await whole.close();}
 },180000);
});
