import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin, systemAttachment, systemUserLevel, user, userLevel } from '@/models/schema';
import { md5 } from '@/utils/jwt';
import { AdminLevelAuthorService } from '@/services/admin/AdminLevelAuthorService';
import { levelActionHash } from '@/services/admin/AdminLevelAuthorInput';
import { applyMobileUserState } from '@/services/user/MobileUserManagementCore';
import { detectUserLevel } from '@/services/order/OrderRewardService';
import { publicLevelImageReferences, renderLevelImageReferences } from '@/services/user/LevelAssetPolicy';
import { UserLevelService } from '@/services/user/UserLevelService';
import { runAdminLevelUpgrade } from '@/migrations/runAdminLevelUpgrade';
import { assertAdminLevelOperationReady, inspectAdminLevelOperation } from '@/migrations/adminLevelOperation';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { inspectAdminAuthorityMaintenanceSnapshot } from '@/migrations/adminAuthorityOperationMaintenance';
import { newLevelValues, type LevelAction, type LevelOperation } from '../../view/common/levelAuthor';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { outcome } from './helpers/financePeers';

function interrupted(db: DbClient, trace: { reached: boolean }): DbClient {
  const dialect = new PgDialect();
  return new Proxy(db, { get(target, key) {
    const method: unknown = Reflect.get(target, key); if (typeof method !== 'function') return method;
    if (key !== 'transaction') return method.bind(target);
    return (callback: (tx: Pick<DbClient, 'execute'>) => Promise<unknown>, options: unknown) => target.transaction(async tx => {
      const port = new Proxy(tx, { get(current, property) {
        const member: unknown = Reflect.get(current, property); if (typeof member !== 'function') return member;
        if (property !== 'execute') return member.bind(current);
        return async (query: Parameters<typeof tx.execute>[0]) => {
          const text = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql, result = await tx.execute(query);
          if (text.startsWith('GRANT SELECT, INSERT ON TABLE public.admin_level_operation TO ')) { trace.reached = true; throw Error('Owned level interruption after real receipt grant'); }
          return result;
        };
      } });
      return callback(port);
    }, options as Parameters<typeof target.transaction>[1]);
  } });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** Pause only after the REAL existing consumer's SELECT has completed. Query
 * builders/rows/SQL are never fabricated; the active transaction retains its
 * observed AccessShare/FOR SHARE lock while the author attempts a delete. */
function pauseFirstLevelRead(db: DbClient, seen: ReturnType<typeof deferred>, resume: ReturnType<typeof deferred>): DbClient {
  let paused = false;
  function builder(target: object, isLevel = false): object {
    return new Proxy(target, { get(value, key) {
      if (key === 'then') return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(value).then(async rows => { if (isLevel && !paused) { paused = true; seen.resolve(); await resume.promise; } return rows; }).then(resolve, reject);
      const member: unknown = Reflect.get(value, key);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(member, value, args), level = isLevel || key === 'from' && args[0] === systemUserLevel;
        return result && typeof result === 'object' && 'then' in result ? builder(result, level) : result;
      };
    } });
  }
  return new Proxy(db, { get(target, key) {
    const member: unknown = Reflect.get(target, key); if (typeof member !== 'function') return member;
    if (key !== 'select') return member.bind(target);
    return (...args: unknown[]) => builder(Reflect.apply(member, target, args) as object);
  } });
}

async function withReader<T>(peer: { role: string; connectionString: string; pid: number }, database: string,
  run: (reader: { db: DbClient; pid: number; exec: (text: string) => Promise<unknown> }) => Promise<T>) {
  const url = new URL(peer.connectionString);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(database)
    || url.pathname !== `/${database}` || decodeURIComponent(url.username) !== peer.role || url.search || url.hash) throw Error('Unexpected owned level reader target');
  const client = postgres(url.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
    connection: { options: '-c search_path=public -c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=15000' } });
  try {
    const [identity] = await client`SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num')::integer/10000 AS major`;
    if (identity.database !== database || identity.role !== peer.role || identity.session !== peer.role || identity.pid === peer.pid || identity.major !== 16) throw Error('Reader is not an independent owned PG16 LOGIN');
    return await run({ db: drizzle(client) as unknown as DbClient, pid: Number(identity.pid), exec: text => client.unsafe(text) });
  } finally { await client.end({ timeout: 2 }); }
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('ordinary member-level explicit addon, native read→assignment/reward races and atomic author history', () => {
  afterEach(() => vi.restoreAllMocks());
  it('commissions/replays with exact ACL, exercises the real author and both old consumers, and rolls back reference/history/asset failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned level native acceptance forbids provider I/O'));
    const whole = await refundRuntimeFixture();
    try {
      if (!whole.withRuntimeRole || !whole.withPeer) throw Error('Independent native LOGIN and lock peers required');
      await whole.withRuntimeRole(async app => whole.withRuntimeRole!(async admin => {
        const [identity] = await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance,current_setting('server_version_num')::integer/10000 AS major`);
        expect(identity.major).toBe(16);
        const target = { database: String(identity.database), maintenance: String(identity.maintenance), app: app.role, admin: admin.role };
        await runRuntimeBusinessCommissioning(whole.db, { ...target, pricingOwner: whole.pricingOwner });
        const password = 'owned-level-native-password';
        await whole.db.insert(systemAdmin).values({ id: 900, account: 'owned_level', pwd: password, realName: 'Owned root', roles: '', level: 0, status: 1, isDel: 0, adminType: 1, relationId: 0 });
        await whole.db.insert(systemAttachment).values({ attId: 900001, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
          attDir: '/api/assets/900001', sattDir: '/api/assets/900001', name: 'attachments/admin/1/2026/10/owned-level.png', attType: 'image/png' });
        await whole.exec("SELECT setval(pg_get_serial_sequence('public.system_user_level','id'),(SELECT coalesce(max(id),0)+1 FROM public.system_user_level),false)");
        const audit = async () => ({ app: await auditRuntimeBusinessPrivileges(app.db, 'app', target), admin: await auditRuntimeBusinessPrivileges(admin.db, 'admin', target) });
        const snapshot = async () => ({ whole: await whole.db.transaction(tx => inspectAdminAuthorityMaintenanceSnapshot(tx, { wholeData: true }), { isolationLevel: 'repeatable read', accessMode: 'read only' }),
          sequences: Array.from(await whole.db.execute(sql`SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`), row => ({ ...row })) });
        expect(await audit()).toMatchObject({ app: { ready: true, failures: [] }, admin: { ready: true, failures: [] } });
        await expect(admin.db.transaction(tx => assertAdminLevelOperationReady(tx))).rejects.toMatchObject({ code: 503 });
        const before = await snapshot(), trace = { reached: false };
        await expect(runAdminLevelUpgrade(interrupted(whole.db, trace), target)).rejects.toThrow('Owned level interruption');
        expect(trace.reached).toBe(true); expect(await snapshot()).toEqual(before); expect(await inspectAdminLevelOperation(whole.db, target)).toBe(false);
        expect(await runAdminLevelUpgrade(whole.db, target)).toEqual({ operation: 'admin-level-operation-v1', applied: true });
        const installed = await snapshot(), old = new Set(before.whole.data.map(row => row.name));
        expect(installed.whole.tableCount).toBe(before.whole.tableCount + 1); expect(installed.whole.data.filter(row => old.has(row.name))).toEqual(before.whole.data);
        expect(installed.whole.data.filter(row => !old.has(row.name))).toEqual([expect.objectContaining({ name: 'admin_level_operation', rows: '0' })]); expect(installed.sequences).toEqual(before.sequences);
        await expect(admin.db.transaction(tx => assertAdminLevelOperationReady(tx))).resolves.toBeUndefined();
        await expect(app.exec('SELECT * FROM public.admin_level_operation')).rejects.toMatchObject({ code: '42501' });
        await expect(app.exec("INSERT INTO public.system_user_level(name) VALUES('FORBIDDEN')")).rejects.toMatchObject({ code: '42501' });
        for (const statement of ['UPDATE public.admin_level_operation SET actor_id=1', 'DELETE FROM public.admin_level_operation', 'TRUNCATE public.admin_level_operation',
          'ALTER TABLE public.admin_level_operation ADD COLUMN forbidden integer', 'SELECT public.admin_level_operation_immutable_v1()']) await expect(admin.exec(statement)).rejects.toMatchObject({ code: '42501' });
        const actor = { id: 900, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 3600 }, env = { APP_KEY: 'owned-level-native-key' } as Env;
        const service = new AdminLevelAuthorService(createContainerFromDb(admin.db), env), query = new URLSearchParams();
        const intent = async (operation: LevelOperation, target_id: number, payload: Record<string, unknown> = {}): Promise<LevelAction> => {
          const draft = { operation_id: crypto.randomUUID(), actor_id: actor.id, operation, target_id, revision: (await service.catalog(query, actor)).revision, payload };
          return { ...draft, payload_hash: levelActionHash(draft) };
        };
        const values = async (name: string) => { const list = (await service.catalog(query, actor)).list; return { ...newLevelValues(), name,
          grade: Math.max(0, ...list.map(row => row.grade)) + 1, exp_num: Math.max(0, ...list.map(row => row.expNum)) + 100,
          discount: '95.50', icon: '/api/assets/900001', image: '/static/native-level-bg.png', color: '#123456', explain: 'Owned level', is_show: 1 }; };
        const draft = await values('Native level'), createAction = await intent('create', 0, draft), made = await service.mutate(createAction, actor), id = made.result.id;
        expect(made).toMatchObject({ state: 'committed', operation: 'create', result: { created: 1 } });
        const updateAction = await intent('update', id, { ...draft, name: 'Edited native level' }), updated = await service.mutate(updateAction, actor);
        const hideAction = await intent('show', id, { is_show: 0 }), hidden = await service.mutate(hideAction, actor);
        const showAction = await intent('show', id, { is_show: 1 }), shown = await service.mutate(showAction, actor);
        const after = await snapshot();
        for (const [action, receipt] of [[createAction, made], [updateAction, updated], [hideAction, hidden], [showAction, shown]] as const) {
          expect(await service.mutate(action, actor)).toEqual(receipt); expect(await service.receipt(action.operation_id, query, actor)).toEqual(receipt);
        }
        expect(await snapshot()).toEqual(after);
        const definition = (await whole.db.select().from(systemUserLevel).where(eq(systemUserLevel.id, id)))[0]!;
        expect(definition.discount).toBe('95.50'); expect(definition.icon).toBe('/api/assets/900001');
        const attachmentRows = await whole.db.select().from(systemAttachment).orderBy(systemAttachment.attId);
        const publicLevels = new UserLevelService(createContainerFromDb(app.db), env), publicRows = await publicLevels.gradeList();
        expect(publicRows.find(row => row.id === id)).toMatchObject({ discount: 95.5, icon: expect.stringMatching(/^\/api\/assets\/900001\?expires=/u) });
        expect(await whole.db.select().from(systemAttachment).orderBy(systemAttachment.attId)).toEqual(attachmentRows);
        // Both existing real consumer functions pause AFTER their actual level
        // SELECT, proving read→later-write cannot race a catalog deletion.
        for (const [index, consumer] of [admin, app].entries()) {
          const uid = 990001 + index; await whole.db.insert(user).values({ uid, account: `owned-level-race-${index}`, nickname: 'Owned level', level: 0 });
          const deletion = await intent('delete', id), frozen = await snapshot();
          await withReader(consumer, target.database, async reader => {
            const seen = deferred(), resume = deferred();
            const work = reader.db.transaction(async tx => {
              const port = pauseFirstLevelRead(tx as unknown as DbClient, seen, resume);
              if (index === 0) await applyMobileUserState(port, { type: 1, uids: [uid], levelId: id }, async () => {});
              else await detectUserLevel(port, uid, 'Owned native', definition.expNum * 100, Math.floor(Date.now() / 1000));
            });
            try {
              await Promise.race([seen.promise, work.then(() => { throw Error('Existing consumer finished without the real level-read barrier'); })]);
              const expectedLock=index===0?'RowShareLock':'AccessShareLock';
              const [lock] = await whole.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${reader.pid} AND relation='public.system_user_level'::regclass AND mode=${expectedLock} AND granted) AS held`);
              expect(lock.held).toBe(true);
              const refused = await outcome(service.mutate(deletion, actor));
              if (refused.ok) throw Error('Level author bypassed a live old consumer read transaction');
              expect(refused.error).toMatchObject({ httpStatus: 409 }); expect(await snapshot()).toEqual(frozen);
            } finally { resume.resolve(); await work; }
          });
          expect((await whole.db.select().from(user).where(eq(user.uid, uid)))[0]!.level).toBe(id);
          const referenced = await snapshot(); await expect(service.mutate(deletion, actor)).rejects.toThrow(/用户/); expect(await snapshot()).toEqual(referenced);
          expect((await service.resolve(deletion, actor)).state).toBe('not_applied');
        }
        // A failed history update happens after definition soft-delete, yet the
        // whole service transaction and its absent UUID receipt must roll back.
        const disposableValues = await values('Disposable native level'), disposable = await service.mutate(await intent('create', 0, disposableValues), actor), disposableId = disposable.result.id;
        await whole.db.insert(userLevel).values({ uid: 990001, levelId: disposableId, grade: disposableValues.grade, status: 0, isDel: 0, mark: 'Historical content', discount: 95 });
        const deletion = await intent('delete', disposableId), originalHistory = await whole.db.select().from(userLevel).orderBy(userLevel.id);
        await whole.exec("CREATE FUNCTION public.owned_level_history_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Owned historical rollback'; END $$; CREATE TRIGGER owned_level_history_failure BEFORE UPDATE ON public.user_level FOR EACH ROW EXECUTE FUNCTION public.owned_level_history_failure()");
        const frozen = await snapshot(); await expect(service.mutate(deletion, actor)).rejects.toThrow(); expect(await snapshot()).toEqual(frozen);
        await whole.exec('DROP TRIGGER owned_level_history_failure ON public.user_level; DROP FUNCTION public.owned_level_history_failure()');
        const removed = await service.mutate(deletion, actor); expect(removed).toMatchObject({ state: 'committed', operation: 'delete', result: { id: disposableId, updated: 1 } });
        expect((await whole.db.select().from(systemUserLevel).where(eq(systemUserLevel.id, disposableId)))[0]!.isDel).toBe(1);
        expect(await whole.db.select().from(userLevel).orderBy(userLevel.id)).toEqual(originalHistory.map(row => row.levelId === disposableId ? { ...row, isDel: 1 } : row));
        const unused = await intent('create', 0, await values('Never applied native')), negative = await service.resolve(unused, actor), sealed = await snapshot();
        expect(negative.state).toBe('not_applied'); await expect(service.mutate(unused, actor)).rejects.toMatchObject({ httpStatus: 409 }); expect(await snapshot()).toEqual(sealed);
        const raw = [{ icon: '/api/assets/900001', image: '/static/native-level-bg.png' }], original = structuredClone(raw);
        const preview = await renderLevelImageReferences(env.APP_KEY, await publicLevelImageReferences(admin.db, raw)); expect(preview[0]!.icon).toMatch(/^\/api\/assets\/900001\?expires=/u); expect(raw).toEqual(original);
        const badValues = { ...newLevelValues((await service.catalog(query, actor)).list.find(row => row.id === id)!), icon: '/api/assets/999999' }, bad = await intent('update', id, badValues), mediaBefore = await snapshot();
        await expect(service.mutate(bad, actor)).rejects.toThrow(/图片/); expect(await snapshot()).toEqual(mediaBefore);
        for (const statement of ['UPDATE public.admin_level_operation SET actor_id=1', 'DELETE FROM public.admin_level_operation', 'TRUNCATE public.admin_level_operation']) await expect(whole.exec(statement)).rejects.toMatchObject({ code: '42501' });
        await whole.withPeer!(async peer => { await peer.exec('BEGIN'); try { await peer.exec('SELECT pg_advisory_xact_lock(731626,16)'); await expect(runAdminLevelUpgrade(whole.db, target)).rejects.toThrow('busy'); await expect(admin.db.transaction(tx => assertAdminLevelOperationReady(tx))).rejects.toMatchObject({ code: 503 }); } finally { await peer.exec('ROLLBACK'); } });
        for (const lock of ['LOCK TABLE ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE', 'LOCK TABLE ONLY public.admin_level_operation IN ACCESS SHARE MODE']) await whole.withPeer!(async peer => { await peer.exec('BEGIN'); try { await peer.exec(lock); await expect(runAdminLevelUpgrade(whole.db, target)).rejects.toThrow(); } finally { await peer.exec('ROLLBACK'); } });
        await whole.exec('GRANT SELECT ON public.admin_level_operation TO PUBLIC');
        try { expect((await audit()).admin.ready).toBe(false); await expect(runAdminLevelUpgrade(whole.db, target)).rejects.toThrow('exact existing runtime profiles'); }
        finally { await whole.exec('REVOKE SELECT ON public.admin_level_operation FROM PUBLIC'); }
        const final = await snapshot(); expect(await runAdminLevelUpgrade(whole.db, target)).toEqual({ operation: 'admin-level-operation-v1', applied: false }); expect(await snapshot()).toEqual(final);
        expect(await audit()).toMatchObject({ app: { ready: true, failures: [] }, admin: { ready: true, failures: [] } });
      }));
      expect(fetch).not.toHaveBeenCalled();
    } finally { await whole.close(); }
  }, 180000);
});
