import { createDbFromConnectionString, type DbClient } from "@/lib/di";
import { runOutApiFulfillmentPostgresScenario } from "./OutApiFulfillmentPostgresScenario";
import { runOutApiHardeningPostgresScenario } from "./OutApiHardeningPostgresScenario";
import { runOutApiInvoicePostgresScenario } from "./OutApiInvoicePostgresScenario";
import { runOutApiRefundDecisionPostgresScenario } from "./OutApiRefundDecisionPostgresScenario";
import { runOutApiRefundMoneyPostgresScenario } from "./OutApiRefundMoneyPostgresScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS "out_api_audit" (
  "id" BIGSERIAL PRIMARY KEY,
  "out_account_id" INTEGER DEFAULT 0 NOT NULL,
  "appid_snapshot" VARCHAR(50) DEFAULT '' NOT NULL,
  "method" VARCHAR(12) DEFAULT '' NOT NULL,
  "route_template" VARCHAR(128) DEFAULT '' NOT NULL,
  "operation" VARCHAR(16) DEFAULT 'read' NOT NULL,
  "resource_hash" VARCHAR(64) DEFAULT '' NOT NULL,
  "query_fields" VARCHAR(255) DEFAULT '' NOT NULL,
  "ip_hash" VARCHAR(64) DEFAULT '' NOT NULL,
  "user_agent_hash" VARCHAR(64) DEFAULT '' NOT NULL,
  "outcome" VARCHAR(16) DEFAULT 'success' NOT NULL,
  "result_code" INTEGER DEFAULT 200 NOT NULL,
  "duration_ms" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "out_audit_operation_ck" CHECK ("operation" IN ('read', 'write')),
  CONSTRAINT "out_audit_outcome_ck" CHECK ("outcome" IN ('success', 'denied', 'rate_limited', 'error')),
  CONSTRAINT "out_audit_result_code_ck" CHECK ("result_code" BETWEEN 0 AND 999999),
  CONSTRAINT "out_audit_duration_ck" CHECK ("duration_ms" BETWEEN 0 AND 3600000),
  CONSTRAINT "out_audit_add_time_ck" CHECK ("add_time" >= 0),
  CONSTRAINT "out_audit_hashes_ck" CHECK (
    ("resource_hash" = '' OR "resource_hash" ~ '^[0-9a-f]{64}$')
    AND ("ip_hash" = '' OR "ip_hash" ~ '^[0-9a-f]{64}$')
    AND ("user_agent_hash" = '' OR "user_agent_hash" ~ '^[0-9a-f]{64}$')
  )
)`;

const INDEX_SQL = [
  `CREATE INDEX IF NOT EXISTS "out_audit_account_time" ON "out_api_audit" ("out_account_id", "add_time", "id")`,
  `CREATE INDEX IF NOT EXISTS "out_audit_route_time" ON "out_api_audit" ("route_template", "add_time", "id")`,
  `CREATE INDEX IF NOT EXISTS "out_audit_outcome_time" ON "out_api_audit" ("outcome", "add_time", "id")`,
];

const EXPECTED_COLUMNS = [
  "id", "out_account_id", "appid_snapshot", "method", "route_template", "operation",
  "resource_hash", "query_fields", "ip_hash", "user_agent_hash", "outcome", "result_code",
  "duration_ms", "add_time",
];
const EXPECTED_CONSTRAINTS = [
  "out_api_audit_pkey", "out_audit_operation_ck", "out_audit_outcome_ck",
  "out_audit_result_code_ck", "out_audit_duration_ck", "out_audit_add_time_ck",
  "out_audit_hashes_ck",
];
const EXPECTED_INDEXES = [
  "out_api_audit_pkey", "out_audit_account_time", "out_audit_route_time", "out_audit_outcome_time",
];

async function authorize(request: Request, verifier: string): Promise<boolean> {
  if (!verifier) return false;
  const token = request.headers.get("X-Audit-Token") ?? "";
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

async function currentState(db: DbClient) {
  const versions = await db.$client<{ server_version: string; table_exists: boolean; temporary_schemas: number }[]>`
    SELECT current_setting('server_version') AS server_version,
      to_regclass('public.out_api_audit') IS NOT NULL AS table_exists,
      (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_out_%') AS temporary_schemas
  `;
  const base = versions[0] ?? { server_version: "unknown", table_exists: false, temporary_schemas: -1 };
  if (!base.table_exists) {
    return { ...base, rows: 0, columns: [], constraints: [], indexes: [], schema_valid: false };
  }
  const [counts, columns, constraints, indexes] = await Promise.all([
    db.$client<{ rows: number }[]>`SELECT count(*)::integer AS rows FROM public.out_api_audit`,
    db.$client<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'out_api_audit' ORDER BY ordinal_position
    `,
    db.$client<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.out_api_audit'::regclass ORDER BY conname
    `,
    db.$client<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'out_api_audit' ORDER BY indexname
    `,
  ]);
  const columnNames = columns.map((row) => row.column_name);
  const constraintNames = constraints.map((row) => row.conname);
  const indexNames = indexes.map((row) => row.indexname);
  return {
    ...base,
    rows: counts[0]?.rows ?? -1,
    columns: columnNames,
    constraints: constraintNames,
    indexes: indexNames,
    schema_valid: JSON.stringify(columnNames) === JSON.stringify(EXPECTED_COLUMNS)
      && EXPECTED_CONSTRAINTS.every((name) => constraintNames.includes(name))
      && EXPECTED_INDEXES.every((name) => indexNames.includes(name)),
  };
}

async function applyMigration(db: DbClient) {
  const before = await currentState(db);
  if (before.table_exists && !before.schema_valid) {
    throw new Error("existing out_api_audit schema does not match migration; refusing automatic repair");
  }
  if (!before.table_exists) {
    await db.$client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '20s'`;
      await tx.unsafe(TABLE_SQL);
      for (const statement of INDEX_SQL) await tx.unsafe(statement);
    });
  }
  const after = await currentState(db);
  if (!after.schema_valid || after.rows !== 0) {
    throw new Error("Out API audit migration verification failed");
  }
  return { created: !before.table_exists, before, after };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    console.log("[out-hardening-audit] request", request.method, path);
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "POST" || !new Set([
      "/state", "/apply", "/run", "/invoice", "/refund-decisions", "/refund-money",
    ]).has(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
      applicationName: "cinashop_out_hardening_audit",
    });
    try {
      if (path === "/state") return Response.json(await currentState(db));
      if (path === "/apply") return Response.json(await applyMigration(db));
      const state = await currentState(db);
      if (!state.schema_valid) throw new Error("out_api_audit migration has not been applied");
      if (path === "/invoice") {
        const invoice = await runOutApiInvoicePostgresScenario(env.HYPERDRIVE.connectionString);
        return Response.json({ state, invoice, after: await currentState(db) });
      }
      if (path === "/refund-decisions") {
        const decisions = await runOutApiRefundDecisionPostgresScenario(env.HYPERDRIVE.connectionString);
        return Response.json({ state, decisions, after: await currentState(db) });
      }
      if (path === "/refund-money") {
        const refund = await runOutApiRefundMoneyPostgresScenario(env.HYPERDRIVE.connectionString);
        return Response.json({ state, refund, after: await currentState(db) });
      }
      const scenario = await runOutApiHardeningPostgresScenario(env.HYPERDRIVE.connectionString);
      const fulfillment = await runOutApiFulfillmentPostgresScenario(env.HYPERDRIVE.connectionString);
      return Response.json({ state, scenario, fulfillment, after: await currentState(db) });
    } catch (error) {
      console.error("[out-hardening-audit] failed", error instanceof Error ? error.name : "unknown");
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
