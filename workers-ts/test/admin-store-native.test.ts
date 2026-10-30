import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin, systemAttachment, systemStore, systemStoreStaff, cityArea, storeOrder, user } from '@/models/schema';
import { md5 } from '@/utils/jwt';
import { AdminStoreAuthorService } from '@/services/admin/AdminStoreAuthorService';
import { storeActionHash } from '@/services/admin/AdminStoreAuthorInput';
import { lockCheckoutPickupStore } from '@/services/order/CheckoutPickupPolicy';
import { readStoreManagerIdentities } from '@/services/store/StoreManagerScope';
import { publicStoreImageReferences, renderStoreImageReferences } from '@/services/store/StoreAssetPolicy';
import { runAdminStoreUpgrade } from '@/migrations/runAdminStoreUpgrade';
import { assertAdminStoreOperationReady, inspectAdminStoreOperation } from '@/migrations/adminStoreOperation';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { inspectAdminAuthorityMaintenanceSnapshot } from '@/migrations/adminAuthorityOperationMaintenance';
import { newStoreValues, type StoreAction, type StoreOperation } from '../../view/common/storeAuthor';
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
          if (text.startsWith('GRANT SELECT, INSERT ON TABLE public.admin_store_operation TO ')) { trace.reached = true; throw Error('Owned store interruption after real receipt grant'); }
          return result;
        };
      } });
      return callback(port);
    }, options as Parameters<typeof target.transaction>[1]);
  } });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

// The deployed whole-runtime baseline has no customer-city forward. Explicit
// columns keep its first complete author lifecycle honest; the second phase
// below separately installs and verifies the known optional pair.
const { cityShopId: _cityShopId, business: _business, ...baseStoreColumns } = getTableColumns(systemStore);


/** Pause only after the REAL existing consumer's SELECT has completed. Query
 * builders/rows/SQL are never fabricated; the active transaction retains its
 * observed AccessShare/FOR SHARE lock while the author attempts a delete. */
function pauseFirstStoreRead(db: DbClient, seen: ReturnType<typeof deferred>, resume: ReturnType<typeof deferred>): DbClient {
  let paused = false;
  function builder(target: object, isStore = false): object {
    return new Proxy(target, { get(value, key) {
      if (key === 'then') return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(value).then(async rows => { if (isStore && !paused) { paused = true; seen.resolve(); await resume.promise; } return rows; }).then(resolve, reject);
      const member: unknown = Reflect.get(value, key);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(member, value, args), store = isStore || key === 'from' && args[0] === systemStore;
        return result && typeof result === 'object' && 'then' in result ? builder(result, store) : result;
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
    || url.pathname !== `/${database}` || decodeURIComponent(url.username) !== peer.role || url.search || url.hash) throw Error('Unexpected owned store reader target');
  const client = postgres(url.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
    connection: { options: '-c search_path=public -c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=15000' } });
  try {
    const [identity] = await client`SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num')::integer/10000 AS major`;
    if (identity.database !== database || identity.role !== peer.role || identity.session !== peer.role || identity.pid === peer.pid || identity.major !== 16) throw Error('Reader is not an independent owned PG16 LOGIN');
    return await run({ db: drizzle(client) as unknown as DbClient, pid: Number(identity.pid), exec: text => client.unsafe(text) });
  } finally { await client.end({ timeout: 2 }); }
}


describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('pickup-store explicit addon, independent LOGIN and actual old consumer read→write race', () => {
  afterEach(() => vi.restoreAllMocks());
  it('commissions/replays exact receipts and proves atomic store/staff/order/media contracts under PG16', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned store native acceptance forbids provider I/O'));
    const whole = await refundRuntimeFixture();
    try {
      if (!whole.withRuntimeRole || !whole.withPeer) throw Error('Independent native LOGIN and lock peers required');
      await whole.withRuntimeRole(async app => whole.withRuntimeRole!(async admin => {
        const [identity] = await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance,current_setting('server_version_num')::integer/10000 AS major`);
        expect(identity.major).toBe(16);
        const target = { database: String(identity.database), maintenance: String(identity.maintenance), app: app.role, admin: admin.role };
        await runRuntimeBusinessCommissioning(whole.db, { ...target, pricingOwner: whole.pricingOwner });
        const password = 'owned-store-native-password';
        await whole.db.insert(systemAdmin).values({ id: 900, account: 'owned_store', pwd: password, realName: 'Owned root', roles: '', level: 0, status: 1, isDel: 0, adminType: 1, relationId: 0 });
        await whole.db.insert(systemAttachment).values({ attId: 900001, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
          attDir: '/api/assets/900001', sattDir: '/api/assets/900001', name: 'attachments/admin/1/2026/10/owned-store.png', attType: 'image/png' });
        await whole.db.insert(cityArea).values([{ id: 900001, parentId: 0, level: 1, name: '原生省' },
          { id: 900002, parentId: 900001, level: 2, name: '原生市' }, { id: 900003, parentId: 900002, level: 3, name: '原生区' }]);
        await whole.exec("SELECT setval(pg_get_serial_sequence('public.system_store','id'),(SELECT coalesce(max(id),0)+1 FROM public.system_store),false)");
        const audit = async () => ({ app: await auditRuntimeBusinessPrivileges(app.db, 'app', target), admin: await auditRuntimeBusinessPrivileges(admin.db, 'admin', target) });
        const snapshot = async () => ({ whole: await whole.db.transaction(tx => inspectAdminAuthorityMaintenanceSnapshot(tx, { wholeData: true }), { isolationLevel: 'repeatable read', accessMode: 'read only' }),
          sequences: Array.from(await whole.db.execute(sql`SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`), row => ({ ...row })) });
        expect(await audit()).toMatchObject({ app: { ready: true, failures: [] }, admin: { ready: true, failures: [] } });
        await expect(admin.db.transaction(tx => assertAdminStoreOperationReady(tx))).rejects.toMatchObject({ code: 503 });
        const before = await snapshot(), trace = { reached: false };
        await expect(runAdminStoreUpgrade(interrupted(whole.db, trace), target)).rejects.toThrow('Owned store interruption');
        expect(trace.reached).toBe(true); expect(await snapshot()).toEqual(before); expect(await inspectAdminStoreOperation(whole.db, target)).toBe(false);
        expect(await runAdminStoreUpgrade(whole.db, target)).toEqual({ operation: 'admin-store-operation-v1', applied: true });
        const installed = await snapshot(), old = new Set(before.whole.data.map(row => row.name));
        expect(installed.whole.tableCount).toBe(before.whole.tableCount + 1); expect(installed.whole.data.filter(row => old.has(row.name))).toEqual(before.whole.data);
        expect(installed.whole.data.filter(row => !old.has(row.name))).toEqual([expect.objectContaining({ name: 'admin_store_operation', rows: '0' })]); expect(installed.sequences).toEqual(before.sequences);
        await expect(admin.db.transaction(tx => assertAdminStoreOperationReady(tx))).resolves.toBeUndefined();
        await expect(app.exec('SELECT * FROM public.admin_store_operation')).rejects.toMatchObject({ code: '42501' });
        await expect(app.exec("INSERT INTO public.system_store(name) VALUES('FORBIDDEN')")).rejects.toMatchObject({ code: '42501' });
        for (const statement of ['UPDATE public.admin_store_operation SET actor_id=1', 'DELETE FROM public.admin_store_operation', 'TRUNCATE public.admin_store_operation',
          'ALTER TABLE public.admin_store_operation ADD COLUMN forbidden integer', 'SELECT public.admin_store_operation_immutable_v1()']) await expect(admin.exec(statement)).rejects.toMatchObject({ code: '42501' });
        const actor = { id: 900, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 3600 }, env = { APP_KEY: 'owned-store-native-key' } as Env;
        const service = new AdminStoreAuthorService(createContainerFromDb(admin.db), env), query = new URLSearchParams();
        const intent = async (operation: StoreOperation, target_id: number, payload: Record<string, unknown> = {}): Promise<StoreAction> => {
          const draft = { operation_id: crypto.randomUUID(), actor_id: actor.id, operation, target_id, revision: (await service.catalog(query, actor)).revision, payload };
          return { ...draft, payload_hash: storeActionHash(draft) };
        };
        const optionalShape = async () => {
          const [row] = await whole.db.execute(sql`SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public.system_store'::regclass AND attname IN ('city_shop_id','business') AND attnum>0 AND NOT attisdropped ORDER BY attname) AS names`);
          return row.names;
        };
        expect(await optionalShape()).toEqual([]);
        const draft = { ...newStoreValues(), name: '原生提货点', phone: '13800138000', address: '原生省,原生市,原生区', detailed_address: '原生街道1号',
          latitude: '0', longitude: '121.50', day_time: '22:00:00 - 06:30:00', image: '/api/assets/900001', valid_range: 107, is_show: 1, is_store: 1 };
        const createAction = await intent('create', 0, draft), made = await service.mutate(createAction, actor), id = made.result.id;
        expect(made).toMatchObject({ state: 'committed', operation: 'create', result: { created: 1, updated: 0 } });
        const [created] = await whole.db.select(baseStoreColumns).from(systemStore).where(eq(systemStore.id, id));
        expect(created).toMatchObject({ erpShopId: 0, bankCode: '0', validTime: '', dayStart: '22:00:00', dayEnd: '06:30:00', latitude: '0'.padEnd(25, ' '), longitude: '121.50'.padEnd(25, ' '), isDel: 0 });
        // Maintenance seeds hidden legacy metadata; the author must preserve all
        // of it while changing the explicitly visible name and no credentials.
        await whole.db.update(systemStore).set({ erpShopId: 77, province: 88, city: 89, area: 90, street: 91,
          bankCode: 'native-bank', bankAddress: 'native-bank-address', alipayAccount: 'native-alipay', alipayQrcodeUrl: 'native-alipay-qr',
          wechat: 'native-wechat', wechatQrcodeUrl: 'native-wechat-qr', validTime: 'legacy-inactive-time', oblongImage: '/static/native-oblong.png' }).where(eq(systemStore.id, id));
        const uid = 990111; await whole.db.insert(user).values({ uid, account: 'owned-store-manager', nickname: 'Owned manager', status: 1 });
        await whole.db.insert(systemStoreStaff).values([
          { id: 990201, storeId: id, uid, account: 'native-manager', pwd: 'native-password-hash', roles: 'retained-role-list', isManager: 1, isAdmin: 0, isCashier: 1, status: 1, isDel: 0 },
          { id: 990202, storeId: id, uid: uid + 1, account: 'native-disabled', pwd: 'disabled-hash', roles: 'disabled-role-list', status: 0, isDel: 0 },
          { id: 990203, storeId: id, uid: uid + 2, account: 'native-recycled', pwd: 'recycled-hash', roles: 'recycled-role-list', status: 1, isDel: 1 },
          { id: 990204, storeId: 0, uid: uid + 3, account: 'native-unrelated', pwd: 'unrelated-hash', roles: 'unrelated-role-list', status: 1, isDel: 0 },
        ]);
        const [legacy] = await whole.db.select(baseStoreColumns).from(systemStore).where(eq(systemStore.id, id)), originalStaff = await whole.db.select().from(systemStoreStaff).orderBy(systemStoreStaff.id);
        const updateAction = await intent('update', id, { ...draft, name: '原生提货点改名' }), updated = await service.mutate(updateAction, actor);
        expect((await whole.db.select(baseStoreColumns).from(systemStore).where(eq(systemStore.id, id)))[0]).toEqual({ ...legacy, name: '原生提货点改名' });
        expect(await whole.db.select().from(systemStoreStaff).orderBy(systemStoreStaff.id)).toEqual(originalStaff);
        expect((await readStoreManagerIdentities(app.db, uid)).stores).toMatchObject([{ store_id: id, staff_id: 990201 }]);
        const hideAction = await intent('show', id, { is_show: 0 }), hidden = await service.mutate(hideAction, actor);
        const hiddenStaff = originalStaff.map(row => row.storeId === id && row.isDel === 0 && row.status === 1 ? { ...row, status: 0 } : row);
        expect(await whole.db.select().from(systemStoreStaff).orderBy(systemStoreStaff.id)).toEqual(hiddenStaff);
        expect((await readStoreManagerIdentities(app.db, uid)).stores).toEqual([]);
        const showAction = await intent('show', id, { is_show: 1 }), shown = await service.mutate(showAction, actor);
        const shownStaff = hiddenStaff.map(row => row.storeId === id && row.isDel === 0 && row.status === 0 ? { ...row, status: 1 } : row);
        expect(await whole.db.select().from(systemStoreStaff).orderBy(systemStoreStaff.id)).toEqual(shownStaff);
        const stable = await snapshot();
        for (const [action, receipt] of [[createAction, made], [updateAction, updated], [hideAction, hidden], [showAction, shown]] as const) {
          expect(await service.mutate(action, actor)).toEqual(receipt); expect(await service.receipt(action.operation_id, query, actor)).toEqual(receipt);
        }
        expect(await snapshot()).toEqual(stable);

        // This is the actual old checkout FOR SHARE read, paused only after SQL
        // completed. Its ordinary App transaction then inserts an order. It is
        // catalog concurrency evidence, not an invented purchase/cart path.
        const deletion = await intent('delete', id), beforeRace = await snapshot(), orderNumber = `store-${crypto.randomUUID().replaceAll('-','').slice(0,24)}`;
        await withReader(app, target.database, async reader => {
          const seen = deferred(), resume = deferred();
          const work = reader.db.transaction(async tx => {
            await lockCheckoutPickupStore(pauseFirstStoreRead(tx as unknown as DbClient, seen, resume), id);
            await tx.insert(storeOrder).values({ orderId: orderNumber, uid, storeId: id, status: 0, shippingType: 2 });
          });
          try {
            await Promise.race([seen.promise, work.then(() => { throw Error('Old checkout finished without its real store SELECT'); })]);
            const [held] = await whole.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${reader.pid} AND relation='public.system_store'::regclass AND mode='RowShareLock' AND granted) AS held`);
            expect(held.held).toBe(true);
            const refused = await outcome(service.mutate(deletion, actor));
            if (refused.ok) throw Error('Store author bypassed the actual old consumer store read transaction');
            expect(refused.error).toMatchObject({ httpStatus: 409 }); expect(await snapshot()).toEqual(beforeRace);
          } finally { resume.resolve(); await work; }
        });
        const [order] = await whole.db.select().from(storeOrder).where(eq(storeOrder.orderId, orderNumber)); expect(order).toMatchObject({ storeId: id, status: 0 });
        for (const status of [0, 1, 5]) {
          await whole.db.update(storeOrder).set({ status }).where(eq(storeOrder.id, order!.id));
          const action = await intent('delete', id), frozen = await snapshot(); await expect(service.mutate(action, actor)).rejects.toThrow(/待处理订单/); expect(await snapshot()).toEqual(frozen);
        }
        await whole.db.update(storeOrder).set({ status: 2 }).where(eq(storeOrder.id, order!.id));

        // ERP's already deployed scope trigger uses this same gate. The author
        // must refuse before waiting in the reverse store-table lock order.
        await whole.withPeer!(async peer => { await peer.exec('BEGIN'); try {
          await peer.exec('SELECT pg_advisory_xact_lock(731745,1)'); const action = await intent('delete', id), frozen = await snapshot();
          await expect(service.mutate(action, actor)).rejects.toMatchObject({ httpStatus: 409 }); expect(await snapshot()).toEqual(frozen);
        } finally { await peer.exec('ROLLBACK'); } });

        await whole.exec("CREATE FUNCTION public.owned_store_metadata_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.bank_code='trigger-changed'; RETURN NEW; END$$; CREATE TRIGGER owned_store_metadata_failure BEFORE UPDATE ON public.system_store FOR EACH ROW EXECUTE FUNCTION public.owned_store_metadata_failure()");
        try { const action = await intent('update', id, { ...draft, name: '拒绝隐藏字段篡改' }), frozen = await snapshot(); await expect(service.mutate(action, actor)).rejects.toThrow(/回读/); expect(await snapshot()).toEqual(frozen); await expect(service.receipt(action.operation_id, query, actor)).rejects.toThrow(/未知/); }
        finally { await whole.exec('DROP TRIGGER owned_store_metadata_failure ON public.system_store; DROP FUNCTION public.owned_store_metadata_failure()'); }
        await whole.exec("CREATE FUNCTION public.owned_store_staff_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.pwd='forged-credential'; RETURN NEW; END$$; CREATE TRIGGER owned_store_staff_failure BEFORE UPDATE ON public.system_store_staff FOR EACH ROW EXECUTE FUNCTION public.owned_store_staff_failure()");
        try { const action = await intent('show', id, { is_show: 0 }), frozen = await snapshot(); await expect(service.mutate(action, actor)).rejects.toThrow(/回读/); expect(await snapshot()).toEqual(frozen); }
        finally { await whole.exec('DROP TRIGGER owned_store_staff_failure ON public.system_store_staff; DROP FUNCTION public.owned_store_staff_failure()'); }
        const imageRows = await whole.db.select().from(systemAttachment).orderBy(systemAttachment.attId), raw = [{ image: '/api/assets/900001' }], original = structuredClone(raw);
        expect((await renderStoreImageReferences(env.APP_KEY, await publicStoreImageReferences(admin.db, raw)))[0]!.image).toMatch(/^\/api\/assets\/900001\?expires=/u);
        expect(raw).toEqual(original); expect(await whole.db.select().from(systemAttachment).orderBy(systemAttachment.attId)).toEqual(imageRows);
        const badImage = await intent('update', id, { ...draft, image: '/api/assets/999999' }), badBefore = await snapshot();
        await expect(service.mutate(badImage, actor)).rejects.toThrow(/图片/); expect(await snapshot()).toEqual(badBefore);

        const recycleAction = await intent('delete', id), recycled = await service.mutate(recycleAction, actor);
        expect((await whole.db.select(baseStoreColumns).from(systemStore).where(eq(systemStore.id, id)))[0]).toEqual({ ...legacy, name: '原生提货点改名', isShow: 0, isDel: 1 });
        const recycledStaff = shownStaff.map(row => row.storeId === id && row.isDel === 0 ? { ...row, isDel: 1 } : row);
        expect(await whole.db.select().from(systemStoreStaff).orderBy(systemStoreStaff.id)).toEqual(recycledStaff);
        expect((await readStoreManagerIdentities(app.db, uid)).stores).toEqual([]);
        const restoreAction = await intent('restore', id), restored = await service.mutate(restoreAction, actor);
        expect((await whole.db.select(baseStoreColumns).from(systemStore).where(eq(systemStore.id, id)))[0]).toEqual({ ...legacy, name: '原生提货点改名', isShow: 0, isDel: 0 });
        expect(await whole.db.select().from(systemStoreStaff).orderBy(systemStoreStaff.id)).toEqual(recycledStaff.map(row => row.storeId === id && row.isDel === 1 ? { ...row, isDel: 0 } : row));
        const finalBusiness = await snapshot();
        for (const [action, receipt] of [[recycleAction, recycled], [restoreAction, restored]] as const) { expect(await service.mutate(action, actor)).toEqual(receipt); expect(await service.receipt(action.operation_id, query, actor)).toEqual(receipt); }
        expect(await snapshot()).toEqual(finalBusiness);
        const unused = await intent('create', 0, { ...draft, name: '从未应用的提货点' }), negative = await service.resolve(unused, actor), sealed = await snapshot();
        expect(negative.state).toBe('not_applied'); await expect(service.mutate(unused, actor)).rejects.toMatchObject({ httpStatus: 409 }); expect(await snapshot()).toEqual(sealed);
        // The legacy profile has completed create/update/show/delete/restore,
        // its actual old-reader race and atomic receipt checks with NO optional
        // DDL. A separate explicit current-profile phase now adds only the
        // already supported customer-city pair; this is not store commissioning.
        expect(await optionalShape()).toEqual([]);
        await whole.exec("ALTER TABLE public.system_store ADD COLUMN city_shop_id varchar(255) NOT NULL DEFAULT '', ADD COLUMN business integer NOT NULL DEFAULT 0");
        expect(await optionalShape()).toEqual(['business', 'city_shop_id']);
        const currentDraft = { ...draft, name: '当前列结构提货点' };
        const currentCreate = await intent('create', 0, currentDraft), currentMade = await service.mutate(currentCreate, actor), currentId = currentMade.result.id;
        const [currentCreated] = await whole.db.select().from(systemStore).where(eq(systemStore.id, currentId));
        expect(currentCreated).toMatchObject({ name: currentDraft.name, cityShopId: '', business: 0, bankCode: '0', erpShopId: 0 });
        await whole.db.update(systemStore).set({ business: 3, cityShopId: 'native-station', erpShopId: 91, bankCode: 'current-profile-bank', oblongImage: '/static/current-oblong.png' }).where(eq(systemStore.id, currentId));
        const [currentLegacy] = await whole.db.select().from(systemStore).where(eq(systemStore.id, currentId));
        const currentUpdate = await intent('update', currentId, { ...currentDraft, name: '当前列结构改名' }), currentUpdated = await service.mutate(currentUpdate, actor);
        expect((await whole.db.select().from(systemStore).where(eq(systemStore.id, currentId)))[0]).toEqual({ ...currentLegacy, name: '当前列结构改名' });
        await whole.exec("CREATE FUNCTION public.owned_store_city_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.business=NEW.business+1; NEW.city_shop_id='forged-city-binding'; RETURN NEW; END$$; CREATE TRIGGER owned_store_city_failure BEFORE UPDATE ON public.system_store FOR EACH ROW EXECUTE FUNCTION public.owned_store_city_failure()");
        try {
          const action = await intent('update', currentId, { ...currentDraft, name: '拒绝城市元数据篡改' }), frozen = await snapshot();
          await expect(service.mutate(action, actor)).rejects.toThrow(/回读/); expect(await snapshot()).toEqual(frozen);
          await expect(service.receipt(action.operation_id, query, actor)).rejects.toThrow(/未知/);
        } finally { await whole.exec('DROP TRIGGER owned_store_city_failure ON public.system_store; DROP FUNCTION public.owned_store_city_failure()'); }
        const currentStable = await snapshot();
        for (const [action, receipt] of [[currentCreate, currentMade], [currentUpdate, currentUpdated], [createAction, made]] as const) {
          expect(await service.mutate(action, actor)).toEqual(receipt); expect(await service.receipt(action.operation_id, query, actor)).toEqual(receipt);
        }
        expect(await snapshot()).toEqual(currentStable);
        expect(await audit()).toMatchObject({ app: { ready: true, failures: [] }, admin: { ready: true, failures: [] } });
        for (const statement of ['UPDATE public.admin_store_operation SET actor_id=1', 'DELETE FROM public.admin_store_operation', 'TRUNCATE public.admin_store_operation']) await expect(whole.exec(statement)).rejects.toMatchObject({ code: '42501' });
        await whole.withPeer!(async peer => { await peer.exec('BEGIN'); try { await peer.exec('SELECT pg_advisory_xact_lock(731626,18)'); await expect(runAdminStoreUpgrade(whole.db, target)).rejects.toThrow('busy'); await expect(admin.db.transaction(tx => assertAdminStoreOperationReady(tx))).rejects.toMatchObject({ code: 503 }); } finally { await peer.exec('ROLLBACK'); } });
        for (const lock of ['LOCK TABLE ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE', 'LOCK TABLE ONLY public.admin_store_operation IN ACCESS SHARE MODE']) await whole.withPeer!(async peer => { await peer.exec('BEGIN'); try { await peer.exec(lock); await expect(runAdminStoreUpgrade(whole.db, target)).rejects.toThrow(); } finally { await peer.exec('ROLLBACK'); } });
        await whole.exec('GRANT SELECT ON public.admin_store_operation TO PUBLIC');
        try { expect((await audit()).admin.ready).toBe(false); await expect(runAdminStoreUpgrade(whole.db, target)).rejects.toThrow('exact existing runtime profiles'); }
        finally { await whole.exec('REVOKE SELECT ON public.admin_store_operation FROM PUBLIC'); }
        const final = await snapshot(); expect(await runAdminStoreUpgrade(whole.db, target)).toEqual({ operation: 'admin-store-operation-v1', applied: false }); expect(await snapshot()).toEqual(final);
        expect(await audit()).toMatchObject({ app: { ready: true, failures: [] }, admin: { ready: true, failures: [] } });
      }));
      expect(fetch).not.toHaveBeenCalled();
    } finally { await whole.close(); }
  }, 180000);
});
