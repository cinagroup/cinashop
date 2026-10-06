import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../view/admin-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
const endpoint = '/marketing/coupon-templates', revision = 'a'.repeat(64), grants = ['coupon_template.view', 'coupon_template.manage', 'coupon_template_issue.manage'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
let runtime: any, browser: any, apps: any[] = [];
beforeAll(async () => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth:1280, location:{ search:'',pathname:endpoint,href:'' } }));
  vi.stubGlobal('localStorage', { getItem:()=>null, setItem(){}, removeItem(){} });
  const output = await build({ absWorkingDir:root, stdin:{ resolveDir:root, contents:"export {default as Page} from './src/pages/marketing/CouponTemplates.vue'; export * as api from './src/api/couponTemplate'; export {default as request} from './src/utils/request'; export {default as Pagination} from 'element-plus/es/components/pagination/index.mjs'; export {createRenderer,createVNode,proxyRefs,nextTick} from 'vue'; export {createPinia} from 'pinia'; export {useAuthStore} from './src/stores/auth'; export * as messages from 'element-plus';" }, alias:{ '@':resolve(root,'src') }, define:{ 'import.meta.env.DEV':'false' }, bundle:true, write:false, platform:'browser', format:'esm', plugins:[{ name:'coupon-template-runtime', setup(builder) {
    builder.onLoad({ filter:/\.vue$/ },({ path })=>{ const descriptor=parse(readFileSync(path,'utf8'),{ filename:path }).descriptor, script=compileScript(descriptor,{ id:'coupon' }), template=compileTemplate({ source:descriptor.template.content,filename:path,id:'coupon',compilerOptions:{ bindingMetadata:script.bindings } }); if(template.errors.length) throw Error(template.errors.map(String).join('\n')); return { contents:script.content,loader:'ts' }; });
    builder.onResolve({ filter:/^element-plus$/ },()=>({ path:'messages',namespace:'fixture' }));
    builder.onLoad({ filter:/.*/,namespace:'fixture' },()=>({ contents:"export const state={confirm:()=>Promise.resolve(),confirmations:[],successes:[],closed:0}; export const ElMessage={success:value=>state.successes.push(value)}; export const ElMessageBox={confirm(...args){state.confirmations.push(args);return state.confirm(...args)},close(){state.closed++}};" }));
  } }] });
  runtime=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
},120000);
const input = (extra={}) => ({ title:' 优惠券模板 ',scope_type:0,category_id:0,product_ids:[],coupon_price:'12.5',use_min_price:'0',valid_days:30,sort:5,status:1,...extra });
const product = (id=11) => ({ id,store_name:'商品'+id,deleted:false });
const row = (id=1,extra={}) => ({ ...input({ title:'优惠券模板',coupon_price:'12.50',use_min_price:'0.00' }),id,deleted:false,add_time:1790470800,revision,valid:true,issues:[],category_name:'',products:[],issue_count:1,...extra });
const options = (extra={}) => ({ categories:[{ id:2,pid:0,cate_name:'食品' },{ id:3,pid:2,cate_name:'水果' }],max_products:100,max_product_ids_length:500,...extra });
const issue = (id=7,extra={}) => ({ issue_id:id,template_id:1,title:'旧发行快照',receive_type:1,status:1,total_count:100,remain_count:70,is_permanent:0,start_time:null,end_time:null,issued_at:1790470800,source_revision:revision,...extra });
const page = (list:any[],count=list.length,next=1) => ({ list,count,page:next,limit:15 });
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
async function mount(permissions=grants,respond:(config:any)=>unknown=()=>undefined,pager:''|'list'|'products'|'history'='') {
  login(permissions);const calls:any[]=[];
  runtime.request.defaults.adapter=async(config:any)=>{calls.push(config);const custom=await respond(config),next=config.params?.page??1,id=Number(config.url.match(/\/(\d+)(?:\/invalidate|\/issues)?$/u)?.[1]??1);
    const fallback=config.method!=='get'?config.url==='/marketing/coupon-template-issues'?{ issue_id:9,template_id:JSON.parse(config.data).template_id }:{id:config.url===endpoint?9:id}:config.url.endsWith('/options')?options():config.url.endsWith('/products')?page([product(next===1?11:12)],16,next):config.url.endsWith('/issues')?page([issue(next===1?7:8,{template_id:id})],16,next):config.url===endpoint?page([row()],1,next):row(id);
    return { config,data:custom??envelope(fallback),status:200,statusText:'fixture',headers:{} };
  };
  let view:any,probe:any,condition:any;
  if(pager){const descriptor=parse(readFileSync(resolve(root,'src/pages/marketing/CouponTemplates.vue'),'utf8')).descriptor,openings=[...descriptor.template.content.matchAll(/<el-pagination([^>]+)>/gu)],opening=openings[pager==='list'?0:pager==='history'?1:2][1];condition=new Function('state','with(state){return ('+opening.match(/v-if="([^"]+)"/)[1]+')}');probe={props:['currentPage','pageSize','total','disabled'],setup(properties:any,context:any){runtime.Pagination.setup(properties,context);return()=>null;}};}
  const renderer=runtime.createRenderer({createElement:()=>({children:[]}),createText:(text:string)=>({text}),createComment:(text:string)=>({text}),insert(node:any,parent:any){node.parent=parent;(parent.children??=[]).push(node)},remove(){},parentNode:(node:any)=>node.parent,nextSibling:()=>null,patchProp(){},setText(){},setElementText(){}});
  const app=renderer.createApp({setup(props:any,context:any){view=runtime.Page.setup(props,context);return()=>{const state=runtime.proxyRefs(view),active=pager&&(pager==='list'||pager==='products'&&state.productsVisible||pager==='history'&&state.editorVisible&&state.mode==='view')&&condition(state);return active?runtime.createVNode(probe,{currentPage:pager==='list'?state.page:pager==='products'?state.productPage:state.historyPage,pageSize:15,total:pager==='list'?state.count:pager==='products'?state.productCount:state.historyCount,'onUpdate:currentPage':(value:number)=>{view[pager==='list'?'page':pager==='products'?'productPage':'historyPage'].value=value},onCurrentChange:(value:number)=>void view[pager==='list'?'load':pager==='products'?'loadProducts':'loadHistory'](value)}):null;}}});
  app.use(runtime.createPinia());app.mount({children:[]});apps.push(app);await flush();return {view,calls,close:()=>app.unmount()};
}
const writes=(calls:any[])=>calls.filter(call=>call.method!=='get');
const body=(call:any)=>JSON.parse(call.data);
async function create(view:any,extra={}) { await view.openCreate();Object.assign(view.form.value,input(extra)); }

it('normalizes Unicode title and exact decimal inputs, stripping inactive scope branches',()=>{
  expect(runtime.api.normalizeCouponTemplate(input({title:' e\u0301券 ',category_id:3,product_ids:[11]}))).toMatchObject({title:'é券',coupon_price:'12.50',use_min_price:'0.00',category_id:0,product_ids:[]});
  expect(runtime.api.normalizeCouponTemplate(input({title:'字'.repeat(64),coupon_price:'9999999999.99',valid_days:3650})).title).toHaveLength(64);
  for(const extra of [{title:'字'.repeat(65)},{title:'坏\n名'},{coupon_price:'0'},{coupon_price:'01'},{coupon_price:'1e2'},{coupon_price:'1.001'},{coupon_price:'10000000000'},{use_min_price:'-1'},{valid_days:0},{valid_days:3651},{sort:-1},{scope_type:1,category_id:0},{scope_type:2,product_ids:[]}]) expect(()=>runtime.api.normalizeCouponTemplate(input(extra))).toThrow();
});
it('rejects duplicate, int32 overflow, product count and CSV length overflow without truncation',()=>{
  for(const ids of [[11,11],[2147483648],Array.from({length:101},(_,n)=>n+1),Array.from({length:51},(_,n)=>2147483600-n)]) expect(()=>runtime.api.normalizeCouponTemplate(input({scope_type:2,product_ids:ids}))).toThrow();
  expect(runtime.api.normalizeCouponTemplate(input({scope_type:2,product_ids:[11,12],category_id:3})).product_ids).toEqual([11,12]);
});
it('checks complete scope details while preserving readonly invalid historical amounts and deleted products',()=>{
  const damaged=row(1,{valid:false,coupon_price:'坏金额',product_ids:[11],scope_type:2,products:[{...product(),deleted:true}],issues:['来源商品已删除']});expect(runtime.api.parseCouponTemplate(damaged).products[0].deleted).toBe(true);
  for(const products of [[],[product(),product()],[product(12)]]) expect(()=>runtime.api.parseCouponTemplate({...damaged,products})).toThrow();
});
it('validates complete category trees including cycles, missing parents, duplicates and capacity',()=>{
  expect(runtime.api.couponCategoryTree(options().categories)[0].children[0].value).toBe(3);
  for(const categories of [[{id:2,pid:2,cate_name:'自环'}],[{id:2,pid:8,cate_name:'孤儿'}],[{id:2,pid:3,cate_name:'甲'},{id:3,pid:2,cate_name:'乙'}],[options().categories[0],options().categories[0]],Array.from({length:5001},(_,n)=>({id:n+1,pid:0,cate_name:'类'}))]) expect(()=>runtime.api.couponCategoryTree(categories)).toThrow();
});
it('validates Shanghai publication windows, unlimited count and gift-only exact amounts',()=>{
  expect(runtime.api.couponTemplateUtc('2099-10-01T12:00')).toBe('2099-10-01T04:00:00.000Z');expect(()=>runtime.api.couponTemplateUtc('2099-02-30T12:00')).toThrow();
  const value={template_id:1,revision,receive_type:1,status:1,is_permanent:0,count:5,start_time:null,end_time:null,full_reduction:'0'};
  expect(runtime.api.normalizeCouponTemplatePublish(value).full_reduction).toBe('0.00');
  for(const extra of [{count:0},{is_permanent:1,count:5},{start_time:'2099-01-01T00:00:00Z'},{start_time:'2099-01-02T00:00:00Z',end_time:'2099-01-01T00:00:00Z'},{start_time:'2000-01-01T00:00:00Z',end_time:'2000-01-02T00:00:00Z'},{full_reduction:'5'},{receive_type:4},{revision:'bad'}]) expect(()=>runtime.api.normalizeCouponTemplatePublish({...value,...extra})).toThrow();
  expect(runtime.api.normalizeCouponTemplatePublish({...value,receive_type:3,full_reduction:'5.2'}).full_reduction).toBe('5.20');
});
it.each([[],['coupon_template.manage'],['coupon_template_issue.manage']].map(permissions=>({permissions})))('denies catalog/options and all writes without template.view ($permissions)',async ({permissions})=>{
  const {view,calls}=await mount(permissions);await view.openCreate();await view.save();await view.publish();expect(calls).toHaveLength(0);expect(view.canView.value).toBe(false);
});
it('allows readonly details/history but no creation, invalidation, deletion or publication',async()=>{
  const {view,calls}=await mount(['coupon_template.view']);await view.openCreate();expect(view.editorVisible.value).toBe(false);await view.openDetail(view.list.value[0],'view');expect(view.history.value[0].title).toBe('旧发行快照');await view.confirmAction(view.list.value[0],'delete');await view.publish();expect(writes(calls)).toHaveLength(0);expect(view.canPublish.value).toBe(false);
});
it('uses publication permission with view independently of template.manage',async()=>{
  const {view,calls}=await mount(['coupon_template.view','coupon_template_issue.manage']);await view.openDetail(view.list.value[0],'publish');await view.publish();expect(writes(calls).map(c=>c.url)).toEqual(['/marketing/coupon-template-issues']);expect(view.canManage.value).toBe(false);expect(view.canPublish.value).toBe(true);
});
it('defaults to valid templates and preserves applied filters during refresh',async()=>{
  const {view,calls}=await mount();expect(calls[0].params).toMatchObject({page:1,limit:15,status:1});view.draftKeyword.value=' 券_% ';view.draftStatus.value='';view.search();await flush();expect(calls.at(-1).params).toMatchObject({keyword:'券_%',status:'',page:1});await view.load();expect(calls.at(-1).params.keyword).toBe('券_%');view.reset();await flush();expect(calls.at(-1).params).toMatchObject({keyword:'',status:1});
});
it('retries a failed list without presenting it as an empty successful directory',async()=>{
  let fail=true;const {view}=await mount(grants,c=>c.url===endpoint&&fail?envelope(null,500,'目录失败'):undefined);expect(view.ready.value).toBe(false);expect(view.listError.value).toBe('目录失败');fail=false;await view.load();expect(view.ready.value).toBe(true);expect(view.list.value).toHaveLength(1);
});
it('retains create draft when options fail and prevents any save until a complete retry succeeds',async()=>{
  let fail=true;const {view,calls}=await mount(grants,c=>c.url.endsWith('/options')&&fail?envelope(null,500,'分类失败'):undefined);await create(view);await view.save();expect(writes(calls)).toHaveLength(0);expect(view.form.value.title).toBe(' 优惠券模板 ');expect(view.optionsError.value).toBe('分类失败');fail=false;await view.loadOptions();expect(view.options.value.categories).toHaveLength(2);
});
it('selects goods across pages once, supports page deselection and leaves draft unchanged on cancel',async()=>{
  const {view,calls}=await mount();await create(view,{scope_type:2});await view.openProducts();view.selectPage(true);await view.loadProducts(2);view.choose(view.products.value[0],true);expect([...view.choices.value.keys()]).toEqual([11,12]);view.selectPage(false);expect([...view.choices.value.keys()]).toEqual([11]);view.choose(view.products.value[0],true);view.applyProducts();expect(view.form.value.product_ids).toEqual([11,12]);expect(view.selectedProducts.value.map((p:any)=>p.store_name)).toEqual(['商品11','商品12']);await view.openProducts();view.unchoose(11);view.closeProducts();expect(view.form.value.product_ids).toEqual([11,12]);expect(calls.every(c=>!c.url.includes('/file/'))).toBe(true);expect(writes(calls)).toHaveLength(0);
});
it('keeps complete selection on a failed second page and can retry without silently dropping it',async()=>{
  let fail=true;const {view}=await mount(grants,c=>c.url.endsWith('/products')&&c.params.page===2&&fail?envelope(null,500,'第二页失败'):undefined);await create(view,{scope_type:2});await view.openProducts();view.selectPage(true);await view.loadProducts(2);view.applyProducts();expect(view.form.value.product_ids).toEqual([]);expect([...view.choices.value.keys()]).toEqual([11]);fail=false;await view.loadProducts(2);view.selectPage(true);view.applyProducts();expect(view.form.value.product_ids).toEqual([11,12]);
});
it.each(['count','csv'])('rejects over-capacity %s selection atomically and keeps IDs/names for correction',async kind=>{
  const {view}=await mount();await create(view,{scope_type:2,product_ids:[11]});view.selectedProducts.value=[product()];await view.openProducts();const ids=kind==='count'?Array.from({length:101},(_,n)=>n+1):Array.from({length:46},(_,n)=>2147483600-n);view.choices.value=new Map(ids.map(id=>[id,product(id)]));view.applyProducts();expect(view.form.value.product_ids).toEqual([11]);expect(view.productsVisible.value).toBe(true);expect(view.choices.value.size).toBe(ids.length);expect(view.productError.value).toContain('完整选择仍保留');view.unchoose(ids[0]);view.applyProducts();expect(view.productsVisible.value).toBe(false);expect(view.form.value.product_ids).toEqual(ids.slice(1));
});
it('ignores a closed picker late response and rejects stale row selection objects',async()=>{
  const gate=deferred();const {view}=await mount(grants,c=>c.url.endsWith('/products')&&c.params.page===2?gate.promise:undefined);await create(view,{scope_type:2});await view.openProducts();const previous=view.products.value[0];const pending=view.loadProducts(2);view.choose(previous,true);expect(view.choices.value.size).toBe(0);view.closeProducts();gate.resolve(envelope(page([product(12)],16,2)));await pending;expect(view.productsVisible.value).toBe(false);expect(view.products.value).toEqual([]);expect(view.form.value.product_ids).toEqual([]);
});
it('creates only whitelisted canonical template fields with a unique UUID and selected scope',async()=>{
  const {view,calls}=await mount();await create(view,{scope_type:1,category_id:3,product_ids:[11],owner:{type:9},revision:'injected'});await view.save();const payload=body(writes(calls)[0]);expect(payload).toEqual({...runtime.api.normalizeCouponTemplate(input({scope_type:1,category_id:3,product_ids:[11]})),request_id:expect.stringMatching(uuid)});expect(view.editorVisible.value).toBe(false);expect(calls.filter(c=>c.url===endpoint&&c.method==='get')).toHaveLength(2);
});
it('rejects unknown category and empty product scope before creating anything',async()=>{
  const {view,calls}=await mount();await create(view,{scope_type:1,category_id:999});await view.save();expect(view.editorError.value).toContain('品类');view.form.value.scope_type=2;view.form.value.product_ids=[];await view.save();expect(view.editorError.value).toContain('商品');expect(writes(calls)).toHaveLength(0);
});
it('keeps draft and selected products after a confirmed backend rejection',async()=>{
  const {view,calls}=await mount(grants,c=>c.method==='post'?envelope(null,409,'商品范围已变更'):undefined);await create(view,{scope_type:2,product_ids:[11,12]});view.selectedProducts.value=[product(11),product(12)];await view.save();expect(view.editorVisible.value).toBe(true);expect(view.form.value.product_ids).toEqual([11,12]);expect(view.selectedProducts.value).toHaveLength(2);expect(view.uncertainOperation.value).toBeNull();expect(view.editorError.value).toContain('商品范围已变更');expect(writes(calls)).toHaveLength(1);
});
it('reads damaged scope details/history but refuses publication while retaining inactive actions',async()=>{
  const damaged=row(1,{valid:false,coupon_price:'坏金额',issues:['来源缺失']});const {view,calls}=await mount(grants,c=>c.method==='get'&&!c.url.endsWith('/issues')&&c.url!==endpoint?envelope(damaged):c.url===endpoint?envelope(page([damaged])):undefined);await view.openDetail(view.list.value[0],'publish');expect(view.editorVisible.value).toBe(false);await view.openDetail(view.list.value[0],'view');expect(view.detail.value.coupon_price).toBe('坏金额');expect(view.detail.value.issues).toContain('来源缺失');view.closeEditor();await view.confirmAction(view.list.value[0],'invalidate');expect(writes(calls)[0].url).toBe(endpoint+'/1/invalidate');
});
it('re-reads authoritative template detail before publishing and never writes snapshot scope or amounts',async()=>{
  const {view,calls}=await mount(grants,c=>c.url===endpoint+'/1'?envelope(row(1,{revision:'b'.repeat(64),coupon_price:'20.00'})):undefined);await view.openDetail(view.list.value[0],'publish');view.publishForm.value.receive_type=3;view.publishForm.value.full_reduction='100.5';view.publishStart.value='2099-10-01T12:00';view.publishEnd.value='2099-10-02T12:00';await view.publish();expect(body(writes(calls)[0])).toEqual({template_id:1,revision:'b'.repeat(64),receive_type:3,status:1,is_permanent:0,count:1,start_time:'2099-10-01T04:00:00.000Z',end_time:'2099-10-02T04:00:00.000Z',full_reduction:'100.50',request_id:expect.stringMatching(uuid)});
});
it('publishes unlimited ordinary/newcomer counts as zero and strips stale gift-only amount',async()=>{
  const {view,calls}=await mount();await view.openDetail(view.list.value[0],'publish');view.publishForm.value.receive_type=2;view.publishForm.value.full_reduction='88';view.publishForm.value.is_permanent=1;view.publishForm.value.count=100;await view.publish();expect(body(writes(calls)[0])).toMatchObject({receive_type:2,is_permanent:1,count:0,full_reduction:'0.00',start_time:null,end_time:null});
});
it('keeps the publication editor and refuses incomplete or expired windows without writes',async()=>{
  const {view,calls}=await mount();await view.openDetail(view.list.value[0],'publish');view.publishStart.value='2099-10-01T12:00';await view.publish();expect(view.editorError.value).toContain('领取时间');expect(view.publishStart.value).toBe('2099-10-01T12:00');expect(writes(calls)).toHaveLength(0);
});
it('cancels editor and deferred confirmations without a write',async()=>{
  const {view,calls}=await mount();await create(view);view.closeEditor();await view.save();runtime.messages.state.confirm=()=>Promise.reject(Error('cancel'));await view.confirmAction(view.list.value[0],'delete');expect(writes(calls)).toHaveLength(0);expect(runtime.messages.state.confirmations[0][0]).toContain('已有发行');
});
it('sends revision/UUID to permanent invalidation and soft deletion and returns a deleted tail page',async()=>{
  let deleted=false;const {view,calls}=await mount(grants,c=>{if(c.method==='delete'){deleted=true;return envelope({id:2})}if(c.url===endpoint&&c.params.page===2)return envelope(page(deleted?[]:[row(2)],deleted?15:16,2));return undefined});await view.confirmAction(view.list.value[0],'invalidate');expect(body(writes(calls)[0])).toEqual({revision,request_id:expect.stringMatching(uuid)});await view.load(2);await view.confirmAction(view.list.value[0],'delete');expect(view.page.value).toBe(1);expect(writes(calls).at(-1).method).toBe('delete');expect(new Set(writes(calls).map(c=>body(c).request_id)).size).toBe(2);
});
it.each(['network','malformed'])('keeps unknown publish %s intent/UUID and performs GET-only reconciliation',async failure=>{
  const {view,calls}=await mount(grants,c=>{if(c.method==='post'){if(failure==='network')throw Error('响应丢失');return envelope({template_id:1,issue_id:'bad'})}return undefined});await view.openDetail(view.list.value[0],'publish');view.publishForm.value.count=13;await view.publish();const pending=view.uncertainOperation.value;expect(pending.kind).toBe('publish');expect(pending.body.count).toBe(13);expect(pending.body.request_id).toMatch(uuid);expect(view.editorVisible.value).toBe(true);expect(view.publishForm.value.count).toBe(13);await view.reconcile();await view.publish();expect(view.uncertainOperation.value.body.request_id).toBe(pending.body.request_id);expect(writes(calls)).toHaveLength(1);expect(calls.filter(c=>c.url.endsWith('/issues')).length).toBeGreaterThanOrEqual(2);expect(calls.filter(c=>c.url.endsWith('/issues')).every(c=>!c.params.request_id)).toBe(true);
});
it('keeps unknown create selected scope and does not infer absence as permission to resubmit',async()=>{
  const {view,calls}=await mount(grants,c=>c.method==='post'?envelope({id:0}):undefined);await create(view,{scope_type:2,product_ids:[11]});view.selectedProducts.value=[product()];await view.save();const key=view.uncertainOperation.value.body.request_id;await view.reconcile();await view.save();expect(writes(calls)).toHaveLength(1);expect(view.uncertainOperation.value.body.request_id).toBe(key);expect(view.form.value.product_ids).toEqual([11]);expect(view.selectedProducts.value[0].id).toBe(11);
});
it('can clear a manually verified pending operation without replaying its write',async()=>{
  const {view,calls}=await mount(grants,c=>c.method==='post'?envelope({id:0}):undefined);await create(view);await view.save();await view.acknowledge();expect(view.uncertainOperation.value).toBeNull();expect(writes(calls)).toHaveLength(1);expect(runtime.messages.state.confirmations.at(-1)[0]).toContain('不会再次提交');
});
it('rejects malformed and cross-template history rows, with independent read retry',async()=>{
  let bad=true;const {view}=await mount(grants,c=>c.url.endsWith('/issues')?envelope(page([issue(7,{template_id:bad?2:1})],1,c.params.page)):undefined);await view.openDetail(view.list.value[0],'view');expect(view.detail.value.id).toBe(1);expect(view.historyError.value).toContain('归属');expect(view.history.value).toEqual([]);bad=false;await view.loadHistory();expect(view.history.value[0].template_id).toBe(1);
});
it('reads lineage-linked historical receive types 0/4/-2 without relaxing new publication inputs',async()=>{
  const {view,calls}=await mount(grants,c=>c.url.endsWith('/issues')?envelope(page([issue(7,{receive_type:0}),issue(8,{receive_type:4}),issue(9,{receive_type:-2})])):undefined);await view.openDetail(view.list.value[0],'view');expect(view.historyError.value).toBe('');expect(view.history.value.map((record:any)=>record.receive_type)).toEqual([0,4,-2]);expect(view.history.value.map((record:any)=>view.receiveLabel(record.receive_type))).toEqual(['未知 #0','未知 #4','未知 #-2']);
  for(const receive_type of [0,4,-2]) expect(()=>runtime.api.normalizeCouponTemplatePublish({template_id:1,revision,receive_type,status:1,is_permanent:0,count:1,start_time:null,end_time:null,full_reduction:'0.00'})).toThrow();expect(writes(calls)).toHaveLength(0);
});
it('preserves all three mutable historical smallint flags and does not infer an unknown unlimited flag',async()=>{
  const records=[issue(7,{receive_type:2,is_permanent:2,status:2}),issue(8,{receive_type:-2,is_permanent:-2,status:-2})];const {view,calls}=await mount(grants,c=>c.url.endsWith('/issues')?envelope(page(records)):undefined);await view.openDetail(view.list.value[0],'view');expect(view.historyError.value).toBe('');expect(view.history.value).toEqual(records);expect(view.issueStatus(2)).toBe('历史状态 #2');expect(view.issueStatus(-2)).toBe('历史状态 #-2');expect(view.issueAmount(view.history.value[0])).toBe('未知标记 #2 · 100 / 70');expect(view.issueAmount(view.history.value[1])).toBe('未知标记 #-2 · 100 / 70');
  const value={template_id:1,revision,receive_type:1,status:1,is_permanent:0,count:1,start_time:null,end_time:null,full_reduction:'0.00'};for(const field of ['status','is_permanent','receive_type'])for(const raw of [2,-2]){if(field==='receive_type'&&raw===2)continue;expect(()=>runtime.api.normalizeCouponTemplatePublish({...value,[field]:raw})).toThrow()}expect(writes(calls)).toHaveLength(0);
});
it.each(['list','products','history'])('uses real Element Plus %s pagination without a loading page-two clamp',async pager=>{
  const gate=deferred();let hold=true;const route=pager==='list'?endpoint:pager==='products'?endpoint+'/products':endpoint+'/1/issues';const fixture=(next:number)=>page(pager==='list'?[row(next)]:pager==='products'?[product(next===1?11:12)]:[issue(next===1?7:8)],16,next);
  const {view,calls}=await mount(grants,c=>c.url===route?c.params.page===2&&hold?gate.promise:envelope(fixture(c.params.page)):undefined,pager as any);if(pager==='products'){await create(view,{scope_type:2});await view.openProducts()}if(pager==='history')await view.openDetail(view.list.value[0],'view');const load=view[pager==='list'?'load':pager==='products'?'loadProducts':'loadHistory'],state=view[pager==='list'?'page':pager==='products'?'productPage':'historyPage'];const pending=load(2);await flush();expect(state.value).toBe(2);expect(calls.filter(c=>c.url===route).map(c=>c.params.page)).toEqual([1,2]);hold=false;gate.resolve(envelope(fixture(2)));await pending;await flush();expect(state.value).toBe(2);await load(1);await flush();expect(state.value).toBe(1);
});
it('rejects late detail and picker results after account A→B→A replacement',async()=>{
  const gate=deferred();const {view}=await mount(grants,c=>c.url===endpoint+'/1'?gate.promise:undefined);const pending=view.openDetail(view.list.value[0],'view');await flush();login(grants,'coupon-b',13);browser.dispatchEvent(new Event('admin-session-changed'));await flush();login(grants,'coupon-a',12);browser.dispatchEvent(new Event('admin-session-changed'));await flush();gate.resolve(envelope(row()));await pending;expect(view.detail.value).toBeNull();expect(view.editorVisible.value).toBe(false);expect(view.list.value[0].id).toBe(1);
});
it('does not act on a confirmation that resolves after an actor change',async()=>{
  const gate=deferred();runtime.messages.state.confirm=()=>gate.promise;const {view,calls}=await mount();const pending=view.confirmAction(view.list.value[0],'invalidate');await flush();login(['coupon_template.view'],'reader-b',9);browser.dispatchEvent(new Event('admin-session-changed'));await flush();gate.resolve();await pending;expect(writes(calls)).toHaveLength(0);expect(runtime.messages.state.closed).toBe(1);
});
it('guards already-started write completion and old account auth errors from overriding replacement state',async()=>{
  const gate=deferred();const {view}=await mount(grants,c=>c.method==='post'?gate.promise:undefined);await create(view);const pending=view.save();await flush();login(['coupon_template.view'],'reader-b',9);browser.dispatchEvent(new Event('admin-session-changed'));await flush();gate.resolve(envelope(null,410000,'过期旧请求'));await pending;expect(localStorage.getItem('admin_token')).toBe('reader-b');expect(view.canView.value).toBe(true);expect(view.uncertainOperation.value).toBeNull();expect(runtime.messages.state.successes).toEqual([]);
});
it('validates outgoing UUID/version and treats malformed mutation responses as unknown',async()=>{
  const {calls}=await mount();await expect(runtime.api.apiCouponTemplateCreate({...input(),request_id:'bad'})).rejects.toThrow('请求ID');await expect(runtime.api.apiCouponTemplateInvalidate(1,{revision:'bad',request_id:crypto.randomUUID()})).rejects.toThrow('版本');expect(writes(calls)).toHaveLength(0);
});
