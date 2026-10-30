const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),vue=require('vue'),pinia=require('pinia'),vueRouter=require('vue-router'),sfc=require('@vue/compiler-sfc'),dom=require('@vue/compiler-dom');
const {makeRenderer,all,text,tick,invoke,deferred}=require('./exception-page-runtime.cjs');
const root=path.resolve(__dirname,'../../src');
function storage(initial=[]){const map=new Map(initial);return {map,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};}
function session(id=11){return {userInfo:{id,account:`profile-${id}`,head_pic:'',real_name:'原姓名',roles:'',level:1},menus:[],uniqueAuth:[]};}
function component(tag,extra={}){return {inheritAttrs:false,...extra,setup(props,{attrs,slots}){return ()=>vue.h(tag,attrs,[tag==='aside'?attrs.title:'',slots.default?.(),slots.footer?.()]);}};}
async function createRuntime(options={}){
 const localStorage=storage([['admin_token','token-A'],['admin_session',JSON.stringify(session())]]),sessionStorage=storage(options.pending??[]),window=new EventTarget();window.location={pathname:'/system/profile',href:'',search:''};
 class StorageEvent extends Event{constructor(type,init={}){super(type);this.key=init.key??null;}}
 const events={calls:[],warnings:[],errors:[],blobUrls:[],revoked:[]},document={title:''},location={origin:'https://profile.test'},cache=new Map();
 const URLport={createObjectURL:blob=>{const url=`blob:profile-${events.blobUrls.length}`;events.blobUrls.push({url,blob});return url;},revokeObjectURL:url=>events.revoked.push(url)};
 const fetch=async(url,init)=>{events.calls.push({kind:'fetch',url,init});if(options.fetchTransport)return options.fetchTransport(url,init);return new Response(new Uint8Array([137,80,78,71,13,10,26,10]),{headers:{'Content-Type':'image/png'}});};
 function load(spec){let file=spec.startsWith('@/')?path.join(root,spec.slice(2)):spec;if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);let source=fs.readFileSync(file,'utf8'),descriptor,script;
  if(file.endsWith('.vue')){descriptor=sfc.parse(source,{filename:file}).descriptor;script=sfc.compileScript(descriptor,{id:'actual-profile-cache-handlers'});source=script.content;}
  source=source.replace(/import\.meta\.env\.DEV/g,'false');
  if(file===path.join(root,'router/index.ts'))source=source.replace(/\bcreateWebHistory\b/g,'createMemoryHistory').replace(/import\(\s*(['"])(@\/[^'"]+\.vue)\1\s*\)/g,(_q,_quote,page)=>`__lazy(${JSON.stringify(page)})`);
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  new Function('require','exports','window','document','location','localStorage','sessionStorage','StorageEvent','fetch','URL','__lazy',code)(name=>name==='vue'?vue:name==='pinia'?pinia:name==='vue-router'?vueRouter:name.startsWith('@/')?load(name):name.startsWith('.')?load(path.resolve(path.dirname(file),name)):require(name),exports,window,document,location,localStorage,sessionStorage,StorageEvent,fetch,URLport,page=>Promise.resolve({__esModule:true,default:page==='@/pages/system/Profile.vue'?load(page).default:page==='@/layouts/AdminLayout.vue'?{render:()=>vue.h(vueRouter.RouterView)}:{render:()=>vue.h('p',page)}}));
  if(descriptor)exports.default.render=new Function('Vue',dom.compile(descriptor.template.content,{mode:'function',prefixIdentifiers:true,cacheHandlers:true,bindingMetadata:script.bindings}).code)(vue);
  return exports;
 }
 let revision=0,info={id:11,account:'profile-11',real_name:'原姓名',head_pic:'',phone:'13800138000',revision:'a'.repeat(64),avatar_id:null};const receipts=new Map();
 const request=load('@/utils/request').default;request.defaults.adapter=async config=>{
  const data=typeof config.data==='string'?JSON.parse(config.data):config.data;events.calls.push({kind:'axios',url:config.url,method:config.method,data,headers:config.headers});
  if(options.transport){const result=await options.transport(config,data);if(result!==undefined)return {config,status:200,statusText:'fixture',headers:{},data:result};}
  let result;
  if(config.url==='/setting/info')result={...info};
  else if(config.url==='/system/profile/commit'){receipts.set(data.operation_id,{operation_id:data.operation_id,actor_id:11,operation:data.operation,state:'committed'});if(data.operation==='name')info.real_name=data.payload.real_name;if(data.operation==='phone')info.phone=data.payload.phone;if(data.operation==='avatar'){info.head_pic=data.payload.head_pic;info.avatar_id=data.payload.head_pic.split('/').at(-1);}info.revision=String(++revision).padStart(64,'a');result=receipts.get(data.operation_id);}
  else if(config.url.startsWith('/system/profile/receipt/'))result=receipts.get(config.url.split('/').at(-1))??{operation_id:config.url.split('/').at(-1),actor_id:11,operation:config.params.operation,state:'unknown'};
  else if(config.url==='/system/profile/resolve'){result=receipts.get(data.operation_id)??{...data,actor_id:11,state:'not_applied'};receipts.set(data.operation_id,result);}
  else if(config.url.startsWith('/system/profile/avatar/'))result={avatar_id:config.url.split('/').at(-1),head_pic:'/admin-profile-avatar/'+config.url.split('/').at(-1)};
  else if(config.url==='/system/profile/challenge')result={key:'11111111-1111-4111-8111-111111111111',action:'admin_phone_update',site_key:'fixture',expire_time:300};
  else if(config.url==='/system/profile/challenge/status')result={verified:true,expires_in:200};
  else if(config.url==='/system/profile/sms')result={queued:true,expires_in:300};
  else if(config.url==='/login')result={token:'token-A',user_info:session().userInfo,menus:[],unique_auth:[]};
  else throw Error('Unexpected endpoint '+config.url);
  return {config,status:200,statusText:'fixture',headers:{},data:{status:200,msg:'ok',data:result}};
 };
 const store=pinia.createPinia(),router=load('@/router/index').default;await router.push(options.path??'/system/profile');await router.isReady();
 const renderer=makeRenderer(),tree={tag:'root',props:{},children:[],parent:null,text:''},show=vue.ref(true),app=renderer.createApp({setup:()=>()=>show.value?vue.h(vueRouter.RouterView):vue.h('p','unmounted')});
 const basic={'el-card':'article','el-alert':'aside','el-button':'button','el-form':'form','el-form-item':'label','el-dialog':'dialog'};for(const [name,tag]of Object.entries(basic))app.component(name,component(tag));
 app.component('el-input',{inheritAttrs:false,props:['modelValue'],emits:['update:modelValue'],setup(props,{attrs,emit}){return ()=>vue.h('input',{...attrs,value:props.modelValue,onInput:e=>emit('update:modelValue',e.target.value)});}});
 app.directive('loading',()=>{});app.config.warnHandler=m=>events.warnings.push(m);app.config.errorHandler=e=>events.errors.push(e);app.use(store);app.use(router);app.mount(tree);await tick();
 function sync(id=11,token='token-A',kind='admin-session-changed'){localStorage.setItem('admin_token',token);localStorage.setItem('admin_session',JSON.stringify(session(id)));window.dispatchEvent(kind==='storage'?new StorageEvent('storage',{key:'admin_session'}):new Event(kind));}
 function buttons(label){return all(tree,n=>n.tag==='button'&&text(n)===label);}
 function inputs(){return all(tree,n=>n.tag==='input');}
 let mounted=true;const click=async label=>{const b=buttons(label)[0];if(!b)throw Error('Missing button '+label);await invoke(b.props.onClick);};
 return {tree,app,router,show,events,window,localStorage,sessionStorage,load,sync,buttons,inputs,click,info,receipts,store,async go(path){await router.push(path);await tick();},async finish(){if(mounted){app.unmount();mounted=false;}await tick();},async input(index,value){const input=inputs()[index];await invoke(input.props.onInput,{target:{value}});}};
}
module.exports={createRuntime,all,text,tick,invoke,deferred};
