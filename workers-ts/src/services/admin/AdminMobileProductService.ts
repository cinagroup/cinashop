import {
  and,
  asc,
  desc,
  eq,
  inArray,
} from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {applyMobileProductShow,applyMobileProductSkus,applyMobileProductBatch,type MobileProductAudit} from '../product/MobileProductManagementCore';
import {
  legacyCategory,
  storeProduct,
  storeProductAttrValue,
  storeProductCategory,
  storeProductLabel,
  systemLog,
  systemStore,
  systemSupplier,
} from "@/models/schema";
import {
  type ProductEditorActor,
} from "@/services/product/ProductAssociationService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_PAGE = 1_000_000;
const MAX_LIMIT = 100;
const MAX_TEXT = 100;
const MAX_BATCH_PRODUCTS = 100;
const MAX_BATCH_RELATIONS = 50;
const MAX_BATCH_COUPONS = 20;
const MAX_SKUS = 500;
const MAX_MONEY = 9_999_999_999.99;
const RECOMMENDATION_KEYS = ["is_hot", "is_benefit", "is_best", "is_new", "is_good"] as const;

type RecommendationKey = typeof RECOMMENDATION_KEYS[number];

export type AdminProductBatchInput =
  | { type: 1 | 2; ids: number[]; relationIds: number[] }
  | { type: 3; ids: number[]; deliveryTypes: number[] }
  | { type: 4; ids: number[]; giveIntegral: string; couponIds: number[] }
  | { type: 5; ids: number[]; relationIds: number[] }
  | { type: 6; ids: number[]; recommendations: RecommendationKey[] }
  | { type: 7; ids: number[]; systemFormId: number }
  | { type: 8; ids: number[]; freight: 1 | 2 | 3; postage: string; templateId: number }
  | { type: 9; ids: number[]; relationIds: number[] };

type SkuRow = typeof storeProductAttrValue.$inferSelect;
type CategoryRow = typeof storeProductCategory.$inferSelect;

export interface AdminProductCategoryNode {
  id: number;
  pid: number;
  cate_name: string;
  pic: string;
  big_pic: string;
  children: AdminProductCategoryNode[];
}

export interface AdminProductListQuery {
  page: number;
  limit: number;
  keyword: string;
  status: number | null;
}

export interface AdminProductSkuUpdate {
  unique: string;
  price: string;
  cost: string;
  otPrice: string;
  stock: number;
}

function positiveInteger(
  value: unknown,
  label: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed;
}

function boundedText(value: unknown, label: string, maximum = MAX_TEXT): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new ValidateException(`${label}错误`);
  const text = value.trim();
  if (text.length > maximum) throw new ValidateException(`${label}不能超过${maximum}个字符`);
  return text;
}

function exactProductId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) {
    throw new ValidateException("请选择商品");
  }
  return id;
}

function integerIds(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
  sortResult = true,
): number[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string" && value.includes(",")
      ? value.split(",")
      : value === undefined || value === null || value === ""
        ? []
        : [value];
  const ids = [...new Set(source.map((item) => Number(item)))];
  if ((!allowEmpty && !ids.length) || ids.length > maximum || ids.some((id) => (
    !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647
  ))) {
    throw new ValidateException(label);
  }
  return sortResult ? ids.sort((left, right) => left - right) : ids;
}

function money(value: unknown, label: string): string {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new ValidateException(`${label}错误`);
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_MONEY) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed.toFixed(2);
}

function stock(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new ValidateException("库存错误");
  }
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed;
}

function recommendationKeys(value: unknown): RecommendationKey[] {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value) || value.length > RECOMMENDATION_KEYS.length) {
    throw new ValidateException("活动推荐错误");
  }
  const selected = new Set(value);
  if ([...selected].some((item) => typeof item !== "string" || !RECOMMENDATION_KEYS.includes(item as RecommendationKey))) {
    throw new ValidateException("活动推荐错误");
  }
  return RECOMMENDATION_KEYS.filter((key) => selected.has(key));
}

function parseStoredIds(value: unknown): number[] {
  let source: unknown = value;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      source = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  const values = Array.isArray(source)
    ? source
    : typeof source === "string" && source.trim()
      ? source.split(",")
      : [];
  const ids = values.map((item) => Number(item)).filter((id) => Number.isSafeInteger(id) && id > 0);
  return [...new Set(ids)].slice(0, MAX_BATCH_RELATIONS);
}

export function parseAdminProductListQuery(
  query: Record<string, string | undefined>,
): AdminProductListQuery {
  const rawStatus = query.type;
  let status: number | null = rawStatus === "" ? null : rawStatus === undefined ? 1 : Number(rawStatus);
  if (status !== null && (!Number.isSafeInteger(status) || status < -2 || status > 7)) {
    throw new ValidateException("商品状态错误");
  }
  return {
    page: positiveInteger(query.page, "页码", 1, MAX_PAGE),
    limit: positiveInteger(query.limit, "每页数量", 20, MAX_LIMIT),
    keyword: boundedText(query.store_name, "搜索词"),
    status,
  };
}

export function parseAdminProductShowBody(body: unknown): { ids: number[]; isShow: number } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidateException("请求数据格式错误");
  }
  const input = body as Record<string, unknown>;
  const ids = integerIds(input.ids ?? input.id, "请选择商品", MAX_BATCH_PRODUCTS);
  const isShow = Number(input.is_show);
  if (!Number.isSafeInteger(isShow) || ![0, 1].includes(isShow)) {
    throw new ValidateException("商品状态错误");
  }
  return { ids, isShow };
}

export function parseAdminProductSkuUpdates(body: unknown): AdminProductSkuUpdate[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidateException("请求数据格式错误");
  }
  const values = (body as Record<string, unknown>).attr_value;
  if (!Array.isArray(values) || !values.length || values.length > MAX_SKUS) {
    throw new ValidateException("请填写属性值");
  }
  const seen = new Set<string>();
  return values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidateException("请重新修改规格库存");
    }
    const input = value as Record<string, unknown>;
    for (const key of ["unique", "price", "stock", "cost", "ot_price"] as const) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) {
        throw new ValidateException("请重新修改规格库存");
      }
    }
    const unique = boundedText(input.unique, "规格标识", 8);
    if (!unique || seen.has(unique)) throw new ValidateException("规格标识重复或为空");
    seen.add(unique);
    return {
      unique,
      price: money(input.price, "售价"),
      cost: money(input.cost, "成本价"),
      otPrice: money(input.ot_price, "划线价"),
      stock: stock(input.stock),
    };
  });
}

export function parseAdminProductBatchBody(body: unknown): AdminProductBatchInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidateException("请求数据格式错误");
  }
  const input = body as Record<string, unknown>;
  const type = Number(input.type);
  if (!Number.isSafeInteger(type) || type < 1 || type > 9) {
    throw new ValidateException("请选择处理类型");
  }
  const ids = integerIds(input.ids, "请选择处理商品", MAX_BATCH_PRODUCTS);
  if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) {
    throw new ValidateException("请选择处理数据");
  }
  const data = input.data as Record<string, unknown>;
  if (type === 1 || type === 2 || type === 5 || type === 9) {
    const rawIds = type === 1
      ? data.cate_id
      : type === 2
        ? data.store_label_id
        : type === 5
          ? data.label_id
          : data.brand_id;
    const label = type === 1
      ? "请选择分类"
      : type === 2
        ? "商品标签错误"
        : type === 5
          ? "用户标签错误"
          : "商品品牌错误";
    return {
      type,
      ids,
      relationIds: integerIds(rawIds, label, MAX_BATCH_RELATIONS, type !== 1, type !== 9),
    };
  }
  if (type === 3) {
    const deliveryTypes = integerIds(data.delivery_type, "请选择商品配送方式", 3);
    if (deliveryTypes.some((item) => item < 1 || item > 3)) {
      throw new ValidateException("商品配送方式错误");
    }
    return { type, ids, deliveryTypes };
  }
  if (type === 4) {
    return {
      type,
      ids,
      giveIntegral: money(data.give_integral ?? 0, "赠送积分"),
      couponIds: integerIds(data.coupon_ids, "赠送优惠券错误", MAX_BATCH_COUPONS, true),
    };
  }
  if (type === 6) {
    return { type, ids, recommendations: recommendationKeys(data.recommend) };
  }
  if (type === 7) {
    return { type, ids, systemFormId: nonNegativeInteger(data.system_form_id, "系统表单") };
  }
  const freight = Number(data.freight);
  if (!Number.isSafeInteger(freight) || ![1, 2, 3].includes(freight)) {
    throw new ValidateException("运费设置错误");
  }
  const postage = money(data.postage ?? 0, "固定运费");
  const templateId = nonNegativeInteger(data.temp_id, "运费模板");
  if (freight === 2 && Number(postage) <= 0) throw new ValidateException("固定运费必须大于0");
  if (freight === 3 && templateId <= 0) throw new ValidateException("请选择运费模板");
  return {
    type: 8,
    ids,
    freight: freight as 1 | 2 | 3,
    postage: freight === 2 ? postage : "0.00",
    templateId: freight === 3 ? templateId : 0,
  };
}

function evidenceFingerprint(values: readonly (number | string)[]): string {
  let hash = 2_166_136_261;
  for (const code of values.join("\u0000")) {
    hash ^= code.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function writeBatchAudit(
  tx: DbClient,
  actor: ProductEditorActor,
  operation:
    | "show"
    | "hide"
    | "category"
    | "label"
    | "delivery"
    | "reward"
    | "user_label"
    | "recommend"
    | "form"
    | "freight"
    | "brand",
  productIds: number[],
  evidenceValues: readonly (number | string)[],
  now: number,
): Promise<void> {
  const relationEvidence = evidenceValues.length
    ? `;evidence=${evidenceValues.length}:${evidenceFingerprint(evidenceValues)}`
    : ";evidence=0";
  await tx.insert(systemLog).values(productIds.map((productId) => ({
    adminId: actor.id,
    adminName: actor.name.slice(0, 64),
    path: operation === "show" || operation === "hide"
      ? "/adminapi/product/set_show"
      : "/adminapi/product/batch_process",
    page: "/product",
    method: "POST",
    action: `product.batch_${operation};id=${productId}${relationEvidence}`,
    ip: actor.ip.slice(0, 45),
    type: "product",
    addTime: now,
  })));
}

function adminAudit(actor:ProductEditorActor):MobileProductAudit {return async(tx,event)=>{if(event.operation!=='sku')await writeBatchAudit(tx,actor,event.operation,event.productIds,event.evidenceValues,event.now);};}

function skuProjection(row: SkuRow) {
  return {
    id: row.id,
    product_id: row.productId,
    suk: row.suk,
    stock: row.stock,
    sum_stock: row.sumStock,
    sales: row.sales,
    price: row.price,
    cost: row.cost,
    ot_price: row.otPrice,
    image: row.image,
    unique: row.unique,
  };
}

function categoryProjection(row: CategoryRow): AdminProductCategoryNode {
  return {
    id: row.id,
    pid: row.pid,
    cate_name: row.cateName,
    pic: row.pic,
    big_pic: row.bigPic,
    children: [],
  };
}

export function buildAdminProductCategoryTree(rows: CategoryRow[]) {
  const projected = new Map(rows.map((row) => [row.id, categoryProjection(row)]));
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const roots: AdminProductCategoryNode[] = [];
  for (const row of rows) {
    const node = projected.get(row.id)!;
    const parent = projected.get(row.pid);
    let cursor = row.pid;
    const ancestors = new Set([row.id]);
    let cycle = false;
    while (cursor && rowById.has(cursor)) {
      if (ancestors.has(cursor)) {
        cycle = true;
        break;
      }
      ancestors.add(cursor);
      cursor = rowById.get(cursor)?.pid ?? 0;
    }
    if (parent && !cycle) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export class AdminMobileProductService {
  constructor(private readonly container: Container) {}

  async categories() {
    const rows = await this.container.db.select().from(storeProductCategory).where(and(
      eq(storeProductCategory.type, 0),
      eq(storeProductCategory.relationId, 0),
      eq(storeProductCategory.isShow, 1),
    )).orderBy(desc(storeProductCategory.sort), desc(storeProductCategory.id));
    return buildAdminProductCategoryTree(rows);
  }

  async list(rawQuery: Record<string, string | undefined>) {
    const query = parseAdminProductListQuery(rawQuery);
    const where: Record<string, unknown> = { isDel: 0 };
    if (query.keyword) where.store_name = query.keyword;
    if (query.status !== null) where.status = query.status;
    const count = await this.container.storeProductDao.countSearch(where);
    const page = count <= query.limit && query.page !== 1 ? 1 : query.page;
    const list = await this.container.storeProductDao.getSearchList({
      where,
      page,
      limit: query.limit,
    });
    const ids = list.map((item) => Number(item.id)).filter((id) => Number.isSafeInteger(id));
    if (!ids.length) return { list: [], count };
    const products = await this.container.db.select({
      id: storeProduct.id,
      is_show: storeProduct.isShow,
      type: storeProduct.type,
      relation_id: storeProduct.relationId,
      spec_type: storeProduct.specType,
      store_label_id: storeProduct.storeLabelId,
      cate_id: storeProduct.cateId,
    }).from(storeProduct).where(inArray(storeProduct.id, ids));
    const productById = new Map(products.map((item) => [item.id, item]));
    const singleIds = products.filter((item) => item.spec_type === 0).map((item) => item.id);
    const storeIds = products.filter((item) => item.type === 1).map((item) => item.relation_id);
    const supplierIds = products.filter((item) => item.type === 2).map((item) => item.relation_id);
    const [skus, stores, suppliers] = await Promise.all([
      singleIds.length
        ? this.container.db.select().from(storeProductAttrValue).where(and(
          inArray(storeProductAttrValue.productId, singleIds),
          eq(storeProductAttrValue.type, 0),
        )).orderBy(storeProductAttrValue.productId, storeProductAttrValue.id)
        : Promise.resolve([]),
      storeIds.length
        ? this.container.db.select({ id: systemStore.id, name: systemStore.name }).from(systemStore).where(and(
          inArray(systemStore.id, storeIds),
          eq(systemStore.isDel, 0),
        ))
        : Promise.resolve([]),
      supplierIds.length
        ? this.container.db.select({ id: systemSupplier.id, name: systemSupplier.supplierName })
          .from(systemSupplier).where(and(
            inArray(systemSupplier.id, supplierIds),
            eq(systemSupplier.isDel, 0),
          ))
        : Promise.resolve([]),
    ]);
    const storeById = new Map(stores.map((item) => [item.id, item.name]));
    const supplierById = new Map(suppliers.map((item) => [item.id, item.name]));
    const skuByProduct = new Map<number, ReturnType<typeof skuProjection>>();
    for (const sku of skus) if (!skuByProduct.has(sku.productId)) skuByProduct.set(sku.productId, skuProjection(sku));
    return {
      list: list.map((item) => {
        const id = Number(item.id);
        const product = productById.get(id);
        const productType = Number(product?.type ?? item.type ?? 0);
        return {
          ...item,
          is_show: product?.is_show ?? 0,
          cate_id: product?.cate_id ?? String(item.cate_id ?? ""),
          store_label_id: parseStoredIds(product?.store_label_id),
          attr_value: product?.spec_type === 0 ? skuByProduct.get(id) ?? null : undefined,
          branch_sales: Number(item.sales ?? 0),
          branch_stock: Number(item.stock ?? 0),
          stock_attr: Number(item.stock ?? 0) > 0,
          plate_name: productType === 1
            ? `门店：${storeById.get(product?.relation_id ?? 0) ?? ""}`
            : productType === 2
              ? `供应商：${supplierById.get(product?.relation_id ?? 0) ?? ""}`
              : "平台",
        };
      }),
      count,
    };
  }

  async setShow(body: unknown, actor: ProductEditorActor): Promise<{changed:number;verified:true}> {
    const input=parseAdminProductShowBody(body);
    return withTx(this.container,tx=>applyMobileProductShow(tx,input,adminAudit(actor)));
  }

  async labels() {
    const [groups, labels] = await Promise.all([
      this.container.db.select().from(legacyCategory).where(and(
        eq(legacyCategory.type, 0),
        eq(legacyCategory.relationId, 0),
        eq(legacyCategory.group, 2),
        eq(legacyCategory.isShow, 1),
      )).orderBy(desc(legacyCategory.sort), asc(legacyCategory.id)),
      this.container.db.select().from(storeProductLabel).where(and(
        eq(storeProductLabel.type, 0),
        eq(storeProductLabel.relationId, 0),
        eq(storeProductLabel.status, 1),
        eq(storeProductLabel.isShow, 1),
      )).orderBy(desc(storeProductLabel.sort), asc(storeProductLabel.id)),
    ]);
    const labelsByCategory = new Map<number, typeof labels>();
    for (const label of labels) {
      labelsByCategory.set(label.labelCate, [...(labelsByCategory.get(label.labelCate) ?? []), label]);
    }
    return groups.map((group) => ({
      id: group.id,
      value: group.id,
      label_cate: 0,
      label_name: group.name,
      label: group.name,
      relation_id: group.relationId,
      type: group.type,
      children: (labelsByCategory.get(group.id) ?? []).map((label) => ({
        id: label.id,
        value: label.id,
        label_cate: label.labelCate,
        label_name: label.labelName,
        label: label.labelName,
        relation_id: label.relationId,
        type: label.type,
        color: label.color,
        bg_color: label.bgColor,
        border_color: label.borderColor,
        icon: label.icon,
      })),
    }));
  }

  async getAttrs(rawProductId: unknown) {
    const productId = exactProductId(rawProductId);
    const product = (await this.container.db.select({ id: storeProduct.id }).from(storeProduct).where(and(
      eq(storeProduct.id, productId),
      eq(storeProduct.isDel, 0),
    )).limit(1))[0];
    if (!product) throw new NotFoundException("商品不存在");
    const rows = await this.container.db.select().from(storeProductAttrValue).where(and(
      eq(storeProductAttrValue.productId, productId),
      eq(storeProductAttrValue.type, 0),
      eq(storeProductAttrValue.isRetired, 0),
    )).orderBy(storeProductAttrValue.id);
    return rows.map(skuProjection);
  }

  async updateAttrs(rawProductId: unknown, body: unknown): Promise<{changed:number}> { const productId=exactProductId(rawProductId),updates=parseAdminProductSkuUpdates(body); return withTx(this.container,tx=>applyMobileProductSkus(tx,productId,updates,async()=>undefined)); }

  async batchProcess(body: unknown, actor: ProductEditorActor): Promise<{changed:number;relations:number;verified:true}> { const input=parseAdminProductBatchBody(body); return withTx(this.container,tx=>applyMobileProductBatch(tx,input,adminAudit(actor))); }
}
