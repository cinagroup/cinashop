import {customerFinancialRuntimePrivilegePlan,customerFinancialRuntimeGrantSql} from './customerFinancialRuntimePlan';
import {pricingIdentifier} from './checkoutPricingLockCatalog';
import type {RuntimePrivilegePlan} from './runtimeBusinessPrivilegePlan';
import {cashierSecondCardPromotionLockGrantSql} from './cashierSecondCardPromotionLock';
export const CUSTOMER_MANUAL_REFUND_FUNCTIONS=['customer_manual_refund_promotion_delete_v1(integer, integer)'] as const;
export function customerManualRefundRuntimePrivilegePlan():RuntimePrivilegePlan{const prior=customerFinancialRuntimePrivilegePlan();return{...prior,tables:{...prior.tables,store_order_promotions:['SELECT','INSERT'],customer_financial_manual_refund_v1:['SELECT','INSERT']},updateColumns:{...prior.updateColumns,store_order_promotions:['id']},functions:[...prior.functions,...CUSTOMER_MANUAL_REFUND_FUNCTIONS]};}
function promotionAppendGrants(role:string,owned:readonly{name:string;table:string}[]){const target=pricingIdentifier(role),rows=owned.filter(x=>x.table==='store_order_promotions');if(rows.length>1)throw Error('Manual promotion sequence ownership ambiguous');return[`GRANT SELECT,INSERT ON public.store_order_promotions TO ${target}`,...rows.map(x=>`GRANT USAGE ON SEQUENCE public.${pricingIdentifier(x.name)} TO ${target}`)];}
/** Stage one, BEFORE the manual definer is installed: install the fixed cashier
 * promotion trigger, then use its exact owner/catalog/ACL compiler for UPDATE(id).
 * This never substitutes a naked column grant for the reviewed row-lock guard. */
export function customerManualRefundPromotionGrantSql(role:string,owned:readonly{name:string;table:string}[]){return[...promotionAppendGrants(role,owned),cashierSecondCardPromotionLockGrantSql(role)];}
/** Stage two after explicit owner installation. The guarded UPDATE(id) must
 * already have passed stage one; readiness rechecks its actual trigger/ACL.
 * No runtime may install, grant or widen either realm itself. */
export function customerManualRefundRuntimeGrantSql(role:string,owned:readonly{name:string;table:string}[]){const target=pricingIdentifier(role);return[...customerFinancialRuntimeGrantSql(role,owned),...promotionAppendGrants(role,owned),`GRANT SELECT,INSERT ON public.customer_financial_manual_refund_v1 TO ${target}`,`GRANT EXECUTE ON FUNCTION public.customer_manual_refund_promotion_delete_v1(integer,integer) TO ${target}`];}
