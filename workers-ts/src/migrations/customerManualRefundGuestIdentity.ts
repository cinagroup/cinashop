import {INVOICE_HISTORY_TABLE_SQL,INVOICE_ALLOCATION_TABLE_SQL} from './invoiceEvidence';
import {REFUND_ORDER_SPLIT_TABLE_SQL} from './refundOrderSplit';
import {INVOICE_MAINTENANCE_SETUP_SQL} from './invoiceEvidenceInstallation';
import {refundEntityAcceptedPairSql} from './guestRefundEntityCatalog';

/** Read the exact published predicate; the upgrade changes its buyer lower
 * bound alone. No model rewrite, table recreation, trigger/function replacement
 * or guessed backfill can enter this explicit owner transaction. */
function guestIdentityPredicate(source:string,name:string):string{
 const token=`CONSTRAINT ${name} CHECK (`,at=source.indexOf(token);if(at<0||source.indexOf(token,at+1)>=0)throw Error('Guest identity published constraint ambiguous');
 const begin=at+token.length;let depth=1,quoted=false,end=begin;
 for(;end<source.length;end++){const c=source[end];if(c==="'"){if(quoted&&source[end+1]==="'"){end++;continue;}quoted=!quoted;continue;}if(!quoted){if(c==='(')depth++;else if(c===')'&&--depth===0)break;}}
 if(depth!==0||quoted)throw Error('Guest identity published constraint incomplete');const body=source.slice(begin,end);
 if((body.match(/\buid > 0\b/g)??[]).length!==1)throw Error('Guest identity published buyer bound changed');return body.replace('uid > 0','uid >= 0');
}
export const CUSTOMER_MANUAL_GUEST_IDENTITY_CONSTRAINTS=Object.freeze([
 {table:'store_order_invoice_evidence',name:'soie_identity_ck',body:guestIdentityPredicate(INVOICE_HISTORY_TABLE_SQL,'soie_identity_ck')},
 {table:'store_order_invoice_allocation',name:'soia_identity_ck',body:guestIdentityPredicate(INVOICE_ALLOCATION_TABLE_SQL,'soia_identity_ck')},
 {table:'store_order_refund_split',name:'sors_identity_ck',body:guestIdentityPredicate(REFUND_ORDER_SPLIT_TABLE_SQL,'sors_identity_ck')},
 {table:'store_order_fulfillment_branch',name:'sofb_identity_ck',body:guestIdentityPredicate(REFUND_ORDER_SPLIT_TABLE_SQL,'sofb_identity_ck')},
]);
export const CUSTOMER_MANUAL_GUEST_IDENTITY_UPGRADE_SQL=`${INVOICE_MAINTENANCE_SETUP_SQL}
DO $cmfr_guest_identity$
DECLARE initial_profile text; locked_profile text;
BEGIN
 IF current_setting('server_version_num')::integer/10000<>16 OR current_setting('transaction_isolation')<>'read committed'
 OR current_setting('transaction_read_only')<>'off' OR current_setting('search_path')<>'public, pg_temp' OR current_schema()<>'public'
 OR current_setting('row_security')<>'off' OR current_setting('session_replication_role')<>'origin' OR current_user<>session_user
 OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 OR (SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout') NOT BETWEEN 1 AND 30000
 OR (SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout') NOT BETWEEN 1 AND 1000
 OR (SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout') NOT BETWEEN 1 AND 5000
 THEN RAISE EXCEPTION 'Guest refund identity upgrade requires bounded reviewed PG16 owner maintenance';END IF;
 IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Guest refund evidence maintenance busy';END IF;
 SELECT profile INTO initial_profile FROM (${refundEntityAcceptedPairSql()}) c;
 IF initial_profile NOT IN('legacy','guest') OR initial_profile IS NULL THEN RAISE EXCEPTION 'Guest refund upgrade requires exact coherent invoice/refund catalog';END IF;
 LOCK TABLE public.store_order_invoice IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.store_order_invoice_evidence IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.store_order_invoice_allocation IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.store_order_refund_split IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.store_order_fulfillment_branch IN ACCESS EXCLUSIVE MODE NOWAIT;
 SELECT profile INTO locked_profile FROM (${refundEntityAcceptedPairSql()}) c;
 IF locked_profile IS DISTINCT FROM initial_profile THEN RAISE EXCEPTION 'Guest refund catalog changed while locking';END IF;
 IF initial_profile='legacy' THEN
 ${CUSTOMER_MANUAL_GUEST_IDENTITY_CONSTRAINTS.map(c=>`ALTER TABLE public.${c.table} DROP CONSTRAINT ${c.name},ADD CONSTRAINT ${c.name} CHECK (${c.body});`).join('\n')}
 END IF;
END $cmfr_guest_identity$;
`;
export const CUSTOMER_MANUAL_GUEST_IDENTITY_POSTCHECK_SQL=`DO $cmfr_guest_postcheck$ BEGIN
 IF (SELECT profile FROM (${refundEntityAcceptedPairSql()}) c) IS DISTINCT FROM 'guest'
 THEN RAISE EXCEPTION 'Guest refund full catalog postcheck uncommissioned or incompatible';END IF;
END $cmfr_guest_postcheck$;`;
