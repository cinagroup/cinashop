import {
  MIGRATION_TABLES,
  type MigrationTableSpec,
} from "./manifest.js";

export type SqlDialect = "mysql" | "postgres";

export interface ParsedColumn {
  name: string;
  definition: string;
  primaryKey: boolean;
}

export interface ParsedTable {
  name: string;
  columns: Map<string, ParsedColumn>;
  primaryKey: string[];
}

export interface SharedTableAudit {
  /** PostgreSQL target table name. */
  table: string;
  /** Unprefixed MySQL source table name. */
  sourceTable: string;
  sourceColumns: string[];
  targetColumns: string[];
  commonColumns: string[];
  sourceOnlyColumns: string[];
  targetOnlyColumns: string[];
  sourcePrimaryKey: string[];
  targetPrimaryKey: string[];
}

export interface SchemaAuditReport {
  sourceTableCount: number;
  targetTableCount: number;
  sharedTableCount: number;
  sourceColumnCompleteTableCount: number;
  sourceColumnGapTableCount: number;
  sourceOnlyTables: string[];
  targetOnlyTables: string[];
  sharedTables: SharedTableAudit[];
}

export interface TargetColumnDrift {
  table: string;
  externalOnlyColumns: string[];
  workerOnlyColumns: string[];
  externalPrimaryKey: string[];
  workerPrimaryKey: string[];
  definitionDrift: Array<{
    column: string;
    external: string;
    worker: string;
  }>;
}

export interface TargetDefinitionDrift {
  externalTableCount: number;
  workerTableCount: number;
  externalOnlyTables: string[];
  workerOnlyTables: string[];
  columnDrift: TargetColumnDrift[];
}

function splitTopLevel(input: string): string[] {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote) {
        if (input[i + 1] === quote) {
          i += 1;
        } else if (input[i - 1] !== "\\") {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      values.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  values.push(input.slice(start).trim());
  return values.filter(Boolean);
}

function findClosingParen(sql: string, openIndex: number): number {
  let depth = 1;
  let quote: "'" | '"' | "`" | null = null;
  for (let i = openIndex + 1; i < sql.length; i += 1) {
    const char = sql[i];
    if (quote) {
      if (char === quote) {
        if (sql[i + 1] === quote) {
          i += 1;
        } else if (sql[i - 1] !== "\\") {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unclosed CREATE TABLE body at offset ${openIndex}`);
}

function extractIdentifiers(input: string): string[] {
  return [...input.matchAll(/[`"]([^`"]+)[`"]|\b([a-z_][a-z0-9_]*)\b/gi)]
    .filter(
      (match) =>
        match[1] !== undefined ||
        !["primary", "key", "using", "btree"].includes(match[2].toLowerCase()),
    )
    .map((match) => match[1] ?? match[2]);
}

export function parseCreateTables(sql: string, dialect: SqlDialect): Map<string, ParsedTable> {
  const tables = new Map<string, ParsedTable>();
  const createPattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"])([^`"]+)\1\s*\(/gi;
  let match: RegExpExecArray | null;

  while ((match = createPattern.exec(sql)) !== null) {
    const rawName = match[2];
    const name = dialect === "mysql" ? rawName : rawName.toLowerCase();
    const openIndex = createPattern.lastIndex - 1;
    const closeIndex = findClosingParen(sql, openIndex);
    const body = sql.slice(openIndex + 1, closeIndex);
    const columns = new Map<string, ParsedColumn>();
    let tablePrimaryKey: string[] = [];

    for (const segment of splitTopLevel(body)) {
      const columnMatch = segment.match(/^\s*[`"]([^`"]+)[`"]\s+([\s\S]+)$/);
      if (columnMatch) {
        const columnName = columnMatch[1].toLowerCase();
        const definition = columnMatch[2].trim();
        const primaryKey = /\bPRIMARY\s+KEY\b/i.test(definition);
        columns.set(columnName, { name: columnName, definition, primaryKey });
        if (primaryKey) tablePrimaryKey.push(columnName);
        continue;
      }

      if (/^\s*(?:CONSTRAINT\s+[`"][^`"]+[`"]\s+)?PRIMARY\s+KEY\b/i.test(segment)) {
        const opening = segment.indexOf("(");
        const closing = segment.lastIndexOf(")");
        if (opening >= 0 && closing > opening) {
          tablePrimaryKey = extractIdentifiers(segment.slice(opening + 1, closing)).map((value) =>
            value.toLowerCase(),
          );
        }
      }
    }

    const existing = tables.get(name);
    // Match database execution semantics: a later CREATE TABLE IF NOT EXISTS
    // does not add columns to an existing table. Only subsequent ALTERs may do so.
    if (!existing) {
      tables.set(name, { name, columns, primaryKey: tablePrimaryKey });
    }
    createPattern.lastIndex = closeIndex + 1;
  }
  return tables;
}

export function mergePostgresAlterColumns(
  tables: Map<string, ParsedTable>,
  sql: string,
): void {
  const alterPattern = /ALTER\s+TABLE\s+"([^"]+)"\s+([\s\S]*?);/gi;
  for (const match of sql.matchAll(alterPattern)) {
    const table = tables.get(match[1].toLowerCase());
    if (!table) continue;
    const addPattern = /ADD\s+COLUMN(?:\s+IF\s+NOT\s+EXISTS)?\s+"([^"]+)"\s+([\s\S]*?)(?=,\s*ADD\s+COLUMN|$)/gi;
    for (const columnMatch of match[2].matchAll(addPattern)) {
      const name = columnMatch[1].toLowerCase();
      if (!table.columns.has(name)) {
        table.columns.set(name, {
          name,
          definition: columnMatch[2].trim(),
          primaryKey: false,
        });
      }
    }
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function buildSchemaAudit(
  sourceSql: string,
  targetSql: string,
  sourcePrefix = "eb_",
  specs: readonly MigrationTableSpec[] = MIGRATION_TABLES,
): SchemaAuditReport {
  const rawSource = parseCreateTables(sourceSql, "mysql");
  const source = new Map<string, ParsedTable>();
  for (const [name, table] of rawSource) {
    const normalized = name.startsWith(sourcePrefix) ? name.slice(sourcePrefix.length) : name;
    source.set(normalized.toLowerCase(), { ...table, name: normalized.toLowerCase() });
  }
  const target = parseCreateTables(targetSql, "postgres");
  mergePostgresAlterColumns(target, targetSql);
  const specsByTable = new Map(specs.map((spec) => [spec.table.toLowerCase(), spec]));
  const mappedPairs = specs
    .map((spec) => ({
      source: (spec.sourceTable ?? spec.table).toLowerCase(),
      target: spec.table.toLowerCase(),
    }))
    .filter((pair) => pair.source !== pair.target && source.has(pair.source) && target.has(pair.target));
  const duplicateMappedSource = mappedPairs.find(
    (pair, index) => mappedPairs.findIndex((candidate) => candidate.source === pair.source) !== index,
  );
  if (duplicateMappedSource) {
    throw new Error(`Schema audit source table is mapped more than once: ${duplicateMappedSource.source}`);
  }
  const duplicateMappedTarget = mappedPairs.find(
    (pair, index) => mappedPairs.findIndex((candidate) => candidate.target === pair.target) !== index,
  );
  if (duplicateMappedTarget) {
    throw new Error(`Schema audit target table is mapped more than once: ${duplicateMappedTarget.target}`);
  }
  const usedSources = new Set(mappedPairs.map((pair) => pair.source));
  const usedTargets = new Set(mappedPairs.map((pair) => pair.target));
  const exactPairs = [...source.keys()]
    .filter((name) => target.has(name) && !usedSources.has(name) && !usedTargets.has(name))
    .map((name) => ({ source: name, target: name }));
  const pairs = [...mappedPairs, ...exactPairs].sort((left, right) =>
    left.target.localeCompare(right.target),
  );
  for (const pair of pairs) {
    usedSources.add(pair.source);
    usedTargets.add(pair.target);
  }

  const sourceOnlyTables = sorted([...source.keys()].filter((name) => !usedSources.has(name)));
  const targetOnlyTables = sorted([...target.keys()].filter((name) => !usedTargets.has(name)));
  const sharedTables = pairs.map(({ source: sourceName, target: targetName }) => {
    const sourceTable = source.get(sourceName)!;
    const targetTable = target.get(targetName)!;
    const columnMappings = specsByTable.get(targetName)?.columnMappings ?? {};
    const sourceColumns = sorted(sourceTable.columns.keys());
    const targetColumns = sorted(targetTable.columns.keys());
    const targetForSource = (column: string) => columnMappings[column] ?? column;
    const commonColumns = sourceColumns.filter((column) =>
      targetTable.columns.has(targetForSource(column)),
    );
    const representedTargets = new Set(commonColumns.map(targetForSource));
    return {
      table: targetName,
      sourceTable: sourceName,
      sourceColumns,
      targetColumns,
      commonColumns,
      sourceOnlyColumns: sourceColumns.filter(
        (column) => !targetTable.columns.has(targetForSource(column)),
      ),
      targetOnlyColumns: targetColumns.filter((column) => !representedTargets.has(column)),
      sourcePrimaryKey: sourceTable.primaryKey,
      targetPrimaryKey: targetTable.primaryKey,
    };
  });

  return {
    sourceTableCount: source.size,
    targetTableCount: target.size,
    sharedTableCount: sharedTables.length,
    sourceColumnCompleteTableCount: sharedTables.filter(
      (table) => table.sourceOnlyColumns.length === 0,
    ).length,
    sourceColumnGapTableCount: sharedTables.filter(
      (table) => table.sourceOnlyColumns.length > 0,
    ).length,
    sourceOnlyTables,
    targetOnlyTables,
    sharedTables,
  };
}

function parsePostgresSchema(sql: string): Map<string, ParsedTable> {
  const tables = parseCreateTables(sql, "postgres");
  mergePostgresAlterColumns(tables, sql);
  return tables;
}

function normalizeDefinition(definition: string): string {
  return definition
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    .trim();
}

export function comparePostgresDefinitions(
  externalSql: string,
  workerSql: string,
): TargetDefinitionDrift {
  const external = parsePostgresSchema(externalSql);
  const worker = parsePostgresSchema(workerSql);
  const externalOnlyTables = sorted([...external.keys()].filter((name) => !worker.has(name)));
  const workerOnlyTables = sorted([...worker.keys()].filter((name) => !external.has(name)));
  const columnDrift = sorted([...external.keys()].filter((name) => worker.has(name)))
    .map((name) => {
      const externalTable = external.get(name)!;
      const workerTable = worker.get(name)!;
      const definitionDrift = sorted(
        [...externalTable.columns.keys()].filter((column) => workerTable.columns.has(column)),
      )
        .map((column) => ({
          column,
          external: normalizeDefinition(externalTable.columns.get(column)!.definition),
          worker: normalizeDefinition(workerTable.columns.get(column)!.definition),
        }))
        .filter((column) => column.external !== column.worker);
      return {
        table: name,
        externalOnlyColumns: sorted(
          [...externalTable.columns.keys()].filter((column) => !workerTable.columns.has(column)),
        ),
        workerOnlyColumns: sorted(
          [...workerTable.columns.keys()].filter((column) => !externalTable.columns.has(column)),
        ),
        externalPrimaryKey: externalTable.primaryKey,
        workerPrimaryKey: workerTable.primaryKey,
        definitionDrift,
      };
    })
    .filter(
      (table) =>
        table.externalOnlyColumns.length > 0 ||
        table.workerOnlyColumns.length > 0 ||
        table.definitionDrift.length > 0 ||
        table.externalPrimaryKey.join("\0") !== table.workerPrimaryKey.join("\0"),
    );
  return {
    externalTableCount: external.size,
    workerTableCount: worker.size,
    externalOnlyTables,
    workerOnlyTables,
    columnDrift,
  };
}

function cell(values: string[]): string {
  return values.length ? values.map((value) => `\`${value}\``).join(", ") : "—";
}

export function formatSchemaAuditMarkdown(report: SchemaAuditReport): string {
  const lines = [
    "# MySQL → PostgreSQL schema coverage",
    "",
    `- Source tables: ${report.sourceTableCount}`,
    `- Target tables: ${report.targetTableCount}`,
    `- Shared tables: ${report.sharedTableCount}`,
    `- Shared tables with every source column represented: ${report.sourceColumnCompleteTableCount}`,
    `- Shared tables still missing source columns: ${report.sourceColumnGapTableCount}`,
    `- Source-only tables: ${report.sourceOnlyTables.length}`,
    `- Target-only tables: ${report.targetOnlyTables.length}`,
    "",
    "| Source -> target | Common | Source only | Target only | Source PK | Target PK |",
    "|---|---:|---:|---:|---|---|",
  ];
  for (const table of report.sharedTables) {
    const label = table.sourceTable === table.table
      ? `\`${table.table}\``
      : `\`${table.sourceTable}\` -> \`${table.table}\``;
    lines.push(
      `| ${label} | ${table.commonColumns.length} | ${table.sourceOnlyColumns.length} | ${table.targetOnlyColumns.length} | ${cell(table.sourcePrimaryKey)} | ${cell(table.targetPrimaryKey)} |`,
    );
  }
  lines.push("", "## Source-only tables", "", cell(report.sourceOnlyTables));
  lines.push("", "## Target-only tables", "", cell(report.targetOnlyTables), "");
  return lines.join("\n");
}
