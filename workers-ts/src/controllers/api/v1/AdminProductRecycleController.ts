import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminProductRecycleService, adminProductRecycleId } from '@/services/admin/AdminProductRecycleService';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { jsonFail, jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
async function change(c: C, mode: 'toggle' | 'recycle') {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  const id = adminProductRecycleId(c.req.param('id'));
  const query = new URL(c.req.url).searchParams;
  let expectedIsDel: 0 | 1 | undefined;
  if (query.size) {
    const values = query.getAll('expected_is_del');
    if (mode !== 'toggle' || query.size !== 1 || values.length !== 1 || !['0', '1'].includes(values[0])) throw new ValidateException('商品回收查询参数错误');
    expectedIsDel = Number(values[0]) as 0 | 1;
  }
  // The genuine old tableDelApi sends data.ids === '', i.e. an empty body.
  // No JSON/body target or extra input may override the canonical path ID.
  if (await readBoundedUtf8Text(c.req.raw, 1024) !== '') throw new ValidateException('商品回收只接受空请求体');
  const container = c.get('container');
  const service = new AdminProductRecycleService(container, { async dispatch(outboxId) { await new OrderOutboxService(container, c.env).dispatchPending(1, outboxId); } });
  const actor = { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 };
  let result: Awaited<ReturnType<AdminProductRecycleService['change']>>;
  try { result = await service.change(id, actor, { mode, expectedIsDel }); }
  catch (error) {
    // The genuine old Axios interceptor rejects status400 envelopes only;
    // its default branch silently resolves undefined for body404/409/503.
    // Preserve that empty-query consumer for definite rolled-back refusals.
    // Modern guarded requests retain explicit HTTP conflicts. Unknown errors
    // still reach the normal handler and must never look safe to replay.
    if (mode === 'toggle' && expectedIsDel === undefined && error instanceof HttpApiException && [409,503].includes(error.httpStatus)) return jsonFail(c, error.message);
    throw error;
  }
  return mode === 'toggle' ? jsonOk(c, [], result.message) : jsonOk(c, null, '删除成功');
}
export async function toggle(c: C) { return change(c, 'toggle'); }
export async function recycleAlias(c: C) { return change(c, 'recycle'); }
