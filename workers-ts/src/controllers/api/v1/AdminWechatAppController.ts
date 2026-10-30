import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminWechatAppService } from '@/services/admin/AdminWechatAppService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store');
  const query = new URL(c.req.url).searchParams;
  if (query.size) throw new ValidateException('原生App配置接口不接受查询参数');
  return { service: new AdminWechatAppService(c.get('container'), c.env),
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
async function body(c: C, limit: number) {
  const text = await readBoundedUtf8Text(c.req.raw, limit);
  try { return parseLevelActivationJson(text); }
  catch { throw new ValidateException('原生App配置JSON无效、字段重复或层级过深'); }
}
export async function read(c: C) { const x = context(c); return jsonOk(c, await x.service.read(x.actor)); }
export async function save(c: C) { const x = context(c); return jsonOk(c, await x.service.save(await body(c, 65536), x.actor)); }
export async function receipt(c: C) { const x = context(c); return jsonOk(c, await x.service.receipt(c.req.param('operationId'), x.actor)); }
export async function resolve(c: C) { const x = context(c); return jsonOk(c, await x.service.resolve(c.req.param('operationId'), await body(c, 1024), x.actor)); }
