import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { verify } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createContainerFromDb } from '../src/lib/di';
import { prepareOfflinePaymentProvider } from '../src/services/payment/OfflinePaymentProvider';
import { assertOfflineProviderRequest, validateOfflinePaymentTicket } from '../src/services/payment/OfflinePaymentProviderContract';
import { paymentQueryFixture, paymentQueryKeys } from './helpers/paymentQueryFixture';
import { decodeOfflineDetail } from '../../view/common/offlineCashier';

describe('offline entrance contracts with actual local RSA and no provider/database I/O', () => {
  const client = postgres('postgres://unused:unused@127.0.0.1:1/unused', { max: 1, connect_timeout: 1 });
  const container = createContainerFromDb(drizzle(client));
  let keys: ReturnType<typeof paymentQueryKeys>, f: Awaited<ReturnType<typeof paymentQueryFixture>>;
  beforeAll(() => { keys = paymentQueryKeys(); });
  beforeEach(async () => {
    vi.spyOn(container.systemConfigDao, 'getValues').mockRejectedValue(Error('Database I/O forbidden'));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unstubbed external I/O forbidden'));
    f = await paymentQueryFixture(container, keys);
    f.config.cfg_pay_weixin_open = '1'; f.config.cfg_ali_pay_status = '1';
    f.env.ALIPAY_NOTIFY_URL = 'https://api.example/notify'; f.env.ALIPAY_RETURN_URL = 'https://shop.example/result';
  });
  afterEach(() => { expect(container.systemConfigDao.getValues).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await client.end(); });
  const request = () => ({ orderNo: 'xx' + 'a'.repeat(30), amountCents: 1000, transactionType: 'h5' as const, payerId: '', clientIp: '203.0.113.42' });
  const identity = () => ({ provider: 'wechat' as const, profile: 'wechat' as const, appId: f.identity().appId, merchantId: f.identity().merchantId });
  it.each(['invalid appid','app\nidentity'])('rejects invalid offline app identity %j during preflight',async appId=>{
    f.config.cfg_wechat_appid=appId;await expect(prepareOfflinePaymentProvider(container,f.env,'wechat','wechat')).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
  });
  it('an explicitly supplied current config bypasses stale KV without cache reads or writes',async()=>{
    const current=Object.fromEntries(Object.entries(f.config).map(([key,value])=>[key.slice(4),value]));
    f.env.CONFIG_KV.get=async()=>{throw Error('Unexpected cache read');};f.env.CONFIG_KV.put=async()=>{throw Error('Unexpected cache write');};
    expect((await prepareOfflinePaymentProvider(container,f.env,'wechat','wechat',current)).identity.appId).toBe('wx-local-query');
    await expect(prepareOfflinePaymentProvider(container,f.env,'wechat','wechat',{...current,pay_weixin_open:'0'})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['127.0.0.1', '0.0.0.0', '::', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:0.0.0.0', 'not-ip', '1.2.3.4\n'])('rejects unsafe H5 IP %s', clientIp => {
    expect(() => assertOfflineProviderRequest({ ...request(), clientIp })).toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['203.0.113.42', '2001:db8::42', '::ffff:192.0.2.42'])('accepts correctly shaped IP %s without pretending to verify edge provenance', clientIp => {
    expect(() => assertOfflineProviderRequest({ ...request(), clientIp })).not.toThrow();
  });
  it.each([0, -1, 1.1, NaN, Infinity, 2_147_483_648])('rejects invalid external cents %s', amountCents => {
    expect(() => assertOfflineProviderRequest({ ...request(), amountCents })).toThrow();
  });
  it.each([null, [], {}, { kind: 'wechat-h5', url: 42 }, { kind: 'wechat-h5', url: 'https://attacker.example/pay' },
    { kind: 'wechat-h5', url: 'https://wx.tenpay.com@attacker.example/cgi-bin/mmpayweb-bin/checkmweb?a=b' },
    { kind: 'wechat-h5', url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?a=b', raw: 'provider-secret' },
    { kind: 'wechat-h5', url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?a=b#fragment' },
    { kind: 'wechat-h5', url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?a=' + 'b'.repeat(8192) }])('rejects malformed or overbroad stored artifact %#', ticket => {
    expect(() => validateOfflinePaymentTicket(ticket, identity(), 'h5')).toThrow();
  });
  it('retains exact signed H5 URL bytes and strips unrelated response fields', async () => {
    const url = 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wx123&package=a%2fb%2Bc';
    vi.mocked(fetch).mockResolvedValue(f.wechatResponse({ h5_url: url, ignored: 'not-public' }));
    const provider = await prepareOfflinePaymentProvider(container, f.env, 'wechat', 'wechat');
    expect(await provider.initiate(request())).toEqual({ kind: 'wechat-h5', url: url + '&redirect_url=' + encodeURIComponent('https://shop.example/offline-payment-return?orderId='+request().orderNo) });
  });
  it.each(['wechat','alipay'] as const)('%s binds the H5 return to the original order and freezes it before config edits',async name=>{
    const raw='https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wx123&package=a%2fb%2Bc';
    vi.mocked(fetch).mockResolvedValue(f.wechatResponse({h5_url:raw}));
    const provider=await prepareOfflinePaymentProvider(container,f.env,name,name,undefined,'h5');
    f.env.OFFLINE_H5_RETURN_ORIGIN='https://changed.example';
    const ticket=await provider.initiate({...request(),transactionType:name==='wechat'?'h5':'wap'});
    if(ticket.kind==='wechat-jsapi')throw Error('Expected URL');
    const parsed=new URL(ticket.url),field=name==='wechat'?'redirect_url':'return_url';
    expect(parsed.searchParams.get(field)).toBe('https://h5.example/offline-payment-return?orderId='+request().orderNo);
    if(name==='alipay')expect(JSON.parse(parsed.searchParams.get('biz_content')!).quit_url).toBe(parsed.searchParams.get('return_url'));
    if(name==='wechat')expect(ticket.url.startsWith(raw+'&redirect_url=')).toBe(true);
  });
  it('rejects a provider response that already supplies any redirect_url instead of overriding it',async()=>{
    vi.mocked(fetch).mockResolvedValue(f.wechatResponse({h5_url:'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?a=b&redirect_url=https%3A%2F%2Fevil.example'}));
    const provider=await prepareOfflinePaymentProvider(container,f.env,'wechat','wechat');
    await expect(provider.initiate(request())).rejects.toThrow(/返回参数/);expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['wechat','alipay'] as const)('%s stored ticket validation rejects foreign, generic and duplicate return context',async name=>{
    vi.mocked(fetch).mockResolvedValue(f.wechatResponse({h5_url:'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wx123'}));
    const provider=await prepareOfflinePaymentProvider(container,f.env,name,name),input={...request(),transactionType:name==='wechat'?'h5' as const:'wap' as const};
    const ticket=await provider.initiate(input);if(ticket.kind==='wechat-jsapi')throw Error('URL expected');
    const field=name==='wechat'?'redirect_url':'return_url';
    for(const change of ['foreign','generic','duplicate']){
      const url=new URL(ticket.url),original=url.searchParams.get(field)!;
      if(change==='duplicate')url.searchParams.append(field,original);
      else url.searchParams.set(field,change==='foreign'?original.replace(input.orderNo,'xx'+'b'.repeat(30)):'https://shop.example/result');
      expect(()=>validateOfflinePaymentTicket({...ticket,url:url.toString()},provider.identity,input.transactionType,input)).toThrow();
      expect(()=>decodeOfflineDetail({order_id:input.orderNo,money:'10.00',pay_price:'10.00',channel:'h5',hidden:false,pay_type:name==='wechat'?'weixin':'alipay',paid:false,created_at:100,state:'READY',display_until:200,ticket:{...ticket,url:url.toString()}},input.orderNo)).toThrow();
    }
  });
  it('Alipay cancellation is signed with the same original context and rejects a foreign quit_url on both readers',async()=>{
    const provider=await prepareOfflinePaymentProvider(container,f.env,'alipay','alipay'),input={...request(),transactionType:'wap' as const};
    const ticket=await provider.initiate(input);if(ticket.kind!=='alipay-wap')throw Error('WAP expected');
    const url=new URL(ticket.url),business=JSON.parse(url.searchParams.get('biz_content')!);
    expect(business.quit_url).toBe(url.searchParams.get('return_url'));
    for(const quit_url of ['https://attacker.example/result','https://shop.example/offline-payment-return?orderId='+'xx'+'b'.repeat(30),null]){
      url.searchParams.set('biz_content',JSON.stringify({...business,quit_url}));const wrong={...ticket,url:url.toString()};
      expect(()=>validateOfflinePaymentTicket(wrong,provider.identity,'wap',input)).toThrow();
      expect(()=>decodeOfflineDetail({order_id:input.orderNo,money:'10.00',pay_price:'10.00',channel:'h5',hidden:false,pay_type:'alipay',paid:false,created_at:100,state:'READY',display_until:200,ticket:wrong},input.orderNo)).toThrow();
    }
  });
  it.each(['wechat','alipay'] as const)('%s rejects an unconfigured selected client without using the other origin',async name=>{
    f.env.OFFLINE_H5_RETURN_ORIGIN=undefined;
    await expect(prepareOfflinePaymentProvider(container,f.env,name,name,undefined,'h5')).rejects.toThrow(/返回站点/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['stale', 'signature', 'error', 'large'] as const)('rejects %s response before returning a ticket', async failure => {
    const body = { h5_url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?a=b' };
    const response = failure === 'large' ? new Response('x'.repeat(65537)) : failure === 'error'
      ? f.wechatResponse({ code: 'INVALID_REQUEST', message: 'not-returned' }, 400)
      : f.wechatResponse(body, 200, failure === 'stale' ? '1' : undefined);
    if (failure === 'signature') response.headers.set('Wechatpay-Signature', 'a'.repeat(344));
    vi.mocked(fetch).mockResolvedValue(response);
    const provider = await prepareOfflinePaymentProvider(container, f.env, 'wechat', 'wechat');
    await expect(provider.initiate(request())).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
  });
  it('freezes Alipay key, application and URLs before later config edits, with exact max int32 cents', async () => {
    const provider = await prepareOfflinePaymentProvider(container, f.env, 'alipay', 'alipay');
    f.env.ALIPAY_PRIVATE_KEY = 'invalid'; f.env.ALIPAY_APP_ID = 'new-app'; f.env.OFFLINE_PC_RETURN_ORIGIN = 'https://changed.example';
    const ticket = await provider.initiate({ ...request(), transactionType: 'wap', amountCents: 2_147_483_647 });
    if (ticket.kind !== 'alipay-wap') throw Error('Expected WAP');
    const params = new URL(ticket.url).searchParams, sig = params.get('sign') ?? ''; params.delete('sign');
    expect(params.get('app_id')).toBe('2026091900000001'); expect(params.get('return_url')).toBe('https://shop.example/offline-payment-return?orderId='+request().orderNo);
    expect(JSON.parse(params.get('biz_content') ?? '{}').total_amount).toBe('21474836.47');
    expect(verify('RSA-SHA256', Buffer.from([...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&')),
      keys.publicKey, Buffer.from(sig, 'base64'))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'bad-public', 'bad-private', 'insecure-notify', 'return-credentials'] as const)('Alipay %s fails before reservation', async failure => {
    if (failure === 'disabled') f.config.cfg_ali_pay_status = '0';
    if (failure === 'bad-public') f.env.ALIPAY_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----oops-----END PUBLIC KEY-----';
    if (failure === 'bad-private') f.env.ALIPAY_PRIVATE_KEY = 'oops';
    if (failure === 'insecure-notify') f.env.ALIPAY_NOTIFY_URL = 'http://api.example/notify';
    if (failure === 'return-credentials') f.env.OFFLINE_PC_RETURN_ORIGIN = 'https://user:secret@shop.example/result';
    await expect(prepareOfflinePaymentProvider(container, f.env, 'alipay', 'alipay')).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
});
