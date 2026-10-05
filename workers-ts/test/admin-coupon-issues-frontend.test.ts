import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../view/admin-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
const endpoint = '/marketing/coupon-issues', revision = 'a'.repeat(64), grants = ['coupon.view', 'coupon.manage', 'coupon_record.view'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
let runtime: any, browser: any, apps: any[] = [];
beforeAll(async () => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth:1280, location:{ search:'',pathname:endpoint,href:'' } }));
  vi.stubGlobal('localStorage', { getItem:()=>null, setItem(){}, removeItem(){} });
  const output = await build({ absWorkingDir:root, stdin:{ resolveDir:root, contents:"export {default as Page} from './src/pages/coupon/CouponList.vue'; export * as api from './src/api/couponIssue'; export {default as request} from './src/utils/request'; export {default as Pagination} from 'element-plus/es/components/pagination/index.mjs'; export {createRenderer,createVNode,proxyRefs,nextTick} from 'vue'; export {createPinia} from 'pinia'; export {useAuthStore} from './src/stores/auth'; export * as messages from 'element-plus';" }, alias:{ '@':resolve(root,'src') }, define:{ 'import.meta.env.DEV':'false' }, bundle:true, write:false, platform:'browser', format:'esm', plugins:[{ name:'coupon-issue-runtime', setup(builder) {
    builder.onLoad({ filter:/\.vue$/ },({ path })=>{ const descriptor=parse(readFileSync(path,'utf8'),{ filename:path }).descriptor, script=compileScript(descriptor,{ id:'coupon' }), template=compileTemplate({ source:descriptor.template.content,filename:path,id:'coupon',compilerOptions:{ bindingMetadata:script.bindings } }); if(template.errors.length) throw Error(template.errors.map(String).join('\n')); return { contents:script.content,loader:'ts' }; });
    builder.onResolve({ filter:/^element-plus$/ },()=>({ path:'messages',namespace:'fixture' }));
    builder.onLoad({ filter:/.*/,namespace:'fixture' },()=>({ contents:"export const state={confirm:()=>Promise.resolve(),confirmations:[],successes:[],closed:0}; export const ElMessage={success:value=>state.successes.push(value)}; export const ElMessageBox={confirm(...args){state.confirmations.push(args);return state.confirm(...args)},close(){state.closed++}};" }));
  } }] });
  runtime=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
},120000);
const input = (extra={}) => ({ title:' 独立优惠券 ',discount_type:1,scope_type:0,category:0,category_id:0,brand_id:0,product_ids:[],coupon_price:'12.50',use_min_price:'0.00',valid_days:30,use_start_time:null,use_end_time:null,start_time:null,end_time:null,receive_type:1,is_permanent:1,total_count:0,rule:'使用说明',status:1,sort:0,...extra });
const product = (id=11) => ({ id,store_name:'商品'+id,deleted:false });
const row = (id=1,extra={}) => { const definition=input({title:'独立优惠券',...extra}); return {...definition,id,deleted:false,remain_count:0,receive_limit:1,add_time:1790470800,cid:0,app_type:0,source_template:null,revision,valid:true,issues:[],category_name:'',brand_name:'',products:[],copy_input:input({...definition,status:definition.status===-1?0:definition.status,category:definition.category===1?0:definition.category}),...extra}; };
const options = (extra={}) => ({ categories:[{ id:2,pid:0,cate_name:'食品' },{ id:3,pid:2,cate_name:'水果' }],brands:[{id:4,pid:0,brand_name:'集团'},{id:5,pid:4,brand_name:'品牌'}],max_products:100,max_product_ids_length:500,...extra });
const claim = (key='log:1',extra={}) => ({id:null,row_key:key,uid:9,nickname:'用户',avatar_preview:'',add_time:1790470800,missing_user:false,deleted_user:false,...extra});
const page = (list:any[],count=list.length,next=1) => ({ list,count,page:next,limit:15 });
const claimPage = (id=1,list=[claim()],count=list.length,next=1) => ({...page(list,count,next),issue_id:id,source:'issue_log'});
const envelope = (data:unknown,status=200,msg='受控业务失败')=>({ status,msg,data });
function login(permissions=grants,token='coupon-a',id=12) { localStorage.setItem('admin_token',token);localStorage.setItem('admin_session',JSON.stringify({ userInfo:{ id,account:'operator',level:1 },menus:[],uniqueAuth:permissions })); }
beforeEach(()=>{
  const values=new Map<string,string>(); browser=Object.assign(new EventTarget(),{ innerWidth:1280,location:{ search:'',pathname:endpoint,href:'' } });
  vi.stubGlobal('window',browser);vi.stubGlobal('localStorage',{ getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key) });
  Object.assign(runtime.messages.state,{ confirm:()=>Promise.resolve(),confirmations:[],successes:[],closed:0 });
});
afterEach(()=>{ apps.forEach(app=>app.unmount());apps=[];vi.unstubAllGlobals(); });
const flush=async()=>{ for(let n=0;n<8;n++){await new Promise(done=>setTimeout(done,1));await runtime.nextTick();} };
function deferred(){let resolve!:(value?:unknown)=>void;const promise=new Promise(done=>{resolve=done});return {promise,resolve};}
async function mount(permissions=grants,respond:(config:any)=>unknown=()=>undefined,pager:''|'list'|'products'|'claims'='') {
  login(permissions);const calls:any[]=[];
  runtime.request.defaults.adapter=async(config:any)=>{calls.push(config);const custom=await respond(config),next=config.params?.page??1,id=Number(config.url.match(/\/(\d+)(?:\/status|\/copy|\/claims)?$/u)?.[1]??1);
    const fallback=config.method!=='get'?{id:config.url===endpoint?9:id}:config.url.endsWith('/options')?options():config.url.endsWith('/products')?page([product(next===1?11:12)],16,next):config.url.endsWith('/claims')?claimPage(id,[claim('log:'+next)],16,next):config.url===endpoint?page([row()],1,next):row(id);
    return { config,data:custom??envelope(fallback),status:200,statusText:'fixture',headers:{} };
  };
  let view:any,probe:any,condition:any;
  if(pager){const descriptor=parse(readFileSync(resolve(root,'src/pages/coupon/CouponList.vue'),'utf8')).descriptor,openings=[...descriptor.template.content.matchAll(/<el-pagination([^>]+)>/gu)],opening=openings[pager==='list'?0:pager==='products'?1:2][1];condition=new Function('state','with(state){return ('+opening.match(/v-if="([^"]+)"/)[1]+')}');probe={props:['currentPage','pageSize','total','disabled'],setup(properties:any,context:any){runtime.Pagination.setup(properties,context);return()=>null;}};}
  const renderer=runtime.createRenderer({createElement:()=>({children:[]}),createText:(text:string)=>({text}),createComment:(text:string)=>({text}),insert(node:any,parent:any){node.parent=parent;(parent.children??=[]).push(node)},remove(){},parentNode:(node:any)=>node.parent,nextSibling:()=>null,patchProp(){},setText(){},setElementText(){}});
  const app=renderer.createApp({setup(props:any,context:any){view=runtime.Page.setup(props,context);return()=>{const state=runtime.proxyRefs(view),active=pager&&(pager==='list'||pager==='products'&&state.productsVisible||pager==='claims'&&state.claimsVisible)&&condition(state);return active?runtime.createVNode(probe,{currentPage:pager==='list'?state.page:pager==='products'?state.productPage:state.claimsPage,pageSize:15,total:pager==='list'?state.count:pager==='products'?state.productCount:state.claimsCount,'onUpdate:currentPage':(value:number)=>{view[pager==='list'?'page':pager==='products'?'productPage':'claimsPage'].value=value},onCurrentChange:(value:number)=>void view[pager==='list'?'load':pager==='products'?'loadProducts':'loadClaims'](value)}):null;}}});
  app.use(runtime.createPinia());app.mount({children:[]});apps.push(app);await flush();return {view,calls,close:()=>app.unmount()};
}
const writes=(calls:any[])=>calls.filter(call=>call.method!=='get');
const body=(call:any)=>JSON.parse(call.data);
async function create(view:any,extra={}) { await view.openCreate();Object.assign(view.form.value,input(extra)); }

it('normalizes exact money and Unicode while retaining all four definition scopes',()=>{
  expect(runtime.api.normalizeCouponIssue(input({title:' e\u0301券 ',coupon_price:'12.5'}))).toMatchObject({title:'é券',coupon_price:'12.50',use_min_price:'0.00'});
  for(const extra of [{scope_type:1,category_id:2},{scope_type:2,product_ids:[12,11]},{scope_type:3,brand_id:4}])expect(runtime.api.normalizeCouponIssue(input(extra))).toMatchObject(extra.scope_type===2?{product_ids:[11,12]}:extra);
  for(const extra of [{title:'字'.repeat(65)},{title:'坏\n名'},{coupon_price:'0'},{coupon_price:'01'},{coupon_price:'1e2'},{coupon_price:'1.001'},{coupon_price:'10000000000'},{use_min_price:'-1'},{category:1},{scope_type:1},{scope_type:0,brand_id:4},{scope_type:3,brand_id:4,category_id:2},{scope_type:2,product_ids:[11,11]},{scope_type:2,product_ids:Array.from({length:101},(_,n)=>n+1)},{scope_type:2,product_ids:Array.from({length:51},(_,n)=>2147483600-n)},{sort:-1},{rule:'\u0000'},{rule:'字'.repeat(4097)}])expect(()=>runtime.api.normalizeCouponIssue(input(extra))).toThrow();
});
it('validates percentage and category/receive/capacity rules without financial floating point',()=>{
  expect(runtime.api.normalizeCouponIssue(input({discount_type:2,coupon_price:'85.99'})).coupon_price).toBe('85.99');
  for(const extra of [{discount_type:2,coupon_price:'100.01'},{category:2,receive_type:3},{is_permanent:0,total_count:0},{is_permanent:1,total_count:2},{receive_type:2,is_permanent:0,total_count:1},{valid_days:0}])expect(()=>runtime.api.normalizeCouponIssue(input(extra))).toThrow();
  expect(runtime.api.normalizeCouponIssue(input({category:2,receive_type:4})).category).toBe(2);
});
it('preserves Shanghai milliseconds and validates paired receipt/fixed-use windows',()=>{
  const utc=runtime.api.couponIssueUtc('2099-10-01T12:34:56.123');expect(utc).toBe('2099-10-01T04:34:56.123Z');expect(runtime.api.couponIssueLocal(utc)).toBe('2099-10-01T12:34:56.123');
  expect(()=>runtime.api.couponIssueUtc('2099-02-30T12:00')).toThrow();
  const windows={start_time:'2099-01-01T00:00:00Z',end_time:'2099-01-02T00:00:00Z',use_start_time:'2099-01-01T01:00:00Z',use_end_time:'2099-01-03T00:00:00Z',valid_days:0};expect(runtime.api.normalizeCouponIssue(input(windows))).toMatchObject(windows);
  for(const extra of [{end_time:null},{use_end_time:null},{use_start_time:'2098-12-31T00:00:00Z'},{use_end_time:'2099-01-01T23:00:00Z'},{valid_days:3}])expect(()=>runtime.api.normalizeCouponIssue(input({...windows,...extra}))).toThrow();
});
it('validates complete ancestor trees, malformed definitions, scope completeness and source proof',()=>{
  expect(runtime.api.couponIssueTree(options().brands.map(item=>({...item,name:item.brand_name})))[0].children[0].value).toBe(5);
  for(const tree of [[{id:1,pid:1,name:'cycle'}],[{id:1,pid:2,name:'orphan'}],[{id:1,pid:0,name:'a'},{id:1,pid:0,name:'b'}]])expect(()=>runtime.api.couponIssueTree(tree)).toThrow();
  const bad=row(1,{discount_type:-2,receive_type:-2,category:7,is_permanent:9,receive_limit:-32768,coupon_price:'坏值',valid:false,copy_input:null,issues:['旧值无效']});expect(runtime.api.parseCouponIssue(bad)).toEqual(bad);
  for(const extra of [{add_time:'2026-01-01'},{source_template:{template_id:1,source_revision:'bad'}},{product_ids:[11],products:[]},{product_ids:[11],products:[product(12)]},{revision:'bad'}])expect(()=>runtime.api.parseCouponIssue(row(1,extra))).toThrow();
});
it.each([[],['coupon.manage'],['coupon_record.view']].map(permissions=>({permissions})))('denies all operations without coupon.view ($permissions)',async({permissions})=>{
  const {view,calls}=await mount(permissions);await view.openCreate();await view.openClaims(row());await view.save();expect(calls).toHaveLength(0);expect(view.canView.value).toBe(false);
});
it('permits readonly detail but independently guards claims and every write entry',async()=>{
  const {view,calls}=await mount(['coupon.view']);await view.openDetail(view.list.value[0]);expect(view.detail.value.id).toBe(1);await view.openClaims(view.detail.value);await view.openCopy(view.detail.value);await view.openCreate();await view.confirmAction(view.list.value[0],'delete');await view.save();expect(view.canClaims.value).toBe(false);expect(calls.some(c=>c.url.endsWith('/claims'))).toBe(false);expect(writes(calls)).toHaveLength(0);
});
it('does not grant claim identities to coupon.manage without coupon_record.view',async()=>{
  const {view,calls}=await mount(['coupon.view','coupon.manage']);await view.openClaims(view.list.value[0]);expect(view.canManage.value).toBe(true);expect(calls.some(c=>c.url.endsWith('/claims'))).toBe(false);
});
it('uses default all status, independent filters and the last applied query for refresh',async()=>{
  const {view,calls}=await mount();expect(calls[0].params).toEqual({page:1,limit:15,keyword:'',status:'',discount_type:'',receive_type:''});view.draftKeyword.value=' 券_% ';view.draftStatus.value=0;view.draftDiscount.value=2;view.draftReceive.value=4;view.search();await flush();expect(calls.at(-1).params).toMatchObject({keyword:'券_%',status:0,discount_type:2,receive_type:4});view.draftKeyword.value='未查询';await view.load();expect(calls.at(-1).params.keyword).toBe('券_%');view.reset();await flush();expect(calls.at(-1).params.status).toBe('');
});
it('keeps failed list separate from normal empty results and supports retry',async()=>{
  let fail=true;const {view}=await mount(grants,c=>c.url===endpoint&&fail?envelope(null,500,'列表失败'):undefined);expect(view.ready.value).toBe(false);expect(view.listError.value).toBe('列表失败');fail=false;await view.load();expect(view.ready.value).toBe(true);expect(view.list.value).toHaveLength(1);
});
it('blocks malformed list responses without committing partial rows',async()=>{
  const {view}=await mount(grants,c=>c.url===endpoint?envelope({...page([row()]),page:2}):undefined);expect(view.list.value).toEqual([]);expect(view.listError.value).toContain('分页');expect(view.ready.value).toBe(false);
});
it('retains new drafts across failed options retry and saves only complete canonical definitions',async()=>{
  let fail=true;const {view,calls}=await mount(grants,c=>c.url.endsWith('/options')&&fail?envelope(null,500,'范围失败'):undefined);await create(view,{scope_type:3,brand_id:4});await view.save();expect(writes(calls)).toHaveLength(0);expect(view.form.value.title).toBe(' 独立优惠券 ');fail=false;await view.loadOptions();await view.save();expect(body(writes(calls)[0])).toEqual({...runtime.api.normalizeCouponIssue(input({scope_type:3,brand_id:4})),request_id:expect.stringMatching(uuid),source_id:0,source_revision:null});expect(view.editorVisible.value).toBe(false);
});
it('supports ancestor category selection and refuses unavailable brand/category',async()=>{
  const {view,calls}=await mount();await create(view,{scope_type:1,category_id:999});await view.save();expect(view.editorError.value).toContain('品类');view.form.value.category_id=2;await view.save();expect(body(writes(calls)[0]).category_id).toBe(2);await create(view,{scope_type:3,brand_id:999});await view.save();expect(view.editorError.value).toContain('品牌');expect(writes(calls)).toHaveLength(1);
});
it('retains complete copy definition, normalizes legacy ordinary category and sends source version only',async()=>{
  const original=row(7,{category:1,status:-1,cid:91,source_template:{template_id:91,source_revision:'b'.repeat(64)},remain_count:4});const {view,calls}=await mount(grants,c=>c.url===endpoint?envelope(page([original])):c.url.endsWith('/copy')?envelope(original):undefined);await view.openCopy(view.list.value[0]);expect(view.form.value.category).toBe(0);expect(view.form.value.status).toBe(0);view.form.value.title='新的独立券';await view.save();const payload=body(writes(calls)[0]);expect(payload).toMatchObject({source_id:7,source_revision:revision,title:'新的独立券',category:0,status:0});for(const key of ['cid','source_template','remain_count','receive_limit','id','app_type'])expect(payload).not.toHaveProperty(key);expect(writes(calls)[0].url).toBe(endpoint);expect(writes(calls)[0].method).toBe('post');
});
it('preserves member category and historical source receive types without offering them on blank creation',async()=>{
  const original=row(1,{category:2,receive_type:4});const {view,calls}=await mount(grants,c=>c.url.endsWith('/copy')?envelope(original):undefined);await create(view);expect(view.receiveOptions.value.map((v:any)=>v.value)).toEqual([1,3]);await view.openCopy(view.list.value[0]);expect(view.receiveOptions.value.map((v:any)=>v.value)).toEqual([1,4]);await view.save();expect(body(writes(calls)[0])).toMatchObject({category:2,receive_type:4});await create(view,{receive_type:2});await view.save();expect(writes(calls)).toHaveLength(1);expect(view.editorError.value).toContain('历史用途');
});
it('forces historical newcomer copies to unlimited and resets hidden scope choices atomically',async()=>{
  const original=row(1,{receive_type:2});const {view,calls}=await mount(grants,c=>c.url.endsWith('/copy')?envelope(original):undefined);await view.openCopy(view.list.value[0]);view.form.value.is_permanent=0;view.form.value.total_count=19;view.changeReceive();expect(view.form.value.total_count).toBe(0);await view.save();expect(body(writes(calls)[0])).toMatchObject({receive_type:2,is_permanent:1,total_count:0});await create(view,{scope_type:1,category_id:3});view.form.value.scope_type=3;view.changeScope();expect(view.form.value.category_id).toBe(0);expect(view.form.value.product_ids).toEqual([]);
});
it('retains historical fractional discount only unchanged with explicit integer settlement display',async()=>{
  const original=row(1,{discount_type:2,coupon_price:'85.99'});const {view,calls}=await mount(grants,c=>c.url.endsWith('/copy')?envelope(original):undefined);await view.openCopy(view.list.value[0]);expect(view.fractionalCopy.value).toBe(true);expect(view.faceLabel(original)).toContain('8.5 折');view.form.value.coupon_price='86.99';await view.save();expect(writes(calls)).toHaveLength(0);view.form.value.coupon_price='85.99';await view.save();expect(body(writes(calls)[0]).coupon_price).toBe('85.99');await create(view,{discount_type:2,coupon_price:'85.99'});await view.save();expect(writes(calls)).toHaveLength(1);
});
it('preserves unsupported-audience diagnostics and requires explicit blank new creation',async()=>{
  const original=row(1,{app_type:1,valid:true,copy_input:null,issues:['受众未由表单支持']});const {view,calls}=await mount(grants,c=>c.url.endsWith('/copy')?envelope(original):undefined);await view.openCopy(view.list.value[0]);await view.save();expect(view.detail.value.issues).toContain('受众未由表单支持');expect(writes(calls)).toHaveLength(0);await view.openCreate();expect(view.form.value.title).toBe('');expect(view.detail.value).toBeNull();expect(view.form.value.category).toBe(0);
});
it('sends exact fixed-use and receive windows in UTC and clears inactive day/quantity fields',async()=>{
  const {view,calls}=await mount();await create(view,{is_permanent:0,total_count:17});view.useDays.value=false;view.hasReceiveWindow.value=true;view.useStart.value='2099-10-01T12:00:00.123';view.useEnd.value='2099-10-05T12:00';view.receiveStart.value='2099-10-01T11:00';view.receiveEnd.value='2099-10-04T12:00';await view.save();expect(body(writes(calls)[0])).toMatchObject({valid_days:0,total_count:17,use_start_time:'2099-10-01T04:00:00.123Z',use_end_time:'2099-10-05T04:00:00.000Z',start_time:'2099-10-01T03:00:00.000Z',end_time:'2099-10-04T04:00:00.000Z'});
});
it('rejects incomplete, already expired fixed windows and zero explicit thresholds before sending',async()=>{
  const {view,calls}=await mount();await create(view);view.useDays.value=false;view.useStart.value='2000-01-01T12:00';await view.save();expect(writes(calls)).toHaveLength(0);view.useEnd.value='2000-01-02T12:00';await view.save();expect(view.editorError.value).toContain('过期');view.useDays.value=true;view.hasMinimum.value=true;await view.save();expect(view.editorError.value).toContain('门槛');expect(writes(calls)).toHaveLength(0);
});
it('selects products across pages and cancels without changing the committed draft',async()=>{
  const {view,calls}=await mount();await create(view,{scope_type:2});await view.openProducts();view.selectPage(true);await view.loadProducts(2);view.selectPage(true);expect([...view.choices.value.keys()]).toEqual([11,12]);view.applyProducts();expect(view.form.value.product_ids).toEqual([11,12]);await view.openProducts();view.unchoose(11);view.closeProducts();expect(view.form.value.product_ids).toEqual([11,12]);await view.save();expect(body(writes(calls)[0]).product_ids).toEqual([11,12]);
});
it('keeps selection during product-page errors and rejects overflow without truncation',async()=>{
  let fail=true;const {view}=await mount(grants,c=>c.url.endsWith('/products')&&c.params.page===2&&fail?envelope(null,500,'商品页失败'):undefined);await create(view,{scope_type:2});await view.openProducts();view.selectPage(true);await view.loadProducts(2);view.applyProducts();expect(view.form.value.product_ids).toEqual([]);expect(view.choices.value.size).toBe(1);fail=false;await view.loadProducts(2);view.selectPage(true);const ids=Array.from({length:101},(_,n)=>n+1);view.choices.value=new Map(ids.map(id=>[id,product(id)]));view.applyProducts();expect(view.productError.value).toContain('完整选择仍保留');expect(view.choices.value.size).toBe(101);view.unchoose(1);view.applyProducts();expect(view.form.value.product_ids).toHaveLength(100);
});
it('discards closed picker responses and ignores stale selection rows',async()=>{
  const gate=deferred();const {view}=await mount(grants,c=>c.url.endsWith('/products')&&c.params.page===2?gate.promise:undefined);await create(view,{scope_type:2});await view.openProducts();const old=view.products.value[0],pending=view.loadProducts(2);view.choose(old,true);expect(view.choices.value.size).toBe(0);view.closeProducts();gate.resolve(envelope(page([product(12)],16,2)));await pending;expect(view.products.value).toEqual([]);expect(view.form.value.product_ids).toEqual([]);
});
it.each([-1,0,1])('confirms status %s transitions without changing authoritative rows before success',async status=>{
  const original=row(1,{status});const gate=deferred();const {view,calls}=await mount(grants,c=>c.url===endpoint?envelope(page([original])):c.method==='post'?gate.promise:undefined);const pending=view.confirmAction(view.list.value[0],'status');await flush();expect(view.list.value[0].status).toBe(status);expect(body(writes(calls)[0])).toEqual({revision,request_id:expect.stringMatching(uuid),status:status===1?0:1});if(status===-1)expect(runtime.messages.state.confirmations[0][0]).toContain('仅恢复本次独立发行，不恢复源模板');gate.resolve(envelope({id:1}));await pending;
});
it('supports -1 to disabled and soft delete with original revision and surviving history confirmation',async()=>{
  const original=row(1,{status:-1});const {view,calls}=await mount(grants,c=>c.url===endpoint?envelope(page([original])):undefined);await view.confirmAction(view.list.value[0],'status',0);await view.confirmAction(view.list.value[0],'delete');expect(body(writes(calls)[0]).status).toBe(0);expect(writes(calls)[1].method).toBe('delete');expect(body(writes(calls)[1])).toMatchObject({revision,request_id:expect.stringMatching(uuid)});expect(runtime.messages.state.confirmations[1][0]).toContain('赠券配置');expect(runtime.messages.state.confirmations[1][0]).not.toContain('清除');
});
it('blocks deleted records, cancelled confirmations and refreshed stale confirmation versions',async()=>{
  const {view,calls}=await mount();const gate=deferred();runtime.messages.state.confirm=()=>gate.promise;const pending=view.confirmAction(view.list.value[0],'delete');await flush();await view.load();gate.resolve();await pending;expect(writes(calls)).toHaveLength(0);runtime.messages.state.confirm=()=>Promise.reject(Error('cancel'));await view.confirmAction(view.list.value[0],'delete');expect(writes(calls)).toHaveLength(0);view.list.value[0].deleted=true;await view.openCopy(view.list.value[0]);await view.confirmAction(view.list.value[0],'status');expect(view.editorVisible.value).toBe(false);
});
it('returns to previous page after deleting the last row',async()=>{
  let deleted=false;const {view,calls}=await mount(grants,c=>{if(c.method==='delete'){deleted=true;return envelope({id:2})}if(c.url===endpoint&&c.params.page===2)return envelope(page(deleted?[]:[row(2)],deleted?15:16,2));return undefined});await view.load(2);await view.confirmAction(view.list.value[0],'delete');expect(view.page.value).toBe(1);expect(writes(calls)).toHaveLength(1);
});
it('loads claims by exact issuer while retaining duplicate logs and nullable identity',async()=>{
  const logs=[claim('log:1'),claim('log:2'),claim('log:3',{uid:null,nickname:'',missing_user:true})];const {view,calls}=await mount(['coupon.view','coupon_record.view'],c=>c.url.endsWith('/claims')?envelope(claimPage(1,logs)):undefined);await view.openClaims(view.list.value[0]);expect(view.claims.value).toEqual(logs);expect(view.claims.value[2].uid).toBeNull();expect(calls.at(-1).url).toBe(endpoint+'/1/claims');expect(calls.at(-1).params).toEqual({page:1,limit:15});expect(view.canManage.value).toBe(false);
});
it('rejects cross-issuer or malformed claim results and retries without exposing partial identities',async()=>{
  let bad=true;const {view}=await mount(grants,c=>c.url.endsWith('/claims')?envelope(claimPage(bad?2:1)):undefined);await view.openClaims(view.list.value[0]);expect(view.claims.value).toEqual([]);expect(view.claimsError.value).toContain('归属');bad=false;await view.loadClaims();expect(view.claims.value).toHaveLength(1);
});
it('preserves member-owned claim source and discards closed or switched issuer responses',async()=>{
  const gate=deferred();const {view}=await mount(grants,c=>c.url===endpoint?envelope(page([row(1),row(2,{category:2})])):c.url.endsWith('/1/claims')?gate.promise:c.url.endsWith('/2/claims')?envelope({...claimPage(2),source:'owned'}):undefined);const pending=view.openClaims(view.list.value[0]);await flush();await view.openClaims(view.list.value[1]);gate.resolve(envelope(claimPage(1)));await pending;expect(view.claimsId.value).toBe(2);expect(view.claimsSource.value).toBe('owned');view.closeClaims();expect(view.claims.value).toEqual([]);
});
it.each(['list','products','claims'])('uses real Element Plus %s pagination without loading page clamps',async pager=>{
  const gate=deferred();let hold=true;const route=pager==='list'?endpoint:pager==='products'?endpoint+'/products':endpoint+'/1/claims';const fixture=(next:number)=>pager==='claims'?claimPage(1,[claim('log:'+next)],16,next):page(pager==='list'?[row(next)]:[product(next===1?11:12)],16,next);
  const {view,calls}=await mount(grants,c=>c.url===route?c.params.page===2&&hold?gate.promise:envelope(fixture(c.params.page)):undefined,pager as any);if(pager==='products'){await create(view,{scope_type:2});await view.openProducts()}if(pager==='claims')await view.openClaims(view.list.value[0]);const load=view[pager==='list'?'load':pager==='products'?'loadProducts':'loadClaims'],state=view[pager==='list'?'page':pager==='products'?'productPage':'claimsPage'];const pending=load(2);await flush();expect(state.value).toBe(2);expect(calls.filter(c=>c.url===route).map(c=>c.params.page)).toEqual([1,2]);hold=false;gate.resolve(envelope(fixture(2)));await pending;await flush();expect(state.value).toBe(2);
});
it.each(['network','malformed'])('retains unknown %s create UUID, body, named scope and draft with GET-only recovery',async failure=>{
  const {view,calls}=await mount(grants,c=>{if(c.method==='post'){if(failure==='network')throw Error('响应丢失');return envelope({id:0})}return undefined});await create(view,{scope_type:2,product_ids:[11]});view.selectedProducts.value=[product()];await view.save();const pending=view.uncertainOperation.value;expect(pending.body.request_id).toMatch(uuid);expect(pending.context.products).toEqual([{id:11,store_name:'商品11'}]);expect(pending.body.source_id).toBe(0);await view.reconcile();await view.save();await view.confirmAction(view.list.value[0],'delete');expect(writes(calls)).toHaveLength(1);expect(view.uncertainOperation.value.body.request_id).toBe(pending.body.request_id);expect(view.form.value.product_ids).toEqual([11]);expect(view.editorVisible.value).toBe(true);
});
it('unknown status/delete only rereads their exact issue and manual acknowledgement proves no server result',async()=>{
  const {view,calls}=await mount(grants,c=>c.method==='delete'?envelope({id:999}):undefined);await view.confirmAction(view.list.value[0],'delete');expect(view.uncertainOperation.value.kind).toBe('delete');expect(calls.at(-1).url).toBe(endpoint+'/1');await view.acknowledge();expect(view.uncertainOperation.value).toBeNull();expect(writes(calls)).toHaveLength(1);expect(runtime.messages.state.confirmations.at(-1)[0]).toContain('不证明服务器成功或失败');expect(runtime.messages.state.confirmations.at(-1)[0]).toContain('可能产生重复发行');
});
it('confirmed business rejection rereads without replacing copy draft or its original source version',async()=>{
  const {view,calls}=await mount(grants,c=>c.method==='post'?envelope(null,400,'来源版本已变化'):c.url===endpoint+'/1'?envelope(row(1,{revision:'b'.repeat(64)})):undefined);await view.openCopy(view.list.value[0]);view.form.value.title='保留草稿';await view.save();expect(view.uncertainOperation.value).toBeNull();expect(view.form.value.title).toBe('保留草稿');expect(view.detail.value.revision).toBe(revision);expect(view.editorError.value).toContain('来源版本已变化');expect(writes(calls)).toHaveLength(1);
});
it('rejects detail A→B→A continuations and clears permission-sensitive claims on storage change',async()=>{
  const gate=deferred();const {view}=await mount(grants,c=>c.url.endsWith('/copy')?gate.promise:undefined);await view.openClaims(view.list.value[0]);const pending=view.openCopy(view.list.value[0]);await flush();login(['coupon.view'],'coupon-b',13);browser.dispatchEvent(Object.assign(new Event('storage'),{key:'admin_session'}));await flush();expect(view.claims.value).toEqual([]);expect(view.canClaims.value).toBe(false);login(grants,'coupon-a',12);browser.dispatchEvent(new Event('admin-session-changed'));await flush();gate.resolve(envelope(row()));await pending;expect(view.detail.value).toBeNull();expect(view.editorVisible.value).toBe(false);
});
it('guards delayed confirmation from actor replacement and closes the old confirmation',async()=>{
  const {view,calls}=await mount();const gate=deferred();runtime.messages.state.confirm=()=>gate.promise;const pending=view.confirmAction(view.list.value[0],'status');await flush();login(['coupon.view'],'reader-b',9);browser.dispatchEvent(new Event('admin-session-changed'));await flush();gate.resolve();await pending;expect(writes(calls)).toHaveLength(0);expect(runtime.messages.state.closed).toBe(1);
});
it('isolates already-started writes and old auth failures from replacement account',async()=>{
  const gate=deferred();const {view}=await mount(grants,c=>c.method==='post'?gate.promise:undefined);await create(view);const pending=view.save();await flush();login(['coupon.view'],'reader-b',9);browser.dispatchEvent(new Event('admin-session-changed'));await flush();gate.resolve(envelope(null,410000,'旧请求过期'));await pending;expect(localStorage.getItem('admin_token')).toBe('reader-b');expect(view.uncertainOperation.value).toBeNull();expect(runtime.messages.state.successes).toEqual([]);expect(view.canManage.value).toBe(false);
});
it('ignores closed-editor options, unmounted read completions and malformed outgoing versions',async()=>{
  const gate=deferred();const {view,calls,close}=await mount(grants,c=>c.url.endsWith('/options')?gate.promise:undefined);const pending=view.openCreate();view.closeEditor();gate.resolve(envelope(options()));await pending;expect(view.options.value).toBeNull();await expect(runtime.api.apiCouponIssueCreate({...input(),source_id:0,source_revision:null,request_id:'bad'})).rejects.toThrow('请求ID');await expect(runtime.api.apiCouponIssueStatus(1,{status:1,revision:'bad',request_id:crypto.randomUUID()})).rejects.toThrow('版本');expect(writes(calls)).toHaveLength(0);close();await view.load();expect(view.list.value).toEqual([]);
});
it('displays expanded historical years and negative claim UIDs without relaxing new input dates',async()=>{
  const expanded='+010000-01-01T00:00:00.000Z',original=row(1,{valid:false,valid_days:0,use_start_time:expanded,use_end_time:'+010001-01-01T00:00:00.000Z',copy_input:null,issues:['历史年份不能复制']});
  const {view}=await mount(grants,c=>c.url===endpoint?envelope(page([original])):c.url.endsWith('/claims')?envelope(claimPage(1,[claim('orphan',{uid:-1,missing_user:true})])):undefined);
  expect(view.listError.value).toBe('');expect(view.timeLabel(expanded)).toContain('10000');expect(view.timeLabel(expanded)).toContain('历史年份');await view.openClaims(view.list.value[0]);expect(view.claimsError.value).toBe('');expect(view.claims.value[0].uid).toBe(-1);expect(()=>runtime.api.normalizeCouponIssue(input({valid_days:0,use_start_time:expanded,use_end_time:'+010001-01-01T00:00:00.000Z'}))).toThrow();
});
it('clears authoritative rows and reports a page offset beyond the supported boundary',async()=>{
  const {view,calls}=await mount();await view.load(668);expect(view.page.value).toBe(668);expect(view.list.value).toEqual([]);expect(view.listError.value).toContain('分页');expect(view.ready.value).toBe(false);expect(calls).toHaveLength(1);await view.load(1);expect(view.list.value).toHaveLength(1);
});
it('keeps writes mutually exclusive while a rejected write is reconciling',async()=>{
  const gate=deferred();let reads=0;const {view,calls}=await mount(grants,c=>c.method==='post'?envelope(null,400,'已拒绝'):c.url===endpoint&&++reads===2?gate.promise:undefined);await create(view);const pending=view.save();await flush();expect(view.recovering.value).toBe(true);await view.save();await view.openCreate();expect(writes(calls)).toHaveLength(1);gate.resolve(envelope(page([row()])));await pending;expect(view.recovering.value).toBe(false);expect(view.form.value.title).toBe(' 独立优惠券 ');
});

