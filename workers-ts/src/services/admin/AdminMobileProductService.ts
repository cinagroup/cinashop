import {
  and,
  asc,
  desc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  legacyCategory,
  shippingTemplates,
  storeCart,
  storeBrand,
  storeCouponIssue,
  storeProduct,
  storeProductAttrValue,
  storeProductCategory,
  storeProductCoupon,
  storeProductLabel,
  storeProductRelation,
  storeProductStockRecord,
  systemForm,
  systemLog,
  systemStore,
  systemSupplier,
  userLabel,
} from "@/models/schema";
import {
  lockProductWrite,
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
const PRODUCT_CATEGORY_RELATION = 1;
const PRODUCT_BRAND_RELATION = 2;
const PRODUCT_LABEL_RELATION = 3;
const PRODUCT_USER_LABEL_RELATION = 4;
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

  async setShow(body: unknown, actor: ProductEditorActor): Promise<{ changed: number; verified: true }> {
    const input = parseAdminProductShowBody(body);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      for (const productId of input.ids) await lockProductWrite(tx, productId);
      const products = await tx.select({
        id: storeProduct.id,
        isDel: storeProduct.isDel,
        isVerify: storeProduct.isVerify,
      }).from(storeProduct).where(inArray(storeProduct.id, input.ids)).orderBy(asc(storeProduct.id)).for("update");
      if (products.length !== input.ids.length) throw new NotFoundException("商品不存在");
      if (products.some((product) => product.isDel === 1)) {
        throw new ValidateException("回收站商品不能修改上下架状态");
      }
      if (input.isShow === 1 && products.some((product) => product.isVerify !== 1)) {
        throw new ValidateException("商品尚未审核通过");
      }
      await tx.update(storeProduct).set(input.isShow === 1
        ? { isShow: 1, autoOffTime: 0 }
        : { isShow: 0 }).where(inArray(storeProduct.id, input.ids));
      await tx.update(storeCart).set({ status: input.isShow }).where(and(
        inArray(storeCart.productId, input.ids),
        eq(storeCart.isPay, 0),
        eq(storeCart.isDel, 0),
      ));
      await tx.update(storeProductRelation).set({ status: input.isShow }).where(and(
        inArray(storeProductRelation.productId, input.ids),
        eq(storeProductRelation.type, PRODUCT_CATEGORY_RELATION),
      ));
      const [savedProducts, badCarts, badRelations] = await Promise.all([
        tx.select({
          id: storeProduct.id,
          isShow: storeProduct.isShow,
          autoOffTime: storeProduct.autoOffTime,
        }).from(storeProduct).where(inArray(storeProduct.id, input.ids)),
        tx.select({ id: storeCart.id }).from(storeCart).where(and(
          inArray(storeCart.productId, input.ids),
          eq(storeCart.isPay, 0),
          eq(storeCart.isDel, 0),
          sql`${storeCart.status} <> ${input.isShow}`,
        )).limit(1),
        tx.select({ id: storeProductRelation.id }).from(storeProductRelation).where(and(
          inArray(storeProductRelation.productId, input.ids),
          eq(storeProductRelation.type, PRODUCT_CATEGORY_RELATION),
          sql`${storeProductRelation.status} <> ${input.isShow}`,
        )).limit(1),
      ]);
      if (
        savedProducts.length !== input.ids.length
        || savedProducts.some((product) => (
          product.isShow !== input.isShow
          || (input.isShow === 1 && product.autoOffTime !== 0)
        ))
        || badCarts[0]
        || badRelations[0]
      ) throw new Error("商品批量上下架数据库回读校验失败");
      await writeBatchAudit(
        tx,
        actor,
        input.isShow === 1 ? "show" : "hide",
        input.ids,
        [],
        Math.floor(Date.now() / 1000),
      );
      return { changed: input.ids.length, verified: true };
    });
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

  async updateAttrs(rawProductId: unknown, body: unknown): Promise<{ changed: number }> {
    const productId = exactProductId(rawProductId);
    const updates = parseAdminProductSkuUpdates(body);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      const product = (await tx.select().from(storeProduct).where(and(
        eq(storeProduct.id, productId),
        eq(storeProduct.isDel, 0),
      )).for("update").limit(1))[0];
      if (!product) throw new NotFoundException("商品不存在");
      const current = await tx.select().from(storeProductAttrValue).where(and(
        eq(storeProductAttrValue.productId, productId),
        eq(storeProductAttrValue.type, 0),
        eq(storeProductAttrValue.isRetired, 0),
      )).orderBy(storeProductAttrValue.id).for("update");
      if (!current.length) throw new NotFoundException("商品规格不存在");
      const currentByUnique = new Map(current.map((item) => [item.unique, item]));
      if (updates.some((item) => !currentByUnique.has(item.unique))) {
        throw new ValidateException("规格不属于当前商品");
      }
      const updatesByUnique = new Map(updates.map((item) => [item.unique, item]));
      const finalRows = current.map((item) => ({
        ...item,
        ...(updatesByUnique.get(item.unique) ?? {}),
      }));
      const aggregateStock = finalRows.reduce((total, item) => total + Number(item.stock), 0);
      if (!Number.isSafeInteger(aggregateStock) || aggregateStock > 2_147_483_647) {
        throw new ValidateException("商品总库存超出允许范围");
      }
      const now = Math.floor(Date.now() / 1000);
      const stockRecords: Array<typeof storeProductStockRecord.$inferInsert> = [];
      for (const update of updates) {
        const previous = currentByUnique.get(update.unique)!;
        await tx.update(storeProductAttrValue).set({
          price: update.price,
          cost: update.cost,
          otPrice: update.otPrice,
          stock: update.stock,
          sumStock: update.stock,
        }).where(and(
          eq(storeProductAttrValue.id, previous.id),
          eq(storeProductAttrValue.productId, productId),
          eq(storeProductAttrValue.type, 0),
          eq(storeProductAttrValue.isRetired, 0),
        ));
        const difference = update.stock - previous.stock;
        if (difference !== 0) stockRecords.push({
          storeId: product.type === 1 ? product.relationId : 0,
          productId,
          unique: update.unique,
          costPrice: update.cost,
          number: Math.abs(difference),
          pm: difference > 0 ? 1 : 0,
          addTime: now,
        });
      }
      await tx.update(storeProduct).set({
        stock: aggregateStock,
        price: Math.max(...finalRows.map((item) => Number(item.price))).toFixed(2),
        cost: Math.max(...finalRows.map((item) => Number(item.cost))).toFixed(2),
        otPrice: Math.max(...finalRows.map((item) => Number(item.otPrice))).toFixed(2),
      }).where(eq(storeProduct.id, productId));
      if (stockRecords.length) await tx.insert(storeProductStockRecord).values(stockRecords);
      return { changed: updates.length };
    });
  }

  async batchProcess(
    body: unknown,
    actor: ProductEditorActor,
  ): Promise<{ changed: number; relations: number; verified: true }> {
    const input = parseAdminProductBatchBody(body);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      for (const productId of input.ids) await lockProductWrite(tx, productId);
      const products = await tx.select({
        id: storeProduct.id,
        isShow: storeProduct.isShow,
        type: storeProduct.type,
        relationId: storeProduct.relationId,
      }).from(storeProduct).where(and(
        inArray(storeProduct.id, input.ids),
        eq(storeProduct.isDel, 0),
      )).orderBy(asc(storeProduct.id)).for("update");
      if (products.length !== input.ids.length) throw new NotFoundException("商品不存在或已删除");
      const productById = new Map(products.map((product) => [product.id, product]));
      const now = Math.floor(Date.now() / 1000);
      const categoryById = new Map<number, { id: number; pid: number }>();
      let relationType = 0;
      let relationIds: number[] = [];
      let couponIds: number[] = [];
      let evidenceValues: Array<number | string> = [];
      let operation: Parameters<typeof writeBatchAudit>[2];

      if (input.type === 1) {
        operation = "category";
        relationType = PRODUCT_CATEGORY_RELATION;
        relationIds = input.relationIds;
        evidenceValues = relationIds;
        const categories = await tx.select({
          id: storeProductCategory.id,
          pid: storeProductCategory.pid,
        }).from(storeProductCategory).where(and(
          inArray(storeProductCategory.id, input.relationIds),
          eq(storeProductCategory.type, 0),
          eq(storeProductCategory.relationId, 0),
          eq(storeProductCategory.isShow, 1),
        )).for("share");
        if (categories.length !== input.relationIds.length) throw new ValidateException("分类不存在或不可用");
        for (const category of categories) categoryById.set(category.id, category);
        await tx.update(storeProduct).set({ cateId: input.relationIds.join(",") })
          .where(inArray(storeProduct.id, input.ids));
      } else if (input.type === 2) {
        operation = "label";
        relationType = PRODUCT_LABEL_RELATION;
        relationIds = input.relationIds;
        evidenceValues = relationIds;
        if (input.relationIds.length) {
          const labels = await tx.select({ id: storeProductLabel.id }).from(storeProductLabel).where(and(
            inArray(storeProductLabel.id, input.relationIds),
            eq(storeProductLabel.type, 0),
            eq(storeProductLabel.relationId, 0),
            eq(storeProductLabel.status, 1),
            eq(storeProductLabel.isShow, 1),
          )).for("share");
          if (labels.length !== input.relationIds.length) throw new ValidateException("商品标签不存在或不可用");
        }
        await tx.update(storeProduct).set({ storeLabelId: input.relationIds.join(",") })
          .where(inArray(storeProduct.id, input.ids));
      } else if (input.type === 3) {
        operation = "delivery";
        evidenceValues = input.deliveryTypes;
        await tx.update(storeProduct).set({ deliveryType: input.deliveryTypes.join(",") })
          .where(inArray(storeProduct.id, input.ids));
      } else if (input.type === 4) {
        operation = "reward";
        couponIds = input.couponIds;
        evidenceValues = [input.giveIntegral, ...couponIds];
        const issues = couponIds.length
          ? await tx.select({
              id: storeCouponIssue.id,
              title: storeCouponIssue.title,
              couponTitle: storeCouponIssue.couponTitle,
            }).from(storeCouponIssue).where(and(
              inArray(storeCouponIssue.id, couponIds),
              eq(storeCouponIssue.isDel, 0),
              eq(storeCouponIssue.status, 1),
            )).orderBy(asc(storeCouponIssue.id)).for("share")
          : [];
        if (issues.length !== couponIds.length) throw new ValidateException("赠送优惠券不存在或不可用");
        await tx.update(storeProduct).set({ giveIntegral: input.giveIntegral })
          .where(inArray(storeProduct.id, input.ids));
        await tx.delete(storeProductCoupon).where(inArray(storeProductCoupon.productId, input.ids));
        if (issues.length) {
          const issueById = new Map(issues.map((issue) => [issue.id, issue]));
          await tx.insert(storeProductCoupon).values(input.ids.flatMap((productId) => couponIds.map((couponId) => {
            const issue = issueById.get(couponId)!;
            return {
              productId,
              issueCouponId: couponId,
              title: issue.couponTitle || issue.title,
              addTime: now,
            };
          })));
        }
      } else if (input.type === 5) {
        operation = "user_label";
        relationType = PRODUCT_USER_LABEL_RELATION;
        relationIds = input.relationIds;
        evidenceValues = relationIds;
        const labels = relationIds.length
          ? await tx.select({
              id: userLabel.id,
              type: userLabel.type,
              relationId: userLabel.relationId,
            }).from(userLabel).where(and(
              inArray(userLabel.id, relationIds),
              eq(userLabel.status, 1),
            )).orderBy(asc(userLabel.id)).for("share")
          : [];
        if (labels.length !== relationIds.length || labels.some((label) => products.some((product) => !(
          (label.type === 0 && label.relationId === 0)
          || (label.type === product.type && label.relationId === product.relationId)
        )))) throw new ValidateException("用户标签不存在或不属于所选商品");
        await tx.update(storeProduct).set({ labelId: relationIds.join(",") })
          .where(inArray(storeProduct.id, input.ids));
      } else if (input.type === 6) {
        operation = "recommend";
        evidenceValues = input.recommendations;
        const selected = new Set(input.recommendations);
        await tx.update(storeProduct).set({
          isHot: selected.has("is_hot") ? 1 : 0,
          isBenefit: selected.has("is_benefit") ? 1 : 0,
          isBest: selected.has("is_best") ? 1 : 0,
          isNew: selected.has("is_new") ? 1 : 0,
          isGood: selected.has("is_good") ? 1 : 0,
        }).where(inArray(storeProduct.id, input.ids));
      } else if (input.type === 7) {
        operation = "form";
        evidenceValues = [input.systemFormId];
        if (input.systemFormId > 0) {
          const forms = await tx.select({ id: systemForm.id }).from(systemForm).where(and(
            eq(systemForm.id, input.systemFormId),
            eq(systemForm.isDel, 0),
            eq(systemForm.status, 1),
          )).limit(1).for("share");
          if (!forms[0]) throw new ValidateException("系统表单不存在或不可用");
        }
        await tx.update(storeProduct).set({ systemFormId: input.systemFormId })
          .where(inArray(storeProduct.id, input.ids));
      } else if (input.type === 8) {
        operation = "freight";
        evidenceValues = [input.freight, input.postage, input.templateId];
        if (input.templateId > 0) {
          const templates = await tx.select({
            id: shippingTemplates.id,
            ownerType: shippingTemplates.ownerType,
            relationId: shippingTemplates.relationId,
          }).from(shippingTemplates).where(and(
            eq(shippingTemplates.id, input.templateId),
            eq(shippingTemplates.status, 1),
            eq(shippingTemplates.isDel, 0),
          )).limit(1).for("share");
          const template = templates[0];
          if (!template || products.some((product) => !(
            (template.ownerType === 0 && template.relationId === 0)
            || (template.ownerType === product.type && template.relationId === product.relationId)
          ))) throw new ValidateException("运费模板不存在或不属于所选商品");
        }
        await tx.update(storeProduct).set({
          freight: input.freight,
          postage: input.postage,
          tempId: input.templateId,
        }).where(inArray(storeProduct.id, input.ids));
      } else {
        operation = "brand";
        relationType = PRODUCT_BRAND_RELATION;
        relationIds = input.relationIds;
        evidenceValues = relationIds;
        const brands = relationIds.length
          ? await tx.select({ id: storeBrand.id, pid: storeBrand.pid }).from(storeBrand).where(and(
              inArray(storeBrand.id, relationIds),
              eq(storeBrand.isDel, 0),
              eq(storeBrand.isShow, 1),
            )).orderBy(asc(storeBrand.id)).for("share")
          : [];
        if (brands.length !== relationIds.length) throw new ValidateException("商品品牌不存在或不可用");
        const brandById = new Map(brands.map((brand) => [brand.id, brand]));
        if (relationIds.slice(1).some((brandId, index) => brandById.get(brandId)?.pid !== relationIds[index])) {
          throw new ValidateException("商品品牌必须是连续的层级路径");
        }
        await tx.update(storeProduct).set({
          brandId: relationIds.at(-1) ?? 0,
          brandCom: relationIds.join(","),
        }).where(inArray(storeProduct.id, input.ids));
      }

      if (relationType > 0) {
        await tx.delete(storeProductRelation).where(and(
          inArray(storeProductRelation.productId, input.ids),
          eq(storeProductRelation.type, relationType),
        ));
        if (relationIds.length) {
          await tx.insert(storeProductRelation).values(input.ids.flatMap((productId) => relationIds.map((relationId) => ({
            type: relationType,
            productId,
            relationId,
            relationPid: relationType === PRODUCT_CATEGORY_RELATION ? categoryById.get(relationId)?.pid ?? 0 : 0,
            status: relationType === PRODUCT_CATEGORY_RELATION ? productById.get(productId)?.isShow ?? 0 : 1,
            addTime: now,
          }))));
        }
      }

      const [savedProducts, savedRelations, savedCoupons] = await Promise.all([
        tx.select({
          id: storeProduct.id,
          cateId: storeProduct.cateId,
          storeLabelId: storeProduct.storeLabelId,
          deliveryType: storeProduct.deliveryType,
          giveIntegral: storeProduct.giveIntegral,
          labelId: storeProduct.labelId,
          isHot: storeProduct.isHot,
          isBenefit: storeProduct.isBenefit,
          isBest: storeProduct.isBest,
          isNew: storeProduct.isNew,
          isGood: storeProduct.isGood,
          systemFormId: storeProduct.systemFormId,
          freight: storeProduct.freight,
          postage: storeProduct.postage,
          tempId: storeProduct.tempId,
          brandId: storeProduct.brandId,
          brandCom: storeProduct.brandCom,
        }).from(storeProduct).where(inArray(storeProduct.id, input.ids)),
        relationType > 0
          ? tx.select({
              productId: storeProductRelation.productId,
              relationId: storeProductRelation.relationId,
              relationPid: storeProductRelation.relationPid,
              status: storeProductRelation.status,
            }).from(storeProductRelation).where(and(
              inArray(storeProductRelation.productId, input.ids),
              eq(storeProductRelation.type, relationType),
            ))
          : Promise.resolve([]),
        input.type === 4
          ? tx.select({
              productId: storeProductCoupon.productId,
              issueCouponId: storeProductCoupon.issueCouponId,
            }).from(storeProductCoupon).where(inArray(storeProductCoupon.productId, input.ids))
          : Promise.resolve([]),
      ]);
      const expectedCsv = relationIds.join(",");
      const selectedRecommendations = input.type === 6 ? new Set(input.recommendations) : null;
      const productReadbackFailed = savedProducts.length !== input.ids.length || savedProducts.some((product) => {
        switch (input.type) {
          case 1: return product.cateId !== expectedCsv;
          case 2: return product.storeLabelId !== expectedCsv;
          case 3: return product.deliveryType !== input.deliveryTypes.join(",");
          case 4: return String(product.giveIntegral) !== input.giveIntegral;
          case 5: return product.labelId !== expectedCsv;
          case 6: return product.isHot !== (selectedRecommendations!.has("is_hot") ? 1 : 0)
            || product.isBenefit !== (selectedRecommendations!.has("is_benefit") ? 1 : 0)
            || product.isBest !== (selectedRecommendations!.has("is_best") ? 1 : 0)
            || product.isNew !== (selectedRecommendations!.has("is_new") ? 1 : 0)
            || product.isGood !== (selectedRecommendations!.has("is_good") ? 1 : 0);
          case 7: return product.systemFormId !== input.systemFormId;
          case 8: return product.freight !== input.freight
            || String(product.postage) !== input.postage
            || product.tempId !== input.templateId;
          case 9: return product.brandId !== (relationIds.at(-1) ?? 0) || product.brandCom !== expectedCsv;
        }
      });
      const relationReadbackFailed = relationType > 0 && (
        savedRelations.length !== input.ids.length * relationIds.length
        || input.ids.some((productId) => {
          const rows = savedRelations.filter((row) => row.productId === productId);
          return rows.length !== relationIds.length || relationIds.some((relationId) => {
            const row = rows.find((item) => item.relationId === relationId);
            return !row
              || row.relationPid !== (relationType === PRODUCT_CATEGORY_RELATION
                ? categoryById.get(relationId)?.pid ?? 0
                : 0)
              || row.status !== (relationType === PRODUCT_CATEGORY_RELATION
                ? productById.get(productId)?.isShow ?? 0
                : 1);
          });
        })
      );
      const couponReadbackFailed = input.type === 4 && (
        savedCoupons.length !== input.ids.length * couponIds.length
        || input.ids.some((productId) => {
          const savedIds = savedCoupons
            .filter((row) => row.productId === productId)
            .map((row) => row.issueCouponId)
            .sort((left, right) => left - right);
          return savedIds.join(",") !== couponIds.join(",");
        })
      );
      if (
        productReadbackFailed
        || relationReadbackFailed
        || couponReadbackFailed
      ) throw new Error("商品批量运营数据库回读校验失败");
      await writeBatchAudit(
        tx,
        actor,
        operation,
        input.ids,
        evidenceValues,
        now,
      );
      return {
        changed: input.ids.length,
        relations: relationIds.length || couponIds.length,
        verified: true,
      };
    });
  }
}
