import { beforeAll, afterAll, it, expect, describe, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { supplierRefundEvidenceFixture } from './helpers/supplierRefundEvidenceFixture';
import { storeOrder, storeOrderRefund, systemAttachment, systemRole } from '../src/models/schema';

describe('supplier return evidence through actual auth, permissions, controller and SQL', () => {
  let f: Awaited<ReturnType<typeof supplierRefundEvidenceFixture>>;
  beforeAll(async () => { f = await supplierRefundEvidenceFixture(); });
  afterAll(async () => { await f?.close(); });
  const read = (id = 25, actor = 100, suffix = '') => f.supplierApp.request(`/supplierapi/refund/detail/${id}${suffix}`, { headers: { Authorization: `Bearer ${f.tokens.get(actor) ?? ''}` } }, f.env);
  const data = async (id = 25, actor = 100) => (await (await read(id, actor)).json()) as { status: number; data: Record<string, unknown> };

  it('reads submitted PHP-compatible return fields and an owned signed image without business writes', async () => {
    const bytes = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]);
    const form = new FormData(); form.append('file', new File([bytes], 'local.png', { type: 'image/png' }));
    const req = new Request('https://local.invalid', { method: 'POST', body: form }), encoded = await req.arrayBuffer();
    const upload = await f.app.request('/api/upload/image', { method: 'POST', headers: { 'x-fixture-user': '11', 'content-type': req.headers.get('content-type')!, 'content-length': String(encoded.byteLength) }, body: encoded }, f.env);
    const image = await upload.json() as { status: number; data: { url: string } }; expect(image.status).toBe(200);
    const submitted = await f.app.request('/api/order/refund/express', { method: 'POST', headers: { 'x-fixture-user': '11', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 25, refund_express: 'LOCAL-25', refund_express_name: '本地快递甲', refund_phone: '000000', refund_explain: '<b>原始退货备注</b>', refund_img: [image.data.url] }) }, f.env);
    expect(await submitted.json()).toMatchObject({ status: 200 });
    const before = await f.snapshot(), refunds = await f.applications(), statuses = await f.statuses();
    const response = await read(), body = await response.json() as { data: { returnImages: Array<{src: string}> } };
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(body.data).toMatchObject({ refund_type: 5, is_cancel: 0, refund_express: 'LOCAL-25', refund_express_name: '本地快递甲', refund_phone: '000000', refund_goods_explain: '<b>原始退货备注</b>',
      returnImages: [{ url: image.data.url, src: expect.stringContaining('?expires=') }], returnImagesError: '' });
    const asset = await f.app.request(body.data.returnImages[0].src, {}, f.env);
    expect(asset.status).toBe(200); expect([...new Uint8Array(await asset.arrayBuffer())]).toEqual([...bytes]);
    expect(JSON.stringify(body.data)).not.toContain('refundGoodsImg');
    expect(await f.snapshot()).toEqual(before); expect(await f.applications()).toEqual(refunds); expect(await f.statuses()).toEqual(statuses);
  });
  it('enforces real read permission and supplier identity; query parameters cannot override the tenant', async () => {
    expect((await data(25, 101)).status).toBe(200);
    for (const actor of [0, 102, 200]) {
      const response = await read(25, actor, '?supplierId=20&uid=11');
      const body = await response.json(); expect(body).not.toMatchObject({ status: 200 }); expect(JSON.stringify(body)).not.toContain('signature=');
    }
    const before = await f.applications();
    const denied = await f.supplierApp.request('/supplierapi/refund/remark/25', { method: 'PUT', headers: { Authorization: `Bearer ${f.tokens.get(101)}`, 'content-type': 'application/json' }, body: '{"remark":"forbidden"}' }, f.env);
    expect(await denied.json()).not.toMatchObject({ status: 200 }); expect(await f.applications()).toEqual(before);
    await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 1));
    try { expect((await data(25, 101)).status).not.toBe(200); }
    finally { await f.db.update(systemRole).set({ status: 1 }).where(eq(systemRole.id, 1)); }
  });
  it.each(['refund-tenant', 'order-tenant', 'owner-mismatch', 'refund-deleted', 'order-deleted', 'system-deleted'])('rejects inconsistent visibility: %s', async kind => {
    const refundChanges = kind === 'refund-tenant' ? { supplierId: 40 } : kind === 'owner-mismatch' ? { uid: 22 } : kind === 'refund-deleted' ? { isDel: 1 } : {};
    const orderChanges = kind === 'order-tenant' ? { supplierId: 40 } : kind === 'order-deleted' ? { isDel: 1 } : kind === 'system-deleted' ? { isSystemDel: 1 } : {};
    if (Object.keys(refundChanges).length) await f.db.update(storeOrderRefund).set(refundChanges).where(eq(storeOrderRefund.id, 32));
    if (Object.keys(orderChanges).length) await f.db.update(storeOrder).set(orderChanges).where(eq(storeOrder.id, 32));
    try { expect((await data(32)).status).not.toBe(200); }
    finally {
      await f.db.update(storeOrderRefund).set({ supplierId: 20, uid: 11, isDel: 0 }).where(eq(storeOrderRefund.id, 32));
      await f.db.update(storeOrder).set({ supplierId: 20, isDel: 0, isSystemDel: 0 }).where(eq(storeOrder.id, 32));
    }
  });
  it('preserves cancelled history as explicitly cancelled, not actionable waiting return', async () => {
    await f.db.update(storeOrderRefund).set({ isCancel: 1 }).where(eq(storeOrderRefund.id, 39));
    expect((await data(39)).data).toMatchObject({ is_cancel: 1, returnImages: [] });
  });
  it('does not leak or sign invalid, oversized, foreign or wrong-purpose attachment references', async () => {
    const [foreign] = await f.db.insert(systemAttachment).values({ type: 3, moduleType: 3, relationId: 22, fileType: 1, imageType: 8 }).returning();
    const [wrong] = await f.db.insert(systemAttachment).values({ type: 3, moduleType: 3, relationId: 11, fileType: 1, imageType: 1 }).returning();
    for (const value of ['[', 'x'.repeat(9000), '["javascript:alert(1)"]', JSON.stringify([`/api/assets/${foreign.attId}`]), JSON.stringify([`/api/assets/${wrong.attId}`])]) {
      await f.db.update(storeOrderRefund).set({ refundGoodsImg: value }).where(eq(storeOrderRefund.id, 32));
      const result = await data(32); expect(result.status).toBe(200); expect(result.data.returnImages).toEqual([]); expect(result.data.returnImagesError).toBeTruthy(); expect(JSON.stringify(result.data)).not.toContain('signature=');
    }
  });
});

describe('Supplier Pages signed evidence proxy', () => {
  afterEach(() => vi.unstubAllGlobals());
  const handler = async () => (await import(new URL('../../view/supplier-ts/functions/api/assets/[id].ts', import.meta.url).href)).onRequest;
  it('streams signed assets with no merchant credentials, no redirect following and private caching', async () => {
    const request = new Request('https://supplier.invalid/api/assets/7?expires=123&signature=synthetic', { headers: { authorization: 'private-token', cookie: 'private-cookie' } });
    const upstream = vi.fn(async () => new Response('image', { headers: { 'content-type': 'image/png', 'set-cookie': 'upstream-cookie', 'cache-control': 'public' } })); vi.stubGlobal('fetch', upstream);
    const response = await (await handler())({ request, env: {} });
    expect(upstream).toHaveBeenCalledWith(new URL('https://cinashop-api.cinagroup.workers.dev/api/assets/7?expires=123&signature=synthetic'), { method: 'GET', redirect: 'manual' });
    expect(response.headers.get('cache-control')).toContain('private, no-store'); expect(response.headers.has('set-cookie')).toBe(false); expect(await response.text()).toBe('image');
  });
  it('rejects mutation methods and unrelated paths without upstream dispatch', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream); const run = await handler();
    for (const [path, method, status] of [['/api/assets/7','POST',405],['/api/assets/7/nested','GET',404],['/api/order/list','GET',404]] as const) {
      expect((await run({ request: new Request('https://supplier.invalid' + path, { method }), env: {} })).status).toBe(status);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});
