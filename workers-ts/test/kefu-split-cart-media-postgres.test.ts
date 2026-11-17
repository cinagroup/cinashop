import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL, eq, ne, sql } from 'drizzle-orm';
import { PgDialect, PgTransaction } from 'drizzle-orm/pg-core';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeProduct, storeService, storeServiceRecord, systemAttachment, systemSupplier, user } from '@/models/schema';
import { KefuFulfillmentService } from '@/services/kefu/KefuFulfillmentService';
import { KefuTransferService } from '@/services/kefu/KefuTransferService';
import { MAX_KEFU_SPLIT_CART_SNAPSHOT_UNITS } from '@/services/kefu/KefuSplitCartMediaPolicy';
import { createToken, md5, verifyToken } from '@/utils/jwt';
import { setTokenBucket } from '@/utils/cache';
import { kefuSplitCartMediaFixture, kefuSplitCartMediaIds as ids } from './helpers/kefuSplitCartMediaFixture';

// Whole-state SQL snapshots and actual login/HTTP calls need a test deadline
// separate from the unchanged production five-second statement deadline.
vi.setConfig({ testTimeout: 30_000 });
// Only the Redis SDK transport is local. JWT, SQL, guards and HMAC are real.
const redis = vi.hoisted(() => new Map<string, { value: unknown; until: number }>());
vi.mock('@upstash/redis/cloudflare', () => ({ Redis: class {
  async set(key: string, value: unknown, options: { ex?: number } = {}) { redis.set(key, { value: structuredClone(value), until: Date.now() + (options.ex ?? 3600) * 1000 }); return 'OK'; }
  async get(key: string) { const row = redis.get(key); return row && row.until > Date.now() ? structuredClone(row.value) : null; }
  async del(key: string) { return Number(redis.delete(key)); }
} }));
type Payload = { status: number; msg: string; data: any };
type Observation = { after?: (statement: string) => Promise<void> | void;
  beforeTransaction?: () => Promise<void> | void; transactionStarted?: () => void;
  beforeExecute?: (statement: string) => Promise<void> | void;
  committed?: () => void; execute?: (statement: string) => void };
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
      const text = dialect.sqlToQuery(statement).sql;
      await observation.beforeExecute?.(text);
      observation.execute?.(text);
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

const route = (id: number | string = ids.order) => `/order/split_cart_info/${id}`;
const nested = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function scrub(value: any) {
  const result = structuredClone(value);
  delete result.image;
  const snapshot = result.cart_info;
  for (const name of ['product', 'productInfo', 'sku']) {
    const item = nested(snapshot?.[name]);
    if (typeof item?.image === 'string') delete item.image;
    if (name !== 'sku') { const attr = nested(item?.attrInfo); if (typeof attr?.image === 'string') delete attr.image; }
  }
  return result;
}
/** Independent pre-migration fulfillment projection, including its original
 * product.image ?? productInfo.image String conversion and SKU precedence. */
function originalProjection(row: typeof storeOrderCartInfo.$inferSelect) {
  let snapshot: Record<string, unknown> | null = null;
  try { snapshot = nested(JSON.parse(row.cartInfo ?? 'null')); } catch { /* Original malformed JSON fallback. */ }
  const product = nested(snapshot?.product), info = nested(snapshot?.productInfo);
  const sku = nested(snapshot?.sku), attr = nested(info?.attrInfo);
  return { id: row.id, cart_id: row.cartId, product_id: row.productId, sku_unique: row.skuUnique,
    cart_num: row.cartNum, refund_num: row.refundNum, surplus_num: row.splitSurplusNum,
    product_name: String(product?.storeName ?? info?.store_name ?? '商品快照'),
    image: String(product?.image ?? info?.image ?? ''), sku: String(sku?.suk ?? attr?.suk ?? row.skuUnique), cart_info: snapshot };
}

describe.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL)('Kefu split-cart preview media on real Hono and independent PostgreSQL16 LOGIN', () => {
  let f: Awaited<ReturnType<typeof kefuSplitCartMediaFixture>>, directory = '';
  const evidence: Record<string, unknown>[] = [], retained = new Set<string>();
  beforeAll(async () => { f = await kefuSplitCartMediaFixture(); directory = await mkdtemp(join(tmpdir(), 'cinashop-kefu-split-cart-media-native-')); await mkdir(join(directory, 'states')); }, 30_000);
  beforeEach(async () => { redis.clear(); await f.reset(); });
  afterAll(async () => { try {
    if (f && directory) await writeFile(join(directory, 'execution.json'), JSON.stringify({
      inventory: await f.inventory(), evidence, completeSnapshotFiles: [...retained].sort(),
      boundaries: { infrastructureTransportOnly: true, sqlAuthAndHmacMocks: false,
        callerTransactionHasCallerIsolation: true, issuedTicketsRemainCapabilitiesUntilExpiry: true },
    }, null, 2) + '\n');
    console.info('KEFU_SPLIT_CART_MEDIA_NATIVE', JSON.stringify({ directory, checks: evidence.length }));
  } finally { await f?.close(); } }, 30_000);

  const retain = async (state: Awaited<ReturnType<typeof f.snapshot>>) => {
    const content = JSON.stringify(state), sha256 = createHash('sha256').update(content).digest('hex');
    const name = `states/${sha256}.json`;
    if (!retained.has(name)) { await writeFile(join(directory, name), content); retained.add(name); }
    return { path: name, sha256, bytes: Buffer.byteLength(content) };
  };
  const noResourceEffects = (before: ReturnType<typeof f.resources>, after: ReturnType<typeof f.resources>, reads = 0) => {
    for (const name of Object.keys(before) as (keyof typeof before)[]) {
      if (name === 'objects') expect(after.objects).toEqual(before.objects);
      else expect(after[name] - before[name], name).toBe(name === 'r2Get' ? reads : 0);
    }
  };
  const run = async (work: (context: {
    peer: Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0]; token: string;
    get: (path: string, token?: string, reads?: number) => Promise<{ response: Response; payload: Payload | null; bytes: Uint8Array; statements: string[] }>;
    post: (path: string, body: unknown, token: string) => Promise<Payload>;
    login: (account: string) => Promise<string>;
  }) => Promise<void>) => f.withRuntimeRole(async peer => {
    await f.installPlan(peer);
    const [identity] = await peer.db.execute(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version`);
    expect(identity.role).toBe(peer.role); expect(identity.session).toBe(peer.role);
    console.info('KEFU_SPLIT_CART_MEDIA_SQL_CONTEXT', JSON.stringify(identity));
    const statements: string[] = [];
    const app = f.appFor(observe(peer.db, { after: statement => { statements.push(statement); }, execute: statement => { statements.push(statement); } }));
    const login = async (account: string) => {
      const response = await app.request('https://owned-kefu-split-media.local/kefuapi/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account, password: f.password }) }, f.env);
      const payload = await response.json() as Payload;
      expect(payload.status).toBe(200); expect(payload.data.kefuInfo).not.toHaveProperty('password');
      expect((await verifyToken(payload.data.token, f.env.APP_KEY)).type).toBe('kefu'); return payload.data.token as string;
    };
    const token = await login('actual-kefu-one');
    const get = async (path: string, auth?: string, reads = 0) => {
      const before = await f.snapshot(), resources = f.resources(); statements.length = 0;
      const response = await app.request('https://owned-kefu-split-media.local/kefuapi' + path, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} }, f.env);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const payload = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(new TextDecoder().decode(bytes)) as Payload : null;
      const after = await f.snapshot(), end = f.resources(), trace = [...statements];
      expect(after).toEqual(before); noResourceEffects(resources, end, reads);
      evidence.push({ kind: 'GET', path, http: response.status, status: payload?.status, msg: payload?.msg,
        before: await retain(before), after: await retain(after), resourcesBefore: resources, resourcesAfter: end,
        statements: trace, bodyBytes: bytes.length, bodySha256: createHash('sha256').update(bytes).digest('hex') });
      return { response, payload, bytes, statements: trace };
    };
    const post = async (path: string, body: unknown, auth: string) => {
      const before = await f.snapshot(), resources = f.resources();
      const response = await app.request('https://owned-kefu-split-media.local/kefuapi' + path, {
        method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }, f.env);
      const payload = await response.json() as Payload;
      evidence.push({ kind: 'intentional-POST-mutation', path, status: payload.status,
        before: await retain(before), after: await retain(await f.snapshot()), resourcesBefore: resources, resourcesAfter: f.resources() });
      return payload;
    };
    await work({ peer, token, get, post, login });
  });
  function signed(value: string, reference: string) {
    const url = new URL(value, 'https://owned-kefu-split-media.local'), expires = Number(url.searchParams.get('expires'));
    expect(url.pathname).toBe(reference); expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']);
    expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000)); expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 900);
    const expected = createHmac('sha256', f.env.APP_KEY).update(`GET\n${reference}\n${expires}`).digest('base64url');
    expect(url.searchParams.get('signature')).toBe(expected);
    evidence.push({ kind: 'independent-HMAC', reference, expires, signature: url.searchParams.get('signature'), expected });
  }
  const patch = (id: number, snapshot: unknown, extra: Partial<typeof storeOrderCartInfo.$inferInsert> = {}) =>
    f.db.update(storeOrderCartInfo).set({ cartInfo: typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot), ...extra }).where(eq(storeOrderCartInfo.id, id));
  const first = async (get: Parameters<Parameters<typeof run>[0]>[0]['get'], token: string) => {
    const result = await get(route(), token); expect(result.payload?.status).toBe(200);
    return result.payload!.data.find((row: any) => row.id === ids.carts.platform);
  };

  it('retains exact original complete preview projections, ordering, quantities, finance and recognized raw path shapes', async () => run(async ({ token, get }) => {
    const result = await get(route(), token); expect(result.payload?.status).toBe(200);
    const rows = result.payload!.data as any[]; expect(rows.map(row => row.id)).toEqual(f.expectedCartIds);
    expect(rows.map(scrub)).toEqual(f.cartRows.filter(row => f.expectedCartIds.includes(row.id as any)).map(row => scrub(originalProjection(row))));
    signed(rows[0].image, f.refs.platform); signed(rows[2].image, f.refs.platform);
    expect(rows[3].image).toBe(''); expect(rows[4].image).toBe('https://legacy.example.test/split-main.png?v=1&x=2'); expect(rows[5].image).toBe('');
    expect(rows[0]).toMatchObject({ product_name: '历史拆单商品', cart_num: 3, refund_num: 1, surplus_num: 2, sku: '先前购买规格' });
    expect(rows[0].cart_info).toMatchObject({ truePrice: '1.23', coupon_price: '0.07', promotions_true_price: '0.11', first_order_price: '0.13', decimal_note: '001.2300', unknown: { image: 'unrecognized-image-field', relation_id: 310 } });
  }));

  it('authorizes all five raw image paths independently and preserves a raw image array while signing its top String projection', async () => run(async ({ token, get }) => {
    const rows = (await get(route(), token)).payload!.data;
    const supplier = rows.find((row: any) => row.id === ids.carts.supplier);
    signed(supplier.image, f.refs.platform); signed(supplier.cart_info.product.image, f.refs.platform);
    signed(supplier.cart_info.product.attrInfo.image, f.refs.supplier);
    expect(supplier.cart_info.productInfo.image).toBe(''); expect(supplier.cart_info.productInfo.attrInfo.image).toBe('');
    expect(supplier.cart_info.sku.image).toBe('https://legacy.example.test/split-sku.png?x=1&y=2');
    const array = rows.find((row: any) => row.id === ids.carts.array);
    signed(array.image, f.refs.platform); expect(array.cart_info.product.image).toEqual([f.refs.platform]);
  }));

  it('preserves original top nullish/String precedence without attr-first merging or mutating non-string raw fields', async () => run(async ({ token, get }) => {
    for (const value of ['', false, 0, 42, {}, [], [f.refs.platform], null]) {
      const snapshot = { product: { image: value }, productInfo: { image: f.refs.platform, attrInfo: { image: f.refs.supplier } }, sku: { image: false } };
      await patch(ids.carts.platform, snapshot); const item = await first(get, token);
      expect(item.cart_info.product.image).toEqual(value); expect(item.cart_info.sku.image).toBe(false);
      if (value === null || (Array.isArray(value) && value.length === 1)) signed(item.image, f.refs.platform); else expect(item.image).toBe('');
      signed(item.cart_info.productInfo.image, f.refs.platform); expect(item.cart_info.productInfo.attrInfo.image).toBe('');
    }
  }));

  it('retains malformed/non-record JSON fallback and the original SKU/name fields', async () => run(async ({ token, get }) => {
    for (const raw of ['[broken', 'null', 'false', '[]', '42']) {
      await patch(ids.carts.platform, raw); const item = await first(get, token);
      expect(item).toMatchObject({ image: '', cart_info: null, product_name: '商品快照', sku: `owned-split-sku-${ids.carts.platform}` });
    }
  }));

  it('retains pid=-1 single matching pending-child selection, empty roots and ambiguous-child errors', async () => run(async ({ token, get }) => {
    const root = (await get(route(ids.root), token)).payload!; expect(root.status).toBe(200); expect(root.data.map((row: any) => row.id)).toEqual([ids.carts.child]);
    signed(root.data[0].image, f.refs.platform);
    expect((await get(route(ids.child), token)).payload!.data.map((row: any) => row.id)).toEqual([ids.carts.child]);
    expect((await get(route(ids.emptyRoot), token)).payload).toMatchObject({ status: 200, data: [] });
    expect((await get(route(ids.ambiguousRoot), token)).payload).toMatchObject({ status: 400, msg: '订单存在多个待发货子单，请先完成数据核对' });
  }));

  it('retains positive int32 validation and not-found/deleted/foreign order guards', async () => run(async ({ token, get }) => {
    for (const value of ['0', '-1', '1.5', 'abc', '2147483648']) expect((await get(route(value), token)).payload?.status).toBe(400);
    for (const value of [2_147_483_647, ids.deleted, ids.foreign]) expect((await get(route(value), token)).payload?.status).toBe(404);
    await f.db.update(storeOrder).set({ isSystemDel: 1 }).where(eq(storeOrder.id, ids.order)); expect((await get(route(), token)).payload?.status).toBe(404);
  }));

  it('retains paid/status/shipping/refund delivery eligibility while allowing refundStatus3 and excluding complete/empty-surplus carts', async () => run(async ({ token, get }) => {
    const original = f.orderRows.find(row => row.id === ids.order)!;
    for (const [state, message] of [[{ paid: 0 }, '订单未支付'], [{ status: 1 }, '订单状态不允许发货'],
      [{ shippingType: 2 }, '核销订单不能发货'], [{ refundStatus: 1 }, '订单售后状态不允许发货']] as const) {
      await f.db.update(storeOrder).set({ ...original, ...state }).where(eq(storeOrder.id, ids.order));
      expect((await get(route(), token)).payload).toMatchObject({ status: 400, msg: message });
    }
    await f.db.update(storeOrder).set({ ...original, refundStatus: 3 }).where(eq(storeOrder.id, ids.order));
    expect((await get(route(), token)).payload!.data.map((row: any) => row.id)).toEqual(f.expectedCartIds);
  }));

  it('requires real dedicated Kefu login and rejects invalid, visitor and wrong-domain JWTs including mislabeled cache authority', async () => run(async ({ get }) => {
    for (const token of [undefined, 'invalid', f.visitorToken()]) expect((await get(route(), token)).payload?.status).not.toBe(200);
    const expired = await createToken(1, 'kefu', md5(f.passwordHash), f.env.APP_KEY, 'cinashop', 1_700_000_000);
    await setTokenBucket(md5(expired.token), { uid: 1, type: 'kefu', token: expired.token, exp: 3600 }, f.env);
    expect((await get(route(), expired.token)).payload?.status).not.toBe(200);
    const wrongPassword = await createToken(1, 'kefu', md5('incorrect-dedicated-password-hash'), f.env.APP_KEY);
    await setTokenBucket(md5(wrongPassword.token), { uid: 1, type: 'kefu', token: wrongPassword.token, exp: 3600 }, f.env);
    expect((await get(route(), wrongPassword.token)).payload?.status).not.toBe(200);
    for (const role of ['api', 'admin'] as const) {
      const wrong = await createToken(1, role, md5(f.passwordHash), f.env.APP_KEY);
      expect((await verifyToken(wrong.token, f.env.APP_KEY)).type).toBe(role);
      await setTokenBucket(md5(wrong.token), { uid: 1, type: role, token: wrong.token, exp: 3600 }, f.env);
      expect((await get(route(), wrong.token)).payload?.status).not.toBe(200);
      await setTokenBucket(md5(wrong.token), { uid: 1, type: 'kefu', token: wrong.token, exp: 3600 }, f.env);
      expect((await get(route(), wrong.token)).payload).toMatchObject({ status: 410002, msg: '无客服权限' });
    }
  }));

  it('requires registered assigned-customer scope, preserves EXISTS duplicate-grant semantics and rejects inactive service/bound-user identities', async () => run(async ({ token, get, login }) => {
    const other = await login('actual-kefu-two'); expect((await get(route(), other)).payload?.status).toBe(404);
    await f.db.insert(storeServiceRecord).values({ userId: 101, toUid: 201, isTourist: 0 }); expect((await get(route(), token)).payload?.status).toBe(200);
    await f.db.update(storeServiceRecord).set({ isTourist: 1 }).where(eq(storeServiceRecord.toUid, 201)); expect((await get(route(), token)).payload?.status).toBe(404);
    for (const state of [{ status: 0 }, { isDel: 1 }, { accountStatus: 0 }]) {
      await f.reset(); const active = await login('actual-kefu-one'); await f.db.update(storeService).set(state).where(eq(storeService.id, 1)); expect((await get(route(), active)).payload?.status).not.toBe(200);
    }
    for (const state of [{ status: 0 }, { isDel: 1 }, { deleteTime: new Date() }]) {
      await f.reset(); const active = await login('actual-kefu-one'); await f.db.update(user).set(state).where(eq(user.uid, 101)); expect((await get(route(), active)).payload?.status).not.toBe(200);
    }
  }));

  it('uses persisted cart ownership independent of live catalog, order supplier and forged snapshot claims', async () => run(async ({ token, get }) => {
    for (const value of [{ type: 0, relationId: 310 }, { type: 1, relationId: 0 }, { type: 1, relationId: -1 }, { type: 2, relationId: 0 }, { type: 3, relationId: 0 }]) {
      await patch(ids.carts.platform, { product: { image: f.refs.platform, type: 0, relation_id: 0 } }, value); expect((await first(get, token)).image).toBe('');
    }
    await patch(ids.carts.platform, { product: { image: f.refs.platform } }, { type: 1, relationId: 2_147_483_647 }); signed((await first(get, token)).image, f.refs.platform);
    for (const image of [f.refs.supplier, f.refs.foreign, f.refs.user]) {
      await patch(ids.carts.platform, { product: { image } }, { type: 1, relationId: 77 }); expect((await first(get, token)).image).toBe('');
    }
  }));

  it('keeps historical preview names, quantities, finance and images after actual live-catalog mutation and deletion', async () => run(async ({ token, get }) => {
    const initial = await get(route(), token); expect(initial.payload?.status).toBe(200);
    const before = await f.snapshot();
    await f.db.update(storeProduct).set({ storeName: 'CURRENT CATALOG MUTATED BY ACCEPTANCE', image: f.refs.foreign,
      type: 2, relationId: 320, price: '987.65', isShow: 0, isDel: 1 }).where(eq(storeProduct.id, 501));
    const mutated = await get(route(), token); expect(mutated.payload?.status).toBe(200);
    expect(mutated.payload!.data.map(scrub)).toEqual(initial.payload!.data.map(scrub));
    signed(mutated.payload!.data[0].image, f.refs.platform);
    await f.db.delete(storeProduct);
    expect(await f.db.select().from(storeProduct)).toEqual([]);
    const deleted = await get(route(), token); expect(deleted.payload?.status).toBe(200);
    expect(deleted.payload!.data.map(scrub)).toEqual(initial.payload!.data.map(scrub));
    signed(deleted.payload!.data[0].image, f.refs.platform);
    signed(deleted.payload!.data[1].cart_info.product.attrInfo.image, f.refs.supplier);
    evidence.push({ kind: 'intentional-live-catalog-mutation-and-deletion', before: await retain(before), after: await retain(await f.snapshot()),
      mutationGet: mutated.statements, deletionGet: deleted.statements, historicalProjectionRetained: true });
  }));

  it('requires active persisted same-supplier metadata including platform fallback, and rejects missing suppliers', async () => run(async ({ token, get }) => {
    for (const image of [f.refs.supplier, f.refs.platform]) {
      await patch(ids.carts.platform, { product: { image } }, { type: 2, relationId: 310 }); signed((await first(get, token)).image, image);
      for (const state of [{ isShow: 0, isDel: 0 }, { isShow: 1, isDel: 1 }]) {
        await f.db.update(systemSupplier).set(state).where(eq(systemSupplier.id, 310)); expect((await first(get, token)).image).toBe('');
      }
      await f.db.update(systemSupplier).set({ isShow: 1, isDel: 0 }).where(eq(systemSupplier.id, 310));
    }
    await f.db.delete(systemSupplier).where(eq(systemSupplier.id, 310)); expect((await first(get, token)).image).toBe('');
  }));

  it('checks actual attachment MIME/module/file/image type, namespace and canonical metadata before signing', async () => run(async ({ token, get }) => {
    const invalid = [{ moduleType: 2 }, { fileType: 0 }, { imageType: 1 }, { type: 4, relationId: 310 },
      { attDir: f.refs.supplier }, { name: 'attachments/admin/0/wrong.png' }, { name: 'attachments/admin/1/../wrong.png' },
      { name: 'attachments/admin/1/a\\b.png' }, { attType: 'text/html' }, { attType: 'image/jpeg' },
      { name: 'attachments/admin/1/wrong.svg', attType: 'image/svg+xml' }];
    for (const state of invalid) {
      await f.db.update(systemAttachment).set({ ...f.attachmentRows.platform, ...state }).where(eq(systemAttachment.attId, 9101)); expect((await first(get, token)).image, JSON.stringify(state)).toBe('');
    }
    await f.db.update(systemAttachment).set({ ...f.attachmentRows.platform, attType: '' }).where(eq(systemAttachment.attId, 9101)); signed((await first(get, token)).image, f.refs.platform);
    await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, 9101)); expect((await first(get, token)).image).toBe('');
  }));

  it('rejects raw/decoded unsafe characters before suffix stripping, strips stale canonical tickets and decodes legacy exactly once', async () => run(async ({ token, get }) => {
    for (const image of ['//evil.invalid/x', 'javascript:alert(1)', 'http://legacy.example.test/x', 'https://u:p@legacy.example.test/x',
      '/a\\b', '/a b', '/a&#x00;b', '/a&#127;b', '/a&#92;b', '/a&#32;b', f.refs.platform + '?x=&#10;',
      f.refs.platform + '?x=\u007f', '/api/assets/0', '/api/assets/02', '/api/assets/2147483648']) {
      await patch(ids.carts.platform, { product: { image } }); expect((await first(get, token)).image, image).toBe('');
    }
    await patch(ids.carts.platform, { product: { image: f.refs.platform + '?expires=1&amp;signature=old' } }); signed((await first(get, token)).image, f.refs.platform);
    await patch(ids.carts.platform, { product: { image: '/static/a&amp;#32;b.png' } }); expect((await first(get, token)).image).toBe('/static/a&#32;b.png');
  }));

  it('retains safe root/HTTPS imported references over256Ki without the order-detail snapshot cap or network/R2 reads', async () => run(async ({ token, get }) => {
    const network = vi.spyOn(globalThis, 'fetch');
    try { for (const image of ['/static/' + '图'.repeat(300_000) + '.png', 'https://legacy.example.test/' + 'a'.repeat(300_000) + '.png?x=1&y=2']) {
      await patch(ids.carts.platform, { product: { image } }); expect((await first(get, token)).image).toBe(image);
    } expect(network).not.toHaveBeenCalled(); } finally { network.mockRestore(); }
  }));

  it('serves real signed platform/supplier PNG bytes while naked, expired and tampered capabilities cannot read R2', async () => run(async ({ token, get }) => {
    const rows = (await get(route(), token)).payload!.data;
    const references = [[rows[0].image, f.refs.platform], [rows[1].cart_info.product.attrInfo.image, f.refs.supplier]];
    for (const [image, reference] of references) {
      signed(image, reference); const result = await get(image.replace(/^\/api\//, '/'), undefined, 1);
      expect(result.response.status).toBe(200); expect(result.response.headers.get('Content-Type')).toContain('image/png'); expect(result.bytes).toEqual(f.png);
      const url = new URL(image, 'https://owned-kefu-split-media.local');
      url.searchParams.set('signature', 'bad'); expect((await get(url.pathname.replace(/^\/api\//, '/') + url.search)).response.status).toBe(404);
      expect((await get(reference.replace(/^\/api\//, '/'))).response.status).toBe(404);
      const expires = Math.floor(Date.now() / 1000) - 1, signature = createHmac('sha256', f.env.APP_KEY).update(`GET\n${reference}\n${expires}`).digest('base64url');
      expect((await get(reference.replace(/^\/api\//, '/') + `?expires=${expires}&signature=${signature}`)).response.status).toBe(404);
    }
  }));

  it('uses a real transfer to close new preview context while already issued tickets retain their TTL', async () => run(async ({ token, get, post, login }) => {
    const issued = (await first(get, token)).image; signed(issued, f.refs.platform);
    expect(await post('/service/transfer', { uid: 201, kefuToUid: 102, is_tourist: 0, request_key: crypto.randomUUID() }, token)).toMatchObject({ status: 200, data: { to_uid: 102 } });
    expect((await get(route(), token)).payload?.status).toBe(404);
    const target = await login('actual-kefu-two'); expect((await get(route(), target)).payload?.status).toBe(200);
    expect((await get(issued.replace(/^\/api\//, '/'), undefined, 1)).bytes).toEqual(f.png);
  }));

  it('reads complete owner/attachment authority in one owned RR snapshot and signs only after its commit', async () => run(async ({ peer }) => {
    await f.withRuntimeRole(async other => {
      await f.installPlan(other); let changed = false, committed = false; const statements: string[] = [];
      const db = observe(peer.db, { after: async statement => { statements.push(statement); if (!changed && statement.includes('from "store_order_cart_info"')) {
        changed = true; await withTx(createContainerFromDb(other.db), async tx => {
          await tx.update(storeOrderCartInfo).set({ type: 2, relationId: 320 }).where(eq(storeOrderCartInfo.id, ids.carts.platform));
          await tx.update(systemAttachment).set({ type: 4, relationId: 310, name: 'attachments/supplier/310/coherent-change.png' }).where(eq(systemAttachment.attId, 9101));
        });
      } }, execute: statement => { statements.push(statement); }, committed: () => { committed = true; } });
      const actual = crypto.subtle.sign.bind(crypto.subtle), sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => { expect(committed).toBe(true); return actual(...args); });
      const before = await f.snapshot(), resources = f.resources();
      try {
        const rows = await new KefuFulfillmentService(createContainerFromDb(db), f.env).splitCartInfo(101, ids.order);
        signed(rows[0].image, f.refs.platform); expect(changed).toBe(true); expect(sign).toHaveBeenCalled();
        expect(statements.some(value => /repeatable read/i.test(value))).toBe(true); expect(statements.some(value => /read only/i.test(value))).toBe(true);
        noResourceEffects(resources, f.resources());
        const after = await f.snapshot(); expect(after.__sequences).toEqual(before.__sequences);
        for (const table of (await f.inventory()).tables.filter(name => !['store_order_cart_info', 'system_attachment'].includes(name))) expect(after[table]).toEqual(before[table]);
        evidence.push({ kind: 'intentional-owner-attachment-race', before: await retain(before), after: await retain(after), statements: [...statements], resourcesBefore: resources, resourcesAfter: f.resources(), signsAfterOwnedCommit: true });
      } finally { sign.mockRestore(); }
      expect((await new KefuFulfillmentService(createContainerFromDb(peer.db), f.env).splitCartInfo(101, ids.order))[0].image).toBe('');
    });
  }));

  it('sees a committed real transfer before an owned snapshot and permits an already-authorized in-flight snapshot to finish', async () => run(async ({ peer }) => {
    for (const timing of ['before-begin', 'after-reference'] as const) {
      await f.reset(); await f.withRuntimeRole(async other => {
        await f.installPlan(other); let moved = false; const statements: string[] = [];
        const transfer = async () => { expect(moved).toBe(false); const value = await new KefuTransferService(createContainerFromDb(other.db)).transfer(1, 101,
          { uid: 201, kefuToUid: 102, is_tourist: 0, request_key: crypto.randomUUID() }); expect(value.to_uid).toBe(102); moved = true; statements.push('REAL_TRANSFER_COMMITTED'); };
        const db = observe(peer.db, { beforeTransaction: timing === 'before-begin' ? transfer : undefined,
          after: async statement => { statements.push(statement); if (!moved && timing === 'after-reference' && statement.includes('from "store_order"')) await transfer(); },
          execute: statement => { statements.push(statement); } });
        const before = await f.snapshot(), resources = f.resources(); const pending = new KefuFulfillmentService(createContainerFromDb(db), f.env).splitCartInfo(101, ids.order);
        if (timing === 'before-begin') await expect(pending).rejects.toThrow('订单不存在');
        else { const rows = await pending; expect(rows.map(row => row.id)).toEqual(f.expectedCartIds); signed(rows[0].image, f.refs.platform); }
        expect(moved).toBe(true); evidence.push({ kind: 'intentional-transfer-snapshot-race', timing, before: await retain(before), after: await retain(await f.snapshot()), statements: [...statements], resourcesBefore: resources, resourcesAfter: f.resources() });
      });
    }
  }));

  it('sees a real transfer committed after owned BEGIN/SET TRANSACTION but before the first timeout SELECT acquires its snapshot', async () => run(async ({ peer }) => {
    await f.withRuntimeRole(async other => {
      await f.installPlan(other); let moved = false, started = false, configured = false; const statements: string[] = [];
      const before = await f.snapshot(), resources = f.resources();
      const db = observe(peer.db, {
        transactionStarted: () => { expect(started).toBe(false); started = true; statements.push('OWNED_TRANSACTION_ENTERED'); },
        beforeExecute: async statement => {
          if (/SELECT[\s\S]*set_config/i.test(statement)) {
            expect(started).toBe(true); expect(configured).toBe(true); expect(moved).toBe(false);
            expect(await new KefuTransferService(createContainerFromDb(other.db)).transfer(1, 101,
              { uid: 201, kefuToUid: 102, is_tourist: 0, request_key: crypto.randomUUID() })).toMatchObject({ to_uid: 102 });
            moved = true; statements.push('REAL_TRANSFER_COMMITTED_AFTER_SET_BEFORE_SNAPSHOT_SELECT');
          }
        },
        execute: statement => {
          if (/SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY/i.test(statement)) configured = true;
          statements.push(statement);
        },
        after: statement => { statements.push(statement); },
      });
      await expect(new KefuFulfillmentService(createContainerFromDb(db), f.env).splitCartInfo(101, ids.order)).rejects.toThrow('订单不存在');
      expect(moved).toBe(true);
      const marker = statements.indexOf('REAL_TRANSFER_COMMITTED_AFTER_SET_BEFORE_SNAPSHOT_SELECT');
      expect(marker).toBeGreaterThan(statements.findIndex(value => /SET TRANSACTION/i.test(value)));
      expect(marker).toBeLessThan(statements.findIndex(value => /SELECT[\s\S]*set_config/i.test(value)));
      expect(statements.filter(value => value.includes('from "store_order_cart_info"') || value.includes('from "system_attachment"'))).toEqual([]);
      evidence.push({ kind: 'intentional-transfer-between-set-and-first-snapshot-select', before: await retain(before), after: await retain(await f.snapshot()),
        statements: [...statements], resourcesBefore: resources, resourcesAfter: f.resources(), completedTransferVisibleToNewSnapshot: true });
    });
  }));

  it('keeps caller transaction prototype/isolation and rollback ownership without nested BEGIN, SET or caller completion', async () => run(async ({ peer }) => {
    let transactions = 0, committed = false, signs = 0; const commands: string[] = [], before = await f.snapshot(), resources = f.resources(), stop = new Error('owned caller rollback');
    const db = observe(peer.db, { execute: statement => { commands.push(statement); }, transactionStarted: () => { transactions++; }, committed: () => { committed = true; } });
    const actual = crypto.subtle.sign.bind(crypto.subtle), sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => { expect(committed).toBe(false); signs++; return actual(...args); });
    try {
      await expect(withTx(createContainerFromDb(db), async tx => {
        expect(tx instanceof PgTransaction).toBe(true); const [initial] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`);
        const service = new KefuFulfillmentService(createContainerFromDb(tx), f.env); signed((await service.splitCartInfo(101, ids.order))[0].image, f.refs.platform);
        await tx.update(storeOrderCartInfo).set({ splitSurplusNum: 1 }).where(eq(storeOrderCartInfo.id, ids.carts.platform)); expect((await service.splitCartInfo(101, ids.order))[0].surplus_num).toBe(1);
        const [end] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`); expect(end).toEqual(initial); throw stop;
      })).rejects.toBe(stop);
      expect(transactions).toBe(1); expect(committed).toBe(false); expect(signs).toBeGreaterThan(0);
      expect(commands.some(command => /set\s+transaction|set_config/i.test(command))).toBe(false);
      expect(await f.snapshot()).toEqual(before); noResourceEffects(resources, f.resources());
      evidence.push({ kind: 'caller-rollback-and-isolation', commands: [...commands], transactions, signsBeforeCallerCompletion: signs, before: await retain(before), after: await retain(await f.snapshot()) });
    } finally { sign.mockRestore(); }
  }));

  it('explicitly retains an established caller RR grant after a later transfer with signing before caller commit', async () => run(async ({ peer }) => {
    await f.withRuntimeRole(async other => {
      await f.installPlan(other); let callerFinished = false;
      const actual = crypto.subtle.sign.bind(crypto.subtle), sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => { expect(callerFinished).toBe(false); return actual(...args); });
      const before = await f.snapshot(), resources = f.resources();
      try { await withTx(createContainerFromDb(peer.db), async tx => {
        await tx.execute(sql.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'));
        expect(await tx.select().from(storeServiceRecord).where(eq(storeServiceRecord.id, 1))).toHaveLength(1);
        expect(await new KefuTransferService(createContainerFromDb(other.db)).transfer(1, 101, { uid: 201, kefuToUid: 102, is_tourist: 0, request_key: crypto.randomUUID() })).toMatchObject({ to_uid: 102 });
        const rows = await new KefuFulfillmentService(createContainerFromDb(tx), f.env).splitCartInfo(101, ids.order); signed(rows[0].image, f.refs.platform);
      }); callerFinished = true; expect(sign).toHaveBeenCalled();
      evidence.push({ kind: 'explicit-caller-RR-limitation', oldSnapshotCanComplete: true, signingPrecedesCallerCommit: true, before: await retain(before), after: await retain(await f.snapshot()), resourcesBefore: resources, resourcesAfter: f.resources() });
      } finally { sign.mockRestore(); }
    });
  }));

  it('uses one real supplier and attachment query for one or100 complete preview rows with an immutable per-case trace', async () => run(async ({ token, get }) => {
    for (const count of [1, 100]) {
      await f.db.delete(storeOrderCartInfo);
      const seed = f.splitSeeds.carts.find(row => row.id === ids.carts.supplier)!;
      await f.db.insert(storeOrderCartInfo).values(Array.from({ length: count }, (_, i) => ({ ...seed, id: 15_000 + i, cartId: `owned-batch-${i}`, unique: `owned-batch-${i}` })));
      const result = await get(route(), token); expect(result.payload?.status).toBe(200); expect(result.payload!.data).toHaveLength(count);
      for (const row of result.payload!.data) signed(row.cart_info.product.attrInfo.image, f.refs.supplier);
      expect(result.statements.filter(value => value.includes('from "system_supplier"'))).toHaveLength(1);
      expect(result.statements.filter(value => value.includes('from "system_attachment"'))).toHaveLength(1);
      evidence.push({ kind: 'complete-cart-batching', count, supplierQueries: 1, attachmentQueries: 1, statements: [...result.statements] });
    }
  }));

  it('allows10000 rows and rejects a complete10001-row result before attachment SQL instead of returning a prefix', async () => run(async ({ token, get }) => {
    await f.db.delete(storeOrderCartInfo).where(ne(storeOrderCartInfo.id, ids.carts.platform));
    await f.exec(`INSERT INTO public.store_order_cart_info SELECT (jsonb_populate_record(NULL::public.store_order_cart_info,to_jsonb(t)||jsonb_build_object('id',g,'cart_id','budget-'||g,'unique','budget-'||g))).* FROM public.store_order_cart_info t CROSS JOIN generate_series(20000,29998) g WHERE t.id=${ids.carts.platform}`);
    const allowed = await get(route(), token); expect(allowed.payload?.status).toBe(200); expect(allowed.payload!.data).toHaveLength(10_000);
    signed(allowed.payload!.data[9999].image, f.refs.platform);
    await f.exec(`INSERT INTO public.store_order_cart_info SELECT (jsonb_populate_record(NULL::public.store_order_cart_info,to_jsonb(t)||jsonb_build_object('id',29999,'cart_id','budget-29999','unique','budget-29999'))).* FROM public.store_order_cart_info t WHERE t.id=${ids.carts.platform}`);
    const rejected = await get(route(), token); expect(rejected.payload?.status).toBe(400); expect(rejected.payload?.data).toBeNull();
    expect(rejected.statements.filter(value => value.includes('from "system_attachment"') || value.includes('from "system_supplier"'))).toEqual([]);
  }));

  it('allows exactly16Mi complete snapshot UTF16 units and rejects one extra before metadata SQL', async () => run(async ({ token, get }) => {
    await f.db.delete(storeOrderCartInfo).where(ne(storeOrderCartInfo.id, ids.carts.platform));
    const data = { product: { image: '/static/within-split-budget.png' }, padding: '' };
    const overhead = JSON.stringify(data).length;
    data.padding = 'x'.repeat(MAX_KEFU_SPLIT_CART_SNAPSHOT_UNITS - overhead);
    expect(JSON.stringify(data).length).toBe(MAX_KEFU_SPLIT_CART_SNAPSHOT_UNITS);
    await patch(ids.carts.platform, data); const allowed = await get(route(), token);
    expect(allowed.payload?.status).toBe(200); expect(allowed.payload!.data[0].image).toBe('/static/within-split-budget.png');
    data.padding += 'x'; await patch(ids.carts.platform, data); const rejected = await get(route(), token);
    expect(rejected.payload?.status).toBe(400); expect(rejected.payload?.data).toBeNull();
    expect(rejected.statements.filter(value => value.includes('from "system_attachment"') || value.includes('from "system_supplier"'))).toEqual([]);
  }));
});

