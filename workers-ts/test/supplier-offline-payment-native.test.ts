import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { DbClient } from '@/lib/di';
import { createContainerFromDb } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeIntegral, storeProductAttrValue, storeCart, userBill, systemAdmin, systemRole,
  paymentReconciliationCase, user, supplierTransactions, supplierFlowingWater } from '@/models/schema';
import { createToken } from '@/utils/jwt';
import { SupplierOfflinePaymentService } from '@/services/supplier/SupplierOfflinePaymentService';
import { manualRefundPaymentFacts } from '@/services/order/CustomerManualRefund';
import { requiredSupplierPermissions } from '@/services/supplier/SupplierPermissionService';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { StoreOrderPayService } from '@/services/order/StoreOrderPayService';
import { supplierOfflinePaymentFixture } from './helpers/supplierOfflinePayment';
import { supplierOrderEditActor, supplierOrderEditAppKey } from './helpers/supplierUnpaidOrderEdit';

const wiring = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.open }));
const app = createApp();
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier actual offline cash receipt, completed paid consumer and immutable origin', () => {
  let f: Awaited<ReturnType<typeof supplierOfflinePaymentFixture>>, id: number;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned Supplier cash scenario forbids external provider I/O'));
    f = await supplierOfflinePaymentFixture(); wiring.open.mockImplementation(() => f.container); id = (await f.createOffline()).id;
  }, 60000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  async function http(method: string, path: string, body?: unknown, actorId = 21, raw?: string) {
    const actor = supplierOrderEditActor(actorId), token = (await createToken(actorId, 'supplier', actor.authVersion, supplierOrderEditAppKey)).token;
    const response = await app.request('/supplierapi' + path, { method, headers: { Authorization: 'Bearer ' + token,
      'X-Supplier-Id': '8', 'Content-Type': 'application/json' }, ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }) }, f.paymentEnvironment);
    return { response, body: await response.json<{ status: number; msg: string; data: unknown }>() };
  }
  it('reads the actual pending offline seed without any DML and accepts only exact route methods', async () => {
    const before = await f.paymentState(), order = (await f.editState(id)).order, result = await http('GET', `/order/pay_offline/${id}`);
    expect(result.body).toMatchObject({ status: 200, data: { id, amount: order.payPrice, cash_required: true } });
    expect(result.response.headers.get('cache-control')).toContain('private, no-store');
    expect(await f.paymentState()).toEqual(before);
    expect(requiredSupplierPermissions('POST', `order/pay_offline/${id}`)).toEqual(['supplier.order.manage']);
    for (const verb of ['PUT', 'DELETE']) expect(requiredSupplierPermissions(verb, `order/pay_offline/${id}`)).toBeNull();
    expect(requiredSupplierPermissions('GET', 'order/payment_operations/not-uuid')).toBeNull();
  });
  it('pays the edited actual checkout through Supplier JWT and restricted LOGIN, consumes once, and preserves original cash and gift facts', async () => {
    const original = await f.editState(id), before = (await f.db.select().from(user).where(eq(user.uid, 11)))[0];
    const edit = { ...await f.body(id), pay_price: '18.75', gain_integral: '17' };
    await f.service.save(id, edit, supplierOrderEditActor());
    await f.withPaymentRuntime(async (runtime, payment) => {
      const [identity] = await runtime.db.execute(sql`SELECT current_user=session_user AS real, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated`);
      expect(identity).toEqual({ real: true, elevated: false });
      wiring.open.mockImplementation(() => runtime.container);
      const body = await f.paymentBody(id, payment), response = await http('POST', `/order/pay_offline/${id}`, body);
      expect(response.body).toMatchObject({ status: 200, data: { operation_id: body.operation_id, actor_id: 21, supplier_id: 7, state: 'committed', result: { id, paid: 1, pay_type: 'offline', pay_price: '18.75' } } });
      const state = await f.paymentState();
      expect((await http('POST', `/order/pay_offline/${id}`, body)).body).toMatchObject({ status: 200, data: response.body.data });
      expect(await f.paymentState()).toEqual(state);
    });
    await f.consumePaid(id);
    const after = await f.editState(id), account = (await f.db.select().from(user).where(eq(user.uid, 11)))[0];
    expect(after.order).toMatchObject({ paid: 1, payType: 'offline', payPrice: '18.75', gainIntegral: '17.00', supplierId: 7 });
    expect(BigInt(after.order.payPrice.replace('.', '')) + BigInt(after.order.changePrice.replace('.', ''))).toBe(BigInt(original.order.payPrice.replace('.', '')));
    expect(after.carts.map(row => JSON.parse(row.cartInfo!).gain_integral).reduce((sum, value) => sum + Number(value), 0)).toBe(17);
    expect(account.nowMoney).toBe(before.nowMoney); expect(account.integral).toBe(before.integral);
    expect(after.statuses.filter(row => row.changeType === 'supplier_order_offline')).toHaveLength(1);
    expect(after.statuses.filter(row => row.changeType === 'pay_success')).toHaveLength(1);
    expect(after.outbox.filter(row => row.eventType === 'order.paid')).toHaveLength(1);
    expect(await f.db.select().from(supplierTransactions)).toHaveLength(1); expect(await f.db.select().from(supplierFlowingWater)).toHaveLength(1);
    const facts = await manualRefundPaymentFacts(f.db, after.order);
    if (!('payment_origin' in facts)) throw Error('Actual Supplier payment origin missing');
    expect(facts.payment_origin).toMatchObject({ kind: 'supplier_order_offline', actor_id: 21, supplier_id: 7 });
    const stable = await f.paymentState(); await f.consumePaid(id, true); expect(await f.paymentState()).toEqual(stable);
  }, 60000);
  it('rejects changed cash, order, explicit confirmation, duplicate JSON and unknown fields before financial DML', async () => {
    const body = await f.paymentBody(id), before = await f.paymentState();
    for (const change of [{ amount: '1.00' }, { order_no: 'ForeignOrder' }, { cash_received: false }, { revision: '0'.repeat(64) }, { supplier_id: 8 }, { amount: '1.001' }])
      expect((await http('POST', `/order/pay_offline/${id}`, { ...body, ...change })).body.status).not.toBe(200);
    const { cash_received: _cash, ...without } = body;
    expect((await http('POST', `/order/pay_offline/${id}`, without)).body.status).not.toBe(200);
    const raw = JSON.stringify(body).replace('"amount":', '"amount":"1.00","a\\u006dount":');
    expect((await http('POST', `/order/pay_offline/${id}`, undefined, 21, raw)).body.status).not.toBe(200);
    expect(await f.paymentState()).toEqual(before);
  });
  it('refuses modern checkout lines whose SQL ownership was replaced with legacy zero owners', async () => {
    await f.db.update(storeOrderCartInfo).set({ type: 0, relationId: 0 }).where(eq(storeOrderCartInfo.oid, id));
    const before = await f.paymentState();
    await f.withPaymentRuntime(async (_runtime, payment) => {
      await expect(payment.seed(id, supplierOrderEditActor())).rejects.toThrow('归属');
    });
    expect(await f.paymentState()).toEqual(before);
  });
  it('preserves complete raw PHP zero-owner purchase lines through actual collection and the paid consumer', async () => {
    const original = await f.editState(id);
    for (const row of original.carts) {
      const info = JSON.parse(row.cartInfo!), product = info.product, sku = info.sku;
      for (const field of ['financial_version', 'product', 'sku', 'member_savings_version', 'paid_member', 'member_postage_price', 'member_coupon_price']) delete info[field];
      info.productInfo = { id: row.productId, store_name: product.storeName, give_integral: product.giveIntegral, attrInfo: { ...sku } };
      await f.db.update(storeOrderCartInfo).set({ type: 0, relationId: 0, cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, row.id));
    }
    const legacy = await f.editState(id);
    await f.withPaymentRuntime(async (_runtime, payment) => {
      expect(await payment.pay(id, await f.paymentBody(id, payment), supplierOrderEditActor())).toMatchObject({ state: 'committed' });
    });
    await f.consumePaid(id);
    const after = await f.editState(id);
    expect(after.carts).toEqual(legacy.carts); expect(after.order.paid).toBe(1);
    expect(await manualRefundPaymentFacts(f.db, after.order)).toMatchObject({ payment_origin: { kind: 'supplier_order_offline' } });
  });
  it('confirms a zero cash order without a fictitious physical-cash claim', async () => {
    await f.service.save(id, { ...await f.body(id), pay_price: '0.00' }, supplierOrderEditActor());
    await f.withPaymentRuntime(async (_runtime, payment) => {
      const body = await f.paymentBody(id, payment); expect(body).not.toHaveProperty('cash_received');
      await expect(payment.pay(id, { ...body, cash_received: true }, supplierOrderEditActor())).rejects.toThrow();
      expect(await payment.pay(id, body, supplierOrderEditActor())).toMatchObject({ state: 'committed', result: { pay_price: '0.00' } });
    });
    await f.consumePaid(id); expect((await f.editState(id)).order.paid).toBe(1);
  });
  it('confirms a genuinely admitted PC integral activity and debits required points once while preserving external cash', async () => {
    await f.db.update(user).set({ integral: 100 }).where(eq(user.uid, 11));
    await f.db.insert(storeIntegral).values({ id: 9, productId: 70, storeName: 'Owned Supplier point activity', stock: 8, quota: 8,
      onceNum: -1, num: -1, status: 1, isShow: 1, isDel: 0, freight: 1 });
    await f.db.insert(storeProductAttrValue).values({ id: 3, productId: 9, type: 4, unique: 'point001', suk: '红色,大号', stock: 8, quota: 8, price: '2.00', integral: 30 });
    await f.db.insert(storeCart).values({ id: 3, uid: 11, productId: 70, productAttrUnique: 'qared001', cartNum: 1, type: 4, activityId: 9, isNew: 1, status: 1 });
    let activityOrderId = 0;
    await f.withPaymentRuntime(async (runtime, payment) => {
      await f.exec(`GRANT SELECT,UPDATE ON public.store_integral TO "${runtime.role}"`);
      const created = await StoreOrderCreateService.createWithRuntime(runtime.container,
        { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'wxActivity' + crypto.randomUUID().replaceAll('-', '').slice(0, 20) },
        { uid: 11, key: crypto.randomUUID(), cartIds: [3], addressId: 11, userIp: '127.0.0.1', useIntegral: false, type: 4, payType: 'offline', from: 'pc' });
      await new StoreOrderPayService(runtime.container, f.paymentEnvironment).offlinePay(11, created.orderId, 'pc');
      const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
      activityOrderId = order.id; expect(order).toMatchObject({ type: 4, supplierId: 7, payIntegral: 30, paid: 0, payType: 'offline' });
      const body = await f.paymentBody(order.id, payment), before = (await f.db.select().from(user).where(eq(user.uid, 11)))[0];
      await payment.pay(order.id, body, supplierOrderEditActor());
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toEqual({ ...before, integral: 70 });
      const bills = await f.db.select().from(userBill).where(eq(userBill.eventKey, 'order_pay_integral')); expect(bills).toHaveLength(1);
      expect(bills[0]).toMatchObject({ uid: 11, linkId: String(order.id), number: '30.00', balance: '70.00' });
      await payment.pay(order.id, body, supplierOrderEditActor()); expect(await f.db.select().from(userBill).where(eq(userBill.eventKey, 'order_pay_integral'))).toEqual(bills);
    });
    await f.consumePaid(activityOrderId);
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, activityOrderId)))[0]).toMatchObject({ paid: 1, payType: 'offline', payIntegral: 30 });
  });
  it('denies view-only, numeric GET-only menu, foreign Supplier, expired, moved and disabled identities', async () => {
    const body = await f.paymentBody(id), before = await f.paymentState();
    for (const actor of [22, 23, 31, 39]) expect((await http('POST', `/order/pay_offline/${id}`, body, actor)).body.status).not.toBe(200);
    await expect(f.paymentService.pay(id, body, { ...supplierOrderEditActor(), expiresAt: 1 })).rejects.toThrow('过期');
    for (const change of [{ status: 0 }, { relationId: 8 }, { pwd: 'changed' }, { isDel: 1 }]) {
      await f.db.update(systemAdmin).set(change).where(eq(systemAdmin.id, 21));
      const state = await f.paymentState(); await expect(f.paymentService.pay(id, body, supplierOrderEditActor())).rejects.toThrow(); expect(await f.paymentState()).toEqual(state);
      await f.db.update(systemAdmin).set({ status: 1, relationId: 7, pwd: 'owned-native-unpaid-order-edit-password', isDel: 0 }).where(eq(systemAdmin.id, 21));
    }
    expect(await f.paymentState()).toEqual(before);
  });
  it('rejects initiated provider, paid, cancelled, split, refund and mixed-owner states without a second payment', async () => {
    const body = await f.paymentBody(id), [original] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, id));
    for (const change of [{ paid: 1 }, { status: 1 }, { isDel: 1 }, { isSystemDel: 1 }, { pid: -1 }, { supplierId: 0 }, { payType: 'yue' }, { refundStatus: 1 }]) {
      await f.db.update(storeOrder).set(change).where(eq(storeOrder.id, id)); const before = await f.paymentState();
      await expect(f.paymentService.pay(id, body, supplierOrderEditActor())).rejects.toThrow(); expect(await f.paymentState()).toEqual(before);
      await f.db.update(storeOrder).set(original).where(eq(storeOrder.id, id));
    }
    await f.db.insert(paymentReconciliationCase).values({ provider: 'wechat', profile: 'wechat', orderDomain: 'store_order', orderNo: original.orderId,
      expectedAmountCents: Math.round(Number(original.payPrice) * 100), initiatedTime: 1, currency: 'CNY', replayKey: crypto.randomUUID() });
    const before = await f.paymentState(); await expect(f.paymentService.pay(id, body, supplierOrderEditActor())).rejects.toThrow('支付已发起'); expect(await f.paymentState()).toEqual(before);
  });
  it('keeps original receipts readable after manage withdrawal without order SELECT and denies another live actor', async () => {
    const body = await f.paymentBody(id), result = await f.paymentService.pay(id, body, supplierOrderEditActor());
    await f.withPaymentRuntime(async (runtime, payment) => {
      await f.db.update(systemRole).set({ rules: 'supplier.order.view' }).where(eq(systemRole.id, 21));
      await f.exec(`REVOKE ALL ON public.store_order,public.store_order_cart_info,public.store_order_status,public.store_order_outbox FROM "${runtime.role}"`);
      const before = await f.paymentState();
      expect(await payment.receipt(body.operation_id, supplierOrderEditActor())).toEqual(result);
      expect(await payment.pay(id, body, supplierOrderEditActor())).toEqual(result);
      await expect(payment.receipt(body.operation_id, supplierOrderEditActor(22))).rejects.toThrow();
      expect(await f.paymentState()).toEqual(before);
    });
  });
  it('keeps unknown GET read-only and explicitly seals an absent operation under the real UUID lock', async () => {
    const operation = crypto.randomUUID(), before = await f.paymentState();
    expect(await f.paymentService.receipt(operation, supplierOrderEditActor())).toMatchObject({ state: 'unknown', order_id: null }); expect(await f.paymentState()).toEqual(before);
    await f.withPaymentRuntime(async runtime => {
      await runtime.db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731746,hashtext(${operation}))`);
        await expect(f.paymentService.resolve(operation, id, supplierOrderEditActor())).rejects.toMatchObject({ httpStatus: 409 });
      });
    });
    expect((await f.paymentService.resolve(operation, id, supplierOrderEditActor())).state).toBe('not_applied');
    await expect(f.paymentService.pay(id, { ...await f.paymentBody(id), operation_id: operation }, supplierOrderEditActor())).rejects.toMatchObject({ httpStatus: 409 });
  });
  it('recovers actual COMMIT-return loss through the immutable original UUID with no repeated payment', async () => {
    await f.withPaymentRuntime(async (runtime, payment) => {
      const body = await f.paymentBody(id, payment), transaction = runtime.db.transaction.bind(runtime.db);
      const fault = Object.create(runtime.db) as DbClient;
      Object.defineProperty(fault, 'transaction', { value: async (run: Parameters<typeof runtime.db.transaction>[0]) => {
        await transaction(run); throw Error('Actual committed Supplier payment response lost');
      } });
      const uncertain = new SupplierOfflinePaymentService(createContainerFromDb(fault), supplierOrderEditAppKey);
      await expect(uncertain.pay(id, body, supplierOrderEditActor())).rejects.toThrow('response lost');
      const before = await f.paymentState(); expect((await payment.receipt(body.operation_id, supplierOrderEditActor())).state).toBe('committed');
      expect((await payment.pay(id, body, supplierOrderEditActor())).state).toBe('committed'); expect(await f.paymentState()).toEqual(before);
      await expect(payment.pay(id, { ...body, amount: '1.00' }, supplierOrderEditActor())).rejects.toMatchObject({ httpStatus: 409 });
    });
  });
  it('rolls back paid, integral, audit, event and receipt when deferred DML changes a purchase fact', async () => {
    const body = await f.paymentBody(id), before = await f.paymentState();
    await f.exec(`CREATE FUNCTION public.owned_payment_late_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE public.store_order_cart_info SET settle_price='0.01' WHERE oid=NEW.oid; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER owned_payment_late_change AFTER INSERT ON public.store_order_status
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.owned_payment_late_change()`);
    await expect(f.paymentService.pay(id, body, supplierOrderEditActor())).rejects.toMatchObject({ httpStatus: 409 }); expect(await f.paymentState()).toEqual(before);
  });
  it('retains production NOWAIT rejection for independent order and authority writers', async () => {
    const body = await f.paymentBody(id), before = await f.paymentState();
    await f.withPaymentRuntime(async runtime => {
      for (const table of [storeOrder, systemRole]) await runtime.db.transaction(async tx => {
        if (table === storeOrder) await tx.update(storeOrder).set({ mark: 'held' }).where(eq(storeOrder.id, id));
        else await tx.update(systemRole).set({ rules: 'supplier.order.view' }).where(eq(systemRole.id, 21));
        await expect(f.paymentService.pay(id, body, supplierOrderEditActor())).rejects.toMatchObject({ httpStatus: 409 });
        await tx.execute(sql.raw(table === storeOrder ? `UPDATE public.store_order SET mark='' WHERE id=${id}` : "UPDATE public.system_role SET rules='supplier.order.manage,supplier.refund.manage' WHERE id=21"));
      });
    });
    expect(await f.paymentState()).toEqual(before);
  });
});
