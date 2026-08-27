import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTransferRequestKey } from "../src/services/kefu/KefuTransferService";

describe("customer-service transfer migration", () => {
  it("accepts UUID idempotency keys, normalizes case and rejects ambiguous values", () => {
    expect(parseTransferRequestKey("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"))
      .toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(parseTransferRequestKey(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => parseTransferRequestKey("retry-me")).toThrow("转接请求键无效");
  });

  it("keeps the external and Worker-embedded transfer DDL byte-equivalent", () => {
    const migration = readFileSync("migrations/0094_kefu_transfer_audit.sql", "utf8").trim();
    const embedded = readFileSync("src/services/MigrationService.ts", "utf8")
      .match(/private migration_0101\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('PRIMARY KEY');
    expect(migration).toContain('"sst_customer_time"');
    expect(migration).toContain('"sst_target_time"');
    expect(migration).not.toContain('"msn"');
  });

  it("serializes ownership changes, persists before notification and closes stale grants", () => {
    const transfer = readFileSync("src/services/kefu/KefuTransferService.ts", "utf8");
    const controller = readFileSync("src/controllers/kefu/KefuController.ts", "utf8");
    const realtime = readFileSync("src/services/kefu/KefuRealtimeService.ts", "utf8");
    const durableObject = readFileSync("src/do/ChatRoomDO.ts", "utf8");

    expect(transfer).toContain("pg_advisory_xact_lock");
    expect(transfer).toContain("storeServiceTransfer");
    expect(transfer.indexOf("delete(storeServiceRecord)")).toBeLessThan(
      transfer.indexOf("insert(storeServiceTransfer)"),
    );
    expect(controller.indexOf(".transfer(")).toBeLessThan(
      controller.indexOf("Promise.allSettled"),
    );
    expect(controller).toContain('type: "transfer_out"');
    expect(controller).toContain('type: "transfer"');
    expect(controller).toContain('type: "to_transfer"');
    expect(durableObject).toContain("session.toUid = 0");
    expect(durableObject).toContain("session.toUid = event.data.toUid");
    expect(realtime).toContain("assertConversationAssignment");
    expect(realtime).toContain("客服会话已转接，请刷新后重试");
  });
});
