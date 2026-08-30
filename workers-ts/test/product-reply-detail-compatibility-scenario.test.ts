import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const audit = readFileSync(resolve(root, "test/integration/ProductReplyDetailAuditWorker.ts"), "utf8");
const scenario = readFileSync(
  resolve(root, "test/integration/ProductReplyDetailCompatibilityScenario.ts"),
  "utf8",
);
const config = readFileSync(
  resolve(root, "test/integration/product-reply-detail-audit.wrangler.jsonc"),
  "utf8",
);

describe("API-007 product reply production audit gates", () => {
  it("binds only the temporary audit Worker to the authorized Hyperdrive", () => {
    expect(config).toContain('"name": "cinashop-product-reply-detail-audit"');
    expect(config).toContain('"main": "ProductReplyDetailAuditWorker.ts"');
    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
    expect(config).toContain('"global_fetch_strictly_public"');
  });

  it("uses distinct timing-safe hashed tokens and POST-only endpoints", () => {
    expect(audit).toContain("AUDIT_READ_TOKEN_SHA256");
    expect(audit).toContain("AUDIT_ISOLATED_TOKEN_SHA256");
    expect(audit).toContain("readHash.toLowerCase() === isolatedHash.toLowerCase()");
    expect(audit).toContain("crypto.subtle.timingSafeEqual");
    expect(audit).toContain('request.method !== "POST"');
    expect(audit).toContain('["/audit", "/isolated-scenario"]');
    expect(audit).toContain('"Cache-Control": "private, no-store"');
  });

  it("pins production inspection to a read-only public snapshot", () => {
    expect(audit).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(audit).toContain("SET LOCAL search_path TO public, pg_temp");
    expect(audit).toContain("SET LOCAL statement_timeout = '45s'");
    expect(audit).toContain("to_regclass('store_product_reply')");
    expect(audit).toContain('resolution.resolved_schema === "public"');
  });

  it("returns only bounded review, reply, relation, config and index aggregates", () => {
    for (const marker of [
      "praise_counter_drift_rows",
      "active_rows_with_hidden_parent",
      "review_target_orphan_rows",
      "comment_target_orphan_rows",
      "duplicate_non_play_groups",
      "required_keys_missing",
      "non_play_unique_index_ready",
    ]) expect(audit).toContain(marker);
    expect(audit).toContain("comments_or_names_returned: false");
    expect(audit).toContain("configuration_values_returned: false");
    expect(audit).toContain("urls_or_user_ids_returned: false");
    expect(audit).toContain("business_ids_returned: false");
  });

  it("clones named tables, rebinds serials and keeps pg_temp last", () => {
    for (const table of [
      "store_product", "store_product_reply", "store_product_reply_comment", "user",
      "user_relation", "system_user_level", "system_config",
    ]) expect(scenario).toContain(`"${table}"`);
    expect(scenario).toContain("LIKE public.${name} INCLUDING ALL");
    expect(scenario).toContain("CREATE SEQUENCE ${schema}.${sequence}");
    expect(scenario).toContain("unexpected sequence-backed column");
    expect(scenario).toContain("SET LOCAL search_path TO ${schema}, pg_temp");
    expect(scenario).toContain("to_regclass('store_product_reply')");
  });

  it("executes real service visibility, content, concurrency and rollback cases", () => {
    expect(scenario).toContain("new ReplyService(container)");
    expect(scenario).toContain("service.replyInfo(IDS.visibleReply");
    expect(scenario).toContain("service.replyComment(IDS.userA");
    expect(scenario).toContain("service.praiseComment(IDS.userA");
    expect(scenario).toContain("service.unpraiseComment(IDS.userA");
    expect(scenario).toContain("await Promise.all([");
    expect(scenario).toContain("installRollbackTrigger");
    expect(scenario).toContain("contentValidation");
    expect(scenario).toContain("visibility_fail_closed");
  });

  it("fingerprints public rows/sequences and guards cleanup", () => {
    expect(scenario).toContain("hashtextextended(to_jsonb(source)::text, 0)");
    expect(scenario).toContain("FROM pg_sequences");
    expect(scenario).toContain("pg_try_advisory_lock(1721, 7)");
    expect(scenario).toContain("pg_advisory_unlock(1721, 7)");
    expect(scenario).toContain("before = await publicFingerprint(admin)");
    expect(scenario).toContain("const after = await publicFingerprint(admin)");
    expect(scenario).toContain("schemaName.startsWith(PRODUCT_REPLY_SCHEMA_PREFIX)");
    expect(scenario).toContain("DROP SCHEMA ${identifier(schemaName)} CASCADE");
    expect(scenario).toContain("public_schema_ddl_or_dml_executed: false");
    expect(scenario).toContain("lockDb.$client.end");
  });
});
