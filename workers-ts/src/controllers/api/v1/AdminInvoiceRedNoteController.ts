import type {Context} from 'hono';
import type {AppVariables,Env} from '@/env';
import {AdminInvoiceRedNoteService} from '@/services/admin/AdminInvoiceRedNoteService';
import {readBoundedJsonObject} from '@/utils/request-body';
import {ValidateException} from '@/utils/errors';
import {jsonOk} from '@/utils/json';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function scope(c:C){c.header('Cache-Control','private, no-store');if(new URL(c.req.url).searchParams.size)throw new ValidateException('此操作不接受查询参数');return new AdminInvoiceRedNoteService(c.get('container'));}
function actor(c:C){const admin=c.get('adminInfo');if(!admin)throw new ValidateException('管理员身份不存在');return admin.id;}
export async function list(c:C){return jsonOk(c,await scope(c).list(c.req.param('id')));}
export async function record(c:C){return jsonOk(c,await scope(c).record(c.req.param('id'),await readBoundedJsonObject(c.req.raw,16384),actor(c)),'人工红字凭据已录入，尚待独立核对');}
export async function review(c:C){return jsonOk(c,await scope(c).review(c.req.param('id'),c.req.param('recordId'),await readBoundedJsonObject(c.req.raw,4096),actor(c)),'人工核对凭据已保存');}
export async function operation(c:C){return jsonOk(c,await scope(c).operation(c.req.param('id'),c.req.param('requestId'),actor(c)));}

