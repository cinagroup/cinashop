import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { user, storeOrder } from '../src/models/schema';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { BROKERAGE_PAID_ORDER_FENCE_SQL } from '../src/migrations/brokeragePaidOrderFence';
import { runBrokeragePaidOrderFence } from '../src/migrations/runBrokeragePaidOrderFence';

it('keeps the standalone paid-order fence SQL identical to its Worker-compatible module', () => {
  expect(readFileSync(new NodeURL('../migrations/0150_brokerage_paid_order_fence.sql', import.meta.url), 'utf8').trim())
    .toBe(BROKERAGE_PAID_ORDER_FENCE_SQL.trim());
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('paid-order write fence on independent PostgreSQL 16', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let schema: string;
  beforeEach(async () => {
    f = await financePostgres([user, storeOrder]);
    const [identity] = await f.db.select({ schema: sql<string>`current_schema()` }).from(sql`(values (1)) as probe(n)`);
    schema = identity.schema;
    await f.db.insert(user).values([{ uid: 11, account: 'fence-first' }, { uid: 22, account: 'fence-second' }]);
    await f.db.insert(storeOrder).values([
      { id: 1001, uid: 11, orderId: 'first-paid', paid: 1, payPrice: '60.00' },
      { id: 1002, uid: 22, orderId: 'second-paid', paid: 1, payPrice: '70.00' },
    ]);
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const install = () => runBrokeragePaidOrderFence(f.db, schema);
  const state = async () => ({ users: await f.db.select().from(user).orderBy(user.uid), orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id) });
  const totals = async () => {
    const rows = await f.db.select({ uid: storeOrder.uid, total: sql<string>`SUM(pay_price)::text` }).from(storeOrder)
      .where(sql`pid<>-1 AND paid=1 AND is_del=0 AND refund_status IN (0,3) AND uid>0`).groupBy(storeOrder.uid);
    const byId = new Map(rows.map(row => [row.uid, Number(row.total)])); return [byId.get(11) ?? 0, byId.get(22) ?? 0];
  };
  const catalog = async () => f.db.select({ name: sql<string>`tgname`, oid: sql<number>`oid::int`, enabled: sql<string>`tgenabled` })
    .from(sql`pg_catalog.pg_trigger`).where(sql`tgrelid='store_order'::regclass AND NOT tgisinternal`).orderBy(sql`tgname`);
  const functionCatalog = async () => f.db.select({ oid: sql<number>`p.oid::int`, body: sql<string>`p.prosrc`, settings: sql<string[]>`p.proconfig` })
    .from(sql`pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace`)
    .where(sql`n.nspname=${schema} AND p.proname='brokerage_paid_order_fence_0150'`);
  const failures = (error: unknown): string => {
    const messages: string[] = []; let current = error;
    for (let i = 0; i < 8 && current && typeof current === 'object'; i++) {
      if ('message' in current) messages.push(String(current.message));
      if (!('cause' in current) || current.cause === current) break; current = current.cause;
    }
    return messages.join('\n');
  };
  it('installs and repeats without changing orders/users, function or trigger identities', async () => {
    const before = await state(); await install(); const first = await catalog();
    const firstFunctions = await functionCatalog(); expect(firstFunctions).toHaveLength(1);
    expect(first.map(row => row.name)).toEqual(['brokerage_paid_delete_0150', 'brokerage_paid_insert_0150', 'brokerage_paid_update_0150']);
    await install(); expect(await catalog()).toEqual(first); expect(await functionCatalog()).toEqual(firstFunctions); expect(await state()).toEqual(before);
  });
  const variants = [
    ['paid-insert', true, [70,70]], ['pay-unpaid', true, [70,70]], ['delete', true, [0,70]],
    ['amount', true, [61,70]], ['refund-remove', true, [0,70]], ['refund-restore', true, [60,70]],
    ['soft-delete', true, [0,70]], ['restore', true, [60,70]], ['split-parent', true, [0,70]],
    ['unsplit', true, [60,70]], ['uid-transfer', true, [0,130]], ['metadata', false, [60,70]],
    ['same-sum-batch', false, [100,70]], ['unpaid-insert', false, [60,70]], ['other-user', false, [60,80]],
    ['same-price', false, [60,70]], ['refund-equivalent', false, [60,70]], ['guest', false, [60,70]],
    ['before-trigger', true, [70,70]], ['upsert', true, [72,70]], ['conflict-nothing', false, [60,70]],
  ] as const;
  type Variant = typeof variants[number][0];
  const prepare = async (v: Variant) => {
    if (v === 'pay-unpaid' || v === 'before-trigger') await f.db.insert(storeOrder).values({ id: 1003, uid: 11, paid: 0, payPrice: '10.00', orderId: 'initial-unpaid' });
    if (v === 'refund-restore') await f.db.update(storeOrder).set({ refundStatus: 1 }).where(eq(storeOrder.id, 1001));
    if (v === 'restore') await f.db.update(storeOrder).set({ isDel: 1 }).where(eq(storeOrder.id, 1001));
    if (v === 'unsplit') await f.db.update(storeOrder).set({ pid: -1 }).where(eq(storeOrder.id, 1001));
    if (v === 'same-sum-batch') await f.db.insert(storeOrder).values({ id: 1003, uid: 11, paid: 1, payPrice: '40.00', orderId: 'batch-second' });
    if (v === 'before-trigger') await f.exec(`CREATE FUNCTION fixture_mark_paid() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=1003 THEN NEW.paid := 1; END IF; RETURN NEW; END $$;
      CREATE TRIGGER zz_fixture_mark_paid BEFORE UPDATE OF mark ON store_order FOR EACH ROW EXECUTE FUNCTION fixture_mark_paid()`);
  };
  const editSql = (v: Variant) => {
    switch (v) {
      case 'paid-insert': return "INSERT INTO store_order(id,uid,paid,pay_price,order_id) VALUES (1003,11,1,10,'added')";
      case 'pay-unpaid': return 'UPDATE store_order SET paid=1 WHERE id=1003';
      case 'delete': return 'DELETE FROM store_order WHERE id=1001';
      case 'amount': return 'UPDATE store_order SET pay_price=61 WHERE id=1001';
      case 'refund-remove': return 'UPDATE store_order SET refund_status=1 WHERE id=1001';
      case 'refund-restore': return 'UPDATE store_order SET refund_status=0 WHERE id=1001';
      case 'soft-delete': return 'UPDATE store_order SET is_del=1 WHERE id=1001';
      case 'restore': return 'UPDATE store_order SET is_del=0 WHERE id=1001';
      case 'split-parent': return 'UPDATE store_order SET pid=-1 WHERE id=1001';
      case 'unsplit': return 'UPDATE store_order SET pid=0 WHERE id=1001';
      case 'uid-transfer': return 'UPDATE store_order SET uid=22 WHERE id=1001';
      case 'metadata': return "UPDATE store_order SET mark='label only' WHERE id=1001";
      case 'same-sum-batch': return 'UPDATE store_order SET pay_price=CASE id WHEN 1001 THEN 65 ELSE 35 END WHERE id IN (1001,1003)';
      case 'unpaid-insert': return "INSERT INTO store_order(id,uid,paid,pay_price,order_id) VALUES (1003,11,0,10,'unpaid')";
      case 'other-user': return 'UPDATE store_order SET pay_price=80 WHERE id=1002';
      case 'same-price': return 'UPDATE store_order SET pay_price=60 WHERE id=1001';
      case 'refund-equivalent': return 'UPDATE store_order SET refund_status=3 WHERE id=1001';
      case 'guest': return "INSERT INTO store_order(id,uid,paid,pay_price,order_id) VALUES (1003,0,1,10,'guest')";
      case 'before-trigger': return "UPDATE store_order SET mark='paid by trigger' WHERE id=1003";
      case 'upsert': return "INSERT INTO store_order(id,uid,paid,pay_price) VALUES (1001,11,1,72) ON CONFLICT(id) DO UPDATE SET pay_price=EXCLUDED.pay_price";
      case 'conflict-nothing': return 'INSERT INTO store_order(id,uid,paid,pay_price) VALUES (1001,11,1,999) ON CONFLICT(id) DO NOTHING';
    }
  };
  it.each(variants)('fences net contribution edits but not unused changes (%s)', async (v, blocks, expectedTotals) => {
    await prepare(v); await install(); const beforeUsers = (await state()).users;
    await withFinancePeers(f.db, async ([reader, writer]) => {
      await reader.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR SHARE');
      const oldTotals = await totals(); const writing = outcome(writer.exec(editSql(v)));
      if (blocks) { await waitForFinanceBlock(f.db, writer.pid, reader.pid); expect(await totals()).toEqual(oldTotals); await reader.exec('COMMIT'); }
      expect((await writing).ok).toBe(true);
      if (!blocks) await reader.exec('COMMIT');
    });
    expect(await totals()).toEqual(expectedTotals); expect((await state()).users).toEqual(beforeUsers);
  }, 15_000);
  it('locks both old and new owners on a paid-order transfer', async () => {
    await install();
    await withFinancePeers(f.db, async ([reader, writer]) => {
      await reader.exec('BEGIN; SELECT uid FROM "user" WHERE uid=22 FOR SHARE');
      const writing = outcome(writer.exec('UPDATE store_order SET uid=22 WHERE id=1001'));
      await waitForFinanceBlock(f.db, writer.pid, reader.pid); expect(await totals()).toEqual([60,70]);
      await reader.exec('COMMIT'); expect((await writing).ok).toBe(true);
    });
    expect(await totals()).toEqual([0,130]);
  }, 15_000);
  it('locks batch owners in uid order, including when input rows are reversed', async () => {
    await install();
    await withFinancePeers(f.db, async ([highOwner, writer, lowEditor]) => {
      await highOwner.exec('BEGIN; SELECT uid FROM "user" WHERE uid=22 FOR SHARE');
      const writing = outcome(writer.exec("INSERT INTO store_order(id,uid,paid,pay_price) VALUES (1003,22,1,10),(1004,11,1,10)"));
      await waitForFinanceBlock(f.db, writer.pid, highOwner.pid);
      const editing = outcome(lowEditor.exec('UPDATE "user" SET nickname=\'low lock probe\' WHERE uid=11'));
      await waitForFinanceBlock(f.db, lowEditor.pid, writer.pid);
      await highOwner.exec('COMMIT'); expect((await writing).ok).toBe(true); expect((await editing).ok).toBe(true);
    });
    expect(await totals()).toEqual([70,80]);
  }, 15_000);
  it('holds writer ownership until commit and rolls back contribution changes exactly', async () => {
    await install(); const before = await state();
    await withFinancePeers(f.db, async ([reader, writer, observer]) => {
      await writer.exec('BEGIN; UPDATE store_order SET pay_price=61 WHERE id=1001');
      expect(await totals()).toEqual([60,70]);
      const reading = outcome(reader.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR SHARE'));
      await waitForFinanceBlock(f.db, reader.pid, writer.pid);
      const [guard] = await observer.db.select({ held: sql<boolean>`EXISTS (SELECT 1 FROM pg_locks WHERE pid=${writer.pid} AND locktype='transactionid' AND granted)` }).from(sql`(values (1)) as probe(n)`);
      expect(guard.held).toBe(true); await writer.exec('ROLLBACK'); expect((await reading).ok).toBe(true); await reader.exec('COMMIT');
    });
    expect(await state()).toEqual(before);
  }, 15_000);
  it('permits the owning user-write transaction to mutate paid orders without self-deadlock', async () => {
    await install();
    await withFinancePeers(f.db, async ([writer]) => {
      await writer.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR UPDATE; UPDATE store_order SET pay_price=61 WHERE id=1001; COMMIT');
    });
    expect(await totals()).toEqual([61,70]);
  });
  it('prevents positive missing-user contributions without manufacturing an account', async () => {
    await install(); const before = await state();
    const writing = await outcome(f.exec('INSERT INTO store_order(id,uid,paid,pay_price) VALUES (1003,99,1,10)'));
    expect(writing.ok).toBe(false); if (!writing.ok) expect(failures(writing.error)).toContain('missing positive user');
    expect(await state()).toEqual(before);
  });
  it('uses relation locking to keep TRUNCATE after a reader transaction', async () => {
    await install();
    await withFinancePeers(f.db, async ([reader, writer]) => {
      await reader.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR SHARE; SELECT SUM(pay_price) FROM store_order');
      const writing = outcome(writer.exec('TRUNCATE store_order'));
      await waitForFinanceBlock(f.db, writer.pid, reader.pid); await reader.exec('COMMIT'); expect((await writing).ok).toBe(true);
    });
    expect(await totals()).toEqual([0,0]);
  }, 15_000);
  it.each(['disabled-trigger', 'function-body', 'rls', 'column-type', 'dangling-user'] as const)('refuses migration drift without mutating business rows (%s)', async drift => {
    if (drift === 'disabled-trigger' || drift === 'function-body') await install();
    if (drift === 'disabled-trigger') await f.exec('ALTER TABLE store_order DISABLE TRIGGER brokerage_paid_update_0150');
    if (drift === 'function-body') await f.exec('CREATE OR REPLACE FUNCTION brokerage_paid_order_fence_0150() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RETURN NULL; END $$');
    if (drift === 'rls') await f.exec('ALTER TABLE store_order ENABLE ROW LEVEL SECURITY');
    if (drift === 'column-type') await f.exec('ALTER TABLE store_order ALTER COLUMN pay_price TYPE numeric(14,2)');
    if (drift === 'dangling-user') await f.exec('INSERT INTO store_order(id,uid,paid,pay_price) VALUES (1003,99,1,10)');
    const before = await state(); const beforeCatalog = await catalog(); const beforeFunctions = await functionCatalog(); const result = await outcome(install());
    expect(result.ok).toBe(false); if (!result.ok) expect(failures(result.error)).toContain('0150');
    expect(await state()).toEqual(before); expect(await catalog()).toEqual(beforeCatalog); expect(await functionCatalog()).toEqual(beforeFunctions);
  });
  it('repairs only a missing matching trigger while preserving existing definitions and data', async () => {
    await install(); const before = await state();
    await f.exec('DROP TRIGGER brokerage_paid_update_0150 ON store_order'); const prior = await catalog();
    await install(); expect(await catalog()).toEqual(expect.arrayContaining(prior)); expect(await catalog()).toHaveLength(3);
    expect(await state()).toEqual(before);
  });
  it('rejects schema injection before invoking any migration SQL', async () => {
    await expect(runBrokeragePaidOrderFence(f.db, 'public; SELECT 1')).rejects.toThrow('Invalid paid-order fence schema');
    expect(await catalog()).toEqual([]);
  });
  it('records the pre-migration gap: a user SHARE lock alone does not freeze the paid-order set', async () => {
    await withFinancePeers(f.db, async ([reader, writer]) => {
      await reader.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR SHARE');
      // Deliberately no migration: completion while the reader still owns its lock
      // is baseline gap evidence, NOT a safe-read-path success claim.
      await writer.exec("INSERT INTO store_order(id,uid,paid,pay_price) VALUES (1003,11,1,10)");
      expect(await totals()).toEqual([70,70]); await reader.exec('COMMIT');
    });
  });
  it('allows zero-contribution missing-user rows without inventing a recipient', async () => {
    await install(); await f.exec('INSERT INTO store_order(id,uid,paid,pay_price) VALUES (1003,99,1,0)');
    expect(await totals()).toEqual([60,70]); expect((await state()).users.map(row => row.uid)).toEqual([11,22]);
  });
  it('rejects a nested/non-root runner before calling its transaction method', async () => {
    await expect(runBrokeragePaidOrderFence({ transaction: f.db.transaction.bind(f.db) }, schema))
      .rejects.toThrow('requires a root database'); expect(await catalog()).toEqual([]);
  });
  it('bounds maintenance lock waits and rolls back incomplete installation', async () => {
    const before = await state();
    await withFinancePeers(f.db, async ([holder, migrator]) => {
      await holder.exec('BEGIN; UPDATE "user" SET nickname=\'held maintenance\' WHERE uid=11');
      const installing = outcome(runBrokeragePaidOrderFence(migrator.db, schema));
      await waitForFinanceBlock(f.db, migrator.pid, holder.pid);
      const result = await installing; expect(result.ok).toBe(false);
      if (!result.ok) expect(failures(result.error)).toContain('lock timeout');
      expect(await catalog()).toEqual([]); expect(await functionCatalog()).toEqual([]);
      await holder.exec('ROLLBACK');
    });
    expect(await state()).toEqual(before);
  }, 15_000);
});
