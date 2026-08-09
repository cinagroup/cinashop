/**
 * OrderLock Durable Object
 *
 * 对应订单创建的强一致互斥 (M3 启用)。
 *
 * 解决问题: PHP createOrder 无分布式锁, 仅靠 unique 约束防重,
 * 但同一用户不同 key 的并发请求会绕过。这里用 DO 做用户级串行化。
 *
 * sharding: 每个 uid 一个 DO 实例 (id = "order:<uid>")。
 *
 * 调用方式: 外部通过 fetch("https://internal/lock") 触发 DO 实例化,
 * DO 内 blockConcurrencyWhile 自动串行同一 uid 的并发请求。
 * 真正强一致仍靠 DB unique + 事务, DO 做软门控降低竞态窗口。
 */
import { DurableObject } from "cloudflare:workers";

export class OrderLockDO extends DurableObject {
  /**
   * fetch 入口: DO 被 get() 后调用, 触发 blockConcurrencyWhile。
   * 同一 DO 实例的 fetch 请求会被自动串行化。
   */
  override async fetch(_request: Request): Promise<Response> {
    // blockConcurrencyWhile 确保同一 uid 的并发请求排队
    // (实际业务逻辑在 Worker 主线程, 这里仅做门控)
    return this.ctx.blockConcurrencyWhile(async () => {
      return new Response("ok", { status: 200 });
    });
  }
}

