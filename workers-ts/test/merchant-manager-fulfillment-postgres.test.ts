import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '@/lib/di';
import type { AppVariables, Env } from '@/env';
import { authMiddleware } from '@/middleware/auth';
import { createToken, md5 } from '@/utils/jwt';
import { abandonOperation, manualDelivery, operationOutcome, saveRemark, splitDelivery } from '@/controllers/api/v1/StoreManagerOrderOperationController';
import { runManagerOrderOperation } from '@/migrations/runManagerOrderOperation';
import { ManagerOrderOperationRequest, type ManagerOperationInput, type ManagerOperationContext } from '@/services/store/ManagerOrderOperationRequest';
import { parseManagerDelivery, parseManagerRemark, StoreManagerOrderOperationService, storeManagerFulfillmentActions } from '@/services/store/StoreManagerOrderOperationService';
import { merchantOrderRevision, requireStoreManagerScope } from '@/services/store/StoreManagerScope';
import { deliveryService, expressCompany, orderWaybillJob, storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderInvoiceAllocation, storeOrderInvoiceEvidence, storeOrderOutbox, storeOrderRefund, storeOrderStatus, storePink, supplierFlowingWater, systemStore, systemStoreStaff, user } from '@/models/schema';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers, waitForFinanceBlock } from './helpers/financePeers';
import { createMerchantManagerRuntime } from './helpers/merchantManagerRuntime';

const manual={type:1,express_record_type:1,delivery_name:'本地快递',delivery_code:'LOCAL',delivery_id:'LOCAL-ONLY-001'};
const env={APP_KEY:'merchant-manager-local-only-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',CONFIG_KV:{get:async()=>null,put:async()=>{}}} as unknown as Env;
const pwd='a'.repeat(32),manager={uid:11,authVersion:md5(pwd),expiresAt:2147483647};

describe('merchant manager strict fulfillment payloads',()=>{
  it('accepts only explicit channels and rejects provider mode, forged agent fields and coercive quantities',()=>{
    expect(parseManagerRemark({remark:' 实际备注 '})).toBe('实际备注');
    expect(parseManagerRemark({remark:' 第一行\n第二行 '})).toBe('第一行\n第二行');
    expect(parseManagerDelivery(manual,false).delivery.deliveryType).toBe('express');
    for(const body of [{...manual,type:true},{...manual,type:'1'},{...manual,express_record_type:2},{...manual,uid:22},{type:2,delivery_type:1,delivery_uid:33,delivery_name:'伪造配送员'},{type:2,delivery_type:2,delivery_uid:33},{type:3,fictitious_content:'\n'},{...manual,cart_ids:[{cart_id:'1',cart_num:true}]},{...manual,cart_ids:[{cart_id:'1',cart_num:'1'}]}]) expect(()=>parseManagerDelivery(body,Object.hasOwn(body,'cart_ids'))).toThrow();
    expect(()=>parseManagerRemark({remark:'x',store_id:999})).toThrow();
    for(const content of ['x\u0000y','x\u000by','x\u001by','x\u007fy'])expect(()=>parseManagerDelivery({type:3,fictitious_content:content},false)).toThrow();
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native merchant manager real SQL fulfillment and user JWT boundary',()=>{
  let f:Awaited<ReturnType<typeof financePostgres>>,runtime:Awaited<ReturnType<typeof createMerchantManagerRuntime>>,guard:ReturnType<typeof vi.spyOn>;
  const service=(db=runtime.db)=>new StoreManagerOrderOperationService(createContainerFromDb(db),env);
  const ledger=(db=runtime.db)=>new ManagerOrderOperationRequest(createContainerFromDb(db));
  const ctx=(key=crypto.randomUUID()):ManagerOperationContext=>({actor:manager,request_key:key});
  const current=async(id=1)=>{const rows=await f.db.select().from(storeOrder).where(eq(storeOrder.id,id));return rows[0];};
  const intent=async(payload:unknown,id=1,storeId=77):Promise<ManagerOperationInput>=>({version:'merchant-order-operation-v1',store_id:storeId,scope_key:(await requireStoreManagerScope(f.db,11,storeId)).scope_key,order_id:id,expected_order_revision:await merchantOrderRevision(await current(id)),payload:payload as ManagerOperationInput['payload']});
  const state=async()=>({orders:await f.db.select().from(storeOrder).orderBy(storeOrder.id),carts:await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),statuses:await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),outbox:await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id),flows:await f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id)});
  beforeAll(async()=>{
    const tables=[user,systemStore,systemStoreStaff,deliveryService,expressCompany,storeOrder,storeOrderCartInfo,storeOrderRefund,storeOrderStatus,storeOrderOutbox,orderWaybillJob,storePink,storeOrderInvoice,storeOrderInvoiceAllocation,storeOrderInvoiceEvidence,supplierFlowingWater];
    f=await financePostgres(tables,{namespace:'public'});
    // Run the production DDL in this new registered local database only. This
    // fixture owner is not an assertion about production runtime ACL rollout.
    await runManagerOrderOperation(f.db);
    await f.exec('CREATE UNIQUE INDEX merchant_notice_event_key ON store_order_outbox(event_key)');
    runtime=await createMerchantManagerRuntime(f.db,tables,{installScopeLocks:true});
  },30000);
  afterAll(async()=>{try{await runtime?.close();}finally{await f?.close();}},30000);
  beforeEach(async()=>{
    guard=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No merchant manager external HTTP'));
    await f.reset();await f.exec('TRUNCATE manager_order_operation_request');
    await f.db.insert(user).values([{uid:11,pwd,nickname:'实际店长'},{uid:22,pwd,nickname:'实际顾客'},{uid:33,pwd,nickname:'实际配送员'}]);
    await f.db.insert(systemStore).values([{id:77,name:'管理门店',isStore:1,isShow:1},{id:88,name:'另一管理门店',isStore:1,isShow:1},{id:999,name:'越权门店',isStore:1,isShow:1}]);
    await f.db.insert(systemStoreStaff).values([{id:1,uid:11,storeId:77,isManager:1,orderStatus:1,verifyStatus:0},{id:2,uid:11,storeId:88,isAdmin:1,orderStatus:1,verifyStatus:0}]);
    await f.db.insert(storeOrder).values([{id:1,orderId:'MANAGER-LOCAL',unique:'manager-local',uid:22,storeId:77,supplierId:0,paid:1,status:0,shippingType:1,totalNum:3,totalPrice:'30.00',payPrice:'30.00',payType:'yue',realName:'实际顾客',userPhone:'13000000022',userAddress:'本地测试地址'},{id:2,orderId:'FOREIGN-LOCAL',unique:'foreign-local',uid:11,storeId:999,paid:1,status:0,payPrice:'999.00'},{id:3,orderId:'SECOND-LOCAL',unique:'second-local',uid:22,storeId:88,paid:1,status:0,payPrice:'80.00'}]);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_order','id'),3,true)");
    await f.db.insert(storeOrderCartInfo).values({id:1,oid:1,uid:22,productId:70,cartId:'1',cartNum:3,surplusNum:3,splitSurplusNum:3,settlePrice:'2.00',cartInfo:'{"id":"1","cart_num":3,"truePrice":"10.00","productInfo":{"id":70,"store_name":"实际商品"}}',unique:'cart-local'});
    await f.exec("SELECT setval(pg_get_serial_sequence('store_order_cart_info','id'),1,true)");
    await f.db.insert(expressCompany).values({id:1,name:'本地快递',code:'LOCAL',isShow:1,status:1});
    await f.db.insert(deliveryService).values({id:1,uid:33,type:1,relationId:77,status:1,isDel:0,nickname:'门店实名配送',phone:'13000000033'});
  },30000);
  afterEach(()=>{try{expect(guard).not.toHaveBeenCalled();}finally{guard?.mockRestore();}});
  it('writes a real manager audit once and returns the immutable owned PII-free receipt on concurrent replay',async()=>{
    const input=await intent({remark:'实际备注'}),context=ctx();
    const results=await Promise.all([runtime.withPeer(db=>service(db).saveRemark(context,input)),runtime.withPeer(db=>service(db).saveRemark(context,input))]);
    expect(results.map(row=>row.replayed).sort()).toEqual([false,true]);expect(results[0].receipt).toEqual(results[1].receipt);
    expect(await current()).toMatchObject({remark:'实际备注'});expect((await state()).statuses).toHaveLength(1);
    expect(results[0].receipt).toMatchObject({actor_uid:11,staff_id:1,store_id:77,kind:'remark',outcome:'remark-saved',evidence:{changed:true}});
    expect(JSON.stringify(results[0].receipt)).not.toMatch(/实际备注|实际顾客|13000000022|本地测试地址|pwd/);
    await expect(service().saveRemark(context,{...input,payload:{remark:'不同备注'}})).rejects.toThrow('不同管理操作');
  });
  it('does not infer an unknown outcome from absence and permits same-key abandon without order mutations',async()=>{
    const context=ctx(),input=await intent(manual),before=await state();
    expect(await ledger().getOutcome(manager,context.request_key)).toBeNull();
    const abandoned=await ledger().abandon('manual_delivery',context,input);expect(abandoned.outcome).toBe('abandoned');
    const retry=await service().delivery('manual_delivery',context,input);expect(retry).toMatchObject({replayed:true,receipt:abandoned});expect(await state()).toEqual(before);
  });
  it('recovers only owned minimal receipts after manager removal without granting another write or leaking order details',async()=>{
    const context=ctx(),input=await intent({remark:'实际备注'}),first=await service().saveRemark(context,input);
    await f.db.update(systemStoreStaff).set({orderStatus:0}).where(eq(systemStoreStaff.id,1));
    expect(await ledger().getOutcome(manager,context.request_key)).toEqual(first.receipt);
    expect(await ledger().getOutcome({...manager,uid:22},context.request_key)).toBeNull();
    expect((await service().saveRemark(ctx(),input)).receipt.outcome).toBe('rollback-rejected');
    expect((await state()).statuses).toHaveLength(1);
  });
  it('rechecks current account password status soft deletion and expiration before receipt recovery',async()=>{
    const context=ctx(),input=await intent({remark:'x'});await service().saveRemark(context,input);
    await expect(ledger().getOutcome({...manager,expiresAt:1},context.request_key)).rejects.toThrow('会话已失效');
    for(const patch of[{pwd:'b'.repeat(32)},{status:0},{isDel:1},{deleteTime:new Date()}]){await f.db.update(user).set({pwd,status:1,isDel:0,deleteTime:null,...patch}).where(eq(user.uid,11));await expect(ledger().getOutcome(manager,context.request_key)).rejects.toThrow('会话已失效');}
  });
  it.each(['foreign-store','changed-store','changed-revision','duplicate-role','writeoff-only'] as const)('fences %s with a durable rejection and no order/audit/outbox writes',async(kind)=>{
    let input=await intent(manual);if(kind==='foreign-store')input={...input,order_id:2};
    if(kind==='changed-store')await f.db.update(storeOrder).set({storeId:88}).where(eq(storeOrder.id,1));
    if(kind==='changed-revision')await f.db.update(storeOrder).set({remark:'已被真实对端修改'}).where(eq(storeOrder.id,1));
    if(kind==='duplicate-role')await f.db.insert(systemStoreStaff).values({id:3,uid:11,storeId:77,isManager:1,orderStatus:1});
    if(kind==='writeoff-only')await f.db.update(systemStoreStaff).set({isManager:0,isAdmin:0,orderStatus:0,verifyStatus:1}).where(eq(systemStoreStaff.id,1));
    const before=await state(),context=ctx(),result=await service().delivery('manual_delivery',context,input);
    expect(result.receipt.outcome).toBe('rollback-rejected');expect(await state()).toEqual(before);expect(await ledger().getOutcome(manager,context.request_key)).toEqual(result.receipt);
  });
  it('serializes actual different operations at the order resource and rejects the stale revision without overwriting a successful receipt',async()=>{
    const input=await intent({remark:'当前版本备注'});await service().saveRemark(ctx(),input);
    const deliveryInput={...input,payload:manual},context=ctx(),before=await state();
    const result=await service().delivery('manual_delivery',context,deliveryInput);expect(result.receipt.outcome).toBe('rollback-rejected');expect(await state()).toEqual(before);
    expect((await service().delivery('manual_delivery',context,deliveryInput)).receipt).toEqual(result.receipt);
  });
  it('uses current authority after a real order lock wait while another SQL session revokes management',async()=>{
    const input=await intent(manual);
    await withFinancePeers(f.db,async([holder,,observer])=>runtime.withPeer(async(writerDb,writerPid)=>{
      let release!:()=>void,locked!:()=>void;const ready=new Promise<void>(r=>{locked=r;}),gate=new Promise<void>(r=>{release=r;});
      const holding=withTx(createContainerFromDb(holder.db),async(tx)=>{await tx.select().from(storeOrder).where(eq(storeOrder.id,1)).for('update');locked();await gate;});await ready;
      const operation=service(writerDb).delivery('manual_delivery',ctx(),input);
      try{await waitForFinanceBlock(observer.db,writerPid,holder.pid);await f.db.update(systemStoreStaff).set({orderStatus:0}).where(eq(systemStoreStaff.id,1));}finally{release();await holding;}
      expect((await operation).receipt.outcome).toBe('rollback-rejected');expect((await current()).status).toBe(0);expect((await state()).outbox).toEqual([]);
    }));
  });
  it('records actual express shipment plus notification atomically and never repeats it after stale original revision',async()=>{
    const context=ctx(),input=await intent(manual),result=await service().delivery('manual_delivery',context,input);
    expect(result.receipt).toMatchObject({outcome:'delivery-recorded',evidence:{split:false,order_id:1,remaining_order_id:null}});
    expect(await current()).toMatchObject({status:1,deliveryType:'express',deliveryCode:'LOCAL',deliveryId:'LOCAL-ONLY-001'});
    const first=await state();expect(first.outbox).toHaveLength(1);expect(first.statuses.map(row=>row.changeType)).toEqual(['delivery_goods','manager_manual_delivery']);
    expect((await service().delivery('manual_delivery',context,input)).replayed).toBe(true);expect(await state()).toEqual(first);
  });
  it('freezes the original body before a real order-lock wait so an outside mutable object cannot change the admitted intent',async()=>{
    const original={remark:'冻结的原始备注'},input=await intent(original);
    await withFinancePeers(f.db,async([holder,,observer])=>runtime.withPeer(async(writerDb,writerPid)=>{
      let release!:()=>void,locked!:()=>void;const ready=new Promise<void>(r=>{locked=r;}),gate=new Promise<void>(r=>{release=r;});
      const holding=withTx(createContainerFromDb(holder.db),async tx=>{await tx.select().from(storeOrder).where(eq(storeOrder.id,1)).for('update');locked();await gate;});await ready;
      const operation=service(writerDb).saveRemark(ctx(),input);
      try{await waitForFinanceBlock(observer.db,writerPid,holder.pid);original.remark='未经准入的外部修改';}finally{release();await holding;}
      expect((await operation).receipt.outcome).toBe('remark-saved');expect((await current()).remark).toBe('冻结的原始备注');
    }));
  });
  it('retains unknown after a real NOWAIT cart conflict and safely resumes only the same request after the peer releases unchanged evidence',async()=>{
    const input=await intent(manual),context=ctx(),before=await state();
    await withFinancePeers(f.db,async([holder])=>runtime.withPeer(async(writerDb)=>{
      let release!:()=>void,locked!:()=>void;const ready=new Promise<void>(r=>{locked=r;}),gate=new Promise<void>(r=>{release=r;});
      const holding=withTx(createContainerFromDb(holder.db),async tx=>{await tx.update(storeOrderCartInfo).set({cartNum:3}).where(eq(storeOrderCartInfo.id,1));locked();await gate;});await ready;
      try{await expect(service(writerDb).delivery('manual_delivery',context,input)).rejects.toThrow();expect(await ledger().getOutcome(manager,context.request_key)).toBeNull();expect(await state()).toEqual(before);}finally{release();await holding;}
    }));
    expect((await service().delivery('manual_delivery',context,input)).receipt.outcome).toBe('delivery-recorded');expect((await state()).outbox).toHaveLength(1);
  });
  it.each(['unpaid','pickup','shipping4','already-shipped','card','virtual-express','open-refund','foreign-cart','duplicate-cart','disabled-carrier','mismatched-carrier','future-presale','incomplete-pink','active-waybill'] as const)('keeps %s unavailable or rejects before any fulfillment write',async(kind)=>{
    if(kind==='unpaid')await f.db.update(storeOrder).set({paid:0});if(kind==='pickup')await f.db.update(storeOrder).set({shippingType:2});if(kind==='shipping4')await f.db.update(storeOrder).set({shippingType:4});if(kind==='already-shipped')await f.db.update(storeOrder).set({status:1});if(kind==='card')await f.db.update(storeOrder).set({productType:1});if(kind==='virtual-express')await f.db.update(storeOrder).set({productType:3});
    if(kind==='open-refund')await f.db.insert(storeOrderRefund).values({storeOrderId:1,uid:22,storeId:77,supplierId:0,refundType:1});
    if(kind==='foreign-cart')await f.db.update(storeOrderCartInfo).set({uid:11});if(kind==='duplicate-cart')await f.db.insert(storeOrderCartInfo).values({oid:1,uid:22,cartId:'1',productId:70});
    if(kind==='disabled-carrier')await f.db.update(expressCompany).set({status:0});if(kind==='mismatched-carrier')await f.db.update(expressCompany).set({name:'不同实际名称'});
    if(kind==='future-presale'){await f.db.update(storeOrder).set({type:6}).where(eq(storeOrder.id,1));await f.db.update(storeOrderCartInfo).set({cartInfo:'{"productInfo":{"id":70,"presale_end_time":2147483647}}'});}
    if(kind==='incomplete-pink')await f.db.update(storeOrder).set({type:3,pinkId:123}).where(eq(storeOrder.id,1));
    if(kind==='active-waybill')await f.db.insert(orderWaybillJob).values({id:1,eventKey:'old-real-job',requestKey:'11111111-1111-4111-8111-111111111111',requestHash:'a'.repeat(64),orderId:1,rootOrderId:1,orderNo:'MANAGER-LOCAL',actorType:'admin',actorId:1,supplierId:0,storeId:77,fulfillmentMode:'whole',carrierId:1,carrierCode:'LOCAL',carrierName:'本地快递',templateId:'local-template',senderName:'本地发件',senderPhone:'13000000011',senderAddress:'本地测试',status:'UNKNOWN'});
    const input=await intent(manual),before=await state();expect((await service().delivery('manual_delivery',ctx(),input)).receipt.outcome).toBe('rollback-rejected');expect(await state()).toEqual(before);
  });
  it('derives delivery name and phone from the unique active current-store agent and rejects another-store agent',async()=>{
    const input=await intent({type:2,delivery_type:1,delivery_uid:33});expect((await service().delivery('manual_delivery',ctx(),input)).receipt.outcome).toBe('delivery-recorded');
    expect(await current()).toMatchObject({deliveryType:'send',deliveryUid:33,deliveryName:'门店实名配送',deliveryId:'13000000033',verifyCode:expect.stringMatching(/^\d{12}$/)});
    await f.db.update(storeOrder).set({status:0,deliveryType:'',deliveryUid:0,deliveryName:'',deliveryId:''}).where(eq(storeOrder.id,1));
    await f.db.update(deliveryService).set({relationId:999});const before=await state();expect((await service().delivery('manual_delivery',ctx(),await intent({type:2,delivery_type:1,delivery_uid:33}))).receipt.outcome).toBe('rollback-rejected');expect(await state()).toEqual(before);
  });
  it('rejects duplicate current-store delivery identities rather than trusting either phone',async()=>{
    await f.db.insert(deliveryService).values({id:2,uid:33,type:1,relationId:77,status:1,isDel:0,nickname:'重复配送',phone:'13000000999'});
    const before=await state();expect((await service().delivery('manual_delivery',ctx(),await intent({type:2,delivery_type:1,delivery_uid:33}))).receipt.outcome).toBe('rollback-rejected');expect(await state()).toEqual(before);
  });
  it('uses manual virtual policy for whole delivery and rejects virtual split delivery',async()=>{
    await f.db.update(storeOrder).set({productType:3}).where(eq(storeOrder.id,1));
    const split=await intent({type:3,fictitious_content:'本地交付内容',cart_ids:[{cart_id:'1',cart_num:1}]});expect((await service().delivery('split_delivery',ctx(),split)).receipt.outcome).toBe('rollback-rejected');
    expect((await service().delivery('manual_delivery',ctx(),await intent({type:3,fictitious_content:'本地交付内容'}))).receipt.outcome).toBe('delivery-recorded');expect(await current()).toMatchObject({deliveryType:'fictitious',fictitiousContent:'本地交付内容'});
  });
  it('preserves the entire supported 500-character virtual delivery while keeping the SQL audit within its actual column limit',async()=>{
    await f.db.update(storeOrder).set({productType:3}).where(eq(storeOrder.id,1));
    const content='实际虚拟内容'.repeat(100).slice(0,500),result=await service().delivery('manual_delivery',ctx(),await intent({type:3,fictitious_content:content}));
    expect(result.receipt.outcome).toBe('delivery-recorded');expect((await current()).fictitiousContent).toBe(content);
    const rows=(await state()).statuses;expect(rows.find(row=>row.changeType==='delivery_fictitious')?.changeMessage.length).toBe(256);expect(JSON.stringify(result.receipt)).not.toContain(content);
  });
  it('keeps legacy textarea line breaks in actual remark and virtual delivery, with the original request receipt stable on replay',async()=>{
    const remark=' 第一行\n第二行\t说明 ',context=ctx(),body=await intent({remark});
    const saved=await service().saveRemark(context,body);
    expect((await current()).remark).toBe(remark.trim());expect(await service().saveRemark(context,body)).toEqual({receipt:saved.receipt,replayed:true});
    await f.db.update(storeOrder).set({productType:3}).where(eq(storeOrder.id,1));
    const content=' 下载链接：https://example.test/file\r\n提取码：CINA\n备注\t说明 ',deliveryContext=ctx(),deliveryBody=await intent({type:3,fictitious_content:content});
    const delivered=await service().delivery('manual_delivery',deliveryContext,deliveryBody);
    expect(delivered.receipt.outcome).toBe('delivery-recorded');expect((await current()).fictitiousContent).toBe(content.trim());
    expect(await service().delivery('manual_delivery',deliveryContext,deliveryBody)).toEqual({receipt:delivered.receipt,replayed:true});
    expect((await state()).outbox).toHaveLength(1);expect(JSON.stringify(delivered.receipt)).not.toContain('CINA');
  });
  it('uses a true ordinary LOGIN that cannot rewrite staff authority or mutate committed operation receipts',async()=>{
    const context=ctx();await service().saveRemark(context,await intent({remark:'实际角色权限核对'}));
    const [identity]=await runtime.db.execute<{role:string;session:string}>(sql`SELECT current_user AS role,session_user AS session`);expect(identity).toEqual({role:runtime.role,session:runtime.role});
    await expect(runtime.db.execute(sql`UPDATE system_store_staff SET is_manager=0 WHERE id=1`)).rejects.toThrow();
    for(const statement of[sql`UPDATE manager_order_operation_request SET outcome='abandoned'`,sql`DELETE FROM manager_order_operation_request`,sql`TRUNCATE manager_order_operation_request`])await expect(runtime.db.execute(statement)).rejects.toThrow();
    expect((await ledger().getOutcome(manager,context.request_key))?.outcome).toBe('remark-saved');
  });
  it('rejects oversized, encoded or non-JSON HTTP bodies before any operation admission or business mutation',async()=>{
    const app=new Hono<{Bindings:Env;Variables:AppVariables}>();
    app.use('*',async(c,next)=>{c.set('container',createContainerFromDb(runtime.db));await next();});app.use('*',authMiddleware({force:true}));
    app.onError((error,c)=>c.json({error:error.message},400));app.post('/remark',saveRemark);
    const token=(await createToken(11,'api',md5(pwd),env.APP_KEY)).token,before=await state(),context=ctx(),body=JSON.stringify(await intent({remark:'HTTP限定'}));
    for(const sample of [{type:'text/plain',body,encoding:''},{type:'application/json',body,encoding:'gzip'},{type:'application/json',body:' '.repeat(262145)+body,encoding:''},{type:'application/json',body:'{',encoding:''}]){
      const response=await app.request('/remark',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':sample.type,'Content-Encoding':sample.encoding,'Idempotency-Key':context.request_key},body:sample.body},env);expect(response.status).toBe(400);
      expect(await state()).toEqual(before);expect(await ledger().getOutcome(manager,context.request_key)).toBeNull();
    }
  });
  it('performs a real partial split preserving total money quantities store ownership and exactly one durable receipt/outbox',async()=>{
    const context=ctx(),input=await intent({...manual,cart_ids:[{cart_id:'1',cart_num:1}]}),result=await service().delivery('split_delivery',context,input);
    expect(result.receipt.outcome).toBe('delivery-recorded');expect(result.receipt.evidence.split).toBe(true);
    const rows=(await state()).orders.filter(row=>row.pid===1);expect(rows).toHaveLength(2);expect(rows.reduce((n,row)=>n+Number(row.payPrice),0)).toBe(30);expect(rows.reduce((n,row)=>n+row.totalNum,0)).toBe(3);expect(rows.every(row=>row.storeId===77&&row.uid===22)).toBe(true);
    expect(await current()).toMatchObject({pid:-1});expect((await state()).outbox).toHaveLength(1);
    const before=await state();expect((await service().delivery('split_delivery',context,input)).replayed).toBe(true);expect(await state()).toEqual(before);
  });
  it('keeps read availability side-effect-free within a real readonly snapshot',async()=>{
    const before=await state();await withTx(createContainerFromDb(runtime.db),async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);const scope=await requireStoreManagerScope(tx,11,77),order=(await tx.select().from(storeOrder).where(eq(storeOrder.id,1)))[0];expect(await storeManagerFulfillmentActions(tx,scope,order)).toMatchObject({remark:{available:true},manual_delivery:{available:true},electronic_waybill:{available:false}});});expect(await state()).toEqual(before);
  });
  it('exercises actual signed user JWT middleware with native SQL handlers and rejects Admin tokens or forged actor payloads',async()=>{
    const app=new Hono<{Bindings:Env;Variables:AppVariables}>();
    app.use('*',async(c,next)=>{c.set('container',createContainerFromDb(runtime.db));await next();});app.use('*',authMiddleware({force:true}));
    app.onError((error,c)=>c.json({error:error.message},400));app.post('/store/manager/order/remark',saveRemark);app.post('/store/manager/order/delivery',manualDelivery);app.post('/store/manager/order/split_delivery',splitDelivery);app.get('/store/manager/order/operation/:requestKey',operationOutcome);app.post('/store/manager/order/operation/abandon/:kind',abandonOperation);
    const userToken=(await createToken(11,'api',md5(pwd),env.APP_KEY)).token,adminToken=(await createToken(11,'admin',md5(pwd),env.APP_KEY)).token,context=ctx(),input=await intent({remark:'JWT真实备注'});
    const post=(token:string,body:unknown=input)=>app.request('/store/manager/order/remark',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'Idempotency-Key':context.request_key},body:JSON.stringify(body)},env);
    expect((await post(adminToken)).status).toBe(400);expect((await post(userToken,{...input,actor_uid:22})).status).toBe(400);
    const response=await post(userToken);expect(response.headers.get('Cache-Control')).toBe('private, no-store');expect(await response.json()).toMatchObject({status:200,data:{receipt:{actor_uid:11,staff_id:1,outcome:'remark-saved'}}});
    const recovery=await app.request(`/store/manager/order/operation/${context.request_key}`,{headers:{Authorization:`Bearer ${userToken}`}},env);expect(await recovery.json()).toMatchObject({status:200,data:{receipt:{actor_uid:11,outcome:'remark-saved'}}});
    expect((await state()).statuses).toHaveLength(1);
  });
});
