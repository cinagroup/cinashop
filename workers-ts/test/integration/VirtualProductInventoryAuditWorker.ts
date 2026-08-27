import {
  cleanupVirtualProductInventoryAudit,
  runVirtualProductInventoryAudit,
  setupVirtualProductInventoryAudit,
  verifyVirtualProductInventoryAudit,
} from "./VirtualProductInventoryPostgresScenario";
import { createDbFromConnectionString } from "../../src/lib/di";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_SCHEMA: string;
  AUDIT_KEY: string;
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
    crypto.subtle.digest("SHA-256", encoder.encode(verifier.trim())),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

async function publicVirtualInventorySummary(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_virtual_inventory_public_summary",
  });
  try {
    const rows = await db.$client.unsafe<Array<Record<string, number>>>(`
      WITH inventory AS (
        SELECT
          av.id AS sku_id,
          p.id AS product_id,
          av.stock::int AS sellable_stock,
          COUNT(v.id)::int AS total_cards,
          COUNT(v.id) FILTER (WHERE v.uid = 0)::int AS available_cards
        FROM public.store_product p
        INNER JOIN public.store_product_attr_value av
          ON av.product_id = p.id AND av.type = 0
        LEFT JOIN public.store_product_virtual v
          ON v.product_id = p.id AND v.attr_unique = av."unique"
        WHERE p.is_del = 0
          AND p.product_type = 1
          AND COALESCE(LENGTH(TRIM(av.disk_info)), 0) = 0
        GROUP BY av.id, p.id, av.stock
      ), candidates AS (
        SELECT * FROM inventory WHERE sellable_stock > 0 OR total_cards > 0
      )
      SELECT
        (SELECT COUNT(*)::int FROM public.store_product WHERE is_del = 0 AND product_type = 1) AS card_products,
        (SELECT COUNT(*)::int FROM public.store_product WHERE is_del = 0 AND product_type = 1 AND type = 0) AS platform_card_products,
        (SELECT COUNT(*)::int FROM public.store_product WHERE is_del = 0 AND product_type = 1 AND type = 2) AS supplier_card_products,
        (SELECT COUNT(*)::int FROM public.store_product_attr_value av INNER JOIN public.store_product p ON p.id = av.product_id WHERE p.is_del = 0 AND p.product_type = 1 AND av.type = 0) AS card_skus,
        (SELECT COUNT(*)::int FROM public.store_product_attr_value av INNER JOIN public.store_product p ON p.id = av.product_id WHERE p.is_del = 0 AND p.product_type = 1 AND av.type = 0 AND COALESCE(LENGTH(TRIM(av.disk_info)), 0) > 0) AS fixed_content_skus,
        (SELECT COUNT(*)::int FROM public.store_product_virtual) AS virtual_cards,
        (SELECT COUNT(*)::int FROM public.store_product_virtual WHERE uid = 0) AS available_cards,
        (SELECT COUNT(*)::int FROM public.store_product_virtual WHERE uid > 0) AS assigned_cards,
        (SELECT COUNT(*)::int FROM public.system_virtual_inventory_export) AS export_audit_rows,
        (SELECT COUNT(*)::int FROM public.store_product_virtual v WHERE NOT EXISTS (SELECT 1 FROM public.store_product p WHERE p.id = v.product_id)) AS orphan_product_cards,
        (SELECT COUNT(*)::int FROM public.store_product_virtual v WHERE NOT EXISTS (SELECT 1 FROM public.store_product_attr_value av WHERE av.product_id = v.product_id AND av."unique" = v.attr_unique)) AS orphan_sku_cards,
        (SELECT COUNT(*)::int FROM candidates) AS active_one_time_skus,
        (SELECT COUNT(*)::int FROM candidates WHERE available_cards < sellable_stock) AS shortage_skus_at_5,
        (SELECT COUNT(*)::int FROM candidates WHERE available_cards >= sellable_stock AND available_cards - sellable_stock <= 5) AS low_buffer_skus_at_5,
        (SELECT COUNT(*)::int FROM candidates WHERE available_cards - sellable_stock > 5) AS healthy_skus_at_5
    `);
    return rows[0] ?? {};
  } finally {
    await db.$client.end();
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "POST" && path === "/setup") {
        return Response.json(await setupVirtualProductInventoryAudit(
          env.HYPERDRIVE.connectionString,
          env.AUDIT_SCHEMA,
          env.AUDIT_KEY,
        ));
      }
      if (request.method === "POST" && path === "/run") {
        return Response.json(await runVirtualProductInventoryAudit(
          env.HYPERDRIVE.connectionString,
          env.AUDIT_SCHEMA,
          env.AUDIT_KEY,
        ));
      }
      if (request.method === "GET" && path === "/verify") {
        return Response.json(await verifyVirtualProductInventoryAudit(
          env.HYPERDRIVE.connectionString,
          env.AUDIT_SCHEMA,
          env.AUDIT_KEY,
        ));
      }
      if (request.method === "GET" && path === "/public-summary") {
        return Response.json(await publicVirtualInventorySummary(env.HYPERDRIVE.connectionString));
      }
      if (request.method === "POST" && path === "/cleanup") {
        return Response.json(await cleanupVirtualProductInventoryAudit(
          env.HYPERDRIVE.connectionString,
          env.AUDIT_SCHEMA,
          env.AUDIT_KEY,
        ));
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
