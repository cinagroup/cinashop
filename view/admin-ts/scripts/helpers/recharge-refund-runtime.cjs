/** Real compiled Vue/API/model, synthetic HTTP responses only. No assertion
 * here establishes a physical refund, provider result or financial authority. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash,webcrypto}=require('node:crypto');
const vue=require('vue'),ts=require('typescript'),sfc=require('@vue/compiler-sfc'),dom=require('@vue/compiler-dom');
const root=path.resolve(__dirname,'../../src'),version='admin-recharge-refund-v1';
const clone=v=>JSON.parse(JSON.stringify(v)),deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=async()=>{await vue.nextTick();await new Promise(setImmediate);await vue.nextTick();};
const until=async(predicate)=>{const deadline=Date.now()+1500;while(!predicate()){assert.ok(Date.now()<deadline,'Expected rendered/request state did not settle');await new Promise(resolve=>setTimeout(resolve,5));await tick();}};
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const option=(gift,available='11.50')=>{const n=Number(available.replace('.','')),debit=gift?1150:1000,enough=n>=debit;return{recoverGift:gift,sufficient:enough,principal:'10.00',gift:'1.50',walletDebitCents:debit,availableBalance:available,postBalance:enough?((n-debit)/100).toFixed(2):available,quoteFingerprint:(gift?'b':'a').repeat(64)};};
const quote=(available='11.50')=>({version,rechargeId:81,orderNo:'cz_ui81',buyerUid:11,options:[option(false,available),option(true,available)]});
function hash(actorId,body){return createHash('sha256').update(JSON.stringify({adminId:actorId,quoteFingerprint:body.quoteFingerprint,rechargeId:body.rechargeId,recoverGift:body.recoverGift,version:body.version})).digest('hex');}
function view(actorId,body,phase='succeeded',available='11.50'){
 const o=option(body.recoverGift,available),admission=phase==='rejected_insufficient'?'rejected_insufficient':phase==='abandoned'?'abandoned':'reserved';
 const receipt={version,operationId:uuid(81),rechargeId:81,requestHash:hash(actorId,body),recoverGift:admission==='abandoned'?null:o.recoverGift,admission,
  principal:admission==='abandoned'?null:o.principal,gift:admission==='abandoned'?null:o.gift,walletDebitCents:admission==='abandoned'?null:o.walletDebitCents,
  balanceBefore:admission==='abandoned'?null:available,postBalance:admission==='abandoned'?null:o.postBalance,createdAt:1700000000};
 return{receipt,execution:{operationId:receipt.operationId,phase,wallet:admission!=='reserved'?'none':phase==='succeeded'?'captured':['cancelled','released'].includes(phase)?'released':'held',
  attemptCount:['abandoned','cancelled','rejected_insufficient','not_requested'].includes(phase)?0:1,nextQueryAt:phase==='awaiting_provider'?1700000060:null}};
}
const envelope=(data,status=200,http=200)=>Response.json({status,msg:status===200?'success':'request rejected',data},{status:http});
function environment(){return{storage:new Map(),windows:new Set(),locks:new Set(),requests:new Map(),calls:[],available:'11.50',phase:'succeeded'};}
const node=tag=>({tag,props:{},children:[],parent:null,text:'',events:{},addEventListener(name,fn){(this.events[name]??=[]).push(fn);},removeEventListener(){}});
const renderer=vue.createRenderer({createElement:node,createText:text=>({...node('#text'),text}),createComment:text=>({...node('#comment'),text}),setText:(n,t)=>{n.text=t;},setElementText:(n,t)=>{n.text=t;n.children=[];},parentNode:n=>n.parent,nextSibling:n=>n.parent?.children[n.parent.children.indexOf(n)+1]??null,
 patchProp(n,k,old,value){n.props[k]=value;if(k==='value'){n.value=value;n._value=value;}if(k==='checked')n.checked=value;},insert(n,p,a){if(n.parent){const i=n.parent.children.indexOf(n);if(i>=0)n.parent.children.splice(i,1);}n.parent=p;const i=a?p.children.indexOf(a):-1;if(i<0)p.children.push(n);else p.children.splice(i,0,n);},remove(n){if(n.parent){const i=n.parent.children.indexOf(n);if(i>=0)n.parent.children.splice(i,1);n.parent=null;}}});
const simple=(tag,props=[])=>vue.defineComponent({props,setup:(p,c)=>()=>vue.h(tag,c.attrs,[p.label?vue.h('strong',p.label):null,p.title?vue.h('span',p.title):null,c.slots.default?.(),c.slots.footer?.()])});
const stubs={ElDialog:simple('section',['title','modelValue','width','closeOnClickModal']),ElButton:vue.defineComponent({props:['disabled','type','loading'],setup:(p,c)=>()=>vue.h('button',{...c.attrs,disabled:p.disabled||p.loading},c.slots.default?.())}),ElAlert:simple('div',['title','type','closable','showIcon']),ElDescriptions:simple('dl',['column','border']),ElDescriptionsItem:simple('div',['label']),ElInput:vue.defineComponent({props:['modelValue','disabled','maxlength','placeholder'],emits:['update:modelValue'],setup:(p,c)=>()=>vue.h('input',{...c.attrs,value:p.modelValue,disabled:p.disabled,maxlength:p.maxlength,placeholder:p.placeholder,onInput:e=>c.emit('update:modelValue',e.target.value)})})};
function runtime(options={}){
 const env=options.env??environment(),window=new EventTarget();window.location={pathname:'/finance/recharges',search:'',href:'/finance/recharges'};
 class StorageEvent extends Event{constructor(type,init){super(type);Object.assign(this,init);}}
 const localStorage={getItem:k=>env.storage.get(k)??null,setItem(k,v){if(options.storageFailure?.(k))throw Error('storage quota');const oldValue=env.storage.get(k)??null;env.storage.set(k,String(v));for(const w of env.windows)if(w.window!==window)w.window.dispatchEvent(new StorageEvent('storage',{key:k,oldValue,newValue:String(v),storageArea:w.localStorage}));},removeItem(k){env.storage.delete(k);}};
 const record={window,localStorage};env.windows.add(record);
 const setSession=(token='A',id=9)=>{localStorage.setItem('admin_token',token);localStorage.setItem('admin_session',JSON.stringify({userInfo:{id,account:'local',head_pic:'',real_name:'Local',level:0,roles:'1'},menus:[],uniqueAuth:['recharge_order.view','recharge_order.refund']}));window.dispatchEvent(new Event('admin-session-changed'));};
 if(!env.storage.has('admin_token'))setSession();
 const cache=new Map();let state,closed=0,changed=0,unmounted=false;const warnings=[];
 function next(call){
  const action=call.url.split('/').at(-1),key=call.headers['Idempotency-Key'],actor=Number(call.headers['X-Recharge-Refund-Scope'].split(':').at(-1));
  if(call.url.includes('/quote/'))return envelope(quote(env.available));
  if(call.url.includes('/execute/')){let r=env.requests.get(key);if(!r){r=view(actor,call.body,env.phase,env.available);env.requests.set(key,r);}return envelope({...r,replayed:false});}
  if(action==='execution'||action==='query')return envelope(env.requests.get(key)??null);
  if(call.url.includes('/cancel/')){const r=clone(env.requests.get(key));r.execution={...r.execution,phase:'cancelled',wallet:'released',attemptCount:0,nextQueryAt:null};env.requests.set(key,r);return envelope({...r,replayed:false});}
  if(call.url.includes('/abandon/')){let r=env.requests.get(key);if(!r){r=view(actor,call.body,'abandoned',env.available);env.requests.set(key,r);}return envelope({version,receipt:r.receipt});}
  throw Error('Unplanned adapter path '+call.url);
 }
 const fetch=async(url,init)=>{const call={url:String(url),method:init.method,headers:{...init.headers},body:JSON.parse(init.body),signal:init.signal,redirect:init.redirect,cache:init.cache,credentials:init.credentials};env.calls.push(call);let abort;const cancelled=new Promise((resolve,reject)=>{abort=()=>reject(new DOMException('Aborted','AbortError'));init.signal.addEventListener('abort',abort,{once:true});if(init.signal.aborted)abort();});try{return await Promise.race([Promise.resolve().then(()=>options.send?options.send(call,()=>next(call)):next(call)),cancelled]);}finally{init.signal.removeEventListener('abort',abort);}};
 function load(name){const file=path.resolve(root,name);if(cache.has(file))return cache.get(file);let source=fs.readFileSync(file,'utf8'),descriptor,script;
  if(file.endsWith('.vue')){const parsed=sfc.parse(source,{filename:file});assert.deepEqual(parsed.errors,[]);descriptor=parsed.descriptor;script=sfc.compileScript(descriptor,{id:'recharge-refund-runtime'});source=script.content;}
  const exports={};cache.set(file,exports);const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  new Function('require','exports','window','localStorage','navigator','crypto','fetch','setTimeout','clearTimeout','setInterval','clearInterval',output)(request=>{
   if(request==='vue')return vue;
   if(request==='@/api/rechargeOrders')return{rechargeOrderTime:n=>new Date(n*1000).toISOString()};
   const resolved=request.startsWith('@/')?request.slice(2):request.startsWith('.')?path.relative(root,path.resolve(path.dirname(file),request)):null;
   if(resolved!==null)return load(path.extname(resolved)?resolved:resolved+'.ts');return require(request);
  },exports,window,localStorage,{locks:{request:async(name,opts,work)=>{if(env.locks.has(name))return work(null);env.locks.add(name);try{return await work({name});}finally{env.locks.delete(name);}}}},webcrypto,fetch,setTimeout,clearTimeout,setInterval,clearInterval);
  if(descriptor){const component=exports.default,setup=component.setup;component.setup=(p,c)=>{const result=setup(p,c);state=vue.proxyRefs(result);return result;};component.render=new Function('Vue',ts.transpileModule(dom.compile(descriptor.template.content,{mode:'function',prefixIdentifiers:true,cacheHandlers:true,bindingMetadata:script.bindings,expressionPlugins:['typescript']}).code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText)(vue);}
  return exports;
 }
 const page=load('pages/finance/RechargeRefundDialog.vue').default,props=vue.reactive({actorId:9,rechargeId:81,orderNo:'cz_ui81',onClose:()=>{closed++;},onChanged:()=>{changed++;}}),tree=node('root'),app=renderer.createApp({setup:()=>()=>vue.h(page,props)});
 for(const[k,v]of Object.entries(stubs))app.component(k,v);app.directive('loading',{});app.config.warnHandler=m=>warnings.push(m);app.mount(tree);
 return{env,storage:env.storage,window,localStorage,tree,props,get state(){return state;},get closed(){return closed;},get changed(){return changed;},warnings,load,setSession,calls:env.calls,
  unmount(){if(!unmounted){unmounted=true;app.unmount();env.windows.delete(record);}},async finish(){if(!unmounted){unmounted=true;app.unmount();env.windows.delete(record);}await tick();assert.deepEqual(warnings,[]);}};
}
function elements(tree,filter){const out=[];function walk(n){if(filter(n))out.push(n);for(const c of n.children??[])walk(c);}walk(tree);return out;}
function text(n){return(n.text??'')+(n.children??[]).map(text).join('');}
const buttons=(r,label)=>elements(r.tree,n=>n.tag==='button'&&text(n)===label);
const replay=(fn,...args)=>Array.isArray(fn)?Promise.all(fn.map(f=>f(...args))):fn?.(...args);
async function click(r,label){await tick();const n=buttons(r,label)[0];assert.ok(n,'Missing '+label);assert.ok(!n.props.disabled,'Disabled '+label);await replay(n.props.onClick);await tick();}
async function gift(r,value){const n=elements(r.tree,n=>n.tag==='input'&&n.props.type==='radio'&&n.props.value===value)[0];assert.ok(n);n.checked=true;for(const f of n.events.change??[])f({target:n});await tick();}
module.exports={runtime,environment,clone,deferred,tick,until,quote,view,hash,envelope,uuid,version,elements,text,buttons,replay,click,gift,assert};
