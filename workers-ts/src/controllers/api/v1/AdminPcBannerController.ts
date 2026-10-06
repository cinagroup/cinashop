import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminPcBannerService } from '@/services/admin/AdminPcBannerService';
import { parsePcBannerQuery, readPcBannerBody, PcBannerStaleVersion, type PcBannerOperation } from '@/services/admin/AdminPcBannerInput';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminPcBannerService(c.get('container'), c.env);
function privateResponse(c: C, query = false) {
  c.header('Cache-Control', 'private, no-store');
  if (!query && new URL(c.req.url).searchParams.size) throw new ValidateException('此PC轮播操作不接受查询参数');
}
function actor(c: C) {
  const admin = c.get('adminInfo'); if (!admin) throw new ValidateException('管理员身份不存在');
  return { id: admin.id };
}
async function read(c: C, action: () => Promise<unknown>) {
  try { return jsonOk(c, await action()); }
  catch (error) { if (error instanceof NotFoundException) return c.json({ status: 404, msg: error.message, data: null }, 404); throw error; }
}
export async function list(c: C) {
  privateResponse(c, true);
  return jsonOk(c, await service(c).list(parsePcBannerQuery(new URL(c.req.url).searchParams)));
}
export async function detail(c: C) { privateResponse(c); return read(c, () => service(c).detail(c.req.param('id'))); }
export async function receipt(c: C) { privateResponse(c); return read(c, () => service(c).receipt(c.req.param('requestId'), actor(c))); }
async function write(c: C, operation: PcBannerOperation) {
  privateResponse(c);
  try { return jsonOk(c, await service(c).mutate(operation, c.req.param('id'), await readPcBannerBody(c.req.raw), actor(c)), 'PC轮播操作成功'); }
  catch (error) {
    if (error instanceof PcBannerStaleVersion) return c.json({ status: 409, msg: error.message,
      data: { code: 'PC_BANNER_STALE_VERSION', operation: error.operation, request_id: error.request_id, payload_hash: error.payload_hash } }, 409);
    if (error instanceof NotFoundException) return c.json({ status: 404, msg: error.message, data: null }, 404);
    throw error;
  }
}
export const create = (c: C) => write(c, 'create');
export const update = (c: C) => write(c, 'update');
export const status = (c: C) => write(c, 'status');
export const remove = (c: C) => write(c, 'delete');
