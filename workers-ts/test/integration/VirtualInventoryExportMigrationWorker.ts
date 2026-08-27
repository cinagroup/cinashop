import { sql } from "drizzle-orm";
import { createDbFromConnectionString, type DbClient } from "../../src/lib/di";

interface MigrationAuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

export const VIRTUAL_INVENTORY_EXPORT_MIGRATION_SQL = `-- Replace the PHP editor's unrestricted plaintext virtual_list replay with a
-- short-lived, actor/tenant-bound and one-time export authorization. Only the
-- SHA-256 digest of the bearer ticket is persisted; card secrets stay in the
-- existing inventory table and the one successful response.
CREATE TABLE IF NOT EXISTS "system_virtual_inventory_export" (
  "id" SERIAL PRIMARY KEY,
  "token_hash" VARCHAR(64) NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL,
  "actor_id" INTEGER NOT NULL,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER NOT NULL,
  "attr_unique" VARCHAR(20) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "requested_count" INTEGER NOT NULL,
  "exported_count" INTEGER DEFAULT 0 NOT NULL,
  "status" VARCHAR(16) DEFAULT 'READY' NOT NULL,
  "created_at" TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "consumed_at" TIMESTAMPTZ,
  CONSTRAINT "svie_actor_type_ck" CHECK ("actor_type" IN ('admin', 'supplier')),
  CONSTRAINT "svie_status_ck" CHECK ("status" IN ('READY', 'CONSUMED', 'EXPIRED')),
  CONSTRAINT "svie_identity_ck" CHECK (
    "actor_id" > 0 AND "supplier_id" >= 0 AND "product_id" > 0
  ),
  CONSTRAINT "svie_count_ck" CHECK (
    "requested_count" > 0 AND "requested_count" <= 1000
      AND "exported_count" >= 0 AND "exported_count" <= 1000
  ),
  CONSTRAINT "svie_expiry_ck" CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX IF NOT EXISTS "svie_token_hash_uq"
  ON "system_virtual_inventory_export" ("token_hash");
CREATE INDEX IF NOT EXISTS "svie_actor_history"
  ON "system_virtual_inventory_export" ("actor_type", "actor_id", "id");
CREATE INDEX IF NOT EXISTS "svie_product_history"
  ON "system_virtual_inventory_export" ("product_id", "attr_unique", "id");
CREATE INDEX IF NOT EXISTS "svie_ready_expiry"
  ON "system_virtual_inventory_export" ("expires_at", "id")
  WHERE "status" = 'READY';
`;

const EXPECTED_CONSTRAINTS = [
  "system_virtual_inventory_export_pkey",
  "svie_actor_type_ck",
  "svie_status_ck",
  "svie_identity_ck",
  "svie_count_ck",
  "svie_expiry_ck",
];
const EXPECTED_INDEXES = [
  "system_virtual_inventory_export_pkey",
  "svie_token_hash_uq",
  "svie_actor_history",
  "svie_product_history",
  "svie_ready_expiry",
];

interface ProductionMigrationState {
  table_exists: boolean;
  public_table_count: number;
  product_count: string;
  card_count: string;
  product_sequence: string;
  card_sequence: string;
  row_count: number | null;
  constraints: string[];
  indexes: string[];
  secret_columns: string[];
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

async function state(db: DbClient): Promise<ProductionMigrationState> {
  const baseRows = await db.$client.unsafe<Array<{
    table_exists: boolean;
    public_table_count: number;
    product_count: string;
    card_count: string;
    product_sequence: string;
    card_sequence: string;
  }>>(`
    SELECT
      to_regclass('public.system_virtual_inventory_export') IS NOT NULL AS table_exists,
      (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public') AS public_table_count,
      (SELECT count(*)::text FROM public.store_product) AS product_count,
      (SELECT count(*)::text FROM public.store_product_virtual) AS card_count,
      (SELECT last_value::text FROM public.store_product_id_seq) AS product_sequence,
      (SELECT last_value::text FROM public.store_product_virtual_id_seq) AS card_sequence
  `);
  const base = baseRows[0];
  if (!base) throw new Error("could not read production schema state");
  if (!base.table_exists) {
    return { ...base, row_count: null, constraints: [], indexes: [], secret_columns: [] };
  }
  const [detail] = await db.$client.unsafe<Array<{
    row_count: number;
    constraints: string[];
    indexes: string[];
    secret_columns: string[];
  }>>(`
    SELECT
      (SELECT count(*)::int FROM public.system_virtual_inventory_export) AS row_count,
      ARRAY(
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.system_virtual_inventory_export'::regclass
        ORDER BY conname
      ) AS constraints,
      ARRAY(
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'system_virtual_inventory_export'
        ORDER BY indexname
      ) AS indexes,
      ARRAY(
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'system_virtual_inventory_export'
          AND column_name IN ('card_no', 'card_pwd')
        ORDER BY column_name
      ) AS secret_columns
  `);
  return { ...base, ...detail };
}

function validateAppliedState(value: Awaited<ReturnType<typeof state>>): void {
  if (!value.table_exists) throw new Error("export audit table was not created");
  if (value.row_count !== 0) throw new Error("new export audit table is not empty");
  if (JSON.stringify(value.constraints) !== JSON.stringify([...EXPECTED_CONSTRAINTS].sort())) {
    throw new Error("export audit constraints are incomplete");
  }
  if (JSON.stringify(value.indexes) !== JSON.stringify([...EXPECTED_INDEXES].sort())) {
    throw new Error("export audit indexes are incomplete");
  }
  if (value.secret_columns.length !== 0) throw new Error("export audit table contains card secrets");
}

async function validateAppliedTransaction(db: DbClient): Promise<void> {
  const rows = await db.execute(sql`
    SELECT
      to_regclass('public.system_virtual_inventory_export') IS NOT NULL AS table_exists,
      (SELECT count(*)::int FROM public.system_virtual_inventory_export) AS row_count,
      ARRAY(
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.system_virtual_inventory_export'::regclass
        ORDER BY conname
      ) AS constraints,
      ARRAY(
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'system_virtual_inventory_export'
        ORDER BY indexname
      ) AS indexes,
      ARRAY(
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'system_virtual_inventory_export'
          AND column_name IN ('card_no', 'card_pwd')
        ORDER BY column_name
      ) AS secret_columns
  `) as unknown as Array<{
    table_exists: boolean;
    row_count: number;
    constraints: string[];
    indexes: string[];
    secret_columns: string[];
  }>;
  const value = rows[0];
  if (!value) throw new Error("could not validate export audit table in transaction");
  validateAppliedState({
    ...value,
    public_table_count: 0,
    product_count: "",
    card_count: "",
    product_sequence: "",
    card_sequence: "",
  });
}

async function rehearse(db: DbClient) {
  const before = await state(db);
  if (before.table_exists) return { skipped_existing: true, before, after: before };
  const rollbackMarker = "EXPECTED_VIRTUAL_EXPORT_MIGRATION_ROLLBACK";
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL search_path TO public"));
      await tx.execute(sql.raw(VIRTUAL_INVENTORY_EXPORT_MIGRATION_SQL));
      await validateAppliedTransaction(tx as unknown as DbClient);
      throw new Error(rollbackMarker);
    });
    throw new Error("migration rehearsal did not roll back");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== rollbackMarker) throw error;
  }
  const after = await state(db);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("production state changed after rollback rehearsal");
  }
  return { skipped_existing: false, rolled_back: true, before, after };
}

async function applyMigration(db: DbClient) {
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL search_path TO public"));
    await tx.execute(sql.raw(VIRTUAL_INVENTORY_EXPORT_MIGRATION_SQL));
    await validateAppliedTransaction(tx as unknown as DbClient);
  });
  const after = await state(db);
  validateAppliedState(after);
  return after;
}

async function rollbackEmptyTable(db: DbClient, request: Request) {
  const body = await request.json().catch(() => null) as { confirm?: unknown } | null;
  if (body?.confirm !== "ROLLBACK_EMPTY_VIRTUAL_INVENTORY_EXPORT") {
    throw new Error("rollback confirmation missing");
  }
  const current = await state(db);
  if (!current.table_exists) return { removed: true, already_absent: true };
  if (current.row_count !== 0) throw new Error("refusing to drop a non-empty export audit table");
  await db.execute(sql.raw('DROP TABLE "system_virtual_inventory_export"'));
  const after = await state(db);
  if (after.table_exists) throw new Error("export audit table still exists after rollback");
  return { removed: true, already_absent: false, after };
}

export default {
  async fetch(request: Request, env: MigrationAuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/ping") {
      return Response.json({ ok: true });
    }
    const db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
      applicationName: "cinashop_virtual_export_migration",
    });
    try {
      if (request.method === "GET" && path === "/state") return Response.json(await state(db));
      if (request.method === "POST" && path === "/rehearse") return Response.json(await rehearse(db));
      if (request.method === "POST" && path === "/apply") return Response.json(await applyMigration(db));
      if (request.method === "POST" && path === "/rollback-empty") {
        return Response.json(await rollbackEmptyTable(db, request));
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    } finally {
      await db.$client.end();
    }
  },
} satisfies ExportedHandler<MigrationAuditEnv>;
