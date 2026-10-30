/** Internal App original-guard contract, distinct from the cross-role provider
 * verifier suite. These cases do not prove actor admission, provider transport
 * or full financial HTTP behavior. No role is broadened. */
import { randomUUID } from 'node:crypto';
import { eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, withTx } from '@/lib/di';
import { systemAdmin, systemConfig, systemMenus, systemRole } from '@/models/schema';
import { ADMIN_WECHAT_APP_OPERATION_SQL } from '@/migrations/adminWechatAppOperation';
import { NATIVE_APP_PAYMENT_AUTHORITY_SQL } from '@/migrations/nativeAppPaymentAuthority';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { AdminWechatAppService } from '@/services/admin/AdminWechatAppService';
import { WECHAT_APP_VIEW_SEED, WECHAT_APP_SAVE_SEED } from '@/services/admin/AdminWechatAppPermissionBinding';
import { assertNativeAppRefundAccount, assertNativeAppRefundAccountInTx, readNativeAppPaymentAccount, recordNativeAppPaymentInitiation,
  confirmNativeAppPaymentInitiation } from '@/services/payment/NativeAppPaymentAuthority';
import { registerPaymentReconciliationIntent } from '@/services/payment/PaymentReconciliationRegistry';
import { md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import type { WechatAppSave } from '../../view/common/wechatApp';

type F = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<F['withRuntimeRole']>>[0] extends (peer: infer R) => unknown ? R : never;
type Context = { f: F; app: Peer; admin: Peer; env: Env; author: AdminWechatAppService };
const A = 'wxrefundA000001', B = 'wxrefundB000002', M1 = '1900000101', M2 = '1900000202';
const APP_ROW = 883348, MCH_ROW = 883350, ADMIN_ID = 883379, PASSWORD = 'owned-app-refund-author';
const actor = { id: ADMIN_ID, authVersion: md5(PASSWORD), expiresAt: Math.floor(Date.now() / 1000) + 86400 };
const appContainer = (ctx: Context) => createContainerFromDb(ctx.app.db);
const input = (orderNo = 'refund_original_A', patch = {}) => ({ orderNo, merchantId: M1, totalAmount: 1250, ...patch });

/** Native PG16 only, with two real independently authenticated runtime LOGINs.
 * Confirmation inputs below are synthetic already-verified internal facts;
 * they are not HTTP signature, real WeChat, SDK or actual refund acceptance. */
async function fixture(run: (ctx: Context) => Promise<void>, install = true) {
  const f = await refundRuntimeFixture();
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Refund authority primitive forbids provider I/O'));
  try {
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.pricingOwner) throw Error('Independent commissioned PG16 LOGINs required');
    await f.withRuntimeRole(app => f.withRuntimeRole!(async admin => {
      const [owner] = await f.exec('SELECT current_database() AS database,current_user AS maintenance');
      const names = { database: String(owner.database), maintenance: String(owner.maintenance),
        app: app.role, admin: admin.role, pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      for (const peer of [app, admin]) {
        const [identity] = await peer.exec(`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
          current_setting('server_version_num')::integer/10000 AS major,
          rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls AS elevated
          FROM pg_roles WHERE rolname=current_user`);
        expect(identity).toEqual({ role: peer.role, session: peer.role, pid: peer.pid, major: 16, elevated: false });
      }
      expect(app.role).not.toBe(admin.role); expect(app.pid).not.toBe(admin.pid);
      await f.db.insert(systemRole).values({ id: ADMIN_ID, roleName: 'Owned App refund authority', rules: '1379,315' });
      await f.db.insert(systemAdmin).values({ id: ADMIN_ID, account: 'owned_app_refund_author', pwd: PASSWORD,
        roles: String(ADMIN_ID), level: 1, adminType: 1 });
      await f.db.delete(systemMenus).where(inArray(systemMenus.id, [1379, 315]));
      await f.db.insert(systemMenus).values([{ ...WECHAT_APP_VIEW_SEED, menuName: '移动应用' }, { ...WECHAT_APP_SAVE_SEED, menuName: '保存配置' }]);
      await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, ['wechat_app_appid', 'wechat_app_appsecret',
        'pay_weixin_mchid', 'wechat_appid', 'wechat_appsecret', 'routine_appId', 'routine_appsecret', 'wechat_open_app_id', 'wechat_open_app_secret']));
      // No AppSecret, official/routine/Open ID or deployment credential can
      // silently supply the refund's public merchant identity.
      await f.db.insert(systemConfig).values([
        { id: APP_ROW, menuName: 'wechat_app_appid', value: JSON.stringify(A), sort: 5, configTabId: 73 },
        { id: MCH_ROW, menuName: 'pay_weixin_mchid', value: JSON.stringify(M1), sort: 5 },
      ]);
      const env = { APP_KEY: 'owned-native-app-refund-key', CONFIG_KV: {
        get: vi.fn(async () => { throw Error('No cached refund account'); }), put: vi.fn(), delete: vi.fn(async () => {}),
      } } as unknown as Env;
      if (install) await runAdminWechatAppUpgrade(f.db, names);
      await run({ f, app, admin, env, author: new AdminWechatAppService(createContainerFromDb(admin.db), env) });
      expect(network).not.toHaveBeenCalled(); expect(env.CONFIG_KV.get).not.toHaveBeenCalled(); expect(env.CONFIG_KV.put).not.toHaveBeenCalled();
    }));
  } finally { await f.close(); }
}
async function rotate(ctx: Context, value: string) {
  const body: WechatAppSave = { request_id: randomUUID(), revision: (await ctx.author.read(actor)).revision, confirmed: true,
    fields: { wechat_app_appid: { action: 'replace', value }, wechat_app_appsecret: { action: 'keep' } } };
  expect(await ctx.author.save(body, actor)).toMatchObject({ state: 'committed' });
}
async function selection(ctx: Context, orderNo = 'refund_original_A', domain = 'store_order') {
  await registerPaymentReconciliationIntent(appContainer(ctx), { provider: 'wechat', profile: 'app', orderDomain: domain as 'store_order' | 'recharge' | 'membership',
    orderNo, expectedAmountCents: 1250, initiated: true });
  const pair = await readNativeAppPaymentAccount(appContainer(ctx), ctx.env);
  return recordNativeAppPaymentInitiation(appContainer(ctx), ctx.env, { appId: pair.appId, merchantId: pair.merchantId,
    profile: 'app', orderNo, amountCents: 1250, orderDomain: domain, currency: 'CNY', configStamp: pair.stamp });
}
async function original(ctx: Context, orderNo = 'refund_original_A', domain = 'store_order') {
  const chosen = await selection(ctx, orderNo, domain);
  await confirmNativeAppPaymentInitiation(appContainer(ctx), ctx.env, chosen, { appId: chosen.appId, merchantId: chosen.merchantId,
    orderNo, amountCents: 1250, currency: 'CNY', tradeType: 'APP', prepayId: 'owned_refund_' + orderNo });
}
async function rows(ctx: Context) {
  return { config: await ctx.f.db.select({ ...getTableColumns(systemConfig), version: sql<string>`xmin::text` }).from(systemConfig).orderBy(systemConfig.id),
    accounts: await ctx.app.exec('SELECT * FROM public.native_app_payment_account ORDER BY account_id'),
    evidence: await ctx.app.exec('SELECT * FROM public.native_app_payment_evidence ORDER BY evidence_id') };
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Native App refund original guard on actual restricted PG16 LOGINs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('allows the completely absent optional bundle as legacy without App keys or a new order-number restriction', async () => fixture(async ctx => {
    const before = await ctx.f.db.select().from(systemConfig).orderBy(systemConfig.id);
    for (const orderNo of ['x', 'legacy order/中文#:1', 'old'.repeat(80)])
      await expect(assertNativeAppRefundAccount(appContainer(ctx), { APP_KEY: '' }, input(orderNo))).resolves.toBeUndefined();
    expect(await ctx.f.db.select().from(systemConfig).orderBy(systemConfig.id)).toEqual(before);
    expect((await ctx.f.exec(`SELECT to_regclass('public.admin_wechat_app_operation') AS operation,
      to_regclass('public.native_app_payment_account') AS account,to_regclass('public.native_app_payment_evidence') AS evidence`))[0])
      .toEqual({ operation: null, account: null, evidence: null });
  }, false), 180000);

  it('refuses operation-only payment-only and orphan-function partial catalogs rather than falling back to legacy', async () => {
    for (const ddl of [ADMIN_WECHAT_APP_OPERATION_SQL, NATIVE_APP_PAYMENT_AUTHORITY_SQL,
      "CREATE FUNCTION public.native_app_payment_orphan() RETURNS integer LANGUAGE sql AS 'SELECT 1'"])
      await fixture(async ctx => {
        await ctx.f.db.execute(sql.raw(ddl));
        await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input())).rejects.toMatchObject({ code: 503 });
      }, false);
  }, 180000);

  it('uses the real App role and confirms a matching original without any configuration history or evidence DML', async () => fixture(async ctx => {
    await original(ctx);
    expect((await ctx.app.exec(`SELECT has_table_privilege(current_user,'public.system_config','UPDATE') AS table_update,
      has_any_column_privilege(current_user,'public.system_config','UPDATE') AS column_update`))[0])
      .toEqual({ table_update: false, column_update: false });
    const before = await rows(ctx);
    await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input())).resolves.toBeUndefined();
    expect(await rows(ctx)).toEqual(before);
    await expect(assertNativeAppRefundAccount(createContainerFromDb(ctx.admin.db), ctx.env, input())).rejects.toMatchObject({ code: 503 });
    await expect(assertNativeAppRefundAccount(createContainerFromDb(ctx.f.db), ctx.env, input())).rejects.toMatchObject({ code: 503 });
  }), 180000);

  it('requires a fresh READ COMMITTED READ ONLY transaction for the in-transaction primitive', async () => fixture(async ctx => {
    const before = await rows(ctx);
    for (const settings of ['ISOLATION LEVEL READ COMMITTED, READ WRITE', 'ISOLATION LEVEL REPEATABLE READ, READ ONLY']) {
      await withTx(appContainer(ctx), async tx => {
        await tx.execute(sql.raw('SET TRANSACTION ' + settings));
        await expect(assertNativeAppRefundAccountInTx(tx, ctx.env, input())).rejects.toMatchObject({ code: 503 });
      });
    }
    expect(await rows(ctx)).toEqual(before);
  }), 180000);

  it('rejects a stale request merchant and a different fresh merchant against the confirmed original', async () => fixture(async ctx => {
    await original(ctx);
    await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input(undefined, { merchantId: M2 })))
      .rejects.toThrow('商户配置已变化');
    // This explicit maintenance variation is not supported merchant rotation.
    // Now the request matches fresh SQL, so only original M1 can reject M2.
    await ctx.f.db.update(systemConfig).set({ value: JSON.stringify(M2) }).where(eq(systemConfig.id, MCH_ROW));
    const before = await rows(ctx);
    await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input(undefined, { merchantId: M2 })))
      .rejects.toThrow('已确认原单');
    expect(await rows(ctx)).toEqual(before);
  }), 180000);

  it('rejects a contradictory total amount even when the current merchant matches', async () => fixture(async ctx => {
    await original(ctx); const before = await rows(ctx);
    await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input(undefined, { totalAmount: 1251 })))
      .rejects.toThrow('已确认原单');
    expect(await rows(ctx)).toEqual(before);
  }), 180000);

  it('does not let a confirmed recharge or membership original authorize the store-order refund domain', async () => fixture(async ctx => {
    for (const domain of ['recharge', 'membership']) {
      const orderNo = 'refund_wrong_domain_' + domain; await original(ctx, orderNo, domain);
      await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input(orderNo))).rejects.toThrow('订单域');
    }
  }), 180000);

  it('keeps an init-only order legacy without guessing its original merchant amount or domain', async () => fixture(async ctx => {
    const chosen = await selection(ctx, 'refund_attempt_only', 'membership');
    await rotate(ctx, B);
    await ctx.f.db.update(systemConfig).set({ value: JSON.stringify(M2) }).where(eq(systemConfig.id, MCH_ROW));
    const before = await rows(ctx);
    expect(before.evidence).toHaveLength(1);
    expect(before.evidence[0]).toMatchObject({ evidence_id: expect.stringMatching(/^init:refund_attempt_only:[a-f0-9]{64}$/u), payload: chosen });
    await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env,
      input('refund_attempt_only', { merchantId: M2, totalAmount: 9999 }))).resolves.toBeUndefined();
    expect(await rows(ctx)).toEqual(before);
    expect(before.evidence.some(row => String(row.evidence_id).startsWith('original:'))).toBe(false);
  }), 180000);

  it('permits a legacy number outside the App format even when the full optional bundle exists', async () => fixture(async ctx => {
    const before = await rows(ctx);
    for (const orderNo of ['x', 'legacy order/中文#:1', 'old'.repeat(80)])
      await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input(orderNo))).resolves.toBeUndefined();
    expect(await rows(ctx)).toEqual(before);
  }), 180000);

  it('continues refunding confirmed A/M1 after B rotation and clear without AppSecret or unrelated AppIDs', async () => fixture(async ctx => {
    await original(ctx); await rotate(ctx, B); await rotate(ctx, '');
    expect(await readNativeAppPaymentAccount(appContainer(ctx), ctx.env)).toMatchObject({ appId: '', merchantId: M1 });
    const before = await rows(ctx);
    expect(before.accounts.map(row => [JSON.parse(String(row.app_id)), row.mch_id]).sort()).toEqual([[A, M1], [B, M1]].sort());
    expect(before.config.some(row => ['wechat_app_appsecret', 'wechat_appid', 'wechat_appsecret', 'routine_appId', 'wechat_open_app_id'].includes(row.menuName))).toBe(false);
    await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input())).resolves.toBeUndefined();
    expect(await rows(ctx)).toEqual(before);
  }), 180000);

  it('rejects catalog constraint function and actual role ACL drift without repairing it', async () => fixture(async ctx => {
    await ctx.f.exec('ALTER TABLE public.native_app_payment_evidence DROP CONSTRAINT nape_format_ck');
    await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input())).rejects.toMatchObject({ code: 503 });
    await ctx.f.exec('ALTER TABLE public.native_app_payment_evidence ADD CONSTRAINT nape_format_ck CHECK(format_version=1)');
    await ctx.f.exec('GRANT EXECUTE ON FUNCTION public.admin_wechat_app_operation_immutable_v1() TO PUBLIC');
    await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input())).rejects.toMatchObject({ code: 503 });
    await ctx.f.exec('REVOKE EXECUTE ON FUNCTION public.admin_wechat_app_operation_immutable_v1() FROM PUBLIC');
    await ctx.f.exec(`GRANT UPDATE ON public.native_app_payment_account TO "${ctx.app.role}"`);
    await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input())).rejects.toMatchObject({ code: 503 });
    expect((await ctx.app.exec("SELECT has_table_privilege(current_user,'public.native_app_payment_account','UPDATE') AS drift_retained"))[0])
      .toEqual({ drift_retained: true });
  }), 180000);

  it('refuses an App-inserted copy with a forged original HMAC while preserving the genuine original', async () => fixture(async ctx => {
    await original(ctx);
    await ctx.app.db.execute(sql`INSERT INTO public.native_app_payment_evidence(evidence_id,order_no,kind,format_version,payload,created_at,signature)
      SELECT 'original:refund_copied_original','refund_copied_original',kind,format_version,
        jsonb_set(payload,'{orderNo}','"refund_copied_original"'::jsonb),created_at,signature
      FROM public.native_app_payment_evidence WHERE evidence_id='original:refund_original_A'`);
    const before = await rows(ctx);
    await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input('refund_copied_original'))).rejects.toMatchObject({ code: 503 });
    await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input())).resolves.toBeUndefined();
    expect(await rows(ctx)).toEqual(before);
  }), 180000);

  it('refuses an Admin-inserted account HMAC copy instead of using corrupt history as refund authority', async () => fixture(async ctx => {
    await original(ctx); await rotate(ctx, B);
    await ctx.admin.db.execute(sql`INSERT INTO public.native_app_payment_account(account_id,app_id,mch_id,operation_id,actor_id,source_revision,format_version,created_at,signature)
      SELECT ${'f'.repeat(64)},app_id,mch_id,operation_id,actor_id,source_revision,format_version,created_at,signature
      FROM public.native_app_payment_account ORDER BY account_id LIMIT 1`);
    const before = await rows(ctx);
    await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input())).rejects.toMatchObject({ code: 503 });
    expect(await rows(ctx)).toEqual(before);
  }), 180000);

  it('uses the same shared account gate and returns before the caller starts provider I/O', async () => fixture(async ctx => {
    await original(ctx);
    await ctx.admin.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(731664,0)`);
      await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input())).rejects.toMatchObject({ code: 503 });
    });
    await expect(assertNativeAppRefundAccount(appContainer(ctx), ctx.env, input())).resolves.toBeUndefined();
    const [released] = await ctx.admin.exec('SELECT pg_try_advisory_xact_lock(731664,0) AS locked');
    expect(released).toEqual({ locked: true });
  }), 180000);
});
