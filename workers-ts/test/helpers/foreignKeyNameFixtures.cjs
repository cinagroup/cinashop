// Synthetic, explicitly identified rows. No provider or production data.
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => value === null ? "NULL" : typeof value === "number" ? String(value) : "'" + value.replaceAll("'", "''") + "'";
const id = n => 2011000000 + n;
const hash = n => String(n).repeat(64);
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const run = n => `fk_name_run_${n}`;
const parentTables = ["city_delivery_callback_event", "data_migration_run", "merchant_shipment_callback_event", "payment_callback_event",
  "store_delivery_order", "wechat_callback_event", "payment_reconciliation_case"];
function row(table, n) {
  const event = { id: id(n), event_key: hash(n), replay_key: uuid(n), payload_hash: hash(n), subject_key_hash: hash(n), payload: "{}" };
  const outbox = { id: id(n), event_id: id(n), replay_key: uuid(n) };
  const watermark = { subject_key_hash: hash(n), last_event_id: id(n), last_event_key: hash(n) };
  switch (table) {
    case "city_delivery_callback_event": return { ...event, source: "query", client_id: `client_${n}`, provider_order_id: `order_${n}`, provider_status: "1", provider_update_time: 1 };
    case "city_delivery_callback_outbox": return outbox;
    case "city_delivery_callback_watermark": return { ...watermark, last_state: "WAITING_ACCEPT", provider_update_time: 1 };
    case "city_delivery_reconciliation_case": return { id: id(n), subject_key_hash: hash(n), delivery_order_id: id(n), last_event_id: id(n) };
    case "data_migration_run": return { run_id: run(n), manifest_version: "fk-name-test", source_fingerprint: hash(n) };
    case "data_migration_checkpoint": return { run_id: run(n), table_name: `fixture_${n}` };
    case "merchant_shipment_callback_event": return { ...event, task_id: `task_${n}`, callback_status: "1", order_status: "1" };
    case "merchant_shipment_callback_outbox": return outbox;
    case "merchant_shipment_callback_watermark": return { ...watermark, projection_type: "order_state", last_state: "ORDER_CREATED" };
    case "payment_callback_event": return { id: id(n), provider: "alipay", profile: "alipay", provider_event_id: `event_${n}`, replay_key: uuid(n), payload_hash: hash(n),
      order_no: `order_${n}`, transaction_id: `transaction_${n}`, trade_state: "TRADE_SUCCESS", amount_cents: 100, currency: "CNY" };
    case "payment_callback_outbox": return outbox;
    case "payment_reconciliation_case": return { id: id(n), replay_key: uuid(n), provider: "alipay", profile: "alipay", order_no: `order_${n}`,
      expected_amount_cents: 100, currency: "CNY", callback_event_id: id(n) };
    case "payment_reconciliation_action": return { id: id(n), case_id: id(n), action_key: uuid(n), admin_id: 1, action_type: "RETRY", reason_code: "fixture_retry", before_status: "OPEN", after_status: "OPEN" };
    case "store_delivery_order": return { id: id(n) };
    case "wechat_callback_event": return { ...event, source: "official", app_id: `fixture_app_${n}`, from_user: `fixture_user_${n}`, event_time: 1, reply_payload: "{}" };
    case "wechat_callback_outbox": return outbox;
    case "wechat_callback_watermark": return { ...watermark, source: "official", projection_type: "follow", last_event_time: 1 };
    default: throw new Error("Unreviewed fixture table: " + table);
  }
}
const insert = (table, values) => `INSERT INTO public.${quote(table)} (${Object.keys(values).map(quote).join(",")}) VALUES (${Object.values(values).map(literal).join(",")})`;
const update = (table, values) => `UPDATE public.${quote(table)} SET ${Object.entries(values).map(([k,v]) => quote(k) + "=" + literal(v)).join(",")}`;
async function seedParents(db, excluded) {
  for (const table of parentTables) if (table !== excluded) for (const n of [1,2]) {
    const values = row(table,n);
    // Keep the optional parent-case reference empty when testing a different FK.
    if (table === "payment_reconciliation_case") values.callback_event_id = null;
    await db.exec(insert(table,values));
  }
}
async function seedAll(db, tables) {
  await seedParents(db);
  await db.exec(update("payment_reconciliation_case", { callback_event_id: id(1) }));
  for (const table of tables) if (!parentTables.includes(table)) await db.exec(insert(table,row(table,1)));
}
module.exports = { quote, literal, id, run, row, insert, update, seedParents, seedAll };
