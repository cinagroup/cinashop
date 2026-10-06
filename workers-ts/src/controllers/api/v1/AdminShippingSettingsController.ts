import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminShippingSettingsService } from '@/services/admin/AdminShippingSettingsService';
import { readShippingSettingsBody, ShippingSettingsStaleVersion } from '@/services/admin/AdminShippingSettingsInput';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminShippingSettingsService(c.get('container'), c.env);
function noStore(c: C, query = false) {
  c.header('Cache-Control', 'private, no-store');
  const params = new URL(c.req.url).searchParams;
  if ((!query && params.size) || (query && ([...params.keys()].some(key => key !== 'pid') || params.getAll('pid').length > 1))) {
    throw new ValidateException('此操作查询参数无效');
  }
}
function actor(c: C) {
  const admin = c.get('adminInfo');
  if (!admin) throw new ValidateException('管理员身份不存在');
  return { id: admin.id };
}
export async function settings(c: C) { noStore(c); return jsonOk(c, await service(c).get()); }
export async function cities(c: C) { noStore(c, true); return jsonOk(c, await service(c).cities(c.req.query('pid'))); }
export async function save(c: C) {
  noStore(c);
  try { return jsonOk(c, await service(c).save(await readShippingSettingsBody(c.req.raw), actor(c)), '配送设置已保存'); }
  catch (error) {
    if (error instanceof ShippingSettingsStaleVersion) return c.json({ status: 409, msg: error.message,
      data: { code: 'SHIPPING_SETTINGS_STALE_VERSION', request_id: error.request_id, payload_hash: error.payload_hash } }, 409);
    throw error;
  }
}
export async function receipt(c: C) {
  noStore(c);
  try { return jsonOk(c, await service(c).receipt(c.req.param('requestId'), actor(c))); }
  catch (error) {
    if (error instanceof NotFoundException) return c.json({ status: 404, msg: error.message, data: null }, 404);
    throw error;
  }
}
