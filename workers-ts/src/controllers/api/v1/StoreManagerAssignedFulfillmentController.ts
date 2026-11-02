import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { StoreManagerAssignedFulfillmentService } from '@/services/store/StoreManagerAssignedFulfillmentService';
import { managerOperationActor, managerOperationContext } from './StoreManagerOrderOperationController';
import { assignmentNoQuery } from '@/services/order/FulfillmentAssignmentProtocol';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function service(c: C) {
  const declaration = c.env.MANAGER_FULFILLMENT_ASSIGNMENT_RUNTIME;
  if (!declaration) throw new ServiceUnavailableException('门店分配履约尚未配置正式运行声明');
  try { return new StoreManagerAssignedFulfillmentService(c.get('container'), c.env, declaration); }
  catch (cause) { throw Object.assign(new ServiceUnavailableException('门店分配履约运行声明不完整，请先核对维护回执'), { cause }); }
}
export async function review(c: C) {
  return jsonOk(c, await service(c).review(c.req.param('id'), new URL(c.req.url).searchParams, managerOperationActor(c)));
}
export async function inbox(c: C) {
  return jsonOk(c, await service(c).inbox(new URL(c.req.url).searchParams, managerOperationActor(c)));
}
export async function receipt(c: C) {
  return jsonOk(c, await service(c).receipt(c.req.param('requestKey'), new URL(c.req.url).searchParams, managerOperationActor(c)));
}
export async function commit(c: C) {
  assignmentNoQuery(new URL(c.req.url).searchParams);
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(c.req.header('Content-Type') ?? '')
    || !['','identity'].includes((c.req.header('Content-Encoding') ?? '').toLowerCase()))
    throw new ValidateException('分配履约仅接受无查询参数的 UTF-8 JSON');
  const raw = await readBoundedUtf8Text(c.req.raw, 8192);
  let input: unknown;
  try { input = parseLevelActivationJson(raw); }
  catch { throw new ValidateException('分配履约 JSON 无效、字段重复或层级过深'); }
  return jsonOk(c, await service(c).commit(input, managerOperationContext(c)));
}
