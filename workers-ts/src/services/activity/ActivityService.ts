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
import { eq, and, sql } from "drizzle-orm";
import {
  storeActivity,
  storeCouponIssue,
  storeCouponIssueUser,
  storeCouponUser,
  storeIntegral,
  storeOrder,
  storeOrderCartInfo,
  storeOrderStatus,
  storeProduct,
  storeProductAttrValue,
  userBill,
  user as userTable,
} from "@/models/schema";
import { withTx, type Container, type DbClient } from "@/lib/di";
import type { DB } from "@/dao/BaseDao";
import { ValidateException, NotFoundException } from "@/utils/errors";
import {
  collectOrderSystemForm,
  loadOrderSystemFormSubmission,
} from "@/services/order/OrderSystemFormService";
import { enqueueOrderPaidEvent } from "@/services/order/OrderOutboxService";

const SHANGHAI_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function shanghaiClock(now: Date): { date: string; hhmm: string } {
  const parts = Object.fromEntries(
    SHANGHAI_CLOCK.formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`,
  };
}

function legacyStopSeconds(date: string, value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return 0;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return 0;
  return Math.floor(Date.parse(
    `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`,
  ) / 1_000);
}

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

export class ActivityService {
  constructor(private readonly container: Container) {}

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
      if (issue.receiveLimit > 0 && received >= issue.receiveLimit) {
        throw new ValidateException(`每人限领 ${issue.receiveLimit} 张`);
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
      if (issue.category !== 2) {
        await tx.insert(storeCouponIssueUser).values({
          uid,
          issueCouponId: issueId,
          addTime: Math.floor(now.getTime() / 1000),
        });
      }
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
    const clock = shanghaiClock(now);
    let activeIndex = -1;
    const seckillTime = times.map((item, index) => {
      const active = clock.hhmm >= item.startTime && clock.hhmm <= item.endTime;
      const upcoming = clock.hhmm < item.startTime;
      if (active && activeIndex === -1) activeIndex = index;
      return {
        id: item.id,
        title: item.title,
        pic: item.pic,
        describe: item.describe,
        start_time: item.startTime,
        end_time: item.endTime,
        status: active ? 1 : upcoming ? 2 : 0,
        state: active ? "疯抢中" : upcoming ? "即将开始" : "已结束",
        time: item.startTime,
        stop: legacyStopSeconds(clock.date, item.endTime),
        add_time: item.addTime,
      };
    });
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
    return rows.map((item) => ({
      id: item.id,
      product_id: item.productId,
      activity_id: item.activityId,
      title: item.storeName,
      image: item.image,
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
  async seckillDetail(id: number) {
    const item = await this.container.storeSeckillDao.getById(id);
    if (!item) throw new NotFoundException("秒杀商品不存在");
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
    return { ...item, activity, percent };
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
    const item = await this.container.storeCombinationDao.getById(id);
    if (!item) throw new NotFoundException("拼团商品不存在");
    return item;
  }

  // ─── 砍价 ─────────────────────────────────────────────────

  async bargainList(pageValue?: unknown, limitValue?: unknown) {
    const { page, limit } = normalizeListPage(pageValue, limitValue);
    const rows = await this.container.storeBargainDao.list(page, limit);
    return rows.map((item) => ({
      id: item.id,
      type: item.type,
      relation_id: item.relationId,
      product_id: item.productId,
      product_type: item.productType,
      price: Number(item.price),
      min_price: Number(item.minPrice),
      ot_price: Number(item.price),
      image: item.image,
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

  async integralList(pageValue: unknown = 1, limitValue: unknown = 10) {
    const { page, limit } = normalizeListPage(pageValue, limitValue);
    const rows = await this.container.storeIntegralDao.list(page, limit);
    return rows.map((item) => ({
      id: item.id,
      product_id: item.productId,
      image: item.image,
      title: item.storeName,
      integral: item.integral,
      price: Number(item.price),
      sales: item.sales,
      stock: item.stock,
      brand_name: "",
    }));
  }

  async integralDetail(id: number) {
    const item = await this.container.storeIntegralDao.getById(id);
    if (!item) throw new NotFoundException("积分商品不存在");
    if (item.status !== 1 || item.isShow !== 1 || item.isDel !== 0) {
      throw new NotFoundException("积分商品不存在或已下架");
    }

    const activitySkus = await this.container.storeProductAttrValueDao.getByProductId(id, 4);
    const skus = await Promise.all(
      activitySkus.map(async (activitySku) => {
        const baseSku = item.productId > 0
          ? await this.container.storeProductAttrValueDao.getBySuk(item.productId, activitySku.suk, 0)
          : null;
        const available = Math.max(
          0,
          Math.min(
            activitySku.stock,
            activitySku.quota,
            baseSku?.stock ?? 0,
            item.stock,
            item.quota,
          ),
        );
        return {
          id: activitySku.id,
          unique: activitySku.unique,
          suk: activitySku.suk,
          image: activitySku.image || item.image,
          price: String(activitySku.price),
          otPrice: String(activitySku.otPrice),
          integral: activitySku.integral,
          stock: available,
        };
      }),
    );
    const availableSkus = skus.filter((sku) => sku.stock > 0);
    return {
      storeInfo: item,
      productAttr: [],
      productValue: Object.fromEntries(skus.map((sku) => [sku.suk || sku.unique, sku])),
      skus,
      saleStock: availableSkus.length > 0 ? 1 : 0,
    };
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
    const existing = await c.storeOrderDao.findByUnique(uid, idempotencyKey);
    if (existing) {
      if (existing.type !== 4 || existing.activityId !== integralId) {
        throw new ValidateException("幂等键已用于其他订单");
      }
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
    if (Number(item.price) !== 0 || Number(item.postage) !== 0) {
      throw new ValidateException("积分加现金或运费商品请走统一购物车下单流程");
    }
    // The legacy direct endpoint has no receiver/address contract. Keep it
    // only for the two product types that the unified order flow also treats
    // as non-shipping goods; every physical/other fulfillment type must use
    // the cart/order flow so address and delivery validation cannot be skipped.
    if (![1, 2].includes(item.productType)) {
      throw new ValidateException("该积分商品请走统一购物车下单流程");
    }

    const skuUnique = requestedUnique.trim();
    const attrConditions = [
      eq(storeProductAttrValue.productId, integralId),
      eq(storeProductAttrValue.type, 4),
    ];
    if (skuUnique) attrConditions.push(eq(storeProductAttrValue.unique, skuUnique));

    const [user, purchaseRows, initialAttrRows, baseProductRows] = await Promise.all([
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
    ]);
    if (!user) throw new NotFoundException("用户不存在");
    let attrRows = initialAttrRows;
    if (!attrRows.length && item.productId > 0) {
      const fallbackConditions = [
        eq(storeProductAttrValue.productId, item.productId),
        eq(storeProductAttrValue.type, 0),
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
    if (skuUnique && !attr) throw new ValidateException("积分商品规格不存在");
    if (attr && (attr.stock < num || (attr.type === 4 && attr.quota < num))) {
      throw new ValidateException("积分商品规格库存不足");
    }
    const baseProduct = baseProductRows[0] ?? null;
    if (item.productId > 0) {
      if (!baseProduct || baseProduct.isShow !== 1 || baseProduct.isDel !== 0) {
        throw new ValidateException("关联商品已下架");
      }
      if (baseProduct.stock < num) throw new ValidateException("关联商品库存不足");
    }

    const needIntegral = item.integral * num;
    if (user.integral < needIntegral) {
      throw new ValidateException(`积分不足, 需要 ${needIntegral} 积分`);
    }

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
        .select({ orderId: storeOrder.orderId, type: storeOrder.type, activityId: storeOrder.activityId })
        .from(storeOrder)
        .where(and(eq(storeOrder.uid, uid), eq(storeOrder.unique, idempotencyKey)))
        .limit(1);
      if (existingRows[0]) {
        if (existingRows[0].type !== 4 || existingRows[0].activityId !== integralId) {
          throw new ValidateException("幂等键已用于其他订单");
        }
        return existingRows[0].orderId;
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
            sql`(quota = 0 OR quota >= ${num})`,
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

      await tx.insert(storeOrderCartInfo).values({
        uid,
        oid: order.id,
        cartId: "0",
        type: item.type,
        relationId: item.relationId,
        productId: item.productId,
        productType: item.productType,
        skuUnique: attr?.unique ?? skuUnique,
        cartNum: num,
        surplusNum: num,
        splitSurplusNum: num,
        settlePrice: "0.00",
        cartInfo: JSON.stringify({
          product: {
            id: item.productId,
            activityId: integralId,
            storeName: item.storeName,
            image: attr?.image || item.image,
            price: "0.00",
            integral: item.integral,
          },
          sku: attr
            ? { id: attr.id, unique: attr.unique, suk: attr.suk, integral: attr.integral }
            : null,
        }),
        unique: random,
        isSupportRefund: 1,
        addTime: now,
      });

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
