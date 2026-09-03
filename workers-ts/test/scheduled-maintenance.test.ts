import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "@/env";
import {
  SCHEDULED_ORDER_PAGE_SIZE,
  createScheduledRunMessages,
  enqueueScheduledRun,
  isScheduledMaintenanceMessage,
  isScheduledOrderMessage,
  isPinkTimeoutMessage,
  scheduledRetryDelaySeconds,
} from "@/services/order/ScheduledMaintenanceService";

describe("可分页定时维护工作流", () => {
  const scheduledAt = Date.parse("2026-08-09T02:25:00.000Z");

  it("Cron 一次投递十四个可重放根任务", async () => {
    const messages = createScheduledRunMessages(scheduledAt);
    expect(messages.map((message) => message.job)).toEqual([
      "payment_outbox_dispatch",
      "notification_delivery_dispatch",
      "print_job_dispatch",
      "waybill_job_dispatch",
      "unpaid_order_cancel",
      "pink_timeout",
      "auto_receipt",
      "auto_comment",
      "live_room_sync",
      "live_goods_sync",
      "live_anchor_sync",
      "refund_reconciliation",
      "reminder_unverified_remind",
      "sign_remind_time",
    ]);
    expect(messages).toHaveLength(14);
    expect(messages.every((message) => message.runId === `scheduled:${scheduledAt}`)).toBe(true);
    expect(messages.every((message) => message.cursor === 0 && message.threshold === null)).toBe(
      true,
    );
    expect(() => structuredClone(messages)).not.toThrow();

    const sendBatch = vi.fn().mockResolvedValue({ metadata: { metrics: {} } });
    const env = { ORDER_QUEUE: { sendBatch } } as unknown as Env;
    await enqueueScheduledRun(env, scheduledAt);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch.mock.calls[0]?.[0]).toEqual(
      messages.map((body) => ({ body, contentType: "json" })),
    );
  });

  it("非上海 10:25 不产生签到扫描根任务", () => {
    const outside = createScheduledRunMessages(Date.parse("2026-08-09T02:20:00.000Z"));
    expect(outside).toHaveLength(13);
    expect(outside.some((message) => message.job === "sign_remind_time")).toBe(false);
  });

  it("严格拒绝损坏的游标、阈值和 runId", () => {
    const root = createScheduledRunMessages(scheduledAt)[1];
    expect(isScheduledMaintenanceMessage(root)).toBe(true);
    expect(isScheduledMaintenanceMessage({ ...root, cursor: -1 })).toBe(false);
    expect(isScheduledMaintenanceMessage({ ...root, threshold: 1.5 })).toBe(false);
    expect(isScheduledMaintenanceMessage({ ...root, runId: "scheduled:other" })).toBe(false);
    expect(isScheduledMaintenanceMessage({ ...root, job: "unknown" })).toBe(false);

    const work = {
      action: "processScheduledOrder",
      job: "auto_receipt",
      runId: `scheduled:${scheduledAt}`,
      scheduledAt,
      orderId: 42,
      threshold: 1_785_000_000,
    };
    expect(isScheduledOrderMessage(work)).toBe(true);
    expect(isScheduledOrderMessage({ ...work, orderId: 0 })).toBe(false);
    expect(isScheduledOrderMessage({ ...work, threshold: -1 })).toBe(false);
    expect(isScheduledOrderMessage({ ...work, job: "refund_reconciliation" })).toBe(false);

    const pinkTimeout = {
      action: "processPinkTimeout",
      job: "pink_timeout",
      runId: `scheduled:${scheduledAt}`,
      scheduledAt,
      pinkId: 9,
    };
    expect(isPinkTimeoutMessage(pinkTimeout)).toBe(true);
    expect(isPinkTimeoutMessage({ ...pinkTimeout, pinkId: 0 })).toBe(false);
    expect(isPinkTimeoutMessage({ ...pinkTimeout, runId: "scheduled:other" })).toBe(false);
  });

  it("重试使用有上限的指数退避", () => {
    expect(scheduledRetryDelaySeconds(1)).toBe(30);
    expect(scheduledRetryDelaySeconds(2)).toBe(60);
    expect(scheduledRetryDelaySeconds(3)).toBe(120);
    expect(scheduledRetryDelaySeconds(99)).toBe(900);
  });

  it("订单候选按主键游标推进，单页连同 continuation 不超过 Queue 上限", () => {
    const source = readFileSync("src/services/order/ScheduledMaintenanceService.ts", "utf8");
    expect(SCHEDULED_ORDER_PAGE_SIZE).toBeLessThanOrEqual(99);
    expect(source).toContain("gt(storeOrder.id, cursor)");
    expect(source).toContain(".orderBy(asc(storeOrder.id))");
    expect(source).toContain("cursor: nextCursor, threshold");
    expect(source).toContain("candidates.length === SCHEDULED_ORDER_PAGE_SIZE");
    expect(source).not.toContain(".limit(100)");
  });

  it("Queue 消费前重新校验资格，订单状态机承担至少一次投递的幂等边界", () => {
    const source = readFileSync("src/services/order/ScheduledMaintenanceService.ts", "utf8");
    const pinkSource = readFileSync("src/services/activity/PinkTimeoutService.ts", "utf8");
    expect(source).toContain("message.orderId");
    expect(source).toContain('reason: "no_longer_eligible"');
    expect(source).toContain("completeOrderReceipt(this.container, this.env");
    expect(source).toContain("autoCommentOrder(message.orderId)");
    expect(source).toContain("eq(storeOrder.paid, 1)");
    expect(source).toContain("inArray(storeOrder.refundStatus, [0, 3])");
    expect(source).toContain('job: "unpaid_order_cancel"');
    expect(source).toContain("lte(storeOrder.addTime, message.threshold)");
    expect(source).toContain("processPinkTimeout(message: PinkTimeoutMessage)");
    expect(source).toContain("eq(storePink.status, 1)");
    expect(source).toContain("participant.order_id_key <> ''");
    expect(source).toContain("backing.id::text = participant.order_id_key");
    expect(source).toContain("NOT EXISTS");
    expect(source).toContain("eq(storePink.status, 3)");
    expect(source).toContain("backing.refund_status <> 2");
    expect(pinkSource).toContain("ensureAutomaticOrderRefund(this.container");
    expect(pinkSource).toContain("MAX_AUTOMATIC_REFUNDS_PER_ORDER");
  });

  it("退款对账按游标分页并在外部查询前原子认领", () => {
    const source = readFileSync("src/services/order/StoreOrderRefundService.ts", "utf8");
    const method = source.slice(source.indexOf("async reconcilePendingRefunds"));
    expect(method).toContain("gt(storeOrderRefundPayment.id, afterId)");
    expect(method).toContain(".orderBy(asc(storeOrderRefundPayment.id))");
    expect(method).toContain('.for("update", { skipLocked: true })');
    expect(method).toContain(".set({ queryTime: now, updateTime: now })");
    expect(method.indexOf('.for("update", { skipLocked: true })')).toBeLessThan(
      method.indexOf("queryRefund(request)"),
    );
    expect(method).toContain("nextCursor: candidates.at(-1)?.id ?? afterId");
    expect(method).toContain("hasMore: candidates.length === boundedLimit");
  });

  it("scheduled 入口不再直接扫描 PostgreSQL，也不存在固定 100 条上限", () => {
    const source = readFileSync("src/index.ts", "utf8");
    const scheduled = source.slice(source.indexOf("async function handleScheduled"));
    expect(scheduled).toContain("enqueueScheduledRun(env, scheduledAt)");
    expect(scheduled).not.toContain("createContainer(env)");
    expect(source).not.toContain(".limit(100)");
  });
});
