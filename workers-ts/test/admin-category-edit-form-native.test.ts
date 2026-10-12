import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { systemAdmin, systemAttachmentCategory, systemMenus, systemRole } from '../src/models/schema';
import { adminCategoryEditForm, adminCategoryUpdate } from '../src/controllers/system/AttachmentController';
import { adminAuthMiddleware } from '../src/middleware/admin-auth';
import type { AdminAttachmentCategoryEditForm } from '../src/services/admin/AdminAttachmentCategoryEditFormService';
import { ApiException } from '../src/utils/errors';
import { createToken, md5 } from '../src/utils/jwt';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type LoginPeer = SequenceRunnerPeer & { role: string };
type Envelope<T> = { status: number; msg: string; data: T };
const dialect = new PgDialect();
const password = 'owned-category-edit-native-password';
const env = { APP_KEY: 'owned-native-category-edit-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;

/** Observe completed statements on the real transaction, without substituting
 * SQL, rows, isolation options, database connections or LOGINs. */
function observeReadOnlyTransaction(db: DbClient, observe: (tx: DbClient) => Promise<void>): DbClient {
  return new Proxy(db, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      if (property !== 'transaction') return method.bind(target);
      return (callback: unknown, ...options: unknown[]) => {
        if (typeof callback !== 'function') throw Error('Missing category-edit transaction callback');
        return Reflect.apply(method, target, [(tx: DbClient) => callback(new Proxy(tx, {
          get(transaction, key) {
            const operation: unknown = Reflect.get(transaction, key);
            if (typeof operation !== 'function') return operation;
            if (key !== 'execute') return operation.bind(transaction);
            return async (...args: unknown[]) => {
              const rows: unknown = await Reflect.apply(operation, transaction, args);
              if (/^\s*SET\s+TRANSACTION\s+ISOLATION\s+LEVEL\s+REPEATABLE\s+READ\s*,\s*READ\s+ONLY\s*$/i
                .test(dialect.sqlToQuery(args[0] as SQL).sql)) await observe(transaction);
              return rows;
            };
          },
        })), ...options]);
      };
    },
  });
}

/** This local Hono harness executes actual middleware/controller handlers on
 * each native peer's DB and both URL bases. Exact source registrations are
 * checked separately by the business suite. */
function application(db: DbClient) {
  const container = createContainerFromDb(db);
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use('*', async (c, next) => { c.set('container', container); await next(); });
  app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500,
    msg: error.message, data: null }));
  for (const prefix of ['/adminapi', '/api/admin']) {
    app.get(`${prefix}/file/category/:id/edit`, adminAuthMiddleware(), adminCategoryEditForm);
    app.put(`${prefix}/file/category/:id`, adminAuthMiddleware(), adminCategoryUpdate);
  }
  return app;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin category edit HTTP forms and final PUT checks on owned PG16 LOGINs', () => {
  let fixture: Fixture;
  let ddl: string;
  let readerToken: string;
  let managerToken: string;

  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}),
      kit.generateDrizzleJson({ systemAdmin, systemRole, systemMenus, systemAttachmentCategory }))).join('\n');
  });

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native category edit forbids external I/O'));
    fixture = await sequenceRunnerDatabase();
    if (fixture.format !== 'pg16' || !fixture.withRuntimeRole || !fixture.withPeer) {
      throw Error('Category-edit privilege and lock proof requires native PG16 LOGIN peers');
    }
    await fixture.exec(ddl);
    await fixture.db.insert(systemRole).values([
      { id: 900, type: 0, relationId: 0, level: 1, roleName: '素材只读', rules: 'attachment.view' },
      { id: 901, type: 1, relationId: 0, level: 1, roleName: '素材管理', rules: 'attachment.manage' },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 100, account: 'native-category-edit-reader', pwd: password, roles: '900', level: 1 },
      { id: 101, account: 'native-category-edit-manager', pwd: password, roles: '901', level: 1 },
    ]);
    await fixture.db.insert(systemAttachmentCategory).values([
      { id: 12, type: 1, relationId: 0, fileType: 1, pid: 0, name: '图片根' },
      { id: 13, type: 1, relationId: 0, fileType: 1, pid: 12, name: '名'.repeat(50) },
      { id: 14, type: 1, relationId: 0, fileType: 1, pid: 0, name: '备选图片根' },
      { id: 20, type: 1, relationId: 0, fileType: 2, pid: 0, name: '视频根' },
      { id: 21, type: 1, relationId: 0, fileType: 2, pid: 20, name: '视频子' },
      { id: 30, type: 4, relationId: 9, fileType: 1, pid: 0, name: '供应商分类' },
      { id: 40, type: 1, relationId: 7, fileType: 1, pid: 0, name: '其他关系分类' },
    ]);
    await fixture.exec("SELECT setval(pg_get_serial_sequence('system_attachment_category','id'),40,true)");
    readerToken = (await createToken(100, 'admin', md5(password), env.APP_KEY)).token;
    managerToken = (await createToken(101, 'admin', md5(password), env.APP_KEY)).token;
  }, 60_000);

  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await fixture?.close(); }
  }, 30_000);

  const categoryRows = () => fixture.db.select().from(systemAttachmentCategory).orderBy(systemAttachmentCategory.id);

  async function reader<T>(run: (peer: LoginPeer) => Promise<T>): Promise<T> {
    return fixture.withRuntimeRole!(async peer => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe category-edit LOGIN name');
      // Four SELECT grants only; no DML, sequence or login-column grants.
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

  async function getForm(app: ReturnType<typeof application>, prefix: string, id: number, fileType: 1 | 2) {
    const response = await app.request(`http://local${prefix}/file/category/${id}/edit?file_type=${fileType}`,
      { headers: { 'Authori-zation': `Bearer ${readerToken}` } }, env);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json() as Envelope<AdminAttachmentCategoryEditForm>;
    expect(body.status).toBe(200);
    return body.data;
  }

  async function putForm(app: ReturnType<typeof application>, prefix: string, form: AdminAttachmentCategoryEditForm, token: string) {
    // Resolve the actual relative DTO action the same way as either Axios base.
    return app.request(new URL(form.action, `http://local${prefix}/`).href,
      { method: form.method, headers: { 'Content-Type': 'application/json', 'Authori-zation': `Bearer ${token}` },
        body: JSON.stringify({ pid: form.rules[1].value, file_type: form.rules[0].value, name: '不得误改' }) }, env);
  }

  it('reads persisted image/video children and root options using SELECT-only LOGIN, RR READ ONLY and no DML', async () => {
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
      let observedTransactions = 0;
      const app = application(observeReadOnlyTransaction(peer.db, async tx => {
        const [state] = await tx.execute(sql`SELECT pg_backend_pid() AS pid,current_user AS role,session_user AS session,
          current_setting('server_version_num') AS version,current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS readonly`);
        expect(state).toMatchObject({ pid: peer.pid, role: peer.role, session: peer.role,
          isolation: 'repeatable read', readonly: 'on' });
        expect(Math.floor(Number(state.version) / 10_000)).toBe(16);
        observedTransactions++;
      }));
      const image = await getForm(app, '/adminapi', 13, 1);
      const video = await getForm(app, '/api/admin', 21, 2);
      const root = await getForm(app, '/adminapi', 12, 1);
      expect(observedTransactions).toBe(3);
      expect(image).toEqual({ title: '编辑分类', method: 'PUT', action: 'file/category/13', rules: [
        { type: 'hidden', field: 'file_type', value: 1 },
        { type: 'select', field: 'pid', title: '上级分类', value: 12, props: { filterable: true },
          options: [{ value: 0, label: '所有分类' }, { value: 12, label: '图片根' }, { value: 14, label: '备选图片根' }] },
        { type: 'input', field: 'name', title: '分类名称', value: '名'.repeat(50), props: { maxlength: 20 } },
      ] });
      expect(video).toEqual({ title: '编辑分类', method: 'PUT', action: 'file/category/21', rules: [
        { type: 'hidden', field: 'file_type', value: 2 },
        { type: 'select', field: 'pid', title: '上级分类', value: 20, props: { filterable: true },
          options: [{ value: 0, label: '所有分类' }, { value: 20, label: '视频根' }] },
        { type: 'input', field: 'name', title: '分类名称', value: '视频子', props: { maxlength: 20 } },
      ] });
      expect(root.rules[1]).toEqual({ type: 'select', field: 'pid', title: '上级分类', value: 0,
        props: { filterable: true }, options: [{ value: 0, label: '所有分类' }, { value: 14, label: '备选图片根' }] });
      const rejectedWrite = await putForm(app, '/adminapi', image, readerToken);
      expect((await rejectedWrite.json() as Envelope<null>).status).toBe(400011);
      await expect(peer.exec("UPDATE public.system_attachment_category SET name='禁止写' WHERE id=13"))
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
    ['parent deleted', 'DELETE FROM public.system_attachment_category WHERE id=12', '/adminapi'],
    ['target realm changed', 'UPDATE public.system_attachment_category SET relation_id=7 WHERE id=13', '/api/admin'],
  ] as const)('rejects the actual authenticated PUT after a proven scope-lock wait when %s', async (change, mutation, prefix) => {
    await reader(readerPeer => fixture.withPeer!(async writer => fixture.withPeer!(async saving => {
      const offered = await getForm(application(readerPeer.db), prefix, 13, 1);
      expect(offered.rules[1].value).toBe(12);
      const before = await categoryRows();
      const [readIdentity] = await readerPeer.exec('SELECT current_database() AS database,pg_backend_pid() AS pid');
      const [writeIdentity] = await writer.exec('SELECT current_database() AS database,pg_backend_pid() AS pid');
      const [saveIdentity] = await saving.exec('SELECT current_database() AS database,pg_backend_pid() AS pid');
      expect(new Set([readIdentity.pid, writeIdentity.pid, saveIdentity.pid]).size).toBe(3);
      expect(writeIdentity).toEqual({ database: readIdentity.database, pid: writer.pid });
      expect(saveIdentity).toEqual({ database: readIdentity.database, pid: saving.pid });
      await saving.exec("SET lock_timeout='8s'");
      // The real writer owns the same Admin/type1/relation0 advisory scope lock
      // used by saveCategory; the actual HTTP PUT must wait on this exact PID.
      await writer.exec(`BEGIN; SELECT pg_advisory_xact_lock(505610,0); ${mutation}`);
      const pending = outcome(putForm(application(saving.db), prefix, offered, managerToken));
      try {
        await waitForFinanceBlock(fixture.db, saving.pid, writer.pid);
        await writer.exec('COMMIT');
        const expected = change === 'parent deleted'
          ? before.filter(row => row.id !== 12)
          : before.map(row => row.id === 13 ? { ...row, relationId: 7 } : row);
        expect(await categoryRows()).toEqual(expected); // Independent writer commit is visible.
        const result = await pending;
        expect(result.ok).toBe(true);
        if (result.ok) expect(await result.value.json()).toMatchObject({ status: 404, data: null });
        expect(await categoryRows()).toEqual(expected); // PUT made no UPDATE or collateral changes.
      } finally {
        await writer.exec('ROLLBACK');
        await pending; // Drain the HTTP handler and DB transaction before peer cleanup.
      }
    })));
  }, 60_000);
});
