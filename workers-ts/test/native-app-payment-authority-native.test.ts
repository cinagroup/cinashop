import { randomUUID } from 'node:crypto';
import { eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { paymentReconciliationCase, systemAdmin, systemConfig, systemMenus, systemRole } from '@/models/schema';
import { ADMIN_WECHAT_APP_OPERATION_SQL } from '@/migrations/adminWechatAppOperation';
import { assertNativeAppPaymentAuthorityReady, inspectNativeAppPaymentAuthority } from '@/migrations/nativeAppPaymentAuthority';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { AdminWechatAppService } from '@/services/admin/AdminWechatAppService';
import { WECHAT_APP_VIEW_SEED, WECHAT_APP_SAVE_SEED } from '@/services/admin/AdminWechatAppPermissionBinding';
import { readNativeAppCredentials, withNativeAppCredentials } from '@/services/wechat/NativeAppRuntimeConfig';
import { readNativeAppPaymentAccount, recordNativeAppPaymentInitiation, recordNativeAppProviderEvidence,
  confirmNativeAppPaymentInitiation, assertNativeAppCallbackWitnessInTx, assertNativeAppQueryWitnessInTx } from '@/services/payment/NativeAppPaymentAuthority';
import { registerPaymentReconciliationIntent } from '@/services/payment/PaymentReconciliationRegistry';
import { lockStoreOrderPaymentBoundary } from '@/services/payment/StoreOrderPaymentBoundary';
import type { VerifiedPaymentCallback } from '@/services/payment/PaymentCallbackPersistence';
import type { PaymentProviderQueryRequest, PaymentProviderQueryResult } from '@/services/payment/PaymentProviderQuery';
import { md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import type { WechatAppSave } from '../../view/common/wechatApp';

type F = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<F['withRuntimeRole']>>[0] extends (peer: infer R) => unknown ? R : never;
type Names = { database: string; maintenance: string; app: string; admin: string; pricingOwner: string };
type Context = { f: F; app: Peer; admin: Peer; names: Names; env: Env; author: AdminWechatAppService };
type Initiation = Parameters<typeof recordNativeAppPaymentInitiation>[2];
type ProviderInput = Parameters<typeof recordNativeAppProviderEvidence>[2];
type CallbackInput = Extract<ProviderInput, { source: 'callback' }>;
const A = 'wxnativeA0000001', B = 'wxnativeB0000002', C = 'wxnativeC0000003';
const M1 = '1900000101', M2 = '1900000202', KEY = 'owned-native-payment-authority-key';
const APP_ROW = 881348, SECRET_ROW = 881349, MCH_ROW = 881350, ADMIN_ID = 881379;
const PASSWORD = 'owned-native-payment-admin-password';
const actor = { id: ADMIN_ID, authVersion: md5(PASSWORD), expiresAt: Math.floor(Date.now() / 1000) + 86400 };
const accountTable = 'public.native_app_payment_account', evidenceTable = 'public.native_app_payment_evidence';

/** Actual PG16 and separately authenticated restricted LOGINs only. Provider
 * facts below are explicit internal inputs: this suite does not run HTTP RSA/
 * AES verification, invoke WeChat, exercise an SDK or prove payment settlement. */
async function fixture(run: (ctx: Context) => Promise<void>, install = true) {
  const f = await refundRuntimeFixture();
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Internal payment primitive test forbids provider I/O'));
  try {
    if (f.format !== 'pg16' || !f.withRuntimeRole) throw Error('Independent PG16 runtime LOGINs required');
    await f.withRuntimeRole(app => f.withRuntimeRole!(async admin => {
      const [maintenance] = await f.exec('SELECT current_database() AS database,current_user AS maintenance');
      if (!f.pricingOwner) throw Error('Missing owned pricing capability owner');
      const names = { database: String(maintenance.database), maintenance: String(maintenance.maintenance),
        app: app.role, admin: admin.role, pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      for (const peer of [app, admin]) {
        const [identity] = await peer.exec(`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
          current_setting('server_version_num')::integer/10000 AS major,
          rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls AS elevated
          FROM pg_roles WHERE rolname=current_user`);
        expect(identity).toEqual({ role: peer.role, session: peer.role, pid: peer.pid, major: 16, elevated: false });
      }
      expect(app.pid).not.toBe(admin.pid); expect(app.role).not.toBe(admin.role);
      await f.db.insert(systemRole).values({ id: ADMIN_ID, roleName: 'Owned native payment author', rules: '1379,315' });
      await f.db.insert(systemAdmin).values({ id: ADMIN_ID, account: 'owned_native_payment_author', pwd: PASSWORD,
        roles: String(ADMIN_ID), level: 1, adminType: 1 });
      await f.db.delete(systemMenus).where(inArray(systemMenus.id, [1379, 315]));
      await f.db.insert(systemMenus).values([{ ...WECHAT_APP_VIEW_SEED, menuName: '移动应用' }, { ...WECHAT_APP_SAVE_SEED, menuName: '保存配置' }]);
      await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, ['wechat_app_appid', 'wechat_app_appsecret',
        'pay_weixin_mchid', 'wechat_open_app_id', 'wechat_open_app_secret', 'wechat_appid', 'routine_appId']));
      await f.db.insert(systemConfig).values([
        { id: APP_ROW, menuName: 'wechat_app_appid', value: JSON.stringify(A), sort: 5, status: 0, configTabId: 73 },
        { id: SECRET_ROW, menuName: 'wechat_app_appsecret', value: '"must-not-return-app-secret"', sort: 5, status: 0, configTabId: 73 },
        { id: MCH_ROW, menuName: 'pay_weixin_mchid', value: JSON.stringify(M1), sort: 5 },
        { id: 881351, menuName: 'wechat_open_app_id', value: '"must-not-return-open-id"' },
        { id: 881352, menuName: 'wechat_open_app_secret', value: '"must-not-return-open-secret"' },
        { id: 881353, menuName: 'wechat_appid', value: '"must-not-return-official-id"' },
        { id: 881354, menuName: 'routine_appId', value: '"must-not-return-routine-id"' },
      ]);
      const env = { APP_KEY: KEY, CONFIG_KV: { get: vi.fn(async () => { throw Error('No cached App account authority'); }),
        put: vi.fn(), delete: vi.fn(async () => {}) } } as unknown as Env;
      if (install) await runAdminWechatAppUpgrade(f.db, names);
      const author = new AdminWechatAppService(createContainerFromDb(admin.db), env);
      await run({ f, app, admin, names, env, author });
      expect(network).not.toHaveBeenCalled(); expect(env.CONFIG_KV.get).not.toHaveBeenCalled();
    }));
  } finally { await f.close(); }
}
const appContainer = (ctx: Context) => createContainerFromDb(ctx.app.db);
const current = (ctx: Context) => readNativeAppPaymentAccount(appContainer(ctx), ctx.env);
async function saveRequest(ctx: Context, next?: string): Promise<WechatAppSave> {
  return { request_id: randomUUID(), revision: (await ctx.author.read(actor)).revision, confirmed: true,
    fields: { wechat_app_appid: next === undefined ? { action: 'keep' } : { action: 'replace', value: next },
      wechat_app_appsecret: { action: 'keep' } } };
}
const rotate = async (ctx: Context, next: string) => ctx.author.save(await saveRequest(ctx, next), actor);
const accountRows = (ctx: Context) => ctx.app.exec(`SELECT * FROM ${accountTable} ORDER BY account_id`);
const evidenceRows = (ctx: Context) => ctx.app.exec(`SELECT * FROM ${evidenceTable} ORDER BY evidence_id`);
async function initiate(ctx: Context, orderNo: string, overrides: Partial<Initiation> = {}) {
  const pair = await current(ctx);
  const input: Initiation = { appId: pair.appId, merchantId: pair.merchantId, configStamp: pair.stamp,
    profile: 'app', orderNo, amountCents: 1250, orderDomain: 'store_order', currency: 'CNY', ...overrides };
  return { input, run: async () => recordNativeAppPaymentInitiation(appContainer(ctx), ctx.env, input) };
}
async function confirm(ctx: Context, input: Initiation,
  overrides: Partial<Parameters<typeof confirmNativeAppPaymentInitiation>[3]> = {}) {
  // Explicit internal already-verified POST/query scope, not an HTTP signature
  // test. Pre-request init alone must never establish this stronger evidence.
  return confirmNativeAppPaymentInitiation(appContainer(ctx), ctx.env, input, { appId: input.appId,
    merchantId: input.merchantId, orderNo: input.orderNo, amountCents: input.amountCents, currency: 'CNY',
    tradeType: 'APP', prepayId: 'owned_prepay_' + input.orderNo, ...overrides });
}
async function register(ctx: Context, orderNo: string, overrides: Partial<Parameters<typeof registerPaymentReconciliationIntent>[1]> = {}) {
  return registerPaymentReconciliationIntent(appContainer(ctx), { provider: 'wechat', profile: 'app', orderDomain: 'store_order',
    orderNo, expectedAmountCents: 1250, initiated: true, ...overrides });
}
function callbackFacts(orderNo: string, overrides: Partial<CallbackInput> = {}): CallbackInput {
  return { source: 'callback', providerEventId: 'event_' + orderNo, appId: A, merchantId: M1, orderNo, amountCents: 1250,
    currency: 'CNY', transactionId: 'txn_' + orderNo, tradeState: 'SUCCESS', providerEventTime: 1700000000,
    tradeType: 'APP', ...overrides };
}
function callback(input: CallbackInput): VerifiedPaymentCallback {
  return { provider: 'wechat', profile: 'app', providerEventId: input.providerEventId, orderNo: input.orderNo,
    transactionId: input.transactionId, tradeState: input.tradeState, amountCents: input.amountCents,
    currency: input.currency, providerEventTime: input.providerEventTime };
}
function query(input: CallbackInput, id: string) {
  const request: PaymentProviderQueryRequest = { provider: 'wechat', profile: 'app', orderDomain: 'store_order',
    orderNo: input.orderNo, expectedAmountCents: input.amountCents, currency: 'CNY' };
  const result: PaymentProviderQueryResult = { status: 'SUCCESS', providerTradeState: 'SUCCESS', orderNo: input.orderNo,
    transactionId: input.transactionId, amountCents: input.amountCents, currency: 'CNY',
    providerEventTime: input.providerEventTime, errorCode: '', nativeAppEvidenceId: id };
  return { request, result };
}
function withOrder<T>(ctx: Context, orderNo: string, run: (tx: DbClient) => Promise<T>) {
  return withTx(appContainer(ctx), async tx => { await lockStoreOrderPaymentBoundary(tx, orderNo); return run(tx); });
}
const checkCallback = (ctx: Context, value: VerifiedPaymentCallback) => withOrder(ctx, value.orderNo,
  tx => assertNativeAppCallbackWitnessInTx(tx, ctx.env, value));
const checkQuery = (ctx: Context, request: PaymentProviderQueryRequest, result: PaymentProviderQueryResult) => withOrder(ctx, request.orderNo,
  tx => assertNativeAppQueryWitnessInTx(tx, ctx.env, request, result));
async function catalog(ctx: Context) {
  return ctx.f.exec(`SELECT jsonb_build_object(
    'classes',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_class c WHERE c.relnamespace='public'::regnamespace
      AND (starts_with(c.relname,'native_app_payment_') OR starts_with(c.relname,'napa_') OR starts_with(c.relname,'nape_') OR c.relname='admin_wechat_app_operation')),
    'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND (starts_with(p.proname,'native_app_payment_') OR p.proname='admin_wechat_app_operation_immutable_v1')),
    'constraints',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_constraint c WHERE c.connamespace='public'::regnamespace
      AND (starts_with(c.conname,'napa_') OR starts_with(c.conname,'nape_') OR starts_with(c.conname,'awao_')))) AS snapshot`);
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Native App payment authority internal primitives on real restricted PG16 LOGINs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('installs one exact optional bundle and checks actual App/Admin table and function privileges', async () => fixture(async ctx => {
    expect(await inspectNativeAppPaymentAuthority(ctx.f.db, ctx.names)).toBe(true);
    expect(await runAdminWechatAppUpgrade(ctx.f.db, ctx.names)).toMatchObject({ applied: false });
    const expected = {
      app: { native_app_payment_account: [true, false], native_app_payment_evidence: [true, true] },
      admin: { native_app_payment_account: [true, true], native_app_payment_evidence: [false, false] },
    } as const;
    for (const [peer, kind] of [[ctx.app, 'app'], [ctx.admin, 'admin']] as const) {
      expect(await auditRuntimeBusinessPrivileges(peer.db, kind, ctx.names)).toMatchObject({ ready: true, failures: [] });
      await withTx(createContainerFromDb(peer.db), tx => assertNativeAppPaymentAuthorityReady(tx, kind));
      await expect(withTx(createContainerFromDb(peer.db), tx => assertNativeAppPaymentAuthorityReady(tx, kind === 'app' ? 'admin' : 'app'))).rejects.toMatchObject({ code: 503 });
      for (const name of ['native_app_payment_account', 'native_app_payment_evidence'] as const) {
        const [rights] = await peer.exec(`SELECT has_table_privilege(current_user,'public.${name}','SELECT') AS s,
          has_table_privilege(current_user,'public.${name}','INSERT') AS i,
          has_table_privilege(current_user,'public.${name}','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS extras,
          has_function_privilege(current_user,'public.${name}_immutable_v1()','EXECUTE') AS execute`);
        expect(rights).toEqual({ s: expected[kind][name][0], i: expected[kind][name][1], extras: false, execute: false });
        for (const statement of [`UPDATE public.${name} SET signature=signature`, `DELETE FROM public.${name}`, `TRUNCATE public.${name}`])
          await expect(peer.exec(statement)).rejects.toMatchObject({ code: '42501' });
      }
    }
    await expect(ctx.app.exec(`INSERT INTO ${accountTable} DEFAULT VALUES`)).rejects.toMatchObject({ code: '42501' });
    await expect(ctx.admin.exec(`SELECT * FROM ${evidenceTable}`)).rejects.toMatchObject({ code: '42501' });
    await expect(ctx.admin.exec(`INSERT INTO ${evidenceTable} DEFAULT VALUES`)).rejects.toMatchObject({ code: '42501' });
    await expect(assertNativeAppPaymentAuthorityReady(ctx.f.db, 'app')).rejects.toMatchObject({ code: 503 });
    await expect(withTx(createContainerFromDb(ctx.f.db), tx => assertNativeAppPaymentAuthorityReady(tx, 'app')))
      .rejects.toMatchObject({ code: 503 });
    await ctx.f.db.delete(systemConfig).where(eq(systemConfig.id, SECRET_ROW));
    expect(await current(ctx)).toMatchObject({ appId: A, merchantId: M1 });
  }), 180000);

  it('commits the credential fence on the real SELECT-only App LOGIN and keeps every config row and xmin unchanged', async () => fixture(async ctx => {
    const [login] = await ctx.app.exec(`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
      has_table_privilege(current_user,'public.system_config','UPDATE') AS table_update,
      has_any_column_privilege(current_user,'public.system_config','UPDATE') AS any_column_update,
      (SELECT bool_and(NOT has_column_privilege(current_user,a.attrelid,a.attnum,'UPDATE'))
       FROM pg_attribute a WHERE a.attrelid='public.system_config'::regclass AND a.attnum>0 AND NOT a.attisdropped) AS all_columns_readonly`);
    expect(login).toEqual({ role: ctx.app.role, session: ctx.app.role, pid: ctx.app.pid,
      table_update: false, any_column_update: false, all_columns_readonly: true });
    const configs = () => ctx.app.db.select({ ...getTableColumns(systemConfig), version: sql<string>`xmin::text` })
      .from(systemConfig).orderBy(systemConfig.id);
    const before = await configs(), credentials = await readNativeAppCredentials(appContainer(ctx), ctx.env);
    expect(credentials).toMatchObject({ appId: A, secret: 'must-not-return-app-secret' });
    const result = await withNativeAppCredentials(appContainer(ctx), ctx.env, credentials.stamp, async (bound, pair) => {
      expect(pair).toEqual(credentials);
      const identity = (tx: DbClient) => tx.execute<{ role: string; session: string; pid: number; xid: string }>(sql`
        SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,txid_current()::text AS xid`);
      const [outer] = await identity(bound.db);
      expect(outer).toEqual({ role: ctx.app.role, session: ctx.app.role, pid: ctx.app.pid, xid: expect.stringMatching(/^\d+$/u) });
      await withTx(bound, async tx => { expect((await identity(tx))[0]).toEqual(outer); });
      // A real denied write runs inside a SAVEPOINT. No permission is added,
      // and the outer credential transaction must still be usable afterwards.
      await expect(withTx(bound, tx => tx.update(systemConfig).set({ info: sql`${systemConfig.info}` })
        .where(eq(systemConfig.id, APP_ROW)))).rejects.toMatchObject({ cause: { code: '42501' } });
      expect((await identity(bound.db))[0]).toEqual(outer);
      return 'restricted-app-credential-commit';
    });
    expect(result).toBe('restricted-app-credential-commit');
    expect(await configs()).toEqual(before);
    expect(await accountRows(ctx)).toEqual([]); expect(await evidenceRows(ctx)).toEqual([]);
  }), 180000);

  it('refuses an operation-only partial bundle without completing or changing any existing owned catalog', async () => fixture(async ctx => {
    await ctx.f.db.execute(sql.raw(ADMIN_WECHAT_APP_OPERATION_SQL));
    const before = await catalog(ctx);
    expect(await inspectNativeAppPaymentAuthority(ctx.f.db, ctx.names)).toBe(false);
    await expect(runAdminWechatAppUpgrade(ctx.f.db, ctx.names)).rejects.toThrow('Partial');
    expect(await catalog(ctx)).toEqual(before);
    expect((await ctx.f.exec(`SELECT to_regclass('${accountTable}') AS account,to_regclass('${evidenceTable}') AS evidence`))[0])
      .toEqual({ account: null, evidence: null });
  }, false), 180000);

  it('rejects constraint and ACL drift without installer repair', async () => fixture(async ctx => {
    await ctx.f.exec('ALTER TABLE public.native_app_payment_account DROP CONSTRAINT napa_mch_id_ck');
    const drifted = await catalog(ctx);
    expect(await inspectNativeAppPaymentAuthority(ctx.f.db, ctx.names)).toBe(false);
    await expect(runAdminWechatAppUpgrade(ctx.f.db, ctx.names)).rejects.toBeDefined();
    expect(await catalog(ctx)).toEqual(drifted);
    await ctx.f.exec("ALTER TABLE public.native_app_payment_account ADD CONSTRAINT napa_mch_id_ck CHECK(mch_id='' OR mch_id ~ '^[0-9]{1,32}$')");
    expect(await inspectNativeAppPaymentAuthority(ctx.f.db, ctx.names)).toBe(true);
    await ctx.f.exec(`GRANT UPDATE ON ${accountTable} TO "${ctx.app.role}"`);
    expect(await inspectNativeAppPaymentAuthority(ctx.f.db, ctx.names)).toBe(false);
    await expect(current(ctx)).rejects.toMatchObject({ code: 503 });
    await expect(runAdminWechatAppUpgrade(ctx.f.db, ctx.names)).rejects.toBeDefined();
    expect((await ctx.app.exec(`SELECT has_table_privilege(current_user,'${accountTable}','UPDATE') AS drift_retained`))[0])
      .toEqual({ drift_retained: true });
    await ctx.f.exec(`REVOKE UPDATE ON ${accountTable} FROM "${ctx.app.role}"`);
    expect(await inspectNativeAppPaymentAuthority(ctx.f.db, ctx.names)).toBe(true);
    await ctx.f.exec('GRANT EXECUTE ON FUNCTION public.native_app_payment_account_immutable_v1() TO PUBLIC');
    expect(await inspectNativeAppPaymentAuthority(ctx.f.db, ctx.names)).toBe(false);
    await expect(current(ctx)).rejects.toMatchObject({ code: 503 });
    await expect(runAdminWechatAppUpgrade(ctx.f.db, ctx.names)).rejects.toBeDefined();
    expect((await ctx.app.exec("SELECT has_function_privilege(current_user,'public.native_app_payment_account_immutable_v1()','EXECUTE') AS drift_retained"))[0])
      .toEqual({ drift_retained: true });
  }), 180000);

  it('A-to-B and clear keep both encoded public accounts and leave all stored evidence immutable', async () => fixture(async ctx => {
    const originalConfigs = await ctx.f.db.select().from(systemConfig);
    expect(await rotate(ctx, B)).toMatchObject({ state: 'committed' });
    const retained = await accountRows(ctx);
    expect(retained.map(row => [JSON.parse(String(row.app_id)), row.mch_id]).sort()).toEqual([[A, M1], [B, M1]].sort());
    expect(await rotate(ctx, '')).toMatchObject({ state: 'committed' });
    expect(await accountRows(ctx)).toEqual(retained);
    expect(await current(ctx)).toMatchObject({ appId: '', merchantId: M1 });
    const facts = callbackFacts('legacy_after_clear');
    await recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, facts);
    await checkCallback(ctx, callback(facts));
    const witnesses = await evidenceRows(ctx);
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0].payload).toMatchObject({ admission: 'provider_verified_legacy', appId: A, merchantId: M1 });
    expect(witnesses[0].payload).not.toHaveProperty('configStamp');
    for (const table of [accountTable, evidenceTable]) for (const statement of [
      `UPDATE ${table} SET signature=signature`, `DELETE FROM ${table}`, `TRUNCATE ${table}`])
      await expect(ctx.f.exec(statement)).rejects.toMatchObject({ code: '42501' });
    expect(await accountRows(ctx)).toEqual(retained); expect(await evidenceRows(ctx)).toEqual(witnesses);
    const after = await ctx.f.db.select().from(systemConfig);
    for (const row of originalConfigs.filter(row => row.id !== APP_ROW)) expect(after.find(item => item.id === row.id)).toEqual(row);
    expect(JSON.stringify({ retained, witnesses, public: await current(ctx), snapshot: await ctx.author.read(actor) }))
      .not.toMatch(/must-not-return-(?:app-secret|open-id|open-secret|official-id|routine-id)/u);
  }), 180000);

  it('keeps encoded NUL in the author history but refuses it at internal payment provider/initiation boundaries', async () => fixture(async ctx => {
    const nul = 'native\0App';
    expect(await rotate(ctx, nul)).toMatchObject({ state: 'committed' });
    const history = await accountRows(ctx), row = history.find(item => JSON.parse(String(item.app_id)) === nul);
    expect(row).toBeDefined(); expect(row!.app_id).toBe(JSON.stringify(nul));
    expect(String(row!.app_id)).not.toContain('\0');
    expect((await ctx.author.read(actor)).settings.wechat_app_appid).toBe(nul);
    await register(ctx, 'nul_initiation');
    const intent = await initiate(ctx, 'nul_initiation');
    await expect(intent.run()).rejects.toMatchObject({ code: 400 });
    await expect(recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, callbackFacts('nul_provider', { appId: nul })))
      .rejects.toMatchObject({ code: 400 });
    expect(await evidenceRows(ctx)).toEqual([]);
  }), 180000);

  it('requires a matching initiated App registry case before recording a pre-request attempt without claiming an original', async () => fixture(async ctx => {
    const variants = [
      { name: 'missing', change: 'missing' }, { name: 'wrong_profile', change: 'profile' },
      { name: 'wrong_amount', change: 'amount' }, { name: 'wrong_domain', change: 'domain' },
      { name: 'not_initiated', change: 'initiated' }, { name: 'conflicted', change: 'conflict' },
    ];
    for (const item of variants) {
      const orderNo = 'authority_' + item.name;
      if (item.change !== 'missing') await register(ctx, orderNo, item.change === 'profile' ? { profile: 'wechat' }
        : item.change === 'amount' ? { expectedAmountCents: 1251 } : item.change === 'domain' ? { orderDomain: 'recharge' }
          : item.change === 'initiated' ? { initiated: false } : {});
      if (item.change === 'conflict') await register(ctx, orderNo, { profile: 'routine' });
      const input = await initiate(ctx, orderNo); await expect(input.run()).rejects.toMatchObject({ code: 400 });
    }
    expect(await evidenceRows(ctx)).toEqual([]);
    await register(ctx, 'authority_valid'); const valid = await initiate(ctx, 'authority_valid');
    expect(await valid.run()).toEqual(valid.input);
    const attempts = await evidenceRows(ctx); expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ evidence_id: expect.stringMatching(/^init:authority_valid:[a-f0-9]{64}$/u), kind: 'initiation', payload: valid.input });
    expect(attempts.some(row => String(row.evidence_id).startsWith('original:'))).toBe(false);
    await ctx.f.db.update(systemConfig).set({ info: 'fresh public source metadata' }).where(eq(systemConfig.id, APP_ROW));
    const fresh = await initiate(ctx, 'authority_valid'); expect(fresh.input.configStamp).not.toBe(valid.input.configStamp);
    expect(await fresh.run()).toEqual(valid.input); expect(await evidenceRows(ctx)).toEqual(attempts);
  }), 180000);

  it('retains separate unconfirmed A and B attempts but refuses A once B becomes the provider-confirmed original', async () => fixture(async ctx => {
    const orderNo = 'rotated_attempt_retry';
    await register(ctx, orderNo);
    const first = await initiate(ctx, orderNo), pendingA = await first.run();
    const onlyA = await evidenceRows(ctx); expect(onlyA).toHaveLength(1);
    expect(onlyA[0]).toMatchObject({ evidence_id: expect.stringMatching(/^init:rotated_attempt_retry:[a-f0-9]{64}$/u),
      kind: 'initiation', payload: pendingA });
    expect(await rotate(ctx, B)).toMatchObject({ state: 'committed' });
    const second = await initiate(ctx, orderNo), pendingB = await second.run();
    const attempts = await evidenceRows(ctx); expect(attempts).toHaveLength(2);
    expect(attempts.find(row => row.evidence_id === onlyA[0].evidence_id)).toEqual(onlyA[0]);
    expect(new Set(attempts.map(row => row.evidence_id)).size).toBe(2);
    expect(attempts.every(row => /^init:rotated_attempt_retry:[a-f0-9]{64}$/u.test(String(row.evidence_id)))).toBe(true);
    expect(attempts.map(row => row.payload)).toEqual(expect.arrayContaining([pendingA, pendingB]));
    expect(attempts.some(row => String(row.evidence_id).startsWith('original:'))).toBe(false);
    await confirm(ctx, pendingB);
    const confirmed = await evidenceRows(ctx); expect(confirmed).toHaveLength(3);
    expect(confirmed.find(row => row.evidence_id === 'original:' + orderNo)!.payload).toMatchObject({
      appId: B, merchantId: M1, profile: 'app', orderNo, amountCents: 1250, orderDomain: 'store_order', currency: 'CNY',
      confirmation_source: 'wechat-signed-query-after-prepay' });
    for (const prior of attempts) expect(confirmed.find(row => row.evidence_id === prior.evidence_id)).toEqual(prior);
    // Return the current config to A so this fails on the confirmed original,
    // rather than merely rejecting a stale source stamp/current account.
    expect(await rotate(ctx, A)).toMatchObject({ state: 'committed' });
    const retryA = await initiate(ctx, orderNo);
    expect(retryA.input.appId).toBe(A);
    await expect(retryA.run()).rejects.toThrow('订单已确认其他原生App原交易身份');
    await expect(confirm(ctx, pendingA)).rejects.toThrow('原生App原单身份发生冲突');
    expect(await evidenceRows(ctx)).toEqual(confirmed);
  }), 180000);

  it('uses provider-confirmed immutable original pairs despite later account history and preserves rejection evidence', async () => fixture(async ctx => {
    await register(ctx, 'original_A'); const first = await initiate(ctx, 'original_A'), pendingA = await first.run();
    await rotate(ctx, B);
    // A's provider response may arrive after the author has already selected B.
    await confirm(ctx, pendingA);
    await register(ctx, 'original_B'); const second = await initiate(ctx, 'original_B'); await confirm(ctx, await second.run());
    const originals = (await evidenceRows(ctx)).filter(row => String(row.evidence_id).startsWith('original:'));
    expect(originals).toHaveLength(2);
    for (const row of originals) {
      expect(row.payload).toMatchObject({ confirmation_source: 'wechat-signed-query-after-prepay', prepayIdHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(row.payload).not.toHaveProperty('prepayId');
    }
    await expect(recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, callbackFacts('original_B'))).rejects.toMatchObject({ code: 400 });
    await expect(recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, callbackFacts('original_A', { appId: B }))).rejects.toMatchObject({ code: 400 });
    const rejected = await evidenceRows(ctx);
    expect(rejected.filter(row => row.kind === 'callback')).toHaveLength(2);
    expect(rejected.filter(row => row.kind === 'callback').every(row => row.payload.admission === 'original_mismatch')).toBe(true);
    await expect(checkCallback(ctx, callback(callbackFacts('original_B')))).rejects.toBeDefined();
    const accepted = callbackFacts('original_A', { providerEventId: 'correct_original_A' });
    const id = await recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, accepted);
    expect(id).toBe('callback:correct_original_A'); await checkCallback(ctx, callback(accepted));
    const beforeReplay = await evidenceRows(ctx);
    await rotate(ctx, '');
    expect(await recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, accepted)).toBe(id);
    await checkCallback(ctx, callback(accepted));
    expect(await evidenceRows(ctx)).toEqual(beforeReplay);
    await expect(recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, { ...accepted, amountCents: 1251 })).rejects.toBeDefined();
    expect(await evidenceRows(ctx)).toEqual(beforeReplay);
  }), 180000);

  it('does not turn a B-era retry attempt into guessed original identity for a legacy A payment', async () => fixture(async ctx => {
    await rotate(ctx, B); await register(ctx, 'legacy_A_retry_B');
    const retry = await initiate(ctx, 'legacy_A_retry_B'), selection = await retry.run();
    // The verified provider says this existing order belongs to A, whereas
    // the newly attempted request selected B. No original may be invented.
    await expect(confirm(ctx, selection, { appId: A })).rejects.toMatchObject({ code: 400 });
    for (const delta of [{ merchantId: M2 }, { orderNo: 'another_order' }, { amountCents: 1251 },
      { currency: 'USD' }, { tradeType: 'JSAPI' }, { prepayId: '' }])
      await expect(confirm(ctx, selection, delta as unknown as Partial<Parameters<typeof confirmNativeAppPaymentInitiation>[3]>))
        .rejects.toMatchObject({ code: 400 });
    expect((await evidenceRows(ctx)).filter(row => String(row.evidence_id).startsWith('original:'))).toEqual([]);
    const facts = callbackFacts('legacy_A_retry_B');
    await recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, facts); await checkCallback(ctx, callback(facts));
    const rows = await evidenceRows(ctx), event = rows.find(row => row.kind === 'callback');
    expect(event!.payload).toMatchObject({ appId: A, admission: 'provider_verified_legacy' });
    expect(event!.payload).not.toHaveProperty('configStamp');
    const attempts = rows.filter(row => /^init:legacy_A_retry_B:[a-f0-9]{64}$/u.test(String(row.evidence_id)));
    expect(attempts).toHaveLength(1); expect(attempts[0].payload).toMatchObject({ appId: B });
    expect(rows.some(row => String(row.evidence_id).startsWith('original:'))).toBe(false);
  }), 180000);

  it('does not recombine historical AppID and merchant strings or treat an empty merchant as a wildcard', async () => fixture(async ctx => {
    await ctx.f.db.update(systemConfig).set({ value: '""' }).where(eq(systemConfig.id, MCH_ROW));
    await rotate(ctx, B);
    expect((await accountRows(ctx)).map(row => row.mch_id)).toEqual(['', '']);
    await ctx.f.db.update(systemConfig).set({ value: JSON.stringify(M1) }).where(eq(systemConfig.id, MCH_ROW));
    await expect(recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, callbackFacts('unbound_A'))).rejects.toMatchObject({ code: 400 });
    await rotate(ctx, C); // B/M1 and C/M1 are real new source tuples, not a backfill of A/''.
    await ctx.f.db.update(systemConfig).set({ value: JSON.stringify(M2) }).where(eq(systemConfig.id, MCH_ROW));
    await rotate(ctx, B); // Explicit owned maintenance variation, not a claim that merchant credential rotation works.
    const tuples = (await accountRows(ctx)).map(row => [JSON.parse(String(row.app_id)), row.mch_id]);
    expect(tuples).toEqual(expect.arrayContaining([[A, ''], [B, ''], [B, M1], [C, M1], [B, M2], [C, M2]]));
    await expect(recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, callbackFacts('recombined_A_M2', { merchantId: M2 })))
      .rejects.toMatchObject({ code: 400 });
    expect(await recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, callbackFacts('authorized_C_M2', { appId: C, merchantId: M2 })))
      .toBe('callback:event_authorized_C_M2');
  }), 180000);

  it('rejects wrong APP trade types and callback profile, currency, amount, transaction and registered domain conflicts', async () => fixture(async ctx => {
    const facts = callbackFacts('callback_scope'); await register(ctx, facts.orderNo);
    await confirm(ctx, await (await initiate(ctx, facts.orderNo)).run());
    for (const tradeType of ['JSAPI', 'NATIVE', 'MWEB', '']) await expect(recordNativeAppProviderEvidence(appContainer(ctx), ctx.env,
      { ...facts, tradeType } as unknown as CallbackInput)).rejects.toMatchObject({ code: 400 });
    expect(await evidenceRows(ctx)).toHaveLength(2);
    await recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, facts); await checkCallback(ctx, callback(facts));
    const valid = callback(facts);
    for (const delta of [{ provider: 'alipay', profile: 'alipay' }, { profile: 'wechat' }, { profile: 'routine' },
      { currency: 'USD' }, { amountCents: 1251 }, { transactionId: 'another_txn' }])
      await expect(checkCallback(ctx, { ...valid, ...delta } as unknown as VerifiedPaymentCallback)).rejects.toBeDefined();
    for (const delta of [{ orderDomain: 'recharge' as const }, { profile: 'wechat' as const }, { expectedAmountCents: 1251 }, { status: 'CONFLICT' as const }]) {
      const [before] = await ctx.f.db.select().from(paymentReconciliationCase).where(eq(paymentReconciliationCase.orderNo, facts.orderNo));
      await ctx.f.db.update(paymentReconciliationCase).set(delta).where(eq(paymentReconciliationCase.id, before.id));
      await expect(checkCallback(ctx, valid)).rejects.toMatchObject({ code: 400 });
      await ctx.f.db.update(paymentReconciliationCase).set({ orderDomain: before.orderDomain, profile: before.profile,
        expectedAmountCents: before.expectedAmountCents, status: before.status }).where(eq(paymentReconciliationCase.id, before.id));
    }
    await checkCallback(ctx, valid);
  }), 180000);

  it('binds signed-query witnesses to App request/result order, amount, currency, status and original domain', async () => fixture(async ctx => {
    const facts = callbackFacts('query_scope'); await register(ctx, facts.orderNo);
    await confirm(ctx, await (await initiate(ctx, facts.orderNo)).run());
    const { providerEventId: _event, ...base } = facts;
    const id = await recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, { ...base, source: 'signed_query' });
    const good = query(facts, id); await checkQuery(ctx, good.request, good.result);
    for (const delta of [{ provider: 'alipay', profile: 'alipay' }, { profile: 'wechat' }, { profile: 'routine' },
      { orderDomain: 'recharge' }, { orderDomain: 'offline_order' }, { currency: 'USD' }, { expectedAmountCents: 1251 }, { orderNo: 'different_order' }])
      await expect(checkQuery(ctx, { ...good.request, ...delta } as unknown as PaymentProviderQueryRequest, good.result)).rejects.toBeDefined();
    for (const delta of [{ status: 'PENDING' }, { providerTradeState: 'NOTPAY' }, { orderNo: 'different_order' },
      { currency: 'USD' }, { amountCents: 1251 }, { transactionId: 'different_txn' },
      { errorCode: 'provider_evidence_mismatch' }, { nativeAppEvidenceId: undefined }])
      await expect(checkQuery(ctx, good.request, { ...good.result, ...delta } as unknown as PaymentProviderQueryResult)).rejects.toBeDefined();
    await checkQuery(ctx, good.request, good.result);
  }), 180000);

  it('rejects copied and payload-tampered evidence signatures inserted by the real App LOGIN', async () => fixture(async ctx => {
    const facts = callbackFacts('signature_source'); await recordNativeAppProviderEvidence(appContainer(ctx), ctx.env, facts);
    await ctx.app.db.execute(sql`INSERT INTO public.native_app_payment_evidence(evidence_id,order_no,kind,format_version,payload,created_at,signature)
      SELECT 'callback:copied_event',order_no,kind,format_version,payload,created_at,signature
      FROM public.native_app_payment_evidence WHERE evidence_id=${'callback:' + facts.providerEventId}`);
    await expect(checkCallback(ctx, { ...callback(facts), providerEventId: 'copied_event' })).rejects.toMatchObject({ code: 503 });
    await ctx.app.db.execute(sql`INSERT INTO public.native_app_payment_evidence(evidence_id,order_no,kind,format_version,payload,created_at,signature)
      SELECT 'callback:tampered_event',order_no,kind,format_version,jsonb_set(payload,'{amountCents}','1251'::jsonb),created_at,signature
      FROM public.native_app_payment_evidence WHERE evidence_id=${'callback:' + facts.providerEventId}`);
    await expect(checkCallback(ctx, { ...callback(facts), providerEventId: 'tampered_event', amountCents: 1251 })).rejects.toMatchObject({ code: 503 });
    await checkCallback(ctx, callback(facts));
    expect(await evidenceRows(ctx)).toHaveLength(3);
  }), 180000);

  it('rejects copied account signatures even when the real Admin has INSERT permission', async () => fixture(async ctx => {
    await rotate(ctx, B); const [source] = await accountRows(ctx);
    await ctx.admin.db.execute(sql`INSERT INTO public.native_app_payment_account(account_id,app_id,mch_id,operation_id,actor_id,source_revision,format_version,created_at,signature)
      SELECT ${'c'.repeat(64)},${JSON.stringify(C)},mch_id,operation_id,actor_id,source_revision,format_version,created_at,signature
      FROM public.native_app_payment_account WHERE account_id=${source.account_id}`);
    expect(await accountRows(ctx)).toHaveLength(3);
    await expect(current(ctx)).rejects.toMatchObject({ code: 503 });
  }), 180000);

  it('rolls back verified account history, config and receipt together after an explicit post-insert publication fault', async () => fixture(async ctx => {
    const beforeConfig = await ctx.f.db.select().from(systemConfig).orderBy(systemConfig.id), beforeAccounts = await accountRows(ctx);
    const beforeReceipts = await ctx.admin.exec('SELECT * FROM public.admin_wechat_app_operation ORDER BY operation_id');
    const input = await saveRequest(ctx, B);
    // Explicit test-host fault after the real append has written and verified
    // its receipt. No SQL success, authorization, catalog or HMAC is mocked.
    // Altering receipt DDL before save would only prove an early drift refusal.
    const internals = ctx.author as unknown as { append: (...args: any[]) => Promise<any> };
    const append = internals.append.bind(ctx.author);
    const publication = vi.spyOn(internals, 'append').mockImplementationOnce(async (...args) => {
      const row = await append(...args), tx = args[0] as DbClient;
      expect(row.state).toBe('committed');
      expect(await tx.execute(sql`SELECT operation_id FROM public.admin_wechat_app_operation WHERE operation_id=${input.request_id}::uuid`))
        .toHaveLength(1);
      expect(await tx.execute(sql`SELECT account_id FROM public.native_app_payment_account`)).toHaveLength(2);
      expect((await tx.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.id, APP_ROW)))[0].value)
        .toBe(JSON.stringify(B));
      throw Error('Owned post-receipt publication fault');
    });
    try {
      await expect(ctx.author.save(input, actor)).rejects.toMatchObject({ code: 503 });
      expect(publication).toHaveBeenCalledTimes(1);
      expect(await ctx.f.db.select().from(systemConfig).orderBy(systemConfig.id)).toEqual(beforeConfig);
      expect(await accountRows(ctx)).toEqual(beforeAccounts);
      expect(await ctx.admin.exec('SELECT * FROM public.admin_wechat_app_operation ORDER BY operation_id')).toEqual(beforeReceipts);
    } finally { publication.mockRestore(); }
    expect(await ctx.author.save(input, actor)).toMatchObject({ state: 'committed', replayed: false });
    expect(await accountRows(ctx)).toHaveLength(2);
  }), 180000);

  it('uses independent restricted sessions for the shared/exclusive731664 account fence while Open731661 stays independent', async () => fixture(async ctx => {
    const input = await saveRequest(ctx, B);
    await ctx.app.db.transaction(async tx => {
      const [identity] = await tx.execute(sql`SELECT current_user AS role,pg_backend_pid() AS pid`);
      expect(identity).toEqual({ role: ctx.app.role, pid: ctx.app.pid });
      await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(731664,0)`);
      await expect(ctx.author.save(input, actor)).rejects.toMatchObject({ code: 503 });
    });
    await ctx.admin.db.transaction(async tx => {
      const [identity] = await tx.execute(sql`SELECT current_user AS role,pg_backend_pid() AS pid`);
      expect(identity).toEqual({ role: ctx.admin.role, pid: ctx.admin.pid });
      await tx.execute(sql`SELECT pg_advisory_xact_lock(731664,0)`);
      await expect(current(ctx)).rejects.toMatchObject({ code: 503 });
    });
    await ctx.admin.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(731661,0)`);
      expect(await current(ctx)).toMatchObject({ appId: A, merchantId: M1 });
    });
    expect(await ctx.author.save(input, actor)).toMatchObject({ state: 'committed' });
    expect(await current(ctx)).toMatchObject({ appId: B, merchantId: M1 });
  }), 180000);
});
