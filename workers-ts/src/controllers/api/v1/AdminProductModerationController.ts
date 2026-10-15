import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminProductModerationService } from '@/services/admin/AdminProductModerationService';
import { adminProductModerationId } from '@/services/admin/AdminProductModerationInput';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('商品审核不接受查询参数');
  return { id: adminProductModerationId(c.req.param('id')), service: new AdminProductModerationService(c.get('container')),
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
export async function verifyForm(c: C) { const x = context(c); return jsonOk(c, await x.service.form(x.id, 'verify', x.actor)); }
export async function removeForm(c: C) { const x = context(c); return jsonOk(c, await x.service.form(x.id, 'remove', x.actor)); }
export async function getVerify(c: C) { const x = context(c); return jsonOk(c, await x.service.getVerify(x.id, x.actor)); }
export async function save(c: C) {
  const x = context(c);
  const source = await readBoundedUtf8Text(c.req.raw, 8 * 1024);
  let body: unknown;
  try { body = JSON.parse(source); } catch { throw new ValidateException('商品审核JSON格式错误'); }
  await x.service.save(x.id, body, x.actor);
  return jsonOk(c, [], '审核成功');
}
