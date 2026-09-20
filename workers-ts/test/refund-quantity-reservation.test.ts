import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { adminRefundEvidenceFixture } from './helpers/adminRefundEvidenceFixture';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, userBrokerage } from '../src/models/schema';
import { applyOrderRefund, approveStoreOrderReturn, ensureAutomaticOrderRefund, finalizeStoreOrderRefund, StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { readRefundQuantityReservation, reserveRefundQuantities } from '../src/services/order/RefundQuantityReservation';
import { lockOrderSettlement } from '../src/services/order/OrderBrokerageService';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { AlipayRefundService } from '../src/services/payment/AlipayRefundService';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

let f:Awaited<ReturnType<typeof adminRefundEvidenceFixture>>;
const input=()=>({uid:11,orderId:'local_refund_1',applyType:1,refundReason:'Quantity lifecycle test',refundExplain:'',cartSelections:[{cartId:501,cartNum:1}]});
const service=()=>new StoreOrderRefundService(f.container,f.env);
const cart=async()=>{const [row]=await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id,1));return row;};
const refund=async(id:number)=>{const [row]=await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,id));return row;};
const state=async()=>({financial:await f.snapshot(),applications:await f.applications(),statuses:await f.statuses(),carts:await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id)});
beforeEach(async()=>{
  f=await adminRefundEvidenceFixture(undefined,[userBrokerage]);
  await f.db.update(storeOrderCartInfo).set({skuUnique:'qared001'}).where(eq(storeOrderCartInfo.id,1));
  const forbid=async()=>{throw Error('Unconfigured provider I/O');};
  vi.spyOn(globalThis,'fetch').mockImplementation(forbid);
  for(const gateway of [WechatPayService,AlipayRefundService])for(const method of ['requestRefund','queryRefund'] as const)vi.spyOn(gateway.prototype,method).mockImplementation(forbid);
},30000);
afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}},45000);

it('reserves exactly selected quantities at application commit without settling money, stock or order status',async()=>{
  const before=await f.snapshot(),created=await applyOrderRefund(f.container,input());
  expect((await cart()).refundNum).toBe(1);expect(await f.snapshot()).toEqual(before);
  const row=await refund(created.refundId);expect(readRefundQuantityReservation(row)).toEqual({version:'refund-quantity-reservation-v1',orderId:1,uid:11,
    items:[{rowId:1,cartId:501,cartNum:1,beforeRefundNum:0,totalNum:2}]});
  expect(JSON.parse(row.cartInfo!)).toMatchObject({cartIds:[{cartId:501,cartNum:1}]});
  expect(await ensureAutomaticOrderRefund(f.container,input())).toEqual(created);expect((await cart()).refundNum).toBe(1);
  await expect(applyOrderRefund(f.container,input())).rejects.toThrow('进行中');
});
it('normalizes implicit cart selectors into exact stored quantities and reserves all selected remaining goods',async()=>{
  const created=await applyOrderRefund(f.container,{...input(),cartSelections:undefined,cartIds:[1]});
  expect((await cart()).refundNum).toBe(2);expect(readRefundQuantityReservation(await refund(created.refundId))?.items[0].cartNum).toBe(2);
});
it('settlement consumes the existing hold without incrementing twice, and a later partial refund reserves only the remainder',async()=>{
  const first=await applyOrderRefund(f.container,input());await finalizeStoreOrderRefund(f.container,first.refundId);
  expect((await cart()).refundNum).toBe(1);expect(await finalizeStoreOrderRefund(f.container,first.refundId)).toBe('already-completed');
  const second=await applyOrderRefund(f.container,{...input(),cartSelections:undefined});expect((await cart()).refundNum).toBe(2);
  expect(readRefundQuantityReservation(await refund(second.refundId))?.items[0]).toMatchObject({beforeRefundNum:1,cartNum:1});
  await finalizeStoreOrderRefund(f.container,second.refundId);expect((await cart()).refundNum).toBe(2);
  const financial=await f.snapshot();expect(financial.users.find(row=>row.uid===11)?.nowMoney).toBe('10.00');
  expect(financial.bills.filter(row=>row.type==='pay_product_refund')).toHaveLength(2);
});
it.each(['cancel','refuse'] as const)('%s releases only its own hold and a new application can reuse the quantity',async mode=>{
  const first=await applyOrderRefund(f.container,input()),before=await f.snapshot();
  if(mode==='cancel')await service().cancelApply(11,first.refundId);else await service().refuseRefund(first.refundId,'Not eligible');
  expect((await cart()).refundNum).toBe(0);expect((await f.snapshot()).users).toEqual(before.users);expect((await f.snapshot()).bills).toEqual(before.bills);
  if(mode==='cancel')await expect(service().cancelApply(11,first.refundId)).rejects.toThrow();else await service().refuseRefund(first.refundId,'Not eligible');
  const second=await applyOrderRefund(f.container,input());expect(second.refundId).not.toBe(first.refundId);expect((await cart()).refundNum).toBe(1);
});
it('releasing a later hold preserves the quantity already settled by a prior refund',async()=>{
  const first=await applyOrderRefund(f.container,input());await finalizeStoreOrderRefund(f.container,first.refundId);
  const second=await applyOrderRefund(f.container,input());expect((await cart()).refundNum).toBe(2);
  await service().cancelApply(11,second.refundId);expect((await cart()).refundNum).toBe(1);
  expect((await f.snapshot()).users.find(row=>row.uid===11)?.nowMoney).toBe('5.00');
});
it('return approval and customer shipment retain the hold until cancellation or settlement',async()=>{
  const created=await applyOrderRefund(f.container,{...input(),applyType:2});await approveStoreOrderReturn(f.container,created.refundId);
  await service().submitReturnExpress(11,{id:created.refundId,refundExpress:'LOCAL-RETURN-1'});expect((await cart()).refundNum).toBe(1);
  await service().cancelApply(11,created.refundId);expect((await cart()).refundNum).toBe(0);
});
it('UNKNOWN provider work retains the hold and rejects release; explicit original recovery settles once',async()=>{
  await f.db.update(storeOrder).set({payType:'weixin'}).where(eq(storeOrder.id,1));
  vi.mocked(WechatPayService.prototype.requestRefund).mockRejectedValue(Error('synthetic transport lost'));
  vi.mocked(WechatPayService.prototype.queryRefund).mockResolvedValue({status:'SUCCESS',providerRefundId:'quantity-local-1'});
  const created=await applyOrderRefund(f.container,input());await expect(service().agreeRefund(created.refundId)).rejects.toThrow('结果未知');
  expect((await cart()).refundNum).toBe(1);
  await expect(service().cancelApply(11,created.refundId)).rejects.toThrow('结果待确认');
  await expect(service().refuseRefund(created.refundId,'Not eligible')).rejects.toThrow('结果待确认');
  await service().agreeRefund(created.refundId);expect((await cart()).refundNum).toBe(1);
  expect(WechatPayService.prototype.requestRefund).toHaveBeenCalledTimes(1);expect(WechatPayService.prototype.queryRefund).toHaveBeenCalledTimes(1);
});
it.each(['settle','cancel','refuse'] as const)('counter drift fails closed before %s, without subtracting another claim or repairing data',async mode=>{
  const created=await applyOrderRefund(f.container,input());await f.db.update(storeOrderCartInfo).set({refundNum:2}).where(eq(storeOrderCartInfo.id,1));
  const before=await state();
  await expect(mode==='settle'?finalizeStoreOrderRefund(f.container,created.refundId):mode==='cancel'?service().cancelApply(11,created.refundId):service().refuseRefund(created.refundId,'No')).rejects.toThrow('预占');
  expect(await state()).toEqual(before);
});
it.each(['version','order','uid','row','quantity','selector','extra','duplicate','null'] as const)('malformed marked %s never falls back to the legacy settlement path',async change=>{
  const created=await applyOrderRefund(f.container,input()),row=await refund(created.refundId);
  const parsed=JSON.parse(row.cartInfo!);
  if(change==='version')parsed.quantityReservation.version='future';if(change==='order')parsed.quantityReservation.orderId=2;
  if(change==='uid')parsed.quantityReservation.uid=22;if(change==='row')parsed.quantityReservation.items[0].rowId=2;
  if(change==='quantity')parsed.quantityReservation.items[0].cartNum=2;if(change==='selector')parsed.cartIds[0].cartId=502;
  if(change==='extra')parsed.quantityReservation.extra=true;if(change==='duplicate')parsed.quantityReservation.items.push(parsed.quantityReservation.items[0]);
  if(change==='null')parsed.quantityReservation=null;
  await f.db.update(storeOrderRefund).set({cartInfo:JSON.stringify(parsed)}).where(eq(storeOrderRefund.id,row.id));
  const before=await state();await expect(service().agreeRefund(row.id)).rejects.toThrow('预占');expect(await state()).toEqual(before);
});
it('a late application audit failure rolls back both the reservation and application',async()=>{
  await f.exec("CREATE FUNCTION quantity_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit fault'; END $$; CREATE TRIGGER quantity_fail_audit BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION quantity_fail_audit()");
  const before=await state();await expect(applyOrderRefund(f.container,input())).rejects.toThrow();expect(await state()).toEqual(before);
});
it.each(['cancel','refuse'] as const)('a %s audit failure restores the held counter and active state atomically',async mode=>{
  const created=await applyOrderRefund(f.container,input());
  await f.exec("CREATE FUNCTION quantity_fail_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic release audit fault'; END $$; CREATE TRIGGER quantity_fail_release BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION quantity_fail_release()");
  const before=await state();await expect(mode==='cancel'?service().cancelApply(11,created.refundId):service().refuseRefund(created.refundId,'No')).rejects.toThrow();
  expect(await state()).toEqual(before);
});
it('financial rollback retains the existing hold and a later explicit retry does not reserve twice',async()=>{
  const created=await applyOrderRefund(f.container,input());
  await f.exec("CREATE FUNCTION quantity_fail_bill() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic bill fault'; END $$; CREATE TRIGGER quantity_fail_bill BEFORE INSERT ON user_bill FOR EACH ROW EXECUTE FUNCTION quantity_fail_bill()");
  const before=await state();await expect(finalizeStoreOrderRefund(f.container,created.refundId)).rejects.toThrow();expect(await state()).toEqual(before);
  await f.exec('DROP TRIGGER quantity_fail_bill ON user_bill');await finalizeStoreOrderRefund(f.container,created.refundId);expect((await cart()).refundNum).toBe(1);
});
it.each(['settle','cancel'] as const)('unmarked legacy application %s keeps the pre-reservation lifecycle',async mode=>{
  const created=await applyOrderRefund(f.container,input());
  await f.db.update(storeOrderRefund).set({cartInfo:'{"cartIds":[{"cartId":501,"cartNum":1}]}'}).where(eq(storeOrderRefund.id,created.refundId));
  await f.db.update(storeOrderCartInfo).set({refundNum:0}).where(eq(storeOrderCartInfo.id,1));
  expect(readRefundQuantityReservation(await refund(created.refundId))).toBeNull();
  if(mode==='settle')await finalizeStoreOrderRefund(f.container,created.refundId);else await service().cancelApply(11,created.refundId);
  expect((await cart()).refundNum).toBe(mode==='settle'?1:0);
});
it('cancelling an unmarked legacy application never subtracts quantities settled by an earlier refund',async()=>{
  const first=await applyOrderRefund(f.container,input());await finalizeStoreOrderRefund(f.container,first.refundId);
  const second=await applyOrderRefund(f.container,input());
  await f.db.update(storeOrderRefund).set({cartInfo:'{"cartIds":[{"cartId":501,"cartNum":1}]}'}).where(eq(storeOrderRefund.id,second.refundId));
  // Reconstruct an old, unreserved active application following one settlement.
  await f.db.update(storeOrderCartInfo).set({refundNum:1}).where(eq(storeOrderCartInfo.id,1));
  const before=await f.snapshot();await service().cancelApply(11,second.refundId);
  expect((await cart()).refundNum).toBe(1);expect(await f.snapshot()).toEqual(before);
});
it('rejects reservation outside the shared application transaction before any row mutation',async()=>{
  const before=await state();
  await expect(reserveRefundQuantities(f.db,{id:1,uid:11},[{cartId:501,cartNum:1}])).rejects.toThrow('locked application transaction');
  expect(await state()).toEqual(before);
});
describe('independent native PostgreSQL order/claim ordering',()=>{
  it('rechecks current order ownership after a cancellation waits for the order lock',async()=>{
    const original=await applyOrderRefund(f.container,input());
    await withFinancePeers(f.db,async([holder,cancel])=>{
      let unlock!:()=>void,locked!:()=>void;const ready=new Promise<void>(resolve=>locked=resolve),release=new Promise<void>(resolve=>unlock=resolve);
      const holding=withTx(createContainerFromDb(holder.db),async tx=>{
        await lockOrderSettlement(tx,1);locked();await release;
        await tx.update(storeOrder).set({uid:22}).where(eq(storeOrder.id,1));
      });await ready;
      const cancelled=outcome(new StoreOrderRefundService(createContainerFromDb(cancel.db),f.env).cancelApply(11,original.refundId));
      try{await waitForFinanceBlock(f.db,cancel.pid,holder.pid);}finally{unlock();}
      await holding;expect((await cancelled).ok).toBe(false);
      expect((await cart()).refundNum).toBe(1);expect((await refund(original.refundId)).isCancel).toBe(0);
      expect((await f.statuses()).filter(row=>row.changeType==='cancel_apply_refund')).toHaveLength(0);
    });
  });
  it('two applications serialize to one active application and one reservation',async()=>{
    await withFinancePeers(f.db,async([holder,first,second])=>{
      let unlock!:()=>void,locked!:()=>void;const ready=new Promise<void>(resolve=>locked=resolve),release=new Promise<void>(resolve=>unlock=resolve);
      const holding=withTx(createContainerFromDb(holder.db),async tx=>{await lockOrderSettlement(tx,1);locked();await release;});await ready;
      const a=outcome(applyOrderRefund(createContainerFromDb(first.db),input()));await waitForFinanceBlock(f.db,first.pid,holder.pid);
      const b=outcome(applyOrderRefund(createContainerFromDb(second.db),input()));
      try{await waitForFinanceBlock(f.db,second.pid,holder.pid);}finally{unlock();}
      await holding;const results=await Promise.all([a,b]);expect(results.filter(row=>row.ok)).toHaveLength(1);expect((await cart()).refundNum).toBe(1);
    });
  });
  it('a queued cancellation releases before a queued fresh application reuses the same quantity',async()=>{
    const original=await applyOrderRefund(f.container,input());
    await withFinancePeers(f.db,async([holder,cancel,apply])=>{
      let unlock!:()=>void,locked!:()=>void;const ready=new Promise<void>(resolve=>locked=resolve),release=new Promise<void>(resolve=>unlock=resolve);
      const holding=withTx(createContainerFromDb(holder.db),async tx=>{await lockOrderSettlement(tx,1);locked();await release;});await ready;
      const cancelled=outcome(new StoreOrderRefundService(createContainerFromDb(cancel.db),f.env).cancelApply(11,original.refundId));await waitForFinanceBlock(f.db,cancel.pid,holder.pid);
      const created=outcome(applyOrderRefund(createContainerFromDb(apply.db),input()));
      try{await waitForFinanceBlock(f.db,apply.pid,holder.pid);}finally{unlock();}
      await holding;expect((await cancelled).ok).toBe(true);expect((await created).ok).toBe(true);expect((await cart()).refundNum).toBe(1);
      expect((await refund(original.refundId)).isCancel).toBe(1);
    });
  });
  it('settlement wins a held refund lock; delayed cancellation cannot release completed quantities',async()=>{
    const original=await applyOrderRefund(f.container,input());
    await withFinancePeers(f.db,async([holder,settle,cancel])=>{
      let unlock!:()=>void,locked!:()=>void;const ready=new Promise<void>(resolve=>locked=resolve),release=new Promise<void>(resolve=>unlock=resolve);
      const holding=withTx(createContainerFromDb(holder.db),async tx=>{await lockOrderSettlement(tx,1);locked();await release;});await ready;
      const settled=outcome(finalizeStoreOrderRefund(createContainerFromDb(settle.db),original.refundId));await waitForFinanceBlock(f.db,settle.pid,holder.pid);
      const cancelled=outcome(new StoreOrderRefundService(createContainerFromDb(cancel.db),f.env).cancelApply(11,original.refundId));
      try{await waitForFinanceBlock(f.db,cancel.pid,settle.pid);}finally{unlock();}
      await holding;expect((await settled).ok).toBe(true);expect((await cancelled).ok).toBe(false);expect((await cart()).refundNum).toBe(1);
      expect((await refund(original.refundId)).refundType).toBe(6);
    });
  });
});
