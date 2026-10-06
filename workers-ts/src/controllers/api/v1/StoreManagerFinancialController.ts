import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { StoreManagerFinancialService } from '@/services/store/StoreManagerFinancialService';
import { MANAGER_OPERATION_VERSION, type ManagerOperationKind } from '@/services/store/ManagerOrderOperationRequest';
import { managerOperationActor, managerOperationContext } from './StoreManagerOrderOperationController';
import { normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { jsonOk } from '@/utils/json';
import { ValidateException } from '@/utils/errors';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function service(c:C){c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');return new StoreManagerFinancialService(c.get('container'),c.env);}
async function body(c:C,max=262144):Promise<unknown>{if(new URL(c.req.url).search||!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type')??'')||!['','identity'].includes((c.req.header('Content-Encoding')??'').toLowerCase()))throw new ValidateException('管理财务仅接受无查询参数的UTF-8 JSON');const raw=await readBoundedUtf8Text(c.req.raw,max);try{return JSON.parse(raw);}catch{throw new ValidateException('管理财务JSON无效');}}
const result=(c:C,value:unknown)=>jsonOk(c,{version:MANAGER_OPERATION_VERSION,...value as Record<string,unknown>});
export async function price(c:C){const ctx=managerOperationContext(c);return result(c,await service(c).price(ctx,await body(c)));}
export async function offline(c:C){const ctx=managerOperationContext(c);return result(c,await service(c).offline(ctx,await body(c)));}
export async function quote(c:C){const actor=managerOperationActor(c);return jsonOk(c,await service(c).quote(actor,await body(c)));}
export async function create(c:C){const ctx=managerOperationContext(c);return result(c,await service(c).create(ctx,await body(c)));}
export async function review(c:C){const actor=managerOperationActor(c);return jsonOk(c,await service(c).review(actor,await body(c)));}
export async function execute(c:C){const ctx=managerOperationContext(c);return result(c,await service(c).execute(ctx,await body(c)));}
export async function receipt(c:C){const actor=managerOperationActor(c),key=normalizeOutRequestKey(c.req.header('Idempotency-Key')),value=await body(c,512);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||(value as Record<string,unknown>).version!==MANAGER_OPERATION_VERSION)throw new ValidateException('管理回执读取协议无效');return result(c,{receipt:await service(c).receipt(actor,key)});}
export async function abandon(c:C){const ctx=managerOperationContext(c),value=await body(c);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='input,kind')throw new ValidateException('原管理操作解除协议无效');const row=value as {kind:ManagerOperationKind;input:unknown};return result(c,{receipt:await service(c).abandon(ctx,row.input,row.kind)});}

/** Read-only original-owner status; role withdrawal never exposes order PII. */
export async function receiptStatus(c:C){if(new URL(c.req.url).search||c.req.header('Transfer-Encoding')||!['','0'].includes(c.req.header('Content-Length')??''))throw new ValidateException('原请求状态读取不接受查询或正文');const actor=managerOperationActor(c),key=normalizeOutRequestKey(c.req.param('requestKey'));return result(c,await service(c).executionStatus(actor,key));}
