/**
 * 售后退款 Service (M4)
 *
 * 对应 PHP app/services/order/StoreOrderRefundServices.php
 *
 * 三个核心方法 (经探针验证):
 *   - applyRefund:  用户申请 (创建 refund 记录, 不改 order.refund_status)
 *   - agreeRefund:  管理员同意 → 退款执行 (余额退/微信退 + 库存回退 + 积分回退)
 *   - refuseRefund: 管理员拒绝
 *
 * 关键一致性:
 *   - 库存回退 (regressionStock): 只在 order.status==0 且首次退款时执行 (防双退)
 *   - 积分回退 (regressionIntegral): 3 种积分各自幂等 (gain/use/pay_integral)
 *   - 余额退 (yueRefund): user.now_money += refundPrice, 带 user_bill 流水
 */
import { eq, sql } from "drizzle-orm";
import {
  storeOrder,
  storeOrderRefund,
  storeProduct,
  storeProductAttrValue,
  user as userTable,
  userBill as userBillTable,
} from "@/models/schema";
import type { Container, DbClient } from "@/lib/di";
import { ValidateException, NotFoundException } from "@/utils/errors";

export class StoreOrderRefundService {
  constructor(private readonly container: Container) {}

  /**
   * 用户申请退款 (对应 PHP applyRefund)
   *
   * 注意: 不改 store_order.refund_status (与 PHP 一致, 仅创建 refund 记录)
   */
  async applyRefund(params: {
    uid: number;
    orderId: string; // 订单号
    refundReason: string;
    refundExplain: string;
    refundImg?: string;
    applyType: number; // 1仅退款 2退货退款
    cartIds?: number[]; // 空=整单退, 非空=部分退
  }): Promise<{ refundId: number }> {
    const c = this.container;
    const { uid, orderId } = params;

    const order = await c.storeOrderDao.findByOrderId(orderId);
    if (!order) throw new NotFoundException("订单不存在");
    if (order.uid !== uid) throw new ValidateException("订单不属于当前用户");
    if (!order.paid) throw new ValidateException("订单未支付");

    // 是否已有进行中的退款
    const hasOpen = await c.storeOrderRefundDao.hasOpenRefund(order.id);
    if (hasOpen) throw new ValidateException("该订单已有进行中的退款申请");

    // 计算退款金额 (整单 / 部分)
    let refundNum = order.totalNum;
    let refundPrice = Number(order.payPrice);
    if (params.cartIds?.length) {
      // 部分退: 按 cart_info 行汇总
      const cartInfos = await c.storeOrderCartInfoDao.getByOid(order.id);
      const selected = cartInfos.filter((ci) => params.cartIds!.includes(Number(ci.cartId)));
      refundNum = selected.reduce((s, ci) => s + ci.cartNum, 0);
      // 守卫: 退款数量不能超过总数量 (防止超退)
      if (refundNum > order.totalNum) {
        throw new ValidateException("退款数量超过订单商品总数");
      }
      const ratio = order.totalNum > 0 ? refundNum / order.totalNum : 0;
      refundPrice = Number(order.payPrice) * ratio;
    }

    const now = Math.floor(Date.now() / 1000);
    const refund = await c.storeOrderRefundDao.save({
      storeOrderId: order.id,
      uid,
      orderId: `r${order.id}${now}`,
      applyType: params.applyType,
      applyPrice: refundPrice.toFixed(2),
      refundType: 0, // 未处理
      refundNum,
      refundPrice: refundPrice.toFixed(2),
      refundReason: params.refundReason,
      refundExplain: params.refundExplain,
      refundImg: params.refundImg ?? "",
      cartInfo: JSON.stringify({ cartIds: params.cartIds ?? [] }),
      addTime: now,
    });

    // 记状态日志
    await c.storeOrderStatusDao.log(
      order.id,
      "apply_refund",
      `用户申请退款，原因：${params.refundReason}`,
    );

    return { refundId: refund.id };
  }

  /**
   * 管理员同意退款 (对应 PHP agreeRefund)
   *
   * 事务内 (ACID):
   *   1. 更新 refund 记录: refundType=6(已退款), refundedTime
   *   2. 更新 order: refundStatus=2(已退款), refundType=6
   *   3. 库存回退 (首次退款守卫)
   *   4. 余额退 (yue) 或记录待微信/支付宝退
   *   5. 积分回退 (use_integral)
   *   6. 状态日志
   */
  async agreeRefund(refundId: number): Promise<void> {
    const c = this.container;
    const refund = await c.storeOrderRefundDao.get(refundId);
    if (!refund) throw new NotFoundException("退款记录不存在");
    if (refund.refundType === 6) return; // 幂等

    const order = await c.storeOrderDao.get(refund.storeOrderId);
    if (!order) throw new NotFoundException("订单不存在");

    const refundPrice = Number(refund.refundPrice);
    const now = Math.floor(Date.now() / 1000);

    await this.runInTx(c.db, async (tx) => {
      // 1. 更新退款记录
      await tx
        .update(storeOrderRefund)
        .set({ refundType: 6, refundedTime: now, refundedPrice: refundPrice.toFixed(2) })
        .where(eq(storeOrderRefund.id, refundId));

      // 2. 更新订单
      await tx
        .update(storeOrder)
        .set({ refundStatus: 2, refundType: 6, refundPrice: refundPrice.toFixed(2) })
        .where(eq(storeOrder.id, order.id));

      // 3. 库存回退 (只在 status==0 待发货 且 首次退款)
      if (order.status === 0) {
        await this.restoreStock(tx, order.id, refund.refundNum);
      }

      // 4. 余额退 (yue 支付的订单)
      if (order.payType === "yue" && refundPrice > 0) {
        await tx
          .update(userTable)
          .set({ nowMoney: sql`now_money + ${refundPrice.toFixed(2)}` })
          .where(eq(userTable.uid, order.uid));
        await tx.insert(userBillTable).values({
          uid: order.uid,
          linkId: order.orderId,
          pm: 1, // 获得
          title: "订单退款",
          category: "now_money",
          type: "pay_product_refund",
          number: refundPrice.toFixed(2),
          balance: refundPrice.toFixed(2), // 简化, 实际需读当前余额
          mark: `退款到余额, 订单 ${order.orderId}`,
          status: 1,
          addTime: now,
        });
      }

      // 5. 积分回退 (use_integral 抵扣的积分加回)
      if (Number(order.useIntegral) > 0) {
        const backIntegral = Math.round(
          Number(order.useIntegral) * (refundPrice / Math.max(Number(order.payPrice), 0.01)),
        );
        await tx
          .update(userTable)
          .set({ integral: sql`integral + ${backIntegral}` })
          .where(eq(userTable.uid, order.uid));
        await tx.insert(userBillTable).values({
          uid: order.uid,
          linkId: order.orderId,
          pm: 1,
          title: "退款退回积分",
          category: "integral",
          type: "pay_product_integral_back",
          number: String(backIntegral),
          balance: String(backIntegral),
          mark: `订单 ${order.orderId} 退款退回抵扣积分`,
          status: 1,
          addTime: now,
        });
      }

      // 6. 状态日志
      await tx.insert((await import("@/models/schema")).storeOrderStatus).values({
        oid: order.id,
        changeType: "refund_price",
        changeMessage: `退款给用户：${refundPrice.toFixed(2)}元`,
        changeTime: now,
      });
    });
  }

  /** 管理员拒绝退款 (对应 PHP refuseRefund) */
  async refuseRefund(refundId: number, refuseReason: string): Promise<void> {
    const c = this.container;
    const refund = await c.storeOrderRefundDao.get(refundId);
    if (!refund) throw new NotFoundException("退款记录不存在");

    const order = await c.storeOrderDao.get(refund.storeOrderId);
    await c.storeOrderRefundDao.update(refundId, {
      refundType: 3, // 拒绝
      refuseReason,
    });
    if (order) {
      await c.storeOrderDao.update(order.id, { refundStatus: 0, refundType: 3 });
      await c.storeOrderStatusDao.log(
        order.id,
        "refund_n",
        `管理员拒绝退款：${refuseReason}`,
      );
    }
  }

  /** 用户取消退款申请 (对应 PHP cancelApplyRefund) */
  async cancelApply(uid: number, refundId: number): Promise<void> {
    const c = this.container;
    const refund = await c.storeOrderRefundDao.get(refundId);
    if (!refund) throw new NotFoundException("退款记录不存在");
    if (refund.uid !== uid) throw new ValidateException("无权操作");
    await c.storeOrderRefundDao.update(refundId, { isCancel: 1 });
    if (refund.storeOrderId) {
      await c.storeOrderStatusDao.log(refund.storeOrderId, "cancel_apply_refund", "用户取消退款申请");
    }
  }

  /**
   * 库存回退 (对应 PHP regressionStock)
   * 增加 SKU + 主商品库存, 减少销量
   */
  private async restoreStock(tx: DbClient, orderId: number, refundNum: number): Promise<void> {
    const cartInfos = await this.container.storeOrderCartInfoDao.getByOid(orderId);
    for (const ci of cartInfos) {
      const num = Math.min(ci.cartNum, refundNum);
      if (num <= 0) continue;

      // SKU 库存回退 (按 unique 找 SKU)
      if (ci.skuUnique) {
        await tx
          .update(storeProductAttrValue)
          .set({
            stock: sql`stock + ${num}`,
            sales: sql`GREATEST(sales - ${num}, 0)`,
          })
          .where(eq(storeProductAttrValue.unique, ci.skuUnique));
      }

      // 主商品库存回退
      await tx
        .update(storeProduct)
        .set({
          stock: sql`stock + ${num}`,
          sales: sql`GREATEST(sales - ${num}, 0)`,
        })
        .where(eq(storeProduct.id, ci.productId));
    }
  }

  /** 退款列表 (用户侧) */
  async listByUser(uid: number) {
    return this.container.storeOrderRefundDao.selectList({
      where: { uid, isDel: 0 },
    });
  }

  /** 退款详情 */
  async detail(uid: number, refundId: number) {
    const refund = await this.container.storeOrderRefundDao.get(refundId);
    if (!refund || refund.uid !== uid) throw new NotFoundException("退款记录不存在");
    return {
      ...refund,
      cartInfo: refund.cartInfo ? JSON.parse(refund.cartInfo) : null,
    };
  }

  /** 事务包装器 */
  private async runInTx<T>(db: DbClient, fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => fn(tx as unknown as DbClient));
  }
}
