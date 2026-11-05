/** Fresh external recharge settlement; IDs are user_recharge/user_bill, never goods or membership aliases. */
export interface RechargePaidNoticeBusiness {
 format:1; domain:'recharge'; settlementNonce:string; orderId:number; orderNo:string; userId:number;
 payType:'weixin'|'alipay'; payPrice:string; giftPrice:string; creditedAmount:string; postBalance:string; billId:number;
 payTime:number; creationTime:number; tradeNo:string; phone:string; sendName:string; occurredAt:number;
}
export const RECHARGE_PAID_NOTICE_KEYS=Object.freeze(['format','domain','settlementNonce','orderId','orderNo','userId','payType','payPrice','giftPrice','creditedAmount','postBalance','billId','payTime','creationTime','tradeNo','phone','sendName','occurredAt']);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
export function rechargePaidNoticeObject(v:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v))||Reflect.ownKeys(v).length!==keys.length)throw Error('充值付款通知字段无效');
 return Object.fromEntries(keys.map(key=>{const d=Object.getOwnPropertyDescriptor(v,key);if(!d?.enumerable||!('value'in d))throw Error('充值付款通知字段无效');return[key,d.value];}));
}
const money=(v:unknown):v is string=>typeof v==='string'&&/^(?:0|[1-9]\d{0,9})\.\d{2}$/u.test(v);
function text(v:unknown,max:number,required=false):v is string{if(typeof v!=='string'||v.length>max*2||required&&!v)return false;let n=0;for(const c of v){const p=c.codePointAt(0)!;if(++n>max||p>=0xd800&&p<=0xdfff)return false;}return true;}
export function captureRechargePaidNoticeBusiness(value:unknown):RechargePaidNoticeBusiness{
 const r=rechargePaidNoticeObject(value,RECHARGE_PAID_NOTICE_KEYS);
 if(r.format!==1||r.domain!=='recharge'||typeof r.settlementNonce!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(r.settlementNonce)
 ||!integer(r.orderId)||!integer(r.userId)||!integer(r.billId)||!integer(r.payTime)||!integer(r.creationTime)||!integer(r.occurredAt)||r.creationTime>r.payTime||r.payTime>r.occurredAt
 ||!text(r.orderNo,32,true)||!/^cz[A-Za-z0-9_-]{1,30}$/u.test(r.orderNo)||!text(r.tradeNo,100,true)||r.tradeNo.trim()!==r.tradeNo
 ||!text(r.phone,32)||r.phone.trim()!==r.phone||!text(r.sendName,255)||(typeof r.payType!=='string'||!['weixin','alipay'].includes(r.payType))
 ||!money(r.payPrice)||r.payPrice==='0.00'||!money(r.giftPrice)||!money(r.creditedAmount)||!(typeof r.postBalance==='string'&&/^-?(?:0|[1-9]\d{0,9})\.\d{2}$/u.test(r.postBalance)&&r.postBalance!=='-0.00'))throw Error('充值付款通知事实无效');
 if(BigInt(r.payPrice.replace('.',''))+BigInt(r.giftPrice.replace('.',''))!==BigInt(r.creditedAmount.replace('.','')))throw Error('充值付款通知账本金额无效');
 return r as unknown as RechargePaidNoticeBusiness;
}
export function rechargePaidNoticeEventKey(id:number){if(!integer(id))throw Error('充值付款通知主体无效');return `recharge.pay.success.notice:${id}`;}
export function rechargePaidSettlementKey(id:number){if(!integer(id))throw Error('充值结算主体无效');return `recharge.settled:${id}`;}
export function rechargePaidNoticeSubjectId(v:unknown):number|null{const m=typeof v==='string'?/^recharge\.pay\.success\.notice:([1-9]\d{0,9})$/u.exec(v):null;return m&&integer(Number(m[1]))?Number(m[1]):null;}
export function rechargePaidNoticeBusinessFromPayload(value:unknown){const keys=value&&typeof value==='object'&&Object.hasOwn(value,'routineSubscriptionRequest')?[...RECHARGE_PAID_NOTICE_KEYS,'routineSubscriptionRequest']:RECHARGE_PAID_NOTICE_KEYS;const r=rechargePaidNoticeObject(value,keys);return captureRechargePaidNoticeBusiness(Object.fromEntries(RECHARGE_PAID_NOTICE_KEYS.map(k=>[k,r[k]])));}
