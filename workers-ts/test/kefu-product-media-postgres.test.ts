import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { storeProduct, storeProductDescription, storeServiceRecord, systemAttachment, systemSupplier, user } from '@/models/schema';
import { KefuProductService } from '@/services/kefu/KefuProductService';
import { readKefuProductMedia } from '@/services/kefu/KefuProductMediaPolicy';
import { createToken, md5, verifyToken } from '@/utils/jwt';
import { setTokenBucket } from '@/utils/cache';
import { kefuProductMediaFixture } from './helpers/kefuProductMediaFixture';

// Only the external Redis SDK transport is local. Application login, token
// domains, expiry, password, SQL grants, owner policy and HMAC run unchanged.
const redis = vi.hoisted(() => new Map<string, { value: unknown; until: number }>());
vi.mock('@upstash/redis/cloudflare', () => ({ Redis: class {
  async set(key: string, value: unknown, options: { ex?: number } = {}) { redis.set(key, { value: structuredClone(value), until: Date.now() + (options.ex ?? 3600) * 1000 }); return 'OK'; }
  async get(key: string) { const row = redis.get(key); return row && row.until > Date.now() ? structuredClone(row.value) : null; }
  async del(key: string) { return Number(redis.delete(key)); }
} }));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Payload = { status: number; msg: string; data: any };

/** Observe fulfilled real SQL and transaction completion, never replace a query
 * result or an application authorization decision. Proxies preserve prototypes. */
function observe(db: DbClient, after: (statement: string) => Promise<void> | void, committed?: () => void): DbClient {
  const query = (builder: any): any => new Proxy(builder, { get(target, key) {
    if (key === 'then') return (resolve: any, reject: any) => target.then(async (rows: unknown) => { await after(target.toSQL().sql); return rows; }).then(resolve, reject);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? (...args: unknown[]) => { const next = value.apply(target, args); return next && typeof next === 'object' && typeof next.toSQL === 'function' ? query(next) : next; } : value;
  } });
  const database = (client: any): DbClient => new Proxy(client, { get(target, key) {
    if (key === 'select') return (...args: unknown[]) => query(target.select(...args));
    if (key === 'transaction') return async (work: any, ...args: unknown[]) => { const result = await target.transaction((tx: any) => work(database(tx)), ...args); committed?.(); return result; };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } }) as DbClient;
  return database(db);
}

describe.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL)('Kefu product media on actual Hono routes and independent PostgreSQL16 LOGIN', () => {
  let f: Awaited<ReturnType<typeof kefuProductMediaFixture>>, directory = '';
  const evidence: Record<string, unknown>[] = [];
  beforeAll(async () => { f = await kefuProductMediaFixture(); directory = await mkdtemp(join(tmpdir(), 'cinashop-kefu-product-media-native-')); }, 30_000);
  beforeEach(async () => { redis.clear(); await f.reset(); });
  afterAll(async () => { try { if (f && directory) await writeFile(join(directory, 'execution.json'), JSON.stringify({ tables: f.tables, sequences: f.sequences, evidence }, null, 2) + '\n');
    console.info('KEFU_PRODUCT_MEDIA_NATIVE', JSON.stringify({ directory, checks: evidence.length }));
  } finally { await f?.close(); } }, 30_000);

  const run = async (work: (context: { peer: Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0]; token: string;
    get: (path: string, token?: string, objectReads?: number) => Promise<{ response: Response; payload: Payload | null; bytes: Uint8Array }>;
    login: (account: string) => Promise<string> }) => Promise<void>) => f.withRuntimeRole(async peer => {
    await f.installPlan(peer);
    const [identity] = await peer.db.execute(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version`);
    console.info('KEFU_MEDIA_SQL_CONTEXT', JSON.stringify(identity));
    const app = f.appFor(peer.db);
    const login = async (account: string) => {
      const response = await app.request('https://owned-kefu-media.local/kefuapi/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account, password: f.password }) }, f.env);
      const payload = await response.json() as Payload; expect(payload.status).toBe(200); expect(payload.data.kefuInfo).not.toHaveProperty('password'); return payload.data.token as string;
    };
    const token = await login('actual-kefu-one');
    const get = async (path: string, auth?: string, objectReads = 0) => {
      const before = await f.snapshot(), resources = f.resources();
      const response = await app.request('https://owned-kefu-media.local/kefuapi' + path, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} }, f.env);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const payload = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(new TextDecoder().decode(bytes)) as Payload : null;
      const after = await f.snapshot(), end = f.resources(); expect(after).toEqual(before);
      for (const name of ['kvPut', 'kvDelete', 'kvList', 'r2Put', 'r2Delete', 'r2List', 'queueSend', 'queueSendBatch', 'sequence', 'chatTransfer', 'chatDisconnect'] as const) expect(end[name], name).toBe(resources[name]);
      expect(end.r2Get - resources.r2Get).toBe(objectReads); expect(end.r2Head).toBe(resources.r2Head); expect(end.objects).toEqual(resources.objects);
      evidence.push({ path, http: response.status, status: payload?.status, before: hash(before), after: hash(after), resourcesBefore: resources, resourcesAfter: end, bodyBytes: bytes.length, bodySha256: createHash('sha256').update(bytes).digest('hex') });
      return { response, payload, bytes };
    };
    await work({ peer, token, get, login });
  });
  function signed(value: string, reference: string) {
    const url = new URL(value, 'https://owned-kefu-media.local'), expires = Number(url.searchParams.get('expires'));
    expect(url.pathname).toBe(reference); expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']);
    expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000)); expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 900);
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', f.env.APP_KEY).update('GET\n' + reference + '\n' + expires).digest('base64url'));
  }
  const assetPath = (value: string) => value.replace(/^\/api\//, '/');
  const routes = ['/product/cart/201', '/product/visit/201', '/product/hot/201'];
  const patch = (value: Partial<typeof storeProduct.$inferInsert>, id = 501) => f.db.update(storeProduct).set(value).where(eq(storeProduct.id, id));

  it('keeps purchase, visit duplicates, hot ranking, decimal fields and hidden-product visibility while signing only admissible media', async () => run(async ({ token, get }) => {
    const ids = [[501, 502, 503, 504], [505, 504, 503, 501, 502, 501], [505, 502, 501, 503, 504]];
    for (const [index, path] of routes.entries()) {
      const result = await get(path, token); expect(result.payload?.status).toBe(200); const rows = result.payload!.data as any[]; expect(rows.map(row => row.id)).toEqual(ids[index]);
      for (const row of rows) { expect(Object.keys(row).sort()).toEqual(['id', 'sales', 'store_name', 'image', 'stock', 'price', ...(index === 2 ? ['ot_price'] : [])].sort());
        if (row.id === 504) expect(row.image).toBe(''); else signed(row.image, row.id === 502 ? f.refs.supplier : f.refs.platform);
      }
      expect(rows.find(row => row.id === 501)).toMatchObject({ price: '12.34', sales: 15, stock: 11 });
    }
    const page = await get('/product/cart/201?page=2&limit=2', token); expect(page.payload!.data.map((row: any) => row.id)).toEqual([503, 504]);
    const search = await get('/product/cart/201?store_name=' + encodeURIComponent('供应商'), token); expect(search.payload!.data.map((row: any) => row.id)).toEqual([502]);
  }));
  it('renders authenticated and public detail with identical complete slider positions and unchanged description/price fields', async () => run(async ({ token, get }) => {
    for (const path of ['/product/info/502', '/tourist/product/502']) {
      const { payload } = await get(path, path.startsWith('/tourist') ? undefined : token); expect(payload?.status).toBe(200);
      const row = payload!.data; expect(Object.keys(row).sort()).toEqual(['id', 'sales', 'store_name', 'image', 'slider_image', 'price', 'vip_price', 'ot_price', 'stock', 'description'].sort());
      expect(row).toMatchObject({ id: 502, sales: 22, stock: 12, price: '23.45', vip_price: '22.22', ot_price: '29.99', description: '<p>客服媒体商品 502 说明 & 保留文本展示</p>' });
      signed(row.image, f.refs.supplier); expect(row.slider_image).toHaveLength(5); signed(row.slider_image[0], f.refs.supplier); signed(row.slider_image[1], f.refs.platform);
      expect(row.slider_image[2]).toBe(row.slider_image[0]); expect(row.slider_image.slice(3)).toEqual(['', '']);
    }
    expect((await get('/product/info/505', token)).payload?.status).toBe(200); expect((await get('/tourist/product/505')).payload?.status).toBe(404);
    await f.db.delete(storeProductDescription).where(eq(storeProductDescription.productId, 501)); expect((await get('/product/info/501', token)).payload!.data.description).toBe('');
  }));
  it('reads actual PNG bytes through the signed asset route and rejects naked, expired and tampered tickets before R2', async () => run(async ({ token, get }) => {
    const image = (await get('/product/info/501', token)).payload!.data.image as string; signed(image, f.refs.platform);
    const result = await get(assetPath(image), undefined, 1); expect(result.response.status).toBe(200); expect(result.response.headers.get('Content-Type')).toContain('image/png'); expect(result.bytes).toEqual(f.png);
    expect(result.response.headers.get('Cache-Control')).toContain('no-store');
    for (const path of [assetPath(f.refs.platform), assetPath(image.replace(/signature=[^&]+/, 'signature=wrong')), assetPath(image.replace(/expires=\d+/, 'expires=1'))]) expect((await get(path)).response.status).toBe(404);
  }));
  it('refreshes entity-encoded stale main and slider tickets without storing response signatures', async () => run(async ({ token, get }) => {
    const stale = f.refs.platform + '?expires=1&amp;signature=old'; await patch({ image: stale, sliderImage: JSON.stringify([stale, '', stale, 42, null, f.refs.user]) });
    const { payload } = await get('/product/info/501', token); signed(payload!.data.image, f.refs.platform);
    expect(payload!.data.slider_image).toEqual([payload!.data.image, '', payload!.data.image, '']);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 501)))[0].image).toBe(stale);
  }));
  it('retains full 5000-character slider JSON including 1666 positions and a legal 4996-character path', async () => run(async ({ token, get }) => {
    const many = [...Array<string>(1665).fill(''), '/']; const long = '/' + 'a'.repeat(4995);
    for (const items of [many, [long], ['https://example.invalid/' + 'a'.repeat(257)], ['/' + '图'.repeat(2490)]]) {
      const raw = JSON.stringify(items); expect([...raw].length).toBeLessThanOrEqual(5000); if (items === many || items[0] === long) expect(raw.length).toBe(5000);
      await patch({ sliderImage: raw }); const { payload } = await get('/product/info/501', token); expect(payload!.data.slider_image).toEqual(items);
    }
  }));
  it('keeps blank/duplicate slider positions, drops only nonstrings and rejects unsafe references without fetching legacy URLs', async () => run(async ({ token, get }) => {
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const refs = ['', f.refs.platform, f.refs.platform, '/static/a.png', 'https://example.invalid/a.png', '//example.invalid/a.png', 'javascript:alert(1)', 'data:image/png,AAAA', '/a\\b.png', '/a b.png', 'https://user:pw@example.invalid/a.png', '/api/assets/02', '/&#92;evil.invalid/x.png', '/foo&#x00;bar.png', '/foo&#127;bar.png', f.refs.foreign, f.refs.user];
      await patch({ sliderImage: JSON.stringify([null, ...refs, { url: f.refs.platform }, 42]) }); const { payload } = await get('/product/info/501', token);
      const images = payload!.data.slider_image as string[]; expect(images).toHaveLength(refs.length); expect(images[0]).toBe(''); signed(images[1], f.refs.platform); expect(images[2]).toBe(images[1]); expect(images.slice(3, 5)).toEqual(refs.slice(3, 5)); expect(images.slice(5)).toEqual(Array(12).fill(''));
      for (const raw of ['', 'null', '{}', 'false', '[broken']) { await patch({ sliderImage: raw }); expect((await get('/product/info/501', token)).payload!.data.slider_image).toEqual([]); }
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  }));
  it('preserves the main image 256-character field while distinguishing slider and main budgets', async () => run(async ({ token, get }) => {
    for (const reference of ['/' + 'a'.repeat(255), '/' + '图'.repeat(255)]) { await patch({ image: reference }); expect((await get('/product/info/501', token)).payload!.data.image).toBe(reference); }
    const tooLong = '/' + 'a'.repeat(256);
    await expect(f.db.update(storeProduct).set({ image: tooLong }).where(eq(storeProduct.id, 501))).rejects.toThrow();
  }));
  it('allows persisted store ownership to use platform/static media but never supplier/user or invalid store owners', async () => run(async ({ token, get }) => {
    const image = async () => (await get('/product/info/503', token)).payload!.data.image as string;
    signed(await image(), f.refs.platform);
    for (const value of ['/static/store.png', 'https://example.invalid/store.png']) { await patch({ image: value }, 503); expect(await image()).toBe(value); }
    for (const value of [f.refs.supplier, f.refs.foreign, f.refs.user]) { await patch({ image: value }, 503); expect(await image()).toBe(''); }
    for (const relationId of [0, -1, 2_147_483_647]) { await patch({ relationId, image: f.refs.platform }, 503); if (relationId > 0) signed(await image(), f.refs.platform); else expect(await image()).toBe(''); }
    for (const type of [-1, 3]) { await patch({ type, relationId: 77 }, 503); expect(await image()).toBe(''); }
  }));
  it('checks live supplier status and persisted product ownership before minting main or slider capabilities', async () => run(async ({ token, get }) => {
    for (const state of [{ isShow: 0, isDel: 0 }, { isShow: 1, isDel: 1 }]) {
      await f.db.update(systemSupplier).set(state).where(eq(systemSupplier.id, 310)); const row = (await get('/product/info/502', token)).payload!.data; expect(row.image).toBe(''); expect(row.slider_image).toEqual(['', '', '', '', '']);
    }
    await f.db.update(systemSupplier).set({ isShow: 1, isDel: 0 }).where(eq(systemSupplier.id, 310));
    await patch({ image: f.refs.platform }, 502); signed((await get('/product/info/502', token)).payload!.data.image, f.refs.platform);
    for (const image of [f.refs.foreign, f.refs.user, '/api/assets/2147483647']) { await patch({ image }, 502); expect((await get('/product/info/502', token)).payload!.data.image).toBe(''); }
    await patch({ type: 0, relationId: 310, image: f.refs.platform }, 502); expect((await get('/product/info/502', token)).payload!.data.image).toBe('');
  }));
  it('rejects registered attachment rows with contradictory module, file, object namespace, path or MIME', async () => run(async ({ token, get }) => {
    const invalid = [{ moduleType: 2 }, { fileType: 0 }, { imageType: 1 }, { type: 2, relationId: 310 }, { attDir: '/api/assets/9102' },
      { name: 'attachments/admin/0/wrong.png' }, { name: 'attachments/admin/1/../wrong.png' }, { name: 'attachments/admin/1/a\\b.png' },
      { name: 'attachments/admin/1/wrong.svg', attType: 'image/svg+xml' }, { attType: 'text/html' }, { attType: 'image/jpeg' }];
    for (const value of invalid) { await f.db.update(systemAttachment).set({ ...f.attachmentRows.platform, ...value }).where(eq(systemAttachment.attId, 9101));
      const row = (await get('/product/info/501', token)).payload!.data; expect(row.image, JSON.stringify(value)).toBe(''); expect(row.slider_image[0]).toBe(''); expect(row.slider_image[2]).toBe('');
    }
    await f.db.update(systemAttachment).set({ ...f.attachmentRows.platform, attType: '' }).where(eq(systemAttachment.attId, 9101)); signed((await get('/product/info/501', token)).payload!.data.image, f.refs.platform);
  }));
  it('rejects malformed/executable main references without R2 or external reads', async () => run(async ({ token, get }) => {
    for (const image of ['/api/assets/0', '/api/assets/02', '/api/assets/2147483648', '//example.invalid/p.png', 'javascript:alert(1)', 'data:image/png,AAAA', '/a\\b.png', '/a b.png', 'https://u:p@example.invalid/p.png', '/&#92;evil.invalid/x.png', '/foo&#x00;bar.png', '/foo&#127;bar.png']) {
      await patch({ image }); expect((await get('/product/info/501', token)).payload!.data.image, image).toBe('');
    }
  }));
  it('requires actual dedicated Kefu login and current conversation for histories while detail remains staff catalog scope', async () => run(async ({ token, get, login }) => {
    for (const path of [...routes, '/product/info/501']) {
      for (const auth of [undefined, 'invalid']) expect((await get(path, auth)).payload?.status).not.toBe(200);
    }
    for (const role of ['api', 'admin'] as const) {
      const wrong = await createToken(1, role, md5(f.passwordHash), f.env.APP_KEY);
      expect((await verifyToken(wrong.token, f.env.APP_KEY)).type).toBe(role);
      await setTokenBucket(md5(wrong.token), { uid: 1, type: role, token: wrong.token, exp: 3600 }, f.env);
      for (const path of [...routes, '/product/info/501']) expect((await get(path, wrong.token)).payload?.status).not.toBe(200);
      // Even a cache entry mislabeled as Kefu cannot change the actual signed
      // JWT domain. No middleware result or application query is substituted.
      await setTokenBucket(md5(wrong.token), { uid: 1, type: 'kefu', token: wrong.token, exp: 3600 }, f.env);
      for (const path of [...routes, '/product/info/501']) { const result = await get(path, wrong.token); expect(result.payload?.status).toBe(410002); expect(result.payload?.msg).toBe('无客服权限'); }
    }
    const other = await login('actual-kefu-two'); for (const path of routes) expect((await get(path, other)).payload?.status).toBe(404);
    expect((await get('/product/info/501', other)).payload?.status).toBe(200);
    await f.db.insert(storeServiceRecord).values({ userId: 101, toUid: 201, isTourist: 0 });
    for (const path of routes) expect((await get(path, token)).payload?.status).toBe(400);
    expect((await get('/product/info/501', token)).payload?.status).toBe(200);
  }));
  it('stops new history tickets after transfer without claiming revocation of already issued short-lived capabilities', async () => run(async ({ token, get, login }) => {
    const issued = (await get('/product/cart/201', token)).payload!.data[0].image as string;
    await f.db.update(storeServiceRecord).set({ userId: 102 }).where(eq(storeServiceRecord.id, 1));
    for (const path of routes) expect((await get(path, token)).payload?.status).toBe(404);
    expect((await get('/product/cart/201?store_name=' + encodeURIComponent('平台'), token)).payload?.status).toBe(404);
    const next = await login('actual-kefu-two'); signed((await get('/product/cart/201', next)).payload!.data[0].image, f.refs.platform);
    expect((await get('/product/info/501', token)).payload?.status).toBe(200);
    expect((await get(assetPath(issued), undefined, 1)).bytes).toEqual(f.png);
  }));
  it('hides deleted-customer histories while retaining the deliberate explicit public catalog search and details', async () => run(async ({ token, get }) => {
    await f.db.update(user).set({ deleteTime: new Date() }).where(eq(user.uid, 201));
    for (const path of routes) expect((await get(path, token)).payload!.data).toEqual([]);
    const search = await get('/product/cart/201?store_name=' + encodeURIComponent('平台'), token); expect(search.payload!.data.map((row: any) => row.id)).toEqual([501]); signed(search.payload!.data[0].image, f.refs.platform);
    expect((await get('/product/info/501', token)).payload?.status).toBe(200);
  }));
  it('retains bounds and not-found results without granting media access', async () => run(async ({ token, get }) => {
    for (const path of ['/product/info/0', '/product/info/2147483648', '/product/cart/0', '/product/cart/201?page=1000001', '/product/visit/201?limit=101']) expect((await get(path, token)).payload?.status).toBe(400);
    expect((await get('/product/info/2147483647', token)).payload?.status).toBe(404); expect((await get('/tourist/product/2147483647')).payload?.status).toBe(404);
  }));
  it('reads product owner and attachment authority in one snapshot and signs only after its owned transaction commits', async () => run(async ({ peer }) => {
    let changed = false, committed = false; const statements: string[] = [];
    const db = observe(peer.db, async statement => { statements.push(statement); if (!changed && statement.includes('from "store_product"')) { changed = true;
      await f.db.update(storeProduct).set({ type: 2, relationId: 320 }).where(eq(storeProduct.id, 501));
      await f.db.update(systemAttachment).set({ type: 2, relationId: 320, name: 'attachments/supplier/320/changed.png' }).where(eq(systemAttachment.attId, 9101));
    } }, () => { committed = true; });
    const actualSign = crypto.subtle.sign.bind(crypto.subtle); const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => { expect(committed).toBe(true); return actualSign(...args); });
    try { const before = await f.snapshot(), resources = f.resources(); const row = await new KefuProductService(createContainerFromDb(db), f.env).productInfo(501); signed(row.image, f.refs.platform);
      expect(sign).toHaveBeenCalled(); expect(changed).toBe(true); expect(statements.filter(value => value.includes('from "system_attachment"'))).toHaveLength(1); expect(f.resources()).toEqual(resources);
      const after = await f.snapshot(); expect(after.__sequences).toEqual(before.__sequences);
      // The independent maintenance writes above are intentional; every other
      // owned table is unchanged and the next request observes the new owner.
      for (const table of f.tables.filter(name => !['store_product', 'system_attachment'].includes(name))) expect(after[table]).toEqual(before[table]);
    } finally { sign.mockRestore(); }
  }));
  it('uses a fixed batched attachment lookup for a full100-product page rather than one query per image', async () => run(async ({ peer }) => {
    const [source] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 501));
    await f.db.insert(storeProduct).values(Array.from({ length: 96 }, (_, index) => ({ ...source, id: 600 + index, storeName: '客服媒体批量商品' + index })));
    const statements: string[] = []; const db = observe(peer.db, statement => { statements.push(statement); });
    const service = new KefuProductService(createContainerFromDb(db), f.env);
    for (const limit of ['1', '100']) { statements.length = 0; const rows = await service.purchasedProducts(101, 201, { store_name: '客服媒体', limit }); expect(rows).toHaveLength(Number(limit));
      expect(statements.filter(value => value.includes('from "system_attachment"'))).toHaveLength(1); for (const row of rows) if (row.id !== 504) signed(row.image, row.id === 502 ? f.refs.supplier : f.refs.platform);
    }
  }));
  it('preserves caller-owned transaction isolation and rollback ownership and retains env-free static legacy detail', async () => run(async ({ peer }) => {
    const stop = new Error('intentional caller rollback');
    await expect(withTx(createContainerFromDb(peer.db), async tx => {
      const [before] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`);
      const service = new KefuProductService(createContainerFromDb(tx), f.env); signed((await service.productInfo(501)).image, f.refs.platform);
      const [after] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`); expect(after).toEqual(before);
      await tx.update(storeProduct).set({ stock: 91 }).where(eq(storeProduct.id, 501)); await service.productInfo(501); throw stop;
    })).rejects.toBe(stop);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 501)))[0].stock).toBe(11);
    await patch({ image: '/static/legacy.png', sliderImage: JSON.stringify(['https://example.invalid/' + 'a'.repeat(257)]) });
    expect((await new KefuProductService(createContainerFromDb(peer.db)).productInfo(501)).image).toBe('/static/legacy.png');
  }));
  it('rejects a complete media input beyond10000 references before SQL and leaves all resources untouched', async () => run(async ({ peer }) => {
    const select = vi.spyOn(peer.db, 'select'); const before = await f.snapshot(), resources = f.resources();
    try { await expect(readKefuProductMedia(peer.db, Array.from({ length: 10001 }, () => ({ image: f.refs.platform, type: 0, relationId: 0 })))).rejects.toThrow('完整预览容量'); expect(select).not.toHaveBeenCalled();
      expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(resources);
    } finally { select.mockRestore(); }
  }));
});
