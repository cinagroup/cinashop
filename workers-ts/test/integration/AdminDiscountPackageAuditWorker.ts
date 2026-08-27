import { createDbFromConnectionString } from "@/lib/di";
import { runAdminDiscountPackagePostgresScenario } from "./AdminDiscountPackagePostgresScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

async function authorize(request: Request, verifier: string): Promise<boolean> {
  if (!verifier) return false;
  const token = request.headers.get("X-Audit-Token") ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

async function currentState(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_admin_discount_public_audit",
  });
  try {
    const rows = await db.$client<Array<{
      server_version: string;
      packages: number;
      active_packages: number;
      deleted_packages: number;
      package_products: number;
      package_attrs: number;
      package_results: number;
      package_skus: number;
      orphan_products: number;
      orphan_skus: number;
      audit_schemas: number;
    }>>`
      SELECT
        current_setting('server_version') AS server_version,
        (SELECT count(*)::integer FROM store_discounts) AS packages,
        (SELECT count(*)::integer FROM store_discounts WHERE status = 1 AND is_del = 0) AS active_packages,
        (SELECT count(*)::integer FROM store_discounts WHERE is_del <> 0) AS deleted_packages,
        (SELECT count(*)::integer FROM store_discounts_products) AS package_products,
        (SELECT count(*)::integer FROM store_product_attr WHERE type = 5) AS package_attrs,
        (SELECT count(*)::integer FROM store_product_attr_result WHERE type = 5) AS package_results,
        (SELECT count(*)::integer FROM store_product_attr_value WHERE type = 5) AS package_skus,
        (SELECT count(*)::integer FROM store_discounts_products p
          LEFT JOIN store_discounts d ON d.id = p.discount_id WHERE d.id IS NULL) AS orphan_products,
        (SELECT count(*)::integer FROM store_product_attr_value s
          LEFT JOIN store_discounts_products p ON p.id = s.product_id
          WHERE s.type = 5 AND p.id IS NULL) AS orphan_skus
        ,(SELECT count(*)::integer FROM pg_namespace
          WHERE nspname LIKE 'codex_admin_discount_%') AS audit_schemas
    `;
    return rows[0];
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      const current = await currentState(env.HYPERDRIVE.connectionString);
      const scenario = await runAdminDiscountPackagePostgresScenario(env.HYPERDRIVE.connectionString);
      return Response.json({ current, scenario });
    } catch (error) {
      console.error("[admin-discount-package-audit] failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
