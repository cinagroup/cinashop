import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsPreparedQuery } from 'drizzle-orm/postgres-js';
import type { PreparedQueryConfig } from 'drizzle-orm/pg-core';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { memberRight, systemConfig, storeProduct } from '../src/models/schema';
import { protectCheckoutPricingSources, readCheckoutPricingSources } from '../src/services/order/CheckoutPricingSources';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { withTx } from '../src/lib/di';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('full-ORM checkout pricing SQL authority', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let beforeSequence: (() => Promise<void>) | undefined;
  const pricingKeys = ['member_func_status', 'member_card_status', 'svip_price_status', 'integral_ratio_status',
    'integral_ratio', 'integral_max_type', 'integral_max_num', 'integral_max_rate', 'whole_free_shipping', 'store_free_postage', 'offline_postage'];
  beforeEach(async () => {
    beforeSequence = undefined;
    f = await createPcCheckoutQuoteFixture([], async () => {
      owned = await sequenceRunnerDatabase();
      try {
        const api = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        return owned;
      } catch (error) { await owned.close(); throw error; }
    });
    await f.setConfig(Object.fromEntries([...Object.keys(f.config), ...pricingKeys].map(key => [key, '0'])));
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => {
      await beforeSequence?.(); return new Response('pricing_authority_order');
    } }) } });
  }, 120_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 120_000);
  const setSql = (name: string, value: string) => f.db.update(systemConfig).set({ value }).where(eq(systemConfig.menuName, name));
  const quote = (payType = '') => new StoreOrderCreateService(f.container, f.env).quoteOrder({ uid: 11, cartIds: [1], addressId: 11, payType });
  const request = async (path: string, body: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; errorCode?: string } }>;
  };
  const receipt = async () => {
    const result = await request('/api/order/confirm', { cartIds: [1], addressId: 11 });
    expect(result.status, result.msg).toBe(200); return result.data;
  };
  const create = (r: { orderKey: string; quoteToken: string }) => request(`/api/order/create/${r.orderKey}`, {
    cartIds: [1], addressId: 11, quoteToken: r.quoteToken,
  });

  it('ignores a stale cached free-shipping grant when SQL disables it', async () => {
    f.config.whole_free_shipping = '1';
    expect((await quote()).payPostageCents).toBe(600);
  });
  it('applies SQL free shipping when the cached value is stale-disabled', async () => {
    await setSql('whole_free_shipping', '1');
    expect((await quote()).payPostageCents).toBe(0);
  });
  it('uses the SQL offline-postage switch', async () => {
    await setSql('offline_postage', '1');
    expect((await quote('offline')).payPostageCents).toBe(0);
  });
  it('does not grant cached paid-member express rights after SQL disables the member card', async () => {
    f.config.member_card_status = '1';
    expect((await quote()).payPostageCents).toBe(600);
  });
  it('preserves sort/id precedence, global scope and visibility-independent configuration values', async () => {
    await f.db.insert(systemConfig).values([
      { id: 100, menuName: 'whole_free_shipping', value: '1', sort: 2, status: 0 },
      { id: 101, menuName: 'whole_free_shipping', value: '0', sort: 1, status: 1 },
      { id: 102, menuName: 'whole_free_shipping', value: '0', sort: 99, isStore: 1 },
    ]);
    expect((await quote()).payPostageCents).toBe(0);
  });
  it('requires a new receipt after SQL configuration changes between confirm and create', async () => {
    const r = await receipt(), before = await f.snapshot();
    await setSql('whole_free_shipping', '1');
    const result = await create(r);
    expect(result.status).toBe(400); expect(result.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED');
    expect(await f.snapshot()).toEqual(before);
  });
  it('rolls back creation when a threshold changes after the create request priced its items', async () => {
    f.config.whole_free_shipping = '1'; f.config.store_free_postage = '100';
    await setSql('whole_free_shipping', '1'); await setSql('store_free_postage', '100');
    const r = await receipt(), before = await f.snapshot();
    beforeSequence = async () => { await setSql('store_free_postage', '10'); };
    const result = await create(r);
    expect(result.status).toBe(400); expect(result.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED');
    expect(await f.snapshot()).toEqual(before);
  });
  it('rolls back creation when the selected express entitlement changes after pricing', async () => {
    f.config.member_card_status = '1'; await setSql('member_card_status', '1');
    await f.db.update(storeProduct).set({ isVip: 0 }).where(eq(storeProduct.id, 70));
    expect((await quote()).payPostageCents).toBe(300);
    const r = await receipt(), before = await f.snapshot();
    beforeSequence = async () => { await f.db.update(memberRight).set({ number: 25 }).where(eq(memberRight.id, 2)); };
    const result = await create(r);
    expect(result.status).toBe(400); expect(result.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED');
    expect(await f.snapshot()).toEqual(before);
  });
  it('creates and replays an unchanged SQL-authorized order without repricing the existing order', async () => {
    const r = await receipt(); expect((await create(r)).status).toBe(200);
    const before = await f.snapshot(); expect(before.orders).toHaveLength(1); expect(before.orders[0].payPostage).toBe('6.00');
    await setSql('whole_free_shipping', '1');
    expect((await create(r)).status).toBe(200); expect(await f.snapshot()).toEqual(before);
  });

  it.each(['insert-winner', 'delete-winner', 'rename-winner'] as const)('rejects a %s change after pricing, including duplicate and missing-key defaults', async kind => {
    if (kind !== 'insert-winner') await setSql('whole_free_shipping', '1');
    const r = await receipt(), before = await f.snapshot();
    beforeSequence = async () => {
      if (kind === 'insert-winner') await f.db.insert(systemConfig).values({ id: 100, menuName: 'whole_free_shipping', value: '1', sort: 10 });
      else if (kind === 'delete-winner') await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'whole_free_shipping'));
      else await f.db.update(systemConfig).set({ menuName: 'renamed_shipping' }).where(eq(systemConfig.menuName, 'whole_free_shipping'));
    };
    const result = await create(r); expect(result.status).toBe(400);
    expect(result.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED'); expect(await f.snapshot()).toEqual(before);
  });

  it.each(['config', 'right'] as const)('rejects insertion of an initially absent %s pricing source', async kind => {
    if (kind === 'config') await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'member_card_status'));
    else {
      await setSql('member_card_status', '1'); await f.db.delete(memberRight).where(eq(memberRight.rightType, 'express'));
    }
    const r = await receipt(), before = await f.snapshot();
    beforeSequence = async () => {
      if (kind === 'config') await f.db.insert(systemConfig).values({ id: 100, menuName: 'member_card_status', value: '0' });
      else await f.db.insert(memberRight).values({ id: 100, rightType: 'express', number: 50, status: 1 });
    };
    const result = await create(r); expect(result.status).toBe(400);
    expect(result.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED'); expect(await f.snapshot()).toEqual(before);
  });

  it('allows cosmetic and losing-duplicate changes without inventing a new pricing policy', async () => {
    await setSql('member_card_status', '1');
    const r = await receipt();
    beforeSequence = async () => {
      await f.db.update(systemConfig).set({ status: 1, info: 'display only' });
      await f.db.insert(systemConfig).values({ id: 100, menuName: 'whole_free_shipping', sort: -1, value: '1' });
      await f.db.insert(memberRight).values({ id: 100, rightType: 'express', number: 1, status: 1 });
    };
    expect((await create(r)).status).toBe(200); expect((await f.snapshot()).orders[0].payPostage).toBe('3.00');
  });

  it.each(['system_config', 'member_right'] as const)('rolls back all business writes when %s has a concurrent writer, then permits the unchanged receipt', async table => {
    const connect = owned.withPeer; if (!connect) throw new Error('Dedicated PG16 peers required');
    const r = await receipt(), before = await f.snapshot();
    await connect(async writer => {
      await writer.exec(table === 'system_config' ? "BEGIN; UPDATE system_config SET value=value WHERE menu_name='whole_free_shipping'" : 'BEGIN; UPDATE member_right SET number=number WHERE id=2');
      try {
        const result = await create(r); expect(result.status).toBe(400);
        expect(result.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED'); expect(await f.snapshot()).toEqual(before);
      } finally { await writer.exec('ROLLBACK'); }
    });
    expect((await create(r)).status).toBe(200);
  }, 20_000);

  it.each(['system_config', 'member_right'] as const)('holds the %s fence through commit against a real independent writer', async table => {
    const connect = owned.withPeer; if (!connect) throw new Error('Dedicated PG16 peers required');
    if (table === 'member_right') await setSql('member_card_status', '1');
    const r = await receipt();
    const [buyer] = await f.db.select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(VALUES (1)) buyer(n)`);
    await connect(writer => connect(async observer => {
      expect(new Set([buyer.pid, writer.pid, observer.pid]).size).toBe(3);
      let writing: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> | undefined;
      let fenced = false;
      const execute = PostgresJsPreparedQuery.prototype.execute;
      vi.spyOn(PostgresJsPreparedQuery.prototype, 'execute').mockImplementation(async function (
        this: PostgresJsPreparedQuery<PreparedQueryConfig>, ...args
      ) {
        const statement = this.getQuery().sql, result = await execute.apply(this, args);
        if (!fenced && statement.startsWith('LOCK TABLE "member_right", "system_config"')) {
          fenced = true;
          writing = outcome(writer.exec(table === 'system_config'
            ? "UPDATE system_config SET value='1' WHERE menu_name='whole_free_shipping'"
            : 'UPDATE member_right SET number=25 WHERE id=2'));
          await waitForFinanceBlock(observer.db, writer.pid, buyer.pid);
        }
        return result;
      });
      try { expect((await create(r)).status).toBe(200); } finally { vi.restoreAllMocks(); }
      expect(fenced).toBe(true); expect((await writing)?.ok).toBe(true);
    }));
    expect((await f.snapshot()).orders[0].payPostage).toBe(table === 'system_config' ? '6.00' : '3.00');
    // The purchased cart is consumed; inspect the newly committed authority,
    // rather than attempting to quote that already-paid cart again.
    const current = await readCheckoutPricingSources(f.db);
    if (table === 'system_config') expect(current.values.whole_free_shipping).toBe('1');
    else expect(current.rightRows.find(row => row.rightType === 'express')?.number).toBe(25);
  }, 20_000);

  it('refuses stale-snapshot isolation rather than claiming a late table lock refreshes it', async () => {
    await expect(withTx(f.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await protectCheckoutPricingSources(tx);
    })).rejects.toThrow('READ COMMITTED');
  });
});
