import { describe, expect, it, vi } from 'vitest';
import { buyerTrackingIntent, buyerTrackingParameters, createBuyerTrackingReader, initialBuyerTracking,
  parseBuyerTrackingResult, type BuyerTrackingResult, type BuyerTrackingPackage } from '../../view/common/buyerOrderTracking';
import { ExpressService } from '@/services/order/ExpressService';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';

function parcel(orderId = 'order_A'): BuyerTrackingPackage {
  return { orderId, deliveryStatus: '已发货', expressName: '本机快递', expressCode: 'LOCAL', expressNo: 'LOCAL-WAYBILL',
    trackingState: 'not_configured', trackingSource: 'merchant', message: '物流轨迹服务未配置', lastUpdatedAt: 0, traces: [] };
}
function result(refund = false): BuyerTrackingResult {
  const primary = parcel(refund ? 'refund_A' : 'order_A');
  return { ...primary, version: 1, identity: { kind: refund ? 'refund' : 'order', reference: refund ? '101' : 'order_A', uid: 11, entityId: 101, entityNo: primary.orderId, split: false },
    packages: [{ ...primary }], contexts: [{ orderId: primary.orderId, uid: 11, entityId: 101, recipientName: '本机买家', recipientPhone: '00000000000', recipientAddress: '隔离测试地址',
      merchant: { source: 'platform', name: '本机商家', phone: '', address: '' }, items: [{ id: 501, name: '<script>按原文展示</script>', sku: '红色', image: '', quantity: 2, unitPrice: '10.00' }], itemsError: '' }],
    express: [], order: { order_id: primary.orderId, delivery_id: primary.expressNo, delivery_name: primary.expressName, delivery_code: primary.expressCode, delivery_type: 'express' } };
}
function gate<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
describe('buyer tracking query, response identity and lifecycle', () => {
  it('keeps outgoing and return intent distinct and accepts only an exact current refund ID', () => {
    expect(buyerTrackingIntent('order_A')).toEqual({ kind: 'order', reference: 'order_A' });
    expect(buyerTrackingIntent('101', 'refund')).toEqual({ kind: 'refund', reference: '101' });
    for (const [id, type] of [['refund_A', 'refund'], ['01', 'refund'], ['2147483648', 'refund'], ['order_A', 'other'], [['order_A'], '']])
      expect(() => buyerTrackingIntent(id, type)).toThrow();
    for (const query of ['orderId=order_A&orderId=other', 'orderId=order_A&type=refund&type=refund', 'type=refund'])
      expect(() => buyerTrackingParameters(new URLSearchParams(query))).toThrow();
  });
  it('clones the full owner-bound order and return DTO without inventing carrier traces', () => {
    for (const refund of [false, true]) {
      const raw = result(refund), intent = buyerTrackingIntent(refund ? '101' : 'order_A', refund ? 'refund' : undefined);
      const parsed = parseBuyerTrackingResult(raw, intent, 11);
      raw.contexts[0].recipientName = 'changed'; raw.packages[0].expressNo = 'changed';
      expect(parsed.contexts[0].recipientName).toBe('本机买家'); expect(parsed.packages[0].expressNo).toBe('LOCAL-WAYBILL');
      expect(parsed.traces).toEqual([]); expect(parsed.contexts[0].items[0].name).toContain('<script>');
    }
  });
  it.each(['owner', 'intent', 'entity', 'missing-context', 'context-owner', 'bad-price', 'invented-trace', 'legacy-number'] as const)('rejects %s response corruption', kind => {
    const raw = result();
    if (kind === 'owner') raw.identity.uid = 22;
    if (kind === 'intent') raw.identity.kind = 'refund';
    if (kind === 'entity') raw.identity.entityNo = 'other';
    if (kind === 'missing-context') raw.contexts = [];
    if (kind === 'context-owner') raw.contexts[0].uid = 22;
    if (kind === 'bad-price') raw.contexts[0].items[0].unitPrice = 'NaN';
    if (kind === 'invented-trace') raw.traces = [{ time: '', content: '非承运商记录', status: '已签收' }];
    if (kind === 'legacy-number') raw.order.delivery_id = 'OTHER-WAYBILL';
    expect(() => parseBuyerTrackingResult(raw, buyerTrackingIntent('order_A'), 11)).toThrow();
  });
  it('discards late outgoing data after switching to a return route', async () => {
    const late = gate<BuyerTrackingResult>(), state = initialBuyerTracking(), read = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValueOnce(result(true));
    const reader = createBuyerTrackingReader(state, { capture: () => ({ uid: 11, token: 'local', current: () => true }), read, copy: async () => {} });
    reader.setRoute('order_A'); const pending = reader.load(); reader.setRoute('101', 'refund'); await reader.load(); late.resolve(result()); await pending;
    expect(state.result?.identity.kind).toBe('refund'); expect(state.result?.identity.entityId).toBe(101); expect(state.loading).toBe(false);
  });
  it('clears old contacts, goods, selection and copy feedback before a failed refresh', async () => {
    const state = initialBuyerTracking(), read = vi.fn().mockResolvedValueOnce(result()).mockRejectedValueOnce(Error('owned 503'));
    const reader = createBuyerTrackingReader(state, { capture: () => ({ uid: 11, token: 'local', current: () => true }), read, copy: async () => {} });
    reader.setRoute('order_A'); await reader.load(); await reader.copy(); expect(state.copyMessage).toContain('已复制');
    const refresh = reader.load(); expect(state.result).toBeNull(); expect(state.selectedPackageId).toBe(''); expect(state.copyMessage).toBe('');
    await refresh; expect(state.result).toBeNull(); expect(state.error).toContain('owned 503');
  });
  it('does not dispatch anonymous or malformed queries and fences a response after owner change', async () => {
    let uid = 0, token = '', epoch = 0;
    const state = initialBuyerTracking(), late = gate<BuyerTrackingResult>(), read = vi.fn(() => late.promise);
    const reader = createBuyerTrackingReader(state, { capture: () => { const expected = epoch; return { uid, token, current: () => epoch === expected }; }, read, copy: async () => {} });
    reader.setRoute('../other'); await reader.load(); expect(read).not.toHaveBeenCalled();
    reader.setRoute('order_A'); await reader.load(); expect(read).not.toHaveBeenCalled();
    uid = 11; token = 'local'; const pending = reader.load(); epoch++; uid = 22; reader.clear('账号已切换'); late.resolve(result()); await pending;
    expect(state.result).toBeNull(); expect(state.error).toBe('账号已切换');
  });
  it('copies only the current selected parcel and suppresses stale clipboard callbacks', async () => {
    const raw = result(); raw.identity.split = true; raw.identity.entityNo = raw.orderId = raw.order.order_id = 'root_A';
    raw.packages.push({ ...parcel('child_B'), expressNo: 'B-WAYBILL' }); raw.contexts.push({ ...raw.contexts[0], entityId: 102, orderId: 'child_B' });
    const copied = gate<void>(), values: string[] = [], state = initialBuyerTracking();
    const reader = createBuyerTrackingReader(state, { capture: () => ({ uid: 11, token: 'local', current: () => true }), read: async () => raw,
      copy: async value => { values.push(value); await copied.promise; } });
    reader.setRoute('root_A'); raw.identity.reference = 'root_A'; await reader.load();
    const old = state.result!.packages[0], next = state.result!.packages[1]; reader.select(next); const pending = reader.copy();
    reader.select(old); copied.resolve(); await pending; expect(values).toEqual(['B-WAYBILL']); expect(state.copyMessage).toBe('');
    reader.clear(); reader.select(next); await reader.copy(); expect(values).toHaveLength(1);
  });
});

describe('frozen carrier engine return semantics (local provider boundary only)', () => {
  it('does not turn a submitted/refunded application into a carrier receipt', async () => {
    const container = { systemConfigDao: { getValue: async () => '' } } as unknown as Container;
    const engine = new ExpressService(container, {} as Env), authorize = vi.fn(async () => {});
    for (const refundType of [4, 5, 6]) {
      const historical = { id: 101, orderId: 'refund_A', refundExpress: 'RETURN-WAYBILL', refundExpressName: '本机退件', refundPhone: '', refundType };
      const data = await engine.queryScopedRefund(historical, authorize);
      expect(data.deliveryStatus).toBe('已填写退货运单'); expect(data.trackingState).toBe('not_configured'); expect(data.traces).toEqual([]);
    }
    expect(authorize).toHaveBeenCalledTimes(6);
  });
});
