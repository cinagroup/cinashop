import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { jsonOk } from '@/utils/json';
import { readAdminWithdrawalDirectoryQuery, readAdminWithdrawalMediaQuery } from '@/services/admin/AdminWithdrawalDirectoryInput';
import { AdminWithdrawalDirectoryService } from '@/services/admin/AdminWithdrawalDirectoryService';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

export async function directory(c: C) {
  c.header('Cache-Control', 'private, no-store');
  c.header('Pragma', 'no-cache');
  // Validate the actual request framing/encoding, then have the service repeat
  // scalar-domain parsing for callers that use its URLSearchParams entrypoint.
  readAdminWithdrawalDirectoryQuery(c.req.raw);
  const actor = { id:c.get('adminId') ?? 0, authVersion:c.get('socketAuthVersion') ?? '', expiresAt:c.get('socketTokenExp') ?? 0 };
  const service = new AdminWithdrawalDirectoryService(c.get('container'), c.env.APP_KEY);
  return jsonOk(c, await service.list(new URL(c.req.url).searchParams, actor));
}

export async function media(c: C) {
  c.header('Cache-Control', 'private, no-store');
  c.header('Pragma', 'no-cache');
  const { id } = readAdminWithdrawalMediaQuery(c.req.raw, c.req.param('id') ?? '');
  const actor = { id:c.get('adminId') ?? 0, authVersion:c.get('socketAuthVersion') ?? '', expiresAt:c.get('socketTokenExp') ?? 0 };
  const service = new AdminWithdrawalDirectoryService(c.get('container'), c.env.APP_KEY);
  return jsonOk(c, await service.media(id, new URL(c.req.url).searchParams, actor));
}
