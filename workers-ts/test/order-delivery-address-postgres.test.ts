import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { StoreOrderCreateService, type CreateOrderParams } from '../src/services/order/StoreOrderCreateService';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { storeOrderCartInfo, storeOrderStatus, printDocument, storeProduct } from '../src/models/schema';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('delivery address independent PostgreSQL boundaries', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  const params: CreateOrderParams = { uid: 11, key: 'address_pg', cartIds: [1], shippingType: 1,
    addressId: 11, userIp: '127.0.0.1' };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    // No template binding: address protection must not depend on template locks.
    await f.db.update(storeProduct).set({ freight: 1, tempId: 0 });
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const create = (db: DbClient) => StoreOrderCreateService.createWithRuntime(createContainerFromDb(db),
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => params.key }, params);
  const state = async () => ({ ...await f.snapshot(), details: await f.db.select().from(storeOrderCartInfo),
    statuses: await f.db.select().from(storeOrderStatus) });

  it.each(['address', 'deleted', 'region', 'ancestor'] as const)('refuses an uncommitted %s editor and rolls back all order writes', async kind => {
    const before = await state();
    await withFinancePeers(f.db, async ([editor, buyer]) => {
      const update = kind === 'address' ? "UPDATE user_address SET detail='pending' WHERE id=11"
        : kind === 'deleted' ? 'UPDATE user_address SET is_del=1 WHERE id=11'
        : kind === 'region' ? "UPDATE city_area SET name='pending' WHERE id=101"
        : "UPDATE city_area SET name='pending' WHERE id=901";
      await editor.exec('BEGIN; ' + update);
      expect(await outcome(create(buyer.db))).toMatchObject({ ok: false, error: { message: expect.stringContaining('收货地址正在更新') } });
      expect(await state()).toEqual(before);
      await editor.exec('ROLLBACK');
    });
  }, 15_000);

  it.each(['address', 'delete', 'ancestor'] as const)('holds delivery authority until order commit against a later %s writer', async kind => {
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731641,1)');
      const buying = outcome(withTx(createContainerFromDb(buyer.db), async tx => {
        const result = await create(tx);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731641,1)`);
        return result;
      }));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      const update = kind === 'address' ? "UPDATE user_address SET detail='after commit' WHERE id=11"
        : kind === 'delete' ? 'DELETE FROM user_address WHERE id=11'
        : "UPDATE city_area SET name='after commit' WHERE id=901";
      const editing = outcome(editor.exec(update));
      await waitForFinanceBlock(f.db, editor.pid, buyer.pid);
      await holder.exec('COMMIT');
      expect(await buying).toMatchObject({ ok: true });
      expect(await editing).toMatchObject({ ok: true });
    });
    expect((await state()).orders[0]).toMatchObject({ userAddress: '本地省 测试甲市 测试甲区 隔离样本一号', payPostage: '0.00' });
  }, 15_000);

  it('allows compatible address readers and rolls back a completed inner create when the enclosing transaction fails', async () => {
    const before = await state();
    await withFinancePeers(f.db, async ([reader, buyer]) => {
      await reader.exec('BEGIN; SELECT id FROM user_address WHERE id=11 FOR SHARE');
      const result = await outcome(withTx(createContainerFromDb(buyer.db), async tx => {
        await create(tx);
        throw new Error('isolated outer rollback');
      }));
      expect(result).toMatchObject({ ok: false, error: { message: 'isolated outer rollback' } });
      await reader.exec('ROLLBACK');
    });
    expect(await state()).toEqual(before);
  }, 15_000);

  it('keeps stricter connection timeouts unchanged after a successful delivery order', async () => {
    await withFinancePeers(f.db, async ([buyer]) => {
      await buyer.exec("SET statement_timeout='3500ms'; SET lock_timeout='120ms'; SET idle_in_transaction_session_timeout='2500ms'");
      await create(buyer.db);
      const [settings] = await buyer.db.select({ statement: sql<string>`current_setting('statement_timeout')`,
        lock: sql<string>`current_setting('lock_timeout')`, idle: sql<string>`current_setting('idle_in_transaction_session_timeout')` })
        .from(sql`(VALUES(1)) q(n)`);
      expect(settings).toEqual({ statement: '3500ms', lock: '120ms', idle: '2500ms' });
    });
  }, 15_000);
});
