import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminLegacyRoleOperationService, parseLegacyRoleCommitMetadata,
  type LegacyRoleActor } from '@/services/admin/AdminLegacyRoleOperationService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedJsonObject, readBoundedUtf8Text } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function actor(c: C): LegacyRoleActor {
  c.header('Cache-Control','private, no-store'); c.header('Pragma','no-cache');
  return { id:c.get('adminId') ?? 0, authVersion:c.get('socketAuthVersion') ?? '', expiresAt:c.get('socketTokenExp') ?? 0 };
}
function noQuery(c: C): void {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('角色操作不接受查询参数');
}
function service(c: C) { return new AdminLegacyRoleOperationService(c.get('container'), c.env.APP_KEY); }
async function noStatusBody(c: C): Promise<void> {
  if (await readBoundedUtf8Text(c.req.raw,1) !== '') throw new ValidateException('角色启停不接受请求体');
}
/** The old tableDelApi sends data.ids, which is an empty string for this page.
 * Also accept its fixed logical {ids:''} envelope. Neither supplies a target:
 * the only target is the strict path ID. Other body fields are refused. */
async function legacyDeleteBody(c: C): Promise<void> {
  const raw = await readBoundedUtf8Text(c.req.raw,128);
  if (raw === '') return;
  let value: unknown;
  try { value=JSON.parse(raw); } catch { throw new ValidateException('角色删除数据格式错误'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Object.hasOwn(value,'ids')
    || (value as {ids:unknown}).ids !== '') throw new ValidateException('角色删除仅兼容空ids参数');
}
export async function adminLegacyRoleStatus(c: C) {
  const claims=actor(c); noQuery(c);
  const metadata=parseLegacyRoleCommitMetadata(c.req.raw.headers); await noStatusBody(c);
  return jsonOk(c,await service(c).setStatus(c.req.param('id') ?? '',c.req.param('status') ?? '',metadata,claims),'修改成功');
}
export async function adminLegacyRoleDelete(c: C) {
  const claims=actor(c); noQuery(c);
  const metadata=parseLegacyRoleCommitMetadata(c.req.raw.headers); await legacyDeleteBody(c);
  return jsonOk(c,await service(c).delete(c.req.param('id') ?? '',metadata,claims),'删除成功!');
}
export async function adminLegacyRolePreview(c: C) {
  const claims=actor(c); noQuery(c);
  return jsonOk(c,await service(c).preview(await readBoundedJsonObject(c.req.raw,2048),claims));
}
export async function adminLegacyRoleReceipt(c: C) {
  const claims=actor(c),query=new URL(c.req.url).searchParams;
  if (query.size !== 1 || query.getAll('operation').length !== 1) throw new ValidateException('回执查询必须包含唯一操作类型');
  return jsonOk(c,await service(c).receipt(c.req.param('operationId') ?? '',query.get('operation'),claims));
}
export async function adminLegacyRoleResolve(c: C) {
  const claims=actor(c); noQuery(c);
  return jsonOk(c,await service(c).resolve(await readBoundedJsonObject(c.req.raw,2048),claims));
}
