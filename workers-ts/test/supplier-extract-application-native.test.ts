/** Actual App/JWT and independent restricted LOGINs, original-key admission.
 * Synthetic settled balances and local Admin metadata are not bank transfers. */
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import {createContainerFromDb,type Container} from '@/lib/di';
import {supplierExtract,supplierFlowingWater,systemAdmin,systemConfig,systemRole,systemSupplier} from '@/models/schema';
import {SupplierExtractApplicationService} from '@/services/supplier/SupplierExtractApplicationService';
import {AdminSupplierFinanceService} from '@/services/admin/AdminSupplierFinanceService';
import {lockSupplierFinance} from '@/services/supplier/SupplierFinanceLock';
import {md5} from '@/utils/jwt';
import {supplierExtractApplicationFixture} from './helpers/supplierExtractApplication';
import {supplierExtractReadPassword} from './helpers/supplierExtractRead';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{if(!wiring.container)throw Error('Missing owned application LOGIN');return wiring.container;}}));
const app=createApp(),path='/supplierapi/finance/supplier_extract',actor=(id=21)=>({id,supplierId:id===31?8:7,authVersion:md5(supplierExtractReadPassword),expiresAt:Math.floor(Date.now()/1000)+3600});
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier original withdrawal actual App and PG16',()=>{
 let f:Awaited<ReturnType<typeof supplierExtractApplicationFixture>>;
 beforeEach(async()=>{f=await supplierExtractApplicationFixture();vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No withdrawal provider I/O'));},30000);
 afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();await f?.close();}finally{wiring.container=undefined;vi.restoreAllMocks();}});
 async function request(suffix:string,body?:unknown,identity:'reader'|'viewer'|'denied'|'other'|'anonymous'='reader') {
  const response=await app.request(path+suffix,{method:body===undefined?'GET':'POST',headers:{...(identity==='anonymous'?{}:{Authorization:'Bearer '+f.tokens[identity]}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env);
  expect(response.headers.get('cache-control')).toContain('private, no-store');return response.json<{status:number;data:any}>();
 }
 async function quote(){const result=await request('/cash');expect(result.status).toBe(200);return result.data as {revision:string;available:string;can_apply:boolean;accounts:any};}
 const body=(revision:string,money='10.00',type='bank',uuid=randomUUID())=>({operation_id:uuid,revision,extract_type:type,money,mark:'原申请说明'});
 const operationPath=(id:string)=>'/application_operations/'+id;
 async function noWrite(work:()=>Promise<unknown>){const before=await f.snapshot(),sequence=await f.sequence(),result=await work();expect(await f.snapshot()).toEqual(before);expect(await f.sequence()).toEqual(sequence);return result;}
 it('reads exact9-key source and chosen-channel accounts in a real read-only seed',async()=>{
  await f.withLookup(async runtime=>{wiring.container=runtime.container;const seed=await noWrite(()=>request('/cash')) as {status:number;data:any};expect(seed).toMatchObject({status:200,data:{version:'supplier-extract-application-seed-v1',actor_id:21,supplier_id:7,available:'735.00',min_price:'5.50',max_price:'200.00',can_apply:true}});
   expect(Object.keys(seed.data).sort()).toEqual(['version','actor_id','supplier_id','revision','available','min_price','max_price','accounts','can_apply'].sort());expect(Object.keys(seed.data.accounts).sort()).toEqual(['alipay','bank','weixin']);expect(seed.data.accounts.bank).toEqual({bank_code:'0000622200099999',bank_address:'本机申请开户行',ready:true});expect(seed.data.accounts.alipay.ready).toBe(true);
  });
 });
 it('ignores an out-of-domain pm in the PHP incoming-minus-outgoing settled balance',async()=>{
  await f.db.insert(supplierFlowingWater).values({id:999,supplierId:7,orderId:'OWNED-INVALID-PM',number:'99.00',pm:2,status:1,type:1});
  await f.withLookup(async runtime=>{wiring.container=runtime.container;await noWrite(async()=>expect((await quote()).available).toBe('735.00'));});
 });
 it('rejects malformed scalar source accounts before emitting a seed or inserting an application',async()=>{
  await f.db.update(systemSupplier).set({bankAddress:'甲\n乙'}).where(eq(systemSupplier.id,7));
  await f.withWriter(async runtime=>{wiring.container=runtime.container;await noWrite(async()=>expect((await request('/cash')).status).toBe(503));});
 });
 it('commits exactly one actual application and immutable receipt while every other table stays unchanged',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await quote(),input=body(seed.revision,'25.50'),before=await f.snapshot();const result=await request('/cash',input);
   expect(result).toMatchObject({status:200,data:{version:'supplier-extract-application-receipt-v1',operation_id:input.operation_id,actor_id:21,supplier_id:7,state:'committed',result:{id:205,extract_type:'bank',extract_price:'25.50',balance:'709.50',bank_code:'0000622200099999',bank_address:'本机申请开户行',alipay_account:'',wechat:'',qrcode_url:'',supplier_mark:'原申请说明',status:0,pay_status:0}}});
   expect(Object.keys(result.data)).toHaveLength(7);expect(Object.keys(result.data.result)).toHaveLength(13);expect(result.data.request_hash).toMatch(/^[a-f0-9]{64}$/);
   const after=await f.snapshot();expect(after.supplier_extract).toHaveLength(before.supplier_extract.length+1);expect(after.supplier_extract_application_operation_v1).toHaveLength(1);
   const normalized={...after,supplier_extract:after.supplier_extract.filter((row:any)=>row.row.id!==205),supplier_extract_application_operation_v1:[]};expect(normalized).toEqual(before);
   await noWrite(async()=>{expect((await request(operationPath(input.operation_id))).data).toEqual(result.data);expect((await request('/cash',input)).data).toEqual(result.data);});
  });
 });
 it('serializes sameUUID samepayload from independent LOGIN sessions without a second reservation or sequence advance on replay',async()=>{
  await f.withWriter(async one=>f.withWriter(async two=>{const a=new SupplierExtractApplicationService(one.container,f.env.APP_KEY),b=new SupplierExtractApplicationService(two.container,f.env.APP_KEY),seed=await a.seed(actor()),input=body(seed.revision);
   const outcomes=await Promise.allSettled([a.execute(input,actor()),b.execute(input,actor())]);expect(outcomes.filter(row=>row.status==='fulfilled').length).toBeGreaterThanOrEqual(1);for(const row of outcomes)if(row.status==='rejected')expect(row.reason).toMatchObject({httpStatus:409});
   const receipt=await a.receipt(input.operation_id,actor());expect(receipt.state).toBe('committed');expect((await f.snapshot()).supplier_extract_application_operation_v1).toHaveLength(1);
   const seq=await f.sequence();expect(await a.execute(input,actor())).toEqual(receipt);expect(await b.execute(input,actor())).toEqual(receipt);expect(await f.sequence()).toEqual(seq);
  }));
 });
 it('serializes differentUUID requests against one remaining balance and refuses the stale second source',async()=>{
  await f.db.update(supplierFlowingWater).set({number:'365.00'}).where(eq(supplierFlowingWater.id,1));
  await f.withWriter(async one=>f.withWriter(async two=>{const a=new SupplierExtractApplicationService(one.container,f.env.APP_KEY),b=new SupplierExtractApplicationService(two.container,f.env.APP_KEY),seed=await a.seed(actor());expect(seed.available).toBe('100.00');
   const results=await Promise.allSettled([a.execute(body(seed.revision,'70.00'),actor()),b.execute(body(seed.revision,'70.00'),actor())]);expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);const rejected=results.find(row=>row.status==='rejected');expect(rejected?.status==='rejected'&&rejected.reason).toMatchObject({httpStatus:409});expect((await a.seed(actor())).available).toBe('30.00');expect((await f.snapshot()).supplier_extract_application_operation_v1).toHaveLength(1);
  }));
 });
 it.each(['settings','limits','balance'])('rejects actual stale %s source without partial reservation',async change=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await quote();
   if(change==='settings')await f.db.update(systemSupplier).set({bankAddress:'实际已改开户行'}).where(eq(systemSupplier.id,7));
   if(change==='limits')await f.db.update(systemConfig).set({value:'199.00'}).where(eq(systemConfig.id,2));
   if(change==='balance')await f.db.update(supplierFlowingWater).set({number:'1001.00'}).where(eq(supplierFlowingWater.id,1));
   await noWrite(async()=>expect((await request('/cash',body(seed.revision))).status).toBe(409));
  });
 });
 it.each(['bank','alipay','weixin'])('requires complete PHP %s account and QR snapshot for new admission',async channel=>{
  await f.db.update(systemSupplier).set(channel==='bank'?{bankCode:'0'}:channel==='alipay'?{alipayQrcodeUrl:''}:{wechatQrcodeUrl:'   '}).where(eq(systemSupplier.id,7));
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await quote();expect(seed.accounts[channel].ready).toBe(false);await noWrite(async()=>expect((await request('/cash',body(seed.revision,'10.00',channel))).status).toBe(400));});
 });
 it('matches PHP max0 denial and invalid config failure while min0 still admits exact positive cents',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;
   await f.db.update(systemConfig).set({value:'0'}).where(eq(systemConfig.id,2));const zero=await quote();expect(zero.can_apply).toBe(false);await noWrite(async()=>expect((await request('/cash',body(zero.revision))).status).toBe(400));
   await f.db.update(systemConfig).set({value:'invalid'}).where(eq(systemConfig.id,2));await noWrite(async()=>expect((await request('/cash')).status).toBe(503));
   await f.db.update(systemConfig).set({value:'200'}).where(eq(systemConfig.id,2));await f.db.update(systemConfig).set({value:'0'}).where(eq(systemConfig.id,1));const min=await quote();expect((await request('/cash',body(min.revision,'0.01'))).status).toBe(200);
  });
 });
 it('recovers the original result after Admin note approval voucher current settings limits balance key and manage changes',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await quote(),input=body(seed.revision),saved=await request('/cash',input),id=saved.data.result.id;expect(saved.status).toBe(200);
   const admin=new AdminSupplierFinanceService(createContainerFromDb(f.db));await admin.updateMark(id,101,{mark:'后台合法新描述',expected_supplier_mark:'原申请说明'});await admin.review(id,101,{type:1});await admin.transfer(id,101,{voucher_title:'本机凭证登记',voucher_image:'/owned-media/new.png'});
   await f.db.update(systemSupplier).set({bankCode:'NEW-ACCOUNT',bankAddress:'新开户行'}).where(eq(systemSupplier.id,7));await f.db.update(systemConfig).set({value:'invalid'}).where(eq(systemConfig.id,2));await f.db.update(supplierFlowingWater).set({number:'1001.00'}).where(eq(supplierFlowingWater.id,1));await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));
   await noWrite(async()=>{expect((await request(operationPath(input.operation_id))).data).toEqual(saved.data);expect((await request('/cash',input)).data).toEqual(saved.data);const changedKey=new SupplierExtractApplicationService(runtime.container,'rotated-key');expect(await changedKey.receipt(input.operation_id,actor())).toEqual(saved.data);});
   expect(saved.data.result).toMatchObject({supplier_mark:'原申请说明',status:0,pay_status:0});
  });
 });
 it('does not recreate an original UUID after Admin refusal releases its reservation',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await quote(),input=body(seed.revision),saved=await request('/cash',input);await new AdminSupplierFinanceService(createContainerFromDb(f.db)).review(saved.data.result.id,101,{type:0,message:'本机拒绝'});
   expect((await quote()).available).toBe('735.00');await noWrite(async()=>expect((await request('/cash',input)).data).toEqual(saved.data));
  });
 });
 it('rejects changed sameUUID payloads and forged actors while keeping reads private and unkeyed public writes explicitly closed',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await quote(),input=body(seed.revision),saved=await request('/cash',input);expect(saved.status).toBe(200);
   for(const modified of [{money:'11.00'},{mark:'替换原文'},{extract_type:'alipay'},{revision:'b'.repeat(64)}])await noWrite(async()=>expect((await request('/cash',{...input,...modified})).status).toBe(409));
   for(const invalid of [{extract_type:'bank',money:'10.00',mark:''},{...input,supplier_id:8},{...input,status:1}])await noWrite(async()=>expect((await request('/cash',invalid)).status).toBe(400));
   await noWrite(async()=>{expect((await request('/cash',body(seed.revision),'viewer')).status).toBe(400011);expect((await request('/cash',input,'other')).status).toBe(400011);expect((await request(operationPath(input.operation_id),undefined,'other')).data.state).toBe('unknown');expect((await request(operationPath(input.operation_id)+'/resolve',{},'other')).status).toBe(400011);expect((await request('/cash?unknown=1')).status).toBe(400);expect((await request('/cash',undefined,'anonymous')).status).toBe(410000);});
  });
 });
 it('keeps unknownGET read-only and explicitly fences a delayed original UUID as not_applied even after manage withdrawal',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await quote(),input=body(seed.revision);await noWrite(async()=>expect((await request(operationPath(input.operation_id))).data).toMatchObject({state:'unknown',request_hash:'',result:null}));
   await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));expect((await request(operationPath(input.operation_id)+'/resolve',{})).data).toMatchObject({state:'not_applied',request_hash:'',result:null});
   await noWrite(async()=>{expect((await request('/cash',input)).status).toBe(409);expect((await request(operationPath(input.operation_id)+'/resolve',{})).data.state).toBe('not_applied');});
  });
 });
 it('never seals not_applied while an independent original request owns its UUID and waits on the finance mutex',async()=>{
  await f.withWriter(async one=>f.withWriter(async two=>{const a=new SupplierExtractApplicationService(one.container,f.env.APP_KEY),b=new SupplierExtractApplicationService(two.container,f.env.APP_KEY),seed=await a.seed(actor()),input=body(seed.revision),rollback=new Error('owned finance release');
   let pending:Promise<{value?:Awaited<ReturnType<typeof a.execute>>;error?:unknown}>|undefined;
   await expect(f.db.transaction(async owner=>{await lockSupplierFinance(owner,7);pending=a.execute(input,actor()).then(value=>({value}),error=>({error}));let held=false;
    for(let tries=0;tries<100&&!held;tries++){const[row]=await owner.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=${one.pid} AND classid=731629 AND granted) AS held`);held=row.held===true;if(!held)await new Promise(done=>setTimeout(done,10));}expect(held).toBe(true);
    await expect(b.resolve(input.operation_id,actor())).rejects.toMatchObject({httpStatus:409});throw rollback;
   })).rejects.toBe(rollback);
   const done=await pending!;expect(done.error).toBeUndefined();expect(done.value?.state).toBe('committed');expect((await b.receipt(input.operation_id,actor())).state).toBe('committed');expect((await f.snapshot()).supplier_extract_application_operation_v1).toHaveLength(1);
  }));
 });
 it('fails NOWAIT on an uncommitted live authority change and admits after rollback without a partial row',async()=>{
  await f.withWriter(async runtime=>{const service=new SupplierExtractApplicationService(runtime.container,f.env.APP_KEY),seed=await service.seed(actor()),input=body(seed.revision),before=await f.snapshot(),rollback=new Error('owned auth rollback');
   await expect(f.db.transaction(async owner=>{await owner.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));await expect(service.execute(input,actor())).rejects.toMatchObject({httpStatus:409});throw rollback;})).rejects.toBe(rollback);
   expect(await f.snapshot()).toEqual(before);expect((await service.execute(input,actor())).state).toBe('committed');
  });
 });
 it('rejects current role password and expiry changes inside the service before admitting a new application',async()=>{
  await f.withWriter(async runtime=>{const service=new SupplierExtractApplicationService(runtime.container,f.env.APP_KEY),seed=await service.seed(actor());
   await expect(service.execute(body(seed.revision),{...actor(),expiresAt:1})).rejects.toMatchObject({code:410001});await f.db.update(systemAdmin).set({pwd:'changed-owned-password'}).where(eq(systemAdmin.id,21));const before=await f.snapshot();await expect(service.execute(body(seed.revision),actor())).rejects.toMatchObject({code:410001});expect(await f.snapshot()).toEqual(before);
  });
 });
 it('rolls back the application and operation when a real deferred financial-row writer changes its committed proof',async()=>{
  await f.exec("CREATE FUNCTION public.owned_extract_late() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$BEGIN UPDATE public.supplier_extract SET balance=balance+1 WHERE id=NEW.id; RETURN NEW; END$$; REVOKE ALL ON FUNCTION public.owned_extract_late() FROM PUBLIC; CREATE CONSTRAINT TRIGGER owned_extract_late AFTER INSERT ON public.supplier_extract DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.owned_extract_late()");
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await quote(),before=await f.snapshot();expect((await request('/cash',body(seed.revision))).status).toBe(503);expect(await f.snapshot()).toEqual(before);});
 });
 it.each(['extractPrice','balance','bankCode','supplierId','mark','addTime'])('refuses a receipt after actual immutable application field %s is changed',async field=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await quote(),input=body(seed.revision),saved=await request('/cash',input),id=saved.data.result.id;
   const changes:Record<string,unknown>={extractPrice:'11.00',balance:'724.00',bankCode:'changed-account',supplierId:8,mark:'unpublished internal mutation',addTime:1800000000};await f.db.update(supplierExtract).set({[field]:changes[field]}).where(eq(supplierExtract.id,id));await noWrite(async()=>expect((await request(operationPath(input.operation_id))).status).toBe(503));
  });
 });
 it.each(['status','payStatus','adminId','failTime','payTime','supplierMark','voucherImage'])('refuses invalid mutable current application domain %s instead of treating corruption as an allowed workflow change',async field=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await quote(),input=body(seed.revision),saved=await request('/cash',input);expect(saved.status).toBe(200);
   const changes:Record<string,unknown>={status:9,payStatus:9,adminId:-1,failTime:-1,payTime:-1,supplierMark:'坏\u0001描述',voucherImage:'bad\nimage'};
   await f.db.update(supplierExtract).set({[field]:changes[field]}).where(eq(supplierExtract.id,saved.data.result.id));await noWrite(async()=>expect((await request(operationPath(input.operation_id))).status).toBe(503));
  });
 });
});
