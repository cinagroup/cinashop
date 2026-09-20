import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { storeCouponIssue, storeCouponUser, storeOrder, storeOrderCartInfo, storeOrderEconomize, storeOrderOutbox,
  storeProduct, storeProductAttrValue, systemConfig, systemSupplier, systemUserLevel, user } from '../src/models/schema';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { applyStoreOrderBalancePayment, applyStoreOrderPayment } from '../src/services/order/StoreOrderPayService';
import { OrderOutboxService } from '../src/services/order/OrderOutboxService';
import { PaidMembershipService } from '../src/services/user/PaidMembershipService';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Runtime = Parameters<Parameters<Fixture['withRuntime']>[0]>[0];
describe('paid membership economize ledger from admitted checkout evidence', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External requests forbidden'));
    f = await refundRuntimeFixture();
    await f.db.update(user).set({ nowMoney: '1000.00' }).where(eq(user.uid, 11));
    await config({ member_card_status: '1', svip_price_status: '1' });
    Object.assign(f.env, { ORDER_QUEUE: { send: vi.fn(async () => { throw Error('Queue forbidden'); }),
      sendBatch: vi.fn(async () => { throw Error('Queue forbidden'); }) } });
  }, 45_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });
  const config = async (values: Record<string, string>) => {
    for (const [key, value] of Object.entries(values)) await f.db.update(systemConfig).set({ value })
      .where(and(eq(systemConfig.menuName, key), eq(systemConfig.isStore, 0)));
  };
  const ledger = () => f.db.select().from(storeOrderEconomize).orderBy(storeOrderEconomize.id);
  const wire = async (r: Runtime) => {
    // Explicit test-only profile for the actual paid outbox and detail readers.
    await f.exec(`GRANT SELECT, INSERT ON store_order_economize TO "${r.role}";
      GRANT USAGE ON SEQUENCE store_order_economize_id_seq TO "${r.role}";
      GRANT UPDATE ON store_order_outbox TO "${r.role}";
      GRANT SELECT ON store_product_coupon, luck_lottery, store_order_promotions, store_promotions, store_order_writeoff,
        store_coupon_issue, agreement, member_ship, other_order TO "${r.role}";
      GRANT UPDATE(id) ON store_coupon_issue TO "${r.role}";
      GRANT SELECT, UPDATE ON store_coupon_user TO "${r.role}"`);
    return new OrderOutboxService(r.container, f.env);
  };
  const pay = async (r: Runtime, orderId: string) => {
    const result = await applyStoreOrderBalancePayment(r.container, { uid: 11, orderId });
    expect(result.outcome).toBe('paid'); expect(result.outbox).not.toBeNull();
    return { action: 'processOrderPaidOutbox' as const, outboxId: result.outbox!.id, eventKey: result.outbox!.eventKey };
  };
  const detail = (r: Runtime, orderId: string) => new StoreOrderCreateService(r.container, f.env).detail(11, orderId);
  const checkout = (r: Runtime, overrides: { couponId?: number; payType?: string } = {}) =>
    StoreOrderCreateService.createWithRuntime(r.container, { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'economize_checkout' },
      { uid: 11, key: 'economize_checkout', cartIds: [1, 2], addressId: 11, userIp: '127.0.0.1', useIntegral: true, ...overrides });
  const coupon = async (category: number) => {
    await f.db.insert(storeCouponIssue).values({ id: 990, type: 1, couponType: 0, category });
    await f.db.insert(storeCouponUser).values({ id: 990, uid: 11, issueCouponId: 990, couponPrice: '5.00', useMinPrice: '0.00' });
  };

  it('writes paid-only savings once, leaves payment unchanged, and exposes the same immutable detail values', async () => {
    await f.withRuntime(async r => {
      const outbox = await wire(r), created = await r.checkout();
      expect(await ledger()).toEqual([]);
      await config({ member_card_status: '0', svip_price_status: '0' });
      await f.db.update(storeProductAttrValue).set({ price: '99.00', vipPrice: '0.01' }).where(eq(storeProductAttrValue.id, 1));
      const message = await pay(r, created.orderId);
      expect(await outbox.processMessage(message)).toBe('completed');
      expect(await ledger()).toMatchObject([{ orderId: created.orderId, uid: 11, orderType: 1,
        payPrice: '50.00', memberPrice: '2.00', postagePrice: '3.00', couponPrice: '0.00', offlinePrice: '0.00' }]);
      expect((await ledger()).length).toBe(1);
      const detail = await new StoreOrderCreateService(r.container, f.env).detail(11, created.orderId);
      expect(detail).toMatchObject({ memberPrice: '2.00', postagePrice: '3.00', payPrice: '50.00' });
      const before = await f.state(), saved = await ledger();
      expect(await outbox.processMessage(message)).toBe('already-completed');
      expect(await ledger()).toEqual(saved); expect(await f.state()).toEqual(before);
    });
  }, 60_000);

  it('does not attribute ordinary level savings to a paid membership ledger', async () => {
    await config({ member_card_status: '0', member_func_status: '1' });
    await f.db.insert(systemUserLevel).values({ id: 990, name: 'Local ordinary level', discount: '80.00', isShow: 1 });
    await f.db.update(user).set({ level: 990, levelStatus: 1 }).where(eq(user.uid, 11));
    await f.withRuntime(async r => {
      const outbox = await wire(r), created = await r.checkout(), message = await pay(r, created.orderId);
      expect(await outbox.processMessage(message)).toBe('completed'); expect(await ledger()).toEqual([]);
      expect(await new StoreOrderCreateService(r.container, f.env).detail(11, created.orderId))
        .toMatchObject({ memberPrice: '0.00', postagePrice: '0.00' });
    });
  }, 60_000);

  it.each(['matching', 'legacy'] as const)('preserves an existing %s ledger without duplication or reconstruction', async mode => {
    await f.withRuntime(async r => {
      const outbox = await wire(r), created = await r.checkout(), message = await pay(r, created.orderId);
      if (mode === 'legacy') {
        const [root] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
        for (const cart of await r.carts(root.id)) {
          const info = JSON.parse(cart.cartInfo!);
          for (const key of ['member_savings_version', 'paid_member', 'member_postage_price', 'member_coupon_price']) delete info[key];
          await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, cart.id));
        }
      }
      await f.db.insert(storeOrderEconomize).values({ uid: 11, orderId: created.orderId, orderType: 1, payPrice: '50.00',
        memberPrice: mode === 'legacy' ? '7.00' : '2.00', postagePrice: '3.00', couponPrice: '0.00', offlinePrice: '0.00', status: 0 });
      const saved = await ledger();
      expect(await outbox.processMessage(message)).toBe('completed'); expect(await ledger()).toEqual(saved);
      expect(await detail(r, created.orderId)).toMatchObject({ memberPrice: mode === 'legacy' ? '7.00' : '2.00', postagePrice: '3.00' });
    });
  }, 60_000);

  it('rolls back economize insertion and all paid effects when the final audit insert fails, then safely retries', async () => {
    await f.withRuntime(async r => {
      const outbox = await wire(r), created = await r.checkout(), message = await pay(r, created.orderId);
      await f.exec(`CREATE FUNCTION reject_member_paid_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.change_type='pay_success' THEN RAISE EXCEPTION 'economize rollback'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_member_paid_audit BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION reject_member_paid_audit()`);
      const before = await f.state(); let failure: unknown;
      try { await outbox.processMessage(message); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error); expect(String((failure as Error).cause ?? failure)).toContain('economize rollback');
      expect(await ledger()).toEqual([]);
      const after = await f.state();
      for (const [table, rows] of Object.entries(before)) if (table !== 'store_order_outbox') expect(after[table], table).toEqual(rows);
      expect((await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, message.outboxId)))[0].status).toBe('FAILED');
      await f.exec('DROP TRIGGER reject_member_paid_audit ON store_order_status; DROP FUNCTION reject_member_paid_audit()');
      expect(await outbox.processMessage(message)).toBe('completed');
      expect(await ledger()).toMatchObject([{ memberPrice: '2.00', postagePrice: '3.00' }]);
      expect((await ledger()).length).toBe(1);
      expect((await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId)))[0].payPrice).toBe('50.00');
    });
  }, 60_000);

  it.each([0, 2])('records only an admitted member coupon (category %s), despite later template edits', async category => {
    await coupon(category);
    await f.withRuntime(async r => {
      const outbox = await wire(r), created = await checkout(r, { couponId: 990 });
      await f.db.update(storeCouponIssue).set({ category: category === 2 ? 0 : 2 }).where(eq(storeCouponIssue.id, 990));
      expect(await outbox.processMessage(await pay(r, created.orderId))).toBe('completed');
      expect(await ledger()).toMatchObject([{ memberPrice: '2.00', postagePrice: '3.00', couponPrice: category === 2 ? '5.00' : '0.00' }]);
      expect(await new PaidMembershipService(r.container, f.env).index(11))
        .toMatchObject({ is_get_free: { user_info: { economize_money: category === 2 ? '10.00' : '5.00' } } });
      expect((await detail(r, created.orderId)).payPrice).toBe('45.00');
    });
  }, 60_000);

  it.each(['offline', 'threshold'] as const)('does not book %s free freight as a member benefit', async mode => {
    await config(mode === 'offline' ? { offline_postage: '1' } : { whole_free_shipping: '1', store_free_postage: '0' });
    await f.withRuntime(async r => {
      const outbox = await wire(r), created = await checkout(r, mode === 'offline' ? { payType: 'offline' } : {});
      let message;
      if (mode === 'offline') {
        const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
        const payment = await applyStoreOrderPayment(r.container, { orderId: order.id, payType: 'offline' });
        expect(payment.outcome).toBe('paid');
        message = { action: 'processOrderPaidOutbox' as const, outboxId: payment.outbox!.id, eventKey: payment.outbox!.eventKey };
      } else message = await pay(r, created.orderId);
      expect(await outbox.processMessage(message)).toBe('completed');
      expect(await ledger()).toMatchObject([{ memberPrice: '2.00', postagePrice: '0.00' }]);
      expect(await detail(r, created.orderId)).toMatchObject({ memberPrice: '2.00', postagePrice: '0.00' });
    });
  }, 60_000);

  it('binds timestamp coupon windows on the real membership reader and filters unavailable issues', async () => {
    const before = new Date(Date.now() - 86_400_000), after = new Date(Date.now() + 86_400_000);
    await f.db.insert(storeCouponIssue).values([
      { id: 991, category: 2, startTime: before, endTime: after },
      { id: 992, category: 2, startTime: null, endTime: null },
      { id: 993, category: 2, startTime: after },
      { id: 994, category: 2, endTime: before },
      { id: 995, category: 0 }, { id: 996, category: 2, status: 0 }, { id: 997, category: 2, isDel: 1 },
    ]);
    await f.withRuntime(async r => {
      await wire(r);
      const coupons = await new PaidMembershipService(r.container, f.env).memberCoupons(11, 1, 50);
      expect(coupons.map(row => row.id).sort()).toEqual([991, 992]);
    });
  }, 60_000);

  it('books only the payment root and reads each supplier/refund child benefit from its own partition', async () => {
    await f.db.insert(systemSupplier).values({ id: 8, adminId: 8, supplierName: 'Local second supplier' });
    await f.db.update(storeProduct).set({ relationId: 8 }).where(eq(storeProduct.id, 71));
    await f.withRuntime(async r => {
      const outbox = await wire(r), created = await r.checkout(), message = await pay(r, created.orderId);
      expect(await outbox.processMessage(message)).toBe('completed');
      const source = (await detail(r, created.orderId)).splitOrders.find(row => row.supplierId === 7)!;
      expect(await detail(r, source.orderId)).toMatchObject({ memberPrice: '2.00', postagePrice: '3.00' });
      const first = await r.apply(source.id); await r.finish(first.refundId);
      const split = await r.receipt(first.refundId);
      for (const id of [split.selectedOrderId, split.remainingOrderId!]) {
        expect(await detail(r, (await r.order(id)).orderId)).toMatchObject({ memberPrice: '1.00', postagePrice: '1.50' });
      }
      const saved = await ledger(); expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ orderId: created.orderId, memberPrice: '2.00', postagePrice: '3.00' });
      // PHP economize is historical gross savings, not net income after refunds.
      expect(await new PaidMembershipService(r.container, f.env).index(11))
        .toMatchObject({ is_get_free: { user_info: { economize_money: '5.00' } } });
      expect(await outbox.processMessage(message)).toBe('already-completed'); expect(await ledger()).toEqual(saved);
      await expect(new StoreOrderCreateService(r.container, f.env).detail(22, source.orderId)).rejects.toThrow('订单不存在');
    });
  }, 60_000);

  it.each(['wrong-owner', 'missing-field'] as const)('rejects %s new evidence without committing paid effects', async kind => {
    await f.withRuntime(async r => {
      const outbox = await wire(r), created = await r.checkout(), message = await pay(r, created.orderId);
      const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId)), [cart] = await r.carts(order.id);
      if (kind === 'wrong-owner') await f.db.update(storeOrderCartInfo).set({ uid: 22 }).where(eq(storeOrderCartInfo.id, cart.id));
      else {
        const info = JSON.parse(cart.cartInfo!); delete info.member_postage_price;
        await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, cart.id));
      }
      const before = await f.state(); await expect(outbox.processMessage(message)).rejects.toThrow('会员');
      expect(await ledger()).toEqual([]);
      const after = await f.state();
      for (const [table, rows] of Object.entries(before)) if (table !== 'store_order_outbox') expect(after[table], table).toEqual(rows);
    });
  }, 60_000);

  it('does not turn a missing INSERT privilege into zero savings or a completed outbox', async () => {
    await f.withRuntime(async r => {
      const outbox = await wire(r), created = await r.checkout(), message = await pay(r, created.orderId);
      await f.exec(`REVOKE INSERT ON store_order_economize FROM "${r.role}"`);
      const before = await f.state(), result = await outcome(outbox.processMessage(message));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        let cause: unknown = result.error; const codes: unknown[] = [];
        for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
          if ('code' in cause) codes.push(cause.code);
          if (!('cause' in cause)) break; cause = cause.cause;
        }
        expect(codes).toContain('42501');
      }
      expect(await ledger()).toEqual([]);
      const after = await f.state();
      for (const [table, rows] of Object.entries(before)) if (table !== 'store_order_outbox') expect(after[table], table).toEqual(rows);
      await f.exec(`GRANT INSERT ON store_order_economize TO "${r.role}"`); // Restore this fixture's original profile only.
      expect(await outbox.processMessage(message)).toBe('completed'); expect(await ledger()).toHaveLength(1);
    });
  }, 60_000);

  it('rejects a conflicting immutable ledger committed during an independently observed outbox lock wait', async () => {
    await f.withRuntime(async r => {
      const outbox = await wire(r), created = await r.checkout(), message = await pay(r, created.orderId);
      await f.withPeer!(async holder => {
        await holder.exec(`BEGIN; SELECT id FROM store_order_outbox WHERE id=${message.outboxId} FOR UPDATE`);
        const processing = outcome(outbox.processMessage(message));
        await waitForFinanceBlock(f.db, r.pid, holder.pid);
        await holder.db.insert(storeOrderEconomize).values({ uid: 11, orderId: created.orderId, payPrice: '50.00', memberPrice: '99.00' });
        await holder.exec('COMMIT');
        const result = await processing; expect(result.ok).toBe(false);
        if (!result.ok) expect(String(result.error)).toContain('会员');
      });
      expect(await ledger()).toMatchObject([{ memberPrice: '99.00' }]); expect(await ledger()).toHaveLength(1);
      expect((await r.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, message.outboxId)))[0].status).toBe('FAILED');
    });
  }, 60_000);

  it('rejects a member-coupon classification edit between source read and transaction admission', async () => {
    await coupon(2);
    await f.withRuntime(async r => {
      await wire(r); const before = await f.state(), transaction = r.db.transaction.bind(r.db);
      vi.spyOn(r.db, 'transaction').mockImplementationOnce(async (fn, options) => {
        await f.db.update(storeCouponIssue).set({ category: 0 }).where(eq(storeCouponIssue.id, 990));
        return transaction(fn, options);
      });
      await expect(checkout(r, { couponId: 990 })).rejects.toThrow('规则已变化');
      expect(await f.state()).toEqual(before); expect(await ledger()).toEqual([]);
      expect((await f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id, 990)))[0].status).toBe(0);
    });
  }, 60_000);
});
