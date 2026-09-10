import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { issueCheckoutConfirmation, readCheckoutConfirmation, assertCheckoutConfirmation, OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { storeOrderCartInfo, storeOrderStatus, printDocument, shippingTemplatesRegion, user, userAddress, storeProduct, storeProductAttrValue } from '../src/models/schema';

describe('immutable server checkout receipts', () => {
  const scope = { uid: 11, key: 'confirmation_test' }, fingerprint = 'a'.repeat(64);
  let values: Map<string, string>;
  const store = { get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); } };
  beforeEach(() => { values = new Map(); });
  afterEach(() => vi.restoreAllMocks());
  it('issues separate immutable versions and stores no address or client price', async () => {
    const a = await issueCheckoutConfirmation(store, scope, fingerprint);
    const b = await issueCheckoutConfirmation(store, scope, 'b'.repeat(64));
    expect(a).not.toBe(b); expect(values.size).toBe(2);
    expect((await readCheckoutConfirmation(store, scope, a)).fingerprint).toBe(fingerprint);
    expect((await readCheckoutConfirmation(store, scope, b)).fingerprint).toBe('b'.repeat(64));
    expect([...values.values()].join('')).not.toMatch(/address|payPrice|realName/);
  });
  it.each([undefined, null, '', 'a', 'A'.repeat(32), 'x'.repeat(10000), true, [], {}].map(token => ({ token })))('rejects malformed receipt $token', async ({ token }) => {
    await expect(readCheckoutConfirmation(store, scope, token)).rejects.toBeInstanceOf(OrderQuoteReconfirmRequired);
  });
  it.each([{ uid: 22 }, { key: 'another_confirmation' }, { adminId: 7 }, { touristUid: 'other' }])('rejects receipt in another scope %j', async change => {
    const token = await issueCheckoutConfirmation(store, scope, fingerprint);
    await expect(readCheckoutConfirmation(store, { ...scope, ...change }, token)).rejects.toBeInstanceOf(OrderQuoteReconfirmRequired);
  });
  it('fails closed on unknown/temporarily invisible receipts and does not downgrade store failures to a business rejection', async () => {
    await expect(readCheckoutConfirmation(store, scope, 'a'.repeat(32))).rejects.toBeInstanceOf(OrderQuoteReconfirmRequired);
    await expect(readCheckoutConfirmation({ ...store, get: async () => { throw new Error('KV unavailable'); } }, scope, 'a'.repeat(32))).rejects.toThrow('KV unavailable');
  });
  it.each(['broken', 'version', 'expiry', 'future', 'digest'] as const)('rejects invalid stored %s data', async kind => {
    const token = await issueCheckoutConfirmation(store, scope, fingerprint), key = [...values.keys()][0];
    const row = JSON.parse(values.get(key)!);
    if (kind === 'version') row.version = 0;
    if (kind === 'expiry') row.expiresAt++;
    if (kind === 'future') { row.createdAt += 3600; row.expiresAt += 3600; }
    if (kind === 'digest') row.fingerprint = 'invalid';
    values.set(key, kind === 'broken' ? '{' : JSON.stringify(row));
    await expect(readCheckoutConfirmation(store, scope, token)).rejects.toBeInstanceOf(OrderQuoteReconfirmRequired);
  });
  it('checks expiration on read and again at final admission', async () => {
    const token = await issueCheckoutConfirmation(store, scope, fingerprint);
    const receipt = await readCheckoutConfirmation(store, scope, token);
    vi.spyOn(Date, 'now').mockReturnValue(receipt.expiresAt * 1000);
    await expect(readCheckoutConfirmation(store, scope, token)).rejects.toBeInstanceOf(OrderQuoteReconfirmRequired);
    expect(() => assertCheckoutConfirmation(receipt, fingerprint, scope.key)).toThrow(OrderQuoteReconfirmRequired);
  });
});

describe('actual HTTP and SQL quote confirmation', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  const input = { cartIds: [1], addressId: 11, shippingType: 1 };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'fixture', get: () => ({ fetch: async () => new Response('confirmed_order') }) } });
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const request = async (path: string, body: Record<string, unknown>) => {
    const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; data: { orderKey: string; quoteToken: string; orderId?: string; errorCode?: string } }>;
  };
  it('binds immutable computed versions and allows explicit reconfirmation without changing the order key', async () => {
    const a = await request('/api/order/confirm', input);
    const b = await request(`/api/order/computed/${a.data.orderKey}`, { ...input, addressId: 12 });
    expect(b.status).toBe(200); expect(b.data.quoteToken).not.toBe(a.data.quoteToken);
    const before = await f.snapshot();
    const path = `/api/order/create/${a.data.orderKey}`;
    expect(await request(path, { ...input, addressId: 12, quoteToken: a.data.quoteToken })).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
    expect(await f.snapshot()).toEqual(before);
    expect((await request(path, { ...input, addressId: 12, quoteToken: b.data.quoteToken })).status).toBe(200);
    expect((await f.snapshot()).orders[0]).toMatchObject({ payPrice: '32.00', paid: 0 });
    f.cache.clear();
    expect((await request(path, { quoteToken: 'corrupt' })).status).toBe(200);
    expect((await f.snapshot()).orders).toHaveLength(1);
  });
  it('rejects changed shipping rules even when the resulting amount stays identical', async () => {
    const a = await request('/api/order/confirm', input);
    await f.db.update(shippingTemplatesRegion).set({ first: '3.00' }).where(eq(shippingTemplatesRegion.id, 1));
    const before = await f.snapshot();
    expect((await request(`/api/order/create/${a.data.orderKey}`, { ...input, quoteToken: a.data.quoteToken })).data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED');
    expect(await f.snapshot()).toEqual(before);
  });
  it('returns a definitive quote rejection when a previously confirmed address is deleted', async () => {
    const a = await request('/api/order/confirm', input);
    await f.db.update(userAddress).set({ isDel: 1 }).where(eq(userAddress.id, 11));
    const before = await f.snapshot();
    expect((await request(`/api/order/create/${a.data.orderKey}`, { ...input, quoteToken: a.data.quoteToken })).data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED');
    expect(await f.snapshot()).toEqual(before);
  });
  it('does not invalidate a quote for default-address metadata or sufficient remaining inventory', async () => {
    const a = await request('/api/order/confirm', input);
    await f.db.update(userAddress).set({ isDefault: 0 }).where(eq(userAddress.id, 11));
    await f.db.update(storeProduct).set({ stock: 7 }); await f.db.update(storeProductAttrValue).set({ stock: 7 });
    expect((await request(`/api/order/create/${a.data.orderKey}`, { ...input, quoteToken: a.data.quoteToken })).status).toBe(200);
    expect((await f.snapshot()).orders[0].payPrice).toBe('26.00');
  });
  it.each(['first_order', 'integral'] as const)('rolls back if final transaction changes %s amount after initial quote admission', async kind => {
    if (kind === 'first_order') Object.assign(f.config, { newcomer_status: '1', first_order_status: '1', first_order_discount: '90', first_order_discount_limit: '100', newcomer_limit_status: '0' });
    else await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '50' });
    const params = { ...input, useIntegral: kind === 'integral' };
    const confirmed = await request('/api/order/confirm', params); expect(confirmed.status).toBe(200);
    let before: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    await expect(StoreOrderCreateService.createWithRuntime(f.container, { CONFIG_KV: f.env.CONFIG_KV, requireConfirmation: true,
      nextOrderId: async () => { await f.db.update(user).set(kind === 'first_order' ? { isFirstOrder: 1 } : { integral: 0 }).where(eq(user.uid, 11)); before = await f.snapshot(); return 'final_quote_rejected'; } },
    { ...params, uid: 11, key: confirmed.data.orderKey, quoteToken: confirmed.data.quoteToken, userIp: '127.0.0.1' })).rejects.toBeInstanceOf(OrderQuoteReconfirmRequired);
    expect(before).toBeDefined(); expect(await f.snapshot()).toEqual(before);
  });
});
