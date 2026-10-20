import { and, desc, eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container } from '@/lib/di';
import { legacyCache, systemConfig, user } from '@/models/schema';
import { AuthException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { publicOrdinaryProductIdentitySql } from '@/services/product/OrdinaryProductReadData';
import { integralPublicH5Origin, integralDetailText } from '@/services/activity/IntegralProductDetailData';
import { OfficialAccountQrcodeService } from '@/services/wechat/OfficialAccountQrcodeService';
import { WechatMiniProgramCodeService } from '@/services/wechat/WechatMiniProgramCodeService';
import { readLegacyPrivateScanTarget, assertLegacyPrivateScanViewer, type LegacyPrivateScanTarget } from './LegacyPrivateScanTarget';
import { readLegacyShareProvider } from './LegacyShareProviderRead';
import { readBargainInvitationTarget } from '@/services/activity/BargainHelpViewService';
import { LEGACY_SHARE_TYPES, LEGACY_SHARE_TTL, LEGACY_SHARE_IMAGE_TTL, LEGACY_SHARE_IMAGE_LIMIT,
  legacyShareHmac, legacyShareEqual, legacyShareToken, validLegacyShareToken, legacyShareWebsiteQr,
  legacyShareDataImage, legacyShareImage, legacyShareOfficialScene, parseLegacyShareOfficialScene,
  verifyLegacyShareImageQuery,
  type LegacyShareImage, type LegacyShareType } from './LegacyShareCodeProtocol';

export interface LegacyShareActor { uid: number; authVersion: string; expiresAt: number }
export function assertLegacyShareActor(actor: LegacyShareActor): void {
  if (!Number.isSafeInteger(actor.uid) || actor.uid < 0 || actor.uid > 2147483647) throw new AuthException();
  if (actor.uid && (!/^[a-f0-9]{32}$/.test(actor.authVersion) || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= Math.floor(Date.now()/1000))) throw new AuthException('请重新登录');
}
interface Descriptor {
  type: LegacyShareType; id: number; uid: number; origin: string; browser: boolean; official: boolean; permanent: boolean;
  miniApp: string; officialApp: string; time?: string; status?: string; privateTarget?: LegacyPrivateScanTarget;
  bargainUserId?: number; bargainOwnerUid?: number;
}
interface Document {
  version: 1; state: 'pending' | 'ready'; token: string; descriptor: Descriptor;
  created: number; expires: number; lease: string; leaseUntil: number;
  images: { wechat?: LegacyShareImage; routine?: LegacyShareImage }; scene: string;
  officialTicket?: string; mac: string;
}
interface Snapshot { descriptor: Descriptor; siteName: string; nickname: string; title: string }
const MAX_DOCUMENT = 3 * 1024 * 1024;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const validId = (value: number, zero = false) => Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= 2147483647;
const artifactKey = (token: string) => `lshare:${token}`;
const privateType = (type: LegacyShareType): type is 90 | 91 => type === 90 || type === 91;

export function parseLegacyShareInput(typeValue: string, idValue: string, query: URLSearchParams) {
  if (!/^(?:-1|0|1|2|3|4|6|7|90|91)$/.test(typeValue) || !/^(?:0|[1-9]\d{0,9})$/.test(idValue)) throw new ValidateException('分享码参数错误');
  const type = Number(typeValue) as LegacyShareType, id = Number(idValue);
  if (!validId(id, type === -1 || privateType(type))) throw new ValidateException('分享对象ID错误');
  const allowed = type === 1 ? ['time', 'status'] : type === 2 ? ['bargain_user_id'] : type === 91 ? ['order_id'] : [];
  for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) throw new ValidateException('分享码查询参数错误');
  const time = query.get('time') ?? '', status = query.get('status') ?? '', orderNo = query.get('order_id') ?? '';
  if (time && (!/^[1-9]\d{0,9}$/.test(time) || !validId(Number(time))) || status && !/^[012]$/.test(status)) throw new ValidateException('秒杀分享条件错误');
  if (type === 91 && (!orderNo || orderNo === '0' || orderNo.length > 32 || !/^[A-Za-z0-9_-]+$/.test(orderNo))) throw new ValidateException('订单号错误');
  const bargainUser = query.get('bargain_user_id');
  if (bargainUser !== null && (!/^[1-9]\d{0,9}$/.test(bargainUser) || !validId(Number(bargainUser))))
    throw new ValidateException('砍价邀请记录错误');
  return { type, id, time: time || undefined, status: status || undefined, orderNo: orderNo || undefined,
    bargainUserId: bargainUser === null ? undefined : Number(bargainUser) };
}

/** Generates both inherited image channels and a durable opaque landing record.
 * Only this cache prefix is mutated. Business authority is always read afresh,
 * and no SQL transaction remains open during provider or image network I/O. */
export class LegacyShareCodeService {
  constructor(private readonly container: Container, private readonly env: Env, private readonly fetcher: typeof fetch = fetch) {}
  private assertActor(actor: LegacyShareActor) {
    assertLegacyShareActor(actor);
  }
  private async snapshot(type: LegacyShareType, id: number, uid: number,
    query: { time?: string; status?: string; orderNo?: string; bargainUserId?: number }, officialBrowser: boolean, actor?: LegacyShareActor, permanentMini = false): Promise<Snapshot> {
    if (!LEGACY_SHARE_TYPES.includes(type) || !validId(uid, true)) throw new ValidateException('分享对象错误');
    if (actor) this.assertActor(actor);
    if ((privateType(type) || type === -1) && !uid) throw new AuthException('请登录后读取本人码');
    if (query.bargainUserId !== undefined && (type !== 2 || !validId(query.bargainUserId)))
      throw new ValidateException('砍价邀请记录错误');
    if (query.bargainUserId !== undefined && !uid) throw new AuthException('请登录后分享砍价邀请');
    const result = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      let nickname = '';
      if (uid) {
        const [account] = await tx.select({ pwd: user.pwd, nickname: user.nickname }).from(user)
          .where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0), sql`${user.deleteTime} IS NULL`)).limit(1);
        if (!account || actor && !legacyShareEqual(legacyShareHmac(this.env.APP_KEY, 'auth', md5(account.pwd)), legacyShareHmac(this.env.APP_KEY, 'auth', actor.authVersion))) throw new AuthException('分享账户已变化');
        nickname = integralDetailText(account.nickname, 128);
      }
      const names = ['site_name','share_qrcode','spread_share_forever','routine_appId','wechat_appid'];
      const rows = await tx.select({ name: systemConfig.menuName, value: sql<string>`left(${systemConfig.value},1001)` }).from(systemConfig)
        .where(and(eq(systemConfig.isStore, 0), sql`${systemConfig.menuName} IN (${sql.join(names.map(name => sql`${name}`), sql`,`)})`))
        .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(1001);
      if (rows.length > 1000 || rows.some(row => row.value.length > 1000)) throw new ValidateException('分享配置超过读取容量');
      const config = new Map<string,string>();
      for (const row of rows) if (!config.has(row.name)) {
        let value = row.value; try { const parsed: unknown = JSON.parse(value); value = typeof parsed === 'string' || typeof parsed === 'number' ? String(parsed) : ''; } catch { /* Legacy scalar. */ }
        config.set(row.name, value);
      }
      const origin = integralPublicH5Origin(this.env.PUBLIC_H5_ORIGIN);
      if (!origin) throw new ValidateException('分享站点未配置');
      const descriptor: Descriptor = { type, id:type===-1?0:id, uid, origin, browser:officialBrowser, official: officialBrowser && config.get('share_qrcode') === '1',
        permanent: permanentMini && type === -1 || officialBrowser && config.get('share_qrcode') === '1' && type === -1 && uid > 0 && config.get('spread_share_forever') === '1',
        miniApp: config.get('routine_appId')?.trim() ?? '', officialApp: permanentMini ? '' : config.get('wechat_appid')?.trim() ?? '',
        ...(query.time ? { time: query.time } : {}), ...(query.status ? { status: query.status } : {}) };
      let title = config.get('site_name') ?? '';
      if (type === 0 || type === 6) {
        const [product] = await tx.execute(sql`SELECT p.id,p.store_name FROM store_product p WHERE p.id=${id}
          AND ${publicOrdinaryProductIdentitySql('p')} ${type === 6 ? sql`AND p.is_presale_product=1` : sql``} LIMIT 1`) as unknown as Array<{ id: number; store_name: string }>;
        if (!product) throw new NotFoundException('分享商品不存在或已下架'); title = product.store_name;
      } else if ([1,2,3,4,7].includes(type)) {
        const table = ({ 1:'store_seckill', 2:'store_bargain', 3:'store_combination', 4:'store_integral', 7:'store_newcomer' } as Record<number,string>)[type];
        const visibility = type === 7 ? sql`a.is_del=0` : type === 2 ? sql`a.status=1 AND a.is_del=0` : sql`a.status=1 AND a.is_show=1 AND a.is_del=0`;
        const [activity] = await tx.execute(sql`SELECT a.id,p.store_name FROM ${sql.identifier(table)} a
          JOIN store_product p ON p.id=a.product_id AND p.type=a.type AND p.relation_id=a.relation_id AND p.product_type=a.product_type
          WHERE a.id=${id} AND ${visibility} AND ${publicOrdinaryProductIdentitySql('p')} LIMIT 1`) as unknown as Array<{ id: number; store_name: string }>;
        if (!activity) throw new NotFoundException('分享活动不存在或已下架'); title = activity.store_name;
        if (type === 1 && query.time) {
          const [slot] = await tx.execute(sql`SELECT t.id FROM store_seckill_time t JOIN store_seckill a ON a.id=${id}
            WHERE t.id=${Number(query.time)} AND t.status=1 AND t.id::text=ANY(string_to_array(a.time_id,',')) LIMIT 1`);
          if (!slot) throw new NotFoundException('秒杀分享时段不存在');
        }
        if (type === 2 && query.bargainUserId !== undefined) {
          const invitation = await readBargainInvitationTarget(tx, id, query.bargainUserId);
          descriptor.bargainUserId = invitation.participantId;
          descriptor.bargainOwnerUid = invitation.ownerUid;
        }
      }
      return { descriptor, siteName: integralDetailText(config.get('site_name') ?? '',128), nickname, title: integralDetailText(title,128) };
    });
    if (privateType(type)) {
      const target = await readLegacyPrivateScanTarget(this.container, uid, type, query.orderNo);
      if (target.kind !== (type === 90 ? 'member' : 'order')) throw new ValidateException('私有码种类错误');
      const targetId = target.kind === 'member' ? uid : target.physicalOrderId;
      if (id !== 0 && id !== targetId) throw new NotFoundException('本人码对象不匹配');
      result.descriptor.id = targetId; result.descriptor.privateTarget = target;
    }
    if (actor) this.assertActor(actor);
    return result;
  }
  private sign(document: Omit<Document,'mac'>): Document { return { ...document, mac: legacyShareHmac(this.env.APP_KEY,'document',JSON.stringify(document)) }; }
  private parse(raw: string | null): Document | null {
    if (!raw) return null;
    if (new TextEncoder().encode(raw).length > MAX_DOCUMENT) throw new ServiceUnavailableException('分享记录超过读取容量');
    let value: Document; try { value = JSON.parse(raw) as Document; } catch { throw new ValidateException('分享记录损坏'); }
    const { mac, ...body } = value;
    if (value.version !== 1 || !validLegacyShareToken(value.token) || !['pending','ready'].includes(value.state)
      || !value.descriptor || !LEGACY_SHARE_TYPES.includes(value.descriptor.type)
      || !legacyShareEqual(mac, legacyShareHmac(this.env.APP_KEY,'document',JSON.stringify(body)))) throw new ValidateException('分享记录签名错误');
    return value;
  }
  private async load(token: string): Promise<Document> {
    if (!validLegacyShareToken(token)) throw new ValidateException('分享标识错误');
    const [row] = await this.container.db.select({ result: sql<string>`left(${legacyCache.result},${MAX_DOCUMENT + 1})` }).from(legacyCache).where(eq(legacyCache.key,artifactKey(token))).limit(1);
    const document = this.parse(row?.result ?? null);
    if (!document || document.state !== 'ready' || document.token !== token || document.expires && document.expires <= nowSeconds()) throw new NotFoundException('分享码已失效，请重新生成');
    return document;
  }
  private landingUrl(token: string, origin: string) { const url = new URL('/',origin); url.hash = `/pages/share/landing?q=${token}`; return url.href; }
  private async fresh(document: Document): Promise<Snapshot> {
    const d = document.descriptor;
    const current = await this.snapshot(d.type, d.id, d.uid, { time:d.time, status:d.status, bargainUserId:d.bargainUserId,
      orderNo:d.privateTarget?.kind==='order'?d.privateTarget.orderNo:undefined }, d.browser, undefined, d.type === -1 && d.permanent && !d.official);
    if (JSON.stringify(current.descriptor) !== JSON.stringify(d)) throw new NotFoundException('分享对象或配置已变化，请重新生成');
    return current;
  }
  private async officialImage(url: string): Promise<LegacyShareImage> {
    const target = new URL(url);
    if (target.origin !== 'https://mp.weixin.qq.com' || target.pathname !== '/cgi-bin/showqrcode' || target.searchParams.size !== 1 || !target.searchParams.get('ticket')) throw new ValidateException('分享票据图片地址错误');
    const response = await readLegacyShareProvider(this.fetcher,target,{method:'GET'},{json:65536,image:LEGACY_SHARE_IMAGE_LIMIT});
    const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (!response.ok || !response.body || Number(response.headers.get('Content-Length') ?? 0) > LEGACY_SHARE_IMAGE_LIMIT) throw new ServiceUnavailableException('分享票据图片不可用');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let count = 0;
    try { while (true) { const { done,value } = await reader.read(); if (done) break; count += value.length;
      if (count > LEGACY_SHARE_IMAGE_LIMIT) { await reader.cancel(); throw new ValidateException('分享票据图片超过容量'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(count); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
    return legacyShareImage(bytes,mime);
  }
  private imageUrl(document: Document, channel: 'wechat'|'routine'): string {
    if (!document.images[channel]) return '';
    const expires = nowSeconds() + LEGACY_SHARE_IMAGE_TTL;
    const signature = legacyShareHmac(this.env.APP_KEY,'image',`${document.token}:${channel}:${expires}`);
    return `/api/share/code/image/${document.token}/${channel}?${new URLSearchParams({expires:String(expires),signature})}`;
  }
  private async checkpoint(indexKey: string, document: Document): Promise<Document> {
    const {mac:_mac,...unsigned} = document, signed = this.sign(unsigned);
    await withTx(this.container, async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${indexKey},0))`);
      const [row] = await tx.select({result:legacyCache.result}).from(legacyCache).where(eq(legacyCache.key,indexKey)).limit(1);
      const current = this.parse(row?.result ?? null);
      if (!current || current.state !== 'pending' || current.token !== document.token || current.lease !== document.lease) throw new ServiceUnavailableException('分享生成已被更新，请重新读取');
      await tx.update(legacyCache).set({result:JSON.stringify(signed)}).where(eq(legacyCache.key,indexKey));
    });
    return signed;
  }
  /** Legacy personal spread-code alias; it requires a configured mini-program channel. */
  async routineCode(actor: LegacyShareActor): Promise<string> {
    const result = await this.code(parseLegacyShareInput('-1', '0', new URLSearchParams()), actor, false, { requireMini: true });
    if (!result.routineUrl) throw new ServiceUnavailableException('分销小程序图片暂不可用，请稍后重试');
    return result.routineUrl;
  }
  async code(input: ReturnType<typeof parseLegacyShareInput>, actor: LegacyShareActor, officialBrowser: boolean, options: { requireMini?: boolean } = {}) {
    // PHP routine_code uses a forever spread record even when official-channel
    // forever sharing is disabled. Keep that lifetime local to this alias.
    const permanentMini = options.requireMini === true && input.type === -1 && !officialBrowser;
    const current = await this.snapshot(input.type,input.id,actor.uid,input,officialBrowser,actor,permanentMini), descriptor = current.descriptor;
    if (options.requireMini && !descriptor.miniApp) throw new ServiceUnavailableException('小程序分销码未配置');
    const indexKey = `lsc:${legacyShareHmac(this.env.APP_KEY,'index',JSON.stringify(descriptor)).slice(0,28)}`;
    const claimed = await withTx(this.container, async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${indexKey},0))`);
      const [row] = await tx.select({ result:legacyCache.result }).from(legacyCache).where(eq(legacyCache.key,indexKey)).limit(1);
      const previous = this.parse(row?.result ?? null), now = nowSeconds();
      if (previous && JSON.stringify(previous.descriptor) !== JSON.stringify(descriptor)) throw new ValidateException('分享缓存身份冲突');
      if (previous?.state === 'ready' && (!previous.expires || previous.expires > now)) return { document:previous, acquired:false };
      if (previous?.state === 'pending' && previous.leaseUntil > now) throw new ServiceUnavailableException('分享码正在生成，请稍后重试');
      const resume = previous?.state === 'pending' && (!previous.expires || previous.expires > now);
      const token = resume ? previous.token : legacyShareToken(), expires = resume ? previous.expires : descriptor.permanent ? 0 : now + LEGACY_SHARE_TTL;
      const document = this.sign({ version:1,state:'pending',token,descriptor,created:resume?previous.created:now,expires,
        lease:legacyShareToken(),leaseUntil:now+90,images:resume?previous.images:{},scene:legacyShareOfficialScene(token,expires,this.env.APP_KEY),
        ...(resume&&previous.officialTicket?{officialTicket:previous.officialTicket}:{}) });
      await tx.insert(legacyCache).values({key:indexKey,result:JSON.stringify(document),expireTime:expires,addTime:now})
        .onConflictDoUpdate({target:legacyCache.key,set:{result:JSON.stringify(document),expireTime:expires,addTime:now}});
      return { document, acquired:true };
    });
    let document = claimed.document;
    if (claimed.acquired) {
      try {
        const images: Document['images'] = {...document.images}, target = this.landingUrl(document.token,descriptor.origin);
        if (descriptor.official) {
          if (!document.officialTicket) {
            const ticket = await new OfficialAccountQrcodeService(this.container,this.env,this.fetcher).requestLegacyShare(document.scene,descriptor.permanent,descriptor.officialApp);
            document.officialTicket = ticket.ticket; document = await this.checkpoint(indexKey,document);
          }
          if (!images.wechat) images.wechat = await this.officialImage(`https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(document.officialTicket!)}`);
        } else if (!images.wechat) images.wechat = legacyShareWebsiteQr(target);
        document.images = images; document = await this.checkpoint(indexKey,document);
        if (!images.routine) {
          const mini = await new WechatMiniProgramCodeService(this.container,this.env,this.fetcher).createLegacyShareLandingDataUrl(document.token,descriptor.miniApp);
          if (descriptor.miniApp && !mini) throw new ServiceUnavailableException('分享小程序图片暂不可用，请稍后重试');
          if (mini) images.routine = legacyShareDataImage(mini);
          document.images = images; document = await this.checkpoint(indexKey,document);
        }
        await this.snapshot(input.type,input.id,actor.uid,input,officialBrowser,actor,permanentMini);
        await this.fresh(document); this.assertActor(actor);
        const {mac:_mac,...unsigned} = document;
        document = this.sign({...unsigned,state:'ready',images,leaseUntil:0});
        document = await withTx(this.container, async tx => {
          await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${indexKey},0))`);
          const [row] = await tx.select({result:legacyCache.result}).from(legacyCache).where(eq(legacyCache.key,indexKey)).limit(1);
          const live = this.parse(row?.result ?? null);
          if (!live || live.token !== document.token || live.lease !== document.lease || live.state !== 'pending') throw new ServiceUnavailableException('分享生成已被更新，请重新读取');
          await tx.insert(legacyCache).values({key:artifactKey(document.token),result:JSON.stringify(document),expireTime:document.expires,addTime:document.created});
          await tx.update(legacyCache).set({result:JSON.stringify(document)}).where(eq(legacyCache.key,indexKey));
          return document;
        });
      } catch (error) {
        // Retain the exact descriptor and scene after an unknown provider result.
        // A later bounded retry uses the same opaque target, never a bare UID.
        if (error instanceof AuthException || error instanceof NotFoundException || error instanceof ValidateException) throw error;
        throw new ServiceUnavailableException('分享码生成失败，请稍后重试');
      }
    }
    await this.fresh(document);
    const live = await this.snapshot(input.type,input.id,actor.uid,input,officialBrowser,actor,permanentMini); this.assertActor(actor);
    return {routineUrl:this.imageUrl(document,'routine'),wechatUrl:this.imageUrl(document,'wechat'),site_name:live.siteName,nickname:live.nickname};
  }
  async scene(token: string, viewer: LegacyShareActor) {
    this.assertActor(viewer); const document = await this.load(token); await this.fresh(document);
    const d = document.descriptor, target = d.privateTarget;
    if (target) {
      if (!viewer.uid) throw new AuthException('请登录后核对本人或已获授权的码');
      await this.snapshot(-1,0,viewer.uid,{},false,viewer);
      const viewerScope = await assertLegacyPrivateScanViewer(this.container,viewer.uid,target,this.env);
      await this.snapshot(-1,0,viewer.uid,{},false,viewer);
      await this.fresh(document);
      this.assertActor(viewer);
      const path = viewerScope === 'owner' ? target.kind === 'member' ? '/pages/user/memberCode'
        : `/pages/order/detail?${new URLSearchParams({orderId:target.orderNo})}`
        : viewerScope === 'customer' ? '/pages/customer-work/scanning'
        : viewerScope === 'staff' ? '/pages/operator/writeoff?role=staff' : '/pages/delivery/scanning';
      return {type:d.type,id:d.id,spid:0,h5_origin:d.origin,namespace:target.kind,code:target.code,viewer_scope:viewerScope,
        ...(target.kind === 'order' ? {order_id:target.orderNo}:{}),path};
    }
    const pages: Partial<Record<LegacyShareType,string>> = {'-1':'/pages/index/index',0:'/pages/goods/detail',1:'/pages/activity/seckillDetail',
      2:'/pages/activity/bargainDetail',3:'/pages/activity/detail',4:'/pages/activity/integralDetail',6:'/pages/activity/presaleDetail',7:'/pages/activity/newcomerDetail'};
    const query = new URLSearchParams({...(d.type===-1?{}:{id:String(d.id)}),
      ...(d.bargainUserId?{bargainUserId:String(d.bargainUserId),help:'1'}:{}),
      ...(d.uid?{spid:String(d.uid)}:{}),...(d.time?{time:d.time}:{}),...(d.status?{status:d.status}:{})});
    return {type:d.type,id:d.id,spid:d.uid,h5_origin:d.origin,...(d.bargainUserId?{bargain_user_id:d.bargainUserId}:{}),
      ...(d.time?{time:d.time}:{}),...(d.status?{status:d.status}:{}),path:pages[d.type]+(query.size?'?'+query:'')};
  }
  async image(token: string, channel: string, query: URLSearchParams): Promise<Response> {
    verifyLegacyShareImageQuery(token,channel,query,this.env.APP_KEY);
    const document = await this.load(token); await this.fresh(document);
    const image = document.images[channel as 'wechat'|'routine']; if (!image) throw new NotFoundException('此分享图片不存在');
    const verified = legacyShareDataImage(`data:${image.mime};base64,${image.base64}`), bytes = Buffer.from(verified.base64,'base64');
    return new Response(bytes,{headers:{'Content-Type':verified.mime,'Content-Length':String(bytes.length),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  }
  /** Called only from the authenticated callback pipeline. A bare scene UID,
   * another provider ticket, or a private code cannot bind a referral. */
  async referrer(eventKey: string, ticket: string): Promise<number | null> {
    const raw = eventKey.startsWith('qrscene_') ? eventKey.slice(8) : eventKey;
    if (!raw.startsWith('ls:')) return null;
    const scene = parseLegacyShareOfficialScene(raw,this.env.APP_KEY); if (!scene || !ticket) return 0;
    try {
      const document = await this.load(scene.token);
      if (document.scene !== raw || document.expires !== scene.expires || !document.descriptor.official
        || document.officialTicket !== ticket || document.descriptor.privateTarget) return 0;
      await this.fresh(document); return document.descriptor.uid;
    } catch (error) { if (error instanceof AuthException || error instanceof NotFoundException || error instanceof ValidateException) return 0; throw error; }
  }
  async news(eventKey: string, ticket?: string): Promise<Record<string,unknown>|null> {
    const scene = parseLegacyShareOfficialScene(eventKey,this.env.APP_KEY); if (!scene) return null;
    try {
      const document = await this.load(scene.token);
      if (document.expires !== scene.expires || document.scene !== (eventKey.startsWith('qrscene_')?eventKey.slice(8):eventKey) || !document.descriptor.official
        || ticket !== undefined && ticket !== document.officialTicket) return null;
      const current = await this.fresh(document);
      // Private code possession never turns a subscribe event into code disclosure.
      return {type:'news',title:current.title||current.siteName,description:document.descriptor.privateTarget?'登录并核验权限后查看扫码内容':'打开当前分享内容',image:'',url:this.landingUrl(document.token,document.descriptor.origin)};
    } catch (error) { if (error instanceof AuthException || error instanceof NotFoundException || error instanceof ValidateException) return null; throw error; }
  }
}
