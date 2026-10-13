import type { Context } from 'hono';
import type { AppVariables,Env } from '@/env';
import { ErpConnectionService } from '@/services/erp/ErpConnectionService';
import { ErpService } from '@/services/erp/ErpService';
import type { AdminAuthorityActor } from '@/services/admin/AdminAuthorityWriteService';
import { erpId,erpReadJson } from '@/services/erp/ErpInput';
import { erpOrderedQuery,type ErpCallbackKind } from '@/services/erp/ErpProtocol';
import { BadRequestException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C=Context<{Bindings:Env;Variables:AppVariables}>;
function privateHeaders(c:C){c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');c.header('Referrer-Policy','no-referrer');}
function actor(c:C):AdminAuthorityActor{return {id:c.get('adminId')??0,authVersion:c.get('socketAuthVersion')??'',expiresAt:c.get('socketTokenExp')??0};}
function connections(c:C){privateHeaders(c);return new ErpConnectionService(c.get('container'),c.env);}
function query(c:C,keys:readonly string[]){const entries=erpOrderedQuery(c.req.url);if(entries.some(([key])=>!keys.includes(key)))throw new BadRequestException('ERP 查询包含未知字段');return new Map(entries);}
function noQuery(c:C){query(c,[]);}
function method(c:C,allowed:string){privateHeaders(c);if(c.req.method!==allowed)return c.json({status:405,msg:'ERP 方法不支持'},405);return null;}
function routeId(c:C){return erpId(c.req.param('id')??'');}
export async function erpConnections(c:C){const rejection=method(c,'GET');if(rejection)return rejection;noQuery(c);return jsonOk(c,await connections(c).list(actor(c)));}
export async function erpConnectionCreate(c:C){const rejection=method(c,'POST');if(rejection)return rejection;noQuery(c);return jsonOk(c,await connections(c).create(actor(c),await erpReadJson(c.req.raw)));}
async function change(c:C,operation:'disable'|'revoke'|'rotate'){const rejection=method(c,'POST');if(rejection)return rejection;noQuery(c);return jsonOk(c,await connections(c).change(actor(c),routeId(c),operation,await erpReadJson(c.req.raw)));}
export const erpConnectionDisable=(c:C)=>change(c,'disable');
export const erpConnectionRevoke=(c:C)=>change(c,'revoke');
export const erpConnectionRotate=(c:C)=>change(c,'rotate');
export async function erpConnectionBind(c:C){const rejection=method(c,'PUT');if(rejection)return rejection;noQuery(c);return jsonOk(c,await connections(c).bind(actor(c),routeId(c),await erpReadJson(c.req.raw)));}
export async function erpConnectionAuth(c:C){const rejection=method(c,'POST');if(rejection)return rejection;noQuery(c);await erpReadJson(c.req.raw);return jsonOk(c,await connections(c).auth(actor(c),routeId(c)));}
export async function erpAuth(c:C){const rejection=method(c,'GET');if(rejection)return rejection;const params=query(c,['connection']);
  const result=await connections(c).auth(actor(c),erpId(params.get('connection')));return jsonOk(c,{'0':result['0'],jump_url:result.jump_url});}
export async function erpAuthCallback(c:C){const rejection=method(c,'GET');if(rejection)return rejection;
  const params=new Map(erpOrderedQuery(c.req.url));if(!params.get('app_key')||!params.get('code')||!params.get('sign')||!params.get('state'))return c.json({code:504},400);
  await connections(c).authCallback(c.req.url);return c.json({code:0});}
export async function erpAccessToken(c:C){const rejection=method(c,'GET');if(rejection)return rejection;const params=query(c,['connection']);
  // PHP success(string) places the actual token in msg and omits data. This
  // separately privileged route must be excluded from response/body logging.
  return c.json({status:200,msg:await connections(c).accessToken(actor(c),erpId(params.get('connection')))});}
export async function erpProductSync(c:C){const rejection=method(c,'GET');if(rejection)return rejection;query(c,['connection','spu_str','request_id']);
  // The old queue dispatch was commented out. No synthetic queue success.
  return c.json({status:503,msg:'ERP 商品导入尚未执行'},503);}
async function callback(c:C,kind:ErpCallbackKind){const rejection=method(c,'POST');if(rejection)return rejection;
  const result=await new ErpService(c.get('container'),c.env).callback(kind,c.req.raw);
  if(!result.completed)return c.json({code:503,msg:'ERP 操作尚未执行或仍待核对',operation:result.receipt},503);
  return kind==='stock'?c.json({code:'0',msg:'执行成功'}):c.json({status:200,msg:'ok'});}
export const erpStockCallback=(c:C)=>callback(c,'stock');
export const erpDeliverCallback=(c:C)=>callback(c,'deliver');
export const erpCancelCallback=(c:C)=>callback(c,'cancel');
export const erpRefundReceiveCallback=(c:C)=>callback(c,'refund-receive');
// Operations/reconciliation endpoints are added with the actual SQL reader and
// exact mature execution adapter, never by an always-success placeholder.
