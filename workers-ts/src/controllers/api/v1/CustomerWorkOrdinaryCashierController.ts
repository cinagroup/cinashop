import type { Context } from 'hono';
import type { Env, AppVariables } from '@/env';
import { jsonOk } from '@/utils/json';
import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { ordinaryCashierObject, ordinaryCashierInteger } from '@/services/customer-work/CustomerOrdinaryCashierContract';
import { CustomerWorkOrdinaryCashierService } from '@/services/customer-work/CustomerWorkOrdinaryCashierService';
import { CustomerWorkOrdinaryCashierReadService } from '@/services/customer-work/CustomerWorkOrdinaryCashierReadService';
import { customerWorkActor } from './CustomerWorkController';
import { normalizeOutRequestKey } from '@/services/out/OutIdempotency';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function input(c:C,read=false) {
  c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');
  if(read){if(Object.values(c.req.queries()).some(values=>values.length!==1))throw new ValidateException('普通收银查询参数不能重复');}
  else if(new URL(c.req.url).search)throw new ValidateException('普通收银写入不接受查询身份或内容');
  return{actor:customerWorkActor(c),service:new CustomerWorkOrdinaryCashierService(c.get('container'),c.env)};
}
async function body(c:C) {
  if(!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type')??'')
    ||!['','identity'].includes((c.req.header('Content-Encoding')??'').toLowerCase()))throw new ValidateException('普通收银仅接受UTF-8 JSON');
  const raw=await readBoundedUtf8Text(c.req.raw,262144);try{return JSON.parse(raw) as unknown;}catch{throw new ValidateException('普通收银JSON无效');}
}
function key(c:C){return c.req.header('Idempotency-Key')??'';}
function draftPath(c:C,value:unknown){if(!value||typeof value!=='object'||Array.isArray(value)||(value as Record<string,unknown>).draft_key!==c.req.param('key'))throw new ValidateException('购物车正文必须绑定原路径编号');return value;}
function readQuery(c:C,keys:readonly string[]) {
  const q=c.req.query();if(Object.keys(q).some(k=>!keys.includes(k))||q.scope_key!==undefined&&!/^[a-f0-9]{64}$/.test(q.scope_key))throw new ValidateException('普通收银读取参数无效');return q;
}
export async function draft(c:C){const s=input(c);return jsonOk(c,await s.service.draft(s.actor,key(c),await body(c)));}
export async function draftRead(c:C){const s=input(c,true),q=readQuery(c,['scope_key']);return jsonOk(c,await s.service.readDraft(s.actor,c.req.param('key'),q.scope_key));}
export async function quantity(c:C){const s=input(c);return jsonOk(c,await s.service.quantity(s.actor,key(c),draftPath(c,await body(c))));}
export async function remove(c:C){const s=input(c);return jsonOk(c,await s.service.remove(s.actor,key(c),draftPath(c,await body(c))));}
export async function rows(c:C){const s=input(c);return jsonOk(c,await s.service.rows(s.actor,key(c),draftPath(c,await body(c))));}
export async function quote(c:C){const s=input(c),r=ordinaryCashierObject(await body(c),['request_key','intent']);return jsonOk(c,await s.service.quote(s.actor,r.request_key,r.intent));}
export async function create(c:C){const s=input(c),r=ordinaryCashierObject(await body(c),['intent','quote_token']);return jsonOk(c,await s.service.create(s.actor,key(c),r.intent,r.quote_token));}
export async function cash(c:C){const s=input(c),r=ordinaryCashierObject(await body(c),['version','scope_key','order_id','order_no','expected_amount']);
  if(String(r.order_id)!==c.req.param('id'))throw new ValidateException('现金付款必须绑定原物理订单');return jsonOk(c,await s.service.cash(s.actor,key(c),r));}
export async function operation(c:C){const s=input(c,true);readQuery(c,[]);return jsonOk(c,await s.service.operation(s.actor,c.req.param('key')));}
export async function abandon(c:C){const s=input(c);if(normalizeOutRequestKey(key(c))!==c.req.param('key'))throw new ValidateException('永久终止必须使用原路径及原操作编号');
  return jsonOk(c,await s.service.abandon(s.actor,key(c),await body(c)));}
export async function readiness(c:C){const s=input(c,true),q=readQuery(c,['scope_key']);return jsonOk(c,await s.service.readiness(s.actor,q.scope_key));}
function reader(c:C){const s=input(c,true);return{...s,query:c.req.query(),reader:new CustomerWorkOrdinaryCashierReadService(c.get('container'),c.env)};}
export async function catalog(c:C){const s=reader(c);return jsonOk(c,await s.reader.catalog(s.actor,s.query));}
export async function selection(c:C){const s=reader(c);return jsonOk(c,await s.reader.selection(s.actor,c.req.param('id'),s.query));}
export async function users(c:C){const s=reader(c);return jsonOk(c,await s.reader.users(s.actor,s.query));}
export async function addresses(c:C){const s=reader(c);return jsonOk(c,await s.reader.addresses(s.actor,c.req.param('uid'),s.query));}
export async function coupons(c:C){const s=input(c,true),q=readQuery(c,['request_key','scope_key','limit','before']);
  if(!q.request_key||!q.scope_key)throw new ValidateException('优惠券读取必须绑定原报价与经营身份');
  const number=(v:string|undefined,f:number,zero=false)=>v===undefined?f:/^(0|[1-9]\d*)$/.test(v)?ordinaryCashierInteger(Number(v),zero):NaN;
  return jsonOk(c,await s.service.coupons(s.actor,q.request_key,c.req.param('token'),q.scope_key,number(q.limit,20),number(q.before,0,true)));}
