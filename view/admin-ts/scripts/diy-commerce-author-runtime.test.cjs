const base = require('./helpers/diy-navigation-runtime.cjs');
const { getEventListeners, setMaxListeners } = require('node:events');
const { test, assert, fs, path, root, ts, vue, sfc, dom, renderer, node, all, text, elementNames, elementStub, tick, deferred } = base;
const { renderToString } = require('@vue/server-renderer');
const { ElInputNumber, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } = require('element-plus');
const editorFile = path.join(root, 'components/content/DiyCommerceEditor.vue');
const utilFile = path.join(root, 'utils/diyCommerceEditor.ts');
// Same installed Vue/SFC loader as the navigation suite. This parent's actual
// template contains valid TypeScript non-null assertions; transpile the actual
// compiler-dom output too, as Vite does, before evaluating its render function.
function loader(options = {}) {
  const cache = new Map(), instances = new Map(), notices = [], calls = [], galleryCalls = [], categoryCalls = [], uploadCalls = [];
  const actor = options.actor ?? vue.reactive({ token: 'A', userInfo: { id: 11, level: 0 }, uniqueAuth: [] });
  const storage = new Map([['admin_token', 'A'], ['admin_session', 'session-A']]);
  // A single imported document mounts >10 independent real link pickers.
  // Node's EventTarget warning limit is not a browser listener limit; every
  // parent harness below still asserts all session listeners leave on unmount.
  const window = new EventTarget(); setMaxListeners(100, window);
  const gateway = options.gateway ?? { get: async url => { calls.push({ method: 'GET', url }); return { data: [] }; }, post: async (url, body) => { calls.push({ method: 'POST', url, body: clone(body) }); return { data: { id: 2 } }; } };
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    let source = fs.readFileSync(file, 'utf8'), descriptor, script;
    if (file.endsWith('.vue')) { descriptor = sfc.parse(source, { filename: file }).descriptor; script = sfc.compileScript(descriptor, { id: 'navigation-editor-runtime' }); source = script.content; }
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    new Function('require', 'exports', 'window', 'localStorage', output)(name => {
      if (name === 'vue') return vue;
      if (name === 'element-plus') return { ElMessage: { error: value => notices.push(['error', value]), success: value => notices.push(['success', value]), warning: value => notices.push(['warning', value]) }, ElMessageBox: { confirm: async () => {} } };
      if (name === '@/stores/auth') return { useAuthStore: () => actor };
      if (name === '@/utils/auth') return { getToken: () => storage.get('admin_token') ?? null, getAdminSession: () => ({ userInfo: actor.userInfo, uniqueAuth: actor.uniqueAuth }) };
      if (name === '@/utils/request') return { __esModule: true, default: gateway, getData: async promise => (await promise).data };
      if (name === '@/api/attachment') return {
        apiAttachmentCategories: async (signal, params) => { categoryCalls.push({ signal, params }); return (options.categories ?? (async () => ({ list: [] })))(signal, params); },
        apiAttachmentList: async (params, signal) => { galleryCalls.push({ params: clone(params), signal }); return (options.gallery ?? (async () => ({ list: [], count: 0 })))(params, signal); },
        apiAttachmentUpload: async (file, pid, signal) => { uploadCalls.push({ file, pid, signal }); return (options.upload ?? (async () => ({ att_id: 18, url: '/api/assets/18', src: ticket(18) })))(file, pid, signal); },
      };
      // These adjacent editors are not this suite's producer. Keep the footer's
      // real named canonicalizer because actual DiseList.save composes it.
      if (name === '@/components/content/DiyCommerceEditor.vue') return { __esModule: true, ...load(editorFile) };
      if (name === '@/components/content/DiyPresentationEditor.vue') return { __esModule: true, default: vue.defineComponent({ setup: () => () => null }) };
      if (name === '@/components/content/DiyFooterEditor.vue') return { __esModule: true, ...load(path.join(root, name.slice(2))), default: vue.defineComponent({ setup: () => () => null }) };
      if (name.startsWith('@/')) return load(path.join(root, name.slice(2)));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name));
      return require(name);
    }, exports, window, { getItem: key => storage.get(key) ?? null });
    if (descriptor) {
      const component = exports.default, setup = component.setup;
      component.setup = (props, context) => { const state = setup(props, context); const values = instances.get(file) ?? []; values.push(vue.proxyRefs(state)); instances.set(file, values); return state; };
      component.render = new Function('Vue', ts.transpileModule(dom.compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, bindingMetadata: script.bindings }).code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(vue);
    }
    return exports;
  }
  return { load, instances, actor, storage, window, notices, calls, galleryCalls, categoryCalls, uploadCalls, componentOverrides: options.componentOverrides };
}

const clone=value=>JSON.parse(JSON.stringify(value));
const phpDefaults=JSON.parse(fs.readFileSync(path.resolve(root,'../../../workers-ts/test/fixtures/diy-commerce-author-defaults.json'),'utf8'));
const block=(kind,timestamp=10)=>({...clone(phpDefaults[kind]),timestamp});
const ticketExpires=Math.floor(Date.now()/1000)+900;
const ticket=(id,expires=ticketExpires)=>`/api/assets/${id}?expires=${expires}&signature=${'A'.repeat(43)}`;
const response=data=>({ok:true,json:async()=>({status:200,data})});
function harness(value=[block('promotionList')],options={}){
 const l=loader(options),props=vue.reactive({modelValue:JSON.stringify(value),editorKey:'commerce:2',disabled:false,pageId:2,pagePublished:true,...options.props}),writes=[],tree=node('root'),component=l.load(editorFile).default;
 const app=renderer.createApp({setup:()=>()=>vue.h(component,{...props,'onUpdate:modelValue':value=>{writes.push(value);if(!options.deferEcho)props.modelValue=value;}})});
 for(const name of [...new Set([...elementNames,'el-radio-button','el-checkbox'])])app.component(name,elementStub(name));app.directive('loading',{});app.mount(tree);let alive=true;
 return{...l,tree,props,writes,value:()=>JSON.parse(props.modelValue),get state(){return l.instances.get(editorFile).at(-1);},unmount(){if(alive){alive=false;app.unmount();for(const event of ['admin-session-changed','admin-auth-expired','storage'])assert.equal(getEventListeners(l.window,event).length,0,event+' cleanup');}}};
}
function control(r,label){const field=all(r.tree,n=>n.props['data-element']==='el-form-item'&&n.props['data-label']===label)[0];assert.ok(field,label);const input=all(field,n=>['el-input','el-input-number','el-select','el-color-picker'].includes(n.props['data-element']))[0];assert.ok(input,label);return input;}
for(const kind of Object.keys(phpDefaults))test('actual parent adds full PHP '+kind+' defaults and opaque neighbors',async()=>{
 const neighbors=[{name:'headerSerch',timestamp:-1,keep:{empty:[]}},{name:'opaque',tail:[false,null,0]},{name:'titles',timestamp:20},{name:'pageFoot',timestamp:900,keep:true}],before=clone(neighbors),r=harness(neighbors);
 try{await tick();assert.deepEqual(r.writes,[]);r.state.addKind=kind;r.state.add();await tick();const expected=clone(before);expected.splice(3,0,{...clone(phpDefaults[kind]),timestamp:21});assert.deepEqual(r.value(),expected);assert.equal(r.writes.length,1);}finally{r.unmount();}
});
for(const kind of Object.keys(phpDefaults))test('actual '+kind+' content/style switch preserves every dormant and unknown leaf',async()=>{
 const b=block(kind);b.opaque={null:null,empty:[],dormant:true};b.numberConfig={val:'001e2',retain:1};const before=clone(b),r=harness([b,{name:'opaque',value:['keep']}]);
 try{await tick();r.state.setLeaf(['setUp','tabVal'],1);await tick();assert.deepEqual(r.value()[0],{...before,setUp:{tabVal:1}});r.state.setLeaf(['setUp','tabVal'],0);await tick();assert.deepEqual(r.value()[0],before);assert.equal(r.writes.length,2);}finally{r.unmount();}
});
test('actual parent duplicates complete imported promotion tabs beyond12 and moves without discarding metadata',async()=>{
 const b=block('promotionList');b.tabConfig.list=Array.from({length:25},(_,i)=>({...clone(b.tabConfig.list[0]),index:i,opaque:{keep:[]}}));const before=clone(b),r=harness([b,{name:'news',timestamp:20}]);
 try{await tick();r.state.add(true);await tick();assert.equal(r.value().length,3);assert.deepEqual(r.value()[2],{...before,timestamp:21});r.state.move(-1);await tick();assert.deepEqual(r.value()[1],{...before,timestamp:20});r.state.remove();await tick();assert.equal(r.value().length,2);assert.deepEqual(r.value()[0],before);}finally{r.unmount();}
});
test('actual tab list add, move and remove retains all25 imported tabs and nested chiild metadata',async()=>{
 const b=block('promotionList');b.tabConfig.list=Array.from({length:25},(_,i)=>({...clone(b.tabConfig.list[0]),keep:i}));const before=clone(b),r=harness([b]);
 try{await tick();r.state.tabIndex=24;r.state.setTab(['chiild',0,'val'],'末尾');await tick();const expected=clone(before);expected.tabConfig.list[24].chiild[0].val='末尾';assert.deepEqual(r.value()[0],expected);r.state.tabEdit('add');await tick();assert.equal(r.value()[0].tabConfig.list.length,26);assert.deepEqual(r.value()[0].tabConfig.list.slice(0,25),expected.tabConfig.list);r.state.tabEdit('move',-1);await tick();assert.equal(r.value()[0].tabConfig.list[25].keep,24);r.state.tabEdit('remove');await tick();assert.deepEqual(r.value()[0],expected);}finally{r.unmount();}
});
for(const [scope,kind,pathKeys] of [[1,'product',['goodsList','ids']],[2,'brand',['brandConfig','brandVal']],[3,'category',['selectConfig','activeValue']],[4,'label',['goodsLabel','activeValue']]])test('actual typed '+kind+' selection touches only its exact promotion scope',async()=>{
 const r=harness();try{await tick();r.state.setTab(['tabVal'],scope);await tick();const before=r.value()[0],issued=r.state.picker;issued.choose({kind,id:17,name:'真实目录选择'});await tick();const after=r.value()[0],t=after.tabConfig.list[0];assert.deepEqual(t[pathKeys[0]][pathKeys[1]],[17]);assert.equal(after.tabConfig.list[0].tabVal,scope);assert.deepEqual(after.tabConfig.list[0].chiild,before.tabConfig.list[0].chiild);const raw=r.props.modelValue;issued.choose({kind,id:19,name:'过期目录'});await tick();assert.equal(r.props.modelValue,raw);r.state.setTab(['tabVal'],scope===1?2:1);await tick();issued.choose({kind,id:29,name:'跨范围回调'});await tick();assert.ok(!r.props.modelValue.includes('29'));}finally{r.unmount();}
});
test('actual editor rejects malformed field ancestors, dormant edits and invalid quantities without a write',async()=>{
 const b=block('seckill');b.titleTxtConfig='malformed';const r=harness([b]);try{await tick();r.state.setLeaf(['titleTxtConfig','value'],'坏');r.state.setLeaf(['numberConfig','val'],101);r.state.setLeaf(['styleConfig','tabVal'],99);await tick();assert.equal(r.writes.length,0);assert.deepEqual(r.value()[0],b);r.state.setLeaf(['numberConfig','val'],7);await tick();assert.equal(r.value()[0].numberConfig.val,7);}finally{r.unmount();}
});
for(const reason of ['raw','disabled','editor','role','storage','selection','unmount'])test('pending image choice is fenced after '+reason,async()=>{
 const b=block('seckill');b.imgConfig.url='/api/assets/7';const r=harness([b,block('bargain',20)]);try{await tick();const issued=r.state.mediaSession(['imgConfig','url']);if(reason==='raw')r.props.modelValue=JSON.stringify([b,{name:'opaque'}]);if(reason==='disabled')r.props.disabled=true;if(reason==='editor')r.props.editorKey='other';if(reason==='role'){r.actor.userInfo.level=1;r.actor.uniqueAuth=[];}if(reason==='storage')r.window.dispatchEvent(new Event('storage'));if(reason==='selection')r.state.select(1);if(reason==='unmount')r.unmount();await tick();const before=r.props.modelValue;await issued.choose('/api/assets/8',ticket(8));await tick();assert.equal(r.props.modelValue,before);assert.equal(r.writes.length,0);}finally{r.unmount();}
});
test('same attachment lease renewal and own field echo keep preview without rewriting imported references',async()=>{
 const b=block('seckill');b.imgConfig.url='/api/assets/7?old=signature';const r=harness([b]);try{await tick();await r.state.mediaSession(['imgConfig','url']).choose('/api/assets/7',ticket(7));await tick();assert.equal(r.writes.length,0);assert.equal(r.state.previewImage(['imgConfig','url']),ticket(7));r.state.setLeaf(['numberConfig','val'],7);await tick();assert.equal(r.value()[0].imgConfig.url,b.imgConfig.url);assert.equal(r.state.previewImage(['imgConfig','url']),ticket(7));}finally{r.unmount();}
});
test('changed attachment adopts exact own echo and leaves every other field intact',async()=>{
 const b=block('pointsMall'),r=harness([b]);try{await tick();const before=r.value();await r.state.mediaSession(['imgConfig','url']).choose('/api/assets/8',ticket(8));await tick();before[0].imgConfig.url='/api/assets/8';assert.deepEqual(r.value(),before);assert.equal(r.state.previewImage(['imgConfig','url']),ticket(8));}finally{r.unmount();}
});
for(const [kind,pathKeys] of [['coupon',['imgConfig','url']],['liveBroadcast',['imgConfig','url']],['promotionList',['tabConfig','list',0,'goodsList','list',0,'image']]])test(kind+' does not authorize row or arbitrary media',async()=>{
 const r=harness([block(kind)]);try{await tick();await r.state.mediaSession(pathKeys).choose('/api/assets/7',ticket(7));await tick();assert.equal(r.writes.length,0);assert.equal(r.state.previewImage(pathKeys),'');}finally{r.unmount();}
});
test('real public saved response binds entire promotion component including later tabs and exact metadata trim',async()=>{
 const b=block('promotionList');b.tabConfig.list=Array.from({length:15},(_,i)=>({...clone(b.tabConfig.list[0]),image:'/api/assets/'+(i+1),keep:i}));b.titleShow={title:'原版删除的标题',keep:true};const saved=clone(b);delete saved.titleShow.title;saved.tabConfig.list.forEach((tab,i)=>tab.image=ticket(i+1));const original=global.fetch;global.fetch=async()=>response({value:[saved]});const r=harness([b]);try{await tick();await r.state.loadSavedMedia();await tick();assert.equal(r.state.previewImage(['tabConfig','list',14,'image']),ticket(15));assert.equal(r.writes.length,0);saved.tabConfig.list[14].keep='foreign';await r.state.loadSavedMedia();await tick();assert.equal(r.state.previewImage(['tabConfig','list',0,'image']),'');assert.match(r.state.error,/不同/);}finally{r.unmount();global.fetch=original;}
});
for(const reason of ['raw','role','disabled','page','editor','storage','selection','unmount'])test('anonymous pending content clears and cannot settle across '+reason,async()=>{
 const pending=deferred(),original=global.fetch,calls=[];global.fetch=(url,options)=>{calls.push({url,options});return pending.promise;};const b=block('coupon'),r=harness([b,block('bargain',20)]);
 try{await tick();const load=r.state.loadContent();if(reason==='raw')r.props.modelValue=JSON.stringify([b,{name:'opaque'}]);if(reason==='role'){r.actor.userInfo.level=1;r.actor.uniqueAuth=[];}if(reason==='disabled')r.props.disabled=true;if(reason==='page')r.props.pageId=7;if(reason==='editor')r.props.editorKey='foreign';if(reason==='storage')r.window.dispatchEvent(new Event('admin-session-changed'));if(reason==='selection')r.state.select(1);if(reason==='unmount')r.unmount();await tick();pending.resolve(response({list:[],count:[0,0,0,0]}));await load;await tick();assert.equal(r.state.previewData,null);assert.equal(r.state.previewLoaded,false);assert.equal(r.writes.length,0);assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.headers.Authorization,undefined);}finally{r.unmount();global.fetch=original;}
});
async function actualNumber(props){const app=vue.createSSRApp({render:()=>vue.h(ElInputNumber,props)});app.provide(ID_INJECTION_KEY,{prefix:164,current:0});app.provide(ZINDEX_INJECTION_KEY,{current:0});return renderToString(app);}
test('installed numeric control preserves imported exponent and over-range spellings without emitting',async()=>{
 const b=block('seckill');b.numberConfig.val='1e3';const r=harness([b]);try{await tick();const input=control(r,'商品数量'),updates=[],handler=input.props['onUpdate:modelValue'],props={...input.props,'onUpdate:modelValue':value=>{updates.push(value);handler(value);}};for(const key of ['data-element','data-label','data-title'])delete props[key];await actualNumber(props);await tick();assert.deepEqual(updates,[]);assert.equal(r.writes.length,0);assert.equal(r.value()[0].numberConfig.val,'1e3');}finally{r.unmount();}
});
for(const [index,slot,expectedPath] of [[-1,0,null],[0,999,null],[0,501,'/api/seckill/list/501']])test('anonymous seckill preview uses actual Uni valid schedule choice index'+index+' explicit'+slot,async()=>{
 const l=loader(),api=l.load(path.join(root,'api/diyCommerceAuthor.ts')),u=l.load(path.join(root,'utils/diyCommerceProjection.ts')),theme=l.load(path.resolve(root,'../../common/theme.ts')).themePreset(3),cfg=u.normalizeDiyCommerce(block('seckill'),theme),original=global.fetch,calls=[];
 global.fetch=async(url,opts)=>{calls.push({url,opts});return response(url.startsWith('/api/seckill/index')?{seckillTime:[{id:501,start_time:'00:00',end_time:'24:00',state:'进行中',stop:1900000000,status:1}],seckillTimeIndex:index}:[]);};
 try{const data=await api.readCommercePreview(cfg,0,slot,new AbortController().signal);assert.equal(data.selectedSlot,expectedPath?501:0);assert.equal(calls.length,expectedPath?2:1);if(expectedPath)assert.ok(calls[1].url.startsWith(expectedPath));assert.ok(calls.every(call=>call.opts.method==='GET'&&call.opts.credentials==='omit'));}finally{global.fetch=original;}
});
test('actual DiseList save composes commerce canonicalizer and preserves independent content plus opaque neighbor',async()=>{
 const l=loader(),file=path.join(root,'pages/content/DiseList.vue'),tree=node('root'),component=l.load(file).default,app=renderer.createApp({setup:()=>()=>vue.h(component)});
 for(const name of [...new Set([...elementNames,'el-radio-button','el-checkbox'])])app.component(name,elementStub(name));app.directive('loading',{});app.mount(tree);
 try{await tick();const state=l.instances.get(file).at(-1),b=block('seckill'),promotion=block('promotionList',20);b.imgConfig.url='/api/assets/7?expires=1&signature=old';promotion.tabConfig.list[0].image='/api/assets/8?expires=1&signature=old';const opaque={name:'opaque',image:'/api/assets/9?keep',value:[0,false,[]]};state.openForm();await tick();state.form.name='商城测试页';state.form.value=JSON.stringify([b,promotion,opaque]);state.form.content='独立内容';await state.save();await tick();const save=l.calls.find(call=>call.method==='POST'&&call.url==='/dise/save');assert.ok(save);const expected=[clone(b),clone(promotion),opaque];expected[0].imgConfig.url='/api/assets/7';expected[1].tabConfig.list[0].image='/api/assets/8';assert.deepEqual(JSON.parse(save.body.value),expected);assert.equal(save.body.content,'独立内容');assert.equal(save.body.create_kind,'diy_page');}finally{app.unmount();}
});
