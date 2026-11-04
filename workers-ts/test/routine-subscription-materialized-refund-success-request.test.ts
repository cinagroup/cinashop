/** Pure candidate/codec units. Catalog, LOGIN and materialization sources are
 * controlled stubs; these units establish neither provider refund nor send authority. */
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { assertRoutineSubscriptionMaterializedRefundSuccessDecision, captureRoutineSubscriptionMaterializedRefundSuccessBusiness,
  captureRoutineSubscriptionMaterializedRefundSuccessDecision, createRoutineSubscriptionMaterializedRefundSuccessRequestTx,
  parseRoutineSubscriptionMaterializedRefundSuccessRequest, type RoutineSubscriptionMaterializedRefundSuccessBusiness,
  type RoutineSubscriptionMaterializedRefundSuccessRequest } from '@/services/wechat/RoutineSubscriptionMaterializedRefundSuccessRequest';
import { parseRoutineSubscriptionRefundSuccessRequest } from '@/services/wechat/RoutineSubscriptionRefundSuccessEvidenceCodec';

const mocks = vi.hoisted(() => ({ catalog: vi.fn(), source: vi.fn() }));
vi.mock('@/migrations/routineSubscriptionDelivery', () => ({ inspectRoutineSubscriptionDeliveryCatalog: mocks.catalog }));
vi.mock('@/services/wechat/RoutineSubscriptionMaterializedRefundSource', () => ({ readRoutineMaterializedRefundSuccessSourceTx: mocks.source }));
const env = { APP_KEY: 'inert-materialized-refund-success-request-key' }, now = 1793602800;
const scope = { database: 'materialized_success_fixture', databaseOid: '102', maintenance: 'materialized_success_owner', maintenanceOid: '103' };
const actor = { role: 'materialized_success_app', roleOid: '104' };
const business: RoutineSubscriptionMaterializedRefundSuccessBusiness = { orderId: 27, orderNo: 'refund_business_71', refundId: 71,
  userId: 11, payPrice: '5.00', materializedRefund: { sourceOrderId: 17, paymentOrderId: 7, refundAmount: '3.00' } };
const raw = () => ({ eventKey: 'order.refund.success.notice:71', aggregateId: 27,
  payload: { ...business, materializedRefund: { ...business.materializedRefund } }, now });
const proof = () => ({ materializationDigest: 'a'.repeat(64), selectedDigest: 'b'.repeat(64) });
const ready = () => ({ present: true, ready: true, failures: [], binding: { maintenance: scope.maintenance,
  maintenanceOid: scope.maintenanceOid, app: actor.role, appOid: actor.roleOid } });
const context = () => ({ ...scope, ...actor, now: String(now + 1), ready: true });
function claim(row = false) {
  const id = row ? 91 : 9, namespace = row ? { sourceCartId: 'opaque_source_cart' } : {};
  return { cartIds: [{ cartId: id, cartNum: 1, ...namespace }], quantityReservation: {
    version: row ? 'refund-quantity-customer-row-v3' : 'refund-quantity-materialization-v2', orderId: 17, uid: 11,
    items: [{ rowId: 91, cartId: id, cartNum: 1, beforeRefundNum: 1, totalNum: 3, ...namespace }] } };
}
const refund = () => ({ id: 71, storeOrderId: 17, orderId: business.orderNo, uid: 11, storeId: 0, supplierId: 0,
  applyType: 4, applyPrice: '4.00', refundNum: 1, refundPrice: '3.00', refundReason: '部分商品退款', refundExplain: '申请原文',
  refundImg: null, cartInfo: JSON.stringify(claim()), addTime: now - 30,
  refundType: 6, refundedPrice: '3.00', refundedTime: now, isCancel: 0, isDel: 0 });
const source = () => ({ refund: refund(), ...proof() });
function query() {
  const execute = vi.fn(async (_query: unknown): Promise<unknown[]> => [context()]);
  return { execute, tx: { execute } as unknown as Pick<DbClient, 'execute'> };
}
const message = '小程序原账号订阅通知批准、凭据或证据尚未完整就绪';
const unavailable = { kind: 'original', request: { format: 6, unavailable: true } };
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
async function signed(): Promise<Readonly<RoutineSubscriptionMaterializedRefundSuccessRequest>> {
  const r = await createRoutineSubscriptionMaterializedRefundSuccessRequestTx(query().tx, env, raw());
  if (r.kind !== 'original' || 'unavailable' in r.request) throw Error('Missing explicit format6 unit candidate');
  return r.request;
}
function resign(request: RoutineSubscriptionMaterializedRefundSuccessRequest) {
  const { signature: _signature, ...body } = request;
  return { ...body, signature: mac('materialized-refund-success-notice-request', body) };
}

describe('format6 materialized refund public provenance and candidate writer', () => {
  beforeEach(() => { mocks.catalog.mockReset().mockResolvedValue(ready()); mocks.source.mockReset().mockImplementation(async () => source()); });

  it('distinguishes physical selected, application source, payment root, displayed refund number and actual cash amount', async () => {
    const f = query(), result = await createRoutineSubscriptionMaterializedRefundSuccessRequestTx(f.tx, env, raw());
    if (result.kind !== 'original' || 'unavailable' in result.request) throw Error('Expected signed candidate');
    const request = result.request;
    expect(request).toMatchObject({ format: 6, scope, actor, aggregateId: 27, eventKey: raw().eventKey, eventTime: now, body: business,
      decision: { refundType: 6, refundedTime: now, refundAmount: '3.00', applicationDigest: mac('materialized-refund-success-application', application()),
        ...proof() }, createdAt: now + 1 });
    const { signature, ...unsigned } = request;
    expect(signature).toBe(mac('materialized-refund-success-notice-request', unsigned));
    expect(signature).not.toBe(mac('refund-success-notice-request', unsigned));
    expect(mocks.source).toHaveBeenCalledExactlyOnceWith(f.tx, business); expect(f.execute).toHaveBeenCalledTimes(1);
    for (const value of [result, request, request.scope, request.actor, request.body, request.body.materializedRefund, request.decision])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it.each([false, true])('accepts the durable public materialization quantity contract rowNamespace=%s', async row => {
    const r = { ...refund(), cartInfo: JSON.stringify(claim(row)) }; mocks.source.mockResolvedValue({ ...source(), refund: r });
    const request = await signed();
    expect(captureRoutineSubscriptionMaterializedRefundSuccessDecision(env, r, business, now, proof())).toEqual(request.decision);
    expect(assertRoutineSubscriptionMaterializedRefundSuccessDecision(env, request, r, proof())).toEqual(request.decision);
  });

  it('copies business, nested amounts and signing material before asynchronous inspection', async () => {
    let release!: (value: ReturnType<typeof ready>) => void;
    mocks.catalog.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const dto = raw(), mutable = { ...env }, pending = createRoutineSubscriptionMaterializedRefundSuccessRequestTx(query().tx, mutable, dto);
    dto.payload.orderNo = 'another_refund'; dto.payload.materializedRefund.sourceOrderId = 99;
    dto.payload.materializedRefund.refundAmount = '2.00'; dto.now = 1; mutable.APP_KEY = 'changed';
    release(ready()); const result = await pending;
    if (result.kind !== 'original' || 'unavailable' in result.request) throw Error('Captured candidate missing');
    expect(result.request.body).toEqual(business); expect(result.request.eventTime).toBe(now);
    expect(parseRoutineSubscriptionMaterializedRefundSuccessRequest(env, result.request, scope)).toEqual(result.request);
    expect(() => parseRoutineSubscriptionMaterializedRefundSuccessRequest(mutable, result.request, scope)).toThrow(message);
  });

  it('retains only whole namespace absence as legacy and never reads source or writer', async () => {
    mocks.catalog.mockResolvedValue({ present: false, ready: false, binding: null }); const f = query();
    expect(await createRoutineSubscriptionMaterializedRefundSuccessRequestTx(f.tx, undefined, raw())).toEqual({ kind: 'legacy' });
    expect(f.execute).not.toHaveBeenCalled(); expect(mocks.source).not.toHaveBeenCalled();
  });

  it.each([{ present: true, ready: false, binding: null }, { present: true, ready: false, binding: ready().binding },
    { present: true, ready: true, binding: null }])('retains unavailable6 for partial catalog %#', async value => {
    mocks.catalog.mockResolvedValue(value); const f = query();
    expect(await createRoutineSubscriptionMaterializedRefundSuccessRequestTx(f.tx, env, raw())).toEqual(unavailable);
    expect(f.execute).not.toHaveBeenCalled(); expect(mocks.source).not.toHaveBeenCalled();
  });

  it('rejects missing, inherited and accessor signing keys, guest users and root connections without public reads', async () => {
    let calls = 0; const f = query();
    for (const key of [undefined, {}, { APP_KEY: '' }, { APP_KEY: 'x'.repeat(8193) }, Object.create(env),
      { get APP_KEY() { calls++; return env.APP_KEY; } }])
      expect(await createRoutineSubscriptionMaterializedRefundSuccessRequestTx(f.tx, key, raw())).toEqual(unavailable);
    expect(await createRoutineSubscriptionMaterializedRefundSuccessRequestTx(f.tx, env, { ...raw(), payload: { ...business, userId: 0 } })).toEqual(unavailable);
    expect(await createRoutineSubscriptionMaterializedRefundSuccessRequestTx({ ...f.tx, $client: {} } as unknown as DbClient, env, raw())).toEqual(unavailable);
    expect(calls).toBe(0); expect(f.execute).not.toHaveBeenCalled(); expect(mocks.source).not.toHaveBeenCalled();
  });

  it('requires actual qualified writer provenance before source reads and propagates catalog, writer and source SQL faults', async () => {
    const f = query(); f.execute.mockResolvedValueOnce([{ ...context(), ready: false }]);
    expect(await createRoutineSubscriptionMaterializedRefundSuccessRequestTx(f.tx, env, raw())).toEqual(unavailable);
    expect(mocks.source).not.toHaveBeenCalled();
    const fault = Error('real optional SAVEPOINT owner must isolate this SQL fault');
    mocks.catalog.mockRejectedValueOnce(fault);
    await expect(createRoutineSubscriptionMaterializedRefundSuccessRequestTx(query().tx, env, raw())).rejects.toBe(fault);
    const writer = query(); writer.execute.mockRejectedValueOnce(fault);
    await expect(createRoutineSubscriptionMaterializedRefundSuccessRequestTx(writer.tx, env, raw())).rejects.toBe(fault);
    mocks.source.mockRejectedValueOnce(fault);
    await expect(createRoutineSubscriptionMaterializedRefundSuccessRequestTx(query().tx, env, raw())).rejects.toBe(fault);
  });

  it.each([{ id: 72 }, { storeOrderId: 27 }, { orderId: 'physical_entity_27' }, { uid: 12 }, { uid: 0 },
    { applyPrice: '2.00' }, { refundPrice: '2.00' }, { refundedPrice: '2.00' }, { refundedPrice: '0.00' }, { refundType: 0 },
    { refundedTime: now - 1 }, { isCancel: 1 }, { isDel: 1 }, { refundNum: 2 }, { addTime: now + 1 },
    { refundImg: '界'.repeat(90000) }, { cartInfo: 'x'.repeat(65537) }])('refuses mismatched or incomplete public completion %#', async patch => {
    mocks.source.mockResolvedValue({ ...source(), refund: { ...refund(), ...patch } });
    expect(await createRoutineSubscriptionMaterializedRefundSuccessRequestTx(query().tx, env, raw())).toEqual(unavailable);
  });

  it('rejects unversioned, v1, cross-order, overreserved, duplicate and contradictory row namespaces', () => {
    const c = claim(), base = c.quantityReservation, item = base.items[0], row = claim(true), rowBase = row.quantityReservation;
    for (const cartInfo of [null, '', '[]', '{broken', JSON.stringify({ cartIds: c.cartIds }),
      JSON.stringify({ ...c, quantityReservation: { ...base, version: 'refund-quantity-reservation-v1' } }),
      JSON.stringify({ ...c, quantityReservation: { ...base, orderId: 27 } }),
      JSON.stringify({ ...c, quantityReservation: { ...base, uid: 12 } }),
      JSON.stringify({ ...c, quantityReservation: { ...base, items: [{ ...item, beforeRefundNum: 3 }] } }),
      JSON.stringify({ ...c, quantityReservation: { ...base, items: [{ ...item, beforeRefundNum: -1 }] } }),
      JSON.stringify({ ...c, cartIds: [...c.cartIds, ...c.cartIds], quantityReservation: { ...base, items: [...base.items, ...base.items] } }),
      JSON.stringify({ ...row, quantityReservation: { ...rowBase, items: [{ ...rowBase.items[0], rowId: 92 }] } }),
      JSON.stringify({ ...row, quantityReservation: { ...rowBase, items: [{ ...rowBase.items[0], sourceCartId: 'another_source' }] } }),
      JSON.stringify({ ...row, cartIds: [{ ...row.cartIds[0], sourceCartId: ' control\n' }] }),
      JSON.stringify({ ...c, quantityReservation: { ...base, extra: true } })])
      expect(() => captureRoutineSubscriptionMaterializedRefundSuccessDecision(env, { ...refund(), cartInfo }, business, now, proof())).toThrow(message);
  });

  it('closes descriptor surfaces without evaluating getters, inherited fields or toJSON', async () => {
    let calls = 0; const f = query();
    for (const payload of [{ ...business, extra: true }, Object.create(business),
      { ...business, get payPrice() { calls++; return business.payPrice; } },
      { ...business, materializedRefund: { ...business.materializedRefund, extra: true } },
      { ...business, materializedRefund: Object.create(business.materializedRefund) },
      { ...business, materializedRefund: { ...business.materializedRefund, get refundAmount() { calls++; return '3.00'; } } }])
      await expect(createRoutineSubscriptionMaterializedRefundSuccessRequestTx(f.tx, env, { ...raw(), payload } as ReturnType<typeof raw>)).rejects.toThrow(message);
    expect(mocks.catalog).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
    for (const r of [Object.create(refund()), { ...refund(), get cartInfo() { calls++; return refund().cartInfo; } },
      { ...refund(), cartInfo: { toJSON() { calls++; return refund().cartInfo; } } }])
      expect(() => captureRoutineSubscriptionMaterializedRefundSuccessDecision(env, r, business, now, proof())).toThrow(message);
    expect(calls).toBe(0);
  });

  it('enforces exact money, identity and event bounds while allowing cash below selected order amount', async () => {
    const f = query();
    for (const materializedRefund of [{ ...business.materializedRefund, refundAmount: '0.00' },
      { ...business.materializedRefund, refundAmount: '5.01' }, { ...business.materializedRefund, refundAmount: '03.00' },
      { ...business.materializedRefund, refundAmount: '3' }, { ...business.materializedRefund, paymentOrderId: 0 }])
      await expect(createRoutineSubscriptionMaterializedRefundSuccessRequestTx(f.tx, env, { ...raw(), payload: { ...business, materializedRefund } })).rejects.toThrow(message);
    for (const patch of [{ eventKey: 'order.refund.success.notice:071' }, { eventKey: 'order.refund.refused.notice:71' }, { aggregateId: 17 }, { now: 0 }])
      await expect(createRoutineSubscriptionMaterializedRefundSuccessRequestTx(f.tx, env, { ...raw(), ...patch })).rejects.toThrow(message);
    expect(captureRoutineSubscriptionMaterializedRefundSuccessBusiness({ ...business, orderNo: 'r'.repeat(50) }).orderNo).toHaveLength(50);
    expect(() => captureRoutineSubscriptionMaterializedRefundSuccessBusiness({ ...business, orderNo: 'r'.repeat(51) })).toThrow(message);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('fresh assertion binds immutable materialization and selected entity digests as well as the original application', async () => {
    const request = await signed();
    expect(assertRoutineSubscriptionMaterializedRefundSuccessDecision(env, request, { ...refund(), remark: 'unrelated later remark' }, proof())).toEqual(request.decision);
    for (const patch of [{ refundReason: 'changed' }, { applyPrice: '5.00' }, { cartInfo: JSON.stringify(claim(true)) }, { refundedTime: now + 1 }])
      expect(() => assertRoutineSubscriptionMaterializedRefundSuccessDecision(env, request, { ...refund(), ...patch }, proof())).toThrow(message);
    for (const p of [{ ...proof(), materializationDigest: 'c'.repeat(64) }, { ...proof(), selectedDigest: 'd'.repeat(64) },
      { ...proof(), selectedDigest: '' }, { ...proof(), extra: true }])
      expect(() => assertRoutineSubscriptionMaterializedRefundSuccessDecision(env, request, refund(), p)).toThrow(message);
  });

  it('historical parsing checks independent format6 scope/MAC without consulting writer, source, policy or provider', async () => {
    const request = await signed(); mocks.catalog.mockRejectedValue(Error('must stay pure')); mocks.source.mockRejectedValue(Error('must stay pure'));
    expect(parseRoutineSubscriptionMaterializedRefundSuccessRequest(env, request, scope)).toEqual(request);
    expect(mocks.catalog).toHaveBeenCalledTimes(1); expect(mocks.source).toHaveBeenCalledTimes(1);
    expect(() => parseRoutineSubscriptionMaterializedRefundSuccessRequest(env, request, { ...scope, databaseOid: '999' })).toThrow(message);
    expect(() => parseRoutineSubscriptionMaterializedRefundSuccessRequest({ APP_KEY: 'wrong' }, request, scope)).toThrow(message);
  });

  it('rejects cross-format/domain reuse, tampering and re-signed contradictory decisions', async () => {
    const request = await signed(), { signature: _signature, ...body } = request;
    for (const value of [{ format: 6, unavailable: true }, { ...request, format: 5 }, { ...request, extra: true },
      { ...request, signature: mac('refund-success-notice-request', body) }, { ...request, signature: mac('refusal-notice-request', body) },
      { ...request, body: { ...business, payPrice: '6.00' } },
      resign({ ...request, decision: { ...request.decision, refundedTime: now + 1 } }),
      resign({ ...request, decision: { ...request.decision, refundAmount: '2.00' } }),
      resign({ ...request, decision: { ...request.decision, selectedDigest: '' } }),
      resign({ ...request, actor: { role: scope.maintenance, roleOid: scope.maintenanceOid } })])
      expect(() => parseRoutineSubscriptionMaterializedRefundSuccessRequest(env, value, scope)).toThrow(message);
    expect(() => parseRoutineSubscriptionRefundSuccessRequest(env, request, scope)).toThrow(message);
    const mutable = JSON.parse(JSON.stringify(request)) as RoutineSubscriptionMaterializedRefundSuccessRequest;
    const parsed = parseRoutineSubscriptionMaterializedRefundSuccessRequest(env, mutable, scope);
    expect(parsed).not.toBe(mutable); expect(Object.isFrozen(mutable)).toBe(false); expect(parsed.body.materializedRefund).not.toBe(mutable.body.materializedRefund);
    let calls = 0;
    expect(() => parseRoutineSubscriptionMaterializedRefundSuccessRequest(env, { ...request, decision: { ...request.decision,
      get selectedDigest() { calls++; return request.decision.selectedDigest; } } }, scope)).toThrow(message);
    expect(calls).toBe(0);
  });
});
