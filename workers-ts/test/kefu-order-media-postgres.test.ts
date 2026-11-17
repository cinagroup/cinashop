import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL, eq, sql } from 'drizzle-orm';
import { PgDialect, PgTransaction } from 'drizzle-orm/pg-core';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import {
  storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderPromotions, storeOrderRefund,
  storeProduct, storeService, storeServiceRecord, systemAttachment, systemSupplier, user,
} from '@/models/schema';
import { KefuOrderService, orderProjection, refundProjection } from '@/services/kefu/KefuOrderService';
import { readKefuOrderMedia, renderKefuOrderMedia } from '@/services/kefu/KefuOrderMediaPolicy';
import { KefuTransferService } from '@/services/kefu/KefuTransferService';
import { createToken, md5, verifyToken } from '@/utils/jwt';
import { setTokenBucket } from '@/utils/cache';
import { kefuOrderMediaFixture, kefuOrderMediaIds as ids } from './helpers/kefuOrderMediaFixture';

// This complete native file makes many real HTTP requests, each snapshotting
// all23 tables and21 sequences. Keep its test deadline separate from the
// unchanged production five-second per-statement SQL deadline.
vi.setConfig({ testTimeout: 30_000 });

// Only the external Redis SDK transport is local. Actual dedicated login, JWT
// domains/passwords, SQL/ownership, transaction boundaries and HMAC are real.
const redis = vi.hoisted(() => new Map<string, { value: unknown; until: number }>());
vi.mock('@upstash/redis/cloudflare', () => ({ Redis: class {
  async set(key: string, value: unknown, options: { ex?: number } = {}) { redis.set(key, { value: structuredClone(value), until: Date.now() + (options.ex ?? 3600) * 1000 }); return 'OK'; }
  async get(key: string) { const row = redis.get(key); return row && row.until > Date.now() ? structuredClone(row.value) : null; }
  async del(key: string) { return Number(redis.delete(key)); }
} }));

type Payload = { status: number; msg: string; data: any };
type CartTarget = { id: number; productInfo: { image: string; attrInfo: { image: string } } };
type Observation = { after?: (statement: string) => Promise<void> | void;
  beforeTransaction?: () => Promise<void> | void; transactionStarted?: () => void;
  committed?: () => void; execute?: (statement: string) => void };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dialect = new PgDialect();

/** Observe completed real queries and real transaction completion. All methods
 * forward unchanged; Proxy preserves PgTransaction's actual prototype. */
function observe(db: DbClient, observation: Observation): DbClient {
  const query = (builder: any): any => new Proxy(builder, { get(target, key) {
    if (key === 'then') return (resolve: any, reject: any) => target.then(async (rows: unknown) => {
      await observation.after?.(target.toSQL().sql); return rows;
    }).then(resolve, reject);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? (...args: unknown[]) => {
      const next = value.apply(target, args);
      return next && typeof next === 'object' && typeof next.toSQL === 'function' ? query(next) : next;
    } : value;
  } });
  const database = (client: any): DbClient => new Proxy(client, { get(target, key) {
    if (key === 'select') return (...args: unknown[]) => query(target.select(...args));
    if (key === 'execute') return async (statement: SQL) => {
      observation.execute?.(dialect.sqlToQuery(statement).sql);
      return target.execute(statement);
    };
    if (key === 'transaction') return async (work: any, ...args: unknown[]) => {
      await observation.beforeTransaction?.(); observation.transactionStarted?.();
      const result = await target.transaction((tx: any) => work(database(tx)), ...args);
      observation.committed?.(); return result;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as DbClient;
  return database(db);
}

function withoutImages(value: any): any {
  if (Array.isArray(value)) return value.map(withoutImages);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, key === 'image' ? '<media>' : withoutImages(entry)]));
  return value;
}

describe.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL)('Kefu historical order media on five actual Hono entrances and independent PostgreSQL16 LOGIN', () => {
  let f: Awaited<ReturnType<typeof kefuOrderMediaFixture>>, directory = '';
  const evidence: Record<string, unknown>[] = [];
  beforeAll(async () => { f = await kefuOrderMediaFixture(); directory = await mkdtemp(join(tmpdir(), 'cinashop-kefu-order-media-native-')); }, 30_000);
  beforeEach(async () => { redis.clear(); await f.reset(); });
  afterAll(async () => { try {
    if (f && directory) await writeFile(join(directory, 'execution.json'), JSON.stringify({
      inventory: await f.inventory(), evidence,
      boundaries: { infrastructureTransportOnly: true, sqlAuthAndHmacMocks: false,
        callerTransactionHasCallerIsolation: true, issuedTicketsRemainCapabilitiesUntilExpiry: true },
    }, null, 2) + '\n');
    console.info('KEFU_ORDER_MEDIA_NATIVE', JSON.stringify({ directory, checks: evidence.length }));
  } finally { await f?.close(); } }, 30_000);

  const routes = ['/order/list/201', '/order/list/201?type=-1', '/order/info/7201', '/order/refund/detail/9201', '/refund/list'];
  const noResourceEffects = (before: ReturnType<typeof f.resources>, after: ReturnType<typeof f.resources>, objectReads = 0) => {
    for (const name of Object.keys(before) as (keyof typeof before)[]) {
      if (name === 'objects') expect(after.objects).toEqual(before.objects);
      else expect(after[name] - before[name], name).toBe(name === 'r2Get' ? objectReads : 0);
    }
  };
  const run = async (work: (context: {
    peer: Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0]; token: string;
    get: (path: string, token?: string, objectReads?: number) => Promise<{ response: Response; payload: Payload | null; bytes: Uint8Array }>;
    post: (path: string, body: unknown, token: string) => Promise<Payload>;
    login: (account: string) => Promise<string>;
  }) => Promise<void>) => f.withRuntimeRole(async peer => {
    await f.installPlan(peer);
    const [identity] = await peer.db.execute(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version`);
    expect(identity.role).toBe(peer.role); expect(identity.session).toBe(peer.role);
    console.info('KEFU_ORDER_MEDIA_SQL_CONTEXT', JSON.stringify(identity));
    const app = f.appFor(peer.db);
    const login = async (account: string) => {
      const response = await app.request('https://owned-kefu-order-media.local/kefuapi/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account, password: f.password }) }, f.env);
      const payload = await response.json() as Payload;
      expect(payload.status).toBe(200); expect(payload.data.kefuInfo).not.toHaveProperty('password');
      expect((await verifyToken(payload.data.token, f.env.APP_KEY)).type).toBe('kefu');
      return payload.data.token as string;
    };
    const token = await login('actual-kefu-one');
    const get = async (path: string, auth?: string, objectReads = 0) => {
      const before = await f.snapshot(), resources = f.resources();
      const response = await app.request('https://owned-kefu-order-media.local/kefuapi' + path, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} }, f.env);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const payload = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(new TextDecoder().decode(bytes)) as Payload : null;
      const after = await f.snapshot(), end = f.resources();
      expect(after).toEqual(before); noResourceEffects(resources, end, objectReads);
      evidence.push({ kind: 'GET', path, http: response.status, status: payload?.status,
        tables: Object.keys(before).filter(name => name !== '__sequences'), sequences: before.__sequences.map(row => row.name),
        before: hash(before), after: hash(after), resourcesBefore: resources, resourcesAfter: end,
        bodyBytes: bytes.length, bodySha256: createHash('sha256').update(bytes).digest('hex') });
      return { response, payload, bytes };
    };
    const post = async (path: string, body: unknown, auth: string) => {
      const before = await f.snapshot(), resources = f.resources();
      const response = await app.request('https://owned-kefu-order-media.local/kefuapi' + path, {
        method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }, f.env);
      const payload = await response.json() as Payload;
      evidence.push({ kind: 'intentional-POST-mutation', path, status: payload.status,
        before: hash(before), after: hash(await f.snapshot()), resourcesBefore: resources, resourcesAfter: f.resources() });
      return payload;
    };
    await work({ peer, token, get, post, login });
  });
  function signed(value: string, reference: string) {
    const url = new URL(value, 'https://owned-kefu-order-media.local'), expires = Number(url.searchParams.get('expires'));
    expect(url.pathname).toBe(reference); expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']);
    expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 900);
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', f.env.APP_KEY).update('GET\n' + reference + '\n' + expires).digest('base64url'));
  }
  const assetPath = (value: string) => value.replace(/^\/api\//, '/');
  const patchCart = (id: number, snapshot: unknown, owner: Partial<typeof storeOrderCartInfo.$inferInsert> = {}) =>
    f.db.update(storeOrderCartInfo).set({ cartInfo: typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot), ...owner }).where(eq(storeOrderCartInfo.id, id));
  const modernSnapshot = (image: unknown, lower: unknown = f.refs.platform) => ({
    product: { id: 501, store_name: '不得降级旧字段', image: f.refs.user, price: '99.99' },
    productInfo: { id: 501, store_name: '优先级测试历史商品', image: lower, price: '12.34',
      attrInfo: { image, suk: '历史规格', price: '12.34' } }, truePrice: '12.34',
  });
  const mediaOf = async (get: Parameters<Parameters<typeof run>[0]>[0]['get'], token: string, cartId: number = ids.carts.platform) => {
    const result = await get('/order/info/7201', token); expect(result.payload?.status).toBe(200);
    return result.payload!.data.orderInfo.cartInfo.find((cart: any) => cart.id === cartId).productInfo.image as string;
  };
  function assertCartImages(carts: any[]) {
    const supplier = new Set<number>([ids.carts.supplier, ids.carts.activeSupplier]);
    const blank = new Set<number>([ids.carts.foreignAttachment, ids.carts.userAttachment, ids.carts.empty, ids.carts.forgedOwner]);
    for (const cart of carts) {
      expect(cart.productInfo.attrInfo.image).toBe(cart.productInfo.image);
      if (blank.has(cart.id)) expect(cart.productInfo.image).toBe('');
      else if (cart.id === ids.carts.legacy) expect(cart.productInfo.image).toBe('https://legacy.example.test/order-snapshot.png?v=1&x=2');
      else signed(cart.productInfo.image, supplier.has(cart.id) ? f.refs.supplier : f.refs.platform);
    }
  }
  const cartRows = (orderId: number) => f.cartRows.filter(row => row.oid === orderId);
  const refundRows = (orderId: number) => f.refundRows.filter(row => row.storeOrderId === orderId && !row.isCancel && !row.isDel);

  it('retains complete normal-order fields, DESC/page/status/search filters, duplicate lines and decimal money', async () => run(async ({ token, get }) => {
    const { payload } = await get('/order/list/201', token); expect(payload?.status).toBe(200);
    const rows = payload!.data as any[]; expect(rows.map(row => row.id)).toEqual(f.seeds.expectedCustomerOrderIds);
    expect(withoutImages(rows)).toEqual(withoutImages(f.seeds.expectedCustomerOrderIds.map(id =>
      orderProjection(f.orderRows.find(row => row.id === id)!, cartRows(id), refundRows(id)))));
    for (const row of rows) assertCartImages(row.cartInfo);
    const history = rows.find(row => row.id === ids.orders.history);
    expect(history.cartInfo.map((cart: any) => cart.id)).toEqual(cartRows(ids.orders.history).map(row => row.id));
    expect(history).toMatchObject({ total_num: 11, pay_price: '74.56', total_price: '79.00', pay_postage: '1.23',
      coupon_price: '0.22', promotions_price: '0.33', first_order_price: '0.44', type: 7, type_name: '新人' });
    expect(history.cartInfo.find((cart: any) => cart.id === ids.carts.promotion)).toMatchObject({ truePrice: '0.67', sum_true_price: '1.30', vip_sum_truePrice: '0.15', cart_num: 2 });
    expect(history.cartInfo.find((cart: any) => cart.id === ids.carts.platform).productInfo).toMatchObject({ store_name: '历史平台快照商品', price: '19.99' });
    expect((await get('/order/list/201?page=2&limit=2', token)).payload!.data.map((row: any) => row.id)).toEqual([7202, 7201]);
    expect((await get('/order/list/201?type=0', token)).payload!.data.map((row: any) => row.id)).toEqual([7203]);
    expect((await get('/order/list/201?type=1', token)).payload!.data.map((row: any) => row.id)).toEqual([7201]);
    expect((await get('/order/list/201?type=4', token)).payload!.data.map((row: any) => row.id)).toEqual([7210]);
    expect((await get('/order/list/201?search=kefu-order-media-history', token)).payload!.data.map((row: any) => row.id)).toEqual([7201]);
    expect((await get('/order/list/201?search=' + encodeURIComponent('唯一客户搜索'), token)).payload!.data.map((row: any) => row.id)).toEqual(f.seeds.expectedCustomerOrderIds);
  }));

  it('retains both active-refund and global-refund shapes, exact selected carts, mirrored _info, count buckets and independent filters', async () => run(async ({ token, get }) => {
    const active = (await get('/order/list/201?type=-1', token)).payload!; expect(active.status).toBe(200);
    expect(active.data.map((row: any) => row.id)).toEqual(f.seeds.expectedCustomerActiveRefundIds);
    const global = (await get('/refund/list', token)).payload!; expect(global.status).toBe(200);
    expect(global.data.list.map((row: any) => row.id)).toEqual(f.seeds.expectedRefundListIds); expect(global.data.count).toBe(7);
    expect(global.data.num).toEqual({ 1: { name: '仅退款', num: 1 }, 2: { name: '退货退款', num: 1 },
      3: { name: '拒绝退款', num: 1 }, 4: { name: '商品待退货', num: 1 }, 5: { name: '退货待收货', num: 1 }, 6: { name: '已退款', num: 1 } });
    for (const rows of [active.data, global.data.list]) for (const row of rows) {
      const source = f.refundRows.find(item => item.id === row.id)!;
      expect(withoutImages(row)).toEqual(withoutImages(refundProjection(source, cartRows(source.storeOrderId), true)));
      expect(row._info.map((entry: any) => entry.cart_info)).toEqual(row.cartInfo); assertCartImages(row.cartInfo);
    }
    expect(global.data.list[0].cartInfo.map((cart: any) => cart.id)).toEqual(f.seeds.selectedRefundCartIds);
    expect(global.data.list[1].cartInfo.map((cart: any) => cart.id)).toEqual(f.seeds.returningRefundCartIds);
    expect((await get('/order/list/201?type=-1&page=2&limit=2', token)).payload!.data.map((row: any) => row.id)).toEqual([9205, 9206]);
    const filtered = (await get('/refund/list?refund_type=4&order_id=kefu-refund-media-returning', token)).payload!.data;
    expect(filtered.list.map((row: any) => row.id)).toEqual([9202]); expect(filtered.count).toBe(1); expect(filtered.num).toEqual(global.data.num);
    const empty = (await get('/refund/list?time=2000-01-01&order_id=does-not-exist', token)).payload!.data;
    expect(empty).toMatchObject({ list: [], count: 0 }); expect(empty.num).toEqual(global.data.num);
    const time = String(f.refundRows.find(row => row.id === ids.refunds.returning)!.addTime);
    expect((await get('/refund/list?time=' + time, token)).payload!.data.list.map((row: any) => row.id)).toEqual([9202]);
  }));

  it('retains full order/refund detail, invoice/promotions/user fields and historical names/prices without leaking secret columns', async () => run(async ({ token, get }) => {
    const detail = (await get('/order/info/7201', token)).payload!; expect(detail.status).toBe(200);
    const order = detail.data.orderInfo, source = f.orderRows.find(row => row.id === ids.orders.history)!;
    const { invoice, promotions_detail, vip_true_price, ...core } = order;
    expect(withoutImages(core)).toEqual(withoutImages(orderProjection(source, cartRows(source.id), refundRows(source.id))));
    expect(invoice).toEqual({ invoice_id: 9411, header_type: 2, type: 1, name: '历史订单发票抬头', duty_number: 'OWNED-HISTORY-TAX',
      drawer_phone: '13900000201', email: 'owned-history@example.test', is_pay: 1, is_refund: 0, is_invoice: 1,
      invoice_number: 'OWNED-HISTORY-INVOICE', invoice_amount: '74.56', remark: '保留发票备注', invoice_time: 1_700_000_900 });
    expect(promotions_detail).toEqual([{ promotions_id: 101, product_id: 501, promotions_price: '0.50' }]);
    expect(vip_true_price).toBe('1.58'); assertCartImages(order.cartInfo);
    expect(Object.keys(detail.data.userInfo).sort()).toEqual(['uid', 'account', 'real_name', 'nickname', 'avatar', 'phone', 'group_id', 'now_money', 'integral', 'spread_uid', 'status'].sort());
    expect(detail.data.userInfo).toMatchObject({ uid: 201, account: 'actual-customer', nickname: '唯一客户搜索', phone: '13900000201' });
    const refund = (await get('/order/refund/detail/9201', token)).payload!; expect(refund.status).toBe(200);
    expect(refund.data.orderInfo).toMatchObject({ id: 9201, store_order_id: 7201, store_order_sn: source.orderId,
      pay_price: '53.33', real_name: '历史订单客户', shipping_type: 1, type: 7 });
    expect(refund.data.orderInfo.cartInfo.map((cart: any) => cart.id)).toEqual([8302, 8303]);
    expect(refund.data.orderInfo._info.map((entry: any) => entry.cart_info)).toEqual(refund.data.orderInfo.cartInfo); assertCartImages(refund.data.orderInfo.cartInfo);
    expect(refund.data.userInfo).toEqual(detail.data.userInfo);
    for (const result of [detail, refund]) {
      const serialized = JSON.stringify(result);
      for (const forbidden of ['verify_code', 'SECRET7201', 'user_ip', 'owned-customer-password', '"pwd"', 'CURRENT CHANGED CATALOG']) expect(serialized).not.toContain(forbidden);
    }
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 501)))[0]).toMatchObject({ type: 2, relationId: 320, price: '999.99' });
    expect(await f.db.select().from(storeProduct).where(eq(storeProduct.id, 502))).toEqual([]);
    await f.db.delete(storeOrderInvoice); await f.db.delete(storeOrderPromotions);
    const absent = (await get('/order/info/7201', token)).payload!.data.orderInfo; expect(absent.invoice).toBeNull(); expect(absent.promotions_detail).toEqual([]);
  }));

  it('reads real platform/supplier/store PNG tickets and rejects naked, tampered and expired capabilities before R2', async () => run(async ({ token, get }) => {
    const order = (await get('/order/info/7201', token)).payload!.data.orderInfo;
    for (const [id, reference] of [[8301, f.refs.platform], [8302, f.refs.supplier], [8303, f.refs.platform]] as const) {
      const image = order.cartInfo.find((row: any) => row.id === id).productInfo.image as string; signed(image, reference);
      const asset = await get(assetPath(image), undefined, 1);
      expect(asset.response.status).toBe(200); expect(asset.response.headers.get('Content-Type')).toContain('image/png');
      expect(asset.response.headers.get('Cache-Control')).toContain('no-store'); expect(asset.bytes).toEqual(f.png);
      for (const path of [assetPath(reference), assetPath(image.replace(/signature=[^&]+/, 'signature=wrong')),
        assetPath(image.replace(/expires=\d+/, 'expires=1'))]) expect((await get(path)).response.status).toBe(404);
    }
  }));

  it('refreshes entity-encoded stale historical tickets without persisting a response signature or changing line precedence', async () => run(async ({ token, get }) => {
    const stale = f.refs.platform + '?expires=1&amp;signature=old';
    await patchCart(ids.carts.platform, modernSnapshot(stale));
    const image = await mediaOf(get, token); signed(image, f.refs.platform);
    const [stored] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, ids.carts.platform));
    expect(stored.cartInfo).toBe(JSON.stringify(modernSnapshot(stale))); expect(stored.cartInfo).not.toContain(new URL(image, 'https://owned.local').searchParams.get('signature'));
  }));

  it('preserves explicit empty/false/number slots and nullish fallback across both historical JSON shapes', async () => run(async ({ token, get }) => {
    for (const image of ['', false, 0, 42, {}, []]) {
      await patchCart(ids.carts.platform, modernSnapshot(image)); expect(await mediaOf(get, token)).toBe('');
    }
    for (const image of [null, undefined]) {
      await patchCart(ids.carts.platform, modernSnapshot(image)); signed(await mediaOf(get, token), f.refs.platform);
    }
    await patchCart(ids.carts.platform, { product: { id: 501, store_name: '旧形状主图回退', image: f.refs.platform, price: '8.88' }, sku: { suk: '无图片规格', price: '7.77' } });
    signed(await mediaOf(get, token), f.refs.platform);
    await patchCart(ids.carts.platform, { product: { id: 501, image: f.refs.platform }, sku: { image: false, price: '7.77' } });
    expect(await mediaOf(get, token)).toBe('');
    await patchCart(ids.carts.platform, { product: { id: 501, image: f.refs.platform }, productInfo: { id: 501, image: false } });
    expect(await mediaOf(get, token)).toBe('');
  }));

  it('keeps 256-codepoint, astral Unicode and long safe legacy snapshot references without 255/256/4096 truncation or network reads', async () => run(async ({ token, get }) => {
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const references = ['/' + 'a'.repeat(255), '/' + '图'.repeat(255), '/' + '😀'.repeat(255),
        '/static/' + 'a'.repeat(50_000) + '.png', 'https://legacy.example.test/' + 'b'.repeat(100_000) + '.png?v=1&x=2'];
      for (const reference of references) {
        await patchCart(ids.carts.platform, modernSnapshot(reference)); expect(await mediaOf(get, token)).toBe(reference);
        await patchCart(ids.carts.platform, { product: { id: 501, image: reference, store_name: '旧形状长主图' }, sku: { price: '1.00' } });
        expect(await mediaOf(get, token)).toBe(reference);
      }
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  }));

  it('fails closed for unsafe/plain or entity-encoded executable references without fetching or falling back to a different picture', async () => run(async ({ token, get }) => {
    for (const image of ['/api/assets/0', '/api/assets/02', '/api/assets/2147483648', '/api/assets/2147483647',
      '//example.invalid/x.png', 'javascript:alert(1)', 'data:image/png,AAAA', '/a\\b.png', '/a b.png',
      'http://example.invalid/x.png', 'https://u:p@example.invalid/x.png', '/&#92;evil.invalid/x.png',
      '/foo&#x00;bar.png', '/foo&#127;bar.png', '/foo\u0000bar.png', '/foo\u007fbar.png']) {
      await patchCart(ids.carts.platform, modernSnapshot(image)); expect(await mediaOf(get, token), image).toBe('');
    }
  }));

  it('uses dedicated persisted cart ownership instead of current catalog, order activity/supplier or forged snapshot owner fields', async () => run(async ({ token, get }) => {
    const rows = (await get('/order/info/7201', token)).payload!.data.orderInfo.cartInfo; assertCartImages(rows);
    expect(rows.find((row: any) => row.id === ids.carts.forgedOwner).productInfo.image).toBe('');
    for (const owner of [{ type: 0, relationId: 310 }, { type: 1, relationId: 0 }, { type: 1, relationId: -1 }, { type: 2, relationId: 0 }, { type: -1, relationId: 0 }, { type: 3, relationId: 0 }]) {
      await patchCart(ids.carts.platform, modernSnapshot(f.refs.platform), owner); expect(await mediaOf(get, token), JSON.stringify(owner)).toBe('');
    }
    await patchCart(ids.carts.platform, modernSnapshot(f.refs.platform), { type: 1, relationId: 2_147_483_647 }); signed(await mediaOf(get, token), f.refs.platform);
    for (const image of [f.refs.supplier, f.refs.foreign, f.refs.user]) {
      await patchCart(ids.carts.platform, modernSnapshot(image), { type: 1, relationId: 77 }); expect(await mediaOf(get, token)).toBe('');
    }
  }));

  it('checks active same-supplier authority for registered platform/supplier pictures while rejecting foreign and user attachment ownership', async () => run(async ({ token, get }) => {
    for (const image of [f.refs.supplier, f.refs.platform]) {
      await patchCart(ids.carts.supplier, modernSnapshot(image), { type: 2, relationId: 310 }); signed(await mediaOf(get, token, ids.carts.supplier), image);
      for (const state of [{ isShow: 0, isDel: 0 }, { isShow: 1, isDel: 1 }]) {
        await f.db.update(systemSupplier).set(state).where(eq(systemSupplier.id, 310)); expect(await mediaOf(get, token, ids.carts.supplier)).toBe('');
      }
      await f.db.update(systemSupplier).set({ isShow: 1, isDel: 0 }).where(eq(systemSupplier.id, 310));
    }
    for (const image of [f.refs.foreign, f.refs.user]) {
      await patchCart(ids.carts.supplier, modernSnapshot(image), { type: 2, relationId: 310 }); expect(await mediaOf(get, token, ids.carts.supplier)).toBe('');
    }
    await f.db.delete(systemSupplier).where(eq(systemSupplier.id, 310));
    await patchCart(ids.carts.supplier, modernSnapshot(f.refs.supplier), { type: 2, relationId: 310 }); expect(await mediaOf(get, token, ids.carts.supplier)).toBe('');
  }));

  it('rejects contradictory attachment module/file/image type, namespace, object key, canonical path and MIME before signing or object reads', async () => run(async ({ token, get }) => {
    const invalid = [{ moduleType: 2 }, { fileType: 0 }, { imageType: 1 }, { type: 2, relationId: 310 },
      { attDir: '/api/assets/9102' }, { name: 'attachments/admin/0/wrong.png' },
      { name: 'attachments/admin/1/../wrong.png' }, { name: 'attachments/admin/1/a\\b.png' },
      { name: 'attachments/admin/1/wrong.svg', attType: 'image/svg+xml' }, { attType: 'text/html' }, { attType: 'image/jpeg' }];
    for (const value of invalid) {
      await f.db.update(systemAttachment).set({ ...f.attachmentRows.platform, ...value }).where(eq(systemAttachment.attId, 9101));
      expect(await mediaOf(get, token), JSON.stringify(value)).toBe('');
    }
    await f.db.update(systemAttachment).set({ ...f.attachmentRows.platform, attType: '' }).where(eq(systemAttachment.attId, 9101)); signed(await mediaOf(get, token), f.refs.platform);
    await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, 9101)); expect(await mediaOf(get, token)).toBe('');
  }));

  it('authorizes only refund-selected persisted cart rows and never accepts an arbitrary image/owner or foreign cart from refund JSON', async () => run(async ({ peer, token, get }) => {
    const statements: string[] = []; const service = new KefuOrderService(createContainerFromDb(observe(peer.db, { after: statement => { statements.push(statement); } })), f.env);
    const details = await service.refundDetail(101, 9201);
    expect(details.orderInfo.cartInfo.map(cart => cart.id)).toEqual([8302, 8303]);
    expect(statements.filter(statement => statement.includes('from "system_attachment"'))).toHaveLength(1);
    await f.db.update(storeOrderRefund).set({ cartInfo: JSON.stringify({ cart_ids: ['foreign-platform', 8315], image: f.refs.platform, type: 0, relation_id: 0 }) }).where(eq(storeOrderRefund.id, 9201));
    const empty = (await get('/order/refund/detail/9201', token)).payload!; expect(empty.status).toBe(200);
    expect(empty.data.orderInfo.cartInfo).toEqual([]); expect(empty.data.orderInfo._info).toEqual([]);
    statements.length = 0; expect((await service.refundDetail(101, 9201)).orderInfo.cartInfo).toEqual([]);
    expect(statements.filter(statement => statement.includes('from "system_attachment"'))).toEqual([]);
  }));

  it('preserves malformed/oversized snapshot fallback while rejecting malformed versioned promotion evidence', async () => run(async ({ token, get }) => {
    for (const raw of ['[broken', 'null', 'false', '[]', JSON.stringify({ ...modernSnapshot(f.refs.platform), padding: 'x'.repeat(256 * 1024) })]) {
      await patchCart(ids.carts.platform, raw); expect(await mediaOf(get, token)).toBe('');
    }
    const promotion = JSON.parse(f.seeds.carts.find(row => row.id === ids.carts.promotion)!.cartInfo!);
    for (const value of [{ ...promotion, sum_true_price: '1.31' }, { ...promotion, promotion_quote_version: 'unknown' },
      { ...promotion, padding: 'x'.repeat(256 * 1024) }]) {
      await patchCart(ids.carts.promotion, value); const result = await get('/order/info/7201', token);
      expect(result.payload?.status).toBe(400); expect(result.payload?.msg).toContain('快照');
    }
    await patchCart(ids.carts.promotion, '{"promotion_quote_version":"order-promotion-quote-v1",');
    expect((await get('/order/info/7201', token)).payload?.status).toBe(400);
  }));

  it('requires actual dedicated Kefu login on all five entrances and rejects real user/admin JWTs even when their cache type is mislabeled', async () => run(async ({ get }) => {
    for (const path of routes) for (const token of [undefined, 'invalid']) expect((await get(path, token)).payload?.status).not.toBe(200);
    for (const role of ['api', 'admin'] as const) {
      const wrong = await createToken(1, role, md5(f.passwordHash), f.env.APP_KEY);
      expect((await verifyToken(wrong.token, f.env.APP_KEY)).type).toBe(role);
      await setTokenBucket(md5(wrong.token), { uid: 1, type: role, token: wrong.token, exp: 3600 }, f.env);
      for (const path of routes) expect((await get(path, wrong.token)).payload?.status).not.toBe(200);
      await setTokenBucket(md5(wrong.token), { uid: 1, type: 'kefu', token: wrong.token, exp: 3600 }, f.env);
      for (const path of routes) { const result = await get(path, wrong.token); expect(result.payload?.status).toBe(410002); expect(result.payload?.msg).toBe('无客服权限'); }
    }
  }));

  it('closes foreign order/refund/customer scope, retains duplicate-grant semantics and rejects inactive Kefu or bound users', async () => run(async ({ token, get, login }) => {
    for (const path of ['/order/list/202', '/order/list/202?type=-1', '/order/info/7204', '/order/refund/detail/9210']) expect((await get(path, token)).payload?.status).toBe(404);
    const other = await login('actual-kefu-two');
    for (const path of routes.slice(0, 4)) expect((await get(path, other)).payload?.status).toBe(404);
    expect((await get('/refund/list', other)).payload!.data.list.map((row: any) => row.id)).toEqual([9210]);
    await f.db.insert(storeServiceRecord).values({ userId: 101, toUid: 201, isTourist: 0 });
    for (const path of routes.slice(0, 2)) expect((await get(path, token)).payload?.status).toBe(400);
    expect((await get('/order/info/7201', token)).payload?.status).toBe(200);
    for (const state of [{ status: 0 }, { isDel: 1 }, { accountStatus: 0 }]) {
      await f.reset(); const active = await login('actual-kefu-one');
      await f.db.update(storeService).set(state).where(eq(storeService.id, 1));
      for (const path of routes) expect((await get(path, active)).payload?.status).not.toBe(200);
    }
    for (const state of [{ status: 0 }, { isDel: 1 }, { deleteTime: new Date() }]) {
      await f.reset(); const active = await login('actual-kefu-one');
      await f.db.update(user).set(state).where(eq(user.uid, 101));
      for (const path of routes) expect((await get(path, active)).payload?.status).not.toBe(200);
    }
  }));

  it('preserves validation/not-found and original-order/user guards without issuing media', async () => run(async ({ token, get }) => {
    for (const path of ['/order/list/0', '/order/list/201?page=1000001', '/order/list/201?limit=101', '/order/list/201?type=10',
      '/order/info/0', '/order/info/2147483648', '/order/refund/detail/0', '/refund/list?refund_type=7',
      '/refund/list?time=not-a-date', '/refund/list?page=1000001', '/refund/list?order_id=' + 'x'.repeat(101)]) expect((await get(path, token)).payload?.status).toBe(400);
    for (const path of ['/order/info/2147483647', '/order/info/7205', '/order/refund/detail/2147483647', '/order/refund/detail/9208', '/order/refund/detail/9209']) expect((await get(path, token)).payload?.status).toBe(404);
    await f.db.update(storeOrderRefund).set({ storeOrderId: ids.orders.foreign }).where(eq(storeOrderRefund.id, 9201));
    expect((await get('/order/refund/detail/9201', token)).payload?.status).toBe(404);
    await f.db.update(storeOrderRefund).set({ storeOrderId: ids.orders.history }).where(eq(storeOrderRefund.id, 9201));
    await f.db.delete(user).where(eq(user.uid, 201));
    for (const path of ['/order/info/7201', '/order/refund/detail/9201']) expect((await get(path, token)).payload?.status).toBe(404);
  }));

  it('revokes future five-entrance context through a real transfer while keeping already issued short-lived tickets valid until expiry', async () => run(async ({ token, get, post, login }) => {
    const issued = await mediaOf(get, token); signed(issued, f.refs.platform);
    const moved = await post('/service/transfer', { uid: 201, kefuToUid: 102, is_tourist: 0, request_key: crypto.randomUUID() }, token);
    expect(moved.status).toBe(200); expect(moved.data.to_uid).toBe(102);
    for (const path of routes.slice(0, 4)) expect((await get(path, token)).payload?.status).toBe(404);
    expect((await get('/refund/list', token)).payload!.data).toMatchObject({ list: [], count: 0 });
    const target = await login('actual-kefu-two'); for (const path of routes) expect((await get(path, target)).payload?.status).toBe(200);
    expect((await get(assetPath(issued), undefined, 1)).bytes).toEqual(f.png);
  }));

  it('sees a real independent transfer committed after the customer grant but before either normal/refund snapshot acquisition', async () => run(async ({ peer }) => {
    for (const type of [undefined, '-1']) {
      await f.reset(); await f.withRuntimeRole(async other => {
        await f.installPlan(other); let moved = false; const trace: string[] = [];
        const observed = observe(peer.db, { after: async statement => {
          trace.push(statement); if (!moved && statement.includes('from "store_service_record"')) {
            const result = await new KefuTransferService(createContainerFromDb(other.db)).transfer(1, 101,
              { uid: 201, kefuToUid: 102, is_tourist: 0, request_key: crypto.randomUUID() });
            expect(result.to_uid).toBe(102); moved = true; trace.push('REAL_TRANSFER_COMMITTED_BEFORE_NEW_SNAPSHOT');
          }
        }, execute: statement => { trace.push(statement); }, transactionStarted: () => { expect(moved).toBe(true); } });
        const resources = f.resources(), before = await f.snapshot();
        const rows = await new KefuOrderService(createContainerFromDb(observed), f.env).customerOrders(101, 201, type ? { type } : {});
        expect(moved).toBe(true); expect(rows).toEqual([]);
        expect(trace.findIndex(statement => statement === 'REAL_TRANSFER_COMMITTED_BEFORE_NEW_SNAPSHOT')).toBeLessThan(trace.findIndex(statement => statement.includes('set_config')));
        evidence.push({ kind: 'intentional-independent-transfer-race', type: type ?? 'normal', trace, before: hash(before), after: hash(await f.snapshot()), resourcesBefore: resources, resourcesAfter: f.resources() });
      });
    }
  }));

  it('checks order/refund/global assignment inside an owned snapshot acquired after a real independent transfer commit', async () => run(async ({ peer }) => {
    for (const kind of ['order', 'refund', 'global'] as const) {
      await f.reset(); await f.withRuntimeRole(async other => {
        await f.installPlan(other); let moved = false; const trace: string[] = [];
        const observed = observe(peer.db, { beforeTransaction: async () => {
          expect(moved).toBe(false);
          await new KefuTransferService(createContainerFromDb(other.db)).transfer(1, 101,
            { uid: 201, kefuToUid: 102, is_tourist: 0, request_key: crypto.randomUUID() });
          moved = true; trace.push('REAL_TRANSFER_COMMITTED_BEFORE_BEGIN');
        }, execute: statement => { expect(moved).toBe(true); trace.push(statement); } });
        const service = new KefuOrderService(createContainerFromDb(observed), f.env);
        if (kind === 'order') await expect(service.orderInfo(101, 7201)).rejects.toThrow('订单不存在');
        else if (kind === 'refund') await expect(service.refundDetail(101, 9201)).rejects.toThrow('退款订单不存在');
        else expect(await service.refundList(101, {})).toMatchObject({ list: [], count: 0 });
        expect(moved).toBe(true); expect(trace.some(statement => statement.includes('set_config'))).toBe(true);
        evidence.push({ kind: 'transfer-before-authorization-snapshot', entrance: kind, trace });
      });
    }
  }));

  it('reads persisted cart owner and attachment in one coherent snapshot and signs only after its owned read commits', async () => run(async ({ peer }) => {
    await f.withRuntimeRole(async other => {
      await f.installPlan(other); let changed = false, committed = false; const statements: string[] = [];
      const db = observe(peer.db, { after: async statement => { statements.push(statement);
        if (!changed && statement.includes('from "store_order_cart_info"')) {
          changed = true;
          await withTx(createContainerFromDb(other.db), async tx => {
            await tx.update(storeOrderCartInfo).set({ type: 2, relationId: 320 }).where(eq(storeOrderCartInfo.id, 8301));
            await tx.update(systemAttachment).set({ type: 2, relationId: 310, name: 'attachments/supplier/310/coherent-change.png' }).where(eq(systemAttachment.attId, 9101));
          });
        }
      }, execute: statement => { statements.push(statement); }, committed: () => { committed = true; } });
      const actualSign = crypto.subtle.sign.bind(crypto.subtle);
      const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => { expect(committed).toBe(true); return actualSign(...args); });
      const before = await f.snapshot(), resources = f.resources();
      try {
        const result = await new KefuOrderService(createContainerFromDb(db), f.env).orderInfo(101, 7201);
        signed(result.orderInfo.cartInfo.find(cart => cart.id === 8301)!.productInfo.image, f.refs.platform);
        expect(changed).toBe(true); expect(sign).toHaveBeenCalled();
        expect(statements.filter(statement => statement.includes('from "system_attachment"'))).toHaveLength(1);
        expect(statements.some(statement => statement.toLowerCase().includes('repeatable read'))).toBe(true);
        expect(statements.some(statement => statement.toLowerCase().includes('read only'))).toBe(true);
        noResourceEffects(resources, f.resources());
        const after = await f.snapshot(); expect(after.__sequences).toEqual(before.__sequences);
        for (const table of (await f.inventory()).tables.filter(name => !['store_order_cart_info', 'system_attachment'].includes(name))) expect(after[table]).toEqual(before[table]);
        evidence.push({ kind: 'intentional-independent-owner-attachment-mutation', changedTables: ['store_order_cart_info', 'system_attachment'], before: hash(before), after: hash(after), statements });
      } finally { sign.mockRestore(); }
      const fresh = await new KefuOrderService(createContainerFromDb(peer.db), f.env).orderInfo(101, 7201);
      expect(fresh.orderInfo.cartInfo.find(cart => cart.id === 8301)!.productInfo.image).toBe('');
    });
  }));

  it('uses one bounded supplier and attachment read for one or100 complete selected cart projections on every entrance', async () => run(async ({ peer }) => {
    const statements: string[] = []; const service = new KefuOrderService(createContainerFromDb(observe(peer.db, { after: statement => { statements.push(statement); } })), f.env);
    for (const count of [1, 100]) {
      await f.db.delete(storeOrderCartInfo);
      await f.db.insert(storeOrderCartInfo).values(Array.from({ length: count }, (_, index) => ({
        ...f.seeds.carts[1], id: 12_000 + index, oid: 7201, cartId: `batch-${index}`, unique: `batch-${index}`,
      })));
      await f.db.update(storeOrderRefund).set({ cartInfo: null });
      const operations = [
        async () => (await service.customerOrders(101, 201, { search: 'kefu-order-media-history' }))[0].cartInfo,
        async () => (await service.customerOrders(101, 201, { type: '-1', search: 'kefu-refund-media-selected' }))[0].cartInfo,
        async () => (await service.orderInfo(101, 7201)).orderInfo.cartInfo,
        async () => (await service.refundDetail(101, 9201)).orderInfo.cartInfo,
        async () => (await service.refundList(101, { order_id: 'kefu-refund-media-selected' })).list[0].cartInfo,
      ];
      for (const [entrance, operation] of operations.entries()) {
        statements.length = 0; const before = await f.snapshot(), resources = f.resources();
        const carts = await operation(); expect(carts).toHaveLength(count); for (const cart of carts) signed(cart.productInfo.image, f.refs.supplier);
        expect(statements.filter(statement => statement.includes('from "system_attachment"'))).toHaveLength(1);
        expect(statements.filter(statement => statement.includes('from "system_supplier"'))).toHaveLength(1);
        expect(await f.snapshot()).toEqual(before); noResourceEffects(resources, f.resources());
        evidence.push({ kind: 'complete-cart-batching', entrance, cartCount: count, supplierQueries: 1, attachmentQueries: 1, statements: [...statements] });
      }
    }
  }));

  it('keeps caller transaction isolation, prototype and rollback ownership without nested SET or taking over caller completion', async () => run(async ({ peer }) => {
    const commands: string[] = []; let transactions = 0, committed = false, beforeCallerCompletionSigns = 0;
    const stop = new Error('intentional caller-owned rollback'), before = await f.snapshot(), resources = f.resources();
    const db = observe(peer.db, { execute: statement => { commands.push(statement); }, transactionStarted: () => { transactions++; }, committed: () => { committed = true; } });
    const actualSign = crypto.subtle.sign.bind(crypto.subtle);
    const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => { expect(committed).toBe(false); beforeCallerCompletionSigns++; return actualSign(...args); });
    try {
      await expect(withTx(createContainerFromDb(db), async tx => {
        expect(tx instanceof PgTransaction).toBe(true);
        const [initial] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`);
        const service = new KefuOrderService(createContainerFromDb(tx), f.env);
        signed((await service.orderInfo(101, 7201)).orderInfo.cartInfo[0].productInfo.image, f.refs.platform);
        await tx.update(storeOrder).set({ remark: 'UNCOMMITTED CALLER CHANGE' }).where(eq(storeOrder.id, 7201));
        expect((await service.orderInfo(101, 7201)).orderInfo.remark).toBe('UNCOMMITTED CALLER CHANGE');
        const [final] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`); expect(final).toEqual(initial);
        throw stop;
      })).rejects.toBe(stop);
      expect(transactions).toBe(1); expect(committed).toBe(false); expect(beforeCallerCompletionSigns).toBeGreaterThan(0);
      expect(commands.some(statement => /set\s+transaction|set_config/i.test(statement))).toBe(false);
      expect(await f.snapshot()).toEqual(before); noResourceEffects(resources, f.resources());
      evidence.push({ kind: 'caller-rollback-and-isolation', commands, transactions, beforeCallerCompletionSigns, callerCompletionTakenOver: false });
    } finally { sign.mockRestore(); }
  }));

  it('explicitly retains an already established caller RR snapshot after a later transfer instead of claiming fresh revocation or post-caller-commit signing', async () => run(async ({ peer }) => {
    await f.withRuntimeRole(async other => {
      await f.installPlan(other); let callerFinished = false;
      const actualSign = crypto.subtle.sign.bind(crypto.subtle);
      const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => { expect(callerFinished).toBe(false); return actualSign(...args); });
      try {
        await withTx(createContainerFromDb(peer.db), async tx => {
          await tx.execute(sql.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'));
          expect(await tx.select().from(storeServiceRecord).where(eq(storeServiceRecord.id, 1))).toHaveLength(1);
          const moved = await new KefuTransferService(createContainerFromDb(other.db)).transfer(1, 101,
            { uid: 201, kefuToUid: 102, is_tourist: 0, request_key: crypto.randomUUID() }); expect(moved.to_uid).toBe(102);
          const result = await new KefuOrderService(createContainerFromDb(tx), f.env).customerOrders(101, 201, {});
          expect(result.map(row => row.id)).toEqual(f.seeds.expectedCustomerOrderIds); assertCartImages(result.find(row => row.id === 7201)!.cartInfo);
        });
        callerFinished = true; expect(sign).toHaveBeenCalled();
        evidence.push({ kind: 'explicit-caller-RR-limitation', transferCommittedAfterCallerSnapshot: true, oldSnapshotCanComplete: true, signingPrecedesCallerCommit: true });
      } finally { sign.mockRestore(); }
    });
  }));

  it('retains env-free safe legacy snapshots without requiring a signing key or fetching a URL', async () => run(async ({ peer }) => {
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ product: { id: 501, image: '/static/legacy-order.png', store_name: '历史静态商品' }, sku: { price: '1.23' } }) });
    const before = await f.snapshot(), resources = f.resources();
    const detail = await new KefuOrderService(createContainerFromDb(peer.db)).orderInfo(101, 7201);
    expect(detail.orderInfo.cartInfo).toHaveLength(10);
    for (const cart of detail.orderInfo.cartInfo) expect(cart.productInfo.image).toBe('/static/legacy-order.png');
    expect(await f.snapshot()).toEqual(before); noResourceEffects(resources, f.resources());
  }));

  it('counts complete selected projections rather than mirrored _info slots and rejects10001 before attachment/supplier SQL', async () => run(async ({ peer }) => {
    const target = (): CartTarget => ({ id: ids.carts.platform, productInfo: { image: f.refs.platform, attrInfo: { image: f.refs.platform } } });
    const owner = [{ id: ids.carts.platform, type: 0, relationId: 0 }];
    const before = await f.snapshot(), resources = f.resources(), select = vi.spyOn(peer.db, 'select');
    try {
      const tooMany = Array.from({ length: 10_001 }, target);
      await expect(readKefuOrderMedia(peer.db, owner, [tooMany])).rejects.toThrow('完整预览容量');
      expect(select).not.toHaveBeenCalled();
      const allowed = Array.from({ length: 10_000 }, target);
      const slots = await readKefuOrderMedia(peer.db, owner, [allowed]); await renderKefuOrderMedia(f.env.APP_KEY, slots);
      expect(allowed).toHaveLength(10_000); signed(allowed[0].productInfo.image, f.refs.platform);
      expect(allowed[9999].productInfo.image).toBe(allowed[0].productInfo.image);
      expect(allowed[0].productInfo.attrInfo.image).toBe(allowed[0].productInfo.image);
      expect(await f.snapshot()).toEqual(before); noResourceEffects(resources, f.resources());
    } finally { select.mockRestore(); }
  }));

  it('includes newly added owned browser tables and sequences in every complete state snapshot', async () => run(async () => {
    await f.exec('CREATE TABLE public.order_media_snapshot_inventory_probe(id serial PRIMARY KEY, value text NOT NULL)');
    try {
      await f.exec("INSERT INTO public.order_media_snapshot_inventory_probe(value) VALUES('owned-snapshot-probe')");
      const state = await f.snapshot(), inventory = await f.inventory();
      expect(state.order_media_snapshot_inventory_probe).toEqual([{ id: 1, value: 'owned-snapshot-probe' }]);
      expect(inventory.tables).toHaveLength(24); expect(inventory.sequences).toHaveLength(22);
      expect(state.__sequences.some(row => row.name === 'order_media_snapshot_inventory_probe_id_seq' && row.last_value === '1' && row.is_called === true)).toBe(true);
    } finally { await f.exec('DROP TABLE public.order_media_snapshot_inventory_probe'); }
  }));
});
