import { pricingIdentifier } from './checkoutPricingLockCatalog';
import type { RuntimePrivilegePlan } from './runtimeBusinessPrivilegePlan';

/** Dedicated user/store principal for the existing 29 manager handlers.
 * This is not the whole-shop/App profile. Authentication remains on App;
 * current store authority and order ownership are rechecked in business SQL.
 * New grants are explicit maintenance work, never a request-time repair. */
export const MANAGER_RUNTIME_ROLE = 'cinashop_manager_v1';
export type ManagerRuntimeProfile='current'|'legacy-without-promotion-gift-receipt';
export const MANAGER_PROMOTION_GIFT_TABLE='store_order_promotion_gift_coupon_reward';
/** Existing PUBLIC invoker baseline measured from source-created PG16.15,
 * five independent canonical fixtures (v2 native receipt), never production.
 * Presence is optional; an executable unknown or changed body is refused. */
export const MANAGER_PUBLIC_INVOKER_BASELINE:Readonly<Record<string,string>>=Object.freeze({
  'brokerage_paid_order_fence_0150()':'a1425c2ecadcaa9857db40dbd46786c761bcb55db5b99fe88ec66a21dbdd1322',
  'coupon_product_scope_fence_0151()':'1dc0a7286d39988c6fa9e0f62a0cc4fbf7d33bebde436435285afe50ea9ac7da',
  'guard_retired_product_sku()':'a7fd5e4f568c081df96f905880e5396adfdfd49566ab9a2f3b335a3e3c703c09',
  'shipping_lifecycle_bind(template integer, owner_type integer, owner_id integer)':'102235dd3153928693d113bede5ddcd76b5b7e9d06abc148e2b9ab73da2b86db',
  'shipping_lifecycle_child()':'261a3a559bf54d5c4000aee74862d86e4a0c3ea76b479126e495e3c4acc1a473',
  'shipping_lifecycle_no_truncate()':'346e23994b6607e46e2b88b437263f852bf26807f1e669c188a99bbc88238260',
  'shipping_lifecycle_parent()':'4489e8b4c01f4adad7a915617610bd67fdc9d18ff945e493bce3ea766319b5a4',
  'shipping_lifecycle_ref(temp integer, freight integer)':'76e0ed4ac67317655e93b9c0a65dce674e8f316477d129e427700fd1f876a4f5',
  'wcaa_guard_immutable_0118()':'26e93f615b3f236158d9f83e468751466c2ae3b65ca54dd4160c9d5bc988b855',
  'wcao_guard_immutable_0118()':'be21d737f0b28125accb56f840310e202840d982d60d5602ab24433996a79e64',
  'wmia_guard_renamed_link_0113()':'044dc5223bf323b4ed5d1411adde0794710c5e8cc8905b452e42e0e3e6e4ff70',
});
const names = (value: string) => value.trim().split(/\s+/);
const read = names(`
  agent_level city_area delivery_service express_company member_right
  notification_template order_waybill_job payment_reconciliation_case print_document
  shipping_templates shipping_templates_free shipping_templates_no_delivery shipping_templates_region
  store_activity store_bargain store_bargain_user store_brand store_combination
  store_config store_coupon_issue store_coupon_issue_user store_coupon_product store_coupon_user
  store_discounts store_discounts_products store_integral store_newcomer
  store_order store_order_cart_info store_order_economize store_order_fulfillment_branch
  store_order_invoice store_order_invoice_allocation store_order_invoice_evidence
  store_order_outbox store_order_promotion_gift_coupon_reward store_order_promotions
  store_order_refund store_order_refund_payment store_order_refund_split store_order_status
  store_order_writeoff store_pink store_product store_product_attr_value store_product_description
  store_product_ensure store_product_log store_product_relation store_promotions store_promotions_auxiliary
  store_seckill store_seckill_time supplier_extract supplier_flowing_water supplier_transactions
  system_attachment system_config system_store system_store_staff system_supplier system_user_level
  user user_address user_bill user_brokerage user_invoice user_label user_label_relation user_level
  manager_order_operation_request
`);
// Actual writes in manager remark/fulfillment, payment admission, refund,
// physical/invoice materialization and their direct settlement helpers.
const insert = names(`
  store_order store_order_cart_info store_order_invoice store_order_invoice_allocation
  store_order_outbox store_order_promotions store_order_refund store_order_refund_payment
  store_order_refund_split store_order_fulfillment_branch store_order_status store_pink
  supplier_flowing_water supplier_transactions user_bill user_brokerage user_label_relation user_level
  manager_order_operation_request
`);
const update = names(`
  store_order store_order_cart_info store_order_refund store_order_refund_payment
  store_order_invoice store_pink
`);
const remove = ['store_order_cart_info', 'store_order_invoice'];
// Reference rows receive only the key column needed by the existing locking
// clauses. Staff/carrier/pricing tables instead use the exact lock functions.
const columns: Record<string, readonly string[]> = {
  user: ['uid', 'now_money', 'integral', 'exp', 'level', 'brokerage_price'],
  system_store: ['id'], user_address: ['id'], city_area: ['id'],
  system_user_level: ['id'], agent_level: ['id'], system_supplier: ['id'],
  user_invoice: ['id'], supplier_transactions: ['id'],
  store_activity: ['id'], store_seckill_time: ['id'], store_promotions: ['id'],
  store_order_promotions: ['id'], store_coupon_issue: ['id'],
  store_product: ['id', 'stock', 'sales'], store_product_attr_value: ['id', 'stock', 'sales'],
  store_bargain: ['id', 'stock', 'sales'], store_combination: ['id', 'stock', 'sales'],
  store_seckill: ['id', 'stock', 'sales'], store_integral: ['id', 'stock', 'sales'],
  store_discounts: ['id', 'limit_num'], store_bargain_user: ['id', 'status'],
  supplier_flowing_water: ['id', 'status', 'finish_time'], user_brokerage: ['id', 'frozen_time'],
  user_bill: ['id'], store_order_status: ['id'], user_level: ['id', 'grade', 'is_forever', 'status', 'is_del', 'mark', 'add_time', 'discount'],
};
const serialParents = insert.filter(name => ![
  'manager_order_operation_request', 'store_order_invoice_allocation',
  'store_order_refund_split', 'store_order_fulfillment_branch',
].includes(name));
export function managerRuntimePrivilegePlan(profile:ManagerRuntimeProfile='current'): RuntimePrivilegePlan {
  if(profile!=='current'&&profile!=='legacy-without-promotion-gift-receipt')throw Error('Unknown fixed manager profile');
  const tables: RuntimePrivilegePlan['tables'] = {};
  for (const name of [...new Set(read)].sort()) {
    if(profile==='legacy-without-promotion-gift-receipt'&&name===MANAGER_PROMOTION_GIFT_TABLE)continue;
    pricingIdentifier(name);
    tables[name] = ['SELECT', ...(insert.includes(name) ? ['INSERT' as const] : []),
      ...(update.includes(name) ? ['UPDATE' as const] : []), ...(remove.includes(name) ? ['DELETE' as const] : [])];
  }
  return { tables, updateColumns: Object.fromEntries(Object.entries(columns).map(([name, value]) => [name, [...value]])),
    functions: ['checkout_lock_pricing_v1()', 'manager_lock_scope_v1(integer,integer)', 'manager_lock_carrier_v1(text)',
      'manager_lock_waybill_v1()', 'manager_lock_delivery_agents_v1(integer,integer)', 'manager_delete_order_promotions_v1(integer,jsonb)'],
    standaloneSequences: serialParents.map(name => `${name}_id_seq`).sort() };
}

/** Fixed target only: no arbitrary role, schema, ACL plan or default grants.
 * The provisioning transaction must independently validate all catalogs first. */
export function managerRuntimeGrantSql(profile:ManagerRuntimeProfile='current'): readonly string[] {
  const plan = managerRuntimePrivilegePlan(profile), role = pricingIdentifier(MANAGER_RUNTIME_ROLE);
  return [`GRANT USAGE ON SCHEMA public TO ${role};`,
    ...Object.entries(plan.tables).map(([name, privileges]) => `GRANT ${privileges.join(',')} ON TABLE public.${pricingIdentifier(name)} TO ${role};`),
    ...Object.entries(plan.updateColumns).map(([name, value]) => `GRANT UPDATE(${value.map(pricingIdentifier).join(',')}) ON TABLE public.${pricingIdentifier(name)} TO ${role};`),
    ...plan.standaloneSequences.map(name => `GRANT USAGE ON SEQUENCE public.${pricingIdentifier(name)} TO ${role};`),
    ...plan.functions.map(name => `GRANT EXECUTE ON FUNCTION public.${name} TO ${role};`)];
}
