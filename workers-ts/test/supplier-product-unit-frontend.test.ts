import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget, ownedDocument: any;
beforeAll(async () => {
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `import Form from './src/pages/ProductForm.vue';import Products from './src/pages/Products.vue';
    import Picker from './src/components/SupplierProductUnitPicker.vue';export {Form,Products};export const captured={};const pickerSetup=Picker.setup;Picker.setup=(p,c)=>{const v=pickerSetup(p,c);captured.picker=v;return v;};const setup=Form.setup;Form.setup=(p,c)=>{const v=setup(p,c);captured.view=v;return v;};
    const listSetup=Products.setup;Products.setup=(p,c)=>{const v=listSetup(p,c);captured.list=v;return v;};
    export * as units from './src/utils/productUnits';export * as unitApi from './src/api/productUnits';export {http} from './src/api/http';export {useAuthStore} from './src/stores/auth';export * as api from './src/api/productCopy';export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,provide,inject} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-copy-editor-with-transport', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        if (path.includes('/components/') && !path.endsWith('SupplierProductUnitPicker.vue')) return { contents: 'export default {render:()=>null}', loader: 'ts' };
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'owned-copy-editor', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'owned-copy-editor',
          compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialog', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const messages=[];
        export const ElMessage={success:m=>messages.push(m),error:m=>messages.push(m),warning:m=>messages.push(m)};
        export const ElMessageBox={confirm:async()=>{},prompt:async()=>({value:'owned'})};` }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}, 30000);
beforeEach(() => {
  const local = new Map<string, string>(), session = new Map<string, string>(); surface = new EventTarget(); vi.stubGlobal('window', surface); class OwnedDocument {activeElement=null};class OwnedShadowRoot{};vi.stubGlobal('Document',OwnedDocument);vi.stubGlobal('ShadowRoot',OwnedShadowRoot);ownedDocument=new OwnedDocument();vi.stubGlobal('document',ownedDocument);
  const storage = (map: Map<string, string>) => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v), removeItem: (k: string) => map.delete(k) });
  vi.stubGlobal('localStorage', storage(local)); vi.stubGlobal('sessionStorage', storage(session));
  localStorage.setItem('supplier-token', 'owned-copy-a'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":20}');
  localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage"]');
  pinia = runtime.createPinia(); runtime.dialogs.messages.length = 0;runtime.captured.picker=undefined;
});
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sku = (card = false) => ({ suk: '默认', detail: { 规格: '默认' }, image: '', price: '12.00', settle_price: '6.00', cost: '3.00',
  ot_price: '14.00', vip_price: '11.00', stock: card ? 0 : 8, bar_code: '', weight: '1.00', volume: '1.00', brokerage: '0.00', brokerage_two: '0.00', code: 'SOURCE', disk_info: '' });
const seed = (id = 80, type = 0) => ({ copy: { source_id: id, token: 'a'.repeat(64), destination: { type: 2, relation_id: 20 } }, product: {
  id: 0, product_type: type, store_name: '来源商品', store_info: '来源简介', keyword: '关键词', unit_name: '件', bar_code: '', cate_id: [1],
  slider_image: ['https://images.invalid/source.png'], description: '<p>来源说明</p>', spec_type: 0, items: [{ value: '规格', detail: ['默认'] }], attrs: [sku(type === 1)],
  retired_attrs: [], freight: 1, postage: '0.00', temp_id: 0, is_postage: 1, is_support_refund: 1, is_limit: 0, limit_type: 0, limit_num: 0,
  brand_id:[1,2],brand_selection:{brand_id:2,brand_com:'1,2',consistent:true,available:true},sort: 1, ficti: 9, video_link: '', is_show: 0, is_verify: 0, store_label_id: [4], media: { version: 1, previews: {} },
} });
const marker = () => ({ operation_id: '12345678-1234-4123-8123-123456789abc', actor_id: 21, supplier_id: 20, source_id: 80 });
const receipt = (pending: any, state = 'committed') => ({ ...pending, state, result: state === 'committed' ? { id: 100, is_show: 0, is_verify: 0 } : null });
const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(done => { resolve = done; }), resolve }; };
async function flush() { for (let i = 0; i < 40; i++) { await Promise.resolve(); await runtime.nextTick(); } }
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node };
const walk = (n: Node): Node[] => [n, ...n.children.flatMap(walk)];
const content = (n: Node): string => (n.text ?? '') + n.children.map(content).join('');
async function mount(url = '/products/80/edit', override: (config: any, fixture: any) => unknown = () => undefined) {
  const calls: any[] = [], fixture = { receipt: null as any, apply(config: any) {
    const body = JSON.parse(config.data); expect(JSON.parse(sessionStorage.getItem('supplier_product_copy_pending_v1:20:21')!).operation_id).toBe(body.operation_id);
    fixture.receipt = receipt({ ...marker(), operation_id: body.operation_id }); return fixture.receipt;
  } };
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); let value = await override(config, fixture);
    if (value === undefined) {
      if (config.url === '/product/get_all_unit') value=unitRows();
      else if (config.url === '/product/category/tree') value = [{ id: 1, cate_name: '本机分类' }];
      else if (config.url === '/product/product/list') value = { list: [{ id: 80, product_type: 0, store_name: '来源商品', image: '', price: '12.00', stock: 8, sales: 4, is_show: 1, is_verify: 1, add_time: 100 }], count: 1, page: 1, limit: 20 };
      else if (config.url === '/product/product/get_rule') value = [];
      else if (config.url.includes('/copy_operations/')) value = fixture.receipt ?? { ...marker(), operation_id: config.url.split('/')[4], source_id: null, state: 'unknown', result: null };
      else if (config.method === 'post') value = config.url.startsWith('/product/product/copy/')?fixture.apply(config):{id:config.url.endsWith('/80')?80:100,is_show:0,is_verify:0};
      else if (/^\/product\/product\/[0-9]+$/.test(config.url)) value = {...seed(80).product,id:Number(config.url.split('/').at(-1)),store_name:'原商品'+config.url.split('/').at(-1),auto_on_time:0,auto_off_time:0};
      else value = seed(Number(config.url.split('/').at(-1)));
    }
    return { config, data: { status: 200, msg: 'owned copy transport', data: value }, status: 200, statusText: 'owned', headers: {} };
  };
  const host: Node = { children: [], props: {} };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => ({ tag, tagName:tag.toUpperCase(),children: [], props: {},value:'',listeners:{},addEventListener(name:string,fn:any){(this.listeners as any)[name]??=[];(this.listeners as any)[name].push(fn)},removeEventListener(){},getRootNode(){return ownedDocument;}}), createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(n: Node, p: Node, anchor?: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); n.parent = p; const at = anchor ? p.children.indexOf(anchor) : -1; p.children.splice(at < 0 ? p.children.length : at, 0, n); },
    remove(n: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); }, parentNode: (n: Node) => n.parent,
    nextSibling: (n: Node) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, patchProp(n: Node, k: string, _: unknown, v: unknown) { n.props[k] = v; },
    setText(n: Node, v: string) { n.text = v; }, setElementText(n: Node, v: string) { n.text = v; n.children = []; } });
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/products/new', component: runtime.Form },
    { path: '/products/:id/edit', component: runtime.Form }, { path: '/products/copy-result', component: runtime.Form },
    { path: '/products/list-fixture', component: runtime.Products }, { path: '/products', component: { render: () => null } }] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  const tags = [...['pages/ProductForm', 'pages/Products','components/SupplierProductUnitPicker'].flatMap(page => [...readFileSync(resolve(root, `src/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const name of new Set(tags)) if (!['el-table', 'el-table-column'].includes(name)) app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(name === 'el-button' ? 'button' : name, attrs, slots.default?.()); } });
  app.component('el-table', { props: ['data'], setup(props: any, { slots }: any) { runtime.provide('owned-copy-table-rows', () => props.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('owned-copy-table-rows'); return () => runtime.h('column', { label: props.label }, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[props.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push(url); app.mount(host); await flush();
  return { get picker(){return runtime.captured.picker;},view: runtime.captured.view, list: runtime.captured.list, calls, fixture, host, router, close: () => app.unmount() };
}
const unitRows=()=>[{id:8,name:'箱'},{id:4,name:'件'},{id:3,name:'箱'}];
const catalogCall=(config:any)=>config.url==='/product/get_all_unit';
const writes=(f:any)=>f.calls.filter((c:any)=>c.method==='post'&&!c.url.endsWith('/resolve'));
const button=(f:any,label:string)=>walk(f.host).find(n=>n.tag==='button'&&content(n)===label)!;
const editor=(f:any)=>walk(f.host).find(n=>n.tag==='el-input'&&n.props['aria-label']==='计量单位')!;
function choose(f:any,value:unknown){const node=walk(f.host).find(n=>n.tag==='el-select'&&n.props['aria-label']==='计量单位目录')!;expect(node).toBeDefined();node.props['onUpdate:modelValue'](value);}
function fill(f:any,value:unknown){expect(editor(f)).toBeDefined();editor(f).props['onUpdate:modelValue'](value);}
const saved=(f:any)=>JSON.parse(writes(f)[0].data);
const detail=(unit='件',id=80)=>({...seed().product,id,unit_name:unit,store_name:'单位商品'+id});
const overrideDetail=(unit:string)=>(c:any)=>c.url==='/product/product/80'?detail(unit):undefined;

describe('actual Supplier unit directory and durable text author transport',()=>{
 it('reads the existing API in server order, collapses equal names and never posts a directory ID',async()=>{
  const f=await mount();try{expect(f.calls.filter(catalogCall)).toHaveLength(1);expect(f.picker.catalog.value).toEqual(unitRows());expect(f.picker.names.value).toEqual(['箱','件']);expect(f.view.form.unit_name).toBe('件');const before=JSON.parse(JSON.stringify(f.view.form.attrs));choose(f,'箱');await flush();expect(f.view.form.unit_name).toBe('箱');expect(writes(f)).toEqual([]);await f.view.submit();expect(writes(f)).toHaveLength(1);expect(saved(f).unit_name).toBe('箱');expect(saved(f).attrs.map((row:any)=>row.price)).toEqual(before.map((row:any)=>row.price));for(const key of ['unit_id','unitId','brand_id','ensure_id','auto_on_time'])expect(saved(f)).not.toHaveProperty(key);}finally{f.close();}
 });
 it.each(['历史自由单位','', 'a'.repeat(32)])('preserves ordinary unit text %j independently of catalogue membership',async unit=>{
  const f=await mount(undefined,overrideDetail(unit));try{expect(f.view.form.unit_name).toBe(unit);expect(f.picker.selected.value).toBe('');await f.view.submit();expect(saved(f).unit_name).toBe(unit);}finally{f.close();}
 });
 it.each(['袋',''])('manual text %j and explicit clear wait for the normal complete save',async unit=>{
  const f=await mount();try{fill(f,unit);await flush();expect(f.view.form.unit_name).toBe(unit);expect(writes(f)).toEqual([]);await f.view.submit();expect(saved(f).unit_name).toBe(unit);}finally{f.close();}
 });
 it('directory loading and its late response cannot replace a newer manual draft',async()=>{
  const wait=gate(),f=await mount(undefined,c=>catalogCall(c)?wait.promise:undefined);try{expect(f.picker.loading.value).toBe(true);expect(editor(f).props.disabled).toBe(false);fill(f,'手填袋');wait.resolve(unitRows());await flush();expect(f.view.form.unit_name).toBe('手填袋');expect(f.picker.names.value).toEqual(['箱','件']);await f.view.submit();expect(saved(f).unit_name).toBe('手填袋');}finally{wait.resolve(unitRows());f.close();}
 });
 it.each(['empty','failure'])('an %s directory never clears history or blocks normal save',async mode=>{
  const f=await mount(undefined,c=>{if(catalogCall(c)){if(mode==='failure')throw Error('Owned directory503');return [];}if(c.url==='/product/product/80')return detail('旧包装');});try{expect(f.view.form.unit_name).toBe('旧包装');expect(content(f.host)).toContain(mode==='empty'?'暂无可选单位':'仍可填写或保存当前单位');fill(f,'保留自由名');await f.view.submit();expect(saved(f).unit_name).toBe('保留自由名');}finally{f.close();}
 });
 it('a refresh removes retired choices without clearing or silently replacing the current name',async()=>{
  let rows=unitRows();const f=await mount(undefined,c=>catalogCall(c)?rows:undefined);try{choose(f,'箱');rows=[{id:4,name:'新目录'}];await button(f,'刷新单位目录').props.onClick();await flush();expect(f.picker.names.value).toEqual(['新目录']);expect(f.view.form.unit_name).toBe('箱');expect(f.picker.selected.value).toBe('');await f.view.submit();expect(saved(f).unit_name).toBe('箱');}finally{f.close();}
 });
 it('valid long legacy directory names remain visible but cannot author an unsaveable product unit',async()=>{
  const long='名'.repeat(50),f=await mount(undefined,c=>catalogCall(c)?[{id:9,name:long},...unitRows()]:undefined);try{expect(f.picker.catalog.value[0].name).toBe(long);const option=walk(f.host).find(n=>n.tag==='el-option'&&n.props.value===long)!;expect(option.props.disabled).toBe(true);expect(content(f.host)).toContain('超过32个字符');choose(f,long);expect(f.view.form.unit_name).toBe('件');choose(f,'箱');await f.view.submit();expect(saved(f).unit_name).toBe('箱');}finally{f.close();}
 });
 it.each([9,null,{},'a'.repeat(33)])('rejects a forged directory/text event %j without overwriting the draft',async value=>{
  const f=await mount();try{choose(f,value);fill(f,value);expect(f.view.form.unit_name).toBe('件');expect(writes(f)).toEqual([]);}finally{f.close();}
 });
 it('allows directory-assisted unit text in the existing safe copy protocol',async()=>{
  const f=await mount('/products/new?copy=80');try{expect(f.view.copyReady.value).toBe(true);choose(f,'箱');await f.view.submit();await flush();expect(writes(f)).toHaveLength(1);expect(writes(f)[0].url).toBe('/product/product/copy/80');expect(saved(f).product.unit_name).toBe('箱');expect(saved(f).product).not.toHaveProperty('unit_id');expect(saved(f).operation_id).toMatch(/^[0-9a-f-]{36}$/);expect(saved(f).copy_token).toBe('a'.repeat(64));}finally{f.close();}
 });
 it('read-only accounts can read the directory but cannot author via either visible control',async()=>{
  localStorage.setItem('supplier-permissions','["supplier.product.view"]');const f=await mount();try{expect(f.picker.names.value).toEqual(['箱','件']);expect(editor(f).props.disabled).toBe(true);choose(f,'箱');fill(f,'袋');await f.view.submit();expect(f.view.form.unit_name).toBe('件');expect(writes(f)).toEqual([]);}finally{f.close();}
 });
 it('rejects the first A catalogue after a route A→B→A without replacing the fresh draft or choices',async()=>{
  const wait=gate();let reads=0;const f=await mount(undefined,c=>catalogCall(c)?++reads===1?wait.promise:reads===2?[{id:12,name:'乙'}]:[{id:13,name:'新甲'}]:c.url==='/product/product/81'?detail('乙历史',81):c.url==='/product/product/80'?detail('甲历史'):undefined);try{await f.router.push('/products/81/edit');await flush();expect(f.view.form.unit_name).toBe('乙历史');await f.router.push('/products/80/edit');await flush();fill(f,'新手填');wait.resolve(unitRows());await flush();expect(f.picker.names.value).toEqual(['新甲']);expect(f.view.form.unit_name).toBe('新手填');expect(f.calls.find(catalogCall).signal.aborted).toBe(true);expect(writes(f)).toEqual([]);}finally{wait.resolve(unitRows());f.close();}
 });
 it('identity ABA permanently invalidates the old directory and cancels its late response',async()=>{
  const wait=gate(),f=await mount(undefined,c=>catalogCall(c)?wait.promise:undefined);try{localStorage.setItem('supplier-token','account-b');surface.dispatchEvent(new Event('supplier-session-changed'));localStorage.setItem('supplier-token','owned-copy-a');surface.dispatchEvent(new Event('supplier-session-changed'));wait.resolve(unitRows());await flush();expect(f.picker.invalid.value).toBe(true);expect(f.picker.catalog.value).toEqual([]);expect(editor(f).props.disabled).toBe(true);expect(f.view.form.store_name).toBe('');choose(f,'箱');fill(f,'袋');await f.picker.reload();await f.view.submit();expect(f.calls.filter(catalogCall)).toHaveLength(1);expect(writes(f)).toEqual([]);}finally{wait.resolve(unitRows());f.close();}
 });
 it.each(['route','session','unmount'])('cancels a queued catalogue before transport after %s invalidation',async mode=>{
  const wait=gate(),queued:any[]=[];const interceptor=runtime.http.interceptors.request.use(async(c:any)=>{if(catalogCall(c)&&!queued.length){queued.push(c);await wait.promise;}return c;});
  const f=await mount(undefined,c=>c.url==='/product/product/81'?detail('乙',81):undefined);let closed=false;try{expect(queued).toHaveLength(1);if(mode==='route')await f.router.push('/products/81/edit');else if(mode==='session'){localStorage.setItem('supplier-token','b');surface.dispatchEvent(new Event('supplier-session-changed'));}else{f.close();closed=true;}wait.resolve();await flush();expect(queued[0].signal.aborted).toBe(true);expect(f.calls.includes(queued[0])).toBe(false);expect(writes(f)).toEqual([]);}finally{wait.resolve();runtime.http.interceptors.request.eject(interceptor);if(!closed)f.close();}
 });
 it('an already aborted directory API call never dispatches a request',async()=>{
  const f=await mount();try{const before=f.calls.length,c=new AbortController();c.abort();await expect(runtime.unitApi.getSupplierProductUnits(c.signal)).rejects.toMatchObject({name:'AbortError'});expect(f.calls).toHaveLength(before);}finally{f.close();}
 });
});

describe('complete directory response contract',()=>{
 it('accepts the actual50-codepoint SQL boundary and safely retains markup as plain option text',()=>{
  const rows=[{id:2147483647,name:'😀'.repeat(50)},{id:2,name:'<b>箱</b>'}];expect(runtime.units.parseSupplierProductUnits(rows)).toEqual(rows);expect(runtime.units.parseSupplierProductUnits([])).toEqual([]);
 });
 it.each([null,{},[{id:'1',name:'箱'}],[{id:0,name:'箱'}],[{id:1,name:'箱'},{id:1,name:'件'}],[{id:1,name:''}],[{id:1,name:' 箱'}],[{id:1,name:'a'.repeat(51)}],[{id:1,name:'x\u0000y'}],[{id:1,name:'x\ud800'}],[{id:1,name:'箱',relation_id:8}]].map(value=>({value})))('refuses malformed complete directory %j instead of exposing a partial choice list',({value})=>{
  expect(()=>runtime.units.parseSupplierProductUnits(value)).toThrow(/目录资料无效/);
 });
});
