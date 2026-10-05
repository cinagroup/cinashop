import { runtimeBusinessPrivilegePlan, type RuntimePrivilegePlan } from './runtimeBusinessPrivilegePlan';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

export const CUSTOMER_WORK_RUNTIME_OPERATION = 'customer-work-fulfillment-runtime-v1';
export const CUSTOMER_WORK_LOCK_FUNCTIONS = [
  'customer_work_lock_scope_v1(integer)', 'customer_work_lock_carrier_v1(integer)', 'customer_work_lock_courier_v1(integer)',
] as const;
/** Separate explicit maintenance profile. Historical whole-shop profiles keep
 * their original meanings. A customer runtime cannot edit customer/courier
 * identity; chat online presence remains an ordinary application operation. */
export function customerWorkRuntimePrivilegePlan(): RuntimePrivilegePlan {
  const original = runtimeBusinessPrivilegePlan('app');
  const plan: RuntimePrivilegePlan = { tables: Object.fromEntries(Object.entries(original.tables).map(([t,p]) => [t,[...p]])),
    updateColumns: Object.fromEntries(Object.entries(original.updateColumns).map(([t,c]) => [t,[...c]])),
    functions: [...original.functions,...CUSTOMER_WORK_LOCK_FUNCTIONS], standaloneSequences: [...original.standaloneSequences] };
  plan.tables.store_service = ['SELECT']; plan.updateColumns.store_service = ['online'];
  plan.tables.delivery_service = ['SELECT']; delete plan.updateColumns.delivery_service;
  plan.tables.express_company = ['SELECT']; delete plan.updateColumns.express_company;
  plan.tables.customer_work_operation_request = ['SELECT','INSERT'];
  for (const table of ['customer_city_delivery_job','customer_city_delivery_attempt','customer_city_delivery_binding'])
    plan.tables[table] = ['SELECT','INSERT'];
  plan.updateColumns.customer_city_delivery_job=['status','provider_order_id','lease_token','lease_until','last_error_code','update_time'];
  plan.updateColumns.customer_city_delivery_attempt=['phase','quote','result','error_code','issued_time','update_time'];
  plan.updateColumns.customer_city_delivery_binding=['active','update_time'];
  plan.tables.store_delivery_order=['SELECT','INSERT','UPDATE'];
  return plan;
}
/** Pure fixed grant compiler, used only after catalog and target inspection.
 * It does not revoke historical grants or install/repair protocols. */
export function customerWorkRuntimeGrantSql(role:string, owned:readonly {name:string;table:string}[]) {
  const target=pricingIdentifier(role),plan=customerWorkRuntimePrivilegePlan(),statements:string[]=[];
  for (const privilege of ['SELECT','INSERT','UPDATE','DELETE'] as const) {
    const tables=Object.entries(plan.tables).filter(([,p])=>p.includes(privilege)).map(([t])=>`public.${pricingIdentifier(t)}`);
    if(tables.length)statements.push(`GRANT ${privilege} ON ${tables.join(',')} TO ${target}`);
  }
  for(const [table,columns] of Object.entries(plan.updateColumns))
    statements.push(`GRANT UPDATE(${columns.map(pricingIdentifier).join(',')}) ON public.${pricingIdentifier(table)} TO ${target}`);
  const sequences=new Set(plan.standaloneSequences);
  for(const s of owned){pricingIdentifier(s.name);pricingIdentifier(s.table);if(plan.tables[s.table]?.includes('INSERT'))sequences.add(s.name);}
  if(sequences.size)statements.push(`GRANT USAGE ON SEQUENCE ${[...sequences].sort().map(s=>`public.${pricingIdentifier(s)}`).join(',')} TO ${target}`);
  for(const signature of plan.functions){if(!/^[a-z_][a-z_0-9]*\((?:integer)?\)$/.test(signature))throw Error('Unexpected customer runtime function');statements.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${target}`);}
  return statements;
}
