import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {eq,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Env} from '@/env';
import {createContainerFromDb,type DbClient} from '@/lib/di';
import {systemAdmin,user,userLabel,userLabelRelation,storePromotions,storeOrder,storeProduct} from '@/models/schema';
import {md5} from '@/utils/jwt';
import {AdminUserLabelAuthorService,labelDigest} from '@/services/admin/AdminUserLabelAuthorService';
import {UserSegmentationService} from '@/services/user/UserSegmentationService';
import {labelCanonical,type LabelAction,type LabelOperation} from '../../view/common/labelAuthor';
import {runAdminLabelUpgrade} from '@/migrations/runAdminLabelUpgrade';
import {assertAdminLabelOperationReady,inspectAdminLabelOperation} from '@/migrations/adminLabelOperation';
import {runRuntimeBusinessCommissioning} from '@/migrations/runRuntimeBusinessCommissioning';
import {auditRuntimeBusinessPrivileges} from '@/migrations/auditRuntimeBusinessPrivileges';
import {inspectAdminAuthorityMaintenanceSnapshot} from '@/migrations/adminAuthorityOperationMaintenance';
import {refundRuntimeFixture} from './helpers/refundRuntimeFixture';
import {outcome} from './helpers/financePeers';

function interrupted(db:DbClient,trace:{reached:boolean}):DbClient{
 const dialect=new PgDialect();
 return new Proxy(db,{get(target,key){const member:unknown=Reflect.get(target,key);if(typeof member!=='function')return member;if(key!=='transaction')return member.bind(target);
  return(callback:(tx:Pick<DbClient,'execute'>)=>Promise<unknown>,options:unknown)=>target.transaction(async tx=>{
   const port=new Proxy(tx,{get(value,property){const method:unknown=Reflect.get(value,property);if(typeof method!=='function')return method;if(property!=='execute')return method.bind(value);
    return async(query:Parameters<typeof tx.execute>[0])=>{const text=dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql,result=await tx.execute(query);if(text.startsWith('GRANT SELECT, INSERT ON TABLE public.admin_label_operation TO ')){trace.reached=true;throw Error('Owned label interruption after real receipt grant');}return result;};}});
   return callback(port);
  },options as Parameters<typeof target.transaction>[1]);
 }});
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}

/** Wrap real query builders and the real transaction callback. Only pause after
 * the mature setUserLabels SELECT completed; rows/SQL/locks are not fabricated. */
function pauseFirstLabelRead(db:DbClient,seen:ReturnType<typeof deferred>,resume:ReturnType<typeof deferred>):DbClient{
 let paused=false;
 function builder(target:object,isLabel=false):object{return new Proxy(target,{get(value,key){
  if(key==='then')return(resolve:(rows:unknown)=>unknown,reject:(error:unknown)=>unknown)=>Promise.resolve(value).then(async rows=>{if(isLabel&&!paused){paused=true;seen.resolve();await resume.promise;}return rows;}).then(resolve,reject);
  const member:unknown=Reflect.get(value,key);if(typeof member!=='function')return member;
  return(...args:unknown[])=>{const next:unknown=Reflect.apply(member,value,args),label=isLabel||key==='from'&&args[0]===userLabel;return next&&typeof next==='object'&&'then'in next?builder(next,label):next;};
 }});}
 function database(target:DbClient):DbClient{return new Proxy(target,{get(value,key){const member:unknown=Reflect.get(value,key);if(typeof member!=='function')return member;
  if(key==='transaction')return(callback:(tx:DbClient)=>Promise<unknown>,options:unknown)=>value.transaction(tx=>callback(database(tx as unknown as DbClient)),options as Parameters<typeof value.transaction>[1]);
  if(key==='select')return(...args:unknown[])=>builder(Reflect.apply(member,value,args) as object);return member.bind(value);
 }});}
 return database(db);
}
async function withReader<T>(peer:{role:string;connectionString:string;pid:number},database:string,run:(reader:{db:DbClient;pid:number})=>Promise<T>){
 const url=new URL(peer.connectionString);
 if(!['127.0.0.1','localhost'].includes(url.hostname)||!/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(database)||url.pathname!==`/${database}`||decodeURIComponent(url.username)!==peer.role||url.search||url.hash)throw Error('Unexpected owned label reader target');
 const connection=postgres(url.href,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,max_lifetime:0,connection:{options:'-c search_path=public -c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=15000'}});
 try{const[identity]=await connection`SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num')::integer/10000 AS major`;
  if(identity.database!==database||identity.role!==peer.role||identity.session!==peer.role||identity.pid===peer.pid||identity.major!==16)throw Error('Reader is not an independent owned PG16 LOGIN');
  return await run({db:drizzle(connection) as unknown as DbClient,pid:Number(identity.pid)});
 }finally{await connection.end({timeout:2});}
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('ordinary label/category native addon, old assignment reader and atomic reference protection',()=>{
 afterEach(()=>vi.restoreAllMocks());
 it('commissions exact independent LOGIN permissions and preserves author/assignment/receipt/reference contracts',async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Owned label native acceptance forbids provider I/O'));
  const whole=await refundRuntimeFixture();
  try{
   if(!whole.withRuntimeRole||!whole.withPeer)throw Error('Independent native LOGIN and lock peers required');
   await whole.withRuntimeRole(async app=>whole.withRuntimeRole!(async admin=>{
    const[identity]=await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance,current_setting('server_version_num')::integer/10000 AS major`);expect(identity.major).toBe(16);
    const target={database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role};
    await runRuntimeBusinessCommissioning(whole.db,{...target,pricingOwner:whole.pricingOwner});
    const password='owned-label-native-password';await whole.db.insert(systemAdmin).values({id:900,account:'owned_label',pwd:password,realName:'Owned root',roles:'',level:0,status:1,isDel:0,adminType:1,relationId:0});
    for(const table of ['category','user_label'])await whole.exec(`SELECT setval(pg_get_serial_sequence('public.${table}','id'),(SELECT coalesce(max(id),0)+1 FROM public.${table}),false)`);
    const audit=async()=>({app:await auditRuntimeBusinessPrivileges(app.db,'app',target),admin:await auditRuntimeBusinessPrivileges(admin.db,'admin',target)});
    const snapshot=async()=>({whole:await whole.db.transaction(tx=>inspectAdminAuthorityMaintenanceSnapshot(tx,{wholeData:true}),{isolationLevel:'repeatable read',accessMode:'read only'}),sequences:Array.from(await whole.db.execute(sql`SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`),row=>({...row}))});
    expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    await expect(admin.db.transaction(tx=>assertAdminLabelOperationReady(tx))).rejects.toMatchObject({code:503});
    const initial=await snapshot(),trace={reached:false};await expect(runAdminLabelUpgrade(interrupted(whole.db,trace),target)).rejects.toThrow('Owned label interruption');expect(trace.reached).toBe(true);expect(await snapshot()).toEqual(initial);expect(await inspectAdminLabelOperation(whole.db,target)).toBe(false);
    expect(await runAdminLabelUpgrade(whole.db,target)).toEqual({operation:'admin-label-operation-v1',applied:true});const installed=await snapshot(),oldTables=new Set(initial.whole.data.map(row=>row.name));
    expect(installed.whole.tableCount).toBe(initial.whole.tableCount+1);expect(installed.whole.data.filter(row=>oldTables.has(row.name))).toEqual(initial.whole.data);expect(installed.whole.data.filter(row=>!oldTables.has(row.name))).toEqual([expect.objectContaining({name:'admin_label_operation',rows:'0'})]);expect(installed.sequences).toEqual(initial.sequences);
    await expect(admin.db.transaction(tx=>assertAdminLabelOperationReady(tx))).resolves.toBeUndefined();await expect(app.exec('SELECT * FROM public.admin_label_operation')).rejects.toMatchObject({code:'42501'});await expect(app.exec("INSERT INTO public.user_label(name) VALUES('FORBIDDEN')")).rejects.toMatchObject({code:'42501'});
    for(const statement of ['UPDATE public.admin_label_operation SET actor_id=1','DELETE FROM public.admin_label_operation','TRUNCATE public.admin_label_operation','ALTER TABLE public.admin_label_operation ADD COLUMN forbidden integer','SELECT public.admin_label_operation_immutable_v1()'])await expect(admin.exec(statement)).rejects.toMatchObject({code:'42501'});
    const actor={id:900,authVersion:md5(password),expiresAt:Math.floor(Date.now()/1000)+3600},service=new AdminUserLabelAuthorService(createContainerFromDb(admin.db),{APP_KEY:'owned-label-native-key'} as Env),query=new URLSearchParams();
    const intent=async(operation:LabelOperation,target_id:number,payload:Record<string,unknown>={}):Promise<LabelAction>=>{const action={operation_id:crypto.randomUUID(),actor_id:actor.id,operation,target_id,revision:(await service.catalog(query,actor)).revision,payload};return{...action,payload_hash:labelDigest(labelCanonical(action))};};
    const categoryAction=await intent('category_create',0,{name:'Native category',sort:3}),categoryReceipt=await service.mutate(categoryAction,actor),categoryId=categoryReceipt.result.id;
    const values={name:'Native label',label_cate:categoryId,color:'#123456',sort:2,status:1},labelAction=await intent('label_create',0,values),labelReceipt=await service.mutate(labelAction,actor),labelId=labelReceipt.result.id;
    const update=await intent('label_update',labelId,{...values,color:'#654321'}),updated=await service.mutate(update,actor),stable=await snapshot();
    for(const[action,receipt]of [[categoryAction,categoryReceipt],[labelAction,labelReceipt],[update,updated]] as const){expect(await service.mutate(action,actor)).toEqual(receipt);expect(await service.receipt(action.operation_id,query,actor)).toEqual(receipt);}expect(await snapshot()).toEqual(stable);

    // Old real assignment holds a FOR KEY SHARE relation lock after its SELECT;
    // author must fail NOWAIT before it can remove the newly selected label.
    const uid=990001;await whole.db.insert(user).values({uid,account:'owned-native-label-user'});const deletion=await intent('label_delete',labelId),beforeRace=await snapshot();
    await withReader(admin,target.database,async reader=>{
     const seen=deferred(),resume=deferred(),consumer=new UserSegmentationService(createContainerFromDb(pauseFirstLabelRead(reader.db,seen,resume))),work=consumer.setUserLabels(uid,{label_ids:[labelId]});
     try{await Promise.race([seen.promise,work.then(()=>{throw Error('Old assignment finished before its real label SELECT barrier');})]);
      const[held]=await whole.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${reader.pid} AND relation='public.user_label'::regclass AND mode='RowShareLock' AND granted) AS held`);expect(held.held).toBe(true);
      const refused=await outcome(service.mutate(deletion,actor));if(refused.ok)throw Error('Label author bypassed the old assignment read transaction');expect(refused.error).toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(beforeRace);
     }finally{resume.resolve();await work;}
    });
    expect(await whole.db.select().from(userLabelRelation).where(eq(userLabelRelation.uid,uid))).toMatchObject([{labelId,uid,type:0,relationId:0}]);

    // Category deletion protects foreign labels too, despite platform-only UI.
    const[foreign]=await whole.db.insert(userLabel).values({name:'Native foreign',type:1,relationId:77,labelCate:categoryId}).returning();const categoryDelete=await intent('category_delete',categoryId),foreignSnapshot=await snapshot();await expect(service.mutate(categoryDelete,actor)).rejects.toThrow(/引用/);expect(await snapshot()).toEqual(foreignSnapshot);await whole.db.delete(userLabel).where(eq(userLabel.id,foreign!.id));
    const[foreignRelation]=await whole.db.insert(userLabelRelation).values({uid,labelId,type:1,relationId:77}).returning();const foreignRelationSnapshot=await snapshot();await expect(service.mutate(await intent('label_delete',labelId),actor)).rejects.toThrow(/范围/);expect(await snapshot()).toEqual(foreignRelationSnapshot);await whole.db.delete(userLabelRelation).where(eq(userLabelRelation.id,foreignRelation!.id));

    // Current consumers parse numeric CSV spellings, including leading zeroes.
    const[promotion]=await whole.db.insert(storePromotions).values({name:'Owned native label reference',labelId:`000${labelId}`}).returning();const promotionSnapshot=await snapshot();await expect(service.mutate(await intent('label_delete',labelId),actor)).rejects.toThrow(/促销|引用/);expect(await snapshot()).toEqual(promotionSnapshot);await whole.db.delete(storePromotions).where(eq(storePromotions.id,promotion!.id));
    const[product]=await whole.db.select({id:storeProduct.id,labelId:storeProduct.labelId}).from(storeProduct).where(eq(storeProduct.id,70));expect(product).toBeDefined();await whole.db.update(storeProduct).set({labelId:String(labelId)}).where(eq(storeProduct.id,70));const productSnapshot=await snapshot();await expect(service.mutate(await intent('label_delete',labelId),actor)).rejects.toThrow(/商品|引用/);expect(await snapshot()).toEqual(productSnapshot);await whole.db.update(storeProduct).set({labelId:product!.labelId}).where(eq(storeProduct.id,70));
    const[order]=await whole.db.insert(storeOrder).values({orderId:'owned-label-reference-order',uid,promotionsGive:JSON.stringify({version:'order-promotion-labels-v1',promotions:[{id:1,label_id:[labelId],name:'gift'}]})}).returning();const orderSnapshot=await snapshot();await expect(service.mutate(await intent('label_delete',labelId),actor)).rejects.toThrow(/快照|引用/);expect(await snapshot()).toEqual(orderSnapshot);await whole.db.delete(storeOrder).where(eq(storeOrder.id,order!.id));

    // Fail AFTER real relation cleanup: label, relations and receipt all roll back.
    await whole.exec("CREATE FUNCTION public.owned_label_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Owned label cleanup rollback'; END$$; CREATE TRIGGER owned_label_delete_failure BEFORE DELETE ON public.user_label FOR EACH ROW EXECUTE FUNCTION public.owned_label_delete_failure()");
    const failedDelete=await intent('label_delete',labelId),rollbackSnapshot=await snapshot();await expect(service.mutate(failedDelete,actor)).rejects.toThrow();expect(await snapshot()).toEqual(rollbackSnapshot);await expect(service.receipt(failedDelete.operation_id,query,actor)).rejects.toThrow(/未知/);await whole.exec('DROP TRIGGER owned_label_delete_failure ON public.user_label;DROP FUNCTION public.owned_label_delete_failure()');
    const removed=await service.mutate(failedDelete,actor);expect(removed).toMatchObject({state:'committed',step:0,result:{id:labelId,updated:1}});expect(await whole.db.select().from(userLabelRelation).where(eq(userLabelRelation.labelId,labelId))).toEqual([]);expect(await whole.db.select().from(userLabel).where(eq(userLabel.id,labelId))).toEqual([]);
    expect((await service.mutate(await intent('category_delete',categoryId),actor)).state).toBe('committed');
    const pending=await intent('category_create',0,{name:'Never applied',sort:0}),negative=await service.resolve(pending,actor),sealed=await snapshot();expect(negative).toMatchObject({state:'not_applied',step:0});await expect(service.mutate(pending,actor)).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(sealed);
    for(const statement of ['UPDATE public.admin_label_operation SET actor_id=1','DELETE FROM public.admin_label_operation','TRUNCATE public.admin_label_operation'])await expect(whole.exec(statement)).rejects.toMatchObject({code:'42501'});
    await whole.withPeer!(async peer=>{await peer.exec('BEGIN');try{await peer.exec('SELECT pg_advisory_xact_lock(731626,17)');await expect(runAdminLabelUpgrade(whole.db,target)).rejects.toThrow('busy');await expect(admin.db.transaction(tx=>assertAdminLabelOperationReady(tx))).rejects.toMatchObject({code:503});}finally{await peer.exec('ROLLBACK');}});
    for(const lock of ['LOCK TABLE ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE','LOCK TABLE ONLY public.admin_label_operation IN ACCESS SHARE MODE'])await whole.withPeer!(async peer=>{await peer.exec('BEGIN');try{await peer.exec(lock);await expect(runAdminLabelUpgrade(whole.db,target)).rejects.toThrow();}finally{await peer.exec('ROLLBACK');}});
    await whole.exec('GRANT SELECT ON public.admin_label_operation TO PUBLIC');try{expect((await audit()).admin.ready).toBe(false);await expect(runAdminLabelUpgrade(whole.db,target)).rejects.toThrow('exact existing runtime profiles');}finally{await whole.exec('REVOKE SELECT ON public.admin_label_operation FROM PUBLIC');}
    const final=await snapshot();expect(await runAdminLabelUpgrade(whole.db,target)).toEqual({operation:'admin-label-operation-v1',applied:false});expect(await snapshot()).toEqual(final);expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
   }));
   expect(fetch).not.toHaveBeenCalled();
  }finally{await whole.close();}
 },180000);
});
