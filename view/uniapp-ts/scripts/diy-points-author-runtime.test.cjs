const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vue = require('vue');
const pinia = require('pinia');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const root = path.resolve(__dirname, '..'), widget = 'components/diy/DiyPointsWidget.vue', card = 'components/diy/DiyPointsCard.vue';
const copy = value => JSON.parse(JSON.stringify(value));
const origin = Date.UTC(2026,9,25,3), signature = 'P'.repeat(43);
const asset = (id=7, expiry=origin+900000) => `/api/assets/${id}?expires=${Math.floor(expiry/1000)}&signature=${signature}`;
const block = (extra={}) => ({name:'pointsMall',timestamp:101,isHide:false,styleConfig:{tabVal:1},titleConfig:{tabVal:0},titleTxtConfig:{value:'积分兑好礼'},titleText:{tabVal:0},goodStyleConfig:{tabVal:0},numberConfig:{val:3},toneConfig:{tabVal:0},imgBgConfig:{url:'/static/images/diy/points-bg.png'},imgConfig:{url:'/static/images/diy/points-title.png'},imgConfig2:{url:'/static/images/diy/points-title-alt.png'},goodsPriceColor:{color:[{item:'#ffffff'}]},goodsPriceColor2:{color:[{item:'#E93323'}]},fillet:{type:0,val:8},filletImg:{type:0,val:5},...extra});
const point = (id=901,extra={}) => ({id,product_id:103,title:`真实积分活动${id}`,image:`/static/business-${id}.png`,integral:120,price:'5',stock:9,sales:3,...extra});
const receipt = rows => ({data:rows});
const readCalls = r => r.calls.filter(call=>call.url.endsWith('/store_integral/list'));
function setup({ value = block(), active = true, platform = 'H5', send, authenticated = true, storage = new Map(), rows = [point()] } = {}) {
  const props = vue.reactive({ block: value, active });
  const answer = call => { if (call.url.endsWith('/store_integral/list')) return receipt(rows.slice(0, call.data.limit)); throw Error(`Unexpected points I/O ${call.url}`); };
  // Bootstrap only the pure Card setup in the shared real module/Pinia loader.
  // The Widget/controller are then genuinely mounted under Vue below, so app
  // unmount owns their real onScopeDispose hooks and captured native leases.
  const loaded = runtime({ component: card, props: {}, platform, authenticated, storage, send: send ?? answer });
  const r = { ...loaded, props, pinia: pinia.getActivePinia() };
  Object.defineProperties(r, { c: { get: () => r.checkout.state }, entries: { get: () => r.checkout.entries.value }, actions: { get: () => r.checkout.actions.value }, view: { get: () => r.checkout.config.value } });
  return r;
}
function compile(file) {
  const sfc = require('@vue/compiler-sfc'), dom = require('@vue/compiler-dom'), descriptor = sfc.parse(fs.readFileSync(file, 'utf8'), { filename: file }).descriptor;
  return new Function('Vue', dom.compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, bindingMetadata: sfc.compileScript(descriptor, { id: 'points-author-real-template' }).bindings, isCustomElement: tag => ['view', 'text', 'image', 'scroll-view'].includes(tag) }).code)(vue);
}
function nodes(tree, predicate) { const found = []; function visit(node) { if (predicate(node)) found.push(node); for (const child of node.children ?? []) visit(child); } visit(tree); return found; }
const css = (tree, name) => nodes(tree, node => String(node.props?.class ?? '').split(' ').includes(name));
const text = node => (node.text ?? '') + (node.children ?? []).map(text).join('');
function fire(node, key = 'onTap') { const fn = node?.props?.[key]; assert.ok(fn, `Missing real native ${key}`); for (const callback of Array.isArray(fn) ? fn : [fn]) callback({ stopPropagation() {} }); }
function mount(r, propsList = [r.props]) {
  const controllerModule = r.load(path.join(root, 'src/composables/useDiyPoints.ts')), originalController = controllerModule.useDiyPoints, controllers = [];
  controllerModule.useDiyPoints = (...args) => { const value = originalController(...args); controllers.push(value); if (controllers.length === 1) r.controller = value; return value; };
  const file = path.join(root, 'src', widget), actual = r.load(file).default, original = actual.setup, instances = [];
  actual.setup = (props, context) => { const state = original(props, context), instance = { props, state, disposed: false }; instances.push(instance); if (instances.length === 1) r.checkout = state; vue.onScopeDispose(() => { instance.disposed = true; }); return state; };
  actual.render = compile(file); r.load(path.join(root, 'src', card)).default.render = compile(path.join(root, 'src', card));
  const node = tag => ({ tag, props: {}, children: [], parent: null, text: '' });
  const renderer = vue.createRenderer({ createElement: node, createText: value => ({ ...node('#text'), text: value }), createComment: value => ({ ...node('#comment'), text: value }),
    setText(n, value) { n.text = value; }, setElementText(n, value) { n.text = value; for (const child of n.children) child.parent = null; n.children = []; },
    parentNode: n => n?.parent ?? null, nextSibling(n) { if (!n?.parent) return null; const siblings = n.parent.children; return siblings[siblings.indexOf(n) + 1] ?? null; }, patchProp: (n, key, _old, value) => { n.props[key] = value; },
    insert(n, parent, anchor = null) { if (n.parent) n.parent.children = n.parent.children.filter(child => child !== n); const index = anchor ? parent.children.indexOf(anchor) : -1; n.parent = parent; if (index < 0) parent.children.push(n); else parent.children.splice(index, 0, n); },
    remove(n) { if (n?.parent) { n.parent.children = n.parent.children.filter(child => child !== n); n.parent = null; } },
  });
  const app = renderer.createApp({ setup: () => () => vue.h(vue.Fragment, propsList.map((props, index) => vue.h(actual, { ...props, key: index }))) });
  const warnings = [], errors = []; app.config.warnHandler = value => warnings.push(value); app.config.errorHandler = value => errors.push(value); app.use(r.pinia); const tree = node('root'); app.mount(tree); let alive = true;
  return { app, tree, instances, controllers, assertClean() { assert.deepEqual(warnings, []); assert.deepEqual(errors.map(String), []); }, unmount() { if (alive) { alive = false; app.unmount(); actual.setup = original; controllerModule.useDiyPoints = originalController; } } };
}
function finish(r, m) { try { m?.assertClean(); } finally { m?.unmount(); r.stop(); } }


/** Advance real production lease callbacks without sleeping or mocking Vue. */
async function clocked(work) {
 const before={now:Date.now,window:global.window,setTimeout:global.setTimeout,clearTimeout:global.clearTimeout};let now=origin,next=1;const timers=new Map();
 Date.now=()=>now;global.window={location:{origin:'https://owned-points.example',hostname:'owned-points.example',search:''}};
 global.setTimeout=(fn,delay=0,...args)=>{const id=next++;timers.set(id,{at:now+Number(delay),callback:()=>fn(...args)});return id;};global.clearTimeout=id=>timers.delete(id);
 const advance=value=>{now=value;let count=0;for(;;){const due=[...timers.entries()].filter(([,t])=>t.at<=now).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;assert.ok(++count<1000,'Owned points clock runaway');timers.delete(due[0]);due[1].callback();}};
 try{await work(advance);}finally{Date.now=before.now;global.setTimeout=before.setTimeout;global.clearTimeout=before.clearTimeout;if(before.window===undefined)delete global.window;else global.window=before.window;}
}
function noWrites(r){assert.ok(r.calls.every(call=>call.url.endsWith('/store_integral/list')), 'Only the integral list is read');assert.equal([...r.storage.keys()].some(key=>/claim|journal|cart|exchange|order/i.test(key)),false);}
function orderedElements(node){return(node.children??[]).filter(child=>child.tag!=='#text'&&child.tag!=='#comment');}

for(const layout of[0,1,2])test(`actual installed Vue points layout${layout} uses fixed PHP structure dimensions icon and title order`,()=>clocked(async()=>{
 const value=block({goodStyleConfig:{tabVal:layout},numberConfig:{val:7}}),before=copy(value),r=setup({value,rows:Array.from({length:7},(_,i)=>point(901+i))}),m=mount(r);
 try{await tick();assert.equal(r.c.loaded.value,true);assert.equal(r.c.error.value,'');assert.equal(readCalls(r).length,1);assert.deepEqual(readCalls(r)[0].data,{page:1,limit:7});
  const cards=css(m.tree,'points-card');assert.equal(cards.length,7);assert.equal(cards[0].props.style.flex,['0 0 224rpx','0 0 33.33%','0 0 50%'][layout]);assert.equal(css(m.tree,'points-product-image')[0].props.style.height,['224rpx','212rpx','324rpx'][layout]);assert.equal(css(m.tree,'points-product-image')[0].props.style.borderRadius,'10rpx');
  assert.equal(css(m.tree,'points-body')[0].props.style.padding,['0 0 32rpx 20rpx','0','0 10rpx 8rpx'][layout]);assert.equal(css(m.tree,'points-scroll').length,layout===0?1:0);assert.equal(css(m.tree,'points-icon').length,layout===0?0:7);assert.equal(css(m.tree,'points-product-title').length,layout===0?0:7);
  assert.equal(css(m.tree,'points-price')[0].props.style.height,layout===0?'36rpx':'auto');assert.equal(css(m.tree,'points-price')[0].props.style.fontSize,layout===0?'22rpx':'24rpx');
  if(layout===0){assert.equal(css(m.tree,'points-scroll')[0].props.style.padding,'20rpx 0 20rpx 20rpx');assert.equal(cards[0].props.style.margin,'0 20rpx 0 0');assert.equal(css(m.tree,'points-price')[0].props.style.borderRadius,'2rpx 20rpx 20rpx 20rpx');assert.match(text(cards[0]),/120积分\+5\.00元/);}
  else{assert.equal(cards[0].props.style.padding,'0 10rpx 20rpx');assert.equal(css(m.tree,'points-icon')[0].props.src,'/static/images/diy/points-icon.png');assert.equal(css(m.tree,'points-icon')[0].props.style.width,'28rpx');assert.equal(css(m.tree,'points-icon')[0].props.style.marginRight,layout===1?'8rpx':'4rpx');assert.equal(css(m.tree,'points-product-title')[0].props.style.fontSize,layout===1?'26rpx':'28rpx');assert.equal(css(m.tree,'points-product-title')[0].props.style.WebkitLineClamp,layout===1?'1':'2');const children=orderedElements(cards[0]),titleIndex=children.findIndex(n=>String(n.props.class).includes('points-product-title')),priceIndex=children.findIndex(n=>String(n.props.class).includes('points-price'));assert.equal(titleIndex<priceIndex,layout===2);assert.equal(text(cards[0]).includes('积分+'),false);}
  assert.equal(css(m.tree,'points-header')[0].props.style.height,'96rpx');assert.equal(css(m.tree,'points-title-image')[0].props.style.width,'176rpx');assert.equal(css(m.tree,'points-title-image')[0].props.style.height,'32rpx');assert.deepEqual(r.props.block,before);assert.deepEqual(r.navigations,[]);noWrites(r);
 }finally{finish(r,m);}
}));

test('pure points projection retains raw rpx outer spacing and doubled nonsymmetric0/1/3/2 corners without mutating imports',()=>clocked(async()=>{
 const value=block({topConfig:{val:'0'},prConfig:{val:'5e-4'},bottomConfig:{val:' 2 '},mbConfig:{val:'3'},fillet:{type:1,valList:[1,2,3,4].map(val=>({val}))},filletImg:{type:'1',valList:[5,6,7,8].map(val=>({val}))}}),before=copy(value),r=setup({value}),m=mount(r);
 try{await tick();assert.equal(r.view.wrapperStyle.padding,'0rpx 0.0005rpx 2rpx');assert.equal(r.view.wrapperStyle.marginTop,'3rpx');assert.equal(r.view.panelStyle.borderRadius,'2rpx 4rpx 8rpx 6rpx');assert.equal(r.view.imageStyle.borderRadius,'10rpx 12rpx 16rpx 14rpx');assert.deepEqual(r.props.block,before);noWrites(r);}finally{finish(r,m);}
}));

for(const layout of[0,1,2])test(`actual PHP points layout${layout} custom and theme0 numeric colors are distinct from generic theme role heuristics`,()=>clocked(async()=>{
 const r=setup({active:false}),m=mount(r);
 try{const {pointsPresentation}=r.load(path.join(root,'../common/diyPoints.ts')),{safeDiyColor,safeDiyImageUrl}=r.load(path.join(root,'src/utils/diy.ts')),theme={theme:'#a11020',gradient:'#eebbcc',priceColor:'#990000'},value=block({goodStyleConfig:{tabVal:layout},goodsPriceColor:{color:[{item:'#123456'}]},goodsPriceColor2:{color:[{item:'#654321'}]},goodsUnitPriceColor:{color:[{item:'#778899'}]},priceBgColor:{color:[{item:'#112233'},{item:'#445566'}]},moduleColor:{color:[{item:'#abcdef'},{item:'#fedcba'}]},moduleColor2:{color:[{item:'#121212'},{item:'#343434'}]},headerBgColor:{color:[{item:'#556677'},{item:'#8899aa'}]}}),before=copy(value);
  const themed=pointsPresentation(value,theme,safeDiyImageUrl,safeDiyColor),custom=pointsPresentation({...value,toneConfig:{tabVal:1}},theme,safeDiyImageUrl,safeDiyColor);
  assert.equal(themed.numberStyle.color,'#123456','PHP tone0 reads authored goodsPriceColor');assert.equal(custom.numberStyle.color,'#654321');assert.equal(themed.priceStyle.color,layout===0?'#ffffff':'#666666');assert.equal(custom.priceStyle.color,layout===0?'#123456':'#778899');assert.equal(themed.priceStyle.background,layout===0?'linear-gradient(90deg, #a11020 0%, #eebbcc 100%)':'none');assert.equal(custom.priceStyle.background,layout===0?'linear-gradient(90deg, #112233 0%, #445566 100%)':'none');assert.equal(custom.panelStyle.backgroundImage,'linear-gradient(270deg, #abcdef 0%, #fedcba 100%)');
  const plain=pointsPresentation({...value,styleConfig:{tabVal:0}},theme,safeDiyImageUrl,safeDiyColor);assert.equal(plain.panelStyle.backgroundImage,'linear-gradient(270deg, #121212 0%, #343434 100%)');assert.equal(plain.headerStyle.backgroundImage,'linear-gradient(90deg, #556677 0%, #8899aa 100%)');assert.deepEqual(value,before);assert.deepEqual(r.calls,[]);
 }finally{finish(r,m);}
}));

test('all six preserved author-only metadata fields do not change any actual public style or text',()=>clocked(async()=>{
 const r=setup({active:false}),m=mount(r);
 try{const {pointsPresentation}=r.load(path.join(root,'../common/diyPoints.ts')),{safeDiyColor,safeDiyImageUrl}=r.load(path.join(root,'src/utils/diy.ts')),theme={theme:'#a11020',gradient:'#eebbcc',priceColor:'#990000'},original=block(),inert={...original,rightBntConfig:{value:'被保留的文本'},titleColor:{color:[{item:'#123456'}]},titleNumber:{val:99},goodsNameColor2:{color:[{item:'#654321'}]},goodsUnitPriceColor2:{color:[{item:'#fedcba'}]},bottomBgColor:{color:[{item:'#abcdef'}]}};assert.deepEqual(pointsPresentation(inert,theme,safeDiyImageUrl,safeDiyColor),pointsPresentation(original,theme,safeDiyImageUrl,safeDiyColor));r.props.active=true;r.props.block=inert;await tick();assert.equal(text(css(m.tree,'points-more')[0]),'更多 ›');assert.equal(r.view.titleStyle.fontSize,'32rpx');assert.equal(r.view.titleStyle.color,'#333333');assert.equal(Object.hasOwn(r.view.wrapperStyle,'background'),false);noWrites(r);
 }finally{finish(r,m);}
}));

for(const font of[0,1,2])test(`real title font${font} follows bold normal italic rather than community font semantics`,()=>clocked(async()=>{
 const r=setup({value:block({titleConfig:{tabVal:1},titleText:{tabVal:font}})}),m=mount(r);
 try{await tick();const title=css(m.tree,'points-heading')[0];assert.equal(title.props.style.fontWeight,font===0?'bold':'normal');assert.equal(title.props.style.fontStyle,font===2?'italic':'normal');assert.equal(text(title),'积分兑好礼');assert.equal(css(m.tree,'points-title-image').length,0);noWrites(r);}finally{finish(r,m);}
}));

for(const platform of['H5','APP-PLUS','MP-WEIXIN'])test(`${platform} compiled more font-size keeps the original bare numeric value without invented px or rpx`,()=>clocked(async()=>{
 const r=setup({platform,value:block({bntNumber:{val:'17.5'}})}),m=mount(r);
 try{await tick();assert.equal(typeof css(m.tree,'points-more')[0].props.style.fontSize,'number');assert.equal(css(m.tree,'points-more')[0].props.style.fontSize,17.5);assert.equal(css(m.tree,'points-more')[0].props.style.color,'#ffffff');noWrites(r);}finally{finish(r,m);}
}));

for(const[raw,limit]of[[0,0],['0',0],['5e-4',0],[' 2.99 ',2],['003',3],[10,10],['1e30',10],['bad',6],[undefined,6]])test(`raw points count${String(raw)} is only projected into the current TS floor/clamp/min10 read`,()=>clocked(async()=>{
 const value=block({numberConfig:raw===undefined?{}:{val:raw},keep:[0,false,'']}),before=copy(value),r=setup({value}),m=mount(r);
 try{await tick();assert.equal(r.view.limit,limit);assert.equal(r.c.config.value.limit,limit);assert.equal(readCalls(r).length,limit?1:0);assert.equal(r.c.loaded.value,true);if(limit)assert.equal(readCalls(r)[0].data.limit,limit);else assert.match(text(m.tree),/暂无可展示/);assert.deepEqual(r.props.block,before);noWrites(r);}finally{finish(r,m);}
}));

test('compiled actual Renderer chooses points coupon promotion presale independently and precisely no remaining Commerce families',()=>clocked(async()=>{
 const components=[block(),{name:'coupon',timestamp:102},{name:'promotionList',timestamp:103},...['bargain','combination','liveBroadcast','seckill','presale'].map((name,index)=>({name,timestamp:200+index}))],props=vue.reactive({components,pageActive:false,pageRefreshing:false,microPage:false,scrollTop:0,loadMoreSignal:0}),r=runtime({component:'components/diy/DiyHomeRenderer.vue',props,platform:'H5',send:()=>{throw Error('Inactive Renderer must not read');}});
 try{const file=path.join(root,'src/components/diy/DiyHomeRenderer.vue'),render=compile(file),bindings=vue.proxyRefs(r.checkout),context={...props,...bindings},tree=render.call(context,context,[],props,bindings,{},{}),found=[];function visit(node){if(Array.isArray(node))return node.forEach(visit);if(!node||typeof node!=='object')return;found.push(node);visit(node.children);}visit(tree);const bargain=r.load(path.join(root,'src/components/diy/DiyBargainWidget.vue')).default;const seckill=r.load(path.join(root,'src/components/diy/DiySeckillWidget.vue')).default;const live=r.load(path.join(root,'src/components/diy/DiyLiveBroadcastWidget.vue')).default;
  const points=r.load(path.join(root,'src',widget)).default,coupon=r.load(path.join(root,'src/components/diy/DiyCouponWidget.vue')).default,promotion=r.load(path.join(root,'src/components/diy/DiyPromotionWidget.vue')).default,commerce=r.load(path.join(root,'src/components/diy/DiyCommerceWidget.vue')).default,presale=r.load(path.join(root,'src/components/diy/DiyPresaleWidget.vue')).default,combination=r.load(path.join(root,'src/components/diy/DiyCombinationWidget.vue')).default,selected=found.filter(node=>[points,coupon,promotion,presale,combination, live, seckill, bargain,commerce].includes(node.type));assert.equal(selected.length,8);assert.equal(selected[0].type,points);assert.equal(selected[0].props.active,false);assert.equal(selected[1].type,coupon);assert.equal(selected[2].type,promotion);assert.deepEqual(selected.filter(node=>node.type===commerce).map(node=>node.props.block.name),[]);assert.equal(selected.find(node=>node.props.block.name==='presale').type,presale);assert.equal(r.checkout.isCommerceWidget({name:'presale'}),false);assert.equal(r.checkout.isCommerceWidget({name:'pointsMall'}),false);assert.deepEqual(r.calls,[]);assert.equal(selected.find(node=>node.props.block.name==='combination').type,combination);assert.equal(r.checkout.isCommerceWidget({name:'combination'}),false);assert.equal(selected.find(node=>node.props.block.name==='bargain').type,bargain);assert.equal(r.checkout.isCommerceWidget({name:'bargain'}),false);assert.equal(selected.find(node=>node.props.block.name==='seckill').type,seckill);assert.equal(r.checkout.isCommerceWidget({name:'seckill'}),false);assert.equal(selected.find(node=>node.props.block.name==='liveBroadcast').type,live);assert.equal(r.checkout.isCommerceWidget({name:'liveBroadcast'}),false);
 }finally{r.stop();}
}));

for(const platform of['H5','APP-PLUS','MP-WEIXIN'])test(`${platform} actual guest points cards open activity ID detail and more without cart exchange or login`,()=>clocked(async()=>{
 const r=setup({platform,authenticated:false,rows:[point(901,{product_id:103})]}),m=mount(r);
 try{await tick();fire(css(m.tree,'points-card')[0]);await tick();fire(css(m.tree,'points-more')[0]);await tick();assert.deepEqual(r.navigations,['/pages/activity/integralDetail?id=901','/pages/user/integral']);assert.equal(r.navigations.some(url=>url.includes('id=103')),false);assert.equal(css(m.tree,'points-card')[0].props['data-points-id'],901);noWrites(r);}finally{finish(r,m);}
}));

test('real failed and malformed-tail reads expose retry without partial cards or counterfeit Admin rows',()=>clocked(async()=>{
 let stage=0;const r=setup({send:()=>stage===0?{httpStatus:503,msg:'owned feed failure'}:stage===1?receipt([point(),point()]):receipt([point(902)])}),m=mount(r);
 try{await tick();assert.equal(r.c.loaded.value,false);assert.match(text(m.tree),/owned feed failure/);assert.equal(css(m.tree,'points-card').length,0);stage=1;fire(css(m.tree,'points-refresh')[0]);await tick();assert.equal(r.c.loaded.value,false);assert.match(r.c.error.value,/重复/);assert.equal(css(m.tree,'points-card').length,0);stage=2;fire(css(m.tree,'points-refresh')[0]);await tick();assert.equal(r.c.loaded.value,true);assert.equal(css(m.tree,'points-card')[0].props['data-points-id'],902);assert.equal(readCalls(r).length,3);noWrites(r);}finally{finish(r,m);}
}));

async function crossBoundary(boundary,r,m){
 if(boundary==='account')r.auth.setLogin('owner22',22);
 else if(boundary==='accountABA'){const uid=r.auth.uid;r.auth.uid=22;await tick();r.auth.uid=uid;}
 else if(boundary==='session')r.auth.setLogin(r.auth.token,r.auth.uid);
 else if(boundary==='count')r.props.block.numberConfig.val=2;
 else if(boundary==='raw')r.props.block.opaque={extra:true};
 else if(boundary==='rawABA'){const raw=copy(r.props.block);r.props.block={...raw,opaque:true};await tick();r.props.block=raw;}
 else if(boundary==='activeABA'){r.props.active=false;await tick();r.props.active=true;}
 else if(boundary==='disabled')r.props.block.isHide=true;
 else if(boundary==='legacyDisabled')r.props.block.isShow=false;
 else if(boundary==='hidden')r.props.active=false;
 else if(boundary==='reloadSameID')fire(css(m.tree,'points-refresh')[0]);
 else if(boundary==='dispose')r.controller.dispose();
 else if(boundary==='unmount')m.unmount();
 else assert.fail('Unknown points boundary '+boundary);
 await tick();
}
for(const boundary of['account','accountABA','session','count','raw','rawABA','activeABA','disabled','legacyDisabled','hidden','reloadSameID','dispose','unmount'])test(`captured real points card more refresh and header callbacks cannot cross${boundary}`,()=>clocked(async()=>{
 const r=setup(),m=mount(r);
 try{await tick();const callbacks=['points-card','points-more','points-refresh'].map(name=>css(m.tree,name)[0].props.onTap),probe=css(m.tree,'points-background-probe')[0],title=css(m.tree,'points-title-image')[0],old=[probe.props.onLoad,probe.props.onError,title.props.onLoad,title.props.onError];await crossBoundary(boundary,r,m);const calls=r.calls.length,failures=copy(r.checkout.imageFailures.value);for(const fn of [...callbacks,...old])fn();await tick();assert.equal(r.calls.length,calls);assert.deepEqual(r.navigations,[]);assert.deepEqual(r.checkout.imageFailures.value,failures);if(boundary==='unmount')assert.equal(m.instances[0].disposed,true);noWrites(r);
 }finally{finish(r,m);}
}));

for(const boundary of['account','raw','rawABA','activeABA','hidden','unmount'])test(`pending real integral feed cannot adopt late old source material across${boundary}`,()=>clocked(async()=>{
 const wait=deferred();let first=true;const r=setup({send:()=>first?(first=false,wait.promise):receipt([point(902)])}),m=mount(r);
 try{await tick();assert.equal(r.c.loading.value,true);await crossBoundary(boundary,r,m);wait.resolve(receipt([point(999)]));await tick();assert.equal(r.c.cards.value.some(row=>row.id===999),false);assert.equal(css(m.tree,'points-card').some(node=>node.props['data-points-id']===999),false);assert.deepEqual(r.navigations,[]);noWrites(r);}finally{wait.resolve(receipt([]));finish(r,m);}
}));

test('late old-owner failed/finally feed cannot release a newer loading generation',()=>clocked(async()=>{
 const old=deferred(),fresh=deferred();let reads=0;const r=setup({send:()=>++reads===1?old.promise:fresh.promise}),m=mount(r);
 try{await tick();r.auth.setLogin('owner22',22);await tick();assert.equal(readCalls(r).length,2);old.resolve({httpStatus:503,msg:'late failure'});await tick();assert.equal(r.c.loading.value,true);assert.equal(r.c.error.value,'');fresh.resolve(receipt([point(902)]));await tick();assert.equal(r.c.loading.value,false);assert.equal(css(m.tree,'points-card')[0].props['data-points-id'],902);noWrites(r);}finally{old.resolve(receipt([]));fresh.resolve(receipt([]));finish(r,m);}
}));

test('two genuinely mounted points instances own independent raw state and same-ID native callbacks',()=>clocked(async()=>{
 const r=setup(),second=vue.reactive({block:block({timestamp:202,goodStyleConfig:{tabVal:2}}),active:true}),m=mount(r,[r.props,second]);
 try{await tick();assert.equal(readCalls(r).length,2);assert.equal(m.controllers.length,2);assert.notStrictEqual(m.controllers[0].state,m.controllers[1].state);const [a,b]=css(m.tree,'points-card').map(node=>node.props.onTap);r.props.block.opaque=true;await tick();const reads=readCalls(r).length;a();await tick();assert.deepEqual(r.navigations,[]);b();await tick();assert.deepEqual(r.navigations,['/pages/activity/integralDetail?id=901']);assert.equal(readCalls(r).length,reads);noWrites(r);}finally{finish(r,m);}
}));

for(const slot of['imgBgConfig','imgConfig','imgConfig2'])test(`even dormant points ${slot} expiry blocks the whole rendered media and all captured native actions`,()=>clocked(async advance=>{
 const value=block({styleConfig:{tabVal:0},titleConfig:{tabVal:1},[slot]:{url:asset(7)}}),r=setup({value}),m=mount(r);
 try{await tick();assert.equal(r.controller.ready(),true);assert.equal(readCalls(r).length,1);const tap=css(m.tree,'points-card')[0].props.onTap,more=css(m.tree,'points-more')[0].props.onTap,refresh=css(m.tree,'points-refresh')[0].props.onTap,oldImages=Object.values(r.checkout.images.value).flatMap(image=>[image.loaded,image.failed]);assert.equal(r.controller.mediaDeadline.value,origin+840000);
  advance(origin+839999);await tick();assert.equal(r.controller.ready(),true);advance(origin+840000);await tick();assert.equal(r.controller.ready(),false);assert.equal(css(m.tree,'points-panel').length,0);assert.equal(css(m.tree,'points-product-image').length,0);assert.match(text(m.tree),/图片授权已失效/);const reads=readCalls(r).length,failures=copy(r.checkout.imageFailures.value);for(const fn of[tap,more,refresh,...oldImages])fn();await tick();assert.equal(readCalls(r).length,reads);assert.deepEqual(r.navigations,[]);assert.deepEqual(r.checkout.imageFailures.value,failures);noWrites(r);
 }finally{finish(r,m);}
}));

for(const slot of['imgBgConfig','imgConfig','imgConfig2'])test(`unsigned expired malformed or missing-ticket ${slot} cannot start the actual points feed even when dormant`,()=>clocked(async()=>{
 for(const url of['/api/assets/7',asset(7,origin-1000),'/api/assets/7?expires=9999999999&signature=bad','/api/assets/7?expires=9999999999&expires=9999999998&signature='+signature]){
  const r=setup({value:block({styleConfig:{tabVal:0},titleConfig:{tabVal:1},[slot]:{url}})}),m=mount(r);
  try{await tick();assert.equal(r.controller.ready(),false);assert.deepEqual(r.calls,[]);assert.equal(css(m.tree,'points-panel').length,0);assert.match(text(m.tree),/图片授权已失效/);assert.deepEqual(r.navigations,[]);}finally{finish(r,m);}
 }
}));

for(const platform of['H5','APP-PLUS','MP-WEIXIN'])test(`${platform} all three ticket-only renewals preserve feed material and current raw configuration while invalidating old image and native tap leases`,()=>clocked(async advance=>{
 const value=block({imgBgConfig:{url:asset(7)},imgConfig:{url:asset(8)},imgConfig2:{url:asset(9)}}),r=setup({platform,value}),m=mount(r);
 try{await tick();assert.equal(readCalls(r).length,1);const products=r.c.cards.value,fingerprint=r.controller.fingerprint.value,oldTap=css(m.tree,'points-card')[0].props.onTap,oldMore=css(m.tree,'points-more')[0].props.onTap,probe=css(m.tree,'points-background-probe')[0],title=css(m.tree,'points-title-image')[0],oldEvents=[probe.props.onLoad,probe.props.onError,title.props.onLoad,title.props.onError];advance(origin+100000);
  for(const[slot,id]of[['imgBgConfig',7],['imgConfig',8],['imgConfig2',9]])r.props.block[slot].url=asset(id,origin+1200000);await tick();assert.equal(r.controller.fingerprint.value,fingerprint);assert.strictEqual(r.c.cards.value,products);assert.equal(readCalls(r).length,1);assert.equal(r.controller.ready(),true);const failures=copy(r.checkout.imageFailures.value);for(const fn of[oldTap,oldMore,...oldEvents])fn();await tick();assert.deepEqual(r.navigations,[]);assert.deepEqual(r.checkout.imageFailures.value,failures);assert.equal(readCalls(r).length,1);
  const prefix=platform==='H5'?'':'https://cinashop-api.cinagroup.workers.dev';assert.equal(css(m.tree,'points-background-probe')[0].props.src,prefix+asset(7,origin+1200000));assert.equal(css(m.tree,'points-title-image')[0].props.src,prefix+asset(8,origin+1200000));fire(css(m.tree,'points-background-probe')[0],'onLoad');fire(css(m.tree,'points-title-image')[0],'onLoad');fire(css(m.tree,'points-card')[0]);await tick();assert.deepEqual(r.navigations,['/pages/activity/integralDetail?id=901']);assert.equal(readCalls(r).length,1);noWrites(r);
 }finally{finish(r,m);}
}));

for(const platform of['H5','APP-PLUS','MP-WEIXIN'])test(`${platform} real background image probe and title native callbacks hide current failures and reject old load error or source replacement`,()=>clocked(async()=>{
 const r=setup({platform,value:block({imgBgConfig:{url:asset(7)},imgConfig:{url:asset(8)},imgConfig2:{url:asset(9)}})}),m=mount(r);
 try{await tick();const probe=css(m.tree,'points-background-probe')[0],oldLoad=probe.props.onLoad,oldError=probe.props.onError;fire(probe,'onError');await tick();assert.equal(r.checkout.imageFailures.value.imgBgConfig,true);assert.equal(css(m.tree,'points-background-probe').length,0);assert.equal(css(m.tree,'points-header')[0].props.style.backgroundImage,'none');oldLoad();oldError();await tick();assert.equal(r.checkout.imageFailures.value.imgBgConfig,true,'Old load cannot revive failed CSS background');
  const title=css(m.tree,'points-title-image')[0],titleLoad=title.props.onLoad,titleError=title.props.onError;r.props.block.imgConfig.url=asset(10);await tick();titleLoad();titleError();await tick();assert.equal(r.checkout.imageFailures.value.imgConfig,undefined);assert.equal(css(m.tree,'points-title-image')[0].props.src.endsWith(asset(10)),true);fire(css(m.tree,'points-title-image')[0],'onError');await tick();assert.equal(css(m.tree,'points-title-image').length,0);assert.equal(r.checkout.imageFailures.value.imgConfig,true);noWrites(r);
 }finally{finish(r,m);}
}));

test('managed raw intent changes invalidate in-flight feed even when quantity and public projection are otherwise identical',()=>clocked(async()=>{
 const wait=deferred();let reads=0;const r=setup({send:()=>++reads===1?wait.promise:receipt([point(902)])}),m=mount(r);
 try{await tick();const firstFingerprint=r.controller.fingerprint.value;r.props.block.preservedOnly={url:'/api/assets/77',opaque:[false]};await tick();assert.notEqual(r.controller.fingerprint.value,firstFingerprint);assert.equal(readCalls(r).length,2);wait.resolve(receipt([point(999)]));await tick();assert.deepEqual(r.c.cards.value.map(row=>row.id),[902]);assert.equal(css(m.tree,'points-card')[0].props['data-points-id'],902);assert.equal(r.props.block.preservedOnly.url,'/api/assets/77');noWrites(r);}finally{wait.resolve(receipt([]));finish(r,m);}
}));

test('unknown business preview and decorative fields never become a page lease deadline or authored ticket fingerprint slot',()=>clocked(async()=>{
 const value=block({icon:asset(70,origin-1000),productList:[{image:asset(71,origin-1000)}],imgColorConfig:{url:asset(72,origin-1000)},unknown:{url:asset(73,origin-1000)}}),r=setup({value}),m=mount(r);
 try{await tick();assert.equal(r.controller.ready(),true);assert.equal(r.controller.mediaDeadline.value,Infinity);assert.equal(readCalls(r).length,1);const fingerprint=r.controller.fingerprint.value;r.props.block.unknown.url=asset(73,origin+1200000);await tick();assert.notEqual(r.controller.fingerprint.value,fingerprint,'Only3 known image slots ignore their ephemeral tickets');assert.equal(readCalls(r).length,2);noWrites(r);}finally{finish(r,m);}
}));

for(const platform of['H5','APP-PLUS','MP-WEIXIN'])test(`${platform} actual static points image sources remain bundled with window and URL globals absent`,()=>clocked(async()=>{
 const before={window:global.window,URL:global.URL};global.window=undefined;global.URL=undefined;let r,m;
 try{r=setup({platform,value:block({goodStyleConfig:{tabVal:1}})});m=mount(r);await tick();assert.equal(r.controller.ready(),true);assert.equal(r.c.loaded.value,true);assert.equal(css(m.tree,'points-background-probe')[0].props.src,'/static/images/diy/points-bg.png');assert.equal(css(m.tree,'points-title-image')[0].props.src,'/static/images/diy/points-title.png');assert.equal(css(m.tree,'points-icon')[0].props.src,'/static/images/diy/points-icon.png');assert.equal(css(m.tree,'points-product-image')[0].props.src,'/static/business-901.png');assert.equal(readCalls(r)[0].url,(platform==='H5'?'':'https://cinashop-api.cinagroup.workers.dev')+'/api/store_integral/list');fire(css(m.tree,'points-card')[0]);await tick();assert.deepEqual(r.navigations,['/pages/activity/integralDetail?id=901']);noWrites(r);}finally{if(r)finish(r,m);global.window=before.window;global.URL=before.URL;}
}));

for(const platform of['H5','APP-PLUS','MP-WEIXIN'])test(`${platform} managed points leases use no window or URL constructor and fail old native events after account ABA`,()=>clocked(async()=>{
 const before={window:global.window,URL:global.URL};global.window=undefined;global.URL=undefined;let r,m;
 try{r=setup({platform,value:block({imgBgConfig:{url:asset(7)},imgConfig:{url:asset(8)},imgConfig2:{url:asset(9)}})});m=mount(r);await tick();assert.equal(r.controller.ready(),true);const oldImage=css(m.tree,'points-background-probe')[0].props.onError,oldTap=css(m.tree,'points-card')[0].props.onTap;await crossBoundary('accountABA',r,m);const reads=readCalls(r).length,failures=copy(r.checkout.imageFailures.value);oldImage();oldTap();await tick();assert.deepEqual(r.checkout.imageFailures.value,failures);assert.deepEqual(r.navigations,[]);assert.equal(readCalls(r).length,reads);noWrites(r);}finally{if(r)finish(r,m);global.window=before.window;global.URL=before.URL;}
}));

for(const slot of['imgBgConfig','imgConfig','imgConfig2'])test(`after ${slot} deadline passes a pure ticket renewal reuses already admitted feed without a second GET`,()=>clocked(async advance=>{
 const value=block({[slot]:{url:asset(7)}}),r=setup({value}),m=mount(r);
 try{await tick();const material=r.c.cards.value,fingerprint=r.controller.fingerprint.value,oldTap=css(m.tree,'points-card')[0].props.onTap,oldMore=css(m.tree,'points-more')[0].props.onTap,oldRefresh=css(m.tree,'points-refresh')[0].props.onTap;assert.equal(readCalls(r).length,1);advance(origin+840000);await tick();assert.equal(r.controller.ready(),false);assert.equal(css(m.tree,'points-panel').length,0);assert.strictEqual(r.c.cards.value,material);assert.equal(r.c.loaded.value,true);oldTap();oldMore();oldRefresh();await tick();assert.equal(readCalls(r).length,1);assert.deepEqual(r.navigations,[]);
  r.props.block[slot].url=asset(7,origin+1800000);await tick();assert.equal(r.controller.ready(),true);assert.equal(r.controller.fingerprint.value,fingerprint);assert.strictEqual(r.c.cards.value,material);assert.equal(readCalls(r).length,1);assert.equal(css(m.tree,'points-card').length,1);oldTap();oldMore();oldRefresh();await tick();assert.deepEqual(r.navigations,[]);assert.equal(readCalls(r).length,1);fire(css(m.tree,'points-card')[0]);await tick();assert.deepEqual(r.navigations,['/pages/activity/integralDetail?id=901']);noWrites(r);
 }finally{finish(r,m);}
}));

for(const boundary of['account','accountABA','session','activeABA','hidden','raw','rawABA'])test(`expired lease cannot preserve old admission or start new owner/intent I/O after ${boundary}`,()=>clocked(async advance=>{
 const r=setup({value:block({imgBgConfig:{url:asset(7)},imgConfig:{url:asset(8)},imgConfig2:{url:asset(9)}})}),m=mount(r);
 try{await tick();const old=css(m.tree,'points-refresh')[0].props.onTap;assert.equal(readCalls(r).length,1);advance(origin+840000);await tick();assert.equal(r.controller.ready(),false);await crossBoundary(boundary,r,m);if(boundary==='hidden'){r.props.active=true;await tick();}assert.equal(r.controller.ready(),false);assert.equal(readCalls(r).length,1,'Expired owner/activity/intent must not inherit media admission');assert.equal(r.c.loaded.value,false);assert.deepEqual(r.c.cards.value,[]);old();await r.c.load();await tick();assert.equal(readCalls(r).length,1);assert.deepEqual(r.navigations,[]);
  for(const[slot,id]of[['imgBgConfig',7],['imgConfig',8],['imgConfig2',9]])r.props.block[slot].url=asset(id,origin+1800000);await tick();assert.equal(r.controller.ready(),true);assert.equal(readCalls(r).length,2,'A newly valid lease can admit this fresh owner/intent once');assert.equal(r.c.loaded.value,true);noWrites(r);
 }finally{finish(r,m);}
}));
