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
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1280, location: { search: '', pathname: '/marketing/recharge-options', href: '' } }));
  const result = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, contents: `
      export { default as Page } from './src/pages/marketing/RechargeOptions.vue';
      export { default as request } from './src/utils/request';
      export * as quota from './src/api/rechargeQuota';
      export { createRenderer, nextTick } from 'vue';
      export { createPinia } from 'pinia';
      export * as messages from 'element-plus';
    ` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'recharge-options-page', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'recharge-options' }).content, loader: 'ts',
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

const grants = ['recharge_quota.view', 'recharge_quota.manage'];
const revision = 'a'.repeat(64);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const row = (id = 1, overrides: Record<string, unknown> = {}) => ({ id, price: '10.00', give_money: '1.00', sort: 1, status: 1,
  valid: true, add_time: '2026-09-26 10:00:00', revision, ...overrides });
const rows = (list: unknown[] = [row()], count = list.length) => ({ list, count, page: 1, limit: 100 });
const envelope = (data: unknown, status = 200, msg = 'ok') => ({ status, msg, data });
function login(permissions = grants, token = 'recharge-quota-token-a', id = 20) {
  localStorage.setItem('admin_token', token);
  localStorage.setItem('admin_session', JSON.stringify({
    userInfo: { id, account: 'operator', level: 1, roles: '' }, menus: [], uniqueAuth: permissions,
  }));
}
beforeEach(() => {
  const values = new Map<string, string>();
  browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { innerWidth: 1280, location: { search: '', pathname: '/marketing/recharge-options', href: '' } }));
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
    const data = custom ?? envelope(config.method !== 'get' ? { id: id || 9 } : id ? row(id) : rows());
    return { config, data, status: 200, statusText: 'recharge fixture', headers: {} };
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

it('normalizes exact decimal strings without rounding and enforces principal and gift boundaries independently', () => {
  const money = runtime.quota.normalizeRechargeMoney;
  expect(money(' 00001.2 ', 'price')).toBe('1.20'); expect(money('0.01', 'price')).toBe('0.01');
  expect(money('100000', 'price')).toBe('100000.00'); expect(money('', 'give_money')).toBe('0.00');
  expect(money('99999999.99', 'give_money')).toBe('99999999.99');
  for (const value of ['', '0', '-1', '+1', '.5', '1.', '1e2', '1.001', '100000.01', '99999999.99', '1,000']) {
    expect(() => money(value, 'price')).toThrow();
  }
  for (const value of ['-0.01', '100000000', '1.005', '1e2']) expect(() => money(value, 'give_money')).toThrow();
});

it('validates full-list responses, exact money, repairable invalid rows and unique IDs', () => {
  expect(runtime.quota.parseRechargeQuotaPage(rows()).count).toBe(1);
  for (const value of [null, { ...rows(), page: 2 }, { ...rows(), limit: 15 }, { ...rows(), count: -1 }, rows([row()], 0)]) {
    expect(() => runtime.quota.parseRechargeQuotaPage(value)).toThrow('列表格式错误');
  }
  expect(() => runtime.quota.parseRechargeQuotaPage(rows([row()], 20))).toThrow('未取得全部充值档位');
  expect(() => runtime.quota.parseRechargeQuotaPage(rows([row(), row()]))).toThrow('记录重复');
  for (const value of [row(0), row(1, { price: 10 }), row(1, { status: 2 }), row(1, { sort: -1 }), row(1, { valid: 1 }), row(1, { revision: '' })]) {
    expect(() => runtime.quota.parseRechargeQuota(value)).toThrow('记录格式错误');
  }
  for (const value of [row(1, { price: '10' }), row(1, { give_money: '0.001' })]) expect(() => runtime.quota.parseRechargeQuota(value)).toThrow('金额格式错误');
  expect(runtime.quota.parseRechargeQuota(row(1, { price: '', give_money: '', valid: false })).valid).toBe(false);
  expect(readFileSync(resolve(root, 'src/router/index.ts'), 'utf8')).toContain('path: "marketing/recharge-options"');
  expect(readFileSync(resolve(root, 'src/layouts/AdminLayout.vue'), 'utf8')).toContain('index="/marketing/recharge-options"');
});

it('fetches all twenty options and previews only saved, enabled, valid rows across the entire list', async () => {
  const list = Array.from({ length: 20 }, (_, index) => row(index + 1, { status: index === 1 ? 0 : 1,
    ...(index === 2 ? { valid: false, price: '', give_money: '' } : {}) }));
  const fixture = await mount(grants, () => envelope(rows(list)));
  try {
    expect(fixture.calls[0].params).toEqual({ page: 1, limit: 100 }); expect(fixture.calls[0].url).toBe('/marketing/recharge-quotas');
    expect(fixture.view.list.value).toHaveLength(20); expect(fixture.view.count.value).toBe(20);
    expect(fixture.view.previewRows.value).toHaveLength(18); expect(fixture.view.previewRows.value.at(-1).id).toBe(20);
    expect(fixture.view.invalidCount.value).toBe(1);
  } finally { fixture.close(); }
});

it('requires independent recharge permissions and prevents read-only users from opening any write flow', async () => {
  const denied = await mount(['activity.view', 'integral_category.manage']);
  try { await denied.view.load(); await denied.view.openForm(0); expect(denied.calls).toEqual([]); } finally { denied.close(); }
  const viewer = await mount(['recharge_quota.view']);
  try {
    expect(viewer.view.canView.value).toBe(true); expect(viewer.view.canManage.value).toBe(false);
    await viewer.view.openForm(0); await viewer.view.openForm(1); await viewer.view.save();
    await viewer.view.remove(viewer.view.list.value[0]); await viewer.view.toggleVisibility(viewer.view.list.value[0]);
    expect(viewer.view.formVisible.value).toBe(false); expect(writes(viewer.calls)).toEqual([]);
    expect(runtime.messages.state.confirmations).toEqual([]);
  } finally { viewer.close(); }
});

it('creates from the four legacy fields and defaults with string money, including gifts larger than principal', async () => {
  const fixture = await mount();
  try {
    const before = fixture.calls.length; await fixture.view.openForm(0); expect(fixture.calls).toHaveLength(before);
    expect(fixture.view.form.value).toEqual({ price: '', give_money: '0.00', sort: 1, status: 1, revision: '' });
    await fixture.view.save(); expect(fixture.view.formError.value).toContain('充值金额');
    fixture.view.form.value.price = '0.01'; fixture.view.form.value.sort = -1;
    await fixture.view.save(); expect(fixture.view.formError.value).toContain('排序');
    fixture.view.form.value.sort = 1; fixture.view.form.value.give_money = '99999999.99'; await fixture.view.save();
    const saved = writes(fixture.calls)[0]; expect(saved).toMatchObject({ method: 'post', url: '/marketing/recharge-quotas' });
    expect(JSON.parse(saved.data)).toEqual({ price: '0.01', give_money: '99999999.99', sort: 1, status: 1, request_id: expect.stringMatching(uuid) });
    expect(fixture.view.formVisible.value).toBe(false); expect(fixture.calls.at(-1).method).toBe('get');
  } finally { fixture.close(); }
});

it('loads a fresh revision for editing and sends only four editable fields plus request identity', async () => {
  const fixture = await mount(grants, config => config.method === 'get' && config.url.endsWith('/1')
    ? envelope(row(1, { price: '88.80', give_money: '5.00', sort: 6, status: 0, revision: 'b'.repeat(64) })) : undefined);
  try {
    await fixture.view.openForm(1); expect(fixture.calls.at(-1).url).toBe('/marketing/recharge-quotas/1');
    expect(fixture.view.form.value.price).toBe('88.80'); fixture.view.form.value.price = ' 100000 '; fixture.view.form.value.give_money = '';
    await fixture.view.save(); const saved = writes(fixture.calls)[0]; expect(saved.method).toBe('put');
    expect(JSON.parse(saved.data)).toEqual({ price: '100000.00', give_money: '0.00', sort: 6, status: 0, revision: 'b'.repeat(64), request_id: expect.stringMatching(uuid) });
  } finally { fixture.close(); }
});

it('blocks creation at and beyond twenty while allowing historical options to be edited, hidden and deleted', async () => {
  for (const length of [20, 21]) {
    const list = Array.from({ length }, (_, index) => row(index + 1));
    const fixture = await mount(grants, config => config.params ? envelope(rows(list)) : undefined);
    try {
      await fixture.view.openForm(0); expect(fixture.view.formVisible.value).toBe(false);
      await fixture.view.openForm(1); expect(fixture.view.form.value.price).toBe('10.00'); await fixture.view.save();
      await fixture.view.toggleVisibility(fixture.view.list.value[0]); await fixture.view.remove(fixture.view.list.value[0]);
      expect(writes(fixture.calls).map(call => call.method)).toEqual(['put', 'put', 'delete']);
      expect(runtime.messages.state.confirmations.at(-1)[0]).toContain('既有充值订单仍按原金额和赠送快照结算');
      expect(JSON.parse(writes(fixture.calls).at(-1).data)).toEqual({ revision, request_id: expect.stringMatching(uuid) });
    } finally { fixture.close(); }
  }
});

it('keeps broken historical money repairable, excludes it from preview and requires repair before enabling', async () => {
  let status = 0, repaired = false;
  const fixture = await mount(grants, config => {
    if (config.method === 'put') { const body = JSON.parse(config.data); status = body.status; repaired ||= !!body.price; return envelope({ id: 1 }); }
    if (config.method === 'get') {
      const value = row(1, { price: repaired ? '50.00' : '', give_money: repaired ? '0.00' : '', status, valid: repaired });
      return envelope(config.params ? rows([value]) : value);
    }
    return undefined;
  });
  try {
    expect(fixture.view.previewRows.value).toEqual([]); await fixture.view.toggleVisibility(fixture.view.list.value[0]);
    expect(writes(fixture.calls)).toEqual([]); expect(fixture.view.actionNotice.value).toContain('先编辑修复');
    status = 1; await fixture.view.load(); await fixture.view.toggleVisibility(fixture.view.list.value[0]);
    expect(JSON.parse(writes(fixture.calls)[0].data).status).toBe(0);
    await fixture.view.openForm(1); expect(fixture.view.form.value).toMatchObject({ price: '', give_money: '0.00' });
    fixture.view.form.value.price = '50'; fixture.view.form.value.status = 1; await fixture.view.save();
    expect(fixture.view.previewRows.value[0].price).toBe('50.00'); expect(fixture.view.invalidCount.value).toBe(0);
  } finally { fixture.close(); }
});

it('confirms visibility without optimistic mutation and cancellation leaves the saved preview intact', async () => {
  const confirmation = deferred(); runtime.messages.state.confirm = () => confirmation.promise;
  let hidden = false;
  const fixture = await mount(grants, config => {
    if (config.method === 'put') { hidden = true; return envelope({ id: 1 }); }
    if (config.params) return envelope(rows([row(1, { status: hidden ? 0 : 1 })]));
    return undefined;
  });
  try {
    const toggle = fixture.view.toggleVisibility(fixture.view.list.value[0]);
    expect(fixture.view.previewRows.value).toHaveLength(1); expect(writes(fixture.calls)).toEqual([]);
    confirmation.resolve(); await toggle;
    expect(writes(fixture.calls)[0].url).toBe('/marketing/recharge-quotas/1/status');
    expect(JSON.parse(writes(fixture.calls)[0].data)).toEqual({ status: 0, revision, request_id: expect.stringMatching(uuid) });
    expect(fixture.view.previewRows.value).toEqual([]);
    runtime.messages.state.confirm = () => Promise.reject('cancel');
    await fixture.view.toggleVisibility(fixture.view.list.value[0]); expect(writes(fixture.calls)).toHaveLength(1);
    expect(fixture.view.list.value[0].status).toBe(0);
  } finally { fixture.close(); }
});

it.each(['network', 'malformed', 'conflict'])('only rereads after a %s write result and keeps ambiguous request identity and payload', async failure => {
  const fixture = await mount(grants, config => {
    if (config.method !== 'get') {
      if (failure === 'network') throw new Error('连接中断');
      if (failure === 'malformed') return envelope({});
      return envelope(null, 400, '充值档位已更改，请重新读取');
    }
    return undefined;
  });
  try {
    await fixture.view.openForm(0); fixture.view.form.value.price = '99'; await fixture.view.save();
    expect(writes(fixture.calls)).toHaveLength(1); expect(fixture.calls.at(-1).method).toBe('get');
    expect(fixture.view.formVisible.value).toBe(false); expect(runtime.messages.state.successes).toEqual([]);
    expect(fixture.view.actionNotice.value).toContain(failure === 'conflict' ? '操作未完成' : '操作结果未确认');
    if (failure === 'conflict') expect(fixture.view.uncertainOperation.value).toBeNull();
    else expect(fixture.view.uncertainOperation.value.body).toEqual(JSON.parse(writes(fixture.calls)[0].data));
    await fixture.view.load(); expect(writes(fixture.calls)).toHaveLength(1);
  } finally { fixture.close(); }
});

it('surfaces incomplete and failed reads, clears stale previews and prevents creation until full recovery', async () => {
  let mode = 'ok';
  const fixture = await mount(grants, config => {
    if (!config.params) return undefined;
    if (mode === 'incomplete') return envelope(rows([row()], 20));
    if (mode === 'failure') throw new Error('目录不可用');
    return undefined;
  });
  try {
    mode = 'incomplete'; await fixture.view.load(); expect(fixture.view.listError.value).toContain('未取得全部充值档位');
    expect(fixture.view.previewRows.value).toEqual([]); expect(fixture.view.loaded.value).toBe(false);
    await fixture.view.openForm(0); expect(fixture.view.formVisible.value).toBe(false);
    mode = 'failure'; await fixture.view.load(); expect(fixture.view.listError.value).toBe('目录不可用');
    mode = 'ok'; await fixture.view.load(); expect(fixture.view.listError.value).toBe(''); expect(fixture.view.previewRows.value).toHaveLength(1);
  } finally { fixture.close(); }
});

it('rejects mismatched details, supports retry and discards older list or editor responses', async () => {
  const oldList = deferred(), oldDetail = deferred(); let holdList = false, detailMode = 'wrong';
  const fixture = await mount(grants, config => {
    if (config.params && holdList) return oldList.promise;
    if (config.method === 'get' && config.url.endsWith('/1')) return detailMode === 'late' ? oldDetail.promise : envelope(row(detailMode === 'wrong' ? 2 : 1));
    return undefined;
  });
  try {
    await fixture.view.openForm(1); expect(fixture.view.form.value).toBeNull(); expect(fixture.view.formError.value).toContain('详情与当前记录不一致');
    await fixture.view.save(); expect(writes(fixture.calls)).toEqual([]);
    detailMode = 'ok'; await fixture.view.openForm(1); expect(fixture.view.form.value.price).toBe('10.00');
    holdList = true; const loading = fixture.view.load(); expect(fixture.view.previewRows.value).toEqual([]); await flush();
    holdList = false; await fixture.view.load(); oldList.resolve(envelope(rows([row(99)]))); await loading;
    expect(fixture.view.list.value[0].id).toBe(1);
    detailMode = 'late'; const editing = fixture.view.openForm(1); await flush();
    await fixture.view.openForm(0); oldDetail.resolve(envelope(row(1))); await editing;
    expect(fixture.view.formId.value).toBe(0); expect(fixture.view.form.value.price).toBe('');
  } finally { fixture.close(); }
});

it('invalidates pending confirmations on refresh and A-B-A account changes', async () => {
  const confirmation = deferred(); runtime.messages.state.confirm = () => confirmation.promise;
  const fixture = await mount();
  try {
    const remove = fixture.view.remove(fixture.view.list.value[0]); await fixture.view.load();
    confirmation.resolve(); await remove; expect(writes(fixture.calls)).toEqual([]);
    const second = deferred(); runtime.messages.state.confirm = () => second.promise;
    const toggle = fixture.view.toggleVisibility(fixture.view.list.value[0]);
    login(grants, 'recharge-quota-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed'));
    login(); browser.dispatchEvent(new Event('admin-session-changed')); await flush();
    second.resolve(); await toggle;
    expect(writes(fixture.calls)).toEqual([]); expect(runtime.messages.state.closed).toBeGreaterThan(0);
  } finally { fixture.close(); }
});

it('isolates delayed writes from replacement sessions and clears stale data when permissions are revoked in another tab', async () => {
  const late = deferred();
  const fixture = await mount(grants, config => config.method === 'post' ? late.promise : undefined);
  try {
    await fixture.view.openForm(0); fixture.view.form.value.price = '88'; const save = fixture.view.save(); await flush();
    const request = writes(fixture.calls)[0];
    login(grants, 'recharge-quota-token-b', 21); browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'admin_session' }));
    await flush(); await fixture.view.openForm(0); fixture.view.form.value.price = '99';
    late.resolve(envelope({ id: 99 })); await save;
    expect(request.signal.aborted).toBe(true); expect(fixture.view.formVisible.value).toBe(true);
    expect(fixture.view.form.value.price).toBe('99'); expect(runtime.messages.state.successes).toEqual([]);
    login([], 'recharge-quota-token-c', 22); browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'admin_token' }));
    expect(fixture.view.list.value).toEqual([]); expect(fixture.view.formVisible.value).toBe(false);
    const count = fixture.calls.length; await fixture.view.load(); expect(fixture.calls).toHaveLength(count);
  } finally { fixture.close(); }
});

it('cancels pending details and confirmations on unmount', async () => {
  const late = deferred(), confirmation = deferred();
  const fixture = await mount(grants, config => config.method === 'get' && config.url.endsWith('/1') ? late.promise : undefined);
  const detail = fixture.view.openForm(1); await flush(); fixture.view.formVisible.value = false; fixture.view.onFormClosed();
  runtime.messages.state.confirm = () => confirmation.promise;
  const remove = fixture.view.remove(fixture.view.list.value[0]); fixture.close();
  late.resolve(envelope(row(1))); confirmation.resolve(); await detail; await remove;
  expect(fixture.view.form.value).toBeNull(); expect(fixture.view.list.value).toEqual([]); expect(writes(fixture.calls)).toEqual([]);
});
