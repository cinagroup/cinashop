import type { Context, MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AuthException, HttpApiException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { adminRefundId } from '@/services/admin/AdminRefundReadService';
import type { AdminRefundDecisionActor } from '@/services/admin/AdminRefundDecisionService';
import type { AdminRefundOperationAction } from '@/services/admin/AdminRefundOperationLedger';
import { normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { abandonAdminRefundOperation, executeAdminRefundOperation, lookupAdminRefundOperation } from '@/services/admin/AdminRefundOperationService';

type HttpEnv = { Bindings: Env; Variables: AppVariables };
type C = Context<HttpEnv>;
export const ADMIN_REFUND_OPERATION_PROTOCOL = 'admin-refund-operation-v1';

/** Authenticated legacy Admin URLs fail closed. Never inspect the old body,
 * fabricate a key, redirect/replay it, or infer anything about an earlier send.
 * In-flight invocations of older deployments are outside this boundary. */
export function retiredAdminRefundMutation(c: C) {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  c.header('Pragma', 'no-cache');
  return c.json({ status: 410,
    msg: '旧版管理员退款写入接口已停用。请保留原操作记录并升级后台；结果未知的旧请求须人工核对，不可自动重发。主动/拆单退款的完整迁移尚未完成。',
    data: null }, 410);
}

/** Run before auth, including failures when this router is mounted separately. */
export const privateRefundOperationResponse: MiddlewareHandler<HttpEnv> = async (c, next) => {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  c.header('Pragma', 'no-cache');
  await next();
};

function identity(c: C) {
  const id = c.get('adminId');
  if (!id || id !== c.get('adminInfo')?.id || id !== c.get('socketAuthId')) throw new AuthException('请重新登录');
  const actor: AdminRefundDecisionActor = {
    id, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0,
  };
  // This declaration is only a precondition. Authority always comes from the
  // fresh authenticated principal and the SQL recheck inside each decision.
  if (c.req.header('X-Refund-Operation-Scope') !== `v1:admin:${id}`) {
    throw new HttpApiException('退款操作身份已变化或缺失，请保留原请求并重新登录核对', 412, 412);
  }
  if (new URL(c.req.url).search) throw new ValidateException('退款操作不接受查询参数');
  const key = normalizeOutRequestKey(c.req.header('Idempotency-Key'));
  return { actor, key };
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new ValidateException('退款操作字段无效，请保留原请求并核对客户端版本');
  }
  return value as Record<string, unknown>;
}

async function body(c: C): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type') ?? '')
    || !['', 'identity'].includes((c.req.header('Content-Encoding') ?? '').toLowerCase())) {
    throw new ValidateException('退款操作仅接受 UTF-8 JSON');
  }
  const text = await readBoundedUtf8Text(c.req.raw, 4096);
  try { return JSON.parse(text); }
  catch { throw new ValidateException('退款操作 JSON 无效'); }
}

function version(value: Record<string, unknown>) {
  if (value.version !== ADMIN_REFUND_OPERATION_PROTOCOL) throw new ValidateException('退款操作协议版本无效');
}

async function decisionBody(c: C) {
  const value = await body(c);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('action' in value)
    || !['return', 'refuse', 'refund'].some(action => value.action === action)) throw new ValidateException('退款操作无效');
  const action: AdminRefundOperationAction = value.action === 'return' ? 'return' : value.action === 'refuse' ? 'refuse' : 'refund';
  const input = record(value, action === 'refuse'
    ? ['version', 'action', 'review', 'decision', 'reason'] : ['version', 'action', 'review', 'decision']);
  version(input);
  record(input.review, ['uid', 'storeOrderId', 'storeId', 'supplierId', 'orderId', 'refundPrice']);
  record(input.decision, ['applyType', 'refundType', 'received']);
  return { action, input };
}

export async function execute(c: C) {
  const { actor, key } = identity(c), id = adminRefundId(c.req.param('id'));
  const { action, input } = await decisionBody(c);
  const result = await executeAdminRefundOperation(c.get('container'), c.env, actor, id, key, action, input);
  return jsonOk(c, { version: ADMIN_REFUND_OPERATION_PROTOCOL, receipt: result.receipt,
    replayed: result.replayed, execution: result.execution ?? null }, '原退款操作已核对');
}

/** POST keeps keys out of URLs and uses refund.manage. This handler performs
 * SQL evidence reads only: a missing receipt never means a late sender is safe. */
export async function receipt(c: C) {
  const { actor, key } = identity(c);
  version(record(await body(c), ['version']));
  return jsonOk(c, { version: ADMIN_REFUND_OPERATION_PROTOCOL,
    receipt: await lookupAdminRefundOperation(c.get('container'), actor, key) });
}

export async function abandon(c: C) {
  const { actor, key } = identity(c), id = adminRefundId(c.req.param('id'));
  const { action, input } = await decisionBody(c);
  return jsonOk(c, { version: ADMIN_REFUND_OPERATION_PROTOCOL,
    receipt: await abandonAdminRefundOperation(c.get('container'), actor, id, key, action, input) }, '原退款操作已核对');
}
