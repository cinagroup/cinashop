import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminProductCatalogReadService } from '@/services/admin/AdminProductCatalogReadService';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  return { service: new AdminProductCatalogReadService(c.get('container'), c.env.APP_KEY), query: new URL(c.req.url).searchParams,
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
export async function list(c: C) { const x = context(c); return jsonOk(c, await x.service.list(x.query, x.actor)); }
export async function header(c: C) { const x = context(c); return jsonOk(c, await x.service.header(x.query, x.actor)); }
