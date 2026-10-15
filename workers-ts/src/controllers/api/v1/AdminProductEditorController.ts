import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminLegacyProductSaveService } from '@/services/admin/AdminLegacyProductSaveService';
import { AdminLegacyProductReadService } from '@/services/admin/AdminLegacyProductReadService';
import { readAdminLegacyProductBody } from '@/services/admin/AdminLegacyProductInput';
import { AdminProductEditorOperationService, prepareProductEditorCopySave, prepareProductEditorSave } from '@/services/admin/AdminProductEditorReceipt';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function actor(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('商品编辑不接受查询参数');
  return { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 };
}
function target(c: C) {
  const value = c.req.param('id') ?? '';
  if (!/^(?:0|[1-9]\d{0,9})$/.test(value) || Number(value) > 2147483647) throw new ValidateException('商品ID错误');
  return Number(value);
}
export async function detail(c: C) {
  const identity = actor(c);
  return jsonOk(c, await new AdminLegacyProductReadService(c.get('container'), c.env.APP_KEY)
    .detail(target(c), new URLSearchParams(), identity, { editorContract: true }));
}
export async function copyDetail(c: C) {
  const identity = actor(c), sourceId = target(c);
  if (!sourceId) throw new ValidateException('复制来源ID错误');
  return jsonOk(c, await new AdminLegacyProductReadService(c.get('container'), c.env.APP_KEY)
    .detail(sourceId, new URLSearchParams(), identity, { editorContract: true, copy: true }));
}
async function persist(c: C, copy: boolean) {
  const identity = actor(c), routeId = target(c), body = await readAdminLegacyProductBody(c.req.raw);
  const prepared = copy ? prepareProductEditorCopySave(body, routeId, identity, c.env.APP_KEY)
    : prepareProductEditorSave(body, routeId, identity, c.env.APP_KEY);
  const container = c.get('container');
  const service = new AdminLegacyProductSaveService(container, { async dispatch(outboxId) {
    await new OrderOutboxService(container, c.env).dispatchPending(1, outboxId);
  } }, c.env.APP_KEY);
  const saved = await service.save(prepared.intent.requestedId, prepared.product, identity, { editorOperation: prepared.intent });
  return jsonOk(c, saved.receipt, saved.message);
}
export async function save(c: C) { return persist(c, false); }
export async function copySave(c: C) { return persist(c, true); }
export async function receipt(c: C) {
  const identity = actor(c);
  return jsonOk(c, await new AdminProductEditorOperationService(c.get('container'))
    .receipt(c.req.param('operationId'), identity));
}
export async function resolve(c: C) {
  const identity = actor(c);
  const value = parseLevelActivationJson(await readBoundedUtf8Text(c.req.raw, 4096));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('商品操作恢复正文无效');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'requested_id'))
    throw new ValidateException('商品操作恢复仅接受目标ID');
  return jsonOk(c, await new AdminProductEditorOperationService(c.get('container'))
    .resolve(c.req.param('operationId'), body.requested_id, identity));
}
