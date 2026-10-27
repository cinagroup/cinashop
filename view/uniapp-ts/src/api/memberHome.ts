import {createUserCenterRequests} from '@/api/userCenter';
import {getFormType} from '@/utils/request';

export type MemberPayMethod='yue'|'weixin'|'alipay';
export interface MemberHomePlan {id:number;title:string;type:string;vipDay:number;price:string;payPrice:string;label:boolean;expiry:string}
export interface MemberHomeRight {id:number;title:string;explain:string;image:string}
export interface MemberHomeCoupon {id:number;title:string;scope:string;type:1|2;price:string;minimum:string;status:string;disabled:boolean}
export interface MemberHomeProduct {id:number;title:string;image:string;price:string;vipPrice:string}
export interface MemberHomeData {requestId:string;uid:number;nickname:string;avatar:string;balance:string;permanent:boolean;member:boolean;expiry:number;freeUsed:boolean;registerDays:number;saved:string;shopName:string;plans:MemberHomePlan[];rights:MemberHomeRight[];coupons:MemberHomeCoupon[]}
export interface MemberPurchaseOrder {id:number;orderId:string;planId:number;price:string;paid:boolean;expiry:number}
export interface MemberPurchaseReceipt {uid:number;requestId:string;state:'unknown'|'committed';order:MemberPurchaseOrder|null}
export interface MemberMethod {enabled:boolean;reason:string}
export interface MemberCashier {orderId:string;price:string;paid:boolean;payable:boolean;reason:string;methods:Record<MemberPayMethod,MemberMethod>}
export interface MemberPayment {orderId:string;paid:boolean;payType?:string;config?:Record<string,unknown>;url?:string}
export const memberRequestId=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const invalid=()=>new Error('会员数据不完整，请重新读取');
function record(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw invalid();return v as Record<string,unknown>;}
function text(v:unknown,max=512):string{if(typeof v!=='string'||v.length>max)throw invalid();return v;}
function integer(v:unknown,min=0):number{if(!Number.isSafeInteger(v)||(Number(v)<min||Number(v)>2147483647))throw invalid();return Number(v);}
function flag(v:unknown):boolean{if(v!==0&&v!==1)throw invalid();return v===1;}
export function memberCents(v:unknown):number{if(typeof v!=='string'||!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(v))throw invalid();const [whole,part='']=v.split('.');const n=Number(whole)*100+Number(part.padEnd(2,'0'));if(!Number.isSafeInteger(n))throw invalid();return n;}
export function memberMoney(cents:number):string{if(!Number.isSafeInteger(cents)||cents<0)throw invalid();return `${Math.floor(cents/100)}.${String(cents%100).padStart(2,'0')}`;}
function money(v:unknown):string{return memberMoney(memberCents(v));}
function array(v:unknown,max:number):unknown[]{if(!Array.isArray(v)||v.length>max)throw invalid();return v;}
function unique<T extends {id:number}>(rows:T[]):T[]{if(new Set(rows.map(v=>v.id)).size!==rows.length)throw invalid();return rows;}
export function decodeMemberCoupons(value:unknown):MemberHomeCoupon[]{return unique(array(value,50).map(v=>{const r=record(v),used=r.used===null?null:record(r.used);if(typeof r.is_use!=='boolean'||(r.type!==1&&r.type!==2))throw invalid();let status=r.is_use?'已领取':'会员专享',disabled=false;if(used){const n=integer(used.status);disabled=n>0||used.isFail===1;status=used.isFail===1?'已失效':({0:'已领取',1:'已使用',2:'已过期',3:'订单占用'} as Record<number,string>)[n]??'暂不可用';}return{id:integer(r.id,1),title:text(r.couponTitle,255)||text(r.title,64)||'会员优惠券',scope:({0:'通用券',1:'品类券',2:'商品券',3:'品牌券'} as Record<number,string>)[integer(r.couponType)]??'优惠券',type:r.type,price:money(r.couponPrice),minimum:money(r.useMinPrice),status,disabled};}));}
export function decodeMemberHome(value:unknown,owner:number):MemberHomeData{
 const r=record(value),free=record(r.is_get_free),user=record(free.user_info);if(integer(user.uid,1)!==owner||!memberRequestId(r.purchase_request_id))throw Error('会员资料与当前账户不一致');
 const plans=unique(array(r.member_type,1000).map(v=>{const p=record(v);return{id:integer(p.id,1),title:text(p.title,255),type:text(p.type,32),vipDay:integer(p.vip_day),price:money(p.price),payPrice:money(p.pre_price),label:flag(p.is_label),expiry:text(p.overdue_time,64)};}));
 const rights=unique(array(r.member_rights,1000).map(v=>{const p=record(v);return{id:integer(p.id,1),title:text(p.title,255),explain:text(p.explain,512),image:text(p.pic,4096)};}));
 return{requestId:r.purchase_request_id,uid:owner,nickname:text(user.nickname,255),avatar:text(user.avatar,4096),balance:money(user.now_money),permanent:flag(user.is_ever_level),member:integer(user.is_money_level)>0,expiry:integer(user.overdue_time),freeUsed:flag(free.is_record),registerDays:integer(user.register_days),saved:money(user.economize_money),shopName:text(user.shop_name,512),plans,rights,coupons:decodeMemberCoupons(r.member_coupons)};
}
function order(value:unknown,planId?:number):MemberPurchaseOrder{const r=record(value),id=text(r.order_id,32);if(!/^[A-Za-z0-9_-]{2,32}$/u.test(id)||typeof r.paid!=='boolean')throw invalid();const p=planId??integer(r.member_type,1);return{id:integer(r.id,1),orderId:id,planId:p,price:money(r.pay_price),paid:r.paid,expiry:integer(r.overdue_time,-1)};}
export function decodeMemberReceipt(value:unknown,owner:number,key:string):MemberPurchaseReceipt{const r=record(value);if(r.owner_uid!==owner||r.request_id!==key||!memberRequestId(key)||(r.state!=='unknown'&&r.state!=='committed'))throw Error('会员订单与当前账户不一致');if(r.state==='unknown'){if(r.order!==null)throw invalid();return{uid:owner,requestId:key,state:'unknown',order:null};}return{uid:owner,requestId:key,state:'committed',order:order(r.order)};}
export function decodeMemberCashier(value:unknown,id:string):MemberCashier{const r=record(value);if(r.type!=='vip'||r.order_id!==id||typeof r.paid!=='boolean'||typeof r.payable!=='boolean')throw Error('会员收银台与原订单不一致');const methods=record(r.methods),out={} as MemberCashier['methods'];for(const k of ['yue','weixin','alipay'] as const){const m=record(methods[k]);if(typeof m.enabled!=='boolean')throw invalid();out[k]={enabled:m.enabled,reason:text(m.reason,1000)};}return{orderId:id,price:money(r.pay_price),paid:r.paid,payable:r.payable,reason:text(r.payable_reason,1000),methods:out};}
export function decodeMemberPayment(value:unknown,id:string,method:MemberPayMethod):MemberPayment{const r=record(value);if(r.order_id!==id||typeof r.paid!=='boolean'||(!r.paid&&r.pay_type!==method))throw Error('支付响应与原会员订单不一致');return{orderId:id,paid:r.paid,...(typeof r.pay_type==='string'?{payType:r.pay_type}:{}),...(r.jsConfig!==undefined?{config:record(r.jsConfig)}:{}),...(r.payUrl!==undefined?{url:text(r.payUrl,12000)}:{})};}
export function memberPurchaseChannel(ua?:string):'weixinh5'|'weixin'|'routine'{
 // #ifdef MP-WEIXIN
 return 'routine';
 // #endif
 // #ifdef APP-PLUS
 return 'weixin';
 // #endif
 // #ifdef H5
 return /MicroMessenger/i.test(ua??(typeof window!=='undefined'?window.navigator.userAgent:''))?'weixin':'weixinh5';
 // #endif
}
export function memberPlatform(){return getFormType();}
export function createMemberHomeRequests(current:()=>boolean){const scope=createUserCenterRequests(current);return{...scope,
 home:async()=>decodeMemberHome(await scope.request('user/member/card/index','GET',{home:1},true),scope.owner.uid),
 receipt:async(key:string)=>decodeMemberReceipt(await scope.request('user/member/card/index','GET',{purchase_request:key},true),scope.owner.uid,key),
 create:async(planId:number,key:string)=>{if(!memberRequestId(key)||!Number.isSafeInteger(planId)||planId<1)throw invalid();return order(await scope.request('user/member/card/create','POST',{member_type:planId,from:memberPurchaseChannel(),request_id:key},true),planId);},
 cashier:async(id:string)=>decodeMemberCashier(await scope.request(`order/cashier/${encodeURIComponent(id)}/vip`,'GET',{},true),id),
 pay:async(id:string,method:MemberPayMethod)=>decodeMemberPayment(await scope.request('user/member/card/pay','POST',{uni:id,paytype:method,from:memberPurchaseChannel()},true),id,method),
 products:async(page:number)=>{const r=record(await scope.request('groom/list/5','GET',{page,limit:15},true));return unique(array(r.list,15).map(v=>{const p=record(v);return{id:integer(p.id,1),title:text(p.store_name,512),image:text(p.image,4096),price:money(p.price),vipPrice:money(p.vip_price)};}));},
 };}
export type MemberHomeRequests=ReturnType<typeof createMemberHomeRequests>;
