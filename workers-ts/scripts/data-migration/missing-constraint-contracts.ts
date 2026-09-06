import type { Catalog, CatalogRow } from "./postgres-catalog-audit";
type Entry = { key: string; catalog: CatalogRow };
const keys = [
  "agent_level.al_brokerage_ck",
  "kefu_visitor_session.kvs_positive_ids_ck",
  "kefu_visitor_session.kvs_time_ck",
  "kefu_visitor_session.kvs_token_hash_ck",
  "store_order_outbox.soob_count_ck",
  "store_order_outbox.soob_status_ck",
  "store_order_outbox.soob_time_ck",
  "store_order_product_coupon_reward.sopcr_positive_ids_ck",
  "store_order_refund_payment.sorp_amount_ck",
  "store_order_refund_payment.sorp_provider_ck",
  "store_order_refund_payment.sorp_status_ck",
  "store_product_attr_value.spav_is_retired_ck",
  "store_product_description.spd_type_ck",
  "store_product_reply.spr_order_cart_info_fk",
  "store_product_stock_record.spsr_number_ck",
  "store_product_stock_record.spsr_pm_ck",
  "store_service_transfer.sst_count_time_ck",
  "store_service_transfer.sst_distinct_kefu_ck",
  "store_service_transfer.sst_is_tourist_ck",
  "store_service_transfer.sst_positive_ids_ck",
  "system_menus.sm_auth_type_ck",
  "system_menus.sm_flags_ck",
  "system_menus.sm_type_ck",
  "system_queue_dead_letter.sqdl_time_ck",
  "work_callback_event.wce_hashes_ck",
  "work_callback_event.wce_payload_object_ck",
  "work_callback_event.wce_payload_retention_ck",
  "work_callback_event.wce_projection_status_ck",
  "work_callback_event.wce_status_ck",
  "work_callback_event.wce_time_ck",
  "work_callback_outbox.wco_event_id_fk",
  "work_callback_outbox.wco_event_key_ck",
  "work_callback_outbox.wco_status_ck",
  "work_callback_outbox.wco_time_ck",
  "work_callback_watermark.wcw_hashes_ck",
  "work_callback_watermark.wcw_time_ck",
  "work_contact_action_audit.wcaa_actor_reason_ck",
  "work_contact_action_audit.wcaa_operation_ck",
  "work_contact_action_audit.wcaa_request_ck",
  "work_contact_action_audit.wcaa_risk_ck",
  "work_contact_action_audit.wcaa_status_ck"
];
const unvalidated = new Set([
  "store_product_attr_value.spav_is_retired_ck",
  "store_product_description.spd_type_ck",
  "store_product_reply.spr_order_cart_info_fk",
  "store_product_stock_record.spsr_number_ck",
  "store_product_stock_record.spsr_pm_ck",
  "system_menus.sm_auth_type_ck",
  "system_menus.sm_flags_ck",
  "system_menus.sm_type_ck"
]);
const foreignKeys = new Set(["store_product_reply.spr_order_cart_info_fk","work_callback_outbox.wco_event_id_fk"]);
const stable = (row: CatalogRow) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));

/** Exact 41 previously absent CHECK/FK contracts; no aliases or other drift waived. */
export function assertMissingConstraintContracts(catalog: Catalog, manifest: { entries: Entry[] }) {
  if (JSON.stringify(manifest.entries?.map(e => e.key)) !== JSON.stringify(keys)) throw new Error("41-constraint cohort changed");
  for (const e of manifest.entries) {
    if (e.catalog.key !== e.key || e.catalog.name !== e.key.split(".")[1] || e.catalog.table !== e.key.split(".")[0]
      || e.catalog.validated !== !unvalidated.has(e.key) || e.catalog.type !== (foreignKeys.has(e.key) ? "f" : "c")
      || e.catalog.deferrable !== false || e.catalog.deferred !== false || e.catalog.local !== true
      || e.catalog.inheritCount !== 0 || e.catalog.noInherit !== foreignKeys.has(e.key)) {
      throw new Error(`Missing-constraint contract metadata drift: ${e.key}`);
    }
    const rows = catalog.constraints.filter(row => row.key === e.key);
    if (rows.length !== 1 || stable(rows[0]) !== stable(e.catalog)) throw new Error(`Missing-constraint catalog drift: ${e.key}`);
  }
}
