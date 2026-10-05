import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminCommissionReadService } from '@/services/admin/AdminCommissionReadService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminCommissionReadService(c.get('container'));
function privateResponse(c: C) {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  c.header('Pragma', 'no-cache');
}

export async function list(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).list(new URL(c.req.url).searchParams));
}

export async function detail(c: C) {
  privateResponse(c);
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('佣金详情不接受查询参数');
  return jsonOk(c, await service(c).detail(c.req.param('uid')));
}

export async function records(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).records(c.req.param('uid'), new URL(c.req.url).searchParams));
}
