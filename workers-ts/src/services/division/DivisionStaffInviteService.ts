import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { qrcode, user } from '@/models/schema';
import { AuthException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { cacheGet, cacheSet } from '@/utils/cache';
import { legacyShareDataImage, legacyShareImage, type LegacyShareImage } from '@/services/other/LegacyShareCodeProtocol';
import { WechatMiniProgramCodeService } from '@/services/wechat/WechatMiniProgramCodeService';
import { assertDivisionStaffActor, assertDivisionStaffAgent } from './DivisionStaffService';
import { staffInteger, type DivisionStaffActor } from './DivisionStaffInput';
import { DIVISION_STAFF_INVITE_PAGE, DIVISION_STAFF_INVITE_TTL, readDivisionStaffWechatCredentials } from './DivisionStaffInvitePolicy';

const ROLE_LOCK_NAMESPACE = 1147879249;
interface InviteSnapshot { uid: number; qrId: number; appId: string; revision: string }
interface CachedInvite { version: 2; revision: string; image: LegacyShareImage; signature: string }
async function hash(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))),
    byte => byte.toString(16).padStart(2, '0')).join('');
}
async function signature(secret: string, value: unknown): Promise<string> {
  if (!secret) throw new ServiceUnavailableException('员工邀请签名未配置');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(JSON.stringify(['division-staff-invite:v2', value])))), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function verify(secret: string, value: unknown, actual: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(actual) || !secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(actual.match(/../g)!, pair => parseInt(pair, 16)),
    new TextEncoder().encode(JSON.stringify(['division-staff-invite:v2', value])));
}
const imageTerms = (snapshot: InviteSnapshot, expires: number) => ['image', snapshot.uid, snapshot.qrId,
  DIVISION_STAFF_INVITE_PAGE, snapshot.appId, snapshot.revision, expires];
const cacheKey = (snapshot: InviteSnapshot) => `division_staff_invite:v2:${snapshot.appId}:${snapshot.qrId}:${snapshot.revision}`;
const cacheTerms = (snapshot: InviteSnapshot, image: LegacyShareImage) => ['cache', snapshot.revision, image.mime, image.base64];

/** Creates only the authentic QR catalogue binding. All provider I/O is outside
 * SQL, and old user/role/order/ledger data is never mutated by image generation. */
export class DivisionStaffInviteService {
  constructor(private readonly container: Container, private readonly env: Env, private readonly fetcher: typeof fetch = fetch) {}

  private async snapshot(uid: number, actor?: DivisionStaffActor): Promise<InviteSnapshot> {
    staffInteger(uid, '代理商UID');
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      const [agent] = await tx.select(getTableColumns(user)).from(user).where(eq(user.uid, uid)).limit(1);
      if (actor) assertDivisionStaffActor(actor, agent);
      assertDivisionStaffAgent(agent);
      const rows = await tx.select({ id: qrcode.id }).from(qrcode).where(and(eq(qrcode.thirdType, 'division_agent'),
        eq(qrcode.thirdId, uid), eq(qrcode.status, 1))).limit(2);
      if (rows.length !== 1) throw new ValidateException('员工邀请二维码不存在、已停用或重复');
      const credentials = await readDivisionStaffWechatCredentials(tx, this.env);
      const revision = await hash([uid, rows[0].id, DIVISION_STAFF_INVITE_PAGE, credentials.appId, credentials.stamp,
        agent.pwd, agent.status, agent.isDel, agent.deleteTime, agent.divisionType, agent.divisionStatus, agent.divisionId,
        agent.agentId, agent.divisionEndTime]);
      return { uid, qrId: rows[0].id, appId: credentials.appId, revision };
    });
  }

  private async ensureQr(actor: DivisionStaffActor) {
    if (!this.env.APP_KEY) throw new ServiceUnavailableException('员工邀请签名未配置');
    await withTx(this.container, async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      const acquired = await tx.execute<{ acquired: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${ROLE_LOCK_NAMESPACE}, ${actor.uid}) AS acquired`);
      if (acquired[0]?.acquired !== true) throw new ValidateException('代理商关系正在更新，请稍后重试');
      const [agent] = await tx.select(getTableColumns(user)).from(user).where(eq(user.uid, actor.uid)).for('share', { noWait: true }).limit(1);
      assertDivisionStaffActor(actor, agent); assertDivisionStaffAgent(agent);
      await readDivisionStaffWechatCredentials(tx, this.env);
      const rows = await tx.select().from(qrcode)
        .where(and(eq(qrcode.thirdType, 'division_agent'), eq(qrcode.thirdId, actor.uid))).limit(2);
      if (rows.length > 1 || rows[0] && rows[0].status !== 1) throw new ValidateException('员工邀请二维码已停用或重复，请联系平台管理员');
      let expected = rows[0];
      if (!expected) {
        const values = { thirdType: 'division_agent', thirdId: actor.uid, status: 1, addTime: String(Math.floor(Date.now() / 1000)),
          ticket: '', expireSeconds: 0, url: '', qrcodeUrl: '', scan: 0, type: 0 };
        const inserted = await tx.insert(qrcode).values(values).onConflictDoNothing({ target: [qrcode.thirdType, qrcode.thirdId] }).returning();
        if (inserted.length !== 1 || !Number.isSafeInteger(inserted[0].id) || inserted[0].id <= 0
          || Object.keys(values).some(key => inserted[0][key as keyof typeof values] !== values[key as keyof typeof values])) {
          throw new ValidateException('员工邀请二维码创建结果不一致');
        }
        expected = inserted[0];
      }
      const persisted = await tx.select().from(qrcode).where(and(eq(qrcode.id, expected.id),
        eq(qrcode.thirdType, 'division_agent'), eq(qrcode.thirdId, actor.uid))).limit(2);
      if (persisted.length !== 1 || Object.keys(expected).some(key => expected[key as keyof typeof expected] !== persisted[0][key as keyof typeof expected])) {
        throw new ValidateException('员工邀请二维码保存结果不一致');
      }
      const [fresh] = await tx.select(getTableColumns(user)).from(user).where(eq(user.uid, actor.uid)).limit(1);
      if (!fresh || (Object.keys(getTableColumns(user)) as (keyof typeof agent)[])
        .some(key => JSON.stringify(fresh[key]) !== JSON.stringify(agent[key]))) {
        throw new ValidateException('员工邀请代理商账户保存结果不一致');
      }
      assertDivisionStaffActor(actor, fresh); assertDivisionStaffAgent(fresh);
    });
  }

  private async fresh(expected: InviteSnapshot, actor?: DivisionStaffActor) {
    const actual = await this.snapshot(expected.uid, actor);
    if (actual.revision !== expected.revision || actual.qrId !== expected.qrId) throw new ValidateException('员工邀请权限或小程序配置已变化，请重新读取');
  }

  private async loadImage(snapshot: InviteSnapshot, actor?: DivisionStaffActor): Promise<LegacyShareImage> {
    const cached = await cacheGet<CachedInvite>(cacheKey(snapshot), this.env);
    if (cached) {
      if (cached.version !== 2 || cached.revision !== snapshot.revision || !cached.image
        || typeof cached.image.base64 !== 'string' || cached.image.base64.length > 1398104
        || !await verify(this.env.APP_KEY, cacheTerms(snapshot, cached.image), cached.signature)) throw new ValidateException('员工邀请码缓存无效');
      const checked = legacyShareDataImage(`data:${cached.image.mime};base64,${cached.image.base64}`);
      await this.fresh(snapshot, actor); return checked;
    }
    const data = await new WechatMiniProgramCodeService(this.container, this.env, this.fetcher)
      .createDivisionStaffInviteDataUrl(snapshot.qrId, snapshot.appId);
    const image = legacyShareDataImage(data);
    await this.fresh(snapshot, actor);
    const saved: CachedInvite = { version: 2, revision: snapshot.revision, image,
      signature: await signature(this.env.APP_KEY, cacheTerms(snapshot, image)) };
    if (!await cacheSet(cacheKey(snapshot), saved, this.env, DIVISION_STAFF_INVITE_TTL)) throw new ServiceUnavailableException('员工邀请码缓存暂不可用');
    await this.fresh(snapshot, actor);
    return image;
  }

  async create(actor: DivisionStaffActor, requestUrl: string): Promise<{ url: string; expires: number }> {
    await this.ensureQr(actor);
    const snapshot = await this.snapshot(actor.uid, actor);
    await this.loadImage(snapshot, actor);
    const expires = Math.min(actor.expiresAt, Math.floor(Date.now() / 1000) + DIVISION_STAFF_INVITE_TTL);
    if (expires <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已失效，请重新登录');
    const url = new URL(requestUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ValidateException('员工邀请入口地址无效');
    const marker = '/division/agent/spread/code', index = url.pathname.lastIndexOf(marker);
    const prefix = index >= 0 ? url.pathname.slice(0, index) : '/api';
    url.pathname = `${prefix}${marker}/image/${actor.uid}`; url.hash = '';
    url.search = new URLSearchParams({ expires: String(expires), signature: await signature(this.env.APP_KEY, imageTerms(snapshot, expires)) }).toString();
    await this.fresh(snapshot, actor);
    return { url: url.toString(), expires };
  }

  async render(uidValue: string, query: URLSearchParams): Promise<Response> {
    const uid = staffInteger(uidValue, '代理商UID');
    for (const key of query.keys()) if (!['expires', 'signature'].includes(key) || query.getAll(key).length !== 1) throw new ValidateException('员工邀请图片查询参数无效');
    const expires = staffInteger(query.get('expires'), '图片凭据期限'), supplied = query.get('signature') ?? '';
    const now = Math.floor(Date.now() / 1000);
    if (expires <= now || expires > now + DIVISION_STAFF_INVITE_TTL) throw new AuthException('员工邀请码已失效，请重新生成');
    const snapshot = await this.snapshot(uid);
    if (!await verify(this.env.APP_KEY, imageTerms(snapshot, expires), supplied)) throw new AuthException('员工邀请码凭据无效');
    const image = await this.loadImage(snapshot);
    await this.fresh(snapshot);
    if (expires <= Math.floor(Date.now() / 1000)) throw new AuthException('员工邀请码已失效，请重新生成');
    const bytes = Uint8Array.from(atob(image.base64), value => value.charCodeAt(0));
    legacyShareImage(bytes, image.mime);
    return new Response(bytes, { headers: { 'Content-Type': image.mime, 'Cache-Control': 'private, no-store, max-age=0',
      Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
  }
}
