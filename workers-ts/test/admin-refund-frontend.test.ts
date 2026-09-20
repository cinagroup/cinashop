import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
let runtime: any, surface: EventTarget;
const root = resolve(import.meta.dirname, '../../view/admin-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Component } from './src/pages/refund/RefundList.vue';
    export { default as CreationComponent } from './src/pages/refund/RefundCreation.vue';
    export * as creation from './src/utils/refundCreation';
    export * as api from './src/api/refund'; export * as auth from './src/utils/auth'; export * as dialog from 'element-plus'; export * as intents from './src/utils/refundIntent'; export * as ops from './src/utils/refundOperation';
    export { createRenderer, h, nextTick } from 'vue'; export { createRouter, createMemoryHistory, RouterView } from 'vue-router';
  ` }, alias: { '@': resolve(root,'src') }, define: { 'import.meta.env.DEV':'false' }, plugins: [{ name:'actual-admin-refund', setup(builder) {
    builder.onLoad({filter:/\.vue$/},({path})=>({contents:compileScript(parse(readFileSync(path,'utf8'),{filename:path}).descriptor,{id:'admin-refund-test'}).content,loader:'ts'}));
    builder.onResolve({filter:/^element-plus$/},()=>({path:'dialogs',namespace:'fixture'}));
    builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const state={confirm:async()=>{},prompt:async()=>({value:'不满足退款条件'}),messages:[]};
      export const ElMessage={success:m=>state.messages.push(['success',m]),warning:m=>state.messages.push(['warning',m]),error:m=>state.messages.push(['error',m])};
      export const ElMessageBox={confirm:(...a)=>state.confirm(...a),prompt:(...a)=>state.prompt(...a),close:()=>{}};`}));
  }}], bundle:true,write:false,platform:'browser',format:'esm' });
  runtime=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
});
function login(readOnly=false) {
  localStorage.setItem('admin_token','local-token-a');
  localStorage.setItem('admin_session',JSON.stringify({userInfo:{id:100,level:1,account:'local-admin'},menus:[],uniqueAuth:readOnly?['refund.view']:['refund.view','refund.manage']}));
}
beforeEach(()=>{
  const values=new Map<string,string>(); surface=new EventTarget();
  vi.stubGlobal('window',Object.assign(surface,{location:{search:'',pathname:'/refund',href:''}}));
  vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});
  const locks = new Set<string>();
  vi.stubGlobal('navigator',{locks:{request:async(name:string, _options:unknown, callback:(lock:unknown)=>Promise<unknown>)=>{
    if (locks.has(name)) return callback(null);
    locks.add(name); try { return await callback({name}); } finally { locks.delete(name); }
  }}});
  login();runtime.dialog.state.messages=[];runtime.dialog.state.confirm=async()=>{};runtime.dialog.state.prompt=async()=>({value:'不满足退款条件'});
});
afterEach(()=>vi.unstubAllGlobals());
const detail=(id=25,changes={})=>({id,storeOrderId:id,orderId:'R'+id,originalOrderId:'O'+id,uid:11,storeId:0,supplierId:0,applyType:2,applyPrice:'5.00',refundType:5,refundNum:1,
  refundPrice:'5.00',refundedPrice:'0.00',refundReason:'本地原因',isCancel:0,isDel:0,addTime:1700000000,refundedTime:0,payType:'yue',providerStatus:null,
  refundExplain:'申请说明',refuseReason:'',refundExpress:'LOCAL-'+id,refundExpressName:'本地快递',refundPhone:'000000',refundGoodsExplain:'用户退货备注',
  returnImages:[],returnImagesError:'',returnContact:{source:'platform',name:'本地收件人',phone:'000000',address:'本地地址'},...changes});
const gate=()=>{let resolve!:(value?:any)=>void;return{promise:new Promise<any>(r=>{resolve=r}),resolve};};
const flush=async()=>{for(let i=0;i<40;i++){await new Promise(resolve=>setTimeout(resolve,1));await runtime.nextTick();}};
function operationResponse(config:any, outcome?:string, execution?:unknown) {
  const key=config.headers['Idempotency-Key'];
  const id=config.url.endsWith('/receipt')?25:Number(config.url.split('/').at(-1));
  const intent=JSON.parse(localStorage.getItem(runtime.ops.refundOperationKey(100,id))!);
  const actual=outcome??({return:'return-approved',refuse:'refused',refund:'provider-admitted'}[intent.action as string]);
  const receipt={version:'admin-refund-operation-v1',adminId:100,requestKey:key,requestHash:intent.requestHash,refundId:id,action:intent.action,outcome:actual};
  return {status:200,data:{version:'admin-refund-operation-v1',receipt,...(config.url.includes('/execute/')?{replayed:false,execution:execution??(actual==='provider-admitted'?{completed:false,status:'PROCESSING'}:actual==='balance-settled'?{completed:true,status:'BALANCE_SUCCESS'}:null)}:{})}};
}
async function mount(override:(c:any)=>unknown=()=>undefined, creation=false){
  const calls:any[]=[];let view:any;
  runtime.api.refundRequest.defaults.adapter=async(config:any)=>{
    calls.push(config);const value=await override(config)??(config.method==='post'?operationResponse(config):{status:200,data:config.url==='/refund/list'?{list:[detail(32),detail(25)],limit:20,nextCursor:null}:detail(Number(config.url.split('/').at(-1)))});
    return {config,data:value,status:200,statusText:'local fixture',headers:{}};
  };
  const router=runtime.createRouter({history:runtime.createMemoryHistory(),routes:[{path:'/refund',component:{setup(p:unknown,c:unknown){view=(creation?runtime.CreationComponent:runtime.Component).setup(p,c);return()=>null;}}},{path:'/away',component:{render:()=>null}}]});
  const renderer=runtime.createRenderer({createElement:()=>({children:[]}),createText:(text:string)=>({text}),createComment:(text:string)=>({text}),
    insert(n:any,p:any){n.parent=p;(p.children??=[]).push(n);},remove(){},parentNode:(n:any)=>n.parent,nextSibling:()=>null,patchProp(){},setText(){},setElementText(){}});
  const app=renderer.createApp({render:()=>runtime.h(runtime.RouterView)});app.use(router);await router.push('/refund');app.mount({children:[]});await flush();
  return {view,calls,router,writes:()=>calls.filter(c=>c.method==='post'&&!c.url.endsWith('/receipt')),close:()=>app.unmount()};
}
it('clears detail, evidence and receipt acknowledgement while another detail loads or closes',async()=>{
  const wait=gate(),f=await mount(c=>c.url==='/refund/detail/32'?wait.promise:undefined);
  try{await f.view.openRefund({id:25});f.view.received.value=true;const pending=f.view.openRefund({id:32});
    expect(f.view.current.value).toBeNull();expect(f.view.received.value).toBe(false);f.view.detailOpen.value=false;wait.resolve({status:200,data:detail(32)});await pending;expect(f.view.current.value).toBeNull();
  }finally{f.close();}
});
it('ignores delayed A -> B -> A responses',async()=>{
  const wait=gate();let count=0;const f=await mount(c=>c.url==='/refund/detail/25'&&++count===1?wait.promise:undefined);
  try{const old=f.view.openRefund({id:25});await flush();await f.view.openRefund({id:32});await f.view.openRefund({id:25});wait.resolve({status:200,data:detail(25,{refundGoodsExplain:'stale'})});await old;expect(f.view.current.value.refundGoodsExplain).toBe('用户退货备注');}finally{f.close();}
});
it.each(['error','wrong-id','missing','unsafe-image'])('fails closed with visible retry on %s detail',async kind=>{
  const f=await mount(c=>c.url==='/refund/detail/32'?{status:kind==='error'?500:200,msg:'local failure',data:kind==='wrong-id'?detail(25):kind==='missing'?detail(32,{returnImages:undefined}):detail(32,{returnImages:[{url:'javascript:alert(1)',src:'javascript:alert(1)'}]})}:undefined);
  try{await f.view.openRefund({id:25});await f.view.openRefund({id:32});expect(f.view.current.value).toBeNull();expect(f.view.detailError.value).toBeTruthy();await f.view.mutate('refund');expect(f.writes()).toHaveLength(0);}finally{f.close();}
});
it.each(['switch','close','session','route'])('does not dispatch after confirmation is invalidated by %s',async kind=>{
  const wait=gate(),f=await mount();runtime.dialog.state.confirm=()=>wait.promise;
  try{await f.view.openRefund({id:25});f.view.received.value=true;const action=f.view.mutate('refund');await flush();
    if(kind==='switch'){await f.view.openRefund({id:32});await f.view.openRefund({id:25});}
    if(kind==='close')f.view.detailOpen.value=false;if(kind==='session')surface.dispatchEvent(new Event('admin-session-changed'));if(kind==='route')await f.router.push('/away');
    wait.resolve();await action;expect(f.writes()).toHaveLength(0);
  }finally{f.close();}
});
it('freezes original reviewed identity and amount; one dispatch; PROCESSING never claims completion or permits resubmission',async()=>{
  const wait=gate(),f=await mount(c=>c.method==='post'?wait.promise:undefined);
  try{await f.view.openRefund({id:25});f.view.received.value=true;const action=f.view.mutate('refund');await flush();await f.view.mutate('refund');expect(f.writes()).toHaveLength(1);
    expect(JSON.parse(f.writes()[0].data)).toEqual({version:'admin-refund-operation-v1',action:'refund',review:{uid:11,storeOrderId:25,storeId:0,supplierId:0,orderId:'R25',refundPrice:'5.00'},decision:{applyType:2,refundType:5,received:true}});
    const stored=await runtime.ops.readRefundOperation(100,25);
    expect(f.writes()[0].headers['Idempotency-Key']).toBe(stored.intent.nonce);expect(f.writes()[0].headers['X-Refund-Operation-Scope']).toBe('v1:admin:100');
    wait.resolve(operationResponse(f.writes()[0]));await action;expect(runtime.dialog.state.messages).toContainEqual(['success','原操作已受理，尚未确认渠道结算；可显式重试原操作继续核对']);
    expect(runtime.dialog.state.messages).not.toContainEqual(['success','退款完成']);expect(f.view.uncertainIds.has(25)).toBe(true);expect(f.view.canWrite.value).toBe(false);
  }finally{f.close();}
});
it.each([null,{}, {completed:true,status:'PROCESSING'}])('persists ambiguous receipt %j across a remounted view, without retry',async receipt=>{
  const f=await mount(c=>c.method==='post'?{status:200,data:receipt}:undefined);
  await f.view.openRefund({id:25});f.view.received.value=true;await f.view.mutate('refund');expect(f.writes()).toHaveLength(1);await f.view.readCurrent();expect(f.view.canWrite.value).toBe(false);f.close();
  const reopened=await mount();try{await reopened.view.openRefund({id:25});reopened.view.received.value=true;await reopened.view.mutate('refund');expect(reopened.writes()).toHaveLength(0);expect(reopened.view.uncertainIds.has(25)).toBe(true);}finally{reopened.close();}
});
it('requires manage permission, actionable state and receipt acknowledgement even when handlers are invoked directly',async()=>{
  login(true);const f=await mount();try{await f.view.openRefund({id:25});f.view.received.value=true;for(const kind of ['refund','return','refuse'])await f.view.mutate(kind);expect(f.writes()).toHaveLength(0);}finally{f.close();}
  login();const second=await mount();try{await second.view.openRefund({id:25});await second.view.mutate('refund');expect(second.writes()).toHaveLength(0);await second.view.openRefund({id:32});}finally{second.close();}
  const cancelled=await mount(c=>c.url==='/refund/detail/25'?{status:200,data:detail(25,{isCancel:1})}:undefined);try{await cancelled.view.openRefund({id:25});cancelled.view.received.value=true;await cancelled.view.mutate('refund');expect(cancelled.writes()).toHaveLength(0);}finally{cancelled.close();}
});
it('sends same-origin return approval separately from monetary refund and verifies the refreshed state',async()=>{
  let approved=false;const f=await mount(c=>c.method==='post'?(approved=true,operationResponse(c)):c.url==='/refund/detail/25'?{status:200,data:detail(25,{refundType:approved?4:0})}:undefined);
  try{await f.view.openRefund({id:25});await f.view.mutate('return');expect(JSON.parse(f.writes()[0].data).action).toBe('return');expect(f.view.current.value.refundType).toBe(4);expect(f.view.uncertainIds.size).toBe(0);}finally{f.close();}
});
it('rejects a stale-row success toast and retains its pending record while another refund is selected',async()=>{
  const wait=gate(),f=await mount(c=>c.method==='post'?wait.promise:undefined);
  try{await f.view.openRefund({id:25});f.view.received.value=true;const action=f.view.mutate('refund');await flush();await f.view.openRefund({id:32});
    wait.resolve({status:200,data:{completed:true,status:'SUCCESS'}});await action;expect(f.view.current.value.id).toBe(32);expect(runtime.dialog.state.messages).toEqual([]);expect(f.view.uncertainIds.has(25)).toBe(true);
  }finally{f.close();}
});
it('captures token at call time and prevents late A -> B -> A auth expiry from logging out the replacement session',async()=>{
  const wait=gate(),f=await mount(c=>c.url==='/refund/detail/25'?wait.promise:undefined);
  try{const pending=f.view.openRefund({id:25});await flush();expect(f.calls.at(-1).headers['Authori-zation']).toBe('Bearer local-token-a');
    runtime.auth.setToken('local-token-b');runtime.auth.setToken('local-token-a');wait.resolve({status:410001,msg:'old token expired',data:null});await pending;
    expect(localStorage.getItem('admin_token')).toBe('local-token-a');expect(f.view.current.value).toBeNull();expect(f.view.list.value).toEqual([]);
  }finally{f.close();}
});
it('cancels queued writes on an immediate session change',async()=>{
  const f=await mount();try{await f.view.openRefund({id:25});f.view.received.value=true;const pending=f.view.mutate('refund');surface.dispatchEvent(new Event('admin-session-changed'));await pending;expect(f.writes()).toHaveLength(0);}finally{f.close();}
});
it('does not retain list rows after a failed refresh; retries the failed page cursor',async()=>{
  let failed=false;const f=await mount(c=>c.url==='/refund/list'?failed?{status:500,msg:'offline'}:{status:200,data:{list:[detail(32),detail(25)],limit:20,nextCursor:null}}:undefined);
  try{failed=true;f.view.before.value='25';await f.view.load();expect(f.view.list.value).toEqual([]);expect(f.view.listError.value).toBeTruthy();expect(f.calls.at(-1).params.before).toBe('25');}finally{f.close();}
});
it('corrupt pending storage fails before a decision is dispatched',async()=>{
  localStorage.setItem('admin-refund-pending-v1:100','broken');const f=await mount();try{await f.view.openRefund({id:25});f.view.received.value=true;await f.view.mutate('refund');expect(f.writes()).toHaveLength(0);}finally{f.close();}
});
it('a bound terminal receipt resolves despite failed business read-back, without allowing a blind new decision',async()=>{
  let sent=false;const f=await mount(c=>c.method==='post'?(sent=true,operationResponse(c)):sent&&c.url==='/refund/detail/25'?{status:500,msg:'read offline'}:c.url==='/refund/detail/25'?{status:200,data:detail(25,{refundType:0})}:undefined);
  try{await f.view.openRefund({id:25});await f.view.mutate('return');expect(f.view.current.value).toBeNull();expect(f.view.detailError.value).toBe('read offline');expect(f.view.uncertainIds.has(25)).toBe(false);expect(f.view.canWrite.value).toBe(false);expect((await runtime.ops.readRefundOperation(100,25)).intent.phase).toBe('resolved');}finally{f.close();}
});
it('binds a refusal to the reviewed row and retains the guard for a malformed null receipt',async()=>{
  const f=await mount(c=>c.method==='post'?{status:200,data:{ok:true}}:undefined);
  try{await f.view.openRefund({id:25});await f.view.mutate('refuse');expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0].url).toBe('/refund/operations/execute/25');expect(JSON.parse(f.writes()[0].data)).toMatchObject({reason:'不满足退款条件',review:{uid:11,storeOrderId:25,refundPrice:'5.00'}});
    expect(f.view.uncertainIds.has(25)).toBe(true);
  }finally{f.close();}
});
it('rechecks actual receipt acknowledgement after the refund confirmation',async()=>{
  const wait=gate(),f=await mount();runtime.dialog.state.confirm=()=>wait.promise;
  try{await f.view.openRefund({id:25});f.view.received.value=true;const action=f.view.mutate('refund');await flush();f.view.received.value=false;wait.resolve();await action;expect(f.writes()).toHaveLength(0);}finally{f.close();}
});
it('supports PHP in-person return state 4 after explicit receipt acknowledgement, without claiming settlement',async()=>{
  const f=await mount(c=>c.url==='/refund/detail/25'?{status:200,data:detail(25,{applyType:3,refundType:4})}:undefined);
  try{await f.view.openRefund({id:25});expect(f.view.canRefund.value).toBe(false);f.view.received.value=true;expect(f.view.canRefund.value).toBe(true);
    await f.view.mutate('refund');expect(f.writes()).toHaveLength(1);expect(f.view.uncertainIds.has(25)).toBe(true);
  }finally{f.close();}
});
it('recovers an unknown committed approval after remount by receipt lookup only, retaining a resolved tombstone',async()=>{
  const f=await mount(c=>c.method==='post'?{status:502,msg:'lost response'}:c.url==='/refund/detail/25'?{status:200,data:detail(25,{refundType:0})}:undefined);
  await f.view.openRefund({id:25});await f.view.mutate('return');expect(f.writes()).toHaveLength(1);f.close();
  const reopened=await mount(c=>c.url==='/refund/detail/25'?{status:200,data:detail(25,{refundType:4})}:undefined);
  try{await reopened.view.openRefund({id:25});expect(reopened.view.pendingIntent.value.action).toBe('return');expect(reopened.view.canWrite.value).toBe(false);
    await reopened.view.reconcilePending();expect(reopened.writes()).toHaveLength(0);expect(reopened.view.uncertainIds.has(25)).toBe(false);
    expect((await runtime.ops.readRefundOperation(100,25)).intent.phase).toBe('resolved');expect(reopened.view.reconcileMessage.value).toContain('原操作回执已确认');
    expect(reopened.calls.filter(c=>c.url==='/refund/operations/receipt')).toHaveLength(1);
  }finally{reopened.close();}
});
it('does not infer an operation or clear legacy ID-only pending records',async()=>{
  localStorage.setItem('admin-refund-pending-v1:100','[25]');const f=await mount();
  try{await f.view.openRefund({id:25});expect(f.view.legacyPending.value).toBe(true);await f.view.reconcilePending();expect(f.writes()).toHaveLength(0);expect(f.view.canWrite.value).toBe(false);expect(localStorage.getItem('admin-refund-pending-v1:100')).toBe('[25]');}finally{f.close();}
});
it('same-origin tabs cannot dispatch simultaneously and a stale confirmation cannot overwrite a resolved intent',async()=>{
  let approved=false;const response=gate(),confirmation=gate();
  const first=await mount(),second=await mount(c=>c.method==='post'?response.promise:c.url==='/refund/detail/25'?{status:200,data:detail(25,{refundType:approved?4:0})}:undefined);
  try{await first.view.openRefund({id:25});await second.view.openRefund({id:25});runtime.dialog.state.confirm=()=>confirmation.promise;
    const stale=second.view.mutate('return');await flush();runtime.dialog.state.confirm=async()=>{};
    const live=first.view.mutate('return');await flush();expect(second.writes()).toHaveLength(1);
    // Both views share one persisted record while the first request holds the lock.
    expect((await runtime.ops.readRefundOperation(100,25)).intent.phase).toBe('pending');
    approved=true;response.resolve(operationResponse(second.writes()[0]));await live;
    const tombstone=localStorage.getItem(runtime.ops.refundOperationKey(100,25));expect(JSON.parse(tombstone!).phase).toBe('resolved');
    confirmation.resolve();await stale;expect(second.writes()).toHaveLength(1);expect(localStorage.getItem(runtime.ops.refundOperationKey(100,25))).toBe(tombstone);
  }finally{first.close();second.close();}
});
it('an unavailable entity lock refuses submission before writing local intent or sending HTTP',async()=>{
  const f=await mount(),held=gate();const lock=runtime.intents.withRefundActionLock(25,()=>held.promise);
  try{await f.view.openRefund({id:25});f.view.received.value=true;await f.view.mutate('refund');expect(f.writes()).toHaveLength(0);expect((await runtime.ops.readRefundOperation(100,25)).intent).toBeNull();}finally{held.resolve();await lock;f.close();}
});
it.each(['unsupported','unwritable'])('fails closed before dispatch when coordination is %s',async kind=>{
  const f=await mount();try{await f.view.openRefund({id:25});f.view.received.value=true;
    if(kind==='unsupported')vi.stubGlobal('navigator',{});else vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw Error('quota');});
    await f.view.mutate('refund');expect(f.writes()).toHaveLength(0);
  }finally{vi.restoreAllMocks();f.close();}
});
it('storage changes clear the reviewed row and cancel an open confirmation',async()=>{
  const confirmation=gate(),f=await mount();runtime.dialog.state.confirm=()=>confirmation.promise;
  try{await f.view.openRefund({id:25});f.view.received.value=true;const pending=f.view.mutate('refund');await flush();
    surface.dispatchEvent(Object.assign(new Event('storage'),{key:runtime.ops.refundOperationKey(100,25),storageArea:localStorage}));
    expect(f.view.current.value).toBeNull();confirmation.resolve();await pending;expect(f.writes()).toHaveLength(0);
  }finally{f.close();}
});
it('a delayed reconciliation cannot clear a newer nonce even without a storage event',async()=>{
  const original=await runtime.ops.makeRefundOperation(100,detail(25,{refundType:0}),'return','',false);
  const originalRaw=runtime.ops.writeRefundOperation(original,null);const delayed=gate();
  const f=await mount(c=>c.url==='/refund/operations/receipt'?delayed.promise:undefined);
  try{await f.view.openRefund({id:25});const pending=f.view.reconcilePending();await flush();
    const reply=operationResponse(f.calls.at(-1));
    const newer={...original,nonce:crypto.randomUUID()};const newerRaw=runtime.ops.writeRefundOperation(newer,originalRaw);
    delayed.resolve(reply);await pending;
    expect(localStorage.getItem(runtime.ops.refundOperationKey(100,25))).toBe(newerRaw);expect(f.view.canWrite.value).toBe(false);expect(f.writes()).toHaveLength(0);
  }finally{f.close();}
});
it.each([{refundType:5},{refundedPrice:'4.00'},{providerStatus:'PROCESSING'},{uid:12}])('keeps legacy v2 guards regardless of apparent business settlement %j',async change=>{
  const intent=runtime.intents.makeRefundIntent(100,detail(),'refund','',true),raw=runtime.intents.writeRefundIntent(intent,null);
  const f=await mount(c=>c.url==='/refund/detail/25'?{status:200,data:detail(25,{refundType:6,refundedPrice:'5.00',providerStatus:'SUCCESS',...change})}:undefined);
  try{await f.view.openRefund({id:25});await f.view.reconcilePending();expect(runtime.intents.readRefundIntent(100,25).raw).toBe(raw);
    expect(f.view.uncertainIds.has(25)).toBe(true);expect(f.view.canWrite.value).toBe(false);expect(f.writes()).toHaveLength(0);
  }finally{f.close();}
});
it('session invalidation during read-only reconciliation clears personal detail without resolving the original record',async()=>{
  const intent=await runtime.ops.makeRefundOperation(100,detail(25,{refundType:0}),'return','',false),raw=runtime.ops.writeRefundOperation(intent,null);
  const delayed=gate();const f=await mount(c=>c.url==='/refund/operations/receipt'?delayed.promise:undefined);
  try{await f.view.openRefund({id:25});const pending=f.view.reconcilePending();await flush();surface.dispatchEvent(new Event('admin-session-changed'));
    delayed.resolve(operationResponse(f.calls.at(-1)));await pending;expect(f.view.current.value).toBeNull();expect(f.view.pendingIntent.value).toBeNull();expect(f.view.list.value).toEqual([]);
    expect((await runtime.ops.readRefundOperation(100,25)).raw).toBe(raw);expect(f.writes()).toHaveLength(0);
  }finally{f.close();}
});
it('permits a new reviewed refusal after an approval tombstone, with a new nonce and exact original reason',async()=>{
  const prior=await runtime.ops.makeRefundOperation(100,detail(25,{refundType:0}),'return','',false);
  runtime.ops.writeRefundOperation(prior,null);
  const receipt=operationResponse({url:'/refund/operations/receipt',headers:{'Idempotency-Key':prior.nonce}}).data.receipt;
  runtime.ops.writeRefundOperation(runtime.ops.applyOperationResult(prior,{receipt,execution:null}),localStorage.getItem(runtime.ops.refundOperationKey(100,25)));
  let refused=false;const f=await mount(c=>c.method==='post'?(refused=true,operationResponse(c)):c.url==='/refund/detail/25'?{status:200,data:detail(25,{refundType:refused?3:4,refuseReason:refused?'不满足退款条件':''})}:undefined);
  try{await f.view.openRefund({id:25});expect(f.view.canWrite.value).toBe(true);await f.view.mutate('refuse');
    const result=(await runtime.ops.readRefundOperation(100,25)).intent;expect(result.nonce).not.toBe(prior.nonce);expect(result.action).toBe('refuse');expect(result.reason).toBe('不满足退款条件');expect(result.phase).toBe('resolved');expect(f.writes()).toHaveLength(1);
  }finally{f.close();}
});
it('null receipt lookup never unlocks an unknown request; only an explicit abandonment fence allows a freshly reviewed decision',async()=>{
  const intent=await runtime.ops.makeRefundOperation(100,detail(),'refund','',true);runtime.ops.writeRefundOperation(intent,null);
  const f=await mount(c=>c.url.endsWith('/receipt')?{status:200,data:{version:'admin-refund-operation-v1',receipt:null}}:c.url.includes('/abandon/')?operationResponse(c,'abandoned'):undefined);
  try{await f.view.openRefund({id:25});await f.view.reconcilePending();expect(f.view.canWrite.value).toBe(false);expect(f.writes()).toHaveLength(0);
    await f.view.recoverPending('abandon');expect(f.writes()).toHaveLength(1);expect(f.writes()[0].headers['Idempotency-Key']).toBe(intent.nonce);
    expect(f.view.reconcileMessage.value).toContain('不是撤销');expect(f.view.canWrite.value).toBe(true);
    expect((await runtime.ops.readRefundOperation(100,25)).intent.phase).toBe('resolved');
  }finally{f.close();}
});
it('abandonment returning prior provider admission is not cancellation and does not unlock a new request',async()=>{
  const intent=await runtime.ops.makeRefundOperation(100,detail(),'refund','',true);runtime.ops.writeRefundOperation(intent,null);
  const f=await mount();try{await f.view.openRefund({id:25});await f.view.recoverPending('abandon');
    expect(f.view.canWrite.value).toBe(false);expect(f.view.reconcileMessage.value).toContain('尚未确认渠道结算');
    expect((await runtime.ops.readRefundOperation(100,25)).intent.receipt.outcome).toBe('provider-admitted');
  }finally{f.close();}
});
it('explicit retry sends the original frozen body and key, not newly fetched amount/status/reason',async()=>{
  const intent=await runtime.ops.makeRefundOperation(100,detail(),'refund','',true);runtime.ops.writeRefundOperation(intent,null);
  const f=await mount(c=>c.url==='/refund/detail/25'?{status:200,data:detail(25,{refundType:6,refundPrice:'99.00',uid:12})}:c.url.includes('/execute/')?operationResponse(c,'provider-admitted',{completed:true,status:'SUCCESS'}):undefined);
  try{await f.view.openRefund({id:25});await f.view.recoverPending('execute');
    expect(f.writes()).toHaveLength(1);expect(JSON.parse(f.writes()[0].data)).toEqual(runtime.ops.operationBody(intent));expect(f.writes()[0].headers['Idempotency-Key']).toBe(intent.nonce);
    expect((await runtime.ops.readRefundOperation(100,25)).intent.phase).toBe('resolved');expect(f.view.reconcileMessage.value).toContain('渠道结算已确认完成');
  }finally{f.close();}
});
it('recovers a bound terminal receipt through the ID entry even when the list and business detail are gone',async()=>{
  const intent=await runtime.ops.makeRefundOperation(100,detail(25,{refundType:0}),'return','',false);runtime.ops.writeRefundOperation(intent,null);
  const f=await mount(c=>c.url==='/refund/list'?{status:200,data:{list:[],limit:20,nextCursor:null}}:c.url.includes('/detail/')?{status:404,msg:'业务记录已移除'}:undefined);
  try{f.view.recoveryId.value='25';await f.view.openRecovery();expect(f.view.current.value).toBeNull();expect(f.view.canReconcile.value).toBe(true);
    await f.view.reconcilePending();expect((await runtime.ops.readRefundOperation(100,25)).intent.phase).toBe('resolved');expect(f.writes()).toHaveLength(0);
    expect(f.view.reconcileMessage.value).toContain('已同意退货');expect(f.view.canWrite.value).toBe(false);
  }finally{f.close();}
});
it.each(['pending','resolved'])('never upgrades or clears a v2 %s marker via receipt lookup, retry or abandonment',async phase=>{
  const intent=runtime.intents.makeRefundIntent(100,detail(),'refund','',true),raw=runtime.intents.writeRefundIntent({...intent,phase},null);
  const f=await mount();try{await f.view.openRefund({id:25});for(const mode of ['receipt','execute','abandon'])await f.view.recoverPending(mode);
    expect(f.calls.filter(c=>c.method==='post')).toHaveLength(0);expect(f.view.canWrite.value).toBe(false);expect(localStorage.getItem(runtime.intents.refundIntentKey(100,25))).toBe(raw);
  }finally{f.close();}
});
it('read-only users cannot invoke any recovery handler',async()=>{
  const intent=await runtime.ops.makeRefundOperation(100,detail(),'refund','',true);runtime.ops.writeRefundOperation(intent,null);login(true);
  const f=await mount();try{await f.view.openRefund({id:25});for(const mode of ['receipt','execute','abandon'])await f.view.recoverPending(mode);
    expect(f.calls.filter(c=>c.method==='post')).toHaveLength(0);expect(f.view.canReconcile.value).toBe(false);
  }finally{f.close();}
});
it('API rejects an actor mismatch before dispatch instead of sending the current token for someone else\'s intent',async()=>{
  const intent=await runtime.ops.makeRefundOperation(101,detail(),'refund','',true);const f=await mount();
  try{await expect(runtime.api.apiAdminRefundOperation(intent,'receipt')).rejects.toThrow('不属于当前管理员');expect(f.calls.filter(c=>c.method==='post')).toHaveLength(0);}finally{f.close();}
});
it('API credential capture remains sticky across A -> B -> A during asynchronous hash verification',async()=>{
  const intent=await runtime.ops.makeRefundOperation(100,detail(),'refund','',true);const f=await mount();
  try{const pending=runtime.api.apiAdminRefundOperation(intent,'execute');runtime.auth.setToken('local-token-b');runtime.auth.setToken('local-token-a');
    await expect(pending).rejects.toThrow('登录状态已变化');expect(f.writes()).toHaveLength(0);
  }finally{f.close();}
});
it('a quota failure while saving a valid response keeps the original pending record and blocks further actions',async()=>{
  const f=await mount(c=>c.method==='post'?(vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw Error('quota');}),operationResponse(c,'balance-settled')):undefined);
  try{await f.view.openRefund({id:25});f.view.received.value=true;await f.view.mutate('refund');expect(f.writes()).toHaveLength(1);
    expect((await runtime.ops.readRefundOperation(100,25)).intent.phase).toBe('pending');expect(f.view.pendingReadable.value).toBe(false);expect(f.view.canWrite.value).toBe(false);
  }finally{vi.restoreAllMocks();f.close();}
});

const creationQuote=()=>({version:'admin-refund-creation-quote-v1',review:{id:1,orderId:'O1',uid:11,storeId:0,supplierId:0,payPrice:'10.00',totalNum:2,status:0,refundPrice:'0.00',payType:'yue'},
  mode:'remaining',items:[{cartId:501,cartNum:2}],quotedPrice:'10.00',refundNum:2,refundTimeDays:0,receivedAt:null,quoteFingerprint:'a'.repeat(64)});
const creationCalls=(f:Awaited<ReturnType<typeof mount>>)=>f.calls.filter(c=>c.url.startsWith('/refund/creation/') && !c.url.endsWith('/quote') && !c.url.endsWith('/receipt'));
async function creationResponse(config:{url:string;data:string;headers:Record<string,string>}) {
  if(config.url==='/refund/creation/quote')return {status:200,data:creationQuote()};
  const stored=await runtime.creation.readCreationIntent(100,1),intent=stored.intent;
  const receipt={version:'admin-refund-creation-v1',adminId:100,requestKey:intent.nonce,requestHash:intent.requestHash,orderId:1,outcome:'created',refundId:75};
  if(config.url==='/refund/creation/receipt')return {status:200,data:{version:'admin-refund-creation-v1',receipt:null}};
  if(config.url==='/refund/creation/abandon')return {status:200,data:{version:'admin-refund-creation-v1',receipt:{...receipt,outcome:'abandoned',refundId:null}}};
  if(config.url==='/refund/creation/create')return {status:200,data:{version:'admin-refund-creation-v1',receipt,replayed:false}};
  const accepted=await runtime.creation.applyCreationResponse(intent,{version:'admin-refund-creation-v1',receipt,replayed:false},'create');
  const operation=await runtime.creation.creationFinancialIntent(accepted);
  return {status:200,data:{version:'admin-refund-creation-v1',creation:{receipt,replayed:false},operation:{receipt:{version:'admin-refund-operation-v1',adminId:100,
    requestKey:intent.nonce,requestHash:operation.requestHash,refundId:75,action:'refund',outcome:'provider-admitted'},replayed:false,execution:{completed:false,status:'PROCESSING'}}}};
}
async function prepareCreation(f:Awaited<ReturnType<typeof mount>>) {
  f.view.orderInput.value='1';await f.view.open();await f.view.readQuote('remaining');f.view.amount.value='3.00';f.view.reason.value='主动测试';
}
it('creation UI copies confirmed quote, saves before dispatch, and never mistakes SQL-only creation for funds',async()=>{
  const f=await mount(creationResponse,true);
  try {
    await prepareCreation(f);await f.view.submit('create');const calls=creationCalls(f);expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].data)).toMatchObject({review:{uid:11,id:1},refundPrice:'3.00',reason:'主动测试'});
    expect(f.view.intent.value.receipt.outcome).toBe('created');expect(f.view.intent.value.phase).toBe('pending');expect(f.view.canStart.value).toBe(false);
    expect(f.view.message.value).toContain('尚未确认资金');expect(f.view.canRecover.value).toBe(true);
  }finally{f.close();}
});
it.each(['cancel','session','route','storage'])('creation confirmation never dispatches after %s invalidation',async kind=>{
  const wait=gate(),f=await mount(creationResponse,true);runtime.dialog.state.confirm=()=>wait.promise;
  try{await prepareCreation(f);const pending=f.view.submit('execute');await flush();
    if(kind==='session'){runtime.auth.setToken('local-token-b');runtime.auth.setToken('local-token-a');}
    if(kind==='route')await f.router.push('/away');
    if(kind==='storage')f.view.storage({storageArea:localStorage,key:runtime.creation.creationIntentKey(100,1)});
    if(kind==='cancel')wait.resolve(Promise.reject('cancel'));else wait.resolve();
    await pending;expect(creationCalls(f)).toHaveLength(0);expect(localStorage.getItem(runtime.creation.creationIntentKey(100,1))).toBeNull();
  }finally{f.close();}
});
it('creation write requires reliable local persistence before network dispatch',async()=>{
  const f=await mount(creationResponse,true);
  try{await prepareCreation(f);vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw Error('quota');});await f.view.submit('execute');
    expect(creationCalls(f)).toHaveLength(0);expect(f.view.readable.value).toBe(false);
  }finally{vi.restoreAllMocks();f.close();}
});
it('creation response loss survives remount, null lookup and explicit original-key abandonment without auto resend',async()=>{
  const f=await mount(c=>c.url==='/refund/creation/execute'?Promise.reject(Error('lost')):creationResponse(c),true);
  await prepareCreation(f);await f.view.submit('execute');const original=f.view.intent.value,body=creationCalls(f)[0].data;f.close();
  const reopened=await mount(creationResponse,true);
  try{reopened.view.orderInput.value='1';await reopened.view.open();expect(reopened.calls).toHaveLength(0);expect(reopened.view.canStart.value).toBe(false);
    await reopened.view.recover('receipt');expect(reopened.view.intent.value.phase).toBe('pending');expect(creationCalls(reopened)).toHaveLength(0);
    await reopened.view.recover('abandon');expect(reopened.view.intent.value.phase).toBe('resolved');expect(reopened.view.canStart.value).toBe(true);
    const call=creationCalls(reopened)[0];expect(call.headers['Idempotency-Key']).toBe(original.nonce);expect(call.data).toBe(body);
  }finally{reopened.close();}
});
it('creation late response cannot repopulate a session-invalidated surface',async()=>{
  const wait=gate(),f=await mount(c=>c.url==='/refund/creation/execute'?wait.promise:creationResponse(c),true);
  try{await prepareCreation(f);const pending=f.view.submit('execute');await flush();expect(creationCalls(f)).toHaveLength(1);
    const response=await creationResponse(creationCalls(f)[0]);runtime.auth.setToken('local-token-b');runtime.auth.setToken('local-token-a');wait.resolve(response);await pending;
    expect(f.view.intent.value).toBeNull();expect(f.view.orderId.value).toBe(0);expect(f.view.invalid.value).toBe(true);
    expect((await runtime.creation.readCreationIntent(100,1)).intent.phase).toBe('pending');
  }finally{f.close();}
});
it('creation pages share an order lock and stale snapshots cannot dispatch a second intent',async()=>{
  const wait=gate(),first=await mount(creationResponse,true);await prepareCreation(first);
  const second=await mount(c=>c.url==='/refund/creation/execute'?wait.promise:creationResponse(c),true);
  try{await prepareCreation(second);const pending=first.view.submit('execute');await flush();expect(creationCalls(second)).toHaveLength(1);
    await second.view.submit('execute');expect(creationCalls(second)).toHaveLength(1);expect(second.view.error.value).toContain('另一标签页');
    wait.resolve(await creationResponse(creationCalls(second)[0]));await pending;expect(first.view.intent.value.phase).toBe('pending');
  }finally{first.close();second.close();}
});
it('changing creation quantities invalidates the quote and blocks submission until re-quoted',async()=>{
  const f=await mount(creationResponse,true);
  try{await prepareCreation(f);f.view.choices.value[0].quantity=1;f.view.changedSelection();await f.view.submit('execute');
    expect(f.view.quote.value).toBeNull();expect(creationCalls(f)).toHaveLength(0);
  }finally{f.close();}
});
it('view-only creation pages cannot quote, create or recover',async()=>{
  login(true);const f=await mount(creationResponse,true);
  try{f.view.orderInput.value='1';await f.view.open();await f.view.readQuote('remaining');await f.view.submit('execute');await f.view.recover('receipt');expect(f.calls).toHaveLength(0);}
  finally{f.close();}
});
