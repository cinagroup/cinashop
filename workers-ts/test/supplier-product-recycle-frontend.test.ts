import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget;
beforeAll(async () => {
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `import Page from './src/pages/ProductRecycle.vue';
    export {Page};export const captured={};const setup=Page.setup;Page.setup=(p,c)=>{const value=setup(p,c);captured.view=value;return value;};
    export {http} from './src/api/http';export * as dialogs from 'element-plus';export {createPinia,disposePinia} from 'pinia';
    export {createRenderer,h,nextTick,provide,inject} from 'vue';export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-recycle-page-and-transport', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'owned-supplier-recycle', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'owned-supplier-recycle',
          compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialog', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const messages=[],confirmations=[];
        export const ElMessage={success:m=>messages.push(m),error:m=>messages.push(m),warning:m=>messages.push(m)};
        export const ElMessageBox={confirm:async(...args)=>{confirmations.push(args)}};` }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}, 30000);
beforeEach(() => {
  const storage = new Map<string, string>(); surface = new EventTarget(); vi.stubGlobal('window', surface);
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  localStorage.setItem('supplier-token', 'owned-recycle-a'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":20}');
  localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage"]');
  pinia = runtime.createPinia(); runtime.dialogs.messages.length = 0; runtime.dialogs.confirmations.length = 0;
  runtime.dialogs.ElMessageBox.confirm = async (...args: any[]) => { runtime.dialogs.confirmations.push(args); };
});
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const product = (id: number, is_del = 1) => ({ id, product_type: 0, is_del, store_name: `回收商品${id}`, price: '12.00', stock: 5, sales: 1, is_show: 0, is_verify: 1, image: '', add_time: 100 });
const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(done => { resolve = done; }), resolve }; };
async function flush() { for (let i = 0; i < 35; i++) { await Promise.resolve(); await runtime.nextTick(); } }
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node };
const walk = (n: Node): Node[] => [n, ...n.children.flatMap(walk)];
const text = (n: Node): string => (n.text ?? '') + n.children.map(text).join('');
async function mount(override: (config: any, fixture: any) => unknown = () => undefined) {
  const calls: any[] = [], fixture = { rows: [product(1), product(2)], apply(config: any) {
    const id = Number(config.url.split('/').at(-1)), row = fixture.rows.find(item => item.id === id)!;
    const body = JSON.parse(config.data); if (!row || row.is_del !== body.expected_is_del) throw Error('owned state conflict');
    if (config.url.includes('/thorough/')) { fixture.rows = fixture.rows.filter(item => item.id !== id); return { id, operation: 'delete' }; }
    row.is_del = 0; return { id, is_del: 0, operation: 'restore' };
  } };
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config, fixture);
    let data = custom;
    if (data === undefined) {
      if (config.method === 'delete') data = fixture.apply(config);
      else if (config.url === '/product/type_header') data = { list: [{ type: 6, name: '回收站', count: fixture.rows.filter(row => row.is_del === 1 && (!config.params.store_name || row.store_name.includes(config.params.store_name))).length }] };
      else {
        const { page, limit, is_del, id, store_name } = config.params;
        const selected = fixture.rows.filter(row => (is_del === 'all' || row.is_del === Number(is_del)) && (!id || row.id === id) && (!store_name || row.store_name.includes(store_name)));
        data = { list: structuredClone(selected.slice((page - 1) * limit, page * limit)), count: selected.length, page, limit };
      }
    }
    return { config, data: { status: 200, msg: 'owned transport', data }, status: 200, statusText: 'owned', headers: {} };
  };
  const host: Node = { children: [], props: {} };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => ({ tag, children: [], props: {} }), createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(n: Node, p: Node, anchor?: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); n.parent = p; const at = anchor ? p.children.indexOf(anchor) : -1; p.children.splice(at < 0 ? p.children.length : at, 0, n); },
    remove(n: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); }, parentNode: (n: Node) => n.parent,
    nextSibling: (n: Node) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, patchProp(n: Node, key: string, _: unknown, value: unknown) { n.props[key] = value; },
    setText(n: Node, value: string) { n.text = value; }, setElementText(n: Node, value: string) { n.text = value; n.children = []; } });
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/products/recycle', component: runtime.Page }, { path: '/products/new', component: { render: () => null } }, { path: '/products', component: { render: () => null } }] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  for (const [name, tag] of Object.entries({ 'el-button': 'button', 'el-input': 'input', 'el-alert': 'alert', 'el-pagination': 'pagination' })) app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(tag, attrs, slots.default?.()); } });
  app.component('el-table', { props: ['data'], setup(props: any, { slots }: any) { runtime.provide('owned-recycle-rows', () => props.data); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('owned-recycle-rows'); return () => runtime.h('column', { label: props.label }, rows().map((row: any) => runtime.h('cell', { row: row.id }, slots.default ? slots.default({ row }) : String(row[props.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push('/products/recycle'); app.mount(host); await flush();
  const press = async (label: string) => { const button = walk(host).find(n => n.tag === 'button' && text(n) === label); if (!button || button.props.disabled) throw Error('Owned button unavailable: ' + label); await button.props.onClick(); await flush(); };
  return { view: runtime.captured.view, calls, fixture, host, press, router, close: () => app.unmount() };
}
const writes = (f: any) => f.calls.filter((config: any) => config.method === 'delete');
describe('rendered Supplier recycle SFC with actual Axios and scoped state transitions', () => {
  it('enters a fresh copy from the rendered recycle row without restoring or deleting the source', async () => {
    const f = await mount(); try { await f.press('复制为新商品'); expect(f.router.currentRoute.value.fullPath).toBe('/products/new?copy=1'); expect(writes(f)).toEqual([]); }
    finally { f.close(); }
  });
  it('blocks recycled copy navigation while another result is unknown or the loaded filter changed', async () => {
    const f = await mount(config => config.method === 'delete' ? Promise.reject(Error('owned unknown delete')) : undefined);
    try { const row = f.view.rows.value[0]; await f.view.change(row, 'restore'); f.view.copyProduct(row); await flush(); expect(f.router.currentRoute.value.path).toBe('/products/recycle'); }
    finally { f.close(); }
    const g = await mount(); try { const row = g.view.rows.value[0]; g.view.filters.store_name = 'stale'; g.view.copyProduct(row); await flush(); expect(g.router.currentRoute.value.path).toBe('/products/recycle'); }
    finally { g.close(); }
  });
  it('reads only recycled products and renders guarded restore and permanent-delete controls', async () => {
    const f = await mount(); try { expect(f.view.ready.value).toBe(true); expect(text(f.host)).toContain('商品回收站'); expect(text(f.host)).toContain('彻底删除');
      expect(f.calls[0].params).toEqual({ page: 1, limit: 20, store_name: '', is_del: 1 }); } finally { f.close(); }
  });
  it.each(['restore', 'delete'] as const)('confirms and sends exactly one %s with expected recycled state, then refreshes authoritative rows', async operation => {
    const f = await mount(); try { await f.press(operation === 'restore' ? '恢复' : '彻底删除'); expect(writes(f)).toHaveLength(1);
      expect(writes(f)[0].url).toBe(operation === 'restore' ? '/product/product/1' : '/product/product/thorough/1');
      expect(JSON.parse(writes(f)[0].data)).toEqual({ expected_is_del: 1 }); expect(f.view.rows.value.map((row: any) => row.id)).toEqual([2]);
      expect(f.view.pending.value).toBeNull(); expect(f.view.ready.value).toBe(true); } finally { f.close(); }
  });
  it.each(['restore', 'delete'] as const)('recovers committed %s response loss with one exact single-snapshot read and no second write', async operation => {
    const f = await mount((config, fixture) => { if (config.method === 'delete') { fixture.apply(config); throw Error('Owned committed response lost'); } });
    try { await f.view.change(f.view.rows.value[0], operation); expect(f.view.pending.value).toEqual({ id: 1, operation });
      await f.view.change(f.view.rows.value[1], operation); expect(writes(f)).toHaveLength(1); await f.press('核对原结果');
      expect(f.calls.filter((c: any) => c.params?.id === 1).map((c: any) => c.params)).toEqual([{ id: 1, is_del: 'all', page: 1, limit: 1 }]);
      expect(writes(f)).toHaveLength(1); expect(f.view.pending.value).toBeNull(); expect(f.view.rows.value.map((r: any) => r.id)).toEqual([2]);
    } finally { f.close(); }
  });
  it('keeps an uncommitted unknown result blocked until read-only verification and an explicit choice to use current state', async () => {
    const f = await mount(config => { if (config.method === 'delete') throw Error('Owned transport unknown'); });
    try { await f.view.change(f.view.rows.value[0], 'delete'); await f.view.recover(); expect(f.view.pending.value?.id).toBe(1); expect(f.view.ready.value).toBe(false);
      await f.view.load(); expect(writes(f)).toHaveLength(1); await f.press('按当前状态重新选择'); expect(f.view.pending.value).toBeNull(); expect(f.view.ready.value).toBe(true); }
    finally { f.close(); }
  });
  it('rejects malformed successful receipts and requires the original ID to be checked', async () => {
    const f = await mount(config => config.method === 'delete' ? { id: 2, operation: 'delete' } : undefined);
    try { await f.view.change(f.view.rows.value[0], 'delete'); expect(f.view.pending.value).toEqual({ id: 1, operation: 'delete' }); expect(runtime.dialogs.messages).toEqual([]); }
    finally { f.close(); }
  });
  it('blocks duplicate sends while confirmation or mutation is pending', async () => {
    const confirmation = gate(), delivery = gate(), f = await mount((config, fixture) => config.method === 'delete' ? delivery.promise.then(() => fixture.apply(config)) : undefined);
    runtime.dialogs.ElMessageBox.confirm = () => confirmation.promise;
    try { const pending = f.view.change(f.view.rows.value[0], 'delete'); await flush(); await f.view.change(f.view.rows.value[1], 'delete'); expect(writes(f)).toHaveLength(0);
      confirmation.resolve(); await flush(); await f.view.change(f.view.rows.value[1], 'delete'); expect(writes(f)).toHaveLength(1); delivery.resolve(); await pending; }
    finally { confirmation.resolve(); delivery.resolve(); f.close(); }
  });
  it('never sends a confirmation that completes after filters changed', async () => {
    const confirmation = gate(), f = await mount(); runtime.dialogs.ElMessageBox.confirm = () => confirmation.promise;
    try { const action = f.view.change(f.view.rows.value[0], 'delete'); await flush(); f.view.filters.store_name = 'different'; confirmation.resolve(); await action; expect(writes(f)).toEqual([]); }
    finally { confirmation.resolve(); f.close(); }
  });
  it.each(['route', 'session', 'silent-storage', 'permissions', 'aba'] as const)('invalidates stale %s confirmations without resurrecting old authority', async reason => {
    const confirmation = gate(), f = await mount(); runtime.dialogs.ElMessageBox.confirm = () => confirmation.promise;
    try { const action = f.view.change(f.view.rows.value[0], 'delete'); await flush();
      if (reason === 'route') await f.router.push('/products');
      else if (reason === 'permissions') { localStorage.setItem('supplier-permissions', '["supplier.product.view"]'); surface.dispatchEvent(new Event('supplier-session-changed')); }
      else { localStorage.setItem('supplier-token', 'owned-recycle-b'); if (reason !== 'silent-storage') surface.dispatchEvent(new Event('supplier-session-changed')); if (reason === 'aba') localStorage.setItem('supplier-token', 'owned-recycle-a'); }
      confirmation.resolve(); await action; expect(writes(f)).toEqual([]); expect(f.view.rows.value).toEqual([]); }
    finally { confirmation.resolve(); f.close(); }
  });
  it('keeps view-only accounts read-only even through direct handler calls', async () => {
    localStorage.setItem('supplier-permissions', '["supplier.product.view"]'); const f = await mount();
    try { expect(walk(f.host).filter(node => node.tag === 'button').map(text)).not.toContain('彻底删除'); await f.view.change(f.view.rows.value[0], 'delete'); expect(writes(f)).toEqual([]); }
    finally { f.close(); }
  });
  it('ignores an old read resolving after a newer keyword query', async () => {
    const wait = gate(); let held = false;
    const f = await mount(config => config.url === '/product/product/list' && config.params.store_name === '' && !held ? (held = true, wait.promise) : undefined);
    try { f.view.filters.store_name = '商品2'; const pending = f.view.load(); await pending; expect(f.view.rows.value.map((r: any) => r.id)).toEqual([2]);
      wait.resolve({ list: [product(1)], count: 1, page: 1, limit: 20 }); await flush(); expect(f.view.rows.value.map((r: any) => r.id)).toEqual([2]); }
    finally { wait.resolve({ list: [], count: 0, page: 1, limit: 20 }); f.close(); }
  });
  it('rejects inconsistent count or owner-state rows before enabling a destructive action', async () => {
    const f = await mount(config => config.url === '/product/product/list' ? { list: [product(1, 0)], count: 1, page: 1, limit: 20 } : undefined);
    try { expect(f.view.ready.value).toBe(false); expect(f.view.rows.value).toEqual([]); expect(writes(f)).toEqual([]); } finally { f.close(); }
  });
});
