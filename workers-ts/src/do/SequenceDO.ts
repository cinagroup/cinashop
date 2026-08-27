/**
 * 雪花 ID 生成器 (DO 版本)
 *
 * 对应 PHP Godruoyi\Snowflake\Snowflake + RedisSequenceResolver。
 *
 * 设计:
 *   - 位结构 (与 PHP godruoyi/snowflake 默认一致, 64bit):
 *       1 bit 符号 | 41 bit 毫秒时间戳 | 10 bit worker | 12 bit 序列号
 *   - 时间起点: 2020-06-05 (与 PHP setStartTimeStamp 一致)
 *   - worker id: 通过 DO 实例 id 哈希得到 (Workers 多 isolate 天然分散)
 *   - 序列号: SQLite 持久化计数器, 同毫秒内递增, DO input gate 保证唯一
 *
 * 为什么用 DO 而非 Upstash:
 *   雪花 ID 的序列号要求强一致 + 单点顺序, DO 单线程执行天然满足。
 *   Upstash REST 跨网络, 同毫秒并发会冲突。
 *
 * sharding: 单例 DO (id 固定为 "seq"), 全局一个序列源。
 * 性能: SQLite 同步单行更新, 单 DO 吞吐受 DO 限流影响。
 * 生产高并发可按业务分片 (order/product/...), 这里用 prefix 区分。
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "@/env";

/** 雪花起点 (2020-06-05 00:00:00 UTC, 与 PHP 一致) */
const EPOCH = Date.UTC(2020, 5, 5);
/** worker id 位数 */
const WORKER_BITS = 10;
/** 序列号位数 */
const SEQ_BITS = 12;
const MAX_WORKER = (1 << WORKER_BITS) - 1; // 1023
const MAX_SEQ = (1 << SEQ_BITS) - 1; // 4095

export class SequenceDO extends DurableObject<Env> {
  /** worker id (从 DO id 哈希, 0-1023) */
  private workerId: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 用 DO 实例 name 哈希出 workerId (稳定且唯一)
    const name = ctx.id.name ?? "seq";
    this.workerId = hashStr(name) & MAX_WORKER;

    // 序列必须在 isolate 回收后继续存在。SQLite 调用是同步的，因此读取和更新
    // 单例行会保持在同一个 DO input gate 内，无需 blockConcurrencyWhile。
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sequence_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_ts INTEGER NOT NULL,
        seq INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO sequence_state (singleton, last_ts, seq) VALUES (1, -1, 0)",
    );
  }

  /**
   * 生成单个雪花 ID。
   * SQLite 同步事务与 DO input gate 共同保证唯一，并跨实例回收保存状态。
   */
  async nextId(): Promise<string> {
    const persisted = this.ctx.storage.sql
      .exec("SELECT last_ts AS lastTs, seq FROM sequence_state WHERE singleton = 1")
      .one() as { lastTs: number; seq: number };
    const physicalTs = Date.now() - EPOCH;
    let ts = Math.max(physicalTs, persisted.lastTs);
    let seq = ts === persisted.lastTs ? persisted.seq + 1 : 0;

    // 不在 ID 分配中 yield。单毫秒序列耗尽时推进逻辑时钟，避免异步等待
    // 期间另一条 RPC 插入并覆盖较新的序列状态。
    if (seq > MAX_SEQ) {
      ts = persisted.lastTs + 1;
      seq = 0;
    }

    this.ctx.storage.sql.exec(
      "UPDATE sequence_state SET last_ts = ?, seq = ? WHERE singleton = 1",
      ts,
      seq,
    );
    return this.compose(ts, seq);
  }

  /**
   * 生成订单号 (对应 PHP getNewOrderId)
   * @param prefix 订单前缀 ('wx'|'hy'|'order')
   */
  async nextOrderId(prefix = "wx"): Promise<string> {
    const id = await this.nextId();
    return prefix + id;
  }

  /** 组装 64bit ID (用 BigInt, JS Number 在 2^53 以上不安全) */
  private compose(ts: number, seq: number): string {
    const id =
      (BigInt(ts) << BigInt(WORKER_BITS + SEQ_BITS)) |
      (BigInt(this.workerId) << BigInt(SEQ_BITS)) |
      BigInt(seq);
    return id.toString();
  }

  /**
   * fetch 入口: 支持 Worker 主线程通过 namespace.get(id).fetch() 调用。
   *   GET /next-id          → 返回雪花 ID
   *   GET /next-order-id?prefix=wx → 返回订单号 (wx + snowflake)
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/next-id") {
        const id = await this.nextId();
        return new Response(id, { status: 200 });
      }
      if (path === "/next-order-id") {
        const prefix = url.searchParams.get("prefix") ?? "wx";
        const orderId = await this.nextOrderId(prefix);
        return new Response(orderId, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response(String(e instanceof Error ? e.message : e), { status: 500 });
    }
  }
}

/** 简单字符串哈希 → workerId */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
