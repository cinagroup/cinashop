/** Compile and render the actual Admin SFC, request scope and shared closed
 * parser. Only Element controls, HTTP transport and the unrelated creator are
 * isolated; settlement reads never enter the write/recovery storage protocol. */
import {afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'../../view/admin-ts'),require=createRequire(resolve(root,'package.json'));
const {parse,compileScript,compileTemplate}=require('@vue/compiler-sfc');
let runtime:any,surface:EventTarget;
beforeAll(async()=>{
 const result=await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`import Page from './src/pages/refund/RefundList.vue';
  export {Page};export const captured={};const setup=Page.setup;Page.setup=(p,c)=>{const view=setup(p,c);captured.view=view;return view;};
  export * as api from './src/api/refund';export * as auth from './src/utils/auth';export * as ops from './src/utils/refundOperation';
  export {createRenderer,h,nextTick} from 'vue';export {createRouter,createMemoryHistory,RouterView} from 'vue-router';`},
  alias:{'@':resolve(root,'src')},define:{'import.meta.env.DEV':'false','__VUE_OPTIONS_API__':'true',
   '__VUE_PROD_DEVTOOLS__':'false','__VUE_PROD_HYDRATION_MISMATCH_DETAILS__':'false'},
  bundle:true,write:false,platform:'browser',format:'esm',plugins:[{name:'actual-admin-settlement',setup(builder){
   builder.onLoad({filter:/\.vue$/},({path})=>{
    if(path.endsWith('/RefundCreation.vue'))return{contents:'export default {render:()=>null};',loader:'ts'};
    const descriptor=parse(readFileSync(path,'utf8'),{filename:path}).descriptor,
     script=compileScript(descriptor,{id:'owned-admin-settlement',genDefaultAs:'__Page'}),
     template=compileTemplate({source:descriptor.template.content,filename:path,id:'owned-admin-settlement',
      compilerOptions:{bindingMetadata:script.bindings,expressionPlugins:['typescript']}});
    if(template.errors.length)throw Error(String(template.errors));
    return{contents:`${script.content}\n${template.code}\n__Page.render=render;export default __Page;`,loader:'ts'};
   });
   builder.onResolve({filter:/^element-plus$/},()=>({path:'controls',namespace:'fixture'}));
   builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const ElMessage={success:()=>{},warning:()=>{},error:()=>{}};
    export const ElMessageBox={confirm:async()=>{},prompt:async()=>({value:'本地原因'}),close:()=>{}};`}));
  }}]});
 runtime=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
},30000);
function login(permissions=['refund.view'],id=100){
 localStorage.setItem('admin_token','owned-admin-token-'+id);
 localStorage.setItem('admin_session',JSON.stringify({userInfo:{id,level:1,account:'owned-admin-'+id},menus:[],uniqueAuth:permissions}));
}
beforeEach(()=>{
 const values=new Map<string,string>();surface=new EventTarget();
 vi.stubGlobal('window',Object.assign(surface,{location:{search:'',pathname:'/refund',href:''}}));
 vi.stubGlobal('localStorage',{getItem:(name:string)=>values.get(name)??null,setItem:(name:string,value:string)=>values.set(name,value),removeItem:(name:string)=>values.delete(name)});
 vi.stubGlobal('navigator',{locks:{request:async(_name:string,_options:unknown,work:(lock:unknown)=>Promise<unknown>)=>work({})}});
 login();
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const detail=(id=25,changes:Record<string,unknown>={})=>({id,storeOrderId:id+100,orderId:'SRGoods'+id,originalOrderId:'wxOwned'+id,
 uid:11,storeId:0,supplierId:7,applyType:4,applyPrice:'7.00',refundType:6,refundNum:3,refundPrice:'7.00',refundedPrice:'7.00',
 refundReason:'实际商品退款',isCancel:0,isDel:0,addTime:1700000000,refundedTime:1700000001,payType:'offline',providerStatus:null,
 refundExplain:'本地核验',refuseReason:'',refundExpress:'',refundExpressName:'',refundPhone:'',refundGoodsExplain:'',
 returnImages:[],returnImagesError:'',returnContact:{source:'supplier',name:'收件人',phone:'',address:''},...changes});
const summary=(id=25,changes:Record<string,unknown>={})=>({version:'supplier-refund-settlement-v1',state:'verified',
 order_id:id+100,order_no:'wxOwned'+id,uid:11,supplier_id:7,store_id:0,refund_id:id,refund_no:'SRGoods'+id,pay_type:'offline',
 paid:'18.75',goods_refunded:'7.00',money_refunded:'5.00',refunded:'12.00',available:'6.75',money_payouts:1,...changes});
const gate=()=>{let resolve!:(value:any)=>void;return{promise:new Promise<any>(done=>{resolve=done;}),resolve};};
const flush=async()=>{for(let i=0;i<40;i++){await Promise.resolve();await runtime.nextTick();}};
type Node={tag?:string;text?:string;children:Node[];props:Record<string,any>;parent?:Node};
const content=(node:Node):string=>(node.text??'')+node.children.map(content).join('');
const walk=(node:Node):Node[]=>[node,...node.children.flatMap(walk)];
async function mount(override:(config:any)=>unknown=()=>undefined){
 const calls:any[]=[];
 runtime.api.refundRequest.defaults.adapter=async(config:any)=>{
  calls.push(config);let value=await override(config);
  if(value===undefined){const id=Number(config.url.split('/').at(-1));
   value={status:200,msg:'owned transport',data:config.url==='/refund/list'?{list:[detail(32),detail(25)],limit:20,nextCursor:null}:
    config.url.startsWith('/refund/settlement/')?summary(id):detail(id)};
  }
  return{config,data:value,status:200,statusText:'owned',headers:{}};
 };
 const host:Node={children:[],props:{}};
 const renderer=runtime.createRenderer({createElement:(tag:string)=>({tag,children:[],props:{}}),
  createText:(text:string)=>({text,children:[],props:{}}),createComment:()=>({children:[],props:{}}),
  insert(node:Node,parent:Node,anchor?:Node){if(node.parent)node.parent.children=node.parent.children.filter(value=>value!==node);
   node.parent=parent;const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,node);},
  remove(node:Node){if(node.parent)node.parent.children=node.parent.children.filter(value=>value!==node);},
  parentNode:(node:Node)=>node.parent,nextSibling:(node:Node)=>node.parent?.children[node.parent.children.indexOf(node)+1]??null,
  patchProp(node:Node,name:string,_old:unknown,value:unknown){node.props[name]=value;},
  setText(node:Node,value:string){node.text=value;},setElementText(node:Node,value:string){node.text=value;node.children=[];}});
 const router=runtime.createRouter({history:runtime.createMemoryHistory(),routes:[{path:'/refund',component:runtime.Page},{path:'/away',component:{render:()=>null}}]});
 const app=renderer.createApp({render:()=>runtime.h(runtime.RouterView)});app.use(router);app.directive('loading',{});
 for(const name of new Set([...readFileSync(resolve(root,'src/pages/refund/RefundList.vue'),'utf8').matchAll(/<(el-[a-z-]+)/g)].map(match=>match[1])))
  app.component(name,{inheritAttrs:false,setup(_:unknown,{slots,attrs}:any){return()=>{
   if(name==='el-table-column'||name==='el-dialog'&&!attrs.modelValue)return null;
   return runtime.h(name==='el-button'?'button':name,attrs,name==='el-alert'?attrs.title:slots.default?.());
  };}});
 await router.push('/refund');app.mount(host);await flush();
 return{view:runtime.captured.view,calls,host,router,close:()=>app.unmount()};
}
const reads=(f:any)=>f.calls.filter((row:any)=>row.url.startsWith('/refund/settlement/'));
const writes=(f:any)=>f.calls.filter((row:any)=>row.method!=='get');
const card=(f:any)=>walk(f.host).find(node=>node.props['aria-label']==='供应商累计退款核验');

describe('actual Admin independent Supplier settlement read surface',()=>{
 it('lets a refund.view account explicitly read closed actual totals without changing the first application or write state',async()=>{
  const f=await mount();try{
   await f.view.openRefund({id:25});await flush();expect(reads(f)).toHaveLength(0);expect(f.view.canManage.value).toBe(false);
   expect(f.view.canVerifySettlement.value).toBe(true);expect(content(card(f)!)).toContain('尚未核验');
   const before=JSON.stringify(f.view.current.value);await f.view.verifySettlement();await flush();
   expect(reads(f)).toHaveLength(1);expect(reads(f)[0]).toMatchObject({url:'/refund/settlement/25',method:'get'});
   expect(reads(f)[0].params).toBeUndefined();expect(reads(f)[0].data).toBeUndefined();
   expect(reads(f)[0].headers['Authori-zation']).toBe('Bearer owned-admin-token-100');
   expect(reads(f)[0].headers['Idempotency-Key']).toBeUndefined();expect(writes(f)).toEqual([]);
   expect(JSON.stringify(f.view.current.value)).toBe(before);expect(f.view.current.value.refundPrice).toBe('7.00');
   expect(f.view.canWrite.value).toBe(false);expect(f.view.pendingIntent.value).toBeNull();
   expect(localStorage.getItem(runtime.ops.refundOperationKey(100,25))).toBeNull();
   const text=content(card(f)!);for(const value of ['累计退款已核验','原付款金额','¥18.75','商品退款','¥7.00','补退货款','¥5.00','累计已退','¥12.00','可退余款','¥6.75','货款补退次数'])expect(text).toContain(value);
  }finally{f.close();}
 });
 it('clears the previous success during an explicit reread and shows the exact final remainder zero',async()=>{
  const wait=gate();let count=0;const f=await mount(config=>config.url==='/refund/settlement/25'&&++count===2?wait.promise:undefined);
  try{await f.view.openRefund({id:25});await f.view.verifySettlement();expect(f.view.settlement.value.available).toBe('6.75');
   const next=f.view.verifySettlement();await flush();expect(f.view.settlement.value).toBeNull();expect(content(card(f)!)).toContain('金额尚未确认');
   await f.view.verifySettlement();expect(reads(f)).toHaveLength(2);
   wait.resolve({status:200,data:summary(25,{money_refunded:'11.75',refunded:'18.75',available:'0.00',money_payouts:2})});await next;await flush();
   expect(f.view.settlement.value.available).toBe('0.00');expect(content(card(f)!)).toContain('¥0.00');expect(writes(f)).toEqual([]);
  }finally{f.close();}
 });
 it.each([409,503])('keeps the original detail and publishes no total after actual envelope status %s',async status=>{
  let fail=false;const f=await mount(config=>config.url==='/refund/settlement/25'&&fail?{status,msg:'完整凭据暂不可核验',data:null}:undefined);
  try{await f.view.openRefund({id:25});await f.view.verifySettlement();fail=true;await f.view.verifySettlement();await flush();
   expect(f.view.current.value.refundPrice).toBe('7.00');expect(f.view.settlement.value).toBeNull();
   expect(f.view.settlementError.value).toContain('尚未完成累计退款核验');expect(content(card(f)!)).not.toContain('累计退款已核验');expect(writes(f)).toEqual([]);
  }finally{f.close();}
 });
 it.each(['order_id','order_no','uid','supplier_id','store_id','refund_id','refund_no','goods_refunded','pay_type','extra','arithmetic'])(
  'rejects a %s mismatch through the actual API parser without changing original detail',async field=>{
   const invalid=summary();if(field==='extra')(invalid as any).operation_id='private';
   else if(field==='arithmetic')invalid.available='7.00';
   else (invalid as any)[field]=field==='pay_type'?'yue':typeof (invalid as any)[field]==='number'?(invalid as any)[field]+1:'wrong';
   const f=await mount(config=>config.url==='/refund/settlement/25'?{status:200,data:invalid}:undefined);
   try{await f.view.openRefund({id:25});await f.view.verifySettlement();
    expect(f.view.settlement.value).toBeNull();expect(f.view.settlementError.value).toContain('尚未完成');expect(f.view.current.value.orderId).toBe('SRGoods25');expect(writes(f)).toEqual([]);
   }finally{f.close();}
  });
 it.each(['close','switch','route','session-aba'] as const)('aborts and discards a delayed read after %s invalidates its owner',async kind=>{
  const wait=gate();const f=await mount(config=>config.url==='/refund/settlement/25'?wait.promise:undefined);
  try{await f.view.openRefund({id:25});const pending=f.view.verifySettlement();await flush();const request=reads(f)[0];
   if(kind==='close')f.view.detailOpen.value=false;
   else if(kind==='switch')await f.view.openRefund({id:32});
   else if(kind==='route')await f.router.push('/away');
   else{runtime.auth.setToken('other-token');runtime.auth.setToken('owned-admin-token-100');}
   expect(request.signal.aborted).toBe(true);expect(f.view.settlement.value).toBeNull();
   wait.resolve({status:200,data:summary()});await pending;expect(f.view.settlement.value).toBeNull();expect(f.view.settlementError.value).toBe('');expect(writes(f)).toEqual([]);
  }finally{f.close();}
 });
 it('cannot let a delayed A response replace a newer B then A verification',async()=>{
  const wait=gate();let count=0;const f=await mount(config=>config.url==='/refund/settlement/25'&&++count===1?wait.promise:undefined);
  try{await f.view.openRefund({id:25});const old=f.view.verifySettlement();await flush();
   await f.view.openRefund({id:32});await f.view.verifySettlement();expect(f.view.settlement.value.refund_id).toBe(32);
   await f.view.openRefund({id:25});expect(f.view.settlement.value).toBeNull();await f.view.verifySettlement();
   wait.resolve({status:200,data:summary(25,{money_refunded:'0.00',refunded:'7.00',available:'11.75',money_payouts:0})});await old;
   expect(f.view.settlement.value.refunded).toBe('12.00');expect(f.view.settlement.value.available).toBe('6.75');expect(writes(f)).toEqual([]);
  }finally{f.close();}
 });
 it('ignores old auth-expiry after session A to B to A and never logs out the replacement session',async()=>{
  const wait=gate(),f=await mount(config=>config.url==='/refund/settlement/25'?wait.promise:undefined);
  try{await f.view.openRefund({id:25});const pending=f.view.verifySettlement();await flush();runtime.auth.setToken('other-token');runtime.auth.setToken('owned-admin-token-100');
   wait.resolve({status:410001,msg:'old auth expired',data:null});await pending;
   expect(localStorage.getItem('admin_token')).toBe('owned-admin-token-100');expect(f.view.current.value).toBeNull();expect(f.view.settlement.value).toBeNull();expect(writes(f)).toEqual([]);
  }finally{f.close();}
 });
 it('requires refund.view even if the readonly handler is invoked directly',async()=>{
  login(['order.view']);const f=await mount();try{await f.view.openRefund({id:25});expect(card(f)).toBeUndefined();
   await f.view.verifySettlement();expect(reads(f)).toEqual([]);expect(writes(f)).toEqual([]);
  }finally{f.close();}
 });
 it.each([{supplierId:0},{refundType:0},{isCancel:1},{applyType:1},{payType:'weixin'}])('does not infer verified settlement eligibility from unsupported detail %j',async changes=>{
  const f=await mount(config=>config.url==='/refund/detail/25'?{status:200,data:detail(25,changes)}:undefined);
  try{await f.view.openRefund({id:25});expect(f.view.settlementCandidate.value).toBe(false);await f.view.verifySettlement();expect(reads(f)).toEqual([]);expect(writes(f)).toEqual([]);
  }finally{f.close();}
 });
 it('clears a verified summary when the same detail is refreshed',async()=>{
  const f=await mount();try{await f.view.openRefund({id:25});await f.view.verifySettlement();await f.view.readCurrent();
   expect(f.view.current.value.id).toBe(25);expect(f.view.settlement.value).toBeNull();expect(reads(f)).toHaveLength(1);
  }finally{f.close();}
 });
 it('clears a verified summary when an existing pending recovery starts and preserves that original record',async()=>{
  login(['refund.view','refund.manage']);
  const intent=await runtime.ops.makeRefundOperation(100,detail(25,{refundType:0}),'refund','',false),
   raw=runtime.ops.writeRefundOperation(intent,null),wait=gate();
  const f=await mount(config=>config.url==='/refund/operations/receipt'?wait.promise:undefined);
  try{await f.view.openRefund({id:25});await f.view.verifySettlement();expect(f.view.settlement.value.refunded).toBe('12.00');
   const recovering=f.view.recoverPending('receipt');await flush();expect(f.view.settlement.value).toBeNull();
   wait.resolve({status:503,msg:'原回执暂不可读取',data:null});await recovering;
   expect(localStorage.getItem(runtime.ops.refundOperationKey(100,25))).toBe(raw);
   expect(reads(f)).toHaveLength(1);expect(f.calls.filter(row=>row.url.includes('/execute/'))).toEqual([]);
  }finally{f.close();}
 });
});
