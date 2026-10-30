import { createCipheriv, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, WechatCallbackOutboxMessage } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemConfig, wechatCallbackEvent, wechatCallbackOutbox, wechatCallbackWatermark, wechatUser } from '@/models/schema';
import { readRoutineAppIdSource, withRoutineAppId } from '@/services/wechat/RoutineRuntimeConfig';
import { WechatCallbackService } from '@/services/wechat/WechatCallbackService';
import type { WechatCallbackQuery } from '@/services/wechat/WechatCallbackCrypto';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';

const APP = 'wx0000000000000001', OTHER = 'wx0000000000000002', TOKEN = 'owned-mini-callback-token';
const KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const AES = KEY.toString('base64').slice(0, -1), TIME = 1800000000;
const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const message = (event = 'subscribe', time = TIME, extra = '') => `<xml><ToUserName>gh-owned-mini</ToUserName><FromUserName>same-openid</FromUserName><CreateTime>${time}</CreateTime><MsgType>event</MsgType><Event>${event}</Event>${extra}</xml>`;
function encrypted(xml: string, appId = APP): string {
  const body = Buffer.from(xml), size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  const raw = Buffer.concat([Buffer.alloc(16, 7), size, body, Buffer.from(appId)]);
  const padding = 32 - raw.length % 32;
  const cipher = createCipheriv('aes-256-cbc', KEY, KEY.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64');
}
function query(cipher = '', token = TOKEN): WechatCallbackQuery {
  const timestamp = String(TIME), nonce = 'owned-mini-nonce';
  const signature = createHash('sha1').update([token, timestamp, nonce, ...(cipher ? [cipher] : [])].sort().join('')).digest('hex');
  return { timestamp, nonce, signature: cipher ? '' : signature, msgSignature: cipher ? signature : '' };
}

describe('Mini callback fresh public admission and historical account scopes', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let depth = 0, afterTransaction: undefined | (() => Promise<void>);
  const outside = () => { if (depth) throw Error('External I/O inside callback SQL fence'); };
  const queue = { send: vi.fn(async () => { outside(); }), sendBatch: vi.fn(async () => { outside(); }) };
  const env = () => ({ WECHAT_MINI_CALLBACK_TOKEN: TOKEN, WECHAT_MINI_CALLBACK_AES_KEY: AES,
    ORDER_QUEUE: queue, CONFIG_KV: { get: vi.fn(async () => { throw Error('Callback cannot read stale KV credentials'); }) } } as unknown as Env);
  const observedDb = () => new Proxy(fixture.db, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (key === 'transaction') return async (action: (tx: DbClient) => Promise<unknown>, ...options: unknown[]) => {
        const result = await Reflect.apply(value as (...args: unknown[]) => unknown, target, [async (tx: DbClient) => {
          depth++; try { return await action(tx); } finally { depth--; }
        }, ...options]);
        const hook = afterTransaction; afterTransaction = undefined; await hook?.();
        return result;
      };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DbClient;
  const container = () => createContainerFromDb(observedDb());
  const service = () => new WechatCallbackService(container(), env());
  const receive = (xml = message(), appId = APP, target = service()) => {
    const cipher = encrypted(xml, appId);
    return target.receiveEncrypted('mini', query(cipher), `<xml><Encrypt><![CDATA[${cipher}]]></Encrypt></xml>`);
  };
  const queueBody = (received: { eventId: number; outboxId: number; replayKey: string }): WechatCallbackOutboxMessage =>
    ({ action: 'processWechatCallbackOutbox', eventId: received.eventId, outboxId: received.outboxId, replayKey: received.replayKey });
  const rotate = (appId = OTHER) => fixture.db.update(systemConfig).set({ value: JSON.stringify(appId) }).where(eq(systemConfig.id, 1)).then(() => undefined);
  const rows = () => fixture.db.select().from(wechatCallbackEvent).orderBy(wechatCallbackEvent.id);

  beforeAll(async () => {
    fixture = await financePostgres([systemConfig, wechatCallbackEvent, wechatCallbackOutbox, wechatCallbackWatermark, wechatUser]);
    // The fixture creates actual columns/column PKs; install the real SQL
    // conflict arbiters used by admission and composite watermark publication.
    await fixture.exec('CREATE UNIQUE INDEX wcevt_source_event_uq ON wechat_callback_event (source,event_key)');
    await fixture.exec('CREATE UNIQUE INDEX wcevt_replay_key_uq ON wechat_callback_event (replay_key)');
    await fixture.exec('CREATE UNIQUE INDEX wcout_event_uq ON wechat_callback_outbox (event_id)');
    await fixture.exec('CREATE UNIQUE INDEX wcout_replay_key_uq ON wechat_callback_outbox (replay_key)');
    await fixture.exec('CREATE UNIQUE INDEX wcwm_pkey ON wechat_callback_watermark (source,projection_type,subject_key_hash)');
  }, 30000);
  afterAll(async () => { await fixture.close(); }, 30000);
  afterEach(() => { afterTransaction = undefined; vi.restoreAllMocks(); });
  beforeEach(async () => {
    depth = 0; afterTransaction = undefined; queue.send.mockClear(); queue.sendBatch.mockClear();
    await fixture.db.delete(wechatCallbackWatermark); await fixture.db.delete(wechatCallbackOutbox); await fixture.db.delete(wechatCallbackEvent);
    await fixture.db.delete(wechatUser); await fixture.db.delete(systemConfig);
    await fixture.db.insert(systemConfig).values([
      { id: 1, menuName: 'routine_appId', value: JSON.stringify(APP), sort: 10, isStore: 0 },
      { id: 2, menuName: 'routine_appId', value: JSON.stringify('shadow-app'), sort: -1, isStore: 0 },
      { id: 3, menuName: 'wechat_appid', value: JSON.stringify('official-app'), isStore: 0 },
    ]);
  });

  it('uses the complete SQL public winner without OAuth Secret, APP_KEY or cfg cache and preserves duplicate evidence', async () => {
    const environment = env(), target = new WechatCallbackService(container(), environment);
    expect(await target.verifyChallenge('mini', query(), 'owned-echo')).toBe('owned-echo');
    const cipher = encrypted('encrypted-echo');
    expect(await target.verifyChallenge('mini', query(cipher), cipher)).toBe('encrypted-echo');
    const first = await receive(message(), APP, target), second = await receive(message(), APP, target);
    expect(second).toMatchObject({ eventId: first.eventId, outboxId: first.outboxId, replayKey: first.replayKey, duplicate: true, responseBody: 'success' });
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ appId: APP, source: 'mini', status: 'RECEIVED' });
    expect(await fixture.db.select().from(wechatCallbackOutbox)).toHaveLength(1);
    expect(environment.CONFIG_KV.get).not.toHaveBeenCalled(); expect(queue.sendBatch).not.toHaveBeenCalled();
  });

  it.each(['missing', 'invalid', 'capacity'] as const)('does not fall back to another realm or stale KV on %s public source', async kind => {
    if (kind === 'missing') await fixture.db.update(systemConfig).set({ value: '""' }).where(eq(systemConfig.id, 1));
    if (kind === 'invalid') await fixture.db.update(systemConfig).set({ value: JSON.stringify('x'.repeat(65)) }).where(eq(systemConfig.id, 1));
    if (kind === 'capacity') await fixture.db.insert(systemConfig).values(Array.from({ length: 63 }, (_, index) =>
      ({ id: 100 + index, menuName: 'routine_appId', value: '"shadow"', sort: -2, isStore: 0 })));
    await expect(receive()).rejects.toThrow(); expect(await rows()).toEqual([]);
  });

  it.each(['signature', 'appId', 'deployment-token', 'deployment-aes'] as const)('retains independent callback crypto rejection for %s', async kind => {
    const cipher = encrypted(message(), kind === 'appId' ? OTHER : APP), signed = query(cipher);
    if (kind === 'signature') signed.msgSignature = '0'.repeat(40);
    const environment = env();
    if (kind === 'deployment-token') environment.WECHAT_MINI_CALLBACK_TOKEN = '';
    if (kind === 'deployment-aes') environment.WECHAT_MINI_CALLBACK_AES_KEY = '';
    await expect(new WechatCallbackService(container(), environment).receiveEncrypted('mini', signed, `<xml><Encrypt>${cipher}</Encrypt></xml>`)).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });

  it.each(['AppID', 'ABA', 'shadow'] as const)('rejects %s changes after the actual public snapshot before persistence', async kind => {
    afterTransaction = async () => {
      if (kind === 'shadow') await fixture.db.update(systemConfig).set({ info: 'changed shadow metadata' }).where(eq(systemConfig.id, 2));
      else { await rotate(); if (kind === 'ABA') await rotate(APP); }
    };
    await expect(receive()).rejects.toThrow('配置已变化');
    expect(await rows()).toEqual([]); expect(await fixture.db.select().from(wechatCallbackOutbox)).toEqual([]);
  });

  it('rechecks public source before returning a verified challenge', async () => {
    afterTransaction = () => rotate();
    await expect(service().verifyChallenge('mini', query(), 'owned-echo')).rejects.toThrow('配置已变化');
  });

  it('does not revoke callback admission on an unrelated OAuth Secret change', async () => {
    const source = await readRoutineAppIdSource(container());
    await fixture.db.insert(systemConfig).values({ id: 4, menuName: 'routine_appsecret', value: '"new-secret"', isStore: 0 });
    expect(await readRoutineAppIdSource(container())).toEqual(source);
    await expect(withRoutineAppId(container(), source, async bound => {
      const [row] = await bound.db.select({ appId: systemConfig.value }).from(systemConfig).where(eq(systemConfig.id, 1));
      return row.appId;
    })).resolves.toBe(JSON.stringify(APP));
  });

  it('rolls back the event and outbox if a real SQL trigger changes public source during admission', async () => {
    await fixture.exec(`CREATE FUNCTION callback_test_rotate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE system_config SET value='"${OTHER}"' WHERE id=1; RETURN NEW; END $$;
      CREATE TRIGGER callback_test_rotate AFTER INSERT ON wechat_callback_event FOR EACH ROW EXECUTE FUNCTION callback_test_rotate()`);
    try {
      await expect(receive()).rejects.toThrow('配置已变化');
      expect(await rows()).toEqual([]); expect(await fixture.db.select().from(wechatCallbackOutbox)).toEqual([]);
      expect((await fixture.db.select().from(systemConfig).where(eq(systemConfig.id, 1)))[0].value).toBe(JSON.stringify(APP));
    } finally {
      await fixture.exec('DROP TRIGGER callback_test_rotate ON wechat_callback_event; DROP FUNCTION callback_test_rotate()');
    }
  });

  it('preserves an old verified account after rotation and cannot project Mini subscribe into official users', async () => {
    await fixture.db.insert(wechatUser).values({ uid: 7, openid: 'same-openid', userType: 'wechat', subscribe: 1, isDel: 0 });
    const received = await receive(message('unsubscribe'));
    const before = (await rows())[0]; await rotate();
    await expect(service().processMessage(queueBody(received))).resolves.toBe('completed');
    const after = (await rows())[0];
    expect(after).toMatchObject({ appId: APP, eventKey: before.eventKey, payloadHash: before.payloadHash, subjectKeyHash: before.subjectKeyHash, status: 'IGNORED' });
    expect((await fixture.db.select().from(wechatUser))[0]).toMatchObject({ uid: 7, subscribe: 1, userType: 'wechat' });
  });

  it('isolates watermarks for the same subject across AppIDs without rewriting old event hashes', async () => {
    const first = await receive(message('subscribe', TIME + 100));
    await service().processMessage(queueBody(first)); await rotate();
    const second = await receive(message('subscribe', TIME), OTHER);
    await service().processMessage(queueBody(second));
    const events = await rows(), watermarks = await fixture.db.select().from(wechatCallbackWatermark);
    expect(events.map(row => row.status)).toEqual(['IGNORED', 'IGNORED']);
    expect(events[0].subjectKeyHash).toBe(events[1].subjectKeyHash);
    expect(new Set(watermarks.map(row => row.subjectKeyHash)).size).toBe(2);
    expect(watermarks.map(row => row.lastEventId).sort((a, b) => a - b)).toEqual([first.eventId, second.eventId]);
  });

  it.each([false, true])('uses a legacy watermark only with matching historical last-event AppID (otherAccount=%s)', async otherAccount => {
    const first = await receive(message('subscribe', TIME + 100));
    const original = (await rows())[0];
    await fixture.db.update(wechatCallbackEvent).set({ status: 'IGNORED' }).where(eq(wechatCallbackEvent.id, first.eventId));
    await fixture.db.insert(wechatCallbackWatermark).values({ source: 'mini', projectionType: 'ignored', subjectKeyHash: original.subjectKeyHash,
      lastEventId: original.id, lastEventKey: original.eventKey, lastEventTime: original.eventTime, lastSequenceRank: original.sequenceRank });
    if (otherAccount) await rotate();
    const next = await receive(message('subscribe', TIME), otherAccount ? OTHER : APP);
    await service().processMessage(queueBody(next));
    expect((await rows())[1].status).toBe(otherAccount ? 'IGNORED' : 'SUPERSEDED');
    expect((await fixture.db.select().from(wechatCallbackWatermark).where(eq(wechatCallbackWatermark.subjectKeyHash, original.subjectKeyHash)))[0].lastEventId).toBe(first.eventId);
  });

  it.each([false, true])('keeps active subject leases within the exact AppID (otherAccount=%s)', async otherAccount => {
    const first = await receive(message('subscribe', TIME + 100)); if (otherAccount) await rotate();
    const second = await receive(message('subscribe', TIME), otherAccount ? OTHER : APP);
    await fixture.db.update(wechatCallbackEvent).set({ status: 'PROCESSING', leaseUntil: Math.floor(Date.now() / 1000) + 120 })
      .where(eq(wechatCallbackEvent.id, first.eventId));
    await expect(service().processMessage(queueBody(second))).resolves.toBe(otherAccount ? 'completed' : 'busy');
    expect((await rows())[1].status).toBe(otherAccount ? 'IGNORED' : 'RECEIVED');
  });

  it.each(['funds_order_pay', 'trade_manage_order_settlement'])('retains %s as explicit failed evidence until original-account proof exists', async eventType => {
    const extra = eventType === 'funds_order_pay'
      ? '<order_info><![CDATA[{"trade_no":"old-owned-order","transaction_id":"old-owned-transaction"}]]></order_info>'
      : '<merchant_trade_no>old-owned-order</merchant_trade_no><confirm_receive_method>auto</confirm_receive_method>';
    const received = await receive(message(eventType, TIME, extra)); await rotate();
    await expect(service().processMessage(queueBody(received))).rejects.toThrow('wechat_callback_original_account_evidence_required');
    expect((await rows())[0]).toMatchObject({ appId: APP, status: 'FAILED', lastErrorCode: 'wechat_callback_original_account_evidence_required' });
    expect((await fixture.db.select().from(wechatCallbackOutbox))[0]).toMatchObject({ status: 'FAILED', attemptCount: 1 });
    expect(await fixture.db.select().from(wechatCallbackWatermark)).toEqual([]); expect(queue.sendBatch).not.toHaveBeenCalled();
  });

  it.each([
    ['funds_order_pay', 'legacy'], ['funds_order_pay', 'scoped'],
    ['trade_manage_order_settlement', 'legacy'], ['trade_manage_order_settlement', 'scoped'],
  ] as const)('does not let %s %s watermarks acknowledge an unresolved Mini financial event', async (eventType, namespace) => {
    const extra = eventType === 'funds_order_pay'
      ? '<order_info><![CDATA[{"trade_no":"old-owned-order","transaction_id":"old-owned-transaction"}]]></order_info>'
      : '<merchant_trade_no>old-owned-order</merchant_trade_no><confirm_receive_method>auto</confirm_receive_method>';
    // Represent a historical implementation's already-applied, verified
    // event. Its newer ordering mark cannot supply absent original-account
    // ownership evidence for the newly received callback.
    const prior = await receive(message(eventType, TIME + 100, extra));
    await fixture.db.update(wechatCallbackEvent).set({ status: 'APPLIED' }).where(eq(wechatCallbackEvent.id, prior.eventId));
    await fixture.db.update(wechatCallbackOutbox).set({ status: 'COMPLETED' }).where(eq(wechatCallbackOutbox.id, prior.outboxId));
    const historical = (await rows())[0];
    const scope = namespace === 'legacy' ? historical.subjectKeyHash : createHash('sha256')
      .update(JSON.stringify(['wechat-callback-account-v1', APP, historical.subjectKeyHash])).digest('hex');
    await fixture.db.insert(wechatCallbackWatermark).values({ source: 'mini',
      projectionType: eventType === 'funds_order_pay' ? 'payment' : 'receipt', subjectKeyHash: scope,
      lastEventId: historical.id, lastEventKey: historical.eventKey,
      lastEventTime: historical.eventTime, lastSequenceRank: historical.sequenceRank });
    const previousWatermarks = await fixture.db.select().from(wechatCallbackWatermark);
    const previousOutbox = (await fixture.db.select().from(wechatCallbackOutbox).where(eq(wechatCallbackOutbox.id, prior.outboxId)))[0];
    const received = await receive(message(eventType, TIME, extra));
    const admitted = (await rows())[1];
    expect(admitted.subjectKeyHash).toBe(historical.subjectKeyHash);
    expect(admitted.eventTime).toBeLessThan(historical.eventTime);

    await expect(service().processMessage(queueBody(received))).rejects.toThrow('wechat_callback_original_account_evidence_required');
    const after = await rows();
    expect(after[0]).toEqual(historical);
    expect(after[1]).toMatchObject({ ...admitted, status: 'FAILED', attemptCount: 1, leaseUntil: 0, leaseToken: '',
      lastErrorCode: 'wechat_callback_original_account_evidence_required', updateTime: expect.any(Number) });
    expect(after[1].updateTime).toBeGreaterThanOrEqual(admitted.updateTime);
    expect(await fixture.db.select().from(wechatCallbackWatermark)).toEqual(previousWatermarks);
    expect((await fixture.db.select().from(wechatCallbackOutbox).where(eq(wechatCallbackOutbox.id, prior.outboxId)))[0]).toEqual(previousOutbox);
    expect((await fixture.db.select().from(wechatCallbackOutbox).where(eq(wechatCallbackOutbox.id, received.outboxId)))[0])
      .toMatchObject({ status: 'FAILED', attemptCount: 1, lastErrorCode: 'wechat_callback_original_account_evidence_required' });
    expect(queue.sendBatch).not.toHaveBeenCalled();
  });

  it.skipIf(!native)('refuses new callback admission while the owned independent PG maintenance gate is held', async () => {
    await withFinancePeers(fixture.db, async ([maintenance]) => {
      await maintenance.exec('BEGIN');
      try {
        await maintenance.exec('SELECT pg_advisory_xact_lock(731666,0)');
        await expect(receive()).rejects.toThrow('正在维护');
        expect(await rows()).toEqual([]);
      } finally { await maintenance.exec('ROLLBACK'); }
    });
  });
});
