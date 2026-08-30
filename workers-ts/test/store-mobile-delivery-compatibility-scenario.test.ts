import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const audit = readFileSync(resolve(root, "test/integration/StoreMobileDeliveryAuditWorker.ts"), "utf8");
const scenario = readFileSync(
  resolve(root, "test/integration/StoreMobileDeliveryCompatibilityScenario.ts"),
  "utf8",
);
const migration = readFileSync(resolve(root, "migrations/0107_store_mobile_delivery_index.sql"), "utf8");
const config = readFileSync(
  resolve(root, "test/integration/store-mobile-delivery-audit.wrangler.jsonc"),
  "utf8",
);

describe("API-008 STORE-A production audit gates", () => {
  it("binds only the temporary audit Worker to the authorized Hyperdrive", () => {
    expect(config).toContain('"name": "cinashop-store-mobile-delivery-audit"');
    expect(config).toContain('"main": "StoreMobileDeliveryAuditWorker.ts"');
    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
    expect(config).toContain('"global_fetch_strictly_public"');
  });

  it("uses three distinct timing-safe hashed tokens and POST-only endpoints", () => {
    for (const marker of [
      "AUDIT_READ_TOKEN_SHA256", "AUDIT_INDEX_TOKEN_SHA256", "AUDIT_ISOLATED_TOKEN_SHA256",
    ]) expect(audit).toContain(marker);
    expect(audit).toContain("crypto.subtle.timingSafeEqual");
    expect(audit).toContain("new Set(hashes.map");
    expect(audit).toContain('request.method !== "POST"');
    expect(audit).toContain('["/audit", "/apply-index", "/isolated-scenario"]');
    expect(audit).toContain('"Cache-Control": "private, no-store"');
  });

  it("pins the production inspection to a read-only public snapshot", () => {
    expect(audit).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(audit).toContain("SET LOCAL search_path TO public, pg_temp");
    expect(audit).toContain("SET LOCAL statement_timeout = '45s'");
    expect(audit).toContain("to_regclass('delivery_service')");
    expect(audit).toContain('resolution.resolved_schema === "public"');
  });

  it("returns only bounded identity, staff, assigned-order and index aggregates", () => {
    for (const marker of [
      "duplicate_active_platform_groups", "duplicate_active_store_scope_groups",
      "duplicate_active_uid_groups", "active_delivery_orphan_rows", "target_index_exists",
    ]) expect(audit).toContain(marker);
    expect(audit).toContain("names_phones_addresses_or_snapshots_returned: false");
    expect(audit).toContain("user_or_business_ids_returned: false");
  });

  it("adds and strictly verifies the bounded delivery-order partial index", () => {
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "so_delivery_mobile_active"');
    expect(migration).toContain('("delivery_uid", "status", "add_time" DESC, "id" DESC)');
    expect(migration).toContain('"refund_status" IN (0, 3)');
    expect(migration).toContain("indexed.indisvalid");
    expect(migration).toContain("actual.key_columns IS DISTINCT FROM");
    expect(migration).toContain("actual.key_options IS DISTINCT FROM");
    expect(migration).toContain("actual.predicate_sql IS DISTINCT FROM");
    expect(audit).toContain("business_rows_and_sequence_unchanged");
  });

  it("clones exactly six named tables, rebinds serials and keeps pg_temp last", () => {
    for (const table of [
      "user", "system_store", "system_store_staff", "delivery_service",
      "store_order", "store_order_cart_info",
    ]) expect(scenario).toContain(`"${table}"`);
    expect(scenario).toContain("LIKE public.${name} INCLUDING ALL");
    expect(scenario).toContain("CREATE SEQUENCE ${schema}.${sequence}");
    expect(scenario).toContain("unexpected sequence-backed column");
    expect(scenario).toContain("SET LOCAL search_path TO ${schema}, pg_temp");
    expect(scenario).toContain("to_regclass('delivery_service')");
  });

  it("executes the real service shape, scope, aggregate and snapshot cases", () => {
    expect(scenario).toContain("new StoreMobileDeliveryService(container)");
    expect(scenario).toContain("service.info(IDS.deliveryUser)");
    expect(scenario).toContain("service.statistics(IDS.deliveryUser");
    expect(scenario).toContain("service.data(IDS.deliveryUser");
    expect(scenario).toContain("service.orders(IDS.deliveryUser");
    expect(scenario).toContain("service.deliveryList(IDS.clerkUser");
    expect(scenario).toContain("duplicate_delivery_fail_closed");
    expect(scenario).toContain("duplicate_staff_fail_closed");
    expect(scenario).toContain("private-malformed-sentinel");
  });

  it("fingerprints public rows/sequences and guards cleanup", () => {
    expect(scenario).toContain("hashtextextended(to_jsonb(source)::text, 0)");
    expect(scenario).toContain("FROM pg_sequences");
    expect(scenario).toContain("pg_try_advisory_lock(1728, 8)");
    expect(scenario).toContain("pg_advisory_unlock(1728, 8)");
    expect(scenario).toContain("before = await publicFingerprint(admin)");
    expect(scenario).toContain("const after = await publicFingerprint(admin)");
    expect(scenario).toContain("schemaName.startsWith(STORE_MOBILE_DELIVERY_SCHEMA_PREFIX)");
    expect(scenario).toContain("DROP SCHEMA ${identifier(schemaName)} CASCADE");
    expect(scenario).toContain("public_schema_ddl_or_dml_executed: false");
  });
});
