import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin, systemLog, systemMenus, systemRole } from '@/models/schema';
import { AdminLegacySystemLogService, parseLegacySystemLogQuery } from '@/services/admin/AdminLegacySystemLogService';
import { md5 } from '@/utils/jwt';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type LoginPeer = SequenceRunnerPeer & { role: string };
const dialect = new PgDialect(), password = 'owned-native-legacy-log-password';
const actor = () => ({ id: 100, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 300 });
const service = (db: DbClient) => new AdminLegacySystemLogService(createContainerFromDb(db));
function afterQuery(db: DbClient, observe: (tx: DbClient, query: SQL) => Promise<void>): DbClient {
  return new Proxy(db, { get(target, key) {
    const method: unknown = Reflect.get(target, key);
    if (typeof method !== 'function') return method;
    if (key !== 'transaction') return method.bind(target);
    return (callback: unknown, ...options: unknown[]) => {
      if (typeof callback !== 'function') throw Error('Missing native callback');
      return Reflect.apply(method, target, [(tx: DbClient) => callback(new Proxy(tx, { get(transaction, property) {
        const operation: unknown = Reflect.get(transaction, property);
        if (typeof operation !== 'function') return operation;
        if (property !== 'execute') return operation.bind(transaction);
        return async (...args: unknown[]) => {
          const rows: unknown = await Reflect.apply(operation, transaction, args);
          await observe(transaction, args[0] as SQL);
          return rows;
        };
      } })), ...options]);
    };
  } });
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('legacy system logs on independent PG16 LOGINs', () => {
  let fixture: Fixture, ddl: string;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson({ systemAdmin, systemRole, systemMenus, systemLog }))).join('\n');
  });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native system log tests forbid external I/O'));
    fixture = await sequenceRunnerDatabase();
    if (fixture.format !== 'pg16' || !fixture.withRuntimeRole || !fixture.withPeer) throw Error('Native log proof requires independent PG16 LOGIN peers');
    await fixture.exec(ddl);
    await fixture.db.insert(systemRole).values({ id: 900, roleName: '日志只读', rules: 'log.view', level: 1 });
    await fixture.db.insert(systemAdmin).values([
      { id: 100, account: 'native-log-reader', pwd: password, roles: '900', level: 1 },
      { id: 201, account: 'native-lower', realName: '下级', level: 2 },
    ]);
    await fixture.db.insert(systemLog).values([
      { id: 501, adminId: 201, adminName: '下级', page: '旧行为', path: '/old', method: 'GET', type: 'admin', addTime: 1 },
      { id: 502, adminId: 100, adminName: '当前', page: '当前行为', path: '/current', method: 'PUT', type: 'admin', addTime: 2 },
    ]);
  }, 60_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await fixture?.close(); } }, 30_000);
  async function reader<T>(run: (peer: LoginPeer) => Promise<T>) {
    return fixture.withRuntimeRole!(async peer => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe owned LOGIN');
      await fixture.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_menus,public.system_log TO "${peer.role}";
        GRANT UPDATE(last_time) ON public.system_admin TO "${peer.role}"`);
      const [identity] = await peer.exec('SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid');
      expect(identity).toEqual({ role: peer.role, session: peer.role, pid: peer.pid });
      return run(peer);
    });
  }
  function isCount(query: SQL) { const text = dialect.sqlToQuery(query).sql; return /count\s*\(/i.test(text) && text.includes('system_log'); }

  it('keeps the exact count and log rows in one READ ONLY snapshot across an independent commit', async () => {
    await reader(peer => fixture.withPeer!(async writer => {
      const [zone] = await writer.exec(`SELECT
        extract(epoch from timestamp '1990-07-01 00:00:00' AT TIME ZONE 'Asia/Shanghai')::bigint::text AS midnight,
        extract(epoch from timestamp '1990-07-01 12:34:56' AT TIME ZONE 'Asia/Shanghai')::bigint::text AS clock,
        extract(epoch from timestamp '2026-07-01 12:34:56' AT TIME ZONE 'Asia/Shanghai')::bigint::text AS modern`);
      for (const [data, expected] of [['1990/07/01-', zone.midnight], ['1990/07/01 12:34:56-', zone.clock],
        ['2026/07/01 12:34:56-', zone.modern]]) {
        expect(parseLegacySystemLogQuery(new URLSearchParams({ data })).start).toBe(Number(expected));
      }
      let crossed = false;
      const observed = service(afterQuery(peer.db, async (tx, query) => {
        if (crossed || !isCount(query)) return;
        crossed = true;
        const [state] = await tx.execute(sql`SELECT pg_backend_pid() AS pid,current_user AS role,session_user AS session,
          current_database() AS database,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly`);
        expect(state).toMatchObject({ pid: peer.pid, role: peer.role, session: peer.role, isolation: 'repeatable read', readonly: 'on' });
        const [writerState] = await writer.exec('SELECT pg_backend_pid() AS pid,current_database() AS database');
        expect(writerState.pid).not.toBe(peer.pid); expect(writerState.database).toBe(state.database);
        await writer.db.transaction(async db => {
          await db.update(systemLog).set({ page: '新行为', path: '/new' }).where(eq(systemLog.id, 501));
          await db.insert(systemLog).values({ id: 503, adminId: 201, path: '/created', type: 'admin', addTime: 3 });
        });
      }));
      const first = await observed.list(new URLSearchParams(), actor());
      expect(crossed).toBe(true); expect(first.count).toBe(2); expect(first.list.map(row => row.id)).toEqual([502,501]);
      expect(first.list[1]).toMatchObject({ page: '旧行为', path: '/old' });
      const fresh = await service(peer.db).list(new URLSearchParams(), actor());
      expect(fresh.count).toBe(3); expect(fresh.list.map(row => row.id)).toEqual([503,502,501]);
      expect(fresh.list[2]).toMatchObject({ page: '新行为', path: '/new' });
    }));
  }, 60_000);

  it('works with SELECT-only audit tables and rejects a granted login-column write within its READ ONLY transaction', async () => {
    await reader(async peer => {
      const [grants] = await peer.exec(`SELECT has_table_privilege(current_user,'public.system_log','SELECT') AS read,
        has_table_privilege(current_user,'public.system_log','INSERT') AS insert,
        has_table_privilege(current_user,'public.system_log','UPDATE') AS update,
        has_table_privilege(current_user,'public.system_log','DELETE') AS delete,
        has_column_privilege(current_user,'public.system_admin','last_time','UPDATE') AS login_update`);
      expect(grants).toEqual({ read: true, insert: false, update: false, delete: false, login_update: true });
      expect((await service(peer.db).list(new URLSearchParams(), actor())).count).toBe(2);
      expect((await service(peer.db).adminOptions(new URLSearchParams(), actor())).info.map(row => row.id)).toEqual([100,201]);
      await peer.exec('UPDATE public.system_admin SET last_time=42 WHERE id=100');
      const before = await fixture.db.select().from(systemLog), adminBefore = await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id);
      let attempted = false;
      const observed = service(afterQuery(peer.db, async (tx, query) => {
        if (attempted || !isCount(query)) return;
        attempted = true;
        await tx.execute(sql`UPDATE public.system_admin SET last_time=99 WHERE id=100`);
      }));
      await expect(observed.list(new URLSearchParams(), actor())).rejects.toMatchObject({ cause: { code: '25006' } });
      expect(attempted).toBe(true);
      expect(await fixture.db.select().from(systemLog)).toEqual(before);
      expect(await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id)).toEqual(adminBefore);
    });
  }, 60_000);
});
