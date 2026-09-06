import type { Catalog, CatalogRow } from "./postgres-catalog-audit";

type Entry = { key: string; catalog: CatalogRow; previousCatalog: CatalogRow };
const keys = [
  "division_apply.da_status_ck", "store_order.so_division_brokerage_ck",
  "store_order.so_supplier_allocation_status_ck", "store_order_cart_info.soci_split_state_ck",
  "store_order_outbox.soob_event_type_ck", "store_product_reply.spr_scores_ck",
  "user.user_division_percent_ck", "user.user_division_status_ck", "user.user_division_type_ck",
];
const stable = (row: CatalogRow) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));

/** Exact raw catalog rows, including expression ordering and validation state. */
export function assertCheckStatesAligned(catalog: Catalog, manifest: { entries: Entry[] }) {
  if (JSON.stringify(manifest.entries.map(e => e.key)) !== JSON.stringify(keys)) throw new Error("CHECK-state cohort changed");
  for (const e of manifest.entries) {
    const validated = e.key === "store_order_outbox.soob_event_type_ck";
    if (e.catalog.key !== e.key || e.previousCatalog.key !== e.key || e.catalog.name !== e.key.split(".")[1]
      || e.catalog.table !== e.key.split(".")[0] || e.catalog.type !== "c" || e.catalog.validated !== validated
      || e.catalog.deferrable !== false || e.catalog.deferred !== false || e.catalog.noInherit !== false
      || e.catalog.local !== true || e.catalog.inheritCount !== 0 || e.previousCatalog.validated !== true)
      throw new Error(`CHECK-state manifest drift: ${e.key}`);
    const actual = catalog.constraints.filter(c => c.key === e.key);
    if (actual.length !== 1 || stable(actual[0]) !== stable(e.catalog)) throw new Error(`CHECK-state catalog drift: ${e.key}`);
    if (catalog.constraints.filter(c => c.table === e.catalog.table
      && [e.catalog.definition, e.previousCatalog.definition].includes(c.definition)).length !== 1)
      throw new Error(`Duplicate CHECK-state alias: ${e.key}`);
  }
}

export function assertAllConstraintsAligned(reference: Catalog, candidate: Catalog) {
  const rows = (catalog: Catalog) => catalog.constraints.map(stable).sort();
  if (JSON.stringify(rows(reference)) !== JSON.stringify(rows(candidate)))
    throw new Error("Complete constraint catalog differs; no validation or expression-order waiver");
}
