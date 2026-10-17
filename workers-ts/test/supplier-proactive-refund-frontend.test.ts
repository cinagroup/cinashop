import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget;
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `import Form from './src/pages/ProactiveRefund.vue';
    export {Form};export const captured={};const setup=Form.setup;Form.setup=(p,c)=>{const v=setup(p,c);captured.view=v;return v;};
    export {http} from './src/api/http';export * as api from './src/api/proactiveRefund';export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-proactive-refund', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'owned-proactive-refund', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'owned-proactive-refund', compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
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
const key = () => 'supplier_proactive_refund_pending_v1:7:21';
const marker = (order_id=80) => ({operation_id:'12345678-1234-4123-8123-123456789abc',actor_id:21,supplier_id:7,order_id});
const seed = (changes:Record<string,unknown>={}) => ({title:'主动退款',action:'/order/refund/80',method:'PUT',order_id:80,order_no:'wxOwned80',
 refund_price:'18.75',paid:'18.75',refunded:'0.00',pay_type:'offline',settlement:'cash',quantity:3,kind:'goods',revision:'a'.repeat(64),fields:[],...changes});
const receipt = (pending=marker(),state='committed',amount='7.00',kind='goods') => ({...pending,order_id:state==='unknown'?null:pending.order_id,state,
 result:state!=='committed'?null:{order_id:pending.order_id,refund_id:kind==='refuse'?null:900,amount,kind,status:kind==='refuse'?'REFUSED':amount==='0.00'?'ZERO_SUCCESS':'CASH_SUCCESS'}});
const gate = () => {let resolve!:(value?:any)=>void;return{promise:new Promise<any>(done=>{resolve=done;}),resolve};};
const flush = async () => {for(let i=0;i<40;i++){await Promise.resolve();await runtime.nextTick();}};
type Node = {tag?:string;text?:string;children:Node[];props:Record<string,any>;parent?:Node};
const content = (node:Node):string => (node.text??'')+node.children.map(content).join('');
const walk = (node:Node):Node[] => [node,...node.children.flatMap(walk)];
async function mount(url='/orders/80/refund',override:(config:any,fixture:any)=>unknown=()=>undefined) {
 const calls:any[]=[],fixture={current:seed(),receipt:null as any,apply(config:any){
  const body=JSON.parse(config.data),pending=JSON.parse(sessionStorage.getItem(key())!);
  expect(Object.keys(pending).sort()).toEqual(['actor_id','operation_id','order_id','supplier_id']);expect(body.operation_id).toBe(pending.operation_id);
  const result=receipt(pending,'committed',body.refund_price,body.type===2?'refuse':fixture.current.kind);
  if(body.type!==2){
   if(fixture.current.settlement==='balance')result.result!.status='BALANCE_SUCCESS';
   const total=BigInt(fixture.current.refunded.replace('.',''))+BigInt(body.refund_price.replace('.',''));
   const remaining=1875n-total;
   fixture.current=seed({kind:'money',quantity:0,refunded:`${total/100n}.${String(total%100n).padStart(2,'0')}`,
    refund_price:`${remaining/100n}.${String(remaining%100n).padStart(2,'0')}`,pay_type:fixture.current.pay_type,settlement:fixture.current.settlement});
  }
  fixture.receipt=result;return result;
 }};
 runtime.http.defaults.adapter=async(config:any)=>{calls.push(config);let value=await override(config,fixture);
  if(value===undefined){if(config.url.includes('refund_operations/'))value=fixture.receipt??receipt(marker(),config.method==='post'?'not_applied':'unknown');
   else if(config.method==='put')value=fixture.apply(config);else value=fixture.current;}
  return{config,data:{status:200,msg:'owned proactive transport',data:value},status:200,statusText:'owned',headers:{}};};
 const host:Node={children:[],props:{}};
 const renderer=runtime.createRenderer({createElement:(tag:string)=>({tag,children:[],props:{}}),createText:(text:string)=>({text,children:[],props:{}}),createComment:()=>({children:[],props:{}}),
  insert(node:Node,parent:Node,anchor?:Node){if(node.parent)node.parent.children=node.parent.children.filter(item=>item!==node);node.parent=parent;const at=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(at<0?parent.children.length:at,0,node);},
  remove(node:Node){if(node.parent)node.parent.children=node.parent.children.filter(item=>item!==node);},parentNode:(node:Node)=>node.parent,nextSibling:(node:Node)=>node.parent?.children[node.parent.children.indexOf(node)+1]??null,
  patchProp(node:Node,property:string,_:unknown,value:unknown){node.props[property]=value;},setText(node:Node,value:string){node.text=value;},setElementText(node:Node,value:string){node.text=value;node.children=[];}});
 const router=runtime.createRouter({history:runtime.createMemoryHistory(),routes:[{path:'/orders/:id/refund',component:runtime.Form},
  {path:'/orders/refund-result',component:runtime.Form},{path:'/orders',component:{render:()=>null}},{path:'/away',component:{render:()=>null}}]});
 const app=renderer.createApp({render:()=>runtime.h(runtime.RouterView)});app.use(pinia);app.use(router);
 for(const name of new Set([...readFileSync(resolve(root,'src/pages/ProactiveRefund.vue'),'utf8').matchAll(/<(el-[a-z-]+)/g)].map(match=>match[1])))
  app.component(name,{inheritAttrs:false,setup(_:unknown,{slots,attrs}:any){return()=>runtime.h(name==='el-button'?'button':name,attrs,slots.default?.());}});
 await router.push(url);app.mount(host);await flush();return{view:runtime.captured.view,calls,fixture,host,router,close:()=>app.unmount()};
}
const writes=(f:any)=>f.calls.filter((call:any)=>call.method==='put');
describe('actual Supplier order-ID refund page and recovery',()=>{
 it('renders real quantity and exact remaining money, then confirms one whole-goods payout after cash acknowledgement',async()=>{
  const f=await mount();try{expect(content(f.host)).toContain('全部 3 件商品');f.view.amount.value='7';await f.view.save();expect(writes(f)).toEqual([]);
   f.view.cashConfirmed.value=true;await f.view.save();expect(writes(f)).toHaveLength(1);expect(JSON.parse(writes(f)[0].data)).toMatchObject({refund_price:'7.00',type:1,cash_returned:true});
   expect(content(f.host)).toContain('整单退款已完成');expect(sessionStorage.getItem(key())).toBeNull();expect(f.view.source.value).toBeNull();
  }finally{f.close();}
 });
 it('explicitly reloads the actual money remainder and never repeats goods when making two later payments',async()=>{
  const f=await mount();try{for(const amount of ['7.00','5.00','6.75']){
   f.view.amount.value=amount;f.view.cashConfirmed.value=true;await f.view.save();expect(f.view.source.value).toBeNull();
   if(amount!=='6.75'){const count=f.calls.length;await f.view.load();expect(f.calls.length).toBe(count+1);expect(f.view.source.value.kind).toBe('money');expect(content(f.host)).toContain('本次只补退货款');}
  }expect(writes(f).map((c:any)=>JSON.parse(c.data).refund_price)).toEqual(['7.00','5.00','6.75']);expect(new Set(writes(f).map((c:any)=>JSON.parse(c.data).operation_id)).size).toBe(3);
  }finally{f.close();}
 });
 it('returns balance money without claiming a cash handoff',async()=>{
  const f=await mount(undefined,(config,fixture)=>{if(config.method==='get'){fixture.current=seed({pay_type:'yue',settlement:'balance'});return fixture.current;}});
  try{expect(content(f.host)).toContain('退回买家的账户余额');expect(walk(f.host).some(n=>n.tag==='el-checkbox')).toBe(false);f.view.amount.value='5.00';await f.view.save();
   expect(writes(f)).toHaveLength(1);expect(JSON.parse(writes(f)[0].data)).not.toHaveProperty('cash_returned');expect(f.view.receipt.value.result.status).toBe('BALANCE_SUCCESS');
  }finally{f.close();}
 });
 it('confirms a genuine refusal with no cash flag and displays the actual refusal result',async()=>{
  const f=await mount();try{f.view.cashConfirmed.value=true;f.view.action.value=2;expect(f.view.cashConfirmed.value).toBe(false);await f.view.save();
   expect(JSON.parse(writes(f)[0].data)).toMatchObject({type:2});expect(JSON.parse(writes(f)[0].data)).not.toHaveProperty('cash_returned');expect(content(f.host)).toContain('本次退款已拒绝');
  }finally{f.close();}
 });
 it('keeps the completed goods7 and existing money totals when refusing, explicitly reloading, paying5 and refusing again',async()=>{
  const f=await mount();try{
   f.view.amount.value='7.00';f.view.cashConfirmed.value=true;await f.view.save();
   expect(f.fixture.current).toMatchObject({kind:'money',quantity:0,refunded:'7.00',refund_price:'11.75'});
   await f.view.load();f.view.cashConfirmed.value=true;f.view.action.value=2;f.view.amount.value='5.00';await flush();
   expect(f.view.cashConfirmed.value).toBe(false);expect(f.view.cashRequired.value).toBe(false);
   expect(walk(f.host).some(node=>node.tag==='el-option'&&node.props.value===2&&node.props.label==='拒绝本次补退')).toBe(true);
   expect(walk(f.host).some(node=>node.tag==='el-checkbox')).toBe(false);
   expect(content(f.host)).toContain('累计已退金额和已完成商品处理保持不变');
   const confirm=vi.spyOn(runtime.dialogs.ElMessageBox,'confirm');await f.view.save();
   expect(confirm.mock.calls[0][0]).toContain('累计已退');expect(confirm.mock.calls[0][0]).toContain('7.00');
   expect(f.fixture.current).toMatchObject({kind:'money',quantity:0,refunded:'7.00',refund_price:'11.75'});
   expect(f.view.receipt.value.result).toMatchObject({kind:'refuse',amount:'5.00',refund_id:null,status:'REFUSED'});
   expect(content(f.host)).toContain('本次未新增退款');expect(f.view.source.value).toBeNull();
   const beforeReload=f.calls.length;await f.view.load();expect(f.calls.length).toBe(beforeReload+1);
   expect(f.view.source.value).toMatchObject({kind:'money',refunded:'7.00',amount:'11.75',quantity:0});
   expect(f.view.action.value).toBe(1);f.view.amount.value='5.00';await f.view.save();expect(writes(f)).toHaveLength(2);
   f.view.cashConfirmed.value=true;await f.view.save();expect(f.fixture.current).toMatchObject({refunded:'12.00',refund_price:'6.75',quantity:0});
   await f.view.load();f.view.action.value=2;f.view.amount.value='2.00';await f.view.save();
   expect(f.fixture.current).toMatchObject({refunded:'12.00',refund_price:'6.75',quantity:0});
   const bodies=writes(f).map((config:any)=>JSON.parse(config.data));
   expect(bodies.map((body:any)=>[body.type,body.refund_price])).toEqual([[1,'7.00'],[2,'5.00'],[1,'5.00'],[2,'2.00']]);
   expect(bodies.filter((body:any)=>body.type===2).every((body:any)=>!Object.hasOwn(body,'cash_returned'))).toBe(true);
   expect(new Set(bodies.map((body:any)=>body.operation_id)).size).toBe(4);expect(sessionStorage.getItem(key())).toBeNull();
   await f.view.load();expect(f.view.source.value).toMatchObject({kind:'money',refunded:'12.00',amount:'6.75',quantity:0});
  }finally{f.close();}
 });
 it('retains the original lost post-goods refusal UUID and uses only GET recovery after manage withdrawal',async()=>{
  const f=await mount(undefined,(config,fixture)=>{if(config.method==='put'&&JSON.parse(config.data).type===2){fixture.apply(config);throw Error('owned committed refusal reply loss');}});
  let done:any,original:any;
  try{
   f.view.amount.value='7.00';f.view.cashConfirmed.value=true;await f.view.save();await f.view.load();
   f.view.action.value=2;f.view.amount.value='5.00';await f.view.save();done=f.fixture.receipt;
   original=JSON.parse(sessionStorage.getItem(key())!);expect(Object.keys(original).sort()).toEqual(['actor_id','operation_id','order_id','supplier_id']);
   expect(done).toMatchObject({...original,state:'committed',result:{kind:'refuse',amount:'5.00',refund_id:null,status:'REFUSED'}});
   expect(f.fixture.current).toMatchObject({refunded:'7.00',refund_price:'11.75',quantity:0});
   expect(JSON.parse(writes(f)[1].data)).not.toHaveProperty('cash_returned');expect(content(f.host)).toContain('退款结果待确认');
   const count=f.calls.length;await f.view.load();await f.view.save();expect(f.calls.length).toBe(count);expect(writes(f)).toHaveLength(2);
  }finally{f.close();}
  localStorage.setItem('supplier-permissions','["supplier.order.view"]');
  const recovered=await mount('/orders/refund-result');try{
   recovered.fixture.receipt=done;expect(recovered.calls).toEqual([]);expect(recovered.view.canWrite.value).toBe(false);
   expect(recovered.view.pending.value).toEqual(original);await recovered.view.recover(false);
   expect(recovered.calls.map((config:any)=>[config.method,config.url])).toEqual([['get','/order/refund_operations/'+original.operation_id]]);
   expect(recovered.view.receipt.value).toMatchObject({...original,state:'committed',result:{kind:'refuse',amount:'5.00'}});
   expect(content(recovered.host)).toContain('本次未新增退款');expect(sessionStorage.getItem(key())).toBeNull();
   await recovered.view.save();expect(writes(recovered)).toEqual([]);expect(recovered.calls).toHaveLength(1);
  }finally{recovered.close();}
 });
 it.each(['0.00','11.76'])('rejects money refusal amount %s before confirmation, UUID persistence or dispatch',async amount=>{
  const f=await mount(undefined,config=>config.method==='get'?seed({kind:'money',quantity:0,refunded:'7.00',refund_price:'11.75'}):undefined);
  try{
   f.view.action.value=2;f.view.amount.value=amount;const confirm=vi.spyOn(runtime.dialogs.ElMessageBox,'confirm');await f.view.save();
   expect(confirm).not.toHaveBeenCalled();expect(writes(f)).toEqual([]);expect(sessionStorage.getItem(key())).toBeNull();
   expect(f.view.error.value).toContain('退款金额须在当前可退金额内');expect(f.view.source.value.refunded).toBe('7.00');
  }finally{f.close();}
 });
 it('keeps a lost committed reply pending across reload and recovers only by GET after manage permission is withdrawn',async()=>{
  const f=await mount(undefined,(config,fixture)=>{if(config.method==='put'){fixture.apply(config);throw Error('owned post-commit reply loss');}});let done:any;
  try{f.view.amount.value='7.00';f.view.cashConfirmed.value=true;await f.view.save();done=f.fixture.receipt;expect(content(f.host)).toContain('退款结果待确认');await f.view.save();expect(writes(f)).toHaveLength(1);}finally{f.close();}
  localStorage.setItem('supplier-permissions','[]');const recovered=await mount('/orders/refund-result');try{recovered.fixture.receipt=done;expect(recovered.calls).toEqual([]);await recovered.view.recover(false);
   expect(recovered.calls.map((c:any)=>c.method)).toEqual(['get']);expect(recovered.view.receipt.value.result.amount).toBe('7.00');expect(sessionStorage.getItem(key())).toBeNull();
  }finally{recovered.close();}
 });
 it('preserves another order original UUID and never fetches a new quote or writes for the newly visited order',async()=>{
  sessionStorage.setItem(key(),JSON.stringify(marker()));const f=await mount('/orders/81/refund');try{expect(f.view.pending.value.order_id).toBe(80);expect(f.calls).toEqual([]);await f.view.save();expect(f.calls).toEqual([]);}finally{f.close();}
 });
 it('leaves an unknown original request pending until explicit resolution and does not auto-resubmit after not-applied',async()=>{
  sessionStorage.setItem(key(),JSON.stringify(marker()));const f=await mount('/orders/refund-result');try{await f.view.recover(false);expect(f.view.pending.value).not.toBeNull();await f.view.recover(true);
   expect(f.calls.map((c:any)=>c.method)).toEqual(['get','post']);expect(writes(f)).toEqual([]);expect(f.view.pending.value).toBeNull();expect(f.view.source.value).toBeNull();await flush();
   expect(walk(f.host).some(node=>node.tag==='el-alert'&&String(node.props.title).includes('原操作已确认未提交'))).toBe(true);
  }finally{f.close();}
 });
 it('does not dispatch when storing the original identity fails',async()=>{
  const f=await mount();try{f.view.cashConfirmed.value=true;vi.spyOn(sessionStorage,'setItem').mockImplementation(()=>{throw Error('owned storage blocked');});await f.view.save();expect(writes(f)).toEqual([]);expect(f.view.storageError.value).toContain('storage blocked');}finally{f.close();}
 });
 it('requires a new physical cash acknowledgement after the amount changes',async()=>{
  const f=await mount();try{f.view.cashConfirmed.value=true;f.view.amount.value='7.00';expect(f.view.cashConfirmed.value).toBe(false);await f.view.save();expect(writes(f)).toEqual([]);
   f.view.cashConfirmed.value=true;await f.view.save();expect(writes(f)).toHaveLength(1);
  }finally{f.close();}
 });
 it.each(['amount','kind','actor','order'])('rejects a mismatching %s receipt and retains the original pending identity',async change=>{
  const f=await mount(undefined,(config,fixture)=>{if(config.method==='put'){const response=fixture.apply(config);if(change==='amount')response.result.amount='1.00';if(change==='kind'){response.result.kind='refuse';response.result.status='REFUSED';response.result.refund_id=null;}if(change==='actor')response.actor_id=22;if(change==='order')response.order_id=81;return response;}});
  try{f.view.amount.value='7.00';f.view.cashConfirmed.value=true;await f.view.save();expect(writes(f)).toHaveLength(1);expect(f.view.pending.value).not.toBeNull();expect(sessionStorage.getItem(key())).not.toBeNull();expect(f.view.receipt.value).toBeNull();}finally{f.close();}
 });
 it.each(['amount','action','route','session'])('invalidates an open confirmation when %s changes, including session A-to-B-to-A',async change=>{
  const wait=gate(),f=await mount();try{f.view.cashConfirmed.value=true;vi.spyOn(runtime.dialogs.ElMessageBox,'confirm').mockImplementation(()=>wait.promise);const saving=f.view.save();
   if(change==='amount')f.view.amount.value='1.00';if(change==='action')f.view.action.value=2;if(change==='route')await f.router.push('/away');
   if(change==='session'){localStorage.setItem('supplier-token','owned-B');surface.dispatchEvent(new Event('supplier-session-changed'));localStorage.setItem('supplier-token','owned-order-edit-token');surface.dispatchEvent(new Event('supplier-session-changed'));}
   wait.resolve();await saving;expect(writes(f)).toEqual([]);expect(sessionStorage.getItem(key())).toBeNull();
  }finally{wait.resolve();f.close();}
 });
 it('cannot launch duplicate writes while confirmation or a dispatch is already pending',async()=>{
  const confirm=gate(),write=gate(),f=await mount(undefined,c=>c.method==='put'?write.promise:undefined);
  try{f.view.cashConfirmed.value=true;vi.spyOn(runtime.dialogs.ElMessageBox,'confirm').mockImplementation(()=>confirm.promise);const saving=f.view.save();await f.view.save();confirm.resolve();await flush();await f.view.save();expect(writes(f)).toHaveLength(1);
   write.resolve(receipt(JSON.parse(sessionStorage.getItem(key())!),'committed','18.75'));await saving;
  }finally{confirm.resolve();write.resolve();f.close();}
 });
 it.each(['resolve','cancel'])('drops the old quote during A-to-B-to-A navigation while an old confirmation later %s',async outcome=>{
  const wait=gate(),f=await mount(undefined,c=>c.method==='get'&&!c.url.includes('refund_operations/')?seed({order_id:Number(c.url.split('/').at(-1)),action:c.url,order_no:'wxOwned'+c.url.split('/').at(-1)}):undefined);
  try{f.view.cashConfirmed.value=true;vi.spyOn(runtime.dialogs.ElMessageBox,'confirm').mockImplementation(()=>wait.promise);const saving=f.view.save();
   await f.router.push('/orders/81/refund');await flush();expect(f.view.source.value.order_id).toBe(81);expect(f.view.cashConfirmed.value).toBe(false);
   await f.router.push('/orders/80/refund');await flush();expect(f.view.source.value.order_id).toBe(80);expect(f.view.cashConfirmed.value).toBe(false);
   // Both modal outcomes must invalidate its old ticket even though the URL
   // has returned to its initial value and a new current quote exists.
   if(outcome==='cancel')wait.resolve(Promise.reject(Error('owned modal cancellation')));else wait.resolve();
   await saving;expect(writes(f)).toEqual([]);expect(sessionStorage.getItem(key())).toBeNull();expect(f.view.source.value.order_id).toBe(80);
  }finally{wait.resolve();f.close();}
 });
 it('does not expose write controls to a view-only account, even at a manually typed write route',async()=>{
  localStorage.setItem('supplier-permissions','["supplier.order.view"]');const f=await mount();try{expect(f.view.canWrite.value).toBe(false);f.view.cashConfirmed.value=true;await f.view.save();expect(writes(f)).toEqual([]);}finally{f.close();}
 });
 it('retains malformed or foreign local records instead of clearing an uncertain operation',async()=>{
  sessionStorage.setItem(key(),JSON.stringify({...marker(),supplier_id:8}));const f=await mount('/orders/refund-result');try{await f.view.recover(false);await f.view.save();expect(f.calls).toEqual([]);expect(f.view.storageError.value).toBeTruthy();expect(sessionStorage.getItem(key())).not.toBeNull();}finally{f.close();}
 });
 it('omits the cash claim when completing an actual zero-value order',async()=>{
  const f=await mount(undefined,c=>c.method==='get'?seed({paid:'0.00',refunded:'0.00',refund_price:'0.00',settlement:'zero'}):undefined);try{await f.view.save();expect(writes(f)).toHaveLength(1);expect(JSON.parse(writes(f)[0].data)).not.toHaveProperty('cash_returned');expect(f.view.receipt.value.result.status).toBe('ZERO_SUCCESS');}finally{f.close();}
 });
});

describe('strict proactive quote, amount and result boundaries',()=>{
 it('rejects wrong-order, wrong-action, inconsistent-budget and fake money quantities',()=>{
  for(const change of [{order_id:81},{action:'/refund/manual/80'},{refund_price:'19.00'},{kind:'money',quantity:3}])expect(()=>runtime.api.parseProactiveRefundSeed(seed(change),80)).toThrow();
 });
 it('uses exact decimal cents and cash acknowledgement without a client chosen channel',()=>{
  const source=runtime.api.parseProactiveRefundSeed(seed(),80);
  expect(runtime.api.proactiveRefundPayload(source,marker(),'07.1',1,true)).toMatchObject({refund_price:'7.10',cash_returned:true});
  for(const value of ['18.76','0','-1','7.001','1e1','1,00'])expect(()=>runtime.api.proactiveRefundPayload(source,marker(),value,1,true)).toThrow();
  expect(()=>runtime.api.proactiveRefundPayload(source,marker(),'7',1,false)).toThrow();
 });
 it('keeps provider payouts unavailable and permits bounded money refusals without a cash claim',()=>{
  const provider=runtime.api.parseProactiveRefundSeed(seed({pay_type:'weixin',settlement:'provider'}),80);
  expect(()=>runtime.api.proactiveRefundPayload(provider,marker(),'7',1,false)).toThrow('原渠道');
  expect(runtime.api.proactiveRefundPayload(provider,marker(),'7',2,false)).not.toHaveProperty('cash_returned');
  const money=runtime.api.parseProactiveRefundSeed(seed({kind:'money',quantity:0,refunded:'7.00',refund_price:'11.75'}),80);
  expect(runtime.api.proactiveRefundPayload(money,marker(),'5',2,false)).toEqual({operation_id:marker().operation_id,revision:'a'.repeat(64),refund_price:'5.00',type:2});
  expect(runtime.api.proactiveRefundPayload(money,marker(),'5',2,true)).not.toHaveProperty('cash_returned');
  expect(()=>runtime.api.proactiveRefundPayload(money,marker(),'5',1,false)).toThrow('现金');
 });
 it('rejects extraneous local authority fields and impossible committed result combinations',()=>{
  expect(()=>runtime.api.parsePendingProactiveRefund({...marker(),cash_returned:true},21,7)).toThrow();
  for(const result of [{...receipt().result,refund_id:null},{...receipt().result,amount:'0.00'},{...receipt().result,kind:'money',amount:'0.00',status:'ZERO_SUCCESS'}])
   expect(()=>runtime.api.parseProactiveRefundReceipt({...receipt(),result},marker())).toThrow();
 });
});
