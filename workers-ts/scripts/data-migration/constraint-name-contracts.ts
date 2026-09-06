import type { Catalog, CatalogRow } from "./postgres-catalog-audit";

type Entry = { key: string; previousKey: string; catalog: CatalogRow; previousCatalog: CatalogRow;
  constraint: CatalogRow; previousConstraint: CatalogRow };
const targets = ["data_migration_checkpoint.data_migration_checkpoint_pkey", "kefu_visitor_session.kefu_visitor_session_token_hash_key", "kefu_visitor_session.kefu_visitor_session_visitor_uid_key"];
const obsolete = ["data_migration_checkpoint.data_migration_checkpoint_run_id_table_name_pk", "kefu_visitor_session.kefu_visitor_session_token_hash_unique", "kefu_visitor_session.kefu_visitor_session_visitor_uid_unique"];
const stable = (row: CatalogRow) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));

export function extendConstraintNameContracts(baseKeys: string[], manifest: { entries: Entry[] }) {
  if (baseKeys.length !== 172 || new Set(baseKeys).size !== 172
    || JSON.stringify(manifest.entries?.map((e) => e.key)) !== JSON.stringify(targets)
    || JSON.stringify(manifest.entries?.map((e) => e.previousKey)) !== JSON.stringify(obsolete)) throw new Error("Constraint-name cohort changed");
  for (const e of manifest.entries) {
    for (const [previous, current] of [[e.previousCatalog, e.catalog], [e.previousConstraint, e.constraint]]) {
      if (previous.key !== e.previousKey || current.key !== e.key
        || previous.name !== e.previousKey.split(".")[1] || current.name !== e.key.split(".")[1]
        || previous.table !== e.previousKey.split(".")[0] || current.table !== e.key.split(".")[0]
        || stable({ ...previous, key: current.key, name: current.name }) !== stable(current)) throw new Error(`Not an exact constraint/index rename: ${e.key}`);
    }
    if (e.catalog.constraintOwned !== true || e.catalog.unique !== true || e.catalog.primary !== (e.constraint.type === "p")
      || !["p", "u"].includes(String(e.constraint.type)) || e.constraint.validated !== true
      || e.constraint.deferrable !== false || e.constraint.deferred !== false) throw new Error(`Unexpected owning constraint: ${e.key}`);
  }
  const keys = [...baseKeys, ...targets];
  if (new Set(keys).size !== 175 || keys.some((key) => obsolete.includes(key))) throw new Error("Expected 175 disjoint canonical index contracts");
  return { keys, constraintKeys: [...targets], oldKeys: [...obsolete] };
}

export function assertConstraintNamesAligned(reference: Catalog, candidate: Catalog) {
  for (const catalog of [reference, candidate]) {
    for (const kind of ["constraints", "indexes"] as const) {
      for (const key of obsolete) if (catalog[kind].some((row) => row.key === key || row.name === key.split(".")[1])) throw new Error(`Old owning constraint/index reintroduced: ${key}`);
      if (new Set(catalog[kind].map((row) => row.key)).size !== catalog[kind].length) throw new Error(`Duplicate ${kind} identities`);
    }
  }
  for (const key of targets) {
    const left = reference.constraints.find((row) => row.key === key), right = candidate.constraints.find((row) => row.key === key);
    if (!left || !right || stable(left) !== stable(right)) throw new Error(`Constraint contract drift: ${key}`);
  }
}
