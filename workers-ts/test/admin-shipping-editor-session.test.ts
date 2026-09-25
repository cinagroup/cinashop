import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Exercise the actual editor setup, auth scope and Axios adapter together.
const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
let runtime: any;
let browser: EventTarget;
let values: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/shipping', href: '' } }));
  const bundled = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, contents: `
      export { default as Editor } from './src/pages/shipping/ShippingTemplateEditor.vue';
      export { default as request } from './src/utils/request';
      export * as auth from './src/utils/auth';
      export { createRenderer, nextTick } from 'vue';
    ` },
    alias: { '@': resolve(root, 'src') },
    bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'actual-shipping-editor', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'shipping-editor-session' }).content,
        loader: 'ts',
      }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
});

beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { pathname: '/shipping', href: '' } }));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  runtime.auth.setToken('shipping-token-a');
  values.set('admin_session', JSON.stringify({ userInfo: { id: 7, account: 'admin-a' }, menus: [], uniqueAuth: ['shipping.manage'] }));
});
afterEach(() => vi.unstubAllGlobals());

const envelope = (data: unknown) => ({ status: 200, data });
const detail = (name = '原模板') => ({ revision: `shipping-v1:${'a'.repeat(64)}`,
  formData: { id: 10, name, type: 1, status: 1, sort: 0, appoint: 0, no_delivery: 0 },
  region_info: [{ city_ids: [[0]], first: '1.00', first_price: '2.00', continue: '1.00', continue_price: '1.00' }],
  appoint_info: [], no_delivery_info: [] });
const gate = () => { let resolve!: (value: unknown) => void;
  return { promise: new Promise(done => { resolve = done; }), resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };

async function mount(respond: (config: any) => unknown = () => undefined) {
  const calls: any[] = [], events: string[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    const data = custom ?? envelope(config.url === '/shipping_template/city_list' ? []
      : config.url === '/shipping_template/10/edit' ? detail() : { id: 10 });
    return { config, data, status: 200, statusText: 'local fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup() { view = runtime.Editor.setup({ id: 10 }, { emit: (event: string) => events.push(event), expose() {} }); return () => null; } });
  app.mount({ children: [] }); await flush();
  return { view, calls, events, close: () => app.unmount() };
}

it('locks the mounted editor after an in-flight save crosses an account switch, even if the old reply arrives', async () => {
  const pending = gate();
  const f = await mount(config => config.method === 'post' ? pending.promise : undefined);
  try {
    expect(f.view.ready.value).toBe(true);
    f.view.form.name = '已输入但未确认';
    const saving = f.view.save(); await flush();
    expect(f.calls.filter(call => call.method === 'post')).toHaveLength(1);
    runtime.auth.setToken('shipping-token-b'); runtime.auth.setToken('shipping-token-a');
    pending.resolve(envelope({ id: 10 })); await saving; await flush();
    expect(f.events).not.toContain('saved');
    expect(f.view.ready.value).toBe(false);
    expect(f.view.error.value).toContain('登录身份已变化');
    await f.view.save();
    expect(f.calls.filter(call => call.method === 'post')).toHaveLength(1);
  } finally { f.close(); }
});

it('keeps an edit frozen after a committed write loses its response; reopening reads the committed value without resending', async () => {
  let stored = '原模板', writes = 0;
  const respond = (config: any) => {
    if (config.url === '/shipping_template/10/edit') return envelope(detail(stored));
    if (config.method === 'post') {
      writes++; stored = JSON.parse(config.data).name;
      throw new Error('connection lost after commit');
    }
    return undefined;
  };
  const first = await mount(respond);
  try {
    first.view.form.name = '已提交的新名称';
    await first.view.save(); await flush();
    expect(first.view.uncertain.value).toBe(true);
    expect(first.view.error.value).toContain('结果未知');
    expect(first.events).not.toContain('saved');
    await first.view.save();
    expect(writes).toBe(1);
  } finally { first.close(); }
  const reopened = await mount(respond);
  try {
    expect(reopened.view.form.name).toBe('已提交的新名称');
    expect(writes).toBe(1);
  } finally { reopened.close(); }
});

it('keeps a confirmed business rejection editable and retries only after a new user action', async () => {
  let writes = 0;
  const f = await mount(config => config.method === 'post'
    ? ++writes === 1 ? { status: 400, msg: '模板版本冲突', data: null } : envelope({ id: 10 })
    : undefined);
  try {
    f.view.form.name = '保留的输入';
    await f.view.save();
    expect(f.view.uncertain.value).toBe(false);
    expect(f.view.error.value).toContain('模板版本冲突');
    expect(f.view.form.name).toBe('保留的输入');
    expect(writes).toBe(1);
    await f.view.save();
    expect(writes).toBe(2);
    expect(f.events).toEqual(['saved']);
  } finally { f.close(); }
});
