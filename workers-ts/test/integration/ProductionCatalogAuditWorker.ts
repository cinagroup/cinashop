import { createDbFromConnectionString } from "@/lib/di";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

async function authorize(request: Request, verifier: string): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  if (!token || !/^[a-f0-9]{64}$/i.test(verifier ?? "")) return false;
  const bytes = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", bytes.encode(token));
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", bytes.encode(actual)),
    crypto.subtle.digest("SHA-256", bytes.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "GET" || new URL(request.url).pathname !== "/catalog") {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
      applicationName: "cinashop_production_catalog_audit",
    });
    try {
      const result = await db.$client.begin(async (tx) => {
        await tx`SET LOCAL search_path TO public`;
        const version = await tx<{ version: string }[]>`SELECT version() AS version`;
        const tables = await tx<{ table_name: string }[]>`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `;
        const catalog = await tx<{ columns: number; indexes: number; primary_keys: number }[]>`
          SELECT
            (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public') AS columns,
            (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public') AS indexes,
            (SELECT count(*)::int FROM pg_constraint WHERE contype = 'p' AND connamespace = 'public'::regnamespace) AS primary_keys
        `;
        const duplicateConfig = await tx<{ duplicate_keys: number; duplicate_rows: number }[]>`
          SELECT
            count(*)::int AS duplicate_keys,
            coalesce(sum(item_count - 1), 0)::int AS duplicate_rows
          FROM (
            SELECT menu_name, count(*)::int AS item_count
            FROM public.system_config
            WHERE is_store = 0
            GROUP BY menu_name
            HAVING count(*) > 1
          ) duplicated
        `;
        const businessCounts = await tx<Record<string, number>[]>`
          SELECT
            (SELECT count(*)::int FROM public.store_product) AS products,
            (SELECT count(*)::int FROM public.store_order) AS orders,
            (SELECT count(*)::int FROM public.store_order_cart_info) AS order_items,
            (SELECT count(*)::int FROM public.store_order_refund) AS refunds,
            (SELECT count(*)::int FROM public.store_service) AS service_accounts,
            (SELECT count(*)::int FROM public.store_service_record) AS service_sessions,
            (SELECT count(*)::int FROM public.store_service_log) AS service_messages,
            (SELECT count(*)::int FROM public.store_product_description) AS product_descriptions,
            (SELECT count(*)::int FROM public.store_visit) AS visits,
            (SELECT count(*)::int FROM public.store_product_relation WHERE type = 1) AS category_relations
        `;
        const tableNames = new Set(tables.map((row) => row.table_name));
        const migrationRuns = tableNames.has("data_migration_run")
          ? await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM public.data_migration_run`
          : [{ count: 0 }];
        const migrationCheckpoints = tableNames.has("data_migration_checkpoint")
          ? await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM public.data_migration_checkpoint`
          : [{ count: 0 }];
        const waybillJobs = tableNames.has("order_waybill_job")
          ? await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM public.order_waybill_job`
          : [{ count: 0 }];
        const printJobs = tableNames.has("order_print_job")
          ? await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM public.order_print_job`
          : [{ count: 0 }];
        return {
          generated_at: new Date().toISOString(),
          database_version: version[0]?.version ?? "unknown",
          table_count: tableNames.size,
          table_names: [...tableNames],
          catalog: catalog[0],
          migration_control: {
            run_table_exists: tableNames.has("data_migration_run"),
            checkpoint_table_exists: tableNames.has("data_migration_checkpoint"),
            migration_runs: migrationRuns[0]?.count ?? 0,
            migration_checkpoints: migrationCheckpoints[0]?.count ?? 0,
          },
          duplicate_system_config: duplicateConfig[0],
          business_counts: {
            ...businessCounts[0],
            waybill_jobs: waybillJobs[0]?.count ?? 0,
            print_jobs: printJobs[0]?.count ?? 0,
          },
        };
      });
      return Response.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "production_catalog_audit_failed", error: message }));
      return Response.json({ error: message }, { status: 500 });
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
