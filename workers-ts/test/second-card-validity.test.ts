import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseSecondCardValiditySnapshot,
  resolveSecondCardValidityAtCheckout,
  resolveSecondCardValidityAtPayment,
} from "@/services/order/SecondCardValidityService";

describe("次卡支付有效期", () => {
  it("读取当前 Worker 与历史 PHP 快照", () => {
    expect(parseSecondCardValiditySnapshot(JSON.stringify({
      sku: { write_valid: 2, write_days: 30, write_start: 0, write_end: 0 },
    }))).toEqual({ writeValid: 2, writeDays: 30, writeStart: 0, writeEnd: 0 });
    expect(parseSecondCardValiditySnapshot(JSON.stringify({
      productInfo: { attrInfo: { write_valid: 3, write_days: 0, write_start: 100, write_end: 200 } },
    }))).toEqual({ writeValid: 3, writeDays: 0, writeStart: 100, writeEnd: 200 });
    expect(parseSecondCardValiditySnapshot("{bad-json")).toBeNull();
  });

  it("永久和固定区间在下单时稳定，购买后天数等待支付激活", () => {
    expect(resolveSecondCardValidityAtCheckout({
      writeValid: 1, writeDays: 0, writeStart: 0, writeEnd: 0,
    })).toEqual({ writeStart: 0, writeEnd: 0 });
    expect(resolveSecondCardValidityAtCheckout({
      writeValid: 2, writeDays: 7, writeStart: 0, writeEnd: 0,
    })).toEqual({ writeStart: 0, writeEnd: 0 });
    expect(resolveSecondCardValidityAtCheckout({
      writeValid: 3, writeDays: 0, writeStart: 100, writeEnd: 200,
    })).toEqual({ writeStart: 100, writeEnd: 200 });
  });

  it("购买后 N 天从支付时间起算且重放不漂移", () => {
    const snapshot = { writeValid: 2 as const, writeDays: 7, writeStart: 0, writeEnd: 0 };
    const activated = resolveSecondCardValidityAtPayment(snapshot, 1_800_000_000, {
      writeStart: 0,
      writeEnd: 0,
    });
    expect(activated).toEqual({ writeStart: 1_800_000_000, writeEnd: 1_800_604_800 });
    expect(resolveSecondCardValidityAtPayment(snapshot, 1_800_000_100, activated)).toEqual(activated);
  });

  it("缺失旧快照时只保留已持久化窗口，不读取可变实时 SKU", () => {
    expect(resolveSecondCardValidityAtPayment(null, 1_800_000_000, {
      writeStart: 100,
      writeEnd: 200,
    })).toEqual({ writeStart: 100, writeEnd: 200 });
    expect(resolveSecondCardValidityAtPayment(null, 1_800_000_000, {
      writeStart: 0,
      writeEnd: 0,
    })).toEqual({ writeStart: 0, writeEnd: 0 });
  });

  it("拒绝无效配置和整数溢出", () => {
    expect(() => resolveSecondCardValidityAtCheckout({
      writeValid: 2, writeDays: 0, writeStart: 0, writeEnd: 0,
    })).toThrow("有效天数无效");
    expect(() => resolveSecondCardValidityAtCheckout({
      writeValid: 3, writeDays: 0, writeStart: 200, writeEnd: 100,
    })).toThrow("固定有效期无效");
    expect(() => resolveSecondCardValidityAtPayment(
      { writeValid: 2, writeDays: 10_000, writeStart: 0, writeEnd: 0 },
      2_100_000_000,
      { writeStart: 0, writeEnd: 0 },
    )).toThrow("超过安全范围");
    expect(() => resolveSecondCardValidityAtPayment(
      { writeValid: 2, writeDays: 7, writeStart: 0, writeEnd: 0 },
      1_800_000_000,
      { writeStart: 0, writeEnd: 100 },
    )).toThrow("历史有效期无效");
  });

  it("接入订单快照、Supplier 分配后的支付 outbox 和数据库行锁", () => {
    const create = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const outbox = readFileSync("src/services/order/OrderOutboxService.ts", "utf8");
    const service = readFileSync("src/services/order/SecondCardValidityService.ts", "utf8");
    expect(create).toContain("resolveSecondCardValidityAtCheckout");
    expect(create).toContain("write_valid: sku.writeValid");
    expect(outbox.indexOf("allocatePaidOrderBySupplier")).toBeLessThan(
      outbox.indexOf("activatePaidSecondCardValidity(tx, allocation.fulfillmentOrders, order.payTime)"),
    );
    expect(outbox).not.toContain("activatePaidSecondCardValidity(tx, allocation.fulfillmentOrders, now)");
    expect(service).toContain('.for("update")');
    expect(service).toContain("次卡有效期发生并发变化");
  });

  it("生产隔离审计只使用令牌保护的临时 Worker 并强制清理", () => {
    const scenario = readFileSync("test/integration/SecondCardValidityPostgresScenario.ts", "utf8");
    const worker = readFileSync("test/integration/SecondCardValidityAuditWorker.ts", "utf8");
    const config = readFileSync("test/integration/second-card-validity-audit.wrangler.jsonc", "utf8");
    const runner = readFileSync("scripts/run-second-card-validity-production-audit.ps1", "utf8");
    expect(scenario).toContain("SET LOCAL search_path");
    expect(scenario).toContain("public_state_unchanged");
    expect(worker).toContain("AUDIT_TOKEN_SHA256");
    expect(config).toContain('"global_fetch_strictly_public"');
    expect(runner).toContain("wrangler delete $taskAuditName");
    expect(runner).toContain("url_returns_404");
    expect(runner).not.toContain("RandomNumberGenerator]::Fill");
    expect(runner).not.toContain("SHA256]::HashData");
  });
});
