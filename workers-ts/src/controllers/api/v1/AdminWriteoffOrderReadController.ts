import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminWriteoffOrderReadService } from '@/services/admin/AdminWriteoffOrderReadService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminWriteoffOrderReadService(c.get('container'));
function privateResponse(c: C) {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  c.header('Pragma', 'no-cache');
}
function noQuery(c: C) {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('核销订单接口不接受查询参数');
}

export async function list(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).list(new URL(c.req.url).searchParams));
}

export async function stores(c: C) {
  privateResponse(c);
  noQuery(c);
  return jsonOk(c, await service(c).stores());
}

export async function spreadInfo(c: C) {
  privateResponse(c);
  noQuery(c);
  return jsonOk(c, await service(c).spreadInfo(c.req.param('uid')));
}

export function badge(c: C) {
  privateResponse(c);
  noQuery(c);
  return jsonOk(c, []);
}
