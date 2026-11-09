import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';
import { ValidateException } from '@/utils/errors';
import { rechargeRefundId } from './RechargeRefundMoney';

export const RECHARGE_REFUND_VERSION = 'admin-recharge-refund-v1' as const;
export interface RechargeRefundRequest {
  readonly version: typeof RECHARGE_REFUND_VERSION;
  readonly rechargeId: number;
  readonly quoteFingerprint: string;
  readonly recoverGift: boolean;
}
export interface RechargeRefundIdentity {
  readonly adminId: number;
  readonly requestKey: string;
  readonly requestHash: string;
  readonly request: Readonly<RechargeRefundRequest>;
}

/** A recharge has its own identity namespace. A physical-order refund id,
 * client amount, UID, admin id or current AppID is not accepted in this body. */
export function captureRechargeRefundRequest(value: unknown): Readonly<RechargeRefundRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('充值退款请求无效');
  const keys = ['version', 'rechargeId', 'quoteFingerprint', 'recoverGift'];
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !('value' in fields[key]))) {
    throw new ValidateException('充值退款请求字段无效');
  }
  const version = fields.version.value, rechargeId = rechargeRefundId(fields.rechargeId.value);
  const quoteFingerprint = fields.quoteFingerprint.value, recoverGift = fields.recoverGift.value;
  if (version !== RECHARGE_REFUND_VERSION || typeof recoverGift !== 'boolean'
    || typeof quoteFingerprint !== 'string' || quoteFingerprint.length !== 64 || !/^[a-f0-9]{64}$/.test(quoteFingerprint)) {
    throw new ValidateException('充值退款版本、报价或赠送额选项无效');
  }
  return Object.freeze({ version, rechargeId, quoteFingerprint, recoverGift });
}

/** adminId is supplied by authenticated request context. Authentication and
 * fresh SQL permission checks remain the execution service's responsibility. */
export async function rechargeRefundIdentity(adminId: number, requestKey: unknown,
  value: unknown): Promise<Readonly<RechargeRefundIdentity>> {
  adminId = rechargeRefundId(adminId);
  const key = normalizeOutRequestKey(requestKey), request = captureRechargeRefundRequest(value);
  const requestHash = await outRequestHash({ adminId, ...request });
  return Object.freeze({ adminId, requestKey: key, requestHash, request });
}
