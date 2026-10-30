import { createCipheriv, sign, verify } from 'node:crypto';
import { notInArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, type Container } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { getPaymentReadinessSnapshot, evaluateWechatRefundReadiness } from '@/services/payment/PaymentReadinessService';
import { buildNativeAppPaySign } from '@/utils/wechat-crypto';
import { financeMemoryPostgres } from './helpers/financePostgres';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

const authority = vi.hoisted(() => ({ read: vi.fn(), initiate: vi.fn(), confirm: vi.fn(), provider: vi.fn(), query: vi.fn(), refund: vi.fn(), refundRequest: vi.fn() }));
vi.mock('@/services/payment/NativeAppRefundProviderAuthority', () => ({
  assertNativeAppRefundProviderRequest: authority.refundRequest,
}));
vi.mock('@/services/payment/NativeAppPaymentAuthority', () => ({
  readNativeAppPaymentAccount: authority.read,
  recordNativeAppPaymentInitiation: authority.initiate,
  confirmNativeAppPaymentInitiation: authority.confirm,
  recordNativeAppProviderEvidence: authority.provider,
  assertNativeAppQueryAccount: authority.query,
  assertNativeAppRefundAccount: authority.refund,
}));

const A = 'wxnativeA0000001', M = '1900000101', ORDER = 'native_transport_order', PREPAY = 'native_prepay_001';
const STAMP = 'a'.repeat(64), SERIAL = 'LOCAL_PLATFORM_KEY', V3KEY = 'n'.repeat(32);
let fixture: Awaited<ReturnType<typeof financeMemoryPostgres>>;
let keys: ReturnType<typeof paymentQueryKeys>, env: Env, service: WechatPayService, container: Container;
const config = () => ({ wechat_appid: 'wxofficial000001', routine_appId: 'wxroutine000001', pay_weixin_mchid: M,
  pay_weixin_serial_no: 'ABCDEF123456', site_url: 'https://owned.example', pay_weixin_open: '1',
  balance_func_status: '1', yue_pay_status: '1' });
async function seedConfig(values: Readonly<Record<string, string>>) {
  await fixture.db.delete(systemConfig);
  await fixture.db.insert(systemConfig).values(Object.entries(values).map(([menuName, value], index) => ({
    id: index + 1, menuName, value: JSON.stringify(value), isStore: 0,
  })));
}
const body = (extra: Record<string, unknown> = {}) => ({ appid: A, mchid: M, out_trade_no: ORDER,
  transaction_id: 'native_transaction_001', trade_type: 'APP', trade_state: 'SUCCESS',
  amount: { total: 1250, currency: 'CNY' }, success_time: '2026-10-27T12:00:00+08:00', ...extra });
function signature(content: string) { return Buffer.from(sign('RSA-SHA256', Buffer.from(content), keys.privateKey)).toString('base64'); }
function response(value: unknown, status = 200) {
  const raw = JSON.stringify(value), timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'owned_response_nonce';
  return new Response(raw, { status, headers: { 'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': nonce,
    'Wechatpay-Serial': SERIAL, 'Wechatpay-Signature': signature(`${timestamp}\n${nonce}\n${raw}\n`) } });
}
function notification(value: Record<string, unknown>, originalType: 'transaction' | 'refund' = 'transaction') {
  const nonce = 'native_nonce', aad = 'transaction';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(V3KEY), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const raw = JSON.stringify({ id: 'native_transport_event', resource_type: 'encrypt-resource', resource: {
    algorithm: 'AEAD_AES_256_GCM', original_type: originalType, nonce, associated_data: aad, ciphertext,
  } });
  const timestamp = String(Math.floor(Date.now() / 1000)), outerNonce = 'owned_callback_nonce';
  return { raw, headers: { 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': outerNonce,
    'wechatpay-serial': SERIAL, 'wechatpay-signature': signature(`${timestamp}\n${outerNonce}\n${raw}\n`) } };
}
const create = () => service.createOrder({ profile: 'app', type: 'app', outTradeNo: ORDER,
  description: 'Owned local transport fixture', amount: 12.5, attach: 'product' });
const query = () => service.queryOrder({ provider: 'wechat', profile: 'app', orderDomain: 'store_order',
  orderNo: ORDER, expectedAmountCents: 1250, currency: 'CNY' });

/** Real SQL public configuration, local RSA/AES and signed HTTP bytes; Native
 * App authority primitives remain mocked and covered by restricted PG16 tests.
 * No request reaches WeChat, and no native SDK or settlement is exercised. */
describe('Native App payment transport with actual local cryptography', () => {
  beforeAll(async () => { keys = paymentQueryKeys(); fixture = await financeMemoryPostgres([systemConfig]); });
  afterAll(async () => { if (fixture) await fixture.close(); });
  beforeEach(async () => {
    await fixture.reset();
    await seedConfig(config());
    container = createContainerFromDb(fixture.db);
    for (const fn of Object.values(authority)) fn.mockReset();
    authority.read.mockResolvedValue({ appId: A, merchantId: M, stamp: STAMP });
    authority.initiate.mockImplementation(async (_container: unknown, _env: unknown, input: unknown) => input);
    authority.confirm.mockResolvedValue(undefined); authority.provider.mockResolvedValue('query:owned-proof');
    authority.query.mockResolvedValue(undefined); authority.refund.mockResolvedValue(undefined); authority.refundRequest.mockResolvedValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unexpected external provider I/O'));
    env = { APP_KEY: 'owned_transport_key', WECHAT_MCH_PRIVATE_KEY: keys.privateKey,
      WECHAT_PLATFORM_PUBLIC_KEY: keys.publicKey, WECHAT_PLATFORM_PUBLIC_KEY_ID: SERIAL, WECHAT_API_V3_KEY: V3KEY,
      CONFIG_KV: { get: vi.fn(async () => JSON.stringify('stale-foreign-payment-config')),
        put: vi.fn(), delete: vi.fn() } } as unknown as Env;
    service = new WechatPayService(container, env);
  });
  afterEach(() => {
    try {
      expect(env.CONFIG_KV.get).not.toHaveBeenCalled();
      expect(env.CONFIG_KV.put).not.toHaveBeenCalled();
      expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });

  it('signs the SDK raw prepay ID and verifies both signed provider responses before confirming the original account', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ prepay_id: PREPAY })).mockResolvedValueOnce(response(body({ trade_state: 'NOTPAY' })));
    const result = await create();
    expect(result).toMatchObject({ prepay_id: PREPAY, appid: A, partnerid: M, prepayid: PREPAY, package: 'Sign=WXPay', signType: 'RSA' });
    expect(result.noncestr).toMatch(/^[a-z0-9]{32}$/u); expect(result.timestamp).toMatch(/^\d+$/u);
    expect(verify('RSA-SHA256', Buffer.from(`${A}\n${result.timestamp}\n${result.noncestr}\n${PREPAY}\n`), keys.publicKey,
      Buffer.from(String(result.sign), 'base64'))).toBe(true);
    expect(verify('RSA-SHA256', Buffer.from(`${A}\n${result.timestamp}\n${result.noncestr}\nprepay_id=${PREPAY}\n`), keys.publicKey,
      Buffer.from(String(result.sign), 'base64'))).toBe(false);
    expect(authority.initiate).toHaveBeenCalledWith(container, env, { appId: A, merchantId: M, profile: 'app', orderNo: ORDER,
      amountCents: 1250, orderDomain: 'store_order', currency: 'CNY', configStamp: STAMP });
    const selected = authority.initiate.mock.calls[0][2];
    expect(authority.confirm).toHaveBeenCalledWith(container, env, selected, { appId: A, merchantId: M, orderNo: ORDER,
      amountCents: 1250, currency: 'CNY', tradeType: 'APP', prepayId: PREPAY });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [input, init] of vi.mocked(fetch).mock.calls) {
      const url = new URL(String(input)), request = init!, header = new Headers(request.headers).get('Authorization') ?? '';
      const parts = Object.fromEntries([...header.matchAll(/(\w+)="([^"]+)"/gu)].map(match => [match[1], match[2]]));
      expect(parts.mchid).toBe(M);
      expect(verify('RSA-SHA256', Buffer.from(`${request.method}\n${url.pathname}${url.search}\n${parts.timestamp}\n${parts.nonce_str}\n${request.body ?? ''}\n`),
        keys.publicKey, Buffer.from(parts.signature, 'base64'))).toBe(true);
    }
  });

  it.each(['post-signature','post-serial','query-signature','query-stale'] as const)('%s failure cannot confirm an original or return SDK parameters', async failure => {
    const post = response({ prepay_id: PREPAY }), observed = response(body());
    if (failure === 'post-signature') post.headers.set('Wechatpay-Signature', 'broken');
    if (failure === 'post-serial') post.headers.set('Wechatpay-Serial', 'FOREIGN_PLATFORM_KEY');
    if (failure === 'query-signature') observed.headers.set('Wechatpay-Signature', 'broken');
    if (failure === 'query-stale') observed.headers.set('Wechatpay-Timestamp', '1');
    vi.mocked(fetch).mockResolvedValueOnce(post).mockResolvedValueOnce(observed);
    await expect(create()).rejects.toThrow(); expect(authority.confirm).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(failure.startsWith('post-') ? 1 : 2);
  });

  it.each([
    { appid: 'wxforeign' }, { mchid: '1900000999' }, { out_trade_no: 'foreign_order' }, { trade_type: 'JSAPI' },
    { amount: { total: 1251, currency: 'CNY' } }, { amount: { total: 1250, currency: 'USD' } }, { trade_state: 'CLOSED' },
  ])('a signed post-prepay query with wrong scope %# cannot create an original witness', async extra => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ prepay_id: PREPAY })).mockResolvedValueOnce(response(body(extra)));
    await expect(create()).rejects.toThrow('实际订单身份'); expect(authority.confirm).not.toHaveBeenCalled();
  });

  it('a failed pre-request account/registry boundary prevents all provider I/O', async () => {
    authority.initiate.mockRejectedValue(Error('Conflicting account or registry'));
    await expect(create()).rejects.toThrow('Conflicting'); expect(fetch).not.toHaveBeenCalled();
    expect(authority.confirm).not.toHaveBeenCalled();
  });

  it('requires confirmation persistence before returning a signed SDK envelope', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ prepay_id: PREPAY })).mockResolvedValueOnce(response(body()));
    authority.confirm.mockRejectedValue(Error('Immutable witness unavailable'));
    await expect(create()).rejects.toThrow('Immutable witness');
  });

  it('verifies RSA and AES before submitting a historical App callback when current AppID is empty', async () => {
    authority.read.mockResolvedValue({ appId: '', merchantId: M, stamp: STAMP });
    const notify = notification(body());
    expect(await service.verifyAndParseNotify(notify.headers, notify.raw, 'app')).toMatchObject({ appId: A, merchantId: M,
      outTradeNo: ORDER, amountTotal: 1250, transactionId: 'native_transaction_001' });
    expect(authority.provider).toHaveBeenCalledWith(container, env, expect.objectContaining({ source: 'callback',
      appId: A, merchantId: M, tradeType: 'APP', orderNo: ORDER, currency: 'CNY' }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['signature','ciphertext','trade-type','merchant','amount'] as const)('rejects a callback %s failure before recording provider evidence', async failure => {
    let value = body();
    if (failure === 'trade-type') value = body({ trade_type: 'JSAPI' });
    if (failure === 'merchant') value = body({ mchid: '1900000999' });
    if (failure === 'amount') value = body({ amount: { total: 1250, currency: 'USD' } });
    const notify = notification(value);
    if (failure === 'signature') notify.headers['wechatpay-signature'] = 'broken';
    if (failure === 'ciphertext') {
      const parsed = JSON.parse(notify.raw); parsed.resource.ciphertext = 'AAAA'; notify.raw = JSON.stringify(parsed);
      notify.headers['wechatpay-signature'] = signature(`${notify.headers['wechatpay-timestamp']}\n${notify.headers['wechatpay-nonce']}\n${notify.raw}\n`);
    }
    await expect(service.verifyAndParseNotify(notify.headers, notify.raw, 'app')).rejects.toThrow();
    expect(authority.provider).not.toHaveBeenCalled();
  });

  it('propagates rejected historical callback authority after actual cryptographic verification', async () => {
    const notify = notification(body()); authority.provider.mockRejectedValue(Error('Original account mismatch'));
    await expect(service.verifyAndParseNotify(notify.headers, notify.raw, 'app')).rejects.toThrow('Original account');
  });

  it('retains a signed historical App query proof after clearing the current AppID', async () => {
    authority.read.mockResolvedValue({ appId: '', merchantId: M, stamp: STAMP });
    vi.mocked(fetch).mockResolvedValue(response(body()));
    expect(await query()).toMatchObject({ status: 'SUCCESS', orderNo: ORDER, nativeAppEvidenceId: 'query:owned-proof', errorCode: '' });
    expect(authority.query).toHaveBeenCalledWith(container, env, expect.objectContaining({ profile: 'app', orderDomain: 'store_order' }),
      { appId: A, merchantId: M });
    expect(authority.provider).toHaveBeenCalledWith(container, env, expect.objectContaining({ source: 'signed_query', appId: A, tradeType: 'APP' }));
  });

  it.each(['NOTPAY','CLOSED'])('%s still requires historical account authorization before returning a non-success state', async trade_state => {
    vi.mocked(fetch).mockResolvedValue(response(body({ trade_state })));
    authority.query.mockRejectedValue(Error('Unknown historical tuple'));
    await expect(query()).rejects.toThrow('historical tuple'); expect(authority.provider).not.toHaveBeenCalled();
  });

  it('a signed JSAPI response cannot enter the native query evidence path', async () => {
    vi.mocked(fetch).mockResolvedValue(response(body({ trade_type: 'JSAPI' })));
    expect(await query()).toMatchObject({ status: 'UNKNOWN', errorCode: 'provider_identity_mismatch' });
    expect(authority.query).not.toHaveBeenCalled(); expect(authority.provider).not.toHaveBeenCalled();
  });

  it('keeps official JSAPI signing independent of the optional App account catalog', async () => {
    authority.read.mockRejectedValue(Error('App catalog absent'));
    vi.mocked(fetch).mockResolvedValue(response({ prepay_id: PREPAY }));
    const result = await service.createOrder({ profile: 'wechat', type: 'jsapi', outTradeNo: ORDER, amount: 12.5,
      description: 'Owned official regression', openid: 'owned_payer' });
    expect(result).toMatchObject({ prepay_id: PREPAY, package: 'prepay_id=' + PREPAY, signType: 'RSA' });
    for (const fn of Object.values(authority)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(['missing','merchant-mismatch'] as const)('%s App authority disables only the App readiness channel', async failure => {
    if (failure === 'missing') authority.read.mockRejectedValue(Error('Optional catalog absent'));
    else authority.read.mockResolvedValue({ appId: A, merchantId: '1900000999', stamp: STAMP });
    const ready = await getPaymentReadinessSnapshot(container, env);
    expect(ready.wechatProfiles.app.enabled).toBe(false);
    expect(ready.wechatProfiles.wechat.enabled).toBe(true); expect(ready.wechatProfiles.routine.enabled).toBe(true);
    expect(ready.methods.weixin.enabled).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed SDK identifiers before signing', async () => {
    for (const [appId, merchant, prepay] of [['bad\napp', M, PREPAY], [A, 'merchant', PREPAY], [A, M, 'x'.repeat(65)]])
      await expect(buildNativeAppPaySign(keys.privateKey, appId, merchant, prepay)).rejects.toThrow();
  });

  const refundRequest = () => ({ outTradeNo: ORDER, transactionId: 'native_transaction_001', outRefundNo: 'native_refund_001', refundAmount: 250, totalAmount: 1250 });
  const refundBody = (extra: Record<string, unknown> = {}) => ({ out_trade_no: ORDER, transaction_id: 'native_transaction_001',
    out_refund_no: 'native_refund_001', refund_id: 'native_provider_refund_001', status: 'SUCCESS',
    amount: { refund: 250, total: 1250 }, success_time: '2026-10-27T12:00:00+08:00', ...extra });
  async function merchantOnly() {
    await fixture.db.delete(systemConfig).where(notInArray(systemConfig.menuName,
      ['pay_weixin_mchid', 'pay_weixin_serial_no', 'site_url']));
  }
  it.each(['request','query'] as const)('%s refund verifies signed merchant-only transport with no client AppID, Secret or new-payment switch', async kind => {
    await merchantOnly(); vi.mocked(fetch).mockResolvedValue(response(refundBody()));
    const result = await (kind === 'request' ? service.requestRefund(refundRequest()) : service.queryRefund(refundRequest()));
    expect(result).toMatchObject({ status: 'SUCCESS', providerRefundId: 'native_provider_refund_001' });
    expect(authority.refundRequest).toHaveBeenCalledWith(container, env, refundRequest(), kind, M);
    expect(authority.refund).not.toHaveBeenCalled();
    expect(authority.read).not.toHaveBeenCalled();
    if (kind === 'request') {
      const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
      expect(sent).toMatchObject({ transaction_id: 'native_transaction_001', out_refund_no: 'native_refund_001' });
      expect(sent).not.toHaveProperty('appid'); expect(sent).not.toHaveProperty('appsecret');
    }
  });
  it.each(['request','query'] as const)('%s refund stops before HTTP when the immutable App original merchant does not match', async kind => {
    await merchantOnly(); authority.refundRequest.mockRejectedValue(Error('Original merchant mismatch'));
    await expect(kind === 'request' ? service.requestRefund(refundRequest()) : service.queryRefund(refundRequest())).rejects.toThrow('Original merchant');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['request','query'] as const)('%s refund rejects a signed response that contradicts a known original transaction', async kind => {
    await merchantOnly(); vi.mocked(fetch).mockResolvedValue(response(refundBody({ transaction_id: 'foreign_transaction' })));
    expect(await (kind === 'request' ? service.requestRefund(refundRequest()) : service.queryRefund(refundRequest())))
      .toMatchObject({ status: 'UNKNOWN' });
  });
  it('verifies refund notification RSA/AES before checking the original merchant without any AppID', async () => {
    await merchantOnly();
    const notify = notification({ ...refundBody(), mchid: M, refund_status: 'SUCCESS' }, 'refund');
    expect(await service.verifyAndParseRefundNotify(notify.headers, notify.raw)).toMatchObject({ outTradeNo: ORDER, totalAmount: 1250,
      transactionId: 'native_transaction_001', status: 'SUCCESS' });
    expect(authority.refund).toHaveBeenCalledWith(container, env, { orderNo: ORDER, merchantId: M, totalAmount: 1250, transactionId: 'native_transaction_001' });
    expect(authority.read).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('a forged refund signature never reaches the original merchant guard', async () => {
    await merchantOnly(); const notify = notification({ ...refundBody(), mchid: M, refund_status: 'SUCCESS' }, 'refund');
    notify.headers['wechatpay-signature'] = 'broken';
    await expect(service.verifyAndParseRefundNotify(notify.headers, notify.raw)).rejects.toThrow();
    expect(authority.refund).not.toHaveBeenCalled(); expect(authority.refundRequest).not.toHaveBeenCalled();
  });
  it('rejects an authenticated refund notification when its original merchant or amount conflicts', async () => {
    await merchantOnly(); authority.refund.mockRejectedValue(Error('Original refund identity mismatch'));
    const notify = notification({ ...refundBody(), mchid: M, refund_status: 'SUCCESS' }, 'refund');
    await expect(service.verifyAndParseRefundNotify(notify.headers, notify.raw)).rejects.toThrow('Original refund identity');
    expect(authority.refund).toHaveBeenCalledWith(container, env, { orderNo: ORDER, merchantId: M,
      totalAmount: 1250, transactionId: 'native_transaction_001' });
    expect(authority.refundRequest).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('retains historical refund readiness when all AppIDs are empty and new payments are disabled', () => {
    expect(evaluateWechatRefundReadiness({ pay_weixin_mchid: M, pay_weixin_serial_no: 'ABCDEF123456',
      site_url: 'https://owned.example', pay_weixin_open: '0', wechat_appid: '', routine_appId: '', wechat_app_appid: '' }, env))
      .toEqual({ enabled: true, reason: '' });
  });
  it.each(['merchant','serial','key','callback'] as const)('refund readiness and actual gateway both reject invalid %s configuration', async failure => {
    const values = { pay_weixin_mchid: M, pay_weixin_serial_no: 'ABCDEF123456', site_url: 'https://owned.example' };
    if (failure === 'merchant') values.pay_weixin_mchid = 'invalid';
    if (failure === 'serial') values.pay_weixin_serial_no = 'not-a-serial';
    if (failure === 'key') env.WECHAT_API_V3_KEY = 'short';
    if (failure === 'callback') env.WECHAT_REFUND_NOTIFY_URL = 'https://owned.example/refund?query=forbidden';
    await seedConfig(values);
    expect(evaluateWechatRefundReadiness(values, env).enabled).toBe(false);
    await expect(service.requestRefund(refundRequest())).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
});
