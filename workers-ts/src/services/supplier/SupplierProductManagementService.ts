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
  storeCart,
  storeProduct,
  storeProductAttr,
  storeProductAttrResult,
  storeProductAttrValue,
  storeProductCategory,
  storeProductDescription,
  storeProductRelation,
  storeProductStockRecord,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const SUPPLIER_TYPE = 2;
const PHYSICAL_PRODUCT_TYPE = 0;
const PRODUCT_ATTR_TYPE = 0;
const CATEGORY_RELATION_TYPE = 1;
const PRODUCT_LOCK_NAMESPACE = 731_602;
const MAX_DIMENSIONS = 3;
const MAX_SKUS = 200;

type UnknownRecord = Record<string, unknown>;

export interface SupplierProductDimension {
  value: string;
  detail: string[];
}

export interface SupplierProductSku {
  suk: string;
  detail: Record<string, string>;
  image: string;
  price: string;
  settlePrice: string;
  cost: string;
  otPrice: string;
  vipPrice: string;
  stock: number;
  barCode: string;
  weight: string;
  volume: string;
  brokerage: string;
  brokerageTwo: string;
  code: string;
  unique?: string;
}

export interface SupplierPhysicalProductInput {
  storeName: string;
  storeInfo: string;
  keyword: string;
  unitName: string;
  barCode: string;
  cateIds: number[];
  sliderImages: string[];
  description: string;
  specType: 0 | 1;
  dimensions: SupplierProductDimension[];
  skus: SupplierProductSku[];
  postage: string;
  tempId: number;
  isPostage: number;
  isSupportRefund: number;
  isLimit: number;
  limitType: number;
  limitNum: number;
  sort: number;
  ficti: number;
  videoLink: string;
}

export interface SupplierStockAdjustment {
  unique: string;
  pm: 0 | 1;
  stock: number;
}

export interface PhysicalProductNormalizationOptions {
  requireSettlePrice?: boolean;
}

function asRecord(value: unknown, message = "参数格式错误"): UnknownRecord {
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
  defaultValue = 0,
  max = 2_147_483_647,
): number {
  if (value === undefined || value === null || value === "") return defaultValue;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new ValidateException(`${field}必须是非负整数`);
  }
  return parsed;
}

function flagValue(value: unknown, field: string, defaultValue: number): number {
  const parsed = integerValue(value, field, defaultValue, 1);
  if (parsed !== 0 && parsed !== 1) throw new ValidateException(`${field}格式错误`);
  return parsed;
}

function decimalString(value: unknown, field: string, positive = false): string {
  if (value === undefined || value === null || value === "") value = "0";
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidateException(`${field}格式错误`);
  }
  const raw = String(value).trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(raw)) {
    throw new ValidateException(`${field}必须是最多两位小数的非负金额`);
  }
  const [whole, fraction = ""] = raw.split(".");
  const normalized = `${BigInt(whole).toString()}.${fraction.padEnd(2, "0")}`;
  if (positive && moneyCents(normalized) <= 0n) throw new ValidateException(`${field}必须大于0`);
  return normalized;
}

function moneyCents(value: string): bigint {
  const [whole, fraction = "00"] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

function normalizeStringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  let values: unknown[];
  if (Array.isArray(value)) {
    values = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) values = [];
    else if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        values = Array.isArray(parsed) ? parsed : [];
      } catch {
        throw new ValidateException(`${field}格式错误`);
      }
    } else {
      values = trimmed.split(",");
    }
  } else {
    values = [];
  }
  const result = values.map((item) => requiredString(item, field, maxLength));
  if (result.length > maxItems) throw new ValidateException(`${field}不能超过${maxItems}项`);
  if (new Set(result).size !== result.length) throw new ValidateException(`${field}不能重复`);
  return result;
}

function normalizeCategoryIds(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const ids = raw.map((item) => integerValue(item, "商品分类", 0));
  if (ids.length === 0 || ids.some((id) => id <= 0)) throw new ValidateException("请选择商品分类");
  if (ids.length > 20) throw new ValidateException("商品分类不能超过20项");
  return [...new Set(ids)];
}

export function normalizeSupplierProductDimensions(value: unknown): SupplierProductDimension[] {
  if (!Array.isArray(value)) throw new ValidateException("商品规格格式错误");
  if (value.length === 0 || value.length > MAX_DIMENSIONS) {
    throw new ValidateException(`商品规格维度需为1至${MAX_DIMENSIONS}项`);
  }
  const dimensions = value.map((item) => {
    const row = asRecord(item, "商品规格格式错误");
    const name = requiredString(firstValue(row, "value", "attr_name"), "规格名称", 32);
    const details = normalizeStringArray(firstValue(row, "detail", "attr_values"), "规格值", 50, 64);
    if (details.length === 0) throw new ValidateException(`规格“${name}”至少需要一个规格值`);
    return { value: name, detail: details };
  });
  if (new Set(dimensions.map((item) => item.value)).size !== dimensions.length) {
    throw new ValidateException("规格名称不能重复");
  }
  return dimensions;
}

export function buildSkuCombinations(dimensions: SupplierProductDimension[]): Array<Record<string, string>> {
  let combinations: Array<Record<string, string>> = [{}];
  for (const dimension of dimensions) {
    combinations = combinations.flatMap((combination) =>
      dimension.detail.map((detail) => ({ ...combination, [dimension.value]: detail })),
    );
    if (combinations.length > MAX_SKUS) throw new ValidateException(`SKU组合不能超过${MAX_SKUS}项`);
  }
  return combinations;
}

function canonicalSuk(detail: Record<string, string>, dimensions: SupplierProductDimension[]): string {
  return dimensions.map((dimension) => detail[dimension.value]).join(",");
}

function normalizeSkuDetail(row: UnknownRecord, dimensions: SupplierProductDimension[]): Record<string, string> {
  const detailValue = row.detail;
  if (detailValue && typeof detailValue === "object" && !Array.isArray(detailValue)) {
    const detailRecord = detailValue as UnknownRecord;
    return Object.fromEntries(
      dimensions.map((dimension) => [
        dimension.value,
        requiredString(detailRecord[dimension.value], `规格${dimension.value}`, 64),
      ]),
    );
  }
  const suk = optionalString(row.suk, "SKU规格", 512);
  const parts = suk.split(",").map((item) => item.trim());
  if (parts.length !== dimensions.length) throw new ValidateException("SKU规格维度不完整");
  return Object.fromEntries(dimensions.map((dimension, index) => [dimension.value, parts[index]]));
}

export function normalizeSupplierProductSkus(
  value: unknown,
  dimensions: SupplierProductDimension[],
  specType: 0 | 1,
  options: PhysicalProductNormalizationOptions = {},
): SupplierProductSku[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value as UnknownRecord)
      : [];
  if (rows.length === 0 || rows.length > MAX_SKUS) throw new ValidateException("请填写商品SKU");
  const normalizedDimensions =
    specType === 0 ? [{ value: "规格", detail: ["默认"] }] : dimensions;
  if (specType === 0 && rows.length !== 1) throw new ValidateException("单规格商品只能有一个SKU");

  const skus = rows.map((item) => {
    const row = asRecord(item, "SKU格式错误");
    const detail = specType === 0 ? { 规格: "默认" } : normalizeSkuDetail(row, normalizedDimensions);
    for (const dimension of normalizedDimensions) {
      if (!dimension.detail.includes(detail[dimension.value])) {
        throw new ValidateException(`SKU包含无效的${dimension.value}规格值`);
      }
    }
    const price = decimalString(row.price, "销售价", true);
    const settlePrice = decimalString(
      firstValue(row, "settle_price", "settlePrice"),
      "结算价",
      options.requireSettlePrice !== false,
    );
    const brokerage = decimalString(row.brokerage, "一级佣金");
    const brokerageTwo = decimalString(firstValue(row, "brokerage_two", "brokerageTwo"), "二级佣金");
    if (moneyCents(brokerage) + moneyCents(brokerageTwo) > moneyCents(price)) {
      throw new ValidateException("一级佣金与二级佣金之和不能超过销售价");
    }
    return {
      suk: canonicalSuk(detail, normalizedDimensions),
      detail,
      image: optionalString(row.image, "SKU图片", 128),
      price,
      settlePrice,
      cost: decimalString(row.cost, "成本价"),
      otPrice: decimalString(firstValue(row, "ot_price", "otPrice"), "原价"),
      vipPrice: decimalString(firstValue(row, "vip_price", "vipPrice"), "会员价"),
      stock: integerValue(row.stock, "库存"),
      barCode: optionalString(firstValue(row, "bar_code", "barCode"), "SKU条码", 50),
      weight: decimalString(row.weight, "重量"),
      volume: decimalString(row.volume, "体积"),
      brokerage,
      brokerageTwo,
      code: optionalString(row.code, "SKU编码", 50),
      unique: optionalString(row.unique, "SKU唯一标识", 8) || undefined,
    };
  });

  const actualKeys = skus.map((sku) => sku.suk);
  if (new Set(actualKeys).size !== actualKeys.length) throw new ValidateException("SKU组合不能重复");
  const expectedKeys = buildSkuCombinations(normalizedDimensions).map((detail) =>
    canonicalSuk(detail, normalizedDimensions),
  );
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key) => !actualKeys.includes(key))) {
    throw new ValidateException("SKU组合必须完整覆盖所有规格组合");
  }
  return skus;
}

export function normalizeSupplierPhysicalProductInput(
  input: UnknownRecord,
  options: PhysicalProductNormalizationOptions = {},
): SupplierPhysicalProductInput {
  const productType = integerValue(firstValue(input, "product_type", "productType"), "商品类型", 0, 4);
  if (productType !== PHYSICAL_PRODUCT_TYPE) {
    throw new ValidateException("当前迁移阶段仅支持实物商品，卡密、优惠券、虚拟商品和次卡暂不可创建");
  }
  const specTypeValue = integerValue(firstValue(input, "spec_type", "specType"), "规格类型", 0, 1);
  if (specTypeValue !== 0 && specTypeValue !== 1) throw new ValidateException("规格类型错误");
  const specType = specTypeValue as 0 | 1;
  const dimensions =
    specType === 0
      ? [{ value: "规格", detail: ["默认"] }]
      : normalizeSupplierProductDimensions(input.items);
  const sliderImages = normalizeStringArray(
    firstValue(input, "slider_image", "sliderImages", "slider_images"),
    "轮播图",
    20,
    256,
  );
  if (sliderImages.length === 0) throw new ValidateException("请至少上传一张商品轮播图");
  const isLimit = flagValue(firstValue(input, "is_limit", "isLimit"), "限购状态", 0);
  const limitType = isLimit
    ? integerValue(firstValue(input, "limit_type", "limitType"), "限购类型", 1, 2)
    : 0;
  const limitNum = isLimit
    ? integerValue(firstValue(input, "limit_num", "limitNum"), "限购数量", 1)
    : 0;
  if (isLimit && ![1, 2].includes(limitType)) throw new ValidateException("限购类型错误");
  if (isLimit && limitNum <= 0) throw new ValidateException("限购数量必须大于0");

  return {
    storeName: requiredString(firstValue(input, "store_name", "storeName"), "商品名称", 256),
    storeInfo: optionalString(firstValue(input, "store_info", "storeInfo"), "商品简介", 256),
    keyword: optionalString(input.keyword, "关键词", 256),
    unitName: optionalString(firstValue(input, "unit_name", "unitName"), "单位", 32) || "件",
    barCode: optionalString(firstValue(input, "bar_code", "barCode"), "商品条码", 15),
    cateIds: normalizeCategoryIds(firstValue(input, "cate_id", "cateIds", "cate_ids")),
    sliderImages,
    description: optionalString(input.description, "商品详情", 200_000),
    specType,
    dimensions,
    skus: normalizeSupplierProductSkus(input.attrs, dimensions, specType, options),
    postage: decimalString(input.postage, "运费"),
    tempId: integerValue(firstValue(input, "temp_id", "tempId"), "运费模板"),
    isPostage: flagValue(firstValue(input, "is_postage", "isPostage"), "包邮状态", 0),
    isSupportRefund: flagValue(
      firstValue(input, "is_support_refund", "isSupportRefund"),
      "退款支持状态",
      1,
    ),
    isLimit,
    limitType,
    limitNum,
    sort: integerValue(input.sort, "排序", 0, 1_000_000),
    ficti: integerValue(input.ficti, "虚拟销量", 0),
    videoLink: optionalString(firstValue(input, "video_link", "videoLink"), "视频地址", 500),
  };
}

export function normalizeStockAdjustments(value: unknown): SupplierStockAdjustment[] {
  const body = value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(body?.attrs)
      ? body.attrs
      : Array.isArray(body?.stock)
        ? body.stock
        : [];
  if (rows.length === 0 || rows.length > MAX_SKUS) throw new ValidateException("请填写库存调整项");
  const adjustments = rows.map((item) => {
    const row = asRecord(item, "库存调整格式错误");
    const pmValue = integerValue(row.pm, "库存方向", 1, 1);
    if (pmValue !== 0 && pmValue !== 1) throw new ValidateException("库存方向错误");
    const stock = integerValue(firstValue(row, "stock", "number"), "库存数量", 0);
    if (stock <= 0) throw new ValidateException("库存调整数量必须大于0");
    return {
      unique: requiredString(row.unique, "SKU唯一标识", 32),
      pm: pmValue as 0 | 1,
      stock,
    };
  });
  if (new Set(adjustments.map((item) => item.unique)).size !== adjustments.length) {
    throw new ValidateException("同一个SKU不能重复调整");
  }
  return adjustments;
}

function generateSkuUnique(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function minMoney(values: string[]): string {
  return values.reduce((minimum, value) => (moneyCents(value) < moneyCents(minimum) ? value : minimum));
}

function buildCategoryTree<T extends { id: number; pid: number }>(rows: T[]): Array<T & { children: T[] }> {
  const byParent = new Map<number, T[]>();
  for (const row of rows) byParent.set(row.pid, [...(byParent.get(row.pid) ?? []), row]);
  const walk = (pid: number): Array<T & { children: T[] }> =>
    (byParent.get(pid) ?? []).map((row) => ({ ...row, children: walk(row.id) }));
  return walk(0);
}

export class SupplierProductManagementService {
  constructor(private readonly container: Container) {}

  private tenantProductWhere(supplierId: number, productId: number) {
    return and(
      eq(storeProduct.id, productId),
      eq(storeProduct.type, SUPPLIER_TYPE),
      eq(storeProduct.relationId, supplierId),
      eq(storeProduct.isDel, 0),
    );
  }

  private async lockProduct(tx: DbClient, supplierId: number, productId: number) {
    const key = productId > 0 ? productId : supplierId;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_LOCK_NAMESPACE}, ${key})`);
  }

  async categoryTree(supplierId: number, includeHidden = true) {
    const conditions = [
      eq(storeProductCategory.type, SUPPLIER_TYPE),
      eq(storeProductCategory.relationId, supplierId),
    ];
    if (!includeHidden) conditions.push(eq(storeProductCategory.isShow, 1));
    const rows = await this.container.db
      .select({
        id: storeProductCategory.id,
        pid: storeProductCategory.pid,
        cate_name: storeProductCategory.cateName,
        path: storeProductCategory.path,
        level: storeProductCategory.level,
        pic: storeProductCategory.pic,
        sort: storeProductCategory.sort,
        is_show: storeProductCategory.isShow,
        add_time: storeProductCategory.addTime,
      })
      .from(storeProductCategory)
      .where(and(...conditions))
      .orderBy(asc(storeProductCategory.level), desc(storeProductCategory.sort), asc(storeProductCategory.id));
    return buildCategoryTree(rows);
  }

  async categoryDetail(supplierId: number, categoryId: number) {
    const row = (
      await this.container.db
        .select({
          id: storeProductCategory.id,
          pid: storeProductCategory.pid,
          cate_name: storeProductCategory.cateName,
          path: storeProductCategory.path,
          level: storeProductCategory.level,
          pic: storeProductCategory.pic,
          sort: storeProductCategory.sort,
          is_show: storeProductCategory.isShow,
        })
        .from(storeProductCategory)
        .where(
          and(
            eq(storeProductCategory.id, categoryId),
            eq(storeProductCategory.type, SUPPLIER_TYPE),
            eq(storeProductCategory.relationId, supplierId),
          ),
        )
        .limit(1)
    )[0];
    if (!row) throw new NotFoundException("分类不存在或不属于当前供应商");
    return row;
  }

  async saveCategory(supplierId: number, categoryId: number, input: UnknownRecord) {
    const cateName = requiredString(firstValue(input, "cate_name", "cateName"), "分类名称", 100);
    const pid = integerValue(input.pid, "上级分类", 0);
    const pic = optionalString(input.pic, "分类图片", 512);
    const sort = integerValue(input.sort, "分类排序", 0, 1_000_000);
    const isShow = flagValue(firstValue(input, "is_show", "isShow"), "分类状态", 1);
    return withTx(this.container, async (tx) => {
      await this.lockProduct(tx, supplierId, categoryId);
      const all = await tx
        .select()
        .from(storeProductCategory)
        .where(
          and(
            eq(storeProductCategory.type, SUPPLIER_TYPE),
            eq(storeProductCategory.relationId, supplierId),
          ),
        );
      const existing = categoryId > 0 ? all.find((row) => row.id === categoryId) : undefined;
      if (categoryId > 0 && !existing) throw new NotFoundException("分类不存在或不属于当前供应商");
      const parent = pid > 0 ? all.find((row) => row.id === pid) : undefined;
      if (pid > 0 && !parent) throw new ValidateException("上级分类不存在或不属于当前供应商");
      if (categoryId > 0 && (pid === categoryId || parent?.path.split(",").includes(String(categoryId)))) {
        throw new ValidateException("不能将分类移动到自身或其子分类下");
      }
      const level = parent ? parent.level + 1 : 0;
      if (level > 2) throw new ValidateException("商品分类最多三级");
      const path = parent ? [parent.path, String(parent.id)].filter(Boolean).join(",") : "";
      const now = Math.floor(Date.now() / 1000);
      let savedId = categoryId;
      if (existing) {
        await tx
          .update(storeProductCategory)
          .set({ pid, cateName, pic, sort, isShow, path, level })
          .where(eq(storeProductCategory.id, categoryId));
      } else {
        const inserted = await tx
          .insert(storeProductCategory)
          .values({
            pid,
            type: SUPPLIER_TYPE,
            relationId: supplierId,
            cateName,
            pic,
            sort,
            isShow,
            path,
            level,
            addTime: now,
          })
          .returning({ id: storeProductCategory.id });
        savedId = inserted[0].id;
      }

      if (existing && (existing.path !== path || existing.level !== level)) {
        const children = new Map<number, typeof all>();
        for (const row of all) children.set(row.pid, [...(children.get(row.pid) ?? []), row]);
        const affectedCategoryIds = [categoryId];
        const updateChildren = async (parentId: number, parentPath: string, parentLevel: number): Promise<void> => {
          for (const child of children.get(parentId) ?? []) {
            const childLevel = parentLevel + 1;
            if (childLevel > 2) throw new ValidateException("移动后分类层级将超过三级");
            const childPath = [parentPath, String(parentId)].filter(Boolean).join(",");
            await tx
              .update(storeProductCategory)
              .set({ path: childPath, level: childLevel })
              .where(eq(storeProductCategory.id, child.id));
            affectedCategoryIds.push(child.id);
            await updateChildren(child.id, childPath, childLevel);
          }
        };
        await updateChildren(categoryId, path, level);
        await tx
          .update(storeProductRelation)
          .set({ relationPid: storeProductCategory.pid })
          .from(storeProductCategory)
          .where(
            and(
              eq(storeProductRelation.type, CATEGORY_RELATION_TYPE),
              eq(storeProductRelation.relationId, storeProductCategory.id),
              inArray(storeProductCategory.id, affectedCategoryIds),
            ),
          );
      }
      return { id: savedId };
    });
  }

  async deleteCategory(supplierId: number, categoryId: number) {
    await withTx(this.container, async (tx) => {
      await this.lockProduct(tx, supplierId, categoryId);
      const rows = await tx
        .select({ id: storeProductCategory.id })
        .from(storeProductCategory)
        .where(
          and(
            eq(storeProductCategory.id, categoryId),
            eq(storeProductCategory.type, SUPPLIER_TYPE),
            eq(storeProductCategory.relationId, supplierId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw new NotFoundException("分类不存在或不属于当前供应商");
      const children = await tx
        .select({ id: storeProductCategory.id })
        .from(storeProductCategory)
        .where(
          and(
            eq(storeProductCategory.pid, categoryId),
            eq(storeProductCategory.type, SUPPLIER_TYPE),
            eq(storeProductCategory.relationId, supplierId),
          ),
        )
        .limit(1);
      if (children[0]) throw new ValidateException("请先删除下级分类");
      const relation = await tx
        .select({ id: storeProductRelation.id })
        .from(storeProductRelation)
        .innerJoin(storeProduct, eq(storeProduct.id, storeProductRelation.productId))
        .where(
          and(
            eq(storeProductRelation.type, CATEGORY_RELATION_TYPE),
            eq(storeProductRelation.relationId, categoryId),
            eq(storeProduct.type, SUPPLIER_TYPE),
            eq(storeProduct.relationId, supplierId),
            eq(storeProduct.isDel, 0),
          ),
        )
        .limit(1);
      if (relation[0]) throw new ValidateException("分类下仍有商品，不能删除");
      await tx.delete(storeProductCategory).where(eq(storeProductCategory.id, categoryId));
    });
  }

  async setCategoryShow(supplierId: number, categoryId: number, isShow: number) {
    if (isShow !== 0 && isShow !== 1) throw new ValidateException("分类状态错误");
    const rows = await this.container.db
      .update(storeProductCategory)
      .set({ isShow })
      .where(
        and(
          eq(storeProductCategory.id, categoryId),
          eq(storeProductCategory.type, SUPPLIER_TYPE),
          eq(storeProductCategory.relationId, supplierId),
        ),
      )
      .returning({ id: storeProductCategory.id });
    if (!rows[0]) throw new NotFoundException("分类不存在或不属于当前供应商");
  }

  private async assertCategories(tx: DbClient, supplierId: number, cateIds: number[]) {
    const rows = await tx
      .select()
      .from(storeProductCategory)
      .where(
        and(
          inArray(storeProductCategory.id, cateIds),
          eq(storeProductCategory.type, SUPPLIER_TYPE),
          eq(storeProductCategory.relationId, supplierId),
        ),
      );
    if (rows.length !== cateIds.length) throw new ValidateException("商品分类不存在或不属于当前供应商");
    return rows;
  }

  async saveProduct(supplierId: number, productId: number, rawInput: UnknownRecord) {
    const input = normalizeSupplierPhysicalProductInput(rawInput);
    return withTx(this.container, async (tx) => {
      await this.lockProduct(tx, supplierId, productId);
      // Legacy schema only indexed SKU unique; serialize saves so new rows can be checked globally
      // without racing another supplier product save. Historical duplicates remain a migration audit item.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_LOCK_NAMESPACE}, 0)`);
      const existing = productId > 0
        ? (
            await tx
              .select()
              .from(storeProduct)
              .where(this.tenantProductWhere(supplierId, productId))
              .limit(1)
          )[0]
        : undefined;
      if (productId > 0 && !existing) throw new NotFoundException("商品不存在或不属于当前供应商");
      if (existing && existing.productType !== PHYSICAL_PRODUCT_TYPE) {
        throw new ValidateException("当前迁移阶段不能编辑非实物商品");
      }
      const categories = await this.assertCategories(tx, supplierId, input.cateIds);
      const stock = input.skus.reduce((sum, sku) => sum + sku.stock, 0);
      if (!Number.isSafeInteger(stock)) throw new ValidateException("商品总库存超出安全范围");
      const price = minMoney(input.skus.map((sku) => sku.price));
      const settlePrice = minMoney(input.skus.map((sku) => sku.settlePrice));
      const cost = minMoney(input.skus.map((sku) => sku.cost));
      const otPrice = minMoney(input.skus.map((sku) => sku.otPrice));
      const vipPrice = minMoney(input.skus.map((sku) => sku.vipPrice));
      const now = Math.floor(Date.now() / 1000);
      const productValues = {
        productType: PHYSICAL_PRODUCT_TYPE,
        type: SUPPLIER_TYPE,
        relationId: supplierId,
        image: input.sliderImages[0],
        sliderImage: JSON.stringify(input.sliderImages),
        storeName: input.storeName,
        storeInfo: input.storeInfo,
        keyword: input.keyword,
        barCode: input.barCode,
        cateId: input.cateIds.join(","),
        price,
        settlePrice,
        vipPrice,
        otPrice,
        deliveryType: "1",
        freight: input.tempId > 0 ? 1 : 2,
        postage: input.postage,
        tempId: input.tempId,
        unitName: input.unitName,
        sort: input.sort,
        ficti: input.ficti,
        stock,
        isShow: 0,
        isVerify: 0,
        isPostage: input.isPostage,
        cost,
        videoOpen: input.videoLink ? 1 : 0,
        videoLink: input.videoLink,
        specType: input.specType,
        isSupportRefund: input.isSupportRefund,
        isLimit: input.isLimit,
        limitType: input.limitType,
        limitNum: input.limitNum,
        isSold: stock > 0 ? 0 : 1,
      } as const;
      let savedProductId = productId;
      if (existing) {
        await tx.update(storeProduct).set(productValues).where(eq(storeProduct.id, productId));
      } else {
        const rows = await tx
          .insert(storeProduct)
          .values({ ...productValues, addTime: now, isDel: 0 })
          .returning({ id: storeProduct.id });
        savedProductId = rows[0].id;
      }

      const currentSkus = existing
        ? await tx
            .select()
            .from(storeProductAttrValue)
            .where(
              and(
                eq(storeProductAttrValue.productId, savedProductId),
                eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
              ),
            )
        : [];
      const existingBySuk = new Map(currentSkus.map((sku) => [sku.suk, sku]));
      const usedUniques = new Set(currentSkus.map((sku) => sku.unique));
      const skuRows: Array<typeof storeProductAttrValue.$inferInsert> = [];
      for (const sku of input.skus) {
        const current = existingBySuk.get(sku.suk);
        let unique = current?.unique;
        while (!unique) {
          const candidate = generateSkuUnique();
          if (usedUniques.has(candidate)) continue;
          const collision = await tx
            .select({ id: storeProductAttrValue.id })
            .from(storeProductAttrValue)
            .where(eq(storeProductAttrValue.unique, candidate))
            .limit(1);
          if (!collision[0]) unique = candidate;
        }
        usedUniques.add(unique);
        skuRows.push({
          productId: savedProductId,
          productType: PHYSICAL_PRODUCT_TYPE,
          suk: sku.suk,
          stock: sku.stock,
          sumStock: current ? Math.max(current.sumStock, sku.stock) : sku.stock,
          sales: current?.sales ?? 0,
          price: sku.price,
          settlePrice: sku.settlePrice,
          image: sku.image || input.sliderImages[0].slice(0, 128),
          unique,
          cost: sku.cost,
          barCode: sku.barCode,
          otPrice: sku.otPrice,
          vipPrice: sku.vipPrice,
          weight: sku.weight,
          volume: sku.volume,
          brokerage: sku.brokerage,
          brokerageTwo: sku.brokerageTwo,
          type: PRODUCT_ATTR_TYPE,
          code: sku.code,
        });
      }

      await tx.delete(storeProductRelation).where(
        and(
          eq(storeProductRelation.productId, savedProductId),
          eq(storeProductRelation.type, CATEGORY_RELATION_TYPE),
        ),
      );
      await tx.insert(storeProductRelation).values(
        categories.map((category) => ({
          type: CATEGORY_RELATION_TYPE,
          productId: savedProductId,
          relationId: category.id,
          relationPid: category.pid,
          status: 0,
          addTime: now,
        })),
      );
      await tx
        .insert(storeProductDescription)
        .values({ productId: savedProductId, description: input.description, type: PHYSICAL_PRODUCT_TYPE })
        .onConflictDoUpdate({
          target: [storeProductDescription.productId, storeProductDescription.type],
          set: { description: input.description },
        });
      await tx.delete(storeProductAttr).where(
        and(eq(storeProductAttr.productId, savedProductId), eq(storeProductAttr.type, PRODUCT_ATTR_TYPE)),
      );
      await tx.insert(storeProductAttr).values(
        input.dimensions.map((dimension) => ({
          productId: savedProductId,
          attrName: dimension.value,
          attrValues: dimension.detail.join(","),
          type: PRODUCT_ATTR_TYPE,
        })),
      );
      await tx.delete(storeProductAttrResult).where(
        and(
          eq(storeProductAttrResult.productId, savedProductId),
          eq(storeProductAttrResult.type, PRODUCT_ATTR_TYPE),
        ),
      );
      await tx.insert(storeProductAttrResult).values({
        productId: savedProductId,
        result: JSON.stringify({ attr: input.dimensions, value: input.skus }),
        changeTime: now,
        type: PRODUCT_ATTR_TYPE,
      });
      await tx.delete(storeProductAttrValue).where(
        and(
          eq(storeProductAttrValue.productId, savedProductId),
          eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
        ),
      );
      await tx.insert(storeProductAttrValue).values(skuRows);
      await tx.update(storeCart).set({ status: 0 }).where(eq(storeCart.productId, savedProductId));
      return { id: savedProductId, is_verify: 0, is_show: 0 };
    });
  }

  async productDetail(supplierId: number, productId: number) {
    const product = (
      await this.container.db
        .select()
        .from(storeProduct)
        .where(this.tenantProductWhere(supplierId, productId))
        .limit(1)
    )[0];
    if (!product) throw new NotFoundException("商品不存在或不属于当前供应商");
    const [relations, descriptions, dimensions, skus] = await Promise.all([
      this.container.db
        .select({ relation_id: storeProductRelation.relationId })
        .from(storeProductRelation)
        .where(
          and(
            eq(storeProductRelation.productId, productId),
            eq(storeProductRelation.type, CATEGORY_RELATION_TYPE),
          ),
        ),
      this.container.db
        .select({ description: storeProductDescription.description })
        .from(storeProductDescription)
        .where(
          and(
            eq(storeProductDescription.productId, productId),
            eq(storeProductDescription.type, PHYSICAL_PRODUCT_TYPE),
          ),
        )
        .limit(1),
      this.container.db
        .select()
        .from(storeProductAttr)
        .where(
          and(eq(storeProductAttr.productId, productId), eq(storeProductAttr.type, PRODUCT_ATTR_TYPE)),
        )
        .orderBy(asc(storeProductAttr.id)),
      this.container.db
        .select()
        .from(storeProductAttrValue)
        .where(
          and(
            eq(storeProductAttrValue.productId, productId),
            eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
          ),
        )
        .orderBy(asc(storeProductAttrValue.id)),
    ]);
    const items = dimensions.map((dimension) => ({
      value: dimension.attrName,
      detail: dimension.attrValues.split(",").filter(Boolean),
    }));
    return {
      id: product.id,
      product_type: product.productType,
      store_name: product.storeName,
      store_info: product.storeInfo,
      keyword: product.keyword,
      unit_name: product.unitName,
      bar_code: product.barCode,
      cate_id: relations.map((relation) => relation.relation_id),
      slider_image: (() => {
        try {
          const parsed: unknown = JSON.parse(product.sliderImage);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
      description: descriptions[0]?.description ?? "",
      spec_type: product.specType,
      items,
      attrs: skus.map((sku) => ({
        unique: sku.unique,
        suk: sku.suk,
        detail: Object.fromEntries(items.map((item, index) => [item.value, sku.suk.split(",")[index] ?? ""])),
        image: sku.image,
        price: sku.price,
        settle_price: sku.settlePrice,
        cost: sku.cost,
        ot_price: sku.otPrice,
        vip_price: sku.vipPrice,
        stock: sku.stock,
        sales: sku.sales,
        bar_code: sku.barCode,
        weight: sku.weight,
        volume: sku.volume,
        brokerage: sku.brokerage,
        brokerage_two: sku.brokerageTwo,
        code: sku.code,
      })),
      postage: product.postage,
      temp_id: product.tempId,
      is_postage: product.isPostage,
      is_support_refund: product.isSupportRefund,
      is_limit: product.isLimit,
      limit_type: product.limitType,
      limit_num: product.limitNum,
      sort: product.sort,
      ficti: product.ficti,
      video_link: product.videoLink,
      is_show: product.isShow,
      is_verify: product.isVerify,
      refusal: product.refusal,
    };
  }

  async recycleProduct(supplierId: number, productId: number) {
    await withTx(this.container, async (tx) => {
      await this.lockProduct(tx, supplierId, productId);
      const rows = await tx
        .update(storeProduct)
        .set({ isDel: 1, isShow: 0 })
        .where(this.tenantProductWhere(supplierId, productId))
        .returning({ id: storeProduct.id });
      if (!rows[0]) throw new NotFoundException("商品不存在或不属于当前供应商");
      await tx.update(storeCart).set({ status: 0 }).where(eq(storeCart.productId, productId));
      await tx
        .update(storeProductRelation)
        .set({ status: 0 })
        .where(eq(storeProductRelation.productId, productId));
    });
  }

  async setProductShow(supplierId: number, productId: number, isShow: number) {
    if (isShow !== 0 && isShow !== 1) throw new ValidateException("商品状态错误");
    await withTx(this.container, async (tx) => {
      await this.lockProduct(tx, supplierId, productId);
      const product = (
        await tx
          .select({ id: storeProduct.id, isVerify: storeProduct.isVerify, price: storeProduct.price })
          .from(storeProduct)
          .where(this.tenantProductWhere(supplierId, productId))
          .limit(1)
      )[0];
      if (!product) throw new NotFoundException("商品不存在或不属于当前供应商");
      if (isShow === 1 && product.isVerify !== 1) throw new ValidateException("商品尚未审核通过，不能上架");
      if (isShow === 1 && moneyCents(product.price) <= 0n) throw new ValidateException("商品价格必须大于0才能上架");
      await tx.update(storeProduct).set({ isShow }).where(eq(storeProduct.id, productId));
      await tx.update(storeCart).set({ status: isShow }).where(eq(storeCart.productId, productId));
      await tx
        .update(storeProductRelation)
        .set({ status: isShow })
        .where(eq(storeProductRelation.productId, productId));
    });
  }

  async batchSetProductShow(supplierId: number, productIds: number[], isShow: number) {
    const ids = [...new Set(productIds)];
    if (ids.length === 0 || ids.length > 200) throw new ValidateException("请选择1至200个商品");
    if (isShow !== 0 && isShow !== 1) throw new ValidateException("商品状态错误");
    let updated = 0;
    const skipped: number[] = [];
    for (const productId of ids) {
      try {
        await this.setProductShow(supplierId, productId, isShow);
        updated += 1;
      } catch (error) {
        if (error instanceof ValidateException || error instanceof NotFoundException) skipped.push(productId);
        else throw error;
      }
    }
    return { updated, skipped, skipped_count: skipped.length };
  }

  async adjustStock(supplierId: number, productId: number, raw: unknown) {
    const adjustments = normalizeStockAdjustments(raw);
    return withTx(this.container, async (tx) => {
      await this.lockProduct(tx, supplierId, productId);
      const product = (
        await tx
          .select({ id: storeProduct.id })
          .from(storeProduct)
          .where(this.tenantProductWhere(supplierId, productId))
          .limit(1)
      )[0];
      if (!product) throw new NotFoundException("商品不存在或不属于当前供应商");
      const uniques = adjustments.map((item) => item.unique);
      const skus = await tx
        .select()
        .from(storeProductAttrValue)
        .where(
          and(
            eq(storeProductAttrValue.productId, productId),
            eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
            inArray(storeProductAttrValue.unique, uniques),
          ),
        );
      if (skus.length !== uniques.length) throw new ValidateException("部分SKU不存在或不属于当前商品");
      const byUnique = new Map(skus.map((sku) => [sku.unique, sku]));
      const now = Math.floor(Date.now() / 1000);
      for (const adjustment of adjustments) {
        const sku = byUnique.get(adjustment.unique);
        if (!sku) throw new ValidateException("SKU不存在");
        if (adjustment.pm === 0 && sku.stock < adjustment.stock) {
          throw new ValidateException(`SKU ${sku.suk} 库存不足，不能扣减`);
        }
        const nextStock = adjustment.pm === 1 ? sku.stock + adjustment.stock : sku.stock - adjustment.stock;
        if (!Number.isSafeInteger(nextStock)) throw new ValidateException("库存超出安全范围");
        await tx
          .update(storeProductAttrValue)
          .set({
            stock: nextStock,
            sumStock: adjustment.pm === 1 ? sku.sumStock + adjustment.stock : sku.sumStock,
          })
          .where(eq(storeProductAttrValue.id, sku.id));
        await tx.insert(storeProductStockRecord).values({
          storeId: supplierId,
          productId,
          unique: sku.unique,
          costPrice: sku.cost,
          number: adjustment.stock,
          pm: adjustment.pm,
          addTime: now,
        });
      }
      const totals = await tx
        .select({ stock: sql<number>`COALESCE(SUM(${storeProductAttrValue.stock}), 0)::int` })
        .from(storeProductAttrValue)
        .where(
          and(
            eq(storeProductAttrValue.productId, productId),
            eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
          ),
        );
      const stock = totals[0]?.stock ?? 0;
      await tx.update(storeProduct).set({ stock, isSold: stock > 0 ? 0 : 1 }).where(eq(storeProduct.id, productId));
      return { stock };
    });
  }
}
