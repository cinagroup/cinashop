import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeProductLabel, storeSeckill, systemArticle, systemAttachment, systemDise } from '@/models/schema';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { diyEditorialFixture, DIY_EDITORIAL_FAMILIES, DIY_EDITORIAL_NOW } from './helpers/diyEditorialFixture';
import { sortedDiyState, type DiyStateRow as Row, type DiyStateViewer } from './helpers/diyStateFixture';

const canonicalSchema = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? canonicalizePublishedAttachmentReference(item) : item));
const requiredBlock = (blocks: Row[], timestamp: number): Row => {
  const block = blocks.find(row => row.timestamp === timestamp);
  if (!block) throw Error(`Missing owned editorial fixture block ${timestamp}`);
  return block;
};
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned DIY editorial SQL'); return wiring.container;
} }));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native six-component DIY editorial contracts on owned PostgreSQL16', () => {
  let f: Awaited<ReturnType<typeof diyEditorialFixture>>; const app = createApp();
  beforeAll(async () => {
    vi.setSystemTime(DIY_EDITORIAL_NOW); f = await diyEditorialFixture(DIY_EDITORIAL_NOW); wiring.container = f.container;
    expect(f.tables).toHaveLength(50); expect(f.sequences).toHaveLength(46);
    expect(f.seedStorage.puts).toBe(2); expect(f.seedStorage.deletes).toBe(0); expect(f.seedStorage.keys).toHaveLength(2);
  }, 45_000);
  afterAll(async () => { wiring.container = undefined; vi.useRealTimers(); await f?.close(); }, 30_000);
  beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned DIY editorial fixture forbids external I/O')); });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  const resources = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length,
    objects: [...f.objects].map(([key, item]) => ({ key, type: item.type, bytes: [...item.bytes] })),
    imageInfo: f.rendering.info.mock.calls.length, imageInput: f.rendering.input.mock.calls.length, imageOutput: f.rendering.output.mock.calls.length,
    queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length });
  async function request(path: string, viewer: DiyStateViewer = 11) {
    const waits: Promise<unknown>[] = [];
    const response = await app.fetch(new Request(`http://localhost${path}`, { headers: viewer ? { Authorization: `Bearer ${viewer === 11 ? f.token : f.otherToken}` } : {} }),
      f.env, { waitUntil: work => { waits.push(work); }, passThroughOnException() {} } as ExecutionContext);
    await Promise.all(waits); return response;
  }
  async function read(path: string, viewer: DiyStateViewer = 11, status = 200) {
    const before = await f.snapshot(), initial = resources(), response = await request(path, viewer), body = await response.json() as Row;
    expect(response.status).toBe(200); expect(body.status).toBe(status);
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial); return body;
  }
  async function catalog(query: string, viewer: DiyStateViewer = 11) { return (await read(`/api/products?${query}`, viewer)).data as Row; }

  it('returns real home and micro schemas with all six families and persisted layout branches', async () => {
    for (const page of [0, 2]) for (const viewer of [0, 11, 22] as const) {
      expect((await read(`/api/diy/diy_version/${page}`, viewer)).data).toEqual({ version: 'diy-editorial-1' });
      const data = (await read(`/api/diy/get_diy/${page}`, viewer)).data;
      expect(canonicalSchema(data.value)).toEqual(f.blocks);
      expect(new Set(data.value.filter((row: Row) => DIY_EDITORIAL_FAMILIES.includes(row.name)).map((row: Row) => row.name))).toEqual(new Set(DIY_EDITORIAL_FAMILIES));
      expect(data.value.filter((row: Row) => row.name === 'goodList').map((row: Row) => row.styleConfig.tabVal)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(data.value.filter((row: Row) => row.name === 'articleList').map((row: Row) => row.styleConfig.tabVal)).toEqual([0, 1, 2]);
    }
  });

  it('reads exact fixed products, zero prices and sales, with actor-isolated real cart quantities', async () => {
    for (const viewer of [0, 11, 22] as const) {
      const data = await catalog('ids=601,611,612&page=1&limit=2', viewer);
      expect(data.count).toBe(2); expect(data.list.map((row: Row) => row.id)).toEqual([601, 611]);
      expect(data.list[0]).toMatchObject({ id: 601, price: '0.00', sales: 10, unit_name: '件', star: '4.5', cart_num: viewer === 11 ? 2 : viewer === 22 ? 4 : 0 });
      expect(data.list[1]).toMatchObject({ id: 611, price: '9.50', sales: 6, cart_num: 0 });
    }
  });

  it.each([
    ['category', 'cate_id=701', [601, 611]], ['brand', 'brand_id=703', [601]], ['label', 'store_label_id=704', [601]],
  ])('uses the real %s scope before pagination without broadening or hidden products', async (_name, scope, ids) => {
    for (const viewer of [0, 11, 22] as const) {
      const data = await catalog(`${scope}&page=1&limit=2`, viewer);
      expect(data.count).toBe(ids.length); expect(data.list.map((row: Row) => row.id)).toEqual(ids);
    }
  });

  it('keeps actual sales and price sorting within the selected category and respects finite paging', async () => {
    for (const [sort, ids] of [['salesOrder=desc', [601, 611]], ['priceOrder=desc', [611, 601]], ['priceOrder=asc', [601, 611]]] as const) {
      const complete = await catalog(`cate_id=701&${sort}&page=1&limit=2`, 0);
      expect(complete.list.map((row: Row) => row.id)).toEqual(ids); expect(complete.count).toBe(2);
      for (const page of [1, 2]) {
        const data = await catalog(`cate_id=701&${sort}&page=${page}&limit=1`, 0);
        expect(data.count).toBe(2); expect(data.list.map((row: Row) => row.id)).toEqual([ids[page - 1]]);
      }
    }
  });

  it('projects real brand, visible signed labels, selected activity frame and advertised SVIP offers', async () => {
    for (const viewer of [0, 11, 22] as const) {
      const data = await catalog('ids=601,611&page=1&limit=2', viewer), [first, second] = data.list;
      expect(first).toMatchObject({ brand_name: '真实商城品牌', vip_price: '0.00', price_type: 'member',
        activity_frame: { id: 831, name: '真实商品活动边框831', image: '/static/logo.png' } });
      expect(second).toMatchObject({ vip_price: '6.50', price_type: 'member', activity_frame: [] });
      expect(first.store_label).toHaveLength(1); expect(first.store_label[0]).toMatchObject({ id: 704, label_name: '真实商城标签' });
      expect(first.store_label[0].icon).toMatch(new RegExp(`^${f.platformImage.url}\\?expires=\\d+&signature=`));
    }
    const original = (await f.snapshot()).store_product_label.find(row => row.id === 704)!;
    try {
      await f.db.update(storeProductLabel).set({ icon: f.image.url }).where(eq(storeProductLabel.id, 704));
      expect((await catalog('ids=601&page=1&limit=1')).list[0].store_label[0].icon).toBe('');
    } finally { await f.db.update(storeProductLabel).set({ icon: original.icon }).where(eq(storeProductLabel.id, 704)); }
  });

  it('uses strict real activity identities and presale priority without treating product ids as activity ids', async () => {
    const items = (await catalog('ids=602,603,604,605&page=1&limit=4')).list;
    expect(items.map((row: Row) => row.diy_navigation)).toEqual([
      { version: 1, product_id: 602, kind: 'seckill', id: 1701, ends_at: new Date((f.shanghaiDay + 86400) * 1000).toISOString() },
      { version: 1, product_id: 603, kind: 'combination', id: 1801, ends_at: null },
      { version: 1, product_id: 604, kind: 'bargain', id: 1901, ends_at: null },
      { version: 1, product_id: 605, kind: 'presale', id: 605, ends_at: null },
    ]);
    const original = (await f.db.select().from(storeSeckill).where(eq(storeSeckill.id, 1701)))[0];
    try {
      await f.db.update(storeSeckill).set({ status: 0 }).where(eq(storeSeckill.id, 1701));
      expect((await catalog('ids=602&page=1&limit=1')).list[0].diy_navigation).toEqual({ version: 1, product_id: 602, kind: 'product', id: 602, ends_at: null });
    } finally { await f.db.update(storeSeckill).set({ status: original.status }).where(eq(storeSeckill.id, 1701)); }
  });

  it('reads real category articles with exact public projection, visibility and deterministic category ordering', async () => {
    for (const viewer of [0, 11, 22] as const) {
      const all = (await read('/api/article/list/0?page=1&limit=10', viewer)).data;
      expect(all.map((row: Row) => row.id)).toEqual([803, 801, 802]);
      expect((await read('/api/article/list/811?page=1&limit=2', viewer)).data.map((row: Row) => row.id)).toEqual([801, 802]);
      expect((await read('/api/article/list/812?page=1&limit=2', viewer)).data.map((row: Row) => row.id)).toEqual([803]);
      expect((await read('/api/article/list/999?page=1&limit=2', viewer)).data).toEqual([]);
      expect(all[1]).toEqual({ id: 801, title: '真实零访问文章801', image_input: [expect.stringMatching(new RegExp(`^${f.platformImage.url}\\?expires=\\d+&signature=`)), '/static/logo.png'],
        visit: '0', likes: 0, add_time: '2026-10-21 09:59', synopsis: '真实摘要801', url: '/pages/article/list' });
      expect(all[2].url).toBe(''); expect(Object.keys(all[1]).sort()).toEqual(['add_time', 'id', 'image_input', 'likes', 'synopsis', 'title', 'url', 'visit']);
    }
  });

  it('serves the real signed article cover while keeping all 50 tables, 46 sequences and R2 objects unchanged', async () => {
    const article = (await read('/api/article/list/811?page=1&limit=1', 0)).data[0];
    const before = await f.snapshot(), initial = resources(), response = await request(article.image_input[0], 0);
    expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.png);
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial);
  });

  it('freshly signs explicit DIY platform image fields and serves their real pixels without changing canonical Admin rows or versions', async () => {
    const before = await f.snapshot(), initial = resources(), data = (await read('/api/diy/get_diy/0', 0)).data;
    expect(canonicalSchema(data.value)).toEqual(f.blocks);
    const hotspot = data.value.find((row: Row) => row.timestamp === 531), follow = data.value.find((row: Row) => row.timestamp === 541);
    expect(hotspot.picStyle.url).toMatch(new RegExp(`^${f.platformImage.url}\\?expires=\\d+&signature=`));
    expect(follow.codeConfig.url).toBe(hotspot.picStyle.url);
    const expires = Number(new URL(hotspot.picStyle.url, 'http://localhost').searchParams.get('expires'));
    expect(expires).toBe(f.seconds + 900);
    const response = await request(hotspot.picStyle.url, 0);
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.png);
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial);
  });

  it('refreshes old image tickets while keeping links, editor preview rows and unrelated component fields byte-for-byte unchanged', async () => {
    const blocks = structuredClone(f.blocks), stale = `${f.platformImage.url}?expires=1&signature=old-ticket`;
    const news = blocks.find(row => row.timestamp === 521)!; news.imgConfig.url = stale; news.linkConfig.value = stale;
    news.unusedImage = stale; news.listConfig.list[0].chiild[1].val = stale;
    const good = blocks.find(row => row.timestamp === 501)!; good.goodsList.list[0].image = stale;
    const foreign = `https://foreign.example/api/assets/${f.platformImage.att_id}?expires=1&signature=foreign-ticket`;
    blocks.find(row => row.timestamp === 552)!.menuConfig.list[1].img = foreign;
    blocks.push({ name: 'unrelated-private-preview', timestamp: 999, imgConfig: { url: stale } });
    const saved = await f.saveSchema(2, blocks); expect(saved.body.status).toBe(200);
    const canonical = structuredClone(blocks); canonical.find(row => row.timestamp === 521)!.imgConfig.url = f.platformImage.url;
    const stored = saved.after.system_dise.find(row => row.id === 2)!, expected = structuredClone(saved.before);
    expect(stored.value).toBe(JSON.stringify(canonical)); expect(stored.version).not.toBe(saved.before.system_dise.find(row => row.id === 2)!.version);
    expected.system_dise = expected.system_dise.map(row => row.id === 2 ? { ...row, value: JSON.stringify(canonical), version: stored.version, update_time: stored.update_time } : row);
    expect(saved.after).toEqual(sortedDiyState(expected));
    const before = await f.snapshot(), data = (await read('/api/diy/get_diy/2', 0)).data, projected = data.value.find((row: Row) => row.timestamp === 521);
    expect(projected.imgConfig.url).not.toBe(stale); expect(projected.imgConfig.url).toMatch(new RegExp(`^${f.platformImage.url}\\?expires=${f.seconds + 900}&signature=`));
    expect(projected.linkConfig.value).toBe(stale); expect(projected.unusedImage).toBe(stale); expect(projected.listConfig.list[0].chiild[1].val).toBe(stale);
    expect(data.value.find((row: Row) => row.timestamp === 501).goodsList.list[0].image).toBe(stale);
    expect(data.value.find((row: Row) => row.timestamp === 999).imgConfig.url).toBe(stale);
    expect(data.value.find((row: Row) => row.timestamp === 552).menuConfig.list[1].img).toBe(foreign);
    expect(await f.snapshot()).toEqual(before);
  });

  it('refreshes imported historical image tickets without rewriting the saved schema or its version', async () => {
    const original = (await f.db.select().from(systemDise).where(eq(systemDise.id, 1)))[0], blocks = structuredClone(f.blocks);
    requiredBlock(blocks, 531).picStyle.url = `${f.platformImage.url}?expires=1&signature=imported-stale-ticket`;
    try {
      await f.db.update(systemDise).set({ value: JSON.stringify(blocks) }).where(eq(systemDise.id, 1));
      const projected = (await read('/api/diy/get_diy/0', 0)).data.value.find((row: Row) => row.timestamp === 531);
      expect(projected.picStyle.url).toMatch(new RegExp(`^${f.platformImage.url}\\?expires=${f.seconds + 900}&signature=`));
    } finally { await f.db.update(systemDise).set({ value: original.value }).where(eq(systemDise.id, 1)); }
  });

  it('supports the existing 200-component UI maximum with all four activeParty image slots and no truncation', async () => {
    const blocks = Array.from({ length: 200 }, (_, index) => ({ name: 'activeParty', timestamp: 1000 + index,
      titleConfig: { value: `真实最大组件${index}` }, menuConfig: { list: Array.from({ length: 4 }, () => ({ img: f.platformImage.url, info: [{ value: '标题' }, { value: '简介' }, { value: '/pages/article/list' }] })) } }));
    const saved = await f.saveSchema(2, blocks); expect(saved.body.status).toBe(200);
    const value = (await read('/api/diy/get_diy/2', 0)).data.value as Row[];
    expect(value).toHaveLength(200); expect(value.flatMap(row => row.menuConfig.list)).toHaveLength(800);
    for (const item of value.flatMap(row => row.menuConfig.list)) expect(item.img).toMatch(new RegExp(`^${f.platformImage.url}\\?expires=`));
  });

  it('signs only the four rendered activeParty images and leaves unused private media, links and preview fields unchanged', async () => {
    const blocks = structuredClone(f.blocks), party = blocks.find(row => row.timestamp === 551)!;
    party.menuConfig.list.push(structuredClone(party.menuConfig.list[0]), structuredClone(party.menuConfig.list[1]),
      { img: f.image.url, info: [{ value: '第五个私有素材预览' }, { value: '不公开签名' }, { value: f.platformImage.url }] });
    const stale = `${f.platformImage.url}?expires=1&signature=unused-editor-ticket`;
    party.menuConfig.list.push({ img: stale }); party.unusedPreview = stale;
    const saved = await f.saveSchema(2, blocks); expect(saved.body.status).toBe(200);
    const projected = (await read('/api/diy/get_diy/2', 0)).data.value.find((row: Row) => row.timestamp === 551);
    expect(projected.menuConfig.list).toHaveLength(6);
    for (const item of projected.menuConfig.list.slice(0, 4)) expect(item.img).toMatch(new RegExp(`^${f.platformImage.url}\\?expires=`));
    expect(projected.menuConfig.list[4]).toEqual(party.menuConfig.list[4]); expect(projected.menuConfig.list[5].img).toBe(stale);
    expect(projected.unusedPreview).toBe(stale);
  });

  it('refuses fresh public DIY signatures for private, merchant, foreign-module, invalid-raster and deleted attachments', async () => {
    const original = (await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformImage.att_id)))[0];
    const invalid = [
      { type: 3, relationId: 11, moduleType: 3 }, { type: 4, relationId: 703, moduleType: 1 },
      { type: 1, relationId: 11, moduleType: 1 }, { type: 1, relationId: 0, moduleType: 5 },
      { fileType: 2 }, { imageType: 0 }, { attType: 'image/jpeg' }, { name: 'attachments/admin/2/foreign.png' },
    ];
    try {
      for (const fields of invalid) {
        await f.db.update(systemAttachment).set({ ...original, ...fields }).where(eq(systemAttachment.attId, original.attId));
        const value = (await read('/api/diy/get_diy/0', 0)).data.value as Row[];
        expect(requiredBlock(value, 531).picStyle.url).toBe('');
        expect(requiredBlock(value, 541).codeConfig.url).toBe('');
        expect(requiredBlock(value, 551).menuConfig.list.map((row: Row) => row.img)).toEqual(['', '']);
      }
      await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, original.attId));
      expect((await read('/api/diy/get_diy/0', 0)).data.value.find((row: Row) => row.timestamp === 531).picStyle.url).toBe('');
    } finally {
      await f.db.insert(systemAttachment).values(original).onConflictDoUpdate({ target: systemAttachment.attId, set: original });
    }
    expect((await read('/api/diy/get_diy/0', 0)).data.value.find((row: Row) => row.timestamp === 531).picStyle.url).toMatch(/\?expires=/);
  });

  it.each(['-1', '1.5', '2147483648', 'bad'])('rejects malformed article category %s without detail, like or resource side effects', async cid => {
    await read(`/api/article/list/${cid}?page=1&limit=2`, 0, 400);
  });

  it('reads authored news, scaled hotspot geometry, local follow QR and activeParty intent without resource generation', async () => {
    const blocks = canonicalSchema((await read('/api/diy/get_diy/0', 0)).data.value) as Row[];
    expect(blocks.find(row => row.timestamp === 521)).toMatchObject({ name: 'news', listConfig: { list: [
      { show: true, chiild: [{ val: '真实文章入口801' }, { val: '/pages/article/detail?id=801' }] },
      { show: false, chiild: [{ val: '隐藏公告旁观' }, { val: '/pages/article/detail?id=804' }] },
      { show: true, chiild: [{ val: '真实商品入口601' }, { val: '/pages/goods/detail?id=601' }] },
    ] } });
    expect(requiredBlock(blocks, 531).picStyle.list[1]).toEqual({ number: 2, starX: 300, starY: 0, areaWidth: 400, areaHeight: 200, link: '/pages/goods/list?brand_id=703' });
    expect(requiredBlock(blocks, 541).codeConfig.url).toBe(f.platformImage.url);
    expect(requiredBlock(blocks, 542).codeConfig.url).toBe('');
    expect(blocks.find(row => row.timestamp === 551)).toMatchObject({ titleConfig: { value: '真实活动魔方0' }, desConfig: { value: '真实Admin促销简介' },
      menuConfig: { list: [{ info: [{ value: '文章专题' }, { value: '来自真实持久配置' }, { value: '/pages/article/list' }] }, { info: [{ value: '品牌商品' }, { value: '筛选真实品牌703' }, { value: '/pages/goods/list?brand_id=703' }] }] } });
  });

  it('roundtrips a real signed six-component read through Admin save into canonical media while changing only its intended DIY row', async () => {
    const blocks = (await read('/api/diy/get_diy/0', 0)).data.value as Row[]; blocks.find(row => row.timestamp === 551)!.desConfig.value = '真实Admin更新简介';
    blocks.find(row => row.timestamp === 511)!.checkboxList.type = [2]; blocks.find(row => row.timestamp === 501)!.styleConfig.tabVal = 5;
    const canonical = canonicalSchema(blocks), result = await f.saveSchema(2, blocks), expected = structuredClone(result.before);
    expect(result.response.status).toBe(200); expect(result.body.status).toBe(200);
    const actual = result.after.system_dise.find(row => row.id === 2)!;
    expect(actual.version).not.toBe('diy-editorial-1'); expect(actual.value).toBe(JSON.stringify(canonical));
    expected.system_dise = expected.system_dise.map(row => row.id === 2 ? { ...row, value: JSON.stringify(canonical), version: actual.version, update_time: actual.update_time } : row);
    expect(result.after).toEqual(sortedDiyState(expected));
    expect(canonicalSchema((await read('/api/diy/get_diy/2', 22)).data.value)).toEqual(canonical);
    expect(canonicalSchema((await read('/api/diy/get_diy/0', 0)).data.value)).toEqual(f.blocks);
  });

  it('generates a poster only on an explicit optional-auth GET and records one derivative R2 write with unchanged SQL', async () => {
    const before = await f.snapshot(), initial = resources(), response = await request('/api/wechat/follow', 0), body = await response.json() as Row;
    expect(body.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    const url = new URL(body.data.path); expect(url.pathname).toMatch(/^\/api\/wechat\/follow\/image\/[a-f0-9]{64}$/);
    expect(await f.snapshot()).toEqual(before); const after = resources();
    expect(after.puts).toBe(initial.puts + 1); expect(after.deletes).toBe(initial.deletes); expect(after.objects).toHaveLength(initial.objects.length + 1);
    expect(after.imageInfo).toBe(initial.imageInfo + 1); expect(after.imageOutput).toBe(initial.imageOutput + 1); expect(after.queue).toBe(0);
    expect(f.rendering.transform).toHaveBeenCalledWith({ width: 344, height: 344, fit: 'squeeze' });
    expect(f.rendering.draw).toHaveBeenCalledWith(expect.any(Object), { left: 76, top: 76 });
    const cached = resources(), image = await request(url.pathname + url.search, 22);
    expect(image.status).toBe(200); expect(image.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(f.posterBytes);
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(cached);
  });

  it('rejects poster query abuse, invalid signatures and missing QR configuration without generating or writing resources', async () => {
    await read('/api/wechat/follow?unexpected=1', 0, 400);
    await read(`/api/wechat/follow/image/${'0'.repeat(64)}?expires=${f.seconds + 900}&signature=${'0'.repeat(64)}`, 0, 404);
    try { await f.setConfig('wechat_qrcode', ''); await read('/api/wechat/follow', 0, 400); }
    finally { await f.setConfig('wechat_qrcode', JSON.stringify(f.platformImage.url)); }
  });

  it('records an explicit article detail GET as a visit mutation rather than claiming that destination is read-only', async () => {
    const before = await f.snapshot(), initial = resources(), response = await request('/api/article/details/801', 11), body = await response.json() as Row;
    expect(body.status).toBe(200); expect(body.data.visit).toBe(1); expect(body.data.content).toContain('真实编辑正文801');
    const expected = structuredClone(before); expected.system_article = expected.system_article.map(row => row.id === 801 ? { ...row, visit: row.visit + 1 } : row);
    expect(await f.snapshot()).toEqual(sortedDiyState(expected)); expect(resources()).toEqual(initial);
    await f.db.update(systemArticle).set({ visit: 0 }).where(eq(systemArticle.id, 801));
  });

  it('blocks schema, article list and explicit poster generation at their real station gates without business writes', async () => {
    try {
      await f.setConfig('station_open', '0');
      for (const path of ['/api/diy/diy_version/0', '/api/diy/get_diy/0', '/api/article/list/811?page=1&limit=1', '/api/wechat/follow']) {
        expect((await read(path, 0, 410010)).msg).toBe('站点升级中，请稍候访问');
      }
      // /products historically has optional auth without a station gate. The
      // root schema gate removes DIY and prevents its catalogue hydration;
      // this slice preserves the established standalone catalogue contract.
      expect((await catalog('ids=601&page=1&limit=1', 0)).list[0].id).toBe(601);
    } finally { await f.setConfig('station_open', '1'); }
    expect((await read('/api/article/list/811?page=1&limit=1', 0)).data[0].id).toBe(801);
  });
});
