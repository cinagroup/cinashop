import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { normalizeWithdrawalBody } from './UserWithdrawalService';
import { withdrawalMediaId } from './UserWithdrawalApplicationPolicy';
export const withdrawalRequestKey=(value:unknown):string=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{16,96}$/.test(value))throw new ValidateException('请求标识格式错误');return value;};
export function withdrawalView(request:Request,view:string,extra:readonly string[]=[]){
 const q=new URL(request.url).searchParams,allowed=['view',...extra];if([...q.keys()].some(key=>!allowed.includes(key))||allowed.some(key=>q.getAll(key).length!==1)||q.get('view')!==view)throw new ValidateException('提现查询参数无效');return q;
}
export function withdrawalReceiptQuery(request:Request){return withdrawalRequestKey(withdrawalView(request,'withdrawal_receipt',['request_id']).get('request_id'));}
export function withdrawalMediaQuery(request:Request){const reference=withdrawalView(request,'withdrawal_media',['reference']).get('reference')!;withdrawalMediaId(reference);return reference;}
export async function readWithdrawalApplicationInput(request:Request){
 withdrawalView(request,'withdrawal_application');if(!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('content-type')??''))throw new ValidateException('提现申请须为JSON');
 let value:unknown;try{value=parseLevelActivationJson(await readBoundedUtf8Text(request,8192));}catch{throw new ValidateException('提现申请JSON无效、过大或字段重复');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ValidateException('提现申请须为对象');const body=value as Record<string,unknown>;
 const fields=['request_id','extract_type','extract_price','real_name','extract_number','bank_name','bank_address','qrcode_url'];if(Object.keys(body).some(key=>!fields.includes(key)))throw new ValidateException('提现申请包含不支持的字段');
 withdrawalRequestKey(body.request_id);if(typeof body.extract_type!=='string'||!['bank','balance','weixin','alipay'].includes(body.extract_type))throw new ValidateException('提现方式错误');
 if(typeof body.extract_price!=='string'||!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(body.extract_price))throw new ValidateException('提现金额格式错误');
 const limits:Record<string,number>={request_id:96,extract_type:32,extract_price:32,real_name:64,extract_number:64,bank_name:64,bank_address:256,qrcode_url:255};
 for(const name of fields){if(body[name]===undefined&& !['request_id','extract_type','extract_price'].includes(name))body[name]='';const text=body[name];if(typeof text!=='string'||[...text].length>limits[name]||/[\u0000-\u001f\u007f]/u.test(text)||[...text].some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;}))throw new ValidateException('提现申请字段格式或长度错误');}
 return normalizeWithdrawalBody(body,request.headers.get('Idempotency-Key')??undefined);
}
