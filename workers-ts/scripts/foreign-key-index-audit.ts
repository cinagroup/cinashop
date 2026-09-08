/** Offline model inventory only. Candidate shape is not a query-plan verdict. */
import { is } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function foreignKeyIndexInventory(models: Record<string, unknown>) {
  const dialect = new PgDialect();
  const tables = [...new Set(Object.values(models).filter((value): value is PgTable => is(value, PgTable)))];
  const entries = tables.flatMap(table => {
    const config = getTableConfig(table);
    const indexes = config.indexes.map(({ config: index }) => ({
      name: index.name ?? null, kind: "index", method: index.method,
      columns: index.columns.map(column => "name" in column ? column.name ?? null : null),
      predicate: index.where ? dialect.sqlToQuery(index.where).sql : null,
    }));
    for (const primary of config.primaryKeys) indexes.push({ name: primary.getName(), kind: "primary",
      method: "btree", columns: primary.columns.map(column => column.name), predicate: null });
    for (const unique of config.uniqueConstraints) indexes.push({ name: unique.getName() ?? null, kind: "unique",
      method: "btree", columns: unique.columns.map(column => column.name), predicate: null });
    for (const column of config.columns) {
      if (column.primary) indexes.push({ name: `${config.name}_pkey`, kind: "column-primary", method: "btree", columns: [column.name], predicate: null });
      if (column.isUnique) indexes.push({ name: column.uniqueName ?? null, kind: "column-unique", method: "btree", columns: [column.name], predicate: null });
    }
    return config.foreignKeys.map(fk => {
      const reference = fk.reference(), columns = reference.columns.map(column => column.name);
      const leadingCandidates = indexes.filter(index => index.columns[0] && columns.includes(index.columns[0])).map(index => ({
        ...index,
        fullReferencePrefix: columns.every(column => index.columns.slice(0, columns.length).includes(column)),
      }));
      return { table: config.name, name: fk.getName(), columns,
        parentTable: getTableConfig(reference.foreignTable).name,
        parentColumns: reference.foreignColumns.map(column => column.name),
        onDelete: fk.onDelete ?? "no action", onUpdate: fk.onUpdate ?? "no action", leadingCandidates };
    });
  }).sort((a, b) => `${a.table}.${a.name}`.localeCompare(`${b.table}.${b.name}`));
  const keys = entries.map(entry => `${entry.table}.${entry.name}`);
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate FK inventory identity");
  return { mode: "offline-model-candidates-not-performance-acceptance", count: entries.length,
    withoutLeadingCandidate: entries.filter(entry => !entry.leadingCandidates.length).map(entry => `${entry.table}.${entry.name}`),
    partialOnly: entries.filter(entry => entry.leadingCandidates.length && entry.leadingCandidates.every(index => index.predicate !== null))
      .map(entry => `${entry.table}.${entry.name}`), entries };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const models = await import("../src/models/schema");
  process.stdout.write("FOREIGN_KEY_INDEX_INVENTORY " + JSON.stringify(foreignKeyIndexInventory(models)) + "\n");
}
