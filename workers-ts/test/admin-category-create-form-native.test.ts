import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Env } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { systemAdmin, systemAttachmentCategory, systemMenus, systemRole } from '../src/models/schema';
import { AdminAttachmentCategoryCreateFormService } from '../src/services/admin/AdminAttachmentCategoryCreateFormService';
import { adminAttachmentScope, AttachmentService } from '../src/services/system/AttachmentService';
import { NotFoundException } from '../src/utils/errors';
import { md5 } from '../src/utils/jwt';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type LoginPeer = SequenceRunnerPeer & { role: string };
const dialect = new PgDialect();
const password = 'owned-category-form-native-password';
const actor = () => ({ id: 100, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 300 });
const query = (value = '') => new URLSearchParams(value);

/** Observe only completed real statements on the original transaction. The
 * observer never substitutes rows, SQL, transaction options or the LOGIN. */
function observeReadOnlyTransaction(db: DbClient, observe: (tx: DbClient) => Promise<void>): DbClient {
  return new Proxy(db, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      if (property !== 'transaction') return method.bind(target);
      return (callback: unknown, ...options: unknown[]) => {
        if (typeof callback !== 'function') throw Error('Missing category-form transaction callback');
        return Reflect.apply(method, target, [(tx: DbClient) => callback(new Proxy(tx, {
          get(transaction, key) {
            const operation: unknown = Reflect.get(transaction, key);
            if (typeof operation !== 'function') return operation;
            if (key !== 'execute') return operation.bind(transaction);
            return async (...args: unknown[]) => {
              const rows: unknown = await Reflect.apply(operation, transaction, args);
              if (/^\s*SET\s+TRANSACTION\s+ISOLATION\s+LEVEL\s+REPEATABLE\s+READ\s*,\s*READ\s+ONLY\s*$/i
                .test(dialect.sqlToQuery(args[0] as SQL).sql)) {
                await observe(transaction);
              }
              return rows;
            };
          },
        })), ...options]);
      };
    },
  });
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin category create form and final parent checks on owned PG16 LOGINs', () => {
  let fixture: Fixture;
  let ddl: string;

  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}),
      kit.generateDrizzleJson({ systemAdmin, systemRole, systemMenus, systemAttachmentCategory }))).join('\n');
  });

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native category form forbids external I/O'));
    fixture = await sequenceRunnerDatabase();
    if (fixture.format !== 'pg16' || !fixture.withRuntimeRole || !fixture.withPeer) {
      throw Error('Category-form privilege and lock proof requires native PG16 LOGIN peers');
    }
    await fixture.exec(ddl);
    await fixture.db.insert(systemRole).values({ id: 900, type: 0, relationId: 0, level: 1,
      roleName: '素材只读', rules: 'attachment.view' });
    await fixture.db.insert(systemAdmin).values({ id: 100, account: 'native-category-reader', pwd: password,
      roles: '900', level: 1 });
    await fixture.db.insert(systemAttachmentCategory).values([
      { id: 12, type: 1, relationId: 0, fileType: 1, pid: 0, name: '图片根' },
      { id: 13, type: 1, relationId: 0, fileType: 1, pid: 12, name: '嵌套图片' },
      { id: 20, type: 1, relationId: 0, fileType: 2, pid: 0, name: '视频根' },
      { id: 30, type: 4, relationId: 9, fileType: 1, pid: 0, name: '供应商分类' },
      { id: 40, type: 1, relationId: 7, fileType: 1, pid: 0, name: '其他关系分类' },
    ]);
    await fixture.exec("SELECT setval(pg_get_serial_sequence('system_attachment_category','id'),40,true)");
  }, 60_000);

  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await fixture?.close(); }
  }, 30_000);

  const formService = (db: DbClient) => new AdminAttachmentCategoryCreateFormService(createContainerFromDb(db));
  const saveService = (db: DbClient) => new AttachmentService(createContainerFromDb(db), {} as Env);
  const categoryRows = () => fixture.db.select().from(systemAttachmentCategory).orderBy(systemAttachmentCategory.id);

  async function reader<T>(run: (peer: LoginPeer) => Promise<T>): Promise<T> {
    return fixture.withRuntimeRole!(async peer => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe category-form LOGIN name');
      // Only SELECT on the four tables used by the real live actor/permission
      // and form queries: no DML, sequence privileges or login-column writes.
      await fixture.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_menus,
        public.system_attachment_category TO "${peer.role}"`);
      const [identity] = await peer.exec(`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
        current_setting('server_version_num') AS version`);
      expect(identity).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid });
      expect(Math.floor(Number(identity.version) / 10_000)).toBe(16);
      const [capability] = await peer.exec(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
        FROM pg_roles WHERE rolname=current_user`);
      expect(capability).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
      return run(peer);
    });
  }

  it('reads image/video root form options on a SELECT-only LOGIN and performs no database writes', async () => {
    const beforeCategories = await categoryRows();
    const beforeAdmins = await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id);
    const beforeRoles = await fixture.db.select().from(systemRole).orderBy(systemRole.id);
    const beforeMenus = await fixture.db.select().from(systemMenus).orderBy(systemMenus.id);
    await reader(async peer => {
      const rights = await peer.exec(`SELECT name,
        has_table_privilege(current_user,'public.'||name,'SELECT') AS read,
        has_table_privilege(current_user,'public.'||name,'INSERT') AS "insert",
        has_table_privilege(current_user,'public.'||name,'UPDATE') AS "update",
        has_table_privilege(current_user,'public.'||name,'DELETE') AS "delete"
        FROM (VALUES ('system_admin'),('system_role'),('system_menus'),('system_attachment_category')) AS tables(name)
        ORDER BY name`);
      expect(rights).toHaveLength(4);
      expect(rights.every(row => row.read === true && row.insert === false && row.update === false && row.delete === false)).toBe(true);
      let readOnlyTransactionsObserved = 0;
      const observed = formService(observeReadOnlyTransaction(peer.db, async tx => {
        const [state] = await tx.execute(sql`SELECT pg_backend_pid() AS pid,current_user AS role,session_user AS session,
          current_setting('server_version_num') AS version,current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS readonly`);
        expect(state).toMatchObject({ pid: peer.pid, role: peer.role, session: peer.role,
          isolation: 'repeatable read', readonly: 'on' });
        expect(Math.floor(Number(state.version) / 10_000)).toBe(16);
        readOnlyTransactionsObserved++;
      }));
      const image = await observed.createForm(query('id=12&file_type=1'), actor());
      const video = await observed.createForm(query('id=20&file_type=2'), actor());
      expect(readOnlyTransactionsObserved).toBe(2);
      expect(image).toMatchObject({ method: 'POST', action: 'file/category' });
      expect(image.rules.find(rule => rule.field === 'pid')).toMatchObject({ type: 'select', value: 12,
        options: [{ value: 0, label: '所有分类' }, { value: 12, label: '图片根' }] });
      expect(video.rules.find(rule => rule.field === 'pid')).toMatchObject({ type: 'select', value: 20,
        options: [{ value: 0, label: '所有分类' }, { value: 20, label: '视频根' }] });
      expect(video.rules.find(rule => rule.field === 'file_type')).toMatchObject({ type: 'hidden', value: 2 });
      await expect(peer.exec("UPDATE public.system_attachment_category SET name='禁止写' WHERE id=12"))
        .rejects.toMatchObject({ code: '42501' });
      await expect(peer.exec('DELETE FROM public.system_attachment_category WHERE id=12'))
        .rejects.toMatchObject({ code: '42501' });
      await expect(peer.exec('UPDATE public.system_admin SET login_count=99 WHERE id=100'))
        .rejects.toMatchObject({ code: '42501' });
      expect((await peer.exec('SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid'))[0])
        .toEqual({ role: peer.role, session: peer.role, pid: peer.pid });
    });
    expect(await categoryRows()).toEqual(beforeCategories);
    expect(await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id)).toEqual(beforeAdmins);
    expect(await fixture.db.select().from(systemRole).orderBy(systemRole.id)).toEqual(beforeRoles);
    expect(await fixture.db.select().from(systemMenus).orderBy(systemMenus.id)).toEqual(beforeMenus);
  }, 60_000);

  it.each([
    ['deleted', 'DELETE FROM public.system_attachment_category WHERE id=12'],
    ['file type changed', 'UPDATE public.system_attachment_category SET file_type=2 WHERE id=12'],
  ] as const)('rechecks a previously offered parent after a real scope-lock wait when it is %s', async (change, mutation) => {
    await reader(readerPeer => fixture.withPeer!(async writer => fixture.withPeer!(async saving => {
      const offered = await formService(readerPeer.db).createForm(query('id=12&file_type=1'), actor());
      expect(offered.rules.find(rule => rule.field === 'pid')).toMatchObject({ value: 12 });
      const before = await categoryRows();
      const [readIdentity] = await readerPeer.exec('SELECT current_database() AS database,pg_backend_pid() AS pid');
      const [writeIdentity] = await writer.exec('SELECT current_database() AS database,pg_backend_pid() AS pid');
      const [saveIdentity] = await saving.exec('SELECT current_database() AS database,pg_backend_pid() AS pid');
      expect(new Set([readIdentity.pid, writeIdentity.pid, saveIdentity.pid]).size).toBe(3);
      expect(writeIdentity).toEqual({ database: readIdentity.database, pid: writer.pid });
      expect(saveIdentity).toEqual({ database: readIdentity.database, pid: saving.pid });
      await saving.exec("SET lock_timeout='8s'");
      // This is the same Admin/type1/relation0 lock acquired by saveCategory.
      // The real writer retains it while changing the parent, then commits only
      // after PostgreSQL proves the independent save backend is blocked by it.
      await writer.exec(`BEGIN; SELECT pg_advisory_xact_lock(505610,0); ${mutation}`);
      const pending = outcome(saveService(saving.db).saveCategory(adminAttachmentScope(), undefined,
        { name: '不得新增的子分类', pid: 12, file_type: 1 }));
      try {
        await waitForFinanceBlock(fixture.db, saving.pid, writer.pid);
        await writer.exec('COMMIT');
        const expected = change === 'deleted'
          ? before.filter(row => row.id !== 12)
          : before.map(row => row.id === 12 ? { ...row, fileType: 2 } : row);
        expect(await categoryRows()).toEqual(expected); // Writer commit is visible.
        const result = await pending;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(NotFoundException);
        expect(await categoryRows()).toEqual(expected); // No INSERT or collateral changes.
      } finally {
        await writer.exec('ROLLBACK');
        await pending; // Drain the real save transaction before peer cleanup.
      }
    })));
  }, 60_000);
});
