import { randomUUID } from 'node:crypto';
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { memberRight, systemConfig, systemStore } from '../src/models/schema';
import { installCheckoutPricingLock } from '../src/migrations/checkoutPricingLock';
import { runtimeBusinessPrivilegePlan } from '../src/migrations/runtimeBusinessPrivilegePlan';
import { protectCheckoutPricingSources } from '../src/services/order/CheckoutPricingSources';
import { lockCheckoutPickupStore, readCheckoutPickupEnabled, readCheckoutPickupPolicy } from '../src/services/order/CheckoutPickupPolicy';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import type { SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { shippingSettingsFixture } from './helpers/shippingSettingsFixture';

type Runtime = SequenceRunnerPeer & { role: string; connectionString: string };
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(release => { resolve = release; });
  return { promise, resolve };
}
function errorCode(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  if ('code' in error) return error.code;
  return 'cause' in error ? errorCode(error.cause) : undefined;
}

/** Native independent LOGINs, the unchanged production ACL slice and reviewed
 * pricing capability. This verifies pickup locks, not full order commissioning. */
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native ordinary pickup policy protects SQL sources until commit', () => {
  let f: Awaited<ReturnType<typeof shippingSettingsFixture>>;
  beforeEach(async () => { f = await shippingSettingsFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);

  const withRoles = async (run: (app: Runtime, admin: Runtime) => Promise<void>) => {
    await f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
      await f.installSlice(app, admin);
      const [maint] = await f.exec('SELECT pg_backend_pid() AS pid');
      expect(new Set([Number(maint.pid), app.pid, admin.pid]).size).toBe(3);
      expect((await app.exec('SELECT current_user,session_user'))[0])
        .toEqual({ current_user: app.role, session_user: app.role });
      await run(app, admin);
    }));
  };

  it.each([
    ['hide', 'UPDATE public.system_store SET is_show=0 WHERE id=1'],
    ['rename', "UPDATE public.system_store SET name='提交后新提货点名称' WHERE id=1"],
  ] as const)('holds a later %s editor behind the app FOR SHARE lock until commit', async (change, update) => {
    await withRoles(async (app, admin) => {
      const quoted = await readCheckoutPickupPolicy(app.db, 1);
      const ready = barrier(), release = barrier();
      const reading = outcome(withTx(createContainerFromDb(app.db), async tx => {
        await lockCheckoutPickupStore(tx, 1);
        expect(await readCheckoutPickupPolicy(tx, 1)).toEqual(quoted);
        ready.resolve();
        await release.promise;
        expect(await readCheckoutPickupPolicy(tx, 1)).toEqual(quoted);
      }));
      // The explicit acquired-lock signal only starts the editor; the exact
      // PostgreSQL blocker PID below is the evidence of write exclusion.
      await Promise.race([ready.promise, reading.then(result => {
        if (!result.ok) throw result.error;
        throw Error('Pickup lock transaction ended before the test barrier');
      })]);
      const editing = outcome(admin.exec(update));
      try {
        await waitForFinanceBlock(f.db, admin.pid, app.pid);
        expect((await f.db.select().from(systemStore).where(sql`${systemStore.id}=1`))[0])
          .toMatchObject({ name: '较早门店', isShow: 1 });
      } finally { release.resolve(); await Promise.all([reading, editing]); }
      expect(await reading).toMatchObject({ ok: true });
      expect(await editing).toMatchObject({ ok: true });
      if (change === 'hide') await expect(readCheckoutPickupPolicy(app.db, 1)).rejects.toThrow('不存在或已暂停营业');
      else expect(await readCheckoutPickupPolicy(app.db, 1)).toMatchObject({
        enabled: true, store: { id: 1, name: '提交后新提货点名称' },
      });
    });
  }, 15_000);

  it('rejects NOWAIT behind an already active store writer before that writer is released', async () => {
    await withRoles(async (app, admin) => {
      const before = await readCheckoutPickupPolicy(app.db, 1);
      await admin.exec('BEGIN');
      try {
        await admin.exec("UPDATE public.system_store SET name='尚未提交编辑' WHERE id=1");
        // A finished 55P03 refusal while the editor transaction still holds its
        // row lock proves NOWAIT; no elapsed-time assertion supplies evidence.
        const rejected = await outcome(withTx(createContainerFromDb(app.db), tx => lockCheckoutPickupStore(tx, 1)));
        expect(rejected.ok).toBe(false);
        if (!rejected.ok) expect(errorCode(rejected.error)).toBe('55P03');
        expect(await readCheckoutPickupPolicy(app.db, 1)).toEqual(before);
      } finally { await admin.exec('ROLLBACK'); }
      expect(await readCheckoutPickupPolicy(app.db, 1)).toEqual(before);
      await withTx(createContainerFromDb(app.db), tx => lockCheckoutPickupStore(tx, 1));
    });
  }, 15_000);

  it('holds a higher-priority global INSERT behind the exact pricing capability and rejects pickup after commit', async () => {
    await withRoles(async (app, admin) => {
      // The pricing capability protects two existing catalogs. Add the actual
      // member_right ORM table to this finite fixture, with the exact role plan.
      const definition = getTableConfig(memberRight), dialect = new PgDialect();
      const columns = definition.columns.map(column => {
        const value = column.default;
        const initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL
          ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public.member_right (${columns.join(',')})`);
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
        const privileges = runtimeBusinessPrivilegePlan(kind).tables.member_right;
        if (!privileges?.includes('SELECT')) throw Error('Production member_right read privilege is missing');
        await f.exec(`GRANT ${privileges.join(',')} ON public.member_right TO "${peer.role}"`);
      }
      const owner = `cinashop_runtime_${randomUUID().replaceAll('-', '')}`;
      await f.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      try {
        await installCheckoutPricingLock(f.db, owner);
        await f.exec(`GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO "${app.role}"`);
        const quoted = await readCheckoutPickupPolicy(app.db, 1);
        const ready = barrier(), release = barrier();
        const reading = outcome(withTx(createContainerFromDb(app.db), async tx => {
          await lockCheckoutPickupStore(tx, 1);
          await protectCheckoutPricingSources(tx);
          expect(await readCheckoutPickupPolicy(tx, 1)).toEqual(quoted);
          ready.resolve();
          await release.promise;
          expect(await readCheckoutPickupPolicy(tx, 1)).toEqual(quoted);
        }));
        await Promise.race([ready.promise, reading.then(result => {
          if (!result.ok) throw result.error;
          throw Error('Pricing lock transaction ended before the test barrier');
        })]);
        const editing = outcome(admin.exec("INSERT INTO public.system_config(menu_name,value,sort) VALUES('store_self_mention','0',999)"));
        try {
          await waitForFinanceBlock(f.db, admin.pid, app.pid);
          expect(await readCheckoutPickupEnabled(f.db)).toBe(true);
          expect((await f.db.select().from(systemConfig).where(sql`${systemConfig.menuName}='store_self_mention'`))).toHaveLength(1);
        } finally { release.resolve(); await Promise.all([reading, editing]); }
        expect(await reading).toMatchObject({ ok: true });
        expect(await editing).toMatchObject({ ok: true });
        expect(await readCheckoutPickupEnabled(app.db)).toBe(false);
        await expect(readCheckoutPickupPolicy(app.db, 1)).rejects.toThrow('自提已关闭');
      } finally {
        if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(owner)) throw Error('Unsafe owned pickup pricing-role cleanup');
        await f.exec(`DROP OWNED BY "${owner}"; DROP ROLE "${owner}"`);
        expect((await f.query(`SELECT oid FROM pg_roles WHERE rolname='${owner}'`)).rows).toEqual([]);
      }
    });
  }, 20_000);
});
