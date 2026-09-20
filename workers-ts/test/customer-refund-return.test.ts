import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { customerRefundReturnFixture } from './helpers/customerRefundReturnFixture';
import { storeOrderRefund, systemAttachment } from '../src/models/schema';
import { parseReturnPayload, returnImageReferences } from '../src/services/order/RefundReturnPayload';

describe('customer return logistics over actual upload, controller and SQL', () => {
  let fixture: Awaited<ReturnType<typeof customerRefundReturnFixture>>;
  beforeAll(async () => { fixture = await customerRefundReturnFixture(); });
  afterAll(async () => { await fixture?.close(); });
  const body = (id = 25) => ({ id, refund_express: 'LOCAL-RETURN-25', refund_express_name: '本地快递甲', refund_phone: '000000', refund_explain: 'PHP原字段备注', refund_img: [] as string[] });
  async function post(value: unknown, uid = '11') {
    return (await fixture.app.request('/api/order/refund/express', { method: 'POST', headers: { 'x-fixture-user': uid, 'content-type': 'application/json' }, body: JSON.stringify(value) }, fixture.env)).json() as Promise<{ status: number; data: unknown }>;
  }
  async function detail(id: number) {
    return (await fixture.app.request(`/api/order/refund/detail/${id}?view=customer`, { headers: { 'x-fixture-user': '11' } }, fixture.env)).json() as Promise<{ status: number; data: Record<string, unknown> }>;
  }
  it('offers only enabled visible carriers without provider credentials', async () => {
    const result = await (await fixture.app.request('/api/logistics?status=1', {}, fixture.env)).json();
    expect(result).toMatchObject({ status: 200, data: [{ id: 1, name: '本地快递甲', code: 'local-a' }, { id: 2, name: '本地快递乙', code: 'local-b' }] });
    expect(JSON.stringify(result)).not.toContain('partnerKey');
  });
  it('rejects invalid owners, states, payload types and oversize bodies without business changes', async () => {
    const before = await fixture.snapshot(), refunds = await fixture.applications(), statuses = await fixture.statuses();
    for (const value of [body(46), body(47), body(21), body(20), { ...body(), refund_express: {} }, { ...body(), refund_explain: ['wrong'] },
      { ...body(), refund_img: ['/api/assets/999'] }, { ...body(), refund_img: ['javascript:alert(1)'] }, { ...body(), refund_explain: 'x'.repeat(33000) }]) {
      expect((await post(value)).status).not.toBe(200);
    }
    expect((await post(body(), '')).status).not.toBe(200);
    expect(await fixture.snapshot()).toEqual(before); expect(await fixture.applications()).toEqual(refunds); expect(await fixture.statuses()).toEqual(statuses);
  });
  it('uploads an owned image, persists canonical references and PHP remarks, signs only after ownership read, and rejects replay', async () => {
    const before = await fixture.snapshot();
    const bytes = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]);
    const form = new FormData(); form.append('file', new File([bytes], 'local-evidence.png', { type: 'image/png' })); form.append('pid', '0');
    const encoded = new Request('https://local.invalid', { method: 'POST', body: form }), buffer = await encoded.arrayBuffer();
    const response = await fixture.app.request('/api/upload/image', { method: 'POST', headers: { 'x-fixture-user': '11', 'content-type': encoded.headers.get('content-type')!, 'content-length': String(buffer.byteLength) }, body: buffer }, fixture.env);
    const uploaded = await response.json() as { status: number; data: { url: string; src: string } }; expect(uploaded.status).toBe(200);
    const payload = { ...body(), refund_img: [uploaded.data.url] };
    expect(await post(payload)).toMatchObject({ status: 200, data: null });
    const read = await detail(25); expect(read.data).toMatchObject({ refundType: 5, refundGoodsExplain: 'PHP原字段备注', refundExpress: payload.refund_express,
      returnImages: [{ url: uploaded.data.url, src: expect.stringContaining(uploaded.data.url + '?expires=') }], returnImagesError: '' });
    expect(JSON.stringify(read.data)).not.toContain('returnImageJson');
    const asset = await fixture.app.request(uploaded.data.src, {}, fixture.env); expect(asset.status).toBe(200);
    expect([...new Uint8Array(await asset.arrayBuffer())]).toEqual([...bytes]); expect(asset.headers.get('cache-control')).toBe('private, no-store');
    expect((await post(payload)).status).not.toBe(200);
    expect(await fixture.statuses()).toHaveLength(1); expect(await fixture.snapshot()).toEqual(before);
    const rows = await fixture.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, 25));
    expect(rows[0].refundGoodsImg).toBe(JSON.stringify([uploaded.data.url])); expect(rows[0].refundGoodsImg).not.toContain('signature');
  });
  it('never signs a foreign attachment, including one injected into an old owned refund row', async () => {
    const [foreign] = await fixture.db.insert(systemAttachment).values({ type: 3, moduleType: 3, relationId: 22, fileType: 1, imageType: 8 }).returning();
    const url = `/api/assets/${foreign.attId}`, before = await fixture.statuses();
    expect((await post({ ...body(32), refund_img: [url] })).status).not.toBe(200);
    await fixture.db.update(storeOrderRefund).set({ refundGoodsImg: JSON.stringify([url]) }).where(eq(storeOrderRefund.id, 32));
    const read = await detail(32); expect(read.status).toBe(200); expect(read.data.returnImages).toEqual([]); expect(read.data.returnImagesError).toBeTruthy();
    expect(JSON.stringify(read.data)).not.toContain('signature='); expect(await fixture.statuses()).toEqual(before);
  });
  it('rolls back the return transition when the status INSERT fails, then allows one explicit retry', async () => {
    const before = await fixture.snapshot(), refunds = await fixture.applications(), statuses = await fixture.statuses();
    // This constraint exists only in the disposable fixture and fails the final write in the real transaction.
    await fixture.exec('ALTER TABLE store_order_status ADD CONSTRAINT local_reject_return_status CHECK (oid <> 39)');
    try {
      expect((await post(body(39))).status).not.toBe(200);
      expect(await fixture.applications()).toEqual(refunds); expect(await fixture.statuses()).toEqual(statuses);
      expect(await fixture.snapshot()).toEqual(before);
    } finally { await fixture.exec('ALTER TABLE store_order_status DROP CONSTRAINT local_reject_return_status'); }
    expect((await post(body(39))).status).toBe(200);
    expect((await detail(39)).data.refundType).toBe(5); expect(await fixture.statuses()).toHaveLength(statuses.length + 1);
    expect(await fixture.snapshot()).toEqual(before);
  });
  it('bounds actual streamed bytes and rejects malformed JSON or UTF-8 without any refund write', async () => {
    const before = await fixture.applications(), statuses = await fixture.statuses();
    for (const bytes of [new TextEncoder().encode('{'), Uint8Array.from([255,254]), new TextEncoder().encode(JSON.stringify({...body(32), unused:'x'.repeat(33000)}))]) {
      const stream = new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close();}});
      const response = await fixture.app.request('/api/order/refund/express',{method:'POST',headers:{'x-fixture-user':'11','content-type':'application/json'},body:stream,duplex:'half'} as RequestInit,fixture.env);
      expect((await response.json() as {status:number}).status).not.toBe(200);
    }
    expect(await fixture.applications()).toEqual(before); expect(await fixture.statuses()).toEqual(statuses);
  });
});

describe('bounded legacy-compatible return payload', () => {
  const input = { id: '25', refund_express: ' TEST ', refund_explain: ' legacy note ' };
  it('retains PHP fields, JSON/array/comma images and aliases', () => {
    expect(parseReturnPayload(input)).toMatchObject({ id: 25, refundExpress: 'TEST', refundGoodsExplain: 'legacy note', refundGoodsImg: '[]' });
    for (const images of [['/api/assets/1', '/api/assets/2'], '["/api/assets/1","/api/assets/2"]', '/api/assets/1,/api/assets/2']) expect(returnImageReferences(images)).toEqual(['/api/assets/1', '/api/assets/2']);
  });
  for (const value of [null, [], { ...input, id: '025' }, { ...input, refund_express: true }, { ...input, refundGoodsExplain: 'conflict' },
    { ...input, refund_phone: '\u0000' }, { ...input, refund_img: ['/api/assets/1', '/api/assets/1'] }, { ...input, refund_img: ['/api/assets/1?expires=9&signature=x'] },
    { ...input, refund_img: ['https://user:pass@example.com/a'] }, { ...input, refund_img: ['1', '2', '3', '4'] }]) {
    it(`rejects malformed payload ${JSON.stringify(value)}`, () => expect(() => parseReturnPayload(value)).toThrow());
  }
});
