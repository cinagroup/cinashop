import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeProduct, storeProductCategory, storeProductRelation } from '@/models/schema';
import { diyCarouselFixture } from '../helpers/diyCarouselFixture';
import { sortedDiyState, stableDiyState, type DiyStateRow as Row } from '../helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned carousel SQL');
  return wiring.container;
} }));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const value of req) { const chunk = Buffer.from(value); length += chunk.length; expect(length).toBeLessThan(500_000); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]))).flat().sort();
}

it('actual built carousel H5 uses owned catalogue, public media, both page callers and real Admin configuration', async () => {
  const f = await diyCarouselFixture(); wiring.container = f.container;
  const app = createApp(), repository = resolve(import.meta.dirname, '../../..');
  const origin = 'http://127.0.0.1:40771', control = '/__carousel/' + randomUUID();
  const prefix = '/tmp/cinashop-homecomb-window-browser-', build = resolve(repository, 'view/uniapp-ts/dist/build/h5');
  const keyword = '轮播搜索A&B 中文';
  const plans = ['home', 'rotated', 'legacyDestination', 'afterLegacy', 'articleDestination', 'afterArticle', 'searchDestination', 'afterSearch', 'rootFixed', 'rootFixedDestination', 'afterRootFixed', 'expanded',
    'microSelected', 'homeSelected', 'categoryFailed', 'categoryRetry', 'categoryPage2', 'childChanged', 'childRenewed', 'owner22Home', 'owner22Category',
    'microCaller', 'microFixed', 'microFixedDestination', 'afterMicroFixed', 'microSelectedFromMicro', 'microCategoryFromMicro', 'microCategoryPage2', 'microHome',
    'changed', 'changedHome', 'closed', 'closedRetry', 'reopened', 'finished'];
  const traces: Row[] = [], evidence: Row[] = [], configs: Row[] = [], setup: Row[] = [], staticPaths = new Set<string>();
  const browserErrors: Row[] = [], servedHtml: Row[] = []; let lastObservation: Row | undefined, failedCategory = false, changed = false, pending = 0;
  let server: Server | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned carousel acceptance forbids external provider I/O'));
  const stage = () => plans[evidence.length];
  const send = (res: ServerResponse, value: string | Buffer, status = 200, type = 'text/html') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(value);
  };
  const json = (res: ServerResponse, value: unknown, status = 200) => send(res, JSON.stringify(value), status, 'application/json');
  const headers = (req: IncomingMessage) => { const value = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) value.append(req.rawHeaders[i], req.rawHeaders[i + 1]); return value; };
  let queue = Promise.resolve();
  function serial<T>(fn: () => Promise<T>) { const next = queue.then(fn); queue = next.then(() => {}, () => {}); return next; }
  const storage = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length,
    objects: digest([...f.objects].map(([key, value]) => ({ key, type: value.type, bytes: [...value.bytes] }))),
    queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length, images: { info: f.rendering.info.mock.calls.length,
      input: f.rendering.input.mock.calls.length, transform: f.rendering.transform.mock.calls.length,
      draw: f.rendering.draw.mock.calls.length, output: f.rendering.output.mock.calls.length } });
  let expected = await f.snapshot(); const initial = structuredClone(expected), initialStorage = storage();
  const blocks: Record<number, Row[]> = { 1: structuredClone(f.blocks), 2: structuredClone(f.blocks) };
  let beforeHashes: Row[] = [], beforeBuild: Row[] = [];
  const sources = async () => {
    const selected = ['workers-ts/test/browser/diy-carousel.acceptance.ts', 'workers-ts/vitest.diy-carousel-browser.config.ts', 'workers-ts/package.json', 'workers-ts/package-lock.json',
      'view/uniapp-ts/package.json', 'view/uniapp-ts/package-lock.json', 'view/uniapp-ts/vite.config.ts',
      'workers-ts/scripts/run-local-finance-postgres.mjs', 'workers-ts/test/helpers/diyCarouselFixture.ts', 'workers-ts/test/helpers/diyEditorialFixture.ts',
      'workers-ts/test/helpers/diyCommerceFixture.ts', 'workers-ts/test/helpers/diyStateFixture.ts'];
    const input = [...selected.map(path => resolve(repository, path)), ...await files(resolve(repository, 'workers-ts/src')),
      ...await files(resolve(repository, 'view/uniapp-ts/src')), ...await files(resolve(repository, 'view/common'))].sort();
    return Promise.all(input.map(async path => ({ path: path.slice(repository.length + 1), sha256: hash(await readFile(path)) })));
  };
  const artifacts = async () => Promise.all((await files(build)).map(async path => ({ path: path.slice(build.length + 1), sha256: hash(await readFile(path)) })));
  const canonical = (input: Row[]) => {
    const value = structuredClone(input), strip = (row: Row, key: string) => {
      if (typeof row[key] === 'string' && /^\/api\/assets\/[1-9]\d*\?/u.test(row[key])) row[key] = row[key].split('?', 1)[0];
    };
    for (const block of value) if (['swipers', 'swiperBg', 'homeComb'].includes(block.name)) {
      for (const item of block.swiperConfig.list) strip(item, 'img');
      if (block.name === 'homeComb') strip(block.logoConfig, 'url');
    }
    return value;
  };
  async function save(id: 1 | 2, value: Row[], phase: 'setup' | 'business-configuration') {
    const receipt = await f.saveSchema(id, value), want = structuredClone(expected);
    expect(receipt.before).toEqual(expected); expect(receipt.response.status).toBe(200); expect(receipt.body.status).toBe(200);
    want.system_dise = want.system_dise.map(row => row.id === id ? { ...row, value: JSON.stringify(value), version: receipt.body.data.version, update_time: receipt.body.data.update_time } : row);
    expect(receipt.after).toEqual(sortedDiyState(want)); expected = receipt.after;
    const record = { phase, id, before: digest(receipt.before), after: digest(receipt.after), allowed: ['system_dise.value', 'system_dise.version', 'system_dise.update_time'],
      before_row: receipt.before.system_dise.find(row => row.id === id), after_row: receipt.after.system_dise.find(row => row.id === id) };
    (phase === 'setup' ? setup : configs).push(record);
  }
  try {
    expect(f.tables).toHaveLength(50); expect(f.sequences).toHaveLength(46);
    // Explicit owned setup, separate from UI business actions. Existing 602 keeps
    // the real seckill/parent/time associations from diyCommerceFixture.
    const firstIds = [601, 611, 602, ...Array.from({ length: 10 }, (_, i) => 3601 + i)], secondIds = [3701, 3702];
    await f.db.insert(storeProductCategory).values([751, 752].map((id, i) => ({ id, pid: 701, type: 0, relationId: 0, level: 1,
      path: '0,701', cateName: `真实轮播子类${i + 1}`, isShow: 1, sort: 20 - i, pic: '/static/logo.png' })));
    for (const [i, id] of [601, 611, 602].entries()) await f.db.update(storeProduct).set({ sort: 3000 - i }).where(eq(storeProduct.id, id));
    const newIds = [...firstIds.slice(3), ...secondIds];
    await f.db.insert(storeProduct).values(newIds.map((id, i) => ({ id, storeName: `真实轮播分页商品${id}`, image: id === 3701 ? f.platformImage.url : '/static/logo.png', recommendImage: id === 3701 ? f.platformImage.url : '', storeLabelId: id === 3701 ? '704' : null, type: 0, relationId: 0,
      price: '6.50', otPrice: '10.00', stock: 12, unitName: '件', isVerify: 1, isDel: 0, isShow: 1, activity: '0', sort: 2000 - i })));
    await f.db.insert(storeProductRelation).values([...firstIds.map(productId => ({ productId, relationId: 751 })),
      ...secondIds.map(productId => ({ productId, relationId: 752 }))].map((row, i) => ({ ...row, id: 9500 + i, type: 1, relationPid: 701 })));
    const catalogue = await f.snapshot(), want = structuredClone(expected);
    for (const table of ['store_product_category', 'store_product_relation', 'store_product']) want[table] = catalogue[table];
    expect(catalogue).toEqual(sortedDiyState(want)); // All other tables and all 46 sequence states unchanged.
    expect(catalogue.store_product_category.filter(row => [751, 752].includes(row.id))).toMatchObject([
      expect.objectContaining({ pid: 701, level: 1, type: 0, relation_id: 0, is_show: 1 }), expect.objectContaining({ pid: 701, level: 1, type: 0, relation_id: 0, is_show: 1 })]);
    const priorProducts = expected.store_product.map(row => [601, 611, 602].includes(row.id) ? { ...row, sort: 3000 - [601, 611, 602].indexOf(row.id) } : row);
    expect(catalogue.store_product.filter(row => !newIds.includes(row.id))).toEqual(sortedDiyState({ rows: priorProducts }).rows);
    expect(catalogue.store_product.filter(row => newIds.includes(row.id)).map(row => row.id).sort((a, b) => a - b)).toEqual(newIds);
    expect(catalogue.store_product_relation.filter(row => row.id >= 9500).map(row => [row.product_id, row.relation_id]).sort((a, b) => a[0] - b[0])).toEqual(
      [...firstIds.map(id => [id, 751]), ...secondIds.map(id => [id, 752])].sort((a, b) => a[0] - b[0]));
    expect(catalogue.store_product_relation.filter(row => row.id < 9500)).toEqual(expected.store_product_relation);
    expect(catalogue.store_product_category.filter(row => ![751, 752].includes(row.id))).toEqual(expected.store_product_category);
    setup.push({ phase: 'catalogue-setup', before: digest(expected), after: digest(catalogue), inserted_categories: [751, 752],
      inserted_products: newIds, managed_product_media: {id:3701,main_and_recommend_canonical:f.platformImage.url,label:704}, first_scope: { cid: 701, sid: 751, ids: firstIds }, second_scope: { cid: 701, sid: 752, ids: secondIds },
      inserted_relations: catalogue.store_product_relation.filter(row => row.id >= 9500), existing_product_sort_only: [601, 611, 602], sequence_delta: 0,
      table_before: Object.fromEntries(['store_product_category', 'store_product_relation', 'store_product'].map(name => [name, expected[name]])),
      table_after: Object.fromEntries(['store_product_category', 'store_product_relation', 'store_product'].map(name => [name, catalogue[name]])) });
    expected = catalogue;
    for (const id of [1, 2] as const) {
      // Distinct initial footers prove that selecting target body never adopts
      // the target schema's footer; the original caller owns its footer.
      blocks[id].push({ name: 'pageFoot', timestamp: 790 + id, menuList: [{ name: id === 1 ? '原始首页页脚旁观' : '原始微页页脚保留',
        link: '/pages/article/list', imgList: ['/static/logo.png'] }] });
      for (const block of blocks[id]) {
        if (block.swiperConfig) for (const item of block.swiperConfig.list) {
          if (item.img === 'https://images.example.test/carousel.png') item.img = '/static/logo.png';
          if (block.name === 'swiperBg') item.info[0].value = '/pages/article/list';
          if (block.name === 'swipers') { item.info[1].title = '/pages/article/list'; item.info[1].value = '/pages/goods/list?brand_id=703'; }
        }
        if (block.name === 'homeComb') block.hotWords.list = [{ val: keyword }, { val: keyword }];
        if (block.name === 'titles') block.titleConfig.value = id === 1 ? '真实轮播调用族' : '真实选中微页内容';
      }
      await save(id, blocks[id], 'setup');
    }
    expect(storage()).toEqual(initialStorage);
    beforeHashes = await sources(); beforeBuild = await artifacts(); expect(beforeBuild.length).toBeGreaterThan(100);
    const preparedSnapshot = structuredClone(expected);
    const chrome: Row = { '/api/site_config': { site_name: '实际轮播组件验收', site_logo: '', record_No: '', ico_path: '' },
      '/api/share': { title: '轮播组件', synopsis: '', img: '' }, '/api/get_open_adv': { status: 0, time: 3, interval_time: 24, type: 'pic', value: [], video_link: '' },
      '/api/v2/diy/color_change/color_change': {}, '/api/v2/diy/product_detail': {} };
    async function synthetic(req: IncomingMessage, res: ServerResponse, url: URL, data: unknown, scope: string) {
      return serial(async () => { expect(req.method).toBe('GET'); expect(await body(req)).toHaveLength(0); const before = await f.snapshot(), resources = storage();
        expect(before).toEqual(expected); const after = await f.snapshot(); expect(after).toEqual(before);
        traces.push({ path: url.pathname, query: url.search, synthetic: true, method: 'GET', scope,
          before: digest(before), after: digest(after), database_unchanged: true, storage_before: resources, storage_after: storage() });
        expect(storage()).toEqual(resources); json(res, { status: 200, msg: 'Synthetic unrelated chrome/destination only', data }); });
    }
    const realPaths = new Set(['/api/get_script', '/api/category', '/api/category_version', '/api/community/config', '/api/community/list', '/api/diy/get_suspended',
      '/api/diy/get_diy/0', '/api/diy/get_diy/2', '/api/diy/diy_version/0', '/api/diy/diy_version/2', '/api/products']);
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      pending++;
      try { return await serial(async () => {
        expect(req.method).toBe('GET'); expect(await body(req)).toHaveLength(0);
        expect(realPaths.has(url.pathname) || /^\/api\/assets\/\d+$/u.test(url.pathname) || url.pathname === '/api/search/hot_keyword' && f.tables.includes('store_product_words')).toBe(true);
        const product = url.pathname === '/api/products', scoped = product && url.searchParams.has('cid'), search = product && url.searchParams.has('keyword');
        const legacyFallback = product && !scoped && !search;
        const pairs: Array<[string, string]> = []; url.searchParams.forEach((value, key) => { pairs.push([key, value]); }); pairs.sort();
        if (legacyFallback) expect(pairs).toEqual([['limit', '8'], ['page', '1']]);
        if (search) { expect(['searchDestination','rootFixedDestination','microFixedDestination']).toContain(stage()); expect(pairs).toEqual([['keyword', keyword]]); }
        if (scoped) {
          const child = Number(url.searchParams.get('sid')), page = Number(url.searchParams.get('page'));
          expect([751, 752]).toContain(child); expect([1, 2]).toContain(page);
          expect(pairs).toEqual([['cid', '701'], ['limit', '10'], ['news', '0'], ['page', String(page)], ['sid', String(child)]]);
        }
        const authorization = req.headers['authori-zation'] || req.headers.authorization;
        const token = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/, '').trim() : '';
        const requestOwner = token === f.token ? 11 : token === f.otherToken ? 22 : 0;
        if (product) expect(requestOwner).toBe(['owner22Home', 'owner22Category'].includes(stage()) ? 22 : 11);
        const before = await f.snapshot(), resources = storage(), waits: Promise<unknown>[] = []; expect(before).toEqual(expected);
        const upstream = new URL(url.href); upstream.protocol = 'https:';
        const response = await app.fetch(new Request(upstream.href, { headers: headers(req) }), f.env,
          { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, passThroughOnException() {} } as unknown as ExecutionContext);
        await Promise.all(waits);
        const raw = Buffer.from(await response.arrayBuffer()), payload = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(raw.toString()) : undefined;
        expect([200, 206]).toContain(response.status);
        if (search) {
          // Real keyword lookup has an existing search-history write. This
          // owned fixture intentionally lacks user_search, so do not synthesize
          // products or treat this destination's failed real lookup as success.
          expect(f.tables).not.toContain('user_search'); expect(payload).toMatchObject({ status: 500, data: null });
        } else if (payload) expect([200, 410010]).toContain(payload.status);
        expect(await f.snapshot()).toEqual(before); expect(storage()).toEqual(resources);
        if (scoped) {
          expect(payload.status).toBe(200); const rows = payload.data.list as Row[], child = Number(url.searchParams.get('sid')), page = Number(url.searchParams.get('page'));
          const ids = (child === 751 ? firstIds : secondIds).slice((page - 1) * 10, page * 10);
          expect(rows.map(row => row.id)).toEqual(ids); expect(payload.data.count).toBe(child === 751 ? 13 : 2);
          const cart = rows.find(row => row.id === 601); if (cart) expect(cart.cart_num).toBe(requestOwner === 22 ? 4 : 2);
          const activity = rows.find(row => row.id === 602); if (activity) expect(activity.diy_navigation).toMatchObject({ version: 1, product_id: 602, kind: 'seckill', id: 1701 });
        }
        const injected = scoped && !failedCategory;
        if (injected) { expect(stage()).toBe('categoryFailed'); failedCategory = true; }
        traces.push({ path: url.pathname, query: url.search, method: 'GET', synthetic: false, material: payload?.data, status: payload?.status ?? response.status,
          injected, requestOwner, legacyFallback, search, scoped, stage: stage(), before: digest(before), after: digest(await f.snapshot()), database_unchanged: true,
          storage_before: resources, storage_after: storage(), acceptance: search ? 'Route/input only; search results and search-history persistence excluded' : 'accepted real read' });
        if (injected) return json(res, { status: 503, msg: '本地验收：此分类读取失败，请单独重试' }, 503);
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      }); } finally { pending--; }
    }
    async function configure(req: IncomingMessage, res: ServerResponse) {
      return serial(async () => {
        const input = JSON.parse((await body(req)).toString()); expect(input).toEqual({ action: input.action }); expect(await f.snapshot()).toEqual(expected);
        if (input.action === 'schema') {
          expect(stage()).toBe('changed'); expect(changed).toBe(false);
          for (const id of [1, 2] as const) {
            const next = structuredClone(blocks[id]); next.find(block => block.timestamp === 702)!.docConfig.type = 0;
            const background = next.find(block => block.timestamp === 711)!; background.docConfig.tabVal = 3; background.prConfig.val = 16;
            next.find(block => block.timestamp === 721)!.inputConfig.value = '更新轮播搜索';
            next.find(block => block.name === 'titles')!.titleConfig.value = id === 1 ? '真实首页已更新' : '真实微页已更新';
            await save(id, next, 'business-configuration'); blocks[id] = next;
          }
          changed = true;
        } else {
          const closed = input.action === 'close'; expect(input.action).toBe(closed ? 'close' : 'open'); expect(stage()).toBe(closed ? 'closed' : 'reopened');
          const receipt = await f.setConfig('station_open', closed ? '0' : '1'), want = structuredClone(expected);
          expect(receipt.before).toEqual(expected);
          want.system_config = want.system_config.map(row => row.menu_name === 'station_open' && row.is_store === 0 ? { ...row, value: closed ? '0' : '1' } : row);
          expect(receipt.after).toEqual(sortedDiyState(want)); expected = receipt.after; f.cache.set('cfg_station_open', closed ? '1' : '0');
          configs.push({ action: input.action, before: digest(receipt.before), after: digest(receipt.after), allowed: ['station_open'], deliberately_stale_kv: true });
        }
        json(res, { configured: input.action, next: stage() });
      });
    }
    const ratio = (actual: number, expectedValue: number) => expect(Math.abs(actual - expectedValue)).toBeLessThan(0.1);
    function styles(widget: Row) {
      const block = blocks[1].find(row => String(row.timestamp) === widget.key)!;
      expect(block).toBeDefined(); expect(widget.state).toBe('ready'); expect(widget.images).toHaveLength(3);
      for (const image of widget.images) { expect(image.loaded).toBe(true); expect(image.width).toBeGreaterThan(0); expect(image.height).toBeGreaterThan(0); expect(image.src).not.toContain('images.example.test'); }
      const unit = widget.kind === 'homeComb' ? widget.paddingBottom / 30 : widget.paddingLeft / (widget.kind === 'swipers' ? 12 : widget.key === '711' && changed ? 32 : 20);
      expect(unit).toBeGreaterThan(0); expect(widget.canvasWidth).toBeGreaterThan(0); expect(widget.canvasWidth).toBeLessThanOrEqual(widget.wrapperWidth);
      // DOMRect retains subpixel device scaling; the global integer scrollWidth
      // remains strictly375, and no canvas may exceed its actual own wrapper.
      expect(widget.wrapperWidth).toBeLessThan(376);
      if (widget.kind === 'swipers') {
        ratio(widget.marginTop / unit, 9); ratio(widget.height, widget.images[0].height + 10);
        ratio(widget.radii[0] / unit, widget.key === '701' ? 10 : 0);
        if (widget.key === '701') { expect(widget.stacked).toBe(3); expect(widget.swipers).toBe(0); expect(widget.dots).toHaveLength(0); }
        else {
          expect(widget.stacked).toBe(0); expect(widget.swipers).toBe(1); ratio(widget.previous, widget.expectedMargin); ratio(widget.next, widget.expectedMargin);
          expect(widget.indicator).toBe(changed ? 'indicator-0' : 'indicator-3'); expect(widget.dots).toHaveLength(3);
          for (const dot of widget.dots) {
            ratio(dot.width / unit, changed ? 10 : 20); ratio(dot.height / unit, changed ? 10 : 5);
            expect(dot.color).toBe(dot.selected ? 'rgb(255, 255, 255)' : 'rgba(0, 0, 0, 0.4)');
          }
        }
      } else if (widget.kind === 'swiperBg') {
        ratio(widget.marginTop / unit, 14); ratio(widget.paddingTop / unit, 12); ratio(widget.paddingBottom / unit, 16);
        ratio(widget.height, widget.images[0].height / widget.images[0].width * (750 - (widget.key === '711' && changed ? 64 : 40)));
        ratio(widget.radii[0] / unit, 24); expect(widget.backgroundColor).toBe('rgb(234, 240, 247)');
        ratio(widget.previous, widget.expectedMargin); ratio(widget.next, widget.expectedMargin);
        ratio(widget.slidePadding / unit, widget.key === '713' ? 8 : 0);
        ratio(widget.backgroundHeight / widget.wrapperHeight, widget.key === '712' ? 0.5 : 1);
        expect(widget.indicator).toBe('indicator-' + (widget.key === '711' && changed ? 3 : Number(widget.key) - 711));
      } else {
        ratio(widget.height, 320); ratio(widget.previous, widget.expectedMargin); ratio(widget.next, widget.expectedMargin);
        expect(widget.logoLoaded).toBe(true); expect(widget.backgroundLoaded).toBe(true); expect(widget.logoSrc).toMatch(/\/api\/assets\/[1-9]\d*\?/u);
        expect(widget.backgroundSrc).toBe(widget.images[widget.index].src);
        widget.radii.forEach((value: number, i: number) => ratio(value / unit, [4, 8, 12, 16][i]));
        expect(widget.tabIndices).toEqual(widget.key === '721' ? [0, 1, 2] : []);
        expect(widget.tabTitles).toEqual(widget.key === '721' ? ['首页', '真实微页', '真实分类'] : []);
        if (widget.key === '721') { ratio(widget.tabGap, 20); expect(new Set(widget.tabIds).size).toBe(3); }
        expect(widget.indicator).toBe(widget.key === '721' ? 'indicator-2' : 'indicator-3');
      }
      if (widget.kind !== 'swipers') {
        const position = Number(block.docPosition.tabVal); expect(widget.dotPosition).toBe(['flex-start', 'center', 'flex-end'][position]);
        if (widget.indicator === 'indicator-2') { expect(widget.progress).toBe(true); expect(widget.dots).toHaveLength(0); }
        else { expect(widget.dots).toHaveLength(3); for (const dot of widget.dots) expect(dot.color).toBe(dot.selected ? 'rgb(55, 90, 127)' : 'rgb(220, 230, 239)'); }
      }
    }
    const retained = (widgets: Row[]) => widgets.filter(row => row.kind === 'homeComb').map(row => ({ key: row.key, kind: row.kind,
      images: row.images, logoSrc: row.logoSrc, tabIds: row.tabIds, tabTitles: row.tabTitles, previous: row.previous, next: row.next,
      wrapperWidth: row.wrapperWidth, radii: row.radii, selectedTab: row.selectedTab }));
    async function checkpoint(req: IncomingMessage, res: ServerResponse, name: string) {
      return serial(async () => {
        expect(name).toBe(stage()); expect(pending).toBe(0); const data = JSON.parse((await body(req)).toString());
        lastObservation = { stage: name, data }; const slice = traces.slice(evidence.at(-1)?.traceCount ?? 0);
        expect(await f.snapshot()).toEqual(expected); expect(storage()).toEqual(initialStorage);
        expect(data.width).toBe(375); expect(data.scrollWidth).toBeLessThanOrEqual(375); expect(data.errors).toEqual([]);
        expect(data.text).not.toMatch(/Internal Server Error|Failed to resolve|Cannot read properties/u);
        const destination = ['legacyDestination', 'articleDestination', 'searchDestination', 'rootFixedDestination', 'microFixedDestination'].includes(name), closed = ['closed', 'closedRetry'].includes(name);
        if (destination) {
          expect(data.widgets).toHaveLength(0);
          if (!['searchDestination','rootFixedDestination','microFixedDestination'].includes(name)) { expect(data.href).toContain('/pages/article/list'); expect(slice.some(row => row.synthetic && row.scope === 'registered article-list destination')).toBe(true); }
          else {
            expect(data.href).toContain('/pages/goods/search'); const routeQuery = data.href.split('?').at(-1)!;
            // Uni H5 wraps the already encoded native query in its hash router layer.
            expect(new URLSearchParams(routeQuery).get('searchVal')).toBe(encodeURIComponent(keyword)); expect(data.searchValue).toBe(keyword);
            const searchReads = slice.filter(row => row.search && !row.synthetic); expect(searchReads).toHaveLength(1);
            expect(searchReads[0]).toMatchObject({ status: 500, acceptance: 'Route/input only; search results and search-history persistence excluded' });
            expect(data.text).toContain('搜索结果');
          }
        } else if (closed) {
          expect(data.widgets).toHaveLength(0); expect(data.products).toBeNull(); expect(data.footers).toEqual([]); expect(data.text).toContain('站点升级中，请稍候访问');
          expect(slice.filter(row => row.scoped && !row.synthetic)).toHaveLength(0);
          expect(slice.some(row => row.path === '/api/diy/diy_version/0' && row.status === 410010)).toBe(true);
          expect(slice.some(row => /^\/api\/diy\/get_diy\//u.test(row.path))).toBe(false);
        } else {
          const id = data.href.includes('/pages/diy/detail') ? 2 : 0, cache = data.schemaCache.find((row: Row) => row.id === String(id));
          expect(cache).toBeDefined(); expect(cache.entry.versionVerified).toBe(true);
          expect(cache.entry.version).toBe(expected.system_dise.find(row => row.id === (id === 0 ? 1 : 2))!.version);
          const projected = blocks[id === 0 ? 1 : 2].filter(block => id !== 0 || block.name !== 'pageFoot');
          expect(canonical(cache.entry.data.value)).toEqual(projected); // Existing default-home public projection omits pageFoot.
          expect(JSON.stringify(cache.entry)).not.toMatch(/cart_num|now_money|couponUserId/u);
          const category = ['categoryFailed', 'categoryRetry', 'categoryPage2', 'childChanged', 'childRenewed', 'owner22Category', 'microCategoryFromMicro', 'microCategoryPage2'].includes(name);
          const micro = ['microSelected', 'homeSelected', 'microSelectedFromMicro', 'microHome'].includes(name);
          expect(data.widgets.map((row: Row) => row.key).sort()).toEqual(category ? ['721', '722'] : ['701', '702', '711', '712', '713', '721', '722']);
          expect(data.widgets.filter((row: Row) => row.kind === 'homeComb')).toHaveLength(2);
          for (const widget of data.widgets) styles(widget);
          expect(data.renderers).toBe(micro ? 2 : 1); expect(data.legacySearchHeaders).toBe(0);
          expect(data.footers).toEqual(id === 2 ? ['原始微页页脚保留'] : []);
          expect(data.text).not.toContain('原始首页页脚旁观');
          const header = data.widgets.find((row: Row) => row.key === '721')!;
          expect(header.selectedTab).toBe(category ? 2 : ['microSelected', 'microSelectedFromMicro'].includes(name) ? 1 : 0);
          if (micro) expect(data.text).toContain(['microSelected', 'microSelectedFromMicro'].includes(name) ? '真实选中微页内容' : '真实轮播调用族');
          if (name === 'expanded') { expect(header.categoryOpen).toBe(true); expect(header.categoryIndices).toEqual([0, 1, 2]); expect(header.categoryBackground).toContain('rgb(55, 90, 127)'); ratio(header.categoryTop,data.nativeWindowTop); expect(header.categoryCloseHit).toBe(true); }
          else expect(header.categoryOpen).toBe(false);
          if (name === 'rotated') expect(data.widgets.find((row: Row) => row.key === '702').index).toBeGreaterThan(0);
          if (['rootFixed', 'microFixed'].includes(name)) {
            expect(data.scrollTop).toBeGreaterThan(10); const fixed = data.widgets.find((row: Row) => row.key === '722')!;
            expect(fixed.fixed).toBe(true); expect(fixed.searchPosition).toBe('fixed'); expect(data.nativeWindowTop).toBeGreaterThan(0); ratio(fixed.searchTop, data.nativeWindowTop); expect(fixed.searchHit).toBe(true);
          }
          if (category) {
            const product = data.products; expect(product).not.toBeNull(); expect(product.category).toBe('701'); expect(product.children).toEqual(['751', '752']);
            expect(product.loading).toBe(false); expect(product.child).toBe(['childChanged', 'childRenewed'].includes(name) ? '752' : '751');
            if (name === 'categoryFailed') { expect(product.ids).toEqual([]); expect(product.error).toContain('本地验收：此分类读取失败'); expect(slice.filter(row => row.injected)).toHaveLength(1); }
            else {
              expect(product.error).toBe(''); const ids = ['childChanged', 'childRenewed'].includes(name) ? secondIds : ['categoryPage2', 'microCategoryPage2'].includes(name) ? firstIds : firstIds.slice(0, 10);
              expect(product.ids.map(Number).sort((a: number, b: number) => a - b)).toEqual(ids.slice().sort((a, b) => a - b));
              expect(product.more).toBe(!['categoryPage2', 'childChanged', 'childRenewed', 'microCategoryPage2'].includes(name));
            }
            if (name === 'categoryRetry') {
              expect(slice.filter(row => row.scoped && !row.synthetic)).toHaveLength(1); expect(slice.some(row => row.path === '/api/category')).toBe(false);
              expect(retained(data.widgets)).toEqual(retained(evidence.at(-1)!.widgets));
            }
            if (['categoryPage2', 'microCategoryPage2'].includes(name)) {
              const reads = slice.filter(row => row.scoped); expect(reads).toHaveLength(1); expect(new URLSearchParams(reads[0].query).get('page')).toBe('2');
            }
            if (name === 'childChanged') { const reads = slice.filter(row => row.scoped); expect(reads).toHaveLength(1); expect(new URLSearchParams(reads[0].query).get('sid')).toBe('752'); }
            if (name === 'childRenewed') {
              const previous = evidence.find(row => row.stage === 'childChanged')!;
              const prior = previous.schemaCache.find((row: Row) => row.id === '0').entry;
              expect(cache.entry.version).toBe(prior.version); expect(cache.entry.cachedAt - prior.cachedAt).toBeGreaterThanOrEqual(800_000);
              expect(data.observedAt - previous.observedAt).toBeGreaterThan(0);
              expect(slice.some(row => row.path === '/api/diy/get_diy/0' && row.status === 200 && !row.synthetic)).toBe(true);
              expect(slice.some(row => row.path === '/api/category')).toBe(false);
              const freshReads = slice.filter(row => row.scoped); expect(freshReads).toHaveLength(1);
              expect(new URLSearchParams(freshReads[0].query).get('sid')).toBe('752'); expect(new URLSearchParams(freshReads[0].query).get('page')).toBe('1');
              const priorRead = traces.slice(0,previous.traceCount).filter(row => row.scoped && new URLSearchParams(row.query).get('sid')==='752').at(-1)!;
              const oldProduct = priorRead.material.list.find((row: Row) => row.id===3701), freshProduct = freshReads[0].material.list.find((row: Row) => row.id===3701);
              for (const [oldUrl,newUrl] of [[oldProduct.image,freshProduct.image],[oldProduct.recommend_image,freshProduct.recommend_image],
                [oldProduct.store_label.find((row: Row)=>row.id===704).icon,freshProduct.store_label.find((row: Row)=>row.id===704).icon]]) {
                expect(newUrl).toMatch(/^\/api\/assets\/[1-9]\d*\?/u); expect(newUrl).not.toBe(oldUrl);
                expect(Number(new URL(newUrl,origin).searchParams.get('expires'))).toBeGreaterThan(Math.floor(data.observedAt/1000));
              }
              const picture=product.images.find((row: Row)=>row.id==='3701')!; expect(picture.loaded).toBe(true);
              expect(new URL(picture.src).pathname+new URL(picture.src).search).toBe(freshProduct.image);
              expect(picture.labels.some((row: Row)=>row.loaded&&new URL(row.src).pathname+new URL(row.src).search===freshProduct.store_label.find((row: Row)=>row.id===704).icon)).toBe(true);
              const ticket = (entry: Row) => entry.data.value.find((row: Row) => row.timestamp === 702).swiperConfig.list[0].img;
              expect(ticket(cache.entry)).not.toBe(ticket(prior));
              expect(Number(new URL(ticket(cache.entry), origin).searchParams.get('expires')) - Number(new URL(ticket(prior), origin).searchParams.get('expires'))).toBeGreaterThanOrEqual(800);
            }
            if (name === 'owner22Category') {
              const reads = slice.filter(row => row.scoped); expect(reads.length).toBeGreaterThan(0); expect(reads.every(row => row.requestOwner === 22)).toBe(true);
              expect(reads.flatMap(row => row.material.list).find((row: Row) => row.id === 601)).toMatchObject({ id: 601, cart_num: 4 });
            }
          } else expect(data.products).toBeNull();
          if (['changed', 'changedHome'].includes(name)) {
            expect(changed).toBe(true); expect(data.text).toContain(id === 2 ? '真实微页已更新' : '真实首页已更新');
            expect(slice.some(row => row.path === `/api/diy/get_diy/${id}` && !row.synthetic && row.status === 200)).toBe(true);
            const first = evidence.find(row => row.stage === (id === 2 ? 'microCaller' : 'home'));
            expect(data.widgets.find((row: Row) => row.key === '702').images[0].src).not.toBe(first!.widgets.find((row: Row) => row.key === '702').images[0].src);
          }
        }
        expect(external).not.toHaveBeenCalled(); browserErrors.push(...data.errors);
        evidence.push({ stage: name, ...data, traceCount: traces.length, database: digest(expected), pending_at_checkpoint: pending });
        await writeFile(prefix + 'progress.json', JSON.stringify({status:'running',checked:evidence.map(row=>row.stage),last:evidence.at(-1),traceCount:traces.length,configCount:configs.length})+'\n');
        if (name === 'finished') {
          expect(configs).toHaveLength(4); expect(setup.filter(row => row.phase === 'setup')).toHaveLength(2); expect(failedCategory).toBe(true);
          const afterHashes = await sources(), afterBuild = await artifacts(); expect(afterHashes).toEqual(beforeHashes); expect(afterBuild).toEqual(beforeBuild);
          await writeFile(prefix + 'evidence.json', JSON.stringify({ status: 'passed-all-35-checkpoints', evidence, traces, configs, setup,
            environment: { node: process.version, executable: process.execPath, versions: process.versions },
            tables: f.tables, sequences: f.sequences, initial_snapshot: initial, prepared_snapshot: preparedSnapshot, final_snapshot: expected,
            initial_storage: initialStorage, final_storage: storage(), source_hashes: { before: beforeHashes, after: afterHashes },
            h5_artifact_hashes: { before: beforeBuild, after: afterBuild }, served_html_transport: servedHtml, viewport_boundary: 'Owned served index adds only html scrollbar-width:none before bootstrap; raw built HTML/JS/CSS unchanged.375 desktop IAB content, not production classic scrollbar or physical device proof.', static_paths: [...staticPaths].sort(), providerCalls: 0,
            carouselAcceptedReadSqlBusinessWrites: 0, r2BusinessWrites: 0, queueBusinessWrites: 0, browserErrors,
            search_destination_boundary: { route_and_input: 'accepted', real_request: 'attempted; actual error envelope preserved',
              product_results: 'not verified', search_history_persistence: 'not verified; existing production write, user_search absent from owned fixture' },
            limitations: 'Actual built H5 JS/CSS/createApp/JWT/owned PG16; served index adds explicitly hashed html scrollbar-width:none viewport-only CSS, raw built files unchanged; accepted carousel/catalogue GETs use real controllers and full 50-table/46-sequence snapshots. Catalogue inserts/sort setup and two initial real Admin-controller saves are separate setup; runtime two schema saves and station close/open are the only allowed configuration writes. The fixture-only Admin host proves parser/controller/transaction, not production Admin authentication or ACL. PHP Admin devise/index.vue permits only one home_comb, excludes search/tabNav and inserts it first; two imported homeComb instances intentionally stress existing TS multi-instance behavior, not a claim that the PHP editor creates this configuration. Synthetic unrelated chrome, registered article-list destination and missing-table hot-keyword destination chrome are explicitly tagged, with no article-detail/visit/like acceptance. Exact legacy homepage page=1/limit=8 recommendations use real products SQL and are distinguished from scoped category reads. Three search destinations including actual fixed-header clicks from both callers prove encoded searchVal route/input only: keyword-only products request is attempted through real API and its actual error is preserved because owned user_search is absent; search results/history persistence are unverified and search GET is not claimed read-only. Root footer is never adopted from selected body; original micro caller footer remains through all body selections. Internal HTTPS Request on HTTP loopback is a transport bridge, not TLS acceptance. No automatic poster, album, cart or provider operation is exercised. Browser childRenewed waits the actual840s root media timer and verifies unchanged version, advanced cachedAt, fresh schema and product main/recommend/label tickets, loaded actual main/label pixels and retained child752/2cards/exhausted paging; coupled Node fake-clock regressions also cover root/micro homeComb/tabNav, pending pagination, hide/owner/closure. Browser additionally proves fresh schema reads/tickets after real configuration save. H5 autoplay is accepted; IAB does not support native touch gesture injection and manual swipe is not claimed. No MP/App device, real provider, production, Windows or standalone PHP execution acceptance.' }, null, 2) + '\n');
          done();
        }
        json(res, { checked: evidence.map(row => row.stage), next: stage() });
      });
    }
    const instructions: Row = {
      home: 'Click 实际首页11, wait frame load and all seven canvases ready with every slide natural image loaded; click 375内容区, then checkpoint.',
      rotated: 'Observe actual autoplay in instance702 until data-index>0; checkpoint after transition settles. IAB touch gesture APIs are unavailable; manual swipes are not claimed.',
      legacyDestination: 'Tap actual stacked701 image; persisted info[1].title goes to article list while info[1].value deliberately points elsewhere. Wait registered destination load.',
      afterLegacy: 'Click 实际首页11 and wait seven complete canvases before checkpoint.',
      articleDestination: 'Tap actual selected image in swiperBg711; info[0].value must navigate registered article list; wait destination load.',
      afterArticle: 'Click 实际首页11 and wait seven complete canvases before checkpoint.',
      searchDestination: 'Tap homeComb721 actual search bar. Wait encoded searchVal destination plus real keyword-only products request and input value.',
      afterSearch: 'Click 实际首页11; wait actual frame load and seven ready canvases.',
      rootFixed: 'Scroll the actual iframe page down >10px; homeComb722 search header must become position:fixed at the actual native titlebar bottom, with unobstructed center hit.',
      rootFixedDestination: 'Click actual fixed722 search without force; wait real encoded search route/input and the explicit real keyword request error.',
      afterRootFixed: 'Load actual home11 fresh; wait seven complete canvases before continuing original expansion flow.',
      expanded: 'Scroll back to homeComb721; open actual expand, click visible close, verify mask gone, reopen then checkpoint. Close center must hit below native titlebar.',
      microSelected: 'Click dropdown item data-tab-index=1 in721. Wait real get_diy/2 plus nested title and all seven canvases; root two headers remain, child footer absent.',
      homeSelected: 'Click721 tab0. Wait version-verified cached or freshly read selected home0 content; root two headers remain and nested headers/footer are stripped.',
      categoryFailed: 'Click721 tab2. Wait real /category and first scoped products request intentionally surfaced503; checkpoint exact error.',
      categoryRetry: 'Click actual 重试当前分类 only. Wait first10 real cards and all images; no reload or other-instance action.',
      categoryPage2: 'Click actual 加载更多 OR reach the actual page bottom once; wait13 cards and no more button.',
      childChanged: 'Click actual child752; wait2 cards, first page and no more button.',
      childRenewed: 'Keep this exact loaded child752 page open until the real840s same-version media renewal; do not navigate, reload or change child. Checkpoint only after schema cachedAt advances and new tickets load, retaining752/2cards/exhausted paging.',
      owner22Home: 'Click 实际首页22 fresh iframe; wait all seven ready canvases.',
      owner22Category: 'Click721 tab2; wait child751 first10, actual owner22/cart601=4.',
      microCaller: 'Click 实际微页面11 fresh iframe; wait all seven ready canvases, real micro-page title and original micro footer.',
      microFixed: 'Scroll actual micro page >10px and verify722 fixed search header.',
      microFixedDestination: 'Click actual fixed722 search in micro caller without force; wait encoded route/input and real keyword request.',
      afterMicroFixed: 'Load actual micro11 fresh; wait original footer and seven complete canvases.',
      microSelectedFromMicro: 'Return to721 and click tab1; wait selected micro2, two root headers, nested stripped content and exactly one original micro footer.',
      microCategoryFromMicro: 'Click721 tab2; wait751 first10 real cards, category response and original micro footer.',
      microCategoryPage2: 'Click actual 加载更多 OR actual page reach-bottom once; wait13 cards.',
      microHome: 'Click721 tab0; wait actual selected root schema body, retaining current micro caller headers/footer; do not adopt target root footer.',
      changed: 'Click 更新配置 (two real Admin controller saves), then 实际微页面11 fresh iframe. Wait all seven new canvases/ticket and updated title.',
      changedHome: 'Click 实际首页11; wait saved home schema and new ticket/all seven ready canvases.',
      closed: 'Click 关闭站点, then 实际首页11 fresh iframe. Wait actual closed envelope and no component/category reads.',
      closedRetry: 'Click actual page 重新加载首页. Wait second fresh closed response; no component/category reads.',
      reopened: 'Click 开启站点, then actual page 重新加载首页. Wait all seven positive canvases/all natural images before checkpoint.',
      finished: 'Final stable checkpoint with all seven ready canvases. Test verifies all source/artifact hashes and writes full receipt.'
    };
    async function ownedIndex() {
      const raw = await readFile(resolve(build, 'index.html')), original = raw.toString();
      const viewport = '<style data-owned-acceptance-viewport>html{scrollbar-width:none!important}</style>';
      expect(original).toContain('</head>'); const augmented = original.replace('</head>', viewport + '</head>');
      servedHtml.push({raw_sha256:hash(raw),served_sha256:hash(augmented),raw_bytes:raw.length,served_bytes:Buffer.byteLength(augmented),fixture_only_style:viewport,app_JS_CSS_unchanged:true});
      return augmented;
    }
    const shell = () => `<!doctype html><meta charset="utf-8"><title>DIY轮播组合后台验收</title>
<style>body{font:13px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:375px;height:830px}pre{max-height:90px;overflow:auto;white-space:pre-wrap}</style>
<h1>实际轮播、搜索、组合分类验收</h1><button data-route="home">实际首页11</button><button data-route="micro">实际微页面11</button><button data-route="other">实际首页22</button><button data-size>375内容区</button>
<button data-config="schema">更新配置</button><button data-config="close">关闭站点</button><button data-config="open">开启站点</button>
${plans.map(name => '<button data-stage="' + name + '">' + name + '</button>').join('')}<pre id="result"></pre><iframe title="实际轮播页面" scrolling="yes"></iframe>
<script>
const frame=document.querySelector('iframe'),token=${JSON.stringify(f.token)},other=${JSON.stringify(f.otherToken)},instructions=${JSON.stringify(instructions)};
for(const key of Object.keys(localStorage))if(key.startsWith('cinashop_diy_page_v1_'))localStorage.removeItem(key);
let loaded=false,errors=[];
frame.onload=()=>{loaded=true;const w=frame.contentWindow;w.addEventListener('error',event=>errors.push({kind:'error',message:String(event.message)}));w.addEventListener('unhandledrejection',event=>errors.push({kind:'unhandledrejection',message:String(event.reason)}));};
for(const button of document.querySelectorAll('[data-route]'))button.onclick=()=>{loaded=false;errors=[];localStorage.setItem('uni_token',JSON.stringify({type:'string',data:button.dataset.route==='other'?other:token}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:button.dataset.route==='other'?22:11}));frame.src='/?carousel_session='+Date.now()+'#'+(button.dataset.route==='micro'?'/pages/diy/detail?id=2':'/pages/index/index');};
document.querySelector('[data-size]').onclick=()=>{frame.style.width=(375+frame.contentWindow.innerWidth-frame.contentDocument.documentElement.clientWidth)+'px';};
for(const button of document.querySelectorAll('[data-config]'))button.onclick=async()=>{button.disabled=true;try{const response=await fetch('${control}/configure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:button.dataset.config})});document.querySelector('#result').textContent=JSON.stringify(await response.json());}finally{button.disabled=false;}};
const visible=element=>{if(!element)return false;for(let parent=element;parent;parent=parent.parentElement){const css=frame.contentWindow.getComputedStyle(parent);if(css.display==='none'||css.visibility==='hidden')return false;}return true;};
const text=element=>visible(element)?element.textContent.trim().replace(/\\s+/g,' '):'';
function observe(){
const d=frame.contentDocument,w=frame.contentWindow,all=(selector,parent=d)=>[...parent.querySelectorAll(selector)].filter(visible),one=(selector,parent=d)=>all(selector,parent)[0],css=element=>element?w.getComputedStyle(element):{},number=value=>parseFloat(value)||0;
const image=element=>{const img=element?.querySelector('img');return{src:img?.src||'',loaded:!!img?.complete&&img.naturalWidth>0&&img.naturalHeight>0,width:img?.naturalWidth||0,height:img?.naturalHeight||0};};
const product=one('.combination-products');
return{loaded,observedAt:Date.now(),href:w.location.href,nativeWindowTop:one('.uni-page-head')?.getBoundingClientRect().height||0,width:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,scrollTop:Math.max(w.scrollY,...all('uni-page-body,uni-page-wrapper').map(element=>element.scrollTop||0)),text:text(d.body),errors:[...errors],
renderers:all('.diy-renderer').length,legacySearchHeaders:all('.diy-search').length,footers:all('.diy-page-foot').map(text),searchValue:one('.search-input input')?.value||one('input.search-input')?.value||'',
schemaCache:Object.keys(localStorage).filter(key=>key.startsWith('cinashop_diy_page_v1_')).sort().map(key=>{let entry=JSON.parse(localStorage.getItem(key));if(entry&&entry.type==='string')entry=JSON.parse(entry.data);else if(entry&&entry.type==='object')entry=entry.data;return{id:key.replace('cinashop_diy_page_v1_',''),entry};}),
products:product?{category:product.dataset.category,children:all('.combination-child',product).map(element=>element.dataset.category),child:one('.combination-child.selected',product)?.dataset.category||'',ids:all('.diy-list-product',product).map(element=>element.dataset.productId),images:all('.diy-list-product',product).map(element=>({id:element.dataset.productId,...image(one('.list-image',element)),labels:all('.list-label',element).map(image)})),loading:!!one('.combination-status[role="status"]',product),error:text(one('.combination-status[role="alert"]',product)),more:!!one('.combination-more',product),text:text(product)}:null,
widgets:all('.diy-media-carousel').map(element=>{const canvas=one('.carousel-canvas',element),swiper=one('.carousel-swiper',canvas),slides=one('.uni-swiper-slides',swiper),dots=one('.carousel-dots',canvas),background=one('.carousel-background',element),header=one('.combination-search-header',element),wrapper=css(element),first=one('.carousel-slide image,.carousel-slide uni-image',canvas),corners=css(first),category=one('.combination-category',element),images=all('.carousel-slide image,.carousel-slide uni-image',canvas).map(image);
return{key:element.dataset.componentKey,kind:element.dataset.kind,index:Number(element.dataset.index),state:canvas?.dataset.state||'',height:Number(canvas?.dataset.height),canvasWidth:canvas?.getBoundingClientRect().width||0,wrapperWidth:element.getBoundingClientRect().width,wrapperHeight:element.getBoundingClientRect().height,
images,expectedMargin:w.rpx2px(element.dataset.kind==='swipers'?28:element.dataset.kind==='swiperBg'?(element.dataset.componentKey==='713'?55:0):(element.dataset.componentKey==='721'?10:50)),marginTop:number(wrapper.marginTop),paddingLeft:number(wrapper.paddingLeft),paddingTop:number(wrapper.paddingTop),paddingBottom:number(wrapper.paddingBottom),previous:number(css(slides).left),next:number(css(slides).right),slidePadding:number(css(one('.carousel-slide',canvas)).paddingLeft),radii:['borderTopLeftRadius','borderTopRightRadius','borderBottomRightRadius','borderBottomLeftRadius'].map(key=>number(corners[key])),stacked:all('.stacked',canvas).length,swipers:all('.carousel-swiper',canvas).length,
indicator:dots?[...dots.classList].find(value=>value.startsWith('indicator-')):'',dotPosition:css(dots).justifyContent||'',dots:all('.carousel-dot',canvas).map(dot=>({selected:dot.classList.contains('selected'),width:number(css(dot).width),height:number(css(dot).height),color:css(dot).backgroundColor})),progress:!!one('.carousel-progress',canvas),backgroundColor:css(background).backgroundColor||'',backgroundHeight:background?.getBoundingClientRect().height||0,
logoLoaded:image(one('.combination-logo',element)).loaded,logoSrc:image(one('.combination-logo',element)).src,backgroundLoaded:image(one('.combination-background',element)).loaded,backgroundSrc:image(one('.combination-background',element)).src,
tabIndices:all('.combination-tab',element).map(tab=>Number(tab.dataset.tabIndex)),tabTitles:all('.combination-tab',element).map(text),tabIds:all('.combination-tab',element).map(tab=>tab.id),tabGap:number(css(one('.combination-tab',element)).marginRight),selectedTab:Number(one('.combination-tab.selected',element)?.dataset.tabIndex||0),categoryOpen:!!category,categoryIndices:all('.combination-category-item',element).map(tab=>Number(tab.dataset.tabIndex)),categoryBackground:css(category).backgroundImage||'',categoryTop:one('.combination-category-mask',element)?.getBoundingClientRect().top||0,categoryCloseHit:(()=>{const target=one('.combination-category-heading uni-button,.combination-category-heading button',element);if(!target)return false;const r=target.getBoundingClientRect();return target.contains(d.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})(),fixed:header?.classList.contains('fixed')||false,searchPosition:css(header).position||'',searchTop:header?.getBoundingClientRect().top||0,searchHit:(()=>{const target=one('.combination-search',element);if(!target)return false;const r=target.getBoundingClientRect();return target.contains(d.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()};})};}
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{button.disabled=true;try{
 const name=button.dataset.stage,state=await(await fetch('${control}/state')).json();
 if(!loaded||state.pending!==0)throw Error('Wait actual iframe load and every pending API response before checkpoint');
 await new Promise(done=>frame.contentWindow.requestAnimationFrame(()=>frame.contentWindow.requestAnimationFrame(done)));
 if(name==='rotated'){const until=Date.now()+10000;while(Number(frame.contentDocument.querySelector('[data-component-key="702"]')?.dataset.index||0)<=0){if(Date.now()>until)throw Error('Wait actual autoplay to leave index0; no synthetic change is allowed');await new Promise(done=>frame.contentWindow.requestAnimationFrame(done));}}
 const data=observe();
 const destination=['legacyDestination','articleDestination','searchDestination','rootFixedDestination','microFixedDestination'].includes(name),closed=['closed','closedRetry'].includes(name),category=['categoryFailed','categoryRetry','categoryPage2','childChanged','childRenewed','owner22Category','microCategoryFromMicro','microCategoryPage2'].includes(name);
 if(!destination&&!closed&&(data.widgets.some(widget=>widget.state!=='ready'||widget.images.length!==3||widget.images.some(img=>!img.loaded)||widget.kind==='homeComb'&&(!widget.logoLoaded||!widget.backgroundLoaded))||data.widgets.length!==(category?2:7)))throw Error('Wait every positive canvas and all natural slide images; empty DOM is not loaded');
 if(category&&(!data.products||data.products.loading||name!=='categoryFailed'&&!data.products.ids.length))throw Error('Wait category/child request and its positive cards');
 const response=await fetch('${control}/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),result=await response.json();document.querySelector('#result').textContent=JSON.stringify({...result,instruction:instructions[result.next]});
}catch(error){document.querySelector('#result').textContent=String(error);}finally{button.disabled=false;}};
document.querySelector('#result').textContent=JSON.stringify({next:'home',instruction:instructions.home});
</script>`;
    server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, shell());
      if (path === control + '/state' && req.method === 'GET') return json(res, { pending, next: stage(), checked: evidence.map(row => row.stage) });
      if (path === control + '/configure' && req.method === 'POST') return configure(req, res);
      if (path.startsWith(control + '/') && req.method === 'POST') return checkpoint(req, res, path.slice(control.length + 1));
      if (req.method === 'GET' && Object.hasOwn(chrome, path)) return synthetic(req, res, url, chrome[path], 'unrelated application chrome');
      if (req.method === 'GET' && ['legacyDestination', 'articleDestination'].includes(stage()) && /^\/api\/article\/(list|category|hot|banner)/u.test(path)) return synthetic(req, res, url, [], 'registered article-list destination');
      if (req.method === 'GET' && ['searchDestination','rootFixedDestination','microFixedDestination'].includes(stage()) && path === '/api/search/hot_keyword' && !f.tables.includes('store_product_words')) return synthetic(req, res, url, [], 'missing-table search destination hot-keyword chrome; search products real');
      if (path.startsWith('/api/')) return api(req, res, url);
      if (path === '/favicon.ico') return send(res, '', 204);
      expect(req.method).toBe('GET'); const target = resolve(build, '.' + decodeURIComponent(path));
      if (target !== build && !target.startsWith(build + sep)) return send(res, 'Owned build only', 403);
      try { if (target !== build && (await stat(target)).isFile()) { staticPaths.add(path); return send(res, extname(target)==='.html'?await ownedIndex():await readFile(target), 200,
        ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Row)[extname(target)] ?? 'application/octet-stream'); } } catch {}
      return send(res, await ownedIndex());
    })().catch(error => { fail(error instanceof Error ? error : Error(String(error))); if (!res.headersSent) send(res, String(error), 500); else res.destroy(); }); });
    await new Promise<void>((yes, no) => { server!.once('error', no); server!.listen(40771, '127.0.0.1', yes); });
    await writeFile(prefix + 'ready.json', JSON.stringify({ url: origin + control, plans, instructions, sourceHashes: beforeHashes,
      artifactHashes: beforeBuild, setup, selectors: { instance: '[data-component-key="701|702|711|712|713|721|722"]',
        tabs: '[data-component-key="721"] .combination-tab[data-tab-index="0|1|2"]', expand: '[data-component-key="721"] .combination-expand',
        dropdown: '[data-component-key="721"] .combination-category-item[data-tab-index="1"]', retry: '.combination-status uni-button',
        more: '.combination-more', child752: '.combination-child[data-category="752"]', category: '.combination-products' },
      limitations: 'Served HTML contains explicit hidden-native-scrollbar fixture CSS; raw built files/JS/CSS unchanged. Two homeComb are imported multi-instance stress beyond PHP Admin single-header editor. Controls only set initial/fresh iframe auth, viewport, real configuration and observation; app interactions use actual iframe UI. External slide replaced through two real setup Admin-controller saves, no external I/O. Search products request uses real API and preserves actual missing-user_search error; only route/input accepted, results/history persistence excluded, no search-read-only claim. Error listeners start at iframe load; operator must also inspect startup console and record known VueRouter warnings separately.' }, null, 2) + '\n');
    process.stdout.write('DIY_CAROUSEL_BROWSER_READY ' + origin + control + '\n');
    deadline = setTimeout(() => fail(Error('Owned Browser acceptance incomplete within sixty-minute operator window')), 60 * 60_000);
    await completion;
  } finally {
    await writeFile(prefix + 'partial.json', JSON.stringify({ stages: evidence.map(row => row.stage), lastObservation, evidence, traces, configs, setup,
      initial_snapshot: initial, expected_snapshot: expected, storage: storage(), source_before: beforeHashes, build_before: beforeBuild }, null, 2) + '\n');
    if (deadline) clearTimeout(deadline); server?.closeAllConnections();
    if (server?.listening) await new Promise<void>(yes => server!.close(() => yes()));
    external.mockRestore(); wiring.container = undefined; await f.close();
    await writeFile(prefix + 'cleanup.json', JSON.stringify({ http_server_stopped: !server?.listening, fixture_close_completed: true,
      provider_spy_restored: true, wiring_cleared: true, completed_stages: evidence.map(row => row.stage),
      pg_process_and_remaining_owned_relations: 'Validated by the outer native runner cleanup receipt; not inferred from fixture.close' }, null, 2) + '\n');
  }
}, 61 * 60_000);
