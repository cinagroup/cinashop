import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { hotKeywords } from '@/controllers/api/v1/PublicController';
import { errorHandler } from '@/middleware/error';
import { ProductWordsService } from '@/services/product/ProductWordsService';
import { storeProduct, storeProductWords, systemAttachment, systemAttachmentCategory, systemConfig, systemLog, user, userSearch } from '@/models/schema';
import { financeMemoryPostgres } from './helpers/financePostgres';

// Fixed PHP8ed2a5b goods_search/index.vue:35–40 consumes name and all three
// colours/icon; PublicController.php:332–336 selects those fields and the DAO
// getList:44–49 orders sortDESC/idDESC. Current TS deliberately adds the existing
// platform(type0/relation0) scope and fixed20 cap; these are not claimed as PHP
// universal limits. is_search/is_hot are NOT extra public visibility gates.
//
// This suite mounts the actual public handler with real SQL and real DI/error
// handling. It does not grant admin/shopper identity, fake a producer response,
// or test/modify the optional-auth /products search-history write contract.
const tables = [storeProductWords, systemAttachment, systemAttachmentCategory, systemConfig, systemLog, storeProduct, userSearch, user];
const word = (patch: Partial<typeof storeProductWords.$inferInsert> = {}) => ({
  id: 801, type: 0, relationId: 0, name: '真实平台热词', color: '#A1B2C3', bgColor: 'rgba(1, 2, 3, 0.4)', borderColor: '#abc',
  icon: '/icons/search.svg', isShow: 1, isDel: 0, isSearch: 0, isHot: 1, sort: 5, addTime: 123, ...patch,
});
interface PublicWord { id: number; name: string; keyword: string; color: string; bg_color: string; border_color: string; icon: string }

describe('Uni search hot words real public SQL catalog', () => {
  let fixture: Awaited<ReturnType<typeof financeMemoryPostgres>>, container: ReturnType<typeof createContainerFromDb>, bindings: Env;
  let external: ReturnType<typeof vi.fn>;
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  // Only the real DB/DI container is supplied. No uid/admin context or auth mock
  // bypasses the controller; registration below is the actual guest handler.
  app.use('*', async (c, next) => { c.set('container', container); await next(); });
  app.onError(errorHandler);
  app.get('/api/search/hot_keyword', hotKeywords);

  beforeAll(async () => {
    fixture = await financeMemoryPostgres(tables);
    container = createContainerFromDb(fixture.db);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(storeProductWords).values(word());
    // Independent, real rows make accidental audit/history writes, attachment
    // rewrites, fallback product reads and sequence consumption observable.
    await fixture.db.insert(systemAttachment).values({ attId: 61, type: 4, relationId: 99, moduleType: 1, imageType: 8, fileType: 1,
      attType: 'image/png', name: 'attachments/supplier/99/private.png', attDir: '/api/assets/61', sattDir: '/api/assets/61' });
    await fixture.db.insert(systemAttachmentCategory).values({ type: 4, relationId: 99, name: '供应商私有图库' });
    await fixture.db.insert(systemConfig).values({ menuName: 'search_keyword_private_sentinel', value: 'not-a-public-word-or-credential' });
    await fixture.db.insert(systemLog).values({ adminId: 11, action: 'before-public-keywords', type: 'fixture' });
    await fixture.db.insert(storeProduct).values({ id: 901, storeName: '不可替代平台热词的商品', price: '99.00', isShow: 1, isDel: 0, isVerify: 1 });
    await fixture.db.insert(userSearch).values([{ uid: 0, keyword: '原匿名搜索历史', result: '[901]', num: 7, addTime: 12 },
      { uid: 11, keyword: '原登录搜索历史', result: '[901]', num: 3, addTime: 13 }]);
    await fixture.db.insert(user).values({ uid: 11, nickname: '不需要登录的目录用户' });
    external = vi.fn(async () => { throw Error('Public hot words must not read provider/KV/R2 or publish media'); });
    bindings = { APP_KEY: 'unused-hotwords-catalog-key', CONFIG_KV: { get: external, put: external, delete: external },
      ORDER_QUEUE: { send: external, sendBatch: external }, ASSETS_BUCKET: { get: external, put: external, head: external, list: external, delete: external } } as unknown as Env;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Public hot words must not fetch a provider or icon'));
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  async function snapshot() {
    const rows = await Promise.all(tables.map(async table => [getTableConfig(table).name,
      Array.from(await fixture.db.execute(sql.raw(`SELECT * FROM "${getTableConfig(table).name}" ORDER BY 1,2`)), row => ({ ...row }))] as const));
    return { rows: Object.fromEntries(rows), sequences: Array.from(await fixture.db.execute(sql`
      SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename
    `), row => ({ ...row })) };
  }
  async function unchanged<T>(work: () => Promise<T>): Promise<T> {
    const before = await snapshot();
    try { return await work(); }
    finally { expect(await snapshot()).toEqual(before); }
  }
  async function read(query = '', headers: Record<string, string> = {}): Promise<PublicWord[]> {
    return unchanged(async () => {
      const response = await app.request(`/api/search/hot_keyword${query ? `?${query}` : ''}`, { method: 'GET', headers }, bindings);
      const body = await response.json() as { status: number; msg: string; data: PublicWord[] | null };
      expect(response.status).toBe(200); expect(body.status).toBe(200); expect(body.msg).toBe('ok'); expect(Array.isArray(body.data)).toBe(true);
      return body.data!;
    });
  }

  it('uses the registered guest public controller and exact seven-field DTO rather than an admin list or group-data alias', async () => {
    const routes = readFileSync('src/routes/v1/index.ts', 'utf8');
    expect(routes).toMatch(/v1Routes\.get\("\/search\/hot_keyword",\s*PublicController\.hotKeywords\);/u);
    expect(fixture.isMemory).toBe(true);
    expect(await read()).toEqual([{ id: 801, name: '真实平台热词', keyword: '真实平台热词', color: '#A1B2C3', bg_color: 'rgba(1, 2, 3, 0.4)', border_color: '#abc', icon: '/icons/search.svg' }]);
  });
  it('cannot widen platform scope through forged auth, owner, supplier, visibility or keyword query parameters', async () => {
    await fixture.db.insert(storeProductWords).values([word({ id: 802, type: 2, relationId: 99, sort: 999, name: '供应商不可公开' }),
      word({ id: 803, type: 0, relationId: 99, sort: 999, name: '其他关联不可公开' })]);
    expect(await read('uid=99&type=2&relation_id=99&is_show=0&is_del=1&is_search=1&is_hot=1&keyword=供应商', {
      Authorization: 'Bearer deliberately-invalid-unused-token', 'Authori-zation': 'Bearer another-unused-token',
    })).toEqual(await read());
  });
  it.each([
    { type: 2, relationId: 99 }, { type: 2, relationId: 0 }, { type: 1, relationId: 0 }, { type: 0, relationId: 99 }, { type: 0, relationId: -1 },
    { isShow: 0 }, { isShow: 2 }, { isDel: 1 }, { isDel: 2 },
  ])('filters nonpublic scope or availability %j before sorting and limiting', async patch => {
    await fixture.db.insert(storeProductWords).values(word({ id: 999, name: '高排序不可见干扰', sort: 999, ...patch }));
    expect((await read()).map(row => row.id)).toEqual([801]);
  });
  it.each([[0, 0], [0, 1], [1, 0], [1, 1]] as const)('does not filter platform words by is_search%s or is_hot%s', async (isSearch, isHot) => {
    await fixture.db.update(storeProductWords).set({ isSearch, isHot });
    const rows = await read(); expect(rows.map(row => row.id)).toEqual([801]);
    expect(Object.keys(rows[0]).sort()).toEqual(['bg_color', 'border_color', 'color', 'icon', 'id', 'keyword', 'name']);
  });
  it('sorts descending configured order before descending ID, including older high-sort rows', async () => {
    await fixture.db.insert(storeProductWords).values([word({ id: 790, sort: 6, name: '老ID高排序' }), word({ id: 802, sort: 5, name: '同排序新ID' })]);
    expect((await read()).map(row => row.id)).toEqual([790, 802, 801]);
  });
  it('applies the existing20 cap after all scope/availability filters, without returning a count wrapper or21st item', async () => {
    await fixture.db.insert(storeProductWords).values([
      ...Array.from({ length: 25 }, (_, index) => word({ id: 1000 + index, name: `平台历史词${index}`, sort: 5 })),
      word({ id: 990, name: '低ID最高排序', sort: 9 }),
      word({ id: 9000, type: 2, relationId: 99, name: '供应商占位不得挤掉公开项', sort: 999 }),
      word({ id: 9001, isShow: 0, name: '隐藏占位不得挤掉公开项', sort: 999 }),
      word({ id: 9002, isDel: 1, name: '删除占位不得挤掉公开项', sort: 999 }),
      word({ id: 9003, relationId: 99, name: '关联占位不得挤掉公开项', sort: 999 }),
    ]);
    const rows = await read(); expect(rows).toHaveLength(20);
    expect(rows.map(row => row.id)).toEqual([990, ...Array.from({ length: 19 }, (_, index) => 1024 - index)]);
  });
  it('keeps the current fixed public20 boundary despite page/limit/duplicate/invalid-looking query values', async () => {
    await fixture.db.insert(storeProductWords).values(Array.from({ length: 24 }, (_, index) => word({ id: 1000 + index, name: `公开词${index}` })));
    const expected = await read(); expect(expected).toHaveLength(20);
    for (const query of ['page=2&limit=1', 'page=0&limit=999', 'page=1&page=9&limit=0&limit=100', 'page=NaN&limit=Infinity']) expect(await read(query)).toEqual(expected);
  });
  it.each(['中'.repeat(128), '🙂'.repeat(128), 'A&B 中文%_[]完整历史词'])('preserves the complete historical name%s and equal keyword without applying the new-author15 limit', async name => {
    await fixture.db.update(storeProductWords).set({ name });
    const row = (await read())[0]; expect(row.name).toBe(name); expect(row.keyword).toBe(name);
    expect(Array.from(row.name)).toHaveLength(Array.from(name).length);
  });
  it('does not silently deduplicate different legacy IDs with equal names or repair whitespace in stored names', async () => {
    await fixture.db.insert(storeProductWords).values([word({ id: 802, name: '真实平台热词' }), word({ id: 803, name: '  保留旧名称空白  ' })]);
    expect((await read()).map(row => [row.id, row.name, row.keyword])).toEqual([[803, '  保留旧名称空白  ', '  保留旧名称空白  '], [802, '真实平台热词', '真实平台热词'], [801, '真实平台热词', '真实平台热词']]);
  });

  it.each([
    ['', ''], ['transparent', 'transparent'], ['#abc', '#abc'], ['#abcd', '#abcd'], ['#123456', '#123456'], ['#12345678', '#12345678'],
    [' #AbC ', '#AbC'], ['rgb(0, 255, 17)', 'rgb(0, 255, 17)'], ['rgba(1,2,3,0.35)', 'rgba(1,2,3,0.35)'],
    ['rgb(256,0,0)', ''], ['rgba(0,0,0,1.1)', ''], ['#12345', ''], ['red', ''], ['hsl(1,2%,3%)', ''], ['url(javascript:1)', ''], ['#abc;color:red', ''],
  ] as const)('projects all three stored colours%s to safe%s without mutating the imported database value', async (stored, safe) => {
    await fixture.db.update(storeProductWords).set({ color: stored, bgColor: stored, borderColor: stored });
    const row = (await read())[0]; expect([row.color, row.bg_color, row.border_color]).toEqual([safe, safe, safe]);
    expect((await fixture.db.select().from(storeProductWords))[0]).toMatchObject({ color: stored, bgColor: stored, borderColor: stored });
  });
  it('projects independent three-colour values without filling empty background or inventing a border', async () => {
    await fixture.db.update(storeProductWords).set({ color: '#abc', bgColor: '', borderColor: 'rgba(0,0,0,0)' });
    expect((await read())[0]).toMatchObject({ color: '#abc', bg_color: '', border_color: 'rgba(0,0,0,0)' });
    await fixture.db.update(storeProductWords).set({ color: '', bgColor: '#123456', borderColor: '' });
    expect((await read())[0]).toMatchObject({ color: '', bg_color: '#123456', border_color: '' });
  });
  it.each([
    ['', ''], ['/static/word.svg', '/static/word.svg'], ['https://cdn.example.test/new.svg', 'https://cdn.example.test/new.svg'],
    [' HTTPS://CDN.EXAMPLE.TEST/new.svg ', 'https://cdn.example.test/new.svg'],
    ['https://cdn.example.test/a b.png', 'https://cdn.example.test/a%20b.png'],
    ['/api/assets/61', '/api/assets/61'], ['/api/assets/61?expires=1&signature=old', '/api/assets/61?expires=1&signature=old'],
    ['http://cdn.example.test/new.svg', ''], ['//cdn.example.test/new.svg', ''], ['icons/new.svg', ''],
    ['https://user:pass@cdn.example.test/new.svg', ''], ['javascript:alert(1)', ''], ['data:image/png;base64,AAAA', ''],
    ['/icons/a&#46;svg', '/icons/a&#46;svg'],
  ] as const)('projects business icon%s as%s without fetching, signing or granting author attachment access', async (stored, safe) => {
    await fixture.db.update(storeProductWords).set({ icon: stored });
    const row = (await read())[0]; expect(row.icon).toBe(safe);
    expect((await fixture.db.select().from(storeProductWords))[0].icon).toBe(stored);
    expect((await fixture.db.select().from(systemAttachment))[0]).toMatchObject({ type: 4, relationId: 99, attDir: '/api/assets/61' });
  });
  it('checks the existing128-character canonical URL budget without rewriting stored or fetched image material', async () => {
    const relative = '/' + 'a'.repeat(127);
    await fixture.db.update(storeProductWords).set({ icon: relative }); expect((await read())[0].icon).toBe(relative);
    // Stored source is short enough for varchar128; URL percent-encoding grows
    // beyond the already-existing public canonical128 check, so it is blanked.
    const expands = 'https://cdn.example.test/' + ' '.repeat(40) + 'x.png';
    expect(expands.length).toBeLessThanOrEqual(128);
    await fixture.db.update(storeProductWords).set({ icon: expands }); expect((await read())[0].icon).toBe('');
    expect((await fixture.db.select().from(storeProductWords))[0].icon).toBe(expands);
  });
  it('does not sign an unrelated supplier private asset or turn a stale icon ticket into public author media authority', async () => {
    for (const icon of ['/api/assets/61', '/api/assets/61?expires=1&signature=old']) {
      await fixture.db.update(storeProductWords).set({ icon });
      const rows = await read('preview=1&media=1&attachment_id=61&sign=1'); expect(rows[0].icon).toBe(icon);
      expect(Object.keys(rows[0]).sort()).toEqual(['bg_color', 'border_color', 'color', 'icon', 'id', 'keyword', 'name']);
    }
  });
  it('can use the real public service with no provider credentials, separate admin producer or environment fallback', async () => {
    const rows = await unchanged(() => new ProductWordsService(container).publicKeywords());
    expect(rows).toEqual(await read()); expect(external).not.toHaveBeenCalled();
  });
  it('returns a genuine empty catalog when only hidden deleted or supplier words remain, without using product/history fallback', async () => {
    await fixture.db.delete(storeProductWords);
    await fixture.db.insert(storeProductWords).values([word({ id: 801, isShow: 0 }), word({ id: 802, isDel: 1 }), word({ id: 803, type: 2, relationId: 99 }), word({ id: 804, relationId: 99 })]);
    expect(await read()).toEqual([]);
    expect((await fixture.db.select().from(userSearch)).map(row => row.keyword).sort()).toEqual(['原匿名搜索历史', '原登录搜索历史'].sort());
  });
});
