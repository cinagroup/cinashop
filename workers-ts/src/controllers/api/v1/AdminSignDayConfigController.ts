import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminSignDayConfigService } from '@/services/admin/AdminSignDayConfigService';
import { readSignDayBody, type SignDayOperation } from '@/services/admin/AdminSignDayConfigInput';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminSignDayConfigService(c.get('container'));
function noQuery(c: C) {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('此操作不接受查询参数');
}
function noStore(c: C) { c.header('Cache-Control', 'private, no-store'); noQuery(c); }
function actor(c: C) {
  const admin = c.get('adminInfo');
  if (!admin) throw new ValidateException('管理员身份不存在');
  return { id: admin.id };
}

export async function list(c: C) { noStore(c); return jsonOk(c, await service(c).list()); }
export async function detail(c: C) { noStore(c); return jsonOk(c, await service(c).detail(c.req.param('id'))); }
export async function receipt(c: C) {
  noStore(c);
  try { return jsonOk(c, await service(c).receipt(c.req.param('requestId'), actor(c))); }
  catch (error) {
    if (error instanceof NotFoundException) return c.json({ status: 404, msg: error.message, data: null }, 404);
    throw error;
  }
}
async function write(c: C, operation: SignDayOperation) {
  noStore(c);
  const admin = actor(c);
  const raw = await readSignDayBody(c.req.raw);
  return jsonOk(c, await service(c).mutate(operation, c.req.param('id'), raw, admin), '操作成功');
}
export const create = (c: C) => write(c, 'create');
export const update = (c: C) => write(c, 'update');
export const status = (c: C) => write(c, 'status');
export const remove = (c: C) => write(c, 'delete');

export const adminSignDayConfigList = list;
export const adminSignDayConfigDetail = detail;
export const adminSignDayConfigReceipt = receipt;
export const adminSignDayConfigCreate = create;
export const adminSignDayConfigUpdate = update;
export const adminSignDayConfigStatus = status;
export const adminSignDayConfigDelete = remove;
