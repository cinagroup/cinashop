/** Contract investigation, not acceptance of the unwired PHP order-ID route.
 * A whole-goods concession and a later monetary remainder are different from
 * selecting the remaining physical goods. Keep that distinction observable. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { withTx, createContainerFromDb } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, user } from '@/models/schema';
import { applyOrderRefundWithMaterialization, quoteOrderRefundWithMaterialization } from '@/services/order/StoreOrderRefundService';
import { prepareSupplierManualRefundApplication } from '@/services/supplier/SupplierManualRefundProof';
import { supplierManualRefundFixture } from './helpers/supplierManualRefund';
import { supplierOrderEditActor } from './helpers/supplierUnpaidOrderEdit';
import { ValidateException } from '@/utils/errors';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier order-ID proactive refund contract baseline on actual PG16', () => {
  let f: Awaited<ReturnType<typeof supplierManualRefundFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('No external provider traffic in the owned contract baseline'); });
    f = await supplierManualRefundFixture();
  }, 120000);
  afterEach(async () => { try { await f?.close(); } finally { vi.restoreAllMocks(); } }, 30000);

  it('reproduces a whole-goods cash concession and distinguishes its unreturned money from remaining refundable quantities', async () => {
    const created = await f.createOffline(), id = created.id;
    await f.service.save(id, { ...await f.body(id), pay_price: '18.75', gain_integral: '17' }, supplierOrderEditActor());
    await f.withPaymentRuntime(async (_runtime, payment) => payment.pay(id, await f.paymentBody(id, payment), supplierOrderEditActor()));
    await f.consumePaid(id);
    await f.withManualRuntime(async (runtime, service) => {
      const [beforeBuyer] = await runtime.db.select().from(user).where(eq(user.uid, 11));
      const order = await runtime.order(id), carts = await runtime.carts(id);
      const { refundId } = await withTx(runtime.container, async tx => {
        await tx.execute(sql`LOCK TABLE ONLY public.system_admin,ONLY public.system_supplier,ONLY public.system_role,ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
        const capability = await prepareSupplierManualRefundApplication(tx, supplierOrderEditActor(), order);
        return applyOrderRefundWithMaterialization(createContainerFromDb(tx), {
          uid: order.uid, orderId: order.orderId, applyType: 4, privilegedActor: 'supplier', selectorNamespace: 'row',
          supplierManualRefundCapability: capability, cartSelections: carts.map(row => ({ cartId: row.id, cartNum: row.cartNum })),
          refundReason: '全量商品退回，先返还部分现金', refundExplain: '真实PHP订单级少额退款合同基线',
          applicationOrderId: 'srf' + randomUUID().replaceAll('-', '').slice(0, 27),
          expectedRefundAmountCents: 1875, requestedRefundAmountCents: 700,
          authorizeApplication: async (_db, locked) => { expect(locked.id).toBe(id); expect(locked.supplierId).toBe(7); },
        }, 0);
      });
      const request = await f.manualBody(service, refundId);
      expect(request.refund_price).toBe('7.00');
      expect(await service.execute(refundId, request, supplierOrderEditActor())).toMatchObject({
        state: 'committed', result: { amount: '7.00', status: 'CASH_SUCCESS' },
      });
      const [refund] = await runtime.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, refundId));
      const [current] = await runtime.db.select().from(storeOrder).where(eq(storeOrder.id, id));
      const actualCarts = await runtime.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id));
      expect(refund).toMatchObject({ refundNum: order.totalNum, refundPrice: '7.00', refundedPrice: '7.00', refundType: 6 });
      expect(current).toMatchObject({ payPrice: '18.75', refundPrice: '7.00', paid: 1 });
      expect(actualCarts.every(row => row.splitStatus === 2 && row.splitSurplusNum === 0)).toBe(true);
      expect(await runtime.receipt(refundId)).toMatchObject({ disposition: 'whole', selectedOrderId: id, remainingOrderId: null });
      expect((await runtime.db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney).toBe(beforeBuyer.nowMoney);
      const settled = await f.manualSnapshot();
      expect(await service.execute(refundId, request, supplierOrderEditActor())).toMatchObject({ state: 'committed' });
      expect(await f.manualSnapshot()).toEqual(settled);
      // The old cash writer has no audit UPDATE privilege. A generic quote's
      // FOR SHARE receipt read is therefore not yet a usable Supplier GET.
      const quoteFailure = await withTx(runtime.container, async tx => {
        const locked = (await tx.select().from(storeOrder).where(eq(storeOrder.id, id)))[0];
        const cap = await prepareSupplierManualRefundApplication(tx, supplierOrderEditActor(), locked);
        return quoteOrderRefundWithMaterialization(createContainerFromDb(tx), {
          uid: locked.uid, orderId: locked.orderId, applyType: 4, privilegedActor: 'supplier', selectorNamespace: 'row',
          supplierManualRefundCapability: cap, cartSelections: carts.map(row => ({ cartId: row.id, cartNum: row.cartNum })),
          authorizeApplication: async (_db, actual) => { expect(actual.id).toBe(id); expect(actual.supplierId).toBe(7); },
        }, 0);
      }).then(() => null, (error: unknown) => error);
      const codes: string[] = [];
      for (let current: unknown = quoteFailure, depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
        if ('code' in current) codes.push(String(current.code));
        current = 'cause' in current ? current.cause : undefined;
      }
      expect(codes).toContain('42501');
      expect(await f.manualSnapshot()).toEqual(settled);
      // The remaining11.75 belongs to this same payment, not another line's
      // quote. Even the permitted real creator has no remaining goods to claim.
      const remainderFailure = await withTx(runtime.container, async tx => {
        const locked = (await tx.select().from(storeOrder).where(eq(storeOrder.id, id)))[0];
        const cap = await prepareSupplierManualRefundApplication(tx, supplierOrderEditActor(), locked);
        return applyOrderRefundWithMaterialization(createContainerFromDb(tx), {
          uid: locked.uid, orderId: locked.orderId, applyType: 4, privilegedActor: 'supplier', selectorNamespace: 'row',
          supplierManualRefundCapability: cap, cartSelections: carts.map(row => ({ cartId: row.id, cartNum: row.cartNum })),
          refundReason: '补退原商品尚欠现金', refundExplain: '',
          applicationOrderId: 'srf' + randomUUID().replaceAll('-', '').slice(0, 27),
          expectedRefundAmountCents: 1175, requestedRefundAmountCents: 1175,
          authorizeApplication: async (_db, actual) => { expect(actual.id).toBe(id); expect(actual.supplierId).toBe(7); },
        }, 0);
      }).then(() => null, (error: unknown) => error);
      expect(remainderFailure).toBeInstanceOf(ValidateException);
      expect((remainderFailure as Error).message).toBe('订单商品已全部退款');
      expect(await f.manualSnapshot()).toEqual(settled);
      expect(fetch).not.toHaveBeenCalled();
      console.log('SUPPLIER_PROACTIVE_CONTRACT_BASELINE', JSON.stringify({ orderId: id, goodsReturned: order.totalNum,
        payment: current.payPrice, returnedCash: current.refundPrice, remainingCash: '11.75',
        existingGoodsCreatorCannotRepresentMoneyOnlyRemainder: true,
        existingQuoteNeedsSeparateReviewedReceiptLock: true, quoteSqlState: '42501',
        remainderRejection: (remainderFailure as Error).message, routeAcceptance: false }));
    });
  }, 120000);
});
