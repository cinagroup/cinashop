import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { withTx } from '../src/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefundSplit, storeOrderStatus, storeOrderOutbox, supplierFlowingWater, supplierTransactions, user, userBill, storeProduct } from '../src/models/schema';
import { installAdminOrderEditOperation } from '../src/migrations/adminOrderEditOperation';
import { installAdminOrderGainPartition } from '../src/migrations/adminOrderGainPartition';
import { installSupplierOrderPriceRevision } from '@/migrations/supplierOrderPriceRevision';
import { ROUTINE_PAYMENT_ATTEMPT_SQL } from '@/migrations/routinePaymentAttempt';
import { loadUnpaidOrderGainIntegralProof } from '../src/services/order/UnpaidOrderGainIntegralProof';
import { planOrderFinancialSplit } from '../src/services/order/OrderSplitFinance';
import { applyStoreOrderBalancePayment } from '../src/services/order/StoreOrderPayService';
import { allocatePaidOrderBySupplier } from '../src/services/order/OrderSupplierAllocationService';
import { recordSupplierPayment } from '../src/services/supplier/SupplierFinanceService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { AdminOrderEditService } from '@/services/admin/AdminOrderEditService';
import { seedPriceActor, priceActor } from './helpers/adminOrderPriceFixture';
import { refundRuntimeFixture, shipping } from './helpers/refundRuntimeFixture';

type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Runtime = ReturnType<Fixture['operationsFor']>;
type Order = typeof storeOrder.$inferSelect;

/** Finite raw PHP purchase facts edited by the actual Admin six-field service,
 * live platform actor and restricted PG16 LOGIN. Real balance payment and
 * allocation/fulfillment/refund implementations; no external provider calls. */
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin desktop edited PHP gift finance lineage', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    await seedPriceActor(f.db);
    await f.db.update(user).set({ nowMoney: '100.00', integral: 100 }).where(eq(user.uid, 11));
  }, 60_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);

  async function install(runtime: Runtime) {
    await f.exec(`GRANT SELECT,UPDATE ON public.system_admin,public.system_role TO "${runtime.role}"`);
    // Fresh owned business fixture storage only; this is not evidence for the
    // separate production Mini identity/author commissioning protocol.
    await f.exec(ROUTINE_PAYMENT_ATTEMPT_SQL);
    await f.exec(`GRANT SELECT ON public.routine_payment_attempt TO "${runtime.role}"`);
    await f.db.transaction(async tx => {
      await installAdminOrderEditOperation(tx,runtime.role);
      await installAdminOrderGainPartition(tx,runtime.role);
      await installSupplierOrderPriceRevision(tx);
      // Existing app profile already grants this legacy absent-ledger proof.
      await tx.execute(sql.raw(`GRANT SELECT ON public.store_order_promotions TO "${runtime.role}"`));
    });
  }
  async function checkout(runtime: Runtime) {
    const created = await runtime.checkout({ key: 'legacy-gift-finance', orderId: 'LegacyGiftFinanceA' });
    const [order] = await runtime.db.select().from(storeOrder).where(eq(storeOrder.orderId,created.orderId));
    for (const row of await runtime.carts(order.id)) {
      const info: Record<string,unknown> = JSON.parse(row.cartInfo!);
      const product = info.product as Record<string,unknown>, sku = info.sku as Record<string,unknown>;
      for (const field of ['financial_version','product','sku','member_savings_version','paid_member','member_postage_price','member_coupon_price']) delete info[field];
      info.productInfo={id:row.productId,store_name:product.storeName,give_integral:product.giveIntegral,
        attrInfo:{...sku,write_times:sku.write_times}};
      await runtime.db.update(storeOrderCartInfo).set({cartInfo:JSON.stringify(info)}).where(eq(storeOrderCartInfo.id,row.id));
    }
    const rows = await runtime.carts(order.id);
    expect(planOrderFinancialSplit(order,rows,new Map(rows.map(row=>[row.cartId,row.cartNum])))?.legacyPhpProjection).toBe('original-purchase');
    return order;
  }
  async function edit(runtime: Runtime, value: Order, target: number) {
    const service = new AdminOrderEditService(runtime.container, 'owned-admin-legacy-edit-key');
    const beforeRows = await runtime.carts(value.id);
    const form = await service.form(value.id, priceActor());
    expect(await service.save(value.id, {...form.values, gain_integral:String(target)}, priceActor())).toEqual({changed:true});
    const order = await runtime.order(value.id), rows = await runtime.carts(value.id);
    const [operation] = await f.db.execute(sql`SELECT operation_id::text,evidence FROM public.admin_order_edit_operation_v1
      WHERE order_id=${value.id} ORDER BY (evidence->>'status_id')::integer DESC LIMIT 1`);
    const evidence = operation.evidence as {source_format:string;before_total:number;after_total:number};
    return {order,operationId:String(operation.operation_id),plan:{evidence,lines:rows.map(row=>({afterCartInfo:row.cartInfo!,
      beforeCartInfo:beforeRows.find(old=>old.id===row.id)!.cartInfo!}))}};
  }

  async function pay(runtime:Runtime,order:Order){
    expect((await applyStoreOrderBalancePayment(runtime.container,{uid:11,orderId:order.orderId})).outcome).toBe('paid');
    return withTx(runtime.container,async tx=>{
      const allocation=await allocatePaidOrderBySupplier(tx,order.id,order.orderId);
      for(const child of allocation.fulfillmentOrders)await recordSupplierPayment(tx,child);
      expect(allocation.fulfillmentOrders).toHaveLength(1);return allocation.fulfillmentOrders[0];
    });
  }
  async function prove(runtime:Runtime,id:number){
    return withTx(runtime.container,async tx=>{
      const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id));
      const rows=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)).orderBy(asc(storeOrderCartInfo.id));
      const proof=await loadUnpaidOrderGainIntegralProof(tx,order,rows);
      expect(proof).not.toBeNull();
      if(order.refundStatus!==2){
        expect(planOrderFinancialSplit({...order,refundPrice:'0.00',backIntegral:'0.00'},
          rows.map(row=>({...row,refundNum:0,splitStatus:0,splitSurplusNum:row.cartNum})),new Map(rows.map(row=>[row.cartId,row.cartNum])),proof)).not.toBeNull();
      }
      return {order,rows};
    });
  }

  it('keeps original PHP purchase facts through repeated edits, payment, ordinary fulfillment partitions and materialized refund generations',async()=>{
    await f.withRuntime(async runtime=>{
      await install(runtime);
      const original=await checkout(runtime),before=(await runtime.carts(original.id)).map(row=>JSON.parse(row.cartInfo!).productInfo);
      const first=await edit(runtime,original,10),second=await edit(runtime,first.order,25);
      expect(second.plan.evidence).toMatchObject({source_format:'legacy-php',before_total:10,after_total:25});
      for(const line of second.plan.lines)expect(JSON.parse(line.afterCartInfo)).not.toHaveProperty('financial_version');
      const paid=await pay(runtime,second.order),service=new SupplierFulfillmentService(runtime.container,f.env);
      const source=(await runtime.carts(paid.id)).find(row=>row.productId===70)!;
      const split=await service.splitDelivery(7,paid.id,shipping,[{cartId:source.cartId,cartNum:1}]);
      const active=[split.order_id,split.remaining_order_id!];
      expect((await Promise.all(active.map(id=>runtime.order(id)))).map(row=>row.gainIntegral)).toEqual(['12.00','13.00']);
      for(const id of active)await prove(runtime,id);
      expect(await f.exec('SELECT count(*)::int AS n FROM public.admin_order_gain_partition_v1')).toEqual([{n:2}]);
      await service.deliver(7,active[1],shipping);
      for(const id of active)await service.confirmTake(7,id);
      expect((await runtime.db.select().from(user).where(eq(user.uid,11)))[0].integral).toBe(25);
      for(const id of active){
        let current=id;
        while(true){
          const rows=await runtime.carts(current),row=rows.find(item=>item.refundNum<item.cartNum);
          if(!row)break;
          const refund=await runtime.apply(current,row.productId,row.cartNum);
          expect(await runtime.finish(refund.refundId)).toBe('completed');
          const [receipt]=await runtime.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId,refund.refundId));
          expect(receipt).toBeDefined();
          if(receipt.remainingOrderId===null)break;
          current=receipt.remainingOrderId;
          await prove(runtime,current);
        }
      }
      const [done]=await runtime.db.select().from(user).where(eq(user.uid,11));
      expect(done).toMatchObject({nowMoney:'100.00',integral:100});
      expect((await runtime.carts(original.id)).map(row=>JSON.parse(row.cartInfo!).productInfo)).toEqual(before);
      const bills=await runtime.db.select().from(userBill);
      expect(bills.filter(row=>row.eventKey==='integral_refund').reduce((sum,row)=>sum+Number(row.number),0)).toBe(25);
    });
  },120_000);

  it('retains a protected refund remainder through later fulfillment branching without reusing the original full grant',async()=>{
    await f.withRuntime(async runtime=>{
      await install(runtime);const original=await checkout(runtime),edited=await edit(runtime,original,7),paid=await pay(runtime,edited.order);
      const refund=await runtime.apply(paid.id,70,1);expect(await runtime.finish(refund.refundId)).toBe('completed');
      const [receipt]=await runtime.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId,refund.refundId));
      expect(receipt.remainingOrderId).toBeGreaterThan(0);const remaining=await prove(runtime,receipt.remainingOrderId!);
      expect(remaining.order.gainIntegral).toBe('4.00');
      const service=new SupplierFulfillmentService(runtime.container,f.env),line=remaining.rows.find(row=>row.productId===70)!;
      const split=await service.splitDelivery(7,remaining.order.id,shipping,[{cartId:line.cartId,cartNum:1}]);
      await prove(runtime,split.order_id);await prove(runtime,split.remaining_order_id!);
      expect((await runtime.order(split.order_id)).gainIntegral).toBe('4.00');
      expect((await runtime.order(split.remaining_order_id!)).gainIntegral).toBe('0.00');
      expect((await runtime.db.select().from(userBill)).filter(row=>row.eventKey==='integral_refund')).toEqual([]);
    });
  },120_000);

  it('rejects forged markers, changed bytes, wrong quantity or SQL owner and never relies on an amount bound',async()=>{
    await f.withRuntime(async runtime=>{
      await install(runtime);const original=await checkout(runtime),edited=await edit(runtime,original,7);
      const [row]=await runtime.carts(original.id);
      for(const change of [
        {cartInfo:JSON.stringify({...JSON.parse(row.cartInfo!),extra:'changed after receipt'})},
        {cartNum:row.cartNum+1},{relationId:8},{skuUnique:'another-sku'},
        {settlePrice:'9.99'},{productType:3},{writeTimes:row.writeTimes+1},
      ]){
        await expect(withTx(runtime.container,async tx=>{
          await tx.update(storeOrderCartInfo).set(change).where(eq(storeOrderCartInfo.id,row.id));
          const rows=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,original.id)).orderBy(asc(storeOrderCartInfo.id));
          await expect(loadUnpaidOrderGainIntegralProof(tx,edited.order,rows)).rejects.toThrow();
          throw Error('owned probe rollback');
        })).rejects.toThrow('owned probe rollback');
      }
      await withTx(runtime.container,async tx=>{
        const rows=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,original.id)).orderBy(asc(storeOrderCartInfo.id));
        const proof=await loadUnpaidOrderGainIntegralProof(tx,edited.order,rows);
        expect(()=>planOrderFinancialSplit(edited.order,rows,new Map(rows.map(item=>[item.cartId,item.cartNum])),JSON.parse(JSON.stringify(proof)))).toThrow();
      });
    });
  },120_000);

  it('rejects a late SQL replacement of a planned child unique instead of blessing it as a new immutable baseline',async()=>{
    await f.withRuntime(async runtime=>{
      await install(runtime);const original=await checkout(runtime),edited=await edit(runtime,original,7),paid=await pay(runtime,edited.order);
      const rows=await runtime.carts(paid.id),line=rows.find(row=>row.productId===70)!;
      const snapshot=async()=>({orders:await f.db.select().from(storeOrder).orderBy(asc(storeOrder.id)),
        carts:await f.db.select().from(storeOrderCartInfo).orderBy(asc(storeOrderCartInfo.id)),
        statuses:await f.db.select().from(storeOrderStatus).orderBy(asc(storeOrderStatus.id)),
        outbox:await f.db.select().from(storeOrderOutbox).orderBy(asc(storeOrderOutbox.id)),
        flow:await f.db.select().from(supplierFlowingWater).orderBy(asc(supplierFlowingWater.id)),
        transactions:await f.db.select().from(supplierTransactions).orderBy(asc(supplierTransactions.id)),
        users:await f.db.select().from(user).orderBy(asc(user.uid)),bills:await f.db.select().from(userBill).orderBy(asc(userBill.id)),
        partitions:await f.db.execute(sql`SELECT * FROM public.admin_order_gain_partition_v1 ORDER BY partition_id`)});
      const before=await snapshot();
      await f.exec(`CREATE FUNCTION public.owned_legacy_unique_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        NEW.unique=md5('owned_late_unique_'||NEW.id::text);RETURN NEW;END $$;
        CREATE TRIGGER owned_legacy_unique_change BEFORE INSERT ON public.store_order_cart_info
        FOR EACH ROW EXECUTE FUNCTION public.owned_legacy_unique_change()`);
      await expect(new SupplierFulfillmentService(runtime.container,f.env).splitDelivery(7,paid.id,shipping,[{cartId:line.cartId,cartNum:1}]))
        .rejects.toThrow('旧订单已编辑赠分的受保护来源凭据不一致');
      expect(await snapshot()).toEqual(before);
    });
  },120_000);

  it('uses SELECT-only evidence access, fails closed when that grant is absent and adds no table dependency for unmarked facts',async()=>{
    await f.withRuntime(async runtime=>{
      await install(runtime);const original=await checkout(runtime),edited=await edit(runtime,original,7);
      const paid=await pay(runtime,edited.order),source=(await runtime.carts(paid.id)).find(row=>row.productId===70)!;
      const split=await new SupplierFulfillmentService(runtime.container,f.env).splitDelivery(7,paid.id,shipping,[{cartId:source.cartId,cartNum:1}]);
      await f.exec(`REVOKE INSERT ON public.admin_order_edit_operation_v1,public.admin_order_gain_partition_v1 FROM "${runtime.role}"`);
      await prove(runtime,split.remaining_order_id!);
      const [privileges]=await runtime.exec("SELECT has_table_privilege(current_user,'public.admin_order_edit_operation_v1','SELECT') AS readable,has_table_privilege(current_user,'public.admin_order_edit_operation_v1','INSERT') AS writable");
      expect(privileges).toEqual({readable:true,writable:false});
      await f.exec(`REVOKE SELECT ON public.admin_order_edit_operation_v1 FROM "${runtime.role}"`);
      const before=await f.state();
      await expect(withTx(runtime.container,async tx=>loadUnpaidOrderGainIntegralProof(tx,edited.order,await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,original.id)).orderBy(asc(storeOrderCartInfo.id)))))
        .rejects.toMatchObject({httpStatus:503});
      expect(await f.state()).toEqual(before);
      await f.exec(`GRANT SELECT ON public.admin_order_edit_operation_v1 TO "${runtime.role}"; REVOKE SELECT ON public.admin_order_gain_partition_v1 FROM "${runtime.role}"`);
      await expect(prove(runtime,split.remaining_order_id!)).rejects.toMatchObject({httpStatus:503});
      expect(await f.state()).toEqual(before);
      await withTx(runtime.container,async tx=>{
        const rows=(await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,original.id)).orderBy(asc(storeOrderCartInfo.id))).map(row=>{
          const info=JSON.parse(row.cartInfo!);delete info.unpaid_gain_integral_edit;delete info.gain_integral;
          return{...row,cartInfo:JSON.stringify(info)};
        });
        expect(await loadUnpaidOrderGainIntegralProof(tx,original,rows)).toBeNull();
      });
    });
  },120_000);
  it('keeps Supplier zero platform provenance through actual payment and a materialized partial refund',async()=>{
    await f.db.update(storeProduct).set({type:0,relationId:0});
    await f.withRuntime(async runtime=>{
      await install(runtime);const original=await checkout(runtime);expect(original.supplierId).toBe(0);
      const edited=await edit(runtime,original,7),paid=await pay(runtime,edited.order);expect(paid.supplierId).toBe(0);
      const refund=await runtime.apply(paid.id,70,1);expect(await runtime.finish(refund.refundId)).toBe('completed');
      const [receipt]=await runtime.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId,refund.refundId));
      expect(receipt.remainingOrderId).toBeGreaterThan(0);await prove(runtime,receipt.remainingOrderId!);
      const records=await f.exec('SELECT supplier_id FROM public.admin_order_gain_partition_v1');expect(records.length).toBeGreaterThan(0);
      expect(records.every(row=>row.supplier_id===0)).toBe(true);
    });
  },120_000);

});
