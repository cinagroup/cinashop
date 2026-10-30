import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminPcBaseSupportService } from '@/services/admin/AdminPcBaseSupportService';
import { AdminPcBaseService } from '@/services/admin/AdminPcBaseService';
import { readPcBaseSaveRequest } from '@/services/admin/AdminPcBaseInput';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C, support = false) {
  c.header('Cache-Control', 'private, no-store');
  const query = new URL(c.req.url).searchParams;
  if (!support && query.size) throw new ValidateException('PC配置接口不接受查询参数');
  return { service: new AdminPcBaseService(c.get('container'), c.env), query,
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
export async function read(c: C) { const x = context(c); return jsonOk(c, await x.service.read(x.actor)); }
export async function save(c: C) { const x = context(c); return jsonOk(c, await x.service.save(await readPcBaseSaveRequest(c.req.raw), x.actor)); }
export async function receipt(c: C) { const x = context(c); return jsonOk(c, await x.service.receipt(c.req.param('operationId'), x.actor)); }
export async function resolve(c: C) {
  const x = context(c), text = await readBoundedUtf8Text(c.req.raw, 1024);
  let body: unknown;
  try { body = parseLevelActivationJson(text); } catch { throw new ValidateException('PC配置封存请求格式无效或字段重复'); }
  return jsonOk(c, await x.service.resolve(c.req.param('operationId'), body, x.actor));
}

export async function categories(c: C) { const x = context(c, true); return jsonOk(c, await new AdminPcBaseSupportService(c.get('container'), c.env).categories(x.query, x.actor)); }
export async function options(c: C) { const x = context(c, true); return jsonOk(c, await new AdminPcBaseSupportService(c.get('container'), c.env).options(x.query, x.actor)); }
