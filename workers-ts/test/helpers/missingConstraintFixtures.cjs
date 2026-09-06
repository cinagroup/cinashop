// Synthetic, deterministic fixtures only; no source/production rows or providers.
const id = "2010000001", otherId = "2010000002";
const hash = "repeat('a',64)", otherHash = "repeat('b',64)";
const uuid = "'11111111-1111-4111-8111-111111111111'";
const fixtures = {
  agent_level: { id },
  kefu_visitor_session: { session_id: uuid, visitor_uid: "1000000001", service_id: "1", kefu_uid: "1", token_hash: hash, created_at: "1", expires_at: "10", last_seen_at: "1" },
  store_order_outbox: { id, event_key: "'constraint-fixture'", aggregate_id: "1", event_type: "'order.paid'" },
  store_order_product_coupon_reward: { id, order_id: "1", uid: "1", product_id: "1", issue_coupon_id: "1", coupon_user_id: "1" },
  store_order_refund_payment: { id, refund_id: "1", store_order_id: "1", provider: "'wechat'", out_refund_no: "'constraint-fixture'" },
  store_product_attr_value: { id },
  store_product_description: { product_id: id, type: "0" },
  store_product_reply: { id, order_cart_info_id: id },
  store_product_stock_record: { id },
  store_service_transfer: { request_key: uuid, customer_uid: "1", from_kefu_uid: "1", to_kefu_uid: "2",
    from_service_id: "1", to_service_id: "2", source_record_id: "1", target_record_id: "2", created_at: "1" },
  system_menus: { id, type: "1" },
  system_queue_dead_letter: { id, queue_name: "'constraint-fixture'", message_id: "'constraint-fixture'", body_sha256: hash },
  work_callback_event: { id, event_key: hash, payload_hash: hash, subject_key_hash: hash, corp_id: "'audit'", payload: "'{}'::jsonb" },
  work_callback_outbox: { id, event_id: id, event_key: hash },
  work_callback_watermark: { subject_key_hash: hash, event_id: id, event_key: hash },
  work_contact_action_audit: { id, action_id: id, request_key: uuid, request_hash: hash, operation: "'CLOSE'",
    from_status: "'UNKNOWN'", to_status: "'CLOSED'", actor_id: "1", reason: "'synthetic audit fixture'" },
};
// Each first case invalidates precisely the named restored constraint.
const invalid = {
  al_brokerage_ck: { one_brokerage: "-1" },
  kvs_positive_ids_ck: { service_id: "0" }, kvs_time_ck: { last_seen_at: "11" }, kvs_token_hash_ck: { token_hash: "'bad'" },
  soob_count_ck: { attempt_count: "-1" }, soob_status_ck: { status: "'bad'" }, soob_time_ck: { available_time: "-1" },
  sopcr_positive_ids_ck: { uid: "0" },
  sorp_amount_ck: { request_amount: "1", total_amount: "0" }, sorp_provider_ck: { provider: "'bad'" }, sorp_status_ck: { provider_status: "'bad'" },
  spav_is_retired_ck: { is_retired: "2" }, spd_type_ck: { type: "99" },
  spr_order_cart_info_fk: { order_cart_info_id: "2010000999" },
  spsr_number_ck: { number: "-1" }, spsr_pm_ck: { pm: "2" },
  sst_count_time_ck: { copied_message_count: "-1" }, sst_distinct_kefu_ck: { to_kefu_uid: "1" },
  sst_is_tourist_ck: { is_tourist: "2" }, sst_positive_ids_ck: { customer_uid: "0" },
  sm_auth_type_ck: { auth_type: "3" }, sm_flags_ck: { is_show: "2" }, sm_type_ck: { type: "0" },
  sqdl_time_ck: { message_timestamp_ms: "-1" },
  wce_hashes_ck: { payload_hash: "'bad'" }, wce_payload_object_ck: { payload: "'[]'::jsonb" },
  wce_payload_retention_ck: { payload_retained_until: "-1" }, wce_projection_status_ck: { projection_status: "'bad'" },
  wce_status_ck: { status: "'bad'" }, wce_time_ck: { attempt_count: "-1" },
  wco_event_id_fk: { event_id: "2010000999" }, wco_event_key_ck: { event_key: "'bad'" },
  wco_status_ck: { status: "'bad'" }, wco_time_ck: { dispatch_count: "-1" },
  wcw_hashes_ck: { event_key: "'bad'" }, wcw_time_ck: { update_time: "-1" },
  wcaa_actor_reason_ck: { reason: "' short '" }, wcaa_operation_ck: { operation: "'bad'" },
  wcaa_request_ck: { request_key: "'bad'" }, wcaa_risk_ck: { operation: "'RETRY_WITH_RISK'", risk_accepted: "false" },
  wcaa_status_ck: { from_status: "'bad'" },
};
const edgeCases = [
  ["al_brokerage_ck", { two_brokerage: "1001" }],
  ["kvs_time_ck", { revoked_at: "-1" }],
  ["wce_payload_object_ck", { payload: "'null'::jsonb" }],
  ["wce_payload_object_ck", { payload: "'1'::jsonb" }],
  ["wce_payload_retention_ck", { received_time: "2", payload_retained_until: "3", payload_redacted_time: "1" }],
  ["sorp_amount_ck", { request_amount: "-1" }],
  ["wcaa_actor_reason_ck", { reason: "'eightchars' || chr(10)" }],
  ["wcaa_actor_reason_ck", { actor_id: "0" }],
  ["wcaa_request_ck", { request_hash: "repeat('A',64)" }],
  ["wcaa_request_ck", { provider_reference_hash: "'bad'" }],
  ["wcaa_request_ck", { request_key: "'11111111-1111-0111-8111-111111111111'" }],
  ["wcaa_status_ck", { to_status: "'UNKNOWN'" }],
  ...["is_show_path", "access", "is_header", "is_del"].map(column => ["sm_flags_ck", { [column]: "2" }]),
];
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const insert = (table, values, schema = "public", override = false) =>
  `INSERT INTO ${quote(schema)}.${quote(table)}(${Object.keys(values).map(quote)}) ${override ? "OVERRIDING SYSTEM VALUE " : ""}VALUES(${Object.values(values)})`;
const update = (table, values) => `UPDATE public.${quote(table)} SET ${Object.entries(values).map(([name, value]) => quote(name) + "=" + value).join(",")}`;
function newRow(table) {
  const row = { ...fixtures[table] };
  for (const name of ["id", "product_id", "order_id", "refund_id", "coupon_user_id", "event_id", "order_cart_info_id"]) if (name in row) row[name] = otherId;
  for (const name of ["event_key", "token_hash", "subject_key_hash"]) if (name in row) row[name] = otherHash;
  for (const name of ["session_id", "request_key"]) if (name in row) row[name] = "'22222222-2222-4222-8222-222222222222'";
  for (const name of ["out_refund_no", "message_id"]) if (name in row) row[name] = "'constraint-second'";
  // Exercise FK enforcement even for soft-deleted replies outside the active unique index.
  if (table === "store_product_reply") row.is_del = "1";
  return row;
}
async function seed(db) {
  await db.exec(insert("store_order_cart_info", { id, oid: id, unique: "'constraint-a'" }) + ";"
    + insert("store_order_cart_info", { id: otherId, oid: otherId, unique: "'constraint-b'" }));
  await db.exec(insert("work_callback_event", fixtures.work_callback_event));
  await db.exec(insert("work_callback_event", { ...fixtures.work_callback_event, id: otherId, event_key: otherHash }));
  await db.exec(insert("work_client_current", { id, corp_id: "'audit'", external_userid: "'synthetic'" }, "public", true));
  await db.exec(insert("work_contact_action_outbox", { id, event_id: id, event_key: hash, action_key: hash,
    action_type: "'AUTO_TAG'", corp_id: "'audit'", client_id: id, payload_hash: hash }));
  for (const [table, row] of Object.entries(fixtures)) if (table !== "work_callback_event") await db.exec(insert(table, row));
}
module.exports = { fixtures, invalid, edgeCases, quote, insert, update, newRow, seed };
