const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),vue=require('vue'),pinia=require('pinia'),axios=require('axios'),sfc=require('@vue/compiler-sfc'),dom=require('@vue/compiler-dom');
const root=path.resolve(__dirname,'../../src');
const tick=async()=>{for(let i=0;i<5;i++){await vue.nextTick();await new Promise(setImmediate);}};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
const clone=value=>structuredClone(value);
function moduleLoader(ports={}){
 const cache=new Map();
 function load(file){file=file.startsWith('@/')?path.join(root,file.slice(2)):path.isAbsolute(file)?file:path.join(root,file);if(!path.extname(file))file+='.ts';file=path.resolve(file);if(cache.has(file))return cache.get(file);
  const exports={};cache.set(file,exports);let source=fs.readFileSync(file,'utf8'),descriptor,script;
  if(file.endsWith('.vue')){descriptor=sfc.parse(source,{filename:file}).descriptor;script=sfc.compileScript(descriptor,{id:'actual-browser-log-cache'});source=script.content;}
  // The real auth API also imports finance helpers. Use the same production
  // compile-time flag as the built app; no API or request module is mocked.
  source=source.replace(/import\.meta\.env\.DEV/g,'false');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  new Function('require','exports','window','localStorage','StorageEvent','console','Date',code)(name=>name==='vue'?vue:name==='pinia'?pinia:name.startsWith('@/')?load(name):name.startsWith('.')?load(path.resolve(path.dirname(file),name)):require(name),exports,ports.window,ports.localStorage,ports.StorageEvent,ports.console??console,ports.Date??Date);
  if(descriptor)exports.default.render=new Function('Vue',dom.compile(descriptor.template.content,{mode:'function',prefixIdentifiers:true,cacheHandlers:true,bindingMetadata:script.bindings}).code)(vue);
  return exports;
 }
 return{load,cache};
}
const load=file=>moduleLoader().load(file);
const node=tag=>({tag,props:{},children:[],parent:null,text:''});
function makeRenderer(){return vue.createRenderer({createElement:node,createText:text=>({...node('#text'),text}),createComment:text=>({...node('#comment'),text}),setText:(n,text)=>{n.text=text;},setElementText(n,text){for(const c of n.children)c.parent=null;n.children=[];n.text=text;},parentNode:n=>n?.parent??null,nextSibling(n){if(!n?.parent)return null;const siblings=n.parent.children;return siblings[siblings.indexOf(n)+1]??null;},patchProp:(n,key,_old,value)=>{n.props[key]=value;},insert(n,parent,anchor=null){if(n.parent)n.parent.children=n.parent.children.filter(c=>c!==n);n.parent=parent;const at=anchor?parent.children.indexOf(anchor):-1;if(at<0)parent.children.push(n);else parent.children.splice(at,0,n);},remove(n){if(n?.parent){n.parent.children=n.parent.children.filter(c=>c!==n);n.parent=null;}}});}
const response=(config,status=200,data={status:200,msg:'ok',data:{ok:true}})=>({config,status,statusText:'local transport',headers:{},data});
const httpError=(config,status=503,data={status,msg:'private response must not enter log',data:null})=>new axios.AxiosError('private HTTP message','ERR_BAD_RESPONSE',config,null,response(config,status,data));
function createRuntime(options={}){
 const events={added:[],removed:[],dispatched:[],storageWrites:[],console:[],warnings:[],navigation:[]},storage=options.storage instanceof Map?options.storage:new Map(options.storage??[]);
 const initial={token:'actor-A',userInfo:{id:7,account:'local-browser-log',head_pic:'',real_name:'本地作者',level:1,roles:'1'},menus:[],uniqueAuth:[],...(options.auth??{})};
 if(!storage.has('admin_token'))storage.set('admin_token',initial.token);
 if(!storage.has('admin_session'))storage.set('admin_session',JSON.stringify({userInfo:initial.userInfo,menus:initial.menus,uniqueAuth:initial.uniqueAuth}));
 const localStorage={get length(){return storage.size;},key:index=>[...storage.keys()][index]??null,getItem(key){if(options.readStorage)options.readStorage(key);return storage.get(key)??null;},setItem(key,value){events.storageWrites.push({method:'set',key,value:String(value)});storage.set(key,String(value));},removeItem(key){events.storageWrites.push({method:'remove',key});storage.delete(key);},clear(){events.storageWrites.push({method:'clear'});storage.clear();}};
 class StorageEvent extends Event{constructor(type,init={}){super(type);this.key=init.key??null;}}
 const window=new EventTarget(),nativeAdd=window.addEventListener.bind(window),nativeRemove=window.removeEventListener.bind(window),nativeDispatch=window.dispatchEvent.bind(window);
 window.addEventListener=(type,listener,...rest)=>{events.added.push({type,listener});return nativeAdd(type,listener,...rest);};window.removeEventListener=(type,listener,...rest)=>{events.removed.push({type,listener});return nativeRemove(type,listener,...rest);};window.dispatchEvent=event=>{events.dispatched.push(event.type);return nativeDispatch(event);};
 window.location={pathname:options.path??'/dashboard',search:'?token=DO-NOT-STORE',hash:'#DO-NOT-STORE',get href(){return events.navigation.at(-1)??'http://localhost/dashboard?token=DO-NOT-STORE#DO-NOT-STORE';},set href(value){events.navigation.push(value);}};
 const consolePort={...console,error(...args){events.console.push(args);if(options.consoleError)return options.consoleError(...args);}};
 class RuntimeDate extends Date{static now(){return typeof options.now==='function'?options.now():options.now??Date.now();}}
 const modules=moduleLoader({window,localStorage,StorageEvent,console:consolePort,Date:RuntimeDate}),loader=modules.load;
 const records=options.records??[{path:'/dashboard',name:'dashboard',meta:{title:'控制台'}},{path:'/config/classes',name:'config-classes',meta:{title:'配置分类'}},{path:'/system/frontend-log',name:'browser-log',meta:{title:'本浏览器日志'}},{path:'/system/log',name:'system-log',meta:{title:'操作日志'}},{path:'/order/:id',name:'order-detail',meta:{title:'订单详情'}},{path:'/login',name:'login',meta:{title:'登录'}},{path:'/:pathMatch(.*)*',meta:{title:'未知'}}];
 const current=vue.shallowRef({path:options.path??'/dashboard',fullPath:'/dashboard?token=DO-NOT-STORE#DO-NOT-STORE',matched:[]});
 function navigate(path,extras={}){const record=records.find(r=>r.path===path)??(path.startsWith('/order/')?records.find(r=>r.path==='/order/:id'):undefined);current.value={path,fullPath:path+'?token=DO-NOT-STORE#DO-NOT-STORE',matched:record?[record]:[],...extras};window.location.pathname=path;}
 const router=options.router??{currentRoute:current,getRoutes:()=>records,push:async path=>{navigate(typeof path==='string'?path:path.path);},replace:async path=>{navigate(typeof path==='string'?path:path.path);}};navigate(options.path??'/dashboard');
 const renderer=makeRenderer(),component=options.page?loader(options.page).default:options.rootComponent?options.rootComponent(loader):options.component??{name:'BrowserLogRuntimeRoot',render:()=>vue.h('main','local runtime')},app=renderer.createApp(component),store=pinia.createPinia();app.use(store);
 const auth=loader('stores/auth.ts').useAuthStore(store),requestModule=loader('utils/request.ts'),request=requestModule.default,io=[];
 request.defaults.adapter=async config=>{io.push(config);return options.transport?options.transport(config,io.length):response(config);};
 if(options.previousHandler)app.config.errorHandler=options.previousHandler;if(Object.hasOwn(options,'previousLog'))app.config.globalProperties.$log=options.previousLog;
 app.config.warnHandler=value=>events.warnings.push(value);for(const [name,port]of Object.entries(options.components??{}))app.component(name,port);
 const installer=loader('utils/browserLog.ts').installBrowserLog,installation=installer(app,router,auth,request),logStore=loader('stores/browserLog.ts').browserLog,model=logStore.value,tree=node('root');let mounted=false;
 if(options.mount!==false){app.mount(tree);mounted=true;}
 function sync(values={},event='admin-session-changed'){auth.$patch(values);storage.set('admin_token',auth.token);storage.set('admin_session',JSON.stringify({userInfo:auth.userInfo,menus:auth.menus,uniqueAuth:auth.uniqueAuth}));window.dispatchEvent(event==='storage'?new StorageEvent('storage',{key:'admin_session'}):new Event(event));}
 function dispose(){if(mounted){app.unmount();mounted=false;}else installation.dispose();}
 return{app,renderer,tree,auth,router,request,requestModule,model,storage,localStorage,events,window,StorageEvent,load:loader,loader,pinia:store,io,installation,install:installer,logStore,navigate,sync,dispose,console:consolePort,mount(){if(!mounted){app.mount(tree);mounted=true;}},async finish(){dispose();await tick();}};
}
function modelHarness(options={}){const u=load('utils/browserLogState.ts'),context={valid:true,path:'/dashboard',now:1800000000000},pages=options.pages??new Map([['/dashboard','控制台'],['/config/classes','配置分类'],['/system/frontend-log','本浏览器日志']]);const model=u.browserLogState({valid:()=>typeof options.valid==='function'?options.valid():context.valid,route:()=>typeof options.route==='function'?options.route():context.path,now:()=>typeof options.now==='function'?options.now():context.now,pages},options.reactive?value=>vue.reactive(value):undefined);return{u,context,model,state:model.state,push(type='info',source='application',status=null,method=null){return model.record(model.begin(),type,source,status,method);}};}
module.exports={root,vue,pinia,axios,tick,deferred,clone,load,moduleLoader,makeRenderer,response,httpError,createRuntime,modelHarness};
