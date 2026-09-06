import type { Catalog, CatalogRow } from "./postgres-catalog-audit";

type Entry = { key: string; previousKey: string; catalog: CatalogRow; previousCatalog: CatalogRow };
const pairs = [
  ["city_delivery_callback_outbox.cdcout_event_fk", "city_delivery_callback_outbox.city_delivery_callback_outbox_event_id_city_delivery_callback_e"],
  ["city_delivery_callback_watermark.cdcwm_event_fk", "city_delivery_callback_watermark.city_delivery_callback_watermark_last_event_id_city_delivery_ca"],
  ["city_delivery_reconciliation_case.cdcrc_delivery_order_fk", "city_delivery_reconciliation_case.city_delivery_reconciliation_case_delivery_order_id_store_deliv"],
  ["city_delivery_reconciliation_case.cdcrc_event_fk", "city_delivery_reconciliation_case.city_delivery_reconciliation_case_last_event_id_city_delivery_c"],
  ["data_migration_checkpoint.data_migration_checkpoint_run_id_fkey", "data_migration_checkpoint.data_migration_checkpoint_run_id_data_migration_run_run_id_fk"],
  ["merchant_shipment_callback_outbox.mscout_event_fk", "merchant_shipment_callback_outbox.merchant_shipment_callback_outbox_event_id_merchant_shipment_ca"],
  ["merchant_shipment_callback_watermark.mscwm_event_fk", "merchant_shipment_callback_watermark.merchant_shipment_callback_watermark_last_event_id_merchant_shi"],
  ["payment_callback_outbox.pco_event_fk", "payment_callback_outbox.payment_callback_outbox_event_id_payment_callback_event_id_fk"],
  ["payment_reconciliation_action.pra_case_fk", "payment_reconciliation_action.payment_reconciliation_action_case_id_payment_reconciliation_ca"],
  ["payment_reconciliation_case.prc_callback_event_fk", "payment_reconciliation_case.payment_reconciliation_case_callback_event_id_payment_callback_"],
  ["wechat_callback_outbox.wcout_event_fk", "wechat_callback_outbox.wechat_callback_outbox_event_id_wechat_callback_event_id_fk"],
  ["wechat_callback_watermark.wcwm_event_fk", "wechat_callback_watermark.wechat_callback_watermark_last_event_id_wechat_callback_event_i"],
];
const stable = (row: CatalogRow) => JSON.stringify(Object.entries(row).sort(([a],[b]) => a.localeCompare(b)));

/** Complete target rows; the reviewed old physical names must never reappear. */
export function assertForeignKeyNamesAligned(catalog: Catalog, manifest: { entries: Entry[] }) {
  if (JSON.stringify(manifest.entries.map(e => [e.key,e.previousKey])) !== JSON.stringify(pairs)) throw new Error("Foreign-key name cohort changed");
  for (const e of manifest.entries) {
    if (e.catalog.key !== e.key || e.previousCatalog.key !== e.previousKey
      || e.catalog.name !== e.key.split(".")[1] || e.previousCatalog.name !== e.previousKey.split(".")[1]
      || e.catalog.table !== e.key.split(".")[0] || e.catalog.type !== "f" || e.catalog.validated !== true
      || e.catalog.deferrable !== false || e.catalog.deferred !== false || e.catalog.noInherit !== true
      || e.catalog.local !== true || e.catalog.inheritCount !== 0
      || stable(e.catalog) !== stable({ ...e.previousCatalog,key:e.key,name:e.catalog.name })) throw new Error(`Foreign-key manifest drift: ${e.key}`);
    const actual = catalog.constraints.filter(c => c.key === e.key);
    if (actual.length !== 1 || stable(actual[0]) !== stable(e.catalog)) throw new Error(`Foreign-key catalog drift: ${e.key}`);
    if (catalog.constraints.filter(c => c.table === e.catalog.table && c.definition === e.catalog.definition).length !== 1) throw new Error(`Duplicate foreign-key alias: ${e.key}`);
    if (catalog.constraints.some(c => c.name === e.previousCatalog.name)) throw new Error(`Obsolete foreign-key name: ${e.previousKey}`);
  }
}
