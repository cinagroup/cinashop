import {eq,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {DbClient} from '@/lib/di';
import {describe,expect,it,vi,afterEach} from 'vitest';
import {deliveryService,systemAdmin,user,storeOrder} from '@/models/schema';
import {createContainerFromDb} from '@/lib/di';
import type {Env} from '@/env';
import {md5} from '@/utils/jwt';
import {AdminDeliveryAuthorService} from '@/services/admin/AdminDeliveryAuthorService';
import {AdminDeliverySupportService} from '@/services/admin/AdminDeliverySupportService';
import {deliveryActionHash} from '@/services/admin/AdminDeliveryAuthorInput';
import {newDeliveryValues,type DeliveryAction,type DeliveryOperation} from '../../view/common/deliveryAuthor';
import {runAdminDeliveryUpgrade} from '@/migrations/runAdminDeliveryUpgrade';
import {assertAdminDeliveryOperationReady,inspectAdminDeliveryOperation} from '@/migrations/adminDeliveryOperation';
import {runRuntimeBusinessCommissioning} from '@/migrations/runRuntimeBusinessCommissioning';
import {auditRuntimeBusinessPrivileges} from '@/migrations/auditRuntimeBusinessPrivileges';
import {requireDeliveryScope,readDeliveryPrincipal} from '@/services/store/DeliveryPrincipalScope';
import {refundRuntimeFixture} from './helpers/refundRuntimeFixture';
function interrupted(db:DbClient,trace:{reached:boolean}):DbClient{
 const dialect=new PgDialect();
 return new Proxy(db,{get(target,key){const method:unknown=Reflect.get(target,key);if(typeof method!=='function')return method;if(key!=='transaction')return method.bind(target);
  return(callback:(tx:Pick<DbClient,'execute'>)=>Promise<unknown>,options:unknown)=>target.transaction(async tx=>{
   const port=new Proxy(tx,{get(current,property){const member:unknown=Reflect.get(current,property);if(typeof member!=='function')return member;if(property!=='execute')return member.bind(current);
    return async(query:Parameters<typeof tx.execute>[0])=>{const text=dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql,result=await tx.execute(query);if(text.startsWith('GRANT SELECT, INSERT ON TABLE public.admin_delivery_operation TO ')){trace.reached=true;throw Error('Owned delivery interruption after grant');}return result;};}});return callback(port);
  },options as Parameters<typeof target.transaction>[1]);}});
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{resolve,promise};};
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('platform delivery author native independent PG16 LOGIN',()=>{
 afterEach(()=>vi.restoreAllMocks());
 it('commissions exact addon and fences actual existing delivery scope until its transaction commits',async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Delivery author forbids provider I/O'));
  const whole=await refundRuntimeFixture();
  try{
   if(!whole.withRuntimeRole||!whole.withPeer)throw Error('Independent LOGIN and peers required');
   await whole.withRuntimeRole(async app=>whole.withRuntimeRole!(async admin=>{
    const [identity]=await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
    const target={database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role};
    await runRuntimeBusinessCommissioning(whole.db,{...target,pricingOwner:whole.pricingOwner});
    const audit=async()=>({app:await auditRuntimeBusinessPrivileges(app.db,'app',target),admin:await auditRuntimeBusinessPrivileges(admin.db,'admin',target)});
    const addon=async()=>Array.from(await whole.db.execute(sql`SELECT * FROM public.admin_delivery_operation ORDER BY operation_id`));
    expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    await expect(admin.db.transaction(tx=>assertAdminDeliveryOperationReady(tx))).rejects.toMatchObject({code:503});
    const trace={reached:false};await expect(runAdminDeliveryUpgrade(interrupted(whole.db,trace),target)).rejects.toThrow('Owned delivery interruption');expect(trace.reached).toBe(true);expect(await inspectAdminDeliveryOperation(whole.db,target)).toBe(false);
    const [absent]=await whole.db.execute(sql`SELECT to_regclass('public.admin_delivery_operation') IS NULL AS table_absent,to_regprocedure('public.admin_delivery_operation_immutable_v1()') IS NULL AS function_absent`);expect(absent).toMatchObject({table_absent:true,function_absent:true});
    expect(await runAdminDeliveryUpgrade(whole.db,target)).toEqual({operation:'admin-delivery-operation-v1',applied:true});
    expect(await inspectAdminDeliveryOperation(whole.db,target)).toBe(true);
    expect(await addon()).toEqual([]);
    await expect(admin.db.transaction(tx=>assertAdminDeliveryOperationReady(tx))).resolves.toBeUndefined();
    for(const q of ['SELECT * FROM public.admin_delivery_operation','INSERT INTO public.admin_delivery_operation DEFAULT VALUES'])await expect(app.exec(q)).rejects.toMatchObject({code:'42501'});
    for(const q of ['UPDATE public.admin_delivery_operation SET actor_id=1','DELETE FROM public.admin_delivery_operation','TRUNCATE public.admin_delivery_operation','ALTER TABLE public.admin_delivery_operation ADD COLUMN forbidden integer'])await expect(admin.exec(q)).rejects.toMatchObject({code:'42501'});
    const uid=990511,otherUid=990512,id=990501,pwd='owned-delivery-native-password';
    await whole.db.insert(systemAdmin).values({id:900,account:'owned_delivery',pwd,level:0,status:1});
    await whole.db.insert(user).values([{uid,account:'native-delivery',pwd:'delivery-user-pwd',nickname:'Delivery person',phone:'13800138000',avatar:'https://native.test/one.png'},{uid:otherUid,account:'native-delivery-new',nickname:'New person',phone:'13900139000',avatar:'https://native.test/two.png'}]);
    await whole.db.insert(deliveryService).values([{id,uid,type:0,relationId:0,nickname:'Original delivery',phone:'13800138000',status:1},{id:id+1,uid:otherUid,type:2,relationId:88,nickname:'Foreign supplier delivery',phone:'13900139000',status:1}]);
    await whole.exec("SELECT setval(pg_get_serial_sequence('public.delivery_service','id'),(SELECT max(id)+1 FROM public.delivery_service),false)");
    const actor={id:900,authVersion:md5(pwd),expiresAt:Math.floor(Date.now()/1000)+3600},env={APP_KEY:'owned-delivery-native-key'} as Env,query=new URLSearchParams();
    const service=new AdminDeliveryAuthorService(createContainerFromDb(admin.db),env),support=new AdminDeliverySupportService(createContainerFromDb(admin.db),env);
    const intent=async(operation:DeliveryOperation,target_id:number,payload:Record<string,unknown>={}):Promise<DeliveryAction>=>{const a={operation_id:crypto.randomUUID(),actor_id:900,operation,target_id,revision:(await service.catalog(query,actor)).revision,payload};return{...a,payload_hash:deliveryActionHash(a)};};
    const snapshot=async()=>({rows:await whole.db.select().from(deliveryService).orderBy(deliveryService.id),users:await whole.db.select().from(user).orderBy(user.uid),receipts:await addon()});
    const original=(await whole.db.select().from(deliveryService).where(eq(deliveryService.id,id)))[0];
    const update=await intent('update',id,{...newDeliveryValues((await service.catalog(query,actor)).list.find(r=>r.id===id)),nickname:'Renamed delivery'}),receipt=await service.mutate(update,actor);
    expect((await whole.db.select().from(deliveryService).where(eq(deliveryService.id,id)))[0]).toEqual({...original,nickname:'Renamed delivery'});
    const picked=(await support.users(new URLSearchParams('keyword='+otherUid),actor)).list.find(r=>r.uid===otherUid)!;
    const create=await intent('create',0,{...newDeliveryValues(),uid:otherUid,avatar:picked.avatar,nickname:'',phone:'',user_selection:picked.selection});
    for(const action of [await intent('status',id,{status:0}),await intent('delete',id),create]){
     const before=await snapshot(),seen=deferred(),resume=deferred(),number='delivery-'+crypto.randomUUID().replaceAll('-','').slice(0,22);
     const work=app.db.transaction(async tx=>{
      const scope=await requireDeliveryScope(tx as unknown as Parameters<typeof requireDeliveryScope>[0],{uid,authVersion:md5('delivery-user-pwd'),expiresAt:Math.floor(Date.now()/1000)+600},{kind:'platform',store_id:0,delivery_id:id},{lock:true});
      expect(scope.contexts).toMatchObject([{delivery_id:id,kind:'platform'}]);seen.resolve();await resume.promise;
      await tx.insert(storeOrder).values({orderId:number,unique:number,uid,deliveryUid:uid,deliveryType:'send'});
     });
     try{
      await Promise.race([seen.promise,work.then(()=>{throw Error('Actual delivery scope did not pause');})]);
      const [lock]=await whole.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${app.pid} AND relation='public.delivery_service'::regclass AND mode='ShareLock' AND granted) AS held`);expect(lock.held).toBe(true);
      await expect(service.mutate(action,actor)).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(before);
     }finally{resume.resolve();await work;}
     expect((await whole.db.select().from(storeOrder).where(eq(storeOrder.orderId,number)))[0]).toMatchObject({deliveryUid:uid,deliveryType:'send'});
    }
    const created=await service.mutate(create,actor);expect((await whole.db.select().from(deliveryService).where(eq(deliveryService.id,created.result.id)))[0]).toMatchObject({uid:otherUid,type:0,relationId:0,nickname:'New person',phone:'13900139000',isDel:0});
    const stable=await snapshot();expect(await service.mutate(update,actor)).toEqual(receipt);expect(await service.receipt(update.operation_id,query,actor)).toEqual(receipt);expect(await snapshot()).toEqual(stable);
    const off=await intent('status',id,{status:0});await service.mutate(off,actor);expect((await readDeliveryPrincipal(app.db,uid)).contexts).toEqual([]);
    const deletion=await intent('delete',id);await service.mutate(deletion,actor);expect((await whole.db.select().from(deliveryService).where(eq(deliveryService.id,id)))[0]).toEqual({...original,nickname:'Renamed delivery',isDel:1,status:0});
    const unknown=await intent('delete',created.result.id);expect((await service.resolve(unknown,actor)).state).toBe('not_applied');await expect(service.mutate(unknown,actor)).rejects.toMatchObject({httpStatus:409});
    await whole.withPeer!(async peer=>{await peer.exec('BEGIN');try{await peer.exec('SELECT pg_advisory_xact_lock(731626,20)');await expect(runAdminDeliveryUpgrade(whole.db,target)).rejects.toThrow('busy');}finally{await peer.exec('ROLLBACK');}});
    expect(await runAdminDeliveryUpgrade(whole.db,target)).toEqual({operation:'admin-delivery-operation-v1',applied:false});expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    for(const q of ['UPDATE public.admin_delivery_operation SET actor_id=1','DELETE FROM public.admin_delivery_operation','TRUNCATE public.admin_delivery_operation'])await expect(whole.exec(q)).rejects.toMatchObject({code:'42501'});
   }));expect(fetch).not.toHaveBeenCalled();
  }finally{await whole.close();}
 },180000);
});
