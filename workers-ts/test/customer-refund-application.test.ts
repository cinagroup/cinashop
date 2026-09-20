import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { customerRefundApplicationFixture } from './helpers/customerRefundApplicationFixture';

describe('customer refund applications through actual HTTP controller and disposable SQL', () => {
  let fixture: Awaited<ReturnType<typeof customerRefundApplicationFixture>>;
  beforeAll(async () => { fixture = await customerRefundApplicationFixture(); });
  afterAll(async () => { await fixture?.close(); });
  async function call(path: string, body?: unknown, uid = '11') {
    return (await fixture.app.request('/api/order/' + path, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-fixture-user': uid },
      body: body ? JSON.stringify(body) : undefined,
    }, fixture.env)).json() as Promise<{ status: number; data: any; msg: string }>;
  }
  const body = { cartIds: [1], applyType: 2, refundReason: '本地测试申请', refundExplain: '' };
  it('returns refundId, persists canonical line selection, and does not perform settlement or change order refund status', async () => {
    const before = await fixture.snapshot();
    const result = await call('refund/apply/local_refund_1', body);
    expect(result.status).toBe(200); expect(result.data.refundId).toBeGreaterThan(0); expect(result.data.id).toBeUndefined();
    const rows = await fixture.applications();
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ uid: 11, storeOrderId: 1, refundNum: 2, refundPrice: '10.00', applyType: 2 });
    const cartSnapshot = rows[0].cartInfo;
    if (cartSnapshot === null) throw Error('退款申请缺少商品快照');
    expect(JSON.parse(cartSnapshot)).toEqual({ cartIds: [{cartId:501,cartNum:2}], quantityReservation: {
      version:'refund-quantity-reservation-v1',orderId:1,uid:11,items:[{rowId:1,cartId:501,cartNum:2,beforeRefundNum:0,totalNum:2}],
    } });
    expect(await fixture.snapshot()).toEqual(before);
    expect(await fixture.statuses()).toHaveLength(1);
  });
  it('rejects a repeated active application rather than silently treating it as the same operation', async () => {
    const before = await fixture.applications();
    const result = await call('refund/apply/local_refund_1', body);
    expect(result.status).toBe(400); expect(result.msg).toContain('进行中'); expect(await fixture.applications()).toEqual(before);
  });
  it('offers owner-scoped receipt history and detail independently of the unchanged order master', async () => {
    const rows = await fixture.applications(), id = rows[0].id;
    expect((await call('refund/list')).data.map((row: { id: number }) => row.id)).toEqual([id]);
    expect((await call(`refund/detail/${id}`)).data.id).toBe(id);
    expect((await call(`refund/detail/${id}`, undefined, '22')).status).not.toBe(200);
    expect((await call('refund/list', undefined, '22')).data).toEqual([]);
  });
  it('rejects foreign orders, foreign lines, duplicate lines and privileged application types without writes', async () => {
    const before = await fixture.applications();
    for (const [id, params] of [['local_refund_4', body], ['local_refund_2', body],
      ['local_refund_2', { ...body, cartIds: [2, 2] }], ['local_refund_2', { ...body, cartIds: [2], applyType: 4 }]] as const) {
      expect((await call(`refund/apply/${id}`, params)).status).not.toBe(200);
    }
    expect(await fixture.applications()).toEqual(before);
  });
});
