import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminWechatBaseService } from '@/services/admin/AdminWechatBaseService';
import { AdminWechatBaseSupportService } from '@/services/admin/AdminWechatBaseSupportService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedJsonObject } from '@/utils/request-body';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C, support = false) {
  c.header('Cache-Control', 'private, no-store');
  const query = new URL(c.req.url).searchParams;
  if (!support && query.size) throw new ValidateException('公众号配置接口不接受查询参数');
  return { service: new AdminWechatBaseService(c.get('container'), c.env), query,
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
export async function read(c: C) { const x = context(c); return jsonOk(c, await x.service.read(x.actor)); }
export async function save(c: C) { const x = context(c); return jsonOk(c, await x.service.save(await readBoundedJsonObject(c.req.raw, 65536), x.actor)); }
export async function receipt(c: C) { const x = context(c); return jsonOk(c, await x.service.receipt(c.req.param('operationId'), x.actor)); }
export async function resolve(c: C) { const x = context(c); return jsonOk(c, await x.service.resolve(c.req.param('operationId'), await readBoundedJsonObject(c.req.raw, 1024), x.actor)); }
export async function categories(c: C) { const x = context(c, true); return jsonOk(c, await new AdminWechatBaseSupportService(c.get('container'), c.env).categories(x.query, x.actor)); }
export async function options(c: C) { const x = context(c, true); return jsonOk(c, await new AdminWechatBaseSupportService(c.get('container'), c.env).options(x.query, x.actor)); }
