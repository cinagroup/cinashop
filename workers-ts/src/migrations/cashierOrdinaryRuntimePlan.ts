import type { RuntimePrivilegePlan } from './runtimeBusinessPrivilegePlan';
import { customerWriteoffRuntimePrivilegePlan } from './customerWriteoffRuntimePlan';
import { CASHIER_ORDINARY_TABLES } from './cashierOrdinary';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { cashierSecondCardPromotionLockGrantSql } from './cashierSecondCardPromotionLock';

export function cashierOrdinaryRuntimePrivilegePlan(): RuntimePrivilegePlan {
  const previous = customerWriteoffRuntimePrivilegePlan();
  const tables = Object.fromEntries(Object.entries(previous.tables).map(([name, rights]) => [name, [...rights]]));
  for (const table of CASHIER_ORDINARY_TABLES) tables[table] = ['SELECT', 'INSERT'];
  tables.store_order_promotions = ['SELECT', 'INSERT'];
  return { tables, updateColumns: { ...Object.fromEntries(Object.entries(previous.updateColumns).map(([name, cols]) => [name, [...cols]])),
    store_order_promotions: ['id'], system_attachment: [...new Set([...(previous.updateColumns.system_attachment ?? []), 'att_id'])] },
    functions: [...previous.functions], standaloneSequences: [...previous.standaloneSequences] };
}
/** Explicit reviewed maintenance grant compiler; never called by HTTP/startup. */
export function cashierOrdinaryRuntimeGrantSql(role: string, owned: readonly { name: string; table: string }[]) {
  const target = pricingIdentifier(role), plan = cashierOrdinaryRuntimePrivilegePlan(), statements: string[] = [];
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
    const tables = Object.entries(plan.tables).filter(([, rights]) => rights.includes(privilege)).map(([name]) => `public.${pricingIdentifier(name)}`);
    if (tables.length) statements.push(`GRANT ${privilege} ON ${tables.join(',')} TO ${target}`);
  }
  for (const [name, columns] of Object.entries(plan.updateColumns)) if (columns.length) {
    if (name === 'store_order_promotions') statements.push(cashierSecondCardPromotionLockGrantSql(role));
    else statements.push(`GRANT UPDATE(${columns.map(pricingIdentifier).join(',')}) ON public.${pricingIdentifier(name)} TO ${target}`);
  }
  const sequences = new Set(plan.standaloneSequences);
  for (const sequence of owned) {
    pricingIdentifier(sequence.name); pricingIdentifier(sequence.table);
    if (plan.tables[sequence.table]?.includes('INSERT')) sequences.add(sequence.name);
  }
  if (sequences.size) statements.push(`GRANT USAGE ON SEQUENCE ${[...sequences].sort().map(name => `public.${pricingIdentifier(name)}`).join(',')} TO ${target}`);
  for (const signature of plan.functions) {
    if (!/^[a-z_][a-z_0-9]*\((?:(?:integer|jsonb|text)(?:\[\])?(?:, (?:integer|jsonb|text)(?:\[\])?)*)?\)$/.test(signature)) throw Error('Unexpected fixed ordinary runtime function');
    statements.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${target}`);
  }
  return statements;
}
