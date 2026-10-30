import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { memberShip, otherOrder, otherOrderStatus, systemConfig, user, wechatUser } from '../src/models/schema';
import { PaidMembershipService } from '../src/services/user/PaidMembershipService';
import { financePostgres } from './helpers/financePostgres';

const boundary = vi.hoisted(() => ({ readiness: vi.fn(), intent: vi.fn(), create: vi.fn() }));
vi.mock('../src/services/payment/PaymentReadinessService', () => ({
  assertPaymentMethodAvailable: vi.fn(), assertWechatPaymentProfileAvailable: boundary.readiness,
}));
vi.mock('../src/services/payment/PaymentInitiationAdmission', () => ({ admitExternalPaymentInitiation: boundary.intent }));
vi.mock('../src/services/wechat/WechatPayService', () => ({
  WechatPayService: class { createOrder = async (input: {beforeProviderRequest?: () => Promise<void>}) => {
    await input.beforeProviderRequest?.(); return boundary.create(input);
  }; },
}));

// Actual SQL create/pay service and channel resolver. Readiness, the registry
// and the provider boundary are replaced; this does not certify their locks,
// native roles, HTTP authentication, WeChat signatures or device SDK behavior.
describe('membership create-to-payment channel contract on owned SQL', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let service: PaidMembershipService;
  const ORDER = 'owned_native_member_1';
  const packet = { appid: 'owned_native_app', partnerid: '1900000101', prepayid: 'owned_native_prepay',
    package: 'Sign=WXPay', noncestr: 'OwnedNonce123', timestamp: '1793000000', sign: 'A'.repeat(340) + 'AA==' };
  const sequence = vi.fn(async () => new Response(ORDER));
  beforeAll(async () => {
    f = await financePostgres([memberShip, otherOrder, otherOrderStatus, systemConfig, user, wechatUser]);
    const app = new Hono<{ Bindings: Env }>();
    app.get('/', c => { service = new PaidMembershipService(createContainerFromDb(f.db), c.env); return c.body(null, 204); });
    expect((await app.request('/', {}, {
      CONFIG_KV: { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn() },
      SEQUENCE: { idFromName: () => 'owned', get: () => ({ fetch: sequence }) },
    })).status).toBe(204);
  }, 30_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External provider forbidden'));
    await f.reset(); sequence.mockClear();
    boundary.readiness.mockReset(); boundary.intent.mockReset(); boundary.create.mockReset().mockResolvedValue(packet);
    await f.db.insert(user).values({ uid: 11, account: 'owned-native-member', nowMoney: '100.00', isMoneyLevel: 0 });
    await f.db.insert(memberShip).values({ id: 1, title: 'Owned month', type: 'month', vipDay: 30, price: '10.00', prePrice: '9.00' });
    await f.db.insert(systemConfig).values({ menuName: 'member_card_status', value: '1' });
    await f.db.insert(wechatUser).values([
      { uid: 11, userType: 'wechat', openid: 'owned_official_payer' },
      { uid: 11, userType: 'routine', openid: 'owned_routine_payer' },
    ]);
  });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
  afterAll(async () => { await f?.close(); });
  const create = (from: string) => service.createOrder(11, { memberType: 1, from });
  const state = async () => ({ orders: await f.db.select().from(otherOrder), statuses: await f.db.select().from(otherOrderStatus),
    accounts: await f.db.select().from(user), identities: await f.db.select().from(wechatUser) });

  it.each([
    { from: 'app', stored: 'app', profile: 'app', mode: 'app', openid: undefined },
    { from: 'routine', stored: 'routine', profile: 'routine', mode: 'jsapi', openid: undefined },
    { from: 'weixin', stored: 'wechat', profile: 'wechat', mode: 'jsapi', openid: 'owned_official_payer' },
    { from: 'wechat', stored: 'wechat', profile: 'wechat', mode: 'jsapi', openid: 'owned_official_payer' },
    { from: 'h5', stored: 'h5', profile: 'wechat', mode: 'h5', openid: undefined },
    { from: 'weixinh5', stored: 'weixinh5', profile: 'wechat', mode: 'h5', openid: undefined },
  ])('creates the actual $from order and returns the resolved $mode transaction mode without marking it paid', async row => {
    const created = await create(row.from);
    expect(created).toMatchObject({ order_id: ORDER, pay_price: '9.00', paid: false });
    expect((await f.db.select().from(otherOrder))[0]).toMatchObject({ uid: 11, type: 1, channelType: row.stored, paid: 0, payPrice: '9.00' });
    const before = await state();
    const result = await service.payOrder(11, { orderId: ORDER, payType: 'weixin' });
    expect(result).toEqual({ order_id: ORDER, paid: false, pay_type: 'weixin', pay_mode: row.mode, jsConfig: packet });
    if (row.profile === 'routine') {
      expect(boundary.readiness).not.toHaveBeenCalled(); expect(boundary.intent).not.toHaveBeenCalled();
      expect(boundary.create.mock.calls[0][0].routinePayer).toEqual({uid:11,orderId:before.orders[0].id,orderDomain:'membership',lockOrder:expect.any(Function)});
    } else {
      expect(boundary.readiness).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything(), row.profile);
      expect(boundary.intent).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ provider: 'wechat',
        profile: row.profile, orderNo: ORDER, expectedAmountCents: 900,
        admission: expect.objectContaining({uid:11,orderId:before.orders[0].id,orderDomain:'membership',lockOrder:expect.any(Function)}) }));
      expect(boundary.intent.mock.invocationCallOrder[0]).toBeLessThan(boundary.create.mock.invocationCallOrder[0]);
    }
    expect(boundary.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ profile: row.profile, type: row.mode,
      outTradeNo: ORDER, amount: 9, attach: 'member', ...(row.openid ? { openid: row.openid } : {}) }));
    if (!row.openid) expect(boundary.create.mock.calls[0][0]).not.toHaveProperty('openid');
    expect(await state()).toEqual(before);
  });

  it('returns an already paid App membership without generating another provider packet or intent', async () => {
    await create('app'); await f.db.update(otherOrder).set({ paid: 1 }).where(eq(otherOrder.orderId, ORDER));
    const before = await state(), result = await service.payOrder(11, { orderId: ORDER, payType: 'weixin', from: 'app' });
    expect(result).toMatchObject({ order_id: ORDER, paid: true }); expect(result).not.toHaveProperty('jsConfig');
    expect(boundary.create).not.toHaveBeenCalled(); expect(boundary.intent).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
  });
  it.each(['foreign-owner', 'other-order-domain'] as const)('rejects %s before provider work or mutation', async kind => {
    await create('app');
    if (kind === 'other-order-domain') await f.db.update(otherOrder).set({ type: 3 }).where(eq(otherOrder.orderId, ORDER));
    const before = await state();
    await expect(service.payOrder(kind === 'foreign-owner' ? 22 : 11, { orderId: ORDER, payType: 'weixin', from: 'app' })).rejects.toThrow('会员订单不存在');
    expect(boundary.readiness).not.toHaveBeenCalled(); expect(boundary.intent).not.toHaveBeenCalled(); expect(boundary.create).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });
  it('stops unavailable App payment before registering an intent or claiming a paid state', async () => {
    await create('app'); const before = await state(); boundary.readiness.mockRejectedValueOnce(Error('Owned unavailable App profile'));
    await expect(service.payOrder(11, { orderId: ORDER, payType: 'weixin' })).rejects.toThrow('Owned unavailable App profile');
    expect(boundary.intent).not.toHaveBeenCalled(); expect(boundary.create).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
  });
  it.each(['pc', 'supplier'])('keeps the unadmitted %s channel rejected before allocating an order number', async from => {
    const before = await state(); await expect(create(from)).rejects.toThrow('非法渠道'); expect(sequence).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });
});
