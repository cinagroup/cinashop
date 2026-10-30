import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { AdminProfileSmsMessage, Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { smsRecord, systemAdmin, systemNotification } from '@/models/schema';
import { getRedis } from '@/utils/cache';
import { ApiErrorCode, AuthException, NotFoundException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { TurnstileService } from '@/services/auth/TurnstileService';
import { secureSixDigitCode, sendAliyunTemplateSms } from '@/services/message/SmsVerificationService';
import { assertAdminAuthoritySession, type AdminAuthorityActor } from './AdminAuthorityWriteService';

const PURPOSE = 'admin_phone_update' as const;
const TTL = 300;
const SMS_LOCK_NAMESPACE = 505_606; // Same budget as every other real SMS producer.
const now = () => Math.floor(Date.now() / 1000);
interface Binding { adminId: number; credentialTag: string; sessionExpiresAt: number }
interface Challenge extends Binding {
  version: 1; purpose: typeof PURPOSE; phone: string; auditIp: string;
  state: 'pending' | 'verified'; expiresAt: number;
}
interface Code extends Binding {
  version: 1; purpose: typeof PURPOSE; phone: string; code: string;
  recordId: number; expiresAt: number;
}
export interface AdminProfileSmsChallenge {
  key: string; expire_time: number; site_key: string; action: typeof PURPOSE;
}
const positiveId = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
const seconds = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function same(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function phone(value: unknown): string {
  if (typeof value !== 'string' || !/^1[3-9]\d{9}$/.test(value)) throw new ValidateException('手机号格式错误');
  return value;
}
function challengeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
    throw new ValidateException('人机验证挑战无效，请重新获取');
  }
  return value;
}
function stableInt(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return hash | 0;
}
async function auditIp(value: string): Promise<string> {
  const ip = value.trim().slice(0, 128), parts = ip.split('.');
  if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return ip;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip || 'unknown'));
  return 'v6' + [...new Uint8Array(hash)].slice(0, 7).map(b => b.toString(16).padStart(2, '0')).join('');
}
function codeKey(b: Binding, value: string): string { return `admin_profile_sms_code:${b.adminId}:${b.credentialTag}:${value}`; }
function challengeKey(key: string): string { return `admin_profile_sms_challenge:${key}`; }
function validBinding(value: Binding): boolean { return positiveId(value.adminId) && hex(value.credentialTag) && seconds(value.sessionExpiresAt); }
function sameBinding(a: Binding, b: Binding): boolean {
  return a.adminId === b.adminId && a.sessionExpiresAt === b.sessionExpiresAt && same(a.credentialTag, b.credentialTag);
}
export function isAdminProfileSmsMessage(value: unknown): value is AdminProfileSmsMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Partial<AdminProfileSmsMessage>;
  return v.action === 'sendAdminProfileSmsVerification' && v.purpose === PURPOSE
    && positiveId(v.recordId) && positiveId(v.adminId) && hex(v.credentialTag)
    && seconds(v.sessionExpiresAt) && seconds(v.expiresAt) && v.expiresAt <= v.sessionExpiresAt
    && typeof v.phone === 'string' && /^1[3-9]\d{9}$/.test(v.phone)
    && typeof v.code === 'string' && /^\d{6}$/.test(v.code)
    && typeof v.templateCode === 'string' && v.templateCode.length > 0 && v.templateCode.length <= 50
    && !('uid' in v);
}

/** All public challenge responses omit the Admin binding. Only authenticated
 * callers can create/status/send; the isolated challenge host needs only its
 * opaque key to render/complete Turnstile. Redis consumption is not a PG write
 * receipt: the profile transaction must still settle its own durable intent. */
export class AdminProfileSmsService {
  constructor(private readonly container: Container, private readonly env: Env,
    private readonly fetcher: typeof fetch = fetch) {}

  private infrastructure(provider = false) {
    if (!this.env.APP_KEY?.trim()) throw new ValidateException('管理员短信绑定尚未配置');
    if (!this.env.UPSTASH_REDIS_URL || !this.env.UPSTASH_REDIS_TOKEN) throw new ValidateException('短信验证缓存尚未配置');
    if (provider && (!this.env.ALIYUN_SMS_ACCESS_KEY_ID || !this.env.ALIYUN_SMS_ACCESS_KEY_SECRET || !this.env.ALIYUN_SMS_SIGN_NAME)) {
      throw new ValidateException('短信服务尚未配置');
    }
    const redis = getRedis(this.env);
    if (!redis) throw new ValidateException('短信验证缓存尚未配置');
    return redis;
  }
  private tag(id: number, auth: string, expiresAt: number): string {
    return createHmac('sha256', this.env.APP_KEY).update(JSON.stringify(['admin-profile-sms:v1', id, auth, expiresAt])).digest('hex');
  }
  private binding(actor: AdminAuthorityActor): Binding {
    assertAdminAuthoritySession(actor);
    return { adminId: actor.id, credentialTag: this.tag(actor.id, actor.authVersion, actor.expiresAt), sessionExpiresAt: actor.expiresAt };
  }
  private async assertLive(binding: Binding, db = this.container.db, lock = false): Promise<void> {
    if (!validBinding(binding) || binding.sessionExpiresAt <= now()) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
    const query = db.select({ pwd: systemAdmin.pwd, adminType: systemAdmin.adminType, relationId: systemAdmin.relationId,
      status: systemAdmin.status, isDel: systemAdmin.isDel }).from(systemAdmin).where(eq(systemAdmin.id, binding.adminId)).limit(1);
    const [live] = await (lock ? query.for('share') : query);
    if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0) {
      throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
    }
    if (!same(this.tag(binding.adminId, md5(live.pwd), binding.sessionExpiresAt), binding.credentialTag)) {
      throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
    }
    if (binding.sessionExpiresAt <= now()) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
  }
  private async readChallenge(keyValue: unknown): Promise<{ key: string; value: Challenge }> {
    const redis = this.infrastructure(), key = challengeId(keyValue);
    const value = await redis.get<Challenge>(challengeKey(key));
    if (!value || value.version !== 1 || value.purpose !== PURPOSE || !validBinding(value)
      || !seconds(value.expiresAt) || value.expiresAt > value.sessionExpiresAt || value.expiresAt <= now()
      || !['pending', 'verified'].includes(value.state) || typeof value.auditIp !== 'string') {
      throw new ValidateException('人机验证挑战已过期，请重新获取');
    }
    phone(value.phone);
    await this.assertLive(value);
    return { key, value };
  }
  private async lock<T>(key: string, work: () => Promise<T>, duration = 15): Promise<T> {
    const redis = this.infrastructure(), token = crypto.randomUUID();
    if (await redis.set(key, token, { nx: true, ex: duration }) !== 'OK') throw new ValidateException('验证正在处理中，请稍后重试');
    try { return await work(); } finally {
      await redis.eval<[string], number>("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", [key], [token]).catch(() => 0);
    }
  }
  async createChallenge(actor: AdminAuthorityActor, phoneValue: unknown, ipValue: string): Promise<AdminProfileSmsChallenge> {
    const redis = this.infrastructure(true), number = phone(phoneValue), binding = this.binding(actor);
    const { siteKey } = new TurnstileService(this.env).publicConfig();
    await this.assertLive(binding);
    const ip = await auditIp(ipValue), minute = Math.floor(Date.now() / 60000);
    const count = await redis.eval<[string], number>("local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]) end; return n",
      [`admin_profile_sms_create:${ip}:${minute}`], ['61']);
    if (Number(count) > 20) throw new ValidateException('人机验证请求过于频繁，请稍后重试');
    await this.assertLive(binding);
    const key = crypto.randomUUID(), expiresAt = Math.min(now() + TTL, binding.sessionExpiresAt);
    const value: Challenge = { ...binding, version: 1, purpose: PURPOSE, phone: number, auditIp: ip, state: 'pending', expiresAt };
    if (await redis.set(challengeKey(key), value, { ex: expiresAt - now() }) !== 'OK') throw new ValidateException('验证码挑战创建失败，请稍后重试');
    return { key, expire_time: Math.ceil((expiresAt - now()) / 60), site_key: siteKey, action: PURPOSE };
  }
  async challengePage(keyValue: unknown): Promise<{ key: string; siteKey: string; action: typeof PURPOSE }> {
    const { key } = await this.readChallenge(keyValue), { siteKey } = new TurnstileService(this.env).publicConfig();
    return { key, siteKey, action: PURPOSE };
  }
  async completeChallenge(keyValue: unknown, tokenValue: unknown, ipValue: string): Promise<{ verified: true; expires_in: number }> {
    const key = challengeId(keyValue);
    return this.lock(`${challengeKey(key)}:lock`, async () => {
      const { value } = await this.readChallenge(key), redis = this.infrastructure();
      if (value.auditIp !== await auditIp(ipValue)) throw new ValidateException('人机验证来源不匹配，请重新获取');
      if (value.state !== 'verified') {
        const attempts = await redis.eval<[string], number>("local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]) end; return n",
          [`${challengeKey(key)}:attempts`], [String(TTL)]);
        if (Number(attempts) > 5) throw new ValidateException('人机验证尝试次数过多，请重新获取');
        await new TurnstileService(this.env, this.fetcher).verify(tokenValue, ipValue, PURPOSE, key);
        await this.assertLive(value);
        if (value.expiresAt <= now()) throw new ValidateException('人机验证挑战已过期，请重新获取');
        if (await redis.set(challengeKey(key), { ...value, state: 'verified' }, { ex: value.expiresAt - now() }) !== 'OK') {
          throw new ValidateException('人机验证状态保存失败，请重试');
        }
      }
      return { verified: true, expires_in: value.expiresAt - now() };
    });
  }
  async challengeStatus(actor: AdminAuthorityActor, keyValue: unknown, ipValue: string): Promise<{ verified: boolean; expires_in: number }> {
    this.infrastructure();
    const binding = this.binding(actor), { value } = await this.readChallenge(keyValue);
    if (!sameBinding(binding, value) || value.auditIp !== await auditIp(ipValue)) throw new ValidateException('人机验证挑战不属于当前会话');
    return { verified: value.state === 'verified', expires_in: value.expiresAt - now() };
  }
  async requestCode(actor: AdminAuthorityActor, phoneValue: unknown, keyValue: unknown, ipValue: string): Promise<{ queued: true; expires_in: number }> {
    this.infrastructure(true);
    const binding = this.binding(actor), number = phone(phoneValue), key = challengeId(keyValue);
    return this.lock(`${challengeKey(key)}:lock`, async () => {
      const { value } = await this.readChallenge(key), ip = await auditIp(ipValue);
      if (!sameBinding(binding, value) || value.phone !== number || value.auditIp !== ip || value.state !== 'verified') {
        throw new ValidateException('请先完成当前会话的人机验证');
      }
      // Consume the verified challenge exactly once, before auditing/queueing.
      // A failed enqueue requires a fresh challenge, never a user-purpose code.
      const redis = this.infrastructure(true);
      if (await redis.del(challengeKey(key)) !== 1) throw new ValidateException('人机验证挑战已失效');
      const templateCode = await this.templateCode();
      const expiresAt = Math.min(now() + TTL, binding.sessionExpiresAt), code = secureSixDigitCode();
      const recordId = await withTx(this.container, async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${SMS_LOCK_NAMESPACE}, 0)`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${SMS_LOCK_NAMESPACE}, ${stableInt(`${number}:${ip}`)})`);
        await this.assertLive(binding, tx, true);
        const timestamp = now(), utc8 = timestamp + 8 * 3600, dayStart = utc8 - utc8 % 86400 - 8 * 3600;
        const [byPhone] = await tx.select({ count: sql<number>`count(*)::int` }).from(smsRecord).where(and(eq(smsRecord.phone, number), gte(smsRecord.addTime, dayStart)));
        const [byIp] = await tx.select({ count: sql<number>`count(*)::int` }).from(smsRecord).where(and(eq(smsRecord.addIp, ip), gte(smsRecord.addTime, dayStart)));
        const [latest] = await tx.select({ time: smsRecord.addTime }).from(smsRecord).where(eq(smsRecord.phone, number)).orderBy(desc(smsRecord.id)).limit(1);
        const [recent] = await tx.select({ count: sql<number>`count(*)::int` }).from(smsRecord).where(gte(smsRecord.addTime, timestamp - 60));
        if (Number(byPhone?.count ?? 0) >= 10) throw new ValidateException('该手机号今日验证码次数已达上限');
        if (Number(byIp?.count ?? 0) >= 50) throw new ValidateException('当前网络今日验证码次数已达上限');
        if (Number(recent?.count ?? 0) >= 20) throw new ValidateException('短信服务当前繁忙，请稍后再试');
        if (latest && timestamp - latest.time < 60) throw new ValidateException('验证码发送过于频繁，请稍后再试');
        if (expiresAt <= now()) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
        const [row] = await tx.insert(smsRecord).values({ uid: `admin:${binding.adminId}`, phone: number,
          content: this.auditContent(binding, expiresAt, number, code, templateCode), addTime: timestamp, addIp: ip, template: templateCode, resultcode: 134 }).returning({ id: smsRecord.id });
        return row.id;
      });
      const message: AdminProfileSmsMessage = { action: 'sendAdminProfileSmsVerification', purpose: PURPOSE,
        ...binding, recordId, expiresAt, phone: number, code, templateCode };
      try { await this.env.ORDER_QUEUE.send(message); } catch {
        await this.container.db.update(smsRecord).set({ resultcode: 130 }).where(eq(smsRecord.id, recordId));
        throw new ValidateException('验证码任务提交失败，请重新验证后重试');
      }
      return { queued: true, expires_in: Math.max(0, expiresAt - now()) };
    });
  }
  /** Pass the profile transaction explicitly: no nested transaction and no
   * claim that a subsequent PG rollback restores this one-time Redis code. */
  async consumeCode(actor: AdminAuthorityActor, phoneValue: unknown, codeValue: unknown, tx?: DbClient): Promise<string> {
    this.infrastructure();
    const binding = this.binding(actor), number = phone(phoneValue);
    if (typeof codeValue !== 'string' || !/^\d{6}$/.test(codeValue)) throw new ValidateException('验证码格式错误');
    const key = codeKey(binding, number);
    return this.lock(`${key}:operation`, async () => {
      const consume = async (db: DbClient) => {
        await this.assertLive(binding, db, true);
        const redis = this.infrastructure(), value = await redis.get<Code>(key);
        if (!value || value.version !== 1 || value.purpose !== PURPOSE || !validBinding(value) || !sameBinding(binding, value)
          || value.phone !== number || !seconds(value.expiresAt) || value.expiresAt > binding.sessionExpiresAt
          || value.expiresAt <= now() || !positiveId(value.recordId) || typeof value.code !== 'string') throw new ValidateException('验证码错误或已过期');
        const attempts = await redis.eval<[string], number>("local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]) end; return n",
          [`${key}:attempts:${value.recordId}`], [String(Math.max(1, value.expiresAt - now()))]);
        if (Number(attempts) > 5) { await redis.del(key); throw new ValidateException('验证码尝试次数过多，请重新获取'); }
        if (!same(value.code, codeValue)) throw new ValidateException('验证码错误或已过期');
        await this.assertLive(binding, db, true);
        if (value.expiresAt <= now()) throw new ValidateException('验证码错误或已过期');
        // Tombstone + deletion are one Redis operation. A queue retry after a
        // PG audit-update failure must never resurrect an already used code.
        const consumed = await redis.eval<[string, string], number>(
          "local raw=redis.call('get',KEYS[1]); if not raw then return 0 end; local v=cjson.decode(raw); if tostring(v.recordId)~=ARGV[1] then return 0 end; redis.call('set',KEYS[2],'1','EX',ARGV[2]); return redis.call('del',KEYS[1])",
          [key, `admin_profile_sms_consumed:${value.recordId}`], [String(value.recordId), String(value.expiresAt - now())]);
        if (Number(consumed) !== 1) throw new ValidateException('验证码错误或已过期');
        return number;
      };
      return tx ? consume(tx) : withTx(this.container, consume);
    }, 30);
  }
  private auditContent(binding: Binding, expiresAt: number, number: string, code: string, template: string) {
    const digest = createHmac('sha256', this.env.APP_KEY).update(JSON.stringify([
      'admin-profile-sms-delivery:v1', binding.adminId, binding.credentialTag, binding.sessionExpiresAt, expiresAt, number, code, template,
    ])).digest('hex');
    return `${PURPOSE}:${digest} (redacted)`;
  }
  async processMessage(message: AdminProfileSmsMessage): Promise<'sent' | 'duplicate' | 'stale'> {
    if (!isAdminProfileSmsMessage(message)) throw new ValidateException('管理员短信任务格式错误');
    this.infrastructure(true);
    return this.lock(`${codeKey(message, message.phone)}:operation`, async () => {
      const [record] = await this.container.db.select().from(smsRecord).where(eq(smsRecord.id, message.recordId)).limit(1);
      if (!record || record.uid !== `admin:${message.adminId}` || record.phone !== message.phone || record.template !== message.templateCode
        || record.content !== this.auditContent(message, message.expiresAt, message.phone, message.code, message.templateCode) || message.expiresAt > record.addTime + TTL) {
        throw new NotFoundException('管理员短信审计记录不匹配');
      }
      if (record.resultcode === 100) return 'duplicate';
      if (record.resultcode === 130) return 'stale';
      if (await this.infrastructure().get(`admin_profile_sms_consumed:${message.recordId}`)) return 'duplicate';
      try { await this.assertLive(message); } catch (error) {
        if (!(error instanceof AuthException)) throw error;
        await this.abandon(message); return 'stale';
      }
      if (message.expiresAt <= now()) { await this.abandon(message); return 'stale'; }
      const fetcher = this.fetcher;
      await sendAliyunTemplateSms(this.env, { phone: message.phone, templateCode: message.templateCode,
        templateParams: { code: message.code }, outId: `admin-profile-sms-${message.recordId}` }, fetcher);
      try { await this.assertLive(message); } catch (error) {
        if (!(error instanceof AuthException)) throw error;
        await this.abandon(message); return 'stale';
      }
      if (message.expiresAt <= now()) { await this.abandon(message); return 'stale'; }
      const redis = this.infrastructure(), key = codeKey(message, message.phone);
      const value: Code = { version: 1, purpose: PURPOSE, adminId: message.adminId, credentialTag: message.credentialTag,
        sessionExpiresAt: message.sessionExpiresAt, phone: message.phone, code: message.code, recordId: message.recordId, expiresAt: message.expiresAt };
      // Publish and the consumption tombstone check must be one Redis operation;
      // this also fences a retry whose process lock expired during an outage.
      const published = Number(await redis.eval<[string, string, string], number>(
        "if redis.call('exists',KEYS[2])==1 then return 0 end; local raw=redis.call('get',KEYS[1]); if raw and tonumber(cjson.decode(raw).recordId)>tonumber(ARGV[1]) then return -1 end; redis.call('set',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1",
        [key, `admin_profile_sms_consumed:${message.recordId}`], [String(message.recordId), JSON.stringify(value), String(message.expiresAt - now())]));
      if (published === 0) return 'duplicate';
      if (published === -1) { await this.abandon(message); return 'stale'; }
      if (published !== 1) throw new ValidateException('验证码保存失败');
      await this.container.db.update(smsRecord).set({ resultcode: 100 }).where(eq(smsRecord.id, message.recordId));
      return 'sent';
    }, 30);
  }
  async abandon(message: AdminProfileSmsMessage): Promise<void> {
    const redis = this.infrastructure(), key = codeKey(message, message.phone), value = await redis.get<Code>(key);
    if (value?.recordId === message.recordId) await redis.del(key);
    await this.container.db.update(smsRecord).set({ resultcode: 130 }).where(and(eq(smsRecord.id, message.recordId), eq(smsRecord.uid, `admin:${message.adminId}`)));
  }
  private async templateCode(): Promise<string> {
    const explicit = this.env.ALIYUN_SMS_VERIFICATION_TEMPLATE_CODE?.trim();
    if (explicit) { if (explicit.length > 50) throw new ValidateException('短信验证码模板配置错误'); return explicit; }
    const [row] = await this.container.db.select({ id: systemNotification.smsId }).from(systemNotification)
      .where(and(eq(systemNotification.mark, 'VERIFICATION_CODE_TIME'), eq(systemNotification.isSms, 1))).orderBy(desc(systemNotification.id)).limit(1);
    const id = row?.id.trim();
    if (!id || id.length > 50) throw new ValidateException('短信验证码模板尚未配置');
    return id;
  }
}
