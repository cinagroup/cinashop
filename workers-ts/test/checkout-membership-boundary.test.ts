import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { assertCheckoutMembershipSnapshot } from '../src/services/order/CheckoutMembershipSnapshot';
import { ValidateException } from '../src/utils/errors';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { user, systemUserLevel, storeProduct, storeProductAttrValue, storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers } from './helpers/financePeers';

describe('checkout membership authority', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let beforeSequence: (() => Promise<void>) | undefined;
  let sequence = 0;
  const input = { cartIds: [1], addressId: 11, type: 0 };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([systemUserLevel, storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.setConfig({ member_func_status: '1', member_card_status: '1', svip_price_status: '1' });
    await f.db.insert(systemUserLevel).values([
      { id: 1, name: '等级甲', isShow: 1, discount: '80.00' },
      { id: 2, name: '等级乙', isShow: 1, discount: '70.00' },
    ]);
    await f.db.update(user).set({ level: 1, isEverLevel: 0, isMoneyLevel: 1, overdueTime: Math.floor(Date.now() / 1000) + 3600 });
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => {
      await beforeSequence?.(); return new Response(`member_boundary_${++sequence}`);
    } }) } });
    beforeSequence = undefined;
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const request = async (path: string, body: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; errorCode?: string; pay_price?: string; priceGroup: { pay_price: string } } }>;
  };
  const state = async () => ({ ...await f.snapshot(), levels: await f.db.select().from(systemUserLevel).orderBy(systemUserLevel.id),
    details: await f.db.select().from(storeOrderCartInfo), statuses: await f.db.select().from(storeOrderStatus) });
  const variants = ['paid-expire', 'paid-revoke', 'paid-grant', 'paid-price-revoke', 'level-change', 'level-same-price', 'level-discount', 'level-hide', 'level-restore', 'level-soft-delete', 'level-delete',
    'cosmetic', 'paid-renew', 'paid-forever', 'disabled'] as const;
  type Variant = typeof variants[number];
  const permitted = (variant: Variant) => ['cosmetic', 'paid-renew', 'paid-forever', 'disabled'].includes(variant);
  const prepare = async (variant: Variant) => {
    if (variant === 'paid-grant') await f.db.update(user).set({ isMoneyLevel: 0 });
    if (variant === 'paid-price-revoke') {
      await f.db.update(user).set({ level: 0 });
      await f.db.update(storeProduct).set({ freight: 1, tempId: 0 });
    }
    if (variant === 'level-same-price') await f.db.update(systemUserLevel).set({ discount: '80.00' }).where(eq(systemUserLevel.id, 2));
    if (variant === 'level-restore') await f.db.update(systemUserLevel).set({ isShow: 0 }).where(eq(systemUserLevel.id, 1));
    if (variant === 'disabled') await f.setConfig({ member_func_status: '0', member_card_status: '0', svip_price_status: '0' });
  };
  const edit = async (db: DbClient, variant: Variant) => {
    if (variant === 'level-delete') await db.delete(systemUserLevel).where(eq(systemUserLevel.id, 1));
    else if (variant === 'level-discount' || variant === 'level-hide' || variant === 'level-restore' || variant === 'level-soft-delete' || variant === 'cosmetic') {
      await db.update(systemUserLevel).set(variant === 'level-discount' ? { discount: '70.00' }
        : variant === 'level-restore' ? { isShow: 1 } : variant === 'level-soft-delete' ? { isDel: 1 }
        : variant === 'level-hide' ? { isShow: 0 } : { name: '仅修改展示名称' }).where(eq(systemUserLevel.id, 1));
    } else await db.update(user).set(variant === 'paid-expire' ? { overdueTime: 0 }
      : variant === 'paid-revoke' || variant === 'paid-price-revoke' ? { isMoneyLevel: 0 } : variant === 'paid-grant' ? { isMoneyLevel: 1 }
      : variant === 'level-change' || variant === 'disabled' ? { level: 2, isMoneyLevel: 0 }
      : variant === 'level-same-price' ? { level: 2 }
      : variant === 'paid-forever' ? { isEverLevel: 1, isMoneyLevel: 0, overdueTime: 0 }
      : { overdueTime: Math.floor(Date.now() / 1000) + 7200 }).where(eq(user.uid, 11));
  };
  it.each(variants)('rechecks late HTTP membership %s and permits explicit recovery', async variant => {
    await prepare(variant);
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    let edited: Awaited<ReturnType<typeof state>> | undefined;
    beforeSequence = async () => { await edit(f.db, variant); edited = await state(); };
    const path = `/api/order/create/${receipt.data.orderKey}`;
    const result = await request(path, { ...input, quoteToken: receipt.data.quoteToken });
    if (permitted(variant)) {
      expect(result.status, result.msg).toBe(200);
      expect((await state()).orders).toMatchObject([{ paid: 0, payPrice: receipt.data.priceGroup.pay_price }]);
    } else {
      expect(result).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: receipt.data.orderKey } });
      expect(edited).toBeDefined(); expect(await state()).toEqual(edited);
      beforeSequence = undefined;
      // Repair a dangling reference explicitly; a missing row cannot be protected with a row lock.
      if (variant === 'level-delete') await f.db.update(user).set({ level: 0 }).where(eq(user.uid, 11));
      const refreshed = await request(`/api/order/computed/${receipt.data.orderKey}`, input); expect(refreshed.status, refreshed.msg).toBe(200);
      expect((await request(path, { ...input, quoteToken: refreshed.data.quoteToken })).status).toBe(200);
      expect((await state()).orders).toMatchObject([{ paid: 0, payPrice: refreshed.data.pay_price }]);
    }
  });
  const create = (db: DbClient, receipt: { orderKey: string; quoteToken: string }, useIntegral = false) =>
    new StoreOrderCreateService(createContainerFromDb(db), f.env).createOrder({ ...input, useIntegral,
      uid: 11, key: receipt.orderKey, quoteToken: receipt.quoteToken, userIp: '127.0.0.1' });

  it.each(['55P03', '40P01', '57014', '08006'])('classifies only NOWAIT conflicts, preserving other SQL failures (%s)', async code => {
    const failure = new Error('wrapped driver failure', { cause: { code } });
    vi.spyOn(f.db, 'select').mockImplementationOnce(() => { throw failure; });
    const checking = assertCheckoutMembershipSnapshot(f.db, { uid: 11, paidActive: true, levelId: 0, level: null });
    if (code === '55P03') await expect(checking).rejects.toBeInstanceOf(ValidateException);
    else await expect(checking).rejects.toBe(failure);
  });

  it('replays an already created order after rights change and receipt removal without repricing', async () => {
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const path = `/api/order/create/${receipt.data.orderKey}`;
    const created = await request(path, { ...input, quoteToken: receipt.data.quoteToken }); expect(created.status, created.msg).toBe(200);
    await f.db.update(user).set({ isMoneyLevel: 0, level: 999 });
    f.cache.clear();
    const before = await state();
    expect(await request(path, { ...input, quoteToken: receipt.data.quoteToken })).toEqual(created);
    expect(await state()).toEqual(before);
  });

  it('refuses a dangling level reference until explicitly repaired, without changing business rows', async () => {
    await f.db.update(user).set({ level: 999 });
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    expect(await request(`/api/order/create/${receipt.data.orderKey}`, { ...input, quoteToken: receipt.data.quoteToken }))
      .toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
    expect(await state()).toEqual(before);
    await f.db.update(user).set({ level: 0 });
    const refreshed = await request(`/api/order/computed/${receipt.data.orderKey}`, input); expect(refreshed.status, refreshed.msg).toBe(200);
    expect((await request(`/api/order/create/${receipt.data.orderKey}`, { ...input, quoteToken: refreshed.data.quoteToken })).status).toBe(200);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('does not admit a missing referenced level inserted during checkout', async () => {
    await f.db.update(user).set({ level: 999 });
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = outcome(create(buyer.db, receipt.data));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await editor.exec('BEGIN');
      await editor.db.insert(systemUserLevel).values({ id: 999, discount: '70.00', isShow: 1 });
      const edited = { ...before, levels: await editor.db.select().from(systemUserLevel).orderBy(systemUserLevel.id) };
      await editor.exec('COMMIT'); await holder.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      expect(await state()).toEqual(edited);
    });
  }, 15_000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['user', 'level'] as const)(
    'retains the %s pricing row lock until its owning transaction commits', async target => {
      await f.db.update(user).set({ isEverLevel: 1 });
      const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
      await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
        await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731642,73)');
        // Deliberate outer transaction solely to observe lock ownership after service
        // return, not an example permitting callers to extend time-based admission.
        const buying = outcome(withTx(createContainerFromDb(buyer.db), async tx => {
          const result = await create(tx, receipt.data);
          await tx.execute(sql`SELECT pg_advisory_xact_lock(731642,73)`);
          return result;
        }));
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        const editing = outcome(target === 'user' ? editor.db.update(user).set({ level: 2 }).where(eq(user.uid, 11))
          : editor.db.update(systemUserLevel).set({ discount: '70.00' }).where(eq(systemUserLevel.id, 1)));
        await waitForFinanceBlock(f.db, editor.pid, buyer.pid);
        await holder.exec('COMMIT');
        expect((await buying).ok).toBe(true); expect((await editing).ok).toBe(true);
      });
      expect((await state()).orders).toMatchObject([{ paid: 0, payPrice: receipt.data.priceGroup.pay_price }]);
    }, 15_000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('breaks the user-editor to inventory reverse wait with a precise rollback', async () => {
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = outcome(create(buyer.db, receipt.data));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await editor.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR UPDATE');
      const editing = outcome(editor.db.update(storeProductAttrValue).set({ stock: 9 }).where(eq(storeProductAttrValue.id, 1)));
      await waitForFinanceBlock(f.db, editor.pid, buyer.pid);
      await holder.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      expect((await editing).ok).toBe(true); await editor.exec('COMMIT');
      expect(await state()).toEqual({ ...before, skus: before.skus.map(row => row.id === 1 ? { ...row, stock: 9 } : row) });
    });
  }, 15_000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(variants)(
    'rechecks committed membership %s after a proven late SKU wait on independent PostgreSQL', async variant => {
      await prepare(variant);
      const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
      const before = await state();
      await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
        await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
        const buying = outcome(create(buyer.db, receipt.data));
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        await editor.exec('BEGIN'); await edit(editor.db, variant);
        const edited = { ...before, users: await editor.db.select().from(user), levels: await editor.db.select().from(systemUserLevel).orderBy(systemUserLevel.id) };
        await editor.exec('COMMIT'); await holder.exec('COMMIT');
        const result = await buying; expect(result.ok).toBe(permitted(variant));
        if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
        if (permitted(variant)) expect((await state()).orders).toMatchObject([{ paid: 0, payPrice: receipt.data.priceGroup.pay_price }]);
        else expect(await state()).toEqual(edited);
      });
    }, 15_000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['user', 'level'] as const)(
    'does not wait behind a held %s pricing row at the final boundary', async target => {
      const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
      const before = await state();
      await withFinancePeers(f.db, async ([holder, buyer]) => {
        await holder.exec(target === 'user' ? 'BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR UPDATE'
          : 'BEGIN; SELECT id FROM system_user_level WHERE id=1 FOR UPDATE');
        const result = await outcome(create(buyer.db, receipt.data));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
        await holder.exec('COMMIT');
      });
      expect(await state()).toEqual(before);
    }, 15_000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each([
    ['UTC', 'expires'], ['America/New_York', 'expires'], ['UTC', 'expires-with-integral'], ['America/New_York', 'expires-with-integral'],
    ['UTC', 'valid'], ['America/New_York', 'valid'], ['UTC', 'forever'], ['America/New_York', 'forever'],
  ] as const)('checks the database membership deadline after a late SKU wait (%s, %s)', async (timezone, variant) => {
    await withFinancePeers(f.db, async ([holder, buyer]) => {
      await buyer.db.execute(sql`SELECT set_config('TimeZone', ${timezone}, false)`);
      const [clock] = await f.db.select({ millis: sql<string>`extract(epoch from clock_timestamp()) * 1000` }).from(sql`(values (1)) as probe(n)`);
      const deadline = Math.ceil((Number(clock.millis) + 700) / 1000);
      await f.db.update(user).set({ isEverLevel: variant === 'forever' ? 1 : 0, overdueTime: variant === 'valid' ? deadline + 3600 : deadline });
      const useIntegral = variant === 'expires-with-integral';
      if (useIntegral) await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '50' });
      const receipt = await request('/api/order/confirm', { ...input, useIntegral }); expect(receipt.status, receipt.msg).toBe(200);
      const before = await state();
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = outcome(create(buyer.db, receipt.data, useIntegral));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await waitForFinanceClock(f.db, deadline * 1000); await holder.exec('COMMIT');
      const result = await buying; const allowed = variant === 'valid' || variant === 'forever';
      expect(result.ok).toBe(allowed);
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      if (allowed) expect((await state()).orders).toMatchObject([{ paid: 0, payPrice: receipt.data.priceGroup.pay_price }]);
      else expect(await state()).toEqual(before);
    });
  }, 15_000);
});
