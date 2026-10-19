import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/supplier-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget;
beforeAll(async () => {
  const output = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    import Page from './src/pages/Refunds.vue';
    export {Page}; export const captured={};const setup=Page.setup;Page.setup=(p,c)=>{const value=setup(p,c);captured.view=value;return value;};
    export {http} from './src/api/http';export * as api from './src/api/supplier';export * as session from './src/utils/supplierSession';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,provide,inject} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"', '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
  plugins: [{ name: 'actual-refund-application-evidence-sfc', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
      const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
      const script = compileScript(descriptor, { id: 'tracking', genDefaultAs: '__Page' });
      const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'tracking', compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
      if (template.errors.length) throw Error(String(template.errors));
      return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
    });
    builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'messages', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const ElMessage={success(){},warning(){},error(){}};export const ElMessageBox={close(){},confirm:async()=>{}};' }));
  } }], bundle: true, write: false, platform: 'browser', format: 'esm' });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}, 30000);
beforeEach(() => {
  const values = new Map<string, string>(); surface = new EventTarget();
  vi.stubGlobal('window', surface); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  localStorage.setItem('supplier-token', 'refund-application-a'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":7}');
  localStorage.setItem('supplier-permissions', '["supplier.refund.view","supplier.refund.manage"]'); pinia = runtime.createPinia();
});
afterEach(() => { runtime.disposePinia(pinia); vi.unstubAllGlobals(); });
const detail = (id = 25, changes = {}) => ({ id, store_order_id: id, refund_order_id: `R${id}`, order_id: `O${id}`, real_name: '本地客户', user_phone: '000000',
  is_cancel: 0, apply_type: 2, apply_price: '5.00', refund_type: 0, refund_num: 1, refund_price: '5.00', refunded_price: '0.00', refund_reason: '本地原因',
  refuse_reason: '', remark: '内部备注', add_time: 1700000000, refunded_time: 0, pay_type: 'yue', pay_price: '10.00', refund_explain: '申请说明',
  refund_express: '', refund_express_name: '', refund_phone: '', refund_goods_explain: '', returnImages: [], returnImagesError: '', cartInfo: null, orderInfo: null, ...changes });
const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(r => { resolve = r; }), resolve }; };
async function flush() { for (let i = 0; i < 45; i++) { await Promise.resolve(); await runtime.nextTick(); } }
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node };
function contents(n: Node): string { return [n.text ?? '', ...n.children.map(contents)].join(' '); }
function nodes(n: Node): Node[] { return [n, ...n.children.flatMap(nodes)]; }
async function mount(override: (config: any) => unknown = () => undefined) {
  const calls: any[] = [], host: Node = { children: [], props: {} };
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const id = Number(config.url.split('/').at(-1));
    const value = await override(config) ?? (config.url === '/refund/list' ? { list: [detail(), detail(32)], count: 2 }
      : config.url === '/refund/reason' ? ['本地原因'] : detail(id));
    return { config, data: { status: 200, data: value }, status: 200, statusText: 'owned', headers: {} };
  };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => ({ tag, children: [], props: {} }), createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(n: Node, p: Node, anchor?: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); n.parent = p; const at = anchor ? p.children.indexOf(anchor) : -1; p.children.splice(at < 0 ? p.children.length : at, 0, n); },
    remove(n: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); }, parentNode: (n: Node) => n.parent,
    nextSibling: (n: Node) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, patchProp(n: Node, key: string, _: unknown, value: unknown) { n.props[key] = value; },
    setText(n: Node, text: string) { n.text = text; }, setElementText(n: Node, text: string) { n.text = text; n.children = []; } });
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/refunds', component: runtime.Page }, { path: '/away', component: { render: () => null } }] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  const tags = [...['pages/Refunds','components/SupplierRefundApplicationReview','components/SupplierRefundApplicationEvidence'].flatMap(page => [...readFileSync(resolve(root, `src/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const tag of new Set(tags)) if (!['el-dialog', 'el-drawer', 'el-table', 'el-table-column'].includes(tag)) app.component(tag, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(tag, attrs, slots.default?.()); } });
  for (const tag of ['el-dialog', 'el-drawer']) app.component(tag, { props: ['modelValue'], setup(p: any, { slots, attrs }: any) { return () => p.modelValue ? runtime.h(tag, attrs, [slots.default?.(), slots.footer?.()]) : null; } });
  app.component('el-table', { props: ['data'], setup(p: any, { slots }: any) { runtime.provide('rows', () => p.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop'], setup(p: any, { slots }: any) { const rows = runtime.inject('rows'); return () => runtime.h('column', {}, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[p.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push('/refunds'); app.mount(host); await flush();
  return { get view() { return runtime.captured.view; }, calls, host, router, close: () => app.unmount() };
}

function visible(f: any) { return [contents(f.host), ...nodes(f.host).map(n => n.props.title ?? '')].join(' '); }
const signed = (id: number) => ({ url: `/api/assets/${id}`, src: `/api/assets/${id}?expires=1700001000&signature=${'a'.repeat(43)}` });
async function evidence(changes: Record<string, unknown> = {}) {
  const f = await mount(c => c.url.startsWith('/refund/detail/') ? detail(Number(c.url.split('/').at(-1)), { requestImages: [signed(31)], requestImagesError: '', ...changes }) : undefined);
  await f.view.openRefund({ id: 25 }); await flush(); return f;
}
it('renders original application and return evidence separately with safe full-size links', async () => {
  const f = await evidence({ returnImages: [signed(33)] });
  try {
    expect(visible(f)).toContain('申请凭证'); expect(visible(f)).toContain('退货凭证');
    const images = nodes(f.host).filter(n => n.tag === 'img');
    expect(images.map(n => n.props.src).sort()).toEqual([signed(31).src, signed(33).src].sort());
    const link = nodes(f.host).find(n => n.tag === 'a' && n.props['aria-label'] === '查看申请凭证 1')!;
    expect(link.props).toMatchObject({ href: signed(31).src, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' });
    expect(f.calls.every(c => c.method === 'get')).toBe(true);
  } finally { f.close(); }
});
it('shows explicit absence, unavailable and historical public-image states', async () => {
  for (const [changes, label] of [
    [{ requestImages: [] }, '用户未上传申请凭证'],
    [{ requestImages: [], requestImagesError: '申请凭证暂不可读取，请与用户核对' }, '申请凭证暂不可读取'],
    [{ requestImages: [{ url: 'https://legacy.invalid/old.png', src: 'https://legacy.invalid/old.png' }] }, '历史图片链接'],
  ] as const) {
    const f = await evidence(changes); try { expect(visible(f)).toContain(label); expect(f.view.current.value.id).toBe(25); }
    finally { f.close(); }
  }
});
it('an older server missing both fields remains readable with an explicit compatibility message', async () => {
  const f = await mount(c => c.url.startsWith('/refund/detail/') ? detail(25) : undefined);
  try { await f.view.openRefund({ id: 25 }); await flush(); expect(f.view.current.value.id).toBe(25); expect(visible(f)).toContain('接口尚未返回申请凭证信息'); }
  finally { f.close(); }
});
for (const [label, changes] of Object.entries({
  null: { requestImages: null }, undefined: { requestImages: undefined }, missingError: { requestImagesError: undefined },
  nullError: { requestImagesError: null }, longError: { requestImagesError: 'x'.repeat(256) },
  conflictingError: { requestImagesError: 'bad' }, duplicate: { requestImages: [signed(31), signed(31)] },
  tooMany: { requestImages: [31, 32, 33, 34].map(signed) }, unknownKey: { requestImages: [{ ...signed(31), private: 'discarding this would hide a malformed contract' }] },
  active: { requestImages: [{ url: 'javascript:alert(1)', src: 'javascript:alert(1)' }] },
  mismatched: { requestImages: [{ ...signed(31), src: signed(32).src }] },
  persistedSignature: { requestImages: [{ url: signed(31).src, src: signed(31).src }] },
  absolutePrivate: { requestImages: [{ url: 'https://legacy.invalid/api/assets/31', src: 'https://legacy.invalid/api/assets/31' }] },
  unsafeLegacy: { requestImages: [{ url: 'https://u:p@legacy.invalid/old.png', src: 'https://u:p@legacy.invalid/old.png' }] },
})) it(`rejects present malformed application evidence before binding any detail or actions: ${label}`, async () => {
  const f = await evidence(changes); try { expect(f.view.current.value).toBeNull(); expect(f.view.detailError.value).toBeTruthy(); expect(nodes(f.host).filter(n => n.tag === 'img')).toHaveLength(0); expect(f.calls.every(c => c.method === 'get')).toBe(true); }
  finally { f.close(); }
});
it('a broken original preview offers refresh and cannot change return evidence', async () => {
  const f = await evidence({ returnImages: [signed(33)] });
  try {
    const image = nodes(f.host).find(n => n.tag === 'img' && n.props.src === signed(31).src)!;
    image.props.onError(); await flush(); expect(visible(f)).toContain('申请凭证 1 读取失败');
    expect(nodes(f.host).some(n => n.tag === 'img' && n.props.src === signed(33).src)).toBe(true);
    await f.view.refreshCurrent(); await flush(); expect(visible(f)).not.toContain('申请凭证 1 读取失败');
    expect(nodes(f.host).some(n => n.tag === 'img' && n.props.src === signed(31).src)).toBe(true);
  } finally { f.close(); }
});
for (const ending of ['close', 'route', 'session', 'switch']) it(`never revives application images from a stale response after ${ending}`, async () => {
  const waiting = gate(); const f = await mount(c => c.url === '/refund/detail/32' ? waiting.promise : c.url.startsWith('/refund/detail/') ? detail(25, { requestImages: [signed(31)], requestImagesError: '' }) : undefined);
  try {
    await f.view.openRefund({ id: 25 }); await flush(); const pending = f.view.openRefund({ id: 32 }); await flush();
    expect(nodes(f.host).some(n => n.tag === 'img')).toBe(false);
    if (ending === 'close') f.view.drawerOpen.value = false;
    if (ending === 'route') await f.router.push('/away');
    if (ending === 'session') surface.dispatchEvent(new Event('supplier-session-changed'));
    if (ending === 'switch') await f.view.openRefund({ id: 25 });
    waiting.resolve(detail(32, { requestImages: [signed(32)], requestImagesError: '' })); await pending; await flush();
    expect(f.view.current.value?.id).not.toBe(32); expect(nodes(f.host).some(n => n.tag === 'img' && n.props.src === signed(32).src)).toBe(false);
  } finally { f.close(); }
});
