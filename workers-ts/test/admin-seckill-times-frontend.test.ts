import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
let runtime: any, browser: EventTarget;
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1280, location: { search: '', pathname: '/activity/seckill-times', href: '' } }));
  const result = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, contents: `
      export { default as Page } from './src/pages/activity/SeckillTimes.vue';
      export { default as request } from './src/utils/request';
      export * as api from './src/api/seckillTime';
      export { createRenderer, nextTick } from 'vue';
      export { createPinia } from 'pinia';
      export * as messages from 'element-plus';
    ` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' }, bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'seckill-times-page', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'seckill-times' }).content, loader: 'ts' }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'messages', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const state = { successes: [], confirmations: [], confirm: () => Promise.resolve(), closed: 0 };
        export const ElMessage = { success: value => state.successes.push(value) };
        export const ElMessageBox = { confirm(...args) { state.confirmations.push(args); return state.confirm(...args); }, close() { state.closed++; } };
      ` }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
const grants = ['seckill_time.view', 'seckill_time.manage'];
const revision = 'a'.repeat(64), uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const row = (id = 1, overrides: Record<string, unknown> = {}) => ({ id, title: '早间秒杀', start_time: '09:00', end_time: '10:00', pic: '/api/assets/31', describe: '每日限时抢购', status: 1, valid: true, revision, pic_preview: '/api/assets/31?expires=9&signature=fixture', ...overrides });
const rows = (list: unknown[] = [row()], count = list.length, page = 1) => ({ list, count, page, limit: 20 });
const asset = (id = 31) => ({ att_id: id, canonical_url: `/api/assets/${id}`, att_dir: `/api/assets/${id}?expires=10&signature=preview`, satt_dir: `/api/assets/${id}?expires=10&signature=thumb`, real_name: '秒杀封面.png', att_type: 'image/png' });
const envelope = (data: unknown, status = 200, msg = 'ok') => ({ status, msg, data });
function login(permissions = grants, token = 'seckill-time-token-a', id = 20) {
  localStorage.setItem('admin_token', token); localStorage.setItem('admin_session', JSON.stringify({ userInfo: { id, account: 'operator', level: 1, roles: '' }, menus: [], uniqueAuth: permissions }));
}
beforeEach(() => {
  const values = new Map<string, string>(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { innerWidth: 1280, location: { search: '', pathname: '/activity/seckill-times', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.messages.state.successes = []; runtime.messages.state.confirmations = []; runtime.messages.state.confirm = () => Promise.resolve(); runtime.messages.state.closed = 0;
});
afterEach(() => vi.unstubAllGlobals());
const flush = async () => { for (let index = 0; index < 8; index++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred() { let resolve!: (value?: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function mount(permissions = grants, respond: (config: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await respond(config), id = Number(config.url.match(/\/(\d+)(?:\/status)?$/u)?.[1] ?? 0);
    const fallback = config.url === '/file/category' ? { list: [{ id: 2, name: '封面' }] } : config.url === '/file/file' ? { list: [asset()], count: 1 } : config.url === '/file/upload' ? { att_id: 31, src: asset().att_dir, url: asset().canonical_url }
      : config.method !== 'get' ? { id: id || 9 } : id ? row(id) : rows([row()], 1, config.params.page);
    return { config, data: custom ?? envelope(fallback), status: 200, statusText: 'seckill fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); }, remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush(); return { view, calls, close: () => app.unmount() };
}
const writes = (calls: any[]) => calls.filter(call => call.method !== 'get');
function fill(view: any, overrides: Record<string, unknown> = {}) { Object.assign(view.form.value, { title: ' 夜间秒杀 ', start_time: '23:00', end_time: '24:00', pic: '/api/assets/31', describe: ' 限时抢购 ', status: 1, ...overrides }); }

it('validates minute precision, terminal 24:00, required legacy fields and safe picture references', () => {
  const normalize = runtime.api.normalizeSeckillTimeInput;
  expect(normalize(row())).toEqual({ title: '早间秒杀', start_time: '09:00', end_time: '10:00', pic: '/api/assets/31', describe: '每日限时抢购', status: 1 });
  expect(normalize(row(1, { start_time: '23:59', end_time: '24:00' })).end_time).toBe('24:00');
  for (const override of [{ start_time: '0900' }, { start_time: '9:00' }, { start_time: '24:00' }, { end_time: '24:01' }, { end_time: '09:00' }, { start_time: '23:00', end_time: '01:00' },
    { title: '' }, { describe: '' }, { describe: '两行\n描述' }, { pic: '' }, { title: '字'.repeat(256) }, { pic: 'http://images.test/a.png' }, { pic: 'https://a:b@images.test/a.png' }, { pic: '//images.test/a.png' }, { pic: '/bad\\image.png' }, { pic: 'javascript:alert(1)' }]) expect(() => normalize(row(1, override))).toThrow();
  expect(normalize(row(1, { title: '😀'.repeat(255), pic: 'https://images.test/a.png' })).title).toHaveLength(510);
  expect(runtime.api.imagePreview('javascript:alert(1)')).toBe(''); expect(runtime.api.imagePreview('//images.test/a')).toBe('');
});
it('checks pagination, unique record identity and repairable invalid DTOs', () => {
  const query = { page: 1, limit: 20 };
  expect(runtime.api.parseSeckillTimePage(rows(), query).list[0].start_time).toBe('09:00');
  for (const value of [null, { ...rows(), page: 2 }, { ...rows(), limit: 15 }, rows([row()], 0), { ...rows(), count: -1 }]) expect(() => runtime.api.parseSeckillTimePage(value, query)).toThrow('分页响应格式错误');
  expect(() => runtime.api.parseSeckillTimePage(rows([row(), row()]), query)).toThrow('记录重复');
  for (const value of [row(0), row(1, { status: 2 }), row(1, { valid: 1 }), row(1, { revision: '' }), row(1, { title: null }), row(1, { start_time: '0900' })]) expect(() => runtime.api.parseSeckillTime(value)).toThrow();
  expect(runtime.api.parseSeckillTime(row(1, { valid: false, title: '', start_time: 'bad', end_time: '', pic: '' })).valid).toBe(false);
  const page = readFileSync(resolve(root, 'src/pages/activity/SeckillTimes.vue'), 'utf8');
  expect(page).toContain('label="时段图片"'); expect(page).toContain('label="时段描述"'); expect(page).toContain('preview-teleported');
  expect(readFileSync(resolve(root, 'src/router/index.ts'), 'utf8')).toContain('path: "activity/seckill-times"');
  expect(readFileSync(resolve(root, 'src/layouts/AdminLayout.vue'), 'utf8')).toContain('index="/activity/seckill-times"');
  expect(readFileSync(resolve(root, 'src/pages/activity/ActivityList.vue'), 'utf8')).not.toContain('continuedTime');
});
it('uses twenty-item pagination, status switching and title search without resetting applied filters on refresh', async () => {
  const f = await mount(); try {
    expect(f.calls[0]).toMatchObject({ method: 'get', url: '/activity/seckill-times', params: { page: 1, limit: 20, title: '', status: '' } });
    f.view.draftTitle.value = '  夜间  '; f.view.draftStatus.value = 0; f.view.search(); await flush();
    expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 20, title: '夜间', status: 0 });
    await f.view.load(2); expect(f.calls.at(-1).params.page).toBe(2); await f.view.load(); expect(f.calls.at(-1).params).toEqual({ page: 2, limit: 20, title: '夜间', status: 0 });
    f.view.reset(); await flush(); expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 20, title: '', status: '' });
  } finally { f.close(); }
});
it('requires independent permissions and read-only users cannot open forms, confirm writes or call the gallery', async () => {
  const denied = await mount(['activity.view', 'activity.manage']); try { await denied.view.load(); await denied.view.openForm(0); expect(denied.calls).toEqual([]); } finally { denied.close(); }
  const viewer = await mount(['seckill_time.view']); try {
    await viewer.view.openForm(0); await viewer.view.openForm(1); await viewer.view.save(); await viewer.view.openAssetPicker(); await viewer.view.remove(viewer.view.list.value[0]); await viewer.view.toggleVisibility(viewer.view.list.value[0]);
    expect(viewer.view.canManage.value).toBe(false); expect(viewer.view.formVisible.value).toBe(false); expect(writes(viewer.calls)).toEqual([]); expect(runtime.messages.state.confirmations).toEqual([]);
  } finally { viewer.close(); }
});
it('creates with six editable fields and a UUID, blocks invalid input and never sends a blank revision', async () => {
  const f = await mount(); try {
    await f.view.openForm(0); await f.view.save(); expect(f.view.formError.value).toContain('时段名称'); expect(writes(f.calls)).toEqual([]);
    fill(f.view, { start_time: '23:00', end_time: '01:00' }); await f.view.save(); expect(f.view.formError.value).toContain('不能跨午夜');
    fill(f.view); await f.view.save(); const write = writes(f.calls)[0]; expect(write).toMatchObject({ method: 'post', url: '/activity/seckill-times' });
    expect(JSON.parse(write.data)).toEqual({ title: '夜间秒杀', start_time: '23:00', end_time: '24:00', pic: '/api/assets/31', describe: '限时抢购', status: 1, request_id: expect.stringMatching(uuid) });
    expect(f.view.formVisible.value).toBe(false); expect(f.calls.at(-1).method).toBe('get');
  } finally { f.close(); }
});
it('fetches a fresh detail revision and preserves stable picture references while previewing signed URLs', async () => {
  const f = await mount(grants, c => c.url.endsWith('/1') && c.method === 'get' ? envelope(row(1, { revision: 'b'.repeat(64) })) : undefined); try {
    await f.view.openForm(1); expect(f.view.formPreview.value).toContain('signature=fixture'); expect(f.view.form.value.pic).toBe('/api/assets/31');
    fill(f.view); await f.view.save(); const write = writes(f.calls)[0]; expect(write.method).toBe('put'); expect(JSON.parse(write.data).revision).toBe('b'.repeat(64));
    expect(JSON.parse(write.data).pic).toBe('/api/assets/31'); expect(JSON.parse(write.data)).not.toHaveProperty('pic_preview');
  } finally { f.close(); }
});
it('supports minute selection and the midnight option without sending invalid native time values or unsigned private previews', async () => {
  const f = await mount(grants, c => c.url.endsWith('/1') && c.method === 'get' ? envelope(row(1, { pic_preview: '' })) : undefined); try {
    expect(f.view.previewFor(f.view.list.value[0])).toContain('signature=fixture');
    await f.view.openForm(1); expect(f.view.formImage.value).toBe('');
    f.view.startSelection.value = '23:30'; f.view.midnightEnd.value = true; expect(f.view.form.value.end_time).toBe('24:00'); expect(f.view.endSelection.value).toBe('');
    f.view.midnightEnd.value = false; expect(f.view.form.value.end_time).toBe(''); f.view.endSelection.value = '23:59'; expect(f.view.form.value.end_time).toBe('23:59');
    f.view.form.value.start_time = 'broken'; expect(f.view.startSelection.value).toBe('');
    expect(f.view.previewFor(row(1, { pic_preview: '' }))).toBe('');
    expect(f.view.previewFor(row(1, { pic: '/uploads/legacy.png', pic_preview: undefined }))).toBe('/uploads/legacy.png');
  } finally { f.close(); }
});
it('shows invalid historical records, prevents direct enabling and allows repair with a fresh detail', async () => {
  let repaired = false;
  const f = await mount(grants, c => {
    if (c.method === 'put') { repaired = true; return envelope({ id: 1 }); }
    if (c.method === 'get') { const item = row(1, repaired ? {} : { valid: false, title: '', start_time: 'broken', end_time: '', pic: '', status: 0 }); return envelope(c.params ? rows([item]) : item); }
    return undefined;
  }); try {
    await f.view.toggleVisibility(f.view.list.value[0]); expect(writes(f.calls)).toEqual([]); expect(f.view.actionNotice.value).toContain('先编辑修复');
    await f.view.openForm(1); expect(f.view.form.value.start_time).toBe('broken'); fill(f.view); await f.view.save(); expect(f.view.list.value[0].valid).toBe(true);
  } finally { f.close(); }
});
it('confirms visibility, leaves the row unchanged on cancel and deletes with exact request identity', async () => {
  const confirmation = deferred(); runtime.messages.state.confirm = () => confirmation.promise;
  const f = await mount(); try {
    const toggle = f.view.toggleVisibility(f.view.list.value[0]); expect(writes(f.calls)).toEqual([]); expect(f.view.list.value[0].status).toBe(1);
    confirmation.resolve(); await toggle;
    expect(writes(f.calls)[0]).toMatchObject({ method: 'put', url: '/activity/seckill-times/1/status' }); expect(JSON.parse(writes(f.calls)[0].data)).toEqual({ status: 0, revision, request_id: expect.stringMatching(uuid) });
    runtime.messages.state.confirm = () => Promise.reject('cancel'); await f.view.remove(f.view.list.value[0]); expect(writes(f.calls)).toHaveLength(1);
    runtime.messages.state.confirm = () => Promise.resolve(); await f.view.remove(f.view.list.value[0]);
    expect(writes(f.calls)[1].method).toBe('delete'); expect(JSON.parse(writes(f.calls)[1].data)).toEqual({ revision, request_id: expect.stringMatching(uuid) });
    expect(runtime.messages.state.confirmations.at(-1)[0]).toContain('仍被未结束秒杀活动使用');
  } finally { f.close(); }
});
it('falls back from a deleted tail page while preserving the applied title and status filters', async () => {
  let deleted = false;
  const f = await mount(grants, c => {
    if (c.method === 'delete') { deleted = true; return envelope({ id: 21 }); }
    if (c.params) return envelope(c.params.page === 2 ? rows(deleted ? [] : [row(21)], deleted ? 20 : 21, 2) : rows(Array.from({ length: 20 }, (_, i) => row(i + 1)), deleted ? 20 : 21));
    return undefined;
  }); try {
    f.view.draftTitle.value = '秒杀'; f.view.draftStatus.value = 1; f.view.search(); await flush(); await f.view.load(2); await f.view.remove(f.view.list.value[0]);
    expect(f.view.page.value).toBe(1); expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 20, title: '秒杀', status: 1 }); expect(f.view.list.value).toHaveLength(20);
  } finally { f.close(); }
});
it.each(['network', 'malformed', 'conflict'])('only rereads after a %s write result and keeps ambiguous payloads unchanged', async failure => {
  const f = await mount(grants, c => { if (c.method === 'get') return undefined; if (failure === 'network') throw new Error('连接中断'); if (failure === 'malformed') return envelope({}); return envelope(null, 400, '时段仍被活动使用'); }); try {
    await f.view.openForm(0); fill(f.view); await f.view.save(); expect(writes(f.calls)).toHaveLength(1); expect(f.calls.at(-1).method).toBe('get'); expect(runtime.messages.state.successes).toEqual([]);
    expect(f.view.actionNotice.value).toContain(failure === 'conflict' ? '操作未完成' : '操作结果未确认');
    if (failure === 'conflict') expect(f.view.uncertainOperation.value).toBeNull(); else expect(f.view.uncertainOperation.value.body).toEqual(JSON.parse(writes(f.calls)[0].data));
    await f.view.load(); expect(writes(f.calls)).toHaveLength(1);
  } finally { f.close(); }
});
it('surfaces failed reads, blocks add while unverified and recovers without stale records', async () => {
  let bad = false; const f = await mount(grants, c => { if (c.params && bad) throw new Error('时段目录不可用'); return undefined; }); try {
    bad = true; await f.view.load(); expect(f.view.list.value).toEqual([]); expect(f.view.loaded.value).toBe(false); await f.view.openForm(0); expect(f.view.formVisible.value).toBe(false);
    bad = false; await f.view.load(); expect(f.view.listError.value).toBe(''); expect(f.view.list.value[0].id).toBe(1);
  } finally { f.close(); }
});
it('rejects mismatched details and drops late list and editor replies', async () => {
  const oldList = deferred(), oldDetail = deferred(); let holdList = false, detailMode = 'wrong';
  const f = await mount(grants, c => c.params && holdList ? oldList.promise : c.url.endsWith('/1') && c.method === 'get' ? detailMode === 'late' ? oldDetail.promise : envelope(row(detailMode === 'wrong' ? 2 : 1)) : undefined); try {
    await f.view.openForm(1); expect(f.view.form.value).toBeNull(); expect(f.view.formError.value).toContain('详情与当前记录不一致');
    holdList = true; const loading = f.view.load(); await flush(); holdList = false; await f.view.load(); oldList.resolve(envelope(rows([row(99)]))); await loading; expect(f.view.list.value[0].id).toBe(1);
    detailMode = 'late'; const editing = f.view.openForm(1); await flush(); await f.view.openForm(0); oldDetail.resolve(envelope(row())); await editing; expect(f.view.formId.value).toBe(0); expect(f.view.form.value.title).toBe('');
  } finally { f.close(); }
});
it('invalidates pending confirmation on refresh and A-B-A session replacement', async () => {
  const confirmation = deferred(); runtime.messages.state.confirm = () => confirmation.promise;
  const f = await mount(); try {
    const remove = f.view.remove(f.view.list.value[0]); await f.view.load(); confirmation.resolve(); await remove; expect(writes(f.calls)).toEqual([]);
    const second = deferred(); runtime.messages.state.confirm = () => second.promise; const toggle = f.view.toggleVisibility(f.view.list.value[0]);
    login(grants, 'seckill-time-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed')); login(); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); second.resolve(); await toggle; expect(writes(f.calls)).toEqual([]); expect(runtime.messages.state.closed).toBeGreaterThan(0);
  } finally { f.close(); }
});
it('cancels delayed writes and does not close a replacement account editor', async () => {
  const late = deferred(); const f = await mount(grants, c => c.method === 'post' ? late.promise : undefined); try {
    await f.view.openForm(0); fill(f.view); const save = f.view.save(); await flush(); const request = writes(f.calls)[0];
    login(grants, 'seckill-time-token-b', 21); browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'admin_session' })); await flush(); await f.view.openForm(0); fill(f.view, { title: '新账号表单' });
    late.resolve(envelope({ id: 99 })); await save; expect(request.signal.aborted).toBe(true); expect(f.view.formVisible.value).toBe(true); expect(f.view.form.value.title).toBe('新账号表单'); expect(runtime.messages.state.successes).toEqual([]);
    login([], 'seckill-time-token-c', 22); browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'admin_token' })); expect(f.view.list.value).toEqual([]); expect(f.view.formVisible.value).toBe(false);
  } finally { f.close(); }
});
it('uses the existing permission-scoped gallery and stores canonical URLs instead of signed previews', async () => {
  const without = await mount(); try { await without.view.openForm(0); await without.view.openAssetPicker(); expect(without.calls.some(c => c.url.startsWith('/file/'))).toBe(false); } finally { without.close(); }
  const f = await mount([...grants, 'attachment.view']); try {
    await f.view.openForm(0); await f.view.openAssetPicker(); expect(f.view.canUploadAssets.value).toBe(false); expect(f.view.assetVisible.value).toBe(true);
    expect(f.calls.at(-1)).toMatchObject({ method: 'get', url: '/file/file', params: { page: 1, limit: 20, pid: 0, name: '', file_type: 1 } });
    f.view.assetPid.value = 2; f.view.assetName.value = '封面'; f.view.searchAssets(); await flush(); expect(f.calls.at(-1).params.pid).toBe(2);
    f.view.chooseAsset(f.view.assets.value[0]); expect(f.view.form.value.pic).toBe('/api/assets/31'); expect(f.view.formPreview.value).toContain('signature=preview'); expect(f.view.assetVisible.value).toBe(false);
    fill(f.view); await f.view.save(); expect(JSON.parse(writes(f.calls)[0].data).pic).toBe('/api/assets/31');
  } finally { f.close(); }
});
it('reuses multipart upload only with attachment.manage and reads the gallery after an unknown upload result', async () => {
  const permissions = [...grants, 'attachment.view', 'attachment.manage']; let failUpload = false;
  const f = await mount(permissions, c => { if (c.url === '/file/upload' && failUpload) throw new Error('上传连接中断'); return undefined; }); try {
    await f.view.openForm(0); await f.view.openAssetPicker();
    await f.view.uploadAsset({ file: new File(['bad'], 'bad.svg', { type: 'image/svg+xml' }) }); expect(writes(f.calls)).toEqual([]); expect(f.view.assetError.value).toContain('10 MiB');
    await f.view.uploadAsset({ file: new File(['png'], 'cover.png', { type: 'image/png' }) });
    const uploaded = writes(f.calls)[0]; expect(uploaded).toMatchObject({ method: 'post', url: '/file/upload' }); expect(uploaded.data).toBeInstanceOf(FormData); expect(uploaded.data.get('pid')).toBe('0'); expect(f.calls.at(-1).url).toBe('/file/file');
    failUpload = true; await f.view.uploadAsset({ file: new File(['png'], 'other.png', { type: 'image/png' }) }); expect(writes(f.calls)).toHaveLength(2); expect(f.view.assetError.value).toContain('上传结果未确认'); expect(f.calls.at(-1).method).toBe('get');
    await f.view.loadAssets(); expect(writes(f.calls)).toHaveLength(2);
  } finally { f.close(); }
});
it('discards late gallery data and invalidates image selection after closing or changing the editor', async () => {
  const late = deferred(); let hold = false; const f = await mount([...grants, 'attachment.view'], c => c.url === '/file/file' && hold ? late.promise : undefined); try {
    await f.view.openForm(0); hold = true; const opening = f.view.openAssetPicker(); await flush(); const request = f.calls.at(-1); await f.view.openForm(1);
    late.resolve(envelope({ list: [asset(99)], count: 1 })); await opening; expect(request.signal.aborted).toBe(true); expect(f.view.assets.value).toEqual([]); expect(f.view.assetVisible.value).toBe(false); expect(f.view.form.value.pic).toBe('/api/assets/31');
    f.view.chooseAsset(asset(99)); expect(f.view.form.value.pic).toBe('/api/assets/31');
  } finally { f.close(); }
});
it('surfaces gallery category failures and permits an explicit retry without silently clearing the failure', async () => {
  let failed = true; const f = await mount([...grants, 'attachment.view'], c => { if (c.url === '/file/category' && failed) throw new Error('分类读取失败'); return undefined; }); try {
    await f.view.openForm(0); await f.view.openAssetPicker(); expect(f.view.assetCategoryError.value).toBe('分类读取失败'); expect(f.view.assets.value).toHaveLength(1);
    failed = false; await f.view.openAssetPicker(); expect(f.view.assetCategoryError.value).toBe(''); expect(f.view.assetCategories.value[0].id).toBe(2);
  } finally { f.close(); }
});
it('aborts pending editor and gallery requests and prevents confirmed writes after unmount', async () => {
  const detail = deferred(), confirm = deferred(); const f = await mount(grants, c => c.method === 'get' && c.url.endsWith('/1') ? detail.promise : undefined);
  const editing = f.view.openForm(1); await flush(); f.view.formVisible.value = false; f.view.onFormClosed(); runtime.messages.state.confirm = () => confirm.promise;
  const removing = f.view.remove(f.view.list.value[0]); f.close(); detail.resolve(envelope(row())); confirm.resolve(); await editing; await removing; expect(f.view.form.value).toBeNull(); expect(f.view.list.value).toEqual([]); expect(writes(f.calls)).toEqual([]);
});
