import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminCouponIssueService } from '@/services/admin/AdminCouponIssueService';
import { readBoundedJsonObject } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminCouponIssueService(c.get('container'), c.env.APP_KEY);
function noQuery(c: C) {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('此操作不接受查询参数');
}
function privateResponse(c: C) { c.header('Cache-Control', 'private, no-store'); }
export async function list(c: C) {
  privateResponse(c); return jsonOk(c, await service(c).list(new URL(c.req.url).searchParams));
}
export async function options(c: C) {
  privateResponse(c); noQuery(c); return jsonOk(c, await service(c).options());
}
export async function products(c: C) {
  privateResponse(c); return jsonOk(c, await service(c).products(new URL(c.req.url).searchParams));
}
export async function detail(c: C) {
  privateResponse(c); noQuery(c); return jsonOk(c, await service(c).detail(c.req.param('id') ?? ''));
}
export async function copy(c: C) {
  privateResponse(c); noQuery(c); return jsonOk(c, await service(c).copy(c.req.param('id') ?? ''));
}
export async function claims(c: C) {
  privateResponse(c); return jsonOk(c, await service(c).claims(c.req.param('id') ?? '', new URL(c.req.url).searchParams));
}
async function write(c: C, operation: 'create' | 'status' | 'delete') {
  privateResponse(c); noQuery(c);
  const actor = c.get('adminInfo');
  if (!actor) throw new ValidateException('管理员身份不存在');
  return jsonOk(c, await service(c).mutate(operation, c.req.param('id'),
    await readBoundedJsonObject(c.req.raw, 16384), { id: actor.id }), '操作成功');
}
export const create = (c: C) => write(c, 'create');
export const status = (c: C) => write(c, 'status');
export const remove = (c: C) => write(c, 'delete');
