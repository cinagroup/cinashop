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
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/config/paid-membership', href: '' } }));
  const result = await build({ absWorkingDir: root,
    stdin: { resolveDir: root, contents: `
      export { default as Page } from './src/pages/config/PaidMembershipSettings.vue';
      export { default as request } from './src/utils/request';
      export * as api from './src/api/paidMembershipConfig';
      export { createRenderer, nextTick } from 'vue'; export { createPinia } from 'pinia';
      export * as messages from 'element-plus';
    ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' }, bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'paid-membership-config-runtime', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'paid-membership-config' }).content, loader: 'ts' }));
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
const revision = 'a'.repeat(64);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function config(overrides: Record<string, unknown> = {}) {
  return { settings: { member_card_status: 1, svip_price_status: 1 }, revision, missing_keys: [], issues: [], raw_values: { member_card_status: '1', svip_price_status: '1' }, ...overrides };
}
const envelope = (data: unknown, status = 200, msg = 'ok') => ({ status, msg, data });
function login(permissions = grants, token = 'paid-token-a', id = 20) {
  localStorage.setItem('admin_token', token);
  localStorage.setItem('admin_session', JSON.stringify({ userInfo: { id, account: 'operator', level: 1, roles: '' }, menus: [], uniqueAuth: permissions }));
}
beforeEach(() => {
  const values = new Map<string, string>(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { pathname: '/config/paid-membership', href: '' } }));
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
    const data = custom ?? envelope(body ? { committed: true, revision: 'd'.repeat(64), request_id: body.request_id, cache_status: 'cleared' } : config());
    return { config: request, data, status: 200, statusText: 'isolated paid membership config fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); }, remove() {}, parentNode: (node: any) => node.parent,
    nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush(); return { view, calls, close: () => app.unmount() };
}
const writes = (calls: any[]) => calls.filter(call => call.method !== 'get');

it('reads the two keys without writes or a menu grant and registers a dedicated configuration entry', async () => {
  const f = await mount(); try {
    expect(f.calls.map(call => call.url)).toEqual(['/config/paid-membership']); expect(f.calls[0].params).toBeUndefined();
    expect(f.view.form.value).toEqual(config().settings); expect(f.view.config.value.raw_values).toEqual(config().raw_values); expect(writes(f.calls)).toEqual([]);
    expect(readFileSync(resolve(root, 'src/router/index.ts'), 'utf8')).toContain('path: "config/paid-membership"');
    expect(readFileSync(resolve(root, 'src/layouts/AdminLayout.vue'), 'utf8')).toContain('v-if="canMenu(\'/config\')" index="/config/paid-membership"');
  } finally { f.close(); }
});
it.each([{ permissions: ['member.manage'] }, { permissions: ['level.manage'] }, { permissions: [] }])('does not read or mutate with unrelated permission $permissions', async ({ permissions }) => {
  const f = await mount(permissions); try { await f.view.load(); f.view.setFlag('member_card_status', 0); await f.view.save(); expect(f.calls).toEqual([]); expect(f.view.canView.value).toBe(false); } finally { f.close(); }
});
it('provides complete config.view read access and grants same-domain read to config.manage', async () => {
  const f = await mount(['config.view']); try { f.view.setFlag('member_card_status', 0); await f.view.save(); expect(f.view.form.value).toEqual(config().settings); expect(f.view.canManage.value).toBe(false); expect(writes(f.calls)).toEqual([]); expect(runtime.messages.state.confirmations).toEqual([]); } finally { f.close(); }
  const manager = await mount(['config.manage']); try { expect(manager.view.canView.value).toBe(true); expect(manager.view.editable.value).toBe(true); } finally { manager.close(); }
});
it('preserves the price switch when disabling membership, confirms both old/new values and posts exact integers with revision/UUID', async () => {
  const f = await mount(); try {
    f.view.setFlag('member_card_status', 0); expect(f.view.form.value.svip_price_status).toBe(1); await f.view.save();
    expect(JSON.parse(writes(f.calls)[0].data)).toEqual({ member_card_status: 0, svip_price_status: 1, revision, request_id: expect.stringMatching(uuid) });
    expect(runtime.messages.state.confirmations[0][0]).toContain('付费会员启用：开启 → 关闭'); expect(runtime.messages.state.confirmations[0][0]).toContain('付费会员价展示与计价：开启 → 开启');
    expect(runtime.messages.state.confirmations[0][0]).toContain('vip_price'); expect(f.calls.at(-1).method).toBe('get'); expect(runtime.messages.state.successes).toHaveLength(1);
  } finally { f.close(); }
});
it.each([null, '', '"1"', '01', 'bad'])('retains missing or malformed raw value %j without selecting a default, then requires explicit repair of both fields', async raw => {
  const f = await mount(grants, call => call.method === 'get' ? envelope(config({ settings: { member_card_status: null, svip_price_status: null },
    raw_values: { member_card_status: raw, svip_price_status: raw }, missing_keys: raw === null ? ['member_card_status', 'svip_price_status'] : [], issues: [{ key: 'member_card_status', message: '需明确修复' }] })) : undefined); try {
    expect(f.view.form.value).toEqual({ member_card_status: null, svip_price_status: null }); expect(f.view.config.value.raw_values.member_card_status).toBe(raw);
    await f.view.save(); expect(writes(f.calls)).toEqual([]); expect(f.view.formError.value).toContain('明确选择');
    f.view.setFlag('member_card_status', 0); await f.view.save(); expect(writes(f.calls)).toEqual([]);
    f.view.setFlag('svip_price_status', 1); await f.view.save(); expect(JSON.parse(writes(f.calls)[0].data)).toMatchObject({ member_card_status: 0, svip_price_status: 1 });
  } finally { f.close(); }
});
it.each(['1', false, 2])('rejects non-integer switch draft %j before confirmation or HTTP', async value => {
  const f = await mount(); try { f.view.form.value.svip_price_status = value; await f.view.save(); expect(writes(f.calls)).toEqual([]); expect(runtime.messages.state.confirmations).toEqual([]); expect(f.view.formError.value).toContain('明确选择'); } finally { f.close(); }
});
it('keeps the draft and performs no write when the user cancels confirmation', async () => {
  const f = await mount(); try { f.view.setFlag('member_card_status', 0); runtime.messages.state.confirm = () => Promise.reject('cancel'); await f.view.save(); expect(writes(f.calls)).toEqual([]); expect(f.view.form.value.member_card_status).toBe(0); expect(f.view.confirming.value).toBe(false); } finally { f.close(); }
});
it('does not submit a draft changed while confirmation is pending and permits only one active confirmation', async () => {
  const decision = deferred(); const f = await mount(); try { runtime.messages.state.confirm = () => decision.promise; const saving = f.view.save(); await f.view.save(); f.view.form.value.member_card_status = 0; decision.resolve(); await saving; expect(writes(f.calls)).toEqual([]); expect(runtime.messages.state.confirmations).toHaveLength(1); } finally { f.close(); }
});
it('distinguishes GET failure from defaults and retries without writing', async () => {
  let fail = true; const f = await mount(grants, () => { if (fail) throw Error('读取中断'); }); try { expect(f.view.ready.value).toBe(false); expect(f.view.form.value).toBeNull(); expect(f.view.loadError.value).toContain('中断'); fail = false; await f.view.load(); expect(f.view.form.value).toEqual(config().settings); expect(writes(f.calls)).toEqual([]); } finally { f.close(); }
});
it.each([{ settings: { member_card_status: 1 } }, { revision: 'bad' }, { raw_values: {} }, { missing_keys: ['unknown'] }, { issues: [{}] }])('rejects incomplete GET data %j rather than exposing a saveable draft', async invalid => {
  const f = await mount(grants, () => envelope(config(invalid))); try { expect(f.view.ready.value).toBe(false); expect(f.view.form.value).toBeNull(); expect(f.view.loadError.value).not.toBe(''); expect(writes(f.calls)).toEqual([]); } finally { f.close(); }
});
it('clears old data immediately and discards a slower superseded GET', async () => {
  const delayed = deferred(); let held = false, count = 0; const f = await mount(grants, () => held && ++count === 1 ? delayed.promise : undefined); try {
    held = true; const first = f.view.load(); await flush(); expect(f.view.form.value).toBeNull(); expect(f.view.ready.value).toBe(false);
    await f.view.load(); delayed.resolve(envelope(config({ settings: { member_card_status: 0, svip_price_status: 0 } }))); await first; expect(f.view.form.value).toEqual(config().settings);
  } finally { f.close(); }
});
it('asks before discarding an unsaved draft and cancellation leaves it intact', async () => {
  const f = await mount(); try { f.view.setFlag('svip_price_status', 0); runtime.messages.state.confirm = () => Promise.reject('cancel'); await f.view.reloadDraft(); expect(f.calls).toHaveLength(1); expect(f.view.form.value.svip_price_status).toBe(0); runtime.messages.state.confirm = () => Promise.resolve(); await f.view.reloadDraft(); expect(f.view.form.value.svip_price_status).toBe(1); expect(writes(f.calls)).toEqual([]); } finally { f.close(); }
});
it.each(['network', 'receipt', 'wrong-request', 'cache-array'])('retains the original unknown %s POST and UUID, only GETs for recovery, and acknowledgement emits no write', async mode => {
  const f = await mount(grants, call => { if (call.method !== 'post') return undefined; if (mode === 'network') throw Error('响应中断'); return envelope(mode === 'receipt' ? null : { committed: true, revision, request_id: mode === 'wrong-request' ? '00000000-0000-4000-8000-000000000000' : JSON.parse(call.data).request_id, cache_status: mode === 'cache-array' ? ['cleared'] : 'cleared' }); }); try {
    await f.view.save(); const body = JSON.parse(writes(f.calls)[0].data); expect(f.view.uncertainOperation.value.body).toEqual(body); expect(f.calls.at(-1).method).toBe('get'); expect(runtime.messages.state.successes).toEqual([]);
    await f.view.save(); f.view.setFlag('member_card_status', 0); await f.view.load(); expect(writes(f.calls)).toHaveLength(1); expect(f.view.uncertainOperation.value.body.request_id).toBe(body.request_id);
    const count = f.calls.length; await f.view.acknowledge(); expect(f.calls).toHaveLength(count); expect(f.view.uncertainOperation.value).toBeNull(); expect(runtime.messages.state.confirmations.at(-1)[0]).toContain('不证明服务器成功或失败');
  } finally { f.close(); }
});
it('keeps the uncertain request when recovery GET fails, blocks acknowledgement until a successful read, then recovers with no POST retry', async () => {
  let broken = false; const f = await mount(grants, call => { if (call.method === 'post') { broken = true; throw Error('写入后连接断开'); } if (broken) throw Error('重读也失败'); }); try {
    await f.view.save(); const body = f.view.uncertainOperation.value.body; await f.view.acknowledge(); expect(f.view.uncertainOperation.value.body).toEqual(body); expect(f.view.ready.value).toBe(false);
    broken = false; await f.view.load(); await f.view.acknowledge(); expect(f.view.uncertainOperation.value).toBeNull(); expect(writes(f.calls)).toHaveLength(1);
  } finally { f.close(); }
});
it('recognizes committed cache-pending receipts without treating cache recovery as rollback or resending', async () => {
  const f = await mount(grants, call => call.method === 'post' ? envelope({ committed: true, revision, request_id: JSON.parse(call.data).request_id, cache_status: 'pending' }) : undefined); try { await f.view.save(); expect(f.view.uncertainOperation.value).toBeNull(); expect(f.view.notice.value).toContain('数据库与审计已提交'); expect(runtime.messages.state.successes[0]).toContain('已保存'); expect(writes(f.calls)).toHaveLength(1); } finally { f.close(); }
});
it('handles a known revision conflict by re-reading and requiring a fresh human decision', async () => {
  const f = await mount(grants, call => call.method === 'post' ? envelope(null, 400, '配置已变化') : undefined); try { await f.view.save(); expect(f.view.uncertainOperation.value).toBeNull(); expect(f.view.notice.value).toContain('保存未完成'); expect(writes(f.calls)).toHaveLength(1); expect(f.calls.at(-1).method).toBe('get'); } finally { f.close(); }
});
it.each(['account', 'permission', 'aba'])('invalidates a pending save confirmation on %s session change', async change => {
  const decision = deferred(); const f = await mount(); try { runtime.messages.state.confirm = () => decision.promise; const saving = f.view.save(); await flush();
    login(change === 'permission' ? ['config.view'] : grants, 'paid-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed'));
    if (change === 'aba') { login(); browser.dispatchEvent(new Event('admin-session-changed')); }
    await flush(); decision.resolve(); await saving; expect(writes(f.calls)).toEqual([]); expect(runtime.messages.state.closed).toBeGreaterThan(0);
  } finally { f.close(); }
});
it('discards a previous account POST response without overwriting or toasting over a new draft', async () => {
  const delayed = deferred(); const f = await mount(grants, call => call.method === 'post' ? delayed.promise : undefined); try {
    const saving = f.view.save(); await flush(); const body = JSON.parse(writes(f.calls)[0].data); login(grants, 'paid-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); f.view.setFlag('svip_price_status', 0);
    delayed.resolve(envelope({ committed: true, revision, request_id: body.request_id, cache_status: 'cleared' })); await saving; expect(f.view.form.value.svip_price_status).toBe(0); expect(runtime.messages.state.successes).toEqual([]); expect(f.view.uncertainOperation.value).toBeNull();
  } finally { f.close(); }
});
it('reacts to cross-tab session replacement and also checks storage before confirmation without requiring an event', async () => {
  const f = await mount(); try {
    login(['member.manage'], 'paid-token-b', 21); await f.view.save(); expect(writes(f.calls)).toEqual([]); expect(runtime.messages.state.confirmations).toEqual([]);
    const event = new Event('storage'); Object.defineProperty(event, 'key', { value: 'admin_session' }); browser.dispatchEvent(event); expect(f.view.form.value).toBeNull(); expect(f.view.canView.value).toBe(false);
  } finally { f.close(); }
});
it('rejects late reads after unmount and removes session listeners', async () => {
  const delayed = deferred(); let hold = false; const f = await mount(grants, () => hold ? delayed.promise : undefined); hold = true; const pending = f.view.load(); await flush(); f.close(); delayed.resolve(envelope(config())); await pending;
  const count = f.calls.length; browser.dispatchEvent(new Event('admin-session-changed')); await flush(); expect(f.calls).toHaveLength(count); expect(f.view.form.value).toBeNull();
});
