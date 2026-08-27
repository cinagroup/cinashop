import { createDbFromConnectionString } from "@/lib/di";
import { runFirstOrderDiscountPostgresScenario } from "./FirstOrderDiscountPostgresScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

async function authorize(request: Request, verifier: string): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

async function productionAudit(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop-first-order-audit",
  });
  try {
    const nonce = crypto.randomUUID();
    const [config, users, orders] = await Promise.all([
      db.$client<{
        menu_name: string;
        value: string;
      }[]>`
        SELECT DISTINCT ON (menu_name) menu_name, value
        FROM system_config
        WHERE menu_name IN (
          'newcomer_status', 'first_order_status', 'first_order_discount',
          'first_order_discount_limit', 'newcomer_limit_status', 'newcomer_limit_time'
        ) AND ${nonce} <> ''
        ORDER BY menu_name, sort DESC, id DESC
      `,
      db.$client<{
        active_users: number;
        available: number;
        consumed: number;
        unavailable: number;
      }[]>`
        SELECT
          count(*) FILTER (WHERE is_del = 0)::integer AS active_users,
          count(*) FILTER (WHERE is_del = 0 AND is_first_order = 0)::integer AS available,
          count(*) FILTER (WHERE is_del = 0 AND is_first_order = 1)::integer AS consumed,
          count(*) FILTER (WHERE is_del = 0 AND is_first_order = -1)::integer AS unavailable
        FROM "user"
        WHERE ${nonce} <> ''
      `,
      db.$client<{
        orders: number;
        discounted_orders: number;
        discounted_total: string;
        coupon_overlap: number;
        max_discount: string;
      }[]>`
        SELECT
          count(*)::integer AS orders,
          count(*) FILTER (WHERE first_order_price > 0)::integer AS discounted_orders,
          COALESCE(sum(first_order_price) FILTER (WHERE first_order_price > 0), 0)::text AS discounted_total,
          count(*) FILTER (WHERE first_order_price > 0 AND (coupon_price > 0 OR coupon_id > 0))::integer AS coupon_overlap,
          COALESCE(max(first_order_price), 0)::text AS max_discount
        FROM store_order
        WHERE ${nonce} <> ''
      `,
    ]);
    return {
      config: Object.fromEntries(config.map((row) => [row.menu_name, row.value])),
      users: users[0],
      orders: orders[0],
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
      const current = await productionAudit(env.HYPERDRIVE.connectionString);
      const scenario = await runFirstOrderDiscountPostgresScenario(
        env.HYPERDRIVE.connectionString,
      );
      return Response.json({ current, scenario });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
