import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { adminRefundEvidenceFixture } from './helpers/adminRefundEvidenceFixture';
import { ADMIN_REFUND_OPERATION_SQL } from '../src/migrations/adminRefundOperation';
import { adminRefundOperation } from '../src/models/schema/admin_refund_operation';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundPayment, storeOrderOutbox,
  systemAdmin, userBrokerage } from '../src/models/schema';
import { executeAdminRefundOperation, lookupAdminRefundOperation, abandonAdminRefundOperation } from '../src/services/admin/AdminRefundOperationService';
import type { AdminRefundOperationAction } from '../src/services/admin/AdminRefundOperationLedger';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { AlipayRefundService } from '../src/services/payment/AlipayRefundService';
import { StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { md5 } from '../src/utils/jwt';
import { withFinancePeers, waitForFinanceBlock, outcome } from './helpers/financePeers';

/** Actual executor and settlement SQL. Only payment-provider I/O is synthetic;
 * spies fail closed unless a test explicitly supplies a provider response. */
describe('Admin refund operation executor with durable decision receipts', () => {
  let f: Awaited<ReturnType<typeof adminRefundEvidenceFixture>>;
  const actor = () => ({id:100,authVersion:md5('synthetic-digest'),expiresAt:Math.floor(Date.now()/1000)+3600});
  const body = (applyType = 2) => ({
    review:{uid:11,storeOrderId:28,storeId:0,supplierId:0,orderId:'history_refund_28',refundPrice:'5.00'},
    decision:{applyType,refundType:0,received:false}, reason:'合成拒绝原因',
  });
  let request: MockInstance<WechatPayService['requestRefund']>;
  let query: MockInstance<WechatPayService['queryRefund']>;
  beforeEach(async () => {
    f = await adminRefundEvidenceFixture(undefined,[userBrokerage]);
    await f.exec(ADMIN_REFUND_OPERATION_SQL);
    const forbidden = async () => { throw new Error('Unconfigured synthetic provider call'); };
    request = vi.spyOn(WechatPayService.prototype,'requestRefund').mockImplementation(forbidden);
    query = vi.spyOn(WechatPayService.prototype,'queryRefund').mockImplementation(forbidden);
    vi.spyOn(AlipayRefundService.prototype,'requestRefund').mockImplementation(forbidden);
    vi.spyOn(AlipayRefundService.prototype,'queryRefund').mockImplementation(forbidden);
  });
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const execute = (key:string, action:AdminRefundOperationAction, input=body(), owner=actor()) =>
    executeAdminRefundOperation(f.container,f.env,owner,28,key,action,input);
  const receipts = () => f.db.select().from(adminRefundOperation);
  const payments = () => f.db.select().from(storeOrderRefundPayment);
  const refund = async () => (await f.applications()).find(row=>row.id===28)!;
  const rejectReceipt = () => f.exec(`CREATE FUNCTION reject_operation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected operation receipt failure'; END$$;
    CREATE TRIGGER reject_operation_receipt BEFORE INSERT ON admin_refund_operation
    FOR EACH ROW EXECUTE FUNCTION reject_operation_receipt()`);
  const financial = async (payType:'yue'|'weixin'|'alipay') => {
    await f.db.update(storeOrder).set({payType,status:0}).where(eq(storeOrder.id,28));
    await f.db.update(storeOrderRefund).set({applyType:1}).where(eq(storeOrderRefund.id,28));
    // Exercise real unshipped inventory restoration as well as money/bill SQL.
    await f.db.update(storeOrderCartInfo).set({skuUnique:'qared001'}).where(eq(storeOrderCartInfo.id,28));
    return body(1);
  };

  it.each(['return','refuse'] as const)('commits %s once and replays the original receipt even after business rows are removed', async action => {
    const key=crypto.randomUUID(),input=body();
    const first=await execute(key,action,input);
    expect(first).toMatchObject({replayed:false,receipt:{adminId:100,refundId:28,action,outcome:action==='return'?'return-approved':'refused'}});
    expect((await refund()).refundType).toBe(action==='return'?4:3);
    const statuses=await f.statuses(),notices=await f.db.select().from(storeOrderOutbox);
    expect(statuses).toHaveLength(1);expect(notices).toHaveLength(action==='refuse'?1:0);
    expect(await execute(key,action,input)).toMatchObject({replayed:true,receipt:first.receipt});
    await f.exec('DELETE FROM store_order_refund WHERE id=28; DELETE FROM store_order WHERE id=28');
    expect(await execute(key,action,input)).toMatchObject({replayed:true,receipt:first.receipt});
    expect(await lookupAdminRefundOperation(f.container,actor(),key)).toEqual(first.receipt);
    expect(await f.statuses()).toEqual(statuses);expect(await f.db.select().from(storeOrderOutbox)).toEqual(notices);
    expect(await receipts()).toHaveLength(1);expect(request).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
  });

  it.each(['return','refuse'] as const)('rolls back %s and its status/outbox if the atomic receipt insert fails', async action => {
    const before=await f.snapshot();await rejectReceipt();
    await expect(execute(crypto.randomUUID(),action)).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);expect((await refund()).refundType).toBe(0);
    expect(await receipts()).toEqual([]);expect(await f.statuses()).toEqual([]);
    expect(await f.db.select().from(storeOrderOutbox)).toEqual([]);
  });

  it('binds the original normalized content, not mutable caller objects or a new session token', async () => {
    const key=crypto.randomUUID(),input=body(),original=structuredClone(input),owner=actor();
    input.reason='  合成拒绝原因  ';
    const pending=execute(key,'refuse',input,owner);
    input.review.uid=22;input.decision.refundType=5;input.reason='改写原因';owner.id=102;
    const first=await pending;
    expect((await refund()).refuseReason).toBe(original.reason);
    expect(await execute(key.toUpperCase(),'refuse',original,{...actor(),expiresAt:actor().expiresAt+60}))
      .toMatchObject({replayed:true,receipt:first.receipt});
    await expect(execute(key,'refuse',{...original,reason:'不同原因'})).rejects.toMatchObject({code:409});
    await expect(execute(key,'return',original)).rejects.toMatchObject({code:409});
    expect(await receipts()).toHaveLength(1);
  });

  it('requires fresh SQL authority for replay, lookup and abandonment, including a disabled actor', async () => {
    const key=crypto.randomUUID();await execute(key,'return');
    await f.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,100));
    await expect(execute(key,'return')).rejects.toThrow('禁用');
    await expect(lookupAdminRefundOperation(f.container,actor(),key)).rejects.toThrow('禁用');
    await expect(abandonAdminRefundOperation(f.container,actor(),28,crypto.randomUUID(),'return',body())).rejects.toThrow('禁用');
    expect(await receipts()).toHaveLength(1);expect(await f.statuses()).toHaveLength(1);
  });

  it('does not let a read-only operator inspect/manage another actor receipt or insert a fence', async () => {
    const key=crypto.randomUUID();await execute(key,'return');
    const reader={...actor(),id:101};
    await expect(lookupAdminRefundOperation(f.container,reader,key)).rejects.toThrow('权限');
    await expect(abandonAdminRefundOperation(f.container,reader,28,key,'return',body())).rejects.toThrow('权限');
    await f.db.update(systemAdmin).set({level:0}).where(eq(systemAdmin.id,101));
    expect(await lookupAdminRefundOperation(f.container,reader,key)).toBeNull();
    expect(await receipts()).toHaveLength(1);
  });

  it('leaves no acceptance on a stale state and permits an explicit durable abandonment before a late send', async () => {
    const key=crypto.randomUUID(),input=body();
    await f.db.update(storeOrderRefund).set({refundType:1}).where(eq(storeOrderRefund.id,28));
    await expect(execute(key,'return',input)).rejects.toThrow('状态已变化');
    expect(await lookupAdminRefundOperation(f.container,actor(),key)).toBeNull();
    const fence=await abandonAdminRefundOperation(f.container,actor(),28,key,'return',input);
    expect(fence.outcome).toBe('abandoned');
    await f.db.update(storeOrderRefund).set({refundType:0}).where(eq(storeOrderRefund.id,28));
    expect(await execute(key,'return',input)).toMatchObject({replayed:true,receipt:fence});
    expect((await refund()).refundType).toBe(0);expect(await f.statuses()).toEqual([]);
  });

  it('never overwrites an already accepted decision with an abandonment fence', async () => {
    const key=crypto.randomUUID(),first=await execute(key,'return');
    expect(await abandonAdminRefundOperation(f.container,actor(),28,key,'return',body())).toEqual(first.receipt);
    expect(await receipts()).toHaveLength(1);expect((await refund()).refundType).toBe(4);
  });

  it('settles balance, bill, stock, order and durable receipt exactly once through the real executor', async () => {
    const input=await financial('yue'),key=crypto.randomUUID(),before=await f.snapshot();
    const first=await execute(key,'refund',input);
    expect(first).toMatchObject({replayed:false,receipt:{outcome:'balance-settled'},execution:{completed:true,status:'BALANCE_SUCCESS'}});
    const after=await f.snapshot();
    expect(after.users.find(row=>row.uid===11)?.nowMoney).toBe('5.00');
    expect(after.bills.filter(row=>row.type==='pay_product_refund')).toMatchObject([{uid:11,number:'5.00',linkId:'history_refund_28'}]);
    expect(after.products.find(row=>row.id===70)?.stock).toBe(before.products.find(row=>row.id===70)!.stock+1);
    expect(after.skus.find(row=>row.unique==='qared001')?.stock).toBe(before.skus.find(row=>row.unique==='qared001')!.stock+1);
    expect(after.orders.find(row=>row.id===28)).toMatchObject({refundStatus:3,refundPrice:'5.00'});
    expect(await refund()).toMatchObject({refundType:6,refundedPrice:'5.00'});
    expect(await execute(key,'refund',input)).toMatchObject({replayed:true,receipt:first.receipt,execution:first.execution});
    expect(await f.snapshot()).toEqual(after);expect(await receipts()).toHaveLength(1);expect(await payments()).toEqual([]);
    expect(await f.statuses()).toHaveLength(1);expect(request).not.toHaveBeenCalled();
  });

  it('rolls back real balance credit, stock restoration, bill and refund if receipt insertion fails', async () => {
    const input=await financial('yue'),before=await f.snapshot();await rejectReceipt();
    await expect(execute(crypto.randomUUID(),'refund',input)).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);expect(await refund()).toMatchObject({refundType:0,refundedPrice:'0.00'});
    expect(await receipts()).toEqual([]);expect(await f.statuses()).toEqual([]);
    expect((await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id,28)))[0].refundNum).toBe(0);
  });

  it('makes provider admission/payment REQUESTING visible to independent SQL before calling the gateway', async () => {
    const input=await financial('weixin'),key=crypto.randomUUID();
    request.mockImplementation(async providerRequest=>{
      // These root-client reads use another connection while a SQL phase is
      // active; uncommitted admission would be absent (or block the key lookup).
      expect(await lookupAdminRefundOperation(f.container,actor(),key)).toMatchObject({outcome:'provider-admitted'});
      expect(await payments()).toMatchObject([{providerStatus:'REQUESTING',attemptCount:1,outRefundNo:'CNSR28'}]);
      expect(providerRequest).toMatchObject({outRefundNo:'CNSR28',refundAmount:500,totalAmount:1000,outTradeNo:'history_order_28'});
      return {status:'PROCESSING'};
    });
    const first=await execute(key,'refund',input);
    expect(first).toMatchObject({receipt:{outcome:'provider-admitted'},execution:{completed:false,status:'PROCESSING'}});
    expect(await abandonAdminRefundOperation(f.container,actor(),28,key,'refund',input)).toEqual(first.receipt);
    expect(await refund()).toMatchObject({refundType:0,refundedPrice:'0.00'});
    expect((await f.snapshot()).bills).toEqual([]);expect(request).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();
  });

  it('never calls a payment provider when its admission receipt cannot commit', async () => {
    const input=await financial('weixin');await rejectReceipt();
    await expect(execute(crypto.randomUUID(),'refund',input)).rejects.toThrow();
    expect(await receipts()).toEqual([]);expect(await payments()).toEqual([]);
    expect(request).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();expect((await refund()).refundType).toBe(0);
  });

  it('keeps an unknown provider result admitted and explicitly retries by querying the same refund number', async () => {
    const input=await financial('weixin'),key=crypto.randomUUID();
    request.mockRejectedValueOnce(new Error('synthetic connection lost after dispatch'));
    await expect(execute(key,'refund',input)).rejects.toThrow('结果未知');
    const receipt=await lookupAdminRefundOperation(f.container,actor(),key);
    expect(receipt?.outcome).toBe('provider-admitted');expect(await payments()).toMatchObject([{providerStatus:'UNKNOWN',attemptCount:1}]);
    expect(query).not.toHaveBeenCalled();
    query.mockResolvedValueOnce({status:'SUCCESS',providerRefundId:'synthetic-provider-28'});
    const recovered=await execute(key,'refund',input);
    expect(recovered).toMatchObject({receipt,execution:{completed:true,status:'SUCCESS'}});
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({outRefundNo:'CNSR28',refundAmount:500}));
    expect(request).toHaveBeenCalledTimes(1);expect(await refund()).toMatchObject({refundType:6,refundedPrice:'5.00'});
    const after=await f.snapshot();
    expect(await execute(key,'refund',input)).toMatchObject({replayed:true,receipt,execution:{completed:true,status:'SUCCESS'}});
    expect(await f.snapshot()).toEqual(after);expect(await f.statuses()).toHaveLength(1);expect(await receipts()).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);expect(query).toHaveBeenCalledTimes(1);
  });

  it('keeps the in-flight request lease when a duplicate same-key request arrives before the first gateway returns', async () => {
    const input=await financial('weixin'),key=crypto.randomUUID();
    request.mockImplementation(async()=>{
      expect(await execute(key,'refund',input)).toMatchObject({receipt:{outcome:'provider-admitted'},execution:{completed:false,status:'PROCESSING'}});
      return {status:'PROCESSING'};
    });
    await execute(key,'refund',input);
    expect(request).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();expect(await payments()).toMatchObject([{attemptCount:1}]);
  });

  it('does not strand an admitted refund when the actor is revoked before a verified provider callback', async () => {
    const input=await financial('weixin'),key=crypto.randomUUID();request.mockResolvedValueOnce({status:'PROCESSING'});
    await execute(key,'refund',input);
    await f.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,100));
    await new StoreOrderRefundService(f.container,f.env).handleWechatRefundNotification({
      outTradeNo:'history_order_28',transactionId:'',outRefundNo:'CNSR28',providerRefundId:'synthetic-provider-28',
      status:'SUCCESS',refundAmount:500,totalAmount:1000,
    });
    expect(await refund()).toMatchObject({refundType:6,refundedPrice:'5.00'});
    expect(await receipts()).toMatchObject([{outcome:'provider-admitted'}]);expect(await f.statuses()).toHaveLength(1);
    await expect(execute(key,'refund',input)).rejects.toThrow('禁用');
  });

  it('rejects an outer transaction instead of allowing gateway I/O under its uncommitted admission', async () => {
    const input=await financial('weixin'),key=crypto.randomUUID();
    await expect(withTx(f.container,tx=>executeAdminRefundOperation(createContainerFromDb(tx),f.env,actor(),28,key,'refund',input)))
      .rejects.toThrow('root database');
    expect(request).not.toHaveBeenCalled();expect(await receipts()).toEqual([]);expect(await payments()).toEqual([]);
  });

  it('uses the same payment number and amount after an explicit NOT_FOUND recovery', async () => {
    const input=await financial('weixin'),key=crypto.randomUUID();
    request.mockRejectedValueOnce(new Error('synthetic response lost')).mockResolvedValueOnce({status:'SUCCESS'});
    await expect(execute(key,'refund',input)).rejects.toThrow('结果未知');
    query.mockResolvedValueOnce({status:'NOT_FOUND'});
    expect(await execute(key,'refund',input)).toMatchObject({receipt:{outcome:'provider-admitted'},execution:{completed:true,status:'SUCCESS'}});
    expect(request).toHaveBeenCalledTimes(2);expect(query).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[1][0]).toEqual(request.mock.calls[0][0]);
    expect(await payments()).toMatchObject([{outRefundNo:'CNSR28',attemptCount:2,requestAmount:500,providerStatus:'SUCCESS'}]);
    expect(await f.statuses()).toHaveLength(1);expect(await receipts()).toHaveLength(1);
  });

  it('rechecks current authority before another dispatch after the provider query returns NOT_FOUND', async () => {
    const input=await financial('weixin'),key=crypto.randomUUID();request.mockRejectedValueOnce(new Error('synthetic response lost'));
    await expect(execute(key,'refund',input)).rejects.toThrow('结果未知');
    query.mockImplementationOnce(async()=>{
      await f.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,100));
      return {status:'NOT_FOUND'};
    });
    await expect(execute(key,'refund',input)).rejects.toThrow('禁用');
    expect(request).toHaveBeenCalledTimes(1);expect(query).toHaveBeenCalledTimes(1);
    expect(await receipts()).toMatchObject([{outcome:'provider-admitted'}]);expect((await refund()).refundType).toBe(0);
  });

  it('refuses a settled replay whose persisted provider confirmation no longer matches the original amount', async () => {
    const input=await financial('weixin'),key=crypto.randomUUID();request.mockResolvedValueOnce({status:'SUCCESS'});
    await execute(key,'refund',input);
    await f.db.update(storeOrderRefundPayment).set({requestAmount:499}).where(eq(storeOrderRefundPayment.refundId,28));
    await expect(execute(key,'refund',input)).rejects.toMatchObject({code:503});
    expect(request).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();expect(await f.statuses()).toHaveLength(1);
  });

  it('uses the same atomic admission and terminal replay on the Alipay gateway path', async () => {
    const input=await financial('alipay'),key=crypto.randomUUID();
    const alipay=vi.mocked(AlipayRefundService.prototype.requestRefund).mockImplementationOnce(async payload=>{
      expect(await lookupAdminRefundOperation(f.container,actor(),key)).toMatchObject({outcome:'provider-admitted'});
      expect(payload).toMatchObject({outRefundNo:'CNSR28',refundAmount:500});return {status:'SUCCESS'};
    });
    const first=await execute(key,'refund',input);
    expect(first).toMatchObject({receipt:{outcome:'provider-admitted'},execution:{completed:true,status:'SUCCESS'}});
    expect(await execute(key,'refund',input)).toMatchObject({replayed:true,receipt:first.receipt,execution:first.execution});
    expect(alipay).toHaveBeenCalledTimes(1);expect(request).not.toHaveBeenCalled();expect(await f.statuses()).toHaveLength(1);
  });

  const pg=it.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL);
  const gate=()=>{let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),resolve};};
  pg.each(['duplicate','abandon'] as const)('the real executor serializes a concurrent %s behind the same business commit', async contender => {
    const key=crypto.randomUUID(),input=body();
    // Pause the first real business commit at receipt insertion. PostgreSQL's
    // blocker PIDs, not a sleep or a mock transaction, prove both wait edges.
    await f.exec(`CREATE FUNCTION pause_receipt_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(731609,1); RETURN NEW; END$$;
      CREATE TRIGGER pause_receipt_commit BEFORE INSERT ON admin_refund_operation FOR EACH ROW EXECUTE FUNCTION pause_receipt_commit()`);
    await withFinancePeers(f.db,async([barrier,first,second])=>{
      const entered=gate(),release=gate();
      const hold=outcome(withTx(createContainerFromDb(barrier.db),async tx=>{
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731609,1)`);entered.resolve();await release.promise;
      }));
      let initial: ReturnType<typeof outcome<Awaited<ReturnType<typeof executeAdminRefundOperation>>>>|undefined;
      let competing: Promise<unknown>|undefined;
      try {
        await Promise.race([entered.promise,hold.then(result=>{if(!result.ok)throw result.error;})]);
        initial=outcome(executeAdminRefundOperation(createContainerFromDb(first.db),f.env,actor(),28,key,'return',input));
        await waitForFinanceBlock(f.db,first.pid,barrier.pid);
        competing=contender==='duplicate'
          ? outcome(executeAdminRefundOperation(createContainerFromDb(second.db),f.env,actor(),28,key,'return',input))
          : outcome(abandonAdminRefundOperation(createContainerFromDb(second.db),actor(),28,key,'return',input));
        await waitForFinanceBlock(f.db,second.pid,first.pid);release.resolve();
        expect((await hold).ok).toBe(true);
        expect(await initial).toMatchObject({ok:true,value:{replayed:false,receipt:{outcome:'return-approved'}}});
        expect(await competing).toMatchObject(contender==='duplicate'
          ? {ok:true,value:{replayed:true,receipt:{outcome:'return-approved'}}}
          : {ok:true,value:{outcome:'return-approved'}});
      } finally {release.resolve();await hold;await initial;await competing;}
    });
    expect(await receipts()).toHaveLength(1);expect(await f.statuses()).toHaveLength(1);expect((await refund()).refundType).toBe(4);
  });

  pg('a committed abandonment wins against a real executor already waiting on its original key', async () => {
    const key=crypto.randomUUID(),input=body();
    await withFinancePeers(f.db,async([first,second])=>{
      const entered=gate(),release=gate();
      const fence=outcome(withTx(createContainerFromDb(first.db),async tx=>{
        const receipt=await abandonAdminRefundOperation(createContainerFromDb(tx),actor(),28,key,'return',input);
        entered.resolve();await release.promise;return receipt;
      }));
      let pending: ReturnType<typeof outcome<Awaited<ReturnType<typeof executeAdminRefundOperation>>>>|undefined;
      try {
        await Promise.race([entered.promise,fence.then(result=>{if(!result.ok)throw result.error;})]);
        pending=outcome(executeAdminRefundOperation(createContainerFromDb(second.db),f.env,actor(),28,key,'return',input));
        await waitForFinanceBlock(f.db,second.pid,first.pid);release.resolve();
        expect(await fence).toMatchObject({ok:true,value:{outcome:'abandoned'}});
        expect(await pending).toMatchObject({ok:true,value:{replayed:true,receipt:{outcome:'abandoned'}}});
      } finally {release.resolve();await fence;await pending;}
    });
    expect(await receipts()).toHaveLength(1);expect(await f.statuses()).toEqual([]);expect((await refund()).refundType).toBe(0);
  });
});
