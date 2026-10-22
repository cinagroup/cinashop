import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeProduct, storeProductCategory, storeProductRelation } from '@/models/schema';
import { diyNavigationFixture } from '../helpers/diyNavigationFixture';
import { sortedDiyState, stableDiyState, type DiyStateRow as Row } from '../helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned navigation SQL');
  return wiring.container;
} }));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let length = 0;
  // Observations include two full schema caches plus600 authored menu rows;
  // this is an owned control-plane bound, not a production request-body change.
  for await (const value of req) { const chunk = Buffer.from(value); length += chunk.length; expect(length).toBeLessThan(2_000_000); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]))).flat().sort();
}

it('actual built navigation H5 uses owned catalogue, public media, both page callers and real Admin configuration', async () => {
  const f = await diyNavigationFixture(); wiring.container = f.container;
  const app = createApp(), repository = resolve(import.meta.dirname, '../../..');
  const origin = 'http://127.0.0.1:40771', control = '/__navigation/' + randomUUID();
  const prefix = '/tmp/cinashop-diy-navigation-browser-', build = resolve(repository, 'view/uniapp-ts/dist/build/h5');
  const keyword = '导航输入A&B 中文';
  const plans = ['home','menuSecond','menuTailDestination','afterMenuTail','cubeDestination','afterCube','headerSearchDestination','afterSearch',
    'rootFixed','microSelected','homeSelected','categoryFailed','categoryRetry','categoryPage2','childChanged','owner22Home','owner22Category',
    'microCaller','microSelectedFromMicro','microCategoryFromMicro','microHome','headerTitle','titleDestination','afterTitle','headerCentered',
    'headerButton','headerText','closed','closedRetry','reopened','finished'];
  const traces: Row[] = [], evidence: Row[] = [], configs: Row[] = [], setup: Row[] = [], staticPaths = new Set<string>();
  const browserErrors: Row[] = [], servedHtml: Row[] = []; let lastObservation: Row | undefined, failedCategory = false, changed = false, pending = 0, headerPhase = 0;
  let server: Server | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned navigation acceptance forbids external provider I/O'));
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
  const normalBlocks = () => structuredClone(f.blocks).filter(row => !['headerSerch','tabNav'].includes(row.name) || [801,811].includes(row.timestamp))
    .sort((left, right) => (left.name === 'headerSerch' ? 0 : left.name === 'tabNav' ? 1 : 2) - (right.name === 'headerSerch' ? 0 : right.name === 'tabNav' ? 1 : 2));
  const blocks: Record<number, Row[]> = { 1: normalBlocks(), 2: normalBlocks() };
  let beforeHashes: Row[] = [], beforeBuild: Row[] = [];
  const sources = async () => {
    const selected = ['workers-ts/test/browser/diy-navigation.acceptance.ts', 'workers-ts/vitest.diy-navigation-browser.config.ts', 'workers-ts/package.json', 'workers-ts/package-lock.json',
      'view/uniapp-ts/package.json', 'view/uniapp-ts/package-lock.json', 'view/uniapp-ts/vite.config.ts',
      'workers-ts/scripts/run-local-finance-postgres.mjs', 'workers-ts/test/helpers/diyNavigationFixture.ts', 'workers-ts/test/helpers/diyCarouselFixture.ts', 'workers-ts/test/helpers/diyEditorialFixture.ts',
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
    for (const block of value) {
      if (block.name === 'headerSerch') strip(block.logoConfig, 'url');
      if (block.name === 'menus') for (const item of block.menuConfig.list) strip(item, 'img');
      if (block.name === 'pictureCube') {
        for (const item of block.picStyle.picList) strip(item, 'image');
        if (block.styleConfig.tabVal === 11 || block.styleConfig.tabVal === '11') for (const item of block.picStyle.docPicList) strip(item, 'img');
      }
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
    await f.db.insert(storeProduct).values(newIds.map((id, i) => ({ id, storeName: `真实轮播分页商品${id}`, image: '/static/logo.png',
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
      inserted_products: newIds, first_scope: { cid: 701, sid: 751, ids: firstIds }, second_scope: { cid: 701, sid: 752, ids: secondIds },
      inserted_relations: catalogue.store_product_relation.filter(row => row.id >= 9500), existing_product_sort_only: [601, 611, 602], sequence_delta: 0,
      table_before: Object.fromEntries(['store_product_category', 'store_product_relation', 'store_product'].map(name => [name, expected[name]])),
      table_after: Object.fromEntries(['store_product_category', 'store_product_relation', 'store_product'].map(name => [name, catalogue[name]])) });
    expected = catalogue;
    for (const id of [1, 2] as const) {
      expect(blocks[id].slice(0,2).map(row => row.name)).toEqual(['headerSerch','tabNav']);
      // Distinct initial footers prove that selecting target body never adopts
      // the target schema's footer; the original caller owns its footer.
      blocks[id].push({ name: 'pageFoot', timestamp: 990 + id, menuList: [{ name: id === 1 ? '原始首页页脚旁观' : '原始微页页脚保留',
        link: '/pages/article/list', imgList: ['/static/logo.png'] }] });
      for (const block of blocks[id]) {
        if (block.name === 'menus') {
          block.menuConfig.list = Array.from({length:100}, (_, index) => ({img:index%2?'/static/logo.png':f.platformImage.url,
            show:block.timestamp!==822 || index>=3,info:[{title:'标题',value:`导航${index}`,max:4},
              {title:'链接',value:index===99?'/pages/article/list?navigation_tail=99':'/pages/article/list',max:100}]}));
          if (block.timestamp===822) {block.rowsNum.tabVal=0;block.number.tabVal=0;}
        }
        if (block.name === 'pictureCube') for (const list of [block.picStyle.picList,block.picStyle.docPicList]) for (const item of list) {
          const key=Object.hasOwn(item,'image')?'image':'img'; if(item[key]==='https://images.example.test/navigation.png')item[key]='/static/logo.png';
          item.link=block.timestamp===852?'/pages/article/list?navigation_cube=11':'/pages/article/list';
        }
        if(block.name==='headerSerch') {block.hotWords.list=[{val:'不可作为关键词传递'},{val:'真实热词'}];block.linkConfig.value='/pages/article/list?navigation_title=1';}
        if(block.name==='titles') {block.titleConfig.value=id===1?'真实导航首页正文':'真实导航微页正文';block.timestamp=820;}
      }
      expect(blocks[id].map(row=>row.timestamp)).toEqual(blocks[id].map(row=>row.timestamp).slice().sort((left,right)=>Number(left)-Number(right)));
      await save(id, blocks[id], 'setup');
    }
    expect(storage()).toEqual(initialStorage);
    beforeHashes = await sources(); beforeBuild = await artifacts(); expect(beforeBuild.length).toBeGreaterThan(100);
    const preparedSnapshot = structuredClone(expected);
    const chrome: Row = { '/api/site_config': { site_name: '实际导航组件验收', site_logo: '', record_No: '', ico_path: '' },
      '/api/share': { title: '导航组件', synopsis: '', img: '' }, '/api/get_open_adv': { status: 0, time: 3, interval_time: 24, type: 'pic', value: [], video_link: '' },
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
        if (search) throw Error('Header search acceptance must stop at route/input; product search/history is outside this slice');
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
        if (payload) expect([200, 410010]).toContain(payload.status);
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
        const variants: Record<string, [number, number, number]> = { headerTitle: [1, 0, 1], headerCentered: [2, 0, 2], headerButton: [2, 1, 2], headerText: [2, 2, 2] };
        if (Object.hasOwn(variants, input.action)) {
          expect(stage()).toBe(input.action);
          const phase = ['headerTitle','headerCentered','headerButton','headerText'].indexOf(input.action) + 1;
          expect(phase).toBe(headerPhase + 1);
          const [style, variant, tab] = variants[input.action];
          for (const id of [1, 2] as const) {
            const next = structuredClone(blocks[id]), header = next.find(row => row.name === 'headerSerch')!, navigation = next.find(row => row.name === 'tabNav')!;
            header.styleConfig.tabVal = style; header.styleSearchConfig.tabVal = variant; header.titleConfig.value = '真实标题入口';
            navigation.styleConfig.tabVal = tab;
            next.find(row => row.name === 'titles')!.titleConfig.value = `真实导航${id === 1 ? '首页' : '微页'}正文配置${phase}`;
            await save(id, next, 'business-configuration'); blocks[id] = next;
          }
          headerPhase = phase; changed = true;
        } else {
          const closed = input.action === 'close'; expect(input.action).toBe(closed ? 'close' : 'open'); expect(stage()).toBe(closed ? 'closed' : 'reopened');
          const receipt = await f.setConfig('station_open', closed ? '0' : '1'), want = structuredClone(expected); expect(receipt.before).toEqual(expected);
          want.system_config = want.system_config.map(row => row.menu_name === 'station_open' && row.is_store === 0 ? { ...row, value: closed ? '0' : '1' } : row);
          expect(receipt.after).toEqual(sortedDiyState(want)); expected = receipt.after; f.cache.set('cfg_station_open', closed ? '1' : '0');
          configs.push({action: input.action, before: digest(receipt.before), after: digest(receipt.after), allowed: ['station_open'], deliberately_stale_kv: true});
        }
        expect(storage()).toEqual(initialStorage); json(res, {configured: input.action, next: stage()});
      });
    }
    const near = (actual: number, expectedValue: number, tolerance = .25) => expect(Math.abs(actual - expectedValue)).toBeLessThan(tolerance);
    const cubeCounts = [2,3,4,3,3,3,3,4,5,4,1,2];
    const rectangles: Record<number, number[][]> = {
      3:[[0,0,.5,.5],[.5,0,.5,.5],[0,.5,1,.5]], 4:[[0,0,1,.5],[0,.5,.5,.5],[.5,.5,.5,.5]],
      5:[[0,0,.5,1],[.5,0,.5,.5],[.5,.5,.5,.5]], 6:[[0,0,.5,.5],[0,.5,.5,.5],[.5,0,.5,1]],
      7:[[0,0,.5,.5],[.5,0,.5,.5],[0,.5,.5,.5],[.5,.5,.5,.5]],
      8:[[0,0,.5,.5],[.5,0,.5,.5],[0,.5,1/3,.5],[1/3,.5,1/3,.5],[2/3,.5,1/3,.5]],
      9:[[0,0,.5,1],[.5,0,.5,.5],[.5,.5,.25,.5],[.75,.5,.25,.5]],
    };
    function natural(image: Row) {
      expect(image.loaded).toBe(true); expect(image.width).toBeGreaterThan(0); expect(image.height).toBeGreaterThan(0);
      expect(image.src).not.toContain('images.example.test');
      if (image.src.includes(f.platformImage.url + '?')) {
        expect([image.width,image.height]).toEqual([Buffer.from(f.png).readUInt32BE(16),Buffer.from(f.png).readUInt32BE(20)]);
        const asset = new URL(image.src); expect(asset.origin).toBe(origin); expect(asset.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(Number(asset.searchParams.get('expires')) * 1000).toBeGreaterThan(Date.now() + 60_000);
      }
    }
    function styles(widget: Row, data: Row) {
      const block = blocks[data.href.includes('/pages/diy/detail') ? 2 : 1].find(row => String(row.timestamp) === widget.key)!;
      expect(block).toBeDefined(); expect(widget.width).toBeLessThan(376); expect(widget.width).toBeGreaterThan(0);
      const px = (rpx: number) => rpx * data.unit;
      if (widget.kind === 'headerSerch') {
        expect(widget.search).toBe(true); expect(widget.position).toBe('fixed'); near(widget.top,data.windowTop);expect(widget.searchHit).toBe(true);if(widget.title)expect(widget.titleHit).toBe(true);
        expect(widget.hotWords).toEqual(['不可作为关键词传递','真实热词']);
        expect(widget.logo).toBe(block.styleConfig.tabVal === 0); expect(widget.title).toBe(block.styleConfig.tabVal === 1 ? block.titleConfig.value : '');
        expect(widget.searchButton).toBe(block.styleConfig.tabVal === 2 && block.styleSearchConfig.tabVal === 1);
        expect(widget.searchText).toBe(block.styleConfig.tabVal === 2 && block.styleSearchConfig.tabVal === 2);
        expect(widget.centered).toBe(block.styleConfig.tabVal === 2 && block.styleSearchConfig.tabVal === 0);
        if (widget.logo) natural(widget.logoImage);
        near(widget.headerHeight,px(96+12+16)); near(widget.placeholderHeight,widget.headerHeight);
        near(widget.paddingTop,px(12)); near(widget.paddingLeft,px(20));
        expect(widget.background).toBe('rgb(234, 240, 247)'); expect(widget.gradient).toContain('rgb(234, 240, 247)');
        return;
      }
      if (widget.kind === 'tabNav') {
        expect(widget.tabs.map((row: Row) => row.label)).toEqual(['首页','真实微页','真实分类']); expect(new Set(widget.tabs.map((row: Row) => row.id)).size).toBe(3);
        expect(widget.style).toBe(block.styleConfig.tabVal); expect(widget.decorations).toBe(widget.style === 2 ? 0 : 1);
        const active = widget.tabs.find((row: Row) => row.selected); expect(active).toBeDefined();
        expect(active.color).toBe(widget.style === 0 ? 'rgb(55, 90, 127)' : widget.style === 1 ? 'rgb(36, 60, 84)' : 'rgb(255, 255, 255)');
        if (widget.style === 2) expect(active.background).toContain('rgb(55, 90, 127)');
        return;
      }
      expect(widget.canvas).toBe(true); expect(widget.canvasWidth).toBeLessThanOrEqual(widget.width);
      near(widget.paddingLeft,px(20)); near(widget.marginTop,px(14));
      if (widget.kind === 'menus') {
        expect(widget.authoredItems).toBe(100); expect(widget.columns).toBe(block.number.tabVal+3); expect(widget.paged).toBe(block.showConfig.tabVal === 1);
        expect(widget.images.length).toBe(block.menuStyleConfig.tabVal === 2 ? 0 : widget.key === '822' ? 97 : 100);
        widget.images.forEach(natural); expect(widget.labels.length).toBe(block.menuStyleConfig.tabVal === 1 ? 0 : widget.key === '822' ? 97 : 100);
        expect(widget.tailExists).toBe(true); if (block.menuStyleConfig.tabVal !== 1) expect(widget.tail).toContain('导航99');
        if (widget.paged) {
          expect(widget.pages.map((row: Row) => row.count).reduce((a: number,b: number) => a+b,0)).toBe(100);
          expect(widget.swiperHeight + .2).toBeGreaterThanOrEqual(Math.max(...widget.pages.map((row: Row) => row.height)));
          expect(widget.dots).toHaveLength(Math.ceil(100/((block.number.tabVal+3)*(block.rowsNum.tabVal+1))));
          expect(widget.dots.filter((row: Row) => row.color === 'rgb(55, 90, 127)')).toHaveLength(1);
          widget.dots.forEach((dot: Row) => { near(dot.width,px(20)); near(dot.height,px(6)); });
        } else expect(widget.pages).toHaveLength(1);
        return;
      }
      const style = block.styleConfig.tabVal; expect(widget.style).toBe(style); expect(widget.cells).toHaveLength(cubeCounts[style]);
      widget.images.forEach(natural); expect(widget.images).toHaveLength(cubeCounts[style]);
      widget.cells.forEach((cell: Row) => { near(cell.border,px(8)); expect(cell.width).toBeGreaterThan(0); expect(cell.height).toBeGreaterThan(0); });
      if (style === 0) widget.cells.forEach((cell: Row) => near(cell.height,data.windowWidth/2+2*cell.border));
      if (style === 1 || style === 2) {
        const image = widget.images[0]; widget.cells.forEach((cell: Row) => { near(cell.width,widget.panelWidth/cubeCounts[style]); near(cell.height,px((style===1?375:230)*image.height/image.width)+2*cell.border); });
      }
      if (rectangles[style]) rectangles[style].forEach((rect,index) => {
        const cell=widget.cells[index]; near(cell.left,widget.panelWidth*rect[0]); near(cell.top,widget.panelHeight*rect[1]); near(cell.width,widget.panelWidth*rect[2]); near(cell.height,widget.panelHeight*rect[3]);
      });
      if (style === 10) near(widget.cells[0].height,data.windowWidth*widget.images[0].height/widget.images[0].width+2*widget.cells[0].border);
      if (style === 11) widget.cells.forEach((cell: Row,index: number) => { near(cell.left,px(index*300)); near(cell.top,0); near(cell.width,px(300)); near(cell.height,px(240)); });
      if (style >= 3 && style <= 9 || style === 11) near(widget.panelHeight,data.windowWidth);
    }
    const categoryStages = ['categoryFailed','categoryRetry','categoryPage2','childChanged','owner22Category','microCategoryFromMicro'];
    const microStages = ['microSelected','homeSelected','microSelectedFromMicro','microHome'];
    const destinations = ['menuTailDestination','cubeDestination','headerSearchDestination','titleDestination'];
    async function checkpoint(req: IncomingMessage, res: ServerResponse, name: string) {
      return serial(async () => {
        expect(name).toBe(stage()); expect(pending).toBe(0); const data = JSON.parse((await body(req)).toString());
        lastObservation={stage:name,data}; const slice=traces.slice(evidence.at(-1)?.traceCount??0);
        expect(await f.snapshot()).toEqual(expected); expect(storage()).toEqual(initialStorage); expect(external).not.toHaveBeenCalled();
        expect(data.loaded).toBe(true); expect(data.width).toBe(375); expect(data.scrollWidth).toBeLessThanOrEqual(375); expect(data.errors).toEqual([]);
        expect(data.text).not.toMatch(/Internal Server Error|Failed to resolve|Cannot read properties/u);
        if (destinations.includes(name)) {
          expect(data.widgets).toHaveLength(0);
          if(name==='headerSearchDestination') {
            expect(data.href).toContain('/pages/goods/search'); expect(data.href).not.toMatch(/searchVal|keyword=/u); expect(data.searchValue).toBe(keyword);
            expect(slice.filter(row=>row.search)).toEqual([]);
          } else {
            expect(data.href).toContain('/pages/article/list');
            expect(data.href).toContain(name==='menuTailDestination'?'navigation_tail=99':name==='cubeDestination'?'navigation_cube=11':'navigation_title=1');
            expect(slice.some(row=>row.synthetic&&row.scope==='registered article-list destination')).toBe(true);
          }
        } else if (['closed','closedRetry'].includes(name)) {
          expect(data.widgets).toHaveLength(0); expect(data.products).toBeNull(); expect(data.footers).toEqual([]); expect(data.text).toContain('站点升级中，请稍候访问');
          expect(slice.some(row=>row.path==='/api/diy/diy_version/0'&&row.status===410010)).toBe(true);
          expect(slice.some(row=>/^\/api\/diy\/get_diy\//u.test(row.path))).toBe(false); expect(slice.filter(row=>row.scoped)).toEqual([]);
        } else {
          const id=data.href.includes('/pages/diy/detail')?2:0,cache=data.schemaCache.find((row:Row)=>row.id===String(id));
          expect(cache).toBeDefined(); expect(cache.entry.versionVerified).toBe(true); expect(cache.entry.version).toBe(expected.system_dise.find(row=>row.id===(id===0?1:2))!.version);
          expect(canonical(cache.entry.data.value)).toEqual(blocks[id===0?1:2].filter(row=>id!==0||row.name!=='pageFoot'));
          expect(JSON.stringify(cache.entry)).not.toMatch(/cart_num|now_money|couponUserId/u);
          const category=categoryStages.includes(name),micro=microStages.includes(name);
          expect(data.widgets.map((row:Row)=>row.key).sort()).toEqual((category?[801,811]:[801,811,821,822,823,824,825,826,841,842,843,844,845,846,847,848,849,850,851,852]).map(String).sort());
          data.widgets.forEach((widget:Row)=>styles(widget,data));
          expect(data.renderers).toBe(micro?2:1); expect(data.footers).toEqual(id===2?['原始微页页脚保留']:[]); expect(data.text).not.toContain('原始首页页脚旁观');
          const tab=data.widgets.find((row:Row)=>row.kind==='tabNav');
          expect(tab.tabs.find((row:Row)=>row.selected).index).toBe(category?2:['microSelected','microSelectedFromMicro'].includes(name)?1:0);
          if(micro) expect(data.text).toContain(['microSelected','microSelectedFromMicro'].includes(name)?'真实导航微页正文':'真实导航首页正文');
          if(name==='rootFixed') {expect(data.scrollTop).toBeGreaterThan(50); expect(tab.fixed).toBe(true);near(tab.top,data.windowTop+data.widgets.find((row:Row)=>row.kind==='headerSerch').headerHeight+14*data.unit);}
          if(name==='menuSecond') {const menu=data.widgets.find((row:Row)=>row.key==='822');expect(menu.currentPage).toBe(1);expect(menu.pages[0].visible).toBe(0);expect(menu.pages[1].visible).toBe(3);expect(menu.swiperHeight+.2).toBeGreaterThanOrEqual(menu.pages[1].height);}
          if(category) {
            const product=data.products; expect(product).not.toBeNull(); expect(product.category).toBe('701');expect(product.children).toEqual(['751','752']);expect(product.loading).toBe(false);
            expect(product.child).toBe(name==='childChanged'?'752':'751');
            if(name==='categoryFailed') {expect(product.ids).toEqual([]);expect(product.error).toContain('本地验收：此分类读取失败');expect(slice.filter(row=>row.injected)).toHaveLength(1);}
            else {expect(product.error).toBe('');const ids=name==='childChanged'?secondIds:name==='categoryPage2'?firstIds:firstIds.slice(0,10);expect(product.ids.map(Number).sort((a:number,b:number)=>a-b)).toEqual(ids.slice().sort((a,b)=>a-b));expect(product.more).toBe(!['categoryPage2','childChanged'].includes(name));}
            if(name==='categoryRetry') {expect(slice.filter(row=>row.scoped)).toHaveLength(1);expect(slice.some(row=>row.path==='/api/category')).toBe(false);expect(data.widgets).toEqual(evidence.at(-1)!.widgets);}
            if(name==='categoryPage2') {const reads=slice.filter(row=>row.scoped);expect(reads).toHaveLength(1);expect(new URLSearchParams(reads[0].query).get('page')).toBe('2');}
            if(name==='childChanged') {const reads=slice.filter(row=>row.scoped);expect(reads).toHaveLength(1);expect(new URLSearchParams(reads[0].query).get('sid')).toBe('752');}
            if(name==='owner22Category') {const reads=slice.filter(row=>row.scoped);expect(reads.length).toBeGreaterThan(0);expect(reads.every(row=>row.requestOwner===22)).toBe(true);expect(reads.flatMap(row=>row.material.list).find((row:Row)=>row.id===601)).toMatchObject({id:601,cart_num:4});}
          } else expect(data.products).toBeNull();
          if(['headerTitle','headerCentered','headerButton','headerText'].includes(name)) {
            expect(changed).toBe(true);expect(data.text).toContain(`真实导航首页正文配置${headerPhase}`);
            expect(slice.some(row=>row.path==='/api/diy/get_diy/0'&&!row.synthetic&&row.status===200)).toBe(true);
            const prior=evidence.find(row=>row.stage==='home')!;expect(data.widgets.find((row:Row)=>row.key==='841').images[0].src).not.toBe(prior.widgets.find((row:Row)=>row.key==='841').images[0].src);
          }
        }
        browserErrors.push(...data.errors);evidence.push({stage:name,...data,traceCount:traces.length,database:digest(expected),pending_at_checkpoint:pending});
        if(name==='finished') {
          expect(configs).toHaveLength(10);expect(setup.filter(row=>row.phase==='setup')).toHaveLength(2);expect(failedCategory).toBe(true);expect(headerPhase).toBe(4);
          const afterHashes=await sources(),afterBuild=await artifacts();expect(afterHashes).toEqual(beforeHashes);expect(afterBuild).toEqual(beforeBuild);
          await writeFile(prefix+'evidence.json',JSON.stringify({status:'passed-all-31-checkpoints',evidence,traces,configs,setup,
            environment:{node:process.version,executable:process.execPath,versions:process.versions},tables:f.tables,sequences:f.sequences,
            initial_snapshot:initial,prepared_snapshot:preparedSnapshot,final_snapshot:expected,initial_storage:initialStorage,final_storage:storage(),
            source_hashes:{before:beforeHashes,after:afterHashes},h5_artifact_hashes:{before:beforeBuild,after:afterBuild},static_paths:[...staticPaths].sort(),
            served_html_transport:servedHtml,viewport_boundary:'Owned bridge injects only hidden native scrollbar viewport CSS before H5 bootstrap. Raw built index/JS/CSS remain byte-identical; served HTML augmentation is explicitly hashed and is not described as unmodified raw HTML.',providerCalls:0,navigationAcceptedReadSqlBusinessWrites:0,r2BusinessWrites:0,queueBusinessWrites:0,browserErrors,
            search_destination_boundary:{route_and_input:'accepted; no hot-word query adoption',product_results:'not verified',search_history_persistence:'not verified; no submitted search and no read-only claim'},
            operator_screenshots_and_startup_console:'Root-owned CUA receipt records returned screenshot bytes/inline outputs and startup console against these exact source/build hashes. Local screenshot files are linked only if a tool actually returns them; post-load iframe listeners alone do not prove startup console.',
            limitations:'Actual built H5 JS/CSS/createApp/JWT/owned PG16; served index adds only explicitly recorded fixture viewport scrollbar CSS, raw/served HTML hashes retained; each accepted real GET compares50tables/46sequences and R2/IMAGES/queue state. Catalogue setup and two initial Admin saves are explicit setup. Four later header/tab configuration batches each save both rows through actual Admin parser/controller/transaction; station close/open are the other allowed configuration writes. The fixture-only Admin host does not prove production Admin auth/ACL. Each configuration has exactly one real search header and one tab; six menu variants and all12 cubes are normal repeatable editor components. Synthetic unrelated chrome and registered article-list/hot-keyword destination chrome are tagged and are not business DTO proofs. Legacy exact page1/limit8 products use real API. Search only opens its actual route and accepts manual text input, without submitting or claiming product/history persistence or search GET read-only. Original micro footer is retained through micro/category/home0 selection, root never adopts a target footer. Internal HTTPS Request over owned HTTP loopback is a transport bridge, not TLS acceptance. Long840s renewal uses Node fakeclock; Browser proves fresh tickets after real Admin versions. No physical MP/App, touch-swipe gesture, production, Windows, provider, cart/poster/album mutation or PHP execution is claimed.'},null,2)+'\n');done();
        }
        json(res,{checked:evidence.map(row=>row.stage),next:stage()});
      });
    }
    const instructions: Row = {
      home:'Warm-load 实际首页11, set375内容区 from actual scrollbar, reload 实际首页11 before acceptance, wait one header/one tab, six menus with100 authored items and all12 cubes/natural images, then checkpoint.',
      menuSecond:'Click actual822 second page dot data-page-index=1. Wait page transition and images; first page has3hidden, second3visible; later page must fit its own swiper.',
      menuTailDestination:'Click actual fixed menu821 item data-item-index=99; wait article destination navigation_tail=99.',
      afterMenuTail:'Load 实际首页11; wait all20 widgets and all positive natural images.',
      cubeDestination:'Click actual custom cube852 cell0 only after its image loaded; wait article destination navigation_cube=11.',
      afterCube:'Load 实际首页11; wait all20 widgets/images.',
      headerSearchDestination:'Click actual header801 search. Confirm no adopted hot-word query. Type 导航输入A&B 中文 into actual search input without submitting; checkpoint route/input only.',
      afterSearch:'Load 实际首页11; wait all20 widgets/images.',
      rootFixed:'Scroll actual page down >50px; tab811 must be fixed immediately below measured search header.',
      microSelected:'Click actual tab811 data-tab-index=1; wait selected micro2, retained single root search/tab and stripped child header/tab/footer, all18 body widgets loaded.',
      homeSelected:'Click actual tab0; wait version-verified cached/fresh selected home0 body, retained original search/tab and no target footer.',
      categoryFailed:'Click actual tab2; wait real category and first scoped products request surfaced503. Do not reload.',
      categoryRetry:'Click actual 重试当前分类 only; wait first10 cards and positive loaded images.',
      categoryPage2:'Click actual 加载更多 or trigger page reach-bottom once; wait13 cards/no more.',
      childChanged:'Click actual child752; wait2 real cards and no more.',
      owner22Home:'Load 实际首页22; wait all20 widgets/images.',
      owner22Category:'Click actual tab2; wait751 first10, real product601 cart_num4 and no owner11 data.',
      microCaller:'Load 实际微页面11; wait one header/one tab, all18 body widgets and exactly original micro footer.',
      microSelectedFromMicro:'Click tab1; wait selected micro2 body while retaining original micro caller search/tab/footer exactly once.',
      microCategoryFromMicro:'Click tab2; wait751 first10 real cards and original micro footer.',
      microHome:'Click tab0; wait selected root body, original micro header/tab/footer retained, target root footer absent.',
      headerTitle:'Click 配置标题, then 实际首页11. Wait real Admin save versions/new media and header style1/title plus tab style1.',
      titleDestination:'Click actual 真实标题入口; wait article navigation_title=1, not search.',
      afterTitle:'Load 实际首页11 and wait all20 widgets/images.',
      headerCentered:'Click 配置居中, then 实际首页11. Wait header style2/searchVariant0 centered and tab pill style2.',
      headerButton:'Click 配置按钮, then 实际首页11. Wait actual colored search button variant1.',
      headerText:'Click 配置文字, then 实际首页11. Wait actual text search action variant2.',
      closed:'Click 关闭站点 then 实际首页11. Wait real version410010, zero component/scoped products.',
      closedRetry:'Click actual page 重新加载首页; wait fresh closed response, no get_diy.',
      reopened:'Click 开启站点, then actual 重新加载首页; wait all20 positive widgets/natural images.',
      finished:'Final stable checkpoint; verifies complete source/H5 identity,31stages, ten explicit config writes and zero accepted-read SQL/R2/queue writes.'
    };
    async function ownedIndex() {
      const raw = await readFile(resolve(build,'index.html')), original = raw.toString(), viewport = '<style data-owned-acceptance-viewport>html{scrollbar-width:none!important}</style>';
      expect(original).toContain('</head>'); const augmented = original.replace('</head>',viewport+'</head>');
      servedHtml.push({raw_sha256:hash(raw),served_sha256:hash(augmented),raw_bytes:raw.length,served_bytes:Buffer.byteLength(augmented),fixture_only_style:viewport,app_JS_CSS_unchanged:true});
      return augmented;
    }
    const shell=()=>`<!doctype html><meta charset="utf-8"><title>DIY导航后台验收</title>
<style>body{font:13px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:375px;height:830px}pre{max-height:100px;overflow:auto;white-space:pre-wrap}</style>
<h1>真实导航四族与12魔方</h1><button data-route="home">实际首页11</button><button data-route="micro">实际微页面11</button><button data-route="other">实际首页22</button><button data-size>375内容区</button>
<button data-config="headerTitle">配置标题</button><button data-config="headerCentered">配置居中</button><button data-config="headerButton">配置按钮</button><button data-config="headerText">配置文字</button><button data-config="close">关闭站点</button><button data-config="open">开启站点</button>
${plans.map(name=>'<button data-stage="'+name+'">'+name+'</button>').join('')}<pre id="result"></pre><iframe title="实际导航页面" scrolling="yes"></iframe>
<script>
const frame=document.querySelector('iframe'),token=${JSON.stringify(f.token)},other=${JSON.stringify(f.otherToken)},instructions=${JSON.stringify(instructions)};
for(const key of Object.keys(localStorage))if(key.startsWith('cinashop_diy_page_v1_'))localStorage.removeItem(key);
let loaded=false,errors=[];
frame.onload=()=>{loaded=true;const w=frame.contentWindow;w.addEventListener('error',event=>errors.push({kind:'error',message:String(event.message)}));w.addEventListener('unhandledrejection',event=>errors.push({kind:'unhandledrejection',message:String(event.reason)}));};
for(const button of document.querySelectorAll('[data-route]'))button.onclick=()=>{loaded=false;errors=[];localStorage.setItem('uni_token',JSON.stringify({type:'string',data:button.dataset.route==='other'?other:token}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:button.dataset.route==='other'?22:11}));frame.src='/?navigation_session='+Date.now()+'#'+(button.dataset.route==='micro'?'/pages/diy/detail?id=2':'/pages/index/index');};
document.querySelector('[data-size]').onclick=()=>{frame.style.width=(375+frame.contentWindow.innerWidth-frame.contentDocument.documentElement.clientWidth)+'px';};
for(const button of document.querySelectorAll('[data-config]'))button.onclick=async()=>{button.disabled=true;try{const response=await fetch('${control}/configure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:button.dataset.config})});document.querySelector('#result').textContent=JSON.stringify(await response.json());}finally{button.disabled=false;}};
const visible=element=>{if(!element)return false;for(let parent=element;parent;parent=parent.parentElement){const css=frame.contentWindow.getComputedStyle(parent);if(css.display==='none'||css.visibility==='hidden')return false;}return true;};
const text=element=>visible(element)?element.textContent.trim().replace(/\\s+/g,' '):'';
function observe(){
const d=frame.contentDocument,w=frame.contentWindow,raw=(selector,parent=d)=>[...parent.querySelectorAll(selector)],all=(selector,parent=d)=>raw(selector,parent).filter(visible),one=(selector,parent=d)=>all(selector,parent)[0],css=element=>element?w.getComputedStyle(element):{},number=value=>parseFloat(value)||0,rect=element=>element?.getBoundingClientRect()||{top:0,left:0,width:0,height:0};
const image=element=>{const img=element?.querySelector('img');return{src:img?.src||'',loaded:!!img?.complete&&img.naturalWidth>0&&img.naturalHeight>0,width:img?.naturalWidth||0,height:img?.naturalHeight||0};};
const product=one('.combination-products');const hit=element=>{if(!element)return false;const r=rect(element),target=d.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !!target&&element.contains(target);};
return{loaded,href:w.location.href,windowTop:rect(one('.uni-page-head')).height,width:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,windowWidth:(()=>{const screenWidth=/^Apple/.test(w.navigator.vendor)&&typeof w.orientation==="number"?Math[Math.abs(w.orientation)===90?"max":"min"](w.screen.width,w.screen.height):w.screen.width;return Math.min(w.innerWidth,d.documentElement.clientWidth,screenWidth)||screenWidth;})(),windowMetrics:{innerWidth:w.innerWidth,clientWidth:d.documentElement.clientWidth,screenWidth:w.screen.width,viewportSetup:"owned iframe scrolling=yes; actual scrollbar calibrated and375content set before accepted bootstrap"},unit:number(css(one('.navigation-header')).paddingLeft)/20,scrollTop:Math.max(w.scrollY,...all('uni-page-body,uni-page-wrapper').map(element=>element.scrollTop||0)),text:text(d.body),errors:[...errors],renderers:all('.diy-renderer').length,footers:all('.diy-page-foot').map(text),searchValue:one('.search-input input')?.value||one('input.search-input')?.value||'',
schemaCache:Object.keys(localStorage).filter(key=>key.startsWith('cinashop_diy_page_v1_')).sort().map(key=>{let entry=JSON.parse(localStorage.getItem(key));if(entry&&entry.type==='string')entry=JSON.parse(entry.data);else if(entry&&entry.type==='object')entry=entry.data;return{id:key.replace('cinashop_diy_page_v1_',''),entry};}),
products:product?{category:product.dataset.category,children:all('.combination-child',product).map(element=>element.dataset.category),child:one('.combination-child.selected',product)?.dataset.category||'',ids:all('.diy-list-product',product).map(element=>element.dataset.productId),loading:!!one('.combination-status[role="status"]',product),error:text(one('.combination-status[role="alert"]',product)),more:!!one('.combination-more',product),text:text(product)}:null,
widgets:all('.diy-navigation-widget').map(element=>{
const canvas=one('.navigation-canvas',element),header=one('.navigation-header',element),tabs=one('.navigation-tab-shell',element),panel=one('.navigation-cube-panel',element),menu=one('.navigation-menu-panel',element),base=header||canvas||tabs,wrapper=css(base),box=rect(panel),dots=all('.navigation-menu-dot',element),kind=element.dataset.kind;
return{key:element.dataset.componentKey,kind,width:rect(element).width,canvas:!!canvas,canvasWidth:rect(canvas).width,paddingLeft:number(wrapper.paddingLeft),paddingTop:number(wrapper.paddingTop),marginTop:number(wrapper.marginTop),background:wrapper.backgroundColor||'',gradient:css(one('.navigation-header-row',element)).backgroundImage||'',
position:css(header).position||'',top:rect(header||tabs).top,headerHeight:rect(header).height,placeholderHeight:rect(element.firstElementChild).height,logo:!!one('.navigation-logo',element),logoImage:image(one('.navigation-logo',element)),title:text(one('.navigation-title',element)),search:!!one('.navigation-search',element),searchHit:hit(one('.navigation-search-wrap',element)),titleHit:hit(one('.navigation-title',element)),hotWords:all('.navigation-hotwords swiper-item,.navigation-hotwords uni-swiper-item',element).map(text),searchButton:!!one('.navigation-search-button',element),searchText:!!one('.navigation-search-text',element),centered:!!one('.navigation-search.center',element),
style:kind==='tabNav'?Number([...one('.navigation-tab-row',element).classList].find(value=>value.startsWith('style-')).slice(6)):Number(canvas?.dataset.layout||0),tabs:all('.navigation-tab',element).map(tab=>({id:tab.id,index:Number(tab.dataset.tabIndex),label:text(tab),selected:tab.classList.contains('selected'),color:css(tab).color,background:css(tab).backgroundImage})),decorations:all('.navigation-tab-decoration',element).length,fixed:tabs?.classList.contains('fixed')||false,
authoredItems:raw('.navigation-menu-item',element).length,columns:(css(one('.navigation-menu-page',element)).gridTemplateColumns||'').split(' ').filter(Boolean).length,paged:!!one('.navigation-menu-swiper',element),images:all(kind==='menus'?'.navigation-menu-picture image,.navigation-menu-picture uni-image':'.navigation-cube-cell image,.navigation-cube-cell uni-image',element).map(image),labels:all('.navigation-menu-label',element).map(text),tail:text(raw('.navigation-menu-item[data-item-index="99"]',element)[0]),tailExists:!!raw('.navigation-menu-item[data-item-index="99"]',element)[0],
pages:all('.navigation-menu-page',element).map(page=>({index:Number(page.dataset.page||0),height:rect(page).height,count:raw('.navigation-menu-item',page).length,visible:all('.navigation-menu-item',page).length})),swiperHeight:rect(one('.navigation-menu-swiper',element)).height,currentPage:dots.findIndex(dot=>css(dot).backgroundColor==='rgb(55, 90, 127)'),dots:dots.map(dot=>({color:css(dot).backgroundColor,width:rect(dot).width,height:rect(dot).height})),
panelWidth:box.width,panelHeight:box.height,cells:all('.navigation-cube-cell',element).map(cell=>({index:Number(cell.dataset.itemIndex),left:rect(cell).left-box.left,top:rect(cell).top-box.top,width:rect(cell).width,height:rect(cell).height,border:number(css(cell).borderLeftWidth)}))};})};}
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{button.disabled=true;try{
const name=button.dataset.stage,state=await(await fetch('${control}/state')).json();if(!loaded||state.pending!==0)throw Error('Wait iframe load and every real API response before checkpoint');
await new Promise(done=>frame.contentWindow.requestAnimationFrame(()=>frame.contentWindow.requestAnimationFrame(done)));const data=observe(),destination=${JSON.stringify(destinations)}.includes(name),closed=['closed','closedRetry'].includes(name),category=${JSON.stringify(categoryStages)}.includes(name);
if(!destination&&!closed){if(data.widgets.length!==(category?2:20)||data.widgets.some(widget=>widget.images.some(img=>!img.loaded)||widget.logo&&!widget.logoImage.loaded))throw Error('Wait all positive navigation widgets and actual natural images; empty DOM is not loaded');if(category&&(!data.products||data.products.loading||name!=='categoryFailed'&&!data.products.ids.length))throw Error('Wait category/child response and real cards');}
const response=await fetch('${control}/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),result=await response.json();document.querySelector('#result').textContent=JSON.stringify({...result,instruction:instructions[result.next]});
}catch(error){document.querySelector('#result').textContent=String(error);}finally{button.disabled=false;}};
document.querySelector('#result').textContent=JSON.stringify({next:'home',instruction:instructions.home});
</script>`;
    server=createServer((req,res)=>{void(async()=>{
      if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
      const url=new URL(req.url??'/',origin),path=url.pathname;
      if(path===control&&req.method==='GET')return send(res,shell());
      if(path===control+'/state'&&req.method==='GET')return json(res,{pending,next:stage(),checked:evidence.map(row=>row.stage)});
      if(path===control+'/configure'&&req.method==='POST')return configure(req,res);
      if(path.startsWith(control+'/')&&req.method==='POST')return checkpoint(req,res,path.slice(control.length+1));
      if(req.method==='GET'&&Object.hasOwn(chrome,path))return synthetic(req,res,url,chrome[path],'unrelated application chrome');
      if(req.method==='GET'&&['menuTailDestination','cubeDestination','titleDestination'].includes(stage())&&/^\/api\/article\/(list|category|hot|banner)/u.test(path))return synthetic(req,res,url,[],'registered article-list destination');
      if(req.method==='GET'&&stage()==='headerSearchDestination'&&path==='/api/search/hot_keyword'&&!f.tables.includes('store_product_words'))return synthetic(req,res,url,[],'missing-table search hot-keyword destination chrome; route/input only');
      if(path.startsWith('/api/'))return api(req,res,url);
      if(path==='/favicon.ico')return send(res,'',204);
      expect(req.method).toBe('GET');const target=resolve(build,'.'+decodeURIComponent(path));if(target!==build&&!target.startsWith(build+sep))return send(res,'Owned build only',403);
      try{if(target!==build&&(await stat(target)).isFile()){staticPaths.add(path);return send(res,extname(target)==='.html'?await ownedIndex():await readFile(target),200,({'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2'} as Row)[extname(target)]??'application/octet-stream');}}catch{}
      return send(res,await ownedIndex());
    })().catch(error=>{fail(error instanceof Error?error:Error(String(error)));if(!res.headersSent)send(res,String(error),500);else res.destroy();});});
    await new Promise<void>((yes,no)=>{server!.once('error',no);server!.listen(40771,'127.0.0.1',yes);});
    await writeFile(prefix+'ready.json',JSON.stringify({url:origin+control,plans,instructions,sourceHashes:beforeHashes,artifactHashes:beforeBuild,setup,
      selectors:{header:'[data-component-key="801"]',tab:'[data-component-key="811"] .navigation-tab[data-tab-index="0|1|2"]',menuSecond:'[data-component-key="822"] .navigation-menu-dot[data-page-index="1"]',menuTail:'[data-component-key="821"] .navigation-menu-item[data-item-index="99"]',cube:'[data-component-key="852"] .navigation-cube-cell[data-item-index="0"]',retry:'.combination-status uni-button',more:'.combination-more',child752:'.combination-child[data-category="752"]'},
      screenshots:['home','menuSecond','rootFixed','microCaller','headerCentered'],
      limitations:'Exactly one search+one tab per normal saved schema; repeated menus/cubes cover their actual editor layouts. Owned bridge explicitly adds only html hidden native scrollbar viewport CSS to served built index before bootstrap, records raw/served hashes, and leaves built files/JS/CSS unchanged. Control plane only initial auth/viewport, explicit real configuration and observation; all app actions happen through actual UI. Search route/manual input only, no search result/history/read-only claim. Root CUA calibrates375 content width using a warm loaded scrolling=yes iframe and reloads before any accepted checkpoint; observed windowWidth follows the installed DCloud H5 DOM formula because its module API is not a global. Root CUA separately captures screenshot bytes/startup console against these hashes; iframe listeners begin after load.'},null,2)+'\n');
    process.stdout.write('DIY_NAVIGATION_BROWSER_READY '+origin+control+'\n');deadline=setTimeout(()=>fail(Error('Owned Browser acceptance incomplete within thirty-minute operator window')),30*60_000);await completion;
  } finally {
    await writeFile(prefix+'partial.json',JSON.stringify({stages:evidence.map(row=>row.stage),lastObservation,evidence,traces,configs,setup,initial_snapshot:initial,expected_snapshot:expected,storage:storage(),source_before:beforeHashes,build_before:beforeBuild},null,2)+'\n');
    if(deadline)clearTimeout(deadline);server?.closeAllConnections();if(server?.listening)await new Promise<void>(yes=>server!.close(()=>yes()));
    external.mockRestore();wiring.container=undefined;await f.close();
    await writeFile(prefix+'cleanup.json',JSON.stringify({http_server_stopped:!server?.listening,fixture_close_completed:true,provider_spy_restored:true,wiring_cleared:true,completed_stages:evidence.map(row=>row.stage),pg_process_and_remaining_owned_relations:'Validated by outer native runner cleanup; not inferred from fixture.close'},null,2)+'\n');
  }
},31*60_000);
