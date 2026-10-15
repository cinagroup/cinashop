import { and, asc, desc, eq, gt, inArray, or, sql, type SQL } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductCategory, storeProductRelation, storeVisit,
  systemAdmin, systemStore, systemSupplier, userRelation } from '@/models/schema';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { ApiErrorCode, AuthException, HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { legacyPhpJsonDecodeWire } from '@/utils/legacy-php-json';
import { assertAdminAuthoritySession, parseAdminAuthorityRoleIds, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminLegacyRoleReferenceHistory } from './AdminLegacyRoleDeletionProof';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';

export type AdminProductCatalogReadActor = AdminAuthorityActor;
type Product = typeof storeProduct.$inferSelect;
const MAX_ID = 2147483647;
const FULL_LIST_CAPACITY = 10000;
const badText = /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u;
const arrayFields = new Set(['cate_id', 'brand_id', 'store_label_id']);
const scalarFields = new Set(['page', 'limit', 'type', 'sales', 'store_name', 'supplier_id', 'store_id', 'excel']);
type QueryInput = Map<string, string | string[]>;

function inputQuery(query: URLSearchParams): QueryInput {
  if (query.toString().length > 16384 || query.size > 320) throw new ValidateException('商品查询参数超出容量');
  const result: QueryInput = new Map(), indexes = new Map<string, Map<number, string>>(), modes = new Map<string, string>();
  for (const [key, value] of query) {
    if (badText.test(value) || [...value].length > 256) throw new ValidateException('商品查询参数包含非法字符或过长');
    const match = /^(cate_id|brand_id|store_label_id)\[(\d*)\]$/.exec(key);
    const base = match?.[1] ?? key;
    if (!arrayFields.has(base) && !scalarFields.has(base)) throw new ValidateException('商品查询包含未知参数');
    if (!match) {
      if (result.has(base) || modes.has(base)) throw new ValidateException('商品查询参数重复');
      result.set(base, value); modes.set(base, 'scalar');
      continue;
    }
    const mode = match[2] === '' ? 'append' : 'indexed';
    if (modes.has(base) && modes.get(base) !== mode) throw new ValidateException('商品查询数组参数混用');
    modes.set(base, mode);
    if (mode === 'append') {
      const values = result.get(base) as string[] | undefined;
      if (values) values.push(value); else result.set(base, [value]);
    } else {
      if (!/^(?:0|[1-9]\d*)$/.test(match[2]) || Number(match[2]) >= 100) throw new ValidateException('商品查询数组索引错误');
      const entries = indexes.get(base) ?? new Map<number, string>(), index = Number(match[2]);
      if (entries.has(index)) throw new ValidateException('商品查询数组索引重复');
      entries.set(index, value); indexes.set(base, entries);
    }
  }
  for (const [base, entries] of indexes) {
    const sorted = [...entries].sort(([a], [b]) => a - b);
    if (sorted.some(([index], position) => index !== position)) throw new ValidateException('商品查询数组索引不连续');
    result.set(base, sorted.map(([, value]) => value));
  }
  if ([...result.values()].some(value => Array.isArray(value) && value.length > 100)) throw new ValidateException('商品查询数组最多100项');
  return result;
}
function integer(value: string | undefined, label: string, fallback = 0): number {
  if (value === undefined || value === '') return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new ValidateException(`${label}错误`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_ID) throw new ValidateException(`${label}超出范围`);
  return parsed;
}
function ids(value: string | string[] | undefined, label: string, dropZero = false): number[] {
  if (value === undefined || value === '' || value === '0') return [];
  // The source category controller wraps a scalar as ONE array element. It
  // does not turn "1,2" into two categories. PHP/Axios bracket arrays work.
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(item => integer(item, label)).filter(id => !dropZero || id !== 0))];
}
function options(query: URLSearchParams) {
  const input = inputQuery(query), get = (key: string) => input.get(key) as string | undefined;
  const status = get('type') ?? '1';
  if (!['', '-2', '-1', '0', '1', '2', '3', '4', '5', '6', '7'].includes(status)) throw new ValidateException('商品状态筛选错误');
  const sales = get('sales') ?? 'normal';
  if (!['normal', '', 'asc', 'desc'].includes(sales)) throw new ValidateException('商品销量排序错误');
  if (get('excel') !== undefined && !['0', '1', ''].includes(get('excel')!)) throw new ValidateException('商品表格参数错误');
  const page = integer(get('page'), '商品页码'), limit = Math.min(100, integer(get('limit'), '商品每页数量'));
  if (page > 1000000 || Math.max(0, page - 1) * limit > MAX_ID) throw new ValidateException('商品分页超出范围');
  return { status, sales, page, limit, keyword: get('store_name') ?? '', supplierId: integer(get('supplier_id'), '供应商ID'),
    storeId: integer(get('store_id'), '门店ID'), categories: ids(input.get('cate_id'), '分类ID', true),
    brands: ids(input.get('brand_id'), '品牌ID'), labels: ids(input.get('store_label_id'), '标签ID') };
}
type Options = ReturnType<typeof options>;
function statusConditions(status: string, categoryCount = false): SQL[] {
  switch (status) {
    case '-2': case '-1': return [eq(storeProduct.isVerify, Number(status))];
    case '0': return [eq(storeProduct.isVerify, 0), eq(storeProduct.isDel, 0)];
    case '1': case '2': return [eq(storeProduct.isShow, status === '1' ? 1 : 0), eq(storeProduct.isDel, 0), ...(categoryCount ? [] : [eq(storeProduct.isVerify, 1)])];
    case '3': return [eq(storeProduct.isDel, 0), ...(categoryCount ? [] : [eq(storeProduct.isVerify, 1)])];
    case '4': return [eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1), categoryCount
      ? and(eq(storeProduct.isSold, 1), eq(storeProduct.stock, 0))!
      : or(eq(storeProduct.isSold, 1), eq(storeProduct.stock, 0))!];
    case '5': return [eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1), eq(storeProduct.isPolices, 1), gt(storeProduct.stock, 0)];
    case '6': return [eq(storeProduct.isDel, 1)];
    case '7': return [or(eq(storeProduct.isDel, 1), eq(storeProduct.isShow, 0))!];
    default: return [];
  }
}
function relation(type: number, values: number[]): SQL {
  return sql`EXISTS (SELECT 1 FROM ${storeProductRelation} WHERE ${storeProductRelation.productId}=${storeProduct.id}
    AND ${storeProductRelation.type}=${type} AND ${inArray(storeProductRelation.relationId, values)})`;
}
function conditions(input: Options, status: string, header: boolean, count: boolean): SQL[] {
  // StoreProductDao.getCount's nonempty category-array branch is a separate
  // query. It intentionally does not call search(), so owner/name/brand/label
  // constraints disappear and some status predicates differ from list().
  if (count && input.categories.length) return [relation(1, input.categories), ...statusConditions(status, true)];
  const result = statusConditions(status);
  if (header && input.storeId) {
    result.push(eq(storeProduct.type, 1), eq(storeProduct.relationId, input.storeId));
    // The PHP store branch unsets store_id but leaves supplier_id. Its model
    // searcher adds an incompatible second owner when both were selected.
    if (input.supplierId) result.push(eq(storeProduct.type, 2), eq(storeProduct.relationId, input.supplierId));
  } else if (input.supplierId) result.push(eq(storeProduct.type, 2), eq(storeProduct.relationId, input.supplierId));
  else result.push(eq(storeProduct.pid, 0));
  if (input.categories.length) result.push(relation(1, input.categories));
  if (input.brands.length) result.push(inArray(storeProduct.brandId, input.brands), relation(2, input.brands));
  if (input.labels.length) result.push(relation(3, input.labels));
  if (input.keyword && input.keyword !== '0') {
    const trimmed = input.keyword.trim(), pattern = `%${trimmed}%`;
    result.push(or(sql`${storeProduct.id}::text ILIKE ${pattern}`, sql`${storeProduct.keyword} ILIKE ${pattern}`,
      sql`${storeProduct.storeName} ILIKE ${pattern}`, sql`${storeProduct.storeInfo} ILIKE ${pattern}`, sql`${storeProduct.barCode} ILIKE ${pattern}`,
      sql`EXISTS (SELECT 1 FROM ${storeProductAttrValue} WHERE ${storeProductAttrValue.productId}=${storeProduct.id} AND ${storeProductAttrValue.barCode}=${trimmed})`)!);
  }
  return result;
}
function safeNumber(value: unknown, nullable = false): number | null {
  if (nullable && value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new ServiceUnavailableException('历史商品汇总超出精确数字容量');
  return number;
}
function csv(value: string | null): number[] {
  if (!value || value === '0') return [];
  if (value.length > 32768) throw new ServiceUnavailableException('历史商品ID数组超出容量');
  const tokens = value.split(',').filter(item => item !== '' && item !== '0');
  if (tokens.length > 10000) throw new ServiceUnavailableException('历史商品ID数组超出容量');
  return tokens.map(item => safeNumber(/^[ \t\n\r\f\v]*[+-]?\d+/.exec(item)?.[0] ?? 0)!);
}
function sourceDto(row: Product) {
  const result = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]));
  result.is_police = row.isPolices; delete result.is_polices;
  return { ...result, id: row.id, image: row.image, recommend_image: row.recommendImage, store_name: row.storeName,
    slider_image: legacyPhpJsonDecodeWire(row.sliderImage),
    custom_form: row.customForm && row.customForm !== '0' ? legacyPhpJsonDecodeWire(row.customForm) : [],
    specs: row.specs && row.specs !== '0' ? legacyPhpJsonDecodeWire(row.specs) : [],
    delivery_type: row.deliveryType && row.deliveryType !== '0' ? row.deliveryType.split(',') : [],
    label_id: csv(row.labelId), store_label_id: csv(row.storeLabelId), ensure_id: csv(row.ensureId),
    price: row.price, settle_price: row.settlePrice, vip_price: row.vipPrice, ot_price: row.otPrice,
    stock: null as number | null, branch_stock: 0, branch_sales: row.sales,
    stock_attr: false, collect: 0, likes: 0, visitor: 0, cate_name: '', plate_name: '平台' };
}
type ProductDto = ReturnType<typeof sourceDto>;
function readError(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(new HttpApiException('商品数据或管理员权限正在更新，请刷新后重试', 409, 409), { cause: error });
    if (['42501', '57014'].includes(code)) throw Object.assign(new ServiceUnavailableException('商品读取运行权限未就绪或查询超时'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

/** Main catalogue reads retain the PHP controller/DAO semantics, including
 * its category-count exceptions. They do not reuse the approved-only picker. */
export class AdminProductCatalogReadService {
  constructor(private readonly container: Container, private readonly appKey?: string) {}

  private async transaction<T>(actor: AdminProductCatalogReadActor, work: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container, async tx => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
        const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
        if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
          || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
        const encoder = new TextEncoder();
        if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
        await loadAdminLegacyRoleReferenceHistory(tx, parseAdminAuthorityRoleIds(live.roles), live.level);
        const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
        if (live.level !== 0 && !hasAdminPermission(keys, 'product.view')) throw new AuthException('管理员权限已变化', ApiErrorCode.ERR_AUTH);
        assertAdminAuthoritySession(actor);
        const result = await work(tx);
        const [clock] = await tx.execute(sql`SELECT extract(epoch from clock_timestamp()) >= ${actor.expiresAt} AS expired`) as unknown as Array<{ expired: boolean }>;
        if (clock?.expired !== false) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
        assertAdminAuthoritySession(actor); return result;
      });
    } catch (error) { return readError(error); }
  }

  private async count(tx: DbClient, where: SQL[]): Promise<number> {
    const [row] = await tx.select({ count: sql<string>`count(*)::text` }).from(storeProduct).where(and(...where));
    return safeNumber(row?.count)!;
  }

  private async renderImages(tx: DbClient, rows: Product[], list: ProductDto[]): Promise<void> {
    const slots: Array<{ image: string; type: number; relationId: number; assign: (value: string) => void }> = [];
    const collect = (value: unknown, owner: Product, assign: (value: string) => void): void => {
      if (typeof value !== 'string') return;
      const reference = canonicalizePublishedAttachmentReference(value);
      // Preserve non-private PHP images exactly, including HTTP/relative/store
      // images. Only the app's exact private transport path gets a signature.
      if (!reference.startsWith('/api/assets/')) return;
      const id = parseCanonicalAttachmentId(reference);
      const validOwner = owner.type === 0 && owner.relationId === 0
        || [1, 2].includes(owner.type) && Number.isInteger(owner.relationId) && owner.relationId > 0 && owner.relationId <= MAX_ID;
      if (!this.appKey || !validOwner || id === null || id > MAX_ID) { assign(''); return; }
      slots.push({ image: reference, type: owner.type === 1 ? 0 : owner.type,
        relationId: owner.type === 1 ? 0 : owner.relationId, assign });
    };
    const collectJson = (value: unknown, owner: Product): void => {
      if (Array.isArray(value)) value.forEach((item, index) => typeof item === 'string'
        ? collect(item, owner, next => { value[index] = next; }) : collectJson(item, owner));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => typeof item === 'string'
        ? collect(item, owner, next => { (value as Record<string, unknown>)[key] = next; }) : collectJson(item, owner));
    };
    rows.forEach((owner, index) => {
      const item = list[index];
      collect(item.image, owner, value => { item.image = value; });
      collect(item.recommend_image, owner, value => { item.recommend_image = value; });
      if (typeof item.slider_image === 'string') collect(item.slider_image, owner, value => { item.slider_image = value; });
      else collectJson(item.slider_image, owner);
    });
    if (slots.length > 10000) throw new ServiceUnavailableException('商品完整图片预览超过10000项容量');
    const allowed = await publicProductPictures(tx, slots);
    const rendered = await renderProductPictures(this.appKey, allowed);
    slots.forEach((slot, index) => slot.assign(rendered[index]));
  }

  async list(query: URLSearchParams, actor: AdminProductCatalogReadActor) {
    const input = options(query);
    return this.transaction(actor, async tx => {
      const count = await this.count(tx, conditions(input, input.status, false, true));
      const page = count <= input.limit && input.page !== 1 ? 1 : input.page;
      const order = input.sales === 'asc' ? [asc(storeProduct.sales), desc(storeProduct.sort), desc(storeProduct.id)]
        : input.sales === 'desc' ? [desc(storeProduct.sales), desc(storeProduct.sort), desc(storeProduct.id)] : [desc(storeProduct.sort), desc(storeProduct.id)];
      const bounded = page !== 0 && input.limit !== 0;
      const rows = await tx.select().from(storeProduct).where(and(...conditions(input, input.status, false, false))).orderBy(...order)
        .limit(bounded ? input.limit : FULL_LIST_CAPACITY + 1).offset(bounded ? (page - 1) * input.limit : 0);
      if (rows.length > FULL_LIST_CAPACITY) throw new ServiceUnavailableException('商品完整列表超过10000项，请使用分页读取');
      const list = rows.map(sourceDto);
      const selected = rows.map(row => row.id);
      const cateIds = [...new Set(rows.flatMap(row => csv(row.cateId)).filter(id => id > 0 && id <= MAX_ID))];
      if (cateIds.length > 10000) throw new ServiceUnavailableException('商品完整分类名称超过10000项容量');
      const categories = cateIds.length ? await tx.select().from(storeProductCategory).where(inArray(storeProductCategory.id, cateIds)) : [];
      const parentIds = [...new Set(categories.map(row => row.pid).filter(Boolean))];
      const parents = parentIds.length ? await tx.select().from(storeProductCategory).where(and(inArray(storeProductCategory.id, parentIds), eq(storeProductCategory.isShow, 1))) : [];
      const parentNames = new Map(parents.map(row => [row.id, row.cateName]));
      const storeIds = [...new Set(rows.filter(row => row.type === 1).map(row => row.relationId))];
      const supplierIds = [...new Set(rows.filter(row => row.type === 2).map(row => row.relationId))];
      const stores = storeIds.length ? await tx.select({ id: systemStore.id, name: systemStore.name }).from(systemStore).where(and(inArray(systemStore.id, storeIds), eq(systemStore.isDel, 0))) : [];
      const suppliers = supplierIds.length ? await tx.select({ id: systemSupplier.id, name: systemSupplier.supplierName }).from(systemSupplier).where(and(inArray(systemSupplier.id, supplierIds), eq(systemSupplier.isDel, 0))) : [];
      const storesById = new Map(stores.map(row => [row.id, row.name])), suppliersById = new Map(suppliers.map(row => [row.id, row.name]));
      // Drizzle strips Column qualifiers inside a single-table projection,
      // including nested SQL. An unqualified "id" then resolves to the inner
      // relation/SKU/visit row. Keep the outer identifier a fixed SQL literal;
      // no request value is interpolated into this identifier.
      const totals = selected.length ? await tx.select({ id: storeProduct.id,
        collect: sql<string>`(SELECT count(*)::text FROM ${userRelation} WHERE ${userRelation.relationId}=${sql.raw('"store_product"."id"')} AND ${userRelation.category}='product' AND ${userRelation.type}='collect')`,
        likes: sql<string>`(SELECT count(*)::text FROM ${userRelation} WHERE ${userRelation.relationId}=${sql.raw('"store_product"."id"')} AND ${userRelation.category}='product' AND ${userRelation.type}='like')`,
        stock: sql<string | null>`(SELECT sum(${storeProductAttrValue.stock})::text FROM ${storeProductAttrValue} WHERE ${storeProductAttrValue.productId}=${sql.raw('"store_product"."id"')} AND ${storeProductAttrValue.type}=0)`,
        visitor: sql<string>`(SELECT count(*)::text FROM ${storeVisit} WHERE ${storeVisit.productId}=${sql.raw('"store_product"."id"')} AND ${storeVisit.productType}='product')`,
      }).from(storeProduct).where(inArray(storeProduct.id, selected)) : [];
      const totalById = new Map(totals.map(row => [row.id, row]));
      // PHP getSkuArray(..., key='product_id') collapses duplicate keys via
      // array_column(resultSet,null,key). Its no-ORDER result's final row wins;
      // the following min therefore is NOT a minimum over all ordinary SKUs.
      const fallbackIds = rows.filter(row => row.type === 2 && input.supplierId && Number(row.settlePrice) <= 0).map(row => row.id);
      const fallbackRows = fallbackIds.length ? await tx.select({ productId: storeProductAttrValue.productId, settlePrice: storeProductAttrValue.settlePrice })
        .from(storeProductAttrValue).where(and(inArray(storeProductAttrValue.productId, fallbackIds), eq(storeProductAttrValue.type, 0))).limit(10001) : [];
      if (fallbackRows.length > 10000) throw new ServiceUnavailableException('供应商结算价完整规格超过10000项');
      const fallback = new Map(fallbackRows.map(row => [row.productId, row.settlePrice]));
      rows.forEach((row, index) => {
        const item = list[index], total = totalById.get(row.id);
        if (!total) throw new ServiceUnavailableException('商品汇总读取不完整');
        item.stock = safeNumber(total.stock, true); item.branch_stock = item.stock ?? 0; item.stock_attr = item.stock !== null && item.stock > 0;
        item.collect = safeNumber(total.collect)!; item.likes = safeNumber(total.likes)!; item.visitor = safeNumber(total.visitor)!;
        const ownCategories = new Set(csv(row.cateId));
        item.cate_name = categories.filter(category => ownCategories.has(category.id)).map(category => {
          const parent = parentNames.get(category.pid);
          return `${parent ? `${parent}/` : ''}${category.cateName}`;
        }).filter(Boolean).join(',');
        if (row.type === 1) item.plate_name = `门店：${storesById.get(row.relationId) ?? ''}`;
        else if (row.type === 2) item.plate_name = `供应商：${suppliersById.get(row.relationId) ?? ''}`;
        if (fallbackIds.includes(row.id)) {
          const value = fallback.get(row.id);
          if (value === undefined) throw new ServiceUnavailableException('供应商商品缺少源结算价规格');
          item.settle_price = value;
        }
      });
      await this.renderImages(tx, rows, list);
      return { list, count };
    });
  }

  async header(query: URLSearchParams, actor: AdminProductCatalogReadActor) {
    const input = options(query);
    return this.transaction(actor, async tx => {
      const labels = [[1, '销售中'], [2, '仓库中'], [4, '已售罄'], [5, '库存预警'], [6, '回收站'], [0, '待审核'], [-1, '审核未通过'], [-2, '强制下架']] as const;
      const list: Array<{ type: number; name: string; count: number }> = [];
      for (const [type, name] of labels) list.push({ type, name, count: await this.count(tx, conditions(input, String(type), true, true)) });
      return { list };
    });
  }

  /** The old supplier selector reads no query values and returns every
   * nondeleted supplier, including disabled suppliers, in descending ID order.
   * Bound the otherwise ignored transport without turning it into pagination. */
  async supplierOptions(query: URLSearchParams, actor: AdminProductCatalogReadActor) {
    if (new TextEncoder().encode(query.toString()).byteLength > 16384 || query.size > 320
      || [...query].some(([key, value]) => [...key].length > 256 || [...value].length > 256)) {
      throw new ValidateException('供应商查询参数超出容量');
    }
    return this.transaction(actor, async tx => {
      const rows = await tx.select({ id: systemSupplier.id, supplier_name: systemSupplier.supplierName })
        .from(systemSupplier).where(eq(systemSupplier.isDel, 0)).orderBy(desc(systemSupplier.id)).limit(FULL_LIST_CAPACITY + 1);
      if (rows.length > FULL_LIST_CAPACITY) throw new ServiceUnavailableException('供应商完整选项超过10000项容量');
      return rows;
    });
  }
}
