import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminProductStockService } from '@/services/admin/AdminProductStockService';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { jsonOk } from '@/utils/json';
import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  const value = c.req.param('id');
  if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 2_147_483_647) throw new ValidateException('缺少商品ID');
  return { id: Number(value), actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 },
    service: new AdminProductStockService(c.get('container'), c.env.APP_KEY, { async dispatch(outboxId) { await new OrderOutboxService(c.get('container'), c.env).dispatchPending(1, outboxId); } }) };
}
export async function attrs(c: C) {
  const x = context(c);
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('库存规格读取不接受查询参数');
  return jsonOk(c, await x.service.attrs(x.id, x.actor));
}
export async function save(c: C) {
  const x = context(c);
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('库存调整不接受查询参数');
  let body: unknown;
  const source = await readBoundedUtf8Text(c.req.raw, 1024 * 1024);
  try { body = JSON.parse(source); } catch { throw new ValidateException('请重新修改规格库存'); }
  return jsonOk(c, await x.service.save(x.id, body, x.actor));
}
