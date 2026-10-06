import type { RuntimePrivilegePlan } from './runtimeBusinessPrivilegePlan';
import { customerUserRuntimePrivilegePlan } from './customerUserRuntimePlan';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

export const CUSTOMER_FINANCIAL_RUNTIME_OPERATION='customer-work-financial-runtime-v1';
export const CUSTOMER_FINANCIAL_FUNCTIONS=[
 'customer_financial_intent_valid_v1(text, jsonb)',
 'customer_financial_evidence_valid_v1(text, text, jsonb, jsonb)',
] as const;
/** The existing customer profile stays intact. The new ledger is append/read only. */
export function customerFinancialRuntimePrivilegePlan():RuntimePrivilegePlan {
 const previous=customerUserRuntimePrivilegePlan();
 return{tables:{...Object.fromEntries(Object.entries(previous.tables).map(([name,privileges])=>[name,[...privileges]])),customer_financial_operation_request:['SELECT','INSERT']},
 updateColumns:Object.fromEntries(Object.entries(previous.updateColumns).map(([name,columns])=>[name,[...columns]])),
 functions:[...previous.functions,...CUSTOMER_FINANCIAL_FUNCTIONS],standaloneSequences:[...previous.standaloneSequences]};
}
/** Fixed maintenance compiler, never an automatic runtime grant or revoke. */
export function customerFinancialRuntimeGrantSql(role:string,owned:readonly {name:string;table:string}[]) {
 const target=pricingIdentifier(role),plan=customerFinancialRuntimePrivilegePlan(),statements:string[]=[];
 for(const privilege of ['SELECT','INSERT','UPDATE','DELETE'] as const) {
  const tables=Object.entries(plan.tables).filter(([,allowed])=>allowed.includes(privilege)).map(([name])=>`public.${pricingIdentifier(name)}`);
  if(tables.length)statements.push(`GRANT ${privilege} ON ${tables.join(',')} TO ${target}`);
 }
 for(const[name,columns]of Object.entries(plan.updateColumns))if(columns.length)
  statements.push(`GRANT UPDATE(${columns.map(pricingIdentifier).join(',')}) ON public.${pricingIdentifier(name)} TO ${target}`);
 const sequences=new Set(plan.standaloneSequences);
 for(const sequence of owned){pricingIdentifier(sequence.name);pricingIdentifier(sequence.table);if(plan.tables[sequence.table]?.includes('INSERT'))sequences.add(sequence.name);}
 if(sequences.size)statements.push(`GRANT USAGE ON SEQUENCE ${[...sequences].sort().map(name=>`public.${pricingIdentifier(name)}`).join(',')} TO ${target}`);
 for(const signature of plan.functions) {
  if(!/^[a-z_][a-z_0-9]*\((?:(?:integer|jsonb|text)(?:\[\])?(?:, (?:integer|jsonb|text)(?:\[\])?)*)?\)$/.test(signature))throw Error('Unexpected fixed customer financial function');
  statements.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${target}`);
 }
 return statements;
}
