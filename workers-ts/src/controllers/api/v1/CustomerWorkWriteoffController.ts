import type {Context} from 'hono';
import type {Env,AppVariables} from '@/env';
import {jsonOk} from '@/utils/json';
import {ValidateException} from '@/utils/errors';
import {readBoundedUtf8Text} from '@/utils/request-body';
import {customerWorkActor} from './CustomerWorkController';
import {CustomerWorkWriteoffService} from '@/services/customer-work/CustomerWorkWriteoffService';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function input(c:C){c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');if(Object.values(c.req.queries()).some(values=>values.length!==1))throw new ValidateException('核销查询参数不能重复');return{actor:customerWorkActor(c),query:c.req.query(),service:new CustomerWorkWriteoffService(c.get('container'),c.env)};}
async function body(c:C){if(new URL(c.req.url).search||!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type')??'')||!['','identity'].includes((c.req.header('Content-Encoding')??'').toLowerCase()))throw new ValidateException('核销操作仅接受无查询参数的UTF-8 JSON');const raw=await readBoundedUtf8Text(c.req.raw,262144);try{return JSON.parse(raw) as unknown;}catch{throw new ValidateException('核销操作JSON无效');}}
/** Read-only namespaces never consume or append a mutation request. */
export async function writeoffLookup(c:C){const s=input(c);return jsonOk(c,await s.service.reader.lookup(s.actor,await body(c)));}
export async function writeoffOrder(c:C){const s=input(c);return jsonOk(c,await s.service.reader.order(s.actor,c.req.param('id'),s.query));}
export async function writeoffRecords(c:C){const s=input(c);return jsonOk(c,await s.service.reader.records(s.actor,c.req.param('id'),s.query));}
export async function writeoffExecute(c:C){const s=input(c);return jsonOk(c,await s.service.execute({actor:s.actor,request_key:c.req.header('Idempotency-Key')??''},await body(c)));}
export async function writeoffOperationStatus(c:C){const s=input(c);if(Object.keys(s.query).length)throw new ValidateException('原核销回执不接受查询身份');return jsonOk(c,await s.service.status(s.actor,c.req.param('key')));}
export async function abandonWriteoffOperation(c:C){const s=input(c);return jsonOk(c,await s.service.abandon(s.actor,c.req.param('key'),await body(c),c.req.header('Idempotency-Key')??''));}
