import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const audit = readFileSync(resolve(root, "test/integration/StoreMobileOrderAuditWorker.ts"), "utf8");
const scenario = readFileSync(
  resolve(root, "test/integration/StoreMobileOrderCompatibilityScenario.ts"),
  "utf8",
);
const config = readFileSync(
  resolve(root, "test/integration/store-mobile-order-audit.wrangler.jsonc"),
  "utf8",
);

describe("API-008 STORE-B production audit gates", () => {
  it("binds only the temporary audit Worker to the authorized Hyperdrive", () => {
    expect(config).toContain('"name": "cinashop-store-mobile-order-audit"');
    expect(config).toContain('"main": "StoreMobileOrderAuditWorker.ts"');
    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
    expect(config).toContain('"global_fetch_strictly_public"');
  });

  it("uses distinct timing-safe hashed tokens and POST-only endpoints", () => {
    expect(audit).toContain("AUDIT_READ_TOKEN_SHA256");
    expect(audit).toContain("AUDIT_ISOLATED_TOKEN_SHA256");
    expect(audit).toContain("crypto.subtle.timingSafeEqual");
    expect(audit).toContain("new Set(hashes.map");
    expect(audit).toContain('request.method !== "POST"');
    expect(audit).toContain('["/audit", "/isolated-scenario"]');
    expect(audit).toContain('"Cache-Control": "private, no-store"');
  });

  it("pins production inspection to a bounded read-only snapshot", () => {
    expect(audit).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(audit).toContain("SET LOCAL search_path TO public, pg_temp");
    expect(audit).toContain("SET LOCAL statement_timeout = '45s'");
    expect(audit).toContain("duplicate_active_verify_code_groups");
    expect(audit).toContain("ownership_mismatch_rows");
    expect(audit).toContain("duplicate_store_config_groups");
    expect(audit).toContain("names_phones_addresses_barcodes_codes_or_snapshots_returned: false");
  });

  it("clones every dependency with rebound serials and pg_temp last", () => {
    for (const table of [
      "user", "system_store", "system_store_staff", "delivery_service", "store_service",
      "store_service_record", "store_order", "store_order_cart_info", "store_order_refund",
      "store_order_status", "store_order_promotions", "store_coupon_issue", "store_pink",
      "store_config", "system_config", "express_company", "order_waybill_job", "store_order_outbox",
    ]) expect(scenario).toContain(`"${table}"`);
    expect(scenario).toContain("LIKE public.${name} INCLUDING ALL");
    expect(scenario).toContain("CREATE SEQUENCE ${schema}.${sequence}");
    expect(scenario).toContain("SET LOCAL search_path TO ${schema}, pg_temp");
  });

  it("executes real STORE-B reads, authorization, writeoff lookup, and split fulfillment", () => {
    expect(scenario).toContain("new StoreMobileOrderService(container, env)");
    expect(scenario).toContain("service.orderDetail(IDS.clerkUid");
    expect(scenario).toContain("service.refundDetail(IDS.clerkUid");
    expect(scenario).toContain("service.deliveryInfo(IDS.clerkUid");
    expect(scenario).toContain("service.writeoffInfo(");
    expect(scenario).toContain("service.writeoffCartInfo(");
    expect(scenario).toContain("service.splitDelivery(IDS.clerkUid");
    expect(scenario).toContain("store_idor_closed");
    expect(scenario).toContain("kefu_conversation_bound");
    expect(scenario).toContain("auth_zero_rejected");
    expect(scenario).toContain("split_audit_and_outbox");
  });

  it("fingerprints public state, single-flights the run, and guards cleanup", () => {
    expect(scenario).toContain("hashtextextended(to_jsonb(source)::text, 0)");
    expect(scenario).toContain("FROM pg_sequences");
    expect(scenario).toContain("pg_try_advisory_lock(1829, 8)");
    expect(scenario).toContain("pg_advisory_unlock(1829, 8)");
    expect(scenario).toContain("schemaName.startsWith(STORE_MOBILE_ORDER_SCHEMA_PREFIX)");
    expect(scenario).toContain("DROP SCHEMA ${identifier(schemaName)} CASCADE");
    expect(scenario).toContain("public_schema_ddl_or_dml_executed: false");
  });
});
