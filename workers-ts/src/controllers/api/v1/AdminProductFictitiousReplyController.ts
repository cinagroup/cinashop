import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminProductFictitiousReplyService, fictitiousProductId } from '@/services/admin/AdminProductFictitiousReplyService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  return { service: new AdminProductFictitiousReplyService(c.get('container'), c.env.APP_KEY), query: new URL(c.req.url).searchParams,
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
export async function form(c: C) {
  const x = context(c); return jsonOk(c, await x.service.form(fictitiousProductId(c.req.param('product_id'), true), x.query, x.actor));
}
export async function products(c: C) { const x = context(c); return jsonOk(c, await x.service.products(x.query, x.actor)); }
export async function create(c: C) {
  const x = context(c);
  if (x.query.size) throw new ValidateException('虚拟评价写入不接受查询参数');
  const source = await readBoundedUtf8Text(c.req.raw, 64 * 1024);
  let body: unknown;
  try { body = JSON.parse(source) as unknown; } catch { throw new ValidateException('虚拟评价JSON格式错误'); }
  await x.service.create(body, x.actor); return c.json({ status: 200, msg: '添加成功!' });
}
