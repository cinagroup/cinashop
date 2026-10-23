import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { OwnedFixedLengthStream } from '../helpers/adminProductVideoUpload';
import { diyNavigationAuthorFixture, expectedNavigationRootEdit, expectedNavigationCustomEdit, DIY_NAVIGATION_AUTHOR_NAMES } from '../helpers/diyNavigationAuthorFixture';
import { navigationAuthorObserver } from '../helpers/diyNavigationAuthorObserver';
import { isNavigationAuthorBodyDisconnect, readNavigationAuthorBody as body, sendNavigationAuthorResponse } from '../helpers/diyNavigationAuthorTransport';
import { sortedDiyState, stableDiyState, type DiyStateRow as Row, type DiyStateSnapshot } from '../helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned navigation author SQL'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned navigation author Admin SQL'); return { container: wiring.container, close: async () => {} }; } }));
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
async function files(directory: string): Promise<string[]> { return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(row => row.isDirectory() ? files(resolve(directory, row.name)) : [resolve(directory, row.name)]))).flat().sort(); }

it('actual complete navigation author controls, three GUI saves and anonymous built H5 on owned PG16', async () => {
  vi.stubGlobal('FixedLengthStream', OwnedFixedLengthStream);
  const f = await diyNavigationAuthorFixture(new Date(), { namespace: 'public' }); wiring.container = f.container;
  const app = createApp(), repository = resolve(import.meta.dirname, '../../..'), origin = 'http://127.0.0.1:40785';
  const control = '/__navigation-author/' + randomUUID(), prefix = '/tmp/cinashop-diy-navigation-author-browser-';
  const h5 = resolve(repository, 'view/uniapp-ts/dist/build/h5'), admin = resolve(repository, 'view/admin-ts/dist');
  const plans = ['admin', 'minimal', 'reader', 'rootOpen', 'catalog', 'latePending', 'lateClosed', 'lateReleased', 'rootReopened', 'layouts', 'rootEdited', 'rootSaved', 'rootH5', 'menuSecond', 'typedMicro', 'customOpen', 'customEdited', 'customSaved', 'customH5', 'microOpen', 'microNoop', 'microEdited', 'microSaved', 'microH5', 'finished'];
  const evidence: Row[] = [], traces: Row[] = [], setup: Row[] = [], writes: Row[] = [], transport: Row[] = [], staticPaths: Row[] = [], servedHtml: Row[] = [];
  const snapshots: Record<string, DiyStateSnapshot> = {}, remember = (value: DiyStateSnapshot) => { const id = digest(value); snapshots[id] ??= structuredClone(value); return id; };
  const initialRoot = f.rootBlocks, initialMicro = f.microBlocks, editedRoot = expectedNavigationRootEdit(f), customRoot = expectedNavigationCustomEdit(f), editedMicro = structuredClone(initialMicro);
  editedMicro.find(row => row.name === 'menus')!.menuConfig.list[0].info[0].value = '微页保留';
  let expected = await f.snapshot(), sourceBefore: Row[] = [], h5Before: Row[] = [], adminBefore: Row[] = [], server: Server | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let pending = 0, businessSave = 0, failure: unknown, lastObservation: Row | undefined, holdGallery = false;
  const held: Array<{ res: ServerResponse; release: () => void; trace: Row }> = [];
  const resources = () => f.resources(), initialResources = resources(), stage = () => plans[evidence.length]; remember(expected);
  let done!: () => void, fail!: (reason: Error) => void; const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  let queue = Promise.resolve(); function serial<T>(fn: () => Promise<T>) { const next = queue.then(fn); queue = next.then(() => {}, () => {}); return next; }
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned navigation author acceptance forbids external provider I/O'));
  const row = (id: number) => expected.system_dise.find(item => item.id === id)!;
  const send = (res: ServerResponse, value: string | Uint8Array, status = 200, type = 'text/html') => sendNavigationAuthorResponse(res, value, status, type, () => {
    transport.push({ kind: 'actual-client-disconnect', phase: 'response', method: res.req.method, path: res.req.url, request_aborted: res.req.aborted, response_destroyed: res.destroyed });
  });
  const json = (res: ServerResponse, value: unknown, status = 200) => send(res, JSON.stringify(value), status, 'application/json');
  const sources = async () => {
    const selected = ['workers-ts/test/browser/diy-navigation-author.acceptance.ts', 'workers-ts/vitest.diy-navigation-author-browser.config.ts', 'workers-ts/scripts/run-local-finance-postgres.mjs', 'workers-ts/package.json', 'workers-ts/package-lock.json', 'workers-ts/test/fixtures/diy-navigation-author-defaults.json', 'workers-ts/test/fixtures/community-teal.png', 'view/uniapp-ts/package.json', 'view/uniapp-ts/package-lock.json', 'view/admin-ts/package.json', 'view/admin-ts/package-lock.json'];
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
    minimal: '点最小作者；实际编辑ID1，搜索框读取平台25词；菜单链接和tab真实目标只浏览/关闭，覆盖5 GET；图库应disabled，JSON无变。',
    reader: '点只读账号；编辑ID1，导航新增/字段/图库/链接禁用；JSON无变。',
    rootOpen: '点真实Admin，编辑导航作者首页ID1；四族源与content不变。',
    catalog: '在菜单第一项打开真实链接目录；依次浏览13种类别，分类可下钻，坏历史链接disabled；不选择、不改JSON。',
    latePending: '外层先点暂缓下一图库；在logo图库打开。真实列表响应已完成但暂缓投递，pending业务=0、held=1。',
    lateClosed: '实际关闭图库，再取消/关闭父编辑页；保持尚未投递。',
    lateReleased: '外层释放图库旧响应；重新编辑ID1，旧响应不能选图或改JSON。',
    rootReopened: '父编辑器回到ID1原四族，完整JSON与content不变。',
    layouts: '选图片魔方，真实点击0..11全部12布局按钮，每次等待预览更新；observer记录trusted click+真实preview。此时无业务POST。',
    rootEdited: '完成第一份材料：搜索提示作者迁移搜索、logo选footer-unselected.png、首词作者热词25；tab0标题作者微页/选真实微页2，tab1标题作者分类/父类下选作者子分类84022；菜单分页1行3列，首项作者菜单/secondIcon/真实商品84031链接，隐藏第2项；魔方选横排两图1，明确trim至2槽，首图secondIcon、首页链接、间隙2，最后选择第1槽。',
    rootSaved: '实际点击Admin保存第1次，等父dialog关闭。',
    rootH5: '外层匿名首页；四族与两种真实PNG完成，菜单首页槽0/2、cube两图。',
    menuSecond: '真实点击H5菜单第二页指示器，第二页槽3/4/5。',
    typedMicro: '真实点击H5作者微页tab；实际get_diy/2与导入微页正文出现。',
    customOpen: '回真实Admin，编辑ID1并选图片魔方。',
    customEdited: '选布局11；真实画布网格1和6画一矩形，再坐标x=.25,y=.5,w=93.75,h=187.25；图库选diy-editorial.png平台图，链接选基础作者首页链接；只保留这1个doc rectangle、picList16槽与双槽同步。',
    customSaved: '实际保存第2次。', customH5: '外层匿名首页新实例；实际style11、1个自定义矩形及平台图。',
    microOpen: '回真实Admin，编辑导航作者微页ID2。',
    microNoop: '依次查看header num0/隐藏重复header num101、menus1e30/空白字符串长度及true四角、cube第1 tiny .0005和第2指数/空白几何；最后回tiny第1矩形。禁止更改这些导入值；完整JSON保持。',
    microEdited: '仅菜单第1条标题改为微页保留；所有tiny/字符串/0/101/true/未知邻居/footer保持。',
    microSaved: '实际保存第3次。', microH5: '外层匿名微页2；四族、保留导入参数且新菜单标题出现。',
    finished: '3个真实GUI业务POST完成；所有GET全表/序列/KV/R2/queue/IMAGES零写，收尾。',
  };
  const saves: Record<string, { id: number; value: Row[] }> = { rootSaved: { id: 1, value: editedRoot }, customSaved: { id: 1, value: customRoot }, microSaved: { id: 2, value: editedMicro } };
  try {
    setup.push({ ...f.navigationAuthorSetup }, { phase: 'inherited owned setup', footer_before: f.beforeBrowserSetup, footer_after: f.afterBrowserSetup, page_settings: f.pageSettingsSetup });
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
    const chrome: Row = { '/api/site_config': { site_name: '导航作者完整验收', site_logo: '', record_No: '', ico_path: '' }, '/api/share': { title: '导航作者', synopsis: '', img: '' },
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
    function assertH5(data: Row, micro = false, custom = false) {
      expect(data.clientWidth).toBe(375); expect(data.scrollWidth).toBeLessThanOrEqual(375); expect(new URL(data.href).pathname).toBe('/__h5');
      expect(data.widgets.map((item: Row) => item.kind).sort()).toEqual([...DIY_NAVIGATION_AUTHOR_NAMES].sort());
      expect(data.bodyText).toContain(micro ? '导航作者导入微页正文' : '导航作者首页正文');
      if (!micro) expect(data.bodyText).toContain('作者热词25');
      const cube = data.widgets.find((item: Row) => item.kind === 'pictureCube'); expect(cube.layout).toBe(micro || custom ? 11 : 1); expect(cube.cells).toHaveLength(custom ? 1 : 2);
      expect(data.images.some((image: Row) => image.src.includes(f.secondIcon.url + '?') && image.complete && image.naturalWidth === 160 && image.naturalHeight === 90)).toBe(true);
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
      else if (name === 'layouts') {
        const layouts = data.layouts.filter((item: Row) => item.trusted && item.kind === 'pictureCube');
        expect([...new Set(layouts.map((item: Row) => item.layout))].sort((a, b) => Number(a)-Number(b))).toEqual(Array.from({length:12},(_,i)=>i));
        // The declared GUI plan visits0..11 in order from the untouched2-slot
        // fixture. Padding preserves earlier slots; fixed mosaics and single
        // image layouts display only their actual intended rectangle count.
        const counts = [2,2,3,3,3,3,3,4,5,4,1,0];
        for (let style = 0; style < 12; style++) {
          const capture = layouts.find((item: Row) => item.layout === style)!;
          expect(capture).toBeDefined(); expect(capture.clicked).toMatch(new RegExp('^魔方布局 ' + style + ' '));
          expect(capture.cells).toHaveLength(counts[style]!);
          expect(capture.cells.map((cell: Row) => cell.slot)).toEqual(Array.from({length:counts[style]!},(_,index)=>index));
          for (const cell of capture.cells) {
            expect(Number.isFinite(cell.box.width)).toBe(true); expect(Number.isFinite(cell.box.height)).toBe(true);
            expect(cell.box.width).toBeGreaterThan(0); expect(cell.box.height).toBeGreaterThan(0);
          }
          if (style === 11) expect(capture.grid).toBe(16);
        }
        expect(businessSave).toBe(0);
      }
      else if (['rootEdited','customEdited','microNoop','microEdited','microOpen','customOpen'].includes(name)) {
        expect(data.admin.editor).toBe(true); const wanted = name === 'rootEdited' ? editedRoot : name === 'customEdited' ? customRoot : name === 'customOpen' ? editedRoot : name === 'microEdited' ? editedMicro : initialMicro;
        expect(JSON.parse(data.admin.value)).toEqual(wanted); expect(data.admin.content).toBe(row(name.startsWith('micro') ? 2 : 1).content);
      } else if (Object.hasOwn(saves, name)) { expect(data.admin.dialog).toBe(false); expect(businessSave).toBe(['rootSaved','customSaved','microSaved'].indexOf(name)+1); }
      else if (['rootH5','customH5','microH5','menuSecond'].includes(name)) { assertH5(data, name === 'microH5', name === 'customH5');
        if (name === 'menuSecond') { const pages = data.widgets.find((item: Row) => item.kind === 'menus').menuPages, current = pages.find((page: Row) => page.page === 1); expect(current.items.map((item: Row) => item.index)).toEqual([3,4,5]); expect(current.box.left).toBeGreaterThanOrEqual(-1); expect(current.box.right).toBeLessThanOrEqual(376); }
      } else if (name === 'typedMicro') { expect(data.bodyText).toContain('导航作者导入微页正文'); expect(gui.some(item => item.path === '/api/diy/get_diy/2' && item.status === 200)).toBe(true); }
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
          boundaries: ['Real built Admin/H5 and actual Worker/owned PG16/R2 metadata and bytes; unrelated chrome alone declared synthetic.', 'Exactly three real GUI Admin saves. Twelve layouts are actually previewed in Admin; only final fixed1/custom11/micro11 are this Browser H5 cases, not twelve H5 layout saves.', 'Browser uses owned maintenance SQL DI boundary; actual distinct production app/Admin LOGIN ACLs are separately verified by author-options native tests.', 'Late response is a real completed gallery response held at HTTP transport and released after closure; cancellation is not misreported as an abort-ignoring application callback.', 'No MP/App physical-device rendering or production deployment claim.'] }, null, 2) + '\n'); done();
      }
      json(res, { checked: evidence.map(item => item.stage), next: stage(), instruction: instructions[stage() ?? ''] });
    }); }
    const shell = () => {
      const bootstrap = { control, sessions: { admin: { token: f.adminToken, session: f.adminSession }, minimal: { token: f.minimalToken, session: f.minimalSession }, reader: { token: f.readerToken, session: f.readerSession } } };
      return '<!doctype html><html lang="zh"><meta charset="utf-8"><title>真实导航作者验收</title><style>body{font:13px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:1200px;height:900px;border:1px solid #ddd}pre{max-height:100px;overflow:auto;white-space:pre-wrap}</style><body><h1>真实导航作者/Admin/H5</h1>' +
        '<button data-route="admin">真实Admin</button><button data-route="minimal">最小作者</button><button data-route="reader">只读账号</button><button data-route="home">匿名首页</button><button data-route="micro">匿名微页</button><button data-control="hold-gallery">暂缓下一图库</button><button data-control="release-gallery">释放图库旧响应</button>' +
        plans.map(name => '<button data-stage="' + name + '">' + name + '</button>').join('') + '<pre id="result"></pre><iframe title="真实应用验收帧"></iframe><script>' + navigationAuthorObserver.replace('__BOOTSTRAP__', JSON.stringify(bootstrap)) + '</script></body></html>';
    };
    async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
      if (url.pathname === '/__h5' || url.pathname === '/content/dise') { const h5Index = url.pathname === '/__h5', raw = await readFile(resolve(h5Index ? h5 : admin, 'index.html'));
        const augmentation = '<style data-owned-navigation-scrollbar>html{scrollbar-width:none!important}</style>', served = h5Index ? Buffer.from(raw.toString().replace('</head>', augmentation + '</head>')) : raw;
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
    timer = setTimeout(() => { failure = Error('Owned navigation author Browser deadline exceeded'); fail(failure as Error); }, 63 * 60_000);
    await writeFile(prefix + 'ready.json', JSON.stringify({ url: origin + '/', origin, control, plans, instructions, pid: process.pid, tables: f.tables, sequences: f.sequences, source: sourceBefore, h5: h5Before, admin: adminBefore,
      expected: { initialRoot, initialMicro, editedRoot, customRoot, editedMicro, platformImage: f.platformImage, secondIcon: f.secondIcon, supplierImage: f.supplierImage, phases: 'three GUI business saves only' },
      boundary: 'Only initial true persisted-role sessions and HTTP response transport gating are outer controls. No app method invocation, application event dispatch or fabricated business DTO.' }, null, 2) + '\n');
    console.log('DIY navigation author Browser ready', origin); await completion;
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
