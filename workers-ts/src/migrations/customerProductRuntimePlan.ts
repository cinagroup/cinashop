import type { RuntimePrivilegePlan } from './runtimeBusinessPrivilegePlan';
import { customerWorkRuntimePrivilegePlan } from './customerWorkRuntimePrivilegePlan';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
export const CUSTOMER_PRODUCT_RUNTIME_OPERATION='customer-work-product-runtime-v1';
export const CUSTOMER_PRODUCT_FUNCTIONS=[
 'customer_product_targets_valid_v1(jsonb)',
 'customer_product_lock_catalog_v1(text, integer[])',
] as const;
/** Explicit reviewed extension of the existing customer runtime. The three
 * taxonomy relations remain SELECT-only even though the NOLOGIN function
 * owner needs UPDATE solely to take PostgreSQL's lock modes. */
export function customerProductRuntimePrivilegePlan():RuntimePrivilegePlan {
 const existing=customerWorkRuntimePrivilegePlan();
 const plan:RuntimePrivilegePlan={
  tables:Object.fromEntries(Object.entries(existing.tables).map(([table,privileges])=>[table,[...privileges]])),
  updateColumns:Object.fromEntries(Object.entries(existing.updateColumns).map(([table,columns])=>[table,[...columns]])),
  functions:[...existing.functions,...CUSTOMER_PRODUCT_FUNCTIONS],standaloneSequences:[...existing.standaloneSequences],
 };
 for(const table of ['store_product_category','store_product_label','category']) {
  plan.tables[table]=['SELECT'];delete plan.updateColumns[table];
 }
 plan.tables.customer_product_operation_request=['SELECT','INSERT'];
 return plan;
}
/** Fixed grant compiler for inspected maintenance only. Does not revoke an
 * existing profile, commission missing protocols, or repair API permissions. */
export function customerProductRuntimeGrantSql(role:string,owned:readonly {name:string;table:string}[]) {
 const target=pricingIdentifier(role),plan=customerProductRuntimePrivilegePlan(),statements:string[]=[];
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
  if(!/^[a-z_][a-z_0-9]*\((?:integer|jsonb|text, integer\[\])?\)$/u.test(signature))throw Error('Unexpected customer product runtime function');
  statements.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${target}`);
 }
 return statements;
}
