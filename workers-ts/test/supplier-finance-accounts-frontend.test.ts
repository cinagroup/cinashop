import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let accountState: any, revisionCounter = 0, images: any[] = [];
let runtime: any, pinia: any, browser: EventTarget, runtimeDirectory: string, hostDocument: { activeElement: null }, local: Map<string, string>;
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    import Page from './src/pages/FinanceAccounts.vue';export {Page};export const captured={};
    const setup=Page.setup;Page.setup=(p,c)=>{const value=setup(p,c);captured.view=value;return value;};
    export * as api from './src/api/supplierFinanceAccounts';export {http} from './src/api/http';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,ref} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-supplier-finance-accounts', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'supplier-finance-accounts', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'supplier-finance-accounts', compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
    } }] });
  runtimeDirectory = mkdtempSync('/tmp/cinashop-supplier-finance-accounts-sfc-');
  const path = resolve(runtimeDirectory, 'compiled-page.mjs'); writeFileSync(path, result.outputFiles[0].text);
  runtime = await import(pathToFileURL(path).href);
}, 30000);
afterAll(() => { if (runtimeDirectory) rmSync(runtimeDirectory, { recursive: true, force: true }); });
function login(permissions = ['supplier.finance.view', 'supplier.finance.manage', 'supplier.attachment.view', 'supplier.attachment.manage'], token = 'owned-extract-application-session-a', id = 21, supplierId = 7) {
  localStorage.setItem('supplier-token', token); localStorage.setItem('supplier-user', JSON.stringify({ id, supplier_id: supplierId }));
  localStorage.setItem('supplier-permissions', JSON.stringify(permissions));
}
beforeEach(() => {
  local = new Map<string, string>(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { search: '' } }));
  class HostDocument { activeElement = null; }
  vi.stubGlobal('Document', HostDocument); vi.stubGlobal('ShadowRoot', class {});
  hostDocument = new HostDocument(); vi.stubGlobal('document', hostDocument);
  vi.stubGlobal('localStorage', { getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value), removeItem: (key: string) => local.delete(key) });
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', { locks: { request: async (key: string, _options: unknown, work: () => unknown) => { const previous = tails.get(key) ?? Promise.resolve(); const next = previous.catch(() => {}).then(work); tails.set(key, next); return next; } } });
  revisionCounter = 0; accountState = accountsContext(); images = [imageRow(31), imageRow(32)]; login(); pinia = runtime.createPinia();
});


afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const gate = () => { let resolve!: (value: any) => void; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const flush = async () => { for (let i = 0; i < 40; i++) { await Promise.resolve(); await runtime.nextTick(); } };
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node; [key: string]: any };
const content = (node: Node): string => (node.text ?? '') + node.children.map(content).join('');
async function mount(url = '/finance/accounts', override: (config: any) => unknown = () => undefined) {
  const calls: any[] = [];
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config);
    const value = custom ?? await transport(config);
    return { config, data: { status: 200, msg: 'owned extract transport', data: value }, status: 200, statusText: 'owned', headers: {} };
  };
  const host: Node = { children: [], props: {} };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => {
    const node: Node = Object.assign(new EventTarget(), { tag, tagName: tag.toUpperCase(), children: [] as Node[], props: {}, value: '', multiple: false, selected: false, getRootNode: () => hostDocument });
    Object.defineProperty(node, 'options', { get: () => node.children.filter(child => child.tag === 'option') }); return node;
  }, createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(node: Node, parent: Node, anchor?: Node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); node.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, node); },
    remove(node: Node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); }, parentNode: (node: Node) => node.parent,
    nextSibling: (node: Node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node: Node, property: string, _: unknown, value: unknown) { node.props[property] = value; if (['value', 'type', 'selected', 'multiple', 'checked'].includes(property)) node[property] = value; }, setText(node: Node, value: string) { node.text = value; }, setElementText(node: Node, value: string) { node.text = value; node.children = []; } });
  const refresh = runtime.ref(0);
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [
    { path: '/finance/accounts', component: runtime.Page }, { path: '/finance', component: runtime.Page, props: { embedded: true } }, { path: '/away', component: { render: () => null } } ] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  app.component('el-button', { inheritAttrs: false, setup(_: unknown, { attrs, slots }: any) { return () => runtime.h('button', attrs, slots.default?.()); } });
  app.component('el-dialog', { props: ['modelValue', 'title'], setup(props: any, { slots }: any) { return () => props.modelValue ? runtime.h('dialog', { 'aria-label': props.title }, [slots.default?.(), slots.footer?.()]) : null; } });
  app.component('el-input', { props: ['modelValue'], emits: ['update:modelValue'], setup(props: any, { attrs, emit }: any) { return () => runtime.h('input', { ...attrs, value: props.modelValue, onInput: (e: any) => emit('update:modelValue', e.target.value) }); } });
  app.component('el-tag', { setup(_: unknown, { slots }: any) { return () => runtime.h('span', {}, slots.default?.()); } });
  app.directive('loading', {});
  await router.push(url); app.mount(host); await flush();
  return { view: runtime.captured.view, host, calls, router, refresh, close: () => app.unmount() };
}
function accountsContext(changes: Record<string, unknown> = {}): any {
  const accounts = { bank_code: '000062220001', bank_address: '本机收款开户行', alipay_account: 'owned-alipay', alipay_qrcode_url: '/owned-media/alipay.png', wechat: 'owned-wechat', wechat_qrcode_url: '/owned-media/wechat.png' };
  return { version: 'supplier-finance-accounts-v1', actor_id: 21, supplier_id: 7, revision: 'a'.repeat(64), bounded: true, accounts,
    ready: { bank: true, alipay: true, weixin: true }, previews: { alipay: { reference: accounts.alipay_qrcode_url, status: 'ready', src: accounts.alipay_qrcode_url, expires_at: null },
      weixin: { reference: accounts.wechat_qrcode_url, status: 'ready', src: accounts.wechat_qrcode_url, expires_at: null } }, ...changes };
}
function ticket(id: number, expires = Math.floor(Date.now() / 1000) + 600) { return `/api/assets/${id}?expires=${expires}&signature=${'_'.repeat(43)}`; }
function imageRow(id: number) { return { att_id: id, pid: 0, type: 4, module_type: 1, relation_id: 7, file_type: 1, att_type: 'image/png', real_name: `本机二维码${id}`, canonical_url: `/api/assets/${id}`, att_dir: ticket(id), satt_dir: ticket(id) }; }
function currentContext(accounts: any, revision = 'b'.repeat(63) + (++revisionCounter).toString(16)): any {
  const base = accountsContext(); base.accounts = { ...accounts }; base.revision = revision;
  base.ready = { bank: !!accounts.bank_code && !!accounts.bank_address, alipay: !!accounts.alipay_account && !!accounts.alipay_qrcode_url, weixin: !!accounts.wechat && !!accounts.wechat_qrcode_url };
  for (const [channel, field] of [['alipay', 'alipay_qrcode_url'], ['weixin', 'wechat_qrcode_url']]) {
    const reference = accounts[field], match = /^\/api\/assets\/([1-9]\d*)$/.exec(reference), expires = Math.floor(Date.now() / 1000) + 600;
    base.previews[channel] = !reference ? { reference, status: 'unavailable', src: '', expires_at: null }
      : match ? { reference, status: 'ready', src: ticket(Number(match[1]), expires), expires_at: expires }
      : { reference, status: 'ready', src: reference, expires_at: null };
  }
  return base;
}
async function transport(c: any): Promise<any> {
  if (c.url === '/finance/info') {
    expect(c.params).toEqual({ selection: 'accounts' });
    if (c.method === 'post') {
      const { revision, ...accounts } = JSON.parse(c.data); expect(revision).toBe(accountState.revision);
      accountState = currentContext(accounts);
    }
    return structuredClone(accountState);
  }
  if (c.url === '/file/category') return { list: [] };
  if (c.url === '/file/file') return { list: structuredClone(images), count: images.length };
  if (c.url === '/file/upload') {
    expect(c.data).toBeInstanceOf(FormData); const file = c.data.get('file'); expect(file).toBeInstanceOf(File); images.push(imageRow(45));
    return { att_id: 45, url: '/api/assets/45', src: ticket(45), name: '收款二维码.png', size: file.size, type: 'image/png' };
  }
  throw Error('Unexpected owned account transport');
}
const posts = (f: any) => f.calls.filter((c: any) => c.method === 'post' && c.url === '/finance/info');
const uploads = (f: any) => f.calls.filter((c: any) => c.method === 'post' && c.url === '/file/upload');
function ready(f: any, bank = '000099990001') { f.view.form.bank_code = bank; f.view.reviewed.value = true; }
function nodes(node: Node, tag: string): Node[] { return [...(node.tag === tag ? [node] : []), ...node.children.flatMap(child => nodes(child, tag))]; }
function button(f: any, label: string) { const found = nodes(f.host, 'button').filter(n => content(n) === label || n.props['aria-label'] === label); expect(found).toHaveLength(1); return found[0]; }

describe('actual Supplier collection account page and scoped picker', () => {
  it('reads the leading-zero payee, requires review and submits exactly six scalars plus the current revision', async () => {
    const f = await mount(); try {
      expect(f.view.context.value.accounts.bank_code).toBe('000062220001'); expect(f.view.canSave.value).toBe(false);
      ready(f); await f.view.save(); await flush(); expect(posts(f)).toHaveLength(1);
      const data = JSON.parse(posts(f)[0].data); expect(Object.keys(data).sort()).toEqual([...Object.keys(runtime.api.financeAccountLimits), 'revision'].sort());
      expect(data.bank_code).toBe('000099990001'); expect(data.revision).toBe('a'.repeat(64)); expect(f.view.context.value.accounts.bank_code).toBe('000099990001');
      expect(f.view.message.value).toContain('收款资料已保存'); expect(JSON.stringify([...local.values()])).not.toContain('000099990001');
    } finally { f.close(); }
  });
  it('blocks rapid duplicate saves while the first request is in flight', async () => {
    const late = gate(); const f = await mount(undefined, c => c.method === 'post' ? late.promise : undefined);
    try { ready(f); const first = f.view.save(); await vi.waitFor(() => expect(posts(f)).toHaveLength(1)); await f.view.save();
      late.resolve(currentContext({ ...f.view.form })); await first; expect(posts(f)).toHaveLength(1);
    } finally { f.close(); }
  });
  it('permits a finance viewer to read the saved QR projection while refusing mutation and gallery entry', async () => {
    login(['supplier.finance.view']); const f = await mount(); try {
      expect(f.view.context.value.accounts.bank_code).toBe('000062220001'); expect(f.view.canManage.value).toBe(false);
      f.view.reviewed.value = true; await f.view.save(); f.view.openPicker('alipay'); await flush(); expect(posts(f)).toHaveLength(0); expect(f.view.pickerOpen.value).toBe(false);
      expect(f.calls).toHaveLength(1); expect(nodes(f.host, 'img').map(n => n.props.src)).toEqual(['/owned-media/alipay.png', '/owned-media/wechat.png']);
    } finally { f.close(); }
  });
  it('loads no account data without finance view permission', async () => {
    login(['supplier.order.view']); const f = await mount(); try { expect(f.calls).toHaveLength(0); expect(f.view.context.value).toBeUndefined(); await f.view.save(); expect(posts(f)).toHaveLength(0); } finally { f.close(); }
  });
  it('does not grant a finance manager full gallery access implicitly', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const f = await mount(); try {
      expect(f.view.canChoose.value).toBe(false); f.view.openPicker('alipay'); await flush(); expect(f.view.pickerOpen.value).toBe(false); expect(f.calls).toHaveLength(1);
      expect(content(f.host)).toContain('选择图片需要素材查看权限');
    } finally { f.close(); }
  });
  it('keeps a lost save response unknown until explicit current-value read and never claims an original receipt', async () => {
    const f = await mount(undefined, async c => { if (c.method === 'post') { await transport(c); throw Error('Owned discarded settings acknowledgement503'); } });
    try { ready(f); await f.view.save(); expect(f.view.unknown.value).toBe(true); expect(f.view.canSave.value).toBe(false);
      await f.view.save(); const before = f.calls.length; await f.view.load(); expect(f.calls).toHaveLength(before);
      await f.view.load(true); expect(posts(f)).toHaveLength(1); expect(f.view.unknown.value).toBe(false); expect(f.view.form.bank_code).toBe('000099990001');
      expect(f.view.message.value).toContain('不是原保存回执'); expect(f.view.message.value).not.toContain('已保存');
    } finally { f.close(); }
  });
  it('shows current differing values after an uncertain save instead of writing its old draft again', async () => {
    const f = await mount(undefined, async c => { if (c.method === 'post') throw Error('Owned unknown wire'); });
    try { ready(f); await f.view.save(); accountState = currentContext({ ...accountState.accounts, bank_code: '000088880002' });
      await f.view.load(true); expect(posts(f)).toHaveLength(1); expect(f.view.form.bank_code).toBe('000088880002'); expect(f.view.message.value).toContain('上次填写不同');
    } finally { f.close(); }
  });
  it.each(['session', 'route', 'unmount'])('clears and rejects a late account context after %s even when transport ignores abort', async kind => {
    const late = gate(); const f = await mount(undefined, c => { c.signal = undefined; return late.promise; }); let closed = false;
    try {
      if (kind === 'session') { login([], 'owned-b', 31, 8); browser.dispatchEvent(new Event('supplier-session-changed')); login(); browser.dispatchEvent(new Event('supplier-session-changed')); }
      if (kind === 'route') await f.router.push('/away'); if (kind === 'unmount') { f.close(); closed = true; }
      late.resolve(accountsContext()); await flush(); expect(f.view.context.value).toBeUndefined(); expect(content(f.host)).not.toContain('000062220001');
    } finally { if (!closed) f.close(); }
  });
  it.each(['session', 'route', 'unmount'])('never publishes a late saved payee after %s when abort is ignored', async kind => {
    const late = gate(); const f = await mount(undefined, async c => { if (c.method === 'post') { c.signal = undefined; await transport(c); return late.promise; } }); let closed = false;
    try { ready(f); const task = f.view.save(); await vi.waitFor(() => expect(posts(f)).toHaveLength(1));
      if (kind === 'session') { login([], 'owned-b', 31, 8); browser.dispatchEvent(new Event('supplier-session-changed')); login(); browser.dispatchEvent(new Event('supplier-session-changed')); }
      if (kind === 'route') await f.router.push('/away'); if (kind === 'unmount') { f.close(); closed = true; }
      late.resolve(structuredClone(accountState)); await task; await flush(); expect(f.view.context.value).toBeUndefined(); expect(f.view.message.value).toBe(''); expect(content(f.host)).not.toContain('000099990001');
    } finally { if (!closed) f.close(); }
  });
  it('cancels a save queued in actual Axios before adapter dispatch after session A to B to A', async () => {
    const f = await mount(), late = gate(); let entered = false;
    const key = runtime.http.interceptors.request.use(async (c: any) => { if (c.method === 'post') { entered = true; await late.promise; } return c; });
    try { ready(f); const task = f.view.save(); await vi.waitFor(() => expect(entered).toBe(true));
      login([], 'owned-b', 31, 8); browser.dispatchEvent(new Event('supplier-session-changed')); login(); browser.dispatchEvent(new Event('supplier-session-changed'));
      late.resolve(undefined); await task; expect(posts(f)).toHaveLength(0); expect(f.view.context.value).toBeUndefined();
    } finally { runtime.http.interceptors.request.eject(key); f.close(); }
  });
  it('clears sensitive settings on a storage read failure before sending a write', async () => {
    const f = await mount(); try { ready(f); localStorage.getItem = () => { throw Error('Owned storage unavailable'); }; await f.view.save(); expect(posts(f)).toHaveLength(0); expect(f.view.context.value).toBeUndefined(); expect(f.view.form.bank_code).toBe(''); } finally { f.close(); }
  });
  it('rejects query scope before account reads or writes', async () => {
    const f = await mount('/finance/accounts?supplier_id=8'); try { expect(f.calls).toHaveLength(0); expect(f.view.context.value).toBeUndefined(); await f.view.save(); expect(posts(f)).toHaveLength(0); } finally { f.close(); }
  });
  it('uses the same closed account context in the original financial settings tab', async () => {
    const f = await mount('/finance'); try { expect(f.view.context.value.accounts.bank_code).toBe('000062220001'); expect(f.calls[0].params).toEqual({ selection: 'accounts' }); } finally { f.close(); }
  });
  it('uses the actual own-supplier image picker and persists its stable reference rather than its ticket', async () => {
    const f = await mount(); try {
      f.view.openPicker('alipay'); await flush(); expect(content(f.host)).toContain('保存后生效');
      button(f, '选择图片 本机二维码31').props.onClick(); await flush(); button(f, '使用所选图片').props.onClick(); await flush();
      expect(f.view.form.alipay_qrcode_url).toBe('/api/assets/31'); expect(f.view.pickerOpen.value).toBe(false); f.view.reviewed.value = true; await f.view.save();
      const data = JSON.parse(posts(f)[0].data); expect(data.alipay_qrcode_url).toBe('/api/assets/31'); expect(JSON.stringify(data)).not.toContain('signature=');
      expect(nodes(f.host, 'img').map(n => n.props.src).some(src => /^\/api\/assets\/31\?/.test(src))).toBe(true);
    } finally { f.close(); }
  });
  it('does not apply a selection emitted with an old picker context or after close', async () => {
    const f = await mount(); try { f.view.openPicker('alipay'); await flush(); const key = f.view.pickerKey.value; f.view.pickerOpen.value = false; await flush();
      f.view.openPicker('weixin'); await flush(); const selected = [{ id: 31, pid: 0, name: 'owned', canonicalUrl: '/api/assets/31', previewUrl: ticket(31), thumbnailUrl: ticket(31) }];
      f.view.acceptImages(selected, key); expect(f.view.form.alipay_qrcode_url).toBe('/owned-media/alipay.png'); expect(f.view.form.wechat_qrcode_url).toBe('/owned-media/wechat.png');
    } finally { f.close(); }
  });
  it('does not show an upload control to a material viewer without material manage', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage', 'supplier.attachment.view']); const f = await mount(); try { f.view.openPicker('alipay'); await flush();
      expect(nodes(f.host, 'button').some(n => content(n) === '上传图片')).toBe(false); expect(uploads(f)).toHaveLength(0);
    } finally { f.close(); }
  });
  it('uploads through the actual multipart helper, re-reads material metadata and only then chooses the new stable key', async () => {
    const f = await mount(); try { f.view.openPicker('weixin'); await flush(); const input = nodes(f.host, 'input').find(n => n.props.type === 'file')!;
      await input.props.onChange({ target: { files: [new File([new Uint8Array([137, 80, 78, 71])], '收款二维码.png', { type: 'image/png' })], value: 'owned' } }); await flush();
      expect(uploads(f)).toHaveLength(1); button(f, '选择图片 本机二维码45').props.onClick(); await flush(); button(f, '使用所选图片').props.onClick(); await flush();
      expect(f.view.form.wechat_qrcode_url).toBe('/api/assets/45'); expect(posts(f)).toHaveLength(0);
    } finally { f.close(); }
  });
  it('keeps an uncertain upload disabled and reconciles the material list without automatically repeating bytes', async () => {
    const f = await mount(undefined, async c => { if (c.url === '/file/upload') { await transport(c); throw Error('Owned lost image upload acknowledgement'); } });
    try { f.view.openPicker('alipay'); await flush(); const input = nodes(f.host, 'input').find(n => n.props.type === 'file')!;
      const event = { target: { files: [new File([new Uint8Array([137, 80])], 'owned.png', { type: 'image/png' })], value: 'owned' } };
      await input.props.onChange(event); await flush(); await input.props.onChange(event); await flush(); expect(uploads(f)).toHaveLength(1); expect(content(f.host)).toContain('未能确认上传结果');
      expect(f.calls.filter((c: any) => c.url === '/file/file').length).toBeGreaterThan(1); expect(posts(f)).toHaveLength(0);
    } finally { f.close(); }
  });
});

describe('closed account context and precise canonical settings values', () => {
  const owner = { actor_id: 21, supplier_id: 7 };
  it('parses the complete owned8-field context and normalizes a seven-field save', () => {
    const ctx = runtime.api.parseFinanceAccounts(accountsContext(), owner); const body = runtime.api.makeFinanceAccountsSave(ctx, { ...ctx.accounts, bank_code: ' 0000007 ' });
    expect(body.bank_code).toBe('0000007'); expect(Object.keys(body)).toHaveLength(7); expect(body.revision).toBe(ctx.revision);
  });
  it.each(['version', 'actor_id', 'supplier_id', 'revision', 'bounded', 'extra', 'account_extra', 'account_missing', 'account_number', 'account_noncanonical', 'ready', 'preview_reference', 'preview_extra', 'preview_public_src'])('rejects an unbound context at %s', key => {
    const value = accountsContext(); if (key === 'version') value.version = 'unknown'; if (key === 'actor_id') value.actor_id = 31; if (key === 'supplier_id') value.supplier_id = 8;
    if (key === 'revision') value.revision = 'A'.repeat(64); if (key === 'bounded') value.bounded = false; if (key === 'extra') value.extra = true;
    if (key === 'account_extra') value.accounts.balance = '1.00'; if (key === 'account_missing') delete value.accounts.wechat; if (key === 'account_number') value.accounts.bank_code = 123;
    if (key === 'account_noncanonical') value.accounts.bank_code = ' 00007 '; if (key === 'ready') value.ready.bank = false;
    if (key === 'preview_reference') value.previews.alipay.reference = '/foreign.png'; if (key === 'preview_extra') value.previews.alipay.token = 'bad'; if (key === 'preview_public_src') value.previews.alipay.src = '/foreign.png';
    expect(() => runtime.api.parseFinanceAccounts(value, owner)).toThrow();
  });
  it.each(['wrong_id', 'unsigned', 'expired', 'too_long', 'fraction_expiry'])('rejects malformed private QR projections at %s', kind => {
    const value = currentContext({ ...accountsContext().accounts, alipay_qrcode_url: '/api/assets/31' });
    if (kind === 'wrong_id') value.previews.alipay.src = ticket(41); if (kind === 'unsigned') value.previews.alipay.src = '/api/assets/31';
    if (kind === 'expired') { value.previews.alipay.expires_at = Math.floor(Date.now() / 1000) - 1; value.previews.alipay.src = ticket(31, value.previews.alipay.expires_at); }
    if (kind === 'too_long') { value.previews.alipay.expires_at += 4000; value.previews.alipay.src = ticket(31, value.previews.alipay.expires_at); }
    if (kind === 'fraction_expiry') value.previews.alipay.expires_at += 0.5;
    expect(() => runtime.api.parseFinanceAccounts(value, owner)).toThrow();
  });
  it('allows a bounded unavailable historical reference without executing or replacing it', () => {
    const value = accountsContext(); value.accounts.alipay_qrcode_url = 'javascript:legacy-retained'; value.previews.alipay = { reference: value.accounts.alipay_qrcode_url, status: 'unavailable', src: '', expires_at: null };
    const ctx = runtime.api.parseFinanceAccounts(value, owner); expect(runtime.api.financeAccountPreview(ctx.previews.alipay, ctx.accounts.alipay_qrcode_url)).toBe('');
    expect(runtime.api.makeFinanceAccountsSave(ctx, ctx.accounts).alipay_qrcode_url).toBe(value.accounts.alipay_qrcode_url);
  });
  it('expires a previously valid private QR without using its canonical ID as a public image', () => {
    const expires = Math.floor(Date.now() / 1000) + 30, entry = { reference: '/api/assets/31', status: 'ready', src: ticket(31, expires), expires_at: expires };
    expect(runtime.api.financeAccountPreview(entry, '/api/assets/31', expires - 1)).toBe(entry.src); expect(runtime.api.financeAccountPreview(entry, '/api/assets/31', expires)).toBe('');
  });
  it.each([null, 1, true, '\0', '\n', '\r', '\t', '\ud800', '\udc00'])('rejects invalid raw scalar %j before trimming', value => {
    expect(() => runtime.api.financeAccountText(value, 256)).toThrow();
  });
  it('uses Unicode scalar lengths and preserves every leading zero', () => {
    expect(runtime.api.financeAccountText('😀'.repeat(15), 15)).toBe('😀'.repeat(15)); expect(() => runtime.api.financeAccountText('😀'.repeat(16), 15)).toThrow();
    expect(runtime.api.normalizeFinanceAccounts({ ...runtime.api.emptyFinanceAccounts(), bank_code: '0000007' }).bank_code).toBe('0000007');
    expect(runtime.api.normalizeFinanceAccounts({ ...runtime.api.emptyFinanceAccounts(), bank_code: '0' }).bank_code).toBe('');
  });
  it.each(['javascript:changed', 'data:image/png;base64,a', 'http://example.test/a.png', '//example.test/a.png', '/kefuapi/assets/31', '/api/assets/31?expires=1&signature=a', 'https://example.test/a.png?signature=a'])('refuses unsafe or expiring changed QR %s', reference => {
    const ctx = runtime.api.parseFinanceAccounts(accountsContext(), owner); expect(() => runtime.api.makeFinanceAccountsSave(ctx, { ...ctx.accounts, alipay_qrcode_url: reference })).toThrow();
  });
  it('allows all channels to be cleared and leaves application completeness to the withdrawal boundary', () => {
    const ctx = runtime.api.parseFinanceAccounts(accountsContext(), owner); const data = runtime.api.makeFinanceAccountsSave(ctx, runtime.api.emptyFinanceAccounts()); expect(data.alipay_account).toBe(''); expect(data.bank_code).toBe('');
    const cleared = currentContext(runtime.api.emptyFinanceAccounts()); expect(runtime.api.parseFinanceAccounts(cleared, owner).ready).toEqual({ bank: false, alipay: false, weixin: false });
  });
});
