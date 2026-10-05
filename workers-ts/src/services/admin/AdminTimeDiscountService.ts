import { and, asc, desc, eq, exists, inArray, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import {
  storeBrand, storeProduct, storeProductAttrValue, storeProductLabel,
  storePromotions, storePromotionsAuxiliary, systemLog, userLabel,
} from '@/models/schema';
import { HttpApiException, NotFoundException, ValidateException } from '@/utils/errors';
import { adminPromotionSales } from './AdminPromotionSales';

type Promotion = typeof storePromotions.$inferSelect;
type Auxiliary = typeof storePromotionsAuxiliary.$inferSelect;
type Scope = 1 | 2 | 3 | 4 | 5;
type Operation = 'create' | 'update' | 'status' | 'delete';
type ProductSelection = { product_id: number; unique: string[] };
type DiscountInput = {
  name: string; startTime: number; stopTime: number; discount: number; isLimit: 0 | 1;
  limitNum: number; labelIds: number[]; overlay: Array<2 | 3 | 5>; scope: Scope;
  products: ProductSelection[]; brandIds: number[]; labelIdsProduct: number[];
  status: 0 | 1; sort: number;
};
type Mutation = { requestId: string; revision: string | null; input: DiscountInput | null; status: 0 | 1 | null };

const requestPattern = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const datePattern = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const selectionLimit = 10_000;
const rootWhere = and(eq(storePromotions.promotionsType, 1), eq(storePromotions.type, 1),
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
  const allowed = option ? ['page', 'limit', 'keyword'] : ['page', 'limit', 'name', 'status'];
  for (const key of parameters.keys()) if (!allowed.includes(key) || parameters.getAll(key).length !== 1) {
    throw new ValidateException('限时折扣查询包含不支持或重复的参数');
  }
  const page = pageValue(parameters.get('page'), 1, 100_000, '页码');
  const limit = pageValue(parameters.get('limit'), 15, 50, '每页条数');
  if ((page - 1) * limit > 100_000) throw new ValidateException('分页偏移超出范围');
  const status = parameters.get('status');
  if (!option && status !== null && status !== '' && status !== '0' && status !== '1') {
    throw new ValidateException('活动状态无效');
  }
  return { page, limit, keyword: text(parameters.get(option ? 'keyword' : 'name') ?? '', '搜索词', 200),
    status: !option && status !== null && status !== '' ? Number(status) as 0 | 1 : null };
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
    ? ['name', 'section_time', 'discount', 'is_limit', 'limit_num', 'is_label', 'label_id',
      'is_overlay', 'overlay', 'product_partake_type', 'product_id', 'brand_id', 'store_label_id',
      'status', 'sort', 'request_id', ...(operation === 'update' ? ['revision'] : [])]
    : ['request_id', 'revision', ...(operation === 'status' ? ['status'] : [])];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new ValidateException(`不支持的限时折扣字段：${key}`);
  if (typeof raw.request_id !== 'string' || !requestPattern.test(raw.request_id)) throw new ValidateException('请求标识必须是UUID');
  const revision = operation === 'create' ? null : raw.revision;
  if (operation !== 'create' && (typeof revision !== 'string' || !/^[a-f\d]{64}$/.test(revision))) {
    throw new ValidateException('限时折扣版本无效，请刷新');
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
  const products = selectedProducts(raw.product_id ?? []);
  const brandIds = ids(raw.brand_id ?? [], '关联品牌ID');
  const labelIdsProduct = ids(raw.store_label_id ?? [], '商品标签ID');
  const labelIds = ids(raw.label_id ?? [], '用户标签ID');
  if (labelIds.length > 100) throw new ValidateException('付后用户标签最多选择100个');
  if (scope === 2 && !products.length) throw new ValidateException('请选择要参与活动的商品');
  if (scope === 3 && !products.length) throw new ValidateException('请选择要排除的商品');
  if (scope === 4 && !brandIds.length) throw new ValidateException('请选择要参与活动的商品品牌');
  if (scope === 5 && !labelIdsProduct.length) throw new ValidateException('请选择要参与活动的商品标签');
  const isLimit = flag(raw.is_limit, '限购设置');
  const limitNum = isLimit ? integer(raw.limit_num, '每人每商品限购数量', 1, 99_999_999) : 0;
  const isLabel = raw.is_label === undefined ? Number(labelIds.length > 0) : flag(raw.is_label, '用户标签开关');
  if (isLabel && !labelIds.length) throw new ValidateException('请选择用户标签');
  const rawOverlay = ids(raw.overlay ?? [], '叠加活动类型');
  if (rawOverlay.some(value => ![2, 3, 5].includes(value))) throw new ValidateException('叠加活动类型无效');
  const isOverlay = raw.is_overlay === undefined ? Number(rawOverlay.length > 0) : flag(raw.is_overlay, '叠加开关');
  if (isOverlay && !rawOverlay.length) throw new ValidateException('请选择叠加活动');
  return { requestId, revision: revision as string | null, status: null,
    input: { name: text(raw.name, '活动名称', 255, true), startTime, stopTime,
      discount: integer(raw.discount, '活动折扣百分数', 0, 100), isLimit, limitNum,
      labelIds: isLabel ? labelIds : [], overlay: isOverlay ? rawOverlay as Array<2 | 3 | 5> : [], scope,
      products: scope === 2 || scope === 3 ? products : [], brandIds: scope === 4 ? brandIds : [],
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
    eq(storePromotions.promotionsType, 1))).orderBy(asc(storePromotions.id));
}
async function revision(tx: DbClient, row: Promotion): Promise<string> {
  return digest({ row, auxiliary: await auxiliary(tx, row.id), children: await children(tx, row.id) });
}
function csv(value: string | null): number[] {
  return (value ?? '').split(',').filter(Boolean).map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
}
function skuList(value: string | null): string[] { return (value ?? '').split(',').filter(Boolean); }
function stage(row: Promotion, now: number) {
  if (!row.status || row.stopTime < now) return { start_status: -1, start_name: '已结束' };
  if (row.startTime > now) return { start_status: 0, start_name: '未开始' };
  return { start_status: 1, start_name: '进行中' };
}

export class AdminTimeDiscountService {
  constructor(private readonly container: Container) {}

  async list(parameters: URLSearchParams) {
    const filter = query(parameters, false);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const now = await databaseClock(tx);
      const where = and(rootWhere,
        filter.status === null ? undefined : eq(storePromotions.status, filter.status),
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
    const id = numberId(value, '限时折扣ID');
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const [row] = await tx.select().from(storePromotions).where(and(rootWhere, eq(storePromotions.id, id))).limit(1);
      if (!row) throw new NotFoundException('限时折扣不存在');
      const info = await this.project(tx, row, await databaseClock(tx));
      return { info: { ...info, ...(await this.detailSelections(tx, row)) } };
    });
  }

  async choices(kind: 'products' | 'brands' | 'labels' | 'user-labels', parameters: URLSearchParams) {
    const filter = query(parameters, true), offset = (filter.page - 1) * filter.limit;
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      if (kind === 'products') {
        const available = exists(tx.select({ id: storeProductAttrValue.id }).from(storeProductAttrValue)
          .where(and(eq(storeProductAttrValue.productId, storeProduct.id), activeSku)));
        const where = and(eligibleProduct, available, filter.keyword ? sql`(
          ${storeProduct.id}::text=${filter.keyword} OR POSITION(lower(${filter.keyword})
          IN lower(${storeProduct.storeName}))>0)` : undefined);
        const rows = await tx.select({ id: storeProduct.id, store_name: storeProduct.storeName,
          image: storeProduct.image, price: storeProduct.price, stock: storeProduct.stock })
          .from(storeProduct).where(where).orderBy(desc(storeProduct.id)).limit(filter.limit).offset(offset);
        const [total] = await tx.select({ count: sql<number>`COUNT(*)::integer` }).from(storeProduct).where(where);
        const items = await Promise.all(rows.map(async row => ({ ...row,
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
    return rows.map(row => ({ ...row, label: row.suk }));
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

  private async project(tx: DbClient, row: Promotion, now: number) {
    const links = await auxiliary(tx, row.id), choices = this.scopeRows(row, links);
    const childRows = await children(tx, row.id);
    const rule = (item: Promotion) => ({ id: item.id, pid: item.pid,
      promotions_type: item.promotionsType, promotions_cate: item.promotionsCate,
      threshold_type: item.thresholdType, threshold: Number(item.threshold),
      discount_type: item.discountType, discount: Number(item.discount) });
    return { ...row, ...choices, promotions_type: 1, product_partake_type: row.productPartakeType,
      start_time: shanghai(row.startTime), stop_time: shanghai(row.stopTime),
      section_time: [shanghai(row.startTime), shanghai(row.stopTime)],
      add_time: shanghai(row.addTime), update_time: shanghai(row.updateTime),
      label_id: csv(row.labelId), overlay: csv(row.overlay),
      is_label: row.labelId ? 1 : 0, is_overlay: row.overlay ? 1 : 0,
      is_limit: row.isLimit, limit_num: row.limitNum, discount: Number(row.discount),
      promotions: [rule(row), ...childRows.map(rule)],
      ...stage(row, now), product_count: await this.productCount(tx, row),
      ...(await adminPromotionSales(tx, row.id, 1)), revision: await revision(tx, row) };
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
    return { products, brands, labels, user_labels: userLabels, selection_issues: issues };
  }

  private async validateInput(tx: DbClient, input: DiscountInput): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
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
        const keys = allSkus.filter(sku => sku.productId === item.product_id).map(sku => sku.unique);
        if (!keys.length || item.unique.some(key => !keys.includes(key))) {
          throw new ValidateException(`商品 ${item.product_id} 含缺失或退役规格`);
        }
        if (new Set(keys).size !== keys.length) throw new ValidateException(`商品 ${item.product_id} 规格身份重复`);
        counts.set(item.product_id, keys.length);
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
    return counts;
  }

  private inputFromRow(row: Promotion, links: Auxiliary[]): DiscountInput {
    const selected = this.scopeRows(row, links);
    return { name: row.name, startTime: row.startTime, stopTime: row.stopTime,
      discount: Number(row.discount), isLimit: row.isLimit as 0 | 1, limitNum: row.limitNum,
      labelIds: csv(row.labelId), overlay: csv(row.overlay) as Array<2 | 3 | 5>,
      scope: row.productPartakeType as Scope, products: selected.product_id,
      brandIds: selected.brand_id, labelIdsProduct: selected.store_label_id,
      status: row.status as 0 | 1, sort: row.sort };
  }

  async mutate(operation: Operation, value: unknown, raw: Record<string, unknown>, actor: { id: number }) {
    numberId(actor.id, '管理员ID');
    const id = operation === 'create' ? 0 : numberId(value, '限时折扣ID');
    const parsed = parseMutation(operation, raw);
    const payload = await digest({ operation, id, revision: parsed.revision, input: parsed.input, status: parsed.status });
    const path = `/marketing/time-discounts/request/${parsed.requestId}`;
    return withTx(this.container, async tx => {
      // Shared ordering with checkout re-quote: catalogue lock first, then the
      // request key, promotion row, products/SKUs, and finally order rows.
      // Checkout takes pg_advisory_xact_lock_shared with these exact two keys.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        hashtext('time_discount_catalog'), hashtext('platform_type_1'))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin_time_discount'),
        hashtext(${`${actor.id}:${parsed.requestId}`}))`);
      const logs = await tx.select({ action: systemLog.action }).from(systemLog).where(and(
        eq(systemLog.adminId, actor.id), eq(systemLog.type, 'time_discount'), eq(systemLog.path, path),
      )).orderBy(desc(systemLog.id)).limit(2);
      if (logs.length) {
        const replay = /^([a-z]+);id=([1-9]\d{0,9});payload=([a-f\d]{64})$/.exec(logs[0].action);
        if (logs.length !== 1 || !replay || replay[1] !== operation || replay[3] !== payload) {
          failConflict('请求标识已用于其他限时折扣操作');
        }
        return { id: Number(replay[2]) };
      }
      const now = await databaseClock(tx);
      let row: Promotion | undefined;
      if (id) {
        [row] = await tx.select().from(storePromotions).where(and(rootWhere, eq(storePromotions.id, id)))
          .limit(1).for('update');
        if (!row) throw new NotFoundException('限时折扣不存在');
        if (await revision(tx, row) !== parsed.revision) failConflict('限时折扣已更新，请刷新后重试');
      }
      let resultId = id;
      if (operation === 'create' || operation === 'update') {
        const input = parsed.input!;
        if (input.stopTime < now) throw new ValidateException('活动结束时间不能小于当前时间');
        const skuCounts = await this.validateInput(tx, input);
        const description = `限时打${Number((input.discount / 10).toFixed(2))}折`
          + (input.isLimit ? `，每人限购${input.limitNum}件` : '');
        const patch = { name: input.name, title: '限时折扣', description,
          promotionsCate: 1, thresholdType: 1, threshold: '0.00', discountType: 2,
          nPieceNDiscount: 3, discount: input.discount.toFixed(2),
          giveIntegral: 0, giveCouponId: '', giveProductId: '', giveProductUnique: '',
          labelId: input.labelIds.join(','), overlay: input.overlay.join(','),
          productPartakeType: input.scope, productId: input.products.map(item => item.product_id).join(','),
          isLimit: input.isLimit, limitNum: input.limitNum, startTime: input.startTime,
          stopTime: input.stopTime, sort: input.sort, status: input.status,
          updateTime: Math.max(now, (row?.updateTime ?? 0) + 1) };
        if (row) await tx.update(storePromotions).set(patch).where(eq(storePromotions.id, id));
        else {
          const [created] = await tx.insert(storePromotions).values({ ...patch, pid: 0,
            type: 1, storeId: 0, promotionsType: 1, isDel: 0, addTime: now })
            .returning({ id: storePromotions.id });
          resultId = created.id;
        }
        // save_discount has one root rule. Preserve historical children and their
        // order allocations while replacing only this root's selection rows.
        await tx.delete(storePromotionsAuxiliary).where(and(eq(storePromotionsAuxiliary.promotionsId, resultId),
          eq(storePromotionsAuxiliary.type, 1)));
        const entries = input.scope === 2 || input.scope === 3
          ? input.products.map(item => ({ productId: item.product_id, unique: item.unique.join(','),
            isAll: Number(item.unique.length === skuCounts.get(item.product_id)) }))
          : input.scope === 4 ? input.brandIds.map(brandId => ({ brandId }))
            : input.scope === 5 ? input.labelIdsProduct.map(storeLabelId => ({ storeLabelId })) : [];
        for (let index = 0; index < entries.length; index += 1_000) {
          await tx.insert(storePromotionsAuxiliary).values(entries.slice(index, index + 1_000).map(entry => ({
            type: 1, promotionsId: resultId, productPartakeType: input.scope, ...entry,
          })));
        }
      } else if (operation === 'status') {
        if (parsed.status === 1) {
          if (row!.stopTime < now || row!.startTime > row!.stopTime || !row!.name
            || row!.discountType !== 2 || row!.thresholdType !== 1 || row!.promotionsCate !== 1
            || ![1, 2, 3, 4, 5].includes(row!.productPartakeType)
            || !Number.isInteger(Number(row!.discount)) || Number(row!.discount) < 0
            || Number(row!.discount) > 100) throw new ValidateException('限时折扣已过期或配置不完整');
          const links = await auxiliary(tx, id);
          const input = this.inputFromRow(row!, links);
          if (input.labelIds.length > 100) throw new ValidateException('付后用户标签最多选择100个');
          if ((input.scope === 2 || input.scope === 3) && !input.products.length
            || input.scope === 4 && !input.brandIds.length
            || input.scope === 5 && !input.labelIdsProduct.length
            || input.overlay.some(item => ![2, 3, 5].includes(item))) {
            throw new ValidateException('限时折扣范围或叠加配置不完整');
          }
          const skuCounts = await this.validateInput(tx, input);
          if ((input.scope === 2 || input.scope === 3) && links.some(link =>
            link.productPartakeType === input.scope && link.productId > 0
            && link.isAll !== Number(skuList(link.unique).length === skuCounts.get(link.productId)))) {
            throw new ValidateException('商品规格集合已变化，请编辑核对后再开启');
          }
        }
        await tx.update(storePromotions).set({ status: parsed.status!,
          updateTime: Math.max(now, row!.updateTime + 1) }).where(eq(storePromotions.id, id));
      } else {
        const derived = await tx.select({ id: storePromotions.id }).from(storePromotions).where(and(
          eq(storePromotions.pid, id), eq(storePromotions.promotionsType, 1), eq(storePromotions.isDel, 0),
        )).orderBy(asc(storePromotions.id)).for('update');
        await tx.update(storePromotions).set({ isDel: 1,
          updateTime: Math.max(now, row!.updateTime + 1) })
          .where(inArray(storePromotions.id, [id, ...derived.map(item => item.id)]));
      }
      await tx.insert(systemLog).values({ adminId: actor.id, type: 'time_discount',
        page: '/marketing/time-discounts', path,
        method: operation === 'create' ? 'POST' : operation === 'update' ? 'PUT'
          : operation === 'status' ? 'PATCH' : 'DELETE',
        action: `${operation};id=${resultId};payload=${payload}`, addTime: now });
      return { id: resultId };
    });
  }
}

