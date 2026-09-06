// Synthetic rows only. Explicit primary/business keys avoid advancing shared sequences.
const { quote, literal } = require("./foreignKeyNameFixtures.cjs");
const id = n => 2012000000 + n;
function row(table,n=1) {
  switch(table) {
    case "division_apply": return { id:id(n),uid:id(n) };
    case "store_order": return { id:id(n),order_id:"check_state_"+n,unique:"check_state_"+n };
    case "store_order_cart_info": return { id:id(n),oid:id(n),unique:"check_state_"+n };
    case "store_order_outbox": return { id:id(n),event_key:"check_state_"+n,aggregate_id:id(n),event_type:"order.paid" };
    case "store_product_reply": return { id:id(n),unique:"check_state_"+n,order_cart_info_id:null };
    case "user": return { uid:id(n),account:"check_state_"+n };
    default: throw new Error("Unreviewed fixture table: "+table);
  }
}
const bounds = {
  status:[0,2], division_brokerage:[0,null], division_agent_brokerage:[0,null],division_staff_brokerage:[0,null],
  supplier_allocation_status:[0,2],split_status:[0,2],split_surplus_num:[0,null],
  product_score:[1,5],service_score:[1,5],logistics_score:[1,5],delivery_score:[1,5],reply_score:[1,3],
  division_percent:[0,100],division_status:[0,1],division_type:[0,3],
};
const events=["order.paid","order.delivery.notice","order.refund.refused.notice","order.second_card.advent.notice",
  "order.second_card.expired.notice","withdrawal.approved.notice","withdrawal.refused.notice",
  "withdrawal.applied.notice","withdrawal.staff.refresh"];
const insert=(table,values,schema="public")=>`INSERT INTO ${quote(schema)}.${quote(table)} (${Object.keys(values).map(quote)}) VALUES (${Object.values(values).map(literal)})`;
const update=(table,values,schema="public")=>`UPDATE ${quote(schema)}.${quote(table)} SET ${Object.entries(values).map(([k,v])=>quote(k)+"="+literal(v)).join(",")}`;
module.exports={quote,literal,row,bounds,events,insert,update};
