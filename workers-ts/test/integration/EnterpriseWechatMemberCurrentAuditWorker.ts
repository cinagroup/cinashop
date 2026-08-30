import postgres from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import type { Env, OrderMessage, WorkCallbackOutboxMessage } from "@/env";
import type { WorkCallbackPayload } from "@/models/schema";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
} from "@/lib/di";
import { MigrationService } from "@/services/MigrationService";
import {
  consumeWorkCallbackQueueMessage,
  EnterpriseWechatCallbackService,
  type DirectoryMemberProviderFactory,
} from "@/services/work/EnterpriseWechatCallbackService";
import { EnterpriseWechatContextService } from "@/services/work/EnterpriseWechatContextService";
import { EnterpriseWechatProviderError } from "@/services/work/EnterpriseWechatProviderClient";
import { ForbiddenException } from "@/utils/errors";

/**
 * Temporary, separately deployed production-engine audit Worker for WORK-C3.
 *
 * `/audit` is read-only. `/migrate` can execute only the repository's exact
 * member-current expand DDL and proves legacy physical state is unchanged.
 * `/isolated` writes only to a cryptographically random schema and verifies
 * every logical public table plus every public sequence before and after
 * cleanup. `/focused` is the smaller real-PostgreSQL regression for resolved
 * forward rename chains when a full public snapshot is unnecessarily costly.
 *
 * All three AUDIT_*_TOKEN_SHA256 values are Wrangler secret bindings. Secret
 * bindings are not represented in wrangler.jsonc, so their entrypoint types
 * remain explicit here while the platform Hyperdrive type is sourced from the
 * current Workers runtime definitions.
 */
interface MemberCurrentAuditEnv {
  readonly HYPERDRIVE: Hyperdrive;
  readonly AUDIT_READ_TOKEN_SHA256: string;
  readonly AUDIT_MIGRATE_TOKEN_SHA256: string;
  readonly AUDIT_ISOLATED_TOKEN_SHA256: string;
}

const AUDIT_SCHEMA_PREFIX = "codex_work_member_current_";
const CALLBACK_TABLES = [
  "work_callback_event",
  "work_callback_outbox",
  "work_callback_watermark",
] as const;
const CURRENT_TABLES = [
  "work_member_current",
  "work_member_identity_alias",
  "work_member_other_current",
  "work_member_relation_current",
] as const;
const CURRENT_MEMBER_COLUMNS = {
  work_member_current: [
    "id", "corp_id", "userid", "canonical_userid", "lifecycle_state",
    "legacy_member_id", "uid", "name", "position", "mobile", "gender",
    "email", "biz_mail", "direct_leader", "avatar", "thumb_avatar",
    "telephone", "alias", "enable", "is_leader", "hide_mobile", "address",
    "open_userid", "main_department", "status", "qr_code", "external_position",
    "profile_complete", "relations_complete", "deleted_time", "last_event_id",
    "last_event_key", "last_event_subject_key_hash", "last_event_time",
    "last_sequence_rank", "create_time", "update_time",
  ],
  work_member_identity_alias: [
    "corp_id", "userid", "member_id", "canonical_userid", "lifecycle_state",
    "last_event_id", "last_event_key", "last_event_subject_key_hash",
    "last_event_time", "last_sequence_rank", "link_event_id", "link_event_time",
    "link_sequence_rank", "create_time", "update_time",
  ],
  work_member_other_current: [
    "corp_id", "member_id", "extattr", "external_profile", "update_time",
  ],
  work_member_relation_current: [
    "corp_id", "member_id", "department_id", "sort_order", "is_leader_in_dept",
    "create_time", "update_time",
  ],
} as const satisfies Record<(typeof CURRENT_TABLES)[number], readonly string[]>;
const LEGACY_MEMBER_TABLES = [
  "work_member",
  "work_member_other",
  "work_member_relation",
] as const;
const TARGET_TABLES = [...CALLBACK_TABLES, ...CURRENT_TABLES] as const;
const ISOLATED_TUPLE_TABLES = [...TARGET_TABLES] as const;

const CALLBACK_PIPELINE_INDEXES = [
  "wce_event_key_uq",
  "wce_subject_order",
  "wce_status_time",
  "wco_event_id_uq",
  "wco_event_key_uq",
  "wco_dispatch_ready",
  "wco_expired_lease",
] as const;
const FOLLOW_PROJECTION_INDEXES = [
  "work_client_active_identity_uq",
  "work_client_follow_active_identity_uq",
] as const;
const PROJECTION_STATE_INDEXES = ["wce_projection_status_time"] as const;
const CURRENT_MEMBER_INDEXES = [
  "wmc_corp_id_uq",
  "wmc_corp_userid_uq",
  "wmc_legacy_member_id_uq",
  "wmc_catalog",
  "wmc_last_event_idx",
  "wmia_active_member_uq",
  "wmia_active_canonical_uq",
  "wmia_pending_source_idx",
  "wmia_member_history",
  "wmia_last_event_idx",
  "wmia_link_event_idx",
  "wmrc_department_catalog",
] as const;

const CALLBACK_PIPELINE_CONSTRAINTS = [
  "wce_hashes_ck",
  "wce_time_ck",
  "wce_status_ck",
  "wce_payload_object_ck",
  "wco_event_id_fk",
  "wco_event_key_ck",
  "wco_time_ck",
  "wco_status_ck",
  "wcw_hashes_ck",
  "wcw_time_ck",
] as const;
const PROJECTION_STATE_CONSTRAINTS = ["wce_projection_status_ck"] as const;
const CURRENT_MEMBER_CONSTRAINTS = [
  "wmc_pk",
  "wmc_last_event_fk",
  "wmc_corp_id_ck",
  "wmc_userid_ck",
  "wmc_canonical_userid_ck",
  "wmc_lifecycle_state_ck",
  "wmc_values_ck",
  "wmc_lifecycle_identity_ck",
  "wmc_event_fence_ck",
  "wmc_time_ck",
  "wmia_pk",
  "wmia_member_fk",
  "wmia_last_event_fk",
  "wmia_link_event_fk",
  "wmia_corp_id_ck",
  "wmia_userid_ck",
  "wmia_canonical_userid_ck",
  "wmia_lifecycle_state_ck",
  "wmia_lifecycle_identity_ck",
  "wmia_resolved_link_required_ck",
  "wmia_event_fence_ck",
  "wmia_link_fence_ck",
  "wmia_time_ck",
  "wmoc_pk",
  "wmoc_member_fk",
  "wmoc_corp_id_ck",
  "wmoc_values_ck",
  "wmrc_pk",
  "wmrc_member_fk",
  "wmrc_corp_id_ck",
  "wmrc_values_ck",
  "wmrc_time_ck",
] as const;
const CURRENT_MEMBER_BASE_CONSTRAINTS = CURRENT_MEMBER_CONSTRAINTS.filter(
  (name) => name !== "wmia_resolved_link_required_ck",
);
const RESOLVED_RENAME_FENCE_CONSTRAINTS = ["wmia_resolved_link_required_ck"] as const;

const ISOLATED_PREREQUISITE_SQL = `
CREATE TABLE "work_client" (
  "id" serial PRIMARY KEY,
  "corp_id" varchar(18) NOT NULL DEFAULT '',
  "external_userid" varchar(64) NOT NULL DEFAULT '',
  "delete_time" integer
);

CREATE TABLE "work_client_follow" (
  "id" serial PRIMARY KEY,
  "client_id" integer NOT NULL DEFAULT 0,
  "userid" varchar(64) NOT NULL DEFAULT '',
  "is_del_user" smallint NOT NULL DEFAULT 0
);

CREATE TABLE "work_member" (
  "id" serial PRIMARY KEY,
  "corp_id" varchar(18) NOT NULL DEFAULT '',
  "userid" varchar(64) NOT NULL DEFAULT '',
  "uid" integer NOT NULL DEFAULT 0,
  "name" varchar(64) NOT NULL DEFAULT '',
  "position" varchar(50) NOT NULL DEFAULT '',
  "mobile" varchar(11) NOT NULL DEFAULT '',
  "gender" smallint NOT NULL DEFAULT 0,
  "email" varchar(50) NOT NULL DEFAULT '',
  "biz_mail" varchar(50) NOT NULL DEFAULT '',
  "direct_leader" varchar(500) NOT NULL DEFAULT '',
  "avatar" varchar(255) NOT NULL DEFAULT '',
  "thumb_avatar" varchar(255) NOT NULL DEFAULT '',
  "telephone" varchar(50) NOT NULL DEFAULT '',
  "alias" varchar(30) NOT NULL DEFAULT '',
  "enable" smallint NOT NULL DEFAULT 0,
  "is_leader" smallint NOT NULL DEFAULT 0,
  "hide_mobile" smallint NOT NULL DEFAULT 0,
  "address" varchar(255) NOT NULL DEFAULT '',
  "open_userid" varchar(64) NOT NULL DEFAULT '',
  "main_department" smallint NOT NULL DEFAULT 0,
  "status" smallint NOT NULL DEFAULT 0,
  "qr_code" varchar(255) NOT NULL DEFAULT '',
  "external_position" varchar(100) NOT NULL DEFAULT '',
  "create_time" integer NOT NULL DEFAULT 0,
  "update_time" integer NOT NULL DEFAULT 0
);

CREATE TABLE "work_member_other" (
  "member_id" integer NOT NULL DEFAULT 0,
  "extattr" text,
  "external_profile" text
);

CREATE TABLE "work_member_relation" (
  "member_id" integer NOT NULL DEFAULT 0,
  "department" integer NOT NULL DEFAULT 0,
  "srot" integer NOT NULL DEFAULT 0,
  "is_leader_in_dept" smallint NOT NULL DEFAULT 0,
  "create_time" integer NOT NULL DEFAULT 0
);
`;

const AUDIT_EVENT_KEY = "a".repeat(64);
const AUDIT_PAYLOAD_HASH = "b".repeat(64);
const AUDIT_SUBJECT_HASH = "c".repeat(64);
const AUDIT_CORP_ID = "auditcorp";
const AUDIT_USER_ID = "audit-user";
const AUDIT_RENAMED_USER_ID = "audit-user-renamed";

interface TableShapeRow {
  table_name: string;
  relkind: string;
  row_estimate: string;
}

interface ColumnShapeRow {
  table_name: string;
  ordinal_position: number;
  column_name: string;
  formatted_type: string;
  nullable: boolean;
  identity_kind: string;
  default_expression: string | null;
}

interface IndexShapeRow {
  table_name: string;
  index_name: string;
  is_unique: boolean;
  is_primary: boolean;
  is_valid: boolean;
  is_ready: boolean;
  definition: string;
}

interface ConstraintShapeRow {
  table_name: string;
  constraint_name: string;
  constraint_type: string;
  is_validated: boolean;
  is_deferrable: boolean;
  definition: string;
}

interface PublicTableFingerprint {
  readonly table: string;
  readonly rows: string;
  readonly fingerprint: string;
}

interface SequenceFingerprint {
  readonly sequence: string;
  readonly lastValue: string;
  readonly isCalled: boolean;
}

interface SequenceCatalogFingerprint {
  readonly sequence_name: string;
  readonly sequence_oid: string;
  readonly data_type: string;
  readonly start_value: string;
  readonly increment_by: string;
  readonly minimum_value: string;
  readonly maximum_value: string;
  readonly cache_size: string;
  readonly cycles: boolean;
  readonly dependency_type: string;
  readonly owned_table: string;
  readonly owned_column: string;
}

interface PublicSafetySnapshot {
  readonly tables: readonly PublicTableFingerprint[];
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
  const token = match?.[1] ?? "";
  const actual = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  ));
  return crypto.subtle.timingSafeEqual(actual, expected);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertAuditSchema(schema: string): void {
  if (!new RegExp(`^${AUDIT_SCHEMA_PREFIX}[0-9a-f]{32}$`).test(schema)) {
    throw new Error("unsafe isolated schema name");
  }
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

async function sha256Text(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function allPresent(actual: ReadonlySet<string>, expected: readonly string[]): boolean {
  return expected.every((name) => actual.has(name));
}

function exactCurrentMemberColumnNames(columns: readonly ColumnShapeRow[]): boolean {
  return CURRENT_TABLES.every((table) => {
    const actual = columns
      .filter((column) => column.table_name === table)
      .sort((left, right) => left.ordinal_position - right.ordinal_position)
      .map((column) => column.column_name);
    return sameJson(actual, CURRENT_MEMBER_COLUMNS[table]);
  });
}

async function tableExists(
  client: postgres.TransactionSql,
  schema: string,
  table: string,
): Promise<boolean> {
  const rows = await client<Array<{ exists: boolean }>>`
    SELECT to_regclass(${`${schema}.${table}`}) IS NOT NULL AS exists
  `;
  return Boolean(rows[0]?.exists);
}

async function legacyMemberAggregates(client: postgres.TransactionSql) {
  const memberExists = await tableExists(client, "public", "work_member");
  const otherExists = await tableExists(client, "public", "work_member_other");
  const relationExists = await tableExists(client, "public", "work_member_relation");

  const memberIdentity = memberExists
    ? (await client<Array<Record<string, string>> >`
      WITH identity_groups AS (
        SELECT corp_id, lower(userid) AS normalized_userid,
          count(*) AS row_count,
          count(DISTINCT userid) AS case_variants
        FROM public.work_member
        GROUP BY corp_id, lower(userid)
      ), cross_corp AS (
        SELECT lower(userid) AS normalized_userid
        FROM public.work_member
        WHERE btrim(userid) <> ''
        GROUP BY lower(userid)
        HAVING count(DISTINCT corp_id) > 1
      )
      SELECT
        (SELECT count(*)::text FROM public.work_member) AS total_rows,
        (SELECT count(*)::text FROM public.work_member
          WHERE btrim(corp_id) = '' OR btrim(userid) = '') AS blank_identity_rows,
        count(*) FILTER (WHERE row_count > 1)::text AS duplicate_identity_groups,
        COALESCE(sum(row_count) FILTER (WHERE row_count > 1), 0)::text
          AS duplicate_identity_rows,
        COALESCE(sum(row_count - 1) FILTER (WHERE row_count > 1), 0)::text
          AS duplicate_identity_extra_rows,
        count(*) FILTER (WHERE case_variants > 1)::text AS case_variant_groups,
        (SELECT count(*)::text FROM cross_corp) AS cross_corp_identity_groups
      FROM identity_groups
    `)[0] ?? null
    : null;

  const other = memberExists && otherExists
    ? (await client<Array<Record<string, string>> >`
      WITH grouped AS (
        SELECT member_id, count(*) AS row_count
        FROM public.work_member_other
        GROUP BY member_id
      )
      SELECT
        (SELECT count(*)::text FROM public.work_member_other) AS total_rows,
        (SELECT count(*)::text
          FROM public.work_member_other AS source
          LEFT JOIN public.work_member AS member ON member.id = source.member_id
          WHERE member.id IS NULL) AS orphan_rows,
        count(*) FILTER (WHERE row_count > 1)::text AS duplicate_member_groups,
        COALESCE(sum(row_count - 1) FILTER (WHERE row_count > 1), 0)::text
          AS duplicate_member_extra_rows
      FROM grouped
    `)[0] ?? null
    : null;

  const relation = memberExists && relationExists
    ? (await client<Array<Record<string, string>> >`
      WITH tuple_groups AS (
        SELECT member_id, department, srot, is_leader_in_dept, create_time,
          count(*) AS row_count
        FROM public.work_member_relation
        GROUP BY member_id, department, srot, is_leader_in_dept, create_time
      ), department_groups AS (
        SELECT member_id, department, count(*) AS row_count
        FROM public.work_member_relation
        GROUP BY member_id, department
      )
      SELECT
        (SELECT count(*)::text FROM public.work_member_relation) AS total_rows,
        (SELECT count(*)::text FROM public.work_member_relation AS relation_row
          LEFT JOIN public.work_member AS member ON member.id = relation_row.member_id
          WHERE member.id IS NULL) AS orphan_rows,
        (SELECT count(*)::text FROM public.work_member_relation
          WHERE member_id <= 0 OR department <= 0 OR srot < 0
            OR is_leader_in_dept NOT IN (0, 1)) AS invalid_value_rows,
        (SELECT count(*)::text FROM tuple_groups) AS distinct_tuple_rows,
        (SELECT count(*)::text FROM tuple_groups WHERE row_count > 1)
          AS duplicate_tuple_groups,
        (SELECT COALESCE(sum(row_count - 1), 0)::text
          FROM tuple_groups WHERE row_count > 1) AS duplicate_tuple_extra_rows,
        (SELECT count(*)::text FROM department_groups WHERE row_count > 1)
          AS repeated_member_department_groups
    `)[0] ?? null
    : null;

  return {
    available: {
      work_member: memberExists,
      work_member_other: otherExists,
      work_member_relation: relationExists,
    },
    member_identity: memberIdentity,
    other: other,
    relation_multiset: relation,
  };
}

async function currentMemberAggregates(client: postgres.TransactionSql) {
  const availabilityEntries = await Promise.all(CURRENT_TABLES.map(async (table) => [
    table,
    await tableExists(client, "public", table),
  ] as const));
  const availability = Object.fromEntries(availabilityEntries) as Record<string, boolean>;
  if (!CURRENT_TABLES.every((table) => availability[table])) {
    return { available: availability, aggregates: null };
  }

  const rows = await client<Array<Record<string, string>> >`
    SELECT
      (SELECT count(*)::text FROM public.work_member_current) AS members,
      (SELECT count(*)::text FROM public.work_member_current
        WHERE lifecycle_state = 'ACTIVE') AS active_members,
      (SELECT count(*)::text FROM public.work_member_current
        WHERE lifecycle_state = 'DELETED') AS deleted_members,
      (SELECT count(*)::text FROM public.work_member_current
        WHERE NOT profile_complete) AS profile_incomplete_members,
      (SELECT count(*)::text FROM public.work_member_current
        WHERE NOT relations_complete) AS relations_incomplete_members,
      (SELECT count(*)::text FROM public.work_member_identity_alias) AS aliases,
      (SELECT count(*)::text FROM public.work_member_identity_alias
        WHERE lifecycle_state = 'UNRESOLVED') AS unresolved_aliases,
      (SELECT count(*)::text FROM public.work_member_relation_current) AS relations,
      (SELECT count(*)::text FROM (
        SELECT corp_id, lower(userid)
        FROM public.work_member_current
        GROUP BY corp_id, lower(userid)
        HAVING count(*) > 1
      ) AS duplicates) AS member_casefold_duplicate_groups,
      (SELECT count(*)::text FROM public.work_member_identity_alias AS alias_row
        LEFT JOIN public.work_member_current AS member
          ON member.corp_id = alias_row.corp_id AND member.id = alias_row.member_id
        WHERE alias_row.member_id IS NOT NULL AND member.id IS NULL)
        AS dangling_member_aliases,
      (SELECT count(*)::text FROM public.work_member_relation_current AS relation_row
        LEFT JOIN public.work_member_current AS member
          ON member.corp_id = relation_row.corp_id AND member.id = relation_row.member_id
        WHERE member.id IS NULL) AS orphan_relations
  `;
  return { available: availability, aggregates: rows[0] ?? null };
}

function migrationEvidence(
  tables: readonly TableShapeRow[],
  columns: readonly ColumnShapeRow[],
  indexes: readonly IndexShapeRow[],
  constraints: readonly ConstraintShapeRow[],
  resolvedRenameGuardReady: boolean,
) {
  const tableNames = new Set(tables.map((row) => row.table_name));
  const indexNames = new Set(indexes
    .filter((row) => row.is_valid && row.is_ready)
    .map((row) => row.index_name));
  const constraintNames = new Set(constraints
    .filter((row) => row.is_validated)
    .map((row) => row.constraint_name));
  const projectionColumn = columns.find((row) =>
    row.table_name === "work_callback_event"
      && row.column_name === "projection_status");
  const lifecycleIdentityConstraint = constraints.find((row) =>
    row.table_name === "work_member_identity_alias"
      && row.constraint_name === "wmia_lifecycle_identity_ck");

  const evidence = {
    migration_0109: {
      ready: allPresent(tableNames, CALLBACK_TABLES)
        && allPresent(indexNames, CALLBACK_PIPELINE_INDEXES)
        && allPresent(constraintNames, CALLBACK_PIPELINE_CONSTRAINTS),
      expected_tables: CALLBACK_TABLES.length,
      expected_named_indexes: CALLBACK_PIPELINE_INDEXES.length,
      expected_named_constraints: CALLBACK_PIPELINE_CONSTRAINTS.length,
    },
    migration_0110: {
      ready: allPresent(indexNames, FOLLOW_PROJECTION_INDEXES),
      expected_named_indexes: FOLLOW_PROJECTION_INDEXES.length,
    },
    migration_0111: {
      ready: projectionColumn?.formatted_type === "character varying(16)"
        && !projectionColumn.nullable
        && allPresent(indexNames, PROJECTION_STATE_INDEXES)
        && allPresent(constraintNames, PROJECTION_STATE_CONSTRAINTS),
      projection_status_column: projectionColumn ?? null,
      expected_named_indexes: PROJECTION_STATE_INDEXES.length,
      expected_named_constraints: PROJECTION_STATE_CONSTRAINTS.length,
    },
    migration_0112: {
      ready: allPresent(tableNames, CURRENT_TABLES)
        && exactCurrentMemberColumnNames(columns)
        && allPresent(indexNames, CURRENT_MEMBER_INDEXES)
        && allPresent(constraintNames, CURRENT_MEMBER_BASE_CONSTRAINTS),
      expected_tables: CURRENT_TABLES.length,
      expected_columns: Object.values(CURRENT_MEMBER_COLUMNS)
        .reduce((count, tableColumns) => count + tableColumns.length, 0),
      exact_column_names: exactCurrentMemberColumnNames(columns),
      expected_named_indexes: CURRENT_MEMBER_INDEXES.length,
      expected_named_constraints: CURRENT_MEMBER_BASE_CONSTRAINTS.length,
    },
    migration_0113: {
      ready: allPresent(constraintNames, RESOLVED_RENAME_FENCE_CONSTRAINTS)
        && lifecycleIdentityConstraint?.definition.includes("'RENAMED'::text") === true
        && lifecycleIdentityConstraint.definition.includes("link_event_id IS NOT NULL")
        && resolvedRenameGuardReady,
      expected_named_constraints: RESOLVED_RENAME_FENCE_CONSTRAINTS.length,
      immutable_guard_ready: resolvedRenameGuardReady,
    },
  };
  return evidence;
}

async function productionAudit(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_work_member_current_read_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL statement_timeout = '90s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;

      const versionRows = await tx<Array<{ server_version: string; server_version_num: string }>>`
        SELECT current_setting('server_version') AS server_version,
          current_setting('server_version_num') AS server_version_num
      `;
      const temporarySchemaRows = await tx<Array<{ count: number }>>`
        SELECT count(*)::integer AS count
        FROM pg_namespace
        WHERE nspname LIKE ${`${AUDIT_SCHEMA_PREFIX}%`}
      `;
      const tables = await tx<Array<TableShapeRow>>`
        SELECT table_class.relname AS table_name,
          table_class.relkind::text AS relkind,
          table_class.reltuples::bigint::text AS row_estimate
        FROM pg_class AS table_class
        JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
        WHERE table_namespace.nspname = 'public'
          AND table_class.relname IN ${tx([...TARGET_TABLES])}
        ORDER BY table_class.relname
      `;
      const columns = await tx<Array<ColumnShapeRow>>`
        SELECT table_class.relname AS table_name,
          attribute.attnum::integer AS ordinal_position,
          attribute.attname AS column_name,
          format_type(attribute.atttypid, attribute.atttypmod) AS formatted_type,
          NOT attribute.attnotnull AS nullable,
          attribute.attidentity AS identity_kind,
          pg_get_expr(attribute_default.adbin, attribute_default.adrelid) AS default_expression
        FROM pg_class AS table_class
        JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = table_class.oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
        LEFT JOIN pg_attrdef AS attribute_default
          ON attribute_default.adrelid = attribute.attrelid
         AND attribute_default.adnum = attribute.attnum
        WHERE table_namespace.nspname = 'public'
          AND table_class.relname IN ${tx([...TARGET_TABLES])}
        ORDER BY table_class.relname, attribute.attnum
      `;
      const indexes = await tx<Array<IndexShapeRow>>`
        SELECT table_class.relname AS table_name,
          index_class.relname AS index_name,
          index_metadata.indisunique AS is_unique,
          index_metadata.indisprimary AS is_primary,
          index_metadata.indisvalid AS is_valid,
          index_metadata.indisready AS is_ready,
          pg_get_indexdef(index_class.oid) AS definition
        FROM pg_index AS index_metadata
        JOIN pg_class AS index_class ON index_class.oid = index_metadata.indexrelid
        JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
        JOIN pg_class AS table_class ON table_class.oid = index_metadata.indrelid
        JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
        WHERE index_namespace.nspname = 'public'
          AND table_namespace.nspname = 'public'
          AND (
            table_class.relname IN ${tx([...TARGET_TABLES])}
            OR index_class.relname IN ${tx([...FOLLOW_PROJECTION_INDEXES])}
          )
        ORDER BY table_class.relname, index_class.relname
      `;
      const constraints = await tx<Array<ConstraintShapeRow>>`
        SELECT table_class.relname AS table_name,
          constraint_row.conname AS constraint_name,
          constraint_row.contype::text AS constraint_type,
          constraint_row.convalidated AS is_validated,
          constraint_row.condeferrable AS is_deferrable,
          pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
        JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
        WHERE table_namespace.nspname = 'public'
          AND table_class.relname IN ${tx([...TARGET_TABLES])}
        ORDER BY table_class.relname, constraint_row.conname
      `;
      const resolvedRenameGuardRows = await tx<Array<{
        function_ready: boolean;
        trigger_ready: boolean;
      }>>`
        SELECT
          EXISTS (
            SELECT 1
            FROM pg_proc AS function_row
            JOIN pg_namespace AS function_namespace
              ON function_namespace.oid = function_row.pronamespace
            JOIN pg_language AS language_row ON language_row.oid = function_row.prolang
            WHERE function_namespace.nspname = 'public'
              AND function_row.proname = 'wmia_guard_renamed_link_0113'
              AND function_row.pronargs = 0
              AND function_row.prorettype = 'trigger'::regtype
              AND language_row.lanname = 'plpgsql'
              AND NOT function_row.prosecdef
              AND function_row.proconfig = ARRAY['search_path=pg_catalog']::text[]
          ) AS function_ready,
          EXISTS (
            SELECT 1
            FROM pg_trigger AS trigger_row
            JOIN pg_class AS table_class ON table_class.oid = trigger_row.tgrelid
            JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
            JOIN pg_proc AS function_row ON function_row.oid = trigger_row.tgfoid
            JOIN pg_namespace AS function_namespace
              ON function_namespace.oid = function_row.pronamespace
            WHERE table_namespace.nspname = 'public'
              AND table_class.relname = 'work_member_identity_alias'
              AND trigger_row.tgname = 'wmia_guard_renamed_link_0113'
              AND NOT trigger_row.tgisinternal
              AND trigger_row.tgtype = 19
              AND trigger_row.tgenabled = 'O'
              AND function_namespace.nspname = 'public'
              AND function_row.proname = 'wmia_guard_renamed_link_0113'
          ) AS trigger_ready
      `;

      const tableCounts: Record<string, string | null> = Object.fromEntries(
        TARGET_TABLES.map((table) => [table, null]),
      );
      const existingTables = new Set(tables.map((row) => row.table_name));
      for (const table of TARGET_TABLES) {
        if (!existingTables.has(table)) continue;
        const countRows = await tx.unsafe<Array<{ row_count: string }>>(
          `SELECT count(*)::text AS row_count FROM "public".${quoteIdentifier(table)}`,
        );
        tableCounts[table] = countRows[0]?.row_count ?? null;
      }

      const legacy = await legacyMemberAggregates(tx);
      const current = await currentMemberAggregates(tx);
      const resolvedRenameGuardShape = resolvedRenameGuardRows[0] ?? {
        function_ready: false,
        trigger_ready: false,
      };
      const evidence = migrationEvidence(
        tables,
        columns,
        indexes,
        constraints,
        resolvedRenameGuardShape.function_ready && resolvedRenameGuardShape.trigger_ready,
      );
      const allMigrationsReady = Object.values(evidence).every((row) => row.ready);
      const callbackPipelineReady = CALLBACK_TABLES.every((table) => existingTables.has(table));
      const rolloutRows = callbackPipelineReady
        ? await tx<Array<{
            parked_outboxes: string;
            parked_member_non_delete_outboxes: string;
            parked_delete_outboxes: string;
            parked_non_member_outboxes: string;
            parked_state_mismatches: string;
          }>>`
            SELECT
              count(*) FILTER (
                WHERE outbox.last_error_code = 'member_projection_disabled'
              )::text AS parked_outboxes,
              count(*) FILTER (
                WHERE outbox.last_error_code = 'member_projection_disabled'
                  AND event.msg_type = 'event'
                  AND event.event_type = 'change_contact'
                  AND event.change_type IN ('create_user', 'update_user')
              )::text AS parked_member_non_delete_outboxes,
              count(*) FILTER (
                WHERE outbox.last_error_code = 'member_projection_disabled'
                  AND event.msg_type = 'event'
                  AND event.event_type = 'change_contact'
                  AND event.change_type = 'delete_user'
              )::text AS parked_delete_outboxes,
              count(*) FILTER (
                WHERE outbox.last_error_code = 'member_projection_disabled'
                  AND NOT (
                    event.msg_type = 'event'
                    AND event.event_type = 'change_contact'
                    AND event.change_type IN ('create_user', 'update_user', 'delete_user')
                  )
              )::text AS parked_non_member_outboxes,
              count(*) FILTER (
                WHERE outbox.last_error_code = 'member_projection_disabled'
                  AND (
                    outbox.status <> 'FAILED'
                    OR event.status <> 'FAILED'
                    OR event.projection_status <> 'REFRESH_REQUIRED'
                    OR event.last_error_code <> 'member_projection_disabled'
                    OR outbox.attempt_count <> 0
                  )
              )::text AS parked_state_mismatches
            FROM public.work_callback_outbox AS outbox
            JOIN public.work_callback_event AS event ON event.id = outbox.event_id
          `
        : [];
      const rollout = rolloutRows[0] ?? null;
      const authorityEnablePreflightSafe = rollout !== null
        && rollout.parked_delete_outboxes === "0"
        && rollout.parked_non_member_outboxes === "0"
        && rollout.parked_state_mismatches === "0";

      return {
        complete: true,
        read_only: true,
        contains_identity_values: false,
        postgres: versionRows[0] ?? null,
        temporary_audit_schema_count: temporarySchemaRows[0]?.count ?? -1,
        migration_evidence: evidence,
        all_migrations_ready: allMigrationsReady,
        table_counts: tableCounts,
        table_shape: tables,
        column_shape: columns,
        index_shape: indexes,
        constraint_shape: constraints,
        resolved_rename_guard_shape: resolvedRenameGuardShape,
        legacy_aggregate_audit: legacy,
        current_aggregate_audit: current,
        rollout_preflight: {
          callback_pipeline_ready: callbackPipelineReady,
          authority_enable_safe: authorityEnablePreflightSafe,
          ...(rollout ?? {}),
        },
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

/**
 * Snapshot every logical public table without reading business column values.
 * PostgreSQL MVCC physical identities change on every UPDATE/INSERT/DELETE, so
 * two independent 64-bit hash aggregates over tableoid/ctid/xmin plus exact row
 * counts form a compact, PII-free mutation detector.
 */
async function publicSafetySnapshot(client: postgres.Sql): Promise<PublicSafetySnapshot> {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx`SET LOCAL search_path TO public, pg_temp`;
    await tx`SET LOCAL statement_timeout = '180s'`;
    await tx`SET LOCAL lock_timeout = '2s'`;
    const tableNames = await tx<Array<{ table_name: string }>>`
      SELECT table_class.relname AS table_name
      FROM pg_class AS table_class
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      WHERE table_namespace.nspname = 'public'
        AND table_class.relkind IN ('r', 'p')
        AND NOT table_class.relispartition
      ORDER BY table_class.relname
    `;
    const tables: PublicTableFingerprint[] = [];
    for (const row of tableNames) {
      const qualified = `${quoteIdentifier("public")}.${quoteIdentifier(row.table_name)}`;
      const fingerprints = await tx.unsafe<Array<{ row_count: string; fingerprint: string }>>(`
        WITH row_tokens AS (
          SELECT
            hashtextextended(
              tableoid::text || ':' || ctid::text || ':' || xmin::text,
              0
            ) AS hash_zero,
            hashtextextended(
              tableoid::text || ':' || ctid::text || ':' || xmin::text,
              1
            ) AS hash_one
          FROM ${qualified}
        )
        SELECT count(*)::text AS row_count,
          md5(
            count(*)::text || ':' ||
            COALESCE(sum(hash_zero::numeric)::text, '0') || ':' ||
            COALESCE(sum(hash_one::numeric)::text, '0') || ':' ||
            COALESCE(min(hash_zero)::text, '0') || ':' ||
            COALESCE(max(hash_one)::text, '0')
          ) AS fingerprint
        FROM row_tokens
      `);
      tables.push({
        table: row.table_name,
        rows: fingerprints[0]?.row_count ?? "-1",
        fingerprint: fingerprints[0]?.fingerprint ?? "",
      });
    }

    const sequenceNames = await tx<Array<{ sequence_name: string }>>`
      SELECT sequence_class.relname AS sequence_name
      FROM pg_class AS sequence_class
      JOIN pg_namespace AS sequence_namespace
        ON sequence_namespace.oid = sequence_class.relnamespace
      WHERE sequence_namespace.nspname = 'public'
        AND sequence_class.relkind = 'S'
      ORDER BY sequence_class.relname
    `;
    const sequences: SequenceFingerprint[] = [];
    for (const row of sequenceNames) {
      const qualified = `${quoteIdentifier("public")}.${quoteIdentifier(row.sequence_name)}`;
      const values = await tx.unsafe<Array<{ last_value: string; is_called: boolean }>>(
        `SELECT last_value::text AS last_value, is_called FROM ${qualified}`,
      );
      if (!values[0]) throw new Error("public sequence fingerprint failed");
      sequences.push({
        sequence: row.sequence_name,
        lastValue: values[0].last_value,
        isCalled: values[0].is_called,
      });
    }
    return { tables, sequences };
  });
}

async function legacyProductionSafetySnapshot(
  client: postgres.Sql,
): Promise<PublicSafetySnapshot> {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx`SET LOCAL search_path TO public, pg_temp`;
    await tx`SET LOCAL statement_timeout = '120s'`;
    await tx`SET LOCAL lock_timeout = '2s'`;
    const existence = await tx<Array<{ table_name: string }>>`
      SELECT table_class.relname AS table_name
      FROM pg_class AS table_class
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      WHERE table_namespace.nspname = 'public'
        AND table_class.relkind IN ('r', 'p')
        AND table_class.relname IN ${tx([...LEGACY_MEMBER_TABLES])}
      ORDER BY table_class.relname
    `;
    if (!allPresent(new Set(existence.map((row) => row.table_name)), LEGACY_MEMBER_TABLES)) {
      throw new Error("legacy member tables are incomplete");
    }

    const tables: PublicTableFingerprint[] = [];
    for (const table of LEGACY_MEMBER_TABLES) {
      const qualified = `${quoteIdentifier("public")}.${quoteIdentifier(table)}`;
      const rows = await tx.unsafe<Array<{ row_count: string; fingerprint: string }>>(`
        WITH row_tokens AS (
          SELECT
            hashtextextended(
              tableoid::text || ':' || ctid::text || ':' || xmin::text,
              0
            ) AS hash_zero,
            hashtextextended(
              tableoid::text || ':' || ctid::text || ':' || xmin::text,
              1
            ) AS hash_one
          FROM ${qualified}
        )
        SELECT count(*)::text AS row_count,
          md5(
            count(*)::text || ':' ||
            COALESCE(sum(hash_zero::numeric)::text, '0') || ':' ||
            COALESCE(sum(hash_one::numeric)::text, '0') || ':' ||
            COALESCE(min(hash_zero)::text, '0') || ':' ||
            COALESCE(max(hash_one)::text, '0')
          ) AS fingerprint
        FROM row_tokens
      `);
      tables.push({
        table,
        rows: rows[0]?.row_count ?? "-1",
        fingerprint: rows[0]?.fingerprint ?? "",
      });
    }

    const sequenceNames = await tx<Array<{ sequence_name: string }>>`
      SELECT DISTINCT sequence_class.relname AS sequence_name
      FROM pg_class AS table_class
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      JOIN pg_depend AS dependency
        ON dependency.refobjid = table_class.oid
       AND dependency.refobjsubid > 0
       AND dependency.deptype IN ('a', 'i')
      JOIN pg_class AS sequence_class
        ON sequence_class.oid = dependency.objid
       AND sequence_class.relkind = 'S'
      JOIN pg_namespace AS sequence_namespace ON sequence_namespace.oid = sequence_class.relnamespace
      WHERE table_namespace.nspname = 'public'
        AND sequence_namespace.nspname = 'public'
        AND table_class.relname IN ${tx([...LEGACY_MEMBER_TABLES])}
      ORDER BY sequence_class.relname
    `;
    const sequences: SequenceFingerprint[] = [];
    for (const row of sequenceNames) {
      const qualified = `${quoteIdentifier("public")}.${quoteIdentifier(row.sequence_name)}`;
      const values = await tx.unsafe<Array<{ last_value: string; is_called: boolean }>>(
        `SELECT last_value::text AS last_value, is_called FROM ${qualified}`,
      );
      if (!values[0]) throw new Error("legacy member sequence fingerprint failed");
      sequences.push({
        sequence: row.sequence_name,
        lastValue: values[0].last_value,
        isCalled: values[0].is_called,
      });
    }
    return { tables, sequences };
  });
}

function assertProjectionSchema(schema: string): void {
  if (schema === "public") return;
  assertAuditSchema(schema);
}

async function currentProjectionRowCounts(
  client: postgres.Sql,
  schema: string,
): Promise<Record<string, string | null>> {
  assertProjectionSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const output: Record<string, string | null> = {};
    for (const table of CURRENT_TABLES) {
      const existsRows = await tx<Array<{ exists: boolean }>>`
        SELECT to_regclass(${`${schema}.${table}`}) IS NOT NULL AS exists
      `;
      if (!existsRows[0]?.exists) {
        output[table] = null;
        continue;
      }
      const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
      const countRows = await tx.unsafe<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM ${qualified}`,
      );
      output[table] = countRows[0]?.count ?? "-1";
    }
    return output;
  });
}

async function currentProjectionObjectFingerprint(
  client: postgres.Sql,
  schema: string,
): Promise<readonly ObjectFingerprint[]> {
  assertProjectionSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    return tx<Array<ObjectFingerprint>>`
      WITH current_tables AS (
        SELECT table_class.oid
        FROM pg_class AS table_class
        JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
        WHERE table_namespace.nspname = ${schema}
          AND table_class.relname IN ${tx([...CURRENT_TABLES])}
          AND table_class.relkind IN ('r', 'p')
      ), current_relations AS (
        SELECT relation.oid
        FROM pg_class AS relation
        WHERE relation.oid IN (SELECT oid FROM current_tables)
        UNION
        SELECT index_metadata.indexrelid
        FROM pg_index AS index_metadata
        WHERE index_metadata.indrelid IN (SELECT oid FROM current_tables)
        UNION
        SELECT dependency.objid
        FROM pg_depend AS dependency
        JOIN pg_class AS sequence_class
          ON sequence_class.oid = dependency.objid
         AND sequence_class.relkind = 'S'
        WHERE dependency.refobjid IN (SELECT oid FROM current_tables)
          AND dependency.deptype IN ('a', 'i')
      )
      SELECT 'relation:' || relation.relkind::text AS object_kind,
        relation.relname AS object_name,
        relation.oid::text AS object_oid,
        relation.relfilenode::text AS relfilenode,
        CASE WHEN relation.relkind = 'i' THEN pg_get_indexdef(relation.oid)
          ELSE NULL::text END AS definition
      FROM pg_class AS relation
      WHERE relation.oid IN (SELECT oid FROM current_relations)
      UNION ALL
      SELECT 'constraint:' || constraint_row.contype::text AS object_kind,
        table_class.relname || '.' || constraint_row.conname AS object_name,
        constraint_row.oid::text AS object_oid,
        NULL::text AS relfilenode,
        pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
      WHERE constraint_row.conrelid IN (SELECT oid FROM current_tables)
      UNION ALL
      SELECT 'function' AS object_kind,
        function_row.proname AS object_name,
        function_row.oid::text AS object_oid,
        NULL::text AS relfilenode,
        pg_get_functiondef(function_row.oid) AS definition
      FROM pg_proc AS function_row
      JOIN pg_namespace AS function_namespace
        ON function_namespace.oid = function_row.pronamespace
      WHERE function_namespace.nspname = ${schema}
        AND function_row.proname = 'wmia_guard_renamed_link_0113'
      UNION ALL
      SELECT 'trigger' AS object_kind,
        table_class.relname || '.' || trigger_row.tgname AS object_name,
        trigger_row.oid::text AS object_oid,
        NULL::text AS relfilenode,
        pg_get_triggerdef(trigger_row.oid) AS definition
      FROM pg_trigger AS trigger_row
      JOIN pg_class AS table_class ON table_class.oid = trigger_row.tgrelid
      WHERE trigger_row.tgrelid IN (SELECT oid FROM current_tables)
        AND NOT trigger_row.tgisinternal
      ORDER BY object_kind, object_name
    `;
  });
}

async function currentProjectionTupleFingerprint(
  client: postgres.Sql,
  schema: string,
): Promise<readonly TupleFingerprint[]> {
  assertProjectionSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const output: TupleFingerprint[] = [];
    for (const table of CURRENT_TABLES) {
      const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
      const rows = await tx.unsafe<Array<{
        row_count: string;
        tuple_identity: string;
        row_digest: string;
      }>>(`
        SELECT count(*)::text AS row_count,
          md5(COALESCE(string_agg(
            ctid::text || ':' || xmin::text,
            '|' ORDER BY ctid
          ), '')) AS tuple_identity,
          md5(COALESCE(string_agg(
            md5(to_jsonb(source_row)::text),
            '|' ORDER BY ctid
          ), '')) AS row_digest
        FROM ${qualified} AS source_row
      `);
      output.push({
        table,
        rows: rows[0]?.row_count ?? "-1",
        tuple_identity: rows[0]?.tuple_identity ?? "",
        row_digest: rows[0]?.row_digest ?? "",
      });
    }
    return output;
  });
}

async function currentProjectionSequenceFingerprint(
  client: postgres.Sql,
  schema: string,
): Promise<readonly SequenceFingerprint[]> {
  assertProjectionSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const names = await tx<Array<{ sequence_name: string }>>`
      SELECT DISTINCT sequence_class.relname AS sequence_name
      FROM pg_class AS table_class
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      JOIN pg_depend AS dependency
        ON dependency.refobjid = table_class.oid
       AND dependency.deptype IN ('a', 'i')
      JOIN pg_class AS sequence_class
        ON sequence_class.oid = dependency.objid
       AND sequence_class.relkind = 'S'
      JOIN pg_namespace AS sequence_namespace ON sequence_namespace.oid = sequence_class.relnamespace
      WHERE table_namespace.nspname = ${schema}
        AND sequence_namespace.nspname = ${schema}
        AND table_class.relname IN ${tx([...CURRENT_TABLES])}
      ORDER BY sequence_class.relname
    `;
    const output: SequenceFingerprint[] = [];
    for (const row of names) {
      const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(row.sequence_name)}`;
      const values = await tx.unsafe<Array<{ last_value: string; is_called: boolean }>>(
        `SELECT last_value::text AS last_value, is_called FROM ${qualified}`,
      );
      if (!values[0]) throw new Error("current projection sequence fingerprint failed");
      output.push({
        sequence: row.sequence_name,
        lastValue: values[0].last_value,
        isCalled: values[0].is_called,
      });
    }
    return output;
  });
}

async function currentProjectionCatalogShape(client: postgres.Sql) {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx`SET LOCAL search_path TO public, pg_temp`;
    const tables = await tx<Array<TableShapeRow>>`
      SELECT table_class.relname AS table_name,
        table_class.relkind::text AS relkind,
        table_class.reltuples::bigint::text AS row_estimate
      FROM pg_class AS table_class
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      WHERE table_namespace.nspname = 'public'
        AND table_class.relname IN ${tx([...CURRENT_TABLES])}
      ORDER BY table_class.relname
    `;
    const columns = await tx<Array<ColumnShapeRow>>`
      SELECT table_class.relname AS table_name,
        attribute.attnum::integer AS ordinal_position,
        attribute.attname AS column_name,
        format_type(attribute.atttypid, attribute.atttypmod) AS formatted_type,
        NOT attribute.attnotnull AS nullable,
        attribute.attidentity AS identity_kind,
        pg_get_expr(attribute_default.adbin, attribute_default.adrelid) AS default_expression
      FROM pg_class AS table_class
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = table_class.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      LEFT JOIN pg_attrdef AS attribute_default
        ON attribute_default.adrelid = attribute.attrelid
       AND attribute_default.adnum = attribute.attnum
      WHERE table_namespace.nspname = 'public'
        AND table_class.relname IN ${tx([...CURRENT_TABLES])}
      ORDER BY table_class.relname, attribute.attnum
    `;
    const indexes = await tx<Array<IndexShapeRow>>`
      SELECT table_class.relname AS table_name,
        index_class.relname AS index_name,
        index_metadata.indisunique AS is_unique,
        index_metadata.indisprimary AS is_primary,
        index_metadata.indisvalid AS is_valid,
        index_metadata.indisready AS is_ready,
        pg_get_indexdef(index_class.oid) AS definition
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_class ON index_class.oid = index_metadata.indexrelid
      JOIN pg_class AS table_class ON table_class.oid = index_metadata.indrelid
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      WHERE table_namespace.nspname = 'public'
        AND table_class.relname IN ${tx([...CURRENT_TABLES])}
      ORDER BY table_class.relname, index_class.relname
    `;
    const constraints = await tx<Array<ConstraintShapeRow>>`
      SELECT table_class.relname AS table_name,
        constraint_row.conname AS constraint_name,
        constraint_row.contype::text AS constraint_type,
        constraint_row.convalidated AS is_validated,
        constraint_row.condeferrable AS is_deferrable,
        pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      WHERE table_namespace.nspname = 'public'
        AND table_class.relname IN ${tx([...CURRENT_TABLES])}
      ORDER BY table_class.relname, constraint_row.conname
    `;
    return { tables, columns, indexes, constraints };
  });
}

async function applyPublicResolvedRenameFenceMigration(
  container: ReturnType<typeof createContainerFromDb>,
): Promise<void> {
  const migration = new MigrationService(container)
    .workMemberResolvedRenameFenceMigrationSqlForVerification();
  await withTx(container, async (tx) => {
    await tx.execute(drizzleSql.raw("SET LOCAL statement_timeout = '120s'"));
    await tx.execute(drizzleSql.raw("SET LOCAL lock_timeout = '5s'"));
    await tx.execute(drizzleSql.raw(migration));
  });
}

async function migrateProductionMemberCurrent(connectionString: string) {
  const admin = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_work_member_current_expand_migration" },
  });
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public,pg_temp",
    applicationName: "cinashop_work_member_current_expand_ddl",
  });
  try {
    const publicBefore = await publicSafetySnapshot(admin);
    const legacyBefore = await legacyProductionSafetySnapshot(admin);
    const currentCountsBefore = await currentProjectionRowCounts(admin, "public");

    await applyPublicResolvedRenameFenceMigration(createContainerFromDb(db));
    const objectsAfterFirstPass = await currentProjectionObjectFingerprint(admin, "public");
    const tuplesAfterFirstPass = await currentProjectionTupleFingerprint(admin, "public");
    const sequencesAfterFirstPass = await currentProjectionSequenceFingerprint(admin, "public");

    await applyPublicResolvedRenameFenceMigration(createContainerFromDb(db));
    const objectsAfterSecondPass = await currentProjectionObjectFingerprint(admin, "public");
    const tuplesAfterSecondPass = await currentProjectionTupleFingerprint(admin, "public");
    const sequencesAfterSecondPass = await currentProjectionSequenceFingerprint(admin, "public");
    const currentCountsAfter = await currentProjectionRowCounts(admin, "public");
    const legacyAfter = await legacyProductionSafetySnapshot(admin);
    const publicAfter = await publicSafetySnapshot(admin);
    const catalog = await currentProjectionCatalogShape(admin);

    const currentRowsUnchanged = CURRENT_TABLES.every((table) => {
      const before = currentCountsBefore[table];
      const after = currentCountsAfter[table];
      return before === null ? after === "0" : before === after;
    });
    const assertions = {
      exact_embedded_0113_applied_twice: true,
      legacy_member_rows_unchanged: sameJson(
        legacyBefore.tables.map((row) => [row.table, row.rows]),
        legacyAfter.tables.map((row) => [row.table, row.rows]),
      ),
      legacy_member_mvcc_aggregate_fingerprints_unchanged: sameJson(
        legacyBefore.tables.map((row) => [row.table, row.fingerprint]),
        legacyAfter.tables.map((row) => [row.table, row.fingerprint]),
      ),
      legacy_member_sequence_values_unchanged:
        sameJson(legacyBefore.sequences, legacyAfter.sequences),
      no_current_member_business_rows_written: currentRowsUnchanged,
      all_public_rows_sequences_and_mvcc_aggregates_unchanged:
        sameJson(publicBefore, publicAfter),
      second_pass_object_oid_and_relfilenode_stable:
        objectsAfterFirstPass.length > 0
        && sameJson(objectsAfterFirstPass, objectsAfterSecondPass),
      second_pass_existing_rows_ctid_xmin_stable:
        sameJson(tuplesAfterFirstPass, tuplesAfterSecondPass),
      second_pass_sequence_values_stable:
        sameJson(sequencesAfterFirstPass, sequencesAfterSecondPass),
      current_catalog_shape_complete:
        catalog.tables.length === CURRENT_TABLES.length
        && exactCurrentMemberColumnNames(catalog.columns)
        && allPresent(new Set(catalog.indexes
          .filter((row) => row.is_valid && row.is_ready)
          .map((row) => row.index_name)), CURRENT_MEMBER_INDEXES)
        && allPresent(new Set(catalog.constraints
          .filter((row) => row.is_validated)
          .map((row) => row.constraint_name)), CURRENT_MEMBER_CONSTRAINTS),
    };
    if (!Object.values(assertions).every(Boolean)) {
      throw new Error("production member current migration assertions failed");
    }
    return {
      complete: true,
      migration: "0113_work_member_resolved_rename_fence",
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
      public_safety: {
        table_count: publicAfter.tables.length,
        sequence_count: publicAfter.sequences.length,
        before_digest: await sha256Json(publicBefore),
        after_digest: await sha256Json(publicAfter),
      },
      current_row_counts_before: currentCountsBefore,
      current_row_counts_after: currentCountsAfter,
      migration_object_count: objectsAfterSecondPass.length,
      current_catalog_shape: catalog,
    };
  } finally {
    const closeResults = await Promise.allSettled([
      db.$client.end({ timeout: 1 }),
      admin.end({ timeout: 1 }),
    ]);
    if (closeResults.some((closeResult) => closeResult.status === "rejected")) {
      throw new Error("production migration client cleanup failed");
    }
  }
}

async function setupIsolatedSchema(
  container: ReturnType<typeof createContainerFromDb>,
): Promise<void> {
  await withTx(container, async (tx) => {
    await tx.execute(drizzleSql.raw("SET LOCAL statement_timeout = '90s'"));
    await tx.execute(drizzleSql.raw("SET LOCAL lock_timeout = '5s'"));
    await tx.execute(drizzleSql.raw(ISOLATED_PREREQUISITE_SQL));
  });
}

async function applyWorkMemberBaselineMigrations(
  container: ReturnType<typeof createContainerFromDb>,
): Promise<void> {
  const migrationService = new MigrationService(container);
  const migrations = [
    migrationService.workCallbackPipelineMigrationSqlForVerification(),
    migrationService.workCallbackFollowProjectionMigrationSqlForVerification(),
    migrationService.workCallbackProjectionStateMigrationSqlForVerification(),
    migrationService.workMemberCurrentProjectionMigrationSqlForVerification(),
  ];
  await withTx(container, async (tx) => {
    await tx.execute(drizzleSql.raw("SET LOCAL statement_timeout = '90s'"));
    await tx.execute(drizzleSql.raw("SET LOCAL lock_timeout = '5s'"));
    for (const migration of migrations) {
      await tx.execute(drizzleSql.raw(migration));
    }
  });
}

async function applyResolvedRenameFenceMigration(
  container: ReturnType<typeof createContainerFromDb>,
): Promise<void> {
  const migration = new MigrationService(container)
    .workMemberResolvedRenameFenceMigrationSqlForVerification();
  await withTx(container, async (tx) => {
    await tx.execute(drizzleSql.raw("SET LOCAL statement_timeout = '90s'"));
    await tx.execute(drizzleSql.raw("SET LOCAL lock_timeout = '5s'"));
    await tx.execute(drizzleSql.raw(migration));
  });
}

async function applyWorkMemberMigrations(
  container: ReturnType<typeof createContainerFromDb>,
): Promise<void> {
  await applyWorkMemberBaselineMigrations(container);
  await applyResolvedRenameFenceMigration(container);
}

async function migrationVerifierRejectsDrift(
  container: ReturnType<typeof createContainerFromDb>,
  client: postgres.Sql,
  schema: string,
  driftSql: string,
  migrationKind: "0112" | "0113" = "0112",
): Promise<{
  verifier_rejected_drift: boolean;
  object_catalog_rolled_back: boolean;
  existing_tuples_rolled_back: boolean;
  sequence_state_rolled_back: boolean;
}> {
  assertAuditSchema(schema);
  const beforeObjects = await isolatedObjectFingerprint(client, schema);
  const beforeTuples = await isolatedTupleFingerprint(client, schema);
  const beforeSequences = await isolatedSequenceFingerprint(client, schema);
  const beforeSequenceCatalog = await isolatedSequenceCatalogFingerprint(client, schema);
  const migrationService = new MigrationService(container);
  const migration = migrationKind === "0112"
    ? migrationService.workMemberCurrentProjectionMigrationSqlForVerification()
    : migrationService.workMemberResolvedRenameFenceMigrationSqlForVerification();
  let verifierRejectedDrift = false;
  try {
    await withTx(container, async (tx) => {
      await tx.execute(drizzleSql.raw("SET LOCAL statement_timeout = '90s'"));
      await tx.execute(drizzleSql.raw("SET LOCAL lock_timeout = '5s'"));
      await tx.execute(drizzleSql.raw(driftSql));
      await tx.execute(drizzleSql.raw(migration));
    });
  } catch (error) {
    verifierRejectedDrift = postgresErrorCode(error) === "P0001";
  }
  const afterObjects = await isolatedObjectFingerprint(client, schema);
  const afterTuples = await isolatedTupleFingerprint(client, schema);
  const afterSequences = await isolatedSequenceFingerprint(client, schema);
  const afterSequenceCatalog = await isolatedSequenceCatalogFingerprint(client, schema);
  return {
    verifier_rejected_drift: verifierRejectedDrift,
    object_catalog_rolled_back: sameJson(beforeObjects, afterObjects),
    existing_tuples_rolled_back: sameJson(beforeTuples, afterTuples),
    sequence_state_rolled_back:
      sameJson(beforeSequences, afterSequences)
      && sameJson(beforeSequenceCatalog, afterSequenceCatalog),
  };
}

async function migrationVerifierNegativeScenario(
  container: ReturnType<typeof createContainerFromDb>,
  client: postgres.Sql,
  schema: string,
) {
  const cases = [
    {
      name: "lowercase_active_index_predicate",
      sql: `
        DROP INDEX "wmia_active_member_uq";
        CREATE UNIQUE INDEX "wmia_active_member_uq"
          ON "work_member_identity_alias" ("corp_id", "member_id")
          WHERE "lifecycle_state" = 'active';
      `,
    },
    {
      name: "and_or_alias_constraint_grouping",
      sql: `
        DELETE FROM "work_member_identity_alias";
        ALTER TABLE "work_member_identity_alias"
          DROP CONSTRAINT "wmia_lifecycle_identity_ck";
        ALTER TABLE "work_member_identity_alias"
          ADD CONSTRAINT "wmia_lifecycle_identity_ck" CHECK (
            ((
              "lifecycle_state" = 'UNRESOLVED'
              AND "userid" = "canonical_userid"
              AND ("link_event_id" IS NULL OR "userid" <> "canonical_userid")
              AND "link_event_id" IS NOT NULL
            ) OR (
              "lifecycle_state" = 'ACTIVE'
              AND "member_id" IS NOT NULL
              AND "userid" = "canonical_userid"
              AND "link_event_id" IS NULL
            ) OR (
              "lifecycle_state" = 'RENAMED'
              AND "member_id" IS NOT NULL
              AND "userid" <> "canonical_userid"
              AND "link_event_id" IS NULL
            ) OR (
              "lifecycle_state" = 'DELETED'
              AND "userid" = "canonical_userid"
              AND "link_event_id" IS NULL
            ))
            AND ("member_id" IS NULL OR "member_id" > 0)
        );
      `,
    },
    {
      name: "link_event_foreign_key_delete_action",
      sql: `
        ALTER TABLE "work_member_identity_alias"
          DROP CONSTRAINT "wmia_link_event_fk";
        ALTER TABLE "work_member_identity_alias"
          ADD CONSTRAINT "wmia_link_event_fk" FOREIGN KEY ("link_event_id")
          REFERENCES "work_callback_event" ("id") ON DELETE CASCADE;
      `,
    },
    {
      name: "link_fence_constraint",
      sql: `
        ALTER TABLE "work_member_identity_alias"
          DROP CONSTRAINT "wmia_link_fence_ck";
        ALTER TABLE "work_member_identity_alias"
          ADD CONSTRAINT "wmia_link_fence_ck" CHECK (
            "link_event_id" IS NULL OR "link_event_id" > 0
          );
      `,
    },
    {
      name: "pending_source_index_predicate",
      sql: `
        DROP INDEX "wmia_pending_source_idx";
        CREATE INDEX "wmia_pending_source_idx"
          ON "work_member_identity_alias" ("corp_id", "canonical_userid", "userid")
          WHERE "lifecycle_state" = 'UNRESOLVED';
      `,
    },
    {
      name: "link_event_index_predicate",
      sql: `
        DROP INDEX "wmia_link_event_idx";
        CREATE INDEX "wmia_link_event_idx"
          ON "work_member_identity_alias" ("link_event_id")
          WHERE "link_event_id" IS NULL;
      `,
    },
    {
      name: "current_values_constraint",
      sql: `
        ALTER TABLE "work_member_current" DROP CONSTRAINT "wmc_values_ck";
        ALTER TABLE "work_member_current"
          ADD CONSTRAINT "wmc_values_ck" CHECK ("id" > 0);
      `,
    },
    {
      name: "other_values_constraint",
      sql: `
        ALTER TABLE "work_member_other_current" DROP CONSTRAINT "wmoc_values_ck";
        ALTER TABLE "work_member_other_current"
          ADD CONSTRAINT "wmoc_values_ck" CHECK ("update_time" >= 0);
      `,
    },
    {
      name: "generated_default_column",
      sql: `
        DROP TABLE "work_member_other_current";
        CREATE TABLE "work_member_other_current" (
          "corp_id" varchar(18) NOT NULL,
          "member_id" integer NOT NULL,
          "extattr" text,
          "external_profile" text,
          "update_time" integer GENERATED ALWAYS AS (0) STORED NOT NULL
        );
      `,
    },
    {
      name: "identity_sequence_parameters",
      sql: `
        ALTER SEQUENCE "work_member_current_id_seq" INCREMENT BY 2;
      `,
    },
    {
      name: "identity_sequence_behind_rows",
      sql: `
        INSERT INTO "work_member_current" (
          "id", "corp_id", "userid", "canonical_userid", "lifecycle_state",
          "enable", "status", "profile_complete", "relations_complete", "deleted_time"
        ) OVERRIDING SYSTEM VALUE VALUES (
          2000000000, 'auditsequence', 'sequence-behind', 'sequence-behind', 'DELETED',
          0, 5, false, false, 1
        );
      `,
    },
  ] as const;
  const caseResults: Record<string, Awaited<ReturnType<typeof migrationVerifierRejectsDrift>>> = {};
  for (const driftCase of cases) {
    caseResults[driftCase.name] = await migrationVerifierRejectsDrift(
      container,
      client,
      schema,
      driftCase.sql,
    );
  }
  const assertions: Record<string, boolean> = {};
  for (const [caseName, caseResult] of Object.entries(caseResults)) {
    assertions[`${caseName}_rejected_by_exact_verifier`] = caseResult.verifier_rejected_drift;
    assertions[`${caseName}_transaction_fully_rolled_back`] =
      caseResult.object_catalog_rolled_back
      && caseResult.existing_tuples_rolled_back
      && caseResult.sequence_state_rolled_back;
  }
  return {
    mode: "transactional_exact_ddl_drift_rejection",
    cases: caseResults,
    assertions,
    checks_passed: Object.values(assertions).filter(Boolean).length,
    expected_checks: Object.keys(assertions).length,
  };
}

async function resolvedRenameFencePreflightNegativeScenario(
  container: ReturnType<typeof createContainerFromDb>,
  client: postgres.Sql,
  schema: string,
) {
  const result = await migrationVerifierRejectsDrift(
    container,
    client,
    schema,
    `
      UPDATE work_member_identity_alias
      SET canonical_userid = 'audit-preexisting-target',
        lifecycle_state = 'RENAMED',
        update_time = update_time + 1
      WHERE corp_id = '${AUDIT_CORP_ID}' AND userid = '${AUDIT_USER_ID}';
    `,
    "0113",
  );
  const assertions = {
    preexisting_renamed_without_provable_edge_rejected:
      result.verifier_rejected_drift,
    preexisting_renamed_rejection_fully_rolled_back:
      result.object_catalog_rolled_back
      && result.existing_tuples_rolled_back
      && result.sequence_state_rolled_back,
  };
  return {
    mode: "0113_fail_closed_preflight",
    result,
    assertions,
    checks_passed: Object.values(assertions).filter(Boolean).length,
    expected_checks: Object.keys(assertions).length,
  };
}

async function resolvedRenameFenceVerifierNegativeScenario(
  container: ReturnType<typeof createContainerFromDb>,
  client: postgres.Sql,
  schema: string,
) {
  const cases = [
    {
      name: "resolved_link_marker_constraint",
      sql: `
        ALTER TABLE work_member_identity_alias
          DROP CONSTRAINT wmia_resolved_link_required_ck;
        ALTER TABLE work_member_identity_alias
          ADD CONSTRAINT wmia_resolved_link_required_ck CHECK (
            lifecycle_state <> 'RENAMED'
            OR link_event_id IS NOT NULL
            OR member_id IS NOT NULL
          );
      `,
    },
    {
      name: "immutable_guard_function_body",
      sql: `
        CREATE OR REPLACE FUNCTION wmia_guard_renamed_link_0113()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog
        AS $wrong_guard$
        BEGIN
          RETURN NEW;
        END
        $wrong_guard$;
      `,
    },
    {
      name: "immutable_guard_trigger_disabled",
      sql: `
        ALTER TABLE work_member_identity_alias
          DISABLE TRIGGER wmia_guard_renamed_link_0113;
      `,
    },
  ] as const;
  const caseResults: Record<string, Awaited<ReturnType<typeof migrationVerifierRejectsDrift>>> = {};
  for (const driftCase of cases) {
    caseResults[driftCase.name] = await migrationVerifierRejectsDrift(
      container,
      client,
      schema,
      driftCase.sql,
      "0113",
    );
  }
  const assertions: Record<string, boolean> = {};
  for (const [caseName, caseResult] of Object.entries(caseResults)) {
    assertions[`${caseName}_rejected_by_exact_verifier`] = caseResult.verifier_rejected_drift;
    assertions[`${caseName}_transaction_fully_rolled_back`] =
      caseResult.object_catalog_rolled_back
      && caseResult.existing_tuples_rolled_back
      && caseResult.sequence_state_rolled_back;
  }
  return {
    mode: "0113_transactional_exact_guard_rejection",
    cases: caseResults,
    assertions,
    checks_passed: Object.values(assertions).filter(Boolean).length,
    expected_checks: Object.keys(assertions).length,
  };
}

async function seedStableRows(
  client: postgres.Sql,
  schema: string,
): Promise<{ eventId: number; memberId: number }> {
  assertAuditSchema(schema);
  return client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const eventRows = await tx<Array<{ id: number }>>`
      INSERT INTO work_callback_event (
        event_key, payload_hash, subject_key_hash, corp_id,
        msg_type, event_type, change_type, event_time, sequence_rank,
        payload, status, projection_status, received_time, processed_time, update_time
      ) VALUES (
        ${AUDIT_EVENT_KEY}, ${AUDIT_PAYLOAD_HASH}, ${AUDIT_SUBJECT_HASH}, ${AUDIT_CORP_ID},
        'event', 'change_contact', 'create_user', 100, 1,
        '{"source":"member-current-audit"}'::jsonb,
        'ORDERED', 'APPLIED', 100, 100, 100
      )
      RETURNING id
    `;
    const eventId = eventRows[0]?.id;
    if (!eventId) throw new Error("isolated event seed failed");
    await tx`
      INSERT INTO work_callback_outbox (
        event_id, event_key, status, available_time,
        enqueued_time, processed_time, add_time, update_time
      ) VALUES (
        ${eventId}, ${AUDIT_EVENT_KEY}, 'COMPLETED', 100,
        100, 100, 100, 100
      )
    `;
    await tx`
      INSERT INTO work_callback_watermark (
        subject_key_hash, event_time, sequence_rank, event_id, event_key, update_time
      ) VALUES (
        ${AUDIT_SUBJECT_HASH}, 100, 1, ${eventId}, ${AUDIT_EVENT_KEY}, 100
      )
    `;
    const memberRows = await tx<Array<{ id: number }>>`
      INSERT INTO work_member_current (
        corp_id, userid, canonical_userid, lifecycle_state,
        name, enable, is_leader, main_department, status,
        profile_complete, relations_complete,
        last_event_id, last_event_key, last_event_subject_key_hash,
        last_event_time, last_sequence_rank, create_time, update_time
      ) VALUES (
        ${AUDIT_CORP_ID}, ${AUDIT_USER_ID}, ${AUDIT_USER_ID}, 'ACTIVE',
        'Audit Member', 1, 0, 1, 1,
        true, true,
        ${eventId}, ${AUDIT_EVENT_KEY}, ${AUDIT_SUBJECT_HASH},
        100, 1, 100, 100
      )
      RETURNING id
    `;
    const memberId = memberRows[0]?.id;
    if (!memberId) throw new Error("isolated member seed failed");
    await tx`
      INSERT INTO work_member_identity_alias (
        corp_id, userid, member_id, canonical_userid, lifecycle_state,
        last_event_id, last_event_key, last_event_subject_key_hash,
        last_event_time, last_sequence_rank, create_time, update_time
      ) VALUES (
        ${AUDIT_CORP_ID}, ${AUDIT_USER_ID}, ${memberId}, ${AUDIT_USER_ID}, 'ACTIVE',
        ${eventId}, ${AUDIT_EVENT_KEY}, ${AUDIT_SUBJECT_HASH},
        100, 1, 100, 100
      )
    `;
    await tx`
      INSERT INTO work_member_other_current (
        corp_id, member_id, extattr, external_profile, update_time
      ) VALUES (
        ${AUDIT_CORP_ID}, ${memberId}, '{"audit":true}', '{"audit":true}', 100
      )
    `;
    await tx`
      INSERT INTO work_member_relation_current (
        corp_id, member_id, department_id, sort_order,
        is_leader_in_dept, create_time, update_time
      ) VALUES (
        ${AUDIT_CORP_ID}, ${memberId}, 1, 4294967295, 0, 100, 100
      )
    `;
    return { eventId, memberId };
  });
}

async function isolatedObjectFingerprint(
  client: postgres.Sql,
  schema: string,
): Promise<readonly ObjectFingerprint[]> {
  assertAuditSchema(schema);
  return client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    return tx<Array<ObjectFingerprint>>`
      SELECT 'relation:' || relation.relkind::text AS object_kind,
        relation.relname AS object_name,
        relation.oid::text AS object_oid,
        relation.relfilenode::text AS relfilenode,
        NULL::text AS definition
      FROM pg_class AS relation
      JOIN pg_namespace AS relation_namespace ON relation_namespace.oid = relation.relnamespace
      WHERE relation_namespace.nspname = ${schema}
      UNION ALL
      SELECT 'constraint:' || constraint_row.contype::text AS object_kind,
        table_class.relname || '.' || constraint_row.conname AS object_name,
        constraint_row.oid::text AS object_oid,
        NULL::text AS relfilenode,
        pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      WHERE table_namespace.nspname = ${schema}
      UNION ALL
      SELECT 'function' AS object_kind,
        function_row.proname AS object_name,
        function_row.oid::text AS object_oid,
        NULL::text AS relfilenode,
        pg_get_functiondef(function_row.oid) AS definition
      FROM pg_proc AS function_row
      JOIN pg_namespace AS function_namespace
        ON function_namespace.oid = function_row.pronamespace
      WHERE function_namespace.nspname = ${schema}
      UNION ALL
      SELECT 'trigger' AS object_kind,
        table_class.relname || '.' || trigger_row.tgname AS object_name,
        trigger_row.oid::text AS object_oid,
        NULL::text AS relfilenode,
        pg_get_triggerdef(trigger_row.oid) AS definition
      FROM pg_trigger AS trigger_row
      JOIN pg_class AS table_class ON table_class.oid = trigger_row.tgrelid
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      WHERE table_namespace.nspname = ${schema}
        AND NOT trigger_row.tgisinternal
      ORDER BY object_kind, object_name
    `;
  });
}

async function isolatedTupleFingerprint(
  client: postgres.Sql,
  schema: string,
): Promise<readonly TupleFingerprint[]> {
  assertAuditSchema(schema);
  return client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const fingerprints: TupleFingerprint[] = [];
    for (const table of ISOLATED_TUPLE_TABLES) {
      const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
      const rows = await tx.unsafe<Array<{
        row_count: string;
        tuple_identity: string;
        row_digest: string;
      }>>(`
        SELECT count(*)::text AS row_count,
          md5(COALESCE(string_agg(
            ctid::text || ':' || xmin::text,
            '|' ORDER BY ctid
          ), '')) AS tuple_identity,
          md5(COALESCE(string_agg(
            md5(to_jsonb(source_row)::text),
            '|' ORDER BY ctid
          ), '')) AS row_digest
        FROM ${qualified} AS source_row
      `);
      fingerprints.push({
        table,
        rows: rows[0]?.row_count ?? "-1",
        tuple_identity: rows[0]?.tuple_identity ?? "",
        row_digest: rows[0]?.row_digest ?? "",
      });
    }
    return fingerprints;
  });
}

async function isolatedSequenceFingerprint(
  client: postgres.Sql,
  schema: string,
): Promise<readonly SequenceFingerprint[]> {
  assertAuditSchema(schema);
  return client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const names = await tx<Array<{ sequence_name: string }>>`
      SELECT sequence_class.relname AS sequence_name
      FROM pg_class AS sequence_class
      JOIN pg_namespace AS sequence_namespace
        ON sequence_namespace.oid = sequence_class.relnamespace
      WHERE sequence_namespace.nspname = ${schema}
        AND sequence_class.relkind = 'S'
      ORDER BY sequence_class.relname
    `;
    const result: SequenceFingerprint[] = [];
    for (const row of names) {
      const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(row.sequence_name)}`;
      const values = await tx.unsafe<Array<{ last_value: string; is_called: boolean }>>(
        `SELECT last_value::text AS last_value, is_called FROM ${qualified}`,
      );
      if (!values[0]) throw new Error("isolated sequence fingerprint failed");
      result.push({
        sequence: row.sequence_name,
        lastValue: values[0].last_value,
        isCalled: values[0].is_called,
      });
    }
    return result;
  });
}

async function isolatedSequenceCatalogFingerprint(
  client: postgres.Sql,
  schema: string,
): Promise<readonly SequenceCatalogFingerprint[]> {
  assertAuditSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    return tx<SequenceCatalogFingerprint[]>`
      SELECT sequence_class.relname AS sequence_name,
        sequence_class.oid::text AS sequence_oid,
        format_type(sequence_metadata.seqtypid, NULL) AS data_type,
        sequence_metadata.seqstart::text AS start_value,
        sequence_metadata.seqincrement::text AS increment_by,
        sequence_metadata.seqmin::text AS minimum_value,
        sequence_metadata.seqmax::text AS maximum_value,
        sequence_metadata.seqcache::text AS cache_size,
        sequence_metadata.seqcycle AS cycles,
        COALESCE(ownership.deptype::text, '') AS dependency_type,
        COALESCE(owned_table.relname, '') AS owned_table,
        COALESCE(owned_column.attname, '') AS owned_column
      FROM pg_class AS sequence_class
      JOIN pg_namespace AS sequence_namespace
        ON sequence_namespace.oid = sequence_class.relnamespace
      JOIN pg_sequence AS sequence_metadata
        ON sequence_metadata.seqrelid = sequence_class.oid
      LEFT JOIN LATERAL (
        SELECT dependency.deptype, dependency.refobjid, dependency.refobjsubid
        FROM pg_depend AS dependency
        WHERE dependency.classid = 'pg_class'::regclass
          AND dependency.objid = sequence_class.oid
          AND dependency.refclassid = 'pg_class'::regclass
          AND dependency.refobjsubid > 0
          AND dependency.deptype IN ('a', 'i')
        ORDER BY dependency.deptype, dependency.refobjid, dependency.refobjsubid
        LIMIT 1
      ) AS ownership ON true
      LEFT JOIN pg_class AS owned_table ON owned_table.oid = ownership.refobjid
      LEFT JOIN pg_attribute AS owned_column
        ON owned_column.attrelid = ownership.refobjid
       AND owned_column.attnum = ownership.refobjsubid
      WHERE sequence_namespace.nspname = ${schema}
        AND sequence_class.relkind = 'S'
      ORDER BY sequence_class.relname
    `;
  });
}

function postgresErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const value = Reflect.get(error, "code");
  return typeof value === "string" ? value : null;
}

async function expectedCheckViolation(operation: () => Promise<void>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch (error) {
    return postgresErrorCode(error) === "23514";
  }
}

async function currentMemberSmoke(
  client: postgres.Sql,
  schema: string,
  seed: { eventId: number; memberId: number },
) {
  assertAuditSchema(schema);
  const renameState = await client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    await tx`
      UPDATE work_member_current
      SET userid = ${AUDIT_RENAMED_USER_ID},
        canonical_userid = ${AUDIT_RENAMED_USER_ID},
        name = 'Audit Member Renamed', update_time = 200
      WHERE corp_id = ${AUDIT_CORP_ID} AND id = ${seed.memberId}
    `;
    await tx`
      UPDATE work_member_identity_alias
      SET canonical_userid = ${AUDIT_RENAMED_USER_ID},
        lifecycle_state = 'RENAMED',
        link_event_id = ${seed.eventId},
        link_event_time = 100,
        link_sequence_rank = 1,
        update_time = 200
      WHERE corp_id = ${AUDIT_CORP_ID} AND userid = ${AUDIT_USER_ID}
    `;
    await tx`
      INSERT INTO work_member_identity_alias (
        corp_id, userid, member_id, canonical_userid, lifecycle_state,
        last_event_id, last_event_key, last_event_subject_key_hash,
        last_event_time, last_sequence_rank, create_time, update_time
      ) VALUES (
        ${AUDIT_CORP_ID}, ${AUDIT_RENAMED_USER_ID}, ${seed.memberId},
        ${AUDIT_RENAMED_USER_ID}, 'ACTIVE',
        ${seed.eventId}, ${AUDIT_EVENT_KEY}, ${AUDIT_SUBJECT_HASH},
        100, 1, 200, 200
      )
    `;
    await tx`
      UPDATE work_member_other_current
      SET extattr = NULL, update_time = 200
      WHERE corp_id = ${AUDIT_CORP_ID} AND member_id = ${seed.memberId}
    `;
    await tx`
      DELETE FROM work_member_relation_current
      WHERE corp_id = ${AUDIT_CORP_ID} AND member_id = ${seed.memberId}
    `;
    await tx`
      INSERT INTO work_member_relation_current (
        corp_id, member_id, department_id, sort_order,
        is_leader_in_dept, create_time, update_time
      ) VALUES (${AUDIT_CORP_ID}, ${seed.memberId}, 2, 7, 1, 200, 200)
    `;
    const member = await tx<Array<{
      id: number;
      userid: string;
      canonical_userid: string;
      lifecycle_state: string;
    }>>`
      SELECT id, userid, canonical_userid, lifecycle_state
      FROM work_member_current
      WHERE corp_id = ${AUDIT_CORP_ID} AND id = ${seed.memberId}
    `;
    const aliases = await tx<Array<{
      userid: string;
      member_id: number | null;
      canonical_userid: string;
      lifecycle_state: string;
    }>>`
      SELECT userid, member_id, canonical_userid, lifecycle_state
      FROM work_member_identity_alias
      WHERE corp_id = ${AUDIT_CORP_ID}
      ORDER BY userid
    `;
    const other = await tx<Array<{ extattr: string | null }>>`
      SELECT extattr FROM work_member_other_current
      WHERE corp_id = ${AUDIT_CORP_ID} AND member_id = ${seed.memberId}
    `;
    const relations = await tx<Array<{
      department_id: number;
      sort_order: string;
      is_leader_in_dept: number;
    }>>`
      SELECT department_id, sort_order::text AS sort_order, is_leader_in_dept
      FROM work_member_relation_current
      WHERE corp_id = ${AUDIT_CORP_ID} AND member_id = ${seed.memberId}
    `;
    return {
      member: member[0] ?? null,
      aliases,
      other: other[0] ?? null,
      relations,
    };
  });

  const uppercaseIdentityRejected = await expectedCheckViolation(() =>
    client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
      await tx`
        INSERT INTO work_member_identity_alias (
          corp_id, userid, canonical_userid, lifecycle_state, create_time, update_time
        ) VALUES (${AUDIT_CORP_ID}, 'UPPER-AUDIT', 'UPPER-AUDIT', 'UNRESOLVED', 1, 1)
      `;
    }).then(() => undefined));

  const sortOverflowRejected = await expectedCheckViolation(() =>
    client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
      await tx`
        INSERT INTO work_member_relation_current (
          corp_id, member_id, department_id, sort_order,
          is_leader_in_dept, create_time, update_time
        ) VALUES (${AUDIT_CORP_ID}, ${seed.memberId}, 3, 4294967296, 0, 1, 1)
      `;
    }).then(() => undefined));

  const renamedWithoutLinkRejected = await expectedCheckViolation(() =>
    client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
      await tx`
        INSERT INTO work_member_identity_alias (
          corp_id, userid, member_id, canonical_userid, lifecycle_state,
          last_event_id, last_event_key, last_event_subject_key_hash,
          last_event_time, last_sequence_rank, create_time, update_time
        ) VALUES (
          ${AUDIT_CORP_ID}, 'missing-resolved-link', ${seed.memberId},
          'missing-resolved-target', 'RENAMED',
          ${seed.eventId}, ${AUDIT_EVENT_KEY}, ${AUDIT_SUBJECT_HASH},
          100, 1, 1, 1
        )
      `;
    }).then(() => undefined));

  const renamedLinkMutationRejected = await expectedCheckViolation(() =>
    client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
      await tx`
        UPDATE work_member_identity_alias
        SET link_event_time = 99
        WHERE corp_id = ${AUDIT_CORP_ID} AND userid = ${AUDIT_USER_ID}
      `;
    }).then(() => undefined));

  const deleteState = await client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    await tx`
      UPDATE work_member_current
      SET lifecycle_state = 'DELETED', enable = 0, status = 5,
        relations_complete = false, deleted_time = 300, update_time = 300
      WHERE corp_id = ${AUDIT_CORP_ID} AND id = ${seed.memberId}
    `;
    await tx`
      UPDATE work_member_identity_alias
      SET lifecycle_state = 'DELETED', update_time = 300
      WHERE corp_id = ${AUDIT_CORP_ID} AND userid = ${AUDIT_RENAMED_USER_ID}
    `;
    await tx`
      DELETE FROM work_member_relation_current
      WHERE corp_id = ${AUDIT_CORP_ID} AND member_id = ${seed.memberId}
    `;
    const members = await tx<Array<{
      id: number;
      userid: string;
      lifecycle_state: string;
      enable: number | null;
      status: number | null;
      deleted_time: number | null;
    }>>`
      SELECT id, userid, lifecycle_state, enable, status, deleted_time
      FROM work_member_current
      WHERE corp_id = ${AUDIT_CORP_ID} AND id = ${seed.memberId}
    `;
    const aliases = await tx<Array<{ userid: string; lifecycle_state: string }>>`
      SELECT userid, lifecycle_state
      FROM work_member_identity_alias
      WHERE corp_id = ${AUDIT_CORP_ID}
      ORDER BY userid
    `;
    const relationCount = await tx<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM work_member_relation_current
      WHERE corp_id = ${AUDIT_CORP_ID} AND member_id = ${seed.memberId}
    `;
    return {
      member: members[0] ?? null,
      aliases,
      relationCount: relationCount[0]?.count ?? -1,
    };
  });

  const renamedAlias = renameState.aliases.find((row) => row.userid === AUDIT_USER_ID);
  const activeAlias = renameState.aliases.find((row) => row.userid === AUDIT_RENAMED_USER_ID);
  const deletedAlias = deleteState.aliases.find((row) => row.userid === AUDIT_RENAMED_USER_ID);
  const assertions = {
    stable_member_id_preserved: renameState.member?.id === seed.memberId,
    rename_updates_canonical_identity:
      renameState.member?.userid === AUDIT_RENAMED_USER_ID
      && renameState.member.canonical_userid === AUDIT_RENAMED_USER_ID
      && renameState.member.lifecycle_state === "ACTIVE",
    rename_alias_chain_preserved:
      renamedAlias?.member_id === seed.memberId
      && renamedAlias.lifecycle_state === "RENAMED"
      && renamedAlias.canonical_userid === AUDIT_RENAMED_USER_ID
      && activeAlias?.member_id === seed.memberId
      && activeAlias.lifecycle_state === "ACTIVE",
    explicit_optional_clear_persisted: renameState.other?.extattr === null,
    relation_full_replace_persisted:
      renameState.relations.length === 1
      && renameState.relations[0]?.department_id === 2
      && renameState.relations[0].sort_order === "7"
      && renameState.relations[0].is_leader_in_dept === 1,
    uppercase_identity_rejected: uppercaseIdentityRejected,
    uint32_sort_overflow_rejected: sortOverflowRejected,
    renamed_alias_requires_resolved_link_fence: renamedWithoutLinkRejected,
    renamed_alias_link_fence_is_database_immutable: renamedLinkMutationRejected,
    delete_tombstone_persisted:
      deleteState.member?.id === seed.memberId
      && deleteState.member.userid === AUDIT_RENAMED_USER_ID
      && deleteState.member.lifecycle_state === "DELETED"
      && deleteState.member.enable === 0
      && deleteState.member.status === 5
      && deleteState.member.deleted_time === 300
      && deletedAlias?.lifecycle_state === "DELETED",
    delete_removes_current_relations: deleteState.relationCount === 0,
  };
  return {
    mode: "direct_sql_constraint_and_lifecycle_smoke",
    service_projection_invoked: false,
    service_projection_note:
      "Provider-backed callback projection is covered by unit tests; this production-engine harness validates exact DDL, identity continuity, aliasing, relation replacement, tombstones, and fail-closed constraints without contacting Enterprise WeChat.",
    assertions,
    checks_passed: Object.values(assertions).filter(Boolean).length,
    expected_checks: Object.keys(assertions).length,
  };
}

type AuditProviderResponse = Record<string, unknown>;
type AuditProviderOutcome =
  | AuditProviderResponse
  | EnterpriseWechatProviderError
  | (() => Promise<AuditProviderResponse>);

function auditProviderSnapshot(
  userid: string,
  overrides: AuditProviderResponse = {},
  omitted: readonly string[] = [],
): AuditProviderResponse {
  const response: AuditProviderResponse = {
    errcode: 0,
    errmsg: "ok",
    userid,
    name: "Audit Service Member",
    position: "Engineering",
    mobile: "+6581234567",
    gender: "1",
    email: "audit-member@example.test",
    biz_mail: "audit-member@corp.example.test",
    direct_leader: ["audit-leader"],
    avatar: "https://example.test/audit/avatar",
    thumb_avatar: "https://example.test/audit/thumb",
    telephone: "+65-61234567",
    alias: "audit-member",
    enable: 1,
    hide_mobile: 0,
    address: "Audit Address",
    open_userid: "open-audit-member",
    main_department: 7,
    status: 1,
    qr_code: "https://example.test/audit/qr",
    external_position: "Engineer",
    department: [7, 9],
    order: [4_294_967_295, 20],
    is_leader_in_dept: [1, 0],
    extattr: { audit: "initial" },
    external_profile: { audit: "initial" },
    ...overrides,
  };
  for (const field of omitted) delete response[field];
  return response;
}

function createAuditProviderController() {
  const outcomes = new Map<string, AuditProviderOutcome[]>();
  const directoryCalls: string[] = [];
  let factoryCalls = 0;
  const enqueue = (userid: string, outcome: AuditProviderOutcome): void => {
    const normalized = userid.toLowerCase();
    const queue = outcomes.get(normalized) ?? [];
    queue.push(outcome);
    outcomes.set(normalized, queue);
  };
  const factory: DirectoryMemberProviderFactory = (_corpId) => {
    factoryCalls += 1;
    return {
      async directoryMember(userid: string): Promise<AuditProviderResponse> {
        directoryCalls.push(userid);
        const queue = outcomes.get(userid);
        const outcome = queue?.shift();
        if (!outcome) {
          throw new EnterpriseWechatProviderError(
            "terminal",
            "directory_member_get",
            -1,
            0,
          );
        }
        if (outcome instanceof EnterpriseWechatProviderError) throw outcome;
        return typeof outcome === "function" ? outcome() : outcome;
      },
    };
  };
  return {
    enqueue,
    factory,
    factoryCallCount: () => factoryCalls,
    directoryCallCount: () => directoryCalls.length,
  };
}

function deferredAuditProviderOutcome() {
  let markStarted: (() => void) | null = null;
  let releaseResponse: ((value: AuditProviderResponse) => void) | null = null;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const response = new Promise<AuditProviderResponse>((resolve) => {
    releaseResponse = resolve;
  });
  return {
    started,
    outcome: async (): Promise<AuditProviderResponse> => {
      markStarted?.();
      return response;
    },
    resolve(value: AuditProviderResponse): void {
      if (!releaseResponse) throw new Error("deferred provider response is unavailable");
      releaseResponse(value);
    },
  };
}

async function boundedAuditWait<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(label)), 10_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function noDispatchAuditQueue(): Queue<OrderMessage> {
  return {
    async metrics(): Promise<QueueMetrics> {
      return { backlogCount: 0, backlogBytes: 0 };
    },
    async send(
      _message: OrderMessage,
      _options?: QueueSendOptions,
    ): Promise<QueueSendResponse> {
      throw new Error("isolated service scenario must not dispatch Queue messages");
    },
    async sendBatch(
      _messages: Iterable<MessageSendRequest<OrderMessage>>,
      _options?: QueueSendBatchOptions,
    ): Promise<QueueSendBatchResponse> {
      throw new Error("isolated service scenario must not dispatch Queue messages");
    },
  };
}

function createAuditQueueCapture() {
  const messages: WorkCallbackOutboxMessage[] = [];
  const capture = (body: OrderMessage): void => {
    if (
      !body
      || typeof body !== "object"
      || !("action" in body)
      || body.action !== "processWorkCallbackOutbox"
    ) throw new Error("isolated authority audit captured an unexpected Queue message");
    messages.push(body as WorkCallbackOutboxMessage);
  };
  const queue = {
    async send(body: OrderMessage): Promise<void> {
      capture(body);
    },
    async sendBatch(batch: Iterable<{ body: OrderMessage }>): Promise<void> {
      for (const item of batch) capture(item.body);
    },
  } as unknown as Queue<OrderMessage>;
  return {
    queue,
    take(): WorkCallbackOutboxMessage {
      const message = messages.shift();
      if (!message) throw new Error("isolated authority audit Queue message is missing");
      return message;
    },
    pendingCount(): number {
      return messages.length;
    },
  };
}

async function consumeAuditQueueMessage(
  message: WorkCallbackOutboxMessage,
  service: Pick<EnterpriseWechatCallbackService, "processMessage">,
): Promise<{ outcome: string; ack_count: number; retry_count: number }> {
  let outcome = "not-called";
  let ackCount = 0;
  let retryCount = 0;
  await consumeWorkCallbackQueueMessage(
    {
      body: message,
      attempts: 1,
      ack(): void {
        ackCount += 1;
      },
      retry(): void {
        retryCount += 1;
      },
    },
    {
      async processMessage(body) {
        const result = await service.processMessage(body);
        outcome = typeof result === "object" ? result.kind : result;
        return result;
      },
    },
  );
  return { outcome, ack_count: ackCount, retry_count: retryCount };
}

async function insertAuditServiceEvent(
  client: postgres.Sql,
  schema: string,
  input: {
    corpId: string;
    eventTime: number;
    changeType: "create_user" | "update_user" | "delete_user";
    userid: string;
    newUserid?: string;
  },
): Promise<WorkCallbackOutboxMessage> {
  assertAuditSchema(schema);
  const payload: WorkCallbackPayload = {
    ToUserName: input.corpId,
    CreateTime: input.eventTime,
    MsgType: "event",
    Event: "change_contact",
    ChangeType: input.changeType,
    UserID: input.userid,
  };
  if (input.newUserid !== undefined) payload.NewUserID = input.newUserid;
  const payloadHash = await sha256Json(payload);
  const eventKey = await sha256Text(
    `${schema}\0${input.eventTime}\0${input.changeType}\0${crypto.randomUUID()}`,
  );
  const subjectKeyHash = await sha256Text(
    `${input.corpId}\0member:${input.userid.toLowerCase()}`,
  );
  const sequenceRank = input.changeType === "delete_user"
    ? 100
    : input.changeType === "update_user"
      ? 50
      : 10;
  return client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const eventRows = await tx<Array<{ id: number }>>`
      INSERT INTO work_callback_event (
        event_key, payload_hash, subject_key_hash, corp_id,
        msg_type, event_type, change_type, event_time, sequence_rank,
        payload, status, projection_status, received_time, update_time
      ) VALUES (
        ${eventKey}, ${payloadHash}, ${subjectKeyHash}, ${input.corpId},
        'event', 'change_contact', ${input.changeType}, ${input.eventTime}, ${sequenceRank},
        jsonb_build_object(
          'ToUserName', ${input.corpId}::text,
          'CreateTime', ${input.eventTime}::integer,
          'MsgType', 'event',
          'Event', 'change_contact',
          'ChangeType', ${input.changeType}::text,
          'UserID', ${input.userid}::text
        ) || CASE WHEN ${input.newUserid !== undefined}::boolean
          THEN jsonb_build_object('NewUserID', ${input.newUserid ?? ""}::text)
          ELSE '{}'::jsonb
        END,
        'RECEIVED', 'PENDING',
        ${input.eventTime}, ${input.eventTime}
      )
      RETURNING id
    `;
    const eventId = eventRows[0]?.id;
    if (!eventId) throw new Error("isolated service event insert failed");
    const outboxRows = await tx<Array<{ id: number }>>`
      INSERT INTO work_callback_outbox (
        event_id, event_key, status, available_time, add_time, update_time
      ) VALUES (${eventId}, ${eventKey}, 'PENDING', 0, ${input.eventTime}, ${input.eventTime})
      RETURNING id
    `;
    const outboxId = outboxRows[0]?.id;
    if (!outboxId) throw new Error("isolated service outbox insert failed");
    return {
      action: "processWorkCallbackOutbox",
      outboxId,
      eventId,
      eventKey,
    };
  });
}

async function makeAuditServiceRetryAvailable(
  client: postgres.Sql,
  schema: string,
  message: WorkCallbackOutboxMessage,
): Promise<void> {
  assertAuditSchema(schema);
  await client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const rows = await tx<Array<{ id: number }>>`
      UPDATE work_callback_outbox
      SET available_time = 0
      WHERE id = ${message.outboxId}
        AND event_id = ${message.eventId}
        AND event_key = ${message.eventKey}
        AND status = 'FAILED'
      RETURNING id
    `;
    if (rows.length !== 1) throw new Error("isolated parked callback was not retryable");
  });
}

async function markAuditServiceLeaseExpired(
  client: postgres.Sql,
  schema: string,
  message: WorkCallbackOutboxMessage,
): Promise<void> {
  assertAuditSchema(schema);
  const expiredLeaseToken = "expired-member-audit-lease-token-01";
  await client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const events = await tx<Array<{ id: number }>>`
      UPDATE work_callback_event
      SET status = 'PROCESSING', projection_status = 'PROCESSING',
        attempt_count = 1, lease_until = 1, lease_token = ${expiredLeaseToken},
        last_error_code = '', update_time = 1
      WHERE id = ${message.eventId} AND event_key = ${message.eventKey}
      RETURNING id
    `;
    const outboxes = await tx<Array<{ id: number }>>`
      UPDATE work_callback_outbox
      SET status = 'PROCESSING', attempt_count = 1, available_time = 0,
        lease_until = 1, lease_token = ${expiredLeaseToken},
        last_error_code = '', update_time = 1
      WHERE id = ${message.outboxId}
        AND event_id = ${message.eventId}
        AND event_key = ${message.eventKey}
      RETURNING id
    `;
    if (events.length !== 1 || outboxes.length !== 1) {
      throw new Error("isolated callback lease expiry fixture was not installed");
    }
  });
}

interface AuditServiceMemberState {
  member: {
    id: number;
    userid: string;
    canonical_userid: string;
    lifecycle_state: string;
    legacy_member_id: number | null;
    uid: number | null;
    name: string | null;
    mobile: string | null;
    profile_complete: boolean;
    relations_complete: boolean;
    enable: number | null;
    status: number | null;
    deleted_time: number | null;
    last_event_id: number | null;
    last_event_time: number;
    last_sequence_rank: number;
    update_time: number;
  } | null;
  aliases: Array<{
    userid: string;
    member_id: number | null;
    canonical_userid: string;
    lifecycle_state: string;
    last_event_id: number | null;
    last_event_time: number;
    last_sequence_rank: number;
    link_event_id: number | null;
    link_event_time: number;
    link_sequence_rank: number;
  }>;
  other: { extattr: string | null; external_profile: string | null } | null;
  relations: Array<{
    department_id: number;
    sort_order: string;
    is_leader_in_dept: number;
  }>;
}

async function auditServiceMemberState(
  client: postgres.Sql,
  schema: string,
  corpId: string,
  userid: string,
): Promise<AuditServiceMemberState> {
  assertAuditSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const members = await tx<Array<Exclude<AuditServiceMemberState["member"], null>> >`
      SELECT id, userid, canonical_userid, lifecycle_state, legacy_member_id, uid,
        name, mobile,
        profile_complete, relations_complete, enable, status, deleted_time
        , last_event_id, last_event_time, last_sequence_rank, update_time
      FROM work_member_current
      WHERE corp_id = ${corpId} AND userid = ${userid}
      ORDER BY id
    `;
    const member = members[0] ?? null;
    const aliases = member
      ? await tx<AuditServiceMemberState["aliases"]>`
        SELECT userid, member_id, canonical_userid, lifecycle_state,
          last_event_id, last_event_time, last_sequence_rank,
          link_event_id, link_event_time, link_sequence_rank
        FROM work_member_identity_alias
        WHERE corp_id = ${corpId} AND member_id = ${member.id}
        ORDER BY userid
      `
      : await tx<AuditServiceMemberState["aliases"]>`
        SELECT userid, member_id, canonical_userid, lifecycle_state,
          last_event_id, last_event_time, last_sequence_rank,
          link_event_id, link_event_time, link_sequence_rank
        FROM work_member_identity_alias
        WHERE corp_id = ${corpId} AND userid = ${userid}
        ORDER BY userid
      `;
    const otherRows = member
      ? await tx<Array<{ extattr: string | null; external_profile: string | null }>>`
        SELECT extattr, external_profile
        FROM work_member_other_current
        WHERE corp_id = ${corpId} AND member_id = ${member.id}
      `
      : [];
    const relations = member
      ? await tx<AuditServiceMemberState["relations"]>`
        SELECT department_id, sort_order::text AS sort_order, is_leader_in_dept
        FROM work_member_relation_current
        WHERE corp_id = ${corpId} AND member_id = ${member.id}
        ORDER BY department_id
      `
      : [];
    return { member, aliases, other: otherRows[0] ?? null, relations };
  });
}

async function auditServiceBusinessCounts(
  client: postgres.Sql,
  schema: string,
  corpId: string,
): Promise<{ members: number; aliases: number; other: number; relations: number }> {
  assertAuditSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const rows = await tx<Array<{
      members: number;
      aliases: number;
      other: number;
      relations: number;
    }>>`
      SELECT
        (SELECT count(*)::integer FROM work_member_current WHERE corp_id = ${corpId}) AS members,
        (SELECT count(*)::integer FROM work_member_identity_alias WHERE corp_id = ${corpId}) AS aliases,
        (SELECT count(*)::integer FROM work_member_other_current WHERE corp_id = ${corpId}) AS other,
        (SELECT count(*)::integer FROM work_member_relation_current WHERE corp_id = ${corpId}) AS relations
    `;
    return rows[0] ?? { members: -1, aliases: -1, other: -1, relations: -1 };
  });
}

async function auditServiceBusinessDigest(
  client: postgres.Sql,
  schema: string,
  corpId: string,
): Promise<string> {
  assertAuditSchema(schema);
  const state = await client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const members = await tx<Array<Record<string, unknown>> >`
      SELECT id, corp_id, userid, canonical_userid, lifecycle_state,
        legacy_member_id, uid, name, position, mobile, gender, email, biz_mail,
        direct_leader, avatar, thumb_avatar, telephone, alias, enable, is_leader,
        hide_mobile, address, open_userid, main_department, status, qr_code,
        external_position, profile_complete, relations_complete, deleted_time, create_time
      FROM work_member_current WHERE corp_id = ${corpId} ORDER BY id
    `;
    const aliases = await tx<Array<Record<string, unknown>> >`
      SELECT corp_id, userid, member_id, canonical_userid, lifecycle_state, create_time
      FROM work_member_identity_alias WHERE corp_id = ${corpId}
      ORDER BY userid
    `;
    const other = await tx<Array<Record<string, unknown>> >`
      SELECT corp_id, member_id, extattr, external_profile
      FROM work_member_other_current WHERE corp_id = ${corpId}
      ORDER BY member_id
    `;
    const relations = await tx<Array<Record<string, unknown>> >`
      SELECT corp_id, member_id, department_id, sort_order::text AS sort_order,
        is_leader_in_dept, create_time
      FROM work_member_relation_current WHERE corp_id = ${corpId}
      ORDER BY member_id, department_id
    `;
    return { members, aliases, other, relations };
  });
  return sha256Json(state);
}

async function auditFullMemberProjectionDigest(
  client: postgres.Sql,
  schema: string,
  corpId: string,
): Promise<string> {
  assertAuditSchema(schema);
  const state = await client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const members = await tx<Array<Record<string, unknown>> >`
      SELECT id, corp_id, userid, canonical_userid, lifecycle_state,
        legacy_member_id, uid, name, position, mobile, gender, email, biz_mail,
        direct_leader, avatar, thumb_avatar, telephone, alias, enable, is_leader,
        hide_mobile, address, open_userid, main_department, status, qr_code,
        external_position, profile_complete, relations_complete, deleted_time,
        last_event_id, last_event_key, last_event_subject_key_hash,
        last_event_time, last_sequence_rank, create_time, update_time
      FROM work_member_current WHERE corp_id = ${corpId} ORDER BY id
    `;
    const aliases = await tx<Array<Record<string, unknown>> >`
      SELECT corp_id, userid, member_id, canonical_userid, lifecycle_state,
        last_event_id, last_event_key, last_event_subject_key_hash,
        last_event_time, last_sequence_rank,
        link_event_id, link_event_time, link_sequence_rank,
        create_time, update_time
      FROM work_member_identity_alias WHERE corp_id = ${corpId}
      ORDER BY userid
    `;
    const other = await tx<Array<Record<string, unknown>> >`
      SELECT corp_id, member_id, extattr, external_profile, update_time
      FROM work_member_other_current WHERE corp_id = ${corpId}
      ORDER BY member_id
    `;
    const relations = await tx<Array<Record<string, unknown>> >`
      SELECT corp_id, member_id, department_id, sort_order::text AS sort_order,
        is_leader_in_dept, create_time, update_time
      FROM work_member_relation_current WHERE corp_id = ${corpId}
      ORDER BY member_id, department_id
    `;
    return { members, aliases, other, relations };
  });
  return sha256Json(state);
}

async function auditServiceEventState(
  client: postgres.Sql,
  schema: string,
  eventId: number,
): Promise<{
  status: string;
  projection_status: string;
  outbox_status: string;
  watermark_count: number;
  event_attempt_count: number;
  outbox_attempt_count: number;
  event_last_error_code: string;
  outbox_last_error_code: string;
} | null> {
  assertAuditSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const rows = await tx<Array<{
      status: string;
      projection_status: string;
      outbox_status: string;
      watermark_count: number;
      event_attempt_count: number;
      outbox_attempt_count: number;
      event_last_error_code: string;
      outbox_last_error_code: string;
    }>>`
      SELECT event.status, event.projection_status,
        outbox.status AS outbox_status,
        event.attempt_count AS event_attempt_count,
        outbox.attempt_count AS outbox_attempt_count,
        event.last_error_code AS event_last_error_code,
        outbox.last_error_code AS outbox_last_error_code,
        (SELECT count(*)::integer FROM work_callback_watermark
          WHERE event_id = event.id) AS watermark_count
      FROM work_callback_event AS event
      JOIN work_callback_outbox AS outbox ON outbox.event_id = event.id
      WHERE event.id = ${eventId}
    `;
    return rows[0] ?? null;
  });
}

async function auditPendingActorBlocked(
  container: ReturnType<typeof createContainerFromDb>,
  corpId: string,
  userid: string,
): Promise<boolean> {
  const contextService = new EnterpriseWechatContextService(
    container,
    { WECHAT_WORK_MEMBER_CURRENT_AUTHORITY: "verified" } as Env,
    {
      stateStore: {
        async putOnce(): Promise<boolean> {
          throw new Error("isolated actor audit must not access a state store");
        },
        async take<T>(): Promise<T | null> {
          throw new Error("isolated actor audit must not access a state store");
        },
      },
      identityProvider: {
        async employeeIdentity(): Promise<{ corpId: string; agentId: number; userid: string }> {
          throw new Error("isolated actor audit must not access an identity provider");
        },
      },
    },
  );
  const requireActor = Reflect.get(contextService, "requireActor");
  if (typeof requireActor !== "function") {
    throw new Error("context actor gate is unavailable");
  }
  try {
    await Reflect.apply(requireActor, contextService, [corpId, userid]);
    return false;
  } catch (error) {
    if (error instanceof ForbiddenException) return true;
    throw error;
  }
}

interface AuditInterleavedIdentityState {
  pair_current_rows: number;
  stable_current_rows: number;
  stable_deleted_target_rows: number;
  active_source_rows: number;
  split_target_rows: number;
  source_renamed_aliases: number;
  target_deleted_aliases: number;
  split_aliases: number;
  current_relations: number;
}

async function auditInterleavedIdentityState(
  client: postgres.Sql,
  schema: string,
  corpId: string,
  sourceUserid: string,
  targetUserid: string,
  stableMemberId: number,
): Promise<AuditInterleavedIdentityState> {
  assertAuditSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const rows = await tx<AuditInterleavedIdentityState[]>`
      SELECT
        (SELECT count(*)::integer FROM work_member_current
          WHERE corp_id = ${corpId}
            AND userid IN (${sourceUserid}, ${targetUserid})) AS pair_current_rows,
        (SELECT count(*)::integer FROM work_member_current
          WHERE corp_id = ${corpId} AND id = ${stableMemberId}) AS stable_current_rows,
        (SELECT count(*)::integer FROM work_member_current
          WHERE corp_id = ${corpId} AND id = ${stableMemberId}
            AND userid = ${targetUserid} AND canonical_userid = ${targetUserid}
            AND lifecycle_state = 'DELETED' AND enable = 0 AND status = 5) AS stable_deleted_target_rows,
        (SELECT count(*)::integer FROM work_member_current
          WHERE corp_id = ${corpId} AND userid = ${sourceUserid}
            AND lifecycle_state = 'ACTIVE') AS active_source_rows,
        (SELECT count(*)::integer FROM work_member_current
          WHERE corp_id = ${corpId} AND userid = ${targetUserid}
            AND id <> ${stableMemberId}) AS split_target_rows,
        (SELECT count(*)::integer FROM work_member_identity_alias
          WHERE corp_id = ${corpId} AND userid = ${sourceUserid}
            AND member_id = ${stableMemberId} AND canonical_userid = ${targetUserid}
            AND lifecycle_state = 'RENAMED') AS source_renamed_aliases,
        (SELECT count(*)::integer FROM work_member_identity_alias
          WHERE corp_id = ${corpId} AND userid = ${targetUserid}
            AND member_id = ${stableMemberId} AND canonical_userid = ${targetUserid}
            AND lifecycle_state = 'DELETED') AS target_deleted_aliases,
        (SELECT count(*)::integer FROM work_member_identity_alias
          WHERE corp_id = ${corpId}
            AND userid IN (${sourceUserid}, ${targetUserid})
            AND member_id IS DISTINCT FROM ${stableMemberId}) AS split_aliases,
        (SELECT count(*)::integer FROM work_member_relation_current
          WHERE corp_id = ${corpId} AND member_id = ${stableMemberId}) AS current_relations
    `;
    const state = rows[0];
    if (!state) throw new Error("interleaved identity audit returned no state");
    return state;
  });
}

interface AuditRenameChainState {
  chain_current_rows: number;
  stable_current_rows: number;
  stable_deleted_target_rows: number;
  active_predecessor_rows: number;
  split_current_rows: number;
  source_renamed_aliases: number;
  middle_renamed_aliases: number;
  target_deleted_aliases: number;
  split_aliases: number;
  current_relations: number;
}

async function auditRenameChainState(
  client: postgres.Sql,
  schema: string,
  corpId: string,
  sourceUserid: string,
  middleUserid: string,
  targetUserid: string,
  stableMemberId: number,
): Promise<AuditRenameChainState> {
  assertAuditSchema(schema);
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const identities = [sourceUserid, middleUserid, targetUserid];
    const rows = await tx<AuditRenameChainState[]>`
      SELECT
        (SELECT count(*)::integer FROM work_member_current
          WHERE corp_id = ${corpId} AND userid IN ${tx(identities)}) AS chain_current_rows,
        (SELECT count(*)::integer FROM work_member_current
          WHERE corp_id = ${corpId} AND id = ${stableMemberId}) AS stable_current_rows,
        (SELECT count(*)::integer FROM work_member_current
          WHERE corp_id = ${corpId} AND id = ${stableMemberId}
            AND userid = ${targetUserid} AND canonical_userid = ${targetUserid}
            AND lifecycle_state = 'DELETED' AND enable = 0 AND status = 5) AS stable_deleted_target_rows,
        (SELECT count(*)::integer FROM work_member_current
          WHERE corp_id = ${corpId} AND userid IN (${sourceUserid}, ${middleUserid})
            AND lifecycle_state = 'ACTIVE') AS active_predecessor_rows,
        (SELECT count(*)::integer FROM work_member_current
          WHERE corp_id = ${corpId} AND userid IN ${tx(identities)}
            AND id <> ${stableMemberId}) AS split_current_rows,
        (SELECT count(*)::integer FROM work_member_identity_alias
          WHERE corp_id = ${corpId} AND userid = ${sourceUserid}
            AND member_id = ${stableMemberId}
            AND lifecycle_state = 'RENAMED') AS source_renamed_aliases,
        (SELECT count(*)::integer FROM work_member_identity_alias
          WHERE corp_id = ${corpId} AND userid = ${middleUserid}
            AND member_id = ${stableMemberId} AND canonical_userid = ${targetUserid}
            AND lifecycle_state = 'RENAMED') AS middle_renamed_aliases,
        (SELECT count(*)::integer FROM work_member_identity_alias
          WHERE corp_id = ${corpId} AND userid = ${targetUserid}
            AND member_id = ${stableMemberId} AND canonical_userid = ${targetUserid}
            AND lifecycle_state = 'DELETED') AS target_deleted_aliases,
        (SELECT count(*)::integer FROM work_member_identity_alias
          WHERE corp_id = ${corpId} AND userid IN ${tx(identities)}
            AND member_id IS DISTINCT FROM ${stableMemberId}) AS split_aliases,
        (SELECT count(*)::integer FROM work_member_relation_current
          WHERE corp_id = ${corpId} AND member_id = ${stableMemberId}) AS current_relations
    `;
    const state = rows[0];
    if (!state) throw new Error("rename chain audit returned no state");
    return state;
  });
}

async function auditStaleLineageReviewerScenario(
  service: Pick<EnterpriseWechatCallbackService, "processMessage">,
  provider: ReturnType<typeof createAuditProviderController>,
  client: postgres.Sql,
  schema: string,
  corpId: string,
  label: "lineage-update" | "lineage-delete",
  baseTime: number,
  targetAction: "update_user" | "delete_user",
): Promise<{ outcomes: Record<string, string>; passed: boolean }> {
  const sourceUserid = `${label}-a`;
  const middleUserid = `${label}-b`;
  const targetUserid = `${label}-c`;
  const results: Record<string, string> = {};

  provider.enqueue(sourceUserid, auditProviderSnapshot(sourceUserid, {
    name: "Lineage Source Created",
  }));
  const createMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: baseTime,
    changeType: "create_user",
    userid: sourceUserid,
  });
  results[`${label}_create`] = await service.processMessage(createMessage) as string;
  const sourceCreated = await auditServiceMemberState(
    client,
    schema,
    corpId,
    sourceUserid,
  );
  const sourceStableMemberId = sourceCreated.member?.id ?? 0;

  const deferredOriginalRename = deferredAuditProviderOutcome();
  provider.enqueue(middleUserid, deferredOriginalRename.outcome);
  const originalRenameMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: baseTime + 10,
    changeType: "update_user",
    userid: sourceUserid,
    newUserid: middleUserid,
  });
  const originalRenameProcess = service.processMessage(originalRenameMessage);
  let originalRenameReleased = false;
  try {
    await boundedAuditWait(
      deferredOriginalRename.started,
      `${label} original rename provider did not start`,
    );

    provider.enqueue(sourceUserid, auditProviderSnapshot(sourceUserid, {
      name: "Lineage Source Reused",
    }));
    const sourceReuseMessage = await insertAuditServiceEvent(client, schema, {
      corpId,
      eventTime: baseTime + 30,
      changeType: "update_user",
      userid: sourceUserid,
    });
    results[`${label}_source_reuse`] = await service.processMessage(
      sourceReuseMessage,
    ) as string;

    const targetProviderCallsBefore = {
      factory: provider.factoryCallCount(),
      directory: provider.directoryCallCount(),
    };
    if (targetAction === "update_user") {
      provider.enqueue(targetUserid, auditProviderSnapshot(targetUserid, {
        name: "Lineage Target First Update",
      }));
    }
    const targetFirstMessage = await insertAuditServiceEvent(client, schema, {
      corpId,
      eventTime: baseTime + 40,
      changeType: targetAction,
      userid: targetUserid,
    });
    results[`${label}_target_first`] = await service.processMessage(
      targetFirstMessage,
    ) as string;
    const targetProviderDelta = {
      factory: provider.factoryCallCount() - targetProviderCallsBefore.factory,
      directory: provider.directoryCallCount() - targetProviderCallsBefore.directory,
    };
    const sourceBeforeStaleEdge = await auditServiceMemberState(
      client,
      schema,
      corpId,
      sourceUserid,
    );
    const middleBeforeStaleEdge = await auditServiceMemberState(
      client,
      schema,
      corpId,
      middleUserid,
    );
    const targetBeforeStaleEdge = await auditServiceMemberState(
      client,
      schema,
      corpId,
      targetUserid,
    );
    const targetStableMemberId = targetBeforeStaleEdge.member?.id ?? 0;
    const digestBeforeStaleEdge = await auditServiceBusinessDigest(
      client,
      schema,
      corpId,
    );

    provider.enqueue(targetUserid, auditProviderSnapshot(targetUserid, {
      name: "Stale Lineage Edge Must Not Fetch",
    }));
    const staleEdgeProviderCallsBefore = {
      factory: provider.factoryCallCount(),
      directory: provider.directoryCallCount(),
    };
    const staleEdgeMessage = await insertAuditServiceEvent(client, schema, {
      corpId,
      eventTime: baseTime + 20,
      changeType: "update_user",
      userid: middleUserid,
      newUserid: targetUserid,
    });
    results[`${label}_stale_edge`] = await service.processMessage(staleEdgeMessage) as string;
    const staleEdgeUsedNoProvider =
      provider.factoryCallCount() === staleEdgeProviderCallsBefore.factory
      && provider.directoryCallCount() === staleEdgeProviderCallsBefore.directory;
    const digestAfterStaleEdge = await auditServiceBusinessDigest(
      client,
      schema,
      corpId,
    );
    const staleEdgeEventState = await auditServiceEventState(
      client,
      schema,
      staleEdgeMessage.eventId,
    );

    deferredOriginalRename.resolve(auditProviderSnapshot(middleUserid, {
      name: "Stale Original Rename",
    }));
    originalRenameReleased = true;
    results[`${label}_original_rename`] = await boundedAuditWait(
      originalRenameProcess,
      `${label} original rename did not finish`,
    ) as string;
    const originalRenameEventState = await auditServiceEventState(
      client,
      schema,
      originalRenameMessage.eventId,
    );
    const sourceFinal = await auditServiceMemberState(
      client,
      schema,
      corpId,
      sourceUserid,
    );
    const targetFinal = await auditServiceMemberState(
      client,
      schema,
      corpId,
      targetUserid,
    );
    const sourceAlias = sourceFinal.aliases.find((row) => row.userid === sourceUserid);
    const pendingMiddleAlias = sourceFinal.aliases.find((row) => row.userid === middleUserid)
      ?? middleBeforeStaleEdge.aliases.find((row) => row.userid === middleUserid);
    const targetAlias = targetFinal.aliases.find((row) => row.userid === targetUserid);
    const targetStatePreserved = targetAction === "update_user"
      ? targetProviderDelta.factory === 1
        && targetProviderDelta.directory === 1
        && targetStableMemberId > 0
        && targetStableMemberId !== sourceStableMemberId
        && targetFinal.member?.id === targetStableMemberId
        && targetFinal.member.lifecycle_state === "ACTIVE"
        && targetAlias?.member_id === targetStableMemberId
        && targetAlias.canonical_userid === targetUserid
        && targetAlias.lifecycle_state === "ACTIVE"
      : targetProviderDelta.factory === 0
        && targetProviderDelta.directory === 0
        && targetBeforeStaleEdge.member === null
        && targetFinal.member === null
        && targetFinal.aliases.length === 1
        && targetAlias?.member_id === null
        && targetAlias.canonical_userid === targetUserid
        && targetAlias.lifecycle_state === "DELETED";

    return {
      outcomes: results,
      passed:
        results[`${label}_create`] === "applied"
        && results[`${label}_source_reuse`] === "applied"
        && results[`${label}_target_first`] === (
          targetAction === "update_user" ? "applied" : "applied-noop"
        )
        && results[`${label}_stale_edge`] === "superseded"
        && results[`${label}_original_rename`] === "superseded"
        && sourceStableMemberId > 0
        && sourceBeforeStaleEdge.member?.id === sourceStableMemberId
        && sourceBeforeStaleEdge.member.lifecycle_state === "ACTIVE"
        && sourceFinal.member?.id === sourceStableMemberId
        && sourceFinal.member.userid === sourceUserid
        && sourceFinal.member.lifecycle_state === "ACTIVE"
        && sourceAlias?.member_id === sourceStableMemberId
        && sourceAlias.canonical_userid === sourceUserid
        && sourceAlias.lifecycle_state === "ACTIVE"
        && pendingMiddleAlias?.member_id === sourceStableMemberId
        && pendingMiddleAlias.canonical_userid === sourceUserid
        && pendingMiddleAlias.lifecycle_state === "UNRESOLVED"
        && middleBeforeStaleEdge.member === null
        && staleEdgeUsedNoProvider
        && digestBeforeStaleEdge === digestAfterStaleEdge
        && staleEdgeEventState?.status === "ORDERED"
        && staleEdgeEventState.projection_status === "SUPERSEDED"
        && staleEdgeEventState.outbox_status === "COMPLETED"
        && staleEdgeEventState.watermark_count === 0
        && originalRenameEventState?.status === "ORDERED"
        && originalRenameEventState.projection_status === "SUPERSEDED"
        && originalRenameEventState.outbox_status === "COMPLETED"
        && targetStatePreserved,
    };
  } finally {
    if (!originalRenameReleased) {
      deferredOriginalRename.resolve(auditProviderSnapshot(middleUserid, {
        name: "Stale Original Rename Cleanup",
      }));
      await Promise.allSettled([originalRenameProcess]);
    }
  }
}

async function auditResolvedForwardRenameScenario(
  service: Pick<EnterpriseWechatCallbackService, "processMessage">,
  provider: ReturnType<typeof createAuditProviderController>,
  client: postgres.Sql,
  schema: string,
  corpId: string,
  label: "resolved-forward-update" | "resolved-forward-delete",
  baseTime: number,
  targetAction: "update_user" | "delete_user",
): Promise<{
  outcomes: Record<string, string>;
  diagnostics: Record<string, boolean>;
  terminal_error_codes: {
    event: string;
    outbox: string;
  };
  passed: boolean;
}> {
  const sourceUserid = `${label}-a`;
  const middleUserid = `${label}-b`;
  const targetUserid = `${label}-c`;
  const results: Record<string, string> = {};

  provider.enqueue(sourceUserid, auditProviderSnapshot(sourceUserid, {
    name: "Resolved Forward Stable Source",
  }));
  const createMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: baseTime,
    changeType: "create_user",
    userid: sourceUserid,
  });
  results[`${label}_create`] = await service.processMessage(createMessage) as string;
  const sourceCreated = await auditServiceMemberState(
    client,
    schema,
    corpId,
    sourceUserid,
  );
  const stableMemberId = sourceCreated.member?.id ?? 0;

  provider.enqueue(targetUserid, auditProviderSnapshot(targetUserid, {
    name: "Resolved Forward Rename Target",
  }));
  const resolvedRenameMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: baseTime + 20,
    changeType: "update_user",
    userid: middleUserid,
    newUserid: targetUserid,
  });
  results[`${label}_resolved_rename`] = await service.processMessage(
    resolvedRenameMessage,
  ) as string;

  const targetProviderCallsBefore = {
    factory: provider.factoryCallCount(),
    directory: provider.directoryCallCount(),
  };
  if (targetAction === "update_user") {
    provider.enqueue(targetUserid, auditProviderSnapshot(targetUserid, {
      name: "Resolved Forward Latest Target",
      mobile: "+6598765432",
      main_department: 17,
      department: [17],
      order: [123],
      is_leader_in_dept: [1],
      extattr: { stage: "resolved-forward-latest" },
      external_profile: { stage: "resolved-forward-latest" },
    }));
  }
  const targetMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: baseTime + 30,
    changeType: targetAction,
    userid: targetUserid,
  });
  results[`${label}_target_terminal`] = await service.processMessage(targetMessage) as string;
  const targetEventState = await auditServiceEventState(
    client,
    schema,
    targetMessage.eventId,
  );
  const targetProviderDelta = {
    factory: provider.factoryCallCount() - targetProviderCallsBefore.factory,
    directory: provider.directoryCallCount() - targetProviderCallsBefore.directory,
  };
  const targetBeforeOlderRename = await auditServiceMemberState(
    client,
    schema,
    corpId,
    targetUserid,
  );
  const provisionalTargetMemberId = targetBeforeOlderRename.member?.id ?? 0;

  const olderRenameProviderCallsBefore = {
    factory: provider.factoryCallCount(),
    directory: provider.directoryCallCount(),
  };
  const olderRenameMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: baseTime + 10,
    changeType: "update_user",
    userid: sourceUserid,
    newUserid: middleUserid,
  });
  results[`${label}_older_predecessor_rename`] = await service.processMessage(
    olderRenameMessage,
  ) as string;
  const olderRenameUsedNoProvider =
    provider.factoryCallCount() === olderRenameProviderCallsBefore.factory
    && provider.directoryCallCount() === olderRenameProviderCallsBefore.directory;

  const finalTarget = await auditServiceMemberState(
    client,
    schema,
    corpId,
    targetUserid,
  );
  const finalChain = await auditRenameChainState(
    client,
    schema,
    corpId,
    sourceUserid,
    middleUserid,
    targetUserid,
    stableMemberId,
  );
  const olderRenameEventState = await auditServiceEventState(
    client,
    schema,
    olderRenameMessage.eventId,
  );
  const sourceAlias = finalTarget.aliases.find((row) => row.userid === sourceUserid);
  const middleAlias = finalTarget.aliases.find((row) => row.userid === middleUserid);
  const targetAlias = finalTarget.aliases.find((row) => row.userid === targetUserid);
  const providerBehaviorExact = targetAction === "update_user"
    ? targetProviderDelta.factory === 1 && targetProviderDelta.directory === 1
    : targetProviderDelta.factory === 0 && targetProviderDelta.directory === 0;
  const targetStateExact = targetAction === "update_user"
    ? finalTarget.member?.lifecycle_state === "ACTIVE"
      && finalTarget.member.name === "Resolved Forward Latest Target"
      && finalTarget.member.mobile === "+6598765432"
      && finalTarget.other?.extattr === '{"stage":"resolved-forward-latest"}'
      && finalTarget.other.external_profile === '{"stage":"resolved-forward-latest"}'
      && finalTarget.relations.length === 1
      && finalTarget.relations[0]?.department_id === 17
      && finalTarget.relations[0].sort_order === "123"
      && finalTarget.relations[0].is_leader_in_dept === 1
      && targetAlias?.lifecycle_state === "ACTIVE"
      && finalChain.current_relations === 1
    : finalTarget.member?.lifecycle_state === "DELETED"
      && finalTarget.member.enable === 0
      && finalTarget.member.status === 5
      && finalTarget.relations.length === 0
      && targetAlias?.lifecycle_state === "DELETED"
      && finalChain.stable_deleted_target_rows === 1
      && finalChain.target_deleted_aliases === 1
      && finalChain.current_relations === 0;

  const diagnostics = {
    create_applied: results[`${label}_create`] === "applied",
    resolved_rename_applied: results[`${label}_resolved_rename`] === "applied",
    target_terminal_applied: results[`${label}_target_terminal`] === "applied",
    older_predecessor_rename_superseded:
      results[`${label}_older_predecessor_rename`] === "superseded",
    provider_behavior_exact: providerBehaviorExact,
    older_rename_used_no_provider: olderRenameUsedNoProvider,
    provisional_and_stable_ids_distinct:
      stableMemberId > 0
      && provisionalTargetMemberId > 0
      && provisionalTargetMemberId !== stableMemberId,
    final_current_uses_stable_id:
      finalTarget.member?.id === stableMemberId
      && finalTarget.member.userid === targetUserid
      && finalTarget.member.canonical_userid === targetUserid,
    exactly_one_current:
      finalChain.chain_current_rows === 1
      && finalChain.stable_current_rows === 1
      && finalChain.active_predecessor_rows === 0
      && finalChain.split_current_rows === 0,
    aliases_share_stable_identity:
      finalChain.source_renamed_aliases === 1
      && finalChain.middle_renamed_aliases === 1
      && finalChain.split_aliases === 0
      && finalTarget.aliases.length === 3
      && sourceAlias?.member_id === stableMemberId
      && sourceAlias.canonical_userid === middleUserid
      && sourceAlias.lifecycle_state === "RENAMED"
      && sourceAlias.link_event_id === olderRenameMessage.eventId
      && sourceAlias.link_event_time === baseTime + 10
      && middleAlias?.member_id === stableMemberId
      && middleAlias.canonical_userid === targetUserid
      && middleAlias.lifecycle_state === "RENAMED"
      && middleAlias.link_event_id === resolvedRenameMessage.eventId
      && middleAlias.link_event_time === baseTime + 20
      && targetAlias?.member_id === stableMemberId
      && targetAlias.canonical_userid === targetUserid
      && targetAlias.link_event_id === null,
    event_terminal_exact:
      olderRenameEventState?.status === "ORDERED"
      && olderRenameEventState.projection_status === "SUPERSEDED"
      && olderRenameEventState.outbox_status === "COMPLETED",
    target_state_exact: targetStateExact,
  };

  return {
    outcomes: results,
    diagnostics,
    terminal_error_codes: {
      event: targetEventState?.event_last_error_code ?? "missing_event_state",
      outbox: targetEventState?.outbox_last_error_code ?? "missing_event_state",
    },
    passed: Object.values(diagnostics).every(Boolean),
  };
}

async function auditContaminatedResolvedForwardScenario(
  service: Pick<EnterpriseWechatCallbackService, "processMessage">,
  provider: ReturnType<typeof createAuditProviderController>,
  client: postgres.Sql,
  schema: string,
  corpId: string,
  label: string,
  baseTime: number,
  historicalAction: "update_user" | "delete_user",
) {
  const sourceUserid = `${label}-a`;
  const middleUserid = `${label}-b`;
  const targetUserid = `${label}-c`;
  const outcomes: Record<string, string> = {};

  provider.enqueue(sourceUserid, auditProviderSnapshot(sourceUserid, {
    name: "Contaminated Fence Stable Source",
  }));
  const createMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: baseTime,
    changeType: "create_user",
    userid: sourceUserid,
  });
  outcomes.create = await service.processMessage(createMessage) as string;
  const sourceCreated = await auditServiceMemberState(
    client, schema, corpId, sourceUserid,
  );
  const stableMemberId = sourceCreated.member?.id ?? 0;

  provider.enqueue(targetUserid, auditProviderSnapshot(targetUserid, {
    name: "Contaminated Fence Independent Target",
  }));
  const resolvedMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: baseTime + 20,
    changeType: "update_user",
    userid: middleUserid,
    newUserid: targetUserid,
  });
  outcomes.resolved = await service.processMessage(resolvedMessage) as string;
  const targetCreated = await auditServiceMemberState(
    client, schema, corpId, targetUserid,
  );
  const provisionalMemberId = targetCreated.member?.id ?? 0;

  const historicalProviderBefore = {
    factory: provider.factoryCallCount(),
    directory: provider.directoryCallCount(),
  };
  if (historicalAction === "update_user") {
    provider.enqueue(middleUserid, auditProviderSnapshot(middleUserid, {
      name: "Historical UserID Must Stay Superseded",
    }));
  }
  const historicalMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: baseTime + 50,
    changeType: historicalAction,
    userid: middleUserid,
  });
  outcomes.historical = await service.processMessage(historicalMessage) as string;
  const historicalProviderDelta = {
    factory: provider.factoryCallCount() - historicalProviderBefore.factory,
    directory: provider.directoryCallCount() - historicalProviderBefore.directory,
  };
  const historicalEventState = await auditServiceEventState(
    client, schema, historicalMessage.eventId,
  );
  const beforeRejectedRename = await auditServiceMemberState(
    client, schema, corpId, targetUserid,
  );
  const middleBefore = beforeRejectedRename.aliases.find(
    (alias) => alias.userid === middleUserid,
  );
  const projectionDigestBefore = await auditFullMemberProjectionDigest(
    client, schema, corpId,
  );

  const rejectedProviderBefore = {
    factory: provider.factoryCallCount(),
    directory: provider.directoryCallCount(),
  };
  const rejectedMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: baseTime + 30,
    changeType: "update_user",
    userid: sourceUserid,
    newUserid: middleUserid,
  });
  outcomes.rejected = await service.processMessage(rejectedMessage) as string;
  const rejectedUsedNoProvider =
    provider.factoryCallCount() === rejectedProviderBefore.factory
    && provider.directoryCallCount() === rejectedProviderBefore.directory;
  const rejectedEventState = await auditServiceEventState(
    client, schema, rejectedMessage.eventId,
  );
  const projectionDigestAfter = await auditFullMemberProjectionDigest(
    client, schema, corpId,
  );
  const sourceFinal = await auditServiceMemberState(
    client, schema, corpId, sourceUserid,
  );
  const targetFinal = await auditServiceMemberState(
    client, schema, corpId, targetUserid,
  );
  const counts = await auditServiceBusinessCounts(client, schema, corpId);
  const sourceAlias = sourceFinal.aliases.find((alias) => alias.userid === sourceUserid);
  const middleAlias = targetFinal.aliases.find((alias) => alias.userid === middleUserid);
  const targetAlias = targetFinal.aliases.find((alias) => alias.userid === targetUserid);
  const historicalProviderExact = historicalAction === "update_user"
    ? historicalProviderDelta.factory === 1 && historicalProviderDelta.directory === 1
    : historicalProviderDelta.factory === 0 && historicalProviderDelta.directory === 0;
  const expectedHistoricalRank = historicalAction === "update_user" ? 50 : 100;

  const diagnostics = {
    setup_exact:
      outcomes.create === "applied"
      && outcomes.resolved === "applied"
      && stableMemberId > 0
      && provisionalMemberId > 0
      && stableMemberId !== provisionalMemberId,
    historical_callback_superseded:
      outcomes.historical === "superseded"
      && historicalProviderExact
      && historicalEventState?.status === "ORDERED"
      && historicalEventState.projection_status === "SUPERSEDED"
      && historicalEventState.outbox_status === "COMPLETED"
      && historicalEventState.watermark_count === 1
      && historicalEventState.event_attempt_count === 1
      && historicalEventState.outbox_attempt_count === 1
      && historicalEventState.event_last_error_code === ""
      && historicalEventState.outbox_last_error_code === "",
    immutable_edge_preserved_while_latest_seen_advances:
      middleBefore?.lifecycle_state === "RENAMED"
      && middleBefore.canonical_userid === targetUserid
      && middleBefore.member_id === provisionalMemberId
      && middleBefore.last_event_id === historicalMessage.eventId
      && middleBefore.last_event_time === baseTime + 50
      && middleBefore.last_sequence_rank === expectedHistoricalRank
      && middleBefore.link_event_id === resolvedMessage.eventId
      && middleBefore.link_event_time === baseTime + 20
      && middleBefore.link_sequence_rank === 50,
    reversed_edge_quarantined_before_provider:
      outcomes.rejected === "dead"
      && rejectedUsedNoProvider
      && rejectedEventState?.status === "DEAD"
      && rejectedEventState.projection_status === "DEAD"
      && rejectedEventState.outbox_status === "DEAD"
      && rejectedEventState.watermark_count === 0
      && rejectedEventState.event_attempt_count === 1
      && rejectedEventState.outbox_attempt_count === 1
      && rejectedEventState.event_last_error_code
        === "callback_member_resolved_rename_order_conflict"
      && rejectedEventState.outbox_last_error_code
        === "callback_member_resolved_rename_order_conflict",
    rejected_edge_projection_transaction_unchanged:
      projectionDigestBefore === projectionDigestAfter,
    two_identity_components_remain_separate:
      counts.members === 2
      && counts.aliases === 3
      && sourceFinal.member?.id === stableMemberId
      && sourceFinal.member.userid === sourceUserid
      && sourceFinal.member.lifecycle_state === "ACTIVE"
      && sourceAlias?.member_id === stableMemberId
      && sourceAlias.canonical_userid === sourceUserid
      && sourceAlias.lifecycle_state === "ACTIVE"
      && sourceAlias.link_event_id === null
      && targetFinal.member?.id === provisionalMemberId
      && targetFinal.member.userid === targetUserid
      && targetFinal.member.lifecycle_state === "ACTIVE"
      && middleAlias?.member_id === provisionalMemberId
      && middleAlias.canonical_userid === targetUserid
      && middleAlias.lifecycle_state === "RENAMED"
      && middleAlias.link_event_id === resolvedMessage.eventId
      && targetAlias?.member_id === provisionalMemberId
      && targetAlias.canonical_userid === targetUserid
      && targetAlias.lifecycle_state === "ACTIVE",
  };
  return {
    outcomes,
    diagnostics,
    passed: Object.values(diagnostics).every(Boolean),
  };
}

async function auditResolvedForwardRollbackScenario(
  service: Pick<EnterpriseWechatCallbackService, "processMessage">,
  provider: ReturnType<typeof createAuditProviderController>,
  client: postgres.Sql,
  schema: string,
  corpId: string,
  baseTime: number,
) {
  const sourceUserid = "resolved-forward-rollback-a";
  const middleUserid = "resolved-forward-rollback-b";
  const targetUserid = "resolved-forward-rollback-c";
  const outcomes: Record<string, string> = {};

  provider.enqueue(sourceUserid, auditProviderSnapshot(sourceUserid, {
    name: "Rollback Stable Source",
  }));
  const createMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: baseTime,
    changeType: "create_user",
    userid: sourceUserid,
  });
  outcomes.create = await service.processMessage(createMessage) as string;
  const sourceCreated = await auditServiceMemberState(
    client, schema, corpId, sourceUserid,
  );
  const stableMemberId = sourceCreated.member?.id ?? 0;

  provider.enqueue(targetUserid, auditProviderSnapshot(targetUserid, {
    name: "Rollback Independent Target",
  }));
  const resolvedMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: baseTime + 20,
    changeType: "update_user",
    userid: middleUserid,
    newUserid: targetUserid,
  });
  outcomes.resolved = await service.processMessage(resolvedMessage) as string;
  const targetCreated = await auditServiceMemberState(
    client, schema, corpId, targetUserid,
  );
  const provisionalMemberId = targetCreated.member?.id ?? 0;

  await client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_temp`);
    const updated = await tx<Array<{ id: number }>>`
      UPDATE work_member_current
      SET uid = CASE WHEN id = ${stableMemberId} THEN 101 ELSE 202 END
      WHERE corp_id = ${corpId} AND id IN (${stableMemberId}, ${provisionalMemberId})
      RETURNING id
    `;
    if (updated.length !== 2) throw new Error("rollback stable-link fixture update failed");
  });
  const projectionDigestBefore = await auditFullMemberProjectionDigest(
    client, schema, corpId,
  );
  const providerBefore = {
    factory: provider.factoryCallCount(),
    directory: provider.directoryCallCount(),
  };
  const conflictingMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: baseTime + 10,
    changeType: "update_user",
    userid: sourceUserid,
    newUserid: middleUserid,
  });
  outcomes.conflict = await service.processMessage(conflictingMessage) as string;
  const usedNoProvider = provider.factoryCallCount() === providerBefore.factory
    && provider.directoryCallCount() === providerBefore.directory;
  const eventState = await auditServiceEventState(
    client, schema, conflictingMessage.eventId,
  );
  const projectionDigestAfter = await auditFullMemberProjectionDigest(
    client, schema, corpId,
  );
  const sourceFinal = await auditServiceMemberState(
    client, schema, corpId, sourceUserid,
  );
  const targetFinal = await auditServiceMemberState(
    client, schema, corpId, targetUserid,
  );
  const counts = await auditServiceBusinessCounts(client, schema, corpId);
  const sourceAlias = sourceFinal.aliases.find((alias) => alias.userid === sourceUserid);
  const middleAlias = targetFinal.aliases.find((alias) => alias.userid === middleUserid);
  const targetAlias = targetFinal.aliases.find((alias) => alias.userid === targetUserid);

  const diagnostics = {
    setup_exact:
      outcomes.create === "applied"
      && outcomes.resolved === "applied"
      && stableMemberId > 0
      && provisionalMemberId > 0
      && stableMemberId !== provisionalMemberId,
    post_mutation_failure_recorded_exactly:
      outcomes.conflict === "dead"
      && usedNoProvider
      && eventState?.status === "DEAD"
      && eventState.projection_status === "DEAD"
      && eventState.outbox_status === "DEAD"
      && eventState.watermark_count === 0
      && eventState.event_attempt_count === 1
      && eventState.outbox_attempt_count === 1
      && eventState.event_last_error_code === "callback_member_stable_link_conflict"
      && eventState.outbox_last_error_code === "callback_member_stable_link_conflict",
    complete_projection_transaction_rolled_back:
      projectionDigestBefore === projectionDigestAfter,
    root_alias_mutation_rolled_back:
      sourceAlias?.member_id === stableMemberId
      && sourceAlias.canonical_userid === sourceUserid
      && sourceAlias.lifecycle_state === "ACTIVE"
      && sourceAlias.link_event_id === null,
    resolved_component_unchanged:
      middleAlias?.member_id === provisionalMemberId
      && middleAlias.canonical_userid === targetUserid
      && middleAlias.lifecycle_state === "RENAMED"
      && middleAlias.link_event_id === resolvedMessage.eventId
      && middleAlias.link_event_time === baseTime + 20
      && targetAlias?.member_id === provisionalMemberId
      && targetAlias.canonical_userid === targetUserid
      && targetAlias.lifecycle_state === "ACTIVE"
      && targetAlias.link_event_id === null,
    two_currents_and_distinct_stable_links_preserved:
      counts.members === 2
      && counts.aliases === 3
      && sourceFinal.member?.id === stableMemberId
      && sourceFinal.member.userid === sourceUserid
      && sourceFinal.member.lifecycle_state === "ACTIVE"
      && sourceFinal.member.uid === 101
      && targetFinal.member?.id === provisionalMemberId
      && targetFinal.member.userid === targetUserid
      && targetFinal.member.lifecycle_state === "ACTIVE"
      && targetFinal.member.uid === 202,
  };
  return {
    outcomes,
    diagnostics,
    passed: Object.values(diagnostics).every(Boolean),
  };
}

async function enterpriseWechatMemberServiceScenario(
  container: ReturnType<typeof createContainerFromDb>,
  client: postgres.Sql,
  schema: string,
) {
  const corpId = "auditservice";
  const provider = createAuditProviderController();
  const service = new EnterpriseWechatCallbackService(
    container,
    {
      ORDER_QUEUE: noDispatchAuditQueue(),
      WECHAT_WORK_MEMBER_CURRENT_AUTHORITY: "verified",
    },
    provider.factory,
  );
  const outcomes: Record<string, string> = {};

  const authorityDisabledProvider = createAuditProviderController();
  const authorityQueue = createAuditQueueCapture();
  authorityDisabledProvider.enqueue(
    "authority-disabled",
    auditProviderSnapshot("authority-disabled", { name: "Authority Disabled" }),
  );
  const authorityDisabledService = new EnterpriseWechatCallbackService(
    container,
    { ORDER_QUEUE: authorityQueue.queue },
    authorityDisabledProvider.factory,
  );
  const countsBeforeAuthorityDisabled = await auditServiceBusinessCounts(
    client,
    schema,
    corpId,
  );
  const authorityDisabledMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 900,
    changeType: "update_user",
    userid: "authority-disabled",
  });
  const authorityDisabledDispatch = await authorityDisabledService.dispatchById(
    authorityDisabledMessage.outboxId,
  );
  const authorityFirstQueueMessage = authorityQueue.take();
  const authorityFirstQueueIdentityMatches = sameJson(
    authorityFirstQueueMessage,
    authorityDisabledMessage,
  );
  const authorityFirstConsume = await consumeAuditQueueMessage(
    authorityFirstQueueMessage,
    authorityDisabledService,
  );
  outcomes.authority_disabled_parked = authorityFirstConsume.outcome;
  const countsAfterAuthorityParked = await auditServiceBusinessCounts(
    client,
    schema,
    corpId,
  );
  const authorityParkedMember = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "authority-disabled",
  );
  const authorityParkedEventState = await auditServiceEventState(
    client,
    schema,
    authorityDisabledMessage.eventId,
  );
  const authorityRepeatConsume = await consumeAuditQueueMessage(
    authorityFirstQueueMessage,
    authorityDisabledService,
  );
  outcomes.authority_disabled_reparked = authorityRepeatConsume.outcome;
  const authorityParkedActorBlocked = await auditPendingActorBlocked(
    container,
    corpId,
    "authority-disabled",
  );
  const authorityProviderCallsAfterPark = {
    factory: authorityDisabledProvider.factoryCallCount(),
    directory: authorityDisabledProvider.directoryCallCount(),
  };
  const authorityDisabledDispatchPages = await authorityDisabledService.dispatchPendingPages(20, 5);
  const authorityVerifiedService = new EnterpriseWechatCallbackService(
    container,
    {
      ORDER_QUEUE: authorityQueue.queue,
      WECHAT_WORK_MEMBER_CURRENT_AUTHORITY: "verified",
    },
    authorityDisabledProvider.factory,
  );
  const authorityVerifiedDispatchPages = await authorityVerifiedService.dispatchPendingPages(20, 5);
  const authorityReplayQueueMessage = authorityQueue.take();
  const authorityReplayQueueIdentityMatches = sameJson(
    authorityReplayQueueMessage,
    authorityDisabledMessage,
  );
  const authorityReplayConsume = await consumeAuditQueueMessage(
    authorityReplayQueueMessage,
    authorityVerifiedService,
  );
  outcomes.authority_verified_retry = authorityReplayConsume.outcome;
  const authorityVerifiedMember = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "authority-disabled",
  );
  const authorityVerifiedEventState = await auditServiceEventState(
    client,
    schema,
    authorityDisabledMessage.eventId,
  );

  const authorityFactoryCallsBeforeDelete = authorityDisabledProvider.factoryCallCount();
  const authorityDirectoryCallsBeforeDelete = authorityDisabledProvider.directoryCallCount();
  const authorityDisabledDeleteMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 910,
    changeType: "delete_user",
    userid: "authority-disabled",
  });
  const authorityDeleteDispatch = await authorityDisabledService.dispatchById(
    authorityDisabledDeleteMessage.outboxId,
  );
  const authorityDeleteQueueMessage = authorityQueue.take();
  const authorityDeleteQueueIdentityMatches = sameJson(
    authorityDeleteQueueMessage,
    authorityDisabledDeleteMessage,
  );
  const authorityDeleteConsume = await consumeAuditQueueMessage(
    authorityDeleteQueueMessage,
    authorityDisabledService,
  );
  outcomes.authority_disabled_delete = authorityDeleteConsume.outcome;
  const authorityDisabledDeleted = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "authority-disabled",
  );
  const authorityDisabledDeleteEventState = await auditServiceEventState(
    client,
    schema,
    authorityDisabledDeleteMessage.eventId,
  );
  const authorityDisabledDeleteUsedNoProvider =
    authorityDisabledProvider.factoryCallCount() === authorityFactoryCallsBeforeDelete
    && authorityDisabledProvider.directoryCallCount() === authorityDirectoryCallsBeforeDelete;

  const authorityRenameProvider = createAuditProviderController();
  const authorityRenameDisabledService = new EnterpriseWechatCallbackService(
    container,
    { ORDER_QUEUE: noDispatchAuditQueue() },
    authorityRenameProvider.factory,
  );
  const authorityRenameVerifiedService = new EnterpriseWechatCallbackService(
    container,
    {
      ORDER_QUEUE: noDispatchAuditQueue(),
      WECHAT_WORK_MEMBER_CURRENT_AUTHORITY: "verified",
    },
    authorityRenameProvider.factory,
  );
  authorityRenameProvider.enqueue(
    "authority-rename-a",
    auditProviderSnapshot("authority-rename-a", { name: "Authority Rename Source" }),
  );
  const authorityRenameCreateMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 920,
    changeType: "create_user",
    userid: "authority-rename-a",
  });
  outcomes.authority_rename_create = await authorityRenameVerifiedService.processMessage(
    authorityRenameCreateMessage,
  ) as string;
  const authorityRenameCreated = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "authority-rename-a",
  );
  const authorityRenameStableMemberId = authorityRenameCreated.member?.id ?? 0;
  const authorityRenameProviderCallsAfterCreate = {
    factory: authorityRenameProvider.factoryCallCount(),
    directory: authorityRenameProvider.directoryCallCount(),
  };

  authorityRenameProvider.enqueue(
    "authority-rename-b",
    auditProviderSnapshot("authority-rename-b", {
      name: "Parked Rename Must Never Fetch",
    }),
  );
  const authorityParkedRenameMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 930,
    changeType: "update_user",
    userid: "authority-rename-a",
    newUserid: "authority-rename-b",
  });
  const authorityParkedRenameResult = await authorityRenameDisabledService.processMessage(
    authorityParkedRenameMessage,
  );
  outcomes.authority_rename_parked = typeof authorityParkedRenameResult === "object"
    ? authorityParkedRenameResult.kind
    : authorityParkedRenameResult;
  const authorityParkedRenameSource = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "authority-rename-a",
  );
  const authorityParkedRenameTarget = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "authority-rename-b",
  );
  const authorityParkedRenameEventState = await auditServiceEventState(
    client,
    schema,
    authorityParkedRenameMessage.eventId,
  );
  const authorityParkedRenameActorBlocked = await auditPendingActorBlocked(
    container,
    corpId,
    "authority-rename-b",
  );
  const authorityParkedRenameSourceActorBlocked = await auditPendingActorBlocked(
    container,
    corpId,
    "authority-rename-a",
  );

  const authorityRenameCallsBeforeDelete = {
    factory: authorityRenameProvider.factoryCallCount(),
    directory: authorityRenameProvider.directoryCallCount(),
  };
  const authorityRenameDeleteMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 940,
    changeType: "delete_user",
    userid: "authority-rename-b",
  });
  outcomes.authority_rename_delete = await authorityRenameDisabledService.processMessage(
    authorityRenameDeleteMessage,
  ) as string;
  const authorityRenameAfterDelete = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "authority-rename-b",
  );
  const authorityRenameDeleteUsedNoProvider =
    authorityRenameProvider.factoryCallCount() === authorityRenameCallsBeforeDelete.factory
    && authorityRenameProvider.directoryCallCount() === authorityRenameCallsBeforeDelete.directory;

  await makeAuditServiceRetryAvailable(client, schema, authorityParkedRenameMessage);
  const authorityRenameCallsBeforeReplay = {
    factory: authorityRenameProvider.factoryCallCount(),
    directory: authorityRenameProvider.directoryCallCount(),
  };
  outcomes.authority_rename_replay = await authorityRenameVerifiedService.processMessage(
    authorityParkedRenameMessage,
  ) as string;
  const authorityRenameReplayUsedNoProvider =
    authorityRenameProvider.factoryCallCount() === authorityRenameCallsBeforeReplay.factory
    && authorityRenameProvider.directoryCallCount() === authorityRenameCallsBeforeReplay.directory;
  const authorityRenameReplayEventState = await auditServiceEventState(
    client,
    schema,
    authorityParkedRenameMessage.eventId,
  );
  const authorityRenameFinalState = await auditInterleavedIdentityState(
    client,
    schema,
    corpId,
    "authority-rename-a",
    "authority-rename-b",
    authorityRenameStableMemberId,
  );

  provider.enqueue("service-a", auditProviderSnapshot("Service-A", {
    name: "Service A Created",
    extattr: { stage: "created" },
    external_profile: { stage: "created" },
  }));
  const createMessage = await insertAuditServiceEvent(client, schema, {
    corpId, eventTime: 1_000, changeType: "create_user", userid: "Service-A",
  });
  outcomes.create = await service.processMessage(createMessage) as string;
  const created = await auditServiceMemberState(client, schema, corpId, "service-a");
  const createdMemberId = created.member?.id ?? 0;

  provider.enqueue("service-a", auditProviderSnapshot("service-a", {
    name: "Service A Optional Omitted",
  }, ["mobile", "extattr", "external_profile"]));
  const omittedMessage = await insertAuditServiceEvent(client, schema, {
    corpId, eventTime: 1_010, changeType: "update_user", userid: "service-a",
  });
  outcomes.optional_omitted = await service.processMessage(omittedMessage) as string;
  const omitted = await auditServiceMemberState(client, schema, corpId, "service-a");

  provider.enqueue("service-a", auditProviderSnapshot("service-a", {
    name: "Service A Explicit Clear",
    mobile: "",
    extattr: {},
    external_profile: {},
    department: [9, 11],
    order: [0, 4_294_967_295],
    is_leader_in_dept: [0, 1],
    main_department: 9,
  }));
  const clearMessage = await insertAuditServiceEvent(client, schema, {
    corpId, eventTime: 1_020, changeType: "update_user", userid: "service-a",
  });
  outcomes.explicit_clear_and_relation_replace = await service.processMessage(clearMessage) as string;
  const cleared = await auditServiceMemberState(client, schema, corpId, "service-a");

  provider.enqueue("service-b", auditProviderSnapshot("service-b", {
    name: "Service B Renamed",
  }));
  const renameMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 1_030,
    changeType: "update_user",
    userid: "service-a",
    newUserid: "service-b",
  });
  outcomes.rename = await service.processMessage(renameMessage) as string;
  const renamed = await auditServiceMemberState(client, schema, corpId, "service-b");

  provider.enqueue("service-b", auditProviderSnapshot("SERVICE-B", {
    name: "Service B Case Only",
  }));
  const caseMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 1_040,
    changeType: "update_user",
    userid: "SERVICE-B",
    newUserid: "service-b",
  });
  outcomes.case_only = await service.processMessage(caseMessage) as string;
  const caseOnly = await auditServiceMemberState(client, schema, corpId, "service-b");

  const countsBeforeVisibilityGaps = await auditServiceBusinessCounts(client, schema, corpId);
  provider.enqueue("service-not-found", new EnterpriseWechatProviderError(
    "not_found",
    "directory_member_get",
    60_111,
    200,
  ));
  const notFoundMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 1_050,
    changeType: "create_user",
    userid: "service-not-found",
  });
  outcomes.not_found = await service.processMessage(notFoundMessage) as string;
  const notFound = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "service-not-found",
  );

  provider.enqueue("service-incomplete", auditProviderSnapshot(
    "service-incomplete",
    {},
    ["name"],
  ));
  const incompleteMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 1_060,
    changeType: "create_user",
    userid: "service-incomplete",
  });
  outcomes.incomplete = await service.processMessage(incompleteMessage) as string;
  const incomplete = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "service-incomplete",
  );
  const countsAfterVisibilityGaps = await auditServiceBusinessCounts(client, schema, corpId);

  provider.enqueue("expired-terminal", new EnterpriseWechatProviderError(
    "terminal",
    "directory_member_get",
    -1,
    0,
  ));
  const expiredTerminalMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 1_065,
    changeType: "update_user",
    userid: "expired-terminal",
  });
  await markAuditServiceLeaseExpired(client, schema, expiredTerminalMessage);
  const factoryCallsBeforeExpiredTerminal = provider.factoryCallCount();
  const directoryCallsBeforeExpiredTerminal = provider.directoryCallCount();
  outcomes.expired_processing_terminal = await service.processMessage(
    expiredTerminalMessage,
  ) as string;
  const expiredTerminalMember = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "expired-terminal",
  );
  const expiredTerminalEventState = await auditServiceEventState(
    client,
    schema,
    expiredTerminalMessage.eventId,
  );
  const expiredTerminalProviderCalls = {
    factory: provider.factoryCallCount() - factoryCallsBeforeExpiredTerminal,
    directory: provider.directoryCallCount() - directoryCallsBeforeExpiredTerminal,
  };

  const factoryCallsBeforeDeletes = provider.factoryCallCount();
  const directoryCallsBeforeDeletes = provider.directoryCallCount();
  const deleteExistingMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 1_070,
    changeType: "delete_user",
    userid: "service-b",
  });
  outcomes.delete_existing = await service.processMessage(deleteExistingMessage) as string;
  const deleted = await auditServiceMemberState(client, schema, corpId, "service-b");

  const deleteMissingMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 1_080,
    changeType: "delete_user",
    userid: "service-missing",
  });
  outcomes.delete_missing = await service.processMessage(deleteMissingMessage) as string;
  const deleteMissingReplayMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 1_081,
    changeType: "delete_user",
    userid: "service-missing",
  });
  outcomes.delete_missing_repeat = await service.processMessage(deleteMissingReplayMessage) as string;
  const missingDeleted = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "service-missing",
  );
  const deletesUsedNoProvider = provider.factoryCallCount() === factoryCallsBeforeDeletes
    && provider.directoryCallCount() === directoryCallsBeforeDeletes;

  const deferred = deferredAuditProviderOutcome();
  provider.enqueue("service-fence", deferred.outcome);
  provider.enqueue("service-fence", auditProviderSnapshot("service-fence", {
    name: "Fence Newer",
  }));
  const staleMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 2_000,
    changeType: "create_user",
    userid: "service-fence",
  });
  const staleProcess = service.processMessage(staleMessage);
  await boundedAuditWait(deferred.started, "stale provider did not start");
  const newerMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 2_010,
    changeType: "update_user",
    userid: "service-fence",
  });
  outcomes.seen_fence_newer = await service.processMessage(newerMessage) as string;
  deferred.resolve(auditProviderSnapshot("service-fence", { name: "Fence Older" }));
  outcomes.seen_fence_older = await boundedAuditWait(
    staleProcess,
    "stale provider process did not finish",
  ) as string;
  const fenced = await auditServiceMemberState(client, schema, corpId, "service-fence");
  const staleEventState = await auditServiceEventState(
    client,
    schema,
    staleMessage.eventId,
  );

  provider.enqueue("interleave-a", auditProviderSnapshot("interleave-a", {
    name: "Interleaved Source",
  }));
  const interleavedCreateMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 2_500,
    changeType: "create_user",
    userid: "interleave-a",
  });
  outcomes.interleaved_create = await service.processMessage(interleavedCreateMessage) as string;
  const interleavedCreated = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "interleave-a",
  );
  const interleavedMemberId = interleavedCreated.member?.id ?? 0;

  const deferredRename = deferredAuditProviderOutcome();
  provider.enqueue("interleave-b", deferredRename.outcome);
  const interleavedRenameMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 2_510,
    changeType: "update_user",
    userid: "interleave-a",
    newUserid: "interleave-b",
  });
  const interleavedRenameProcess = service.processMessage(interleavedRenameMessage);
  await boundedAuditWait(
    deferredRename.started,
    "interleaved rename provider did not start",
  );
  const pendingRenameSource = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "interleave-a",
  );
  const pendingRenameTarget = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "interleave-b",
  );
  const pendingTargetAlias = pendingRenameTarget.aliases[0];
  const pendingActorBlocked = await auditPendingActorBlocked(
    container,
    corpId,
    "interleave-b",
  );

  provider.enqueue("interleave-b", auditProviderSnapshot("interleave-b", {
    name: "Interleaved Newer Update",
  }));
  const interleavedUpdateMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 2_520,
    changeType: "update_user",
    userid: "interleave-b",
  });
  outcomes.interleaved_newer_update = await service.processMessage(
    interleavedUpdateMessage,
  ) as string;
  const interleavedUpdated = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "interleave-b",
  );

  const factoryCallsBeforeInterleavedDelete = provider.factoryCallCount();
  const directoryCallsBeforeInterleavedDelete = provider.directoryCallCount();
  const interleavedDeleteMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 2_530,
    changeType: "delete_user",
    userid: "interleave-b",
  });
  outcomes.interleaved_newer_delete = await service.processMessage(
    interleavedDeleteMessage,
  ) as string;
  const interleavedDeleted = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "interleave-b",
  );
  const interleavedDeleteUsedNoProvider =
    provider.factoryCallCount() === factoryCallsBeforeInterleavedDelete
    && provider.directoryCallCount() === directoryCallsBeforeInterleavedDelete;
  const interleavedDigestBeforeStaleRename = await auditServiceBusinessDigest(
    client,
    schema,
    corpId,
  );

  deferredRename.resolve(auditProviderSnapshot("interleave-b", {
    name: "Interleaved Older Rename",
  }));
  outcomes.interleaved_older_rename = await boundedAuditWait(
    interleavedRenameProcess,
    "interleaved stale rename did not finish",
  ) as string;
  const interleavedDigestAfterStaleRename = await auditServiceBusinessDigest(
    client,
    schema,
    corpId,
  );
  const interleavedRenameEventState = await auditServiceEventState(
    client,
    schema,
    interleavedRenameMessage.eventId,
  );
  const interleavedFinalState = await auditInterleavedIdentityState(
    client,
    schema,
    corpId,
    "interleave-a",
    "interleave-b",
    interleavedMemberId,
  );

  provider.enqueue("conflict-old", auditProviderSnapshot("conflict-old", {
    name: "Conflict Old",
  }));
  const conflictOldMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 3_000,
    changeType: "create_user",
    userid: "conflict-old",
  });
  outcomes.conflict_old_create = await service.processMessage(conflictOldMessage) as string;
  provider.enqueue("conflict-new", auditProviderSnapshot("conflict-new", {
    name: "Conflict New",
  }));
  const conflictNewMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 3_010,
    changeType: "create_user",
    userid: "conflict-new",
  });
  outcomes.conflict_new_create = await service.processMessage(conflictNewMessage) as string;
  const conflictDigestBefore = await auditServiceBusinessDigest(client, schema, corpId);
  provider.enqueue("conflict-new", auditProviderSnapshot("conflict-new", {
    name: "Conflict Rename Must Roll Back",
  }));
  const conflictRenameMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 3_020,
    changeType: "update_user",
    userid: "conflict-old",
    newUserid: "conflict-new",
  });
  outcomes.identity_conflict = await service.processMessage(conflictRenameMessage) as string;
  const conflictDigestAfter = await auditServiceBusinessDigest(client, schema, corpId);
  const conflictEventState = await auditServiceEventState(
    client,
    schema,
    conflictRenameMessage.eventId,
  );

  provider.enqueue("ahead-a", auditProviderSnapshot("ahead-a", {
    name: "Ahead Source",
  }));
  const aheadCreateMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 3_500,
    changeType: "create_user",
    userid: "ahead-a",
  });
  outcomes.ahead_create = await service.processMessage(aheadCreateMessage) as string;
  const aheadCreated = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "ahead-a",
  );
  const aheadStableMemberId = aheadCreated.member?.id ?? 0;
  provider.enqueue("ahead-b", auditProviderSnapshot("ahead-b", {
    name: "Ahead Newer Target Update",
  }, ["mobile", "extattr", "external_profile"]));
  const aheadNewerUpdateMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 3_520,
    changeType: "update_user",
    userid: "ahead-b",
  });
  outcomes.ahead_newer_update = await service.processMessage(aheadNewerUpdateMessage) as string;
  provider.enqueue("ahead-b", auditProviderSnapshot("ahead-b", {
    name: "Ahead Older Rename",
  }));
  const providerCallsBeforeAheadOlderRename = {
    factory: provider.factoryCallCount(),
    directory: provider.directoryCallCount(),
  };
  const aheadOlderRenameMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 3_510,
    changeType: "update_user",
    userid: "ahead-a",
    newUserid: "ahead-b",
  });
  outcomes.ahead_older_rename = await service.processMessage(aheadOlderRenameMessage) as string;
  const aheadOlderRenameUsedNoProvider =
    provider.factoryCallCount() === providerCallsBeforeAheadOlderRename.factory
    && provider.directoryCallCount() === providerCallsBeforeAheadOlderRename.directory;
  const aheadFinalTarget = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "ahead-b",
  );
  const aheadFinalState = await auditInterleavedIdentityState(
    client,
    schema,
    corpId,
    "ahead-a",
    "ahead-b",
    aheadStableMemberId,
  );
  const aheadSourceAlias = aheadFinalTarget.aliases.find((row) => row.userid === "ahead-a");
  const aheadTargetAlias = aheadFinalTarget.aliases.find((row) => row.userid === "ahead-b");

  provider.enqueue("chain-a", auditProviderSnapshot("chain-a", {
    name: "Chain Source",
  }));
  const chainCreateMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 4_000,
    changeType: "create_user",
    userid: "chain-a",
  });
  outcomes.chain_create = await service.processMessage(chainCreateMessage) as string;
  const chainCreated = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "chain-a",
  );
  const chainStableMemberId = chainCreated.member?.id ?? 0;
  const deferredFirstRename = deferredAuditProviderOutcome();
  provider.enqueue("chain-b", deferredFirstRename.outcome);
  const chainFirstRenameMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 4_010,
    changeType: "update_user",
    userid: "chain-a",
    newUserid: "chain-b",
  });
  const chainFirstRenameProcess = service.processMessage(chainFirstRenameMessage);
  await boundedAuditWait(
    deferredFirstRename.started,
    "first chained rename provider did not start",
  );
  provider.enqueue("chain-c", auditProviderSnapshot("chain-c", {
    name: "Chain Newer Rename",
  }));
  const chainSecondRenameMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 4_020,
    changeType: "update_user",
    userid: "chain-b",
    newUserid: "chain-c",
  });
  outcomes.chain_newer_rename = await service.processMessage(chainSecondRenameMessage) as string;
  provider.enqueue("chain-c", auditProviderSnapshot("chain-c", {
    name: "Chain Newer Target Update",
  }));
  const chainUpdateMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 4_025,
    changeType: "update_user",
    userid: "chain-c",
  });
  outcomes.chain_newer_update = await service.processMessage(chainUpdateMessage) as string;
  const chainUpdated = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "chain-c",
  );
  const factoryCallsBeforeChainDelete = provider.factoryCallCount();
  const directoryCallsBeforeChainDelete = provider.directoryCallCount();
  const chainDeleteMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 4_030,
    changeType: "delete_user",
    userid: "chain-c",
  });
  outcomes.chain_newer_delete = await service.processMessage(chainDeleteMessage) as string;
  const chainDeleteUsedNoProvider = provider.factoryCallCount() === factoryCallsBeforeChainDelete
    && provider.directoryCallCount() === directoryCallsBeforeChainDelete;
  deferredFirstRename.resolve(auditProviderSnapshot("chain-b", {
    name: "Chain Older Rename",
  }));
  outcomes.chain_older_rename = await boundedAuditWait(
    chainFirstRenameProcess,
    "first chained stale rename did not finish",
  ) as string;
  const chainFinalState = await auditRenameChainState(
    client,
    schema,
    corpId,
    "chain-a",
    "chain-b",
    "chain-c",
    chainStableMemberId,
  );

  provider.enqueue("reverse-delete-a", auditProviderSnapshot("reverse-delete-a", {
    name: "Reverse Delete Source",
  }));
  const reverseDeleteCreateMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 4_500,
    changeType: "create_user",
    userid: "reverse-delete-a",
  });
  outcomes.reverse_delete_create = await service.processMessage(
    reverseDeleteCreateMessage,
  ) as string;
  const reverseDeleteCreated = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "reverse-delete-a",
  );
  const reverseDeleteStableMemberId = reverseDeleteCreated.member?.id ?? 0;
  const factoryCallsBeforeMissingTargetDelete = provider.factoryCallCount();
  const directoryCallsBeforeMissingTargetDelete = provider.directoryCallCount();
  const reverseDeleteTargetMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 4_520,
    changeType: "delete_user",
    userid: "reverse-delete-b",
  });
  outcomes.reverse_delete_target = await service.processMessage(
    reverseDeleteTargetMessage,
  ) as string;
  const reverseDeleteTargetBeforeRename = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "reverse-delete-b",
  );
  const missingTargetDeleteUsedNoProvider =
    provider.factoryCallCount() === factoryCallsBeforeMissingTargetDelete
    && provider.directoryCallCount() === directoryCallsBeforeMissingTargetDelete;

  provider.enqueue("reverse-delete-b", auditProviderSnapshot("reverse-delete-b", {
    name: "Reverse Delete Older Rename Must Not Fetch",
  }));
  const factoryCallsBeforeReverseDeleteRename = provider.factoryCallCount();
  const directoryCallsBeforeReverseDeleteRename = provider.directoryCallCount();
  const reverseDeleteRenameMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 4_510,
    changeType: "update_user",
    userid: "reverse-delete-a",
    newUserid: "reverse-delete-b",
  });
  outcomes.reverse_delete_older_rename = await service.processMessage(
    reverseDeleteRenameMessage,
  ) as string;
  const reverseDeleteRenameUsedNoProvider =
    provider.factoryCallCount() === factoryCallsBeforeReverseDeleteRename
    && provider.directoryCallCount() === directoryCallsBeforeReverseDeleteRename;
  const reverseDeleteFinalState = await auditInterleavedIdentityState(
    client,
    schema,
    corpId,
    "reverse-delete-a",
    "reverse-delete-b",
    reverseDeleteStableMemberId,
  );

  provider.enqueue("branch-a", auditProviderSnapshot("branch-a", {
    name: "Branch Source A",
  }));
  const branchSourceCreateMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 5_000,
    changeType: "create_user",
    userid: "branch-a",
  });
  outcomes.branch_source_create = await service.processMessage(
    branchSourceCreateMessage,
  ) as string;
  const branchSourceCreated = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "branch-a",
  );
  const branchSourceStableMemberId = branchSourceCreated.member?.id ?? 0;
  provider.enqueue("branch-c", auditProviderSnapshot("branch-c", {
    name: "Branch Source C",
  }));
  const branchOtherCreateMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 5_001,
    changeType: "create_user",
    userid: "branch-c",
  });
  outcomes.branch_other_create = await service.processMessage(branchOtherCreateMessage) as string;
  const branchOtherCreated = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "branch-c",
  );
  const branchOtherStableMemberId = branchOtherCreated.member?.id ?? 0;

  const deferredBranchRename = deferredAuditProviderOutcome();
  provider.enqueue("branch-b", deferredBranchRename.outcome);
  const branchOriginalRenameMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 5_010,
    changeType: "update_user",
    userid: "branch-a",
    newUserid: "branch-b",
  });
  const branchOriginalRenameProcess = service.processMessage(branchOriginalRenameMessage);
  await boundedAuditWait(
    deferredBranchRename.started,
    "original branch rename provider did not start",
  );
  const branchDigestBeforeQuarantine = await auditServiceBusinessDigest(
    client,
    schema,
    corpId,
  );
  provider.enqueue("branch-b", auditProviderSnapshot("branch-b", {
    name: "Conflicting Branch Must Not Fetch",
  }));
  const factoryCallsBeforeBranchConflict = provider.factoryCallCount();
  const directoryCallsBeforeBranchConflict = provider.directoryCallCount();
  const branchConflictMessage = await insertAuditServiceEvent(client, schema, {
    corpId,
    eventTime: 5_020,
    changeType: "update_user",
    userid: "branch-c",
    newUserid: "branch-b",
  });
  outcomes.branch_conflict = await service.processMessage(branchConflictMessage) as string;
  const branchConflictUsedNoProvider = provider.factoryCallCount() === factoryCallsBeforeBranchConflict
    && provider.directoryCallCount() === directoryCallsBeforeBranchConflict;
  const branchDigestAfterQuarantine = await auditServiceBusinessDigest(
    client,
    schema,
    corpId,
  );
  const branchConflictEventState = await auditServiceEventState(
    client,
    schema,
    branchConflictMessage.eventId,
  );
  deferredBranchRename.resolve(auditProviderSnapshot("branch-b", {
    name: "Original Branch Rename",
  }));
  outcomes.branch_original_rename = await boundedAuditWait(
    branchOriginalRenameProcess,
    "original branch rename did not finish",
  ) as string;
  const branchFinalTarget = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "branch-b",
  );
  const branchFinalOtherSource = await auditServiceMemberState(
    client,
    schema,
    corpId,
    "branch-c",
  );
  const branchFinalOldAlias = branchFinalTarget.aliases.find((row) => row.userid === "branch-a");
  const branchFinalTargetAlias = branchFinalTarget.aliases.find((row) => row.userid === "branch-b");

  const staleLineageUpdateReviewer = await auditStaleLineageReviewerScenario(
    service,
    provider,
    client,
    schema,
    corpId,
    "lineage-update",
    6_000,
    "update_user",
  );
  Object.assign(outcomes, staleLineageUpdateReviewer.outcomes);
  const staleLineageDeleteReviewer = await auditStaleLineageReviewerScenario(
    service,
    provider,
    client,
    schema,
    corpId,
    "lineage-delete",
    7_000,
    "delete_user",
  );
  Object.assign(outcomes, staleLineageDeleteReviewer.outcomes);

  const resolvedForwardUpdateReviewer = await auditResolvedForwardRenameScenario(
    service,
    provider,
    client,
    schema,
    corpId,
    "resolved-forward-update",
    8_000,
    "update_user",
  );
  Object.assign(outcomes, resolvedForwardUpdateReviewer.outcomes);
  const resolvedForwardDeleteReviewer = await auditResolvedForwardRenameScenario(
    service,
    provider,
    client,
    schema,
    corpId,
    "resolved-forward-delete",
    9_000,
    "delete_user",
  );
  Object.assign(outcomes, resolvedForwardDeleteReviewer.outcomes);
  const contaminatedForwardUpdateReviewer = await auditContaminatedResolvedForwardScenario(
    service,
    provider,
    client,
    schema,
    "auditreuseupd",
    "full-resolved-reuse-update",
    10_000,
    "update_user",
  );
  for (const [key, value] of Object.entries(contaminatedForwardUpdateReviewer.outcomes)) {
    outcomes[`reuse_update_${key}`] = value;
  }
  const contaminatedForwardDeleteReviewer = await auditContaminatedResolvedForwardScenario(
    service,
    provider,
    client,
    schema,
    "auditreusedel",
    "full-resolved-reuse-delete",
    11_000,
    "delete_user",
  );
  for (const [key, value] of Object.entries(contaminatedForwardDeleteReviewer.outcomes)) {
    outcomes[`reuse_delete_${key}`] = value;
  }
  const resolvedForwardRollbackReviewer = await auditResolvedForwardRollbackScenario(
    service,
    provider,
    client,
    schema,
    "auditrollback",
    12_000,
  );
  for (const [key, value] of Object.entries(resolvedForwardRollbackReviewer.outcomes)) {
    outcomes[`rollback_${key}`] = value;
  }

  const createdRelationMaximum = created.relations.some((row) =>
    row.sort_order === "4294967295");
  const clearedRelationsExact = cleared.relations.length === 2
    && cleared.relations[0]?.department_id === 9
    && cleared.relations[0].sort_order === "0"
    && cleared.relations[1]?.department_id === 11
    && cleared.relations[1].sort_order === "4294967295"
    && cleared.relations[1].is_leader_in_dept === 1;
  const oldRenameAlias = renamed.aliases.find((row) => row.userid === "service-a");
  const newRenameAlias = renamed.aliases.find((row) => row.userid === "service-b");
  const assertions = {
    member_current_authority_defaults_closed_with_durable_retryable_park:
      outcomes.authority_disabled_parked === "parked"
      && outcomes.authority_disabled_reparked === "parked"
      && authorityDisabledDispatch.claimed === 1
      && authorityDisabledDispatch.enqueued === 1
      && authorityFirstQueueIdentityMatches
      && authorityFirstConsume.ack_count === 1
      && authorityFirstConsume.retry_count === 0
      && authorityRepeatConsume.ack_count === 1
      && authorityRepeatConsume.retry_count === 0
      && authorityDisabledDispatchPages.claimed === 0
      && authorityDisabledDispatchPages.enqueued === 0
      && authorityDisabledDispatchPages.batches === 0
      && countsAfterAuthorityParked.members === countsBeforeAuthorityDisabled.members
      && countsAfterAuthorityParked.other === countsBeforeAuthorityDisabled.other
      && countsAfterAuthorityParked.relations === countsBeforeAuthorityDisabled.relations
      && countsAfterAuthorityParked.aliases === countsBeforeAuthorityDisabled.aliases + 1
      && authorityParkedMember.member === null
      && authorityParkedMember.aliases.length === 1
      && authorityParkedMember.aliases[0]?.member_id === null
      && authorityParkedMember.aliases[0].canonical_userid === "authority-disabled"
      && authorityParkedMember.aliases[0].lifecycle_state === "UNRESOLVED"
      && authorityParkedActorBlocked
      && authorityProviderCallsAfterPark.factory === 0
      && authorityProviderCallsAfterPark.directory === 0
      && authorityParkedEventState?.status === "FAILED"
      && authorityParkedEventState.projection_status === "REFRESH_REQUIRED"
      && authorityParkedEventState.outbox_status === "FAILED"
      && authorityParkedEventState.event_attempt_count === 0
      && authorityParkedEventState.outbox_attempt_count === 0
      && authorityParkedEventState.event_last_error_code === "member_projection_disabled"
      && authorityParkedEventState.outbox_last_error_code === "member_projection_disabled"
      && authorityParkedEventState.watermark_count === 0,
    verified_authority_replays_the_same_parked_event:
      outcomes.authority_verified_retry === "applied"
      && authorityVerifiedDispatchPages.claimed === 1
      && authorityVerifiedDispatchPages.enqueued === 1
      && authorityVerifiedDispatchPages.batches === 1
      && authorityReplayQueueIdentityMatches
      && authorityReplayConsume.ack_count === 1
      && authorityReplayConsume.retry_count === 0
      && authorityVerifiedMember.member?.lifecycle_state === "ACTIVE"
      && authorityVerifiedMember.member.userid === "authority-disabled"
      && authorityVerifiedMember.aliases.length === 1
      && authorityVerifiedEventState?.status === "ORDERED"
      && authorityVerifiedEventState.projection_status === "APPLIED"
      && authorityVerifiedEventState.outbox_status === "COMPLETED"
      && authorityVerifiedEventState.event_attempt_count === 1
      && authorityVerifiedEventState.outbox_attempt_count === 1
      && authorityVerifiedEventState.watermark_count === 1,
    disabled_authority_delete_still_tombstones_without_provider:
      outcomes.authority_disabled_delete === "applied"
      && authorityDeleteDispatch.claimed === 1
      && authorityDeleteDispatch.enqueued === 1
      && authorityDeleteQueueIdentityMatches
      && authorityDeleteConsume.ack_count === 1
      && authorityDeleteConsume.retry_count === 0
      && authorityQueue.pendingCount() === 0
      && authorityDisabledDeleteUsedNoProvider
      && authorityDisabledProvider.factoryCallCount() === 1
      && authorityDisabledProvider.directoryCallCount() === 1
      && authorityDisabledDeleted.member?.id === authorityVerifiedMember.member?.id
      && authorityDisabledDeleted.member?.lifecycle_state === "DELETED"
      && authorityDisabledDeleted.member.enable === 0
      && authorityDisabledDeleted.member.status === 5
      && authorityDisabledDeleteEventState?.status === "ORDERED"
      && authorityDisabledDeleteEventState.projection_status === "APPLIED"
      && authorityDisabledDeleteEventState.outbox_status === "COMPLETED"
      && authorityDisabledDeleteEventState.watermark_count === 1,
    parked_rename_then_delete_replay_preserves_stable_tombstone_without_provider:
      outcomes.authority_rename_create === "applied"
      && outcomes.authority_rename_parked === "parked"
      && outcomes.authority_rename_delete === "applied"
      && outcomes.authority_rename_replay === "superseded"
      && authorityRenameStableMemberId > 0
      && authorityRenameProviderCallsAfterCreate.factory === 1
      && authorityRenameProviderCallsAfterCreate.directory === 1
      && authorityRenameProvider.factoryCallCount() === 1
      && authorityRenameProvider.directoryCallCount() === 1
      && authorityParkedRenameSource.member?.id === authorityRenameStableMemberId
      && authorityParkedRenameSource.member.userid === "authority-rename-a"
      && authorityParkedRenameSource.member.lifecycle_state === "ACTIVE"
      && authorityParkedRenameSource.aliases.length === 1
      && authorityParkedRenameSource.aliases[0]?.member_id === authorityRenameStableMemberId
      && authorityParkedRenameSource.aliases[0].lifecycle_state === "UNRESOLVED"
      && authorityParkedRenameTarget.member === null
      && authorityParkedRenameTarget.aliases.length === 1
      && authorityParkedRenameTarget.aliases[0]?.member_id === null
      && authorityParkedRenameTarget.aliases[0].canonical_userid === "authority-rename-a"
      && authorityParkedRenameTarget.aliases[0].lifecycle_state === "UNRESOLVED"
      && authorityParkedRenameActorBlocked
      && authorityParkedRenameSourceActorBlocked
      && authorityParkedRenameEventState?.status === "FAILED"
      && authorityParkedRenameEventState.projection_status === "REFRESH_REQUIRED"
      && authorityParkedRenameEventState.outbox_status === "FAILED"
      && authorityParkedRenameEventState.event_attempt_count === 0
      && authorityParkedRenameEventState.outbox_attempt_count === 0
      && authorityRenameDeleteUsedNoProvider
      && authorityRenameReplayUsedNoProvider
      && authorityRenameAfterDelete.member?.id === authorityRenameStableMemberId
      && authorityRenameAfterDelete.member.lifecycle_state === "DELETED"
      && authorityRenameReplayEventState?.status === "ORDERED"
      && authorityRenameReplayEventState.projection_status === "SUPERSEDED"
      && authorityRenameReplayEventState.outbox_status === "COMPLETED"
      && authorityRenameReplayEventState.event_attempt_count === 0
      && authorityRenameReplayEventState.outbox_attempt_count === 0
      && authorityRenameReplayEventState.watermark_count === 0
      && authorityRenameFinalState.pair_current_rows === 1
      && authorityRenameFinalState.stable_current_rows === 1
      && authorityRenameFinalState.stable_deleted_target_rows === 1
      && authorityRenameFinalState.active_source_rows === 0
      && authorityRenameFinalState.split_target_rows === 0
      && authorityRenameFinalState.source_renamed_aliases === 1
      && authorityRenameFinalState.target_deleted_aliases === 1
      && authorityRenameFinalState.split_aliases === 0,
    callback_service_create_applied:
      outcomes.create === "applied"
      && createdMemberId > 0
      && created.member?.lifecycle_state === "ACTIVE"
      && created.member.mobile === "+6581234567"
      && created.other?.extattr === '{"stage":"created"}'
      && createdRelationMaximum,
    omitted_optional_fields_preserved:
      outcomes.optional_omitted === "applied"
      && omitted.member?.id === createdMemberId
      && omitted.member.mobile === "+6581234567"
      && omitted.other?.extattr === '{"stage":"created"}'
      && omitted.other.external_profile === '{"stage":"created"}',
    explicit_empty_fields_clear_and_relations_replace:
      outcomes.explicit_clear_and_relation_replace === "applied"
      && cleared.member?.id === createdMemberId
      && cleared.member.mobile === ""
      && cleared.other?.extattr === "{}"
      && cleared.other.external_profile === "{}"
      && clearedRelationsExact,
    rename_preserves_stable_member_id:
      outcomes.rename === "applied"
      && renamed.member?.id === createdMemberId
      && renamed.member.userid === "service-b"
      && oldRenameAlias?.member_id === createdMemberId
      && oldRenameAlias.lifecycle_state === "RENAMED"
      && newRenameAlias?.member_id === createdMemberId
      && newRenameAlias.lifecycle_state === "ACTIVE",
    case_only_update_does_not_split_identity:
      outcomes.case_only === "applied"
      && caseOnly.member?.id === createdMemberId
      && caseOnly.member.userid === "service-b"
      && caseOnly.aliases.length === 2,
    provider_not_found_writes_no_business_projection:
      outcomes.not_found === "refresh-required"
      && countsAfterVisibilityGaps.members === countsBeforeVisibilityGaps.members
      && countsAfterVisibilityGaps.other === countsBeforeVisibilityGaps.other
      && countsAfterVisibilityGaps.relations === countsBeforeVisibilityGaps.relations
      && countsAfterVisibilityGaps.aliases === countsBeforeVisibilityGaps.aliases + 2
      && notFound.member === null
      && notFound.aliases.length === 1
      && notFound.aliases[0]?.lifecycle_state === "UNRESOLVED",
    provider_incomplete_writes_no_business_projection:
      outcomes.incomplete === "refresh-required"
      && incomplete.member === null
      && incomplete.aliases.length === 1
      && incomplete.aliases[0]?.lifecycle_state === "UNRESOLVED",
    expired_processing_lease_reclaims_seen_fence_then_terminally_dies:
      outcomes.expired_processing_terminal === "dead"
      && expiredTerminalProviderCalls.factory === 1
      && expiredTerminalProviderCalls.directory === 1
      && expiredTerminalMember.member === null
      && expiredTerminalMember.aliases.length === 1
      && expiredTerminalMember.aliases[0]?.member_id === null
      && expiredTerminalMember.aliases[0].lifecycle_state === "UNRESOLVED"
      && expiredTerminalEventState?.status === "DEAD"
      && expiredTerminalEventState.projection_status === "DEAD"
      && expiredTerminalEventState.outbox_status === "DEAD"
      && expiredTerminalEventState.event_attempt_count === 2
      && expiredTerminalEventState.outbox_attempt_count === 2
      && expiredTerminalEventState.watermark_count === 0,
    delete_existing_and_missing_never_construct_provider:
      deletesUsedNoProvider
      && outcomes.delete_existing === "applied"
      && outcomes.delete_missing === "applied-noop"
      && outcomes.delete_missing_repeat === "applied-noop",
    delete_existing_tombstones_stable_member:
      deleted.member?.id === createdMemberId
      && deleted.member.lifecycle_state === "DELETED"
      && deleted.member.enable === 0
      && deleted.member.status === 5
      && deleted.relations.length === 0,
    delete_missing_keeps_nullable_tombstone:
      missingDeleted.member === null
      && missingDeleted.aliases.length === 1
      && missingDeleted.aliases[0]?.member_id === null
      && missingDeleted.aliases[0].lifecycle_state === "DELETED",
    latest_seen_fence_blocks_older_provider_response:
      outcomes.seen_fence_newer === "applied"
      && outcomes.seen_fence_older === "superseded"
      && fenced.member?.name === "Fence Newer"
      && staleEventState?.status === "ORDERED"
      && staleEventState.projection_status === "SUPERSEDED"
      && staleEventState.outbox_status === "COMPLETED",
    pending_cross_subject_rename_links_member_but_context_blocks:
      outcomes.interleaved_create === "applied"
      && interleavedMemberId > 0
      && pendingRenameSource.member?.id === interleavedMemberId
      && pendingRenameSource.member.lifecycle_state === "ACTIVE"
      && pendingRenameTarget.member === null
      && pendingTargetAlias?.member_id === interleavedMemberId
      && pendingTargetAlias.canonical_userid === "interleave-a"
      && pendingTargetAlias.lifecycle_state === "UNRESOLVED"
      && pendingActorBlocked,
    cross_subject_newer_update_reuses_stable_member_id:
      outcomes.interleaved_newer_update === "applied"
      && interleavedUpdated.member?.id === interleavedMemberId
      && interleavedUpdated.member.userid === "interleave-b"
      && interleavedUpdated.member.lifecycle_state === "ACTIVE",
    cross_subject_delete_tombstones_same_member_without_provider:
      outcomes.interleaved_newer_delete === "applied"
      && interleavedDeleteUsedNoProvider
      && interleavedDeleted.member?.id === interleavedMemberId
      && interleavedDeleted.member.userid === "interleave-b"
      && interleavedDeleted.member.lifecycle_state === "DELETED"
      && interleavedDeleted.relations.length === 0,
    older_cross_subject_rename_is_superseded_without_business_mutation:
      outcomes.interleaved_older_rename === "superseded"
      && interleavedDigestBeforeStaleRename === interleavedDigestAfterStaleRename
      && interleavedRenameEventState?.status === "ORDERED"
      && interleavedRenameEventState.projection_status === "SUPERSEDED"
      && interleavedRenameEventState.outbox_status === "COMPLETED",
    cross_subject_rename_update_delete_never_splits_identity:
      interleavedFinalState.pair_current_rows === 1
      && interleavedFinalState.stable_current_rows === 1
      && interleavedFinalState.stable_deleted_target_rows === 1
      && interleavedFinalState.active_source_rows === 0
      && interleavedFinalState.split_target_rows === 0
      && interleavedFinalState.source_renamed_aliases === 1
      && interleavedFinalState.target_deleted_aliases === 1
      && interleavedFinalState.split_aliases === 0
      && interleavedFinalState.current_relations === 0,
    identity_conflict_rolls_back_business_transaction:
      outcomes.identity_conflict === "dead"
      && conflictDigestBefore === conflictDigestAfter
      && conflictEventState?.status === "DEAD"
      && conflictEventState.projection_status === "DEAD"
      && conflictEventState.outbox_status === "DEAD"
      && conflictEventState.watermark_count === 0,
    newer_target_update_before_older_rename_never_splits_identity:
      outcomes.ahead_create === "applied"
      && outcomes.ahead_newer_update === "applied"
      && outcomes.ahead_older_rename === "superseded"
      && aheadOlderRenameUsedNoProvider
      && aheadStableMemberId > 0
      && aheadFinalTarget.member?.id === aheadStableMemberId
      && aheadFinalTarget.member.lifecycle_state === "ACTIVE"
      && aheadFinalTarget.member.mobile === aheadCreated.member?.mobile
      && aheadFinalTarget.other?.extattr === aheadCreated.other?.extattr
      && aheadFinalTarget.other?.external_profile === aheadCreated.other?.external_profile
      && aheadFinalState.pair_current_rows === 1
      && aheadFinalState.stable_current_rows === 1
      && aheadFinalState.split_target_rows === 0
      && aheadSourceAlias?.member_id === aheadStableMemberId
      && aheadSourceAlias.lifecycle_state === "RENAMED"
      && aheadTargetAlias?.member_id === aheadStableMemberId
      && aheadTargetAlias.lifecycle_state === "ACTIVE",
    chained_pending_rename_and_delete_preserve_one_tombstoned_identity:
      outcomes.chain_create === "applied"
      && outcomes.chain_newer_rename === "applied"
      && outcomes.chain_newer_update === "applied"
      && outcomes.chain_newer_delete === "applied"
      && outcomes.chain_older_rename === "superseded"
      && chainDeleteUsedNoProvider
      && chainStableMemberId > 0
      && chainUpdated.member?.id === chainStableMemberId
      && chainUpdated.member.lifecycle_state === "ACTIVE"
      && chainFinalState.chain_current_rows === 1
      && chainFinalState.stable_current_rows === 1
      && chainFinalState.stable_deleted_target_rows === 1
      && chainFinalState.active_predecessor_rows === 0
      && chainFinalState.split_current_rows === 0
      && chainFinalState.source_renamed_aliases === 1
      && chainFinalState.middle_renamed_aliases === 1
      && chainFinalState.target_deleted_aliases === 1
      && chainFinalState.split_aliases === 0
      && chainFinalState.current_relations === 0,
    newer_missing_target_delete_then_older_rename_propagates_tombstone_without_provider:
      outcomes.reverse_delete_create === "applied"
      && outcomes.reverse_delete_target === "applied-noop"
      && outcomes.reverse_delete_older_rename === "superseded"
      && reverseDeleteStableMemberId > 0
      && missingTargetDeleteUsedNoProvider
      && reverseDeleteRenameUsedNoProvider
      && reverseDeleteTargetBeforeRename.member === null
      && reverseDeleteTargetBeforeRename.aliases.length === 1
      && reverseDeleteTargetBeforeRename.aliases[0]?.member_id === null
      && reverseDeleteTargetBeforeRename.aliases[0].lifecycle_state === "DELETED"
      && reverseDeleteFinalState.pair_current_rows === 1
      && reverseDeleteFinalState.stable_current_rows === 1
      && reverseDeleteFinalState.stable_deleted_target_rows === 1
      && reverseDeleteFinalState.active_source_rows === 0
      && reverseDeleteFinalState.split_target_rows === 0
      && reverseDeleteFinalState.source_renamed_aliases === 1
      && reverseDeleteFinalState.target_deleted_aliases === 1
      && reverseDeleteFinalState.split_aliases === 0
      && reverseDeleteFinalState.current_relations === 0,
    conflicting_pending_rename_source_branch_is_quarantined_before_provider:
      outcomes.branch_source_create === "applied"
      && outcomes.branch_other_create === "applied"
      && outcomes.branch_conflict === "dead"
      && outcomes.branch_original_rename === "applied"
      && branchSourceStableMemberId > 0
      && branchOtherStableMemberId > 0
      && branchSourceStableMemberId !== branchOtherStableMemberId
      && branchConflictUsedNoProvider
      && branchDigestBeforeQuarantine === branchDigestAfterQuarantine
      && branchConflictEventState?.status === "DEAD"
      && branchConflictEventState.projection_status === "DEAD"
      && branchConflictEventState.outbox_status === "DEAD"
      && branchConflictEventState.watermark_count === 0
      && branchFinalTarget.member?.id === branchSourceStableMemberId
      && branchFinalTarget.member.lifecycle_state === "ACTIVE"
      && branchFinalOldAlias?.member_id === branchSourceStableMemberId
      && branchFinalOldAlias.lifecycle_state === "RENAMED"
      && branchFinalTargetAlias?.member_id === branchSourceStableMemberId
      && branchFinalTargetAlias.lifecycle_state === "ACTIVE"
      && branchFinalOtherSource.member?.id === branchOtherStableMemberId
      && branchFinalOtherSource.member.lifecycle_state === "ACTIVE",
    stale_ancestor_blocks_old_edge_after_new_target_update_without_provider_or_merge:
      staleLineageUpdateReviewer.passed,
    stale_ancestor_blocks_old_edge_after_new_target_delete_without_provider_or_tombstone_spread:
      staleLineageDeleteReviewer.passed,
    resolved_forward_chain_update_then_older_predecessor_rename_preserves_one_stable_identity:
      resolvedForwardUpdateReviewer.passed,
    resolved_forward_chain_delete_then_older_predecessor_rename_preserves_one_stable_tombstone:
      resolvedForwardDeleteReviewer.passed,
    resolved_forward_contaminated_update_fence_is_quarantined_without_merge:
      contaminatedForwardUpdateReviewer.passed,
    resolved_forward_contaminated_delete_fence_is_quarantined_without_tombstone_spread:
      contaminatedForwardDeleteReviewer.passed,
    resolved_forward_post_mutation_failure_rolls_back_complete_projection_transaction:
      resolvedForwardRollbackReviewer.passed,
  };
  return {
    mode: "real_drizzle_callback_service_with_deterministic_provider",
    callback_service_invoked: true,
    provider_is_mocked: true,
    enterprise_wechat_network_calls: 0,
    assertions,
    outcomes,
    resolved_forward_diagnostics: {
      update: resolvedForwardUpdateReviewer.diagnostics,
      delete: resolvedForwardDeleteReviewer.diagnostics,
      contaminated_update: contaminatedForwardUpdateReviewer.diagnostics,
      contaminated_delete: contaminatedForwardDeleteReviewer.diagnostics,
      rollback: resolvedForwardRollbackReviewer.diagnostics,
    },
    provider_factory_calls: provider.factoryCallCount(),
    provider_directory_calls: provider.directoryCallCount(),
    checks_passed: Object.values(assertions).filter(Boolean).length,
    expected_checks: Object.keys(assertions).length,
  };
}

async function focusedResolvedForwardScenario(connectionString: string) {
  const beforeAudit = await productionAudit(connectionString);
  if (beforeAudit.temporary_audit_schema_count !== 0) {
    throw new Error("focused_audit_requires_clean_schema_prefix");
  }
  const schema = `${AUDIT_SCHEMA_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
  assertAuditSchema(schema);
  const admin = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_work_member_current_focused_audit" },
  });
  let isolatedDb: ReturnType<typeof createDbFromConnectionString> | null = null;
  let result: Record<string, unknown> | null = null;
  let primaryError: unknown = null;
  const cleanupErrors: string[] = [];
  let schemaRemoved = false;
  try {
    await admin.unsafe(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    isolatedDb = createDbFromConnectionString(connectionString, 1, {
      searchPath: schema,
      applicationName: "cinashop_work_member_current_focused_schema_audit",
    });
    const container = createContainerFromDb(isolatedDb);
    await setupIsolatedSchema(container);
    await applyWorkMemberMigrations(container);

    const corpId = "focusedservice";
    const provider = createAuditProviderController();
    const service = new EnterpriseWechatCallbackService(
      container,
      {
        ORDER_QUEUE: noDispatchAuditQueue(),
        WECHAT_WORK_MEMBER_CURRENT_AUTHORITY: "verified",
      },
      provider.factory,
    );
    const update = await auditResolvedForwardRenameScenario(
      service,
      provider,
      admin,
      schema,
      corpId,
      "resolved-forward-update",
      10_000,
      "update_user",
    );
    const deleted = await auditResolvedForwardRenameScenario(
      service,
      provider,
      admin,
      schema,
      corpId,
      "resolved-forward-delete",
      11_000,
      "delete_user",
    );
    const contaminatedUpdate = await auditContaminatedResolvedForwardScenario(
      service,
      provider,
      admin,
      schema,
      "focusreuseupd",
      "resolved-forward-reuse-update",
      12_000,
      "update_user",
    );
    const contaminatedDelete = await auditContaminatedResolvedForwardScenario(
      service,
      provider,
      admin,
      schema,
      "focusreusedel",
      "resolved-forward-reuse-delete",
      13_000,
      "delete_user",
    );
    const rollback = await auditResolvedForwardRollbackScenario(
      service,
      provider,
      admin,
      schema,
      "focusrollback",
      14_000,
    );
    const assertions = {
      resolved_forward_update: update.passed,
      resolved_forward_delete: deleted.passed,
      contaminated_forward_update_quarantined: contaminatedUpdate.passed,
      contaminated_forward_delete_quarantined: contaminatedDelete.passed,
      resolved_forward_post_mutation_failure_rolled_back: rollback.passed,
    };
    result = {
      complete: Object.values(assertions).every(Boolean),
      isolated_schema_only: true,
      contains_identity_values: false,
      provider_is_mocked: true,
      enterprise_wechat_network_calls: 0,
      provider_factory_calls: provider.factoryCallCount(),
      provider_directory_calls: provider.directoryCallCount(),
      assertions,
      outcomes: {
        update: update.outcomes,
        delete: deleted.outcomes,
        contaminated_update: contaminatedUpdate.outcomes,
        contaminated_delete: contaminatedDelete.outcomes,
        rollback: rollback.outcomes,
      },
      diagnostics: {
        update: update.diagnostics,
        delete: deleted.diagnostics,
        contaminated_update: contaminatedUpdate.diagnostics,
        contaminated_delete: contaminatedDelete.diagnostics,
        rollback: rollback.diagnostics,
      },
      terminal_error_codes: {
        update: update.terminal_error_codes,
        delete: deleted.terminal_error_codes,
      },
      failed_checks: Object.entries(assertions)
        .filter(([, passed]) => !passed)
        .map(([name]) => name),
    };
  } catch (error) {
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
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      const removedRows = await admin<Array<{ removed: boolean }>>`
        SELECT to_regnamespace(${schema}) IS NULL AS removed
      `;
      schemaRemoved = Boolean(removedRows[0]?.removed);
      if (!schemaRemoved) cleanupErrors.push("temporary_schema_still_resolves");
    } catch {
      cleanupErrors.push("temporary_schema_drop_failed");
    }
    try {
      await admin.end({ timeout: 1 });
    } catch {
      cleanupErrors.push("admin_client_close_failed");
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) {
    throw new Error(`focused cleanup assertions failed: ${cleanupErrors.join(",")}`);
  }
  if (!result) throw new Error("focused audit produced no complete result");

  const afterAudit = await productionAudit(connectionString);
  const publicGuardUnchanged = afterAudit.temporary_audit_schema_count === 0
    && sameJson(beforeAudit.table_counts, afterAudit.table_counts)
    && sameJson(beforeAudit.legacy_aggregate_audit, afterAudit.legacy_aggregate_audit)
    && sameJson(beforeAudit.current_aggregate_audit, afterAudit.current_aggregate_audit);
  if (!publicGuardUnchanged) throw new Error("focused_public_guard_changed");
  return {
    ...result,
    temporary_schema_removed: schemaRemoved,
    public_target_counts_and_aggregates_unchanged: publicGuardUnchanged,
    temporary_audit_schema_count: afterAudit.temporary_audit_schema_count,
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
    connection: { application_name: "cinashop_work_member_current_isolated_audit" },
  });
  let isolatedDb: ReturnType<typeof createDbFromConnectionString> | null = null;
  let beforePublic: PublicSafetySnapshot | null = null;
  let afterPublic: PublicSafetySnapshot | null = null;
  let beforeSchemaCount: number | null = null;
  let result: Record<string, unknown> | null = null;
  let primaryError: unknown = null;
  let auditStage = "public_snapshot_before";
  const cleanupErrors: string[] = [];
  let schemaRemoved = false;

  try {
    beforePublic = await publicSafetySnapshot(admin);
    const prefixRows = await admin<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM pg_namespace WHERE nspname LIKE ${`${AUDIT_SCHEMA_PREFIX}%`}
    `;
    beforeSchemaCount = prefixRows[0]?.count ?? 0;
    auditStage = "schema_create";
    await admin.unsafe(`CREATE SCHEMA ${quoteIdentifier(schema)}`);

    isolatedDb = createDbFromConnectionString(connectionString, 1, {
      searchPath: schema,
      applicationName: "cinashop_work_member_current_schema_audit",
    });
    const container = createContainerFromDb(isolatedDb);
    auditStage = "prerequisite_schema";
    await setupIsolatedSchema(container);
    auditStage = "migration_baseline_0109_0112";
    await applyWorkMemberBaselineMigrations(container);
    auditStage = "stable_seed";
    const seed = await seedStableRows(admin, schema);

    auditStage = "migration_0112_verifier_negative";
    const verifierNegativeScenario = await migrationVerifierNegativeScenario(
      container,
      admin,
      schema,
    );
    auditStage = "migration_0113_preflight_negative";
    const resolvedFencePreflightNegative = await resolvedRenameFencePreflightNegativeScenario(
      container,
      admin,
      schema,
    );

    auditStage = "migration_0113_first";
    await applyResolvedRenameFenceMigration(container);

    auditStage = "first_fingerprint";
    const objectsAfterFirstPass = await isolatedObjectFingerprint(admin, schema);
    const tuplesAfterFirstPass = await isolatedTupleFingerprint(admin, schema);
    const sequencesAfterFirstPass = await isolatedSequenceFingerprint(admin, schema);

    auditStage = "migration_0113_second";
    await applyResolvedRenameFenceMigration(container);

    auditStage = "second_fingerprint";
    const objectsAfterSecondPass = await isolatedObjectFingerprint(admin, schema);
    const tuplesAfterSecondPass = await isolatedTupleFingerprint(admin, schema);
    const sequencesAfterSecondPass = await isolatedSequenceFingerprint(admin, schema);
    const migrationAssertions = {
      migration_objects_oid_and_relfilenode_stable:
        objectsAfterFirstPass.length > 0
        && sameJson(objectsAfterFirstPass, objectsAfterSecondPass),
      existing_rows_ctid_xmin_stable:
        tuplesAfterFirstPass.every((row) => row.rows === "1")
        && sameJson(tuplesAfterFirstPass, tuplesAfterSecondPass),
      sequence_values_stable:
        sequencesAfterFirstPass.length >= 3
        && sameJson(sequencesAfterFirstPass, sequencesAfterSecondPass),
    };
    if (!Object.values(migrationAssertions).every(Boolean)) {
      throw new Error("isolated migration identity assertions failed");
    }

    auditStage = "migration_0113_verifier_negative";
    const resolvedFenceVerifierNegative = await resolvedRenameFenceVerifierNegativeScenario(
      container,
      admin,
      schema,
    );

    auditStage = "direct_sql_smoke";
    const smoke = await currentMemberSmoke(admin, schema, seed);
    auditStage = "callback_service";
    const serviceScenario = await enterpriseWechatMemberServiceScenario(
      container,
      admin,
      schema,
    );
    const failedChecks = [
      ...Object.entries(verifierNegativeScenario.assertions)
        .filter(([, passed]) => !passed)
        .map(([name]) => `migration_verifier.${name}`),
      ...Object.entries(resolvedFencePreflightNegative.assertions)
        .filter(([, passed]) => !passed)
        .map(([name]) => `migration_0113_preflight.${name}`),
      ...Object.entries(resolvedFenceVerifierNegative.assertions)
        .filter(([, passed]) => !passed)
        .map(([name]) => `migration_0113_verifier.${name}`),
      ...Object.entries(smoke.assertions)
        .filter(([, passed]) => !passed)
        .map(([name]) => `direct_sql.${name}`),
      ...Object.entries(serviceScenario.assertions)
        .filter(([, passed]) => !passed)
        .map(([name]) => `callback_service.${name}`),
    ];

    result = {
      complete: failedChecks.length === 0,
      isolated_schema_only: true,
      contains_identity_values: false,
      migration_passes: 2,
      migration_assertions: migrationAssertions,
      migration_object_count: objectsAfterSecondPass.length,
      stable_existing_table_count: tuplesAfterSecondPass.length,
      stable_sequence_count: sequencesAfterSecondPass.length,
      migration_verifier_negative_scenario: verifierNegativeScenario,
      resolved_rename_fence_preflight_negative_scenario: resolvedFencePreflightNegative,
      resolved_rename_fence_verifier_negative_scenario: resolvedFenceVerifierNegative,
      current_member_smoke: smoke,
      callback_service_member_scenario: serviceScenario,
      failed_checks: failedChecks,
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
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      const removedRows = await admin<Array<{ removed: boolean }>>`
        SELECT to_regnamespace(${schema}) IS NULL AS removed
      `;
      schemaRemoved = Boolean(removedRows[0]?.removed);
      if (!schemaRemoved) cleanupErrors.push("temporary_schema_still_resolves");
    } catch {
      cleanupErrors.push("temporary_schema_drop_failed");
    }
    try {
      if (beforeSchemaCount !== null) {
        const prefixRows = await admin<Array<{ count: number }>>`
          SELECT count(*)::integer AS count
          FROM pg_namespace WHERE nspname LIKE ${`${AUDIT_SCHEMA_PREFIX}%`}
        `;
        if (prefixRows[0]?.count !== beforeSchemaCount) {
          cleanupErrors.push("temporary_schema_prefix_count_changed");
        }
      }
      if (beforePublic) {
        afterPublic = await publicSafetySnapshot(admin);
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
    throw new Error(`isolated audit and cleanup failed: ${cleanupErrors.join(",")}`);
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new Error(`isolated cleanup assertions failed: ${cleanupErrors.join(",")}`);
  }
  if (!result || !beforePublic || !afterPublic) {
    throw new Error("isolated audit produced no complete result");
  }
  const beforeSummary = {
    table_count: beforePublic.tables.length,
    sequence_count: beforePublic.sequences.length,
    digest: await sha256Json(beforePublic),
  };
  const afterSummary = {
    table_count: afterPublic.tables.length,
    sequence_count: afterPublic.sequences.length,
    digest: await sha256Json(afterPublic),
  };
  return {
    ...result,
    temporary_schema_removed: schemaRemoved,
    public_full_snapshot: {
      before: beforeSummary,
      after: afterSummary,
      all_table_row_counts_unchanged: sameJson(
        beforePublic.tables.map((row) => [row.table, row.rows]),
        afterPublic.tables.map((row) => [row.table, row.rows]),
      ),
      all_table_mvcc_aggregate_fingerprints_unchanged: sameJson(
        beforePublic.tables.map((row) => [row.table, row.fingerprint]),
        afterPublic.tables.map((row) => [row.table, row.fingerprint]),
      ),
      all_sequence_values_unchanged: sameJson(beforePublic.sequences, afterPublic.sequences),
      complete_snapshot_unchanged: sameJson(beforePublic, afterPublic),
    },
  };
}

function safeErrorCode(error: unknown): string {
  const postgresCode = postgresErrorCode(error);
  if (postgresCode && /^[A-Z0-9]{5}$/.test(postgresCode)) return postgresCode;
  if (!(error instanceof Error)) return "unknown_error";
  if (/public rows sequences or mvcc/i.test(error.message)) return "public_snapshot_changed";
  if (/cleanup/i.test(error.message)) return "cleanup_failed";
  if (/migration/i.test(error.message)) return "migration_audit_failed";
  if (/smoke/i.test(error.message)) return "member_smoke_failed";
  return "audit_failed";
}

function safeErrorField(error: unknown, field: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = Reflect.get(error, field);
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : undefined;
}

function safeAuditDiagnostic(error: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries({
    audit_stage: safeErrorField(error, "audit_stage"),
    constraint_name: safeErrorField(error, "constraint_name"),
    table_name: safeErrorField(error, "table_name"),
  }).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function noStoreJson(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(value, { ...init, headers });
}

export default {
  async fetch(request: Request, env: MemberCurrentAuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method !== "POST"
      || url.search !== ""
      || !["/audit", "/migrate", "/isolated", "/focused"].includes(url.pathname)
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
          ? await migrateProductionMemberCurrent(env.HYPERDRIVE.connectionString)
          : url.pathname === "/isolated"
            ? await isolatedScenario(env.HYPERDRIVE.connectionString)
            : await focusedResolvedForwardScenario(env.HYPERDRIVE.connectionString);
      return noStoreJson({ request_id: requestId, ...result });
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const diagnostic = safeAuditDiagnostic(error);
      console.error(JSON.stringify({
        event: "enterprise_wechat_member_current_audit_failed",
        request_id: requestId,
        error_code: errorCode,
        ...diagnostic,
      }));
      return noStoreJson({
        error: "audit_failed",
        error_code: errorCode,
        request_id: requestId,
        ...diagnostic,
      }, { status: 500 });
    }
  },
} satisfies ExportedHandler<MemberCurrentAuditEnv>;
