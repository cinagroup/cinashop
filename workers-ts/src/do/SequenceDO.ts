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
 *   - 序列号: DO 内部计数器, 同毫秒内递增, blockConcurrencyWhile 保证唯一
 *
 * 为什么用 DO 而非 Upstash:
 *   雪花 ID 的序列号要求强一致 + 单点顺序, DO 单线程执行天然满足。
 *   Upstash REST 跨网络, 同毫秒并发会冲突。
 *
 * sharding: 单例 DO (id 固定为 "seq"), 全局一个序列源。
 * 性能: DO 内部计数极快, 单 DO 可承担每秒数万 ID (受 DO 限流影响)。
 * 生产高并发可按业务分片 (order/product/...), 这里用 prefix 区分。
 */
import { DurableObject } from "cloudflare:workers";

/** 雪花起点 (2020-06-05 00:00:00 UTC, 与 PHP 一致) */
const EPOCH = Date.UTC(2020, 5, 5);
/** worker id 位数 */
const WORKER_BITS = 10;
/** 序列号位数 */
const SEQ_BITS = 12;
const MAX_WORKER = (1 << WORKER_BITS) - 1; // 1023
const MAX_SEQ = (1 << SEQ_BITS) - 1; // 4095

interface SeqState {
  lastTs: number; // 上次时间戳 (毫秒, 相对 EPOCH)
  seq: number; // 当前序列号
}

export class SequenceDO extends DurableObject {
  private state: SeqState = { lastTs: -1, seq: 0 };
  /** worker id (从 DO id 哈希, 0-1023) */
  private workerId: number;

  constructor(state: DurableObjectState) {
    super(state, {} as never);
    // 用 DO 实例 name 哈希出 workerId (稳定且唯一)
    const name = state.id.name ?? "seq";
    this.workerId = hashStr(name) & MAX_WORKER;
  }

  /**
   * 生成单个雪花 ID。
   * 同一 DO 实例内 blockConcurrencyWhile 串行, 保证唯一。
   */
  async nextId(): Promise<string> {
    return this.ctx.blockConcurrencyWhile(() => {
      const now = Date.now() - EPOCH;
      let seq = 0;
      if (now === this.state.lastTs) {
        // 同毫秒: 序列号递增
        this.state.seq = (this.state.seq + 1) & MAX_SEQ;
        if (this.state.seq === 0) {
          // 序列号耗尽, 等到下一毫秒
          return this.waitNextMs(now).then((ts) => {
            this.state.lastTs = ts;
            this.state.seq = 0;
            return this.compose(ts, 0);
          });
        }
        seq = this.state.seq;
      } else if (now > this.state.lastTs) {
        this.state.lastTs = now;
        this.state.seq = 0;
        seq = 0;
      } else {
        // 时钟回拨 (极少见): 等待
        return this.waitNextMs(this.state.lastTs).then((ts) => {
          this.state.lastTs = ts;
          this.state.seq = 0;
          return this.compose(ts, 0);
        });
      }
      return Promise.resolve(this.compose(now, seq));
    });
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

  /** 自旋等到下一毫秒 */
  private async waitNextMs(after: number): Promise<number> {
    let ts = Date.now() - EPOCH;
    while (ts <= after) {
      await new Promise((r) => setTimeout(r, 0));
      ts = Date.now() - EPOCH;
    }
    return ts;
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
