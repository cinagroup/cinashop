import { createDbFromConnectionString } from "@/lib/di";
import { runOutApiCategoryPostgresScenario } from "./OutApiCategoryPostgresScenario";

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
    applicationName: "cinashop_out_category_public_audit",
  });
  try {
    const rows = await db.$client<Array<{
      server_version: string;
      platform_categories: number;
      active_platform_products: number;
      category_relations: number;
      legacy_category_rows: number;
      category_brand_rows: number;
      temporary_schemas: number;
      temporary_schema_names: string[];
    }>>`
      SELECT
        current_setting('server_version') AS server_version,
        (SELECT count(*)::integer FROM store_product_category WHERE type = 0 AND relation_id = 0) AS platform_categories,
        (SELECT count(*)::integer FROM store_product WHERE type = 0 AND relation_id = 0 AND is_del = 0) AS active_platform_products,
        (SELECT count(*)::integer FROM store_product_relation WHERE type = 1) AS category_relations,
        (SELECT count(*)::integer FROM store_product_cate) AS legacy_category_rows,
        (SELECT count(*)::integer FROM store_product_category_brand) AS category_brand_rows,
        (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_out_category_%') AS temporary_schemas,
        ARRAY(SELECT nspname FROM pg_namespace WHERE nspname LIKE 'codex_out_category_%' ORDER BY nspname) AS temporary_schema_names
    `;
    return rows[0];
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    console.log(JSON.stringify({
      event: "out_category_audit_request",
      method: request.method,
      path,
    }));
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "POST" || !new Set(["/state", "/run"]).has(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      if (path === "/state") {
        return Response.json(await currentState(env.HYPERDRIVE.connectionString));
      }
      const before = await currentState(env.HYPERDRIVE.connectionString);
      const scenario = await runOutApiCategoryPostgresScenario(env.HYPERDRIVE.connectionString);
      const after = await currentState(env.HYPERDRIVE.connectionString);
      return Response.json({ before, scenario, after });
    } catch (error) {
      console.error(JSON.stringify({
        event: "out_category_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
