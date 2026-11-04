/** Genuine UserJWT checkout/payment and Admin/Kefu HTTP writeoff; Customer writeoff
 * uses its real service on the already commissioned independent Cashier LOGIN.
 * App Queue/SMS sender are unchanged, only transport is local. This does not
 * commission the Customer HTTP route or seed successful business facts. */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContainerFromDb } from '@/lib/di';
import { CustomerWorkWriteoffService } from '@/services/customer-work/CustomerWorkWriteoffService';
import { customerWriteoffOperationReadiness } from '@/migrations/runCustomerWriteoffOperation';
import { cashierSecondCardOriginReadiness } from '@/migrations/runCashierSecondCardOrigin';
import type { AppVariables, Env } from '@/env';
import { errorHandler } from '@/middleware/error';
import { kefuapiRoutes } from '@/routes/kefuapi';
import { createToken, md5 } from '@/utils/jwt';
import { orderNotificationDelivery, storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderStatus,
  storeOrderWriteoff, storeProduct, storeProductAttrValue, storeService, storeServiceRecord, supplierFlowingWater, systemMessage,
  systemNotification, user, userBill, userBrokerage, type OrderWriteoffNoticeOutboxPayload } from '@/models/schema';
import { runWriteoffNoticeUpgrade, WRITEOFF_NOTICE_EVENT, writeoffNoticeCommissionedTx, writeoffNoticeEventGeneration } from '@/migrations/writeoffNotice';
import { PRODUCT_SAVE_EFFECTS_EVENTS } from '@/migrations/productSaveEffects';
import { CUSTOMER_WRITEOFF_VERSION, type WriteoffInput, type WriteoffSelection } from '@/services/customer-work/CustomerWorkWriteoffProtocol';
import { OrderOutboxService, isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { WRITEOFF_NOTICE_MARK } from '@/services/order/OrderWriteoffNoticeService';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';

type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
type Event = typeof storeOrderOutbox.$inferSelect;
const PHONE = '13800000011', USER_PHONE = '13800000022', OPERATOR_PHONE = '13800000101';
const TEMPLATE = 'owned_writeoff_sms_provider_template';
const base = '/mobile/work/cashier/second-card';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real writeoff batch SMS/inbox notifications on five independent PG16 LOGINs', { timeout: 30000 }, () => {
  let f: Fixture, network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const app = () => createContainerFromDb(f.appRuntime.db);
  const writer = () => new CustomerWorkWriteoffService(createContainerFromDb(f.cashierRuntime.db), f.env);
  const context = (key: string) => ({ actor: f.actor(), request_key: key });
  const outbox = () => new OrderOutboxService(app(), f.env);
  async function kefuRequest(path: string, body?: Record<string, unknown>, token?: string) {
    const h = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    h.use('*', async (c, next) => { c.set('container', app()); await next(); });
    h.onError(errorHandler); h.route('/kefuapi', kefuapiRoutes);
    // Token creation is local; the real middleware checks realm, password,
    // active account, bound user and owned registered conversation on App LOGIN.
    const bearer = token ?? (await createToken(41, 'kefu', md5('owned-writeoff-kefu-password'), f.env.APP_KEY)).token;
    const response = await h.request('/kefuapi' + path, { method: body === undefined ? 'GET' : 'PUT',
      headers: { Authorization: 'Bearer ' + bearer, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      { ...f.env, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' });
    return await response.json() as { status: number; msg: string; data: { completed: boolean } | null };
  }
  const delivery = () => new OrderNotificationDeliveryService(app(), { ...f.env,
    ALIYUN_SMS_ACCESS_KEY_ID: 'synthetic-owned-writeoff-key', ALIYUN_SMS_ACCESS_KEY_SECRET: 'synthetic-owned-writeoff-secret',
    ALIYUN_SMS_SIGN_NAME: '本地核销测试' } as Env);
  async function ok(path: string, body?: unknown, key?: string, uid = 101) {
    const result = await f.request(path, body, key, uid);
    expect(result.body.status, result.body.msg).toBe(200);
    expect(result.response.headers.get('Cache-Control') ?? '').not.toContain('public');
    return result.body.data;
  }
  async function cashCard(buyer = 11, quantity = 2, phone = PHONE) {
    const selected = await ok(base + '/catalog/70'), key = randomUUID();
    const intent = { version: 'customer-cashier-second-card-v1', scope_key: selected.scope_key,
      buyer_uid: buyer, tourist_key: buyer ? '' : 'owned-writeoff-guest', product_id: 70, sku_unique: 'qared001', quantity,
      real_name: buyer ? '真实核销购买人' : '真实核销游客', user_phone: phone, mark: '', custom_form: [], coupon_id: 0, use_integral: false };
    await ok(base + '/drafts', intent, key);
    const quote = await ok(base + '/quote', { request_key: key, intent });
    const created = await ok(base + '/orders', { intent, quote_token: quote.quote_token }, key);
    const id = created.receipt.order_id, current = await f.order(id);
    const payment = await ok(base + '/orders/' + id + '/cash', { version: 'customer-cashier-second-card-payment-v1',
      scope_key: selected.scope_key, order_id: id, order_no: current.orderId, expected_amount: current.payPrice }, randomUUID());
    expect(payment).toMatchObject({ evidence: { paid: 1, pay_type: 'cash', buyer_uid: buyer } });
    await consumePaid(id);
    expect(await f.order(id)).toMatchObject({ uid: buyer, paid: 1, payType: 'cash', productType: 4, userPhone: phone });
    return await f.order(id);
  }
  async function consumePaid(id: number) {
    const events = await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId, id), eq(storeOrderOutbox.eventType, 'order.paid')));
    expect(events).toHaveLength(1);
    const result = await outbox().processMessage({ action: 'processOrderPaidOutbox', outboxId: events[0].id, eventKey: events[0].eventKey });
    expect(['completed', 'already-completed']).toContain(result);
    return events[0];
  }
  async function ordinary(skus = ['qared001'], phone = PHONE, quantity = 1) {
    await f.maintenanceDb.update(storeProduct).set({ productType: 0, isVip: 0, freight: 2, storeName: '购买时快照商品名' }).where(eq(storeProduct.id, 70));
    await f.maintenanceDb.update(storeProductAttrValue).set({ price: '7.00', vipPrice: '7.00' }).where(eq(storeProductAttrValue.productId, 70));
    const ids: number[] = [];
    for (const uniqueId of skus) ids.push((await ok('/cart/add', { productId: 70, uniqueId, cartNum: quantity, isNew: 1 }, undefined, 11)).cartId);
    const selection = { cartIds: ids, shippingType: 2, storeId: 1, useIntegral: false, couponId: 0 };
    const quote = await ok('/order/confirm', selection, undefined, 11);
    const created = await ok('/order/create/' + quote.orderKey, { ...selection, quoteToken: quote.quoteToken,
      realName: '真实普通购买人', userPhone: phone, payType: 'yue', from: 'h5' }, undefined, 11);
    const current = await f.appRuntime.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    expect(current).toHaveLength(1); expect(current[0]).toMatchObject({ paid: 1, payType: 'yue', productType: 0, userPhone: phone });
    await consumePaid(current[0].id); return await f.order(current[0].id);
  }
  const carts = (id: number) => f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(asc(storeOrderCartInfo.id));
  const records = (id: number) => f.maintenanceDb.select().from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid, id)).orderBy(asc(storeOrderWriteoff.id));
  const events = (id: number) => f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId, id), eq(storeOrderOutbox.eventType, WRITEOFF_NOTICE_EVENT))).orderBy(asc(storeOrderOutbox.id));
  const stagedRows = (key: string) => f.maintenanceDb.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.eventKey, key));
  const inbox = (key: string) => f.maintenanceDb.select().from(systemMessage).where(eq(systemMessage.eventKey, key));
  const payload = (event: Event) => event.payload as OrderWriteoffNoticeOutboxPayload;
  async function input(id: number, selection?: WriteoffSelection[]): Promise<WriteoffInput> {
    const scope = await ok('/mobile/work/context'), order = await f.order(id);
    const read = await writer().reader.order(f.actor(), id, { scope_key: scope.scope_key, order_no: order.orderId }), target = read.data;
    expect(target.actions.writeoff.available, target.actions.writeoff.reason).toBe(true);
    return { version: CUSTOMER_WRITEOFF_VERSION, scope_key: scope.scope_key, order_id: id,
      expected_order_revision: target.order_revision, expected_writeoff_revision: target.writeoff_revision,
      payload: { order_no: target.order_no, root_order_id: target.root_order_id, root_order_no: target.root_order_no,
        code: target.code, target_fingerprint: target.target_fingerprint,
        items: selection ?? target.carts.filter((cart: { write_surplus_times: number }) => cart.write_surplus_times > 0)
          .map((cart: { cart_row_id: number; write_surplus_times: number }) => ({ cart_row_id: cart.cart_row_id, writeoff_num: cart.write_surplus_times })) } };
  }
  async function execute(body: WriteoffInput, key = randomUUID()) {
    const result = await writer().execute(context(key), body);
    expect(result.execution).toMatchObject({ state: 'SQL_COMMITTED', committed: true, verified: true });
    return { key, body, result };
  }
  async function stage(event: Event) {
    const before = f.messages.length;
    expect(await outbox().dispatchPending(1, event.id)).toMatchObject({ enqueued: 1 });
    const messages = f.messages.slice(before).filter(isOrderNotificationOutboxMessage).filter(message => message.outboxId === event.id);
    expect(messages).toHaveLength(1); expect(messages[0].eventKey).toBe(event.eventKey);
    expect(await outbox().processMessage(messages[0])).toBe('completed');
    const rows = await stagedRows(event.eventKey); expect(rows.every(row => row.channel === 'sms')).toBe(true);
    expect(await outbox().processMessage({ action: 'processOrderNotificationOutbox', outboxId: event.id, eventKey: event.eventKey })).toBe('already-completed');
    return rows;
  }
  async function queued(event: Event) {
    const before = f.messages.length;
    expect(await delivery().dispatchPending(20, event.eventKey)).toMatchObject({ enqueued: 1 });
    const messages = f.messages.slice(before).filter(isOrderNotificationDeliveryMessage).filter(message => message.eventKey === event.eventKey);
    expect(messages).toHaveLength(1); expect(messages[0].channel).toBe('sms'); return messages[0];
  }
  function provider(expected: { phone: string; name: string; time: string }, lost = false) {
    network.mockImplementation(async (url, options) => {
      expect(String(url)).toBe('https://dysmsapi.aliyuncs.com/'); expect(options?.method).toBe('POST');
      const body = new URLSearchParams(String(options?.body));
      expect(body.get('Action')).toBe('SendSms'); expect(body.get('PhoneNumbers')).toBe(expected.phone);
      expect(body.get('TemplateCode')).toBe(TEMPLATE);
      expect(JSON.parse(body.get('TemplateParam')!)).toEqual({ store_name: expected.name, write_time: expected.time });
      expect(body.get('Signature')).toBeTruthy();
      const [active] = await f.maintenanceDb.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE datname=current_database() AND state='idle in transaction' AND usename IN(${f.appRuntime.role},${f.cashierRuntime.role},${f.financialRuntime.role},${f.managerRuntime.role},${f.adminRuntime.role})`);
      expect(active.count).toBe(0);
      if (lost) throw Error('Owned SMS transport lost response after POST');
      return Response.json({ Code: 'OK', BizId: 'owned-writeoff-biz', RequestId: 'owned-writeoff-request' });
    });
  }
  async function send(event: Event, expectedName: string, expectedPhone = PHONE, lost = false) {
    const rows = await stage(event); expect(rows).toHaveLength(1);
    const value = payload(event), [clock] = await f.maintenanceDb.execute<{ minute: string }>(sql`SELECT to_char(to_timestamp(${value.occurredAt}) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI') AS minute`);
    expect(rows[0]).toMatchObject({ channel: 'sms', target: expectedPhone, templateCode: TEMPLATE,
      payload: { kind: 'sms', params: { store_name: expectedName, write_time: clock.minute } } });
    provider({ phone: expectedPhone, name: expectedName, time: clock.minute }, lost);
    const message = await queued(event), before = network.mock.calls.length;
    expect(await delivery().processMessage(message, network)).toBe(lost ? 'unknown' : 'sent');
    expect(network.mock.calls.length).toBe(before + 1);
    const saved = clone(await stagedRows(event.eventKey));
    expect(saved[0]).toMatchObject({ status: lost ? 'UNKNOWN' : 'SENT', attemptCount: 1 });
    expect(await delivery().processMessage(message, network)).toBe(lost ? 'unknown' : 'already-sent');
    expect(await stagedRows(event.eventKey)).toEqual(saved); expect(network.mock.calls.length).toBe(before + 1);
    return { rows: saved, minute: clock.minute };
  }
  async function business(id: number) {
    return { order: await f.order(id), carts: await carts(id), records: await records(id), outbox: await f.maintenanceDb.select().from(storeOrderOutbox).orderBy(asc(storeOrderOutbox.id)),
      statuses: await f.maintenanceDb.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id)).orderBy(asc(storeOrderStatus.id)),
      bills: await f.maintenanceDb.select().from(userBill).orderBy(asc(userBill.id)), brokerage: await f.maintenanceDb.select().from(userBrokerage).orderBy(asc(userBrokerage.id)),
      supplier: await f.maintenanceDb.select().from(supplierFlowingWater).orderBy(asc(supplierFlowingWater.id)),
      accounts: await f.maintenanceDb.select({ uid: user.uid, money: user.nowMoney, integral: user.integral, exp: user.exp, brokerage: user.brokeragePrice }).from(user).orderBy(asc(user.uid)) };
  }
  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unexpected external writeoff acceptance request'));
    f = await customerCashierRuntimeHttpFixture();
    expect(new Set(await Promise.all([f.appRuntime, f.adminRuntime, f.cashierRuntime, f.financialRuntime, f.managerRuntime].map(peer => peer.verify()))).size).toBe(5);
    expect(await customerWriteoffOperationReadiness(f.cashierRuntime.db)).toMatchObject({ ready: true });
    expect(await cashierSecondCardOriginReadiness(f.cashierRuntime.db)).toMatchObject({ ready: true });
    await runWriteoffNoticeUpgrade(f.maintenanceDb);
    expect(await writeoffNoticeCommissionedTx(f.cashierRuntime.db)).toBe(true);
  }, 300000);
  beforeEach(async () => {
    await f.reset();
    await f.maintenanceDb.delete(storeService).where(eq(storeService.id, 41));
    await f.maintenanceDb.insert(storeService).values({ id: 41, uid: 101, account: 'owned-writeoff-kefu', password: 'owned-writeoff-kefu-password' });
    await f.maintenanceDb.delete(storeServiceRecord).where(and(eq(storeServiceRecord.userId, 101), eq(storeServiceRecord.toUid, 11)));
    await f.maintenanceDb.insert(storeServiceRecord).values({ userId: 101, toUid: 11, isTourist: 0 });
    await f.maintenanceDb.delete(storeProductAttrValue).where(eq(storeProductAttrValue.id, 2));
    await f.maintenanceDb.delete(orderNotificationDelivery); await f.maintenanceDb.delete(systemMessage);
    await f.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark, WRITEOFF_NOTICE_MARK));
    await f.maintenanceDb.insert(systemNotification).values({ mark: WRITEOFF_NOTICE_MARK, isSms: 1, isSystem: 1, isWechat: 1, isRoutine: 1,
      smsId: TEMPLATE, systemTitle: '核销 {store_name}', systemText: '{store_name}|{write_time}' });
    await f.maintenanceDb.update(user).set({ phone: USER_PHONE }).where(eq(user.uid, 11));
    await f.maintenanceDb.update(user).set({ phone: OPERATOR_PHONE }).where(eq(user.uid, 101));
    network.mockReset().mockRejectedValue(Error('Unexpected external writeoff acceptance request'));
  }, 30000);
  afterEach(() => { vi.useRealTimers(); network.mockReset().mockRejectedValue(Error('Unexpected external writeoff acceptance request')); });
  afterAll(async () => { try { await f?.close(); } finally { network?.mockRestore(); } }, 30000);

  it('keeps consecutive real cash-card partial/final batches in one second distinct and recovers original UUIDs read-only', async () => {
    const order = await cashCard(), [cart] = await carts(order.id), originalPaid = await consumePaid(order.id), runs: Awaited<ReturnType<typeof execute>>[] = [];
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Math.floor(Date.now() / 1000) * 1000);
    try {
      for (const count of [1, 1, 4]) runs.push(await execute(await input(order.id, [{ cart_row_id: cart.id, writeoff_num: count }])));
    } finally { clock.mockRestore(); }
    expect(runs.map(run => run.result.receipt?.outcome)).toEqual(['partial-writtenoff', 'partial-writtenoff', 'written-off']);
    const notice = await events(order.id); expect(notice).toHaveLength(3);
    expect(new Set(notice.map(event => event.eventKey)).size).toBe(3);
    expect(new Set(notice.map(event => payload(event).occurredAt)).size).toBe(1);
    expect((await records(order.id)).map(row => row.writeoffNum)).toEqual([1, 1, 4]);
    expect(await f.order(order.id)).toMatchObject({ status: 2, verifyCode: '' });
    const before = await business(order.id);
    for (const run of runs) {
      expect((await writer().status(f.actor(), run.key)).receipt).toEqual(run.result.receipt);
      expect((await writer().execute(context(run.key), run.body)).replayed).toBe(true);
    }
    expect(await business(order.id)).toEqual(before);
    for (const event of notice) { await send(event, payload(event).storeName); expect(await inbox(event.eventKey)).toHaveLength(1); }
    expect((await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventType, 'order.paid'))).map(row => row.id)).toEqual([originalPaid.id]);
  }, 60000);
  it('uses actual ordinary balance checkout, live product name and captured order phone rather than buyer/operator phones', async () => {
    const order = await ordinary(), before = await carts(order.id);
    await f.maintenanceDb.update(storeProduct).set({ storeName: '实时核销商品名改名内容' }).where(eq(storeProduct.id, 70));
    const executed = await execute(await input(order.id)); expect(executed.result.receipt?.outcome).toBe('written-off');
    const [event] = await events(order.id); expect(payload(event)).toMatchObject({ userId: 11, phone: PHONE, storeName: '实时核销商品名改名内' });
    expect((await carts(order.id))[0].cartInfo).toBe(before[0].cartInfo); expect(before[0].cartInfo).toContain('购买时快照商品名');
    // Consumption happens after another live edit; the original batch stays fixed.
    await f.maintenanceDb.update(storeProduct).set({ storeName: '稍后又改名' }).where(eq(storeProduct.id, 70));
    await f.maintenanceDb.update(storeOrder).set({ userPhone: '13800000033' }).where(eq(storeOrder.id, order.id));
    const delivered = await send(event, '实时核销商品名改名内');
    expect(await inbox(event.eventKey)).toMatchObject([{ userId: 11, title: '核销 实时核销商品名改名内', content: '实时核销商品名改名内|' + delivered.minute }]);
  });
  it('persists a genuine multi-SKU batch with repeated product title truncated to ten Unicode characters per line', async () => {
    const [sku] = await f.maintenanceDb.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    await f.maintenanceDb.insert(storeProductAttrValue).values({ ...sku, id: 2, unique: 'qablue02', suk: '蓝色,大号' });
    const order = await ordinary(['qared001', 'qablue02']);
    await f.maintenanceDb.update(storeProduct).set({ storeName: '😀甲乙丙丁戊己庚辛壬癸尾' }).where(eq(storeProduct.id, 70));
    const executed = await execute(await input(order.id)); expect(executed.result.receipt?.outcome).toBe('written-off');
    const actual = await records(order.id), [event] = await events(order.id);
    expect(actual).toHaveLength(2); expect(new Set(actual.map(row => row.productId)).size).toBe(1);
    expect(new Set(actual.map(row => row.orderCartId)).size).toBe(2);
    expect(payload(event).recordIds).toEqual(actual.map(row => row.id));
    expect(event.eventKey).toBe('order.writeoff.notice:' + actual[0].id);
    await send(event, '😀甲乙丙丁戊己庚辛壬 😀甲乙丙丁戊己庚辛壬');
  });
  it('retains literal dollar replacement characters in both actual SMS and inbox rendering', async () => {
    const order = await cashCard(), name = 'A$&B$$C';
    await f.maintenanceDb.update(storeProduct).set({ storeName: name }).where(eq(storeProduct.id, 70));
    await execute(await input(order.id));
    const [event] = await events(order.id), delivered = await send(event, name);
    expect(await inbox(event.eventKey)).toMatchObject([{ title: '核销 ' + name, content: name + '|' + delivered.minute }]);
  });
  it('keeps valid SMS when a genuine multi-SKU batch exceeds the inbox title capacity without truncation', async () => {
    const [sku] = await f.maintenanceDb.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    await f.maintenanceDb.insert(storeProductAttrValue).values({ ...sku, id: 2, unique: 'qablue02', suk: '蓝色,大号' });
    const order = await ordinary(['qared001', 'qablue02']);
    await f.maintenanceDb.update(storeProduct).set({ storeName: '甲乙丙丁戊己庚辛壬癸' }).where(eq(storeProduct.id, 70));
    await f.maintenanceDb.update(systemNotification).set({ systemTitle: '前'.repeat(240) + '{store_name}' }).where(eq(systemNotification.mark, WRITEOFF_NOTICE_MARK));
    await execute(await input(order.id)); const [event] = await events(order.id);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await send(event, '甲乙丙丁戊己庚辛壬癸 甲乙丙丁戊己庚辛壬癸');
      expect(await inbox(event.eventKey)).toEqual([]);
      expect((await events(order.id))[0].status).toBe('COMPLETED');
      expect(warning.mock.calls.filter(([entry]) => entry?.event === 'writeoff_inbox_gap')).toEqual([[{
        schema: 'cinashop_operational_v1', event: 'writeoff_inbox_gap', component: 'queue', operation: 'notification_delivery',
        outcome: 'failure', errorCode: 'inbox_title_too_long', eventKey: event.eventKey, resourceCount: 1,
      }]]);
    } finally { warning.mockRestore(); }
  });
  it('keeps the authenticated Admin all-items request notification even with an empty title', async () => {
    const order = await ordinary(), token = await f.bearer(1, 'admin', 'offline-native-admin-password');
    const response = await f.raw('/admin/order/writeoff', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: order.verifyCode }) });
    const body = await response.json() as { status: number; msg: string; data: { completed: boolean } };
    expect(body.status, body.msg).toBe(200); expect(body.data.completed).toBe(true);
    const [event] = await events(order.id); expect(payload(event)).toMatchObject({ selection: 'all', storeName: '' });
    await send(event, ''); expect(await inbox(event.eventKey)).toMatchObject([{ userId: 11, title: '核销 ' }]);
  });
  it('keeps legacy Kefu verific without notifications or a new catalog dependency after real balance payment', async () => {
    const order = await ordinary();
    const [catalog] = await f.maintenanceDb.execute<{ definition: string; comment: string | null }>(sql`SELECT pg_get_constraintdef(oid,false) AS definition,obj_description(oid,'pg_constraint') AS comment FROM pg_constraint
      WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'`);
    const generation = writeoffNoticeEventGeneration(catalog.definition);
    if (!generation) throw Error('Owned writeoff acceptance requires the exact commissioned generation');
    const deliveries = await f.maintenanceDb.select().from(orderNotificationDelivery), messages = await f.maintenanceDb.select().from(systemMessage);
    await f.exec("ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck; ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type<>'')");
    try {
      await expect(writeoffNoticeCommissionedTx(f.appRuntime.db)).rejects.toThrow();
      const result = await kefuRequest('/order/verific/' + order.id);
      expect(result.status, result.msg).toBe(200); expect(result.data?.completed).toBe(true);
      expect(await f.order(order.id)).toMatchObject({ status: 2, verifyCode: '' });
      expect(await records(order.id)).toHaveLength(1); expect(await events(order.id)).toEqual([]);
      const written = await business(order.id), replay = await kefuRequest('/order/verific/' + order.id);
      expect(replay.status).not.toBe(200); expect(await business(order.id)).toEqual(written);
      expect(await f.maintenanceDb.select().from(orderNotificationDelivery)).toEqual(deliveries);
      expect(await f.maintenanceDb.select().from(systemMessage)).toEqual(messages); expect(network).not.toHaveBeenCalled();
    } finally {
      // Replaying pg_get_constraintdef text inserts extra casts into this
      // expression. Recreate from the exact known event list, as the installer
      // does, and assert the original canonical definition is recovered.
      await f.exec(`ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck; ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type IN(${generation.events.map(event => "'" + event.replaceAll("'", "''") + "'").join(',')}))`);
      if (catalog.comment !== null) await f.exec("COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS '" + catalog.comment.replaceAll("'", "''") + "'");
      const [restored] = await f.maintenanceDb.execute<{ definition: string }>(sql`SELECT pg_get_constraintdef(oid,false) AS definition FROM pg_constraint
        WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'`);
      expect(restored.definition).toBe(catalog.definition); expect(await writeoffNoticeCommissionedTx(f.appRuntime.db)).toBe(true);
    }
  });
  it('keeps modern Kefu implicit-all notifications and ignores a forged legacy marker in the HTTP body', async () => {
    const order = await ordinary(), path = '/order/write_update/' + encodeURIComponent(order.orderId);
    expect((await kefuRequest(path, {}, await f.bearer(101))).status).not.toBe(200);
    expect(await records(order.id)).toEqual([]);
    const result = await kefuRequest(path, { phpWriteoffSource: 'legacy-verific' });
    expect(result.status, result.msg).toBe(200); expect(result.data?.completed).toBe(true);
    const notice = await events(order.id); expect(notice).toHaveLength(1);
    expect(payload(notice[0])).toMatchObject({ selection: 'all', storeName: '' });
    await send(notice[0], ''); expect(await inbox(notice[0].eventKey)).toHaveLength(1);
  });
  it('notifies both actual modern Kefu partial and final explicit batches of a real paid store pickup', async () => {
    const order = await ordinary(['qared001'], PHONE, 2), [cart] = await carts(order.id), path = '/order/write_update/' + encodeURIComponent(order.orderId);
    expect(cart.writeSurplusTimes).toBeGreaterThan(1);
    const finalQuantity = cart.writeSurplusTimes - 1;
    for (const [quantity, completed] of [[1, false], [finalQuantity, true]] as const) {
      const result = await kefuRequest(path, { cart_ids: [{ cart_id: cart.cartId, cart_num: quantity }] });
      expect(result.status, result.msg).toBe(200); expect(result.data?.completed).toBe(completed);
    }
    expect((await records(order.id)).map(row => row.writeoffNum)).toEqual([1, finalQuantity]);
    const notice = await events(order.id); expect(notice).toHaveLength(2);
    for (const event of notice) {
      expect(payload(event).selection).toBe('explicit'); await send(event, payload(event).storeName);
      expect(await inbox(event.eventKey)).toHaveLength(1);
    }
  });
  it('creates a real guest cashier payment and sends only SMS without an invented account inbox', async () => {
    const order = await cashCard(0, 1); await execute(await input(order.id));
    const [event] = await events(order.id); expect(payload(event)).toMatchObject({ userId: 0, phone: PHONE });
    await send(event, payload(event).storeName); expect(await inbox(event.eventKey)).toEqual([]);
    expect(await f.maintenanceDb.select().from(user).where(eq(user.uid, 0))).toEqual([]);
  });
  it('obeys SMS/inbox switches independently and has no WeChat channels when both are disabled', async () => {
    const order = await cashCard();
    await f.maintenanceDb.update(systemNotification).set({ isSms: 0, isSystem: 0 }).where(eq(systemNotification.mark, WRITEOFF_NOTICE_MARK));
    await execute(await input(order.id, [{ cart_row_id: (await carts(order.id))[0].id, writeoff_num: 1 }]));
    const [first] = await events(order.id); expect(await stage(first)).toEqual([]); expect(await inbox(first.eventKey)).toEqual([]);
    await f.maintenanceDb.update(systemNotification).set({ isSystem: 1 }).where(eq(systemNotification.mark, WRITEOFF_NOTICE_MARK));
    await execute(await input(order.id, [{ cart_row_id: (await carts(order.id))[0].id, writeoff_num: 1 }])); const second = (await events(order.id))[1];
    expect(await stage(second)).toEqual([]); expect(await inbox(second.eventKey)).toHaveLength(1); expect(network).not.toHaveBeenCalled();
    await f.maintenanceDb.update(systemNotification).set({ isSystem: 0, isSms: 1 }).where(eq(systemNotification.mark, WRITEOFF_NOTICE_MARK));
    await execute(await input(order.id)); const third = (await events(order.id))[2];
    await send(third, payload(third).storeName); expect(await inbox(third.eventKey)).toEqual([]);
  });
  it('keeps inbox delivery for an actual paid order whose mutable contact phone is absent', async () => {
    const order = await ordinary();
    // Contact maintenance before real writeoff is not an authored paid/writeoff fact.
    await f.maintenanceDb.update(storeOrder).set({ userPhone: '' }).where(eq(storeOrder.id, order.id));
    await execute(await input(order.id)); const [event] = await events(order.id);
    expect(payload(event).phone).toBe(''); expect(await stage(event)).toEqual([]); expect(await inbox(event.eventKey)).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
  });
  it('rejects a stale rotated code under a new UUID without another record/event and leaves original recovery stable', async () => {
    const order = await cashCard(), [cart] = await carts(order.id), first = await execute(await input(order.id, [{ cart_row_id: cart.id, writeoff_num: 1 }]));
    const before = await business(order.id), key = randomUUID(), rejected = await writer().execute(context(key), first.body);
    expect(rejected.receipt?.outcome).toBe('rollback-rejected');
    expect(await business(order.id)).toEqual(before);
    expect((await writer().status(f.actor(), first.key)).receipt).toEqual(first.result.receipt);
    expect((await writer().execute(context(first.key), first.body)).replayed).toBe(true);
    expect(await events(order.id)).toHaveLength(1); expect(network).not.toHaveBeenCalled();
  });
  it('rolls back actual final writeoff/settlement on outbox INSERT failure and stabilizes the original UUID by explicit abandonment', async () => {
    const order = await ordinary(), body = await input(order.id), key = randomUUID(), before = await business(order.id);
    const [sequence] = await f.maintenanceDb.execute<{ value: string; called: boolean }>(sql`SELECT last_value::text AS value,is_called AS called FROM public.store_order_outbox_id_seq`);
    expect(sequence.called).toBe(true);
    await f.exec(`CREATE FUNCTION public.owned_writeoff_notice_fault() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF NEW.event_type='order.writeoff.notice' THEN PERFORM nextval(pg_get_serial_sequence('public.store_order_outbox','id'));RAISE EXCEPTION 'Owned real writeoff outbox insert fault';END IF;RETURN NEW;END $body$;
      CREATE TRIGGER owned_writeoff_notice_fault BEFORE INSERT ON public.store_order_outbox FOR EACH ROW EXECUTE FUNCTION public.owned_writeoff_notice_fault()`);
    try { await expect(writer().execute(context(key), body)).rejects.toThrow(); }
    finally { await f.exec('DROP TRIGGER owned_writeoff_notice_fault ON public.store_order_outbox;DROP FUNCTION public.owned_writeoff_notice_fault()'); }
    const [after] = await f.maintenanceDb.execute<{ value: string }>(sql`SELECT last_value::text AS value FROM public.store_order_outbox_id_seq`);
    expect(BigInt(after.value)).toBe(BigInt(sequence.value) + 2n);
    expect(await business(order.id)).toEqual(before); expect(await events(order.id)).toEqual([]);
    // Arbitrary SQL errors are UNKNOWN to the existing request protocol; they
    // do not automatically author a rollback-rejected receipt. The original
    // owner explicitly abandons that still-absent UUID before starting anew.
    expect((await writer().status(f.actor(), key)).receipt).toBeNull();
    const abandoned = await writer().abandon(f.actor(), key, { kind: 'writeoff', input: body }, key);
    expect(abandoned.receipt?.outcome).toBe('abandoned');
    const retry = await writer().execute(context(key), body); expect(retry.receipt).toEqual(abandoned.receipt); expect(retry.execution).toBeNull();
    expect(await business(order.id)).toEqual(before);
    await execute(await input(order.id)); const [event] = await events(order.id); await send(event, payload(event).storeName);
  });
  it('rolls back a real BEFORE INSERT payload corruption instead of accepting the proposed author payload', async () => {
    const order = await ordinary(), body = await input(order.id), key = randomUUID(), before = await business(order.id);
    await f.exec(`CREATE FUNCTION public.owned_writeoff_payload_fault() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF NEW.event_type='order.writeoff.notice' THEN NEW.payload:=jsonb_set(NEW.payload,'{phone}','"13800000999"'::jsonb);END IF;RETURN NEW;END $body$;
      CREATE TRIGGER owned_writeoff_payload_fault BEFORE INSERT ON public.store_order_outbox FOR EACH ROW EXECUTE FUNCTION public.owned_writeoff_payload_fault()`);
    try { await expect(writer().execute(context(key), body)).rejects.toThrow('核销通知批次不可变字段冲突'); }
    finally { await f.exec('DROP TRIGGER owned_writeoff_payload_fault ON public.store_order_outbox;DROP FUNCTION public.owned_writeoff_payload_fault()'); }
    expect(await business(order.id)).toEqual(before); expect(await events(order.id)).toEqual([]);
    expect((await writer().status(f.actor(), key)).receipt).toBeNull();
    const abandoned = await writer().abandon(f.actor(), key, { kind: 'writeoff', input: body }, key);
    expect(abandoned.receipt?.outcome).toBe('abandoned'); expect(network).not.toHaveBeenCalled();
  });
  it('retains one actual SMS UNKNOWN attempt and never resends the ambiguous provider POST', async () => {
    const order = await cashCard(); await execute(await input(order.id)); const [event] = await events(order.id);
    await send(event, payload(event).storeName, PHONE, true); expect(await inbox(event.eventKey)).toHaveLength(1);
  });
  it('refuses a tampered real writeoff record before staging any channel or inbox', async () => {
    const order = await cashCard(); await execute(await input(order.id)); const [event] = await events(order.id), [record] = await records(order.id);
    await f.maintenanceDb.update(storeOrderWriteoff).set({ writeoffNum: record.writeoffNum + 1 }).where(eq(storeOrderWriteoff.id, record.id));
    try {
      await expect(outbox().processMessage({ action: 'processOrderNotificationOutbox', outboxId: event.id, eventKey: event.eventKey })).rejects.toThrow();
      expect(await stagedRows(event.eventKey)).toEqual([]); expect(await inbox(event.eventKey)).toEqual([]); expect(network).not.toHaveBeenCalled();
    } finally { await f.maintenanceDb.update(storeOrderWriteoff).set({ writeoffNum: record.writeoffNum }).where(eq(storeOrderWriteoff.id, record.id)); }
  });
  it('keeps genuine legacy writeoff working before explicit commissioning and authors only later new batches', async () => {
    await f.exec(`ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck;
      ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type IN(${PRODUCT_SAVE_EFFECTS_EVENTS.map(event => `'${event}'`).join(',')}))`);
    try {
      expect(await writeoffNoticeCommissionedTx(f.appRuntime.db)).toBe(false);
      const order = await cashCard(), [cart] = await carts(order.id);
      await execute(await input(order.id, [{ cart_row_id: cart.id, writeoff_num: 1 }]));
      expect(await events(order.id)).toEqual([]); expect(await records(order.id)).toHaveLength(1);
      await runWriteoffNoticeUpgrade(f.maintenanceDb); await execute(await input(order.id));
      const [event] = await events(order.id); expect(payload(event).recordIds).toEqual([(await records(order.id))[1].id]);
      await send(event, payload(event).storeName);
    } finally { await runWriteoffNoticeUpgrade(f.maintenanceDb); }
  });
});
