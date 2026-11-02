/** Codec/candidate-writer units only. Catalog and SQL rows are explicit stubs,
 * not real LOGIN, refusal, committed producer, owner or provider evidence. */
import { createHmac } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { assertRoutineSubscriptionRefusalDecision, captureRoutineSubscriptionRefusalBusiness, captureRoutineSubscriptionRefusalDecision,
  createRoutineSubscriptionRefusalRequestTx, parseRoutineSubscriptionRefusalRequest,
  type RoutineSubscriptionRefusalRequest, type RefusalBusiness } from '@/services/wechat/RoutineSubscriptionRefusalRequest';

const catalog = vi.hoisted(() => vi.fn());
vi.mock('@/migrations/routineSubscriptionDelivery', () => ({ inspectRoutineSubscriptionDeliveryCatalog: catalog }));
const env = { APP_KEY: 'inert-refusal-request-key' }, now = 1793602800;
const scope = { database: 'refusal_fixture', databaseOid: '102', maintenance: 'refusal_owner', maintenanceOid: '103' };
const actor = { role: 'refusal_admin', roleOid: '104' };
const business: RefusalBusiness = { orderId: 17, orderNo: 'order_refusal_17', refundId: 71, userId: 11, payPrice: '5.00' };
const raw = () => ({ eventKey: 'order.refund.refused.notice:71', aggregateId: 17, payload: { ...business }, now });
const ready = () => ({ present: true, ready: true, failures: [], binding: { maintenance: scope.maintenance,
  maintenanceOid: scope.maintenanceOid, app: 'refusal_app', appOid: '105' } });
const context = () => ({ ...scope, ...actor, now: String(now + 1), ready: true });
const refund = () => ({ id: 71, storeOrderId: 17, orderId: 'refund_application_71', uid: 11, storeId: 0, supplierId: 0,
  applyType: 1, applyPrice: '2.00', refundNum: 1, refundPrice: '2.00', refundReason: '客户申请', refundExplain: '原申请说明',
  refundImg: null, cartInfo: '{"cartIds":[{"cartId":9,"cartNum":1}]}', addTime: now - 30,
  refundType: 3, refuseReason: '实际作者拒绝', refundedTime: now, isCancel: 0, isDel: 0 });
const source = () => ({ refund: refund(), order: { id: 17, orderNo: business.orderNo, uid: 11, storeId: 0, supplierId: 0,
  payPrice: business.payPrice, paid: 1, isDel: 0, isSystemDel: 0 }, resolution: true });
function mockQuery() {
  let count = 0;
  const execute = vi.fn(async (_query: unknown): Promise<unknown[]> => ++count === 1 ? [context()] : [source()]);
  return { execute, tx: { execute } as unknown as Pick<DbClient, 'execute'> };
}
const message = '小程序原账号订阅通知批准、凭据或证据尚未完整就绪';
const unavailable = { kind: 'original', request: { format: 3, unavailable: true } };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
function mac(domain: string, value: unknown, key = env.APP_KEY) {
  return createHmac('sha256', key).update('cinashop.routine.original-payment.subscription-' + domain + '.v1\0').update(canonical(value)).digest('hex');
}
function application() {
  const r = refund();
  return { id: r.id, storeOrderId: r.storeOrderId, orderId: r.orderId, uid: r.uid, storeId: r.storeId, supplierId: r.supplierId,
    applyType: r.applyType, applyPrice: r.applyPrice, refundNum: r.refundNum, refundPrice: r.refundPrice,
    refundReason: r.refundReason, refundExplain: r.refundExplain, refundImg: r.refundImg, cartInfo: r.cartInfo, addTime: r.addTime };
}
async function signed(): Promise<Readonly<RoutineSubscriptionRefusalRequest>> {
  const result = await createRoutineSubscriptionRefusalRequestTx(mockQuery().tx, env, raw());
  if (result.kind !== 'original' || 'unavailable' in result.request) throw Error('Missing explicit signed codec fixture'); return result.request;
}

describe('separate format3 refusal request and public decision snapshot', () => {
  beforeEach(() => { catalog.mockReset().mockResolvedValue(ready()); });

  it('independently MAC-binds the exact five business facts and a particular refusal application/reason/time', async () => {
    const { tx, execute } = mockQuery(), result = await createRoutineSubscriptionRefusalRequestTx(tx, env, raw());
    if (result.kind !== 'original' || 'unavailable' in result.request) throw Error('Expected signed structural candidate');
    const request = result.request;
    expect(request).toMatchObject({ format: 3, scope, actor, eventKey: raw().eventKey, aggregateId: 17,
      eventTime: now, body: business, createdAt: now + 1, decision: { refuseReason: '实际作者拒绝', refundedTime: now,
        applicationDigest: mac('refusal-application', application()) } });
    expect(request.requestId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    expect(Object.keys(request.body).sort()).toEqual(['orderId', 'orderNo', 'payPrice', 'refundId', 'userId']);
    const { signature, ...body } = request; expect(signature).toBe(mac('refusal-notice-request', body));
    expect(parseRoutineSubscriptionRefusalRequest(env, JSON.parse(JSON.stringify(request)), scope)).toEqual(request);
    expect(assertRoutineSubscriptionRefusalDecision(env, request, refund())).toEqual(request.decision);
    expect(execute).toHaveBeenCalledTimes(2);
    const queries = execute.mock.calls.map(([q]) => new PgDialect().sqlToQuery(q as never).sql);
    expect(queries[0]).toContain('current_user=session_user'); expect(queries[0]).toContain('r.rolinherit');
    expect(queries[1]).toContain('FROM public.store_order_refund r JOIN public.store_order o');
    expect(queries[1]).toContain('LIMIT 2 FOR SHARE OF r,o NOWAIT');
    for (const query of queries) {
      expect(query).not.toMatch(/pg_(?:try_)?advisory|set_config|\bGRANT\b|\bINSERT\s+INTO\b|\bUPDATE\b/u);
      expect(query).not.toMatch(/FROM\s+(?:public\.)?(?:routine_original_payment_evidence|routine_identity_ownership|routine_subscription_account_policy)\b/u);
    }
    for (const value of [result, request, request.scope, request.actor, request.body, request.decision]) expect(Object.isFrozen(value)).toBe(true);
  });

  it('copies DTO and primitive signing material before the first asynchronous catalog read', async () => {
    let release!: (v: ReturnType<typeof ready>) => void;
    catalog.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const dto = raw(), mutable = { ...env }, pending = createRoutineSubscriptionRefusalRequestTx(mockQuery().tx, mutable, dto);
    dto.payload.refundId = 99; dto.payload.payPrice = '99.00'; dto.now = 1; mutable.APP_KEY = 'changed';
    release(ready()); const result = await pending;
    if (result.kind !== 'original' || 'unavailable' in result.request) throw Error('Captured fixture not signed');
    expect(result.request.body).toEqual(business); expect(result.request.eventTime).toBe(now);
    expect(parseRoutineSubscriptionRefusalRequest(env, result.request, scope)).toEqual(result.request);
    expect(() => parseRoutineSubscriptionRefusalRequest(mutable, result.request, scope)).toThrow(message);
  });

  it('preserves whole-namespace absence as legacy without reading writer or public decision rows', async () => {
    catalog.mockResolvedValue({ present: false, ready: false, failures: [], binding: null }); const { tx, execute } = mockQuery();
    expect(await createRoutineSubscriptionRefusalRequestTx(tx, undefined, raw())).toEqual({ kind: 'legacy' }); expect(execute).not.toHaveBeenCalled();
  });

  it.each([{ present: true, ready: false, failures: ['namespace'], binding: null },
    { present: true, ready: false, failures: ['acl'], binding: ready().binding },
    { present: true, ready: true, failures: [], binding: null }])('keeps incomplete catalog %# unavailable3', async value => {
    catalog.mockResolvedValue(value); const { tx, execute } = mockQuery();
    expect(await createRoutineSubscriptionRefusalRequestTx(tx, env, raw())).toEqual(unavailable); expect(execute).not.toHaveBeenCalled();
  });

  it('never invokes an Env key getter, borrows an inherited key or signs a guest', async () => {
    let reads = 0; const { tx, execute } = mockQuery();
    for (const value of [undefined, {}, { APP_KEY: '' }, { APP_KEY: 'x'.repeat(8193) }, { get APP_KEY() { reads++; return env.APP_KEY; } }, Object.create(env)])
      expect(await createRoutineSubscriptionRefusalRequestTx(tx, value, raw())).toEqual(unavailable);
    expect(await createRoutineSubscriptionRefusalRequestTx(tx, env, { ...raw(), payload: { ...business, userId: 0 } })).toEqual(unavailable);
    expect(reads).toBe(0); expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a root connection or an invalid real-writer result before public decision reads', async () => {
    const { tx, execute } = mockQuery();
    expect(await createRoutineSubscriptionRefusalRequestTx({ ...tx, $client: {} } as unknown as DbClient, env, raw())).toEqual(unavailable);
    execute.mockResolvedValueOnce([{ ...context(), ready: false }]);
    expect(await createRoutineSubscriptionRefusalRequestTx(tx, env, raw())).toEqual(unavailable); expect(execute).toHaveBeenCalledTimes(1);
  });

  it('propagates genuine catalog, provenance and public-row SQL errors for a real caller SAVEPOINT', async () => {
    const fault = Error('explicit query transport failure'); catalog.mockRejectedValueOnce(fault);
    await expect(createRoutineSubscriptionRefusalRequestTx(mockQuery().tx, env, raw())).rejects.toBe(fault);
    const first = mockQuery(); first.execute.mockRejectedValueOnce(fault);
    await expect(createRoutineSubscriptionRefusalRequestTx(first.tx, env, raw())).rejects.toBe(fault);
    const second = mockQuery(); second.execute.mockResolvedValueOnce([context()]).mockRejectedValueOnce(fault);
    await expect(createRoutineSubscriptionRefusalRequestTx(second.tx, env, raw())).rejects.toBe(fault);
  });

  it.each(['missing', 'duplicate', 'wrong-order', 'wrong-uid', 'wrong-store', 'wrong-supplier', 'price', 'unpaid', 'deleted', 'shadow'] as const)
    ('refuses inconsistent real public-order result %# before signing', async kind => {
      const row = source();
      if (kind === 'wrong-order') row.order.orderNo = 'foreign_order';
      if (kind === 'wrong-uid') row.order.uid = 12;
      if (kind === 'wrong-store') row.order.storeId = 77;
      if (kind === 'wrong-supplier') row.order.supplierId = 8;
      if (kind === 'price') row.order.payPrice = '6.00';
      if (kind === 'unpaid') row.order.paid = 0;
      if (kind === 'deleted') row.order.isSystemDel = 1;
      if (kind === 'shadow') row.resolution = false;
      const { tx, execute } = mockQuery(); execute.mockResolvedValueOnce([context()]).mockResolvedValueOnce(kind === 'missing' ? [] : kind === 'duplicate' ? [row, row] : [row]);
      expect(await createRoutineSubscriptionRefusalRequestTx(tx, env, raw())).toEqual(unavailable);
    });

  it.each([{ refundType: 0 }, { refundType: 6 }, { isCancel: 1 }, { isDel: 1 }, { uid: 12 }, { id: 72 }, { storeOrderId: 18 },
    { refusedTime: now, refundedTime: now - 1 }, { refuseReason: '' }, { refuseReason: ' not normalized ' }])
    ('refuses a nonmatching refusal decision %#', async patch => {
      const { tx, execute } = mockQuery(); execute.mockResolvedValueOnce([context()]).mockResolvedValueOnce([{ ...source(), refund: { ...refund(), ...patch } }]);
      expect(await createRoutineSubscriptionRefusalRequestTx(tx, env, raw())).toEqual(unavailable);
    });

  it('rejects raw/body getters, symbols, foreign fields, noncanonical IDs and amount formats before catalog I/O', async () => {
    let reads = 0; const getter = { ...business, get payPrice() { reads++; return '5.00'; } };
    const bad = [getter, { ...business, routineAppId: 'foreign' }, { ...business, reason: 'not an old body field' },
      { ...business, [Symbol('foreign')]: true }, { ...business, orderNo: '\ud800' }, { ...business, payPrice: '5' },
      { ...business, payPrice: '05.00' }, { ...business, payPrice: '5.001' }, { ...business, refundId: 0 }];
    const { tx, execute } = mockQuery();
    for (const payload of bad) await expect(createRoutineSubscriptionRefusalRequestTx(tx, env, { ...raw(), payload } as unknown as ReturnType<typeof raw>)).rejects.toThrow(message);
    for (const patch of [{ eventKey: 'order.refund.refused.notice:071' }, { eventKey: 'order.delivery.notice:71' }, { aggregateId: 18 }, { now: 0 }])
      await expect(createRoutineSubscriptionRefusalRequestTx(tx, env, { ...raw(), ...patch })).rejects.toThrow(message);
    expect(reads).toBe(0); expect(catalog).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it('bounds public primitive snapshots without serializing getters, nested JSON or prototypes', async () => {
    let reads = 0; const getter = { ...refund(), get cartInfo() { reads++; return 'unexpected'; } };
    for (const row of [getter, { ...refund(), cartInfo: { toJSON() { reads++; return 'unexpected'; } } },
      { ...refund(), refundImg: '界'.repeat(90000) }, { ...refund(), cartInfo: 'x'.repeat(65537) }, Object.create(refund())]) {
      const { tx, execute } = mockQuery(); execute.mockResolvedValueOnce([context()]).mockResolvedValueOnce([{ ...source(), refund: row }]);
      expect(await createRoutineSubscriptionRefusalRequestTx(tx, env, raw())).toEqual(unavailable);
    }
    expect(reads).toBe(0);
  });

  it('fresh-matches the old application and decision, while unrelated remarks or a new current hold do not reinterpret it', async () => {
    const request = await signed();
    const row = { ...refund(), remark: 'mutable operator remark', currentHold: 99 };
    expect(assertRoutineSubscriptionRefusalDecision(env, request, row)).toEqual(request.decision);
    row.remark = 'another later remark'; row.currentHold = 0;
    expect(assertRoutineSubscriptionRefusalDecision(env, request, row)).toEqual(request.decision);
    for (const patch of [{ orderId: 'new_application' }, { applyPrice: '1.00' }, { refundPrice: '1.00' }, { refundNum: 2 },
      { refundReason: 'changed' }, { refundExplain: 'changed' }, { refundImg: '[]' }, { cartInfo: '[]' }, { addTime: now - 20 },
      { refuseReason: 'changed' }, { refundedTime: now + 1 }, { refundType: 0 }, { isCancel: 1 }])
      expect(() => assertRoutineSubscriptionRefusalDecision(env, request, { ...refund(), ...patch })).toThrow(message);
  });

  it('parses historical authenticated provenance without catalog or current-writer liveness checks', async () => {
    const request = await signed(); catalog.mockRejectedValue(Error('Parser must not consult current writer'));
    expect(parseRoutineSubscriptionRefusalRequest(env, JSON.parse(JSON.stringify(request)), scope)).toEqual(request); expect(catalog).toHaveBeenCalledTimes(1);
    expect(captureRoutineSubscriptionRefusalBusiness(business)).toEqual(business);
    expect(captureRoutineSubscriptionRefusalDecision(env, refund(), business, now)).toEqual(request.decision);
  });

  it('rejects format2, unavailable3, wrong domain/key/scope and altered signed decision/event facts', async () => {
    const request = await signed(), { signature: _signature, ...body } = request;
    for (const value of [{ format: 3, unavailable: true }, { ...request, format: 2 }, { ...request, extra: true },
      { ...request, signature: mac('notice-request', body) }, { ...request, signature: '0'.repeat(64) },
      { ...request, decision: { ...request.decision, refuseReason: 'changed' } },
      { ...request, decision: { ...request.decision, refundedTime: now + 1 } },
      { ...request, decision: { ...request.decision, applicationDigest: 'a'.repeat(64) } }, { ...request, eventKey: 'order.refund.refused.notice:72' }])
      expect(() => parseRoutineSubscriptionRefusalRequest(env, value, scope)).toThrow(message);
    expect(() => parseRoutineSubscriptionRefusalRequest({ APP_KEY: 'wrong-key' }, request, scope)).toThrow(message);
    expect(() => parseRoutineSubscriptionRefusalRequest(env, request, { ...scope, databaseOid: '999' })).toThrow(message);
    let reads = 0;
    expect(() => parseRoutineSubscriptionRefusalRequest(env, { ...request, decision: { ...request.decision, get applicationDigest() { reads++; return request.decision.applicationDigest; } } }, scope)).toThrow(message);
    expect(reads).toBe(0);
  });
});
