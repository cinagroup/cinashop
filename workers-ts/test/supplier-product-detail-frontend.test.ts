import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget;
async function loadRuntime(development = false) {
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `import Form from './src/pages/ProductDetail.vue';import Products from './src/pages/Products.vue';
    export {Form,Products};export const captured={};const setup=Form.setup;Form.setup=(p,c)=>{const v=setup(p,c);captured.view=v;return v;};
    const listSetup=Products.setup;Products.setup=(p,c)=>{const v=listSetup(p,c);captured.list=v;return v;};
    export {http} from './src/api/http';export {useAuthStore} from './src/stores/auth';export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,provide,inject} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': String(development), 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-readonly-product-with-transport', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        if (path.includes('/components/')) return { contents: 'export default {render:()=>null}', loader: 'ts' };
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'owned-product-read', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'owned-product-read',
          compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialog', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const messages=[];
        export const ElMessage={success:m=>messages.push(m),error:m=>messages.push(m),warning:m=>messages.push(m)};
        export const ElMessageBox={confirm:async()=>{},prompt:async()=>({value:'owned'})};` }));
    } }] });
  return await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
beforeAll(async () => { runtime = await loadRuntime(); }, 30000);
beforeEach(() => {
  const local = new Map<string, string>(), session = new Map<string, string>(); surface = new EventTarget(); vi.stubGlobal('window', surface);
  const storage = (map: Map<string, string>) => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v), removeItem: (k: string) => map.delete(k) });
  vi.stubGlobal('localStorage', storage(local)); vi.stubGlobal('sessionStorage', storage(session));
  localStorage.setItem('supplier-token', 'owned-review-a'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":20}');
  localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage"]');
  pinia = runtime.createPinia(); runtime.dialogs.messages.length = 0;
});
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(done => { resolve = done; }), resolve }; };
async function flush() { for (let i = 0; i < 45; i++) { await Promise.resolve(); await runtime.nextTick(); } }
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node };
const walk = (n: Node): Node[] => [n, ...n.children.flatMap(walk)];
const content = (n: Node): string => (n.text ?? '') + n.children.map(content).join('');
const views = (f: any) => f.calls.filter((c: any) => /\/product\/product\/[1-9]\d*\/view$/.test(c.url));
function dto(id = 80): any {return {version:'supplier-product-detail-v1',actor_id:21,supplier_id:20,product_id:id,bounded:true,
  product:{product_type:0,store_name:`本店商品${id}`,store_info:'商品合成简介',keyword:'合成',unit_name:'件',bar_code:'OWNED80',image:`/owned-media/image${id}.svg`,slider_image:[`/owned-media/image${id}.svg`],price:'19.99',ot_price:'25.00',vip_price:'18.00',stock:8,sales:4,spec_type:1,freight:2,postage:'3.00',temp_id:0,is_postage:0,is_support_refund:1,is_limit:1,limit_type:1,limit_num:3,is_show:1,is_verify:1,refusal:'',sort:100,ficti:2,add_time:100,video_link:'',video_preview_url:''},
  attributes:[{name:'颜色',values:['蓝','白']}],skus:[{id:id*10+1,suk:'蓝',price:'19.99',ot_price:'25.00',vip_price:'18.00',stock:8,sales:4,image:`/owned-media/image${id}.svg`,bar_code:'SKU80',is_retired:0}],
  media:{version:1,status:'ready',previews:{[`/owned-media/image${id}.svg`]:{status:'ready',src:`/owned-media/image${id}.svg`,expires_at:null}},description_html:`<p>合成安全介绍${id}</p>`}};}
async function mount(url = '/products/80/view', override: (config: any, fixture: any) => unknown = () => undefined) {
 const calls:any[]=[];const fixture={entries:[dto(),dto(81)]};
 runtime.http.defaults.adapter=async(config:any)=>{calls.push(config);let value=await override(config,fixture);if(value===undefined){
  if(config.url==='/product/product/list')value={list:[{id:80,product_type:0,store_name:'本店商品80',image:'',price:'19.99',stock:8,sales:4,is_show:1,is_verify:1,add_time:100}],count:1,page:1,limit:20};
  else if(config.method==='get'&&/\/view$/.test(config.url)){const id=Number(config.url.split('/').at(-2));value=structuredClone(fixture.entries.find(x=>x.product_id===id));}
  else throw Error('Unexpected request '+config.method+' '+config.url);
 }return {config,data:{status:200,msg:'owned product view',data:value},status:200,statusText:'owned',headers:{}};};
  const host: Node = { children: [], props: {} };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => ({ tag, children: [], props: {} }), createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(n: Node, p: Node, anchor?: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); n.parent = p; const at = anchor ? p.children.indexOf(anchor) : -1; p.children.splice(at < 0 ? p.children.length : at, 0, n); },
    remove(n: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); }, parentNode: (n: Node) => n.parent,
    nextSibling: (n: Node) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, patchProp(n: Node, k: string, _: unknown, v: unknown) { n.props[k] = v; },
    setText(n: Node, v: string) { n.text = v; }, setElementText(n: Node, v: string) { n.text = v; n.children = []; } });
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/products/:id/view', component: runtime.Form }, { path: '/product-reviews', component: {render:()=>null} }, { path: '/products/:id/edit', component: {render:()=>null} },
    { path: '/products', component: runtime.Products }, { path: '/elsewhere', component: { render: () => null } }] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  const tags = [...['ProductDetail', 'Products'].flatMap(page => [...readFileSync(resolve(root, `src/pages/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const name of new Set(tags)) if (!['el-table', 'el-table-column', 'el-dialog'].includes(name)) app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) {
    return () => runtime.h(name === 'el-button' ? 'button' : name, attrs, name === 'el-alert' ? [attrs.title, attrs.description] : slots.default?.()); } });
  app.component('el-dialog', { props: ['modelValue'], setup(props: any, { slots, attrs }: any) { return () => props.modelValue ? runtime.h('dialog', attrs, [slots.default?.(), slots.footer?.()]) : null; } });
  app.component('el-table', { props: ['data'], setup(props: any, { slots }: any) { runtime.provide('owned-review-table-rows', () => props.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('owned-review-table-rows'); return () => runtime.h('column', { label: props.label }, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[props.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push(url); app.mount(host); await flush();
  return { get view() { return runtime.captured.view; }, get list() { return runtime.captured.list; }, calls, fixture, host, router, close: () => app.unmount() };
}
function sessionABA(){localStorage.setItem('supplier-token','other');surface.dispatchEvent(new Event('supplier-session-changed'));localStorage.setItem('supplier-token','owned-review-a');surface.dispatchEvent(new Event('supplier-session-changed'));}
function button(f:any,label:string){return walk(f.host).find(n=>n.tag==='button'&&content(n)===label);}

describe('Supplier read-only product detail, actual SFC/Pinia/Router/Axios', () => {
  it('opens the selected product through the actual list and consumes only the isolated view GET', async () => {
    const f = await mount('/products'); try {
      expect(button(f, '详情')).toBeDefined(); await button(f, '详情')!.props.onClick(); await flush();
      expect(f.router.currentRoute.value.path).toBe('/products/80/view');
      expect(views(f).map((c:any)=>c.url)).toEqual(['/product/product/80/view']);
      expect(content(f.host)).toContain('本店商品80'); expect(content(f.host)).toContain('配送与售后');
      expect(content(f.host)).toContain('商品规格'); expect(content(f.host)).toContain('SKU80');
      expect(f.calls.every(c=>c.method==='get')).toBe(true);
    } finally { f.close(); }
  });
  it('allows view-only inspection and review navigation but blocks even a forged edit handler', async () => {
    localStorage.setItem('supplier-permissions','["supplier.product.view"]'); const f=await mount('/products');
    try {await button(f,'详情')!.props.onClick();await flush();expect(button(f,'编辑商品')).toBeUndefined();
      f.view.edit(); await flush();expect(f.router.currentRoute.value.path).toBe('/products/80/view');
      await button(f,'查看评价')!.props.onClick();await flush();expect(f.router.currentRoute.value.fullPath).toBe('/product-reviews?product_id=80');
      expect(f.calls.every(c=>c.method==='get')).toBe(true);
    } finally {f.close();}
  });
  it('permits a fresh manage account to navigate to the separate existing editor',async()=>{
    const f=await mount();try{await button(f,'编辑商品')!.props.onClick();await flush();expect(f.router.currentRoute.value.path).toBe('/products/80/edit');expect(f.calls.every(c=>c.method==='get')).toBe(true);}finally{f.close();}
  });
  it('preserves database-scale prices, historical negative sort, repeated slides and empty dimension values',async()=>{
    const f=await mount('/products/80/view',config=>{if(!config.url.endsWith('/view'))return;const d=dto();d.product.price='999999999999999999.99';d.product.sort=-1;d.product.slider_image.push(d.product.slider_image[0]);d.attributes[0].values=[];return d;});
    try{expect(f.view.fresh.value).toBe(true);expect(content(f.host)).toContain('999,999,999,999,999,999.99');expect(f.view.pictures.value).toHaveLength(1);}finally{f.close();}
  });
  it.each([[2,'优惠券商品'],[3,'虚拟商品'],[4,'次卡商品']])('renders the actual schema meaning of product type %s as %s',async(type,label)=>{
    const f=await mount('/products/80/view',config=>{if(!config.url.endsWith('/view'))return;const d=dto();d.product.product_type=type;return d;});
    try{expect(f.view.fresh.value).toBe(true);expect(content(f.host)).toContain(label);expect(!!button(f,'编辑商品')).toBe(type===3);}finally{f.close();}
  });
  it('does not turn a forged or stale product-list target into a detail read',async()=>{
    const f=await mount('/products');try{f.list.viewProductDetail({...f.list.rows.value[0],id:81});await flush();expect(views(f)).toEqual([]);
      const target=f.list.rows.value[0];sessionABA();f.list.viewProductDetail(target);await flush();expect(views(f)).toEqual([]);expect(f.router.currentRoute.value.path).toBe('/products');
    }finally{f.close();}
  });
  it.each(['0','-1','01','1e2','%2080','2147483648','80?preview=1','80?product_id=80','80?supplier_id=20','80?preview=1&preview=1'])('rejects invalid detail selection %s without a request',async suffix=>{
    const [id,query]=suffix.split('?');const f=await mount(`/products/${id}/view${query?'?'+query:''}`);try{expect(views(f)).toEqual([]);expect(f.view.detail.value).toBeNull();expect(content(f.host)).toContain('查询参数无效');}finally{f.close();}
  });
  it('never reads when the current account lacks product.view',async()=>{
    localStorage.setItem('supplier-permissions','["supplier.product.manage"]');const f=await mount();try{expect(views(f)).toEqual([]);expect(content(f.host)).toContain('无法查看商品详情');}finally{f.close();}
  });
  it.each([
    ['another actor',(d:any)=>{d.actor_id=22;}],['another supplier',(d:any)=>{d.supplier_id=99;}],['another product',(d:any)=>{d.product_id=81;}],
    ['raw card config',(d:any)=>{d.product.disk_info='hidden-card';}],['card in SKU',(d:any)=>{d.skus[0].card_pwd='hidden-card';}],
    ['retired SKU',(d:any)=>{d.skus[0].is_retired=1;}],['duplicate SKU',(d:any)=>{d.skus.push({...d.skus[0]});}],
    ['invalid price',(d:any)=>{d.product.price=19.99;}],['negative inventory',(d:any)=>{d.skus[0].stock=-1;}],
    ['unbounded result',(d:any)=>{d.bounded=false;}],['oversize description',(d:any)=>{d.media.description_html='x'.repeat(400001);}],
    ['foreign unsigned preview',(d:any)=>{d.media.previews['/api/assets/31']={status:'ready',src:'/api/assets/32',expires_at:2000000000};}],
  ])('clears the complete surface on invalid payload: %s',async(_label,change)=>{
    const f=await mount('/products/80/view',config=>{if(!config.url.endsWith('/view'))return;const d=dto();change(d);return d;});
    try{expect(f.view.detail.value).toBeNull();expect(f.view.fresh.value).toBe(false);expect(content(f.host)).toContain('当前账号或商品不符');expect(button(f,'编辑商品')).toBeUndefined();expect(button(f,'查看评价')).toBeUndefined();}finally{f.close();}
  });
  it('sanitizes the canonical rich text once and uses only the delegated signed image',async()=>{
    const expires=Math.floor(Date.now()/1000)+60,src=`/api/assets/31?expires=${expires}&signature=${'a'.repeat(43)}`;
    const f=await mount('/products/80/view',config=>{if(!config.url.endsWith('/view'))return;const d=dto();d.product.image='/api/assets/31';d.product.slider_image=['/api/assets/31'];d.media.previews={'/api/assets/31':{status:'ready',src,expires_at:expires}};d.media.description_html='<p onclick="danger()">安全介绍<img src="/api/assets/31" onerror="danger()"></p><script>danger()</script>';return d;});
    try{expect(f.view.image('/api/assets/31')).toBe(src);expect(f.view.description.value).toContain(src.replaceAll('&','&amp;'));expect(f.view.description.value).not.toMatch(/onclick|onerror|<script/);expect(walk(f.host).find(n=>n.props.innerHTML)?.props.innerHTML).toBe(f.view.description.value);}finally{f.close();}
  });
  it('expires delegated images without rereading and only refreshes on an explicit action',async()=>{
    vi.useFakeTimers();const expires=Math.floor(Date.now()/1000)+2,src=`/api/assets/31?expires=${expires}&signature=${'b'.repeat(43)}`;
    let f:Awaited<ReturnType<typeof mount>>|undefined;
    try{f=await mount('/products/80/view',config=>{if(!config.url.endsWith('/view'))return;const d=dto();d.product.image='/api/assets/31';d.product.slider_image=['/api/assets/31'];d.media.previews={'/api/assets/31':{status:'ready',src,expires_at:expires}};d.media.description_html='<img src="/api/assets/31">';return d;});
      expect(f.view.image('/api/assets/31')).toBe(src);await vi.advanceTimersByTimeAsync(2100);await flush();expect(f.view.image('/api/assets/31')).toBeNull();expect(f.view.description.value).not.toContain('signature=');expect(views(f)).toHaveLength(1);
      await button(f,'刷新详情')!.props.onClick();await flush();expect(views(f)).toHaveLength(2);
    }finally{f?.close();vi.useRealTimers();}
  });
  it('keeps image failures as placeholders until an explicit refresh',async()=>{
    const f=await mount();try{const img=walk(f.host).find(n=>n.tag==='img'&&n.props.src==='/owned-media/image80.svg');expect(img).toBeDefined();img!.props.onError();await flush();expect(f.view.image('/owned-media/image80.svg')).toBeNull();expect(views(f)).toHaveLength(1);await f.view.load();expect(f.view.image('/owned-media/image80.svg')).toBe('/owned-media/image80.svg');}finally{f.close();}
  });
  it('clears the previous product immediately and rejects an old route ABA response',async()=>{
    const held=gate();let first=true;const f=await mount('/products/80/view',config=>{if(config.url==='/product/product/80/view'&&first){first=false;return held.promise;}});
    try{await f.router.push('/products/81/view');await flush();expect(f.view.detail.value.product_id).toBe(81);await f.router.push('/products/80/view');await flush();
      const stale=dto();stale.product.store_name='过期商品名';held.resolve(stale);await flush();expect(f.view.detail.value.product.store_name).toBe('本店商品80');expect(content(f.host)).not.toContain('过期商品名');
    }finally{held.resolve(dto());f.close();}
  });
  it('clears loaded details while a refresh fails and permits only a manual fresh GET',async()=>{
    let fail=false;const f=await mount('/products/80/view',config=>{if(config.url.endsWith('/view')&&fail)throw Error('本机读取失败');});
    try{expect(f.view.detail.value).not.toBeNull();fail=true;const pending=f.view.load();expect(f.view.detail.value).toBeNull();await pending;await flush();expect(content(f.host)).toContain('本机读取失败');expect(button(f,'编辑商品')).toBeUndefined();expect(views(f)).toHaveLength(2);fail=false;await f.view.load();expect(f.view.detail.value.product_id).toBe(80);}finally{f.close();}
  });
  it.each(['permission','session','unmount'])('cancels a queued Axios GET on %s invalidation before dispatch',async mode=>{
    const blocked=gate(),hook=runtime.http.interceptors.request.use(async(config:any)=>{await blocked.promise;return config;});let f:Awaited<ReturnType<typeof mount>>|undefined;
    try{f=await mount();expect(views(f)).toEqual([]);if(mode==='permission')runtime.useAuthStore(pinia).permissions=[];else if(mode==='session')sessionABA();else f.close();blocked.resolve();await flush();expect(views(f)).toEqual([]);expect(f.view.detail.value).toBeNull();if(mode!=='unmount')expect(content(f.host)).toContain('登录状态或权限已变化');}finally{blocked.resolve();runtime.http.interceptors.request.eject(hook);if(mode!=='unmount')f?.close();}
  });
  it('permanently invalidates loaded details and navigation after same-account session ABA',async()=>{
    const f=await mount();try{sessionABA();await flush();expect(f.view.detail.value).toBeNull();expect(button(f,'查看评价')).toBeUndefined();await f.view.load();f.view.edit();f.view.reviews();await flush();expect(views(f)).toHaveLength(1);expect(f.router.currentRoute.value.path).toBe('/products/80/view');}finally{f.close();}
  });
  it('drops an actual in-flight GET after a cross-window storage session ABA',async()=>{
    const held=gate();const f=await mount('/products/80/view',config=>config.url.endsWith('/view')?held.promise:undefined);
    try{localStorage.setItem('supplier-token','other');const change=new Event('storage');Object.assign(change,{key:'supplier-token',storageArea:localStorage});surface.dispatchEvent(change);localStorage.setItem('supplier-token','owned-review-a');surface.dispatchEvent(change);held.resolve(dto());await flush();expect(f.view.detail.value).toBeNull();expect(views(f)[0].signal.aborted).toBe(true);expect(content(f.host)).toContain('登录状态或权限已变化');}finally{held.resolve(dto());f.close();}
  });
  it('keeps explicit development preview inspection without a business request',async()=>{
    const production=runtime,originalPinia=pinia;let f:Awaited<ReturnType<typeof mount>>|undefined;Object.assign(surface,{location:{search:'?preview=1'}});
    try{runtime=await loadRuntime(true);pinia=runtime.createPinia();f=await mount('/products/71/view?preview=1');expect(f.view.fresh.value).toBe(true);expect(f.view.detail.value.product_id).toBe(71);expect(f.calls).toEqual([]);expect(Object.keys(f.view.detail.value.skus[0])).not.toContain('disk_info');}finally{f?.close();if(runtime!==production)runtime.disposePinia(pinia);runtime=production;pinia=originalPinia;}
  },30000);
});
