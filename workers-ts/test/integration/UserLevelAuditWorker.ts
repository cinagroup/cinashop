import { createDbFromConnectionString } from "@/lib/di";
import {
  cleanupUserLevelAudit,
  cleanupPublicUserLevelAuditMarkers,
  cleanupUserLevelAuditSchemas,
  inspectPublicUserLevelAuditMarkers,
  listUserLevelAuditSchemas,
  runUserLevelAudit,
  runUserProfileAudit,
  setupUserLevelAudit,
  smokeProductionUserProfile,
  verifyUserLevelAudit,
  verifyUserProfileAudit,
} from "./UserLevelPostgresScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_SCHEMA: string;
  AUDIT_TOKEN_SHA256: string;
}

async function authorize(request: Request, verifier: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const token = request.headers.get("X-Audit-Token") ?? "";
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

async function productionState(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api003_state",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '20s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const state = await tx<Record<string, unknown>[]>`
        SELECT
          current_setting('server_version') AS server_version,
          (SELECT count(*)::int FROM public."user") AS users,
          (SELECT count(*)::int FROM public."user" WHERE level_status = 1 AND is_del = 0) AS activated_users,
          (SELECT count(*)::int FROM public.system_user_level WHERE is_del = 0 AND is_show = 1) AS visible_levels,
          (SELECT count(*)::int FROM public.user_level WHERE status = 1 AND is_del = 0) AS active_user_levels,
          (SELECT count(*)::int FROM public.user_bill WHERE event_key = 'level_give_integral') AS activation_integral_bills,
          (SELECT count(*)::int FROM public.user_money WHERE type = 'level_add') AS activation_money_bills,
          (SELECT count(*)::int FROM public.store_coupon_user WHERE receive_source = 'activate_level') AS activation_coupons,
          (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'codex_api003_%') AS temporary_schemas
      `;
      const config = await tx<Array<{ menu_name: string; value: string; rows: number }>>`
        SELECT menu_name, (array_agg(value ORDER BY sort DESC, id DESC))[1] AS value, count(*)::int AS rows
        FROM public.system_config
        WHERE is_store = 0 AND menu_name IN (
          'member_func_status', 'level_activate_status', 'level_extend_info',
          'level_integral_status', 'level_give_integral', 'level_money_status',
          'level_give_money', 'level_coupon_status', 'level_give_coupon'
        )
        GROUP BY menu_name
        ORDER BY menu_name
      `;
      return { transaction: "READ ONLY", state: state[0], config };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && path === "/state") {
        return Response.json(await productionState(env.HYPERDRIVE.connectionString));
      }
      if (request.method === "GET" && path === "/profile-smoke") {
        return Response.json(await smokeProductionUserProfile(env.HYPERDRIVE.connectionString));
      }
      if (request.method === "GET" && path === "/public-markers") {
        return Response.json(await inspectPublicUserLevelAuditMarkers(env.HYPERDRIVE.connectionString));
      }
      if (request.method === "POST" && path === "/public-marker-cleanup") {
        return Response.json(await cleanupPublicUserLevelAuditMarkers(env.HYPERDRIVE.connectionString));
      }
      if (request.method === "GET" && path === "/orphan-schemas") {
        return Response.json({ schemas: await listUserLevelAuditSchemas(env.HYPERDRIVE.connectionString) });
      }
      if (request.method === "POST" && path === "/orphan-schema-cleanup") {
        return Response.json(await cleanupUserLevelAuditSchemas(env.HYPERDRIVE.connectionString));
      }
      if (request.method === "POST" && path === "/maintenance") {
        const schemas = await cleanupUserLevelAuditSchemas(env.HYPERDRIVE.connectionString);
        const publicMarkers = await inspectPublicUserLevelAuditMarkers(env.HYPERDRIVE.connectionString);
        return Response.json({ schemas, public_markers: publicMarkers });
      }
      if (request.method === "POST" && path === "/full") {
        let setup = false;
        try {
          const production = await productionState(env.HYPERDRIVE.connectionString);
          const seeded = await setupUserLevelAudit(env.HYPERDRIVE.connectionString, env.AUDIT_SCHEMA);
          setup = true;
          const run = await runUserLevelAudit(env.HYPERDRIVE.connectionString, env.AUDIT_SCHEMA);
          const profileRun = await runUserProfileAudit(env.HYPERDRIVE.connectionString, env.AUDIT_SCHEMA);
          const verify = await verifyUserLevelAudit(env.HYPERDRIVE.connectionString, env.AUDIT_SCHEMA);
          const profileVerify = await verifyUserProfileAudit(env.HYPERDRIVE.connectionString, env.AUDIT_SCHEMA);
          const profileSmoke = await smokeProductionUserProfile(env.HYPERDRIVE.connectionString);
          return Response.json({
            production,
            setup: seeded,
            run,
            profile_run: profileRun,
            verify,
            profile_verify: profileVerify,
            profile_smoke: profileSmoke,
          });
        } finally {
          if (setup) await cleanupUserLevelAudit(env.HYPERDRIVE.connectionString, env.AUDIT_SCHEMA);
        }
      }
      if (request.method === "POST" && path === "/setup") {
        return Response.json(await setupUserLevelAudit(env.HYPERDRIVE.connectionString, env.AUDIT_SCHEMA));
      }
      if (request.method === "POST" && path === "/run") {
        return Response.json(await runUserLevelAudit(env.HYPERDRIVE.connectionString, env.AUDIT_SCHEMA));
      }
      if (request.method === "GET" && path === "/verify") {
        return Response.json(await verifyUserLevelAudit(env.HYPERDRIVE.connectionString, env.AUDIT_SCHEMA));
      }
      if (request.method === "POST" && path === "/cleanup") {
        return Response.json(await cleanupUserLevelAudit(env.HYPERDRIVE.connectionString, env.AUDIT_SCHEMA));
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
      console.error(JSON.stringify({
        event: "api003_user_level_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
