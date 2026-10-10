import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { systemAdmin, systemMenus, systemRole } from '../src/models/schema';
import { AdminLegacySystemListService } from '../src/services/admin/AdminLegacySystemListService';
import { md5 } from '../src/utils/jwt';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type LoginPeer = SequenceRunnerPeer & { role: string };
const dialect = new PgDialect();
const actorPassword = 'owned-native-system-list-password';
const actor = () => ({ id: 100, authVersion: md5(actorPassword), expiresAt: Math.floor(Date.now() / 1000) + 300 });
const params = (query = '') => new URLSearchParams(query);

/** Intercept only after a real query resolves, on the actual transaction.
 * The observer may commit on an independent peer before the next query starts.
 * Neither SQL results nor the transaction/LOGIN identity are substituted. */
function afterQueryDatabase(db: DbClient, observe: (tx: DbClient, statement: SQL) => Promise<void>): DbClient {
  return new Proxy(db, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      if (property !== 'transaction') return method.bind(target);
      return (callback: unknown, ...options: unknown[]) => {
        if (typeof callback !== 'function') throw Error('Missing native transaction callback');
        return Reflect.apply(method, target, [(tx: DbClient) => callback(new Proxy(tx, {
          get(transaction, key) {
            const operation: unknown = Reflect.get(transaction, key);
            if (typeof operation !== 'function') return operation;
            if (key !== 'execute') return operation.bind(transaction);
            return async (...args: unknown[]) => {
              const rows: unknown = await Reflect.apply(operation, transaction, args);
              await observe(transaction, args[0] as SQL);
              return rows;
            };
          },
        })), ...options]);
      };
    },
  });
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('legacy staff lists on independent PG16 LOGINs', () => {
  let fixture: Fixture;
  let ddl: string;

  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}),
      kit.generateDrizzleJson({ systemAdmin, systemRole, systemMenus }))).join('\n');
  });

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native staff lists forbid external I/O'));
    fixture = await sequenceRunnerDatabase();
    if (fixture.format !== 'pg16' || !fixture.withRuntimeRole || !fixture.withPeer) {
      throw Error('Staff snapshot proof requires native PG16 and independent LOGIN peers');
    }
    await fixture.exec(ddl);
    await fixture.db.insert(systemMenus).values([
      { id: 701, type: 1, menuName: '旧菜单甲', authType: 2, apiUrl: 'system_admin/list', methods: 'GET' },
      { id: 702, type: 4, menuName: '租户菜单', authType: 2, apiUrl: 'system_admin/list', methods: 'GET' },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 900, type: 0, relationId: 0, level: 1, roleName: '系统只读', rules: 'system.view' },
      { id: 901, type: 1, relationId: 0, level: 2, roleName: '旧平台角色甲', rules: '701' },
      { id: 903, type: 0, relationId: 0, level: 2, roleName: '平台零型角色', rules: '701' },
      { id: 904, type: 4, relationId: 9, level: 2, roleName: '供应商角色', rules: '702' },
      { id: 905, type: 2, relationId: 0, level: 2, roleName: '门店角色', rules: '701' },
      { id: 906, type: 1, relationId: 9, level: 2, roleName: '非平台关系', rules: '701' },
      { id: 907, type: 1, relationId: 0, level: 3, roleName: '另一层级', rules: '701' },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 100, account: 'snapshot-reader', pwd: actorPassword, roles: '900', level: 1 },
      { id: 201, account: 'snapshot-target', realName: '旧姓名', pwd: 'never-return-native-private-hash',
        roles: '901', level: 2, lastTime: 1 },
      { id: 202, account: 'another-platform', roles: '903', level: 2 },
      { id: 204, account: 'hidden-supplier', adminType: 4, relationId: 9, level: 2 },
      { id: 205, account: 'hidden-deleted', isDel: 1, level: 2 },
      { id: 206, account: 'hidden-level', level: 3 },
    ]);
  }, 60_000);

  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await fixture?.close(); }
  }, 30_000);

  const service = (db: DbClient) => new AdminLegacySystemListService(createContainerFromDb(db));
  const countQuery = (statement: SQL, table: string) => {
    const text = dialect.sqlToQuery(statement).sql;
    return /\bcount\s*\(/i.test(text) && text.includes(table);
  };
  const snapshotSettings = sql`SELECT pg_backend_pid() AS pid,current_user AS role,session_user AS session,
    current_setting('server_version_num') AS version,current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS readonly`;

  async function reader<T>(run: (peer: LoginPeer) => Promise<T>): Promise<T> {
    return fixture.withRuntimeRole!(async peer => {
      // This is an owned test role, never a production role installer. Authority
      // tables remain SELECT-only; only the three existing login columns vary.
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe native LOGIN name');
      await fixture.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_menus TO "${peer.role}";
        GRANT UPDATE(last_ip,last_time,login_count) ON public.system_admin TO "${peer.role}"`);
      const [identity] = await peer.exec('SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid');
      expect(identity).toEqual({ role: peer.role, session: peer.role, pid: peer.pid });
      const [capability] = await peer.exec(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
        FROM pg_roles WHERE rolname=current_user`);
      expect(capability).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
      return run(peer);
    });
  }

  async function proveSnapshot(tx: DbClient, peer: LoginPeer, writer: SequenceRunnerPeer) {
    const [state] = await tx.execute(snapshotSettings);
    expect(state).toMatchObject({ pid: peer.pid, role: peer.role, session: peer.role,
      isolation: 'repeatable read', readonly: 'on' });
    expect(Math.floor(Number(state.version) / 10_000)).toBe(16);
    expect(writer.pid).not.toBe(peer.pid);
    const [writerState] = await writer.exec('SELECT pg_backend_pid() AS pid,current_database() AS database');
    const [readerState] = await tx.execute(sql`SELECT current_database() AS database`);
    expect(writerState).toEqual({ pid: writer.pid, database: readerState.database });
  }

  it('keeps administrator count, rows and displayed role names in one real snapshot across an independent commit', async () => {
    await reader(peer => fixture.withPeer!(async writer => {
      let barrierCrossed = false;
      const observed = service(afterQueryDatabase(peer.db, async (tx, statement) => {
        if (barrierCrossed || !countQuery(statement, 'system_admin')) return;
        barrierCrossed = true;
        await proveSnapshot(tx, peer, writer);
        await writer.db.transaction(async other => {
          await other.update(systemAdmin).set({ realName: '新姓名' }).where(eq(systemAdmin.id, 201));
          await other.update(systemRole).set({ roleName: '新平台角色甲' }).where(eq(systemRole.id, 901));
          await other.insert(systemAdmin).values({ id: 203, account: 'snapshot-new', realName: '新行', level: 2, roles: '901' });
        });
        // The write is committed before the intercepted read proceeds to its
        // list and role-name queries; no timer or scheduling guess is involved.
        expect((await writer.db.select().from(systemAdmin).where(eq(systemAdmin.id, 201)))[0].realName).toBe('新姓名');
      }));
      const first = await observed.adminList(params('name=snapshot'), actor());
      expect(barrierCrossed).toBe(true);
      expect(first).toMatchObject({ count: 1, list: [{ id: 201, real_name: '旧姓名', roles: '旧平台角色甲' }] });
      expect(first.list).toHaveLength(1);
      expect(JSON.stringify(first)).not.toContain('never-return-native-private-hash');
      const fresh = await service(peer.db).adminList(params('name=snapshot'), actor());
      expect(fresh.count).toBe(2);
      expect(fresh.list.find(row => row.id === 201)).toMatchObject({ real_name: '新姓名', roles: '新平台角色甲' });
      expect(fresh.list.map(row => row.id)).toEqual([203, 201]);
    }));
  }, 60_000);

  it('keeps role count, rows and menu display names in the same snapshot and excludes nonplatform or other-level roles', async () => {
    await reader(peer => fixture.withPeer!(async writer => {
      let barrierCrossed = false;
      const observed = service(afterQueryDatabase(peer.db, async (tx, statement) => {
        if (barrierCrossed || !countQuery(statement, 'system_role')) return;
        barrierCrossed = true;
        await proveSnapshot(tx, peer, writer);
        await writer.db.transaction(async other => {
          await other.update(systemRole).set({ roleName: '新平台角色甲' }).where(eq(systemRole.id, 901));
          await other.update(systemMenus).set({ menuName: '新菜单甲' }).where(eq(systemMenus.id, 701));
          await other.insert(systemRole).values({ id: 908, type: 1, relationId: 0, level: 2, roleName: '新增平台角色', rules: '701' });
        });
      }));
      const first = await observed.roleList(params(), actor());
      expect(barrierCrossed).toBe(true);
      expect(first.count).toBe(2);
      expect(first.list.map(row => row.id)).toEqual([903, 901]);
      expect(first.list.find(row => row.id === 901)).toMatchObject({ role_name: '旧平台角色甲', rules: '旧菜单甲' });
      expect(first.list.every(row => row.rules === '旧菜单甲')).toBe(true);
      const fresh = await service(peer.db).roleList(params(), actor());
      expect(fresh.count).toBe(3);
      expect(fresh.list.map(row => row.id)).toEqual([908, 903, 901]);
      expect(fresh.list.find(row => row.id === 901)).toMatchObject({ role_name: '新平台角色甲', rules: '新菜单甲' });
    }));
  }, 60_000);

  it('runs with SELECT and login-column grants, rejects authority writes and rolls back even an allowed login-column write inside the readonly list', async () => {
    await reader(async peer => {
      const [privileges] = await peer.exec(`SELECT
        has_table_privilege(current_user,'public.system_admin','SELECT') AS read,
        has_table_privilege(current_user,'public.system_admin','UPDATE') AS full_update,
        has_column_privilege(current_user,'public.system_admin','last_time','UPDATE') AS login_update,
        has_column_privilege(current_user,'public.system_admin','account','UPDATE') AS authority_update`);
      expect(privileges).toEqual({ read: true, full_update: false, login_update: true, authority_update: false });
      await expect(peer.exec("UPDATE public.system_admin SET account='forbidden' WHERE id=201"))
        .rejects.toMatchObject({ code: '42501' });
      await peer.exec('UPDATE public.system_admin SET last_time=42 WHERE id=100');
      expect((await service(peer.db).adminList(params(), actor())).count).toBe(2);
      expect((await service(peer.db).roleList(params(), actor())).list.map(row => row.id)).toEqual([903, 901]);
      const before = await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id);
      let attempted = false;
      const observed = service(afterQueryDatabase(peer.db, async (tx, statement) => {
        if (attempted || !countQuery(statement, 'system_admin')) return;
        attempted = true;
        await tx.execute(sql`UPDATE public.system_admin SET last_time=99 WHERE id=100`);
      }));
      await expect(observed.adminList(params(), actor())).rejects.toMatchObject({ cause: { code: '25006' } });
      expect(attempted).toBe(true);
      expect(await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id)).toEqual(before);
      expect((await peer.exec('SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid'))[0])
        .toEqual({ role: peer.role, session: peer.role, pid: peer.pid });
      expect((await service(peer.db).adminList(params(), actor())).count).toBe(2);
    });
  }, 60_000);
});
