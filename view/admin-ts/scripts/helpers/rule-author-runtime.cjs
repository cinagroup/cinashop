const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
// When applied, defaults are entirely repository-relative. A caller reviewing
// the unapplied mirror can opt into real installed dependencies and source overlay.
const repository=path.resolve(process.env.RULE_AUTHOR_REPOSITORY_ROOT??path.join(__dirname,'../../../..'));
const installed=createRequire(path.join(repository,'view/admin-ts/package.json'));
const ts=installed('typescript'),vue=installed('vue'),sfc=installed('@vue/compiler-sfc'),dom=installed('@vue/compiler-dom'),axios=installed('axios');
const sourceRepository=path.resolve(process.env.RULE_AUTHOR_SOURCE_ROOT??repository),root=path.join(sourceRepository,'view/admin-ts/src'),page=path.join(root,'pages/product/ProductRuleAuthor.vue');
const digests=new Set(),copy=v=>JSON.parse(JSON.stringify(v)),tick=async()=>{for(let i=0;i<8;i++){await vue.nextTick();await Promise.allSettled([...digests]);await new Promise(setImmediate);}};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
const row=(id=1,extra={})=>({id,type:0,relation_id:0,rule_name:`模板${id}`,rule_value:JSON.stringify([{value:'颜色',detail:['红','蓝']}]),...extra});
const catalog=(list=[row(),row(2)],revision='a'.repeat(64))=>({list:copy(list),count:list.length,revision,write_ready:true,can_create:true});
const envelope=data=>({data}),failure=(status,msg='本地拒绝')=>({httpStatus:status,status,msg,data:null});
const all=(tree,predicate)=>{const out=[];const visit=n=>{if(predicate(n))out.push(n);for(const c of n.children??[])visit(c);};visit(tree);return out;};
const text=n=>n.tag==='#comment'?'':(n.text??'')+(n.children??[]).map(text).join('');
const css=(r,name)=>all(r.tree,n=>String(n.props?.class??'').split(' ').includes(name));
const byLabel=(r,label)=>all(r.tree,n=>n.props?.['aria-label']===label&&['input','select','textarea'].includes(n.tag))[0];
const buttons=(r,label)=>all(r.tree,n=>n.tag==='button'&&text(n)===label);
const replay=(fn,value)=>{for(const call of Array.isArray(fn)?fn:[fn]){if(typeof call!=='function')throw Error('Missing captured actual control handler');call(value);}};
async function click(r,label,index=0){const n=buttons(r,label)[index];if(!n)throw Error('Missing actual button '+label);if(n.props.disabled)throw Error('Actual button disabled '+label);replay(n.props.onClick,{stopPropagation(){}});await tick();return n;}
async function update(r,label,value){const n=byLabel(r,label);if(!n)throw Error('Missing actual control '+label);if(n.props.disabled)throw Error('Actual control disabled '+label);replay(n.tag==='select'?n.props.onChange:n.props.onInput,{target:{value}});await tick();return n;}


function runtime(options={}){
 const selectedPage=options.page?path.join(root,options.page):page,props=vue.reactive({active:options.active??true}),changes=[],messages=[];
 const cache=new Map(),io=[],storageWrites=[],warnings=[],errors=[],navigation=[],server={rows:copy(options.rows??[row(),row(2)]),revision:'a'.repeat(64),version:10};
 const storage=new Map(options.storage??[]),actor=vue.reactive({token:'actor-A',userInfo:{id:7,level:0},uniqueAuth:[],menus:[],...(options.actor??{})});actor.$patch=values=>Object.assign(actor,values);
 if(!storage.has('admin_token'))storage.set('admin_token',actor.token);
 if(!storage.has('admin_session'))storage.set('admin_session',JSON.stringify({userInfo:actor.userInfo,uniqueAuth:actor.uniqueAuth,menus:actor.menus}));
 const localStorage={get length(){return storage.size;},key:index=>[...storage.keys()][index]??null,getItem:key=>storage.get(key)??null,setItem(key,value){if(options.persist)options.persist(key,String(value));storageWrites.push({kind:'set',key,value:String(value)});storage.set(key,String(value));},removeItem(key){if(options.persist)options.persist(key,null);storageWrites.push({kind:'remove',key});storage.delete(key);}};
 const window=new EventTarget();window.location={pathname:'/product/rules',search:'',get href(){return navigation.at(-1)??'/product/rules';},set href(value){navigation.push(value);}};
 const listeners=new Set(),add=window.addEventListener.bind(window),remove=window.removeEventListener.bind(window);window.addEventListener=(type,fn,...args)=>{if(type==='message')listeners.add(fn);return add(type,fn,...args);};window.removeEventListener=(type,fn,...args)=>{if(type==='message')listeners.delete(fn);return remove(type,fn,...args);};
 class StorageEvent extends Event{constructor(type,init={}){super(type);this.key=init.key??null;}}
 let model,bindings,alive=true;const route=vue.reactive({fullPath:'/product/rules'}),actionListeners=new Set();actor.$onAction=callback=>{actionListeners.add(callback);return()=>actionListeners.delete(callback);};const fireAction=name=>{for(const callback of actionListeners){let after;callback({name,after:fn=>{after=fn;}});after?.();}};
 function source(){return {...catalog(server.rows,server.revision),can_create:options.canCreate??true};}
 const receipts=new Map();
 const base='/product/rule/author';
 function answer(call){
  if(call.method==='GET'&&call.url===base+'/catalog')return envelope({...source(),write_ready:options.writeReady??true});
  if(call.method==='GET'&&call.url.startsWith(base+'/receipt/'))return receipts.has(call.url.split('/').at(-1))?envelope(receipts.get(call.url.split('/').at(-1))):{status:404,msg:'原规格模板请求回执不存在',data:null};
  if(call.method==='GET'&&call.url==='/product/unit/author/catalog')return envelope({list:[{id:1,type:0,relation_id:0,name:'单位1',sort:0,status:1,is_del:0,add_time:1}],count:1,revision:'a'.repeat(64),write_ready:true,can_create:true});
  if(call.method==='GET'&&['/ensure','/product/rule','/specs','/product/words'].includes(call.url))return envelope({list:[],count:0,page:1,limit:20});
  if(call.method==='GET'&&call.url==='/product/ensure/author/catalog')return envelope({list:[{id:1,type:0,relation_id:0,name:'保障1',image:'',desc:'说明',sort:0,status:1,add_time:1,product_count:0,image_preview:''}],count:1,revision:'a'.repeat(64),write_ready:true,can_create:true});
  if(![base+'/commit',base+'/resolve'].includes(call.url))throw Error('Unexpected real adapter I/O '+call.url);
  const a=call.body;if(receipts.has(a.operation_id))return envelope(receipts.get(a.operation_id));
  let id=a.target_id,created=0,updated=0;const state=call.url.endsWith('/resolve')?'not_applied':'committed';
  if(state==='committed'){
   if(a.operation==='create'){id=Math.max(0,...server.rows.map(r=>r.id))+1;server.rows.push(row(id,{rule_name:a.payload.rule_name.trim(),rule_value:JSON.stringify(load(path.join(sourceRepository,'view/common/ruleAuthor.ts')).ruleSpec(a.payload.spec))}));created=1;}
   else if(a.operation==='update'){server.rows=server.rows.map(r=>r.id===id?{...r,rule_name:r.rule_name===a.payload.rule_name?r.rule_name:a.payload.rule_name.trim(),rule_value:a.payload.mode==='preserve'?r.rule_value:JSON.stringify(load(path.join(sourceRepository,'view/common/ruleAuthor.ts')).ruleSpec(a.payload.spec))}:r);updated=1;}
   else if(a.operation==='delete'){server.rows=server.rows.filter(r=>r.id!==id);updated=1;}
   server.revision=(++server.version).toString(16).padStart(64,'0');
  }
  const result={operation_id:a.operation_id,actor_id:a.actor_id,operation:a.operation,target_id:a.target_id,revision:a.revision,payload_hash:a.payload_hash,state,result:{id,created,updated,count:state==='committed'?server.rows.length:0,revision:state==='committed'?server.revision:a.revision}};receipts.set(a.operation_id,copy(result));return envelope(result);
 }
 const tabsContext=Symbol('actual parent tabs');
 const formDisabled=Symbol('test Element form semantics');
 function element(name){return vue.defineComponent({name,inheritAttrs:false,props:['modelValue','disabled','label','title','value','name'],emits:['update:modelValue'],setup(props,{attrs,slots,emit}){
  const instance=vue.getCurrentInstance(),parent=vue.inject(formDisabled,vue.computed(()=>false)),disabled=vue.computed(()=>!!props.disabled||parent.value);
  if(name==='el-form')vue.provide(formDisabled,disabled);
  if(name==='el-tabs')vue.provide(tabsContext,{value:vue.computed(()=>props.modelValue),select:value=>emit('update:modelValue',value)});
  const tabs=vue.inject(tabsContext,null);
  return()=>{if(name==='el-dialog'&&!props.modelValue)return null;
   if(name==='el-table-column')return null;
   if(name==='el-tab-pane')return vue.h('section',{'data-tab':props.name,hidden:tabs?.value.value!==props.name},[vue.h('button',{'data-tab-button':props.name,onClick:()=>tabs.select(props.name)},props.label),slots.default?.()]);
   const tag=name==='el-button'?'button':name==='el-input'||name==='el-input-number'?'input':name==='el-select'?'select':name==='el-option'?'option':'section';
   const issued=instance.vnode.props?.['onUpdate:modelValue'];
   const native=value=>{if(!disabled.value)emit('update:modelValue',value);};
   const p={...attrs,disabled:disabled.value,'data-element':name,'data-label':props.label,'data-title':props.title,value:name==='el-option'?props.value:props.modelValue,modelValue:props.modelValue,
    // The issued listener is taken from the actual parent VNode. Captured
    // listener tests do not call the model's controls in place of the template.
    ...(issued?{'onUpdate:modelValue':issued}:{}),
    ...(tag==='input'?{onInput:event=>native(name==='el-input-number'?Number(event.target.value):event.target.value)}:{}),
    ...(tag==='select'?{onChange:event=>native(typeof props.modelValue==='number'?Number(event.target.value):event.target.value)}:{})};
   return vue.h(tag,p,tag==='input'?null:name==='el-option'?props.label:[props.title??null,props.label??null,slots.header?.(),slots.default?.(),slots.footer?.()]);
  };
 }});}
 function load(file){file=path.resolve(file);if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);
  const source=fs.existsSync(file)?file:path.join(repository,path.relative(sourceRepository,file));
  let input=fs.readFileSync(source,'utf8').replace(/import\.meta\.env\.DEV/g,'false'),descriptor,script;
  if(file.endsWith('.vue')){descriptor=sfc.parse(input,{filename:file}).descriptor;script=sfc.compileScript(descriptor,{id:'actual-rule-cache'});input=script.content;}
  const output=ts.transpileModule(input,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const nativeCrypto=globalThis.crypto,cryptoPort={randomUUID:()=>nativeCrypto.randomUUID(),subtle:{digest(...args){const promise=nativeCrypto.subtle.digest(...args);digests.add(promise);promise.then(()=>digests.delete(promise),()=>digests.delete(promise));options.onDigest?.(args,promise);return promise;}}};
  new Function('require','exports','window','localStorage','StorageEvent','crypto',output)(name=>{
   if(name==='vue')return vue;if(name==='vue-router')return {useRoute:()=>route};
   if(name==='element-plus')return {ElMessage:Object.fromEntries(['error','warning','success'].map(kind=>[kind,value=>messages.push({kind,value})])),ElMessageBox:{confirm:()=>Promise.reject(Error('Other-domain confirmations are outside this runtime'))}};if(name==='@/stores/auth')return{useAuthStore:()=>actor};
   if(name.startsWith('@/'))return load(path.join(root,name.slice(2)));if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name));return installed(name);
  },exports,window,localStorage,StorageEvent,cryptoPort);
  if(file.endsWith('/utils/request.ts'))exports.default.defaults.adapter=async config=>{
   const call={method:String(config.method).toUpperCase(),url:config.url,body:config.data?typeof config.data==='string'?JSON.parse(config.data):copy(config.data):undefined,signal:config.signal,headers:config.headers?.toJSON?.()??config.headers,actor_id:actor.userInfo?.id,params:config.params};io.push(call);
   const result=await(options.send?options.send(call,()=>answer(call)):answer(call));
   const httpStatus=result.httpStatus??200,response={status:httpStatus,statusText:'local transport',headers:{},config,data:{status:result.status??200,...(Object.hasOwn(result,'msg')?{msg:result.msg}:httpStatus>=400?{}:{msg:'ok'}),data:result.data}};
   // Preserve installed Axios settle semantics; the actual request interceptor
   // must see the original HTTP error, not a fixture-prettified service message.
   if(response.status&&config.validateStatus&&!config.validateStatus(response.status))throw new axios.AxiosError('Request failed with status code '+response.status,response.status>=400&&response.status<500?axios.AxiosError.ERR_BAD_REQUEST:axios.AxiosError.ERR_BAD_RESPONSE,config,null,response);
   return response;
  };
  if(file.endsWith('/utils/ruleAuthorState.ts')){const original=exports.ruleAuthorState;exports.ruleAuthorState=(...args)=>(model=original(...args));}
  if(descriptor){const component=exports.default,original=component.setup;component.setup=(props,ctx)=>{const state=original(props,ctx);if(file===selectedPage)bindings=vue.proxyRefs(state);return state;};component.render=new Function('Vue',ts.transpileModule(dom.compile(descriptor.template.content,{mode:'function',prefixIdentifiers:true,cacheHandlers:true,bindingMetadata:script.bindings,expressionPlugins:['typescript']}).code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText)(vue);}
  return exports;
 }
 const node=tag=>({tag,props:{},children:[],parent:null,text:''});
 const renderer=vue.createRenderer({createElement:node,createText:text=>({...node('#text'),text}),createComment:text=>({...node('#comment'),text}),setText:(n,v)=>{n.text=v;},setElementText(n,v){n.text=v;for(const c of n.children)c.parent=null;n.children=[];},parentNode:n=>n?.parent??null,nextSibling(n){if(!n?.parent)return null;const a=n.parent.children;return a[a.indexOf(n)+1]??null;},patchProp:(n,k,_old,v)=>{n.props[k]=v;},insert(n,p,anchor=null){if(n.parent)n.parent.children=n.parent.children.filter(c=>c!==n);const at=anchor?p.children.indexOf(anchor):-1;n.parent=p;if(at<0)p.children.push(n);else p.children.splice(at,0,n);},remove(n){if(n?.parent){n.parent.children=n.parent.children.filter(c=>c!==n);n.parent=null;}}});
 const component=load(selectedPage).default,app=renderer.createApp({render:()=>vue.h(component,{...props,onChanged:()=>changes.push('committed')})});for(const name of ['el-card','el-alert','el-button','el-select','el-option','el-form','el-form-item','el-input','el-input-number','el-dialog','el-tag','el-tabs','el-tab-pane','el-table','el-table-column','el-empty','el-pagination','el-switch','el-image','el-color-picker'])app.component(name,element(name));app.directive('loading',{});app.config.globalProperties.$router={push:value=>navigation.push(value)};app.config.warnHandler=value=>warnings.push(value);app.config.errorHandler=value=>errors.push(value);const tree=node('root');app.mount(tree);
 function sync(values={},event='admin-session-changed'){actor.$patch(values);storage.set('admin_token',actor.token);storage.set('admin_session',JSON.stringify({userInfo:actor.userInfo,uniqueAuth:actor.uniqueAuth,menus:actor.menus}));window.dispatchEvent(event==='storage'?new StorageEvent('storage',{key:'admin_session'}):new Event(event));}
 return{tree,actor,route,props,changes,messages,fireAction,io,storage,storageWrites,server,receipts,window,StorageEvent,load,get model(){return model;},get state(){return model.state;},get bindings(){return bindings;},sync,
  reads:()=>io.filter(c=>c.method==='GET'&&c.url===base+'/catalog'),writes:()=>io.filter(c=>c.url===base+'/commit'),receiptReads:()=>io.filter(c=>c.url.startsWith(base+'/receipt/')),
  unmount(){if(alive){alive=false;app.unmount();}},async finish(){if(alive){alive=false;app.unmount();}await tick();if(warnings.length)throw Error('Actual Vue warnings: '+warnings.join(';'));if(errors.length)throw errors[0];for(const c of io)if(!c.url.startsWith(base+'/')&&!(options.page&&['/product/unit/author/catalog','/product/ensure/author/catalog','/ensure','/product/rule','/specs','/product/words'].includes(c.url)))throw Error('Unexpected non-rule author API');},navigation,
 };
}
module.exports={vue,axios,repository,sourceRepository,root,page,copy,tick,deferred,row,catalog,envelope,failure,all,text,css,byLabel,buttons,replay,click,update,runtime};
