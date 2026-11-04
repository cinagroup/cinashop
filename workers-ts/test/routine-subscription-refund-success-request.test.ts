/** Candidate-writer and pure-codec units only. The catalog, LOGIN context and
 * completed public rows below are stubs, never real refund/provider evidence. */
import { createHmac } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { assertRoutineSubscriptionRefundSuccessDecision, captureRoutineSubscriptionRefundSuccessBusiness,
  captureRoutineSubscriptionRefundSuccessDecision, createRoutineSubscriptionRefundSuccessRequestTx,
  parseRoutineSubscriptionRefundSuccessRequest, type RoutineSubscriptionRefundSuccessBusiness,
  type RoutineSubscriptionRefundSuccessRequest } from '@/services/wechat/RoutineSubscriptionRefundSuccessRequest';

const catalog = vi.hoisted(() => vi.fn());
vi.mock('@/migrations/routineSubscriptionDelivery', () => ({ inspectRoutineSubscriptionDeliveryCatalog: catalog }));
const env = { APP_KEY: 'inert-refund-success-request-key' }, now = 1793602800;
const scope = { database: 'refund_success_fixture', databaseOid: '102', maintenance: 'refund_success_owner', maintenanceOid: '103' };
const actor = { role: 'refund_success_app', roleOid: '104' };
const business: RoutineSubscriptionRefundSuccessBusiness = { orderId: 17, orderNo: 'refund_business_71', refundId: 71, userId: 11, payPrice: '5.00' };
const raw = () => ({ eventKey: 'order.refund.success.notice:71', aggregateId: 17, payload: { ...business }, now });
const ready = () => ({ present: true, ready: true, failures: [], binding: { maintenance: scope.maintenance,
  maintenanceOid: scope.maintenanceOid, app: actor.role, appOid: actor.roleOid } });
const context = () => ({ ...scope, ...actor, now: String(now + 1), ready: true });
const claim = () => ({ cartIds: [{ cartId: 9, cartNum: 1 }], quantityReservation: { version: 'refund-quantity-reservation-v1',
  orderId: 17, uid: 11, items: [{ rowId: 91, cartId: 9, cartNum: 1, beforeRefundNum: 0, totalNum: 1 }] } });
const refund = () => ({ id: 71, storeOrderId: 17, orderId: business.orderNo, uid: 11, storeId: 0, supplierId: 0,
  applyType: 1, applyPrice: '5.00', refundNum: 1, refundPrice: '5.00', refundReason: '客户申请全额退款', refundExplain: '原申请说明',
  refundImg: null, cartInfo: JSON.stringify(claim()), addTime: now - 30,
  refundType: 6, refundedPrice: '5.00', refundedTime: now, isCancel: 0, isDel: 0 });
const source = () => ({ refund: refund(), order: { id: 17, orderNo: 'physical_paid_order_17', uid: 11, storeId: 0, supplierId: 0,
  payPrice: '5.00', paid: 1, payType: 'weixin', pid: 0, type: 0, totalNum: 1, refundStatus: 2, refundType: 6,
  refundPrice: '5.00', isDel: 0, isSystemDel: 0, hasChildren: false, hasOtherCompleted: false }, resolution: true });
function query() {
  let calls = 0;
  const execute = vi.fn(async (_query: unknown): Promise<unknown[]> => ++calls === 1 ? [context()] : [source()]);
  return { execute, tx: { execute } as unknown as Pick<DbClient, 'execute'> };
}
const message = '小程序原账号订阅通知批准、凭据或证据尚未完整就绪';
const unavailable = { kind: 'original', request: { format: 5, unavailable: true } };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
const mac = (domain: string, value: unknown, key = env.APP_KEY) => createHmac('sha256', key)
  .update('cinashop.routine.original-payment.subscription-' + domain + '.v1\0').update(canonical(value)).digest('hex');
function application() {
  const r = refund();
  return { id: r.id, storeOrderId: r.storeOrderId, orderId: r.orderId, uid: r.uid, storeId: r.storeId, supplierId: r.supplierId,
    applyType: r.applyType, applyPrice: r.applyPrice, refundNum: r.refundNum, refundPrice: r.refundPrice,
    refundReason: r.refundReason, refundExplain: r.refundExplain, refundImg: r.refundImg, cartInfo: r.cartInfo, addTime: r.addTime };
}
async function signed(): Promise<Readonly<RoutineSubscriptionRefundSuccessRequest>> {
  const result = await createRoutineSubscriptionRefundSuccessRequestTx(query().tx, env, raw());
  if (result.kind !== 'original' || 'unavailable' in result.request) throw Error('Missing explicit format5 candidate fixture');
  return result.request;
}
function resign(request: RoutineSubscriptionRefundSuccessRequest) {
  const { signature: _signature, ...body } = request;
  return { ...body, signature: mac('refund-success-notice-request', body) };
}

describe('format5 completed-refund public provenance and candidate writer', () => {
  beforeEach(() => { catalog.mockReset().mockResolvedValue(ready()); });

  it('binds the refund display number, original order amount and completed public decision in separate domains', async () => {
    const f = query(), result = await createRoutineSubscriptionRefundSuccessRequestTx(f.tx, env, raw());
    if (result.kind !== 'original' || 'unavailable' in result.request) throw Error('Expected signed candidate');
    const request = result.request;
    expect(request).toMatchObject({ format: 5, scope, actor, aggregateId: 17, eventKey: raw().eventKey, eventTime: now,
      body: business, decision: { refundType: 6, refundedTime: now, refundAmount: '5.00',
        applicationDigest: mac('refund-success-application', application()) }, createdAt: now + 1 });
    expect(request.body.orderNo).not.toBe(source().order.orderNo);
    const { signature, ...body } = request; expect(signature).toBe(mac('refund-success-notice-request', body));
    expect(parseRoutineSubscriptionRefundSuccessRequest(env, JSON.parse(JSON.stringify(request)), scope)).toEqual(request);
    expect(assertRoutineSubscriptionRefundSuccessDecision(env, request, refund())).toEqual(request.decision);
    expect(f.execute).toHaveBeenCalledTimes(2);
    const queries = f.execute.mock.calls.map(([q]) => new PgDialect().sqlToQuery(q as never).sql);
    expect(queries[0]).toContain('current_user=session_user');
    expect(queries[1]).toContain('FROM public.store_order_refund r JOIN public.store_order o');
    expect(queries[1]).toContain('LIMIT 2 FOR SHARE OF r,o NOWAIT');
    expect(queries[1]).toContain('prior.refund_type=6');
    for (const sql of queries) {
      expect(sql).not.toMatch(/pg_(?:try_)?advisory|set_config|\bGRANT\b|\bINSERT\s+INTO\b|\bUPDATE\b/u);
      expect(sql).not.toMatch(/FROM\s+(?:public\.)?(?:routine_original_payment_evidence|routine_identity_ownership|routine_subscription_account_policy|routine_refund_dispatch|routine_refund_provider_evidence)\b/u);
    }
    for (const value of [result, request, request.scope, request.actor, request.body, request.decision]) expect(Object.isFrozen(value)).toBe(true);
  });

  it('copies signing material and business primitives before asynchronous catalog work', async () => {
    let release!: (value: ReturnType<typeof ready>) => void;
    catalog.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const dto = raw(), mutable = { ...env }, pending = createRoutineSubscriptionRefundSuccessRequestTx(query().tx, mutable, dto);
    dto.payload.orderNo = 'another_refund'; dto.payload.refundId = 99; dto.payload.payPrice = '99.00'; dto.now = 1; mutable.APP_KEY = 'changed';
    release(ready()); const result = await pending;
    if (result.kind !== 'original' || 'unavailable' in result.request) throw Error('Captured candidate missing');
    expect(result.request.body).toEqual(business); expect(result.request.eventTime).toBe(now);
    expect(parseRoutineSubscriptionRefundSuccessRequest(env, result.request, scope)).toEqual(result.request);
    expect(() => parseRoutineSubscriptionRefundSuccessRequest(mutable, result.request, scope)).toThrow(message);
  });

  it('keeps only whole namespace absence legacy, without accessing writer or completed rows', async () => {
    catalog.mockResolvedValue({ present: false, ready: false, failures: [], binding: null }); const f = query();
    expect(await createRoutineSubscriptionRefundSuccessRequestTx(f.tx, undefined, raw())).toEqual({ kind: 'legacy' });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each([{ present: true, ready: false, failures: ['namespace'], binding: null },
    { present: true, ready: false, failures: ['acl'], binding: ready().binding },
    { present: true, ready: true, failures: [], binding: null }])('retains unavailable5 for a partial or drifted catalog %#', async value => {
    catalog.mockResolvedValue(value); const f = query();
    expect(await createRoutineSubscriptionRefundSuccessRequestTx(f.tx, env, raw())).toEqual(unavailable); expect(f.execute).not.toHaveBeenCalled();
  });

  it('never invokes a signing-key getter, borrows an inherited key, signs a guest or uses a root connection', async () => {
    let reads = 0; const f = query();
    for (const key of [undefined, {}, { APP_KEY: '' }, { APP_KEY: 'x'.repeat(8193) }, Object.create(env),
      { get APP_KEY() { reads++; return env.APP_KEY; } }])
      expect(await createRoutineSubscriptionRefundSuccessRequestTx(f.tx, key, raw())).toEqual(unavailable);
    expect(await createRoutineSubscriptionRefundSuccessRequestTx(f.tx, env, { ...raw(), payload: { ...business, userId: 0 } })).toEqual(unavailable);
    expect(await createRoutineSubscriptionRefundSuccessRequestTx({ ...f.tx, $client: {} } as unknown as DbClient, env, raw())).toEqual(unavailable);
    expect(reads).toBe(0); expect(f.execute).not.toHaveBeenCalled();
  });

  it('refuses an unqualified writer before reading public source rows, and propagates genuine SQL faults', async () => {
    const f = query(); f.execute.mockResolvedValueOnce([{ ...context(), ready: false }]);
    expect(await createRoutineSubscriptionRefundSuccessRequestTx(f.tx, env, raw())).toEqual(unavailable); expect(f.execute).toHaveBeenCalledTimes(1);
    const fault = Error('actual caller must roll back its savepoint'); catalog.mockRejectedValueOnce(fault);
    await expect(createRoutineSubscriptionRefundSuccessRequestTx(query().tx, env, raw())).rejects.toBe(fault);
    const writerFault = query(); writerFault.execute.mockRejectedValueOnce(fault);
    await expect(createRoutineSubscriptionRefundSuccessRequestTx(writerFault.tx, env, raw())).rejects.toBe(fault);
    const sourceFault = query(); sourceFault.execute.mockResolvedValueOnce([context()]).mockRejectedValueOnce(fault);
    await expect(createRoutineSubscriptionRefundSuccessRequestTx(sourceFault.tx, env, raw())).rejects.toBe(fault);
  });

  it.each([{ id: 18 }, { orderNo: '' }, { orderNo: 'x'.repeat(33) }, { uid: 12 }, { paid: 0 }, { payType: 'yue' },
    { payPrice: '6.00' }, { pid: -1 }, { pid: 9 }, { type: 3 }, { totalNum: 2 }, { refundStatus: 3 }, { refundType: 3 },
    { refundPrice: '2.00' }, { isDel: 1 }, { isSystemDel: 1 }, { hasChildren: true }, { hasOtherCompleted: true },
    { storeId: 2 }, { supplierId: 2 }])('does not extend the completed first full ordinary physical-order scope: %j', async patch => {
    const f = query(); f.execute.mockResolvedValueOnce([context()]).mockResolvedValueOnce([{ ...source(), order: { ...source().order, ...patch } }]);
    expect(await createRoutineSubscriptionRefundSuccessRequestTx(f.tx, env, raw())).toEqual(unavailable);
  });

  it.each([{ id: 72 }, { storeOrderId: 18 }, { orderId: source().order.orderNo }, { uid: 12 }, { applyPrice: '2.00' },
    { refundPrice: '2.00' }, { refundedPrice: '2.00' }, { refundedPrice: '0.00' }, { refundType: 0 }, { refundType: 3 },
    { refundedTime: now - 1 }, { isCancel: 1 }, { isDel: 1 }, { refundNum: 2 }, { addTime: now + 1 }])('keeps mismatched or incomplete public refunds unavailable5: %j', async patch => {
    const f = query(); f.execute.mockResolvedValueOnce([context()]).mockResolvedValueOnce([{ ...source(), refund: { ...refund(), ...patch } }]);
    expect(await createRoutineSubscriptionRefundSuccessRequestTx(f.tx, env, raw())).toEqual(unavailable);
  });

  it('refuses unversioned, partial, duplicate, cross-order and later-version quantity claims', async () => {
    const c = claim(), base = c.quantityReservation, item = base.items[0];
    const invalid = [null, '', '[]', '{broken', JSON.stringify({ cartIds: c.cartIds }),
      JSON.stringify({ ...c, quantityReservation: { ...base, version: 'refund-quantity-materialization-v2' } }),
      JSON.stringify({ ...c, quantityReservation: { ...base, version: 'refund-quantity-customer-row-v3' } }),
      JSON.stringify({ ...c, quantityReservation: { ...base, orderId: 18 } }),
      JSON.stringify({ ...c, quantityReservation: { ...base, uid: 12 } }),
      JSON.stringify({ ...c, quantityReservation: { ...base, items: [{ ...item, beforeRefundNum: 1 }] } }),
      JSON.stringify({ ...c, quantityReservation: { ...base, items: [{ ...item, totalNum: 2 }] } }),
      JSON.stringify({ ...c, cartIds: [...c.cartIds, ...c.cartIds], quantityReservation: { ...base, items: [...base.items, ...base.items] } }),
      JSON.stringify({ ...c, quantityReservation: { ...base, items: [{ ...item, cartId: 10 }] } })];
    for (const cartInfo of invalid) {
      const f = query(); f.execute.mockResolvedValueOnce([context()]).mockResolvedValueOnce([{ ...source(), refund: { ...refund(), cartInfo } }]);
      expect(await createRoutineSubscriptionRefundSuccessRequestTx(f.tx, env, raw())).toEqual(unavailable);
    }
  });

  it('rejects malformed DTO descriptors before SQL and accepts the separate 50-code-point refund-number bound', async () => {
    let calls = 0; const f = query(), getter = { ...business, get orderNo() { calls++; return business.orderNo; } };
    for (const payload of [getter, { ...business, extra: true }, { ...business, orderNo: 'x'.repeat(51) }, Object.create(business)])
      await expect(createRoutineSubscriptionRefundSuccessRequestTx(f.tx, env, { ...raw(), payload } as ReturnType<typeof raw>)).rejects.toThrow(message);
    for (const patch of [{ eventKey: 'order.refund.success.notice:071' }, { eventKey: 'order.refund.refused.notice:71' }, { aggregateId: 18 }, { now: 0 }])
      await expect(createRoutineSubscriptionRefundSuccessRequestTx(f.tx, env, { ...raw(), ...patch })).rejects.toThrow(message);
    expect(calls).toBe(0); expect(catalog).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
    expect(captureRoutineSubscriptionRefundSuccessBusiness({ ...business, orderNo: 'r'.repeat(50) }).orderNo).toHaveLength(50);
  });

  it('bounds selected primitive public fields without invoking getters, toJSON or inherited snapshots', async () => {
    let calls = 0; const getter = { ...refund(), get cartInfo() { calls++; return refund().cartInfo; } };
    for (const value of [getter, { ...refund(), cartInfo: { toJSON() { calls++; return refund().cartInfo; } } },
      { ...refund(), refundImg: '界'.repeat(90000) }, { ...refund(), cartInfo: 'x'.repeat(65537) }, Object.create(refund())]) {
      const f = query(); f.execute.mockResolvedValueOnce([context()]).mockResolvedValueOnce([{ ...source(), refund: value }]);
      expect(await createRoutineSubscriptionRefundSuccessRequestTx(f.tx, env, raw())).toEqual(unavailable);
    }
    expect(calls).toBe(0);
  });

  it('keeps unrelated mutable remarks outside the snapshot but matches application and completion fields exactly', async () => {
    const request = await signed();
    expect(assertRoutineSubscriptionRefundSuccessDecision(env, request, { ...refund(), remark: 'later public operator remark' })).toEqual(request.decision);
    for (const patch of [{ orderId: 'another_refund_number' }, { refundReason: 'changed' }, { refundExplain: 'changed' },
      { refundImg: '[]' }, { addTime: now - 20 }, { refundedTime: now + 1 }, { refundedPrice: '4.00' }])
      expect(() => assertRoutineSubscriptionRefundSuccessDecision(env, request, { ...refund(), ...patch })).toThrow(message);
    expect(captureRoutineSubscriptionRefundSuccessDecision(env, refund(), business, now)).toEqual(request.decision);
  });

  it('authenticates historical request5 without consulting current writer, policy or provider state', async () => {
    const request = await signed(); catalog.mockRejectedValue(Error('Historical parser must stay pure'));
    expect(parseRoutineSubscriptionRefundSuccessRequest(env, request, scope)).toEqual(request); expect(catalog).toHaveBeenCalledTimes(1);
    expect(() => parseRoutineSubscriptionRefundSuccessRequest(env, request, { ...scope, databaseOid: '999' })).toThrow(message);
    expect(() => parseRoutineSubscriptionRefundSuccessRequest({ APP_KEY: 'wrong' }, request, scope)).toThrow(message);
  });

  it('refuses other formats/domains and re-signed success contradictions without mutating caller-owned input', async () => {
    const request = await signed(), { signature: _signature, ...body } = request;
    for (const value of [{ format: 5, unavailable: true }, { ...request, format: 3 }, { ...request, extra: true },
      { ...request, signature: mac('refusal-notice-request', body) }, { ...request, eventKey: 'order.refund.success.notice:72' },
      resign({ ...request, decision: { ...request.decision, refundedTime: now + 1 } }),
      resign({ ...request, decision: { ...request.decision, refundAmount: '2.00' } }),
      resign({ ...request, actor: { role: scope.maintenance, roleOid: scope.maintenanceOid } })])
      expect(() => parseRoutineSubscriptionRefundSuccessRequest(env, value, scope)).toThrow(message);
    const raw = JSON.parse(JSON.stringify(request)) as RoutineSubscriptionRefundSuccessRequest;
    const parsed = parseRoutineSubscriptionRefundSuccessRequest(env, raw, scope); expect(parsed).not.toBe(raw); expect(Object.isFrozen(raw)).toBe(false);
    expect(parsed.body).not.toBe(raw.body); expect(parsed.decision).not.toBe(raw.decision);
    let calls = 0;
    expect(() => parseRoutineSubscriptionRefundSuccessRequest(env, { ...request, decision: { ...request.decision,
      get applicationDigest() { calls++; return request.decision.applicationDigest; } } }, scope)).toThrow(message);
    expect(calls).toBe(0);
  });
});
