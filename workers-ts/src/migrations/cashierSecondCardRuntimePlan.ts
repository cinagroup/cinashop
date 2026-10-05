import type { RuntimePrivilegePlan } from './runtimeBusinessPrivilegePlan';
import { customerWriteoffRuntimePrivilegePlan } from './customerWriteoffRuntimePlan';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { cashierSecondCardPromotionLockGrantSql, CASHIER_SECOND_CARD_PROMOTION_LOCK_COLUMNS } from './cashierSecondCardPromotionLock';

export const CASHIER_SECOND_CARD_RUNTIME_OPERATION = 'customer-cashier-second-card-runtime-v1';
export const CASHIER_SECOND_CARD_TABLES = ['cashier_second_card_cart_v1', 'cashier_second_card_origin_v1', 'cashier_second_card_payment_v1'] as const;
export const CASHIER_SECOND_CARD_PURCHASE_APPEND_TABLES = ['store_order_promotions'] as const;
export const CASHIER_SECOND_CARD_FUNCTIONS = [
  'cashier_second_card_origin_valid_v1(text, jsonb)',
  'cashier_second_card_payment_valid_v1(text, jsonb)',
] as const;
export function cashierSecondCardRuntimePrivilegePlan(): RuntimePrivilegePlan {
  const previous = customerWriteoffRuntimePrivilegePlan();
  const tables = Object.fromEntries(Object.entries(previous.tables).map(([name, privileges]) => [name, [...privileges]]));
  for (const table of CASHIER_SECOND_CARD_TABLES) tables[table] = ['SELECT', 'INSERT'];
  for (const table of CASHIER_SECOND_CARD_PURCHASE_APPEND_TABLES) tables[table] = ['SELECT', 'INSERT'];
  return { tables,
    updateColumns: { ...Object.fromEntries(Object.entries(previous.updateColumns).map(([name, columns]) => [name, [...columns]])),
      store_order_promotions: [...CASHIER_SECOND_CARD_PROMOTION_LOCK_COLUMNS] },
    functions: [...previous.functions, ...CASHIER_SECOND_CARD_FUNCTIONS], standaloneSequences: [...previous.standaloneSequences] };
}
/** Fixed maintenance grants only. Never an API repair or automatic installer. */
export function cashierSecondCardRuntimeGrantSql(role: string, owned: readonly { name: string; table: string }[]) {
  const target = pricingIdentifier(role), plan = cashierSecondCardRuntimePrivilegePlan(), statements: string[] = [];
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
    const tables = Object.entries(plan.tables).filter(([, allowed]) => allowed.includes(privilege)).map(([name]) => `public.${pricingIdentifier(name)}`);
    if (tables.length) statements.push(`GRANT ${privilege} ON ${tables.join(',')} TO ${target}`);
  }
  for (const [name, columns] of Object.entries(plan.updateColumns)) if (columns.length) {
    if (name === 'store_order_promotions') {
      if (columns.length !== 1 || columns[0] !== 'id') throw Error('Cashier promotion row lock only permits the reviewed id column');
      statements.push(cashierSecondCardPromotionLockGrantSql(role));
    } else statements.push(`GRANT UPDATE(${columns.map(pricingIdentifier).join(',')}) ON public.${pricingIdentifier(name)} TO ${target}`);
  }
  const sequences = new Set(plan.standaloneSequences);
  for (const sequence of owned) {
    pricingIdentifier(sequence.name); pricingIdentifier(sequence.table);
    if (plan.tables[sequence.table]?.includes('INSERT')) sequences.add(sequence.name);
  }
  if (sequences.size) statements.push(`GRANT USAGE ON SEQUENCE ${[...sequences].sort().map(name => `public.${pricingIdentifier(name)}`).join(',')} TO ${target}`);
  for (const signature of plan.functions) {
    if (!/^[a-z_][a-z_0-9]*\((?:(?:integer|jsonb|text)(?:\[\])?(?:, (?:integer|jsonb|text)(?:\[\])?)*)?\)$/.test(signature))
      throw Error('Unexpected fixed cashier second card function');
    statements.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${target}`);
  }
  return statements;
}
