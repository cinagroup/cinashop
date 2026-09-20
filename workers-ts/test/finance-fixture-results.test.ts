import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { financePostgres } from './helpers/financePostgres';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { reserveOrderCartRowIds } from '../src/services/order/OrderCartIdentity';
import { storeOrderCartInfo } from '../src/models/schema';

let f: Awaited<ReturnType<typeof financePostgres>>;
beforeEach(async () => { f = await financePostgres([storeOrderCartInfo]); }, 30_000);
afterEach(async () => { await f?.close(); });

it('returns actual parameterized raw rows and counts without changing mapped builders', async () => {
  const value = "literal ' not SQL";
  const raw = await f.db.execute<{ value: string }>(sql`SELECT ${value}::text AS value`);
  expect(Array.isArray(raw)).toBe(true); expect(raw.map(row => row.value)).toEqual([value]); expect(raw.count).toBe(1);
  const inserted = await f.db.insert(storeOrderCartInfo).values({ oid: 11, uid: 11, cartId: 'original' }).returning();
  expect(inserted).toHaveLength(1); expect(inserted[0]).toMatchObject({ oid: 11, cartId: 'original' });
  const update = await f.db.execute(sql`UPDATE store_order_cart_info SET cart_num=2 WHERE id=${inserted[0].id}`);
  expect(update).toHaveLength(0); expect(update.count).toBe(1);
  expect((await f.db.select().from(storeOrderCartInfo))[0].cartNum).toBe(2);
  expect(await f.db.execute(sql`SELECT id FROM store_order_cart_info WHERE oid=999`)).toHaveLength(0);
});

it('reserves distinct sequence identities inside the real transaction and rejects a connection', async () => {
  await expect(reserveOrderCartRowIds(f.db, 1)).rejects.toThrow('require an order transaction');
  await withTx(createContainerFromDb(f.db), async tx => {
    expect(Object.hasOwn(tx, '$client')).toBe(false);
    const first = await reserveOrderCartRowIds(tx, 2), second = await reserveOrderCartRowIds(tx, 1);
    expect(first).toEqual([1, 2]); expect(second).toEqual([3]);
    await tx.insert(storeOrderCartInfo).values(first.map(id => ({ id, cartId: String(id), oid: 11, uid: 11 })));
    expect((await tx.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM store_order_cart_info`))[0].count).toBe(2);
  });
  expect((await f.db.select().from(storeOrderCartInfo)).map(row => row.id)).toEqual([1, 2]);
});

it('keeps outer rollback and nested savepoint rollback real', async () => {
  await expect(withTx(createContainerFromDb(f.db), async tx => {
    await tx.insert(storeOrderCartInfo).values({ oid: 11, uid: 11, cartId: 'rollback' });
    throw Error('rollback all');
  })).rejects.toThrow('rollback all');
  expect(await f.db.select().from(storeOrderCartInfo)).toEqual([]);
  await withTx(createContainerFromDb(f.db), async tx => {
    const [saved] = await tx.insert(storeOrderCartInfo).values({ oid: 11, uid: 11, cartId: 'keep' }).returning();
    await expect(tx.transaction(async nested => {
      await nested.execute(sql`UPDATE store_order_cart_info SET cart_num=9 WHERE id=${saved.id}`);
      expect((await nested.execute<{ cart_num: number }>(sql`SELECT cart_num FROM store_order_cart_info WHERE id=${saved.id}`))[0].cart_num).toBe(9);
      throw Error('rollback nested');
    })).rejects.toThrow('rollback nested');
    expect((await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, saved.id)))[0].cartNum).toBe(0);
  });
  expect((await f.db.select().from(storeOrderCartInfo))[0]).toMatchObject({ cartId: 'keep', cartNum: 0 });
});

it('propagates SQL errors instead of converting them to empty successful results', async () => {
  await expect(f.db.execute(sql`SELECT * FROM intentionally_missing_fixture_table`)).rejects.toThrow();
  await expect(withTx(createContainerFromDb(f.db), async tx => {
    await tx.insert(storeOrderCartInfo).values({ oid: 11, uid: 11, cartId: 'must-rollback' });
    await tx.execute(sql`SELECT * FROM intentionally_missing_fixture_table`);
  })).rejects.toThrow();
  expect(await f.db.select().from(storeOrderCartInfo)).toEqual([]);
});
