import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainer, createContainerFromDb, withTx } from '../src/lib/di';
import { adminRuntimeAuthMiddleware } from '../src/middleware/admin-runtime-auth';
import { adminAssistedCartAdd, adminAssistedConfirm, adminAssistedComputed, adminAssistedCreate,
  adminAssistedFormImage, adminAssistedFormPreview, adminAssistedOrderForm,
  adminAssistedPay, adminAssistedPayStatus, adminAssistedPlaceDetail, adminAssistedPlaceList } from '../src/controllers/api/v1/AdminController';
import { createToken, md5 } from '../src/utils/jwt';
import { refundRuntimeFixture, shipping } from './helpers/refundRuntimeFixture';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox, systemAttachment, systemForm } from '../src/models/schema';
import { assistedFormAttachmentScope, assistedFormAttachmentKey } from '../src/services/system/AssistedFormAttachmentScope';
import { AttachmentService } from '../src/services/system/AttachmentService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { readOrderSystemFormForOrder } from '../src/services/order/OrderSystemFormService';
import * as orderForms from '../src/services/order/OrderSystemFormService';
import { allocatePaidOrderBySupplier } from '../src/services/order/OrderSupplierAllocationService';
import { recordSupplierPayment } from '../src/services/supplier/SupplierFinanceService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { enqueueOrderDeliveryNoticeEvent, processOrderNotificationOutboxEvent } from '../src/services/order/OrderNotificationOutboxService';

type Reply<T> = { status: number; msg: string; data: T };
type Quote = { orderKey: string; quoteToken: string };
type Created = { result: { order_id: string; extended: boolean } };
type Form = Array<{ name: string; value: unknown; assistedImageScope?: unknown }>;
const template = [{ id: 'text', name: 'texts', value: '' },
  { id: 'image', name: 'uploadPicture', value: [], titleShow: { val: true }, assistedImageScope: { digest: 'forged-template' } }];
const answers = (reference: string) => [{ id: 'text', value: 'Local synthetic answer' },
  { id: 'image', value: [reference], assistedImageScope: { digest: 'forged-client' } }];

describe('assisted form upload -> authenticated create -> scoped read on independent PG16 LOGINs', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    await f.exec(`INSERT INTO system_role(id,role_name,rules,status) VALUES (1,'Local assisted','order.assisted',1),(2,'Local reader','order.view',1);
      INSERT INTO system_admin(id,account,pwd,admin_type,level,roles) VALUES
        (1,'local-a','local-hash',1,1,'1'),(2,'local-b','local-hash',1,1,'1'),(3,'local-read','local-hash',1,1,'2');
      SELECT setval('public.store_cart_id_seq',(SELECT max(id) FROM public.store_cart));
      UPDATE store_product SET system_form_id=77 WHERE id=70;`);
    await f.db.insert(systemForm).values({ id: 77, name: 'Local form', value: JSON.stringify(template), status: 1 });
  }, 60_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30_000);
  type Role = Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (r: infer R) => unknown ? R : never;
  async function scenario(run: (client: Awaited<ReturnType<typeof http>>, role: Role) => Promise<void>) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS database');
      const names = { app: app.role, admin: admin.role, maintenance: 'finance_test' };
      await runRuntimeBusinessCommissioning(f.db, { ...names, database: String(identity.database), pricingOwner: f.pricingOwner });
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const)
        expect(await auditRuntimeBusinessPrivileges(peer.db, kind, names)).toMatchObject({ ready: true, failures: [] });
      await run(await http(app, admin), app);
      expect((await f.exec(`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database()
        AND application_name IN ('cinashop_api','cinashop_admin')`))[0].n).toBe(0);
    }));
  }
  async function http(appRole: Role, adminRole: Role) {
    let serial = 0;
    const put = vi.fn(async (key: string, bytes: ReadableStream) => ({ key, size: (await new Response(bytes).arrayBuffer()).byteLength }));
    const env = Object.assign(f.env, { APP_KEY: 'local-form-consumption-only', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      HYPERDRIVE: { connectionString: appRole.connectionString }, HYPERDRIVE_ADMIN: { connectionString: adminRole.connectionString },
      SEQUENCE: { idFromName: () => 'local', get: () => ({ fetch: async () => new Response('local_form_' + (++serial)) }) },
      ORDER_QUEUE: { sendBatch: async () => {}, send: async () => {} }, ASSETS_BUCKET: { put, delete: vi.fn(async () => {}) },
    }) as Env;
    const tokens = await Promise.all([1, 2, 3].map(async id => (await createToken(id, 'admin', md5('local-hash'), env.APP_KEY)).token));
    const customerToken = (await createToken(11, 'api', md5('local-hash'), env.APP_KEY)).token;
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      const container = createContainer(c.env); c.set('container', container);
      try { await next(); } finally { await container.db.$client.end({ timeout: 5 }); }
    });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    const auth = adminRuntimeAuthMiddleware();
    app.post('/api/admin/order/cart/add/:uid', auth, adminAssistedCartAdd);
    app.post('/api/admin/order/confirm/:uid', auth, adminAssistedConfirm);
    app.post('/api/admin/order/computed/:key/:uid', auth, adminAssistedComputed);
    app.post('/api/admin/order/create/:key/:uid', auth, adminAssistedCreate);
    app.post('/api/admin/order/form_image/:key/:uid', auth, adminAssistedFormImage);
    app.post('/api/admin/order/form_preview/:key/:uid', auth, adminAssistedFormPreview);
    app.get('/api/admin/order/form/:orderId/:uid', auth, adminAssistedOrderForm);
    app.get('/api/admin/order/place/detail/:orderId', auth, adminAssistedPlaceDetail);
    app.get('/api/admin/order/place/list', auth, adminAssistedPlaceList);
    app.get('/api/admin/order/pay/status', auth, adminAssistedPayStatus);
    app.post('/api/admin/order/pay/:uid', auth, adminAssistedPay);
    const headers = (actor: number): Record<string, string> => actor ? { Authorization: 'Bearer ' + (actor === -1 ? customerToken : tokens[actor - 1]) } : {};
    async function request<T>(method: string, path: string, body?: object, actor = 1) {
      const response = await app.request('/api/admin/order/' + path, { method, headers: { 'content-type': 'application/json', ...headers(actor) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
      return { response, body: await response.json<Reply<T>>() };
    }
    const post = async <T>(path: string, body: object, actor = 1) => (await request<T>('POST', path, body, actor)).body;
    async function confirm(uid: number, actor = 1, tourist = 'local_guest_a') {
      const added = await post<{ cartId: number }>('cart/add/' + uid, { productId: 70, uniqueId: 'qared001', cartNum: 2, new: 1, tourist_uid: tourist }, actor);
      expect(added.status, added.msg).toBe(200);
      const body = { cartId: [added.data.cartId], new: 1, tourist_uid: tourist, useIntegral: true, payType: 'weixin',
        ...(uid ? { addressId: 11 } : { manualAddress: { realName: 'Local Guest', phone: '00000000000', province: '本地省', city: '测试甲市',
          district: '测试甲区', cityId: 101, detail: 'Local synthetic address' } }) };
      const quote = await post<Quote>('confirm/' + uid, body, actor);
      expect(quote.status, quote.msg).toBe(200); return { body, quote: quote.data };
    }
    async function upload(key: string, uid: number) {
      const form = new FormData(); form.append('file', new File([new Uint8Array([137,80,78,71,13,10,26,10])], 'local.png', { type: 'image/png' }));
      const encoded = new Response(form), body = await encoded.arrayBuffer();
      const response = await app.request(`/api/admin/order/form_image/${key}/${uid}`, { method: 'POST', body,
        headers: { ...headers(1), 'content-type': encoded.headers.get('content-type')!, 'content-length': String(body.byteLength) } }, env);
      const result = await response.json<Reply<{ att_id: number; url: string }>>();
      expect(result.status, result.msg).toBe(200);
      return result.data;
    }
    return { post, confirm, upload, env, request };
  }
  const business = async () => ({ state: await f.state(), forms: await f.exec('SELECT * FROM system_form_data ORDER BY id') });

  it('reads only this actor’s payment roots with a bounded private projection, including split roots', async () => {
    await scenario(async client => {
      const [root] = await f.db.insert(storeOrder).values({ orderId: 'local_detail_root', unique: 'local-detail-root',
        uid: 11, staffId: 1, isChannel: 2, paid: 1, payPrice: '12.50', totalNum: 2, addTime: 101,
        payType: 'cash', shippingType: 1, realName: 'PRIVATE-CUSTOMER-NAME', userPhone: '00000000000',
        userAddress: 'PRIVATE-ADDRESS', customForm: 'PRIVATE-FORM' }).returning({ id: storeOrder.id });
      const [split] = await f.db.insert(storeOrder).values({ orderId: 'local_detail_split', unique: 'local-detail-split',
        uid: 0, staffId: 1, isChannel: 2, pid: -1, paid: 1, payPrice: '8.00', totalNum: 1,
        payType: 'cash', realName: 'PRIVATE-GUEST' }).returning({ id: storeOrder.id });
      await f.db.insert(storeOrderCartInfo).values([
        { oid: root.id, uid: 11, cartId: '71', productId: 70, cartNum: 2, unique: 'detail-product-root',
          cartInfo: JSON.stringify({ productInfo: { store_name: 'Local product' }, sku: { suk: 'Standard', price: '6.25' },
            privateForm: 'PRIVATE-CART-FORM' }) },
        { oid: split.id, uid: 0, cartId: '72', productId: 71, cartNum: 1, unique: 'detail-product-split',
          cartInfo: JSON.stringify({ productInfo: { store_name: 'Split original' }, sku: { suk: 'Blue', price: '8.00' } }) },
      ]);
      const [child] = await f.db.insert(storeOrder).values({ orderId: 'local_detail_child', unique: 'local-detail-child',
        uid: 0, staffId: 1, isChannel: 2, pid: split.id, paid: 1 }).returning({ id: storeOrder.id });
      const [foreign] = await f.db.insert(storeOrder).values({ orderId: 'local_detail_foreign', unique: 'local-detail-foreign',
        uid: 11, staffId: 2, isChannel: 2 }).returning({ id: storeOrder.id });
      const [ordinary] = await f.db.insert(storeOrder).values({ orderId: 'local_detail_ordinary', unique: 'local-detail-ordinary',
        uid: 11, staffId: 1, isChannel: 0 }).returning({ id: storeOrder.id });
      const [deleted] = await f.db.insert(storeOrder).values({ orderId: 'local_detail_deleted', unique: 'local-detail-deleted',
        uid: 11, staffId: 1, isChannel: 2, isDel: 1 }).returning({ id: storeOrder.id });
      const [systemDeleted] = await f.db.insert(storeOrder).values({ orderId: 'local_detail_system_deleted', unique: 'local-detail-system-deleted',
        uid: 11, staffId: 1, isChannel: 2, isSystemDel: 1 }).returning({ id: storeOrder.id });
      const [prefixed] = await f.db.insert(storeOrder).values({ orderId: '123_local_detail', unique: 'local-detail-prefixed',
        uid: 11, staffId: 1, isChannel: 2 }).returning({ id: storeOrder.id });
      const [aliasTarget] = await f.db.insert(storeOrder).values({ orderId: 'local_detail', unique: 'local-detail-alias-target',
        uid: 11, staffId: 1, isChannel: 2, paid: 1 }).returning({ id: storeOrder.id });
      const longestOrderId = 'a'.repeat(32);
      const [longest] = await f.db.insert(storeOrder).values({ orderId: longestOrderId, unique: 'local-detail-max-length',
        uid: 11, staffId: 1, isChannel: 2, paid: 1 }).returning({ id: storeOrder.id });
      const [overflow] = await f.db.insert(storeOrder).values({ orderId: 'local_detail_overflow', unique: 'local-detail-overflow',
        uid: 11, staffId: 1, isChannel: 2 }).returning({ id: storeOrder.id });
      await f.db.insert(storeOrderCartInfo).values(Array.from({ length: 201 }, (_, index) => ({
        oid: overflow.id, uid: 11, cartId: String(1000 + index), productId: 70, cartNum: 1,
        unique: `detail-overflow-${index}`, cartInfo: '{}',
      })));

      const owned = await client.request<unknown>('GET', 'place/detail/local_detail_root');
      expect(owned.body.status, owned.body.msg).toBe(200);
      expect(owned.body.data).toEqual({ order_id: 'local_detail_root', uid: 11, paid: 1,
        pay_price: '12.50', total_num: 2, add_time: 101, pay_type: 'cash', shipping_type: 1,
        _status: { _title: '待发货' }, split: false,
        items: [{ id: expect.any(Number), product_id: 70, store_name: 'Local product', suk: 'Standard', cart_num: 2, price: '6.25' }] });
      expect(JSON.stringify(owned.body.data)).not.toMatch(/PRIVATE-|user_phone|user_address|cartInfo|customForm/);
      expect((await client.request('GET', 'place/detail/123_local_detail')).body).toMatchObject({
        status: 200, data: { order_id: '123_local_detail' },
      });
      expect((await client.request('GET', 'pay/status?order_id=123_local_detail')).body).toMatchObject({
        status: 200, data: { order_id: '123_local_detail', status: false },
      });
      expect((await client.request('GET', 'pay/status?order_id=456_local_detail')).body).toMatchObject({
        status: 200, data: { order_id: 'local_detail', status: true },
      });
      expect((await client.request('GET', `pay/status?order_id=123_${longestOrderId}`)).body).toMatchObject({
        status: 200, data: { order_id: longestOrderId, status: true },
      });
      expect((await client.request('GET', `pay/status?order_id=123_${longestOrderId}a`)).body.status).not.toBe(200);
      expect(await client.post('pay/11', { uni: '456_local_detail', paytype: 'cash' })).toMatchObject({
        status: 400, msg: '订单不存在',
      });
      expect((await client.request('GET', 'form/456_local_detail/11')).body).toMatchObject({
        status: 400, msg: '订单不存在',
      });
      expect((await client.request('GET', 'pay/status?order_id=123_local_detail', undefined, 2)).body).toMatchObject({
        status: 400, msg: '订单不存在',
      });
      expect((await client.request('GET', 'pay/status?order_id=123_local_detail', undefined, 3)).body.status).not.toBe(200);
      expect((await client.request('GET', 'place/detail/local_detail_overflow')).body).toMatchObject({
        status: 400, msg: '订单商品超过展示上限',
      });
      const splitDetail = await client.request<unknown>('GET', 'place/detail/local_detail_split');
      expect(splitDetail.body).toMatchObject({ status: 200, data: { order_id: 'local_detail_split', uid: 0,
        split: true, _status: { _title: '已拆分' }, items: [{ store_name: 'Split original' }] } });
      const oldList = await client.request<unknown>('GET', 'place/list?page=1&limit=10');
      expect(oldList.response.status).toBe(400);
      expect(oldList.response.headers.get('cache-control')).toMatch(/no-store/);
      expect(oldList.body).toEqual({ status: 400, msg: '客户端版本过低，请升级后查看代客订单记录', data: null });
      const list = await client.request<{ list: Array<{ order_id: string; _status: { _title: string } }>;
        next_cursor: string | null; has_more: boolean }>('GET', 'place/list?paging=cursor');
      expect(list.body.status, list.body.msg).toBe(200);
      expect(list.response.headers.get('cache-control')).toMatch(/no-store/);
      expect(list.body.data.list.map(order => order.order_id)).toEqual(expect.arrayContaining([
        'local_detail_root', 'local_detail_split', '123_local_detail',
      ]));
      expect(list.body.data.list.map(order => order.order_id)).not.toContain('local_detail_child');
      for (const hidden of ['local_detail_foreign', 'local_detail_ordinary', 'local_detail_deleted',
        'local_detail_system_deleted']) expect(list.body.data.list.map(order => order.order_id)).not.toContain(hidden);
      expect(list.body.data.list.find(order => order.order_id === 'local_detail_split')?._status._title).toBe('已拆分');
      expect(Object.keys(list.body.data.list.find(order => order.order_id === 'local_detail_root') ?? {}).sort()).toEqual([
        'id', 'order_id', 'uid', 'paid', 'pay_price', 'total_num', 'add_time', 'pid', '_status',
      ].sort());
      expect(JSON.stringify(list.body.data)).not.toMatch(/PRIVATE-|user_phone|user_address|cartInfo|customForm|refund/);
      const searched = await client.request<{ list: Array<{ order_id: string }> }>('GET', 'place/list?paging=cursor&keyword=PRIVATE-CUSTOMER-NAME');
      expect(searched.body.data.list.map(order => order.order_id)).toEqual(['local_detail_root']);
      expect(JSON.stringify(searched.body.data)).not.toContain('PRIVATE-CUSTOMER-NAME');
      const otherList = await client.request<{ list: Array<{ order_id: string }> }>('GET', 'place/list?paging=cursor', undefined, 2);
      expect(otherList.body.data.list.map(order => order.order_id)).toEqual(['local_detail_foreign']);
      expect((await client.request('GET', 'place/list?paging=cursor', undefined, 3)).body.status).not.toBe(200);
      for (const orderId of ['local_detail_child', 'local_detail_foreign', 'local_detail_ordinary',
        'local_detail_deleted', 'local_detail_system_deleted', 'missing_order']) {
        expect((await client.request('GET', `place/detail/${orderId}`)).body).toMatchObject({ status: 400, msg: '订单不存在' });
      }
      for (const actor of [0, -1, 2, 3]) {
        expect((await client.request('GET', 'place/detail/local_detail_root', undefined, actor)).body.status).not.toBe(200);
      }
      expect((await client.request('GET', 'place/detail/bad!')).body.status).not.toBe(200);
      await f.withPeer(async peer => { await peer.exec(`UPDATE store_order SET staff_id=2 WHERE id=${root.id}`); });
      expect((await client.request('GET', 'place/detail/local_detail_root')).body).toMatchObject({ status: 400, msg: '订单不存在' });
      expect((await client.request('GET', 'place/detail/local_detail_root', undefined, 2)).body.status).toBe(200);
      await f.withPeer(async peer => { await peer.exec(`UPDATE store_order SET staff_id=1,is_system_del=1 WHERE id=${root.id}`); });
      expect((await client.request('GET', 'place/detail/local_detail_root')).body).toMatchObject({ status: 400, msg: '订单不存在' });
      await f.withPeer(async peer => { await peer.exec(`UPDATE store_order SET staff_id=2 WHERE id=${prefixed.id}`); });
      expect((await client.request('GET', 'pay/status?order_id=123_local_detail')).body).toMatchObject({ status: 400, msg: '订单不存在' });
      expect(await client.post('pay/11', { uni: '123_local_detail', paytype: 'cash' })).toMatchObject({
        status: 400, msg: '订单不存在',
      });
      expect((await client.request('GET', 'form/123_local_detail/11')).body).toMatchObject({
        status: 400, msg: '订单不存在',
      });
      expect((await client.request('GET', 'pay/status?order_id=123_local_detail', undefined, 2)).body).toMatchObject({
        status: 200, data: { order_id: '123_local_detail', status: false },
      });
      await f.withPeer(async peer => { await peer.exec(`UPDATE store_order SET staff_id=1,is_system_del=1 WHERE id=${prefixed.id}`); });
      expect((await client.request('GET', 'pay/status?order_id=123_local_detail')).body).toMatchObject({ status: 400, msg: '订单不存在' });
      expect([root.id, split.id, child.id, foreign.id, ordinary.id, deleted.id, systemDeleted.id,
        prefixed.id, aliasTarget.id, longest.id, overflow.id].every(Number.isSafeInteger)).toBe(true);
    });
  }, 60_000);
  async function create(client: Awaited<ReturnType<typeof http>>, uid: number) {
    const { body, quote } = await client.confirm(uid), image = await client.upload(quote.orderKey, uid);
    const payload = { ...body, quoteToken: quote.quoteToken, customForm: answers('/api/assets/' + image.att_id) };
    const result = await client.post<Created>(`create/${quote.orderKey}/${uid}`, payload);
    expect(result.status, result.msg).toBe(200);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, result.data.result.order_id));
    return { body, quote, image, payload, order };
  }

  it.each(['name', 'field-label'] as const)(
    'binds the assisted receipt to a still-valid form %s edit, then accepts a fresh receipt on the same key', async change => {
      await scenario(async client => {
        const { body, quote } = await client.confirm(11);
        const image = await client.upload(quote.orderKey, 11);
        const payload = { ...body, quoteToken: quote.quoteToken,
          customForm: answers(`/api/assets/${image.att_id}`) };
        if (change === 'name') await f.db.update(systemForm).set({ name: 'Renamed local form' }).where(eq(systemForm.id, 77));
        else await f.db.update(systemForm).set({ value: JSON.stringify(template.map(field =>
          field.id === 'text' ? { ...field, title: 'Renamed optional label' } : field)) }).where(eq(systemForm.id, 77));
        const before = await business();
        expect(await client.post(`create/${quote.orderKey}/11`, payload)).toMatchObject({
          status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: quote.orderKey },
        });
        expect(await business()).toEqual(before);
        const refreshed = await client.post<{ result: Quote }>(`computed/${quote.orderKey}/11`, body);
        expect(refreshed.status, refreshed.msg).toBe(200);
        expect(refreshed.data.result.orderKey).toBe(quote.orderKey);
        expect(refreshed.data.result.quoteToken).not.toBe(quote.quoteToken);
        const accepted = await client.post<Created>(`create/${quote.orderKey}/11`, {
          ...payload, quoteToken: refreshed.data.result.quoteToken,
        });
        expect(accepted.status, accepted.msg).toBe(200);
        expect((await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, accepted.data.result.order_id))).length).toBe(1);
      });
    }, 60_000);

  it('rechecks a form edit between the fast read and the transaction row lock', async () => {
    await scenario(async client => {
      const { body, quote } = await client.confirm(11), image = await client.upload(quote.orderKey, 11);
      const before = await f.state();
      delete before.system_form;
      const original = orderForms.loadActiveOrderSystemForm;
      let edited = false;
      const hook = vi.spyOn(orderForms, 'loadActiveOrderSystemForm').mockImplementationOnce(async (...args) => {
        const definition = await original(...args);
        await f.withPeer(async peer => { await peer.exec("UPDATE system_form SET name='Edited after fast read' WHERE id=77"); });
        edited = true;
        return definition;
      });
      let stale: Reply<unknown>;
      try {
        stale = await client.post(`create/${quote.orderKey}/11`, { ...body, quoteToken: quote.quoteToken,
          customForm: answers(`/api/assets/${image.att_id}`) });
      } finally { hook.mockRestore(); }
      expect(edited).toBe(true);
      expect(stale).toMatchObject({ status: 400,
        data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: quote.orderKey } });
      const after = await f.state();
      delete after.system_form;
      expect(after).toEqual(before);
      const refreshed = await client.post<{ result: Quote }>(`computed/${quote.orderKey}/11`, body);
      expect(refreshed.status, refreshed.msg).toBe(200);
      expect((await client.post<Created>(`create/${quote.orderKey}/11`, { ...body,
        quoteToken: refreshed.data.result.quoteToken, customForm: answers(`/api/assets/${image.att_id}`) })).status).toBe(200);
    });
  }, 60_000);

  it('rolls back if an editor rebinds the product after the form lock but before inventory admission', async () => {
    await scenario(async client => {
      await f.db.insert(systemForm).values({ id: 78, name: 'Rebound local form', value: JSON.stringify(template), status: 1 });
      const { body, quote } = await client.confirm(11), image = await client.upload(quote.orderKey, 11);
      const beforeStock = await f.exec('SELECT stock,sales FROM store_product WHERE id=70');
      const beforeOther = await f.state();
      delete beforeOther.store_product;
      const original = orderForms.loadOrderSystemFormSubmission;
      let rebound = false;
      const hook = vi.spyOn(orderForms, 'loadOrderSystemFormSubmission').mockImplementationOnce(async (...args) => {
        const prepared = await original(...args);
        await f.withPeer(async peer => { await peer.exec('UPDATE store_product SET system_form_id=78 WHERE id=70'); });
        rebound = true;
        return prepared;
      });
      let stale: Reply<unknown>;
      try {
        stale = await client.post(`create/${quote.orderKey}/11`, { ...body, quoteToken: quote.quoteToken,
          customForm: answers(`/api/assets/${image.att_id}`) });
      } finally { hook.mockRestore(); }
      expect(rebound).toBe(true);
      expect(stale).toMatchObject({ status: 400,
        data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: quote.orderKey } });
      const afterOther = await f.state();
      delete afterOther.store_product;
      expect(afterOther).toEqual(beforeOther);
      expect(await f.exec('SELECT stock,sales FROM store_product WHERE id=70')).toEqual(beforeStock);
      const refreshed = await client.post<{ result: Quote }>(`computed/${quote.orderKey}/11`, body);
      expect(refreshed.status, refreshed.msg).toBe(200);
      const currentImage = await client.upload(quote.orderKey, 11);
      const accepted = await client.post<Created>(`create/${quote.orderKey}/11`, { ...body,
        quoteToken: refreshed.data.result.quoteToken, customForm: answers(`/api/assets/${currentImage.att_id}`) });
      expect(accepted.status, accepted.msg).toBe(200);
    });
  }, 60_000);

  it.each([11, 0])('renews only the live owned checkout images without business writes uid=%i', async uid => {
    await scenario(async client => {
      const { quote } = await client.confirm(uid), first = await client.upload(quote.orderKey, uid), second = await client.upload(quote.orderKey, uid);
      const before = await business(), ids = [second.att_id, first.att_id];
      const response = await client.request<Array<{ att_id: number; reference: string; url: string }>>('POST', `form_preview/${quote.orderKey}/${uid}`, { ids });
      expect(response.body.status, response.body.msg).toBe(200);
      expect(response.response.headers.get('cache-control')).toContain('no-store');
      expect(response.body.data.map(row => row.att_id)).toEqual(ids);
      for (const row of response.body.data) {
        expect(row.reference).toBe(`/api/assets/${row.att_id}`);
        expect(row.url).toMatch(new RegExp(`^/api/assets/${row.att_id}\\?expires=\\d+&signature=[A-Za-z0-9_-]{43}$`));
      }
      for (const actor of [0, -1, 2, 3]) expect((await client.post(`form_preview/${quote.orderKey}/${uid}`, { ids }, actor)).status).not.toBe(200);
      expect((await client.post(`form_preview/${quote.orderKey}/${uid ? 0 : 11}`, { ids })).status).not.toBe(200);
      expect(await business()).toEqual(before);
    });
  }, 60_000);

  it('bounds preview IDs and rejects missing/duplicate/oversized/non-numeric references before signing', async () => {
    await scenario(async client => {
      const { quote } = await client.confirm(11), image = await client.upload(quote.orderKey, 11);
      const before = await business(), signer = vi.spyOn(AttachmentService.prototype, 'signReferences');
      for (const ids of [undefined, [], [0], [-1], [1.5], ['1'], [2147483648], [image.att_id, image.att_id], Array.from({ length: 901 }, (_, i) => i + 1), [2147483647]]) {
        expect((await client.post(`form_preview/${quote.orderKey}/11`, { ids })).status).not.toBe(200);
      }
      expect(signer).not.toHaveBeenCalled(); expect(await business()).toEqual(before);
    });
  }, 60_000);

  it.each(['expired','used','disabled','form-changed','guest-changed'] as const)('refuses preview after checkout becomes %s', async reason => {
    await scenario(async client => {
      const uid = reason === 'guest-changed' ? 0 : 11, { quote, body } = await client.confirm(uid), image = await client.upload(quote.orderKey, uid);
      if (reason === 'expired') {
        const cacheKey = `admin:assisted:checkout:1:${uid}:${quote.orderKey}`;
        const cached = JSON.parse((await client.env.CONFIG_KV.get(cacheKey))!); cached.createdAt = Math.floor(Date.now() / 1000) - 1801;
        await client.env.CONFIG_KV.put(cacheKey, JSON.stringify(cached));
      } else if (reason === 'used') {
        expect((await client.post(`create/${quote.orderKey}/${uid}`, { ...body, quoteToken: quote.quoteToken, customForm: answers(image.url) })).status).toBe(200);
      } else if (reason === 'disabled') await f.db.update(systemForm).set({ status: 0 });
      else if (reason === 'form-changed') await f.exec('UPDATE store_product SET system_form_id=0 WHERE id=70');
      else await f.exec("UPDATE store_cart SET tourist_uid='different_guest' WHERE uid=0");
      const before = await business(), signer = vi.spyOn(AttachmentService.prototype, 'signReferences');
      expect((await client.post(`form_preview/${quote.orderKey}/${uid}`, { ids: [image.att_id] })).status).not.toBe(200);
      expect(signer).not.toHaveBeenCalled(); expect(await business()).toEqual(before);
    });
  }, 60_000);

  it.each([11, 0])('persists server evidence, reads after KV/cart removal, and replays without duplicate effects uid=%i', async uid => {
    await scenario(async (client, app) => {
      const { order, quote, image, payload } = await create(client, uid);
      const stored = JSON.parse(order.customForm!);
      const scope = await assistedFormAttachmentScope({ adminId: 1, uid, touristUid: uid ? '' : 'local_guest_a', key: quote.orderKey, systemFormId: 77 });
      expect(stored[1].assistedImageScope).toEqual({ version: 1, adminId: 1, uid, key: quote.orderKey, systemFormId: 77, digest: scope.digest });
      expect(order.customForm).not.toContain('local_guest_a'); expect(order.customForm).not.toContain('forged');
      const [collected] = await f.exec('SELECT value FROM system_form_data'); expect(String(collected.value)).not.toContain('assistedImageScope');
      await client.env.CONFIG_KV.delete(`admin:assisted:checkout:1:${uid}:${quote.orderKey}`);
      await f.exec(`UPDATE store_cart SET tourist_uid='changed_after_commit',is_del=1 WHERE uid=${uid}`);
      const before = await business();
      const replay = await client.post<Created>(`create/${quote.orderKey}/${uid}`, { ...payload, customForm: [] });
      expect(replay.data.result).toMatchObject({ order_id: order.orderId, extended: true }); expect(await business()).toEqual(before);
      const read = await client.request<Form>('GET', `form/${order.orderId}/${uid}`);
      expect(read.body.status, read.body.msg).toBe(200); expect(read.response.headers.get('cache-control')).toContain('no-store');
      expect(read.body.data[1].value).toEqual([expect.stringMatching(new RegExp(`/api/assets/${image.att_id}\\?`))]);
      expect(read.body.data[1]).not.toHaveProperty('assistedImageScope'); expect(read.body.data[0].value).toBe('Local synthetic answer');
      if (uid) {
        const detail = await new StoreOrderCreateService(createContainerFromDb(app.db), client.env).detail(uid, order.orderId);
        expect(detail.customForm[1].value).toEqual([expect.stringMatching(new RegExp(`/api/assets/${image.att_id}\\?`))]);
      }
      for (const actor of [0, -1, 2, 3]) expect((await client.request('GET', `form/${order.orderId}/${uid}`, undefined, actor)).body.status).not.toBe(200);
      expect((await client.request('GET', `form/${order.orderId}/${uid ? 0 : 11}`)).body.status).not.toBe(200);
    });
  }, 60_000);

  it.each(['actor','buyer','guest','key','form','namespace','storage','malformed-key'] as const)('rejects wrong %s ownership without business writes', async mismatch => {
    await scenario(async client => {
      const uid = mismatch === 'guest' ? 0 : 11, { body, quote } = await client.confirm(uid);
      const owner = { adminId: 1, uid, touristUid: uid ? '' : 'local_guest_a', key: quote.orderKey, systemFormId: 77 };
      const other = { ...owner, ...(mismatch === 'actor' ? { adminId: 2 } : {}), ...(mismatch === 'buyer' ? { uid: 22 } : {}),
        ...(mismatch === 'guest' ? { touristUid: 'local_guest_b' } : {}), ...(mismatch === 'key' ? { key: 'f'.repeat(32) } : {}),
        ...(mismatch === 'form' ? { systemFormId: 78 } : {}) };
      const scope = await assistedFormAttachmentScope(other);
      const [image] = await f.db.insert(systemAttachment).values({ type: scope.type, relationId: scope.relationId,
        moduleType: mismatch === 'namespace' ? 1 : 5, imageType: mismatch === 'storage' ? 1 : 8, fileType: 1,
        name: mismatch === 'malformed-key' ? `attachments/ao/${scope.digest}/bad.png` : assistedFormAttachmentKey(scope, 'png') }).returning();
      const before = await business();
      expect((await client.post(`form_preview/${quote.orderKey}/${uid}`, { ids: [image.attId] })).status).not.toBe(200);
      const result = await client.post(`create/${quote.orderKey}/${uid}`, { ...body, quoteToken: quote.quoteToken, customForm: answers(`/api/assets/${image.attId}`) });
      expect(result).toMatchObject({ status: 400, data: { errorCode: 'ORDER_FORM_REJECTED', orderKey: quote.orderKey } });
      expect(await business()).toEqual(before);
    });
  }, 60_000);

  it.each(['https://example.test/picture.png', 'https://shop.example.test/api/assets/42?sig=foreign', '/api/assets/9007199254740993', '/api/assets/2147483648'])(
    'rejects noncanonical or unsafe image references: %s', async reference => {
      await scenario(async client => {
        const { body, quote } = await client.confirm(11), before = await business();
        expect(await client.post(`create/${quote.orderKey}/11`, { ...body, quoteToken: quote.quoteToken, customForm: answers(reference) }))
          .toMatchObject({ status: 400, data: { errorCode: 'ORDER_FORM_REJECTED' } });
        expect(await business()).toEqual(before);
      });
    }, 60_000);

  it('pins attachment metadata NOWAIT and preserves retry after a SQL lock failure', async () => {
    await scenario(async client => {
      const { body, quote } = await client.confirm(11), image = await client.upload(quote.orderKey, 11), before = await business();
      const payload = { ...body, quoteToken: quote.quoteToken, customForm: answers(`/api/assets/${image.att_id}`) };
      await f.withPeer(async peer => {
        await peer.exec('BEGIN');
        try {
          await peer.exec(`SELECT att_id FROM system_attachment WHERE att_id=${image.att_id} FOR UPDATE`);
          expect(await client.post(`create/${quote.orderKey}/11`, payload)).toMatchObject({ status: 400, data: null });
          expect(await business()).toEqual(before);
        } finally { await peer.exec('ROLLBACK'); }
      });
      expect((await client.post(`create/${quote.orderKey}/11`, payload)).status).toBe(200);
    });
  }, 60_000);

  it('rolls back image-backed order and collection on a late INSERT denial; reuses the same upload on retry', async () => {
    await scenario(async (client, app) => {
      const { body, quote } = await client.confirm(0), image = await client.upload(quote.orderKey, 0), before = await business();
      const payload = { ...body, quoteToken: quote.quoteToken, customForm: answers(`/api/assets/${image.att_id}`) };
      await f.exec(`REVOKE INSERT ON system_form_data FROM "${app.role}"`);
      expect(await client.post(`create/${quote.orderKey}/0`, payload)).toMatchObject({ status: 400, data: null });
      expect(await business()).toEqual(before);
      await f.exec(`GRANT INSERT ON system_form_data TO "${app.role}"`);
      expect((await client.post(`create/${quote.orderKey}/0`, payload)).status).toBe(200);
    });
  }, 60_000);

  it.each([11, 0])('reads actual fulfillment split snapshots using the payment root and rejects broken ancestry uid=%i', async uid => {
    await scenario(async (client, app) => {
      const { order } = await create(client, uid), container = createContainerFromDb(app.db);
      // Only payment is synthetic. Allocation, supplier ledger, split evidence and SQL are real.
      await f.db.update(storeOrder).set({ paid: 1, payType: 'cash', payTime: 100 }).where(eq(storeOrder.id, order.id));
      await withTx(container, async tx => {
        const allocated = await allocatePaidOrderBySupplier(tx, order.id, order.orderId, 100);
        for (const child of allocated.fulfillmentOrders) await recordSupplierPayment(tx, child, 100);
      });
      const [line] = await app.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
      await new SupplierFulfillmentService(container, client.env).splitDelivery(7, order.id, shipping, [{ cartId: line.cartId, cartNum: 1 }]);
      const children = await app.db.select().from(storeOrder).where(eq(storeOrder.pid, order.id));
      expect(children).toHaveLength(2);
      for (const child of children) {
        expect(child.unique).not.toBe(order.unique); expect(child.customForm).toBe(order.customForm);
        const result = await client.request<Form>('GET', `form/${child.orderId}/${uid}`);
        expect(result.body.status, result.body.msg).toBe(200); expect(result.body.data[1].value).toHaveLength(1);
      }
      const [event] = await app.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventType, 'order.delivery.notice'));
      expect(event.payload).toMatchObject({ userId: uid });
      if (uid === 0) {
        await f.exec(`DELETE FROM system_notification WHERE mark='order_postage_success';
          INSERT INTO system_notification(mark,is_system,is_sms,is_wechat,is_routine,sms_id,system_title,system_text)
          VALUES('order_postage_success',1,1,1,1,'local-sms-template','Local','Local');
          INSERT INTO wechat_user(uid,openid,user_type) VALUES(0,'local-forbidden-shared-identity','routine');`);
        const process = () => withTx(container, tx => processOrderNotificationOutboxEvent(tx, event, 200));
        expect(await process()).toBe('disabled'); expect(await process()).toBe('disabled');
        expect(await f.exec('SELECT channel,user_id,target,status FROM order_notification_delivery')).toEqual([
          { channel: 'sms', user_id: 0, target: '00000000000', status: 'PENDING' },
        ]);
        expect(await f.exec('SELECT id FROM system_message WHERE user_id=0')).toEqual([]);
        await f.exec(`UPDATE store_order SET staff_id=0 WHERE id=${event.aggregateId}`);
        await expect(process()).rejects.toThrow('游客发货通知订单来源无效');
        await f.exec(`UPDATE store_order SET staff_id=1 WHERE id=${event.aggregateId}`);
      }
      if (uid) {
        const result = await new StoreOrderCreateService(container, client.env).detail(uid, order.orderId);
        expect(result.splitOrders).toHaveLength(2);
        for (const child of result.splitOrders) expect(child.customForm[1].value).toHaveLength(1);
      }
      await f.db.update(storeOrder).set({ staffId: 2 }).where(eq(storeOrder.id, order.id));
      expect((await client.request<Form>('GET', `form/${children[0].orderId}/${uid}`)).body.data[1].value).toEqual([]);
      await f.db.update(storeOrder).set({ staffId: 1, isSystemDel: 1 }).where(eq(storeOrder.id, order.id));
      expect((await client.request<Form>('GET', `form/${children[0].orderId}/${uid}`)).body.data[1].value).toEqual([]);
    });
  }, 60_000);

  it('rejects unproven guest delivery events and ordinary nonzero buyer substitution', async () => {
    await scenario(async (client, app) => {
      const { order } = await create(client, 0), container = createContainerFromDb(app.db);
      const input = { orderId: order.id, orderNo: order.orderId, userId: 0, userAddress: '',
        deliveryType: 'express' as const, deliveryName: 'Local', deliveryId: 'Local' };
      for (const patch of [{ staffId: 0 }, { isChannel: 0 }, { type: 6 }, { couponId: 1 }, { uid: 11 }]) {
        await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, order.id));
        await expect(withTx(container, tx => enqueueOrderDeliveryNoticeEvent(tx, input))).rejects.toThrow('游客发货通知订单来源无效');
        await f.db.update(storeOrder).set({ staffId: 1, isChannel: 2, type: 0, couponId: 0, uid: 0 }).where(eq(storeOrder.id, order.id));
      }
      expect(await f.exec("SELECT id FROM store_order_outbox WHERE event_type='order.delivery.notice'")).toEqual([]);
    });
  }, 60_000);

  it('fails closed for malformed proof, substituted IDs, and changed attachment metadata without hiding text', async () => {
    await scenario(async (client, app) => {
      const { order, image } = await create(client, 0), original = JSON.parse(order.customForm!);
      const signer = vi.spyOn(AttachmentService.prototype, 'signReferences');
      for (const patch of [undefined, {}, { ...original[1].assistedImageScope, key: 'f'.repeat(32) },
        { ...original[1].assistedImageScope, uid: 11 }, { ...original[1].assistedImageScope, digest: 'x'.repeat(43) }]) {
        const changed = structuredClone(original); changed[1].assistedImageScope = patch;
        const result = await readOrderSystemFormForOrder(app.db, new AttachmentService(createContainerFromDb(app.db), client.env),
          { ...order, customForm: JSON.stringify(changed) });
        expect(result[1].value).toEqual([]); expect(result[0].value).toBe('Local synthetic answer');
      }
      expect(signer).not.toHaveBeenCalled();
      await f.db.update(systemAttachment).set({ moduleType: 1 }).where(eq(systemAttachment.attId, image.att_id));
      expect((await client.request<Form>('GET', `form/${order.orderId}/0`)).body.data[1].value).toEqual([]);
    });
  }, 60_000);
});
