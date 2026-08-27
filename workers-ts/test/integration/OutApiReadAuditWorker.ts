import { createDbFromConnectionString } from "@/lib/di";
import { runOutApiReadPostgresScenario } from "./OutApiReadPostgresScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

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

async function currentState(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_read_public_audit",
  });
  try {
    const rows = await db.$client<Array<{
      server_version: string;
      out_accounts: number;
      out_interfaces: number;
      get_interfaces: number;
      orders: number;
      refunds: number;
      coupons: number;
      user_levels: number;
      users: number;
      express_companies: number;
      temporary_schemas: number;
    }>>`
      SELECT
        current_setting('server_version') AS server_version,
        (SELECT count(*)::integer FROM out_account WHERE is_del = 0) AS out_accounts,
        (SELECT count(*)::integer FROM out_interface WHERE is_del = 0 AND type = 1) AS out_interfaces,
        (SELECT count(*)::integer FROM out_interface WHERE is_del = 0 AND type = 1 AND lower(method) = 'get') AS get_interfaces,
        (SELECT count(*)::integer FROM store_order WHERE is_system_del = 0) AS orders,
        (SELECT count(*)::integer FROM store_order_refund WHERE is_del = 0 AND is_cancel = 0) AS refunds,
        (SELECT count(*)::integer FROM store_coupon_issue WHERE is_del = 0) AS coupons,
        (SELECT count(*)::integer FROM system_user_level WHERE is_del = 0) AS user_levels,
        (SELECT count(*)::integer FROM "user" WHERE is_del = 0 AND delete_time IS NULL) AS users,
        (SELECT count(*)::integer FROM express_company WHERE is_show = 1 AND status = 1) AS express_companies,
        (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_out_read_%') AS temporary_schemas
    `;
    return rows[0];
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    console.log("[out-read-audit] request", request.method, new URL(request.url).pathname);
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      const current = await currentState(env.HYPERDRIVE.connectionString);
      const scenario = await runOutApiReadPostgresScenario(env.HYPERDRIVE.connectionString);
      return Response.json({ current, scenario });
    } catch (error) {
      console.error("[out-read-audit] failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
