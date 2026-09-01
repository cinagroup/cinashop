import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workerSource = readFileSync(
  "test/integration/DiyHomeWidgetsAuditWorker.ts",
  "utf8",
);
const scenarioSource = readFileSync(
  "test/integration/DiyHomeWidgetsCompatibilityScenario.ts",
  "utf8",
);
const wranglerConfig = JSON.parse(readFileSync(
  "test/integration/diy-home-widgets-audit.wrangler.jsonc",
  "utf8",
)) as Record<string, unknown>;

function sourceBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

const publicTables = [
  "system_dise",
  "system_config",
  "user",
  "system_user_level",
  "store_coupon_user",
  "user_relation",
  "store_product_log",
  "video",
  "live_room",
  "store_product",
  "store_newcomer",
  "store_order",
  "store_coupon_issue",
  "system_sign_reward",
  "user_sign",
  "store_brand",
  "store_product_label",
  "member_right",
  "store_coupon_product",
  "store_seckill",
  "store_combination",
  "store_bargain",
  "store_promotions",
  "store_promotions_auxiliary",
] as const;

const configKeys = [
  "station_open",
  "routine_contact_type",
  "image_thumb_status",
  "image_watermark_status",
  "thumb_big_width",
  "thumb_big_height",
  "thumb_mid_width",
  "thumb_mid_height",
  "thumb_small_width",
  "thumb_small_height",
  "watermark_type",
  "watermark_text",
  "watermark_text_angle",
  "watermark_text_color",
  "watermark_text_size",
  "watermark_position",
  "watermark_image",
  "watermark_opacity",
  "watermark_rotate",
  "watermark_x",
  "watermark_y",
  "upload_type",
  "site_url",
  "video_func_status",
  "site_name",
  "wap_login_logo",
  "newcomer_status",
  "register_integral_status",
  "register_give_integral",
  "register_coupon_status",
  "register_give_coupon",
  "register_price_status",
  "newcomer_limit_status",
  "newcomer_limit_time",
  "member_card_status",
  "svip_price_status",
  "sign_give_point",
  "member_func_status",
  "sign_give_exp",
  "sign_status",
] as const;

const supportTables = ["store_product_relation", "store_seckill_time"] as const;

describe("DIY-HOME-WIDGETS production audit and isolated scenario", () => {
  it("pins the exact non-secret public dependency and configuration allowlists", () => {
    expect(publicTables).toHaveLength(24);
    expect(configKeys).toHaveLength(40);
    for (const table of publicTables) {
      expect(scenarioSource).toContain(`"${table}"`);
    }
    for (const table of supportTables) {
      expect(scenarioSource).toContain(`"${table}"`);
    }
    for (const key of configKeys) {
      expect(workerSource).toContain(`"${key}"`);
    }
    expect(workerSource).not.toMatch(/WECHAT_|ALIPAY_|UPSTASH_|PRIVATE_KEY|API_V3_KEY/);
  });

  it("ships a token-protected, no-store temporary Worker on the production Hyperdrive", () => {
    expect(workerSource).toContain("AUDIT_TOKEN_SHA256");
    expect(workerSource).toContain("crypto.subtle.digest");
    expect(workerSource).toContain("crypto.subtle.timingSafeEqual");
    expect(workerSource).toContain('request.method !== "POST"');
    expect(workerSource).toContain('"/audit"');
    expect(workerSource).toContain('"/apply-user-center-indexes"');
    expect(workerSource).toContain('"/isolated-scenario"');
    expect(workerSource).toContain('"Cache-Control": "private, no-store"');
    expect(workerSource).toContain("satisfies ExportedHandler<AuditEnv>");

    expect(wranglerConfig).toMatchObject({
      name: "cinashop-diy-home-widgets-audit",
      main: "DiyHomeWidgetsAuditWorker.ts",
      workers_dev: true,
      compatibility_date: "2026-08-29",
    });
    expect(wranglerConfig.compatibility_flags).toEqual(expect.arrayContaining([
      "nodejs_compat",
      "global_fetch_strictly_public",
    ]));
    expect(wranglerConfig.hyperdrive).toEqual([{
      binding: "HYPERDRIVE",
      id: "9748c294e21c49a99579c9cef70102e0",
    }]);
    expect(JSON.stringify(wranglerConfig)).not.toContain("AUDIT_TOKEN_SHA256");
  });

  it("applies the user-center index migration twice with row fingerprints unchanged", () => {
    const apply = sourceBlock(
      workerSource,
      "async function applyUserCenterIndexes(",
      "export default {",
    );
    expect(apply).toContain("USER_CENTER_COMPATIBILITY_INDEX_SQL");
    expect(apply.match(/tx\.unsafe\(USER_CENTER_COMPATIBILITY_INDEX_SQL\)/g)).toHaveLength(2);
    expect(apply).toContain("pg_advisory_xact_lock(731625, 105)");
    expect(apply).toContain("type <> 'play'");
    expect(apply).toContain("md5(to_jsonb(address_row)::text)");
    expect(apply).toContain("md5(to_jsonb(relation_row)::text)");
    expect(apply).toContain("md5(to_jsonb(sign_row)::text)");
    expect(apply).toContain("JSON.stringify(before) === JSON.stringify(after)");
    expect(apply).toContain("dmlExecuted: false");
    expect(apply).toContain("businessRowsUnchanged: true");
    expect(apply).toContain("fingerprintsReturned: false");
  });

  it("keeps production aggregation repeatable-read, read-only and structurally redacted", () => {
    const production = sourceBlock(
      workerSource,
      "async function productionAggregates(",
      "async function withProductionService<",
    );
    expect(production).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(production).toContain("SET LOCAL search_path TO public, pg_temp");
    expect(production).toContain("current_setting('search_path')");
    expect(production).toContain("to_regclass('system_dise')");
    expect(production).toContain("SET LOCAL statement_timeout");
    expect(production).toContain("SET LOCAL lock_timeout");
    expect(production).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/);
    expect(production).not.toContain("selected_value");
    expect(production).not.toContain("jsonb_agg(value");
    expect(production).not.toContain("array_agg(value");
    expect(production).toContain("configurationValuesReturned: false");
    expect(production).toContain("enabledRows");
    expect(production).toContain("boundedDimensionRows");
    expect(production).toContain("piiReturned: false");
    expect(production).toContain("businessIdsReturned: false");
    expect(production).toContain("mediaReferencesReturned: false");
    expect(production).toContain("dmlOrDdlExecuted: false");
    expect(workerSource).toContain("contractShape");
    expect(workerSource).not.toContain("recordPlays(");
  });

  it("fingerprints all public rows plus sequence state and rebinds every clone identity", () => {
    expect(scenarioSource).toContain("md5(to_jsonb(source_row)::text)");
    expect(scenarioSource).toContain("string_agg(row_digest, '|' ORDER BY row_digest)");
    expect(scenarioSource).toContain("last_value::text AS last_value, is_called");
    expect(scenarioSource).toContain("dependency.deptype IN ('a', 'i')");
    expect(scenarioSource).toContain("(LIKE public.${table} INCLUDING ALL)");
    expect(scenarioSource).toContain("DROP IDENTITY IF EXISTS");
    expect(scenarioSource).toContain("ADD GENERATED BY DEFAULT AS IDENTITY");
    expect(scenarioSource).toContain("external_default_sequences");
    expect(scenarioSource).toContain("external_owned_sequences");
    expect(scenarioSource).toContain("external sequence dependency");
    expect(scenarioSource).toContain("sameSnapshot(before, after)");
    expect(scenarioSource).toContain("publicRowsAndSequencesUnchanged: true");
    expect(scenarioSource).toContain("publicTablesFingerprinted: DIY_HOME_PUBLIC_TABLES.length");
    expect(scenarioSource).toContain("supportTablesFingerprinted: DIY_HOME_SUPPORT_TABLES.length");
    expect(scenarioSource).toContain("publicSequencesFingerprinted: before.sequences.length");
  });

  it("pins every fixture, service and direct query to one schema with fail-closed bindings", () => {
    const isolatedTransaction = sourceBlock(
      scenarioSource,
      "async function withIsolatedTransaction<T>(",
      "async function seedFixture(",
    );
    expect(isolatedTransaction).toContain("SET LOCAL search_path TO ${schema}, pg_temp");
    expect(isolatedTransaction).toContain("SET LOCAL TIME ZONE 'UTC'");
    expect(isolatedTransaction).toContain("current_schema()");
    expect(isolatedTransaction).toContain("current_setting('search_path')");
    expect(isolatedTransaction).toContain("to_regclass('system_dise')");
    expect(isolatedTransaction).toContain('configuredPath[1] === "pg_temp"');
    expect(isolatedTransaction).toContain("pinned.resolved_schema === schemaName");
    expect(scenarioSource).toContain("crypto.randomUUID()");
    expect(scenarioSource).toContain("new Proxy(env");
    expect(scenarioSource).toContain("isolated DIY service attempted external binding access");
    expect(scenarioSource).toContain("diy-home-widgets-isolated-fixture-key");
    expect(scenarioSource).toContain("realExternalBindingsUsed: false");
    expect(scenarioSource).not.toContain("...env");
  });

  it("calls every core compatibility method and confines playback writes to the isolate", () => {
    const methods = [
      "getDiy",
      "diyVersion",
      "userInfo",
      "videoList",
      "newcomerList",
      "productRank",
      "homeSign",
      "suspended",
    ];
    for (const method of methods) {
      expect(scenarioSource).toContain(`service.${method}(`);
      expect(workerSource).toContain(`service.${method}(`);
    }
    const isolatedVideo = sourceBlock(
      scenarioSource,
      "async function exerciseVideo(",
      "function newcomerProductCount(",
    );
    expect(isolatedVideo).toContain(".recordPlays(playIds, 0)");
    expect(isolatedVideo).toContain("readPathDidNotWrite");
    expect(isolatedVideo).toContain("isolatedPlaybackWrite");
    expect(isolatedVideo).toContain("withIsolatedTransaction");
  });

  it("drops the random schema in finally and verifies namespace cleanup before returning", () => {
    const runner = sourceBlock(
      scenarioSource,
      "export async function runDiyHomeWidgetsCompatibilityScenario(",
      "  } finally {\n    await admin.end",
    );
    expect(runner).toContain("} finally {");
    expect(runner).toContain("await dropIsolatedSchema(admin, schemaName)");
    expect(runner).toContain("const dropped = !(await schemaExists(admin, schemaName))");
    expect(runner).toContain("isolatedSchemaDropped: true");
    expect(runner).toContain("temporarySchemaCountUnchanged: true");
    expect(runner).toContain("fixtureDataReturned: false");
  });
});
