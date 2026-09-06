import type { Catalog, CatalogRow } from "./postgres-catalog-audit";

type Entry = { key: string; previousKey: string; catalog: CatalogRow; previousCatalog: CatalogRow };
export function extendIndexNameContracts(baseKeys: string[], manifest: { entries: Entry[] }) {
  if (baseKeys.length !== 128 || new Set(baseKeys).size !== 128 || !Array.isArray(manifest.entries)
    || manifest.entries.length !== 44) throw new Error("Index-name cohort changed; explicit review required");
  const oldKeys = manifest.entries.map((entry) => entry.previousKey);
  const keys = [...baseKeys, ...manifest.entries.map((entry) => entry.key)];
  if (new Set(oldKeys).size !== 44 || new Set(keys).size !== 172 || keys.some((key) => oldKeys.includes(key))) {
    throw new Error("Expected 44 disjoint name alignments and 172 exact contracts");
  }
  for (const entry of manifest.entries) {
    const old = entry.previousCatalog, current = entry.catalog;
    const expected = { ...old, key: current.key, name: current.name };
    if (entry.previousKey !== old.key || entry.key !== current.key || current.unique !== false || current.primary !== false
      || current.constraintOwned !== false || current.valid !== true || current.ready !== true
      || JSON.stringify(expected) !== JSON.stringify(current)) throw new Error(`Not an exact ordinary index rename: ${entry.key}`);
  }
  return { keys, oldKeys };
}

export function assertOldIndexNamesAbsent(catalog: Catalog, keys: string[]) {
  if (keys.length !== 44 || new Set(keys).size !== 44 || keys.some((key) => !/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(key))) {
    throw new Error("Expected all 44 obsolete ordinary index names");
  }
  for (const key of keys) if (catalog.indexes.some((row) => row.key === key || row.name === key.split(".")[1])) {
    throw new Error(`Old index name reintroduced: ${key}`);
  }
}
