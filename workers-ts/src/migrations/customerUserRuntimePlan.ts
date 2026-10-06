import type { RuntimePrivilegePlan } from './runtimeBusinessPrivilegePlan';
import { customerProductRuntimePrivilegePlan } from './customerProductRuntimePlan';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
export const CUSTOMER_USER_RUNTIME_OPERATION='customer-work-user-runtime-v1';
export const CUSTOMER_USER_FUNCTIONS=[
 'customer_user_targets_valid_v1(jsonb)',
 'customer_user_intent_valid_v1(text, jsonb)',
 'customer_user_lock_catalog_v1(text, integer[])',
] as const;
/** Explicit reviewed extension of the existing customer runtime. The four
 * taxonomy relations remain SELECT-only even though the NOLOGIN function
 * owner needs UPDATE solely to take PostgreSQL's lock modes. */
export function customerUserRuntimePrivilegePlan():RuntimePrivilegePlan {
 const existing=customerProductRuntimePrivilegePlan();
 const plan:RuntimePrivilegePlan={
  tables:Object.fromEntries(Object.entries(existing.tables).map(([table,privileges])=>[table,[...privileges]])),
  updateColumns:Object.fromEntries(Object.entries(existing.updateColumns).map(([table,columns])=>[table,[...columns]])),
  functions:[...existing.functions,...CUSTOMER_USER_FUNCTIONS],standaloneSequences:[...existing.standaloneSequences],
 };
 for(const table of ['user_group','user_label','system_user_level','category']) {
  plan.tables[table]=['SELECT'];delete plan.updateColumns[table];
 }
 plan.tables.customer_user_operation_request=['SELECT','INSERT'];
 return plan;
}
/** Fixed grant compiler for inspected maintenance only. Does not revoke an
 * existing profile, commission missing protocols, or repair API permissions. */
export function customerUserRuntimeGrantSql(role:string,owned:readonly {name:string;table:string}[]) {
 const target=pricingIdentifier(role),plan=customerUserRuntimePrivilegePlan(),statements:string[]=[];
 for(const privilege of ['SELECT','INSERT','UPDATE','DELETE'] as const) {
  const tables=Object.entries(plan.tables).filter(([,allowed])=>allowed.includes(privilege)).map(([table])=>`public.${pricingIdentifier(table)}`);
  if(tables.length)statements.push(`GRANT ${privilege} ON ${tables.join(',')} TO ${target}`);
 }
 for(const[table,columns]of Object.entries(plan.updateColumns))
  statements.push(`GRANT UPDATE(${columns.map(pricingIdentifier).join(',')}) ON public.${pricingIdentifier(table)} TO ${target}`);
 const sequences=new Set(plan.standaloneSequences);
 for(const sequence of owned){pricingIdentifier(sequence.name);pricingIdentifier(sequence.table);if(plan.tables[sequence.table]?.includes('INSERT'))sequences.add(sequence.name);}
 if(sequences.size)statements.push(`GRANT USAGE ON SEQUENCE ${[...sequences].sort().map(name=>`public.${pricingIdentifier(name)}`).join(',')} TO ${target}`);
 for(const signature of plan.functions) {
  if(!/^[a-z_][a-z_0-9]*\((?:integer|jsonb|text, jsonb|text, integer\[\])?\)$/u.test(signature))throw Error('Unexpected customer user runtime function');
  statements.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${target}`);
 }
 return statements;
}
