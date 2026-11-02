import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminOrderFulfillmentAssignmentService } from '@/services/admin/AdminOrderFulfillmentAssignmentService';
import { assignmentNoQuery } from '@/services/admin/AdminOrderFulfillmentAssignmentInput';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  const declaration = c.env.ADMIN_FULFILLMENT_ASSIGNMENT_RUNTIME;
  if (!declaration) throw new ServiceUnavailableException('后台履约分配尚未配置正式运行声明');
  let service: AdminOrderFulfillmentAssignmentService;
  try { service = new AdminOrderFulfillmentAssignmentService(c.get('container'), declaration); }
  catch (cause) { throw Object.assign(new ServiceUnavailableException('后台履约分配运行声明不完整，请先核对维护回执'), { cause }); }
  return { service, actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '',
    expiresAt: c.get('socketTokenExp') ?? 0 }, query: new URL(c.req.url).searchParams };
}
export async function review(c: C) {
  const x = context(c); return jsonOk(c, await x.service.review(c.req.param('id'), x.query, x.actor));
}
export async function stores(c: C) {
  const x = context(c); return jsonOk(c, await x.service.stores(x.query, x.actor));
}
export async function receipt(c: C) {
  const x = context(c); return jsonOk(c, await x.service.receipt(c.req.param('operationId'), x.query, x.actor));
}
export async function commit(c: C) {
  const x = context(c); assignmentNoQuery(x.query);
  const raw = await readBoundedUtf8Text(c.req.raw, 4096);
  let input: unknown;
  try { input = parseLevelActivationJson(raw); }
  catch { throw new ValidateException('履约分配 JSON 无效、字段重复或层级过深'); }
  return jsonOk(c, await x.service.commit(input, x.actor));
}
