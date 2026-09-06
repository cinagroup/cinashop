import { compareCatalogs, type Catalog } from "./postgres-catalog-audit";

export const TABLE_CATALOG_COUNT = 263;
export const TABLE_CATALOG_FIELDS = [
  "forceRowSecurity", "key", "kind", "name", "partition", "partitionKey", "persistence", "rowSecurity",
] as const;

/** Raw public-table metadata only, not complete policy/privilege or runtime equivalence. */
export function assertAllTablesAligned(reference: Catalog, candidate: Catalog): void {
  for (const catalog of [reference, candidate]) {
    if (catalog.tables.length !== TABLE_CATALOG_COUNT
      || new Set(catalog.tables.map(row => row.key)).size !== TABLE_CATALOG_COUNT) {
      throw new Error("Complete table cohort changed: expected 263 unique identities");
    }
    for (const row of catalog.tables) {
      // Reject a reader that silently drops a field on BOTH sides, as well as
      // accidental casts (e.g. the string 'false'). A new field needs review.
      if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(TABLE_CATALOG_FIELDS)
        || typeof row.key !== "string" || !row.key || row.name !== row.key
        || typeof row.kind !== "string" || !["r", "p"].includes(row.kind)
        || typeof row.persistence !== "string" || !["p", "u", "t"].includes(row.persistence)
        || typeof row.rowSecurity !== "boolean" || typeof row.forceRowSecurity !== "boolean"
        || typeof row.partition !== "boolean"
        || !(row.partitionKey === null || typeof row.partitionKey === "string" && row.partitionKey.length > 0)) {
        throw new Error("Invalid complete table catalog row shape");
      }
    }
  }
  if (Object.values(compareCatalogs(reference, candidate).tables).some(rows => rows.length)) {
    throw new Error("Full table catalog differs; no name, kind, persistence, RLS or partition waiver");
  }
}
