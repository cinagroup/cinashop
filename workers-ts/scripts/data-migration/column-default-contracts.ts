import { compareCatalogs, type Catalog, type CatalogRow } from "./postgres-catalog-audit";

type Entry = { key: string; catalog: CatalogRow; previousCatalog: CatalogRow };
const keys = ["store_order_outbox.payload", "store_seckill.time_id", "system_queue_dead_letter.body", "user_brokerage_frozen.price"];
const stable = (row: CatalogRow) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));

export function assertColumnDefaultContracts(catalog: Catalog, manifest: { entries: Entry[] }) {
  if (JSON.stringify(manifest.entries?.map(e => e.key)) !== JSON.stringify(keys)) throw new Error("Four-default cohort changed");
  for (const e of manifest.entries) {
    if (e.catalog.key !== e.key || e.previousCatalog.key !== e.key || e.catalog.name !== e.key.split(".")[1]
      || e.catalog.table !== e.key.split(".")[0] || e.catalog.notNull !== true || e.catalog.identity !== "" || e.catalog.generated !== ""
      || e.catalog.default === e.previousCatalog.default
      || stable({ ...e.previousCatalog, default: e.catalog.default }) !== stable(e.catalog)) throw new Error(`Not a default-only contract: ${e.key}`);
    const rows = catalog.columns.filter(row => row.key === e.key);
    if (rows.length !== 1 || stable(rows[0]) !== stable(e.catalog)) throw new Error(`Column default contract drift: ${e.key}`);
  }
}

/** Compare every column field, without normalizing expressions or ignoring extra columns. */
export function assertAllColumnsAligned(reference: Catalog, candidate: Catalog) {
  if (!reference.columns.length || Object.values(compareCatalogs(reference, candidate).columns).some(rows => rows.length)) {
    throw new Error("Full column catalog differs");
  }
}
