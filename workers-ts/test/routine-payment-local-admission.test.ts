import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { randomUUID, sign, verify } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { otherOrder, otherOrderStatus, paymentReconciliationAction, paymentReconciliationCase, storeOrder,
  storeOrderInvoice, storeOrderOutbox, storeOrderStatus, systemConfig, user, userBill, wechatUser } from '@/models/schema';
import { ROUTINE_IDENTITY_WITNESS_SQL } from '@/migrations/routineIdentityWitness';
import { ROUTINE_PAYMENT_ATTEMPT_SQL } from '@/migrations/routinePaymentAttempt';
import { StoreOrderPayService, applyStoreOrderBalancePayment, applyStoreOrderPayment,
  applyProviderStoreOrderPayment } from '@/services/order/StoreOrderPayService';
import { PaidMembershipService, applyMembershipPayment, applyProviderMembershipPayment } from '@/services/user/PaidMembershipService';
import { lockLocalPaymentAdmissionTx } from '@/services/payment/LocalPaymentAdmission';
import { registerPaymentReconciliationIntent, registerPaymentReconciliationTx } from '@/services/payment/PaymentReconciliationRegistry';
import { PaymentReconciliationService } from '@/services/payment/PaymentReconciliationService';
import { issueRoutineIdentityObservation } from '@/services/wechat/RoutineIdentityObservation';
import { appendRoutineIdentityWitness } from '@/services/wechat/RoutineIdentityWitness';
import { readRoutineCredentials } from '@/services/wechat/RoutineRuntimeConfig';
import { financePostgres, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

const APP = 'wxRoutineLocal09', PAYER = 'routine_local_payer', MCH = '1900000109';
const SERIAL = 'LOCAL_ADMISSION_PLATFORM_KEY';
const DOMAINS = ['store_order', 'membership'] as const;
type Domain = typeof DOMAINS[number];
const LOCAL = [
  { domain: 'store_order', method: 'balance' }, { domain: 'store_order', method: 'manual_offline' },
  { domain: 'membership', method: 'balance' },
] as const;
type Local = typeof LOCAL[number];
const ORDERS = { store_order: { id: 11, orderNo: 'local_admission_store', attach: 'product' },
  membership: { id: 13, orderNo: 'local_admission_member', attach: 'member' } } as const;
const CANCEL = new Set(['cfg_order_activity_time', 'cfg_order_bargain_time', 'cfg_order_cancel_time',
  'cfg_order_pink_time', 'cfg_order_seckill_time', 'cfg_rebate_points_orders_time']);
const HISTORY = ['initiated', 'provider-success', 'transaction', 'event-time', 'callback', 'attempt-count', 'query-time',
  'lease-until', 'lease-token', 'error', 'resolved', 'wrong-amount', 'wrong-domain', 'unknown', 'no-payment', 'closed', 'conflict'] as const;
const PROFILES = [{ provider: 'wechat', profile: 'wechat' }, { provider: 'wechat', profile: 'routine' },
  { provider: 'wechat', profile: 'app' }, { provider: 'alipay', profile: 'alipay' }] as const;

describe('ordinary local settlement versus Mini initiation on actual owned PG16', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env, keys: ReturnType<typeof paymentQueryKeys>;
  let depth = 0, network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const transactionContext = new AsyncLocalStorage<boolean>();
  const observe = (db: DbClient): DbClient => new Proxy(db, {
    get(target, key, receiver) {
      const method: unknown = Reflect.get(target, key, receiver);
      if (typeof method !== 'function') return method;
      if (key !== 'transaction') return method.bind(target);
      return (action: (tx: DbClient) => Promise<unknown>, ...options: unknown[]) => Reflect.apply(method, target,
        [async (tx: DbClient) => {
          depth++;
          try { return await transactionContext.run(true, () => action(observe(tx))); } finally { depth--; }
        }, ...options]);
    },
  });
  const container = (db: DbClient = f.db) => createContainerFromDb(observe(db));
  const mini = (domain: Domain, c: Container = container()) => domain === 'store_order'
    ? new StoreOrderPayService(c, env).pay(7, ORDERS[domain].orderNo, 'weixin', 'routine')
    : new PaidMembershipService(c, env).payOrder(7, { orderId: ORDERS[domain].orderNo, payType: 'weixin', from: 'routine' });
  const local = (request: Local, c: Container = container()) => request.domain === 'membership'
    ? applyMembershipPayment(c, { uid: 7, orderId: ORDERS.membership.orderNo, payType: 'yue', debitBalance: true })
    : request.method === 'manual_offline'
      ? applyStoreOrderPayment(c, { orderId: ORDERS.store_order.id, payType: 'offline',
        audit: { changeType: 'local_fixture_offline', changeMessage: 'Explicit owned local funds confirmation' } })
      : applyStoreOrderBalancePayment(c, { uid: 7, orderId: ORDERS.store_order.orderNo });
  const localBalance = (domain: Domain, c: Container = container()) => local(domain === 'store_order' ? LOCAL[0] : LOCAL[2], c);
  const cases = () => f.db.select().from(paymentReconciliationCase).orderBy(paymentReconciliationCase.id);
  const attempts = () => f.db.execute<{ order_no: string; event_kind: string; payload: Record<string, unknown>; signature: string }>(
    sql`SELECT order_no,event_kind,payload,signature FROM public.routine_payment_attempt ORDER BY order_no,event_kind`);
  const state = async () => ({
    users: await f.db.select().from(user).orderBy(user.uid), bindings: await f.db.select().from(wechatUser).orderBy(wechatUser.id),
    store: await f.db.select().from(storeOrder).orderBy(storeOrder.id), membership: await f.db.select().from(otherOrder).orderBy(otherOrder.id),
    invoices: await f.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id),
    bills: await f.db.select().from(userBill).orderBy(userBill.id), statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
    memberStatuses: await f.db.select().from(otherOrderStatus).orderBy(otherOrderStatus.oid, otherOrderStatus.changeType, otherOrderStatus.changeTime, otherOrderStatus.shopType, otherOrderStatus.changeMessage),
    outboxes: await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id),
    registry: await cases(), actions: await f.db.select().from(paymentReconciliationAction).orderBy(paymentReconciliationAction.id),
  });
  const assertRejectedUnchanged = async (work: () => Promise<unknown>) => {
    const before = await state(), recorded = await attempts();
    await expect(work()).rejects.toThrow(); expect(await state()).toEqual(before); expect(await attempts()).toEqual(recorded);
  };
  const register = (domain: Domain, rail: typeof PROFILES[number] = PROFILES[1], initiated = false) =>
    registerPaymentReconciliationIntent(container(), { ...rail, orderDomain: domain,
      orderNo: ORDERS[domain].orderNo, expectedAmountCents: 1250, initiated });
  const signedResponse = (body: unknown) => {
    const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'owned_local_response';
    return new Response(raw, { headers: { 'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': nonce,
      'Wechatpay-Serial': SERIAL, 'Wechatpay-Signature': Buffer.from(sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), keys.privateKey)).toString('base64') } });
  };
  // Only this disposable owned database is commissioned for these two tests.
  // This is not the complete production runtimeBusinessCommission profile.
  const withRestrictedLocal = async (work: (login: {
    db: DbClient; client: ReturnType<typeof postgres>; role: string;
  }) => Promise<void>) => {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    const [owned] = await f.db.execute<{ database: string; schema: string }>(sql`SELECT current_database() AS database,current_schema() AS schema`);
    if (owned.schema !== 'public' || !ownsFinanceFixtureTarget(owned.database, owned.schema, base.href)) throw Error('Unowned local-role fixture');
    const role = 'rpa_local_fixture_' + randomUUID().replaceAll('-', ''), password = randomUUID();
    if (!/^rpa_local_fixture_[a-f0-9]{32}$/u.test(role) || !/^finance_fixture_[a-f0-9]{32}$/u.test(owned.database)) throw Error('Unsafe local-role fixture name');
    let client: ReturnType<typeof postgres> | undefined, created = false;
    try {
      await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1 PASSWORD '${password}'`);
      created = true;
      await f.exec(`REVOKE TEMPORARY ON DATABASE "${owned.database}" FROM PUBLIC;
        GRANT CONNECT ON DATABASE "${owned.database}" TO "${role}";
        GRANT USAGE ON SCHEMA public TO "${role}";
        GRANT SELECT ON public.routine_payment_attempt,public.store_order,public."user",public.store_order_invoice,
          public.user_bill,public.store_order_outbox,public.payment_reconciliation_case,public.payment_reconciliation_action TO "${role}";
        GRANT UPDATE(paid,pay_type,pay_time) ON public.store_order TO "${role}";
        GRANT UPDATE(now_money,integral) ON public."user" TO "${role}";
        GRANT UPDATE(is_pay) ON public.store_order_invoice TO "${role}";
        GRANT UPDATE(id) ON public.payment_reconciliation_case TO "${role}";
        GRANT INSERT ON public.user_bill,public.store_order_outbox TO "${role}";
        GRANT USAGE ON SEQUENCE public.user_bill_id_seq,public.store_order_outbox_id_seq TO "${role}"`);
      const target = new URL(base.href); target.pathname = '/' + owned.database; target.username = role; target.password = password;
      client = postgres(target.href, { max: 1, prepare: false, connect_timeout: 5,
        connection: { options: '-c search_path=public -c statement_timeout=5000 -c lock_timeout=2000' } });
      const db = drizzle(client) as unknown as DbClient;
      const [login] = await db.execute(sql`SELECT current_user AS role,session_user AS session,current_database() AS database,
        current_setting('server_version_num')::integer/10000 AS major,
        rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls AS elevated,
        EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid) AS member,
        has_schema_privilege(current_user,'public','CREATE') AS ddl,
        has_database_privilege(current_user,current_database(),'CREATE,TEMPORARY') AS database_ddl
        FROM pg_catalog.pg_roles r WHERE rolname=current_user`);
      expect(login).toEqual({ role, session: role, database: owned.database, major: 16, elevated: false, member: false, ddl: false, database_ddl: false });
      const [acl] = await db.execute(sql`SELECT has_table_privilege(current_user,'public.routine_payment_attempt','SELECT') AS readable,
        has_table_privilege(current_user,'public.routine_payment_attempt','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writable,
        has_function_privilege(current_user,'public.routine_payment_attempt_immutable_v1()','EXECUTE') AS executable,
        EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)) AS owner`);
      expect(acl).toEqual({ readable: true, writable: false, executable: false, owner: false });
      for (const statement of ['UPDATE public.routine_payment_attempt SET signature=signature',
        'DELETE FROM public.routine_payment_attempt', 'TRUNCATE public.routine_payment_attempt',
        'INSERT INTO public.routine_payment_attempt SELECT * FROM public.routine_payment_attempt WHERE false',
        'CREATE TABLE public.local_role_should_not_own(id integer)', 'CREATE TEMPORARY TABLE local_role_no_temp(id integer)'])
        await expect(client.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
      await work({ db, client, role });
    } finally {
      try { await client?.end({ timeout: 1 }); }
      finally {
        if (created) {
          try { await f.exec(`DROP OWNED BY "${role}"`); }
          finally { await f.exec(`DROP ROLE "${role}"`); }
        }
      }
    }
  };
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Actual owned PG16 required for local payment admission');
    keys = paymentQueryKeys();
    f = await financePostgres([systemConfig, user, wechatUser, storeOrder, otherOrder, otherOrderStatus, userBill,
      storeOrderInvoice, storeOrderOutbox, storeOrderStatus, paymentReconciliationCase, paymentReconciliationAction], { namespace: 'public' });
    await f.exec('CREATE UNIQUE INDEX local_case_uq ON public.payment_reconciliation_case(provider,order_no)');
    await f.exec('CREATE UNIQUE INDEX local_store_uq ON public.store_order(order_id)');
    await f.exec('CREATE UNIQUE INDEX local_member_uq ON public.other_order(order_id)');
    await f.exec('CREATE UNIQUE INDEX local_outbox_uq ON public.store_order_outbox(event_key)');
  }, 30000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(async () => {
    depth = 0;
    await f.exec('DROP TABLE IF EXISTS public.routine_payment_attempt');
    await f.exec('DROP FUNCTION IF EXISTS public.routine_payment_attempt_immutable_v1()');
    await f.exec('DROP TABLE IF EXISTS public.routine_identity_witness');
    await f.exec('DROP FUNCTION IF EXISTS public.routine_identity_witness_immutable_v1()');
    await f.reset(); await f.exec(ROUTINE_IDENTITY_WITNESS_SQL); await f.exec(ROUTINE_PAYMENT_ATTEMPT_SQL);
    await f.db.insert(systemConfig).values(Object.entries({ routine_appId: APP, routine_appsecret: 'fixture-observation-secret',
      pay_weixin_mchid: MCH, pay_weixin_serial_no: 'ABCDEF123456', pay_weixin_open: '1', site_url: 'https://local.example' })
      .map(([menuName, value], index) => ({ id: index + 1, menuName, value: JSON.stringify(value), sort: 5 })));
    env = { APP_KEY: 'owned-local-observation-and-attempt-key', WECHAT_MCH_PRIVATE_KEY: keys.privateKey,
      WECHAT_PLATFORM_PUBLIC_KEY: keys.publicKey, WECHAT_PLATFORM_PUBLIC_KEY_ID: SERIAL, WECHAT_API_V3_KEY: 'c'.repeat(32),
      CONFIG_KV: {
        get: vi.fn(async (key: string) => { expect(transactionContext.getStore()).not.toBe(true);
          if (!CANCEL.has(key)) throw Error('No credential or payment public configuration from KV'); return '24'; }),
        put: vi.fn(async () => { throw Error('Unexpected KV publication'); }), delete: vi.fn(async () => { throw Error('Unexpected KV deletion'); }),
      },
    } as unknown as Env;
    await f.db.insert(user).values({ uid: 7, account: 'owned-local-user', status: 1, nowMoney: '88.00', integral: 21, isMoneyLevel: 0, isEverLevel: 0 });
    await f.db.insert(wechatUser).values({ id: 7, uid: 7, openid: PAYER, userType: 'routine' });
    const now = Math.floor(Date.now() / 1000);
    await f.db.insert(storeOrder).values({ id: 11, uid: 7, orderId: ORDERS.store_order.orderNo, unique: 'owned-local-store', payPrice: '12.50',
      payIntegral: 5, paid: 0, status: 0, type: 0, addTime: now });
    await f.db.insert(storeOrderInvoice).values({ id: 11, uid: 7, orderId: 11, isPay: 0 });
    await f.db.insert(otherOrder).values({ id: 13, uid: 7, orderId: ORDERS.membership.orderNo, type: 1, memberType: 'monthly', payPrice: '12.50',
      paid: 0, isFree: 0, isPermanent: 0, vipDay: 30, channelType: 'routine', addTime: now });
    const credentials = await readRoutineCredentials(container(), env);
    const observation = issueRoutineIdentityObservation(env, { appId: credentials.appId, openid: PAYER, sourceStamp: credentials.stamp });
    await withTx(container(), tx => appendRoutineIdentityWitness(tx, env, { uid: 7, observation }));
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'routine_appsecret'));
    network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(transactionContext.getStore()).not.toBe(true);
      expect(String(input)).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi'); expect(init?.method).toBe('POST');
      const raw = String(init?.body), body = JSON.parse(raw) as { out_trade_no: string };
      expect(body).toMatchObject({ appid: APP, mchid: MCH, amount: { total: 1250, currency: 'CNY' }, payer: { openid: PAYER } });
      expect(await attempts()).toEqual(expect.arrayContaining([expect.objectContaining({ order_no: body.out_trade_no, event_kind: 'INITIATION' })]));
      const authorization = new Headers(init?.headers).get('Authorization') ?? '';
      const fields = Object.fromEntries([...authorization.matchAll(/(\w+)="([^"]+)"/gu)].map(m => [m[1], m[2]]));
      expect(fields.mchid).toBe(MCH); expect(fields.serial_no).toBe('ABCDEF123456');
      expect(verify('RSA-SHA256', Buffer.from(`POST\n/v3/pay/transactions/jsapi\n${fields.timestamp}\n${fields.nonce_str}\n${raw}\n`),
        keys.publicKey, Buffer.from(fields.signature, 'base64'))).toBe(true);
      return signedResponse({ prepay_id: `prepay_${body.out_trade_no}` });
    });
  });
  afterEach(() => {
    try { expect(depth).toBe(0); expect(transactionContext.getStore()).not.toBe(true);
      if (env) { expect(env.CONFIG_KV.put).not.toHaveBeenCalled(); expect(env.CONFIG_KV.delete).not.toHaveBeenCalled(); } }
    finally { vi.restoreAllMocks(); }
  });

  it.each(LOCAL)('committed Mini INIT prevents $domain $method and preserves every local effect', async request => {
    await mini(request.domain); await assertRejectedUnchanged(() => local(request)); expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(LOCAL)('immutable Mini INIT still prevents $domain $method after mutable cases are deleted', async request => {
    await mini(request.domain); await f.db.delete(paymentReconciliationCase);
    await assertRejectedUnchanged(() => local(request)); expect(await cases()).toEqual([]); expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(LOCAL)('$domain $method first commits locally and then prevents Mini HTTP', async request => {
    expect(await local(request)).toMatchObject({ outcome: 'paid' }); const before = await state();
    const replay = await mini(request.domain);
    if (request.domain === 'store_order') expect(replay).toEqual({ order_id: ORDERS.store_order.orderNo, paid: true, pay_type: before.store[0].payType });
    else expect(replay).toEqual({ order_id: ORDERS.membership.orderNo, paid: true, overdue_time: before.membership[0].overdueTime });
    expect(replay).not.toHaveProperty('jsConfig'); expect(await state()).toEqual(before);
    expect(await attempts()).toEqual([]); expect(network).not.toHaveBeenCalled();
  });
  it.each(LOCAL)('$domain $method without external history commits its actual ledger and rights once', async request => {
    expect(await local(request)).toMatchObject({ outcome: 'paid' });
    const after = await state(), account = after.users[0];
    expect(account.nowMoney).toBe(request.method === 'balance' ? '75.50' : '88.00');
    if (request.domain === 'store_order') {
      expect(after.store[0]).toMatchObject({ paid: 1, payType: request.method === 'balance' ? 'yue' : 'offline' });
      expect(account.integral).toBe(16); expect(after.invoices[0].isPay).toBe(1);
      expect(after.outboxes).toMatchObject([{ eventKey: 'order.paid:11', status: 'PENDING' }]);
      expect(after.bills).toHaveLength(request.method === 'balance' ? 2 : 1);
    } else {
      expect(after.membership[0]).toMatchObject({ paid: 1, payType: 'yue' }); expect(account.isMoneyLevel).toBe(1);
      expect(account.overdueTime).toBeGreaterThan(Math.floor(Date.now() / 1000)); expect(after.bills).toHaveLength(1); expect(after.memberStatuses).toHaveLength(1);
    }
    expect(await local(request)).toMatchObject({ outcome: 'already-paid' }); expect(await state()).toEqual(after);
    expect(await attempts()).toEqual([]); expect(network).not.toHaveBeenCalled();
  });
  it('a separate restricted LOGIN completes local settlement with only required money/outbox grants and read-only Mini ledger', async () => {
    await withRestrictedLocal(async ({ db }) => {
      expect(await localBalance('store_order', container(db))).toMatchObject({ outcome: 'paid' });
      const current = await state(); expect(current.users[0]).toMatchObject({ nowMoney: '75.50', integral: 16 });
      expect(current.store[0]).toMatchObject({ paid: 1, payType: 'yue' }); expect(current.invoices[0].isPay).toBe(1);
      expect(current.bills).toHaveLength(2); expect(current.outboxes).toMatchObject([{ eventKey: 'order.paid:11', status: 'PENDING' }]);
      expect(await attempts()).toEqual([]); expect(network).not.toHaveBeenCalled();
    });
  });
  it('a restricted LOGIN with no money-write permission rejects actual Mini INIT at admission before any financial access', async () => {
    await mini('store_order');
    await withRestrictedLocal(async ({ db, role }) => {
      await f.exec(`REVOKE UPDATE(now_money,integral) ON public."user" FROM "${role}";
        REVOKE INSERT ON public.user_bill FROM "${role}"`);
      const [acl] = await db.execute(sql`SELECT has_column_privilege(current_user,'public.user','now_money','UPDATE') AS money,
        has_column_privilege(current_user,'public.user','integral','UPDATE') AS points,
        has_table_privilege(current_user,'public.user_bill','INSERT') AS bill`);
      expect(acl).toEqual({ money: false, points: false, bill: false });
      const before = await state(), immutable = await attempts();
      await expect(localBalance('store_order', container(db))).rejects.toThrow('外部支付已发起');
      expect(await state()).toEqual(before); expect(await attempts()).toEqual(immutable); expect(network).toHaveBeenCalledTimes(1);
    });
  });
  it.each(DOMAINS.flatMap(domain => (['weixin', 'alipay'] as const).map(payType => ({ domain, payType }))))(
    'a default local $domain call cannot masquerade as verified $payType settlement', async ({ domain, payType }) => {
      await mini(domain);
      await assertRejectedUnchanged(() => domain === 'store_order'
        ? applyStoreOrderPayment(container(), { orderId: 11, payType, tradeNo: 'claimed_verified_trade' })
        : applyMembershipPayment(container(), { orderId: ORDERS.membership.orderNo, payType, tradeNo: 'claimed_verified_trade', expectedAmountCents: 1250 }));
    });
  it.each(DOMAINS.flatMap(domain => (['weixin', 'alipay'] as const).map(payType => ({ domain, payType }))))(
    'even without history a local $domain string cannot select the verified $payType mode', async ({ domain, payType }) => {
      await assertRejectedUnchanged(() => domain === 'store_order'
        ? applyStoreOrderPayment(container(), { orderId: 11, payType, tradeNo: 'unverified_request_string' })
        : applyMembershipPayment(container(), { orderId: ORDERS.membership.orderNo, payType, tradeNo: 'unverified_request_string' }));
      expect(await cases()).toEqual([]); expect(network).not.toHaveBeenCalled();
    });
  it.each(DOMAINS)('the explicit internal provider wrapper can settle %s with its INIT still present', async domain => {
    await mini(domain); const saved = await attempts(); let authorized = false;
    const authorize = async (tx: DbClient) => {
      expect(transactionContext.getStore()).toBe(true);
      const rows = await tx.select().from(paymentReconciliationCase).where(eq(paymentReconciliationCase.orderNo, ORDERS[domain].orderNo)).for('update');
      expect(rows).toMatchObject([{ profile: 'routine', initiatedTime: expect.any(Number), expectedAmountCents: 1250 }]); authorized = true;
    };
    // Explicit trusted-internal API contract, not a claim that a synthetic
    // trade number or prepay response proves provider SUCCESS/original payer.
    const result = domain === 'store_order'
      ? await applyProviderStoreOrderPayment(container(), { orderId: 11, payType: 'weixin', tradeNo: 'explicit_internal_trade', authorizeBeforePayment: authorize })
      : await applyProviderMembershipPayment(container(), { orderId: ORDERS.membership.orderNo, payType: 'weixin', tradeNo: 'explicit_internal_trade',
        expectedAmountCents: 1250, authorizeBeforePayment: authorize });
    expect(result).toMatchObject({ outcome: 'paid' }); expect(authorized).toBe(true); expect(await attempts()).toEqual(saved);
    const current = await state(); expect(current.users[0].nowMoney).toBe('88.00');
    expect(domain === 'store_order' ? current.store[0].paid : current.membership[0].paid).toBe(1); expect(network).toHaveBeenCalledTimes(1);
  });

  it.each(HISTORY)('rejects retained %s history rather than interpreting it as a clean local order', async kind => {
    const row = await register('store_order');
    const updates: Partial<typeof paymentReconciliationCase.$inferInsert> = {};
    if (kind === 'initiated') updates.initiatedTime = Math.floor(Date.now() / 1000);
    if (kind === 'provider-success') updates.providerStatus = 'SUCCESS';
    if (kind === 'transaction') updates.providerTransactionId = 'observed_provider_transaction';
    if (kind === 'event-time') updates.providerEventTime = Math.floor(Date.now() / 1000);
    if (kind === 'callback') updates.callbackEventId = 99;
    if (kind === 'attempt-count') updates.attemptCount = 1;
    if (kind === 'query-time') updates.lastQueryTime = Math.floor(Date.now() / 1000);
    if (kind === 'lease-until') updates.leaseUntil = Math.floor(Date.now() / 1000) + 120;
    if (kind === 'lease-token') updates.leaseToken = crypto.randomUUID();
    if (kind === 'error') updates.lastErrorCode = 'queue_dispatch_failed';
    if (kind === 'resolved') updates.resolvedTime = Math.floor(Date.now() / 1000);
    if (kind === 'wrong-amount') updates.expectedAmountCents = 1251;
    if (kind === 'wrong-domain') updates.orderDomain = 'membership';
    if (kind === 'unknown') updates.status = 'UNKNOWN';
    if (kind === 'no-payment') updates.status = 'NO_PAYMENT';
    if (kind === 'closed') updates.status = 'CLOSED';
    if (kind === 'conflict') updates.status = 'CONFLICT';
    await f.db.update(paymentReconciliationCase).set(updates).where(eq(paymentReconciliationCase.id, row.id));
    await assertRejectedUnchanged(() => localBalance('store_order')); expect(network).not.toHaveBeenCalled();
  });
  it.each(DOMAINS.flatMap(domain => PROFILES.map(rail => ({ domain, ...rail }))))(
    '$domain permits an exactly pristine $provider/$profile case without turning it into initiation', async ({ domain, provider, profile }) => {
      const row = await registerPaymentReconciliationIntent(container(), { provider, profile, orderDomain: domain,
        orderNo: ORDERS[domain].orderNo, expectedAmountCents: 1250 });
      expect(row.initiatedTime).toBe(0); const before = await cases();
      expect(await localBalance(domain)).toMatchObject({ outcome: 'paid' }); expect(await cases()).toEqual(before);
      expect(await attempts()).toEqual([]); expect(network).not.toHaveBeenCalled();
    });
  it.each(DOMAINS)('a real UNKNOWN to RETRY action cannot authorize local %s settlement', async domain => {
    const row = await register(domain);
    await f.db.update(paymentReconciliationCase).set({ status: 'UNKNOWN', lastErrorCode: 'queue_dispatch_failed' }).where(eq(paymentReconciliationCase.id, row.id));
    await new PaymentReconciliationService(container(), env).decide({ caseId: row.id, adminId: 91, actionKey: crypto.randomUUID(), action: 'retry', reasonCode: 'retry_original_query' });
    expect(await cases()).toMatchObject([{ status: 'OPEN', initiatedTime: 0, attemptCount: 0, lastErrorCode: '' }]);
    expect(await f.db.select().from(paymentReconciliationAction)).toHaveLength(1);
    await assertRejectedUnchanged(() => localBalance(domain));
  });
  it.each(LOCAL)('missing immutable storage refuses new $domain $method mutation without touching effects', async request => {
    const before = await state(); await f.exec('ALTER TABLE public.routine_payment_attempt RENAME TO hidden_local_attempt');
    try { await expect(local(request)).rejects.toThrow(); expect(await state()).toEqual(before); }
    finally { await f.exec('ALTER TABLE public.hidden_local_attempt RENAME TO routine_payment_attempt'); }
    expect(network).not.toHaveBeenCalled();
  });
  it.each(DOMAINS)('missing storage does not erase already-paid local %s replay', async domain => {
    expect(await localBalance(domain)).toMatchObject({ outcome: 'paid' }); const before = await state();
    await f.exec('ALTER TABLE public.routine_payment_attempt RENAME TO hidden_local_attempt');
    try { expect(await localBalance(domain)).toMatchObject({ outcome: 'already-paid' }); expect(await state()).toEqual(before); }
    finally { await f.exec('ALTER TABLE public.hidden_local_attempt RENAME TO routine_payment_attempt'); }
  });
  it.each(DOMAINS)('missing order %s returns missing without requiring the new catalog', async domain => {
    if (domain === 'store_order') await f.db.delete(storeOrder).where(eq(storeOrder.id, 11));
    else await f.db.delete(otherOrder).where(eq(otherOrder.id, 13));
    const before = await state(); await f.exec('ALTER TABLE public.routine_payment_attempt RENAME TO hidden_local_attempt');
    try {
      const result = domain === 'store_order' ? await applyStoreOrderPayment(container(), { orderId: 11, payType: 'offline' })
        : await applyMembershipPayment(container(), { uid: 7, orderId: ORDERS.membership.orderNo, payType: 'yue' });
      expect(result).toMatchObject({ outcome: 'missing' }); expect(await state()).toEqual(before);
    } finally { await f.exec('ALTER TABLE public.hidden_local_attempt RENAME TO routine_payment_attempt'); }
  });

  it.each(DOMAINS)('a normal no-history zero %s order still settles without balance debit or provider access', async domain => {
    if (domain === 'store_order') await f.db.update(storeOrder).set({ payPrice: '0.00', payIntegral: 0 }).where(eq(storeOrder.id, 11));
    else await f.db.update(otherOrder).set({ type: 0, isFree: 1, payPrice: '0.00' }).where(eq(otherOrder.id, 13));
    const result = domain === 'store_order' ? await applyStoreOrderBalancePayment(container(), { uid: 7, orderId: ORDERS.store_order.orderNo })
      : await applyMembershipPayment(container(), { uid: 7, orderId: ORDERS.membership.orderNo, payType: 'yue', debitBalance: false });
    expect(result).toMatchObject({ outcome: 'paid' });
    const current = await state(); expect(current.users[0].nowMoney).toBe('88.00'); expect(current.bills).toEqual([]); expect(network).not.toHaveBeenCalled();
  });
  it.each(DOMAINS)('a retained Mini INIT is not excused by a later zero-price %s historical snapshot', async domain => {
    await mini(domain); await f.db.delete(paymentReconciliationCase);
    // Controlled owner SQL represents a historical inconsistent snapshot. No
    // claim that the ordinary admin repricing API permits this after INIT.
    if (domain === 'store_order') await f.db.update(storeOrder).set({ payPrice: '0.00', payIntegral: 0 }).where(eq(storeOrder.id, 11));
    else await f.db.update(otherOrder).set({ type: 0, isFree: 1, payPrice: '0.00' }).where(eq(otherOrder.id, 13));
    await assertRejectedUnchanged(() => domain === 'store_order'
      ? applyStoreOrderBalancePayment(container(), { uid: 7, orderId: ORDERS.store_order.orderNo })
      : applyMembershipPayment(container(), { uid: 7, orderId: ORDERS.membership.orderNo, payType: 'yue', debitBalance: false }));
    expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(DOMAINS)('an exclusive maintenance gate refuses %s before its order mutation', async domain => {
    const before = await state();
    await withFinancePeers(f.db, async ([holder, payer]) => {
      await holder.exec('BEGIN'); await holder.exec('SELECT pg_advisory_xact_lock(731670,0)');
      try { await expect(localBalance(domain, container(payer.db))).rejects.toThrow('维护'); }
      finally { await holder.exec('ROLLBACK'); }
    });
    expect(await state()).toEqual(before); expect(network).not.toHaveBeenCalled();
  });
  it.each(DOMAINS)('independent backend %s order lock makes local admission observe newly committed initiation', async domain => {
    // The holder commits real registry SQL while this exact order lock blocks
    // the independent payer. Actual signed Mini INIT/history is covered above;
    // a registry initiation is denial evidence, not provider success authority.
    const before = await state();
    await withFinancePeers(f.db, async ([holder, payer, monitor]) => {
      await holder.exec('BEGIN');
      await holder.exec(domain === 'store_order' ? 'SELECT id FROM public.store_order WHERE id=11 FOR UPDATE' : 'SELECT id FROM public.other_order WHERE id=13 FOR UPDATE');
      const waiting = outcome<unknown>(localBalance(domain, container(payer.db)));
      try {
        await waitForFinanceBlock(monitor.db, payer.pid, holder.pid);
        await registerPaymentReconciliationTx(holder.db, { provider: 'wechat', profile: 'routine', orderDomain: domain,
          orderNo: ORDERS[domain].orderNo, expectedAmountCents: 1250, initiated: true });
      } finally { await holder.exec('COMMIT'); }
      expect((await waiting).ok).toBe(false);
    });
    const after = await state(); expect(after.users).toEqual(before.users); expect(after.store).toEqual(before.store);
    expect(after.membership).toEqual(before.membership); expect(after.bills).toEqual([]); expect(after.outboxes).toEqual([]);
    expect(await cases()).toMatchObject([{ profile: 'routine', initiatedTime: expect.any(Number) }]); expect(network).not.toHaveBeenCalled();
  });
  it.each(DOMAINS)('concurrent local balance and Mini for %s complete only one financial rail', async domain => {
    const results = await Promise.all([outcome<unknown>(localBalance(domain)), outcome(mini(domain))]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    const after = await state();
    if (results[0].ok) {
      expect(after.users[0].nowMoney).toBe('75.50'); expect(await attempts()).toEqual([]); expect(network).not.toHaveBeenCalled();
    } else {
      expect(after.users[0].nowMoney).toBe('88.00'); expect(after.bills).toEqual([]); expect(after.outboxes).toEqual([]);
      expect(domain === 'store_order' ? after.store[0].paid : after.membership[0].paid).toBe(0);
      expect(await attempts()).toHaveLength(2); expect(network).toHaveBeenCalledTimes(1);
    }
  });
  it.each([false, true])('nested actual local payment preserves the outer gate/order transaction (Mini history=%s)', async history => {
    if (history) await mini('store_order');
    const before = await state(); let outerPid = 0, innerPid = 0;
    const work = () => withTx(container(), async tx => {
      await lockLocalPaymentAdmissionTx(tx);
      const [identity] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`); outerPid = identity.pid;
      await tx.select().from(storeOrder).where(eq(storeOrder.id, 11)).for('update');
      return applyStoreOrderPayment(createContainerFromDb(observe(tx)), { orderId: 11, payType: 'cash', authorizeBeforePayment: async inner => {
        const [identity] = await inner.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`); innerPid = identity.pid;
      } });
    });
    if (history) { await expect(work()).rejects.toThrow(); expect(await state()).toEqual(before); }
    else expect(await work()).toMatchObject({ outcome: 'paid' });
    expect(outerPid).toBeGreaterThan(0); expect(innerPid).toBe(outerPid);
  });

  it.each((['weixin', 'alipay'] as const).flatMap(payType => [false, true].map(history => ({ payType, history }))))(
    'zero store local settlement preserves $payType label while guarding immutable Mini history=$history', async ({ payType, history }) => {
      if (history) {
        await mini('store_order');
        expect(await attempts()).toHaveLength(2);
        await f.db.delete(paymentReconciliationCase);
      }
      // Owner-only SQL models a historical inconsistent snapshot after INIT;
      // this does not claim the ordinary repricing API permits that mutation.
      await f.db.update(storeOrder).set({ payPrice: '0.00', payIntegral: 0 }).where(eq(storeOrder.id, ORDERS.store_order.id));
      const pay = () => applyStoreOrderPayment(container(), { orderId: ORDERS.store_order.id, payType,
        audit: { changeType: 'local_zero_label', changeMessage: 'Owned zero-value local settlement retaining its original label' } });
      if (history) {
        await assertRejectedUnchanged(pay);
        expect(await cases()).toEqual([]); expect(await attempts()).toHaveLength(2);
        expect(network).toHaveBeenCalledTimes(1);
      } else {
        const before = await state();
        expect(await pay()).toMatchObject({ outcome: 'paid' });
        const after = await state();
        expect(after.store[0]).toMatchObject({ id: ORDERS.store_order.id, paid: 1, payType, payPrice: '0.00', tradeNo: '' });
        expect(after.users).toEqual(before.users); expect(after.bindings).toEqual(before.bindings);
        expect(after.membership).toEqual(before.membership); expect(after.memberStatuses).toEqual(before.memberStatuses);
        expect(after.bills).toEqual(before.bills); expect(after.invoices[0].isPay).toBe(1);
        expect(after.outboxes).toMatchObject([{ eventKey: 'order.paid:11', status: 'PENDING',
          eventType: 'order.paid', aggregateId: ORDERS.store_order.id,
          payload: { orderId: ORDERS.store_order.id, orderNo: ORDERS.store_order.orderNo } }]);
        expect(after.statuses).toMatchObject([{ oid: ORDERS.store_order.id, changeType: 'local_zero_label',
          changeMessage: 'Owned zero-value local settlement retaining its original label' }]);
        expect(after.registry).toEqual(before.registry); expect(after.actions).toEqual(before.actions);
        expect(await pay()).toMatchObject({ outcome: 'already-paid' }); expect(await state()).toEqual(after);
        expect(await attempts()).toEqual([]); expect(network).not.toHaveBeenCalled();
      }
    });

  it.each(DOMAINS)('a new local %s settlement cannot persist a caller-supplied provider tradeNo', async domain => {
    const pay = () => domain === 'store_order'
      ? applyStoreOrderPayment(container(), { orderId: ORDERS.store_order.id, payType: 'cash', tradeNo: 'unverified_local_trade' })
      : applyMembershipPayment(container(), { uid: 7, orderId: ORDERS.membership.orderNo, payType: 'yue', debitBalance: true,
        tradeNo: 'unverified_local_trade' });
    await assertRejectedUnchanged(pay);
    expect(await cases()).toEqual([]); expect(await attempts()).toEqual([]); expect(network).not.toHaveBeenCalled();
  });
});
