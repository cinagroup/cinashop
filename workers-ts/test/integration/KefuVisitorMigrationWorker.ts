import type postgres from "postgres";
import { createContainerFromDb, createDbFromConnectionString } from "@/lib/di";
import { MigrationService } from "@/services/MigrationService";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

type Sql = postgres.Sql<Record<string, never>>;

const EXPECTED_COLUMNS = [
  "avatar",
  "created_at",
  "expires_at",
  "kefu_uid",
  "last_seen_at",
  "nickname",
  "revoked_at",
  "service_id",
  "session_id",
  "token_hash",
  "visitor_uid",
] as const;

const EXPECTED_CONSTRAINTS = [
  "kefu_visitor_session_pkey",
  "kefu_visitor_session_token_hash_key",
  "kefu_visitor_session_visitor_uid_key",
  "kvs_positive_ids_ck",
  "kvs_time_ck",
  "kvs_token_hash_ck",
] as const;

const EXPECTED_INDEXES = [
  "kefu_visitor_session_pkey",
  "kefu_visitor_session_token_hash_key",
  "kefu_visitor_session_visitor_uid_key",
  "kvs_active_expiry",
  "kvs_kefu_active",
] as const;

const BUSINESS_FINGERPRINT_SQL = `
  SELECT jsonb_build_object(
    'store_service', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_service t),
    'store_service_record', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_service_record t),
    'store_service_log', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_service_log t),
    'store_order', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_order t)
  )::text AS fingerprint
`;

async function authorize(request: Request, verifier: string): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  if (!token || !/^[a-f0-9]{64}$/i.test(verifier ?? "")) return false;
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier.trim())),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

async function relationState(client: Sql, schema: string) {
  const rows = await client.unsafe<Array<{
    table_exists: boolean;
    sequence_exists: boolean;
    transfer_is_tourist: boolean;
    transfer_constraint: boolean;
    transfer_scope_index: boolean;
  }>>(`
    SELECT
      to_regclass('${schema}.kefu_visitor_session') IS NOT NULL AS table_exists,
      to_regclass('${schema}.kefu_visitor_uid_seq') IS NOT NULL AS sequence_exists,
      EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = '${schema}' AND table_name = 'store_service_transfer'
          AND column_name = 'is_tourist' AND data_type = 'smallint' AND is_nullable = 'NO'
      ) AS transfer_is_tourist,
      EXISTS(
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('${schema}.store_service_transfer')
          AND conname = 'sst_is_tourist_ck'
      ) AS transfer_constraint,
      EXISTS(
        SELECT 1 FROM pg_indexes
        WHERE schemaname = '${schema}' AND tablename = 'store_service_transfer'
          AND indexname = 'sst_customer_scope_time'
      ) AS transfer_scope_index
  `);
  const base = rows[0];
  if (!base) throw new Error("could not read visitor migration state");
  if (!base.table_exists) {
    return { ...base, row_count: null, columns: [], constraints: [], indexes: [] };
  }
  const detail = await client.unsafe<Array<{
    row_count: number;
    columns: string[];
    constraints: string[];
    indexes: string[];
  }>>(`
    SELECT
      (SELECT count(*)::int FROM ${identifier(schema)}.kefu_visitor_session) AS row_count,
      ARRAY(
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = '${schema}' AND table_name = 'kefu_visitor_session'
        ORDER BY column_name
      ) AS columns,
      ARRAY(
        SELECT conname FROM pg_constraint
        WHERE conrelid = to_regclass('${schema}.kefu_visitor_session')
        ORDER BY conname
      ) AS constraints,
      ARRAY(
        SELECT indexname FROM pg_indexes
        WHERE schemaname = '${schema}' AND tablename = 'kefu_visitor_session'
        ORDER BY indexname
      ) AS indexes
  `);
  if (!detail[0]) throw new Error("could not read visitor migration details");
  return { ...base, ...detail[0] };
}

function validateState(state: Awaited<ReturnType<typeof relationState>>, requireEmpty: boolean): void {
  if (!state.table_exists || !state.sequence_exists) {
    throw new Error(
      `visitor relation missing: table=${state.table_exists}, sequence=${state.sequence_exists}`,
    );
  }
  if (requireEmpty && state.row_count !== 0) throw new Error("new visitor table is not empty");
  if (JSON.stringify(state.columns) !== JSON.stringify(EXPECTED_COLUMNS)) {
    throw new Error(`visitor columns differ: ${state.columns.join(",")}`);
  }
  if (JSON.stringify(state.constraints) !== JSON.stringify(EXPECTED_CONSTRAINTS)) {
    throw new Error(`visitor constraints differ: ${state.constraints.join(",")}`);
  }
  if (JSON.stringify(state.indexes) !== JSON.stringify(EXPECTED_INDEXES)) {
    throw new Error(`visitor indexes differ: ${state.indexes.join(",")}`);
  }
  if (!state.transfer_is_tourist || !state.transfer_constraint || !state.transfer_scope_index) {
    throw new Error("transfer visitor scope is incomplete");
  }
}

async function publicState(client: Sql) {
  const [catalog, fingerprint] = await Promise.all([
    client<Array<{ tables: number; service_rows: string; record_rows: string; log_rows: string }>>`
      SELECT
        (SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables,
        (SELECT count(*)::text FROM public.store_service) AS service_rows,
        (SELECT count(*)::text FROM public.store_service_record) AS record_rows,
        (SELECT count(*)::text FROM public.store_service_log) AS log_rows
    `,
    client.unsafe<Array<{ fingerprint: string }>>(BUSINESS_FINGERPRINT_SQL),
  ]);
  return {
    catalog: catalog[0],
    target: await relationState(client, "public"),
    business_fingerprint: fingerprint[0]?.fingerprint ?? "",
  };
}

async function isolatedRehearsal(client: Sql, transferSql: string, visitorSql: string) {
  const schema = `codex_kefu_visitor_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const rollbackMarker = "EXPECTED_KEFU_VISITOR_REHEARSAL_ROLLBACK";
  try {
    await client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx.unsafe(`CREATE SCHEMA ${identifier(schema)}`);
      await tx.unsafe(`SET LOCAL search_path TO ${identifier(schema)}`);
      await tx.unsafe(transferSql);
      await tx.unsafe(visitorSql);
      const initial = await relationState(tx as unknown as Sql, schema);
      validateState(initial, true);
      const now = Math.floor(Date.now() / 1_000);
      await tx.unsafe(`
        INSERT INTO ${identifier(schema)}.kefu_visitor_session
          (session_id, service_id, kefu_uid, token_hash, nickname,
           created_at, expires_at, last_seen_at, revoked_at)
        VALUES
          ('11111111-1111-4111-8111-111111111111', 1, 1001,
           repeat('a', 64), 'isolated visitor', ${now}, ${now + 3600}, ${now}, 0)
      `);
      const generated = await tx.unsafe<Array<{ visitor_uid: number }>>(`
        SELECT visitor_uid FROM ${identifier(schema)}.kefu_visitor_session
      `);
      if (generated[0]?.visitor_uid !== 1_000_000_000) {
        throw new Error("visitor UID sequence did not start in the isolated range");
      }
      await tx.unsafe(visitorSql);
      validateState(await relationState(tx as unknown as Sql, schema), false);
      throw new Error(rollbackMarker);
    });
    throw new Error("isolated rehearsal did not roll back");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== rollbackMarker) throw error;
  }
  const schemas = await client<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = ${schema}
  `;
  if (schemas[0]?.count !== 0) throw new Error("isolated rehearsal schema was not removed");
  return { passed: true, schema_removed: true, generated_uid: 1_000_000_000 };
}

async function applyMigration(client: Sql, visitorSql: string) {
  const before = await publicState(client);
  await client.begin(async (tx) => {
    await tx`SET LOCAL search_path TO public`;
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx`SELECT pg_advisory_xact_lock(hashtext('cinashop-kefu-visitor-migration'))`;
    const fingerprint = await tx.unsafe<Array<{ fingerprint: string }>>(BUSINESS_FINGERPRINT_SQL);
    await tx.unsafe(visitorSql);
    validateState(await relationState(tx as unknown as Sql, "public"), true);
    const after = await tx.unsafe<Array<{ fingerprint: string }>>(BUSINESS_FINGERPRINT_SQL);
    if (fingerprint[0]?.fingerprint !== after[0]?.fingerprint) {
      throw new Error("business fingerprint changed inside migration transaction");
    }
  });
  const after = await publicState(client);
  validateState(after.target, true);
  if (before.business_fingerprint !== after.business_fingerprint) {
    throw new Error("business fingerprint changed after migration commit");
  }
  return { applied: true, business_fingerprint_unchanged: true, before, after };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
      applicationName: "cinashop_kefu_visitor_migration",
    });
    try {
      const migration = new MigrationService(createContainerFromDb(db));
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/state") {
        return Response.json(await publicState(db.$client));
      }
      if (request.method === "POST" && path === "/isolated") {
        return Response.json(await isolatedRehearsal(
          db.$client,
          migration.kefuTransferMigrationSqlForVerification(),
          migration.kefuVisitorSessionMigrationSqlForVerification(),
        ));
      }
      if (request.method === "POST" && path === "/apply") {
        return Response.json(await applyMigration(
          db.$client,
          migration.kefuVisitorSessionMigrationSqlForVerification(),
        ));
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "kefu_visitor_migration_failed", error: message }));
      return Response.json({ error: message }, { status: 500 });
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
