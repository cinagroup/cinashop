import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, systemAttachment, user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { SupplierAfterSaleService } from '@/services/supplier/SupplierAfterSaleService';
import * as evidence from '@/services/order/RefundApplicationEvidence';
import { readRefundQuantityReservation } from '@/services/order/RefundQuantityReservation';
import { refundApplicationEvidenceFixture, refundApplicationEvidenceWriterFixture } from './helpers/refundApplicationEvidence';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned evidence App boundary'); return wiring.container;
} }));
const app = createApp();
type Envelope = { status: number; msg: string; data: any };
const route = (id: number) => '/supplierapi/refund/detail/' + id;
const bearer = (token: string) => ({ Authorization: 'Bearer ' + token });

/** Ordinary Customer upload/apply author is intentionally separate from the
 * Supplier independent read-only LOGIN. No provider or production ACL involved. */
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('original refund application evidence actual App JWT owned PG16', () => {
  let f: Awaited<ReturnType<typeof refundApplicationEvidenceFixture>>;
  beforeEach(async () => { f = await refundApplicationEvidenceFixture(); wiring.container = f.container;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned evidence acceptance forbids provider calls')); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally {
    wiring.container = undefined; vi.restoreAllMocks(); await f?.close();
  } }, 30000);

  async function read(id = 100, token = f.tokens.viewer) {
    return f.withReader(async peer => {
      wiring.container = peer.container;
      const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,
        has_table_privilege(current_user,'store_order_refund','UPDATE') AS updates,
        has_schema_privilege(current_user,'public','CREATE') AS creates`);
      expect(rights).toEqual({ independent: true, updates: false, creates: false });
      const before = await f.snapshot(), sequences = await f.sequences();
      const response = await app.request(route(id), { headers: bearer(token) }, f.env);
      const body = await response.json<Envelope>();
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
      return body;
    });
  }
  async function good(id = 100) { const result = await read(id); expect(result.status, result.msg).toBe(200); return result.data; }
  async function apply(value: unknown, token: string) {
    wiring.container = f.container;
    return (await app.request('/api/order/refund/apply/100', { method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify(value) }, f.env)).json<Envelope>();
  }

  it('reads original and later return images independently and streams exact owned PNG bytes with no SQL or sequence writes', async () => {
    const detail = await good();
    expect(detail.requestImagesError).toBe(''); expect(detail.returnImagesError).toBe('');
    expect(detail.requestImages).toEqual([{ url: '/api/assets/31', src: expect.stringContaining('/api/assets/31?expires=') }]);
    expect(detail.returnImages).toEqual([{ url: '/api/assets/33', src: expect.stringContaining('/api/assets/33?expires=') }]);
    expect(detail).not.toHaveProperty('refundImg'); expect(detail).not.toHaveProperty('refund_img');
    expect(detail.cartInfo).toBeNull(); expect(detail.orderInfo).toBeNull();
    await f.withReader(async peer => {
      wiring.container = peer.container;
      const before = await f.snapshot(), sequences = await f.sequences();
      for (const image of [...detail.requestImages, ...detail.returnImages]) {
        const response = await app.request(image.src, {}, f.env); expect(response.status).toBe(200);
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...f.png]);
        expect(response.headers.get('Content-Type')).toContain('image/png'); expect(response.headers.get('Cache-Control')).toContain('private, no-store');
      }
      expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
    });
    expect(f.r2Reads).toEqual([f.images.ownedKey, f.images.returnedKey]); expect(f.r2Writes).toEqual([]);
  });

  it.each([null, '', '[]'])('distinguishes known empty original evidence from unavailable: %j', async value => {
    await f.db.update(storeOrderRefund).set({ refundImg: value }).where(eq(storeOrderRefund.id, 100));
    const detail = await good(); expect(detail.requestImages).toEqual([]); expect(detail.requestImagesError).toBe('');
    expect(detail.returnImages).toHaveLength(1);
  });

  it.each([0, 1, 2, 3, 4, 5, 6])('reads stored original evidence in exact authorized lifecycle %s without depending on quantity history', async refundType => {
    await f.db.update(storeOrderRefund).set({ refundType, cartInfo: null }).where(eq(storeOrderRefund.id, 100));
    const detail = await good(); expect(detail.application_review.state).toBe('unavailable');
    expect(detail.requestImages).toHaveLength(1); expect(detail.requestImagesError).toBe('');
  });
  it('keeps cancelled exact history readable and does not fetch current catalog evidence', async () => {
    const detail = await good(111); expect(detail.is_cancel).toBe(1); expect(detail.requestImages[0].url).toBe('/api/assets/31');
    await f.db.update(storeOrderCartInfo).set({ cartInfo: '{broken' }).where(eq(storeOrderCartInfo.id, 1001));
    expect((await good()).requestImages[0].url).toBe('/api/assets/31'); expect(f.r2Reads).toEqual([]);
  });

  it.each([
    { name: 'foreign UID', change: { relationId: 12 } }, { name: 'supplier namespace', change: { type: 4 } },
    { name: 'foreign module', change: { moduleType: 4 } }, { name: 'video', change: { fileType: 2 } },
    { name: 'uncontrolled storage', change: { imageType: 1 } },
  ])('never signs a stored canonical reference with mismatched metadata: $name', async ({ change }) => {
    await f.db.update(systemAttachment).set(change).where(eq(systemAttachment.attId, 31));
    const detail = await good(); expect(detail.requestImages).toEqual([]); expect(detail.requestImagesError).toContain('退款申请凭证');
    expect(detail.requestImagesError).not.toContain('退货凭证'); expect(detail.returnImages).toHaveLength(1);
  });

  it.each([
    { name: 'broken JSON', raw: '[' }, { name: 'unsafe active scheme', raw: '["javascript:alert(1)"]' },
    { name: 'foreign mixed list', raw: '["/api/assets/31","/api/assets/32"]' },
    { name: 'missing attachment', raw: '["/api/assets/99999"]' },
    { name: 'duplicate', raw: '["/api/assets/31","/api/assets/31"]' },
    { name: 'ticket persisted', raw: '["/api/assets/31?expires=9&signature=old"]' },
    { name: 'four pictures', raw: '["https://old.invalid/a","https://old.invalid/b","https://old.invalid/c","https://old.invalid/d"]' },
  ])('rejects the complete legacy evidence list without partial signatures: $name', async ({ raw }) => {
    await f.db.update(storeOrderRefund).set({ refundImg: raw }).where(eq(storeOrderRefund.id, 100));
    const detail = await good(); expect(detail.requestImages).toEqual([]); expect(detail.requestImagesError).toBeTruthy();
    expect(detail.returnImages).toHaveLength(1); expect(f.r2Reads).toEqual([]);
  });

  it('bounds real UTF8 TEXT before SQL transport, preserving empty versus over-budget truth', async () => {
    const refs = ['a','b','c'].map(label => 'https://legacy.invalid/' + label + '😀'.repeat(650));
    refs[2] += 'x'.repeat(8192 - new TextEncoder().encode(JSON.stringify(refs)).length);
    const boundary = JSON.stringify(refs); expect(new TextEncoder().encode(boundary).length).toBe(8192);
    await f.db.update(storeOrderRefund).set({ refundImg: boundary }).where(eq(storeOrderRefund.id, 100));
    const accepted = await good(); expect(accepted.requestImages).toEqual(refs.map(url => ({ url, src: url }))); expect(accepted.requestImagesError).toBe('');
    const value = '😀'.repeat(2049); expect(value.length).toBeLessThan(8192);
    await f.db.update(storeOrderRefund).set({ refundImg: value }).where(eq(storeOrderRefund.id, 100));
    await f.withReader(async peer => {
      const [selected] = await peer.db.select({ raw: evidence.supplierRefundApplicationImagesSql }).from(storeOrderRefund).where(eq(storeOrderRefund.id, 100));
      expect(selected.raw).toBe('__invalid__'); expect(selected.raw).not.toBe(value);
    });
    const detail = await good(); expect(detail.requestImages).toEqual([]); expect(detail.requestImagesError).toBeTruthy();
  });
  it('retains bounded original PHP public HTTPS arrays and CSV as historical references, with no owner assertion or backend fetch', async () => {
    const refs = ['https://legacy.invalid/application-a.png', 'https://legacy.invalid/application-b.png'];
    for (const raw of [JSON.stringify(refs), refs.join(',')]) {
      await f.db.update(storeOrderRefund).set({ refundImg: raw }).where(eq(storeOrderRefund.id, 100));
      const detail = await good(); expect(detail.requestImages).toEqual(refs.map(url => ({ url, src: url }))); expect(detail.requestImagesError).toBe('');
    }
    expect(f.r2Reads).toEqual([]);
  });

  it.each(['foreign', 'denied', 'customer', 'admin', 'anonymous'])('denies an unrelated reader without images or SQL side effects: %s', async actor => {
    const token = actor === 'anonymous' ? '' : f.tokens[actor as 'foreign' | 'denied' | 'customer' | 'admin'];
    const result = await read(100, token); expect(result.status).not.toBe(200); expect(JSON.stringify(result)).not.toContain('signature=');
  });
  it('does not disclose another supplier refund and does not turn real attachment42501 into an empty success', async () => {
    expect((await read(900)).status).not.toBe(200);
    await f.withReader(async peer => {
      await f.exec(`REVOKE SELECT ON public.system_attachment FROM "${peer.role}"`);
      const before = await f.snapshot(), sequences = await f.sequences();
      await expect(new SupplierAfterSaleService(peer.container, f.env).detail(7, 100)).rejects.toBeTruthy();
      wiring.container = peer.container; const result = await (await app.request(route(100), { headers: bearer(f.tokens.viewer) }, f.env)).json<Envelope>();
      expect(result.status).not.toBe(200); expect(JSON.stringify(result)).not.toContain('signature=');
      expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
    });
  });

  it('binds attachment ownership and stored references to the same actual RR READ ONLY snapshot', async () => {
    const actual = evidence.previewRefundApplicationEvidence; let reached = false, committed: unknown;
    await f.withReader(async peer => {
      wiring.container = peer.container;
      const spy = vi.spyOn(evidence, 'previewRefundApplicationEvidence').mockImplementationOnce(async (container, uid, value, key) => {
        const [settings] = await container.db.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
        expect(settings).toEqual({ isolation: 'repeatable read', readonly: 'on', timeout: '5s' }); reached = true;
        await f.db.update(systemAttachment).set({ relationId: 12 }).where(eq(systemAttachment.attId, 31));
        await f.db.update(storeOrderRefund).set({ refundImg: '["/api/assets/32"]' }).where(eq(storeOrderRefund.id, 100));
        committed = await f.snapshot(); return actual(container, uid, value, key);
      });
      try {
        const response = await (await app.request(route(100), { headers: bearer(f.tokens.viewer) }, f.env)).json<Envelope>();
        expect(response.status, response.msg).toBe(200); expect(response.data.requestImages[0].url).toBe('/api/assets/31');
        expect(reached).toBe(true); expect(await f.snapshot()).toEqual(committed);
      } finally { spy.mockRestore(); }
    });
    expect((await good()).requestImages).toEqual([]);
  });

  it.each([
    { name: 'modern null', image: { refundImg: null } }, { name: 'modern array', image: { refundImg: ['/api/assets/31'] } },
    { name: 'legacy null', image: { refund_reason_wap_img: null } }, { name: 'alias conflict', image: { refundImg: '["/api/assets/31"]', refund_reason_wap_img: ['/api/assets/33'] } },
    { name: 'foreign canonical', image: { refundImg: '["/api/assets/32"]' } },
    { name: 'signed canonical', image: { refundImg: '["/api/assets/31?expires=9&signature=old"]' } },
    { name: 'four images', image: { refund_reason_wap_img: ['https://legacy.invalid/a','https://legacy.invalid/b','https://legacy.invalid/c','https://legacy.invalid/d'] } },
    { name: 'UTF8 byte excess', image: { refundImg: '😀'.repeat(2049) } },
  ])('ordinary Customer HTTP rejects invalid original evidence before application writes: $name', async ({ image }) => {
    // Real Buyer apiJWT, explicitly owned maintenance SQL. The existing active
    // application does not matter: evidence rejection must precede the writer.
    const [buyer] = await f.db.select({ pwd: user.pwd }).from(user).where(eq(user.uid, 11));
    const token = (await createToken(11, 'api', md5(buyer.pwd), f.env.APP_KEY)).token;
    const before = await f.snapshot(), sequences = await f.sequences();
    const result = await apply({ refundReason: '核对原申请凭证', applyType: 1, cartIds: [1001], ...image }, token);
    expect(result.status).not.toBe(200); expect(result.msg).toContain('退款申请凭证');
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
  });

  it('validates canonical metadata in the ordinary author before any refund write', async () => {
    const [buyer] = await f.db.select({ pwd: user.pwd }).from(user).where(eq(user.uid, 11));
    const token = (await createToken(11, 'api', md5(buyer.pwd), f.env.APP_KEY)).token;
    for (const change of [{ type: 4 }, { moduleType: 4 }, { fileType: 2 }, { imageType: 1 }]) {
      await f.db.update(systemAttachment).set({ type: 3, moduleType: 3, fileType: 1, imageType: 8, ...change }).where(eq(systemAttachment.attId, 31));
      const before = await f.snapshot(), sequences = await f.sequences();
      const result = await apply({ refundReason: '实际已鉴权用户', applyType: 1, cartIds: [1001], refundImg: '["/api/assets/31"]' }, token);
      expect(result.status).not.toBe(200); expect(result.msg).toContain('退款申请凭证不存在');
      expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
    }
  });

  it('keeps exact refund/order tenant, UID, store and visibility checks ahead of any evidence disclosure', async () => {
    for (const change of [{ uid: 12 }, { storeId: 999 }, { supplierId: 8 }, { isDel: 1 }, { isSystemDel: 1 }]) {
      const [original] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, 100));
      await f.db.update(storeOrder).set(change).where(eq(storeOrder.id, 100));
      try { const result = await read(); expect(result.status).not.toBe(200); expect(JSON.stringify(result)).not.toContain('signature='); }
      finally { await f.db.update(storeOrder).set({ uid: original.uid, storeId: original.storeId, supplierId: original.supplierId,
        isDel: original.isDel, isSystemDel: original.isSystemDel }).where(eq(storeOrder.id, 100)); }
    }
  });

  it('persists actual Customer PHP array/CSV/HTTPS aliases, explicit empty and omission without touching later return evidence', async () => {
    const whole = await refundApplicationEvidenceWriterFixture();
    try {
      const refs = ['https://legacy.invalid/first.png', 'https://legacy.invalid/second.png', 'https://legacy.invalid/third.png'];
      const cases = [
        { input: { refund_reason_wap_img: refs.join(',') }, stored: JSON.stringify(refs) },
        { input: { refund_reason_wap_img: refs }, stored: JSON.stringify(refs) },
        { input: { refundImg: JSON.stringify(refs), refund_reason_wap_img: refs }, stored: JSON.stringify(refs) },
        { input: { refundImg: '' }, stored: '[]' },
        { input: {}, stored: '' },
      ];
      for (const current of cases) await whole.withBuyer(async buyer => {
        wiring.container = buyer.container;
        const [cart] = await whole.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, whole.ids.sourceOrder)).orderBy(storeOrderCartInfo.id);
        const response = await (await app.request('/api/order/refund/apply/' + whole.ids.sourceOrder, { method: 'POST',
          headers: { ...bearer(whole.tokens.buyer), 'content-type': 'application/json' }, body: JSON.stringify({
            text: 'PHP原申请字段', refund_type: 1, cart_ids: [{ cart_id: Number(cart.cartId), cart_num: 1 }], ...current.input }) }, whole.env)).json<Envelope>();
        expect(response.status, response.msg).toBe(200);
        const [stored] = await whole.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, response.data.refundId));
        expect(stored.refundImg).toBe(current.stored); expect(stored.refundGoodsImg).toBeNull();
        await whole.withReader(async reader => {
          wiring.container = reader.container; const before = await whole.snapshot(), sequences = await whole.sequences();
          const result = await (await app.request(route(stored.id), { headers: bearer(whole.tokens.viewer) }, whole.env)).json<Envelope>();
          expect(result.status, result.msg).toBe(200); expect(result.data.requestImagesError).toBe('');
          expect(result.data.requestImages).toEqual((current.stored === '' || current.stored === '[]' ? [] : refs).map(url => ({ url, src: url })));
          expect(await whole.snapshot()).toEqual(before); expect(await whole.sequences()).toEqual(sequences);
        });
        wiring.container = buyer.container;
        const cancelled = await (await app.request('/api/order/refund/cancel/' + stored.id, { method: 'POST', headers: bearer(whole.tokens.buyer) }, whole.env)).json<Envelope>();
        expect(cancelled.status, cancelled.msg).toBe(200);
      });
      expect(whole.r2Reads).toEqual([]); expect(whole.r2Writes).toEqual([]);
    } finally { await whole.close(); }
  }, 120000);

  it('connects real registered checkout, Customer multipart upload and apply, and Supplier SELECT-only detail plus signed PNG without provider calls', async () => {
    const whole = await refundApplicationEvidenceWriterFixture();
    try {
      let uploaded!: { url: string; src: string; att_id: number }, refundId = 0;
      await whole.withBuyer(async buyer => {
        wiring.container = buyer.container; expect(buyer.sqlBoundary).toBe('maintenance');
        const orderRead = await (await app.request('/api/order/detail/' + whole.ids.publicOrderId, { headers: bearer(whole.tokens.buyer) }, whole.env)).json<Envelope>();
        expect(orderRead.status, orderRead.msg).toBe(200); expect(orderRead.data.id).toBe(whole.ids.sourceOrder);
        const data = new FormData(); data.append('file', new File([whole.png], 'application-original.png', { type: 'image/png' })); data.append('pid', '0');
        const request = new Request('https://owned.invalid', { method: 'POST', body: data }), body = await request.arrayBuffer();
        const response = await app.request('/api/upload/image', { method: 'POST', headers: { ...bearer(whole.tokens.buyer),
          'content-type': request.headers.get('content-type')!, 'content-length': String(body.byteLength) }, body }, whole.env);
        const envelope = await response.json<Envelope>(); expect(envelope.status, envelope.msg).toBe(200); uploaded = envelope.data;
        const [metadata] = await whole.db.select().from(systemAttachment).where(eq(systemAttachment.attId, uploaded.att_id));
        expect(metadata).toMatchObject({ relationId: 11, type: 3, moduleType: 3, fileType: 1, imageType: 8, attDir: uploaded.url });
        const [cart] = await whole.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, whole.ids.sourceOrder)).orderBy(storeOrderCartInfo.id);
        const result = await (await app.request('/api/order/refund/apply/' + whole.ids.sourceOrder, { method: 'POST', headers: {
          ...bearer(whole.tokens.buyer), 'content-type': 'application/json' }, body: JSON.stringify({ refundReason: '上传原始凭证后只退一件', applyType: 1,
            refundImg: JSON.stringify([uploaded.url]), refund_reason_wap_img: [uploaded.url], cart_ids: [{ cart_id: Number(cart.cartId), cart_num: 1 }] }) }, whole.env)).json<Envelope>();
        expect(result.status, result.msg).toBe(200); refundId = result.data.refundId;
      });
      const [stored] = await whole.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, refundId));
      expect(stored.refundImg).toBe(JSON.stringify([uploaded.url])); expect(stored.refundImg).not.toContain('signature');
      expect(readRefundQuantityReservation(stored)?.version).toBe('refund-quantity-reservation-v1');
      await whole.withReader(async reader => {
        wiring.container = reader.container;
        const [rights] = await reader.db.execute(sql`SELECT current_user=session_user AS independent,
          has_table_privilege(current_user,'store_order_refund','UPDATE') AS updates,has_schema_privilege(current_user,'public','CREATE') AS creates`);
        expect(rights).toEqual({ independent: true, updates: false, creates: false });
        const before = await whole.snapshot(), sequences = await whole.sequences();
        const result = await (await app.request(route(refundId), { headers: bearer(whole.tokens.viewer) }, whole.env)).json<Envelope>();
        expect(result.status, result.msg).toBe(200); expect(result.data.requestImagesError).toBe('');
        expect(result.data.requestImages).toEqual([{ url: uploaded.url, src: expect.stringContaining(uploaded.url + '?expires=') }]);
        expect(result.data.returnImages).toEqual([]); expect(result.data.application_review.items[0].quantity).toBe(1);
        const response = await app.request(result.data.requestImages[0].src, {}, whole.env); expect(response.status).toBe(200);
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...whole.png]); expect(response.headers.get('Cache-Control')).toContain('private, no-store');
        expect(await whole.snapshot()).toEqual(before); expect(await whole.sequences()).toEqual(sequences);
      });
      expect(whole.r2Writes).toHaveLength(1); expect(whole.r2Reads).toHaveLength(1);
    } finally { await whole.close(); }
  }, 120000);
});
