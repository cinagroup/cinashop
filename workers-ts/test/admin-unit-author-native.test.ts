import {eq,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {DbClient} from '@/lib/di';
import {createContainerFromDb} from '@/lib/di';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {systemAdmin,systemRole,storeProductUnit,storeProduct,storeProductCategory,storeProductAttrValue} from '@/models/schema';
import {md5} from '@/utils/jwt';
import {AdminUnitAuthorService} from '@/services/admin/AdminUnitAuthorService';
import {ProductAssociationService} from '@/services/product/ProductAssociationService';
import {SupplierProductManagementService} from '@/services/supplier/SupplierProductManagementService';
import {unitActionHash} from '@/services/admin/AdminUnitAuthorInput';
import {runAdminUnitUpgrade} from '@/migrations/runAdminUnitUpgrade';
import {assertAdminUnitOperationReady,inspectAdminUnitOperation} from '@/migrations/adminUnitOperation';
import {runRuntimeBusinessCommissioning} from '@/migrations/runRuntimeBusinessCommissioning';
import {auditRuntimeBusinessPrivileges} from '@/migrations/auditRuntimeBusinessPrivileges';
import {refundRuntimeFixture} from './helpers/refundRuntimeFixture';
import type {UnitAction,UnitOperation} from '../../view/common/unitAuthor';

function interrupted(db:DbClient,trace:{reached:boolean}):DbClient{
  const dialect=new PgDialect();
  return new Proxy(db,{get(target,key){
    const method:unknown=Reflect.get(target,key);if(typeof method!=='function')return method;if(key!=='transaction')return method.bind(target);
    return (callback:(tx:Pick<DbClient,'execute'>)=>Promise<unknown>,options:unknown)=>target.transaction(async tx=>{
      const port=new Proxy(tx,{get(current,property){
        const member:unknown=Reflect.get(current,property);if(typeof member!=='function')return member;if(property!=='execute')return member.bind(current);
        return async(query:Parameters<typeof tx.execute>[0])=>{
          const statement=dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql,result=await tx.execute(query);
          if(statement.startsWith('GRANT SELECT, INSERT ON TABLE public.admin_unit_operation TO ')){trace.reached=true;throw Error('Owned unit interruption after grant');}
          return result;
        };
      }});return callback(port);
    },options as Parameters<typeof target.transaction>[1]);
  }});
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
async function waitFor(execute:(text:string)=>Promise<any>,statement:string){
 for(let i=0;i<100;i++){const [row]=await execute(statement);if(row?.waiting===true)return;await new Promise(done=>setTimeout(done,10));}
 throw Error('Expected independent unit/product blocker was not observed');
}
const outcome=<T>(task:Promise<T>)=>task.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('unit author native PG16 independent current LOGIN and actual product writers',()=>{
 afterEach(()=>vi.restoreAllMocks());
 it('commissions atomically and synchronizes new author with real platform/Supplier saves and free-text history',async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unit native forbids provider I/O'));
  const whole=await refundRuntimeFixture();
  try{
   if(!whole.withRuntimeRole||!whole.withPeer)throw Error('Independent PG16 LOGIN and maintenance peers required');
   await whole.withRuntimeRole(async app=>whole.withRuntimeRole!(async admin=>{
    const [identity]=await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
    const target={database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role};
    await runRuntimeBusinessCommissioning(whole.db,{...target,pricingOwner:whole.pricingOwner});
    const audit=async()=>({app:await auditRuntimeBusinessPrivileges(app.db,'app',target),admin:await auditRuntimeBusinessPrivileges(admin.db,'admin',target)});
    expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    await expect(admin.db.transaction(tx=>assertAdminUnitOperationReady(tx))).rejects.toMatchObject({code:503});
    const trace={reached:false};await expect(runAdminUnitUpgrade(interrupted(whole.db,trace),target)).rejects.toThrow('Owned unit interruption');expect(trace.reached).toBe(true);
    const [absent]=await whole.db.execute(sql`SELECT to_regclass('public.admin_unit_operation') IS NULL AS table_absent,to_regprocedure('public.admin_unit_operation_immutable_v1()') IS NULL AS function_absent`);expect(absent).toEqual({table_absent:true,function_absent:true});
    expect(await runAdminUnitUpgrade(whole.db,target)).toEqual({operation:'admin-unit-operation-v1',applied:true});expect(await inspectAdminUnitOperation(whole.db,target)).toBe(true);
    await expect(admin.db.transaction(tx=>assertAdminUnitOperationReady(tx))).resolves.toBeUndefined();
    for(const q of ['SELECT * FROM public.admin_unit_operation','INSERT INTO public.admin_unit_operation DEFAULT VALUES'])await expect(app.exec(q)).rejects.toMatchObject({code:'42501'});
    for(const q of ['UPDATE public.admin_unit_operation SET actor_id=1','DELETE FROM public.admin_unit_operation','TRUNCATE public.admin_unit_operation','ALTER TABLE public.admin_unit_operation ADD COLUMN forbidden integer'])await expect(admin.exec(q)).rejects.toMatchObject({code:'42501'});
    const id=990641,pid=990661,pwd='owned-unit-native-password';
    await whole.db.insert(systemRole).values({id:900,roleName:'Owned unit writer',rules:'product.manage'});
    await whole.db.insert(systemAdmin).values({id:900,account:'owned_unit',pwd,level:1,roles:'900',status:1});
    await whole.db.insert(storeProductUnit).values([{id,name:'原生待引用箱',sort:11},{id:id+1,name:'原生先删除箱',sort:-9},{id:id+2,name:'供应商真实箱',sort:3}]);
    await whole.db.insert(storeProduct).values({id:pid,storeName:'原生平台商品',unitName:'原自由文本',price:'10.00'});
    await whole.db.insert(storeProductCategory).values({id:990671,cateName:'原生供应商分类',type:2,relationId:7});
    // This owned migration fixture inserts product/SKU ids explicitly. Align
    // its real default allocators before business/invariant baselines; do not
    // weaken product-save validation or grant new runtime capabilities.
    for(const table of ['store_product','store_product_attr_value'])await whole.exec(`SELECT setval(pg_get_serial_sequence('public.${table}','id'),(SELECT max(id)+1 FROM public.${table}),false)`);
    const actor={id:900,authVersion:md5(pwd),expiresAt:Math.floor(Date.now()/1000)+3600},query=new URLSearchParams(),productActor={id:900,name:'unit fixture',ip:'127.0.0.1'};
    const service=new AdminUnitAuthorService(createContainerFromDb(admin.db));
    const intent=async(operation:UnitOperation,target_id:number,payload:Record<string,unknown>={}):Promise<UnitAction>=>{const a={operation_id:crypto.randomUUID(),actor_id:900,operation,target_id,revision:(await service.catalog(query,actor)).revision,payload};return{...a,payload_hash:unitActionHash(a)};};
    const snapshot=async()=>({units:await whole.db.select().from(storeProductUnit).orderBy(storeProductUnit.id),products:await whole.db.select().from(storeProduct).orderBy(storeProduct.id),
     logs:Array.from(await whole.db.execute(sql`SELECT * FROM public.system_log ORDER BY id`)),receipts:Array.from(await whole.db.execute(sql`SELECT * FROM public.admin_unit_operation ORDER BY operation_id`))});
    // Hold the unchanged real platform save in its outer transaction. The new
    // author must wait on that actual backend's lifecycle fence and then see it.
    const deletion=await intent('delete',id),ready=deferred(),release=deferred();
    const productSave=outcome(app.db.transaction(async tx=>{await new ProductAssociationService(createContainerFromDb(tx as unknown as DbClient)).save(pid,{unit_name:'原生待引用箱'},productActor);ready.resolve();await release.promise;}));
    await Promise.race([ready.promise,productSave.then(result=>{if(!result.ok)throw result.error;throw Error('Platform save did not pause');})]);
    const removal=outcome(service.mutate(deletion,actor));
    let saved:Awaited<typeof productSave>|undefined,deleted:Awaited<typeof removal>|undefined;
    try{await waitFor(whole.exec,`SELECT ${app.pid}=ANY(pg_blocking_pids(${admin.pid})) AS waiting`);}
    finally{release.resolve();[saved,deleted]=await Promise.all([productSave,removal]);}
    expect(saved?.ok).toBe(true);expect(deleted?.ok).toBe(false);if(deleted&&!deleted.ok)expect(String(deleted.error)).toContain('正在使用');
    expect((await whole.db.select().from(storeProductUnit).where(eq(storeProductUnit.id,id)))[0]!.isDel).toBe(0);
    expect((await whole.db.select().from(storeProduct).where(eq(storeProduct.id,pid)))[0]!.unitName).toBe('原生待引用箱');
    // Same real Supplier full save/SKU writer; do not replace it with a manual
    // advisory lock or use a maintenance identity for the business call.
    const supplierDeletion=await intent('delete',id+2),supplierReady=deferred(),supplierRelease=deferred();
    const supplierSave=outcome(app.db.transaction(async tx=>{
     await new SupplierProductManagementService(createContainerFromDb(tx as unknown as DbClient)).saveProduct(7,0,{
      store_name:'原生供应商产品',unit_name:'供应商真实箱',cate_id:[990671],slider_image:['https://images.example/unit.png'],spec_type:0,
      attrs:[{suk:'默认',image:'https://images.example/unit.png',price:'10.00',settle_price:'8.00',stock:3}],description:'<p>fixture</p>',freight:1,is_postage:1,
     });supplierReady.resolve();await supplierRelease.promise;
    }));
    await Promise.race([supplierReady.promise,supplierSave.then(result=>{if(!result.ok)throw result.error;throw Error('Supplier save did not pause');})]);
    const supplierRemoval=outcome(service.mutate(supplierDeletion,actor));
    let supplierSaved:Awaited<typeof supplierSave>|undefined,supplierDeleted:Awaited<typeof supplierRemoval>|undefined;
    try{await waitFor(whole.exec,`SELECT ${app.pid}=ANY(pg_blocking_pids(${admin.pid})) AS waiting`);}
    finally{supplierRelease.resolve();[supplierSaved,supplierDeleted]=await Promise.all([supplierSave,supplierRemoval]);}
    expect(supplierSaved?.ok).toBe(true);expect(supplierDeleted?.ok).toBe(false);if(supplierDeleted&&!supplierDeleted.ok)expect(String(supplierDeleted.error)).toContain('正在使用');
    const [supplierProduct]=await whole.db.select().from(storeProduct).where(eq(storeProduct.unitName,'供应商真实箱'));expect(supplierProduct).toMatchObject({type:2,relationId:7});
    expect(await whole.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId,supplierProduct!.id))).toHaveLength(1);
    // Reverse order: author holds its normal audit, real platform save blocks,
    // soft deletion commits first, then historical free text remains legal.
    const second=await intent('delete',id+1);
    await whole.exec(`CREATE FUNCTION owned_unit_audit_hold() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_unit_catalog' AND (NEW.action::jsonb->>'id')::integer=${id+1} THEN PERFORM pg_advisory_xact_lock(731740,1);END IF;RETURN NEW;END$$;CREATE TRIGGER owned_unit_audit_hold BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION owned_unit_audit_hold()`);
    try{await whole.withPeer!(async blocker=>{
     await blocker.exec('SELECT pg_advisory_lock(731740,1)');const author=outcome(service.mutate(second,actor));let product:ReturnType<typeof outcome>|undefined;
     try{
      await waitFor(blocker.exec,`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${admin.pid} AND locktype='advisory' AND classid=731740::oid AND objid=1::oid AND NOT granted) AS waiting`);
      product=outcome(new ProductAssociationService(createContainerFromDb(app.db)).save(pid,{unit_name:'原生先删除箱'},productActor));
      await waitFor(blocker.exec,`SELECT ${admin.pid}=ANY(pg_blocking_pids(${app.pid})) AS waiting`);
     }finally{await blocker.exec('SELECT pg_advisory_unlock(731740,1)');const results=await Promise.all([author,product??Promise.resolve({ok:false,error:Error('Writer never started')})]);for(const result of results){if(!result.ok)throw result.error;}}
    });}finally{await whole.exec('DROP TRIGGER owned_unit_audit_hold ON system_log;DROP FUNCTION owned_unit_audit_hold()');}
    expect((await whole.db.select().from(storeProductUnit).where(eq(storeProductUnit.id,id+1)))[0]).toMatchObject({isDel:1,name:'原生先删除箱',sort:-9});
    expect((await whole.db.select().from(storeProduct).where(eq(storeProduct.id,pid)))[0]!.unitName).toBe('原生先删除箱');
    const update=await intent('update',id,{name:'原生待引用箱',sort:19}),receipt=await service.mutate(update,actor),stable=await snapshot();expect(await service.mutate(update,actor)).toEqual(receipt);expect(await snapshot()).toEqual(stable);
    const unknown=await intent('create',0,{name:'原生封存箱',sort:0});await whole.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,900));
    expect((await service.resolve(unknown,actor)).state).toBe('not_applied');expect((await service.receipt(unknown.operation_id,query,actor)).state).toBe('not_applied');
    await whole.db.update(systemRole).set({rules:'product.manage'}).where(eq(systemRole.id,900));await expect(service.mutate(unknown,actor)).rejects.toMatchObject({httpStatus:409});
    await whole.withPeer!(async blocker=>{await blocker.exec('BEGIN');try{await blocker.exec('SELECT pg_advisory_xact_lock(731626,22)');await expect(runAdminUnitUpgrade(whole.db,target)).rejects.toThrow('busy');}finally{await blocker.exec('ROLLBACK');}});
    expect(await runAdminUnitUpgrade(whole.db,target)).toEqual({operation:'admin-unit-operation-v1',applied:false});expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    for(const q of ['UPDATE public.admin_unit_operation SET actor_id=1','DELETE FROM public.admin_unit_operation','TRUNCATE public.admin_unit_operation'])await expect(whole.exec(q)).rejects.toMatchObject({code:'42501'});
   }));expect(fetch).not.toHaveBeenCalled();
  }finally{await whole.close();}
 },180000);
});
