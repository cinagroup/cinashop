/** Actual App/Supplier JWT with independent SELECT-only and note-column-only
 * PG16 LOGINs. Input history is synthetic; Admin confirmations are local state
 * changes and never evidence of an external bank payment. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import {createContainerFromDb,type Container} from '@/lib/di';
import {supplierExtract,supplierFlowingWater,systemAdmin,systemConfig,systemLog,systemRole} from '@/models/schema';
import {SupplierExtractReadService} from '@/services/supplier/SupplierExtractReadService';
import {AdminSupplierFinanceService} from '@/services/admin/AdminSupplierFinanceService';
import {md5} from '@/utils/jwt';
import {supplierExtractReadFixture,supplierExtractReadPassword,supplierExtractTime} from './helpers/supplierExtractRead';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 if(!wiring.container)throw Error('Owned withdrawal history LOGIN unavailable');return wiring.container;
}}));
const app=createApp(),path='/supplierapi/finance/supplier_extract';
const actor=(id=21)=>({id,supplierId:id===31?8:7,authVersion:md5(supplierExtractReadPassword),expiresAt:Math.floor(Date.now()/1000)+3600});
const rowKeys=['id','supplier_id','extract_type','bank_code','bank_address','alipay_account','wechat','qrcode_url','extract_price','balance','supplier_mark','status','pay_status','admin_id','admin_name','fail_msg','fail_time','voucher_image','voucher_title','pay_time','add_time','revision'];
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier withdrawal history actual App JWT minimal-column PG16',()=>{
 let f:Awaited<ReturnType<typeof supplierExtractReadFixture>>;
 beforeEach(async()=>{f=await supplierExtractReadFixture();vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Withdrawal history forbids outbound I/O'));},30000);
 afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();await f?.close();}finally{wiring.container=undefined;vi.restoreAllMocks();}});
 async function request(suffix:string,principal:'reader'|'viewer'|'denied'|'other'|'anonymous'='reader',body?:unknown) {
  const response=await app.request(path+suffix,{method:body===undefined?'GET':'POST',headers:{...(principal==='anonymous'?{}:{Authorization:'Bearer '+f.tokens[principal]}),
   ...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env);
  const result=await response.json<{status:number;data:any}>();expect(response.headers.get('cache-control')).toContain('private, no-store');return result;
 }
 async function read(suffix:string,principal:'reader'|'viewer'|'denied'|'other'|'anonymous'='reader') {const before=await f.snapshot(),result=await request(suffix,principal);expect(await f.snapshot()).toEqual(before);return result;}
 async function mark(id=1){const result=await read(`/mark/${id}?selection=history`);expect(result.status).toBe(200);return result.data as {revision:string;supplier_mark:string};}
 it('reads closed22-field historical accounts vouchers and administrator names without exposing internal mark',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const result=await read('/list?selection=history&limit=100&data=2026/09/01-2026/09/03');
   expect(result).toMatchObject({status:200,data:{version:'supplier-extract-v1',selection:'history',supplier_id:7,count:4,page:1,limit:100,status:'',pay_status:'',extract_type:'',bounded:true,
    statistics:{pending_review:'10.00',pending_transfer:'20.00',paid:'30.00',withdrawable:'735.00',extract_min_price:'5.50',extract_max_price:'200.00'}}});
   expect(Object.keys(result.data).sort()).toEqual(['version','selection','supplier_id','status','pay_status','extract_type','data','page','limit','bounded','list','count','statistics'].sort());
   expect(Object.keys(result.data.statistics).sort()).toEqual(['pending_review','pending_transfer','paid','withdrawable','extract_min_price','extract_max_price'].sort());
   expect(result.data.list.map((row:any)=>row.id)).toEqual([4,3,2,1]);for(const row of result.data.list){expect(Object.keys(row).sort()).toEqual([...rowKeys].sort());expect(row.revision).toMatch(/^[a-f0-9]{64}$/);}
   expect(result.data.list[1]).toMatchObject({wechat:'owned-wechat',qrcode_url:'/owned-media/wechat.png',voucher_image:'/owned-media/voucher.png',voucher_title:'本机确认登记',admin_name:'历史经办人',add_time:'2026-09-02 10:00:00',pay_time:'2026-09-02 11:00:00',fail_time:''});
   expect(result.data.list[2]).toMatchObject({alipay_account:'owned-alipay',admin_name:'本机财务经办人'});
   expect(result.data.list[3]).toMatchObject({bank_code:'6222000011112222',bank_address:'本机开户行',admin_name:''});expect(JSON.stringify(result)).not.toContain('CURRENT-OTHER-ACCOUNT');expect(JSON.stringify(result)).not.toContain('内部字段不进入现代响应');
   expect((await read('/list?selection=history','other')).data).toMatchObject({supplier_id:8,count:1,statistics:{pending_review:'99.00',withdrawable:'401.00'}});
  });
 });
 it('matches PHP review and transfer statistics override rules while keeping full-account availability independent',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   const day='&data=2026/09/01-2026/09/01';
   const reviewed=await read('/list?selection=history&status=1&pay_status=0'+day);expect(reviewed.data).toMatchObject({count:1,list:[{id:2}],statistics:{pending_review:'10.00',pending_transfer:'20.00',paid:'0.00',withdrawable:'735.00'}});
   const paid=await read('/list?selection=history&status=0&pay_status=1');expect(paid.data).toMatchObject({count:0,list:[],statistics:{pending_review:'0.00',pending_transfer:'20.00',paid:'30.00',withdrawable:'735.00'}});
   const alias=await read('/list?selection=history&extract_type=wx');expect(alias.data).toMatchObject({extract_type:'weixin',count:1,list:[{id:3}],statistics:{pending_review:'0.00',pending_transfer:'0.00',paid:'30.00',withdrawable:'735.00'}});
   const rejected=await read('/list?selection=history&status=-1'+day);expect(rejected.data).toMatchObject({count:1,list:[{id:4,fail_msg:'本机拒绝说明',fail_time:'2026-09-03 14:00:00'}]});
  });
 });
 it('paginates all105 records and preserves legacy camel fields and the separate FinanceSummary6 shape',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;const query='/list?selection=history&data=2026/09/04-2026/09/04&limit=100';
   const first=await read(query),second=await read(query+'&page=2');expect(first.data).toMatchObject({count:105,statistics:{pending_review:'105.00',pending_transfer:'0.00',paid:'0.00',withdrawable:'735.00'}});
   expect(first.data.list).toHaveLength(100);expect(second.data.list).toHaveLength(5);expect(first.data.list[0].id).toBe(204);expect(second.data.list.at(-1).id).toBe(100);expect(new Set([...first.data.list,...second.data.list].map((row:any)=>row.id)).size).toBe(105);
   const legacy=await read('/list?extract_type=alipay');expect(legacy.data).toMatchObject({count:1,page:1,limit:20,list:[{id:2,extractType:'alipay',extractPrice:'20.00',supplierMark:'支付宝申请说明',adminId:101,addTime:supplierExtractTime('2026-09-01T13:00:00+08:00'),add_time:'2026-09-01 13:00:00'}],
    extract_statistics:{available:'735.00',pending_settlement:'50.00',total_income:'1000.00',total_refund:'100.00',pending_extract:'115.00',paid_extract:'30.00'}});
   expect(Object.keys(legacy.data.extract_statistics).sort()).toEqual(['available','pending_settlement','total_income','total_refund','pending_extract','paid_extract'].sort());
  });
 });
 it('retains complete pagination above10000 and exact aggregate cents beyond Number safe integers',async()=>{
  const when=supplierExtractTime('2026-09-05T12:00:00+08:00');
  await f.exec(`INSERT INTO public.supplier_extract(id,supplier_id,extract_type,extract_price,status,pay_status,add_time) SELECT 10000+i,7,'bank',9999999999.99,0,0,${when} FROM generate_series(0,10004) i`);
  await f.withReader(async runtime=>{wiring.container=runtime.container;const result=await read('/list?selection=history&data=2026/09/05-2026/09/05&page=101&limit=100');
   expect(result.data).toMatchObject({count:10005,page:101,statistics:{pending_review:'100049999999899.95',withdrawable:'0.00'}});expect(result.data.list).toHaveLength(5);expect(result.data.list.at(-1).id).toBe(10000);
  });
 },60000);
 it('reads bounded authoritative config in the same database snapshot and refuses invalid nonempty settings',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   await f.db.update(systemConfig).set({value:'invalid amount'}).where(eq(systemConfig.id,2));const failed=await read('/list?selection=history');expect(failed.status).toBe(503);
   await f.db.update(systemConfig).set({value:''}).where(eq(systemConfig.id,2));await f.db.delete(systemConfig).where(sql`${systemConfig.menuName}='supplier_extract_min_price'`);
   expect((await read('/list?selection=history')).data.statistics).toMatchObject({extract_min_price:'0.00',extract_max_price:'0.00'});
   expect((await read('/list')).status).toBe(200);
  });
 });
 it('pins rows count statistics balances and config across a real independent writer commit in one READ ONLY snapshot',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;let changed=false,afterWriter:Awaited<ReturnType<typeof f.snapshot>>|undefined;
   const original=runtime.container.db.transaction.bind(runtime.container.db);
   const transaction=vi.spyOn(runtime.container.db,'transaction').mockImplementation((work,options)=>original(async tx=>{
    const execute=tx.execute.bind(tx);let statements=0;
    const intercepted=vi.spyOn(tx,'execute').mockImplementation(statement=>{const raw=execute(statement),run=raw.execute.bind(raw);raw.execute=async()=>{
     const rows=await run();if(++statements===2&&!changed){changed=true;const[state]=await execute(sql`SELECT current_setting('transaction_read_only') AS readonly`);expect(state.readonly).toBe('on');
      await f.db.transaction(async owner=>{await owner.update(supplierExtract).set({extractPrice:'11.00'}).where(eq(supplierExtract.id,1));await owner.insert(supplierExtract).values({id:1000,supplierId:7,extractType:'bank',extractPrice:'2.00',status:0,payStatus:0});await owner.update(supplierFlowingWater).set({number:'1100.00'}).where(eq(supplierFlowingWater.id,1));await owner.update(systemConfig).set({value:'300.00'}).where(eq(systemConfig.id,2));});afterWriter=await f.snapshot();
     }return rows;};return raw;});
    try{return await work(tx);}finally{intercepted.mockRestore();}
   },options));
   try{const result=await request('/list?selection=history');expect(changed).toBe(true);expect(result.data).toMatchObject({count:109,statistics:{pending_review:'115.00',withdrawable:'735.00',extract_max_price:'200.00'}});expect(result.data.list.some((row:any)=>row.id===1000)).toBe(false);expect(await f.snapshot()).toEqual(afterWriter);}
   finally{transaction.mockRestore();}
   const next=await read('/list?selection=history');expect(next.data).toMatchObject({count:110,statistics:{pending_review:'118.00',withdrawable:'832.00',extract_max_price:'300.00'}});
  });
 });
 it('enforces tenant closed queries private failures and SELECT-only reader privileges',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;
   expect((await read('/list?selection=history','viewer')).status).toBe(200);expect((await read('/list?selection=history','denied')).status).toBe(400011);expect((await read('/list?selection=history','anonymous')).status).toBe(410000);
   for(const suffix of ['&supplier_id=8','&status=0&status=1','&status=2','&pay_status=2','&extract_type=balance','&limit=101','&data=bad','&unknown=1'])expect((await read('/list?selection=history'+suffix)).status).toBe(400);
   expect((await read('/mark/5?selection=history')).status).toBe(404);expect((await read('/mark/999?selection=history')).status).toBe(404);
   const[grants]=await runtime.db.execute<{unsafe:boolean;log:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM pg_class t WHERE t.relnamespace='public'::regnamespace AND t.relkind IN('r','p') AND(has_table_privilege(current_user,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,t.oid,'INSERT,UPDATE,REFERENCES'))) OR EXISTS(SELECT 1 FROM pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relkind='S' AND has_sequence_privilege(current_user,s.oid,'USAGE,SELECT,UPDATE')) AS unsafe,has_table_privilege(current_user,'public.system_log','SELECT') AS log`);expect(grants).toEqual({unsafe:false,log:false});
  });
 });
 it('updates only supplier_mark with minimal column rights modernCAS and legacy null compatibility',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const before=await f.snapshot(),seed=await mark();
   const result=await request('/mark/1','reader',{selection:'history',mark:'  供应商已核对  ',expected_revision:seed.revision});expect(result).toMatchObject({status:200,data:{version:'supplier-extract-mark-v1',supplier_id:7,id:1,supplier_mark:'供应商已核对',bounded:true}});expect(Object.keys(result.data).sort()).toEqual(['version','supplier_id','id','supplier_mark','revision','bounded'].sort());expect(result.data.revision).not.toBe(seed.revision);
   const after=await f.snapshot(),normalized=structuredClone(after);normalized.supplier_extract.find((row:any)=>row.row.id===1)!.row.supplier_mark='银行申请说明';expect(normalized).toEqual(before);
   expect((await request('/mark/1','reader',{selection:'history',mark:'旧页面覆盖',expected_revision:seed.revision})).status).toBe(409);expect(await f.snapshot()).toEqual(after);
   expect(await request('/mark/1','reader',{mark:'旧API备注'})).toMatchObject({status:200,data:null});
   const[rights]=await runtime.db.execute<{mark:boolean;amount:boolean;status:boolean;pay:boolean;admin:boolean;image:boolean;rules:boolean;pwd:boolean;insert:boolean;sequence:boolean}>(sql`SELECT has_column_privilege(current_user,'public.supplier_extract','supplier_mark','UPDATE') AS mark,has_column_privilege(current_user,'public.supplier_extract','extract_price','UPDATE') AS amount,has_column_privilege(current_user,'public.supplier_extract','status','UPDATE') AS status,has_column_privilege(current_user,'public.supplier_extract','pay_status','UPDATE') AS pay,has_column_privilege(current_user,'public.supplier_extract','admin_id','UPDATE') AS admin,has_column_privilege(current_user,'public.supplier_extract','voucher_image','UPDATE') AS image,has_column_privilege(current_user,'public.system_role','rules','UPDATE') AS rules,has_column_privilege(current_user,'public.system_admin','pwd','UPDATE') AS pwd,has_table_privilege(current_user,'public.supplier_extract','INSERT,DELETE,TRUNCATE') AS insert,EXISTS(SELECT 1 FROM pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relkind='S' AND has_sequence_privilege(current_user,s.oid,'USAGE,SELECT,UPDATE')) AS sequence`);
   expect(rights).toEqual({mark:true,amount:false,status:false,pay:false,admin:false,image:false,rules:false,pwd:false,insert:false,sequence:false});
   expect((await f.db.select().from(supplierExtract).where(eq(supplierExtract.id,1)))[0].mark).toBe('内部字段不进入现代响应');
  });
 });
 it('prevents foreign viewer forged financial fields stale credentials and revoked authority from writing notes',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const before=await f.snapshot(),seed=await mark();
   expect((await request('/mark/1','viewer',{mark:'越权'})).status).toBe(400011);expect((await request('/mark/5','reader',{mark:'越界'})).status).toBe(404);
   for(const body of [{mark:''},{mark:'x',supplier_id:8},{selection:'history',mark:'x',expected_revision:seed.revision,pay_status:1}])expect((await request('/mark/1','reader',body)).status).toBe(400);expect(await f.snapshot()).toEqual(before);
   const service=new SupplierExtractReadService(runtime.container);await expect(service.updateMark(7,1,{mark:'x'},actor(31))).rejects.toThrow();
   await f.db.update(systemRole).set({rules:'supplier.finance.view'}).where(eq(systemRole.id,21));const revoked=await f.snapshot();await expect(service.updateMark(7,1,{mark:'x'},actor())).rejects.toMatchObject({code:400011});expect(await f.snapshot()).toEqual(revoked);
   await f.db.update(systemRole).set({rules:'supplier.finance.manage'}).where(eq(systemRole.id,21));await f.db.update(systemAdmin).set({pwd:'changed-owned-password'}).where(eq(systemAdmin.id,21));const changed=await f.snapshot();await expect(service.updateMark(7,1,{mark:'x'},actor())).rejects.toThrow();await expect(service.updateMark(7,1,{mark:'x'},{...actor(),expiresAt:1})).rejects.toThrow();expect(await f.snapshot()).toEqual(changed);
  });
 });
 it('composes actual Admin shared-note CAS review and local voucher confirmation without rewriting financial fields',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const admin=new AdminSupplierFinanceService(createContainerFromDb(f.db)),initial=await mark();
   await admin.updateMark(1,101,{mark:'后台先核对',expected_supplier_mark:initial.supplier_mark});const afterAdmin=await f.snapshot();
   expect((await request('/mark/1','reader',{selection:'history',mark:'过期覆盖',expected_revision:initial.revision})).status).toBe(409);expect(await f.snapshot()).toEqual(afterAdmin);
   const current=await mark();expect((await request('/mark/1','reader',{selection:'history',mark:'供方复核',expected_revision:current.revision})).status).toBe(200);
   await expect(admin.updateMark(1,101,{mark:'后台旧覆盖',expected_supplier_mark:'后台先核对'})).rejects.toMatchObject({httpStatus:409});expect(await f.db.select().from(systemLog)).toHaveLength(1);
   const beforeReview=await mark();await admin.review(1,101,{type:1});expect((await request('/mark/1','reader',{selection:'history',mark:'审核前旧覆盖',expected_revision:beforeReview.revision})).status).toBe(409);
   const beforeTransfer=await mark();await admin.transfer(1,101,{voucher_title:'本机追加登记',voucher_image:'/owned-media/admin-transfer.png'});expect((await request('/mark/1','reader',{selection:'history',mark:'凭证前旧覆盖',expected_revision:beforeTransfer.revision})).status).toBe(409);
   const list=await read('/list?selection=history&extract_type=bank&status=1&pay_status=1');expect(list.data.list[0]).toMatchObject({id:1,supplier_mark:'供方复核',admin_name:'本机财务经办人',voucher_title:'本机追加登记',voucher_image:'/owned-media/admin-transfer.png',extract_price:'10.00'});
   const afterConfirmation=await f.snapshot(),fresh=await mark();expect((await request('/mark/1','reader',{selection:'history',mark:'凭证后供方确认',expected_revision:fresh.revision})).status).toBe(200);
   const final=await f.snapshot(),normalized=structuredClone(final);normalized.supplier_extract.find((row:any)=>row.row.id===1)!.row.supplier_mark='供方复核';expect(normalized).toEqual(afterConfirmation);
  });
 });
 it('fails closed on an uncommitted authority writer and resumes note-only writes after rollback',async()=>{
  await f.withWriter(async runtime=>{const service=new SupplierExtractReadService(runtime.container),before=await f.snapshot(),seed=await service.mark(7,1,{selection:'history'});
   const rollback=new Error('owned withdrawal authority rollback');
   await expect(f.db.transaction(async owner=>{
    await owner.update(systemRole).set({rules:'supplier.finance.view'}).where(eq(systemRole.id,21));
    await expect(service.updateMark(7,1,{selection:'history',mark:'不得提交的备注',expected_revision:seed.revision},actor())).rejects.toMatchObject({code:409,httpStatus:409});
    throw rollback;
   })).rejects.toBe(rollback);
   expect(await f.snapshot()).toEqual(before);
   const result=await service.updateMark(7,1,{selection:'history',mark:'权限事务回滚后核对',expected_revision:seed.revision},actor());
   expect(result).toMatchObject({version:'supplier-extract-mark-v1',supplier_id:7,id:1,supplier_mark:'权限事务回滚后核对'});
   const after=await f.snapshot(),normalized=structuredClone(after);normalized.supplier_extract.find((row:any)=>row.row.id===1)!.row.supplier_mark='银行申请说明';expect(normalized).toEqual(before);
  });
 });
 it('serializes independent Supplier and Admin note CAS while preserving one winning description',async()=>{
  await f.withWriter(async runtime=>{const supplier=new SupplierExtractReadService(runtime.container),admin=new AdminSupplierFinanceService(createContainerFromDb(f.db)),seed=await supplier.mark(7,1,{selection:'history'});
   const results=await Promise.allSettled([supplier.updateMark(7,1,{selection:'history',mark:'供方并发',expected_revision:seed.revision},actor()),admin.updateMark(1,101,{mark:'后台并发',expected_supplier_mark:seed.supplier_mark})]);
   expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);const failed=results.find(row=>row.status==='rejected');expect(failed?.status==='rejected'&&failed.reason).toMatchObject({httpStatus:409});
   const current=await supplier.mark(7,1,{selection:'history'});expect(['供方并发','后台并发']).toContain(current.supplier_mark);expect(current.revision).not.toBe(seed.revision);
  });
 });
});
