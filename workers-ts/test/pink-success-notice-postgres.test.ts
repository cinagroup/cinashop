import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, withTx } from '@/lib/di';
import type { Env, OrderMessage } from '@/env';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderOutbox, storePink, user,
  systemConfig, systemNotification, systemMessage, wechatUser, notificationTemplate, orderNotificationDelivery } from '@/models/schema';
import { enqueuePinkSuccessNotices } from '@/services/activity/PinkSuccessNotice';
import { enqueueOrderPinkSuccessNoticeEvent, assertOrderNotificationPayload, ORDER_PINK_SUCCESS_NOTICE_EVENT } from '@/services/order/OrderNotificationOutboxService';
import { OrderOutboxService, isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { OrderNotificationAdminService } from '@/services/order/OrderNotificationAdminService';
import { prepareOrderQueueDeadLetter } from '@/services/order/OrderQueueDeadLetterService';
import { financePostgres } from './helpers/financePostgres';

// Real PG16 outbox, queue claims, channel staging and provider result ledger.
// Only the Queue transport and explicit SMS HTTP response are substituted.
// No real provider credentials, deployment or network request is used.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('durable real-member pink success notices on PG16', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  const queue = { sendBatch: vi.fn(async () => undefined), send: vi.fn(async () => undefined) };
  const env = { ORDER_QUEUE: queue as unknown as Queue<OrderMessage>,
    ALIYUN_SMS_ACCESS_KEY_ID: 'local-fake-id', ALIYUN_SMS_ACCESS_KEY_SECRET: 'local-fake-secret',
    ALIYUN_SMS_SIGN_NAME: 'local-fake-sign' } as unknown as Env;
  const container = () => createContainerFromDb(f.db);
  const outbox = () => new OrderOutboxService(container(), env);
  const events = () => f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id);
  const effects = async () => ({ events: await events(), messages: await f.db.select().from(systemMessage).orderBy(systemMessage.id),
    deliveries: await f.db.select().from(orderNotificationDelivery).orderBy(orderNotificationDelivery.id) });
  const source = async () => ({ users: await f.db.select().from(user).orderBy(user.uid),
    orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id), pinks: await f.db.select().from(storePink).orderBy(storePink.id),
    details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id), refunds: await f.db.select().from(storeOrderRefund) });
  const enqueue = () => withTx(container(), tx => enqueuePinkSuccessNotices(tx, 400, 1_700_000_020));
  const message = (event: Awaited<ReturnType<typeof events>>[number]) => ({
    action: 'processOrderNotificationOutbox' as const, outboxId: event.id, eventKey: event.eventKey,
  });
  beforeAll(async () => {
    f = await financePostgres([storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderOutbox, storePink, user,
      systemConfig, systemNotification, systemMessage, wechatUser, notificationTemplate, orderNotificationDelivery]);
    const dialect = new PgDialect();
    for (const table of [storeOrderOutbox, orderNotificationDelivery]) for (const check of getTableConfig(table).checks)
      await f.exec(`ALTER TABLE ${getTableConfig(table).name} ADD CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`);
    await f.exec('CREATE UNIQUE INDEX soob_event_key_uq ON store_order_outbox(event_key)');
    await f.exec('CREATE UNIQUE INDEX smsg_event_key_uq ON system_message(event_key)');
    await f.exec('CREATE UNIQUE INDEX ond_event_channel_uq ON order_notification_delivery(event_key,channel)');
  });
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External network forbidden'));
    queue.sendBatch.mockClear(); queue.send.mockClear(); await f.reset();
    await f.db.insert(user).values([{ uid: 11, nickname: '真实团长', phone: '10000000001' }, { uid: 22, nickname: '真实团员', phone: '10000000002' }]);
    await f.db.insert(storeOrder).values([1, 2].map(id => ({ id, orderId: `PINK-${id}`, unique: `pink-key-${id}`,
      uid: id * 11, type: 3, activityId: 30, pinkId: 400, paid: 1, payTime: 1_700_000_000 + id,
      userPhone: '00000000000', payType: 'yue', totalNum: 1, payPrice: '6.25' })));
    await f.db.insert(storeOrderCartInfo).values([1, 2].map(id => ({ id, oid: id, uid: id * 11, productId: 70,
      cartId: String(id), cartNum: 1, cartInfo: JSON.stringify(id === 1
        ? { productInfo: { store_name: '通知拼团商品' }, cart_num: 1 } : { product: { storeName: '通知拼团商品' }, cart_num: 1 }) })));
    await f.db.insert(storePink).values([1, 2].map(id => ({ id: 399 + id, uid: id * 11, kId: id === 1 ? 0 : 400,
      combinationId: 30, productId: 70, people: 3, memberCount: id === 1 ? 3 : 0, status: 2, nickname: id === 1 ? '真实团长' : '真实团员',
      orderId: `PINK-${id}`, orderIdKey: String(id), addTime: 1_700_000_000 + id })));
    await f.db.insert(storePink).values({ id: 402, uid: 0, kId: 400, combinationId: 30, productId: 70,
      people: 3, status: 2, isVirtual: 1, isTpl: 1, orderId: '0', orderIdKey: '0' });
    await f.db.insert(systemNotification).values({ mark: 'order_user_groups_success', isSystem: 1, isSms: 1,
      isWechat: 1, isRoutine: 1, smsId: 'SMS_LOCAL', systemTitle: '{title}成团',
      systemText: '{nickname}|{count}|{pink_time}|{order_id}' });
    await f.db.insert(notificationTemplate).values({ mark: '3098', legacyType: 0, tempid: 'routine-local', status: 1 });
    await f.db.insert(wechatUser).values([1, 2].map(id => ({ uid: id * 11, userType: 'routine', openid: `routine-local-${id}` })));
  });
  afterEach(() => { try { expect(globalThis.fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });

  it('persists one immutable five-scalar event per real paid member and no virtual UID or financial write', async () => {
    const before = await source(); await enqueue(); const first = await effects();
    expect(first.events).toHaveLength(2); expect(first.messages).toEqual([]); expect(first.deliveries).toEqual([]);
    expect(first.events.map(event => event.payload)).toEqual([1, 2].map(id => ({ orderId: id, orderNo: `PINK-${id}`, userId: id * 11, pinkId: 400, people: 3 })));
    expect(first.events.every(event => event.eventType === ORDER_PINK_SUCCESS_NOTICE_EVENT && event.status === 'PENDING')).toBe(true);
    await enqueue(); expect(await effects()).toEqual(first); expect(await source()).toEqual(before);
    expect(queue.sendBatch).not.toHaveBeenCalled();
  });
  it('dispatches reference-only Queue messages, stages the exact legacy channels and completes each event once', async () => {
    await enqueue(); const rows = await events();
    expect(await outbox().dispatchPending()).toEqual({ claimed: 2, enqueued: 2 });
    expect(queue.sendBatch).toHaveBeenCalledWith(rows.map(event => ({ body: message(event), contentType: 'json' })));
    for (const event of rows) expect(await outbox().processMessage(message(event))).toBe('completed');
    const before = await effects();
    expect(before.messages.map(row => [row.userId, row.mark, row.type, row.title])).toEqual([
      [11, 'order_user_groups_success', 1, '通知拼团商品成团'], [22, 'order_user_groups_success', 1, '通知拼团商品成团'],
    ]);
    expect(before.messages[0].content).toBe('真实团长|3|2023-11-15 06:13:21|PINK-1');
    expect(before.messages[1].content).toBe('真实团长|3|2023-11-15 06:13:22|PINK-2');
    expect(before.deliveries.map(row => row.channel)).toEqual(['sms', 'wechat_routine', 'sms', 'wechat_routine']);
    expect(before.deliveries[0]).toMatchObject({ target: '10000000001', templateCode: 'SMS_LOCAL',
      payload: { kind: 'sms', params: { title: '通知拼团商品', nickname: '真实团长' } } });
    expect(before.deliveries[1]).toMatchObject({ target: 'routine-local-1', templateCode: 'routine-local', payload: {
      kind: 'wechat_routine', data: { thing1: '通知拼团商品', name3: '真实团长', date5: '2023-11-15 06:13:21', number2: '3' },
      url: '/pages/goods/order_details/index?order_id=PINK-1',
    } });
    for (const event of rows) expect(await outbox().processMessage(message(event))).toBe('already-completed');
    expect(await effects()).toEqual(before);
  });
  it('accepts only its event identity for outbox, delivery and manual replay reference contracts', async () => {
    await enqueue(); const event = (await events())[0], msg = message(event);
    expect(isOrderNotificationOutboxMessage(msg)).toBe(true);
    expect(prepareOrderQueueDeadLetter(msg)).toMatchObject({ replayPolicy: 'ALLOW', replayMessage: msg });
    expect(isOrderNotificationDeliveryMessage({ action: 'processOrderNotificationDelivery', deliveryId: 1, eventKey: event.eventKey, channel: 'sms' })).toBe(true);
    for (const key of ['order.pink.success.notice:0', 'order.pink.success.notice:1:2', 'order.pink.success.notice:01', 'other:1'])
      expect(isOrderNotificationOutboxMessage({ ...msg, eventKey: key })).toBe(false);
    for (const payload of [{ ...event.payload, userId: 0 }, { ...event.payload, people: 1 }, { ...event.payload, people: 501 },
      { ...event.payload, pinkId: 0 }, { ...event.payload, orderId: 2_147_483_648 }])
      expect(() => assertOrderNotificationPayload(payload, ORDER_PINK_SUCCESS_NOTICE_EVENT, 1)).toThrow();
  });
  it('rolls back the whole enqueue when an existing per-order key has a different immutable group', async () => {
    await withTx(container(), tx => enqueueOrderPinkSuccessNoticeEvent(tx, { orderId: 2, orderNo: 'PINK-2', userId: 22, pinkId: 999, people: 3 }, 1));
    const before = await effects(); await expect(enqueue()).rejects.toThrow('不可变'); expect(await effects()).toEqual(before);
  });
  it('configures the restored event through the existing Admin contract and resolves the PHP routine key 3098', async () => {
    await f.db.delete(notificationTemplate); await f.db.delete(systemNotification);
    const admin = new OrderNotificationAdminService(container(), env);
    const config = (await admin.listOrderConfigs()).find(row => row.mark === 'order_user_groups_success')!;
    expect(config).toMatchObject({ exists: false, officialAllowed: false, routineAllowed: true, enabledTemplateCount: 0 });
    await expect(admin.saveOrderConfig('order_user_groups_success', { isWechat: true })).rejects.toThrow('不支持公众号');
    await admin.saveOrderConfig('order_user_groups_success', { isSystem: true, isSms: true, isRoutine: true,
      smsId: 'SMS_LOCAL', systemTitle: '{title}成团', systemText: '{nickname}|{count}|{pink_time}' });
    const template = await admin.saveTemplate({ mark: 'order_user_groups_success', type: 'routine', title: '本地成团模板', tempid: 'routine-local' });
    expect(template).toMatchObject({ mark: '3098', legacyType: 0 });
    expect((await admin.listOrderConfigs()).find(row => row.mark === 'order_user_groups_success')).toMatchObject({ exists: true, enabledTemplateCount: 1 });
    await enqueue(); await outbox().processMessage(message((await events())[0]));
    expect((await effects()).deliveries.find(row => row.channel === 'wechat_routine')).toMatchObject({ templateCode: 'routine-local', status: 'PENDING' });
  });
  it('keeps the full SMS nickname, while truncating routine nickname, removing digits and bounding the title by Unicode characters', async () => {
    await f.db.update(storePink).set({ nickname: '团长123456789姓名' }).where(eq(storePink.id, 400));
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ product: { storeName: '拼'.repeat(21) } }) }).where(eq(storeOrderCartInfo.oid, 1));
    await enqueue(); await outbox().processMessage(message((await events())[0]));
    const state = await effects();
    expect(state.messages[0].title).toBe('拼'.repeat(20) + '成团');
    expect(state.deliveries[0].payload).toEqual({ kind: 'sms', params: { title: '拼'.repeat(20), nickname: '团长123456789姓名' } });
    expect(state.deliveries[1].payload).toMatchObject({ data: { thing1: '拼'.repeat(20), name3: '团长...' } });
  });
  it.each([{ uid: 0 }, { isVirtual: 1 }])('refuses a synthetic leader at enqueue and suppresses a previously queued event on consumption (%s)', async patch => {
    await enqueue(); const memberEvent = (await events())[1]; await f.db.delete(storeOrderOutbox);
    await f.db.update(storePink).set(patch).where(eq(storePink.id, 400));
    await expect(enqueue()).rejects.toThrow('有效终态'); expect(await events()).toEqual([]);
    const restored = await withTx(container(), tx => enqueueOrderPinkSuccessNoticeEvent(tx, memberEvent.payload as Parameters<typeof enqueueOrderPinkSuccessNoticeEvent>[1], 1));
    expect(await outbox().processMessage({ action: 'processOrderNotificationOutbox', ...restored, outboxId: restored.id })).toBe('completed');
    expect((await effects()).messages).toEqual([]); expect((await effects()).deliveries).toEqual([]);
  });
  it.each(['unpaid', 'virtual', 'refunded', 'pending', 'conflicting-key', 'wrong-activity'] as const)(
    'does not enqueue or consume a member with %s evidence', async fault => {
      await enqueue(); const original = (await events()).find(event => event.aggregateId === 2)!;
      await f.db.delete(storeOrderOutbox);
      if (fault === 'unpaid') await f.db.update(storeOrder).set({ paid: 0 }).where(eq(storeOrder.id, 2));
      if (fault === 'virtual') await f.db.update(storePink).set({ isVirtual: 1 }).where(eq(storePink.id, 401));
      if (fault === 'refunded') await f.db.update(storePink).set({ isRefund: 1 }).where(eq(storePink.id, 401));
      if (fault === 'pending') await f.db.insert(storeOrderRefund).values({ storeOrderId: 2, uid: 22, orderId: 'local-refund', refundType: 1 });
      if (fault === 'conflicting-key') await f.db.update(storePink).set({ orderIdKey: 'contradictory' }).where(eq(storePink.id, 401));
      if (fault === 'wrong-activity') await f.db.update(storeOrder).set({ activityId: 999 }).where(eq(storeOrder.id, 2));
      await enqueue(); expect((await events()).map(event => event.aggregateId)).toEqual([1]);
      const restored = await withTx(container(), tx => enqueueOrderPinkSuccessNoticeEvent(tx, original.payload as Parameters<typeof enqueueOrderPinkSuccessNoticeEvent>[1], 1));
      expect(await outbox().processMessage({ action: 'processOrderNotificationOutbox', outboxId: restored.id, eventKey: restored.eventKey })).toBe('completed');
      expect((await effects()).messages).toEqual([]); expect((await effects()).deliveries).toEqual([]);
    },
  );
  it('retains a real paid member with a completed partial refund and no pending refund request', async () => {
    await f.db.update(storeOrder).set({ refundStatus: 3 }).where(eq(storeOrder.id, 2));
    await f.db.insert(storeOrderRefund).values({ storeOrderId: 2, uid: 22, refundType: 6 });
    await enqueue(); expect(await events()).toHaveLength(2);
    const event = (await events())[1]; expect(await outbox().processMessage(message(event))).toBe('completed');
    expect((await effects()).messages[0].userId).toBe(22);
  });
  it('persists explicit missing-target/template channel skips while keeping the enabled system notice', async () => {
    await f.db.update(user).set({ phone: '' }); await f.db.delete(wechatUser); await f.db.delete(notificationTemplate);
    await enqueue(); for (const event of await events()) await outbox().processMessage(message(event));
    const rows = await effects(); expect(rows.messages).toHaveLength(2);
    expect(rows.deliveries).toHaveLength(4); expect(rows.deliveries.every(row => row.status === 'SKIPPED')).toBe(true);
  });
  it.each([false, true])('uses actual channel lease/result SQL for substituted SMS response (ambiguous=%s)', async ambiguous => {
    await enqueue(); const event = (await events())[0]; await outbox().processMessage(message(event));
    const row = (await effects()).deliveries.find(delivery => delivery.channel === 'sms')!;
    const deliveryMessage = { action: 'processOrderNotificationDelivery' as const, deliveryId: row.id, eventKey: row.eventKey, channel: row.channel };
    const fetcher = vi.fn(async () => { if (ambiguous) throw Error('Local substituted transport disconnect'); return Response.json({ Code: 'OK', BizId: 'local-biz', RequestId: 'local-request' }); });
    const service = new OrderNotificationDeliveryService(container(), env);
    expect(await service.dispatchPending(20, row.eventKey)).toEqual({ claimed: 2, enqueued: 2, unknown: 0 });
    expect(await service.processMessage(deliveryMessage, fetcher as typeof fetch)).toBe(ambiguous ? 'unknown' : 'sent');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await service.processMessage(deliveryMessage, fetcher as typeof fetch)).toBe(ambiguous ? 'unknown' : 'already-sent');
    expect(fetcher).toHaveBeenCalledOnce();
    const [stored] = await f.db.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, row.id));
    expect(stored).toMatchObject({ status: ambiguous ? 'UNKNOWN' : 'SENT', attemptCount: 1 });
  });
});
