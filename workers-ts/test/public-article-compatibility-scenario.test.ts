import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const auditSource = readFileSync(
  resolve(root, "test/integration/PublicArticleAuditWorker.ts"),
  "utf8",
);
const scenarioSource = readFileSync(
  resolve(root, "test/integration/PublicArticleCompatibilityScenario.ts"),
  "utf8",
);
const configSource = readFileSync(
  resolve(root, "test/integration/public-article-audit.wrangler.jsonc"),
  "utf8",
);

describe("PUBLIC-ARTICLE production audit gates", () => {
  it("binds only the temporary audit Worker to the authorized Hyperdrive", () => {
    expect(configSource).toContain('"name": "cinashop-public-article-audit"');
    expect(configSource).toContain('"main": "PublicArticleAuditWorker.ts"');
    expect(configSource).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
    expect(configSource).toContain('"nodejs_compat"');
    expect(configSource).toContain('"global_fetch_strictly_public"');
    expect(configSource).toContain('"cpu_ms": 120000');
  });

  it("uses a timing-safe hashed Bearer gate and POST-only endpoints", () => {
    expect(auditSource).toContain("AUDIT_READ_TOKEN_SHA256");
    expect(auditSource).toContain("AUDIT_ISOLATED_TOKEN_SHA256");
    expect(auditSource).toContain("readHash.toLowerCase() === isolatedHash.toLowerCase()");
    expect(auditSource).toContain('url.pathname === "/audit" ? readHash : isolatedHash');
    expect(auditSource).toContain("crypto.subtle.timingSafeEqual");
    expect(auditSource).toContain('request.method !== "POST"');
    expect(auditSource).toContain('["/audit", "/isolated-scenario"]');
    expect(auditSource).toContain('status: 403');
    expect(auditSource).toContain('"Cache-Control": "private, no-store"');
  });

  it("pins every production query to a read-only public snapshot", () => {
    expect(auditSource).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(auditSource).toContain("SET LOCAL search_path TO public, pg_temp");
    expect(auditSource).toContain("SET LOCAL statement_timeout = '45s'");
    expect(auditSource).toContain("SET LOCAL lock_timeout = '2s'");
    expect(auditSource).toContain("to_regclass('system_article')");
    expect(auditSource).toContain('resolution.resolved_schema === "public"');
  });

  it("returns only aggregates for content, users, media, and indexes", () => {
    for (const marker of [
      "like_counter_drift_rows",
      "dangerous_tag_rows",
      "inline_event_rows",
      "dangerous_scheme_rows",
      "encoded_url_entity_rows",
      "cover_tokens",
      "other_cover_tokens",
      "missing_article_tokens",
      "owner_orphan_rows",
      "target_orphan_rows",
      "index_aggregates",
      "article_like_partial_unique_ready",
      "correctness_requires_new_index: !articleLikeIndexReady",
    ]) expect(auditSource).toContain(marker);
    expect(auditSource).toContain("titles_or_bodies_returned: false");
    expect(auditSource).toContain("urls_or_user_ids_returned: false");
    expect(auditSource).toContain("business_ids_returned: false");
    expect(auditSource).not.toContain("SELECT title,");
  });

  it("clones only named tables and rebinds every serial sequence", () => {
    for (const table of [
      "system_article",
      "article_category",
      "article_content",
      "store_product",
      "wechat_news_category",
      "user_relation",
    ]) expect(scenarioSource).toContain(`"${table}"`);
    expect(scenarioSource).toContain("LIKE public.${name} INCLUDING ALL");
    expect(scenarioSource).toContain("CREATE SEQUENCE ${schema}.${sequence}");
    expect(scenarioSource).toContain("SET DEFAULT nextval('${schemaName}.${sequenceName}'::regclass)");
    expect(scenarioSource).toContain("unexpected production sequence-backed column");
    expect(scenarioSource).toContain("identity-backed columns require a dedicated isolated clone path");
    expect(scenarioSource).toContain("isolated serial default still points outside its schema");
  });

  it("keeps pg_temp last and checks unqualified table resolution", () => {
    expect(scenarioSource).toContain("SET LOCAL search_path TO ${schema}, pg_temp");
    expect(scenarioSource).toContain("to_regclass('system_article')");
    expect(scenarioSource).toContain('row?.configured_path === `${schemaName}, pg_temp`');
    expect(scenarioSource).toContain('row?.resolved_schema === schemaName');
  });

  it("tests real service side effects, concurrency, visibility, and rollback", () => {
    expect(scenarioSource).toContain("new PublicArticleCompatibilityService(container)");
    expect(scenarioSource).toContain("const concurrentDetails = await Promise.all");
    expect(scenarioSource).toContain("likeIdempotent");
    expect(scenarioSource).toContain("likeConcurrent");
    expect(scenarioSource).toContain("anonymousRejected");
    expect(scenarioSource).toContain("installRollbackTrigger");
    expect(scenarioSource).toContain("visibilityOk: hiddenRejected && inactiveRejected && deletedRejected");
    expect(scenarioSource).toContain("body_product_category");
  });

  it("fingerprints public rows and sequences around guarded cleanup", () => {
    expect(scenarioSource).toContain("hashtextextended(to_jsonb(source)::text, 0)");
    expect(scenarioSource).toContain("FROM pg_sequences");
    expect(scenarioSource).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(scenarioSource).toContain("SET LOCAL statement_timeout = '30s'");
    expect(scenarioSource).toContain("pg_try_advisory_lock(1346981441, 1381258324)");
    expect(scenarioSource).toContain("pg_advisory_unlock(1346981441, 1381258324)");
    expect(scenarioSource).toContain("before = await publicFingerprint(adminDb)");
    expect(scenarioSource).toContain("const after = await publicFingerprint(adminDb)");
    expect(scenarioSource).toContain("schemaName.startsWith(PUBLIC_ARTICLE_SCHEMA_PREFIX)");
    expect(scenarioSource).toContain("DROP SCHEMA ${identifier(schemaName)} CASCADE");
    expect(scenarioSource).toContain("isolated_schema_ddl_and_fixture_dml_executed: true");
    expect(scenarioSource).toContain("public_schema_ddl_or_dml_executed: false");
    expect(scenarioSource).toContain("concurrent_public_writes_can_fail_verification: true");
    expect(scenarioSource).toContain("lockDb.$client.end");
  });
});
