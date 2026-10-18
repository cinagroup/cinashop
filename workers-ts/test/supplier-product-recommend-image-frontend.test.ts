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
    export * as forms from './src/utils/productRecommendImage';export {http} from './src/api/http';export {useAuthStore} from './src/stores/auth';export * as api from './src/api/productCopy';export * as dialogs from 'element-plus';
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
  localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage","supplier.attachment.view"]');
  pinia = runtime.createPinia(); runtime.dialogs.messages.length = 0;runtime.captured.picker=undefined;
});
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sku = (card = false) => ({ suk: '默认', detail: { 规格: '默认' }, image: '', price: '12.00', settle_price: '6.00', cost: '3.00',
  ot_price: '14.00', vip_price: '11.00', stock: card ? 0 : 8, bar_code: '', weight: '1.00', volume: '1.00', brokerage: '0.00', brokerage_two: '0.00', code: 'SOURCE', disk_info: '' });
const dimensions=()=>[{value:'颜色',detail:['红','蓝']},{value:'尺码',detail:['S','M']}];
const multiSkus=(card=false)=>['红','蓝'].flatMap((color,c)=>['S','M'].map((size,z)=>({...sku(card),suk:color+','+size,detail:{颜色:color,尺码:size},price:(12+c*2+z)+'.00',settle_price:(6+c*2+z)+'.00',cost:(3+c*2+z)+'.00',bar_code:'BAR'+c+z,code:'CODE'+c+z,stock:card?0:8+c*2+z})));
const seed = (id = 80, type = 0) => ({ copy: { source_id: id, token: 'a'.repeat(64), destination: { type: 2, relation_id: 20 } }, product: {
  id: 0, product_type: type, store_name: '来源商品', store_info: '来源简介', keyword: '关键词', unit_name: '件', bar_code: '', cate_id: [1],
  slider_image: ['https://images.invalid/source.png'], description: '<p>来源说明</p>', spec_type: 1, items: dimensions(), attrs: multiSkus(type === 1),
  retired_attrs: [], freight: 1, postage: '0.00', temp_id: 0, is_postage: 1, is_support_refund: 1, is_limit: 0, limit_type: 0, limit_num: 0,
  system_form_id:71,system_form_selection:{system_form_id:71,available:true},ensure_id:[41],ensure_selection:{ensure_id:'41',consistent:true,available:true,retained_ids:[],truncated:false},brand_id:[1,2],brand_selection:{brand_id:2,brand_com:'1,2',consistent:true,available:true},sort: 1, ficti: 9, video_link: '', is_show: 0, is_verify: 0, store_label_id: [4], media: { version: 1, previews: {} },
} });
const marker = () => ({ operation_id: '12345678-1234-4123-8123-123456789abc', actor_id: 21, supplier_id: 20, source_id: 80 });
const receipt = (pending: any, state = 'committed') => ({ ...pending, state, result: state === 'committed' ? { id: 100, is_show: 0, is_verify: 0 } : null });
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
      if (config.url === '/product/category/tree') value = [{ id: 1, cate_name: '本机分类' }];
      else if (config.url === '/product/product/list') value = { list: [{ id: 80, product_type: 0, store_name: '来源商品', image: '', price: '12.00', stock: 8, sales: 4, is_show: 1, is_verify: 1, add_time: 100 }], count: 1, page: 1, limit: 20 };
      else if (config.url === '/product/product/get_rule') value = [];
      else if (config.url.includes('/copy_operations/')) value = fixture.receipt ?? { ...marker(), operation_id: config.url.split('/')[4], source_id: null, state: 'unknown', result: null };
      else if (config.method === 'post') value = config.url.startsWith('/product/product/copy/')?fixture.apply(config):{id:config.url.endsWith('/80')?80:100,is_show:0,is_verify:0};
      else if (/^\/product\/product\/[0-9]+$/.test(config.url)) value = {...seed(80).product,id:Number(config.url.split('/').at(-1)),attrs:multiSkus().map((row,index)=>({...row,id:11+index,unique:'batch00'+index})),store_name:'原商品'+config.url.split('/').at(-1),auto_on_time:0,auto_off_time:0};
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
  const tags = [...['pages/ProductForm', 'pages/Products','components/SupplierSkuBatchEditor'].flatMap(page => [...readFileSync(resolve(root, `src/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const name of new Set(tags)) if (!['el-table', 'el-table-column'].includes(name)) app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(name === 'el-button' ? 'button' : name, attrs, slots.default?.()); } });
  app.component('el-table', { props: ['data'], setup(props: any, { slots }: any) { runtime.provide('owned-copy-table-rows', () => props.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('owned-copy-table-rows'); return () => runtime.h('column', { label: props.label }, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[props.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push(url); app.mount(host); await flush();
  return { get picker(){return runtime.captured.picker;},view: runtime.captured.view, list: runtime.captured.list, calls, fixture, host, router, close: () => app.unmount() };
}
const writes=(f:any)=>f.calls.filter((c:any)=>c.method==='post'&&!c.url.endsWith('/resolve'));
const button=(f:any,label:string)=>walk(f.host).find(n=>n.tag==='button'&&content(n)===label)!;
function fill(f:any,label:string,value:unknown){const field=walk(f.host).find(n=>n.tag==='el-input'&&n.props['aria-label']===label);expect(field,label).toBeTruthy();field!.props['onUpdate:modelValue'](value);}
async function click(f:any,label:string){const node=button(f,label);expect(node,label).toBeTruthy();node.props.onClick();await flush();}
const copyRows=(rows:any[])=>JSON.parse(JSON.stringify(rows));
const image=(id=31)=>({id,pid:0,name:'本机图片.png',canonicalUrl:'/api/assets/'+id,previewUrl:'/api/assets/'+id+'?expires='+Math.floor(Date.now()/1000+900)+'&signature='+'a'.repeat(43),thumbnailUrl:''});
const body=(f:any)=>JSON.parse(writes(f)[0].data);
describe('actual Supplier recommendation-image author and save transport',()=>{
 it('keeps main images and unrelated values while an explicit selected image posts only its stable reference',async()=>{const f=await mount();try{const before=copyRows(f.view.form);await click(f,'选择商品推荐图');const context=f.view.mediaContext.value;f.view.receiveMedia([image()],context);await flush();expect(f.view.form.recommend_image).toBe('/api/assets/31');expect(f.view.previewImage('/api/assets/31')).toContain('signature=');expect(writes(f)).toEqual([]);await f.view.submit();expect(body(f).recommend_image).toBe('/api/assets/31');expect(JSON.stringify(body(f))).not.toContain('signature=');expect(body(f).slider_image).toEqual(before.slider_image);expect(body(f).attrs).toEqual(before.attrs.map(({delivery_mode,original_disk_info,...row}:any)=>({...row,disk_info:''})));for(const key of ['system_form_id','specs','ensure_id','brand_id','auto_on_time'])expect(body(f)).not.toHaveProperty(key);}finally{f.close();}});
 it('cancels selection without changing the existing recommendation or producing a save intention',async()=>{const f=await mount();try{f.view.applyProductDetail({...f.view.form,recommend_image:'/old-recommend.png'});await flush();await click(f,'选择商品推荐图');const context=f.view.mediaContext.value;f.view.invalidateMediaTarget();f.view.receiveMedia([image()],context);await flush();expect(f.view.form.recommend_image).toBe('/old-recommend.png');expect(f.view.recommendImageChanged.value).toBe(false);expect(writes(f)).toEqual([]);await f.view.submit();expect(body(f)).not.toHaveProperty('recommend_image');}finally{f.close();}});
 it('explicitly clears only the recommendation and leaves the product main image and SKUs untouched',async()=>{const f=await mount();try{f.view.applyProductDetail({...f.view.form,recommend_image:'/old-recommend.png'});await flush();const before=copyRows(f.view.form);await click(f,'清空商品推荐图');expect(f.view.form.recommend_image).toBe('');expect(writes(f)).toEqual([]);await f.view.submit();expect(body(f).recommend_image).toBe('');expect(body(f).slider_image).toEqual(before.slider_image);expect(body(f).attrs.map((r:any)=>r.unique)).toEqual(before.attrs.map((r:any)=>r.unique));}finally{f.close();}});
 it('does not reauthor an unchanged unavailable historical reference and allows an explicit repair',async()=>{const f=await mount();try{f.view.applyProductDetail({...f.view.form,recommend_image:'javascript:historical()'});await flush();expect(content(f.host)).toContain('当前预览不可用');expect(f.view.previewImage(f.view.form.recommend_image)).toBeNull();await f.view.submit();expect(body(f)).not.toHaveProperty('recommend_image');}finally{f.close();}const g=await mount();try{g.view.applyProductDetail({...g.view.form,recommend_image:'javascript:historical()'});await flush();await click(g,'清空商品推荐图');await g.view.submit();expect(body(g).recommend_image).toBe('');}finally{g.close();}});
 it('treats explicitly selecting the same canonical reference as an author action requiring backend validation',async()=>{const f=await mount();try{f.view.applyProductDetail({...f.view.form,recommend_image:'/api/assets/31'});await flush();await click(f,'选择商品推荐图');f.view.receiveMedia([image()],f.view.mediaContext.value);await flush();await f.view.submit();expect(body(f).recommend_image).toBe('/api/assets/31');}finally{f.close();}});
 it('accepts a typed private ticket only as a canonical payload and rejects a stale pending picker after typing',async()=>{const f=await mount();try{await click(f,'选择商品推荐图');const context=f.view.mediaContext.value;fill(f,'商品推荐图地址','/api/assets/31?expires=123&signature=never-post');await flush();expect(f.view.mediaPickerOpen.value).toBe(false);f.view.receiveMedia([image(32)],context);expect(f.view.form.recommend_image).toContain('/31?');await f.view.submit();expect(body(f).recommend_image).toBe('/api/assets/31');expect(JSON.stringify(body(f))).not.toContain('never-post');}finally{f.close();}});
 it('rejects a malformed new address before any POST while retaining the unsaved product',async()=>{const f=await mount();try{fill(f,'商品推荐图地址','https://user:password@example.invalid/image.png');await flush();await f.view.submit();expect(writes(f)).toEqual([]);expect(f.view.form.store_name).toBe('原商品80');expect(runtime.dialogs.messages.at(-1)).toContain('推荐图');}finally{f.close();}});
 it('invalidates a captured recommendation picker through route A to B and back to A',async()=>{const f=await mount();try{await click(f,'选择商品推荐图');const context=f.view.mediaContext.value;await f.router.push('/products/81/edit');await flush();await f.router.push('/products/80/edit');await flush();await click(f,'选择商品推荐图');expect(f.view.mediaContext.value).not.toBe(context);f.view.receiveMedia([image()],context);expect(f.view.form.recommend_image).toBe('');expect(f.view.recommendImageChanged.value).toBe(false);expect(writes(f)).toEqual([]);}finally{f.close();}});
 it('clears old author state and permanently rejects old receipts after real storage identity ABA',async()=>{const f=await mount();try{fill(f,'商品推荐图地址','/draft.png');await click(f,'选择商品推荐图');const context=f.view.mediaContext.value;for(const token of ['other-actor','owned-copy-a']){localStorage.setItem('supplier-token',token);surface.dispatchEvent(Object.assign(new Event('storage'),{key:'supplier-token',storageArea:localStorage}));}await flush();f.view.receiveMedia([image()],context);expect(f.view.mediaInvalidated.value).toBe(true);expect(f.view.form.recommend_image).toBe('');expect(f.view.recommendImageChanged.value).toBe(false);await f.view.submit();expect(writes(f)).toEqual([]);}finally{f.close();}});
 it('keeps recommendation inheritance read-only on the trusted-copy route and excludes even forged author bytes',async()=>{const f=await mount('/products/new?copy=80');try{expect(content(f.host)).toContain('推荐图沿用来源商品');expect(walk(f.host).some(n=>n.props['aria-label']==='商品推荐图地址')).toBe(false);f.view.changeRecommendImage('/forged.png');expect(f.view.recommendImageChanged.value).toBe(false);f.view.form.recommend_image='/forged.png';f.view.recommendImageChanged.value=true;await f.view.submit();expect(writes(f)[0].url).toBe('/product/product/copy/80');expect(body(f).copy_token).toBe('a'.repeat(64));expect(body(f).product).not.toHaveProperty('recommend_image');}finally{f.close();}});
 it.each([0,1,3])('exposes this metadata for ordinary supported fulfillment type %i without changing inventory',async type=>{const f=await mount('/products/80/edit',c=>c.url==='/product/product/80'?{...seed(80,type).product,id:80}:undefined);try{expect(content(f.host)).toContain('商品推荐图');const stocks=f.view.form.attrs.map((r:any)=>r.stock);fill(f,'商品推荐图地址','https://images.invalid/recommend.png');await flush();await f.view.submit();expect(body(f).recommend_image).toBe('https://images.invalid/recommend.png');expect(body(f).attrs.map((r:any)=>r.stock)).toEqual(stocks);}finally{f.close();}});
 it('omits the field for a new default form and includes an explicitly chosen create recommendation',async()=>{const f=await mount('/products/new');try{Object.assign(f.view.form,seed().product);await flush();await f.view.submit();expect(body(f)).not.toHaveProperty('recommend_image');}finally{f.close();}const g=await mount('/products/new');try{Object.assign(g.view.form,seed().product);await flush();fill(g,'商品推荐图地址','/create-cover.png');await flush();await g.view.submit();expect(writes(g)[0].url).toBe('/product/product');expect(body(g).recommend_image).toBe('/create-cover.png');}finally{g.close();}});
 it('does not allow readonly or protected-state callbacks to create recommendation intent',async()=>{localStorage.setItem('supplier-permissions','["supplier.product.view"]');const f=await mount();try{f.view.changeRecommendImage('/bad.png');f.view.openMedia('recommend');expect(f.view.form.recommend_image).toBe('');expect(f.view.recommendImageChanged.value).toBe(false);expect(f.view.mediaPickerOpen.value).toBe(false);await f.view.submit();expect(writes(f)).toEqual([]);}finally{f.close();}});
 it.each(['loading','saving','productReadReady','mediaInvalidated'] as const)('drops recommendation receipt during protected state %s',async key=>{const f=await mount();try{f.view.openMedia('recommend');const context=f.view.mediaContext.value;f.view[key].value=key==='productReadReady'?false:true;f.view.receiveMedia([image()],context);f.view.changeRecommendImage('/bad.png');expect(f.view.form.recommend_image).toBe('');expect(f.view.recommendImageChanged.value).toBe(false);}finally{f.close();}});
});
describe('recommendation author URL and optional-payload contract',()=>{
 it('bounds canonical public references at256 and strips private tickets and aliases before persistence',()=>{const fn=runtime.forms.productRecommendImagePayload;const boundary='https://images.invalid/'+ 'x'.repeat(233);expect(boundary).toHaveLength(256);expect(fn(boundary,true)).toEqual({recommend_image:boundary});expect(()=>fn(boundary+'x',true)).toThrow('256');expect(fn('https://owned.invalid/kefuapi/assets/31?expires=123&signature=secret',true)).toEqual({recommend_image:'/api/assets/31'});expect(fn('   ',true)).toEqual({recommend_image:''});});
 it.each([null,false,0,{},'javascript:alert(1)','http://images.invalid/a.png','//foreign.invalid/a.png','/api/assets/0','/api/assets/2147483648','/api/assets/31/extra','https://user:pass@images.invalid/a.png','/api%2fassets/31','\\\\foreign.invalid/image.png','x'.repeat(4097)])('rejects malformed explicit recommendation %# while preserving omitted history',value=>{expect(()=>runtime.forms.productRecommendImagePayload(value,true)).toThrow();expect(runtime.forms.productRecommendImagePayload(value,false)).toEqual({});});
});
