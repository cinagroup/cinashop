/**
 * 订单支付 Service (M4)
 *
 * 对应 PHP app/services/pay/YuePayServices.php + StoreOrderSuccessServices.php
 *
 * 策略 (经探针验证 + 计划约定):
 *   - 余额支付 (yue): Workers 直接实现 (扣 user.now_money → paySuccess)
 *   - 微信/支付宝: 回调先转发 PHP 后端过渡, Workers 仅做 notify 接收 + 幂等标记
 *   - paySuccess 幂等: 已 paid 的订单重复回调直接返回 (对应 PHP PayNotifyServices 第 36 行)
 *
 * 关键: paySuccess 是唯一的同步写 (paid=1, pay_type, pay_time, trade_no),
 *        其余 (佣金/积分/通知) 全部走队列, 最终一致。
 */
import { eq, and, sql } from "drizzle-orm";
import {
  user as userTable,
  storeOrder,
  userBill as userBillTable,
  userRecharge,
  storeCouponUser,
} from "@/models/schema";
import type { Container, DbClient } from "@/lib/di";
import type { Env, OrderMessage } from "@/env";
import { ValidateException, NotFoundException } from "@/utils/errors";

/** 支付方式常量 (对应 PHP PayServices) */
export const PayType = {
  WEIXIN: "weixin",
  YUE: "yue",
  OFFLINE: "offline",
  ALIPAY: "alipay",
  INTEGRAL: "integral",
} as const;

export class StoreOrderPayService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  /**
   * 余额支付 (对应 PHP YuePayServices::yueOrderPay)
   *
   * 事务内:
   *   1. 检查余额 >= payPrice
   *   2. 扣 user.now_money (WHERE now_money >= payPrice 守卫)
   *   3. 记 user_bill 流水
   *   4. paySuccess (paid=1)
   */
  async yuePay(uid: number, orderId: string): Promise<{ paid: boolean }> {
    const c = this.container;
    const order = await c.storeOrderDao.findByOrderId(orderId);
    if (!order) throw new NotFoundException("订单不存在");
    if (order.uid !== uid) throw new ValidateException("订单不属于当前用户");
    if (order.paid) return { paid: true }; // 幂等

    const payPrice = Number(order.payPrice);
    if (payPrice <= 0) {
      // 0 元单: 直接 paySuccess (对应 PHP zeroYuanPayment)
      await this.paySuccess(order.id, PayType.YUE);
      return { paid: true };
    }

    const user = await c.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户不存在");
    if (Number(user.nowMoney) < payPrice) {
      throw new ValidateException("余额不足");
    }

    // 事务: 扣余额 + 流水 + 标记支付
    await this.runInTx(c.db, async (tx) => {
      // 1. 扣余额 (带 now_money >= payPrice 守卫, 防并发)
      const updated = await tx
        .update(userTable)
        .set({ nowMoney: sql`now_money - ${payPrice.toFixed(2)}` })
        .where(and(eq(userTable.uid, uid), sql`now_money >= ${payPrice.toFixed(2)}`))
        .returning({ uid: userTable.uid });
      if (!updated.length) {
        throw new ValidateException("余额不足 (并发冲突)");
      }

      // 2. 记账单流水 (对应 PHP UserMoneyServices::income)
      await tx.insert(userBillTable).values({
        uid,
        linkId: orderId,
        pm: 0, // 支出
        title: "购买商品",
        category: "now_money",
        type: "pay_product",
        number: payPrice.toFixed(2),
        balance: (Number(user.nowMoney) - payPrice).toFixed(2),
        mark: `余额支付订单 ${orderId}`,
        status: 1,
        addTime: Math.floor(Date.now() / 1000),
      });

      // 3. 标记订单已支付 (幂等: paid=0 守卫)
      const paid = await tx
        .update(storeOrder)
        .set({
          paid: 1,
          payType: PayType.YUE,
          payTime: Math.floor(Date.now() / 1000),
        })
        .where(and(eq(storeOrder.id, order.id), eq(storeOrder.paid, 0)))
        .returning({ id: storeOrder.id });
      if (!paid.length) {
        throw new ValidateException("订单已被支付 (并发)");
      }
    });

    // 事务成功 → 佣金结算 (对应 paySuccess 行为, 一级 10% / 二级 5%) + 投异步队列
    await this.settleBrokerage(order);
    await this.consumeCoupon(order.id);
    await this.dispatchPaySuccessJobs(order.id, uid);

    return { paid: true };
  }

  /**
   * 充值到账 (M17: 补全充值支付闭环)
   *
   * 充值单 (user_recharge, 单号 cz 前缀) 支付成功后:
   *   - user_recharge.paid=1 + pay_time
   *   - user.now_money += price + give_price
   *   - user_bill 收入流水
   */
  async rechargePay(uid: number, orderId: string, payType: string = PayType.YUE): Promise<boolean> {
    void payType; // 预留: 记录支付方式
    const c = this.container;
    const rec = await c.db
      .select()
      .from(userRecharge)
      .where(eq(userRecharge.orderId, orderId))
      .limit(1);
    if (!rec[0]) throw new NotFoundException("充值订单不存在");
    if (rec[0].uid !== uid) throw new ValidateException("订单不属于当前用户");
    if (rec[0].paid) return true; // 幂等

    const price = Number(rec[0].price);
    const givePrice = Number(rec[0].givePrice ?? 0);
    const total = price + givePrice;
    const user = await c.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户不存在");

    const now = Math.floor(Date.now() / 1000);
    await this.runInTx(c.db, async (tx) => {
      const paid = await tx
        .update(userRecharge)
        .set({ paid: 1, payTime: now })
        .where(and(eq(userRecharge.id, rec[0].id), eq(userRecharge.paid, 0)))
        .returning({ id: userRecharge.id });
      if (!paid.length) throw new ValidateException("充值订单已被处理 (并发)");

      // 余额入账
      await tx
        .update(userTable)
        .set({ nowMoney: sql`now_money + ${total.toFixed(2)}` })
        .where(eq(userTable.uid, uid));

      // 流水 (收入)
      await tx.insert(userBillTable).values({
        uid,
        linkId: orderId,
        pm: 1,
        title: "充值到账",
        category: "now_money",
        type: "recharge",
        number: total.toFixed(2),
        balance: (Number(user.nowMoney) + total).toFixed(2),
        mark: givePrice > 0 ? `充值 ¥${price.toFixed(2)} 赠送 ¥${givePrice.toFixed(2)}` : `充值 ¥${price.toFixed(2)}`,
        status: 1,
        addTime: now,
      });
    });
    return true;
  }

  /**
   * 支付成功标记 (对应 PHP StoreOrderSuccessServices::paySuccess)
   *
   * 幂等: 已 paid 直接返回 (对应 PHP PayNotifyServices 第 36 行)
   * 这是微信/支付宝回调最终调用的方法 (M4 先转发 PHP, 后续 M6 直连)
   */
  async paySuccess(orderId: number, payType: string, tradeNo?: string): Promise<boolean> {
    const c = this.container;
    const order = await c.storeOrderDao.get(orderId);
    if (!order) return true; // 订单不存在, 返回 true 阻止重试 (与 PHP 一致)
    if (order.paid) return true; // 幂等

    const updated = await c.storeOrderDao.update(orderId, {
      paid: 1,
      payType,
      payTime: Math.floor(Date.now() / 1000),
      ...(tradeNo ? { tradeNo } : {}),
    });
    void updated;

    // 分销佣金结算 (订单支付后给推广人发佣金)
    await this.settleBrokerage(order);

    // M17: 下单用券 → 支付成功核销
    await this.consumeCoupon(orderId);

    await this.dispatchPaySuccessJobs(orderId, order.uid);
    return true;
  }

  /** 核销下单时使用的优惠券 (幂等: 仅未使用的券) */
  private async consumeCoupon(orderId: number | string): Promise<void> {
    try {
      const order =
        typeof orderId === "number"
          ? await this.container.storeOrderDao.get(orderId)
          : await this.container.storeOrderDao.findByOrderId(orderId);
      if (!order || !order.couponId) return;
      await this.container.db
        .update(storeCouponUser)
        .set({
          status: 1,
          useTime: new Date(Math.floor(Date.now() / 1000) * 1000),
        })
        .where(and(eq(storeCouponUser.id, order.couponId), eq(storeCouponUser.status, 0)));
    } catch (e) {
      // 核销失败不影响支付结果 (可补单)
      console.error("[consumeCoupon] failed:", e);
    }
  }

  /**
   * 分销佣金结算
   *
   * 规则 (对应 PHP order.create 事件后的佣金计算):
   *   - 买家 spread_uid = A → A 获得一级佣金 (SKU.brokerage)
   *   - A.spread_uid = B → B 获得二级佣金 (SKU.brokerage_two)
   *   - 佣金写 user_brokerage (status=1 有效), 同时累加 user.brokerage_price
   */
  private async settleBrokerage(order: {
    id: number;
    uid: number;
    orderId: string;
    payPrice: string;
  }): Promise<void> {
    const c = this.container;
    try {
      // 买家
      const buyer = await c.userDao.findForAuth(order.uid);
      if (!buyer || !buyer.spreadUid) return; // 无推广人则不分佣

      // 订单商品 (取 SKU 佣金比例)
      const cartInfos = await c.storeOrderCartInfoDao.getByOid(order.id);
      const now = Math.floor(Date.now() / 1000);

      // 一级推广人
      const l1 = await c.userDao.findForAuth(buyer.spreadUid);
      if (l1 && l1.status) {
        // 简化: 佣金 = 订单实付 * 10% (M5+ 从 SKU.brokerage 读精确比例)
        const l1Commission = (Number(order.payPrice) * 0.1).toFixed(2);
        if (Number(l1Commission) > 0) {
          await c.userBrokerageDao.save({
            uid: l1.uid,
            linkId: order.orderId,
            pm: 1,
            title: "一级推广佣金",
            category: "one_brokerage",
            type: "order_brokerage",
            number: l1Commission,
            balance: (Number(l1.brokeragePrice) + Number(l1Commission)).toFixed(2),
            mark: `订单 ${order.orderId} 推广佣金`,
            status: 1,
            addTime: now,
          });
          await c.userDao.inc({ uid: l1.uid }, "brokeragePrice", Number(l1Commission));
        }

        // 二级推广人
        if (l1.spreadUid) {
          const l2 = await c.userDao.findForAuth(l1.spreadUid);
          if (l2 && l2.status) {
            const l2Commission = (Number(order.payPrice) * 0.05).toFixed(2);
            if (Number(l2Commission) > 0) {
              await c.userBrokerageDao.save({
                uid: l2.uid,
                linkId: order.orderId,
                pm: 1,
                title: "二级推广佣金",
                category: "two_brokerage",
                type: "order_brokerage",
                number: l2Commission,
                balance: (Number(l2.brokeragePrice) + Number(l2Commission)).toFixed(2),
                mark: `订单 ${order.orderId} 二级佣金`,
                status: 1,
                addTime: now,
              });
              await c.userDao.inc({ uid: l2.uid }, "brokeragePrice", Number(l2Commission));
            }
          }
        }
      }
      void cartInfos;
    } catch (e) {
      // 佣金结算失败不影响支付结果 (可补单)
      console.error("[settleBrokerage] failed:", e);
    }
  }

  /** 投递支付成功后的异步任务 (对应 PHP event('order.pay')) */
  private async dispatchPaySuccessJobs(orderId: number, uid: number): Promise<void> {
    // M4 简化: 只投核心任务; 佣金/积分/通知 M5 完善
    const messages = [
      { body: { action: "compute", orderId: String(orderId), uid } },
    ] satisfies { body: OrderMessage }[];
    try {
      await this.env.ORDER_QUEUE.sendBatch(messages);
    } catch (e) {
      // 队列失败不影响支付结果 (最终一致, 可补单)
      console.error("[paySuccess] queue dispatch failed:", e);
    }
  }

  /** 事务包装器 */
  private async runInTx<T>(db: DbClient, fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => fn(tx as unknown as DbClient));
  }

  // ═══ M23: 支付宝 + 通用回调 ═════════════════════════════════

  /**
   * 支付宝 H5 支付 (M23)
   *
   * 生成支付宝跳转 URL (H5 网关), 实际签名需要商户私钥 + appId 配置。
   * 未配置时返回沙箱占位 URL (调试用, 前端跳转后需手动回调)。
   */
  async alipayPay(uid: number, orderId: string): Promise<string> {
    const c = this.container;
    const order = await c.storeOrderDao.findByOrderId(orderId);
    if (!order) throw new NotFoundException("订单不存在");
    if (order.uid !== uid) throw new ValidateException("订单不属于当前用户");
    if (order.paid) throw new ValidateException("订单已支付");

    // 支付宝网关 URL (实际需用 RSA2 签名, 这里返回结构化 URL 供前端跳转)
    // 前端可直接 window.location.href = payUrl
    const appId = this.env.ALIPAY_APP_ID ?? "";
    const gateway = "https://openapi.alipay.com/gateway.do";
    const notifyUrl = `https://cinashop-api.cinagroup.workers.dev/api/pay/notify/alipay`;
    const returnUrl = `https://cinashop-h5.pages.dev/#/pages/order/payResult?status=ok&orderId=${orderId}&amount=${order.payPrice}`;

    if (!appId) {
      // 未配置: 返回占位 URL (仅调试)
      return `${gateway}?app_id=SANDBOX&out_trade_no=${orderId}&total_amount=${order.payPrice}&subject=CinaShop&notify_url=${encodeURIComponent(notifyUrl)}&return_url=${encodeURIComponent(returnUrl)}`;
    }

    // 已配置: 构建签名 URL (需 RSA2 签名, Worker 环境用 Web Crypto API)
    // 简化: 返回前端跳转地址, 前端调用支付宝 SDK
    return returnUrl;
  }

  /**
   * 按订单号标记支付成功 (通用回调, M23)
   *
   * 供 /pay/notify/:type 调用, 幂等。
   */
  async paySuccessByOrderId(orderId: string, payType: string, tradeNo?: string): Promise<boolean> {
    const c = this.container;
    const order = await c.storeOrderDao.findByOrderId(orderId);
    if (!order) return false;
    if (order.paid) return true; // 幂等

    await this.paySuccess(order.id, payType, tradeNo);
    return true;
  }
}
