import { createHash } from "node:crypto";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import postgres from "postgres";
import {
  MIGRATION_MANIFEST_VERSION,
  MIGRATION_TABLES,
  type MigrationTableSpec,
} from "./manifest.js";

export interface LiveColumn {
  table: string;
  name: string;
  dataType: string;
  nullable: boolean;
  hasDefault: boolean;
  identity: boolean;
  primaryKey: boolean;
  unsigned?: boolean;
  numericPrecision?: number;
  numericScale?: number;
  characterMaximumLength?: number;
}

export interface ColumnConversion {
  column: string;
  kind:
    | "epoch_seconds_to_timestamp"
    | "timestamp_to_epoch_seconds"
    | "numeric_string_to_integer"
    | "epoch_string_to_timestamp"
    | "parse_json"
    | "json_to_text";
}

export interface IntegerRangeCheck {
  column: string;
  sourceColumn: string;
  minimum: string;
  maximum: string;
}

export interface SourceSentinelCheck {
  column: string;
  kind: "empty_string_to_null" | "zero_to_null";
}

export interface SourceNumericStringCheck {
  column: string;
  maximum: string;
}

export interface TableTransferPlan {
  spec: MigrationTableSpec;
  sourceTable: string;
  /** Target column names written to PostgreSQL, in source schema order. */
  columns: string[];
  /** Target serial/identity columns explicitly populated by the copy. */
  targetIdentityColumns: string[];
  /** Explicit resolved target-column to source-column transfer map. */
  sourceColumnByTarget: Record<string, string>;
  /** Source-side columns used for keyset pagination and uniqueness checks. */
  sourceKeyColumns: string[];
  /** Integer components use numeric keyset ordering; text components use binary UTF-8 ordering. */
  keyKinds: MigrationKeyKind[];
  conversions: ColumnConversion[];
  integerRangeChecks: IntegerRangeCheck[];
  sourceNullabilityChecks: string[];
  sourceSentinelChecks: SourceSentinelCheck[];
  sourceNumericStringChecks: SourceNumericStringCheck[];
  targetColumnTypes: Record<string, string>;
  liveChecksVerified: boolean;
  sourceKeyRequiresUniquenessCheck: boolean;
  sourceKeyUniquenessVerified: boolean;
  sourceDuplicateKeyGroups?: number;
  sourceDuplicateExcessRows?: number;
  sourceOnlyColumns: string[];
  targetOnlyRequiredColumns: string[];
  blockers: string[];
  eligible: boolean;
  sourceExists: boolean;
  targetExists: boolean;
  sourceCount?: number;
  targetCount?: number;
}

export interface DatabaseInventory {
  source: Map<string, LiveColumn[]>;
  target: Map<string, LiveColumn[]>;
  sourceUniqueKeys?: Map<string, string[][]>;
  targetUniqueKeys?: Map<string, string[][]>;
}

export interface CopyOptions {
  batchSize: number;
  runId: string;
  sourcePrefix: string;
  selectedTables?: Set<string>;
}

export interface TableCopyResult {
  table: string;
  sourceCount: number;
  insertedCount: number;
  conflictCount: number;
  status: "completed" | "completed_with_conflicts" | "skipped_completed";
}

export interface VerificationIssue {
  key: string;
  kind: "missing_target" | "value_mismatch";
  columns: string[];
}

export interface TableVerificationResult {
  table: string;
  sourceCount: number;
  targetCount: number;
  checkedCount: number;
  missingTargetCount: number;
  mismatchedRowCount: number;
  extraTargetCount: number;
  checkpointStatus: string;
  checkpointSourceCount: number;
  checkpointInsertedCount: number;
  checkpointConflictCount: number;
  status: "passed" | "failed";
  issues: VerificationIssue[];
}

export interface VerifyOptions {
  batchSize: number;
  issueLimit: number;
  runId: string;
}

export interface VerificationReport {
  runId: string;
  runStatus: string;
  passed: boolean;
  tables: TableVerificationResult[];
}

export interface VerificationBatchResult {
  checkedCount: number;
  missingTargetCount: number;
  mismatchedRowCount: number;
  issues: VerificationIssue[];
}

export interface KeysetProgress {
  lastKey: string | null;
  insertedCount: number;
  conflictCount: number;
}

export type MigrationCursor = string[] | null;
export type MigrationKeyKind = "integer" | "text";

export interface CursorProgress {
  lastKey: MigrationCursor;
  insertedCount: number;
  conflictCount: number;
}

export interface CursorKeysetCopyOptions {
  keys: string[];
  keyKinds?: MigrationKeyKind[];
  batchSize: number;
  initial: CursorProgress;
  readBatch: (
    afterKey: MigrationCursor,
    limit: number,
  ) => Promise<Array<Record<string, unknown>>>;
  writeBatch: (
    rows: Array<Record<string, unknown>>,
    nextLastKey: string[],
    current: CursorProgress,
  ) => Promise<{ insertedCount: number; conflictCount: number }>;
}

export interface KeysetCopyOptions {
  key: string;
  batchSize: number;
  initial: KeysetProgress;
  readBatch: (afterKey: string | null, limit: number) => Promise<Array<Record<string, unknown>>>;
  writeBatch: (
    rows: Array<Record<string, unknown>>,
    nextLastKey: string,
    current: KeysetProgress,
  ) => Promise<{ insertedCount: number; conflictCount: number }>;
}

type TargetSql = ReturnType<typeof postgres>;

const INTEGER_TYPES = new Set(["tinyint", "smallint", "mediumint", "int", "integer", "bigint"]);
const DECIMAL_TYPES = new Set(["decimal", "numeric"]);
const FLOAT_TYPES = new Map([
  ["real", 1],
  ["float", 1],
  ["double", 2],
  ["double precision", 2],
]);
const TEXT_TYPES = new Set([
  "char",
  "character",
  "varchar",
  "character varying",
  "text",
  "tinytext",
  "mediumtext",
  "longtext",
  "enum",
  "set",
  "uuid",
]);
const JSON_TYPES = new Set(["json", "jsonb"]);
const TIME_TYPES = new Set(["date", "datetime", "timestamp", "timestamp without time zone", "timestamp with time zone"]);

const SIGNED_INTEGER_RANGES: Record<string, readonly [bigint, bigint]> = {
  tinyint: [-128n, 127n],
  smallint: [-32768n, 32767n],
  mediumint: [-8388608n, 8388607n],
  int: [-2147483648n, 2147483647n],
  integer: [-2147483648n, 2147483647n],
  bigint: [-9223372036854775808n, 9223372036854775807n],
};

const UNSIGNED_INTEGER_MAX: Record<string, bigint> = {
  tinyint: 255n,
  smallint: 65535n,
  mediumint: 16777215n,
  int: 4294967295n,
  integer: 4294967295n,
  bigint: 18446744073709551615n,
};

function normalizeType(type: string): string {
  return type.toLowerCase().replace(/\s+/g, " ").trim();
}

function integerRange(column: LiveColumn): readonly [bigint, bigint] | undefined {
  const type = normalizeType(column.dataType);
  const signed = SIGNED_INTEGER_RANGES[type];
  if (!signed) return undefined;
  return column.unsigned ? [0n, UNSIGNED_INTEGER_MAX[type]] : signed;
}

function decimalCapacity(column: LiveColumn): { integerDigits: number; scale: number } | undefined {
  if (!DECIMAL_TYPES.has(normalizeType(column.dataType))) return undefined;
  if (column.numericPrecision === undefined || column.numericScale === undefined) return undefined;
  return {
    integerDigits: column.numericPrecision - column.numericScale,
    scale: column.numericScale,
  };
}

function planConversion(
  column: string,
  sourceColumnName: string,
  sourceColumn: LiveColumn,
  targetColumn: LiveColumn,
): { compatible: boolean; conversion?: ColumnConversion; rangeCheck?: IntegerRangeCheck } {
  const source = normalizeType(sourceColumn.dataType);
  const target = normalizeType(targetColumn.dataType);
  if (INTEGER_TYPES.has(source) && INTEGER_TYPES.has(target)) {
    const sourceRange = integerRange(sourceColumn)!;
    const targetRange = integerRange(targetColumn)!;
    if (sourceRange[0] >= targetRange[0] && sourceRange[1] <= targetRange[1]) {
      return { compatible: true };
    }
    return {
      compatible: true,
      rangeCheck: {
        column,
        sourceColumn: sourceColumnName,
        minimum: targetRange[0].toString(),
        maximum: targetRange[1].toString(),
      },
    };
  }
  if (DECIMAL_TYPES.has(source) && DECIMAL_TYPES.has(target)) {
    const sourceCapacity = decimalCapacity(sourceColumn);
    const targetCapacity = decimalCapacity(targetColumn);
    if (!sourceCapacity || !targetCapacity) return { compatible: source === target };
    return {
      compatible:
        sourceCapacity.integerDigits <= targetCapacity.integerDigits &&
        sourceCapacity.scale <= targetCapacity.scale,
    };
  }
  if (FLOAT_TYPES.has(source) && FLOAT_TYPES.has(target)) {
    return { compatible: FLOAT_TYPES.get(source)! <= FLOAT_TYPES.get(target)! };
  }
  if (
    (INTEGER_TYPES.has(source) || DECIMAL_TYPES.has(source) || FLOAT_TYPES.has(source)) &&
    (INTEGER_TYPES.has(target) || DECIMAL_TYPES.has(target) || FLOAT_TYPES.has(target))
  ) {
    return { compatible: false };
  }
  if (JSON_TYPES.has(source) && JSON_TYPES.has(target)) return { compatible: true };
  if (TEXT_TYPES.has(source) && JSON_TYPES.has(target)) {
    return { compatible: true, conversion: { column, kind: "parse_json" } };
  }
  if (JSON_TYPES.has(source) && TEXT_TYPES.has(target)) {
    return { compatible: true, conversion: { column, kind: "json_to_text" } };
  }
  if (TEXT_TYPES.has(source) && TEXT_TYPES.has(target)) {
    const sourceLength = sourceColumn.characterMaximumLength;
    const targetLength = targetColumn.characterMaximumLength;
    if (targetLength !== undefined && (sourceLength === undefined || sourceLength > targetLength)) {
      return { compatible: false };
    }
    return { compatible: true };
  }
  if (TIME_TYPES.has(source) && TIME_TYPES.has(target)) {
    if (source === target) return { compatible: true };
    if (source === "date" && target !== "date") return { compatible: true };
    return { compatible: false };
  }
  if (INTEGER_TYPES.has(source) && TIME_TYPES.has(target)) {
    return { compatible: true, conversion: { column, kind: "epoch_seconds_to_timestamp" } };
  }
  if (TIME_TYPES.has(source) && INTEGER_TYPES.has(target)) {
    return { compatible: true, conversion: { column, kind: "timestamp_to_epoch_seconds" } };
  }
  return { compatible: source === target };
}

function mapColumns(columns: LiveColumn[]): Map<string, LiveColumn> {
  return new Map(columns.map((column) => [column.name, column]));
}

function primaryKeyFromColumns(columns: LiveColumn[]): string[][] {
  const key = columns.filter((column) => column.primaryKey).map((column) => column.name);
  return key.length ? [key] : [];
}

function hasUniqueKey(keys: string[][], expected: readonly string[]): boolean {
  return keys.some(
    (key) =>
      key.length === expected.length &&
      key.every((column) => expected.includes(column)),
  );
}

export function buildTransferPlans(
  inventory: DatabaseInventory,
  sourcePrefix: string,
  specs: readonly MigrationTableSpec[] = MIGRATION_TABLES,
): TableTransferPlan[] {
  const targetAssignments = new Map<string, number>();
  const sourceAssignments = new Map<string, string>();
  for (const spec of specs) {
    targetAssignments.set(spec.table, (targetAssignments.get(spec.table) ?? 0) + 1);
    const sourceTable = spec.sourceTable ?? spec.table;
    const existingTarget = sourceAssignments.get(sourceTable);
    if (existingTarget && existingTarget !== spec.table) {
      throw new Error(
        `Migration source table ${sourceTable} is assigned to multiple targets: ${existingTarget}, ${spec.table}`,
      );
    }
    sourceAssignments.set(sourceTable, spec.table);
  }
  const duplicateTarget = [...targetAssignments].find(([, count]) => count > 1)?.[0];
  if (duplicateTarget) {
    throw new Error(`Migration target table is configured more than once: ${duplicateTarget}`);
  }

  return specs.map((spec) => {
    const sourceTable = `${sourcePrefix}${spec.sourceTable ?? spec.table}`;
    const sourceColumns = inventory.source.get(sourceTable) ?? [];
    const targetColumns = inventory.target.get(spec.table) ?? [];
    const sourceExists = inventory.source.has(sourceTable);
    const targetExists = inventory.target.has(spec.table);
    const sourceByName = mapColumns(sourceColumns);
    const targetByName = mapColumns(targetColumns);
    const configuredMappings = spec.columnMappings ?? {};
    const transfers = sourceColumns
      .map((column) => ({
        source: column.name,
        target: configuredMappings[column.name] ?? column.name,
      }))
      .filter((transfer) => targetByName.has(transfer.target));
    const common = transfers.map((transfer) => transfer.target);
    const sourceColumnByTarget = Object.fromEntries(
      transfers.map((transfer) => [transfer.target, transfer.source]),
    );
    const representedTargets = new Set(common);
    const targetIdentityColumns = targetColumns
      .filter((column) => column.identity && representedTargets.has(column.name))
      .map((column) => column.name);
    const sourceOnlyColumns = sourceColumns
      .map((column) => column.name)
      .filter((column) => {
        const target = configuredMappings[column] ?? column;
        return !targetByName.has(target);
      });
    const targetOnlyRequiredColumns = targetColumns
      .filter(
        (column) =>
          !representedTargets.has(column.name) &&
          !column.nullable &&
          !column.hasDefault &&
          !column.identity,
      )
      .map((column) => column.name);
    const blockers: string[] = [];
    const conversions: ColumnConversion[] = [];
    const integerRangeChecks: IntegerRangeCheck[] = [];
    const sourceNullabilityChecks: string[] = [];
    const sourceSentinelChecks: SourceSentinelCheck[] = [];
    const sourceNumericStringChecks: SourceNumericStringCheck[] = [];
    const targetColumnTypes: Record<string, string> = {};
    const sourceUniqueKeys =
      inventory.sourceUniqueKeys?.get(sourceTable) ?? primaryKeyFromColumns(sourceColumns);
    const targetUniqueKeys =
      inventory.targetUniqueKeys?.get(spec.table) ?? primaryKeyFromColumns(targetColumns);
    const sourceKeyColumns = spec.key.map(
      (targetKey) => sourceColumnByTarget[targetKey] ?? targetKey,
    );
    const keyKinds: MigrationKeyKind[] = [];
    let sourceKeyRequiresUniquenessCheck = false;

    if (!sourceExists) blockers.push("source table is missing");
    if (!targetExists) blockers.push("target table is missing");
    for (const [sourceColumn, targetColumn] of Object.entries(configuredMappings)) {
      if (sourceExists && !sourceByName.has(sourceColumn)) {
        blockers.push(`mapped source column is missing: ${sourceColumn}`);
      }
      if (targetExists && !targetByName.has(targetColumn)) {
        blockers.push(`mapped target column is missing: ${targetColumn}`);
      }
    }
    for (const sourceColumn of Object.keys(spec.columnConversions ?? {})) {
      if (sourceExists && !sourceByName.has(sourceColumn)) {
        blockers.push(`conversion source column is missing: ${sourceColumn}`);
      }
      const targetColumn = configuredMappings[sourceColumn] ?? sourceColumn;
      if (targetExists && !targetByName.has(targetColumn)) {
        blockers.push(`conversion target column is missing: ${targetColumn}`);
      }
    }
    const targetAssignments = new Map<string, string[]>();
    for (const transfer of transfers) {
      const sources = targetAssignments.get(transfer.target) ?? [];
      sources.push(transfer.source);
      targetAssignments.set(transfer.target, sources);
    }
    for (const [targetColumn, sourceAssignments] of targetAssignments) {
      if (sourceAssignments.length > 1) {
        blockers.push(
          `multiple source columns map to target column ${targetColumn}: ${sourceAssignments.join(", ")}`,
        );
      }
    }
    if (sourceOnlyColumns.length) {
      blockers.push(`source columns would be discarded: ${sourceOnlyColumns.join(", ")}`);
    }
    if (targetOnlyRequiredColumns.length) {
      blockers.push(
        `required target columns have no source/default: ${targetOnlyRequiredColumns.join(", ")}`,
      );
    }
    const copyStrategy = spec.copyStrategy ?? "keyset";
    if (copyStrategy === "append_multiset") {
      if (spec.key.length) {
        blockers.push("append_multiset copy must not declare a conflict key");
      }
      if (!common.length) blockers.push("append_multiset copy has no mapped columns");
      for (const sourceColumn of sourceColumns) {
        const sourceType = normalizeType(sourceColumn.dataType);
        if (!INTEGER_TYPES.has(sourceType) && !TEXT_TYPES.has(sourceType)) {
          blockers.push(
            `append_multiset source type is unsupported: ${sourceColumn.name} (${sourceColumn.dataType})`,
          );
        }
      }
    } else if (!spec.key.length) {
      blockers.push("source table has no deterministic migration key");
    } else {
      for (const [index, key] of spec.key.entries()) {
        const sourceKeyName = sourceKeyColumns[index];
        const sourceKey = sourceByName.get(sourceKeyName);
        const targetKey = targetByName.get(key);
        if (!sourceKey || !targetKey) {
          blockers.push(`migration key is missing: ${sourceKeyName} -> ${key}`);
          continue;
        }
        const sourceType = normalizeType(sourceKey.dataType);
        const targetType = normalizeType(targetKey.dataType);
        const sourceKind = INTEGER_TYPES.has(sourceType)
          ? "integer"
          : TEXT_TYPES.has(sourceType)
            ? "text"
            : null;
        const targetKind = INTEGER_TYPES.has(targetType)
          ? "integer"
          : TEXT_TYPES.has(targetType)
            ? "text"
            : null;
        if (!sourceKind) {
          blockers.push(`migration key type is unsupported: ${sourceKeyName} (${sourceKey.dataType})`);
        }
        if (!targetKind) {
          blockers.push(`target migration key type is unsupported: ${key} (${targetKey.dataType})`);
        }
        if (sourceKind && targetKind && sourceKind !== targetKind) {
          blockers.push(
            `migration key kinds do not match: ${sourceKeyName} (${sourceKind}) -> ${key} (${targetKind})`,
          );
        }
        keyKinds.push(sourceKind ?? targetKind ?? "integer");
        if (sourceKey.nullable) {
          blockers.push(`source migration key must not be nullable: ${sourceKeyName}`);
        }
        if (targetKey.nullable) blockers.push(`target migration key must not be nullable: ${key}`);
      }
      sourceKeyRequiresUniquenessCheck = !hasUniqueKey(sourceUniqueKeys, sourceKeyColumns);
      if (!hasUniqueKey(targetUniqueKeys, spec.key)) {
        blockers.push(`target conflict key is not unique: ${spec.key.join(", ")}`);
      }
    }

    for (const transfer of transfers) {
      const sourceColumn = sourceByName.get(transfer.source)!;
      const targetColumn = targetByName.get(transfer.target)!;
      targetColumnTypes[transfer.target] = targetColumn.dataType;
      const columnLabel = transfer.source === transfer.target
        ? transfer.target
        : `${transfer.source} -> ${transfer.target}`;
      const explicitConversion = spec.columnConversions?.[transfer.source];
      let compatibility: ReturnType<typeof planConversion>;
      if (explicitConversion === "numeric_string_to_integer") {
        const targetRange = integerRange(targetColumn);
        compatibility = {
          compatible:
            TEXT_TYPES.has(normalizeType(sourceColumn.dataType)) && targetRange !== undefined,
          conversion: { column: transfer.target, kind: explicitConversion },
        };
        if (targetRange) {
          sourceNumericStringChecks.push({
            column: transfer.target,
            maximum: targetRange[1].toString(),
          });
        }
      } else if (explicitConversion === "epoch_string_to_timestamp") {
        compatibility = {
          compatible:
            TEXT_TYPES.has(normalizeType(sourceColumn.dataType)) &&
            TIME_TYPES.has(normalizeType(targetColumn.dataType)),
          conversion: { column: transfer.target, kind: explicitConversion },
        };
        sourceNumericStringChecks.push({
          column: transfer.target,
          maximum: "8640000000000",
        });
      } else {
        compatibility = planConversion(
          transfer.target,
          transfer.source,
          sourceColumn,
          targetColumn,
        );
      }
      if (!compatibility.compatible) {
        blockers.push(
          `incompatible type for ${columnLabel}: ${sourceColumn.dataType} -> ${targetColumn.dataType}`,
        );
      } else if (compatibility.conversion) {
        conversions.push(compatibility.conversion);
      }
      if (compatibility.rangeCheck) integerRangeChecks.push(compatibility.rangeCheck);
      if (sourceColumn.nullable && !targetColumn.nullable) {
        sourceNullabilityChecks.push(transfer.target);
      }
      if (!targetColumn.nullable && compatibility.conversion?.kind === "parse_json") {
        sourceSentinelChecks.push({ column: transfer.target, kind: "empty_string_to_null" });
      }
      if (
        !targetColumn.nullable &&
        compatibility.conversion?.kind === "epoch_seconds_to_timestamp"
      ) {
        sourceSentinelChecks.push({ column: transfer.target, kind: "zero_to_null" });
      }
    }

    return {
      spec,
      sourceTable,
      columns: common,
      targetIdentityColumns,
      sourceColumnByTarget,
      sourceKeyColumns,
      keyKinds,
      conversions,
      integerRangeChecks,
      sourceNullabilityChecks,
      sourceSentinelChecks,
      sourceNumericStringChecks,
      targetColumnTypes,
      liveChecksVerified: false,
      sourceKeyRequiresUniquenessCheck,
      sourceKeyUniquenessVerified: !sourceKeyRequiresUniquenessCheck,
      sourceOnlyColumns,
      targetOnlyRequiredColumns,
      blockers,
      eligible: blockers.length === 0 && !sourceKeyRequiresUniquenessCheck,
      sourceExists,
      targetExists,
    };
  });
}

export function quoteMysqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe MySQL identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}

function groupColumns(rows: LiveColumn[]): Map<string, LiveColumn[]> {
  const grouped = new Map<string, LiveColumn[]>();
  for (const row of rows) {
    const existing = grouped.get(row.table) ?? [];
    existing.push(row);
    grouped.set(row.table, existing);
  }
  return grouped;
}

function groupUniqueKeys(
  rows: Array<{
    table: string;
    index: string;
    column: string | null;
    position: number;
    usable?: boolean;
  }>,
): Map<string, string[][]> {
  const indexes = new Map<
    string,
    { usable: boolean; entries: Array<{ column: string; position: number }> }
  >();
  for (const row of rows) {
    const identity = `${row.table}\0${row.index}`;
    const index = indexes.get(identity) ?? { usable: true, entries: [] };
    index.usable = index.usable && row.usable !== false && row.column !== null;
    if (row.column !== null) {
      index.entries.push({ column: row.column, position: row.position });
    }
    indexes.set(identity, index);
  }
  const tables = new Map<string, string[][]>();
  for (const [identity, index] of indexes) {
    if (!index.usable || !index.entries.length) continue;
    const table = identity.slice(0, identity.indexOf("\0"));
    const keys = tables.get(table) ?? [];
    keys.push(
      index.entries
        .sort((left, right) => left.position - right.position)
        .map((entry) => entry.column),
    );
    tables.set(table, keys);
  }
  return tables;
}

export async function openSource(sourceUrl: string): Promise<Connection> {
  const connection = await mysql.createConnection({
    uri: sourceUrl,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false,
  });
  await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await connection.query("SET SESSION TRANSACTION READ ONLY");
  await connection.query("SET SESSION MAX_EXECUTION_TIME = 30000");
  return connection;
}

export function openTarget(targetUrl: string): TargetSql {
  return postgres(targetUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
  });
}

export async function inspectDatabases(
  source: Connection,
  target: TargetSql,
): Promise<DatabaseInventory> {
  const [sourceRows] = await source.query<RowDataPacket[]>(`
    SELECT
      TABLE_NAME AS table_name,
      COLUMN_NAME AS column_name,
      DATA_TYPE AS data_type,
      COLUMN_TYPE AS column_type,
      NUMERIC_PRECISION AS numeric_precision,
      NUMERIC_SCALE AS numeric_scale,
      CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
      IS_NULLABLE AS is_nullable,
      COLUMN_DEFAULT AS column_default,
      EXTRA AS extra,
      COLUMN_KEY AS column_key
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME, ORDINAL_POSITION
  `);
  const [sourceIndexRows] = await source.query<RowDataPacket[]>(`
    SELECT
      TABLE_NAME AS table_name,
      INDEX_NAME AS index_name,
      COLUMN_NAME AS column_name,
      SEQ_IN_INDEX AS position,
      (COLUMN_NAME IS NOT NULL AND SUB_PART IS NULL) AS usable
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND NON_UNIQUE = 0
    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
  `);
  const targetRows = await target<
    Array<{
      table_name: string;
      column_name: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
      character_maximum_length: number | null;
      is_nullable: "YES" | "NO";
      column_default: string | null;
      is_identity: "YES" | "NO";
      primary_key: boolean;
    }>
  >`
    SELECT
      columns.table_name,
      columns.column_name,
      columns.data_type,
      columns.numeric_precision,
      columns.numeric_scale,
      columns.character_maximum_length,
      columns.is_nullable,
      columns.column_default,
      columns.is_identity,
      EXISTS (
        SELECT 1
        FROM information_schema.table_constraints AS constraints
        JOIN information_schema.key_column_usage AS keys
          ON keys.constraint_name = constraints.constraint_name
         AND keys.constraint_schema = constraints.constraint_schema
         AND keys.table_name = constraints.table_name
        WHERE constraints.constraint_type = 'PRIMARY KEY'
          AND constraints.table_schema = columns.table_schema
          AND constraints.table_name = columns.table_name
          AND keys.column_name = columns.column_name
      ) AS primary_key
    FROM information_schema.columns AS columns
    WHERE columns.table_schema = 'public'
    ORDER BY columns.table_name, columns.ordinal_position
  `;
  const targetIndexRows = await target<
    Array<{
      table_name: string;
      index_name: string;
      column_name: string;
      position: number;
    }>
  >`
    SELECT
      target_table.relname AS table_name,
      target_index.relname AS index_name,
      target_attribute.attname AS column_name,
      index_column.ordinality::integer AS position
    FROM pg_catalog.pg_index AS target_definition
    JOIN pg_catalog.pg_class AS target_table
      ON target_table.oid = target_definition.indrelid
    JOIN pg_catalog.pg_namespace AS target_namespace
      ON target_namespace.oid = target_table.relnamespace
    JOIN pg_catalog.pg_class AS target_index
      ON target_index.oid = target_definition.indexrelid
    CROSS JOIN LATERAL unnest(target_definition.indkey)
      WITH ORDINALITY AS index_column(attnum, ordinality)
    JOIN pg_catalog.pg_attribute AS target_attribute
      ON target_attribute.attrelid = target_table.oid
     AND target_attribute.attnum = index_column.attnum
    WHERE target_namespace.nspname = 'public'
      AND target_definition.indisunique
      AND target_definition.indisvalid
      AND target_definition.indisready
      AND target_definition.indimmediate
      AND target_definition.indpred IS NULL
      AND target_definition.indexprs IS NULL
      AND index_column.ordinality <= target_definition.indnkeyatts
    ORDER BY target_table.relname, target_index.relname, index_column.ordinality
  `;

  const sourceColumns = sourceRows.map<LiveColumn>((row) => ({
    table: String(row.table_name).toLowerCase(),
    name: String(row.column_name).toLowerCase(),
    dataType: String(row.data_type).toLowerCase(),
    nullable: row.is_nullable === "YES",
    hasDefault: row.column_default !== null,
    identity: String(row.extra).toLowerCase().includes("auto_increment"),
    primaryKey: row.column_key === "PRI",
    unsigned: /\bunsigned\b/i.test(String(row.column_type)),
    numericPrecision:
      row.numeric_precision === null || row.numeric_precision === undefined
        ? undefined
        : Number(row.numeric_precision),
    numericScale:
      row.numeric_scale === null || row.numeric_scale === undefined
        ? undefined
        : Number(row.numeric_scale),
    characterMaximumLength:
      row.character_maximum_length === null || row.character_maximum_length === undefined
        ? undefined
        : Number(row.character_maximum_length),
  }));
  const targetColumns = targetRows.map<LiveColumn>((row) => ({
    table: row.table_name.toLowerCase(),
    name: row.column_name.toLowerCase(),
    dataType: row.data_type.toLowerCase(),
    nullable: row.is_nullable === "YES",
    hasDefault: row.column_default !== null,
    identity: row.is_identity === "YES" || row.column_default?.startsWith("nextval(") === true,
    primaryKey: row.primary_key,
    numericPrecision: row.numeric_precision ?? undefined,
    numericScale: row.numeric_scale ?? undefined,
    characterMaximumLength: row.character_maximum_length ?? undefined,
  }));
  const sourceUniqueKeys = groupUniqueKeys(
    sourceIndexRows.map((row) => ({
      table: String(row.table_name).toLowerCase(),
      index: String(row.index_name).toLowerCase(),
      column: row.column_name === null ? null : String(row.column_name).toLowerCase(),
      position: Number(row.position),
      usable: Number(row.usable) === 1,
    })),
  );
  const targetUniqueKeys = groupUniqueKeys(
    targetIndexRows.map((row) => ({
      table: row.table_name.toLowerCase(),
      index: row.index_name.toLowerCase(),
      column: row.column_name.toLowerCase(),
      position: Number(row.position),
      usable: true,
    })),
  );
  return {
    source: groupColumns(sourceColumns),
    target: groupColumns(targetColumns),
    sourceUniqueKeys,
    targetUniqueKeys,
  };
}

export async function addTableCounts(
  source: Connection,
  target: TargetSql,
  plans: TableTransferPlan[],
): Promise<void> {
  for (const plan of plans) {
    if (plan.sourceExists) {
      const [sourceRows] = await source.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS count FROM ${quoteMysqlIdentifier(plan.sourceTable)}`,
      );
      plan.sourceCount = parseRowCount(sourceRows[0]?.count, `${plan.sourceTable} source`);
      for (const check of plan.integerRangeChecks) {
        const identifier = quoteMysqlIdentifier(check.sourceColumn);
        const [rangeRows] = await source.query<RowDataPacket[]>(
          `SELECT MIN(${identifier}) AS min_value, MAX(${identifier}) AS max_value
           FROM ${quoteMysqlIdentifier(plan.sourceTable)}`,
        );
        const blocker = integerRangeBlocker(
          check,
          rangeRows[0]?.min_value,
          rangeRows[0]?.max_value,
        );
        if (blocker) plan.blockers.push(blocker);
      }
      for (const column of plan.sourceNullabilityChecks) {
        const sourceColumn = plan.sourceColumnByTarget[column] ?? column;
        const identifier = quoteMysqlIdentifier(sourceColumn);
        const [nullRows] = await source.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS null_count
           FROM ${quoteMysqlIdentifier(plan.sourceTable)}
           WHERE ${identifier} IS NULL`,
        );
        const nullCount = parseRowCount(
          nullRows[0]?.null_count,
          `${plan.sourceTable}.${sourceColumn} NULL`,
        );
        if (nullCount > 0) {
          plan.blockers.push(
            `source NULL values cannot populate required target column: ${column} (${nullCount} row(s))`,
          );
        }
      }
      for (const check of plan.sourceSentinelChecks) {
        const sourceColumn = plan.sourceColumnByTarget[check.column] ?? check.column;
        const identifier = quoteMysqlIdentifier(sourceColumn);
        const predicate = check.kind === "zero_to_null"
          ? `${identifier} = 0`
          : `${identifier} = ''`;
        const [sentinelRows] = await source.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS sentinel_count
           FROM ${quoteMysqlIdentifier(plan.sourceTable)}
           WHERE ${predicate}`,
        );
        const sentinelCount = parseRowCount(
          sentinelRows[0]?.sentinel_count,
          `${plan.sourceTable}.${sourceColumn} sentinel`,
        );
        if (sentinelCount > 0) {
          plan.blockers.push(
            `source sentinel values convert to NULL for required target column: ${check.column}` +
              ` (${sentinelCount} row(s), ${check.kind})`,
          );
        }
      }
      for (const check of plan.sourceNumericStringChecks) {
        const sourceColumn = plan.sourceColumnByTarget[check.column] ?? check.column;
        const identifier = quoteMysqlIdentifier(sourceColumn);
        const [formatRows] = await source.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS invalid_count
           FROM ${quoteMysqlIdentifier(plan.sourceTable)}
           WHERE ${identifier} IS NOT NULL
             AND ${identifier} <> ''
             AND (
               ${identifier} NOT REGEXP '^[0-9]+$'
               OR CAST(${identifier} AS DECIMAL(65, 0)) > ${check.maximum}
             )`,
        );
        const invalidCount = parseRowCount(
          formatRows[0]?.invalid_count,
          `${plan.sourceTable}.${sourceColumn} numeric string`,
        );
        if (invalidCount > 0) {
          plan.blockers.push(
            `source numeric strings cannot populate ${check.column}` +
              ` (${invalidCount} invalid or out-of-range row(s))`,
          );
        }
      }
      if (
        plan.sourceKeyRequiresUniquenessCheck &&
        plan.spec.key.length > 0 &&
        plan.spec.key.every((key) => plan.columns.includes(key))
      ) {
        const duplicates = await inspectSourceMigrationKeyDuplicates(source, plan);
        plan.sourceDuplicateKeyGroups = duplicates.groupCount;
        plan.sourceDuplicateExcessRows = duplicates.excessRowCount;
        plan.sourceKeyUniquenessVerified = duplicates.groupCount === 0;
        if (duplicates.groupCount > 0) {
          const blocker =
            `duplicate source migration key values: ${plan.spec.key.join(", ")}` +
            ` (${duplicates.groupCount} group(s), ${duplicates.excessRowCount} excess row(s))`;
          if (!plan.blockers.includes(blocker)) plan.blockers.push(blocker);
        }
      }
      plan.eligible =
        plan.blockers.length === 0 &&
        (!plan.sourceKeyRequiresUniquenessCheck || plan.sourceKeyUniquenessVerified);
    }
    if (plan.targetExists) {
      const targetRows = await target<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM ${target(plan.spec.table)}
      `;
      plan.targetCount = parseRowCount(targetRows[0]?.count, `${plan.spec.table} target`);
    }
    plan.liveChecksVerified = true;
  }
}

export async function hasDuplicateSourceMigrationKeys(
  source: Pick<Connection, "query">,
  plan: Pick<TableTransferPlan, "sourceTable" | "spec" | "sourceKeyColumns">,
): Promise<boolean> {
  return (await inspectSourceMigrationKeyDuplicates(source, plan)).groupCount > 0;
}

export async function inspectSourceMigrationKeyDuplicates(
  source: Pick<Connection, "query">,
  plan: Pick<TableTransferPlan, "sourceTable" | "spec" | "sourceKeyColumns">,
): Promise<{ groupCount: number; excessRowCount: number }> {
  if (!plan.spec.key.length) throw new Error(`${plan.spec.table}: migration key is missing`);
  const groupBy = plan.sourceKeyColumns.map(quoteMysqlIdentifier).join(", ");
  const [rows] = await source.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS duplicate_group_count,
            COALESCE(SUM(duplicate_count - 1), 0) AS duplicate_excess_row_count
     FROM (
       SELECT COUNT(*) AS duplicate_count
       FROM ${quoteMysqlIdentifier(plan.sourceTable)}
       GROUP BY ${groupBy}
       HAVING COUNT(*) > 1
     ) AS duplicate_keys`,
  );
  return {
    groupCount: parseRowCount(rows[0]?.duplicate_group_count, `${plan.spec.table} duplicate group`),
    excessRowCount: parseRowCount(
      rows[0]?.duplicate_excess_row_count,
      `${plan.spec.table} duplicate excess row`,
    ),
  };
}

export function integerRangeBlocker(
  check: IntegerRangeCheck,
  minimumValue: unknown,
  maximumValue: unknown,
): string | undefined {
  if (minimumValue === null || minimumValue === undefined) return undefined;
  if (maximumValue === null || maximumValue === undefined) return undefined;
  try {
    const actualMinimum = BigInt(String(minimumValue));
    const actualMaximum = BigInt(String(maximumValue));
    if (actualMinimum < BigInt(check.minimum) || actualMaximum > BigInt(check.maximum)) {
      return `values outside target integer range for ${check.column}: ${actualMinimum}..${actualMaximum} not within ${check.minimum}..${check.maximum}`;
    }
  } catch {
    return `could not validate integer range for ${check.column}`;
  }
  return undefined;
}

function parseRowCount(value: unknown, label: string): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${label} row count exceeds the safe migration counter range`);
  }
  return count;
}

export function sourceFingerprint(sourceUrl: string, prefix: string): string {
  const parsed = new URL(sourceUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const identity = `${parsed.hostname.toLowerCase()}:${parsed.port || "3306"}/${database}/${prefix}`;
  return createHash("sha256").update(identity).digest("hex");
}

export function convertRowForTarget(
  row: Record<string, unknown>,
  conversions: ColumnConversion[],
): Record<string, unknown> {
  const converted = { ...row };
  for (const conversion of conversions) {
    const value = converted[conversion.column];
    if (conversion.kind === "parse_json") {
      if (value === null || value === undefined || value === "") {
        converted[conversion.column] = null;
      } else if (typeof value === "string") {
        try {
          converted[conversion.column] = JSON.parse(value);
        } catch {
          throw new Error(`Invalid JSON in ${conversion.column}`);
        }
      }
      continue;
    }
    if (conversion.kind === "json_to_text") {
      if (value !== null && value !== undefined && typeof value !== "string") {
        converted[conversion.column] = JSON.stringify(value);
      }
      continue;
    }
    if (conversion.kind === "numeric_string_to_integer") {
      if (value === null || value === undefined || value === "") {
        converted[conversion.column] = 0;
      } else {
        const raw = String(value);
        if (!/^\d+$/.test(raw)) {
          throw new Error(`Invalid numeric string in ${conversion.column}`);
        }
        const integer = Number(raw);
        if (!Number.isSafeInteger(integer)) {
          throw new Error(`Numeric string exceeds safe range in ${conversion.column}`);
        }
        converted[conversion.column] = integer;
      }
      continue;
    }
    if (
      conversion.kind === "epoch_seconds_to_timestamp" ||
      conversion.kind === "epoch_string_to_timestamp"
    ) {
      if (value === null || value === undefined || value === 0 || value === "0" || value === "") {
        converted[conversion.column] = null;
      } else {
        const raw = String(value);
        if (conversion.kind === "epoch_string_to_timestamp" && !/^\d+$/.test(raw)) {
          throw new Error(`Invalid epoch string in ${conversion.column}`);
        }
        const seconds = Number(raw);
        if (!Number.isSafeInteger(seconds) || seconds < 0) {
          throw new Error(`Invalid epoch seconds in ${conversion.column}`);
        }
        const timestamp = new Date(seconds * 1000);
        if (Number.isNaN(timestamp.getTime())) {
          throw new Error(`Epoch seconds exceed timestamp range in ${conversion.column}`);
        }
        converted[conversion.column] = timestamp;
      }
    } else if (conversion.kind === "timestamp_to_epoch_seconds") {
      if (value === null || value === undefined || value === "") {
        converted[conversion.column] = 0;
      } else {
        const date = value instanceof Date ? value : new Date(String(value));
        if (Number.isNaN(date.getTime())) {
          throw new Error(`Invalid timestamp in ${conversion.column}`);
        }
        converted[conversion.column] = Math.floor(date.getTime() / 1000);
      }
    }
  }
  return converted;
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeDecimal(value: unknown): string {
  const raw = String(value).trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return raw;
  const integer = match[2].replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const zero = /^0+$/.test(integer) && !fraction;
  const sign = zero || match[1] !== "-" ? "" : "-";
  return `${sign}${integer}${fraction ? `.${fraction}` : ""}`;
}

export function canonicalColumnValue(dataType: string, value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const type = normalizeType(dataType);
  if (INTEGER_TYPES.has(type)) {
    try {
      return `integer:${BigInt(String(value)).toString()}`;
    } catch {
      return `invalid-integer:${String(value)}`;
    }
  }
  if (DECIMAL_TYPES.has(type)) return `decimal:${normalizeDecimal(value)}`;
  if (FLOAT_TYPES.has(type)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `float:${numeric}` : `invalid-float:${String(value)}`;
  }
  if (JSON_TYPES.has(type)) {
    if (typeof value === "string") {
      try {
        return `json:${stableJson(JSON.parse(value))}`;
      } catch {
        return `invalid-json:${value}`;
      }
    }
    return `json:${stableJson(value)}`;
  }
  if (TIME_TYPES.has(type)) {
    if (type === "date") return `date:${String(value).slice(0, 10)}`;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime())
      ? `invalid-time:${String(value)}`
      : `time:${date.toISOString()}`;
  }
  if (type === "boolean") {
    return `boolean:${value === true || value === 1 || value === "1" || value === "true"}`;
  }
  if (value instanceof Uint8Array) {
    return `bytes:${Buffer.from(value).toString("base64")}`;
  }
  return `text:${String(value)}`;
}

export function compareConvertedRows(
  plan: Pick<TableTransferPlan, "columns" | "targetColumnTypes">,
  sourceRow: Record<string, unknown>,
  targetRow: Record<string, unknown>,
): string[] {
  return plan.columns.filter(
    (column) =>
      canonicalColumnValue(plan.targetColumnTypes[column], sourceRow[column]) !==
      canonicalColumnValue(plan.targetColumnTypes[column], targetRow[column]),
  );
}

async function assertControlSchema(target: TargetSql): Promise<void> {
  const rows = await target<Array<{ ready: boolean }>>`
    SELECT to_regclass('public.data_migration_run') IS NOT NULL
       AND to_regclass('public.data_migration_checkpoint') IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'data_migration_checkpoint'
           AND column_name = 'last_key_json'
       ) AS ready
  `;
  if (!rows[0]?.ready) {
    throw new Error(
      "Target migration ledger is outdated; apply migrations/0020_data_migration_control.sql and 0022_composite_migration_cursor.sql first",
    );
  }
}

async function ensureRun(
  target: TargetSql,
  options: CopyOptions,
  fingerprint: string,
): Promise<void> {
  const existing = await target<
    Array<{ manifest_version: string; source_fingerprint: string; source_prefix: string }>
  >`
    SELECT manifest_version, source_fingerprint, source_prefix
    FROM data_migration_run
    WHERE run_id = ${options.runId}
  `;
  if (existing.length) {
    const run = existing[0];
    if (
      run.manifest_version !== MIGRATION_MANIFEST_VERSION ||
      run.source_fingerprint !== fingerprint ||
      run.source_prefix !== options.sourcePrefix
    ) {
      throw new Error("Existing migration run does not match this manifest or source fingerprint");
    }
    await target`
      UPDATE data_migration_run
      SET status = 'RUNNING', completed_at = NULL, last_error = ''
      WHERE run_id = ${options.runId}
    `;
    return;
  }
  await target`
    INSERT INTO data_migration_run (
      run_id, manifest_version, source_fingerprint, source_prefix, status
    ) VALUES (
      ${options.runId}, ${MIGRATION_MANIFEST_VERSION}, ${fingerprint},
      ${options.sourcePrefix}, 'RUNNING'
    )
  `;
}

async function synchronizeSequence(target: TargetSql, table: string, key: string): Promise<void> {
  const sequenceRows = await target<Array<{ sequence_name: string | null }>>`
    SELECT pg_get_serial_sequence(${table}, ${key}) AS sequence_name
  `;
  const sequenceName = sequenceRows[0]?.sequence_name;
  if (!sequenceName) return;
  const maximumRows = await target<Array<{ maximum: string | null }>>`
    SELECT max(${target(key)})::text AS maximum FROM ${target(table)}
  `;
  const maximum = maximumRows[0]?.maximum;
  if (maximum !== null && maximum !== undefined) {
    await target`SELECT setval(${sequenceName}::regclass, ${maximum}, true)`;
  }
}

export async function readSourceBatch(
  source: Connection,
  plan: TableTransferPlan,
  afterKey: MigrationCursor,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const selectColumns = plan.columns
    .map((targetColumn) => {
      const sourceColumn = plan.sourceColumnByTarget[targetColumn] ?? targetColumn;
      return `${quoteMysqlIdentifier(sourceColumn)} AS ${quoteMysqlIdentifier(targetColumn)}`;
    })
    .join(", ");
  const sourceTable = quoteMysqlIdentifier(plan.sourceTable);
  const sourceKeys = plan.sourceKeyColumns.map(quoteMysqlIdentifier);
  if (!sourceKeys.length) throw new Error(`${plan.spec.table}: migration key is missing`);
  const orderBy = sourceKeys
    .map((key, index) =>
      plan.keyKinds[index] === "text" ? `CAST(${key} AS BINARY) ASC` : `${key} ASC`,
    )
    .join(", ");
  if (afterKey !== null && afterKey.length !== sourceKeys.length) {
    throw new Error(`${plan.spec.table}: checkpoint cursor width does not match the migration key`);
  }
  const resume = afterKey === null
    ? null
    : sourceKeys.reduce(
        (result, key, index) => {
          const equalities = sourceKeys.slice(0, index).map((priorKey, priorIndex) => {
            result.parameters.push(afterKey[priorIndex]);
            return plan.keyKinds[priorIndex] === "text"
              ? `CAST(${priorKey} AS BINARY) = CAST(? AS BINARY)`
              : `${priorKey} = ?`;
          });
          result.parameters.push(afterKey[index]);
          const greater = plan.keyKinds[index] === "text"
            ? `CAST(${key} AS BINARY) > CAST(? AS BINARY)`
            : `${key} > ?`;
          result.clauses.push(`(${[...equalities, greater].join(" AND ")})`);
          return result;
        },
        { clauses: [] as string[], parameters: [] as string[] },
      );
  const [rows] = afterKey === null
    ? await source.query<RowDataPacket[]>(
        `SELECT ${selectColumns} FROM ${sourceTable}
         ORDER BY ${orderBy} LIMIT ?`,
        [limit],
      )
    : await source.query<RowDataPacket[]>(
        `SELECT ${selectColumns} FROM ${sourceTable}
         WHERE ${resume!.clauses.join(" OR ")}
         ORDER BY ${orderBy} LIMIT ?`,
        [...resume!.parameters, limit],
      );
  return rows.map((row) =>
    convertRowForTarget(row as Record<string, unknown>, plan.conversions),
  );
}

export interface SourceMultisetGroup {
  canonicalKey: string;
  multiplicity: number;
  row: Record<string, unknown>;
}

export interface MultisetCheckpointCursor {
  canonicalKey: string | null;
  consumedInGroup: number;
}

export function selectMultisetBatch(
  table: string,
  groups: readonly SourceMultisetGroup[],
  cursor: MultisetCheckpointCursor,
  batchSize: number,
): { records: Array<Record<string, unknown>>; nextCursor: MultisetCheckpointCursor } {
  const records: Array<Record<string, unknown>> = [];
  let nextCursor = cursor;
  for (const group of groups) {
    const alreadyConsumed = group.canonicalKey === cursor.canonicalKey
      ? cursor.consumedInGroup
      : 0;
    if (alreadyConsumed > group.multiplicity) {
      throw new Error(`${table}: source multiset group shrank below its checkpoint multiplicity`);
    }
    const remaining = group.multiplicity - alreadyConsumed;
    if (remaining === 0) continue;
    const take = Math.min(remaining, batchSize - records.length);
    for (let index = 0; index < take; index += 1) records.push(group.row);
    nextCursor = {
      canonicalKey: group.canonicalKey,
      consumedInGroup: alreadyConsumed + take,
    };
    if (records.length === batchSize) break;
  }
  return { records, nextCursor };
}

function sourceMultisetCanonicalExpression(plan: TableTransferPlan): string {
  const components = plan.columns.map((targetColumn) => {
    const sourceColumn = plan.sourceColumnByTarget[targetColumn] ?? targetColumn;
    const identifier = quoteMysqlIdentifier(sourceColumn);
    return `CASE WHEN ${identifier} IS NULL THEN 'N;' ELSE CONCAT(` +
      `'V', OCTET_LENGTH(CAST(${identifier} AS BINARY)), ':', ` +
      `HEX(CAST(${identifier} AS BINARY)), ';') END`;
  });
  if (!components.length) throw new Error(`${plan.spec.table}: multiset copy has no columns`);
  return `CONCAT(${components.join(", ")})`;
}

/**
 * Reads distinct full-row groups in a collision-free, binary-stable order.
 * The length-prefixed hexadecimal cursor distinguishes NULL, empty strings,
 * case variants and delimiter-like values without depending on source collation.
 */
export async function readSourceMultisetGroups(
  source: Pick<Connection, "query">,
  plan: TableTransferPlan,
  afterCanonicalKey: string | null,
  limit: number,
  includeAfterKey = false,
): Promise<SourceMultisetGroup[]> {
  if ((plan.spec.copyStrategy ?? "keyset") !== "append_multiset") {
    throw new Error(`${plan.spec.table}: multiset reader requires append_multiset strategy`);
  }
  const selectColumns = plan.columns
    .map((targetColumn) => {
      const sourceColumn = plan.sourceColumnByTarget[targetColumn] ?? targetColumn;
      return `${quoteMysqlIdentifier(sourceColumn)} AS ${quoteMysqlIdentifier(targetColumn)}`;
    })
    .join(", ");
  const sourceColumns = plan.columns.map((targetColumn) =>
    quoteMysqlIdentifier(plan.sourceColumnByTarget[targetColumn] ?? targetColumn)
  );
  const canonical = sourceMultisetCanonicalExpression(plan);
  const resume = afterCanonicalKey === null
    ? ""
    : `WHERE CAST(${canonical} AS BINARY) ${includeAfterKey ? ">=" : ">"} CAST(? AS BINARY)`;
  const parameters = afterCanonicalKey === null ? [limit] : [afterCanonicalKey, limit];
  const [rows] = await source.query<RowDataPacket[]>(
    `SELECT ${selectColumns}, COUNT(*) AS __migration_multiplicity,
            ${canonical} AS __migration_canonical_key
     FROM ${quoteMysqlIdentifier(plan.sourceTable)}
     ${resume}
     GROUP BY ${[...sourceColumns, canonical].join(", ")}
     ORDER BY CAST(${canonical} AS BINARY) ASC
     LIMIT ?`,
    parameters,
  );
  return rows.map((rawRow) => {
    const row = rawRow as Record<string, unknown>;
    const canonicalKey = String(row.__migration_canonical_key ?? "");
    const multiplicity = parseRowCount(
      row.__migration_multiplicity,
      `${plan.spec.table} multiset multiplicity`,
    );
    const mapped = Object.fromEntries(plan.columns.map((column) => [column, row[column]]));
    return {
      canonicalKey,
      multiplicity,
      row: convertRowForTarget(mapped, plan.conversions),
    };
  });
}

export function decodeMultisetCheckpointCursor(value: unknown): MultisetCheckpointCursor {
  if (value === null || value === undefined) {
    return { canonicalKey: null, consumedInGroup: 0 };
  }
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error("Invalid multiset migration checkpoint cursor");
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    !Number.isSafeInteger(Number(parsed[1])) ||
    Number(parsed[1]) < 0
  ) {
    throw new Error("Invalid multiset migration checkpoint cursor");
  }
  return { canonicalKey: parsed[0], consumedInGroup: Number(parsed[1]) };
}

export function decodeCheckpointCursor(
  keys: readonly string[],
  scalarValue: unknown,
  jsonValue: unknown,
  keyKinds: readonly MigrationKeyKind[] = keys.map(() => "integer"),
): MigrationCursor {
  if (!keys.length) throw new Error("Cannot decode a checkpoint without migration keys");
  if (keyKinds.length !== keys.length) throw new Error("Checkpoint key kind width mismatch");
  if (keys.length === 1 && keyKinds[0] === "integer") {
    if (scalarValue === null || scalarValue === undefined) return null;
    const value = String(scalarValue);
    if (!/^-?\d+$/.test(value)) throw new Error("Invalid scalar migration checkpoint cursor");
    return [value];
  }
  if (jsonValue === null || jsonValue === undefined) return null;
  let parsed = jsonValue;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error("Invalid composite migration checkpoint cursor");
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== keys.length ||
    parsed.some((value, index) =>
      keyKinds[index] === "integer"
        ? !/^-?\d+$/.test(String(value))
        : typeof value !== "string")
  ) {
    throw new Error(
      keys.length > 1 && keyKinds.every((kind) => kind === "integer")
        ? "Invalid composite migration checkpoint cursor"
        : "Invalid JSON migration checkpoint cursor",
    );
  }
  return parsed.map(String);
}

async function copyAppendMultisetTable(
  source: Connection,
  target: TargetSql,
  plan: TableTransferPlan,
  options: CopyOptions,
): Promise<TableCopyResult> {
  const checkpoints = await target<
    Array<{
      last_key_json: unknown;
      source_count: string;
      inserted_count: string;
      conflict_count: string;
      status: string;
    }>
  >`
    SELECT last_key_json, source_count::text, inserted_count::text,
           conflict_count::text, status
    FROM data_migration_checkpoint
    WHERE run_id = ${options.runId} AND table_name = ${plan.spec.table}
  `;
  const checkpoint = checkpoints[0];
  if (
    checkpoint &&
    plan.sourceCount !== undefined &&
    Number(checkpoint.source_count) !== plan.sourceCount
  ) {
    throw new Error(
      `${plan.spec.table}: source row count changed since checkpoint (${checkpoint.source_count} -> ${plan.sourceCount})`,
    );
  }
  if (Number(checkpoint?.conflict_count ?? 0) !== 0) {
    throw new Error(`${plan.spec.table}: append_multiset checkpoint cannot contain conflicts`);
  }
  if (checkpoint?.status === "COMPLETED") {
    return {
      table: plan.spec.table,
      sourceCount: plan.sourceCount ?? 0,
      insertedCount: Number(checkpoint.inserted_count),
      conflictCount: 0,
      status: "skipped_completed",
    };
  }

  let cursor = decodeMultisetCheckpointCursor(checkpoint?.last_key_json ?? null);
  let insertedCount = Number(checkpoint?.inserted_count ?? 0);
  if (!Number.isSafeInteger(insertedCount) || insertedCount < 0) {
    throw new Error(`${plan.spec.table}: invalid append_multiset inserted count`);
  }

  for (;;) {
    const groups = await readSourceMultisetGroups(
      source,
      plan,
      cursor.canonicalKey,
      options.batchSize + 1,
      cursor.canonicalKey !== null,
    );
    const { records, nextCursor } = selectMultisetBatch(
      plan.spec.table,
      groups,
      cursor,
      options.batchSize,
    );
    if (!records.length) break;

    await target.begin(async (transaction) => {
      await transaction`LOCK TABLE ${transaction(plan.spec.table)} IN EXCLUSIVE MODE`;
      const ownershipRows = await transaction<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM ${transaction(plan.spec.table)}
      `;
      const actualTargetCount = parseRowCount(
        ownershipRows[0]?.count,
        `${plan.spec.table} append_multiset target`,
      );
      if (actualTargetCount !== insertedCount) {
        throw new Error(
          `${plan.spec.table}: append_multiset requires an empty/exclusively-owned target ` +
            `(${actualTargetCount} rows present, ${insertedCount} recorded by this run)`,
        );
      }
      await transaction`
        INSERT INTO ${transaction(plan.spec.table)}
        ${transaction(records, ...plan.columns)}
      `;
      await transaction`
        INSERT INTO data_migration_checkpoint (
          run_id, table_name, last_key, last_key_json, source_count,
          inserted_count, conflict_count, status, updated_at
        ) VALUES (
          ${options.runId}, ${plan.spec.table}, NULL,
          ${transaction.json([nextCursor.canonicalKey, nextCursor.consumedInGroup])},
          ${plan.sourceCount ?? 0}, ${insertedCount + records.length}, 0, 'RUNNING', now()
        )
        ON CONFLICT (run_id, table_name) DO UPDATE SET
          last_key = NULL,
          last_key_json = excluded.last_key_json,
          source_count = excluded.source_count,
          inserted_count = excluded.inserted_count,
          conflict_count = 0,
          status = excluded.status,
          updated_at = excluded.updated_at
      `;
    });
    insertedCount += records.length;
    cursor = nextCursor;
  }

  const [finalCountRows] = await source.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM ${quoteMysqlIdentifier(plan.sourceTable)}`,
  );
  const finalSourceCount = parseRowCount(
    finalCountRows[0]?.count,
    `${plan.sourceTable} source`,
  );
  if (plan.sourceCount !== undefined && finalSourceCount !== plan.sourceCount) {
    throw new Error(
      `${plan.spec.table}: source row count changed during copy (${plan.sourceCount} -> ${finalSourceCount})`,
    );
  }
  if (insertedCount !== finalSourceCount) {
    throw new Error(
      `${plan.spec.table}: multiset copy accounting mismatch (${insertedCount} inserted != ${finalSourceCount} source)`,
    );
  }

  await target.begin(async (transaction) => {
    await transaction`LOCK TABLE ${transaction(plan.spec.table)} IN EXCLUSIVE MODE`;
    const ownershipRows = await transaction<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM ${transaction(plan.spec.table)}
    `;
    const actualTargetCount = parseRowCount(
      ownershipRows[0]?.count,
      `${plan.spec.table} append_multiset target`,
    );
    if (actualTargetCount !== insertedCount) {
      throw new Error(
        `${plan.spec.table}: append_multiset target changed before completion ` +
          `(${actualTargetCount} rows present, ${insertedCount} recorded by this run)`,
      );
    }
    await transaction`
      INSERT INTO data_migration_checkpoint (
        run_id, table_name, last_key, last_key_json, source_count,
        inserted_count, conflict_count, status, updated_at
      ) VALUES (
        ${options.runId}, ${plan.spec.table}, NULL,
        ${cursor.canonicalKey === null
          ? null
          : transaction.json([cursor.canonicalKey, cursor.consumedInGroup])},
        ${finalSourceCount}, ${insertedCount}, 0, 'COMPLETED', now()
      )
      ON CONFLICT (run_id, table_name) DO UPDATE SET
        last_key = NULL,
        last_key_json = excluded.last_key_json,
        source_count = excluded.source_count,
        inserted_count = excluded.inserted_count,
        conflict_count = 0,
        status = 'COMPLETED',
        updated_at = excluded.updated_at
    `;
  });

  return {
    table: plan.spec.table,
    sourceCount: finalSourceCount,
    insertedCount,
    conflictCount: 0,
    status: "completed",
  };
}

async function copyTable(
  source: Connection,
  target: TargetSql,
  plan: TableTransferPlan,
  options: CopyOptions,
): Promise<TableCopyResult> {
  if ((plan.spec.copyStrategy ?? "keyset") === "append_multiset") {
    return copyAppendMultisetTable(source, target, plan, options);
  }
  const keys = plan.spec.key;
  const checkpoints = await target<
    Array<{
      last_key: string | null;
      last_key_json: unknown;
      source_count: string;
      inserted_count: string;
      conflict_count: string;
      status: string;
    }>
  >`
    SELECT last_key::text, last_key_json,
           source_count::text, inserted_count::text, conflict_count::text, status
    FROM data_migration_checkpoint
    WHERE run_id = ${options.runId} AND table_name = ${plan.spec.table}
  `;
  if (
    checkpoints.length &&
    plan.sourceCount !== undefined &&
    Number(checkpoints[0].source_count) !== plan.sourceCount
  ) {
    throw new Error(
      `${plan.spec.table}: source row count changed since checkpoint (${checkpoints[0].source_count} -> ${plan.sourceCount})`,
    );
  }
  if (checkpoints[0]?.status === "COMPLETED") {
    return {
      table: plan.spec.table,
      sourceCount: plan.sourceCount ?? 0,
      insertedCount: Number(checkpoints[0].inserted_count),
      conflictCount: Number(checkpoints[0].conflict_count),
      status: "skipped_completed",
    };
  }

  const sourceTable = quoteMysqlIdentifier(plan.sourceTable);
  const progress = await runCursorBatches({
    keys,
    keyKinds: plan.keyKinds,
    batchSize: options.batchSize,
    initial: {
      lastKey: decodeCheckpointCursor(
        keys,
        checkpoints[0]?.last_key ?? null,
        checkpoints[0]?.last_key_json ?? null,
        plan.keyKinds,
      ),
      insertedCount: Number(checkpoints[0]?.inserted_count ?? 0),
      conflictCount: Number(checkpoints[0]?.conflict_count ?? 0),
    },
    readBatch: (afterKey, limit) => readSourceBatch(source, plan, afterKey, limit),
    writeBatch: async (records, nextLastKey, current) =>
      target.begin(async (transaction) => {
        const returned = await transaction<Array<Record<string, unknown>>>`
          INSERT INTO ${transaction(plan.spec.table)}
          ${transaction(records, ...plan.columns)}
          ON CONFLICT (${transaction(keys)}) DO NOTHING
          RETURNING ${transaction(keys)}
        `;
        const batchInserted = returned.length;
        const batchConflicts = records.length - batchInserted;
        const scalarCursor = keys.length === 1 && plan.keyKinds[0] === "integer"
          ? nextLastKey[0]
          : null;
        const jsonCursor = keys.length > 1 || plan.keyKinds[0] === "text"
          ? transaction.json(nextLastKey)
          : null;
        await transaction`
          INSERT INTO data_migration_checkpoint (
            run_id, table_name, last_key, last_key_json, source_count,
            inserted_count, conflict_count, status, updated_at
          ) VALUES (
            ${options.runId}, ${plan.spec.table}, ${scalarCursor}, ${jsonCursor},
            ${plan.sourceCount ?? 0},
            ${current.insertedCount + batchInserted},
            ${current.conflictCount + batchConflicts}, 'RUNNING', now()
          )
          ON CONFLICT (run_id, table_name) DO UPDATE SET
            last_key = excluded.last_key,
            last_key_json = excluded.last_key_json,
            source_count = excluded.source_count,
            inserted_count = excluded.inserted_count,
            conflict_count = excluded.conflict_count,
            status = excluded.status,
            updated_at = excluded.updated_at
        `;
        return { insertedCount: batchInserted, conflictCount: batchConflicts };
      }),
  });
  const { insertedCount, conflictCount } = progress;

  const [finalCountRows] = await source.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM ${sourceTable}`,
  );
  const finalSourceCount = parseRowCount(finalCountRows[0]?.count, `${plan.sourceTable} source`);
  if (plan.sourceCount !== undefined && finalSourceCount !== plan.sourceCount) {
    throw new Error(
      `${plan.spec.table}: source row count changed during copy (${plan.sourceCount} -> ${finalSourceCount})`,
    );
  }
  if (insertedCount + conflictCount !== finalSourceCount) {
    throw new Error(
      `${plan.spec.table}: copied accounting mismatch (${insertedCount} inserted + ${conflictCount} conflicts != ${finalSourceCount} source)`,
    );
  }

  const checkpointStatus = conflictCount ? "CONFLICT" : "COMPLETED";
  // Sequence advancement is idempotent and must happen before the checkpoint is
  // terminal; otherwise a crash in between would make a retry skip this table.
  for (const identityColumn of plan.targetIdentityColumns) {
    await synchronizeSequence(target, plan.spec.table, identityColumn);
  }
  await target`
    UPDATE data_migration_checkpoint
    SET status = ${checkpointStatus}, updated_at = now()
    WHERE run_id = ${options.runId} AND table_name = ${plan.spec.table}
  `;
  return {
    table: plan.spec.table,
    sourceCount: finalSourceCount,
    insertedCount,
    conflictCount,
    status: conflictCount ? "completed_with_conflicts" : "completed",
  };
}

export async function copyEligibleTables(
  source: Connection,
  target: TargetSql,
  plans: TableTransferPlan[],
  options: CopyOptions,
  fingerprint: string,
): Promise<TableCopyResult[]> {
  const selected = plans.filter(
    (plan) => !options.selectedTables || options.selectedTables.has(plan.spec.table),
  );
  if (!selected.length) throw new Error("No migration tables were selected");
  const unchecked = selected.filter((plan) => !plan.liveChecksVerified);
  if (unchecked.length) {
    throw new Error(
      `Live migration checks were not completed: ${unchecked.map((plan) => plan.spec.table).join(", ")}`,
    );
  }
  const unverifiedKeys = selected.filter(
    (plan) => plan.sourceKeyRequiresUniquenessCheck && !plan.sourceKeyUniquenessVerified,
  );
  if (unverifiedKeys.length) {
    throw new Error(
      `Source migration key uniqueness was not verified: ${unverifiedKeys.map((plan) => plan.spec.table).join(", ")}`,
    );
  }
  const blocked = selected.filter((plan) => !plan.eligible);
  if (blocked.length) {
    throw new Error(
      `Blocked migration tables cannot be copied: ${blocked.map((plan) => plan.spec.table).join(", ")}`,
    );
  }
  await assertControlSchema(target);
  const locks = await target<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_lock(hashtext('cinashop:mysql-to-postgres:v1')) AS acquired
  `;
  if (!locks[0]?.acquired) throw new Error("Another MySQL to PostgreSQL migration is running");

  let runReady = false;
  try {
    await ensureRun(target, options, fingerprint);
    runReady = true;
    const results: TableCopyResult[] = [];
    for (const plan of selected) {
      results.push(await copyTable(source, target, plan, options));
    }
    const reviewRows = await target<Array<{ needs_review: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM data_migration_checkpoint
        WHERE run_id = ${options.runId}
          AND (conflict_count > 0 OR status NOT IN ('COMPLETED', 'CONFLICT'))
      ) AS needs_review
    `;
    const needsReview = reviewRows[0]?.needs_review === true ||
      results.some((result) => result.conflictCount > 0);
    await target`
      UPDATE data_migration_run
      SET status = ${needsReview ? "NEEDS_REVIEW" : "COMPLETED"}, completed_at = now(), last_error = ''
      WHERE run_id = ${options.runId}
    `;
    return results;
  } catch (error) {
    if (runReady) {
      await target`
        UPDATE data_migration_run
        SET status = 'FAILED', last_error = ${safeErrorLabel(error)}
        WHERE run_id = ${options.runId}
      `.catch(() => undefined);
    }
    throw error;
  } finally {
    await target`SELECT pg_advisory_unlock(hashtext('cinashop:mysql-to-postgres:v1'))`;
  }
}

export function safeErrorLabel(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
    ? error.name
    : "MigrationError";
  const rawCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const code = /^[A-Za-z0-9_.-]{1,32}$/.test(rawCode) ? rawCode : "";
  return code ? `${name}:${code}` : name;
}

export function compareVerificationBatch(
  plan: Pick<TableTransferPlan, "columns" | "targetColumnTypes" | "spec">,
  sourceRows: Array<Record<string, unknown>>,
  targetRows: Array<Record<string, unknown>>,
  issueLimit: number,
): VerificationBatchResult {
  const keys = plan.spec.key;
  if (!keys.length) throw new Error(`${plan.spec.table}: verification key is missing`);
  const canonicalKey = (row: Record<string, unknown>) =>
    JSON.stringify(
      keys.map((key) => canonicalColumnValue(plan.targetColumnTypes[key], row[key])),
    );
  const printableKey = (row: Record<string, unknown>) => {
    const values = keys.map((key) => String(row[key]));
    return values.length === 1 ? values[0] : JSON.stringify(values);
  };
  const targetByKey = new Map(
    targetRows.map((row) => [canonicalKey(row), row]),
  );
  let missingTargetCount = 0;
  let mismatchedRowCount = 0;
  const issues: VerificationIssue[] = [];
  for (const sourceRow of sourceRows) {
    const sourceKey = printableKey(sourceRow);
    const targetRow = targetByKey.get(canonicalKey(sourceRow));
    if (!targetRow) {
      missingTargetCount += 1;
      if (issues.length < issueLimit) {
        issues.push({ key: sourceKey, kind: "missing_target", columns: [] });
      }
      continue;
    }
    const columns = compareConvertedRows(plan, sourceRow, targetRow);
    if (columns.length) {
      mismatchedRowCount += 1;
      if (issues.length < issueLimit) {
        issues.push({ key: sourceKey, kind: "value_mismatch", columns });
      }
    }
  }
  return {
    checkedCount: sourceRows.length,
    missingTargetCount,
    mismatchedRowCount,
    issues,
  };
}

async function readTargetRowsForSourceKeys(
  target: TargetSql,
  plan: TableTransferPlan,
  sourceRows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  if (!sourceRows.length) return [];
  const predicates = sourceRows.map((row) => {
    const conditions = plan.spec.key.map((key, index) =>
      plan.keyKinds[index] === "text"
        ? target`${target(key)}::text = ${String(row[key])}::text`
        : target`${target(key)}::numeric = ${String(row[key])}::numeric`,
    );
    return conditions.slice(1).reduce(
      (combined, condition) => target`${combined} AND ${condition}`,
      conditions[0],
    );
  });
  const predicate = predicates.slice(1).reduce(
    (combined, entry) => target`${combined} OR ${entry}`,
    predicates[0],
  );
  return target<Array<Record<string, unknown>>>`
    SELECT ${target(plan.columns)}
    FROM ${target(plan.spec.table)}
    WHERE ${predicate}
  `;
}

async function countTargetMultisetRow(
  target: TargetSql,
  plan: TableTransferPlan,
  row: Record<string, unknown>,
): Promise<number> {
  const conditions = plan.columns.map((column) => {
    const value = row[column] as string | number | boolean | Date | null;
    return target`${target(column)} IS NOT DISTINCT FROM ${value}`;
  });
  if (!conditions.length) throw new Error(`${plan.spec.table}: multiset verification has no columns`);
  const predicate = conditions.slice(1).reduce(
    (combined, condition) => target`${combined} AND ${condition}`,
    conditions[0],
  );
  const rows = await target<Array<{ count: string }>>`
    SELECT count(*)::text AS count
    FROM ${target(plan.spec.table)}
    WHERE ${predicate}
  `;
  return parseRowCount(rows[0]?.count, `${plan.spec.table} target multiset group`);
}

async function verifyAppendMultisetTable(
  source: Connection,
  target: TargetSql,
  plan: TableTransferPlan,
  options: VerifyOptions,
): Promise<TableVerificationResult> {
  if (plan.sourceCount === undefined || plan.targetCount === undefined) {
    throw new Error(`${plan.spec.table}: row counts were not loaded before verification`);
  }
  let lastCanonicalKey: string | null = null;
  let checkedCount = 0;
  let matchedTargetCount = 0;
  let missingTargetCount = 0;
  let mismatchedRowCount = 0;
  const issues: VerificationIssue[] = [];

  for (;;) {
    const groups = await readSourceMultisetGroups(
      source,
      plan,
      lastCanonicalKey,
      options.batchSize,
    );
    if (!groups.length) break;
    for (const group of groups) {
      const targetMultiplicity = await countTargetMultisetRow(target, plan, group.row);
      checkedCount += group.multiplicity;
      matchedTargetCount += Math.min(group.multiplicity, targetMultiplicity);
      if (targetMultiplicity !== group.multiplicity) {
        const missing = Math.max(0, group.multiplicity - targetMultiplicity);
        missingTargetCount += missing;
        mismatchedRowCount += Math.abs(group.multiplicity - targetMultiplicity);
        if (issues.length < options.issueLimit) {
          issues.push({
            key: `multiset:${createHash("sha256").update(group.canonicalKey).digest("hex")}`,
            kind: targetMultiplicity === 0 ? "missing_target" : "value_mismatch",
            columns: targetMultiplicity === 0 ? [] : ["__multiplicity"],
          });
        }
      }
      lastCanonicalKey = group.canonicalKey;
    }
  }
  if (checkedCount !== plan.sourceCount) {
    throw new Error(
      `${plan.spec.table}: verification scanned ${checkedCount} multiset rows but source count is ${plan.sourceCount}`,
    );
  }

  const checkpoints = await target<
    Array<{
      status: string;
      source_count: string;
      inserted_count: string;
      conflict_count: string;
    }>
  >`
    SELECT status, source_count::text, inserted_count::text, conflict_count::text
    FROM data_migration_checkpoint
    WHERE run_id = ${options.runId} AND table_name = ${plan.spec.table}
  `;
  const checkpoint = checkpoints[0];
  const checkpointStatus = checkpoint?.status ?? "MISSING";
  const checkpointSourceCount = parseRowCount(
    checkpoint?.source_count,
    `${plan.spec.table} checkpoint source`,
  );
  const checkpointInsertedCount = parseRowCount(
    checkpoint?.inserted_count,
    `${plan.spec.table} checkpoint inserted`,
  );
  const checkpointConflictCount = parseRowCount(
    checkpoint?.conflict_count,
    `${plan.spec.table} checkpoint conflict`,
  );
  const extraTargetCount = Math.max(0, plan.targetCount - matchedTargetCount);
  const checkpointValid =
    checkpointStatus === "COMPLETED" &&
    checkpointSourceCount === plan.sourceCount &&
    checkpointInsertedCount === plan.sourceCount &&
    checkpointConflictCount === 0;
  const passed =
    checkpointValid &&
    missingTargetCount === 0 &&
    mismatchedRowCount === 0 &&
    extraTargetCount === 0;
  return {
    table: plan.spec.table,
    sourceCount: plan.sourceCount,
    targetCount: plan.targetCount,
    checkedCount,
    missingTargetCount,
    mismatchedRowCount,
    extraTargetCount,
    checkpointStatus,
    checkpointSourceCount,
    checkpointInsertedCount,
    checkpointConflictCount,
    status: passed ? "passed" : "failed",
    issues,
  };
}

async function verifyTable(
  source: Connection,
  target: TargetSql,
  plan: TableTransferPlan,
  options: VerifyOptions,
): Promise<TableVerificationResult> {
  if ((plan.spec.copyStrategy ?? "keyset") === "append_multiset") {
    return verifyAppendMultisetTable(source, target, plan, options);
  }
  if (!plan.spec.key.length) throw new Error(`${plan.spec.table}: verification key is missing`);
  if (plan.sourceCount === undefined || plan.targetCount === undefined) {
    throw new Error(`${plan.spec.table}: row counts were not loaded before verification`);
  }
  const keys = plan.spec.key;
  let lastKey: MigrationCursor = null;
  let checkedCount = 0;
  let missingTargetCount = 0;
  let mismatchedRowCount = 0;
  const issues: VerificationIssue[] = [];

  for (;;) {
    const sourceRows = await readSourceBatch(source, plan, lastKey, options.batchSize);
    if (!sourceRows.length) break;
    const nextLastKey = validateIncreasingKeyTupleBatch(
      sourceRows,
      keys,
      lastKey,
      plan.keyKinds,
    );
    const targetRows = await readTargetRowsForSourceKeys(target, plan, sourceRows);
    const batch = compareVerificationBatch(
      plan,
      sourceRows,
      targetRows,
      Math.max(0, options.issueLimit - issues.length),
    );
    checkedCount += batch.checkedCount;
    missingTargetCount += batch.missingTargetCount;
    mismatchedRowCount += batch.mismatchedRowCount;
    issues.push(...batch.issues);
    lastKey = nextLastKey;
  }

  if (checkedCount !== plan.sourceCount) {
    throw new Error(
      `${plan.spec.table}: verification scanned ${checkedCount} rows but source count is ${plan.sourceCount}`,
    );
  }
  const checkpoints = await target<
    Array<{
      status: string;
      source_count: string;
      inserted_count: string;
      conflict_count: string;
    }>
  >`
    SELECT status, source_count::text, inserted_count::text, conflict_count::text
    FROM data_migration_checkpoint
    WHERE run_id = ${options.runId} AND table_name = ${plan.spec.table}
  `;
  const checkpoint = checkpoints[0];
  const checkpointStatus = checkpoint?.status ?? "MISSING";
  const checkpointSourceCount = parseRowCount(
    checkpoint?.source_count,
    `${plan.spec.table} checkpoint source`,
  );
  const checkpointInsertedCount = parseRowCount(
    checkpoint?.inserted_count,
    `${plan.spec.table} checkpoint inserted`,
  );
  const checkpointConflictCount = parseRowCount(
    checkpoint?.conflict_count,
    `${plan.spec.table} checkpoint conflict`,
  );
  const matchedTargetCount = checkedCount - missingTargetCount;
  const extraTargetCount = Math.max(0, plan.targetCount - matchedTargetCount);
  const checkpointValid =
    checkpointStatus === "COMPLETED" &&
    checkpointSourceCount === plan.sourceCount &&
    checkpointInsertedCount + checkpointConflictCount === plan.sourceCount &&
    checkpointConflictCount === 0;
  const passed =
    checkpointValid &&
    missingTargetCount === 0 &&
    mismatchedRowCount === 0 &&
    extraTargetCount === 0;
  return {
    table: plan.spec.table,
    sourceCount: plan.sourceCount,
    targetCount: plan.targetCount,
    checkedCount,
    missingTargetCount,
    mismatchedRowCount,
    extraTargetCount,
    checkpointStatus,
    checkpointSourceCount,
    checkpointInsertedCount,
    checkpointConflictCount,
    status: passed ? "passed" : "failed",
    issues,
  };
}

export async function verifyEligibleTables(
  source: Connection,
  target: TargetSql,
  plans: TableTransferPlan[],
  options: VerifyOptions,
  fingerprint: string,
  sourcePrefix: string,
): Promise<VerificationReport> {
  if (!plans.length) throw new Error("No migration tables were selected for verification");
  const unchecked = plans.filter((plan) => !plan.liveChecksVerified);
  if (unchecked.length) {
    throw new Error(
      `Live migration checks were not completed: ${unchecked.map((plan) => plan.spec.table).join(", ")}`,
    );
  }
  const unverifiedKeys = plans.filter(
    (plan) => plan.sourceKeyRequiresUniquenessCheck && !plan.sourceKeyUniquenessVerified,
  );
  if (unverifiedKeys.length) {
    throw new Error(
      `Source migration key uniqueness was not verified: ${unverifiedKeys.map((plan) => plan.spec.table).join(", ")}`,
    );
  }
  const blocked = plans.filter((plan) => !plan.eligible);
  if (blocked.length) {
    throw new Error(
      `Blocked migration tables cannot be verified: ${blocked.map((plan) => plan.spec.table).join(", ")}`,
    );
  }
  await assertControlSchema(target);
  const runs = await target<
    Array<{
      manifest_version: string;
      source_fingerprint: string;
      source_prefix: string;
      status: string;
    }>
  >`
    SELECT manifest_version, source_fingerprint, source_prefix, status
    FROM data_migration_run
    WHERE run_id = ${options.runId}
  `;
  const run = runs[0];
  if (!run) throw new Error(`Migration run does not exist: ${options.runId}`);
  if (
    run.manifest_version !== MIGRATION_MANIFEST_VERSION ||
    run.source_fingerprint !== fingerprint ||
    run.source_prefix !== sourcePrefix
  ) {
    throw new Error("Migration run does not match this manifest or source fingerprint");
  }
  const tables: TableVerificationResult[] = [];
  for (const plan of plans) tables.push(await verifyTable(source, target, plan, options));
  return {
    runId: options.runId,
    runStatus: run.status,
    passed: run.status === "COMPLETED" && tables.every((table) => table.status === "passed"),
    tables,
  };
}

export function validateApplyTarget(
  targetUrl: string,
  confirmation: string | undefined,
  allowRemote: boolean,
): { database: string; remote: boolean } {
  const parsed = new URL(targetUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) throw new Error("TARGET_POSTGRES_URL must include a database name");
  if (confirmation !== database) {
    throw new Error("MIGRATION_CONFIRM_TARGET must exactly match the target database name");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const remote = !["localhost", "127.0.0.1", "::1"].includes(host);
  if (remote && !allowRemote) {
    throw new Error("Remote target writes require MIGRATION_ALLOW_REMOTE_TARGET=1");
  }
  return { database, remote };
}

export function validateBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new Error("Batch size must be an integer between 1 and 1000");
  }
  return value;
}

export function validateIncreasingKeyBatch(
  rows: Array<Record<string, unknown>>,
  key: string,
  previousKey: string | null,
): string {
  return validateIncreasingKeyTupleBatch(
    rows,
    [key],
    previousKey === null ? null : [previousKey],
  )[0];
}

function compareKeyTuples(
  left: readonly string[],
  right: readonly string[],
  keyKinds: readonly MigrationKeyKind[],
): number {
  if (left.length !== right.length) throw new Error("Migration key tuple widths do not match");
  if (keyKinds.length !== left.length) throw new Error("Migration key kind widths do not match");
  for (let index = 0; index < left.length; index += 1) {
    if (keyKinds[index] === "text") {
      const compared = Buffer.compare(Buffer.from(left[index], "utf8"), Buffer.from(right[index], "utf8"));
      if (compared !== 0) return compared;
    } else {
      const leftValue = BigInt(left[index]);
      const rightValue = BigInt(right[index]);
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
    }
  }
  return 0;
}

export function validateIncreasingKeyTupleBatch(
  rows: Array<Record<string, unknown>>,
  keys: readonly string[],
  previousKey: MigrationCursor,
  keyKinds: readonly MigrationKeyKind[] = keys.map(() => "integer"),
): string[] {
  if (!rows.length) throw new Error("Cannot advance an empty migration key batch");
  if (!keys.length) throw new Error("Cannot advance a migration batch without keys");
  if (previousKey !== null && previousKey.length !== keys.length) {
    throw new Error("Migration checkpoint cursor width does not match the migration key");
  }
  if (keyKinds.length !== keys.length) throw new Error("Migration key kind width mismatch");
  let previous = previousKey;
  for (const row of rows) {
    const current = keys.map((key, index) => {
      const raw = row[key];
      if (raw === null || raw === undefined) {
        throw new Error(`Missing migration key in ${key}`);
      }
      if (keyKinds[index] === "integer" && !/^-?\d+$/.test(String(raw))) {
        throw new Error(`Invalid integer migration key in ${key}`);
      }
      if (keyKinds[index] === "text" && typeof raw !== "string") {
        throw new Error(`Invalid text migration key in ${key}`);
      }
      return String(raw);
    });
    if (previous !== null && compareKeyTuples(current, previous, keyKinds) <= 0) {
      throw new Error(`Migration keys must be strictly increasing in ${keys.join(", ")}`);
    }
    previous = current;
  }
  return previous!;
}

export async function runCursorBatches(
  options: CursorKeysetCopyOptions,
): Promise<CursorProgress> {
  let progress: CursorProgress = {
    ...options.initial,
    lastKey: options.initial.lastKey ? [...options.initial.lastKey] : null,
  };
  for (;;) {
    const rows = await options.readBatch(progress.lastKey, options.batchSize);
    if (!rows.length) return progress;
    const nextLastKey = validateIncreasingKeyTupleBatch(
      rows,
      options.keys,
      progress.lastKey,
      options.keyKinds,
    );
    const batch = await options.writeBatch(rows, nextLastKey, progress);
    if (
      !Number.isSafeInteger(batch.insertedCount) ||
      !Number.isSafeInteger(batch.conflictCount) ||
      batch.insertedCount < 0 ||
      batch.conflictCount < 0 ||
      batch.insertedCount + batch.conflictCount !== rows.length
    ) {
      throw new Error("Batch accounting must equal the number of source rows");
    }
    progress = {
      lastKey: nextLastKey,
      insertedCount: progress.insertedCount + batch.insertedCount,
      conflictCount: progress.conflictCount + batch.conflictCount,
    };
  }
}

export async function runKeysetBatches(options: KeysetCopyOptions): Promise<KeysetProgress> {
  const progress = await runCursorBatches({
    keys: [options.key],
    batchSize: options.batchSize,
    initial: {
      lastKey: options.initial.lastKey === null ? null : [options.initial.lastKey],
      insertedCount: options.initial.insertedCount,
      conflictCount: options.initial.conflictCount,
    },
    readBatch: (afterKey, limit) => options.readBatch(afterKey?.[0] ?? null, limit),
    writeBatch: (rows, nextLastKey, current) =>
      options.writeBatch(rows, nextLastKey[0], {
        lastKey: current.lastKey?.[0] ?? null,
        insertedCount: current.insertedCount,
        conflictCount: current.conflictCount,
      }),
  });
  return {
    lastKey: progress.lastKey?.[0] ?? null,
    insertedCount: progress.insertedCount,
    conflictCount: progress.conflictCount,
  };
}
