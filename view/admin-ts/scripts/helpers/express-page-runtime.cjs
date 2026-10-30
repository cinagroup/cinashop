const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),vue=require('vue'),sfc=require('@vue/compiler-sfc'),dom=require('@vue/compiler-dom'),axios=require('axios');
const root=path.resolve(__dirname,'../../src'),page=path.join(root,'pages/express/ExpressList.vue');
const digests=new Set(),copy=v=>JSON.parse(JSON.stringify(v)),tick=async()=>{for(let i=0;i<6;i++){await vue.nextTick();await Promise.allSettled([...digests]);await new Promise(setImmediate);}};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
const fields=['account','key','netName','courierName','customerName','codeName'];
const row=(id=1,extra={})=>({id,name:`快递${id}`,code:`CODE${id}`,sort:0,isShow:1,status:1,addTime:0,required:Object.fromEntries(fields.map(f=>[f,true])),configured:Object.fromEntries(fields.map(f=>[f,true])),...extra});
const catalog=(list=[row(),row(2,{isShow:0})],revision='a'.repeat(64))=>({list:copy(list),count:list.length,revision,write_ready:true});
const envelope=data=>({data}),failure=(status,msg='本地拒绝')=>({httpStatus:status,status,msg,data:null});
const all=(tree,predicate)=>{const out=[];const visit=n=>{if(predicate(n))out.push(n);for(const c of n.children??[])visit(c);};visit(tree);return out;};
const text=n=>n.tag==='#comment'?'':(n.text??'')+(n.children??[]).map(text).join('');
const css=(r,name)=>all(r.tree,n=>String(n.props?.class??'').split(' ').includes(name));
const byLabel=(r,label)=>all(r.tree,n=>n.props?.['aria-label']===label&&['input','select'].includes(n.tag))[0];
const buttons=(r,label)=>all(r.tree,n=>n.tag==='button'&&text(n)===label);
const replay=(fn,value)=>{for(const call of Array.isArray(fn)?fn:[fn]){if(typeof call!=='function')throw Error('Missing captured actual control handler');call(value);}};
async function click(r,label,index=0){const n=buttons(r,label)[index];if(!n)throw Error('Missing actual button '+label);if(n.props.disabled)throw Error('Actual button disabled '+label);replay(n.props.onClick,{stopPropagation(){}});await tick();return n;}
async function update(r,label,value){const n=byLabel(r,label);if(!n)throw Error('Missing actual control '+label);if(n.props.disabled)throw Error('Actual control disabled '+label);replay(n.tag==='select'?n.props.onChange:n.props.onInput,{target:{value}});await tick();return n;}

function runtime(options={}){
 const cache=new Map(),io=[],storageWrites=[],warnings=[],errors=[],navigation=[],server={rows:copy(options.rows??[row(),row(2,{isShow:0})]),revision:'a'.repeat(64),version:10};
 const storage=new Map(options.storage??[]),actor=vue.reactive({token:'actor-A',userInfo:{id:7,level:0},uniqueAuth:[],menus:[],...(options.actor??{})});actor.$patch=values=>Object.assign(actor,values);
 if(!storage.has('admin_token'))storage.set('admin_token',actor.token);
 if(!storage.has('admin_session'))storage.set('admin_session',JSON.stringify({userInfo:actor.userInfo,uniqueAuth:actor.uniqueAuth,menus:actor.menus}));
 const localStorage={get length(){return storage.size;},key:index=>[...storage.keys()][index]??null,getItem:key=>storage.get(key)??null,setItem(key,value){if(options.persist)options.persist(key,String(value));storageWrites.push({kind:'set',key,value:String(value)});storage.set(key,String(value));},removeItem(key){if(options.persist)options.persist(key,null);storageWrites.push({kind:'remove',key});storage.delete(key);}};
 const window=new EventTarget();window.location={pathname:'/express',get href(){return navigation.at(-1)??'/express';},set href(value){navigation.push(value);}};
 class StorageEvent extends Event{constructor(type,init={}){super(type);this.key=init.key??null;}}
 let model,bindings,alive=true;const route=vue.reactive({fullPath:'/express'}),actionListeners=new Set();actor.$onAction=callback=>{actionListeners.add(callback);return()=>actionListeners.delete(callback);};const fireAction=name=>{for(const callback of actionListeners){let after;callback({name,after:fn=>{after=fn;}});after?.();}};
 function source(){return catalog(server.rows,server.revision);}
 const receipts=new Map(),prepared=new Map();
 function answer(call){
  if(call.method==='GET'&&call.url==='/express/catalog')return envelope({...source(),write_ready:options.writeReady??true});
  if(call.method==='GET'&&call.url.startsWith('/express/author/receipt/'))return receipts.has(call.url.split('/').at(-1))?envelope(receipts.get(call.url.split('/').at(-1))):failure(404,'原请求回执不存在');
  if(call.url==='/express/author/prepare'){
   const input=call.body,ticket={seal:Buffer.from(input.operation_id).toString('base64url')+'.'+'a'.repeat(64),operation_id:input.operation_id,actor_id:call.actor_id,operation:input.operation,target_id:input.target_id,revision:input.revision};prepared.set(ticket.seal,{ticket,input:copy(input)});return envelope({ticket,payload:input.operation==='sync'?{catalog:[]}:null,summary:'请核对本次快递操作'});
  }
  const p=prepared.get(call.body.seal);if(!p)throw Error('Missing original prepared ticket');const t=p.ticket;
  if(receipts.has(t.operation_id))return envelope(receipts.get(t.operation_id));
  if(call.url==='/express/author/resolve'){const r={...t,state:'not_applied',result:{id:t.target_id,created:0,updated:0,count:0,revision:t.revision}};delete r.seal;receipts.set(t.operation_id,r);return envelope(r);}
  if(call.url!=='/express/author/commit')throw Error('Unexpected real adapter I/O '+call.url);
  const input=call.body.payload;let id=t.target_id,created=0,updated=0;
  if(t.operation==='create'){id=Math.max(0,...server.rows.map(r=>r.id))+1;server.rows.push({...row(id,{required:Object.fromEntries(fields.map(f=>[f,false])),configured:Object.fromEntries(fields.map(f=>[f,false]))}),name:input.name,code:input.code,sort:input.sort,isShow:input.isShow});created++;}
  else if(t.operation==='update'){server.rows=server.rows.map(r=>r.id===id?{...r,name:input.name,code:input.code,sort:input.sort,isShow:input.isShow,configured:Object.fromEntries(fields.map(f=>[f,input.accounts[f].mode==='keep'?r.configured[f]:input.accounts[f].mode==='replace']))}:r);updated++;}
  else if(t.operation==='show'){server.rows=server.rows.map(r=>r.id===id?{...r,isShow:input.isShow}:r);updated++;}
  else if(t.operation==='delete'){server.rows=server.rows.filter(r=>r.id!==id);updated++;}
  server.revision=(++server.version).toString(16).padStart(64,'0');const result={...t,state:'committed',result:{id,created,updated,count:server.rows.length,revision:server.revision}};delete result.seal;receipts.set(t.operation_id,copy(result));return envelope(result);
 }
 const formDisabled=Symbol('test Element form semantics');
 function element(name){return vue.defineComponent({name,inheritAttrs:false,props:['modelValue','disabled','label','title','value'],emits:['update:modelValue'],setup(props,{attrs,slots,emit}){
  const instance=vue.getCurrentInstance(),parent=vue.inject(formDisabled,vue.computed(()=>false)),disabled=vue.computed(()=>!!props.disabled||parent.value);
  if(name==='el-form')vue.provide(formDisabled,disabled);
  return()=>{if(name==='el-dialog'&&!props.modelValue)return null;
   const tag=name==='el-button'?'button':name==='el-input'||name==='el-input-number'?'input':name==='el-select'?'select':name==='el-option'?'option':'section';
   const issued=instance.vnode.props?.['onUpdate:modelValue'];
   const native=value=>{if(!disabled.value)emit('update:modelValue',value);};
   const p={...attrs,disabled:disabled.value,'data-element':name,'data-label':props.label,'data-title':props.title,value:name==='el-option'?props.value:props.modelValue,modelValue:props.modelValue,
    // The issued listener is taken from the actual parent VNode. Captured
    // listener tests do not call the model's controls in place of the template.
    ...(issued?{'onUpdate:modelValue':issued}:{}),
    ...(tag==='input'?{onInput:event=>native(name==='el-input-number'?Number(event.target.value):event.target.value)}:{}),
    ...(tag==='select'?{onChange:event=>native(typeof props.modelValue==='number'?Number(event.target.value):event.target.value)}:{})};
   return vue.h(tag,p,tag==='input'?null:name==='el-option'?props.label:[props.title??null,props.label??null,slots.default?.(),slots.footer?.()]);
  };
 }});}
 function load(file){file=path.resolve(file);if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);let input=fs.readFileSync(file,'utf8'),descriptor,script;
  if(file.endsWith('.vue')){descriptor=sfc.parse(input,{filename:file}).descriptor;script=sfc.compileScript(descriptor,{id:'actual-express-cache'});input=script.content;}
  const output=ts.transpileModule(input,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const nativeCrypto=globalThis.crypto,cryptoPort={randomUUID:()=>nativeCrypto.randomUUID(),subtle:{digest(...args){const promise=nativeCrypto.subtle.digest(...args);digests.add(promise);promise.then(()=>digests.delete(promise),()=>digests.delete(promise));options.onDigest?.(args,promise);return promise;}}};
  new Function('require','exports','window','localStorage','StorageEvent','crypto',output)(name=>{
   if(name==='vue')return vue;if(name==='vue-router')return {useRoute:()=>route};if(name==='@/stores/auth')return{useAuthStore:()=>actor};
   if(name.startsWith('@/'))return load(path.join(root,name.slice(2)));if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name));return require(name);
  },exports,window,localStorage,StorageEvent,cryptoPort);
  if(file.endsWith('/utils/request.ts'))exports.default.defaults.adapter=async config=>{
   const call={method:String(config.method).toUpperCase(),url:config.url,body:config.data?typeof config.data==='string'?JSON.parse(config.data):copy(config.data):undefined,signal:config.signal,headers:config.headers?.toJSON?.()??config.headers,actor_id:actor.userInfo?.id};io.push(call);
   const result=await(options.send?options.send(call,()=>answer(call)):answer(call));
   const response={status:result.httpStatus??200,statusText:'local transport',headers:{},config,data:{status:result.status??200,msg:result.msg??'ok',data:result.data}};
   if(response.status>=400)throw new axios.AxiosError(response.data.msg,'ERR_BAD_RESPONSE',config,null,response);
   return response;
  };
  if(file.endsWith('/utils/expressState.ts')){const original=exports.expressState;exports.expressState=(...args)=>(model=original(...args));}
  if(descriptor){const component=exports.default,original=component.setup;component.setup=(props,ctx)=>{const state=original(props,ctx);if(file===page)bindings=vue.proxyRefs(state);return state;};component.render=new Function('Vue',ts.transpileModule(dom.compile(descriptor.template.content,{mode:'function',prefixIdentifiers:true,cacheHandlers:true,bindingMetadata:script.bindings,expressionPlugins:['typescript']}).code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText)(vue);}
  return exports;
 }
 const node=tag=>({tag,props:{},children:[],parent:null,text:''});
 const renderer=vue.createRenderer({createElement:node,createText:text=>({...node('#text'),text}),createComment:text=>({...node('#comment'),text}),setText:(n,v)=>{n.text=v;},setElementText(n,v){n.text=v;for(const c of n.children)c.parent=null;n.children=[];},parentNode:n=>n?.parent??null,nextSibling(n){if(!n?.parent)return null;const a=n.parent.children;return a[a.indexOf(n)+1]??null;},patchProp:(n,k,_old,v)=>{n.props[k]=v;},insert(n,p,anchor=null){if(n.parent)n.parent.children=n.parent.children.filter(c=>c!==n);const at=anchor?p.children.indexOf(anchor):-1;n.parent=p;if(at<0)p.children.push(n);else p.children.splice(at,0,n);},remove(n){if(n?.parent){n.parent.children=n.parent.children.filter(c=>c!==n);n.parent=null;}}});
 const app=renderer.createApp(load(page).default);for(const name of ['el-alert','el-button','el-select','el-option','el-form','el-form-item','el-input','el-input-number','el-dialog','el-tag'])app.component(name,element(name));app.config.warnHandler=value=>warnings.push(value);app.config.errorHandler=value=>errors.push(value);const tree=node('root');app.mount(tree);
 function sync(values={},event='admin-session-changed'){actor.$patch(values);storage.set('admin_token',actor.token);storage.set('admin_session',JSON.stringify({userInfo:actor.userInfo,uniqueAuth:actor.uniqueAuth,menus:actor.menus}));window.dispatchEvent(event==='storage'?new StorageEvent('storage',{key:'admin_session'}):new Event(event));}
 return{tree,actor,route,fireAction,io,storage,storageWrites,server,receipts,window,StorageEvent,load,get model(){return model;},get state(){return model.state;},get bindings(){return bindings;},sync,
  reads:()=>io.filter(c=>c.method==='GET'&&c.url==='/express/catalog'),writes:()=>io.filter(c=>c.url==='/express/author/commit'),prepares:()=>io.filter(c=>c.url==='/express/author/prepare'),receiptReads:()=>io.filter(c=>c.url.startsWith('/express/receipt/')),
  unmount(){if(alive){alive=false;app.unmount();}},async finish(){if(alive){alive=false;app.unmount();}await tick();if(warnings.length)throw Error('Actual Vue warnings: '+warnings.join(';'));if(errors.length)throw errors[0];for(const c of io)if(!c.url.startsWith('/express/'))throw Error('Unexpected non-metadata API');},navigation,
 };
}
module.exports={vue,root,page,copy,tick,deferred,row,catalog,envelope,failure,all,text,css,byLabel,buttons,replay,click,update,runtime};
