const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const dependencyRoot = process.env.EXTRACT_DIRECTORY_DEPENDENCY_ROOT || path.resolve(__dirname, '../..');
const realRequire = createRequire(path.join(dependencyRoot, 'package.json'));
const vue = realRequire('vue'), ts = realRequire('typescript');
const sourceRoot = process.env.EXTRACT_DIRECTORY_SOURCE_ROOT || path.resolve(__dirname, '../../src');
const fallbackRoot = process.env.EXTRACT_DIRECTORY_SOURCE_FALLBACK || '';
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const tick = async () => { await vue.nextTick(); await new Promise(setImmediate); await vue.nextTick(); };
const node = tag => ({tag,props:{},children:[],parent:null,text:''});
const renderer = vue.createRenderer({
  createElement:node,createText:text=>({...node('#text'),text}),createComment:text=>({...node('#comment'),text}),
  setText:(n,text)=>{n.text=text;},setElementText:(n,text)=>{n.text=text;n.children=[];},
  parentNode:n=>n.parent,nextSibling:n=>n.parent?.children[n.parent.children.indexOf(n)+1]??null,
  patchProp:(n,key,old,value)=>{n.props[key]=value;},
  insert(n,parent,anchor){if(n.parent){const old=n.parent.children.indexOf(n);if(old>=0)n.parent.children.splice(old,1);}n.parent=parent;const i=anchor?parent.children.indexOf(anchor):-1;if(i<0)parent.children.push(n);else parent.children.splice(i,0,n);},
  remove(n){if(n.parent){const i=n.parent.children.indexOf(n);if(i>=0)n.parent.children.splice(i,1);n.parent=null;}},
});
function rawQuery(url) {
  const q=new URL(url,'https://admin.invalid').searchParams;
  return {page:Number(q.get('page')),limit:Number(q.get('limit')),status:q.get('status')==='all'?null:Number(q.get('status')),
    extract_type:q.get('extract_type'),keyword:q.get('keyword'),start:Number(q.get('start')),stop:Number(q.get('stop'))};
}
const revision = 'a'.repeat(64);
function row(id, changes={}) {
  return {id,uid:11,nickname:'提现用户',account:'user-11',extract_type:'weixin',real_name:'收款人',bank_name:'',bank_code:'',bank_address:'',alipay_code:'',wechat:'wechat-11',extract_number:'wechat-11',gross_amount:'20.00',net_amount:'19.49',fee_amount:'0.51',balance_before:'1000.00',status:0,fail_msg:'',fail_time:0,mark:'',add_time:0,time:'',media_available:true,revision,...changes};
}
function report(actor,query,count=41,changes={}) {
  // The fixture's default has no period. Tests that request dates provide their
  // complete server period explicitly; no application period helper is reused.
  assert.equal(query.start,0,'Supply a fixed independent period for dated fixtures');assert.equal(query.stop,0);
  const n=Math.min(20,Math.max(0,count-(query.page-1)*20));
  return {version:1,actor_id:actor,query:clone(query),period:{start:0,stop:0,effective_stop:0,rule:'none'},count,
    statistics:{price:'40.00',priced:'80.00',brokerage_count:'1000.00',brokerage_not:'920.00'},
    list:Array.from({length:n},(_,i)=>row(count-(query.page-1)*20-i)),...changes};
}
function envelope(data,options={}) {
  return new Response(JSON.stringify({status:options.code??200,msg:options.msg??'success',data}),{status:options.http??200,headers:{'Content-Type':'application/json'}});
}
function media(source,owner,seconds,changes={}) {
  return {version:1,actor_id:owner,id:source.id,revision:source.revision,available:true,reference:'/api/assets/14',
    preview:`/api/assets/14?expires=${seconds+900}&signature=${'A'.repeat(43)}`,expires:seconds+900,...changes};
}
function harness(options={}) {
  const clock={now:(options.now??1700000000)*1000},timers=new Map();let timerID=0;
  class ClockDate extends Date { constructor(...args){super(...(args.length?args:[clock.now]));}static now(){return clock.now;} }
  function timeout(fn,delay=0){const id=++timerID;timers.set(id,{at:clock.now+Number(delay),fn});return id;}
  const cancel=id=>timers.delete(id);
  const actor=vue.reactive({token:'A',userInfo:{id:9,account:'admin9',head_pic:'',real_name:'管理员',level:1,roles:'9'},menus:[],uniqueAuth:['extract.view'],
    $patch(value){Object.assign(this,value);}});
  const storage=new Map(),window=new EventTarget();window.location={pathname:'/finance/extract',href:'/finance/extract'};
  const localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)};
  const route=vue.reactive({query:{}}),calls=[],legacyCalls=[],notices=[],cache=new Map(),instances=new Map();
  const setSession=(token,id=9,grants=['extract.view'],level=1,notify=true)=>{
    storage.set('admin_token',token);storage.set('admin_session',JSON.stringify({userInfo:{id,account:'admin'+id,head_pic:'',real_name:'管理员',level,roles:String(id)},menus:[],uniqueAuth:grants}));
    if(notify)window.dispatchEvent(new Event('admin-session-changed'));
  };
  setSession('A',9,['extract.view'],1,false);
  const fetch=async(url,init)=>{
    const call={url,method:init.method,headers:clone(init.headers),cache:init.cache,credentials:init.credentials,signal:init.signal};calls.push(call);
    if(options.fetch)return options.fetch(call,calls.length);
    return envelope(report(actor.userInfo.id,rawQuery(url)));
  };
  function load(file) {
    file=path.resolve(sourceRoot,file);if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file);
    let source=file;if(!fs.existsSync(source)&&fallbackRoot)source=path.join(fallbackRoot,path.relative(sourceRoot,file));
    const exports={};cache.set(file,exports);let text=fs.readFileSync(source,'utf8'),descriptor,script;
    // Vite replaces this build-time flag in the actual legacy review/API.
    // The readonly suite runs the production branch, never local preview data.
    text=text.replaceAll('import.meta.env.DEV','false');
    if(file.endsWith('.vue')){const sfc=realRequire('@vue/compiler-sfc');const parsed=sfc.parse(text,{filename:file});assert.deepEqual(parsed.errors,[]);descriptor=parsed.descriptor;script=sfc.compileScript(descriptor,{id:'extract-directory-runtime'});text=script.content;}
    const compiled=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},reportDiagnostics:true});
    assert.deepEqual((compiled.diagnostics??[]).filter(x=>x.category===ts.DiagnosticCategory.Error),[]);
    // Only Pinia's store container, routing and Axios' trivial error value are
    // adapted. The real auth utility, native-fetch API, owner and composable run.
    const require=name=>{
      if(name==='vue')return vue;
      if(name==='vue-router')return{useRoute:()=>route};
      if(name==='element-plus')return{ElMessage:{error:value=>notices.push(['error',value]),success:value=>notices.push(['success',value])},ElMessageBox:{confirm:async()=>{throw Error('No legacy write confirmation authorized by this readonly wrapper test');}}};
      if(name==='@/stores/auth')return{useAuthStore:()=>actor};
      if(name==='@/utils/request')return{__esModule:true,AdminResponseError:class extends Error{constructor(message,status){super(message);this.name='AdminResponseError';this.status=status;}},
        getData:async promise=>(await promise).data,default:{
          get:async(url,config)=>{legacyCalls.push({method:'GET',url,config:clone(config??{})});return{data:options.legacyList??{list:[{id:91,uid:11,nickname:'原审核用户',account:'legacy11',extractType:'bank',bankName:'历史银行',realName:'历史收款人',extractNumber:'10001',extractPrice:'19.49',status:0,addTime:0,failMsg:''}],total:1}};},
          post:async(url,body)=>{legacyCalls.push({method:'POST',url,body:clone(body)});throw Error('Unexpected legacy write in readonly wrapper test');},
        }};
      if(name.startsWith('@/'))return load(name.slice(2));
      if(name.startsWith('.'))return load(path.relative(sourceRoot,path.resolve(path.dirname(file),name)));
      return realRequire(name);
    };
    new Function('require','exports','window','localStorage','fetch','Date','setTimeout','clearTimeout',compiled.outputText)(require,exports,window,localStorage,fetch,ClockDate,timeout,cancel);
    if(descriptor){const component=exports.default,setup=component.setup;component.setup=(props,context)=>{const value=setup(props,context);instances.set(file,value);return value;};component.render=new Function('Vue',realRequire('@vue/compiler-dom').compile(descriptor.template.content,{mode:'function',prefixIdentifiers:true,bindingMetadata:script.bindings}).code)(vue);}
    return exports;
  }
  let app,state;
  function mount(initialStatus=null){assert.equal(app,undefined);app=renderer.createApp({setup(){state=load('composables/useExtractDirectory.ts').useExtractDirectory(initialStatus);return()=>vue.h('div');}});const tree=node('root');app.mount(tree);return{tree,get state(){return state;},unmount(){if(app){app.unmount();app=undefined;}}};}
  function mountPage(name='AdminExtractList.vue'){assert.equal(app,undefined);const file=path.join(sourceRoot,'pages/finance',name);app=renderer.createApp(load('pages/finance/'+name).default);registerElements(app);const tree=node('root');app.mount(tree);return{tree,get state(){return vue.proxyRefs(instances.get(file));},unmount(){if(app){app.unmount();app=undefined;}}};}
  async function advance(ms){clock.now+=ms;for(let turn=0;turn<100;turn++){const due=[...timers].filter(([,timer])=>timer.at<=clock.now);if(!due.length){await tick();return;}for(const[id,timer]of due){if(timers.delete(id))timer.fn();}await tick();}throw Error('Timer loop did not settle');}
  return{load,mount,mountPage,actor,storage,localStorage,window,route,calls,legacyCalls,notices,instances,clock,timers,setSession,advance};
}
function elements(tree,predicate){const out=[];function visit(n){if(predicate(n))out.push(n);n.children?.forEach(visit);}visit(tree);return out;}
const text=n=>(n.text??'')+(n.children??[]).map(text).join('');
function registerElements(app){
  // Table rows render the actual SFC column slots. The adapter does not invent
  // column values or status/channel text; those remain compiled page behavior.
  const tableRows=Symbol('extract-directory-table-rows');
  for(const name of ['el-alert','el-button','el-form','el-form-item','el-select','el-option','el-date-picker','el-input','el-card','el-table','el-table-column','el-tag','el-pagination','el-dialog','el-radio-group','el-radio-button']){
    app.component(name,vue.defineComponent({name,inheritAttrs:false,props:['modelValue','disabled','label','title','data','prop'],emits:['update:modelValue'],setup(p,{attrs,slots,emit}){
      if(name==='el-table')vue.provide(tableRows,vue.computed(()=>p.data??[]));
      const rows=name==='el-table-column'?vue.inject(tableRows):null;
      return()=>{
      if(name==='el-dialog'&&!p.modelValue)return null;
      if(name==='el-table')return vue.h('table',attrs,slots.default?.());
      if(name==='el-table-column')return vue.h('section',{'data-column':p.label},[vue.h('b',p.label),...rows.value.map(row=>vue.h('div',{'data-row':row.id},slots.default?.({row})??String(row[p.prop]??'')))]);
      const tag=name==='el-button'?'button':name==='el-input'?'input':'section';
      return vue.h(tag,{...attrs,'data-element':name,'data-title':p.title,disabled:p.disabled,modelValue:p.modelValue,'onUpdate:modelValue':value=>emit('update:modelValue',value)},tag==='input'?null:[slots.header?.(),slots.default?.(),slots.footer?.()]);
    };}}));
  }
  app.directive('loading',{});
}
module.exports={assert,vue,sourceRoot,fallbackRoot,realRequire,clone,deferred,tick,rawQuery,row,report,envelope,media,revision,harness,elements,text};
