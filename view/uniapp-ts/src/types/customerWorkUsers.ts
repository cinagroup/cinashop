export const CUSTOMER_USER_READ_VERSION = 'customer-work-user-read-v1' as const;
export const CUSTOMER_USER_OPERATION_VERSION = 'customer-work-user-operation-v1' as const;
export type CustomerWorkUserKind = 'replace_level'|'replace_group'|'replace_labels'|'grant_coupons'|'adjust_membership'|'adjust_money'|'adjust_integral';
export type Hash64 = string;
export type Direction = 'add'|'subtract';
export interface CustomerWorkUserAction { available:boolean; reason:string }
export type CustomerWorkUserActions = Record<CustomerWorkUserKind,CustomerWorkUserAction>;
export interface CustomerWorkUserLabel { id:number; label_name:string; color:string }
export interface CustomerWorkUser {
 uid:number; nickname:string; avatar:string; phone:string; status:0|1; deleted:boolean;
 group_id:number; group_name:string; level:number; level_name:string; level_status:0|1; level_grade:number|null;
 labels:CustomerWorkUserLabel[]; now_money:string|null; integral:number|null; financial_diagnostics:string[];
 isMember:0|1; is_money_level:0|1|2|3; is_ever_level:0|1; overdue_time:number; membership_active:boolean;
 svip_over_day:number|null; svip_overdue_time:string; user_revision:Hash64; actions:CustomerWorkUserActions;
}
export interface CustomerWorkUserDetail extends CustomerWorkUser {
 real_name:string; birthday:string; birthday_epoch:number; card_id:string; addres:string; add_time:number; _add_time:string;
 order_total_count:number; order_total_price:string; coupon_num:number;
}
export const CUSTOMER_USER_SCOPES = {users:'global',groups:'global',levels:'global',labels:'platform',coupon_issues:'global_send',wallet:'exact_target_user',paid_order_count:'original_roots',paid_order_value:'physical_fulfillments'} as const;
export interface CustomerWorkUserMeta { scopes:typeof CUSTOMER_USER_SCOPES; catalog_revision:Hash64; readiness:{writes:boolean;reason:string}; at_time:number }
export interface CustomerWorkUserEnvelope<T> {
 version:typeof CUSTOMER_USER_READ_VERSION;actor_uid:number;
 principal:{kind:'customer-order-manager';service_id:number;scope:'global'};
 scope_key:Hash64;consistency_key:Hash64;data:T&CustomerWorkUserMeta;
}
export interface CustomerWorkUserList extends CustomerWorkUserMeta {list:CustomerWorkUser[];count:number;page:number;limit:number;has_more:boolean}
export interface CustomerWorkUserDetailData extends CustomerWorkUserMeta {user:CustomerWorkUserDetail}
export interface CustomerWorkUserGroups extends CustomerWorkUserMeta {list:{id:number;group_name:string}[];count:number}
export interface CustomerWorkUserLevels extends CustomerWorkUserMeta {list:{id:number;name:string;grade:number;image:string;icon:string}[];count:number}
export interface CustomerWorkUserLabels extends CustomerWorkUserMeta {uid:number;list:{id:number;name:string;sort:number;label:(CustomerWorkUserLabel&{label_cate:number;selected:boolean})[]}[];count:number}
export interface CustomerWorkUserCouponCandidate {
 id:number;cid:number;coupon_title:string;type:1|2;coupon_type:0|1|2|3;coupon_price:string;use_min_price:string;
 total_count:number;remain_count:number;is_permanent:0|1;receive_limit:number;receive_type:3;day:number;
 start_time:string|null;end_time:string|null;use_start_time:string|null;use_end_time:string|null;coupon_time:string;
 issue_revision:Hash64;action:CustomerWorkUserAction;
}
export interface CustomerWorkUserCouponCandidates extends CustomerWorkUserMeta {list:CustomerWorkUserCouponCandidate[];count:number;page:number;limit:number;has_more:boolean}
export interface CustomerWorkUserCoupon {
 id:number;uid:number;issue_coupon_id:number;template_id:number|null;coupon_title:string;coupon_price:string;use_min_price:string;
 status:0;is_fail:0|1;type:1|2;coupon_type:0|1|2|3|null;receive_source:string;receive_time:number;
 start_time:string|null;end_time:string|null;use_time:string|null;availability:'available'|'future'|'expired'|'invalid';
 availability_message:string;
}
export interface CustomerWorkUserCoupons extends CustomerWorkUserMeta {uid:number;list:CustomerWorkUserCoupon[];count:number;page:number;limit:number;has_more:boolean}
export type CustomerWorkUserPayload =
 {level_id:number}|{group_id:number}|{label_ids:number[]}|{issue_id:number;expected_issue_revision:Hash64}|
 {direction:Direction;days:number}|{direction:Direction;amount:string}|{direction:Direction;amount:number};
export interface CustomerWorkUserBody {
 version:typeof CUSTOMER_USER_OPERATION_VERSION;scope_key:Hash64;
 targets:{uid:number;expected_user_revision:Hash64}[];expected_catalog_revision:Hash64;payload:CustomerWorkUserPayload;
}
export type CustomerWorkUserOutcome='users-updated'|'coupons-granted'|'membership-adjusted'|'finance-adjusted'|'rollback-rejected'|'abandoned';
export type CustomerWorkUserEvidence=
 {changed:number;verified:true}|{changed:number;issued_count:number;issue_id:number;verified:true}|
 {changed:0|1;other_order_id:number;verified:true}|{changed:0|1;money_ledger_id:number;verified:true}|
 {changed:0|1;integral_ledger_id:number;verified:true}|{code:string}|Record<string,never>;
export interface CustomerWorkUserReceipt {
 version:typeof CUSTOMER_USER_OPERATION_VERSION;actor_uid:number;service_id:number;request_key:string;request_hash:Hash64;
 kind:CustomerWorkUserKind;user_ids:number[];outcome:CustomerWorkUserOutcome;evidence:CustomerWorkUserEvidence;
}
export interface CustomerWorkUserOperationResult {receipt:CustomerWorkUserReceipt;replayed:boolean}
export interface CustomerWorkUserOutcomeData {receipt:CustomerWorkUserReceipt|null}


export interface CustomerWorkUserIntent {version:"customer-work-user-pending-v1";actor_uid:number;service_id:number;scope_key:string;kind:CustomerWorkUserKind;request_key:string;request_hash:string;body:CustomerWorkUserBody;endpoint:string;method:"POST";created_at:number}
export interface CustomerWorkUserOperationState {receipt:CustomerWorkUserReceipt|null;unknown:boolean;error:string}
