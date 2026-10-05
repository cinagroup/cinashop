import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminRechargeQuotaService, type RechargeQuotaOperation } from '@/services/admin/AdminRechargeQuotaService';
import { readBoundedJsonObject } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminRechargeQuotaService(c.get('container'));
function noQuery(c: C) {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('此操作不接受查询参数');
}

export async function list(c: C) {
  c.header('Cache-Control', 'private, no-store');
  return jsonOk(c, await service(c).list(new URL(c.req.url).searchParams));
}

export async function detail(c: C) {
  c.header('Cache-Control', 'private, no-store');
  noQuery(c);
  return jsonOk(c, await service(c).detail(c.req.param('id')));
}

async function write(c: C, operation: RechargeQuotaOperation) {
  c.header('Cache-Control', 'private, no-store');
  noQuery(c);
  const admin = c.get('adminInfo');
  if (!admin) throw new ValidateException('管理员身份不存在');
  const input = await readBoundedJsonObject(c.req.raw, 4096);
  return jsonOk(c, await service(c).mutate(operation, c.req.param('id'), input, { id: admin.id }), '操作成功');
}

export const create = (c: C) => write(c, 'create');
export const update = (c: C) => write(c, 'update');
export const status = (c: C) => write(c, 'status');
export const remove = (c: C) => write(c, 'delete');
