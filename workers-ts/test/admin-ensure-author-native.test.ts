import {eq,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {DbClient} from '@/lib/di';
import {createContainerFromDb} from '@/lib/di';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {systemAdmin,systemRole,storeProductEnsure,storeProduct,storeProductCategory,storeProductRelation} from '@/models/schema';
import {md5} from '@/utils/jwt';
import {AdminEnsureAuthorService} from '@/services/admin/AdminEnsureAuthorService';
import {ProductAssociationService} from '@/services/product/ProductAssociationService';
import {SupplierProductManagementService} from '@/services/supplier/SupplierProductManagementService';
import {ensureActionHash} from '@/services/admin/AdminEnsureAuthorInput';
import {runAdminEnsureUpgrade} from '@/migrations/runAdminEnsureUpgrade';
import {assertAdminEnsureOperationReady,inspectAdminEnsureOperation} from '@/migrations/adminEnsureOperation';
import {runRuntimeBusinessCommissioning} from '@/migrations/runRuntimeBusinessCommissioning';
import {auditRuntimeBusinessPrivileges} from '@/migrations/auditRuntimeBusinessPrivileges';
import {refundRuntimeFixture} from './helpers/refundRuntimeFixture';
import type {EnsureAction,EnsureOperation} from '../../view/common/ensureAuthor';

function interrupted(db:DbClient,trace:{reached:boolean}):DbClient{
  const dialect=new PgDialect();
  return new Proxy(db,{get(target,key){
    const method:unknown=Reflect.get(target,key);if(typeof method!=='function')return method;if(key!=='transaction')return method.bind(target);
    return (callback:(tx:Pick<DbClient,'execute'>)=>Promise<unknown>,options:unknown)=>target.transaction(async tx=>{
      const port=new Proxy(tx,{get(current,property){
        const member:unknown=Reflect.get(current,property);if(typeof member!=='function')return member;if(property!=='execute')return member.bind(current);
        return async(query:Parameters<typeof tx.execute>[0])=>{
          const statement=dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql,result=await tx.execute(query);
          if(statement.startsWith('GRANT SELECT, INSERT ON TABLE public.admin_ensure_operation TO ')){trace.reached=true;throw Error('Owned ensure interruption after grant');}
          return result;
        };
      }});return callback(port);
    },options as Parameters<typeof target.transaction>[1]);
  }});
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
async function waitFor(execute:(text:string)=>Promise<any>,statement:string){
 for(let i=0;i<100;i++){const [row]=await execute(statement);if(row?.waiting===true)return;await new Promise(done=>setTimeout(done,10));}
 throw Error('Expected independent ensure/product blocker was not observed');
}
const outcome=<T>(task:Promise<T>)=>task.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Ensure author PG16 real current LOGIN, physical delete and existing platform/Supplier writers',()=>{
 afterEach(()=>vi.restoreAllMocks());
 it('commissions atomically and serializes both directions against actual assurance binding writers',async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Ensure native forbids external I/O'));
  const whole=await refundRuntimeFixture();
  try{
   if(!whole.withRuntimeRole||!whole.withPeer)throw Error('Independent PG16 LOGIN peers required');
   await whole.withRuntimeRole(async app=>whole.withRuntimeRole!(async admin=>{
    const [identity]=await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
    const target={database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role};
    await runRuntimeBusinessCommissioning(whole.db,{...target,pricingOwner:whole.pricingOwner});
    const audit=async()=>({app:await auditRuntimeBusinessPrivileges(app.db,'app',target),admin:await auditRuntimeBusinessPrivileges(admin.db,'admin',target)});
    expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    await expect(admin.db.transaction(tx=>assertAdminEnsureOperationReady(tx))).rejects.toMatchObject({code:503});
    const trace={reached:false};await expect(runAdminEnsureUpgrade(interrupted(whole.db,trace),target)).rejects.toThrow('Owned ensure interruption');expect(trace.reached).toBe(true);
    const [absent]=await whole.db.execute(sql`SELECT to_regclass('public.admin_ensure_operation') IS NULL AS table_absent,to_regprocedure('public.admin_ensure_operation_immutable_v1()') IS NULL AS function_absent`);expect(absent).toEqual({table_absent:true,function_absent:true});
    expect(await runAdminEnsureUpgrade(whole.db,target)).toEqual({operation:'admin-ensure-operation-v1',applied:true});expect(await inspectAdminEnsureOperation(whole.db,target)).toBe(true);
    await expect(admin.db.transaction(tx=>assertAdminEnsureOperationReady(tx))).resolves.toBeUndefined();
    for(const q of ['SELECT * FROM public.admin_ensure_operation','INSERT INTO public.admin_ensure_operation DEFAULT VALUES'])await expect(app.exec(q)).rejects.toMatchObject({code:'42501'});
    for(const q of ['UPDATE public.admin_ensure_operation SET actor_id=1','DELETE FROM public.admin_ensure_operation','TRUNCATE public.admin_ensure_operation','ALTER TABLE public.admin_ensure_operation ADD COLUMN forbidden integer'])await expect(admin.exec(q)).rejects.toMatchObject({code:'42501'});
    const base=990641,pid=990661,pwd='owned-ensure-native-password';
    await whole.db.insert(systemRole).values([{id:900,roleName:'Owned ensure writer',rules:'product.manage'},{id:901,type:4,relationId:7,roleName:'Owned supplier ensure writer',rules:'supplier.product.manage'}]);
    await whole.db.insert(systemAdmin).values([{id:900,account:'owned_ensure',pwd,level:1,roles:'900',status:1},{id:901,account:'owned_supplier_ensure',pwd,level:1,roles:'901',status:1,adminType:4,relationId:7}]);
    await whole.db.insert(storeProductEnsure).values([0,1,2,3,4].map(n=>({id:base+n,name:`原生保障${n}`,image:'',desc:'历史无图',sort:n})));
    await whole.db.insert(storeProduct).values({id:pid,storeName:'原生平台保障商品',unitName:'件',price:'10.00'});
    await whole.db.insert(storeProductCategory).values({id:990671,cateName:'原生供应商分类',type:2,relationId:7});
    for(const table of ['store_product','store_product_attr_value'])await whole.exec(`SELECT setval(pg_get_serial_sequence('public.${table}','id'),(SELECT max(id)+1 FROM public.${table}),false)`);
    const actor={id:900,authVersion:md5(pwd),expiresAt:Math.floor(Date.now()/1000)+3600},supplierActor={...actor,id:901},query=new URLSearchParams(),productActor={id:900,name:'ensure fixture',ip:'127.0.0.1'};
    const service=new AdminEnsureAuthorService(createContainerFromDb(admin.db),{APP_KEY:'owned-ensure-native-key'});
    const intent=async(operation:EnsureOperation,target_id:number,payload:Record<string,unknown>={}):Promise<EnsureAction>=>{const a={operation_id:crypto.randomUUID(),actor_id:900,operation,target_id,revision:(await service.catalog(query,actor)).revision,payload};return{...a,payload_hash:ensureActionHash(a)};};
    const supplierBody=(id:number)=>({store_name:'原生供应商保障商品',unit_name:'件',ensure_id:[id],cate_id:[990671],slider_image:['https://images.example/ensure.png'],spec_type:0,attrs:[{suk:'默认',image:'https://images.example/ensure.png',price:'10.00',settle_price:'8.00',stock:3}],description:'<p>fixture</p>',freight:1,is_postage:1});
    const platformSave=(db:DbClient,id:number)=>new ProductAssociationService(createContainerFromDb(db)).save(pid,{ensure_id:[id]},productActor);
    const supplierSave=(db:DbClient,id:number)=>new SupplierProductManagementService(createContainerFromDb(db)).saveProduct(7,0,supplierBody(id),supplierActor);
    // First ordering: each unchanged real writer finishes binding in an outer
    // transaction. Its genuine ensure FOR SHARE protects the parent row.
    for(const kind of ['platform','supplier']as const){
     const id=base+(kind==='platform'?0:1),a=await intent('delete',id),ready=deferred(),release=deferred();
     const saving=outcome(app.db.transaction(async tx=>{await (kind==='platform'?platformSave(tx as unknown as DbClient,id):supplierSave(tx as unknown as DbClient,id));ready.resolve();await release.promise;}));
     try{
      await Promise.race([ready.promise,saving.then(result=>{if(!result.ok)throw result.error;throw Error('Real writer did not pause');})]);
      await expect(service.mutate(a,actor)).rejects.toMatchObject({httpStatus:409});
     }finally{release.resolve();const result=await saving;if(!result.ok)throw result.error;}
     await expect(service.mutate(a,actor)).rejects.toThrow('正在使用');
     expect((await whole.db.select().from(storeProductEnsure).where(eq(storeProductEnsure.id,id)))[0]).toBeDefined();
     const bindings=await whole.db.select().from(storeProductRelation).where(eq(storeProductRelation.relationId,id));expect(bindings.some(row=>row.type===5)).toBe(true);
    }
    // Reverse ordering: hold the normal author audit after physical deletion.
    // Platform waits, then refuses the missing ensure. Supplier uses NOWAIT.
    await whole.exec(`CREATE FUNCTION owned_ensure_audit_hold() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_ensure_catalog' THEN PERFORM pg_advisory_xact_lock(731741,1);END IF;RETURN NEW;END$$;CREATE TRIGGER owned_ensure_audit_hold BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION owned_ensure_audit_hold()`);
    try{for(const kind of ['platform','supplier']as const){
     const id=base+(kind==='platform'?2:3),a=await intent('delete',id);
     await whole.withPeer!(async blocker=>{
      await blocker.exec('SELECT pg_advisory_lock(731741,1)');const author=outcome(service.mutate(a,actor));let writing:ReturnType<typeof outcome>|undefined;
      try{
       await waitFor(blocker.exec,`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${admin.pid} AND locktype='advisory' AND classid=731741::oid AND objid=1::oid AND NOT granted) AS waiting`);
       writing=outcome<unknown>(kind==='platform'?platformSave(app.db,id):supplierSave(app.db,id));
       if(kind==='platform')await waitFor(blocker.exec,`SELECT ${admin.pid}=ANY(pg_blocking_pids(${app.pid})) AS waiting`);
       else{const result=await writing;expect(result.ok).toBe(false);}
      }finally{await blocker.exec('SELECT pg_advisory_unlock(731741,1)');const written=await writing,authored=await author;expect(authored.ok).toBe(true);expect(written?.ok).toBe(false);}
     });
     expect((await whole.db.select().from(storeProductEnsure).where(eq(storeProductEnsure.id,id)))[0]).toBeUndefined();
     expect(await whole.db.select().from(storeProductRelation).where(eq(storeProductRelation.relationId,id))).toEqual([]);
    }}finally{await whole.exec('DROP TRIGGER owned_ensure_audit_hold ON system_log;DROP FUNCTION owned_ensure_audit_hold()');}
    // Display count excludes relation-only bindings, physical deletion does not.
    await whole.db.insert(storeProductRelation).values({productId:999999,type:5,relationId:base+4,status:0});
    expect((await service.catalog(query,actor)).list.find(row=>row.id===base+4)?.product_count).toBe(0);
    await expect(service.mutate(await intent('delete',base+4),actor)).rejects.toThrow('正在使用');
    const change=await intent('status',base,{status:0}),receipt=await service.mutate(change,actor);expect(await service.mutate(change,actor)).toEqual(receipt);
    const unknown=await intent('delete',base+4);await whole.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,900));
    expect((await service.resolve(unknown,actor)).state).toBe('not_applied');expect((await service.receipt(unknown.operation_id,query,actor)).state).toBe('not_applied');
    await whole.db.update(systemRole).set({rules:'product.manage'}).where(eq(systemRole.id,900));await expect(service.mutate(unknown,actor)).rejects.toMatchObject({httpStatus:409});
    await whole.withPeer!(async blocker=>{await blocker.exec('BEGIN');try{await blocker.exec('SELECT pg_advisory_xact_lock(731626,23)');await expect(runAdminEnsureUpgrade(whole.db,target)).rejects.toThrow('busy');}finally{await blocker.exec('ROLLBACK');}});
    expect(await runAdminEnsureUpgrade(whole.db,target)).toEqual({operation:'admin-ensure-operation-v1',applied:false});expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    for(const q of ['UPDATE public.admin_ensure_operation SET actor_id=1','DELETE FROM public.admin_ensure_operation','TRUNCATE public.admin_ensure_operation'])await expect(whole.exec(q)).rejects.toMatchObject({code:'42501'});
   }));expect(fetch).not.toHaveBeenCalled();
  }finally{await whole.close();}
 },180000);
});
