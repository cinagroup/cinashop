import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createContainerFromDb } from '../src/lib/di';
import { paymentQueryFixture, paymentQueryKeys } from './helpers/paymentQueryFixture';
import { readPaymentProviderResponse } from '../src/utils/payment-response';
import { parseAndVerifyAlipayApiResponse } from '../src/utils/alipay';

describe('signed original-identity provider query adapters (no provider or database I/O)', () => {
  // Lazy local client only supplies the real container type. All config comes from
  // local KV; an unexpected DAO read throws before it can open a socket.
  const client = postgres('postgres://unused:unused@127.0.0.1:1/unused', { max: 1, connect_timeout: 1 });
  const container = createContainerFromDb(drizzle(client));
  let keys: ReturnType<typeof paymentQueryKeys>, f: Awaited<ReturnType<typeof paymentQueryFixture>>;
  beforeAll(() => { keys = paymentQueryKeys(); });
  beforeEach(async () => {
    vi.spyOn(container.systemConfigDao, 'getValues').mockRejectedValue(Error('Database I/O forbidden'));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unstubbed provider I/O forbidden'));
    f = await paymentQueryFixture(container, keys);
  });
  afterEach(() => { expect(container.systemConfigDao.getValues).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await client.end(); });
  const query = (rail: 'wechat' | 'alipay') => rail === 'wechat'
    ? f.wechat.queryOrder(f.request(rail), f.identity(rail)) : f.alipay.query(f.request(rail), f.identity(rail));
  it.each(['wechat', 'alipay'] as const)('%s signs the exact original request and labels query provenance', async rail => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(typeof url).toBe('string'); expect(init).toBeDefined();
      if (typeof url !== 'string' || !init) throw Error('Unexpected request');
      expect(f.verifyRequest(url, init)).toBe(true);
      if (rail === 'wechat') expect(new URL(url).searchParams.get('mchid')).toBe(f.identity().merchantId);
      else expect(JSON.parse(new URLSearchParams(String(init.body)).get('biz_content') ?? '{}'))
        .toEqual({ out_trade_no: f.request().orderNo });
      return rail === 'wechat' ? f.wechatResponse() : f.alipayResponse();
    });
    const result = await query(rail);
    expect(result).toMatchObject({ status: 'SUCCESS', amountCents: 1000, currency: 'CNY', providerEventTime: 1789790400,
      identityEvidence: { appId: f.identity(rail).appId, merchantId: f.identity(rail).merchantId,
        source: rail === 'wechat' ? 'wechat-signed-query' : 'alipay-direct-request-scope' } });
    expect(result).not.toHaveProperty('providerEventId');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['wechat', 'alipay'] as const)('%s rejects missing original identity before network', async rail => {
    const work = rail === 'wechat' ? f.wechat.queryOrder(f.request()) : f.alipay.query(f.request('alipay'));
    await expect(work).rejects.toThrow('原支付身份'); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['wechat-app', 'wechat-merchant', 'alipay-app', 'alipay-merchant', 'alipay-missing-seller'] as const)
    ('rejects rotated %s before network', async change => {
      if (change === 'wechat-app') f.config.cfg_wechat_appid = 'rotated-app';
      if (change === 'wechat-merchant') f.config.cfg_pay_weixin_mchid = '9999999999';
      if (change === 'alipay-app') f.bindings.ALIPAY_APP_ID = 'rotated-app';
      if (change === 'alipay-merchant') f.bindings.ALIPAY_SELLER_ID = '9999999999';
      if (change === 'alipay-missing-seller') f.bindings.ALIPAY_SELLER_ID = '';
      await expect(query(change.startsWith('wechat') ? 'wechat' : 'alipay')).rejects.toThrow('原支付商户');
      expect(fetch).not.toHaveBeenCalled();
    });
  it.each([
    { appid: 'wrong' }, { mchid: '9999999999' }, { out_trade_no: 'wrong-order' }, { payer: { openid: 'new-payer' } },
    { payer: {} }, { trade_type: 'APP' }, { transaction_id: 'x'.repeat(51) }, { transaction_id: 123 },
    { amount: { total: '1000', currency: 'CNY' } }, { amount: { total: 1001, currency: 'CNY' } },
    { amount: { total: 1000, currency: 'USD' } }, { success_time: '' }, { success_time: {} }, { trade_state: ['SUCCESS'] },
  ])('WeChat rejects signed but mismatched success %j', async extra => {
    vi.mocked(fetch).mockResolvedValue(f.wechatResponse(f.wxBody(extra)));
    expect(await query('wechat')).toMatchObject({ status: 'UNKNOWN' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['signature', 'missing', 'serial', 'old-time', 'future-time', 'malformed-time', 'sign-test'] as const)
    ('WeChat rejects %s verification evidence', async failure => {
      const response = f.wechatResponse(f.wxBody(), 200, failure === 'old-time' ? '1'
        : failure === 'future-time' ? String(Math.floor(Date.now() / 1000) + 301)
          : failure === 'malformed-time' ? '1e9' : undefined);
      if (failure === 'signature') response.headers.set('Wechatpay-Signature', f.signature('tampered'));
      if (failure === 'missing') response.headers.delete('Wechatpay-Signature');
      if (failure === 'serial') response.headers.set('Wechatpay-Serial', 'WRONG_KEY');
      if (failure === 'sign-test') response.headers.set('Wechatpay-Signature', 'WECHATPAY/SIGNTEST/test');
      vi.mocked(fetch).mockResolvedValue(response);
      await expect(query('wechat')).rejects.toThrow();
    });
  it('requires a signed WeChat not-found response, not a proxy error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"code":"ORDER_NOT_EXIST"}', { status: 404 }));
    await expect(query('wechat')).rejects.toThrow('验签头');
    vi.mocked(fetch).mockResolvedValueOnce(f.wechatResponse({ code: 'ORDER_NOT_EXIST' }, 404));
    expect(await query('wechat')).toMatchObject({ status: 'NOT_FOUND' });
  });
  it.each(['NOTPAY', 'USERPAYING', 'CLOSED', 'REVOKED', 'PAYERROR', 'REFUND', 'UNKNOWN'])('WeChat preserves non-success %s without successful identity evidence', async state => {
    vi.mocked(fetch).mockResolvedValue(f.wechatResponse(f.wxBody({ trade_state: state })));
    const result = await query('wechat');
    expect(result.status).toBe(['NOTPAY', 'USERPAYING'].includes(state) ? 'PENDING' : 'UNKNOWN');
    expect(result.identityEvidence).toBeUndefined();
  });
  it('accepts H5 without manufacturing payer identity and routine with the frozen JSAPI payer', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(f.wechatResponse(f.wxBody({ trade_type: 'MWEB', payer: undefined })));
    const h5 = await f.wechat.queryOrder(f.request(), { ...f.identity(), transactionType: 'h5', payerId: '' });
    expect(h5.status).toBe('SUCCESS'); expect(h5.identityEvidence).not.toHaveProperty('payerId');
    vi.mocked(fetch).mockResolvedValueOnce(f.wechatResponse());
    const routine = await f.wechat.queryOrder({ ...f.request(), profile: 'routine' }, f.identity());
    expect(routine.identityEvidence).toMatchObject({ payerId: f.identity().payerId });
  });
  it.each([
    { out_trade_no: 'wrong-order' }, { trade_no: 'x'.repeat(51) }, { total_amount: '10.001' }, { total_amount: '1e1' },
    { total_amount: '9.99' }, { send_pay_date: '' }, { send_pay_date: '2026-02-30 12:00:00' },
    { trans_currency: 'USD' }, { settle_currency: 'USD' },
  ])('Alipay rejects signed but mismatched success %j', async extra => {
    vi.mocked(fetch).mockResolvedValue(f.alipayResponse(f.aliBody(extra)));
    expect(await query('alipay')).toMatchObject({ status: 'UNKNOWN' });
  });
  it('rejects a signed Alipay scalar of the wrong type', async () => {
    vi.mocked(fetch).mockResolvedValue(f.alipayResponse(f.aliBody({ total_amount: 10 })));
    await expect(query('alipay')).rejects.toThrow('字段类型');
  });
  it.each(['WAIT_BUYER_PAY', 'TRADE_CLOSED', 'UNRECOGNIZED'])('Alipay preserves %s without positive identity evidence', async state => {
    vi.mocked(fetch).mockResolvedValue(f.alipayResponse(f.aliBody({ trade_status: state })));
    const result = await query('alipay');
    expect(result.status).toBe(state === 'WAIT_BUYER_PAY' ? 'PENDING' : 'UNKNOWN');
    expect(result.identityEvidence).toBeUndefined();
  });
  it('accepts final Alipay success without pretending request-scope identities were response fields', async () => {
    vi.mocked(fetch).mockResolvedValue(f.alipayResponse(f.aliBody({ trade_status: 'TRADE_FINISHED' })));
    expect((await query('alipay')).identityEvidence).toEqual({ source: 'alipay-direct-request-scope',
      appId: f.identity('alipay').appId, merchantId: f.identity('alipay').merchantId });
  });
  it.each(['wechat', 'alipay'] as const)('%s snapshots input before awaited work', async rail => {
    const request = f.request(rail), original = f.identity(rail);
    vi.mocked(fetch).mockResolvedValue(rail === 'wechat' ? f.wechatResponse() : f.alipayResponse());
    const work = rail === 'wechat' ? f.wechat.queryOrder(request, original) : f.alipay.query(request, original);
    request.orderNo = 'new-order'; original.appId = 'new-app'; original.payerId = 'new-payer';
    expect(await work).toMatchObject({ status: 'SUCCESS', orderNo: f.request().orderNo });
  });
  it.each(['wechat', 'alipay'] as const)('%s network loss remains unknown/throw, never success or not-found', async rail => {
    await expect(query(rail)).rejects.toThrow('状态未知');
  });
  it.each(['wechat', 'alipay'] as const)('%s applies the byte limit to the real provider response path', async rail => {
    vi.mocked(fetch).mockResolvedValue(new Response('x'.repeat(65537)));
    await expect(query(rail)).rejects.toThrow('超过64 KiB');
  });
  it.each([0, -1, 1.5, Number.NaN, 2147483648])('rejects invalid expected amount %s before network', async amount => {
    await expect(f.wechat.queryOrder({ ...f.request(), expectedAmountCents: amount }, f.identity())).rejects.toThrow('查单请求');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects malformed original payer and unsupported routine/H5 combination before network', async () => {
    await expect(f.wechat.queryOrder(f.request(), { ...f.identity(), payerId: '' })).rejects.toThrow('原身份');
    await expect(f.wechat.queryOrder({ ...f.request(), profile: 'routine' }, { ...f.identity(), transactionType: 'h5', payerId: '' })).rejects.toThrow('原身份');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('Alipay requires a valid signature for not-found and non-success results too', async () => {
    const body = { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' };
    vi.mocked(fetch).mockResolvedValueOnce(f.alipayResponse(body));
    expect(await query('alipay')).toMatchObject({ status: 'NOT_FOUND', errorCode: 'provider_trade_not_found' });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ alipay_trade_query_response: body })));
    await expect(query('alipay')).rejects.toThrow('缺少签名');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ alipay_trade_query_response: f.aliBody(), sign: f.signature('wrong body') })));
    await expect(query('alipay')).rejects.toThrow('验签失败');
    vi.mocked(fetch).mockResolvedValueOnce(f.alipayResponse({ code: '40004', sub_code: 'NOT_TRADE_NOT_EXIST' }));
    expect((await query('alipay')).status).toBe('UNKNOWN');
  });
  it.each(['duplicate', 'nested'] as const)('Alipay cannot verify one %s response node and use another', async shape => {
    const trusted = JSON.stringify(f.aliBody({ total_amount: '0.01' })), forged = JSON.stringify(f.aliBody());
    const prefix = shape === 'duplicate' ? `"alipay_trade_query_response":${trusted}`
      : `"nested":{"alipay_trade_query_response":${trusted}}`;
    const raw = `{${prefix},"alipay_trade_query_response":${forged},"sign":${JSON.stringify(f.signature(trusted))}}`;
    await expect(parseAndVerifyAlipayApiResponse(raw, 'alipay_trade_query_response', keys.publicKey)).rejects.toThrow('签名节点不一致');
  });
  it.each(['wechat', 'alipay'] as const)('%s rejects a reserved offline number disguised as another domain', async rail => {
    const request = { ...f.request(rail), orderDomain: 'membership' as const };
    await expect(rail === 'wechat' ? f.wechat.queryOrder(request, f.identity(rail)) : f.alipay.query(request, f.identity(rail)))
      .rejects.toThrow('原支付身份'); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['wechat', 'alipay'] as const)('%s ordinary callers retain their scalar success contract', async rail => {
    const request = { ...f.request(rail), orderNo: 'ordinary-order', orderDomain: 'membership' as const };
    vi.mocked(fetch).mockResolvedValue(rail === 'wechat' ? f.wechatResponse(f.wxBody({ out_trade_no: request.orderNo }))
      : f.alipayResponse(f.aliBody({ out_trade_no: request.orderNo })));
    const result = await (rail === 'wechat' ? f.wechat.queryOrder(request) : f.alipay.query(request));
    expect(result.status).toBe('SUCCESS'); expect(result.identityEvidence).toBeUndefined();
  });
  it.each(['alipay', 'wechat-refund', 'wechat-revoked'] as const)('does not classify ambiguous %s closure as non-payment for ordinary callers', async rail => {
    const alipay = rail === 'alipay';
    const request = { ...f.request(alipay ? 'alipay' : 'wechat'), orderNo: 'ordinary-order', orderDomain: 'membership' as const };
    vi.mocked(fetch).mockResolvedValue(alipay ? f.alipayResponse(f.aliBody({ out_trade_no: request.orderNo, trade_status: 'TRADE_CLOSED' }))
      : f.wechatResponse(f.wxBody({ out_trade_no: request.orderNo, trade_state: rail === 'wechat-refund' ? 'REFUND' : 'REVOKED' })));
    const result = await (alipay ? f.alipay.query(request) : f.wechat.queryOrder(request));
    expect(result).toMatchObject({ status: 'UNKNOWN', errorCode: 'provider_closed_or_refunded' });
  });
});

describe('bounded provider response bytes', () => {
  it('reads exactly the UTF-8 limit and preserves signed BOM bytes', async () => {
    expect((await readPaymentProviderResponse(new Response('x'.repeat(65536)))).length).toBe(65536);
    expect(await readPaymentProviderResponse(new Response('\uFEFF{}'))).toBe('\uFEFF{}');
  });
  it.each(['65537', '-1', 'bad', '1.5'])('rejects declared length %s and cancels the body', async length => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    await expect(readPaymentProviderResponse(new Response(stream, { headers: { 'content-length': length } }))).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([undefined, '1'])('enforces actual streaming size despite declared length %s', async length => {
    const cancel = vi.fn(); let sent = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (!sent) { controller.enqueue(new Uint8Array(65536)); sent = true; }
      else controller.enqueue(new Uint8Array(1));
    }, cancel });
    await expect(readPaymentProviderResponse(new Response(stream, { headers: length ? { 'content-length': length } : {} })))
      .rejects.toThrow('超过64 KiB'); expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects invalid UTF-8 instead of verifying lossy text', async () => {
    await expect(readPaymentProviderResponse(new Response(new Uint8Array([0xc3, 0x28])))).rejects.toThrow();
  });
});
