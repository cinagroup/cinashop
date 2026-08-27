import { createDbFromConnectionString } from "@/lib/di";
import { runDiscountPackagePostgresScenario } from "./DiscountPackagePostgresScenario";

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
    applicationName: "cinashop_discount_package_public_audit",
  });
  try {
    const rows = await db.$client<Array<{
      server_version: string;
      packages: number;
      active_packages: number;
      package_products: number;
      package_skus: number;
      carts: number;
      unpaid_carts: number;
      orders: number;
      paid_orders: number;
    }>>`
      SELECT
        current_setting('server_version') AS server_version,
        (SELECT count(*)::integer FROM store_discounts) AS packages,
        (SELECT count(*)::integer FROM store_discounts
          WHERE status = 1 AND is_del = 0
            AND (start_time = 0 OR start_time <= EXTRACT(EPOCH FROM NOW())::integer)
            AND (stop_time = 0 OR stop_time >= EXTRACT(EPOCH FROM NOW())::integer)
            AND (is_limit = 0 OR limit_num > 0)) AS active_packages,
        (SELECT count(*)::integer FROM store_discounts_products) AS package_products,
        (SELECT count(*)::integer FROM store_product_attr_value WHERE type = 5) AS package_skus,
        (SELECT count(*)::integer FROM store_cart WHERE type = 5) AS carts,
        (SELECT count(*)::integer FROM store_cart WHERE type = 5 AND is_pay = 0 AND is_del = 0) AS unpaid_carts,
        (SELECT count(*)::integer FROM store_order WHERE type = 5) AS orders,
        (SELECT count(*)::integer FROM store_order WHERE type = 5 AND paid = 1) AS paid_orders
    `;
    return rows[0];
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    console.log("[discount-package-audit] request", request.method, new URL(request.url).pathname);
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      console.log("[discount-package-audit] reading public snapshot");
      const current = await currentState(env.HYPERDRIVE.connectionString);
      console.log("[discount-package-audit] running isolated scenario");
      const scenario = await runDiscountPackagePostgresScenario(env.HYPERDRIVE.connectionString);
      console.log("[discount-package-audit] isolated scenario completed");
      return Response.json({ current, scenario });
    } catch (error) {
      console.error("[discount-package-audit] failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
