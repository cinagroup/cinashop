import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { memberRight, storeOrder, storeOrderStatus, systemConfig, user, userBill } from '../src/models/schema';
import { completeOrderReceipt } from '../src/services/order/OrderBrokerageService';
import { financePostgres } from './helpers/financePostgres';

// Actual receipt transaction and reward SQL. The small column fixture does not
// establish native cross-session locking, HTTP authentication or role grants.
describe('receipt membership rewards use the SQL flag without blocking old orders', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let container: Container;
  const cached: Record<string, string> = { member_card_status: '1', order_give_integral: '1',
    member_func_status: '0', order_give_exp: '2', brokerage_func_status: '0',
    extract_time: '0', store_brokerage_statu: '1', store_brokerage_price: '0' };
  const get = vi.fn(async (key: string) => cached[key.replace(/^cfg_/, '')] ?? null);
  const put = vi.fn(async () => undefined);
  const env = { CONFIG_KV: { get, put, delete: vi.fn(async () => undefined) } };
  const receipt = () => completeOrderReceipt(container, env, {
    orderId: 41, actor: 'user', actorId: 11, message: 'Local receipt authority test',
  });
  const setFlag = async (value: string | null) => {
    await f.db.delete(systemConfig);
    if (value !== null) await f.db.insert(systemConfig).values({ menuName: 'member_card_status', value });
  };
  const state = async () => ({ orders: await f.db.select().from(storeOrder),
    users: await f.db.select().from(user), bills: await f.db.select().from(userBill).orderBy(userBill.id),
    statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id) });
  const expectReceipt = async (enabled: boolean) => {
    expect(await receipt()).toBe(true);
    const settled = await state();
    expect(settled.orders).toMatchObject([{ paid: 1, status: 2, payPrice: '10.00' }]);
    expect(settled.users).toMatchObject([{ integral: enabled ? 137 : 117, exp: '0.00', nowMoney: '100.00' }]);
    expect(settled.bills).toMatchObject([
      { eventKey: 'pay_give_integral', number: '7.00' },
      { eventKey: 'order_give_integral', number: enabled ? '30.00' : '10.00' },
    ]);
    expect(settled.statuses).toMatchObject([{ changeType: 'take_delivery' }]);
    expect(settled.statuses).toHaveLength(1);
    // Changing today's switch cannot reopen an already completed receipt or
    // reprice/reissue its recorded reward. The original status transition wins.
    await setFlag(enabled ? '0' : '1');
    expect(await receipt()).toBe(false);
    expect(await state()).toEqual(settled);
    expect(get.mock.calls.some(([key]) => key === 'cfg_member_card_status')).toBe(false);
    expect(get.mock.calls.map(([key]) => key)).toContain('cfg_order_give_integral');
    expect(put).not.toHaveBeenCalled();
  };

  beforeAll(async () => {
    f = await financePostgres([memberRight, storeOrder, storeOrderStatus, systemConfig, user, userBill]);
    container = createContainerFromDb(f.db);
  }, 30_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External requests forbidden'));
    get.mockClear(); put.mockClear(); cached.member_card_status = '1';
    await f.reset();
    await f.db.insert(user).values({ uid: 11, account: 'local-reward-config', isMoneyLevel: 1,
      overdueTime: Math.floor(Date.now() / 1000) + 86_400, integral: 100, nowMoney: '100.00' });
    await f.db.insert(memberRight).values({ id: 1, rightType: 'integral', status: 1, number: 3 });
    // Existing paid/shipped order, created before this test's switch change.
    await f.db.insert(storeOrder).values({ id: 41, uid: 11, orderId: 'local_reward_config', paid: 1,
      status: 1, shippingType: 1, deliveryType: 'express', payPrice: '10.00', gainIntegral: '7.00' });
  });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
  afterAll(async () => { await f?.close(); });

  it.each([{ sql: '1', kv: '0', enabled: true }, { sql: '0', kv: '1', enabled: false }])(
    'follows SQL $sql instead of cached $kv, still completing receipt exactly once', async row => {
      cached.member_card_status = row.kv; await setFlag(row.sql); await expectReceipt(row.enabled);
    });

  it.each([
    { label: 'missing', value: null, enabled: true },
    { label: 'empty', value: '', enabled: true },
    { label: 'malformed', value: 'not-a-number', enabled: true },
    { label: 'quoted one', value: ' "1" ', enabled: true },
    { label: 'double-encoded zero', value: JSON.stringify('"0"'), enabled: false },
    { label: 'other integer', value: '2', enabled: false },
  ])('preserves historical receipt fallback/scalar semantics for $label', async row => {
    await setFlag(row.value); await expectReceipt(row.enabled);
  });

  it('selects the hidden global sort/id winner without adopting a store-scoped flag', async () => {
    await f.db.insert(systemConfig).values([
      { id: 100, menuName: 'member_card_status', value: '1', sort: 9 },
      { id: 101, menuName: 'member_card_status', value: '1', sort: 10 },
      { id: 102, menuName: 'member_card_status', value: '0', sort: 10, status: 0 },
      { id: 103, menuName: 'member_card_status', value: '1', sort: 99, isStore: 1 },
    ]);
    await expectReceipt(false);
  });

  it('does not read an unavailable membership KV key while retaining other reward cache reads', async () => {
    await setFlag('1');
    get.mockImplementation(async key => {
      if (key === 'cfg_member_card_status') throw Error('Membership cache unavailable');
      return cached[key.replace(/^cfg_/, '')] ?? null;
    });
    try { await expectReceipt(true); }
    finally { get.mockImplementation(async key => cached[key.replace(/^cfg_/, '')] ?? null); }
  });

  it('leaves the shipped order and all reward evidence unchanged if SQL authority cannot be read', async () => {
    await setFlag('1');
    const before = await state();
    vi.spyOn(container.systemConfigDao, 'getValue').mockRejectedValue(Error('SQL authority unavailable'));
    await expect(receipt()).rejects.toThrow('SQL authority unavailable');
    expect(await state()).toEqual(before);
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, 41)))[0].status).toBe(1);
  });
});
