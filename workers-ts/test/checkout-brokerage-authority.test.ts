import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { assertCheckoutBrokerageAuthority } from '../src/services/order/CheckoutBrokerageAuthority';
import { ValidateException } from '../src/utils/errors';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { agentLevel, printDocument, storeOrderCartInfo, storeOrderStatus, storeProduct, storeProductAttrValue,
  user, userBrokerage } from '../src/models/schema';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers } from './helpers/financePeers';

// Epoch-second rounding adds up to another second. The former +1200ms could
// deliberately hold the detail lock for 2.2s, exceeding the application's 2s
// lock_timeout before its clock guard ran. Keep a 0.5-1.5s probe window; never
// relax the business timeout or treat an unrelated SQL timeout as reconfirmation.
const divisionProbeDeadline = (millis: number) => Math.ceil((millis + 500) / 1000);

it('keeps every millisecond phase of the division clock probe below the unchanged 2s business lock timeout', () => {
  for (let phase = 0; phase < 1000; phase++) {
    const millis = 1_700_000_000_000 + phase;
    const wait = divisionProbeDeadline(millis) * 1000 - millis;
    expect(wait).toBeGreaterThanOrEqual(500);
    expect(wait).toBeLessThanOrEqual(1500);
  }
});

describe('checkout brokerage participant authority', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  const input = { cartIds: [1], addressId: 11, type: 0 };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([agentLevel, storeOrderCartInfo, storeOrderStatus, printDocument, userBrokerage]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    Object.assign(f.config, { brokerage_func_status: '1', store_brokerage_statu: '1', brokerage_level: '2',
      brokerage_compute_type: '1', store_brokerage_ratio: '10', store_brokerage_two: '5', division_status: '0' });
    await f.db.update(user).set({ spreadUid: 22 }).where(eq(user.uid, 11));
    await f.db.insert(user).values([
      { uid: 22, account: 'first', isPromoter: 1, spreadOpen: 1, status: 1, spreadUid: 33, agentLevel: 1 },
      { uid: 33, account: 'second', isPromoter: 1, spreadOpen: 1, status: 1, agentLevel: 2 },
      { uid: 44, account: 'division', divisionType: 1, divisionStatus: 1, divisionPercent: 40,
        divisionEndTime: Math.floor(Date.now() / 1000) + 3600 },
    ]);
    await f.db.insert(agentLevel).values([{ id: 1, name: 'first level', oneBrokerage: 50 }, { id: 2, name: 'second level', twoBrokerage: 20 }]);
    await f.db.update(storeProduct).set({ isSub: 0 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ brokerage: '0.30', brokerageTwo: '0.10' }).where(eq(storeProductAttrValue.id, 1));
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => new Response('brokerage_authority_order') }) } });
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const request = async (path: string, body: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; errorCode?: string; pay_price?: string; priceGroup: { pay_price: string } } }>;
  };
  const state = async () => ({ ...await f.snapshot(), levels: await f.db.select().from(agentLevel).orderBy(agentLevel.id),
    details: await f.db.select().from(storeOrderCartInfo), statuses: await f.db.select().from(storeOrderStatus), brokerageRows: await f.db.select().from(userBrokerage) });
  const variants = ['buyer-spread', 'parent-spread', 'first-off', 'second-off', 'promoter-off', 'level-one', 'level-two',
    'level-status', 'level-restore', 'level-delete', 'missing-level-insert', 'first-delete', 'missing-first-insert',
    'division-percent', 'division-revoke', 'division-renew', 'cosmetic', 'disabled', 'specified-unused-level', 'second-disabled', 'mode-two'] as const;
  type Variant = typeof variants[number];
  const permitted = (v: Variant) => ['division-renew', 'cosmetic', 'disabled', 'specified-unused-level', 'second-disabled', 'mode-two'].includes(v);
  const prepare = async (v: Variant) => {
    if (v.startsWith('division')) { f.config.division_status = '1'; await f.db.update(user).set({ divisionId: 44 }).where(eq(user.uid, 11)); }
    if (v === 'level-restore') await f.db.update(agentLevel).set({ status: 0 }).where(eq(agentLevel.id, 1));
    if (v === 'missing-level-insert') await f.db.update(user).set({ agentLevel: 99 }).where(eq(user.uid, 22));
    if (v === 'missing-first-insert') await f.db.update(user).set({ spreadUid: 99 }).where(eq(user.uid, 11));
    if (v === 'disabled') f.config.brokerage_func_status = '0';
    if (v === 'second-disabled') f.config.brokerage_level = '1';
    if (v === 'mode-two') f.config.store_brokerage_statu = '2';
    if (v === 'specified-unused-level') await f.db.update(storeProduct).set({ isSub: 1 }).where(eq(storeProduct.id, 70));
  };
  const edit = async (db: DbClient, v: Variant) => {
    if (v === 'buyer-spread' || v === 'disabled') await db.update(user).set({ spreadUid: 33 }).where(eq(user.uid, 11));
    else if (v === 'parent-spread') await db.update(user).set({ spreadUid: 44 }).where(eq(user.uid, 22));
    else if (v === 'first-off') await db.update(user).set({ spreadOpen: 0 }).where(eq(user.uid, 22));
    else if (v === 'second-off' || v === 'second-disabled') await db.update(user).set({ status: 0 }).where(eq(user.uid, 33));
    else if (v === 'promoter-off' || v === 'mode-two') await db.update(user).set({ isPromoter: 0 }).where(eq(user.uid, 22));
    else if (v === 'level-one' || v === 'specified-unused-level') await db.update(agentLevel).set({ oneBrokerage: 100 }).where(eq(agentLevel.id, 1));
    else if (v === 'level-two') await db.update(agentLevel).set({ twoBrokerage: 100 }).where(eq(agentLevel.id, 2));
    else if (v === 'level-status' || v === 'level-restore') await db.update(agentLevel).set({ status: v === 'level-status' ? 0 : 1 }).where(eq(agentLevel.id, 1));
    else if (v === 'level-delete') await db.delete(agentLevel).where(eq(agentLevel.id, 1));
    else if (v === 'missing-level-insert') await db.insert(agentLevel).values({ id: 99, oneBrokerage: 100 });
    else if (v === 'first-delete') await db.delete(user).where(eq(user.uid, 22));
    else if (v === 'missing-first-insert') await db.insert(user).values({ uid: 99, account: 'inserted', status: 1, spreadOpen: 1, isPromoter: 1 });
    else if (v === 'division-percent') await db.update(user).set({ divisionPercent: 50 }).where(eq(user.uid, 44));
    else if (v === 'division-revoke') await db.update(user).set({ divisionStatus: 0 }).where(eq(user.uid, 44));
    else if (v === 'division-renew') await db.update(user).set({ divisionEndTime: Math.floor(Date.now() / 1000) + 7200 }).where(eq(user.uid, 44));
    else { await db.update(user).set({ nickname: 'new label', brokeragePrice: '1.00' }).where(eq(user.uid, 22));
      await db.update(agentLevel).set({ name: 'new label' }).where(eq(agentLevel.id, 1)); }
  };
  const assertOrder = async (v: Variant) => {
    const after = await state(); expect(after.orders).toHaveLength(1);
    const one = v === 'buyer-spread' ? '2.00' : ['first-off', 'promoter-off', 'first-delete', 'disabled'].includes(v) ? '0.00'
      : v === 'level-one' || v === 'missing-level-insert' ? '4.00'
      : ['level-status', 'level-delete', 'missing-first-insert'].includes(v) ? '2.00'
      : v === 'specified-unused-level' ? '0.60' : '3.00';
    const two = ['buyer-spread', 'parent-spread', 'second-off', 'first-delete', 'missing-first-insert', 'disabled', 'second-disabled'].includes(v) ? '0.00'
      : v === 'level-two' ? '2.00' : v === 'specified-unused-level' ? '0.20' : '1.20';
    expect(after.orders[0]).toMatchObject({ paid: 0, oneBrokerage: one, twoBrokerage: two,
      divisionBrokerage: v === 'division-percent' ? '5.80' : v === 'division-renew' ? '3.80' : '0.00' });
    expect(after.brokerageRows).toEqual([]);
  };
  for (const phase of ['between', 'late'] as const) it.each(variants)(`${phase} actual HTTP participant authority %s`, async v => {
    await prepare(v);
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    let edited: Awaited<ReturnType<typeof state>> | undefined;
    const editing = async () => { await edit(f.db, v); edited = await state(); };
    if (phase === 'between') await editing();
    else {
      // Real SQL edit after the brokerage builder, before the business transaction.
      const transaction = f.db.transaction.bind(f.db);
      vi.spyOn(f.db, 'transaction').mockImplementationOnce(async (fn, config) => { await editing(); return transaction(fn, config); });
    }
    const path = `/api/order/create/${receipt.data.orderKey}`;
    const result = await request(path, { ...input, quoteToken: receipt.data.quoteToken });
    if (phase === 'late' && !permitted(v)) {
      expect(result).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: receipt.data.orderKey } });
      expect(edited).toBeDefined(); expect(await state()).toEqual(edited);
      // Missing references must be explicitly repaired; never invent a receiver/level.
      if (v === 'level-delete') await f.db.update(user).set({ agentLevel: 0 }).where(eq(user.uid, 22));
      if (v === 'first-delete') await f.db.update(user).set({ spreadUid: 0 }).where(eq(user.uid, 11));
      const fresh = await request(`/api/order/computed/${receipt.data.orderKey}`, input); expect(fresh.status, fresh.msg).toBe(200);
      expect(fresh.data.pay_price).toBe(receipt.data.priceGroup.pay_price);
      expect((await request(path, { ...input, quoteToken: fresh.data.quoteToken })).status).toBe(200);
    } else if (phase === 'between' && (v === 'level-delete' || v === 'first-delete')) {
      expect(result.status).toBe(400); expect(await state()).toEqual(edited); return;
    } else expect(result.status, result.msg).toBe(200);
    await assertOrder(v);
    f.cache.clear(); const beforeReplay = await state();
    expect((await request(path, { ...input, quoteToken: receipt.data.quoteToken })).status).toBe(200);
    expect(await state()).toEqual(beforeReplay);
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(variants)('independent PostgreSQL participant authority %s', async v => {
    await prepare(v);
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = outcome(new StoreOrderCreateService(createContainerFromDb(buyer.db), f.env).createOrder({ ...input,
        uid: 11, key: receipt.data.orderKey, quoteToken: receipt.data.quoteToken, userIp: '127.0.0.1' }));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await editor.exec('BEGIN'); await edit(editor.db, v);
      const edited = { ...before, users: await editor.db.select().from(user), levels: await editor.db.select().from(agentLevel).orderBy(agentLevel.id) };
      await editor.exec('COMMIT'); await holder.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(permitted(v));
      if (result.ok) await assertOrder(v);
      else { expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired); expect(await state()).toEqual(edited); }
    });
  }, 15_000);

  const create = (db: DbClient, receipt: { orderKey: string; quoteToken: string }, useIntegral = false) =>
    new StoreOrderCreateService(createContainerFromDb(db), f.env).createOrder({ ...input, useIntegral,
      uid: 11, key: receipt.orderKey, quoteToken: receipt.quoteToken, userIp: '127.0.0.1' });
  const lockTargets = ['buyer', 'first', 'second', 'level-one', 'level-two', 'division'] as const;
  type LockTarget = typeof lockTargets[number];
  const holdTarget = (target: LockTarget) => target === 'level-one' || target === 'level-two'
    ? `SELECT id FROM agent_level WHERE id=${target === 'level-one' ? 1 : 2} FOR UPDATE`
    : `SELECT uid FROM "user" WHERE uid=${target === 'buyer' ? 11 : target === 'first' ? 22 : target === 'second' ? 33 : 44} FOR UPDATE`;
  const updateTarget = (db: DbClient, target: LockTarget) => target.startsWith('level')
    ? db.update(agentLevel).set({ name: 'lock probe' }).where(eq(agentLevel.id, target === 'level-one' ? 1 : 2))
    : db.update(user).set({ nickname: 'lock probe' }).where(eq(user.uid, target === 'buyer' ? 11 : target === 'first' ? 22 : target === 'second' ? 33 : 44));
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(lockTargets)('NOWAIT refuses occupied %s authority without reversing row waits', async target => {
    await prepare('division-renew');
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([holder, buyer]) => {
      await holder.exec(`BEGIN; ${holdTarget(target)}`);
      const result = await outcome(create(buyer.db, receipt.data));
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      expect(await state()).toEqual(before);
      await holder.exec('COMMIT');
    });
  }, 15_000);
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(lockTargets)('holds %s authority through owning transaction commit', async target => {
    await prepare('division-renew');
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731643,73)');
      // Outer transaction observes ownership only, not extended deadline authorization.
      const buying = outcome(withTx(createContainerFromDb(buyer.db), async tx => {
        const result = await create(tx, receipt.data);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731643,73)`); return result;
      }));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      const editing = outcome(updateTarget(editor.db, target));
      await waitForFinanceBlock(f.db, editor.pid, buyer.pid);
      await holder.exec('COMMIT');
      expect((await buying).ok).toBe(true); expect((await editing).ok).toBe(true);
    });
    await assertOrder('division-renew');
  }, 15_000);
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['first', 'level-one', 'division'] as const)(
    'breaks reverse %s editor to inventory wait by rolling back checkout', async target => {
      await prepare('division-renew');
      const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
      const before = await state();
      await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
        await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
        const buying = outcome(create(buyer.db, receipt.data));
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        await editor.exec(`BEGIN; ${holdTarget(target)}`);
        const editing = outcome(editor.db.update(storeProductAttrValue).set({ stock: 9 }).where(eq(storeProductAttrValue.id, 1)));
        await waitForFinanceBlock(f.db, editor.pid, buyer.pid); await holder.exec('COMMIT');
        const result = await buying; expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
        expect((await editing).ok).toBe(true); await editor.exec('COMMIT');
        expect(await state()).toEqual({ ...before, skus: before.skus.map(row => row.id === 1 ? { ...row, stock: 9 } : row) });
      });
    }, 15_000);
  for (const timezone of ['UTC', 'America/New_York']) it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(
    ['expires', 'valid', 'expired', 'specified-unused', 'integral-expires'] as const,
  )(`rechecks division clock after late business wait (${timezone}, %s)`, async variant => {
    await prepare('division-renew');
    const useIntegral = variant === 'integral-expires';
    if (useIntegral) await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '50' });
    if (variant === 'specified-unused') await f.db.update(storeProduct).set({ isSub: 1 }).where(eq(storeProduct.id, 70));
    await withFinancePeers(f.db, async ([holder, buyer]) => {
      await buyer.db.execute(sql`SELECT set_config('TimeZone', ${timezone}, false)`);
      const [clock] = await f.db.select({ millis: sql<string>`extract(epoch from clock_timestamp()) * 1000` }).from(sql`(values (1)) as probe(n)`);
      const deadline = divisionProbeDeadline(Number(clock.millis));
      await f.db.update(user).set({ divisionEndTime: variant === 'valid' ? deadline + 3600 : variant === 'expired' ? deadline - 3600 : deadline }).where(eq(user.uid, 44));
      const receipt = await request('/api/order/confirm', { ...input, useIntegral }); expect(receipt.status, receipt.msg).toBe(200);
      const before = await state();
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = outcome(create(buyer.db, receipt.data, useIntegral));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      if (variant === 'expires' || variant === 'integral-expires') {
        const [barrier] = await f.db.select({ beforeDeadline: sql<boolean>`extract(epoch from clock_timestamp()) * 1000 < ${deadline * 1000}` })
          .from(sql`(values (1)) as probe(n)`);
        expect(barrier.beforeDeadline, 'expiry must occur after the observed business lock wait begins').toBe(true);
      }
      await waitForFinanceClock(f.db, deadline * 1000); await holder.exec('COMMIT');
      const result = await buying;
      // Preserve the actual failure when a positive control unexpectedly rejects.
      if (variant !== 'expires' && variant !== 'integral-expires' && !result.ok) throw result.error;
      expect(result.ok).toBe(variant !== 'expires' && variant !== 'integral-expires');
      if (!result.ok) { expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired); expect(await state()).toEqual(before); }
      else await assertOrder(variant === 'specified-unused' ? 'specified-unused-level' : variant === 'expired' ? 'division-revoke' : 'division-renew');
    });
  }, 15_000);
  it.each(['55P03', '40P01', '57014', '08006'])('only converts NOWAIT errors and preserves unrelated SQL failures (%s)', async code => {
    const failure = new Error('wrapped driver failure', { cause: { code } });
    vi.spyOn(f.db, 'select').mockImplementationOnce(() => { throw failure; });
    const checking = assertCheckoutBrokerageAuthority(f.db, { accounts: [{ uid: 11 }], levels: [], missingReference: false, divisionClocks: [], paidOrders: [] });
    if (code === '55P03') await expect(checking).rejects.toBeInstanceOf(ValidateException);
    else await expect(checking).rejects.toBe(failure);
  });
  const divisionRoles = ['staff', 'agent', 'division', 'self', 'overlap', 'missing-staff'] as const;
  type DivisionRole = typeof divisionRoles[number];
  const prepareRole = async (role: DivisionRole) => {
    f.config.division_status = '1';
    const end = Math.floor(Date.now() / 1000) + 3600;
    await f.db.update(user).set({ staffId: role === 'self' ? 11 : role === 'overlap' ? 22 : 55, agentId: 66, divisionId: 44,
      ...(role === 'self' ? { divisionType: 3, divisionStatus: 1, divisionPercent: 20, divisionEndTime: end, isPromoter: 1, spreadOpen: 1 } : {}) }).where(eq(user.uid, 11));
    if (role === 'self') f.config.is_self_brokerage = '1';
    if (role === 'overlap') await f.db.update(user).set({ divisionPercent: 30, divisionStatus: 1, divisionEndTime: end }).where(eq(user.uid, 22));
    if (role !== 'missing-staff') await f.db.insert(user).values({ uid: 55, account: 'staff', divisionPercent: 30, divisionStatus: 1, divisionEndTime: end });
    await f.db.insert(user).values({ uid: 66, account: 'agent', divisionPercent: 35, divisionStatus: 1, divisionEndTime: end });
  };
  const editRole = (db: DbClient, role: DivisionRole) => role === 'missing-staff'
    ? db.insert(user).values({ uid: 55, account: 'inserted-staff', divisionPercent: 30, divisionStatus: 1, divisionEndTime: Math.floor(Date.now() / 1000) + 3600 })
    : db.update(user).set({ divisionPercent: role === 'self' ? 21 : role === 'agent' ? 36 : role === 'division' ? 41 : 31 })
      .where(eq(user.uid, role === 'self' ? 11 : role === 'agent' ? 66 : role === 'division' ? 44 : role === 'overlap' ? 22 : 55));
  it.each(divisionRoles)('actual HTTP captures used division rate role %s and explicit recovery', async role => {
    await prepareRole(role);
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    let edited: Awaited<ReturnType<typeof state>> | undefined;
    const transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, 'transaction').mockImplementationOnce(async (fn, config) => {
      await editRole(f.db, role); edited = await state(); return transaction(fn, config);
    });
    const path = `/api/order/create/${receipt.data.orderKey}`;
    expect(await request(path, { ...input, quoteToken: receipt.data.quoteToken })).toMatchObject({
      status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' },
    });
    expect(edited).toBeDefined(); expect(await state()).toEqual(edited);
    const fresh = await request(`/api/order/computed/${receipt.data.orderKey}`, input); expect(fresh.status, fresh.msg).toBe(200);
    expect(fresh.data.pay_price).toBe(receipt.data.priceGroup.pay_price);
    expect((await request(path, { ...input, quoteToken: fresh.data.quoteToken })).status).toBe(200);
    const after = await state(); expect(after.orders).toHaveLength(1);
    expect(after.orders[0]).toMatchObject({ paid: 0,
      oneBrokerage: role === 'self' || role === 'overlap' ? '0.00' : '3.00',
      twoBrokerage: role === 'self' || role === 'overlap' ? '0.00' : '1.20',
      divisionStaffBrokerage: role === 'self' ? '4.20' : role === 'overlap' ? '6.20' : role === 'staff' ? '2.00' : '1.80',
      divisionAgentBrokerage: role === 'self' ? '2.80' : role === 'agent' ? '1.20' : role === 'staff' || role === 'overlap' ? '0.80' : '1.00',
      divisionBrokerage: role === 'agent' ? '0.80' : role === 'division' ? '1.20' : '1.00',
    });
    expect(after.brokerageRows).toEqual([]);
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(divisionRoles)('independent PostgreSQL used division rate role %s', async role => {
    await prepareRole(role);
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = outcome(create(buyer.db, receipt.data));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await editor.exec('BEGIN'); await editRole(editor.db, role);
      const edited = { ...before, users: await editor.db.select().from(user) };
      await editor.exec('COMMIT'); await holder.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      expect(await state()).toEqual(edited);
    });
  }, 15_000);
  for (const timezone of ['UTC', 'America/New_York']) it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['expires', 'valid'] as const)(
    `evaluates division clock after authority locks and subsequent shipping SQL wait (${timezone}, %s)`, async variant => {
      await prepare('division-renew');
      await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
        await buyer.db.execute(sql`SELECT set_config('TimeZone', ${timezone}, false)`);
        const [clock] = await f.db.select({ millis: sql<string>`extract(epoch from clock_timestamp()) * 1000` }).from(sql`(values (1)) as probe(n)`);
        const deadline = Math.ceil((Number(clock.millis) + 700) / 1000);
        await f.db.update(user).set({ divisionEndTime: variant === 'valid' ? deadline + 3600 : deadline }).where(eq(user.uid, 44));
        const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
        const before = await state();
        await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
        const buying = outcome(create(buyer.db, receipt.data));
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        // Initial shipping reads are already complete. This blocks only the last
        // shipping snapshot SELECT, after the new authority locks have been acquired.
        await editor.exec('BEGIN; LOCK TABLE shipping_templates_free IN ACCESS EXCLUSIVE MODE');
        await holder.exec('COMMIT'); await waitForFinanceBlock(f.db, buyer.pid, editor.pid);
        await waitForFinanceClock(f.db, deadline * 1000); await editor.exec('COMMIT');
        const result = await buying; expect(result.ok).toBe(variant === 'valid');
        if (!result.ok) { expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired); expect(await state()).toEqual(before); }
        else await assertOrder('division-renew');
      });
    }, 15_000);
});
