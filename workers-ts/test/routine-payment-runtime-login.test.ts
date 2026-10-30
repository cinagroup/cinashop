import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRoutinePaymentRuntime, runRoutinePaymentRuntimeInstallation } from '../src/migrations/routinePaymentRuntime';
import { runtimeBusinessPrivilegePlan } from '../src/migrations/runtimeBusinessPrivilegePlan';
import { applyStoreOrderBalancePayment } from '../src/services/order/StoreOrderPayService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { registerPaymentReconciliationTx } from '../src/services/payment/PaymentReconciliationRegistry';
import { appendRoutineIdentityWitness, readRoutineIdentityWitness } from '../src/services/wechat/RoutineIdentityWitness';
import { issueRoutineIdentityObservation } from '../src/services/wechat/RoutineIdentityObservation';
import { readRoutineCredentials } from '../src/services/wechat/RoutineRuntimeConfig';
import { paymentReconciliationAction, storeCart, wechatUser } from '../src/models/schema';
import { decimalToCents } from '../src/services/order/OrderBrokerageService';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

describe('routine addon with complete independently commissioned app and admin LOGINs', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned native PG16 required');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No real provider calls'));
    f = await refundRuntimeFixture();
    await f.exec(`UPDATE public."user" SET now_money=200 WHERE uid=11;
      INSERT INTO public.system_config(menu_name,value) VALUES('balance_func_status','1'),('yue_pay_status','1'),('order_give_integral','0');`);
  }, 60000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);

  it('keeps the 283-table base exact, audits the explicit 285-table delta, and performs real guarded app operations', async () => {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS database');
      const target = { database: String(identity.database), maintenance: 'finance_test', app: app.role, admin: admin.role, pricingOwner: f.pricingOwner };
      const basePlans = JSON.stringify([runtimeBusinessPrivilegePlan('app'), runtimeBusinessPrivilegePlan('admin')]);
      await runRuntimeBusinessCommissioning(f.db, target);
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const)
        expect(await auditRuntimeBusinessPrivileges(peer.db, kind, target)).toMatchObject({ ready: true, failures: [], tableCount: 283 });
      expect(await runRoutinePaymentRuntimeInstallation(f.db, target)).toMatchObject({ applied: true, after: { ready: true }, baseProfilesVerified: false });
      expect(JSON.stringify([runtimeBusinessPrivilegePlan('app'), runtimeBusinessPrivilegePlan('admin')])).toBe(basePlans);
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
        expect(await auditRoutinePaymentRuntime(peer.db, kind, target)).toMatchObject({ ready: true, realLogin: true });
        expect(await auditRuntimeBusinessPrivileges(peer.db, kind, target)).toMatchObject({ ready: true, failures: [], tableCount: 285 });
      }
      // Actual witness service, HMAC and live identity/binding checks, under the
      // complete App LOGIN. The exchange is synthetic and makes no provider
      // authentication or old-account ownership claim.
      await f.exec(`DELETE FROM public.system_config WHERE menu_name IN('routine_appId','routine_appsecret');
        INSERT INTO public.system_config(menu_name,value) VALUES('routine_appId','"wxFormalRoutine10"'),('routine_appsecret','"formal-fixture-secret"');`);
      const [binding] = await f.db.insert(wechatUser).values({ uid: 11, openid: 'formal_routine_payer', userType: 'routine' }).returning();
      const container = createContainerFromDb(app.db), env = { ...f.env, APP_KEY: 'owned-formal-runtime-key' };
      const credentials = await readRoutineCredentials(container, env);
      const observation = issueRoutineIdentityObservation(env, { appId: credentials.appId, openid: binding.openid, sourceStamp: credentials.stamp });
      const [usersBefore] = await f.exec('SELECT jsonb_agg(to_jsonb(u) ORDER BY uid) AS users FROM public."user" u');
      const witness = await withTx(container, tx => appendRoutineIdentityWitness(tx, env, { uid: 11, observation }));
      expect(witness).toMatchObject({ uid: 11, bindingId: binding.id, observation: { appId: 'wxFormalRoutine10', openid: binding.openid } });
      expect(await withTx(container, tx => readRoutineIdentityWitness(tx, env, { uid: 11, bindingId: binding.id, appId: credentials.appId, openid: binding.openid }))).toEqual(witness);
      expect((await f.exec('SELECT jsonb_agg(to_jsonb(u) ORDER BY uid) AS users FROM public."user" u'))[0]).toEqual(usersBefore);

      const sourceCarts = await f.db.select().from(storeCart).where(inArray(storeCart.id, [1, 2]));
      expect(sourceCarts).toHaveLength(2);
      let cartId = 50;
      const create = async (suffix: string) => {
        const orderNo = `formal_local_${suffix}`;
        const freshCarts = await f.db.insert(storeCart).values(sourceCarts.map(row => ({ ...row, id: cartId++, isPay: 0, isDel: 0 }))).returning();
        await StoreOrderCreateService.createWithRuntime(container, { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => orderNo },
          { uid: 11, key: orderNo, cartIds: freshCarts.map(row => row.id), addressId: 11, userIp: '127.0.0.1', useIntegral: true });
        const [order] = await app.exec(`SELECT id,order_id,pay_price FROM public.store_order WHERE order_id='${orderNo}'`);
        const candidate = await withTx(createContainerFromDb(f.db), tx => registerPaymentReconciliationTx(tx, { provider: 'alipay', profile: 'alipay',
          orderDomain: 'store_order', orderNo, expectedAmountCents: decimalToCents(String(order.pay_price)) }));
        return { orderNo, order, candidate };
      };
      const clean = await create('clean');
      const [beforeMoney] = await app.exec('SELECT now_money FROM public."user" WHERE uid=11');
      expect(await applyStoreOrderBalancePayment(container, { uid: 11, orderId: clean.orderNo })).toMatchObject({ outcome: 'paid' });
      const [afterMoney] = await app.exec('SELECT now_money FROM public."user" WHERE uid=11');
      expect(decimalToCents(String(afterMoney.now_money))).toBe(decimalToCents(String(beforeMoney.now_money)) - decimalToCents(String(clean.order.pay_price)));
      const paidState = await f.state();
      expect(await applyStoreOrderBalancePayment(container, { uid: 11, orderId: clean.orderNo })).toMatchObject({ outcome: 'already-paid' });
      expect(await f.state()).toEqual(paidState);

      const attempt = await create('attempt');
      // Presence is denial-only. This owner-seeded local record is deliberately
      // not presented as a cryptographic Mini initiation or provider SUCCESS.
      await f.exec(`INSERT INTO public.routine_payment_attempt VALUES('${attempt.orderNo}','INITIATION','{"fixture_presence_only":true}',1,'${'a'.repeat(64)}')`);
      const beforeAttempt = await f.state();
      await expect(applyStoreOrderBalancePayment(container, { uid: 11, orderId: attempt.orderNo })).rejects.toThrow('外部支付已发起');
      expect(await f.state()).toEqual(beforeAttempt);

      const action = await create('action');
      await admin.db.insert(paymentReconciliationAction).values({ caseId: action.candidate.id, actionKey: randomUUID(), adminId: 1,
        actionType: 'RETRY', reasonCode: 'formal_fixture_retry', beforeStatus: 'UNKNOWN', afterStatus: 'OPEN' });
      const beforeAction = await f.state();
      await expect(applyStoreOrderBalancePayment(container, { uid: 11, orderId: action.orderNo })).rejects.toThrow('外部支付已发起');
      expect(await f.state()).toEqual(beforeAction);
      await expect(app.db.insert(paymentReconciliationAction).values({ caseId: action.candidate.id, actionKey: randomUUID(), adminId: 1,
        actionType: 'RETRY', reasonCode: 'must_remain_denied', beforeStatus: 'UNKNOWN', afterStatus: 'OPEN' })).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(admin.exec('INSERT INTO public.routine_identity_witness DEFAULT VALUES')).rejects.toMatchObject({ code: '42501' });
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const)
        expect(await auditRuntimeBusinessPrivileges(peer.db, kind, target)).toMatchObject({ ready: true, failures: [] });
      await f.exec(`GRANT UPDATE(uid) ON public.routine_identity_witness TO "${app.role}"`);
      expect((await auditRuntimeBusinessPrivileges(app.db, 'app', target)).failures).toContain('routine_payment_runtime_catalog');
      await expect(runRoutinePaymentRuntimeInstallation(f.db, target)).rejects.toThrow('preflight refused');
    }));
  }, 60000);
});
