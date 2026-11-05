/** Current contract acceptance, distinct from the archived owner-only vector.
 * Real registered HTTP/UserJWT and five independently commissioned LOGINs;
 * the official NativeApp addon precedes the genuine missing-AppID rejection.
 * No provider response, readiness, initiation or original-payment fact is mocked.
 * This suite does not claim a successful SDK/provider payment launch. */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { memberShip, otherOrder, systemConfig, user } from '@/models/schema';
import { createContainerFromDb } from '@/lib/di';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { readNativeAppPaymentAccount } from '@/services/payment/NativeAppPaymentAuthority';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

const PLAN = 66101, BUYER = 66101, OTHER = 66102, MERCHANT = '1900000109';
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('membership current NativeApp admission on genuine commissioned PG16 LOGINs',
  { timeout: 30000 }, () => {
    let f: Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
    let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>, orderNo: string;
    let tables: string[], sequences: string[];
    const resources = () => ({ objects: [...f.objects.keys()].sort(), messages: [...f.messages],
      put: f.put.mock.calls.length, remove: f.remove.mock.calls.length,
      send: f.send.mock.calls.length, sendBatch: f.sendBatch.mock.calls.length });
    async function snapshot() {
      const rows = await f.maintenanceDb.execute(sql.join(tables.map(name => sql`
        SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows
        FROM public.${sql.identifier(name)} t`), sql` UNION ALL `));
      const sequenceState = await f.maintenanceDb.execute(sql.join(sequences.map(name => sql`
        SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM public.${sql.identifier(name)}`), sql` UNION ALL `));
      const catalog = await f.maintenanceDb.execute(sql`SELECT jsonb_build_object(
        'relations',(SELECT jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relowner,c.relacl,c.reloptions,
          pg_catalog.obj_description(c.oid,'pg_class')) ORDER BY c.oid) FROM pg_catalog.pg_class c
          WHERE c.relnamespace='public'::regnamespace AND (c.relname LIKE 'native_app_payment_%'
            OR c.relname LIKE 'napa_%' OR c.relname LIKE 'nape_%' OR c.relname LIKE 'admin_wechat_app_operation%'
            OR c.relname LIKE 'awao_%')),
        'constraints',(SELECT jsonb_agg(jsonb_build_array(c.oid,c.conrelid,c.conname,pg_catalog.pg_get_constraintdef(c.oid)) ORDER BY c.oid)
          FROM pg_catalog.pg_constraint c WHERE c.conrelid IN ('public.native_app_payment_account'::regclass,
            'public.native_app_payment_evidence'::regclass,'public.admin_wechat_app_operation'::regclass)),
        'triggers',(SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('definition',pg_catalog.pg_get_triggerdef(t.oid)) ORDER BY t.oid)
          FROM pg_catalog.pg_trigger t WHERE t.tgrelid IN ('public.native_app_payment_account'::regclass,
            'public.native_app_payment_evidence'::regclass,'public.admin_wechat_app_operation'::regclass)),
        'functions',(SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('definition',pg_catalog.pg_get_functiondef(p.oid)) ORDER BY p.oid)
          FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN (
            'native_app_payment_account_immutable_v1','native_app_payment_evidence_immutable_v1','admin_wechat_app_operation_immutable_v1'))
      ) AS value`);
      return { rows, sequences: sequenceState, catalog, resources: resources() };
    }
    async function request(path: string, body: unknown, uid = BUYER) {
      const response = await f.raw(path, { method: 'POST', headers: {
        Authorization: 'Bearer ' + await f.bearer(uid), 'Content-Type': 'application/json', 'Form-type': 'app',
      }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return await response.json() as { status: number; msg: string; data: Record<string, unknown> | null };
    }
    beforeAll(async () => {
      network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('NativeApp admission acceptance forbids provider I/O'));
      f = await customerCashierRuntimeHttpFixture();
      await runAdminWechatAppUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
      expect(new Set(await Promise.all([f.appRuntime, f.adminRuntime, f.financialRuntime,
        f.managerRuntime, f.cashierRuntime].map(role => role.verify()))).size).toBe(5);
      const [identity] = await f.appRuntime.db.execute(sql`SELECT current_user AS role,session_user AS session,
        current_setting('server_version_num')::integer/10000 AS major,
        rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls AS elevated
        FROM pg_catalog.pg_roles WHERE rolname=current_user`);
      expect(identity).toEqual({ role: f.target.app, session: f.target.app, major: 16, elevated: false });
      const keys = paymentQueryKeys();
      Object.assign(f.env, { WECHAT_MCH_PRIVATE_KEY: keys.privateKey, WECHAT_PLATFORM_PUBLIC_KEY: keys.publicKey,
        WECHAT_API_V3_KEY: 'a'.repeat(32), WECHAT_PLATFORM_PUBLIC_KEY_ID: 'OWNED_APP_ADMISSION' });
      const values = { member_card_status: '1', balance_func_status: '1', yue_pay_status: '1', pay_weixin_open: '1',
        pay_weixin_mchid: MERCHANT, pay_weixin_serial_no: 'AB12CD34', site_url: 'https://member.example.invalid',
        wechat_appid: 'wx1234567890abcdef', routine_appId: 'wx_owned_routine', wechat_app_appid: '' };
      await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName, Object.keys(values)));
      await f.maintenanceDb.insert(systemConfig).values(Object.entries(values).map(([menuName, value]) =>
        ({ menuName, value: JSON.stringify(value), sort: 20 })));
      for (const uid of [BUYER, OTHER]) await f.maintenanceDb.insert(user).values({ uid, account: 'native-member-' + uid,
        pwd: 'owned-financial-password', status: 1, nowMoney: '100.00', isMoneyLevel: 0, isEverLevel: 0, overdueTime: 0 });
      await f.maintenanceDb.insert(memberShip).values({ id: PLAN, title: '实际App会员准入', type: 'month', vipDay: 30,
        price: '29.90', prePrice: '9.90', isDel: 0 });
      // A blank current AppID is a legitimate query/verification state, but
      // cannot initiate a new App payment. No historical account is invented.
      expect(await readNativeAppPaymentAccount(createContainerFromDb(f.appRuntime.db), f.env))
        .toMatchObject({ appId: '', merchantId: MERCHANT });
      const created = await request('/user/member/card/create', { member_type: PLAN, from: 'weixin', request_id: randomUUID() });
      expect(created.status, created.msg).toBe(200); expect(created.data).toMatchObject({ paid: false, pay_price: '9.90' });
      orderNo = String(created.data!.order_id);
      expect((await f.maintenanceDb.select().from(otherOrder).where(eq(otherOrder.orderId, orderNo)))[0])
        .toMatchObject({ uid: BUYER, paid: 0, type: 1, channelType: 'wechat' });
      tables = (await f.maintenanceDb.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_catalog.pg_tables
        WHERE schemaname='public' ORDER BY tablename`)).map(row => row.name);
      sequences = (await f.maintenanceDb.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_catalog.pg_sequences
        WHERE schemaname='public' ORDER BY sequencename`)).map(row => row.name);
    }, 180000);
    afterAll(async () => {
      try { expect(network).not.toHaveBeenCalled(); }
      finally { network?.mockRestore(); await f?.close(); }
    }, 30000);
    it.each(['weixin', 'app'])('uses the genuine App profile for headerApp/body %s and refuses its missing AppID without any write', async from => {
      const before = await snapshot();
      const result = await request('/user/member/card/pay', { uni: orderNo, paytype: 'weixin', from });
      expect(result.status, result.msg).toBe(400); expect(result.msg).toBe('App AppID 未配置');
      expect(await snapshot()).toEqual(before); expect(network).not.toHaveBeenCalled();
    });
    it('rejects both supported paid spellings for another authenticated owner before account, finance, intent or provider writes', async () => {
      for (const from of ['weixin', 'app']) {
        const before = await snapshot();
        const result = await request('/user/member/card/pay', { uni: orderNo, paytype: 'weixin', from }, OTHER);
        expect(result.status, result.msg).toBe(400); expect(result.msg).toBe('会员订单不存在');
        expect(await snapshot()).toEqual(before); expect(network).not.toHaveBeenCalled();
      }
    });
  });
