import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminFabSettingsService } from '@/services/admin/AdminFabSettingsService';
import { FabSettingsRejected, FabSettingsStaleVersion, readFabBody } from '@/services/admin/AdminFabSettingsInput';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminFabSettingsService(c.get('container'), c.env);
function privateResponse(c: C) {
  c.header('Cache-Control','private, no-store');
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('悬浮按钮接口不接受查询参数');
}
function actor(c: C) { const admin = c.get('adminInfo'); if (!admin) throw new ValidateException('管理员身份不存在'); return { id: admin.id }; }
export async function read(c: C) { privateResponse(c); return jsonOk(c, await service(c).read()); }
export async function receipt(c: C) {
  privateResponse(c);
  try { return jsonOk(c, await service(c).receipt(c.req.param('requestId'),actor(c))); }
  catch (error) { if (error instanceof NotFoundException) return c.json({ status: 404,msg: error.message,data: null },404); throw error; }
}
export async function save(c: C) {
  privateResponse(c);
  try { return jsonOk(c,await service(c).save(await readFabBody(c.req.raw),actor(c)),'悬浮按钮保存成功'); }
  catch (error) {
    if (error instanceof FabSettingsStaleVersion || error instanceof FabSettingsRejected) {
      const status = error instanceof FabSettingsStaleVersion ? 409 : 400;
      return c.json({ status,msg: error.message,data: { code: status === 409 ? 'FAB_SETTINGS_STALE_VERSION' : 'FAB_SETTINGS_REJECTED',
        operation: error.operation,request_id: error.request_id,payload_hash: error.payload_hash } },status);
    }
    throw error;
  }
}
