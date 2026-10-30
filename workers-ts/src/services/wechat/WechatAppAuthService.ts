import type { Env } from '@/env';
import type { Container } from '@/lib/di';
import { LoginService } from '@/services/user/LoginService';
import { SmsVerificationService } from '@/services/message/SmsVerificationService';
import { evaluateAgentLevelsAfterRegistration } from '@/services/agent/AgentLevelRegistrationEffects';
import { cacheGet, cacheSetIfAbsent, cacheTake, clearToken, getRedis } from '@/utils/cache';
import { md5 } from '@/utils/jwt';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { WechatAuthService, type VerifiedSocialIdentity } from './WechatAuthService';
import { readNativeAppCredentials, withNativeAppCredentials, type NativeAppCredentials } from './NativeAppRuntimeConfig';
import { nativeAppAuthObject, parseNativeAppAuthComplete, parseNativeAppAuthPhone,
  type NativeAppAuthComplete, type NativeAppAuthPhone } from './NativeAppAuthInput';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';

const STATE_TTL = 5 * 60, CODE_TTL = 10 * 60, PENDING_TTL = 10 * 60;
const STATE_PREFIX = 'native_app_oauth_state_v1:';
const CODE_PREFIX = 'native_app_oauth_code_used_v1:';
const PENDING_PREFIX = 'native_app_oauth_phone_v1:';
const RESPONSE_BYTES = 32 * 1024, PROVIDER_BUDGET_MS = 8_000, RATE = 30;
type NativeIdentity = VerifiedSocialIdentity & { userType: 'app' };
interface StateRecord { version: 1; purpose: 'native_app_oauth'; issuedAt: number; expiresAt: number; auditIp: string; stamp: string }
interface PendingRecord { version: 1; purpose: 'native_app_oauth_phone'; issuedAt: number; expiresAt: number; auditIp: string; stamp: string; identity: NativeIdentity }
export type NativeAppAuthResult = { token: string; exp_time: number; uid: number } | { need_phone: true; key: string; expiresIn: number };
const now = () => Math.floor(Date.now() / 1000);
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
const auditIp = async (ip: string) => (await hash(ip.trim().slice(0, 128) || 'unknown')).slice(0, 24);
const invalidState = () => new ValidateException('原生App授权状态无效、已使用或已过期，请重新授权');
const invalidPending = () => new ValidateException('原生App手机号续绑凭据无效、已使用或已过期，请重新授权');
const validStamp = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const asciiId = (value: unknown, max: number): value is string => typeof value === 'string' && new RegExp('^[A-Za-z0-9_-]{1,' + max + '}$', 'u').test(value);

/** Independent App credential realm and one-use capability namespace. Provider
 * access/refresh tokens and bodies never enter pending storage or responses.
 * Provider I/O finishes before the shared SQL credential fence is acquired. */
export class WechatAppAuthService {
  constructor(private readonly container: Container, private readonly env: Env) {}

  private async stored<T>(action: () => Promise<T>): Promise<T> {
    if (!getRedis(this.env)) throw new ServiceUnavailableException('原生App授权状态存储不可用');
    try { return await action(); }
    catch { throw new ServiceUnavailableException('原生App授权状态存储不可用'); }
  }
  private async rate(kind: 'state' | 'complete' | 'phone', ip: string): Promise<void> {
    const redis = getRedis(this.env);
    if (!redis) throw new ServiceUnavailableException('原生App授权状态存储不可用');
    const key = 'native_app_oauth_rate_v1:' + kind + ':' + await auditIp(ip) + ':' + Math.floor(Date.now() / 60_000);
    const count = await this.stored(() => redis.eval<[string], number>(
      "local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]) end; return n", [key], ['61']));
    if (!Number.isSafeInteger(count) || count < 1) throw new ServiceUnavailableException('原生App授权限流状态无效');
    if (count > RATE) throw new ValidateException('原生App授权请求过于频繁，请稍后重试');
  }
  private providerCredentials(value: NativeAppCredentials): NativeAppCredentials {
    // Authoring accepts optional arbitrary text. Only the actual provider
    // boundary applies its safe public-ID and nonempty single-line secret needs.
    // There is no website Open18/Secret256 policy or fallback realm here.
    if (!asciiId(value.appId, 32) || !value.secret || [...value.secret].length > 5000 || !value.secret.trim()
      || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value.secret))
      throw new ServiceUnavailableException('原生App微信登录凭据不适用于授权接口，请维护配置');
    return value;
  }
  private async credentials(stamp?: string): Promise<NativeAppCredentials> {
    const value = this.providerCredentials(await readNativeAppCredentials(this.container, this.env));
    if (stamp !== undefined && value.stamp !== stamp) throw new ValidateException('原生App微信配置已变化，请重新授权');
    return value;
  }

  async createState(ip = ''): Promise<{ state: string; verifier: string; appId: string; expiresIn: number }> {
    await this.rate('state', ip);
    const credentials = await this.credentials(), state = crypto.randomUUID(), verifier = randomHex(), issuedAt = now();
    const verifierHash = await hash(verifier);
    const record: StateRecord = { version: 1, purpose: 'native_app_oauth', issuedAt, expiresAt: issuedAt + STATE_TTL,
      auditIp: await auditIp(ip), stamp: credentials.stamp };
    const ok = await this.stored(() => cacheSetIfAbsent(STATE_PREFIX + state + ':' + verifierHash, record, this.env, STATE_TTL));
    if (!ok) throw new ValidateException('原生App授权状态创建失败，请重试');
    return { state, verifier, appId: credentials.appId, expiresIn: STATE_TTL };
  }

  private state(value: unknown, source: string): StateRecord {
    try {
      const row = nativeAppAuthObject(value, ['version', 'purpose', 'issuedAt', 'expiresAt', 'auditIp', 'stamp']);
      if (row.version !== 1 || row.purpose !== 'native_app_oauth' || row.auditIp !== source || !validStamp(row.stamp)
        || typeof row.issuedAt !== 'number' || !Number.isSafeInteger(row.issuedAt) || row.issuedAt <= 0
        || row.expiresAt !== row.issuedAt + STATE_TTL || row.issuedAt > now() + 30 || Number(row.expiresAt) <= now()) throw invalidState();
      return row as unknown as StateRecord;
    } catch { throw invalidState(); }
  }
  private identity(value: unknown): NativeIdentity {
    const row = nativeAppAuthObject(value, ['openid', 'unionid', 'userType', 'nickname', 'avatar', 'sex']);
    if (!asciiId(row.openid, 100) || typeof row.unionid !== 'string' || row.unionid !== '' && !asciiId(row.unionid, 30)
      || row.userType !== 'app' || typeof row.nickname !== 'string' || [...row.nickname].length > 60
      || typeof row.avatar !== 'string' || [...row.avatar].length > 256 || ![0, 1, 2].includes(Number(row.sex))
      || typeof row.sex !== 'number' || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(row.nickname + row.avatar)) throw invalidPending();
    return { openid: row.openid, unionid: row.unionid, userType: 'app', nickname: row.nickname, avatar: row.avatar, sex: row.sex };
  }
  private pending(value: unknown, source: string): PendingRecord {
    try {
      const row = nativeAppAuthObject(value, ['version', 'purpose', 'issuedAt', 'expiresAt', 'auditIp', 'stamp', 'identity']);
      if (row.version !== 1 || row.purpose !== 'native_app_oauth_phone' || row.auditIp !== source || !validStamp(row.stamp)
        || typeof row.issuedAt !== 'number' || !Number.isSafeInteger(row.issuedAt) || row.issuedAt <= 0
        || row.expiresAt !== row.issuedAt + PENDING_TTL || row.issuedAt > now() + 30 || Number(row.expiresAt) <= now()) throw invalidPending();
      return { version: 1, purpose: 'native_app_oauth_phone', issuedAt: row.issuedAt, expiresAt: Number(row.expiresAt),
        auditIp: source, stamp: row.stamp, identity: this.identity(row.identity) };
    } catch { throw invalidPending(); }
  }

  async login(inputValue: NativeAppAuthComplete, ip = ''): Promise<NativeAppAuthResult> {
    const input = parseNativeAppAuthComplete(inputValue);
    await this.rate('complete', ip);
    const verifierHash = await hash(input.verifier), source = await auditIp(ip);
    const state = this.state(await this.stored(() => cacheTake<unknown>(STATE_PREFIX + input.state + ':' + verifierHash, this.env)), source);
    const credentials = await this.credentials(state.stamp);
    // Claim before transport, including failed/ambiguous provider responses.
    const codeKey = CODE_PREFIX + await hash(credentials.appId + '\0' + input.code);
    if (!await this.stored(() => cacheSetIfAbsent(codeKey, { version: 1, usedAt: now() }, this.env, CODE_TTL)))
      throw new ValidateException('原生App授权code已使用，请重新授权');
    const identity = await this.exchange(input.code, credentials);
    return this.commit(identity, credentials.stamp, verifierHash, source, ip);
  }
  async completePhone(inputValue: NativeAppAuthPhone, ip = ''): Promise<NativeAppAuthResult> {
    const input = parseNativeAppAuthPhone(inputValue);
    await this.rate('phone', ip);
    const verifierHash = await hash(input.verifier), source = await auditIp(ip), key = PENDING_PREFIX + input.key + ':' + verifierHash;
    const preview = this.pending(await this.stored(() => cacheGet<unknown>(key, this.env)), source);
    await this.credentials(preview.stamp);
    // Wrong realm/verifier/stamp/age fails before the independent SMS is spent.
    await new SmsVerificationService(this.container, this.env).consumeUserCode('user_social_binding', input.phone, input.captcha);
    const consumed = this.pending(await this.stored(() => cacheTake<unknown>(key, this.env)), source);
    if (JSON.stringify(preview) !== JSON.stringify(consumed)) throw invalidPending();
    return this.commit(consumed.identity, consumed.stamp, verifierHash, source, ip, input.phone);
  }

  private async commit(identity: NativeIdentity, stamp: string, verifierHash: string, source: string, ip: string, phone?: string): Promise<NativeAppAuthResult> {
    let issuedToken = '', committedUid = 0;
    let result: NativeAppAuthResult;
    try {
      const nonce = crypto.randomUUID();
      result = await withNativeAppCredentials(this.container, this.env, stamp, async bound => {
        const auth = new WechatAuthService(bound, this.env);
        if (!phone && await auth.nativeAppPhoneBindingRequired(identity)) {
          const key = crypto.randomUUID(), issuedAt = now();
          const pending: PendingRecord = { version: 1, purpose: 'native_app_oauth_phone', issuedAt, expiresAt: issuedAt + PENDING_TTL,
            auditIp: source, stamp, identity };
          if (!await this.stored(() => cacheSetIfAbsent(PENDING_PREFIX + key + ':' + verifierHash, pending, this.env, PENDING_TTL)))
            throw new ServiceUnavailableException('原生App手机号续绑状态保存失败，请重新授权');
          return { need_phone: true as const, key, expiresIn: PENDING_TTL };
        }
        const uid = await auth.reconcileVerifiedIdentity({ ...identity, ...(phone ? { phone } : {}) });
        const issued = await new LoginService(bound, this.env).loginByVerifiedUid(uid, ip, undefined, token => { issuedToken = token; }, nonce, true);
        committedUid = uid;
        return { token: issued.token, exp_time: issued.expires_time, uid };
      });
    } catch (error) {
      if (issuedToken) {
        try { await clearToken(md5(issuedToken), this.env); }
        catch { throw new ServiceUnavailableException('原生App登录提交失败，登录状态撤销未确认，请重新授权'); }
      }
      throw error;
    }
    if (committedUid) await evaluateAgentLevelsAfterRegistration(this.container, committedUid);
    return result;
  }

  private async exchange(code: string, config: NativeAppCredentials): Promise<NativeIdentity> {
    const deadline = Date.now() + PROVIDER_BUDGET_MS;
    const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
    url.search = new URLSearchParams({ appid: config.appId, secret: config.secret, code, grant_type: 'authorization_code' }).toString();
    const token = await this.providerJson(url, deadline);
    await this.credentials(config.stamp);
    if (token.errcode !== undefined && token.errcode !== 0 || !asciiId(token.openid, 100)
      || typeof token.access_token !== 'string' || !/^[\x21-\x7e]{1,4096}$/u.test(token.access_token)
      || token.scope !== 'snsapi_userinfo' || typeof token.expires_in !== 'number' || !Number.isSafeInteger(token.expires_in)
      || token.expires_in <= 0 || token.expires_in > 86400 || token.unionid !== undefined && !asciiId(token.unionid, 30)
      || token.appid !== undefined && token.appid !== config.appId) throw new ValidateException('原生App微信授权返回身份无效');
    const identity: NativeIdentity = { openid: token.openid, unionid: typeof token.unionid === 'string' ? token.unionid : '', userType: 'app', nickname: '', avatar: '', sex: 0 };
    // User-info is optional enrichment; an unavailable endpoint cannot replace
    // token identity. A returned contradictory identity is always a hard error.
    const info = new URL('https://api.weixin.qq.com/sns/userinfo');
    info.search = new URLSearchParams({ access_token: token.access_token, openid: token.openid, lang: 'zh_CN' }).toString();
    let profile: Record<string, unknown>;
    try { profile = await this.providerJson(info, deadline); }
    catch (error) { if (!(error instanceof ServiceUnavailableException)) throw error; return identity; }
    await this.credentials(config.stamp);
    if (profile.errcode !== undefined && profile.errcode !== 0) return identity;
    if (profile.openid !== identity.openid || profile.unionid !== undefined && !asciiId(profile.unionid, 30)
      || identity.unionid && profile.unionid !== undefined && profile.unionid !== identity.unionid)
      throw new ValidateException('原生App微信用户资料与授权身份不一致');
    if (profile.unionid !== undefined) identity.unionid = profile.unionid as string;
    for (const [key, max] of [['nickname', 60], ['headimgurl', 256]] as const) {
      const value = profile[key];
      if (value !== undefined && (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)))
        throw new ValidateException('原生App微信用户资料无效');
      if (typeof value === 'string') identity[key === 'nickname' ? 'nickname' : 'avatar'] = [...value].slice(0, max).join('');
    }
    if (profile.sex !== undefined && (typeof profile.sex !== 'number' || ![0, 1, 2].includes(profile.sex))) throw new ValidateException('原生App微信用户资料无效');
    identity.sex = typeof profile.sex === 'number' ? profile.sex : 0;
    return identity;
  }
  private async providerJson(url: URL, deadline: number): Promise<Record<string, unknown>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ServiceUnavailableException('原生App微信授权服务超时，请重新授权');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(url.toString(), { method: 'GET', redirect: 'error', signal: controller.signal });
      const declared = response.headers.get('content-length');
      if (!response.ok || response.redirected || !response.body || declared !== null
        && (!/^\d+$/u.test(declared) || Number(declared) > RESPONSE_BYTES)) throw Error('unavailable');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > RESPONSE_BYTES || Date.now() > deadline) throw Error('bounded');
          chunks.push(next.value);
        }
      } catch (error) { try { await reader.cancel(); } catch { /* no response body is retained */ } throw error; }
      if (Date.now() > deadline) throw Error('deadline');
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const parsed = parseLevelActivationJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('object');
      return parsed as Record<string, unknown>;
    } catch { throw new ServiceUnavailableException('原生App微信授权服务暂时不可用，请重新授权'); }
    finally { clearTimeout(timer); }
  }
}
