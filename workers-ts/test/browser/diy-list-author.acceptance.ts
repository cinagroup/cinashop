import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq, getTableColumns } from 'drizzle-orm';
import { systemDise } from '@/models/schema';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { OwnedFixedLengthStream } from '../helpers/adminProductVideoUpload';
import { diyListAuthorFixture, expectedListRootEdit, expectedListAlternateEdit, expectedListMicroEdit } from '../helpers/diyListAuthorFixture';
import { listAuthorObserver } from '../helpers/diyListAuthorObserver';
import { isNavigationAuthorBodyDisconnect, readNavigationAuthorBody as body, sendNavigationAuthorResponse } from '../helpers/diyNavigationAuthorTransport';
import { sortedDiyState, stableDiyState, type DiyStateRow as Row, type DiyStateSnapshot } from '../helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned list author SQL'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned list author Admin SQL'); return { container: wiring.container, close: async () => {} }; } }));
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
async function files(directory: string): Promise<string[]> { return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(row => row.isDirectory() ? files(resolve(directory, row.name)) : [resolve(directory, row.name)]))).flat().sort(); }

// A deadline failure remains failed. This explicit optional mode only consumes
// the two remaining read-only checkpoints from that exact archived candidate.
const resumePartialPath = process.env.TEST_DIY_LIST_AUTHOR_RESUME_PARTIAL;
const resumeMode = resumePartialPath !== undefined;
const RESUME_PARTIAL_SHA256 = '14a11a97e72bd187c7ad7b9c7563db9a1c9164007422cf9dbc21f5a40b3048ee';
const RESUME_HARNESS_BEFORE_SHA256 = '20a001257093a7f0aedbe3e179ec610654f8c4f86ab9c6313c08126b9bb3bc88';
const FULL_PLANS = ['admin', 'minimal', 'reader', 'rootOpen', 'catalog', 'latePending', 'lateClosed', 'lateReleased', 'rootReopened', 'styles', 'rootEdited', 'rootSaved', 'rootH5', 'publicSources', 'articleReadOnly', 'alternateOpen', 'alternateEdited', 'alternateSaved', 'alternateH5', 'microOpen', 'microNoop', 'microEdited', 'microSaved', 'microH5', 'finished'];
async function archivedResume(path: string) {
  const archived = resolve(path);
  expect(path.length).toBeGreaterThan(0); expect(path).toBe(archived);
  expect(archived.startsWith('/tmp/')).toBe(true);
  expect(archived).not.toBe('/tmp/cinashop-diy-list-author-browser-partial.json');
  expect(archived.endsWith('/cinashop-diy-list-author-browser-partial.json')).toBe(true);
  const raw = await readFile(archived); expect(raw.length).toBeLessThan(32 * 1024 * 1024);
  expect(hash(raw)).toBe(RESUME_PARTIAL_SHA256);
  const prior = JSON.parse(raw.toString()) as Row;
  expect(prior.status).toBe('failed'); expect(prior.error).toContain('Owned list author Browser deadline exceeded'); expect(prior.next).toBe('microH5');
  expect(prior.evidence.map((entry: Row) => entry.stage)).toEqual(FULL_PLANS.slice(0, 23));
  for (const entry of prior.evidence) for (const key of ['errors', 'consoleErrors', 'jsonEdits']) expect(entry.observation[key]).toEqual([]);
  expect(prior.writes.map((entry: Row) => entry.stage)).toEqual(['rootSaved', 'alternateSaved', 'microSaved']);
  expect(prior.writes.map((entry: Row) => entry.input.id)).toEqual([1, 1, 2]);
  const registry = prior.snapshots_by_sha256 as Record<string, DiyStateSnapshot>;
  expect(Object.keys(registry)).toHaveLength(4);
  for (const [key, snapshot] of Object.entries(registry)) expect(digest(snapshot)).toBe(key);
  for (const [index, write] of prior.writes.entries()) {
    const before = registry[write.before]!, after = registry[write.after]!;
    expect(before).toBeDefined(); expect(after).toBeDefined();
    const want = structuredClone(before), target = want.system_dise.filter(item => item.id === write.input.id), actual = after.system_dise.filter(item => item.id === write.input.id);
    expect(target).toHaveLength(1); expect(actual).toHaveLength(1); expect(actual[0]!.version).not.toBe(target[0]!.version);
    Object.assign(target[0]!, { value: write.input.value, version: actual[0]!.version, update_time: actual[0]!.update_time });
    expect(after).toEqual(sortedDiyState(want));
    expect(write.allowed.slice().sort()).toEqual(['value','version','update_time'].map(key => 'system_dise.' + write.input.id + '.' + key).sort());
    if (index) expect(write.before).toBe(prior.writes[index - 1].after);
  }
  const posts = prior.traces.filter((entry: Row) => entry.method === 'POST'); expect(posts).toHaveLength(3);
  expect(posts.map((entry: Row) => entry.stage)).toEqual(['rootSaved', 'alternateSaved', 'microSaved']);
  for (const post of posts) { expect(post.synthetic).toBe(false); expect(post.actor).toBe(901); expect(post.path).toBe('/adminapi/dise/save'); expect(post.status).toBe(200); }
  const finalSnapshot = registry[prior.writes[2].after]!;
  expect(prior.evidence[22].snapshot).toBe(prior.writes[2].after);
  const rows = [1, 2].map(id => { const matches = finalSnapshot.system_dise.filter(item => item.id === id); expect(matches).toHaveLength(1); return structuredClone(matches[0]!); });
  expect(rows[0]!.value).toBe(prior.writes[1].input.value); expect(rows[1]!.value).toBe(prior.writes[2].input.value);
  expect(prior.source_before.find((entry: Row) => entry.path === 'workers-ts/test/browser/diy-list-author.acceptance.ts')?.sha256).toBe(RESUME_HARNESS_BEFORE_SHA256);
  const linkedPrior = { path: archived, sha256: RESUME_PARTIAL_SHA256, status: prior.status, next: prior.next,
    completed_stages: prior.evidence.map((entry: Row) => entry.stage), prior_actual_GUI_save_count: 3, prior_actual_business_test_outcome: 'failed-deadline; not relabelled passed',
    final_recorded_snapshot: prior.writes[2].after, restored_system_dise_ids: [1, 2],
    prior_GUI_writes: prior.writes.map((entry: Row) => ({ stage: entry.stage, id: entry.input.id, before: entry.before, after: entry.after, input_sha256: digest(entry.input) })),
    boundary: 'Earlier 23 checkpoints and three actual GUI saves belong only to this archived failed candidate. No prior checkpoint or POST is counted in this fresh read-only continuation.' };
  return { prior, rows, linkedPrior };
}

it(resumeMode ? 'actual remaining microH5 and finished read-only checkpoints from archived GUI saves on owned PG16' : 'actual complete list author controls, three GUI saves and anonymous built H5 on owned PG16', async () => {
  vi.stubGlobal('FixedLengthStream', OwnedFixedLengthStream);
  const resume = resumeMode ? await archivedResume(resumePartialPath!) : undefined;
  const f = await diyListAuthorFixture(new Date(), { namespace: 'public' }); wiring.container = f.container;
  const app = createApp(), repository = resolve(import.meta.dirname, '../../..'), origin = 'http://127.0.0.1:40785';
  const control = '/__list-author/' + randomUUID(), prefix = '/tmp/cinashop-diy-list-author-browser-';
  const h5 = resolve(repository, 'view/uniapp-ts/dist/build/h5'), admin = resolve(repository, 'view/admin-ts/dist');
  const plans = resume ? ['microH5', 'finished'] : FULL_PLANS;
  const evidence: Row[] = [], traces: Row[] = [], setup: Row[] = [], writes: Row[] = [], transport: Row[] = [], staticPaths: Row[] = [], servedHtml: Row[] = [];
  const snapshots: Record<string, DiyStateSnapshot> = {}, remember = (value: DiyStateSnapshot) => { const id = digest(value); snapshots[id] ??= structuredClone(value); return id; };
  const initialRoot = resume ? JSON.parse(resume.rows[0]!.value) as Row[] : f.rootBlocks, initialMicro = resume ? JSON.parse(resume.rows[1]!.value) as Row[] : f.microBlocks, editedRoot = expectedListRootEdit(f), alternateRoot = expectedListAlternateEdit(f), editedMicro = expectedListMicroEdit(f);
  let expected = await f.snapshot(), sourceBefore: Row[] = [], h5Before: Row[] = [], adminBefore: Row[] = [], server: Server | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let pending = 0, businessSave = 0, failure: unknown, lastObservation: Row | undefined, holdDirectory = false;
  const held: Array<{ res: ServerResponse; release: () => void; trace: Row }> = [];
  const resources = () => f.resources(), initialResources = resources(), stage = () => plans[evidence.length]; remember(expected);
  let done!: () => void, fail!: (reason: Error) => void; const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  let queue = Promise.resolve(); function serial<T>(fn: () => Promise<T>) { const next = queue.then(fn); queue = next.then(() => {}, () => {}); return next; }
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned list author acceptance forbids external provider I/O'));
  const row = (id: number) => expected.system_dise.find(item => item.id === id)!;
  const send = (res: ServerResponse, value: string | Uint8Array, status = 200, type = 'text/html') => sendNavigationAuthorResponse(res, value, status, type, () => {
    transport.push({ kind: 'actual-client-disconnect', phase: 'response', method: res.req.method, path: res.req.url, request_aborted: res.req.aborted, response_destroyed: res.destroyed });
  });
  const json = (res: ServerResponse, value: unknown, status = 200) => send(res, JSON.stringify(value), status, 'application/json');
  const sources = async () => {
    const selected = ['workers-ts/test/browser/diy-list-author.acceptance.ts', 'workers-ts/vitest.diy-list-author-browser.config.ts', 'workers-ts/scripts/run-local-finance-postgres.mjs', 'workers-ts/package.json', 'workers-ts/package-lock.json', 'workers-ts/test/fixtures/diy-list-author-defaults.json', 'workers-ts/test/fixtures/diy-navigation-author-defaults.json', 'workers-ts/test/fixtures/community-teal.png', 'view/uniapp-ts/package.json', 'view/uniapp-ts/package-lock.json', 'view/admin-ts/package.json', 'view/admin-ts/package-lock.json'];
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
    snapshots_by_sha256: snapshots, observation: lastObservation, source_before: sourceBefore, h5_before: h5Before, admin_before: adminBefore,
    ...(resume ? { mode: 'remaining-two-read-only', linked_prior: resume.linkedPrior, business_save_count: businessSave } : {}) }, null, 2) + '\n');
  const instructions: Record<string,string> = {
    admin:'真实Admin列表。',
    minimal:'外层最小作者，编辑ID1，切列表组件；分别打开fixed商品、brand、category、label、article真实目录并关闭，不选择，不改JSON。全部4新GET和复用tab-targets返回200；目录可读，原FAB/product/attachment管理仍禁止。',
    reader:'外层只读账号编辑ID1；添加/字段/真实目录均disabled，JSON完整保持。',
    rootOpen:'外层真实Admin编辑ID1，选择列表组件，JSON/content初始不变。',
    catalog:'各列表范围打开真实目录浏览关闭；商品搜索作者指定，按商品分类筛选到85022后关闭不选择；品牌展开85001到85002；category85021到85022；标签85011；article85081和显式热门0。无JSON改写。',
    latePending:'外层暂缓下一目录，选择第2项固定商品并打开真实目录。真实list-products GET已完成，但HTTP响应held1，pending0。',
    lateClosed:'实际关闭目录，再取消父编辑对话框；旧响应仍held1。',
    lateReleased:'外层释放目录旧响应，再编辑ID1；旧响应不改JSON或选身份。',
    rootReopened:'原ID1四商品来源和文章JSON/content全等初始值。',
    styles:'用第2项固定商品真实读取预览后逐风格0..5，每次风格变更需再点读取当前公开列表预览，等待实际初始1个商品出现。文章先真实选择85081，逐0..2并读取。该stage只要求9种真实DOM预览，无POST；rootEdited随后设置所有最终值。',
    rootEdited:'固定商品目录搜索85032选择作者指定商品二，已选范围第2项上移 => IDs85032,85031；风格1、按钮样式1购物车、数量2、商品名称颜色#13579b。品牌组件移除85001后目录展开85001选择85002，风格0。分类组件移除85021后展开85021选择85022，风格2。标签组件移除704后选择85011，风格5。文章目录选择85081，风格2、数量2、标题颜色#2468ac。其它全部保留。',
    rootSaved:'真实GUI保存第1次，等dialog关闭。',rootH5:'外层匿名首页真实H5：四来源当前商品、文章，风格1/action1显示购物车；图片真实160x90，不能点击商品/加购/文章/点赞。',
    publicSources:'停留实际匿名H5，滚动四商品列表，确认真实HTTP四种filter分别存在，禁止详情/SKU/购物车/搜索历史变更。',
    articleReadOnly:'滚到真实文章列表，确认两文章标题/时间/浏览0与12/赞0与3，绝不点击文章；全表/序列/resources保持。',
    alternateOpen:'真实Admin回ID1，保持第一次已保存值。',
    alternateEdited:'固定商品风格0按钮样式0购买文字；品牌风格4按钮样式2购物车；分类风格3；文章风格1。标签保留风格5，全部身份/自定义字段和其它配置保留。',
    alternateSaved:'真实GUI保存第2次。',alternateH5:'外层匿名首页新实例，fixed0购买/brand4购物车/category3无按钮/label5/article1，真实四来源和两篇文章。',
    microOpen:'真实Admin编辑ID2导入微页，选择列表组件。',
    microNoop:'逐6个列表组件；focus/blur tiny .0005、指数/空白、true分角、0和101、0003；选择已选范围项101项全部逐项查看并保持末项可达；文章selectConfig107个导入项整体保留。不能改JSON。最后回固定商品组件。',
    microEdited:'仅固定商品组件商品名称颜色改#a13f67，其余全部导入数据保持。',microSaved:'真实GUI保存第3次。',
    microH5:'匿名微页2实际H5：fixed1个真实商品、brand数量0空列表；0003数量错误与101标签范围错误阻止宽查询；article101只读当前2篇并显示100上限提示；隐藏article仍隐藏。导入2501资料从未作为媒体authority。',
    finished:'3真实GUI业务POST，25阶段；GET全表/序列/KV/R2/queue/IMAGES零写，收尾。',
  };
  const saves: Record<string, { id: number; value: Row[] }> = resume ? {} : { rootSaved: { id: 1, value: editedRoot }, alternateSaved: { id: 1, value: alternateRoot }, microSaved: { id: 2, value: editedMicro } };
  try {
    setup.push({ ...f.listAuthorSetup }, { phase: 'inherited owned setup', footer_before: f.beforeBrowserSetup, footer_after: f.afterBrowserSetup, page_settings: f.pageSettingsSetup });

    if (resume) {
      // This is explicit fresh owned-fixture seed work, not a GUI POST, GET or
      // cross-session full-database identity claim. Restore all 25 persisted
      // columns for exactly dise1/2; random/time-bearing other rows stay fresh.
      const seedBefore = await f.snapshot(), seedResources = resources(), columns = getTableColumns(systemDise);
      const want = structuredClone(seedBefore);
      await f.db.transaction(async tx => {
        for (const saved of resume.rows) {
          expect(Object.keys(saved).sort()).toEqual(Object.values(columns).map(column => column.name).sort());
          const values = Object.fromEntries(Object.entries(columns).map(([key, column]) => [key, saved[column.name]])) as typeof systemDise.$inferInsert;
          await tx.update(systemDise).set(values).where(eq(systemDise.id, saved.id));
          const index = want.system_dise.findIndex(item => item.id === saved.id); expect(index).toBeGreaterThanOrEqual(0); want.system_dise[index] = structuredClone(saved);
        }
      });
      const seedAfter = await f.snapshot(); expect(seedAfter).toEqual(sortedDiyState(want)); expect(resources()).toEqual(seedResources);
      setup.push({ phase: 'explicit owned continuation seed from archived actual GUI final dise1/2 whole rows; not measured GET or GUI business save',
        before: seedBefore, after: seedAfter, resources_before: seedResources, resources_after: resources(), linked_prior: resume.linkedPrior,
        restored_rows: resume.rows.map(saved => ({ id: saved.id, whole_row_sha256: digest(saved), raw_value_sha256: hash(saved.value) })),
        boundary: 'Only the two archived persisted system_dise rows are restored. Other row randomness, timestamps and resource setup are a fresh session; old/new full snapshots are not claimed equal.' });
      expected = seedAfter;
      // The measured registry starts after seed restoration. Its single fresh
      // snapshot proves this continuation's GETs do not write, not old/new DB
      // equivalence or a fourth real GUI save.
      for (const key of Object.keys(snapshots)) delete snapshots[key]; remember(expected);
      instructions.microH5 = '续验：外层匿名微页；恢复的是前轮三次实际GUI保存的最终dise1/2整行。只验真实H5，禁止再次保存/改JSON。' + instructions.microH5;
      instructions.finished = '本轮仅microH5/finished两阶段、0业务POST；旧23阶段/3GUI保存仅linked_prior，不称单轮25全通过。GET全表/序列/resources零写后收尾。';
    }
    expect(f.tables).toContain('store_product_words'); expect(f.tables).toContain('page_link'); expect(f.tables).toContain('system_dise'); expect(f.tables.length).toBeGreaterThan(73);
    if (!resume) {
    for (const prefix of ['/adminapi','/api/admin']) for (const resource of ['list-products','list-brands','list-labels','list-article-categories']) {
      const path=prefix+'/dise/author-options/'+resource;
      await measured(path,f.minimalToken,'actual-minimal903',200);await measured(path,f.readerToken,'actual-reader902',400011);await measured(path,undefined,'actual-guest',410000);
    }
    const categories=await measured('/adminapi/dise/author-options/tab-targets?kind=product_category&parent_id=85021',f.minimalToken,'actual-minimal903',200);
    expect(categories.list.some((r:Row)=>r.selection?.id===85022&&r.selection.kind==='category')).toBe(true);
    for(const resource of ['list-products','list-brands','list-labels','list-article-categories'])expect((await measured('/adminapi/dise/author-options/'+resource,f.adminToken,'actual-admin901',200)).list.length).toBeGreaterThan(0);
    for(const path of ['/adminapi/setting/fab/link-targets?kind=product','/adminapi/product/product','/adminapi/file/file'])await measured(path,f.minimalToken,'actual-minimal903',400011);
    }
    expect(await f.snapshot()).toEqual(expected); expect(resources()).toEqual(initialResources);
    sourceBefore = await sources(); h5Before = await artifacts(h5); adminBefore = await artifacts(admin); expect(h5Before.length).toBeGreaterThan(100); expect(adminBefore.length).toBeGreaterThan(20);
    if (resume) {
      const unchanged = (items: Row[]) => items.filter(entry => entry.path !== 'workers-ts/test/browser/diy-list-author.acceptance.ts');
      expect(unchanged(sourceBefore)).toEqual(unchanged(resume.prior.source_before));
      expect(h5Before).toEqual(resume.prior.h5_before); expect(adminBefore).toEqual(resume.prior.admin_before);
    }
    const chrome: Row = { '/api/site_config': { site_name: '列表作者完整验收', site_logo: '', record_No: '', ico_path: '' }, '/api/share': { title: '列表作者', synopsis: '', img: '' },
      '/api/get_open_adv': { status: 0, time: 3, interval_time: 24, type: 'pic', value: [], video_link: '' }, '/api/v2/diy/color_change/color_change': {}, '/adminapi/new_push': { ordernum: 0, inventory: 0, commentnum: 0, reflectnum: 0, msgcount: 0, sampled_at: Math.floor(Date.now()/1000) } };
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      pending++; try { await serial(async () => {
        const raw = await body(req), method = req.method ?? 'GET', before = await f.snapshot(), startResources = resources(), reads = f.bucket.get.mock.calls.length, path = url.pathname;
        expect(before).toEqual(expected); const header = req.headers['authori-zation'] || req.headers.authorization, token = typeof header === 'string' ? header.replace(/^Bearer\s+/u, '').trim() : '';
        const actor = token === f.adminToken ? 901 : token === f.minimalToken ? 903 : token === f.readerToken ? 902 : 0;
        if (resume) { expect(method).toBe('GET'); expect(actor).toBe(0); expect(path.startsWith('/api/')).toBe(true); }
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
        if (holdDirectory && path === '/adminapi/dise/author-options/list-products') { holdDirectory = false; held.push({ res, release: deliver, trace }); trace.transport = 'actual-response-held-after-complete-read'; return; } deliver();
      }); } finally { pending--; }
    }
    function assertH5(data:Row,micro=false,alternate=false){
      expect(data.clientWidth).toBe(375);expect(data.scrollWidth).toBeLessThanOrEqual(375);expect(new URL(data.href).pathname).toBe('/__h5');
      expect(data.bodyText).toContain(micro?'列表作者导入微页正文':'列表作者首页正文');
      expect(data.widgets).toHaveLength(5);expect(data.widgets.map((w:Row)=>w.kind).sort()).toEqual(['articleList','goodList','goodList','goodList','goodList']);
      const widget=(key:number)=>data.widgets.find((w:Row)=>w.key===String(key));
      if(!micro){
        for(const[key,ids]of[[10,[85032,85031]],[20,[85033]],[30,[85034]],[40,[85035]]]as const){const w=widget(key);expect(w.products.map((r:Row)=>r.id)).toEqual([...ids]);expect(w.errors).toEqual([]);}
        expect(widget(50).articles.map((r:Row)=>r.id)).toEqual([85091,85092]);expect(widget(10).products.map((r:Row)=>r.action)).toEqual([alternate?'购买':'购物车',alternate?'购买':'购物车']);
        expect(widget(20).products[0].action).toBe(alternate?'购物车':'购买');if(alternate)expect(widget(30).products[0].action).toBeUndefined();
        expect([10,20,30,40,50].map(key=>widget(key).layout)).toEqual(alternate?[0,4,3,5,1]:[1,0,2,5,2]);
      }else{
        expect(widget(10).products.map((r:Row)=>r.id)).toEqual([85031]);expect(widget(20).products).toEqual([]);expect(widget(30).products).toEqual([]);expect(widget(40).products).toEqual([]);
        expect(widget(30).errors.join('')).toContain('列表数量配置无效');expect(widget(40).errors.join('')).toContain('商品范围配置无效');expect(widget(50).articles.map((r:Row)=>r.id)).toEqual([85091,85092]);expect(data.bodyText).toContain('列表预览最多显示100项');
      }
      for(const w of data.widgets){expect(w.box.width).toBeGreaterThan(0);expect(w.box.width).toBeLessThanOrEqual(376);expect(w.box.height).toBeGreaterThan(0);}
      for(const asset of[f.platformImage,f.secondIcon])expect(data.images.some((image:Row)=>image.src.includes(asset.url+'?')&&image.complete&&image.naturalWidth===160&&image.naturalHeight===90)).toBe(true);
      expect(traces.some(t=>t.path===(micro?'/api/diy/get_diy/2':'/api/diy/get_diy/0')&&t.status===200&&!t.synthetic)).toBe(true);
    }
    async function checkpoint(name: string, data: Row, res: ServerResponse) { expect(pending).toBe(0); await serial(async () => {
      lastObservation = data; expect(name).toBe(stage()); expect(data.loaded).toBe(true); expect(data.errors).toEqual([]); expect(data.consoleErrors).toEqual([]); expect(data.jsonEdits).toEqual([]);
      const gui = traces.filter(item => item.phase !== 'actual-read-only-preflight' && !item.synthetic);
      if(['admin','minimal','reader'].includes(name)){
        expect(data.href).toContain('/content/dise');if(name!=='admin'){expect(data.admin.editor).toBe(true);expect(JSON.parse(data.admin.value)).toEqual(initialRoot);
          expect(data.admin.addDisabled).toBe(name==='reader');expect(data.admin.catalogButtons.length).toBeGreaterThan(0);expect(data.admin.catalogButtons.every((b:Row)=>b.disabled===(name==='reader'))).toBe(true);
          if(name==='minimal')for(const resource of['list-products','list-brands','list-labels','list-article-categories','tab-targets'])expect(gui.some(t=>t.actor===903&&t.path.endsWith('/'+resource)&&t.status===200)).toBe(true);
        }
      }else if(['rootOpen','catalog','latePending','lateReleased','rootReopened'].includes(name)){
        expect(data.admin.editor).toBe(true);expect(JSON.parse(data.admin.value)).toEqual(initialRoot);expect(data.admin.content).toBe(row(1).content);
        if(name==='catalog')for(const resource of['list-products','list-brands','list-labels','list-article-categories','tab-targets'])expect(gui.some(t=>t.actor===901&&t.path.endsWith('/'+resource)&&t.status===200)).toBe(true);
        if(name==='latePending')expect(held).toHaveLength(1);if(name==='lateReleased')expect(held).toHaveLength(0);
      }else if(name==='lateClosed'){expect(data.admin.dialog).toBe(false);expect(held).toHaveLength(1);}
      else if(name==='styles'){
        for(const[kind,count]of[['goodList',6],['articleList',3]]as const)for(let layout=0;layout<count;layout++){const capture=data.styles.find((item:Row)=>item.trusted&&item.kind===kind&&item.layout===layout&&(item.products.length||item.articles.length));expect(capture,kind+' actual Admin loaded preview '+layout).toBeDefined();expect(capture.box.width).toBe(375);expect(capture.box.height).toBeGreaterThan(0);for(const card of[...capture.products,...capture.articles]){expect(card.box.width).toBeGreaterThan(0);expect(card.box.height).toBeGreaterThan(0);}}
        expect(businessSave).toBe(0);
      }else if(['rootEdited','alternateEdited','microNoop','microEdited','microOpen','alternateOpen'].includes(name)){
        expect(data.admin.editor).toBe(true);const wanted=name==='rootEdited'?editedRoot:name==='alternateEdited'?alternateRoot:name==='alternateOpen'?editedRoot:name==='microEdited'?editedMicro:initialMicro;expect(JSON.parse(data.admin.value)).toEqual(wanted);expect(data.admin.content).toBe(row(name.startsWith('micro')?2:1).content);
        if(name==='microNoop'){const selected=data.events.filter((e:Row)=>e.trusted&&e.type==='click'&&typeof e.option==='string');for(let i=0;i<101;i++)expect(selected.some((e:Row)=>e.option.startsWith((i+1)+' · ')&&e.option.includes('#'+(85011+i))), 'actual imported selection '+i).toBe(true);}
      }else if(Object.hasOwn(saves,name)){expect(data.admin.dialog).toBe(false);expect(businessSave).toBe(['rootSaved','alternateSaved','microSaved'].indexOf(name)+1);}
      else if(['rootH5','alternateH5','microH5','publicSources','articleReadOnly'].includes(name)){
        assertH5(data,name==='microH5',name==='alternateH5');
        const publicReads=gui.filter(t=>t.path==='/api/products'&&t.actor===0&&t.status===200);
        if(name!=='microH5')for(const[key,value]of[['ids','85032,85031'],['brand_id','85002'],['cate_id','85022'],['store_label_id','85011']])expect(publicReads.some(t=>new URLSearchParams(t.query).get(key)===value)).toBe(true);
        expect(gui.some(t=>t.path==='/api/article/list/85081'&&t.actor===0&&t.status===200)).toBe(true);
        expect(gui.some(t=>/\/(?:detail|attr|like|visit|cart)(?:\/|$)/u.test(t.path))).toBe(false);
      }
      else expect(name).toBe('finished');
      expect(await f.snapshot()).toEqual(expected); expect(resources()).toEqual(initialResources);
      evidence.push({ stage: name, at: Date.now(), observation: data, traceCount: traces.length, snapshot: remember(await f.snapshot()), resources: resources() }); await persist();
      await writeFile(prefix + 'progress.json', JSON.stringify({ checked: evidence.map(item => item.stage), next: stage(), traces: traces.length, business_save_count: businessSave }) + '\n');
      if (name === 'finished') {
        if (resume) { expect(businessSave).toBe(0); expect(writes).toEqual([]); expect(traces.every(item => item.method === 'GET')).toBe(true); }
        else expect(businessSave).toBe(3); expect(held).toHaveLength(0); expect(external).not.toHaveBeenCalled();
        const sourceAfter = await sources(), h5After = await artifacts(h5), adminAfter = await artifacts(admin); expect(sourceAfter).toEqual(sourceBefore); expect(h5After).toEqual(h5Before); expect(adminAfter).toEqual(adminBefore);
        await writeFile(prefix + 'evidence.json', JSON.stringify({ status: resume ? 'passed-remaining-two-checkpoints-from-archived-GUI-saves' : 'passed-all-25-checkpoints', plans, evidence, traces, setup, writes, transport, snapshots_by_sha256: snapshots,
          ...(resume ? { mode: 'remaining-two-read-only', linked_prior: resume.linkedPrior, current_business_save_count: 0, prior_actual_GUI_save_count: 3 } : {}),
          tables: f.tables, sequences: f.sequences, source_before: sourceBefore, source_after: sourceAfter, h5_before: h5Before, h5_after: h5After, admin_before: adminBefore, admin_after: adminAfter,
          static_paths: staticPaths, served_html: servedHtml, resources_before: initialResources, resources_after: resources(), business_save_count: businessSave,
          boundaries: resume ? ['Fresh continuation has only microH5/finished and0GUI saves. Earlier23/checkpoints and3actualGUI saves belong to a preserved failed-deadline candidate linked by fixed SHA.', 'Fresh explicit fixture seed restores only archived final dise1/2 whole rows. No old/new whole-database/signedURL/timestamp identity claim. Current GET snapshots/resources prove fresh read-only behavior.', 'Real built H5 and actual Worker on fresh owned PG16/R2 fixture; only declared unrelated chrome GETs are synthetic. No new Admin controls/9style/101option/3GUI-save claim in this continuation.', 'Owned maintenance SQL DI boundary remains; no production LOGIN ACL or MP/App physical-device/deployment claim.'] : ['Real built Admin/H5 and actual Worker/owned PG16/R2 metadata and bytes; unrelated chrome alone declared synthetic.', 'Exactly three real GUI Admin saves. All6 goods and3 article styles are actually visited with current public content in Admin. H5 is the explicit root, alternate and imported matrix; no all9 H5 transition claim.', 'Browser uses owned maintenance SQL DI boundary; actual distinct production app/Admin LOGIN ACLs are separately verified by author-options native tests.', 'Late response is a real completed product directory response held at HTTP transport and released after closure; cancellation is not misreported as an abort-ignoring application callback.', 'No MP/App physical-device rendering or production deployment claim.'] }, null, 2) + '\n'); done();
      }
      json(res, { checked: evidence.map(item => item.stage), next: stage(), instruction: instructions[stage() ?? ''] });
    }); }
    const shell = () => {
      const bootstrap = { control, sessions: { admin: { token: f.adminToken, session: f.adminSession }, minimal: { token: f.minimalToken, session: f.minimalSession }, reader: { token: f.readerToken, session: f.readerSession } } };
      return '<!doctype html><html lang="zh"><meta charset="utf-8"><title>真实列表作者验收</title><style>body{font:13px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:1200px;height:900px;border:1px solid #ddd}pre{max-height:100px;overflow:auto;white-space:pre-wrap}</style><body><h1>真实列表作者/Admin/H5</h1>' +
        '<button data-route="admin">真实Admin</button><button data-route="minimal">最小作者</button><button data-route="reader">只读账号</button><button data-route="home">匿名首页</button><button data-route="micro">匿名微页</button><button data-control="hold-directory">暂缓下一目录</button><button data-control="release-directory">释放目录旧响应</button>' +
        plans.map(name => '<button data-stage="' + name + '">' + name + '</button>').join('') + '<pre id="result"></pre><iframe title="真实应用验收帧"></iframe><script>' + listAuthorObserver.replace('__BOOTSTRAP__', JSON.stringify(bootstrap)) + '</script></body></html>';
    };
    async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
      if (url.pathname === '/__h5' || url.pathname === '/content/dise') { const h5Index = url.pathname === '/__h5', raw = await readFile(resolve(h5Index ? h5 : admin, 'index.html'));
        const augmentation = '<style data-owned-list-scrollbar>html{scrollbar-width:none!important}</style>', served = h5Index ? Buffer.from(raw.toString().replace('</head>', augmentation + '</head>')) : raw;
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
        expect(['hold-directory','release-directory']).toContain(input.action); expect(stage()).toBe(input.action === 'hold-directory' ? 'latePending' : 'lateReleased');
        const before = await f.snapshot(), start = resources(); if (input.action === 'hold-directory') holdDirectory = true; else { expect(held).toHaveLength(1); for (const item of held.splice(0)) item.release(); }
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
    timer = setTimeout(() => { failure = Error('Owned list author Browser deadline exceeded'); fail(failure as Error); }, 63 * 60_000);
    await writeFile(prefix + 'ready.json', JSON.stringify({ url: origin + '/', origin, control, plans, instructions, pid: process.pid, tables: f.tables, sequences: f.sequences, source: sourceBefore, h5: h5Before, admin: adminBefore,
      ...(resume ? { mode: 'remaining-two-read-only', linked_prior: resume.linkedPrior, business_save_count: 0 } : {}),
      expected: { initialRoot, initialMicro, editedRoot, alternateRoot, editedMicro, platformImage: f.platformImage, secondIcon: f.secondIcon, supplierImage: f.supplierImage, phases: resume ? 'fresh remaining-two read-only checkpoints;0GUI saves; archived prior3saves linked separately' : 'three GUI business saves only' },
      boundary: 'Only initial true persisted-role sessions and HTTP response transport gating are outer controls. No app method invocation, application event dispatch or fabricated business DTO.' }, null, 2) + '\n');
    console.log('DIY list author Browser ready', origin); await completion;
  } catch (reason) { failure ??= reason; throw reason; }
  finally {
    if (timer) clearTimeout(timer); for (const item of held.splice(0)) item.res.destroy(); server?.closeAllConnections(); if (server?.listening) await new Promise<void>(yes => server!.close(() => yes())); await queue;
    let finalSnapshot: DiyStateSnapshot | undefined, sourceAfter: Row[] = [], h5After: Row[] = [], adminAfter: Row[] = [], inspectionError: unknown;
    try { finalSnapshot = await f.snapshot(); remember(finalSnapshot); sourceAfter = sourceBefore.length ? await sources() : []; h5After = h5Before.length ? await artifacts(h5) : []; adminAfter = adminBefore.length ? await artifacts(admin) : []; await persist(); }
    catch (reason) { inspectionError = reason instanceof Error ? reason.stack : String(reason); }
    finally { external.mockRestore(); wiring.container = undefined; vi.unstubAllGlobals(); await f.close(); }
    await writeFile(prefix + 'cleanup.json', JSON.stringify({ server_closed: true, database_fixture_closed: true, timer_cleared: true, external_restored: true, fixed_stream_restored: true, checked: evidence.map(item => item.stage), inspection_error: inspectionError,
      final_snapshot: finalSnapshot, snapshots_by_sha256: snapshots, final_resources: resources(), source_after: sourceAfter, h5_after: h5After, admin_after: adminAfter,
      ...(resume ? { mode: 'remaining-two-read-only', linked_prior: resume.linkedPrior, business_save_count: businessSave, writes } : {}),
      source_drift: sourceBefore.length ? digest(sourceBefore) !== digest(sourceAfter) : null, h5_drift: h5Before.length ? digest(h5Before) !== digest(h5After) : null, admin_drift: adminBefore.length ? digest(adminBefore) !== digest(adminAfter) : null }, null, 2) + '\n');
    if (inspectionError && !failure) throw Error(String(inspectionError));
  }
}, 65 * 60_000);
