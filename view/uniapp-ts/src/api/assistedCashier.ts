import { adminRequest } from './adminRequest';
import { validAssistedOrderNo } from './assistedDetail';

export type AssistedPaymentMethod = 'weixin' | 'alipay' | 'cash';
export type AssistedPaymentResult = { kind: 'paid' } | {
  kind: 'qr'; method: 'weixin' | 'alipay'; code: string; amount: string; expiresAt: number;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('收银响应格式无效');
  return value as Record<string, unknown>;
}

function paymentAmount(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,10}\.\d{2}$/.test(value) || Number(value) < 0.01) {
    throw Error('扫码收银金额无效，请核对付款状态');
  }
  return value;
}

function qrCode(value: unknown): string {
  // The upstream payment URL is never embedded in a third-party image URL.
  if (typeof value !== 'string' || value.length < 1 || value.length > 1800 || !/^[\x21-\x7e]+$/.test(value)) {
    throw Error('支付二维码内容无效，请核对付款状态');
  }
  return value;
}

export async function apiAssistedPay(orderNo: string, uid: number, method: AssistedPaymentMethod,
  expectedAmount: string): Promise<AssistedPaymentResult> {
  if (!validAssistedOrderNo(orderNo) || !Number.isSafeInteger(uid) || uid < 0 || uid > 2147483647
    || !['weixin', 'alipay', 'cash'].includes(method) || !/^\d{1,10}\.\d{2}$/.test(expectedAmount)) {
    throw Error('收银请求参数无效');
  }
  const data = object(await adminRequest('POST', `admin/order/pay/${uid}`,
    { uni: orderNo, paytype: method, expected_pay_price: expectedAmount }, 'order.assisted'));
  const result = object(data.result);
  if (result.order_id !== orderNo) throw Error('收银结果不属于当前订单，请核对付款状态');
  if (data.status === 'SUCCESS') return { kind: 'paid' };
  if ((method === 'weixin' && data.status !== 'WECHAT_PC_PAY')
    || (method === 'alipay' && data.status !== 'ALIPAY_PAY') || method === 'cash') {
    throw Error('收银结果与支付方式不一致，请核对付款状态');
  }
  const config = object(result.jsConfig);
  const code = qrCode(method === 'weixin' ? config.code_url : config.qrCode);
  const invalid = config.invalid;
  const now = Math.floor(Date.now() / 1000);
  if (typeof invalid !== 'number' || !Number.isSafeInteger(invalid) || invalid <= now || invalid > now + 600) {
    throw Error('支付二维码已失效，请核对付款状态');
  }
  return { kind: 'qr', method, code, amount: paymentAmount(result.pay_price), expiresAt: invalid * 1000 };
}
