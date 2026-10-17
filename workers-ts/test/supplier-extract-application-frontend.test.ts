import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
const operations = new Map<string, any>();
let runtime: any, pinia: any, browser: EventTarget, runtimeDirectory: string, hostDocument: { activeElement: null }, local: Map<string, string>;
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    import Page from './src/pages/FinanceApply.vue';export {Page};export const captured={};
    const setup=Page.setup;Page.setup=(p,c)=>{const value=setup(p,c);captured.view=value;return value;};
    export * as api from './src/api/supplierExtractApplication';export {http} from './src/api/http';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,ref} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-supplier-extract-application', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'supplier-extract-application', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'supplier-extract-application', compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
    } }] });
  runtimeDirectory = mkdtempSync('/tmp/cinashop-supplier-extract-application-sfc-');
  const path = resolve(runtimeDirectory, 'compiled-page.mjs'); writeFileSync(path, result.outputFiles[0].text);
  runtime = await import(pathToFileURL(path).href);
}, 30000);
afterAll(() => { if (runtimeDirectory) rmSync(runtimeDirectory, { recursive: true, force: true }); });
function login(permissions = ['supplier.finance.view', 'supplier.finance.manage'], token = 'owned-extract-application-session-a', id = 21, supplierId = 7) {
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
  operations.clear(); login(); pinia = runtime.createPinia();
});


afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const gate = () => { let resolve!: (value: any) => void; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const flush = async () => { for (let i = 0; i < 40; i++) { await Promise.resolve(); await runtime.nextTick(); } };
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node; [key: string]: any };
const content = (node: Node): string => (node.text ?? '') + node.children.map(content).join('');
async function mount(url = '/finance/apply', override: (config: any) => unknown = () => undefined) {
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
    { path: '/finance/apply', component: runtime.Page }, { path: '/finance/application-result', component: runtime.Page }, { path: '/away', component: { render: () => null } } ] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  app.component('el-button', { inheritAttrs: false, setup(_: unknown, { attrs, slots }: any) { return () => runtime.h('button', attrs, slots.default?.()); } });
  await router.push(url); app.mount(host); await flush();
  return { view: runtime.captured.view, host, calls, router, refresh, close: () => app.unmount() };
}
function seed(changes: Record<string, unknown> = {}): any {
  return { version: 'supplier-extract-application-seed-v1', actor_id: 21, supplier_id: 7, revision: 'a'.repeat(64),
    available: '735.00', min_price: '5.50', max_price: '200.00', can_apply: true,
    accounts: { bank: { bank_code: '000062220001', bank_address: '申请时开户行', ready: true },
      alipay: { account: 'owned-alipay', qrcode_url: '/owned-media/alipay.png', ready: true },
      weixin: { account: 'owned-wechat', qrcode_url: '/owned-media/wechat.png', ready: true } }, ...changes };
}
const pendingKey = () => runtime.api.extractApplicationStorageKey(21, 7);
async function pending(operation = '2e37c214-2497-4f05-a25b-d084e6c43521'): Promise<any> {
  const intent = runtime.api.makeExtractApplicationIntent(seed(), operation, 'bank', '25.50', '申请资料已核对');
  return { version: 'supplier-extract-application-pending-v1', operation_id: operation, actor_id: 21, supplier_id: 7,
    request_hash: await runtime.api.extractApplicationRequestHash(intent), money: '25.50', extract_type: 'bank' };
}
function terminal(operation: any, state = 'committed'): any {
  return { version: 'supplier-extract-application-receipt-v1', operation_id: operation.operation_id, actor_id: 21, supplier_id: 7, state,
    request_hash: state === 'committed' ? operation.request_hash : '', result: state === 'committed' ? { id: 51, extract_type: 'bank', extract_price: '25.50',
      balance: '709.50', bank_code: '000062220001', bank_address: '申请时开户行', alipay_account: '', wechat: '', qrcode_url: '',
      supplier_mark: '申请资料已核对', status: 0, pay_status: 0, add_time: 1788235200 } : null };
}
async function transport(c: any): Promise<any> {
  if (c.url.endsWith('/cash')) {
    if (c.method === 'get') return seed();
    const body = typeof c.data === 'string' ? JSON.parse(c.data) : c.data;
    const intent = { version: 'supplier-extract-application-intent-v1', ...body, actor_id: 21, supplier_id: 7 };
    const p = { version: 'supplier-extract-application-pending-v1', operation_id: body.operation_id, actor_id: 21, supplier_id: 7,
      request_hash: await runtime.api.extractApplicationRequestHash(intent), money: body.money, extract_type: body.extract_type };
    const value = terminal(p); operations.set(body.operation_id, value); return value;
  }
  const operation = c.url.match(/application_operations\/([^/]+)/)?.[1];
  const raw = local.get(pendingKey()); if (!operation || !raw) throw Error('Owned recovery requires original journal');
  const p = JSON.parse(raw); expect(p.operation_id).toBe(operation);
  if (c.method === 'post' && !operations.has(operation)) operations.set(operation, terminal(p, 'not_applied'));
  return operations.get(operation) ?? terminal(p, 'unknown');
}
function ready(f: any) { f.view.money.value = '25.5'; f.view.mark.value = '申请资料已核对'; f.view.confirmed.value = true; }
const posts = (f: any) => f.calls.filter((c: any) => c.method === 'post' && c.url.endsWith('/cash'));
function nodes(node: Node, tag: string): Node[] { return [...(node.tag === tag ? [node] : []), ...node.children.flatMap(child => nodes(child, tag))]; }

describe('actual withdrawal application page and durable original-key recovery', () => {
  it('shows current leading-zero account and exact limits, requires an explicit review and canonicalizes decimal input', async () => {
    const f = await mount(); try {
      expect(content(f.host)).toContain('000062220001'); expect(content(f.host)).toContain('¥735.00'); expect(f.view.canSubmit.value).toBe(false);
      ready(f); expect(f.view.canSubmit.value).toBe(true); await f.view.submit(); await flush();
      expect(posts(f)).toHaveLength(1); const body = JSON.parse(posts(f)[0].data);
      expect(Object.keys(body).sort()).toEqual(['extract_type', 'mark', 'money', 'operation_id', 'revision']); expect(body.money).toBe('25.50');
      expect(f.view.receipt.value).toMatchObject({ state: 'committed', result: { id: 51, bank_code: '000062220001', balance: '709.50' } });
      expect(local.has(pendingKey())).toBe(false); expect(content(f.host)).toContain('申请提交时的收款快照');
    } finally { f.close(); }
  });
  it('persists only the bounded own-actor digest before the financial POST and rejects a rapid second click', async () => {
    let journal: any; const f = await mount(undefined, c => { if (c.method === 'post') journal = JSON.parse(local.get(pendingKey())!); });
    try { ready(f); await Promise.all([f.view.submit(), f.view.submit()]); expect(posts(f)).toHaveLength(1);
      expect(Object.keys(journal).sort()).toEqual(['actor_id', 'extract_type', 'money', 'operation_id', 'request_hash', 'supplier_id', 'version']);
      expect(JSON.stringify(journal)).not.toContain('申请资料'); expect(JSON.stringify(journal)).not.toContain('000062220001'); expect(JSON.stringify(journal)).not.toContain('session');
    } finally { f.close(); }
  });
  it('keeps a committed but lost acknowledgement across remount and recovers by GET without another application', async () => {
    const f = await mount(undefined, async c => { if (c.method === 'post') { await transport(c); throw Error('Owned discarded acknowledgement503'); } });
    ready(f); await f.view.submit(); expect(f.view.pending.value).toBeTruthy(); expect(posts(f)).toHaveLength(1); expect(f.view.source.value).toBeNull(); f.close();
    const next = await mount('/finance/application-result'); try {
      expect(next.calls).toHaveLength(0); expect(next.view.pending.value).toBeTruthy(); await next.view.recover(); expect(next.calls).toHaveLength(1);
      expect(next.calls[0].method).toBe('get'); expect(next.view.receipt.value.state).toBe('committed'); expect(local.has(pendingKey())).toBe(false);
    } finally { next.close(); }
  });
  it('keeps an unknown GET read-only, requires explicit close confirmation and only then allows a fresh application', async () => {
    const p = await pending(); local.set(pendingKey(), JSON.stringify(p)); const f = await mount('/finance/application-result');
    try { await f.view.recover(); expect(f.view.pending.value).toBeTruthy(); expect(f.calls.map((c: any) => c.method)).toEqual(['get']);
      await f.view.recover(true); expect(f.calls).toHaveLength(1); f.view.closeConfirmed.value = true; await f.view.recover(true);
      expect(f.calls.map((c: any) => c.method)).toEqual(['get', 'post']); expect(JSON.parse(f.calls[1].data)).toEqual({});
      expect(f.view.receipt.value.state).toBe('not_applied'); expect(local.has(pendingKey())).toBe(false); expect(posts(f)).toHaveLength(0);
    } finally { f.close(); }
  });
  it('can query original committed results after both financial capabilities are revoked', async () => {
    const p = await pending(); local.set(pendingKey(), JSON.stringify(p)); operations.set(p.operation_id, terminal(p)); login([]);
    const f = await mount('/finance/application-result'); try { expect(f.view.canManage.value).toBe(false); await f.view.recover();
      expect(f.view.receipt.value.state).toBe('committed'); expect(f.calls).toHaveLength(1); expect(posts(f)).toHaveLength(0);
    } finally { f.close(); }
  });
  it('does not request current accounts or send an application from a view-only session', async () => {
    login(['supplier.finance.view']); const f = await mount(); try { await f.view.submit(); expect(f.calls).toEqual([]); expect(f.view.source.value).toBeNull(); } finally { f.close(); }
  });
  it.each(['set', 'get', 'locks'])('fails closed before POST when durable journal protection fails at %s', async kind => {
    const f = await mount(); try {
      ready(f); if (kind === 'set') localStorage.setItem = () => { throw Error('owned quota'); };
      if (kind === 'get') localStorage.getItem = () => { throw Error('owned unreadable storage'); };
      if (kind === 'locks') vi.stubGlobal('navigator', {});
      await f.view.submit(); expect(posts(f)).toHaveLength(0); expect(f.view.error.value || f.view.storageError.value).toBeTruthy();
    } finally { f.close(); }
  });
  it('retains the original journal if clearing it fails after a committed response, then recovers safely', async () => {
    const f = await mount(); const remove = localStorage.removeItem; try {
      ready(f); localStorage.removeItem = () => { throw Error('owned remove blocked'); }; await f.view.submit();
      expect(operations.size).toBe(1); expect(f.view.pending.value).toBeTruthy(); expect(f.view.receipt.value).toBeNull();
      localStorage.removeItem = remove; await f.view.recover(); expect(f.view.receipt.value.state).toBe('committed'); expect(posts(f)).toHaveLength(1);
    } finally { f.close(); }
  });
  it('does not erase a newer journal while handling an older result', async () => {
    const old = await pending(), newer = await pending('8e37c214-2497-4f05-a25b-d084e6c43522'); local.set(pendingKey(), JSON.stringify(newer));
    await expect(runtime.api.clearExtractApplication(old, () => true)).rejects.toThrow('已变化'); expect(JSON.parse(local.get(pendingKey())!).operation_id).toBe(newer.operation_id);
  });
  it('serializes two journal reservations under one own-actor lock', async () => {
    const one = await pending(), two = await pending('8e37c214-2497-4f05-a25b-d084e6c43522');
    const results = await Promise.allSettled([runtime.api.reserveExtractApplication(one, () => true), runtime.api.reserveExtractApplication(two, () => true)]);
    expect(results.map((r: any) => r.status)).toEqual(['fulfilled', 'rejected']); expect(JSON.parse(local.get(pendingKey())!).operation_id).toBe(one.operation_id);
  });
  it.each(['session', 'route', 'unmount'])('never displays a late seed after %s even when abort is ignored', async kind => {
    const late = gate(); const f = await mount(undefined, c => { c.signal = undefined; return late.promise; }); let closed = false;
    try { if (kind === 'session') { login([], 'other', 31, 8); browser.dispatchEvent(new Event('supplier-session-changed')); login(); browser.dispatchEvent(new Event('supplier-session-changed')); }
      if (kind === 'route') await f.router.push('/finance/application-result');
      if (kind === 'unmount') { f.close(); closed = true; }
      late.resolve(seed()); await flush(); expect(f.view.source.value).toBeNull(); expect(content(f.host)).not.toContain('000062220001');
    } finally { if (!closed) f.close(); }
  });
  it.each(['session', 'route', 'unmount', 'journal'])('ignores a late application response after %s while keeping its original key', async kind => {
    const late = gate(); let returned: any; const f = await mount(undefined, async c => { if (c.method === 'post') { returned = await transport(c); return late.promise; } }); let closed = false;
    try { ready(f); const task = f.view.submit(); await vi.waitFor(() => expect(posts(f)).toHaveLength(1)); expect(local.has(pendingKey())).toBe(true);
      if (kind === 'session') { login([], 'other', 31, 8); browser.dispatchEvent(new Event('supplier-session-changed')); login(); browser.dispatchEvent(new Event('supplier-session-changed')); }
      if (kind === 'route') await f.router.push('/finance/application-result');
      if (kind === 'unmount') { f.close(); closed = true; }
      if (kind === 'journal') { const event = new Event('storage'); Object.defineProperty(event, 'key', { value: pendingKey() }); browser.dispatchEvent(event); }
      late.resolve(returned); await task; await flush(); expect(f.view.receipt.value).toBeNull(); expect(local.has(pendingKey())).toBe(true); expect(posts(f)[0].signal.aborted).toBe(true);
    } finally { if (!closed) f.close(); }
  });
  it('does not publish or POST an old actor claim when the session changes after the durable reservation', async () => {
    const late = gate(); vi.stubGlobal('navigator', { locks: { request: async (_key: string, _options: unknown, work: () => unknown) => { const value = await work(); await late.promise; return value; } } });
    const f = await mount(); try { ready(f); const task = f.view.submit(); await vi.waitFor(() => expect(local.has(pendingKey())).toBe(true));
      login([], 'other', 31, 8); browser.dispatchEvent(new Event('supplier-session-changed')); login(); browser.dispatchEvent(new Event('supplier-session-changed'));
      late.resolve(undefined); await task; await flush(); expect(posts(f)).toHaveLength(0); expect(f.view.pending.value).toBeNull(); expect(content(f.host)).not.toContain('25.50'); expect(local.has(pendingKey())).toBe(true);
    } finally { f.close(); }
  });
  it('does not dispatch a saved original intent after its final digest check observes a session change', async () => {
    const f = await mount(); const original = crypto.subtle.digest.bind(crypto.subtle); let count = 0;
    const late = gate(); vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args: Parameters<typeof crypto.subtle.digest>) => { count++; if (count === 2) await late.promise; return original(...args); });
    try { ready(f); const task = f.view.submit(); await vi.waitFor(() => expect(count).toBe(2)); expect(local.has(pendingKey())).toBe(true);
      login([], 'other', 31, 8); browser.dispatchEvent(new Event('supplier-session-changed')); login(); browser.dispatchEvent(new Event('supplier-session-changed'));
      late.resolve(undefined); await task; expect(posts(f)).toHaveLength(0); expect(f.view.pending.value).toBeNull(); expect(local.has(pendingKey())).toBe(true);
    } finally { f.close(); }
  });
  it('cancels a financial POST queued inside the actual Axios interceptor before adapter dispatch after session ABA', async () => {
    const f = await mount(), late = gate(); let entered = false;
    const interceptor = runtime.http.interceptors.request.use(async (config: any) => { if (config.method === 'post' && config.url.endsWith('/cash')) { entered = true; await late.promise; } return config; });
    try { ready(f); const task = f.view.submit(); await vi.waitFor(() => expect(entered).toBe(true));
      login([], 'other', 31, 8); browser.dispatchEvent(new Event('supplier-session-changed')); login(); browser.dispatchEvent(new Event('supplier-session-changed'));
      late.resolve(undefined); await task; expect(posts(f)).toHaveLength(0); expect(local.has(pendingKey())).toBe(true); expect(f.view.receipt.value).toBeNull();
    } finally { runtime.http.interceptors.request.eject(interceptor); f.close(); }
  });
  it.each(['session', 'route', 'unmount', 'journal'])('ignores a late recovery after %s without removing the durable original key', async kind => {
    const p = await pending(); local.set(pendingKey(), JSON.stringify(p)); const late = gate(); const f = await mount('/finance/application-result', () => late.promise); let closed = false;
    try { const task = f.view.recover(); await flush(); expect(f.calls).toHaveLength(1);
      if (kind === 'session') { login([], 'other', 31, 8); browser.dispatchEvent(new Event('supplier-session-changed')); login(); browser.dispatchEvent(new Event('supplier-session-changed')); }
      if (kind === 'route') await f.router.push('/finance/apply');
      if (kind === 'unmount') { f.close(); closed = true; }
      if (kind === 'journal') { const event = new Event('storage'); Object.defineProperty(event, 'key', { value: pendingKey() }); browser.dispatchEvent(event); }
      late.resolve(terminal(p)); await task; await flush(); expect(f.view.receipt.value).toBeNull(); expect(local.has(pendingKey())).toBe(true); expect(content(f.host)).not.toContain('000062220001');
    } finally { if (!closed) f.close(); }
  });
  it('does not show or discard another actor journal', async () => {
    const p = await pending(); local.set(pendingKey(), JSON.stringify(p)); login(['supplier.finance.view'], 'other', 31, 8);
    const f = await mount('/finance/application-result'); try { expect(f.view.pending.value).toBeNull(); expect(f.calls).toEqual([]); expect(local.has(pendingKey())).toBe(true); } finally { f.close(); }
  });
  it('retains a damaged journal and blocks a new financial write', async () => {
    local.set(pendingKey(), '{invalid'); const f = await mount(); try { expect(f.view.storageError.value).toBeTruthy(); await f.view.submit(); expect(f.calls).toEqual([]); expect(local.get(pendingKey())).toBe('{invalid'); } finally { f.close(); }
  });
  it('binds native payment selection and invalidates the prior confirmation when the form changes', async () => {
    const f = await mount(); try { ready(f); const select = nodes(f.host, 'select')[0]; select.children.forEach(n => { n.selected = n.props.value === 'weixin'; }); select.dispatchEvent(new Event('change')); await flush();
      expect(f.view.extractType.value).toBe('weixin'); expect(f.view.confirmed.value).toBe(false); expect(content(f.host)).toContain('owned-wechat');
      expect(nodes(f.host, 'img').map(n => n.props.src)).toEqual(['/owned-media/wechat.png']); nodes(f.host, 'img')[0].props.onError(); await flush(); expect(content(f.host)).toContain('图片暂不可预览');
    } finally { f.close(); }
  });
  it('does not treat configured max0 as unlimited or allow a channel missing its QR code', async () => {
    const value = seed({ max_price: '0.00', can_apply: false }); value.accounts.alipay = { account: 'owned', qrcode_url: '', ready: false };
    const f = await mount(undefined, () => value); try { ready(f); f.view.extractType.value = 'alipay'; f.view.confirmed.value = true; await f.view.submit(); expect(posts(f)).toHaveLength(0); expect(content(f.host)).toContain('不能申请'); } finally { f.close(); }
  });
  it('rejects unknown route context before seed, lookup or POST', async () => {
    const p = await pending(); local.set(pendingKey(), JSON.stringify(p)); const f = await mount('/finance/application-result?supplier_id=8');
    try { await f.view.recover(); expect(f.calls).toEqual([]); expect(f.view.pending.value).toBeNull(); expect(f.view.error.value).toContain('参数无效'); } finally { f.close(); }
  });
});

describe('closed withdrawal application seed, intent and original receipt parsers', () => {
  it.each(['unknown', 'actor', 'supplier', 'revision', 'negative', 'unsafeNumber', 'limit', 'accounts', 'readiness', 'enabled'])('rejects corrupted seed %s', kind => {
    const value = seed(); if (kind === 'unknown') value.extra = true; if (kind === 'actor') value.actor_id = 22; if (kind === 'supplier') value.supplier_id = 8;
    if (kind === 'revision') value.revision = 'a'; if (kind === 'negative') value.available = '-1.00'; if (kind === 'unsafeNumber') value.available = 9007199254740992;
    if (kind === 'limit') value.min_price = '01.00'; if (kind === 'accounts') value.accounts.alipay.extra = true;
    if (kind === 'readiness') value.accounts.bank.ready = false; if (kind === 'enabled') value.can_apply = false;
    expect(() => runtime.api.parseExtractApplicationSeed(value, 21, 7)).toThrow();
  });
  it.each(['unknown', 'actor', 'supplier', 'operation', 'hash', 'amount', 'type'])('rejects a corrupted pending identity %s', async kind => {
    const p = await pending(); if (kind === 'unknown') p.extra = true; if (kind === 'actor') p.actor_id = 22; if (kind === 'supplier') p.supplier_id = 8;
    if (kind === 'operation') p.operation_id = p.operation_id.toUpperCase(); if (kind === 'hash') p.request_hash = 'a'; if (kind === 'amount') p.money = '25.5'; if (kind === 'type') p.extract_type = 'wx';
    expect(() => runtime.api.parsePendingExtractApplication(p, 21, 7)).toThrow();
  });
  it.each(['unknown', 'actor', 'supplier', 'operation', 'hash', 'result', 'amount', 'balance', 'status', 'time', 'account', 'foreignChannel', 'state'])('rejects a corrupted original receipt %s', async kind => {
    const p = await pending(), value = terminal(p); if (kind === 'unknown') value.extra = true; if (kind === 'actor') value.actor_id = 22;
    if (kind === 'supplier') value.supplier_id = 8; if (kind === 'operation') value.operation_id = crypto.randomUUID(); if (kind === 'hash') value.request_hash = 'b'.repeat(64);
    if (kind === 'result') value.result.extra = true; if (kind === 'amount') value.result.extract_price = '26.50'; if (kind === 'balance') value.result.balance = '-0.00';
    if (kind === 'status') value.result.status = 1; if (kind === 'time') value.result.add_time = 0; if (kind === 'account') value.result.bank_code = '0';
    if (kind === 'foreignChannel') value.result.alipay_account = 'other'; if (kind === 'state') value.state = 'unknown';
    expect(() => runtime.api.parseExtractApplicationReceipt(value, p)).toThrow();
  });
  it('preserves exact large cents and full Unicode notes without serializing mutable form fields into the digest', async () => {
    expect(runtime.api.normalizeExtractApplicationMoney('0000000025.5')).toBe('25.50');
    const source = seed({ available: '100049999999899.95', max_price: '9999999999.99' });
    const intent = runtime.api.makeExtractApplicationIntent(source, crypto.randomUUID(), 'bank', '9999999999.99', '😀'.repeat(255));
    expect(intent.money).toBe('9999999999.99'); expect([...intent.mark]).toHaveLength(255); expect(await runtime.api.extractApplicationRequestHash(intent)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => runtime.api.makeExtractApplicationIntent(source, crypto.randomUUID(), 'bank', '1.00', 'a\tb')).toThrow();
  });
});
