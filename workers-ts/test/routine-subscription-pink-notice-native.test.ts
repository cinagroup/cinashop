/** Actual PG16 five LOGINs: Admin combination -> two real JWT buyers' type3
 * cart/confirm/create -> separately approved original RSA/AES callbacks while
 * current B stays selected -> actual natural/virtual group authors -> request4
 * -> App stage4 -> original A/C Queue GET/POST and immutable attempt/result.
 * Only provider/KV/cache/Queue transports and initial catalog/users are local.
 * SQL mutations below are labelled negatives/scheduler controls, never paid,
 * successful group, approval, business receipt or provider-positive authors.
 * Phone continuity is explicit verified server input, not SMS login coverage. */
import { assertRoutineNotificationContinuation } from './helpers/routineNotificationContinuationAssertions';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { orderNotificationDelivery, storeOrderOutbox, storeOrder, storePink, systemConfig, systemMessage, systemNotification, user, wechatUser,
  type OrderPinkSuccessNoticeOutboxPayload, type WechatTemplateNotificationPayload } from '@/models/schema';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { enqueueOrderPinkSuccessNoticeEvent, processOrderNotificationOutboxEvent } from '@/services/order/OrderNotificationOutboxService';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { prepareRoutineSubscriptionNoticeAuthorTx } from '@/services/wechat/RoutineSubscriptionDeliveryNotice';
import { routineSubscriptionScopeTx, subscriptionMac } from '@/services/wechat/RoutineSubscriptionAccount';
import { parseRoutineSubscriptionPinkRequest } from '@/services/wechat/RoutineSubscriptionPinkRequest';
import { parseRoutineSubscriptionNoticeIntent } from '@/services/wechat/RoutineSubscriptionNoticeIntent';
import { routineSubscriptionPinkFixture, PINK_ACCOUNTS, PINK_CURRENT_B, PINK_GLOBAL_B, PINK_MARK,
  type PinkAccount } from './helpers/routineSubscriptionPinkFixture';

const transport = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const get = vi.fn(async (k: string) => values.get(k) ?? null), set = vi.fn(async (k: string, v: unknown) => { values.set(k, v); return true; });
  const remove = vi.fn(async (k: string) => values.delete(k));
  const take = vi.fn(async (k: string) => { const v = values.get(k) ?? null; values.delete(k); return v; });
  const setIfAbsent = vi.fn(async (k: string, v: unknown) => { if (values.has(k)) return false; values.set(k, v); return true; });
  const redis = { eval: vi.fn(async () => 1), get, set: vi.fn(async (k: string, v: unknown) => { await set(k, v); return 'OK'; }), del: vi.fn(async (k: string) => Number(await remove(k))) };
  return { values, get, set, remove, take, setIfAbsent, redis };
});
vi.mock('@/utils/cache', async original => ({ ...await original<typeof import('@/utils/cache')>(), getRedis: () => transport.redis,
  cacheGet: transport.get, cacheSet: transport.set, cacheDelete: transport.remove, cacheTake: transport.take, cacheSetIfAbsent: transport.setIfAbsent,
  setTokenBucket: vi.fn(async () => true), clearToken: vi.fn(async () => true) }));

type Fixture = Awaited<ReturnType<typeof routineSubscriptionPinkFixture>>;
type Event = typeof storeOrderOutbox.$inferSelect;
type Source = { order: typeof storeOrder.$inferSelect; event: Event; kind: PinkAccount };
type Staged = Source & { delivery: typeof orderNotificationDelivery.$inferSelect };
type Query = Pick<DbClient, 'execute'>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const bare = (uid: number) => 'pink_latest_bare_b_' + uid;
const msg = (event: Event) => ({ action: 'processOrderNotificationOutbox' as const, outboxId: event.id, eventKey: event.eventKey });
const date = (seconds: number) => new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 19).replace('T', ' ');

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual multi-buyer original-account group-success3098 notification', () => {
  let f: Fixture, network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  let legacyB: Staged, legacyEmpty: Staged, missingOwnerA: Source, missingOwnerC: Source;
  let missingEffects: Awaited<ReturnType<typeof effects>>;
  const app = () => createContainerFromDb(f.appRuntime.db);
  const outbox = () => new OrderOutboxService(app(), f.env);
  const consumer = () => new OrderNotificationDeliveryService(app(), f.env);
  const source = async (order: typeof storeOrder.$inferSelect, kind: PinkAccount): Promise<Source> => {
    const events = await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, 'order.pink.success.notice:' + order.id));
    expect(events).toHaveLength(1); return { order, event: events[0], kind };
  };
  const routine = (s: Source) => f.maintenanceDb.select().from(orderNotificationDelivery).where(and(
    eq(orderNotificationDelivery.eventKey, s.event.eventKey), eq(orderNotificationDelivery.channel, 'wechat_routine')));
  async function effects(s: Source) {
    return { sms: await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey, s.event.eventKey), eq(orderNotificationDelivery.channel, 'sms'))),
      inbox: await f.maintenanceDb.select().from(systemMessage).where(eq(systemMessage.eventKey, s.event.eventKey)) };
  }
  const eventFor = async (s: Source) => (await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, s.event.id)))[0];
  const retry = async (s: Source) => {
    // Scheduler availability only, not a new source, lease or attempt.
    await f.maintenanceDb.update(storeOrderOutbox).set({ availableTime: 0 }).where(eq(storeOrderOutbox.id, s.event.id));
    return outbox().processMessage(msg(s.event));
  };
  async function signed(s: Source) {
    const p = s.event.payload as OrderPinkSuccessNoticeOutboxPayload;
    expect(p).not.toHaveProperty('routineAppId');
    const r = parseRoutineSubscriptionPinkRequest(f.env, p.routineSubscriptionRequest, await routineSubscriptionScopeTx(f.maintenanceDb));
    expect(r).toMatchObject({ format: 4, actor: { role: f.appRuntime.role }, eventKey: s.event.eventKey, aggregateId: s.order.id,
      eventTime: s.event.addTime, body: { orderId: s.order.id, orderNo: s.order.orderId, userId: s.order.uid, pinkId: s.order.pinkId } }); return r;
  }
  async function staged(s: Source): Promise<Staged> {
    const status = await retry(s); expect(['completed', 'already-completed']).toContain(status);
    const rows = await routine(s); expect(rows).toHaveLength(1); const delivery = rows[0], a = PINK_ACCOUNTS[s.kind];
    expect(delivery).toMatchObject({ status: 'PENDING', target: a.target, templateCode: a.template,
      payload: { routineAppId: a.appId, routineSubscriptionIntent: { format: 4, outboxId: s.event.id, deliveryId: delivery.id,
        source: { appId: a.appId, buyerUid: s.order.uid, templateMark: '3098' } } } });
    const intent = (delivery.payload as WechatTemplateNotificationPayload).routineSubscriptionIntent;
    expect(parseRoutineSubscriptionNoticeIntent(f.env, intent, await routineSubscriptionScopeTx(f.maintenanceDb))).toEqual(intent);
    return { ...s, delivery };
  }
  const attempts = (s: Staged) => f.maintenanceDb.execute<any>(sql`SELECT * FROM public.routine_subscribe_attempt WHERE delivery_id=${s.delivery.id} ORDER BY attempt_no`);
  const results = (s: Staged) => f.maintenanceDb.execute<any>(sql`SELECT r.* FROM public.routine_subscribe_result r JOIN public.routine_subscribe_attempt a USING(attempt_id) WHERE a.delivery_id=${s.delivery.id}`);
  const posts = () => network.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/cgi-bin/message/subscribe/send');
  const gets = () => network.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/cgi-bin/token');
  async function queued(s: Staged) {
    const before = f.messages.length; expect((await consumer().dispatchPending(30, s.event.eventKey)).enqueued).toBeGreaterThan(0);
    const messages = f.messages.slice(before).filter(isOrderNotificationDeliveryMessage).filter(m => m.deliveryId === s.delivery.id);
    expect(messages).toHaveLength(1); return messages[0];
  }
  function provider(lost = false) {
    for (const key of transport.values.keys()) if (key.startsWith('routine:subscription:')) transport.values.delete(key);
    network.mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe('https://api.weixin.qq.com'); expect(init?.redirect).toBe('error');
      const [idle] = await f.maintenanceDb.execute<{ n: number }>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity
        WHERE usename IN(${f.appRuntime.role},${f.adminRuntime.role},${f.financialRuntime.role},${f.managerRuntime.role},${f.cashierRuntime.role}) AND state='idle in transaction'`);
      expect(idle.n).toBe(0);
      const [current] = await f.maintenanceDb.select().from(systemConfig).where(eq(systemConfig.menuName, 'routine_appId'));
      expect(JSON.parse(current.value)).toBe(PINK_CURRENT_B);
      if (url.pathname === '/cgi-bin/token') {
        expect(init?.method).toBe('GET'); const kind = url.searchParams.get('appid') === PINK_ACCOUNTS.a.appId ? 'a' : 'c', a = PINK_ACCOUNTS[kind];
        expect(url.searchParams.get('appid')).toBe(a.appId); expect(url.searchParams.get('secret')).toBe(a.secret);
        return Response.json({ access_token: 'synthetic-pink-token-' + kind, expires_in: 7200 });
      }
      expect(url.pathname).toBe('/cgi-bin/message/subscribe/send'); expect(init?.method).toBe('POST');
      const token = url.searchParams.get('access_token'), kind = token === 'synthetic-pink-token-a' ? 'a' : 'c', a = PINK_ACCOUNTS[kind];
      expect(token).toBe('synthetic-pink-token-' + kind);
      const body = JSON.parse(String(init?.body)); expect(body).toMatchObject({ touser: a.target, template_id: a.template,
        data: { thing1: { value: '原生3098成团商品' }, name3: { value: '原生团长' } } });
      for (const forbidden of [PINK_ACCOUNTS.a.payer, PINK_ACCOUNTS.c.payer, bare(11), bare(22), PINK_GLOBAL_B]) expect(String(init?.body)).not.toContain(forbidden);
      if (lost) throw Error('Controlled lost response after actual local3098 POST'); return Response.json({ errcode: 0 });
    });
  }
  async function identity(kind: PinkAccount) {
    const a = PINK_ACCOUNTS[kind]; await f.current(a.appId);
    await f.maintenanceDb.insert(wechatUser).values({ uid: a.uid, userType: 'routine', openid: a.target });
    network.mockImplementation(async input => {
      const url = new URL(String(input)); expect(url.pathname).toBe('/sns/jscode2session'); expect(url.searchParams.get('appid')).toBe(a.appId);
      return Response.json({ openid: a.target, session_key: Buffer.from('0123456789abcdef').toString('base64') });
    });
    const auth = new WechatAuthService(app(), f.env), ticket = await auth.beginMiniProgramLogin({ code: randomUUID(), ip: '127.0.0.1' });
    const pending = transport.values.get('routine_login:' + ticket.key) as { identity: VerifiedSocialIdentity };
    expect(pending.identity.routineObservation).toMatchObject({ appId: a.appId, openid: a.target });
    expect(await auth.reconcileVerifiedIdentity({ ...pending.identity, phone: a.phone })).toBe(a.uid);
    await f.maintenanceDb.delete(wechatUser).where(eq(wechatUser.openid, bare(a.uid)));
    await f.maintenanceDb.insert(wechatUser).values({ uid: a.uid, userType: 'routine', openid: bare(a.uid) });
    await f.current(); network.mockReset().mockRejectedValue(Error('Unexpected provider transport'));
  }
  async function hold(lock: (tx: Query) => Promise<unknown>, work: () => Promise<void>) {
    await f.withMaintenancePeer(async peer => {
      let ready!: () => void, release!: () => void;
      const acquired = new Promise<void>(r => { ready = r; }), released = new Promise<void>(r => { release = r; });
      const held = peer.transaction(async tx => { await lock(tx); ready(); await released; });
      try { await Promise.race([acquired, held.then(() => { throw Error('Source lock holder ended early'); })]); await work(); }
      finally { release(); await held; }
    });
  }
  async function formed() {
    const g = await f.group(); expect(g.second).toBeDefined(); return { g, a: await source(g.first, 'a'), c: await source(g.second!, 'c') };
  }
  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unexpected provider transport'));
    f = await routineSubscriptionPinkFixture(); await identity('a');
    await f.maintenanceDb.insert(wechatUser).values({ uid: 22, userType: 'routine', openid: bare(22) });
    const old = await formed(); expect(await outbox().processMessage(msg(old.a.event))).toBe('completed');
    legacyB = { ...old.a, delivery: (await routine(old.a))[0] };
    await f.current(''); const empty = await formed(); expect(await outbox().processMessage(msg(empty.a.event))).toBe('completed');
    legacyEmpty = { ...empty.a, delivery: (await routine(empty.a))[0] }; await f.current();
    await f.commissionDelivery();
    const missing = await formed(); missingOwnerA = missing.a; missingOwnerC = missing.c;
    await signed(missing.c); expect(await outbox().processMessage(msg(missing.a.event))).toBe('completed');
    expect(await outbox().processMessage(msg(missing.c.event))).toBe('deferred'); expect(await routine(missing.c)).toHaveLength(0);
    missingEffects = await effects(missing.c); expect(missingEffects.sms).toHaveLength(1); expect(missingEffects.inbox).toHaveLength(1);
    await identity('c');
    const logins = await Promise.all([f.appRuntime, f.adminRuntime, f.managerRuntime, f.financialRuntime, f.cashierRuntime].map(p => p.verify()));
    expect(new Set(logins).size).toBe(5);
  }, 300000);
  afterEach(() => { network.mockReset().mockRejectedValue(Error('Unexpected provider transport')); });
  afterAll(async () => { try { await f?.close(); } finally { vi.restoreAllMocks(); } }, 30000);

  it('preserves genuine pre-commission B/empty pins and never upgrades a missing-pin SQL negative', async () => {
    expect(legacyB.event.payload).toHaveProperty('routineAppId', PINK_CURRENT_B); expect(legacyB.event.payload).not.toHaveProperty('routineSubscriptionRequest');
    expect(legacyEmpty.event.payload).toHaveProperty('routineAppId', ''); expect(legacyEmpty.delivery.status).toBe('SKIPPED');
    for (const old of [legacyB, legacyEmpty]) {
      const before = clone(await eventFor(old)), rows = clone(await routine(old));
      expect(await outbox().processMessage(msg(old.event))).toBe('already-completed');
      expect(await eventFor(old)).toEqual(before); expect(await routine(old)).toEqual(rows);
      expect(rows[0].payload).not.toHaveProperty('routineSubscriptionIntent');
    }
    provider(); expect(await consumer().processMessage(await queued(legacyB), network)).toBe('dead'); expect(network).not.toHaveBeenCalled();
    const missing = clone(legacyB.event.payload) as OrderPinkSuccessNoticeOutboxPayload; delete missing.routineAppId;
    await f.maintenanceDb.update(storeOrderOutbox).set({ payload: missing }).where(eq(storeOrderOutbox.id, legacyB.event.id));
    try { await expect(withTx(app(), tx => prepareRoutineSubscriptionNoticeAuthorTx(tx, f.env, { outboxId: legacyB.event.id, eventKey: legacyB.event.eventKey }))).rejects.toMatchObject({ code: 503 }); }
    finally { await f.maintenanceDb.update(storeOrderOutbox).set({ payload: legacyB.event.payload }).where(eq(storeOrderOutbox.id, legacyB.event.id)); }
  }, 90000);

  it('keeps missing C ownership local, then sends each real mixed A/C buyer through their own original account', async () => {
    const a = await staged(missingOwnerA), c = await staged(missingOwnerC);
    expect(await effects(missingOwnerC)).toEqual(missingEffects);
    const ar = await signed(a), cr = await signed(c); expect(ar.group).toEqual(cr.group); expect(ar.body.userId).not.toBe(cr.body.userId); expect(a.order.tradeNo).not.toBe(c.order.tradeNo);
    expect(ar.member.orderId).not.toBe(cr.member.orderId); expect(ar.member.addTime).toBeLessThan(cr.member.addTime); expect(ar.group).toMatchObject({ realMembers: 2, virtualMembers: 0 });
    provider(); expect(await consumer().processMessage(await queued(a), network)).toBe('sent');
    expect(await consumer().processMessage(await queued(c), network)).toBe('sent'); expect(posts()).toHaveLength(2); expect(gets()).toHaveLength(2);
    for (const s of [a, c]) { expect(await attempts(s)).toHaveLength(1); expect(await results(s)).toHaveLength(1); }
  }, 120000);

  it('uses each member persisted join date and keeps producer/staging request signatures on same-key replay', async () => {
    const { g, a, c } = await formed(), sa = await staged(a), sc = await staged(c);
    for (const s of [sa, sc]) {
      const r = await signed(s), member = g.rows.find(m => m.id === r.member.id)!;
      expect((s.delivery.payload as WechatTemplateNotificationPayload).data).toMatchObject({ date5: date(member.addTime), number2: '2', name3: '原生团长' });
      const before = clone(await eventFor(s)), rows = clone(await routine(s)), p = s.event.payload as OrderPinkSuccessNoticeOutboxPayload;
      await withTx(app(), tx => enqueueOrderPinkSuccessNoticeEvent(tx, { orderId: p.orderId, orderNo: p.orderNo, userId: p.userId, pinkId: p.pinkId, people: p.people }, s.event.addTime + 1, f.env));
      await withTx(app(), tx => processOrderNotificationOutboxEvent(tx, before, s.event.addTime + 1));
      expect(await eventFor(s)).toEqual(before); expect(await routine(s)).toEqual(rows);
    }
    expect(network).not.toHaveBeenCalled();
  }, 120000);

  it('uses the actual virtual-threshold timeout author and creates no virtual order, event or provider recipient', async () => {
    const g = await f.group({ people: 3, virtual: 33, one: true }); expect(g.rows).toHaveLength(1); expect(g.rows[0].status).toBe(1);
    // Actual timeout author, with its published explicit future now parameter
    // advancing logical time beyond the persisted deadline; no hour-long wait
    // and no SQL-created success or virtual-member positive.
    expect(await f.expire(g.pinkId)).toMatchObject({ completed: true, expired: false });
    const members = await f.maintenanceDb.select().from(storePink).where(sql`${storePink.id}=${g.pinkId} OR ${storePink.kId}=${g.pinkId}`);
    expect(members).toHaveLength(3); expect(members.filter(m => m.isVirtual === 1)).toMatchObject([{ uid: 0, orderId: '0', orderIdKey: '0' }, { uid: 0, orderId: '0', orderIdKey: '0' }]);
    const events = await f.maintenanceDb.select().from(storeOrderOutbox).where(sql`${storeOrderOutbox.eventType}='order.pink.success.notice' AND ${storeOrderOutbox.payload}->>'pinkId'=${String(g.pinkId)}`);
    expect(events).toHaveLength(1); const s = await source(await f.actual(g.first.id), 'a'), r = await signed(s);
    expect(r.group).toMatchObject({ realMembers: 1, virtualMembers: 2 });
    const ready = await staged(s); provider(); expect(await consumer().processMessage(await queued(ready), network)).toBe('sent'); expect(posts()).toHaveLength(1);
    const incomplete = await f.group({ people: 3, virtual: 100, one: true });
    network.mockReset().mockRejectedValue(Error('Uncommissioned refund provider transport disabled'));
    // The existing timeout failure transition commits before compensation.
    // Original refund execution is not commissioned by this notification
    // fixture, so compensation can reject; no completed refund is claimed.
    await f.expire(incomplete.pinkId).catch(() => undefined);
    const [failed] = await f.maintenanceDb.select().from(storePink).where(eq(storePink.id, incomplete.pinkId));
    expect(failed.status).toBe(3);
    expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, 'order.pink.success.notice:' + incomplete.first.id))).toHaveLength(0);
    expect(network.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/cgi-bin/message/subscribe/send')).toHaveLength(0);
  }, 120000);

  it('does not borrow C notify/query, unrelated1451 or global B approval, while A remains independently sendable', async () => {
    await f.approve('c', { templates: [{ mark: '1451', templateId: 'pink_wrong_refusal_template' }] });
    try {
      const { a, c } = await formed(); await signed(c);
      expect(await outbox().processMessage(msg(c.event))).toBe('deferred'); expect(await routine(c)).toHaveLength(0);
      const saved = await effects(c); expect(saved.sms).toHaveLength(1); expect(saved.inbox).toHaveLength(1);
      provider(); const sa = await staged(a); expect(await consumer().processMessage(await queued(sa), network)).toBe('sent'); expect(posts()).toHaveLength(1);
      await f.approve('c'); const sc = await staged(c); expect(await effects(c)).toEqual(saved);
      expect(await consumer().processMessage(await queued(sc), network)).toBe('sent'); expect(posts()).toHaveLength(2);
    } finally { await f.approve('c'); }
  }, 120000);

  it('preserves account-phone SMS/inbox bytes through real source contention and changed current render inputs', async () => {
    const { a } = await formed(); let saved!: Awaited<ReturnType<typeof effects>>;
    const [profile] = await f.maintenanceDb.select().from(user).where(eq(user.uid, 11));
    const [template] = await f.maintenanceDb.select().from(systemNotification).where(eq(systemNotification.mark, PINK_MARK));
    try {
      await hold(tx => tx.execute(sql`LOCK TABLE ONLY public.routine_original_payment_evidence IN ACCESS EXCLUSIVE MODE NOWAIT`), async () => {
        expect(await outbox().processMessage(msg(a.event))).toBe('deferred'); expect(await routine(a)).toHaveLength(0);
        saved = await effects(a); expect(saved.sms).toHaveLength(1); expect(saved.inbox).toHaveLength(1); expect(saved.sms[0].target).toBe(PINK_ACCOUNTS.a.phone);
        await f.maintenanceDb.update(user).set({ phone: '13800000099' }).where(eq(user.uid, 11));
        await f.maintenanceDb.update(systemNotification).set({ smsId: 'later_pink_sms', systemTitle: 'later title', systemText: 'later text' }).where(eq(systemNotification.id, template.id));
        expect(await retry(a)).toBe('deferred'); expect(await effects(a)).toEqual(saved);
      });
    } finally {
      await f.maintenanceDb.update(user).set({ phone: profile.phone }).where(eq(user.uid, 11));
      await f.maintenanceDb.update(systemNotification).set({ smsId: template.smsId, systemTitle: template.systemTitle, systemText: template.systemText }).where(eq(systemNotification.id, template.id));
    }
    await staged(a); expect(await effects(a)).toEqual(saved); expect(saved.sms[0].addTime).toBe(a.event.addTime); expect(network).not.toHaveBeenCalled();
  }, 120000);

  it('rolls actual late intent UPDATE failure back to no Mini row and retains SMS/inbox before recovery', async () => {
    const { a } = await formed(); let saved!: Awaited<ReturnType<typeof effects>>;
    await f.maintenanceDb.execute(sql.raw(`CREATE FUNCTION public.pink_test_intent_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_key='${a.event.eventKey}' AND NEW.payload ? 'routineSubscriptionIntent' THEN RAISE EXCEPTION 'controlled pink intent failure'; END IF; RETURN NEW; END $$`));
    await f.maintenanceDb.execute(sql.raw('CREATE TRIGGER pink_test_intent_failure BEFORE UPDATE ON public.order_notification_delivery FOR EACH ROW EXECUTE FUNCTION public.pink_test_intent_failure()'));
    try { expect(await outbox().processMessage(msg(a.event))).toBe('deferred'); expect(await routine(a)).toHaveLength(0);
      saved = await effects(a); expect(saved.sms).toHaveLength(1); expect(saved.inbox).toHaveLength(1); }
    finally { await f.maintenanceDb.execute(sql.raw('DROP TRIGGER pink_test_intent_failure ON public.order_notification_delivery')); await f.maintenanceDb.execute(sql.raw('DROP FUNCTION public.pink_test_intent_failure()')); }
    await staged(a); expect(await routine(a)).toHaveLength(1); expect(await effects(a)).toEqual(saved); expect(network).not.toHaveBeenCalled();
  }, 120000);

  it('defers missing consumer signing material and recovers the same request4 and other-channel bytes', async () => {
    const { c } = await formed(), before = clone(c.event.payload), key = f.env.APP_KEY; let saved!: Awaited<ReturnType<typeof effects>>;
    try { f.env.APP_KEY = ''; expect(await outbox().processMessage(msg(c.event))).toBe('deferred'); expect(await routine(c)).toHaveLength(0); saved = await effects(c); }
    finally { f.env.APP_KEY = key; }
    await staged(c); expect((await eventFor(c)).payload).toEqual(before); expect(await effects(c)).toEqual(saved); expect(network).not.toHaveBeenCalled();
  }, 120000);

  it('fresh rejects MAC, domain, group, member, UID and public identity SQL negatives before any provider call', async () => {
    const { a } = await formed(), original = await signed(a), payload = clone(a.event.payload as OrderPinkSuccessNoticeOutboxPayload);
    for (const kind of ['mac', 'domain', 'scope', 'uid', 'member', 'digest', 'ids'] as const) {
      const { signature: _signature, ...unsigned } = clone(original), changed = { ...unsigned, scope: { ...unsigned.scope }, body: { ...unsigned.body }, member: { ...unsigned.member }, group: { ...unsigned.group, memberIds: [...unsigned.group.memberIds] } };
      if (kind === 'scope') changed.scope.databaseOid = '4294967294';
      if (kind === 'uid') { changed.body.userId = 22; changed.member.uid = 22; }
      if (kind === 'member') changed.member.id = original.group.memberIds[1];
      if (kind === 'digest') changed.group.membersDigest = 'a'.repeat(64);
      if (kind === 'ids') changed.group.memberIds = [original.group.memberIds[0], original.group.memberIds[1] + 10000];
      const specimen = { ...changed, signature: kind === 'mac' ? '0'.repeat(64) : subscriptionMac(f.env, kind === 'domain' ? 'refusal-notice-request' : 'pink-notice-request', changed) };
      await f.maintenanceDb.update(storeOrderOutbox).set({ payload: { ...payload, routineSubscriptionRequest: specimen } }).where(eq(storeOrderOutbox.id, a.event.id));
      try { await expect(withTx(app(), tx => prepareRoutineSubscriptionNoticeAuthorTx(tx, f.env, { outboxId: a.event.id, eventKey: a.event.eventKey }))).rejects.toMatchObject({ code: 503 }); }
      finally { await f.maintenanceDb.update(storeOrderOutbox).set({ payload }).where(eq(storeOrderOutbox.id, a.event.id)); }
    }
    const [row] = await f.maintenanceDb.select().from(storePink).where(eq(storePink.id, original.member.id));
    for (const patch of [{ orderIdKey: 'foreign_identity' }, { isRefund: original.group.pinkId }, { status: 1 }]) {
      await f.maintenanceDb.update(storePink).set(patch).where(eq(storePink.id, row.id));
      try { await expect(withTx(app(), tx => prepareRoutineSubscriptionNoticeAuthorTx(tx, f.env, { outboxId: a.event.id, eventKey: a.event.eventKey }))).rejects.toMatchObject({ code: 503 }); }
      finally { await f.maintenanceDb.update(storePink).set({ orderIdKey: row.orderIdKey, isRefund: row.isRefund, status: row.status }).where(eq(storePink.id, row.id)); }
    }
    await staged(a); expect(network).not.toHaveBeenCalled();
  }, 150000);

  it('uses an actual other-buyer pending refund application without invalidating A, and denies that C target', async () => {
    const { a, c } = await formed();
    const applied = await f.http('/order/refund/apply/' + c.order.orderId, { refundReason: '真实成团成员退款申请', refundExplain: '只影响本买家通知', applyType: 1 }, 22);
    expect(applied.refundId).toBeGreaterThan(0);
    expect(await outbox().processMessage(msg(c.event))).toBe('completed'); expect(await routine(c)).toHaveLength(0);
    // Existing pink eligibility disables this target's whole notification;
    // the other buyer still owns an independent source and send capability.
    expect((await effects(c)).sms).toHaveLength(0);
    const ready = await staged(a); provider(); expect(await consumer().processMessage(await queued(ready), network)).toBe('sent'); expect(posts()).toHaveLength(1);
  }, 120000);

  it('rechecks revoked3098 and corrupt staged intent before attempt, token or POST', async () => {
    const { a, c } = await formed(), sa = await staged(a); await f.approve('a', { state: 'revoked' });
    try { provider(); expect(await consumer().processMessage(await queued(sa), network)).toBe('dead'); expect(await attempts(sa)).toHaveLength(0); expect(network).not.toHaveBeenCalled(); }
    finally { await f.approve('a'); }
    const sc = await staged(c), payload = clone(sc.delivery.payload as WechatTemplateNotificationPayload);
    payload.routineSubscriptionIntent = { ...payload.routineSubscriptionIntent!, signature: '0'.repeat(64) };
    await f.maintenanceDb.update(orderNotificationDelivery).set({ payload }).where(eq(orderNotificationDelivery.id, sc.delivery.id));
    provider(); expect(await consumer().processMessage(await queued(sc), network)).toBe('dead'); expect(await attempts(sc)).toHaveLength(0); expect(network).not.toHaveBeenCalled();
  }, 120000);

  it('keeps one real lost3098 POST UNKNOWN across replay and an explicit mutable delivery-ID substitution negative', async () => {
    const { a } = await formed(), ready = await staged(a); provider(true); const queue = await queued(ready);
    expect(await consumer().processMessage(queue, network)).toBe('unknown'); const before = clone(await attempts(ready));
    expect(before).toHaveLength(1); expect(await results(ready)).toHaveLength(0); expect(posts()).toHaveLength(1);
    expect(await consumer().processMessage(queue, network)).toBe('unknown'); expect(await attempts(ready)).toEqual(before); expect(posts()).toHaveLength(1);
    await f.maintenanceDb.delete(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, ready.delivery.id));
    const { id: _id, ...copy } = ready.delivery;
    const [replacement] = await f.maintenanceDb.insert(orderNotificationDelivery).values({ ...copy, status: 'PENDING', attemptCount: 0, replayCount: 0, availableTime: 0 }).returning();
    const replaced = { ...ready, delivery: replacement };
    expect(await consumer().processMessage(await queued(replaced), network)).toBe('unknown'); expect(posts()).toHaveLength(1);
    const rows = await f.maintenanceDb.execute<any>(sql`SELECT * FROM public.routine_subscribe_attempt WHERE source_key=${before[0].source_key}`);
    expect(rows.map(r => r.attempt_id)).toEqual([before[0].attempt_id]);
  }, 120000);

  it('preserves immutable unavailable4 after an explicit partial-catalog fault is repaired', async () => {
    let s!: Source;
    await f.maintenanceDb.execute(sql`CREATE INDEX rsnd_pink_test_partial ON public.routine_subscribe_result(attempt_id)`);
    try { const formedGroup = await formed(); s = formedGroup.a;
      expect(s.event.payload).toHaveProperty('routineSubscriptionRequest', { format: 4, unavailable: true });
      expect(await outbox().processMessage(msg(s.event))).toBe('completed'); expect(await routine(s)).toMatchObject([{ status: 'SKIPPED', target: '' }]); }
    finally { await f.maintenanceDb.execute(sql`DROP INDEX public.rsnd_pink_test_partial`); }
    const p = s.event.payload as OrderPinkSuccessNoticeOutboxPayload;
    await withTx(app(), tx => enqueueOrderPinkSuccessNoticeEvent(tx, { orderId: p.orderId, orderNo: p.orderNo, userId: p.userId, pinkId: p.pinkId, people: p.people }, s.event.addTime + 1, f.env));
    expect((await eventFor(s)).payload).toEqual(s.event.payload); expect(network).not.toHaveBeenCalled();
  }, 120000);
  it('classifies actual format4 history in the complete maintenance snapshot without sending or rewriting it', async () => {
    await assertRoutineNotificationContinuation(f,4,()=>[network.mock.calls.length,transport.get.mock.calls.length,transport.set.mock.calls.length,
      transport.remove.mock.calls.length,transport.take.mock.calls.length,transport.setIfAbsent.mock.calls.length,f.messages.length],Object.values(PINK_ACCOUNTS).flatMap(a=>[a.appId,a.payer,a.target,a.phone,a.secret,a.template]),false);
  },90000);
});
