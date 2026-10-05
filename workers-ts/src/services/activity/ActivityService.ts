/**
 * 营销活动 Service (M5)
 * 优惠券领取 + 秒杀/拼团/砍价/积分商城只读列表
 *
 * 对应 PHP:
 *   - StoreCouponIssueServices (getIssueCouponList + issueUserCoupon)
 *   - StoreSeckillServices (lst/detail)
 *   - StoreCombinationServices (lst/detail)
 *   - StoreBargainServices (lst/detail)
 *   - StoreIntegralServices (lst/detail)
 */
import { eq, and, desc, sql } from "drizzle-orm";
import {
  legacyCategory,
  storeActivity,
  storeCouponIssue,
  storeCouponIssueUser,
  storeCouponUser,
  storeIntegral,
  storeOrder,
  storeOrderCartInfo,
  storeOrderStatus,
  storeProduct,
  storeProductAttrResult,
  storeProductAttrValue,
  userBill,
  user as userTable,
} from "@/models/schema";
import type { Env } from "@/env";
import { withTx,createContainerFromDb, type Container, type DbClient } from "@/lib/di";
import type { DB } from "@/dao/BaseDao";
import { ValidateException, NotFoundException } from "@/utils/errors";
import {
  collectOrderSystemForm,
  loadOrderSystemFormSubmission,
} from "@/services/order/OrderSystemFormService";
import { enqueueOrderPaidEvent } from "@/services/order/OrderOutboxService";
import { signAttachmentReferences } from "@/services/system/AttachmentService";
import { PublicCatalogService } from "@/services/product/PublicCatalogService";
import { renderPublishedArticleMediaReferences } from '@/services/content/ArticleContentPolicy';
import { readSeckillScheduleSlots, seckillDayStart, seckillScheduleView, seckillSlotMinutes } from "./SeckillScheduleService";
import { publicSeckillTimePictures, renderSeckillTimePictures } from './SeckillTimeAssetPolicy';
import { publicProductPictures, renderProductPictures } from './ProductAssetPolicy';
import { resolveLegacyActivitySkuPair } from './ActivityOrderSkuService';
import { MEMBER_SAVINGS_VERSION } from '@/services/order/OrderMembershipSavings';
import { IntegralProductReadService } from './IntegralProductReadService';
import { readActivityDetailDesign,renderActivityDetailDesign } from '@/services/product/ProductDetailDesignData';
import { themeDeadlines } from '@/services/content/ThemeReadService';

function normalizeListPage(pageValue: unknown, limitValue: unknown): { page: number; limit: number } {
  const parsedPage = Number(pageValue);
  const parsedLimit = Number(limitValue);
  const limit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50) : 10;
  const maximumPage = Math.floor(10_000 / limit) + 1;
  return {
    page: Number.isSafeInteger(parsedPage) && parsedPage > 0 ? Math.min(parsedPage, maximumPage) : 1,
    limit,
  };
}

function progress(quota: number, quotaShow: number): number {
  if (quota <= 0 || quotaShow <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round(((quotaShow - quota) / quotaShow) * 1_000) / 10));
}
/** Explicit activity display projection; accounting/codes/forms are never
 * returned by a detail endpoint simply because its DAO supports whole rows. */
function safeActivityRow(item:Record<string,unknown>){
  const keys=['id','type','relationId','productId','productType','storeName','title','info','image','images','price','minPrice','otPrice','unitName','sales','stock','quota','quotaShow','num','onceNum','people','isShow','isDel','status','startTime','stopTime','activityId','deliveryType','specType','brandId','isLimit','limitType','limitNum'];
  return Object.fromEntries(keys.filter(key=>Object.hasOwn(item,key)).map(key=>[key,item[key]]));
}

const MAX_INTEGRAL_CATEGORY_ROWS = 1_000;

export interface IntegralListQuery {
  storeName?: unknown;
  priceOrder?: unknown;
  salesOrder?: unknown;
  range?: unknown;
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, maximum)
    : "";
}

function safePublicAsset(value: unknown): string {
  const text = boundedText(value, 2_048);
  if (!text) return "";
  if (/^\/(?!\/)/u.test(text)) return text;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function safeIntegralBannerLink(value: unknown): string {
  const text = boundedText(value, 2_048);
  if (!text) return "";
  if (/^\/(?!\/)/u.test(text)) return text;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.toString() : "";
  } catch {
    return "";
  }
}

export function parseIntegralRange(value: unknown): { minimum: number; maximum: number } | undefined {
  const text = boundedText(value, 64);
  const match = /^(\d+)\s*-\s*(\d+)$/u.exec(text);
  if (!match) return undefined;
  const minimum = Number(match[1]);
  const maximum = Number(match[2]);
  if (
    !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) ||
    minimum < 0 || maximum < 0 || maximum > 2_147_483_647
  ) {
    return undefined;
  }
  return { minimum, maximum };
}

function legacyOrder(value: unknown): "asc" | "desc" | undefined {
  const normalized = boundedText(value, 16).toLowerCase();
  return normalized === "asc" || normalized === "desc" ? normalized : undefined;
}

export class ActivityService {
  constructor(
    private readonly container: Container,
    private readonly env?: Env,
  ) {}

  // ─── 优惠券 ───────────────────────────────────────────────

  /** 可领取列表 */
  async couponList() {
    return this.container.storeCouponIssueDao.getIssueList();
  }

  /**
   * 领取优惠券 (对应 PHP issueUserCoupon)
   *
   * 逻辑:
   *   1. 校验优惠券存在 + 在有效期
   *   2. 校验剩余量 > 0
   *   3. 校验未超限领 (receiveLimit)
   *   4. 事务: 扣 remainCount + 插入 user_coupon
   */
  async receiveCoupon(uid: number, issueId: number): Promise<{ couponUserId: number }> {
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(issueId) || issueId <= 0) {
      throw new ValidateException("优惠券领取参数错误");
    }
    const result = await withTx(this.container, async (tx) => {
      // 同一模板的领取串行化，使“限领计数 + 扣库存 + 发券”成为一个判定。
      const issueRows = await tx
        .select()
        .from(storeCouponIssue)
        .where(eq(storeCouponIssue.id, issueId))
        .limit(1)
        .for("update");
      const issue = issueRows[0];
      if (!issue || issue.status !== 1 || issue.isDel !== 0) {
        throw new NotFoundException("优惠券不存在或已停发");
      }

      // Public self-claim is a manual-coupon operation. Hidden gift/newcomer
      // catalogs are not an authority check; callers can submit any issue ID.
      // Trusted registration/product grants have their own transaction paths.
      // Member/popup coupons stay closed until genuine entitlement is checked.
      // Ordinary PHP issuers use category=1; new canonical issuers use 0.
      // Neither value grants paid membership or a trusted delivery capability.
      if (issue.receiveType !== 1 || ![0, 1].includes(issue.category) || issue.appType !== 0) {
        throw new ValidateException("该优惠券不允许手动领取");
      }

      const now = new Date();
      if (issue.startTime && issue.startTime > now) throw new ValidateException("优惠券未开始");
      if (issue.endTime && issue.endTime < now) throw new ValidateException("优惠券已结束");
      if (!issue.isPermanent && issue.remainCount <= 0) {
        throw new ValidateException("优惠券已领完");
      }

      const receivedRows = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeCouponUser)
        .where(and(eq(storeCouponUser.uid, uid), eq(storeCouponUser.issueCouponId, issueId)));
      const received = receivedRows[0]?.count ?? 0;
      if (issue.receiveLimit < 0) throw new ValidateException('优惠券限领配置无效');
      // PHP's public controller always passes more=false. A legacy default 0
      // is not permission for unlimited direct claims. Preserve issue evidence
      // even if its owned coupon was later removed; do not join duplicate logs.
      const effectiveLimit = issue.receiveLimit || 1;
      const [evidence] = issue.receiveLimit === 0 ? await tx
        .select({ count: sql<number>`COUNT(*)::int` }).from(storeCouponIssueUser)
        .where(and(eq(storeCouponIssueUser.uid, uid), eq(storeCouponIssueUser.issueCouponId, issueId))) : [];
      if (received >= effectiveLimit || (issue.receiveLimit === 0 && (evidence?.count ?? 0) > 0)) {
        throw new ValidateException(`每人限领 ${effectiveLimit} 张`);
      }

      if (!issue.isPermanent) {
        const updated = await tx
          .update(storeCouponIssue)
          .set({ remainCount: sql`${storeCouponIssue.remainCount} - 1` })
          .where(and(eq(storeCouponIssue.id, issueId), sql`${storeCouponIssue.remainCount} > 0`))
          .returning({ id: storeCouponIssue.id });
        if (!updated[0]) throw new ValidateException("优惠券已领完");
      }

      let startTime = now;
      let endTime: Date;
      if (issue.day > 0) {
        endTime = new Date(now.getTime() + issue.day * 86_400_000);
      } else {
        if (!issue.useEndTime) throw new ValidateException("优惠券固定有效期未配置");
        if (!Number.isFinite(issue.useEndTime.getTime()) || issue.useEndTime < now) throw new ValidateException("优惠券固定使用期已过期");
        startTime = issue.useStartTime ?? now;
        endTime = issue.useEndTime;
      }
      const couponRows = await tx
        .insert(storeCouponUser)
        .values({
          uid,
          issueCouponId: issueId,
          couponTitle: issue.couponTitle || issue.title,
          couponPrice: issue.couponPrice,
          useMinPrice: issue.useMinPrice,
          status: 0,
          startTime,
          endTime,
          type: issue.type,
          receiveTime: Math.floor(now.getTime() / 1000),
          receiveSource: "get",
          isFail: 0,
        })
        .returning();
      await tx.insert(storeCouponIssueUser).values({
        uid,
        issueCouponId: issueId,
        addTime: Math.floor(now.getTime() / 1000),
      });
      return couponRows;
    });

    const couponUser = result[0];
    if (!couponUser) throw new Error("优惠券领取失败");
    return { couponUserId: couponUser.id };
  }

  /** 用户优惠券列表 (0未用 1已用 2过期) */
  async myCoupons(uid: number, status?: number) {
    return this.container.storeCouponUserDao.listByUid(uid, status);
  }

  // ─── 秒杀 ─────────────────────────────────────────────────

  /** 秒杀时间段列表 */
  async seckillTimes(now = new Date()) {
    const [times, configs] = await Promise.all([
      this.container.storeSeckillTimeDao.getAll(),
      this.container.systemConfigDao.getValues(["seckill_header_banner", "site_url"]),
    ]);
    if (times.length > 1000) throw new ValidateException("秒杀时段超过1000项，请先整理配置");
    const dayStart = seckillDayStart(now), minute = (now.getTime() - dayStart) / 60000;
    const format = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const ordered = times.map(item => {
      try {
        const start = seckillSlotMinutes(item.startTime), end = seckillSlotMinutes(item.endTime, true);
        if (start >= end) throw new ValidateException("秒杀时段配置无效");
        return { item, start, end };
      } catch (error) {
        if (!(error instanceof ValidateException)) throw error;
        return { item, start: Infinity, end: Infinity };
      }
    }).sort((a, b) => a.start - b.start || a.item.id - b.item.id);
    const slotPictures = await renderSeckillTimePictures(this.env?.APP_KEY,
      await publicSeckillTimePictures(this.container.db, ordered.map(({ item }) => item.pic)));
    const seckillTime = ordered.map(({ item, start, end }, index) => {
      const valid = Number.isFinite(start), active = valid && minute >= start && minute < end;
      const upcoming = valid && minute < start;
      return {
        id: item.id,
        title: item.title,
        pic: slotPictures[index] ?? '',
        describe: item.describe,
        start_time: valid ? format(start) : "",
        end_time: valid ? format(end) : "",
        status: active ? 1 : upcoming ? 2 : 0,
        state: !valid ? "配置不可用" : active ? "疯抢中" : upcoming ? "即将开始" : "已结束",
        time: valid ? format(start) : "",
        stop: valid ? Math.floor((dayStart + end * 60000) / 1000) : 0,
        add_time: item.addTime,
      };
    });
    let activeIndex = seckillTime.findIndex((item) => item.status === 1);
    if (activeIndex === -1) activeIndex = seckillTime.findIndex((item) => item.status === 2);
    const banner = String(configs.seckill_header_banner ?? "").trim().replaceAll("\\", "/");
    const siteUrl = String(configs.site_url ?? "").trim().replace(/\/$/, "");
    const lovely = banner && !/^https?:\/\//i.test(banner) && siteUrl
      ? `${siteUrl}/${banner.replace(/^\/+/, "")}`
      : banner;
    return { lovely, seckillTime, seckillTimeIndex: activeIndex };
  }

  /** 按时间段取秒杀商品 */
  async seckillList(timeId: string, pageValue?: unknown, limitValue?: unknown) {
    const { page, limit } = normalizeListPage(pageValue, limitValue);
    const rows = await this.container.storeSeckillDao.getByTimeId(timeId, page, limit);
    const images = await renderProductPictures(this.env?.APP_KEY,
      await publicProductPictures(this.container.db, rows.map(item => ({ image: item.image, type: item.type, relationId: item.relationId }))));
    return rows.map((item, index) => ({
      id: item.id,
      product_id: item.productId,
      activity_id: item.activityId,
      title: item.storeName,
      image: images[index] ?? '',
      price: Number(item.price),
      ot_price: Number(item.otPrice),
      quota: item.quota,
      quota_show: item.quotaShow,
      freight: item.freight,
      stock: Math.max(0, item.quota),
      store_label_id: item.storeLabelId ?? "",
      store_label: [],
      brand_name: "",
      percent: progress(item.quota, item.quotaShow),
      discount_num: Number(item.otPrice) > 0
        ? Math.round((Number(item.price) / Number(item.otPrice)) * 100) / 10
        : 10,
      activity_image: "",
    }));
  }

  /** 秒杀详情 */
  async seckillDetail(id: number, now = new Date()) {
    const result=await withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(tx);return new ActivityService(createContainerFromDb(tx),this.env).seckillDetailSnapshot(id,now);});
    return {...result.item,...await renderActivityDetailDesign(this.env?.APP_KEY,result.design)};
  }
  private async seckillDetailSnapshot(id:number,now:Date){
    const item = await this.container.storeSeckillDao.getById(id);
    if (!item||item.isDel!==0||item.isShow!==1||item.status!==1) throw new NotFoundException("秒杀商品不存在");
    const activity = item.activityId > 0
      ? (
          await this.container.db
            .select()
            .from(storeActivity)
            .where(eq(storeActivity.id, item.activityId))
            .limit(1)
        )[0] ?? null
      : null;
    // 库存进度
    const percent = item.quotaShow > 0
      ? Math.round(((item.quotaShow - item.quota) / item.quotaShow) * 100)
      : 0;
    const schedule = await readSeckillScheduleSlots(this.container.db, item, activity);
    return {item:{...safeActivityRow(item),activity,percent,schedule:seckillScheduleView(schedule,now)},design:await readActivityDetailDesign(this.container.db,item,1,0)};
  }

  // ─── 拼团 ─────────────────────────────────────────────────

  async combinationList(pageValue?: unknown, limitValue?: unknown) {
    const { page, limit } = normalizeListPage(pageValue, limitValue);
    const rows = await this.container.storeCombinationDao.list(page, limit);
    return rows.map((item) => ({
      id: item.id,
      title: item.storeName,
      image: item.image,
      price: Number(item.price),
      product_id: item.productId,
      people: item.people,
      quota: item.quota,
      quota_show: item.quotaShow,
      stock: item.stock,
      product_price: Number(item.otPrice),
      ot_price: Number(item.otPrice),
      pink_count: Math.max(0, item.quotaShow - item.quota),
      brand_name: "",
    }));
  }

  async combinationDetail(id: number) {
    const result=await withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(tx);
      const item=await createContainerFromDb(tx).storeCombinationDao.getById(id);
      if(!item||item.isDel!==0||item.isShow!==1||item.status!==1)throw new NotFoundException('拼团商品不存在');
      return {item:safeActivityRow(item),design:await readActivityDetailDesign(tx,item,3,0)};});
    return {...result.item,...await renderActivityDetailDesign(this.env?.APP_KEY,result.design)};
  }

  // ─── 砍价 ─────────────────────────────────────────────────

  async bargainList(pageValue?: unknown, limitValue?: unknown) {
    const { page, limit } = normalizeListPage(pageValue, limitValue);
    const rows = await this.container.storeBargainDao.list(page, limit);
    const images = await renderPublishedArticleMediaReferences(this.env?.APP_KEY,rows.map(item=>item.image));
    return rows.map((item,index) => ({
      id: item.id,
      type: item.type,
      relation_id: item.relationId,
      product_id: item.productId,
      product_type: item.productType,
      price: Number(item.price),
      min_price: Number(item.minPrice),
      ot_price: Number(item.price),
      image: images[index] ?? '',
      title: item.title || item.storeName,
      info: item.info,
      sales: item.sales,
      stock: item.stock,
      people: item.people,
      brand_name: "",
    }));
  }

  async bargainDetail(id: number) {
    const item = await this.container.storeBargainDao.getById(id);
    if (!item) throw new NotFoundException("砍价商品不存在");
    return item;
  }

  // ─── 积分商城 ─────────────────────────────────────────────

  private async signIntegralAssets(references: string[]): Promise<string[]> {
    const safe = references.map(safePublicAsset);
    return this.env?.APP_KEY ? signAttachmentReferences(this.env.APP_KEY, safe) : safe;
  }

  async integralList(
    pageValue: unknown = 1,
    limitValue: unknown = 10,
    query: IntegralListQuery = {},
    isHost = false,
  ) {
    const { page, limit } = normalizeListPage(pageValue, limitValue);
    const rows = await this.container.storeIntegralDao.list(page, limit, {
      storeName: boundedText(query.storeName, 100) || undefined,
      priceOrder: legacyOrder(query.priceOrder),
      salesOrder: legacyOrder(query.salesOrder),
      range: parseIntegralRange(query.range),
      isHost,
    });
    const images = await this.signIntegralAssets(rows.map((item) => item.image));
    return rows.map((item, index) => ({
      id: item.id,
      product_id: item.productId,
      image: images[index] ?? "",
      title: item.storeName,
      integral: item.integral,
      price: Number(item.price),
      sales: item.sales,
      stock: item.stock,
      brand_name: item.brandName ?? "",
    }));
  }

  async integralHome(uid: number, pageValue: unknown = 1, limitValue: unknown = 10) {
    if (!this.env) throw new Error("积分商城兼容服务缺少运行环境");
    const catalog = new PublicCatalogService(this.container, this.env);
    const [groups, list, users] = await Promise.all([
      catalog.groupDataMany(["integral_shop_banner"]),
      this.integralList(pageValue, limitValue, {}, true),
      uid > 0
        ? this.container.db
            .select({ integral: userTable.integral })
            .from(userTable)
            .where(eq(userTable.uid, uid))
            .limit(1)
        : Promise.resolve([]),
    ]);
    const rawBanner = groups.integral_shop_banner ?? [];
    const bannerImages = await this.signIntegralAssets(
      rawBanner.map((item) => safePublicAsset(item.img ?? item.image)),
    );
    const banner = rawBanner.map((item, index) => ({
      ...item,
      ...(Object.hasOwn(item, "img") || !Object.hasOwn(item, "image")
        ? { img: bannerImages[index] ?? "" }
        : { image: bannerImages[index] ?? "" }),
      ...(Object.hasOwn(item, "comment") ? { comment: boundedText(item.comment, 500) } : {}),
      ...(Object.hasOwn(item, "link") ? { link: safeIntegralBannerLink(item.link) } : {}),
    }));
    return {
      banner,
      list,
      integral: Number(users[0]?.integral ?? 0),
    };
  }

  async integralCategories() {
    const rows = await this.container.db
      .select({
        name: legacyCategory.name,
        integralMin: legacyCategory.integralMin,
        integralMax: legacyCategory.integralMax,
      })
      .from(legacyCategory)
      .where(and(eq(legacyCategory.isShow, 1), eq(legacyCategory.group, 5)))
      .orderBy(desc(legacyCategory.sort), desc(legacyCategory.id))
      .limit(MAX_INTEGRAL_CATEGORY_ROWS + 1);
    if (rows.length > MAX_INTEGRAL_CATEGORY_ROWS) {
      throw new ValidateException("积分分类超过安全上限");
    }
    return rows.map((item) => ({
      label: boundedText(item.name, 255),
      value: `${item.integralMin}-${item.integralMax}`,
    }));
  }

  async integralDetail(id: number) {
    return new IntegralProductReadService(this.container, this.env).read(id);
  }

  /** 积分兑换 (store_integral/exchange/:id): 扣积分 + 建积分订单 + 减库存 */
  async exchange(
    uid: number,
    integralId: number,
    num = 1,
    requestedUnique = "",
    requestKey = "",
    customForm?: unknown,
  ): Promise<{ orderId: string }> {
    const c = this.container;
    if (!Number.isSafeInteger(num) || num <= 0) {
      throw new ValidateException("兑换数量必须是大于 0 的整数");
    }

    const item = await this.container.storeIntegralDao.getById(integralId);
    if (!item) throw new NotFoundException("积分商品不存在");
    const now = Math.floor(Date.now() / 1000);
    const random = crypto.randomUUID().replaceAll("-", "");
    const orderId = `jy${now}${random.slice(0, 12)}`;
    const normalizedRequestKey = requestKey.trim();
    if (normalizedRequestKey.length > 128) throw new ValidateException("幂等键过长");
    const keyMaterial = normalizedRequestKey || random;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${uid}:${integralId}:${keyMaterial}`),
    );
    const keyHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
    const idempotencyKey = `ix:${integralId}:${keyHash}`;
    const skuUnique = requestedUnique.trim();
    const assertReplay = async (db: DbClient, existingOrder: Pick<typeof storeOrder.$inferSelect, 'id' | 'type' | 'activityId' | 'totalNum'>) => {
      if (existingOrder.type !== 4 || existingOrder.activityId !== integralId || existingOrder.totalNum !== num) {
        throw new ValidateException('幂等键已用于其他兑换请求');
      }
      if (skuUnique) {
        const lines = await db.select({ cartInfo: storeOrderCartInfo.cartInfo }).from(storeOrderCartInfo)
          .where(eq(storeOrderCartInfo.oid, existingOrder.id)).limit(2);
        let snapshot: { sku?: { unique?: unknown }; activitySku?: { unique?: unknown } } = {};
        try { if (lines.length === 1) snapshot = JSON.parse(lines[0].cartInfo ?? '{}'); } catch { /* Replays cannot repair history. */ }
        if (![snapshot?.sku?.unique, snapshot?.activitySku?.unique].some(value => typeof value === 'string' && value.trimEnd() === skuUnique)) {
          throw new ValidateException('幂等键已用于其他积分商品规格');
        }
      }
    };
    const existing = await c.storeOrderDao.findByUnique(uid, idempotencyKey);
    if (existing) {
      await assertReplay(c.db, existing);
      return { orderId: existing.orderId };
    }
    if (item.status !== 1 || item.isShow !== 1 || item.isDel !== 0) {
      throw new ValidateException("积分商品已下架");
    }
    if (item.stock < num) throw new ValidateException("库存不足");
    if (item.onceNum > 0 && num > item.onceNum) {
      throw new ValidateException(`每个订单限购 ${item.onceNum} 件`);
    }
    // The direct endpoint cannot complete a third-party cash payment. Never
    // mark a cash/postage-bearing order paid and give the goods away.
    if (Number(item.postage) !== 0) {
      throw new ValidateException("积分加现金或运费商品请走统一购物车下单流程");
    }
    // The legacy direct endpoint has no receiver/address contract. Keep it
    // only for the two product types that the unified order flow also treats
    // as non-shipping goods; every physical/other fulfillment type must use
    // the cart/order flow so address and delivery validation cannot be skipped.
    if (![1, 2].includes(item.productType)) {
      throw new ValidateException("该积分商品请走统一购物车下单流程");
    }

    const attrConditions = [
      eq(storeProductAttrValue.productId, integralId),
      eq(storeProductAttrValue.type, 4),
    ];

    const [user, purchaseRows, initialAttrRows, baseProductRows, catalogueRows] = await Promise.all([
      c.userDao.findForAuth(uid),
      c.db
        .select({ total: sql<number>`COALESCE(SUM(${storeOrder.totalNum}), 0)::int` })
        .from(storeOrder)
        .where(
          and(
            eq(storeOrder.uid, uid),
            eq(storeOrder.type, 4),
            eq(storeOrder.activityId, integralId),
            eq(storeOrder.isDel, 0),
            eq(storeOrder.isSystemDel, 0),
          ),
        ),
      c.db
        .select()
        .from(storeProductAttrValue)
        .where(and(...attrConditions))
        .limit(2),
      item.productId > 0
        ? c.db
            .select()
            .from(storeProduct)
            .where(eq(storeProduct.id, item.productId))
            .limit(1)
        : Promise.resolve([]),
      c.db.select({ id: storeProductAttrResult.id }).from(storeProductAttrResult)
        .where(and(eq(storeProductAttrResult.productId, integralId), eq(storeProductAttrResult.type, 4))).limit(1),
    ]);
    if (!user) throw new NotFoundException("用户不存在");
    // A retired type-4 catalogue cannot downgrade to the legacy base-SKU
    // fallback. The resolver below separately requires an active exact pair.
    const modernSku = initialAttrRows.length > 0 || catalogueRows.length > 0;
    const pair = modernSku ? await resolveLegacyActivitySkuPair(c.db, {
      activityId: integralId, productId: item.productId, type: 4, unique: skuUnique,
    }) : null;
    let attrRows = pair ? [pair.activitySku] : initialAttrRows;
    if (!attrRows.length && item.productId > 0) {
      const fallbackConditions = [
        eq(storeProductAttrValue.productId, item.productId),
        eq(storeProductAttrValue.type, 0),
        eq(storeProductAttrValue.isRetired, 0),
      ];
      if (skuUnique) fallbackConditions.push(eq(storeProductAttrValue.unique, skuUnique));
      attrRows = await c.db
        .select()
        .from(storeProductAttrValue)
        .where(and(...fallbackConditions))
        .limit(2);
    }
    const purchased = purchaseRows[0]?.total ?? 0;
    if (item.num > 0 && purchased + num > item.num) {
      throw new ValidateException(`每人累计限购 ${item.num} 件`);
    }
    if (!skuUnique && attrRows.length > 1) {
      throw new ValidateException("请选择积分商品规格");
    }
    const attr = attrRows[0] ?? null;
    const baseSku = pair?.baseSku ?? (attr?.type === 0 ? attr : null);
    // Cash and points belong to the chosen activity SKU. The root is only the
    // catalogue summary (the SKU with the smallest points requirement).
    const unitIntegral = modernSku ? attr!.integral : item.integral;
    if (Number(modernSku ? attr!.price : item.price) !== 0) {
      throw new ValidateException("积分加现金或运费商品请走统一购物车下单流程");
    }
    if (!Number.isSafeInteger(unitIntegral) || unitIntegral <= 0) {
      throw new ValidateException("积分商品兑换积分无效");
    }
    if (skuUnique && !attr) throw new ValidateException("积分商品规格不存在");
    if (attr && (attr.stock < num || (attr.type === 4 && attr.quota < num))) {
      throw new ValidateException("积分商品规格库存不足");
    }
    const baseProduct = baseProductRows[0] ?? null;
    if (item.productId > 0) {
      if (!baseProduct || baseProduct.isShow !== 1 || baseProduct.isDel !== 0
        || (modernSku && (baseProduct.isVerify !== 1 || baseProduct.type !== item.type
          || baseProduct.relationId !== item.relationId || baseProduct.productType !== item.productType))) {
        throw new ValidateException("关联商品已下架");
      }
      if (baseProduct.stock < num) throw new ValidateException("关联商品库存不足");
    }
    if (modernSku && (!baseSku || baseSku.stock < num || item.quota < num)) {
      throw new ValidateException("关联商品规格库存或兑换次数不足");
    }

    const needIntegral = unitIntegral * num;
    if (!Number.isSafeInteger(needIntegral) || needIntegral > 2_147_483_647) {
      throw new ValidateException("兑换积分超出范围");
    }
    if (user.integral < needIntegral) {
      throw new ValidateException(`积分不足, 需要 ${needIntegral} 积分`);
    }
    const unitCost = modernSku ? String(attr!.cost) : '0.00';
    const totalCostCents = BigInt(unitCost.replace('.', '')) * BigInt(num);
    if (totalCostCents < 0n || totalCostCents > 999_999_999_999n) throw new ValidateException('兑换成本超出范围');
    const orderCost = `${totalCostCents / 100n}.${String(totalCostCents % 100n).padStart(2, '0')}`;

    // 事务: 扣积分 + 建统一积分订单 + 减活动/SKU/商品库存 + 快照/状态/流水
    const finalOrderId = await this.runInTx(c.db, async (tx) => {
      const preparedSystemForm = await loadOrderSystemFormSubmission(
        tx,
        item.systemFormId,
        customForm,
        uid,
      );
      const lockedUsers = await tx
        .select({ integral: userTable.integral })
        .from(userTable)
        .where(eq(userTable.uid, uid))
        .limit(1)
        .for("update");
      if (!lockedUsers.length) throw new NotFoundException("用户不存在");

      const existingRows = await tx
        .select({ id: storeOrder.id, orderId: storeOrder.orderId, type: storeOrder.type, activityId: storeOrder.activityId, totalNum: storeOrder.totalNum })
        .from(storeOrder)
        .where(and(eq(storeOrder.uid, uid), eq(storeOrder.unique, idempotencyKey)))
        .limit(1);
      if (existingRows[0]) {
        await assertReplay(tx as unknown as DbClient, existingRows[0]);
        return existingRows[0].orderId;
      }

      if (modernSku) {
        // Freeze the quoted rules and both SKU identities before writing. A
        // stock-only change can still succeed; an Admin price/owner/spec edit
        // must never turn an earlier points-only quote into a free purchase.
        const [currentItem] = await tx.select().from(storeIntegral)
          .where(eq(storeIntegral.id, integralId)).for('update');
        const [currentProduct] = await tx.select().from(storeProduct)
          .where(eq(storeProduct.id, item.productId)).for('update');
        const rules = ['productId', 'productType', 'type', 'relationId', 'postage', 'num', 'onceNum', 'systemFormId'] as const;
        if (!currentItem || rules.some(key => currentItem[key] !== item[key])
          || currentItem.status !== 1 || currentItem.isShow !== 1 || currentItem.isDel !== 0
          || !currentProduct || currentProduct.isShow !== 1 || currentProduct.isDel !== 0
          || currentProduct.isVerify !== 1 || currentProduct.type !== item.type
          || currentProduct.relationId !== item.relationId || currentProduct.productType !== item.productType
          || currentProduct.isSupportRefund !== baseProduct!.isSupportRefund) {
          throw new ValidateException('积分商品信息已变更，请重新兑换');
        }
        const quotedSkus = [attr!, baseSku!].sort((a, b) => a.id - b.id);
        const quoteKeys = ['productId', 'type', 'unique', 'suk', 'productType', 'isRetired', 'price', 'integral', 'cost', 'settlePrice', 'writeTimes', 'diskInfo', 'image'] as const;
        for (const quoted of quotedSkus) {
          const [lockedSku] = await tx.select().from(storeProductAttrValue)
            .where(eq(storeProductAttrValue.id, quoted.id)).for('update');
          if (!lockedSku || quoteKeys.some(key => lockedSku[key] !== quoted[key])) {
            throw new ValidateException('积分商品规格已变更，请重新兑换');
          }
        }
      }

      const currentPurchaseRows = await tx
        .select({ total: sql<number>`COALESCE(SUM(${storeOrder.totalNum}), 0)::int` })
        .from(storeOrder)
        .where(
          and(
            eq(storeOrder.uid, uid),
            eq(storeOrder.type, 4),
            eq(storeOrder.activityId, integralId),
            eq(storeOrder.isDel, 0),
            eq(storeOrder.isSystemDel, 0),
          ),
        );
      if (item.num > 0 && (currentPurchaseRows[0]?.total ?? 0) + num > item.num) {
        throw new ValidateException(`每人累计限购 ${item.num} 件`);
      }

      const updated = await tx
        .update(userTable)
        .set({ integral: sql`integral - ${needIntegral}` })
        .where(and(eq(userTable.uid, uid), sql`integral >= ${needIntegral}`))
        .returning({ uid: userTable.uid, integral: userTable.integral });
      if (!updated.length) throw new ValidateException("积分不足 (并发冲突)");

      const inserted = await tx
        .insert(storeOrder)
        .values({
          type: 4,
          activityId: integralId,
          orderId,
          uid,
          storeId: item.type === 1 ? item.relationId : 0,
          supplierId: item.type === 2 ? item.relationId : 0,
          realName: "",
          userPhone: "",
          province: "",
          userAddress: "",
          totalNum: num,
          totalPrice: "0.00",
          totalPostage: "0.00",
          payPrice: "0.00",
          payPostage: "0.00",
          cost: orderCost,
          payIntegral: needIntegral,
          paid: 1,
          payType: "integral",
          payTime: now,
          status: 0,
          shippingType: 1,
          productType: item.productType,
          customForm: preparedSystemForm?.snapshotJson ?? "[]",
          unique: idempotencyKey,
          isDel: 0,
          addTime: now,
        })
        .returning();
      const order = inserted[0];
      if (!order) throw new Error("积分订单创建失败");
      await collectOrderSystemForm(tx, preparedSystemForm, uid, order.id, now);

      const integralUpdated = await tx
        .update(storeIntegral)
        .set({
          stock: sql`stock - ${num}`,
          quota: sql`CASE WHEN quota > 0 THEN quota - ${num} ELSE quota END`,
          sales: sql`sales + ${num}`,
        })
        .where(
          and(
            eq(storeIntegral.id, integralId),
            eq(storeIntegral.status, 1),
            eq(storeIntegral.isShow, 1),
            eq(storeIntegral.isDel, 0),
            sql`stock >= ${num}`,
            modernSku ? sql`quota >= ${num}` : sql`(quota = 0 OR quota >= ${num})`,
          ),
        )
        .returning({ id: storeIntegral.id });
      if (!integralUpdated.length) throw new ValidateException("库存不足 (并发冲突)");

      if (attr) {
        const attrWhere = attr.type === 4
          ? and(
              eq(storeProductAttrValue.id, attr.id),
              sql`stock >= ${num}`,
              sql`quota >= ${num}`,
            )
          : and(eq(storeProductAttrValue.id, attr.id), sql`stock >= ${num}`);
        const attrUpdated = await tx
          .update(storeProductAttrValue)
          .set({
            stock: sql`stock - ${num}`,
            quota: attr.type === 4 ? sql`quota - ${num}` : attr.quota,
            sales: sql`sales + ${num}`,
          })
          .where(attrWhere)
          .returning({ id: storeProductAttrValue.id });
        if (!attrUpdated.length) throw new ValidateException("积分商品规格库存不足 (并发冲突)");
      }

      if (modernSku && baseSku) {
        const baseSkuUpdated = await tx.update(storeProductAttrValue).set({
          stock: sql`stock - ${num}`, sales: sql`sales + ${num}`,
        }).where(and(eq(storeProductAttrValue.id, baseSku.id),
          eq(storeProductAttrValue.productId, item.productId), eq(storeProductAttrValue.type, 0),
          eq(storeProductAttrValue.isRetired, 0), sql`stock >= ${num}`))
          .returning({ id: storeProductAttrValue.id });
        if (!baseSkuUpdated.length) throw new ValidateException('关联商品规格库存不足 (并发冲突)');
      }

      if (baseProduct) {
        const productUpdated = await tx
          .update(storeProduct)
          .set({ stock: sql`stock - ${num}`, sales: sql`sales + ${num}` })
          .where(
            and(
              eq(storeProduct.id, baseProduct.id),
              eq(storeProduct.isShow, 1),
              eq(storeProduct.isDel, 0),
              sql`stock >= ${num}`,
            ),
          )
          .returning({ id: storeProduct.id });
        if (!productUpdated.length) throw new ValidateException("关联商品库存不足 (并发冲突)");
      }

      const snapshotSku = modernSku ? baseSku : attr;
      const cartSnapshot = {
        ...(modernSku ? {
          financial_version: 'checkout-line-finance-v1', id: '', cart_num: num,
          member_savings_version: MEMBER_SAVINGS_VERSION, paid_member: 0, price_type: '',
          integral: unitIntegral, use_integral: '0', sum_price: '0.00', sum_true_price: '0.00',
          costPrice: unitCost, vip_truePrice: '0.00', promotions_true_price: '0.00',
          raw_postage_price: '0.00', postage_price: '0.00', member_postage_price: '0.00',
          member_coupon_price: '0.00', coupon_price: '0.00', integral_price: '0.00',
          first_order_price: '0.00', one_brokerage: '0.00', two_brokerage: '0.00',
          division_staff_brokerage: '0.00', division_agent_brokerage: '0.00', division_brokerage: '0.00',
          activitySku: { id: attr!.id, unique: attr!.unique.trimEnd(), suk: attr!.suk,
            price: String(attr!.price), integral: unitIntegral },
        } : {}),
        product: { id: item.productId, activityId: integralId, storeName: item.storeName,
          image: attr?.image || item.image, price: '0.00', integral: unitIntegral, giveIntegral: '0.00' },
        sku: snapshotSku ? { id: snapshotSku.id, unique: snapshotSku.unique.trimEnd(),
          suk: snapshotSku.suk, integral: unitIntegral, price: '0.00', write_times: Math.max(snapshotSku.writeTimes, 1),
          ...(item.productType === 1 ? { disk_info: snapshotSku.diskInfo ?? '' } : {}) } : null,
      };
      const [orderLine] = await tx.insert(storeOrderCartInfo).values({
        uid,
        oid: order.id,
        cartId: "0",
        type: item.type,
        relationId: item.relationId,
        productId: item.productId,
        productType: item.productType,
        skuUnique: snapshotSku?.unique.trimEnd() ?? skuUnique,
        cartNum: num,
        surplusNum: num,
        splitSurplusNum: num,
        settlePrice: modernSku ? String(attr!.settlePrice || baseSku!.settlePrice) : '0.00',
        ...(modernSku ? { writeTimes: Math.max(baseSku!.writeTimes, 1) * num,
          writeSurplusTimes: Math.max(baseSku!.writeTimes, 1) * num } : {}),
        cartInfo: JSON.stringify(cartSnapshot),
        unique: random,
        isSupportRefund: baseProduct?.isSupportRefund ?? 1,
        addTime: now,
      }).returning({ id: storeOrderCartInfo.id });
      if (modernSku) {
        if (!orderLine) throw new Error('积分订单商品创建失败');
        // Direct checkout has no store_cart row. Use its real order-line id as
        // the immutable, positive refund selector, without fabricating a cart.
        cartSnapshot.id = String(orderLine.id);
        await tx.update(storeOrderCartInfo).set({ cartId: cartSnapshot.id, cartInfo: JSON.stringify(cartSnapshot) })
          .where(eq(storeOrderCartInfo.id, orderLine.id));
      }

      await tx.insert(storeOrderStatus).values({
        oid: order.id,
        changeType: "create",
        changeMessage: "积分兑换订单创建并支付",
        changeTime: now,
      });

      // Direct pure-points orders are already paid inside this transaction;
      // persist the same outbox event as every other paid order so virtual
      // delivery, supplier allocation and the remaining payment side effects
      // are replayable instead of being silently skipped.
      await enqueueOrderPaidEvent(tx as unknown as DbClient, order, now);

      await tx.insert(userBill).values({
        uid,
        linkId: String(order.id),
        pm: 0,
        title: "积分兑换",
        category: "integral",
        type: "storeIntegral_use_integral",
        number: String(needIntegral),
        balance: String(updated[0].integral),
        mark: `积分兑换「${item.storeName}」x${num}`,
        status: 1,
        addTime: now,
      });
      return order.orderId;
    });

    return { orderId: finalOrderId };
  }

  private async runInTx<T>(db: DbClient, fn: (tx: DB) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => fn(tx as unknown as DB));
  }
}
