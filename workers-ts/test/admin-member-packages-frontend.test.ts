import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
let runtime: any, storage: Map<string, string>;
const manager = ['paid_membership.view', 'paid_membership.manage'];
const ownerEvent = (name: string) => (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(new Event(name));
function session(id = 9601, permissions = manager, dispatch = true) {
  storage.set('admin_token', `isolated-owner-${id}`);
  storage.set('admin_session', JSON.stringify({ userInfo: { id, account: `owner-${id}`, head_pic: '',
    real_name: '目录管理员', level: 1, roles: '1' }, menus: [], uniqueAuth: permissions }));
  if (dispatch) ownerEvent('admin-session-changed');
}
function globals() {
  storage = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/member', href: '' } }));
}
beforeAll(async () => {
  globals();
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/user/PaidMembership.vue';
    export { membershipPlanPage } from './src/composables/useMembershipPlanCatalogue';
    export { default as request } from './src/utils/request';
    export { createRenderer, nextTick } from 'vue'; export { createPinia } from 'pinia';
    export * as messages from 'element-plus';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'real-membership-page', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(
        parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'membership-catalogue' }).content, loader: 'ts' }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'messages', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const state = { errors: [], warnings: [], successes: [] };
        export const ElMessage = { error: v => state.errors.push(v), warning: v => state.warnings.push(v), success: v => state.successes.push(v) };
        export const ElMessageBox = { confirm: () => Promise.resolve() };
      ` }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
beforeEach(() => { globals(); session(); for (const key of ['errors', 'warnings', 'successes']) runtime.messages.state[key] = []; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
const deferred = () => { let resolve!: (value?: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const catalogue = (n = 125) => Array.from({ length: n }, (_, i) => ({ id: 7001 + i, type: i === 0 ? 'legacy-import' : 'month',
  title: `套餐 ${7001 + i}`, vip_day: 30, price: '19.90', pre_price: '29.90', is_label: 0, sort: 0, is_del: i % 9 === 0 ? 1 : 0, add_time: 1793000000 }));
const isCatalogue = (c: any) => c.url === '/member/ship' && c.params?.include_deleted === 1;
async function mount() {
  const calls: any[] = [], data = catalogue();
  const hooks: { read?: (c: any) => Promise<unknown>; write?: (c: any) => Promise<unknown> } = {};
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); let result: any = { list: [], count: 0 };
    if (config.method === 'get' && config.url === '/member/ship') {
      if (isCatalogue(config) && hooks.read) result = await hooks.read(config);
      else { const rows = data.filter(row => config.params?.include_deleted === 1 || row.is_del === 0);
        const page = Number(config.params?.page ?? 1), limit = Number(config.params?.limit ?? 20);
        result = { list: rows.slice((page - 1) * limit, page * limit).map(row => ({ ...row })), count: rows.length }; }
    } else if (config.method === 'post') {
      if (hooks.write) result = await hooks.write(config);
      else { const body = JSON.parse(config.data), id = Number(body.id ?? config.url.split('/').at(-1));
        const row = data.find(row => row.id === id);
        if (config.url === '/member_ship/set_ship_status') row!.is_del = body.is_del;
        else if (row) Object.assign(row, body);
        result = { id }; }
    }
    return { config, data: { status: 200, msg: 'ok', data: result }, status: 200, statusText: 'isolated catalogue transport', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { calls, data, hooks, view, close: () => app.unmount(), reads: () => calls.filter(isCatalogue), writes: () => calls.filter(c => c.method === 'post') };
}

it('reads all statuses in bounded pages while record choices remain active-only', async () => {
  const f = await mount(); try {
    expect(f.view.plans.value).toHaveLength(20); expect(f.view.planCount.value).toBe(125);
    expect(f.view.activePlanCount.value).toBe(17); expect(f.view.recordPlanOptions.value).toHaveLength(111);
    expect(f.reads().every(c => c.params.limit === 20 && c.signal instanceof AbortSignal)).toBe(true);
    expect(f.calls.filter(c => c.url === '/member/ship' && !isCatalogue(c)).map(c => c.params)).toEqual([
      { page: 1, limit: 100 }, { page: 2, limit: 100 }]);
    await f.view.loadPlans(7); expect(f.view.plans.value.map((row: any) => row.id)).toEqual([7121, 7122, 7123, 7124, 7125]);
    await f.view.loadPlans(); expect(f.view.planPage.value).toBe(7); expect(f.writes()).toHaveLength(0);
  } finally { f.close(); }
});
it('keeps disabled plans available and refreshes authoritative state after each explicit toggle', async () => {
  const f = await mount(); try {
    await f.view.togglePlan(f.view.plans.value[1], false);
    expect(f.view.plans.value.find((row: any) => row.id === 7002).is_del).toBe(1);
    await f.view.loadPlans(); await f.view.togglePlan(f.view.plans.value[1], true);
    expect(f.view.plans.value[1].is_del).toBe(0); expect(f.view.planCount.value).toBe(125);
    expect(f.writes().map(c => [c.url, JSON.parse(c.data)])).toEqual([
      ['/member_ship/set_ship_status', { id: 7002, is_del: 1 }], ['/member_ship/set_ship_status', { id: 7002, is_del: 0 }]]);
  } finally { f.close(); }
});
it('preserves the last successful page and count on failure and retries the requested page', async () => {
  const f = await mount(); try {
    const ids = f.view.plans.value.map((row: any) => row.id);
    f.hooks.read = async () => { throw new Error('目录网络失败'); };
    expect(await f.view.loadPlans(7)).toBe(false); expect(f.view.planError.value).toContain('目录网络失败');
    expect(f.view.planPage.value).toBe(1); expect(f.view.planCount.value).toBe(125); expect(f.view.plans.value.map((row: any) => row.id)).toEqual(ids);
    delete f.hooks.read; expect(await f.view.loadPlans(7)).toBe(true); expect(f.view.planPage.value).toBe(7); expect(f.view.planError.value).toBe('');
  } finally { f.close(); }
});
it('corrects a vanished final page once and never fabricates an empty successful page', async () => {
  const f = await mount(); try {
    await f.view.loadPlans(7); f.data.splice(8); const before = f.reads().length;
    expect(await f.view.loadPlans()).toBe(true); expect(f.reads().slice(before).map(c => c.params.page)).toEqual([7, 1]);
    expect(f.view.planPage.value).toBe(1); expect(f.view.planCount.value).toBe(8); expect(f.view.plans.value).toHaveLength(8);
  } finally { f.close(); }
});
it('aborts an obsolete read and only adopts the latest requested page', async () => {
  const f = await mount(), gate = deferred(); try {
    f.hooks.read = async () => { await gate.promise; return { list: [], count: 0 }; };
    const old = f.view.loadPlans(2); await flush(); const oldRequest = f.reads().at(-1);
    delete f.hooks.read; expect(await f.view.loadPlans(7)).toBe(true); expect(oldRequest.signal.aborted).toBe(true);
    gate.resolve(); await old; expect(f.view.planPage.value).toBe(7); expect(f.view.planCount.value).toBe(125);
  } finally { gate.resolve(); f.close(); }
});
it('blocks duplicate toggles and retained row handlers after changing pages', async () => {
  const f = await mount(), gate = deferred(); try {
    const row = f.view.plans.value[1]; f.hooks.write = async () => { await gate.promise; return { id: row.id }; };
    const first = f.view.togglePlan(row, false); await flush(); await f.view.togglePlan(row, false);
    expect(f.writes()).toHaveLength(1); gate.resolve(); await first;
    delete f.hooks.write; await f.view.loadPlans(7); await f.view.togglePlan(row, false); f.view.openPlan(row);
    expect(f.writes()).toHaveLength(1); expect(f.view.planDialog.value).toBe(false);
  } finally { gate.resolve(); f.close(); }
});
it('refreshes the committed server state after a lost write response without retrying the write', async () => {
  const f = await mount(); try {
    f.hooks.write = async c => { const body = JSON.parse(c.data); f.data.find(row => row.id === body.id)!.is_del = body.is_del;
      throw new Error('响应丢失'); };
    await f.view.togglePlan(f.view.plans.value[1], false);
    expect(f.view.plans.value[1].is_del).toBe(1); expect(f.writes()).toHaveLength(1);
    expect(runtime.messages.state.successes).toHaveLength(0); expect(runtime.messages.state.errors.at(-1)).toContain('响应丢失');
  } finally { f.close(); }
});
it('saves an edit and reloads the same actual page', async () => {
  const f = await mount(); try {
    await f.view.loadPlans(7); f.view.openPlan(f.view.plans.value[0]); f.view.planForm.title = '更新末页套餐'; await f.view.savePlan();
    expect(f.view.planPage.value).toBe(7); expect(f.view.plans.value[0].title).toBe('更新末页套餐'); expect(f.view.planDialog.value).toBe(false);
    expect(f.writes().map(c => c.url)).toEqual(['/member_ship/save/7121']);
  } finally { f.close(); }
});
it('denies retained actions immediately after persistent permissions change without an event', async () => {
  const f = await mount(); try {
    const row = f.view.plans.value[1]; f.view.openPlan(row); session(9601, ['paid_membership.view'], false);
    await f.view.togglePlan(row, false); await f.view.savePlan(); f.view.openPlan(); expect(f.writes()).toHaveLength(0);
    ownerEvent('focus'); await flush(); expect(f.view.canManagePlans.value).toBe(false); expect(f.view.planDialog.value).toBe(false);
    expect(f.view.plans.value).toHaveLength(20);
  } finally { f.close(); }
});
it('clears denied catalogue state and rejects late reads when live grants are revoked', async () => {
  const f = await mount(), gate = deferred(); try {
    f.hooks.read = async () => { await gate.promise; return { list: [], count: 0 }; };
    const pending = f.view.loadPlans(2); await flush(); session(9601, []); await flush();
    expect(f.view.plans.value).toEqual([]); expect(f.view.planCount.value).toBe(0); expect(f.view.canViewPlans.value).toBe(false);
    gate.resolve(); await pending; expect(f.view.plans.value).toEqual([]); expect(f.writes()).toHaveLength(0);
  } finally { gate.resolve(); f.close(); }
});
it('ignores the old editor completion after another administrator takes ownership', async () => {
  const f = await mount(), gate = deferred(); try {
    f.view.openPlan(f.view.plans.value[1]); f.hooks.write = async () => { await gate.promise; return { id: 7002 }; };
    const pending = f.view.savePlan(); await flush(); session(9603); await flush();
    const reads = f.reads().length; gate.resolve(); await pending;
    expect(f.reads()).toHaveLength(reads); expect(runtime.messages.state.successes).toEqual([]);
    expect(f.view.planDialog.value).toBe(false); expect(f.view.planPage.value).toBe(1);
  } finally { gate.resolve(); f.close(); }
});
it('clears logout state and fences callbacks after unmount', async () => {
  const f = await mount(); const row = f.view.plans.value[1];
  storage.clear(); ownerEvent('admin-auth-expired'); await flush();
  expect(f.view.plans.value).toEqual([]); await f.view.togglePlan(row, false); expect(f.writes()).toHaveLength(0);
  session(); await flush(); f.close(); const reads = f.reads().length;
  await f.view.loadPlans(2); await f.view.togglePlan(row, false); expect(f.reads()).toHaveLength(reads); expect(f.writes()).toHaveLength(0);
});
it('rejects duplicate IDs or inconsistent envelopes and retains imported DTO values', async () => {
  const f = await mount(); try {
    const previous = f.view.plans.value; f.hooks.read = async () => ({ list: [catalogue(1)[0], catalogue(1)[0]], count: 2 });
    expect(await f.view.loadPlans(1)).toBe(false); expect(f.view.plans.value).toBe(previous); expect(f.view.planCount.value).toBe(125);
    expect(f.view.planError.value).toContain('数据格式错误');
    expect(() => runtime.membershipPlanPage({ list: [], count: '125' }, 1)).toThrow('数据格式错误');
    expect(() => runtime.membershipPlanPage({ list: [], count: 125 }, 1)).toThrow('目录已变化');
    const imported = { ...catalogue(1)[0], type: 'legacy-import', price: '-2.359', is_del: 4 };
    expect(runtime.membershipPlanPage({ list: [imported], count: 1 }, 1).list[0]).toEqual(imported);
  } finally { f.close(); }
});
it('bounds a stalled read and leaves a usable retry state', async () => {
  const f = await mount(), gate = deferred(); try {
    f.hooks.read = async () => { await gate.promise; return { list: [], count: 0 }; }; vi.useFakeTimers();
    const pending = f.view.loadPlans(2); await vi.advanceTimersByTimeAsync(12_001); expect(await pending).toBe(false);
    expect(f.reads().at(-1).signal.aborted).toBe(true); expect(f.view.planLoading.value).toBe(false);
    expect(f.view.planError.value).toContain('超时'); expect(f.view.planPage.value).toBe(1); expect(f.view.planCount.value).toBe(125);
  } finally { gate.resolve(); vi.useRealTimers(); f.close(); }
});
