import { createContainerFromDb, createDbFromConnectionString } from "@/lib/di";
import { MigrationService } from "@/services/MigrationService";
import {
  fingerprintOutUserPublicState,
  runOutApiUserPostgresScenario,
} from "./OutApiUserPostgresScenario";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & {
  AUDIT_TOKEN_SHA256: string;
};

async function authorize(request: Request, verifier: string): Promise<boolean> {
  if (!verifier) return false;
  const token = request.headers.get("X-Audit-Token") ?? "";
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

async function currentState(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_user_public_audit",
  });
  try {
    const state = await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      const rows = await tx<Array<{
        server_version: string;
        public_tables: number;
        public_columns: number;
        public_indexes: number;
        public_primary_keys: number;
        users: number;
        active_users: number;
        deleted_users: number;
        active_users_with_phone: number;
        active_users_without_phone: number;
        active_duplicate_phone_groups: number;
        malformed_active_phone_rows: number;
        negative_money_users: number;
        negative_integral_users: number;
        system_money_ledgers: number;
        system_integral_ledgers: number;
        user_levels: number;
        user_labels: number;
        user_groups: number;
        community_users: number;
        active_out_accounts: number;
        active_out_interfaces: number;
        replay_table_exists: boolean;
        replay_columns: number;
        replay_constraints: number;
        replay_indexes: number;
        user_active_phone_index: boolean;
        money_evidence_index: boolean;
        integral_evidence_index: boolean;
        public_failure_probe_exists: boolean;
        temporary_schemas: number;
        temporary_schema_names: string[];
      }>>`
        SELECT
          current_setting('server_version') AS server_version,
          (SELECT count(*)::integer FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS public_tables,
          (SELECT count(*)::integer FROM information_schema.columns
            WHERE table_schema = 'public') AS public_columns,
          (SELECT count(*)::integer FROM pg_indexes WHERE schemaname = 'public') AS public_indexes,
          (SELECT count(*)::integer FROM pg_constraint c
            JOIN pg_class r ON r.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = r.relnamespace
            WHERE n.nspname = 'public' AND c.contype = 'p') AS public_primary_keys,
          (SELECT count(*)::integer FROM "user") AS users,
          (SELECT count(*)::integer FROM "user"
            WHERE is_del = 0 AND delete_time IS NULL) AS active_users,
          (SELECT count(*)::integer FROM "user"
            WHERE is_del <> 0 OR delete_time IS NOT NULL) AS deleted_users,
          (SELECT count(*)::integer FROM "user"
            WHERE is_del = 0 AND delete_time IS NULL AND phone <> '') AS active_users_with_phone,
          (SELECT count(*)::integer FROM "user"
            WHERE is_del = 0 AND delete_time IS NULL AND phone = '') AS active_users_without_phone,
          (SELECT count(*)::integer FROM (
            SELECT phone FROM "user"
            WHERE is_del = 0 AND delete_time IS NULL AND phone <> ''
            GROUP BY phone HAVING count(*) > 1
          ) duplicates) AS active_duplicate_phone_groups,
          (SELECT count(*)::integer FROM "user"
            WHERE is_del = 0 AND delete_time IS NULL AND phone <> ''
              AND phone !~ '^1[3-9][0-9]{9}$') AS malformed_active_phone_rows,
          (SELECT count(*)::integer FROM "user" WHERE now_money < 0) AS negative_money_users,
          (SELECT count(*)::integer FROM "user" WHERE integral < 0) AS negative_integral_users,
          (SELECT count(*)::integer FROM user_money
            WHERE type IN ('system_add', 'system_sub')) AS system_money_ledgers,
          (SELECT count(*)::integer FROM user_bill
            WHERE category = 'integral' AND type IN ('system_add', 'system_sub')) AS system_integral_ledgers,
          (SELECT count(*)::integer FROM user_level) AS user_levels,
          (SELECT count(*)::integer FROM user_label_relation) AS user_labels,
          (SELECT count(*)::integer FROM user_group) AS user_groups,
          (SELECT count(*)::integer FROM community_user) AS community_users,
          (SELECT count(*)::integer FROM out_account WHERE is_del = 0 AND status = 1) AS active_out_accounts,
          (SELECT count(*)::integer FROM out_interface WHERE is_del = 0 AND type = 1) AS active_out_interfaces,
          to_regclass('public.out_user_write_replay') IS NOT NULL AS replay_table_exists,
          (SELECT count(*)::integer FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'out_user_write_replay') AS replay_columns,
          (SELECT count(*)::integer FROM pg_constraint
            WHERE conrelid = to_regclass('public.out_user_write_replay')) AS replay_constraints,
          (SELECT count(*)::integer FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'out_user_write_replay') AS replay_indexes,
          EXISTS (SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public' AND indexname = 'user_active_phone_uq') AS user_active_phone_index,
          EXISTS (SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public' AND indexname = 'um_out_request_uq') AS money_evidence_index,
          EXISTS (SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public' AND indexname = 'ub_out_request_uq') AS integral_evidence_index,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.user_money'::regclass
              AND conname = 'out_user_finance_failure_probe'
          ) AS public_failure_probe_exists,
          (SELECT count(*)::integer FROM pg_namespace
            WHERE nspname LIKE 'codex_out_user_%') AS temporary_schemas,
          ARRAY(SELECT nspname FROM pg_namespace
            WHERE nspname LIKE 'codex_out_user_%' ORDER BY nspname) AS temporary_schema_names
      `;
      return rows[0];
    });
    if (!state) throw new Error("Out user production state query returned no row");
    const replayRows = state.replay_table_exists
      ? await db.$client.begin(async (tx) => {
          await tx`SET LOCAL search_path TO public`;
          const rows = await tx<Array<{ count: number }>>`
            SELECT count(*)::integer AS count FROM out_user_write_replay
          `;
          return Number(rows[0]?.count ?? 0);
        })
      : 0;
    return { ...state, replay_rows: replayRows };
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function applyReplaySchema(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_user_replay_apply",
  });
  try {
    const before = await fingerprintOutUserPublicState(db);
    const preflight = await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      const rows = await tx<Array<{
        duplicate_phone_groups: number;
        required_tables: number;
        event_key_exists: boolean;
      }>>`
        SELECT
          (SELECT count(*)::integer FROM (
            SELECT phone FROM "user"
            WHERE is_del = 0 AND delete_time IS NULL AND phone <> ''
            GROUP BY phone HAVING count(*) > 1
          ) duplicates) AS duplicate_phone_groups,
          (SELECT count(*)::integer FROM unnest(ARRAY[
            'public.user'::regclass,
            'public.user_money'::regclass,
            'public.user_bill'::regclass
          ])) AS required_tables,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'user_bill' AND column_name = 'event_key'
          ) AS event_key_exists
      `;
      return rows[0];
    });
    if (!preflight || preflight.duplicate_phone_groups !== 0
      || preflight.required_tables !== 3 || !preflight.event_key_exists) {
      throw new Error("Out user production DDL preflight failed");
    }
    const ddl = new MigrationService(createContainerFromDb(db))
      .outUserWriteReplayMigrationSqlForVerification();
    await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SELECT pg_advisory_xact_lock(744240099, 0)`;
      await tx.unsafe(ddl);
      await tx.unsafe(ddl);
    });
    const after = await fingerprintOutUserPublicState(db);
    const verification = await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      const rows = await tx<Array<{
        columns: number;
        constraints: number;
        indexes: number;
        rows: number;
        guard_indexes: number;
        invalid_guard_indexes: number;
      }>>`
        SELECT
          (SELECT count(*)::integer FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'out_user_write_replay') AS columns,
          (SELECT count(*)::integer FROM pg_constraint
            WHERE conrelid = 'public.out_user_write_replay'::regclass) AS constraints,
          (SELECT count(*)::integer FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'out_user_write_replay') AS indexes,
          (SELECT count(*)::integer FROM out_user_write_replay) AS rows,
          (SELECT count(*)::integer FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname IN ('user_active_phone_uq', 'um_out_request_uq', 'ub_out_request_uq')) AS guard_indexes,
          (SELECT count(*)::integer FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname IN ('user_active_phone_uq', 'um_out_request_uq', 'ub_out_request_uq')
              AND (NOT i.indisvalid OR NOT i.indisready)) AS invalid_guard_indexes
      `;
      return rows[0];
    });
    const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
    if (!publicStateUnchanged || !verification || verification.columns !== 9
      || verification.constraints !== 4 || verification.indexes !== 3
      || verification.guard_indexes !== 3 || verification.invalid_guard_indexes !== 0) {
      throw new Error("Out user replay schema verification failed");
    }
    return {
      applied: true,
      repeated_apply_succeeded: true,
      public_business_state_unchanged: publicStateUnchanged,
      ...preflight,
      ...verification,
    };
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    console.log(JSON.stringify({ event: "out_user_audit_request", method: request.method, path }));
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "POST" || !new Set(["/state", "/run", "/apply"]).has(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      if (path === "/state") return Response.json(await currentState(env.HYPERDRIVE.connectionString));
      if (path === "/apply") return Response.json(await applyReplaySchema(env.HYPERDRIVE.connectionString));
      const before = await currentState(env.HYPERDRIVE.connectionString);
      const scenario = await runOutApiUserPostgresScenario(env.HYPERDRIVE.connectionString);
      const after = await currentState(env.HYPERDRIVE.connectionString);
      return Response.json({ before, scenario, after });
    } catch (error) {
      console.error(JSON.stringify({
        event: "out_user_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
