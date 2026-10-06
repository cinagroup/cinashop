import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminLevelActivationService } from '@/services/admin/AdminLevelActivationService';
import { readAdminLevelActivationBody } from '@/services/admin/AdminLevelActivationInput';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminLevelActivationService(c.get('container'), c.env);

function noQuery(c: C): void {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('此操作不接受查询参数');
}

function privateResponse(c: C): void {
  c.header('Cache-Control', 'private, no-store');
}

export async function get(c: C) {
  privateResponse(c);
  noQuery(c);
  return jsonOk(c, await service(c).get());
}

export async function coupons(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).coupons(new URL(c.req.url).searchParams));
}

export async function save(c: C) {
  privateResponse(c);
  noQuery(c);
  const actor = c.get('adminInfo');
  if (!actor) throw new ValidateException('管理员身份不存在');
  const input = await readAdminLevelActivationBody(c.req.raw);
  return jsonOk(c, await service(c).save(input, { id: actor.id }), '保存成功');
}
