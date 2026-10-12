import type { RuntimePrivilegePlan } from './runtimeBusinessPrivilegePlan';
import { cashierSecondCardRuntimeGrantSql, cashierSecondCardRuntimePrivilegePlan } from './cashierSecondCardRuntimePlan';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { CASHIER_SECOND_CARD_FORM_IMAGE_TABLES, CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS,
  CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS, CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS } from './cashierSecondCardFormImages';
export { CASHIER_SECOND_CARD_FORM_IMAGE_TABLES, CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS,
  CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS, CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS } from './cashierSecondCardFormImages';
export const CASHIER_SECOND_CARD_FORM_IMAGES_RUNTIME_OPERATION = 'customer-cashier-second-card-form-images-runtime-v1';
/** Adds only guarded session/upload columns; the existing profile stays intact. */
export function cashierSecondCardFormImagesRuntimePrivilegePlan(): RuntimePrivilegePlan {
  const previous = cashierSecondCardRuntimePrivilegePlan();
  return { tables: { ...Object.fromEntries(Object.entries(previous.tables).map(([name, values]) => [name, [...values]])),
    ...Object.fromEntries(CASHIER_SECOND_CARD_FORM_IMAGE_TABLES.map(name => [name, ['SELECT', 'INSERT']])) },
    updateColumns: { ...Object.fromEntries(Object.entries(previous.updateColumns).map(([name, values]) => [name, [...values]])),
      cashier_second_card_form_session_v1: [...CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS],
      cashier_second_card_form_upload_v1: [...CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS] },
    functions: [...previous.functions, ...CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS], standaloneSequences: [...previous.standaloneSequences] };
}
/** Explicit maintenance compiler; never runtime installation or repair. */
export function cashierSecondCardFormImagesRuntimeGrantSql(role: string, owned: readonly { name: string; table: string }[]) {
  const target = pricingIdentifier(role), statements = cashierSecondCardRuntimeGrantSql(role, owned);
  for (const table of CASHIER_SECOND_CARD_FORM_IMAGE_TABLES) statements.push(`GRANT SELECT,INSERT ON public.${pricingIdentifier(table)} TO ${target}`);
  for (const [table, columns] of [[CASHIER_SECOND_CARD_FORM_IMAGE_TABLES[0], CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS],
    [CASHIER_SECOND_CARD_FORM_IMAGE_TABLES[1], CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS]] as const)
    statements.push(`GRANT UPDATE(${columns.map(pricingIdentifier).join(',')}) ON public.${pricingIdentifier(table)} TO ${target}`);
  for (const signature of CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS) statements.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${target}`);
  return statements;
}
