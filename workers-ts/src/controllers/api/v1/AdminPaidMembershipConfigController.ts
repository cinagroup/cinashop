import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminPaidMembershipConfigService } from '@/services/admin/AdminPaidMembershipConfigService';
import { readAdminPaidMembershipConfigBody } from '@/services/admin/AdminPaidMembershipConfigInput';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminPaidMembershipConfigService(c.get('container'), c.env);
function prepare(c: C) {
  c.header('Cache-Control', 'private, no-store');
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('此操作不接受查询参数');
}
export async function get(c: C) {
  prepare(c); return jsonOk(c, await service(c).get());
}
export async function save(c: C) {
  prepare(c);
  const actor = c.get('adminInfo');
  if (!actor) throw new ValidateException('管理员身份不存在');
  return jsonOk(c, await service(c).save(await readAdminPaidMembershipConfigBody(c.req.raw), { id: actor.id }), '保存成功');
}
