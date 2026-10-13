import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { jsonOk } from '@/utils/json';
import { AdminLegacySystemLogService, type AdminLegacySystemLogActor } from '@/services/admin/AdminLegacySystemLogService';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function actor(c: C): AdminLegacySystemLogActor {
  c.header('Cache-Control', 'private, no-store');
  c.header('Pragma', 'no-cache');
  return { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 };
}
export async function list(c: C) {
  const identity = actor(c);
  return jsonOk(c, await new AdminLegacySystemLogService(c.get('container')).list(new URL(c.req.url).searchParams, identity));
}
export async function adminOptions(c: C) {
  const identity = actor(c);
  return jsonOk(c, await new AdminLegacySystemLogService(c.get('container')).adminOptions(new URL(c.req.url).searchParams, identity));
}
