import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Hono } from 'hono';
import type { Env } from '../../src/env';
import type { Container } from '../../src/lib/di';
import { WechatPayService } from '../../src/services/wechat/WechatPayService';
import { AlipayTradeQueryService } from '../../src/services/payment/AlipayTradeQueryService';
import type { PaymentProviderQueryRequest } from '../../src/services/payment/PaymentProviderQuery';
import type { PaymentQueryOriginalIdentity } from '../../src/services/payment/PaymentQueryIdentity';

export function paymentQueryKeys() {
  return generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { format: 'pem', type: 'spki' },
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' } });
}
export async function paymentQueryFixture(container: Container, keys: ReturnType<typeof paymentQueryKeys>) {
  const appId = 'wx-local-query', merchantId = '1234567890', payerId = 'frozen-local-payer', aliApp = '2026091900000001';
  const config: Record<string, string> = { cfg_wechat_appid: appId, cfg_routine_appId: appId, cfg_wechat_app_appid: appId,
    cfg_pay_weixin_mchid: merchantId, cfg_pay_weixin_serial_no: 'ABCDEF123456', cfg_site_url: 'https://query.example' };
  const bindings = { ALIPAY_APP_ID: aliApp, ALIPAY_SELLER_ID: merchantId, ALIPAY_PRIVATE_KEY: keys.privateKey, ALIPAY_PUBLIC_KEY: keys.publicKey,
    OFFLINE_PC_RETURN_ORIGIN: 'https://shop.example', OFFLINE_H5_RETURN_ORIGIN: 'https://h5.example',
    WECHAT_MCH_PRIVATE_KEY: keys.privateKey, WECHAT_PLATFORM_PUBLIC_KEY: keys.publicKey, WECHAT_API_V3_KEY: 'a'.repeat(32),
    WECHAT_PLATFORM_PUBLIC_KEY_ID: 'TEST_QUERY_PUBLIC_KEY',
    CONFIG_KV: { get: async (key: string) => config[key] ?? null, put: async () => {}, delete: async () => {} } };
  // Hono accepts partial bindings in tests; the production constructors retain generated Env.
  const app = new Hono<{ Bindings: Env }>();
  let ready: { wechat: WechatPayService; alipay: AlipayTradeQueryService; env: Env } | undefined;
  app.get('/', c => { ready = { wechat: new WechatPayService(container, c.env), alipay: new AlipayTradeQueryService(c.env), env: c.env }; return c.body(null, 204); });
  await app.request('/', {}, bindings);
  if (!ready) throw Error('Query fixture initialization failed');
  const orderNo = 'xx' + 'a'.repeat(30);
  const request = (provider: 'wechat' | 'alipay' = 'wechat'): PaymentProviderQueryRequest => ({ provider,
    profile: provider, orderDomain: 'offline_order', orderNo, expectedAmountCents: 1000, currency: 'CNY' });
  const identity = (provider: 'wechat' | 'alipay' = 'wechat'): PaymentQueryOriginalIdentity => ({
    appId: provider === 'alipay' ? aliApp : appId, merchantId, transactionType: provider === 'alipay' ? 'wap' : 'jsapi',
    payerId: provider === 'alipay' ? '' : payerId });
  const wxBody = (extra: Record<string, unknown> = {}) => ({ appid: appId, mchid: merchantId, out_trade_no: orderNo,
    transaction_id: 'wechat_query_transaction', trade_state: 'SUCCESS', trade_type: 'JSAPI', payer: { openid: payerId },
    amount: { total: 1000, currency: 'CNY' }, success_time: '2026-09-19T12:00:00+08:00', ...extra });
  const aliBody = (extra: Record<string, unknown> = {}) => ({ code: '10000', out_trade_no: orderNo, trade_no: 'alipay_query_transaction',
    trade_status: 'TRADE_SUCCESS', total_amount: '10.00', send_pay_date: '2026-09-19 12:00:00', ...extra });
  const signature = (content: string) => Buffer.from(sign('RSA-SHA256', Buffer.from(content), keys.privateKey)).toString('base64');
  const wechatResponse = (body: unknown = wxBody(), status = 200, timestamp = String(Math.floor(Date.now() / 1000))) => {
    const raw = JSON.stringify(body), nonce = 'test-response-nonce';
    return new Response(raw, { status, headers: { 'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': nonce,
      'Wechatpay-Serial': 'TEST_QUERY_PUBLIC_KEY', 'Wechatpay-Signature': signature(`${timestamp}\n${nonce}\n${raw}\n`) } });
  };
  const alipayResponse = (body: unknown = aliBody()) => {
    const raw = JSON.stringify(body);
    return new Response(`{"alipay_trade_query_response":${raw},"sign":${JSON.stringify(signature(raw))}}`);
  };
  const verifyRequest = (url: string, init: RequestInit) => {
    if (url.startsWith('https://api.mch.weixin.qq.com/')) {
      const auth = new Headers(init.headers).get('Authorization') ?? '';
      const fields = Object.fromEntries([...auth.matchAll(/(\w+)="([^"]+)"/g)].map(match => [match[1], match[2]]));
      const u = new URL(url);
      return init.method === 'GET' && fields.mchid === merchantId && fields.serial_no === 'ABCDEF123456'
        && verify('RSA-SHA256', Buffer.from(`GET\n${u.pathname}${u.search}\n${fields.timestamp}\n${fields.nonce_str}\n\n`),
          keys.publicKey, Buffer.from(fields.signature, 'base64'));
    }
    if (url !== 'https://openapi.alipay.com/gateway.do' || typeof init.body !== 'string') return false;
    const params = new URLSearchParams(init.body), sig = params.get('sign') ?? ''; params.delete('sign');
    const content = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
    return params.get('app_id') === aliApp && params.get('method') === 'alipay.trade.query' && !params.has('app_auth_token')
      && verify('RSA-SHA256', Buffer.from(content), keys.publicKey, Buffer.from(sig, 'base64'));
  };
  return { ...ready, bindings, config, request, identity, wxBody, aliBody, wechatResponse, alipayResponse, signature, verifyRequest };
}
