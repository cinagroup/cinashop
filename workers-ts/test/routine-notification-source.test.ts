import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, OrderNotificationDeliveryMessage } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { orderNotificationDelivery, storeOrderOutbox, systemConfig, type WechatTemplateNotificationPayload } from '@/models/schema';
import { createImmutableDelivery, enqueueOrderDeliveryNoticeEvent, type OrderNotificationOutboxEvent } from '@/services/order/OrderNotificationOutboxService';
import { OrderNotificationDeliveryService } from '@/services/order/OrderNotificationDeliveryService';
import { readRoutineCredentials, routineCredentialCacheKey } from '@/services/wechat/RoutineRuntimeConfig';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';

const cache = vi.hoisted(() => {
  const state = { values: new Map<string, unknown>(), reads: [] as string[], writes: [] as string[], deletes: [] as string[],
    depth: 0, enabled: true, getHook: undefined as undefined | (() => Promise<void>) };
  const outside = () => { if (state.depth) throw Error('Notification external I/O inside SQL transaction'); };
  const redis = {
    get: async (key: string) => { outside(); state.reads.push(key); const value = state.values.get(key) ?? null; await state.getHook?.(); return value; },
    set: async (key: string, value: unknown) => { outside(); state.writes.push(key); state.values.set(key, value); return 'OK'; },
    del: async (key: string) => { outside(); state.deletes.push(key); return Number(state.values.delete(key)); },
  };
  return { state, outside, redis };
});
vi.mock('@/utils/cache', async original => ({ ...await original<typeof import('@/utils/cache')>(), getRedis: () => cache.state.enabled ? cache.redis : null }));
const APP = 'wx0000000000000001', OTHER = 'wx0000000000000002', SECRET = 'owned-notification-secret';
const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe('Mini notification immutable intended account and provider outcome ledger', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env, fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  const calls: Array<{ url: URL; body: unknown }> = [];
  const observe = (db: DbClient): DbClient => new Proxy(db, { get(target, key, receiver) {
    const method = Reflect.get(target, key, receiver) as unknown;
    if (typeof method !== 'function') return method;
    if (key !== 'transaction') return method.bind(target);
    return (action: (tx: DbClient) => Promise<unknown>, ...args: unknown[]) => Reflect.apply(method, target, [async (tx: DbClient) => {
      cache.state.depth++; try { return await action(observe(tx)); } finally { cache.state.depth--; }
    }, ...args]);
  } });
  const container = () => createContainerFromDb(observe(f.db));
  const payload = (): WechatTemplateNotificationPayload => ({ kind: 'wechat_routine', routineAppId: APP, data: { thing1: '商品' }, url: '/pages/goods/order_details/index?order_id=owned' });
  const message = (): OrderNotificationDeliveryMessage => ({ action: 'processOrderNotificationDelivery', deliveryId: 17, eventKey: 'order.delivery.notice:9', channel: 'wechat_routine' });
  const ledger = () => f.db.select().from(orderNotificationDelivery).orderBy(orderNotificationDelivery.id);
  const rotate = (id = 2, value = 'owned-next-secret') => f.db.update(systemConfig).set({ value: JSON.stringify(value) }).where(eq(systemConfig.id, id));
  const run = (msg = message()) => new OrderNotificationDeliveryService(container(), env).processMessage(msg, fetcher);
  const queue = async (body = payload()) => {
    await f.db.insert(orderNotificationDelivery).values({ id: 17, outboxId: 1, eventKey: message().eventKey, orderId: 9, userId: 7,
      noticeMark: 'order_postage_success', channel: 'wechat_routine', target: 'owned-openid', templateCode: 'owned-template', payload: body, status: 'ENQUEUED' });
  };
  const tokenCache = async () => {
    const credentials = await readRoutineCredentials(container(), env), key = routineCredentialCacheKey(credentials, 'access_token');
    cache.state.values.set(key, { version: 1, token: 'owned-cached-token', expiresAt: Date.now() + 600_000 }); return key;
  };
  const stage = async (eventKey = 'order.delivery.notice:9', data = { thing1: '商品' }) => {
    await withTx(container(), async tx => {
      const created = await enqueueOrderDeliveryNoticeEvent(tx, { orderId: 9, orderNo: 'owned', userId: 7, userAddress: '', deliveryType: 'express', deliveryName: 'owned', deliveryId: 'owned' }, 1800000000);
      const [event] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, created.id));
      await createImmutableDelivery(tx, { event: { ...event, eventKey }, payload: { userId: 7, orderId: 9 }, mark: 'order_postage_success',
        channel: 'wechat_routine', target: 'owned-openid', templateCode: 'owned-template', deliveryPayload: { kind: 'wechat_routine', data, url: '', routineAppId: 'caller-cannot-choose-account' }, now: 1800000000 });
    });
  };
  beforeAll(async () => {
    f = await financePostgres([systemConfig, storeOrderOutbox, orderNotificationDelivery]);
    await f.exec('CREATE UNIQUE INDEX ond_event_channel_uq ON order_notification_delivery(event_key,channel); CREATE UNIQUE INDEX soob_event_key_uq ON store_order_outbox(event_key)');
  }, 30000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(async () => {
    vi.restoreAllMocks(); cache.state.values.clear(); cache.state.reads.length = 0; cache.state.writes.length = 0; cache.state.deletes.length = 0;
    cache.state.depth = 0; cache.state.enabled = true; cache.state.getHook = undefined; calls.length = 0;
    await f.reset();
    await f.db.insert(systemConfig).values([{ id: 1, menuName: 'routine_appId', value: JSON.stringify(APP), sort: 5 },
      { id: 2, menuName: 'routine_appsecret', value: JSON.stringify(SECRET), sort: 5 },
      { id: 3, menuName: 'routine_appsecret', value: 'shadow-secret', sort: -1 }]);
    env = { APP_KEY: 'owned-notification-signing-key', CONFIG_KV: { get: vi.fn(async () => { cache.outside(); throw Error('Notification credential KV forbidden'); }), put: vi.fn(), delete: vi.fn() } } as unknown as Env;
    fetcher = vi.fn(async (input, init) => {
      cache.outside(); const url = new URL(String(input)); calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      return url.pathname === '/cgi-bin/token' ? Response.json({ access_token: 'owned-fresh-token', expires_in: 7200 }) : Response.json({ errcode: 0 });
    });
  });
  afterEach(() => { expect(cache.state.depth).toBe(0); expect(env.CONFIG_KV.get).not.toHaveBeenCalled(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('pins a newly rendered intent to public SQL AppID without requiring OAuth Secret or APP_KEY', async () => {
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 2)); env.APP_KEY = '';
    await stage(); expect((await ledger())[0]).toMatchObject({ status: 'PENDING', payload: { routineAppId: APP } });
    expect(fetcher).not.toHaveBeenCalled(); expect(cache.state.reads).toEqual([]);
  });
  it('replays retain the original pin across AppID changes and never rewrite immutable payloads', async () => {
    await stage(); const before = await ledger(); await rotate(1, OTHER); await stage(); expect(await ledger()).toEqual(before);
    await expect(stage(message().eventKey, { thing1: 'different' })).rejects.toThrow('不可变字段冲突'); expect(await ledger()).toEqual(before);
  });
  it('historical unbound intent replay remains unbound instead of receiving the current AppID', async () => {
    await stage(); const [row] = await ledger(); const { routineAppId: _old, ...unbound } = row.payload as WechatTemplateNotificationPayload;
    await f.db.update(orderNotificationDelivery).set({ payload: unbound }).where(eq(orderNotificationDelivery.id, row.id));
    const [root] = await f.db.select().from(storeOrderOutbox); const { routineAppId: _root, ...oldRoot } = root.payload as typeof root.payload & { routineAppId?: string };
    await f.db.update(storeOrderOutbox).set({ payload: oldRoot }).where(eq(storeOrderOutbox.id, root.id));
    const before = await ledger(); await rotate(1, OTHER); await stage(); expect(await ledger()).toEqual(before); expect((await ledger())[0].payload).not.toHaveProperty('routineAppId');
  });
  it('a delivery account cannot override an explicit different original business-event account', async () => {
    await stage(); const [row] = await ledger(); await f.db.update(orderNotificationDelivery).set({ payload: { ...row.payload, routineAppId: OTHER } as WechatTemplateNotificationPayload }).where(eq(orderNotificationDelivery.id, row.id));
    const before = await ledger(), root = await f.db.select().from(storeOrderOutbox); await rotate(1, OTHER);
    await expect(stage()).rejects.toThrow('原事件与投递账号不可变字段冲突'); expect(await ledger()).toEqual(before); expect(await f.db.select().from(storeOrderOutbox)).toEqual(root);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('an accumulated business event keeps its original account when rendered after rotation', async () => {
    const created = await withTx(container(), tx => enqueueOrderDeliveryNoticeEvent(tx, { orderId: 9, orderNo: 'owned', userId: 7, userAddress: '', deliveryType: 'express', deliveryName: 'owned', deliveryId: 'owned' }));
    const before = await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, created.id));
    await rotate(1, OTHER); await stage(); expect((await ledger())[0].payload).toMatchObject({ routineAppId: APP });
    expect(await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, created.id))).toEqual(before);
  });
  it('an old unbound business event cannot adopt a current account while rendering a delivery', async () => {
    await f.db.insert(storeOrderOutbox).values({ id: 1, eventKey: message().eventKey, aggregateType: 'order', aggregateId: 9, eventType: 'order.delivery.notice',
      payload: { orderId: 9, orderNo: 'owned', userId: 7, userAddress: '', deliveryType: 'express', deliveryName: 'owned', deliveryId: 'owned' } });
    const before = await f.db.select().from(storeOrderOutbox); await stage();
    expect((await ledger())[0]).toMatchObject({ status: 'SKIPPED', lastError: 'routine_account_evidence_required' });
    expect((await ledger())[0].payload).not.toHaveProperty('routineAppId'); expect(await f.db.select().from(storeOrderOutbox)).toEqual(before);
  });
  it('missing public account records SKIPPED for the optional Mini channel while SMS may still be staged', async () => {
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 1)); await stage();
    await withTx(container(), tx => createImmutableDelivery(tx, { event: { id: 1, eventKey: message().eventKey } as OrderNotificationOutboxEvent,
      payload: { userId: 7, orderId: 9 }, mark: 'order_postage_success', channel: 'sms', target: '13800000000', templateCode: 'SMS_owned', deliveryPayload: { kind: 'sms', params: {} }, now: 1800000000 }));
    expect(await ledger()).toMatchObject([{ status: 'SKIPPED', lastError: 'routine_account_not_configured' }, { channel: 'sms', status: 'PENDING' }]);
  });
  it.each([undefined, '', OTHER, 7, 'x'.repeat(65), 'bad\nappid'])('rejects unbound or mismatched durable target %j before HTTP [case %#]', async appId => {
    const body = { ...payload(), routineAppId: appId } as unknown as WechatTemplateNotificationPayload;
    await queue(body); const before = (await ledger())[0].payload;
    expect(await run()).toBe('dead'); expect(fetcher).not.toHaveBeenCalled(); expect((await ledger())[0]).toMatchObject({ status: 'DEAD', payload: before });
    expect(await run()).toBe('dead'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('fresh SQL pair and versioned token ignore all legacy keys and send only the original target/body', async () => {
    cache.state.values.set(`routine_access_token:${APP}`, 'legacy-token'); cache.state.values.set('routine_access_token', 'global-token');
    await queue(); expect(await run()).toBe('sent'); expect(await run()).toBe('already-sent');
    expect(calls).toHaveLength(2); expect(calls[0].url.searchParams.get('appid')).toBe(APP); expect(calls[0].url.searchParams.get('secret')).toBe(SECRET);
    expect(calls[1].body).toEqual({ touser: 'owned-openid', template_id: 'owned-template', page: payload().url, data: { thing1: { value: '商品' } } });
    expect(JSON.stringify(calls[1].body)).not.toMatch(/secret|routineAppId/u);
    expect(cache.state.reads).toEqual([routineCredentialCacheKey(await readRoutineCredentials(container(), env), 'access_token')]);
    expect((await ledger())[0]).toMatchObject({ status: 'SENT', attemptCount: 1 });
  });
  it('uses the matching cached token without fetching or touching another namespace', async () => {
    const key = await tokenCache(); await queue(); expect(await run()).toBe('sent'); expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get('access_token')).toBe('owned-cached-token'); expect(cache.state.reads).toEqual([key]);
  });
  it('can send without Redis using the same fresh SQL/token admission', async () => {
    cache.state.enabled = false; await queue(); expect(await run()).toBe('sent'); expect(calls).toHaveLength(2); expect(cache.state.reads).toEqual([]);
  });
  it.each([40001, 40014, 42001])('retries explicit invalid-token %i once in the captured source namespace', async errcode => {
    const key = await tokenCache(), original = fetcher.getMockImplementation()!; let posts = 0;
    fetcher.mockImplementation(async (input, init) => { const response = await original(input, init); return new URL(String(input)).pathname !== '/cgi-bin/token' && ++posts === 1 ? Response.json({ errcode }) : response; });
    await queue(); expect(await run()).toBe('sent'); expect(posts).toBe(2); expect(calls).toHaveLength(3); expect(cache.state.deletes).toEqual([key]);
  });
  it.each(['AppID', 'Secret', 'ABA', 'shadow'])('a %s change after known rejection prevents the second POST and preserves the pin', async kind => {
    await tokenCache(); const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => { await original(input, init);
      if (kind === 'shadow') await f.db.update(systemConfig).set({ info: 'changed shadow' }).where(eq(systemConfig.id, 3));
      else { await rotate(kind === 'AppID' ? 1 : 2, kind === 'AppID' ? OTHER : 'next-secret'); if (kind === 'ABA') await rotate(2, SECRET); }
      return Response.json({ errcode: 40014 });
    });
    await queue(); expect(await run()).toBe('dead'); expect(calls).toHaveLength(1); expect(cache.state.deletes).toEqual([]);
    expect((await ledger())[0]).toMatchObject({ status: 'DEAD', payload: { routineAppId: APP } });
  });
  it.each(['cache', 'provider'])('source rotation during %s token read prevents all notification POSTs', async source => {
    if (source === 'cache') { await tokenCache(); cache.state.getHook = async () => { cache.state.getHook = undefined; await rotate(); }; }
    else { const original = fetcher.getMockImplementation()!; fetcher.mockImplementation(async (input, init) => { const response = await original(input, init); await rotate(); return response; }); }
    await queue(); expect(await run()).toBe('dead'); expect(calls.every(call => call.url.pathname === '/cgi-bin/token')).toBe(true);
    expect(await run()).toBe('dead'); expect((await ledger())[0]).toMatchObject({ status: 'DEAD', attemptCount: 1 });
  });
  it('known successful POST stays SENT after AppID rotates before the response, with no post-send SQL admission', async () => {
    await tokenCache(); const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => { const response = await original(input, init); await rotate(1, OTHER); return response; });
    await queue(); expect(await run()).toBe('sent'); expect(await run()).toBe('already-sent'); expect(calls).toHaveLength(1);
    expect((await ledger())[0]).toMatchObject({ status: 'SENT', payload: { routineAppId: APP } });
  });
  it.each([{ errcode: 43101, expected: 'dead', status: 'DEAD' }, { errcode: 45009, expected: 'retry-scheduled', status: 'RETRYABLE' }])('classifies explicit rejection $errcode as $status', async entry => {
    await tokenCache(); fetcher.mockImplementation(async () => { cache.outside(); return Response.json({ errcode: entry.errcode }); });
    await queue(); expect(await run()).toBe(entry.expected); expect((await ledger())[0]).toMatchObject({ status: entry.status, responseCode: String(entry.errcode) }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  const ambiguous = [
    { name: 'disconnect', response: () => { throw Error('disconnect after send'); } },
    { name: 'invalid JSON', response: () => new Response('{') },
    { name: 'missing errcode', response: () => Response.json({ errmsg: 'ok' }) },
    { name: 'string errcode', response: () => Response.json({ errcode: '0' }) },
    { name: 'array', response: () => Response.json([]) },
    { name: 'HTTP failure without provider rejection', response: () => Response.json({ errcode: 0 }, { status: 502 }) },
    { name: 'oversized declared body', response: () => new Response('{"errcode":0}', { headers: { 'Content-Length': String(65537) } }) },
    { name: 'oversized streamed body', response: () => new Response(' '.repeat(65537)) },
    { name: 'invalid UTF-8', response: () => new Response(new Uint8Array([255])) },
  ];
  it.each(ambiguous)('$name after POST remains UNKNOWN across rotation and Queue replay', async entry => {
    await tokenCache(); fetcher.mockImplementation(async () => { cache.outside(); await rotate(1, OTHER); return entry.response(); });
    await queue(); const before = (await ledger())[0].payload; expect(await run()).toBe('unknown'); expect(await run()).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(1); expect((await ledger())[0]).toMatchObject({ status: 'UNKNOWN', attemptCount: 1, payload: before }); expect(cache.state.deletes).toEqual([]);
  });
  it.each(['fetch', 'body'])('8-second %s deadline remains UNKNOWN even when transport ignores abort', async mode => {
    await tokenCache(); await queue(); const entered = barrier(); let canceled = false;
    fetcher.mockImplementation(async () => { cache.outside(); entered.resolve(); if (mode === 'fetch') return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"errcode":')); }, cancel() { canceled = true; } })); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const pending = run();
    await entered.promise; await vi.advanceTimersByTimeAsync(8001); expect(await pending).toBe('unknown'); vi.useRealTimers();
    expect(await run()).toBe('unknown'); expect(fetcher).toHaveBeenCalledTimes(1); if (mode === 'body') expect(canceled).toBe(true);
  });
  it.each(['pair', 'signing', 'capacity'])('known %s configuration failure is DEAD before HTTP', async kind => {
    if (kind === 'pair') { await f.db.delete(systemConfig).where(eq(systemConfig.id, 2)); await f.db.delete(systemConfig).where(eq(systemConfig.id, 3)); }
    if (kind === 'signing') env.APP_KEY = '';
    if (kind === 'capacity') await f.db.insert(systemConfig).values(Array.from({ length: 62 }, (_, i) => ({ id: 100 + i, menuName: 'routine_appsecret', value: 'shadow', sort: -1 })));
    await queue(); expect(await run()).toBe('dead'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('SQL faults retain UNKNOWN instead of being mislabeled as missing configuration', async () => {
    await queue(); await f.exec('ALTER TABLE system_config RENAME COLUMN menu_name TO unavailable_menu_name');
    try { expect(await run()).toBe('unknown'); expect(fetcher).not.toHaveBeenCalled(); }
    finally { await f.exec('ALTER TABLE system_config RENAME COLUMN unavailable_menu_name TO menu_name'); }
  });
  it('shipping without original AppID/merchant/payer evidence is preserved DEAD without current-config or HTTP fallback', async () => {
    const body = { kind: 'wechat_shipping' as const, transactionId: 'old-transaction', logisticsType: 1, deliveryMode: 1 as const, isAllDelivered: true,
      itemDescription: '商品', trackingNumber: 'old-track', expressCompanyName: 'old-express', receiverContact: '13800000000', path: '' };
    await f.db.insert(orderNotificationDelivery).values({ id: 17, outboxId: 1, eventKey: message().eventKey, orderId: 9, userId: 7, noticeMark: 'order_postage_success',
      channel: 'wechat_shipping', target: 'old-payer', payload: body, status: 'ENQUEUED' });
    const before = (await ledger())[0].payload; expect(await run({ ...message(), channel: 'wechat_shipping' })).toBe('dead');
    expect((await ledger())[0]).toMatchObject({ status: 'DEAD', payload: before, lastError: 'wechat_shipping_original_account_evidence_required' }); expect(fetcher).not.toHaveBeenCalled();
  });
  it.runIf(native)('independent PG maintenance gate blocks dispatch before HTTP without holding the provider in SQL', async () => {
    await queue(); await withFinancePeers(f.db, async ([owner]) => {
      await owner.exec('BEGIN'); try { await owner.exec('SELECT pg_advisory_xact_lock(731666,0)'); expect(await run()).toBe('unknown'); expect(fetcher).not.toHaveBeenCalled(); }
      finally { await owner.exec('ROLLBACK'); }
    });
  });
});
