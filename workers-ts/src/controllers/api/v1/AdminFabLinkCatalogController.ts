import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminFabLinkCatalogService } from '@/services/admin/AdminFabLinkCatalogService';
import { jsonOk } from '@/utils/json';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function service(c: C) { c.header('Cache-Control', 'private, no-store'); return new AdminFabLinkCatalogService(c.get('container'), c.env); }
export async function categories(c: C) { return jsonOk(c, await service(c).categories(new URL(c.req.url).searchParams)); }
export async function targets(c: C) { return jsonOk(c, await service(c).targets(new URL(c.req.url).searchParams)); }
