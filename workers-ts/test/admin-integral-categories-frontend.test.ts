import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
let runtime: any;
let browser: EventTarget;
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { search: '', pathname: '/marketing/integral-categories', href: '' } }));
  const result = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, contents: `
      export { default as Page } from './src/pages/marketing/IntegralCategories.vue';
      export { default as request } from './src/utils/request';
      export * as category from './src/api/integralCategory';
      export { createRenderer, nextTick } from 'vue';
      export { createPinia } from 'pinia';
      export * as messages from 'element-plus';
    ` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'integral-categories-page', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'integral-categories' }).content, loader: 'ts',
      }));
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

const grants = ['integral_category.view', 'integral_category.manage'];
const revision = 'a'.repeat(64);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const row = (id = 1, overrides: Record<string, unknown> = {}) => ({ id, name: `分类${id}`, integral_min: 0, integral_max: 100, is_show: 1, sort: 5,
  add_time: '2026-09-26 10:00:00', revision, ...overrides });
const rows = (page = 1, list: unknown[] = [row(page)], count = 16) => ({ list, count, page, limit: 15 });
const envelope = (data: unknown, status = 200, msg = 'ok') => ({ status, msg, data });
function login(permissions = grants, token = 'integral-category-token-a', id = 20) {
  localStorage.setItem('admin_token', token);
  localStorage.setItem('admin_session', JSON.stringify({
    userInfo: { id, account: 'operator', level: 1, roles: '' }, menus: [], uniqueAuth: permissions,
  }));
}
beforeEach(() => {
  const values = new Map<string, string>();
  browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { search: '', pathname: '/marketing/integral-categories', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.messages.state.successes = []; runtime.messages.state.confirmations = [];
  runtime.messages.state.confirm = () => Promise.resolve(); runtime.messages.state.closed = 0;
});
afterEach(() => vi.unstubAllGlobals());
const flush = async () => {
  for (let index = 0; index < 8; index++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); }
};
function deferred() {
  let resolve!: (value?: unknown) => void;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function mount(permissions = grants, respond: (config: any) => unknown = () => undefined) {
  login(permissions);
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    const id = Number(config.url.match(/\/(\d+)(?:\/status)?$/u)?.[1] ?? 0);
    const data = custom ?? envelope(config.method !== 'get' ? { id: id || 9 } : id ? row(id) : rows(config.params.page));
    return { config, data, status: 200, statusText: 'category fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({
    createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {},
  });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}
const writes = (calls: any[]) => calls.filter(call => call.method !== 'get');
const reads = (calls: any[]) => calls.filter(call => call.method === 'get' && call.params);

it('validates pagination, revisions, row types and unique IDs without requiring a legacy form schema', () => {
  const query = { page: 1, limit: 15 };
  expect(runtime.category.parseIntegralCategoryPage(rows(), query).list[0].name).toBe('分类1');
  for (const value of [null, rows(2), { ...rows(), count: -1 }, { list: [], count: 0 }, { ...rows(), limit: 20 }]) {
    expect(() => runtime.category.parseIntegralCategoryPage(value, query)).toThrow('分页响应格式错误');
  }
  for (const value of [row(0), row(1, { name: 1 }), row(1, { integral_min: 1.5 }), row(1, { integral_max: -1 }), row(1, { is_show: 2 }), row(1, { revision: '' })]) {
    expect(() => runtime.category.parseIntegralCategory(value)).toThrow('记录格式错误');
  }
  expect(() => runtime.category.parseIntegralCategoryPage(rows(1, [row(), row()]), query)).toThrow('记录重复');
  expect(runtime.category.parseIntegralCategory(row(1, { integral_min: 0, integral_max: 0 })).id).toBe(1);
  expect(readFileSync(resolve(root, 'src/router/index.ts'), 'utf8')).toContain('path: "marketing/integral-categories"');
  expect(readFileSync(resolve(root, 'src/layouts/AdminLayout.vue'), 'utf8')).toContain('index="/marketing/integral-categories"');
});

it('keeps category read and write permissions independent from other activity and point permissions', async () => {
  const denied = await mount(['activity.view', 'point_statistic.view']);
  try { await denied.view.load(); await denied.view.openForm(0); expect(denied.calls).toEqual([]); } finally { denied.close(); }
  const viewer = await mount(['integral_category.view']);
  try {
    expect(viewer.view.canView.value).toBe(true); expect(viewer.view.canManage.value).toBe(false);
    await viewer.view.openForm(0); await viewer.view.openForm(1);
    await viewer.view.toggleVisibility(viewer.view.list.value[0]); await viewer.view.remove(viewer.view.list.value[0]);
    await viewer.view.save();
    expect(viewer.view.formVisible.value).toBe(false); expect(writes(viewer.calls)).toEqual([]);
    expect(runtime.messages.state.confirmations).toEqual([]);
  } finally { viewer.close(); }
});

it('uses server totals, name/status filtering and the legacy 15-row page size', async () => {
  const fixture = await mount();
  try {
    expect(fixture.calls[0].params).toEqual({ page: 1, limit: 15, name: '', is_show: '' });
    expect(fixture.view.count.value).toBe(16);
    fixture.view.draftName.value = ' 范围%_\\ '; fixture.view.draftShow.value = 0; fixture.view.search();
    expect(fixture.view.list.value).toEqual([]); await flush();
    expect(reads(fixture.calls).at(-1).params).toEqual({ page: 1, limit: 15, name: '范围%_\\', is_show: 0 });
    fixture.view.draftName.value = '未提交'; await fixture.view.load(2);
    expect(reads(fixture.calls).at(-1).params).toMatchObject({ page: 2, name: '范围%_\\', is_show: 0 });
    expect(fixture.view.page.value).toBe(2);
    fixture.view.reset(); await flush();
    expect(reads(fixture.calls).at(-1).params).toEqual({ page: 1, limit: 15, name: '', is_show: '' });
  } finally { fixture.close(); }
});

it('builds the old five-field defaults and validates required names and strict integral ranges before creation', async () => {
  const fixture = await mount();
  try {
    const before = fixture.calls.length;
    await fixture.view.openForm(0);
    expect(fixture.calls).toHaveLength(before);
    expect(fixture.view.form.value).toMatchObject({ name: '', integral_min: 0, integral_max: 0, is_show: 1, sort: 0 });
    await fixture.view.save(); expect(fixture.view.formError.value).toContain('分类名称');
    fixture.view.form.value.name = '分类'.repeat(16); await fixture.view.save(); expect(writes(fixture.calls)).toEqual([]);
    fixture.view.form.value.name = ' 入门分类 '; await fixture.view.save(); expect(fixture.view.formError.value).toContain('最低积分');
    fixture.view.form.value.integral_max = 99; fixture.view.form.value.sort = -1;
    await fixture.view.save(); expect(fixture.view.formError.value).toContain('整数');
    fixture.view.form.value.sort = 5; await fixture.view.save();
    const saved = writes(fixture.calls)[0], body = JSON.parse(saved.data);
    expect(saved).toMatchObject({ method: 'post', url: '/marketing/integral-categories' });
    expect(body).toEqual({ name: '入门分类', integral_min: 0, integral_max: 99, is_show: 1, sort: 5, request_id: expect.stringMatching(uuid) });
    expect(fixture.view.formVisible.value).toBe(false); expect(fixture.calls.at(-1).method).toBe('get');
  } finally { fixture.close(); }
});

it('loads fresh edit details and saves only the five editable fields plus revision and request identity', async () => {
  const fixture = await mount(grants, config => config.method === 'get' && config.url.endsWith('/1')
    ? envelope(row(1, { integral_min: 100, integral_max: 300, is_show: 0, revision: 'b'.repeat(64) })) : undefined);
  try {
    await fixture.view.openForm(1);
    expect(fixture.calls.at(-1).url).toBe('/marketing/integral-categories/1');
    expect(fixture.view.form.value.integral_min).toBe(100);
    fixture.view.form.value.name = '新名称'; await fixture.view.save();
    const saved = writes(fixture.calls)[0];
    expect(saved.method).toBe('put');
    expect(JSON.parse(saved.data)).toEqual({ name: '新名称', integral_min: 100, integral_max: 300, is_show: 0, sort: 5, revision: 'b'.repeat(64), request_id: expect.stringMatching(uuid) });
  } finally { fixture.close(); }
});

it('does not expose a failed or mismatched detail response as an editable form and retries safely', async () => {
  let wrong = true;
  const fixture = await mount(grants, config => config.method === 'get' && config.url.endsWith('/1') ? envelope(row(wrong ? 2 : 1)) : undefined);
  try {
    await fixture.view.openForm(1);
    expect(fixture.view.form.value).toBeNull(); expect(fixture.view.formError.value).toContain('详情与当前记录不一致');
    await fixture.view.save(); expect(writes(fixture.calls)).toEqual([]);
    wrong = false; await fixture.view.openForm(1);
    expect(fixture.view.formError.value).toBe(''); expect(fixture.view.form.value.name).toBe('分类1');
  } finally { fixture.close(); }
});

it('confirms status changes and uses a versioned PUT without optimistic row mutation', async () => {
  const confirmation = deferred(); runtime.messages.state.confirm = () => confirmation.promise;
  let hidden = false;
  const fixture = await mount(grants, config => {
    if (config.method === 'put') { hidden = true; return envelope({ id: 1 }); }
    if (config.params) return envelope(rows(1, [row(1, { is_show: hidden ? 0 : 1 })]));
    return undefined;
  });
  try {
    const toggle = fixture.view.toggleVisibility(fixture.view.list.value[0]);
    expect(fixture.view.list.value[0].is_show).toBe(1); expect(writes(fixture.calls)).toEqual([]);
    expect(runtime.messages.state.confirmations[0][0]).toContain('隐藏');
    confirmation.resolve(); await toggle;
    expect(writes(fixture.calls)[0]).toMatchObject({ method: 'put', url: '/marketing/integral-categories/1/status' });
    expect(JSON.parse(writes(fixture.calls)[0].data)).toEqual({ is_show: 0, revision, request_id: expect.stringMatching(uuid) });
    expect(fixture.view.list.value[0].is_show).toBe(0);
  } finally { fixture.close(); }
});

it('deletes only the selected range and reads the previous page after deleting its last item', async () => {
  let deleted = false;
  const fixture = await mount(grants, config => {
    if (config.method === 'delete') { deleted = true; return envelope({ id: 2 }); }
    if (config.params) return envelope(rows(config.params.page, deleted && config.params.page === 2 ? [] : [row(config.params.page)], deleted ? 15 : 16));
    return undefined;
  });
  try {
    await fixture.view.load(2); await fixture.view.remove(fixture.view.list.value[0]);
    expect(runtime.messages.state.confirmations[0][0]).toContain('不会删除积分商品');
    expect(writes(fixture.calls)[0].url).toBe('/marketing/integral-categories/2');
    expect(JSON.parse(writes(fixture.calls)[0].data)).toEqual({ revision, request_id: expect.stringMatching(uuid) });
    expect(fixture.view.page.value).toBe(1); expect(reads(fixture.calls).slice(-2).map(call => call.params.page)).toEqual([2, 1]);
  } finally { fixture.close(); }
});

it.each(['network', 'malformed', 'conflict'])('only rereads after a %s write result and retains ambiguous request identity and body', async failure => {
  const fixture = await mount(grants, config => {
    if (config.method !== 'get') {
      if (failure === 'network') throw new Error('连接中断');
      if (failure === 'malformed') return envelope({});
      return envelope(null, 400, '积分分类已更改，请重新读取');
    }
    return undefined;
  });
  try {
    await fixture.view.openForm(0); fixture.view.form.value.name = '新分类'; fixture.view.form.value.integral_max = 100;
    await fixture.view.save();
    expect(writes(fixture.calls)).toHaveLength(1); expect(fixture.calls.at(-1).method).toBe('get');
    expect(fixture.view.formVisible.value).toBe(false);
    expect(fixture.view.actionNotice.value).toContain(failure === 'conflict' ? '操作未完成' : '操作结果未确认');
    expect(runtime.messages.state.successes).toEqual([]);
    if (failure !== 'conflict') expect(fixture.view.uncertainOperation.value.body).toEqual(JSON.parse(writes(fixture.calls)[0].data));
    else expect(fixture.view.uncertainOperation.value).toBeNull();
    await fixture.view.load(); expect(writes(fixture.calls)).toHaveLength(1);
  } finally { fixture.close(); }
});

it('discards delayed list and detail responses, and exposes read failures for retry', async () => {
  const oldList = deferred(), oldDetail = deferred();
  let fail = false;
  const fixture = await mount(grants, config => {
    if (config.params?.name === 'OLD') return oldList.promise;
    if (config.method === 'get' && config.url.endsWith('/1')) return oldDetail.promise;
    if (config.params?.page === 2 && fail) throw new Error('列表不可用');
    return undefined;
  });
  try {
    fixture.view.draftName.value = 'OLD'; fixture.view.search(); await flush();
    fixture.view.draftName.value = 'NEW'; fixture.view.search(); await flush();
    oldList.resolve(envelope(rows(1, [row(99)]))); await flush(); expect(fixture.view.list.value[0].id).toBe(1);
    const editing = fixture.view.openForm(1); await flush();
    await fixture.view.openForm(0); oldDetail.resolve(envelope(row(1))); await editing;
    expect(fixture.view.formId.value).toBe(0); expect(fixture.view.form.value.name).toBe('');
    fail = true; await fixture.view.load(2);
    expect(fixture.view.list.value).toEqual([]); expect(fixture.view.formVisible.value).toBe(false); expect(fixture.view.listError.value).toBe('列表不可用');
    fail = false; await fixture.view.load(); expect(fixture.view.page.value).toBe(2); expect(fixture.view.listError.value).toBe('');
  } finally { fixture.close(); }
});

it('invalidates confirmations on query changes and A-B-A account replacements', async () => {
  const confirmation = deferred(); runtime.messages.state.confirm = () => confirmation.promise;
  const fixture = await mount();
  try {
    const remove = fixture.view.remove(fixture.view.list.value[0]); await fixture.view.load(2);
    confirmation.resolve(); await remove; expect(writes(fixture.calls)).toEqual([]);
    const second = deferred(); runtime.messages.state.confirm = () => second.promise;
    const toggle = fixture.view.toggleVisibility(fixture.view.list.value[0]);
    login(grants, 'integral-category-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed'));
    login(); browser.dispatchEvent(new Event('admin-session-changed')); await flush();
    second.resolve(); await toggle;
    expect(writes(fixture.calls)).toEqual([]); expect(runtime.messages.state.closed).toBeGreaterThan(0);
  } finally { fixture.close(); }
});

it('does not let a previous account save close the replacement editor or restore its rows', async () => {
  const late = deferred();
  const fixture = await mount(grants, config => config.method === 'post' ? late.promise : undefined);
  try {
    await fixture.view.openForm(0); fixture.view.form.value.name = '旧账号分类'; fixture.view.form.value.integral_max = 10;
    const save = fixture.view.save(); await flush();
    const request = writes(fixture.calls)[0];
    login(grants, 'integral-category-token-b', 21); browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'admin_session' }));
    await flush(); await fixture.view.openForm(0); fixture.view.form.value.name = '新账号草稿';
    late.resolve(envelope({ id: 99 })); await save;
    expect(request.signal.aborted).toBe(true); expect(fixture.view.formVisible.value).toBe(true);
    expect(fixture.view.form.value.name).toBe('新账号草稿'); expect(runtime.messages.state.successes).toEqual([]);
    login([], 'integral-category-token-c', 22); browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'admin_token' }));
    expect(fixture.view.list.value).toEqual([]); expect(fixture.view.formVisible.value).toBe(false);
    const count = fixture.calls.length; await fixture.view.load(); expect(fixture.calls).toHaveLength(count);
  } finally { fixture.close(); }
});

it('cancels a pending detail and confirmation on unmount', async () => {
  const late = deferred(), confirmation = deferred();
  const fixture = await mount(grants, config => config.method === 'get' && config.url.endsWith('/1') ? late.promise : undefined);
  const detail = fixture.view.openForm(1); await flush();
  fixture.view.formVisible.value = false; fixture.view.onFormClosed();
  runtime.messages.state.confirm = () => confirmation.promise;
  const remove = fixture.view.remove(fixture.view.list.value[0]); fixture.close();
  late.resolve(envelope(row(1))); confirmation.resolve(); await detail; await remove;
  expect(fixture.view.form.value).toBeNull(); expect(fixture.view.list.value).toEqual([]); expect(writes(fixture.calls)).toEqual([]);
});
