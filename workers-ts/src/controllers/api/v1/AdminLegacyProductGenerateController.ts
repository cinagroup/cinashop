import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminLegacyProductGenerateService } from '@/services/admin/AdminLegacyProductGenerateService';
import { readAdminLegacyProductGenerateBody } from '@/services/admin/AdminLegacyProductGenerateInput';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { jsonFail, jsonOk } from '@/utils/json';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
export async function generate(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  const rawId = c.req.param('id') ?? '', rawMode = c.req.param('type') ?? '';
  if (!/^(?:0|[1-9]\d{0,9})$/.test(rawId) || Number(rawId) > 2_147_483_647 || !/^[012]$/.test(rawMode))
    throw new ValidateException('商品ID或规格生成模式错误');
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('商品规格生成不接受查询参数');
  const body = await readAdminLegacyProductGenerateBody(c.req.raw);
  const actor = { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 };
  try { return jsonOk(c, await new AdminLegacyProductGenerateService(c.get('container'), c.env.APP_KEY)
    .generate(Number(rawId), Number(rawMode) as 0 | 1 | 2, body, actor)); }
  catch (error) {
    if (error instanceof HttpApiException && [409, 503].includes(error.httpStatus)) return jsonFail(c, error.message);
    throw error;
  }
}
