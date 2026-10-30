import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {createContainerFromDb,type DbClient} from '@/lib/di';
import {systemAdmin,systemRole,systemLog,storeProduct,storeProductUnit} from '@/models/schema';
import {AdminUnitAuthorService} from '@/services/admin/AdminUnitAuthorService';
import {AdminProductUnitService} from '@/services/admin/AdminProductUnitService';
import {unitActionHash} from '@/services/admin/AdminUnitAuthorInput';
import {unitActor,seedUnits} from './helpers/adminProductUnits';
import {createAdminUnitAuthorFixture} from './helpers/adminUnitAuthorFixture';
import {md5} from '@/utils/jwt';
import type {UnitAction,UnitOperation} from '../../view/common/unitAuthor';

describe('recoverable platform unit author, complete private source and actual SQL privileges',()=>{
 let f:Awaited<ReturnType<typeof createAdminUnitAuthorFixture>>,service:AdminUnitAuthorService;
 beforeAll(async()=>{
  f=await createAdminUnitAuthorFixture();service=new AdminUnitAuthorService(f.container);
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unit author forbids provider requests'));
 },30000);
 beforeEach(async()=>{await f.reset();await seedUnits(f.db);await f.exec("SELECT setval('public.store_product_unit_id_seq',100,false)");});
 afterAll(async()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();await f?.close();},30000);
 const catalog=(id=101)=>f.asAdmin(()=>service.catalog(new URLSearchParams(),unitActor(id)));
 async function intent(operation:UnitOperation,target_id=3,payload:Record<string,unknown>={},actor_id=101):Promise<UnitAction>{
  const original={operation_id:crypto.randomUUID(),actor_id,operation,target_id,revision:(await catalog()).revision,payload};
  return {...original,payload_hash:unitActionHash(original)};
 }
 const mutate=(a:UnitAction)=>f.asAdmin(()=>service.mutate(a,unitActor(a.actor_id)));
 async function snapshot(){return {units:await f.db.select().from(storeProductUnit).orderBy(storeProductUnit.id),products:await f.db.select().from(storeProduct).orderBy(storeProduct.id),
  logs:await f.db.select().from(systemLog).orderBy(systemLog.id),receipts:Array.from(await f.db.execute(sql`SELECT * FROM admin_unit_operation ORDER BY operation_id`))};}
 async function unchanged(run:()=>Promise<unknown>){const before=await snapshot();try{return await run();}finally{expect(await snapshot()).toEqual(before);}}
 it('returns only complete active platform snake-case rows and keeps all other scopes private',()=>unchanged(async()=>{
  const result=await catalog(105);expect(result).toMatchObject({count:3,write_ready:true,can_create:true,list:[{id:2,name:'箱'},{id:1,name:'件'},{id:3,name:'套餐'}]});
  for(const row of result.list)expect(Object.keys(row)).toEqual(['id','type','relation_id','name','sort','status','is_del','add_time']);
  expect(result.revision).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(result)).not.toMatch(/rowVersion|供应商私有|异常平台|隐藏|旧删除|unit-101|pwd/);
 }));
 it('creates normalized15-emoji names, sorts and soft-deletes with original log methods and no product DML',async()=>{
  const products=(await snapshot()).products,create=await intent('create',0,{name:'  '+'😀'.repeat(15)+'  ',sort:32767});
  const made=await mutate(create);expect(made.result).toMatchObject({id:100,created:1,updated:0,count:4});
  const old=(await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.id,100)))[0]!;
  expect(old).toMatchObject({name:'😀'.repeat(15),sort:32767,type:0,relationId:0,status:1,isDel:0});
  expect(made.payload_hash).toBe(create.payload_hash);
  await mutate(await intent('update',100,{name:'新单位',sort:2}));const edited=(await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.id,100)))[0]!;
  expect(edited).toEqual({...old,name:'新单位',sort:2});await mutate(await intent('delete',100));
  expect((await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.id,100)))[0]).toEqual({...edited,isDel:1});
  expect((await snapshot()).products).toEqual(products);expect((await snapshot()).logs.map(x=>x.method)).toEqual(['POST','PUT','DELETE']);
 });
 it('keeps existing legacy CRUD and the15-Unicode contract executable alongside recoverable authoring',async()=>{
  const old=new AdminProductUnitService(f.container);const created=await f.asAdmin(()=>old.save(0,{name:'😀'.repeat(15),sort:0},unitActor()));
  const source=await catalog();expect(source.list.find(x=>x.id===created.id)?.name).toBe('😀'.repeat(15));
  await mutate(await intent('update',created.id,{name:'新作者调整',sort:10}));
  expect(await f.asAdmin(()=>old.detail(created.id,new URLSearchParams(),unitActor()))).toMatchObject({name:'新作者调整',sort:10});
 });
 for(const name of ['', ' ', 'x'.repeat(16), '😀'.repeat(16), 'x\n', 'x\u0085', 'x\ud800', 'x\udfff'])it('rejects invalid new/changed name atomically '+JSON.stringify(name),async()=>{
  await unchanged(async()=>expect(mutate(await intent('create',0,{name,sort:0}))).rejects.toThrow());
  await unchanged(async()=>expect(mutate(await intent('update',3,{name,sort:0}))).rejects.toThrow());
 });
 for(const name of ['', ' 历史空白 ', '旧\u0085名', '😀'.repeat(50)])it('preserves exact historical varchar50 name and xmin on an unchanged save '+JSON.stringify(name),async()=>{
  await f.db.update(storeProductUnit).set({name,sort:-32768}).where(eq(storeProductUnit.id,3));const before=await catalog();
  await mutate(await intent('update',3,{name,sort:-32768}));expect((await catalog()).revision).toBe(before.revision);
  expect((await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.id,3)))[0]).toMatchObject({name,sort:-32768});
  await mutate(await intent('update',3,{name:'明确修改',sort:0}));
 });
 it('preserves negative history per field while rejecting a new negative sort',async()=>{
  await f.db.update(storeProductUnit).set({sort:-5}).where(eq(storeProductUnit.id,3));
  await mutate(await intent('update',3,{name:'改名保留负排序',sort:-5}));
  await unchanged(async()=>expect(mutate(await intent('update',3,{name:'改名保留负排序',sort:-6}))).rejects.toThrow());
  await unchanged(async()=>expect(mutate(await intent('create',0,{name:'新负排序',sort:-5}))).rejects.toThrow());
  await mutate(await intent('update',3,{name:'改名保留负排序',sort:32767}));
 });
 for(const sort of ['0','01','1e2',1.5,NaN,Infinity,-32769,32768,null,true])it('rejects non-integer or out-of-smallint sort '+String(sort),async()=>{
  // Deliberately sign raw JSON rather than normalizing it through the input helper.
  const valid=await intent('update',3,{name:'套餐',sort:0}),action={...valid,payload:{name:'套餐',sort}};
  await unchanged(()=>expect(mutate(action)).rejects.toThrow());
 });
 for(const extra of [{id:1},{status:0},{type:2},{relation_id:20},{is_del:1},{add_time:5},{image:'x'}])it('rejects hidden fields in the two-field payload '+JSON.stringify(extra),async()=>{
  const a=await intent('update',3,{name:'套餐',sort:0});await unchanged(()=>expect(mutate({...a,payload:{...a.payload,...extra}})).rejects.toThrow());
 });
 for(const target of [4,5,6,7,999])it('refuses hidden/deleted/foreign targets '+target,async()=>{
  for(const op of ['update','delete']as const)await unchanged(async()=>expect(mutate(await intent(op,target,op==='delete'?{}:{name:'越界',sort:0}))).rejects.toThrow('不存在'));
 });
 it('scopes duplicate checks to platform nondeleted rows including disabled units, allowing unchanged duplicates',async()=>{
  for(const name of ['件','隐藏'])await unchanged(async()=>expect(mutate(await intent('create',0,{name,sort:0}))).rejects.toThrow('已经存在'));
  await mutate(await intent('create',0,{name:'旧删除',sort:0}));await mutate(await intent('create',0,{name:'供应商私有',sort:0}));
  await f.db.update(storeProductUnit).set({name:'件'}).where(eq(storeProductUnit.id,3));await mutate(await intent('update',3,{name:'件',sort:10}));
 });
 it('blocks rename/delete for any live product scope, allows sort and ignores deleted product references',async()=>{
  await f.db.insert(storeProduct).values([{id:80,type:2,relationId:20,unitName:'套餐'},{id:81,type:0,relationId:99,unitName:'套餐'}]);
  const products=(await snapshot()).products;
  await unchanged(async()=>expect(mutate(await intent('update',3,{name:'改名',sort:0}))).rejects.toThrow('正在使用'));
  await unchanged(async()=>expect(mutate(await intent('delete',3))).rejects.toThrow('正在使用'));
  await mutate(await intent('update',3,{name:'套餐',sort:11}));expect((await snapshot()).products).toEqual(products);
  await f.db.update(storeProduct).set({isDel:1});await mutate(await intent('delete',3));
 });
 for(const target of [3,4,5,6,7])it('private full-source xmin catches restored ABA in visible/hidden/foreign row '+target,async()=>{
  const action=await intent('delete'),old=(await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.id,target)))[0]!;
  await f.db.update(storeProductUnit).set({name:'ABA'}).where(eq(storeProductUnit.id,target));await f.db.update(storeProductUnit).set({name:old.name}).where(eq(storeProductUnit.id,target));
  await unchanged(()=>expect(mutate(action)).rejects.toMatchObject({httpStatus:409}));
 });
 it('replays exact UUID before stale source and without duplicate audit, rejects changed original content',async()=>{
  const a=await intent('update',3,{name:'原请求',sort:11}),receipt=await mutate(a);await f.db.update(storeProductUnit).set({sort:21}).where(eq(storeProductUnit.id,6));
  await unchanged(async()=>{expect(await mutate(a)).toEqual(receipt);expect(await f.asAdmin(()=>service.receipt(a.operation_id,new URLSearchParams(),unitActor()))).toEqual(receipt);});
  const changed={...a,payload:{name:'不同内容',sort:11}};changed.payload_hash=unitActionHash(changed);await unchanged(()=>expect(mutate(changed)).rejects.toThrow('标识'));
 });
 it('keeps missing404 unknown, seals exact not_applied and refuses late original commit',async()=>{
  const a=await intent('delete');await unchanged(()=>expect(f.asAdmin(()=>service.receipt(a.operation_id,new URLSearchParams(),unitActor()))).rejects.toMatchObject({code:404}));
  const receipt=await f.asAdmin(()=>service.resolve(a,unitActor()));expect(receipt).toMatchObject({state:'not_applied',result:{id:3,created:0,updated:0,count:0,revision:a.revision}});
  await unchanged(async()=>{expect(await f.asAdmin(()=>service.resolve(a,unitActor()))).toEqual(receipt);await expect(mutate(a)).rejects.toThrow('封存');});
 });
 for(const id of [102,103,105])it('does not promote view/unrelated/exact1349 page-only actor '+id+' to writer',async()=>{
  await unchanged(async()=>expect(mutate(await intent('delete',3,{},id))).rejects.toThrow());
 });
 it('allows still-valid original owner recovery after all role grants disappear without new commits',async()=>{
  const a=await intent('delete');await f.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,1));
  await unchanged(()=>expect(mutate(a)).rejects.toThrow());const receipt=await f.asAdmin(()=>service.resolve(a,unitActor()));expect(receipt.state).toBe('not_applied');
  expect(await f.asAdmin(()=>service.receipt(a.operation_id,new URLSearchParams(),unitActor()))).toEqual(receipt);
  await unchanged(()=>expect(f.asAdmin(()=>service.receipt(a.operation_id,new URLSearchParams(),unitActor(100)))).rejects.toMatchObject({code:404}));
 });
 for(const patch of [{status:0},{isDel:1},{adminType:4},{relationId:20},{pwd:'changed'}])it('rejects invalidated owner recovery '+JSON.stringify(patch),async()=>{
  const a=await intent('delete');await f.db.update(systemAdmin).set(patch).where(eq(systemAdmin.id,101));await unchanged(()=>expect(f.asAdmin(()=>service.resolve(a,unitActor()))).rejects.toThrow());
 });
 it('checks owner session expiry and credential fingerprint during recovery',async()=>{
  const a=await intent('delete');for(const actor of [{...unitActor(),expiresAt:1},{...unitActor(),authVersion:md5('changed')}])await unchanged(()=>expect(f.asAdmin(()=>service.resolve(a,actor))).rejects.toThrow());
 });
 for(const body of ["NEW.type=2;", "NEW.relation_id=77;", "NEW.status=0;", "NEW.add_time=42;", "IF NEW.id=3 THEN UPDATE store_product_unit SET name='forged foreign' WHERE id=6;END IF;"])it('complete8-column/all-scope readback rolls back successful-looking trigger '+body,async()=>{
  await f.exec(`CREATE FUNCTION owned_unit_change() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ${body} RETURN NEW;END$$;CREATE TRIGGER owned_unit_change BEFORE UPDATE ON store_product_unit FOR EACH ROW EXECUTE FUNCTION owned_unit_change()`);
  try{await unchanged(async()=>expect(mutate(await intent('update',3,{name:'目标新名',sort:2}))).rejects.toThrow('回读'));}
  finally{await f.exec('DROP TRIGGER owned_unit_change ON store_product_unit;DROP FUNCTION owned_unit_change()');}
 });
 it('rolls back skipped softdelete and corrupted insert return values',async()=>{
  await f.exec("CREATE FUNCTION owned_unit_skip() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$;CREATE TRIGGER owned_unit_skip BEFORE UPDATE ON store_product_unit FOR EACH ROW EXECUTE FUNCTION owned_unit_skip()");
  try{await unchanged(async()=>expect(mutate(await intent('delete'))).rejects.toThrow('回读'));}finally{await f.exec('DROP TRIGGER owned_unit_skip ON store_product_unit;DROP FUNCTION owned_unit_skip()');}
  await f.exec("CREATE FUNCTION owned_unit_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.status=0;RETURN NEW;END$$;CREATE TRIGGER owned_unit_insert BEFORE INSERT ON store_product_unit FOR EACH ROW EXECUTE FUNCTION owned_unit_insert()");
  try{await unchanged(async()=>expect(mutate(await intent('create',0,{name:'新插入',sort:0}))).rejects.toThrow('回读'));}finally{await f.exec('DROP TRIGGER owned_unit_insert ON store_product_unit;DROP FUNCTION owned_unit_insert()');}
 });
 it('rolls back writes and receipts when original audit insertion fails',async()=>{
  await f.exec("CREATE FUNCTION owned_unit_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$;CREATE TRIGGER owned_unit_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION owned_unit_audit()");
  try{for(const op of ['create','update','delete']as const)await unchanged(async()=>expect(mutate(await intent(op,op==='create'?0:3,op==='delete'?{}:{name:'审计拒绝',sort:0}))).rejects.toThrow('审计'));}
  finally{await f.exec('DROP TRIGGER owned_unit_audit ON system_log;DROP FUNCTION owned_unit_audit()');}
 });
 it('refuses an unreviewed receipt trigger before business writes and preserves the complete snapshot',async()=>{
  await f.exec("CREATE FUNCTION owned_unit_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.result='{}'::jsonb;RETURN NEW;END$$;CREATE TRIGGER owned_unit_receipt BEFORE INSERT ON admin_unit_operation FOR EACH ROW EXECUTE FUNCTION owned_unit_receipt()");
  try{await unchanged(async()=>expect(mutate(await intent('update',3,{name:'回执失败',sort:0}))).rejects.toMatchObject({code:503}));}
  finally{await f.exec('DROP TRIGGER owned_unit_receipt ON admin_unit_operation;DROP FUNCTION owned_unit_receipt()');}
 });
 for(const mode of ['invalid-return','transport-error']as const)it('rolls back actually executed unit/audit/receipt after INSERT result fault '+mode,async()=>{
  const action=await intent('update',3,{name:'已执行待回滚',sort:17}),dialect=new PgDialect(),trace={inserted:false,unitWritten:false,auditWritten:false};
  const db=new Proxy(f.db,{get(target,key){
   const value:unknown=Reflect.get(target,key);if(typeof value!=='function')return value;if(key!=='transaction')return value.bind(target);
   return(callback:(tx:DbClient)=>Promise<unknown>,options:unknown)=>target.transaction(async tx=>{
    const port=new Proxy(tx,{get(current,property){
     const member:unknown=Reflect.get(current,property);if(typeof member!=='function')return member;if(property!=='execute')return member.bind(current);
     return async(query:Parameters<typeof tx.execute>[0])=>{
      const statement=dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql,result=await tx.execute(query);
      if(statement.startsWith('INSERT INTO public.admin_unit_operation')){
       trace.inserted=true;const [row]=await tx.select().from(storeProductUnit).where(eq(storeProductUnit.id,3));
       trace.unitWritten=row?.name==='已执行待回滚'&&row.sort===17;
       const [log]=await tx.select().from(systemLog).where(eq(systemLog.type,'product_unit_catalog'));trace.auditWritten=log?.method==='PUT';
       if(mode==='transport-error')throw Error('Owned receipt result fault after real INSERT');
       return Array.from(result).map(row=>({...row,result:{}}));
      }
      return result;
     };
    }});return callback(port as unknown as DbClient);
   },options as Parameters<typeof target.transaction>[1]);
  }});
  const faulted=new AdminUnitAuthorService(createContainerFromDb(db));
  await unchanged(()=>expect(f.asAdmin(()=>faulted.mutate(action,unitActor()))).rejects.toThrow());
  expect(trace).toEqual({inserted:true,unitWritten:true,auditWritten:true});
 });
 it('refuses unknown source columns or queries instead of dropping data',async()=>{
  for(const q of ['page=1','id=3&id=6'])await expect(f.asAdmin(()=>service.catalog(new URLSearchParams(q),unitActor()))).rejects.toThrow();
  await f.exec('ALTER TABLE store_product_unit ADD COLUMN unreviewed integer NOT NULL DEFAULT 1');try{await expect(catalog()).rejects.toMatchObject({code:503});}finally{await f.exec('ALTER TABLE store_product_unit DROP COLUMN unreviewed');}
 });
 it('reads an unavailable author and writes nothing when addon ACL drifts',async()=>{
  await f.exec(`GRANT UPDATE ON admin_unit_operation TO ${f.names.admin}`);try{expect((await catalog()).write_ready).toBe(false);await unchanged(async()=>expect(mutate(await intent('delete'))).rejects.toMatchObject({code:503}));}
  finally{await f.exec(`REVOKE UPDATE ON admin_unit_operation FROM ${f.names.admin}`);}
 });
 it('uses private fullsource cap rather than public active count, preserving existing edits at20000',async()=>{
  await f.exec("INSERT INTO store_product_unit(id,type,relation_id,status) SELECT n,2,42,0 FROM generate_series(1000,20992)n");
  expect(await catalog()).toMatchObject({count:3,can_create:false});await unchanged(async()=>expect(mutate(await intent('create',0,{name:'超容量',sort:0}))).rejects.toThrow('20000'));
  await mutate(await intent('update',3,{name:'容量满仍可编辑',sort:1}));await f.db.insert(storeProductUnit).values({id:22000,type:2,relationId:42});await expect(catalog()).rejects.toMatchObject({code:503});
 },30000);
});
