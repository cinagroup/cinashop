import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { StoreProductService } from '../src/services/product/StoreProductService';
import { ProductExperienceService } from '../src/services/product/ProductExperienceService';
import { PublicBrandingService } from '../src/services/system/PublicBrandingService';
import { createToken, md5 } from '../src/utils/jwt';
import { NotFoundException } from '../src/utils/errors';

// Real app, middleware, routes, auth and controllers. Only external data/services
// are replaced: this suite never opens a database or sends a Redis request.
const fixtures = vi.hoisted(() => ({
  failContainer: false,
  user: { uid: 901, account: 'cache-fixture', pwd: 'synthetic-password-hash',
    status: 1, nickname: 'Fixture', avatar: '', phone: '', nowMoney: '0', integral: 0, level: 0 },
}));
vi.mock('../src/lib/di', () => ({
  createContainer: () => {
    if (fixtures.failContainer) throw new Error('synthetic DI failure');
    return { userDao: { findForAuth: async () => fixtures.user } };
  },
}));

const bindings = { NODE_ENV: 'test', APP_KEY: 'cache-policy-test-only-signing-key',
  UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', ALLOWED_ORIGINS: 'https://shop.example.test' };
const pending: Promise<unknown>[] = [];
const context = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
  passThroughOnException: () => {}, props: {} };
const policy = 'private, no-store, max-age=0';

beforeEach(() => {
  fixtures.failContainer = false;
  vi.spyOn(ProductExperienceService.prototype, 'recordVisit').mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => { await Promise.all(pending.splice(0)); vi.restoreAllMocks(); });

describe('assembled Worker HTTP cache policy', () => {
  it.each(['/api/products?page=1&limit=8', '/api/products?page=1&limit=100'])
    ('does not cache dynamic catalogue %s', async (path) => {
      const list = vi.spyOn(StoreProductService.prototype, 'getGoodsList')
        .mockResolvedValue({ list: [{ id: 70, image: '/new-a.svg' }], count: 1 });
      const response = await createApp().request(path, {}, bindings, context);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 200, data: { count: 1, list: [{ image: '/new-a.svg' }] } });
      expect(list).toHaveBeenCalledWith(expect.any(Object), 0);
      expect(response.headers.get('Cache-Control')).toBe(policy);
    });

  it.each(['/api/product/detail/70', '/api/product/detail/70/0'])
    ('keeps anonymous and authenticated detail private at %s', async (path) => {
      vi.spyOn(StoreProductService.prototype, 'getProductDetail').mockImplementation(async (id, uid) =>
        ({ id, image: '/new-a.svg', uid, userCollect: uid > 0, price: '99.90', attr_value: [] }));
      const { token } = await createToken(fixtures.user.uid, 'api', md5(fixtures.user.pwd), bindings.APP_KEY);
      const app = createApp();
      for (const [header, uid] of [[null, 0], ['Authorization', 901], ['Authori-zation', 901]] as const) {
        const response = await app.request(path, { headers: header ? { [header]: `Bearer ${token}` } : {} }, bindings, context);
        expect(await response.json()).toMatchObject({ status: 200, data: { uid, userCollect: uid > 0, image: '/new-a.svg' } });
        expect(response.headers.get('Cache-Control')).toBe(policy);
      }
    });

  it.each(['/api/product/detail/0', '/api/product/detail/70/99', '/api/v2/get_attr/0/0'])
    ('protects early HTTP-200 validation envelopes at %s', async (path) => {
      const response = await createApp().request(path, {}, bindings, context);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe(policy);
    });

  it('protects service failures and not-found envelopes without changing their contract', async () => {
    const detail = vi.spyOn(StoreProductService.prototype, 'getProductDetail');
    for (const [error, code] of [[new NotFoundException('商品已下架'), 404], [new Error('private detail'), 500]] as const) {
      detail.mockRejectedValueOnce(error);
      const response = await createApp().request('/api/product/detail/70', {}, bindings, context);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: code, data: null });
      expect(response.headers.get('Cache-Control')).toBe(policy);
    }
  });

  it('protects mandatory-login rejection before its controller runs', async () => {
    const response = await createApp().request('/api/user', {}, bindings, context);
    expect(await response.json()).toMatchObject({ status: 410000, data: null });
    expect(response.headers.get('Cache-Control')).toBe(policy);
  });

  it('protects container failure before routing', async () => {
    fixtures.failContainer = true;
    const response = await createApp().request('/health', {}, bindings, context);
    expect(await response.json()).toMatchObject({ status: 500 });
    expect(response.headers.get('Cache-Control')).toBe(policy);
  });

  it.each(['/health', '/api/not-a-route', '/adminapi/not-a-route', '/supplierapi/not-a-route', '/outapi/not-a-route', '/kefuapi/not-a-route'])
    ('defaults unclassified response %s to no-store', async (path) => {
      const response = await createApp().request(path, {}, bindings, context);
      expect(response.headers.get('Cache-Control')).toBe(policy);
    });

  it('preserves explicit public branding cache but not an exception after it is set', async () => {
    const site = vi.spyOn(PublicBrandingService.prototype, 'siteConfig').mockResolvedValue({
      site_name: 'Fixture', record_No: '', site_logo: '', site_logo_square: '',
      login_logo: '', ico_path: '', admin_login_slide: [],
    });
    const app = createApp();
    const ok = await app.request('/api/site_config', {}, bindings, context);
    expect(ok.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=300');
    expect(await ok.json()).toMatchObject({ status: 200, data: { site_name: 'Fixture' } });
    site.mockRejectedValueOnce(new Error('synthetic branding failure'));
    const failure = await app.request('/api/site_config', {}, bindings, context);
    expect(await failure.json()).toMatchObject({ status: 500 });
    expect(failure.headers.get('Cache-Control')).toBe(policy);
  });

  it('covers CORS early return without modifying the preflight contract', async () => {
    const response = await createApp().request('/api/products', { method: 'OPTIONS', headers: {
      Origin: 'https://shop.example.test', 'Access-Control-Request-Method': 'GET',
    } }, bindings, context);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(response.headers.get('Cache-Control')).toBe(policy);
  });
});
