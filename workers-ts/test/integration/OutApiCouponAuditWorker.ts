import { createContainerFromDb, createDbFromConnectionString } from "@/lib/di";
import { MigrationService } from "@/services/MigrationService";
import {
  fingerprintOutCouponPublicState,
  runOutApiCouponPostgresScenario,
} from "./OutApiCouponPostgresScenario";

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
    applicationName: "cinashop_out_coupon_public_audit",
  });
  try {
    const rows = await db.$client<Array<{
      server_version: string;
      public_tables: number;
      public_columns: number;
      public_indexes: number;
      public_primary_keys: number;
      coupon_issues: number;
      active_coupon_issues: number;
      deleted_coupon_issues: number;
      amount_coupon_issues: number;
      discount_coupon_issues: number;
      general_coupon_issues: number;
      category_coupon_issues: number;
      product_coupon_issues: number;
      brand_coupon_issues: number;
      coupon_user_rows: number;
      unused_coupon_user_rows: number;
      used_coupon_user_rows: number;
      reserved_coupon_user_rows: number;
      claim_evidence_rows: number;
      applicable_product_rows: number;
      paid_product_grant_rows: number;
      lottery_coupon_prizes: number;
      promotion_coupon_rows: number;
      newcomer_coupon_configured: boolean;
      replay_table_exists: boolean;
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
        (SELECT count(*)::integer FROM store_coupon_issue) AS coupon_issues,
        (SELECT count(*)::integer FROM store_coupon_issue WHERE status = 1 AND is_del = 0) AS active_coupon_issues,
        (SELECT count(*)::integer FROM store_coupon_issue WHERE is_del = 1 OR status = -1) AS deleted_coupon_issues,
        (SELECT count(*)::integer FROM store_coupon_issue WHERE type = 1) AS amount_coupon_issues,
        (SELECT count(*)::integer FROM store_coupon_issue WHERE type = 2) AS discount_coupon_issues,
        (SELECT count(*)::integer FROM store_coupon_issue WHERE coupon_type = 0) AS general_coupon_issues,
        (SELECT count(*)::integer FROM store_coupon_issue WHERE coupon_type = 1) AS category_coupon_issues,
        (SELECT count(*)::integer FROM store_coupon_issue WHERE coupon_type = 2) AS product_coupon_issues,
        (SELECT count(*)::integer FROM store_coupon_issue WHERE coupon_type = 3) AS brand_coupon_issues,
        (SELECT count(*)::integer FROM store_coupon_user) AS coupon_user_rows,
        (SELECT count(*)::integer FROM store_coupon_user WHERE status = 0) AS unused_coupon_user_rows,
        (SELECT count(*)::integer FROM store_coupon_user WHERE status = 1) AS used_coupon_user_rows,
        (SELECT count(*)::integer FROM store_coupon_user WHERE status = 3) AS reserved_coupon_user_rows,
        (SELECT count(*)::integer FROM store_coupon_issue_user) AS claim_evidence_rows,
        (SELECT count(*)::integer FROM store_coupon_product) AS applicable_product_rows,
        (SELECT count(*)::integer FROM store_product_coupon) AS paid_product_grant_rows,
        (SELECT count(*)::integer FROM luck_prize WHERE type = 5 AND coupon_id > 0 AND is_del = 0) AS lottery_coupon_prizes,
        (SELECT count(*)::integer FROM store_promotions_auxiliary WHERE coupon_id > 0) AS promotion_coupon_rows,
        EXISTS (
          SELECT 1 FROM system_config
          WHERE is_store = 0 AND menu_name = 'register_give_coupon'
            AND regexp_replace(value, '[^0-9]', '', 'g') <> ''
        ) AS newcomer_coupon_configured,
        to_regclass('public.out_coupon_write_replay') IS NOT NULL AS replay_table_exists,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.out_coupon_write_replay')
            AND conname = 'out_coupon_replay_failure_probe'
        ) AS public_failure_probe_exists,
        (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_out_coupon_%') AS temporary_schemas,
        ARRAY(SELECT nspname FROM pg_namespace WHERE nspname LIKE 'codex_out_coupon_%' ORDER BY nspname)
          AS temporary_schema_names
    `;
    const state = rows[0];
    const replayRows = state.replay_table_exists
      ? Number((await db.$client.unsafe<Array<{ count: number }>>(
          "SELECT count(*)::integer AS count FROM public.out_coupon_write_replay",
        ))[0]?.count ?? 0)
      : 0;
    return { ...state, replay_rows: replayRows };
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function applyReplaySchema(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_coupon_replay_apply",
  });
  try {
    const before = await fingerprintOutCouponPublicState(db);
    const ddl = new MigrationService(createContainerFromDb(db))
      .outCouponWriteReplayMigrationSqlForVerification();
    await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SELECT pg_advisory_xact_lock(744230003, 0)`;
      await tx.unsafe(ddl);
      await tx.unsafe(ddl);
    });
    const after = await fingerprintOutCouponPublicState(db);
    const [verification] = await db.$client<Array<{
      columns: number;
      constraints: number;
      indexes: number;
      rows: number;
    }>>`
      SELECT
        (SELECT count(*)::integer FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'out_coupon_write_replay') AS columns,
        (SELECT count(*)::integer FROM pg_constraint
          WHERE conrelid = 'public.out_coupon_write_replay'::regclass) AS constraints,
        (SELECT count(*)::integer FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'out_coupon_write_replay') AS indexes,
        (SELECT count(*)::integer FROM out_coupon_write_replay) AS rows
    `;
    const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
    if (!publicStateUnchanged || verification.columns !== 8 || verification.constraints !== 4
      || verification.indexes !== 3 || verification.rows !== 0) {
      throw new Error("Out coupon replay schema verification failed");
    }
    return {
      applied: true,
      repeated_apply_succeeded: true,
      public_business_state_unchanged: publicStateUnchanged,
      ...verification,
    };
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    console.log(JSON.stringify({ event: "out_coupon_audit_request", method: request.method, path }));
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
      const scenario = await runOutApiCouponPostgresScenario(env.HYPERDRIVE.connectionString);
      const after = await currentState(env.HYPERDRIVE.connectionString);
      return Response.json({ before, scenario, after });
    } catch (error) {
      console.error(JSON.stringify({
        event: "out_coupon_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
