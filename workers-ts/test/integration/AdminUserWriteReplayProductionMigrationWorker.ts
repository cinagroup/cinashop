import postgres from "postgres";
import { ADMIN_MOBILE_USER_REPLAY_SQL } from "@/migrations/adminMobileUserReplay";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & {
  AUDIT_TOKEN_SHA256: string;
};

type SqlClient = postgres.TransactionSql;

interface CatalogSummary {
  tables: number;
  columns: number;
  indexes: number;
  primary_keys: number;
}

interface ReplayState {
  table_exists: boolean;
  sequence_exists: boolean;
  row_count: number | null;
  columns_ready: boolean;
  constraints_ready: boolean;
  indexes_ready: boolean;
  definition_digest: string;
  ready: boolean;
}

const EXPECTED_COLUMNS = [
  ["id", "bigint", true],
  ["admin_id", "integer", true],
  ["operation", "character varying(32)", true],
  ["request_key", "character varying(36)", true],
  ["request_hash", "character varying(64)", true],
  ["user_id", "integer", true],
  ["target_count", "integer", true],
  ["money_ledger_id", "integer", true],
  ["integral_ledger_id", "integer", true],
  ["other_order_id", "integer", true],
  ["coupon_issue_id", "integer", true],
  ["add_time", "integer", true],
] as const;

const EXPECTED_INDEXES = new Map<string, { unique: boolean; columns: string[] }>([
  ["admin_user_write_replay_pkey", { unique: true, columns: ["id"] }],
  ["auwr_admin_operation_key_uq", {
    unique: true,
    columns: ["admin_id", "operation", "request_key"],
  }],
  ["auwr_user_history", { unique: false, columns: ["user_id", "id"] }],
  ["auwr_coupon_history", { unique: false, columns: ["coupon_issue_id", "id"] }],
]);

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorize(request: Request, verifier: string): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  if (!token || !/^[a-f0-9]{64}$/i.test(verifier ?? "")) return false;
  const actual = await sha256(token);
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

async function readCatalogSummary(sql: SqlClient): Promise<CatalogSummary> {
  const row = (await sql<CatalogSummary[]>`
    SELECT
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r') AS tables,
      (SELECT count(*)::integer FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
      (SELECT count(*)::integer FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS indexes,
      (SELECT count(*)::integer FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND c.contype = 'p') AS primary_keys
  `)[0];
  if (!row) throw new Error("catalog summary returned no row");
  return row;
}

async function readBusinessSnapshot(sql: SqlClient) {
  const row = (await sql<{
    admins: number;
    users: number;
    user_money: number;
    user_bill: number;
    other_order: number;
    coupon_issue: number;
    coupon_users: number;
    system_logs: number;
  }[]>`
    SELECT
      (SELECT count(*)::integer FROM system_admin) AS admins,
      (SELECT count(*)::integer FROM "user") AS users,
      (SELECT count(*)::integer FROM user_money) AS user_money,
      (SELECT count(*)::integer FROM user_bill) AS user_bill,
      (SELECT count(*)::integer FROM other_order) AS other_order,
      (SELECT count(*)::integer FROM store_coupon_issue) AS coupon_issue,
      (SELECT count(*)::integer FROM store_coupon_user) AS coupon_users,
      (SELECT count(*)::integer FROM system_log) AS system_logs
  `)[0];
  if (!row) throw new Error("business snapshot returned no row");
  return row;
}

async function readReplayState(sql: SqlClient): Promise<ReplayState> {
  const tableRow = (await sql<{ table_exists: boolean; sequence_exists: boolean }[]>`
    SELECT
      to_regclass('public.admin_user_write_replay') IS NOT NULL AS table_exists,
      to_regclass('public.admin_user_write_replay_id_seq') IS NOT NULL AS sequence_exists
  `)[0];
  if (!tableRow) throw new Error("replay table status returned no row");
  if (!tableRow.table_exists) {
    return {
      table_exists: false,
      sequence_exists: tableRow.sequence_exists,
      row_count: null,
      columns_ready: false,
      constraints_ready: false,
      indexes_ready: false,
      definition_digest: await sha256("absent"),
      ready: false,
    };
  }

  const columns = await sql<{
    name: string;
    data_type: string;
    not_null: boolean;
    default_expression: string | null;
  }[]>`
    SELECT
      a.attname AS name,
      format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS not_null,
      pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'public.admin_user_write_replay'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `;
  const constraints = await sql<{
    name: string;
    type: string;
    validated: boolean;
    inherited: boolean;
    definition: string;
  }[]>`
    SELECT conname AS name, contype AS type, convalidated AS validated,
      connoinherit AS inherited, pg_get_constraintdef(oid, true) AS definition
    FROM pg_constraint
    WHERE conrelid = 'public.admin_user_write_replay'::regclass
    ORDER BY conname
  `;
  const indexes = await sql<{
    name: string;
    unique: boolean;
    valid: boolean;
    ready: boolean;
    predicate: string | null;
    columns: string[];
    definition: string;
  }[]>`
    SELECT c.relname AS name, i.indisunique AS unique, i.indisvalid AS valid,
      i.indisready AS ready, pg_get_expr(i.indpred, i.indrelid) AS predicate,
      ARRAY(
        SELECT pg_get_indexdef(i.indexrelid, key_position, true)
        FROM generate_series(1, i.indnkeyatts) AS key_position
        ORDER BY key_position
      ) AS columns,
      pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.admin_user_write_replay'::regclass
    ORDER BY c.relname
  `;
  const countRow = (await sql<{ row_count: number }[]>`
    SELECT count(*)::integer AS row_count FROM admin_user_write_replay
  `)[0];
  if (!countRow) throw new Error("replay row count returned no row");

  const columnsReady = columns.length === EXPECTED_COLUMNS.length
    && columns.every((column, index) => {
      const expected = EXPECTED_COLUMNS[index];
      if (!expected) return false;
      const [name, dataType, notNull] = expected;
      if (column.name !== name || column.data_type !== dataType || column.not_null !== notNull) return false;
      if (name === "id") return column.default_expression?.includes("admin_user_write_replay_id_seq") === true;
      if (["user_id", "target_count", "money_ledger_id", "integral_ledger_id", "other_order_id", "coupon_issue_id", "add_time"].includes(name)) {
        return column.default_expression === "0";
      }
      return column.default_expression === null;
    });
  const constraintNames = new Set(constraints.map((constraint) => constraint.name));
  const constraintByName = new Map(
    constraints.map((constraint) => [constraint.name, constraint.definition.toLowerCase()]),
  );
  const operationDefinition = constraintByName.get("auwr_operation_ck") ?? "";
  const identityDefinition = constraintByName.get("auwr_identity_ck") ?? "";
  const requestHashDefinition = constraintByName.get("auwr_request_hash_ck") ?? "";
  const constraintsReady = constraints.length === 4
    && constraints.every((constraint) => constraint.validated)
    && constraints.filter((constraint) => constraint.type === "c").every((constraint) => !constraint.inherited)
    && constraints.filter((constraint) => constraint.type === "p").length === 1
    && constraints.filter((constraint) => constraint.type === "c").length === 3
    && ["admin_user_write_replay_pkey", "auwr_operation_ck", "auwr_identity_ck", "auwr_request_hash_ck"]
      .every((name) => constraintNames.has(name))
    && (constraintByName.get("admin_user_write_replay_pkey") ?? "").includes("primary key (id)")
    && ["operation", "finance", "membership", "coupon_grant"]
      .every((fragment) => operationDefinition.includes(fragment))
    && [
      "admin_id", "user_id", "target_count", "money_ledger_id", "integral_ledger_id",
      "other_order_id", "coupon_issue_id", "add_time",
    ].every((fragment) => identityDefinition.includes(fragment))
    && requestHashDefinition.includes("request_hash")
    && requestHashDefinition.includes("[0-9a-f]{64}");
  const indexesReady = indexes.length === EXPECTED_INDEXES.size
    && indexes.every((index) => {
      const expected = EXPECTED_INDEXES.get(index.name);
      return expected !== undefined
        && index.valid
        && index.ready
        && index.predicate === null
        && index.unique === expected.unique
        && JSON.stringify(index.columns) === JSON.stringify(expected.columns);
    });
  const definitionDigest = await sha256(JSON.stringify({ columns, constraints, indexes }));
  const ready = tableRow.sequence_exists && columnsReady && constraintsReady && indexesReady;
  return {
    table_exists: true,
    sequence_exists: tableRow.sequence_exists,
    row_count: countRow.row_count,
    columns_ready: columnsReady,
    constraints_ready: constraintsReady,
    indexes_ready: indexesReady,
    definition_digest: definitionDigest,
    ready,
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) return json({ error: "forbidden" }, 403);
    const path = new URL(request.url).pathname;
    const isAudit = request.method === "GET" && path === "/audit";
    const isMigration = request.method === "POST" && path === "/migrate";
    if (!isAudit && !isMigration) return json({ error: "not found" }, 404);

    const client = postgres(env.HYPERDRIVE.connectionString, {
      prepare: false,
      max: 1,
      connection: { application_name: "cinashop_admin_user_replay_migration" },
    });
    try {
      if (isAudit) {
        const report = await client.begin(async (tx) => {
          await tx`SET TRANSACTION READ ONLY`;
          await tx`SET LOCAL statement_timeout = '15s'`;
          return {
            database: (await tx<{ version: string }[]>`SELECT current_setting('server_version') AS version`)[0]?.version,
            catalog: await readCatalogSummary(tx),
            replay: await readReplayState(tx),
          };
        });
        return json(report);
      }

      const report = await client.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '2s'`;
        await tx`SET LOCAL statement_timeout = '15s'`;
        await tx`SET LOCAL idle_in_transaction_session_timeout = '20s'`;
        await tx`SELECT pg_advisory_xact_lock(770426, 119)`;
        const beforeCatalog = await readCatalogSummary(tx);
        const beforeBusiness = await readBusinessSnapshot(tx);
        const before = await readReplayState(tx);
        if (before.table_exists && !before.ready) {
          throw new Error("partial admin user replay object set detected");
        }
        if (before.row_count !== null && before.row_count !== 0) {
          throw new Error("admin user replay table is unexpectedly non-empty");
        }

        await tx.unsafe(ADMIN_MOBILE_USER_REPLAY_SQL);
        const afterFirst = await readReplayState(tx);
        await tx.unsafe(ADMIN_MOBILE_USER_REPLAY_SQL);
        const afterSecond = await readReplayState(tx);
        const afterCatalog = await readCatalogSummary(tx);
        const afterBusiness = await readBusinessSnapshot(tx);
        const businessUnchanged = JSON.stringify(beforeBusiness) === JSON.stringify(afterBusiness);
        const idempotent = afterFirst.definition_digest === afterSecond.definition_digest;
        const expectedCatalogDelta = before.table_exists
          ? JSON.stringify(beforeCatalog) === JSON.stringify(afterCatalog)
          : afterCatalog.tables === beforeCatalog.tables + 1
            && afterCatalog.columns === beforeCatalog.columns + 12
            && afterCatalog.indexes === beforeCatalog.indexes + 4
            && afterCatalog.primary_keys === beforeCatalog.primary_keys + 1;
        if (!afterFirst.ready || !afterSecond.ready || afterSecond.row_count !== 0) {
          throw new Error("admin user replay migration verification failed");
        }
        if (!businessUnchanged || !idempotent || !expectedCatalogDelta) {
          throw new Error("admin user replay migration invariant failed");
        }
        return {
          applied_from_absent: !before.table_exists,
          business_state_unchanged: businessUnchanged,
          expected_catalog_delta: expectedCatalogDelta,
          idempotent,
          before_catalog: beforeCatalog,
          after_catalog: afterCatalog,
          replay: afterSecond,
        };
      });
      return json(report);
    } catch {
      return json({ error: "migration audit failed" }, 500);
    } finally {
      await client.end({ timeout: 5 });
    }
  },
};
