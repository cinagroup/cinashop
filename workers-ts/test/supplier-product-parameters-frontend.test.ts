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
    import Picker from './src/components/SupplierProductParameterEditor.vue';export {Form,Products};export const captured={};const pickerSetup=Picker.setup;Picker.setup=(p,c)=>{const v=pickerSetup(p,c);captured.picker=v;return v;};const setup=Form.setup;Form.setup=(p,c)=>{const v=setup(p,c);captured.view=v;return v;};
    const listSetup=Products.setup;Products.setup=(p,c)=>{const v=listSetup(p,c);captured.list=v;return v;};
    export * as parameters from './src/utils/productParameters';export * as parameterApi from './src/api/productParameters';export {http} from './src/api/http';export {useAuthStore} from './src/stores/auth';export * as api from './src/api/productCopy';export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,provide,inject} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-copy-editor-with-transport', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        if (path.includes('/components/') && !path.endsWith('SupplierProductParameterEditor.vue')) return { contents: 'export default {render:()=>null}', loader: 'ts' };
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
  specs_id:51,specs:originalRows(),specs_selection:{specs_id:51,specs:JSON.stringify(originalRows()),consistent:true,available:true,truncated:false},ensure_id:[41],ensure_selection:{ensure_id:'41',consistent:true,available:true,retained_ids:[],truncated:false},brand_id:[1,2],brand_selection:{brand_id:2,brand_com:'1,2',consistent:true,available:true},sort: 1, ficti: 9, video_link: '', is_show: 0, is_verify: 0, store_label_id: [4], media: { version: 1, previews: {} },
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
      if (config.url === '/product/all_specs') value=options();
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
  const tags = [...['pages/ProductForm', 'pages/Products','components/SupplierProductParameterEditor'].flatMap(page => [...readFileSync(resolve(root, `src/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const name of new Set(tags)) if (!['el-table', 'el-table-column'].includes(name)) app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(name === 'el-button' ? 'button' : name, attrs, slots.default?.()); } });
  app.component('el-table', { props: ['data'], setup(props: any, { slots }: any) { runtime.provide('owned-copy-table-rows', () => props.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('owned-copy-table-rows'); return () => runtime.h('column', { label: props.label }, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[props.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push(url); app.mount(host); await flush();
  return { get picker(){return runtime.captured.picker;},view: runtime.captured.view, list: runtime.captured.list, calls, fixture, host, router, close: () => app.unmount() };
}
const row=(name='原材质',value='原棉',sort=0,id=0,temp_id=0)=>({id,temp_id,name,value,sort});
const originalRows=()=>[row('原材质','原棉',2,51,51)];
const child=(id:number,temp_id:number,type=0,relation_id=0)=>({id,temp_id,type,relation_id,name:'参数'+id,value:'初值'+id,sort:0,status:1,add_time:0});
const options=()=>[{id:51,name:'原有模板',specs:[child(51,51,2,20)]},{id:201,name:'平台参数',specs:[child(2011,201),child(2012,201)]},{id:202,name:'本店参数',specs:[child(2021,202,2,20)]}];
const detail=(specs_id=51,specs=originalRows())=>({...seed().product,id:80,specs_id,specs,specs_selection:{specs_id,specs:JSON.stringify(specs),consistent:true,available:true,truncated:false}});
const writes=(f:any)=>f.calls.filter((c:any)=>c.method==='post'&&!c.url.endsWith('/resolve'));
const button=(f:any,label:string)=>walk(f.host).find(n=>n.tag==='button'&&content(n)===label)!;
const catalogCall=(c:any)=>c.url==='/product/all_specs';
const overrideDetail=(value:any)=>(c:any)=>c.url==='/product/product/80'?value:undefined;
const templateNode=(f:any)=>walk(f.host).find(n=>n.tag==='el-select'&&n.props['aria-label']==='参数模板')!;
function select(f:any,id:unknown){templateNode(f).props['onUpdate:modelValue'](id);}
function edit(f:any,name:string,value:unknown){const node=walk(f.host).find(n=>n.props['aria-label']===name)!;expect(node).toBeDefined();node.props['onUpdate:modelValue'](value);}
describe('actual Supplier parameter editor and ordinary form transport',()=>{
 it('reads actual snapshot and refreshes templates without automatically posting hidden fields',async()=>{
  const f=await mount();try{expect(f.view.parameterDraft.value).toEqual({specs_id:51,specs:originalRows()});await button(f,'刷新参数模板').props.onClick();await flush();expect(f.view.parametersChanged.value).toBe(false);await f.view.submit();await flush();const body=JSON.parse(writes(f)[0].data);for(const key of ['specs_id','specs','specs_selection','brand_id','ensure_id','auto_on_time','auto_off_time','store_label_id'])expect(body).not.toHaveProperty(key);}finally{f.close();}
 });
 it.each([201,202])('selects template %s and posts only its five-field parameter projection',async id=>{
  const f=await mount();try{select(f,id);await flush();expect(f.view.parametersChanged.value).toBe(true);await f.view.submit();await flush();const body=JSON.parse(writes(f)[0].data);expect(body.specs_id).toBe(id);expect(body.specs).toEqual(options().find(x=>x.id===id)!.specs.map(({id,temp_id,name,value,sort})=>({id,temp_id,name,value,sort})));expect(body).not.toHaveProperty('specs_selection');for(const r of body.specs)expect(Object.keys(r)).toEqual(['id','temp_id','name','value','sort']);}finally{f.close();}
 });
 it('renames, adds, deletes and keeps duplicate names with negative sort through the real component handlers',async()=>{
  const f=await mount();try{select(f,201);await flush();edit(f,'参数名称 1','自由名称');await flush();edit(f,'参数值 1',' 自由值 ');await flush();edit(f,'参数排序 1',-9);await flush();await button(f,'添加参数').props.onClick();await flush();edit(f,'参数名称 3','自由名称');await flush();edit(f,'参数值 3','另一值');await flush();edit(f,'参数排序 3',7);await flush();const remove=walk(f.host).find(n=>n.props['aria-label']==='删除参数 2')!;remove.props.onClick();await flush();expect(f.view.parameterDraft.value.specs).toEqual([row('自由名称',' 自由值 ',-9,2011,201),row('自由名称','另一值',7)]);await f.view.submit();await flush();expect(JSON.parse(writes(f)[0].data).specs).toEqual([row('自由名称',' 自由值 ',-9,2011,201),row('自由名称','另一值',7)]);}finally{f.close();}
 });
 it.each(['button','selector'])('clears only template via %s and preserves editable nonempty parameters',async mode=>{
  const f=await mount();try{if(mode==='button')await button(f,'清除模板选择').props.onClick();else select(f,undefined);await flush();expect(f.view.parameterDraft.value).toEqual({specs_id:0,specs:originalRows()});await f.view.submit();await flush();expect(JSON.parse(writes(f)[0].data)).toMatchObject({specs_id:0,specs:originalRows()});}finally{f.close();}
 });
 it('clear-all sends both zero and empty array and preserves other authors by omission',async()=>{
  const f=await mount();try{await button(f,'清空全部参数').props.onClick();await flush();await f.view.submit();await flush();const body=JSON.parse(writes(f)[0].data);expect(body).toMatchObject({specs_id:0,specs:[]});for(const key of ['specs_selection','brand_id','ensure_id','auto_on_time','auto_off_time','label_id'])expect(body).not.toHaveProperty(key);}finally{f.close();}
 });
 it('creates a new ordinary product with custom template-free parameters',async()=>{
  const f=await mount('/products/new');try{Object.assign(f.view.form,{store_name:'参数新商品',cate_id:[1],slider_image:['/owned-media/new.png'],attrs:[sku()]});await button(f,'添加参数').props.onClick();await flush();edit(f,'参数名称 1',' 自填名称 ');await flush();edit(f,'参数值 1','自填值');await flush();edit(f,'参数排序 1',-2147483648);await flush();await f.view.submit();await flush();expect(writes(f)).toHaveLength(1);expect(writes(f)[0].url).toBe('/product/product');expect(JSON.parse(writes(f)[0].data)).toMatchObject({specs_id:0,specs:[row(' 自填名称 ','自填值',-2147483648)]});}finally{f.close();}
 });
 it.each(['preserve','clear','detach'])('catalog failure permits deliberate %s while keeping persisted text',async mode=>{
  const f=await mount(undefined,c=>{if(catalogCall(c))throw Error('Owned parameter catalog unavailable');});try{expect(f.picker.failed.value).toBe(true);expect(f.view.parameterDraft.value.specs).toEqual(originalRows());if(mode==='clear')await button(f,'清空全部参数').props.onClick();if(mode==='detach')await button(f,'清除模板选择').props.onClick();await f.view.submit();await flush();expect(writes(f)).toHaveLength(1);const body=JSON.parse(writes(f)[0].data);if(mode==='preserve')expect(body).not.toHaveProperty('specs_id');else expect(body).toMatchObject({specs_id:0,specs:mode==='clear'?[]:originalRows()});}finally{f.close();}
 });
 it('refresh never erases a draft; a disappeared chosen template must be detached or replaced before saving',async()=>{
  let catalog=options();const f=await mount(undefined,c=>catalogCall(c)?catalog:undefined);try{select(f,201);await flush();edit(f,'参数名称 1','模板外的新名称');await flush();catalog=[];await button(f,'刷新参数模板').props.onClick();await flush();expect(f.view.parameterDraft.value.specs[0].name).toBe('模板外的新名称');await f.view.submit();expect(writes(f)).toEqual([]);await button(f,'清除模板选择').props.onClick();await f.view.submit();await flush();expect(JSON.parse(writes(f)[0].data).specs_id).toBe(0);}finally{f.close();}
 });
 it.each(['empty','zero','long'])('blocks incomplete or invalid parameter %s before any POST',async mode=>{
  const f=await mount();try{edit(f,'参数值 1',mode==='empty'?'   ':mode==='zero'?'0':'字'.repeat(256));await flush();await f.view.submit();expect(writes(f)).toEqual([]);}finally{f.close();}
 });
 it.each(['name','value']as const)('rejects a lone surrogate in actual parameter %s edits before any POST',async key=>{
  const f=await mount();try{const invalid=key==='name'?'\ud800':'\udfff';edit(f,key==='name'?'参数名称 1':'参数值 1',invalid);await flush();expect(f.view.parameterDraft.value.specs[0][key]).toBe(invalid);await f.view.submit();await flush();expect(writes(f)).toEqual([]);}finally{f.close();}
 });
 it('blank new row remains editable, cannot silently disappear, and can be explicitly removed if not first',async()=>{
  const f=await mount();try{await button(f,'添加参数').props.onClick();await flush();await f.view.submit();expect(writes(f)).toEqual([]);const first=walk(f.host).find(n=>n.props['aria-label']==='删除参数 1')!;expect(first.props.disabled).toBe(true);first.props.onClick();await flush();expect(f.view.parameterDraft.value.specs).toHaveLength(2);walk(f.host).find(n=>n.props['aria-label']==='删除参数 2')!.props.onClick();await flush();await f.view.submit();await flush();expect(JSON.parse(writes(f)[0].data).specs).toEqual(originalRows());}finally{f.close();}
 });
 it('rejects oversized templates without truncating their rows or changing the current draft',async()=>{
  const large={id:301,name:'大模板',specs:Array.from({length:101},(_,i)=>child(3010+i,301))};const f=await mount(undefined,c=>catalogCall(c)?[...options(),large]:undefined);try{select(f,301);await flush();expect(f.view.parameterDraft.value).toEqual({specs_id:51,specs:originalRows()});expect(f.view.parametersChanged.value).toBe(false);expect(runtime.dialogs.messages.some((x:string)=>x.includes('超过100项'))).toBe(true);}finally{f.close();}
 });
 it.each(['foreign','malformed','inconsistent','truncated'])('keeps historical %s readable and preserves omission until an explicit repair',async mode=>{
  const value={...detail(mode==='foreign'?999:51,mode==='malformed'||mode==='truncated'?[]:originalRows()),specs_selection:{specs_id:mode==='foreign'?999:51,specs:mode==='malformed'?'bad json':mode==='truncated'?'原'.repeat(1048576):JSON.stringify(originalRows()),consistent:mode==='foreign',available:false,truncated:mode==='truncated'}};
  const f=await mount(undefined,overrideDetail(value));try{expect(f.view.productReadReady.value).toBe(true);expect(content(f.host)).toContain('暂不可用');expect(f.view.parametersChanged.value).toBe(false);await button(f,'清空全部参数').props.onClick();await flush();select(f,202);await flush();await f.view.submit();await flush();expect(JSON.parse(writes(f)[0].data).specs_id).toBe(202);}finally{f.close();}
 });
 it('accepts the legitimate historical template-zero snapshot without requiring a template',async()=>{
  const f=await mount(undefined,overrideDetail(detail(0,originalRows())));try{expect(f.view.productReadReady.value).toBe(true);edit(f,'参数值 1','更新值');await flush();await f.view.submit();await flush();expect(JSON.parse(writes(f)[0].data)).toMatchObject({specs_id:0,specs:[row('原材质','更新值',2,51,51)]});}finally{f.close();}
 });
 it('older DTOs without all parameter fields remain editable and omit parameters',async()=>{
  const original={...seed().product,id:80}as any;delete original.specs_id;delete original.specs;delete original.specs_selection;const f=await mount(undefined,overrideDetail(original));try{expect(f.view.parameterSelection.value).toBe(null);await f.view.submit();await flush();expect(JSON.parse(writes(f)[0].data)).not.toHaveProperty('specs_id');}finally{f.close();}
 });
 it.each([
  ['missing id',{specs_id:undefined}],['missing rows',{specs:undefined}],['missing metadata',{specs_selection:undefined}],['bad modern id',{specs_id:'51'}],
  ['extra row',{specs:[{...originalRows()[0],secret:1}]}],['false raw proof',{specs_selection:{specs_id:51,specs:'[]',consistent:true,available:true,truncated:false}}],
  ['null legacy metadata',{specs:[row('原材质','原棉',2)],specs_selection:{specs_id:51,specs:JSON.stringify([{id:null,temp_id:null,name:'原材质',value:'原棉',sort:2}]),consistent:true,available:true,truncated:false}}],
  ['available inconsistent',{specs_selection:{specs_id:51,specs:'[]',consistent:false,available:true,truncated:false}}],['truncated authority',{specs_selection:{specs_id:51,specs:'[]',consistent:true,available:false,truncated:true}}],
 ]as const)('malformed parameter DTO %s cannot enable whole-product save',async(_name,patch)=>{
  const f=await mount(undefined,overrideDetail({...detail(),...patch}));try{expect(f.view.productReadReady.value).toBe(false);await f.view.submit();expect(writes(f)).toEqual([]);}finally{f.close();}
 });
 it('copy hides parameter authors, performs no catalog request and never sends ignored parameter fields',async()=>{
  const f=await mount('/products/new?copy=80');try{expect(content(f.host)).toContain('复制保留来源的商品参数');expect(walk(f.host).some(n=>n.props['aria-label']==='参数模板')).toBe(false);expect(f.calls.filter(catalogCall)).toEqual([]);await f.view.submit();await flush();expect(writes(f)).toHaveLength(1);const body=JSON.parse(writes(f)[0].data);for(const key of ['specs_id','specs','specs_selection'])expect(body.product).not.toHaveProperty(key);}finally{f.close();}
 });
 it('view-only can see the snapshot but cannot emit changes or clear author fields',async()=>{
  localStorage.setItem('supplier-permissions','["supplier.product.view"]');const f=await mount();try{select(f,201);await f.picker.clearAll();edit(f,'参数值 1','无权修改');await f.view.submit();expect(f.view.parameterDraft.value.specs).toEqual(originalRows());expect(f.view.parametersChanged.value).toBe(false);expect(writes(f)).toEqual([]);}finally{f.close();}
 });
 it('a late template catalog cannot replace a later product or clear its selected snapshot',async()=>{
  const wait=gate();let reads=0;const f=await mount(undefined,c=>catalogCall(c)?++reads===1?wait.promise:options():c.url==='/product/product/81'?{...detail(202,[row('第二商品','值')]),id:81}:undefined);try{await f.router.push('/products/81/edit');await flush();expect(f.view.parameterDraft.value.specs).toEqual([row('第二商品','值')]);wait.resolve(options());await flush();expect(f.calls.find(catalogCall).signal.aborted).toBe(true);expect(f.view.parameterDraft.value.specs[0].name).toBe('第二商品');}finally{wait.resolve(options());f.close();}
 });
 it('actual account storage ABA permanently invalidates parameters and the entire ordinary form',async()=>{
  const wait=gate();const f=await mount(undefined,c=>catalogCall(c)?wait.promise:undefined);try{localStorage.setItem('supplier-token','parameters-next');surface.dispatchEvent(new Event('supplier-session-changed'));localStorage.setItem('supplier-token','owned-copy-a');surface.dispatchEvent(new Event('supplier-session-changed'));wait.resolve(options());await flush();expect(f.picker.catalog.value).toEqual([]);expect(f.view.parameterDraft.value).toEqual({specs_id:0,specs:[]});expect(f.view.form.store_name).toBe('');expect(f.picker.invalid.value).toBe(true);await f.picker.reload();await f.view.submit();expect(f.calls.filter(catalogCall)).toHaveLength(1);expect(writes(f)).toEqual([]);}finally{wait.resolve(options());f.close();}
 });
 it.each(['route','session','unmount'])('cancels queued template GET before transport on %s invalidation',async mode=>{
  const wait=gate(),queued:any[]=[];const interceptor=runtime.http.interceptors.request.use(async(c:any)=>{if(catalogCall(c)&&!queued.length){queued.push(c);await wait.promise;}return c;});const f=await mount(undefined,c=>c.url==='/product/product/81'?{...detail(0,[]),id:81}:undefined);let closed=false;try{expect(queued).toHaveLength(1);expect(f.calls.filter(catalogCall)).toEqual([]);if(mode==='route')await f.router.push('/products/81/edit');else if(mode==='session'){localStorage.setItem('supplier-token','next-parameters');surface.dispatchEvent(new Event('supplier-session-changed'));}else{f.close();closed=true;}await flush();expect(queued[0].signal.aborted).toBe(true);wait.resolve();await flush();expect(f.calls.filter(catalogCall)).toHaveLength(mode==='route'?1:0);}finally{wait.resolve();runtime.http.interceptors.request.eject(interceptor);if(!closed)f.close();}
 });
 it('Pinia manage revocation permanently invalidates parameter catalog and draft authoring',async()=>{
  const f=await mount();try{const auth=runtime.useAuthStore(pinia);auth.permissions=['supplier.product.view'];await flush();expect(f.picker.catalog.value).toEqual([]);auth.permissions=['supplier.product.view','supplier.product.manage'];await flush();await f.picker.reload();select(f,201);expect(f.picker.invalid.value).toBe(true);expect(f.view.parameterDraft.value).toEqual({specs_id:0,specs:[]});expect(f.view.form.store_name).toBe('');await f.view.submit();expect(writes(f)).toEqual([]);}finally{f.close();}
 });
 it.each(['manage','view','identity'])('cancels queued parameter POST across in-memory %s ABA before transport',async mode=>{
  const f=await mount(),wait=gate(),queued:any[]=[];const interceptor=runtime.http.interceptors.request.use(async(c:any)=>{if(c.method==='post'){queued.push(c);await wait.promise;}return c;});
  try{select(f,201);await flush();const saving=f.view.submit();await flush();expect(queued).toHaveLength(1);const auth=runtime.useAuthStore(pinia),permissions=[...auth.permissions],user={...auth.user};if(mode==='identity')auth.user={...user,id:22};else auth.permissions=mode==='manage'?['supplier.product.view']:['supplier.product.manage'];auth.user=user;auth.permissions=permissions;expect(queued[0].signal.aborted).toBe(true);wait.resolve();await saving;await flush();expect(writes(f)).toEqual([]);expect(f.view.productReadReady.value).toBe(false);expect(f.view.parameterDraft.value).toEqual({specs_id:0,specs:[]});}finally{wait.resolve();runtime.http.interceptors.request.eject(interceptor);f.close();}
 });
 it.each(['route','session','unmount'])('cancels queued parameter POST before transport on %s invalidation',async mode=>{
  const f=await mount(),wait=gate();const interceptor=runtime.http.interceptors.request.use(async(c:any)=>{if(c.method==='post')await wait.promise;return c;});try{select(f,201);await flush();const saving=f.view.submit();await flush();expect(writes(f)).toEqual([]);if(mode==='route')await f.router.push('/products/81/edit');else if(mode==='session'){localStorage.setItem('supplier-token','next-parameter-account');surface.dispatchEvent(new Event('supplier-session-changed'));}else f.close();wait.resolve();await saving;await flush();expect(writes(f)).toEqual([]);}finally{wait.resolve();runtime.http.interceptors.request.eject(interceptor);f.close();}
 });
});
describe('closed existing parameter catalog and modern snapshot contracts',()=>{
 it('accepts actual parent3/child9, owner/platform scopes and exact2000 parent/child boundaries',()=>{
  const parse=runtime.parameters.parseSupplierProductParameterCatalog;expect(parse(options(),20)[1].specs[0]).toEqual(row('参数2011','初值2011',0,2011,201));expect(parse(Array.from({length:2000},(_,i)=>({id:i+1,name:'空模板',specs:[]})),20)).toHaveLength(2000);expect(parse([{id:1,name:'模板',specs:Array.from({length:2000},(_,i)=>child(i+1,1))}],20)[0].specs).toHaveLength(2000);
 });
 it.each([
  ['not array',{}],['extra parent',[{...options()[0],secret:1}]],['duplicate parent',[options()[0],options()[0]]],['foreign',[{id:1,name:'外店',specs:[child(1,1,2,8)]}]],
  ['wrong parent',[{id:1,name:'错父',specs:[child(1,2)]}]],['mixed ownership',[{id:1,name:'混归属',specs:[child(1,1),child(2,1,2,20)]}]],['disabled child',[{id:1,name:'停用',specs:[{...child(1,1),status:0}]}]],
  ['duplicate child',[{id:1,name:'重复',specs:[child(1,1),child(1,1)]}]],['extra child',[{id:1,name:'额外',specs:[{...child(1,1),secret:1}]}]],['invalid sort',[{id:1,name:'坏排序',specs:[{...child(1,1),sort:2147483648}]}]],
  ['too many parents',Array.from({length:2001},(_,i)=>({id:i+1,name:'模板',specs:[]}))],['too many children',[{id:1,name:'模板',specs:Array.from({length:2001},(_,i)=>child(i+1,1))}]],
 ]as const)('rejects entire malformed catalog %s without partially displaying data',(_name,value)=>{expect(()=>runtime.parameters.parseSupplierProductParameterCatalog(value,20)).toThrow();});
 it('allows free duplicate names, signed sort, raw spaces,255 Unicode and100 complete rows without mutation',()=>{
  const draft={specs_id:0,specs:[row('同名',' 0 ',-2147483648),row('同名','😀'.repeat(255),2147483647)]};expect(runtime.parameters.productParameterPayload(draft,true)).toEqual(draft);expect(runtime.parameters.productParameterPayload(draft,false)).toEqual({});const detached=runtime.parameters.productParameterPayload(draft,true);draft.specs[0].value='后改';expect(detached.specs[0].value).toBe(' 0 ');expect(runtime.parameters.productParameterPayload({specs_id:0,specs:Array.from({length:100},()=>row())},true).specs).toHaveLength(100);
 });
 it.each([
  ['string id',{specs_id:'1',specs:[]}],['negative id',{specs_id:-1,specs:[]}],['missing row id',{specs_id:0,specs:[{name:'名称',value:'值',sort:0,temp_id:0}]}],['empty value',{specs_id:0,specs:[row('名称',' ')]}],['zero value',{specs_id:0,specs:[row('名称','0')]}],
  ['lone surrogate name',{specs_id:0,specs:[row('\ud800','值')]}],['lone surrogate value',{specs_id:0,specs:[row('名称','\udfff')]}],
  ['oversized text',{specs_id:0,specs:[row('名称','😀'.repeat(256))]}],['overflow sort',{specs_id:0,specs:[row('名称','值',2147483648)]}],['too many',{specs_id:0,specs:Array.from({length:101},()=>row())}],
 ]as const)('rejects invalid author payload %s before transport',(_name,value)=>{expect(()=>runtime.parameters.productParameterPayload(value,true)).toThrow();});
 it('reads exact null and legacy five-field metadata while retaining bounded malformed originals as non-authority',()=>{
  expect(runtime.parameters.productParameterDetail({specs_id:0,specs:[],specs_selection:{specs_id:0,specs:null,consistent:true,available:true,truncated:false}}).selection.specs).toBe(null);
  const raw=JSON.stringify([{id:'51',temp_id:'51',name:'同名',value:'值',sort:'-2',status:1}]);expect(runtime.parameters.productParameterDetail({specs_id:51,specs:[row('同名','值',-2,51,51)],specs_selection:{specs_id:51,specs:raw,consistent:true,available:true,truncated:false}}).draft.specs[0].sort).toBe(-2);
  expect(runtime.parameters.productParameterDetail({specs_id:0,specs:[],specs_selection:{specs_id:-1,specs:'😀'.repeat(1048576),consistent:false,available:false,truncated:true}}).selection.truncated).toBe(true);
 });
});
