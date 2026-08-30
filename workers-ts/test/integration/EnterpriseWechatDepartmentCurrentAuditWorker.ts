import postgres from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
} from "@/lib/di";
import { MigrationService } from "@/services/MigrationService";
import { EnterpriseWechatCatalogService } from "@/services/work/EnterpriseWechatCatalogService";
import {
  applyDepartmentCurrentProjection,
  auditDepartmentProjectionRows,
  recordDepartmentProjectionSeen,
} from "@/services/work/EnterpriseWechatDepartmentCurrentService";
import {
  EnterpriseWechatDepartmentProjectionError,
  prepareDepartmentProjection,
  type DepartmentProjectionClaim,
  type EnterpriseWechatDepartmentSnapshot,
  type PreparedDepartmentProjection,
} from "@/services/work/EnterpriseWechatDepartmentProjection";
import { EnterpriseWechatProviderError } from "@/services/work/EnterpriseWechatProviderClient";

/**
 * Temporary, separately deployed production-engine audit Worker for WORK-C4.
 *
 * `/audit` is strictly read-only and returns only aggregate or catalog data.
 * `/migrate` runs only the repository-embedded C4 expand migration, twice.
 * `/isolated` writes only inside a cryptographically random schema and always
 * removes that schema before returning.
 */
interface DepartmentCurrentAuditEnv {
  readonly HYPERDRIVE: Hyperdrive;
  readonly AUDIT_READ_TOKEN_SHA256: string;
  readonly AUDIT_MIGRATE_TOKEN_SHA256: string;
  readonly AUDIT_ISOLATED_TOKEN_SHA256: string;
}

const AUDIT_SCHEMA_PREFIX = "codex_work_department_current_";
const DEPARTMENT_TABLES = [
  "work_department_current",
  "work_department_projection_fence",
  "work_department_leader_current",
] as const;
const C4_RELATED_TABLES = ["work_callback_event", ...DEPARTMENT_TABLES] as const;

interface TableFingerprint {
  readonly table: string;
  readonly rows: string;
  readonly fingerprint: string;
}

interface SequenceFingerprint {
  readonly sequence: string;
  readonly lastValue: string;
  readonly isCalled: boolean;
}

interface SafetySnapshot {
  readonly tables: readonly TableFingerprint[];
  readonly sequences: readonly SequenceFingerprint[];
}

interface ObjectFingerprint {
  readonly object_kind: string;
  readonly object_name: string;
  readonly object_oid: string;
  readonly relfilenode: string | null;
  readonly definition: string | null;
}

interface TupleFingerprint {
  readonly table: string;
  readonly rows: string;
  readonly tuple_identity: string;
  readonly row_digest: string;
}

function bytesFromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

async function authorized(request: Request, expectedHex: string): Promise<boolean> {
  const expected = bytesFromHex(expectedHex);
  if (!expected) return false;
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([^\s]{1,4096})$/i.exec(authorization);
  const actual = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(match?.[1] ?? ""),
  ));
  return crypto.subtle.timingSafeEqual(actual, expected);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertAuditSchema(schema: string): void {
  if (!new RegExp(`^${AUDIT_SCHEMA_PREFIX}[0-9a-f]{32}$`).test(schema)) {
    throw new Error("unsafe_isolated_schema_name");
  }
}

function assertProjectionSchema(schema: string): void {
  if (schema !== "public") assertAuditSchema(schema);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function sha256Json(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  ));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function postgresErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

async function safetySnapshot(client: postgres.Sql, schema = "public"): Promise<SafetySnapshot> {
  assertProjectionSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    await tx`SET LOCAL statement_timeout = '180s'`;
    await tx`SET LOCAL lock_timeout = '2s'`;
    const tableNames = await tx<Array<{ table_name: string }>>`
      SELECT relation.relname AS table_name
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ${schema}
        AND relation.relkind IN ('r', 'p')
        AND NOT relation.relispartition
      ORDER BY relation.relname
    `;
    const tables: TableFingerprint[] = [];
    for (const row of tableNames) {
      const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(row.table_name)}`;
      const result = await tx.unsafe<Array<{ row_count: string; fingerprint: string }>>(`
        WITH row_tokens AS (
          SELECT
            hashtextextended(tableoid::text || ':' || ctid::text || ':' || xmin::text, 0)
              AS hash_zero,
            hashtextextended(tableoid::text || ':' || ctid::text || ':' || xmin::text, 1)
              AS hash_one
          FROM ${qualified}
        )
        SELECT count(*)::text AS row_count,
          md5(count(*)::text || ':'
            || COALESCE(sum(hash_zero::numeric)::text, '0') || ':'
            || COALESCE(sum(hash_one::numeric)::text, '0') || ':'
            || COALESCE(min(hash_zero)::text, '0') || ':'
            || COALESCE(max(hash_one)::text, '0')) AS fingerprint
        FROM row_tokens
      `);
      tables.push({
        table: row.table_name,
        rows: result[0]?.row_count ?? "-1",
        fingerprint: result[0]?.fingerprint ?? "",
      });
    }

    const sequenceNames = await tx<Array<{ sequence_name: string }>>`
      SELECT relation.relname AS sequence_name
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ${schema} AND relation.relkind = 'S'
      ORDER BY relation.relname
    `;
    const sequences: SequenceFingerprint[] = [];
    for (const row of sequenceNames) {
      const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(row.sequence_name)}`;
      const result = await tx.unsafe<Array<{ last_value: string; is_called: boolean }>>(
        `SELECT last_value::text AS last_value, is_called FROM ${qualified}`,
      );
      if (!result[0]) throw new Error("sequence_fingerprint_failed");
      sequences.push({
        sequence: row.sequence_name,
        lastValue: result[0].last_value,
        isCalled: result[0].is_called,
      });
    }
    return { tables, sequences };
  });
}

async function legacyDepartmentSnapshot(client: postgres.Sql): Promise<SafetySnapshot> {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx`SET LOCAL search_path TO public, pg_temp`;
    await tx`SET LOCAL statement_timeout = '120s'`;
    await tx`SET LOCAL lock_timeout = '2s'`;
    const existence = await tx<Array<{ exists: boolean }>>`
      SELECT to_regclass('public.work_department') IS NOT NULL AS exists
    `;
    if (!existence[0]?.exists) throw new Error("legacy_work_department_missing");
    const tableResult = await tx<Array<{ row_count: string; fingerprint: string }>>`
      WITH row_tokens AS (
        SELECT
          hashtextextended(tableoid::text || ':' || ctid::text || ':' || xmin::text, 0)
            AS hash_zero,
          hashtextextended(tableoid::text || ':' || ctid::text || ':' || xmin::text, 1)
            AS hash_one
        FROM public.work_department
      )
      SELECT count(*)::text AS row_count,
        md5(count(*)::text || ':'
          || COALESCE(sum(hash_zero::numeric)::text, '0') || ':'
          || COALESCE(sum(hash_one::numeric)::text, '0') || ':'
          || COALESCE(min(hash_zero)::text, '0') || ':'
          || COALESCE(max(hash_one)::text, '0')) AS fingerprint
      FROM row_tokens
    `;
    const sequenceNames = await tx<Array<{ sequence_name: string }>>`
      SELECT DISTINCT sequence_class.relname AS sequence_name
      FROM pg_class AS table_class
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      JOIN pg_depend AS dependency
        ON dependency.refobjid = table_class.oid
       AND dependency.refobjsubid > 0
       AND dependency.deptype IN ('a', 'i')
      JOIN pg_class AS sequence_class
        ON sequence_class.oid = dependency.objid AND sequence_class.relkind = 'S'
      JOIN pg_namespace AS sequence_namespace
        ON sequence_namespace.oid = sequence_class.relnamespace
      WHERE table_namespace.nspname = 'public'
        AND sequence_namespace.nspname = 'public'
        AND table_class.relname = 'work_department'
      ORDER BY sequence_class.relname
    `;
    const sequences: SequenceFingerprint[] = [];
    for (const row of sequenceNames) {
      const qualified = `public.${quoteIdentifier(row.sequence_name)}`;
      const result = await tx.unsafe<Array<{ last_value: string; is_called: boolean }>>(
        `SELECT last_value::text AS last_value, is_called FROM ${qualified}`,
      );
      if (!result[0]) throw new Error("legacy_sequence_fingerprint_failed");
      sequences.push({
        sequence: row.sequence_name,
        lastValue: result[0].last_value,
        isCalled: result[0].is_called,
      });
    }
    return {
      tables: [{
        table: "work_department",
        rows: tableResult[0]?.row_count ?? "-1",
        fingerprint: tableResult[0]?.fingerprint ?? "",
      }],
      sequences,
    };
  });
}

function projectSnapshot(after: SafetySnapshot, before: SafetySnapshot): SafetySnapshot {
  const tableNames = new Set(before.tables.map((row) => row.table));
  const sequenceNames = new Set(before.sequences.map((row) => row.sequence));
  return {
    tables: after.tables.filter((row) => tableNames.has(row.table)),
    sequences: after.sequences.filter((row) => sequenceNames.has(row.sequence)),
  };
}

async function projectionObjectFingerprint(
  client: postgres.Sql,
  schema: string,
): Promise<readonly ObjectFingerprint[]> {
  assertProjectionSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    return tx<ObjectFingerprint[]>`
      SELECT 'relation:' || relation.relkind::text AS object_kind,
        relation.relname AS object_name,
        relation.oid::text AS object_oid,
        relation.relfilenode::text AS relfilenode,
        NULL::text AS definition
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ${schema}
        AND relation.relname IN ${tx([...C4_RELATED_TABLES])}
      UNION ALL
      SELECT 'constraint:' || constraint_row.contype::text AS object_kind,
        table_class.relname || '.' || constraint_row.conname AS object_name,
        constraint_row.oid::text AS object_oid,
        NULL::text AS relfilenode,
        pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = ${schema}
        AND table_class.relname IN ${tx([...C4_RELATED_TABLES])}
      UNION ALL
      SELECT 'index' AS object_kind,
        table_class.relname || '.' || index_class.relname AS object_name,
        index_class.oid::text AS object_oid,
        index_class.relfilenode::text AS relfilenode,
        pg_get_indexdef(index_class.oid) AS definition
      FROM pg_index AS index_row
      JOIN pg_class AS index_class ON index_class.oid = index_row.indexrelid
      JOIN pg_class AS table_class ON table_class.oid = index_row.indrelid
      JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = ${schema}
        AND table_class.relname IN ${tx([...C4_RELATED_TABLES])}
      ORDER BY object_kind, object_name
    `;
  });
}

async function projectionTupleFingerprint(
  client: postgres.Sql,
  schema: string,
): Promise<readonly TupleFingerprint[]> {
  assertProjectionSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const result: TupleFingerprint[] = [];
    for (const table of DEPARTMENT_TABLES) {
      const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
      const rows = await tx.unsafe<Array<{
        row_count: string;
        tuple_identity: string;
        row_digest: string;
      }>>(`
        SELECT count(*)::text AS row_count,
          md5(COALESCE(string_agg(
            tableoid::text || ':' || ctid::text || ':' || xmin::text,
            '|' ORDER BY ctid
          ), '')) AS tuple_identity,
          md5(COALESCE(string_agg(
            md5(to_jsonb(source_row)::text),
            '|' ORDER BY ctid
          ), '')) AS row_digest
        FROM ${qualified} AS source_row
      `);
      result.push({
        table,
        rows: rows[0]?.row_count ?? "-1",
        tuple_identity: rows[0]?.tuple_identity ?? "",
        row_digest: rows[0]?.row_digest ?? "",
      });
    }
    return result;
  });
}

async function productionAudit(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_work_department_current_read_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL statement_timeout = '120s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;

      const legacyExists = (await tx<Array<{ exists: boolean }>>`
        SELECT to_regclass('public.work_department') IS NOT NULL AS exists
      `)[0]?.exists ?? false;
      if (!legacyExists) throw new Error("legacy_work_department_missing");

      const legacy = (await tx<Array<Record<string, string>>>
      `
        WITH per_corp AS (
          SELECT corp_id,
            count(*) FILTER (WHERE parentid = 0) AS root_count
          FROM public.work_department
          GROUP BY corp_id
        ), duplicate_groups AS (
          SELECT corp_id, department_id, count(*) AS row_count
          FROM public.work_department
          GROUP BY corp_id, department_id
          HAVING count(*) > 1
        )
        SELECT
          (SELECT count(*)::text FROM public.work_department) AS row_count,
          (SELECT count(DISTINCT corp_id)::text FROM public.work_department) AS corp_count,
          (SELECT count(*)::text FROM public.work_department
            WHERE department_id <= 0) AS invalid_department_id_rows,
          (SELECT count(*)::text FROM public.work_department
            WHERE corp_id !~ '^[A-Za-z0-9_-]{1,18}$') AS invalid_corp_id_rows,
          (SELECT count(*)::text FROM public.work_department
            WHERE corp_id !~ '^[A-Za-z0-9_-]{1,18}$' OR department_id <= 0)
            AS invalid_identity_rows,
          (SELECT count(*)::text FROM public.work_department WHERE srot < 0)
            AS invalid_order_rows,
          (SELECT count(*)::text FROM duplicate_groups) AS duplicate_identity_groups,
          (SELECT COALESCE(sum(row_count), 0)::text FROM duplicate_groups)
            AS duplicate_identity_rows,
          (SELECT COALESCE(sum(row_count - 1), 0)::text FROM duplicate_groups)
            AS duplicate_extra_rows,
          (SELECT count(*)::text FROM public.work_department WHERE parentid = 0)
            AS root_rows,
          (SELECT count(*)::text FROM per_corp WHERE root_count = 0)
            AS corps_without_root,
          (SELECT count(*)::text FROM per_corp WHERE root_count > 1)
            AS corps_with_multiple_roots,
          (SELECT count(*)::text
             FROM public.work_department AS child
            WHERE child.parentid <> 0
              AND NOT EXISTS (
                SELECT 1 FROM public.work_department AS parent
                WHERE parent.corp_id = child.corp_id
                  AND parent.department_id = child.parentid
              )) AS orphan_rows
      `)[0];

      const hierarchy = (await tx<Array<{
        cycle_member_rows: string;
        cycle_corps: string;
      }>>`
        WITH RECURSIVE edges AS (
          SELECT DISTINCT corp_id, department_id, parentid
          FROM public.work_department
          WHERE department_id > 0 AND parentid > 0
        ), reach AS (
          SELECT corp_id, department_id AS start_id, parentid AS current_id
          FROM edges
          UNION
          SELECT reach.corp_id, reach.start_id, parent.parentid
          FROM reach
          JOIN edges AS parent
            ON parent.corp_id = reach.corp_id
           AND parent.department_id = reach.current_id
        )
        SELECT count(DISTINCT (corp_id, start_id)) FILTER (
            WHERE start_id = current_id
          )::text AS cycle_member_rows,
          count(DISTINCT corp_id) FILTER (WHERE start_id = current_id)::text
            AS cycle_corps
        FROM reach
      `)[0];

      const hasInputValidator = (await tx<Array<{ available: boolean }>>`
        SELECT to_regprocedure('pg_catalog.pg_input_is_valid(text,text)') IS NOT NULL
          AS available
      `)[0]?.available ?? false;
      let leaderJson: Record<string, string | boolean | null>;
      if (hasInputValidator) {
        leaderJson = (await tx<Array<Record<string, string>>>
        `
          SELECT
            count(*) FILTER (WHERE department_leader = '')::text AS blank_rows,
            count(*) FILTER (
              WHERE department_leader <> ''
                AND NOT pg_input_is_valid(department_leader, 'jsonb')
            )::text AS invalid_json_rows,
            count(*) FILTER (
              WHERE department_leader <> ''
                AND CASE WHEN pg_input_is_valid(department_leader, 'jsonb')
                  THEN jsonb_typeof(department_leader::jsonb) <> 'array'
                  ELSE false END
            )::text AS valid_json_non_array_rows
          FROM public.work_department
        `)[0] ?? {};
        leaderJson.validation_supported = true;
      } else {
        const fallback = (await tx<Array<{ blank_rows: string; non_array_like_rows: string }>>`
          SELECT count(*) FILTER (WHERE department_leader = '')::text AS blank_rows,
            count(*) FILTER (
              WHERE department_leader <> ''
                AND department_leader !~ '^\s*\[.*\]\s*$'
            )::text AS non_array_like_rows
          FROM public.work_department
        `)[0];
        leaderJson = {
          validation_supported: false,
          blank_rows: fallback?.blank_rows ?? "-1",
          invalid_json_rows: null,
          non_array_like_rows: fallback?.non_array_like_rows ?? "-1",
        };
      }

      const tableCatalog = await tx<Array<{
        table_name: string;
        oid: string;
        relkind: string;
        persistence: string;
        relfilenode: string;
        row_estimate: string;
      }>>`
        SELECT relation.relname AS table_name,
          relation.oid::text AS oid,
          relation.relkind::text AS relkind,
          relation.relpersistence::text AS persistence,
          relation.relfilenode::text AS relfilenode,
          relation.reltuples::bigint::text AS row_estimate
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname IN ${tx([...C4_RELATED_TABLES])}
        ORDER BY relation.relname
      `;
      const exactCounts: Record<string, string | null> = Object.fromEntries(
        C4_RELATED_TABLES.map((table) => [table, null]),
      );
      for (const table of C4_RELATED_TABLES) {
        if (!tableCatalog.some((row) => row.table_name === table && row.relkind === "r")) continue;
        const rows = await tx.unsafe<Array<{ row_count: string }>>(
          `SELECT count(*)::text AS row_count FROM public.${quoteIdentifier(table)}`,
        );
        exactCounts[table] = rows[0]?.row_count ?? "-1";
      }

      const constraints = await tx<Array<{
        table_name: string;
        constraint_name: string;
        constraint_type: string;
        validated: boolean;
        deferrable: boolean;
      }>>`
        SELECT table_class.relname AS table_name,
          constraint_row.conname AS constraint_name,
          constraint_row.contype::text AS constraint_type,
          constraint_row.convalidated AS validated,
          constraint_row.condeferrable AS deferrable
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
        JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
        WHERE namespace.nspname = 'public'
          AND table_class.relname IN ${tx([...C4_RELATED_TABLES])}
        ORDER BY table_class.relname, constraint_row.conname
      `;
      const indexes = await tx<Array<{
        table_name: string;
        index_name: string;
        oid: string;
        valid: boolean;
        ready: boolean;
        live: boolean;
        unique: boolean;
        primary: boolean;
      }>>`
        SELECT table_class.relname AS table_name, index_class.relname AS index_name,
          index_class.oid::text AS oid, index_row.indisvalid AS valid,
          index_row.indisready AS ready, index_row.indislive AS live,
          index_row.indisunique AS unique, index_row.indisprimary AS primary
        FROM pg_index AS index_row
        JOIN pg_class AS index_class ON index_class.oid = index_row.indexrelid
        JOIN pg_class AS table_class ON table_class.oid = index_row.indrelid
        JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
        WHERE namespace.nspname = 'public'
          AND table_class.relname IN ${tx([...C4_RELATED_TABLES])}
        ORDER BY table_class.relname, index_class.relname
      `;
      const columns = await tx<Array<{
        table_name: string;
        column_count: number;
        identity_column_count: number;
        generated_column_count: number;
      }>>`
        SELECT table_class.relname AS table_name,
          count(*)::integer AS column_count,
          count(*) FILTER (WHERE attribute.attidentity <> '')::integer
            AS identity_column_count,
          count(*) FILTER (WHERE attribute.attgenerated <> '')::integer
            AS generated_column_count
        FROM pg_attribute AS attribute
        JOIN pg_class AS table_class ON table_class.oid = attribute.attrelid
        JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
        WHERE namespace.nspname = 'public'
          AND table_class.relname IN ${tx([...C4_RELATED_TABLES])}
          AND attribute.attnum > 0 AND NOT attribute.attisdropped
        GROUP BY table_class.relname
        ORDER BY table_class.relname
      `;

      const completeProjection = DEPARTMENT_TABLES.every((table) =>
        tableCatalog.some((row) => row.table_name === table && row.relkind === "r"));
      let projectionAggregates: Record<string, string> | null = null;
      if (completeProjection) {
        projectionAggregates = (await tx<Array<Record<string, string>>>
        `
          SELECT
            (SELECT count(*)::text FROM work_department_current
              WHERE lifecycle_state = 'UNRESOLVED') AS unresolved_rows,
            (SELECT count(*)::text FROM work_department_current
              WHERE lifecycle_state = 'ACTIVE') AS active_rows,
            (SELECT count(*)::text FROM work_department_current
              WHERE lifecycle_state = 'DELETED') AS deleted_rows,
            (SELECT count(*)::text FROM work_department_current AS current_row
              JOIN work_department_projection_fence AS fence
                USING (corp_id, department_id)
              WHERE (current_row.last_event_id, current_row.last_event_key,
                     current_row.last_event_subject_key_hash,
                     current_row.last_event_time, current_row.last_sequence_rank)
                    IS DISTINCT FROM
                    (fence.last_event_id, fence.last_event_key,
                     fence.last_event_subject_key_hash,
                     fence.last_event_time, fence.last_sequence_rank))
              AS parked_or_inflight_rows,
            (SELECT count(*)::text FROM work_department_current AS child
              JOIN work_department_current AS parent
                ON parent.corp_id = child.corp_id
               AND parent.department_id = child.parent_department_id
              WHERE child.lifecycle_state = 'ACTIVE'
                AND parent.lifecycle_state <> 'ACTIVE') AS active_rows_with_inactive_parent,
            (SELECT count(*)::text FROM work_department_leader_current)
              AS leader_rows
        `)[0];
      }
      const temporarySchemas = (await tx<Array<{ count: number }>>`
        SELECT count(*)::integer AS count FROM pg_namespace
        WHERE nspname LIKE ${`${AUDIT_SCHEMA_PREFIX}%`}
      `)[0]?.count ?? -1;
      const publicCatalogTotals = (await tx<Array<{
        table_count: number;
        column_count: number;
        index_count: number;
        primary_key_count: number;
        sequence_count: number;
      }>>`
        WITH catalog_tables AS (
          SELECT relation.oid
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relkind IN ('r', 'p')
            AND NOT relation.relispartition
        )
        SELECT
          (SELECT count(*)::integer FROM catalog_tables) AS table_count,
          (SELECT count(*)::integer
             FROM pg_attribute AS attribute
             JOIN catalog_tables ON catalog_tables.oid = attribute.attrelid
            WHERE attribute.attnum > 0 AND NOT attribute.attisdropped) AS column_count,
          (SELECT count(*)::integer
             FROM pg_index AS index_row
             JOIN catalog_tables ON catalog_tables.oid = index_row.indrelid) AS index_count,
          (SELECT count(*)::integer
             FROM pg_constraint AS constraint_row
             JOIN catalog_tables ON catalog_tables.oid = constraint_row.conrelid
            WHERE constraint_row.contype = 'p') AS primary_key_count,
          (SELECT count(*)::integer
             FROM pg_class AS relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relkind = 'S') AS sequence_count
      `)[0];
      if (!publicCatalogTotals) throw new Error("public_catalog_totals_missing");

      return {
        complete: true,
        read_only: true,
        production_schema: "public",
        contains_identity_values: false,
        legacy_work_department: {
          ...legacy,
          ...hierarchy,
          leader_json: leaderJson,
        },
        c4_state: {
          complete_projection_surface: completeProjection,
          exact_row_counts: exactCounts,
          tables: tableCatalog,
          columns,
          constraints,
          indexes,
          aggregates: projectionAggregates,
        },
        public_catalog_totals: publicCatalogTotals,
        temporary_audit_schema_count: temporarySchemas,
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function currentRowCounts(
  client: postgres.Sql,
  schema: string,
): Promise<Record<string, string | null>> {
  assertProjectionSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const result: Record<string, string | null> = {};
    for (const table of DEPARTMENT_TABLES) {
      const exists = (await tx<Array<{ exists: boolean }>>`
        SELECT to_regclass(${`${schema}.${table}`}) IS NOT NULL AS exists
      `)[0]?.exists ?? false;
      if (!exists) {
        result[table] = null;
        continue;
      }
      const rows = await tx.unsafe<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
      );
      result[table] = rows[0]?.count ?? "-1";
    }
    return result;
  });
}

async function applyDepartmentMigration(
  container: ReturnType<typeof createContainerFromDb>,
): Promise<void> {
  const migration = new MigrationService(container)
    .workDepartmentCurrentProjectionMigrationSqlForVerification();
  await withTx(container, async (tx) => {
    await tx.execute(drizzleSql.raw("SET LOCAL statement_timeout = '180s'"));
    await tx.execute(drizzleSql.raw("SET LOCAL lock_timeout = '5s'"));
    await tx.execute(drizzleSql.raw(migration));
  });
}

async function migrateProductionDepartmentCurrent(connectionString: string) {
  const admin = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_work_department_current_expand_audit" },
  });
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public,pg_temp",
    applicationName: "cinashop_work_department_current_expand_ddl",
  });
  try {
    const publicBefore = await safetySnapshot(admin);
    const legacyBefore = await legacyDepartmentSnapshot(admin);
    const countsBefore = await currentRowCounts(admin, "public");

    await applyDepartmentMigration(createContainerFromDb(db));
    const objectsAfterFirst = await projectionObjectFingerprint(admin, "public");
    const tuplesAfterFirst = await projectionTupleFingerprint(admin, "public");

    await applyDepartmentMigration(createContainerFromDb(db));
    const objectsAfterSecond = await projectionObjectFingerprint(admin, "public");
    const tuplesAfterSecond = await projectionTupleFingerprint(admin, "public");
    const countsAfter = await currentRowCounts(admin, "public");
    const legacyAfter = await legacyDepartmentSnapshot(admin);
    const publicAfterComplete = await safetySnapshot(admin);
    const publicAfter = projectSnapshot(publicAfterComplete, publicBefore);

    const countsStable = DEPARTMENT_TABLES.every((table) =>
      countsBefore[table] === null
        ? countsAfter[table] === "0"
        : countsBefore[table] === countsAfter[table]);
    const assertions = {
      exact_embedded_c4_applied_twice: true,
      legacy_rows_and_mvcc_digest_unchanged: sameJson(legacyBefore.tables, legacyAfter.tables),
      legacy_sequence_values_unchanged: sameJson(
        legacyBefore.sequences,
        legacyAfter.sequences,
      ),
      all_preexisting_public_rows_and_mvcc_digests_unchanged:
        sameJson(publicBefore.tables, publicAfter.tables),
      all_preexisting_public_sequence_values_unchanged:
        sameJson(publicBefore.sequences, publicAfter.sequences),
      c4_added_no_public_sequence:
        sameJson(publicBefore.sequences, publicAfterComplete.sequences),
      no_department_business_rows_written: countsStable,
      second_pass_object_oid_and_relfilenode_stable:
        objectsAfterFirst.length > 0 && sameJson(objectsAfterFirst, objectsAfterSecond),
      second_pass_existing_tuple_ctid_xmin_stable:
        sameJson(tuplesAfterFirst, tuplesAfterSecond),
      c4_tables_are_permanent_ordinary_relations:
        (await admin<Array<{ count: number }>>`
          SELECT count(*)::integer AS count
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname IN ${admin([...DEPARTMENT_TABLES])}
            AND relation.relkind = 'r' AND relation.relpersistence = 'p'
            AND NOT relation.relispartition
        `)[0]?.count === DEPARTMENT_TABLES.length,
    };
    if (!Object.values(assertions).every(Boolean)) {
      throw new Error("production_department_migration_assertions_failed");
    }
    return {
      complete: true,
      migration: "0114_work_department_current_projection",
      production_schema: "public",
      expand_only: true,
      business_rows_written: false,
      migration_passes: 2,
      assertions,
      checks_passed: Object.keys(assertions).length,
      expected_checks: Object.keys(assertions).length,
      legacy_safety: {
        table_count: legacyAfter.tables.length,
        sequence_count: legacyAfter.sequences.length,
        before_digest: await sha256Json(legacyBefore),
        after_digest: await sha256Json(legacyAfter),
      },
      public_preexisting_safety: {
        table_count: publicBefore.tables.length,
        sequence_count: publicBefore.sequences.length,
        before_digest: await sha256Json(publicBefore),
        after_digest: await sha256Json(publicAfter),
      },
      current_row_counts_before: countsBefore,
      current_row_counts_after: countsAfter,
      migration_object_count: objectsAfterSecond.length,
    };
  } finally {
    const results = await Promise.allSettled([
      db.$client.end({ timeout: 1 }),
      admin.end({ timeout: 1 }),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("production_migration_client_cleanup_failed");
    }
  }
}

const ISOLATED_MEMBER_EDGE_SQL = `
CREATE TABLE work_member_relation_current (
  corp_id varchar(18) NOT NULL,
  member_id integer NOT NULL,
  department_id integer NOT NULL,
  sort_order bigint NOT NULL DEFAULT 0,
  is_leader_in_dept smallint NOT NULL DEFAULT 0,
  create_time integer NOT NULL DEFAULT 0,
  update_time integer NOT NULL DEFAULT 0,
  PRIMARY KEY (corp_id, member_id, department_id)
);
`;

async function setupIsolatedPrerequisite(
  container: ReturnType<typeof createContainerFromDb>,
): Promise<void> {
  const callbackMigration = new MigrationService(container)
    .workCallbackPipelineMigrationSqlForVerification();
  await withTx(container, async (tx) => {
    await tx.execute(drizzleSql.raw("SET LOCAL statement_timeout = '120s'"));
    await tx.execute(drizzleSql.raw("SET LOCAL lock_timeout = '5s'"));
    await tx.execute(drizzleSql.raw(callbackMigration));
    await tx.execute(drizzleSql.raw(ISOLATED_MEMBER_EDGE_SQL));
  });
}

function hex64(value: number): string {
  return Math.max(0, value).toString(16).padStart(64, "0").slice(-64);
}

async function insertDepartmentClaim(
  client: postgres.Sql,
  schema: string,
  input: {
    seed: number;
    corpId: string;
    departmentId: number;
    changeType: "create_party" | "update_party" | "delete_party";
    eventTime: number;
    sequenceRank?: number;
  },
): Promise<DepartmentProjectionClaim> {
  assertAuditSchema(schema);
  const eventKey = hex64(1_000_000 + input.seed);
  const payloadHash = hex64(2_000_000 + input.seed);
  const subjectKeyHash = hex64(3_000_000 + input.seed);
  const sequenceRank = input.sequenceRank ?? 1;
  const payload = { Id: String(input.departmentId) };
  const result = await client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    return tx<Array<{ id: number }>>`
      INSERT INTO work_callback_event (
        event_key, payload_hash, subject_key_hash, corp_id,
        msg_type, event_type, change_type, event_time, sequence_rank,
        payload, status, received_time, update_time
      ) VALUES (
        ${eventKey}, ${payloadHash}, ${subjectKeyHash}, ${input.corpId},
        'event', 'change_contact', ${input.changeType}, ${input.eventTime},
        ${sequenceRank}, ${tx.json(payload)}, 'RECEIVED', ${input.eventTime},
        ${input.eventTime}
      )
      RETURNING id
    `;
  });
  const eventId = result[0]?.id;
  if (!eventId) throw new Error("isolated_callback_event_insert_failed");
  return {
    eventId,
    eventKey,
    subjectKeyHash,
    eventTime: input.eventTime,
    sequenceRank,
    corpId: input.corpId,
    msgType: "event",
    eventType: "change_contact",
    changeType: input.changeType,
    payload,
  };
}

async function recordSeen(
  container: ReturnType<typeof createContainerFromDb>,
  claim: DepartmentProjectionClaim,
  now: number,
) {
  return withTx(container, async (tx) =>
    recordDepartmentProjectionSeen(tx, claim, now));
}

async function applyPrepared(
  container: ReturnType<typeof createContainerFromDb>,
  claim: DepartmentProjectionClaim,
  prepared: PreparedDepartmentProjection,
  now: number,
) {
  return withTx(container, async (tx) =>
    applyDepartmentCurrentProjection(tx, claim, prepared, now));
}

function snapshotPrepared(
  departmentId: number,
  snapshot: Omit<EnterpriseWechatDepartmentSnapshot, "departmentId">,
): PreparedDepartmentProjection {
  return {
    kind: "snapshot",
    departmentId,
    snapshot: { departmentId, ...snapshot },
  };
}

async function projectionRows(
  container: ReturnType<typeof createContainerFromDb>,
  corpId: string,
  departmentIds: number[],
) {
  return withTx(container, async (tx) =>
    auditDepartmentProjectionRows(tx, corpId, departmentIds));
}

async function departmentPhysicalDigest(
  client: postgres.Sql,
  schema: string,
  corpId: string,
  departmentId: number,
): Promise<string> {
  assertAuditSchema(schema);
  const state = await client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const current = await tx<Array<Record<string, unknown>>>
    `
      SELECT lifecycle_state, profile_complete, name, name_en,
        parent_department_id, sort_order::text, last_event_id,
        last_event_key, last_event_subject_key_hash, last_event_time,
        last_sequence_rank, deleted_time, ctid::text AS ctid,
        xmin::text AS xmin
      FROM work_department_current
      WHERE corp_id = ${corpId} AND department_id = ${departmentId}
    `;
    const fence = await tx<Array<Record<string, unknown>>>
    `
      SELECT last_event_id, last_event_key, last_event_subject_key_hash,
        last_event_time, last_sequence_rank, ctid::text AS ctid,
        xmin::text AS xmin
      FROM work_department_projection_fence
      WHERE corp_id = ${corpId} AND department_id = ${departmentId}
    `;
    const leaders = await tx<Array<Record<string, unknown>>>
    `
      SELECT userid, sort_order, ctid::text AS ctid, xmin::text AS xmin
      FROM work_department_leader_current
      WHERE corp_id = ${corpId} AND department_id = ${departmentId}
      ORDER BY sort_order
    `;
    return { current, fence, leaders };
  });
  return sha256Json(state);
}

async function catalogDepartmentCount(
  container: ReturnType<typeof createContainerFromDb>,
  corpId: string,
): Promise<number> {
  return withTx(container, async (tx) => {
    const service = new EnterpriseWechatCatalogService(
      createContainerFromDb(tx),
      { WECHAT_WORK_DEPARTMENT_CURRENT_AUTHORITY: "verified" },
    );
    const result = await service.departments({ corp_id: corpId });
    return result.count;
  });
}

async function projectionErrorMatches(
  operation: () => Promise<unknown>,
  expectedCode: string,
): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch (error) {
    return error instanceof EnterpriseWechatDepartmentProjectionError
      && error.errorCode === expectedCode;
  }
}

async function postgresErrorMatches(
  operation: () => Promise<unknown>,
  expectedCode: string,
): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch (error) {
    return postgresErrorCode(error) === expectedCode;
  }
}

async function runDirectServiceScenario(
  client: postgres.Sql,
  schema: string,
  container: ReturnType<typeof createContainerFromDb>,
) {
  const corpId = "auditcorp";
  const childClaim = await insertDepartmentClaim(client, schema, {
    seed: 1,
    corpId,
    departmentId: 2,
    changeType: "create_party",
    eventTime: 100,
  });
  const childSeen = await recordSeen(container, childClaim, 100);
  const childApplied = await applyPrepared(
    container,
    childClaim,
    snapshotPrepared(2, {
      name: "Audit Child",
      nameEn: "Audit Child",
      parentDepartmentId: 1,
      sortOrder: 0,
      leaders: [],
    }),
    101,
  );
  const childFirstRows = await projectionRows(container, corpId, [1, 2]);
  const placeholder = childFirstRows.departments.find((row) => row.departmentId === 1);
  const child = childFirstRows.departments.find((row) => row.departmentId === 2);

  const parentClaim = await insertDepartmentClaim(client, schema, {
    seed: 2,
    corpId,
    departmentId: 1,
    changeType: "create_party",
    eventTime: 110,
  });
  const parentSeen = await recordSeen(container, parentClaim, 110);
  const parentApplied = await applyPrepared(
    container,
    parentClaim,
    snapshotPrepared(1, {
      name: "Audit Root",
      nameEn: "Audit Root",
      parentDepartmentId: null,
      sortOrder: 0,
      leaders: ["leader-a", "leader-b"],
    }),
    111,
  );

  const replaceClaim = await insertDepartmentClaim(client, schema, {
    seed: 3,
    corpId,
    departmentId: 1,
    changeType: "update_party",
    eventTime: 120,
  });
  const replaceSeen = await recordSeen(container, replaceClaim, 120);
  const replaceApplied = await applyPrepared(
    container,
    replaceClaim,
    snapshotPrepared(1, {
      name: "Audit Root Updated",
      nameEn: "Audit Root Updated",
      parentDepartmentId: null,
      sortOrder: 4_294_967_295,
      leaders: ["leader-c"],
    }),
    121,
  );
  const replacedRows = await projectionRows(container, corpId, [1, 2]);
  const replacedRoot = replacedRows.departments.find((row) => row.departmentId === 1);
  const replacedChild = replacedRows.departments.find((row) => row.departmentId === 2);
  const replacedLeaders = replacedRows.leaders.filter((row) => row.departmentId === 1);
  const catalogBeforeDelete = await catalogDepartmentCount(container, corpId);

  const notFoundCorp = "notfoundcorp";
  const notFoundClaim = await insertDepartmentClaim(client, schema, {
    seed: 4,
    corpId: notFoundCorp,
    departmentId: 9,
    changeType: "create_party",
    eventTime: 130,
  });
  const notFoundSeen = await recordSeen(container, notFoundClaim, 130);
  const notFoundPrepared = await prepareDepartmentProjection(notFoundClaim, {
    directoryDepartment: async () => {
      throw new EnterpriseWechatProviderError(
        "not_found",
        "directory_department_get",
        60_003,
        200,
      );
    },
  });
  const notFoundBefore = await departmentPhysicalDigest(
    client,
    schema,
    notFoundCorp,
    9,
  );
  const notFoundApplied = await applyPrepared(
    container,
    notFoundClaim,
    notFoundPrepared,
    131,
  );
  const notFoundAfter = await departmentPhysicalDigest(
    client,
    schema,
    notFoundCorp,
    9,
  );
  const notFoundRows = await projectionRows(container, notFoundCorp, [9]);
  const notFoundCurrent = notFoundRows.departments[0];

  await client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    await tx`
      INSERT INTO work_member_relation_current (
        corp_id, member_id, department_id, sort_order,
        is_leader_in_dept, create_time, update_time
      ) VALUES (${corpId}, 1, 1, 0, 1, 130, 130)
    `;
  });

  const deleteClaim = await insertDepartmentClaim(client, schema, {
    seed: 5,
    corpId,
    departmentId: 1,
    changeType: "delete_party",
    eventTime: 140,
  });
  const deleteSeen = await recordSeen(container, deleteClaim, 140);
  const deleteApplied = await applyPrepared(
    container,
    deleteClaim,
    { kind: "absent", departmentId: 1, source: "delete_callback" },
    141,
  );
  const deletedRows = await projectionRows(container, corpId, [1, 2]);
  const deletedRoot = deletedRows.departments.find((row) => row.departmentId === 1);
  const preservedChild = deletedRows.departments.find((row) => row.departmentId === 2);
  const memberEdgeCount = await client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const rows = await tx<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM work_member_relation_current
      WHERE corp_id = ${corpId} AND member_id = 1 AND department_id = 1
    `;
    return rows[0]?.count ?? -1;
  });
  const catalogAfterDelete = await catalogDepartmentCount(container, corpId);

  const staleClaim = await insertDepartmentClaim(client, schema, {
    seed: 6,
    corpId,
    departmentId: 1,
    changeType: "update_party",
    eventTime: 135,
  });
  const staleResult = await recordSeen(container, staleClaim, 142);
  const afterStaleRows = await projectionRows(container, corpId, [1]);
  const afterStale = afterStaleRows.departments[0];

  const reviveClaim = await insertDepartmentClaim(client, schema, {
    seed: 7,
    corpId,
    departmentId: 1,
    changeType: "create_party",
    eventTime: 150,
  });
  const reviveSeen = await recordSeen(container, reviveClaim, 150);
  const reviveApplied = await applyPrepared(
    container,
    reviveClaim,
    snapshotPrepared(1, {
      name: "Audit Root Revived",
      nameEn: "Audit Root Revived",
      parentDepartmentId: null,
      sortOrder: 4_294_967_295,
      leaders: [],
    }),
    151,
  );
  const revivedRows = await projectionRows(container, corpId, [1, 2]);
  const revivedRoot = revivedRows.departments.find((row) => row.departmentId === 1);
  const catalogAfterRevive = await catalogDepartmentCount(container, corpId);

  const tenantCorpId = "tenantcorp";
  const tenantRootClaim = await insertDepartmentClaim(client, schema, {
    seed: 10,
    corpId: tenantCorpId,
    departmentId: 1,
    changeType: "create_party",
    eventTime: 155,
  });
  const tenantRootSeen = await recordSeen(container, tenantRootClaim, 155);
  const tenantRootApplied = await applyPrepared(
    container,
    tenantRootClaim,
    snapshotPrepared(1, {
      name: "Tenant Root",
      nameEn: "Tenant Root",
      parentDepartmentId: null,
      sortOrder: 1,
      leaders: [],
    }),
    156,
  );
  const tenantCatalogCount = await catalogDepartmentCount(container, tenantCorpId);
  const auditCatalogAfterTenant = await catalogDepartmentCount(container, corpId);

  const secondRootClaim = await insertDepartmentClaim(client, schema, {
    seed: 8,
    corpId,
    departmentId: 3,
    changeType: "create_party",
    eventTime: 160,
  });
  await recordSeen(container, secondRootClaim, 160);
  const rootConflictRejected = await projectionErrorMatches(
    () => applyPrepared(
      container,
      secondRootClaim,
      snapshotPrepared(3, {
        name: "Second Root",
        nameEn: "Second Root",
        parentDepartmentId: null,
        sortOrder: 1,
        leaders: [],
      }),
      161,
    ),
    "callback_department_root_conflict",
  );
  const rootUniqueIndexRejected = await postgresErrorMatches(
    () => client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
      await tx`
        UPDATE work_department_current
        SET lifecycle_state = 'ACTIVE', profile_complete = true,
          name = 'Second Root', name_en = 'Second Root', sort_order = 1,
          last_event_id = ${secondRootClaim.eventId},
          last_event_key = ${secondRootClaim.eventKey},
          last_event_subject_key_hash = ${secondRootClaim.subjectKeyHash},
          last_event_time = ${secondRootClaim.eventTime},
          last_sequence_rank = ${secondRootClaim.sequenceRank},
          update_time = 161
        WHERE corp_id = ${corpId} AND department_id = 3
      `;
    }),
    "23505",
  );

  const cycleClaim = await insertDepartmentClaim(client, schema, {
    seed: 9,
    corpId,
    departmentId: 1,
    changeType: "update_party",
    eventTime: 170,
  });
  await recordSeen(container, cycleClaim, 170);
  const cycleRejected = await projectionErrorMatches(
    () => applyPrepared(
      container,
      cycleClaim,
      snapshotPrepared(1, {
        name: "Cycle Root",
        nameEn: "Cycle Root",
        parentDepartmentId: 2,
        sortOrder: 1,
        leaders: [],
      }),
      171,
    ),
    "callback_department_hierarchy_cycle",
  );

  const otherCorpClaim = await insertDepartmentClaim(client, schema, {
    seed: 11,
    corpId: "othercorp",
    departmentId: 50,
    changeType: "create_party",
    eventTime: 180,
  });
  const crossCorpParentRejected = await postgresErrorMatches(
    () => client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
      await tx`
        INSERT INTO work_department_current (
          corp_id, department_id, lifecycle_state, profile_complete,
          name, name_en, parent_department_id, sort_order,
          last_event_id, last_event_key, last_event_subject_key_hash,
          last_event_time, last_sequence_rank, create_time, update_time
        ) VALUES (
          ${otherCorpClaim.corpId}, 50, 'ACTIVE', true,
          'Cross Corp Child', 'Cross Corp Child', 1, 0,
          ${otherCorpClaim.eventId}, ${otherCorpClaim.eventKey},
          ${otherCorpClaim.subjectKeyHash}, ${otherCorpClaim.eventTime},
          ${otherCorpClaim.sequenceRank}, 180, 180
        )
      `;
    }),
    "23503",
  );

  const assertions = {
    child_first_seen_ready: childSeen === "ready",
    child_first_snapshot_applied: childApplied === "applied",
    child_first_created_unresolved_parent_placeholder:
      placeholder?.lifecycleState === "UNRESOLVED"
      && placeholder.profileComplete === false
      && child?.lifecycleState === "ACTIVE"
      && child.parentDepartmentId === 1,
    parent_seen_ready: parentSeen === "ready",
    parent_snapshot_applied: parentApplied === "applied",
    uint32_order_boundaries_preserved:
      replacedRoot?.sortOrder === 4_294_967_295
      && replacedChild?.sortOrder === 0,
    leader_replace_removed_old_values:
      replaceSeen === "ready"
      && replaceApplied === "applied"
      && replacedLeaders.length === 1
      && replacedLeaders[0]?.userid === "leader-c"
      && replacedLeaders[0]?.sortOrder === 0,
    provider_not_found_classified_without_delete_authority:
      notFoundSeen === "ready"
      && notFoundPrepared.kind === "not_found"
      && notFoundApplied === "refresh-required"
      && notFoundCurrent?.lifecycleState === "UNRESOLVED"
      && notFoundCurrent.profileComplete === false
      && notFoundRows.leaders.length === 0,
    provider_not_found_phase_three_wrote_no_tuple:
      notFoundBefore === notFoundAfter,
    delete_tombstones_parent_and_clears_leaders:
      deleteSeen === "ready"
      && deleteApplied === "applied"
      && deletedRoot?.lifecycleState === "DELETED"
      && deletedRoot.profileComplete === false
      && deletedRows.leaders.every((row) => row.departmentId !== 1),
    delete_preserves_child_edge:
      preservedChild?.lifecycleState === "ACTIVE"
      && preservedChild.parentDepartmentId === 1,
    delete_preserves_member_edge: memberEdgeCount === 1,
    stale_update_is_superseded_without_resurrection:
      staleResult === "superseded"
      && afterStale?.lifecycleState === "DELETED"
      && afterStale.lastEventId === deleteClaim.eventId,
    newer_create_revives_tombstone:
      reviveSeen === "ready"
      && reviveApplied === "applied"
      && revivedRoot?.lifecycleState === "ACTIVE"
      && revivedRoot.deletedTime === null,
    catalog_requires_active_ancestor_closure:
      catalogBeforeDelete === 2
      && catalogAfterDelete === 0
      && catalogAfterRevive === 2,
    same_department_id_is_tenant_scoped:
      tenantRootSeen === "ready"
      && tenantRootApplied === "applied"
      && tenantCatalogCount === 1
      && auditCatalogAfterTenant === 2,
    second_active_root_rejected: rootConflictRejected,
    second_active_root_unique_index_rejected: rootUniqueIndexRejected,
    multi_node_cycle_rejected: cycleRejected,
    cross_corp_parent_fk_rejected: crossCorpParentRejected,
  };
  if (!Object.values(assertions).every(Boolean)) {
    throw new Error("isolated_direct_service_assertions_failed");
  }
  return {
    complete: true,
    provider_is_mocked: true,
    enterprise_wechat_network_calls: 0,
    assertions,
    checks_passed: Object.keys(assertions).length,
    expected_checks: Object.keys(assertions).length,
    catalog_counts: {
      before_delete: catalogBeforeDelete,
      after_delete: catalogAfterDelete,
      after_revive: catalogAfterRevive,
      tenant_same_department_id: tenantCatalogCount,
      audit_after_tenant_insert: auditCatalogAfterTenant,
    },
  };
}

async function isolatedScenario(connectionString: string) {
  const schema = `${AUDIT_SCHEMA_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
  assertAuditSchema(schema);
  const admin = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_work_department_current_isolated_audit" },
  });
  let isolatedDb: ReturnType<typeof createDbFromConnectionString> | null = null;
  let beforePublic: SafetySnapshot | null = null;
  let afterPublic: SafetySnapshot | null = null;
  let beforeSchemaCount: number | null = null;
  let result: Record<string, unknown> | null = null;
  let primaryError: unknown = null;
  let auditStage = "public_snapshot_before";
  let schemaRemoved = false;
  let schemaCreated = false;
  const cleanupErrors: string[] = [];

  try {
    beforePublic = await safetySnapshot(admin);
    beforeSchemaCount = (await admin<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM pg_namespace
      WHERE nspname LIKE ${`${AUDIT_SCHEMA_PREFIX}%`}
    `)[0]?.count ?? 0;

    auditStage = "schema_create";
    await admin.unsafe(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    schemaCreated = true;
    isolatedDb = createDbFromConnectionString(connectionString, 1, {
      searchPath: schema,
      applicationName: "cinashop_work_department_current_schema_audit",
    });
    const container = createContainerFromDb(isolatedDb);

    auditStage = "callback_prerequisite";
    await setupIsolatedPrerequisite(container);
    const schemaAfterPrerequisite = await safetySnapshot(admin, schema);
    auditStage = "c4_migration_first";
    await applyDepartmentMigration(container);
    const objectsAfterFirst = await projectionObjectFingerprint(admin, schema);
    const tuplesAfterFirst = await projectionTupleFingerprint(admin, schema);
    const schemaAfterFirst = await safetySnapshot(admin, schema);

    auditStage = "c4_migration_second";
    await applyDepartmentMigration(container);
    const objectsAfterSecond = await projectionObjectFingerprint(admin, schema);
    const tuplesAfterSecond = await projectionTupleFingerprint(admin, schema);
    const schemaAfterSecond = await safetySnapshot(admin, schema);
    const migrationAssertions = {
      migration_objects_oid_and_relfilenode_stable:
        objectsAfterFirst.length > 0 && sameJson(objectsAfterFirst, objectsAfterSecond),
      existing_projection_tuples_ctid_xmin_stable:
        tuplesAfterFirst.every((row) => row.rows === "0")
        && sameJson(tuplesAfterFirst, tuplesAfterSecond),
      callback_and_projection_rows_and_sequences_stable:
        sameJson(schemaAfterFirst, schemaAfterSecond),
      c4_added_no_sequence:
        sameJson(schemaAfterPrerequisite.sequences, schemaAfterFirst.sequences),
    };
    if (!Object.values(migrationAssertions).every(Boolean)) {
      throw new Error("isolated_migration_identity_assertions_failed");
    }

    auditStage = "direct_department_service";
    const directService = await runDirectServiceScenario(admin, schema, container);
    result = {
      complete: true,
      isolated_schema_only: true,
      contains_identity_values: false,
      migration_passes: 2,
      migration_assertions: migrationAssertions,
      migration_object_count: objectsAfterSecond.length,
      direct_service: directService,
      checks_passed:
        Object.keys(migrationAssertions).length + directService.checks_passed,
      expected_checks:
        Object.keys(migrationAssertions).length + directService.expected_checks,
      failed_checks: [],
    };
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      Reflect.set(error, "audit_stage", auditStage);
    }
    primaryError = error;
  } finally {
    if (isolatedDb) {
      try {
        await isolatedDb.$client.end({ timeout: 1 });
      } catch {
        cleanupErrors.push("isolated_client_close_failed");
      }
    }
    try {
      if (schemaCreated) {
        await admin.unsafe(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      }
      schemaRemoved = (await admin<Array<{ removed: boolean }>>`
        SELECT to_regnamespace(${schema}) IS NULL AS removed
      `)[0]?.removed ?? false;
      if (schemaCreated && !schemaRemoved) {
        cleanupErrors.push("temporary_schema_still_resolves");
      }
    } catch {
      cleanupErrors.push("temporary_schema_drop_failed");
    }
    try {
      if (beforeSchemaCount !== null) {
        const afterSchemaCount = (await admin<Array<{ count: number }>>`
          SELECT count(*)::integer AS count FROM pg_namespace
          WHERE nspname LIKE ${`${AUDIT_SCHEMA_PREFIX}%`}
        `)[0]?.count ?? -1;
        if (afterSchemaCount !== beforeSchemaCount) {
          cleanupErrors.push("temporary_schema_prefix_count_changed");
        }
      }
      if (beforePublic) {
        afterPublic = await safetySnapshot(admin);
        if (!sameJson(beforePublic, afterPublic)) {
          cleanupErrors.push("public_rows_sequences_or_mvcc_fingerprint_changed");
        }
      }
    } catch {
      cleanupErrors.push("public_after_snapshot_failed");
    }
    try {
      await admin.end({ timeout: 1 });
    } catch {
      cleanupErrors.push("admin_client_close_failed");
    }
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new Error(`isolated_audit_and_cleanup_failed:${cleanupErrors.join(",")}`);
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new Error(`isolated_cleanup_assertions_failed:${cleanupErrors.join(",")}`);
  }
  if (!result || !beforePublic || !afterPublic) {
    throw new Error("isolated_audit_incomplete");
  }
  return {
    ...result,
    temporary_schema_removed: schemaRemoved,
    public_full_snapshot: {
      before: {
        table_count: beforePublic.tables.length,
        sequence_count: beforePublic.sequences.length,
        digest: await sha256Json(beforePublic),
      },
      after: {
        table_count: afterPublic.tables.length,
        sequence_count: afterPublic.sequences.length,
        digest: await sha256Json(afterPublic),
      },
      all_public_rows_sequences_and_mvcc_digests_unchanged:
        sameJson(beforePublic, afterPublic),
    },
  };
}

function safeErrorField(error: unknown, field: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = Reflect.get(error, field);
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : undefined;
}

function safeErrorCode(error: unknown): string {
  const postgresCode = postgresErrorCode(error);
  if (postgresCode && /^[A-Z0-9]{5}$/.test(postgresCode)) return postgresCode;
  if (!(error instanceof Error)) return "unknown_error";
  if (/cleanup/i.test(error.message)) return "cleanup_failed";
  if (/migration/i.test(error.message)) return "migration_audit_failed";
  if (/direct_service/i.test(error.message)) return "department_service_audit_failed";
  if (/legacy_work_department_missing/i.test(error.message)) return "legacy_table_missing";
  return "audit_failed";
}

function safeAuditErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const normalized = error.message.replace(
    new RegExp(`${AUDIT_SCHEMA_PREFIX}[0-9a-f]{32}`, "g"),
    `${AUDIT_SCHEMA_PREFIX}[redacted]`,
  );
  if (
    normalized.length > 240
    || !/^(?:0114\b|work_callback_event\b|work_department_\w+\b|constraint\b|foreign key\b|check\b|index\b)/i.test(normalized)
    || /(?:postgres(?:ql)?:\/\/|password|token|secret|authorization)/i.test(normalized)
  ) return undefined;
  return normalized;
}

function noStoreJson(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(value, { ...init, headers });
}

export default {
  async fetch(request: Request, env: DepartmentCurrentAuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method !== "POST"
      || url.search !== ""
      || !["/audit", "/migrate", "/isolated"].includes(url.pathname)
    ) {
      return noStoreJson({ error: "not_found" }, { status: 404 });
    }
    const expectedHash = url.pathname === "/audit"
      ? env.AUDIT_READ_TOKEN_SHA256
      : url.pathname === "/migrate"
        ? env.AUDIT_MIGRATE_TOKEN_SHA256
        : env.AUDIT_ISOLATED_TOKEN_SHA256;
    if (!(await authorized(request, expectedHash ?? ""))) {
      return noStoreJson({ error: "forbidden" }, { status: 403 });
    }

    const requestId = crypto.randomUUID();
    try {
      const result = url.pathname === "/audit"
        ? await productionAudit(env.HYPERDRIVE.connectionString)
        : url.pathname === "/migrate"
          ? await migrateProductionDepartmentCurrent(env.HYPERDRIVE.connectionString)
          : await isolatedScenario(env.HYPERDRIVE.connectionString);
      return noStoreJson({ request_id: requestId, ...result });
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const auditStage = safeErrorField(error, "audit_stage");
      const errorDetail = safeAuditErrorDetail(error);
      console.error(JSON.stringify({
        event: "enterprise_wechat_department_current_audit_failed",
        request_id: requestId,
        error_code: errorCode,
        ...(auditStage ? { audit_stage: auditStage } : {}),
        ...(errorDetail ? { error_detail: errorDetail } : {}),
      }));
      return noStoreJson({
        error: "audit_failed",
        error_code: errorCode,
        request_id: requestId,
        ...(auditStage ? { audit_stage: auditStage } : {}),
        ...(errorDetail ? { error_detail: errorDetail } : {}),
      }, { status: 500 });
    }
  },
} satisfies ExportedHandler<DepartmentCurrentAuditEnv>;
