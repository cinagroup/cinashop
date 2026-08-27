import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  hasExhaustedOrderQueueRetries,
  ORDER_QUEUE_MAX_DELIVERY_ATTEMPTS,
  ORDER_QUEUE_MAX_RETRIES,
} from "@/services/order/OrderQueuePolicy";

function configuredOrderQueueMaxRetries(): number {
  const config = readFileSync("wrangler.toml", "utf8");
  const consumer = config.match(
    /\[\[queues\.consumers\]\][\s\S]*?queue\s*=\s*"cinashop-order"[\s\S]*?max_retries\s*=\s*(\d+)/,
  );
  if (!consumer?.[1]) throw new Error("cinashop-order max_retries is missing");
  return Number(consumer[1]);
}

describe("order Queue retry policy", () => {
  it("stays aligned with the deployed Wrangler consumer contract", () => {
    expect(configuredOrderQueueMaxRetries()).toBe(ORDER_QUEUE_MAX_RETRIES);
    expect(ORDER_QUEUE_MAX_DELIVERY_ATTEMPTS).toBe(ORDER_QUEUE_MAX_RETRIES + 1);
  });

  it("treats the fourth delivery as the final attempt when max_retries is three", () => {
    expect(hasExhaustedOrderQueueRetries(1)).toBe(false);
    expect(hasExhaustedOrderQueueRetries(2)).toBe(false);
    expect(hasExhaustedOrderQueueRetries(3)).toBe(false);
    expect(hasExhaustedOrderQueueRetries(4)).toBe(true);
    expect(hasExhaustedOrderQueueRetries(5)).toBe(true);
  });
});
