import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, systemAttachment } from '@/models/schema';
import { CustomerRefundReadService } from '@/services/order/CustomerRefundReadService';
import * as evidence from '@/services/order/RefundApplicationEvidence';
import { refundApplicationEvidenceWriterFixture } from './helpers/refundApplicationEvidence';
import { customerRefundRequestImagesFixture, grantCustomerRefundImageReader } from './helpers/customerRefundRequestImages';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned Customer image App boundary'); return wiring.container;
} }));
const app = createApp();
type Envelope = { status: number; msg: string; data: any };
const route = (id: number | string) => '/api/order/refund/detail/' + id + '?view=customer';
const bearer = (token: string) => ({ Authorization: 'Bearer ' + token });

/** The new read uses actual apiJWT and an independently authenticated SELECT-only
 * LOGIN. Registered application authors keep their explicit maintenance boundary. */
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Customer original refund images actual App JWT owned PG16', () => {
  let f: Awaited<ReturnType<typeof customerRefundRequestImagesFixture>>;
  beforeEach(async () => {
    f = await customerRefundRequestImagesFixture(); wiring.container = f.container;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Customer image acceptance forbids provider dispatch'));
  }, 30000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.container = undefined; vi.restoreAllMocks(); await f?.close(); }
  }, 30000);

  async function read(id: number | string = 100, token = f.tokens.customer) {
    return f.withReader(async peer => {
      wiring.container = peer.container;
      const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,
        has_table_privilege(current_user,'user','SELECT') AS authenticates,
        has_table_privilege(current_user,'user','UPDATE') AS user_updates,
        has_table_privilege(current_user,'store_order_refund','UPDATE') AS refund_updates,
        has_table_privilege(current_user,'system_attachment','INSERT') AS attachment_inserts,
        has_schema_privilege(current_user,'public','CREATE') AS creates`);
      expect(rights).toEqual({ independent: true, authenticates: true, user_updates: false,
        refund_updates: false, attachment_inserts: false, creates: false });
      const before = await f.snapshot(), sequences = await f.sequences(), writes = f.r2Writes.length, deletes = f.r2Deletes.length;
      const response = await app.request(route(id), { headers: bearer(token) }, f.env);
      const body = await response.json<Envelope>();
      if (body.status === 200) expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
      expect(f.r2Writes).toHaveLength(writes); expect(f.r2Deletes).toHaveLength(deletes);
      return body;
    });
  }
  async function good(id = 100) { const result = await read(id); expect(result.status, result.msg).toBe(200); return result.data; }

  it('reads original and returned images as independent fields, streams exact owned bytes and keeps list free of image payload', async () => {
    const detail = await good();
    expect(detail.requestImagesError).toBe(''); expect(detail.returnImagesError).toBe('');
    expect(detail.requestImages).toEqual([{ url: '/api/assets/31', src: expect.stringContaining('/api/assets/31?expires=') }]);
    expect(detail.returnImages).toEqual([{ url: '/api/assets/33', src: expect.stringContaining('/api/assets/33?expires=') }]);
    for (const key of ['refundImg', 'refund_img', 'requestImageJson', 'returnImageJson', 'cartInfo', 'orderInfo']) expect(detail).not.toHaveProperty(key);
    await f.withReader(async peer => {
      wiring.container = peer.container;
      const before = await f.snapshot(), sequences = await f.sequences();
      const page = await (await app.request('/api/order/refund/list?view=customer', { headers: bearer(f.tokens.customer) }, f.env)).json<Envelope>();
      expect(page.status, page.msg).toBe(200);
      for (const item of page.data.items) for (const key of ['requestImages', 'requestImagesError', 'refundImg', 'refund_img', 'returnImages']) expect(item).not.toHaveProperty(key);
      for (const image of [...detail.requestImages, ...detail.returnImages]) {
        const response = await app.request(image.src, {}, f.env); expect(response.status).toBe(200);
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...f.png]);
        expect(response.headers.get('Content-Type')).toContain('image/png');
        expect(response.headers.get('Cache-Control')).toContain('private, no-store');
      }
      expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
    });
    expect(f.r2Reads).toEqual([f.images.ownedKey, f.images.returnedKey]); expect(f.r2Writes).toEqual([]); expect(f.r2Deletes).toEqual([]);
  });

  it.each([{ name: 'SQL NULL', raw: null }, { name: 'old empty TEXT', raw: '' }, { name: 'empty JSON list', raw: '[]' }])
    ('reports known empty original images separately from later return evidence: $name', async ({ raw }) => {
      await f.db.update(storeOrderRefund).set({ refundImg: raw }).where(eq(storeOrderRefund.id, 100));
      const detail = await good(); expect(detail.requestImages).toEqual([]); expect(detail.requestImagesError).toBe('');
      expect(detail.returnImages).toHaveLength(1);
    });

  it.each([0, 1, 2, 3, 4, 5, 6])('reads stored original images in already authorized refund state %s even when goods history is unavailable', async refundType => {
    await f.db.update(storeOrderRefund).set({ refundType, cartInfo: null }).where(eq(storeOrderRefund.id, 100));
    const detail = await good(); expect(detail.items).toEqual([]); expect(detail.itemsError).toBeTruthy();
    expect(detail.requestImages).toHaveLength(1); expect(detail.requestImagesError).toBe('');
  });
  it('keeps cancelled and legacy goods histories independent from original image availability', async () => {
    const cancelled = await good(111); expect(cancelled.isCancel).toBe(1); expect(cancelled.requestImages[0].url).toBe('/api/assets/31');
    const legacy = await good(201); expect(legacy.itemsError).toBeTruthy(); expect(legacy.requestImages[0].url).toBe('/api/assets/31');
    await f.db.update(storeOrderCartInfo).set({ cartInfo: '{broken' }).where(eq(storeOrderCartInfo.id, 1001));
    const broken = await good(); expect(broken.itemsError).toBeTruthy(); expect(broken.requestImages[0].url).toBe('/api/assets/31');
    expect(f.r2Reads).toEqual([]);
  });

  it.each([
    { name: 'another buyer', change: { relationId: 12 } }, { name: 'Supplier namespace', change: { type: 4 } },
    { name: 'another module', change: { moduleType: 4 } }, { name: 'video file', change: { fileType: 2 } },
    { name: 'uncontrolled storage', change: { imageType: 1 } },
  ])('does not sign a canonical original with wrong metadata: $name', async ({ change }) => {
    await f.db.update(systemAttachment).set(change).where(eq(systemAttachment.attId, 31));
    const detail = await good(); expect(detail.requestImages).toEqual([]); expect(detail.requestImagesError).toContain('申请凭证');
    expect(detail.returnImages).toHaveLength(1); expect(detail.returnImagesError).toBe(''); expect(f.r2Reads).toEqual([]);
  });

  it.each([
    { name: 'malformed JSON', raw: '[' }, { name: 'mixed owned and foreign', raw: '["/api/assets/31","/api/assets/32"]' },
    { name: 'stored private ticket', raw: '["/api/assets/31?expires=9&signature=old"]' },
    { name: 'four public references', raw: '["https://old.invalid/a","https://old.invalid/b","https://old.invalid/c","https://old.invalid/d"]' },
  ])('rejects an entire original list without partial signing: $name', async ({ raw }) => {
    await f.db.update(storeOrderRefund).set({ refundImg: raw }).where(eq(storeOrderRefund.id, 100));
    const detail = await good(); expect(detail.requestImages).toEqual([]); expect(detail.requestImagesError).toBeTruthy();
    expect(detail.returnImages).toHaveLength(1); expect(f.r2Reads).toEqual([]);
  });

  it('retains bounded PHP public HTTPS JSON and CSV as references without uploader or backend-fetch claims', async () => {
    const images = ['https://legacy.invalid/request-a.png', 'https://legacy.invalid/request-b.png'];
    for (const raw of [JSON.stringify(images), images.join(',')]) {
      await f.db.update(storeOrderRefund).set({ refundImg: raw }).where(eq(storeOrderRefund.id, 100));
      const detail = await good(); expect(detail.requestImages).toEqual(images.map(url => ({ url, src: url }))); expect(detail.requestImagesError).toBe('');
    }
    expect(f.r2Reads).toEqual([]);
  });
  it('accepts exactly8192 UTF8 bytes and passes an SQL sentinel instead of oversized TEXT into the image projector', async () => {
    const images = ['a', 'b', 'c'].map(label => 'https://legacy.invalid/' + label + '😀'.repeat(650));
    images[2] += 'x'.repeat(8192 - new TextEncoder().encode(JSON.stringify(images)).length);
    const boundary = JSON.stringify(images); expect(new TextEncoder().encode(boundary).length).toBe(8192);
    await f.db.update(storeOrderRefund).set({ refundImg: boundary }).where(eq(storeOrderRefund.id, 100));
    expect((await good()).requestImages).toEqual(images.map(url => ({ url, src: url })));
    const oversized = '😀'.repeat(2049); expect(oversized.length).toBeLessThan(8192);
    await f.db.update(storeOrderRefund).set({ refundImg: oversized }).where(eq(storeOrderRefund.id, 100));
    const actual = evidence.previewRefundApplicationEvidence; let observed = false;
    const spy = vi.spyOn(evidence, 'previewRefundApplicationEvidence').mockImplementationOnce(async (container, uid, raw, key) => {
      expect(raw).toBe('__invalid__'); expect(raw).not.toBe(oversized); observed = true;
      return actual(container, uid, raw, key);
    });
    try { const detail = await good(); expect(detail.requestImages).toEqual([]); expect(detail.requestImagesError).toBeTruthy(); }
    finally { spy.mockRestore(); }
    expect(observed).toBe(true);
  });

  it('denies foreign Customer, Supplier and anonymous identities and malformed exact IDs without image disclosure', async () => {
    for (const token of [f.tokens.foreignCustomer, f.tokens.viewer, '']) {
      const result = await read(100, token); expect(result.status).not.toBe(200); expect(JSON.stringify(result)).not.toContain('signature=');
    }
    for (const id of ['0', '0100', '100junk']) expect((await read(id)).status).not.toBe(200);
  });
  it('requires refund and original-order UID coherence and hides deleted applications while allowing the same buyer at another merchant', async () => {
    const otherMerchant = await good(900); expect(otherMerchant.uid).toBe(11);
    await f.db.update(storeOrder).set({ uid: 12 }).where(eq(storeOrder.id, 100));
    expect((await read()).status).not.toBe(200);
    await f.db.update(storeOrder).set({ uid: 11 }).where(eq(storeOrder.id, 100));
    await f.db.update(storeOrderRefund).set({ uid: 12 }).where(eq(storeOrderRefund.id, 100));
    expect((await read()).status).not.toBe(200); expect((await read(100, f.tokens.foreignCustomer)).status).not.toBe(200);
    await f.db.update(storeOrderRefund).set({ uid: 11, isDel: 1 }).where(eq(storeOrderRefund.id, 100));
    expect((await read()).status).not.toBe(200);
  });
  it('does not turn a real attachment42501 into successful empty original evidence', async () => {
    expect((await good()).requestImages).toHaveLength(1);
    await f.withReader(async peer => {
      await f.exec(`REVOKE SELECT ON public.system_attachment FROM "${peer.role}"`);
      // Remove later evidence so only the new original-image read hits the
      // missing privilege, rather than failing at an older return-image query.
      await f.db.update(storeOrderRefund).set({ refundGoodsImg: null }).where(eq(storeOrderRefund.id, 100));
      const before = await f.snapshot(), sequences = await f.sequences();
      await expect(new CustomerRefundReadService(peer.container, f.env.APP_KEY).detail(11, '100', new URLSearchParams('view=customer')))
        .rejects.toMatchObject({ cause: { code: '42501', message: expect.stringContaining('system_attachment') } });
      wiring.container = peer.container;
      const result = await (await app.request(route(100), { headers: bearer(f.tokens.customer) }, f.env)).json<Envelope>();
      expect(result.status).not.toBe(200); expect(JSON.stringify(result)).not.toContain('signature=');
      expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
    });
  });
  it('reads references and attachment ownership from one actual RR READ ONLY snapshot despite an independent committed change', async () => {
    const actual = evidence.previewRefundApplicationEvidence; let reached = false, committed: unknown;
    await f.withReader(async peer => {
      wiring.container = peer.container;
      const spy = vi.spyOn(evidence, 'previewRefundApplicationEvidence').mockImplementationOnce(async (container, uid, raw, key) => {
        const [settings] = await container.db.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
        expect(settings).toEqual({ isolation: 'repeatable read', readonly: 'on', timeout: '5s' }); reached = true;
        await f.db.update(systemAttachment).set({ relationId: 12 }).where(eq(systemAttachment.attId, 31));
        await f.db.update(storeOrderRefund).set({ refundImg: '["/api/assets/32"]' }).where(eq(storeOrderRefund.id, 100));
        committed = await f.snapshot(); return actual(container, uid, raw, key);
      });
      const sequences = await f.sequences();
      try {
        const response = await (await app.request(route(100), { headers: bearer(f.tokens.customer) }, f.env)).json<Envelope>();
        expect(response.status, response.msg).toBe(200); expect(response.data.requestImages[0].url).toBe('/api/assets/31');
        expect(reached).toBe(true); expect(await f.snapshot()).toEqual(committed); expect(await f.sequences()).toEqual(sequences);
      } finally { spy.mockRestore(); }
      const [after] = await peer.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly`);
      expect(after.readonly).toBe('off');
    });
    const next = await good(); expect(next.requestImages).toEqual([]); expect(next.requestImagesError).toBeTruthy();
  });

  it('joins actual registered checkout and multipart application author to Customer SELECT-only detail and signed original bytes', async () => {
    const whole = await refundApplicationEvidenceWriterFixture();
    try {
      let uploaded!: { url: string; src: string; att_id: number }, refundId = 0;
      await whole.withBuyer(async buyer => {
        wiring.container = buyer.container; expect(buyer.sqlBoundary).toBe('maintenance');
        const data = new FormData(); data.append('file', new File([whole.png], 'original-request.png', { type: 'image/png' })); data.append('pid', '0');
        const request = new Request('https://owned.invalid', { method: 'POST', body: data }), body = await request.arrayBuffer();
        const upload = await (await app.request('/api/upload/image', { method: 'POST', headers: { ...bearer(whole.tokens.buyer),
          'content-type': request.headers.get('content-type')!, 'content-length': String(body.byteLength) }, body }, whole.env)).json<Envelope>();
        expect(upload.status, upload.msg).toBe(200); uploaded = upload.data;
        const [metadata] = await whole.db.select().from(systemAttachment).where(eq(systemAttachment.attId, uploaded.att_id));
        expect(metadata).toMatchObject({ relationId: 11, type: 3, moduleType: 3, fileType: 1, imageType: 8, attDir: uploaded.url });
        const [cart] = await whole.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, whole.ids.sourceOrder)).orderBy(storeOrderCartInfo.id);
        const result = await (await app.request('/api/order/refund/apply/' + whole.ids.sourceOrder, { method: 'POST', headers: {
          ...bearer(whole.tokens.buyer), 'content-type': 'application/json' }, body: JSON.stringify({ refundReason: '申请图提交后买家自己核对', applyType: 1,
          refundImg: JSON.stringify([uploaded.url]), cart_ids: [{ cart_id: Number(cart.cartId), cart_num: 1 }] }) }, whole.env)).json<Envelope>();
        expect(result.status, result.msg).toBe(200); refundId = result.data.refundId;
      });
      const [stored] = await whole.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, refundId));
      expect(stored.refundImg).toBe(JSON.stringify([uploaded.url])); expect(stored.refundImg).not.toContain('signature');
      await whole.withReader(async peer => {
        await grantCustomerRefundImageReader(peer.role, whole.exec); wiring.container = peer.container;
        const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,
          has_table_privilege(current_user,'store_order_refund','UPDATE') AS updates,
          has_table_privilege(current_user,'user','UPDATE') AS user_updates,has_schema_privilege(current_user,'public','CREATE') AS creates`);
        expect(rights).toEqual({ independent: true, updates: false, user_updates: false, creates: false });
        const before = await whole.snapshot(), sequences = await whole.sequences(), writes = whole.r2Writes.length;
        const detail = await (await app.request(route(refundId), { headers: bearer(whole.tokens.buyer) }, whole.env)).json<Envelope>();
        expect(detail.status, detail.msg).toBe(200); expect(detail.data.uid).toBe(11); expect(detail.data.itemsError).toBe('');
        expect(detail.data.requestImages).toEqual([{ url: uploaded.url, src: expect.stringContaining(uploaded.url + '?expires=') }]);
        expect(detail.data.returnImages).toEqual([]); expect(detail.data.requestImagesError).toBe(''); expect(detail.data).not.toHaveProperty('refundImg');
        const response = await app.request(detail.data.requestImages[0].src, {}, whole.env); expect(response.status).toBe(200);
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...whole.png]);
        expect(await whole.snapshot()).toEqual(before); expect(await whole.sequences()).toEqual(sequences); expect(whole.r2Writes).toHaveLength(writes);
      });
      expect(whole.r2Writes).toHaveLength(1); expect(whole.r2Reads).toHaveLength(1); expect(whole.r2Deletes).toEqual([]);
    } finally { await whole.close(); }
  }, 120000);
});
