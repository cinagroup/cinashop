import type { Context } from 'hono';
import type { Env, AppVariables } from '@/env';
import { authMiddleware } from '@/middleware/auth';
import { ProductCouponDirectoryService, productCouponId, productCouponPage } from '@/services/product/ProductCouponDirectoryService';
import { ValidateException } from '@/utils/errors';
import { jsonOk, jsonFail } from '@/utils/json';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function service(c:C){const uid=c.get('uid')??0,actor=uid?{uid,authVersion:c.get('socketAuthVersion')??'',expiresAt:c.get('socketTokenExp')??0}:undefined;
  return new ProductCouponDirectoryService(c.get('container'),actor,async()=>{if(actor){await authMiddleware({force:true})(c,async()=>{});if(c.get('uid')!==actor.uid||c.get('socketAuthVersion')!==actor.authVersion||c.get('socketTokenExp')!==actor.expiresAt)throw new ValidateException('登录状态已变化');}});}
async function response(c:C,work:()=>Promise<unknown>){c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');c.header('Referrer-Policy','no-referrer');
  try{if(new URL(c.req.url).pathname.includes('%'))throw new ValidateException('商品优惠券参数无效');return jsonOk(c,await work());}catch(e){if(e instanceof ValidateException)return jsonFail(c,e.message);throw e;}}
export const directory=(c:C)=>response(c,()=>{const {page,limit}=productCouponPage(c.req.url);return service(c).directory(productCouponId(c.req.param('productId')),page,limit);});
export const receipt=(c:C)=>response(c,()=>{if(new URL(c.req.url).search)throw new ValidateException('领取状态不接受查询参数');return service(c).receipt(productCouponId(c.req.param('productId')),productCouponId(c.req.param('couponId')));});
/** Legacy PC list had an array payload and a product_id query. */
export const legacyProductList=(c:C)=>response(c,async()=>{const {page,limit}=productCouponPage(c.req.url,true),id=productCouponId(new URL(c.req.url).searchParams.get('product_id')??undefined),result=await service(c).directory(id,page,limit);
  return result.items.map(row=>({id:row.id,coupon_title:row.title,type:row.scopeType,coupon_type:row.benefitType,coupon_price:Number(row.benefitValue),use_min_price:Number(row.minimum),coupon_time:row.validity.days,
    start_time:row.validity.startTime?new Date((row.validity.startTime+28800)*1000).toISOString().slice(0,10).replaceAll('-','/'):'',end_time:row.validity.endTime?new Date((row.validity.endTime+28800)*1000).toISOString().slice(0,10).replaceAll('-','/'):'',is_use:row.receivedCount>0,receive_type:row.isMember?4:1}));});
