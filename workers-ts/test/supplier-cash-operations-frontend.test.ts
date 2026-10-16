import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget;
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `import Form from './src/pages/CashOperation.vue';
    export {Form};export const captured={};const setup=Form.setup;Form.setup=(p,c)=>{const v=setup(p,c);captured.view=v;return v;};
    export {http} from './src/api/http';export * as api from './src/api/cashOperations';export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-cash-operations', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'owned-cash-operations', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'owned-cash-operations', compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
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
  localStorage.setItem('supplier-permissions', '["supplier.order.view","supplier.order.manage","supplier.refund.view","supplier.refund.manage"]');
  pinia = runtime.createPinia(); runtime.dialogs.messages.length = 0;
});
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
type Kind = 'payment'|'refund';
const key = (kind:Kind) => `supplier_cash_${kind}_pending_v1:7:21`;
const marker = (kind:Kind) => ({operation_id:'12345678-1234-4123-8123-123456789abc',actor_id:21,supplier_id:7,subject_id:80,kind});
const seed = (kind:Kind,id=80,amount='18.75') => kind==='payment'
  ? {id,order_no:'wxOwned'+id,amount,gain_integral:'17.00',cash_required:amount!=='0.00',revision:'a'.repeat(64)}
  : {refund_id:id,order_id:70,refund_no:'wxRefund'+id,refund_price:amount,pay_type:'offline',settlement:amount==='0.00'?'zero':'cash',revision:'a'.repeat(64)};
const receipt = (pending:any,state='committed',amount='18.75') => ({operation_id:pending.operation_id,actor_id:pending.actor_id,supplier_id:pending.supplier_id,
  [pending.kind==='payment'?'order_id':'refund_id']:state==='unknown'?null:pending.subject_id,state,result:state!=='committed'?null:pending.kind==='payment'
    ? {id:pending.subject_id,order_no:'wxOwned'+pending.subject_id,paid:1,pay_type:'offline',pay_price:amount,pay_time:100}
    : {refund_id:pending.subject_id,order_id:70,amount,status:amount==='0.00'?'ZERO_SUCCESS':'CASH_SUCCESS'}});
const gate = () => {let resolve!:(value?:any)=>void;return{promise:new Promise<any>(done=>{resolve=done;}),resolve};};
const flush = async () => {for(let i=0;i<40;i++){await Promise.resolve();await runtime.nextTick();}};
type Node = {tag?:string;text?:string;children:Node[];props:Record<string,any>;parent?:Node};
const walk = (node:Node):Node[] => [node,...node.children.flatMap(walk)];
const content = (node:Node):string => (node.text??'')+node.children.map(content).join('');
const entry = (kind:Kind) => kind==='payment'?'/orders/80/offline':'/refunds/80/cash';
const resultEntry = (kind:Kind) => kind==='payment'?'/orders/cash-result':'/refunds/cash-result';
async function mount(kind:Kind,url=entry(kind),override:(config:any,fixture:any)=>unknown=()=>undefined) {
  const calls:any[] = [],fixture={receipt:null as any,apply(config:any){const body=JSON.parse(config.data),pending=JSON.parse(sessionStorage.getItem(key(kind))!);
    expect(Object.keys(pending).sort()).toEqual(['actor_id','kind','operation_id','subject_id','supplier_id']);expect(pending.operation_id).toBe(body.operation_id);
    fixture.receipt=receipt(pending,'committed',kind==='payment'?body.amount:body.refund_price);return fixture.receipt;}};
  runtime.http.defaults.adapter=async(config:any)=>{calls.push(config);let value=await override(config,fixture);
    if(value===undefined){if(config.url.includes('_operations/'))value=fixture.receipt??receipt(marker(kind),config.method==='post'?'not_applied':'unknown');
      else if(config.method==='post'||config.method==='put')value=fixture.apply(config);else value=seed(kind,Number(config.url.split('/').at(-1)));}
    return{config,data:{status:200,msg:'owned cash transport',data:value},status:200,statusText:'owned',headers:{}};};
  const host: Node = { children: [], props: {} };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => ({ tag, children: [], props: {} }), createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(node: Node, parent: Node, anchor?: Node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); node.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, node); },
    remove(node: Node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); }, parentNode: (node: Node) => node.parent,
    nextSibling: (node: Node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null, patchProp(node: Node, property: string, _: unknown, value: unknown) { node.props[property] = value; },
    setText(node: Node, value: string) { node.text = value; }, setElementText(node: Node, value: string) { node.text = value; node.children = []; } });
  const router=runtime.createRouter({history:runtime.createMemoryHistory(),routes:[
    {path:'/orders/:id/offline',component:runtime.Form},{path:'/refunds/:id/cash',component:runtime.Form},
    {path:'/orders/cash-result',component:runtime.Form},{path:'/refunds/cash-result',component:runtime.Form},
    {path:'/orders',component:{render:()=>null}},{path:'/refunds',component:{render:()=>null}}]});
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  for (const name of new Set([...readFileSync(resolve(root, 'src/pages/CashOperation.vue'), 'utf8').matchAll(/<(el-[a-z-]+)/g)].map(match => match[1])))
    app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(name === 'el-button' ? 'button' : name, attrs, slots.default?.()); } });
  await router.push(url); app.mount(host); await flush(); return { view: runtime.captured.view, calls, fixture, host, router, close: () => app.unmount() };
}
const writes=(f:any)=>f.calls.filter((call:any)=>(call.method==='post'||call.method==='put')&&!call.url.endsWith('/resolve'));
describe.each(['payment','refund'] as const)('rendered actual Supplier cash %s flow and original operation recovery',kind=>{
  it('requires explicit physical cash confirmation and persists only the original identity before one write',async()=>{
    const f=await mount(kind);try{await f.view.save();expect(writes(f)).toEqual([]);f.view.cashConfirmed.value=true;await f.view.save();await flush();
      expect(writes(f)).toHaveLength(1);const body=JSON.parse(writes(f)[0].data);expect(body).toMatchObject({revision:'a'.repeat(64),[kind==='payment'?'cash_received':'cash_returned']:true});
      expect(sessionStorage.getItem(key(kind))).toBeNull();expect(f.router.currentRoute.value.path).toBe(kind==='payment'?'/orders':'/refunds');
    }finally{f.close();}
  });
  it('keeps post-COMMIT response loss pending across reload and recovers through GET without any repeated write',async()=>{
    const f=await mount(kind,undefined,(config,fixture)=>{if((config.method==='post'||config.method==='put')&&!config.url.endsWith('/resolve')){fixture.apply(config);throw Error('owned committed reply lost');}});
    let committed:any;try{f.view.cashConfirmed.value=true;await f.view.save();expect(writes(f)).toHaveLength(1);committed=f.fixture.receipt;expect(content(f.host)).toContain('结果待确认');await f.view.save();expect(writes(f)).toHaveLength(1);}finally{f.close();}
    const recovered=await mount(kind,resultEntry(kind));try{recovered.fixture.receipt=committed;expect(recovered.calls).toEqual([]);await recovered.view.recover(false);
      expect(writes(recovered)).toEqual([]);expect(recovered.calls.map((call:any)=>call.method)).toEqual(['get']);expect(sessionStorage.getItem(key(kind))).toBeNull();
    }finally{recovered.close();}
  });
  it('preserves pending operations for another subject and never fetches a new seed automatically',async()=>{
    sessionStorage.setItem(key(kind),JSON.stringify(marker(kind)));const f=await mount(kind,entry(kind).replace('/80/','/81/'));
    try{expect(f.view.pending.value.subject_id).toBe(80);expect(f.view.source.value).toBeNull();expect(f.calls).toEqual([]);await f.view.save();expect(writes(f)).toEqual([]);}finally{f.close();}
  });
  it('offers read-only original-result recovery after all manage permissions are withdrawn',async()=>{
    localStorage.setItem('supplier-permissions','[]');sessionStorage.setItem(key(kind),JSON.stringify(marker(kind)));const f=await mount(kind,resultEntry(kind));
    try{f.fixture.receipt=receipt(marker(kind));await f.view.save();expect(writes(f)).toEqual([]);await f.view.recover(false);expect(sessionStorage.getItem(key(kind))).toBeNull();expect(writes(f)).toEqual([]);}finally{f.close();}
  });
  it('never writes when pending identity persistence fails',async()=>{
    const f=await mount(kind);try{f.view.cashConfirmed.value=true;vi.spyOn(sessionStorage,'setItem').mockImplementation(()=>{throw Error('owned blocked storage');});await f.view.save();expect(writes(f)).toEqual([]);expect(f.view.storageError.value).toContain('blocked storage');}finally{f.close();}
  });
  it('rejects amount or wrong-subject receipts and retains the original pending request',async()=>{
    const f=await mount(kind,undefined,(config,fixture)=>{if(config.method==='post'||config.method==='put'){const response=fixture.apply(config);if(kind==='payment')response.result.pay_price='1.00';else response.result.amount='1.00';return response;}});
    try{f.view.cashConfirmed.value=true;await f.view.save();expect(f.view.pending.value).not.toBeNull();expect(sessionStorage.getItem(key(kind))).not.toBeNull();expect(writes(f)).toHaveLength(1);}finally{f.close();}
  });
  it('invalidates a stale confirmation after session A-to-B-to-A change',async()=>{
    const dialog=gate(),f=await mount(kind);try{f.view.cashConfirmed.value=true;vi.spyOn(runtime.dialogs.ElMessageBox,'confirm').mockImplementation(()=>dialog.promise);const action=f.view.save();
      localStorage.setItem('supplier-token','owned-B');surface.dispatchEvent(new Event('supplier-session-changed'));localStorage.setItem('supplier-token','owned-order-edit-token');surface.dispatchEvent(new Event('supplier-session-changed'));
      dialog.resolve();await action;expect(writes(f)).toEqual([]);expect(f.view.source.value).toBeNull();}finally{dialog.resolve();f.close();}
  });
  it('keeps unknown GET pending and seals not-applied only through explicit resolution',async()=>{
    sessionStorage.setItem(key(kind),JSON.stringify(marker(kind)));const f=await mount(kind,resultEntry(kind));try{await f.view.recover(false);expect(f.view.pending.value).not.toBeNull();expect(writes(f)).toEqual([]);await f.view.recover(true);expect(f.view.pending.value).toBeNull();expect(f.calls.map((call:any)=>call.method)).toEqual(['get','post']);}finally{f.close();}
  });
  it('omits physical-cash claims for a real zero-value settlement',async()=>{
    const f=await mount(kind,undefined,config=>config.method==='get'?seed(kind,80,'0.00'):undefined);try{await f.view.save();expect(writes(f)).toHaveLength(1);const body=JSON.parse(writes(f)[0].data);expect(body).not.toHaveProperty('cash_received');expect(body).not.toHaveProperty('cash_returned');}finally{f.close();}
  });
  it('refuses foreign pending identities instead of silently clearing the uncertain operation',async()=>{
    sessionStorage.setItem(key(kind),JSON.stringify({...marker(kind),supplier_id:8}));const f=await mount(kind);try{expect(f.view.storageError.value).toContain('记录无效');await f.view.save();expect(f.calls).toEqual([]);expect(sessionStorage.getItem(key(kind))).not.toBeNull();}finally{f.close();}
  });
});
