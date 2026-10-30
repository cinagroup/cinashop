// Dedicated exact signed-hotword icon display tests. Existing search suites are unchanged.
// Hotword reads are anonymous. Explicit product GETs preserve optional shopper
// identity and the server's existing history/cache writes; this suite only
// prevents stale native callbacks from starting additional operations.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vue=require('vue'),pinia=require('pinia');
const {runtime,tick,deferred}=require('./uni-store-runtime.cjs');
const root=path.resolve(__dirname,'..'),pageFile=path.join(root,'src/pages/goods/search.vue'),hookFile=path.join(root,'src/composables/useGoodsSearch.ts'),HISTORY='h5_search_history';
const copy=value=>JSON.parse(JSON.stringify(value));
const word=(id=801,extra={})=>({id,name:'A&B 中文热词',keyword:'A&B 中文热词',color:'#123456',bg_color:'rgba(1,2,3,0.4)',border_color:'#abc',icon:'/static/hotword.png',...extra});
const product=(id=901,extra={})=>({id,store_name:'真实蛇形商品名称'+id,image:'/products/'+id+'.png',price:'7.00',ot_price:'9.00',vip_price:'',sales:0,stock:10,is_vip:0,is_vip_product:0,cart_button:1,unit_name:'件',star:'5',brand_name:'',spec_type:0,is_presale_product:0,cart_num:0,...extra});
const receipt=data=>({data});
function compile(file){const sfc=require('@vue/compiler-sfc'),dom=require('@vue/compiler-dom'),descriptor=sfc.parse(fs.readFileSync(file,'utf8'),{filename:file}).descriptor;return new Function('Vue',dom.compile(descriptor.template.content,{mode:'function',prefixIdentifiers:true,cacheHandlers:true,bindingMetadata:sfc.compileScript(descriptor,{id:'search-production-cache'}).bindings,isCustomElement:tag=>['view','text','image','input','scroll-view'].includes(tag)}).code)(vue);}
function nodes(tree,predicate){const result=[];function visit(n){if(predicate(n))result.push(n);for(const child of n.children??[])visit(child);}visit(tree);return result;}
const css=(m,name)=>nodes(m.tree,n=>String(n.props?.class??'').split(' ').includes(name));
const text=n=>n.tag==='#comment'?'':(n.text??'')+(n.children??[]).map(text).join('');
function handler(node,event){const value=node?.props?.[event];assert.ok(value,`Missing actual host ${event}`);return value;}
function replay(value,event={stopPropagation(){}}){for(const fn of Array.isArray(value)?value:[value])fn(event);}
function fire(node,event='onTap',value){replay(handler(node,event),{stopPropagation(){},detail:{value}});}
const hotReads=r=>r.io.filter(c=>c.url.endsWith('/search/hot_keyword'));
const searches=r=>r.io.filter(c=>c.url.endsWith('/products'));
const localHistoryWrites=r=>r.writes.filter(c=>c.key===HISTORY);
function assertRequests(r){assert(r.io.every(c=>c.method==='GET'&&(c.url.endsWith('/search/hot_keyword')||c.url.endsWith('/products'))));for(const c of hotReads(r)){assert.deepEqual(c.data,{});assert.equal(Object.keys(c.header).some(k=>/authori-zation|authorization/iu.test(k)),false);assert.notEqual(c.withCredentials,true);}for(const c of searches(r)){assert.deepEqual(Object.keys(c.data).sort(),['keyword','limit','page']);assert.equal(c.data.page,1);assert.equal(c.data.limit,20);}assert.deepEqual(r.sdk,[]);assert.equal([...r.storage.keys()].some(k=>/journal|claim|cart.*intent|order.*intent/iu.test(k)),false);}

function mount({platform='H5',authenticated=false,storage=new Map([[HISTORY,JSON.stringify(['本机旧词','另一旧词'])]]),words=[word()],products=[product()],send}={}){
  const io=[],writes=[],sdk=[];
  // This already-accepted pure Card only initializes the shared native/Pinia
  // loader. Its computed view is never rendered and installs no lifecycle/feed.
  // The real search page/controller are instantiated once by the Vue app below.
  const r=runtime({component:'components/diy/DiyLiveBroadcastCard.vue',props:{},platform,authenticated,storage,send:call=>{
    const captured={url:call.url,method:call.method,header:copy(call.header??{}),data:copy(call.data??{}),withCredentials:call.withCredentials};io.push(captured);
    assert(call.url.endsWith('/search/hot_keyword')||call.url.endsWith('/products'),'Unexpected search-page I/O '+call.url);
    if(send)return send(call);
    return call.url.endsWith('/search/hot_keyword')?receipt(words):receipt({list:products,count:products.length});
  }});
  const set=r.uni.setStorageSync,remove=r.uni.removeStorageSync;
  r.uni.setStorageSync=(key,value)=>{writes.push({kind:'set',key,value});return set(key,value);};r.uni.removeStorageSync=key=>{writes.push({kind:'remove',key});return remove(key);};
  for(const name of['requestSubscribeMessage','login','getProvider','navigateToMiniProgram'])r.uni[name]=(...args)=>{sdk.push({name,args});assert.fail('Search must not invoke SDK/login/provider '+name);};
  const mod=r.load(hookFile),originalHook=mod.useGoodsSearch;let controller;
  mod.useGoodsSearch=(...args)=>(controller=originalHook(...args));
  const component=r.load(pageFile).default;component.render=compile(pageFile);
  // ThemePage is real and rendered. Floating navigation is an adjacent tested
  // feature: preserve its actual template slot without starting a second feed.
  const themeFile=path.join(root,'src/components/ThemePage.vue');r.load(themeFile).default.render=compile(themeFile);
  const node=tag=>({tag,props:{},children:[],parent:null,text:''});
  const renderer=vue.createRenderer({createElement:node,createText:value=>({...node('#text'),text:value}),createComment:value=>({...node('#comment'),text:value}),setText(n,value){n.text=value;},setElementText(n,value){n.text=value;for(const child of n.children)child.parent=null;n.children=[];},parentNode:n=>n?.parent??null,nextSibling(n){if(!n?.parent)return null;const siblings=n.parent.children;return siblings[siblings.indexOf(n)+1]??null;},patchProp:(n,key,_old,value)=>{n.props[key]=value;},insert(n,parent,anchor=null){if(n.parent)n.parent.children=n.parent.children.filter(c=>c!==n);const at=anchor?parent.children.indexOf(anchor):-1;n.parent=parent;if(at<0)parent.children.push(n);else parent.children.splice(at,0,n);},remove(n){if(n?.parent){n.parent.children=n.parent.children.filter(c=>c!==n);n.parent=null;}}});
  const app=renderer.createApp({render:()=>vue.h(component)}),warnings=[],errors=[];
  app.use(pinia.getActivePinia());app.component('DiySuspendedNavigation',vue.defineComponent({name:'AdjacentSuspendedNavigation',setup:()=>()=>vue.h('view',{'data-adjacent-floating-navigation':true})}));app.config.warnHandler=value=>warnings.push(value);app.config.errorHandler=value=>errors.push(value);
  const tree=node('root');app.mount(tree);let alive=true;
  return{...r,io,writes,sdk,tree,get c(){return controller;},async start(query={}){await r.start(query);},unmount(){if(alive){alive=false;r.hooks.onUnload?.();app.unmount();}},finish(){try{assert.deepEqual(warnings,[]);assert.deepEqual(errors.map(String),[]);assertRequests(this);}finally{if(alive){alive=false;r.hooks.onUnload?.();app.unmount();}mod.useGoodsSearch=originalHook;r.stop();}}};
}
async function type(r,value){const input=css(r,'search-input')[0];assert.ok(input);fire(input,'onInput',value);await tick();return input;}
async function search(r,value,confirm=false){if(value!==undefined)await type(r,value);fire(css(r,confirm?'search-input':'search-btn')[0],confirm?'onConfirm':'onTap');await tick();}


const signed=(id=9,signature='a'.repeat(43),expires='1999999999')=>`/api/assets/${id}?expires=${expires}&signature=${signature}`;
for(const platform of ['H5','APP-PLUS','MP-WEIXIN']) {
 test(`signed hotword ${platform} uses only its configured API origin without changing the raw row or requiring browser URL globals`,async()=>{
  const saved={window:global.window,URL:global.URL};delete global.window;delete global.URL;let r;
  try {const icon=signed(2147483647);r=mount({platform,words:[word(801,{icon})]});await r.start();const base=r.load(path.join(root,'src/utils/request.ts')).API_BASE;
   assert.equal(css(r,'hotword-icon')[0].props.src,base+icon);assert.equal(r.c.hotWords.value[0].icon,icon);assert.equal(r.c.hotEntries.value[0].row.icon,icon);
   assert.equal(hotReads(r).length,1);assert.equal(searches(r).length,0);assert.equal(localHistoryWrites(r).length,0);assert.equal(text(css(r,'hotword')[0]),'A&B 中文热词');
  } finally {if(r)r.finish();if(saved.window===undefined)delete global.window;else global.window=saved.window;if(saved.URL===undefined)delete global.URL;else global.URL=saved.URL;}
 });
 test(`signed hotword ${platform} leaves ordinary HTTPS static relative and unsigned canonical sources byte exact`,async()=>{const icons=['https://cdn.example.test/a.png?x=1#y','/static/hotword.png','/uploads/old.svg','/api/assets/9'];const r=mount({platform,words:icons.map((icon,i)=>word(801+i,{icon}))});try{await r.start();assert.deepEqual(css(r,'hotword-icon').map(n=>n.props.src),icons);assert.deepEqual(r.c.hotWords.value.map(row=>row.icon),icons);assert.equal(hotReads(r).length,1);assert.equal(searches(r).length,0);}finally{r.finish();}});
 test(`signed hotword ${platform} does not promote malformed near-matches into API-origin assets`,async()=>{const icons=[signed(0),signed('01'),signed(2147483648),signed(9,'a'.repeat(42)),signed(9,'a'.repeat(44)),signed(9,'a'.repeat(43),'999999999'),signed(9,'a'.repeat(43),'19999999999'),signed()+'&extra=1',signed()+'#x',signed().replace('?expires=1999999999&signature=','?signature=')+'&expires=1999999999'];const r=mount({platform,words:icons.map((icon,i)=>word(801+i,{icon}))});try{await r.start();assert.deepEqual(css(r,'hotword-icon').map(n=>n.props.src),icons);assert.deepEqual(r.c.hotWords.value.map(row=>row.icon),icons);assert.equal(searches(r).length,0);}finally{r.finish();}});
 test(`signed hotword ${platform} rejects old cached image-error and tap after same-ID ticket renewal`,async()=>{let icon=signed();const r=mount({platform,send:c=>c.url.endsWith('/search/hot_keyword')?receipt([word(801,{icon})]):receipt({list:[product()],count:1})});try{await r.start();const oldError=handler(css(r,'hotword-icon')[0],'onError'),oldTap=handler(css(r,'hotword')[0],'onTap');icon=signed(9,'b'.repeat(43));fire(css(r,'refresh')[0]);await tick();const current=css(r,'hotword-icon')[0],src=current.props.src;replay(oldError);replay(oldTap);await tick();assert.strictEqual(css(r,'hotword-icon')[0],current);assert.equal(current.props.src,src);assert.equal(searches(r).length,0);assert.equal(localHistoryWrites(r).length,0);fire(current,'onError');await tick();assert.equal(css(r,'hotword-icon').length,0);assert.equal(css(r,'hotword').length,1);fire(css(r,'hotword')[0]);await tick();assert.equal(searches(r).length,1);}finally{r.finish();}});
 test(`signed hotword ${platform} retains raw-source lease when the same row object changes its signed icon`,async()=>{const r=mount({platform,words:[word(801,{icon:signed()})]});try{await r.start();const oldError=handler(css(r,'hotword-icon')[0],'onError'),oldTap=handler(css(r,'hotword')[0],'onTap');r.c.hotWords.value[0].icon=signed(10);await tick();const current=css(r,'hotword-icon')[0],src=current.props.src;replay(oldError);replay(oldTap);await tick();assert.equal(css(r,'hotword-icon')[0].props.src,src);assert.equal(searches(r).length,0);fire(css(r,'hotword')[0]);await tick();assert.equal(searches(r).length,1);}finally{r.finish();}});
 test(`signed hotword ${platform} retires old native callbacks on hide-owner ABA and unmount`,async()=>{const r=mount({platform,authenticated:true,words:[word(801,{icon:signed()})]});try{await r.start();const oldError=handler(css(r,'hotword-icon')[0],'onError'),oldTap=handler(css(r,'hotword')[0],'onTap');r.hooks.onHide();r.hooks.onShow();await tick();r.auth.setLogin('owner22',22);await tick();r.auth.setLogin('synthetic-local-token',11);await tick();const before=r.io.length,current=css(r,'hotword-icon')[0];replay(oldError);replay(oldTap);await tick();assert.equal(r.io.length,before);assert.ok(css(r,'hotword-icon')[0]);const lastError=handler(current,'onError'),lastTap=handler(css(r,'hotword')[0],'onTap');r.unmount();replay(lastError);replay(lastTap);await tick();assert.equal(r.io.length,before);assert.equal(localHistoryWrites(r).length,0);assert.deepEqual(r.navigations,[]);}finally{r.finish();}});
}
