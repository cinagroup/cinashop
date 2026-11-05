import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env } from '../src/env';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { agreement, memberCard, memberCardBatch, memberRight, memberShip, otherOrder,
  otherOrderStatus, storeCouponIssue, storeCouponUser, storeOrderEconomize, systemConfig,
  user, userBill } from '../src/models/schema';
import { PaidMembershipService } from '../src/services/user/PaidMembershipService';
import { financePostgres } from './helpers/financePostgres';

// Real service/DAO/SQL and payment state transitions on a disposable column
// fixture. This does not certify HTTP authentication, native locks or privileges.
describe('paid membership admission uses SQL configuration authority', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let container: Container;
  let service: PaidMembershipService;
  let cachedFlag = '0';
  let sequenceNumber = 0;
  const get = vi.fn(async (key: string) => key === 'cfg_member_card_status' ? cachedFlag : 'Cached shop name');
  const put = vi.fn(async () => undefined);
  const sequence = vi.fn(async () => new Response(`membership_config_${++sequenceNumber}`));
  const create = () => service.createOrder(11, { memberType: 1, from: 'h5' });
  const redeem = () => service.redeem(11, { cardCode: 'local-card', cardPassword: 'local-secret', from: 'h5' });
  const setFlag = async (value: string | null) => {
    await f.db.delete(systemConfig);
    if (value !== null) await f.db.insert(systemConfig).values({ menuName: 'member_card_status', value });
  };
  const state = async () => ({
    orders: await f.db.select().from(otherOrder).orderBy(otherOrder.id),
    statuses: await f.db.select().from(otherOrderStatus),
    cards: await f.db.select().from(memberCard),
    batches: await f.db.select().from(memberCardBatch),
    users: await f.db.select().from(user),
    bills: await f.db.select().from(userBill),
  });
  const expectAdmission = async (enabled: boolean) => {
    const page = await service.index(11);
    expect(page.member_type).toEqual(enabled ? [expect.objectContaining({ id: 1 })] : []);
    expect(page.member_rights).toEqual(enabled ? [expect.objectContaining({ id: 1 })] : []);
    expect(page.is_get_free).toMatchObject({ user_info: { shop_name: 'Cached shop name' } });
    if (enabled) {
      expect(await create()).toMatchObject({ pay_price: '9.00', paid: false });
      expect(await redeem()).toMatchObject({ order_id: expect.stringMatching(/^membership_config_/) });
      expect((await state()).cards).toMatchObject([{ useUid: 11 }]);
    } else {
      const before = await state();
      await expect(create()).rejects.toThrow('付费会员功能暂未开启');
      await expect(redeem()).rejects.toThrow('会员功能暂未开启');
      expect(await state()).toEqual(before);
      expect(sequence).not.toHaveBeenCalled();
    }
    expect(get.mock.calls.map(([key]) => key)).toEqual(['cfg_site_name']);
    expect(put).not.toHaveBeenCalled();
  };

  beforeAll(async () => {
    f = await financePostgres([agreement, memberCard, memberCardBatch, memberRight, memberShip,
      otherOrder, otherOrderStatus, storeCouponIssue, storeCouponUser, storeOrderEconomize,
      systemConfig, user, userBill]);
    container = createContainerFromDb(f.db);
    // Hono supplies only these test-owned bindings. No host credentials, DO,
    // provider or network resource is inherited by the actual service.
    const app = new Hono<{ Bindings: Env }>();
    app.get('/', c => { service = new PaidMembershipService(container, c.env); return c.body(null, 204); });
    expect((await app.request('/', {}, {
      CONFIG_KV: { get, put, delete: vi.fn(async () => undefined) },
      SEQUENCE: { idFromName: () => 'local', get: () => ({ fetch: sequence }) },
    })).status).toBe(204);
  }, 30_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External requests forbidden'));
    get.mockClear(); put.mockClear(); sequence.mockClear(); cachedFlag = '0'; sequenceNumber = 0;
    await f.db.delete(otherOrderStatus); await f.db.delete(otherOrder); await f.db.delete(userBill);
    await f.db.delete(memberCard); await f.db.delete(memberCardBatch); await f.db.delete(memberShip);
    await f.db.delete(memberRight); await f.db.delete(user);
    await f.db.insert(user).values({ uid: 11, account: 'local-membership-config', nowMoney: '100.00' });
    await f.db.insert(memberShip).values({ id: 1, title: 'Local month', type: 'month', vipDay: 30, price: '10.00', prePrice: '9.00' });
    await f.db.insert(memberCardBatch).values({ id: 1, title: 'Local batch', totalNum: 1, useDay: 7, status: 1 });
    await f.db.insert(memberCard).values({ id: 1, cardBatchId: 1, cardNumber: 'local-card', cardPassword: 'local-secret', status: 1 });
    await f.db.insert(memberRight).values({ id: 1, rightType: 'vip_price', status: 1, number: 1 });
    await setFlag('1');
  });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
  afterAll(async () => { await f?.close(); });

  it.each([{ sql: '1', cached: '0', enabled: true }, { sql: '0', cached: '1', enabled: false }])(
    'uses SQL $sql despite the opposite cached flag $cached for purchase, redemption and page', async row => {
      await setFlag(row.sql); cachedFlag = row.cached; await expectAdmission(row.enabled);
    });

  it.each([
    { label: 'missing', value: null, enabled: true },
    { label: 'empty', value: '', enabled: true },
    { label: 'quoted empty', value: '""', enabled: true },
    { label: 'malformed', value: 'not-a-number', enabled: true },
    { label: 'boolean text', value: 'false', enabled: true },
    { label: 'unsafe integer', value: '9007199254740992', enabled: true },
    { label: 'quoted zero', value: ' "0" ', enabled: false },
    { label: 'legacy double-encoded zero', value: JSON.stringify('"0"'), enabled: false },
    { label: 'quoted one', value: ' "1" ', enabled: true },
    { label: 'other integer', value: '2', enabled: false },
    { label: 'negative integer', value: '-1', enabled: false },
  ])('retains existing admission semantics for $label SQL values', async row => {
    await setFlag(row.value); await expectAdmission(row.enabled);
  });

  it('uses the global sort/id winner even when the field is hidden, ignoring a higher store value', async () => {
    await f.db.delete(systemConfig);
    await f.db.insert(systemConfig).values([
      { id: 100, menuName: 'member_card_status', value: '1', sort: 9 },
      { id: 101, menuName: 'member_card_status', value: '1', sort: 10 },
      { id: 102, menuName: 'member_card_status', value: '"0"', sort: 10, status: 0 },
      { id: 103, menuName: 'member_card_status', value: '1', sort: 99, isStore: 1 },
    ]);
    cachedFlag = '1'; await expectAdmission(false);
    await f.db.update(systemConfig).set({ value: '"1"' }).where(eq(systemConfig.id, 102));
    get.mockClear(); await expectAdmission(true);
  });

  it('does not depend on membership KV availability or refill it during admission', async () => {
    get.mockImplementationOnce(async key => {
      if (key !== 'cfg_site_name') throw Error('Membership KV unavailable');
      return 'Cached shop name';
    });
    // Any accidental membership lookup after the permitted site-name read fails.
    get.mockImplementation(async () => { throw Error('Membership KV unavailable'); });
    try { await expectAdmission(true); }
    finally { get.mockImplementation(async key => key === 'cfg_member_card_status' ? cachedFlag : 'Cached shop name'); }
  });

  it('propagates a failed SQL authority read before sequence allocation or business writes', async () => {
    const before = await state();
    vi.spyOn(container.systemConfigDao, 'getValue').mockRejectedValue(Error('SQL authority unavailable'));
    await expect(create()).rejects.toThrow('SQL authority unavailable');
    await expect(redeem()).rejects.toThrow('SQL authority unavailable');
    await expect(service.index(11)).rejects.toThrow('SQL authority unavailable');
    expect(sequence).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
  });

  it.each(['weixin', 'alipay'] as const)('settles and idempotently replays an existing %s order after disabling admission', async payType => {
    const created = await create();
    await setFlag('0'); cachedFlag = '0';
    const initial = await state();
    await expect(create()).rejects.toThrow('付费会员功能暂未开启');
    await expect(redeem()).rejects.toThrow('会员功能暂未开启');
    expect(await state()).toEqual(initial);
    await expect(service.settleExternalPayment(created.order_id, payType, 'local-provider-evidence', 899))
      .rejects.toThrow('会员支付回调金额不匹配');
    expect(await state()).toEqual(initial);
    expect(await service.settleExternalPayment(created.order_id, payType, 'local-provider-evidence', 900)).toBe(true);
    const paid = await state();
    expect(paid.orders).toMatchObject([{ paid: 1, payType, payPrice: '9.00', vipDay: 30, tradeNo: 'local-provider-evidence' }]);
    expect(paid.statuses.filter(row => row.changeType === 'pay_success')).toHaveLength(1);
    expect(paid.users).toMatchObject([{ isMoneyLevel: 1, nowMoney: '100.00' }]);
    expect(await service.settleExternalPayment(created.order_id, payType, 'local-provider-evidence', 900)).toBe(true);
    expect(await service.payOrder(11, { orderId: created.order_id, payType })).toMatchObject({ paid: true });
    expect(await state()).toEqual(paid); expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });
});
