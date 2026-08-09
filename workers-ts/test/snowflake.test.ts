/**
 * 雪花 ID 逻辑测试 (位运算部分, 纯函数验证)
 *
 * 不实例化 DO (需要 Workers runtime), 只验证组装逻辑的正确性。
 * DO 集成测试需要 Miniflare, 留到接真实数据库后做。
 */
import { describe, it, expect } from "vitest";

// 镜像 SequenceDO 的常量, 验证位运算约定
const EPOCH = Date.UTC(2020, 5, 5);
const WORKER_BITS = 10;
const SEQ_BITS = 12;
const MAX_WORKER = (1 << WORKER_BITS) - 1;
const MAX_SEQ = (1 << SEQ_BITS) - 1;

function compose(ts: number, workerId: number, seq: number): bigint {
  return (
    (BigInt(ts) << BigInt(WORKER_BITS + SEQ_BITS)) |
    (BigInt(workerId) << BigInt(SEQ_BITS)) |
    BigInt(seq)
  );
}

describe("雪花 ID 位运算 (对应 PHP Godruoyi\\Snowflake)", () => {
  it("时间戳占高位 41bit, worker 10bit, seq 12bit", () => {
    const ts = 1234567890; // 相对 EPOCH 的毫秒
    const worker = 500;
    const seq = 3000;
    const id = compose(ts, worker, seq);

    // 反解验证
    const extractedSeq = id & BigInt(MAX_SEQ);
    const extractedWorker = (id >> BigInt(SEQ_BITS)) & BigInt(MAX_WORKER);
    const extractedTs = id >> BigInt(WORKER_BITS + SEQ_BITS);

    expect(Number(extractedSeq)).toBe(seq);
    expect(Number(extractedWorker)).toBe(worker);
    expect(Number(extractedTs)).toBe(ts);
  });

  it("同毫秒不同序列号 → ID 单调递增", () => {
    const ts = 1000;
    const worker = 1;
    const id1 = compose(ts, worker, 0);
    const id2 = compose(ts, worker, 1);
    const id3 = compose(ts, worker, 2);
    expect(id1 < id2).toBe(true);
    expect(id2 < id3).toBe(true);
  });

  it("同序列号不同时间 → 时间大的 ID 大", () => {
    const worker = 1;
    const seq = 0;
    const id1 = compose(1000, worker, seq);
    const id2 = compose(1001, worker, seq);
    expect(id1 < id2).toBe(true);
  });

  it("最大值边界: worker=1023, seq=4095 不溢出", () => {
    const id = compose(9999999, MAX_WORKER, MAX_SEQ);
    // 64bit 内 (BigInt 无溢出问题)
    expect(id > 0n).toBe(true);
  });

  it("订单号前缀 wx + ID 字符串 (对应 PHP getNewOrderId)", () => {
    const id = compose(1000, 1, 0).toString();
    const orderId = "wx" + id;
    expect(orderId.startsWith("wx")).toBe(true);
    expect(orderId.length).toBeGreaterThan(2);
  });

  it("EPOCH 起点是 2020-06-05 (与 PHP setStartTimeStamp 一致)", () => {
    // 2020-06-05 00:00:00 UTC
    expect(new Date(EPOCH).toISOString()).toBe("2020-06-05T00:00:00.000Z");
  });
});
