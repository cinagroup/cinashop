import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { storeBargain, storeBargainUser, storeCart } from '../src/models/schema';
import { bargainList } from '../src/controllers/api/v1/UserActivityController';
import { parseBargainList, parseBargainSelection, parseMyBargains, bargainCartInput, bargainCheckoutQuery } from '../../view/common/bargainPurchase';

describe('actual bargain HTTP/SQL responses through the shared PC purchase contract', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => { f = await createBargainSelectionFixture(); f.app.get('/api/bargain/list', bargainList); }, 30000);
  afterEach(async () => { await f?.close(); });
  async function request(path: string, body?: unknown, uid = '11') {
    const response = await f.app.request(`/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-fixture-user': uid, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) }, f.env);
    const result = await response.json() as { status: number; msg: string; data: unknown };
    expect(result.status, result.msg).toBe(200); return result.data;
  }
  it('maps public list and each owned participation without confusing original, cut and current money', async () => {
    const list = parseBargainList(await request('/bargain/list?page=1&limit=20'));
    expect(list[0]).toMatchObject({ id: 40, title: '砍价真实规格目录', price: '10.00', minimum: '2.00' });
    const mine = parseMyBargains(await request('/bargain/user/list?page=1&limit=20'), 11);
    expect(mine.find(r => r.id === 80)).toMatchObject({ current: '2.00', cut: '8.00', progress: 100, ready: true });
    expect(mine.find(r => r.id === 82)).toMatchObject({ current: '8.00', cut: '2.00', progress: 25, ready: false });
    expect(mine.some(r => r.id === 81)).toBe(false);
  });
  it.each([80, 90])('keeps participation %s, activity SKU and exact quote through real add and confirm', async id => {
    await f.db.insert(storeBargainUser).values({ id: 90, uid: 11, bargainId: 40, bargainPrice: '10.00', bargainPriceMin: '4.00', price: '6.00', status: 3 });
    const selection = parseBargainSelection(await request(`/bargain/detail/40?view=skus&bargain_user_id=${id}`), 40, id);
    const cart = await request('/cart/add', bargainCartInput(selection, 'actblu40', 2)) as { id: number };
    expect(bargainCheckoutQuery(cart.id, id)).toMatchObject({ type: '2', bargainUserId: String(id) });
    expect((await f.db.select().from(storeCart))[0]).toMatchObject({ bargainUserId: id, activityId: 40, productId: 70, productAttrUnique: 'qablue01', cartNum: 2, isNew: 1 });
    expect(await request('/order/confirm', { cartIds: [cart.id], type: 2, bargainUserId: id, addressId: 11 })).toMatchObject({ priceGroup: { pay_price: id === 80 ? '4.00' : '8.00' } });
    expect((await f.snapshot()).orders).toHaveLength(0);
  });
  it('does not invent anonymous eligibility or hide activity-price changes', async () => {
    const anonymous = parseBargainSelection(await request('/bargain/detail/40?view=skus', undefined, '0'), 40, 0, false);
    expect(anonymous.participation).toBeNull(); expect(anonymous.can_select).toBe(false);
    expect(() => bargainCartInput(anonymous, 'actred40', 1)).toThrow();
    await f.db.update(storeBargain).set({ price: '12.00' }).where(eq(storeBargain.id, 40));
    expect(parseBargainSelection(await request('/bargain/detail/40?view=skus&bargain_user_id=80'), 40, 80).participation)
      .toMatchObject({ current_price: '2.00', catalog_price: '4.00', activity_price_changed: true });
  });
});
