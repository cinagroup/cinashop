import { ValidateException } from '@/utils/errors';

export const PRODUCT_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;
const validId = (value:number) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
async function signature(message:string,secret:string) {
  if (!secret) throw new ValidateException('商品分享签名未配置');
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('ordinary-product-share:'+message)));
  return Array.from(bytes.slice(0,12),byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** Provider scenes are authenticated capabilities, not arbitrary client URLs. */
export async function createProductShareScene(id:number,uid:number,secret:string,now=Math.floor(Date.now()/1000)) {
  if(!validId(id)||!validId(uid)||!Number.isSafeInteger(now)||now<0)throw new ValidateException('商品分享参数无效');
  const message=`p:${id}:${uid}:${now+PRODUCT_SHARE_TTL_SECONDS}`;
  const scene=`${message}:${await signature(message,secret)}`;
  if(new TextEncoder().encode(scene).byteLength>64)throw new ValidateException('商品分享场景过长');
  return scene;
}
export async function verifyProductShareScene(scene:string,secret:string,now=Math.floor(Date.now()/1000)) {
  const match=/^p:([1-9]\d{0,9}):([1-9]\d{0,9}):(\d{1,10}):([a-f\d]{24})$/.exec(scene);
  if(!match||!secret||!Number.isSafeInteger(now))return null;
  const id=Number(match[1]),uid=Number(match[2]),expires=Number(match[3]);
  if(!validId(id)||!validId(uid)||expires<=now||expires>now+PRODUCT_SHARE_TTL_SECONDS)return null;
  const expected=await signature(`p:${id}:${uid}:${expires}`,secret);
  let difference=0;for(let i=0;i<expected.length;i++)difference|=expected.charCodeAt(i)^match[4].charCodeAt(i);
  return difference===0?{id,uid,expires}:null;
}
