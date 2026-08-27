import { createContainerFromDb, createDbFromConnectionString } from "@/lib/di";
import { MigrationService } from "@/services/MigrationService";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

const BUSINESS_FINGERPRINT_SQL = `
  SELECT jsonb_build_object(
    'print_document', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.print_document t),
    'store_order', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_order t),
    'store_order_cart_info', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_order_cart_info t),
    'system_config', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.system_config t),
    'store_config', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_config t),
    'express_company', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.express_company t)
  )::text AS fingerprint
`;

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

async function state(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_production_outbox_migration_state",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      const catalog = await tx<{
        tables: number;
        columns: number;
        indexes: number;
        primary_keys: number;
      }[]>`
        SELECT
          (SELECT count(*)::int FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables,
          (SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'public') AS columns,
          (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public') AS indexes,
          (SELECT count(*)::int FROM pg_constraint
            WHERE contype = 'p' AND connamespace = 'public'::regnamespace) AS primary_keys
      `;
      const targets = await tx<{
        table_name: string;
        exists: boolean;
        columns: number;
        indexes: number;
        constraints: number;
      }[]>`
        WITH expected(table_name) AS (VALUES
          ('order_print_job'),
          ('order_print_job_action'),
          ('order_waybill_job'),
          ('order_waybill_job_action')
        )
        SELECT expected.table_name,
          to_regclass('public.' || expected.table_name) IS NOT NULL AS exists,
          (SELECT count(*)::int FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name = expected.table_name) AS columns,
          (SELECT count(*)::int FROM pg_indexes i
            WHERE i.schemaname = 'public' AND i.tablename = expected.table_name) AS indexes,
          (SELECT count(*)::int FROM pg_constraint c
            WHERE c.conrelid = to_regclass('public.' || expected.table_name)) AS constraints
        FROM expected ORDER BY expected.table_name
      `;
      const fingerprint = await tx.unsafe<Array<{ fingerprint: string }>>(BUSINESS_FINGERPRINT_SQL);
      return {
        catalog: catalog[0],
        targets,
        business_fingerprint: fingerprint[0]?.fingerprint ?? "",
      };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function applyMigration(connectionString: string, kind: "print" | "waybill") {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: `cinashop_production_${kind}_migration`,
  });
  let transaction: { business_fingerprint_unchanged: boolean };
  try {
    const service = new MigrationService(createContainerFromDb(db));
    const migration = kind === "print"
      ? service.receiptPrintJobMigrationSqlForVerification()
      : service.waybillJobMigrationSqlForVerification();
    transaction = await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SELECT pg_advisory_xact_lock(hashtext('cinashop-production-outbox-migration'))`;
      const before = await tx.unsafe<Array<{ fingerprint: string }>>(BUSINESS_FINGERPRINT_SQL);
      await tx.unsafe(migration);
      const after = await tx.unsafe<Array<{ fingerprint: string }>>(BUSINESS_FINGERPRINT_SQL);
      if (!before[0] || before[0].fingerprint !== after[0]?.fingerprint) {
        throw new Error("business fingerprint changed inside DDL transaction");
      }
      return { business_fingerprint_unchanged: true };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
  return { kind, ...transaction, state: await state(connectionString) };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && path === "/state") {
        return Response.json(await state(env.HYPERDRIVE.connectionString));
      }
      if (request.method === "POST" && path === "/apply-print") {
        return Response.json(await applyMigration(env.HYPERDRIVE.connectionString, "print"));
      }
      if (request.method === "POST" && path === "/apply-waybill") {
        return Response.json(await applyMigration(env.HYPERDRIVE.connectionString, "waybill"));
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "production_outbox_migration_failed", path, error: message }));
      return Response.json({ error: message }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
