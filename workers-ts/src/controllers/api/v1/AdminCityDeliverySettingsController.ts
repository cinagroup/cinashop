import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminCityDeliverySettingsService } from '@/services/admin/AdminCityDeliverySettingsService';
import { CityDeliverySettingsRejected, CityDeliverySettingsStaleVersion, readCitySettingsBody } from '@/services/admin/AdminCityDeliverySettingsInput';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminCityDeliverySettingsService(c.get('container'), c.env);
function privateResponse(c: C) { c.header('Cache-Control', 'private, no-store'); if (new URL(c.req.url).searchParams.size) throw new ValidateException('配送配置接口不接受查询参数'); }
function actor(c: C) { const value = c.get('adminInfo'); if (!value) throw new ValidateException('管理员身份不存在'); return { id: value.id }; }
async function run(c: C, operation: () => Promise<unknown>) {
  privateResponse(c);
  try { return jsonOk(c, await operation()); } catch (error) {
    if (error instanceof NotFoundException) return c.json({ status: 404, msg: error.message, data: null }, 404);
    // Exact pre-effective-DML errors arrive only after withTx rollback completed.
    if (error instanceof CityDeliverySettingsRejected || error instanceof CityDeliverySettingsStaleVersion) {
      const status = error instanceof CityDeliverySettingsStaleVersion ? 409 : 400;
      return c.json({ status, msg: error.message, data: { code: status === 409 ? 'CITY_DELIVERY_SETTINGS_STALE_VERSION' : 'CITY_DELIVERY_SETTINGS_REJECTED', operation: error.operation,
        request_id: error.request_id, client_nonce: error.client_nonce, payload_hash: error.payload_hash } }, status);
    }
    throw error;
  }
}
export async function read(c: C) { return run(c, () => service(c).read()); }
export async function prepare(c: C) { return run(c, async () => service(c).prepare(await readCitySettingsBody(c.req.raw), actor(c))); }
export async function intent(c: C) { return run(c, () => service(c).intent(c.req.param('requestId'), actor(c))); }
export async function confirm(c: C) { return run(c, async () => service(c).confirm(await readCitySettingsBody(c.req.raw), actor(c))); }
export async function receipt(c: C) { return run(c, () => service(c).receipt(c.req.param('requestId'), actor(c))); }
