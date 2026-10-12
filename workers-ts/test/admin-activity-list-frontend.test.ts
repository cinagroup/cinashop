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
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { search: '', pathname: '/activity', href: '' } }));
  const result = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, contents: `
      export { default as Page } from './src/pages/activity/ActivityList.vue';
      export { default as request } from './src/utils/request';
      export * as activity from './src/api/activity';
      export { createRenderer, nextTick } from 'vue';
      export { createPinia } from 'pinia';
      export * as messages from 'element-plus';
    ` },
    alias: { '@': resolve(root, 'src') },
    define: { 'import.meta.env.DEV': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'activity-list-page', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'activity-list' }).content,
        loader: 'ts',
      }));
      builder.onResolve({ filter: /^(element-plus|vue-router)$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'vue-router'
        ? `export function useRouter() { return { push() {} }; }
          export function useRoute() { return { query: {} }; }`
        : `export const state = { errors: [], successes: [], confirmations: 0 };
          export const ElMessage = { error: value => state.errors.push(value), success: value => state.successes.push(value) };
          export const ElMessageBox = { confirm() { state.confirmations++; return Promise.resolve(); } };`,
      }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});

function login(permissions: string[], token = 'activity-token-a', id = 20) {
  localStorage.setItem('admin_token', token);
  localStorage.setItem('admin_session', JSON.stringify({
    userInfo: { id, account: 'operator', level: 1, roles: '' }, menus: [], uniqueAuth: permissions,
  }));
}

beforeEach(() => {
  const values = new Map<string, string>();
  browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { search: '', pathname: '/activity', href: '' } }));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  runtime.messages.state.errors = [];
  runtime.messages.state.successes = [];
  runtime.messages.state.confirmations = 0;
});
afterEach(() => vi.unstubAllGlobals());

const row = (id: number) => ({ id, productId: 7, storeName: `活动 ${id}`, price: '12.50', stock: 8, sales: 3, status: 1, sort: 5 });
const rows = (page = 1, id = page) => ({ list: [row(id)], count: 21, page, limit: 20 });
const envelope = (data: unknown) => ({ status: 200, msg: 'ok', data });
const flush = async () => {
  for (let index = 0; index < 8; index++) {
    await new Promise(done => setTimeout(done, 1));
    await runtime.nextTick();
  }
};
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function mount(permissions = ['activity.view'], respond: (config: any) => unknown = () => undefined) {
  login(permissions);
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const result = await respond(config);
    const data = result ?? (config.url === '/activity/seckill_times' ? []
      : config.method !== 'get' ? { id: 7 }
      : config.params ? rows(config.params.page) : [row(1)]);
    return { config, data: envelope(data), status: 200, statusText: 'activity fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({
    createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {},
  });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) {
    view = runtime.Page.setup(props, context);
    return () => null;
  } });
  app.use(runtime.createPinia());
  app.mount({ children: [] });
  await flush();
  return { view, calls, close: () => app.unmount() };
}

const catalogs = (calls: any[]) => calls.filter(call => /^\/activity\/(seckill|combination|bargain|integral)$/u.test(call.url));

it('preserves all four array clients while adding typed, validated paginated requests', async () => {
  const fixture = await mount();
  try {
    for (const name of ['apiAdminSeckillList', 'apiAdminCombinationList', 'apiAdminBargainList', 'apiAdminIntegralList']) {
      expect(await runtime.activity[name]()).toEqual([row(1)]);
      expect(fixture.calls.at(-1).params).toBeUndefined();
      expect(await runtime.activity[name]({ page: 2, limit: 20, keyword: '%_\\', status: 0 })).toEqual(rows(2));
      expect(fixture.calls.at(-1).params).toEqual({ page: 2, limit: 20, keyword: '%_\\', status: 0 });
    }
  } finally { fixture.close(); }
});

it('uses server totals, applied name/status filters and page resets for all catalogs', async () => {
  const fixture = await mount();
  try {
    expect(fixture.view.count.value).toBe(21);
    expect(fixture.view.list.value).toHaveLength(1);
    expect(catalogs(fixture.calls)[0].params).toEqual({ page: 1, limit: 20, keyword: '' });
    for (const tab of ['seckill', 'combination', 'bargain', 'integral']) {
      fixture.view.activeTab.value = tab;
      await flush();
      fixture.view.draftKeyword.value = ' 商品%_\\ ';
      fixture.view.draftStatus.value = 0;
      fixture.view.search();
      expect(fixture.view.list.value).toEqual([]);
      expect(fixture.view.count.value).toBe(0);
      await flush();
      expect(catalogs(fixture.calls).at(-1)).toMatchObject({ url: `/activity/${tab}`, params: { page: 1, limit: 20, keyword: '商品%_\\', status: 0 } });
      fixture.view.draftKeyword.value = '未提交的输入';
      await fixture.view.load(2);
      expect(catalogs(fixture.calls).at(-1).params).toMatchObject({ page: 2, keyword: '商品%_\\', status: 0 });
      expect(fixture.view.page.value).toBe(2);
      fixture.view.reset();
      await flush();
      expect(catalogs(fixture.calls).at(-1).params).toEqual({ page: 1, limit: 20, keyword: '' });
    }
    const count = fixture.calls.length;
    fixture.view.activeTab.value = 'discounts';
    expect(fixture.view.list.value).toEqual([]);
    await flush();
    expect(fixture.calls).toHaveLength(count);
  } finally { fixture.close(); }
});

it('clears rows immediately and ignores delayed page, filter, tab and seckill-time responses', async () => {
  const oldPage = deferred(), oldTimes = deferred(), oldFilter = deferred();
  const fixture = await mount(undefined, config => {
    if (config.url === '/activity/seckill_times') return oldTimes.promise;
    if (config.params?.page === 2) return oldPage.promise;
    if (config.params?.keyword === 'OLD') return oldFilter.promise;
    return undefined;
  });
  try {
    const pendingPage = fixture.view.load(2);
    expect(fixture.view.list.value).toEqual([]);
    expect(fixture.view.loading.value).toBe(true);
    await flush();
    const pageRequest = catalogs(fixture.calls).at(-1);
    fixture.view.activeTab.value = 'combination';
    expect(fixture.view.list.value).toEqual([]);
    await flush();
    expect(pageRequest.signal.aborted).toBe(true);
    oldPage.resolve(rows(2, 99)); oldTimes.resolve([{ id: 99 }]);
    await pendingPage;
    await flush();
    expect(fixture.view.list.value[0].id).toBe(1);
    expect(fixture.view.seckillTimes.value).toEqual([]);

    fixture.view.draftKeyword.value = 'OLD'; fixture.view.search(); await flush();
    fixture.view.draftKeyword.value = 'NEW'; fixture.view.search(); await flush();
    oldFilter.resolve(rows(1, 88)); await flush();
    expect(fixture.view.list.value[0].id).toBe(1);
    expect(fixture.view.loading.value).toBe(false);
    expect(fixture.view.listError.value).toBe('');
  } finally { fixture.close(); }
});

it('shows request and malformed-response errors without presenting a normal empty result, then retries the failed page', async () => {
  let fail = true, malformed = false;
  const fixture = await mount(undefined, config => {
    if (config.params?.page === 2 && fail) throw new Error('活动服务暂时不可用');
    if (config.params?.page === 2 && malformed) return [row(2)];
    return undefined;
  });
  try {
    await fixture.view.load(2);
    expect(fixture.view.list.value).toEqual([]);
    expect(fixture.view.count.value).toBe(0);
    expect(fixture.view.listError.value).toBe('活动服务暂时不可用');
    expect(fixture.view.page.value).toBe(2);
    fail = false; malformed = true;
    await fixture.view.load();
    expect(fixture.view.listError.value).toBe('活动分页响应格式错误');
    malformed = false;
    await fixture.view.load();
    expect(fixture.view.listError.value).toBe('');
    expect(fixture.view.page.value).toBe(2);
    expect(fixture.view.list.value[0].id).toBe(2);
  } finally { fixture.close(); }
});

it('requires activity.view for reads and activity.manage for mutations, and discards a replaced account', async () => {
  const denied = await mount(['marketing.view']);
  try {
    expect(denied.view.canView.value).toBe(false);
    await denied.view.load();
    expect(denied.calls).toEqual([]);
  } finally { denied.close(); }
  const fixture = await mount();
  try {
    expect(fixture.view.canView.value).toBe(true);
    expect(fixture.view.canManage.value).toBe(false);
    fixture.view.openForm(row(1));
    await fixture.view.toggleStatus(row(1));
    await fixture.view.del(row(1));
    await fixture.view.save();
    expect(fixture.view.formVisible.value).toBe(false);
    expect(fixture.calls.every(call => call.method === 'get')).toBe(true);
    expect(runtime.messages.state.confirmations).toBe(0);
    login([], 'activity-token-b', 21);
    browser.dispatchEvent(new Event('admin-session-changed'));
    await flush();
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.view.list.value).toEqual([]);
    expect(fixture.view.count.value).toBe(0);
    const count = fixture.calls.length;
    await fixture.view.load();
    expect(fixture.calls).toHaveLength(count);
  } finally { fixture.close(); }
});

it('keeps legacy combination reads while refusing generic writes even for an activity manager', async () => {
  const fixture = await mount(['activity.view', 'activity.manage', 'combination.view', 'combination.manage']);
  try {
    fixture.view.activeTab.value = 'combination'; await flush();
    expect(fixture.view.canManage.value).toBe(false);
    fixture.view.openForm(row(1));
    await fixture.view.toggleStatus(row(1)); await fixture.view.del(row(1)); await fixture.view.save();
    expect(fixture.view.formVisible.value).toBe(false);
    expect(fixture.calls.every(call => call.method === 'get')).toBe(true);
    expect(catalogs(fixture.calls).some(call => call.url === '/activity/combination')).toBe(true);
    expect(runtime.messages.state.confirmations).toBe(0);
  } finally { fixture.close(); }
});

it('preserves editing and status updates, and returns to the previous page after deleting its final row', async () => {
  let deleted = false;
  const fixture = await mount(['activity.view', 'activity.manage'], config => {
    if (config.method === 'delete') { deleted = true; return { id: 2 }; }
    if (config.params?.page === 2 && deleted) return { list: [], count: 20, page: 2, limit: 20 };
    return undefined;
  });
  try {
    fixture.view.openForm(row(1));
    expect(fixture.view.formVisible.value).toBe(true);
    fixture.view.form.storeName = '改名后的活动';
    await fixture.view.save(); await flush();
    const saved = fixture.calls.find(call => call.url === '/activity/save');
    expect(JSON.parse(saved.data)).toMatchObject({ type: 'seckill', id: 1, productId: 7, storeName: '改名后的活动', price: '12.50' });
    expect(fixture.view.formVisible.value).toBe(false);
    await fixture.view.toggleStatus(row(1)); await flush();
    expect(JSON.parse(fixture.calls.find(call => call.url === '/activity/status').data)).toEqual({ type: 'seckill', id: 1, status: 0 });
    await fixture.view.load(2);
    await fixture.view.del(row(2)); await flush();
    expect(fixture.calls.some(call => call.url === '/activity/del/seckill/2')).toBe(true);
    expect(fixture.view.page.value).toBe(1);
    expect(fixture.view.list.value[0].id).toBe(1);
    expect(catalogs(fixture.calls).slice(-2).map(call => call.params.page)).toEqual([2, 1]);
  } finally { fixture.close(); }
});

it('does not allow a pending response to restore data after unmount', async () => {
  const late = deferred();
  const fixture = await mount(undefined, config => config.params?.page === 2 ? late.promise : undefined);
  const pending = fixture.view.load(2);
  await flush();
  fixture.close();
  late.resolve(rows(2));
  await pending;
  expect(fixture.view.list.value).toEqual([]);
  expect(fixture.view.loading.value).toBe(false);
});

it('clears a cross-tab replacement session and prevents an old save from closing the replacement form', async () => {
  const lateSave = deferred();
  const fixture = await mount(['activity.view', 'activity.manage'], config => config.url === '/activity/save' ? lateSave.promise : undefined);
  try {
    fixture.view.openForm(row(1));
    const save = fixture.view.save();
    await flush();
    login(['activity.view', 'activity.manage'], 'activity-token-b', 21);
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'admin_session' }));
    await flush();
    expect(fixture.view.formVisible.value).toBe(false);
    fixture.view.openForm(row(2));
    lateSave.resolve({ id: 1 });
    await save;
    expect(fixture.view.formVisible.value).toBe(true);
    expect(fixture.view.form.id).toBe(2);
    expect(fixture.view.saving.value).toBe(false);
    expect(runtime.messages.state.successes).toEqual([]);
    login([], 'activity-token-c', 22);
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'admin_token' }));
    await flush();
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.view.list.value).toEqual([]);
  } finally { fixture.close(); }
});
