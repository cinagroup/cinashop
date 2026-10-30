import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminProfileSmsMessage, Env } from '@/env';
import { createContainerFromDb, withTx } from '@/lib/di';
import { smsRecord, systemAdmin, systemNotification, systemRole } from '@/models/schema';
import { adminProfileOperation } from '@/models/schema/adminProfile';
import { ADMIN_PROFILE_SQL } from '@/migrations/adminProfile';
import { AdminProfileService } from '@/services/admin/AdminProfileService';
import { md5 } from '@/utils/jwt';
import { AdminProfileSmsService, isAdminProfileSmsMessage } from '@/services/admin/AdminProfileSmsService';
import { isSmsVerificationMessage, SmsVerificationService } from '@/services/message/SmsVerificationService';
import { prepareOrderQueueDeadLetter } from '@/services/order/OrderQueueDeadLetterService';
import { financeMemoryPostgres } from './helpers/financePostgres';

// Only Redis and remote HTTP ports are replaced. The identity reads, all SMS
// limits/audit queries and transaction rollbacks execute against actual PGlite.
// This proves no provider delivery or native PostgreSQL concurrency by itself.
const cache = vi.hoisted(() => {
  const values = new Map<string, { value: unknown; expires: number }>();
  const get = (key: string) => {
    const value = values.get(key);
    if (value && value.expires <= Date.now()) { values.delete(key); return null; }
    return value ? structuredClone(value.value) : null;
  };
  const redis = {
    get: vi.fn(async (key: string) => get(key)),
    set: vi.fn(async (key: string, value: unknown, options: { ex?: number; nx?: boolean } = {}) => {
      if (options.nx && get(key) !== null) return null;
      if (options.ex !== undefined && options.ex <= 0) throw Error('Invalid real Redis expiry');
      values.set(key, { value: structuredClone(value), expires: options.ex === undefined ? Infinity : Date.now() + options.ex * 1000 }); return 'OK';
    }),
    del: vi.fn(async (key: string) => Number(values.delete(key))),
    eval: vi.fn(async (script: string, keys: string[], args: string[]) => {
      if (script.includes("redis.call('incr'")) {
        const prior = get(keys[0]), next = Number(prior ?? 0) + 1;
        values.set(keys[0], { value: next, expires: prior === null ? Date.now() + Number(args[0]) * 1000 : values.get(keys[0])!.expires }); return next;
      }
      if (script.includes("redis.call('exists'")) {
        if (get(keys[1]) !== null) return 0;
        const current = get(keys[0]) as { recordId: number } | null;
        if (current && current.recordId > Number(args[0])) return -1;
        values.set(keys[0], { value: JSON.parse(args[1]), expires: Date.now() + Number(args[2]) * 1000 }); return 1;
      }
      if (script.includes('cjson.decode')) {
        const value = get(keys[0]) as { recordId?: number } | null;
        if (!value || String(value.recordId) !== args[0]) return 0;
        values.set(keys[1], { value: '1', expires: Date.now() + Number(args[1]) * 1000 }); return Number(values.delete(keys[0]));
      }
      if (get(keys[0]) === args[0]) return Number(values.delete(keys[0]));
      return 0;
    }),
  };
  return { values, get, redis };
});
vi.mock('@/utils/cache', () => ({
  getRedis: () => cache.redis,
  cacheGet: async (key: string) => cache.get(key),
  cacheSet: async (key: string, value: unknown, _env: unknown, ex?: number) => (await cache.redis.set(key, value, { ex })) === 'OK',
  cacheDelete: async (key: string) => Boolean(await cache.redis.del(key)),
}));

const START = Date.parse('2026-10-25T10:00:00Z'), PHONE = '13800138000', IP = '192.0.2.10', PASSWORD = 'fixture-admin-hash';
const tables = [systemAdmin, systemRole, smsRecord, systemNotification];
const queuedResponse: QueueSendResponse = { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
const env = {
  APP_KEY: 'local-profile-sms-hmac-fixture', UPSTASH_REDIS_URL: 'https://fixture.invalid', UPSTASH_REDIS_TOKEN: 'fixture',
  ALIYUN_SMS_ACCESS_KEY_ID: 'fixture-access', ALIYUN_SMS_ACCESS_KEY_SECRET: 'fixture-secret', ALIYUN_SMS_SIGN_NAME: 'fixture-sign',
  ALIYUN_SMS_VERIFICATION_TEMPLATE_CODE: 'SMS_PROFILE_FIXTURE', TURNSTILE_SECRET_KEY: 'fixture-turnstile-secret',
  TURNSTILE_SITE_KEY: 'fixture-site', TURNSTILE_EXPECTED_HOSTNAMES: 'admin.example.test',
  ORDER_QUEUE: { send: vi.fn(async (_message: unknown): Promise<QueueSendResponse> => queuedResponse) },
} as unknown as Env;
const actor = (patch: Record<string, unknown> = {}) => ({ id: 11, authVersion: md5(PASSWORD), expiresAt: Math.floor(START / 1000) + 3600, ...patch });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject }; }

describe('Admin self-phone dedicated SMS identity, real SQL budgets and controlled provider ports', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>, container: ReturnType<typeof createContainerFromDb>, service: AdminProfileSmsService;
  let clock = START, beforeTurnstile: (() => Promise<void>) | undefined, beforeSms: (() => Promise<void>) | undefined;
  const remote = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/turnstile/')) {
      const body = JSON.parse(String(init?.body));
      await beforeTurnstile?.();
      return new Response(JSON.stringify({ success: true, hostname: 'admin.example.test', action: 'admin_phone_update',
        cdata: body.response, challenge_ts: new Date(clock).toISOString() }), { status: 200 });
    }
    if (url !== 'https://dysmsapi.aliyuncs.com/') throw Error('Unexpected external endpoint');
    await beforeSms?.();
    return new Response(JSON.stringify({ Code: 'OK', BizId: 'fixture-biz', RequestId: 'fixture-request' }), { status: 200 });
  });
  beforeAll(async () => {
    f = await financeMemoryPostgres(tables); container = createContainerFromDb(f.db);
    // These two evidence tables are deliberately excluded from f.reset(): the
    // real maintenance SQL makes UPDATE/DELETE/TRUNCATE impossible.
    await f.exec(ADMIN_PROFILE_SQL);
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    service = new AdminProfileSmsService(container, env, remote as typeof fetch);
  }, 30000);
  beforeEach(async () => {
    clock = START; cache.values.clear(); remote.mockClear(); vi.mocked(env.ORDER_QUEUE.send).mockReset().mockResolvedValue(queuedResponse);
    beforeTurnstile = undefined; beforeSms = undefined;
    await f.reset(); await f.db.insert(systemAdmin).values([
      { id: 11, account: 'self-editor', pwd: PASSWORD, level: 1, roles: '' },
      { id: 12, account: 'different-admin', pwd: PASSWORD, level: 1, roles: '' },
    ]);
  });
  afterAll(async () => { vi.restoreAllMocks(); await f?.close(); }, 30000);
  const rows = () => f.db.select().from(smsRecord).orderBy(smsRecord.id);
  async function snapshot() {
    return { rows: Object.fromEntries(await Promise.all([...tables.map(t => getTableConfig(t).name), 'admin_profile_operation', 'admin_profile_avatar'].map(async name => [name,
      Array.from(await f.db.execute(sql.raw(`SELECT * FROM "${name}" ORDER BY 1`)), r => ({ ...r }))]))),
      sequences: Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`), r => ({ ...r })) };
  }
  async function unchanged(work: () => Promise<unknown>) { const before = await snapshot(); try { return await work(); } finally { expect(await snapshot()).toEqual(before); } }
  async function challenge(who = actor(), number = PHONE, ip = IP) {
    const result = await service.createChallenge(who, number, ip);
    await service.completeChallenge(result.key, result.key, ip);
    return result;
  }
  async function queued(who = actor(), number = PHONE, ip = IP) {
    const c = await challenge(who, number, ip);
    await service.requestCode(who, number, c.key, ip);
    const all = vi.mocked(env.ORDER_QUEUE.send).mock.calls;
    return all[all.length - 1][0] as AdminProfileSmsMessage;
  }
  async function sent(who = actor(), number = PHONE) { const message = await queued(who, number); await service.processMessage(message); return message; }
  const smsCalls = () => remote.mock.calls.filter(([url]) => String(url).includes('dysmsapi'));

  it('keeps the phone update capability outside every public user/supplier message and rejects mixed UID payloads', async () => {
    const message = await queued(); expect(isAdminProfileSmsMessage(message)).toBe(true); expect(isSmsVerificationMessage(message)).toBe(false);
    expect(message).not.toHaveProperty('uid'); expect(message).not.toHaveProperty('authVersion'); expect(message.credentialTag).toMatch(/^[a-f0-9]{64}$/);
    expect(message.credentialTag).not.toBe(md5(PASSWORD));
    for (const patch of [{ uid: 0 }, { purpose: 'user_login' }, { adminId: 0 }, { recordId: 0 }, { sessionExpiresAt: '1' },
      { credentialTag: md5(PASSWORD) }, { code: '1e0000' }, { phone: '12000138000' }, { expiresAt: message.sessionExpiresAt + 1 }]) {
      expect(isAdminProfileSmsMessage({ ...message, ...patch })).toBe(false);
    }
  });
  for (const [name, patch] of [
    ['signing key', { APP_KEY: '' }], ['Redis', { UPSTASH_REDIS_TOKEN: '' }], ['SMS provider', { ALIYUN_SMS_SIGN_NAME: '' }],
    ['Turnstile', { TURNSTILE_SECRET_KEY: '' }],
  ] as const) it(`fails closed without ${name} before challenge storage, SMS SQL writes, queue or external I/O`, async () => {
    const broken = new AdminProfileSmsService(container, { ...env, ...patch }, remote as typeof fetch);
    await expect(unchanged(() => broken.createChallenge(actor(), PHONE, IP))).rejects.toThrow();
    expect(cache.values.size).toBe(0); expect(remote).not.toHaveBeenCalled(); expect(env.ORDER_QUEUE.send).not.toHaveBeenCalled();
  });
  for (const patch of [{ id: 0 }, { id: 99 }, { authVersion: '0'.repeat(32) }, { expiresAt: Math.floor(START / 1000) }]) {
    it(`refuses stale/missing Admin identity before creating any challenge ${JSON.stringify(patch)}`, async () => {
      await expect(unchanged(() => service.createChallenge(actor(patch), PHONE, IP))).rejects.toThrow();
      expect(cache.values.size).toBe(0); expect(remote).not.toHaveBeenCalled(); expect(env.ORDER_QUEUE.send).not.toHaveBeenCalled();
    });
  }
  for (const patch of [{ adminType: 2, relationId: 7 }, { status: 0 }, { isDel: 1 }]) it(`rejects current disabled/deleted/nonplatform identity ${JSON.stringify(patch)}`, async () => {
    await f.db.update(systemAdmin).set(patch).where(eq(systemAdmin.id, 11));
    await expect(unchanged(() => service.createChallenge(actor(), PHONE, IP))).rejects.toThrow('身份已变化');
    expect(env.ORDER_QUEUE.send).not.toHaveBeenCalled();
  });
  it('returns only opaque key and public Turnstile configuration; page and pending/status are SQL-read-only', async () => {
    const c = await unchanged(() => service.createChallenge(actor(), PHONE, IP)) as Awaited<ReturnType<typeof service.createChallenge>>;
    expect(Object.keys(c).sort()).toEqual(['action', 'expire_time', 'key', 'site_key']); expect(c).toMatchObject({ action: 'admin_phone_update', site_key: 'fixture-site', expire_time: 5 });
    expect(await unchanged(() => service.challengePage(c.key))).toEqual({ key: c.key, siteKey: 'fixture-site', action: 'admin_phone_update' });
    expect(await unchanged(() => service.challengeStatus(actor(), c.key, IP))).toEqual({ verified: false, expires_in: 300 });
    expect(remote).not.toHaveBeenCalled(); expect(env.ORDER_QUEUE.send).not.toHaveBeenCalled();
  });
  it('does not permit key-only page rendering to send an SMS and will not send a pending challenge', async () => {
    const c = await service.createChallenge(actor(), PHONE, IP);
    await service.challengePage(c.key);
    await expect(unchanged(() => service.requestCode(actor(), PHONE, c.key, IP))).rejects.toThrow('人机验证');
    expect(smsCalls()).toHaveLength(0); expect(env.ORDER_QUEUE.send).not.toHaveBeenCalled(); expect(await rows()).toEqual([]);
  });
  it('verifies the real Turnstile service with separate action/cdata and does not expose the binding', async () => {
    const c = await service.createChallenge(actor(), PHONE, IP);
    const result = await unchanged(() => service.completeChallenge(c.key, c.key, IP));
    expect(result).toEqual({ verified: true, expires_in: 300 });
    expect(await service.challengeStatus(actor(), c.key, IP)).toEqual({ verified: true, expires_in: 300 });
    const body = JSON.parse(String(remote.mock.calls[0][1]?.body)); expect(body.response).toBe(c.key); expect(body.remoteip).toBe(IP);
    expect(body).not.toHaveProperty('credentialTag'); expect(body).not.toHaveProperty('adminId');
  });
  it('rejects incorrect Turnstile cdata and never upgrades or queues that challenge', async () => {
    const c = await service.createChallenge(actor(), PHONE, IP);
    await expect(service.completeChallenge(c.key, crypto.randomUUID(), IP)).rejects.toThrow('挑战不匹配');
    expect((await service.challengeStatus(actor(), c.key, IP)).verified).toBe(false); expect(env.ORDER_QUEUE.send).not.toHaveBeenCalled();
  });
  it('binds status/send to exact actor, deadline, phone and normalized source IP', async () => {
    const c = await challenge();
    for (const [who, number, ip] of [[actor({ id: 12 }), PHONE, IP], [actor({ expiresAt: actor().expiresAt + 1 }), PHONE, IP],
      [actor(), '13900139000', IP], [actor(), PHONE, '192.0.2.11']] as const) {
      await expect(unchanged(() => service.requestCode(who, number, c.key, ip))).rejects.toThrow();
    }
    await expect(service.challengeStatus(actor({ id: 12 }), c.key, IP)).rejects.toThrow();
    await expect(service.completeChallenge(c.key, c.key, '192.0.2.11')).rejects.toThrow('来源不匹配');
    expect(env.ORDER_QUEUE.send).not.toHaveBeenCalled();
  });
  it('rechecks the original credential after remote verification settles and refuses the late completion', async () => {
    const c = await service.createChallenge(actor(), PHONE, IP), gate = deferred<void>(), entered = deferred<void>();
    beforeTurnstile = async () => { entered.resolve(); await gate.promise; };
    const completion = service.completeChallenge(c.key, c.key, IP); await entered.promise;
    await f.db.update(systemAdmin).set({ pwd: 'new-hash' }).where(eq(systemAdmin.id, 11)); gate.resolve();
    await expect(completion).rejects.toThrow('凭据已变化'); expect(env.ORDER_QUEUE.send).not.toHaveBeenCalled();
  });
  it('consumes one verified challenge once and reports queued separately from provider delivery or valid code', async () => {
    const c = await challenge(); expect(await service.requestCode(actor(), PHONE, c.key, IP)).toEqual({ queued: true, expires_in: 300 });
    const message = vi.mocked(env.ORDER_QUEUE.send).mock.calls[0][0] as AdminProfileSmsMessage;
    expect(await rows()).toMatchObject([{ uid: 'admin:11', resultcode: 134, phone: PHONE }]);
    expect((await rows())[0].content).toMatch(/^admin_phone_update:[a-f0-9]{64} \(redacted\)$/); expect(smsCalls()).toHaveLength(0);
    await expect(service.consumeCode(actor(), PHONE, message.code)).rejects.toThrow('错误或已过期');
    await expect(service.requestCode(actor(), PHONE, c.key, IP)).rejects.toThrow('已过期'); expect(env.ORDER_QUEUE.send).toHaveBeenCalledTimes(1);
  });
  it('records failed queue submission without creating a valid code or pretending sent', async () => {
    const c = await challenge(); vi.mocked(env.ORDER_QUEUE.send).mockRejectedValueOnce(Error('queue offline'));
    await expect(service.requestCode(actor(), PHONE, c.key, IP)).rejects.toThrow('任务提交失败');
    expect(await rows()).toMatchObject([{ uid: 'admin:11', resultcode: 130 }]); expect(smsCalls()).toHaveLength(0);
    await expect(service.requestCode(actor(), PHONE, c.key, IP)).rejects.toThrow('已过期');
  });
  it('uses the actual Aliyun signer with redacted audit, then publishes one code and marks sent exactly once', async () => {
    const message = await queued(); expect(await service.processMessage(message)).toBe('sent');
    expect(smsCalls()).toHaveLength(1); const body = new URLSearchParams(String(smsCalls()[0][1]?.body));
    expect(body.get('Action')).toBe('SendSms'); expect(body.get('PhoneNumbers')).toBe(PHONE);
    expect(JSON.parse(body.get('TemplateParam')!)).toEqual({ code: message.code }); expect(body.get('Signature')).toBeTruthy();
    expect(await rows()).toMatchObject([{ resultcode: 100 }]);
    expect(await service.processMessage(message)).toBe('duplicate'); expect(smsCalls()).toHaveLength(1);
    expect(await service.consumeCode(actor(), PHONE, message.code)).toBe(PHONE);
    await expect(service.consumeCode(actor(), PHONE, message.code)).rejects.toThrow('错误或已过期');
  });
  it('does not turn a rejected provider result into a consumable code or a sent audit', async () => {
    const message = await queued(); const failed = new AdminProfileSmsService(container, env, vi.fn(async () => new Response(JSON.stringify({ Code: 'isv.BUSINESS_LIMIT_CONTROL' }))) as typeof fetch);
    await expect(failed.processMessage(message)).rejects.toThrow('Aliyun SMS rejected');
    expect(await rows()).toMatchObject([{ resultcode: 134 }]); await expect(service.consumeCode(actor(), PHONE, message.code)).rejects.toThrow();
  });
  for (const patch of [{ pwd: 'changed' }, { status: 0 }, { isDel: 1 }, { adminType: 2, relationId: 7 }]) it(`drops a queued task after live identity mutation ${JSON.stringify(patch)}`, async () => {
    const message = await queued(); await f.db.update(systemAdmin).set(patch).where(eq(systemAdmin.id, 11));
    expect(await service.processMessage(message)).toBe('stale'); expect(smsCalls()).toHaveLength(0); expect(await rows()).toMatchObject([{ resultcode: 130 }]);
  });
  it('does not publish a valid code after credentials change while Aliyun is in flight', async () => {
    const message = await queued(), gate = deferred<void>(), entered = deferred<void>();
    beforeSms = async () => { entered.resolve(); await gate.promise; };
    const delivery = service.processMessage(message); await entered.promise;
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 11)); gate.resolve();
    expect(await delivery).toBe('stale'); expect(await rows()).toMatchObject([{ resultcode: 130 }]);
    await expect(service.consumeCode(actor(), PHONE, message.code)).rejects.toThrow('凭据已变化');
  });
  it('limits every challenge and code to the authenticated session deadline, including equality at expiry', async () => {
    const who = actor({ expiresAt: Math.floor(START / 1000) + 40 }), c = await challenge(who);
    const r = await service.requestCode(who, PHONE, c.key, IP); expect(r.expires_in).toBe(40);
    const message = vi.mocked(env.ORDER_QUEUE.send).mock.calls[0][0] as AdminProfileSmsMessage; expect(message.expiresAt).toBe(who.expiresAt);
    clock += 40000; expect(await service.processMessage(message)).toBe('stale'); expect(smsCalls()).toHaveLength(0);
    await expect(service.consumeCode(who, PHONE, message.code)).rejects.toThrow('已过期');
  });
  it('never accepts a user-login UID0 code, another actor, another session or another phone as Admin authorization', async () => {
    const message = await sent(); cache.values.set(`user_verification_code_user_login_${PHONE}`, { value: { uid: 0, code: message.code, purpose: 'user_login' }, expires: clock + 300000 });
    for (const [who, number] of [[actor({ id: 12 }), PHONE], [actor({ expiresAt: actor().expiresAt + 1 }), PHONE], [actor(), '13900139000']] as const) {
      await expect(unchanged(() => service.consumeCode(who, number, message.code))).rejects.toThrow();
    }
    const adminKeys = [...cache.values.keys()].filter(key => key.startsWith('admin_profile_sms_code:') && !key.includes(':attempts:'));
    cache.values.delete(adminKeys[0]); await expect(service.consumeCode(actor(), PHONE, message.code)).rejects.toThrow('错误或已过期');
    expect(cache.get(`user_verification_code_user_login_${PHONE}`)).toBeTruthy();
  });
  it('caps online guessing and retires the code even when the sixth attempt is correct', async () => {
    const message = await sent(), wrong = message.code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) await expect(service.consumeCode(actor(), PHONE, wrong)).rejects.toThrow('错误或已过期');
    await expect(service.consumeCode(actor(), PHONE, message.code)).rejects.toThrow('尝试次数过多');
    await expect(service.consumeCode(actor(), PHONE, message.code)).rejects.toThrow('错误或已过期');
  });
  it('supports the caller transaction without nested SQL transactions and does not claim rollback restores OTP', async () => {
    const message = await sent(), before = await snapshot();
    await expect(withTx(container, async tx => {
      expect(await service.consumeCode(actor(), PHONE, message.code, tx)).toBe(PHONE);
      await tx.update(systemAdmin).set({ phone: PHONE }).where(eq(systemAdmin.id, 11)); throw Error('profile rejection after consume');
    })).rejects.toThrow('profile rejection');
    expect(await snapshot()).toEqual(before); await expect(service.consumeCode(actor(), PHONE, message.code)).rejects.toThrow('错误或已过期');
  });
  it('keeps consumed-code tombstones across an audit retry and cannot resurrect a code', async () => {
    const message = await sent(); await service.consumeCode(actor(), PHONE, message.code);
    // Represent a previous successful send whose final PG audit status was not
    // durably acknowledged, without replacing any production SQL/provider code.
    await f.db.update(smsRecord).set({ resultcode: 134 }).where(eq(smsRecord.id, message.recordId));
    expect(await service.processMessage(message)).toBe('duplicate'); expect(smsCalls()).toHaveLength(1);
    await expect(service.consumeCode(actor(), PHONE, message.code)).rejects.toThrow('错误或已过期');
  });
  it('authenticates the complete queue issuance against the persisted redacted HMAC audit', async () => {
    const message = await queued();
    for (const patch of [{ code: message.code === '000000' ? '000001' : '000000' }, { phone: '13900139000' }, { templateCode: 'SMS_OTHER' }, { expiresAt: message.expiresAt - 1 }]) {
      await expect(unchanged(() => service.processMessage({ ...message, ...patch }))).rejects.toThrow('审计记录不匹配');
    }
    expect(smsCalls()).toHaveLength(0); expect(await service.processMessage(message)).toBe('sent');
  });
  it('never lets late abandon of an older issuance erase the current code', async () => {
    const old = await sent(); clock += 61000; const current = await sent();
    await service.abandon(old); expect(await service.consumeCode(actor(), PHONE, current.code)).toBe(PHONE);
  });
  it('shares phone cooldown and daily budgets with pre-existing user/supplier SMS audit rows', async () => {
    await f.db.insert(smsRecord).values({ uid: '0', phone: PHONE, addIp: IP, addTime: Math.floor(clock / 1000), resultcode: 100 });
    const c = await challenge(); await expect(unchanged(() => service.requestCode(actor(), PHONE, c.key, IP))).rejects.toThrow('过于频繁');
    clock += 61000;
    await f.db.insert(smsRecord).values(Array.from({ length: 9 }, (_, i) => ({ uid: '123', phone: PHONE, addIp: '192.0.2.20', addTime: Math.floor(clock / 1000) - 100 - i, resultcode: 130 })));
    const next = await challenge(); await expect(unchanged(() => service.requestCode(actor(), PHONE, next.key, IP))).rejects.toThrow('今日验证码次数已达上限');
    expect(env.ORDER_QUEUE.send).not.toHaveBeenCalled();
  });
  it('shares the IP and global SMS budgets instead of offering an Admin bypass', async () => {
    await f.db.insert(smsRecord).values(Array.from({ length: 20 }, (_, i) => ({ uid: '0', phone: `139${String(i).padStart(8, '0')}`, addIp: '192.0.2.90', addTime: Math.floor(clock / 1000) - 1, resultcode: 100 })));
    let c = await challenge(); await expect(unchanged(() => service.requestCode(actor(), PHONE, c.key, IP))).rejects.toThrow('繁忙');
    clock += 61000;
    await f.db.insert(smsRecord).values(Array.from({ length: 50 }, (_, i) => ({ uid: 'other', phone: `137${String(i).padStart(8, '0')}`, addIp: IP, addTime: Math.floor(clock / 1000) - 100, resultcode: 130 })));
    c = await challenge(); await expect(unchanged(() => service.requestCode(actor(), PHONE, c.key, IP))).rejects.toThrow('当前网络今日');
    expect(env.ORDER_QUEUE.send).not.toHaveBeenCalled();
  });
  it('uses the configured notification template only when the explicit template is absent', async () => {
    await f.db.insert(systemNotification).values({ mark: 'VERIFICATION_CODE_TIME', isSms: 1, smsId: 'SMS_FROM_DATABASE' });
    const fallback = new AdminProfileSmsService(container, { ...env, ALIYUN_SMS_VERIFICATION_TEMPLATE_CODE: undefined }, remote as typeof fetch);
    const c = await challenge(); await fallback.requestCode(actor(), PHONE, c.key, IP);
    const message = vi.mocked(env.ORDER_QUEUE.send).mock.calls[0][0] as AdminProfileSmsMessage; expect(message.templateCode).toBe('SMS_FROM_DATABASE');
    expect(smsCalls()).toHaveLength(0);
  });
  it('archives the Admin message as sensitive/non-replayable with no phone, code or credential binding', async () => {
    const message = await queued(), result = prepareOrderQueueDeadLetter(message);
    expect(result.replayPolicy).toBe('BLOCK_SENSITIVE'); expect(result).not.toHaveProperty('replayMessage');
    const text = JSON.stringify(result.body); expect(text).not.toContain(message.code); expect(text).not.toContain(message.phone); expect(text).not.toContain(message.credentialTag);
    expect(result.body).toMatchObject({ adminId: 11, recordId: message.recordId, purpose: 'admin_phone_update' });
    expect(Object.keys(result.body as object).sort()).toEqual(['action', 'adminId', 'code', 'phone', 'purpose', 'recordId']);
  });
  it('cannot route the new Admin purpose through the existing public user SMS consumer', async () => {
    const message = await sent(), publicService = new SmsVerificationService(container, env);
    await expect(publicService.consumeUserCode('user_login', PHONE, message.code)).rejects.toThrow('验证码错误或已过期');
    expect(await service.consumeCode(actor(), PHONE, message.code)).toBe(PHONE);
  });
  it('commits the complete challenge→provider→phone-profile chain with one owner receipt and safe same-UUID replay', async () => {
    const message = await sent(), profile = new AdminProfileService(container, env), info = await profile.info(actor());
    const input = { operation_id: 'f0000000-0000-4000-8000-000000000001', operation: 'phone', revision: info.revision,
      payload: { phone: PHONE, code: message.code } };
    const result = await profile.commit(input, actor());
    expect(result).toEqual({ operation_id: input.operation_id, actor_id: 11, operation: 'phone', state: 'committed' });
    expect((await profile.info(actor())).phone).toBe(PHONE);
    const committed = await snapshot();
    expect(await profile.receipt(input.operation_id, 'phone', actor())).toEqual(result);
    expect(await profile.commit(input, actor())).toEqual(result); expect(await snapshot()).toEqual(committed);
    const [row] = await f.db.select().from(adminProfileOperation).where(eq(adminProfileOperation.operationId, input.operation_id));
    expect(row.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(row).sort()).toEqual(['actorId', 'createdAt', 'operation', 'operationId', 'requestHash', 'state']);
    await expect(service.consumeCode(actor(), PHONE, message.code)).rejects.toThrow('错误或已过期'); expect(smsCalls()).toHaveLength(1);
  });
  it('rolls back the actual profile PG write/receipt after OTP consumption without resurrecting that OTP', async () => {
    const message = await sent(), profile = new AdminProfileService(container, env), info = await profile.info(actor());
    const input = { operation_id: 'f0000000-0000-4000-8000-000000000002', operation: 'phone', revision: info.revision,
      payload: { phone: PHONE, code: message.code } };
    const before = await snapshot();
    await f.exec("CREATE FUNCTION public.profile_phone_sms_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture phone write rejected'; END $$; CREATE TRIGGER profile_phone_sms_reject BEFORE UPDATE ON system_admin FOR EACH ROW EXECUTE FUNCTION public.profile_phone_sms_reject()");
    try { await expect(profile.commit(input, actor())).rejects.toThrow(); }
    finally { await f.exec('DROP TRIGGER profile_phone_sms_reject ON system_admin; DROP FUNCTION public.profile_phone_sms_reject()'); }
    expect(await snapshot()).toEqual(before);
    expect(await profile.receipt(input.operation_id, 'phone', actor())).toEqual({ operation_id: input.operation_id, actor_id: 11, operation: 'phone', state: 'unknown' });
    await expect(profile.commit(input, actor())).rejects.toThrow('错误或已过期');
    expect((await profile.info(actor())).phone).toBe(''); expect(smsCalls()).toHaveLength(1);
    expect(await profile.receipt(input.operation_id, 'phone', actor(), true)).toMatchObject({ state: 'not_applied' });
    await expect(profile.commit(input, actor())).rejects.toThrow('封存');
  });
  it('rejects a stale profile revision before consuming SMS authorization, then permits an explicit fresh intent', async () => {
    const message = await sent(), profile = new AdminProfileService(container, env), info = await profile.info(actor());
    await f.db.update(systemAdmin).set({ realName: 'changed other' }).where(eq(systemAdmin.id, 11));
    const old = { operation_id: 'f0000000-0000-4000-8000-000000000003', operation: 'phone', revision: info.revision,
      payload: { phone: PHONE, code: message.code } };
    await expect(unchanged(() => profile.commit(old, actor()))).rejects.toThrow('资料已变化');
    expect(await profile.receipt(old.operation_id, 'phone', actor(), true)).toMatchObject({ state: 'not_applied' });
    const fresh = { ...old, operation_id: 'f0000000-0000-4000-8000-000000000004', revision: (await profile.info(actor())).revision };
    expect(await profile.commit(fresh, actor())).toMatchObject({ state: 'committed' });
    expect((await profile.info(actor())).phone).toBe(PHONE); expect(smsCalls()).toHaveLength(1);
  });
});
