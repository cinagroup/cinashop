const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),vue=require('vue'),sfc=require('@vue/compiler-sfc'),dom=require('@vue/compiler-dom'),axios=require('axios');
const root=path.resolve(__dirname,'../../src'),page=path.join(root,'pages/operations/StoreCatalogAuthor.vue');
const digests=new Set(),copy=v=>JSON.parse(JSON.stringify(v)),tick=async()=>{for(let i=0;i<8;i++){await vue.nextTick();await Promise.allSettled([...digests]);await new Promise(setImmediate);}};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
const row=(id=1,extra={})=>({id,name:`提货点${id}`,introduction:'历史简介',phone:'13800138000',address:'甲省,乙市,丙区',detailed_address:'旧街1号',latitude:'31.20',longitude:'121.40',day_time:'08:00 - 20:00',image:'/static/store.png',valid_range:1000,is_show:1,is_store:1,is_del:0,add_time:0,image_preview:'/static/store.png',...extra});
const catalog=(list=[row(),row(2,{is_show:0}),row(3,{is_del:1,is_show:0})],revision='a'.repeat(64))=>({list:copy(list),count:list.length,revision,write_ready:true});
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
 const cache=new Map(),io=[],storageWrites=[],warnings=[],errors=[],navigation=[],server={rows:copy(options.rows??[row(),row(2,{is_show:0}),row(3,{is_del:1,is_show:0})]),revision:'a'.repeat(64),version:10};
 const storage=new Map(options.storage??[]),actor=vue.reactive({token:'actor-A',userInfo:{id:7,level:0},uniqueAuth:[],menus:[],...(options.actor??{})});actor.$patch=values=>Object.assign(actor,values);
 if(!storage.has('admin_token'))storage.set('admin_token',actor.token);
 if(!storage.has('admin_session'))storage.set('admin_session',JSON.stringify({userInfo:actor.userInfo,uniqueAuth:actor.uniqueAuth,menus:actor.menus}));
 const localStorage={get length(){return storage.size;},key:index=>[...storage.keys()][index]??null,getItem:key=>storage.get(key)??null,setItem(key,value){if(options.persist)options.persist(key,String(value));storageWrites.push({kind:'set',key,value:String(value)});storage.set(key,String(value));},removeItem(key){if(options.persist)options.persist(key,null);storageWrites.push({kind:'remove',key});storage.delete(key);}};
 const window=new EventTarget();window.location={pathname:'/operations/store',get href(){return navigation.at(-1)??'/operations/store';},set href(value){navigation.push(value);}};
 const listeners=new Set(),add=window.addEventListener.bind(window),remove=window.removeEventListener.bind(window);window.addEventListener=(type,fn,...args)=>{if(type==='message')listeners.add(fn);return add(type,fn,...args);};window.removeEventListener=(type,fn,...args)=>{if(type==='message')listeners.delete(fn);return remove(type,fn,...args);};
 class StorageEvent extends Event{constructor(type,init={}){super(type);this.key=init.key??null;}}
 let model,bindings,alive=true,changed=0,frameSerial=0;const hostProps=vue.reactive({active:options.active??true}),route=vue.reactive({fullPath:'/operations/store'}),actionListeners=new Set();actor.$onAction=callback=>{actionListeners.add(callback);return()=>actionListeners.delete(callback);};const fireAction=name=>{for(const callback of actionListeners){let after;callback({name,after:fn=>{after=fn;}});after?.();}};
 function source(){return catalog(server.rows,server.revision);}
 const receipts=new Map(),images=options.images??Array.from({length:24},(_,i)=>({att_id:i+1,pid:0,real_name:`图片${i+1}`,reference:`/api/assets/${i+1}`,preview:`/static/preview-${i+1}.png`}));
 const regionRows=options.regions??[{id:1,pid:0,level:1,name:'甲省'},{id:2,pid:1,level:2,name:'乙市'},{id:3,pid:2,level:3,name:'丙区'},{id:20,pid:0,level:1,name:'香港'},{id:21,pid:0,level:1,name:'浅省'},{id:22,pid:21,level:2,name:'浅市'}];
 const base='/merchant/store/author';
 function answer(call){
  if(call.method==='GET'&&call.url===base+'/catalog')return envelope({...source(),write_ready:options.writeReady??true});
  if(call.method==='GET'&&call.url===base+'/attachment-categories')return envelope({list:[{id:1,pid:0,name:'门店素材'}]});
  if(call.method==='GET'&&call.url===base+'/attachment-options'){const q=call.params??{},list=images.filter(i=>i.pid===Number(q.pid??0)&&i.real_name.includes(q.name??'')),page=Number(q.page??1),limit=Number(q.limit??20);return envelope({list:list.slice((page-1)*limit,page*limit),count:list.length,page,limit});}
  if(call.method==='GET'&&call.url===base+'/regions')return envelope({list:copy(regionRows),count:regionRows.length});
  if(call.method==='GET'&&call.url===base+'/map-config')return envelope(options.mapConfig??{available:true,url:'https://apis.map.qq.com/tools/locpicker?type=1&key=controlled-browser-key&referer=myapp',origin:'https://apis.map.qq.com'});
  if(call.method==='GET'&&call.url.startsWith(base+'/receipt/'))return receipts.has(call.url.split('/').at(-1))?envelope(receipts.get(call.url.split('/').at(-1))):{status:404,msg:'原提货点请求回执不存在',data:null};
  if(![base+'/commit',base+'/resolve'].includes(call.url))throw Error('Unexpected real adapter I/O '+call.url);
  const a=call.body;if(receipts.has(a.operation_id))return envelope(receipts.get(a.operation_id));
  let id=a.target_id,created=0,updated=0;const input=a.payload,state=call.url.endsWith('/resolve')?'not_applied':'committed';
  if(state==='committed'){
   if(a.operation==='create'){id=Math.max(0,...server.rows.map(r=>r.id))+1;server.rows.push(row(id,{...input,image_preview:input.image}));created=1;}
   else if(a.operation==='update'){server.rows=server.rows.map(r=>r.id===id?{...r,...input,image_preview:input.image===r.image?r.image_preview:input.image}:r);updated=1;}
   else if(a.operation==='show'){server.rows=server.rows.map(r=>r.id===id?{...r,is_show:input.is_show}:r);updated=1;}
   else if(a.operation==='delete'){server.rows=server.rows.map(r=>r.id===id?{...r,is_del:1,is_show:0}:r);updated=1;}
   else if(a.operation==='restore'){server.rows=server.rows.map(r=>r.id===id?{...r,is_del:0}:r);updated=1;}
   server.revision=(++server.version).toString(16).padStart(64,'0');
  }
  const result={operation_id:a.operation_id,actor_id:a.actor_id,operation:a.operation,target_id:a.target_id,revision:a.revision,payload_hash:a.payload_hash,state,result:{id,created,updated,count:state==='committed'?server.rows.length:0,revision:state==='committed'?server.revision:a.revision}};receipts.set(a.operation_id,copy(result));return envelope(result);
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
  if(file.endsWith('.vue')){descriptor=sfc.parse(input,{filename:file}).descriptor;script=sfc.compileScript(descriptor,{id:'actual-store-cache'});input=script.content;}
  const output=ts.transpileModule(input,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const nativeCrypto=globalThis.crypto,cryptoPort={randomUUID:()=>nativeCrypto.randomUUID(),subtle:{digest(...args){const promise=nativeCrypto.subtle.digest(...args);digests.add(promise);promise.then(()=>digests.delete(promise),()=>digests.delete(promise));options.onDigest?.(args,promise);return promise;}}};
  new Function('require','exports','window','localStorage','StorageEvent','crypto',output)(name=>{
   if(name==='vue')return vue;if(name==='vue-router')return {useRoute:()=>route};if(name==='@/stores/auth')return{useAuthStore:()=>actor};
   if(name.startsWith('@/'))return load(path.join(root,name.slice(2)));if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name));return require(name);
  },exports,window,localStorage,StorageEvent,cryptoPort);
  if(file.endsWith('/utils/request.ts'))exports.default.defaults.adapter=async config=>{
   const call={method:String(config.method).toUpperCase(),url:config.url,body:config.data?typeof config.data==='string'?JSON.parse(config.data):copy(config.data):undefined,signal:config.signal,headers:config.headers?.toJSON?.()??config.headers,actor_id:actor.userInfo?.id,params:config.params};io.push(call);
   const result=await(options.send?options.send(call,()=>answer(call)):answer(call));
   const response={status:result.httpStatus??200,statusText:'local transport',headers:{},config,data:{status:result.status??200,msg:result.msg??'ok',data:result.data}};
   if(response.status>=400)throw new axios.AxiosError(response.data.msg,'ERR_BAD_RESPONSE',config,null,response);
   return response;
  };
  if(file.endsWith('/utils/storeAuthorState.ts')){const original=exports.storeAuthorState;exports.storeAuthorState=(...args)=>(model=original(...args));}
  if(descriptor){const component=exports.default,original=component.setup;component.setup=(props,ctx)=>{const state=original(props,ctx);if(file===page)bindings=vue.proxyRefs(state);return state;};component.render=new Function('Vue',ts.transpileModule(dom.compile(descriptor.template.content,{mode:'function',prefixIdentifiers:true,cacheHandlers:true,bindingMetadata:script.bindings,expressionPlugins:['typescript']}).code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText)(vue);}
  return exports;
 }
 const node=tag=>({tag,props:{},children:[],parent:null,text:'',...(tag==='iframe'?{contentWindow:{frame:++frameSerial}}:{})});
 const renderer=vue.createRenderer({createElement:node,createText:text=>({...node('#text'),text}),createComment:text=>({...node('#comment'),text}),setText:(n,v)=>{n.text=v;},setElementText(n,v){n.text=v;for(const c of n.children)c.parent=null;n.children=[];},parentNode:n=>n?.parent??null,nextSibling(n){if(!n?.parent)return null;const a=n.parent.children;return a[a.indexOf(n)+1]??null;},patchProp:(n,k,_old,v)=>{n.props[k]=v;},insert(n,p,anchor=null){if(n.parent)n.parent.children=n.parent.children.filter(c=>c!==n);const at=anchor?p.children.indexOf(anchor):-1;n.parent=p;if(at<0)p.children.push(n);else p.children.splice(at,0,n);},remove(n){if(n?.parent){n.parent.children=n.parent.children.filter(c=>c!==n);n.parent=null;}}});
 const component=load(page).default,app=renderer.createApp({render:()=>vue.h(component,{active:hostProps.active,onChanged:()=>{changed++;}})});for(const name of ['el-alert','el-button','el-select','el-option','el-form','el-form-item','el-input','el-input-number','el-dialog','el-tag'])app.component(name,element(name));app.config.warnHandler=value=>warnings.push(value);app.config.errorHandler=value=>errors.push(value);const tree=node('root');app.mount(tree);
 function sync(values={},event='admin-session-changed'){actor.$patch(values);storage.set('admin_token',actor.token);storage.set('admin_session',JSON.stringify({userInfo:actor.userInfo,uniqueAuth:actor.uniqueAuth,menus:actor.menus}));window.dispatchEvent(event==='storage'?new StorageEvent('storage',{key:'admin_session'}):new Event(event));}
 function message(data,opts={}){const frame=opts.frame??all(tree,n=>n.tag==='iframe')[0];const event=new Event('message');Object.defineProperties(event,{data:{value:data},origin:{value:opts.origin??'https://apis.map.qq.com'},source:{value:Object.hasOwn(opts,'source')?opts.source:frame?.contentWindow??null}});window.dispatchEvent(event);return event;}
 return{tree,actor,route,fireAction,io,storage,storageWrites,server,receipts,window,StorageEvent,load,props:hostProps,get model(){return model;},get state(){return model.state;},get bindings(){return bindings;},sync,message,get changed(){return changed;},get messageListeners(){return listeners.size;},
  reads:()=>io.filter(c=>c.method==='GET'&&c.url===base+'/catalog'),writes:()=>io.filter(c=>c.url===base+'/commit'),receiptReads:()=>io.filter(c=>c.url.startsWith(base+'/receipt/')),
  unmount(){if(alive){alive=false;app.unmount();}},async finish(){if(alive){alive=false;app.unmount();}await tick();if(warnings.length)throw Error('Actual Vue warnings: '+warnings.join(';'));if(errors.length)throw errors[0];if(listeners.size)throw Error('Map listener leaked');for(const c of io)if(!c.url.startsWith(base+'/'))throw Error('Unexpected non-store author API');},navigation,
 };
}
module.exports={vue,root,page,copy,tick,deferred,row,catalog,envelope,failure,all,text,css,byLabel,buttons,replay,click,update,runtime};
