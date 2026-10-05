import type {Context} from 'hono';
import type {Env,AppVariables} from '@/env';
import {jsonOk} from '@/utils/json';
import {ValidateException} from '@/utils/errors';
import {readBoundedUtf8Text} from '@/utils/request-body';
import {customerWorkActor} from './CustomerWorkController';
import {CustomerWorkFinancialService} from '@/services/customer-work/CustomerWorkFinancialService';
import type {FinancialKind} from '@/services/customer-work/CustomerWorkFinancialProtocol';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function input(c:C){c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');if(Object.values(c.req.queries()).some(x=>x.length!==1))throw new ValidateException('财务查询参数不能重复');return{actor:customerWorkActor(c),query:c.req.query(),service:new CustomerWorkFinancialService(c.get('container'),c.env)};}
async function body(c:C){if(new URL(c.req.url).search||!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type')??'')||!['','identity'].includes((c.req.header('Content-Encoding')??'').toLowerCase()))throw new ValidateException('财务操作仅接受无查询参数的UTF-8 JSON');const raw=await readBoundedUtf8Text(c.req.raw,262144);try{return JSON.parse(raw) as unknown;}catch{throw new ValidateException('财务操作JSON无效');}}
async function write(c:C,kind:FinancialKind){const s=input(c),context={actor:s.actor,request_key:c.req.header('Idempotency-Key')??''},value=await body(c);const result=kind==='change_price'?await s.service.price(context,value):kind==='confirm_offline'?await s.service.offline(context,value):kind==='refund_create'?await s.service.create(context,value):kind==='refund_remark'?await s.service.remark(context,value):await s.service.execute(kind,context,value);return jsonOk(c,result);}
export async function financialOrder(c:C){const s=input(c);return jsonOk(c,await s.service.reader.order(s.actor,c.req.param('id'),s.query));}
export async function financialRefundReview(c:C){const s=input(c);return jsonOk(c,await s.service.reader.review(s.actor,c.req.param('id'),s.query));}
/** Read quote does not consume an Idempotency-Key or admit any mutation. */
export async function financialRefundQuote(c:C){const s=input(c);return jsonOk(c,await s.service.reader.quote(s.actor,await body(c)));}
export async function changePrice(c:C){return write(c,'change_price');}
export async function confirmOffline(c:C){return write(c,'confirm_offline');}
export async function refundCreate(c:C){return write(c,'refund_create');}
export async function refundReturn(c:C){return write(c,'refund_return');}
export async function refundRefuse(c:C){return write(c,'refund_refuse');}
/** The original endpoint, complete original intent and original UUID are also
 * the explicit provider query/recovery command. GET never dispatches. */
export async function refundExecute(c:C){return write(c,'refund_execute');}
export async function refundRemark(c:C){return write(c,'refund_remark');}
export async function financialOperationStatus(c:C){const s=input(c);if(Object.keys(s.query).length)throw new ValidateException('原财务回执不接受查询身份');return jsonOk(c,await s.service.status(s.actor,c.req.param('key')));}
export async function abandonFinancialOperation(c:C){const s=input(c);return jsonOk(c,await s.service.abandon(s.actor,c.req.param('key'),await body(c),c.req.header('Idempotency-Key')??''));}
