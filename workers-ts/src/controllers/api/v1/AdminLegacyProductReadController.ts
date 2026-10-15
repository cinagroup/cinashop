import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminLegacyProductReadService } from '@/services/admin/AdminLegacyProductReadService';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { jsonFail, jsonOk } from '@/utils/json';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
export async function detail(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  const raw = c.req.param('id') ?? '';
  if (!/^(?:0|[1-9]\d{0,9})$/.test(raw) || Number(raw) > 2_147_483_647) throw new ValidateException('商品ID错误');
  const service = new AdminLegacyProductReadService(c.get('container'), c.env.APP_KEY);
  const actor = { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 };
  try { return jsonOk(c, await service.detail(Number(raw), new URL(c.req.url).searchParams, actor)); }
  catch (error) {
    if (error instanceof HttpApiException && [409, 503].includes(error.httpStatus)) return jsonFail(c, error.message);
    throw error;
  }
}
