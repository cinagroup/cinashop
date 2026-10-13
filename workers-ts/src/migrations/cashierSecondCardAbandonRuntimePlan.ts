import { cashierSecondCardRuntimeGrantSql, cashierSecondCardRuntimePrivilegePlan } from './cashierSecondCardRuntimePlan';
import { cashierSecondCardFormImagesRuntimeGrantSql,cashierSecondCardFormImagesRuntimePrivilegePlan } from './cashierSecondCardFormImagesRuntimePlan';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import type { RuntimePrivilegePlan } from './runtimeBusinessPrivilegePlan';
export const CASHIER_SECOND_CARD_ABANDON_RUNTIME_OPERATION='customer-cashier-second-card-abandon-runtime-v1';
/** Complete cashier + image profile. The base variant supports the earlier cashier-only installation. */
export function cashierSecondCardAbandonRuntimePrivilegePlan(images=true):RuntimePrivilegePlan {
 const previous=images?cashierSecondCardFormImagesRuntimePrivilegePlan():cashierSecondCardRuntimePrivilegePlan();
 return{...previous,tables:{...previous.tables,cashier_second_card_abandon_v1:['SELECT','INSERT']}};
}
export function cashierSecondCardAbandonRuntimeGrantSql(role:string,owned:readonly {name:string;table:string}[],images=true) {
 const previous=images?cashierSecondCardFormImagesRuntimeGrantSql(role,owned):cashierSecondCardRuntimeGrantSql(role,owned);
 return[...previous,`GRANT SELECT,INSERT ON public.cashier_second_card_abandon_v1 TO ${pricingIdentifier(role)}`];
}
