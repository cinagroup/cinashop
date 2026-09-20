import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { adminRefundEvidenceFixture } from './helpers/adminRefundEvidenceFixture';
import { ADMIN_REFUND_CREATION_SQL } from '../src/migrations/adminRefundCreation';
import { ADMIN_REFUND_OPERATION_SQL } from '../src/migrations/adminRefundOperation';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { adminRefundOperation, storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundPayment, systemAdmin, systemRole, systemConfig, userBrokerage } from '../src/models/schema';
import { createAdminRefundApplication, executeAdminProactiveRefund, lookupAdminRefundCreation, abandonAdminRefundCreation } from '../src/services/admin/AdminRefundCreationService';
import { quoteAdminRefundCreation } from '../src/services/admin/AdminRefundCreationQuoteService';
import { parseAdminRefundCreation,adminRefundCreationNumber } from '../src/services/admin/AdminRefundCreationProtocol';
import { readRefundCreation } from '../src/services/admin/AdminRefundCreationLedger';
import { lookupAdminRefundOperation } from '../src/services/admin/AdminRefundOperationService';
import { applyOrderRefund, ensureAutomaticOrderRefund, StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { AdminRefundReadService } from '../src/services/admin/AdminRefundReadService';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { AlipayRefundService } from '../src/services/payment/AlipayRefundService';
import { md5 } from '../src/utils/jwt';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { lockOrderSettlement } from '../src/services/order/OrderBrokerageService';

const actor=()=>({id:100,authVersion:md5('synthetic-digest'),expiresAt:Math.floor(Date.now()/1000)+3600});
let quoteFingerprint:string;
const input=()=>({version:'admin-refund-creation-v1',review:{id:1,orderId:'local_refund_1',uid:11,storeId:0,supplierId:0,
  payPrice:'10.00',totalNum:2,status:0,refundPrice:'0.00',payType:'yue'},mode:'items',items:[{cartId:501,cartNum:1}],quotedPrice:'5.00',refundPrice:'3.00',reason:'合成主动退款原因',quoteFingerprint});
let f:Awaited<ReturnType<typeof adminRefundEvidenceFixture>>;
const quote=()=>quoteAdminRefundCreation(f.container,actor(),{version:'admin-refund-creation-quote-v1',orderId:1,mode:'remaining',items:[]});
beforeEach(async()=>{
  f=await adminRefundEvidenceFixture(undefined,[userBrokerage]);
  await f.exec(ADMIN_REFUND_CREATION_SQL);await f.exec(ADMIN_REFUND_OPERATION_SQL);
  await f.db.update(systemRole).set({rules:'refund.manage'}).where(eq(systemRole.id,1));
  await f.db.update(systemAdmin).set({level:1,roles:'1'}).where(eq(systemAdmin.id,100));
  await f.db.update(storeOrderCartInfo).set({skuUnique:'qared001'}).where(eq(storeOrderCartInfo.id,1));
  await f.db.insert(systemConfig).values({menuName:'refund_time_available',value:'0'});
  const forbidden=async()=>{throw Error('Unconfigured external I/O');};
  for(const gateway of [WechatPayService,AlipayRefundService])for(const method of ['requestRefund','queryRefund'] as const)vi.spyOn(gateway.prototype,method).mockImplementation(forbidden);
  vi.spyOn(globalThis,'fetch').mockImplementation(forbidden);
  quoteFingerprint=(await quote()).quoteFingerprint;
},30000);
afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}},45000);
const receipts=()=>f.db.select().from(sql`admin_refund_creation`);
const ownRefunds=()=>f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,1));
const snapshot=async()=>({business:await f.snapshot(),refunds:await f.applications(),statuses:await f.statuses(),creations:await receipts(),executions:await f.db.select().from(adminRefundOperation)});

it('creates a reviewed partial-quantity/manual-amount application and immutable receipt in one transaction, without money',async()=>{
  const before=await f.snapshot(),key=crypto.randomUUID(),value=input();
  const created=await createAdminRefundApplication(f.container,actor(),key,value);
  expect(created).toMatchObject({replayed:false,receipt:{adminId:100,requestKey:key,orderId:1,outcome:'created'}});
  expect(await ownRefunds()).toMatchObject([{id:created.receipt.refundId,applyType:4,refundType:0,refundNum:1,refundPrice:'3.00',refundedPrice:'0.00'}]);
  expect(JSON.parse((await ownRefunds())[0].cartInfo!)).toEqual({cartIds:[{cartId:501,cartNum:1}],quantityReservation:{
    version:'refund-quantity-reservation-v1',orderId:1,uid:11,items:[{rowId:1,cartId:501,cartNum:1,beforeRefundNum:0,totalNum:2}],
  }});
  expect((await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id,1)))[0].refundNum).toBe(1);
  expect(await f.snapshot()).toEqual(before);expect(await receipts()).toHaveLength(1);
  expect(await createAdminRefundApplication(f.container,actor(),key,value)).toEqual({receipt:created.receipt,replayed:true});
  expect(await f.statuses()).toHaveLength(2);expect(WechatPayService.prototype.requestRefund).not.toHaveBeenCalled();
});
it('preserves store and supplier ownership so a created store refund remains readable',async()=>{
  const body=input();body.review.storeId=9;body.review.supplierId=8;
  await f.db.update(storeOrder).set({storeId:9,supplierId:8}).where(eq(storeOrder.id,1));
  body.quoteFingerprint=(await quote()).quoteFingerprint;
  const created=await createAdminRefundApplication(f.container,actor(),crypto.randomUUID(),body);
  if(created.receipt.outcome!=='created')throw Error('Expected creation');
  expect(await new AdminRefundReadService(f.container,f.env).detail(created.receipt.refundId)).toMatchObject({storeId:9,supplierId:8,uid:11});
});
it.each(['remaining','items'])('settles %s exactly once through the composed real balance/stock/bill executor',async mode=>{
  const body=input();body.mode=mode;if(mode==='remaining'){body.items=[];body.quotedPrice='10.00';body.refundPrice='8.00';}
  const key=crypto.randomUUID(),before=await f.snapshot(),first=await executeAdminProactiveRefund(f.container,f.env,actor(),key,body);
  expect(first.operation).toMatchObject({receipt:{outcome:'balance-settled'},execution:{completed:true,status:'BALANCE_SUCCESS'}});
  const after=await f.snapshot();expect(after.users.find(row=>row.uid===11)?.nowMoney).toBe(body.refundPrice);
  expect(after.bills.filter(row=>row.type==='pay_product_refund')).toHaveLength(1);
  expect(after.products.find(row=>row.id===70)?.stock).toBe(before.products.find(row=>row.id===70)!.stock+(mode==='items'?1:2));
  expect(after.skus.find(row=>row.unique==='qared001')?.stock).toBe(before.skus.find(row=>row.unique==='qared001')!.stock+(mode==='items'?1:2));
  expect((await executeAdminProactiveRefund(f.container,f.env,actor(),key,body)).operation).toMatchObject({replayed:true,receipt:first.operation?.receipt});
  expect(await f.snapshot()).toEqual(after);expect(await receipts()).toHaveLength(1);
});
it('does not transfer a prior cash concession to the remaining goods quote',async()=>{
  await executeAdminProactiveRefund(f.container,f.env,actor(),crypto.randomUUID(),input());
  const body=input();body.mode='remaining';body.items=[];body.review.refundPrice='3.00';body.quotedPrice='7.00';body.refundPrice='7.00';
  body.quoteFingerprint=(await quote()).quoteFingerprint;
  await expect(createAdminRefundApplication(f.container,actor(),crypto.randomUUID(),body)).rejects.toThrow('服务端可退金额');
  body.quotedPrice='5.00';body.refundPrice='5.00';
  await executeAdminProactiveRefund(f.container,f.env,actor(),crypto.randomUUID(),body);
  expect((await f.snapshot()).users.find(row=>row.uid===11)?.nowMoney).toBe('8.00');
  expect(await ownRefunds()).toHaveLength(2);expect((await f.snapshot()).bills.filter(row=>row.type==='pay_product_refund')).toHaveLength(2);
});
it('preserves mandatory whole-payment recovery after a manually discounted partial-quantity refund',async()=>{
  await executeAdminProactiveRefund(f.container,f.env,actor(),crypto.randomUUID(),input());
  const automatic=await ensureAutomaticOrderRefund(f.container,{uid:11,orderId:'local_refund_1',applyType:1,
    refundReason:'合成系统全额退款',refundExplain:'验证系统退清余额，不是另一件商品的管理员报价'});
  expect(await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,automatic.refundId)))
    .toMatchObject([{refundNum:1,refundPrice:'7.00'}]);
  const service=new StoreOrderRefundService(f.container,f.env);
  expect(await service.agreeRefund(automatic.refundId)).toMatchObject({completed:true});
  const after=await f.snapshot();expect(after.users.find(row=>row.uid===11)?.nowMoney).toBe('10.00');
  expect(after.bills.filter(row=>row.type==='pay_product_refund')).toHaveLength(2);
  expect(await service.agreeRefund(automatic.refundId)).toMatchObject({completed:true});
  expect(await f.snapshot()).toEqual(after);
});
it('retains creation and terminal execution evidence after business deletion; a new key cannot recreate it',async()=>{
  const key=crypto.randomUUID(),body=input(),first=await executeAdminProactiveRefund(f.container,f.env,actor(),key,body);
  await f.db.delete(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,1));await f.db.delete(storeOrder).where(eq(storeOrder.id,1));
  expect(await lookupAdminRefundCreation(f.container,actor(),key)).toEqual(first.creation.receipt);
  expect(await abandonAdminRefundCreation(f.container,actor(),key,body)).toEqual(first.creation.receipt);
  expect((await executeAdminProactiveRefund(f.container,f.env,actor(),key,body)).operation?.receipt).toEqual(first.operation?.receipt);
  await expect(createAdminRefundApplication(f.container,actor(),crypto.randomUUID(),body)).rejects.toThrow('订单不存在');
});
it.each(['order','refund'])('preserves committed creation but does not start money movement after its %s disappears',async kind=>{
  const key=crypto.randomUUID(),body=input(),created=await createAdminRefundApplication(f.container,actor(),key,body);
  if(kind==='order')await f.db.delete(storeOrder).where(eq(storeOrder.id,1));
  else await f.db.delete(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,1));
  const before=await snapshot();
  await expect(executeAdminProactiveRefund(f.container,f.env,actor(),key,body)).rejects.toThrow();
  expect(await lookupAdminRefundCreation(f.container,actor(),key)).toEqual(created.receipt);
  expect(await snapshot()).toEqual(before);
  expect(WechatPayService.prototype.requestRefund).not.toHaveBeenCalled();
  expect(AlipayRefundService.prototype.requestRefund).not.toHaveBeenCalled();
});
it('does not adopt a matching business number without its durable creation receipt',async()=>{
  const key=crypto.randomUUID(),body=input();
  await applyOrderRefund(f.container,{uid:11,orderId:body.review.orderId,applyType:4,privilegedActor:'admin',
    applicationOrderId:adminRefundCreationNumber(100,key),refundReason:body.reason,refundExplain:body.reason,
    cartSelections:body.items});
  const before=await snapshot();
  await expect(executeAdminProactiveRefund(f.container,f.env,actor(),key,body)).rejects.toThrow('创建回执与业务记录不一致');
  expect(await snapshot()).toEqual(before);expect(await receipts()).toEqual([]);
});
it.each(['reason','quantity','amount','order','mode'])('rejects changed %s under the original creation key',async kind=>{
  const key=crypto.randomUUID(),body=input();await createAdminRefundApplication(f.container,actor(),key,body);
  if(kind==='reason')body.reason='新的原因';if(kind==='quantity')body.items[0].cartNum=2;if(kind==='amount')body.refundPrice='4.00';
  if(kind==='order'){body.review.id=2;body.review.orderId='local_refund_2';}if(kind==='mode'){body.mode='remaining';body.items=[];}
  const before=await snapshot();
  for(const run of [createAdminRefundApplication,abandonAdminRefundCreation])await expect(run(f.container,actor(),key,body)).rejects.toMatchObject({code:409});
  expect(await snapshot()).toEqual(before);
});
it('a null lookup is not a fence; explicit abandonment prevents later creation and funds',async()=>{
  const key=crypto.randomUUID(),body=input(),before=await f.snapshot();
  expect(await lookupAdminRefundCreation(f.container,actor(),key)).toBeNull();expect(await receipts()).toEqual([]);
  const fence=await abandonAdminRefundCreation(f.container,actor(),key,body);expect(fence).toMatchObject({outcome:'abandoned',refundId:null});
  expect(await executeAdminProactiveRefund(f.container,f.env,actor(),key,body)).toEqual({creation:{receipt:fence,replayed:true},operation:null});
  expect(await ownRefunds()).toEqual([]);expect(await f.snapshot()).toEqual(before);expect(await f.statuses()).toEqual([]);
});
it.each(['status','pwd','role','expiry'])('requires fresh %s authority for creation, replay, lookup and abandonment',async kind=>{
  const key=crypto.randomUUID(),body=input(),owner=actor();await createAdminRefundApplication(f.container,owner,key,body);
  if(kind==='status')await f.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,100));
  if(kind==='pwd')await f.db.update(systemAdmin).set({pwd:'revoked'}).where(eq(systemAdmin.id,100));
  if(kind==='role')await f.db.update(systemRole).set({rules:'refund.view'}).where(eq(systemRole.id,1));
  if(kind==='expiry')owner.expiresAt=1;
  const before=await snapshot();
  await expect(createAdminRefundApplication(f.container,owner,crypto.randomUUID(),body)).rejects.toThrow();
  await expect(createAdminRefundApplication(f.container,owner,key,body)).rejects.toThrow();
  await expect(lookupAdminRefundCreation(f.container,owner,key)).rejects.toThrow();
  await expect(abandonAdminRefundCreation(f.container,owner,key,body)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
it('isolates actors and captures original nested values before asynchronous admission',async()=>{
  const owner=actor(),body=input(),key=crypto.randomUUID();const pending=executeAdminProactiveRefund(f.container,f.env,owner,key,body);
  owner.id=102;body.review.uid=22;body.items[0].cartNum=2;body.refundPrice='9.00';
  expect((await pending).operation?.execution).toMatchObject({completed:true,status:'BALANCE_SUCCESS'});
  await f.db.update(systemAdmin).set({level:0}).where(eq(systemAdmin.id,101));
  expect(await lookupAdminRefundCreation(f.container,{...actor(),id:101},key)).toBeNull();
  expect((await f.snapshot()).users.find(row=>row.uid===11)?.nowMoney).toBe('3.00');
});
it('rolls back application and audit if the creation receipt cannot commit',async()=>{
  await f.exec("CREATE FUNCTION fail_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER fail_creation BEFORE INSERT ON admin_refund_creation FOR EACH ROW EXECUTE FUNCTION fail_creation()");
  const before=await snapshot();await expect(executeAdminProactiveRefund(f.container,f.env,actor(),crypto.randomUUID(),input())).rejects.toThrow();
  expect(await snapshot()).toEqual(before);expect(WechatPayService.prototype.requestRefund).not.toHaveBeenCalled();
});
it('retains a committed creation when payment receipt failure rolls back money, then safely resumes it',async()=>{
  await f.exec("CREATE FUNCTION fail_execution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER fail_execution BEFORE INSERT ON admin_refund_operation FOR EACH ROW EXECUTE FUNCTION fail_execution()");
  const key=crypto.randomUUID(),body=input(),before=await f.snapshot();
  await expect(executeAdminProactiveRefund(f.container,f.env,actor(),key,body)).rejects.toThrow();
  expect(await lookupAdminRefundCreation(f.container,actor(),key)).toMatchObject({outcome:'created'});
  expect(await ownRefunds()).toMatchObject([{refundType:0,refundedPrice:'0.00'}]);expect(await f.snapshot()).toEqual(before);
  expect(await f.db.select().from(adminRefundOperation)).toEqual([]);
  await f.exec('DROP TRIGGER fail_execution ON admin_refund_operation');
  expect((await executeAdminProactiveRefund(f.container,f.env,actor(),key,body)).operation?.execution?.completed).toBe(true);
  expect(await ownRefunds()).toHaveLength(1);
});
it('commits both creation and payment admission before a synthetic lost provider response, and retries only the original number',async()=>{
  const body=input();body.review.payType='weixin';await f.db.update(storeOrder).set({payType:'weixin'}).where(eq(storeOrder.id,1));
  body.quoteFingerprint=(await quote()).quoteFingerprint;
  const key=crypto.randomUUID();
  vi.mocked(WechatPayService.prototype.requestRefund).mockImplementation(async request=>{
    const creation=await lookupAdminRefundCreation(f.container,actor(),key);expect(creation).toMatchObject({outcome:'created'});
    expect(await lookupAdminRefundOperation(f.container,actor(),key)).toMatchObject({outcome:'provider-admitted',refundId:creation?.refundId});
    expect(request).toMatchObject({outRefundNo:'CNSR'+creation?.refundId,refundAmount:300,totalAmount:1000});
    throw Error('synthetic lost response');
  });
  await expect(executeAdminProactiveRefund(f.container,f.env,actor(),key,body)).rejects.toThrow('结果未知');
  const created=await lookupAdminRefundCreation(f.container,actor(),key);
  expect(await abandonAdminRefundCreation(f.container,actor(),key,body)).toEqual(created);
  expect(WechatPayService.prototype.queryRefund).not.toHaveBeenCalled();
  expect(await f.db.select().from(storeOrderRefundPayment)).toMatchObject([{providerStatus:'UNKNOWN',attemptCount:1}]);
  vi.mocked(WechatPayService.prototype.queryRefund).mockResolvedValue({status:'SUCCESS',providerRefundId:'synthetic'});
  const resumed=await executeAdminProactiveRefund(f.container,f.env,actor(),key,body);expect(resumed.operation?.execution?.completed).toBe(true);
  expect(WechatPayService.prototype.requestRefund).toHaveBeenCalledTimes(1);expect(WechatPayService.prototype.queryRefund).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({outRefundNo:'CNSR'+created?.refundId,refundAmount:300}));
  expect(await ownRefunds()).toHaveLength(1);
});
it('rejects invalid quantities, noncanonical IDs, stale quote/order scope and unauthenticated cash overrides without any write',async()=>{
  const before=await snapshot();
  for(const change of [(b:ReturnType<typeof input>)=>{b.items[0].cartId=1;},(b:ReturnType<typeof input>)=>{b.items[0].cartNum=3;},
    (b:ReturnType<typeof input>)=>{b.quotedPrice='6.00';},(b:ReturnType<typeof input>)=>{b.review.storeId=5;},(b:ReturnType<typeof input>)=>{b.refundPrice='0.00';}]){
    const b=input();change(b);await expect(createAdminRefundApplication(f.container,actor(),crypto.randomUUID(),b)).rejects.toThrow();
  }
  await expect(applyOrderRefund(f.container,{uid:11,orderId:'local_refund_1',refundReason:'synthetic',refundExplain:'synthetic',applyType:4,privilegedActor:'admin',requestedRefundAmountCents:300})).rejects.toThrow('锁内管理员授权');
  expect(await snapshot()).toEqual(before);
});
it('rejects missing/corrupt ledgers, does not self-install and rejects outer transactions',async()=>{
  await expect(withTx(f.container,tx=>executeAdminProactiveRefund(createContainerFromDb(tx),f.env,actor(),crypto.randomUUID(),input()))).rejects.toThrow('root database');
  await expect(readRefundCreation(f.db,100,crypto.randomUUID())).rejects.toThrow('business transaction');
  const key=crypto.randomUUID();await f.exec('ALTER TABLE admin_refund_creation DROP CONSTRAINT arc_outcome_ck');
  await f.db.execute(sql`INSERT INTO admin_refund_creation(admin_id,request_key,request_hash,order_id,refund_id,outcome) VALUES(100,${key}::uuid,${'a'.repeat(64)},1,NULL,'created')`);
  await expect(lookupAdminRefundCreation(f.container,actor(),key)).rejects.toMatchObject({code:503});
  await f.exec('DROP TABLE admin_refund_creation');
  await expect(createAdminRefundApplication(f.container,actor(),crypto.randomUUID(),input())).rejects.toThrow();
  expect(await ownRefunds()).toEqual([]);expect(await f.statuses()).toEqual([]);
});
it('enforces creation identity, UUIDv4, hash, outcome and unique-key constraints in SQL',async()=>{
  const valid={adminId:100,key:crypto.randomUUID(),hash:'a'.repeat(64),orderId:1,refundId:1 as number|null,outcome:'created'};
  const insert=(row:typeof valid)=>f.db.execute(sql`INSERT INTO admin_refund_creation(admin_id,request_key,request_hash,order_id,refund_id,outcome)
    VALUES(${row.adminId},${row.key}::uuid,${row.hash},${row.orderId},${row.refundId},${row.outcome})`);
  for(const invalid of [{...valid,adminId:0},{...valid,orderId:0},{...valid,key:'00000000-0000-1000-8000-000000000000'},
    {...valid,hash:'A'.repeat(64)},{...valid,refundId:null},{...valid,refundId:0},{...valid,outcome:'abandoned'},
    {...valid,outcome:'unknown',refundId:null}])await expect(insert(invalid)).rejects.toThrow();
  expect(await receipts()).toEqual([]);
  await insert(valid);const before=await receipts();
  await expect(insert({...valid,outcome:'abandoned',refundId:null})).rejects.toThrow();
  expect(await receipts()).toEqual(before);
  // The same UUID for another actor is distinct, not a global collision.
  await insert({...valid,adminId:101,outcome:'abandoned',refundId:null});
  expect(await receipts()).toHaveLength(2);
});
it('validates protocol before hashing and canonicalizes item order and decimal spellings without retaining mutable input',()=>{
  const key='ffffffff-ffff-4fff-bfff-ffffffffffff';
  expect(adminRefundCreationNumber(2147483647,key)).toHaveLength(31);
  expect(adminRefundCreationNumber(100,key)).not.toBe(adminRefundCreationNumber(101,key));
  expect(adminRefundCreationNumber(100,key)).not.toBe(adminRefundCreationNumber(100,key.replace(/^f/,'e')));
  const b=input();b.items=[{cartId:502,cartNum:1},{cartId:501,cartNum:1}];b.quotedPrice='0005.00';
  const parsed=parseAdminRefundCreation(b);b.items[0].cartNum=8;expect(parsed.items).toEqual([{cartId:501,cartNum:1},{cartId:502,cartNum:1}]);expect(parsed.quotedPrice).toBe('5.00');
  for(const value of [null,{}, {...input(),version:'v0'},{...input(),mode:{toString:()=> 'items'}},{...input(),adminId:100},{...input(),items:Array(101).fill({cartId:501,cartNum:1})},
    {...input(),refundPrice:'6.00'},{...input(),items:[{cartId:501,cartNum:1.1}]},{...input(),reason:'x'.repeat(256)}])expect(()=>parseAdminRefundCreation(value)).toThrow();
});

describe.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL)('native independent creation backends',()=>{
  it('serializes same-key creation and abandonment with one final receipt',async()=>{
    await withFinancePeers(f.db,async([a,b])=>{
      const key=crypto.randomUUID(),body=input();
      const results=await Promise.all([createAdminRefundApplication(createContainerFromDb(a.db),actor(),key,body),
        abandonAdminRefundCreation(createContainerFromDb(b.db),actor(),key,body)]);
      expect(results[0].receipt).toEqual(results[1]);expect(await receipts()).toHaveLength(1);
      expect(await ownRefunds()).toHaveLength(results[1].outcome==='created'?1:0);
    });
  });
  it('rechecks reviewed order state changed by another backend while waiting for the order lock',async()=>{
    await withFinancePeers(f.db,async([blocker,waiter])=>{
      let release!:()=>void,entered!:()=>void;const heldGate=new Promise<void>(r=>{release=r;}),enteredGate=new Promise<void>(r=>{entered=r;});
      const held=outcome(withTx(createContainerFromDb(blocker.db),async tx=>{await lockOrderSettlement(tx,1);entered();await heldGate;await tx.update(storeOrder).set({status:1}).where(eq(storeOrder.id,1));}));
      let pending:ReturnType<typeof outcome<Awaited<ReturnType<typeof createAdminRefundApplication>>>>|undefined;
      try{await enteredGate;pending=outcome(createAdminRefundApplication(createContainerFromDb(waiter.db),actor(),crypto.randomUUID(),input()));
        await waitForFinanceBlock(f.db,waiter.pid,blocker.pid);release();expect((await held).ok).toBe(true);const result=await pending;expect(result.ok).toBe(false);
        if(!result.ok)expect(result.error.message).toContain('状态已变化');
      }finally{release();await held;await pending;}
      expect(await receipts()).toEqual([]);expect(await ownRefunds()).toEqual([]);
    });
  });
});
