import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SignReminderMessage } from "@/env";
import {
  consumeSignReminderQueueMessage,
  isSignReminderDispatchTime,
  isSignReminderMessage,
  signReminderEventKey,
  signReminderRetryDelaySeconds,
  signReminderShanghaiDay,
} from "@/services/message/SignReminderService";
import { prepareOrderQueueDeadLetter } from "@/services/order/OrderQueueDeadLetterService";

const scheduledAt = Date.parse("2026-08-09T02:25:00.000Z");

function body(): SignReminderMessage {
  return {
    action: "processSignReminder",
    job: "sign_remind_time",
    runId: `scheduled:${scheduledAt}`,
    scheduledAt,
    userId: 42,
    shanghaiDay: signReminderShanghaiDay(scheduledAt),
  };
}

function queueMessage(attempts = 1) {
  return { body: body(), attempts, ack: vi.fn(), retry: vi.fn() };
}

describe("sign reminder scheduling and delivery contract", () => {
  it("uses the legacy 10:25 Asia/Shanghai daily window and an exact day boundary", () => {
    expect(isSignReminderDispatchTime(scheduledAt)).toBe(true);
    expect(isSignReminderDispatchTime(Date.parse("2026-08-09T02:24:00.000Z"))).toBe(false);
    expect(isSignReminderDispatchTime(Date.parse("2026-08-09T02:26:00.000Z"))).toBe(false);
    const beforeMidnight = signReminderShanghaiDay(Date.parse("2026-08-08T15:59:59.999Z"));
    const atMidnight = signReminderShanghaiDay(Date.parse("2026-08-08T16:00:00.000Z"));
    expect(atMidnight).toBe(beforeMidnight + 1);
  });

  it("binds the Queue payload and idempotency key to the scheduled Shanghai day", () => {
    const message = body();
    expect(isSignReminderMessage(message)).toBe(true);
    expect(isSignReminderMessage({ ...message, shanghaiDay: message.shanghaiDay + 1 })).toBe(false);
    expect(isSignReminderMessage({ ...message, runId: "scheduled:other" })).toBe(false);
    expect(signReminderEventKey(message.shanghaiDay, message.userId))
      .toBe(`sign_remind_time:${message.shanghaiDay}:42`);
  });

  it("acknowledges a completed idempotent delivery", async () => {
    const message = queueMessage();
    const processor = { processMessage: vi.fn().mockResolvedValue("created") };
    await consumeSignReminderQueueMessage(message, processor);
    expect(processor.processMessage).toHaveBeenCalledWith(message.body);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries a failed delivery with bounded exponential backoff", async () => {
    const message = queueMessage(3);
    const processor = { processMessage: vi.fn().mockRejectedValue(new Error("transient")) };
    await consumeSignReminderQueueMessage(message, processor);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(signReminderRetryDelaySeconds(99)).toBe(900);
  });

  it("keeps replayable DLQ evidence free of phone numbers and rendered content", () => {
    const prepared = prepareOrderQueueDeadLetter(body());
    expect(prepared.replayPolicy).toBe("ALLOW");
    expect(prepared.messageType).toBe("processSignReminder");
    expect(prepared.replayMessage).toEqual(body());
    expect(prepared.body).not.toHaveProperty("phone");
    expect(prepared.body).not.toHaveProperty("content");
  });

  it("revalidates preference/sign state under the sign lock and inserts one event-keyed notice", () => {
    const source = readFileSync("src/services/message/SignReminderService.ts", "utf8");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain('return "preference-disabled"');
    expect(source).toContain('return "already-signed"');
    expect(source).toContain("notExists(");
    expect(source).toContain("onConflictDoNothing({ target: systemMessage.eventKey })");
    expect(source).toContain('return "already-created"');
    expect(source).not.toContain("phone: user.phone");
  });
});
