import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { diyFooterBrowserFixture } from '../helpers/diyFooterBrowserFixture';
import { diyFooterBlock } from '../helpers/diyFooterFixture';
import { sortedDiyState, stableDiyState, type DiyStateRow as Row, type DiyStateSnapshot } from '../helpers/diyStateFixture';

// Only connection/environment wiring changes. Real Admin auth/password/role
// checks run first, then the normal Admin session owns the same disposable DB.
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned footer SQL'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned footer Admin SQL'); return { container: wiring.container, close: async () => {} }; },
}));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
async function files(directory: string): Promise<string[]> { return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(row => row.isDirectory() ? files(resolve(directory, row.name)) : [resolve(directory, row.name)]))).flat().sort(); }
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { const value = Buffer.from(chunk); size += value.length; expect(size).toBeLessThanOrEqual(2_100_000); chunks.push(value); } return Buffer.concat(chunks); }
const canonical = (value: Row[]) => { const copy = structuredClone(value); for (const row of copy) if (typeof row.name === 'string' && row.name.toLowerCase() === 'pagefoot' && Array.isArray(row.menuList)) for (const item of row.menuList) if (Array.isArray(item?.imgList)) for (const index of [0, 1]) if (typeof item.imgList[index] === 'string') { const match = /^\/api\/assets\/([1-9]\d*)(?:[?#][\s\S]*)?$/u.exec(item.imgList[index]); if (match) item.imgList[index] = '/api/assets/' + match[1]; } return copy; };
/** Owned H5 first-tab alias only; retain the original href in every receipt. */
function canonicalPagePath(actualHref: string): string | null {
  try {
    const url = new URL(actualHref);
    if (url.origin !== 'http://127.0.0.1:40779' || url.username || url.password || url.pathname !== '/__h5' || url.search) return null;
    if (url.hash === '#/') return '/pages/index/index';
    return url.hash.startsWith('#/pages/') ? url.hash.slice(1) : null;
  } catch { return null; }
}

it('actual built UniApp and Admin join complete footer, native navigation and private quantity contracts on owned PG16', async () => {
  const f = await diyFooterBrowserFixture(); wiring.container = f.container;
  const app = createApp(), repository = resolve(import.meta.dirname, '../../..'), origin = 'http://127.0.0.1:40779';
  const control = '/__footer/' + randomUUID(), prefix = '/tmp/cinashop-diy-footer-browser-';
  const h5 = resolve(repository, 'view/uniapp-ts/dist/build/h5'), admin = resolve(repository, 'view/admin-ts/dist');
  const plans = ['home','category','categoryDrawer','categoryDrawerClosed','categoryCart','categoryCartClosed','cart','cartUpdated','community','user','micro','microFresh','microReturned','native','nativeCategory','nativeHome','text','floatingIcons','floatingAll','owner22','guest','adminOpen','adminEdited','adminSaved','afterAdmin','closed','closedRetry','reopened','finished'];
  const evidence: Row[] = [], traces: Row[] = [], configs: Row[] = [], setup: Row[] = [], staticPaths: Row[] = [], servedHtml: Row[] = [], browserErrors: Row[] = [];
  let server: Server | undefined, timer: ReturnType<typeof setTimeout> | undefined, pending = 0, lastObservation: Row | undefined;
  let scene = 'initial', businessSave = 0, cartWrite = 0, failed = false, failure: unknown;
  const snapshots: Record<string, DiyStateSnapshot> = {};
  const remember = (value: DiyStateSnapshot) => { const id = digest(value); snapshots[id] ??= structuredClone(value); return id; };
  let done!: () => void, fail!: (reason: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  let queue = Promise.resolve();
  function serial<T>(fn: () => Promise<T>) { const next = queue.then(fn); queue = next.then(() => {}, () => {}); return next; }
  const stage = () => plans[evidence.length];
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned footer acceptance forbids external provider I/O'));
  const resources = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length, objects: digest([...f.objects].map(([key, value]) => ({ key, type: value.type, bytes: [...value.bytes] }))), queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length,
    images: { info: f.rendering.info.mock.calls.length, input: f.rendering.input.mock.calls.length, transform: f.rendering.transform.mock.calls.length, draw: f.rendering.draw.mock.calls.length, output: f.rendering.output.mock.calls.length } });
  let expected = await f.snapshot(); remember(expected); const initial = structuredClone(expected), initialResources = resources();
  let sourceBefore: Row[] = [], h5Before: Row[] = [], adminBefore: Row[] = [];
  const row = (id: number) => expected.system_dise.find(value => value.id === id)!;
  const footer = (micro = false) => { const value = diyFooterBlock(f.platformImage.url); value.menuList.forEach((item: Row, index: number) => { item.imgList = [f.platformImage.url, f.secondIcon.url]; item.name = (micro ? '微' : '') + ['首页','分类','逛逛','购物车','我的'][index]; }); return value; };
  let globalFooter = footer(), microFooter = footer(true);
  const rootBlocks = () => [{ name: 'titles', timestamp: 1, titleConfig: { value: '真实全局页脚首页' } }, ...Array.from({ length: 12 }, (_, index) => ({ name: 'blankPage', timestamp: 10 + index, heightConfig: { val: 12 } })), globalFooter];
  const microBlocks = () => [{ name: 'titles', timestamp: 1, titleConfig: { value: '真实独立微页正文' } }, { ...footer(true), timestamp: 2, menuList: [{ name: '前置旁观页脚', link: '/pages/article/list', imgList: [f.platformImage.url, f.secondIcon.url] }] },
    ...Array.from({ length: 201 }, (_, index) => ({ name: 'blankPage', timestamp: 10 + index })), { ...microFooter, timestamp: 900, isHide: 1 }, { ...footer(true), name: 'PAGEFOOT', timestamp: 901, menuList: [{ name: '大写微页旁观', link: '/pages/article/list', imgList: [f.platformImage.url, f.secondIcon.url] }] }];
  const send = (res: ServerResponse, data: string | Buffer, status = 200, type = 'text/html') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(data); };
  const json = (res: ServerResponse, data: unknown, status = 200) => send(res, JSON.stringify(data), status, 'application/json');
  const sources = async () => { const selected = ['workers-ts/test/browser/diy-footer.acceptance.ts','workers-ts/vitest.diy-footer-browser.config.ts','workers-ts/scripts/run-local-finance-postgres.mjs','workers-ts/package.json','workers-ts/package-lock.json','view/uniapp-ts/package.json','view/uniapp-ts/package-lock.json','view/admin-ts/package.json','view/admin-ts/package-lock.json'];
    const paths = [...selected.map(value => resolve(repository, value)), ...await files(resolve(repository, 'workers-ts/src')), ...await files(resolve(repository, 'workers-ts/test/helpers')), ...await files(resolve(repository, 'view/uniapp-ts/src')), ...await files(resolve(repository, 'view/admin-ts/src')), ...await files(resolve(repository, 'view/common'))]; return Promise.all([...new Set(paths)].sort().map(async path => ({ path: path.slice(repository.length + 1), sha256: hash(await readFile(path)) }))); };
  const artifacts = async (directory: string) => Promise.all((await files(directory)).map(async path => ({ path: path.slice(directory.length + 1), sha256: hash(await readFile(path)) })));
  async function dispatch(path: string, method = 'GET', bytes?: Buffer, incoming?: IncomingMessage, token?: string) {
    const headers = new Headers(); if (incoming) for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
    if (token) headers.set('Authori-zation', 'Bearer ' + token);
    if (bytes?.length) headers.set('Content-Type', 'application/json');
    const waits: Promise<unknown>[] = [];
    const response = await app.fetch(new Request('https://127.0.0.1:40779' + path, { method, headers, ...(bytes?.length ? { body: bytes } : {}) }), f.env, { waitUntil: (work: Promise<unknown>) => { waits.push(work); }, passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(waits); const raw = Buffer.from(await response.arrayBuffer()), payload = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(raw.toString()) as Row : undefined;
    return { response, raw, payload };
  }
  function writeDiff(before: Row, after: Row, input: Row, result: Row) {
    const want = structuredClone(before), id = Number(input.id), original = want.system_dise.find((item: Row) => item.id === id);
    expect(original).toBeDefined(); original.value = JSON.stringify(canonical(JSON.parse(input.value))); original.version = result.version; original.update_time = result.update_time;
    expect(after).toEqual(sortedDiyState(want)); expect(original.value).not.toContain('signature=');
  }
  async function configuration(id: 1 | 2, value: Row[], phase: 'setup' | 'configuration') {
    const before = await f.snapshot(), startResources = resources(), input = { id, value: JSON.stringify(value) }; expect(before).toEqual(expected);
    const result = await dispatch('/adminapi/dise/save', 'POST', Buffer.from(JSON.stringify(input)), undefined, f.adminToken); expect(result.payload?.status).toBe(200);
    const after = await f.snapshot(); writeDiff(before, after, input, result.payload!.data); expect(resources()).toEqual(startResources); expected = after;
    const record = { phase, operation: 'actual-production-admin-auth-save', id, before: remember(before), after: remember(after), before_row: before.system_dise.find(item => item.id === id), after_row: after.system_dise.find(item => item.id === id), allowed: ['system_dise.value','system_dise.version','system_dise.update_time'] };
    (phase === 'setup' ? setup : configs).push(record);
  }
  const persistPartial = async (error?: unknown) => writeFile(prefix + 'partial.json', JSON.stringify({ status: failed ? 'failed' : 'running', error: error instanceof Error ? error.stack : error, stage: stage(), evidence, traces, configs, setup, snapshots_by_sha256: snapshots, observation: lastObservation, source_before: sourceBefore, h5_before: h5Before, admin_before: adminBefore }, null, 2) + '\n');
  try {
    setup.push({ phase: 'owned-only-ORM-schema-and-seed', added_tables: f.additionalTables, original_tables: 50, original_sequences: 46, actual_tables: f.tables, actual_sequences: f.sequences, before: f.beforeBrowserSetup, after: f.afterBrowserSetup, resources_before: f.beforeBrowserSetupResources, resources_after: f.afterBrowserSetupResources,
      allowed: ['new empty read dependencies','one real Admin/role','one real platform image upload','one actualSKU','existing cartattrUnique only','one exact category/type3 Dise layout and two platform child categories'], badge_quantities_and_flags_changed: false });
    expect(f.afterBrowserSetupResources.puts - f.beforeBrowserSetupResources.puts).toBe(1);
    expect(f.afterBrowserSetupResources.deletes).toBe(f.beforeBrowserSetupResources.deletes);
    expect(f.afterBrowserSetupResources.queue).toBe(f.beforeBrowserSetupResources.queue);
    remember(f.beforeBrowserSetup); remember(f.afterBrowserSetup);
    const categorySetup = f.categorySetup, categoryWant = structuredClone(categorySetup.before);
    const styleRows = categorySetup.after.system_dise.filter(item => item.id === 88), children = categorySetup.after.store_product_category.filter(item => [751,752].includes(item.id));
    expect(categorySetup.before.system_dise.some(item => item.id === 88)).toBe(false);
    expect(categorySetup.before.store_product_category.some(item => [751,752].includes(item.id))).toBe(false);
    expect(styleRows).toHaveLength(1); expect(styleRows[0]).toMatchObject({ id:88,template_name:'category',type:3,is_del:0,is_diy:0,status:1,is_show:1,value:JSON.stringify({level:2,index:2}) });
    expect(categorySetup.before.store_product_category.find(item => item.id === 701)).toMatchObject({ id:701,pid:0,level:0,type:0,relation_id:0,is_show:1 });
    expect(children).toHaveLength(2); expect(children.map(item => item.id).sort((a,b) => a-b)).toEqual([751,752]);
    for (const child of children) expect(child).toMatchObject({ pid:701,level:1,type:0,relation_id:0,path:'701',is_show:1 });
    categoryWant.system_dise.push(...styleRows); categoryWant.store_product_category.push(...children);
    expect(categorySetup.after).toEqual(sortedDiyState(categoryWant)); expect(categorySetup.resources_after).toEqual(categorySetup.resources_before);
    expect(categorySetup.after.store_product_relation).toEqual(categorySetup.before.store_product_relation); expect(categorySetup.after.store_cart).toEqual(categorySetup.before.store_cart);
    setup.push({ phase:'owned-real-category-layout-and-children', ...categorySetup, allowed:['new system_dise.id88 category/type3 row','new store_product_category.id751/752 children of701'], product_relations_unchanged:true, badge_quantities_and_flags_changed:false });
    remember(categorySetup.before); remember(categorySetup.after);
    for (const token of ['', f.token]) { const before = await f.snapshot(), result = await dispatch('/adminapi/dise/list', 'GET', undefined, undefined, token); expect(result.payload?.status).not.toBe(200); expect(await f.snapshot()).toEqual(before); setup.push({ phase: 'actual-admin-auth-negative', actor: token ? 'shopper11' : 'guest', status: result.payload?.status, unchanged: true }); }
    await configuration(1, rootBlocks(), 'setup'); await configuration(2, microBlocks(), 'setup');
    expect(resources()).toEqual(initialResources);
    sourceBefore = await sources(); h5Before = await artifacts(h5); adminBefore = await artifacts(admin); expect(h5Before.length).toBeGreaterThan(100); expect(adminBefore.length).toBeGreaterThan(20);
    const prepared = structuredClone(expected);
    const chrome: Row = {
      '/api/site_config': { site_name: '真实页脚联合验收', site_logo: '', record_No: '', ico_path: '' }, '/api/share': { title: '真实页脚', synopsis: '', img: '' },
      '/api/get_open_adv': { status: 0, time: 3, interval_time: 24, type: 'pic', value: [], video_link: '' }, '/api/v2/diy/color_change/color_change': {},
      '/adminapi/new_push': { ordernum: 0, inventory: 0, commentnum: 0, reflectnum: 0, msgcount: 0, sampled_at: Math.floor(Date.now() / 1000) },
    };
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      pending++;
      try { await serial(async () => {
        const raw = await body(req), method = req.method ?? 'GET', before = await f.snapshot(), startResources = resources(); expect(before).toEqual(expected);
        const path = url.pathname, query = url.search, isAdmin = path.startsWith('/adminapi/'), supplied = req.headers['authori-zation'] || req.headers.authorization, token = typeof supplied === 'string' ? supplied.replace(/^Bearer\s+/, '').trim() : '';
        const actor = token === f.token ? 11 : token === f.otherToken ? 22 : token === f.adminToken ? 901 : 0;
        if (Object.hasOwn(chrome, path)) {
          expect(method).toBe('GET'); expect(raw.length).toBe(0); expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(startResources);
          traces.push({ path, query, method, synthetic: true, scope: 'unrelated branding/advertisement/theme-or-admin-notification chrome', before: remember(before), after: remember(before), resources_before: startResources, resources_after: resources(), stage: stage() });
          json(res, { status: 200, msg: 'Explicit unrelated chrome only', data: chrome[path] }); return;
        }
        expect(path.startsWith('/api/') || isAdmin).toBe(true);
        if (method === 'GET') expect(raw.length).toBe(0);
        else expect(['/api/cart/num','/api/cart/compute','/adminapi/dise/save']).toContain(path);
        if (isAdmin) { expect(['/adminapi/dise/list','/adminapi/dise/save','/adminapi/file/file','/adminapi/file/category']).toContain(path); expect(actor).toBe(901); }
        const result = await dispatch(path + query, method, raw, req), after = await f.snapshot();
        expect(result.response.status).toBe(200); expect(result.payload ? [200,410010,410000].includes(result.payload.status) : true).toBe(true);
        if (path === '/adminapi/dise/save') {
          expect(stage()).toBe('adminSaved'); expect(method).toBe('POST'); expect(businessSave++).toBe(0); expect(result.payload?.status).toBe(200);
          const input = JSON.parse(raw.toString()); expect(Object.keys(input).sort()).toEqual(['content','id','name','status','title','value']); expect(input.id).toBe(1);
          const original = row(1); expect(input.name).toBe(original.name); expect(input.title).toBe(original.title); expect(input.content).toBe(original.content ?? ''); expect(input.status).toBe(original.status);
          writeDiff(before, after, input, result.payload!.data); const parsed = JSON.parse(after.system_dise.find(item => item.id === 1)!.value); globalFooter = parsed.find((item: Row) => item.name === 'pageFoot');
          expect(globalFooter.menuList[0].name).toBe('保存首页'); expect(globalFooter.topConfig.val).toBe(9); expect(globalFooter.activeTxtColor.color[0].item).toBe('#663399'); expect(globalFooter.menuList[0].imgList[0]).toBe(f.secondIcon.url);
          expect(parsed.filter((item: Row) => item.name !== 'pageFoot')).toEqual(JSON.parse(original.value).filter((item: Row) => item.name !== 'pageFoot'));
          configs.push({ phase: 'actual-Admin-typed-editor-business-save', before: remember(before), after: remember(after), before_row: original, after_row: after.system_dise.find(item => item.id === 1), allowed: ['system_dise.value','system_dise.version','system_dise.update_time'] }); expected = after;
        } else if (path === '/api/cart/num') {
          expect(stage()).toBe('cartUpdated'); expect(cartWrite++).toBe(0); expect(actor).toBe(11); expect(JSON.parse(raw.toString())).toEqual({ id: 9101, cartNum: 4 }); expect(result.payload?.status).toBe(200);
          const want = structuredClone(before); want.store_cart = want.store_cart.map(item => item.id === 9101 ? { ...item, cart_num: 4 } : item); expect(after).toEqual(sortedDiyState(want)); expected = after;
          configs.push({ phase: 'actual-cart-num-business-write', before: remember(before), after: remember(after), allowed: ['store_cart.9101.cart_num:3→4'] });
        } else expect(after).toEqual(before);
        expect(resources()).toEqual(startResources);
        if (path === '/api/cart/count' && url.searchParams.has('numType')) { expect(actor).not.toBe(0); expect([...url.searchParams].sort()).toEqual([['numType','0'],['scope','cart']]); expect(result.payload?.data.count).toBe(actor === 22 ? 4 : cartWrite ? 8 : 7); expect(result.response.headers.get('Cache-Control')).toBe('private, no-store'); }
        if (path === '/api/v2/diy/product_detail') { expect(result.payload?.status).toBe(200); expect(result.payload?.data.product_category).toEqual({ level:2,index:2,configured:true,issues:[] }); }
        if (path === '/api/category') { expect(result.payload?.status).toBe(200); const roots = result.payload?.data; expect(Array.isArray(roots)).toBe(true); const root = roots.find((item:Row) => item.id === 701); expect(root).toMatchObject({id:701,pid:0}); expect(root.children.map((item:Row) => item.id).sort((a:number,b:number) => a-b)).toEqual([751,752]); }
        if (path === '/api/products' && url.searchParams.get('cid') === '701' && !url.searchParams.has('sid') && !url.searchParams.has('tid')) { expect(result.payload?.status).toBe(200); expect(result.payload?.data.list.map((item:Row) => item.id).sort((a:number,b:number) => a-b)).toEqual([601,611]); expect(result.payload?.data.count).toBe(2); }
        if (path === '/api/navigation') { expect(result.response.headers.get('Cache-Control')).toBe('no-store'); if (result.payload?.status === 200) expect(canonical([result.payload.data])[0]).toEqual(globalFooter); }
        traces.push({ path, query, method, synthetic: false, actor, stage: stage(), status: result.payload?.status ?? result.response.status, material: result.payload?.data,
          operation: path === '/adminapi/dise/save' || path === '/api/cart/num' ? 'allowed explicit business write' : method === 'GET' ? 'actual read' : 'actual read-only computation POST', before: remember(before), after: remember(after), unchanged: digest(before) === digest(after), resources_before: startResources, resources_after: resources() });
        const responseHeaders: Record<string, string> = {}; result.response.headers.forEach((value, key) => { if (!['content-length','content-encoding','transfer-encoding','connection'].includes(key.toLowerCase())) responseHeaders[key] = value; });
        res.writeHead(result.response.status, responseHeaders); res.end(result.raw);
      }); } finally { pending--; }
    }
    async function configure(req: IncomingMessage, res: ServerResponse) { const input = JSON.parse((await body(req)).toString()); await serial(async () => {
      if (['native','text','floatingIcons','floatingAll'].includes(input.action)) {
        expect(stage()).toBe(input.action); globalFooter = footer();
        if (input.action === 'native') globalFooter.effectConfig.tabVal = 0;
        if (input.action === 'text') globalFooter.navStyleConfig.tabVal = 1;
        if (input.action === 'floatingIcons') { globalFooter.navConfig.tabVal = 1; globalFooter.navStyleConfig.tabVal = 2; }
        if (input.action === 'floatingAll') globalFooter.navConfig.tabVal = 1;
        scene = input.action; await configuration(1, rootBlocks(), 'configuration');
      } else {
        expect(['close','open']).toContain(input.action); expect(stage()).toBe(input.action === 'close' ? 'closed' : 'reopened');
        const receipt = await f.station(input.action === 'close' ? '0' : '1'); expect(receipt.before).toEqual(expected);
        const want = structuredClone(expected); want.system_config = want.system_config.map(item => item.menu_name === 'station_open' && item.is_store === 0 ? { ...item, value: input.action === 'close' ? '0' : '1' } : item);
        expect(receipt.after).toEqual(sortedDiyState(want)); expected = receipt.after; f.cache.set('cfg_station_open', input.action === 'close' ? '1' : '0');
        configs.push({ phase: 'station-' + input.action, before: remember(receipt.before), after: remember(receipt.after), allowed: ['system_config.station_open'], deliberately_opposite_stale_kv: true });
      }
      expect(resources()).toEqual(initialResources); json(res, { configured: input.action, next: stage() });
    }); }
    const rgb = (hex: string) => { const text = hex.slice(1); return `rgb(${[0, 2, 4].map(index => parseInt(text.slice(index, index + 2), 16)).join(', ')})`; };
    const near = (a: number, b: number, tolerance = .8) => expect(Math.abs(a - b)).toBeLessThan(tolerance);
    function assertFooter(data: Row, mode: 'micro' | 'global', badge: number) {
      const pagePath = canonicalPagePath(data.href); expect(pagePath).not.toBeNull();
      expect(data.native.visible).toBe(false); expect(data.footers).toHaveLength(1); const observed = data.footers[0], wanted = mode === 'micro' ? microFooter : globalFooter;
      expect(observed.visibility).toBe('visible'); expect(observed.items).toHaveLength(5); expect(observed.items.map((item: Row) => item.label)).toEqual(wanted.menuList.map((item: Row) => item.name));
      expect(data.bodyText).not.toContain('前置旁观页脚'); expect(data.bodyText).not.toContain('大写微页旁观'); expect(observed.badges).toEqual(badge ? [String(badge)] : []);
      near(observed.box.bottom, data.clientHeight); expect(observed.box.width).toBeLessThan(376); expect(observed.box.width).toBeGreaterThan(374);
      const px = (value: number) => data.rpx[String(value)], floating = wanted.navConfig.tabVal === 1, style = wanted.navStyleConfig.tabVal;
      near(observed.paddingBottom, (floating ? px(wanted.mbConfig.val * 2) : 0) + data.safeBottom);
      near(observed.menu.paddingTop, px(wanted.topConfig.val * 2)); near(observed.menu.paddingBottom, px(wanted.bottomConfig.val * 2));
      near(observed.menu.marginLeft, floating ? px(wanted.prConfig.val * 2) : 0); near(observed.menu.marginRight, floating ? px(wanted.prConfig.val * 2) : 0);
      if (floating) [0,1,3,2].forEach((index, slot) => near(observed.menu.radius[slot], px(wanted.fillet.valList[index].val * 2)));
      expect(observed.items.every((item: Row) => item.style === style)).toBe(true);
      expect(observed.menu.background).toBe(rgb((floating ? wanted.bgColor2 : wanted.bgColor).color[0].item));
      for (const [index, item] of observed.items.entries()) {
        const expectedPath = wanted.menuList[index].link.replace('/pages/goods_cate/goods_cate','/pages/goods/cate').replace('/pages/order_addcart/order_addcart','/pages/cart/index').replace('/pages/discoverIndex/index','/pages/discover/index');
        const selected = pagePath?.split('?')[0] === expectedPath; expect(item.selected).toBe(selected); expect(item.textVisible).toBe(style !== 2);
        if (style !== 2) expect(item.textColor).toBe(rgb((selected ? wanted.activeTxtColor : wanted.txtColor).color[0].item));
        if (style === 1) expect(item.images).toHaveLength(0);
        else { expect(item.images).toHaveLength(1); const image = item.images[0]; expect(image.complete).toBe(true); expect(image.naturalWidth).toBeGreaterThan(0); expect(image.naturalHeight).toBeGreaterThan(0); expect(new URL(image.src).pathname).toBe(wanted.menuList[index].imgList[selected ? 0 : 1]); }
      }
    }
    function assertPublicFooterReads(slice: Row[]) {
      for (const path of ['/api/diy/diy_version/0','/api/navigation']) expect(slice.some(item => item.path === path && !item.synthetic && item.status === 200)).toBe(true);
    }
    async function checkpoint(name: string, data: Row, res: ServerResponse) { expect(pending).toBe(0); await serial(async () => {
      const pagePath = canonicalPagePath(data.href); lastObservation = { ...data, canonical_page_path: pagePath }; expect(name).toBe(stage()); expect(data.loaded).toBe(true); expect(pending).toBe(0); if (name.startsWith('admin')) { expect(data.clientWidth).toBeGreaterThanOrEqual(1000); expect(data.scrollWidth).toBeLessThanOrEqual(data.clientWidth); } else { expect(pagePath).not.toBeNull(); expect(data.clientWidth).toBe(375); expect(data.scrollWidth).toBeLessThanOrEqual(375); } expect(data.errors).toEqual([]);
      const start = evidence.at(-1)?.traceCount ?? 0, slice = traces.slice(start), amount = cartWrite ? 8 : 7;
      if (name === 'adminOpen') { expect(data.href).toContain('/content/dise'); expect(data.bodyText).toContain('DIY 装修 / 自定义页面'); expect(slice.some(item => item.path === '/adminapi/dise/list' && item.actor === 901 && item.status === 200)).toBe(true); }
      else if (name === 'adminEdited') { expect(data.admin.editor).toBe(true); expect(data.admin.value).toBeTruthy(); const value = JSON.parse(data.admin.value), edited = value.find((item: Row) => item.name === 'pageFoot'); expect(edited.menuList[0].name).toBe('保存首页'); expect(edited.topConfig.val).toBe(9); expect(edited.activeTxtColor.color[0].item).toBe('#663399'); expect(edited.menuList[0].imgList[0]).toBe(f.secondIcon.url); expect(slice.some(item => item.path === '/adminapi/file/file' && !item.synthetic)).toBe(true); expect(businessSave).toBe(0); }
      else if (name === 'adminSaved') { expect(businessSave).toBe(1); expect(data.admin.dialog).toBe(false); expect(slice.some(item => item.path === '/adminapi/dise/save' && !item.synthetic)).toBe(true); }
      else if (name === 'closed' || name === 'closedRetry') { expect(data.footers).toEqual([]); expect(data.bodyText).toContain('站点'); expect(slice.some(item => item.path === '/api/diy/diy_version/0' && item.status === 410010)).toBe(true); }
      else if (['native','nativeCategory','nativeHome'].includes(name)) {
        expect(data.footers).toEqual([]); expect(data.native.visible).toBe(true); expect(data.native.items).toBe(5);
        expect(pagePath).toBe(name === 'nativeCategory' ? '/pages/goods/cate' : '/pages/index/index');
        if (name !== 'native') assertPublicFooterReads(slice);
        if (name === 'nativeCategory') expect(slice.some(item => item.path === '/api/v2/diy/product_detail' && !item.synthetic && item.status === 200)).toBe(true);
      }
      else if (name === 'categoryDrawer' || name === 'categoryCart') { expect(data.footers).toEqual([]); expect(data.native.visible).toBe(false); expect(data.modal.visible).toBe(true); expect(data.modal.type).toContain(name === 'categoryDrawer' ? 'category-drawer' : 'cart-sheet'); }
      else if (name !== 'finished') {
        assertFooter(data, ['micro','microFresh'].includes(name) ? 'micro' : 'global', name === 'owner22' ? 4 : name === 'guest' ? 0 : amount);
        if (['category','cart','community','user','microReturned'].includes(name)) assertPublicFooterReads(slice);
        if (name === 'microReturned') expect(pagePath).toBe('/pages/index/index');
        if (name === 'home') expect(slice.some(item => item.path === '/api/cart/count' && item.actor === 11 && item.material.count === 7 && new URLSearchParams(item.query).get('numType') === '0')).toBe(true);
        if (name.startsWith('category')) { if (name === 'category') { expect(slice.some(item => item.path === '/api/v2/diy/product_detail' && !item.synthetic && item.status === 200)).toBe(true); expect(slice.some(item => item.path === '/api/products' && new URLSearchParams(item.query).get('cid') === '701' && !item.synthetic && item.status === 200)).toBe(true); expect(data.bodyText).toContain('真实促销零价商品601'); expect(data.bodyText).toContain('真实促销商品611'); } expect(data.href).toContain('/pages/goods/cate'); expect(data.category).toBeTruthy(); expect(data.category.bottom).toBeLessThanOrEqual(data.footers[0].box.top + 1); }
        if (name === 'cart' || name === 'cartUpdated') { expect(data.href).toContain('/pages/cart/index'); expect(data.checkout).toBeTruthy(); near(data.checkout.bottom, data.footers[0].box.top); if (name === 'cart') expect(slice.some(item => item.path === '/api/cart/list' && !item.synthetic)).toBe(true); }
        if (name === 'cartUpdated') { expect(slice.some(item => item.path === '/api/cart/num' && item.actor === 11 && item.status === 200)).toBe(true); expect(cartWrite).toBe(1); expect(slice.some(item => item.path === '/api/cart/count' && item.material.count === 8)).toBe(true); }
        if (name === 'community') expect(data.href).toContain('/pages/discover/index');
        if (name === 'user') expect(data.href).toContain('/pages/user/index');
        if (name === 'micro') { expect(data.href).toContain('/pages/diy/detail?id=2'); expect(JSON.parse(row(2).value).findIndex((item: Row) => item.name === 'pageFoot' && item.timestamp === 900)).toBeGreaterThan(200); }
        if (name === 'microFresh') expect(slice.some(item => item.path === '/api/diy/get_diy/2' && item.status === 200)).toBe(true);
        if (name === 'owner22') expect(slice.some(item => item.path === '/api/cart/count' && item.actor === 22 && item.material.count === 4)).toBe(true);
        if (name === 'guest') expect(slice.filter(item => item.path === '/api/cart/count')).toEqual([]);
        if (name === 'afterAdmin') { expect(slice.some(item => item.path === '/api/navigation' && item.status === 200 && !item.synthetic)).toBe(true); const old = evidence.find(item => item.stage === 'home')!; expect(data.footers[0].items[1].images[0].src).not.toBe(old.footers[0].items[1].images[0].src); }
      }
      browserErrors.push(...data.errors); evidence.push({ stage: name, ...data, canonical_page_path: pagePath, traceCount: traces.length, pending_at_checkpoint: pending, snapshot: digest(expected), scene });
      await writeFile(prefix + 'progress.json', JSON.stringify({ status: name === 'finished' ? 'passed' : 'running', checked: evidence.map(item => item.stage), last: name, next: stage(), counts: { traces: traces.length, configs: configs.length }, at: new Date().toISOString() }, null, 2) + '\n');
      if (name === 'finished') {
        expect(evidence).toHaveLength(plans.length); expect(businessSave).toBe(1); expect(cartWrite).toBe(1); expect(external).not.toHaveBeenCalled();
        const sourceAfter = await sources(), h5After = await artifacts(h5), adminAfter = await artifacts(admin); expect(sourceAfter).toEqual(sourceBefore); expect(h5After).toEqual(h5Before); expect(adminAfter).toEqual(adminBefore);
        await writeFile(prefix + 'evidence.json', JSON.stringify({ status: 'passed-all-29-checkpoints', evidence, traces, configs, setup, tables: f.tables, sequences: f.sequences,
          snapshots_by_sha256: snapshots, initial_snapshot: initial, prepared_snapshot: prepared, final_snapshot: expected, initial_resources: initialResources, final_resources: resources(), source_hashes: { before: sourceBefore, after: sourceAfter }, h5_artifact_hashes: { before: h5Before, after: h5After }, admin_artifact_hashes: { before: adminBefore, after: adminAfter }, served_html_transport: servedHtml, static_paths: staticPaths, browserErrors,
          environment: { node: process.version, executable: process.execPath }, providerCalls: 0,
          boundary: 'Actual built H5/Admin, real createApp/JWT/production Admin role middleware/controller/SQL. DB-session wiring alone targets owned PG16. Exact extended tables/sequences snapshot every API; only listed Admin/cart writes may change DB; all resources unchanged after explicit setup. No fake footer/media/cart/DIY/Admin save or permission DTO. Initial session bootstrap is synthetic authentication setup, not login UI acceptance. Native H5 bar DOM is real; physical MP/App not executed. Public previews are not Admin/publishing authority. Imported micro footer beyond200/duplicate stress is not normal PHP visual-editor capacity. Guest badge0 makes no forced-auth cart/count call. Browser does not wait840s; Node fakeclock proves timed renewal, Browser proves actual fresh ticket reread and natural pixels. Owned served H5 index only hides desktop scrollbar without changing scrollroot; raw/served hashes explicit, actual JS/CSS unmodified. Screenshots and startup console belong to root CUA receipts; no local screenshot path is claimed without a tool-returned file.' }, null, 2) + '\n'); done();
      }
      json(res, { checked: evidence.map(item => item.stage), next: stage() });
    }); }
    const instructions: Row = {
      home:'Load 首页11. Wait initial page, nativebar hidden,5 actual footer items, positive natural images andbadge7, then checkpoint.',
      category:'Click actual custom footer 分类. Wait actual Page onShow newversion0+navigation success, real configured2/2 top-products layout, both751/752 child labels and cid701 actual601/611 products plus footer images/selectedstate; nativebar hidden; checkpoint dimensions.',
      categoryDrawer:'Click actual category 更多 (primary category dropdown), wait visible drawer and hidden global/nativefooter. Do not click synthetic controls.',
      categoryDrawerClosed:'Close actual drawer. Wait footer restored with correct selection/height.',
      categoryCart:'Click actual category mini-cart entry to open actual cart sheet; wait API, modal and hidden footer. This is a read, no clear/remove.',
      categoryCartClosed:'Close actual cart sheet and wait footer restored.',
      cart:'Click actual custom footer 购物车. Wait actual Page onShow newversion0+navigation success, realcart/list, valid601 row qty3, checkoutbar above measured footer; badge remains7 despite another nonstandard included badge row.',
      cartUpdated:'Click actual valid601 + once (3→4). Wait actualcart/num success/reload andfooterbadge8; do not checkout.',
      community:'Click actual custom footer 逛逛. Wait actual Page onShow newversion0+navigation success, feed/card loading and correct footer selection; nativebar hidden; all real APIs read-only.',
      user:'Click actual custom footer 我的. Wait actual Page onShow newversion0+navigation success, actualusercenter menu/date and correct footer selection; nativebar hidden.',
      micro:'Click control 微页11 to load actual micro2. Last exact pageFoot after200+components must own five微-prefixedlabels; earlier/lateruppercase footer not adopted. Badge8.',
      microFresh:'Click control 重新加载当前帧 once. This test-only action first evicts only cinashop_diy_page_v1_ persisted cache, then performs actual location.reload. Wait new actualget_diy2 and five positive natural images; no cache-bypass production change or840s claim.',
      microReturned:'Click actual micro footer 微首页 inside the application (not shell 首页11). Wait real switchTab to root, newversion0+navigation success, global five labels/images/badge8 and nativebar hidden; no control route/reload.',
      native:'Click control 配置native (actual Admin authenticated save), then 首页11. Wait customfooterabsent/nativefiveitemsvisible.',
      nativeCategory:'Click actual visible native tabbar 分类 inside application (not shell route). Wait actual Page onShow newversion0+navigation success and realcategory layout/tree/products. No customfooter; nativefiveitemsremainvisible.',
      nativeHome:'Click actual native tabbar 首页 inside application (not shell route/reload). Wait actual root Page onShow newversion0+navigation success. No customfooter; nativefiveitemsvisible, proving category-to-root global restoration.',
      text:'Click 配置text, then 首页11. Wait customtext-onlyfiveitems/noimages andbadge8.',
      floatingIcons:'Click 配置floatingIcons, then 首页11. Wait floatingicon-onlyfiveitems/positiveimages/pr10/mb7/top6/bottom8/corners2,4,8,6px authored.',
      floatingAll:'Click 配置floatingAll, then 首页11. Wait floatingicons+text andnaturalpixels.',
      owner22:'Click 首页22 initial-session bootstrap. Wait badge4 and no owner11 state.',
      guest:'Click 访客首页. Wait badge0 and no cart/count request from guest (productionforceauthunchanged).',
      adminOpen:'Click 真实Admin (desktopframe1200). Wait real /content/dise table and productionAdminauth list.',
      adminEdited:'Edit row1 actual页面. In footer editor: firstmenu名称→保存首页; 上内边距9; 选中文字颜色#663399. First选中图标 从图库选择 choose footer-unselected.png (real secondplatformasset). Do NOT save yet; checkpoint typed JSON+real gallery GET.',
      adminSaved:'Click actual页面dialog 保存 once. Wait dialog closed andrealproduction /adminapi/dise/save successful. No JSONpaste or controlsave substitute.',
      afterAdmin:'Click 首页11. Wait new navigation version/read, 保存首页 label, top9/color#663399/selectedsecondicon andfresh tickets/natural pixels; badge8.',
      closed:'Click 关闭站点 then 首页11. Wait actual410010 andzero footer; no fake410response.',
      closedRetry:'Click actual 重新加载首页 once. Wait realclosed410010, no footer.',
      reopened:'Click 开启站点 then 首页11 (new actualframe load). Wait same savedfooter andbadge8. This is fresh reopening, not claimed sameclosed-instance recovery.',
      finished:'Final current frame observation: all29stages, realAdmin1/cartwrite1, exactsource+bothbuild hashes and zero unlisted DB/R2/Queue delta.'
    };
    const shell = () => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>页脚真实双端验收</title><style>body{font:13px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:375px;height:830px;border:1px solid #ddd}pre{max-height:100px;overflow:auto;white-space:pre-wrap}</style></head><body><h1>真实全局/微页页脚＋Admin编辑</h1>
<button data-route="home">首页11</button><button data-route="other">首页22</button><button data-route="guest">访客首页</button><button data-route="micro">微页11</button><button data-route="admin">真实Admin</button><button id="reload">重新加载当前帧</button>
${['native','text','floatingIcons','floatingAll','close','open'].map(name => '<button data-config="'+name+'">配置'+name+'</button>').join('')}
${plans.map(name => '<button data-stage="'+name+'">'+name+'</button>').join('')}<pre id="result"></pre><iframe title="真实应用验收帧" scrolling="yes"></iframe>
<script>
const frame=document.querySelector('iframe'),instructions=${JSON.stringify(instructions)},tokens=${JSON.stringify({ home: f.token, other: f.otherToken, micro: f.token })};
let loaded=false,errors=[],removeFrameListeners=()=>{};
function frameReady(w,d){if(w!==frame.contentWindow||d!==frame.contentDocument||!d||d.readyState!=='complete')return false;const location=w.location;return location.origin===window.location.origin&&((location.pathname==='/__h5'&&(location.hash==='#/'||location.hash.startsWith('#/pages/')))||location.pathname==='/content/dise');}
frame.onload=()=>{removeFrameListeners();const w=frame.contentWindow,d=frame.contentDocument,ready=()=>{loaded=frameReady(w,d);},error=event=>errors.push({kind:'error',message:String(event.message)}),rejection=event=>errors.push({kind:'unhandledrejection',message:String(event.reason)});w.addEventListener('hashchange',ready);w.addEventListener('error',error);w.addEventListener('unhandledrejection',rejection);removeFrameListeners=()=>{w.removeEventListener('hashchange',ready);w.removeEventListener('error',error);w.removeEventListener('unhandledrejection',rejection);};ready();};
window.addEventListener('pagehide',()=>removeFrameListeners());
function navigateFrame(target){const destination=new URL(target,window.location.href).href,current=frame.contentWindow.location,rootAlias=current.origin===window.location.origin&&current.pathname==='/__h5'&&current.search===''&&current.hash==='#/'&&destination===new URL('/__h5#/pages/index/index',window.location.href).href;if(frame.contentWindow.location.href===destination||rootAlias)frame.contentWindow.location.reload();else frame.src=destination;}
for(const button of document.querySelectorAll('[data-route]'))button.onclick=()=>{loaded=false;errors=[];const kind=button.dataset.route;if(kind==='admin'){localStorage.setItem('admin_token',${JSON.stringify(f.adminToken)});localStorage.setItem('admin_session',${JSON.stringify(JSON.stringify(f.adminSession))});frame.style.width='1200px';navigateFrame('/content/dise');return;}frame.style.width='375px';if(kind==='guest'){localStorage.removeItem('uni_token');localStorage.removeItem('uni_uid');}else{localStorage.setItem('uni_token',JSON.stringify({type:'string',data:tokens[kind]}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:kind==='other'?22:11}));}for(const key of Object.keys(localStorage))if(key.startsWith('cinashop_diy_page_v1_'))localStorage.removeItem(key);navigateFrame('/__h5#/pages/'+(kind==='micro'?'diy/detail?id=2':'index/index'));};
document.getElementById('reload').onclick=()=>{loaded=false;errors=[];for(const key of Object.keys(localStorage))if(key.startsWith('cinashop_diy_page_v1_'))localStorage.removeItem(key);frame.contentWindow.location.reload();};
for(const button of document.querySelectorAll('[data-config]'))button.onclick=async()=>{button.disabled=true;try{const response=await fetch(${JSON.stringify(control)}+'/scene',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:button.dataset.config})});document.getElementById('result').textContent=await response.text();}finally{button.disabled=false;}};
const visible=node=>{if(!node)return false;const s=frame.contentWindow.getComputedStyle(node),b=node.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&b.width>0&&b.height>0;};
function box(node){if(!node)return null;const b=node.getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,width:b.width,height:b.height};}
function observe(){const w=frame.contentWindow,d=frame.contentDocument,css=node=>w.getComputedStyle(node),num=(node,key)=>parseFloat(css(node)[key])||0;
 const footers=[...d.querySelectorAll('.diy-page-foot')].filter(visible).map(node=>{const menu=node.querySelector('.diy-footer-menu');return {box:box(node),visibility:css(node).visibility,paddingBottom:num(node,'paddingBottom'),badges:[...node.querySelectorAll('.diy-foot-badge')].map(x=>x.textContent.trim()),menu:{...box(menu),paddingTop:num(menu,'paddingTop'),paddingBottom:num(menu,'paddingBottom'),marginLeft:num(menu,'marginLeft'),marginRight:num(menu,'marginRight'),background:css(menu).backgroundColor,radius:['borderTopLeftRadius','borderTopRightRadius','borderBottomRightRadius','borderBottomLeftRadius'].map(key=>num(menu,key))},items:[...node.querySelectorAll('.diy-foot-item')].map(item=>({label:item.getAttribute('aria-label'),selected:item.classList.contains('selected'),style:Number(/diy-footer-style-(\\d)/.exec(item.className)?.[1]),textVisible:!!item.querySelector('.diy-foot-text'),textColor:item.querySelector('.diy-foot-text')?css(item.querySelector('.diy-foot-text')).color:'',images:[...item.querySelectorAll('img')].map(img=>({src:img.currentSrc||img.src,complete:img.complete,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,box:box(img)}))}))};});
 const native=[...d.querySelectorAll('uni-tabbar')].find(visible)??[...d.querySelectorAll('.uni-tabbar')].find(visible),modal=[...d.querySelectorAll('.category-drawer,.category-cart-sheet,.cart-sheet,.sku-modal')].find(visible),dialog=[...d.querySelectorAll('.el-dialog')].find(visible),editor=dialog?.querySelector('.footer-editor');
 const rpx={};for(const n of [0,4,8,12,14,16,18,20])rpx[n]=typeof w.rpx2px==='function'?w.rpx2px(n):NaN;
 return {loaded:loaded&&frameReady(w,d),observedAt:Date.now(),href:w.location.href,bodyText:d.body.innerText,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,clientHeight:w.innerHeight,safeBottom:0,rpx,unit:typeof w.rpx2px==='function'?w.rpx2px(2)/2:NaN,footers,native:{visible:!!native,items:native?native.querySelectorAll('.uni-tabbar__item').length:0,box:box(native)},category:box(d.querySelector('.cate-page')),checkout:box(d.querySelector('.checkout-bar')),modal:{visible:!!modal,type:modal?.className??'',box:box(modal)},admin:{editor:!!editor,dialog:!!dialog,value:dialog?.querySelector('textarea')?.value??'',inputs:editor?[...editor.querySelectorAll('input')].map(x=>({value:x.value,label:x.getAttribute('aria-label')})):[]},errors:[...errors]};}
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{button.disabled=true;try{const end=Date.now()+10000;for(;;){const state=await(await fetch(${JSON.stringify(control)}+'/state')).json();if(!state.pending)break;if(Date.now()>end)throw Error('API still pending; wait actual loading before checkpoint');await new Promise(resolve=>setTimeout(resolve,100));}await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const data=observe(),response=await fetch(${JSON.stringify(control)}+'/checkpoint/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify({instruction:instructions[button.dataset.stage],...(await response.json())});}catch(error){document.getElementById('result').textContent=String(error);}finally{button.disabled=false;}};
</script></body></html>`;
    async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
      const h5Index = url.pathname === '/__h5', adminIndex = url.pathname === '/content/dise';
      if (h5Index || adminIndex) {
        const directory = h5Index ? h5 : admin, raw = await readFile(resolve(directory, 'index.html')); let served = raw;
        if (h5Index) { const style = '<style data-owned-footer-viewport>html{scrollbar-width:none!important}</style>'; expect(raw.toString()).toContain('</head>'); served = Buffer.from(raw.toString().replace('</head>', style + '</head>')); servedHtml.push({ scope: 'H5', raw_sha256: hash(raw), served_sha256: hash(served), viewport_only_augmentation: style }); }
        else servedHtml.push({ scope: 'Admin', raw_sha256: hash(raw), served_sha256: hash(raw), augmented: false });
        send(res, served); return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, ''), preferred = String(req.headers.referer ?? '').includes('/content/dise') ? [admin,h5] : [h5,admin];
      for (const directory of preferred) { const path = resolve(directory, relative); if (!path.startsWith(directory + sep)) continue; try { const raw = await readFile(path); staticPaths.push({ path: url.pathname, build: directory === admin ? 'Admin' : 'H5', sha256: hash(raw) }); const type: Record<string,string> = { '.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.ico':'image/x-icon' }; send(res, raw, 200, type[extname(path)] ?? 'application/octet-stream'); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EISDIR') throw error; } }
      throw Error('Unowned static path ' + url.pathname);
    }
    server = createServer((req, res) => { void (async () => {
      expect(req.socket.remoteAddress).toBe('127.0.0.1'); const url = new URL(req.url ?? '/', origin);
      if (url.pathname === '/') { expect(req.method).toBe('GET'); send(res, shell()); return; }
      if (url.pathname === control + '/state') { json(res, { checked: evidence.map(item => item.stage), next: stage(), pending, instructions: instructions[stage() ?? ''] }); return; }
      if (url.pathname === control + '/scene') { expect(req.method).toBe('POST'); await configure(req, res); return; }
      if (url.pathname.startsWith(control + '/checkpoint/')) { expect(req.method).toBe('POST'); await checkpoint(url.pathname.slice((control + '/checkpoint/').length), JSON.parse((await body(req)).toString()), res); return; }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/adminapi/')) { await api(req, res, url); return; }
      expect(req.method).toBe('GET'); await serveStatic(req, res, url);
    })().catch(async error => { failed = true; failure ??= error; await persistPartial(failure); if (!res.headersSent) json(res, { error: error instanceof Error ? error.message : String(error), stage: stage() }, 500); else res.end(); fail(error instanceof Error ? error : Error(String(error))); }); });
    await new Promise<void>((yes, no) => { server!.once('error', no); server!.listen(40779, '127.0.0.1', yes); });
    timer = setTimeout(() => { failed = true; failure = Error('Owned footer Browser30min deadline exceeded'); fail(failure as Error); }, 30 * 60_000);
    await writeFile(prefix + 'ready.json', JSON.stringify({ url: origin + '/', origin, control, plans, instructions, tables: f.tables, sequences: f.sequences, additional_tables: f.additionalTables, source: sourceBefore, h5: h5Before, admin: adminBefore, pid: process.pid, observed_source_frozen: true, expected: { initial_badges: { uid11:7,uid22:4,guest:0 }, after_actual_cart_num_uid11:8, icons: [f.platformImage.url,f.secondIcon.url], admin_row: 1, category: {layout:{level:2,index:2},root:701,children:[751,752],initial_products:[601,611]} }, boundary: 'Open url (origin+/) as the actual Browser shell. control is an HTTP API prefix, never a page entry. Root owns all actual CUA actions. Control only sets initial sessions/routes, explicit real configuration scenes and readonly DOM observations. It never invokes application methods or synthesizes clicks.' }, null, 2) + '\n');
    console.log('DIY footer Browser ready', origin); await completion;
  } catch (error) { failed = true; failure ??= error; throw error;
  } finally {
    if (timer) clearTimeout(timer); server?.closeAllConnections(); if (server?.listening) await new Promise<void>(yes => server!.close(() => yes())); await queue;
    let finalBeforeClose: DiyStateSnapshot | undefined, finalResources: Row | undefined, sourceAfter: Row[] = [], h5After: Row[] = [], adminAfter: Row[] = [], inspectionError: unknown;
    try {
      finalBeforeClose = await f.snapshot(); remember(finalBeforeClose); finalResources = resources(); sourceAfter = sourceBefore.length ? await sources() : []; h5After = h5Before.length ? await artifacts(h5) : []; adminAfter = adminBefore.length ? await artifacts(admin) : [];
      await persistPartial(failure);
    } catch (error) { inspectionError = error instanceof Error ? error.stack : String(error); }
    finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
    await writeFile(prefix + 'cleanup.json', JSON.stringify({ server_closed:true,database_fixture_closed:true,timer_cleared:true,external_mock_restored:true,checked:evidence.map(item=>item.stage),inspection_error:inspectionError,final_snapshot:finalBeforeClose,final_resources:finalResources,snapshots_by_sha256:snapshots,source_after:sourceAfter,h5_after:h5After,admin_after:adminAfter,source_drift:sourceBefore.length ? digest(sourceBefore)!==digest(sourceAfter) : null,h5_drift:h5Before.length ? digest(h5Before)!==digest(h5After) : null,admin_drift:adminBefore.length ? digest(adminBefore)!==digest(adminAfter) : null },null,2)+'\n');
    if (inspectionError && !failure) throw Error(String(inspectionError));
  }
}, 31 * 60_000);
