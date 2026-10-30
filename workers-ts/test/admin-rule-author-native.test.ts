import {eq,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {createContainerFromDb,type DbClient} from '@/lib/di';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {systemAdmin,systemRole,systemSupplier,storeProductRule,storeProductUnit,storeProduct,storeProductAttr,storeProductAttrValue,storeProductAttrResult,storeProductStockRecord} from '@/models/schema';
import {md5} from '@/utils/jwt';
import {AdminRuleAuthorService} from '@/services/admin/AdminRuleAuthorService';
import {ProductMetadataService,platformMetadataOwner} from '@/services/product/ProductMetadataService';
import {ProductAssociationService} from '@/services/product/ProductAssociationService';
import {SupplierProductRuleService} from '@/services/supplier/SupplierProductRuleService';
import {ruleActionHash} from '@/services/admin/AdminRuleAuthorInput';
import {runAdminRuleUpgrade} from '@/migrations/runAdminRuleUpgrade';
import {runAdminEnsureUpgrade} from '@/migrations/runAdminEnsureUpgrade';
import {assertAdminRuleOperationReady,inspectAdminRuleOperation} from '@/migrations/adminRuleOperation';
import {runRuntimeBusinessCommissioning} from '@/migrations/runRuntimeBusinessCommissioning';
import {auditRuntimeBusinessPrivileges} from '@/migrations/auditRuntimeBusinessPrivileges';
import {refundRuntimeFixture} from './helpers/refundRuntimeFixture';
import type {RuleAction,RuleOperation} from '../../view/common/ruleAuthor';

function interrupted(db:DbClient,trace:{reached:boolean}):DbClient {
 const dialect=new PgDialect();return new Proxy(db,{get(target,key){const method:unknown=Reflect.get(target,key);if(typeof method!=='function')return method;if(key!=='transaction')return method.bind(target);
  return (callback:(tx:Pick<DbClient,'execute'>)=>Promise<unknown>,options:unknown)=>target.transaction(async tx=>{const port=new Proxy(tx,{get(current,property){const member:unknown=Reflect.get(current,property);if(typeof member!=='function')return member;if(property!=='execute')return member.bind(current);return async(query:Parameters<typeof tx.execute>[0])=>{const statement=dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql,result=await tx.execute(query);if(statement.startsWith('GRANT SELECT, INSERT ON TABLE public.admin_rule_operation TO ')){trace.reached=true;throw Error('Owned rule interruption after grant');}return result;};}});return callback(port);},options as Parameters<typeof target.transaction>[1]);
 }});
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
const outcome=<T>(task:Promise<T>)=>task.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
async function waitFor(execute:(text:string)=>Promise<any>,statement:string){for(let i=0;i<120;i++){const [row]=await execute(statement);if(row?.waiting===true)return;await new Promise(done=>setTimeout(done,10));}throw Error('Expected native rule writer blocker was not observed');}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Rule author PG16 actual current App/Admin LOGINs, mature writers and copied SKU lifecycle',()=>{
 afterEach(()=>vi.restoreAllMocks());
 it('commissions atomically, serializes real writers and physically deletes templates without changing copied products',async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Native rule author forbids external I/O'));const whole=await refundRuntimeFixture();
  try{
   if(!whole.withRuntimeRole||!whole.withPeer)throw Error('Independent current PG16 LOGIN peers required');
   await whole.withRuntimeRole(async app=>whole.withRuntimeRole!(async admin=>{
    const [identity]=await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);const target={database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role};
    await runRuntimeBusinessCommissioning(whole.db,{...target,pricingOwner:whole.pricingOwner});
    // Actual already-accepted optional Ensure addon must coexist with the new one.
    await runAdminEnsureUpgrade(whole.db,target);
    const audit=async()=>({app:await auditRuntimeBusinessPrivileges(app.db,'app',target),admin:await auditRuntimeBusinessPrivileges(admin.db,'admin',target)});
    expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    await expect(admin.db.transaction(tx=>assertAdminRuleOperationReady(tx))).rejects.toMatchObject({code:503});
    const trace={reached:false};await expect(runAdminRuleUpgrade(interrupted(whole.db,trace),target)).rejects.toThrow('Owned rule interruption');expect(trace.reached).toBe(true);
    const [absent]=await whole.db.execute(sql`SELECT to_regclass('public.admin_rule_operation') IS NULL AS table_absent,to_regprocedure('public.admin_rule_operation_immutable_v1()') IS NULL AS function_absent`);expect(absent).toEqual({table_absent:true,function_absent:true});
    expect(await runAdminRuleUpgrade(whole.db,target)).toEqual({operation:'admin-rule-operation-v1',applied:true});expect(await inspectAdminRuleOperation(whole.db,target)).toBe(true);
    for(const q of ['SELECT * FROM public.admin_rule_operation','INSERT INTO public.admin_rule_operation DEFAULT VALUES'])await expect(app.exec(q)).rejects.toMatchObject({code:'42501'});
    for(const q of ['UPDATE public.admin_rule_operation SET actor_id=1','DELETE FROM public.admin_rule_operation','TRUNCATE public.admin_rule_operation','ALTER TABLE public.admin_rule_operation ADD COLUMN forbidden integer'])await expect(admin.exec(q)).rejects.toMatchObject({code:'42501'});
    const base=990681,pwd='owned-native-rule-password',spec=[{value:'颜色',detail:['红','蓝']},{value:'尺码',detail:['S','M']}];
    await whole.db.insert(systemRole).values({id:900,roleName:'Owned native rule writer',rules:'product.manage'});
    await whole.db.insert(systemAdmin).values([{id:900,account:'owned_rule',pwd,level:1,roles:'900'},{id:901,account:'owned_supplier_rule',pwd,adminType:4,relationId:7,level:0}]);
    await whole.db.update(systemSupplier).set({adminId:901}).where(eq(systemSupplier.id,7));
    await whole.db.insert(storeProductRule).values([{id:base,ruleName:'原生平台规格',ruleValue:JSON.stringify(spec)},{id:base+1,type:2,relationId:7,ruleName:'原生供应商规格',ruleValue:JSON.stringify(spec)}]);
    await whole.db.insert(storeProductUnit).values({id:990691,name:'规格原生件'});
    for(const table of ['store_product_rule','store_product','store_product_attr_value'])await whole.exec(`SELECT setval(pg_get_serial_sequence('public.${table}','id'),(SELECT max(id)+1 FROM public.${table}),false)`);
    const actor={id:900,authVersion:md5(pwd),expiresAt:Math.floor(Date.now()/1000)+3600},supplierActor={...actor,id:901},query=new URLSearchParams();
    const service=new AdminRuleAuthorService(createContainerFromDb(admin.db));
    const intent=async(operation:RuleOperation,target_id=base,payload:Record<string,unknown>={}):Promise<RuleAction>=>{const a={operation_id:crypto.randomUUID(),actor_id:900,operation,target_id,revision:(await service.catalog(query,actor)).revision,payload};return {...a,payload_hash:ruleActionHash(a)};};
    const core=(db:DbClient)=>new ProductMetadataService(createContainerFromDb(db));
    const supplier=(db:DbClient)=>new SupplierProductRuleService(createContainerFromDb(db));
    const beforeSupplier=(await whole.db.select().from(storeProductRule).where(eq(storeProductRule.id,base+1)))[0];
    // The genuine old platform writer retains731612,0 through its outer commit.
    const a=await intent('update',base,{rule_name:'旧写入之后',mode:'preserve'}),ready=deferred(),release=deferred();
    const oldWriting=outcome(app.db.transaction(async tx=>{await core(tx as unknown as DbClient).saveRule(platformMetadataOwner,base,{rule_name:'成熟核心已写',spec});ready.resolve();await release.promise;}));
    let author:ReturnType<typeof outcome>|undefined;
    try{await Promise.race([ready.promise,oldWriting.then(result=>{if(!result.ok)throw result.error;throw Error('Core writer did not pause');})]);author=outcome(service.mutate(a,actor));await waitFor(whole.exec,`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${admin.pid} AND locktype='advisory' AND classid=731612::oid AND objid=0::oid AND NOT granted) AS waiting`);}
    finally{release.resolve();const old=await oldWriting;if(!old.ok)throw old.error;}
    const authorResult=await author!;expect(authorResult.ok).toBe(false);if(!authorResult.ok)expect(authorResult.error).toMatchObject({httpStatus:409});expect((await whole.db.select().from(storeProductRule).where(eq(storeProductRule.id,base)))[0].ruleName).toBe('成熟核心已写');
    // New author first; mature core and Supplier perform their actual writes afterwards.
    await whole.exec("CREATE FUNCTION owned_rule_audit_hold() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_rule_catalog' THEN PERFORM pg_advisory_xact_lock(731748,11);END IF;RETURN NEW;END$$;CREATE TRIGGER owned_rule_audit_hold BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION owned_rule_audit_hold()");
    try{for(const kind of ['platform','supplier']as const){
     const change=await intent('update',base,{rule_name:'作者先写'+kind,mode:'preserve'});
     await whole.withPeer!(async blocker=>{await blocker.exec('SELECT pg_advisory_lock(731748,11)');const writing=outcome(service.mutate(change,actor));let other:ReturnType<typeof outcome>|undefined;
      try{await waitFor(blocker.exec,`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${admin.pid} AND locktype='advisory' AND classid=731748::oid AND objid=11::oid AND NOT granted) AS waiting`);
       other=outcome<unknown>(kind==='platform'?core(app.db).saveRule(platformMetadataOwner,base,{rule_name:'成熟核心后写',spec}):supplier(app.db).save(7,base+1,{rule_name:'供应商后写',spec},supplierActor));
       await waitFor(blocker.exec,`SELECT ${admin.pid}=ANY(pg_blocking_pids(${app.pid})) AS waiting`);
      }finally{await blocker.exec('SELECT pg_advisory_unlock(731748,11)');const authored=await writing,following=await other;expect(authored.ok).toBe(true);expect(following?.ok).toBe(true);}
      expect((await service.mutate(change,actor)).state).toBe('committed');
     });
    }}finally{await whole.exec('DROP TRIGGER owned_rule_audit_hold ON system_log;DROP FUNCTION owned_rule_audit_hold()');}
    // A real Supplier DML transaction held first is refused by the NOWAIT full-source table gate.
    const beforeSupplierFirst=await intent('update',base,{rule_name:'供应商事务期间',mode:'preserve'}),sReady=deferred(),sRelease=deferred();
    const supplierWriting=outcome(app.db.transaction(async tx=>{await supplier(tx as unknown as DbClient).save(7,base+1,{rule_name:'供应商先写',spec},supplierActor);sReady.resolve();await sRelease.promise;}));
    try{await Promise.race([sReady.promise,supplierWriting.then(result=>{if(!result.ok)throw result.error;throw Error('Supplier writer did not pause');})]);await expect(service.mutate(beforeSupplierFirst,actor)).rejects.toMatchObject({httpStatus:409});}
    finally{sRelease.resolve();const result=await supplierWriting;if(!result.ok)throw result.error;}
    await expect(service.mutate(beforeSupplierFirst,actor)).rejects.toMatchObject({httpStatus:409});
    expect((await whole.db.select().from(storeProductRule).where(eq(storeProductRule.id,base+1)))[0]).toMatchObject({...beforeSupplier,ruleName:'供应商先写'});
    // Actual ProductAssociation copies four SKUs. New author edit/delete cannot mutate them.
    const products=new ProductAssociationService(createContainerFromDb(app.db));const template=(await products.editorOptions()).sku_rule_templates.find(row=>row.id===base)!;expect(template.dimensions).toHaveLength(2);
    const dimensions=structuredClone(template.dimensions),attrs=dimensions[0].detail.flatMap((first,a)=>dimensions[1].detail.map((second,b)=>({suk:`${first},${second}`,detail:{[dimensions[0].value]:first,[dimensions[1].value]:second},price:19.5+a+b,cost:8,ot_price:30,vip_price:17,stock:4+a+b})));
    const body={store_name:'作者原生复制商品',unit_name:'规格原生件',product_type:0,spec_type:1,items:dimensions,attrs,sku_rule_id:base},productActor={id:900,name:'Owned rule copy',ip:'127.0.0.1'};
    const saved=await products.save(0,body,productActor);expect(saved.sku_verified).toBe(true);
    const productSnapshot=async(id:number)=>({row:(await whole.db.select().from(storeProduct).where(eq(storeProduct.id,id)))[0],dimensions:await whole.db.select().from(storeProductAttr).where(eq(storeProductAttr.productId,id)).orderBy(storeProductAttr.id),values:await whole.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId,id)).orderBy(storeProductAttrValue.id),results:await whole.db.select().from(storeProductAttrResult).where(eq(storeProductAttrResult.productId,id)).orderBy(storeProductAttrResult.id),stock:await whole.db.select().from(storeProductStockRecord).where(eq(storeProductStockRecord.productId,id)).orderBy(storeProductStockRecord.id)});
    const copied=await productSnapshot(saved.id);expect(copied.dimensions).toHaveLength(2);expect(copied.values).toHaveLength(4);expect(new Set(copied.values.map(row=>row.unique)).size).toBe(4);
    await service.mutate(await intent('update',base,{rule_name:'明确替换规格',mode:'replace',spec:[{value:'材质',detail:['钢']}]}),actor);expect(await productSnapshot(saved.id)).toEqual(copied);
    await service.mutate(await intent('delete'),actor);expect(await productSnapshot(saved.id)).toEqual(copied);expect(await whole.db.select().from(storeProductRule).where(eq(storeProductRule.id,base))).toEqual([]);
    const later=await products.save(0,{...body,store_name:'删模板后继续保存复制原稿'},productActor);expect(later.sku_verified).toBe(true);const laterCopy=await productSnapshot(later.id);
    expect(laterCopy.values.map(row=>({suk:row.suk,price:row.price,stock:row.stock}))).toEqual(copied.values.map(row=>({suk:row.suk,price:row.price,stock:row.stock})));expect(await productSnapshot(saved.id)).toEqual(copied);
    const unknown=await intent('delete',base+1);await whole.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,900));expect((await service.resolve(unknown,actor)).state).toBe('not_applied');expect((await service.receipt(unknown.operation_id,query,actor)).state).toBe('not_applied');
    await whole.withPeer!(async blocker=>{await blocker.exec('BEGIN');try{await blocker.exec('SELECT pg_advisory_xact_lock(731648,0)');await expect(runAdminRuleUpgrade(whole.db,target)).rejects.toThrow('busy');}finally{await blocker.exec('ROLLBACK');}});
    expect(await runAdminRuleUpgrade(whole.db,target)).toEqual({operation:'admin-rule-operation-v1',applied:false});expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    for(const q of ['UPDATE public.admin_rule_operation SET actor_id=1','DELETE FROM public.admin_rule_operation','TRUNCATE public.admin_rule_operation'])await expect(whole.exec(q)).rejects.toMatchObject({code:'42501'});
   }));expect(fetch).not.toHaveBeenCalled();
  }finally{await whole.close();}
 },180000);
});
