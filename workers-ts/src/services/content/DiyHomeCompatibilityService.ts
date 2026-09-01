import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import {
  memberRight,
  storeBargain,
  storeCombination,
  storeCouponIssue,
  storeCouponProduct,
  storeCouponUser,
  storeNewcomer,
  storeOrder,
  storeProduct,
  storeProductLog,
  storeSeckill,
  storeSeckillTime,
  systemDise,
  systemUserLevel,
  user,
  userRelation,
} from "@/models/schema";
import {
  formatLegacyCouponDate,
} from "@/services/activity/V2CouponCompatibilityService";
import {
  legacyConfigEnabledWithPresence,
  ShortVideoService,
} from "@/services/activity/ShortVideoService";
import {
  parseConfigIds,
} from "@/services/activity/StoreNewcomerService";
import { V2PromotionCompatibilityService } from "@/services/activity/V2PromotionCompatibilityService";
import { PublicCatalogService } from "@/services/product/PublicCatalogService";
import {
  createAttachmentImageVariant,
  signAttachmentReferences,
  signAttachmentVariantReferences,
  type AttachmentImageVariant,
} from "@/services/system/AttachmentService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { UserSignCompatibilityService } from "@/services/user/UserSignCompatibilityService";
import { parseConfigInteger } from "@/utils/config";
import { ValidateException } from "@/utils/errors";
import { parseLegacyDiyJson } from "./V2PublicCompatibilityService";

const MAX_PAGE = 1_000_000;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE_OFFSET = 10_000;
const MAX_VIDEO_PAGE_SIZE = 10;
const MAX_RANK_SIZE = 20;
const MAX_ACTIVE_COUPONS = 1_000;

const SUSPENDED_DEFAULT = {
  is_show: 1,
  index: 1,
  shifting: 1,
  main_ago_image: "",
  main_after_image: "",
  button: Array.from({ length: 4 }, () => ({ img: "", url: "" })),
};

type DiyComponent = Record<string, unknown>;

export function legacyMidThumbnailVariant(configs: Record<
  string,
  { exists: boolean; value: string } | undefined
>): AttachmentImageVariant | null {
  if (!legacyConfigEnabledWithPresence(configs.image_thumb_status, false)) return null;
  return createAttachmentImageVariant(
    "mid",
    parseConfigInteger(configs.thumb_mid_width?.value, 0),
    parseConfigInteger(configs.thumb_mid_height?.value, 0),
  );
}

function legacyInteger(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  const match = String(value).trim().match(/^[+-]?\d+/);
  if (!match) return 0;
  const result = Number(match[0]);
  return Number.isSafeInteger(result) && result >= -2_147_483_648 && result <= 2_147_483_647
    ? result
    : 0;
}

function pageInput(
  pageValue: unknown,
  limitValue: unknown,
  defaultLimit: number,
  cap = MAX_PAGE_SIZE,
) {
  const page = legacyInteger(pageValue, 1);
  const limit = legacyInteger(limitValue, defaultLimit);
  const safePage = page > 0 ? Math.min(page, MAX_PAGE) : 1;
  const safeLimit = limit > 0 ? Math.min(limit, cap) : defaultLimit;
  if ((safePage - 1) * safeLimit > MAX_PAGE_OFFSET) {
    throw new ValidateException("分页偏移超过安全上限");
  }
  return { page: safePage, limit: safeLimit };
}

function record(value: unknown): DiyComponent | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as DiyComponent
    : null;
}

function deleteNestedKey(component: DiyComponent, parent: string, key: string): void {
  const nested = record(component[parent]);
  if (nested) delete nested[key];
}

/** PHP's component projection, including the default-home pageFoot omission. */
export function transformLegacyHomeComponents(value: unknown, explicitId: boolean): unknown[] {
  if (!Array.isArray(value)) return [];
  const transformed: unknown[] = [];
  for (const raw of value) {
    const component = record(raw);
    if (!component) continue;
    const name = String(component.name ?? "");
    if (name === "pageFoot" && !explicitId) continue;
    if (name === "promotionList") {
      deleteNestedKey(component, "titleShow", "title");
      deleteNestedKey(component, "opriceShow", "title");
      deleteNestedKey(component, "priceShow", "title");
      deleteNestedKey(component, "couponShow", "title");
    }
    if (name === "activeParty") {
      deleteNestedKey(component, "titleConfig", "place");
      deleteNestedKey(component, "titleConfig", "max");
      deleteNestedKey(component, "desConfig", "place");
      deleteNestedKey(component, "desConfig", "max");
      const menu = record(component.menuConfig);
      const list = record(menu?.list);
      const info = list?.info;
      if (Array.isArray(info)) {
        for (const entry of info) {
          const item = record(entry);
          if (item) {
            delete item.tips;
            delete item.max;
          }
        }
      }
    }
    transformed.push(component);
  }
  return transformed;
}

function csvIds(value: unknown): number[] {
  const source = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(source.map((item) => Number(String(item).trim())).filter((id) => (
    Number.isSafeInteger(id) && id > 0
  )))];
}

function validCouponNow(now: Date) {
  return and(
    eq(storeCouponIssue.status, 1),
    eq(storeCouponIssue.isDel, 0),
    or(gt(storeCouponIssue.remainCount, 0), eq(storeCouponIssue.isPermanent, 1)),
    or(isNull(storeCouponIssue.startTime), lte(storeCouponIssue.startTime, now)),
    or(isNull(storeCouponIssue.endTime), gte(storeCouponIssue.endTime, now)),
    or(gt(storeCouponIssue.day, 0), isNull(storeCouponIssue.useEndTime), gte(storeCouponIssue.useEndTime, now)),
  );
}

function couponMatchesProduct(
  coupon: {
    id: number;
    couponType: number;
    legacyProductIds: string | null;
    productId: string;
    legacyCategoryId: number;
    categoryId: string;
    legacyBrandId: number;
    brandId: string;
  },
  product: Record<string, unknown>,
  related: ReadonlySet<number>,
): boolean {
  if (coupon.couponType === 0) return true;
  const productId = Number(product.id);
  if (coupon.couponType === 2) {
    return related.has(productId)
      || csvIds(coupon.legacyProductIds).includes(productId)
      || csvIds(coupon.productId).includes(productId);
  }
  if (coupon.couponType === 1) {
    const categories = new Set(csvIds(product.cate_id));
    return (coupon.legacyCategoryId > 0 && categories.has(coupon.legacyCategoryId))
      || csvIds(coupon.categoryId).some((id) => categories.has(id));
  }
  if (coupon.couponType === 3) {
    const brandId = Number(product.brand_id ?? 0);
    return brandId > 0 && (
      coupon.legacyBrandId === brandId || csvIds(coupon.brandId).includes(brandId)
    );
  }
  return false;
}

function shanghaiClock(now: Date) {
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  const hhmm = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  const date = local.toISOString().slice(0, 10);
  return { hhmm, date };
}

function activityFor(
  item: Record<string, unknown>,
  activities: Map<number, Map<number, { id: number; time?: number }>>,
): Record<string, unknown> | unknown[] {
  const order = String(item.activity ?? "") || "0,1,2,3";
  const types = order.split(",").map((value) => legacyInteger(value)).filter((value) => value >= 0);
  if (types[0] === 0) return [];
  const productId = Number(item.id);
  const byType = activities.get(productId);
  for (const type of types) {
    const selected = byType?.get(type);
    if (selected) return { type, id: selected.id, ...(selected.time ? { time: selected.time } : {}) };
  }
  return [];
}

function unixSeconds(value: Date | null | undefined): number {
  return value && Number.isFinite(value.getTime()) ? Math.floor(value.getTime() / 1_000) : 0;
}

function legacyCouponProductIds(row: typeof storeCouponIssue.$inferSelect): string {
  return row.legacyProductIds ?? row.productId;
}

function firstLegacyScopeId(value: string): number {
  return csvIds(value)[0] ?? 0;
}

function legacyCouponCategoryId(row: typeof storeCouponIssue.$inferSelect): number {
  return row.legacyCategoryId > 0 ? row.legacyCategoryId : firstLegacyScopeId(row.category_id);
}

function legacyCouponBrandId(row: typeof storeCouponIssue.$inferSelect): number {
  return row.legacyBrandId > 0 ? row.legacyBrandId : firstLegacyScopeId(row.brandId);
}

function legacyMoney(value: string | number): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function slashDateFromUnix(value: number): string {
  return formatLegacyCouponDate(new Date(value * 1_000), "/");
}

const COUPON_USER_STATUS: Record<number, string> = {
  0: "未使用",
  1: "已使用",
  2: "已过期",
};

const COUPON_RECEIVE_SOURCE: Record<string, string> = {
  send: "后台发放",
  get: "手动领取",
  newcomer: "新人礼赠送",
  activate_level: "会员卡激活赠送",
  user_first: "用户注册赠送",
  order: "下单赠送",
  luck_lottery: "抽奖赠送",
};

/** Exact StoreCouponIssue model field contract used for anonymous newcomer coupons. */
export function newcomerCouponIssueProjection(row: typeof storeCouponIssue.$inferSelect) {
  return {
    id: row.id,
    cid: row.cid,
    category: row.category,
    type: row.couponType,
    coupon_title: row.couponTitle,
    coupon_type: row.type,
    // ThinkPHP returns DECIMAL model fields as strings on this unformatted path.
    coupon_price: row.couponPrice,
    use_min_price: row.useMinPrice,
    product_id: legacyCouponProductIds(row),
    category_id: legacyCouponCategoryId(row),
    brand_id: legacyCouponBrandId(row),
    total_count: row.totalCount,
    remain_count: row.remainCount,
    receive_limit: row.receiveLimit,
    receive_type: row.receiveType,
    start_time: unixSeconds(row.startTime),
    end_time: unixSeconds(row.endTime),
    coupon_time: row.day,
    is_permanent: row.isPermanent,
    is_give_subscribe: row.isGiveSubscribe,
    is_full_give: row.isFullGive,
    full_reduction: row.fullReduction,
    is_del: row.isDel,
    title: row.title,
    integral: row.integral,
    start_use_time: unixSeconds(row.useStartTime),
    end_use_time: unixSeconds(row.useEndTime),
    rule: row.rule,
    status: row.status,
    app_type: row.appType,
    sort: row.sort,
    add_time: row.addTime,
  };
}

/** StoreCouponUser accessors + issue bind fields + tidyCouponList. */
export function newcomerCouponUserProjection(
  row: typeof storeCouponUser.$inferSelect,
  issue: typeof storeCouponIssue.$inferSelect | null,
  now = Math.floor(Date.now() / 1_000),
) {
  const startTime = unixSeconds(row.startTime);
  const endTime = unixSeconds(row.endTime);
  const status = COUPON_USER_STATUS[row.status] ?? "";
  let isFail = row.isFail;
  let type = 1;
  let message = "立即使用";
  let pcType = 1;
  let pcMessage = "可使用";
  if (status === "已使用") {
    type = 0;
    message = "已使用";
    pcType = 0;
    pcMessage = "已使用";
  } else if (status === "已过期" || endTime < now) {
    isFail = 1;
    type = 0;
    message = "已过期";
    pcType = 0;
    pcMessage = "已过期";
  } else if (startTime > now) {
    type = 0;
    message = "未开始";
    pcType = 1;
    pcMessage = "未开始";
  } else if (startTime + 86_400 > now) {
    type = 2;
  }

  const addTime = slashDateFromUnix(startTime || row.receiveTime);
  const result: Record<string, unknown> = {
    id: row.id,
    cid: row.issueCouponId,
    uid: row.uid,
    coupon_title: row.couponTitle,
    coupon_price: legacyMoney(row.couponPrice),
    use_min_price: legacyMoney(row.useMinPrice),
    status,
    start_time: addTime,
    end_time: slashDateFromUnix(endTime),
    use_time: unixSeconds(row.useTime),
    type: COUPON_RECEIVE_SOURCE[row.receiveSource] ?? "",
    add_time: addTime,
    is_fail: isFail,
    _type: type,
    _msg: message,
    pc_type: pcType,
    pc_msg: pcMessage,
    _add_time: addTime,
    _end_time: slashDateFromUnix(endTime),
  };
  if (issue) {
    Object.assign(result, {
      applicable_type: issue.couponType,
      coupon_time: issue.day,
      product_id: legacyCouponProductIds(issue),
      category_id: legacyCouponCategoryId(issue),
      brand_id: legacyCouponBrandId(issue),
      receive_type: issue.receiveType,
      coupon_type: issue.type,
      start_use_time: unixSeconds(issue.useStartTime),
      end_use_time: unixSeconds(issue.useEndTime),
      rule: issue.rule,
    });
  }
  return result;
}

export class DiyHomeCompatibilityService {
  private readonly config: SystemConfigService;

  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {
    this.config = new SystemConfigService(container, env);
  }

  async getDiy(idValue: unknown) {
    const id = legacyInteger(idValue);
    const fields = {
      title: systemDise.title,
      value: systemDise.value,
      is_show: systemDise.isShow,
      is_bg_color: systemDise.isBgColor,
      color_picker: systemDise.colorPicker,
      bg_pic: systemDise.bgPic,
      bg_tab_val: systemDise.bgTabVal,
      is_bg_pic: systemDise.isBgPic,
      order_status: systemDise.orderStatus,
    };
    let rows = await this.container.db.select(fields).from(systemDise).where(
      id !== 0
        ? eq(systemDise.id, id)
        : and(eq(systemDise.status, 1), eq(systemDise.type, 1), eq(systemDise.isDiy, 1)),
    ).limit(1);
    if (!rows[0]) {
      rows = await this.container.db.select(fields).from(systemDise)
        .where(eq(systemDise.templateName, "default")).limit(1);
    }
    const row = rows[0];
    if (!row) return [];
    const parsed = parseLegacyDiyJson(row.value);
    const components = transformLegacyHomeComponents(parsed, id !== 0);
    const routineContactType = await this.config.get("routine_contact_type");
    for (const raw of components) {
      const component = record(raw);
      if (component?.name === "customerService") {
        component.routine_contact_type = parseConfigInteger(routineContactType, 0);
      }
    }
    return { ...row, value: components };
  }

  async diyVersion(idValue: unknown): Promise<{ version: string | null }> {
    const id = legacyInteger(idValue);
    const rows = await this.container.db.select({ version: systemDise.version }).from(systemDise).where(
      id !== 0
        ? eq(systemDise.id, id)
        : and(eq(systemDise.status, 1), eq(systemDise.type, 1), eq(systemDise.isDiy, 1)),
    ).limit(1);
    return { version: rows[0]?.version ?? null };
  }

  async userInfo(uid: number) {
    if (!Number.isSafeInteger(uid) || uid <= 0) return [];
    const [rows, levels, configs] = await Promise.all([
      this.container.db.select({
        uid: user.uid,
        nickname: user.nickname,
        phone: user.phone,
        avatar: user.avatar,
        level: user.level,
        integral: user.integral,
        now_money: user.nowMoney,
        exp: user.exp,
        is_money_level: user.isMoneyLevel,
        bar_code: user.barCode,
      }).from(user).where(and(eq(user.uid, uid), eq(user.isDel, 0))).limit(1),
      this.container.db.select({
        id: systemUserLevel.id,
        name: systemUserLevel.name,
        exp_num: systemUserLevel.expNum,
      }).from(systemUserLevel).where(and(
        eq(systemUserLevel.isDel, 0),
        eq(systemUserLevel.isShow, 1),
      )).orderBy(asc(systemUserLevel.grade), asc(systemUserLevel.id)),
      this.container.systemConfigDao.getValuesWithPresence(["video_func_status"]),
    ]);
    const account = rows[0];
    if (!account) return [];
    const now = new Date();
    const category = legacyConfigEnabledWithPresence(configs.video_func_status)
      ? undefined
      : eq(userRelation.category, "product");
    const [couponRows, collectRows, visitRows] = await Promise.all([
      this.container.db.select({ value: sql<number>`COUNT(*)::int` }).from(storeCouponUser).where(and(
        eq(storeCouponUser.uid, uid),
        eq(storeCouponUser.status, 0),
        or(isNull(storeCouponUser.endTime), gte(storeCouponUser.endTime, now)),
      )),
      this.container.db.select({ value: sql<number>`COUNT(*)::int` }).from(userRelation).where(and(
        eq(userRelation.uid, uid),
        eq(userRelation.type, "collect"),
        category,
      )),
      this.container.db.select({ value: sql<number>`COUNT(DISTINCT ${storeProductLog.productId})::int` })
        .from(storeProductLog).where(and(
          eq(storeProductLog.uid, uid),
          eq(storeProductLog.type, "visit"),
        )),
    ]);
    const levelIndex = levels.findIndex((level) => level.id === account.level);
    const currentLevel = levelIndex >= 0 ? levels[levelIndex] : undefined;
    const nextExp = account.level === 0
      ? levels[0]?.exp_num ?? 0
      : currentLevel
        ? levels[levelIndex + 1]?.exp_num ?? currentLevel.exp_num
        : 0;
    return {
      ...account,
      coupon_num: Number(couponRows[0]?.value ?? 0),
      vip_name: currentLevel?.name ?? "",
      next_exp: nextExp,
      collectCount: Number(collectRows[0]?.value ?? 0),
      visit_num: Number(visitRows[0]?.value ?? 0),
    };
  }

  async videoList(uid: number, params: Record<string, string | undefined>) {
    const page = pageInput(params.page, params.limit, MAX_VIDEO_PAGE_SIZE, MAX_VIDEO_PAGE_SIZE);
    const result = await new ShortVideoService(this.container, this.env).listDiy(uid, {
      page: String(page.page),
      limit: String(page.limit),
    });
    return {
      playIds: result.playIds,
      list: result.list.map((item) => ({ ...item, id: Number(item.id) })),
    };
  }

  async newcomerList(uid: number, params: Record<string, string | undefined>) {
    // PHP initializes all three values together; every eligibility early return
    // therefore exposes newcomer_integral as [] rather than the later numeric 0.
    const defaults = { newcomer_products: [], newcomer_integral: [], newcomer_coupon: [] };
    const configs = await this.container.systemConfigDao.getValuesWithPresence([
      "newcomer_status",
      "register_integral_status",
      "register_give_integral",
      "register_coupon_status",
      "register_give_coupon",
      "register_price_status",
      "newcomer_limit_time",
      "newcomer_limit_status",
    ]);
    const enabled = (key: string, missingDefault = false) => (
      legacyConfigEnabledWithPresence(configs[key], missingDefault)
    );
    const value = (key: string) => configs[key]?.value ?? "";
    if (!enabled("newcomer_status")) return defaults;
    let eligible = true;
    if (uid > 0) {
      const accounts = await this.container.db.select({
        addTime: user.addTime,
        isNewcomer: user.isNewcomer,
      }).from(user).where(and(eq(user.uid, uid), eq(user.isDel, 0))).limit(1);
      const account = accounts[0];
      const days = Math.max(0, parseConfigInteger(value("newcomer_limit_time"), 0));
      // sys_config('newcomer_limit_status', 1): absent applies 1, explicit
      // empty/0 remains false. CONFIG_KV cannot distinguish those states.
      const limitEnabled = enabled("newcomer_limit_status", true);
      const timedOut = Boolean(
        limitEnabled
        && days > 0
        && account
        && account.addTime + days * 86_400 < Math.floor(Date.now() / 1_000)
      );
      const paid = account ? await this.container.db.select({ id: storeOrder.id }).from(storeOrder).where(and(
        eq(storeOrder.uid, uid),
        eq(storeOrder.type, 7),
        eq(storeOrder.paid, 1),
      )).limit(1) : [];
      eligible = Boolean(
        enabled("register_price_status")
        && account
        && account.isNewcomer === 0
        && !timedOut
        && paid.length === 0
      );
    }
    if (!eligible) return defaults;

    const paging = pageInput(params.page, params.limit, 10);
    const couponIds = enabled("register_coupon_status")
      ? parseConfigIds(value("register_give_coupon"))
      : [];
    let newcomerCoupon: Record<string, unknown>[] = [];
    if (couponIds.length) {
      if (uid > 0) {
        const rows = await this.container.db.select({
          coupon: storeCouponUser,
          issue: storeCouponIssue,
        }).from(storeCouponUser)
          .leftJoin(storeCouponIssue, eq(storeCouponIssue.id, storeCouponUser.issueCouponId))
          .where(and(
            eq(storeCouponUser.uid, uid),
            inArray(storeCouponUser.issueCouponId, couponIds),
          ))
          .orderBy(desc(storeCouponUser.id))
          .limit(paging.limit)
          .offset((paging.page - 1) * paging.limit);
        newcomerCoupon = rows.map(({ coupon, issue }) => (
          newcomerCouponUserProjection(coupon, issue)
        ));
      } else {
        const rows = await this.container.db.select().from(storeCouponIssue)
          .where(inArray(storeCouponIssue.id, couponIds))
          .orderBy(desc(storeCouponIssue.id))
          .limit(paging.limit)
          .offset((paging.page - 1) * paging.limit);
        newcomerCoupon = rows.map(newcomerCouponIssueProjection);
      }
    }

    let newcomerProducts: Record<string, unknown>[] = [];
    if (enabled("register_price_status")) {
      const orders = [];
      if (params.priceOrder) orders.push(params.priceOrder === "desc" ? desc(storeNewcomer.price) : asc(storeNewcomer.price));
      if (params.salesOrder) orders.push(params.salesOrder === "desc" ? desc(storeNewcomer.sales) : asc(storeNewcomer.sales));
      orders.push(desc(storeNewcomer.id));
      const rows = await this.container.db.select({ newcomer: storeNewcomer, product: storeProduct })
        .from(storeNewcomer)
        .innerJoin(storeProduct, eq(storeProduct.id, storeNewcomer.productId))
        .where(and(
          eq(storeNewcomer.isDel, 0),
          eq(storeProduct.isShow, 1),
          eq(storeProduct.isDel, 0),
          eq(storeProduct.isVerify, 1),
        ))
        .orderBy(...orders)
        .limit(paging.limit)
        .offset((paging.page - 1) * paging.limit);
      newcomerProducts = rows.map(({ newcomer, product }) => ({
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
        ot_price: String(product.otPrice),
      }));
    }
    return {
      newcomer_products: newcomerProducts,
      newcomer_integral: enabled("register_integral_status")
        ? Math.max(0, parseConfigInteger(value("register_give_integral"), 0))
        : 0,
      newcomer_coupon: newcomerCoupon,
    };
  }

  private async rankDecorations(list: Record<string, unknown>[]) {
    if (!list.length) return [];
    const productIds = [...new Set(list.map((item) => Number(item.id)).filter((id) => id > 0))];
    const now = new Date();
    const [promoted, coupons, couponProducts, seckill, seckillTimes, combination, bargain, configs, vipRights] = await Promise.all([
      new V2PromotionCompatibilityService(this.container, this.env).decorateCatalogProducts(list),
      this.container.db.select({
        id: storeCouponIssue.id,
        couponType: storeCouponIssue.couponType,
        legacyProductIds: storeCouponIssue.legacyProductIds,
        productId: storeCouponIssue.productId,
        legacyCategoryId: storeCouponIssue.legacyCategoryId,
        categoryId: storeCouponIssue.category_id,
        legacyBrandId: storeCouponIssue.legacyBrandId,
        brandId: storeCouponIssue.brandId,
      }).from(storeCouponIssue).where(validCouponNow(now)).limit(MAX_ACTIVE_COUPONS + 1),
      this.container.db.select({
        couponId: storeCouponProduct.couponId,
        productId: storeCouponProduct.productId,
      }).from(storeCouponProduct).where(inArray(storeCouponProduct.productId, productIds)),
      this.container.db.select({ id: storeSeckill.id, productId: storeSeckill.productId, timeId: storeSeckill.timeId })
        .from(storeSeckill).where(and(
          inArray(storeSeckill.productId, productIds),
          eq(storeSeckill.status, 1),
          eq(storeSeckill.isShow, 1),
          eq(storeSeckill.isDel, 0),
          or(isNull(storeSeckill.startTime), lte(storeSeckill.startTime, now)),
          or(isNull(storeSeckill.stopTime), gte(storeSeckill.stopTime, now)),
        )),
      this.container.db.select().from(storeSeckillTime).where(eq(storeSeckillTime.status, 1)),
      this.container.db.select({ id: storeCombination.id, productId: storeCombination.productId })
        .from(storeCombination).where(and(
          inArray(storeCombination.productId, productIds),
          eq(storeCombination.status, 1),
          eq(storeCombination.isShow, 1),
          eq(storeCombination.isDel, 0),
          or(isNull(storeCombination.startTime), lte(storeCombination.startTime, now)),
          or(isNull(storeCombination.stopTime), gte(storeCombination.stopTime, now)),
        )),
      this.container.db.select({ id: storeBargain.id, productId: storeBargain.productId })
        .from(storeBargain).where(and(
          inArray(storeBargain.productId, productIds),
          eq(storeBargain.status, 1),
          eq(storeBargain.isDel, 0),
          or(isNull(storeBargain.startTime), lte(storeBargain.startTime, now)),
          or(isNull(storeBargain.stopTime), gte(storeBargain.stopTime, now)),
        )),
      this.container.systemConfigDao.getValuesWithPresence([
        "member_card_status",
        "svip_price_status",
        "image_thumb_status",
        "thumb_mid_width",
        "thumb_mid_height",
      ]),
      this.container.db.select({ status: memberRight.status }).from(memberRight)
        .where(eq(memberRight.rightType, "vip_price"))
        .orderBy(asc(memberRight.id))
        .limit(1),
    ]);
    if (coupons.length > MAX_ACTIVE_COUPONS) {
      throw new ValidateException("有效优惠券数量超过首页安全上限");
    }
    const related = new Map<number, Set<number>>();
    for (const row of couponProducts) {
      const set = related.get(row.couponId) ?? new Set<number>();
      set.add(row.productId);
      related.set(row.couponId, set);
    }
    const activities = new Map<number, Map<number, { id: number; time?: number }>>();
    const setActivity = (productId: number, type: number, value: { id: number; time?: number }) => {
      const byType = activities.get(productId) ?? new Map<number, { id: number; time?: number }>();
      if (!byType.has(type)) byType.set(type, value);
      activities.set(productId, byType);
    };
    const clock = shanghaiClock(now);
    const timeById = new Map(seckillTimes.map((row) => [row.id, row]));
    for (const row of seckill) {
      for (const timeId of csvIds(row.timeId)) {
        const slot = timeById.get(timeId);
        if (!slot || clock.hhmm < slot.startTime || clock.hhmm >= slot.endTime) continue;
        const end = Math.floor(new Date(`${clock.date}T${slot.endTime}:00+08:00`).getTime() / 1_000);
        setActivity(row.productId, 1, { id: row.id, time: end });
        break;
      }
    }
    for (const row of bargain) setActivity(row.productId, 2, { id: row.id });
    for (const row of combination) setActivity(row.productId, 3, { id: row.id });
    const vipEnabled = legacyConfigEnabledWithPresence(configs.member_card_status)
      && legacyConfigEnabledWithPresence(configs.svip_price_status)
      && vipRights[0]?.status === 1;
    const decorated = promoted.map((item) => {
      const checkCoupon = coupons.some((coupon) => couponMatchesProduct(
        coupon,
        item,
        related.get(coupon.id) ?? new Set<number>(),
      ));
      return {
        ...item,
        product_id: Number(item.id),
        activity: activityFor(item, activities),
        checkCoupon,
        promotions: item.promotions ?? [],
        activity_frame: item.activity_frame ?? [],
        activity_background: item.activity_background ?? [],
        ...(!vipEnabled ? { vip_price: 0 } : {}),
      };
    });
    const images = decorated.map((item) => {
      const image = (item as Record<string, unknown>).image;
      return typeof image === "string" ? image : "";
    });
    const thumbnail = legacyMidThumbnailVariant(configs);
    const signedImages = thumbnail
      ? await signAttachmentVariantReferences(this.env.APP_KEY, images, thumbnail)
      : await signAttachmentReferences(this.env.APP_KEY, images);
    return decorated.map((item, index) => ({ ...item, image: signedImages[index] }));
  }

  async productRank(uid: number, limitValue: unknown) {
    const raw = limitValue === undefined || limitValue === null || limitValue === ""
      ? 3
      : legacyInteger(limitValue, 0);
    if (raw < 1 || raw > MAX_RANK_SIZE) throw new ValidateException("排行榜数量参数错误");
    const catalog = new PublicCatalogService(this.container, this.env);
    const [sales, star, collect] = await Promise.all([
      catalog.recommend(uid, { rank: "sales", limit: raw }),
      catalog.recommend(uid, { rank: "star", limit: raw }),
      catalog.recommend(uid, { rank: "collect", limit: raw }),
    ]);
    const lengths = [sales.length, star.length, collect.length];
    const decorated = await this.rankDecorations([...sales, ...star, ...collect]);
    const first = lengths[0];
    const second = first + lengths[1];
    return {
      sales: decorated.slice(0, first),
      star: decorated.slice(first, second),
      collect: decorated.slice(second),
    };
  }

  async homeSign(uid: number) {
    return new UserSignCompatibilityService(this.container).homeDiy(uid);
  }

  async suspended() {
    const rows = await this.container.db.select({ value: systemDise.value }).from(systemDise).where(and(
      eq(systemDise.templateName, "suspended_window"),
      eq(systemDise.type, 3),
    )).limit(1);
    const result: Record<string, unknown> = {
      ...SUSPENDED_DEFAULT,
      button: SUSPENDED_DEFAULT.button.map((item) => ({ ...item })),
    };
    const saved = record(parseLegacyDiyJson(rows[0]?.value));
    if (!saved) return result;
    for (const key of Object.keys(result)) {
      if (Object.hasOwn(saved, key)) result[key] = saved[key];
    }
    return result;
  }
}
