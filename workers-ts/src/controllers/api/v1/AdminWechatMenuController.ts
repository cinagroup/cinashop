import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminWechatMenuService } from '@/services/admin/AdminWechatMenuService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedJsonObject } from '@/utils/request-body';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store');
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('公众号菜单接口不接受查询参数');
  return { service: new AdminWechatMenuService(c.get('container'), c.env.APP_KEY),
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
export async function read(c: C) { const x = context(c); return jsonOk(c, await x.service.read(x.actor)); }
export async function publish(c: C) { const x = context(c); return jsonOk(c, await x.service.publish(await readBoundedJsonObject(c.req.raw, 65536), x.actor)); }
export async function legacyPublish(c: C) {
  const x = context(c), body = await readBoundedJsonObject(c.req.raw, 65536);
  return jsonOk(c, await x.service.legacyPublish(body, x.actor, c.req.header('X-Menu-Operation') ?? crypto.randomUUID()), '公众号菜单已发布');
}
export async function receipt(c: C) { const x = context(c); return jsonOk(c, await x.service.receipt(c.req.param('operationId'), x.actor)); }
export async function observe(c: C) {
  const x = context(c), body = await readBoundedJsonObject(c.req.raw, 1024);
  if (Object.keys(body).length) throw new ValidateException('核对请求须为空对象');
  return jsonOk(c, await x.service.observe(c.req.param('operationId'), x.actor));
}
export async function confirmObservation(c: C) {
  const x = context(c);
  return jsonOk(c, await x.service.confirmObservation(c.req.param('operationId'), await readBoundedJsonObject(c.req.raw, 1024), x.actor));
}
export async function resolveMissing(c: C) {
  const x = context(c);
  return jsonOk(c, await x.service.resolveMissing(c.req.param('operationId'), await readBoundedJsonObject(c.req.raw, 65536), x.actor));
}
