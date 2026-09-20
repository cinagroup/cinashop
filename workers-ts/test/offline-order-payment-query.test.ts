import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlinePredecessorSchemaSql } from './helpers/offlinePredecessorSchema';
import { sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { otherOrder, systemConfig, user, userRecharge, wechatUser } from '../src/models/schema';
import { OFFLINE_ORDER_ADMISSION_SQL } from '../src/migrations/offlineOrderAdmission';
import { OFFLINE_ORDER_PAYMENT_SELECTION_SQL } from '../src/migrations/offlineOrderPaymentSelection';
import { OFFLINE_ORDER_BALANCE_SQL } from '../src/migrations/offlineOrderBalance';
import { admitOfflineOrder } from '../src/services/order/OfflineOrderAdmissionService';
import { selectOfflineOrderExternalPayment } from '../src/services/order/OfflineOrderPaymentSelectionService';
import { queryOfflineOrderPayment } from '../src/services/order/OfflineOrderPaymentQueryService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { paymentQueryFixture, paymentQueryKeys } from './helpers/paymentQueryFixture';

describe('offline original-identity query preflight on isolated native PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string, keys: ReturnType<typeof paymentQueryKeys>;
  type Runtime = SequenceRunnerPeer & { role: string };
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 required');
    ddl = await offlinePredecessorSchemaSql();
    keys = paymentQueryKeys();
  }, 60_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unstubbed provider I/O forbidden'));
    f = await sequenceRunnerDatabase();
    await f.db.transaction(async tx => {
      for (const statement of [ddl, OFFLINE_ORDER_ADMISSION_SQL, OFFLINE_ORDER_PAYMENT_SELECTION_SQL, OFFLINE_ORDER_BALANCE_SQL]) {
        await tx.execute(sql.raw(statement));
      }
    });
    await f.db.insert(user).values({ uid: 11, account: 'original-query-buyer', nowMoney: '100.00', integral: 50 });
    await f.db.insert(systemConfig).values({ menuName: 'member_card_status', value: '0' });
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const runtime = <T>(work: (r: Runtime) => Promise<T>) => f.withRuntimeRole!(async r => {
    await f.exec(`GRANT SELECT ON "user",system_config,member_right,wechat_user,other_order,other_order_status,
      offline_order_admission,offline_order_payment_selection,store_order,user_recharge TO "${r.role}";
      GRANT UPDATE(uid) ON "user" TO "${r.role}";
      GRANT UPDATE(id) ON other_order,wechat_user TO "${r.role}";
      GRANT EXECUTE ON FUNCTION public.ooa_lock_pricing() TO "${r.role}";
      GRANT INSERT ON other_order,other_order_status,offline_order_admission,offline_order_payment_selection TO "${r.role}";
      GRANT USAGE ON SEQUENCE other_order_id_seq TO "${r.role}"`);
    const [role] = await r.exec(`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    return work(r);
  });
  const create = async (r: Runtime, channel: 'h5' | 'wechat' | 'routine' = 'wechat', rail: 'wechat' | 'alipay' = 'wechat') => {
    const container = createContainerFromDb(r.db), api = await paymentQueryFixture(container, keys);
    const request = { ...api.request(rail), profile: channel === 'routine' ? 'routine' as const : rail };
    await admitOfflineOrder(container, { uid: 11, requestKey: crypto.randomUUID(), orderNo: request.orderNo,
      money: '10.00', expectedPayPrice: '10.00', from: channel });
    if (rail === 'wechat' && channel !== 'h5') await f.db.insert(wechatUser).values({ uid: 11,
      openid: api.identity().payerId, userType: channel, nickname: 'query-payer' });
    const { selection } = await selectOfflineOrderExternalPayment(container, { uid: 11, orderNo: request.orderNo,
      identity: { provider: rail, profile: request.profile, appId: api.identity(rail).appId, merchantId: api.identity(rail).merchantId } });
    return { container, api, request, selection,
      query: () => queryOfflineOrderPayment(container, api.env, request) };
  };
  const state = async () => (await f.query(`SELECT
    (SELECT row_to_json(o) FROM other_order o) AS order_row,
    (SELECT row_to_json(u) FROM "user" u) AS account,
    (SELECT row_to_json(s) FROM offline_order_payment_selection s) AS selection,
    (SELECT count(*)::integer FROM user_money) AS money,
    (SELECT count(*)::integer FROM user_bill) AS bills,
    (SELECT count(*)::integer FROM payment_callback_event) AS callbacks,
    (SELECT count(*)::integer FROM payment_callback_outbox) AS outboxes,
    (SELECT count(*)::integer FROM payment_reconciliation_case) AS cases`)).rows[0];
  it.each(['wechat', 'routine', 'h5', 'alipay'] as const)('%s query uses frozen selection after committing all locks and changes no financial state', async channel => {
    await runtime(async r => {
      const test = await create(r, channel === 'alipay' ? 'h5' : channel, channel === 'alipay' ? 'alipay' : 'wechat');
      const before = await state();
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (typeof url !== 'string' || !init) throw Error('Unexpected provider request');
        expect(test.api.verifyRequest(url, init)).toBe(true);
        const activity = await f.query(`SELECT state,xact_start IS NULL AS ended FROM pg_stat_activity WHERE pid=${r.pid}`);
        expect(activity.rows).toEqual([{ state: 'idle', ended: true }]);
        // A separate connection can acquire both row locks before the response.
        await f.db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL lock_timeout='250ms'`);
          await tx.execute(sql`SELECT id FROM other_order FOR UPDATE NOWAIT`);
          await tx.execute(sql`SELECT uid FROM "user" FOR UPDATE NOWAIT`);
        });
        return channel === 'alipay' ? test.api.alipayResponse()
          : test.api.wechatResponse(test.api.wxBody({ trade_type: channel === 'h5' ? 'MWEB' : 'JSAPI' }));
      });
      expect(await test.query()).toMatchObject({ selectionKey: test.selection.selectionKey, result: { status: 'SUCCESS' } });
      expect(await state()).toEqual(before); expect(fetch).toHaveBeenCalledOnce();
    });
  });
  it('uses original payer despite changed account binding, account ban and hidden order, without settling or reactivating anything', async () => {
    await runtime(async r => {
      const test = await create(r);
      await f.db.update(wechatUser).set({ openid: 'current-but-not-original-payer' });
      await f.db.update(user).set({ status: 0, isDel: 1, deleteTime: new Date('2026-09-19T00:00:00Z') });
      await f.db.update(otherOrder).set({ isDel: 1 });
      const before = await state();
      vi.mocked(fetch).mockResolvedValueOnce(test.api.wechatResponse(test.api.wxBody({ payer: { openid: 'current-but-not-original-payer' } })));
      expect((await test.query()).result.status).toBe('UNKNOWN');
      vi.mocked(fetch).mockResolvedValueOnce(test.api.wechatResponse());
      expect((await test.query()).result.status).toBe('SUCCESS');
      expect(await state()).toEqual(before);
    });
  });
  it.each(['amount', 'profile', 'provider', 'domain', 'currency'] as const)('rejects altered %s before provider I/O', async field => {
    await runtime(async r => {
      const test = await create(r), before = await state();
      const request = { ...test.request,
        ...(field === 'amount' ? { expectedAmountCents: 1001 } : {}),
        ...(field === 'profile' ? { profile: 'routine' as const } : {}),
        ...(field === 'provider' ? { provider: 'alipay' as const } : {}),
        ...(field === 'domain' ? { orderDomain: 'membership' as const } : {}) };
      // Runtime malformed input, without weakening the production CNY type.
      if (field === 'currency') Object.defineProperty(request, 'currency', { value: 'USD' });
      await expect(queryOfflineOrderPayment(test.container, test.api.env, request)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
    });
  });
  it.each(['merchant', 'app'] as const)('rejects rotated %s after authoritative preflight but before provider I/O', async field => {
    await runtime(async r => {
      const test = await create(r), before = await state();
      test.api.config[field === 'merchant' ? 'cfg_pay_weixin_mchid' : 'cfg_wechat_appid'] = field === 'merchant' ? '9999999999' : 'new-app';
      await expect(test.query()).rejects.toThrow('原支付商户');
      expect(fetch).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
    });
  });
  it('rejects cross-domain order ambiguity without asking any provider', async () => {
    await runtime(async r => {
      const test = await create(r);
      await f.db.insert(userRecharge).values({ uid: 11, orderId: test.request.orderNo, price: '10.00', paid: 0 });
      await expect(test.query()).rejects.toThrow('跨域歧义'); expect(fetch).not.toHaveBeenCalled();
    });
  });
  it('rejects a same-number membership row before using offline provider credentials', async () => {
    await runtime(async r => {
      const test = await create(r);
      await f.db.insert(otherOrder).values({ uid: 11, orderId: test.request.orderNo, type: 1, payPrice: '10.00', memberPrice: '10.00' });
      await expect(test.query()).rejects.toThrow('身份异常'); expect(fetch).not.toHaveBeenCalled();
    });
  });
  it.each(['selection-table', 'selection-permission', 'order-permission'] as const)('fails closed on missing %s, without runtime repair or I/O', async failure => {
    await runtime(async r => {
      const test = await create(r);
      if (failure === 'selection-table') await f.exec('ALTER TABLE offline_order_payment_selection RENAME TO missing_query_selection');
      else await f.exec(`REVOKE SELECT ON ${failure === 'selection-permission' ? 'offline_order_payment_selection' : 'other_order'} FROM "${r.role}"`);
      await expect(test.query()).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
    });
  });
  it('rejects an order without a persisted original selection', async () => {
    await runtime(async r => {
      const container = createContainerFromDb(r.db), api = await paymentQueryFixture(container, keys);
      await expect(queryOfflineOrderPayment(container, api.env, api.request())).rejects.toThrow('原支付路径不存在');
      expect(fetch).not.toHaveBeenCalled();
    });
  });
  it('does not release or rewrite the original selection after a lost query response', async () => {
    await runtime(async r => {
      const test = await create(r), before = await state();
      await expect(test.query()).rejects.toThrow('状态未知'); expect(await state()).toEqual(before);
      expect(fetch).toHaveBeenCalledOnce();
    });
  });
});
