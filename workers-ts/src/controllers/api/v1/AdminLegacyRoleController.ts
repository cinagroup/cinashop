import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminLegacyRoleWorkflowService, type AdminLegacyRoleActor } from '@/services/admin/AdminLegacyRoleWorkflowService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function actor(c: C): AdminLegacyRoleActor {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  return { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 };
}
export async function adminLegacyRoleCreateForm(c: C) {
  return jsonOk(c, await new AdminLegacyRoleWorkflowService(c.get('container')).createForm(new URL(c.req.url).searchParams, actor(c)));
}
export async function adminLegacyRoleEditForm(c: C) {
  return jsonOk(c, await new AdminLegacyRoleWorkflowService(c.get('container')).editForm(c.req.param('id') ?? '', new URL(c.req.url).searchParams, actor(c)));
}
export async function adminLegacyRoleSave(c: C) {
  const claims = actor(c);
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('角色提交不接受查询参数');
  let body: unknown;
  try { body = await c.req.json(); } catch { throw new ValidateException('角色提交必须为JSON对象'); }
  const result = await new AdminLegacyRoleWorkflowService(c.get('container')).save(c.req.param('id') ?? '', body, claims);
  return jsonOk(c, result, result.created ? '添加身份成功!' : '修改成功!');
}
