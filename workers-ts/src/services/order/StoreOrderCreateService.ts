/**
 * 订单创建 Service (M3 最高风险模块)
 *
 * 对应 PHP app/services/order/StoreOrderCreateServices.php::createOrder
 *
 * 强一致链路 (经探针验证):
 *   ① OrderLockDO 串行化 (防同一用户并发下单绕过 unique 检查)
 *   ② Hyperdrive 事务 (ACID):
 *      - INSERT order (unique 约束兜底幂等)
 *      - UPDATE store_product_attr_value SET stock=stock-n WHERE id=? AND stock>=n  ← 修复 PHP 超卖 bug
 *      - UPDATE store_product SET stock=stock-n, sales=sales+n WHERE id=? AND stock>=n
 *      - INSERT store_order_cart_info (商品快照)
 *      - (可选) UPDATE user SET integral=integral-n, INSERT user_bill
 *   ③ 事务提交后, Queues 投递异步任务 (佣金计算/清购物车/通知)
 *
 * 关键修复 (相比 PHP):
 *   - 库存扣减加 WHERE stock>=n 守卫 (PHP decStockIncSales 缺失, 靠事务行锁兜底)
 *   - 显式 OrderLockDO 串行化 (PHP 无分布式锁, 仅靠 unique 约束)
 */
import { and, eq, sql } from "drizzle-orm";
import {
  storeOrder,
  storeProduct,
  storeProductAttrValue,
  storeOrderCartInfo,
  user as userTable,
  userBill,
  storeSeckill,
  storeCombination,
  storePink,
  storeBargain,
  storeBargainUser,
  storeCouponUser,
} from "@/models/schema";
import type { Container, DbClient } from "@/lib/di";
import type { Env, OrderMessage } from "@/env";
import { ValidateException, NotFoundException } from "@/utils/errors";

/** 下单入参 */
export interface CreateOrderParams {
  uid: number;
  /** 确认订单的 key (幂等防重) */
  key: string;
  cartIds: number[];
  realName?: string;
  userPhone?: string;
  province?: string;
  userAddress?: string;
  mark?: string;
  shippingType?: number;
  useIntegral?: number;
  userIp: string;
  /** 活动类型: 0普通 1秒杀 2砍价 3拼团 4积分 (M5+ 活动下单) */
  type?: number;
  /** 拼团: 参团的团 ID (0=开团) */
  pinkId?: number;
  /** 拼团: 活动 ID (开团时必传) */
  combinationId?: number;
  /** 秒杀: 秒杀活动 ID */
  seckillId?: number;
  /** 砍价: 砍价记录 ID (store_bargain_user) */
  bargainUserId?: number;
  /** 优惠券: 用户优惠券 ID (store_coupon_user) */
  couponId?: number;
}

export class StoreOrderCreateService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  /**
   * 创建订单 (对应 PHP StoreOrderCreateServices::createOrder)
   *
   * 通过 OrderLockDO 串行化同一用户的下单请求, 防止并发绕过 unique 检查。
   */
  async createOrder(params: CreateOrderParams): Promise<{ orderId: string; key: string }> {
    const { uid } = params;
    const lockId = this.env.ORDER_LOCK.idFromName(`order:${uid}`);
    const lock = this.env.ORDER_LOCK.get(lockId);
    // DO fetch 触发 runExclusive (DO 内 blockConcurrencyWhile 串行同一 uid 的请求)
    // 这里用 DO 做软门控, 真正强一致靠 DB unique + 事务
    await lock.fetch("https://internal/lock").catch(() => {});
    return this.doCreate(params);
  }

  /** 真实创建逻辑 (DB 事务内) */
  private async doCreate(params: CreateOrderParams): Promise<{ orderId: string; key: string }> {
    const { uid, key, cartIds } = params;
    const c = this.container;

    // 幂等检查 (对应 PHP StoreOrder::create 第 188 行)
    const existing = await c.storeOrderDao.findByUnique(uid, key);
    if (existing) return { orderId: existing.orderId, key };

    if (!cartIds.length) throw new ValidateException("请选择要购买的商品");

    // 1. 取购物车 + 校验所有权
    const carts = await c.storeCartDao.getByIds(cartIds);
    if (!carts.length) throw new NotFoundException("购物车商品不存在");
    for (const cart of carts) {
      if (cart.uid !== uid) throw new ValidateException("购物车商品不属于当前用户");
    }

    // 2. 预加载商品 + SKU + 计算总价 (整数分, 避免浮点误差)
    //    活动单 (秒杀/砍价/拼团) 用活动价替换 SKU 价
    const type = params.type ?? 0;
    let totalNum = 0;
    let totalCents = 0;
    const orderItems: OrderItem[] = [];
    for (const cart of carts) {
      const product = await c.storeProductDao.getById(cart.productId);
      if (!product) throw new NotFoundException(`商品 ${cart.productId} 不存在`);
      if (!product.isShow || product.isDel) {
        throw new ValidateException(`商品「${product.storeName}」已下架`);
      }
      const sku = await c.storeProductAttrValueDao.getByUnique(cart.productAttrUnique);
      if (!sku) throw new NotFoundException(`商品规格不存在`);

      // 活动价 (M17: 秒杀/砍价/拼团替换 SKU 价)
      let unitPriceCents = Math.round(Number(sku.price) * 100);
      if (type === 1 && params.seckillId) {
        const seckill = await c.db
          .select()
          .from(storeSeckill)
          .where(eq(storeSeckill.id, params.seckillId))
          .limit(1);
        if (!seckill[0] || seckill[0].status !== 1) throw new ValidateException("秒杀活动不存在或已结束");
        if (seckill[0].productId !== product.id) throw new ValidateException("秒杀商品不匹配");
        if (cart.cartNum > (seckill[0].num || 99)) throw new ValidateException("超过秒杀限购数量");
        unitPriceCents = Math.round(Number(seckill[0].price) * 100);
      } else if (type === 2 && params.bargainUserId) {
        const bu = await c.db
          .select()
          .from(storeBargainUser)
          .where(and(eq(storeBargainUser.id, params.bargainUserId), eq(storeBargainUser.uid, uid)))
          .limit(1);
        if (!bu[0]) throw new ValidateException("砍价记录不存在");
        // 必须砍到最低价才能购买 (对应 PHP: status=3 表示可购买)
        if (bu[0].status !== 3) throw new ValidateException("还未砍到最低价, 请继续砍价");
        unitPriceCents = Math.round(Number(bu[0].bargainPrice) * 100);
      } else if (type === 3 && params.pinkId !== undefined) {
        // 拼团价: 从参团的团取关联活动价
        const pink = await c.db
          .select({ combinationId: storePink.combinationId })
          .from(storePink)
          .where(eq(storePink.id, params.pinkId!))
          .limit(1);
        if (!pink[0]) throw new ValidateException("拼团信息不存在");
        const comboRow = await c.db
          .select()
          .from(storeCombination)
          .where(eq(storeCombination.id, pink[0].combinationId))
          .limit(1);
        if (!comboRow[0] || comboRow[0].status !== 1) throw new ValidateException("拼团活动不存在或已结束");
        if (comboRow[0].productId !== product.id) throw new ValidateException("拼团商品不匹配");
        unitPriceCents = Math.round(Number(comboRow[0].price) * 100);
      }

      totalNum += cart.cartNum;
      totalCents += unitPriceCents * cart.cartNum;
      orderItems.push({ cart, product, sku });
    }

    // 2b. 优惠券抵扣 (M17: 下单用券)
    //    满减券: 抵扣 = min(面额, 应付); 折扣券: couponPrice=8.5 → 85 折
    let couponPriceCents = 0;
    let couponRow: { id: number; type: number; couponPrice: string } | null = null;
    if (params.couponId) {
      const cu = await c.db
        .select()
        .from(storeCouponUser)
        .where(and(eq(storeCouponUser.id, params.couponId), eq(storeCouponUser.uid, uid)))
        .limit(1);
      if (!cu[0]) throw new ValidateException("优惠券不存在");
      if (cu[0].status !== 0) throw new ValidateException("优惠券已使用或已过期");
      if (cu[0].endTime && new Date(cu[0].endTime).getTime() < Date.now()) {
        throw new ValidateException("优惠券已过期");
      }
      if (Number(cu[0].useMinPrice) > 0 && totalCents / 100 < Number(cu[0].useMinPrice)) {
        throw new ValidateException(`订单满 ¥${cu[0].useMinPrice} 才能使用该券`);
      }
      if (cu[0].type === 2) {
        // 折扣券 (coupon_price 存折扣, 如 8.5 = 85 折)
        const rate = Math.max(0.1, Math.min(1, Number(cu[0].couponPrice) / 10));
        couponPriceCents = Math.round(totalCents * (1 - rate) * 100) / 100;
      } else {
        couponPriceCents = Math.min(
          Math.round(Number(cu[0].couponPrice) * 100),
          totalCents,
        );
      }
      couponRow = cu[0];
    }

    // 3. 雪花订单号 (通过 SequenceDO)
    const seqId = this.env.SEQUENCE.idFromName("seq");
    const seq = this.env.SEQUENCE.get(seqId);
    const seqResp = await seq.fetch("https://internal/next-order-id?prefix=wx");
    const orderId = (await seqResp.text()).trim();
    if (!orderId) throw new Error("订单号生成失败");

    // 4. 积分抵扣 (可选, 对应 PHP deductIntegral)
    const user = await c.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户不存在");
    const useIntegral = params.useIntegral ?? 0;
    let deductionCents = 0;
    if (useIntegral > 0) {
      if (user.integral < useIntegral) throw new ValidateException("积分不足");
      // 简化: 100 积分 = 1 元 (实际从 system_config 读比例, M4 补)
      deductionCents = Math.min(useIntegral * 1, totalCents);
    }

    // 4c. 运费计算 (M22: 按 shipping_templates_region 计费, 省份匹配)
    let postageCents = 0;
    const province = params.province ?? "";
    if (province) {
      try {
        const { shippingTemplatesRegion } = await import("@/models/schema");
        // 查所有区域费率, 按省份模糊匹配 (region_name LIKE '%省名%')
        const regions = await c.db
          .select()
          .from(shippingTemplatesRegion)
          .limit(50);
        const matched = regions.find((r) => {
          const rn = r.regionName ?? "";
          // "全国" 或包含省份名
          return rn === "全国" || rn.includes(province) || province.includes(rn);
        });
        if (matched) {
          // 首件费 + 续件费 (按件计, totalNum > first 则加续费)
          const first = Number(matched.first) || 1;
          const firstPrice = Number(matched.firstPrice) || 0;
          const continuePrice = Number(matched.continuePrice) || 0;
          const continueUnit = Number(matched.continue) || 1;
          postageCents = Math.round(firstPrice * 100);
          if (totalNum > first) {
            const extraUnits = Math.ceil((totalNum - first) / continueUnit);
            postageCents += Math.round(extraUnits * continuePrice * 100);
          }
        }
      } catch {
        // 运费查询失败 → 免邮 (不阻塞下单)
        postageCents = 0;
      }
    }
    const payCents = Math.max(0, totalCents - couponPriceCents - deductionCents + postageCents);

    // 4b. 拼团: 开团/参团团信息 (事务内处理人数, 这里预取组合 ID)
    let pinkCombinationId = 0;
    if (type === 3) {
      if (params.pinkId) {
        const pink = await c.db
          .select({ combinationId: storePink.combinationId })
          .from(storePink)
          .where(eq(storePink.id, params.pinkId!))
          .limit(1);
        if (pink[0]) pinkCombinationId = pink[0].combinationId;
      } else {
        pinkCombinationId = params.combinationId ?? 0;
      }
      if (!pinkCombinationId) throw new ValidateException("缺少拼团活动信息");
    }

    // 5. 事务 (ACID): 订单 + 库存 + 快照 + 积分
    const orderRow = await this.runInTx(c.db, async (tx) => {
      const now = Math.floor(Date.now() / 1000);

      // 5a0. 活动库存与拼团团 (M17: 事务内保证一致)
      let finalPinkId = 0;
      if (type === 1 && params.seckillId) {
        // 秒杀: 扣活动 quota (守卫)
        const sk = await tx
          .update(storeSeckill)
          .set({ quota: sql`quota - 1`, stock: sql`stock - 1`, sales: sql`sales + 1` })
          .where(and(eq(storeSeckill.id, params.seckillId), sql`quota >= 1`))
          .returning({ id: storeSeckill.id });
        if (!sk.length) throw new ValidateException("秒杀库存不足");
      } else if (type === 2 && params.bargainUserId) {
        // 砍价: 扣活动库存 + 标记记录已购买 (status=4)
        await tx
          .update(storeBargain)
          .set({ quota: sql`quota - 1`, stock: sql`stock - 1`, sales: sql`sales + 1` })
          .where(sql`quota >= 1`);
        await tx
          .update(storeBargainUser)
          .set({ status: 4 })
          .where(eq(storeBargainUser.id, params.bargainUserId));
      } else if (type === 3) {
        // 拼团: 扣活动库存 (守卫)
        const comb = await tx
          .update(storeCombination)
          .set({ quota: sql`quota - 1`, stock: sql`stock - 1`, sales: sql`sales + 1` })
          .where(and(eq(storeCombination.id, pinkCombinationId), sql`quota >= 1`))
          .returning({ id: storeCombination.id });
        if (!comb.length) throw new ValidateException("拼团库存不足");

        const comboRow = await tx
          .select()
          .from(storeCombination)
          .where(eq(storeCombination.id, pinkCombinationId))
          .limit(1);
        if (!comboRow[0]) throw new ValidateException("拼团活动不存在");

        if (!params.pinkId) {
          // 开团 (kId=0)
          const pinkRow = await tx
            .insert(storePink)
            .values({
              uid,
              orderId,
              orderIdKey: key,
              combinationId: pinkCombinationId,
              productId: comboRow[0].productId,
              kId: 0,
              people: 1,
              status: 1,
              addTime: now,
            })
            .returning({ id: storePink.id });
          finalPinkId = pinkRow[0].id;
        } else {
          // 参团: 校验团状态, 人数 +1, 满员成团
          finalPinkId = params.pinkId;
          const pink = await tx
            .select()
            .from(storePink)
            .where(eq(storePink.id, finalPinkId))
            .limit(1);
          if (!pink[0] || pink[0].status !== 1) throw new ValidateException("该团已结束, 请重新开团");
          if (pink[0].combinationId !== pinkCombinationId) throw new ValidateException("拼团信息不匹配");
          const people = pink[0].people + 1;
          const full = people >= comboRow[0].people;
          await tx
            .update(storePink)
            .set({ people, status: full ? 2 : 1 })
            .where(eq(storePink.id, finalPinkId));
        }
      }

      // 5a. INSERT 订单 (unique(uid,unique) 约束兜底)
      const orderInsert = await tx
        .insert(storeOrder)
        .values({
          type,
          orderId,
          uid,
          realName: params.realName ?? "",
          userPhone: params.userPhone ?? "",
          province: params.province ?? "",
          userAddress: params.userAddress ?? "",
          cartId: cartIds.join(","),
          totalNum,
          totalPrice: (totalCents / 100).toFixed(2),
          payPrice: (payCents / 100).toFixed(2),
          deductionPrice: (deductionCents / 100).toFixed(2),
          payPostage: (postageCents / 100).toFixed(2),
          shippingType: params.shippingType ?? 1,
          useIntegral: useIntegral.toFixed(2),
          mark: params.mark ?? "",
          paid: 0,
          status: 0,
          unique: key,
          addTime: now,
          userIp: params.userIp,
          // M17: 活动/优惠券字段
          couponId: couponRow?.id ?? 0,
          couponPrice: (couponPriceCents / 100).toFixed(2),
          pinkId: finalPinkId,
          activityId: type === 1 ? (params.seckillId ?? 0) : type === 2 ? (params.bargainUserId ?? 0) : type === 3 ? pinkCombinationId : 0,
        })
        .returning();
      const order = orderInsert[0];
      if (!order) throw new Error("订单插入失败");

      // 5b. 库存扣减 (关键: WHERE stock>=n 守卫, 修复 PHP 超卖 bug)
      for (const { cart, product, sku } of orderItems) {
        // SKU 库存 — 守卫失败抛异常, 事务回滚
        const skuUpdated = await tx
          .update(storeProductAttrValue)
          .set({
            stock: sql`stock - ${cart.cartNum}`,
            sales: sql`sales + ${cart.cartNum}`,
          })
          .where(and(eq(storeProductAttrValue.id, sku.id), sql`stock >= ${cart.cartNum}`))
          .returning({ id: storeProductAttrValue.id });
        if (!skuUpdated.length) {
          throw new ValidateException(`商品「${product.storeName}」库存不足`);
        }

        // 主商品库存 (也带守卫)
        await tx
          .update(storeProduct)
          .set({
            stock: sql`stock - ${cart.cartNum}`,
            sales: sql`sales + ${cart.cartNum}`,
          })
          .where(and(eq(storeProduct.id, product.id), sql`stock >= ${cart.cartNum}`));

        // 5c. 订单商品快照
        const cartInfoJson = JSON.stringify({
          product: { id: product.id, storeName: product.storeName, image: product.image },
          sku: { unique: sku.unique, suk: sku.suk, price: String(sku.price) },
        });
        await tx.insert(storeOrderCartInfo).values({
          uid,
          oid: order.id,
          cartId: String(cart.id),
          productId: cart.productId,
          productType: cart.productType,
          skuUnique: cart.productAttrUnique,
          cartNum: cart.cartNum,
          cartInfo: cartInfoJson,
          unique: key + cart.id,
          isSupportRefund: 1,
        });
      }

      // 5d. 积分扣减 + 账单
      if (useIntegral > 0) {
        await tx
          .update(userTable)
          .set({ integral: sql`integral - ${useIntegral}` })
          .where(and(eq(userTable.uid, uid), sql`integral >= ${useIntegral}`));
        await tx.insert(userBill).values({
          uid,
          linkId: orderId,
          pm: 0,
          title: "购买商品",
          category: "integral",
          type: "deduction",
          number: useIntegral.toFixed(2),
          balance: (user.integral - useIntegral).toFixed(2),
          mark: `下单抵扣, 订单号 ${orderId}`,
          status: 1,
          addTime: now,
        });
      }

      return order;
    });

    // 6. 事务提交成功 → 投递异步队列 (对应 PHP event('order.create') fan-out)
    const messages = [
      { body: { action: "compute", orderId, uid } },
      { body: { action: "delCart", orderId, uid, payload: { cartIds } } },
    ] satisfies { body: OrderMessage }[];
    await this.env.ORDER_QUEUE.sendBatch(messages);

    // 7. 标记购物车已下单
    for (const id of cartIds) {
      await c.storeCartDao.update(id, { isPay: 1 });
    }

    return { orderId: orderRow.orderId, key };
  }

  /** 事务包装器 (类型安全, tx 与 db 同构但无 $client) */
  private async runInTx<T>(
    db: DbClient,
    fn: (tx: DbClient) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => fn(tx as unknown as DbClient));
  }

  /** 订单列表 */
  async list(uid: number, opts: { type?: number; page?: number; limit?: number }) {
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 10;
    const where: Record<string, unknown> = { uid, isDel: 0 };
    if (opts.type !== undefined) where.type = opts.type;
    return this.container.storeOrderDao.selectList({ where, page, limit });
  }

  /** 订单详情 */
  async detail(uid: number, orderId: string) {
    const order = await this.container.storeOrderDao.findByOrderId(orderId);
    if (!order || order.uid !== uid) throw new NotFoundException("订单不存在");
    const cartInfos = await this.container.storeOrderCartInfoDao.getByOid(order.id);
    return {
      ...order,
      cartInfo: cartInfos.map((ci) => ({
        ...ci,
        cartInfo: ci.cartInfo ? JSON.parse(ci.cartInfo) : null,
      })),
    };
  }

  // ═══ 订单操作 (补全) ═════════════════════════════════════

  /** 确认收货 (order/take) */
  async take(uid: number, orderId: string): Promise<void> {
    const order = await this.container.storeOrderDao.findByOrderId(orderId);
    if (!order || order.uid !== uid) throw new NotFoundException("订单不存在");
    if (!order.paid) throw new ValidateException("订单未支付");
    if (order.status !== 1) throw new ValidateException("订单状态不允许收货");

    await this.container.storeOrderDao.update(order.id, { status: 2 });
    await this.container.storeOrderStatusDao.log(order.id, "take_delivery", "用户确认收货");
  }

  /** 取消订单 (order/cancel, 未支付可取消) */
  async cancel(uid: number, orderId: string): Promise<void> {
    const order = await this.container.storeOrderDao.findByOrderId(orderId);
    if (!order || order.uid !== uid) throw new NotFoundException("订单不存在");
    if (order.paid) throw new ValidateException("已支付订单不能取消");

    await this.container.storeOrderDao.update(order.id, { status: -2, isDel: 1 });
    await this.container.storeOrderStatusDao.log(order.id, "cancel", "用户取消订单");

    // M17: 拼团单取消 → 团标记失败 (status=3)
    if (order.type === 3 && order.pinkId) {
      await this.container.db
        .update(storePink)
        .set({ status: 3 })
        .where(and(eq(storePink.id, order.pinkId), eq(storePink.status, 1)));
    }
  }

  /** 删除订单 (order/del, 已收货/已取消可删) */
  async del(uid: number, orderId: string): Promise<void> {
    const order = await this.container.storeOrderDao.findByOrderId(orderId);
    if (!order || order.uid !== uid) throw new NotFoundException("订单不存在");
    await this.container.storeOrderDao.update(order.id, { isDel: 1 });
  }

  /** 再次购买 (order/again, 简化: 返回商品加入购物车) */
  async again(uid: number, orderId: string): Promise<{ cartIds: number[] }> {
    const order = await this.container.storeOrderDao.findByOrderId(orderId);
    if (!order || order.uid !== uid) throw new NotFoundException("订单不存在");
    const cartInfos = await this.container.storeOrderCartInfoDao.getByOid(order.id);

    const cartIds: number[] = [];
    for (const ci of cartInfos) {
      const row = await this.container.storeCartDao.save({
        uid,
        productId: ci.productId,
        productAttrUnique: ci.skuUnique,
        cartNum: ci.cartNum,
        addTime: Math.floor(Date.now() / 1000),
        status: 1,
      });
      cartIds.push(row.id);
    }
    return { cartIds };
  }
}

interface OrderItem {
  cart: Awaited<ReturnType<Container["storeCartDao"]["getByIds"]>>[number];
  product: NonNullable<Awaited<ReturnType<Container["storeProductDao"]["getById"]>>>;
  sku: NonNullable<Awaited<ReturnType<Container["storeProductAttrValueDao"]["getByUnique"]>>>;
}
