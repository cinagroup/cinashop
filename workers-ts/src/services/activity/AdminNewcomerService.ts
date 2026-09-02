import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import type { Env } from "@/env";
import {
  legacyCache,
  storeCouponIssue,
  storeNewcomer,
  storeProduct,
  storeProductAttrValue,
  systemConfig,
} from "@/models/schema";
import {
  PRODUCT_SKU_IDENTITY_LOCK_KEY,
  PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE,
} from "@/services/product/ProductSkuIdentity";
import { normalizeConfigScalar } from "@/utils/config";
import { ValidateException } from "@/utils/errors";

export const REGISTER_CONFIG_KEYS = [
  "store_user_mobile",
  "routine_auth_type",
  "store_user_agreement",
  "newcomer_status",
  "newcomer_limit_status",
  "newcomer_limit_time",
  "register_integral_status",
  "register_give_integral",
  "register_money_status",
  "register_give_money",
  "register_coupon_status",
  "register_give_coupon",
  "first_order_status",
  "first_order_discount",
  "first_order_discount_limit",
  "register_price_status",
] as const;

type RegisterConfigKey = (typeof REGISTER_CONFIG_KEYS)[number];

const DEFAULTS: Record<RegisterConfigKey, unknown> = {
  store_user_mobile: 0,
  routine_auth_type: [1, 2],
  store_user_agreement: 1,
  newcomer_status: 0,
  newcomer_limit_status: 1,
  newcomer_limit_time: 0,
  register_integral_status: 0,
  register_give_integral: 0,
  register_money_status: 0,
  register_give_money: "0.00",
  register_coupon_status: 0,
  register_give_coupon: [],
  first_order_status: 0,
  first_order_discount: "100",
  first_order_discount_limit: "0.00",
  register_price_status: 0,
};

const CONFIG_INFO: Record<RegisterConfigKey, string> = {
  store_user_mobile: "强制手机号登录",
  routine_auth_type: "小程序授权登录方式",
  store_user_agreement: "注册协议开关",
  newcomer_status: "新人礼总开关",
  newcomer_limit_status: "新人礼时效开关",
  newcomer_limit_time: "新人礼有效天数",
  register_integral_status: "注册赠送积分开关",
  register_give_integral: "注册赠送积分",
  register_money_status: "注册赠送余额开关",
  register_give_money: "注册赠送余额",
  register_coupon_status: "注册赠送优惠券开关",
  register_give_coupon: "注册赠送优惠券",
  first_order_status: "首单优惠开关",
  first_order_discount: "首单支付百分比",
  first_order_discount_limit: "首单优惠上限",
  register_price_status: "新人专享价开关",
};

export interface NormalizedNewcomerSku {
  unique: string;
  price: string;
}

export interface NormalizedNewcomerProduct {
  productId: number;
  skus: NormalizedNewcomerSku[];
}

export interface NormalizedRegisterConfig {
  values: Record<RegisterConfigKey, unknown>;
  agreement: string;
  products: NormalizedNewcomerProduct[];
}

function pick(input: Record<string, unknown>, key: string): unknown {
  return input[key];
}

function flag(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  throw new ValidateException(`${label}格式错误`);
}

function integer(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; fallback?: number } = {},
): number {
  if ((value === undefined || value === "") && options.fallback !== undefined) {
    return options.fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < (options.min ?? 0)
    || parsed > (options.max ?? 2_147_483_647)
  ) {
    throw new ValidateException(`${label}格式错误`);
  }
  return parsed;
}

function money(value: unknown, label: string, options: { positive?: boolean } = {}): string {
  const text = String(value ?? "0").trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) {
    throw new ValidateException(`${label}格式错误`);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed >= 10_000_000_000 || (options.positive && parsed <= 0)) {
    throw new ValidateException(options.positive ? `${label}必须大于0` : `${label}超出支持范围`);
  }
  return parsed.toFixed(2);
}

function discountPercent(value: unknown): string {
  const text = String(value ?? "100").trim();
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text)) throw new ValidateException("首单折扣格式错误");
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new ValidateException("首单折扣必须在0到100之间");
  }
  return text.replace(/\.0+$/, "");
}

function positiveIds(value: unknown, label: string, max = 100): number[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === "" ? [] : [value];
  const ids = raw.map((item) => {
    const candidate = item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>).id
      : item;
    return integer(candidate, label, { min: 1 });
  });
  const unique = [...new Set(ids)].sort((left, right) => left - right);
  if (unique.length !== ids.length) throw new ValidateException(`${label}不能重复`);
  if (unique.length > max) throw new ValidateException(`${label}最多选择${max}项`);
  return unique;
}

function routineAuthTypes(value: unknown): number[] {
  const ids = positiveIds(value ?? [1, 2], "登录方式", 2);
  if (!ids.length || ids.some((id) => id !== 1 && id !== 2)) {
    throw new ValidateException("至少选择一种受支持的登录方式");
  }
  return ids;
}

function normalizeProducts(value: unknown): NormalizedNewcomerProduct[] {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value)) throw new ValidateException("新人专享商品格式错误");
  if (value.length > 100) throw new ValidateException("新人专享商品最多选择100个");
  const seenProducts = new Set<number>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ValidateException("新人专享商品格式错误");
    }
    const row = item as Record<string, unknown>;
    const productId = integer(row.product_id ?? row.productId, "商品 ID", { min: 1 });
    if (seenProducts.has(productId)) throw new ValidateException("新人专享商品不能重复");
    seenProducts.add(productId);
    const attrs = row.attr ?? row.attr_value ?? row.skus;
    if (!Array.isArray(attrs) || attrs.length === 0 || attrs.length > 200) {
      throw new ValidateException("每个新人专享商品必须选择1到200个规格");
    }
    const seenSkus = new Set<string>();
    const skus = attrs.map((attr) => {
      if (!attr || typeof attr !== "object" || Array.isArray(attr)) {
        throw new ValidateException("新人专享规格格式错误");
      }
      const sku = attr as Record<string, unknown>;
      const unique = typeof sku.unique === "string" ? sku.unique.trim() : "";
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(unique)) throw new ValidateException("新人专享规格标识无效");
      if (seenSkus.has(unique)) throw new ValidateException("同一商品规格不能重复");
      seenSkus.add(unique);
      return { unique, price: money(sku.price, "商品专享价", { positive: true }) };
    });
    return { productId, skus };
  }).sort((left, right) => left.productId - right.productId);
}

export function normalizeRegisterConfig(input: Record<string, unknown>): NormalizedRegisterConfig {
  const values: Record<RegisterConfigKey, unknown> = {
    store_user_mobile: flag(pick(input, "store_user_mobile"), "手机号登录开关", 0),
    routine_auth_type: routineAuthTypes(pick(input, "routine_auth_type")),
    store_user_agreement: flag(pick(input, "store_user_agreement"), "注册协议开关", 1),
    newcomer_status: flag(pick(input, "newcomer_status"), "新人礼开关", 0),
    newcomer_limit_status: flag(pick(input, "newcomer_limit_status"), "新人礼时效开关", 1),
    newcomer_limit_time: integer(pick(input, "newcomer_limit_time"), "新人礼有效天数", {
      min: 0,
      max: 36_500,
      fallback: 0,
    }),
    register_integral_status: flag(pick(input, "register_integral_status"), "赠送积分开关", 0),
    register_give_integral: integer(pick(input, "register_give_integral"), "赠送积分", {
      min: 0,
      max: 2_147_483_647,
      fallback: 0,
    }),
    register_money_status: flag(pick(input, "register_money_status"), "赠送余额开关", 0),
    register_give_money: money(pick(input, "register_give_money"), "赠送余额"),
    register_coupon_status: flag(pick(input, "register_coupon_status"), "赠送优惠券开关", 0),
    register_give_coupon: positiveIds(pick(input, "register_give_coupon"), "优惠券", 100),
    first_order_status: flag(pick(input, "first_order_status"), "首单优惠开关", 0),
    first_order_discount: discountPercent(pick(input, "first_order_discount")),
    first_order_discount_limit: money(pick(input, "first_order_discount_limit"), "首单优惠上限"),
    register_price_status: flag(pick(input, "register_price_status"), "新人专享价开关", 0),
  };
  const agreement = typeof input.newcomer_agreement === "string"
    ? input.newcomer_agreement.trim()
    : "";
  if (agreement.length > 200_000) throw new ValidateException("新人规则不能超过200000个字符");
  return { values, agreement, products: normalizeProducts(input.product) };
}

function parseStoredValue(key: RegisterConfigKey, value: string | undefined): unknown {
  if (value === undefined) return DEFAULTS[key];
  const normalized = normalizeConfigScalar(value);
  if (key === "routine_auth_type" || key === "register_give_coupon") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : DEFAULTS[key];
    } catch {
      return normalized ? normalized.split(",").map(Number).filter(Number.isSafeInteger) : [];
    }
  }
  if (new Set<RegisterConfigKey>([
    "register_give_money",
    "first_order_discount",
    "first_order_discount_limit",
  ]).has(key)) return normalized || DEFAULTS[key];
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : DEFAULTS[key];
}

function randomUnique(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function freshSkuUnique(tx: DbClient, reserved: Set<string>): Promise<string> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(
    ${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},
    ${PRODUCT_SKU_IDENTITY_LOCK_KEY}
  )`);
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = randomUnique();
    if (reserved.has(candidate)) continue;
    const rows = await tx
      .select({ id: storeProductAttrValue.id })
      .from(storeProductAttrValue)
      .where(eq(storeProductAttrValue.unique, candidate))
      .limit(1);
    if (!rows[0]) {
      reserved.add(candidate);
      return candidate;
    }
  }
  throw new Error("新人专享规格标识生成失败");
}

function cloneActivitySku(
  base: typeof storeProductAttrValue.$inferSelect,
  productId: number,
  unique: string,
  price: string,
): typeof storeProductAttrValue.$inferInsert {
  return {
    productId,
    productType: base.productType,
    suk: base.suk,
    stock: base.stock,
    sumStock: base.sumStock,
    sales: base.sales,
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
    type: 7,
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

export class AdminNewcomerService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private async configSnapshot() {
    const rows = await this.container.db
      .select({
        id: systemConfig.id,
        menuName: systemConfig.menuName,
        value: systemConfig.value,
        sort: systemConfig.sort,
      })
      .from(systemConfig)
      .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...REGISTER_CONFIG_KEYS])))
      .orderBy(asc(systemConfig.sort), asc(systemConfig.id));
    const raw = new Map<string, string>();
    for (const row of rows) raw.set(row.menuName, row.value);
    const missing = REGISTER_CONFIG_KEYS.filter((key) => !raw.has(key));
    const values = Object.fromEntries(
      REGISTER_CONFIG_KEYS.map((key) => [key, parseStoredValue(key, raw.get(key))]),
    ) as Record<RegisterConfigKey, unknown>;
    return { values, missing };
  }

  private async catalog() {
    const newcomers = await this.container.db
      .select({ newcomer: storeNewcomer, product: storeProduct })
      .from(storeNewcomer)
      .innerJoin(storeProduct, eq(storeProduct.id, storeNewcomer.productId))
      .where(eq(storeNewcomer.isDel, 0))
      .orderBy(asc(storeNewcomer.id));
    if (!newcomers.length) return [];
    const productIds = [...new Set(newcomers.map(({ newcomer }) => newcomer.productId))];
    const newcomerIds = newcomers.map(({ newcomer }) => newcomer.id);
    const [baseSkus, activitySkus] = await Promise.all([
      this.container.db
        .select()
        .from(storeProductAttrValue)
        .where(and(eq(storeProductAttrValue.type, 0), inArray(storeProductAttrValue.productId, productIds)))
        .orderBy(asc(storeProductAttrValue.id)),
      this.container.db
        .select()
        .from(storeProductAttrValue)
        .where(and(eq(storeProductAttrValue.type, 7), inArray(storeProductAttrValue.productId, newcomerIds)))
        .orderBy(asc(storeProductAttrValue.id)),
    ]);
    return newcomers.map(({ newcomer, product }) => {
      const baseBySuk = new Map(
        baseSkus.filter((sku) => sku.productId === newcomer.productId).map((sku) => [sku.suk, sku]),
      );
      const attr = activitySkus
        .filter((sku) => sku.productId === newcomer.id)
        .map((sku) => ({
          unique: baseBySuk.get(sku.suk)?.unique ?? "",
          activity_unique: sku.unique,
          suk: sku.suk || "默认",
          price: String(sku.price),
          ot_price: String(sku.otPrice),
          stock: baseBySuk.get(sku.suk)?.stock ?? 0,
        }))
        .filter((sku) => sku.unique);
      return {
        id: newcomer.id,
        product_id: newcomer.productId,
        store_name: product.storeName,
        image: product.image,
        price: String(newcomer.price),
        ot_price: String(newcomer.otPrice),
        stock: product.stock,
        attr,
      };
    });
  }

  async registerConfig() {
    const [{ values, missing }, product, cacheRows] = await Promise.all([
      this.configSnapshot(),
      this.catalog(),
      this.container.db
        .select({ result: legacyCache.result, expireTime: legacyCache.expireTime })
        .from(legacyCache)
        .where(eq(legacyCache.key, "newcomer_agreement"))
        .limit(1),
    ]);
    let newcomerAgreement = "";
    const cached = cacheRows[0];
    if (cached && (cached.expireTime === 0 || cached.expireTime >= Math.floor(Date.now() / 1_000))) {
      try {
        const parsed: unknown = JSON.parse(cached.result ?? "null");
        newcomerAgreement = typeof parsed === "string" ? parsed : "";
      } catch {
        newcomerAgreement = "";
      }
    }
    const couponIds = values.register_give_coupon as number[];
    const coupons = couponIds.length
      ? await this.container.db
          .select({
            id: storeCouponIssue.id,
            title: storeCouponIssue.title,
            couponTitle: storeCouponIssue.couponTitle,
            couponPrice: storeCouponIssue.couponPrice,
            useMinPrice: storeCouponIssue.useMinPrice,
            remainCount: storeCouponIssue.remainCount,
            isPermanent: storeCouponIssue.isPermanent,
            status: storeCouponIssue.status,
          })
          .from(storeCouponIssue)
          .where(inArray(storeCouponIssue.id, couponIds))
          .orderBy(asc(storeCouponIssue.id))
      : [];
    return {
      ...values,
      register_give_coupon: coupons.map((coupon) => ({
        id: coupon.id,
        title: coupon.title || coupon.couponTitle,
        coupon_price: coupon.couponPrice,
        use_min_price: coupon.useMinPrice,
        remain_count: coupon.remainCount,
        is_permanent: coupon.isPermanent,
        status: coupon.status,
      })),
      product,
      newcomer_agreement: newcomerAgreement,
      register_notice: "多端账号统一可通过强制手机号登录或绑定微信开放平台实现。",
      missing_config_keys: missing,
    };
  }

  async productOptions(query: Record<string, unknown>) {
    const page = Math.max(1, Number.parseInt(String(query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(query.limit ?? "20"), 10) || 20));
    const keyword = typeof query.keyword === "string" ? query.keyword.trim().slice(0, 100) : "";
    const conditions: SQL[] = [
      eq(storeProduct.isShow, 1),
      eq(storeProduct.isDel, 0),
      eq(storeProduct.isVerify, 1),
      eq(storeProduct.isVipProduct, 0),
      eq(storeProduct.isPresaleProduct, 0),
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
          specType: storeProduct.specType,
        })
        .from(storeProduct)
        .where(where)
        .orderBy(desc(storeProduct.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(storeProduct).where(where),
    ]);
    const ids = products.map((product) => product.id);
    const skus = ids.length
      ? await this.container.db
          .select()
          .from(storeProductAttrValue)
          .where(and(eq(storeProductAttrValue.type, 0), inArray(storeProductAttrValue.productId, ids)))
          .orderBy(asc(storeProductAttrValue.id))
      : [];
    return {
      list: products.map((product) => ({
        id: product.id,
        store_name: product.storeName,
        image: product.image,
        price: product.price,
        ot_price: product.otPrice,
        stock: product.stock,
        spec_type: product.specType,
        attr: skus.filter((sku) => sku.productId === product.id).map((sku) => ({
          unique: sku.unique,
          suk: sku.suk || "默认",
          price: sku.price,
          ot_price: sku.otPrice,
          stock: sku.stock,
        })),
      })),
      count: totals[0]?.count ?? 0,
    };
  }

  async couponOptions(query: Record<string, unknown>) {
    const page = Math.max(1, Number.parseInt(String(query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(query.limit ?? "20"), 10) || 20));
    const keyword = typeof query.keyword === "string" ? query.keyword.trim().slice(0, 100) : "";
    const conditions: SQL[] = [eq(storeCouponIssue.isDel, 0), eq(storeCouponIssue.status, 1)];
    if (keyword) conditions.push(or(
      ilike(storeCouponIssue.title, `%${keyword}%`),
      ilike(storeCouponIssue.couponTitle, `%${keyword}%`),
    )!);
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(storeCouponIssue)
        .where(where)
        .orderBy(desc(storeCouponIssue.sort), desc(storeCouponIssue.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(storeCouponIssue).where(where),
    ]);
    return {
      list: rows.map((coupon) => ({
        id: coupon.id,
        title: coupon.title || coupon.couponTitle,
        coupon_price: coupon.couponPrice,
        use_min_price: coupon.useMinPrice,
        remain_count: coupon.remainCount,
        is_permanent: coupon.isPermanent,
      })),
      count: totals[0]?.count ?? 0,
    };
  }

  async saveRegisterConfig(input: Record<string, unknown>) {
    const normalized = normalizeRegisterConfig(input);
    const now = Math.floor(Date.now() / 1_000);
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin-newcomer-register-config'))`);

      const configs = await tx
        .select({ id: systemConfig.id, menuName: systemConfig.menuName })
        .from(systemConfig)
        .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...REGISTER_CONFIG_KEYS])))
        .orderBy(asc(systemConfig.id))
        .for("update");
      const existing = new Map<string, number[]>();
      for (const config of configs) {
        existing.set(config.menuName, [...(existing.get(config.menuName) ?? []), config.id]);
      }
      for (const key of REGISTER_CONFIG_KEYS) {
        const value = JSON.stringify(normalized.values[key]);
        const ids = existing.get(key) ?? [];
        if (ids.length) {
          await tx.update(systemConfig).set({ value }).where(inArray(systemConfig.id, ids));
        } else {
          await tx.insert(systemConfig).values({
            isStore: 0,
            menuName: key,
            type: "text",
            inputType: "input",
            configTabId: 0,
            parameter: "",
            uploadType: 1,
            required: "",
            width: 0,
            high: 0,
            value,
            info: CONFIG_INFO[key],
            desc: CONFIG_INFO[key],
            sort: 0,
            status: 0,
          });
        }
      }
      await tx.insert(legacyCache).values({
        key: "newcomer_agreement",
        result: JSON.stringify(normalized.agreement),
        expireTime: 0,
        addTime: now,
      }).onConflictDoUpdate({
        target: legacyCache.key,
        set: { result: JSON.stringify(normalized.agreement), expireTime: 0, addTime: now },
      });

      await this.replaceCatalog(tx, normalized.products, now);
    });
    await Promise.all(REGISTER_CONFIG_KEYS.map((key) => this.env.CONFIG_KV.delete(`cfg_${key}`)));
    return this.registerConfig();
  }

  private async replaceCatalog(tx: DbClient, products: NormalizedNewcomerProduct[], now: number) {
    const productIds = products.map((product) => product.productId);
    const baseProducts = productIds.length
      ? await tx
          .select()
          .from(storeProduct)
          .where(inArray(storeProduct.id, productIds))
          .orderBy(asc(storeProduct.id))
          .for("update")
      : [];
    const productById = new Map(baseProducts.map((product) => [product.id, product]));
    for (const requested of products) {
      const product = productById.get(requested.productId);
      if (
        !product
        || product.isShow !== 1
        || product.isDel !== 0
        || product.isVerify !== 1
        || product.isVipProduct !== 0
        || product.isPresaleProduct !== 0
      ) throw new ValidateException("原商品已下架、未审核或不支持新人专享");
    }

    const baseSkus = productIds.length
      ? await tx
          .select()
          .from(storeProductAttrValue)
          .where(and(eq(storeProductAttrValue.type, 0), inArray(storeProductAttrValue.productId, productIds)))
          .orderBy(asc(storeProductAttrValue.id))
          .for("update")
      : [];
    const baseByProduct = new Map<number, Map<string, typeof storeProductAttrValue.$inferSelect>>();
    for (const sku of baseSkus) {
      const byUnique = baseByProduct.get(sku.productId) ?? new Map();
      byUnique.set(sku.unique, sku);
      baseByProduct.set(sku.productId, byUnique);
    }
    for (const requested of products) {
      const byUnique = baseByProduct.get(requested.productId);
      if (!byUnique || requested.skus.some((sku) => !byUnique.has(sku.unique))) {
        throw new ValidateException("新人专享规格已变更，请重新选择商品");
      }
    }

    const existingRows = await tx
      .select()
      .from(storeNewcomer)
      .where(eq(storeNewcomer.isDel, 0))
      .orderBy(asc(storeNewcomer.productId), asc(storeNewcomer.id))
      .for("update");
    const existingByProduct = new Map<number, typeof storeNewcomer.$inferSelect>();
    for (const row of existingRows) {
      if (existingByProduct.has(row.productId)) {
        throw new ValidateException(`商品 ${row.productId} 存在重复的新人专享记录，请先清理历史数据`);
      }
      existingByProduct.set(row.productId, row);
    }
    const reserved = new Set(baseSkus.map((sku) => sku.unique));
    for (const requested of products) {
      const product = productById.get(requested.productId)!;
      const minimum = requested.skus.reduce(
        (current, sku) => Math.min(current, Number(sku.price)),
        Number.POSITIVE_INFINITY,
      ).toFixed(2);
      let newcomer = existingByProduct.get(requested.productId);
      if (newcomer) {
        const updated = await tx.update(storeNewcomer).set({
          type: product.type,
          productType: product.productType,
          relationId: product.relationId,
          price: minimum,
          otPrice: product.otPrice,
          updateTime: now,
        }).where(eq(storeNewcomer.id, newcomer.id)).returning();
        newcomer = updated[0];
      } else {
        const inserted = await tx.insert(storeNewcomer).values({
          type: product.type,
          productId: product.id,
          productType: product.productType,
          relationId: product.relationId,
          price: minimum,
          otPrice: product.otPrice,
          sales: 0,
          isDel: 0,
          updateTime: 0,
          addTime: now,
        }).returning();
        newcomer = inserted[0];
      }
      if (!newcomer) throw new Error("新人专享商品保存失败");

      const oldActivitySkus = await tx
        .select()
        .from(storeProductAttrValue)
        .where(and(eq(storeProductAttrValue.type, 7), eq(storeProductAttrValue.productId, newcomer.id)))
        .orderBy(asc(storeProductAttrValue.id))
        .for("update");
      const oldUniqueBySuk = new Map(oldActivitySkus.map((sku) => [sku.suk, sku.unique]));
      for (const sku of oldActivitySkus) reserved.add(sku.unique);
      await tx.delete(storeProductAttrValue).where(and(
        eq(storeProductAttrValue.type, 7),
        eq(storeProductAttrValue.productId, newcomer.id),
      ));
      const rows = [];
      for (const requestedSku of requested.skus) {
        const base = baseByProduct.get(requested.productId)!.get(requestedSku.unique)!;
        const unique = oldUniqueBySuk.get(base.suk) || await freshSkuUnique(tx, reserved);
        rows.push(cloneActivitySku(base, newcomer.id, unique, requestedSku.price));
      }
      await tx.insert(storeProductAttrValue).values(rows);
    }

    const selected = new Set(productIds);
    const removed = existingRows.filter((row) => !selected.has(row.productId)).map((row) => row.id);
    if (removed.length) {
      await tx.update(storeNewcomer).set({ isDel: 1, updateTime: now }).where(inArray(storeNewcomer.id, removed));
    }
  }
}
