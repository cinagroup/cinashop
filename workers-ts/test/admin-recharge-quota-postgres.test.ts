import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainerFromDb } from '../src/lib/di';
import { systemGroupData } from '../src/models/schema';
import { AdminRechargeQuotaService, type RechargeQuotaOperation } from '../src/services/admin/AdminRechargeQuotaService';
import { UserFinanceService } from '../src/services/user/UserFinanceService';
import { applyRechargePayment } from '../src/services/payment/RechargePaymentService';
import { quotaInput, quotaValue, rechargeQuotaFixture } from './helpers/rechargeQuotaFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('recharge quota serialization on owned PostgreSQL 16', () => {
  let f: Awaited<ReturnType<typeof rechargeQuotaFixture>>;
  const actor = { id: 2 };
  beforeEach(async () => { f = await rechargeQuotaFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);

  for (const operation of ['update', 'status', 'delete'] as const) {
    it.each(['admin-first', 'order-first'] as const)(`${operation} versus package order: %s`, async order => {
      const body = { request_id: crypto.randomUUID(), revision: await f.revision(),
        ...(operation === 'update' ? { ...quotaInput, price: '150.00', give_money: '20.00' } : operation === 'status' ? { status: 0 } : {}) };
      await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
        await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731642,1)');
        try {
          const adminPeer = order === 'admin-first' ? firstPeer : secondPeer;
          const orderPeer = order === 'admin-first' ? secondPeer : firstPeer;
          const adminRun = () => outcome(new AdminRechargeQuotaService(createContainerFromDb(adminPeer.db)).mutate(operation, 101, body, actor));
          const orderRun = () => outcome(new UserFinanceService(createContainerFromDb(orderPeer.db)).recharge(10, 0.01, 'h5', 101));
          let administrative: ReturnType<typeof adminRun>, purchase: ReturnType<typeof orderRun>;
          if (order === 'admin-first') {
            administrative = adminRun(); await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
            purchase = orderRun(); await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
          } else {
            purchase = orderRun(); await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
            administrative = adminRun(); await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
          }
          await blocker.exec('COMMIT');
          expect((await administrative).ok).toBe(true);
          const bought = await purchase;
          expect(bought.ok).toBe(order === 'order-first' || operation === 'update');
          if (bought.ok) expect(bought.value.price).toBe(order === 'order-first' ? '100.00' : '150.00');
        } finally { await blocker.exec('ROLLBACK'); }
      });
      const after = await f.snapshot(); expect(after.logs).toHaveLength(1);
      const createsOrder = order === 'order-first' || operation === 'update';
      expect(after.orders).toHaveLength(createsOrder ? 1 : 0);
      if (createsOrder) {
        const expectedPrice = order === 'order-first' ? 10000 : 15000;
        expect(after.orders[0]).toMatchObject({ price: order === 'order-first' ? '100.00' : '150.00', givePrice: order === 'order-first' ? '10.00' : '20.00' });
        const payment = { orderId: after.orders[0].orderId, payType: 'weixin' as const, tradeNo: `fixture-${operation}-${order}`, expectedAmountCents: expectedPrice };
        expect((await applyRechargePayment(f.container, payment)).outcome).toBe('paid');
        expect((await applyRechargePayment(f.container, payment)).outcome).toBe('already-paid');
        const settled = await f.snapshot(); expect(settled.bills).toHaveLength(1);
        expect(settled.users[0].nowMoney).toBe(order === 'order-first' ? '115.00' : '175.00');
      }
    });
  }

  it.each(['capacity', 'same-request'] as const)('serializes concurrent creates: %s', async mode => {
    if (mode === 'capacity') await f.db.insert(systemGroupData).values(Array.from({ length: 17 }, (_, n) => ({ id: 200 + n, gid: 77, value: quotaValue(), status: 0 })));
    const body = { ...quotaInput, request_id: crypto.randomUUID() };
    await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731642,1)');
      try {
        const first = outcome(new AdminRechargeQuotaService(createContainerFromDb(firstPeer.db)).mutate('create', 0, body, actor));
        await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
        const second = outcome(new AdminRechargeQuotaService(createContainerFromDb(secondPeer.db)).mutate('create', 0,
          mode === 'same-request' ? body : { ...body, request_id: crypto.randomUUID() }, actor));
        await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid); await blocker.exec('COMMIT');
        const a = await first, b = await second;
        expect(a.ok).toBe(true); expect(b.ok).toBe(mode === 'same-request');
        if (a.ok && b.ok) expect(b.value).toEqual(a.value);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const after = await f.snapshot(); expect(after.logs).toHaveLength(1);
    expect(after.quotas.filter(row => row.gid === 77)).toHaveLength(mode === 'same-request' ? 3 : 20);
  });

  it('allows only the first of conflicting versioned update/delete confirmations', async () => {
    const revision = await f.revision();
    await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731642,1)');
      try {
        const run = (peer: typeof firstPeer, operation: RechargeQuotaOperation) => outcome(new AdminRechargeQuotaService(createContainerFromDb(peer.db))
          .mutate(operation, 101, { revision, request_id: crypto.randomUUID(), ...(operation === 'update' ? { ...quotaInput, price: '150' } : {}) }, actor));
        const first = run(firstPeer, 'update'); await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
        const second = run(secondPeer, 'delete'); await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
        await blocker.exec('COMMIT'); expect((await first).ok).toBe(true); expect((await second).ok).toBe(false);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    expect((await f.request('/101')).body.data.price).toBe('150.00'); expect((await f.snapshot()).logs).toHaveLength(1);
  });
});
