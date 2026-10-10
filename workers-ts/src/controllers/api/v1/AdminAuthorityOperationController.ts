import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminAuthorityOperationService } from '@/services/admin/AdminAuthorityOperationService';
import type { AdminAuthorityActor } from '@/services/admin/AdminAuthorityWriteService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedJsonObject } from '@/utils/request-body';

type C = Context<{ Bindings:Env; Variables:AppVariables }>;
function actor(c: C): AdminAuthorityActor {
  c.header('Cache-Control','private, no-store'); c.header('Pragma','no-cache');
  return { id:c.get('adminId') ?? 0,authVersion:c.get('socketAuthVersion') ?? '',expiresAt:c.get('socketTokenExp') ?? 0 };
}
function noQuery(c: C): void {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('权限操作不接受查询参数');
}
function service(c: C) { return new AdminAuthorityOperationService(c.get('container'),c.env.APP_KEY); }
export async function adminAuthorityPreview(c: C) {
  const claims = actor(c); noQuery(c);
  return jsonOk(c,await service(c).preview(await readBoundedJsonObject(c.req.raw,65_536),claims));
}
export async function adminAuthorityCommit(c: C) {
  const claims = actor(c); noQuery(c);
  return jsonOk(c,await service(c).commit(await readBoundedJsonObject(c.req.raw,65_536),claims));
}
export async function adminAuthorityReceipt(c: C) {
  const claims = actor(c),query = new URL(c.req.url).searchParams;
  if (query.size !== 1 || query.getAll('operation').length !== 1) throw new ValidateException('回执查询必须包含唯一操作类型');
  return jsonOk(c,await service(c).receipt(c.req.param('operationId'),query.get('operation'),claims));
}
export async function adminAuthorityResolve(c: C) {
  const claims = actor(c); noQuery(c);
  return jsonOk(c,await service(c).resolve(await readBoundedJsonObject(c.req.raw,2_048),claims));
}
