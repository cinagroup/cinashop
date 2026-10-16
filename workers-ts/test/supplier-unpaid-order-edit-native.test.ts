import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { createToken } from '@/utils/jwt';
import { storeOrder, storeOrderCartInfo, systemRole, paymentReconciliationCase, systemNotification, systemMessage, orderNotificationDelivery } from '@/models/schema';
import { OrderOutboxService, isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { supplierOrderPriceRevisionIsActive } from '@/services/supplier/SupplierUnpaidOrderEditEffects';
import { installLegacyOrderGainPartition } from '@/migrations/legacyOrderGainPartition';
import { requiredSupplierPermissions } from '@/services/supplier/SupplierPermissionService';
import { supplierUnpaidOrderEditFixture, supplierOrderEditActor, supplierOrderEditAppKey,
  supplierOrderEditService } from './helpers/supplierUnpaidOrderEdit';

const wiring = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.open }));
const app = createApp();
const environment = { APP_KEY: supplierOrderEditAppKey, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
  ORDER_QUEUE: { send: async () => {}, sendBatch: async () => {} } } as unknown as Env;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier unpaid order edit actual checkout, JWT, SQL and immutable operation', () => {
  let f: Awaited<ReturnType<typeof supplierUnpaidOrderEditFixture>>, id: number;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned unpaid edit forbids external provider I/O'));
    f = await supplierUnpaidOrderEditFixture(); wiring.open.mockImplementation(() => f.container);
    id = (await f.checkout()).id;
  }, 60000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  async function http(method: string, path: string, body?: unknown, actorId = 21, raw?: string) {
    const actor = supplierOrderEditActor(actorId), token = (await createToken(actorId, 'supplier', actor.authVersion, environment.APP_KEY)).token;
    const response = await app.request('/supplierapi' + path, { method,
      headers: { Authorization: 'Bearer ' + token, 'X-Supplier-Id': '8', 'Content-Type': 'application/json' },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }) }, environment);
    return { response, body: await response.json<{ status: number; msg: string; data: unknown }>() };
  }
  it('round-trips the actual immutable PHP form fields and performs no order or ledger mutation for GET', async () => {
    const before = await f.editState(id), result = await http('GET', `/order/edit/${id}`);
    expect(result.body.status).toBe(200); expect(result.response.headers.get('cache-control')).toContain('private, no-store');
    expect(result.body.data).toMatchObject({ title: '修改订单', method: 'PUT', action: `/order/update/${id}`,
      fields: [expect.objectContaining({ field: 'order_id', disabled: true }), expect.objectContaining({ field: 'total_price', disabled: true }),
        expect.objectContaining({ field: 'total_postage', disabled: true }), expect.objectContaining({ field: 'pay_postage', disabled: true }),
        expect.objectContaining({ field: 'pay_price', precision: 2 }), expect.objectContaining({ field: 'gain_integral', precision: 0 })] });
    expect(await f.editState(id)).toEqual(before);
  });
  it('preserves the cumulative original cash baseline, original purchase facts and unrelated incentives across repeated edits', async () => {
    const before = await f.editState(id), original = BigInt(before.order.payPrice.replace('.', ''));
    for (const [cash, points] of [['20.00', '11'], ['25.00', '7'], ['60.00', '0'], ['0.00', '23']]) {
      const body = { ...await f.body(id), pay_price: cash, gain_integral: points }, receipt = await f.service.save(id, body, supplierOrderEditActor());
      expect(receipt).toMatchObject({ operation_id: body.operation_id, state: 'committed', result: { id, order_id: before.order.orderId, pay_price: cash, gain_integral: points + '.00', changed: true } });
      const after = await f.editState(id); expect(BigInt(after.order.payPrice.replace('.', '')) + BigInt(after.order.changePrice.replace('.', ''))).toBe(original);
      expect(after.order.orderId).toBe(before.order.orderId);
      for (const field of ['giveIntegral', 'payIntegral', 'useIntegral', 'couponPrice', 'deductionPrice', 'promotionsPrice', 'firstOrderPrice', 'oneBrokerage', 'twoBrokerage'] as const)
        expect(after.order[field], field).toBe(before.order[field]);
      for (const row of after.carts) {
        const old = before.carts.find(item => item.id === row.id)!;
        const oldJson = JSON.parse(old.cartInfo!), nextJson = JSON.parse(row.cartInfo!); delete oldJson.gain_integral; delete nextJson.gain_integral;
        expect(nextJson).toEqual(oldJson); expect({ ...row, cartInfo: old.cartInfo }).toEqual(old);
      }
    }
    const after = await f.editState(id); expect(after.statuses.filter(row => row.changeType === 'order_edit')).toHaveLength(4);
    expect(after.operations).toHaveLength(4); expect(after.outbox.filter(row => row.eventType === 'order.price.revision')).toHaveLength(4);
  });
  it('replays one exact operation without new DML and rejects changed bodies or stale source revisions', async () => {
    const body = { ...await f.body(id), pay_price: '22.00', gain_integral: '17' };
    const result = await f.service.save(id, body, supplierOrderEditActor()), saved = await f.editState(id);
    expect(await f.service.save(id, body, supplierOrderEditActor())).toEqual(result); expect(await f.editState(id)).toEqual(saved);
    await expect(f.service.save(id, { ...body, pay_price: '21.00' }, supplierOrderEditActor())).rejects.toMatchObject({ httpStatus: 409 });
    await expect(f.service.save(id, { ...body, operation_id: crypto.randomUUID() }, supplierOrderEditActor())).rejects.toMatchObject({ httpStatus: 409 });
    expect(await f.editState(id)).toEqual(saved);
  });
  it('uses actual JWT and a restricted LOGIN to edit complete historical PHP purchase snapshots repeatedly', async () => {
    await f.db.transaction(tx => installLegacyOrderGainPartition(tx));
    const before = await f.editState(id);
    for (const row of before.carts) {
      const info = JSON.parse(row.cartInfo!), product = info.product, sku = info.sku;
      for (const field of ['financial_version', 'product', 'sku', 'member_savings_version', 'paid_member', 'member_postage_price', 'member_coupon_price']) delete info[field];
      info.productInfo = { id: row.productId, store_name: product.storeName, give_integral: product.giveIntegral, attrInfo: { ...sku } };
      await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, row.id));
    }
    const original = await f.editState(id);
    await f.withEditRuntime(async (runtime, service) => {
      wiring.open.mockImplementation(() => runtime.container);
      const initial = await service.seed(id, supplierOrderEditActor());
      const unchanged = await http('PUT', `/order/update/${id}`, { ...initial.values, revision: initial.revision, operation_id: crypto.randomUUID() });
      expect(unchanged.body).toMatchObject({ status: 200, data: { state: 'committed', result: { changed: false } } });
      const afterNoop = await f.editState(id);
      expect({ ...afterNoop, operations: [] }).toEqual({ ...original, operations: [] }); expect(afterNoop.operations).toHaveLength(1);
      const cashOnly = await http('PUT', `/order/update/${id}`, { ...initial.values, pay_price: '18.75', revision: initial.revision, operation_id: crypto.randomUUID() });
      expect(cashOnly.body).toMatchObject({ status: 200, data: { state: 'committed', result: { changed: true, gain_integral: original.order.gainIntegral } } });
      expect((await f.editState(id)).carts).toEqual(original.carts);
      for (const [cash, gift] of [['18.75', '17'], ['23.00', '7']]) {
        const seed = await service.seed(id, supplierOrderEditActor());
        const response = await http('PUT', `/order/update/${id}`, { ...seed.values, pay_price: cash, gain_integral: gift, revision: seed.revision, operation_id: crypto.randomUUID() });
        expect(response.body).toMatchObject({ status: 200, data: { state: 'committed', result: { pay_price: cash, gain_integral: gift + '.00' } } });
      }
    });
    const after = await f.editState(id); expect(after.operations).toHaveLength(4);
    for (const row of after.carts) {
      const old = original.carts.find(item => item.id === row.id)!, prior = JSON.parse(old.cartInfo!), current = JSON.parse(row.cartInfo!);
      expect(current.financial_version).toBeUndefined(); expect(current.productInfo).toEqual(prior.productInfo);
      delete prior.gain_integral; delete current.gain_integral; delete current.unpaid_gain_integral_edit;
      expect(current).toEqual(prior); expect({ ...row, cartInfo: old.cartInfo }).toEqual(old);
    }
  });
  it('keeps no-op receipts terminal without rewriting root, carts, audit or notifications', async () => {
    const before = await f.editState(id), result = await f.service.save(id, await f.body(id), supplierOrderEditActor());
    expect(result.result?.changed).toBe(false); const after = await f.editState(id);
    expect({ ...after, operations: [] }).toEqual({ ...before, operations: [] }); expect(after.operations).toHaveLength(1);
  });
  it('enforces actual JWT owner, primary/manage/view and numeric GET menu permission boundaries', async () => {
    const body = { ...await f.body(id), pay_price: '24.00' }, before = await f.editState(id);
    for (const actor of [22, 23, 31, 39]) expect((await http('PUT', `/order/update/${id}`, body, actor)).body.status).not.toBe(200);
    expect((await http('GET', `/order/edit/${id}`, undefined, 22)).body.status).toBe(200);
    expect((await http('GET', `/order/edit/${id}`, undefined, 23)).body.status).toBe(200);
    expect(await f.editState(id)).toEqual(before);
    expect((await http('PUT', `/order/update/${id}`, { ...await f.body(id, supplierOrderEditActor(29)), pay_price: '24.00' }, 29)).body.status).toBe(200);
    expect(requiredSupplierPermissions('GET', 'order/update/1')).toBeNull();
    expect(requiredSupplierPermissions('PUT', 'order/edit/1')).toBeNull();
    expect(requiredSupplierPermissions('GET', 'order/edit_operations/not-a-uuid')).toBeNull();
  });
  it('rejects changed readonly values, unknown fields and duplicate decoded JSON members with zero financial DML', async () => {
    const body = await f.body(id), before = await f.editState(id);
    for (const extra of [{ total_price: '0.00' }, { pay_postage: '9.00' }, { supplier_id: 8 }, { gain_integral: '-1' }, { pay_price: '1.001' }])
      expect((await http('PUT', `/order/update/${id}`, { ...body, ...extra })).body.status).not.toBe(200);
    const raw = JSON.stringify(body).replace('"pay_price":', '"pay_price":"1.00","pay_\\u0070rice":');
    expect((await http('PUT', `/order/update/${id}`, undefined, 21, raw)).body.status).not.toBe(200);
    expect(await f.editState(id)).toEqual(before);
  });
  it('blocks paid, cancelled and already initiated provider orders before any root or points write', async () => {
    const body = { ...await f.body(id), pay_price: '2.00' }, original = (await f.editState(id)).order;
    for (const change of [{ paid: 1 }, { isDel: 1 }, { status: 1 }]) {
      await f.db.update(storeOrder).set(change).where(eq(storeOrder.id, id)); const before = await f.editState(id);
      await expect(f.service.save(id, body, supplierOrderEditActor())).rejects.toThrow(); expect(await f.editState(id)).toEqual(before);
      await f.db.update(storeOrder).set({ paid: original.paid, isDel: original.isDel, status: original.status }).where(eq(storeOrder.id, id));
    }
    await f.db.insert(paymentReconciliationCase).values({ provider: 'wechat', profile: 'wechat', orderDomain: 'store_order', orderNo: original.orderId,
      expectedAmountCents: Number(original.payPrice) * 100, initiatedTime: 1, currency: 'CNY', replayKey: crypto.randomUUID() });
    const before = await f.editState(id); await expect(f.service.save(id, body, supplierOrderEditActor())).rejects.toThrow('支付已发起'); expect(await f.editState(id)).toEqual(before);
  });
  it('keeps unknown GET read-only, explicitly seals not-applied, and recovers a committed own operation after management withdrawal', async () => {
    const operation = crypto.randomUUID(), before = await f.editState(id);
    expect(await f.service.receipt(operation, supplierOrderEditActor())).toMatchObject({ state: 'unknown', order_id: null }); expect(await f.editState(id)).toEqual(before);
    expect(await f.service.resolve(operation, id, supplierOrderEditActor())).toMatchObject({ state: 'not_applied', order_id: id });
    await expect(f.service.save(id, { ...await f.body(id), operation_id: operation, pay_price: '2.00' }, supplierOrderEditActor())).rejects.toMatchObject({ httpStatus: 409 });
    const body = { ...await f.body(id), pay_price: '23.00' }, saved = await f.service.save(id, body, supplierOrderEditActor());
    await f.db.update(systemRole).set({ rules: 'supplier.order.view' }).where(eq(systemRole.id, 21));
    expect(await f.service.receipt(body.operation_id, supplierOrderEditActor())).toEqual(saved);
    await expect(f.service.save(id, { ...await f.body(id), pay_price: '2.00' }, supplierOrderEditActor())).rejects.toThrow('权限');
    await expect(f.service.receipt(body.operation_id, supplierOrderEditActor(22))).rejects.toThrow('其他身份');
  });
  it('uses a separately authenticated restricted LOGIN and fails closed when an exact required grant is absent', async () => {
    await f.withEditRuntime(async (runtime, service) => {
      const [identity] = await runtime.db.execute(sql`SELECT current_user = session_user AS direct, r.rolsuper AS owner FROM pg_roles r WHERE rolname=current_user`);
      expect(identity).toMatchObject({ direct: true, owner: false });
      const seed = await service.seed(id, supplierOrderEditActor()), body = { ...seed.values, operation_id: crypto.randomUUID(), revision: seed.revision, pay_price: '26.00', gain_integral: '19' };
      expect((await service.save(id, body, supplierOrderEditActor())).state).toBe('committed');
      const next = { ...await f.body(id), pay_price: '25.00' }, before = await f.editState(id);
      await f.exec(`REVOKE INSERT ON public.supplier_order_edit_operation_v1 FROM "${runtime.role}"`);
      expect((await service.seed(id, supplierOrderEditActor())).values.pay_price).toBe('26.00');
      expect((await service.receipt(body.operation_id, supplierOrderEditActor())).state).toBe('committed');
      await expect(service.save(id, next, supplierOrderEditActor())).rejects.toMatchObject({ httpStatus: 503 }); expect(await f.editState(id)).toEqual(before);
    });
  });
  it('rejects a formerly valid form after a later edit restores identical cash and points', async () => {
    await f.service.save(id, { ...await f.body(id), pay_price: '22.00', gain_integral: '17' }, supplierOrderEditActor());
    const stale = { ...await f.body(id), pay_price: '20.00' }, first = await f.editState(id);
    await f.service.save(id, { ...await f.body(id), pay_price: '24.00', gain_integral: '18' }, supplierOrderEditActor());
    await f.service.save(id, { ...await f.body(id), pay_price: '22.00', gain_integral: '17' }, supplierOrderEditActor());
    const after = await f.editState(id); expect(after.order).toEqual(first.order); expect(after.carts).toEqual(first.carts);
    await expect(f.service.save(id, stale, supplierOrderEditActor())).rejects.toMatchObject({ httpStatus: 409 });
    expect(await f.editState(id)).toEqual(after);
  });
  it('stages the actual PHP SMS and inbox once and never reactivates an obsolete equal-amount notice', async () => {
    await f.db.delete(systemNotification).where(eq(systemNotification.mark, 'price_revision'));
    await f.db.insert(systemNotification).values({ mark: 'price_revision', isSms: 1, isSystem: 1, isWechat: 1, isRoutine: 1,
      smsId: 'OWNED_REVISION', systemTitle: '订单{order_id}改价', systemText: '请支付{pay_price}元' });
    const consumer = new OrderOutboxService(f.container, environment);
    const save = async (cash: string, points: string) => {
      await f.service.save(id, { ...await f.body(id), pay_price: cash, gain_integral: points }, supplierOrderEditActor());
      return (await f.editState(id)).outbox.filter(row => row.eventType === 'order.price.revision').at(-1)!;
    };
    const message = (event: Awaited<ReturnType<typeof save>>) => ({ action: 'processOrderNotificationOutbox' as const, outboxId: event.id, eventKey: event.eventKey });
    const a = await save('22.00', '17'); expect(isOrderNotificationOutboxMessage(message(a))).toBe(true); expect(await consumer.processMessage(message(a))).toBe('completed');
    expect(await consumer.processMessage(message(a))).toBe('already-completed');
    const [delivery] = await f.db.select().from(orderNotificationDelivery); expect(delivery).toMatchObject({ channel: 'sms', noticeMark: 'price_revision',
      payload: { kind: 'sms', params: { order_id: (await f.editState(id)).order.orderId, pay_price: '22.00' } } });
    expect(isOrderNotificationDeliveryMessage({ action: 'processOrderNotificationDelivery', deliveryId: delivery.id, eventKey: a.eventKey, channel: 'sms' })).toBe(true);
    expect(await f.db.select().from(orderNotificationDelivery)).toHaveLength(1);
    expect(await f.db.select().from(systemMessage)).toHaveLength(1);
    const b = await save('24.00', '18'), c = await save('22.00', '17');
    expect(await supplierOrderPriceRevisionIsActive(f.db, a.eventKey)).toBe(false);
    expect(await supplierOrderPriceRevisionIsActive(f.db, b.eventKey)).toBe(false);
    expect(await supplierOrderPriceRevisionIsActive(f.db, c.eventKey)).toBe(true);
    await f.db.update(orderNotificationDelivery).set({ status: 'ENQUEUED' }).where(eq(orderNotificationDelivery.id, delivery.id));
    expect(await new OrderNotificationDeliveryService(f.container, environment).processMessage({ action: 'processOrderNotificationDelivery',
      deliveryId: delivery.id, eventKey: a.eventKey, channel: 'sms' })).toBe('skipped');
    expect((await f.db.select().from(orderNotificationDelivery))[0]).toMatchObject({ status: 'SKIPPED', attemptCount: 0 });
    await consumer.processMessage(message(b)); await consumer.processMessage(message(c));
    expect(await f.db.select().from(orderNotificationDelivery)).toHaveLength(2); expect(await f.db.select().from(systemMessage)).toHaveLength(2);
    await f.db.update(storeOrder).set({ uid: 22 }).where(eq(storeOrder.id, id));
    expect(await supplierOrderPriceRevisionIsActive(f.db, c.eventKey)).toBe(false);
  });
  it('rolls back every edit fact when a deferred trigger changes an unrelated purchase column', async () => {
    const body = { ...await f.body(id), pay_price: '21.00', gain_integral: '19' }, before = await f.editState(id);
    await f.exec(`CREATE FUNCTION public.owned_edit_late_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE public.store_order_cart_info SET settle_price='0.01' WHERE oid=NEW.oid; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER owned_edit_late_change AFTER INSERT ON public.store_order_status
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.owned_edit_late_change();`);
    await expect(f.service.save(id, body, supplierOrderEditActor())).rejects.toMatchObject({ httpStatus: 409 });
    expect(await f.editState(id)).toEqual(before);
  });
  it('does not seal an in-flight operation and fences concurrent authority writes before financial DML', async () => {
    const operation = crypto.randomUUID(), before = await f.editState(id), body = { ...await f.body(id), pay_price: '21.00' };
    await f.withEditRuntime(async runtime => {
      await runtime.db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731744, hashtext(${operation}))`);
        expect((await f.service.receipt(operation, supplierOrderEditActor())).state).toBe('unknown');
        await expect(f.service.resolve(operation, id, supplierOrderEditActor())).rejects.toMatchObject({ httpStatus: 409 });
      });
      await runtime.db.transaction(async tx => {
        await tx.update(systemRole).set({ rules: 'supplier.order.view' }).where(eq(systemRole.id, 21));
        await expect(f.service.save(id, body, supplierOrderEditActor())).rejects.toMatchObject({ httpStatus: 409 });
      });
    });
    expect(await f.editState(id)).toEqual(before);
    expect((await f.service.resolve(operation, id, supplierOrderEditActor())).state).toBe('not_applied');
  });
  it('recovers actual COMMIT-return loss through the original operation without a second edit', async () => {
    const body = { ...await f.body(id), pay_price: '25.00', gain_integral: '13' };
    const lost = new Proxy(f.db, { get(target, key) {
      const member = Reflect.get(target, key);
      if (key === 'transaction') return async (...args: unknown[]) => { await Reflect.apply(member, target, args); throw Error('owned post-COMMIT reply lost'); };
      return typeof member === 'function' ? member.bind(target) : member;
    } }) as DbClient;
    await expect(supplierOrderEditService(lost).save(id, body, supplierOrderEditActor())).rejects.toThrow('post-COMMIT');
    const before = await f.editState(id), result = await f.service.receipt(body.operation_id, supplierOrderEditActor());
    expect(result.state).toBe('committed'); expect(await f.service.save(id, body, supplierOrderEditActor())).toEqual(result);
    expect(await f.editState(id)).toEqual(before);
  });
});
