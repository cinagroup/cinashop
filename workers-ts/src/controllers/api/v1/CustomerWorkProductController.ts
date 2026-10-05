import type {Context} from 'hono';
import type {Env,AppVariables} from '@/env';
import {jsonOk} from '@/utils/json';
import {ValidateException} from '@/utils/errors';
import {readBoundedUtf8Text} from '@/utils/request-body';
import {customerWorkActor} from './CustomerWorkController';
import {CustomerWorkProductReadService,customerProductQuery} from '@/services/customer-work/CustomerWorkProductReadService';
import {CustomerWorkProductOperationService} from '@/services/customer-work/CustomerWorkProductOperationService';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function input(c:C){c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');if(Object.values(c.req.queries()).some(v=>v.length!==1))throw new ValidateException('商品查询参数不能重复');return{actor:customerWorkActor(c),query:c.req.query(),reader:new CustomerWorkProductReadService(c.get('container'),c.env),writer:new CustomerWorkProductOperationService(c.get('container'))};}
async function body(c:C){if(new URL(c.req.url).search||!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type')??'')||!['','identity'].includes((c.req.header('Content-Encoding')??'').toLowerCase()))throw new ValidateException('商品操作仅接受无查询参数的UTF-8 JSON');const raw=await readBoundedUtf8Text(c.req.raw,262144);try{return JSON.parse(raw) as unknown;}catch{throw new ValidateException('商品操作JSON无效');}}
function operation(c:C){return{actor:customerWorkActor(c),request_key:c.req.header('Idempotency-Key')??''};}
export async function productList(c:C){const s=input(c);return jsonOk(c,await s.reader.list(s.actor,s.query));}
export async function productCategories(c:C){const s=input(c);return jsonOk(c,await s.reader.categories(s.actor,s.query));}
export async function productLabels(c:C){const s=input(c);return jsonOk(c,await s.reader.labels(s.actor,s.query));}
export async function productSkus(c:C){const s=input(c);return jsonOk(c,await s.reader.skus(s.actor,c.req.param('id'),s.query));}
export async function setProductShow(c:C){const s=input(c);return jsonOk(c,await s.writer.setShow(operation(c),await body(c)));}
export async function batchProducts(c:C){const s=input(c);return jsonOk(c,await s.writer.batch(operation(c),await body(c)));}
export async function updateProductSkus(c:C){const s=input(c);return jsonOk(c,await s.writer.updateSkus(operation(c),c.req.param('id'),await body(c)));}
export async function productOperationOutcome(c:C){const s=input(c);customerProductQuery(s.query,[]);if(Object.keys(s.query).length)throw new ValidateException('商品回执不接受查询身份');return jsonOk(c,await s.writer.outcome(s.actor,c.req.param('key')));}
export async function abandonProductOperation(c:C){const s=input(c);return jsonOk(c,await s.writer.abandon(s.actor,c.req.param('key')??'',await body(c)));}
