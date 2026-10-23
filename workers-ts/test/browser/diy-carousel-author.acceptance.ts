import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { OwnedFixedLengthStream } from '../helpers/adminProductVideoUpload';
import { diyCarouselAuthorFixture, expectedCarouselRootEdit, expectedCarouselAlternateEdit, expectedCarouselMicroEdit, DIY_CAROUSEL_AUTHOR_NAMES } from '../helpers/diyCarouselAuthorFixture';
import { carouselAuthorObserver } from '../helpers/diyCarouselAuthorObserver';
import { isNavigationAuthorBodyDisconnect, readNavigationAuthorBody as body, sendNavigationAuthorResponse } from '../helpers/diyNavigationAuthorTransport';
import { sortedDiyState, stableDiyState, type DiyStateRow as Row, type DiyStateSnapshot } from '../helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned carousel author SQL'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned carousel author Admin SQL'); return { container: wiring.container, close: async () => {} }; } }));
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
async function files(directory: string): Promise<string[]> { return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(row => row.isDirectory() ? files(resolve(directory, row.name)) : [resolve(directory, row.name)]))).flat().sort(); }

it('actual complete carousel author controls, three GUI saves and anonymous built H5 on owned PG16', async () => {
  vi.stubGlobal('FixedLengthStream', OwnedFixedLengthStream);
  const f = await diyCarouselAuthorFixture(new Date(), { namespace: 'public' }); wiring.container = f.container;
  const app = createApp(), repository = resolve(import.meta.dirname, '../../..'), origin = 'http://127.0.0.1:40785';
  const control = '/__carousel-author/' + randomUUID(), prefix = '/tmp/cinashop-diy-carousel-author-browser-';
  const h5 = resolve(repository, 'view/uniapp-ts/dist/build/h5'), admin = resolve(repository, 'view/admin-ts/dist');
  const plans = ['admin', 'minimal', 'reader', 'rootOpen', 'catalog', 'latePending', 'lateClosed', 'lateReleased', 'rootReopened', 'styles', 'rootEdited', 'rootSaved', 'rootH5', 'typedMicro', 'typedCategory', 'alternateOpen', 'alternateEdited', 'alternateSaved', 'alternateH5', 'microOpen', 'microNoop', 'microEdited', 'microSaved', 'microH5', 'finished'];
  const evidence: Row[] = [], traces: Row[] = [], setup: Row[] = [], writes: Row[] = [], transport: Row[] = [], staticPaths: Row[] = [], servedHtml: Row[] = [];
  const snapshots: Record<string, DiyStateSnapshot> = {}, remember = (value: DiyStateSnapshot) => { const id = digest(value); snapshots[id] ??= structuredClone(value); return id; };
  const initialRoot = f.rootBlocks, initialMicro = f.microBlocks, editedRoot = expectedCarouselRootEdit(f), alternateRoot = expectedCarouselAlternateEdit(f), editedMicro = expectedCarouselMicroEdit(f);
  let expected = await f.snapshot(), sourceBefore: Row[] = [], h5Before: Row[] = [], adminBefore: Row[] = [], server: Server | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let pending = 0, businessSave = 0, failure: unknown, lastObservation: Row | undefined, holdGallery = false;
  const held: Array<{ res: ServerResponse; release: () => void; trace: Row }> = [];
  const resources = () => f.resources(), initialResources = resources(), stage = () => plans[evidence.length]; remember(expected);
  let done!: () => void, fail!: (reason: Error) => void; const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  let queue = Promise.resolve(); function serial<T>(fn: () => Promise<T>) { const next = queue.then(fn); queue = next.then(() => {}, () => {}); return next; }
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned carousel author acceptance forbids external provider I/O'));
  const row = (id: number) => expected.system_dise.find(item => item.id === id)!;
  const send = (res: ServerResponse, value: string | Uint8Array, status = 200, type = 'text/html') => sendNavigationAuthorResponse(res, value, status, type, () => {
    transport.push({ kind: 'actual-client-disconnect', phase: 'response', method: res.req.method, path: res.req.url, request_aborted: res.req.aborted, response_destroyed: res.destroyed });
  });
  const json = (res: ServerResponse, value: unknown, status = 200) => send(res, JSON.stringify(value), status, 'application/json');
  const sources = async () => {
    const selected = ['workers-ts/test/browser/diy-carousel-author.acceptance.ts', 'workers-ts/vitest.diy-carousel-author-browser.config.ts', 'workers-ts/scripts/run-local-finance-postgres.mjs', 'workers-ts/package.json', 'workers-ts/package-lock.json', 'workers-ts/test/fixtures/diy-carousel-author-defaults.json', 'workers-ts/test/fixtures/diy-navigation-author-defaults.json', 'workers-ts/test/fixtures/community-teal.png', 'view/uniapp-ts/package.json', 'view/uniapp-ts/package-lock.json', 'view/admin-ts/package.json', 'view/admin-ts/package-lock.json'];
    const all = [...selected.map(path => resolve(repository, path)), ...await files(resolve(repository, 'workers-ts/src')), ...await files(resolve(repository, 'workers-ts/test/helpers')), ...await files(resolve(repository, 'view/admin-ts/src')), ...await files(resolve(repository, 'view/uniapp-ts/src')), ...await files(resolve(repository, 'view/common'))];
    return Promise.all([...new Set(all)].sort().map(async path => ({ path: path.slice(repository.length + 1), sha256: hash(await readFile(path)) })));
  };
  const artifacts = async (directory: string) => Promise.all((await files(directory)).map(async path => ({ path: path.slice(directory.length + 1), sha256: hash(await readFile(path)) })));
  async function dispatch(path: string, method = 'GET', raw?: Buffer, incoming?: IncomingMessage, token?: string) {
    const headers = new Headers(); if (incoming) for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
    if (token) headers.set('Authori-zation', 'Bearer ' + token); if (raw?.length) headers.set('Content-Type', 'application/json');
    const waits: Promise<unknown>[] = [], response = await app.fetch(new Request('https://127.0.0.1:40785' + path, { method, headers, ...(raw?.length ? { body: raw } : {}) }), f.env,
      { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(waits); const bytes = Buffer.from(await response.arrayBuffer());
    return { response, bytes, payload: response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(bytes.toString()) as Row : undefined };
  }
  async function measured(path: string, token: string | undefined, label: string, wanted: number) {
    const before = await f.snapshot(), beforeResources = resources(), result = await dispatch(path, 'GET', undefined, undefined, token), after = await f.snapshot();
    expect(result.payload?.status ?? result.response.status).toBe(wanted); expect(after).toEqual(before); expect(resources()).toEqual(beforeResources);
    traces.push({ path: path.split('?')[0], query: new URL(path, origin).search, method: 'GET', actor: label, phase: 'actual-read-only-preflight', synthetic: false, status: wanted, material: result.payload?.data,
      before: remember(before), after: remember(after), unchanged: true, resources_before: beforeResources, resources_after: resources() }); return result.payload?.data;
  }
  function writeDiff(before: DiyStateSnapshot, after: DiyStateSnapshot, id: number, value: Row[], result: Row) {
    const want = structuredClone(before), target = want.system_dise.find(item => item.id === id)!;
    Object.assign(target, { value: JSON.stringify(value), version: result.version, update_time: result.update_time }); expect(after).toEqual(sortedDiyState(want));
    expect(after.system_dise.find(item => item.id === id)!.content).toBe(before.system_dise.find(item => item.id === id)!.content);
  }
  const persist = async () => writeFile(prefix + 'partial.json', JSON.stringify({ status: failure ? 'failed' : 'running', error: failure instanceof Error ? failure.stack : failure, next: stage(), evidence, traces, setup, writes, transport,
    snapshots_by_sha256: snapshots, observation: lastObservation, source_before: sourceBefore, h5_before: h5Before, admin_before: adminBefore }, null, 2) + '\n');
  const instructions: Row = {
    admin: '真实Admin列表。',
    minimal: '点最小作者，编辑ID1。homeComb读取平台25词，图片链接目录浏览/关闭，分类目标分别浏览微页和商品分类，覆盖5个GET。回homeComb或swiperBg显示真实图库disabled；完整JSON不变。',
    reader: '点只读账号，编辑ID1；轮播新增/字段/图库/链接禁用，完整JSON不变。',
    rootOpen: '点真实Admin，编辑轮播作者首页ID1；三族和独立content不变。',
    catalog: '在轮播图片链接打开真实目录，依次浏览13类；分类可下钻、坏历史链接disabled；不选、不改JSON。',
    latePending: '外层暂缓下一图库，在homeComb logo打开图库；真实列表已完成但暂缓投递，pending0/held1。',
    lateClosed: '实际关闭图库，再取消父编辑对话框；旧响应仍held。',
    lateReleased: '外层释放图库旧响应，再编辑ID1；旧响应不能选图或改JSON。',
    rootReopened: '原始ID1三族恢复，JSON/content不变。',
    styles: '真实选择swiperBg依次风格0/1/2，再homeComb风格0/1；每次等实际预览更新。observer只从真实trusted输入记录5种Admin预览，无POST。最终bg2/home1。',
    rootEdited: 'homeComb：吸顶搜索、提示轮播作者搜索，logo选footer-unselected.png；读取25词选作者热词25；时长4、分类间距22。分类0标题作者微页/目标轮播作者微页2；分类1标题作者分类/目标作者子分类84022。图片0选同secondIcon、标题作者图、链接个人作者个人中心链接。swiperBg：风格2，图片0secondIcon、商品84031链接；指示器3位置2色调自定义1、选中#123456未选中#abcdef、间隙6、分角值UI左上1/右上2/右下4/左下3。legacy：图片0secondIcon、链接基础作者首页链接，页面上间距8。其余全部保留。',
    rootSaved: '真实点击保存第1次，等父dialog关闭。',
    rootH5: '外层匿名首页：现代两族+legacy实际轮播、两张真实PNG完成。',
    typedMicro: '真实点击首页homeComb作者微页tab，实际get_diy/2和轮播作者导入微页正文；主homeComb仍保留，child homeComb被剔除。',
    typedCategory: '真实点击主homeComb作者分类tab，实际category/products只读GET，子分类84022和作者目录商品出现。',
    alternateOpen: '回真实Admin编辑ID1，原已保存root值不变。',
    alternateEdited: 'homeComb风格0/隐藏分类；swiperBg风格1/默认色调0；legacy静态广告tab0/方形指示器type1。原自定义颜色和gap等隐藏字段保留。',
    alternateSaved: '真实保存第2次。', alternateH5: '外层匿名首页新实例：现代两族、home分类隐藏，legacy两张静态广告。',
    microOpen: '回真实Admin编辑ID2导入微页。',
    microNoop: '真实逐项选择homeComb num0/23热词、隐藏重复home num101、swiperBg1e30/.0005/空白指数分角、legacy27图和空白指数rpx；查看/失焦不改写导入值，JSON完全保持。最后选swiperBg图片0。',
    microEdited: '仅swiperBg图片0标题改微页保留；所有微小、字符串、0/101、true、超普通新增数量和未知邻居/footer保持。',
    microSaved: '真实保存第3次。', microH5: '外层匿名微页2：三族加载真实图片、全部导入原字段保持且新标题已发布。',
    finished: '3次实际GUI业务POST；全部GET全表/序列/KV/R2/queue/IMAGES零写并收尾。',
  };
  const saves: Record<string, { id: number; value: Row[] }> = { rootSaved: { id: 1, value: editedRoot }, alternateSaved: { id: 1, value: alternateRoot }, microSaved: { id: 2, value: editedMicro } };
  try {
    setup.push({ ...f.carouselAuthorSetup }, { phase: 'inherited owned setup', footer_before: f.beforeBrowserSetup, footer_after: f.afterBrowserSetup, page_settings: f.pageSettingsSetup });
    expect(f.tables).toContain('store_product_words'); expect(f.tables).toContain('page_link'); expect(f.tables).toContain('system_dise'); expect(f.tables.length).toBeGreaterThan(73);
    for (const prefix of ['/adminapi', '/api/admin']) for (const [resource, query] of [['hot-words',''],['link-categories',''],['link-targets','?kind=product'],['tab-categories',''],['tab-targets','?kind=special']]) {
      const path = prefix + '/dise/author-options/' + resource + query;
      await measured(path, f.minimalToken, 'actual-minimal903', 200); await measured(path, f.readerToken, 'actual-reader902', 400011); await measured(path, undefined, 'actual-guest', 410000);
    }
    const categories = await measured('/adminapi/dise/author-options/link-categories', f.adminToken, 'actual-admin901', 200); expect(categories.list).toHaveLength(13);
    for (const category of categories.list) { const data = await measured('/adminapi/dise/author-options/link-targets?kind=' + category.kind, f.adminToken, 'actual-admin901', 200); expect(data.list.some((item: Row) => item.selectable)).toBe(true); }
    expect((await measured('/adminapi/dise/author-options/hot-words', f.adminToken, 'actual-admin901', 200)).list).toHaveLength(25);
    for (const path of ['/adminapi/setting/fab/link-targets?kind=product', '/adminapi/product/words/get_all', '/adminapi/file/file']) await measured(path, f.minimalToken, 'actual-minimal903', 400011);
    expect(await f.snapshot()).toEqual(expected); expect(resources()).toEqual(initialResources);
    sourceBefore = await sources(); h5Before = await artifacts(h5); adminBefore = await artifacts(admin); expect(h5Before.length).toBeGreaterThan(100); expect(adminBefore.length).toBeGreaterThan(20);
    const chrome: Row = { '/api/site_config': { site_name: '轮播作者完整验收', site_logo: '', record_No: '', ico_path: '' }, '/api/share': { title: '轮播作者', synopsis: '', img: '' },
      '/api/get_open_adv': { status: 0, time: 3, interval_time: 24, type: 'pic', value: [], video_link: '' }, '/api/v2/diy/color_change/color_change': {}, '/adminapi/new_push': { ordernum: 0, inventory: 0, commentnum: 0, reflectnum: 0, msgcount: 0, sampled_at: Math.floor(Date.now()/1000) } };
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      pending++; try { await serial(async () => {
        const raw = await body(req), method = req.method ?? 'GET', before = await f.snapshot(), startResources = resources(), reads = f.bucket.get.mock.calls.length, path = url.pathname;
        expect(before).toEqual(expected); const header = req.headers['authori-zation'] || req.headers.authorization, token = typeof header === 'string' ? header.replace(/^Bearer\s+/u, '').trim() : '';
        const actor = token === f.adminToken ? 901 : token === f.minimalToken ? 903 : token === f.readerToken ? 902 : 0;
        if (Object.hasOwn(chrome, path)) { expect(method).toBe('GET'); expect(raw.length).toBe(0); traces.push({ path, query: url.search, method, stage: stage(), actor, synthetic: true, declared: 'unrelated branding/advert/theme/Admin notification chrome only', before: remember(before), after: remember(before), unchanged: true, resources_before: startResources, resources_after: resources() }); json(res, { status: 200, msg: 'Declared unrelated chrome only', data: chrome[path] }); return; }
        if (method === 'GET') expect(raw.length).toBe(0); else { expect(method).toBe('POST'); expect(path).toBe('/adminapi/dise/save'); expect(Object.hasOwn(saves, stage() ?? '')).toBe(true); expect(actor).toBe(901); }
        const result = await dispatch(path + url.search, method, raw, req), after = await f.snapshot();
        if (method === 'POST') {
          const target = saves[stage()!]!, input = JSON.parse(raw.toString()), old = row(target.id);
          expect(input).toEqual({ id: target.id, name: old.name.trim(), title: old.title.trim(), value: JSON.stringify(target.value), content: old.content, status: old.status });
          expect(result.payload?.status).toBe(200); writeDiff(before, after, target.id, target.value, result.payload!.data);
          expected = after; businessSave++; writes.push({ stage: stage(), input, before: remember(before), after: remember(after), allowed: ['system_dise.' + target.id + '.value', 'system_dise.' + target.id + '.version', 'system_dise.' + target.id + '.update_time'] });
        } else expect(after).toEqual(before);
        expect(resources()).toEqual(startResources);
        expect(result.payload ? [200,400011,410000,410002].includes(result.payload.status) : [200,206,404].includes(result.response.status)).toBe(true);
        const trace: Row = { path, query: url.search, method, actor, stage: stage(), synthetic: false, status: result.payload?.status ?? result.response.status, material: result.payload?.data,
          before: remember(before), after: remember(after), unchanged: digest(before) === digest(after), resources_before: startResources, resources_after: resources(), r2_reads: f.bucket.get.mock.calls.length - reads, bytes: result.bytes.length, body_sha256: hash(result.bytes) };
        traces.push(trace);
        const deliver = () => { if (res.destroyed) { trace.transport = 'client-closed-before-delivery'; return; } const headers: Record<string,string> = {}; result.response.headers.forEach((value,key) => { if (!['content-length','content-encoding','transfer-encoding','connection'].includes(key.toLowerCase())) headers[key] = value; }); res.writeHead(result.response.status, headers); res.end(result.bytes); trace.delivered = true; };
        if (holdGallery && path === '/adminapi/file/file') { holdGallery = false; held.push({ res, release: deliver, trace }); trace.transport = 'actual-response-held-after-complete-read'; return; } deliver();
      }); } finally { pending--; }
    }
    function assertH5(data: Row, micro = false, alternate = false) {
      expect(data.clientWidth).toBe(375); expect(data.scrollWidth).toBeLessThanOrEqual(375); expect(new URL(data.href).pathname).toBe('/__h5');
      expect(data.widgets.map((item: Row) => item.kind).sort()).toEqual([...DIY_CAROUSEL_AUTHOR_NAMES].sort());
      expect(data.bodyText).toContain(micro ? '轮播作者导入微页正文' : '轮播作者首页正文');
      const home = data.widgets.find((item: Row) => item.kind === 'homeComb'), background = data.widgets.find((item: Row) => item.kind === 'swiperBg'), legacy = data.widgets.find((item: Row) => item.kind === 'swipers');
      expect(home.slides).toBe(2); expect(background.slides).toBe(2); expect(legacy.slides).toBe(micro ? 27 : 2);
      expect(legacy.stacked).toBe(alternate ? 2 : 0); expect(home.tabs).toHaveLength(alternate ? 0 : 5);
      if (!micro) expect(data.bodyText).toContain('作者热词25');
      for (const widget of data.widgets) { expect(widget.canvasState).toBe('ready'); expect(widget.box.width).toBeGreaterThan(0); expect(widget.box.width).toBeLessThanOrEqual(376); if (!widget.stacked) expect(widget.height).toBeGreaterThan(0); }
      for (const asset of [f.platformImage, f.secondIcon]) expect(data.images.some((image: Row) => image.src.includes(asset.url + '?') && image.complete && image.naturalWidth === 160 && image.naturalHeight === 90)).toBe(true);
      expect(traces.some(item => item.path === (micro ? '/api/diy/get_diy/2' : '/api/diy/get_diy/0') && item.status === 200 && !item.synthetic)).toBe(true);
    }
    async function checkpoint(name: string, data: Row, res: ServerResponse) { expect(pending).toBe(0); await serial(async () => {
      lastObservation = data; expect(name).toBe(stage()); expect(data.loaded).toBe(true); expect(data.errors).toEqual([]); expect(data.consoleErrors).toEqual([]); expect(data.jsonEdits).toEqual([]);
      const gui = traces.filter(item => item.phase !== 'actual-read-only-preflight' && !item.synthetic);
      if (['admin','minimal','reader'].includes(name)) {
        expect(data.href).toContain('/content/dise'); if (name !== 'admin') { expect(data.admin.editor).toBe(true); expect(JSON.parse(data.admin.value)).toEqual(initialRoot);
          if (name === 'minimal') { expect(data.admin.addDisabled).toBe(false); expect(data.admin.imageButtons.length).toBeGreaterThan(0); expect(data.admin.imageButtons.every((item: Row) => item.disabled)).toBe(true);
            for (const resource of ['hot-words','link-categories','link-targets','tab-categories','tab-targets']) expect(gui.some(item => item.actor === 903 && item.path.endsWith('/' + resource) && item.status === 200)).toBe(true);
          } else expect(data.admin.addDisabled).toBe(true);
        }
      } else if (['rootOpen','catalog','latePending','lateReleased','rootReopened'].includes(name)) {
        expect(data.admin.editor).toBe(true); expect(JSON.parse(data.admin.value)).toEqual(initialRoot); expect(data.admin.content).toBe(row(1).content);
        if (name === 'catalog') for (const category of categories.list) expect(gui.some(item => item.actor === 901 && item.path.endsWith('/link-targets') && new URLSearchParams(item.query).get('kind') === category.kind && item.status === 200)).toBe(true);
        if (name === 'latePending') expect(held).toHaveLength(1); if (name === 'lateReleased') expect(held).toHaveLength(0);
      } else if (name === 'lateClosed') { expect(data.admin.dialog).toBe(false); expect(held).toHaveLength(1); }
      else if (name === 'styles') {
        const captures = data.styles.filter((item: Row) => item.trusted);
        for (const [kind, count] of [['swiperBg',3],['homeComb',2]] as const) for (let layout = 0; layout < count; layout++) {
          const capture = captures.find((item: Row) => item.kind === kind && item.layout === layout);
          expect(capture, `${kind} real Admin preview style${layout}`).toBeDefined(); expect(capture.box.width).toBe(375); expect(capture.box.height).toBeGreaterThan(0);
        }
        expect(businessSave).toBe(0); expect(data.jsonEdits).toEqual([]);
      }
      else if (['rootEdited','alternateEdited','microNoop','microEdited','microOpen','alternateOpen'].includes(name)) {
        expect(data.admin.editor).toBe(true); const wanted = name === 'rootEdited' ? editedRoot : name === 'alternateEdited' ? alternateRoot : name === 'alternateOpen' ? editedRoot : name === 'microEdited' ? editedMicro : initialMicro;
        expect(JSON.parse(data.admin.value)).toEqual(wanted); expect(data.admin.content).toBe(row(name.startsWith('micro') ? 2 : 1).content);
      } else if (Object.hasOwn(saves, name)) { expect(data.admin.dialog).toBe(false); expect(businessSave).toBe(['rootSaved','alternateSaved','microSaved'].indexOf(name)+1); }
      else if (['rootH5','alternateH5','microH5'].includes(name)) assertH5(data, name === 'microH5', name === 'alternateH5');
      else if (name === 'typedMicro') {
        expect(data.bodyText).toContain('轮播作者导入微页正文'); expect(gui.some(item => item.path === '/api/diy/get_diy/2' && item.status === 200)).toBe(true);
        expect(data.widgets.filter((item: Row) => item.kind === 'homeComb')).toHaveLength(1);
        expect(data.widgets.find((item: Row) => item.kind === 'homeComb').tabs.find((item: Row) => item.index === 1).selected).toBe(true);
      } else if (name === 'typedCategory') {
        expect(data.categories.some((item: Row) => item.id === 84022 && item.text.includes('作者目录商品'))).toBe(true);
        expect(gui.some(item => item.path === '/api/category' && item.status === 200)).toBe(true);
        expect(gui.some(item => item.path === '/api/products' && item.status === 200 && new URLSearchParams(item.query).get('sid') === '84022')).toBe(true);
      }
      else expect(name).toBe('finished');
      expect(await f.snapshot()).toEqual(expected); expect(resources()).toEqual(initialResources);
      evidence.push({ stage: name, at: Date.now(), observation: data, traceCount: traces.length, snapshot: remember(await f.snapshot()), resources: resources() }); await persist();
      await writeFile(prefix + 'progress.json', JSON.stringify({ checked: evidence.map(item => item.stage), next: stage(), traces: traces.length, business_save_count: businessSave }) + '\n');
      if (name === 'finished') {
        expect(businessSave).toBe(3); expect(held).toHaveLength(0); expect(external).not.toHaveBeenCalled();
        const sourceAfter = await sources(), h5After = await artifacts(h5), adminAfter = await artifacts(admin); expect(sourceAfter).toEqual(sourceBefore); expect(h5After).toEqual(h5Before); expect(adminAfter).toEqual(adminBefore);
        await writeFile(prefix + 'evidence.json', JSON.stringify({ status: 'passed-all-25-checkpoints', plans, evidence, traces, setup, writes, transport, snapshots_by_sha256: snapshots,
          tables: f.tables, sequences: f.sequences, source_before: sourceBefore, source_after: sourceAfter, h5_before: h5Before, h5_after: h5After, admin_before: adminBefore, admin_after: adminAfter,
          static_paths: staticPaths, served_html: servedHtml, resources_before: initialResources, resources_after: resources(), business_save_count: businessSave,
          boundaries: ['Real built Admin/H5 and actual Worker/owned PG16/R2 metadata and bytes; unrelated chrome alone declared synthetic.', 'Exactly three real GUI Admin saves. All five modern style combinations are actually visited in Admin; H5 is root bg2/home1/legacycarousel, alternate bg1/home0/legacystatic and imported micro. Native/runtime cover the full independent style/indicator matrix; Browser does not claim all matrix combinations.', 'Browser uses owned maintenance SQL DI boundary; actual distinct production app/Admin LOGIN ACLs are separately verified by author-options native tests.', 'Late response is a real completed gallery response held at HTTP transport and released after closure; cancellation is not misreported as an abort-ignoring application callback.', 'No MP/App physical-device rendering or production deployment claim.'] }, null, 2) + '\n'); done();
      }
      json(res, { checked: evidence.map(item => item.stage), next: stage(), instruction: instructions[stage() ?? ''] });
    }); }
    const shell = () => {
      const bootstrap = { control, sessions: { admin: { token: f.adminToken, session: f.adminSession }, minimal: { token: f.minimalToken, session: f.minimalSession }, reader: { token: f.readerToken, session: f.readerSession } } };
      return '<!doctype html><html lang="zh"><meta charset="utf-8"><title>真实轮播作者验收</title><style>body{font:13px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:1200px;height:900px;border:1px solid #ddd}pre{max-height:100px;overflow:auto;white-space:pre-wrap}</style><body><h1>真实轮播作者/Admin/H5</h1>' +
        '<button data-route="admin">真实Admin</button><button data-route="minimal">最小作者</button><button data-route="reader">只读账号</button><button data-route="home">匿名首页</button><button data-route="micro">匿名微页</button><button data-control="hold-gallery">暂缓下一图库</button><button data-control="release-gallery">释放图库旧响应</button>' +
        plans.map(name => '<button data-stage="' + name + '">' + name + '</button>').join('') + '<pre id="result"></pre><iframe title="真实应用验收帧"></iframe><script>' + carouselAuthorObserver.replace('__BOOTSTRAP__', JSON.stringify(bootstrap)) + '</script></body></html>';
    };
    async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
      if (url.pathname === '/__h5' || url.pathname === '/content/dise') { const h5Index = url.pathname === '/__h5', raw = await readFile(resolve(h5Index ? h5 : admin, 'index.html'));
        const augmentation = '<style data-owned-carousel-scrollbar>html{scrollbar-width:none!important}</style>', served = h5Index ? Buffer.from(raw.toString().replace('</head>', augmentation + '</head>')) : raw;
        servedHtml.push({ scope: h5Index ? 'H5' : 'Admin', raw_sha256: hash(raw), served_sha256: hash(served), augmentation: h5Index ? augmentation : null }); send(res, served); return; }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, ''), preferred = String(req.headers.referer ?? '').includes('/content/dise') ? [admin,h5] : [h5,admin];
      for (const directory of preferred) { const path = resolve(directory, relative); if (!path.startsWith(directory + sep)) continue; try {
        const raw = await readFile(path), types: Record<string,string> = { '.js':'application/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.woff2':'font/woff2','.ico':'image/x-icon' };
        staticPaths.push({ path: url.pathname, build: directory === admin ? 'Admin' : 'H5', sha256: hash(raw) }); send(res, raw, 200, types[extname(path)] ?? 'application/octet-stream'); return;
      } catch (reason) { if (!['ENOENT','EISDIR'].includes((reason as NodeJS.ErrnoException).code ?? '')) throw reason; } }
      throw Error('Unowned static path ' + url.pathname);
    }
    server = createServer((req, res) => { void (async () => {
      expect(req.socket.remoteAddress).toBe('127.0.0.1'); const url = new URL(req.url ?? '/', origin);
      if (url.pathname === '/') { expect(req.method).toBe('GET'); send(res, shell()); return; }
      if (url.pathname === control + '/state') { json(res, { next: stage(), checked: evidence.map(item => item.stage), pending, held: held.length, instruction: instructions[stage() ?? ''] }); return; }
      if (url.pathname === control + '/transport') { expect(req.method).toBe('POST'); const input = JSON.parse((await body(req)).toString());
        expect(['hold-gallery','release-gallery']).toContain(input.action); expect(stage()).toBe(input.action === 'hold-gallery' ? 'latePending' : 'lateReleased');
        const before = await f.snapshot(), start = resources(); if (input.action === 'hold-gallery') holdGallery = true; else { expect(held).toHaveLength(1); for (const item of held.splice(0)) item.release(); }
        expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(start); transport.push({ action: input.action, stage: stage(), before: remember(before), after: remember(before), resources: start }); json(res, { next: stage(), held: held.length }); return;
      }
      if (url.pathname.startsWith(control + '/checkpoint/')) { expect(req.method).toBe('POST'); await checkpoint(url.pathname.slice((control + '/checkpoint/').length), JSON.parse((await body(req)).toString()), res); return; }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/adminapi/')) { await api(req, res, url); return; }
      expect(req.method).toBe('GET'); await serveStatic(req, res, url);
    })().catch(async reason => {
      if (isNavigationAuthorBodyDisconnect(reason, req)) {
        transport.push({ kind: 'actual-client-disconnect', phase: 'request-body-before-dispatch', method: req.method, path: req.url, request_aborted: req.aborted, response_destroyed: res.destroyed });
        await persist(); return;
      }
      failure ??= reason; await persist(); if (!res.headersSent) json(res, { error: reason instanceof Error ? reason.message : String(reason), stage: stage() }, 500); else res.end(); fail(reason instanceof Error ? reason : Error(String(reason)));
    }); });
    await new Promise<void>((yes, no) => { server!.once('error', no); server!.listen(40785, '127.0.0.1', yes); });
    timer = setTimeout(() => { failure = Error('Owned carousel author Browser deadline exceeded'); fail(failure as Error); }, 63 * 60_000);
    await writeFile(prefix + 'ready.json', JSON.stringify({ url: origin + '/', origin, control, plans, instructions, pid: process.pid, tables: f.tables, sequences: f.sequences, source: sourceBefore, h5: h5Before, admin: adminBefore,
      expected: { initialRoot, initialMicro, editedRoot, alternateRoot, editedMicro, platformImage: f.platformImage, secondIcon: f.secondIcon, supplierImage: f.supplierImage, phases: 'three GUI business saves only' },
      boundary: 'Only initial true persisted-role sessions and HTTP response transport gating are outer controls. No app method invocation, application event dispatch or fabricated business DTO.' }, null, 2) + '\n');
    console.log('DIY carousel author Browser ready', origin); await completion;
  } catch (reason) { failure ??= reason; throw reason; }
  finally {
    if (timer) clearTimeout(timer); for (const item of held.splice(0)) item.res.destroy(); server?.closeAllConnections(); if (server?.listening) await new Promise<void>(yes => server!.close(() => yes())); await queue;
    let finalSnapshot: DiyStateSnapshot | undefined, sourceAfter: Row[] = [], h5After: Row[] = [], adminAfter: Row[] = [], inspectionError: unknown;
    try { finalSnapshot = await f.snapshot(); remember(finalSnapshot); sourceAfter = sourceBefore.length ? await sources() : []; h5After = h5Before.length ? await artifacts(h5) : []; adminAfter = adminBefore.length ? await artifacts(admin) : []; await persist(); }
    catch (reason) { inspectionError = reason instanceof Error ? reason.stack : String(reason); }
    finally { external.mockRestore(); wiring.container = undefined; vi.unstubAllGlobals(); await f.close(); }
    await writeFile(prefix + 'cleanup.json', JSON.stringify({ server_closed: true, database_fixture_closed: true, timer_cleared: true, external_restored: true, fixed_stream_restored: true, checked: evidence.map(item => item.stage), inspection_error: inspectionError,
      final_snapshot: finalSnapshot, snapshots_by_sha256: snapshots, final_resources: resources(), source_after: sourceAfter, h5_after: h5After, admin_after: adminAfter,
      source_drift: sourceBefore.length ? digest(sourceBefore) !== digest(sourceAfter) : null, h5_drift: h5Before.length ? digest(h5Before) !== digest(h5After) : null, admin_drift: adminBefore.length ? digest(adminBefore) !== digest(adminAfter) : null }, null, 2) + '\n');
    if (inspectionError && !failure) throw Error(String(inspectionError));
  }
}, 65 * 60_000);
