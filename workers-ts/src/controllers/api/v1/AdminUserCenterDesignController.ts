import type { Context } from 'hono';
import type { AppVariables,Env } from '@/env';
import { AdminUserCenterDesignService } from '@/services/admin/AdminUserCenterDesignService';
import { AdminUserCenterCatalogService } from '@/services/admin/AdminUserCenterCatalogService';
import { UserCenterDesignRejected,UserCenterDesignStaleVersion,readUserCenterDesignBody } from '@/services/admin/AdminUserCenterDesignInput';
import { NotFoundException,ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
const service=(c:C)=>new AdminUserCenterDesignService(c.get('container'),c.env);
function privateResponse(c:C,query=false){c.header('Cache-Control','private, no-store');if(!query&&new URL(c.req.url).searchParams.size)throw new ValidateException('个人中心设计接口不接受查询参数');}
function actor(c:C){const admin=c.get('adminInfo');if(!admin)throw new ValidateException('管理员身份不存在');return{id:admin.id};}
export async function read(c:C){privateResponse(c);return jsonOk(c,await service(c).read());}
export async function receipt(c:C){privateResponse(c);try{return jsonOk(c,await service(c).receipt(c.req.param('operationId'),actor(c)));}catch(error){if(error instanceof NotFoundException)return c.json({status:404,msg:error.message,data:null},404);throw error;}}
export async function save(c:C){privateResponse(c);try{return jsonOk(c,await service(c).save(await readUserCenterDesignBody(c.req.raw),actor(c)),'个人中心设计保存成功');}catch(error){if(error instanceof UserCenterDesignStaleVersion||error instanceof UserCenterDesignRejected){const status=error instanceof UserCenterDesignStaleVersion?409:400;return c.json({status,msg:error.message,data:{code:status===409?'USER_CENTER_DESIGN_STALE_VERSION':'USER_CENTER_DESIGN_REJECTED',operation:error.operation,operationId:error.operationId,payloadHash:error.payloadHash}},status);}throw error;}}
export async function assets(c:C){privateResponse(c,true);return jsonOk(c,await new AdminUserCenterCatalogService(c.get('container'),c.env).assets(new URL(c.req.url).searchParams));}
export async function categories(c:C){privateResponse(c,true);return jsonOk(c,await new AdminUserCenterCatalogService(c.get('container'),c.env).categories(new URL(c.req.url).searchParams));}
export async function targets(c:C){privateResponse(c,true);return jsonOk(c,await new AdminUserCenterCatalogService(c.get('container'),c.env).targets(new URL(c.req.url).searchParams));}
