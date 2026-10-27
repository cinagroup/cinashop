import { otherOrder } from '@/models/schema';
import { ApiException, ValidateException } from '@/utils/errors';

export const MEMBERSHIP_PURCHASE_BODY_BYTES = 4096;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export type MembershipPurchaseOrder = { id:number; order_id:string; member_type:number; pay_price:string; paid:boolean; overdue_time:number };
export type MembershipPurchaseReceipt = { owner_uid:number; request_id:string; state:'unknown'|'committed'; order:MembershipPurchaseOrder|null };
export type MembershipOrderRow = typeof otherOrder.$inferSelect;

export function membershipPurchaseRequestId(value:unknown):string {
  if(typeof value!=='string'||!UUID_V4.test(value))throw new ValidateException('购买请求标识须为小写UUIDv4');
  return value;
}
export const membershipPurchaseConflict=()=>new ApiException('该购买请求与原订单不一致，请重新读取原请求',409);

/** The UUID is a public idempotence identifier, never an authorization token.
 * JWT owner checks and persisted order.uid/type enforce authority. A stable,
 * domain-separated SHA mapping survives JWT/APP_KEY rotation without a schema
 * addition or allocating the global order sequence. Thirty base64url characters
 * retain 180 digest bits while hy+suffix fits the existing varchar(32). */
export async function membershipPurchaseOrderId(uid:number,requestId:string):Promise<string>{
  if(!Number.isSafeInteger(uid)||uid<=0)throw new ValidateException('用户ID无效');
  membershipPurchaseRequestId(requestId);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`membership-purchase:v1\n${uid}\n${requestId}`));
  return 'hy'+btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'').slice(0,30);
}

/** A malformed, deleted, duplicated or wrong-domain persisted row is a conflict,
 * never evidence that this UUID is unused. No current plan price is consulted. */
export function membershipPurchaseOrder(row:MembershipOrderRow,uid:number):MembershipPurchaseOrder{
  const plan=/^[1-9]\d{0,9}$/.test(row.memberType)?Number(row.memberType):0;
  const price=typeof row.payPrice==='string'&&/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(row.payPrice)?Number(row.payPrice):NaN;
  // Keep the predicate explicit: type=0 is free, type=1 is priced membership.
  if(row.uid!==uid||row.isDel!==0||!Number.isSafeInteger(row.id)||row.id<=0||!Number.isSafeInteger(plan)||plan<1||plan>2147483647
    ||![0,1].includes(row.type)||![0,1].includes(row.paid)||![0,1].includes(row.isFree)||![0,1].includes(row.isPermanent)
    ||!Number.isFinite(price)||(row.type===0&&(row.isFree!==1||row.paid!==1||price!==0))||(row.type===1&&(row.isFree!==0||price<=0))
    ||!['wechat','weixinh5','routine','h5'].includes(row.channelType)||!Number.isSafeInteger(row.overdueTime)
    ||(row.isPermanent===1?row.overdueTime!==-1:row.overdueTime<=0||!Number.isSafeInteger(row.vipDay)||row.vipDay<=0))throw membershipPurchaseConflict();
  return{id:row.id,order_id:row.orderId,member_type:plan,pay_price:price.toFixed(2),paid:row.paid===1,overdue_time:row.overdueTime};
}

/** Legacy bodies retain their original JSON.parse/object-coercion behavior.
 * Only an explicit decoded request_id opts into the strict three-key contract.
 * The modern byte cap is validated against the exact original UTF-8 bytes. */
export async function readMembershipCreateBody(request:Request):Promise<Record<string,unknown>>{
  const bytes=new Uint8Array(await request.arrayBuffer());
  let value:unknown;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{return{};}
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'request_id'))return (value??{}) as Record<string,unknown>;
  if(bytes.byteLength>MEMBERSHIP_PURCHASE_BODY_BYTES)throw new ValidateException('购买请求不能超过4 KiB');
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes);}catch{throw new ValidateException('购买请求不是有效UTF-8');}
  const input=value as Record<string,unknown>;
  // Only scalar values are legal. A token walk retains duplicate decoded keys,
  // including escaped aliases that JSON.parse would otherwise silently discard.
  const keys=new Set<string>();let offset=0;
  const whitespace=()=>{while(offset<text.length&&/\s/u.test(text[offset]!))offset++;};
  const string=()=>{const start=offset++;while(offset<text.length){const char=text[offset++];if(char==='\\')offset++;else if(char==='"')break;}return JSON.parse(text.slice(start,offset)) as string;};
  whitespace();offset++;whitespace();
  while(text[offset]!=='}'){
    const key=string();if(keys.has(key))throw new ValidateException('购买请求字段不能重复');keys.add(key);whitespace();offset++;whitespace();
    if(text[offset]==='"')string();else{if(text[offset]==='{'||text[offset]==='[')throw new ValidateException('购买请求字段须为标量');while(offset<text.length&&!/[,}]/u.test(text[offset]!))offset++;}
    whitespace();if(text[offset]!==',')break;offset++;whitespace();
  }
  if(keys.size!==3||[...keys].some(key=>!['member_type','from','request_id'].includes(key)))throw new ValidateException('购买请求字段不完整或包含未知字段');
  membershipPurchaseRequestId(input.request_id);
  if(typeof input.member_type!=='number'||!Number.isSafeInteger(input.member_type)||input.member_type<1||input.member_type>2147483647)throw new ValidateException('请选择会员套餐');
  if(typeof input.from!=='string'||!['weixin','wechat','weixinh5','routine','h5'].includes(input.from))throw new ValidateException('非法渠道');
  return input;
}
