import type { Env } from '@/env';
import type { Container } from '@/lib/di';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { SystemConfigService } from '@/services/system/SystemConfigService';
import { formatAlipayTimestamp, signAlipayParams, verifyAlipayNotification, type AlipayParams } from '@/utils/alipay';
import { ValidateException } from '@/utils/errors';
import type { OfflineExternalPaymentIdentity } from '@/services/order/OfflineOrderPaymentSelectionService';
import { prepareOfflineReturn, type OfflineReturnClient } from './OfflinePaymentReturn';

import { assertOfflineProviderRequest, checkedOfflineHttps, validateOfflinePaymentTicket,
  type OfflinePaymentTicket, type PreparedOfflineProvider } from './OfflinePaymentProviderContract';

/** Load effective switches/credentials once BEFORE reserving an outgoing attempt.
 * Config/secret edits after this point cannot redirect that request to a new merchant.
 */
export async function prepareOfflinePaymentProvider(container: Container, env: Env,
  provider: 'wechat' | 'alipay', profile: 'wechat' | 'routine' | 'alipay',
  currentConfig?: Readonly<Record<string, string>>, returnClient: OfflineReturnClient = 'pc'): Promise<PreparedOfflineProvider> {
  if (provider === 'wechat') {
    if (profile !== 'wechat' && profile !== 'routine') throw new ValidateException('线下微信渠道无效');
    return new WechatPayService(container, env).prepareOfflineOrder(profile, currentConfig, returnClient);
  }
  if (provider !== 'alipay' || profile !== 'alipay') throw new ValidateException('线下支付渠道无效');
  const appId = env.ALIPAY_APP_ID ?? '', merchantId = env.ALIPAY_SELLER_ID ?? '', privateKey = env.ALIPAY_PRIVATE_KEY ?? '';
  const publicKey = env.ALIPAY_PUBLIC_KEY ?? '', notifyUrl = env.ALIPAY_NOTIFY_URL ?? '', returnUrl = prepareOfflineReturn(env,returnClient);
  const config = currentConfig ?? await new SystemConfigService(container, env).getMany(['ali_pay_status']);
  if (config.ali_pay_status !== '1') throw new ValidateException('支付宝支付未开启');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(appId) || !/^[A-Za-z0-9_-]{1,64}$/.test(merchantId)
    || !publicKey.includes('BEGIN PUBLIC KEY')) throw new ValidateException('支付宝支付配置不完整');
  checkedOfflineHttps(notifyUrl);
  // Validate the signing key before committing an ambiguous outgoing attempt.
  const probe = await signAlipayParams({ method: 'offline_preflight' }, privateKey);
  // Check SPKI import/algorithm, not equality with the separate merchant key.
  await verifyAlipayNotification({ method: 'offline_preflight', sign: probe }, publicKey);
  const identity: OfflineExternalPaymentIdentity = { provider, profile, appId, merchantId };
  return { identity: { ...identity }, initiate: async input => {
    const request = { ...input }; assertOfflineProviderRequest(request);
    if (request.transactionType !== 'wap') throw new ValidateException('支付宝线下交易类型无效');
    const cents = BigInt(request.amountCents);
    const params: AlipayParams = { app_id: appId, method: 'alipay.trade.wap.pay', charset: 'utf-8', sign_type: 'RSA2',
      timestamp: formatAlipayTimestamp(new Date()), version: '1.0', notify_url: notifyUrl, return_url: returnUrl(request.orderNo),
      biz_content: JSON.stringify({ out_trade_no: request.orderNo, total_amount: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`,
        subject: 'CinaShop线下消费', product_code: 'QUICK_WAP_WAY', passback_params: 'offline_order', quit_url: returnUrl(request.orderNo) }) };
    params.sign = await signAlipayParams(params, privateKey);
    const ticket: OfflinePaymentTicket = { kind: 'alipay-wap', url: `https://openapi.alipay.com/gateway.do?${new URLSearchParams(params)}` };
    validateOfflinePaymentTicket(ticket, identity, request.transactionType, request); return ticket;
  } };
}
