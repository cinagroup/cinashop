import postgres from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { createContainerFromDb, createDbFromConnectionString, withTx } from "@/lib/di";
import { MigrationService } from "@/services/MigrationService";
import { runEnterpriseWechatContactActionScenario } from "./EnterpriseWechatContactActionPostgresScenario";

interface AuditEnv {
  readonly HYPERDRIVE: Hyperdrive;
  readonly AUDIT_READ_TOKEN_SHA256: string;
  readonly AUDIT_MIGRATE_TOKEN_SHA256: string;
  readonly AUDIT_ISOLATED_TOKEN_SHA256: string;
}

function bytesFromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

async function authorized(request: Request, expectedHex: string): Promise<boolean> {
  const expected = bytesFromHex(expectedHex);
  if (!expected) return false;
  const match = /^Bearer ([^\s]{1,4096})$/i.exec(
    request.headers.get("Authorization") ?? "",
  );
  const actual = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(match?.[1] ?? ""),
  ));
  return crypto.subtle.timingSafeEqual(actual, expected);
}

function pgClient(connectionString: string, applicationName = "cinashop_work_action_audit") {
  return postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: applicationName },
  });
}

async function inventory(client: postgres.Sql) {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx`SET LOCAL search_path = public, pg_temp`;
    await tx`SET LOCAL statement_timeout = '60s'`;
    return tx<Array<{
      kind: string;
      name: string;
      oid: string;
      relfilenode: string;
    }>>`
      SELECT relation.relkind::text AS kind, relation.relname AS name,
        relation.oid::text AS oid, relation.relfilenode::text AS relfilenode
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r','S') AND NOT relation.relispartition
      ORDER BY relation.relkind, relation.relname
    `;
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function tableFingerprint(client: postgres.Sql, tables: readonly string[]) {
  const output: Array<{ table: string; rows: string; digest: string }> = [];
  for (const table of tables) {
    const exists = (await client<Array<{ exists: boolean }>>`
      SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS exists
    `)[0]?.exists ?? false;
    if (!exists) {
      output.push({ table, rows: "missing", digest: "" });
      continue;
    }
    const qualified = `public."${table.replaceAll('"', '""')}"`;
    const rows = await client.unsafe<Array<{ rows: string; digest: string }>>(`
      WITH tokens AS (
        SELECT hashtextextended(tableoid::text||':'||ctid::text||':'||xmin::text,0) AS a,
          hashtextextended(tableoid::text||':'||ctid::text||':'||xmin::text,1) AS b
        FROM ${qualified}
      )
      SELECT count(*)::text AS rows,
        md5(count(*)::text||':'||COALESCE(sum(a::numeric)::text,'0')||':'
          ||COALESCE(sum(b::numeric)::text,'0')) AS digest
      FROM tokens
    `);
    output.push({ table, rows: rows[0]?.rows ?? "-1", digest: rows[0]?.digest ?? "" });
  }
  return output;
}

async function actionMetadata(client: postgres.Sql) {
  return client<Array<{ kind: string; table_name: string; name: string; definition: string }>>`
    SELECT 'constraint' AS kind, table_row.relname AS table_name,
      constraint_row.conname AS name, pg_get_constraintdef(constraint_row.oid, true) AS definition
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = table_row.relnamespace
    WHERE namespace.nspname = 'public'
      AND table_row.relname IN ('work_contact_action_outbox','work_contact_action_audit')
    UNION ALL
    SELECT 'index', table_row.relname, index_row.relname, pg_get_indexdef(index_row.oid)
    FROM pg_index AS index_meta
    JOIN pg_class AS index_row ON index_row.oid = index_meta.indexrelid
    JOIN pg_class AS table_row ON table_row.oid = index_meta.indrelid
    JOIN pg_namespace AS namespace ON namespace.oid = table_row.relnamespace
    WHERE namespace.nspname = 'public'
      AND table_row.relname IN ('work_contact_action_outbox','work_contact_action_audit')
    UNION ALL
    SELECT 'trigger', table_row.relname, trigger_row.tgname,
      pg_get_triggerdef(trigger_row.oid, true)
    FROM pg_trigger AS trigger_row
    JOIN pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
    JOIN pg_namespace AS namespace ON namespace.oid = table_row.relnamespace
    WHERE namespace.nspname = 'public' AND NOT trigger_row.tgisinternal
      AND table_row.relname IN ('work_contact_action_outbox','work_contact_action_audit')
    UNION ALL
    SELECT 'function', '', function_row.proname,
      pg_get_functiondef(function_row.oid)
    FROM pg_proc AS function_row
    JOIN pg_namespace AS namespace ON namespace.oid = function_row.pronamespace
    WHERE namespace.nspname = 'public'
      AND function_row.proname IN ('wcao_guard_immutable_0118','wcaa_guard_immutable_0118')
    ORDER BY kind, table_name, name
  `;
}

async function retentionMetadata(client: postgres.Sql) {
  return client<Array<{ kind: string; name: string; definition: string }>>`
    SELECT 'column' AS kind, column_row.column_name AS name,
      concat_ws('|', column_row.data_type, column_row.is_nullable,
        COALESCE(column_row.column_default, '')) AS definition
    FROM information_schema.columns AS column_row
    WHERE column_row.table_schema = 'public'
      AND column_row.table_name = 'work_callback_event'
      AND column_row.column_name IN ('payload_retained_until','payload_redacted_time')
    UNION ALL
    SELECT 'constraint', constraint_row.conname,
      pg_get_constraintdef(constraint_row.oid, true)
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.work_callback_event'::regclass
      AND constraint_row.conname = 'wce_payload_retention_ck'
    UNION ALL
    SELECT 'index', index_row.relname, pg_get_indexdef(index_row.oid)
    FROM pg_index AS index_meta
    JOIN pg_class AS index_row ON index_row.oid = index_meta.indexrelid
    JOIN pg_class AS table_row ON table_row.oid = index_meta.indrelid
    JOIN pg_namespace AS namespace ON namespace.oid = table_row.relnamespace
    WHERE namespace.nspname = 'public'
      AND table_row.relname = 'work_callback_event'
      AND index_row.relname = 'wce_payload_redaction_ready'
    ORDER BY kind, name
  `;
}

async function temporarySchemaCount(client: postgres.Sql): Promise<number> {
  const rows = await client<Array<{ count: number }>>`
    SELECT count(*)::integer AS count
    FROM pg_namespace
    WHERE nspname LIKE 'codex_work_action_%'
  `;
  return rows[0]?.count ?? -1;
}

async function readProduction(connectionString: string) {
  const client = pgClient(connectionString);
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL search_path = public, pg_temp`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      await tx`SET LOCAL statement_timeout = '30s'`;

      const tables = await tx<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'work_channel_code', 'work_welcome', 'work_welcome_relation',
            'work_media', 'wechat_user', 'user', 'work_client',
            'work_client_current', 'work_callback_event', 'work_callback_outbox',
            'work_contact_action_outbox', 'work_contact_action_audit'
          )
        ORDER BY table_name
      `;
      const present = new Set(tables.map((row) => row.table_name));
      const required = [
        "work_channel_code", "work_welcome", "work_welcome_relation",
        "work_media", "wechat_user", "user", "work_client",
        "work_client_current", "work_callback_event", "work_callback_outbox",
      ];
      const missing = required.filter((table) => !present.has(table));
      if (missing.length > 0) throw new Error("required_audit_table_missing");

      const version = await tx<Array<{ major: number }>>`
        SELECT current_setting('server_version_num')::integer / 10000 AS major
      `;
      const channels = await tx<Array<Record<string, number>> >`
        SELECT
          count(*)::integer AS total,
          count(*) FILTER (WHERE delete_time IS NULL)::integer AS live,
          count(*) FILTER (WHERE delete_time IS NULL AND status = 1)::integer AS enabled,
          count(*) FILTER (WHERE delete_time IS NULL AND welcome_type = 0)::integer AS custom_welcome,
          count(*) FILTER (
            WHERE delete_time IS NULL AND welcome_type = 0
              AND btrim(welcome_words) <> ''
          )::integer AS custom_welcome_nonempty,
          count(*) FILTER (
            WHERE delete_time IS NULL AND welcome_type = 0
              AND btrim(welcome_words) <> ''
              AND NOT pg_input_is_valid(welcome_words, 'jsonb')
          )::integer AS custom_welcome_invalid_json,
          count(*) FILTER (
            WHERE delete_time IS NULL AND btrim(label_id) <> ''
          )::integer AS label_nonempty,
          count(*) FILTER (
            WHERE delete_time IS NULL AND btrim(label_id) <> ''
              AND NOT pg_input_is_valid(label_id, 'jsonb')
          )::integer AS label_invalid_json,
          count(*) FILTER (
            WHERE delete_time IS NULL AND pg_input_is_valid(label_id, 'jsonb')
              AND jsonb_typeof(label_id::jsonb) <> 'array'
          )::integer AS label_not_array,
          count(*) FILTER (WHERE client_num < 0)::integer AS negative_client_num
        FROM work_channel_code
      `;
      const welcomes = await tx<Array<Record<string, number>> >`
        SELECT
          count(*)::integer AS total,
          count(*) FILTER (WHERE delete_time IS NULL)::integer AS live,
          count(*) FILTER (WHERE delete_time IS NULL AND type = 0)::integer AS default_candidates,
          count(*) FILTER (
            WHERE delete_time IS NULL AND btrim(COALESCE(attachments, '')) <> ''
              AND NOT pg_input_is_valid(attachments, 'jsonb')
          )::integer AS attachments_invalid_json,
          count(*) FILTER (
            WHERE delete_time IS NULL AND pg_input_is_valid(COALESCE(NULLIF(attachments, ''), '[]'), 'jsonb')
              AND jsonb_typeof(COALESCE(NULLIF(attachments, ''), '[]')::jsonb) <> 'array'
          )::integer AS attachments_not_array,
          count(*) FILTER (
            WHERE delete_time IS NULL AND btrim(COALESCE(content, '')) = ''
              AND pg_input_is_valid(COALESCE(NULLIF(attachments, ''), '[]'), 'jsonb')
              AND COALESCE(NULLIF(attachments, ''), '[]')::jsonb = '[]'::jsonb
          )::integer AS empty_message
        FROM work_welcome
      `;
      const relations = await tx<Array<Record<string, number>> >`
        SELECT
          count(*)::integer AS total,
          count(*) FILTER (WHERE welcome.id IS NULL)::integer AS orphan_welcome,
          count(*) FILTER (WHERE btrim(relation.userid) = '')::integer AS empty_userid,
          (
            SELECT count(*)::integer FROM (
              SELECT welcome_id, userid FROM work_welcome_relation
              GROUP BY welcome_id, userid HAVING count(*) > 1
            ) AS duplicate_relation
          ) AS duplicate_groups
        FROM work_welcome_relation AS relation
        LEFT JOIN work_welcome AS welcome ON welcome.id = relation.welcome_id
      `;
      const media = await tx<Array<Record<string, number>> >`
        SELECT
          count(*)::integer AS total,
          count(*) FILTER (WHERE temporary = 1)::integer AS temporary,
          count(*) FILTER (WHERE temporary = 1 AND valid_time <= extract(epoch FROM clock_timestamp())::integer)::integer AS temporary_expired,
          count(*) FILTER (WHERE btrim(media_id) = '')::integer AS missing_media_id,
          count(*) FILTER (WHERE type NOT IN ('image','video','file'))::integer AS unsupported_type
        FROM work_media
      `;
      const identity = await tx<Array<Record<string, number>> >`
        WITH active_wechat AS (
          SELECT unionid, uid
          FROM wechat_user
          WHERE is_del = 0 AND btrim(unionid) <> '' AND uid > 0
        ), ambiguous AS (
          SELECT unionid
          FROM active_wechat
          GROUP BY unionid
          HAVING count(DISTINCT uid) > 1
        ), active_clients AS (
          SELECT corp_id, id, unionid, uid
          FROM work_client_current
          WHERE lifecycle_state = 'ACTIVE'
        ), matches AS (
          SELECT client.corp_id, client.id, client.uid AS client_uid,
            count(DISTINCT identity.uid)::integer AS uid_count,
            min(identity.uid)::integer AS matched_uid
          FROM active_clients AS client
          LEFT JOIN active_wechat AS identity ON identity.unionid = client.unionid
          GROUP BY client.corp_id, client.id, client.uid
        )
        SELECT
          (SELECT count(*)::integer FROM wechat_user) AS wechat_total,
          (SELECT count(*)::integer FROM active_wechat) AS active_unionid_rows,
          (SELECT count(*)::integer FROM ambiguous) AS ambiguous_unionids,
          (SELECT count(*)::integer FROM active_clients) AS active_clients,
          (SELECT count(*)::integer FROM active_clients WHERE btrim(COALESCE(unionid, '')) <> '') AS clients_with_unionid,
          count(*) FILTER (WHERE uid_count = 1)::integer AS clients_single_match,
          count(*) FILTER (WHERE uid_count > 1)::integer AS clients_ambiguous_match,
          count(*) FILTER (WHERE uid_count = 1 AND client_uid IS NOT NULL AND client_uid <> matched_uid)::integer AS existing_uid_conflicts,
          count(*) FILTER (WHERE uid_count = 1 AND client_uid IS NULL)::integer AS linkable_clients
        FROM matches
      `;
      const callbacks = await tx<Array<Record<string, number>> >`
        SELECT
          count(*) FILTER (
            WHERE event_type = 'change_external_contact'
              AND change_type = 'add_external_contact'
          )::integer AS add_events,
          count(*) FILTER (
            WHERE event_type = 'change_external_contact'
              AND change_type = 'edit_external_contact'
          )::integer AS edit_events,
          count(*) FILTER (
            WHERE event_type = 'change_external_contact'
              AND change_type = 'add_external_contact'
              AND COALESCE(payload->>'WelcomeCode', '') <> ''
          )::integer AS add_with_welcome_code,
          count(*) FILTER (WHERE status IN ('RECEIVED','PROCESSING','FAILED'))::integer AS unfinished,
          count(*) FILTER (WHERE payload ? 'WelcomeCode')::integer AS retained_welcome_codes
        FROM work_callback_event
      `;
      const callbackOutbox = await tx<Array<Record<string, number>> >`
        SELECT
          count(*)::integer AS total,
          count(*) FILTER (WHERE status IN ('PENDING','ENQUEUING','ENQUEUED','PROCESSING','FAILED'))::integer AS unfinished,
          count(*) FILTER (WHERE status = 'DEAD')::integer AS dead
        FROM work_callback_outbox
      `;
      const targetCounts: Record<string, number | null> = {};
      for (const table of ["work_contact_action_outbox", "work_contact_action_audit"]) {
        if (!present.has(table)) {
          targetCounts[table] = null;
          continue;
        }
        const rows = await tx.unsafe<Array<{ count: number }>>(
          `SELECT count(*)::integer AS count FROM public.${table}`,
        );
        targetCounts[table] = rows[0]?.count ?? -1;
      }
      const temporarySchemas = await tx<Array<{ count: number }>>`
        SELECT count(*)::integer AS count
        FROM pg_namespace
        WHERE nspname LIKE 'codex_work_action_%'
      `;

      return {
        postgresMajor: version[0]?.major ?? 0,
        tables: [...present],
        channels: channels[0],
        welcomes: welcomes[0],
        welcomeRelations: relations[0],
        media: media[0],
        identity: identity[0],
        callbacks: callbacks[0],
        callbackOutbox: callbackOutbox[0],
        targetCounts,
        temporarySchemas: temporarySchemas[0]?.count ?? -1,
      };
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

const BUSINESS_TABLES = [
  "work_channel_code",
  "work_welcome",
  "work_welcome_relation",
  "work_media",
  "wechat_user",
  "work_client",
  "work_client_current",
  "work_callback_event",
  "work_callback_outbox",
] as const;

const ACTION_TABLES = [
  "work_contact_action_outbox",
  "work_contact_action_audit",
] as const;

async function isolatedAudit(connectionString: string) {
  const client = pgClient(connectionString, "cinashop_work_action_isolated_guard");
  const beforeInventory = await inventory(client);
  const beforeBusiness = await tableFingerprint(client, BUSINESS_TABLES);
  const beforeMetadata = await actionMetadata(client);
  const beforeTemporarySchemas = await temporarySchemaCount(client);
  let scenario: Awaited<ReturnType<typeof runEnterpriseWechatContactActionScenario>> | null = null;
  let primaryError: unknown = null;
  let afterInventory: Awaited<ReturnType<typeof inventory>> | null = null;
  let afterBusiness: Awaited<ReturnType<typeof tableFingerprint>> | null = null;
  let afterMetadata: Awaited<ReturnType<typeof actionMetadata>> | null = null;
  let afterTemporarySchemas = -1;
  try {
    scenario = await runEnterpriseWechatContactActionScenario(connectionString);
  } catch (error) {
    primaryError = error;
  } finally {
    afterInventory = await inventory(client);
    afterBusiness = await tableFingerprint(client, BUSINESS_TABLES);
    afterMetadata = await actionMetadata(client);
    afterTemporarySchemas = await temporarySchemaCount(client);
    await client.end({ timeout: 1 });
  }
  if (primaryError) throw primaryError;
  if (!scenario || !afterInventory || !afterBusiness || !afterMetadata) {
    throw new Error("isolated_action_audit_incomplete");
  }

  const assertions = {
    scenario_assertions_passed: Object.values(scenario.assertions).every(Boolean),
    public_catalog_unchanged: sameJson(beforeInventory, afterInventory),
    public_business_rows_mvcc_unchanged: sameJson(beforeBusiness, afterBusiness),
    public_action_metadata_unchanged: sameJson(beforeMetadata, afterMetadata),
    temporary_schema_count_restored: beforeTemporarySchemas === afterTemporarySchemas,
  };
  if (!Object.values(assertions).every(Boolean)) {
    throw new Error("isolated_action_audit_public_guard_failed");
  }
  return {
    complete: true,
    isolated_schema_only: true,
    scenario,
    assertions,
    temporary_schema_count: afterTemporarySchemas,
    public_catalog_digest: await sha256Json(afterInventory),
    public_business_digest: await sha256Json(afterBusiness),
    failed_checks: [],
  };
}

async function applyProductionMigration(
  container: ReturnType<typeof createContainerFromDb>,
): Promise<void> {
  const ddl = new MigrationService(container)
    .workContactActionOutboxMigrationSqlForVerification();
  await withTx(container, async (tx) => {
    await tx.execute(drizzleSql.raw(ddl));
  });
}

function relationNames(
  rows: Awaited<ReturnType<typeof inventory>>,
  kind: "r" | "S",
): string[] {
  return rows.filter((row) => row.kind === kind).map((row) => row.name);
}

function addedNames(before: readonly string[], after: readonly string[]): string[] {
  const existing = new Set(before);
  return after.filter((name) => !existing.has(name));
}

async function productionMigrate(connectionString: string) {
  const audit = pgClient(connectionString, "cinashop_work_action_migration_audit");
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public,pg_temp",
    applicationName: "cinashop_work_action_migration",
  });
  const container = createContainerFromDb(db);
  try {
    const beforeInventory = await inventory(audit);
    const beforeBusiness = await tableFingerprint(audit, BUSINESS_TABLES);
    const beforeTargets = await tableFingerprint(audit, ACTION_TABLES);
    const absentCount = beforeTargets.filter((row) => row.rows === "missing").length;
    if (absentCount !== 0 && absentCount !== ACTION_TABLES.length) {
      throw new Error("production_action_target_partial_state");
    }
    if (absentCount === ACTION_TABLES.length) {
      const callback = beforeBusiness.find((row) => row.table === "work_callback_event");
      if (!callback || callback.rows !== "0") {
        throw new Error("production_callback_backfill_requires_separate_review");
      }
    }

    await applyProductionMigration(container);
    const firstMetadata = await actionMetadata(audit);
    const firstRetention = await retentionMetadata(audit);
    const firstTargets = await tableFingerprint(audit, ACTION_TABLES);
    await applyProductionMigration(container);
    const secondMetadata = await actionMetadata(audit);
    const secondRetention = await retentionMetadata(audit);
    const secondTargets = await tableFingerprint(audit, ACTION_TABLES);
    const afterBusiness = await tableFingerprint(audit, BUSINESS_TABLES);
    const afterInventory = await inventory(audit);

    const beforeTables = relationNames(beforeInventory, "r");
    const afterTables = relationNames(afterInventory, "r");
    const beforeSequences = relationNames(beforeInventory, "S");
    const afterSequences = relationNames(afterInventory, "S");
    const targetPreviouslyAbsent = absentCount === ACTION_TABLES.length;
    const expectedAddedTables = targetPreviouslyAbsent ? [...ACTION_TABLES].sort() : [];
    const expectedAddedSequences = targetPreviouslyAbsent
      ? ["work_contact_action_audit_id_seq", "work_contact_action_outbox_id_seq"]
      : [];
    const assertions = {
      migration_metadata_stable_on_second_pass: sameJson(firstMetadata, secondMetadata),
      retention_metadata_stable_on_second_pass: sameJson(firstRetention, secondRetention),
      target_rows_stable_on_second_pass: sameJson(firstTargets, secondTargets),
      target_tables_empty: secondTargets.every((row) => row.rows === "0"),
      business_rows_mvcc_unchanged: sameJson(beforeBusiness, afterBusiness),
      table_delta_exact: sameJson(addedNames(beforeTables, afterTables).sort(), expectedAddedTables),
      sequence_delta_exact: sameJson(
        addedNames(beforeSequences, afterSequences).sort(),
        expectedAddedSequences,
      ),
      exact_action_constraint_count:
        secondMetadata.filter((row) => row.kind === "constraint").length === 18,
      exact_action_index_count:
        secondMetadata.filter((row) => row.kind === "index").length === 10,
      exact_action_trigger_count:
        secondMetadata.filter((row) => row.kind === "trigger").length === 2,
      exact_action_function_count:
        secondMetadata.filter((row) => row.kind === "function").length === 2,
      exact_callback_retention_metadata_count: secondRetention.length === 4,
    };
    if (!Object.values(assertions).every(Boolean)) {
      throw new Error(`production_action_migration_assertions_failed:${Object.entries(assertions)
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
        .join(",")}`);
    }
    return {
      complete: true,
      production_schema: "public",
      migration_passes: 2,
      target_previously_absent: targetPreviouslyAbsent,
      before: { table_count: beforeTables.length, sequence_count: beforeSequences.length },
      after: { table_count: afterTables.length, sequence_count: afterSequences.length },
      assertions,
      action_metadata_digest: await sha256Json(secondMetadata),
      retention_metadata_digest: await sha256Json(secondRetention),
      failed_checks: [],
    };
  } finally {
    await db.$client.end({ timeout: 1 });
    await audit.end({ timeout: 1 });
  }
}

function noStoreJson(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(value, { ...init, headers });
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  if (/cleanup|schema_count|public_guard/i.test(error.message)) return "cleanup_failed";
  if (/migration|target_partial|backfill/i.test(error.message)) return "migration_failed";
  if (/scenario/i.test(error.message)) return "scenario_failed";
  return "audit_failed";
}

function safeErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const detail = error.message.replace(
    /codex_work_action_[0-9a-f]{32}/g,
    "codex_work_action_[redacted]",
  );
  if (
    detail.length > 300
    || /(?:postgres(?:ql)?:\/\/|password|token|secret|authorization)/i.test(detail)
  ) return undefined;
  return detail;
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.search
      || !["/audit", "/migrate", "/isolated"].includes(url.pathname)) {
      return noStoreJson({ error: "not_found" }, { status: 404 });
    }
    const expected = url.pathname === "/audit"
      ? env.AUDIT_READ_TOKEN_SHA256
      : url.pathname === "/migrate"
        ? env.AUDIT_MIGRATE_TOKEN_SHA256
        : env.AUDIT_ISOLATED_TOKEN_SHA256;
    if (!(await authorized(request, expected ?? ""))) {
      return noStoreJson({ error: "forbidden" }, { status: 403 });
    }
    const requestId = crypto.randomUUID();
    try {
      const result = url.pathname === "/audit"
        ? await readProduction(env.HYPERDRIVE.connectionString)
        : url.pathname === "/migrate"
          ? await productionMigrate(env.HYPERDRIVE.connectionString)
          : await isolatedAudit(env.HYPERDRIVE.connectionString);
      return noStoreJson({ request_id: requestId, ...result });
    } catch (error) {
      const code = safeError(error);
      console.error(JSON.stringify({
        event: "work_action_audit_failed",
        request_id: requestId,
        error_code: code,
      }));
      const detail = safeErrorDetail(error);
      return noStoreJson({
        error: "audit_failed",
        error_code: code,
        request_id: requestId,
        ...(detail ? { error_detail: detail } : {}),
      }, {
        status: 500,
      });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
