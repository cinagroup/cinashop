import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import type { Env } from "@/env";
import {
  storeNewcomer,
  storeCouponIssue,
  storeCouponIssueUser,
  storeCouponUser,
  storeOrder,
  storeProduct,
  storeProductAttrValue,
  userBill,
  userMoney,
  user as userTable,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { normalizeConfigScalar, parseConfigInteger } from "@/utils/config";
import {
  SystemConfigService,
  type SystemConfigEnv,
} from "@/services/system/SystemConfigService";
import { DatabaseCacheService } from "@/services/system/DatabaseCacheService";
import { StoreProductService } from "@/services/product/StoreProductService";

const CONFIG_KEYS = [
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

export interface NewcomerEligibilityConfig {
  enabled: boolean;
  priceEnabled: boolean;
  limitEnabled: boolean;
  limitDays: number;
}

export interface FirstOrderDiscountConfig {
  enabled: boolean;
  limitEnabled: boolean;
  limitDays: number;
  /** PHP 先以 scale=2 计算 discount/100，实际只保留整数折扣百分比。 */
  payPercent: number;
  limitCents: number;
}

export interface FirstOrderDiscountQuote {
  eligible: boolean;
  couponExclusive: boolean;
  subtotal: string;
  firstOrderPrice: string;
  payPercent: number;
  discountLimit: string;
}

export interface RegistrationGiftConfig {
  enabled: boolean;
  integral: number;
  /** PHP casts register_give_money to int before crediting the account. */
  moneyUnits: number;
  couponIds: number[];
}

export interface RegistrationState {
  flags: { isFirstOrder: number; isNewcomer: number };
  gifts: RegistrationGiftConfig;
}

export interface RegistrationGiftResult {
  integral: number;
  money: string;
  coupons: number;
}

export function configFlag(value: string | undefined, fallback = false): boolean {
  const normalized = normalizeConfigScalar(value).toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "off", "no", "null"].includes(normalized);
}

export function parseConfigIds(value: string | undefined): number[] {
  const normalized = normalizeConfigScalar(value);
  if (!normalized) return [];
  let candidate: unknown = normalized;
  try {
    candidate = JSON.parse(normalized);
  } catch {
    candidate = normalized.split(",");
  }
  const values = Array.isArray(candidate) ? candidate : [candidate];
  return [...new Set(values.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

export function parseFirstOrderPayPercent(value: string | undefined): number {
  const normalized = normalizeConfigScalar(value) || "100";
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return 100;
  const whole = Number(normalized.split(".")[0]);
  return Number.isSafeInteger(whole) && whole >= 0 && whole <= 100 ? whole : 100;
}

function parseNonNegativeMoneyCents(value: string | undefined): number {
  const normalized = normalizeConfigScalar(value) || "0";
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return 0;
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : 0;
}

export function parseLegacyWholeMoney(value: string | undefined): number {
  const normalized = normalizeConfigScalar(value) || "0";
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return 0;
  const whole = Number(normalized.split(".")[0]);
  return Number.isSafeInteger(whole) && whole >= 0 ? whole : 0;
}

/** 精确复现 PHP BCMath：折扣金额向下截断到分，并受折扣上限约束。 */
export function calculateFirstOrderDiscountCents(
  totalCents: number,
  config: FirstOrderDiscountConfig,
): number {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new Error("首单优惠计价基数无效");
  }
  if (!config.enabled || config.limitCents <= 0 || totalCents === 0) return 0;
  const discountPercent = 100 - config.payPercent;
  const product = totalCents * discountPercent;
  if (!Number.isSafeInteger(product)) throw new Error("首单优惠金额超出安全范围");
  return Math.min(Math.floor(product / 100), config.limitCents, totalCents);
}

/** PHP 按 scale=4 比例分摊，前 N-1 行向下截断到分，最后一行承接余数。 */
export function allocateLegacyDiscountCents(
  discountCents: number,
  grossCents: number[],
): number[] {
  if (!Number.isSafeInteger(discountCents) || discountCents < 0) {
    throw new Error("待分摊优惠金额无效");
  }
  if (grossCents.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
    throw new Error("优惠分摊权重无效");
  }
  if (!grossCents.length) return [];
  const total = grossCents.reduce((sum, amount) => {
    const next = sum + amount;
    if (!Number.isSafeInteger(next)) throw new Error("优惠分摊权重超出安全范围");
    return next;
  }, 0);
  if (discountCents === 0 || total === 0) return grossCents.map(() => 0);
  const boundedDiscount = Math.min(discountCents, total);
  const ratioTenThousandths = Math.floor((boundedDiscount * 10_000) / total);
  const result: number[] = [];
  let allocated = 0;
  for (let index = 0; index < grossCents.length; index++) {
    const amount = index === grossCents.length - 1
      ? boundedDiscount - allocated
      : Math.floor((grossCents[index] * ratioTenThousandths) / 10_000);
    result.push(amount);
    allocated += amount;
  }
  return result;
}

/** Narrow config-only entry used by order creation and integration harnesses. */
export async function loadNewcomerEligibilityConfig(
  container: Container,
  env: SystemConfigEnv,
): Promise<NewcomerEligibilityConfig> {
  const values = await new SystemConfigService(container, env).getMany([
    "newcomer_status",
    "register_price_status",
    "newcomer_limit_status",
    "newcomer_limit_time",
  ]);
  return {
    enabled: configFlag(values.newcomer_status),
    priceEnabled: configFlag(values.register_price_status),
    limitEnabled: configFlag(values.newcomer_limit_status, true),
    limitDays: Math.max(0, parseConfigInteger(values.newcomer_limit_time, 0)),
  };
}

/** PHP StoreNewcomerServices::checkUserFirstDiscount 所需的配置快照。 */
export async function loadFirstOrderDiscountConfig(
  container: Container,
  env: SystemConfigEnv,
): Promise<FirstOrderDiscountConfig> {
  const values = await new SystemConfigService(container, env).getMany([
    "newcomer_status",
    "first_order_status",
    "first_order_discount",
    "first_order_discount_limit",
    "newcomer_limit_status",
    "newcomer_limit_time",
  ]);
  return {
    enabled: configFlag(values.newcomer_status) && configFlag(values.first_order_status),
    limitEnabled: configFlag(values.newcomer_limit_status, true),
    limitDays: Math.max(0, parseConfigInteger(values.newcomer_limit_time, 0)),
    payPercent: parseFirstOrderPayPercent(values.first_order_discount),
    limitCents: parseNonNegativeMoneyCents(values.first_order_discount_limit),
  };
}

/** PHP registration listener configuration, read once before creating the user. */
export async function loadRegistrationState(
  container: Container,
  env: SystemConfigEnv,
): Promise<RegistrationState> {
  const values = await new SystemConfigService(container, env).getMany([
    "newcomer_status",
    "first_order_status",
    "register_price_status",
    "register_integral_status",
    "register_give_integral",
    "register_money_status",
    "register_give_money",
    "register_coupon_status",
    "register_give_coupon",
  ]);
  const enabled = configFlag(values.newcomer_status);
  return {
    flags: enabled
      ? {
          isFirstOrder: configFlag(values.first_order_status) ? 0 : -1,
          isNewcomer: configFlag(values.register_price_status) ? 0 : -1,
        }
      : { isFirstOrder: -1, isNewcomer: -1 },
    gifts: {
      enabled,
      integral: enabled && configFlag(values.register_integral_status)
        ? Math.max(0, parseConfigInteger(values.register_give_integral, 0))
        : 0,
      moneyUnits: enabled && configFlag(values.register_money_status)
        ? parseLegacyWholeMoney(values.register_give_money)
        : 0,
      couponIds: enabled && configFlag(values.register_coupon_status)
        ? parseConfigIds(values.register_give_coupon)
        : [],
    },
  };
}

function registrationCouponUsable(
  issue: typeof storeCouponIssue.$inferSelect,
  now: number,
): boolean {
  const nowMs = now * 1_000;
  const withinIssueWindow = (!issue.startTime && !issue.endTime)
    || Boolean(
      issue.startTime
      && issue.endTime
      && issue.startTime.getTime() <= nowMs
      && issue.endTime.getTime() >= nowMs,
    );
  return issue.status === 1
    && issue.isDel === 0
    && (issue.remainCount > 0 || issue.isPermanent === 1)
    && withinIssueWindow;
}

/**
 * Apply PHP newcomer registration gifts in the caller's user-creation transaction.
 * The new user row, both ledgers, coupon inventory and coupon evidence therefore
 * commit or roll back together instead of relying on lossy post-registration jobs.
 */
export async function applyRegistrationGifts(
  tx: DbClient,
  uid: number,
  config: RegistrationGiftConfig,
  now: number,
): Promise<RegistrationGiftResult> {
  if (!config.enabled) return { integral: 0, money: "0.00", coupons: 0 };
  const users = await tx
    .select({ integral: userTable.integral, nowMoney: userTable.nowMoney })
    .from(userTable)
    .where(eq(userTable.uid, uid))
    .limit(1)
    .for("update");
  const account = users[0];
  if (!account) throw new Error("新人注册账户不存在");

  const nextIntegral = account.integral + config.integral;
  if (!Number.isSafeInteger(nextIntegral)) throw new Error("新人赠送积分超出安全范围");
  const currentMoneyCents = parseNonNegativeMoneyCents(String(account.nowMoney));
  const giftMoneyCents = config.moneyUnits * 100;
  const nextMoneyCents = currentMoneyCents + giftMoneyCents;
  if (!Number.isSafeInteger(giftMoneyCents) || !Number.isSafeInteger(nextMoneyCents)) {
    throw new Error("新人赠送余额超出安全范围");
  }
  const nextMoney = (nextMoneyCents / 100).toFixed(2);

  if (config.integral > 0 || giftMoneyCents > 0) {
    await tx
      .update(userTable)
      .set({
        ...(config.integral > 0 ? { integral: nextIntegral } : {}),
        ...(giftMoneyCents > 0 ? { nowMoney: nextMoney } : {}),
      })
      .where(eq(userTable.uid, uid));
  }
  if (config.integral > 0) {
    await tx.insert(userBill).values({
      uid,
      linkId: "0",
      pm: 1,
      title: "新人礼赠送积分",
      category: "integral",
      type: "newcomer_add",
      eventKey: "newcomer_give_integral",
      number: config.integral.toFixed(2),
      balance: nextIntegral.toFixed(2),
      mark: `新人礼赠送${config.integral}积分`,
      addTime: now,
      status: 1,
    });
  }
  if (giftMoneyCents > 0) {
    await tx.insert(userMoney).values({
      uid,
      linkId: "0",
      type: "newcomer_add",
      title: "新人礼赠送余额",
      number: (giftMoneyCents / 100).toFixed(2),
      balance: nextMoney,
      pm: 1,
      mark: `新人礼赠送${(giftMoneyCents / 100).toFixed(2)}余额`,
      status: 1,
      addTime: now,
    });
  }

  const couponIds = [...new Set(config.couponIds)].sort((left, right) => left - right);
  const issues = couponIds.length
    ? await tx
        .select()
        .from(storeCouponIssue)
        .where(inArray(storeCouponIssue.id, couponIds))
        .orderBy(asc(storeCouponIssue.id))
        .for("update")
    : [];
  let coupons = 0;
  for (const issue of issues) {
    if (!registrationCouponUsable(issue, now)) continue;
    if (issue.isPermanent !== 1) {
      const updated = await tx
        .update(storeCouponIssue)
        .set({ remainCount: sql`${storeCouponIssue.remainCount} - 1` })
        .where(and(eq(storeCouponIssue.id, issue.id), sql`${storeCouponIssue.remainCount} > 0`))
        .returning({ remainCount: storeCouponIssue.remainCount });
      if (!updated[0]) continue;
      issue.remainCount = updated[0].remainCount;
    }
    const rolling = issue.day > 0;
    await tx.insert(storeCouponUser).values({
      uid,
      issueCouponId: issue.id,
      couponTitle: issue.title || issue.couponTitle,
      couponPrice: issue.couponPrice,
      useMinPrice: issue.useMinPrice,
      status: 0,
      startTime: rolling ? new Date(now * 1_000) : issue.useStartTime,
      endTime: rolling ? new Date((now + issue.day * 86_400) * 1_000) : issue.useEndTime,
      useTime: null,
      type: issue.type,
      receiveTime: now,
      receiveSource: "newcomer",
      isFail: 0,
    });
    await tx.insert(storeCouponIssueUser).values({
      uid,
      issueCouponId: issue.id,
      addTime: now,
    });
    coupons++;
  }
  return {
    integral: config.integral,
    money: (giftMoneyCents / 100).toFixed(2),
    coupons,
  };
}

export async function quoteFirstOrderDiscount(
  container: Container,
  env: SystemConfigEnv,
  uid: number,
  totalCents: number,
  now = Math.floor(Date.now() / 1000),
): Promise<FirstOrderDiscountQuote> {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new ValidateException("首单优惠计价基数无效");
  }
  const config = await loadFirstOrderDiscountConfig(container, env);
  const accounts = await container.db
    .select({ addTime: userTable.addTime, isFirstOrder: userTable.isFirstOrder })
    .from(userTable)
    .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
    .limit(1);
  const account = accounts[0];
  let eligible = Boolean(
    config.enabled
    && account
    && account.isFirstOrder === 0
    && !(
      config.limitEnabled
      && config.limitDays > 0
      && account.addTime + config.limitDays * 86_400 < now
    ),
  );
  if (eligible) {
    const paid = await container.db
      .select({ id: storeOrder.id })
      .from(storeOrder)
      .where(and(eq(storeOrder.uid, uid), eq(storeOrder.paid, 1), ne(storeOrder.type, 7)))
      .limit(1);
    eligible = paid.length === 0;
  }
  const firstOrderPriceCents = eligible
    ? calculateFirstOrderDiscountCents(totalCents, config)
    : 0;
  return {
    eligible,
    couponExclusive: eligible,
    subtotal: (totalCents / 100).toFixed(2),
    firstOrderPrice: (firstOrderPriceCents / 100).toFixed(2),
    payPercent: config.payPercent,
    discountLimit: (config.limitCents / 100).toFixed(2),
  };
}

export class StoreNewcomerService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async loadEligibilityConfig(): Promise<NewcomerEligibilityConfig> {
    return loadNewcomerEligibilityConfig(this.container, this.env);
  }

  async registrationFlags(): Promise<{ isFirstOrder: number; isNewcomer: number }> {
    return (await loadRegistrationState(this.container, this.env)).flags;
  }

  async registrationState(): Promise<RegistrationState> {
    return loadRegistrationState(this.container, this.env);
  }

  async isEligible(uid: number, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
    if (!Number.isSafeInteger(uid) || uid <= 0) return false;
    const config = await this.loadEligibilityConfig();
    if (!config.enabled || !config.priceEnabled) return false;
    const rows = await this.container.db
      .select({ addTime: userTable.addTime, isNewcomer: userTable.isNewcomer })
      .from(userTable)
      .where(eq(userTable.uid, uid))
      .limit(1);
    const account = rows[0];
    if (!account || account.isNewcomer !== 0) return false;
    if (config.limitEnabled && config.limitDays > 0 && account.addTime + config.limitDays * 86_400 < now) {
      return false;
    }
    const paid = await this.container.db
      .select({ id: storeOrder.id })
      .from(storeOrder)
      .where(and(eq(storeOrder.uid, uid), eq(storeOrder.type, 7), eq(storeOrder.paid, 1)))
      .limit(1);
    return paid.length === 0;
  }

  async assertEligible(uid: number): Promise<void> {
    if (!(await this.isEligible(uid))) {
      throw new ValidateException("您已无法享受新人专享价");
    }
  }

  async getActive(id: number) {
    const rows = await this.container.db
      .select()
      .from(storeNewcomer)
      .where(and(eq(storeNewcomer.id, id), eq(storeNewcomer.isDel, 0)))
      .limit(1);
    return rows[0] ?? null;
  }

  async resolveCartSku(params: {
    uid: number;
    newcomerId: number;
    productId: number;
    activityUnique?: string;
    quantity: number;
  }) {
    if (params.quantity !== 1) throw new ValidateException("新人专享商品限购一件");
    await this.assertEligible(params.uid);
    const newcomer = await this.getActive(params.newcomerId);
    if (!newcomer) throw new ValidateException("该新人专享商品已下架");
    if (newcomer.productId !== params.productId) throw new ValidateException("新人专享商品与活动不匹配");

    const product = await this.container.storeProductDao.getById(newcomer.productId);
    if (!product || !product.isShow || product.isDel) throw new ValidateException("原商品已下架或删除");

    const activitySku = params.activityUnique
      ? await this.container.storeProductAttrValueDao.getByUnique(
          params.activityUnique,
          7,
          newcomer.id,
        )
      : (await this.container.storeProductAttrValueDao.getByProductId(newcomer.id, 7))[0] ?? null;
    if (!activitySku) throw new ValidateException("请选择有效的新人专享商品属性");
    const baseSku = await this.container.storeProductAttrValueDao.getBySuk(
      newcomer.productId,
      activitySku.suk,
      0,
    );
    if (!baseSku) throw new ValidateException("新人专享规格没有对应的普通商品规格");
    if (baseSku.stock < params.quantity || product.stock < params.quantity) {
      throw new ValidateException("该商品库存不足");
    }
    return { newcomer, product, activitySku, baseSku };
  }

  async list(uid: number, pageInput?: string, limitInput?: string) {
    if (!(await this.isEligible(uid))) return [];
    const page = Math.max(1, Number.parseInt(pageInput ?? "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(limitInput ?? "10", 10) || 10));
    const rows = await this.container.db
      .select({ newcomer: storeNewcomer, product: storeProduct })
      .from(storeNewcomer)
      .innerJoin(storeProduct, eq(storeProduct.id, storeNewcomer.productId))
      .where(
        and(
          eq(storeNewcomer.isDel, 0),
          eq(storeProduct.isDel, 0),
          eq(storeProduct.isShow, 1),
        ),
      )
      .orderBy(asc(storeNewcomer.id))
      .limit(limit)
      .offset((page - 1) * limit);
    return rows.map(({ newcomer, product }) => ({
      id: newcomer.id,
      type: newcomer.type,
      product_id: newcomer.productId,
      relation_id: newcomer.relationId,
      product_type: newcomer.productType,
      price: String(newcomer.price),
      image: product.image,
      store_name: product.storeName,
      stock: product.stock,
      sales: product.sales,
      ot_price: String(newcomer.otPrice || product.otPrice),
    }));
  }

  async detail(uid: number, id: number): Promise<Record<string, unknown>> {
    const newcomer = await this.getActive(id);
    if (!newcomer) throw new NotFoundException("新人商品已下架或删除");
    const base = await new StoreProductService(this.container, this.env)
      .getProductDetail(newcomer.productId, uid);
    const activitySkus = await this.container.db
      .select()
      .from(storeProductAttrValue)
      .where(
        and(
          eq(storeProductAttrValue.productId, newcomer.id),
          eq(storeProductAttrValue.type, 7),
        ),
      )
      .orderBy(asc(storeProductAttrValue.id));
    const baseSkus = await this.container.storeProductAttrValueDao.getByProductId(
      newcomer.productId,
      0,
    );
    const baseStockBySuk = new Map(baseSkus.map((sku) => [sku.suk, sku.stock]));
    const productValue = Object.fromEntries(activitySkus.map((sku) => [sku.unique, {
      id: sku.id,
      unique: sku.unique,
      suk: sku.suk || "默认",
      price: String(sku.price),
      ot_price: String(sku.otPrice),
      stock: baseStockBySuk.get(sku.suk) ?? 0,
      sales: sku.sales,
    }]));
    const buyRows = uid > 0
      ? await this.container.db
          .select({ count: sql<number>`COALESCE(SUM(${storeOrder.totalNum}), 0)::int` })
          .from(storeOrder)
          .where(
            and(
              eq(storeOrder.uid, uid),
              eq(storeOrder.type, 7),
              eq(storeOrder.activityId, newcomer.id),
            ),
          )
      : [];
    return {
      storeInfo: {
        ...base,
        id: newcomer.id,
        product_id: newcomer.productId,
        type: newcomer.type,
        relation_id: newcomer.relationId,
        product_type: newcomer.productType,
        price: String(newcomer.price),
        otPrice: String(newcomer.otPrice),
        sales: newcomer.sales,
        attr_value: Object.values(productValue),
      },
      productAttr: [],
      productValue,
      buy_num: Number(buyRows[0]?.count ?? 0),
    };
  }

  async info(uid: number, giftOnly: boolean): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(uid) || uid <= 0) return {};
    const userRows = await this.container.db
      .select({ addTime: userTable.addTime, lastTime: userTable.lastTime })
      .from(userTable)
      .where(eq(userTable.uid, uid))
      .limit(1);
    const account = userRows[0];
    if (!account) return {};
    if (giftOnly && account.addTime !== account.lastTime) return {};
    if (giftOnly && !(await this.isEligible(uid))) return {};

    const values = await new SystemConfigService(this.container, this.env).getMany([...CONFIG_KEYS]);
    if (!giftOnly && !configFlag(values.newcomer_status)) return {};
    const priceEnabled = configFlag(values.register_price_status);
    const productCountRows = priceEnabled
      ? await this.container.db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(storeNewcomer)
          .where(eq(storeNewcomer.isDel, 0))
      : [];
    const couponIds = configFlag(values.register_coupon_status)
      ? parseConfigIds(values.register_give_coupon)
      : [];
    const coupons = couponIds.length
      ? (await this.container.storeCouponUserDao.listByUid(uid)).filter((coupon) =>
          couponIds.includes(coupon.issueCouponId))
      : [];
    const limitDays = Math.max(0, parseConfigInteger(values.newcomer_limit_time, 0));
    const limitEnabled = configFlag(values.newcomer_limit_status, true);
    const response: Record<string, unknown> = {
      newcomer_limit_status: limitEnabled ? 1 : 0,
      newcomer_limit_time: limitDays,
      register_integral_status: configFlag(values.register_integral_status) ? 1 : 0,
      register_give_integral: configFlag(values.register_integral_status)
        ? Math.max(0, parseConfigInteger(values.register_give_integral, 0))
        : 0,
      register_money_status: configFlag(values.register_money_status) ? 1 : 0,
      register_give_money: configFlag(values.register_money_status)
        ? normalizeConfigScalar(values.register_give_money)
        : "0",
      register_coupon_status: configFlag(values.register_coupon_status) ? 1 : 0,
      register_give_coupon: coupons,
      first_order_status: configFlag(values.first_order_status) ? 1 : 0,
      first_order_discount: configFlag(values.first_order_status)
        ? Math.max(0, parseConfigInteger(values.first_order_discount, 100))
        : 0,
      first_order_discount_limit: normalizeConfigScalar(values.first_order_discount_limit),
      register_price_status: priceEnabled ? 1 : 0,
      product_count: Number(productCountRows[0]?.count ?? 0),
      coupon_count: coupons.length,
      last_time: limitEnabled && limitDays > 0 ? account.addTime + limitDays * 86_400 : 0,
    };
    if (!giftOnly) {
      response.newcomer_agreement = await new DatabaseCacheService(this.container)
        .get("newcomer_agreement", "");
    }
    return response;
  }
}
