import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { LegacyOrderCompatibilityService } from '@/services/order/LegacyOrderCompatibilityService';

const KEY = 'a'.repeat(32), SECRET = 'alipay-key-unit-signing-key';
const NOW = 1_790_000_000;
const DOMAIN = 'cinashop.payment.alipay-redirect-capability.v2\0';
const FIELDS = ['version', 'purpose', 'key', 'uid', 'orderNo', 'orderId', 'amountCents', 'orderDomain',
  'provider', 'profile', 'caseId', 'replayKey', 'payUrl', 'issuedAt', 'expiresAt', 'signature'] as const;
function payload(): Record<string, unknown> {
  const url = new URL('https://openapi.alipay.com/gateway.do');
  url.searchParams.set('app_id', 'local_app');
  url.searchParams.set('method', 'alipay.trade.wap.pay');
  url.searchParams.set('biz_content', JSON.stringify({ out_trade_no: 'local_order', total_amount: '1.00' }));
  url.searchParams.set('sign', 'only-the-native-matrix-uses-provider-RSA');
  return { version: 2, purpose: 'alipay_redirect_replay', key: KEY, uid: 11, orderNo: 'local_order', orderId: 21,
    amountCents: 100, orderDomain: 'store_order', provider: 'alipay', profile: 'alipay', caseId: 31,
    replayKey: '11111111-1111-4111-8111-111111111111', payUrl: url.toString(), issuedAt: NOW, expiresAt: NOW + 300 };
}
function sealed(value = payload(), domain = DOMAIN): Record<string, unknown> {
  // Independent HMAC calculation. These tests exercise rejection before SQL;
  // successful live admission/replay is exercised in routine-payment-key-replay.
  return { ...value, signature: createHmac('sha256', SECRET).update(domain).update(JSON.stringify(value)).digest('hex') };
}
const TAMPER: Record<typeof FIELDS[number], unknown> = {
  version: 3, purpose: 'routine_code2session', key: 'b'.repeat(32), uid: 12, orderNo: 'other_order', orderId: 22,
  amountCents: 101, orderDomain: 'membership', provider: 'wechat', profile: 'routine', caseId: 32,
  replayKey: '22222222-2222-4222-8222-222222222222', payUrl: String(payload().payUrl) + '&subject=changed',
  issuedAt: NOW - 1, expiresAt: NOW + 299, signature: 'f'.repeat(64),
};

describe('Alipay opaque-key authentication before live SQL replay', () => {
  let values: Map<string, string>, env: Env, service: LegacyOrderCompatibilityService, sqlReads: number;
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
    values = new Map(); sqlReads = 0;
    const inaccessible = new Proxy({} as Container, { get() { sqlReads++; throw Error('Invalid capabilities must not reach SQL'); } });
    env = { APP_KEY: SECRET, CONFIG_KV: {
      get: vi.fn(async (key: string) => values.get(key) ?? null), put: vi.fn(async () => {}), delete: vi.fn(async () => {}),
    } } as unknown as Env;
    service = new LegacyOrderCompatibilityService(inaccessible, env);
  });
  afterEach(() => {
    try {
      expect(sqlReads).toBe(0);
      expect(env.CONFIG_KV.put).not.toHaveBeenCalled();
      expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
  const save = (value: unknown) => values.set(`pay:alipay:${KEY}`, JSON.stringify(value));

  it.each(FIELDS)('rejects tampered %s without deleting the original capability', async field => {
    save({ ...sealed(), [field]: TAMPER[field] });
    const before = values.get(`pay:alipay:${KEY}`);
    await expect(service.consumeAlipayKey(KEY)).rejects.toThrow();
    expect(values.get(`pay:alipay:${KEY}`)).toBe(before);
  });
  it.each(FIELDS)('rejects missing %s rather than filling it from current data', async field => {
    const value = sealed(); delete value[field]; save(value);
    await expect(service.consumeAlipayKey(KEY)).rejects.toThrow();
  });
  it.each([null, [], {}, { uid: 11, orderId: 'local_order', payUrl: payload().payUrl },
    { ...sealed(), extra: 'unknown' }, { ...sealed(), sessionKey: 'forbidden-sensitive-field' }].map(value => ({ value })))(
    'rejects a legacy, incomplete or extra-field record (%j)', async ({ value }) => {
      save(value); await expect(service.consumeAlipayKey(KEY)).rejects.toThrow();
    });
  it.each(['', 'z'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), KEY + '\n'])('rejects malformed key %j before cache access', async key => {
    await expect(service.consumeAlipayKey(key)).rejects.toThrow();
    expect(env.CONFIG_KV.get).not.toHaveBeenCalled();
  });
  it.each(['', undefined, 123])('rejects an unavailable signing key %j', async secret => {
    save(sealed());
    const broken = { ...env, APP_KEY: secret } as unknown as Env;
    await expect(new LegacyOrderCompatibilityService({} as Container, broken).consumeAlipayKey(KEY)).rejects.toThrow();
  });
  it.each([
    { issuedAt: NOW - 300, expiresAt: NOW }, { issuedAt: NOW + 1, expiresAt: NOW + 300 },
    { issuedAt: NOW, expiresAt: NOW + 301 }, { issuedAt: NOW, expiresAt: NOW },
    { issuedAt: String(NOW), expiresAt: NOW + 300 }, { issuedAt: NOW, expiresAt: null },
  ])('rejects authenticated invalid lifetime %j', async times => {
    save(sealed({ ...payload(), ...times }));
    await expect(service.consumeAlipayKey(KEY)).rejects.toThrow();
  });
  it('does not accept a valid HMAC from an unrelated purpose/domain', async () => {
    save(sealed(payload(), 'cinashop.routine.identity-observation.v1\0'));
    await expect(service.consumeAlipayKey(KEY)).rejects.toThrow();
  });
  it('rejects invalid and oversized JSON without deleting it', async () => {
    for (const value of ['{', ' '.repeat(24_577)]) {
      values.set(`pay:alipay:${KEY}`, value);
      await expect(service.consumeAlipayKey(KEY)).rejects.toThrow();
      expect(values.get(`pay:alipay:${KEY}`)).toBe(value);
    }
  });
  it('requires an original gateway URL at creation instead of enabling a later fallback', async () => {
    await expect(service.createAlipayKey(11, 'local_order')).rejects.toThrow('支付宝支付地址无效');
    await expect(service.createAlipayKey(11, 'local_order', 'javascript:alert(1)')).rejects.toThrow('支付宝支付地址无效');
  });
});
