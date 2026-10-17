import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import type {Container} from '@/lib/di';
import {supplierFlowingWater,systemRole,user} from '@/models/schema';
import {SupplierBillExportService} from '@/services/supplier/SupplierBillExportService';
import {supplierBillExportFixture} from './helpers/supplierBillExport';
import {supplierBillTime} from './helpers/supplierBillRead';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 if(!wiring.container)throw Error('Owned bill export SELECT-only LOGIN unavailable');return wiring.container;
}}));
const app=createApp(),path='/supplierapi/export/financeRecord';
const query='?selection=period&period=2026-09-04';
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('complete Supplier bill export actual App JWT and SELECT-only PG16',()=>{
 let f:Awaited<ReturnType<typeof supplierBillExportFixture>>;
 beforeEach(async()=>{f=await supplierBillExportFixture();},30000);
 afterEach(async()=>{vi.restoreAllMocks();wiring.container=undefined;await f?.close();});
 async function request(search:string,principal:'reader'|'denied'|'other'|'anonymous'='reader',externalWriter=false) {
  const before=externalWriter?undefined:await f.snapshot();
  const response=await app.request(path+search,{headers:principal==='anonymous'?{}:{Authorization:'Bearer '+f.tokens[principal]}},f.env);
  const body=await response.json<{status:number;msg:string;data:any}>();
  if(!externalWriter)expect(await f.snapshot()).toEqual(before);
  expect(response.headers.get('Cache-Control')).toContain('private, no-store');return {response,body};
 }
 it('exports all105 records in one closed, exact and write-free response under finance.manage',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const {body}=await request(query);expect(body).toMatchObject({status:200,data:{version:'supplier-bill-export-v1',selection:'period',supplier_id:7,
    timeType:'day',status:'',data:'',period:'2026-09-04',count:105,income_num:'105.00',exp_num:'0.00',entry_num:'105.00',complete:true,bounded:true,
    filename:'账单导出_day_2026-09-04_all'}});
   expect(body.data.export).toHaveLength(105);expect(body.data.export[0].id).toBe(204);expect(body.data.export.at(-1).id).toBe(100);
   expect(new Set(body.data.export.map((row:any)=>row.id)).size).toBe(105);
   expect(Object.keys(body.data).sort()).toEqual(['version','selection','supplier_id','timeType','status','data','period','header','filekey','export','filename','count','income_num','exp_num','entry_num','complete','bounded'].sort());
   expect(Object.keys(body.data.export[0]).sort()).toEqual(['id','order_id','link_id','trade_time','number','pm','user_nickname','type_name','pay_type_name'].sort());
   expect(body.data.filekey).toHaveLength(8);expect(body.data.export.at(-1)).toMatchObject({order_id:'MANY-0',number:'1.00',pm:'收入',trade_time:'2026-09-04 12:00:00'});
   const empty=(await request('?selection=period&period=2026-08-01')).body;
   expect(empty).toMatchObject({status:200,data:{count:0,export:[],income_num:'0.00',exp_num:'0.00',entry_num:'0.00',complete:true}});
  });
 });
 it('exports more than10000 complete records and checks all totals beyond safe integer cents',async()=>{
  const when=supplierBillTime('2026-09-05T12:00:00+08:00');
  await f.exec(`INSERT INTO public.supplier_flowing_water (id,supplier_id,order_id,number,pm,add_time) SELECT 10000+i,7,'EXACT-'||i,9999999999.99,1,${when} FROM generate_series(0,10004) i`);
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const {body}=await request('?selection=period&period=2026-09-05');
   expect(body).toMatchObject({status:200,data:{count:10005,income_num:'100049999999899.95',exp_num:'0.00',entry_num:'100049999999899.95',complete:true}});
   expect(body.data.export).toHaveLength(10005);expect(body.data.export[0].id).toBe(20004);expect(body.data.export.at(-1).id).toBe(10000);
   expect(new Set(body.data.export.map((row:any)=>row.id)).size).toBe(10005);
  });
 },60000);
 it('includes the largest legitimate int4 identity before every lower owned row without an overflowing cursor',async()=>{
  await f.db.insert(supplierFlowingWater).values({id:2147483647,supplierId:7,orderId:'MAXIMUM-INT4-ID',number:'2.00',pm:1,
   addTime:supplierBillTime('2026-09-04T12:00:00+08:00')});
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const {body}=await request(query);expect(body).toMatchObject({status:200,data:{count:106,income_num:'107.00',exp_num:'0.00',entry_num:'107.00',complete:true}});
   expect(body.data.export).toHaveLength(106);expect(body.data.export[0]).toMatchObject({id:2147483647,order_id:'MAXIMUM-INT4-ID',number:'2.00'});
   expect(body.data.export.slice(1).map((row:any)=>row.id)).toEqual(Array.from({length:105},(_,index)=>204-index));
  });
 });
 it('keeps the first snapshot after an independent writer commits between keyset chunks and sees it only on the next request',async()=>{
  const when=supplierBillTime('2026-09-04T12:00:00+08:00');
  await f.exec(`INSERT INTO public.supplier_flowing_water (id,supplier_id,order_id,number,pm,add_time) SELECT 1000+i,7,'LATER-'||i,1.00,1,${when} FROM generate_series(0,899) i`);
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   let wrote=false,afterWriter:Awaited<ReturnType<typeof f.snapshot>>|undefined;
   const original=runtime.container.db.transaction.bind(runtime.container.db);
   const transaction=vi.spyOn(runtime.container.db,'transaction').mockImplementation((work,options)=>original(async tx=>{
    const execute=tx.execute.bind(tx);
    const intercepted=vi.spyOn(tx,'execute').mockImplementation(statement=>{
     const raw=execute(statement),run=raw.execute.bind(raw);
     raw.execute=async()=>{
      const rows=await run();
      if(!wrote&&rows.length===1000&&Object.hasOwn(rows[0]??{},'order_id')) {
       wrote=true;
       await f.db.update(supplierFlowingWater).set({number:'9.00'}).where(eq(supplierFlowingWater.id,1899));
       await f.db.insert(supplierFlowingWater).values({id:20000,supplierId:7,orderId:'AFTER-SNAPSHOT',number:'2.00',pm:1,addTime:when});
       afterWriter=await f.snapshot();
      }
      return rows;
     };return raw;
    });
    try{return await work(tx);}finally{intercepted.mockRestore();}
   },options));
   try {
    const first=(await request(query,'reader',true)).body;expect(wrote).toBe(true);
    expect(first).toMatchObject({status:200,data:{count:1005,income_num:'1005.00',entry_num:'1005.00'}});
    expect(first.data.export).toHaveLength(1005);expect(first.data.export.some((row:any)=>row.id===20000)).toBe(false);
    expect(first.data.export.find((row:any)=>row.id===1899).number).toBe('1.00');expect(await f.snapshot()).toEqual(afterWriter);
   }finally{transaction.mockRestore();}
   const next=(await request(query)).body;expect(next).toMatchObject({status:200,data:{count:1006,income_num:'1015.00',entry_num:'1015.00'}});
   expect(next.data.export[0]).toMatchObject({id:20000,number:'2.00'});expect(next.data.export.find((row:any)=>row.id===1899).number).toBe('9.00');
  });
 });
 it('binds settled finish clocks, add-clock dates and PHP calendar-year week00/53 to the full export',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   expect((await request('?selection=period&status=1&period=2026-09-02&data=2026/09/01-2026/09/01')).body)
    .toMatchObject({status:200,data:{count:1,income_num:'0.00',exp_num:'3.00',entry_num:'-3.00',export:[{id:2,trade_time:'2026-09-01 13:00:00',pm:'支出',pay_type_name:'余额支付'}]}});
   for(const [period,id] of [['2021-00',8],['2020-53',7]] as const)expect((await request('?selection=period&timeType=week&period='+period)).body).toMatchObject({status:200,data:{count:1,export:[{id}]}});
   expect((await request('?selection=period&timeType=month&status=-1&period=2026-09')).body).toMatchObject({status:200,data:{count:1,exp_num:'2.00',export:[{id:4}]}});
  });
 });
 it('requires live finance.manage and JWT tenancy while preserving read-only database authority',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   expect((await request(query,'denied')).body.status).toBe(400011);
   expect((await request(query,'anonymous')).body.status).toBe(410000);
   expect((await request('?selection=period&period=2026-09-01','other')).body).toMatchObject({status:200,data:{supplier_id:8,count:1,income_num:'99.00',export:[{id:3}]}});
   await f.db.update(systemRole).set({rules:'supplier.finance.view'}).where(eq(systemRole.id,21));
   expect((await request(query)).body.status).toBe(400011);
   await f.db.update(systemRole).set({rules:'supplier.finance.manage'}).where(eq(systemRole.id,21));
   expect((await request(query)).body.status).toBe(200);
   const [grants]=await runtime.db.execute<{unsafe:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM pg_class t WHERE t.relnamespace='public'::regnamespace AND t.relkind IN('r','p') AND
    (has_table_privilege(current_user,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,t.oid,'INSERT,UPDATE,REFERENCES'))) OR
    EXISTS(SELECT 1 FROM pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relkind='S' AND has_sequence_privilege(current_user,s.oid,'USAGE,SELECT,UPDATE')) AS unsafe`);
   expect(grants.unsafe).toBe(false);
  });
 });
 it('runs complete chunks inside the actual read-only repeatable-read transaction',async()=>{
  await f.withReader(async runtime=>{
   const original=runtime.container.db.transaction.bind(runtime.container.db);
   const transaction=vi.spyOn(runtime.container.db,'transaction').mockImplementation((work,options)=>original(async tx=>{
    const result=await work(tx);const [settings]=await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`);
    expect(settings).toMatchObject({readonly:'on',isolation:'repeatable read'});return result;
   },options));
   try{expect((await new SupplierBillExportService(runtime.container).period(7,{selection:'period',period:'2026-09-04'})).count).toBe(105);}
   finally{transaction.mockRestore();}
  });
 });
 it('neutralizes spreadsheet text while preserving signed money, deleted-user fallback and PHP channel labels',async()=>{
  await f.db.update(user).set({nickname:' =HYPERLINK("owned")'}).where(eq(user.uid,11));
  await f.db.update(supplierFlowingWater).set({orderId:'=FORMULA',linkId:'@LINK',number:'-2.50',pm:0,payType:'automatic'}).where(eq(supplierFlowingWater.id,1));
  await f.db.update(supplierFlowingWater).set({payType:'store'}).where(eq(supplierFlowingWater.id,6));
  await f.db.update(supplierFlowingWater).set({payType:'constructor'}).where(eq(supplierFlowingWater.id,4));
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const {body}=await request('?selection=period&period=2026-09-01');expect(body.status).toBe(200);
   expect(body.data.export.find((row:any)=>row.id===1)).toMatchObject({order_id:"'=FORMULA",link_id:"'@LINK",number:'-2.50',pm:'支出',user_nickname:"' =HYPERLINK(\"owned\")",pay_type_name:'自动转账'});
   expect(body.data.export.find((row:any)=>row.id===6)).toMatchObject({user_nickname:'游客',pay_type_name:'微信支付'});
   expect(body.data.export.find((row:any)=>row.id===4)).toMatchObject({pay_type_name:'其他方式'});
  });
 });
 it('preserves normal legacy ids shape and rejects wrong or partial period selectors without any export data',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const legacy=(await request('?ids=1,2,1&page=1')).body;expect(legacy.status).toBe(200);expect(legacy.data.export.map((row:any)=>row.order_id)).toEqual(['BILL-REFUND','BILL-INCOME']);
   expect(Object.keys(legacy.data).sort()).toEqual(['header','filekey','export','filename','limit','has_more','bounded'].sort());
   for(const suffix of ['&page=1','&limit=1000','&keyword=MANY','&ids=1','&supplier_id=8','&period=2026-09-03','&status=2']) {
    const denied=(await request(query+suffix)).body;expect(denied).toMatchObject({status:400,data:null});expect(JSON.stringify(denied)).not.toContain('MANY-0');
   }
   for(const ids of ['1,3','1,404','1,5'])expect((await request('?ids='+ids)).body).toMatchObject({status:400,data:null});
  });
 });
 it('rejects actual UTF8 capacity overflow as a whole instead of returning a partial successful file',async()=>{
  const when=supplierBillTime('2026-09-06T12:00:00+08:00');await f.db.update(user).set({nickname:'界'.repeat(60)}).where(eq(user.uid,11));
  await f.exec(`INSERT INTO public.supplier_flowing_water (id,supplier_id,uid,order_id,link_id,number,pm,add_time)
   SELECT 30000+i,7,11,repeat('界',40)||lpad(i::text,10,'0'),repeat('界',50),1.00,1,${when} FROM generate_series(0,34999) i`);
  const checksum=()=>f.exec('SELECT count(*)::text AS count,md5(string_agg(to_jsonb(t)::text,\'\' ORDER BY id)) AS hash FROM public.supplier_flowing_water t');
  await f.withReader(async runtime=>{wiring.container=runtime.container;const before=await checksum();
   const response=await app.request(path+'?selection=period&period=2026-09-06',{headers:{Authorization:'Bearer '+f.tokens.reader}},f.env);
   const body=await response.json<{status:number;msg:string;data:unknown}>();expect(body).toMatchObject({status:400,data:null});expect(body.msg).toContain('16MiB');
   expect(await checksum()).toEqual(before);expect(JSON.stringify(body)).not.toContain('export');
  });
 },60000);
});
