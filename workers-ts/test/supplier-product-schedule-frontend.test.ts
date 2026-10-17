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
    export {Form,Products};export const captured={};const setup=Form.setup;Form.setup=(p,c)=>{const v=setup(p,c);captured.view=v;return v;};
    const listSetup=Products.setup;Products.setup=(p,c)=>{const v=listSetup(p,c);captured.list=v;return v;};
    export {http} from './src/api/http';export {useAuthStore} from './src/stores/auth';export * as api from './src/api/productCopy';export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,provide,inject} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-copy-editor-with-transport', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        if (path.includes('/components/')) return { contents: 'export default {render:()=>null}', loader: 'ts' };
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
  pinia = runtime.createPinia(); runtime.dialogs.messages.length = 0;
});
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sku = (card = false) => ({ suk: '默认', detail: { 规格: '默认' }, image: '', price: '12.00', settle_price: '6.00', cost: '3.00',
  ot_price: '14.00', vip_price: '11.00', stock: card ? 0 : 8, bar_code: '', weight: '1.00', volume: '1.00', brokerage: '0.00', brokerage_two: '0.00', code: 'SOURCE', disk_info: '' });
const seed = (id = 80, type = 0) => ({ copy: { source_id: id, token: 'a'.repeat(64), destination: { type: 2, relation_id: 20 } }, product: {
  id: 0, product_type: type, store_name: '来源商品', store_info: '来源简介', keyword: '关键词', unit_name: '件', bar_code: '', cate_id: [1],
  slider_image: ['https://images.invalid/source.png'], description: '<p>来源说明</p>', spec_type: 0, items: [{ value: '规格', detail: ['默认'] }], attrs: [sku(type === 1)],
  retired_attrs: [], freight: 1, postage: '0.00', temp_id: 0, is_postage: 1, is_support_refund: 1, is_limit: 0, limit_type: 0, limit_num: 0,
  sort: 1, ficti: 9, video_link: '', is_show: 0, is_verify: 0, store_label_id: [4], media: { version: 1, previews: {} },
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
      if (config.url === '/product/category') value = [{ id: 1, cate_name: '本机分类' }];
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
  const tags = [...['ProductForm', 'Products'].flatMap(page => [...readFileSync(resolve(root, `src/pages/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const name of new Set(tags)) if (!['el-table', 'el-table-column'].includes(name)) app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(name === 'el-button' ? 'button' : name, attrs, slots.default?.()); } });
  app.component('el-table', { props: ['data'], setup(props: any, { slots }: any) { runtime.provide('owned-copy-table-rows', () => props.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('owned-copy-table-rows'); return () => runtime.h('column', { label: props.label }, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[props.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push(url); app.mount(host); await flush();
  return { view: runtime.captured.view, list: runtime.captured.list, calls, fixture, host, router, close: () => app.unmount() };
}
const writes = (f: any) => f.calls.filter((c: any) => c.method === 'post' && !c.url.endsWith('/resolve'));
const saveButton = (f:any) => walk(f.host).find(n=>n.tag==='button'&&content(n)==='保存并提交审核')!;
function check(f:any,label:string,value:boolean){const node=walk(f.host).find(n=>n.tag==='el-checkbox'&&content(n)===label)!;expect(node).toBeDefined();node.props['onUpdate:modelValue'](value);node.props.onChange(value);}
function input(f:any,label:string,value:string){const n=walk(f.host).find(n=>n.tag==='input'&&n.props['aria-label']===label)as any;expect(n).toBeDefined();n.value=value;for(const fn of n.listeners.input??[])fn({target:n});n.props.onInput({target:n});}
const onLabel='定时上架时间（北京时间）',offLabel='定时下架时间（北京时间）';
const scheduledDetail=(on=1793499330,off=1793589600)=>({...seed().product,id:80,store_name:'原定时商品',auto_on_time:on,auto_off_time:off});
const detailOverride=(on=1793499330,off=1793589600)=>(config:any)=>config.url==='/product/product/80'?scheduledDetail(on,off):undefined;
describe('actual Supplier product schedule authoring and guarded save',()=>{
 it('reads stored epochs as Shanghai wall times and sends no schedule replacement when unchanged',async()=>{
  const f=await mount(undefined,detailOverride());try{expect(content(f.host)).toContain('定时上下架');expect(f.view.schedule.onTime).toBe('2026-11-01T10:15:30');expect(f.view.schedule.offTime).toBe('2026-11-02T11:20:00');expect(writes(f)).toEqual([]);
   await saveButton(f).props.onClick();await flush();expect(writes(f)).toHaveLength(1);const body=JSON.parse(writes(f)[0].data);expect(body).not.toHaveProperty('auto_on_time');expect(body).not.toHaveProperty('auto_off_time');expect(body.store_name).toBe('原定时商品');
  }finally{f.close();}
 });
 it('creates both plans through rendered controls using exact numeric seconds without replacing approval',async()=>{
  const f=await mount('/products/new');try{Object.assign(f.view.form,{store_name:'新定时商品',cate_id:[1],slider_image:['/owned-media/new.png'],attrs:[sku()]});
   check(f,'启用定时上架',true);check(f,'启用定时下架',true);await flush();input(f,onLabel,'2026-11-01T10:15:30');input(f,offLabel,'2026-11-02T11:20:00');await flush();expect(writes(f)).toEqual([]);
   await saveButton(f).props.onClick();await flush();expect(writes(f)).toHaveLength(1);expect(JSON.parse(writes(f)[0].data)).toMatchObject({auto_on_time:1793499330,auto_off_time:1793589600});expect(JSON.parse(writes(f)[0].data)).not.toHaveProperty('is_verify');
  }finally{f.close();}
 });
 it('explicitly cancels one plan while preserving the other exact stored time',async()=>{
  const f=await mount(undefined,detailOverride());try{check(f,'启用定时上架',false);await flush();expect(walk(f.host).some(n=>n.props['aria-label']===onLabel)).toBe(false);await saveButton(f).props.onClick();await flush();expect(JSON.parse(writes(f)[0].data)).toMatchObject({auto_on_time:0});expect(JSON.parse(writes(f)[0].data)).not.toHaveProperty('auto_off_time');}finally{f.close();}
 });
 it('can clear both schedules and accepts equal or past valid plans without adding an invented24hour rule',async()=>{
  for(const mode of ['clear','equal','past']){const f=await mount(undefined,detailOverride());try{
   if(mode==='clear'){check(f,'启用定时上架',false);check(f,'启用定时下架',false);}else{input(f,onLabel,'2020-01-01T08:00:00');input(f,offLabel,mode==='equal'?'2020-01-01T08:00:00':'2019-12-31T08:00:00');}
   await saveButton(f).props.onClick();await flush();expect(writes(f)).toHaveLength(1);expect(JSON.parse(writes(f)[0].data)).toMatchObject(mode==='clear'?{auto_on_time:0,auto_off_time:0}:{auto_on_time:1577836800,auto_off_time:mode==='equal'?1577836800:1577750400});
  }finally{f.close();}}
 });
 it.each(['','2026-02-30T09:00','2026-11-01','2026-11-01T24:00','2026-11-01T10:60','2026-11-01T10:00:60','2038-01-19T11:14:08','1969-12-31T23:00','2026-11-01T10:00Z'])('rejects malformed or out-of-range authoring without a POST: %s',async(value)=>{
  const f=await mount(undefined,detailOverride());try{f.view.schedule.onTime=value;f.view.scheduleChanged();await saveButton(f).props.onClick();await flush();expect(writes(f)).toEqual([]);expect(runtime.dialogs.messages.length).toBeGreaterThan(0);}finally{f.close();}
 });
 it('accepts the final int4 second and never uses browser-local Date parsing',async()=>{
  const f=await mount(undefined,detailOverride());try{input(f,onLabel,'2038-01-19T11:14:07');await saveButton(f).props.onClick();await flush();expect(JSON.parse(writes(f)[0].data).auto_on_time).toBe(2147483647);}finally{f.close();}
 });
 it('preserves the older no-plan DTO when no explicit schedule edit is made',async()=>{
  const f=await mount(undefined,c=>c.url==='/product/product/80'?{...seed().product,id:80}:undefined);try{await saveButton(f).props.onClick();await flush();expect(writes(f)).toHaveLength(1);expect(JSON.parse(writes(f)[0].data)).not.toHaveProperty('auto_on_time');}finally{f.close();}
 });
 it.each([{auto_on_time:1},{auto_on_time:'1',auto_off_time:0},{auto_on_time:-1,auto_off_time:0},{auto_on_time:0,auto_off_time:2147483648}])('blocks saving an incomplete or invalid stored schedule: %j',async(value)=>{
  const f=await mount(undefined,c=>c.url==='/product/product/80'?{...seed().product,id:80,...value}:undefined);try{expect(f.view.productReadReady.value).toBe(false);expect(saveButton(f).props.disabled).toBe(true);await f.view.submit();expect(writes(f)).toEqual([]);expect(content(f.host)).toContain('重新读取商品资料');}finally{f.close();}
 });
 it('failed product loading cannot turn an edit into an empty replacement, and explicit reread restores authoring',async()=>{
  let fail=true;const f=await mount(undefined,c=>{if(c.url==='/product/product/80'){if(fail)throw Error('owned read failed');return scheduledDetail();}});try{Object.assign(f.view.form,{store_name:'不可写入',cate_id:[1],slider_image:['/owned-media/new.png']});await f.view.submit();expect(writes(f)).toEqual([]);fail=false;await walk(f.host).find(n=>n.tag==='button'&&content(n)==='重新读取商品资料')!.props.onClick();await flush();expect(f.view.productReadReady.value).toBe(true);expect(f.view.form.store_name).toBe('原定时商品');}finally{f.close();}
 });
 it.each(['/products/abc/edit','/products/0/edit','/products/-1/edit','/products/01/edit','/products/2147483648/edit'])('invalid edit route never falls back to new scheduled product: %s',async(url)=>{
  const f=await mount(url);try{expect(f.calls).toEqual([]);expect(f.view.productReadReady.value).toBe(false);await f.view.submit();expect(writes(f)).toEqual([]);}finally{f.close();}
 });
 it('preserves the copy contract and provides no schedule controls whose edits would be discarded',async()=>{
  const f=await mount('/products/new?copy=80');try{expect(content(f.host)).toContain('复制保留来源的上下架计划');expect(walk(f.host).some(n=>content(n)==='启用定时上架')).toBe(false);await saveButton(f).props.onClick();await flush();expect(writes(f)).toHaveLength(1);const body=JSON.parse(writes(f)[0].data);expect(body.product).not.toHaveProperty('auto_on_time');expect(body.product).not.toHaveProperty('auto_off_time');}finally{f.close();}
 });
 it.each(['route','session','unmount'])('cancels a queued real Axios save before transport after %s invalidation',async(mode)=>{
  const f=await mount(undefined,detailOverride()),wait=gate();const interceptor=runtime.http.interceptors.request.use(async(c:any)=>{if(c.method==='post')await wait.promise;return c;});try{
   input(f,onLabel,'2026-11-01T10:15:00');const saving=saveButton(f).props.onClick();await flush();expect(writes(f)).toEqual([]);
   if(mode==='route')await f.router.push('/products/81/edit');else if(mode==='session'){localStorage.setItem('supplier-token','different-real-session');surface.dispatchEvent(new Event('supplier-session-changed'));}else f.close();await flush();wait.resolve();await saving;await flush();expect(writes(f)).toEqual([]);
  }finally{wait.resolve();runtime.http.interceptors.request.eject(interceptor);f.close();}
 });
 it('a late product read after a route change cannot replace the new product schedule',async()=>{
  const wait=gate();const f=await mount(undefined,c=>c.url==='/product/product/80'?wait.promise:c.url==='/product/product/81'?{...scheduledDetail(0,0),id:81,store_name:'新路由商品'}:undefined);try{await f.router.push('/products/81/edit');await flush();expect(f.view.form.store_name).toBe('新路由商品');wait.resolve(scheduledDetail());await flush();expect(f.view.form.store_name).toBe('新路由商品');expect(f.view.schedule.onEnabled).toBe(false);expect(writes(f)).toEqual([]);}finally{wait.resolve(scheduledDetail());f.close();}
 });
});
