import { customerWorkCanonicalJson,isCustomerWorkUserIntent,customerWorkUuid } from './customerWorkUsersContract';
import { customerWorkRequestKey } from './customerWorkFulfillment';
import type { CustomerWorkUserIntent } from '../types/customerWorkUsers';
export * from './customerWorkUsersContract';
export { customerWorkRequestKey };
export const CUSTOMER_WORK_USER_STORAGE='customer_work_user_pending_v1';
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
export function customerWorkUserPending():CustomerWorkUserIntent[]{const value=uni.getStorageSync(CUSTOMER_WORK_USER_STORAGE);if(value===undefined||value===null||value==='')return[];assert(Array.isArray(value)&&value.length<=100&&value.every(isCustomerWorkUserIntent)&&new Set(value.map(row=>row.request_key)).size===value.length,'原用户操作记录损坏，请保留记录并核对');return JSON.parse(customerWorkCanonicalJson(value));}
export function retainCustomerWorkUserIntent(intent:CustomerWorkUserIntent){assert(isCustomerWorkUserIntent(intent),'原用户意图无效，尚未提交');const previous=customerWorkUserPending(),known=previous.find(row=>row.request_key===intent.request_key);if(known){assert(customerWorkCanonicalJson(known)===customerWorkCanonicalJson(intent),'同一用户请求编号不能替换内容');return;}assert(previous.length<100,'待核对用户操作过多，请先查询');const next=JSON.parse(customerWorkCanonicalJson([...previous,intent]));uni.setStorageSync(CUSTOMER_WORK_USER_STORAGE,next);assert(customerWorkCanonicalJson(customerWorkUserPending())===customerWorkCanonicalJson(next),'原用户意图保存未确认，尚未提交');}
export function releaseCustomerWorkUserIntent(key:string){assert(customerWorkUuid(key),'原用户请求编号无效');const next=customerWorkUserPending().filter(row=>row.request_key!==key);uni.setStorageSync(CUSTOMER_WORK_USER_STORAGE,next);assert(customerWorkCanonicalJson(customerWorkUserPending())===customerWorkCanonicalJson(next),'关闭原用户记录失败，请继续核对');}

/** Translate public diagnostic codes at the display boundary; wire validation stays independent. */
export function customerWorkUserNotice(code:string,area:'diagnostic'|'readiness'|'action'|'coupon'='action'):string{
 const messages:Record<string,string>={
  money_invalid:'余额记录异常，请先核对账户。',integral_invalid:'积分记录异常，请先核对账户。',user_deleted:'用户已删除，当前仅可查看。',permanent_membership:'永久会员无需调整时长。',user_management_not_ready:'用户管理暂未开放修改，当前仅可查看。',
  customer_user_operation_not_installed:'用户管理暂未开放修改，当前仅可查看。',customer_user_operation_catalog_incompatible:'用户管理尚未完成验收，当前仅可查看。',
  coupon_issue_unavailable:'这张券当前不能赠送。',coupon_issue_invalid:'优惠券记录异常，暂不可赠送。',coupon_discount_invalid:'优惠券折扣记录异常，暂不可赠送。',coupon_issue_window_invalid:'优惠券领取期限异常，暂不可赠送。',coupon_issue_not_started:'这张券尚未开始领取。',coupon_issue_ended:'这张券的领取期限已结束。',coupon_issue_empty:'优惠券剩余数量不足。',coupon_title_invalid:'优惠券名称异常，暂不可赠送。',coupon_use_window_invalid:'优惠券使用期限异常，暂不可赠送。',
  coupon_future:'尚未到优惠券使用时间。',coupon_expired:'优惠券已超过使用期限。',coupon_invalid:'优惠券记录异常或已失效。'
 };
 const fallback={diagnostic:'账户记录存在异常，请核对后再调整。',readiness:'用户管理暂未开放修改，当前仅可查看。',action:'当前无法执行此操作，请重新读取并核对用户状态。',coupon:'这张优惠券当前不可使用或赠送，请核对券记录。'};
 return code?Object.hasOwn(messages,code)?messages[code]!:fallback[area]:area==='readiness'?fallback.readiness:'';
}
