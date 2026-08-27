import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import {
  storeDiscounts,
  storeDiscountsProducts,
  storeProduct,
  storeProductAttr,
  storeProductAttrResult,
  storeProductAttrValue,
  userLabel,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

type UnknownRecord = Record<string, unknown>;
type DiscountRow = typeof storeDiscounts.$inferSelect;
type EntryRow = typeof storeDiscountsProducts.$inferSelect;
type ProductRow = typeof storeProduct.$inferSelect;
type AttrRow = typeof storeProductAttr.$inferSelect;
type SkuRow = typeof storeProductAttrValue.$inferSelect;

const PACKAGE_SKU_TYPE = 5;
const BASE_SKU_TYPE = 0;
const MAX_PRODUCTS = 100;
const MAX_SKUS_PER_PRODUCT = 200;
const PACKAGE_TIME_ZONE = "+08:00";

export interface NormalizedDiscountPackageSku {
  unique: string;
  price: string;
}

export interface NormalizedDiscountPackageProduct {
  productId: number;
  required: 0 | 1;
  skus: NormalizedDiscountPackageSku[];
}

export interface NormalizedDiscountPackageInput {
  id: number;
  title: string;
  image: string;
  type: 0 | 1;
  isLimit: 0 | 1;
  limitNum: number;
  linkIds: number[];
  isTime: 0 | 1;
  startTime: number;
  stopTime: number;
  sort: number;
  freeShipping: 0 | 1;
  status: 0 | 1;
  isSupportRefund: 0 | 1;
  deliveryType?: string;
  freight?: number;
  customForm?: string | null;
  products: NormalizedDiscountPackageProduct[];
}

function asRecord(value: unknown, message: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException(message);
  }
  return value as UnknownRecord;
}

function firstValue(input: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (input[key] !== undefined) return input[key];
  }
  return undefined;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new ValidateException(`请填写${field}`);
  const normalized = value.trim();
  if (!normalized) throw new ValidateException(`请填写${field}`);
  if (normalized.length > maxLength) throw new ValidateException(`${field}不能超过${maxLength}个字符`);
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ValidateException(`${field}格式错误`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new ValidateException(`${field}不能超过${maxLength}个字符`);
  return normalized;
}

function integerValue(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; fallback?: number } = {},
): number {
  if ((value === undefined || value === null || value === "") && options.fallback !== undefined) {
    return options.fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < (options.min ?? 0)
    || parsed > (options.max ?? 2_147_483_647)
  ) {
    throw new ValidateException(`${field}格式错误`);
  }
  return parsed;
}

function flagValue(value: unknown, field: string, fallback: 0 | 1): 0 | 1 {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  throw new ValidateException(`${field}格式错误`);
}

function moneyValue(value: unknown, field: string): string {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ValidateException(`${field}格式错误`);
  }
  const raw = String(value).trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(raw)) {
    throw new ValidateException(`${field}必须是最多两位小数的非负金额`);
  }
  const [whole, fraction = ""] = raw.split(".");
  return `${BigInt(whole).toString()}.${fraction.padEnd(2, "0")}`;
}

function positiveIds(value: unknown, field: string, max: number): number[] {
  const source = value === undefined || value === null || value === ""
    ? []
    : Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(",").filter(Boolean)
        : [value];
  const ids = source.map((item) => {
    const candidate = item && typeof item === "object" && !Array.isArray(item)
      ? firstValue(item as UnknownRecord, "id", "value")
      : item;
    return integerValue(candidate, field, { min: 1 });
  });
  if (ids.length > max) throw new ValidateException(`${field}最多选择${max}项`);
  if (new Set(ids).size !== ids.length) throw new ValidateException(`${field}不能重复`);
  return [...ids].sort((left, right) => left - right);
}

function parseDateOnly(value: unknown, endOfDay: boolean): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidateException("套餐时间格式错误");
  }
  const suffix = endOfDay ? `T23:59:59${PACKAGE_TIME_ZONE}` : `T00:00:00${PACKAGE_TIME_ZONE}`;
  const millis = Date.parse(`${value}${suffix}`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) === "Invalid") {
    throw new ValidateException("套餐时间格式错误");
  }
  const normalized = new Date(millis + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  if (normalized !== value) throw new ValidateException("套餐日期不存在");
  return Math.floor(millis / 1_000);
}

function normalizeTime(input: UnknownRecord, isTime: 0 | 1): { startTime: number; stopTime: number } {
  if (!isTime) return { startTime: 0, stopTime: 0 };
  const time = input.time;
  let startTime: number;
  let stopTime: number;
  if (Array.isArray(time) && time.length === 2) {
    startTime = parseDateOnly(time[0], false);
    stopTime = parseDateOnly(time[1], true);
  } else {
    startTime = integerValue(firstValue(input, "start_time", "startTime"), "开始时间", { min: 1 });
    stopTime = integerValue(firstValue(input, "stop_time", "stopTime"), "结束时间", { min: 1 });
  }
  if (stopTime < startTime) throw new ValidateException("套餐结束时间不能早于开始时间");
  return { startTime, stopTime };
}

function normalizeDeliveryType(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const source = Array.isArray(value) ? value.join(",") : optionalString(value, "配送方式", 10);
  if (source && !/^([123])(?:,[123]){0,2}$/.test(source)) {
    throw new ValidateException("配送方式格式错误");
  }
  if (new Set(source.split(",").filter(Boolean)).size !== source.split(",").filter(Boolean).length) {
    throw new ValidateException("配送方式不能重复");
  }
  return source;
}

function normalizeCustomForm(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  let serialized: string;
  if (typeof value === "string") {
    try {
      JSON.parse(value);
    } catch {
      throw new ValidateException("自定义表单格式错误");
    }
    serialized = value;
  } else if (typeof value === "object") {
    serialized = JSON.stringify(value);
  } else {
    throw new ValidateException("自定义表单格式错误");
  }
  if (serialized.length > 200_000) throw new ValidateException("自定义表单不能超过200000个字符");
  return serialized;
}

function normalizeProducts(value: unknown, packageType: 0 | 1): NormalizedDiscountPackageProduct[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new ValidateException("套餐内商品不能少于2个");
  }
  if (value.length > MAX_PRODUCTS) throw new ValidateException(`套餐商品不能超过${MAX_PRODUCTS}个`);
  const seenProducts = new Set<number>();
  const products = value.map((item) => {
    const row = asRecord(item, "套餐商品格式错误");
    const productId = integerValue(firstValue(row, "product_id", "productId", "id"), "商品 ID", {
      min: 1,
    });
    if (seenProducts.has(productId)) throw new ValidateException("套餐商品不能重复");
    seenProducts.add(productId);
    const rawSkus = firstValue(row, "skus", "attr", "attr_value", "attrValue");
    if (!Array.isArray(rawSkus) || rawSkus.length === 0 || rawSkus.length > MAX_SKUS_PER_PRODUCT) {
      throw new ValidateException(`商品 ${productId} 必须选择1到${MAX_SKUS_PER_PRODUCT}个规格`);
    }
    const seenSkus = new Set<string>();
    const skus = rawSkus.map((itemSku) => {
      const sku = asRecord(itemSku, "套餐规格格式错误");
      const unique = requiredString(
        firstValue(sku, "base_unique", "baseUnique", "unique"),
        "基础规格标识",
        32,
      );
      if (!/^[A-Za-z0-9_-]+$/.test(unique)) throw new ValidateException("基础规格标识无效");
      if (seenSkus.has(unique)) throw new ValidateException("同一商品规格不能重复");
      seenSkus.add(unique);
      return { unique, price: moneyValue(sku.price, "套餐规格价格") };
    });
    const required = packageType === 0 ? 0 : flagValue(row.type ?? row.required, "主商品标识", 0);
    return { productId, required, skus };
  });
  if (packageType === 1 && !products.some((product) => product.required === 1)) {
    throw new ValidateException("搭配套餐至少需要一个主商品");
  }
  return products;
}

export function normalizeDiscountPackageInput(input: UnknownRecord): NormalizedDiscountPackageInput {
  const type = integerValue(input.type, "套餐类型", { min: 0, max: 1, fallback: 0 }) as 0 | 1;
  const isLimit = flagValue(firstValue(input, "is_limit", "isLimit"), "限量开关", 0);
  const limitNum = isLimit
    ? integerValue(firstValue(input, "limit_num", "limitNum"), "套餐库存", { min: 1 })
    : 0;
  const linkIds = positiveIds(firstValue(input, "link_ids", "linkIds"), "用户标签", 100);
  if (linkIds.join(",").length > 255) throw new ValidateException("用户标签 ID 超出存储长度");
  const isTime = flagValue(firstValue(input, "is_time", "isTime"), "时间开关", 0);
  const { startTime, stopTime } = normalizeTime(input, isTime);
  const freightRaw = firstValue(input, "freight");
  const freight = freightRaw === undefined
    ? undefined
    : integerValue(freightRaw, "运费方式", { min: 1, max: 3 });
  return {
    id: integerValue(input.id, "套餐 ID", { min: 0, fallback: 0 }),
    title: requiredString(input.title, "套餐名称", 255),
    image: requiredString(input.image, "套餐图片", 500),
    type,
    isLimit,
    limitNum,
    linkIds,
    isTime,
    startTime,
    stopTime,
    sort: integerValue(input.sort, "排序", { min: 0, fallback: 0 }),
    freeShipping: flagValue(firstValue(input, "free_shipping", "freeShipping"), "包邮开关", 1),
    status: flagValue(input.status, "状态", 1),
    isSupportRefund: flagValue(
      firstValue(input, "is_support_refund", "isSupportRefund"),
      "退款开关",
      1,
    ),
    deliveryType: normalizeDeliveryType(firstValue(input, "delivery_type", "deliveryType")),
    freight,
    customForm: normalizeCustomForm(firstValue(input, "custom_form", "customForm")),
    products: normalizeProducts(input.products, type),
  };
}

function randomUnique(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function freshSkuUnique(tx: DbClient, reserved: Set<string>): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = randomUnique();
    if (reserved.has(candidate)) continue;
    const found = await tx
      .select({ id: storeProductAttrValue.id })
      .from(storeProductAttrValue)
      .where(eq(storeProductAttrValue.unique, candidate))
      .limit(1);
    if (!found[0]) {
      reserved.add(candidate);
      return candidate;
    }
  }
  throw new Error("套餐规格标识生成失败");
}

function clonePackageSku(
  base: SkuRow,
  entryId: number,
  unique: string,
  price: string,
  old?: SkuRow,
): typeof storeProductAttrValue.$inferInsert {
  return {
    productId: entryId,
    productType: base.productType,
    suk: base.suk,
    stock: base.stock,
    sumStock: base.sumStock,
    sales: old?.sales ?? 0,
    price,
    settlePrice: base.settlePrice,
    integral: base.integral,
    image: base.image,
    unique,
    cost: base.cost,
    barCode: base.barCode,
    otPrice: base.otPrice,
    vipPrice: base.vipPrice,
    weight: base.weight,
    volume: base.volume,
    brokerage: base.brokerage,
    brokerageTwo: base.brokerageTwo,
    type: PACKAGE_SKU_TYPE,
    quota: base.quota,
    quotaShow: base.quotaShow,
    code: base.code,
    diskInfo: base.diskInfo,
    writeTimes: base.writeTimes,
    writeValid: base.writeValid,
    writeDays: base.writeDays,
    writeStart: base.writeStart,
    writeEnd: base.writeEnd,
  };
}

function dateString(epoch: number): string {
  if (!epoch) return "";
  return new Date((epoch + 8 * 60 * 60) * 1_000).toISOString().slice(0, 10);
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row]);
  return grouped;
}

function availability(
  discount: DiscountRow,
  entries: EntryRow[],
  products: Map<number, ProductRow>,
  packageSkus: Map<number, SkuRow[]>,
  baseSkus: Map<number, SkuRow[]>,
  now: number,
): { available: boolean; reason: string; effectiveStatus: number; minPrice: string } {
  let reason = "";
  if (discount.status !== 1) reason = "套餐已停用";
  else if (discount.isTime === 1 && now < discount.startTime) reason = "套餐尚未开始";
  else if (discount.isTime === 1 && now > discount.stopTime) reason = "套餐已结束";
  else if (discount.isLimit === 1 && discount.limitNum <= 0) reason = "套餐库存不足";
  else if (entries.length < 2) reason = "套餐商品不足";

  let validCount = 0;
  let requiredInvalid = false;
  let minCents = 0n;
  for (const entry of entries) {
    const product = products.get(entry.productId);
    const baseBySuk = new Map((baseSkus.get(entry.productId) ?? []).map((sku) => [sku.suk, sku]));
    const usable = (packageSkus.get(entry.id) ?? []).filter((sku) => {
      const base = baseBySuk.get(sku.suk);
      return sku.stock > 0 && !!base && base.stock > 0;
    });
    const valid = !!product
      && product.isDel === 0
      && product.isShow === 1
      && product.stock > 0
      && product.productType === entry.productType
      && usable.length > 0;
    if (valid) {
      validCount++;
      const cents = usable.reduce((minimum, sku) => {
        const [whole, fraction = "00"] = sku.price.split(".");
        const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
        return minimum === null || value < minimum ? value : minimum;
      }, null as bigint | null);
      if (discount.type === 0 || entry.type === 1) minCents += cents ?? 0n;
    } else if (discount.type === 0 || entry.type === 1) {
      requiredInvalid = true;
    }
  }
  if (!reason && requiredInvalid) reason = "主商品已下架、规格失效或库存不足";
  if (!reason && discount.type === 1 && validCount < 2) reason = "可选套餐商品不足2个";
  const available = reason === "";
  return {
    available,
    reason,
    effectiveStatus: available ? 1 : 0,
    minPrice: `${minCents / 100n}.${String(minCents % 100n).padStart(2, "0")}`,
  };
}

export class AdminDiscountPackageService {
  constructor(private readonly container: Container) {}

  async list(query: Record<string, unknown>) {
    const page = Math.max(1, Number.parseInt(String(query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(query.limit ?? "20"), 10) || 20));
    const conditions: SQL[] = [eq(storeDiscounts.isDel, 0)];
    const type = query.type === undefined || query.type === "" ? null : Number(query.type);
    if (type !== null) {
      if (type !== 0 && type !== 1) throw new ValidateException("套餐类型格式错误");
      conditions.push(eq(storeDiscounts.type, type));
    }
    const status = query.status === undefined || query.status === "" ? null : Number(query.status);
    if (status !== null) {
      if (status !== 0 && status !== 1) throw new ValidateException("套餐状态格式错误");
      conditions.push(eq(storeDiscounts.status, status));
    }
    const title = typeof query.title === "string" ? query.title.trim().slice(0, 100) : "";
    if (title) conditions.push(ilike(storeDiscounts.title, `%${title}%`));
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(storeDiscounts)
        .where(where)
        .orderBy(desc(storeDiscounts.sort), desc(storeDiscounts.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(storeDiscounts).where(where),
    ]);
    const related = await this.loadRelated(rows);
    const now = Math.floor(Date.now() / 1_000);
    return {
      list: rows.map((row) => {
        const state = availability(
          row,
          related.entriesByDiscount.get(row.id) ?? [],
          related.productById,
          related.packageSkusByEntry,
          related.baseSkusByProduct,
          now,
        );
        return {
          ...row,
          is_limit: row.isLimit,
          limit_num: row.limitNum,
          link_ids: row.linkIds,
          product_ids: row.productIds,
          is_time: row.isTime,
          start_time: row.startTime,
          stop_time: row.stopTime,
          add_time: row.addTime,
          free_shipping: row.freeShipping,
          is_del: row.isDel,
          is_support_refund: row.isSupportRefund,
          delivery_type: row.deliveryType,
          custom_form: row.customForm,
          product_count: related.entriesByDiscount.get(row.id)?.length ?? 0,
          available: state.available,
          invalid_reason: state.reason,
          effective_status: state.effectiveStatus,
          min_price: state.minPrice,
        };
      }),
      count: totals[0]?.count ?? 0,
    };
  }

  async detail(id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("套餐 ID 格式错误");
    const discount = (
      await this.container.db
        .select()
        .from(storeDiscounts)
        .where(and(eq(storeDiscounts.id, id), eq(storeDiscounts.isDel, 0)))
        .limit(1)
    )[0];
    if (!discount) throw new NotFoundException("套餐不存在");
    const related = await this.loadRelated([discount]);
    const entries = related.entriesByDiscount.get(discount.id) ?? [];
    const labels = discount.linkIds
      ? await this.container.db
          .select({ id: userLabel.id, name: userLabel.name })
          .from(userLabel)
          .where(inArray(userLabel.id, discount.linkIds.split(",").map(Number).filter(Number.isSafeInteger)))
          .orderBy(asc(userLabel.sort), asc(userLabel.id))
      : [];
    const now = Math.floor(Date.now() / 1_000);
    const state = availability(
      discount,
      entries,
      related.productById,
      related.packageSkusByEntry,
      related.baseSkusByProduct,
      now,
    );
    return {
      ...discount,
      is_limit: discount.isLimit,
      limit_num: discount.limitNum,
      link_ids: labels,
      link_id_values: labels.map((label) => label.id),
      product_ids: discount.productIds,
      is_time: discount.isTime,
      start_time: discount.startTime,
      stop_time: discount.stopTime,
      time: discount.isTime ? [dateString(discount.startTime), dateString(discount.stopTime)] : [],
      add_time: discount.addTime,
      free_shipping: discount.freeShipping,
      is_del: discount.isDel,
      is_support_refund: discount.isSupportRefund,
      delivery_type: discount.deliveryType,
      custom_form: discount.customForm,
      available: state.available,
      invalid_reason: state.reason,
      effective_status: state.effectiveStatus,
      min_price: state.minPrice,
      products: entries.map((entry) => {
        const product = related.productById.get(entry.productId);
        const baseBySuk = new Map((related.baseSkusByProduct.get(entry.productId) ?? []).map((sku) => [sku.suk, sku]));
        const dimensions = related.attrsByProduct.get(entry.productId) ?? [];
        const items = dimensions.map((attr) => ({
          value: attr.attrName,
          detail: attr.attrValues.split(",").filter(Boolean),
        }));
        const skus = (related.packageSkusByEntry.get(entry.id) ?? []).map((sku) => {
          const base = baseBySuk.get(sku.suk);
          return {
            unique: base?.unique ?? "",
            base_unique: base?.unique ?? "",
            activity_unique: sku.unique,
            suk: sku.suk || "默认",
            value: sku.suk.split(",").filter(Boolean).join("，") || "默认",
            price: sku.price,
            p_price: base?.price ?? product?.price ?? "0.00",
            stock: Math.min(sku.stock, base?.stock ?? 0),
            image: sku.image,
          };
        });
        return {
          ...entry,
          entry_id: entry.id,
          discount_id: entry.discountId,
          product_id: entry.productId,
          product_type: entry.productType,
          store_name: entry.title,
          temp_id: entry.tempId,
          items,
          attr: skus,
          skus,
          product,
        };
      }),
    };
  }

  async productOptions(query: Record<string, unknown>) {
    const page = Math.max(1, Number.parseInt(String(query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(query.limit ?? "20"), 10) || 20));
    const keyword = typeof query.keyword === "string" ? query.keyword.trim().slice(0, 100) : "";
    const conditions: SQL[] = [
      eq(storeProduct.isShow, 1),
      eq(storeProduct.isDel, 0),
      gt(storeProduct.stock, 0),
    ];
    if (keyword) {
      conditions.push(or(ilike(storeProduct.storeName, `%${keyword}%`), eq(storeProduct.id, Number(keyword) || 0))!);
    }
    const where = and(...conditions);
    const [products, totals] = await Promise.all([
      this.container.db
        .select({
          id: storeProduct.id,
          storeName: storeProduct.storeName,
          image: storeProduct.image,
          price: storeProduct.price,
          otPrice: storeProduct.otPrice,
          stock: storeProduct.stock,
          productType: storeProduct.productType,
          specType: storeProduct.specType,
          tempId: storeProduct.tempId,
        })
        .from(storeProduct)
        .where(where)
        .orderBy(desc(storeProduct.sort), desc(storeProduct.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(storeProduct).where(where),
    ]);
    const ids = products.map((product) => product.id);
    const skus = ids.length
      ? await this.container.db
          .select()
          .from(storeProductAttrValue)
          .where(and(
            eq(storeProductAttrValue.type, BASE_SKU_TYPE),
            inArray(storeProductAttrValue.productId, ids),
            gt(storeProductAttrValue.stock, 0),
          ))
          .orderBy(asc(storeProductAttrValue.productId), asc(storeProductAttrValue.id))
      : [];
    const byProduct = groupBy(skus, (sku) => sku.productId);
    return {
      list: products.map((product) => ({
        id: product.id,
        product_id: product.id,
        store_name: product.storeName,
        image: product.image,
        price: product.price,
        ot_price: product.otPrice,
        stock: product.stock,
        product_type: product.productType,
        spec_type: product.specType,
        temp_id: product.tempId,
        skus: (byProduct.get(product.id) ?? []).map((sku) => ({
          unique: sku.unique,
          suk: sku.suk || "默认",
          price: sku.price,
          ot_price: sku.otPrice,
          stock: sku.stock,
          image: sku.image,
        })),
      })),
      count: totals[0]?.count ?? 0,
    };
  }

  async labelOptions(query: Record<string, unknown>) {
    const keyword = typeof query.keyword === "string" ? query.keyword.trim().slice(0, 100) : "";
    const where = keyword
      ? and(eq(userLabel.status, 1), ilike(userLabel.name, `%${keyword}%`))
      : eq(userLabel.status, 1);
    const rows = await this.container.db
      .select({ id: userLabel.id, name: userLabel.name })
      .from(userLabel)
      .where(where)
      .orderBy(asc(userLabel.sort), asc(userLabel.id))
      .limit(100);
    return rows;
  }

  async save(input: UnknownRecord) {
    const normalized = normalizeDiscountPackageInput(input);
    const now = Math.floor(Date.now() / 1_000);
    if (normalized.status === 1 && normalized.isTime === 1 && normalized.stopTime < now) {
      throw new ValidateException("套餐结束时间不能早于当前时间");
    }
    const discountId = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin-discount-package'))`);
      const current = normalized.id
        ? (
            await tx
              .select()
              .from(storeDiscounts)
              .where(eq(storeDiscounts.id, normalized.id))
              .limit(1)
              .for("update")
          )[0]
        : undefined;
      if (normalized.id && (!current || current.isDel !== 0)) throw new NotFoundException("套餐不存在");

      if (normalized.linkIds.length) {
        const labels = await tx
          .select({ id: userLabel.id })
          .from(userLabel)
          .where(inArray(userLabel.id, normalized.linkIds));
        if (labels.length !== normalized.linkIds.length) throw new ValidateException("用户标签已变更，请重新选择");
      }

      const productIds = normalized.products.map((product) => product.productId);
      const products = await tx
        .select()
        .from(storeProduct)
        .where(inArray(storeProduct.id, productIds))
        .orderBy(asc(storeProduct.id))
        .for("update");
      const productById = new Map(products.map((product) => [product.id, product]));
      for (const requested of normalized.products) {
        const product = productById.get(requested.productId);
        if (!product || product.isDel !== 0 || product.isShow !== 1 || product.stock <= 0) {
          throw new ValidateException(`商品 ${requested.productId} 已下架或库存不足`);
        }
      }

      const baseSkus = await tx
        .select()
        .from(storeProductAttrValue)
        .where(and(
          eq(storeProductAttrValue.type, BASE_SKU_TYPE),
          inArray(storeProductAttrValue.productId, productIds),
        ))
        .orderBy(asc(storeProductAttrValue.productId), asc(storeProductAttrValue.id))
        .for("update");
      const baseByProduct = groupBy(baseSkus, (sku) => sku.productId);
      for (const requested of normalized.products) {
        const byUnique = new Map((baseByProduct.get(requested.productId) ?? []).map((sku) => [sku.unique, sku]));
        for (const requestedSku of requested.skus) {
          const sku = byUnique.get(requestedSku.unique);
          if (!sku || sku.stock <= 0) {
            throw new ValidateException(`商品 ${requested.productId} 的规格已变更或库存不足`);
          }
        }
      }

      const baseAttrs = await tx
        .select()
        .from(storeProductAttr)
        .where(and(eq(storeProductAttr.type, BASE_SKU_TYPE), inArray(storeProductAttr.productId, productIds)))
        .orderBy(asc(storeProductAttr.productId), asc(storeProductAttr.id));
      const attrsByProduct = groupBy(baseAttrs, (attr) => attr.productId);

      const productIdsValue = normalized.type === 0
        ? productIds.join(",")
        : String(normalized.products.find((product) => product.required === 1)?.productId ?? "");
      if (productIdsValue.length > 255) throw new ValidateException("套餐商品 ID 超出存储长度");
      const values = {
        title: normalized.title,
        image: normalized.image,
        type: normalized.type,
        isLimit: normalized.isLimit,
        limitNum: normalized.limitNum,
        linkIds: normalized.linkIds.join(","),
        productIds: productIdsValue,
        isTime: normalized.isTime,
        startTime: normalized.startTime,
        stopTime: normalized.stopTime,
        sort: normalized.sort,
        freeShipping: normalized.freeShipping,
        status: normalized.status,
        isSupportRefund: normalized.isSupportRefund,
        deliveryType: normalized.deliveryType ?? current?.deliveryType ?? "",
        freight: normalized.freight ?? current?.freight ?? 2,
        customForm: normalized.customForm === undefined ? current?.customForm ?? null : normalized.customForm,
      };
      let savedId: number;
      if (current) {
        await tx.update(storeDiscounts).set(values).where(eq(storeDiscounts.id, current.id));
        savedId = current.id;
      } else {
        const inserted = await tx.insert(storeDiscounts).values({ ...values, addTime: now, isDel: 0 }).returning({
          id: storeDiscounts.id,
        });
        if (!inserted[0]) throw new Error("套餐保存失败");
        savedId = inserted[0].id;
      }

      const existingEntries = await tx
        .select()
        .from(storeDiscountsProducts)
        .where(eq(storeDiscountsProducts.discountId, savedId))
        .orderBy(asc(storeDiscountsProducts.id))
        .for("update");
      const existingByProduct = new Map<number, EntryRow>();
      for (const entry of existingEntries) {
        if (existingByProduct.has(entry.productId)) {
          throw new ValidateException(`商品 ${entry.productId} 存在重复套餐关系，请先清理历史数据`);
        }
        existingByProduct.set(entry.productId, entry);
      }
      const existingEntryIds = existingEntries.map((entry) => entry.id);
      const oldPackageSkus = existingEntryIds.length
        ? await tx
            .select()
            .from(storeProductAttrValue)
            .where(and(
              eq(storeProductAttrValue.type, PACKAGE_SKU_TYPE),
              inArray(storeProductAttrValue.productId, existingEntryIds),
            ))
            .orderBy(asc(storeProductAttrValue.id))
            .for("update")
        : [];
      const oldByEntry = groupBy(oldPackageSkus, (sku) => sku.productId);
      const reserved = new Set([...baseSkus, ...oldPackageSkus].map((sku) => sku.unique));
      const retainedEntryIds = new Set<number>();

      for (const requested of normalized.products) {
        const product = productById.get(requested.productId)!;
        let entry = existingByProduct.get(requested.productId);
        const entryValues = {
          discountId: savedId,
          productId: product.id,
          productType: product.productType,
          title: product.storeName,
          image: product.image,
          type: normalized.type === 0 ? 0 : requested.required,
          tempId: product.tempId,
        };
        if (entry) {
          const updated = await tx
            .update(storeDiscountsProducts)
            .set(entryValues)
            .where(eq(storeDiscountsProducts.id, entry.id))
            .returning();
          entry = updated[0];
        } else {
          const inserted = await tx.insert(storeDiscountsProducts).values(entryValues).returning();
          entry = inserted[0];
        }
        if (!entry) throw new Error("套餐商品保存失败");
        retainedEntryIds.add(entry.id);

        const oldBySuk = new Map((oldByEntry.get(entry.id) ?? []).map((sku) => [sku.suk, sku]));
        await Promise.all([
          tx.delete(storeProductAttrValue).where(and(
            eq(storeProductAttrValue.type, PACKAGE_SKU_TYPE),
            eq(storeProductAttrValue.productId, entry.id),
          )),
          tx.delete(storeProductAttr).where(and(
            eq(storeProductAttr.type, PACKAGE_SKU_TYPE),
            eq(storeProductAttr.productId, entry.id),
          )),
          tx.delete(storeProductAttrResult).where(and(
            eq(storeProductAttrResult.type, PACKAGE_SKU_TYPE),
            eq(storeProductAttrResult.productId, entry.id),
          )),
        ]);

        const dimensions = (attrsByProduct.get(product.id) ?? []).map((attr) => ({
          value: attr.attrName,
          detail: attr.attrValues.split(",").filter(Boolean),
        }));
        if (dimensions.length) {
          await tx.insert(storeProductAttr).values(dimensions.map((dimension) => ({
            productId: entry!.id,
            attrName: dimension.value,
            attrValues: dimension.detail.join(","),
            type: PACKAGE_SKU_TYPE,
          })));
        }
        const baseByUnique = new Map((baseByProduct.get(product.id) ?? []).map((sku) => [sku.unique, sku]));
        const skuRows: Array<typeof storeProductAttrValue.$inferInsert> = [];
        const resultValues: UnknownRecord[] = [];
        for (const requestedSku of requested.skus) {
          const base = baseByUnique.get(requestedSku.unique)!;
          const old = oldBySuk.get(base.suk);
          const unique = old?.unique ?? await freshSkuUnique(tx, reserved);
          skuRows.push(clonePackageSku(base, entry.id, unique, requestedSku.price, old));
          const parts = base.suk.split(",");
          resultValues.push({
            unique,
            base_unique: base.unique,
            value: parts.join("，") || "默认",
            detail: Object.fromEntries(dimensions.map((dimension, index) => [dimension.value, parts[index] ?? ""])),
            price: requestedSku.price,
            p_price: base.price,
            stock: base.stock,
            pic: base.image,
          });
        }
        await tx.insert(storeProductAttrValue).values(skuRows);
        await tx.insert(storeProductAttrResult).values({
          productId: entry.id,
          result: JSON.stringify({ attr: dimensions, value: resultValues }),
          changeTime: now,
          type: PACKAGE_SKU_TYPE,
        });
      }

      const removedEntryIds = existingEntries
        .filter((entry) => !retainedEntryIds.has(entry.id))
        .map((entry) => entry.id);
      if (removedEntryIds.length) {
        await tx.delete(storeProductAttrValue).where(and(
          eq(storeProductAttrValue.type, PACKAGE_SKU_TYPE),
          inArray(storeProductAttrValue.productId, removedEntryIds),
        ));
        await tx.delete(storeProductAttr).where(and(
          eq(storeProductAttr.type, PACKAGE_SKU_TYPE),
          inArray(storeProductAttr.productId, removedEntryIds),
        ));
        await tx.delete(storeProductAttrResult).where(and(
          eq(storeProductAttrResult.type, PACKAGE_SKU_TYPE),
          inArray(storeProductAttrResult.productId, removedEntryIds),
        ));
        await tx.delete(storeDiscountsProducts).where(inArray(storeDiscountsProducts.id, removedEntryIds));
      }
      return savedId;
    });
    return this.detail(discountId);
  }

  async setStatus(id: number, status: number) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("套餐 ID 格式错误");
    if (status !== 0 && status !== 1) throw new ValidateException("套餐状态格式错误");
    await withTx(this.container, async (tx) => {
      const discount = (
        await tx
          .select()
          .from(storeDiscounts)
          .where(eq(storeDiscounts.id, id))
          .limit(1)
          .for("update")
      )[0];
      if (!discount || discount.isDel !== 0) throw new NotFoundException("套餐不存在");
      if (status === 1) {
        const now = Math.floor(Date.now() / 1_000);
        if (discount.isTime === 1 && discount.stopTime < now) throw new ValidateException("套餐已结束，不能启用");
        if (discount.isLimit === 1 && discount.limitNum <= 0) throw new ValidateException("套餐库存不足，不能启用");
        const entries = await tx
          .select()
          .from(storeDiscountsProducts)
          .where(eq(storeDiscountsProducts.discountId, id))
          .orderBy(asc(storeDiscountsProducts.id));
        if (entries.length < 2) throw new ValidateException("套餐商品不足，不能启用");
        if (discount.type === 1 && !entries.some((entry) => entry.type === 1)) {
          throw new ValidateException("搭配套餐缺少主商品，不能启用");
        }
        const productIds = entries.map((entry) => entry.productId);
        const entryIds = entries.map((entry) => entry.id);
        const [products, packageSkus, baseSkus] = await Promise.all([
          tx.select().from(storeProduct).where(inArray(storeProduct.id, productIds)),
          tx.select().from(storeProductAttrValue).where(and(
            eq(storeProductAttrValue.type, PACKAGE_SKU_TYPE),
            inArray(storeProductAttrValue.productId, entryIds),
          )),
          tx.select().from(storeProductAttrValue).where(and(
            eq(storeProductAttrValue.type, BASE_SKU_TYPE),
            inArray(storeProductAttrValue.productId, productIds),
          )),
        ]);
        // A scheduled package may be enabled before its start date, matching
        // the PHP contract. Structural validation is evaluated at its start.
        const validationTime = discount.isTime === 1 && now < discount.startTime
          ? discount.startTime
          : now;
        const state = availability(
          { ...discount, status: 1 },
          entries,
          new Map(products.map((product) => [product.id, product])),
          groupBy(packageSkus, (sku) => sku.productId),
          groupBy(baseSkus, (sku) => sku.productId),
          validationTime,
        );
        if (!state.available) throw new ValidateException(`${state.reason}，不能启用`);
      }
      await tx.update(storeDiscounts).set({ status }).where(eq(storeDiscounts.id, id));
    });
    return { id, status };
  }

  async remove(id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("套餐 ID 格式错误");
    const updated = await this.container.db
      .update(storeDiscounts)
      .set({ isDel: 1 })
      .where(and(eq(storeDiscounts.id, id), eq(storeDiscounts.isDel, 0)))
      .returning({ id: storeDiscounts.id });
    if (!updated[0]) throw new NotFoundException("套餐不存在");
    return { id };
  }

  private async loadRelated(discounts: DiscountRow[]) {
    const discountIds = discounts.map((discount) => discount.id);
    const entries = discountIds.length
      ? await this.container.db
          .select()
          .from(storeDiscountsProducts)
          .where(inArray(storeDiscountsProducts.discountId, discountIds))
          .orderBy(asc(storeDiscountsProducts.discountId), asc(storeDiscountsProducts.id))
      : [];
    const entryIds = entries.map((entry) => entry.id);
    const productIds = [...new Set(entries.map((entry) => entry.productId))];
    const [products, packageSkus, baseSkus, attrs] = await Promise.all([
      productIds.length
        ? this.container.db.select().from(storeProduct).where(inArray(storeProduct.id, productIds))
        : Promise.resolve([] as ProductRow[]),
      entryIds.length
        ? this.container.db
            .select()
            .from(storeProductAttrValue)
            .where(and(
              eq(storeProductAttrValue.type, PACKAGE_SKU_TYPE),
              inArray(storeProductAttrValue.productId, entryIds),
            ))
            .orderBy(asc(storeProductAttrValue.productId), asc(storeProductAttrValue.id))
        : Promise.resolve([] as SkuRow[]),
      productIds.length
        ? this.container.db
            .select()
            .from(storeProductAttrValue)
            .where(and(
              eq(storeProductAttrValue.type, BASE_SKU_TYPE),
              inArray(storeProductAttrValue.productId, productIds),
            ))
            .orderBy(asc(storeProductAttrValue.productId), asc(storeProductAttrValue.id))
        : Promise.resolve([] as SkuRow[]),
      productIds.length
        ? this.container.db
            .select()
            .from(storeProductAttr)
            .where(and(eq(storeProductAttr.type, BASE_SKU_TYPE), inArray(storeProductAttr.productId, productIds)))
            .orderBy(asc(storeProductAttr.productId), asc(storeProductAttr.id))
        : Promise.resolve([] as AttrRow[]),
    ]);
    return {
      entriesByDiscount: groupBy(entries, (entry) => entry.discountId),
      productById: new Map(products.map((product) => [product.id, product])),
      packageSkusByEntry: groupBy(packageSkus, (sku) => sku.productId),
      baseSkusByProduct: groupBy(baseSkus, (sku) => sku.productId),
      attrsByProduct: groupBy(attrs, (attr) => attr.productId),
    };
  }
}
