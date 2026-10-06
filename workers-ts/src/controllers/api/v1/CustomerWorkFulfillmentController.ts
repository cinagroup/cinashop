import type { Context } from 'hono';
import type { Env,AppVariables } from '@/env';
import { jsonOk } from '@/utils/json';
import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { customerWorkActor } from './CustomerWorkController';
import { CustomerWorkFulfillmentService } from '@/services/customer-work/CustomerWorkFulfillmentService';
import { CustomerWorkOperationRequest,type CustomerOperationContext,type CustomerOperationKind } from '@/services/customer-work/CustomerWorkOperationRequest';
import { customerWorkId } from '@/services/customer-work/CustomerWorkScope';

type C=Context<{Bindings:Env;Variables:AppVariables}>;
function input(c:C){c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');if(Object.values(c.req.queries()).some(v=>v.length!==1))throw new ValidateException('工作台查询参数不能重复');return{service:new CustomerWorkFulfillmentService(c.get('container'),c.env),actor:customerWorkActor(c),query:c.req.query()};}
async function body(c:C){if(new URL(c.req.url).search||!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type')??'')||!['','identity'].includes((c.req.header('Content-Encoding')??'').toLowerCase()))throw new ValidateException('工作台操作仅接受无查询参数的UTF-8 JSON');const raw=await readBoundedUtf8Text(c.req.raw,262144);try{return JSON.parse(raw) as unknown;}catch{throw new ValidateException('工作台操作JSON无效');}}
function context(c:C):CustomerOperationContext{return{actor:customerWorkActor(c),request_key:c.req.header('Idempotency-Key')??''};}
function path(c:C,value:unknown){const orderId=customerWorkId(c.req.param('id'),'订单');if(!value||Array.isArray(value)||typeof value!=='object'||(value as Record<string,unknown>).order_id!==orderId)throw new ValidateException('路径订单与原操作标识不符');}
export async function fulfillmentBootstrap(c:C){const s=input(c);return jsonOk(c,await s.service.bootstrap(s.actor,c.req.param('id'),s.query));}
export async function remarkTarget(c:C){const s=input(c);return jsonOk(c,await s.service.remarkTarget(s.actor,c.req.param('id'),s.query));}
export async function carriers(c:C){const s=input(c);return jsonOk(c,await s.service.carriers(s.actor,s.query));}
export async function couriers(c:C){const s=input(c);return jsonOk(c,await s.service.couriers(s.actor,s.query));}
export async function defaults(c:C){const s=input(c);return jsonOk(c,await s.service.defaults(s.actor,s.query));}
export async function templates(c:C){const s=input(c);return jsonOk(c,await s.service.templates(s.actor,s.query));}
export async function waybillJobs(c:C){const s=input(c);return jsonOk(c,await s.service.waybillJobs(s.actor,s.query));}
export async function waybillJob(c:C){const s=input(c);return jsonOk(c,await s.service.waybillJob(s.actor,c.req.param('id'),s.query));}
export async function waybillActions(c:C){const s=input(c);return jsonOk(c,await s.service.waybillActions(s.actor,c.req.param('id'),s.query));}
export async function waybillDecision(c:C){const s=input(c);return jsonOk(c,await s.service.waybillDecision(context(c),c.req.param('id'),await body(c)));}
export async function deliver(c:C){const s=input(c),value=await body(c);path(c,value);return jsonOk(c,await s.service.delivery(context(c),value));}
export async function splitDeliver(c:C){const s=input(c),value=await body(c);path(c,value);return jsonOk(c,await s.service.delivery(context(c),value,true));}
export async function saveRemark(c:C){const s=input(c),value=await body(c);path(c,value);return jsonOk(c,await s.service.saveRemark(context(c),value));}
export async function operationOutcome(c:C){const s=input(c);if(Object.keys(s.query).length)throw new ValidateException('操作回执不接受查询身份');return jsonOk(c,await s.service.operationOutcome(s.actor,c.req.param('key')));}
export async function cityJobOutcome(c:C){const s=input(c);if(Object.keys(s.query).length)throw new ValidateException('同城结果不接受查询身份');return jsonOk(c,await s.service.cityJobOutcome(s.actor,c.req.param('id')));}
export async function cityJobRecover(c:C){const s=input(c);return jsonOk(c,await s.service.cityJobRecover(s.actor,c.req.param('id'),await body(c)));}
export async function abandonOperation(c:C){input(c);const value=await body(c);if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).sort().join(',')!=='input,kind')throw new ValidateException('放弃操作合同无效');const record=value as Record<string,unknown>;return jsonOk(c,{receipt:await new CustomerWorkOperationRequest(c.get('container')).abandon(record.kind as CustomerOperationKind,{actor:customerWorkActor(c),request_key:c.req.param('key')??''},record.input)});}
