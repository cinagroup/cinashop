import { and, asc, desc, eq, gt, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { liveGoods, storeProduct, storeProductAttrValue, storeProductCategory, storeProductDescription,
  storeProductLabel, storeProductRelation, storeProductReply, systemAdmin, systemLog } from '@/models/schema';
import { lockReviewProducts, refreshProductReviewStar, verifyReviewProductSnapshot, type ReviewProductRow } from '@/services/product/ProductReviewRatingService';
import { validateFictitiousReplyMedia, verifyFictitiousReplyMedia } from '@/services/product/ProductReplyMediaPolicy';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { ApiErrorCode, AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { legacyPhpJsonDecodeWire } from '@/utils/legacy-php-json';
import { acquireAdminAuthorityWriteBarrier, assertAdminAuthoritySession, loadAdminAuthorityLiveActor,
  parseAdminAuthorityRoleIds, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminLegacyRoleReferenceHistory } from './AdminLegacyRoleDeletionProof';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';

export type AdminProductFictitiousReplyActor = AdminAuthorityActor;
type SkuRow = typeof storeProductAttrValue.$inferSelect;
type ReplyRow = typeof storeProductReply.$inferSelect;
const MAX_ID = 2_147_483_647;
const MAX_SKUS = 200;
const invalidText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u;

export function fictitiousProductId(value: unknown, allowZero = false): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < (allowZero ? 0 : 1) || id > MAX_ID) throw new ValidateException('商品ID错误');
  return id;
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException(`${label}必须是对象`);
  return value as Record<string, unknown>;
}
function keys(input: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ValidateException('虚拟评价包含未知字段');
}
function queryInput(query: URLSearchParams, allowed: readonly string[]): Record<string, string> {
  const input: Record<string, string> = {};
  for (const [key, value] of query) {
    if (!allowed.includes(key) || Object.hasOwn(input, key)) throw new ValidateException('商品查询参数错误或重复');
    input[key] = value;
  }
  return input;
}
function text(value: unknown, label: string, max: number, required = true, multiline = false): string {
  if (typeof value !== 'string' || (required && !value.trim())) throw new ValidateException(`请填写${label}`);
  if ([...value].length > max || invalidText.test(value) || (!multiline && /[\t\n\r]/u.test(value))) throw new ValidateException(`${label}最多${max}个字符且不能包含非法字符`);
  return value;
}
function media(value: unknown, label: string, max: number): string {
  const source = text(value, label, max);
  if (/\s|\\/u.test(source) || source.startsWith('//')) throw new ValidateException(`${label}地址错误`);
  let parsed: URL;
  if (/^https?:\/\//i.test(source)) {
    try {
      parsed = new URL(source);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error();
    } catch { throw new ValidateException(`${label}地址错误`); }
  } else {
    if (source.includes(':') || source.startsWith('#') || source.startsWith('?')) throw new ValidateException(`${label}地址错误`);
    try { parsed = new URL(source, 'https://reply-media.invalid/'); } catch { throw new ValidateException(`${label}地址错误`); }
  }
  if ([...parsed.searchParams.keys()].some(key => ['expires', 'signature'].includes(key.toLowerCase()))) throw new ValidateException(`${label}请使用稳定素材地址，不能保存临时签名链接`);
  return source;
}
function score(value: unknown, fallback: number, maximum: number): number {
  const input = value === undefined ? fallback : value;
  const number = typeof input === 'number' ? input : typeof input === 'string' && /^[1-5]$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new ValidateException(`评价分数必须是1-${maximum}之间的整数`);
  return number;
}
const shanghaiFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
type CalendarParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
function localParts(epoch: number): CalendarParts {
  const parts = Object.fromEntries(shanghaiFormatter.formatToParts(new Date(epoch * 1000)).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}
function utcCalendar(parts: CalendarParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
}
function addTime(value: unknown, now: number): number {
  if (value === undefined || value === '' || value === 0 || value === '0') return now;
  if (typeof value !== 'string') throw new ValidateException('评论时间格式错误');
  const match = value.match(/^(\d{4})[/-](\d{2})[/-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) throw new ValidateException('评论时间格式错误');
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => part === undefined ? 0 : Number(part));
  const parts = { year, month, day, hour, minute, second }, target = utcCalendar(parts), date = new Date(target);
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) throw new ValidateException('评论时间格式错误');
  let candidate = target, resolved = false;
  for (let index = 0; index < 6; index++) {
    const correction = target - utcCalendar(localParts(candidate / 1000));
    if (correction === 0) { resolved = true; break; }
    candidate += correction;
  }
  const epoch = candidate / 1000;
  if (!resolved || !Number.isSafeInteger(epoch) || epoch < -2_147_483_648 || epoch > MAX_ID) throw new ValidateException('评论时间在上海时区不存在或超出范围');
  if (epoch > now) throw new ValidateException('评论时间应小于当前时间');
  return epoch;
}
function createInput(value: unknown) {
  const body = record(value, '虚拟评价正文');
  keys(body, ['image', 'nickname', 'avatar', 'comment', 'pics', 'reply_score', 'product_score', 'service_score', 'delivery_score', 'product_id', 'unique', 'add_time']);
  let imageId = 0;
  if (body.image !== undefined && body.image !== '') {
    const image = record(body.image, '商品图片'); keys(image, ['image', 'product_id']);
    if (image.image !== undefined) text(image.image, '商品图片', 256, false);
    if (image.product_id !== undefined) imageId = fictitiousProductId(image.product_id, true);
  }
  const bodyId = body.product_id === undefined ? 0 : fictitiousProductId(body.product_id, true);
  if (imageId && bodyId && imageId !== bodyId) throw new ValidateException('商品选择与商品ID不一致');
  const productId = fictitiousProductId(bodyId || imageId);
  const skuUnique = body.unique === undefined ? '' : text(body.unique, 'SKU唯一标识', 8, false);
  const pics = body.pics === undefined ? [] : body.pics;
  if (!Array.isArray(pics) || pics.length > 8) throw new ValidateException('评价图片必须为数组且最多8张');
  return { productId, skuUnique, nickname: text(body.nickname, '用户昵称', 64), avatar: media(body.avatar, '用户头像', 255),
    comment: text(body.comment, '评论内容', 512, true, true), pics: pics.map(pic => media(pic, '评价图片', 2048)),
    replyScore: score(body.reply_score, 3, 3), productScore: score(body.product_score, 5, 5),
    serviceScore: score(body.service_score, 5, 5), deliveryScore: score(body.delivery_score, 5, 5), addTime: body.add_time };
}
function validOwner(type: number, relationId: number): boolean {
  return type === 0 && relationId === 0 || [1, 2].includes(type) && Number.isSafeInteger(relationId) && relationId > 0 && relationId <= MAX_ID;
}
function assertProduct(row: ReviewProductRow): void {
  if (!validOwner(row.type, row.relationId)) throw new ServiceUnavailableException('历史商品归属异常，请核对数据');
  if (row.isDel !== 0 || row.isVerify !== 1) throw new NotFoundException('商品不存在、已删除或未通过审核');
}
function sameRow<T extends object>(actual: T | undefined, expected: T): boolean {
  return !!actual && Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => (actual as Record<string, unknown>)[key] === value);
}
function operationError(error: unknown): never {
  let cause: unknown = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(new HttpApiException('商品或管理员权限正在更新，请刷新后重试', 409, 409), { cause: error });
    if (['42501', '57014'].includes(code)) throw Object.assign(new ServiceUnavailableException('虚拟评价运行权限配置未就绪或操作超时'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}
function snake(row: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]));
}
function csv(value: string | null): number[] {
  if (!value || value === '0') return [];
  const values = value.split(',').filter(item => item !== '' && item !== '0');
  if (values.length > 200 || values.some(item => !/^[1-9]\d*$/.test(item) || Number(item) > MAX_ID)) throw new ServiceUnavailableException('历史商品分类或标签格式异常，请核对数据');
  return values.map(Number);
}
function skuDto(row: SkuRow) {
  const { isRetired: _isRetired, retiredAt: _retiredAt, retiredBy: _retiredBy, retireReason: _retireReason, ...source } = row;
  return { ...snake(source), id: row.id, product_id: row.productId, type: row.type, unique: row.unique, suk: row.suk,
    image: row.image, price: row.price, stock: row.stock };
}
function productDto(row: ReviewProductRow, skus: SkuRow[], categories: Map<number, typeof storeProductCategory.$inferSelect>, labels: Map<number, string>, description: string | null) {
  const source = snake(row);
  source.is_police = row.isPolices; delete source.is_polices;
  const names = csv(row.cateId).map(id => categories.get(id)).filter(category => category !== undefined).sort((a, b) => a.id - b.id)
    .map(category => `${categories.get(category.pid)?.cateName ? `${categories.get(category.pid)!.cateName}/` : ''}${category.cateName}`);
  return { ...source, id: row.id, type: row.type, relation_id: row.relationId, image: row.image, store_name: row.storeName,
    product_type: row.productType, is_show: row.isShow, price: Number(row.price), vip_price: Number(row.vipPrice), ot_price: Number(row.otPrice),
    give_integral: Number(row.giveIntegral), postage: Number(row.postage), cost: Number(row.cost), stock: row.stock, sales: row.sales,
    delivery_type: row.deliveryType && row.deliveryType !== '0' ? row.deliveryType.split(',') : [],
    slider_image: legacyPhpJsonDecodeWire(row.sliderImage),
    custom_form: row.customForm && row.customForm !== '0' ? legacyPhpJsonDecodeWire(row.customForm) : [],
    specs: row.specs && row.specs !== '0' ? legacyPhpJsonDecodeWire(row.specs) : [],
    label_id: csv(row.labelId), store_label_id: csv(row.storeLabelId), ensure_id: csv(row.ensureId),
    cate_name: names.join(','), store_label: csv(row.storeLabelId).map(id => labels.get(id)).filter(Boolean).join(','),
    description, attrValue: skus.map(skuDto) };
}
function queryChoice(value: string | undefined, allowed: readonly string[], fallback: string): string {
  const choice = value === undefined ? fallback : value;
  if (!allowed.includes(choice)) throw new ValidateException('商品筛选参数错误');
  return choice;
}
function queryIds(value: string | undefined): number[] | undefined {
  if (value === undefined || value === '' || value === '0') return undefined;
  const ids = value.split(',').map(item => fictitiousProductId(item));
  if (ids.length > 100 || new Set(ids).size !== ids.length) throw new ValidateException('商品筛选ID错误、重复或过多');
  return ids;
}

/** UID0 source reviews are new platform records, never an edit to customer or
 * order evidence. Central Admin may choose any valid approved product owner. */
export class AdminProductFictitiousReplyService {
  constructor(private readonly container: Container, private readonly appKey?: string) {}

  /** The source selector capacity is 100 products with 200 current SKUs each.
   * Sign only exact private transport references, in policy-sized chunks; raw
   * HTTP/HTTPS/relative images and every other source field remain untouched. */
  private async renderSelectorImages(tx: DbClient, owners: ReviewProductRow[], list: Array<ReturnType<typeof productDto>>): Promise<void> {
    const slots: Array<{ image: string; type: number; relationId: number; assign: (value: string) => void }> = [];
    const collect = (image: string, owner: ReviewProductRow, assign: (value: string) => void) => {
      const id = parseCanonicalAttachmentId(image);
      if (id === null) return;
      if (!this.appKey || id > MAX_ID) { assign(''); return; }
      // Existing public product detail treats store copies as platform media.
      // Supplier copies retain their own persisted publication owner tuple.
      slots.push({ image, type: owner.type === 1 ? 0 : owner.type, relationId: owner.type === 1 ? 0 : owner.relationId, assign });
    };
    owners.forEach((owner, index) => {
      const item = list[index];
      collect(item.image, owner, value => { item.image = value; });
      item.attrValue.forEach(sku => collect(sku.image, owner, value => { sku.image = value; }));
    });
    for (let start = 0; start < slots.length; start += 10000) {
      const batch = slots.slice(start, start + 10000);
      const allowed = await publicProductPictures(tx, batch);
      const rendered = await renderProductPictures(this.appKey, allowed);
      batch.forEach((slot, index) => slot.assign(rendered[index]));
    }
  }

  private async readActor(tx: DbClient, actor: AdminProductFictitiousReplyActor, capability: string): Promise<void> {
    const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
    if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
      || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
    const encoder = new TextEncoder();
    if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
    await loadAdminLegacyRoleReferenceHistory(tx, parseAdminAuthorityRoleIds(live.roles), live.level);
    const { keys: permissions } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
    if (live.level !== 0 && !hasAdminPermission(permissions, capability)) throw new AuthException('管理员权限已变化', ApiErrorCode.ERR_AUTH);
    assertAdminAuthoritySession(actor);
  }
  private async transaction<T>(actor: AdminProductFictitiousReplyActor, write: boolean, capability: string, work: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container, async tx => {
        let initial: typeof systemAdmin.$inferSelect | undefined;
        if (write) {
          await acquireAdminAuthorityWriteBarrier(tx); await loadAdminAuthorityLiveActor(tx, actor, capability);
          [initial] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
        } else {
          await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
          await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
          await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`); await this.readActor(tx, actor, capability);
        }
        const result = await work(tx);
        if (write) {
          await loadAdminAuthorityLiveActor(tx, actor, capability);
          const [fresh] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
          if (!initial || !sameRow(fresh, initial)) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_AUTH);
        }
        const [clock] = await tx.execute(sql`SELECT extract(epoch from clock_timestamp()) >= ${actor.expiresAt} AS expired`) as unknown as Array<{ expired: boolean }>;
        if (clock?.expired !== false) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
        assertAdminAuthoritySession(actor); return result;
      });
    } catch (error) { return operationError(error); }
  }
  private async audit(tx: DbClient, actor: AdminProductFictitiousReplyActor, reply: ReplyRow, sku?: SkuRow): Promise<void> {
    const expected = { storeId: 0, merchantId: 0, adminName: '', ip: '', adminId: actor.id,
      path: 'product/reply/save_fictitious_reply', page: '商品评价管理', method: 'POST', type: 'product_fictitious_reply',
      action: JSON.stringify({ operation: 'create', id: reply.id, productId: reply.productId, ...(sku ? { skuId: sku.id } : {}) }), addTime: Math.floor(Date.now() / 1000) };
    const rows = await tx.insert(systemLog).values(expected).returning();
    const row = rows[0];
    const matches = (value: typeof row | undefined) => value && Number.isSafeInteger(value.id) && value.id > 0
      && Object.keys(value).length === Object.keys(expected).length + 1
      && Object.entries(expected).every(([key, expectedValue]) => value[key as keyof typeof value] === expectedValue);
    if (rows.length !== 1 || !matches(row)) throw new Error('虚拟评价审计回执不完整');
    const [fresh] = await tx.select().from(systemLog).where(eq(systemLog.id, row.id)).limit(1);
    if (!matches(fresh)) throw new Error('虚拟评价审计回读不一致');
  }
  private async verifyReply(tx: DbClient, expected: ReplyRow): Promise<void> {
    const rows = await tx.select().from(storeProductReply).where(eq(storeProductReply.id, expected.id));
    if (rows.length !== 1 || !sameRow(rows[0], expected)) throw new Error('虚拟评价完整业务回执核验失败');
  }
  private async selectedSku(tx: DbClient, productId: number, unique: string, lock: boolean): Promise<SkuRow> {
    const query = tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, productId),
      eq(storeProductAttrValue.unique, unique), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0)))
      .orderBy(asc(storeProductAttrValue.id)).limit(2);
    const rows = await (lock ? query.for('update', { noWait: true }) : query);
    if (rows.length > 1) throw new ServiceUnavailableException('商品SKU唯一标识存在歧义，请核对数据');
    if (!rows[0]) throw new ValidateException('所选SKU不存在、已退役或不属于该商品的普通规格');
    text(rows[0].suk, 'SKU规格快照', 255, false);
    return rows[0];
  }

  async form(productId: number, query: URLSearchParams, actor: AdminProductFictitiousReplyActor) {
    const id = fictitiousProductId(productId, true), input = queryInput(query, ['product_id']);
    if (input.product_id !== undefined && fictitiousProductId(input.product_id, true) !== id) throw new ValidateException('路径与查询商品ID不一致');
    return this.transaction(actor, false, 'reply.view', async tx => {
      if (id) { const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, id)).limit(1);
        if (!product) throw new NotFoundException('商品不存在'); assertProduct(product); }
      const frame = (multiple: boolean, field: string, title: string, src: string, height: string) => ({ type: 'frame', field, title, value: multiple ? [] : '',
        props: { type: 'image', maxLength: multiple ? 8 : 1, src, icon: 'ios-add', width: '960px', height,
          frameTitle: `请选择${title}`, modal: { 'footer-hide': true } } });
      const first = id ? { type: 'hidden', field: 'product_id', value: id } : {
        ...frame(false, 'image', '商品', 'admin/store.StoreProduct/index?fodder=image', '560px'),
        props: { ...frame(false, 'image', '商品', 'admin/store.StoreProduct/index?fodder=image', '560px').props, srcKey: 'image' } };
      return { title: '添加虚拟评论', action: 'product/reply/save_fictitious_reply', method: 'POST', rules: [first,
        frame(false, 'avatar', '用户头像', 'admin/widget.images/index?fodder=avatar', '505px'),
        { type: 'input', field: 'nickname', title: '用户名称', value: '', col: { span: 24 }, props: { type: 'text', placeholder: '请输入用户名称' } },
        { type: 'input', field: 'comment', title: '评价文字', value: '', props: { type: 'textarea', placeholder: '请输入评价文字' } },
        { type: 'rate', field: 'product_score', title: '商品分数', value: 0, props: { allowHalf: false } },
        { type: 'rate', field: 'service_score', title: '服务分数', value: 0, props: { allowHalf: false } },
        { ...frame(true, 'pics', '评价图片', 'admin/widget.images/index?fodder=pics&type=many&maxLength=8', '505px'),
          props: { ...frame(true, 'pics', '评价图片', 'admin/widget.images/index?fodder=pics&type=many&maxLength=8', '505px').props,
            closeBtn: false, okBtn: false } },
        { type: 'datePicker', field: 'add_time', title: '评论时间', value: '', props: { type: 'datetime', editable: false, placeholder: '请选择评论时间(不选择默认当前添加时间)' } },
      ] };
    });
  }

  async create(body: unknown, actor: AdminProductFictitiousReplyActor): Promise<{ id: number }> {
    const input = createInput(body);
    return this.transaction(actor, true, 'reply.manage', async tx => {
      const products = await lockReviewProducts(tx, [input.productId]), before = products.get(input.productId);
      if (!before) throw new NotFoundException('商品不存在'); assertProduct(before);
      const sku = input.skuUnique ? await this.selectedSku(tx, before.id, input.skuUnique, true) : undefined;
      const mediaProof = await validateFictitiousReplyMedia(tx, actor, [input.avatar, ...input.pics]);
      const now = Math.floor(Date.now() / 1000), timestamp = addTime(input.addTime, now), unique = Array.from(randomBytes(16), byte => byte.toString(16).padStart(2, '0')).join('');
      const collision = await tx.select({ id: storeProductReply.id }).from(storeProductReply).where(eq(storeProductReply.unique, unique)).limit(1);
      if (collision.length) throw new ServiceUnavailableException('评价标识冲突，请重试');
      const expected = { productId: before.id, oid: 0, orderCartInfoId: null, unique, uid: 0,
        nickname: input.nickname, avatar: input.avatar, comment: input.comment, sku: sku?.suk ?? '', skuUnique: input.skuUnique,
        type: 0, relationId: 0, replyType: 'product', replyScore: input.replyScore, productScore: input.productScore,
        serviceScore: input.serviceScore, logisticsScore: input.deliveryScore, deliveryScore: input.deliveryScore, pics: JSON.stringify(input.pics),
        isReply: 0, merchantReply: '', merchantReplyContent: '', merchantReplyTime: 0, praise: 0, viewsNum: 0, status: 1, top: 0, isDel: 0, addTime: timestamp };
      const rows = await tx.insert(storeProductReply).values(expected).returning(), reply = rows[0];
      if (rows.length !== 1 || !reply || !Number.isSafeInteger(reply.id) || reply.id <= 0 || !sameRow(reply, { id: reply.id, ...expected })) throw new Error('虚拟评价新增回执不完整');
      await this.verifyReply(tx, reply);
      const rated = await refreshProductReviewStar(tx, before);
      await this.audit(tx, actor, reply, sku);
      await this.verifyReply(tx, reply); await verifyReviewProductSnapshot(tx, rated);
      if (sku && !sameRow(await this.selectedSku(tx, before.id, input.skuUnique, false), sku)) throw new Error('虚拟评价SKU完整回执核验失败');
      await verifyFictitiousReplyMedia(tx, actor, mediaProof);
      return { id: reply.id };
    });
  }

  async products(query: URLSearchParams, actor: AdminProductFictitiousReplyActor) {
    const input = queryInput(query, ['page', 'limit', 'ids', 'cate_id', 'store_name', 'is_integral', 'type', 'is_live', 'is_new', 'is_vip_product', 'is_presale_product', 'store_label_id', 'is_supplier']);
    const page = input.page === undefined ? 1 : fictitiousProductId(input.page), limit = input.limit === undefined ? 10 : fictitiousProductId(input.limit);
    if (page > 1_000_000 || limit > 100 || (page - 1) * limit > MAX_ID) throw new ValidateException('商品分页超出范围');
    const ids = queryIds(input.ids), labels = queryIds(input.store_label_id), category = input.cate_id === undefined || input.cate_id === '' ? undefined : fictitiousProductId(input.cate_id);
    const rawKeyword = input.store_name === undefined ? '' : text(input.store_name, '商品关键词', 128, false), keyword = rawKeyword.trim();
    const supplier = queryChoice(input.is_supplier, ['-1', '0', '1'], '-1'), live = queryChoice(input.is_live, ['0', '1', ''], '0');
    queryChoice(input.is_integral, ['0', '1', ''], '0');
    const isNew = queryChoice(input.is_new, ['0', '1', ''], '');
    const vip = queryChoice(input.is_vip_product, ['-1', '0', '1', ''], ''), presale = queryChoice(input.is_presale_product, ['0', '1', ''], '');
    const status = queryChoice(input.type, ['-2', '-1', '0', '1', '2', '3', '4', '5', '6', '7', ''], '');
    return this.transaction(actor, false, 'product.view', async tx => {
      const conditions: SQL[] = [eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1), sql`((${storeProduct.type}=0 AND ${storeProduct.relationId}=0) OR (${storeProduct.type} IN (1,2) AND ${storeProduct.relationId}>0))`];
      if (supplier === '1') conditions.push(eq(storeProduct.type, 2));
      if (rawKeyword && rawKeyword !== '0') {
        const pattern = `%${keyword}%`;
        conditions.push(or(sql`${storeProduct.id}::text ILIKE ${pattern}`, ilike(storeProduct.keyword, pattern), ilike(storeProduct.storeName, pattern),
          ilike(storeProduct.storeInfo, pattern), ilike(storeProduct.barCode, pattern), sql`EXISTS (SELECT 1 FROM ${storeProductAttrValue} WHERE ${storeProductAttrValue.productId}=${storeProduct.id} AND ${storeProductAttrValue.barCode}=${keyword})`)!);
      }
      if (category !== undefined) {
        const [selected] = await tx.select().from(storeProductCategory).where(eq(storeProductCategory.id, category)).limit(1);
        const categoryPredicate = selected?.pid ? sql`(${storeProductCategory.id}=${category} OR ${storeProductCategory.pid}=${category})`
          : sql`(${storeProductCategory.id}=${category} OR ${category}::text=ANY(string_to_array(${storeProductCategory.path}, ',')))`;
        conditions.push(sql`EXISTS (SELECT 1 FROM ${storeProductRelation} JOIN ${storeProductCategory} ON ${storeProductCategory.id}=${storeProductRelation.relationId}
          WHERE ${storeProductRelation.productId}=${storeProduct.id} AND ${storeProductRelation.type}=1 AND ${categoryPredicate})`);
      }
      if (labels) conditions.push(sql`EXISTS (SELECT 1 FROM ${storeProductRelation} WHERE ${storeProductRelation.productId}=${storeProduct.id} AND ${storeProductRelation.type}=3 AND ${inArray(storeProductRelation.relationId, labels)})`);
      // PHP's is_new searcher uses built-in label 4, not the is_new column.
      if (isNew === '1') conditions.push(sql`EXISTS (SELECT 1 FROM ${storeProductRelation} WHERE ${storeProductRelation.productId}=${storeProduct.id} AND ${storeProductRelation.type}=3 AND ${storeProductRelation.relationId}=4)`);
      if (vip !== '' && vip !== '-1') conditions.push(eq(storeProduct.isVipProduct, Number(vip)));
      if (presale !== '') conditions.push(eq(storeProduct.isPresaleProduct, Number(presale)));
      if (live === '1') conditions.push(sql`NOT EXISTS (SELECT 1 FROM ${liveGoods} WHERE ${liveGoods.productId}=${storeProduct.id} AND ${liveGoods.isDel}=0 AND ${liveGoods.auditStatus}<>3)`);
      if (['-2', '-1', '0', '6'].includes(status)) conditions.push(sql`FALSE`);
      if (status === '1') conditions.push(eq(storeProduct.isShow, 1));
      if (status === '2' || status === '7') conditions.push(eq(storeProduct.isShow, 0));
      if (status === '4') conditions.push(or(eq(storeProduct.isSold, 1), eq(storeProduct.stock, 0))!);
      if (status === '5') conditions.push(eq(storeProduct.isShow, 1), eq(storeProduct.isPolices, 1), gt(storeProduct.stock, 0));
      // is_integral has no StoreProduct searcher; source search(false) ignores
      // it. ids controls list ordering, while PHP's Supplier count omits ids.
      const countConditions = ids && supplier !== '1' ? [...conditions, inArray(storeProduct.id, ids)] : conditions;
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(storeProduct).where(and(...countConditions));
      const listConditions = ids ? [...conditions, inArray(storeProduct.id, ids)] : conditions;
      const order = ids ? sql`CASE ${storeProduct.id} ${sql.join(ids.map((id, index) => sql`WHEN ${id} THEN ${index}`), sql` `)} END` : desc(storeProduct.sort);
      const rows = await tx.select().from(storeProduct).where(and(...listConditions)).orderBy(order, desc(storeProduct.id)).limit(limit).offset((page - 1) * limit);
      const productIds = rows.map(row => row.id), skuRows: SkuRow[] = [];
      for (const row of rows) {
        const skus = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, row.id), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0)))
          .orderBy(asc(storeProductAttrValue.id)).limit(MAX_SKUS + 1);
        if (skus.length > MAX_SKUS) throw new ServiceUnavailableException('商品普通规格超过200项，请先整理数据');
        const aliases = skus.map(sku => sku.unique);
        if (aliases.some(alias => !alias || [...alias].length > 8 || invalidText.test(alias)) || new Set(aliases).size !== aliases.length) throw new ServiceUnavailableException('商品普通规格唯一标识异常或存在歧义，请核对数据');
        skuRows.push(...skus);
      }
      const cateIds = [...new Set(rows.flatMap(row => csv(row.cateId)))], labelIds = [...new Set(rows.flatMap(row => csv(row.storeLabelId)))];
      const categories = cateIds.length ? await tx.select().from(storeProductCategory).where(inArray(storeProductCategory.id, cateIds)) : [];
      const parentIds = [...new Set(categories.map(row => row.pid).filter(Boolean))];
      const parents = parentIds.length ? await tx.select().from(storeProductCategory).where(inArray(storeProductCategory.id, parentIds)) : [];
      const categoryMap = new Map([...parents, ...categories].map(row => [row.id, row]));
      const labelRows = labelIds.length ? await tx.select().from(storeProductLabel).where(and(inArray(storeProductLabel.id, labelIds), eq(storeProductLabel.type, 0), eq(storeProductLabel.relationId, 0))) : [];
      const descriptions = productIds.length ? await tx.select().from(storeProductDescription).where(and(inArray(storeProductDescription.productId, productIds), eq(storeProductDescription.type, 0))) : [];
      if (new Set(descriptions.map(row => row.productId)).size !== descriptions.length) throw new ServiceUnavailableException('商品详情存在重复记录，请核对数据');
      const list = rows.map(row => productDto(row, skuRows.filter(sku => sku.productId === row.id), categoryMap,
        new Map(labelRows.map(label => [label.id, label.labelName])), descriptions.find(item => item.productId === row.id)?.description ?? null));
      await this.renderSelectorImages(tx, rows, list);
      return { count, list };
    });
  }
}
