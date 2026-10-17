import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import type {Container} from '@/lib/di';
import {systemRole,supplierFlowingWater} from '@/models/schema';
import {SupplierBillReadService} from '@/services/supplier/SupplierBillReadService';
import {supplierBillReadFixture,supplierBillTime} from './helpers/supplierBillRead';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 if(!wiring.container)throw Error('Owned bill read LOGIN unavailable');return wiring.container;
}}));
const app=createApp();
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier bill read actual App JWT and SELECT-only PG16',()=>{
 let f:Awaited<ReturnType<typeof supplierBillReadFixture>>;
 beforeEach(async()=>{f=await supplierBillReadFixture();},30000);
 afterEach(async()=>{wiring.container=undefined;await f?.close();});
 const group='/finance/supplier_flowing_water/fund_record',details='/finance/supplier_flowing_water/fund_record_info';
 async function request(path:string,principal:'reader'|'denied'|'other'|'anonymous'='reader') {
  const before=await f.snapshot(),response=await app.request('/supplierapi'+path,{headers:principal==='anonymous'?{}:{Authorization:'Bearer '+f.tokens[principal]}},f.env);
  const body=await response.json<{status:number;msg:string;data:any}>();expect(await f.snapshot()).toEqual(before);
  expect(response.headers.get('Cache-Control')).toContain('private, no-store');return {response,body};
 }
 it('derives the tenant from the actual JWT and grants reads without any write or sequence authority',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const result=await request(group+'?selection=period&data=2026/09/01-2026/09/01');
   expect(result.body).toMatchObject({status:200,data:{supplier_id:7,status:'',count:1,list:[{period:'2026-09-01',income_num:'11.00',exp_num:'5.00',entry_num:'6.00',detail_count:4}]}});
   expect((await request(group+'?selection=period&data=2026/09/01-2026/09/01','other')).body.data)
    .toMatchObject({supplier_id:8,list:[{income_num:'99.00',exp_num:'0.00'}]});
   expect((await request(group+'?selection=period','denied')).body.status).toBe(400011);
   expect((await request(group+'?selection=period','anonymous')).body.status).toBe(410000);
   const grants=await runtime.db.execute<{unsafe:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM pg_class t WHERE t.relnamespace='public'::regnamespace AND t.relkind IN('r','p') AND
    (has_table_privilege(current_user,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,t.oid,'INSERT,UPDATE,REFERENCES'))) OR
    EXISTS(SELECT 1 FROM pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relkind='S' AND has_sequence_privilege(current_user,s.oid,'USAGE,SELECT,UPDATE')) AS unsafe`);
   expect(grants[0].unsafe).toBe(false);
  });
 });
 it('preserves finish-clock groups, add-clock date filters and calendar-year week00/53',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const settled=(await request(group+'?selection=period&status=1&data=2026/09/01-2026/09/01')).body;
   expect(settled).toMatchObject({status:200,data:{list:[{period:'2026-09-02',income_num:'0.00',exp_num:'3.00',entry_num:'-3.00'}]}});
   expect((await request(details+'?selection=period&status=1&period=2026-09-02&data=2026/09/01-2026/09/01')).body)
    .toMatchObject({status:200,data:{count:1,list:[{id:2,trade_time:'2026-09-01 13:00:00',finish_time:'2026-09-02 10:00:00'}]}});
   expect((await request(group+'?selection=period&timeType=week&data=2020/12/31-2021/01/02')).body.data.list)
    .toMatchObject([{period:'2021-00',income_num:'5.00'},{period:'2020-53',income_num:'2.00'}]);
   expect((await request(group+'?selection=period&timeType=month&status=-1')).body.data.list).toMatchObject([{period:'2026-09',exp_num:'2.00'}]);
  });
 });
 it('reads every row after100 through period pagination with a closed modern response',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const query=details+'?selection=period&period=2026-09-04&limit=100';
   const first=(await request(query)).body,second=(await request(query+'&page=2')).body;
   expect(first).toMatchObject({status:200,data:{count:105,page:1,limit:100}});expect(first.data.list).toHaveLength(100);
   expect(second).toMatchObject({status:200,data:{count:105,page:2,limit:100}});expect(second.data.list).toHaveLength(5);
   expect(new Set([...first.data.list,...second.data.list].map((row:any)=>row.id)).size).toBe(105);
   expect(first.data.list[0].id).toBe(204);expect(second.data.list.at(-1).id).toBe(100);
   expect(Object.keys(first.data).sort()).toEqual(['version','selection','supplier_id','timeType','status','data','page','limit','bounded','period','keyword','list','count'].sort());
   expect(Object.keys(first.data.list[0]).sort()).toEqual(['id','supplier_id','uid','order_id','link_id','pm','number','type','pay_type','status','mark','remark','add_time','trade_time','finish_time','user_nickname','type_name','pay_type_name'].sort());
  });
 });
 it('does not truncate modern periods above10000 rows and keeps SQL money exact beyond safe integer cents',async()=>{
  const when=supplierBillTime('2026-09-05T12:00:00+08:00');
  for(let offset=0;offset<10005;offset+=500)await f.db.insert(supplierFlowingWater).values(Array.from({length:Math.min(500,10005-offset)},(_,i)=>({
   id:10000+offset+i,supplierId:7,orderId:'EXACT-'+(offset+i),number:'9999999999.99',pm:1,addTime:when})));
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const groups=(await request(group+'?selection=period&data=2026/09/05-2026/09/05')).body;
   expect(groups).toMatchObject({status:200,data:{list:[{detail_count:10005,income_num:'100049999999899.95',exp_num:'0.00',entry_num:'100049999999899.95'}]}});
   const tail=(await request(details+'?selection=period&period=2026-09-05&limit=100&page=101')).body;
   expect(tail).toMatchObject({status:200,data:{count:10005,page:101}});expect(tail.data.list).toHaveLength(5);
   expect(tail.data.list.at(-1).id).toBe(10000);
   expect((await request(group+'?data=2026/09/05-2026/09/05')).body.status).toBe(400);
  });
 },60000);
 it('keeps complete legacy ids and raw field compatibility while rejecting foreign/missing or excessive identities',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const legacy=(await request(group+'?data=2026/09/04-2026/09/04')).body;
   expect(legacy.status).toBe(200);const ids=legacy.data.list[0].ids as string;expect(ids.split(',')).toHaveLength(105);
   const full=(await request(details+'?ids='+ids+'&limit=100&page=2')).body;
   expect(full).toMatchObject({status:200,data:{count:105}});expect(full.data.list).toHaveLength(5);
   expect(full.data.list[0]).toHaveProperty('supplierId',7);expect(full.data.list[0]).toHaveProperty('supplier_id',7);
   for(const invalid of ['1,3','1,404','1,5',Array.from({length:1001},(_,i)=>String(i+1)).join(',')])
    expect((await request(details+'?ids='+invalid)).body.status).toBe(400);
   expect((await request(details+'?ids=1,2,1&keyword=Alice')).body).toMatchObject({status:200,data:{count:2}});
  });
 });
 it('searches literal transaction/user identity, hides deleted-user names and never broadens the tenant',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const query=details+'?selection=period&period=2026-09-01';
   expect((await request(query+'&keyword=Alice')).body.data.count).toBe(2);
   expect((await request(query+'&keyword=11')).body.data.count).toBe(2);
   expect((await request(query+'&keyword=Deleted')).body.data.count).toBe(0);
   expect((await request(query)).body.data.list.find((row:any)=>row.id===6).user_nickname).toBe('游客');
   const literal=(await request(details+'?selection=period&period=2026-09-03&keyword=%25_')).body;
   expect(literal).toMatchObject({status:200,data:{count:1,list:[{id:9,order_id:'A%_LITERAL'}]}});
   expect((await request(query+'&supplier_id=8')).body.status).toBe(400);
  });
 });
 it('rejects malformed/duplicate scopes and rechecks live finance permissions on the next actual GET',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   for(const query of ['selection=period&status=2','selection=period&timeType=week&timeType=day','selection=period&data=2026/02/30-2026/03/01','selection=period&uid=11'])
    expect((await request(group+'?'+query)).body.status).toBe(400);
   expect((await request(details+'?selection=period&period=2026-09-01&ids=1')).body.status).toBe(400);
   await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));
   expect((await request(group+'?selection=period')).body.status).toBe(400011);
   await f.db.update(systemRole).set({rules:'supplier.finance.view'}).where(eq(systemRole.id,21));
   expect((await request(group+'?selection=period')).body.status).toBe(200);
  });
 });
 it('executes the service in an actual repeatable read read-only transaction',async()=>{
  await f.withReader(async runtime=>{
   const original=runtime.container.db.transaction.bind(runtime.container.db);
   const transaction=vi.spyOn(runtime.container.db,'transaction').mockImplementation((work,options)=>original(async tx=>{
    const value=await work(tx);const [settings]=await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`);
    expect(settings).toMatchObject({readonly:'on',isolation:'repeatable read'});return value;
   },options));
   try{const service=new SupplierBillReadService(runtime.container);expect((await service.groups(7,{selection:'period'})).count).toBeGreaterThan(0);
    expect((await service.details(7,{selection:'period',period:'2026-09-04'})).count).toBe(105);
   }finally{transaction.mockRestore();}
  });
 });
});
