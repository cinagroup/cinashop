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
import { storeCouponIssue, storeCouponUser, storeIntegral, storeOrder, userBill, user as userTable } from "@/models/schema";
import type { Container } from "@/lib/di";
import { ValidateException, NotFoundException } from "@/utils/errors";

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
    const c = this.container;
    const issue = await c.storeCouponIssueDao.get(issueId);
    if (!issue || issue.status !== 0) {
      throw new NotFoundException("优惠券不存在或已停发");
    }

    // 有效期校验 (receive_type=1 时检查时间)
    const now = new Date();
    if (issue.receiveType === 1) {
      if (issue.startTime && issue.startTime > now) {
        throw new ValidateException("优惠券未开始");
      }
      if (issue.endTime && issue.endTime < now) {
        throw new ValidateException("优惠券已结束");
      }
    }

    // 剩余量
    if (issue.totalCount > 0 && issue.remainCount <= 0) {
      throw new ValidateException("优惠券已领完");
    }

    // 限领校验
    const received = await c.storeCouponUserDao.countReceived(uid, issueId);
    if (issue.receiveLimit > 0 && received >= issue.receiveLimit) {
      throw new ValidateException(`每人限领 ${issue.receiveLimit} 张`);
    }

    // 事务: 扣量 + 发券
    const result = await c.db.transaction(async (tx) => {
      // 原子扣量 (WHERE remain_count > 0 守卫, 防并发超发)
      if (issue.totalCount > 0) {
        const updated = await tx
          .update(storeCouponIssue)
          .set({ remainCount: sql`remain_count - 1` })
          .where(and(eq(storeCouponIssue.id, issueId), sql`remain_count > 0`))
          .returning({ id: storeCouponIssue.id });
        if (!updated.length) throw new ValidateException("优惠券已领完");
      }

      // 计算有效期
      const start = new Date();
      const end = new Date();
      if (issue.receiveType === 0 && issue.day > 0) {
        // 领取后 N 天有效
        end.setDate(end.getDate() + issue.day);
      } else if (issue.receiveType === 1) {
        // 固定时段
        return tx.insert(storeCouponUser).values({
          uid,
          issueCouponId: issueId,
          couponTitle: issue.couponTitle,
          couponPrice: issue.couponPrice,
          useMinPrice: issue.useMinPrice,
          status: 0,
          startTime: issue.startTime ?? start,
          endTime: issue.endTime ?? end,
          type: issue.type,
          receiveTime: Math.floor(Date.now() / 1000),
        }).returning();
      }

      return tx
        .insert(storeCouponUser)
        .values({
          uid,
          issueCouponId: issueId,
          couponTitle: issue.couponTitle,
          couponPrice: issue.couponPrice,
          useMinPrice: issue.useMinPrice,
          status: 0,
          startTime: start,
          endTime: end,
          type: issue.type,
          receiveTime: Math.floor(Date.now() / 1000),
        })
        .returning();
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
  async seckillTimes() {
    const times = await this.container.storeSeckillTimeDao.getAll();
    const now = new Date();
    const nowHHmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    return times.map((t) => {
      const active = nowHHmm >= t.startTime && nowHHmm <= t.endTime;
      return { ...t, is_active: active };
    });
  }

  /** 按时间段取秒杀商品 */
  async seckillList(timeId: string) {
    return this.container.storeSeckillDao.getByTimeId(timeId);
  }

  /** 秒杀详情 */
  async seckillDetail(id: number) {
    const item = await this.container.storeSeckillDao.getById(id);
    if (!item) throw new NotFoundException("秒杀商品不存在");
    // 库存进度
    const percent = item.quotaShow > 0
      ? Math.round(((item.quotaShow - item.quota) / item.quotaShow) * 100)
      : 0;
    return { ...item, percent };
  }

  // ─── 拼团 ─────────────────────────────────────────────────

  async combinationList() {
    return this.container.storeCombinationDao.list();
  }

  async combinationDetail(id: number) {
    const item = await this.container.storeCombinationDao.getById(id);
    if (!item) throw new NotFoundException("拼团商品不存在");
    return item;
  }

  // ─── 砍价 ─────────────────────────────────────────────────

  async bargainList() {
    return this.container.storeBargainDao.list();
  }

  async bargainDetail(id: number) {
    const item = await this.container.storeBargainDao.getById(id);
    if (!item) throw new NotFoundException("砍价商品不存在");
    return item;
  }

  // ─── 积分商城 ─────────────────────────────────────────────

  async integralList(page = 1, limit = 10) {
    return this.container.storeIntegralDao.list(page, limit);
  }

  async integralDetail(id: number) {
    const item = await this.container.storeIntegralDao.getById(id);
    if (!item) throw new NotFoundException("积分商品不存在");
    return item;
  }

  /** 积分兑换 (store_integral/exchange/:id): 扣积分 + 建积分订单 + 减库存 */
  async exchange(uid: number, integralId: number, num = 1): Promise<{ orderId: string }> {
    const c = this.container;
    if (num <= 0) throw new ValidateException("兑换数量必须大于 0");

    const item = await this.container.storeIntegralDao.getById(integralId);
    if (!item) throw new NotFoundException("积分商品不存在");
    if (item.status !== 1) throw new ValidateException("积分商品已下架");
    if (item.stock < num) throw new ValidateException("库存不足");

    // 校验用户积分
    const user = await c.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户不存在");
    const needIntegral = item.integral * num;
    if (Number(user.integral) < needIntegral) {
      throw new ValidateException(`积分不足, 需要 ${needIntegral} 积分`);
    }

    const now = Math.floor(Date.now() / 1000);
    // 订单号 (简化: 时间戳+随机)
    const orderId = `jy${now}${Math.floor(Math.random() * 1000)}`;

    // 事务: 扣积分 + 建订单 + 减库存 + 记流水
    await this.runInTx(c.db, async (tx) => {
      // 1. 扣积分 (守卫)
      const updated = await tx
        .update(userTable)
        .set({ integral: sql`integral - ${needIntegral}` })
        .where(and(eq(userTable.uid, uid), sql`integral >= ${needIntegral}`))
        .returning({ uid: userTable.uid });
      if (!updated.length) throw new ValidateException("积分不足 (并发冲突)");

      // 2. 建积分订单 (type=3, 已支付)
      await tx.insert(storeOrder).values({
        type: 3,
        orderId,
        uid,
        realName: "",
        userPhone: "",
        province: "",
        userAddress: "",
        totalPrice: "0.00",
        totalPostage: "0.00",
        payPrice: "0.00",
        payIntegral: needIntegral,
        paid: 1,
        payType: "integral",
        payTime: now,
        status: 1,
        isDel: 0,
        addTime: now,
      });

      // 3. 减库存 + 加销量
      await tx
        .update(storeIntegral)
        .set({ stock: sql`stock - ${num}`, sales: sql`sales + ${num}` })
        .where(and(eq(storeIntegral.id, integralId), sql`stock >= ${num}`));

      // 4. 记积分流水
      await tx.insert(userBill).values({
        uid,
        linkId: orderId,
        pm: 0,
        title: "积分兑换",
        category: "integral",
        type: "exchange",
        number: needIntegral,
        balance: Number(user.integral) - needIntegral,
        mark: `积分兑换「${item.storeName}」x${num}`,
        status: 1,
        addTime: now,
      });
    });

    return { orderId };
  }

  private async runInTx(db: any, fn: (tx: any) => Promise<void>) {
    await db.transaction(async (tx: any) => fn(tx));
  }
}
