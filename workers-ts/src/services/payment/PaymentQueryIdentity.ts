import type { PaymentProviderQueryRequest } from './PaymentProviderQuery';
import { ValidateException } from '@/utils/errors';

/** Immutable server-side payment selection, never a customer request body. */
export interface PaymentQueryOriginalIdentity {
  appId: string;
  merchantId: string;
  transactionType: 'h5' | 'jsapi' | 'wap';
  payerId: string;
}

/** Query evidence is NOT a notification and has no provider notification ID.
 * Alipay's query does not return app_id/seller_id: its scope is the authenticated
 * direct-merchant request, including the operator-declared app/seller mapping.
 */
export type PaymentQueryIdentityEvidence =
  | { source: 'wechat-signed-query'; appId: string; merchantId: string; payerId?: string }
  | { source: 'alipay-direct-request-scope'; appId: string; merchantId: string };

export function validatePaymentQueryIdentity(
  request: PaymentProviderQueryRequest,
  identity: PaymentQueryOriginalIdentity | undefined,
): void {
  if (typeof request.orderNo !== 'string' || !/^[A-Za-z0-9_-]{2,64}$/.test(request.orderNo)
    || !Number.isSafeInteger(request.expectedAmountCents) || request.expectedAmountCents <= 0
    || request.expectedAmountCents > 2_147_483_647 || request.currency !== 'CNY') {
    throw new ValidateException('支付查单请求无效');
  }
  const offline = request.orderDomain === 'offline_order' || /^xx[0-9a-f]{30}$/.test(request.orderNo);
  if (offline && (request.orderDomain !== 'offline_order' || !identity)) {
    throw new ValidateException('线下消费查单必须核验原支付身份');
  }
  if (!identity) return;
  if (typeof identity.appId !== 'string' || typeof identity.merchantId !== 'string' || typeof identity.payerId !== 'string'
    || !/^[A-Za-z0-9_-]{1,64}$/.test(identity.appId) || !/^[A-Za-z0-9_-]{1,64}$/.test(identity.merchantId)
    || (identity.transactionType === 'jsapi' ? !/^[A-Za-z0-9_-]{1,100}$/.test(identity.payerId) : identity.payerId !== '')
    || (request.provider === 'alipay'
      ? request.profile !== 'alipay' || identity.transactionType !== 'wap'
      : !['wechat', 'routine'].includes(request.profile) || !['jsapi', 'h5'].includes(identity.transactionType)
        || (request.profile === 'routine' && identity.transactionType !== 'jsapi'))) {
    throw new ValidateException('支付查单原身份无效');
  }
}

export function assertPaymentQueryCredentialIdentity(
  identity: PaymentQueryOriginalIdentity | undefined,
  appId: string,
  merchantId: string | undefined,
): void {
  if (identity && (identity.appId !== appId || identity.merchantId !== merchantId)) {
    throw new ValidateException('当前查单凭据与原支付商户身份不匹配');
  }
}
