import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminProductCatalogReadService } from '@/services/admin/AdminProductCatalogReadService';
import { jsonFail, jsonOk } from '@/utils/json';
import { HttpApiException } from '@/utils/errors';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  return { service: new AdminProductCatalogReadService(c.get('container'), c.env.APP_KEY), query: new URL(c.req.url).searchParams,
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
export async function list(c: C) { const x = context(c); return jsonOk(c, await x.service.list(x.query, x.actor)); }
export async function header(c: C) { const x = context(c); return jsonOk(c, await x.service.header(x.query, x.actor)); }
export async function supplierOptions(c: C) {
  const x = context(c);
  try { return jsonOk(c, await x.service.supplierOptions(x.query, x.actor)); }
  catch (error) {
    // The actual old Axios interceptor resolves non-2xx failures as undefined.
    // Classified read refusals must use its PHP business-error envelope so
    // both old and current callers reject with the usable server message.
    if (error instanceof HttpApiException && [409, 503].includes(error.httpStatus)) return jsonFail(c, error.message);
    throw error;
  }
}
