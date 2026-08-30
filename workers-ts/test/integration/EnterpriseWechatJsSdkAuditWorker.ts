import postgres from "postgres";
import { sql as postgresSql } from "drizzle-orm";
import type { Env } from "@/env";
import { createContainerFromDb, createDbFromConnectionString, type DbClient } from "@/lib/di";
import {
  EnterpriseWechatJsSdkService,
  normalizeEnterpriseWechatSignedUrl,
} from "@/services/work/EnterpriseWechatJsSdkService";
import { ForbiddenException, ServiceUnavailableException } from "@/utils/errors";
import { jsSdkSignature } from "@/utils/wechat-crypto";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_READ_TOKEN_SHA256: string;
  AUDIT_ISOLATED_TOKEN_SHA256: string;
}

interface MemoryKv {
  binding: KVNamespace;
  keys(): string[];
  serializedValues(): string[];
}

class AuditStageError extends Error {
  constructor(readonly stage: string) {
    super(`WORK-A audit stage failed: ${stage}`);
    this.name = "AuditStageError";
  }
}

const SCHEMA_PREFIX = "codex_enterprise_wechat_jssdk_";
const CONFIG_KEYS = [
  "wechat_work_corpid",
  "wechat_work_build_agent_id",
  "wechat_work_build_secret",
  "wechat_work_user_secret",
  "wechat_work_address_secret",
] as const;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`WORK-A audit failed: ${message}`);
}

function memoryKv(): MemoryKv {
  const values = new Map<string, string>();
  const binding = {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      return value !== null && type === "json" ? JSON.parse(value) as unknown : value;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  } as unknown as KVNamespace;
  return {
    binding,
    keys: () => [...values.keys()],
    serializedValues: () => [...values.values()],
  };
}

function decodeSha256(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function authorized(request: Request, expectedHex: string): Promise<boolean> {
  const expected = decodeSha256(expectedHex);
  if (!expected) return false;
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const actual = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied));
  return crypto.subtle.timingSafeEqual(actual, expected);
}

async function temporarySchemaCount(client: postgres.Sql): Promise<number> {
  const rows = await client<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM pg_namespace
    WHERE starts_with(nspname, ${SCHEMA_PREFIX})
  `;
  return Number(rows[0]?.count ?? -1);
}

async function publicConfigFingerprint(client: postgres.Sql): Promise<string> {
  const rows = await client<Array<{ fingerprint: string }>>`
    SELECT md5(
      count(*)::text || ':' ||
      COALESCE(string_agg(md5(row_to_json(config)::text), '' ORDER BY config.id), '')
    ) AS fingerprint
    FROM public.system_config AS config
  `;
  return String(rows[0]?.fingerprint ?? "");
}

async function productionAggregates(connectionString: string) {
  let stage = "production_connect";
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_enterprise_wechat_jssdk_read_only_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      stage = "production_read_only_transaction";
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      stage = "production_catalog";
      const catalogRows = await tx<Array<{
        table_exists: boolean;
        column_count: number;
        expected_columns_present: number;
        resolved_schema: string | null;
        server_version: string;
      }>>`
        SELECT to_regclass('public.system_config') IS NOT NULL AS table_exists,
          (SELECT count(*)::integer FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'system_config') AS column_count,
          (SELECT count(*)::integer FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'system_config'
              AND column_name IN ('id', 'menu_name', 'value', 'is_store', 'sort'))
            AS expected_columns_present,
          (SELECT namespace.nspname FROM pg_class AS relation
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE relation.oid = to_regclass('system_config')) AS resolved_schema,
          current_setting('server_version') AS server_version
      `;
      const catalog = catalogRows[0];
      invariant(
        catalog?.table_exists
          && catalog.expected_columns_present === 5
          && catalog.resolved_schema === "public",
        "system_config catalog or public search path is incomplete",
      );

      stage = "production_configuration_aggregates";
      const configRows = await tx<Array<Record<string, unknown>>>`
        WITH ranked AS (
          SELECT menu_name, value,
            row_number() OVER (PARTITION BY menu_name ORDER BY sort DESC, id DESC) AS priority,
            count(*) OVER (PARTITION BY menu_name) AS copies
          FROM system_config
          WHERE is_store = 0 AND menu_name IN ${tx(CONFIG_KEYS)}
        ), selected AS (
          SELECT menu_name, value, copies FROM ranked WHERE priority = 1
        )
        SELECT
          (SELECT count(*)::integer FROM ranked) AS matching_rows,
          (SELECT count(*)::integer FROM selected) AS distinct_keys_present,
          (SELECT count(*)::integer FROM selected WHERE copies > 1) AS duplicate_key_groups,
          (SELECT count(*)::integer FROM ranked WHERE value = '') AS blank_rows,
          (SELECT count(*)::integer FROM selected
            WHERE menu_name = 'wechat_work_corpid') AS corp_key_present,
          (SELECT count(*)::integer FROM selected
            WHERE menu_name = 'wechat_work_corpid' AND value <> '') AS corp_selected_nonblank,
          (SELECT count(*)::integer FROM selected
            WHERE menu_name = 'wechat_work_corpid'
              AND value ~ '^[A-Za-z0-9_-]{1,64}$') AS corp_selected_format_valid,
          (SELECT count(*)::integer FROM selected
            WHERE menu_name = 'wechat_work_build_agent_id') AS agent_key_present,
          (SELECT count(*)::integer FROM selected
            WHERE menu_name = 'wechat_work_build_agent_id' AND value <> '') AS agent_selected_nonblank,
          (SELECT count(*)::integer FROM selected
            WHERE menu_name = 'wechat_work_build_agent_id'
              AND CASE WHEN value ~ '^[0-9]{1,10}$'
                THEN value::numeric BETWEEN 1 AND 2147483647 ELSE false END)
            AS agent_selected_format_valid,
          (SELECT count(*)::integer FROM selected
            WHERE menu_name IN ('wechat_work_build_secret', 'wechat_work_user_secret',
              'wechat_work_address_secret')) AS legacy_secret_keys_present,
          (SELECT count(*)::integer FROM selected
            WHERE menu_name IN ('wechat_work_build_secret', 'wechat_work_user_secret',
              'wechat_work_address_secret') AND value <> '') AS legacy_secret_keys_nonblank
      `;
      stage = "production_temporary_schema_count";
      const tempRows = await tx<Array<{ count: number }>>`
        SELECT count(*)::integer AS count FROM pg_namespace
        WHERE starts_with(nspname, ${SCHEMA_PREFIX})
      `;
      const tempCount = Number(tempRows[0]?.count ?? -1);
      return {
        complete: true,
        server_version: catalog.server_version,
        catalog: {
          system_config_exists: catalog.table_exists,
          column_count: catalog.column_count,
          expected_columns_present: catalog.expected_columns_present,
          resolved_schema: catalog.resolved_schema,
          temporary_schema_count: tempCount,
        },
        configuration: configRows[0] ?? {},
        deployment_boundary: {
          required_worker_secrets: ["WECHAT_WORK_CORP_SECRET", "WECHAT_WORK_AGENT_SECRET"],
          required_non_secret_var: "WORK_WECHAT_ALLOWED_ORIGINS",
          database_secret_values_consumed_by_new_service: false,
        },
        guarantees: {
          transaction: "REPEATABLE READ, READ ONLY",
          search_path: "public, pg_temp (pg_temp last)",
          configuration_values_returned: false,
          corp_or_agent_identifiers_returned: false,
          secret_values_returned: false,
          row_ids_or_fingerprints_returned: false,
          dml_or_ddl_executed: false,
        },
      };
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "enterprise_wechat_jssdk_audit_stage_failed",
      stage,
      error: error instanceof Error ? error.message : String(error),
    }));
    throw new AuditStageError(stage);
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function runIsolatedScenario(connectionString: string) {
  let stage = "isolated_connect";
  const admin = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_enterprise_wechat_jssdk_isolated_audit" },
  });
  const schema = `${SCHEMA_PREFIX}${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  invariant(/^[a-z_][a-z0-9_]{0,62}$/.test(schema), "temporary schema name is invalid");
  stage = "isolated_before_snapshot";
  const beforeTemp = await temporarySchemaCount(admin);
  const beforePublic = await publicConfigFingerprint(admin);
  let scenarioDb: ReturnType<typeof createDbFromConnectionString> | null = null;
  let checks = 0;
  try {
    stage = "isolated_schema_create";
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    await admin.unsafe(`CREATE TABLE "${schema}".system_config (LIKE public.system_config INCLUDING ALL)`);
    await admin.unsafe(
      `INSERT INTO "${schema}".system_config
        (id, is_store, menu_name, value, sort, status)
       VALUES
        (900000001, 0, 'wechat_work_corpid', 'ww0123456789abcdef', 0, 1),
        (900000002, 0, 'wechat_work_build_agent_id', '1000002', 0, 1)`,
    );
    stage = "isolated_service_connection";
    scenarioDb = createDbFromConnectionString(connectionString, 1, {
      searchPath: schema,
      applicationName: "cinashop_work_jssdk_scenario",
    });
    const providerCalls: string[] = [];
    await scenarioDb.transaction(async (transaction) => {
      const scopedDb = transaction as unknown as DbClient;
      stage = "isolated_set_search_path";
      await scopedDb.execute(postgresSql.raw(`SET LOCAL search_path TO "${schema}", pg_temp`));
      await scopedDb.execute(postgresSql.raw("SET LOCAL statement_timeout = '30s'"));
      await scopedDb.execute(postgresSql.raw("SET LOCAL lock_timeout = '3s'"));
      stage = "isolated_service_resolution";
      const resolution = await scopedDb.execute<{
        current_schema: string;
        resolved_schema: string | null;
      }>(postgresSql`
        SELECT current_schema(),
          (SELECT namespace.nspname FROM pg_class AS relation
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE relation.oid = to_regclass('system_config')) AS resolved_schema
      `);
      const resolutionRows = Array.isArray(resolution)
        ? resolution
        : (resolution as { rows?: Array<{ current_schema: string; resolved_schema: string | null }> })
          .rows ?? [];
      stage = `isolated_service_resolution_current_${resolutionRows[0]?.current_schema === schema}`
        + `_resolved_${resolutionRows[0]?.resolved_schema === schema}`;
      invariant(
        resolutionRows[0]?.current_schema === schema && resolutionRows[0]?.resolved_schema === schema,
        "service connection escaped the isolated schema",
      );
      checks += 1;

      stage = "isolated_company_and_agent_service";
      const kv = memoryKv();
      const companySecret = "isolated-company-secret";
      const agentSecret = "isolated-agent-secret";
      const provider = (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        providerCalls.push(url.pathname);
        if (url.pathname === "/cgi-bin/gettoken") {
          const supplied = url.searchParams.get("corpsecret");
          invariant(
            [companySecret, agentSecret].includes(supplied ?? ""),
            "unexpected provider secret",
          );
          return Response.json({
            errcode: 0,
            access_token: supplied === companySecret ? "company-access" : "agent-access",
            expires_in: 7200,
          });
        }
        if (url.pathname === "/cgi-bin/get_jsapi_ticket") {
          invariant(
            url.searchParams.get("access_token") === "company-access",
            "company token mismatch",
          );
          return Response.json({ errcode: 0, ticket: "company-ticket", expires_in: 7200 });
        }
        if (url.pathname === "/cgi-bin/ticket/get") {
          invariant(
            url.searchParams.get("access_token") === "agent-access",
            "agent token mismatch",
          );
          invariant(url.searchParams.get("type") === "agent_config", "agent ticket type mismatch");
          return Response.json({ errcode: 0, ticket: "agent-ticket", expires_in: 7200 });
        }
        return Response.json({ errcode: 404 }, { status: 404 });
      }) as typeof fetch;
      const serviceEnv = {
        CONFIG_KV: kv.binding,
        WORK_WECHAT_ALLOWED_ORIGINS: "https://work.example.com",
        WECHAT_WORK_CORP_SECRET: companySecret,
        WECHAT_WORK_AGENT_SECRET: agentSecret,
      } as Env;
      const container = createContainerFromDb(scopedDb);
      const service = new EnterpriseWechatJsSdkService(container, serviceEnv, provider);
      stage = "isolated_company_service";
      const company = await service.companyConfig("https://work.example.com/customer?id=7#ignored");
      const companyCached = await service.companyConfig("https://work.example.com/customer?id=7#ignored");
      invariant(company.appId === "ww0123456789abcdef", "company CorpID mismatch");
      invariant(company.url === "https://work.example.com/customer?id=7", "company URL mismatch");
      invariant(company.signature === await jsSdkSignature(
        "company-ticket", company.nonceStr, company.timestamp, company.url,
      ), "company signature mismatch");
      invariant(companyCached.nonceStr !== company.nonceStr, "company response nonce was reused");
      checks += 4;

      stage = "isolated_agent_service";
      const agent = await service.agentConfig("https://work.example.com/chat#ignored");
      const agentCached = await service.agentConfig("https://work.example.com/chat#ignored");
      invariant(agent.corpid === "ww0123456789abcdef" && agent.agentid === 1000002,
        "agent identity mismatch");
      invariant(agent.signature === await jsSdkSignature(
        "agent-ticket", agent.nonceStr, agent.timestamp, agent.url,
      ), "agent signature mismatch");
      invariant(agentCached.nonceStr !== agent.nonceStr, "agent response nonce was reused");
      invariant(providerCalls.length === 4, "ticket or access-token cache was bypassed");
      checks += 4;

      stage = "isolated_secret_cache_assertion";
      invariant(
        !kv.keys().join("\n").includes(companySecret)
          && !kv.keys().join("\n").includes(agentSecret)
          && !kv.serializedValues().join("\n").includes(companySecret)
          && !kv.serializedValues().join("\n").includes(agentSecret),
        "Worker secret leaked into credential cache",
      );
      checks += 1;

      stage = "isolated_negative_boundaries";
      let rejectedOrigin = false;
      try {
        normalizeEnterpriseWechatSignedUrl("https://evil.example.com/page", "https://work.example.com");
      } catch (error) {
        rejectedOrigin = error instanceof ForbiddenException;
      }
      invariant(rejectedOrigin, "non-allowlisted origin did not fail closed");
      let missingSecret = false;
      try {
        await new EnterpriseWechatJsSdkService(
          container,
          { ...serviceEnv, WECHAT_WORK_CORP_SECRET: undefined } as Env,
          provider,
        ).companyConfig("https://work.example.com/page");
      } catch (error) {
        missingSecret = error instanceof ServiceUnavailableException;
      }
      invariant(missingSecret, "missing company secret did not fail closed");
      checks += 2;
    });

    stage = "isolated_public_unchanged";
    const afterPublic = await publicConfigFingerprint(admin);
    invariant(beforePublic === afterPublic, "public system_config changed during isolated scenario");
    checks += 1;
    invariant(checks === 13, "isolated assertion accounting drifted");
    return {
      complete: true,
      checks_passed: checks,
      expected_checks: 13,
      provider_calls: providerCalls.length,
      company_and_agent_cache_reused: true,
      url_normalization_and_allowlist_verified: true,
      missing_secret_failed_closed: true,
      cache_contains_worker_secret: false,
      public_system_config_unchanged: true,
      temporary_schema_count_before: beforeTemp,
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: "enterprise_wechat_jssdk_isolated_stage_failed",
      stage,
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error instanceof AuditStageError ? error : new AuditStageError(stage);
  } finally {
    if (scenarioDb) await scenarioDb.$client.end({ timeout: 1 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const afterTemp = await temporarySchemaCount(admin);
    invariant(afterTemp === beforeTemp, "temporary schema cleanup failed");
    await admin.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    const hashes = [env.AUDIT_READ_TOKEN_SHA256 ?? "", env.AUDIT_ISOLATED_TOKEN_SHA256 ?? ""];
    if (request.method !== "POST" || !["/audit", "/isolated-scenario"].includes(url.pathname)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (hashes.some((value) => !decodeSha256(value))
      || new Set(hashes.map((value) => value.toLowerCase())).size !== 2) {
      return Response.json(
        { error: "audit unavailable" },
        { status: 503, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const expectedHash = url.pathname === "/audit" ? hashes[0] : hashes[1];
    if (!(await authorized(request, expectedHash))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const result = url.pathname === "/audit"
        ? await productionAggregates(env.HYPERDRIVE.connectionString)
        : await runIsolatedScenario(env.HYPERDRIVE.connectionString);
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      console.error(JSON.stringify({
        event: "enterprise_wechat_jssdk_audit_failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return Response.json(
        {
          error: "audit failed",
          stage: error instanceof AuditStageError ? error.stage : "unknown",
        },
        { status: 500, headers: { "Cache-Control": "private, no-store" } },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
