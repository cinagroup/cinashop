/** Real registered application and genuine non-owner SELECT LOGIN. Only DI
 * request connection wiring and the explicitly local R2 get boundary are
 * supplied. No activity/owner/financial service is mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { systemConfig, storeIntegral, storeProduct, storeProductAttrValue, storeProductDescription } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';
import type { IntegralDetail } from '../src/services/activity/IntegralProductDetailData';
import { integralProductReadFixture, integralReadBindings } from './helpers/integralProductReadFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Owned integral read HTTP connection unavailable'); return wiring.container;
} }));
type LocalObject = Pick<R2ObjectBody, 'body' | 'httpEtag' | 'size' | 'writeHttpMetadata'>;
type HttpBindings = Pick<Env, 'APP_KEY' | 'PUBLIC_H5_ORIGIN' | 'UPSTASH_REDIS_URL' | 'UPSTASH_REDIS_TOKEN'> & { NODE_ENV: 'test'; ASSETS_BUCKET: { get: (key: string) => Promise<LocalObject> } };
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('integral detail registered HTTP and local asset capability', () => {
  let f: Awaited<ReturnType<typeof integralProductReadFixture>>, guard: ReturnType<typeof vi.spyOn>, token: string;
  const app = createApp(), gets: string[] = [];
  // The unused Workers bindings/methods are intentionally absent. Their real
  // used field types are checked before this explicit test binding boundary.
  const bindings = { ...integralReadBindings, PUBLIC_H5_ORIGIN: 'https://cinashop-h5.pages.dev', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', NODE_ENV: 'test', ASSETS_BUCKET: { get: async (key: string): Promise<LocalObject> => {
    gets.push(key); return { body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([4, 5, 6])); controller.close(); } }),
      httpEtag: '"owned-integral-image"', size: 3, writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'image/png') };
  } } } satisfies HttpBindings;
  const env = bindings as unknown as Env;
  beforeEach(async () => { f = await integralProductReadFixture(); gets.length = 0; env.PUBLIC_H5_ORIGIN = 'https://cinashop-h5.pages.dev';
    token = (await createToken(11, 'api', md5('owned-integral-password'), bindings.APP_KEY)).token;
    guard = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Integral detail must not call providers or fetch media'));
  }, 30000);
  afterEach(async () => { try { if (guard) expect(guard).not.toHaveBeenCalled(); } finally { guard?.mockRestore(); wiring.container = undefined; await f?.close(); } }, 30000);
  async function profile(run: () => Promise<void>) {
    await f.withRuntimeRole(async peer => {
      await f.installSelectSlice(peer, 'app'); expect((await peer.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: peer.role, session_user: peer.role });
      wiring.container = createContainerFromDb(peer.db); Object.assign(env, { HYPERDRIVE: { connectionString: peer.connectionString } as Env['HYPERDRIVE'] });
      try { await run(); } finally { wiring.container = undefined; }
    });
  }
  async function detail(id = '9', authenticated = false) {
    const response = await app.request(`/api/store_integral/detail/${id}`, { headers: authenticated ? { Authorization: `Bearer ${token}` } : {} }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: IntegralDetail | null }>() };
  }
  it('serves the actual public controller anonymously and with a real user JWT without exposing private rows', async () => {
    await profile(async () => {
      const before = await f.snapshot();
      for (const authenticated of [false, true]) {
        const result = await detail('9', authenticated); expect(result.response.status).toBe(200); expect(result.body.status).toBe(200);
        expect(result.response.headers.get('Cache-Control')).toContain('no-store'); expect(result.body.data?.storeInfo).toMatchObject({ id: 9, productId: 70, storeName: '积分商品' });
        expect(result.body.data?.skus[1]).toMatchObject({ unique: 'blue0009', price: '4.25', integral: 10, stock: 6, purchasable: true });
        expect(JSON.stringify(result.body.data)).not.toMatch(/account|pwd|customForm|cost|settlePrice|diskInfo|PRIVATE/);
      }
      expect(gets).toEqual([]); expect(await f.snapshot()).toEqual(before);
    });
  });
  it('uses the owner-verified emitted asset signature on the actual local R2 asset route', async () => {
    await profile(async () => {
      const result = await detail(), image = result.body.data!.storeInfo.image;
      const query = new URL(image, 'https://owned.local'), expires = query.searchParams.get('expires')!, signature = query.searchParams.get('signature')!;
      expect(query.pathname).toBe('/api/assets/41'); expect(signature).toBe(createHmac('sha256', bindings.APP_KEY).update(`GET\n/api/assets/41\n${expires}`).digest('base64url'));
      const before = await f.snapshot(), response = await app.request(query.pathname + query.search, undefined, env);
      expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('image/png'); expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([4, 5, 6]);
      expect((await app.request(`/api/assets/41?expires=${expires}&signature=invalid`, undefined, env)).status).toBe(404);
      expect(gets).toEqual(['attachments/admin/1/2026/10/integral.png']); expect(await f.snapshot()).toEqual(before);
      expect(result.body.data!.storeInfo.description).not.toContain('/api/assets/43');
      const expiredSignature = createHmac('sha256', bindings.APP_KEY).update('GET\n/api/assets/41\n0').digest('base64url');
      const foreignExpires = String(Math.floor(Date.now() / 1000) + 60), foreignSignature = createHmac('sha256', bindings.APP_KEY).update(`GET\n/api/assets/43\n${foreignExpires}`).digest('base64url');
      const aliasSource = `<img src="/a/../api/assets/41?expires=0&amp;signature=${expiredSignature}">` +
        `<a href="/%61pi/%61ssets/41?expires=0&amp;signature=${expiredSignature}">本商品素材</a>` +
        `<img src="https://other.example/a/../api/assets/41?expires=0&amp;signature=${expiredSignature}">` +
        `<img src="/a/../api/assets/43?expires=${foreignExpires}&amp;signature=${foreignSignature}">` +
        `<a href="https://other.example/%61pi/assets/43?expires=${foreignExpires}&amp;signature=${foreignSignature}">异属素材</a>`;
      await f.db.update(storeProductDescription).set({ description: aliasSource }).where(and(eq(storeProductDescription.productId, 9), eq(storeProductDescription.type, 4)));
      const aliasBefore = await f.snapshot(), aliases = await detail(), aliasBody = aliases.body.data!.storeInfo.description;
      expect(aliases.body.status).toBe(200); expect(aliasBody.match(/(?:href|src)="\/api\/assets\/41\?expires=/g)).toHaveLength(3);
      expect(aliasBody).not.toContain(expiredSignature); expect(aliasBody).not.toContain(foreignSignature);
      expect(aliasBody).not.toMatch(/\/api\/assets\/43|expires=0(?:&|&amp;)|other\.example|\/a\/\.\.|%61pi/);
      expect(aliases.body.data!.issues).toContain('image_unavailable'); expect(await f.snapshot()).toEqual(aliasBefore);
      // The 200k bound is stored HTML, before verified references become signed
      // URLs. A consumer must accept that legitimate bounded output expansion.
      const media = '<img src="/api/assets/41">', source = `<p>${'a'.repeat(200000 - media.length - 9)}\u0007\u007f${media}</p>`;
      expect(new TextEncoder().encode(source).byteLength).toBe(200000);
      await f.db.update(storeProductDescription).set({ description: source }).where(and(eq(storeProductDescription.productId, 9), eq(storeProductDescription.type, 4)));
      const expandedBefore = await f.snapshot(), expanded = await detail(), body = expanded.body.data!.storeInfo.description;
      expect(expanded.body.status).toBe(200); expect(body).toContain('/api/assets/41?expires=');
      expect(body).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
      expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(200000);
      expect(new TextEncoder().encode(body).byteLength).toBeLessThan(2 * 1024 * 1024);
      expect(await f.snapshot()).toEqual(expandedBefore); expect(gets).toEqual(['attachments/admin/1/2026/10/integral.png']);
    });
  });
  it('takes share origin only from the canonical H5 deployment binding and emits empty for absent or malicious values', async () => {
    await f.db.insert(systemConfig).values({ id: 51, menuName: 'site_url', value: '"https://untrusted-sql.example"', sort: 100 });
    await profile(async () => { const before = await f.snapshot();
      for (const [value, expected] of [['https://cinashop-h5.pages.dev', 'https://cinashop-h5.pages.dev'], [undefined, ''],
        ['https://user@evil.example', ''], ['https://evil.example/path', ''], ['https://evil.example:443', ''], ['http://evil.example', '']] as const) {
        env.PUBLIC_H5_ORIGIN = value; const result = await detail(); expect(result.body.status).toBe(200); expect(result.body.data?.siteUrl).toBe(expected);
      }
      expect(await f.snapshot()).toEqual(before); expect(gets).toEqual([]);
    });
  });
  it('rejects noncanonical activity IDs with the exact existing validation envelope and no writes', async () => {
    await profile(async () => { const before = await f.snapshot();
      for (const value of ['09', '9.0', '9e0', '0', '-1', '2147483648', '%209']) { const result = await detail(value); expect(result.response.status).toBe(200); expect(result.body).toMatchObject({ status: 400, data: null }); }
      expect(gets).toEqual([]); expect(await f.snapshot()).toEqual(before);
    });
  });
  it('honors real station-open middleware before both authenticated and anonymous detail reads', async () => {
    await f.db.insert(systemConfig).values({ id: 50, menuName: 'station_open', value: '0', sort: 10 });
    await profile(async () => { const before = await f.snapshot();
      for (const authenticated of [false, true]) expect((await detail('9', authenticated)).body).toEqual({ status: 410010, msg: '站点升级中，请稍候访问', data: null });
      expect(await f.snapshot()).toEqual(before); expect(gets).toEqual([]);
    });
  });
  it('preserves public sold-out detail and reports bad historical SKU as disabled rather than an unsafe checkout identity', async () => {
    await f.db.update(storeProductAttrValue).set({ unique: 'bad\n', integral: -1 }).where(eq(storeProductAttrValue.id, 91));
    await f.db.update(storeIntegral).set({ quota: 0 }).where(eq(storeIntegral.id, 9));
    await profile(async () => { const result = await detail(); expect(result.body.status).toBe(200); expect(result.body.data?.saleStock).toBe(0);
      expect(result.body.data?.skus[1]).toMatchObject({ unique: '', integral: 0, stock: 0, purchasable: false }); expect(result.body.data?.skus[1].issues).toContain('sku_identity_invalid');
    });
  });
  it('fails closed for a hidden base product using the existing precise business404 envelope', async () => {
    await f.db.update(storeProduct).set({ isShow: 0 }).where(eq(storeProduct.id, 70));
    await profile(async () => { const before = await f.snapshot(), result = await detail(); expect(result.response.status).toBe(200); expect(result.body).toEqual({ status: 404, msg: '积分商品不存在、已下架或关联信息异常', data: null }); expect(await f.snapshot()).toEqual(before); expect(gets).toEqual([]); });
  });
});
