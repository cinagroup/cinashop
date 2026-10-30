import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { jsonOk } from '@/utils/json';
import { AdminLevelAttachmentService } from '@/services/admin/AdminLevelAttachmentService';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store');
  c.header('Pragma', 'no-cache');
  return { service: new AdminLevelAttachmentService(c.get('container'), c.env.APP_KEY),
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 },
    query: new URL(c.req.url).searchParams };
}
export async function options(c: C) { const value = context(c); return jsonOk(c, await value.service.options(value.query, value.actor)); }
export async function categories(c: C) { const value = context(c); return jsonOk(c, await value.service.categories(value.query, value.actor)); }
