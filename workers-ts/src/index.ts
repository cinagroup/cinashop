/**
 * Worker 入口
 *
 * 导出 4 个 handler:
 *   - fetch:      HTTP 请求 (主入口)
 *   - queue:      队列消费 (M3 启用)
 *   - scheduled:  定时任务 (M3 启用)
 *   - TokenBucketDO / OrderLockDO: Durable Object 类
 */
import { createApp } from "./app";
import { TokenBucketDO } from "./do/TokenBucketDO";
import { OrderLockDO } from "./do/OrderLockDO";
import { SequenceDO } from "./do/SequenceDO";
import { ChatRoomDO } from "./do/ChatRoomDO";
import type { Env, OrderMessage } from "./env";

const app = createApp();

// ─── HTTP ────────────────────────────────────────────────────
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(req, env, ctx);
  },

  // ─── 队列消费 (M3 启用, M1 占位) ──────────────────────────
  async queue(
    batch: MessageBatch<OrderMessage>,
    _env: Env,
  ): Promise<void> {
    for (const msg of batch.messages) {
      console.log("[queue] TODO M3:", msg.body.action, msg.body.orderId);
      // M3: 按 action 分发到 OrderCreateAfterJob / UnpaidOrderJob
      msg.ack();
    }
  },

  // ─── 定时任务 (M4 启用: 自动收货 / 自动评价) ────────────
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
  },
};

/**
 * 定时任务处理 (对应 PHP SystemTimer: auto_take / auto_comment)
 *
 * 策略 (经探针验证):
 *   - 每日扫描 paid=1 且发货 N 天前的订单 → 自动收货 (status 1→2)
 *   - 每日扫描 status=2 且收货 N 天前的订单 → 自动评价 (status 2→3)
 *   - 阈值从 system_config 读 (system_delivery_time / system_comment_time), 默认 0=禁用
 *
 * 注意: PHP 用 change_time 精确匹配, Workers 改用 >= 范围扫描 (每天跑一次即可)
 */
async function handleScheduled(env: Env): Promise<void> {
  const { createContainer } = await import("./lib/di");
  const { storeOrder } = await import("./models/schema");
  const { SystemConfigService } = await import("./services/system/SystemConfigService");
  const { and, eq } = await import("drizzle-orm");

  const c = createContainer(env);
  const configSvc = new SystemConfigService(c, env);
  const now = Math.floor(Date.now() / 1000);

  // 1. 自动收货 (发货后 N 天)
  const deliveryDays = Number(await configSvc.get("system_delivery_time")) || 0;
  if (deliveryDays > 0) {
    const threshold = now - deliveryDays * 86400;
    const orders = await c.db
      .select()
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.paid, 1),
          eq(storeOrder.status, 1),
          eq(storeOrder.isDel, 0),
        ),
      )
      .limit(100);
    for (const order of orders) {
      const lastDelivery = await c.storeOrderStatusDao.getLastChange(order.id, [
        "delivery_goods",
        "delivery_fictitious",
        "delivery",
        "city_delivery",
      ]);
      if (lastDelivery && lastDelivery.changeTime <= threshold) {
        await c.storeOrderDao.update(order.id, { status: 2 });
        await c.storeOrderStatusDao.log(order.id, "take_delivery", "已收货[自动收货]");
      }
    }
  }

  // 2. 自动评价 (收货后 N 天)
  const commentDays = Number(await configSvc.get("system_comment_time")) || 0;
  if (commentDays > 0) {
    const threshold = now - commentDays * 86400;
    const orders = await c.db
      .select()
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.paid, 1),
          eq(storeOrder.status, 2),
          eq(storeOrder.isDel, 0),
        ),
      )
      .limit(100);
    for (const order of orders) {
      const lastTake = await c.storeOrderStatusDao.getLastChange(order.id, [
        "user_take_delivery",
        "take_delivery",
        "writeoff",
      ]);
      if (lastTake && lastTake.changeTime <= threshold) {
        await c.storeOrderDao.update(order.id, { status: 3 });
        await c.storeOrderStatusDao.log(order.id, "check_comment", "已评价[自动评价]");
      }
    }
  }
}

// ─── Durable Object 导出 (wrangler.toml class_name 指向这些) ─
export { TokenBucketDO, OrderLockDO, SequenceDO, ChatRoomDO };
