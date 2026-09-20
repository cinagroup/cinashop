import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { customerRefundReadFixture } from './helpers/customerRefundReadFixture';
import { projectCustomerRefundItems } from '../src/services/order/CustomerRefundReadService';

describe('customer refund read contract over actual controllers and SQL', () => {
  let fixture: Awaited<ReturnType<typeof customerRefundReadFixture>>;
  beforeAll(async () => { fixture = await customerRefundReadFixture(); });
  afterAll(async () => { await fixture?.close(); });
  async function read(path: string, uid = '11') {
    return (await fixture.app.request('/api/order/refund/' + path, { headers: { 'x-fixture-user': uid } }, fixture.env)).json();
  }
  it('returns a bounded stable customer page, excluding foreign/deleted rows and internal remarks', async () => {
    const result = await read('list?view=customer&filter=all&limit=20') as { status: number; data: { version: number; items: Array<Record<string, unknown>>; nextCursor: string } };
    expect(result.status).toBe(200); expect(result.data.version).toBe(1); expect(result.data.items).toHaveLength(20);
    expect(result.data.items.map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => 45 - i));
    expect(result.data.items.every(row => row.uid === 11 && !('remark' in row) && !('cartInfo' in row))).toBe(true);
    const next = await read('list?view=customer&filter=all&limit=20&cursor=' + encodeURIComponent(result.data.nextCursor)) as { data: { items: Array<{ id: number }>; nextCursor: null } };
    expect(next.data.items.map(row => row.id)).toEqual([25, 24, 23, 22, 21, 20]); expect(next.data.nextCursor).toBeNull();
  });
  it('returns selected product snapshot and exact quantity, not the whole order quantity', async () => {
    const result = await read('detail/25?view=customer') as { status: number; data: { version: number; id: number; orderId: string; items: unknown[]; returnContact: { name: string }; remark?: string } };
    expect(result.status).toBe(200); expect(result.data.version).toBe(1); expect(result.data.id).toBe(25);
    expect(result.data.orderId).toBe('history_order_25');
    expect(result.data.items).toEqual([{ id: 25, cartId: 2025, name: '退款商品 25', sku: '红色', image: '/api/qa/image.svg', quantity: 1 }]);
    expect(result.data.returnContact.name).toBe('本地收件人'); expect(result.data.remark).toBeUndefined();
  });
  it('rejects malformed route identities and hides deleted refunds without business writes', async () => {
    const before = await fixture.snapshot(), refunds = await fixture.applications(), statuses = await fixture.statuses();
    for (const id of ['47', '46', '025', '25junk', '0', '-1']) {
      expect((await read(`detail/${id}?view=customer`) as { status: number }).status).not.toBe(200);
    }
    expect(await fixture.snapshot()).toEqual(before); expect(await fixture.applications()).toEqual(refunds); expect(await fixture.statuses()).toEqual(statuses);
  });
  for (const filter of ['all', 'pending', 'returning', 'transit', 'completed', 'rejected', 'cancelled']) {
    it(`filters ${filter} using actual refund type and cancellation precedence`, async () => {
      const result = await read(`list?view=customer&limit=50&filter=${filter}`) as { status: number; data: { items: Array<{ id: number }> } };
      const states: Record<string, number[]> = { pending: [0, 1, 2], returning: [4], transit: [5], completed: [6], rejected: [3] };
      const expected = Array.from({ length: 26 }, (_, i) => 45 - i).filter(id => filter === 'all' || (filter === 'cancelled' ? id === 21 : id !== 21 && states[filter].includes(id % 7)));
      expect(result.status).toBe(200); expect(result.data.items.map(row => row.id)).toEqual(expected);
    });
  }
  it('searches literal order/refund numbers without treating wildcard characters as SQL wildcards', async () => {
    for (const q of ['HISTORY_ORDER_25', 'history_refund_25', '%', 'history_order_2_', '\\']) {
      const result = await read('list?view=customer&q=' + encodeURIComponent(q)) as { data: { items: Array<{ id: number }> } };
      expect(result.data.items.map(row => row.id)).toEqual(q.toLowerCase().endsWith('25') ? [25] : []);
    }
  });
  it('rejects malformed filters, repeated parameters, excessive bounds and foreign cursor contexts', async () => {
    const first = await read('list?view=customer&limit=20') as { data: { nextCursor: string } };
    for (const query of ['filter=bad', 'limit=51', 'limit=0', 'limit=01', 'limit=1.5', 'limit=20&limit=20', 'q='+'x'.repeat(81), 'q=%00', 'cursor=invalid', 'extra=yes',
      `limit=10&cursor=${first.data.nextCursor}`, `filter=pending&cursor=${first.data.nextCursor}`, `q=25&cursor=${first.data.nextCursor}`]) {
      expect((await read('list?view=customer&'+query) as {status:number}).status).not.toBe(200);
    }
    expect((await read('list?view=customer&cursor='+first.data.nextCursor,'22') as {status:number}).status).not.toBe(200);
    expect((await read('list?view=customer','') as {status:number}).status).not.toBe(200);
  });
  it('preserves the unversioned legacy read contract and marks customer reads no-store', async () => {
    const legacy = await read('list') as {status:number;data:unknown}; expect(legacy.status).toBe(200); expect(Array.isArray(legacy.data)).toBe(true);
    const response = await fixture.app.request('/api/order/refund/detail/25?view=customer', {headers:{'x-fixture-user':'11'}}, fixture.env);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('cancels only an owned synthetic application, without payment, order or inventory mutation', async () => {
    const before = await fixture.snapshot(), statuses = await fixture.statuses();
    const invoke = async (id: number, uid = '11') => (await fixture.app.request('/api/order/refund/cancel/'+id,
      {method:'POST',headers:{'x-fixture-user':uid}},fixture.env)).json() as Promise<{status:number;data:unknown}>;
    expect((await invoke(46)).status).not.toBe(200); expect((await invoke(20)).status).not.toBe(200);
    expect(await invoke(25)).toMatchObject({status:200,data:null});
    expect((await read('detail/25?view=customer') as {data:{isCancel:number;returnContact:unknown}}).data).toMatchObject({isCancel:1,returnContact:null});
    expect((await invoke(25)).status).not.toBe(200);
    expect(await fixture.snapshot()).toEqual(before); expect(await fixture.statuses()).toHaveLength(statuses.length+1);
  });
});

describe('bounded customer refund product snapshots', () => {
  const carts = [1,2].map(id=>({id,cartId:String(500+id),cartNum:3,cartInfo:JSON.stringify({product:{storeName:'合成商品 '+id},sku:{suk:'红色'}})}));
  it('retains unknown quantities for genuinely ambiguous legacy partial multi-line refunds',()=>{
    expect(projectCustomerRefundItems(JSON.stringify({cartIds:[501,502]}),4,carts).map(row=>row.quantity)).toEqual([null,null]);
    expect(projectCustomerRefundItems(JSON.stringify({cartIds:[501,502]}),6,carts).map(row=>row.quantity)).toEqual([3,3]);
    expect(projectCustomerRefundItems(JSON.stringify({cartIds:[501]}),2,carts)[0].quantity).toBe(2);
  });
  for(const raw of [null,'bad','x'.repeat(65537),JSON.stringify({cartIds:[]}),JSON.stringify({cartIds:[501,501]}),JSON.stringify({cartIds:[999]}),
    JSON.stringify({cartIds:[{cartId:501,cartNum:4}]}),JSON.stringify({cartIds:[{cartId:501,cartNum:1}]})]) {
    it(`rejects invalid snapshot ${raw===null?'null':raw.slice(0,55)}`,()=>expect(()=>projectCustomerRefundItems(raw,2,carts)).toThrow());
  }
});
