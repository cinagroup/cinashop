import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlinePredecessorSchemaSql } from './helpers/offlinePredecessorSchema';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { memberRight, otherOrder, paymentReconciliationCase, systemConfig, user } from '../src/models/schema';
import { offlineOrderQueryEvidence } from '../src/models/candidates/offline_order_query_evidence';
import { offlineOrderExternalPayment } from '../src/models/candidates/offline_order_external_payment';
import { OFFLINE_ORDER_ADMISSION_SQL } from '../src/migrations/offlineOrderAdmission';
import { OFFLINE_ORDER_PAYMENT_SELECTION_SQL } from '../src/migrations/offlineOrderPaymentSelection';
import { OFFLINE_ORDER_BALANCE_SQL } from '../src/migrations/offlineOrderBalance';
import { OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL } from '../src/migrations/offlineOrderExternalPayment';
import { OFFLINE_ORDER_CALLBACK_DOMAIN_SQL } from '../src/migrations/offlineOrderCallbackDomain';
import { admitOfflineOrder } from '../src/services/order/OfflineOrderAdmissionService';
import { selectOfflineOrderExternalPayment } from '../src/services/order/OfflineOrderPaymentSelectionService';
import { queryOfflineOrderPayment } from '../src/services/order/OfflineOrderPaymentQueryService';
import { persistOfflineQueryEvidence } from '../src/services/order/OfflineOrderQueryEvidenceService';
import * as settlement from '../src/services/order/OfflineOrderExternalPaymentService';
import { PaymentCallbackEventService } from '../src/services/payment/PaymentCallbackEventService';
import { PaymentReconciliationService } from '../src/services/payment/PaymentReconciliationService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { paymentQueryFixture, paymentQueryKeys } from './helpers/paymentQueryFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

// Real PG and real query crypto; provider transport/config KV are local fixtures.
// Interleaved callbacks below are trusted decoded fixtures; the companion signed
// HTTP suite verifies their actual ingress separately, not replaced by this test.
describe('offline durable query collection and recovery on isolated native PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string, keys: ReturnType<typeof paymentQueryKeys>;
  type Runtime = SequenceRunnerPeer & { role: string };
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 required');
    ddl = await offlinePredecessorSchemaSql(); keys = paymentQueryKeys();
  }, 60_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unstubbed external I/O forbidden'));
    f = await sequenceRunnerDatabase();
    await f.db.transaction(async tx => {
      for (const source of [ddl, OFFLINE_ORDER_ADMISSION_SQL, OFFLINE_ORDER_PAYMENT_SELECTION_SQL, OFFLINE_ORDER_BALANCE_SQL,
        OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL, OFFLINE_ORDER_CALLBACK_DOMAIN_SQL]) await tx.execute(sql.raw(source));
    });
    await f.db.insert(user).values({ uid: 11, account: 'query-recovery-buyer', nowMoney: '100.00', integral: 50, isEverLevel: 1 });
    await f.db.insert(systemConfig).values([{ menuName: 'member_card_status', value: '1' }, { menuName: 'order_give_integral', value: '1.234567' }]);
    await f.db.insert(memberRight).values([{ rightType: 'offline', number: 80, status: 1 }, { rightType: 'integral', number: 2, status: 1 }]);
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const runtime = <T>(work: (r: Runtime) => Promise<T>) => f.withRuntimeRole!(async r => {
    await f.exec(`GRANT SELECT ON "user",system_config,member_right,wechat_user,other_order,other_order_status,
      offline_order_admission,offline_order_payment_selection,offline_order_external_payment,offline_order_callback_binding,
      offline_order_query_evidence,store_order,user_recharge,user_money,user_bill,store_order_economize,
      payment_callback_event,payment_callback_outbox,payment_reconciliation_case TO "${r.role}";
      GRANT UPDATE(uid,integral,is_promoter) ON "user" TO "${r.role}";
      GRANT UPDATE(id,paid,pay_type,pay_time,trade_no) ON other_order TO "${r.role}";
      GRANT EXECUTE ON FUNCTION public.ooa_lock_pricing() TO "${r.role}";
      GRANT INSERT ON other_order,other_order_status,offline_order_admission,offline_order_payment_selection,
        offline_order_external_payment,offline_order_callback_binding,offline_order_query_evidence,user_bill,store_order_economize TO "${r.role}";
      GRANT INSERT,UPDATE ON payment_callback_event,payment_callback_outbox,payment_reconciliation_case TO "${r.role}";
      GRANT USAGE ON SEQUENCE other_order_id_seq,user_bill_id_seq,store_order_economize_id_seq,
        payment_callback_event_id_seq,payment_callback_outbox_id_seq,payment_reconciliation_case_id_seq TO "${r.role}"`);
    const [role] = await r.exec(`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    return work(r);
  });
  const create = async (r: Runtime, rail: 'wechat' | 'alipay' = 'wechat', letter = 'a') => {
    const container = createContainerFromDb(r.db), api = await paymentQueryFixture(container, keys);
    const request = { ...api.request(rail), orderNo: 'xx' + letter.repeat(30) };
    await admitOfflineOrder(container, { uid: 11, requestKey: crypto.randomUUID(), orderNo: request.orderNo,
      money: '12.50', expectedPayPrice: '10.00', from: 'h5' });
    await selectOfflineOrderExternalPayment(container, { uid: 11, orderNo: request.orderNo,
      identity: { provider: rail, profile: rail, appId: api.identity(rail).appId, merchantId: api.identity(rail).merchantId } });
    const recovery = new PaymentReconciliationService(container, api.env), callback = new PaymentCallbackEventService(container, api.env);
    const row = await recovery.registerIntent(request), reference = { caseId: row.id, replayKey: row.replayKey };
    const message = { ...reference, action: 'processPaymentReconciliation' as const };
    const response = (extra: Record<string, unknown> = {}) => rail === 'wechat'
      ? api.wechatResponse(api.wxBody({ out_trade_no: request.orderNo, trade_type: 'MWEB', ...extra }))
      : api.alipayResponse(api.aliBody({ out_trade_no: request.orderNo, ...extra }));
    const due = async () => { await f.db.update(paymentReconciliationCase).set({ nextCheckTime: 0, leaseUntil: 0, leaseToken: '' })
      .where(eq(paymentReconciliationCase.id, row.id)); };
    const query = () => queryOfflineOrderPayment(container, api.env, request);
    const persist = async () => persistOfflineQueryEvidence(container, { reference, request, queried: await query() });
    const notify = (transactionId = rail === 'wechat' ? 'wechat_query_transaction' : 'alipay_query_transaction', orderNo = request.orderNo) => callback.receive({
      provider: rail, profile: rail, providerEventId: crypto.randomUUID(), orderNo, transactionId,
      tradeState: rail === 'wechat' ? 'SUCCESS' : 'TRADE_SUCCESS', amountCents: 1000, currency: 'CNY', providerEventTime: 1789790400,
    }, { appId: api.identity(rail).appId, merchantId: api.identity(rail).merchantId });
    return { container, api, request, reference, message, response, recovery, callback, due, query, persist, notify };
  };
  const counts = async () => (await f.query(`SELECT
    (SELECT count(*)::integer FROM offline_order_query_evidence) AS queries,
    (SELECT count(*)::integer FROM offline_order_external_payment) AS receipts,
    (SELECT count(*)::integer FROM payment_callback_event) AS callbacks,
    (SELECT count(*)::integer FROM payment_callback_outbox) AS outboxes,
    (SELECT count(*)::integer FROM user_money) AS money,
    (SELECT count(*)::integer FROM user_bill) AS bills,
    (SELECT count(*)::integer FROM store_order_economize) AS savings`)).rows[0];
  const paid = async (queries = 1, callbacks = 0) => {
    expect(await counts()).toEqual({ queries, receipts: 1, callbacks, outboxes: callbacks, money: 0, bills: 1, savings: 1 });
    expect((await f.db.select().from(user))[0]).toMatchObject({ nowMoney: '100.00', integral: 64, isEverLevel: 1, overdueTime: 0 });
    expect((await f.db.select().from(otherOrder))[0]).toMatchObject({ type: 3, paid: 1 });
  };
  it.each(['wechat', 'alipay'] as const)('%s no-callback recovery queries, commits separate evidence and settles once', async rail => {
    await runtime(async r => {
      const t = await create(r, rail); await t.due();
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (typeof url !== 'string' || !init) throw Error('Unexpected request'); expect(t.api.verifyRequest(url, init)).toBe(true);
        expect((await f.query(`SELECT state,xact_start IS NULL AS ended FROM pg_stat_activity WHERE pid=${r.pid}`)).rows)
          .toEqual([{ state: 'idle', ended: true }]);
        return t.response();
      });
      expect(await t.recovery.processMessage(t.message)).toBe('settled'); await paid();
      const [receipt] = await f.db.select().from(offlineOrderExternalPayment), [evidence] = await f.db.select().from(offlineOrderQueryEvidence);
      expect(receipt.eventId).toBeNull(); expect(receipt.queryId).toBe(evidence.id);
      expect(evidence.identitySource).toBe(rail === 'wechat' ? 'wechat-signed-query' : 'alipay-direct-request-scope');
      expect(JSON.stringify(evidence)).not.toContain(t.api.identity().payerId);
      expect(JSON.stringify(evidence)).not.toContain(t.api.identity(rail).appId);
      expect(await t.recovery.processMessage(t.message)).toBe('already-terminal'); expect(fetch).toHaveBeenCalledOnce();
    });
  });
  it.each([false, true])('recovers committed query proof without current credentials (financially committed=%s)', async committed => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockResolvedValueOnce(t.response()); const ref = await t.persist();
      if (committed) await settlement.settleOfflineOrderQueryPayment(t.container, ref);
      t.api.config.cfg_pay_weixin_mchid = '9999999999'; await t.due(); vi.mocked(fetch).mockClear();
      expect(await t.recovery.processMessage(t.message)).toBe(committed ? 'confirmed' : 'settled');
      expect(fetch).not.toHaveBeenCalled(); await paid();
    });
  });
  it('uses durable proof after a financial commit followed by a thrown completion error', async () => {
    await runtime(async r => {
      const t = await create(r); await t.due(); vi.mocked(fetch).mockResolvedValueOnce(t.response());
      const original = settlement.settleOfflineOrderQueryPayment;
      vi.spyOn(settlement, 'settleOfflineOrderQueryPayment').mockImplementationOnce(async (...args) => {
        await original(...args); throw Error('injected_after_financial_commit');
      });
      expect(await t.recovery.processMessage(t.message)).toBe('unknown'); await paid();
      expect((await f.db.select().from(paymentReconciliationCase))[0].providerTransactionId).toBe('wechat_query_transaction');
      await t.due();
      expect(await t.recovery.processMessage(t.message)).toBe('confirmed'); await paid(); expect(fetch).toHaveBeenCalledOnce();
    });
  });
  it('does not erase a late conflict after financial commit and before recovery completion', async () => {
    await runtime(async r => {
      const t = await create(r); await t.due(); vi.mocked(fetch).mockResolvedValueOnce(t.response());
      const original = settlement.settleOfflineOrderQueryPayment;
      vi.spyOn(settlement, 'settleOfflineOrderQueryPayment').mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        expect((await t.notify('late_different_transaction')).terminalConflict).toBe(true);
        return result;
      });
      expect(await t.recovery.processMessage(t.message)).toBe('conflict');
      expect((await f.db.select().from(paymentReconciliationCase))[0].status).toBe('CONFLICT');
      await paid(1, 1); expect(await t.recovery.processMessage(t.message)).toBe('already-terminal');
      expect(fetch).toHaveBeenCalledOnce();
    });
  });
  it.each(['no-intent', 'proof-permission'] as const)('fails closed before network I/O when %s is missing', async missing => {
    await runtime(async r => {
      const t = await create(r); await t.due();
      if (missing === 'no-intent') await f.db.update(paymentReconciliationCase).set({ initiatedTime: 0 });
      else await f.exec(`REVOKE SELECT ON offline_order_query_evidence FROM "${r.role}"`);
      expect(await t.recovery.processMessage(t.message)).toBe('unknown'); expect(fetch).not.toHaveBeenCalled();
      expect(await counts()).toMatchObject({ queries: 0, callbacks: 0, receipts: 0, bills: 0 });
    });
  });
  it('deduplicates repeated queries without creating fake callback/outbox rows', async () => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockImplementation(async () => t.response());
      const first = await t.persist(), second = await t.persist(); expect(second).toEqual(first);
      expect(await counts()).toMatchObject({ queries: 1, callbacks: 0, outboxes: 0, receipts: 0 });
    });
  });
  it.each(['query-first', 'callback-first'] as const)('%s retains the first receipt and all effects when the other source arrives', async order => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockResolvedValueOnce(t.response()); const q = await t.persist(), cb = await t.notify();
      if (order === 'query-first') await settlement.settleOfflineOrderQueryPayment(t.container, q);
      else await settlement.settleOfflineOrderExternalPayment(t.container, cb);
      const before = await f.db.select().from(offlineOrderExternalPayment);
      const next = order === 'query-first' ? await settlement.settleOfflineOrderExternalPayment(t.container, cb)
        : await settlement.settleOfflineOrderQueryPayment(t.container, q);
      expect(next.replayed).toBe(true); expect(await f.db.select().from(offlineOrderExternalPayment)).toEqual(before); await paid(1, 1);
    });
  });
  it('serializes callback/query settlement on independent backends and rewards only once', async () => {
    await runtime(async a => runtime(async b => f.withPeer!(async holder => {
      const t = await create(a); vi.mocked(fetch).mockResolvedValueOnce(t.response()); const q = await t.persist(), cb = await t.notify();
      await holder.exec('BEGIN'); await holder.exec('SELECT id FROM other_order FOR UPDATE');
      const first = outcome(settlement.settleOfflineOrderQueryPayment(t.container, q)); let second: Promise<unknown> | undefined, released = false;
      try {
        await waitForFinanceBlock(f.db, a.pid, holder.pid);
        const next = outcome(settlement.settleOfflineOrderExternalPayment(createContainerFromDb(b.db), cb)); second = next;
        await waitForFinanceBlock(f.db, b.pid, a.pid); await holder.exec('COMMIT'); released = true;
        const results = await Promise.all([first, next]); expect(results.every(row => row.ok)).toBe(true);
        expect(results.filter(row => row.ok && !row.value.replayed)).toHaveLength(1); await paid(1, 1);
      } finally { if (!released) await holder.exec('ROLLBACK'); await first; await second; }
    })));
  });
  it('serializes two query settlers on independent backends and retains one receipt', async () => {
    await runtime(async a => runtime(async b => f.withPeer!(async holder => {
      const t = await create(a); vi.mocked(fetch).mockResolvedValueOnce(t.response()); const q = await t.persist();
      await holder.exec('BEGIN'); await holder.exec('SELECT id FROM other_order FOR UPDATE');
      const first = outcome(settlement.settleOfflineOrderQueryPayment(t.container, q)); let second: Promise<unknown> | undefined, released = false;
      try {
        await waitForFinanceBlock(f.db, a.pid, holder.pid);
        const next = outcome(settlement.settleOfflineOrderQueryPayment(createContainerFromDb(b.db), q)); second = next;
        await waitForFinanceBlock(f.db, b.pid, a.pid); await holder.exec('COMMIT'); released = true;
        const results = await Promise.all([first, next]); expect(results.every(row => row.ok)).toBe(true);
        expect(results.filter(row => row.ok && !row.value.replayed)).toHaveLength(1); await paid();
      } finally { if (!released) await holder.exec('ROLLBACK'); await first; await second; }
    })));
  });
  it.each(['query-first', 'callback-first'] as const)('%s preserves one-order/two-transaction conflict without settlement', async order => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockImplementation(async () => t.response());
      if (order === 'query-first') { await t.persist(); expect((await t.notify('different_transaction')).terminalConflict).toBe(true); }
      else { await t.notify('different_transaction'); expect((await t.persist()).terminalConflict).toBe(true); }
      expect((await f.db.select().from(paymentReconciliationCase))[0].status).toBe('CONFLICT');
      expect(await counts()).toMatchObject({ queries: 1, callbacks: 1, receipts: 0, bills: 0 });
      const [q] = await f.db.select().from(offlineOrderQueryEvidence);
      await expect(settlement.settleOfflineOrderQueryPayment(t.container, { queryId: q.id, replayKey: q.replayKey })).rejects.toThrow('冲突');
    });
  });
  it.each(['query-first', 'callback-first'] as const)('%s detects one transaction claimed by two orders across both sources', async order => {
    await runtime(async r => {
      const first = await create(r), second = await create(r, 'wechat', 'b');
      vi.mocked(fetch).mockImplementation(async () => first.response());
      if (order === 'query-first') { await first.persist(); expect((await second.notify()).terminalConflict).toBe(true); }
      else { await second.notify(); expect((await first.persist()).terminalConflict).toBe(true); }
      expect(await counts()).toMatchObject({ queries: 1, receipts: 0, callbacks: 1, bills: 0 });
      const [q] = await f.db.select().from(offlineOrderQueryEvidence);
      await expect(settlement.settleOfflineOrderQueryPayment(first.container, { queryId: q.id, replayKey: q.replayKey })).rejects.toThrow('冲突');
    });
  });
  it.each(['proof-insert', 'receipt-insert', 'bill-insert', 'order-update'] as const)('%s failure cannot partially settle and committed proof remains recoverable', async failure => {
    await runtime(async r => {
      const t = await create(r); await t.due(); vi.mocked(fetch).mockImplementation(async () => t.response());
      const revoke = failure === 'proof-insert' ? 'INSERT ON offline_order_query_evidence'
        : failure === 'receipt-insert' ? 'INSERT ON offline_order_external_payment'
          : failure === 'bill-insert' ? 'INSERT ON user_bill' : 'UPDATE(paid,pay_type,pay_time,trade_no) ON other_order';
      await f.exec(`REVOKE ${revoke} FROM "${r.role}"`);
      expect(await t.recovery.processMessage(t.message)).toBe('unknown');
      expect(await counts()).toMatchObject({ queries: failure === 'proof-insert' ? 0 : 1, receipts: 0, bills: 0, savings: 0 });
      expect((await f.db.select().from(paymentReconciliationCase))[0].providerTransactionId)
        .toBe(failure === 'proof-insert' ? '' : 'wechat_query_transaction');
      expect((await f.db.select().from(user))[0].integral).toBe(50);
      expect((await f.db.select().from(otherOrder))[0].paid).toBe(0);
      await f.exec(`GRANT ${revoke} TO "${r.role}"`); await t.due();
      expect(await t.recovery.processMessage(t.message)).toBe('settled'); await paid();
      expect(fetch).toHaveBeenCalledTimes(failure === 'proof-insert' ? 2 : 1);
    });
  });
  it.each(['NOTPAY', 'CLOSED', 'REFUND', 'NOT_FOUND'] as const)('keeps %s non-success out of financial evidence and never guesses no-payment', async state => {
    await runtime(async r => {
      const t = await create(r); await t.due();
      await f.db.update(paymentReconciliationCase).set({ initiatedTime: 1, attemptCount: 3 });
      vi.mocked(fetch).mockResolvedValueOnce(state === 'NOT_FOUND' ? t.api.wechatResponse({ code: 'ORDER_NOT_EXIST' }, 404) : t.response({ trade_state: state }));
      expect(await t.recovery.processMessage(t.message)).toBe(state === 'NOTPAY' ? 'waiting' : 'unknown');
      expect(await counts()).toMatchObject({ queries: 0, receipts: 0, callbacks: 0 });
    });
  });
  it('retains signed proof after an operator closes the case during query, without settling or erasing CLOSED', async () => {
    await runtime(async r => {
      const t = await create(r); await t.due();
      vi.mocked(fetch).mockImplementationOnce(async () => {
        await f.db.update(paymentReconciliationCase).set({ status: 'CLOSED' }).where(eq(paymentReconciliationCase.id, t.reference.caseId));
        return t.response();
      });
      expect(await t.recovery.processMessage(t.message)).toBe('already-terminal');
      expect(await counts()).toMatchObject({ queries: 1, receipts: 0 });
      expect((await f.db.select().from(paymentReconciliationCase))[0].status).toBe('CLOSED');
    });
  });
  it.each(['identity', 'source', 'selection', 'case-key'] as const)('rejects a malformed trusted projection %s with the registration transaction rolled back', async field => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockResolvedValueOnce(t.response()); const queried = await t.query();
      if (field === 'identity' && queried.result.identityEvidence) queried.result.identityEvidence.appId = 'wrong-app';
      if (field === 'source') queried.result.identityEvidence = { source: 'alipay-direct-request-scope', appId: 'wrong', merchantId: 'wrong' };
      if (field === 'selection') queried.selectionKey = crypto.randomUUID();
      const before = await f.db.select().from(paymentReconciliationCase);
      await expect(persistOfflineQueryEvidence(t.container, { request: t.request, queried,
        reference: { ...t.reference, ...(field === 'case-key' ? { replayKey: crypto.randomUUID() } : {}) } })).rejects.toThrow();
      expect(await f.db.select().from(paymentReconciliationCase)).toEqual(before); expect(await counts()).toMatchObject({ queries: 0, receipts: 0 });
    });
  });
  it.each(['UPDATE', 'DELETE', 'TRUNCATE'] as const)('DDL rejects %s of query evidence even by the fixture owner', async command => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockResolvedValueOnce(t.response()); await t.persist();
      const statement = command === 'UPDATE' ? "UPDATE offline_order_query_evidence SET identity_source='alipay-direct-request-scope'"
        : command === 'DELETE' ? 'DELETE FROM offline_order_query_evidence' : 'TRUNCATE offline_order_query_evidence CASCADE';
      await expect(f.exec(statement)).rejects.toThrow(); expect(await counts()).toMatchObject({ queries: 1, receipts: 0 });
    });
  });
  it.each(['missing', 'wrong-key'] as const)('rejects %s opaque query references without effects', async invalid => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockResolvedValueOnce(t.response()); const ref = await t.persist();
      await expect(settlement.settleOfflineOrderQueryPayment(t.container, {
        queryId: invalid === 'missing' ? crypto.randomUUID() : ref.queryId,
        replayKey: invalid === 'wrong-key' ? crypto.randomUUID() : ref.replayKey,
      })).rejects.toThrow('引用不存在');
      expect(await counts()).toMatchObject({ queries: 1, receipts: 0, bills: 0 });
    });
  });
  it.each(['neither', 'both'] as const)('database CHECK rejects a receipt with %s evidence sources independently of the trigger', async sources => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockResolvedValueOnce(t.response()); const q = await t.persist(), cb = await t.notify();
      await settlement.settleOfflineOrderQueryPayment(t.container, q);
      // Maintenance-only fault injection inside the owned random fixture DB;
      // the rejected transaction also rolls back its trigger disable.
      const change = f.db.transaction(async tx => {
        await tx.execute(sql`ALTER TABLE offline_order_external_payment DISABLE TRIGGER ooep_change_guard`);
        await tx.execute(sources === 'neither'
          ? sql`UPDATE offline_order_external_payment SET query_id=NULL`
          : sql`UPDATE offline_order_external_payment SET event_id=${cb.eventId}`);
      });
      await expect(change).rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'ooep_source_ck' } }); await paid(1, 1);
      const [receipt] = await f.db.select().from(offlineOrderExternalPayment);
      expect(receipt.eventId).toBeNull(); expect(receipt.queryId).toBe(q.queryId);
    });
  });
  it('rejects evidence whose maintenance-corrupted digest no longer matches, before any effect', async () => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockResolvedValueOnce(t.response()); const ref = await t.persist();
      await f.exec("ALTER TABLE offline_order_query_evidence DISABLE TRIGGER ooqe_change_guard; UPDATE offline_order_query_evidence SET identity_hash=repeat('0',64); ALTER TABLE offline_order_query_evidence ENABLE TRIGGER ooqe_change_guard");
      await expect(settlement.settleOfflineOrderQueryPayment(t.container, ref)).rejects.toThrow('摘要');
      expect(await counts()).toMatchObject({ queries: 1, receipts: 0, bills: 0 });
    });
  });
});
