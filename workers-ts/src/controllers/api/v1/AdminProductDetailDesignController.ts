import type { Context } from 'hono';
import type { AppVariables,Env } from '@/env';
import { AdminProductDetailDesignService } from '@/services/admin/AdminProductDetailDesignService';
import { ProductDetailDesignRejected,ProductDetailDesignStaleVersion,readProductDetailDesignBody } from '@/services/admin/AdminProductDetailDesignInput';
import { NotFoundException,ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
const service=(c:C)=>new AdminProductDetailDesignService(c.get('container'));
function privateResponse(c:C){c.header('Cache-Control','private, no-store');if(new URL(c.req.url).searchParams.size)throw new ValidateException('商品详情设计接口不接受查询参数');}
function actor(c:C){const admin=c.get('adminInfo');if(!admin)throw new ValidateException('管理员身份不存在');return {id:admin.id};}
export async function read(c:C){privateResponse(c);return jsonOk(c,await service(c).read());}
export async function receipt(c:C){privateResponse(c);try{return jsonOk(c,await service(c).receipt(c.req.param('operationId'),actor(c)));}catch(error){if(error instanceof NotFoundException)return c.json({status:404,msg:error.message,data:null},404);throw error;}}
export async function save(c:C){privateResponse(c);try{return jsonOk(c,await service(c).save(await readProductDetailDesignBody(c.req.raw),actor(c)),'商品详情设计保存成功');}catch(error){
  if(error instanceof ProductDetailDesignStaleVersion||error instanceof ProductDetailDesignRejected){const status=error instanceof ProductDetailDesignStaleVersion?409:400;
    return c.json({status,msg:error.message,data:{code:status===409?'PRODUCT_DETAIL_DESIGN_STALE_VERSION':'PRODUCT_DETAIL_DESIGN_REJECTED',operation:error.operation,operationId:error.operationId,payloadHash:error.payloadHash}},status);}throw error;}}
