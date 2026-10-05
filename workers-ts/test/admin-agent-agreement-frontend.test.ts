import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
const envelope = (data: unknown, status = 200, msg = 'ok') => ({ status, msg, data });
const agreement = (content = '<p>原说明</p>', revision = '123', status = 1) =>
  ({ id: 2, type: 2, title: '分销说明', content, sort: 0, status, add_time: 1_790_000_000, revision });
let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/agent/agreement', href: '' } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/agent/AgentAgreement.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/agentAgreement';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
    export * as messages from 'element-plus';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' },
  bundle: true, write: false, platform: 'browser', format: 'esm',
  plugins: [{ name: 'agent-agreement-runtime', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'),
      { filename: path }).descriptor, { id: 'agent-agreement-runtime' }).content, loader: 'ts' }));
    builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'messages', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export const state = { successes: [] };
      export const ElMessage = { success: value => state.successes.push(value) };
    ` }));
  } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});

beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { pathname: '/agent/agreement', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.messages.state.successes = [];
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function login(permissions = ['agent_agreement.view', 'agent_agreement.manage'], token = 'agreement-a', id = 7) {
  values.set('admin_token', token);
  values.set('admin_session', JSON.stringify({ userInfo: { id, account: 'editor', level: 1, roles: '' },
    menus: [], uniqueAuth: permissions }));
}
const flush = async () => { for (let index = 0; index < 8; index++) {
  await new Promise(done => setTimeout(done, 1)); await runtime.nextTick();
} };
function deferred() { let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; }); return { promise, resolve }; }

async function mount(permissions = ['agent_agreement.view', 'agent_agreement.manage'],
  respond: (config: any) => unknown = config => envelope(config.method === 'get' ? agreement() : agreement('<p>新说明</p>', '124'))) {
  login(permissions);
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const data = await respond(config);
    return { config, data, status: 200, statusText: 'agreement fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }),
    createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null,
    patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) {
    view = runtime.Page.setup(props, context); return () => null;
  } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it('rejects malformed or cross-type records and treats a missing type=2 row as a create draft', () => {
  expect(runtime.api.parseAgentAgreement([])).toMatchObject({ id: 0, type: 2, revision: 'absent' });
  for (const bad of [null, { ...agreement(), type: 1 }, { ...agreement(), revision: '' },
    { ...agreement(), content: 42 }, { ...agreement(), status: 2 }]) {
    expect(() => runtime.api.parseAgentAgreement(bad)).toThrow('响应无效');
  }
});

it('separates view/manage permissions and sends content, status and the read revision', async () => {
  const viewer = await mount(['agent_agreement.view']);
  try {
    expect(viewer.view.canView.value).toBe(true);
    expect(viewer.view.canManage.value).toBe(false);
    viewer.view.record.value.content = '<p>不能保存</p>';
    await viewer.view.save();
    expect(viewer.calls.filter(call => call.method !== 'get')).toEqual([]);
  } finally { viewer.close(); }
  const editor = await mount();
  try {
    editor.view.record.value.content = '<p>新说明</p>';
    editor.view.record.value.status = 0;
    await editor.view.save();
    const write = editor.calls.find(call => call.method === 'post');
    expect(write.url).toBe('/agent/set_agent_agreement/2');
    expect(JSON.parse(write.data)).toEqual({ content: '<p>新说明</p>', status: 0, revision: '123' });
    expect(editor.view.record.value.revision).toBe('124');
    expect(runtime.messages.state.successes).toContain('分销说明已保存');
    expect(editor.view.dirty.value).toBe(false);
  } finally { editor.close(); }
});

it('keeps server conflicts visible, and never retries an uncertain write automatically', async () => {
  const fixture = await mount(undefined, config => config.method === 'post'
    ? envelope(null, 409, '分销说明已变更') : envelope(agreement()));
  try {
    fixture.view.record.value.content = '<p>本地改动</p>';
    await fixture.view.save();
    expect(fixture.view.notice.value).toContain('分销说明已变更');
    expect(fixture.calls.filter(call => call.method === 'post')).toHaveLength(1);
    expect(fixture.view.record.value.content).toBe('<p>本地改动</p>');
  } finally { fixture.close(); }
});

it('aborts a previous account read and clears its agreement before a late response resolves', async () => {
  const late = deferred(); let block = false;
  const fixture = await mount(undefined, config => block && config.method === 'get'
    ? late.promise : envelope(agreement()));
  try {
    block = true;
    const pending = fixture.view.load(); await flush();
    const stale = fixture.calls.at(-1);
    login(['distribution.view'], 'agreement-b', 8);
    browser.dispatchEvent(new Event('admin-session-changed')); await flush();
    expect(stale.signal.aborted).toBe(true);
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.view.record.value.content).toBe('');
    late.resolve(envelope(agreement('<p>旧账号秘密</p>')));
    await pending; await flush();
    expect(fixture.view.record.value.content).toBe('');
  } finally { fixture.close(); }
});

it('renders a sanitized preview and offers rich and source editing of the same body', async () => {
  const fixture = await mount(undefined, () => envelope(agreement('<p onclick="evil()">文字</p><script>evil()</script>')));
  try {
    expect(fixture.view.safePreview.value).not.toMatch(/onclick|<script/i);
    const page = readFileSync(resolve(root, 'src/pages/agent/AgentAgreement.vue'), 'utf8');
    expect(page).toContain('contenteditable');
    expect(page).toContain('HTML 源码');
    expect(page).toContain('v-html="safePreview"');
  } finally { fixture.close(); }
});
