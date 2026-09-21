import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { runtimeBusinessPrivilegePlan } from './runtimeBusinessPrivilegePlan';

export interface RuntimeOwnedSequence { name:string; table:string }
/** Pure fixed-profile compiler. The caller must verify catalog ownership and
 * shape, install the conditional-write boundaries and bind the real target.
 * No ALL/default privileges, ownership, role changes or sequence resets. */
export function runtimeBusinessGrantSql(kind:'app'|'admin',role:string,owned:readonly RuntimeOwnedSequence[]) {
  const plan=runtimeBusinessPrivilegePlan(kind),target=pricingIdentifier(role),statements:string[]=[];
  for(const privilege of ['SELECT','INSERT','UPDATE','DELETE'] as const){
    const tables=Object.entries(plan.tables).filter(([,p])=>p.includes(privilege)).map(([t])=>'public.'+pricingIdentifier(t));
    if(tables.length)statements.push(`GRANT ${privilege} ON ${tables.join(',')} TO ${target}`);
  }
  for(const [table,columns] of Object.entries(plan.updateColumns))
    statements.push(`GRANT UPDATE(${columns.map(pricingIdentifier).join(',')}) ON public.${pricingIdentifier(table)} TO ${target}`);
  const sequences=new Set(plan.standaloneSequences);
  for(const sequence of owned){
    pricingIdentifier(sequence.name);pricingIdentifier(sequence.table);
    if(plan.tables[sequence.table]?.includes('INSERT'))sequences.add(sequence.name);
  }
  if(sequences.size)statements.push(`GRANT USAGE ON SEQUENCE ${[...sequences].sort().map(s=>'public.'+pricingIdentifier(s)).join(',')} TO ${target}`);
  for(const signature of plan.functions){
    if(!/^[a-z_][a-z_0-9]*\(\)$/.test(signature))throw Error('Unexpected runtime routine signature');
    statements.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${target}`);
  }
  return statements;
}
