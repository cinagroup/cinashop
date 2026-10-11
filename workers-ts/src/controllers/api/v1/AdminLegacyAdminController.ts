import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminLegacyAdminWorkflowService, parseLegacyAdminCommitMetadata,
  type LegacyAdminActor as AdminLegacyAdminActor } from '@/services/admin/AdminLegacyAdminWorkflowService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedJsonObject, readBoundedUtf8Text } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function actor(c: C): AdminLegacyAdminActor {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  return { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 };
}
function noQuery(c: C): void {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('管理员操作不接受查询参数');
}
function service(c: C) { return new AdminLegacyAdminWorkflowService(c.get('container'), c.env.APP_KEY); }
async function noBody(c: C): Promise<void> {
  if (await readBoundedUtf8Text(c.req.raw, 1) !== '') throw new ValidateException('管理员状态和删除操作不接受请求体');
}
export async function adminLegacyAdminCreateForm(c: C) {
  return jsonOk(c, await service(c).createForm(new URL(c.req.url).searchParams, actor(c)));
}
export async function adminLegacyAdminEditForm(c: C) {
  return jsonOk(c, await service(c).editForm(c.req.param('id') ?? '', new URL(c.req.url).searchParams, actor(c)));
}
export async function adminLegacyAdminCreate(c: C) {
  const claims = actor(c); noQuery(c);
  const metadata = parseLegacyAdminCommitMetadata(c.req.raw.headers);
  return jsonOk(c, await service(c).save('0', await readBoundedJsonObject(c.req.raw, 8_192), metadata, claims), '添加成功');
}
export async function adminLegacyAdminUpdate(c: C) {
  const claims = actor(c); noQuery(c);
  const metadata = parseLegacyAdminCommitMetadata(c.req.raw.headers);
  return jsonOk(c, await service(c).save(c.req.param('id') ?? '', await readBoundedJsonObject(c.req.raw, 8_192), metadata, claims), '修改成功');
}
export async function adminLegacyAdminStatus(c: C) {
  const claims = actor(c); noQuery(c);
  const metadata = parseLegacyAdminCommitMetadata(c.req.raw.headers); await noBody(c);
  const status = c.req.param('status') ?? '';
  return jsonOk(c, await service(c).setStatus(c.req.param('id') ?? '', status, metadata, claims), status === '0' ? '关闭成功' : '开启成功');
}
export async function adminLegacyAdminDelete(c: C) {
  const claims = actor(c); noQuery(c);
  const metadata = parseLegacyAdminCommitMetadata(c.req.raw.headers); await noBody(c);
  return jsonOk(c, await service(c).delete(c.req.param('id') ?? '', metadata, claims), '删除成功！');
}
export async function adminLegacyAdminPreview(c: C) {
  const claims = actor(c); noQuery(c);
  return jsonOk(c, await service(c).preview(await readBoundedJsonObject(c.req.raw, 10_240), claims));
}
export async function adminLegacyAdminReceipt(c: C) {
  const claims = actor(c), query = new URL(c.req.url).searchParams;
  if (query.size !== 1 || query.getAll('operation').length !== 1) throw new ValidateException('回执查询必须包含唯一操作类型');
  return jsonOk(c, await service(c).receipt(c.req.param('operationId') ?? '', query.get('operation'), claims));
}
export async function adminLegacyAdminResolve(c: C) {
  const claims = actor(c); noQuery(c);
  return jsonOk(c, await service(c).resolve(await readBoundedJsonObject(c.req.raw, 2_048), claims));
}
