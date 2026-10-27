import { ValidateException } from '@/utils/errors';
export const MEMBERSHIP_COUPON_BODY_BYTES=4096;
export function membershipCouponId(value:unknown):number{
 const id=typeof value==='number'?value:typeof value==='string'&&/^[1-9]\d*$/u.test(value)?Number(value):NaN;
 if(!Number.isSafeInteger(id)||id<1||id>2147483647)throw new ValidateException('会员优惠券编号无效');return id;
}
export function membershipCouponQuery(query:URLSearchParams):{kind:'view';page:number;limit:number}|{kind:'claim';issueId:number}|null{
 if(!query.has('view')&&!query.has('claim'))return null;
 if(query.has('claim')){if(query.size!==1||query.getAll('claim').length!==1)throw new ValidateException('领取状态查询参数未知或重复');return{kind:'claim',issueId:membershipCouponId(query.get('claim'))};}
 for(const key of query.keys())if(!['view','page','limit'].includes(key)||query.getAll(key).length!==1)throw new ValidateException('会员券列表参数未知或重复');
 if(query.get('view')!=='1')throw new ValidateException('会员券列表版本无效');
 const page=membershipCouponId(query.get('page')??'1'),limit=membershipCouponId(query.get('limit')??'15');
 if(limit>50||(page-1)*limit>10000)throw new ValidateException('会员券分页超出范围');return{kind:'view',page,limit};
}
/** Only an explicit decoded member key opts into the two-key modern body.
 * Historical bodies retain JSON.parse semantics and existing alias validation. */
export async function readMembershipCouponBody(request:Request):Promise<unknown>{
 const bytes=new Uint8Array(await request.arrayBuffer());let value:unknown;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{return null;}
 if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'member'))return value;
 if(bytes.byteLength>MEMBERSHIP_COUPON_BODY_BYTES)throw new ValidateException('会员券领取请求不能超过4 KiB');
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes);}catch{throw new ValidateException('会员券领取请求不是有效UTF-8');}
 const keys=new Set<string>();let offset=0;const whitespace=()=>{while(offset<text.length&&/\s/u.test(text[offset]!))offset++;};
 const string=()=>{const start=offset++;while(offset<text.length){const char=text[offset++];if(char==='\\')offset++;else if(char==='"')break;}return JSON.parse(text.slice(start,offset)) as string;};
 whitespace();offset++;whitespace();while(text[offset]!=='}'){
  const key=string();if(keys.has(key))throw new ValidateException('会员券领取字段不能重复');keys.add(key);whitespace();offset++;whitespace();
  if(text[offset]==='"')string();else{if(text[offset]==='{'||text[offset]==='[')throw new ValidateException('会员券领取字段须为标量');while(offset<text.length&&!/[,}]/u.test(text[offset]!))offset++;}
  whitespace();if(text[offset]!==',')break;offset++;whitespace();
 }
 const input=value as Record<string,unknown>;
 if(keys.size!==2||!keys.has('couponId')||!keys.has('member')||input.member!==1||typeof input.couponId!=='number')throw new ValidateException('会员券领取字段未知、不完整或无效');membershipCouponId(input.couponId);return input;
}
