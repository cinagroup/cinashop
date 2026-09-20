import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AuthException, HttpApiException, ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { jsonOk } from '@/utils/json';
import { quoteAdminRefundCreation } from '@/services/admin/AdminRefundCreationQuoteService';

export async function adminRefundCreationQuote(c:Context<{Bindings:Env;Variables:AppVariables}>) {
  const id=c.get('adminId');
  if(!id || id!==c.get('adminInfo')?.id || id!==c.get('socketAuthId'))throw new AuthException('请重新登录');
  if(c.req.header('X-Refund-Operation-Scope')!==`v1:admin:${id}`)throw new HttpApiException('退款报价身份已变化或缺失',412,412);
  if(new URL(c.req.url).search || c.req.header('Idempotency-Key')!==undefined)throw new ValidateException('报价不接受查询参数或资金操作键');
  if(!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type')??'')
    || !['','identity'].includes((c.req.header('Content-Encoding')??'').toLowerCase()))throw new ValidateException('退款报价仅接受 UTF-8 JSON');
  const text=await readBoundedUtf8Text(c.req.raw,8192);
  let body:unknown;
  try{body=JSON.parse(text);}catch{throw new ValidateException('退款报价 JSON 无效');}
  const quote=await quoteAdminRefundCreation(c.get('container'),{id,authVersion:c.get('socketAuthVersion')??'',expiresAt:c.get('socketTokenExp')??0},body);
  return jsonOk(c,quote,'当前退款报价已核对，尚未创建退款申请');
}
