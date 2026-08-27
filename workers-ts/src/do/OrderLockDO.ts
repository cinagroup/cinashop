/**
 * OrderLock Durable Object
 *
 * 历史兼容 Durable Object。
 *
 * 它无法把 Worker 主线程中的 PostgreSQL 事务纳入 DO 串行边界，因此订单
 * 创建已改为在数据库事务中原子认领购物车。保留导出和绑定仅为兼容既有迁移。
 */
import { DurableObject } from "cloudflare:workers";

export class OrderLockDO extends DurableObject {
  /**
   * 若旧调用仍存在则显式失败，避免把空操作误认为已经获得数据库锁。
   */
  override async fetch(_request: Request): Promise<Response> {
    return Response.json(
      { error: "OrderLockDO is deprecated; use the database transaction path" },
      { status: 410 },
    );
  }
}

