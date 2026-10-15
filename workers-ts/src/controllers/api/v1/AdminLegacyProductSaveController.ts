import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminLegacyProductSaveService } from '@/services/admin/AdminLegacyProductSaveService';
import { readAdminLegacyProductBody } from '@/services/admin/AdminLegacyProductInput';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { jsonFail, jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
export async function save(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  const rawId = c.req.param('id') ?? '';
  if (!/^(?:0|[1-9]\d{0,9})$/.test(rawId) || Number(rawId) > 2_147_483_647) throw new ValidateException('商品ID错误');
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('商品保存不接受查询参数');
  const body = await readAdminLegacyProductBody(c.req.raw);
  const container = c.get('container');
  const service = new AdminLegacyProductSaveService(container, { async dispatch(outboxId) {
    await new OrderOutboxService(container, c.env).dispatchPending(1, outboxId);
  } });
  const actor = { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 };
  try {
    const result = await service.save(Number(rawId), body, actor);
    // Source Json.success(string) returns an empty data array; both old and
    // current callers can rely on the message without a new provider contract.
    return jsonOk(c, [], result.message);
  } catch (error) {
    // Only classified rolled-back refusals become old-Axios business errors.
    // Unknown failures remain unknown; they must not become replay-safe 400s.
    if (error instanceof HttpApiException && [409, 503].includes(error.httpStatus)) return jsonFail(c, error.message);
    throw error;
  }
}
