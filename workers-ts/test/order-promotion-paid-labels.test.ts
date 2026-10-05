import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { user, userLabel, userLabelRelation } from '../src/models/schema';
import { grantPaidPromotionLabels, promotionPaidLabelIds } from '../src/services/order/OrderRewardService';
import { MEMBER_SAVINGS_VERSION, orderMembershipSavings } from '../src/services/order/OrderMembershipSavings';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';

const snapshot = (promotions: Array<{ id: number; label_id: number[]; name: string }>) =>
  JSON.stringify({ version: 'order-promotion-labels-v1', promotions });
const paidRoot = (promotionsGive: string | null, pid = 0, uid = 7, paid = 1) =>
  ({ uid, pid, paid, promotionsGive });

describe('paid promotion label effects', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async () => { fixture = await financePostgres([user, userLabel, userLabelRelation]); }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(user).values({ uid: 7, account: 'paid-promotion-buyer' });
    await fixture.db.insert(userLabel).values([
      { id: 31, name: '留存', type: 0, relationId: 0, status: 1 },
      { id: 32, name: '会员关怀', type: 0, relationId: 0, status: 1 },
      { id: 33, name: '已退役', type: 0, relationId: 0, status: 0 },
      { id: 34, name: '门店标签', type: 1, relationId: 5, status: 1 },
    ]);
  });

  it('reads only the exact versioned wrapper and deduplicates labels across promotions', () => {
    expect(promotionPaidLabelIds(null)).toBeNull();
    expect(promotionPaidLabelIds('[]')).toBeNull();
    expect(promotionPaidLabelIds(JSON.stringify({ legacy_gift: [31] }))).toBeNull();
    expect(promotionPaidLabelIds(snapshot([
      { id: 90, label_id: [32, 31, 31], name: '限时折扣' },
      { id: 91, label_id: [32], name: '叠加优惠' },
    ]))).toEqual([31, 32]);
    for (const malformed of [
      '{',
      JSON.stringify({ version: 'order-promotion-labels-v0', promotions: [] }),
      JSON.stringify({ version: 'order-promotion-labels-v1', promotions: [], extra: true }),
      JSON.stringify({ version: 'order-promotion-labels-v1', promotions: [{ id: 90, label_id: [31] }] }),
      JSON.stringify({ version: 'order-promotion-labels-v1', promotions: [{ id: 90, label_id: ['31'], name: 'bad' }] }),
    ]) expect(() => promotionPaidLabelIds(malformed)).toThrow();
  });

  it('grants only current platform labels on a paid payment root and is replay-safe', async () => {
    const intent = snapshot([{ id: 90, label_id: [31, 32, 33, 34], name: '限时折扣' }]);
    await fixture.db.insert(userLabelRelation).values([
      { uid: 7, type: 0, relationId: 0, labelId: 31 },
      { uid: 7, type: 1, relationId: 5, labelId: 34 },
    ]);
    const container = createContainerFromDb(fixture.db);
    await withTx(container, tx => grantPaidPromotionLabels(tx, paidRoot(intent)));
    await withTx(container, tx => grantPaidPromotionLabels(tx, paidRoot(intent, -1)));
    const owned = await fixture.db.select().from(userLabelRelation)
      .where(and(eq(userLabelRelation.uid, 7), eq(userLabelRelation.type, 0)))
      .orderBy(userLabelRelation.labelId);
    expect(owned.map(row => row.labelId)).toEqual([31, 32]);
    expect(await fixture.db.select().from(userLabelRelation)).toHaveLength(3);
  });

  it('skips guests and rejects unpaid, child or missing-user effects without assigning labels', async () => {
    const intent = snapshot([{ id: 90, label_id: [31], name: '限时折扣' }]);
    const container = createContainerFromDb(fixture.db);
    await withTx(container, tx => grantPaidPromotionLabels(tx, paidRoot(intent, 0, 0)));
    for (const order of [paidRoot(intent, 0, 7, 0), paidRoot(intent, 5), paidRoot(intent, 0, 999)]) {
      await expect(withTx(container, tx => grantPaidPromotionLabels(tx, order)))
        .rejects.toMatchObject({ code: 400 });
    }
    expect(await fixture.db.select().from(userLabelRelation)).toEqual([]);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('serializes concurrent first grants on the user row', async () => {
    const intent = snapshot([{ id: 90, label_id: [31, 32], name: '限时折扣' }]);
    await withFinancePeers(fixture.db, async ([first, second]) => {
      await Promise.all([first, second].map(peer => withTx(createContainerFromDb(peer.db),
        tx => grantPaidPromotionLabels(tx, paidRoot(intent)))));
    });
    const rows = await fixture.db.select().from(userLabelRelation)
      .where(eq(userLabelRelation.uid, 7));
    expect(rows.map(row => row.labelId).sort()).toEqual([31, 32]);
  }, 30_000);
});

describe('membership savings partial snapshot fence', () => {
  const order = { id: 77, uid: 7, totalNum: 2 };
  const row = (cartId: string, cartInfo: Record<string, unknown>, cartNum = 1) => ({
    oid: 77, uid: 7, cartId, cartNum, cartInfo: JSON.stringify(cartInfo),
  });
  const full = (id: string) => ({ id, cart_num: 1, financial_version: 'checkout-line-finance-v1',
    member_savings_version: MEMBER_SAVINGS_VERSION, paid_member: 1, price_type: 'member',
    vip_truePrice: '0.50', member_postage_price: '0.00', member_coupon_price: '0.00',
    raw_postage_price: '0.00', postage_price: '0.00', coupon_price: '0.00' });

  it('returns unknown for entirely old evidence but rejects a mixed old/new cart family', () => {
    expect(orderMembershipSavings(order, [row('1', { id: '1' }), row('2', { id: '2' })])).toBeNull();
    expect(() => orderMembershipSavings(order,
      [row('1', full('1')), row('2', { id: '2', cart_num: 1, vip_truePrice: '0.50' })]))
      .toThrow('会员节省金额快照证据不一致');
    expect(orderMembershipSavings(order, [row('1', full('1')), row('2', full('2'))]))
      .toMatchObject({ eligible: true, memberPrice: '1.00', postagePrice: '0.00', couponPrice: '0.00' });
  });

  it('uses the exact quoted membership line amount instead of multiplying a rounded unit', () => {
    const quote = { ...full('cart-1'), cart_num: 2,
      promotion_quote_version: 'order-promotion-quote-v1', promotion_line_member_savings: '1.01' };
    expect(orderMembershipSavings(order, [row('cart-1', quote, 2)]))
      .toMatchObject({ eligible: true, memberPrice: '1.01', postagePrice: '0.00', couponPrice: '0.00' });
  });
});
