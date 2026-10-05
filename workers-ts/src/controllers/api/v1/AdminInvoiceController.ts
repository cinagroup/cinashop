import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminInvoiceService } from '@/services/admin/AdminInvoiceService';
import { readBoundedJsonObject } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminInvoiceService(c.get('container'));
function privateResponse(c: C) { c.header('Cache-Control', 'private, no-store'); }
function noQuery(c: C) {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('此操作不接受查询参数');
}

export async function list(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).list(new URL(c.req.url).searchParams));
}

export async function detail(c: C) {
  privateResponse(c);
  noQuery(c);
  return jsonOk(c, await service(c).detail(c.req.param('id')));
}

export async function orderInfo(c: C) {
  privateResponse(c);
  noQuery(c);
  return jsonOk(c, await service(c).orderInfo(c.req.param('id')));
}

export async function process(c: C) {
  privateResponse(c);
  noQuery(c);
  const actor = c.get('adminInfo');
  if (!actor) throw new ValidateException('管理员身份不存在');
  return jsonOk(c, await service(c).process(c.req.param('id'), await readBoundedJsonObject(c.req.raw, 4096), actor.id), '处理成功');
}
