import type { Catalog, CatalogRow } from "./postgres-catalog-audit";

type Entry = { key: string; catalog: CatalogRow; previousCatalog: CatalogRow };
const expected: CatalogRow = {
  key: "kefu_visitor_uid_seq", name: "kefu_visitor_uid_seq", type: "integer",
  start: "1000000000", min: "1", max: "2147483647", increment: "1", cache: "1",
  cycle: false, ownedBy: "public.kefu_visitor_session.visitor_uid",
};
const stable = (row: CatalogRow) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));

/** Neither an alias nor a partial integer/unowned or bigint/owned state is accepted. */
export function assertKefuSequenceAligned(catalog: Catalog, manifest: { entries: Entry[] }) {
  const entry = manifest.entries[0];
  if (manifest.entries.length !== 1 || entry.key !== expected.key
    || stable(entry.catalog) !== stable(expected)
    || stable(entry.previousCatalog) !== stable({ ...expected, type: "bigint", ownedBy: null }))
    throw new Error("Kefu sequence manifest drift");
  const rows = catalog.sequences.filter(row => row.key === expected.key);
  if (rows.length !== 1 || stable(rows[0]) !== stable(expected))
    throw new Error("Kefu sequence catalog drift: kefu_visitor_uid_seq");
  if (catalog.sequences.filter(row => row.ownedBy === expected.ownedBy).length !== 1)
    throw new Error("Duplicate kefu sequence ownership alias");
}

/** Compare all 227 named sequences and every raw field; never normalize away a difference. */
export function assertAllSequencesAligned(reference: Catalog, candidate: Catalog) {
  for (const catalog of [reference, candidate]) {
    if (catalog.sequences.length !== 227 || new Set(catalog.sequences.map(row => row.key)).size !== 227)
      throw new Error("Complete sequence cohort changed: expected 227 unique identities");
  }
  const rows = (catalog: Catalog) => catalog.sequences.map(stable).sort();
  if (JSON.stringify(rows(reference)) !== JSON.stringify(rows(candidate)))
    throw new Error("Complete sequence catalog differs; no type, bounds or ownership waiver");
}
