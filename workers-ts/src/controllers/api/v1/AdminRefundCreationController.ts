import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import type { AdminRefundDecisionActor } from '@/services/admin/AdminRefundDecisionService';
import { ADMIN_REFUND_CREATION_VERSION, parseAdminRefundCreation } from '@/services/admin/AdminRefundCreationProtocol';
import { abandonAdminRefundCreation, createAdminRefundApplication, executeAdminProactiveRefund,
  lookupAdminRefundCreation } from '@/services/admin/AdminRefundCreationService';
import { normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { AuthException, HttpApiException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function identity(c: C) {
  const id = c.get('adminId');
  if (!id || id !== c.get('adminInfo')?.id || id !== c.get('socketAuthId')) throw new AuthException('请重新登录');
  if (c.req.header('X-Refund-Operation-Scope') !== `v1:admin:${id}`) {
    throw new HttpApiException('主动退款身份已变化或缺失，请保留原请求并重新登录核对', 412, 412);
  }
  if (new URL(c.req.url).search) throw new ValidateException('主动退款不接受查询参数');
  const actor: AdminRefundDecisionActor = {
    id, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0,
  };
  return { actor, key: normalizeOutRequestKey(c.req.header('Idempotency-Key')) };
}

async function body(c: C, maxBytes = 8192): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type') ?? '')
    || !['', 'identity'].includes((c.req.header('Content-Encoding') ?? '').toLowerCase())) {
    throw new ValidateException('主动退款仅接受 UTF-8 JSON');
  }
  const text = await readBoundedUtf8Text(c.req.raw, maxBytes);
  try { return JSON.parse(text); }
  catch { throw new ValidateException('主动退款 JSON 无效'); }
}

/** Optional SQL-only stage. A replayed receipt may already have progressed
 * financially; this endpoint itself never invokes the financial executor. */
export async function create(c: C) {
  const { actor, key } = identity(c), input = parseAdminRefundCreation(await body(c));
  const creation = await createAdminRefundApplication(c.get('container'), actor, key, input);
  return jsonOk(c, { version: ADMIN_REFUND_CREATION_VERSION, receipt: creation.receipt,
    replayed: creation.replayed }, '原创建操作已核对；本次接口不执行资金处理');
}

/** Creation commits before financial admission/settlement. An HTTP failure
 * can follow either commit; never catch it as proof that creation rolled back.
 * Explicit recovery must retain the original actor/key/body, not requote it. */
export async function execute(c: C) {
  const { actor, key } = identity(c), input = parseAdminRefundCreation(await body(c));
  const result = await executeAdminProactiveRefund(c.get('container'), c.env, actor, key, input);
  return jsonOk(c, { version: ADMIN_REFUND_CREATION_VERSION,
    creation: { receipt: result.creation.receipt, replayed: result.creation.replayed },
    operation: result.operation ? { receipt: result.operation.receipt, replayed: result.operation.replayed,
      execution: result.operation.execution ?? null } : null }, '原主动退款操作已核对；是否完成以回执为准');
}

/** POST keeps the original key out of URLs. This reads creation evidence only,
 * not financial state; null does not fence a delayed original sender. */
export async function receipt(c: C) {
  const { actor, key } = identity(c), value = await body(c, 512);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || !Object.hasOwn(value, 'version') || !('version' in value) || value.version !== ADMIN_REFUND_CREATION_VERSION) {
    throw new ValidateException('创建回执查询协议无效');
  }
  return jsonOk(c, { version: ADMIN_REFUND_CREATION_VERSION,
    receipt: await lookupAdminRefundCreation(c.get('container'), actor, key) });
}

/** Only an uncreated original key can be fenced. An existing created receipt
 * wins unchanged; this is not cancellation of its application or payment. */
export async function abandon(c: C) {
  const { actor, key } = identity(c), input = parseAdminRefundCreation(await body(c));
  return jsonOk(c, { version: ADMIN_REFUND_CREATION_VERSION,
    receipt: await abandonAdminRefundCreation(c.get('container'), actor, key, input) }, '原创建操作已核对；不等同于取消已创建退款或支付');
}
