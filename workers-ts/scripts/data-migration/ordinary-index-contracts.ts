import type { Catalog, CatalogRow } from "./postgres-catalog-audit";

type Entry = { key: string; decision: string; catalog: CatalogRow; replacementCatalog?: CatalogRow };
const retiredKeys = ["store_order.so_order_id", "system_supplier.supplier_admin_id"];

/** Fixed reviewed cohort. No broad name/prefix equivalence or silent contraction. */
export function extendOrdinaryIndexContracts(baseKeys: string[], manifest: { entries: Entry[] }) {
  if (baseKeys.length !== 107 || new Set(baseKeys).size !== 107 || !Array.isArray(manifest.entries)
    || manifest.entries.length !== 22 || new Set(manifest.entries.map((entry) => entry.key)).size !== 22) {
    throw new Error("Ordinary index cohort changed; explicit review required");
  }
  const restore = manifest.entries.filter((entry) => entry.decision === "restore-worker-query-index");
  const retire = manifest.entries.filter((entry) => entry.decision === "remove-redundant-orm-declaration");
  if (restore.length !== 20 || retire.length !== 2 || JSON.stringify(retire.map((entry) => entry.key)) !== JSON.stringify(retiredKeys)) {
    throw new Error("Expected exactly 20 additions and two reviewed ORM retirements");
  }
  const keys = [...baseKeys, ...restore.map((entry) => entry.key)];
  for (const entry of retire) {
    const replacement = entry.replacementCatalog;
    if (!replacement || replacement.key !== entry.key + "_uq" || replacement.unique !== true
      || replacement.constraintOwned !== false || replacement.definition !== entry.catalog.definition
      || replacement.table !== entry.catalog.table || entry.catalog.unique !== false) {
      throw new Error(`Invalid retained unique index contract: ${entry.key}`);
    }
    // The supplier unique index was already pinned by DB-009D2b1. Only this
    // explicit overlap is allowed; duplicate new keys are still rejected below.
    if (replacement.key === "system_supplier.supplier_admin_id_uq") {
      if (!baseKeys.includes(replacement.key)) throw new Error("Lost prior supplier unique contract");
    } else keys.push(replacement.key);
  }
  if (keys.length !== 128 || new Set(keys).size !== 128 || keys.some((key) => retiredKeys.includes(key))) {
    throw new Error("Expected all 128 exact positive index contracts");
  }
  return { keys, retiredKeys: [...retiredKeys] };
}

export function assertRetiredIndexesAbsent(catalog: Catalog, keys: string[]) {
  if (JSON.stringify(keys) !== JSON.stringify(retiredKeys)) throw new Error("Retired index cohort changed");
  for (const key of keys) if (catalog.indexes.some((row) => row.key === key || row.name === key.split(".")[1])) {
    throw new Error(`Retired index reintroduced: ${key}`);
  }
}
