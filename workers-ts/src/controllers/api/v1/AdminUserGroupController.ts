import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminUserGroupService } from '@/services/admin/AdminUserGroupService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store');
  c.header('Pragma', 'no-cache');
  return { service: new AdminUserGroupService(c.get('container')), query: new URL(c.req.url).searchParams,
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
async function body(c: C) {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('用户分组写入不接受查询参数');
  const text = await readBoundedUtf8Text(c.req.raw, 8192);
  try { return JSON.parse(text) as unknown; } catch { throw new ValidateException('用户分组JSON格式错误'); }
}
export async function list(c: C) { const x = context(c); return jsonOk(c, await x.service.list(x.query, x.actor)); }
export async function form(c: C) { const x = context(c); return jsonOk(c, await x.service.form(c.req.param('id'), x.query, x.actor)); }
export async function save(c: C) { const x = context(c); await x.service.save(await body(c), x.actor); return jsonOk(c, [], '提交成功！'); }
export async function remove(c: C) { const x = context(c); const message = await x.service.remove(c.req.param('id'), x.query, x.actor); return jsonOk(c, [], message ?? '删除成功!'); }
export async function modernList(c: C) { const x = context(c); return jsonOk(c, await x.service.list(x.query, x.actor, false)); }
export async function modernSave(c: C) { const x = context(c); return jsonOk(c, await x.service.save(await body(c), x.actor, false), '提交成功'); }
export async function modernRemove(c: C) { const x = context(c); return jsonOk(c, await x.service.remove(c.req.param('id'), x.query, x.actor, false), '删除成功'); }
