import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { storeCombination, storeOrder, storePink } from '../src/models/schema';
import { AdminCombinationStatisticsService } from '../src/services/admin/AdminCombinationStatisticsService';
import { AdminCombinationExportService } from '../src/services/admin/AdminCombinationExportService';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { seedCombinationStatistics, statisticsSnapshot } from './helpers/combinationStatisticsFixture';

type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<Fixture['withRuntimeRole']>>[0] extends (peer: infer R) => unknown ? R : never;
const query = (value = '') => new URLSearchParams(value), dialect = new PgDialect();

/** Observe genuine SQL after it executes; never fabricate results or bypass the
 * restricted connection. A second genuine peer writes between count and list. */
function observedDb(db: DbClient, observe: (tx: DbClient, statement: SQL) => Promise<void>): DbClient {
  return new Proxy(db, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== 'function') return method;
      if (property !== 'transaction') return method.bind(target);
      return (callback: unknown, ...options: unknown[]) => {
        if (typeof callback !== 'function') throw Error('Missing real transaction callback');
        return Reflect.apply(method, target, [(tx: DbClient) => callback(new Proxy(tx, {
          get(transaction, key, transactionReceiver) {
            const operation: unknown = Reflect.get(transaction, key, transactionReceiver);
            if (typeof operation !== 'function') return operation;
            if (key !== 'execute') return operation.bind(transaction);
            return async (...args: unknown[]) => {
              const result: unknown = await Reflect.apply(operation, transaction, args);
              await observe(transaction, args[0] as SQL);
              return result;
            };
          },
        })), ...options]);
      };
    },
  });
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('combination statistics on formal 175-step / 279-table schema and actual commissioned Admin LOGIN', () => {
  let f: Fixture;
  let cleanup: Fixture | undefined;
  beforeEach(async () => {
    cleanup = undefined;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external I/O'));
    // Commissioning records bind the schema to the actual LOGIN roles. Each
    // case needs a fresh formal catalog before creating its independent peers.
    f = await refundRuntimeFixture();
    cleanup = f;
    await seedCombinationStatistics(f.db);
  }, 120000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally {
      vi.restoreAllMocks();
      const current = cleanup;
      cleanup = undefined;
      await current?.close();
    }
  }, 30000);
  async function admin(run: (peer: Peer, service: AdminCombinationStatisticsService) => Promise<void>) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async peer => {
      const [identity] = await f.exec('SELECT current_database() AS database');
      const names = { app: app.role, admin: peer.role, maintenance: 'finance_test', database: String(identity.database), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      expect(await auditRuntimeBusinessPrivileges(app.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(peer.db, 'admin', names)).toMatchObject({ ready: true, failures: [] });
      expect((await peer.exec('SELECT current_user AS role,session_user AS session'))[0]).toEqual({ role: peer.role, session: peer.role });
      expect((await peer.exec('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user'))[0])
        .toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
      await run(peer, new AdminCombinationStatisticsService(createContainerFromDb(peer.db)));
    }));
  }
  it('reads all five datasets, gross card formulas and all broad search sources under existing exact grants with zero writes', async () => {
    await admin(async (_peer, service) => {
      const before = await statisticsSnapshot(f.db);
      expect(await service.globalHead()).toEqual({ participant_record_count: 12, success_count: 3 });
      expect(await service.head(501)).toMatchObject({ people_count: 5, spread_count: 5, start_count: 4, success_count: 2, pay_price: '110.09', pay_count: 4 });
      expect((await service.groups(query('start_day=2026-09-26&end_day=2026-09-26'), 501)).list.map(row => row.id)).toEqual([9008, 9007, 9001]);
      const members = await service.members(9001, query(), 501);
      expect(members.count).toBe(4); expect(members.list.find(row => row.pink_id === 9001)).toMatchObject({ order_id: 'BUSINESS-9101', detail_available: true });
      expect(members.list.find(row => row.pink_id === 9002)).toMatchObject({ order_deleted: true, detail_available: false });
      expect(members.list.find(row => row.pink_id === 9003)).toMatchObject({ is_virtual: 1, order_id: '', deleted_user: false });
      await expect(service.members(9001, query(), 502)).rejects.toMatchObject({ code: 404 });
      expect((await service.orders(501, query())).count).toBe(5);
      for (const [keyword, count] of [['地址联系人', 2], ['13711112222', 2], ['搜索商品', 1], ['商品标题%_', 1],
        ['组合活动简介', 5], ['活动%_', 5], ['用户甲', 2]] as const) {
        const result = await service.orders(501, query(`keyword=${encodeURIComponent(keyword)}`));
        expect(result.count, keyword).toBe(count); expect(result.list.length, keyword).toBe(count);
      }
      expect(await statisticsSnapshot(f.db)).toEqual(before);
    });
  }, 120000);
  it('keeps all reads repeatable-read/read-only and bounded without relaxing stricter caller deadlines or leaking settings', async () => {
    await admin(async (peer) => {
      await peer.exec("SET statement_timeout='1s'; SET lock_timeout='500ms'; SET idle_in_transaction_session_timeout='1500ms'");
      const settings = sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
        (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement,
        (SELECT setting::integer FROM pg_settings WHERE name='lock_timeout') AS lock,
        (SELECT setting::integer FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`;
      const before = await peer.db.execute(settings), states: unknown[] = [], statements: string[] = [];
      const service = new AdminCombinationStatisticsService(createContainerFromDb(observedDb(peer.db, async (tx, statement) => {
        const command = dialect.sqlToQuery(statement).sql; statements.push(command);
        if (command.includes("set_config('statement_timeout'")) states.push((await tx.execute(settings))[0]);
      })));
      await service.globalHead(); await service.head(501); await service.groups(query()); await service.members(9001, query()); await service.orders(501, query());
      expect(states).toHaveLength(5);
      for (const state of states) expect(state).toEqual({ isolation: 'repeatable read', read_only: 'on', statement: 1000, lock: 500, idle: 1500 });
      expect(statements.some(command => /\b(?:INSERT|UPDATE|DELETE|MERGE|LOCK|pg_advisory\w*)\b/iu.test(command))).toBe(false);
      expect(await peer.db.execute(settings)).toEqual(before);
    });
  }, 120000);
  it('exports exact full pages under the same commissioned Admin grants and rejects continuation after another session changes the result', async () => {
    await admin(async peer => {
      const states: unknown[] = [];
      const exporter = new AdminCombinationExportService(createContainerFromDb(observedDb(peer.db, async (tx, statement) => {
        if (dialect.sqlToQuery(statement).sql.includes("set_config('statement_timeout'")) states.push((await tx.execute(sql`SELECT
          current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
          (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement,
          (SELECT setting::integer FROM pg_settings WHERE name='lock_timeout') AS lock,
          (SELECT setting::integer FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`))[0]);
      })));
      const before = await statisticsSnapshot(f.db), first = await exporter.manifest(query('keyword=活动&limit=1'));
      const second = await exporter.manifest(query(`keyword=活动&limit=1&page=2&snapshot=${first.snapshot}`));
      expect(first).toMatchObject({ count: 2, page: 1, limit: 1, has_more: true });
      expect(second).toMatchObject({ count: 2, page: 2, limit: 1, has_more: false, snapshot: first.snapshot, csv_bytes: first.csv_bytes });
      expect([...first.export, ...second.export].map(row => row.id)).toEqual(['502', '501']);
      expect(states).toHaveLength(2);
      for (const state of states) expect(state).toEqual({ isolation: 'repeatable read', read_only: 'on', statement: 5000, lock: 2000, idle: 5000 });
      expect(await statisticsSnapshot(f.db)).toEqual(before);
      try {
        await f.db.update(storeCombination).set({ info: 'Independent maintenance session changed the export cohort' }).where(eq(storeCombination.id, 501));
        await expect(exporter.manifest(query(`keyword=活动&limit=1&page=2&snapshot=${first.snapshot}`))).rejects.toThrow('已变化');
      } finally { await f.db.update(storeCombination).set({ info: '组合活动简介' }).where(eq(storeCombination.id, 501)); }
    });
  }, 120000);
  it('refuses an actual attempted write inside the read transaction and rolls the whole read back under the same Admin LOGIN', async () => {
    await admin(async peer => {
      const before = await statisticsSnapshot(f.db); let attempted = false;
      const service = new AdminCombinationStatisticsService(createContainerFromDb(observedDb(peer.db, async (tx, statement) => {
        if (!attempted && dialect.sqlToQuery(statement).sql.includes("set_config('statement_timeout'")) {
          attempted = true;
          await tx.execute(sql`INSERT INTO public.store_combination(store_name) VALUES('read-only transaction refusal fixture')`);
        }
      })));
      await expect(service.head(501)).rejects.toMatchObject({ cause: { code: '25006' } });
      expect(attempted).toBe(true); expect(await statisticsSnapshot(f.db)).toEqual(before);
      expect((await peer.exec('SELECT current_user AS role,session_user AS session'))[0]).toEqual({ role: peer.role, session: peer.role });
    });
  }, 120000);
  it('keeps group count/list in one real snapshot while an independent peer adds a leader between queries', async () => {
    await admin(async peer => {
      let injected = false;
      const service = new AdminCombinationStatisticsService(createContainerFromDb(observedDb(peer.db, async (_tx, statement) => {
        const command = dialect.sqlToQuery(statement).sql;
        if (!injected && command.includes('SELECT count(*)::integer AS count FROM public.store_pink')) {
          injected = true;
          await f.db.insert(storePink).values({ id: 9801, combinationId: 501, productId: 700, people: 3, uid: 101, nickname: 'Concurrent leader', kId: 0 });
        }
      })));
      try {
        const result = await service.groups(query(), 501);
        expect(injected).toBe(true); expect(result.count).toBe(4); expect(result.list).toHaveLength(4);
        expect((await new AdminCombinationStatisticsService(createContainerFromDb(peer.db)).groups(query(), 501)).count).toBe(5);
      } finally { await f.db.delete(storePink).where(eq(storePink.id, 9801)); }
    });
  }, 120000);
  it('keeps paid-root order count/list in one real snapshot while an independent peer adds a matching order', async () => {
    await admin(async peer => {
      let injected = false;
      const service = new AdminCombinationStatisticsService(createContainerFromDb(observedDb(peer.db, async (_tx, statement) => {
        if (!injected && dialect.sqlToQuery(statement).sql.includes('SELECT count(*)::integer AS count FROM public.store_order o')) {
          injected = true;
          await f.db.insert(storeOrder).values({ id: 9802, type: 3, activityId: 501, uid: 101, paid: 1,
            orderId: 'CONCURRENT-STATISTICS-9802', unique: 'stat-concurrent-9802', payPrice: '1.01', pinkId: 9001 });
        }
      })));
      try {
        const result = await service.orders(501, query());
        expect(injected).toBe(true); expect(result.count).toBe(5); expect(result.list).toHaveLength(5);
        expect((await new AdminCombinationStatisticsService(createContainerFromDb(peer.db)).orders(501, query())).count).toBe(6);
      } finally { await f.db.delete(storeOrder).where(eq(storeOrder.id, 9802)); }
    });
  }, 120000);
});
