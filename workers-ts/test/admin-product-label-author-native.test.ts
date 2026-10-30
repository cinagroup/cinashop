import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {drizzle} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createContainerFromDb,type DbClient} from '@/lib/di';
import {legacyCategory,storeProductLabel,storeProductLabelAuxiliary,storeProductRelation,storeProduct,systemAttachment,systemAdmin,systemRole,systemLog,systemSupplier} from '@/models/schema';
import {md5} from '@/utils/jwt';
import {AdminProductLabelAuthorService} from '@/services/admin/AdminProductLabelAuthorService';
import {AdminProductLabelService} from '@/services/admin/AdminProductLabelService';
import {ProductAssociationService} from '@/services/product/ProductAssociationService';
import {SupplierProductLabelService} from '@/services/supplier/SupplierProductLabelService';
import {assertSupplierProductLabelBindings,replaceSupplierProductLabelBindings} from '@/services/supplier/SupplierProductLabelBindings';
import {productLabelActionHash} from '@/services/admin/AdminProductLabelAuthorInput';
import {publicProductLabelAuthorImages} from '@/services/product/ProductLabelAuthorAssetPolicy';
import {readPublicProductLabelMap} from '@/services/product/PublicProductLabelData';
import {runRuntimeBusinessCommissioning} from '@/migrations/runRuntimeBusinessCommissioning';
import {auditRuntimeBusinessPrivileges} from '@/migrations/auditRuntimeBusinessPrivileges';
import {runAdminHotwordUpgrade} from '@/migrations/runAdminHotwordUpgrade';
import {inspectAdminHotwordOperation} from '@/migrations/adminHotwordOperation';
import {runAdminProductLabelUpgrade} from '@/migrations/runAdminProductLabelUpgrade';
import {runSupplierProductLabelUpgrade} from '@/migrations/runSupplierProductLabelUpgrade';
import {assertAdminProductLabelOperationReady,inspectAdminProductLabelOperation} from '@/migrations/adminProductLabelOperation';
import {refundRuntimeFixture} from './helpers/refundRuntimeFixture';
import type {SequenceRunnerPeer} from './helpers/checkoutPricingMigrationDatabase';
import type {ProductLabelAction,ProductLabelOperation,ProductLabelRow} from '../../view/common/productLabelAuthor';

const signal=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
const outcome=<T>(task:Promise<T>)=>task.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
async function waitFor(exec:SequenceRunnerPeer['exec'],statement:string){
  for(let i=0;i<120;i++){const [row]=await exec(statement);if(row?.waiting===true)return;await new Promise(done=>setTimeout(done,10));}
  throw Error('Expected actual product_label writer blocker was not observed');
}
async function paused<T>(ready:ReturnType<typeof signal>,task:ReturnType<typeof outcome<T>>){
  await Promise.race([ready.promise,task.then(result=>{if(!result.ok)throw result.error;throw Error('Actual writer returned without pausing');})]);
}
function interrupted(db:DbClient,trace:{reached:boolean}):DbClient{
  const dialect=new PgDialect();
  return new Proxy(db,{get(target,key){const method:unknown=Reflect.get(target,key);if(typeof method!=='function')return method;if(key!=='transaction')return method.bind(target);
    return(callback:(tx:Pick<DbClient,'execute'>)=>Promise<unknown>,options:unknown)=>target.transaction(async tx=>{
      const port=new Proxy(tx,{get(current,property){const member:unknown=Reflect.get(current,property);if(typeof member!=='function')return member;if(property!=='execute')return member.bind(current);
        return async(query:Parameters<typeof tx.execute>[0])=>{const statement=dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql;
          const result=await tx.execute(query);if(statement.startsWith('GRANT SELECT (label_id) ON TABLE public.store_product_label_auxiliary TO ')){trace.reached=true;throw Error('Owned product_label interruption after actual grant');}return result;};
      }});return callback(port);
    },options as Parameters<typeof target.transaction>[1]);
  }});
}
/** A second real LOGIN with the already commissioned Admin credentials. No
 * maintenance SET ROLE, additional grants, or enlarged App catalog DML port. */
async function withAdminConnection<T>(connectionString:string,role:string,run:(peer:SequenceRunnerPeer)=>Promise<T>){
  const client=postgres(connectionString,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,max_lifetime:0,
    connection:{options:'-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=2000'}});
  try{
    const [identity]=await client`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version`;
    expect(identity).toMatchObject({role,session:role});expect(Math.floor(Number(identity.version)/10000)).toBe(16);
    return await run({db:drizzle(client) as unknown as DbClient,pid:Number(identity.pid),exec:async text=>Array.from(await client.unsafe(text))});
  }finally{await client.end({timeout:5});}
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Product label author PG16 current LOGIN profiles, full source and genuine product references',()=>{
 afterEach(()=>vi.restoreAllMocks());
 it('commissions immutable receipts atomically and preserves mature writers, product bindings and exact image authority under contention',async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Product label native forbids outbound I/O'));
  const whole=await refundRuntimeFixture();
  try{
   if(!whole.withRuntimeRole||!whole.withPeer)throw Error('Independent PG16 current App/Admin LOGIN peers required');
   await whole.withRuntimeRole(async app=>whole.withRuntimeRole!(async admin=>{
    const [identity]=await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`),target={database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role};
    await runRuntimeBusinessCommissioning(whole.db,{...target,pricingOwner:whole.pricingOwner});await runAdminHotwordUpgrade(whole.db,target);
    const audit=async()=>({app:await auditRuntimeBusinessPrivileges(app.db,'app',target),admin:await auditRuntimeBusinessPrivileges(admin.db,'admin',target)});
    expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});expect(await inspectAdminHotwordOperation(whole.db,target)).toBe(true);
    await expect(admin.db.transaction(tx=>assertAdminProductLabelOperationReady(tx))).rejects.toMatchObject({code:503});
    const trace={reached:false};await expect(runAdminProductLabelUpgrade(interrupted(whole.db,trace),target)).rejects.toThrow('Owned product_label interruption');expect(trace.reached).toBe(true);
    expect((await whole.db.execute(sql`SELECT to_regclass('public.admin_product_label_operation') IS NULL AS table_absent,to_regprocedure('public.admin_product_label_operation_immutable_v1()') IS NULL AS function_absent`))[0]).toEqual({table_absent:true,function_absent:true});expect(await inspectAdminHotwordOperation(whole.db,target)).toBe(true);
    expect(await runAdminProductLabelUpgrade(whole.db,target)).toEqual({operation:'admin-product-label-operation-v1',applied:true});expect(await inspectAdminProductLabelOperation(whole.db,target)).toBe(true);await admin.db.transaction(tx=>assertAdminProductLabelOperationReady(tx));
    await expect(admin.exec('SELECT label_id FROM public.store_product_label_auxiliary LIMIT 0')).resolves.toBeDefined();
    for(const statement of ['SELECT * FROM public.store_product_label_auxiliary','SELECT id FROM public.store_product_label_auxiliary','SELECT product_id FROM public.store_product_label_auxiliary','UPDATE public.store_product_label_auxiliary SET label_id=1'])await expect(admin.exec(statement)).rejects.toMatchObject({code:'42501'});
    await expect(app.exec('SELECT label_id FROM public.store_product_label_auxiliary LIMIT 0')).rejects.toMatchObject({code:'42501'});
    for(const statement of['SELECT * FROM public.admin_product_label_operation','INSERT INTO public.admin_product_label_operation DEFAULT VALUES',"INSERT INTO public.store_product_label(label_name) VALUES('App cannot author labels')"] )await expect(app.exec(statement)).rejects.toMatchObject({code:'42501'});
    for(const statement of['UPDATE public.admin_product_label_operation SET actor_id=1','DELETE FROM public.admin_product_label_operation','TRUNCATE public.admin_product_label_operation','ALTER TABLE public.admin_product_label_operation ADD COLUMN forbidden integer'])await expect(admin.exec(statement)).rejects.toMatchObject({code:'42501'});
    await expect(whole.db.transaction(async tx=>{await tx.execute(sql.raw('ALTER TABLE public.admin_product_label_operation ADD COLUMN forbidden integer'));expect(await inspectAdminProductLabelOperation(tx,target)).toBe(false);throw Error('Owned label schema rollback');})).rejects.toThrow('Owned label schema rollback');
    await expect(whole.db.transaction(async tx=>{await tx.execute(sql.raw(`GRANT SELECT ON public.admin_product_label_operation TO "${app.role}"`));expect(await inspectAdminProductLabelOperation(tx,target)).toBe(false);throw Error('Owned label ACL rollback');})).rejects.toThrow('Owned label ACL rollback');
    const supplierLabelOwner=`cinashop_runtime_${randomUUID().replaceAll('-','')}`;
    await whole.exec(`CREATE ROLE "${supplierLabelOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    try{await runSupplierProductLabelUpgrade(whole.db,{...target,owner:supplierLabelOwner});
    await withAdminConnection(admin.connectionString,admin.role,async legacy=>{
     const base=991001,group=991041,asset1=901041,asset2=901042,pwd='owned-native-product-label-password',env={APP_KEY:'owned-native-product-label-key'},query=new URLSearchParams();
     await whole.db.insert(systemRole).values({id:900,roleName:'Owned native label writer',rules:'label.manage'});await whole.db.insert(systemAdmin).values([{id:900,account:'owned_native_product_label',pwd,level:1,roles:'900'},{id:901,account:'owned_native_supplier_label',pwd,adminType:4,relationId:7,level:0}]);await whole.db.update(systemSupplier).set({adminId:901}).where(eq(systemSupplier.id,7));
     await whole.db.insert(legacyCategory).values([{id:group,type:0,relationId:0,ownerId:0,group:2,name:'原生平台标签组',sort:1,other:'opaque legacy group',integralMin:7,integralMax:19},{id:group+1,type:2,relationId:7,ownerId:0,group:2,name:'原生供应商标签组'}]);
     await whole.db.insert(storeProductLabel).values([{id:base,labelCate:group,labelName:'原生平台标签',color:'#abc',sort:1},{id:base+1,labelCate:0,labelName:'😀'.repeat(255),styleType:3,color:'red',bgColor:'url(legacy)',borderColor:'legacy-border',icon:'http://legacy.example/label.png',sort:-2147483648,status:7,isShow:5,addTime:-1},{id:base+2,type:2,relationId:7,labelCate:group,labelName:'原生供应商标签',sort:-9},...[10,11,12,20,21,22,30,31,32,33].map(n=>({id:base+n,labelCate:group,labelName:'普通原生标签'+n,styleType:1,status:1,isShow:1}))]);
     await whole.db.insert(systemAttachment).values([asset1,asset2].map(id=>({attId:id,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,name:`attachments/admin/1/2026/10/${id}.png`,attDir:`/api/assets/${id}`,sattDir:`/api/assets/${id}`,attType:'image/png',realName:'原生标签图片'+id})));
     await whole.db.insert(storeProduct).values({id:991081,type:2,relationId:7,storeName:'原生供应商引用商品',isShow:1,isVerify:1,price:'19.99'});
     for(const table of['store_product_label','category','store_product'])await whole.exec(`SELECT setval(pg_get_serial_sequence('public.${table}','id'),(SELECT max(id)+1 FROM public.${table}),false)`);
     const actor={id:900,authVersion:md5(pwd),expiresAt:Math.floor(Date.now()/1000)+3600},supplierActor={...actor,id:901},service=new AdminProductLabelAuthorService(createContainerFromDb(admin.db),env),old=(db:DbClient)=>new AdminProductLabelService(createContainerFromDb(db),env.APP_KEY);
     const intent=async(operation:ProductLabelOperation,target_id:number,payload:Record<string,unknown>={}):Promise<ProductLabelAction>=>{const a={operation_id:crypto.randomUUID(),actor_id:900,operation,target_id,revision:(await service.catalog(query,actor)).revision,payload};return{...a,payload_hash:productLabelActionHash(a)};};
     const raw=(row:ProductLabelRow)=>({label_cate:row.label_cate,label_name:row.label_name,style_type:String(row.style_type),color:row.color,bg_color:row.bg_color,border_color:row.border_color,icon:row.icon,is_show:String(row.is_show),status:String(row.status),sort:String(row.sort)});
     const values=async(id:number,patch:Record<string,unknown>={})=>{const row=(await service.catalog(query,actor)).list.find(row=>row.id===id);if(!row)throw Error('Owned label expected row missing');return{...raw(row),...patch};};
     const label=async(id:number)=>(await whole.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,id)))[0];
     const snapshot=async()=>({labels:await whole.exec('SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.store_product_label t ORDER BY id'),groups:await whole.exec('SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.category t ORDER BY id'),products:await whole.db.select().from(storeProduct).orderBy(storeProduct.id),relations:await whole.db.select().from(storeProductRelation).orderBy(storeProductRelation.id),auxiliary:await whole.db.select().from(storeProductLabelAuxiliary).orderBy(storeProductLabelAuxiliary.id),attachments:await whole.db.select().from(systemAttachment).orderBy(systemAttachment.attId),logs:await whole.db.select().from(systemLog).orderBy(systemLog.id),receipts:await whole.exec('SELECT * FROM public.admin_product_label_operation ORDER BY operation_id')});
     const history=await label(base+1),foreign=await label(base+2),historyVersion=await whole.exec(`SELECT xmin::text AS version FROM store_product_label WHERE id=${base+1}`);expect((await service.mutate(await intent('label-update',base+1,await values(base+1)),actor)).state).toBe('committed');expect(await label(base+1)).toEqual(history);expect(await label(base+2)).toEqual(foreign);expect(await whole.exec(`SELECT xmin::text AS version FROM store_product_label WHERE id=${base+1}`)).toEqual(historyVersion);
     // Only the reserved negative author key participates; positive row IDs do not.
     await whole.withPeer!(async peer=>{await peer.exec('BEGIN');try{await peer.exec('SELECT pg_advisory_xact_lock(731654,1)');expect((await service.mutate(await intent('label-update',base+1,await values(base+1)),actor)).state).toBe('committed');}finally{await peer.exec('ROLLBACK');}});
     const legacyValues=(id:number)=>({label_cate:group,label_name:'旧标签写'+(id-base),style_type:1,color:'#123456',bg_color:'#fff',border_color:'',icon:'',is_show:1,status:1,sort:3});
     const legacyWrite=(db:DbClient,operation:'save'|'status'|'delete',id:number)=>operation==='save'?old(db).save(id,legacyValues(id),actor):operation==='status'?old(db).setFlag(id,0,'status',actor):old(db).deleteLabel(id,actor);
     // Both real Admin services first hold the same authority table barrier.
     // Its NOWAIT conflict is intentional; do not manufacture an advisory wait.
     await whole.exec("CREATE FUNCTION owned_label_legacy_hold() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_label_catalog' THEN PERFORM pg_advisory_xact_lock(731756,40);END IF;RETURN NEW;END$$;CREATE TRIGGER owned_label_legacy_hold BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION owned_label_legacy_hold()");
     try{for(const[index,operation]of(['save','status','delete']as const).entries()){
      const id=base+10+index,a=await intent('label-update',id,await values(id,{label_name:'不能覆盖旧写入'}));
      await whole.withPeer!(async peer=>{await peer.exec('SELECT pg_advisory_lock(731756,40)');const writing=outcome(legacyWrite(legacy.db,operation,id));
       try{await waitFor(peer.exec,`SELECT ${peer.pid}=ANY(pg_blocking_pids(${legacy.pid})) AS waiting`);const before=await snapshot();await expect(service.mutate(a,actor)).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(before);}
       finally{await peer.exec('SELECT pg_advisory_unlock(731756,40)');const result=await writing;if(!result.ok)throw result.error;}
      });
      await expect(service.mutate(a,actor)).rejects.toMatchObject({httpStatus:409});if(operation==='delete')expect(await label(id)).toBeUndefined();else expect(await label(id)).toMatchObject(operation==='save'?{labelName:'旧标签写10'}:{status:0});
     }}finally{await whole.exec('DROP TRIGGER owned_label_legacy_hold ON system_log;DROP FUNCTION owned_label_legacy_hold()');}
     await whole.exec("CREATE FUNCTION owned_label_audit_hold() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_label_catalog' THEN PERFORM pg_advisory_xact_lock(731756,41);END IF;RETURN NEW;END$$;CREATE TRIGGER owned_label_audit_hold BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION owned_label_audit_hold()");
     try{for(const[index,operation]of(['save','status','delete']as const).entries()){
      const id=base+20+index,a=await intent('label-update',id,await values(id,{label_name:'新作者先写'+index}));await whole.withPeer!(async peer=>{await peer.exec('SELECT pg_advisory_lock(731756,41)');const writing=outcome(service.mutate(a,actor));try{await waitFor(peer.exec,`SELECT ${peer.pid}=ANY(pg_blocking_pids(${admin.pid})) AS waiting`);await expect(legacyWrite(legacy.db,operation,id)).rejects.toSatisfy(error=>{for(let i=0;i<8&&error&&typeof error==='object';i++){if('code'in error&&String(error.code)==='55P03')return true;error='cause'in error?error.cause:undefined;}return false;});}finally{await peer.exec('SELECT pg_advisory_unlock(731756,41)');expect((await writing).ok).toBe(true);}});await legacyWrite(legacy.db,operation,id);const before=await snapshot();expect((await service.mutate(a,actor)).state).toBe('committed');expect(await snapshot()).toEqual(before);
     }}finally{await whole.exec('DROP TRIGGER owned_label_audit_hold ON system_log;DROP FUNCTION owned_label_audit_hold()');}
     // The genuine Supplier label writer touches another scope. The author's
     // whole-source table gate refuses that live DML and its later stale CAS.
     const sReady=signal(),sRelease=signal(),beforeSupplier=await intent('label-show',base,{is_show:0});const supplierWriting=outcome(app.db.transaction(async tx=>{await new SupplierProductLabelService(createContainerFromDb(tx as unknown as DbClient)).save(7,base+2,{label_cate:group,label_name:'供应商原生先写'},supplierActor);sReady.resolve();await sRelease.promise;}));
     try{await paused(sReady,supplierWriting);await expect(service.mutate(beforeSupplier,actor)).rejects.toMatchObject({httpStatus:409});}finally{sRelease.resolve();const result=await supplierWriting;if(!result.ok)throw result.error;}await expect(service.mutate(beforeSupplier,actor)).rejects.toMatchObject({httpStatus:409});expect((await label(base+2))!.labelName).toBe('供应商原生先写');
     // A real platform product save holds the label SHARE lock until its outer
     // transaction ends. Physical deletion must not race the subsequent CSV/type3 write.
     const products=new ProductAssociationService(createContainerFromDb(app.db)),productActor={id:900,name:'Owned native product label',ip:'127.0.0.1'},consumerId=base+30,readReady=signal(),readRelease=signal();const toDelete=await intent('label-delete',consumerId);let savedId=0;
     const saving=outcome(app.db.transaction(async tx=>{const result=await new ProductAssociationService(createContainerFromDb(tx as unknown as DbClient)).save(0,{store_name:'真实平台标签消费者',price:19.5,stock:3,store_label_id:[consumerId]},productActor);savedId=result.id;readReady.resolve();await readRelease.promise;}));
     try{await paused(readReady,saving);expect((await whole.exec(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${app.pid} AND relation='public.store_product_label'::regclass AND mode='RowShareLock' AND granted) AS held`))[0]!.held).toBe(true);await expect(service.mutate(toDelete,actor)).rejects.toMatchObject({httpStatus:409});}finally{readRelease.resolve();const result=await saving;if(!result.ok)throw result.error;}
     await expect(service.mutate(await intent('label-delete',consumerId),actor)).rejects.toThrow('引用');expect((await whole.db.select().from(storeProduct).where(eq(storeProduct.id,savedId)))[0]!.storeLabelId).toBe(String(consumerId));expect((await whole.db.select().from(storeProductRelation).where(eq(storeProductRelation.productId,savedId))).some(row=>row.type===3&&row.relationId===consumerId)).toBe(true);
     // The Supplier binding helper is the actual current SELECT/FOR SHARE and
     // whole product/relations readback protocol, not a test-created row lock.
     const supplierLabel=base+31,supReady=signal(),supRelease=signal(),supDelete=await intent('label-delete',supplierLabel);const binding=outcome(app.db.transaction(async tx=>{await assertSupplierProductLabelBindings(tx as unknown as DbClient,7,[supplierLabel]);await replaceSupplierProductLabelBindings(tx as unknown as DbClient,7,991081,[supplierLabel]);supReady.resolve();await supRelease.promise;}));
     try{await paused(supReady,binding);await expect(service.mutate(supDelete,actor)).rejects.toMatchObject({httpStatus:409});}finally{supRelease.resolve();const result=await binding;if(!result.ok)throw result.error;}await expect(service.mutate(await intent('label-delete',supplierLabel),actor)).rejects.toThrow('引用');expect((await whole.db.select().from(storeProduct).where(eq(storeProduct.id,991081)))[0]!.storeLabelId).toBe(String(supplierLabel));
     // Reverse order: pause a genuine delete after its audit INSERT, then run
     // both real consumers. After commit each must reject the absent row and
     // neither may leave a partial product or type3 relation.
     await whole.exec("CREATE FUNCTION owned_label_delete_hold() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_label_catalog' THEN PERFORM pg_advisory_xact_lock(731756,42);END IF;RETURN NEW;END$$;CREATE TRIGGER owned_label_delete_hold BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION owned_label_delete_hold()");
     try{for(const kind of['platform','supplier']as const){const id=kind==='platform'?base+32:base+33,a=await intent('label-delete',id),beforeProducts=await whole.db.select().from(storeProduct).orderBy(storeProduct.id),beforeRelations=await whole.db.select().from(storeProductRelation).orderBy(storeProductRelation.id);await whole.withPeer!(async peer=>{await peer.exec('SELECT pg_advisory_lock(731756,42)');const deleting=outcome(service.mutate(a,actor));let consuming:ReturnType<typeof outcome>|undefined;try{await waitFor(peer.exec,`SELECT ${peer.pid}=ANY(pg_blocking_pids(${admin.pid})) AS waiting`);consuming=outcome<unknown>(kind==='platform'?products.save(0,{store_name:'删除后不应创建半商品',price:10,stock:1,store_label_id:[id]},productActor):app.db.transaction(tx=>replaceSupplierProductLabelBindings(tx as unknown as DbClient,7,991081,[id])));if(kind==='platform')await waitFor(peer.exec,`SELECT ${admin.pid}=ANY(pg_blocking_pids(${app.pid})) AS waiting`);else{const rejected=await consuming;expect(rejected.ok).toBe(false);}}finally{await peer.exec('SELECT pg_advisory_unlock(731756,42)');expect((await deleting).ok).toBe(true);const result=await consuming;expect(result?.ok).toBe(false);}});expect(await whole.db.select().from(storeProduct).orderBy(storeProduct.id)).toEqual(beforeProducts);expect(await whole.db.select().from(storeProductRelation).orderBy(storeProductRelation.id)).toEqual(beforeRelations);expect(await label(id)).toBeUndefined();}}
     finally{await whole.exec('DROP TRIGGER owned_label_delete_hold ON system_log;DROP FUNCTION owned_label_delete_hold()');}
     // Group references in ANY label scope are blockers, even when not visible
     // in the platform catalog. Removing a group never repairs foreign rows.
     await expect(service.mutate(await intent('category-delete',group),actor)).rejects.toThrow('有标签');
     // A real deferred audit trigger introduces a type3 reference after the
     // first delete check. The author must reject the whole transaction rather
     // than commit a dangling consumer relation or an apparent success receipt.
     await whole.exec(`CREATE FUNCTION owned_label_reference_tamper() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_label_catalog' AND NEW.path='product/label/delete' THEN INSERT INTO public.store_product_relation(product_id,type,relation_id) VALUES(70,3,${base+10});END IF;RETURN NEW;END$$;CREATE CONSTRAINT TRIGGER owned_label_reference_tamper AFTER INSERT ON system_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION owned_label_reference_tamper()`);
     try{const a=await intent('label-delete',base+10),before=await snapshot();await expect(service.mutate(a,actor)).rejects.toThrow('引用');expect(await snapshot()).toEqual(before);}
     finally{await whole.exec('DROP TRIGGER owned_label_reference_tamper ON system_log;DROP FUNCTION owned_label_reference_tamper()');}
     const iconChange=await intent('label-update',base,await values(base,{style_type:'2',icon:`/api/assets/${asset1}`}));await whole.withPeer!(async peer=>{await peer.exec('BEGIN');try{await peer.exec(`UPDATE system_attachment SET real_name='uncommitted metadata' WHERE att_id=${asset1}`);const before=await snapshot();await expect(service.mutate(iconChange,actor)).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(before);}finally{await peer.exec('ROLLBACK');}});
     await whole.exec("CREATE FUNCTION owned_label_media_hold() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_label_catalog' THEN PERFORM pg_advisory_xact_lock(731756,43);END IF;RETURN NEW;END$$;CREATE TRIGGER owned_label_media_hold BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION owned_label_media_hold()");
     try{const change=await intent('label-update',base,await values(base,{style_type:'2',icon:`/api/assets/${asset1}`}));await whole.withPeer!(async peer=>{await peer.exec('SELECT pg_advisory_lock(731756,43)');const writing=outcome(service.mutate(change,actor));let metadata:ReturnType<typeof outcome>|undefined;
      try{await waitFor(peer.exec,`SELECT ${peer.pid}=ANY(pg_blocking_pids(${admin.pid})) AS waiting`);metadata=outcome(legacy.db.update(systemAttachment).set({attType:'text/html'}).where(eq(systemAttachment.attId,asset1)));await waitFor(peer.exec,`SELECT ${admin.pid}=ANY(pg_blocking_pids(${legacy.pid})) AS waiting`);}
      finally{await peer.exec('SELECT pg_advisory_unlock(731756,43)');expect((await writing).ok).toBe(true);expect((await metadata)?.ok).toBe(true);}
     });expect((await label(base))!.icon).toBe(`/api/assets/${asset1}`);expect(await publicProductLabelAuthorImages(admin.db,[`/api/assets/${asset1}`])).toEqual(['']);await whole.db.update(systemAttachment).set({attType:'image/png'}).where(eq(systemAttachment.attId,asset1));}
     finally{await whole.exec('DROP TRIGGER owned_label_media_hold ON system_log;DROP FUNCTION owned_label_media_hold()');}
     await whole.exec(`CREATE FUNCTION owned_label_media_tamper() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_label_catalog' THEN UPDATE system_attachment SET att_type='text/html' WHERE att_id=${asset2};END IF;RETURN NEW;END$$;CREATE TRIGGER owned_label_media_tamper AFTER INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION owned_label_media_tamper()`);
     try{const a=await intent('label-update',base,await values(base,{style_type:'2',icon:`/api/assets/${asset2}`})),before=await snapshot();await expect(service.mutate(a,actor)).rejects.toThrow();expect(await snapshot()).toEqual(before);}finally{await whole.exec('DROP TRIGGER owned_label_media_tamper ON system_log;DROP FUNCTION owned_label_media_tamper()');}
     const createAction=await intent('label-create',0,{label_cate:group,label_name:' 原生新图片标签 ',style_type:'2',color:'#abc',bg_color:'',border_color:'',icon:`/api/assets/${asset1}`,is_show:'1',status:'1',sort:'2147483647'}),created=await service.mutate(createAction,actor),createdId=created.result.id;expect(created.result).toMatchObject({created:1,updated:0,deleted:0,protected_ids:[]});expect((await label(createdId))!.icon).toBe(`/api/assets/${asset1}`);const publicRows=await readPublicProductLabelMap(app.db,env.APP_KEY,[createdId]);expect(publicRows.get(createdId)!.icon).toMatch(new RegExp(`^/api/assets/${asset1}\\?expires=\\d{10}&signature=[A-Za-z0-9_-]{43}$`));expect(await publicProductLabelAuthorImages(admin.db,[`/api/assets/${asset1}`])).toEqual([`/api/assets/${asset1}`]);
     await expect(old(legacy.db).save(0,{...legacyValues(createdId),label_name:'原生新图片标签'},actor)).rejects.toThrow('已经存在');const beforeReplay=await snapshot();expect(await service.mutate(createAction,actor)).toEqual(created);expect(await snapshot()).toEqual(beforeReplay);expect(await service.receipt(created.operation_id,query,actor)).toEqual(created);
     const first=created;
     const sealedAction=await intent('label-show',base,{is_show:0});await whole.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,900));expect(await service.receipt(first.operation_id,query,actor)).toEqual(first);const beforeSeal=await whole.db.select().from(storeProductLabel).orderBy(storeProductLabel.id);expect((await service.resolve(sealedAction,actor)).state).toBe('not_applied');expect(await whole.db.select().from(storeProductLabel).orderBy(storeProductLabel.id)).toEqual(beforeSeal);await whole.db.update(systemRole).set({rules:'label.manage'}).where(eq(systemRole.id,900));await expect(service.mutate(sealedAction,actor)).rejects.toMatchObject({httpStatus:409});
     await whole.withPeer!(async peer=>{await peer.exec('BEGIN');try{await peer.exec('SELECT pg_advisory_xact_lock(731654,0)');await expect(runAdminProductLabelUpgrade(whole.db,target)).rejects.toThrow('busy');await expect(admin.db.transaction(tx=>assertAdminProductLabelOperationReady(tx))).rejects.toMatchObject({code:503});}finally{await peer.exec('ROLLBACK');}});
     expect(await runAdminProductLabelUpgrade(whole.db,target)).toEqual({operation:'admin-product-label-operation-v1',applied:false});expect(await inspectAdminProductLabelOperation(whole.db,target)).toBe(true);expect(await inspectAdminHotwordOperation(whole.db,target)).toBe(true);expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});for(const statement of['UPDATE public.admin_product_label_operation SET actor_id=1','DELETE FROM public.admin_product_label_operation','TRUNCATE public.admin_product_label_operation'])await expect(whole.exec(statement)).rejects.toMatchObject({code:'42501'});
    });
    }finally{await whole.exec(`DROP OWNED BY "${supplierLabelOwner}";DROP ROLE "${supplierLabelOwner}"`);}
   }));expect(fetch).not.toHaveBeenCalled();
  }finally{await whole.close();}
 },240000);
});
