import { orderDetailId } from './orderDetailIdentity';
export const buyerReviewLegacyPath='/pages/goods/goods_comment_con/index';
export function buyerReviewParameters(input:Readonly<Record<string,unknown>>,legacy=false):{orderId:string;unique?:string}{
  const field=legacy?'uni':'orderId',keys=Object.keys(input);
  if(keys.some(k=>k!==field&&k!=='unique')||typeof input[field]!=='string')throw Error('评价链接无效，请重新进入订单');
  const orderId=orderDetailId(input[field]);if(orderId.length>50)throw Error('评价链接无效');
  const unique=input.unique;if(unique!==undefined&&(typeof unique!=='string'||!unique||unique.length>50||/[\x00-\x20\x7f\uD800-\uDFFF]/u.test(unique)))throw Error('评价商品链接无效');
  return {orderId,...(typeof unique==='string'?{unique}:{})};
}
/** Native UniApp does not need browser URL constructors to consume a link. */
export function buyerReviewQuery(raw:string,legacy=false){
  if(raw.length>2048||/%(?![0-9a-f]{2})/iu.test(raw))throw Error('评价链接无效');
  const input:Record<string,string>=Object.create(null),decode=(value:string)=>decodeURIComponent(value.replace(/\+/g,' '));
  for(const part of (raw.startsWith('?')?raw.slice(1):raw).split('&')){
    if(!part)continue;const offset=part.indexOf('='),key=decode(offset<0?part:part.slice(0,offset)),value=decode(offset<0?'':part.slice(offset+1));
    if(Object.prototype.hasOwnProperty.call(input,key))throw Error('评价链接参数重复');input[key]=value;
  }
  return buyerReviewParameters(input,legacy);
}
export function buyerReviewPageRoute(input:Readonly<Record<string,unknown>>,legacy=false){const q=buyerReviewParameters(input,legacy);return '/pages/order/reply?orderId='+encodeURIComponent(q.orderId)+(q.unique?'&unique='+encodeURIComponent(q.unique):'');}
