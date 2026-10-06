import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import {
  storeBrand, storeProduct, storeProductLabel, storePromotions,
  storePromotionsAuxiliary, systemLog,
} from '@/models/schema';
import { HttpApiException, NotFoundException, ValidateException } from '@/utils/errors';

type FrameRow = typeof storePromotions.$inferSelect;
type AuxiliaryRow = typeof storePromotionsAuxiliary.$inferSelect;
type Scope = 1 | 2 | 3 | 4 | 5;
type Operation = 'create' | 'update' | 'status' | 'delete';
type Window = { start: number; end: number };
type ListQuery = {
  page: number; limit: number; name: string; status: -1 | 0 | 1 | null;
  time: Window | null; createTime: Window | null;
};
type ChoiceQuery = { page: number; limit: number; keyword: string };
type FrameInput = {
  name: string; image: string; productPartakeType: Scope; productIds: number[];
  brandIds: number[]; labelIds: number[]; startTime: number; stopTime: number;
  status: 0 | 1; sort: number;
};
type MutationInput = { requestId: string; revision: string | null; frame: FrameInput | null; status: 0 | 1 | null };

/** Fixed server-owned identities. Never derive promotions_type from a request body. */
export type DecorativePromotionKind = Readonly<{
  promotionsType: 5 | 6; noun: '活动边框' | '活动背景'; slug: 'activity-frame' | 'activity-background';
  logType: 'activity_frame' | 'activity_background'; advisoryNamespace: 'admin_activity_frame' | 'admin_activity_background';
}>;
const FRAME_KIND: DecorativePromotionKind = {
  promotionsType: 5, noun: '活动边框', slug: 'activity-frame',
  logType: 'activity_frame', advisoryNamespace: 'admin_activity_frame',
};
export const BACKGROUND_KIND: DecorativePromotionKind = {
  promotionsType: 6, noun: '活动背景', slug: 'activity-background',
  logType: 'activity_background', advisoryNamespace: 'admin_activity_background',
};
function rootScope(kind: DecorativePromotionKind) { return and(
  eq(storePromotions.promotionsType, kind.promotionsType), eq(storePromotions.type, 1),
  eq(storePromotions.storeId, 0), eq(storePromotions.pid, 0), eq(storePromotions.isDel, 0),
); }
const queryLimit = 50;
const selectionLimit = 10_000;
const datePattern = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const requestPattern = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

function failConflict(message: string): never { throw new HttpApiException(message, 409, 409); }
function idValue(value: unknown, label: string): number {
  const string = typeof value === 'number' ? String(value) : value;
  if (typeof string !== 'string' || !/^[1-9]\d{0,9}$/.test(string)) throw new ValidateException(`${label}无效`);
  const parsed = Number(string);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) throw new ValidateException(`${label}无效`);
  return parsed;
}
function boundedNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ValidateException(`${label}无效`);
  return value;
}
function pageNumber(raw: string | null, fallback: number, max: number, label: string): number {
  if (raw === null) return fallback;
  if (!/^[1-9]\d{0,7}$/.test(raw) || Number(raw) > max) throw new ValidateException(`${label}无效`);
  return Number(raw);
}
function queryShape(parameters: URLSearchParams, keys: string[], noun: string): void {
  for (const key of parameters.keys()) if (!keys.includes(key) || parameters.getAll(key).length !== 1) {
    throw new ValidateException(`${noun}查询包含不支持或重复的参数`);
  }
}
function safeText(value: unknown, label: string, max: number, required: boolean): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new ValidateException(`${label}无效`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ValidateException(`${label}不能为空`);
  return trimmed;
}
function imageReference(value: unknown): string {
  const image = safeText(value, '活动图', 255, true);
  if (!/^(https:\/\/|\/(?!\/))/u.test(image) || /[\u0000-\u0020\u007f\\]/u.test(image)) {
    throw new ValidateException('活动图地址无效');
  }
  return image;
}
function epochShanghai(value: string, label: string): number {
  const match = datePattern.exec(value);
  if (!match) throw new ValidateException(`${label}须为上海时间 YYYY-MM-DD HH:mm:ss`);
  const [, year, month, day, hour, minute, second] = match;
  const utc = Date.UTC(+year, +month - 1, +day, +hour - 8, +minute, +second);
  if (!Number.isFinite(utc)) throw new ValidateException(`${label}无效`);
  const date = new Date(utc + 8 * 3_600_000);
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() + 1 !== +month || date.getUTCDate() !== +day
    || date.getUTCHours() !== +hour || date.getUTCMinutes() !== +minute || date.getUTCSeconds() !== +second) {
    throw new ValidateException(`${label}无效`);
  }
  const epoch = Math.floor(utc / 1000);
  if (epoch < 1 || epoch > 2_147_483_647) throw new ValidateException(`${label}超出范围`);
  return epoch;
}
function windowValue(value: string | null, label: string): Window | null {
  if (value === null || value === '') return null;
  const parts = value.split(' - ');
  if (parts.length !== 2) throw new ValidateException(`${label}时间范围无效`);
  const start = epochShanghai(parts[0], `${label}开始`), end = epochShanghai(parts[1], `${label}结束`);
  if (end < start) throw new ValidateException(`${label}结束不能早于开始`);
  return { start, end };
}
function ids(value: unknown, label: string): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > selectionLimit) throw new ValidateException(`${label}数量超出范围`);
  return [...new Set(value.map(item => idValue(item, label)))];
}
function objectKeys(raw: Record<string, unknown>, allowed: string[], noun: string): void {
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new ValidateException(`不支持的${noun}字段：${key}`);
}
function flag(value: unknown, label: string): 0 | 1 {
  return boundedNumber(value, label, 0, 1) as 0 | 1;
}
function parseMutation(operation: Operation, raw: Record<string, unknown>, noun: string): MutationInput {
  objectKeys(raw, operation === 'create' || operation === 'update'
    ? ['name', 'image', 'product_partake_type', 'product_id', 'brand_id', 'store_label_id', 'section_time', 'status', 'sort', 'request_id', ...(operation === 'update' ? ['revision'] : [])]
    : ['request_id', 'revision', ...(operation === 'status' ? ['status'] : [])], noun);
  if (typeof raw.request_id !== 'string' || !requestPattern.test(raw.request_id)) throw new ValidateException('请求标识必须是UUID');
  const revision = operation === 'create' ? null : raw.revision;
  if (operation !== 'create' && (typeof revision !== 'string' || !/^[a-f\d]{64}$/.test(revision))) throw new ValidateException(`${noun}版本无效，请刷新`);
  if (operation === 'status') return { requestId: raw.request_id.toLowerCase(), revision: revision as string, frame: null, status: flag(raw.status, '活动状态') };
  if (operation === 'delete') return { requestId: raw.request_id.toLowerCase(), revision: revision as string, frame: null, status: null };
  const scope = boundedNumber(raw.product_partake_type, '商品参与类型', 1, 5) as Scope;
  if (![1, 2, 3, 4, 5].includes(scope)) throw new ValidateException('商品参与类型无效');
  if (!Array.isArray(raw.section_time) || raw.section_time.length !== 2 || raw.section_time.some(value => typeof value !== 'string')) {
    throw new ValidateException('请选择活动时间');
  }
  const [start, stop] = raw.section_time as string[];
  const startTime = epochShanghai(start, '活动开始时间'), stopTime = epochShanghai(stop, '活动结束时间');
  if (stopTime < startTime) throw new ValidateException('活动结束时间不能早于开始时间');
  const productIds = ids(raw.product_id, '关联商品ID'), brandIds = ids(raw.brand_id, '关联品牌ID'), labelIds = ids(raw.store_label_id, '关联标签ID');
  if (scope === 2 && !productIds.length) throw new ValidateException('请选择要参与活动的商品');
  if (scope === 3 && !productIds.length) throw new ValidateException('请选择要排除的商品');
  if (scope === 4 && !brandIds.length) throw new ValidateException('请选择要参与活动的商品品牌');
  if (scope === 5 && !labelIds.length) throw new ValidateException('请选择要参与活动的商品标签');
  return { requestId: raw.request_id.toLowerCase(), revision: revision as string | null, status: null,
    frame: { name: safeText(raw.name, '活动名称', 255, true), image: imageReference(raw.image),
      productPartakeType: scope, productIds: scope === 2 || scope === 3 ? productIds : [],
      brandIds: scope === 4 ? brandIds : [], labelIds: scope === 5 ? labelIds : [],
      startTime, stopTime, status: flag(raw.status ?? 1, '活动状态'),
      sort: boundedNumber(raw.sort ?? 0, '排序', 0, 32_767) } };
}

export function parseAdminActivityFrameListQuery(parameters: URLSearchParams, noun = '活动边框'): ListQuery {
  queryShape(parameters, ['page', 'limit', 'name', 'status', 'time', 'create_time'], noun);
  const page = pageNumber(parameters.get('page'), 1, 100_000, '页码');
  const limit = pageNumber(parameters.get('limit'), 15, queryLimit, '每页条数');
  if ((page - 1) * limit > 100_000) throw new ValidateException('分页偏移超出范围');
  const stage = parameters.get('status');
  if (stage !== null && stage !== '' && !['-1', '0', '1'].includes(stage)) throw new ValidateException('活动阶段无效');
  return { page, limit, name: safeText(parameters.get('name') ?? '', '活动名称筛选', 200, false),
    status: stage === null || stage === '' ? null : Number(stage) as -1 | 0 | 1,
    time: windowValue(parameters.get('time'), '活动'), createTime: windowValue(parameters.get('create_time'), '创建') };
}
export function parseAdminActivityFrameChoiceQuery(parameters: URLSearchParams, noun = '活动边框'): ChoiceQuery {
  queryShape(parameters, ['page', 'limit', 'keyword'], noun);
  const page = pageNumber(parameters.get('page'), 1, 100_000, '页码');
  const limit = pageNumber(parameters.get('limit'), 15, queryLimit, '每页条数');
  if ((page - 1) * limit > 100_000) throw new ValidateException('分页偏移超出范围');
  return { page, limit, keyword: safeText(parameters.get('keyword') ?? '', '选项搜索', 200, false) };
}
function shanghai(epoch: number): string {
  if (!epoch) return '';
  const date = new Date((epoch + 8 * 3600) * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}
async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function scopeIds(row: FrameRow, auxiliary: AuxiliaryRow[]) {
  const selected = auxiliary.filter(item => item.type === 1 && item.productPartakeType === row.productPartakeType);
  return { product_id: [...new Set(selected.map(item => item.productId).filter(Boolean))],
    brand_id: [...new Set(selected.map(item => item.brandId).filter(Boolean))],
    store_label_id: [...new Set(selected.map(item => item.storeLabelId).filter(Boolean))] };
}
async function revision(row: FrameRow, auxiliary: AuxiliaryRow[]): Promise<string> {
  return hash({ row, auxiliary: [...auxiliary].sort((a, b) => a.id - b.id) });
}
async function clock(tx: DbClient): Promise<number> {
  const [now] = await tx.execute(sql<{ epoch: number }>`SELECT EXTRACT(EPOCH FROM clock_timestamp())::integer AS epoch`);
  const epoch = Number(now?.epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new ValidateException('数据库时间无效');
  return epoch;
}
async function auxiliary(tx: DbClient, id: number): Promise<AuxiliaryRow[]> {
  return tx.select().from(storePromotionsAuxiliary).where(and(eq(storePromotionsAuxiliary.promotionsId, id), eq(storePromotionsAuxiliary.type, 1)))
    .orderBy(asc(storePromotionsAuxiliary.id));
}
function stage(row: FrameRow, now: number): { start_status: -1 | 0 | 1; start_name: string } {
  if (!row.status || row.stopTime < now) return { start_status: -1, start_name: '已结束' };
  if (row.startTime > now) return { start_status: 0, start_name: '未开始' };
  return { start_status: 1, start_name: '进行中' };
}
async function productCount(tx: DbClient, row: FrameRow, noun: string): Promise<number> {
  const [result] = await tx.execute(sql<{ count: number }>`
    SELECT COUNT(*)::integer AS count FROM store_product p
    WHERE p.pid=0 AND p.is_show=1 AND p.is_del=0 AND p.is_verify=1 AND (
      ${row.productPartakeType} = 1
      OR (${row.productPartakeType} = 2 AND EXISTS (
        SELECT 1 FROM store_promotions_auxiliary a WHERE a.promotions_id=${row.id} AND a.type=1
          AND a.product_partake_type=2 AND a.product_id=p.id))
      OR (${row.productPartakeType} = 3 AND NOT EXISTS (
        SELECT 1 FROM store_promotions_auxiliary a WHERE a.promotions_id=${row.id} AND a.type=1
          AND a.product_partake_type=3 AND a.is_all=1 AND a.product_id=p.id))
      OR (${row.productPartakeType} = 4 AND EXISTS (
        SELECT 1 FROM store_promotions_auxiliary a JOIN store_product_relation r
          ON r.type=2 AND r.relation_id=a.brand_id AND r.product_id=p.id
        WHERE a.promotions_id=${row.id} AND a.type=1 AND a.product_partake_type=4))
      OR (${row.productPartakeType} = 5 AND EXISTS (
        SELECT 1 FROM store_promotions_auxiliary a JOIN store_product_relation r
          ON r.type=3 AND r.relation_id=a.store_label_id AND r.product_id=p.id
        WHERE a.promotions_id=${row.id} AND a.type=1 AND a.product_partake_type=5))
    )`);
  const count = Number(result?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new ValidateException(`${noun}商品数量无效`);
  return count;
}
async function projected(tx: DbClient, row: FrameRow, now: number, includeCount: boolean, noun: string) {
  const linked = await auxiliary(tx, row.id), choices = scopeIds(row, linked);
  return { ...row, ...choices, start_time: shanghai(row.startTime), stop_time: shanghai(row.stopTime),
    add_time: shanghai(row.addTime), update_time: shanghai(row.updateTime),
    product_partake_type: row.productPartakeType, ...stage(row, now),
    ...(includeCount ? { product_count: await productCount(tx, row, noun) } : {}),
    revision: await revision(row, linked) };
}
async function validateScope(tx: DbClient, input: FrameInput): Promise<void> {
  const expected = input.productPartakeType === 2 || input.productPartakeType === 3 ? input.productIds
    : input.productPartakeType === 4 ? input.brandIds : input.productPartakeType === 5 ? input.labelIds : [];
  if (!expected.length) return;
  if (input.productPartakeType === 2 || input.productPartakeType === 3) {
    const rows = await tx.select({ id: storeProduct.id }).from(storeProduct).where(and(inArray(storeProduct.id, expected),
      eq(storeProduct.pid, 0), eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0),
      eq(storeProduct.isVerify, 1))).orderBy(asc(storeProduct.id)).for('share');
    if (rows.length !== expected.length) throw new ValidateException('选择商品中有子商品、待审核、已下架或移入回收站');
  } else if (input.productPartakeType === 4) {
    const rows = await tx.select({ id: storeBrand.id }).from(storeBrand).where(and(inArray(storeBrand.id, expected),
      eq(storeBrand.isShow, 1), eq(storeBrand.isDel, 0))).orderBy(asc(storeBrand.id)).for('share');
    if (rows.length !== expected.length) throw new ValidateException('选择商品品牌中有已下架或删除的');
  } else {
    const rows = await tx.select({ id: storeProductLabel.id }).from(storeProductLabel)
      .where(inArray(storeProductLabel.id, expected)).orderBy(asc(storeProductLabel.id)).for('share');
    if (rows.length !== expected.length) throw new ValidateException('选择商品标签中有已下架或删除的');
  }
}

export class AdminActivityFrameService {
  constructor(private readonly container: Container) {}
  protected get promotionKind(): DecorativePromotionKind { return FRAME_KIND; }

  async list(parameters: URLSearchParams) {
    const kind = this.promotionKind, query = parseAdminActivityFrameListQuery(parameters, kind.noun);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const now = await clock(tx), conditions: SQL[] = [rootScope(kind)!];
      if (query.name) {
        conditions.push(sql`(POSITION(lower(${query.name}) IN lower(CAST(${storePromotions.id} AS text))) > 0
          OR POSITION(lower(${query.name}) IN lower(${storePromotions.name})) > 0
          OR POSITION(lower(${query.name}) IN lower(COALESCE(${storePromotions.description},''))) > 0)`);
      }
      if (query.status === -1) conditions.push(sql`(${storePromotions.stopTime} < ${now} OR ${storePromotions.status}=0)`);
      if (query.status === 0) conditions.push(and(eq(storePromotions.status, 1), sql`${storePromotions.startTime} > ${now}`)!);
      if (query.status === 1) conditions.push(and(eq(storePromotions.status, 1), sql`${storePromotions.startTime} <= ${now}`, sql`${storePromotions.stopTime} >= ${now}`)!);
      if (query.time) conditions.push(sql`${storePromotions.startTime} <= ${query.time.end} AND ${storePromotions.stopTime} >= ${query.time.start}`);
      if (query.createTime) conditions.push(sql`${storePromotions.addTime} BETWEEN ${query.createTime.start} AND ${query.createTime.end}`);
      const where = and(...conditions);
      const rows = await tx.select().from(storePromotions).where(where)
        .orderBy(sql`${storePromotions.updateTime} DESC`, sql`${storePromotions.id} DESC`)
        .limit(query.limit).offset((query.page - 1) * query.limit);
      const [count] = await tx.select({ value: sql<number>`COUNT(*)::integer` }).from(storePromotions).where(where);
      return { list: await Promise.all(rows.map(row => projected(tx, row, now, true, kind.noun))), count: count.value,
        page: query.page, limit: query.limit };
    });
  }

  async detail(value: unknown) {
    const kind = this.promotionKind, id = idValue(value, `${kind.noun}ID`);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const [row] = await tx.select().from(storePromotions).where(and(rootScope(kind), eq(storePromotions.id, id))).limit(1);
      if (!row) throw new NotFoundException(`${kind.noun}不存在`);
      const info = await projected(tx, row, await clock(tx), true, kind.noun);
      const productIds = info.product_id;
      const products = productIds.length ? await tx.select({ id: storeProduct.id,
        store_name: storeProduct.storeName, image: storeProduct.image, price: storeProduct.price,
        stock: storeProduct.stock, cate_id: storeProduct.cateId,
        cate_name: sql<string>`COALESCE((SELECT string_agg(DISTINCT c.cate_name, ',')
          FROM store_product_relation r JOIN store_product_category c ON c.id=r.relation_id
          WHERE r.product_id="store_product"."id" AND r.type=1),'')`, is_show: storeProduct.isShow,
        is_del: storeProduct.isDel, is_verify: storeProduct.isVerify }).from(storeProduct)
        .where(inArray(storeProduct.id, productIds)).orderBy(asc(storeProduct.id)) : [];
      const brandIds = info.brand_id, labelIds = info.store_label_id;
      const brands = brandIds.length ? await tx.select({ id: storeBrand.id, brand_name: storeBrand.brandName })
        .from(storeBrand).where(inArray(storeBrand.id, brandIds)).orderBy(asc(storeBrand.id)) : [];
      const labels = labelIds.length ? await tx.select({ id: storeProductLabel.id, label_name: storeProductLabel.labelName })
        .from(storeProductLabel).where(inArray(storeProductLabel.id, labelIds)).orderBy(asc(storeProductLabel.id)) : [];
      return { info: { ...info, products, brands, labels } };
    });
  }

  async choices(kind: 'products' | 'brands' | 'labels', parameters: URLSearchParams) {
    const query = parseAdminActivityFrameChoiceQuery(parameters, this.promotionKind.noun);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const offset = (query.page - 1) * query.limit;
      if (kind === 'products') {
        const where = sql`p.pid=0 AND p.is_show=1 AND p.is_del=0 AND p.is_verify=1 ${query.keyword
          ? sql`AND (p.id::text=${query.keyword} OR POSITION(lower(${query.keyword}) IN lower(p.store_name))>0)` : sql``}`;
        const list = await tx.execute(sql<{ id: number; store_name: string; image: string; price: string; stock: number; cate_name: string }>`
          SELECT p.id,p.store_name,p.image,p.price,p.stock,
            COALESCE((SELECT string_agg(DISTINCT c.cate_name, ',') FROM store_product_relation r
              JOIN store_product_category c ON c.id=r.relation_id WHERE r.product_id=p.id AND r.type=1),'') AS cate_name
          FROM store_product p WHERE ${where} ORDER BY p.id DESC LIMIT ${query.limit} OFFSET ${offset}`);
        const [count] = await tx.execute(sql<{ count: number }>`SELECT COUNT(*)::integer AS count FROM store_product p WHERE ${where}`);
        return { list, count: count.count, page: query.page, limit: query.limit };
      }
      if (kind === 'brands') {
        const where = sql`b.is_show=1 AND b.is_del=0 ${query.keyword
          ? sql`AND (b.id::text=${query.keyword} OR POSITION(lower(${query.keyword}) IN lower(b.brand_name))>0)` : sql``}`;
        const list = await tx.execute(sql<{ id: number; brand_name: string }>`SELECT b.id,b.brand_name FROM store_brand b
          WHERE ${where} ORDER BY b.sort DESC,b.id DESC LIMIT ${query.limit} OFFSET ${offset}`);
        const [count] = await tx.execute(sql<{ count: number }>`SELECT COUNT(*)::integer AS count FROM store_brand b WHERE ${where}`);
        return { list, count: count.count, page: query.page, limit: query.limit };
      }
      const where = query.keyword ? sql`(l.id::text=${query.keyword} OR POSITION(lower(${query.keyword}) IN lower(l.label_name))>0)` : sql`TRUE`;
      const list = await tx.execute(sql<{ id: number; label_name: string }>`SELECT l.id,l.label_name FROM store_product_label l
        WHERE ${where} ORDER BY l.sort DESC,l.id DESC LIMIT ${query.limit} OFFSET ${offset}`);
      const [count] = await tx.execute(sql<{ count: number }>`SELECT COUNT(*)::integer AS count FROM store_product_label l WHERE ${where}`);
      return { list, count: count.count, page: query.page, limit: query.limit };
    });
  }

  async mutate(operation: Operation, value: unknown, raw: Record<string, unknown>, actor: { id: number }) {
    const kind = this.promotionKind, id = operation === 'create' ? 0 : idValue(value, `${kind.noun}ID`);
    idValue(actor.id, '管理员ID');
    const input = parseMutation(operation, raw, kind.noun);
    const payload = await hash({ operation, id, revision: input.revision, frame: input.frame, status: input.status });
    const path = `/marketing/${kind.slug}/request/${input.requestId}`;
    return withTx(this.container, async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${kind.advisoryNamespace}),hashtext(${`${actor.id}:${input.requestId}`}))`);
      const logs = await tx.select({ action: systemLog.action }).from(systemLog)
        .where(and(eq(systemLog.adminId, actor.id), eq(systemLog.type, kind.logType), eq(systemLog.path, path)))
        .orderBy(sql`${systemLog.id} DESC`).limit(2);
      if (logs.length) {
        const replay = /^([a-z]+);id=([1-9]\d{0,9});payload=([a-f\d]{64})$/.exec(logs[0].action);
        if (logs.length !== 1 || !replay || replay[1] !== operation || replay[3] !== payload) failConflict(`请求标识已用于其他${kind.noun}操作`);
        return { id: Number(replay[2]) };
      }
      const now = await clock(tx);
      let row: FrameRow | undefined;
      if (id) {
        [row] = await tx.select().from(storePromotions).where(and(rootScope(kind), eq(storePromotions.id, id))).limit(1).for('update');
        if (!row) throw new NotFoundException(`${kind.noun}不存在`);
        if (await revision(row, await auxiliary(tx, id)) !== input.revision) failConflict(`${kind.noun}已更新，请刷新后重试`);
      }
      let resultId = id;
      if (operation === 'create' || operation === 'update') {
        const frame = input.frame!;
        if (frame.stopTime < now) throw new ValidateException('活动结束时间不能小于当前时间');
        await validateScope(tx, frame);
        const patch = { name: frame.name, image: frame.image, productPartakeType: frame.productPartakeType,
          productId: frame.productIds.join(','), startTime: frame.startTime, stopTime: frame.stopTime,
          status: frame.status, sort: frame.sort, updateTime: Math.max(now, (row?.updateTime ?? 0) + 1) };
        if (row) await tx.update(storePromotions).set(patch).where(eq(storePromotions.id, id));
        else {
          const [created] = await tx.insert(storePromotions).values({ ...patch, promotionsType: kind.promotionsType,
            type: 1, storeId: 0, pid: 0, isDel: 0, addTime: now }).returning({ id: storePromotions.id });
          resultId = created.id;
        }
        await tx.delete(storePromotionsAuxiliary).where(and(eq(storePromotionsAuxiliary.promotionsId, resultId), eq(storePromotionsAuxiliary.type, 1)));
        const entries = frame.productPartakeType === 1 ? []
          : frame.productPartakeType === 2 || frame.productPartakeType === 3
            ? frame.productIds.map(productId => ({ productId }))
            : frame.productPartakeType === 4 ? frame.brandIds.map(brandId => ({ brandId }))
              : frame.labelIds.map(storeLabelId => ({ storeLabelId }));
        if (entries.length) {
          // Bounded chunks keep PostgreSQL's parameter count below the wire limit.
          for (let index = 0; index < entries.length; index += 1000) {
            await tx.insert(storePromotionsAuxiliary).values(entries.slice(index, index + 1000)
              .map(entry => ({ type: 1, promotionsId: resultId, productPartakeType: frame.productPartakeType,
                // Public catalogue and V2 promotion consumers exclude only is_all=1.
                isAll: 1, ...entry })));
          }
        }
      } else if (operation === 'status') {
        if (input.status === 1) {
          if (row!.stopTime < now || row!.startTime > row!.stopTime || !row!.name || !row!.image
            || ![1, 2, 3, 4, 5].includes(row!.productPartakeType)) {
            throw new ValidateException(`${kind.noun}已过期或配置不完整`);
          }
          const linkedRows = await auxiliary(tx, id), linked = scopeIds(row!, linkedRows);
          if ((row!.productPartakeType === 2 || row!.productPartakeType === 3) && !linked.product_id.length
            || row!.productPartakeType === 4 && !linked.brand_id.length
            || row!.productPartakeType === 5 && !linked.store_label_id.length
            || row!.productPartakeType === 3 && linkedRows.some(item => item.productPartakeType === 3 && item.isAll !== 1)) {
            throw new ValidateException(`${kind.noun}关联商品范围不完整`);
          }
          await validateScope(tx, { name: row!.name, image: row!.image,
            productPartakeType: row!.productPartakeType as Scope, productIds: linked.product_id,
            brandIds: linked.brand_id, labelIds: linked.store_label_id,
            startTime: row!.startTime, stopTime: row!.stopTime, status: 1, sort: row!.sort });
        }
        await tx.update(storePromotions).set({ status: input.status!, updateTime: Math.max(now, row!.updateTime + 1) })
          .where(eq(storePromotions.id, id));
      } else {
        const children = await tx.select({ id: storePromotions.id }).from(storePromotions)
          .where(and(eq(storePromotions.pid, id), eq(storePromotions.promotionsType, kind.promotionsType),
            eq(storePromotions.isDel, 0))).orderBy(asc(storePromotions.id)).for('update');
        await tx.update(storePromotions).set({ isDel: 1, updateTime: Math.max(now, row!.updateTime + 1) })
          .where(inArray(storePromotions.id, [id, ...children.map(child => child.id)]));
      }
      await tx.insert(systemLog).values({ adminId: actor.id, type: kind.logType, page: `/marketing/${kind.slug}`,
        path, method: operation === 'create' ? 'POST' : operation === 'update' ? 'PUT' : operation === 'status' ? 'PATCH' : 'DELETE',
        action: `${operation};id=${resultId};payload=${payload}`, addTime: now });
      return { id: resultId };
    });
  }
}
