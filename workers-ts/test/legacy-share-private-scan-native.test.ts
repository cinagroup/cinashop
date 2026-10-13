import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeOrder, systemStoreStaff, user } from '@/models/schema';
import { assertLegacyPrivateScanViewer, readLegacyPrivateScanTarget } from '@/services/other/LegacyPrivateScanTarget';
import { financePostgres } from './helpers/financePostgres';
import { afterFirstPrivateScanSnapshot, MEMBER_CODE, ORDER_CODE, PRIVATE_SCAN_READ_ENV, PRIVATE_SCAN_TABLES,
  seedPrivateScan, sqlErrorCode, withPrivateScanReadRole, type PrivateScanFixture } from './helpers/legacyPrivateScanFixture';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('private QR on owned PostgreSQL16 SELECT-only runtime role', () => {
  let f: PrivateScanFixture;
  beforeAll(async () => { f = await financePostgres(PRIVATE_SCAN_TABLES, { namespace: 'public' }); });
  beforeEach(async () => { await seedPrivateScan(f); });
  afterAll(async () => { await f?.close(); });

  it('reads member/order and mature store/customer/delivery scopes with a real nonprivileged role, rejecting cross-owner/scopes and actual DML', async () => {
    await withPrivateScanReadRole(f, async db => {
      const c = createContainerFromDb(db);
      const member = await readLegacyPrivateScanTarget(c, 11, 90);
      const pickup = await readLegacyPrivateScanTarget(c, 11, 91, 'owned-pickup-1');
      expect(member).toEqual({ kind: 'member', uid: 11, code: MEMBER_CODE });
      expect(pickup.code).toBe(ORDER_CODE);
      await expect(readLegacyPrivateScanTarget(c, 11, 91, 'foreign-pickup-2')).rejects.toThrow(/本人订单/);
      for (const uid of [11, 101, 301]) await expect(assertLegacyPrivateScanViewer(c, uid, pickup, PRIVATE_SCAN_READ_ENV)).resolves.toBe(uid === 11 ? 'owner' : uid === 101 ? 'staff' : 'customer');
      for (const uid of [0, 12, 102, 202, 302]) await expect(assertLegacyPrivateScanViewer(c, uid, pickup, PRIVATE_SCAN_READ_ENV)).rejects.toThrow();
      await expect(assertLegacyPrivateScanViewer(c, 101, member, PRIVATE_SCAN_READ_ENV)).resolves.toBe('staff');
      await expect(assertLegacyPrivateScanViewer(c, 102, member, PRIVATE_SCAN_READ_ENV)).rejects.toThrow();
      const delivery = await readLegacyPrivateScanTarget(c, 11, 91, 'owned-delivery');
      await expect(assertLegacyPrivateScanViewer(c, 201, delivery, PRIVATE_SCAN_READ_ENV)).resolves.toBe('delivery');
      await expect(assertLegacyPrivateScanViewer(c, 202, delivery, PRIVATE_SCAN_READ_ENV)).rejects.toThrow();
      const failure = await db.update(user).set({ barCode: 'must-not-write' }).where(eq(user.uid, 11)).then(() => undefined, error => error);
      expect(sqlErrorCode(failure)).toBe('42501');
    });
    expect((await f.db.select({ code: user.barCode }).from(user).where(eq(user.uid, 11)))[0].code).toBe(MEMBER_CODE);
  });

  it('enforces actual READ ONLY even after a deliberately granted UPDATE counterfactual', async () => {
    await withPrivateScanReadRole(f, async db => {
      const [identity] = await db.execute<{ role: string }>(sql`SELECT current_user AS role`);
      if (!/^private_scan_[a-f0-9]{32}$/.test(identity.role)) throw Error('Unexpected owned runtime role');
      await f.db.$client.unsafe(`GRANT UPDATE (bar_code) ON public."user" TO "${identity.role}"`);
      // Prove this particular column DML really works outside our read helper.
      await db.update(user).set({ barCode: MEMBER_CODE }).where(eq(user.uid, 11));
      let observedReadOnly = false;
      const probe = new Proxy(db, {
        get(target, key, receiver) {
          if (key !== 'transaction') return Reflect.get(target, key, receiver);
          return (read: (tx: DbClient) => Promise<unknown>) => target.transaction(async txValue => {
            const tx = txValue as unknown as DbClient;
            const observed = new Proxy(tx, {
              get(inner, method, innerReceiver) {
                if (method !== 'execute') return Reflect.get(inner, method, innerReceiver);
                return async (query: Parameters<DbClient['execute']>[0]) => {
                  const result = await inner.execute(query);
                  if (!observedReadOnly) {
                    const [settings] = await inner.execute<{ read_only: string; isolation: string }>(sql`
                      SELECT current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation`);
                    expect(settings).toEqual({ read_only: 'on', isolation: 'repeatable read' });
                    observedReadOnly = true;
                    await inner.update(user).set({ barCode: 'must-not-write' }).where(eq(user.uid, 11));
                  }
                  return result;
                };
              },
            });
            return read(observed);
          });
        },
      });
      const failure = await readLegacyPrivateScanTarget(createContainerFromDb(probe), 11, 90).then(() => undefined, error => error);
      expect(observedReadOnly).toBe(true);
      expect(sqlErrorCode(failure)).toBe('25006');
    });
    expect((await f.db.select({ code: user.barCode }).from(user).where(eq(user.uid, 11)))[0].code).toBe(MEMBER_CODE);
  });

  it('rejects committed code replacement and role revocation between independent real read snapshots', async () => {
    await withPrivateScanReadRole(f, async db => {
      const codeChange = afterFirstPrivateScanSnapshot(db, () => f.db.update(storeOrder).set({ verifyCode: '998877665544' }).where(eq(storeOrder.id, 401)));
      await expect(readLegacyPrivateScanTarget(createContainerFromDb(codeChange), 11, 91, 'owned-pickup-1')).rejects.toThrow(/对象已变化/);
      await f.db.update(storeOrder).set({ verifyCode: ORDER_CODE }).where(eq(storeOrder.id, 401));
      const target = await readLegacyPrivateScanTarget(createContainerFromDb(db), 11, 91, 'owned-pickup-1');
      const identityChange = afterFirstPrivateScanSnapshot(db, () => f.db.update(systemStoreStaff).set({ id: 9 }).where(eq(systemStoreStaff.id, 1)));
      await expect(assertLegacyPrivateScanViewer(createContainerFromDb(identityChange), 101, target, PRIVATE_SCAN_READ_ENV)).rejects.toThrow(/读取资格已变化/);
      const roleChange = afterFirstPrivateScanSnapshot(db, () => f.db.update(systemStoreStaff).set({ status: 0 }).where(eq(systemStoreStaff.uid, 101)));
      await expect(assertLegacyPrivateScanViewer(createContainerFromDb(roleChange), 101, target, PRIVATE_SCAN_READ_ENV)).rejects.toThrow(/无权/);
      await f.db.update(user).set({ deleteTime: new Date() }).where(eq(user.uid, 11));
      await expect(readLegacyPrivateScanTarget(createContainerFromDb(db), 11, 90)).rejects.toThrow(/账号/);
    });
  });
});
