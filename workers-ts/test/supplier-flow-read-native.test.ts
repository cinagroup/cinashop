import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import type {Container} from '@/lib/di';
import {supplierFlowingWater,systemAdmin,systemRole} from '@/models/schema';
import {SupplierFlowReadService} from '@/services/supplier/SupplierFlowReadService';
import {md5} from '@/utils/jwt';
import {supplierFlowReadFixture} from './helpers/supplierFlowRead';
import {supplierBillReadPassword,supplierBillTime} from './helpers/supplierBillRead';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 if(!wiring.container)throw Error('Owned ledger LOGIN unavailable');return wiring.container;
}}));
const app=createApp(),path='/supplierapi/finance/supplier_flowing_water';
const actor=(id=21)=>({id,supplierId:id===31?8:7,authVersion:md5(supplierBillReadPassword),expiresAt:Math.floor(Date.now()/1000)+3600});
const rowKeys=['id','supplier_id','uid','order_id','link_id','pm','number','type','pay_type','status','mark','remark','add_time','trade_time','finish_time','user_nickname','type_name','pay_type_name','is_del','revision'];
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier ledger actual App JWT minimal-column PG16',()=>{
 let f:Awaited<ReturnType<typeof supplierFlowReadFixture>>;
 beforeEach(async()=>{f=await supplierFlowReadFixture();},30000);
 afterEach(async()=>{wiring.container=undefined;vi.restoreAllMocks();await f?.close();});
 async function request(suffix:string,principal:'reader'|'denied'|'other'|'anonymous'='reader',body?:unknown) {
  const response=await app.request(path+suffix,{method:body===undefined?'GET':'POST',headers:{...(principal==='anonymous'?{}:{Authorization:'Bearer '+f.tokens[principal]}),
   ...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env);
  const result=await response.json<{status:number;data:any}>();expect(response.headers.get('cache-control')).toContain('private, no-store');return result;
 }
 async function read(suffix:string,principal:'reader'|'denied'|'other'|'anonymous'='reader') {const before=await f.snapshot(),result=await request(suffix,principal);expect(await f.snapshot()).toEqual(before);return result;}
 async function mark(id=1){const result=await read(`/mark/${id}?selection=ledger`);expect(result.status).toBe(200);return result.data as {revision:string;mark:string};}
 it('returns a closed20-field ledger and preserves legacy camel fields plus PHP labels and safe fallback',async()=>{
  await f.db.update(supplierFlowingWater).set({payType:'constructor'}).where(eq(supplierFlowingWater.id,6));
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const result=await read('/list?selection=ledger&data=2026/09/01-2026/09/01');
   expect(result).toMatchObject({status:200,data:{version:'supplier-flow-v1',selection:'ledger',supplier_id:7,type:'',keyword:'',data:'2026/09/01-2026/09/01',page:1,limit:20,bounded:true,count:4}});
   expect(Object.keys(result.data).sort()).toEqual(['version','selection','supplier_id','type','keyword','data','page','limit','bounded','list','count'].sort());
   expect(result.data.list.map((row:any)=>row.id)).toEqual([6,4,2,1]);
   for(const row of result.data.list){expect(Object.keys(row).sort()).toEqual([...rowKeys].sort());expect(row.revision).toMatch(/^[a-f0-9]{64}$/);expect(row.is_del).toBe(0);}
   expect(result.data.list[0]).toMatchObject({user_nickname:'游客',pay_type_name:'其他方式'});
   expect(result.data.list[2]).toMatchObject({trade_time:'2026-09-01 13:00:00',finish_time:'2026-09-02 10:00:00',type_name:'退款订单',pay_type_name:'余额支付'});
   const legacy=await read('/list?type=1&limit=100');expect(legacy.status).toBe(200);expect(legacy.data.list[0]).toMatchObject({supplierId:7,supplier_id:7,orderId:'BILL-INCOME',order_id:'BILL-INCOME',addTime:supplierBillTime('2026-09-01T12:00:00+08:00'),add_time:'2026-09-01 12:00:00'});
   expect((await read('/list?selection=ledger','other')).data).toMatchObject({supplier_id:8,count:1,list:[{order_id:'FOREIGN-BILL'}]});
   const grants=await runtime.db.execute<{unsafe:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM pg_class t WHERE t.relnamespace='public'::regnamespace AND t.relkind IN('r','p') AND(has_table_privilege(current_user,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,t.oid,'INSERT,UPDATE,REFERENCES'))) OR EXISTS(SELECT 1 FROM pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relkind='S' AND has_sequence_privilege(current_user,s.oid,'USAGE,SELECT,UPDATE')) AS unsafe`);
   expect(grants[0].unsafe).toBe(false);
  });
 });
 it('applies literal order link buyer nickname uid and add-date filters without truncating page2',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   for(const keyword of ['Alice Buyer','11','OWNED-A'])expect((await read('/list?selection=ledger&keyword='+encodeURIComponent(keyword))).data.list.map((row:any)=>row.id)).toEqual(keyword==='11'?[111,2,1]:[2,1]);
   expect((await read('/list?selection=ledger&keyword='+encodeURIComponent('%_'))).data.list.map((row:any)=>row.id)).toEqual([9]);
   expect((await read('/list?selection=ledger&type=2&data=2026/09/01-2026/09/01')).data).toMatchObject({count:1,list:[{id:2}]});
   const first=await read('/list?selection=ledger&data=2026/09/04-2026/09/04&limit=100'),second=await read('/list?selection=ledger&data=2026/09/04-2026/09/04&limit=100&page=2');
   expect(first.data.count).toBe(105);expect(first.data.list).toHaveLength(100);expect(second.data.list).toHaveLength(5);expect(second.data.list.at(-1).id).toBe(100);
   expect(new Set([...first.data.list,...second.data.list].map((row:any)=>row.id)).size).toBe(105);
  });
 });
 it('prevents parameter tenant injection duplicates bad filters and anonymous reads without writes',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   for(const query of ['supplier_id=8','type=1&type=2','selection=ledger&selection=ledger','limit=101','page=0','type=0','keyword=%00','data=bad'])expect((await read('/list?selection=ledger&'+query)).status).toBe(400);
   expect((await read('/list?selection=ledger','anonymous')).status).toBe(410000);
   expect((await read('/mark/3?selection=ledger')).status).not.toBe(200);expect((await read('/mark/5?selection=ledger')).status).not.toBe(200);
   expect((await read('/mark/1?selection=ledger','denied')).status).toBe(200);
  });
 });
 it('updates only the note using minimum column rights and returns a fresh revision with staleCAS409',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const original=await mark();
   const before=await f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id),allBefore=await f.snapshot();
   const result=await request('/mark/1','reader',{selection:'ledger',mark:'  实际核对  ',expected_revision:original.revision});
   expect(result).toMatchObject({status:200,data:{version:'supplier-flow-mark-v1',supplier_id:7,id:1,mark:'实际核对',bounded:true}});expect(Object.keys(result.data).sort()).toEqual(['version','supplier_id','id','mark','revision','bounded'].sort());expect(result.data.revision).not.toBe(original.revision);
   expect(await f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id)).toEqual(before.map(row=>row.id===1?{...row,mark:'实际核对'}:row));
   const allAfter=await f.snapshot();for(const key of Object.keys(allBefore).filter(key=>key!=='supplier_flowing_water'))expect(allAfter[key]).toEqual(allBefore[key]);
   const saved=await f.snapshot();expect((await request('/mark/1','reader',{selection:'ledger',mark:'迟到覆盖',expected_revision:original.revision})).status).toBe(409);expect(await f.snapshot()).toEqual(saved);
   const noOp=await request('/mark/1','reader',{selection:'ledger',mark:'实际核对',expected_revision:result.data.revision});expect(noOp.data.revision).toBe(result.data.revision);expect(await f.snapshot()).toEqual(saved);
   const rights=await runtime.db.execute<{mark:boolean;number:boolean;rules:boolean;pwd:boolean;insert:boolean;unsafe_sequence:boolean}>(sql`SELECT has_column_privilege(current_user,'public.supplier_flowing_water','mark','UPDATE') AS mark,has_column_privilege(current_user,'public.supplier_flowing_water','number','UPDATE') AS number,has_column_privilege(current_user,'public.system_role','rules','UPDATE') AS rules,has_column_privilege(current_user,'public.system_admin','pwd','UPDATE') AS pwd,has_table_privilege(current_user,'public.supplier_flowing_water','INSERT,DELETE,TRUNCATE') AS insert,EXISTS(SELECT 1 FROM pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relkind='S' AND has_sequence_privilege(current_user,s.oid,'USAGE,SELECT,UPDATE')) AS unsafe_sequence`);
   expect(rights[0]).toEqual({mark:true,number:false,rules:false,pwd:false,insert:false,unsafe_sequence:false});
  });
 });
 it('keeps old note POST null and denies view-only foreign deleted and forged finance fields',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;
   expect(await request('/mark/1','reader',{mark:'旧客户备注'})).toMatchObject({status:200,data:null});
   const before=await f.snapshot(),revision=(await mark()).revision;
   expect((await request('/mark/1','denied',{mark:'越权'})).status).toBe(400011);
   for(const id of [3,5,999])expect((await request('/mark/'+id,'reader',{mark:'越界'})).status).not.toBe(200);
   for(const body of [{selection:'ledger',mark:'x',expected_revision:revision,number:'999.00'},{mark:''},{mark:'x',supplier_id:8}])expect((await request('/mark/1','reader',body)).status).toBe(400);
   expect(await f.snapshot()).toEqual(before);
  });
 });
 it('rechecks live session roles and supplier tuple inside the write transaction',async()=>{
  await f.withWriter(async runtime=>{const service=new SupplierFlowReadService(runtime.container),before=await f.snapshot();
   await expect(service.updateMark(7,1,{mark:'x'},actor(31))).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
   await f.db.update(systemRole).set({rules:'supplier.finance.view'}).where(eq(systemRole.id,21));const revoked=await f.snapshot();
   await expect(service.updateMark(7,1,{mark:'x'},actor())).rejects.toMatchObject({code:400011});expect(await f.snapshot()).toEqual(revoked);
   await f.db.update(systemRole).set({rules:'supplier.finance.manage'}).where(eq(systemRole.id,21));
   await f.db.update(systemAdmin).set({pwd:'replaced-owned-password'}).where(eq(systemAdmin.id,21));const changed=await f.snapshot();
   await expect(service.updateMark(7,1,{mark:'x'},actor())).rejects.toThrow();expect(await f.snapshot()).toEqual(changed);
   await expect(service.updateMark(7,1,{mark:'x'},{...actor(),expiresAt:1})).rejects.toThrow();expect(await f.snapshot()).toEqual(changed);
  });
 });
 it('fails closed on a concurrent authority writer and recovers after its actual transaction releases',async()=>{
  await f.withWriter(async runtime=>{const service=new SupplierFlowReadService(runtime.container),before=await f.snapshot();
   await f.db.transaction(async tx=>{await tx.update(systemRole).set({rules:'supplier.finance.view'}).where(eq(systemRole.id,21));
    await expect(service.updateMark(7,1,{mark:'must not commit'},actor())).rejects.toMatchObject({httpStatus:409});
    throw new Error('owned rollback release');
   }).catch(error=>{expect(error.message).toBe('owned rollback release');});
   expect(await f.snapshot()).toEqual(before);await service.updateMark(7,1,{mark:'after release'},actor());
   expect((await f.db.select().from(supplierFlowingWater).where(eq(supplierFlowingWater.id,1)))[0].mark).toBe('after release');
  });
 });
 it('serializes independent original note requests with one successful CAS and one409',async()=>{
  await f.withWriter(async one=>f.withWriter(async two=>{
   const first=new SupplierFlowReadService(one.container),second=new SupplierFlowReadService(two.container),seed=await first.mark(7,1,{selection:'ledger'});
   const results=await Promise.allSettled([first.updateMark(7,1,{selection:'ledger',mark:'并发甲',expected_revision:seed.revision},actor()),second.updateMark(7,1,{selection:'ledger',mark:'并发乙',expected_revision:seed.revision},actor())]);
   expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);const rejected=results.find(row=>row.status==='rejected');
   expect(rejected?.status==='rejected'&&rejected.reason).toMatchObject({httpStatus:409});
   const current=await first.mark(7,1,{selection:'ledger'});expect(['并发甲','并发乙']).toContain(current.mark);expect(current.revision).not.toBe(seed.revision);
   expect((await f.db.select().from(supplierFlowingWater).where(eq(supplierFlowingWater.id,1)))[0]).toMatchObject({number:'10.00',pm:1,type:1,status:0});
  }));
 });

});
