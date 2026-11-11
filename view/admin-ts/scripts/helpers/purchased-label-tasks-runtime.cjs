const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),vue=require('vue'),pinia=require('pinia'),axios=require('axios');
const repository=path.resolve(__dirname,'../../../..'),src=path.join(repository,'view/admin-ts/src');
const tick=async()=>{for(let i=0;i<8;i++){await Promise.resolve();await vue.nextTick();}};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const now=1700000000;
const row=i=>({taskId:i.toString(16).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa',eventKey:`order.product.labels:${100+i}:${100+i}`,orderId:100+i,userId:11,createdAt:now-1,status:'FAILED',attemptCount:1,dispatchCount:1,replayCount:0,availableAt:0,leaseUntil:0,processedAt:0,lastError:'请维护归属',receiptCompletedAt:null,recovery:'eligible'});
function runtime(options={}){
 const storage=new Map(),window=new EventTarget(),calls=[],rows=options.rows??Array.from({length:21},(_,i)=>row(i+1)),warnings=[];
 window.location={pathname:'/operations/outbox',search:'',href:'/operations/outbox'};
 const localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)};
 const session=(id=1,permissions=['outbox.manage'],level=0)=>({userInfo:{id,account:'owned-unit',head_pic:'',real_name:'Owned',level,roles:'1'},menus:[],uniqueAuth:permissions});
 storage.set('admin_token','A');storage.set('admin_session',JSON.stringify(session()));
 const client=axios.create();
 function next(call){
  if(call.method==='GET'){
   let visible=rows.filter(r=>(!call.params.status||r.status===call.params.status)&&(!call.params.task_id||r.taskId===call.params.task_id)&&(!call.params.after_id||r.taskId>call.params.after_id)).sort((a,b)=>a.taskId.localeCompare(b.taskId));
   const limit=call.params.limit??20,items=visible.slice(0,limit).map(x=>({...x}));return{items,nextAfterId:visible.length>limit?items.at(-1).taskId:null,observedAt:now};
  }
  const target=rows.find(r=>call.url.endsWith('/'+r.taskId+'/replay'));if(!target)throw Error('Missing original fake transport row');
  target.status='ENQUEUED';target.replayCount++;target.recovery='active';target.leaseUntil=now+600;target.lastError='';
  return{taskId:target.taskId,eventKey:target.eventKey,replayed:true,completed:false};
 }
 client.defaults.adapter=async config=>{
  const call={method:config.method.toUpperCase(),url:config.url,params:config.params??{},body:typeof config.data==='string'?JSON.parse(config.data):config.data,token:config.headers['Authori-zation'],signal:config.signal};calls.push(call);
  const value=options.send?await options.send(call,()=>next(call)):next(call);
  return {data:{status:200,msg:'',data:value},status:200,statusText:'OK',headers:{},config};
 };
 const facade={...axios,create:()=>client},cache=new Map();
 function load(file){
  file=path.resolve(file);if(cache.has(file))return cache.get(file);if(!file.startsWith(repository+path.sep))throw Error('Only owned source modules');
  let source=fs.readFileSync(file,'utf8').replaceAll('import.meta.env.DEV','false');const exports={};cache.set(file,exports);
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  new Function('require','exports','window','localStorage',js)(name=>{
   if(name==='axios')return{...facade,__esModule:true,default:facade};if(name==='vue')return vue;if(name==='pinia')return pinia;
   const resolved=name.startsWith('@/')?path.join(src,name.slice(2)):name.startsWith('.')?path.resolve(path.dirname(file),name):null;
   if(resolved)return load(path.extname(resolved)?resolved:resolved+'.ts');return require(name);
  },exports,window,localStorage);return exports;
 }
 const p=pinia.createPinia();pinia.setActivePinia(p);const auth=load(path.join(src,'stores/auth.ts')).useAuthStore(p);
 if(options.actor){const a=options.actor;storage.set('admin_session',JSON.stringify(session(a.id,a.permissions,a.level)));auth.$patch({userInfo:session(a.id,a.permissions,a.level).userInfo,uniqueAuth:a.permissions});}
 const node=tag=>({tag,children:[],parent:null});
 const renderer=vue.createRenderer({createElement:node,createText:t=>({...node('#text'),text:t}),createComment:t=>({...node('#comment'),text:t}),setText:(n,t)=>n.text=t,setElementText:(n,t)=>{n.text=t;n.children=[];},patchProp:()=>{},parentNode:n=>n.parent,nextSibling:n=>{const a=n.parent?.children??[];return a[a.indexOf(n)+1]??null;},remove:n=>{if(n.parent)n.parent.children.splice(n.parent.children.indexOf(n),1);},insert:(n,p,a)=>{if(n.parent)n.parent.children.splice(n.parent.children.indexOf(n),1);n.parent=p;const i=a?p.children.indexOf(a):-1;p.children.splice(i<0?p.children.length:i,0,n);}});
 let app,state,api;const mount=()=>{pinia.setActivePinia(p);app=renderer.createApp({setup(){api=load(path.join(src,'composables/usePurchasedLabelTasks.ts')).usePurchasedLabelTasks();state=api.state;return()=>vue.h('div');}});app.use(p);app.config.warnHandler=m=>warnings.push(m);app.mount(node('root'));};mount();
 const setSession=(token='B',id=2,permissions=['outbox.view'],level=1)=>{localStorage.setItem('admin_token',token);localStorage.setItem('admin_session',JSON.stringify(session(id,permissions,level)));window.dispatchEvent(new Event('admin-session-changed'));auth.$patch({token,userInfo:session(id,permissions,level).userInfo,uniqueAuth:permissions});};
 return{storage,window,rows,calls,auth,load,get api(){return api;},get state(){return state;},setSession,unmount(){app?.unmount();app=null;},mount,async finish(){app?.unmount();app=null;await tick();require('node:assert/strict').deepEqual(warnings,[]);}};
}
module.exports={runtime,tick,deferred,row,now};
