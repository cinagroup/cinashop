import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { createContainerFromDb } from '../src/lib/di';
import type { AppVariables, Env } from '../src/env';
import { supplierapiRoutes } from '../src/routes/supplierapi';
import * as AttachmentController from '../src/controllers/system/AttachmentController';
import { errorHandler } from '../src/middleware/error';
import { createToken, md5 } from '../src/utils/jwt';
import * as cache from '../src/utils/cache';
import { canonicalizePublishedHtmlAttachmentReferences, sanitizePublishedArticleHtml } from '../src/services/content/ArticleContentPolicy';
import { SupplierProductManagementService } from '../src/services/supplier/SupplierProductManagementService';
import { classifyProductMediaReference } from '../../view/common/productMediaReference';
import {
  normalizeSupplierProductMediaReference, prepareSupplierProductMediaInput, projectSupplierProductMedia,
} from '../src/services/supplier/SupplierProductMediaService';
import {
  storeCart, storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue,
  storeProductCategory, storeProductDescription, storeProductRelation, storeProductStockRecord,
  systemAdmin, systemAttachment, systemRole, systemSupplier,
} from '../src/models/schema';

const tables = [storeCart, storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue,
  storeProductCategory, storeProductDescription, storeProductRelation, storeProductStockRecord,
  systemAdmin, systemAttachment, systemRole, systemSupplier];
const path = '/supplierapi/product/product';
const editingHtml = `<p style="color:red" title="a > b">原文<strong>保留</strong></p><!-- keep -->` +
  `<img SRC='/api/assets/12?expires=1&amp;signature=old' alt="图"><a href="https://docs.example/">说明</a>`;
const stableHtml = editingHtml.replace('/api/assets/12?expires=1&amp;signature=old', '/api/assets/12');
function product(overrides: Record<string, unknown> = {}) {
  return { product_type: 0, store_name: 'fixture-product', cate_id: [1],
    slider_image: ['/api/assets/11?expires=1&signature=old', 'https://images.example/legacy.jpg'],
    spec_type: 0, attrs: [{ suk: '默认', image: 'https://old.example/api/assets/13?expires=1&signature=old',
      price: '10.00', settle_price: '8.00', stock: 3 }], description: editingHtml, is_postage: 1, ...overrides };
}

describe('Supplier stable product media policy', () => {
  it('preserves editing markup and comments while stripping relative and absolute private tickets', () => {
    expect(canonicalizePublishedHtmlAttachmentReferences(editingHtml)).toBe(stableHtml);
    const html = `<DIV class='legacy' data-x="a > b"><img src=https://host.example/api/assets/123?expires=1&signature=x></DIV>尾部 <`;
    expect(canonicalizePublishedHtmlAttachmentReferences(html)).toBe(html.replace('https://host.example/api/assets/123?expires=1&signature=x', '/api/assets/123'));
    expect(sanitizePublishedArticleHtml(`<p onclick="attack()"><img src="javascript:alert(1)"><script>text</script></p>`))
      .toBe('<p><img width="100%">text</p>');
  });
  it.each(['javascript:alert(1)', 'http://images.example/one.jpg', 'https://user:pw@images.example/one.jpg',
    '//images.example/one.jpg', '/api/assets/0', '/api/assets/2147483648', '/api/assets/1/extra', 'https://images.example/\\bad'])
    ('rejects unsafe/invalid image input %s', value => expect(() => normalizeSupplierProductMediaReference(value)).toThrow());
  it('deduplicates durable references without changing legitimate external HTTPS query parameters', () => {
    const raw = product({ slider_image: ['https://images.example/a.jpg?x=1&y=2', '/api/assets/11?expires=1'] });
    const normalized = prepareSupplierProductMediaInput(raw);
    expect(normalized.slider_image).toEqual(['https://images.example/a.jpg?x=1&y=2', '/api/assets/11']);
    expect(normalized.description).toBe(stableHtml);
    expect((normalized.attrs as any[])[0].image).toBe('/api/assets/13');
    expect(raw.description).toBe(editingHtml);
  });
  it('retains safe root-relative public media while canonicalizing routed private aliases', () => {
    for (const reference of ['/api/qa/image.svg', '/isolated.png', '/images/图.jpg?x=1&y=2', '/images/a%20b.jpg'])
      expect(normalizeSupplierProductMediaReference(reference)).toBe(reference);
    for (const reference of ['/old/../api/assets/11?expires=1&signature=old', '/old/%2e%2e/api/assets/11',
      '/%61pi/assets/%31%31?ticket=old', 'https://old.example/old/../api/assets/11?ticket=old',
      '/kefuapi/assets/11?expires=1&signature=old', 'https://old.example/old/../kefuapi/assets/11?ticket=old',
      '/old/%2e%2e/%6befuapi/assets/%31%31?ticket=old'])
      expect(normalizeSupplierProductMediaReference(reference)).toBe('/api/assets/11');
  });
  it('rejects ambiguous routing aliases without dropping private paths into the public branch', () => {
    for (const value of [null, {}, 1, Symbol('not-a-url'), 'x'.repeat(4097)])
      expect(classifyProductMediaReference(value)).toEqual({ kind: 'invalid', privateNamespace: false });
    for (const reference of ['/api%2fassets%2f11', '/api/assets%2f11', '/api/%2561ssets/11',
      '/api/ass%0aets/11', '/api\\assets\\11', '/api//assets/11', '/api/assets/11/extra', '/api/assets',
      '//host.example/api/assets/11', '/images/a%ZZ.jpg', '/images/a%255c.jpg',
      '/kefuapi%2fassets%2f11', '/kefuapi/assets/11/extra', 'https:\\host.example\\kefuapi\\assets\\11'])
      expect(() => normalizeSupplierProductMediaReference(reference), reference).toThrow();
    for (const reference of ['/api%2fassets%2f11', '/api/%2561ssets/11', '/api/ass%0aets/11',
      '/kefuapi%2fassets%2f11', 'https:\\host.example\\api\\assets\\11', 'https:\\host.example\\kefuapi\\assets\\11',
      'https:/api/assets/11?ticket=old', 'https:/kefuapi/assets/11?ticket=old'])
      expect(() => prepareSupplierProductMediaInput({ description: `<unknown src="${reference}">source</unknown>` }), reference).toThrow();
  });
});

// The same HTTP suite executes with the actual native PostgreSQL driver in the
// isolated finance runner. Memory mode keeps ordinary Worker CI useful as well.
describe('Supplier product media save/read through JWT, RBAC and registered HTTP routes', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let env: Env, token: string;
  let buckets: Map<string, cache.TokenBucket>;
  let objectGet: ReturnType<typeof vi.fn>;
  beforeAll(async () => {
    f = await financePostgres(tables);
    await f.exec('ALTER TABLE store_product_description ADD UNIQUE(product_id,type)');
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', createContainerFromDb(f.db)); await next(); });
    app.onError(errorHandler); app.route('/supplierapi', supplierapiRoutes);
    app.get('/api/assets/:id', AttachmentController.asset);
  }, 45000);
  afterAll(async () => { await f?.close(); }, 45000);
  beforeEach(async () => {
    buckets = new Map();
    objectGet = vi.fn(async () => ({ body: new Blob(['owned-image']).stream(), size: 11,
      etag: 'fixture', httpEtag: '"fixture"', writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'image/png') }));
    env = { APP_KEY: crypto.randomUUID(), NODE_ENV: 'production', UPSTASH_REDIS_URL: 'https://isolated.invalid',
      UPSTASH_REDIS_TOKEN: 'fixture-only', ASSETS_BUCKET: { get: objectGet } } as unknown as Env;
    vi.spyOn(cache, 'getTokenBucket').mockImplementation(async key => buckets.get(key) ?? null);
    vi.spyOn(cache, 'clearToken').mockImplementation(async key => buckets.delete(key));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External network forbidden'); }));
    await f.reset();
    await f.exec(`INSERT INTO system_supplier(id,admin_id,supplier_name) VALUES(7,70,'owned'),(8,80,'foreign');
      INSERT INTO system_admin(id,account,admin_type,relation_id,roles,level) VALUES(27,'child',4,7,'2',1),(28,'foreign',4,8,'3',1);
      INSERT INTO system_role(id,type,relation_id,rules,status) VALUES(2,4,7,'supplier.product.manage',1),(3,4,8,'supplier.product.manage',1);
      INSERT INTO store_product_category(id,type,relation_id,cate_name) VALUES(1,2,7,'category');
      INSERT INTO system_attachment(att_id,type,module_type,relation_id,file_type,image_type,name,att_dir) VALUES
      (11,4,1,7,1,8,'attachments/own-11.png','/api/assets/11'),
      (12,4,1,7,1,8,'attachments/own-12.png','/api/assets/12'),
      (13,4,1,7,1,8,'attachments/own-13.png','/api/assets/13'),
      (21,4,1,8,1,8,'attachments/foreign.png','/api/assets/21'),
      (22,4,2,7,1,8,'attachments/wrong-module.png','/api/assets/22'),
      (23,4,1,7,2,8,'attachments/video.mp4','/api/assets/23'),
      (24,1,1,7,1,8,'attachments/wrong-type.png','/api/assets/24'),
      (25,4,1,7,1,1,'old-storage','/api/assets/25'),
      (26,4,1,7,1,8,'attachments/wrong-reference.png','/api/assets/999')`);
    token = await issue(27);
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function issue(id: number) {
    const issued = await createToken(id, 'supplier', md5(''), env.APP_KEY);
    buckets.set(md5(issued.token), { ...issued, uid: id, type: 'supplier' }); return issued.token;
  }
  async function request(id: number, input?: Record<string, unknown>, bearer = token) {
    const response = await app.request(`${path}/${id}?supplierId=8&relation_id=8`, {
      method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'X-Supplier-Id': '8' },
      ...(input ? { body: JSON.stringify(input) } : {}),
    }, env);
    return { response, body: await response.json() as { status: number; data: any; msg: string } };
  }
  it('persists stable gallery/main/SKU/HTML, returns fresh signed previews, and serves a verified private object', async () => {
    const saved = await request(0, product()); expect(saved.body.status).toBe(200);
    const id = saved.body.data.id;
    const rows = await f.db.select().from(storeProduct).where(eq(storeProduct.id, id));
    expect(rows[0]).toMatchObject({ image: '/api/assets/11', sliderImage: '["/api/assets/11","https://images.example/legacy.jpg"]', relationId: 7 });
    const first = await request(id); expect(first.body.status).toBe(200);
    const detail = first.body.data;
    expect(detail.slider_image).toEqual(['/api/assets/11', 'https://images.example/legacy.jpg']);
    expect(detail.attrs[0].image).toBe('/api/assets/13'); expect(detail.description).toBe(stableHtml);
    expect(detail.media.status).toBe('ready');
    expect(Object.keys(detail.media.previews).sort()).toEqual(['/api/assets/11', '/api/assets/12', '/api/assets/13', 'https://images.example/legacy.jpg'].sort());
    expect(detail.media.description_html).not.toMatch(/style=|onclick=|<!--/);
    expect(detail.media.description_html).toContain('signature=');
    const preview = detail.media.previews['/api/assets/11'];
    expect(preview.status).toBe('ready'); expect(preview.expires_at).toBeGreaterThan(Math.floor(Date.now()/1000));
    const asset = await app.request(preview.src, {}, env); expect(asset.status).toBe(200); expect(await asset.text()).toBe('owned-image');
    expect(objectGet).toHaveBeenCalledWith('attachments/own-11.png', undefined);
    const corrupt = await app.request(preview.src.replace(/signature=[^&]+/, 'signature=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), {}, env);
    expect(corrupt.status).not.toBe(200); expect(objectGet).toHaveBeenCalledTimes(1);
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 60000);
    const next = await request(id); expect(next.body.data.media.previews['/api/assets/11'].expires_at).toBe(preview.expires_at + 60);
    expect(next.body.data.description).toBe(stableHtml);
    expect(first.response.headers.get('cache-control')).toContain('no-store');
  });
  it.each(['gallery','sku','html','hidden-html'])('rejects foreign private references in %s and rolls back every business write', async location => {
    const input = product();
    if (location === 'gallery') input.slider_image = ['/api/assets/21'];
    if (location === 'sku') (input.attrs as any[])[0].image = '/api/assets/21';
    if (location === 'html') input.description = '<img src="/api/assets/21">';
    if (location === 'hidden-html') input.description = '<unknown src="/api/assets/21">old text</unknown>';
    const result = await request(0, input); expect(result.body.status).toBe(400);
    expect(result.body.msg).toBe('商品附件不可用，请重新选择当前供应商素材');
    for (const table of [storeProduct,storeProductRelation,storeProductDescription,storeProductAttrValue,storeProductAttrResult])
      expect(await f.db.select().from(table)).toEqual([]);
    expect(objectGet).not.toHaveBeenCalled();
  });
  it.each(['json','comma'])('canonicalizes the legacy %s gallery transport before column bounds and persistence', async format => {
    const ticket = `/api/assets/11?expires=1&signature=${'old'.repeat(100)}`;
    const input = product({slider_image:format === 'json' ? JSON.stringify([ticket]) : ticket});
    const saved = await request(0,input); expect(saved.body.status).toBe(200);
    expect((await request(saved.body.data.id)).body.data.slider_image).toEqual(['/api/assets/11']);
  });
  it.each([22,23,24,25,26,999])('refuses wrong module/file/type/storage/canonical or missing attachment %s identically', async id => {
    const result = await request(0, product({ slider_image: [`/api/assets/${id}`] }));
    expect(result.body).toMatchObject({ status:400, msg:'商品附件不可用，请重新选择当前供应商素材' });
    expect(await f.db.select().from(storeProduct)).toEqual([]);
  });
  it('returns the same unavailable state for historical foreign/missing references, preserves editing HTML and never signs them', async () => {
    const saved = await request(0, product()); const id = saved.body.data.id;
    await f.exec(`UPDATE store_product SET slider_image='["/api/assets/21","/api/assets/999","/api/assets/2147483648"]' WHERE id=${id};
      UPDATE store_product_attr_value SET image='/api/assets/21' WHERE product_id=${id};
      UPDATE store_product_description SET description='<p style="color:red">历史</p><img src="/api/assets/21"><img src="/api/assets/999">' WHERE product_id=${id}`);
    const result = await request(id); expect(result.body.status).toBe(200); const detail = result.body.data;
    expect(detail.description).toContain('style="color:red"'); expect(detail.media.status).toBe('partial');
    for (const reference of ['/api/assets/21','/api/assets/999','/api/assets/2147483648'])
      expect(detail.media.previews[reference]).toEqual({ status:'unavailable', expires_at:null });
    expect(detail.media.description_html).not.toMatch(/signature=|\/api\/assets\/|style=/);
    expect(objectGet).not.toHaveBeenCalled();
  });
  it('hides another supplier product and observes role revocation for the same JWT', async () => {
    const saved = await request(0, product()); const id = saved.body.data.id;
    expect((await request(id, undefined, await issue(28))).body.status).toBe(404);
    await f.exec("UPDATE system_role SET rules='supplier.product.view' WHERE id=2");
    expect((await request(id)).body.status).toBe(200); expect((await request(id, product())).body.status).toBe(400011);
    await f.exec("UPDATE system_role SET rules='supplier.attachment.manage' WHERE id=2");
    expect((await request(id)).body.status).toBe(400011);
    expect((await request(id, undefined, '')).body.status).toBe(410000);
  });
  it('strips historical absolute/relative private tickets from editing responses without rewriting stored content or signing a foreign reference', async () => {
    const saved = await request(0,product()); const id = saved.body.data.id;
    const oldHtml = '<p style="color:red">原文</p><img src="https://old.example/api/assets/21?expires=1&amp;signature=old">';
    await f.db.update(storeProduct).set({sliderImage:'["https://old.example/api/assets/21?expires=1&signature=old"]'}).where(eq(storeProduct.id,id));
    await f.db.update(storeProductAttrValue).set({image:'/api/assets/21?expires=1&signature=old'}).where(eq(storeProductAttrValue.productId,id));
    await f.db.update(storeProductDescription).set({description:oldHtml}).where(eq(storeProductDescription.productId,id));
    const detail = (await request(id)).body.data;
    expect(detail.slider_image).toEqual(['/api/assets/21']); expect(detail.attrs[0].image).toBe('/api/assets/21');
    expect(detail.description).toBe(oldHtml.replace('https://old.example/api/assets/21?expires=1&amp;signature=old','/api/assets/21'));
    expect(detail.media.previews).toEqual({'/api/assets/21':{status:'unavailable',expires_at:null}});
    expect(detail.media.description_html).not.toContain('signature=');
    expect((await f.db.select().from(storeProductDescription).where(eq(storeProductDescription.productId,id)))[0].description).toBe(oldHtml);
  });
  it('keeps valid external HTTPS images and existing HTML editing content intact', async () => {
    const html = '\n <table style="width:400px"><tr><td><b>旧正文</b><img src="https://images.example/a.jpg?x=1&amp;y=2"></td></tr></table> \n';
    const input = product({ slider_image:['https://images.example/a.jpg?x=1&y=2'], attrs:[{suk:'默认',image:'https://images.example/b.jpg',price:'10',settle_price:'8',stock:3}], description:html });
    const saved = await request(0,input); expect(saved.body.status).toBe(200);
    const detail = (await request(saved.body.data.id)).body.data;
    expect(detail.description).toBe(html); expect(detail.media.description_html).toContain('https://images.example/a.jpg?x=1&amp;y=2');
    expect(detail.media.status).toBe('ready'); expect(detail.media.previews['https://images.example/b.jpg']).toEqual({status:'ready',src:'https://images.example/b.jpg',expires_at:null});
  });
  it('roundtrips public root-relative gallery, SKU and raw HTML without changing ordinary links or editing markup', async () => {
    const html = '\n <p onclick="legacy()">历史<script>source()</script></p><!-- keep -->' +
      '<img src=/api/qa/image.svg?x=1&y=2><img src="/images/legacy.png">' +
      '<a href="mailto:owner@example.test">邮件</a><a href="tel:123">电话</a><a href="#section">目录</a> \n';
    const input = product({ slider_image: ['/api/qa/image.svg', '/isolated.png?x=1&y=2'],
      attrs: [{ suk: '默认', image: '/images/legacy.png', price: '10', settle_price: '8', stock: 3 }], description: html });
    const saved = await request(0, input); expect(saved.body.status, saved.body.msg).toBe(200);
    const detail = (await request(saved.body.data.id)).body.data;
    expect(detail.slider_image).toEqual(input.slider_image); expect(detail.attrs[0].image).toBe('/images/legacy.png');
    expect(detail.description).toBe(html); expect(detail.media.status).toBe('ready');
    expect(detail.media.description_html).not.toMatch(/onclick=|<script|<!--/);
    expect(detail.media.description_html).toContain('src="/api/qa/image.svg?x=1&amp;y=2"');
    for (const link of ['mailto:owner@example.test', 'tel:123', '#section']) expect(detail.media.description_html).toContain(`href="${link}"`);
    expect(detail.media.previews['/isolated.png?x=1&y=2']).toEqual({ status: 'ready', src: '/isolated.png?x=1&y=2', expires_at: null });
    expect((await f.db.select().from(storeProductDescription).where(eq(storeProductDescription.productId, saved.body.data.id)))[0].description).toBe(html);
    expect(objectGet).not.toHaveBeenCalled();
  });
  it.each(['gallery', 'sku', 'html', 'hidden-html'])('normalizes a routed foreign private alias in %s then refuses tenant ownership atomically', async location => {
    const input = product();
    const alias = '/old/%2e%2e/%61pi/assets/%32%31?expires=1&signature=old';
    if (location === 'gallery') input.slider_image = [alias];
    if (location === 'sku') (input.attrs as any[])[0].image = alias;
    if (location === 'html') input.description = `<a href="${alias}">copied link</a>`;
    if (location === 'hidden-html') input.description = `<unknown src="${alias}">hidden</unknown>`;
    const result = await request(0, input);
    expect(result.body).toMatchObject({ status: 400, msg: '商品附件不可用，请重新选择当前供应商素材' });
    for (const table of [storeProduct, storeProductRelation, storeProductDescription, storeProductAttrValue, storeProductAttrResult])
      expect(await f.db.select().from(table)).toEqual([]);
    expect(objectGet).not.toHaveBeenCalled();
  });
  it('canonicalizes every actual owned Kefu asset mount before saving and returns only the matching fresh Supplier previews', async () => {
    const rootAlias = '/kefuapi/assets/11?expires=1&signature=old';
    const absoluteAlias = 'https://old.example/legacy/../kefuapi/assets/13?expires=1&signature=old';
    const hiddenAlias = '/old/%2e%2e/%6befuapi/assets/%31%32?expires=1&signature=old';
    const html = `<unknown src="${hiddenAlias}">legacy</unknown><a href="${rootAlias}">owned link</a>`;
    const saved = await request(0, product({ slider_image: [rootAlias],
      attrs: [{ suk: '默认', image: absoluteAlias, price: '10', settle_price: '8', stock: 3 }], description: html }));
    expect(saved.body.status, saved.body.msg).toBe(200);
    const detail = (await request(saved.body.data.id)).body.data;
    expect(detail.slider_image).toEqual(['/api/assets/11']); expect(detail.attrs[0].image).toBe('/api/assets/13');
    expect(detail.description).toBe(html.replace(hiddenAlias, '/api/assets/12').replace(rootAlias, '/api/assets/11'));
    expect(Object.keys(detail.media.previews).sort()).toEqual(['/api/assets/11', '/api/assets/12', '/api/assets/13']);
    for (const id of [11, 12, 13]) {
      const preview = detail.media.previews[`/api/assets/${id}`];
      expect(preview).toMatchObject({ status: 'ready', src: expect.stringMatching(new RegExp(`^/api/assets/${id}\\?expires=`)), expires_at: expect.any(Number) });
    }
    expect(detail.media.description_html).not.toContain('kefuapi'); expect(detail.media.description_html).toContain('href="/api/assets/11?expires=');
    expect((await f.db.select().from(storeProductDescription).where(eq(storeProductDescription.productId, saved.body.data.id)))[0].description).not.toContain('signature=');
    expect(objectGet).not.toHaveBeenCalled();
  });
  it.each(['gallery', 'sku', 'href', 'hidden-html'])('refuses a foreign copied Kefu ticket in %s using the same tenant lock boundary', async location => {
    const input = product();
    const rootAlias = '/kefuapi/assets/21?expires=1&signature=old';
    const absoluteAlias = 'https://old.example/legacy/../kefuapi/assets/21?expires=1&signature=old';
    const encodedAlias = '/old/%2e%2e/%6befuapi/assets/%32%31?expires=1&signature=old';
    if (location === 'gallery') input.slider_image = [rootAlias];
    if (location === 'sku') (input.attrs as any[])[0].image = absoluteAlias;
    if (location === 'href') input.description = `<a href="${encodedAlias}">foreign</a>`;
    if (location === 'hidden-html') input.description = `<unknown src="${encodedAlias}">hidden</unknown>`;
    const result = await request(0, input);
    expect(result.body).toMatchObject({ status: 400, msg: '商品附件不可用，请重新选择当前供应商素材' });
    for (const table of [storeProduct, storeProductRelation, storeProductDescription, storeProductAttrValue, storeProductAttrResult])
      expect(await f.db.select().from(table)).toEqual([]);
    expect(objectGet).not.toHaveBeenCalled();
  });
  it('retains oversized historical editing text and reports a bounded render failure without issuing tickets', async () => {
    const saved = await request(0,product()); const id = saved.body.data.id;
    const historical = '旧'.repeat(200001);
    await f.db.update(storeProductDescription).set({description:historical}).where(eq(storeProductDescription.productId,id));
    const detail = (await request(id)).body.data;
    expect(detail.description).toBe(historical);
    expect(detail.media).toEqual({version:1,status:'too_many_references',previews:{},description_html:''});
    expect(objectGet).not.toHaveBeenCalled();
  });
  it('bounds HTML and batch parsing before storage without clearing historical editing content', async () => {
    const saved = await request(0,product()); const id = saved.body.data.id;
    const many = '<img src="/api/assets/11">'.repeat(101);
    expect((await request(id,product({description:many}))).body.status).toBe(400);
    expect((await request(id)).body.data.description).toBe(stableHtml);
    const projection = await projectSupplierProductMedia(f.db,7,{sliderImages:Array.from({length:641},(_,i)=>`https://images.example/${i}.jpg`),skus:[],description:'old'},env.APP_KEY);
    expect(projection).toEqual({version:1,status:'too_many_references',previews:{},description_html:''});
    expect((await request(id,product({description:'x'.repeat(200001)}))).body.status).toBe(400);
  });
  it('does not issue private signatures without APP_KEY', async () => {
    const projection = await projectSupplierProductMedia(f.db,7,{sliderImages:['/api/assets/11'],skus:[],description:'<img src="/api/assets/11">'},undefined);
    expect(projection.previews['/api/assets/11']).toEqual({status:'unavailable',expires_at:null});
    expect(projection.description_html).not.toContain('/api/assets/');
  });

  describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('independent native PG16 connection schedules', () => {
    it('rejects an in-flight tenant transfer without waiting and leaves creation fully rolled back', async () => {
      await withFinancePeers(f.db,async ([writer,owner]) => {
        await owner.exec('BEGIN'); await owner.exec('UPDATE system_attachment SET relation_id=8 WHERE att_id=11');
        const result = await outcome(new SupplierProductManagementService(createContainerFromDb(writer.db),env).saveProduct(7,0,product()));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toBe('商品附件正在变化，请刷新素材后重试');
        expect(await f.db.select().from(storeProduct)).toEqual([]);
        await owner.exec('COMMIT');
        const retry = await request(0,product()); expect(retry.body.status).toBe(400);
      });
    });
    it('holds the attachment SHARE lock until the actual product save commits, then allows deletion', async () => {
      const saved = await request(0,product()); const id = saved.body.data.id;
      await withFinancePeers(f.db,async ([writer,descriptionOwner,deletion]) => {
        await descriptionOwner.exec('BEGIN');
        await descriptionOwner.exec(`UPDATE store_product_description SET description=description WHERE product_id=${id}`);
        const saving = outcome(new SupplierProductManagementService(createContainerFromDb(writer.db),env).saveProduct(7,id,product({store_name:'updated-after-lock'})));
        await waitForFinanceBlock(f.db,writer.pid,descriptionOwner.pid);
        const deleting = outcome(deletion.exec('DELETE FROM system_attachment WHERE att_id=11'));
        await waitForFinanceBlock(f.db,deletion.pid,writer.pid);
        await descriptionOwner.exec('COMMIT'); expect((await saving).ok).toBe(true); expect((await deleting).ok).toBe(true);
        expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id,id)))[0].storeName).toBe('updated-after-lock');
        expect((await request(id)).body.data.media.previews['/api/assets/11']).toEqual({status:'unavailable',expires_at:null});
      });
    });
  });
});
