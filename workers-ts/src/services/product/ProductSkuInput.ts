import { ValidateException } from "@/utils/errors";

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

export interface PhysicalProductNormalizationOptions {
  requireSettlePrice?: boolean;
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

function integerValue(value: unknown, field: string): number {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new ValidateException(`${field}必须是非负整数`);
  }
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

export function buildSkuCombinations(
  dimensions: SupplierProductDimension[],
): Array<Record<string, string>> {
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

function normalizeSkuDetail(
  row: UnknownRecord,
  dimensions: SupplierProductDimension[],
): Record<string, string> {
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
  const normalizedDimensions = specType === 0 ? [{ value: "规格", detail: ["默认"] }] : dimensions;
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
