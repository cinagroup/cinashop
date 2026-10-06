import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminCouponTemplateService } from '@/services/admin/AdminCouponTemplateService';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { readBoundedJsonObject } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
type Operation = 'create' | 'invalidate' | 'delete' | 'publish';
const service = (c: C) => new AdminCouponTemplateService(c.get('container'), c.env.APP_KEY);
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
export async function issues(c: C) {
  privateResponse(c); return jsonOk(c, await service(c).issues(c.req.param('id') ?? '', new URL(c.req.url).searchParams));
}
async function write(c: C, operation: Operation) {
  privateResponse(c); noQuery(c);
  const actor = c.get('adminInfo');
  if (!actor) throw new ValidateException('管理员身份不存在');
  // Publishing requires both the explicit publication capability checked by
  // adminAuth and access to the template whose terms are being published.
  if (operation === 'publish') await new AdminPermissionService(c.get('container'))
    .assertAuthorized(actor, 'GET', '/adminapi/marketing/coupon-templates');
  return jsonOk(c, await service(c).mutate(operation, c.req.param('id'),
    await readBoundedJsonObject(c.req.raw, 16384), { id: actor.id }), '操作成功');
}
export const create = (c: C) => write(c, 'create');
export const invalidate = (c: C) => write(c, 'invalidate');
export const remove = (c: C) => write(c, 'delete');
export const publish = (c: C) => write(c, 'publish');
