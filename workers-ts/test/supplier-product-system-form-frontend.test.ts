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
    import Picker from './src/components/SupplierProductSystemFormPicker.vue';export {Form,Products};export const captured={};const pickerSetup=Picker.setup;Picker.setup=(p,c)=>{const v=pickerSetup(p,c);captured.picker=v;return v;};const setup=Form.setup;Form.setup=(p,c)=>{const v=setup(p,c);captured.view=v;return v;};
    const listSetup=Products.setup;Products.setup=(p,c)=>{const v=listSetup(p,c);captured.list=v;return v;};
    export * as forms from './src/utils/productSystemForms';export * as formApi from './src/api/productSystemForms';export {http} from './src/api/http';export {useAuthStore} from './src/stores/auth';export * as api from './src/api/productCopy';export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,provide,inject} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-copy-editor-with-transport', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        if (path.includes('/components/') && !path.endsWith('SupplierProductSystemFormPicker.vue')) return { contents: 'export default {render:()=>null}', loader: 'ts' };
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
  system_form_id:71,system_form_selection:{system_form_id:71,available:true},ensure_id:[41],ensure_selection:{ensure_id:'41',consistent:true,available:true,retained_ids:[],truncated:false},brand_id:[1,2],brand_selection:{brand_id:2,brand_com:'1,2',consistent:true,available:true},sort: 1, ficti: 9, video_link: '', is_show: 0, is_verify: 0, store_label_id: [4], media: { version: 1, previews: {} },
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
      if (config.url === '/form/all_system_form') value=options();
      else if (/^\/form\/info\/[0-9]+$/.test(config.url)) value=info(Number(config.url.split('/').at(-1)));
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
  const tags = [...['pages/ProductForm', 'pages/Products','components/SupplierProductSystemFormPicker'].flatMap(page => [...readFileSync(resolve(root, `src/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const name of new Set(tags)) if (!['el-table', 'el-table-column'].includes(name)) app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(name === 'el-button' ? 'button' : name, attrs, slots.default?.()); } });
  app.component('el-table', { props: ['data'], setup(props: any, { slots }: any) { runtime.provide('owned-copy-table-rows', () => props.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('owned-copy-table-rows'); return () => runtime.h('column', { label: props.label }, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[props.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push(url); app.mount(host); await flush();
  return { get picker(){return runtime.captured.picker;},view: runtime.captured.view, list: runtime.captured.list, calls, fixture, host, router, close: () => app.unmount() };
}
const options=()=>[{id:71,name:'原留言模板'},{id:201,name:'配送留言'},{id:202,name:'联系留言'}];
const components=(title='收货备注')=>[{id:'note',name:'texts',titleConfig:{value:title},titleShow:{val:true}},{id:'contact',name:'times',titleConfig:{value:'联系时间'},titleShow:{val:false}}];
const info=(id=71,value:unknown=components())=>({info:{id,version:1,name:options().find(r=>r.id===id)?.name??'留言模板',cover_image:'',value,default_value:'',status:1,is_del:0,update_time:0,add_time:0}});
const detail=(id=71,available=true)=>({...seed().product,id:80,system_form_id:Math.max(0,id),system_form_selection:{system_form_id:id,available}});
const writes=(f:any)=>f.calls.filter((c:any)=>c.method==='post'&&!c.url.endsWith('/resolve'));
const button=(f:any,label:string)=>walk(f.host).find(n=>n.tag==='button'&&content(n)===label)!;
const catalogCall=(c:any)=>c.url==='/form/all_system_form';
const previewCall=(c:any)=>/^\/form\/info\/[0-9]+$/.test(c.url);
const overrideDetail=(value:any)=>(c:any)=>c.url==='/product/product/80'?value:undefined;
function choose(f:any,id:unknown){walk(f.host).find(n=>n.tag==='el-select'&&n.props['aria-label']==='自定义留言模板')!.props['onUpdate:modelValue'](id);}
function toggle(f:any,value:boolean){walk(f.host).find(n=>n.tag==='el-checkbox'&&content(n)==='启用自定义留言')!.props['onUpdate:modelValue'](value);}
describe('actual Supplier system-form author and transport',()=>{
 it('reads the current definition, previews only field title/type/required and omits untouched binding metadata',async()=>{
  const f=await mount();try{expect(f.view.selectedSystemFormId.value).toBe(71);expect(f.picker.preview.value.fields).toEqual([{title:'收货备注',type:'文本框',required:true},{title:'联系时间',type:'时间',required:false}]);expect(content(f.host)).toContain('收货备注');await f.view.submit();await flush();const b=JSON.parse(writes(f)[0].data);expect(b).not.toHaveProperty('system_form_id');expect(b).not.toHaveProperty('system_form_selection');expect(b).not.toHaveProperty('custom_form');}finally{f.close();}
 });
 it('chooses another template, waits for its actual preview and sends only the explicit numeric ID',async()=>{
  const f=await mount();try{choose(f,201);await flush();expect(f.picker.preview.value.id).toBe(201);expect(f.view.systemFormChanged.value).toBe(true);await f.view.submit();await flush();const b=JSON.parse(writes(f)[0].data);expect(b.system_form_id).toBe(201);expect(b).not.toHaveProperty('system_form_selection');expect(b).not.toHaveProperty('custom_form');}finally{f.close();}
 });
 it('requires a chosen template after enabling an empty binding, then creates through the real new form',async()=>{
  const f=await mount('/products/new');try{Object.assign(f.view.form,{...seed().product,id:0});toggle(f,true);await flush();expect(f.picker.enabled.value).toBe(true);expect(f.view.systemFormChanged.value).toBe(true);await f.view.submit();expect(writes(f)).toEqual([]);choose(f,201);await flush();await f.view.submit();await flush();expect(writes(f)[0].url).toBe('/product/product');expect(JSON.parse(writes(f)[0].data).system_form_id).toBe(201);}finally{f.close();}
 });
 it('turns off a historical binding and sends0 without relying on a working catalog',async()=>{
  const f=await mount(undefined,c=>catalogCall(c)?Promise.reject(Error('目录暂不可用')):undefined);try{expect(f.picker.failed.value).toBe(true);toggle(f,false);await flush();expect(f.picker.preview.value).toBe(null);await f.view.submit();await flush();expect(JSON.parse(writes(f)[0].data).system_form_id).toBe(0);}finally{f.close();}
 });
 it('allows an unrelated save after catalog or preview failure when the old binding is untouched',async()=>{
  const f=await mount(undefined,c=>catalogCall(c)||previewCall(c)?Promise.reject(Error('读取失败')):undefined);try{await f.view.submit();await flush();expect(JSON.parse(writes(f)[0].data)).not.toHaveProperty('system_form_id');}finally{f.close();}
 });
 it('retains an unavailable negative historical ID as metadata and permits explicit repair to0',async()=>{
  const f=await mount(undefined,overrideDetail(detail(-7,false)));try{expect(f.view.selectedSystemFormId.value).toBe(0);expect(content(f.host)).toContain('原留言模板 #-7');expect(content(f.host)).not.toContain('关闭自定义留言');toggle(f,true);await flush();expect(content(f.host)).toContain('关闭自定义留言');toggle(f,false);await flush();await f.view.submit();await flush();expect(JSON.parse(writes(f)[0].data).system_form_id).toBe(0);}finally{f.close();}
 });
 it('does not save a positive selection while its strict preview is pending',async()=>{
  const wait=gate();const f=await mount(undefined,c=>c.url==='/form/info/201'?wait.promise:undefined);try{choose(f,201);await flush();await f.view.submit();expect(writes(f)).toEqual([]);wait.resolve(info(201));await flush();await f.view.submit();await flush();expect(JSON.parse(writes(f)[0].data).system_form_id).toBe(201);}finally{wait.resolve(info(201));f.close();}
 });
 it.each(['empty','bad-type','disabled','wrong-id']as const)('rejects malformed or unavailable selected preview %s before POST',async mode=>{
  const bad=info(201);if(mode==='empty')bad.info.value=[];else if(mode==='bad-type')bad.info.value=[{...components()[0],name:'script'}];else if(mode==='disabled')bad.info.status=0;else bad.info.id=202;
  const f=await mount(undefined,c=>c.url==='/form/info/201'?bad:undefined);try{choose(f,201);await flush();expect(f.picker.previewFailed.value).toBe(true);await f.view.submit();expect(writes(f)).toEqual([]);toggle(f,false);await flush();await f.view.submit();await flush();expect(JSON.parse(writes(f)[0].data).system_form_id).toBe(0);}finally{f.close();}
 });
 it('a catalog refresh retains author intent, but a removed template needs a new selection or explicit close',async()=>{
  let catalog=options();const f=await mount(undefined,c=>catalogCall(c)?catalog:undefined);try{choose(f,201);await flush();catalog=options().filter(x=>x.id!==201);await button(f,'刷新留言模板').props.onClick();await flush();expect(f.view.selectedSystemFormId.value).toBe(201);await f.view.submit();expect(writes(f)).toEqual([]);toggle(f,false);await flush();await f.view.submit();await flush();expect(JSON.parse(writes(f)[0].data).system_form_id).toBe(0);}finally{f.close();}
 });
 it('late earlier previews cannot overwrite the current selected definition',async()=>{
  const wait=gate();const f=await mount(undefined,c=>c.url==='/form/info/201'?wait.promise:undefined);try{choose(f,201);await flush();choose(f,202);await flush();expect(f.picker.preview.value.id).toBe(202);wait.resolve(info(201,components('过期字段')));await flush();expect(f.calls.find((c:any)=>c.url==='/form/info/201').signal.aborted).toBe(true);expect(f.picker.preview.value.id).toBe(202);expect(content(f.host)).not.toContain('过期字段');}finally{wait.resolve(info(201));f.close();}
 });
 it('closing while a preview is in flight cannot restore that definition or enabled state',async()=>{
  const wait=gate();const f=await mount(undefined,c=>c.url==='/form/info/201'?wait.promise:undefined);try{choose(f,201);await flush();toggle(f,false);await flush();wait.resolve(info(201));await flush();expect(f.picker.preview.value).toBe(null);expect(f.picker.enabled.value).toBe(false);expect(f.view.selectedSystemFormId.value).toBe(0);}finally{wait.resolve(info(201));f.close();}
 });
 it('keeps copy authoring hidden, retains inherited source configuration and strips any editor metadata',async()=>{
  const f=await mount('/products/new?copy=80');try{expect(f.picker).toBeUndefined();expect(f.calls.filter(catalogCall)).toEqual([]);expect(content(f.host)).toContain('复制保留来源的留言模板');await f.view.submit();await flush();const body=JSON.parse(writes(f)[0].data);expect(body.product).not.toHaveProperty('system_form_id');expect(body.product).not.toHaveProperty('system_form_selection');}finally{f.close();}
 });
 it('never gives a read-only user template authoring or save authority',async()=>{
  localStorage.setItem('supplier-permissions','["supplier.product.view"]');const f=await mount();try{toggle(f,false);choose(f,201);await flush();await f.view.submit();expect(f.view.selectedSystemFormId.value).toBe(71);expect(writes(f)).toEqual([]);}finally{f.close();}
 });
 it('storage account ABA clears the old draft and permanently cancels pending template reads',async()=>{
  const wait=gate();const f=await mount(undefined,c=>c.url==='/form/info/71'?wait.promise:undefined);try{localStorage.setItem('supplier-token','form-next');surface.dispatchEvent(new Event('supplier-session-changed'));localStorage.setItem('supplier-token','owned-copy-a');surface.dispatchEvent(new Event('supplier-session-changed'));wait.resolve(info(71));await flush();expect(f.view.selectedSystemFormId.value).toBe(0);expect(f.view.form.store_name).toBe('');expect(f.picker.preview.value).toBe(null);expect(f.picker.invalid.value).toBe(true);await f.view.submit();expect(writes(f)).toEqual([]);}finally{wait.resolve(info(71));f.close();}
 });
 it.each(['manage','view','identity']as const)('cancels queued POST across in-memory %s ABA and cannot revive an old form',async mode=>{
  const f=await mount(),wait=gate(),queued:any[]=[];const interceptor=runtime.http.interceptors.request.use(async(c:any)=>{if(c.method==='post'){queued.push(c);await wait.promise;}return c;});try{choose(f,201);await flush();const save=f.view.submit();await flush();expect(queued).toHaveLength(1);const auth=runtime.useAuthStore(pinia),permissions=[...auth.permissions],user={...auth.user};if(mode==='identity')auth.user={...user,id:22};else auth.permissions=mode==='manage'?['supplier.product.view']:['supplier.product.manage'];auth.user=user;auth.permissions=permissions;expect(queued[0].signal.aborted).toBe(true);wait.resolve();await save;await flush();expect(writes(f)).toEqual([]);expect(f.view.selectedSystemFormId.value).toBe(0);expect(f.picker.invalid.value).toBe(true);}finally{wait.resolve();runtime.http.interceptors.request.eject(interceptor);f.close();}
 });
 it.each(['route','session','unmount']as const)('cancels queued catalog GET before transport on %s invalidation',async mode=>{
  const wait=gate(),queued:any[]=[];const interceptor=runtime.http.interceptors.request.use(async(c:any)=>{if(catalogCall(c)&&!queued.length){queued.push(c);await wait.promise;}return c;});const f=await mount();let closed=false;try{expect(queued).toHaveLength(1);if(mode==='route')await f.router.push('/products/81/edit');else if(mode==='session'){localStorage.setItem('supplier-token','another-form-user');surface.dispatchEvent(new Event('supplier-session-changed'));}else{f.close();closed=true;}await flush();expect(queued[0].signal.aborted).toBe(true);wait.resolve();await flush();expect(f.calls.filter(catalogCall)).toHaveLength(mode==='route'?1:0);}finally{wait.resolve();runtime.http.interceptors.request.eject(interceptor);if(!closed)f.close();}
 });
});
describe('system-form directory, binding and actual shared order template contracts',()=>{
 it('accepts a bounded500-entry directory and labels its possible truncation in the actual component',async()=>{
  const many=Array.from({length:500},(_,i)=>({id:i+1,name:'模板'+i}));expect(runtime.forms.parseSupplierProductSystemFormCatalog(many)).toHaveLength(500);const f=await mount(undefined,c=>catalogCall(c)?many:undefined);try{expect(content(f.host)).toContain('目录最多显示500项');}finally{f.close();}
 });
 it.each([null,{},[{id:0,name:'模板'}],[{id:'1',name:'模板'}],[{id:1,name:'模板',extra:1}],[{id:1,name:'模板'},{id:1,name:'重复'}],[{id:1,name:''}],Array.from({length:501},(_,i)=>({id:i+1,name:'模板'}))])('rejects an invalid complete directory %#',value=>{expect(()=>runtime.forms.parseSupplierProductSystemFormCatalog(value)).toThrow();});
 it.each(['1',null,true,-1,-0,1.5,2147483648])('rejects a noncanonical client ID %s',value=>{expect(()=>runtime.forms.productSystemFormPayload(value,true)).toThrow();});
 it('omits an unchanged selection and accepts only complete raw-ID metadata for current and negative history',()=>{
  expect(runtime.forms.productSystemFormPayload(71,false)).toEqual({});expect(runtime.forms.productSystemFormPayload(0,true)).toEqual({system_form_id:0});expect(runtime.forms.productSystemFormDetail()).toEqual({id:0,selection:null});expect(runtime.forms.productSystemFormDetail({system_form_id:0,system_form_selection:{system_form_id:-3,available:false}}).selection.system_form_id).toBe(-3);
 });
 it.each([{system_form_id:'1'},{system_form_id:1},{system_form_id:1,system_form_selection:{system_form_id:2,available:true}},{system_form_id:0,system_form_selection:{system_form_id:-1,available:true}},{system_form_id:1,system_form_selection:{system_form_id:1,available:true,extra:1}}])('rejects inconsistent or partial binding metadata %#',value=>{expect(()=>runtime.forms.productSystemFormDetail(value)).toThrow();});
 it('uses the actual shared order parser, preserves100 fields and exposes no defaults or customer values',()=>{
  const value=Array.from({length:100},(_,i)=>({id:'f'+i,name:'texts',titleConfig:{value:'字段'+i},titleShow:{val:i===0},value:'不应展示的默认答案'}));const p=runtime.forms.parseSupplierProductSystemFormInfo(info(201,value),201);expect(p.fields).toHaveLength(100);expect(Object.keys(p.fields[0]).sort()).toEqual(['required','title','type']);expect(JSON.stringify(p)).not.toContain('不应展示的默认答案');
 });
 it.each([[],[{id:'bad',name:'script'}],Array.from({length:101},(_,i)=>({id:i,name:'texts'})),[{id:1,name:'texts'},{id:1,name:'texts'}]].map(value=>({value})))('rejects invalid order template structure %#',({value})=>{expect(()=>runtime.forms.parseSupplierProductSystemFormInfo(info(201,value),201)).toThrow();});
});
