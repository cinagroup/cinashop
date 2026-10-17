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
    import Picker from './src/components/SupplierProductBrandPicker.vue';export {Form,Products};export const captured={};const pickerSetup=Picker.setup;Picker.setup=(p,c)=>{const v=pickerSetup(p,c);captured.picker=v;return v;};const setup=Form.setup;Form.setup=(p,c)=>{const v=setup(p,c);captured.view=v;return v;};
    const listSetup=Products.setup;Products.setup=(p,c)=>{const v=listSetup(p,c);captured.list=v;return v;};
    export * as brands from './src/utils/productBrands';export * as brandApi from './src/api/productBrands';export {http} from './src/api/http';export {useAuthStore} from './src/stores/auth';export * as api from './src/api/productCopy';export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,provide,inject} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-copy-editor-with-transport', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        if (path.includes('/components/') && !path.endsWith('SupplierProductBrandPicker.vue')) return { contents: 'export default {render:()=>null}', loader: 'ts' };
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
      if (config.url === '/product/brand/cascader_list/2') value=tree();
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
  const tags = [...['pages/ProductForm', 'pages/Products','components/SupplierProductBrandPicker'].flatMap(page => [...readFileSync(resolve(root, `src/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const name of new Set(tags)) if (!['el-table', 'el-table-column'].includes(name)) app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(name === 'el-button' ? 'button' : name, attrs, slots.default?.()); } });
  app.component('el-table', { props: ['data'], setup(props: any, { slots }: any) { runtime.provide('owned-copy-table-rows', () => props.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('owned-copy-table-rows'); return () => runtime.h('column', { label: props.label }, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[props.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push(url); app.mount(host); await flush();
  return { get picker(){return runtime.captured.picker;},view: runtime.captured.view, list: runtime.captured.list, calls, fixture, host, router, close: () => app.unmount() };
}
const tree=()=>[{value:1,label:'品牌甲',pid:0,children:[{value:2,label:'系列乙',pid:1,children:[{value:3,label:'型号丙',pid:2}]}]},{value:4,label:'品牌丁',pid:0}];
const detail=(path:number[]=[1,2])=>({...seed().product,id:80,brand_id:path,brand_selection:{brand_id:path.at(-1)??0,brand_com:path.join(','),consistent:true,available:true}});
const writes=(f:any)=>f.calls.filter((call:any)=>call.method==='post'&&!call.url.endsWith('/resolve'));
const button=(f:any,label:string)=>walk(f.host).find(node=>node.tag==='button'&&content(node)===label)!;
function choose(f:any,path:unknown){const node=walk(f.host).find(item=>item.tag==='el-cascader'&&item.props['aria-label']==='商品品牌')!;expect(node).toBeDefined();node.props['onUpdate:modelValue'](path);}
const catalogCall=(config:any)=>config.url==='/product/brand/cascader_list/2';
const overrideDetail=(value:any)=>(c:any)=>c.url==='/product/product/80'?value:undefined;
describe('actual Supplier ordinary brand picker and editor transport',()=>{
 it('loads and refreshes the original complete brand path without an automatic write or replacement',async()=>{
  const f=await mount();try{expect(f.view.selectedBrandPath.value).toEqual([1,2]);expect(f.picker.catalog.value).toEqual(tree());expect(f.view.brandChanged.value).toBe(false);await button(f,'刷新品牌').props.onClick();await flush();expect(f.view.selectedBrandPath.value).toEqual([1,2]);expect(f.view.brandChanged.value).toBe(false);await button(f,'保存并提交审核').props.onClick();await flush();expect(writes(f)).toHaveLength(1);const body=JSON.parse(writes(f)[0].data);expect(body).not.toHaveProperty('brand_id');expect(body).not.toHaveProperty('brand_selection');expect(body).not.toHaveProperty('auto_on_time');expect(body).not.toHaveProperty('auto_off_time');expect(body).not.toHaveProperty('store_label_id');}finally{f.close();}
 });
 it.each([[1],[1,2],[1,2,3],[4]])('selects the complete root-to-node path %j using rendered cascader controls',async(...args: number[])=>{
  const path=args as number[];const f=await mount();try{choose(f,path);await flush();expect(f.view.brandChanged.value).toBe(true);await button(f,'保存并提交审核').props.onClick();await flush();expect(writes(f)).toHaveLength(1);expect(JSON.parse(writes(f)[0].data).brand_id).toEqual(path);expect(JSON.parse(writes(f)[0].data)).not.toHaveProperty('brand_selection');}finally{f.close();}
 });
 it('explicit clear is a real empty path and does not copy raw metadata or unrelated hidden bindings',async()=>{
  const f=await mount();try{await button(f,'清空品牌选择').props.onClick();await flush();expect(f.view.selectedBrandPath.value).toEqual([]);await button(f,'保存并提交审核').props.onClick();await flush();const body=JSON.parse(writes(f)[0].data);expect(body.brand_id).toEqual([]);for(const key of ['brand_selection','brand_com','auto_on_time','auto_off_time','store_label_id','ensure_id','label_id'])expect(body).not.toHaveProperty(key);}finally{f.close();}
 });
 it('creates an ordinary new product with a deliberately selected brand',async()=>{
  const f=await mount('/products/new');try{Object.assign(f.view.form,{store_name:'品牌新商品',cate_id:[1],slider_image:['/owned-media/new.png'],attrs:[sku()]});choose(f,[1,2,3]);await flush();await button(f,'保存并提交审核').props.onClick();await flush();expect(writes(f)).toHaveLength(1);expect(writes(f)[0].url).toBe('/product/product');expect(JSON.parse(writes(f)[0].data)).toMatchObject({brand_id:[1,2,3],store_name:'品牌新商品'});}finally{f.close();}
 });
 it.each(['preserve','clear'])('catalog failure permits deliberate %s without silently resetting existing brands',async mode=>{
  const f=await mount(undefined,c=>{if(catalogCall(c))throw Error('Owned catalog read unavailable');});try{expect(f.picker.failed.value).toBe(true);expect(f.view.selectedBrandPath.value).toEqual([1,2]);if(mode==='clear')await button(f,'清空品牌选择').props.onClick();await button(f,'保存并提交审核').props.onClick();await flush();expect(writes(f)).toHaveLength(1);if(mode==='clear')expect(JSON.parse(writes(f)[0].data).brand_id).toEqual([]);else expect(JSON.parse(writes(f)[0].data)).not.toHaveProperty('brand_id');}finally{f.close();}
 });
 it('a selected brand disappearing on manual refresh blocks replacement until reselected or explicitly cleared',async()=>{
  let rows=tree();const f=await mount(undefined,c=>catalogCall(c)?rows:undefined);try{choose(f,[1,2,3]);await flush();rows=[tree()[1]!]as any;await button(f,'刷新品牌').props.onClick();await flush();expect(f.view.selectedBrandPath.value).toEqual([1,2,3]);await button(f,'保存并提交审核').props.onClick();await flush();expect(writes(f)).toEqual([]);await button(f,'清空品牌选择').props.onClick();await button(f,'保存并提交审核').props.onClick();await flush();expect(JSON.parse(writes(f)[0].data).brand_id).toEqual([]);}finally{f.close();}
 });
 it.each(['hidden','malformed','inconsistent'])('shows an unavailable historical %s binding while allowing preserve and explicit repair',async mode=>{
  const original={...detail(mode==='malformed'?[]:[1,2]),brand_selection:{brand_id:2,brand_com:mode==='malformed'?'1,,2':'1,2',consistent:mode==='hidden',available:false}};
  const f=await mount(undefined,overrideDetail(original));try{expect(f.view.productReadReady.value).toBe(true);expect(content(f.host)).toContain('暂不可选');expect(content(f.host)).toContain('#2');expect(f.view.brandChanged.value).toBe(false);choose(f,[4]);await flush();await button(f,'保存并提交审核').props.onClick();await flush();expect(JSON.parse(writes(f)[0].data).brand_id).toEqual([4]);}finally{f.close();}
 });
 it('older product DTOs omit brand replacement until the user explicitly selects one',async()=>{
  const value={...seed().product,id:80}as any;delete value.brand_id;delete value.brand_selection;const f=await mount(undefined,overrideDetail(value));try{expect(f.view.brandSelection.value).toBe(null);await button(f,'保存并提交审核').props.onClick();await flush();expect(JSON.parse(writes(f)[0].data)).not.toHaveProperty('brand_id');}finally{f.close();}
 });
 it.each([
  ['missing path',{brand_id:undefined}],['missing metadata',{brand_selection:undefined}],['bad path',{brand_id:[1,'2']}],
  ['extra metadata',{brand_selection:{brand_id:2,brand_com:'1,2',consistent:true,available:true,secret:1}}],
  ['false consistency',{brand_selection:{brand_id:4,brand_com:'1,2',consistent:true,available:true}}],
 ] as const)('malformed stored brand DTO (%s) cannot become an ordinary replacement save',async(_name,value)=>{
  const f=await mount(undefined,overrideDetail({...detail(),...value}));try{expect(f.view.productReadReady.value).toBe(false);expect(button(f,'保存并提交审核').props.disabled).toBe(true);await f.view.submit();expect(writes(f)).toEqual([]);expect(content(f.host)).toContain('重新读取商品资料');}finally{f.close();}
 });
 it('copy retains source brands through its mature protocol and offers no ignored brand author controls',async()=>{
  const f=await mount('/products/new?copy=80');try{expect(content(f.host)).toContain('复制保留来源的品牌');expect(walk(f.host).some(n=>n.tag==='el-cascader'&&n.props['aria-label']==='商品品牌')).toBe(false);expect(f.calls.filter(catalogCall)).toEqual([]);await button(f,'保存并提交审核').props.onClick();await flush();expect(writes(f)).toHaveLength(1);const body=JSON.parse(writes(f)[0].data);expect(body.product).not.toHaveProperty('brand_id');expect(body.product).not.toHaveProperty('brand_selection');}finally{f.close();}
 });
 it('reader can inspect the original binding but cannot emit selection changes or save',async()=>{
  localStorage.setItem('supplier-permissions','["supplier.product.view"]');const f=await mount();try{expect(f.view.selectedBrandPath.value).toEqual([1,2]);choose(f,[4]);await f.picker.clear();await f.view.submit();expect(f.view.selectedBrandPath.value).toEqual([1,2]);expect(f.view.brandChanged.value).toBe(false);expect(writes(f)).toEqual([]);}finally{f.close();}
 });
 it('a late catalog for a different product cannot erase the new product selection or tree',async()=>{
  const wait=gate();let reads=0;const f=await mount(undefined,c=>catalogCall(c)?++reads===1?wait.promise:[tree()[1]]:c.url==='/product/product/81'?{...detail([4]),id:81,store_name:'另一个品牌商品'}:undefined);try{await f.router.push('/products/81/edit');await flush();expect(f.view.selectedBrandPath.value).toEqual([4]);expect(f.picker.catalog.value).toEqual([tree()[1]]);wait.resolve(tree());await flush();expect(f.view.selectedBrandPath.value).toEqual([4]);expect(f.picker.catalog.value).toEqual([tree()[1]]);expect(f.calls.find(catalogCall).signal.aborted).toBe(true);}finally{wait.resolve(tree());f.close();}
 });
 it('real storage account ABA permanently clears the picker and prevents late catalog reinsertion',async()=>{
  const wait=gate();const f=await mount(undefined,c=>catalogCall(c)?wait.promise:undefined);try{localStorage.setItem('supplier-token','brand-account-b');surface.dispatchEvent(new Event('supplier-session-changed'));localStorage.setItem('supplier-token','owned-copy-a');surface.dispatchEvent(new Event('supplier-session-changed'));wait.resolve(tree());await flush();expect(f.picker.catalog.value).toEqual([]);expect(f.view.selectedBrandPath.value).toEqual([]);expect(f.view.form.store_name).toBe('');expect(f.picker.invalid.value).toBe(true);await f.picker.reload();await f.view.submit();expect(f.calls.filter(catalogCall)).toHaveLength(1);expect(writes(f)).toEqual([]);}finally{wait.resolve(tree());f.close();}
 });
 it.each(['route','session','unmount'])('cancels a queued catalog GET before transport after %s invalidation',async mode=>{
  const wait=gate(),queued:any[]=[];const interceptor=runtime.http.interceptors.request.use(async(c:any)=>{if(catalogCall(c)&&!queued.length){queued.push(c);await wait.promise;}return c;});
  const f=await mount(undefined,c=>c.url==='/product/product/81'?{...detail([4]),id:81}:undefined);let closed=false;
  try{expect(queued).toHaveLength(1);expect(f.calls.filter(catalogCall)).toEqual([]);if(mode==='route')await f.router.push('/products/81/edit');else if(mode==='session'){localStorage.setItem('supplier-token','catalog-account-b');surface.dispatchEvent(new Event('supplier-session-changed'));localStorage.setItem('supplier-token','owned-copy-a');surface.dispatchEvent(new Event('supplier-session-changed'));}else{f.close();closed=true;}await flush();expect(queued[0].signal.aborted).toBe(true);wait.resolve();await flush();expect(f.calls.filter(catalogCall)).toHaveLength(mode==='route'?1:0);if(mode==='route')expect(f.view.selectedBrandPath.value).toEqual([4]);else if(!closed)expect(f.picker.catalog.value).toEqual([]);
  }finally{wait.resolve();runtime.http.interceptors.request.eject(interceptor);if(!closed)f.close();}
 });
 it('a Pinia permission loss clears catalog and does not resurrect it when permission is restored',async()=>{
  const f=await mount();try{const auth=runtime.useAuthStore(pinia);auth.permissions=['supplier.product.view'];await flush();expect(f.picker.catalog.value).toEqual([]);choose(f,[4]);await f.view.submit();expect(writes(f)).toEqual([]);auth.permissions=['supplier.product.view','supplier.product.manage'];await flush();await f.picker.reload();choose(f,[4]);expect(f.picker.invalid.value).toBe(true);expect(f.view.brandChanged.value).toBe(false);expect(writes(f)).toEqual([]);}finally{f.close();}
 });
 it.each(['route','session','unmount'])('cancels a queued brand replacement POST before transport after %s invalidation',async mode=>{
  const f=await mount(),wait=gate();const interceptor=runtime.http.interceptors.request.use(async(c:any)=>{if(c.method==='post')await wait.promise;return c;});try{choose(f,[4]);await flush();const saving=button(f,'保存并提交审核').props.onClick();await flush();expect(writes(f)).toEqual([]);if(mode==='route')await f.router.push('/products/81/edit');else if(mode==='session'){localStorage.setItem('supplier-token','new-account');surface.dispatchEvent(new Event('supplier-session-changed'));}else f.close();wait.resolve();await saving;await flush();expect(writes(f)).toEqual([]);}finally{wait.resolve();runtime.http.interceptors.request.eject(interceptor);f.close();}
 });
});
describe('bounded frontend brand catalog and path contract',()=>{
 it('retains both roots and descendants, accepts ancestor selection, and reaches exact1000 node boundary',()=>{
  expect(runtime.brands.parseSupplierProductBrandCatalog(tree())).toEqual(tree());expect(runtime.brands.productBrandAvailable(tree(),[1])).toBe(true);expect(runtime.brands.productBrandAvailable(tree(),[1,2,3])).toBe(true);expect(runtime.brands.productBrandAvailable(tree(),[2])).toBe(false);
  expect(runtime.brands.parseSupplierProductBrandCatalog(Array.from({length:1000},(_,i)=>({value:i+1,label:'品牌'+i,pid:0})))).toHaveLength(1000);
 });
 it.each([
  ['not array',{}],['synthetic root0',[{value:0,label:'根',pid:0}]],['string id',[{value:'1',label:'品牌',pid:0}]],
  ['wrong parent',[{value:1,label:'品牌',pid:2}]],['empty label',[{value:1,label:'',pid:0}]],['unknown keys',[{value:1,label:'品牌',pid:0,secret:true}]],
  ['duplicate id',[{value:1,label:'甲',pid:0},{value:1,label:'乙',pid:0}]],['bad child',[{value:1,label:'甲',pid:0,children:[{value:2,label:'乙',pid:0}]}]],
  ['too many',Array.from({length:1001},(_,i)=>({value:i+1,label:'品牌'+i,pid:0}))],
 ] as const)('rejects malformed catalog %s without silently dropping or flattening nodes',(_name,value)=>{expect(()=>runtime.brands.parseSupplierProductBrandCatalog(value)).toThrow();});
 it('bounds depth and CSV storage independently instead of truncating a selected path',()=>{
  let nodes:any[]=[];for(let i=17;i>=1;i--)nodes=[{value:i,label:'品牌'+i,pid:i-1,...(nodes.length?{children:nodes}:{})}];expect(()=>runtime.brands.parseSupplierProductBrandCatalog(nodes)).toThrow();
  expect(()=>runtime.brands.productBrandPath(Array.from({length:7},(_,i)=>2147483647-i))).toThrow();expect(runtime.brands.productBrandPayload([],false)).toEqual({});expect(runtime.brands.productBrandPayload([],true)).toEqual({brand_id:[]});
 });
 it.each([null,'1,2',[0],[-1],[1,1],[1,'2'],[2147483648]])('rejects a malformed submitted path %j',value=>{expect(()=>runtime.brands.productBrandPath(value)).toThrow();});
});
