import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminWechatRoutineService } from '@/services/admin/AdminWechatRoutineService';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store');
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('小程序配置接口不接受查询参数');
  return { service: new AdminWechatRoutineService(c.get('container'), c.env),
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
async function body(c: C, limit: number): Promise<unknown> {
  const text = await readBoundedUtf8Text(c.req.raw, limit);
  try { return parseLevelActivationJson(text); }
  catch { throw new ValidateException('小程序配置JSON无效、字段重复或层级过深'); }
}
export async function read(c: C) { const x = context(c); return jsonOk(c, await x.service.loadSnapshot(x.actor)); }
export async function save(c: C) { const x = context(c); return jsonOk(c, await x.service.saveConfig(x.actor, await body(c, 65536))); }
export async function receipt(c: C) { const x = context(c); return jsonOk(c, await x.service.receiptConfig(x.actor, c.req.param('operationId'))); }
export async function resolve(c: C) {
  const x = context(c), input = await body(c, 1024);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'confirmed')
    || (input as { confirmed?: unknown }).confirmed !== true)
    throw new ValidateException('请明确确认核对并封存原小程序配置请求');
  return jsonOk(c, await x.service.resolveConfig(x.actor, c.req.param('operationId')));
}
