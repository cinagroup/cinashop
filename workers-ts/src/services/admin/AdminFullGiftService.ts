import { and, asc, desc, eq, exists, inArray, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import {
  storeBrand, storeCouponIssue, storeProduct, storeProductAttrValue, storeProductLabel,
  storePromotions, storePromotionsAuxiliary, systemLog, userLabel,
} from '@/models/schema';
import { HttpApiException, NotFoundException, ValidateException } from '@/utils/errors';

type Promotion = typeof storePromotions.$inferSelect;
type Auxiliary = typeof storePromotionsAuxiliary.$inferSelect;
type Scope = 1 | 2 | 3 | 4 | 5;
type Operation = 'create' | 'update' | 'status' | 'delete';
type ProductSelection = { product_id: number; unique: string[] };
type CouponGift = { give_coupon_id: number; give_coupon_num: number };
type ProductGift = { give_product_id: number; unique: string; give_product_num: number };
type Rule = { id: number | null; threshold: number; give_integral: number;
  give_coupon_id: CouponGift[]; give_product_id: ProductGift[] };
type GiftInput = {
  name: string; startTime: number; stopTime: number; cate: 1 | 2;
  thresholdType: 1 | 2; rules: Rule[];
  labelIds: number[]; scope: Scope;
  products: ProductSelection[]; brandIds: number[]; labelIdsProduct: number[];
  status: 0 | 1; sort: number;
};
type Materials = { skuCounts: Map<number, number>; couponAvailable: Map<number, number>;
  giftAvailable: Map<string, number> };
type Mutation = { requestId: string; revision: string | null; input: GiftInput | null; status: 0 | 1 | null };

const requestPattern = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const datePattern = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const selectionLimit = 10_000;
const rootWhere = and(eq(storePromotions.promotionsType, 4), eq(storePromotions.type, 1),
  eq(storePromotions.storeId, 0), eq(storePromotions.pid, 0), eq(storePromotions.isDel, 0));
const activeSku = and(eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0),
  sql`${storeProductAttrValue.unique} <> ''`);
const eligibleProduct = and(eq(storeProduct.pid, 0), eq(storeProduct.isShow, 1),
  eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1));

function failConflict(message: string): never { throw new HttpApiException(message, 409, 409); }
function numberId(value: unknown, label: string): number {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2_147_483_647) {
    throw new ValidateException(`${label}无效`);
  }
  return Number(raw);
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidateException(`${label}无效`);
  }
  return value;
}
function flag(value: unknown, label: string): 0 | 1 { return integer(value, label, 0, 1) as 0 | 1; }
function yuan(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
    || !/^(?:[1-9]\d{0,5}|0)(?:\.\d{1,2})?$/.test(String(value))) {
    throw new ValidateException(`${label}须为大于0且最多两位小数的金额`);
  }
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || cents > 99_999_900) throw new ValidateException(`${label}超出范围`);
  return cents / 100;
}
function rules(value: unknown, cate: 1 | 2, thresholdType: 1 | 2, operation: Operation): Rule[] {
  if (!Array.isArray(value) || !value.length || value.length > 100 || (cate === 2 && value.length !== 1)) {
    throw new ValidateException('满送活动优惠层级数量无效');
  }
  let previous = 0;
  let giftCount = 0;
  const usedIds = new Set<number>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ValidateException('优惠层级结构无效');
    const raw = item as Record<string, unknown>;
    if (Object.keys(raw).some(key => !['id', 'threshold', 'give_integral', 'give_coupon_id', 'give_product_id'].includes(key))) {
      throw new ValidateException('优惠层级结构无效');
    }
    const id = raw.id === undefined || raw.id === null ? null : numberId(raw.id, '优惠层级ID');
    if (operation === 'create' && id !== null) throw new ValidateException('新活动不能指定历史层级ID');
    if (id !== null) {
      if (usedIds.has(id)) throw new ValidateException('优惠层级ID重复');
      usedIds.add(id);
    }
    const threshold = thresholdType === 1 ? yuan(raw.threshold, '优惠门槛')
      : integer(raw.threshold, '优惠件数门槛', 1, 999_999);
    if (threshold <= previous) throw new ValidateException('优惠门槛必须逐级递增');
    previous = threshold;
    const giveIntegral = integer(raw.give_integral ?? 0, '赠送积分', 0, 999_999);
    const couponRaw = raw.give_coupon_id ?? [], productRaw = raw.give_product_id ?? [];
    if (!Array.isArray(couponRaw) || !Array.isArray(productRaw)
      || couponRaw.length > 100 || productRaw.length > 100) throw new ValidateException('赠送内容数量无效');
    const couponIds = new Set<number>(), giftKeys = new Set<string>();
    const coupons = couponRaw.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('赠送优惠券结构无效');
      const entry = value as Record<string, unknown>;
      if (Object.keys(entry).some(key => !['give_coupon_id', 'give_coupon_num'].includes(key))) {
        throw new ValidateException('赠送优惠券结构无效');
      }
      const couponId = numberId(entry.give_coupon_id, '赠送优惠券ID');
      if (couponIds.has(couponId)) throw new ValidateException('赠送优惠券不能重复');
      couponIds.add(couponId);
      return { give_coupon_id: couponId,
        give_coupon_num: integer(entry.give_coupon_num, '赠送优惠券总量', 1, 99_999_999) };
    });
    const products = productRaw.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('赠品结构无效');
      const entry = value as Record<string, unknown>;
      if (Object.keys(entry).some(key => !['give_product_id', 'unique', 'give_product_num'].includes(key))) {
        throw new ValidateException('赠品结构无效');
      }
      const productId = numberId(entry.give_product_id, '赠品商品ID');
      const unique = text(entry.unique, '赠品规格唯一值', 8, true);
      const key = `${productId}:${unique}`;
      if (giftKeys.has(key)) throw new ValidateException('赠品规格不能重复');
      giftKeys.add(key);
      return { give_product_id: productId, unique,
        give_product_num: integer(entry.give_product_num, '赠品总量', 1, 99_999_999) };
    });
    giftCount += coupons.length + products.length;
    if (giftCount > 1_000) throw new ValidateException('赠送内容总量超出范围');
    if (!giveIntegral && !coupons.length && !products.length) throw new ValidateException('每级至少设置一项赠送内容');
    if (index > 0 && cate !== 1) throw new ValidateException('循环满送只能设置一个门槛');
    return { id, threshold, give_integral: giveIntegral,
      give_coupon_id: coupons, give_product_id: products };
  });
}
function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ValidateException(`${label}无效`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new ValidateException(`${label}不能为空`);
  return trimmed;
}
function ids(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length > selectionLimit) throw new ValidateException(`${label}数量无效`);
  return [...new Set(value.map(item => numberId(item, label)))];
}
function epochShanghai(value: unknown, label: string): number {
  if (typeof value !== 'string') throw new ValidateException(`${label}须为上海时间 YYYY-MM-DD HH:mm:ss`);
  const match = datePattern.exec(value);
  if (!match) throw new ValidateException(`${label}须为上海时间 YYYY-MM-DD HH:mm:ss`);
  const [, year, month, day, hour, minute, second] = match;
  const utc = Date.UTC(+year, +month - 1, +day, +hour - 8, +minute, +second);
  const check = new Date(utc + 8 * 3_600_000);
  if (check.getUTCFullYear() !== +year || check.getUTCMonth() + 1 !== +month || check.getUTCDate() !== +day
    || check.getUTCHours() !== +hour || check.getUTCMinutes() !== +minute || check.getUTCSeconds() !== +second) {
    throw new ValidateException(`${label}无效`);
  }
  const epoch = Math.floor(utc / 1_000);
  if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > 2_147_483_647) throw new ValidateException(`${label}超出范围`);
  return epoch;
}
function shanghai(epoch: number): string {
  if (!epoch) return '';
  const date = new Date((epoch + 8 * 3600) * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}
function pageValue(raw: string | null, fallback: number, max: number, label: string): number {
  if (raw === null) return fallback;
  if (!/^[1-9]\d{0,7}$/.test(raw) || Number(raw) > max) throw new ValidateException(`${label}无效`);
  return Number(raw);
}
function query(parameters: URLSearchParams, option: boolean) {
  const allowed = option ? ['page', 'limit', 'keyword'] : ['page', 'limit', 'name', 'status', 'threshold_type'];
  for (const key of parameters.keys()) if (!allowed.includes(key) || parameters.getAll(key).length !== 1) {
    throw new ValidateException('满送活动查询包含不支持或重复的参数');
  }
  const page = pageValue(parameters.get('page'), 1, 100_000, '页码');
  const limit = pageValue(parameters.get('limit'), 15, 50, '每页条数');
  if ((page - 1) * limit > 100_000) throw new ValidateException('分页偏移超出范围');
  const status = parameters.get('status');
  if (!option && status !== null && status !== '' && status !== '0' && status !== '1') {
    throw new ValidateException('活动状态无效');
  }
  const rawThreshold = parameters.get('threshold_type');
  if (!option && rawThreshold !== null && rawThreshold !== '' && rawThreshold !== '1' && rawThreshold !== '2') {
    throw new ValidateException('活动条件类型无效');
  }
  return { page, limit, keyword: text(parameters.get(option ? 'keyword' : 'name') ?? '', '搜索词', 200),
    status: !option && status !== null && status !== '' ? Number(status) as 0 | 1 : null,
    thresholdType: !option && rawThreshold !== null && rawThreshold !== '' ? Number(rawThreshold) as 1 | 2 : null };
}
function selectedProducts(value: unknown): ProductSelection[] {
  if (!Array.isArray(value) || value.length > selectionLimit) throw new ValidateException('关联商品数量无效');
  const seen = new Set<number>();
  let totalSkus = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ValidateException('关联商品结构无效');
    const raw = item as Record<string, unknown>;
    if (Object.keys(raw).some(key => !['product_id', 'unique'].includes(key))) throw new ValidateException('关联商品结构无效');
    const productId = numberId(raw.product_id, '关联商品ID');
    if (seen.has(productId)) throw new ValidateException('关联商品不能重复');
    seen.add(productId);
    if (!Array.isArray(raw.unique) || !raw.unique.length || raw.unique.length > selectionLimit) {
      throw new ValidateException('每个选中商品须明确选择规格');
    }
    const unique = raw.unique.map(value => text(value, '商品规格唯一值', 8, true));
    totalSkus += unique.length;
    if (totalSkus > selectionLimit) throw new ValidateException('选中商品规格数量超出范围');
    if (new Set(unique).size !== unique.length) throw new ValidateException('商品规格不能重复');
    return { product_id: productId, unique };
  });
}
function parseMutation(operation: Operation, raw: Record<string, unknown>): Mutation {
  const allowed = operation === 'create' || operation === 'update'
    ? ['name', 'section_time', 'promotions_cate', 'threshold_type', 'promotions', 'is_label', 'label_id',
      'product_partake_type', 'product_id', 'brand_id', 'store_label_id',
      'status', 'sort', 'request_id', ...(operation === 'update' ? ['revision'] : [])]
    : ['request_id', 'revision', ...(operation === 'status' ? ['status'] : [])];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new ValidateException(`不支持的满送活动字段：${key}`);
  if (typeof raw.request_id !== 'string' || !requestPattern.test(raw.request_id)) throw new ValidateException('请求标识必须是UUID');
  const revision = operation === 'create' ? null : raw.revision;
  if (operation !== 'create' && (typeof revision !== 'string' || !/^[a-f\d]{64}$/.test(revision))) {
    throw new ValidateException('满送活动版本无效，请刷新');
  }
  const requestId = raw.request_id.toLowerCase();
  if (operation === 'delete') return { requestId, revision: revision as string, input: null, status: null };
  if (operation === 'status') return { requestId, revision: revision as string, input: null,
    status: flag(raw.status, '活动状态') };
  if (!Array.isArray(raw.section_time) || raw.section_time.length !== 2) throw new ValidateException('请选择活动时间');
  const startTime = epochShanghai(raw.section_time[0], '活动开始时间');
  const stopTime = epochShanghai(raw.section_time[1], '活动结束时间');
  if (stopTime < startTime) throw new ValidateException('活动结束时间不能早于开始时间');
  const scope = integer(raw.product_partake_type, '商品参与类型', 1, 5) as Scope;
  if (scope === 3) throw new ValidateException('满送活动不支持排除商品范围');
  const products = selectedProducts(raw.product_id ?? []);
  const brandIds = ids(raw.brand_id ?? [], '关联品牌ID');
  const labelIdsProduct = ids(raw.store_label_id ?? [], '商品标签ID');
  const labelIds = ids(raw.label_id ?? [], '用户标签ID');
  if (labelIds.length > 100) throw new ValidateException('付后用户标签最多选择100个');
  if (scope === 2 && !products.length) throw new ValidateException('请选择要参与活动的商品');
  if (scope === 4 && !brandIds.length) throw new ValidateException('请选择要参与活动的商品品牌');
  if (scope === 5 && !labelIdsProduct.length) throw new ValidateException('请选择要参与活动的商品标签');
  const cate = integer(raw.promotions_cate, '优惠模式', 1, 2) as 1 | 2;
  const thresholdType = integer(raw.threshold_type, '门槛类型', 1, 2) as 1 | 2;
  const parsedRules = rules(raw.promotions, cate, thresholdType, operation);
  const isLabel = raw.is_label === undefined ? Number(labelIds.length > 0) : flag(raw.is_label, '用户标签开关');
  if (isLabel && !labelIds.length) throw new ValidateException('请选择用户标签');
  return { requestId, revision: revision as string | null, status: null,
    input: { name: text(raw.name, '活动名称', 255, true), startTime, stopTime,
      cate, thresholdType, rules: parsedRules,
      labelIds: isLabel ? labelIds : [], scope,
      products: scope === 2 ? products : [], brandIds: scope === 4 ? brandIds : [],
      labelIdsProduct: scope === 5 ? labelIdsProduct : [], status: flag(raw.status, '活动状态'),
      sort: integer(raw.sort ?? 0, '排序', 0, 32_767) } };
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function databaseClock(tx: DbClient): Promise<number> {
  const [result] = await tx.execute(sql<{ epoch: number }>`SELECT EXTRACT(EPOCH FROM clock_timestamp())::integer AS epoch`);
  return Number(result.epoch);
}
async function auxiliary(tx: DbClient, id: number): Promise<Auxiliary[]> {
  return tx.select().from(storePromotionsAuxiliary).where(and(eq(storePromotionsAuxiliary.promotionsId, id),
    eq(storePromotionsAuxiliary.type, 1))).orderBy(asc(storePromotionsAuxiliary.id));
}
async function children(tx: DbClient, id: number) {
  return tx.select().from(storePromotions).where(and(eq(storePromotions.pid, id),
    eq(storePromotions.promotionsType, 4))).orderBy(asc(storePromotions.id));
}
async function tiers(tx: DbClient, id: number) {
  return tx.select().from(storePromotions).where(and(eq(storePromotions.pid, id),
    eq(storePromotions.promotionsType, 4), eq(storePromotions.type, 1),
    eq(storePromotions.storeId, 0), eq(storePromotions.isDel, 0)))
    .orderBy(asc(storePromotions.threshold), asc(storePromotions.id));
}
async function revision(tx: DbClient, row: Promotion): Promise<string> {
  const childRows = await children(tx, row.id);
  const giftRows = await tx.select().from(storePromotionsAuxiliary).where(and(
    inArray(storePromotionsAuxiliary.promotionsId, [row.id, ...childRows.map(item => item.id)]),
    inArray(storePromotionsAuxiliary.type, [2, 3]),
  )).orderBy(asc(storePromotionsAuxiliary.id));
  return digest({ row, auxiliary: await auxiliary(tx, row.id), children: childRows, gifts: giftRows });
}
function csv(value: string | null): number[] {
  return (value ?? '').split(',').filter(Boolean).map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
}
function skuList(value: string | null): string[] { return (value ?? '').split(',').map(item => item.trimEnd()).filter(Boolean); }
function stage(row: Promotion, now: number) {
  if (!row.status || row.stopTime < now) return { start_status: -1, start_name: '已结束' };
  if (row.startTime > now) return { start_status: 0, start_name: '未开始' };
  return { start_status: 1, start_name: '进行中' };
}

/** Full-gift does not create a price-saving allocation. Count paid original
 * orders with a purchased cart explicitly carrying this type-4 root/tier ID;
 * never infer participation from an unrelated discount ledger. */
async function fullGiftSales(tx: DbClient, rootId: number) {
  const [summary] = await tx.execute(sql<{ sum_pay_price: string; sum_order: number;
    sum_user: number; old_user: number }>`
    WITH qualified AS (SELECT o.id,o.uid,o.pay_price FROM store_order o
      WHERE o.paid=1 AND o.is_del=0 AND o.is_system_del=0
        AND o.pid IN (0,-1) AND o.refund_status IN (0,3)
        AND EXISTS (SELECT 1 FROM store_order_cart_info c
          WHERE c.oid=o.id AND COALESCE(c.promotions_id,'') ~
            ('(^|,)' || ${rootId}::text || '(,|$)'))),
    buyers AS (SELECT uid,COUNT(*)::integer AS n FROM qualified GROUP BY uid)
    SELECT COALESCE((SELECT SUM(pay_price) FROM qualified),0)::numeric(20,2)::text AS sum_pay_price,
      (SELECT COUNT(*)::integer FROM qualified) AS sum_order,
      (SELECT COUNT(*)::integer FROM buyers) AS sum_user,
      (SELECT COUNT(*)::integer FROM buyers WHERE n>1) AS old_user`);
  const sumUser = Number(summary?.sum_user ?? 0), oldUser = Number(summary?.old_user ?? 0);
  return { sum_pay_price: summary?.sum_pay_price ?? '0.00', sum_order: Number(summary?.sum_order ?? 0),
    sum_user: sumUser, old_user: oldUser, new_user: sumUser - oldUser };
}

export class AdminFullGiftService {
  constructor(private readonly container: Container) {}

  async list(parameters: URLSearchParams) {
    const filter = query(parameters, false);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const now = await databaseClock(tx);
      const where = and(rootWhere,
        filter.status === null ? undefined : eq(storePromotions.status, filter.status),
        filter.thresholdType === null ? undefined : eq(storePromotions.thresholdType, filter.thresholdType),
        filter.keyword ? sql`(POSITION(lower(${filter.keyword}) IN lower(${storePromotions.id}::text))>0
          OR POSITION(lower(${filter.keyword}) IN lower(${storePromotions.name}))>0
          OR POSITION(lower(${filter.keyword}) IN lower(COALESCE(${storePromotions.description},'')))>0)` : undefined);
      const rows = await tx.select().from(storePromotions).where(where)
        .orderBy(desc(storePromotions.updateTime), desc(storePromotions.id))
        .limit(filter.limit).offset((filter.page - 1) * filter.limit);
      const [total] = await tx.select({ count: sql<number>`COUNT(*)::integer` }).from(storePromotions).where(where);
      return { list: await Promise.all(rows.map(row => this.project(tx, row, now))),
        count: total.count, page: filter.page, limit: filter.limit };
    });
  }

  async detail(value: unknown) {
    const id = numberId(value, '满送活动ID');
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const [row] = await tx.select().from(storePromotions).where(and(rootWhere, eq(storePromotions.id, id))).limit(1);
      if (!row) throw new NotFoundException('满送活动不存在');
      const info = await this.project(tx, row, await databaseClock(tx), true);
      const selected = await this.detailSelections(tx, row);
      return { info: { ...info, ...selected,
        selection_issues: [...info.selection_issues, ...selected.selection_issues] } };
    });
  }

  async choices(kind: 'products' | 'brands' | 'labels' | 'user-labels' | 'coupons', parameters: URLSearchParams) {
    const filter = query(parameters, true), offset = (filter.page - 1) * filter.limit;
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      if (kind === 'coupons') {
        const now = new Date((await databaseClock(tx)) * 1_000).toISOString();
        const where = and(eq(storeCouponIssue.receiveType, 3), eq(storeCouponIssue.status, 1),
          eq(storeCouponIssue.isDel, 0),
          sql`(${storeCouponIssue.isPermanent}=1 OR ${storeCouponIssue.remainCount}>0)`,
          sql`((${storeCouponIssue.startTime} IS NULL AND ${storeCouponIssue.endTime} IS NULL)
            OR (${storeCouponIssue.startTime}<=${now} AND ${storeCouponIssue.endTime}>=${now}))`,
          inArray(storeCouponIssue.type, [1, 2]),
          sql`(${storeCouponIssue.day}>0 OR (${storeCouponIssue.useStartTime} IS NOT NULL
            AND ${storeCouponIssue.useEndTime} IS NOT NULL
            AND ${storeCouponIssue.useEndTime}>=${now}))`,
          sql`length(COALESCE(NULLIF(${storeCouponIssue.couponTitle},''),${storeCouponIssue.title})) BETWEEN 1 AND 64`,
          filter.keyword ? sql`(${storeCouponIssue.id}::text=${filter.keyword}
            OR POSITION(lower(${filter.keyword}) IN lower(${storeCouponIssue.couponTitle}))>0)` : undefined);
        const rows = await tx.select().from(storeCouponIssue).where(where)
          .orderBy(desc(storeCouponIssue.id)).limit(filter.limit).offset(offset);
        const [total] = await tx.select({ count: sql<number>`COUNT(*)::integer` })
          .from(storeCouponIssue).where(where);
        return { list: rows.map(row => ({ id: row.id, coupon_title: row.couponTitle || row.title,
          coupon_type: row.couponType, type: row.type, coupon_price: row.couponPrice,
          use_min_price: row.useMinPrice, remain_count: row.remainCount,
          is_permanent: row.isPermanent, receive_type: row.receiveType,
          status: row.status, is_del: row.isDel })),
          count: total.count, page: filter.page, limit: filter.limit };
      }
      if (kind === 'products') {
        const available = exists(tx.select({ id: storeProductAttrValue.id }).from(storeProductAttrValue)
          .where(and(eq(storeProductAttrValue.productId, storeProduct.id), activeSku)));
        const where = and(eligibleProduct, available, filter.keyword ? sql`(
          ${storeProduct.id}::text=${filter.keyword} OR POSITION(lower(${filter.keyword})
          IN lower(${storeProduct.storeName}))>0)` : undefined);
        const rows = await tx.select({ id: storeProduct.id, store_name: storeProduct.storeName,
          image: storeProduct.image, price: storeProduct.price, stock: storeProduct.stock,
          product_type: storeProduct.productType, is_presale_product: storeProduct.isPresaleProduct })
          .from(storeProduct).where(where).orderBy(desc(storeProduct.id)).limit(filter.limit).offset(offset);
        const [total] = await tx.select({ count: sql<number>`COUNT(*)::integer` }).from(storeProduct).where(where);
        const items = await Promise.all(rows.map(async row => ({ ...row,
          gift_eligible: Number(row.product_type === 0 && row.is_presale_product === 0),
          cate_name: await this.categoryName(tx, row.id),
          attrValue: await this.productSkus(tx, row.id, false) })));
        return { list: items, count: total.count, page: filter.page, limit: filter.limit };
      }
      if (kind === 'brands') {
        const where = and(eq(storeBrand.isShow, 1), eq(storeBrand.isDel, 0), filter.keyword ? sql`(
          ${storeBrand.id}::text=${filter.keyword} OR POSITION(lower(${filter.keyword}) IN lower(${storeBrand.brandName}))>0)` : undefined);
        const list = await tx.select({ id: storeBrand.id, brand_name: storeBrand.brandName })
          .from(storeBrand).where(where).orderBy(desc(storeBrand.sort), desc(storeBrand.id)).limit(filter.limit).offset(offset);
        const [total] = await tx.select({ count: sql<number>`COUNT(*)::integer` }).from(storeBrand).where(where);
        return { list, count: total.count, page: filter.page, limit: filter.limit };
      }
      if (kind === 'labels') {
        const where = and(eq(storeProductLabel.type, 0), eq(storeProductLabel.relationId, 0),
          eq(storeProductLabel.isShow, 1), eq(storeProductLabel.status, 1), filter.keyword ? sql`(
          ${storeProductLabel.id}::text=${filter.keyword} OR POSITION(lower(${filter.keyword}) IN lower(${storeProductLabel.labelName}))>0)` : undefined);
        const list = await tx.select({ id: storeProductLabel.id, label_name: storeProductLabel.labelName })
          .from(storeProductLabel).where(where).orderBy(desc(storeProductLabel.sort), desc(storeProductLabel.id)).limit(filter.limit).offset(offset);
        const [total] = await tx.select({ count: sql<number>`COUNT(*)::integer` }).from(storeProductLabel).where(where);
        return { list, count: total.count, page: filter.page, limit: filter.limit };
      }
      const where = and(eq(userLabel.type, 0), eq(userLabel.relationId, 0), eq(userLabel.status, 1),
        filter.keyword ? sql`(${userLabel.id}::text=${filter.keyword} OR POSITION(lower(${filter.keyword})
          IN lower(${userLabel.name}))>0)` : undefined);
      const list = await tx.select({ id: userLabel.id, label_name: userLabel.name })
        .from(userLabel).where(where).orderBy(desc(userLabel.sort), desc(userLabel.id)).limit(filter.limit).offset(offset);
      const [total] = await tx.select({ count: sql<number>`COUNT(*)::integer` }).from(userLabel).where(where);
      return { list, count: total.count, page: filter.page, limit: filter.limit };
    });
  }

  private async categoryName(tx: DbClient, productId: number): Promise<string> {
    const [row] = await tx.execute(sql<{ name: string }>`SELECT COALESCE(string_agg(DISTINCT c.cate_name, ','), '') AS name
      FROM store_product_relation r JOIN store_product_category c ON c.id=r.relation_id
      WHERE r.type=1 AND r.product_id=${productId}`);
    return typeof row?.name === 'string' ? row.name : '';
  }

  private async productSkus(tx: DbClient, productId: number, includeRetired: boolean) {
    const rows = await tx.select({ id: storeProductAttrValue.id, unique: storeProductAttrValue.unique,
      suk: storeProductAttrValue.suk, price: storeProductAttrValue.price,
      stock: storeProductAttrValue.stock, is_retired: storeProductAttrValue.isRetired })
      .from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, productId),
        eq(storeProductAttrValue.type, 0), includeRetired ? undefined : activeSku))
      .orderBy(asc(storeProductAttrValue.id));
    // The source column is char(8); PostgreSQL drivers can expose its padding.
    return rows.map(row => ({ ...row, unique: row.unique.trimEnd(), label: row.suk }));
  }

  private scopeRows(row: Promotion, links: Auxiliary[]) {
    const own = links.filter(link => link.productPartakeType === row.productPartakeType);
    const product_id = own.filter(link => link.productId > 0).map(link => ({
      product_id: link.productId, unique: skuList(link.unique),
    }));
    return { product_id, brand_id: [...new Set(own.map(link => link.brandId).filter(Boolean))],
      store_label_id: [...new Set(own.map(link => link.storeLabelId).filter(Boolean))] };
  }

  private async productCount(tx: DbClient, row: Promotion): Promise<number> {
    const [result] = await tx.execute(sql<{ count: number }>`SELECT COUNT(*)::integer AS count
      FROM store_product p WHERE p.pid=0 AND p.is_show=1 AND p.is_del=0 AND p.is_verify=1
        AND EXISTS (SELECT 1 FROM store_product_attr_value sku WHERE sku.product_id=p.id
          AND sku.type=0 AND sku.is_retired=0 AND sku.unique<>'')
        AND (${row.productPartakeType}=1
          OR (${row.productPartakeType}=2 AND EXISTS (SELECT 1 FROM store_promotions_auxiliary a
            WHERE a.promotions_id=${row.id} AND a.type=1 AND a.product_partake_type=2 AND a.product_id=p.id))
          OR (${row.productPartakeType}=3 AND NOT EXISTS (SELECT 1 FROM store_promotions_auxiliary a
            WHERE a.promotions_id=${row.id} AND a.type=1 AND a.product_partake_type=3
              AND a.product_id=p.id AND a.is_all=1))
          OR (${row.productPartakeType}=4 AND EXISTS (SELECT 1 FROM store_promotions_auxiliary a
            JOIN store_product_relation r ON r.type=2 AND r.relation_id=a.brand_id AND r.product_id=p.id
            WHERE a.promotions_id=${row.id} AND a.type=1 AND a.product_partake_type=4))
          OR (${row.productPartakeType}=5 AND EXISTS (SELECT 1 FROM store_promotions_auxiliary a
            JOIN store_product_relation r ON r.type=3 AND r.relation_id=a.store_label_id AND r.product_id=p.id
            WHERE a.promotions_id=${row.id} AND a.type=1 AND a.product_partake_type=5)))`);
    return Number(result?.count ?? 0);
  }

  private async giftRules(tx: DbClient, row: Promotion, includeDetails: boolean, now: number) {
    const rules = [row, ...await tiers(tx, row.id)];
    const poolRows = await tx.select().from(storePromotionsAuxiliary).where(and(
      inArray(storePromotionsAuxiliary.promotionsId, rules.map(item => item.id)),
      inArray(storePromotionsAuxiliary.type, [2, 3]), eq(storePromotionsAuxiliary.isAll, 1),
    )).orderBy(asc(storePromotionsAuxiliary.id));
    const issues: string[] = [];
    const result = [];
    for (const tier of rules) {
      const own = poolRows.filter(item => item.promotionsId === tier.id);
      const coupons = own.filter(item => item.type === 2);
      const products = own.filter(item => item.type === 3);
      const expectedCoupons = csv(tier.giveCouponId);
      const expectedProducts = csv(tier.giveProductId);
      const expectedUnique = skuList(tier.giveProductUnique);
      const sorted = (values: string[]) => values.sort().join(',');
      if (sorted(expectedCoupons.map(String)) !== sorted(coupons.map(item => String(item.couponId)))
        || sorted(expectedProducts.map((id, index) => `${id}:${expectedUnique[index] ?? ''}`))
          !== sorted(products.map(item => `${item.productId}:${item.unique?.trimEnd() ?? ''}`))) {
        issues.push(`层级 ${tier.id} 的赠送清单与奖品池不一致`);
      }
      if (!Number(tier.giveIntegral) && !coupons.length && !products.length) {
        issues.push(`层级 ${tier.id} 没有赠送内容`);
      }
      const item: Record<string, unknown> = { id: tier.id, pid: tier.pid,
        threshold: Number(tier.threshold), give_integral: tier.giveIntegral,
        give_coupon_id: coupons.map(link => ({ give_coupon_id: link.couponId,
          give_coupon_num: link.limitNum })),
        give_product_id: products.map(link => ({ give_product_id: link.productId,
          unique: link.unique?.trimEnd() ?? '', give_product_num: link.limitNum })) };
      if (includeDetails) {
        const giveCoupon = [];
        for (const link of coupons) {
          const [coupon] = await tx.select().from(storeCouponIssue)
            .where(eq(storeCouponIssue.id, link.couponId)).limit(1);
          const title = coupon?.couponTitle || coupon?.title || '';
          if (!coupon || coupon.isDel !== 0 || coupon.status !== 1 || coupon.receiveType !== 3
            || !title || title.length > 64 || ![1, 2].includes(coupon.type)
            || (coupon.day === 0 && (!coupon.useStartTime || !coupon.useEndTime
              || coupon.useEndTime.getTime() < now * 1_000))
            || (!coupon.isPermanent && coupon.remainCount < link.surplusNum)) {
            issues.push(`层级 ${tier.id} 优惠券 ${link.couponId} 已缺失、停用或库存不足`);
          }
          giveCoupon.push({ id: link.id, coupon_id: link.couponId,
            limit_num: link.limitNum, surplus_num: link.surplusNum,
            coupon_title: title, coupon_type: coupon?.couponType ?? 0,
            type: coupon?.type ?? 0, coupon_price: coupon?.couponPrice ?? '0.00',
            use_min_price: coupon?.useMinPrice ?? '0.00', remain_count: coupon?.remainCount ?? 0,
            is_permanent: coupon?.isPermanent ?? 0, receive_type: coupon?.receiveType ?? 0,
            status: coupon?.status ?? 0, is_del: coupon?.isDel ?? 1 });
        }
        const giveProducts = [];
        for (const link of products) {
          const [product] = await tx.select().from(storeProduct)
            .where(eq(storeProduct.id, link.productId)).limit(1);
          const [sku] = await tx.select().from(storeProductAttrValue)
            .where(and(eq(storeProductAttrValue.productId, link.productId),
              eq(storeProductAttrValue.unique, link.unique ?? ''), eq(storeProductAttrValue.type, 0)))
            .limit(1);
          if (!product || product.pid !== 0 || product.isShow !== 1 || product.isDel !== 0
            || product.productType !== 0 || product.isPresaleProduct !== 0
            || product.isVerify !== 1 || product.stock < link.surplusNum
            || !sku || sku.isRetired !== 0 || sku.stock < link.surplusNum) {
            issues.push(`层级 ${tier.id} 赠品 ${link.productId}/${link.unique ?? ''} 已缺失、停用或库存不足`);
          }
          giveProducts.push({ id: link.id, product_id: link.productId, unique: link.unique?.trimEnd() ?? '',
            limit_num: link.limitNum, surplus_num: link.surplusNum,
            store_name: product?.storeName ?? '', image: product?.image ?? '',
            stock: product?.stock ?? 0,
            sku: { id: sku?.id ?? 0, unique: sku?.unique?.trimEnd() ?? link.unique?.trimEnd() ?? '',
              suk: sku?.suk ?? '', stock: sku?.stock ?? 0, is_retired: sku?.isRetired ?? 1 } });
        }
        item.giveCoupon = giveCoupon;
        item.giveProducts = giveProducts;
      }
      result.push(item);
    }
    return { rules: result, issues };
  }

  private async project(tx: DbClient, row: Promotion, now: number, includeDetails = false) {
    const links = await auxiliary(tx, row.id), choices = this.scopeRows(row, links);
    const gift = await this.giftRules(tx, row, includeDetails, now);
    return { ...row, ...choices, promotions_type: 4, promotions_cate: row.promotionsCate,
      threshold_type: row.thresholdType, desc: row.description ?? '',
      product_partake_type: row.productPartakeType,
      start_time: shanghai(row.startTime), stop_time: shanghai(row.stopTime),
      section_time: [shanghai(row.startTime), shanghai(row.stopTime)],
      add_time: shanghai(row.addTime), update_time: shanghai(row.updateTime),
      label_id: csv(row.labelId), is_label: row.labelId ? 1 : 0,
      promotions: gift.rules, selection_issues: gift.issues,
      ...stage(row, now), product_count: await this.productCount(tx, row),
      ...(await fullGiftSales(tx, row.id)), revision: await revision(tx, row) };
  }

  private async detailSelections(tx: DbClient, row: Promotion) {
    const links = await auxiliary(tx, row.id), selected = this.scopeRows(row, links);
    const issues: string[] = [];
    const products = [];
    for (const item of selected.product_id) {
      const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, item.product_id)).limit(1);
      if (!product) { issues.push(`商品 ${item.product_id} 已不存在`); continue; }
      if (product.pid !== 0 || product.isShow !== 1 || product.isDel !== 0 || product.isVerify !== 1) {
        issues.push(`商品 ${item.product_id} 已不可参与`);
      }
      const skus = await this.productSkus(tx, product.id, true);
      const picked = skus.filter(sku => item.unique.includes(sku.unique));
      for (const key of item.unique) {
        const found = picked.find(sku => sku.unique === key);
        if (!found || found.is_retired !== 0 || !found.unique) issues.push(`商品 ${item.product_id} 规格 ${key} 已缺失或退役`);
      }
      products.push({ id: product.id, store_name: product.storeName, image: product.image,
        price: product.price, stock: product.stock, pid: product.pid,
        is_show: product.isShow, is_del: product.isDel, is_verify: product.isVerify,
        cate_name: await this.categoryName(tx, product.id), attrValue: picked });
    }
    const brands = selected.brand_id.length ? await tx.select({ id: storeBrand.id,
      brand_name: storeBrand.brandName, is_show: storeBrand.isShow, is_del: storeBrand.isDel })
      .from(storeBrand).where(inArray(storeBrand.id, selected.brand_id)).orderBy(asc(storeBrand.id)) : [];
    for (const id of selected.brand_id) if (!brands.some(item => item.id === id && item.is_show === 1 && item.is_del === 0)) {
      issues.push(`品牌 ${id} 已缺失或停用`);
    }
    const labels = selected.store_label_id.length ? await tx.select({ id: storeProductLabel.id,
      label_name: storeProductLabel.labelName, type: storeProductLabel.type,
      relation_id: storeProductLabel.relationId, is_show: storeProductLabel.isShow,
      status: storeProductLabel.status }).from(storeProductLabel)
      .where(inArray(storeProductLabel.id, selected.store_label_id)).orderBy(asc(storeProductLabel.id)) : [];
    for (const id of selected.store_label_id) if (!labels.some(item => item.id === id && item.type === 0
      && item.relation_id === 0 && item.is_show === 1 && item.status === 1)) {
      issues.push(`商品标签 ${id} 已缺失或停用`);
    }
    const labelIds = csv(row.labelId);
    if (labelIds.length > 100) issues.push('付后用户标签超过100个，请编辑核对');
    const userLabels = labelIds.length ? await tx.select({ id: userLabel.id,
      label_name: userLabel.name, type: userLabel.type, relation_id: userLabel.relationId,
      status: userLabel.status }).from(userLabel).where(inArray(userLabel.id, labelIds)).orderBy(asc(userLabel.id)) : [];
    for (const id of labelIds) if (!userLabels.some(item => item.id === id && item.type === 0
      && item.relation_id === 0 && item.status === 1)) issues.push(`用户标签 ${id} 已缺失或停用`);
    if (row.productPartakeType === 2 || row.productPartakeType === 3) {
      if (!selected.product_id.length) issues.push('指定商品范围为空');
    } else if (row.productPartakeType === 4 && !selected.brand_id.length) issues.push('指定品牌范围为空');
    else if (row.productPartakeType === 5 && !selected.store_label_id.length) issues.push('指定商品标签范围为空');
    if (row.productPartakeType === 3) issues.push('历史排除商品范围不受当前满送管理支持，请修改范围');
    return { products, brands, labels, user_labels: userLabels, selection_issues: issues };
  }

  private async validateInput(tx: DbClient, input: GiftInput, now: number): Promise<Materials> {
    const skuCounts = new Map<number, number>();
    const couponAvailable = new Map<number, number>();
    const giftAvailable = new Map<string, number>();
    if (input.labelIds.length) {
      const rows = await tx.select({ id: userLabel.id }).from(userLabel).where(and(
        inArray(userLabel.id, input.labelIds), eq(userLabel.type, 0),
        eq(userLabel.relationId, 0), eq(userLabel.status, 1),
      )).orderBy(asc(userLabel.id)).for('share');
      if (rows.length !== input.labelIds.length) throw new ValidateException('用户标签已缺失或停用');
    }
    if (input.scope === 2 || input.scope === 3) {
      const productIds = input.products.map(item => item.product_id);
      if (new Set(productIds).size !== productIds.length || input.products.some(item =>
        !item.unique.length || new Set(item.unique).size !== item.unique.length)) {
        throw new ValidateException('选中商品或规格身份重复或为空');
      }
      const products = await tx.select({ id: storeProduct.id }).from(storeProduct).where(and(
        inArray(storeProduct.id, productIds), eligibleProduct,
      )).orderBy(asc(storeProduct.id)).for('share');
      if (products.length !== productIds.length) throw new ValidateException('选中商品中有子商品、待审核、已下架或删除的');
      const allSkus = await tx.select({ productId: storeProductAttrValue.productId,
        unique: storeProductAttrValue.unique }).from(storeProductAttrValue)
        .where(and(inArray(storeProductAttrValue.productId, productIds), activeSku))
        .orderBy(asc(storeProductAttrValue.id)).for('share');
      for (const item of input.products) {
        const keys = allSkus.filter(sku => sku.productId === item.product_id).map(sku => sku.unique.trimEnd());
        if (!keys.length || item.unique.some(key => !keys.includes(key))) {
          throw new ValidateException(`商品 ${item.product_id} 含缺失或退役规格`);
        }
        if (new Set(keys).size !== keys.length) throw new ValidateException(`商品 ${item.product_id} 规格身份重复`);
        skuCounts.set(item.product_id, keys.length);
      }
    } else if (input.scope === 4) {
      const rows = await tx.select({ id: storeBrand.id }).from(storeBrand).where(and(
        inArray(storeBrand.id, input.brandIds), eq(storeBrand.isShow, 1), eq(storeBrand.isDel, 0),
      )).orderBy(asc(storeBrand.id)).for('share');
      if (rows.length !== input.brandIds.length) throw new ValidateException('选择品牌中有已下架或删除的');
    } else if (input.scope === 5) {
      const rows = await tx.select({ id: storeProductLabel.id }).from(storeProductLabel).where(and(
        inArray(storeProductLabel.id, input.labelIdsProduct), eq(storeProductLabel.type, 0),
        eq(storeProductLabel.relationId, 0), eq(storeProductLabel.isShow, 1),
        eq(storeProductLabel.status, 1),
      )).orderBy(asc(storeProductLabel.id)).for('share');
      if (rows.length !== input.labelIdsProduct.length) throw new ValidateException('选择商品标签中有已下架或删除的');
    }
    const couponIds = [...new Set(input.rules.flatMap(rule => rule.give_coupon_id.map(item => item.give_coupon_id)))];
    if (couponIds.length) {
      const coupons = await tx.select().from(storeCouponIssue).where(inArray(storeCouponIssue.id, couponIds))
        .orderBy(asc(storeCouponIssue.id)).for('share');
      if (coupons.length !== couponIds.length) throw new ValidateException('赠送优惠券已缺失');
      for (const coupon of coupons) {
        const activeWindow = (coupon.startTime === null && coupon.endTime === null)
          || (coupon.startTime !== null && coupon.endTime !== null
            && coupon.startTime.getTime() <= now * 1_000 && coupon.endTime.getTime() >= now * 1_000);
        const title = coupon.couponTitle || coupon.title;
        if (coupon.receiveType !== 3 || coupon.status !== 1 || coupon.isDel !== 0 || !activeWindow
          || !title || title.length > 64 || ![1, 2].includes(coupon.type)
          || (coupon.day === 0 && (!coupon.useStartTime || !coupon.useEndTime
            || coupon.useEndTime.getTime() < now * 1_000))) {
          throw new ValidateException(`赠送优惠券 ${coupon.id} 已失效或不属于满送券`);
        }
        couponAvailable.set(coupon.id, coupon.isPermanent ? Number.MAX_SAFE_INTEGER : coupon.remainCount);
      }
    }
    const giftProductIds = [...new Set(input.rules.flatMap(rule => rule.give_product_id.map(item => item.give_product_id)))];
    if (giftProductIds.length) {
      const products = await tx.select().from(storeProduct).where(inArray(storeProduct.id, giftProductIds))
        .orderBy(asc(storeProduct.id)).for('share');
      if (products.length !== giftProductIds.length) throw new ValidateException('赠品商品已缺失');
      const skus = await tx.select().from(storeProductAttrValue)
        .where(and(inArray(storeProductAttrValue.productId, giftProductIds),
          eq(storeProductAttrValue.type, 0))).orderBy(asc(storeProductAttrValue.id)).for('share');
      for (const gift of input.rules.flatMap(rule => rule.give_product_id)) {
        const product = products.find(item => item.id === gift.give_product_id);
        const sku = skus.find(item => item.productId === gift.give_product_id && item.unique.trimEnd() === gift.unique);
        if (!product || product.pid !== 0 || product.isShow !== 1 || product.isDel !== 0
          || product.productType !== 0 || product.isPresaleProduct !== 0
          || product.isVerify !== 1 || !sku || sku.isRetired !== 0 || !sku.unique) {
          throw new ValidateException(`赠品 ${gift.give_product_id}/${gift.unique} 已缺失或退役`);
        }
        if (skus.filter(item => item.productId === gift.give_product_id && item.unique.trimEnd() === gift.unique).length !== 1) {
          throw new ValidateException('赠品规格身份不唯一');
        }
        giftAvailable.set(`${gift.give_product_id}:${gift.unique}`, Math.min(product.stock, sku.stock));
      }
    }
    return { skuCounts, couponAvailable, giftAvailable };
  }

  private async inputFromRow(tx: DbClient, row: Promotion): Promise<GiftInput> {
    const selected = this.scopeRows(row, await auxiliary(tx, row.id));
    const tierRows = [row, ...await tiers(tx, row.id)];
    const pools = await tx.select().from(storePromotionsAuxiliary).where(and(
      inArray(storePromotionsAuxiliary.promotionsId, tierRows.map(item => item.id)),
      inArray(storePromotionsAuxiliary.type, [2, 3]), eq(storePromotionsAuxiliary.isAll, 1),
    )).orderBy(asc(storePromotionsAuxiliary.id));
    return { name: row.name, startTime: row.startTime, stopTime: row.stopTime,
      cate: row.promotionsCate as 1 | 2, thresholdType: row.thresholdType as 1 | 2,
      rules: tierRows.map(tier => ({ id: tier.id, threshold: Number(tier.threshold),
        give_integral: tier.giveIntegral,
        give_coupon_id: pools.filter(pool => pool.promotionsId === tier.id && pool.type === 2)
          .map(pool => ({ give_coupon_id: pool.couponId, give_coupon_num: pool.limitNum })),
        give_product_id: pools.filter(pool => pool.promotionsId === tier.id && pool.type === 3)
          .map(pool => ({ give_product_id: pool.productId, unique: pool.unique?.trimEnd() ?? '',
            give_product_num: pool.limitNum })) })),
      labelIds: csv(row.labelId), scope: row.productPartakeType as Scope,
      products: selected.product_id, brandIds: selected.brand_id,
      labelIdsProduct: selected.store_label_id, status: row.status as 0 | 1, sort: row.sort };
  }

  private async writeScopeAuxiliary(tx: DbClient, promotionId: number, input: GiftInput,
    skuCounts: Map<number, number>) {
    const entries = input.scope === 2 || input.scope === 3
      ? input.products.map(item => ({ productId: item.product_id, unique: item.unique.join(','),
        isAll: Number(item.unique.length === skuCounts.get(item.product_id)) }))
      : input.scope === 4 ? input.brandIds.map(brandId => ({ brandId }))
        : input.scope === 5 ? input.labelIdsProduct.map(storeLabelId => ({ storeLabelId })) : [];
    for (let index = 0; index < entries.length; index += 1_000) {
      await tx.insert(storePromotionsAuxiliary).values(entries.slice(index, index + 1_000).map(entry => ({
        type: 1, promotionsId: promotionId, productPartakeType: input.scope, ...entry,
      })));
    }
  }

  private async syncPools(tx: DbClient, promotionId: number, rule: Rule, materials: Materials) {
    // Consumer reservations hold these same rows. Keep IDs and spent units;
    // changing an advertised limit only changes currently available surplus.
    const old = await tx.select().from(storePromotionsAuxiliary).where(and(
      eq(storePromotionsAuxiliary.promotionsId, promotionId),
      inArray(storePromotionsAuxiliary.type, [2, 3]),
    )).orderBy(asc(storePromotionsAuxiliary.id)).for('update');
    const remaining = new Set(old.map(item => item.id));
    const apply = async (type: 2 | 3, identity: { couponId?: number; productId?: number; unique?: string },
      limit: number, available: number) => {
      const matches = old.filter(item => item.type === type
        && (type === 2 ? item.couponId === identity.couponId
          : item.productId === identity.productId && item.unique?.trimEnd() === identity.unique));
      const matched = matches.find(item => item.isAll === 1) ?? matches.at(-1);
      if (matches.filter(item => item.isAll === 1).length > 1) {
        throw new ValidateException('赠送池历史身份重复，请先处理旧配置');
      }
      const spent = matched ? matched.limitNum - matched.surplusNum : 0;
      if (spent < 0 || limit < spent) throw new ValidateException('赠送池总量不能低于已使用或占用数量');
      const surplus = limit - spent;
      if (surplus > available) throw new ValidateException('赠送池可用数量超过当前券或赠品库存');
      if (matched) {
        remaining.delete(matched.id);
        await tx.update(storePromotionsAuxiliary).set({ limitNum: limit, surplusNum: surplus,
          isAll: 1 }).where(eq(storePromotionsAuxiliary.id, matched.id));
      } else {
        await tx.insert(storePromotionsAuxiliary).values({ type, promotionsId: promotionId,
          productPartakeType: 1, couponId: identity.couponId ?? 0,
          productId: identity.productId ?? 0, unique: identity.unique ?? '',
          limitNum: limit, surplusNum: surplus, isAll: 1 });
      }
    };
    for (const gift of rule.give_coupon_id) await apply(2, { couponId: gift.give_coupon_id },
      gift.give_coupon_num, materials.couponAvailable.get(gift.give_coupon_id) ?? -1);
    for (const gift of rule.give_product_id) await apply(3,
      { productId: gift.give_product_id, unique: gift.unique }, gift.give_product_num,
      materials.giftAvailable.get(`${gift.give_product_id}:${gift.unique}`) ?? -1);
    if (remaining.size) await tx.update(storePromotionsAuxiliary).set({ isAll: 0 })
      .where(inArray(storePromotionsAuxiliary.id, [...remaining]));
  }

  async mutate(operation: Operation, value: unknown, raw: Record<string, unknown>, actor: { id: number }) {
    numberId(actor.id, '管理员ID');
    const id = operation === 'create' ? 0 : numberId(value, '满送活动ID');
    const parsed = parseMutation(operation, raw);
    const payload = await digest({ operation, id, revision: parsed.revision, input: parsed.input, status: parsed.status });
    const path = `/marketing/full-gifts/request/${parsed.requestId}`;
    return withTx(this.container, async tx => {
      // Shared ordering with checkout re-quote: catalogue lock first, then the
      // request key, promotion row, products/SKUs, and finally order rows.
      // Checkout takes pg_advisory_xact_lock_shared with these exact two keys.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        hashtext('time_discount_catalog'), hashtext('platform_type_1'))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin_full_gift'),
        hashtext(${`${actor.id}:${parsed.requestId}`}))`);
      const logs = await tx.select({ action: systemLog.action }).from(systemLog).where(and(
        eq(systemLog.adminId, actor.id), eq(systemLog.type, 'full_gift'), eq(systemLog.path, path),
      )).orderBy(desc(systemLog.id)).limit(2);
      if (logs.length) {
        const replay = /^([a-z]+);id=([1-9]\d{0,9});payload=([a-f\d]{64})$/.exec(logs[0].action);
        if (logs.length !== 1 || !replay || replay[1] !== operation || replay[3] !== payload) {
          failConflict('请求标识已用于其他满送活动操作');
        }
        return { id: Number(replay[2]) };
      }
      const now = await databaseClock(tx);
      let row: Promotion | undefined;
      if (id) {
        [row] = await tx.select().from(storePromotions).where(and(rootWhere, eq(storePromotions.id, id)))
          .limit(1).for('update');
        if (!row) throw new NotFoundException('满送活动不存在');
        if (await revision(tx, row) !== parsed.revision) failConflict('满送活动已更新，请刷新后重试');
      }
      let resultId = id;
      if (operation === 'create' || operation === 'update') {
        const input = parsed.input!;
        if (input.stopTime < now) throw new ValidateException('活动结束时间不能小于当前时间');
        const previous = row ? await tiers(tx, id) : [];
        const previousIds = new Set(previous.map(item => item.id));
        if (row && (input.rules[0].id !== id || input.rules.slice(1).some(rule =>
          rule.id !== null && !previousIds.has(rule.id)))) {
          throw new ValidateException('优惠层级ID不属于当前平台满送活动');
        }
        const materials = await this.validateInput(tx, input, now);
        const description = input.rules.map(rule => `${input.cate === 2 ? '每' : ''}满${rule.threshold}`
          + `${input.thresholdType === 1 ? '元' : '件'}送`
          + [rule.give_integral ? `${rule.give_integral}积分` : '',
            rule.give_coupon_id.length ? `${rule.give_coupon_id.length}种优惠券` : '',
            rule.give_product_id.length ? `${rule.give_product_id.length}种赠品` : '']
            .filter(Boolean).join('、')).join(',');
        const first = input.rules[0];
        const patch = { name: input.name, title: '满送活动', description,
          promotionsCate: input.cate, thresholdType: input.thresholdType,
          threshold: first.threshold.toFixed(2), discountType: 1,
          nPieceNDiscount: 1, discount: '0.00',
          giveIntegral: first.give_integral,
          giveCouponId: first.give_coupon_id.map(gift => gift.give_coupon_id).join(','),
          giveProductId: first.give_product_id.map(gift => gift.give_product_id).join(','),
          giveProductUnique: first.give_product_id.map(gift => gift.unique).join(','),
          labelId: input.labelIds.join(','), overlay: '',
          productPartakeType: input.scope, productId: input.products.map(item => item.product_id).join(','),
          isLimit: 0, limitNum: 0, startTime: input.startTime,
          stopTime: input.stopTime, sort: input.sort, status: input.status,
          updateTime: Math.max(now, (row?.updateTime ?? 0) + 1) };
        if (row) await tx.update(storePromotions).set(patch).where(eq(storePromotions.id, id));
        else {
          const [created] = await tx.insert(storePromotions).values({ ...patch, pid: 0,
            type: 1, storeId: 0, promotionsType: 4, isDel: 0, addTime: now })
            .returning({ id: storePromotions.id });
          resultId = created.id;
        }
        await tx.delete(storePromotionsAuxiliary).where(and(eq(storePromotionsAuxiliary.promotionsId, resultId),
          eq(storePromotionsAuxiliary.type, 1)));
        await this.writeScopeAuxiliary(tx, resultId, input, materials.skuCounts);
        await this.syncPools(tx, resultId, first, materials);
        for (const rule of input.rules.slice(1)) {
          const tierPatch = { promotionsCate: input.cate, thresholdType: input.thresholdType,
            threshold: rule.threshold.toFixed(2), discountType: 1, discount: '0.00',
            giveIntegral: rule.give_integral,
            giveCouponId: rule.give_coupon_id.map(gift => gift.give_coupon_id).join(','),
            giveProductId: rule.give_product_id.map(gift => gift.give_product_id).join(','),
            giveProductUnique: rule.give_product_id.map(gift => gift.unique).join(','),
            status: input.status, updateTime: now };
          let tierId = rule.id;
          if (tierId !== null) {
            await tx.update(storePromotions).set(tierPatch).where(and(
              eq(storePromotions.id, tierId), eq(storePromotions.pid, resultId),
              eq(storePromotions.promotionsType, 4), eq(storePromotions.type, 1),
              eq(storePromotions.storeId, 0), eq(storePromotions.isDel, 0)));
          } else {
            const [tier] = await tx.insert(storePromotions).values({ ...tierPatch,
              pid: resultId, type: 1, storeId: 0, promotionsType: 4,
              isDel: 0, addTime: now }).returning({ id: storePromotions.id });
            tierId = tier.id;
          }
          await this.syncPools(tx, tierId, rule, materials);
          previousIds.delete(tierId);
        }
        if (previousIds.size) {
          // An omitted tier is retired, but its pool rows survive for refunds
          // and reservation cancellation; store-derived children are untouched.
          await tx.update(storePromotions).set({ isDel: 1, updateTime: now })
            .where(inArray(storePromotions.id, [...previousIds]));
          await tx.update(storePromotionsAuxiliary).set({ isAll: 0 }).where(and(
            inArray(storePromotionsAuxiliary.promotionsId, [...previousIds]),
            inArray(storePromotionsAuxiliary.type, [2, 3])));
        }
      } else if (operation === 'status') {
        if (parsed.status === 1) {
          if (row!.stopTime < now || row!.startTime > row!.stopTime || !row!.name
            || ![1, 2].includes(row!.thresholdType) || ![1, 2].includes(row!.promotionsCate)
            || ![1, 2, 4, 5].includes(row!.productPartakeType)
            ) throw new ValidateException('满送活动已过期或配置不完整');
          const links = await auxiliary(tx, id);
          const childRows = await tiers(tx, id);
          if (childRows.some(child => child.promotionsCate !== row!.promotionsCate
            || child.thresholdType !== row!.thresholdType)) throw new ValidateException('优惠层级配置不一致');
          const input = await this.inputFromRow(tx, row!);
          if (input.labelIds.length > 100) throw new ValidateException('付后用户标签最多选择100个');
          rules(input.rules.map(rule => ({ ...rule, id: rule.id })),
            input.cate, input.thresholdType, 'update');
          if (input.scope === 2 && !input.products.length
            || input.scope === 4 && !input.brandIds.length
            || input.scope === 5 && !input.labelIdsProduct.length) {
            throw new ValidateException('满送活动范围配置不完整');
          }
          const issues = (await this.giftRules(tx, row!, true, now)).issues;
          if (issues.length) throw new ValidateException(issues[0]);
          const materials = await this.validateInput(tx, input, now);
          if (input.scope === 2 && links.some(link =>
            link.productPartakeType === input.scope && link.productId > 0
            && link.isAll !== Number(skuList(link.unique).length === materials.skuCounts.get(link.productId)))) {
            throw new ValidateException('商品规格集合已变化，请编辑核对后再开启');
          }
        }
        await tx.update(storePromotions).set({ status: parsed.status!,
          updateTime: Math.max(now, row!.updateTime + 1) }).where(eq(storePromotions.id, id));
        await tx.update(storePromotions).set({ status: parsed.status!, updateTime: now }).where(and(
          eq(storePromotions.pid, id), eq(storePromotions.promotionsType, 4),
          eq(storePromotions.type, 1), eq(storePromotions.storeId, 0), eq(storePromotions.isDel, 0)));
      } else {
        const derived = await tx.select({ id: storePromotions.id }).from(storePromotions).where(and(
          eq(storePromotions.pid, id), eq(storePromotions.promotionsType, 4), eq(storePromotions.isDel, 0),
        )).orderBy(asc(storePromotions.id)).for('update');
        await tx.update(storePromotions).set({ isDel: 1,
          updateTime: Math.max(now, row!.updateTime + 1) })
          .where(inArray(storePromotions.id, [id, ...derived.map(item => item.id)]));
      }
      await tx.insert(systemLog).values({ adminId: actor.id, type: 'full_gift',
        page: '/marketing/full-gifts', path,
        method: operation === 'create' ? 'POST' : operation === 'update' ? 'PUT'
          : operation === 'status' ? 'PATCH' : 'DELETE',
        action: `${operation};id=${resultId};payload=${payload}`, addTime: now });
      return { id: resultId };
    });
  }
}


