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
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { search: '', pathname: '/agent/promoter-applications', href: '' } }));
  const result = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, contents: `
      export { default as Page } from './src/pages/agent/PromoterApplications.vue';
      export { default as request } from './src/utils/request';
      export * as promoter from './src/api/promoterApplication';
      export { createRenderer, nextTick } from 'vue';
      export { createPinia } from 'pinia';
      export * as messages from 'element-plus';
    ` },
    alias: { '@': resolve(root, 'src') },
    define: { 'import.meta.env.DEV': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'promoter-applications-page', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'promoter-applications' }).content,
        loader: 'ts',
      }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'messages', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const state = { successes: [], confirmations: [], confirm: () => Promise.resolve(), closed: 0 };
        export const ElMessage = { success: value => state.successes.push(value) };
        export const ElMessageBox = {
          confirm(...args) { state.confirmations.push(args); return state.confirm(...args); },
          close() { state.closed++; }
        };`,
      }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});

function login(permissions: string[], token = 'promoter-token-a', id = 20) {
  localStorage.setItem('admin_token', token);
  localStorage.setItem('admin_session', JSON.stringify({
    userInfo: { id, account: 'operator', level: 1, roles: '' }, menus: [], uniqueAuth: permissions,
  }));
}
beforeEach(() => {
  const values = new Map<string, string>();
  browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { search: '', pathname: '/agent/promoter-applications', href: '' } }));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  runtime.messages.state.successes = [];
  runtime.messages.state.confirmations = [];
  runtime.messages.state.confirm = () => Promise.resolve();
  runtime.messages.state.closed = 0;
});
afterEach(() => vi.unstubAllGlobals());

const grants = ['distribution.view', 'distribution.manage'];
const revision = 'a'.repeat(64);
const row = (id = 1, status = 0, refusal_reason = '') => ({ id, uid: 80 + id, nickname: `用户${id}`, real_name: `姓名${id}`, phone: '13800000001',
  status, add_time: '2026-09-26 08:00:00', status_time: status ? '2026-09-26 09:00:00' : '', refusal_reason, revision });
const rows = (page = 1, list: unknown[] = [row(page)], count = 16) => ({ list, count, page, limit: 15 });
const envelope = (data: unknown, status = 200, msg = 'ok') => ({ status, msg, data });
const flush = async () => {
  for (let index = 0; index < 8; index++) {
    await new Promise(done => setTimeout(done, 1));
    await runtime.nextTick();
  }
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
    const data = custom ?? envelope(config.method === 'get' ? rows(config.params.page) : null);
    return { config, data, status: 200, statusText: 'promoter fixture', headers: {} };
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
const writes = (calls: any[]) => calls.filter(call => call.method !== 'get');

it('validates server rows and keeps the new route and its menu distinct from distribution management', () => {
  const query = { page: 1, limit: 15 };
  expect(runtime.promoter.parsePromoterApplicationPage(rows(), query).list[0].revision).toBe(revision);
  for (const invalid of [null, rows(2), { ...rows(), count: -1 }, { ...rows(), limit: 20 }, { list: [], count: 0 }]) {
    expect(() => runtime.promoter.parsePromoterApplicationPage(invalid, query)).toThrow('分页响应格式错误');
  }
  for (const invalid of [{ ...row(), status: 3 }, { ...row(), revision: '' }, { ...row(), uid: 0 }, { ...row(), add_time: 123 }]) {
    expect(() => runtime.promoter.parsePromoterApplicationPage(rows(1, [invalid]), query)).toThrow('记录格式错误');
  }
  expect(() => runtime.promoter.parsePromoterApplicationPage(rows(1, [row(), row()]), query)).toThrow('记录格式错误');
  const router = readFileSync(resolve(root, 'src/router/index.ts'), 'utf8');
  const layout = readFileSync(resolve(root, 'src/layouts/AdminLayout.vue'), 'utf8');
  expect(router).toContain('path: "agent/promoter-applications"');
  expect(router).toContain('@/pages/agent/PromoterApplications.vue');
  expect(layout).toContain('index="/agent/promoter-applications"');
  expect(layout.indexOf('if (path.startsWith("/agent/promoter-applications"))')).toBeLessThan(layout.indexOf('if (path.startsWith("/agent"))'));
});

it('gates direct reads and writes separately and prevents reviewing non-pending rows', async () => {
  const denied = await mount(['agent.view']);
  try {
    expect(denied.view.canView.value).toBe(false);
    await denied.view.load();
    await denied.view.approve(row());
    expect(denied.calls).toEqual([]);
  } finally { denied.close(); }
  const viewer = await mount(['distribution.view']);
  try {
    expect(viewer.view.canManage.value).toBe(false);
    await viewer.view.approve(viewer.view.list.value[0]);
    viewer.view.openReject(viewer.view.list.value[0]);
    await viewer.view.remove(viewer.view.list.value[0]);
    expect(viewer.view.rejectVisible.value).toBe(false);
    expect(writes(viewer.calls)).toEqual([]);
    expect(runtime.messages.state.confirmations).toEqual([]);
  } finally { viewer.close(); }
  const reviewed = await mount(grants, config => config.method === 'get' ? envelope(rows(1, [row(1, 1)])) : undefined);
  try {
    await reviewed.view.approve(reviewed.view.list.value[0]);
    reviewed.view.openReject(reviewed.view.list.value[0]);
    expect(writes(reviewed.calls)).toEqual([]);
    expect(reviewed.view.rejectVisible.value).toBe(false);
  } finally { reviewed.close(); }
});

it('uses 15-row pagination and applied name/status filters, and clears the old rows on every query', async () => {
  const fixture = await mount();
  try {
    expect(fixture.calls[0]).toMatchObject({ url: '/promoter/apply/list', method: 'get', params: { page: 1, limit: 15, keyword: '', status: 'all' } });
    expect(fixture.view.count.value).toBe(16);
    fixture.view.draftKeyword.value = ' 姓名%_\\ ';
    fixture.view.draftStatus.value = 0;
    fixture.view.search();
    expect(fixture.view.list.value).toEqual([]);
    await flush();
    expect(fixture.calls.at(-1).params).toEqual({ page: 1, limit: 15, keyword: '姓名%_\\', status: 0 });
    fixture.view.draftKeyword.value = '未提交';
    await fixture.view.load(2);
    expect(fixture.calls.at(-1).params).toMatchObject({ page: 2, keyword: '姓名%_\\', status: 0 });
    expect(fixture.view.page.value).toBe(2);
    fixture.view.reset(); await flush();
    expect(fixture.calls.at(-1).params).toEqual({ page: 1, limit: 15, keyword: '', status: 'all' });
  } finally { fixture.close(); }
});

it('ignores delayed page and filter responses and exposes malformed or failed reads for retry', async () => {
  const old = deferred();
  let fail = false, malformed = false;
  const fixture = await mount(grants, config => {
    if (config.params?.keyword === 'OLD') return old.promise;
    if (config.params?.page === 2 && fail) throw new Error('读取失败');
    if (config.params?.page === 2 && malformed) return envelope({ list: [], count: 0 });
    return undefined;
  });
  try {
    fixture.view.draftKeyword.value = 'OLD'; fixture.view.search(); await flush();
    const stale = fixture.calls.at(-1);
    fixture.view.draftKeyword.value = 'NEW'; fixture.view.search(); await flush();
    expect(stale.signal.aborted).toBe(true);
    old.resolve(envelope(rows(1, [row(99)]))); await flush();
    expect(fixture.view.list.value[0].id).toBe(1);
    fail = true;
    await fixture.view.load(2);
    expect(fixture.view.list.value).toEqual([]);
    expect(fixture.view.listError.value).toBe('读取失败');
    fail = false; malformed = true;
    await fixture.view.load();
    expect(fixture.view.listError.value).toContain('分页响应格式错误');
    malformed = false;
    await fixture.view.load();
    expect(fixture.view.page.value).toBe(2);
    expect(fixture.view.list.value[0].id).toBe(2);
    expect(fixture.view.listError.value).toBe('');
  } finally { fixture.close(); }
});

it('requires confirmation before approving and includes the reviewed material revision in the POST', async () => {
  const confirmation = deferred();
  let approved = false;
  runtime.messages.state.confirm = () => confirmation.promise;
  const fixture = await mount(grants, config => {
    if (config.method === 'post') { approved = true; return envelope(null); }
    return envelope(rows(1, [row(1, approved ? 1 : 0)]));
  });
  try {
    const approve = fixture.view.approve(fixture.view.list.value[0]);
    expect(writes(fixture.calls)).toEqual([]);
    expect(runtime.messages.state.confirmations[0][0]).toContain('UID 81');
    confirmation.resolve(); await approve;
    expect(writes(fixture.calls)).toHaveLength(1);
    expect(writes(fixture.calls)[0]).toMatchObject({ method: 'post', url: '/promoter/apply/examine/1/81/1' });
    expect(JSON.parse(writes(fixture.calls)[0].data)).toEqual({ revision });
    expect(fixture.view.list.value[0].status).toBe(1);
    expect(fixture.calls.at(-1).method).toBe('get');
    await fixture.view.approve(fixture.view.list.value[0]);
    expect(writes(fixture.calls)).toHaveLength(1);
  } finally { fixture.close(); }
});

it('requires a refusal reason and sends the trimmed text with the original material revision', async () => {
  let rejected = false;
  const fixture = await mount(grants, config => {
    if (config.method === 'post') { rejected = true; return envelope(null); }
    return envelope(rows(1, [row(1, rejected ? 2 : 0, rejected ? '资料不完整' : '')]));
  });
  try {
    fixture.view.openReject(fixture.view.list.value[0]);
    expect(fixture.view.rejectVisible.value).toBe(true);
    fixture.view.rejectReason.value = '  ';
    await fixture.view.confirmReject();
    expect(fixture.view.rejectError.value).toContain('拒绝原因');
    expect(writes(fixture.calls)).toEqual([]);
    fixture.view.rejectReason.value = ' 资料不完整 ';
    await fixture.view.confirmReject();
    expect(writes(fixture.calls)[0].url).toBe('/promoter/apply/examine/1/81/2');
    expect(JSON.parse(writes(fixture.calls)[0].data)).toEqual({ revision, refusal_reason: '资料不完整' });
    expect(fixture.view.rejectVisible.value).toBe(false);
    expect(fixture.view.list.value[0]).toMatchObject({ status: 2, refusal_reason: '资料不完整' });
  } finally { fixture.close(); }
});

it('explains soft deletion, sends its revision, and moves back after deleting the last row of a page', async () => {
  let deleted = false;
  const fixture = await mount(grants, config => {
    if (config.method === 'delete') { deleted = true; return envelope(null); }
    const page = config.params.page;
    return envelope(rows(page, deleted && page === 2 ? [] : [row(page, 1)], deleted ? 15 : 16));
  });
  try {
    await fixture.view.load(2);
    await fixture.view.remove(fixture.view.list.value[0]);
    expect(runtime.messages.state.confirmations[0][0]).toContain('不会取消已获得的分销资格');
    expect(writes(fixture.calls)[0].url).toBe('/promoter/apply/del/2');
    expect(JSON.parse(writes(fixture.calls)[0].data)).toEqual({ revision });
    expect(fixture.view.page.value).toBe(1);
    expect(fixture.view.list.value[0].id).toBe(1);
    expect(fixture.calls.slice(-2).map(call => call.params.page)).toEqual([2, 1]);
  } finally { fixture.close(); }
});

it.each(['network', 'conflict'])('refreshes state after a %s failure without replaying the mutation', async failure => {
  let attempted = false;
  const fixture = await mount(grants, config => {
    if (config.method === 'post') {
      attempted = true;
      if (failure === 'network') throw new Error('连接中断');
      return envelope(null, 400, '申请资料已变更，请刷新后重新审核');
    }
    return envelope(rows(1, [{ ...row(1, attempted ? 1 : 0), revision: (attempted ? 'b' : 'a').repeat(64) }]));
  });
  try {
    await fixture.view.approve(fixture.view.list.value[0]);
    expect(writes(fixture.calls)).toHaveLength(1);
    expect(fixture.calls.at(-1).method).toBe('get');
    expect(fixture.view.actionNotice.value).toContain(failure === 'network' ? '操作结果未确认' : '操作未完成');
    expect(fixture.view.list.value[0].status).toBe(1);
    expect(fixture.view.list.value[0].revision).toBe('b'.repeat(64));
    expect(runtime.messages.state.successes).toEqual([]);
  } finally { fixture.close(); }
});

it('invalidates a pending confirmation after a query change or an A-B-A session replacement', async () => {
  const confirmation = deferred();
  runtime.messages.state.confirm = () => confirmation.promise;
  const fixture = await mount();
  try {
    const approve = fixture.view.approve(fixture.view.list.value[0]);
    await fixture.view.load(2);
    confirmation.resolve(); await approve;
    expect(writes(fixture.calls)).toEqual([]);
    const second = deferred(); runtime.messages.state.confirm = () => second.promise;
    const remove = fixture.view.remove(fixture.view.list.value[0]);
    login(grants, 'promoter-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed'));
    login(grants); browser.dispatchEvent(new Event('admin-session-changed'));
    await flush();
    second.resolve(); await remove;
    expect(writes(fixture.calls)).toEqual([]);
    expect(runtime.messages.state.closed).toBeGreaterThan(0);
  } finally { fixture.close(); }
});

it('discards old mutation responses and read data when a storage event replaces or revokes the account', async () => {
  const late = deferred();
  const fixture = await mount(grants, config => {
    if (config.method === 'post') return late.promise;
    const id = config.headers['Authori-zation'] === 'Bearer promoter-token-b' ? 42 : 1;
    return envelope(rows(1, [row(id)]));
  });
  try {
    const approve = fixture.view.approve(fixture.view.list.value[0]); await flush();
    const oldRequest = writes(fixture.calls)[0];
    login(grants, 'promoter-token-b', 21);
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'admin_session' }));
    await flush();
    expect(oldRequest.signal.aborted).toBe(true);
    expect(fixture.view.list.value[0].id).toBe(42);
    late.resolve(envelope(null)); await approve;
    expect(runtime.messages.state.successes).toEqual([]);
    expect(fixture.view.list.value[0].id).toBe(42);
    expect(fixture.view.actionNotice.value).toBe('');
    login([], 'promoter-token-c', 22);
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'admin_token' }));
    expect(fixture.view.list.value).toEqual([]);
    expect(fixture.view.canView.value).toBe(false);
    const count = fixture.calls.length;
    await fixture.view.load();
    expect(fixture.calls).toHaveLength(count);
  } finally { fixture.close(); }
});

it('does not submit a rejection after its list generation changed or a confirmation after unmount', async () => {
  const fixture = await mount();
  fixture.view.openReject(fixture.view.list.value[0]);
  fixture.view.rejectReason.value = '资料不完整';
  await fixture.view.load();
  await fixture.view.confirmReject();
  expect(writes(fixture.calls)).toEqual([]);
  const confirmation = deferred(); runtime.messages.state.confirm = () => confirmation.promise;
  const pending = fixture.view.approve(fixture.view.list.value[0]);
  fixture.close();
  confirmation.resolve(); await pending;
  expect(writes(fixture.calls)).toEqual([]);
  expect(fixture.view.list.value).toEqual([]);
});
