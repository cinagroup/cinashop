import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget;
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `import Form from './src/pages/OrderEdit.vue';
    export {Form};export const captured={};const setup=Form.setup;Form.setup=(p,c)=>{const v=setup(p,c);captured.view=v;return v;};
    export {http} from './src/api/http';export * as api from './src/api/orderEdit';export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-unpaid-order-editor', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'owned-unpaid-order', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'owned-unpaid-order', compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialogs', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const messages=[];export const ElMessage={success:m=>messages.push(m)};
        export const ElMessageBox={confirm:async()=>{},close:()=>{}};` }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}, 30000);
beforeEach(() => {
  const local = new Map<string, string>(), session = new Map<string, string>(); surface = new EventTarget(); vi.stubGlobal('window', surface);
  const storage = (map: Map<string, string>) => ({ getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value), removeItem: (key: string) => map.delete(key) });
  vi.stubGlobal('localStorage', storage(local)); vi.stubGlobal('sessionStorage', storage(session));
  localStorage.setItem('supplier-token', 'owned-order-edit-token'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":7}');
  localStorage.setItem('supplier-permissions', '["supplier.order.view","supplier.order.manage"]');
  pinia = runtime.createPinia(); runtime.dialogs.messages.length = 0;
});
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const key = 'supplier_order_edit_pending_v1:7:21';
const marker = () => ({ operation_id: '12345678-1234-4123-8123-123456789abc', actor_id: 21, supplier_id: 7, order_id: 80 });
const seed = (id = 80) => ({ title: '修改订单', method: 'PUT', action: `/order/update/${id}`, revision: 'a'.repeat(64),
  values: { order_id: 'wxOwned' + id, total_price: '100.00', total_postage: '5.00', pay_postage: '3.00', pay_price: '90.00', gain_integral: '20' } });
const receipt = (pending: any, state = 'committed') => ({ ...pending, state,
  result: state === 'committed' ? { id: pending.order_id, order_id: 'wxOwned' + pending.order_id, pay_price: '80.25', change_price: '22.75', gain_integral: '17.00', changed: true } : null });
const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(done => { resolve = done; }), resolve }; };
const flush = async () => { for (let i = 0; i < 40; i++) { await Promise.resolve(); await runtime.nextTick(); } };
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node };
const walk = (node: Node): Node[] => [node, ...node.children.flatMap(walk)];
const content = (node: Node): string => (node.text ?? '') + node.children.map(content).join('');
async function mount(url = '/orders/80/edit', override: (config: any, fixture: any) => unknown = () => undefined) {
  const calls: any[] = [], fixture = { receipt: null as any, apply(config: any) {
    const body = JSON.parse(config.data), pending = JSON.parse(sessionStorage.getItem(key)!);
    expect(Object.keys(pending).sort()).toEqual(['actor_id', 'operation_id', 'order_id', 'supplier_id']); expect(pending.operation_id).toBe(body.operation_id);
    fixture.receipt = receipt(pending);
    fixture.receipt.result.pay_price = Number(body.pay_price).toFixed(2); fixture.receipt.result.gain_integral = body.gain_integral + '.00';
    return fixture.receipt;
  } };
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); let value = await override(config, fixture);
    if (value === undefined) {
      if (config.url.startsWith('/order/edit/')) value = seed(Number(config.url.split('/').at(-1)));
      else if (config.method === 'put') value = fixture.apply(config);
      else if (config.url.startsWith('/order/edit_operations/')) {
        const pending = JSON.parse(sessionStorage.getItem(key)!);
        if (config.method === 'post' && !fixture.receipt) fixture.receipt = receipt(pending, 'not_applied');
        value = fixture.receipt ?? { ...pending, order_id: null, state: 'unknown', result: null };
      } else throw Error('Unexpected owned request ' + config.url);
    }
    return { config, data: { status: 200, data: value }, status: 200, statusText: 'owned local fixture', headers: {} };
  };
  const host: Node = { children: [], props: {} };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => ({ tag, children: [], props: {} }), createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(node: Node, parent: Node, anchor?: Node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); node.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, node); },
    remove(node: Node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); }, parentNode: (node: Node) => node.parent,
    nextSibling: (node: Node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null, patchProp(node: Node, property: string, _: unknown, value: unknown) { node.props[property] = value; },
    setText(node: Node, value: string) { node.text = value; }, setElementText(node: Node, value: string) { node.text = value; node.children = []; } });
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/orders/edit-result', component: runtime.Form },
    { path: '/orders/:id/edit', component: runtime.Form }, { path: '/orders', component: { render: () => null } }] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  for (const name of new Set([...readFileSync(resolve(root, 'src/pages/OrderEdit.vue'), 'utf8').matchAll(/<(el-[a-z-]+)/g)].map(match => match[1])))
    app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(name === 'el-button' ? 'button' : name, attrs, slots.default?.()); } });
  await router.push(url); app.mount(host); await flush(); return { view: runtime.captured.view, calls, fixture, host, router, close: () => app.unmount() };
}
const writes = (fixture: any) => fixture.calls.filter((call: any) => call.method === 'put');
describe('rendered unpaid order editor, actual Axios and persistent original-operation recovery', () => {
  it('renders the four immutable fields and submits only the PHP six fields plus exact operation and revision', async () => {
    const f = await mount(); try {
      expect(walk(f.host).filter(node => node.tag === 'el-input' && node.props.readonly !== undefined)).toHaveLength(4);
      f.view.payPrice.value = '80.25'; f.view.gainIntegral.value = '17';
      const button = walk(f.host).find(node => node.tag === 'button' && content(node) === '保存修改'); expect(button).toBeDefined(); await button!.props.onClick(); await flush();
      expect(writes(f)).toHaveLength(1); const body = JSON.parse(writes(f)[0].data);
      expect(Object.keys(body).sort()).toEqual(['gain_integral', 'operation_id', 'order_id', 'pay_postage', 'pay_price', 'revision', 'total_postage', 'total_price']);
      expect(body).toMatchObject({ order_id: 'wxOwned80', total_price: '100.00', total_postage: '5.00', pay_postage: '3.00', pay_price: '80.25', gain_integral: '17', revision: 'a'.repeat(64) });
      expect(sessionStorage.getItem(key)).toBeNull(); expect(f.router.currentRoute.value.path).toBe('/orders');
    } finally { f.close(); }
  });
  it('blocks a lost committed response and recovers the original result without another PUT', async () => {
    const f = await mount(undefined, (config, fixture) => { if (config.method === 'put') { fixture.apply(config); throw Error('owned postcommit response loss'); } });
    try { await f.view.save(); expect(writes(f)).toHaveLength(1); expect(content(f.host)).toContain('订单编辑结果待确认'); await f.view.save(); expect(writes(f)).toHaveLength(1);
      await f.view.recover(false); expect(writes(f)).toHaveLength(1); expect(f.view.pending.value).toBeNull(); expect(f.router.currentRoute.value.path).toBe('/orders');
    } finally { f.close(); }
  });
  it('restores the minimal pending operation across another order route and never automatically writes', async () => {
    sessionStorage.setItem(key, JSON.stringify(marker())); const f = await mount('/orders/81/edit');
    try { expect(f.view.pending.value.order_id).toBe(80); expect(f.view.source.value).toBeNull(); expect(f.calls).toEqual([]); await f.view.save(); expect(writes(f)).toEqual([]); }
    finally { f.close(); }
  });
  it('keeps receipt-only recovery available without any current management permission or seed fetch', async () => {
    localStorage.setItem('supplier-permissions', '[]'); sessionStorage.setItem(key, JSON.stringify(marker())); const f = await mount('/orders/edit-result');
    try { f.fixture.receipt = receipt(marker()); expect(f.calls).toEqual([]); await f.view.save(); expect(writes(f)).toEqual([]); await f.view.recover(false);
      expect(f.calls.map((call: any) => call.url)).toEqual(['/order/edit_operations/' + marker().operation_id]); expect(sessionStorage.getItem(key)).toBeNull();
    } finally { f.close(); }
  });
  it('does not load a seed or expose a save in an empty receipt-only entry', async () => {
    const f = await mount('/orders/edit-result'); try { expect(f.calls).toEqual([]);
      expect(walk(f.host).some(node => node.tag === 'el-alert' && node.props.title === '本窗口没有待确认的订单编辑操作')).toBe(true);
      await f.view.save(); expect(writes(f)).toEqual([]); }
    finally { f.close(); }
  });
  it('blocks malformed persisted identity instead of dropping the unknown operation', async () => {
    sessionStorage.setItem(key, JSON.stringify({ ...marker(), supplier_id: 8 })); const f = await mount();
    try { expect(f.view.storageError.value).toContain('记录无效'); await f.view.save(); expect(f.calls).toEqual([]); expect(sessionStorage.getItem(key)).not.toBeNull(); }
    finally { f.close(); }
  });
  it('performs no PUT when operation persistence fails', async () => {
    const f = await mount(); try { vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw Error('owned blocked storage'); }); await f.view.save();
      expect(writes(f)).toEqual([]); expect(f.view.storageError.value).toContain('blocked storage'); }
    finally { f.close(); }
  });
  it('does not dispatch a confirmed draft after its amount changes while confirmation is open', async () => {
    const dialog = gate(), f = await mount(); try { vi.spyOn(runtime.dialogs.ElMessageBox, 'confirm').mockImplementation(() => dialog.promise); const action = f.view.save();
      f.view.payPrice.value = '1.00'; dialog.resolve(); await action; expect(writes(f)).toEqual([]); }
    finally { dialog.resolve(); f.close(); }
  });
  it('rejects stale A-to-B-to-A reads and keeps the latest route form', async () => {
    const wait = gate(); let reads = 0; const f = await mount(undefined, config => config.url === '/order/edit/80' && ++reads === 1 ? wait.promise : undefined);
    try { await f.router.push('/orders/81/edit'); await flush(); await f.router.push('/orders/80/edit'); await flush(); wait.resolve({ ...seed(), values: { ...seed().values, pay_price: '1.00' } }); await flush();
      expect(f.view.payPrice.value).toBe('90.00'); expect(writes(f)).toEqual([]); }
    finally { wait.resolve(seed()); f.close(); }
  });
  it('invalidates writes and stale confirmations on session or permission A-to-B-to-A changes', async () => {
    const dialog = gate(), f = await mount(); try { vi.spyOn(runtime.dialogs.ElMessageBox, 'confirm').mockImplementation(() => dialog.promise); const action = f.view.save();
      localStorage.setItem('supplier-token', 'owned-B'); surface.dispatchEvent(new Event('supplier-session-changed'));
      localStorage.setItem('supplier-token', 'owned-order-edit-token'); surface.dispatchEvent(new Event('supplier-session-changed'));
      dialog.resolve(); await action; expect(writes(f)).toEqual([]); expect(f.view.source.value).toBeNull(); }
    finally { dialog.resolve(); f.close(); }
  });
  it.each(['actor_id', 'supplier_id', 'order_id', 'operation_id'])('retains pending state when receipt %s belongs to another operation', async field => {
    sessionStorage.setItem(key, JSON.stringify(marker())); const f = await mount('/orders/edit-result', config => config.method === 'get'
      ? { ...receipt(marker()), [field]: field === 'operation_id' ? crypto.randomUUID() : 999 } : undefined);
    try { await f.view.recover(false); expect(f.view.pending.value).not.toBeNull(); expect(sessionStorage.getItem(key)).not.toBeNull(); expect(writes(f)).toEqual([]); }
    finally { f.close(); }
  });
  it('keeps unknown GET blocked and only explicit resolution seals not-applied', async () => {
    sessionStorage.setItem(key, JSON.stringify(marker())); const f = await mount('/orders/edit-result');
    try { await f.view.recover(false); expect(f.view.pending.value).not.toBeNull(); await f.view.save(); expect(writes(f)).toEqual([]);
      await f.view.recover(true); expect(f.view.pending.value).toBeNull(); expect(f.calls.filter((call: any) => call.method === 'post')).toHaveLength(1); }
    finally { f.close(); }
  });
  it.each(['1.001', '-1', '1e3', 'NaN'])('rejects invalid financial input %s before persistence or PUT', async value => {
    const f = await mount(); try { f.view.payPrice.value = value; await f.view.save(); expect(writes(f)).toEqual([]); expect(sessionStorage.getItem(key)).toBeNull(); }
    finally { f.close(); }
  });
});
