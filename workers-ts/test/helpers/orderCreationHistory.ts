/** Actual assembled App/JWT checkout; only the external Sequence DO is local. */
import { expect } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '@/env';
import { storeOrder, user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import type { RemarkScenario } from './adminOrderRemark';

export async function orderCreationClient(s: RemarkScenario) {
  let sequenceCalls = 0;
  const prefix = 'ch' + crypto.randomUUID().replaceAll('-', '').slice(0, 24);
  s.env.SEQUENCE = {
    idFromName: (name: string) => { expect(name).toBe('seq'); return name; },
    get: () => ({ fetch: async (url: string) => {
      expect(url).toBe('https://internal/next-order-id?prefix=wx');
      return new Response(prefix + String(++sequenceCalls));
    } }),
  } as unknown as Env['SEQUENCE'];
  const [buyer] = await s.f.db.select().from(user).where(eq(user.uid, 11));
  if (!buyer) throw Error('Owned buyer missing');
  const token = (await createToken(11, 'api', md5(buyer.pwd), s.env.APP_KEY)).token;
  const input = { cartIds: [1, 2], addressId: 11, shippingType: 1, useIntegral: true };
  const quote = async (changes: Record<string, unknown> = {}) => {
    const result = await s.request('POST', '/api/order/confirm', { ...input, ...changes }, token);
    expect(result.status, result.msg).toBe(200);
    expect(result.data).toMatchObject({ orderKey: expect.any(String), quoteToken: expect.any(String) });
    return result.data as { orderKey: string; quoteToken: string };
  };
  const create = (receipt: { orderKey: string; quoteToken: string }, changes: Record<string, unknown> = {}) =>
    s.request('POST', '/api/order/create/' + receipt.orderKey, { ...input, quoteToken: receipt.quoteToken, ...changes }, token);
  const checkout = async () => {
    const receipt = await quote(), result = await create(receipt);
    expect(result.status, result.msg).toBe(200);
    const [order] = await s.f.db.select().from(storeOrder).where(eq(storeOrder.orderId, result.data.orderId));
    if (!order) throw Error('Actual HTTP checkout order missing');
    expect(order).toMatchObject({ uid: 11, paid: 0, status: 0, pid: 0, unique: receipt.orderKey });
    return { receipt, result, order };
  };
  return { token, input, quote, create, checkout, sequenceCalls: () => sequenceCalls };
}
