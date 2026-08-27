import { createDbFromConnectionString } from "@/lib/di";
import { REGISTER_CONFIG_KEYS } from "@/services/activity/AdminNewcomerService";
import { runNewcomerAdminPostgresScenario } from "./NewcomerAdminPostgresScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

async function authorize(request: Request, verifier: string): Promise<boolean> {
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
    applicationName: "cinashop-newcomer-current-audit",
  });
  try {
    const [configs, catalog, gifts] = await Promise.all([
      db.$client<{ menu_name: string; value: string }[]>`
        SELECT DISTINCT ON (menu_name) menu_name, value
        FROM system_config
        WHERE is_store = 0 AND menu_name = ANY(${[...REGISTER_CONFIG_KEYS]})
        ORDER BY menu_name, sort DESC, id DESC
      `,
      db.$client<{
        active_products: number;
        duplicate_products: number;
        ineligible_products: number;
        activity_skus: number;
        orphan_activity_skus: number;
      }[]>`
        SELECT
          (SELECT count(*)::int FROM store_newcomer WHERE is_del = 0) AS active_products,
          (SELECT count(*)::int FROM (
            SELECT product_id FROM store_newcomer WHERE is_del = 0 GROUP BY product_id HAVING count(*) > 1
          ) duplicate) AS duplicate_products,
          (SELECT count(*)::int FROM store_newcomer n LEFT JOIN store_product p ON p.id = n.product_id
            WHERE n.is_del = 0 AND (p.id IS NULL OR p.is_del <> 0 OR p.is_show <> 1 OR p.is_verify <> 1
              OR p.is_vip_product <> 0 OR p.is_presale_product <> 0)) AS ineligible_products,
          (SELECT count(*)::int FROM store_product_attr_value WHERE type = 7) AS activity_skus,
          (SELECT count(*)::int FROM store_product_attr_value a
            LEFT JOIN store_newcomer n ON n.id = a.product_id AND n.is_del = 0
            LEFT JOIN store_product_attr_value b ON b.product_id = n.product_id AND b.type = 0 AND b.suk = a.suk
            WHERE a.type = 7 AND (n.id IS NULL OR b.id IS NULL)) AS orphan_activity_skus
      `,
      db.$client<{
        integral_ledgers: number;
        money_ledgers: number;
        newcomer_coupons: number;
        coupon_evidence: number;
      }[]>`
        SELECT
          (SELECT count(*)::int FROM user_bill WHERE type = 'newcomer_add') AS integral_ledgers,
          (SELECT count(*)::int FROM user_money WHERE type = 'newcomer_add') AS money_ledgers,
          (SELECT count(*)::int FROM store_coupon_user WHERE receive_source = 'newcomer') AS newcomer_coupons,
          (SELECT count(*)::int FROM store_coupon_issue_user iu
            WHERE EXISTS (SELECT 1 FROM store_coupon_user cu
              WHERE cu.uid = iu.uid AND cu.issue_coupon_id = iu.issue_coupon_id AND cu.receive_source = 'newcomer')) AS coupon_evidence
      `,
    ]);
    const present = Object.fromEntries(configs.map((row) => [row.menu_name, row.value]));
    return {
      config: present,
      missing_config_keys: REGISTER_CONFIG_KEYS.filter((key) => !(key in present)),
      catalog: catalog[0],
      registration_gifts: gifts[0],
    };
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
      const scenario = await runNewcomerAdminPostgresScenario(env.HYPERDRIVE.connectionString);
      return Response.json({ current, scenario });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
