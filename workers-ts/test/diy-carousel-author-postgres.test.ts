import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemAttachment, systemDise, systemRole } from '@/models/schema';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { diyCarouselAuthorFixture, carouselAuthorBlock, importedLegacyCarousel, expectedCarouselRootEdit, expectedCarouselAlternateEdit, expectedCarouselMicroEdit } from './helpers/diyCarouselAuthorFixture';
import { sortedDiyState, stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned carousel author SQL'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned carousel author Admin SQL'); return { container: wiring.container, close: async () => {} }; } }));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => sha(stableDiyState(value));
const oldTicket = (reference: string) => reference + '?expires=1&signature=imported-author';
// Independent contract slots, including footer's separately budgeted icons.
function images(value: Row[], transform: (reference: string) => string): Row[] {
  const result = structuredClone(value);
  for (const block of result) {
    if (['swiperBg','homeComb','swipers'].includes(block.name)) {
      if (Array.isArray(block.swiperConfig?.list)) for (const item of block.swiperConfig.list) if (item && typeof item.img === 'string') item.img = transform(item.img);
      if (block.name === 'homeComb' && typeof block.logoConfig?.url === 'string') block.logoConfig.url = transform(block.logoConfig.url);
    }
    if (String(block.name).toLowerCase() === 'pagefoot' && Array.isArray(block.menuList)) for (const item of block.menuList) if (Array.isArray(item.imgList)) for (const i of [0,1]) if (typeof item.imgList[i] === 'string') item.imgList[i] = transform(item.imgList[i]);
  }
  return result;
}
const canonical = (value: Row[]) => images(value, canonicalizePublishedAttachmentReference);
function mediaValues(value: Row[]): string[] { const result: string[] = []; images(value, reference => { result.push(reference); return reference; }); return result; }
type Actor = 0 | 11 | 22 | 'admin' | 'minimal' | 'reader';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('complete carousel author persistence on two real owned PG16 schema configurations', () => {
  describe.each(['isolated-search-path', 'public'] as const)('%s', namespace => {
    const app = createApp(), reads: Row[] = [], writes: Row[] = [], snapshots: Record<string, DiyStateSnapshot> = {};
    let f: Awaited<ReturnType<typeof diyCarouselAuthorFixture>>, directory = '', now: Date;
    let rows: Array<typeof systemDise.$inferSelect>, attachments: Array<typeof systemAttachment.$inferSelect>, roles: Array<typeof systemRole.$inferSelect>;
    const remember = (snapshot: DiyStateSnapshot) => { const hash = digest(snapshot); snapshots[hash] ??= structuredClone(snapshot); return hash; };
    beforeAll(async () => {
      now = new Date(); vi.setSystemTime(now); f = await diyCarouselAuthorFixture(now, namespace === 'public' ? { namespace: 'public' } : {}); wiring.container = f.container;
      rows = await f.db.select().from(systemDise); attachments = await f.db.select().from(systemAttachment); roles = await f.db.select().from(systemRole);
      directory = await mkdtemp(join(tmpdir(), 'cinashop-diy-carousel-author-native-'));
      const actualSchema = (await f.db.execute<{ schema: string }>(sql`SELECT current_schema() AS schema`))[0]!.schema;
      expect(actualSchema === 'public').toBe(namespace === 'public');
      const text = JSON.stringify({ namespace, actual_schema: actualSchema, inventory: { tables: f.tables, sequences: f.sequences }, setup: f.carouselAuthorSetup,
        boundary: 'Owned maintenance SQL DI, actual createApp/middleware/JWT/transactions/public projection/PNG bytes. Distinct production LOGIN grants are covered separately by admin-diy-author-options native tests. Dynamic inventory is not the old73/68 claim.' }, null, 2) + '\n';
      const path = join(directory, 'setup.json'); await writeFile(path, text); process.stdout.write('DIY_CAROUSEL_AUTHOR_NATIVE_SETUP ' + JSON.stringify({ path, sha256: sha(text), namespace, tables: f.tables.length, sequences: f.sequences.length }) + '\n');
    }, 90_000);
    afterAll(async () => {
      try { if (f && directory) {
        const text = JSON.stringify({ namespace, tables: f.tables, sequences: f.sequences, reads, writes, snapshots_by_sha256: snapshots, final: await f.snapshot(), resources: f.resources(),
          boundary: 'Every completed GET consumes real JSON/asset bytes before all-table/all-sequence/KV/R2/queue/IMAGES equality. Explicit fixture imports/cleanup and actual POST changes are recorded separately.' }, null, 2) + '\n';
        const path = join(directory, 'execution.json'); await writeFile(path, text); process.stdout.write('DIY_CAROUSEL_AUTHOR_NATIVE_EXECUTION ' + JSON.stringify({ path, sha256: sha(text), namespace, reads: reads.length, writes: writes.length, all_reads_unchanged: reads.every(read => read.unchanged) }) + '\n');
      } } finally { wiring.container = undefined; vi.useRealTimers(); await f?.close(); }
    }, 30_000);
    beforeEach(() => { vi.setSystemTime(now); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned carousel author native forbids external I/O')); });
    afterEach(async () => {
      try { expect(fetch).not.toHaveBeenCalled(); }
      finally {
        vi.restoreAllMocks();
        for (const row of rows) await f.db.update(systemDise).set(row).where(eq(systemDise.id, row.id));
        for (const row of attachments) await f.db.update(systemAttachment).set(row).where(eq(systemAttachment.attId, row.attId));
        for (const row of roles) await f.db.update(systemRole).set(row).where(eq(systemRole.id, row.id));
      }
    });
    const token = (actor: Actor) => actor === 'admin' ? f.adminToken : actor === 'minimal' ? f.minimalToken : actor === 'reader' ? f.readerToken : actor === 11 ? f.token : actor === 22 ? f.otherToken : undefined;
    async function request(path: string, method: 'GET' | 'POST', actor: Actor, body?: unknown) {
      const waits: Promise<unknown>[] = [], auth = token(actor), headers: Record<string, string> = { ...(auth ? { 'Authori-zation': 'Bearer ' + auth } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
      const response = await app.fetch(new Request('https://owned-carousel-author.local' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), f.env,
        { waitUntil: (work: Promise<unknown>) => { waits.push(work); }, passThroughOnException() {} } as unknown as ExecutionContext);
      await Promise.all(waits); const bytes = new Uint8Array(await response.arrayBuffer());
      return { response, bytes, body: response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(new TextDecoder().decode(bytes)) as Row : undefined };
    }
    async function get(path: string, actor: Actor = 0) {
      const before = await f.snapshot(), resources = f.resources(), initialReads = f.bucket.get.mock.calls.length, result = await request(path, 'GET', actor), after = await f.snapshot();
      expect(after).toEqual(before); expect(f.resources()).toEqual(resources);
      reads.push({ path, actor, status: result.body?.status ?? result.response.status, before: remember(before), after: remember(after), unchanged: true,
        body_sha256: sha(result.bytes), r2_reads: f.bucket.get.mock.calls.length - initialReads, resources_before: resources, resources_after: f.resources() }); return result;
    }
    async function page(id = 2, actor: Actor = 0) { const result = await get('/api/diy/get_diy/' + id, actor); expect(result.body?.status).toBe(200); expect(result.response.headers.get('Cache-Control')).toBe('no-store'); return result.body!.data as Row; }
    async function save(body: Row, actor: Actor = 'admin') {
      const before = await f.snapshot(), resources = f.resources(), result = await request('/adminapi/dise/save', 'POST', actor, body), after = await f.snapshot();
      expect(f.resources()).toEqual(resources); writes.push({ actor, request: body, status: result.body?.status, before: remember(before), after: remember(after), resources_before: resources, resources_after: f.resources() }); return { ...result, before, after };
    }
    function saved(result: Awaited<ReturnType<typeof save>>, value: Row[], id = 2) {
      expect(result.body?.status).toBe(200); const old = result.before.system_dise.find(row => row.id === id)!, actual = result.after.system_dise.find(row => row.id === id)!, wanted = structuredClone(result.before);
      expect(actual.version).not.toBe(old.version); expect(actual.update_time).toBeGreaterThan(old.update_time);
      Object.assign(wanted.system_dise.find(row => row.id === id)!, { value: JSON.stringify(value), version: actual.version, update_time: actual.update_time }); expect(result.after).toEqual(sortedDiyState(wanted));
      expect(actual.content).toBe(old.content); return actual;
    }
    async function imported(value: Row[]) {
      const before = await f.snapshot(), resources = f.resources(); await f.db.update(systemDise).set({ value: JSON.stringify(value) }).where(eq(systemDise.id, 2));
      const after = await f.snapshot(), wanted = structuredClone(before); wanted.system_dise.find(row => row.id === 2)!.value = JSON.stringify(value); expect(after).toEqual(sortedDiyState(wanted)); expect(f.resources()).toEqual(resources);
      writes.push({ phase: 'explicit owned imported-fixture setup, not author POST or GET', before: remember(before), after: remember(after), resources_before: resources, resources_after: f.resources() });
    }

    it('dynamically inventories every real table and sequence with separate modern default and legacy import setup', async () => {
      const tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(r => r.name);
      const sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(r => r.name);
      expect(f.tables).toEqual(tables); expect(f.sequences).toEqual(sequences);
      const snapshot = await f.snapshot(); expect(Object.keys(snapshot).sort()).toEqual([...tables, '__sequences'].sort()); expect(snapshot.__sequences.map(r => r.name).sort()).toEqual(sequences);
      expect(f.carouselAuthorSetup.legacy_ordinary_new_default).toBe(false); expect(snapshot.store_product_words.filter(r => r.type === 0 && r.relation_id === 0 && r.is_show === 1)).toHaveLength(25);
      expect(carouselAuthorBlock('swiperBg', 7).swiperConfig.list).toHaveLength(1); expect(carouselAuthorBlock('homeComb', 8).tabListConfig.list).toHaveLength(4);
    });
    it('serves root and imported micro all-three-family schema to anonymous and both users with full metadata retained', async () => {
      for (const id of [0,2]) for (const actor of [0,11,22] as const) {
        const expected = id === 0 ? f.rootBlocks.filter(b => b.name !== 'pageFoot') : f.microBlocks;
        const actual = await page(id, actor); expect(canonical(actual.value)).toEqual(expected); expect(actual.title).toBe(id === 0 ? '轮播作者首页' : '轮播作者导入微页');
        expect(actual.content).toBeUndefined(); expect((await get('/api/diy/diy_version/' + id, actor)).body?.data.version).toBe('carousel-author-initial');
      }
    });
    it('publishes the real typed category child and its sid-scoped product anonymously with all SQL, sequences and resources unchanged', async () => {
      const category = await get('/api/category'); expect(category.body?.status).toBe(200);
      const roots = category.body!.data as Row[], parent = roots.find(row => row.id === 84021)!;
      expect(parent).toEqual({ id: 84021, pid: 0, cate_name: '作者父分类', pic: '', big_pic: '', children: [
        { id: 84022, pid: 84021, cate_name: '作者子分类', pic: '', big_pic: '', children: [] },
      ] });
      expect(JSON.stringify(roots)).not.toMatch(/作者隐藏分类|作者孤儿分类|作者供应商分类/u);
      const products = await get('/api/products?cid=84021&sid=84022&page=1&limit=8'); expect(products.body?.status).toBe(200);
      expect(products.body!.data.count).toBe(1); expect(products.body!.data.list.map((row: Row) => row.id)).toEqual([84031]);
      const product = products.body!.data.list[0]; expect(product).toMatchObject({ id: 84031, store_name: '作者目录商品', price: '9.50' });
      expect(canonicalizePublishedAttachmentReference(product.image)).toBe(f.platformImage.url); expect(product.image).toMatch(/\?expires=\d+&signature=/u);
      const asset = await get(product.image); expect(asset.response.status).toBe(200); expect(asset.bytes).toEqual(f.png);
    });
    it.each([['swiperBg',0],['swiperBg',1],['swiperBg',2],['homeComb',0],['homeComb',1]] as const)('roundtrips complete modern%s style%s content, metadata and every conditional style family', async (kind, style) => {
      const value = structuredClone(f.rootBlocks), block = value.find(r => r.name === kind)!;
      block.styleConfig.tabVal = style; block.docConfig.tabVal = 3; block.docPosition.tabVal = 2; block.toneConfig.tabVal = 1;
      block.dotColor.color[0].item = '#123456'; block.dotBgColor.color[0].item = '#abcdef'; block.filletImg.type = 1;
      block.filletImg.valList = [{ val: ' 1.25 ' },{ val: '2e0' },{ val: 3.5 },{ val: 4.75 }]; block.filletImg.val = 12;
      block.swiperConfig.list.reverse(); block.swiperConfig.list[0].img = f.secondIcon.url;
      block.swiperConfig.list[0].info[kind === 'swiperBg' ? 0 : 1].value = '/pages/article/list';
      if (kind === 'swiperBg') { block.imgConfig.val = 6; block.bgColor.color[0].item = '#f0e0d0'; for (const key of ['topConfig','bottomConfig','prConfig','mbConfig']) block[key].val = 7.5; }
      else { block.classConfig.tabVal = style; block.searchConfig.tabVal = 1; block.logoConfig.url = f.secondIcon.url; block.inputConfig.value = '更新轮播提示'; block.hotWords.list = [{ val: '作者热词25' },{ val: '作者热词1' }]; block.numConfig.val = 4.5; block.contentConfig.val = 22;
        block.classColor.color[0].item = '#123456'; block.classColor.color[1].item = '#abcdef'; block.tabListConfig.list.reverse(); const tab = block.tabListConfig.list[0];
        tab.text.val = '真实微页'; tab.dataType.tabVal = 0; Object.assign(tab.microPage, { id: 2, name: '轮播作者微页' }); Object.assign(tab.classPage, { id: 84022, name: '保留非当前分类' }); }
      saved(await save({ id: 2, value: JSON.stringify(value) }), value); expect(canonical((await page()).value)).toEqual(value);
    });
    it.each([0,1,2,3])('retains modern indicator%s and both positions/colors without erasing hidden tone or spacing values', async indicator => {
      const value = expectedCarouselRootEdit(f), home = value.find(r => r.name === 'homeComb')!, bg = value.find(r => r.name === 'swiperBg')!;
      home.docConfig.tabVal = bg.docConfig.tabVal = indicator; home.docPosition.tabVal = 0; bg.docPosition.tabVal = 2;
      home.toneConfig.tabVal = bg.toneConfig.tabVal = 0; home.dotColor.color[0].item = '#fedcba'; bg.bottomConfig.val = ' 77.5 '; bg.imgConfig.val = '9e0'; bg.styleConfig.tabVal = 1;
      saved(await save({ id: 2, value: JSON.stringify(value) }), value); expect(canonical((await page()).value)).toEqual(value);
    });
    it.each([[0,0],[0,1],[1,0],[1,1]])('edits imported legacy layout%s indicator%s with all actual link slots and rpx fields retained', async (layout, indicator) => {
      const value = structuredClone(f.microBlocks), legacy = value.find(r => r.name === 'swipers')!;
      legacy.tabConfig.tabVal = layout; legacy.docConfig.type = indicator; legacy.imgConfig.type = indicator; legacy.itemEdge.val = ' 12.5 '; legacy.lrConfig.val = 8; legacy.mbConfig.val = 3.25;
      legacy.swiperConfig.list[0].img = f.secondIcon.url; legacy.swiperConfig.list[0].info[1].title = '/pages/user/sign';
      legacy.swiperConfig.list[1].info[1].title = '链接'; legacy.swiperConfig.list[1].info[1].value = '/pages/article/list';
      saved(await save({ id: 2, value: JSON.stringify(value) }, 'minimal'), value); expect(canonical((await page()).value)).toEqual(value);
    });
    it('roundtrips the complete three-GUI-save expectations with independent content and unrelated metadata unchanged', async () => {
      for (const [id, value] of [[1,expectedCarouselRootEdit(f)],[1,expectedCarouselAlternateEdit(f)],[2,expectedCarouselMicroEdit(f)]] as const) {
        saved(await save({ id, value: JSON.stringify(value) }), value, id); expect(canonical((await page(id)).value)).toEqual(value);
      }
    });
    it('keeps tiny radii, exponent/whitespace strings, zero and101 times, hidden duplicate and malformed dormant fields after an unrelated edit', async () => {
      const value = expectedCarouselMicroEdit(f), home = value.find(r => r.name === 'homeComb')!;
      home.tabListConfig.list[0].classPage = { id: -17, name: '非当前旧分类', imported: ['opaque'] };
      home.tabListConfig.list[2].microPage = ['malformed-dormant-import']; home.extraLegacy = { unrendered: ' 1e-999 ', metadata: false };
      saved(await save({ id: 2, value: JSON.stringify(value) }, 'minimal'), value); expect(canonical((await page()).value)).toEqual(value);
      expect(value.find(r => r.name === 'homeComb' && r.isHide)?.numConfig.val).toBe(101);
    });
    it('retains imported lists beyond10slides20words100tabs and beyond200raw components without implicit clipping', async () => {
      const value = structuredClone(f.microBlocks), home = value.find(r => r.name === 'homeComb')!, bg = value.find(r => r.name === 'swiperBg')!;
      home.tabListConfig.list = Array.from({ length: 101 }, (_, i) => ({ ...structuredClone(home.tabListConfig.list[0]), importedIndex: i }));
      bg.swiperConfig.list = Array.from({ length: 21 }, (_, i) => ({ ...structuredClone(bg.swiperConfig.list[0]), importedIndex: i }));
      while (value.length < 201) value.push({ name: 'unsupported-carousel-import', timestamp: 1000 + value.length, opaque: { zero: 0, list: [] } });
      saved(await save({ id: 2, value: JSON.stringify(value) }), value); expect(canonical((await page()).value)).toEqual(value);
    });
    it('preserves imported duplicate/top conflicts as raw data rather than inventing a backend ordinary-author restriction', async () => {
      const value = structuredClone(f.microBlocks); value.push({ name: 'headerSerch', timestamp: -5, isHide: true, logoConfig: { url: '' }, unknown: 'retain-conflict' }, { name: 'tabNav', timestamp: -4, hidden: 'preserve' });
      saved(await save({ id: 2, value: JSON.stringify(value) }), value); expect(canonical((await page()).value)).toEqual(value);
    });
    it('canonicalizes only actual slide/logo/footer slots while captions, link precedence slots, tab previews and unknown strings remain exact', async () => {
      const value = images(f.microBlocks, reference => reference ? oldTicket(reference) : reference), home = value.find(r => r.name === 'homeComb')!, legacy = value.find(r => r.name === 'swipers')!;
      legacy.swiperConfig.list[0].info[1].value = oldTicket(f.platformImage.url); home.tabListConfig.list[0].preview = oldTicket(f.image.url); home.unknownImage = oldTicket(f.platformImage.url);
      const expected = canonical(value); saved(await save({ id: 2, value: JSON.stringify(value) }), expected); const actual = await page(); expect(canonical(actual.value)).toEqual(expected);
      const url = actual.value.find((r: Row) => r.name === 'homeComb').logoConfig.url; expect(url).toMatch(/\?expires=\d+&signature=/u); const asset = await get(url); expect(asset.response.status).toBe(200); expect(asset.bytes).toEqual(f.png);
    });
    it('refuses private user and supplier carousel assets even for their authenticated attachment owner', async () => {
      const value = images(f.microBlocks, reference => reference === f.platformImage.url ? f.image.url : reference);
      value.find(r => r.name === 'swiperBg')!.swiperConfig.list[0].img = f.supplierImage.url;
      saved(await save({ id: 2, value: JSON.stringify(value) }), value);
      const expected = images(value, reference => [f.image.url,f.supplierImage.url].includes(reference) ? '' : reference);
      for (const actor of [0,11,22] as const) expect(canonical((await page(2, actor)).value)).toEqual(expected);
    });
    const ownershipCases: Array<[string, Partial<typeof systemAttachment.$inferInsert>]> = [
      ['private user',{ type: 3, relationId: 11, moduleType: 3 }],['foreign user',{ type: 3, relationId: 22, moduleType: 3 }],['merchant owner',{ type: 4, relationId: 703 }],
      ['wrong platform relation',{ type: 1, relationId: 11 }],['foreign module',{ moduleType: 5 }],['non-image file',{ fileType: 2 }],['non-R2 raster',{ imageType: 0 }],
      ['contradictory MIME',{ attType: 'image/jpeg' }],['active MIME',{ attType: 'text/html' }],['foreign key',{ name: 'attachments/admin/2/foreign.png' }],
      ['traversal key',{ name: 'attachments/admin/1/../foreign.png' }],['backslash key',{ name: 'attachments/admin/1/foreign\\image.png' }],['SVG object',{ name: 'attachments/admin/1/foreign.svg' }],['mismatched canonical id',{ attDir: '/api/assets/999999' }],
    ];
    it.each(ownershipCases)('rechecks%s and withdraws all matching modern, legacy and logo signatures with zero GET mutation', async (_label, patch) => {
      await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, f.platformImage.att_id));
      const expected = images(f.microBlocks, reference => reference === f.platformImage.url ? '' : reference);
      for (const actor of [0,11,22] as const) { const actual = await page(2, actor); expect(canonical(actual.value)).toEqual(expected); expect(JSON.stringify(actual)).not.toContain('attachments/admin/'); }
    });
    it('withdraws actually deleted media without modifying the authored version and restores the owned fixture row', async () => {
      const original = attachments.find(r => r.attId === f.platformImage.att_id)!;
      await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, original.attId));
      try { expect(canonical((await page()).value)).toEqual(images(f.microBlocks, reference => reference === f.platformImage.url ? '' : reference)); expect((await get('/api/diy/diy_version/2')).body?.data.version).toBe('carousel-author-initial'); }
      finally { await f.db.insert(systemAttachment).values(original); }
    });
    it('renews expired read tickets for every real carousel slot without changing its page version, storage or resource writes', async () => {
      const first = await page(), url = first.value.find((r: Row) => r.name === 'homeComb').logoConfig.url;
      vi.setSystemTime(new Date(now.getTime() + 901_000)); const fresh = await page(), next = fresh.value.find((r: Row) => r.name === 'homeComb').logoConfig.url;
      expect(next).not.toBe(url); expect((await get(url)).response.status).toBe(404); const asset = await get(next); expect(asset.response.status).toBe(200); expect(asset.bytes).toEqual(f.png);
      expect((await get('/api/diy/diy_version/2')).body?.data.version).toBe('carousel-author-initial');
    });
    it('keeps the ordinary2500 budget independent from footer/navigation and atomically rejects2501 before signing or saving', async () => {
      const legacy = importedLegacyCarousel(f.platformImage.url); legacy.swiperConfig.list = Array.from({ length: 2500 }, () => ({ img: f.platformImage.url }));
      const footer = structuredClone(f.microBlocks.find(r => r.name === 'pageFoot')!), value = [legacy,footer]; saved(await save({ id: 2, value: JSON.stringify(value) }), value);
      const actual = await page(); expect(mediaValues(actual.value).filter(v => v.startsWith(f.platformImage.url + '?'))).toHaveLength(2510); expect(canonical(actual.value)).toEqual(value);
      legacy.swiperConfig.list.push({ img: f.platformImage.url }); const failed = await save({ id: 2, value: JSON.stringify(value) }); expect(failed.body?.status).toBe(400); expect(failed.body?.msg).toBe('DIY公开素材超过完整读取容量'); expect(failed.after).toEqual(failed.before);
      await imported(value); const read = await get('/api/diy/get_diy/2'); expect(read.body?.status).toBe(400); expect(JSON.stringify(read.body)).not.toContain('signature=');
    }, 45_000);
    it('retains200 imported complete-capacity minimal homeComb records with10slides andlogo each without inventing normal singleton creation', async () => {
      const value = Array.from({ length: 200 }, (_, i) => ({ name: 'homeComb', timestamp: 1000+i, imported: true, logoConfig: { url: f.platformImage.url }, swiperConfig: { list: Array.from({ length: 10 }, () => ({ img: f.platformImage.url, info: [{ value: '导入图' },{ value: '/pages/article/list' }] })) } }));
      saved(await save({ id: 2, value: JSON.stringify(value) }), value); const actual = await page(); expect(mediaValues(actual.value)).toHaveLength(2200); expect(canonical(actual.value)).toEqual(value);
    }, 45_000);
    it('keeps the exact2MB UTF8 and valid-top-level depth/node boundaries with atomic rejects rather than clipping authored data', async () => {
      const value = structuredClone(f.microBlocks); value.push({ name: 'unsupported-carousel-payload', note: '界' }); const block = value.at(-1)!;
      block.note += 'a'.repeat(2_000_000 - Buffer.byteLength(JSON.stringify(value))); saved(await save({ id: 2, value: JSON.stringify(value) }), value);
      for (const bad of [JSON.stringify([...value.slice(0,-1),{ ...block, note: block.note+'a' }]),JSON.stringify([{ name: 'swipers', payload: Array(100001).fill(0) }]),JSON.stringify([{ name: 'homeComb', nested: Array.from({ length: 65 }).reduce<unknown>(next => ({ next }), '') }])]) {
        const result = await save({ id: 2, value: bad }); expect(result.body?.status).toBe(400); expect(result.after).toEqual(result.before);
      }
    }, 45_000);
    it.each([0,11,22,'reader'] as const)('denies actual save byactor%s with fullSQL/sequences/resources unchanged', async actor => {
      const result = await save({ id: 2, value: JSON.stringify(expectedCarouselRootEdit(f)) }, actor); expect(result.body?.status).not.toBe(200); expect(result.after).toEqual(result.before);
    });
    it('rechecks persisted minimal-role revocation and rejects forged generic identity/metadata writes atomically', async () => {
      await f.db.update(systemRole).set({ rules: 'dise.view' }).where(eq(systemRole.id, 903)); const denied = await save({ id: 2, value: JSON.stringify(f.microBlocks) }, 'minimal'); expect(denied.body?.status).toBe(400011); expect(denied.after).toEqual(denied.before);
      for (const patch of [{ type: 1 },{ is_diy: 0 },{ template_name: 'default' },{ version: 'forged' },{ is_bg_color: true },{ bg_tab_val: 3 }]) { const result = await save({ id: 2, value: JSON.stringify(f.microBlocks), ...patch }); expect(result.body?.status).toBe(400); expect(result.after).toEqual(result.before); }
    });
  });
});
