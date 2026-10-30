/** Native PG16 internal provider-boundary tests, not HTTP/provider acceptance.
 * Synthetic committed refund rows do not establish an actor or an exclusive
 * invocation claim. Existing financial scope/receipt suites remain required.
 * Production selects App/Admin/manager DB bindings; ordinary customer-work
 * keeps the App binding. The extra independent manager/customer LOGINs here
 * receive only three profile-derived provider snapshot SELECT grants, not a
 * complete manager installation or a production customer binding. Neither
 * read-only peer receives staff DML or any Native App table authority. */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import * as Di from '@/lib/di';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderRefund, storeOrderRefundPayment, systemAdmin, systemConfig, systemMenus, systemRole } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { ADMIN_WECHAT_APP_OPERATION_SQL } from '@/migrations/adminWechatAppOperation';
import { managerRuntimePrivilegePlan } from '@/migrations/managerRuntimePrivilegePlan';
import { customerFinancialRuntimePrivilegePlan } from '@/migrations/customerFinancialRuntimePlan';
import type { RuntimePrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import * as Authority from '@/services/payment/NativeAppPaymentAuthority';
import { assertNativeAppRefundProviderRequest } from '@/services/payment/NativeAppRefundProviderAuthority';
import type { RefundProviderRequest } from '@/services/payment/RefundGateway';
import { registerPaymentReconciliationIntent } from '@/services/payment/PaymentReconciliationRegistry';
import { AdminWechatAppService } from '@/services/admin/AdminWechatAppService';
import { WECHAT_APP_VIEW_SEED, WECHAT_APP_SAVE_SEED } from '@/services/admin/AdminWechatAppPermissionBinding';
import { md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

type F = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<F['withRuntimeRole']>>[0] extends (peer: infer P) => unknown ? P : never;
type Ctx = { f: F; app: Peer; admin: Peer; manager: Peer; customer: Peer; env: Env; request: RefundProviderRequest };
const APP_ID = 'wxrefundproviderA', M1 = '1900000101', M2 = '1900000202';
const ORDER_ID = 884401, REFUND_ID = 884402, CONFIG_ID = 884348, MCH_ID = 884350, ADMIN_ID = 884379;
const ORDER_NO = 'refund_provider_original', REASON = '  Exact committed refund reason  ';
const now = () => Math.floor(Date.now() / 1000);
const dialect = new PgDialect();
const queryText = (query: SQL) => dialect.sqlToQuery(query).sql;

async function tableProfile(f: F, peer: Peer, plan: RuntimePrivilegePlan) {
  // This provider verifier reads only these existing financial rows. A full
  // cloned App grant on a new customer LOGIN would bypass the App-named staff
  // fence and also change global gift-receipt authority. Do not install it.
  for (const name of ['store_order','store_order_refund','store_order_refund_payment']) {
    if (!plan.tables[name]?.includes('SELECT')) throw Error('Existing financial profile lacks provider snapshot read');
    await f.exec(`GRANT SELECT ON public.${pricingIdentifier(name)} TO ${pricingIdentifier(peer.role)}`);
  }
}
async function fixture(run: (c: Ctx) => Promise<void>, install = true) {
  const f = await refundRuntimeFixture();
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider HTTP in native extra-verifier tests'));
  try {
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.pricingOwner) throw Error('Real isolated PG16 LOGINs required');
    await f.withRuntimeRole(app => f.withRuntimeRole!(admin => f.withRuntimeRole!(manager => f.withRuntimeRole!(async customer => {
      const [owner] = await f.exec('SELECT current_database() AS database,current_user AS maintenance');
      const target = { database: String(owner.database), maintenance: String(owner.maintenance), app: app.role, admin: admin.role, pricingOwner: f.pricingOwner! };
      await runRuntimeBusinessCommissioning(f.db, target);
      await tableProfile(f, manager, managerRuntimePrivilegePlan());
      await tableProfile(f, customer, customerFinancialRuntimePrivilegePlan());
      for (const peer of [app, admin, manager, customer]) {
        const [id] = await peer.exec(`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
          current_setting('server_version_num')::int/10000 AS major,
          rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls AS elevated
          FROM pg_catalog.pg_roles WHERE rolname=current_user`);
        expect(id).toEqual({ role: peer.role, session: peer.role, pid: peer.pid, major: 16, elevated: false });
      }
      expect(new Set([app, admin, manager, customer].map(p => p.role)).size).toBe(4);
      expect(new Set([app, admin, manager, customer].map(p => p.pid)).size).toBe(4);
      await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, ['wechat_app_appid','wechat_app_appsecret','pay_weixin_mchid',
        'wechat_appid','wechat_appsecret','routine_appId','routine_appsecret','wechat_open_app_id','wechat_open_app_secret']));
      await f.db.insert(systemConfig).values([
        { id: CONFIG_ID, menuName: 'wechat_app_appid', value: JSON.stringify(APP_ID), configTabId: 73, sort: 1 },
        { id: MCH_ID, menuName: 'pay_weixin_mchid', value: JSON.stringify(M1), sort: 1 },
      ]);
      if (install) await runAdminWechatAppUpgrade(f.db, target);
      await f.db.insert(storeOrder).values({ id: ORDER_ID, orderId: ORDER_NO, uid: 11, paid: 1, payType: 'weixin',
        payPrice: '12.50', totalPrice: '12.50', totalNum: 1, tradeNo: 'owned_provider_transaction' });
      await f.db.insert(storeOrderRefund).values({ id: REFUND_ID, storeOrderId: ORDER_ID, orderId: 'owned_provider_refund',
        uid: 11, applyType: 1, refundType: 0, refundPrice: '5.00', refundReason: REASON, refundNum: 1 });
      await f.db.insert(storeOrderRefundPayment).values({ refundId: REFUND_ID, storeOrderId: ORDER_ID, provider: 'wechat',
        outRefundNo: 'CNSR' + REFUND_ID, requestAmount: 500, totalAmount: 1250, providerStatus: 'REQUESTING',
        requestTime: now(), attemptCount: 1, updateTime: now() });
      const env = { APP_KEY: 'owned-extra-refund-verifier-key', HYPERDRIVE: { connectionString: app.connectionString },
        CONFIG_KV: { get: vi.fn(async () => { throw Error('No cached authority'); }), put: vi.fn(), delete: vi.fn(async () => {}) } } as unknown as Env;
      await run({ f, app, admin, manager, customer, env, request: { outTradeNo: ORDER_NO,
        transactionId: 'owned_provider_transaction', outRefundNo: 'CNSR' + REFUND_ID, refundAmount: 500, totalAmount: 1250, reason: REASON } });
      expect(network).not.toHaveBeenCalled(); expect(env.CONFIG_KV.get).not.toHaveBeenCalled();
    }))));
  } finally { await f.close(); }
}
const check = (c: Ctx, role: Peer = c.manager, mode: 'request' | 'query' = 'request', request = c.request, env = c.env, merchant = M1) =>
  assertNativeAppRefundProviderRequest(createContainerFromDb(role.db), env, request, mode, merchant);
async function confirmed(c: Ctx, domain = 'store_order') {
  const container = createContainerFromDb(c.app.db);
  await registerPaymentReconciliationIntent(container, { provider: 'wechat', profile: 'app', orderNo: ORDER_NO,
    orderDomain: domain as 'store_order' | 'membership', expectedAmountCents: 1250, initiated: true });
  const pair = await Authority.readNativeAppPaymentAccount(container, c.env);
  const selected = await Authority.recordNativeAppPaymentInitiation(container, c.env, { appId: pair.appId, merchantId: pair.merchantId,
    profile: 'app', orderNo: ORDER_NO, orderDomain: domain, amountCents: 1250, currency: 'CNY', configStamp: pair.stamp });
  // Synthetic already-verified facts only: transport/crypto is separately tested.
  await Authority.confirmNativeAppPaymentInitiation(container, c.env, selected, { appId: selected.appId, merchantId: selected.merchantId,
    orderNo: ORDER_NO, amountCents: 1250, currency: 'CNY', tradeType: 'APP', prepayId: 'owned_provider_prepay' });
}
async function state(c: Ctx) {
  const tables = ['store_order','store_order_refund','store_order_refund_payment','system_config',
    'admin_wechat_app_operation','native_app_payment_account','native_app_payment_evidence'];
  const rows: Record<string, unknown> = {};
  for (const name of tables) rows[name] = await c.f.exec(`SELECT to_jsonb(t)::text AS row,xmin::text AS xmin
    FROM public.${pricingIdentifier(name)} t ORDER BY to_jsonb(t)::text`);
  rows.native_acl = await c.f.exec("SELECT relname,relacl::text FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'native_app_payment_%' ORDER BY relname");
  return rows;
}
/** Test-host observation only. Every SQL statement still reaches real PG; a
 * callback can arrange a concurrent committed mutation after an actual read. */
function observed(db: DbClient, after: (text: string, result: unknown) => Promise<unknown>): DbClient {
  return new Proxy(db, { get(target, key, receiver) {
    if (key === 'transaction') return (run: (tx: DbClient) => Promise<unknown>) => target.transaction(async tx => {
      const proxy = new Proxy(tx, { get(t, k, r) {
        if (k === 'execute') return async (q: SQL) => after(queryText(q), await t.execute(q));
        return Reflect.get(t, k, r);
      } });
      return run(proxy as unknown as DbClient);
    });
    return Reflect.get(target, key, receiver);
  } });
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Native App extra refund verifier with distinct restricted PG16 connections', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps whole-namespace absence legacy without opening an App connection or requiring App configuration', async () => fixture(async c => {
    const create = vi.spyOn(Di, 'createDbFromConnectionString');
    const missing = { APP_KEY: '', HYPERDRIVE: undefined } as unknown as Env;
    await expect(check(c, c.manager, 'request', c.request, missing)).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  }, false), 180000);

  it('rejects partial and orphan namespace states before creating the App verification connection', async () => fixture(async c => {
    const create = vi.spyOn(Di, 'createDbFromConnectionString');
    await c.f.exec("CREATE FUNCTION public.native_app_payment_orphan() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
    await expect(check(c)).rejects.toMatchObject({ code: 503 });
    await c.f.exec('DROP FUNCTION public.native_app_payment_orphan()');
    await c.f.db.execute(sql.raw(ADMIN_WECHAT_APP_OPERATION_SQL));
    await expect(check(c)).rejects.toMatchObject({ code: 503 });
    expect(create).not.toHaveBeenCalled();
  }, false), 180000);

  it('checks one confirmed original from App Admin manager and customer table profiles without broadening or mutating them', async () => fixture(async c => {
    await confirmed(c);
    for (const peer of [c.manager, c.customer]) {
      const [acl] = await peer.exec(`SELECT has_table_privilege(current_user,'public.native_app_payment_account','SELECT') AS account,
        has_table_privilege(current_user,'public.native_app_payment_evidence','SELECT') AS evidence,
        has_table_privilege(current_user,'public.system_admin','UPDATE') AS author`);
      expect(acl).toEqual({ account: false, evidence: false, author: false });
    }
    const original = Authority.assertNativeAppRefundAccountInTx;
    const seen: string[] = [];
    vi.spyOn(Authority, 'assertNativeAppRefundAccountInTx').mockImplementation(async (tx, env, value) => {
      const [id] = await tx.execute<{ role: string; session: string; readonly: string; isolation: string }>(sql`SELECT current_user AS role,
        session_user AS session,current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`);
      expect(id).toEqual({ role: c.app.role, session: c.app.role, readonly: 'on', isolation: 'read committed' }); seen.push(id.role);
      await original(tx, env, value);
    });
    const before = await state(c);
    for (const peer of [c.app, c.admin, c.manager, c.customer]) await expect(check(c, peer)).resolves.toBeUndefined();
    expect(seen).toHaveLength(4); expect(await state(c)).toEqual(before);
    const [closed] = await c.f.exec("SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND application_name='cinashop_app_refund_verify'");
    expect(closed).toEqual({ n: 0 });
    const sessions = await c.f.db.execute<{ pid: number; idle: boolean }>(sql`SELECT pid,state='idle' AND xact_start IS NULL AS idle
      FROM pg_catalog.pg_stat_activity WHERE pid IN (${sql.join([c.app,c.admin,c.manager,c.customer].map(peer => sql`${peer.pid}`), sql`,`)})`);
    expect(sessions).toHaveLength(4); expect(sessions.every(session => session.idle)).toBe(true);
  }), 180000);

  it('requires an actual App verifier LOGIN and closes a failed wrong-role connection', async () => fixture(async c => {
    const before = await state(c);
    await expect(check(c, c.manager, 'request', c.request, { ...c.env, HYPERDRIVE: { connectionString: c.admin.connectionString } } as Env)).rejects.toMatchObject({ code: 503 });
    await expect(check(c, c.customer, 'request', c.request, { ...c.env, HYPERDRIVE: { connectionString: c.manager.connectionString } } as Env)).rejects.toMatchObject({ code: 503 });
    expect(await state(c)).toEqual(before);
    const [closed] = await c.f.exec("SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND application_name='cinashop_app_refund_verify'");
    expect(closed).toEqual({ n: 0 });
  }), 180000);

  it('binds every request field and committed ownership amount and parent relationship before any App check', async () => fixture(async c => {
    const inTx = vi.spyOn(Authority, 'assertNativeAppRefundAccountInTx');
    for (const patch of [{ outTradeNo: 'other_order' }, { transactionId: undefined }, { transactionId: 'different_transaction' },
      { outRefundNo: 'CNSR999' }, { refundAmount: 499 }, { totalAmount: 1249 }, { reason: REASON.trim() }])
      await expect(check(c, c.manager, 'request', { ...c.request, ...patch })).rejects.toMatchObject({ code: 503 });
    await c.f.db.update(storeOrderRefund).set({ supplierId: 7 }).where(eq(storeOrderRefund.id, REFUND_ID));
    await expect(check(c)).rejects.toMatchObject({ code: 503 });
    await c.f.db.update(storeOrderRefund).set({ supplierId: 0, uid: 22 }).where(eq(storeOrderRefund.id, REFUND_ID));
    await expect(check(c)).rejects.toMatchObject({ code: 503 });
    expect(inTx).not.toHaveBeenCalled();
  }), 180000);

  it('preserves expired REQUESTING and PROCESSING UNKNOWN query recovery while rejecting stale POST and terminal provider states', async () => fixture(async c => {
    const before = await state(c);
    await expect(check(c)).resolves.toBeUndefined(); expect(await state(c)).toEqual(before);
    for (const providerStatus of ['REQUESTING','PROCESSING','UNKNOWN']) {
      await c.f.db.update(storeOrderRefundPayment).set({ providerStatus, requestTime: now() - 180, queryTime: now() }).where(eq(storeOrderRefundPayment.refundId, REFUND_ID));
      await expect(check(c, c.customer, 'query')).resolves.toBeUndefined();
      await expect(check(c, c.customer, 'request')).rejects.toMatchObject({ code: 503 });
    }
    for (const providerStatus of ['CREATED','SUCCESS','CLOSED','ABNORMAL','FAILED']) {
      await c.f.db.update(storeOrderRefundPayment).set({ providerStatus }).where(eq(storeOrderRefundPayment.refundId, REFUND_ID));
      await expect(check(c, c.manager, 'query')).rejects.toMatchObject({ code: 503 });
    }
    // Query-not-found recovery reclaims REQUESTING before its existing POST.
    await c.f.db.update(storeOrderRefundPayment).set({ providerStatus: 'REQUESTING', requestTime: now(), attemptCount: 2 }).where(eq(storeOrderRefundPayment.refundId, REFUND_ID));
    await expect(check(c)).resolves.toBeUndefined();
  }), 180000);

  it('keeps refundType6 provider recovery and an already split root as the same payment row compatible', async () => fixture(async c => {
    await c.f.db.update(storeOrderRefund).set({ refundType: 6 }).where(eq(storeOrderRefund.id, REFUND_ID));
    await c.f.db.update(storeOrder).set({ pid: -1 }).where(eq(storeOrder.id, ORDER_ID));
    await expect(check(c)).resolves.toBeUndefined();
  }), 180000);

  it('accepts a legitimate allocated supplier child while keeping the original parent total and trade identity', async () => fixture(async c => {
    await confirmed(c);
    await c.f.db.update(storeOrder).set({ pid: -1, supplierAllocationStatus: 2 }).where(eq(storeOrder.id, ORDER_ID));
    await c.f.db.insert(storeOrder).values({ id: ORDER_ID + 10, orderId: 'refund_provider_child', pid: ORDER_ID, uid: 11, unique: 'provider_child_884411',
      paid: 1, payType: 'weixin', payPrice: '5.00', totalPrice: '5.00', supplierId: 7, storeId: 9 });
    await c.f.db.update(storeOrderRefund).set({ storeOrderId: ORDER_ID + 10, supplierId: 7, storeId: 9 }).where(eq(storeOrderRefund.id, REFUND_ID));
    await c.f.db.update(storeOrderRefundPayment).set({ storeOrderId: ORDER_ID + 10 }).where(eq(storeOrderRefundPayment.refundId, REFUND_ID));
    await expect(check(c, c.customer)).resolves.toBeUndefined();
    await expect(check(c, c.customer, 'request', { ...c.request, totalAmount: 500 })).rejects.toMatchObject({ code: 503 });
    await c.f.db.update(storeOrder).set({ supplierAllocationStatus: 0 }).where(eq(storeOrder.id, ORDER_ID));
    await expect(check(c, c.customer)).rejects.toMatchObject({ code: 503 });
  }), 180000);

  it('rejects business value ABA by xmin after a real App-side check and detaches mutable request input', async () => fixture(async c => {
    const original = Authority.assertNativeAppRefundAccountInTx;
    vi.spyOn(Authority, 'assertNativeAppRefundAccountInTx').mockImplementation(async (tx, env, input) => {
      await original(tx, env, input);
      await c.f.db.update(storeOrderRefund).set({ refundReason: 'intermediate' }).where(eq(storeOrderRefund.id, REFUND_ID));
      await c.f.db.update(storeOrderRefund).set({ refundReason: REASON }).where(eq(storeOrderRefund.id, REFUND_ID));
    });
    await expect(check(c)).rejects.toMatchObject({ code: 503 });
    vi.mocked(Authority.assertNativeAppRefundAccountInTx).mockRestore();
    let read = false;
    const mutable = { ...c.request };
    const db = observed(c.manager.db, async (text, result) => {
      if (!read && text.includes('AS payment')) { read = true; mutable.totalAmount = 999; mutable.transactionId = 'replaced'; }
      return result;
    });
    await expect(assertNativeAppRefundProviderRequest(createContainerFromDb(db), c.env, mutable, 'request', M1)).resolves.toBeUndefined();
    expect(read).toBe(true); expect(mutable.totalAmount).toBe(999);
  }), 180000);

  it('uses account-before-order verification without holding a business row lock across connections', async () => fixture(async c => {
    const original = Authority.assertNativeAppRefundAccountInTx;
    vi.spyOn(Authority, 'assertNativeAppRefundAccountInTx').mockImplementation(async (tx, env, input) => {
      // This real update would block if the outer business snapshot held a row
      // lock while waiting for this connection. Roll it back; no fixture drift.
      const rollback = Error('Owned verifier row-lock probe rollback');
      await c.f.db.transaction(async t => {
        await t.execute(sql`SET LOCAL lock_timeout='200ms'`);
        await t.update(storeOrderRefund).set({ remark: 'owned lock probe' }).where(eq(storeOrderRefund.id, REFUND_ID));
        throw rollback;
      }).catch(error => { if (error !== rollback) throw error; });
      await original(tx, env, input);
    });
    const before = await state(c); await expect(check(c)).resolves.toBeUndefined(); expect(await state(c)).toEqual(before);
    vi.mocked(Authority.assertNativeAppRefundAccountInTx).mockRestore();
    await c.admin.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(731664,0)`);
      await expect(check(c)).rejects.toMatchObject({ code: 503 });
    });
    await expect(check(c)).resolves.toBeUndefined();
  }), 180000);

  it('rejects another real database even if a test host spoofs equal database-name and oid metadata', async () => fixture(async c => {
    const other = await refundRuntimeFixture();
    try {
      if (!other.withRuntimeRole) throw Error('Second actual native database required');
      await other.withRuntimeRole(async peer => {
        const [id] = await peer.exec('SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid');
        const env = { ...c.env, HYPERDRIVE: { connectionString: peer.connectionString } } as Env;
        await expect(check(c, c.manager, 'request', c.request, env)).rejects.toMatchObject({ code: 503 });
        let spoofed = 0;
        const db = observed(c.manager.db, async (text, result) => {
          if (text.includes('AS database_oid')) {
            spoofed++;
            return (result as Array<Record<string, unknown>>).map(row => ({ ...row, database: id.database, database_oid: id.database_oid }));
          }
          return result;
        });
        const guard = vi.spyOn(Authority, 'assertNativeAppRefundAccountInTx');
        await expect(assertNativeAppRefundProviderRequest(createContainerFromDb(db), env, c.request, 'request', M1)).rejects.toMatchObject({ code: 503 });
        expect(spoofed).toBe(1); expect(guard).not.toHaveBeenCalled();
        // This uses two real databases plus spoofed identity metadata, not two
        // actual clusters with equal names. The actual advisory lock differs.
      });
    } finally { await other.close(); }
  }), 240000);

  it('keeps strong original merchant domain and amount checks after the current AppID is cleared', async () => fixture(async c => {
    await confirmed(c);
    await c.f.db.insert(systemRole).values({ id: ADMIN_ID, roleName: 'Owned verifier author', rules: '1379,315' });
    await c.f.db.insert(systemAdmin).values({ id: ADMIN_ID, account: 'owned_verifier_author', pwd: 'owned-app-author', roles: String(ADMIN_ID), level: 1, adminType: 1 });
    await c.f.db.delete(systemMenus).where(inArray(systemMenus.id, [1379,315]));
    await c.f.db.insert(systemMenus).values([{ ...WECHAT_APP_VIEW_SEED, menuName: '移动应用' }, { ...WECHAT_APP_SAVE_SEED, menuName: '保存配置' }]);
    const author = new AdminWechatAppService(createContainerFromDb(c.admin.db), c.env);
    const actor = { id: ADMIN_ID, authVersion: md5('owned-app-author'), expiresAt: now() + 3600 };
    expect(await author.save({ request_id: randomUUID(), revision: (await author.read(actor)).revision, confirmed: true,
      fields: { wechat_app_appid: { action: 'replace', value: '' }, wechat_app_appsecret: { action: 'keep' } } }, actor)).toMatchObject({ state: 'committed' });
    await expect(check(c, c.manager)).resolves.toBeUndefined();
    await c.f.db.update(systemConfig).set({ value: JSON.stringify(M2) }).where(eq(systemConfig.id, MCH_ID));
    await expect(check(c, c.customer, 'request', c.request, c.env, M2)).rejects.toThrow('已确认原单');
    await c.f.db.update(systemConfig).set({ value: JSON.stringify(M1) }).where(eq(systemConfig.id, MCH_ID));
    await c.f.db.update(storeOrder).set({ payPrice: '12.51' }).where(eq(storeOrder.id, ORDER_ID));
    await c.f.db.update(storeOrderRefundPayment).set({ totalAmount: 1251 }).where(eq(storeOrderRefundPayment.refundId, REFUND_ID));
    await expect(check(c, c.customer, 'request', { ...c.request, totalAmount: 1251 })).rejects.toThrow('已确认原单');
  }), 180000);

  it('rejects a non-store strong original and immutable catalog drift with no business mutation', async () => fixture(async c => {
    await confirmed(c, 'membership'); const before = await state(c);
    await expect(check(c)).rejects.toThrow('订单域'); expect(await state(c)).toEqual(before);
    await c.f.exec('ALTER TABLE public.native_app_payment_evidence DROP CONSTRAINT nape_format_ck');
    await expect(check(c)).rejects.toMatchObject({ code: 503 });
  }), 180000);

  it('rejects an uncommitted caller transaction before opening any owned App connection', async () => fixture(async c => {
    const create = vi.spyOn(Di, 'createDbFromConnectionString');
    await c.manager.db.transaction(async tx => {
      await expect(assertNativeAppRefundProviderRequest(createContainerFromDb(tx as unknown as DbClient), c.env, c.request, 'request', M1))
        .rejects.toMatchObject({ code: 503 });
    });
    expect(create).not.toHaveBeenCalled();
  }), 180000);
});
