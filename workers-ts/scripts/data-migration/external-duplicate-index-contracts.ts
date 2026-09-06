import { assertIndexContracts, compareCatalogs, type Catalog, type CatalogRow } from "./postgres-catalog-audit";

type Entry = { key: string; retainedKey: string; catalog: CatalogRow; retainedCatalog: CatalogRow; decision: string };
const retired = ["store_order_refund.sor_store_order_id_idx", "user_recharge.ur_uid_idx", "wechat_user.wu_openid_uq_idx", "wechat_user.wu_uid_idx", "wechat_user.wu_unionid_idx"];
const retained = ["store_order_refund.sor_store_order_id", "user_recharge.ur_uid", "wechat_user.wu_openid_uq", "wechat_user.wu_uid", "wechat_user.wu_unionid"];
const stable = (row: CatalogRow) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));

export function extendExternalDuplicateContracts(baseKeys: string[], manifest: { entries: Entry[] }) {
  if (baseKeys.length !== 175 || new Set(baseKeys).size !== 175
    || JSON.stringify(manifest.entries?.map(e => e.key)) !== JSON.stringify(retired)
    || JSON.stringify(manifest.entries?.map(e => e.retainedKey)) !== JSON.stringify(retained)) throw new Error("External duplicate cohort changed");
  for (const e of manifest.entries) {
    if (e.decision !== "remove-exact-external-duplicate-only-if-unreferenced"
      || e.catalog.key !== e.key || e.retainedCatalog.key !== e.retainedKey
      || e.catalog.table !== e.key.split(".")[0] || e.catalog.name !== e.key.split(".")[1]
      || e.retainedCatalog.table !== e.retainedKey.split(".")[0] || e.retainedCatalog.name !== e.retainedKey.split(".")[1]
      || stable({ ...e.catalog, key: e.retainedKey, name: e.retainedCatalog.name }) !== stable(e.retainedCatalog)
      || e.catalog.unique !== (e.key === retired[2]) || e.catalog.constraintOwned !== false
      || e.catalog.primary !== false || e.catalog.valid !== true || e.catalog.ready !== true) throw new Error(`Not a reviewed exact duplicate: ${e.key}`);
  }
  const keys = [...baseKeys, ...retained];
  if (new Set(keys).size !== 180 || keys.some(key => retired.includes(key))) throw new Error("Expected 180 disjoint canonical index contracts");
  return { keys, retiredKeys: [...retired] };
}

/** Category-wide gate: no unexpected addition, omission, alias or definition drift is waived. */
export function assertAllIndexesAligned(reference: Catalog, candidate: Catalog) {
  for (const catalog of [reference, candidate]) {
    for (const key of retired) if (catalog.indexes.some(row => row.key === key || row.name === key.split(".")[1])) throw new Error(`External duplicate reintroduced: ${key}`);
  }
  assertIndexContracts(reference, candidate, reference.indexes.map(row => row.key));
  if (Object.values(compareCatalogs(reference, candidate).indexes).some(rows => rows.length)) throw new Error("Full index catalog differs");
}
