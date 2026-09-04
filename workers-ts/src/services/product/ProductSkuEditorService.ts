import { and, asc, eq, sql } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import {
  storeProduct,
  storeProductAttr,
  storeProductAttrResult,
  storeProductAttrValue,
  storeProductStockRecord,
  storeProductVirtual,
} from "@/models/schema";
import {
  normalizeSupplierProductDimensions,
  normalizeSupplierProductSkus,
  type SupplierProductDimension,
  type SupplierProductSku,
} from "@/services/product/ProductSkuInput";
import {
  PRODUCT_SKU_IDENTITY_LOCK_KEY,
  PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE,
} from "@/services/product/ProductSkuIdentity";
import { ValidateException } from "@/utils/errors";

const PRODUCT_ATTR_TYPE = 0;
const PHYSICAL_PRODUCT_TYPE = 0;
const CARD_PRODUCT_TYPE = 1;
const MANUAL_VIRTUAL_PRODUCT_TYPE = 3;
const SECOND_CARD_PRODUCT_TYPE = 4;
const MAX_SECOND_CARD_WRITE_TIMES = 99_999_999;
const MAX_SECOND_CARD_WRITE_DAYS = 3_650;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

export interface SecondCardSkuConfiguration {
  writeTimes: number;
  writeValid: 1 | 2 | 3;
  writeDays: number;
  writeStart: number;
  writeEnd: number;
}

export type ProductSkuEditorSku = SupplierProductSku & SecondCardSkuConfiguration;

export interface ProductSkuEditorPayload {
  specType: 0 | 1;
  dimensions: SupplierProductDimension[];
  skus: ProductSkuEditorSku[];
}

export interface ProductSkuEditorRow extends ProductSkuEditorSku {
  id?: number;
  unique: string;
  sales: number;
  sumStock: number;
  is_retired?: 0 | 1;
}

export interface ProductSkuSummary {
  stock: number;
  price: string;
  settlePrice: string;
  cost: string;
  otPrice: string;
  vipPrice: string;
  isSold: number;
}

function owns(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function normalizedMoneyCents(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

function minimum(values: string[]): string {
  return values.reduce((left, right) =>
    normalizedMoneyCents(right) < normalizedMoneyCents(left) ? right : left
  );
}

function safeDimensionText(value: string, field: string): string {
  if (value.includes(",")) throw new ValidateException(`${field}不能包含英文逗号`);
  if (/\p{Cc}/u.test(value)) throw new ValidateException(`${field}不能包含控制字符`);
  return value;
}

function skuInputRows(value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value as Record<string, unknown>)
      : [];
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new ValidateException("SKU格式错误");
    }
    return row as Record<string, unknown>;
  });
}

function integerAlias(row: Record<string, unknown>, snake: string, camel: string): number | null {
  const raw = Object.prototype.hasOwnProperty.call(row, snake) ? row[snake] : row[camel];
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeSecondCardSkuConfiguration(
  row: Record<string, unknown>,
): SecondCardSkuConfiguration {
  const writeTimes = integerAlias(row, "write_times", "writeTimes");
  if (writeTimes === null || writeTimes < 1 || writeTimes > MAX_SECOND_CARD_WRITE_TIMES) {
    throw new ValidateException(`次卡核销次数必须为1至${MAX_SECOND_CARD_WRITE_TIMES}`);
  }
  const writeValid = integerAlias(row, "write_valid", "writeValid");
  if (writeValid !== 1 && writeValid !== 2 && writeValid !== 3) {
    throw new ValidateException("请选择次卡有效期类型");
  }
  if (writeValid === 1) {
    return { writeTimes, writeValid, writeDays: 0, writeStart: 0, writeEnd: 0 };
  }
  if (writeValid === 2) {
    const writeDays = integerAlias(row, "write_days", "writeDays");
    if (writeDays === null || writeDays < 1 || writeDays > MAX_SECOND_CARD_WRITE_DAYS) {
      throw new ValidateException(`次卡购买后有效天数必须为1至${MAX_SECOND_CARD_WRITE_DAYS}`);
    }
    return { writeTimes, writeValid, writeDays, writeStart: 0, writeEnd: 0 };
  }
  const writeStart = integerAlias(row, "write_start", "writeStart");
  const writeEnd = integerAlias(row, "write_end", "writeEnd");
  if (
    writeStart === null
    || writeEnd === null
    || writeStart <= 0
    || writeEnd <= writeStart
    || writeEnd > MAX_POSTGRES_INTEGER
  ) {
    throw new ValidateException("次卡固定有效期必须是合法且结束晚于开始的时间区间");
  }
  return { writeTimes, writeValid, writeDays: 0, writeStart, writeEnd };
}

export const DEFAULT_SECOND_CARD_CONFIGURATION: SecondCardSkuConfiguration = {
  writeTimes: 1,
  writeValid: 1,
  writeDays: 0,
  writeStart: 0,
  writeEnd: 0,
};

export function hasProductSkuEditorPayload(body: Record<string, unknown>): boolean {
  const hasItems = owns(body, "items");
  const hasAttrs = owns(body, "attrs");
  if (hasItems !== hasAttrs) throw new ValidateException("商品规格维度与SKU必须同时提交");
  return hasItems && hasAttrs;
}

export function normalizeProductSkuEditorPayload(
  body: Record<string, unknown>,
  productType = PHYSICAL_PRODUCT_TYPE,
): ProductSkuEditorPayload {
  const specTypeValue = Number(body.spec_type ?? 0);
  if (specTypeValue !== 0 && specTypeValue !== 1) throw new ValidateException("规格类型错误");
  const specType = specTypeValue as 0 | 1;
  if (productType === SECOND_CARD_PRODUCT_TYPE && specType !== 0) {
    throw new ValidateException("次卡商品只支持单规格单SKU");
  }
  const dimensions = specType === 0
    ? [{ value: "规格", detail: ["默认"] }]
    : normalizeSupplierProductDimensions(body.items);
  for (const dimension of dimensions) {
    safeDimensionText(dimension.value, "规格名称");
    for (const value of dimension.detail) safeDimensionText(value, "规格值");
  }
  const commonSkus = normalizeSupplierProductSkus(
    body.attrs,
    dimensions,
    specType,
    { requireSettlePrice: false },
  );
  if (productType !== CARD_PRODUCT_TYPE && commonSkus.some((sku) => sku.diskInfo)) {
    throw new ValidateException("只有卡密商品可以配置固定虚拟内容");
  }
  if (![PHYSICAL_PRODUCT_TYPE, CARD_PRODUCT_TYPE, MANUAL_VIRTUAL_PRODUCT_TYPE, SECOND_CARD_PRODUCT_TYPE].includes(productType)) {
    throw new ValidateException("当前阶段只支持编辑实物、卡密、手工虚拟或次卡商品SKU");
  }
  const inputs = skuInputRows(body.attrs);
  const skus = commonSkus.map((sku, index): ProductSkuEditorSku => ({
    ...sku,
    ...(productType === SECOND_CARD_PRODUCT_TYPE
      ? normalizeSecondCardSkuConfiguration(inputs[index])
      : DEFAULT_SECOND_CARD_CONFIGURATION),
  }));
  return { specType, dimensions, skus };
}

export function parseProductSkuRuleValue(value: unknown): SupplierProductDimension[] | null {
  try {
    const source = typeof value === "string" ? JSON.parse(value) as unknown : value;
    const dimensions = normalizeSupplierProductDimensions(source);
    for (const dimension of dimensions) {
      safeDimensionText(dimension.value, "规格名称");
      for (const item of dimension.detail) safeDimensionText(item, "规格值");
    }
    return dimensions;
  } catch {
    return null;
  }
}

export function productSkuSummary(payload: ProductSkuEditorPayload): ProductSkuSummary {
  const stock = payload.skus.reduce((sum, sku) => sum + sku.stock, 0);
  if (!Number.isSafeInteger(stock)) throw new ValidateException("商品总库存超出安全范围");
  return {
    stock,
    price: minimum(payload.skus.map((sku) => sku.price)),
    settlePrice: minimum(payload.skus.map((sku) => sku.settlePrice)),
    cost: minimum(payload.skus.map((sku) => sku.cost)),
    otPrice: minimum(payload.skus.map((sku) => sku.otPrice)),
    vipPrice: minimum(payload.skus.map((sku) => sku.vipPrice)),
    isSold: stock > 0 ? 0 : 1,
  };
}

function opaqueSkuUnique(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 8);
}

function dimensionsFromRows(
  rows: Array<{ attrName: string; attrValues: string }>,
  specType: number,
): SupplierProductDimension[] {
  if (!rows.length && specType === 0) return [{ value: "规格", detail: ["默认"] }];
  return rows.map((row) => ({
    value: row.attrName,
    detail: row.attrValues.split(",").map((item) => item.trim()).filter(Boolean),
  }));
}

function skuProjection(
  row: typeof storeProductAttrValue.$inferSelect,
  dimensions: SupplierProductDimension[],
): ProductSkuEditorRow {
  const parts = row.suk.split(",");
  return {
    id: row.id,
    unique: row.unique,
    suk: row.suk,
    detail: Object.fromEntries(dimensions.map((dimension, index) => [
      dimension.value,
      parts[index] ?? "",
    ])),
    image: row.image,
    price: row.price,
    settlePrice: row.settlePrice,
    cost: row.cost,
    otPrice: row.otPrice,
    vipPrice: row.vipPrice,
    stock: row.stock,
    barCode: row.barCode,
    weight: row.weight,
    volume: row.volume,
    brokerage: row.brokerage,
    brokerageTwo: row.brokerageTwo,
    code: row.code,
    diskInfo: row.diskInfo ?? "",
    writeTimes: row.writeTimes,
    writeValid: row.writeValid === 2 ? 2 : row.writeValid === 3 ? 3 : 1,
    writeDays: row.writeDays,
    writeStart: row.writeStart,
    writeEnd: row.writeEnd,
    sales: row.sales,
    sumStock: row.sumStock,
    is_retired: row.isRetired === 1 ? 1 : 0,
  };
}

export async function loadProductSkuEditor(
  db: DbClient,
  productId: number,
  specType: number,
) {
  const [dimensionRows, skuRows] = await Promise.all([
    db.select({
      attrName: storeProductAttr.attrName,
      attrValues: storeProductAttr.attrValues,
    }).from(storeProductAttr).where(and(
      eq(storeProductAttr.productId, productId),
      eq(storeProductAttr.type, PRODUCT_ATTR_TYPE),
    )).orderBy(asc(storeProductAttr.id)),
    db.select().from(storeProductAttrValue).where(and(
      eq(storeProductAttrValue.productId, productId),
      eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
    )).orderBy(asc(storeProductAttrValue.id)),
  ]);
  const dimensions = dimensionsFromRows(dimensionRows, specType);
  const activeRows = skuRows.filter((row) => row.isRetired === 0);
  const retiredRows = skuRows.filter((row) => row.isRetired === 1);
  const serialize = (row: typeof storeProductAttrValue.$inferSelect) => ({
    ...skuProjection(row, dimensions),
    settle_price: row.settlePrice,
    ot_price: row.otPrice,
    vip_price: row.vipPrice,
    bar_code: row.barCode,
    brokerage_two: row.brokerageTwo,
    disk_info: row.diskInfo ?? "",
    write_times: row.writeTimes,
    write_valid: row.writeValid,
    write_days: row.writeDays,
    write_start: row.writeStart,
    write_end: row.writeEnd,
    settlePrice: undefined,
    otPrice: undefined,
    vipPrice: undefined,
    barCode: undefined,
    brokerageTwo: undefined,
    diskInfo: undefined,
    writeTimes: undefined,
    writeValid: undefined,
    writeDays: undefined,
    writeStart: undefined,
    writeEnd: undefined,
  });
  return {
    spec_type: specType === 1 ? 1 : 0,
    items: dimensions,
    attrs: activeRows.map(serialize),
    retired_attrs: retiredRows.map(serialize),
  };
}

export function completeCartesianDimensions(
  rows: Array<{ suk: string }>,
  dimensionRows: Array<{ attrName: string; attrValues: string }>,
  specType: number,
): SupplierProductDimension[] {
  if (!rows.length) throw new ValidateException("商品必须保留至少一个可售SKU");
  const names = specType === 0
    ? ["规格"]
    : dimensionRows.map((row) => row.attrName);
  if (!names.length || names.length > 3) throw new ValidateException("历史商品规格维度无法安全重建");
  const parts = rows.map((row) => row.suk.split(","));
  if (parts.some((item) => item.length !== names.length || item.some((value) => !value.trim()))) {
    throw new ValidateException("历史商品SKU组合与规格维度不一致");
  }
  const dimensions = names.map((name, index) => {
    const used = new Set(parts.map((item) => item[index]));
    const previous = (dimensionRows[index]?.attrValues ?? "").split(",").filter((value) => used.has(value));
    const values = [...previous, ...[...used].filter((value) => !previous.includes(value))];
    return { value: name, detail: values };
  });
  const expected = dimensions.reduce((total, dimension) => total * dimension.detail.length, 1);
  if (expected !== rows.length || new Set(rows.map((row) => row.suk)).size !== rows.length) {
    throw new ValidateException("退役或恢复后的SKU必须保持完整笛卡尔组合，请成组选择规格");
  }
  let combinations = [""];
  for (const dimension of dimensions) {
    combinations = combinations.flatMap((prefix) => dimension.detail.map((value) => (
      prefix ? `${prefix},${value}` : value
    )));
  }
  const actual = new Set(rows.map((row) => row.suk));
  if (combinations.some((combination) => !actual.has(combination))) {
    throw new ValidateException("退役或恢复后的SKU组合存在缺口，请成组选择规格");
  }
  return dimensions;
}

/** 退役/恢复后重建仅包含活跃SKU的规格投影、快照和商品汇总，并强制数据库回读。 */
export async function rebuildActiveProductSkuState(
  tx: DbClient,
  product: {
    id: number;
    specType: number;
  },
  now: number,
): Promise<ProductSkuEditorRow[]> {
  const [dimensionRows, activeRows] = await Promise.all([
    tx.select({
      attrName: storeProductAttr.attrName,
      attrValues: storeProductAttr.attrValues,
    }).from(storeProductAttr).where(and(
      eq(storeProductAttr.productId, product.id),
      eq(storeProductAttr.type, PRODUCT_ATTR_TYPE),
    )).orderBy(asc(storeProductAttr.id)),
    tx.select().from(storeProductAttrValue).where(and(
      eq(storeProductAttrValue.productId, product.id),
      eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
      eq(storeProductAttrValue.isRetired, 0),
    )).orderBy(asc(storeProductAttrValue.id)),
  ]);
  const dimensions = completeCartesianDimensions(activeRows, dimensionRows, product.specType);
  const assigned = activeRows.map((row) => skuProjection(row, dimensions));
  const payload: ProductSkuEditorPayload = {
    specType: product.specType === 1 ? 1 : 0,
    dimensions,
    skus: assigned,
  };
  await tx.delete(storeProductAttr).where(and(
    eq(storeProductAttr.productId, product.id),
    eq(storeProductAttr.type, PRODUCT_ATTR_TYPE),
  ));
  await tx.insert(storeProductAttr).values(dimensions.map((dimension) => ({
    productId: product.id,
    attrName: dimension.value,
    attrValues: dimension.detail.join(","),
    type: PRODUCT_ATTR_TYPE,
  })));
  await tx.delete(storeProductAttrResult).where(and(
    eq(storeProductAttrResult.productId, product.id),
    eq(storeProductAttrResult.type, PRODUCT_ATTR_TYPE),
  ));
  await tx.insert(storeProductAttrResult).values({
    productId: product.id,
    result: JSON.stringify({ attr: dimensions, value: assigned }),
    changeTime: now,
    type: PRODUCT_ATTR_TYPE,
  });
  const summary = productSkuSummary(payload);
  await tx.update(storeProduct).set({
    stock: summary.stock,
    price: summary.price,
    settlePrice: summary.settlePrice,
    cost: summary.cost,
    otPrice: summary.otPrice,
    vipPrice: summary.vipPrice,
    isSold: summary.isSold,
  }).where(eq(storeProduct.id, product.id));
  const [products, savedDimensions, savedRows, results] = await Promise.all([
    tx.select({
      specType: storeProduct.specType,
      stock: storeProduct.stock,
      price: storeProduct.price,
      settlePrice: storeProduct.settlePrice,
      cost: storeProduct.cost,
      otPrice: storeProduct.otPrice,
      vipPrice: storeProduct.vipPrice,
      isSold: storeProduct.isSold,
    }).from(storeProduct).where(eq(storeProduct.id, product.id)).limit(1),
    tx.select({ attrName: storeProductAttr.attrName, attrValues: storeProductAttr.attrValues })
      .from(storeProductAttr).where(and(
        eq(storeProductAttr.productId, product.id), eq(storeProductAttr.type, PRODUCT_ATTR_TYPE),
      )).orderBy(asc(storeProductAttr.id)),
    tx.select({
      suk: storeProductAttrValue.suk,
      unique: storeProductAttrValue.unique,
      stock: storeProductAttrValue.stock,
      price: storeProductAttrValue.price,
      settlePrice: storeProductAttrValue.settlePrice,
      cost: storeProductAttrValue.cost,
      otPrice: storeProductAttrValue.otPrice,
      vipPrice: storeProductAttrValue.vipPrice,
      diskInfo: storeProductAttrValue.diskInfo,
      writeTimes: storeProductAttrValue.writeTimes,
      writeValid: storeProductAttrValue.writeValid,
      writeDays: storeProductAttrValue.writeDays,
      writeStart: storeProductAttrValue.writeStart,
      writeEnd: storeProductAttrValue.writeEnd,
    }).from(storeProductAttrValue).where(and(
      eq(storeProductAttrValue.productId, product.id),
      eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
      eq(storeProductAttrValue.isRetired, 0),
    )).orderBy(asc(storeProductAttrValue.id)),
    tx.select({ result: storeProductAttrResult.result }).from(storeProductAttrResult).where(and(
      eq(storeProductAttrResult.productId, product.id), eq(storeProductAttrResult.type, PRODUCT_ATTR_TYPE),
    )).limit(1),
  ]);
  if (!productSkuReadbackMatches(
    products[0],
    dimensionsFromRows(savedDimensions, payload.specType),
    savedRows,
    results[0]?.result,
    payload,
    assigned,
  )) throw new Error("商品SKU退役状态数据库回读校验失败");
  return assigned;
}

function equalDimensions(
  actual: SupplierProductDimension[],
  expected: SupplierProductDimension[],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function productSkuReadbackMatches(
  product: {
    specType: number;
    stock: number;
    price: string;
    settlePrice: string;
    cost: string;
    otPrice: string;
    vipPrice: string;
    isSold: number;
  } | undefined,
  dimensions: SupplierProductDimension[],
  rows: Array<{
    suk: string;
    unique: string;
    stock: number;
    price: string;
    settlePrice: string;
    cost: string;
    otPrice: string;
    vipPrice: string;
    diskInfo?: string | null;
    writeTimes?: number;
    writeValid?: number;
    writeDays?: number;
    writeStart?: number;
    writeEnd?: number;
  }>,
  result: string | undefined,
  expected: ProductSkuEditorPayload,
  assigned: ProductSkuEditorRow[],
): boolean {
  if (!product || !result) return false;
  const summary = productSkuSummary(expected);
  if (
    product.specType !== expected.specType
    || product.stock !== summary.stock
    || product.price !== summary.price
    || product.settlePrice !== summary.settlePrice
    || product.cost !== summary.cost
    || product.otPrice !== summary.otPrice
    || product.vipPrice !== summary.vipPrice
    || product.isSold !== summary.isSold
    || !equalDimensions(dimensions, expected.dimensions)
    || rows.length !== assigned.length
  ) return false;
  const expectedBySuk = new Map(assigned.map((row) => [row.suk, row]));
  for (const row of rows) {
    const wanted = expectedBySuk.get(row.suk);
    if (!wanted
      || row.unique !== wanted.unique
      || row.stock !== wanted.stock
      || row.price !== wanted.price
      || row.settlePrice !== wanted.settlePrice
      || row.cost !== wanted.cost
      || row.otPrice !== wanted.otPrice
      || row.vipPrice !== wanted.vipPrice
      || (row.diskInfo ?? "") !== wanted.diskInfo
      || (row.writeTimes ?? 1) !== wanted.writeTimes
      || (row.writeValid ?? 1) !== wanted.writeValid
      || (row.writeDays ?? 0) !== wanted.writeDays
      || (row.writeStart ?? 0) !== wanted.writeStart
      || (row.writeEnd ?? 0) !== wanted.writeEnd
    ) return false;
  }
  try {
    const snapshot = JSON.parse(result) as { attr?: unknown; value?: unknown };
    if (!equalDimensions(snapshot.attr as SupplierProductDimension[], expected.dimensions)) return false;
    if (!Array.isArray(snapshot.value) || snapshot.value.length !== assigned.length) return false;
    const snapshotRows = snapshot.value as Array<{
      suk?: unknown;
      unique?: unknown;
      diskInfo?: unknown;
      writeTimes?: unknown;
      writeValid?: unknown;
      writeDays?: unknown;
      writeStart?: unknown;
      writeEnd?: unknown;
    }>;
    return snapshotRows.every((row) => (
      typeof row.suk === "string"
      && typeof row.unique === "string"
      && expectedBySuk.get(row.suk)?.unique === row.unique
      && expectedBySuk.get(row.suk)?.diskInfo === (
        typeof row.diskInfo === "string" ? row.diskInfo : ""
      )
      && expectedBySuk.get(row.suk)?.writeTimes === (typeof row.writeTimes === "number" ? row.writeTimes : 1)
      && expectedBySuk.get(row.suk)?.writeValid === (typeof row.writeValid === "number" ? row.writeValid : 1)
      && expectedBySuk.get(row.suk)?.writeDays === (typeof row.writeDays === "number" ? row.writeDays : 0)
      && expectedBySuk.get(row.suk)?.writeStart === (typeof row.writeStart === "number" ? row.writeStart : 0)
      && expectedBySuk.get(row.suk)?.writeEnd === (typeof row.writeEnd === "number" ? row.writeEnd : 0)
    ));
  } catch {
    return false;
  }
}

export async function replaceProductSkuEditor(
  tx: DbClient,
  product: { id: number; productType: number; image: string; type: number; relationId: number },
  payload: ProductSkuEditorPayload,
  now: number,
): Promise<ProductSkuEditorRow[]> {
  if (![PHYSICAL_PRODUCT_TYPE, CARD_PRODUCT_TYPE, MANUAL_VIRTUAL_PRODUCT_TYPE, SECOND_CARD_PRODUCT_TYPE].includes(product.productType)) {
    throw new ValidateException("当前阶段只支持编辑实物、卡密、手工虚拟或次卡商品SKU");
  }
  await tx.execute(sql`SELECT pg_advisory_xact_lock(
    ${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},
    ${PRODUCT_SKU_IDENTITY_LOCK_KEY}
  )`);
  const allCurrentRows = await tx.select().from(storeProductAttrValue).where(and(
    eq(storeProductAttrValue.productId, product.id),
    eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
  )).orderBy(asc(storeProductAttrValue.id)).for("update");
  if (
    new Set(allCurrentRows.map((row) => row.suk)).size !== allCurrentRows.length
    || new Set(allCurrentRows.map((row) => row.unique)).size !== allCurrentRows.length
  ) throw new ValidateException("历史商品存在重复SKU或唯一标识，请先专项清理");

  const currentRows = allCurrentRows.filter((row) => row.isRetired === 0);
  const cardCounts = product.productType === CARD_PRODUCT_TYPE
    ? await tx
        .select({
          attrUnique: storeProductVirtual.attrUnique,
          total: sql<number>`COUNT(*)::int`,
        })
        .from(storeProductVirtual)
        .where(eq(storeProductVirtual.productId, product.id))
        .groupBy(storeProductVirtual.attrUnique)
    : [];
  const cardCountByUnique = new Map(cardCounts.map((row) => [row.attrUnique, Number(row.total)]));
  const retiredSuks = new Set(allCurrentRows.filter((row) => row.isRetired === 1).map((row) => row.suk));
  if (payload.skus.some((row) => retiredSuks.has(row.suk))) {
    throw new ValidateException("退役SKU不能通过普通保存恢复，请使用受控恢复操作");
  }

  const desiredSuks = new Set(payload.skus.map((sku) => sku.suk));
  const removed = currentRows.filter((row) => !desiredSuks.has(row.suk));
  if (removed.length) {
    throw new ValidateException("为保护购物车、订单、退款和活动引用，当前阶段不能删除或重命名已有SKU");
  }
  const currentBySuk = new Map(currentRows.map((row) => [row.suk, row]));
  const used = new Set(allCurrentRows.map((row) => row.unique));
  const assigned: ProductSkuEditorRow[] = [];
  const stockRecords: Array<typeof storeProductStockRecord.$inferInsert> = [];

  for (const sku of payload.skus) {
    const current = currentBySuk.get(sku.suk);
    if (current && sku.unique && sku.unique !== current.unique) {
      throw new ValidateException(`SKU ${sku.suk} 的唯一标识不能修改`);
    }
    let unique = current?.unique ?? "";
    while (!unique) {
      const candidate = opaqueSkuUnique();
      if (used.has(candidate)) continue;
      const collision = await tx.select({ id: storeProductAttrValue.id })
        .from(storeProductAttrValue).where(eq(storeProductAttrValue.unique, candidate)).limit(1);
      if (!collision[0]) unique = candidate;
    }
    used.add(unique);
    const diskInfo = product.productType === CARD_PRODUCT_TYPE ? sku.diskInfo : "";
    const cardCount = current ? (cardCountByUnique.get(current.unique) ?? 0) : 0;
    if (diskInfo && cardCount > 0) {
      throw new ValidateException(`SKU ${sku.suk} 已有关联卡密，不能切换为固定虚拟内容`);
    }
    if (product.productType === CARD_PRODUCT_TYPE && !diskInfo) {
      if (!current && sku.stock !== 0) {
        throw new ValidateException(`SKU ${sku.suk} 使用卡密库存时初始库存必须为0，请通过卡密导入增加库存`);
      }
      if (current && current.diskInfo?.trim() && sku.stock !== 0) {
        throw new ValidateException(`SKU ${sku.suk} 切换为卡密库存时库存必须为0`);
      }
      if (current && !current.diskInfo?.trim() && sku.stock !== current.stock) {
        throw new ValidateException(`SKU ${sku.suk} 的库存由未分配卡密数量维护，不能直接修改`);
      }
    }
    const sumStock = current
      ? current.sumStock + Math.max(0, sku.stock - current.stock)
      : sku.stock;
    const row: ProductSkuEditorRow = {
      ...sku,
      unique,
      sales: current?.sales ?? 0,
      sumStock,
      diskInfo,
    };
    assigned.push(row);
    if (current) {
      await tx.update(storeProductAttrValue).set({
        productType: product.productType,
        stock: sku.stock,
        sumStock,
        price: sku.price,
        settlePrice: sku.settlePrice,
        image: sku.image || product.image.slice(0, 128),
        cost: sku.cost,
        barCode: sku.barCode,
        otPrice: sku.otPrice,
        vipPrice: sku.vipPrice,
        weight: sku.weight,
        volume: sku.volume,
        brokerage: sku.brokerage,
        brokerageTwo: sku.brokerageTwo,
        code: sku.code,
        diskInfo,
        writeTimes: sku.writeTimes,
        writeValid: sku.writeValid,
        writeDays: sku.writeDays,
        writeStart: sku.writeStart,
        writeEnd: sku.writeEnd,
      }).where(eq(storeProductAttrValue.id, current.id));
      const difference = sku.stock - current.stock;
      if (difference !== 0) stockRecords.push({
        storeId: product.type === 0 ? 0 : product.relationId,
        productId: product.id,
        unique,
        costPrice: sku.cost,
        number: Math.abs(difference),
        pm: difference > 0 ? 1 : 0,
        addTime: now,
      });
    } else {
      await tx.insert(storeProductAttrValue).values({
        productId: product.id,
        productType: product.productType,
        suk: sku.suk,
        stock: sku.stock,
        sumStock,
        sales: 0,
        price: sku.price,
        settlePrice: sku.settlePrice,
        image: sku.image || product.image.slice(0, 128),
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
        diskInfo,
        writeTimes: sku.writeTimes,
        writeValid: sku.writeValid,
        writeDays: sku.writeDays,
        writeStart: sku.writeStart,
        writeEnd: sku.writeEnd,
      });
      if (sku.stock > 0) stockRecords.push({
        storeId: product.type === 0 ? 0 : product.relationId,
        productId: product.id,
        unique,
        costPrice: sku.cost,
        number: sku.stock,
        pm: 1,
        addTime: now,
      });
    }
  }

  await tx.delete(storeProductAttr).where(and(
    eq(storeProductAttr.productId, product.id),
    eq(storeProductAttr.type, PRODUCT_ATTR_TYPE),
  ));
  await tx.insert(storeProductAttr).values(payload.dimensions.map((dimension) => ({
    productId: product.id,
    attrName: dimension.value,
    attrValues: dimension.detail.join(","),
    type: PRODUCT_ATTR_TYPE,
  })));
  await tx.delete(storeProductAttrResult).where(and(
    eq(storeProductAttrResult.productId, product.id),
    eq(storeProductAttrResult.type, PRODUCT_ATTR_TYPE),
  ));
  await tx.insert(storeProductAttrResult).values({
    productId: product.id,
    result: JSON.stringify({ attr: payload.dimensions, value: assigned }),
    changeTime: now,
    type: PRODUCT_ATTR_TYPE,
  });
  if (stockRecords.length) await tx.insert(storeProductStockRecord).values(stockRecords);
  const summary = productSkuSummary(payload);
  await tx.update(storeProduct).set({
    specType: payload.specType,
    stock: summary.stock,
    price: summary.price,
    settlePrice: summary.settlePrice,
    cost: summary.cost,
    otPrice: summary.otPrice,
    vipPrice: summary.vipPrice,
    isSold: summary.isSold,
  }).where(eq(storeProduct.id, product.id));

  const [products, dimensionRows, skuRows, results] = await Promise.all([
    tx.select({
      specType: storeProduct.specType,
      stock: storeProduct.stock,
      price: storeProduct.price,
      settlePrice: storeProduct.settlePrice,
      cost: storeProduct.cost,
      otPrice: storeProduct.otPrice,
      vipPrice: storeProduct.vipPrice,
      isSold: storeProduct.isSold,
    }).from(storeProduct).where(eq(storeProduct.id, product.id)).limit(1),
    tx.select({ attrName: storeProductAttr.attrName, attrValues: storeProductAttr.attrValues })
      .from(storeProductAttr).where(and(
        eq(storeProductAttr.productId, product.id), eq(storeProductAttr.type, PRODUCT_ATTR_TYPE),
      )).orderBy(asc(storeProductAttr.id)),
    tx.select({
      suk: storeProductAttrValue.suk,
      unique: storeProductAttrValue.unique,
      stock: storeProductAttrValue.stock,
      price: storeProductAttrValue.price,
      settlePrice: storeProductAttrValue.settlePrice,
      cost: storeProductAttrValue.cost,
      otPrice: storeProductAttrValue.otPrice,
      vipPrice: storeProductAttrValue.vipPrice,
      diskInfo: storeProductAttrValue.diskInfo,
      writeTimes: storeProductAttrValue.writeTimes,
      writeValid: storeProductAttrValue.writeValid,
      writeDays: storeProductAttrValue.writeDays,
      writeStart: storeProductAttrValue.writeStart,
      writeEnd: storeProductAttrValue.writeEnd,
    }).from(storeProductAttrValue).where(and(
      eq(storeProductAttrValue.productId, product.id),
      eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
      eq(storeProductAttrValue.isRetired, 0),
    )).orderBy(asc(storeProductAttrValue.id)),
    tx.select({ result: storeProductAttrResult.result }).from(storeProductAttrResult).where(and(
      eq(storeProductAttrResult.productId, product.id), eq(storeProductAttrResult.type, PRODUCT_ATTR_TYPE),
    )).limit(1),
  ]);
  const verified = productSkuReadbackMatches(
    products[0],
    dimensionsFromRows(dimensionRows, payload.specType),
    skuRows,
    results[0]?.result,
    payload,
    assigned,
  );
  if (!verified) throw new Error("商品SKU数据库回读校验失败");
  return assigned;
}
