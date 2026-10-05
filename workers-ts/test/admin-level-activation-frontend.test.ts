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
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/config/level-activation', href: '' } }));
  const result = await build({ absWorkingDir: root,
    stdin: { resolveDir: root, contents: `
      export { default as Page } from './src/pages/config/LevelActivationSettings.vue';
      export { default as request } from './src/utils/request';
      export * as api from './src/api/levelActivation';
      export { createRenderer, nextTick } from 'vue'; export { createPinia } from 'pinia';
      export * as messages from 'element-plus';
    ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'level-activation-runtime', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'level-activation' }).content, loader: 'ts' }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'messages', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const state = { successes: [], confirmations: [], closed: 0, confirm: () => Promise.resolve() };
        export const ElMessage = { success: value => state.successes.push(value) };
        export const ElMessageBox = { confirm(...args) { state.confirmations.push(args); return state.confirm(...args); }, close() { state.closed++; } };
      ` }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
const grants = ['config.view', 'config.manage'];
const revision = 'a'.repeat(64), profileKey = 'b'.repeat(64), customKey = 'c'.repeat(64);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function coupon(id = 1, overrides: Record<string, unknown> = {}) {
  return { id, title: `发行券 ${id}`, revision, selectable: true, issues: [], discount_type: 1, coupon_price: '3.00', use_min_price: '10.00',
    effective_pay_percent: null, scope_type: 0, category: 0, app_type: 0, status: 1, deleted: false, is_permanent: 0, remain_count: 8,
    receive_type: 3, valid_days: 7, start_time: null, end_time: null, use_start_time: null, use_end_time: null, ...overrides };
}
function profile(field_key = profileKey, overrides: Record<string, unknown> = {}) {
  return { field_key, source: 'default', selectable: true, issues: [], raw: null,
    definition: { info: '姓名', tip: '请填写真实姓名', format: 'text', label: '文本', param: 'real_name', single: '', singlearr: [], use: 1, user_show: 1, sort: 0 }, ...overrides };
}
function settings(overrides: Record<string, unknown> = {}) {
  return { member_func_status: 1, level_activate_status: 1, level_extend_info: [{ field_key: profileKey, required: 1 }],
    level_integral_status: 1, level_give_integral: 7, level_money_status: 1, level_give_money: '15', level_coupon_status: 1, level_give_coupon: [1], ...overrides };
}
function config(overrides: Record<string, unknown> = {}) {
  const values = settings();
  return { settings: values, revision, missing_keys: [], issues: [], raw_values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)])),
    effective: { member_enabled: true, activation_required: true, integral_enabled: true, integral: 7, money_enabled: true, money_units: '15', coupon_enabled: true, coupon_ids: [1], gift_active: true },
    profile_options: [profile()], selected_coupons: [coupon()], limits: { fields: 64, coupons: 100, config_value_characters: 5000, template_characters: 180, integral_max: 2147483647, money_max: '9999999999' }, ...overrides };
}
const envelope = (data: unknown, status = 200, msg = 'ok') => ({ status, msg, data });
function login(permissions = grants, token = 'level-token-a', id = 20) {
  localStorage.setItem('admin_token', token);
  localStorage.setItem('admin_session', JSON.stringify({ userInfo: { id, account: 'operator', level: 1, roles: '' }, menus: [], uniqueAuth: permissions }));
}
beforeEach(() => {
  const values = new Map<string, string>(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { pathname: '/config/level-activation', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.messages.state.successes = []; runtime.messages.state.confirmations = []; runtime.messages.state.closed = 0; runtime.messages.state.confirm = () => Promise.resolve();
});
afterEach(() => vi.unstubAllGlobals());
const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred() { let resolve!: (value?: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function mount(permissions = grants, respond: (request: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (request: any) => {
    calls.push(request); const custom = await respond(request), body = request.method === 'post' ? JSON.parse(request.data) : null;
    const data = custom ?? envelope(body ? { committed: true, revision: 'd'.repeat(64), request_id: body.request_id, cache_status: 'cleared' }
      : request.url.endsWith('/coupons') ? { list: [coupon()], count: 1, page: request.params.page, limit: request.params.limit } : config());
    return { config: request, data, status: 200, statusText: 'isolated level fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); }, remove() {}, parentNode: (node: any) => node.parent,
    nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush(); return { view, calls, close: () => app.unmount() };
}
const writes = (calls: any[]) => calls.filter(call => call.method !== 'get');

it('loads all nine settings and the saved coupon/profile identities without issuing writes or relying on a menu grant', async () => {
  const f = await mount(); try {
    expect(f.calls.map(call => call.url)).toEqual(['/config/level-activation']); expect(f.view.form.value).toEqual(settings());
    expect(f.view.selectedProfiles.value[0].option.definition.info).toBe('姓名'); expect(f.view.selectedCoupons.value[0].id).toBe(1);
    expect(writes(f.calls)).toEqual([]); expect(readFileSync(resolve(root, 'src/router/index.ts'), 'utf8')).toContain('path: "config/level-activation"');
  } finally { f.close(); }
});

it.each([{ permissions: ['coupon.view'] }, { permissions: ['level.manage'] }, { permissions: [] }])('does not read or mutate with unrelated grants $permissions', async ({ permissions }) => {
  const f = await mount(permissions); try { await f.view.load(); await f.view.save(); await f.view.openCoupons(); f.view.openProfiles(); expect(f.calls).toEqual([]); expect(f.view.canView.value).toBe(false); } finally { f.close(); }
});

it('gives config.view a complete read-only page while config.manage includes same-domain view', async () => {
  const f = await mount(['config.view']); try {
    expect(f.view.form.value.level_give_integral).toBe(7); expect(f.view.form.value.level_give_money).toBe('15'); expect(f.view.canManage.value).toBe(false);
    await f.view.save(); await f.view.openCoupons(); f.view.openProfiles(); f.view.removeProfile(profileKey); f.view.removeCoupon(1); f.view.repair('level_give_money');
    expect(writes(f.calls)).toEqual([]); expect(f.view.form.value).toEqual(settings()); expect(runtime.messages.state.confirmations).toEqual([]);
  } finally { f.close(); }
  const manager = await mount(['config.manage']); try { expect(manager.view.canView.value).toBe(true); expect(manager.view.editable.value).toBe(true); } finally { manager.close(); }
});

it('submits exactly nine keys and revision/UUID/reference proofs after a full confirmation, then reads authoritative state', async () => {
  const f = await mount(); try {
    f.view.form.value.level_give_integral = 2147483647; f.view.form.value.level_give_money = '9999999999'; f.view.form.value.member_func_status = 0;
    await f.view.save(); const post = writes(f.calls)[0], body = JSON.parse(post.data);
    expect(post.url).toBe('/config/level-activation'); expect(body).toEqual({ ...settings({ member_func_status: 0, level_give_integral: 2147483647, level_give_money: '9999999999' }), revision, request_id: expect.stringMatching(uuid), coupon_revisions: [{ id: 1, revision }] });
    expect(runtime.messages.state.confirmations[0][0]).toContain('会员等级：关闭'); expect(runtime.messages.state.confirmations[0][0]).toContain('9999999999 整元');
    expect(runtime.messages.state.confirmations[0][0]).toContain('姓名（必填）'); expect(f.calls.at(-1).method).toBe('get'); expect(runtime.messages.state.successes).toHaveLength(1);
  } finally { f.close(); }
});

it.each(['15.99', '1e2', '-1', '+1', '10000000000', '', '01'])('rejects non-canonical whole-yuan draft %s before confirmation or HTTP', async money => {
  const f = await mount(); try { f.view.form.value.level_give_money = money; await f.view.save(); expect(f.view.formError.value).toContain('整数元'); expect(writes(f.calls)).toEqual([]); expect(runtime.messages.state.confirmations).toEqual([]); } finally { f.close(); }
});

it('keeps malformed historical values unresolved until an explicit repair, and never fills them merely by reading', async () => {
  const data = config({ settings: settings({ level_give_integral: null, level_give_money: null, level_extend_info: null, level_give_coupon: null }),
    raw_values: { ...config().raw_values, level_give_integral: '"7"', level_give_money: '15.99', level_extend_info: '{broken', level_give_coupon: '[broken' },
    issues: [{ key: 'level_give_integral', message: 'quoted值当前实际为0' }], effective: { ...config().effective, integral: 0 }, selected_coupons: [] });
  const f = await mount(grants, call => call.method === 'get' ? envelope(data) : undefined); try {
    expect(f.view.form.value.level_give_money).toBeNull(); await f.view.save(); expect(writes(f.calls)).toEqual([]); expect(f.view.formError.value).toContain('修复');
    for (const key of ['level_give_integral', 'level_give_money', 'level_extend_info', 'level_give_coupon']) f.view.repair(key);
    expect(f.view.form.value).toMatchObject({ level_give_integral: 0, level_give_money: '15', level_extend_info: [], level_give_coupon: [] });
    await f.view.save(); expect(writes(f.calls)).toHaveLength(1); expect(JSON.parse(writes(f.calls)[0].data).level_give_money).toBe('15');
  } finally { f.close(); }
});

it('preserves missing-key diagnostics without materializing defaults on GET', async () => {
  const f = await mount(grants, () => envelope(config({ settings: settings({ member_func_status: 0 }), missing_keys: ['member_func_status'], raw_values: { ...config().raw_values, member_func_status: null } }))); try {
    expect(f.view.config.value.missing_keys).toEqual(['member_func_status']); expect(f.view.form.value.member_func_status).toBe(0); expect(writes(f.calls)).toEqual([]);
  } finally { f.close(); }
});

it('chooses complete custom radio/date definitions by server key, cancels atomically, and sends only required references', async () => {
  const radio = profile(customKey, { source: 'base', definition: { ...profile().definition, info: '偏好', param: '', format: 'radio', label: '单选', singlearr: ['邮件', '短信'] } });
  const date = profile('d'.repeat(64), { source: 'base', definition: { ...profile().definition, info: '纪念日', param: '', format: 'date', label: '日期' } });
  const f = await mount(grants, call => call.method === 'get' ? envelope(config({ profile_options: [profile(), radio, date] })) : undefined); try {
    f.view.openProfiles(); f.view.profileKeyword.value = '偏好'; expect(f.view.filteredProfiles.value).toHaveLength(1); f.view.selectProfile(radio, true); f.view.closeProfiles(); expect(f.view.form.value.level_extend_info).toHaveLength(1);
    f.view.openProfiles(); f.view.selectProfile(radio, true); f.view.selectProfile(date, true); f.view.confirmProfiles(); f.view.setRequired(customKey, true); f.view.removeProfile(profileKey); await f.view.save();
    const fields = JSON.parse(writes(f.calls)[0].data).level_extend_info;
    expect(fields).toEqual([{ field_key: customKey, required: 1 }, { field_key: 'd'.repeat(64), required: 0 }]); expect(fields.every((row: any) => Object.keys(row).length === 2)).toBe(true);
  } finally { f.close(); }
});

it('shows invalid selected profile definitions and requires explicit removal before saving other fields', async () => {
  const f = await mount(grants, call => call.method === 'get' ? envelope(config({ profile_options: [profile(profileKey, { definition: null, selectable: false, issues: ['映射字段不合法'], raw: { param: 'now_money' } })] })) : undefined); try {
    expect(f.view.selectedProfiles.value[0].option.issues).toEqual(['映射字段不合法']); await f.view.save(); expect(writes(f.calls)).toEqual([]); expect(f.view.formError.value).toContain('移除');
    f.view.removeProfile(profileKey); await f.view.save(); expect(JSON.parse(writes(f.calls)[0].data).level_extend_info).toEqual([]);
  } finally { f.close(); }
});

it('keeps cross-page coupon selections and invalid saved IDs, with cancel preserving the original draft', async () => {
  const invalid = coupon(99, { title: '', revision: null, selectable: false, deleted: true, issues: ['发行不存在'] });
  const f = await mount(grants, call => call.url.endsWith('/coupons') ? envelope({ list: [coupon(call.params.page === 1 ? 2 : 11)], count: 11, page: call.params.page, limit: 10 })
    : call.method === 'get' ? envelope(config({ settings: settings({ level_give_coupon: [1, 99] }), selected_coupons: [coupon(), invalid] })) : undefined); try {
    await f.view.openCoupons(); f.view.selectCoupon(f.view.couponRows.value[0], true); await f.view.loadCoupons(2); f.view.selectCoupon(f.view.couponRows.value[0], true);
    expect([...f.view.couponChoices.value.keys()]).toEqual([1, 99, 2, 11]); f.view.closeCoupons(); expect(f.view.form.value.level_give_coupon).toEqual([1, 99]);
    await f.view.openCoupons(); f.view.selectCoupon(f.view.couponRows.value[0], true); await f.view.loadCoupons(2); f.view.selectCoupon(f.view.couponRows.value[0], true); f.view.confirmCoupons();
    expect(f.view.form.value.level_give_coupon).toEqual([1, 99, 2, 11]); f.view.form.value.member_func_status = 0; await f.view.save();
    expect(JSON.parse(writes(f.calls)[0].data).coupon_revisions).toEqual([{ id: 1, revision }, { id: 99, revision: null }, { id: 2, revision }, { id: 11, revision }]);
  } finally { f.close(); }
});

it('clears stale coupon rows while changing pages and ignores a late old-page response', async () => {
  const delayed = deferred(); let hold = false;
  const f = await mount(grants, call => call.url.endsWith('/coupons') ? hold && call.params.page === 2 ? delayed.promise
    : envelope({ list: [coupon(call.params.page === 3 ? 21 : 1)], count: 31, page: call.params.page, limit: 10 }) : undefined); try {
    await f.view.openCoupons(); hold = true; const old = f.view.loadCoupons(2); await flush(); expect(f.view.couponRows.value).toEqual([]); expect(f.view.couponReady.value).toBe(false);
    await f.view.loadCoupons(3); delayed.resolve(envelope({ list: [coupon(11)], count: 31, page: 2, limit: 10 })); await old;
    expect(f.view.couponPage.value).toBe(3); expect(f.view.couponRows.value.map((row: any) => row.id)).toEqual([21]);
  } finally { f.close(); }
});

it('distinguishes coupon read failure from empty results, retries the same page and trims literal search text', async () => {
  let fail = false;
  const f = await mount(grants, call => { if (call.url.endsWith('/coupons') && fail) throw Error('候选读取中断'); return undefined; }); try {
    await f.view.openCoupons(); fail = true; await f.view.loadCoupons(2); expect(f.view.couponRows.value).toEqual([]); expect(f.view.couponReady.value).toBe(false); expect(f.view.couponError.value).toContain('中断');
    fail = false; await f.view.loadCoupons(f.view.couponPage.value); expect(f.view.couponPage.value).toBe(2); f.view.couponKeyword.value = '  50%_\\  '; f.view.searchCoupons(); await flush();
    expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 10, keyword: '50%_\\' });
  } finally { f.close(); }
});

it('clears previously saved form on read errors and recovers only from a validated response', async () => {
  let fail = false; const f = await mount(grants, () => { if (fail) throw Error('读取失败'); }); try {
    fail = true; await f.view.load(); expect(f.view.form.value).toBeNull(); expect(f.view.ready.value).toBe(false); expect(f.view.loadError.value).toContain('读取失败');
    fail = false; await f.view.load(); expect(f.view.form.value).toEqual(settings()); expect(f.view.loadError.value).toBe('');
  } finally { f.close(); }
});

it('does not silently accept missing selected detail or invalid limits, and preserves non-finite legacy diagnostics', () => {
  for (const data of [config({ selected_coupons: [] }), config({ profile_options: [] }), config({ limits: { ...config().limits, coupons: 0 } }), config({ settings: settings({ level_give_integral: '7' }) })]) expect(() => runtime.api.parseLevelActivation(data)).toThrow();
  expect(runtime.api.parseLevelActivation(config({ settings: settings({ level_give_integral: null }), effective: { ...config().effective, integral: null } })).effective.integral).toBeNull();
  expect(runtime.api.parseLevelActivation(config({ settings: settings({ level_give_coupon: null }), effective: { ...config().effective, coupon_ids: [2147483648] }, selected_coupons: [] })).effective.coupon_ids).toEqual([2147483648]);
});

it('surfaces mismatched coupon page envelopes and over-limit offsets without leaving stale rows or emitting invalid requests', async () => {
  let wrongPage = false;
  const f = await mount(grants, call => call.url.endsWith('/coupons') && wrongPage ? envelope({ list: [coupon(11)], count: 20, page: call.params.page + 1, limit: 10 }) : undefined);
  try {
    await f.view.openCoupons(); wrongPage = true; await f.view.loadCoupons(2);
    expect(f.view.couponRows.value).toEqual([]); expect(f.view.couponError.value).toContain('与请求不一致'); expect(f.view.couponReady.value).toBe(false);
    const requests = f.calls.length; await f.view.loadCoupons(1002);
    expect(f.calls).toHaveLength(requests); expect(f.view.couponError.value).toContain('分页范围无效'); expect(f.view.couponRows.value).toEqual([]);
  } finally { f.close(); }
});

it('renders fractional historical discounts using the explicit consumer percentage, not a money subtraction', async () => {
  const f = await mount(); try { const text = f.view.faceLabel(coupon(2, { discount_type: 2, coupon_price: '85.99', effective_pay_percent: 85 })); expect(text).toContain('8.5 折'); expect(text).toContain('按 85% 结算'); expect(text).toContain('85.99%'); } finally { f.close(); }
});

it('cancels confirmation without writing, and freezes controls throughout an unresolved confirmation', async () => {
  const decision = deferred(); const f = await mount(); try {
    runtime.messages.state.confirm = () => decision.promise; const saving = f.view.save(); await flush(); expect(f.view.editable.value).toBe(false); await f.view.save(); expect(runtime.messages.state.confirmations).toHaveLength(1);
    // A draft change outside the disabled UI must still invalidate the prepared body.
    f.view.form.value.level_give_integral = 9; decision.resolve(); await saving; expect(writes(f.calls)).toEqual([]);
    runtime.messages.state.confirm = () => Promise.reject(Error('cancel')); await f.view.save(); expect(writes(f.calls)).toEqual([]);
  } finally { f.close(); }
});

it.each(['network', 'malformed-receipt'])('preserves the exact uncertain POST and only GETs on %s, with zero-write acknowledgement', async mode => {
  const f = await mount(grants, call => { if (call.method === 'post') { if (mode === 'network') throw Error('response interrupted after commit'); return envelope({ committed: true, revision, request_id: 'wrong', cache_status: 'cleared' }); } }); try {
    await f.view.save(); const post = writes(f.calls)[0]; expect(f.view.uncertainOperation.value.body).toEqual(JSON.parse(post.data)); expect(f.view.notice.value).toContain('未确认'); expect(f.calls.at(-1).method).toBe('get');
    await f.view.save(); await f.view.load(); expect(writes(f.calls)).toHaveLength(1); const before = f.calls.length; await f.view.acknowledge(); expect(f.calls).toHaveLength(before); expect(f.view.uncertainOperation.value).toBeNull();
    expect(runtime.messages.state.confirmations.at(-1)[0]).toContain('不证明服务器成功或失败'); expect(runtime.messages.state.successes).toEqual([]);
  } finally { f.close(); }
});

it('recognizes committed cache-pending receipts and never treats them as rollback or resends the POST', async () => {
  const f = await mount(grants, call => call.method === 'post' ? envelope({ committed: true, revision: 'd'.repeat(64), request_id: JSON.parse(call.data).request_id, cache_status: 'pending' }) : undefined); try {
    await f.view.save(); expect(f.view.uncertainOperation.value).toBeNull(); expect(f.view.notice.value).toContain('数据库与审计已提交'); expect(runtime.messages.state.successes[0]).toContain('已保存'); expect(writes(f.calls)).toHaveLength(1);
  } finally { f.close(); }
});

it('handles a known revision conflict with GET and a fresh human decision, without automatic POST retry', async () => {
  const f = await mount(grants, call => call.method === 'post' ? envelope(null, 400, '配置已变化，请重新读取') : undefined); try {
    await f.view.save(); expect(f.view.uncertainOperation.value).toBeNull(); expect(f.view.notice.value).toContain('保存未完成'); expect(writes(f.calls)).toHaveLength(1); expect(f.calls.at(-1).method).toBe('get');
  } finally { f.close(); }
});

it.each(['account', 'permission', 'aba'])('invalidates a pending save confirmation on %s session change', async change => {
  const decision = deferred(); const f = await mount(); try {
    runtime.messages.state.confirm = () => decision.promise; const saving = f.view.save(); await flush();
    login(change === 'permission' ? ['config.view'] : grants, 'level-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed'));
    if (change === 'aba') { login(); browser.dispatchEvent(new Event('admin-session-changed')); }
    await flush(); decision.resolve(); await saving; expect(writes(f.calls)).toEqual([]); expect(runtime.messages.state.closed).toBeGreaterThan(0);
  } finally { f.close(); }
});

it('discards a prior account POST completion without overwriting, toasting or closing the replacement draft', async () => {
  const delayed = deferred(); const f = await mount(grants, call => call.method === 'post' ? delayed.promise : undefined); try {
    const saving = f.view.save(); await flush(); const oldBody = JSON.parse(writes(f.calls)[0].data);
    login(grants, 'level-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); f.view.form.value.level_give_money = '99';
    delayed.resolve(envelope({ committed: true, revision, request_id: oldBody.request_id, cache_status: 'cleared' })); await saving;
    expect(f.view.form.value.level_give_money).toBe('99'); expect(runtime.messages.state.successes).toEqual([]); expect(f.view.uncertainOperation.value).toBeNull();
  } finally { f.close(); }
});

it('reacts to cross-tab raw-session replacement and removes prior data immediately', async () => {
  const delayed = deferred(); let hold = false; const f = await mount(grants, () => hold ? delayed.promise : undefined); try {
    hold = true; login(['coupon.view'], 'level-token-b', 21); const event = new Event('storage'); Object.defineProperty(event, 'key', { value: 'admin_session' }); browser.dispatchEvent(event);
    expect(f.view.form.value).toBeNull(); expect(f.view.canView.value).toBe(false); expect(f.view.uncertainOperation.value).toBeNull(); delayed.resolve(envelope(config())); await flush(); expect(f.view.form.value).toBeNull();
  } finally { f.close(); }
});

it('rejects a late read after unmount and leaves no active session listener', async () => {
  const delayed = deferred(); let hold = false; const f = await mount(grants, () => hold ? delayed.promise : undefined);
  hold = true; const pending = f.view.load(); await flush(); f.close(); delayed.resolve(envelope(config())); await pending;
  const count = f.calls.length; browser.dispatchEvent(new Event('admin-session-changed')); await flush(); expect(f.calls).toHaveLength(count); expect(f.view.form.value).toBeNull();
});
