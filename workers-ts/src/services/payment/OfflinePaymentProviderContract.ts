import { isIP } from 'node:net';
import { ValidateException } from '@/utils/errors';
import { isOfflineReturnUrl, validOfflineTicketReturn } from '../../../../view/common/offlineReturn';
import type { OfflineExternalPaymentIdentity } from '@/services/order/OfflineOrderPaymentSelectionService';

export type OfflinePaymentTicket =
  | { kind: 'wechat-h5'; url: string }
  | { kind: 'wechat-jsapi'; appId: string; timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string }
  | { kind: 'alipay-wap'; url: string };
export interface OfflineProviderRequest {
  orderNo: string; amountCents: number; transactionType: 'h5' | 'jsapi' | 'wap'; payerId: string; clientIp: string;
}
export interface PreparedOfflineProvider {
  identity: OfflineExternalPaymentIdentity;
  /** Request-local credential closure, never a DTO, queue payload or global cache. */
  initiate(request: OfflineProviderRequest): Promise<OfflinePaymentTicket>;
}

export function assertOfflineProviderRequest(p: OfflineProviderRequest) {
  if (!/^xx[0-9a-f]{30}$/.test(p.orderNo) || !Number.isSafeInteger(p.amountCents) || p.amountCents <= 0
    || p.amountCents > 2_147_483_647 || !['h5', 'jsapi', 'wap'].includes(p.transactionType)
    || (p.transactionType === 'jsapi' ? !/^[A-Za-z0-9_-]{1,100}$/.test(p.payerId) : p.payerId !== '')) {
    throw new ValidateException('线下支付请求身份或金额无效');
  }
  if (p.transactionType === 'h5') {
    if (typeof p.clientIp !== 'string' || p.clientIp.length > 45 || !isIP(p.clientIp)) {
      throw new ValidateException('微信H5必须提供真实客户端IP');
    }
    // URL normalizes expanded/mapped IPv6 before excluding unspecified/loopback.
    const ip = isIP(p.clientIp) === 6 ? new URL(`https://[${p.clientIp}]/`).hostname.toLowerCase() : p.clientIp;
    if (/^(127\.|0\.)/.test(ip) || ['[::]', '[::1]'].includes(ip) || /^\[::ffff:(?:7f[0-9a-f]{2}:|[0-9a-f]{1,2}:)/.test(ip)) {
      throw new ValidateException('微信H5必须提供真实客户端IP');
    }
  }
}
export function checkedOfflineHttps(value: string, max = 256) {
  try {
    if (typeof value !== 'string' || !value.startsWith('https://') || value.length > max || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error();
    return url;
  } catch { throw new ValidateException('线下支付地址无效'); }
}
/** Runtime check for stored JSON as well as freshly returned provider data. */
export function validateOfflinePaymentTicket(ticket: unknown, identity: OfflineExternalPaymentIdentity,
  transactionType: string, expected?: { orderNo: string; amountCents: number }): asserts ticket is OfflinePaymentTicket {
  if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) throw new ValidateException('线下支付入口无效');
  const t = ticket as Record<string, unknown>;
  if (new TextEncoder().encode(JSON.stringify(t)).byteLength > 8192) throw new ValidateException('线下支付入口超出范围');
  if (t.kind === 'wechat-h5' && identity.provider === 'wechat' && transactionType === 'h5' && typeof t.url === 'string') {
    const url = checkedOfflineHttps(t.url, 4096);
    if (Object.keys(t).length !== 2 || url.hostname !== 'wx.tenpay.com' || url.port
      || url.pathname !== '/cgi-bin/mmpayweb-bin/checkmweb' || !url.search
      || (expected && !validOfflineTicketReturn(url, 'redirect_url', expected.orderNo))) throw new ValidateException('微信H5支付地址无效');
    return;
  }
  if (t.kind === 'alipay-wap' && identity.provider === 'alipay' && transactionType === 'wap' && typeof t.url === 'string') {
    const url = checkedOfflineHttps(t.url, 8192);
    if (Object.keys(t).length !== 2 || url.origin !== 'https://openapi.alipay.com' || url.pathname !== '/gateway.do'
      || url.searchParams.get('app_id') !== identity.appId || url.searchParams.get('method') !== 'alipay.trade.wap.pay'
      || url.searchParams.get('sign_type') !== 'RSA2' || !url.searchParams.get('sign')) throw new ValidateException('支付宝支付地址无效');
    if (expected) {
      if (!validOfflineTicketReturn(url, 'return_url', expected.orderNo)) throw new ValidateException('支付宝返回地址与原订单不一致');
      const content: unknown = JSON.parse(url.searchParams.get('biz_content') ?? 'null');
      if (!content || typeof content !== 'object' || Array.isArray(content)) throw new ValidateException('支付宝支付业务字段无效');
      const business = content as Record<string, unknown>, cents = BigInt(expected.amountCents);
      if (business.quit_url !== undefined && (typeof business.quit_url !== 'string' || !isOfflineReturnUrl(business.quit_url, expected.orderNo))) {
        throw new ValidateException('支付宝退出地址与原订单不一致');
      }
      if (business.out_trade_no !== expected.orderNo || business.total_amount !== `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
        || business.product_code !== 'QUICK_WAP_WAY' || business.passback_params !== 'offline_order') {
        throw new ValidateException('支付宝支付入口与原订单不一致');
      }
    }
    return;
  }
  if (t.kind === 'wechat-jsapi' && identity.provider === 'wechat' && transactionType === 'jsapi') {
    if (Object.keys(t).length !== 7 || t.appId !== identity.appId || t.signType !== 'RSA'
      || typeof t.timeStamp !== 'string' || !/^\d{1,12}$/.test(t.timeStamp)
      || typeof t.nonceStr !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(t.nonceStr)
      || typeof t.package !== 'string' || !/^prepay_id=[A-Za-z0-9_-]{1,128}$/.test(t.package)
      || typeof t.paySign !== 'string' || !/^[A-Za-z0-9+/]{64,1024}={0,2}$/.test(t.paySign)) {
      throw new ValidateException('微信JSAPI支付入口无效');
    }
    return;
  }
  throw new ValidateException('线下支付入口与原路径不一致');
}
