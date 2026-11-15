import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { authMiddleware } from '@/middleware/auth';
import { BuyerReviewService } from '@/services/order/BuyerReviewService';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';
import { jsonFail, jsonOk } from '@/utils/json';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
const invalid=()=>new ValidateException('评价参数无效，请重新读取');
function service(c:C) {
  const actor={uid:c.get('uid')??0,authVersion:c.get('socketAuthVersion')??'',expiresAt:c.get('socketTokenExp')??0};
  const authorize=async()=>{await authMiddleware({force:true})(c,async()=>{});
    if(c.get('uid')!==actor.uid||c.get('socketAuthVersion')!==actor.authVersion||c.get('socketTokenExp')!==actor.expiresAt)throw invalid();};
  return new BuyerReviewService(c.get('container'),c.env,actor,authorize);
}
async function response(c:C,run:()=>Promise<unknown>) {
  c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');c.header('Referrer-Policy','no-referrer');
  try{return jsonOk(c,await run());}catch(e){
    if(e instanceof ValidateException)return jsonFail(c,e.message);
    if(e instanceof Error&&['评价资料与当前账号或订单不一致，请重新读取','订单链接无效，请返回订单列表'].includes(e.message))return jsonFail(c,e.message);
    throw e;
  }
}
export async function buyerReviewOrder(c:C){return response(c,async()=>{
  if([...new URL(c.req.url).searchParams.keys()].length)throw invalid();
  return service(c).order(c.req.param('uni')??'');
});}
/** Explicit versioned authoring view; existing PHP response/aliases remain intact. */
export function buyerReviewSubmit(legacy:(c:C)=>Promise<Response>):(c:C)=>Promise<Response>{return c=>{
  const query=new URL(c.req.url).searchParams;if(!query.has('view'))return legacy(c);
  return response(c,async()=>{if(query.get('view')!=='buyer'||query.getAll('view').length!==1||[...query.keys()].some(k=>k!=='view'))throw invalid();
    let body:unknown;try{body=JSON.parse(await readBoundedUtf8Text(c.req.raw,8192));}catch(e){if(e instanceof ValidateException)throw e;throw invalid();}
    return service(c).submit(body);
  });
};}
