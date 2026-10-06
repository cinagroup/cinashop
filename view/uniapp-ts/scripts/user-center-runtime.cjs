const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),vue=require('vue'),pinia=require('pinia');
const root=path.resolve(__dirname,'..'),tick=async()=>{for(let i=0;i<8;i++){await vue.nextTick();await new Promise(setImmediate);}},deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function runtime({send,component='pages/user/index.vue',anonymous=false,modal}={}){
  const hooks={},calls=[],navigations=[],toasts=[],modals=[],cache=new Map(),storage=new Map(),aborts=[];
  const uni={getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value),removeStorageSync:key=>storage.delete(key),
    navigateTo:o=>{navigations.push(o.url);o.success?.();},switchTab:o=>{navigations.push(o.url);o.success?.();},showToast:o=>toasts.push(o),showModal:o=>{modals.push(o);o.success?.({confirm:!!modal});},
    request:call=>{calls.push({url:call.url,data:structuredClone(vue.toRaw(call.data)),method:call.method,header:{...call.header}});const index=calls.length-1;
      Promise.resolve().then(()=>send(call)).then(result=>{if(result?.transport)call.fail({errMsg:result.transport});else call.success({statusCode:result?.httpStatus??200,data:{status:result?.status??200,msg:result?.msg??'ok',data:result?.data}});}).catch(e=>call.fail({errMsg:e.message}));
      return {abort(){aborts.push(index);}};
    },
  };
  const lifecycle=Object.fromEntries(['onLoad','onShow','onHide','onUnload','onReachBottom'].map(name=>[name,fn=>{const previous=hooks[name];hooks[name]=previous?(...args)=>{previous(...args);return fn(...args);}:fn;}]));
  function load(file){file=path.resolve(file);if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file);assert.ok(fs.existsSync(file),file);const exports={};cache.set(file,exports);let source=fs.readFileSync(file,'utf8');
    if(file.endsWith('.vue')){const sfc=require('@vue/compiler-sfc');source=sfc.compileScript(sfc.parse(source,{filename:file}).descriptor,{id:'actual-user-center-runtime'}).content;}
    const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
    new Function('require','exports','uni',output)(id=>{if(id==='vue')return vue;if(id==='pinia')return pinia;if(id==='@dcloudio/uni-app')return lifecycle;if(id.startsWith('@/'))return load(path.join(root,'src',id.slice(2)));if(id.startsWith('.'))return load(path.resolve(path.dirname(file),id));if(id.startsWith('qrcode-terminal/'))return require(id);throw Error(`unexpected dependency ${id}`);},exports,uni);return exports;
  }
  const active=pinia.createPinia();pinia.setActivePinia(active);const unbind=load(path.join(root,'src/stores/session.ts')).bindAuthStores(active),auth=load(path.join(root,'src/stores/auth.ts')).useAuthStore();if(!anonymous)auth.setLogin('synthetic-local-token',11);
  const scope=vue.effectScope(),page=scope.run(()=>load(path.join(root,'src',component)).default.setup({}, {expose(){}}));
  return {page,auth,uni,hooks,calls,navigations,toasts,modals,aborts,load,async start(query={}){hooks.onLoad?.(query);hooks.onShow?.();await tick();},stop(){hooks.onUnload?.();scope.stop();unbind();}};
}
async function render(r,file,setup){
  const sfc=require('@vue/compiler-sfc'),compiler=require('@vue/compiler-dom'),absolute=path.join(root,'src',file),descriptor=sfc.parse(fs.readFileSync(absolute,'utf8'),{filename:absolute}).descriptor,bindings=sfc.compileScript(descriptor,{id:'actual-user-center-render'}).bindings;
  const renderFn=new Function('Vue',compiler.compile(descriptor.template.content,{mode:'function',prefixIdentifiers:true,bindingMetadata:bindings,isCustomElement:tag=>['view','text','image','swiper','swiper-item','video','scroll-view'].includes(tag)}).code)(vue);
  if(!setup){r.load(absolute).default.render=renderFn;return;}
  const app=vue.createSSRApp({render:renderFn,setup:()=>setup});app.use(pinia.getActivePinia());return require('@vue/server-renderer').renderToString(app);
}
module.exports={runtime,tick,deferred,render};
