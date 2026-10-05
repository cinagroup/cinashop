import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname,'../../view/admin-ts'), require = createRequire(resolve(root,'package.json'));
const { parse,compileScript,compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, browser: any, downloads: any[], apps: any[] = [];
const all = ['combination.view','combination.manage','combination_group.view','combination_statistics.view','combination_export.view','order.view'];
beforeAll(async () => {
  vi.stubGlobal('window',Object.assign(new EventTarget(),{ innerWidth:1280,location:{ search:'',pathname:'/',href:'' } }));
  vi.stubGlobal('localStorage',{ getItem:() => null,setItem(){},removeItem(){} });
  const result = await build({ absWorkingDir:root,stdin:{ resolveDir:root,contents:
    "export {default as Groups} from './src/pages/activity/CombinationGroups.vue'; export {default as Statistics} from './src/pages/activity/CombinationStatistics.vue'; export {default as Members} from './src/pages/activity/CombinationMembers.vue'; export {default as Catalog} from './src/pages/activity/Combinations.vue'; export {default as Pagination} from 'element-plus/es/components/pagination/index.mjs'; export * as api from './src/api/combinationStatistics'; export * as csv from './src/utils/combinationCsv'; export {default as request} from './src/utils/request'; export {createRenderer,createVNode,nextTick,reactive,proxyRefs} from 'vue'; export {createPinia} from 'pinia'; export {useAuthStore} from './src/stores/auth'; export * as routing from 'vue-router';"
  },alias:{ '@':resolve(root,'src') },define:{ 'import.meta.env.DEV':'false' },bundle:true,write:false,platform:'browser',format:'esm',plugins:[{ name:'combination-read-runtime',setup(builder) {
    builder.onLoad({ filter:/\.vue$/ },({ path }) => { const descriptor = parse(readFileSync(path,'utf8'),{ filename:path }).descriptor, script = compileScript(descriptor,{ id:'read' }), template = compileTemplate({ source:descriptor.template.content,filename:path,id:'read',compilerOptions:{ bindingMetadata:script.bindings } }); if (template.errors.length) throw Error(template.errors.map(String).join('\n')); return { contents:script.content,loader:'ts' }; });
    builder.onResolve({ filter:/^element-plus$/ },() => ({ path:'messages',namespace:'fixture' }));
    builder.onResolve({ filter:/^vue-router$/ },() => ({ path:'router',namespace:'fixture' }));
    builder.onLoad({ filter:/.*/,namespace:'fixture' },({ path }) => ({ resolveDir:root,contents:path === 'router' ? "import {reactive} from 'vue'; export const route=reactive({params:{id:'1'}}); export const pushes=[]; export const useRoute=()=>route; export const useRouter=()=>({push:value=>pushes.push(value)});" : "export const ElMessage={success(){}};export const ElMessageBox={confirm:()=>Promise.resolve(),close(){}};" }));
  } }] });
  runtime = await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
},120000);
const group = (id = 10, extra = {}) => ({ id,combination_id:1,product_id:21,uid:8,nickname:'队长',avatar_preview:'/avatar.png',title:'历史活动',people:3,member_count_raw:2,participant_record_count:4,active_real_count:2,virtual_count:1,status:1,status_raw:1,is_refund:0,expired_pending:true,add_time:1790470800,stop_time:'2026-09-27T04:00:00.000Z',deleted_user:false,missing_user:false,activity_deleted:false,activity_missing:false,issues:[],...extra });
const member = (pink = 10, extra = {}) => ({ pink_id:pink,combination_id:1,product_id:21,uid:8,nickname:'队长',avatar_preview:'/avatar.png',is_leader:true,is_virtual:0,is_refund:0,price:'12.30',add_time:1790470800,status_raw:1,deleted_user:false,missing_user:false,order_id:'wx_ORDER_01',order_db_id:50,order_id_snapshot:'wx_ORDER_01',order_key_snapshot:'source-key',order_deleted:false,detail_available:true,issues:[],...extra });
const order = (id = 50, extra = {}) => ({ id,order_id:'wx_ORDER_01',uid:8,real_name:'李',user_phone:'123',nickname:'旧用户',pay_price:'1234567890.12',total_num:2,add_time:1790470800,pay_time:1790471800,status:'已完成',status_raw:3,shipping_type:1,refund_status:2,refund_type:5,parent_id:-1,deleted:false,detail_available:true,issues:[],...extra });
const head = (id = 1,extra = {}) => ({ id,store_name:'历史活动',activity_deleted:true,people_count:4,spread_count:2,start_count:3,success_count:1,pay_price:'900719925474.12',pay_count:2,...extra });
const catalog = () => ({ id:1,product_id:21,title:'拼团',image:'/api/assets/1',image_preview:'/api/assets/1?signature=mock',start_time:'2026-09-27T04:00:00.000Z',end_time:'2026-09-29T04:00:00.000Z',status:1,phase:'active',people:3,quota_total:10,consumed:2,remaining:8,stock:8,sales:2,sort:0,valid:true,issues:[],revision:'a'.repeat(64),price:'5.00',ot_price:'19.00',count_people:8,count_people_all:12,count_people_pink:4 });
const page = (list: any[], count = list.length, next = 1) => ({ list,count,page:next,limit:15 });
const envelope = (data: unknown,status = 200) => ({ status,msg:status === 200 ? 'ok' : '受控失败',data });
const exportRow = (id = 1,extra = {}) => ({ id:String(id),title:'拼团商品',ot_price:'19.00',price:'5.00',stock:'8',people:'3',count_people_all:'12',count_people_pink:'2',sales:'4',is_show:'开启',stop_time:'2026-09-29 12:00:00',...extra });
function manifest(rows: any[], next = 1) {
  const header = [...runtime.api.combinationExportHeaders], filekey = [...runtime.api.combinationExportKeys], csv = runtime.csv.buildCombinationCsv(header,rows.map(row => filekey.map(key => row[key])),16777216,true);
  return { header,filekey,export:rows.slice((next-1)*1000,next*1000),filename:'拼团商品导出',count:rows.length,page:next,limit:1000,has_more:next*1000<rows.length,snapshot:'b'.repeat(64),csv_bytes:new TextEncoder().encode(csv).byteLength,max_rows:100000,max_bytes:16777216,timezone:'Asia/Shanghai' };
}
function login(permissions = all,token = 'reader-a',id = 7) { localStorage.setItem('admin_token',token); localStorage.setItem('admin_session',JSON.stringify({ userInfo:{ id,account:'operator',level:1 },menus:[],uniqueAuth:permissions })); }
beforeEach(() => {
  const values = new Map<string,string>(); browser = Object.assign(new EventTarget(),{ innerWidth:1280,location:{ search:'',pathname:'/',href:'' } });
  vi.stubGlobal('window',browser); vi.stubGlobal('localStorage',{ getItem:(key: string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key) });
  downloads = []; vi.spyOn(URL,'createObjectURL').mockImplementation(blob => { downloads.push(blob); return 'blob:local'; }); vi.spyOn(URL,'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('document',{ createElement:()=>({ style:{},href:'',download:'',click:vi.fn(),remove:vi.fn() }),body:{ appendChild:vi.fn() } });
  runtime.routing.route.params.id = '1'; runtime.routing.pushes.length = 0;
});
afterEach(() => { apps.forEach(app=>app.unmount()); apps=[]; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const flush = async () => { for(let n=0;n<8;n++) { await new Promise(done=>setTimeout(done,1)); await runtime.nextTick(); } };
function deferred() { let resolve!: (value?:unknown)=>void; const promise = new Promise(done=>{ resolve=done; }); return { promise,resolve }; }
async function mount(kind = 'Groups',permissions = all,respond: (config:any)=>unknown = ()=>undefined,propsValue: any = {},pagination: boolean | 'always' = false) {
  login(permissions); const calls: any[] = [],emissions: any[] = [],props = runtime.reactive({ modelValue:true,groupId:10,...propsValue });
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await respond(config), next=config.params?.page??1, activity=Number(config.url.match(/statistics\/(\d+)/)?.[1]??1);
    let fallback: unknown;
    if(config.url.endsWith('/export')) fallback=manifest([exportRow()],next);
    else if(config.url.endsWith('/members')) fallback={ ...page([member()],1,next),group_id:props.groupId,combination_id:props.activityId??1,replacement_leader_id:null };
    else if(config.url.endsWith('/head')) fallback=config.url.includes('combination-groups')?{ participant_record_count:8,success_count:2 }:head(activity);
    else if(config.url.endsWith('/orders')) fallback={ ...page([order()],1,next),id:activity,combination_id:activity };
    else if(config.url === '/activity/combinations') fallback=page([catalog()],1,next);
    else fallback=page([group(10,{ combination_id:activity })],1,next);
    return { config,data:custom??envelope(fallback),status:200,statusText:'fixture',headers:{} };
  };
  let view: any, probe: any;
  if(pagination) {
    const descriptor=parse(readFileSync(resolve(root,'src/pages/activity/Combination'+kind+'.vue'),'utf8')).descriptor;
    const opening=descriptor.template.content.match(/<el-pagination([^>]+)>/)[1], condition=opening.match(/v-if="([^"]+)"/)[1];
    probe={ props:['currentPage','pageSize','total','disabled'],setup(properties: any,context: any) { runtime.Pagination.setup(properties,context); return ()=>null; } };
    probe.condition = pagination === 'always' ? () => true : new Function('state','with(state){return ('+condition+')}');
  }
  const renderer=runtime.createRenderer({ createElement:()=>({ children:[] }),createText:(text:string)=>({ text }),createComment:(text:string)=>({ text }),insert(node:any,parent:any){ node.parent=parent;(parent.children??=[]).push(node); },remove(){},parentNode:(node:any)=>node.parent,nextSibling:()=>null,patchProp(){},setText(){},setElementText(){} });
  const app=renderer.createApp({ setup(_props:any,context:any) { view=runtime[kind].setup(props,{ ...context,emit:(...args:any[])=>emissions.push(args) }); return ()=>pagination&&probe.condition(runtime.proxyRefs(view))?runtime.createVNode(probe,{ currentPage:view.page.value,pageSize:15,total:view.count.value,disabled:kind==='Members'?view.loading.value:view.listLoading.value,'onUpdate:currentPage':(value:number)=>{ view.page.value=value; },onCurrentChange:(value:number)=>void (kind==='Members'?view.load(value):view.loadList(value)) }):null; } });
  app.use(runtime.createPinia()); app.mount({ children:[] }); apps.push(app); await flush(); return { view,calls,props,emissions,close:()=>app.unmount() };
}
it('uses independent sensitive read permissions instead of granting them through combination.manage',async()=>{
  for(const kind of ['Groups','Statistics','Members']) { const state=await mount(kind,['combination.manage']); expect(state.calls).toHaveLength(0); expect(state.view.session.allowed.value).toBe(false); state.close(); }
});
it('keeps the global two cards independent of status/date/activity filters',async()=>{
  const { view,calls }=await mount(); expect(view.head.value).toEqual({ participant_record_count:8,success_count:2 });
  view.draftKeyword.value='_%';view.draftStatus.value=3;view.draftStart.value='2026-09-27';view.draftEnd.value='2026-09-28';view.draftActivity.value='2';view.search();await flush();
  expect(calls.filter(c=>c.url.endsWith('/head'))).toHaveLength(1);expect(calls.at(-1).params).toMatchObject({ keyword:'_%',status:3,start_day:'2026-09-27',end_day:'2026-09-28',combination_id:2,page:1,limit:15 });
});
it.each(['Groups','Statistics','Members'])('uses real Element Plus pagination watchers for %s without clamping a loading second page',async(kind)=>{
  const gate=deferred(); let hold=true;
  const { view,calls }=await mount(kind,all,config=>config.params?.page===2&&hold?gate.promise:config.params?.page?envelope(kind==='Members'?{ ...page([member(config.params.page===1?10:11)],16,config.params.page),group_id:10,combination_id:1,replacement_leader_id:null }:page([group(config.params.page===1?10:11)],16,config.params.page)):undefined,{},true);
  const load=kind==='Members'?view.load:view.loadList; const pending=load(2);await flush();expect(view.page.value).toBe(2);expect(calls.filter(c=>c.params?.page).map(c=>c.params.page)).toEqual([1,2]);
  hold=false;gate.resolve(envelope(kind==='Members'?{ ...page([member(11)],16,2),group_id:10,combination_id:1,replacement_leader_id:null }:page([group(11)],16,2)));await pending;await flush();expect(view.page.value).toBe(2);
  await load(1);await flush();expect(view.page.value).toBe(1);expect(calls.filter(c=>c.params?.page).map(c=>c.params.page)).toEqual([1,2,1]);
});
it('proves the real Element Plus clamp would regress an always-mounted pager when total clears',async()=>{
  const gate=deferred();const {view,calls}=await mount('Groups',all,c=>c.params?.page===2?gate.promise:c.params?.page?envelope(page([group()],16,c.params.page)):undefined,{},'always');
  // The real watcher cancels the second-page signal before Axios reaches its
  // adapter, and immediately starts another page-one read.
  void view.loadList(2);await flush();expect(view.page.value).toBe(1);expect(calls.filter(c=>c.params?.page).map(c=>c.params.page)).toEqual([1,1]);gate.resolve(envelope(page([group(11)],16,2)));await flush();expect(view.page.value).toBe(1);
});
it('retries head and list failures separately without turning errors into ordinary empty results',async()=>{
  let failed=true;const {view,calls}=await mount('Groups',all,()=>failed?envelope(null,500):undefined);
  expect(view.head.value).toBeNull();expect(view.headError.value).toBeTruthy();expect(view.listError.value).toBeTruthy();failed=false;
  await view.loadHead();expect(view.headError.value).toBe('');expect(view.listError.value).toBeTruthy();const before=calls.length;await view.loadList(1);expect(calls.length).toBe(before+1);expect(view.groups.value).toHaveLength(1);
});
it('rejects malformed query and calendar days before sending reads',async()=>{
  const {view,calls}=await mount();const count=calls.length;view.draftStart.value='2026-02-30';view.search();expect(calls).toHaveLength(count);expect(view.filterError.value).toBeTruthy();
  view.draftStart.value='';view.draftActivity.value='-1';view.search();expect(calls).toHaveLength(count);await view.loadList(668);expect(calls).toHaveLength(count);
});
it('shows unknown and expired pending states honestly while retaining damaged historical rows',async()=>{
  const {view}=await mount('Groups',all,c=>c.url.endsWith('/head')?undefined:envelope(page([group(-1,{ product_id:-9,combination_id:0,status:9,status_raw:9,stop_time:null,issues:['历史损坏'] })])));
  expect(view.groups.value).toHaveLength(1);expect(runtime.api.combinationGroupStatus(view.groups.value[0])).toBe('未知状态 #9');expect(runtime.api.combinationGroupStatus(group())).toBe('已到期，待结算');
});
it('rejects a late old filter response after the newest list has loaded',async()=>{
  const gate=deferred();const {view}=await mount('Groups',all,c=>c.params?.keyword==='old'?gate.promise:undefined);
  view.draftKeyword.value='old';view.search();await flush();view.draftKeyword.value='new';view.search();await flush();gate.resolve(envelope(page([group(99)])));await flush();expect(view.groups.value[0].id).toBe(10);
});
it('cancels an actor A to B to A ABA read and does not reinstall stale private data',async()=>{
  const gate=deferred();let hold=false;const {view}=await mount('Groups',all,c=>hold&&c.url.endsWith('/head')?gate.promise:undefined);hold=true;void view.loadHead();await flush();
  login(['combination.manage'],'reader-b',8);browser.dispatchEvent(new Event('admin-session-changed'));login(all);hold=false;browser.dispatchEvent(new Event('admin-session-changed'));await flush();gate.resolve(envelope({participant_record_count:999,success_count:999}));await flush();expect(view.head.value.participant_record_count).toBe(8);
});
it('does not request NaN or a missing optional statistics ID and validates chooser navigation',async()=>{
  runtime.routing.route.params.id='';const {view,calls}=await mount('Statistics');expect(calls).toHaveLength(0);view.idInput.value='0';view.openId();expect(runtime.routing.pushes).toHaveLength(0);view.idInput.value='2';view.openId();expect(runtime.routing.pushes).toEqual(['/activity/combination-statistics/2']);
});
it('preserves exact gross historical money and six distinct head measures',async()=>{
  const {view}=await mount('Statistics');expect(view.head.value.pay_price).toBe('900719925474.12');expect(view.cards.value).toHaveLength(6);expect(view.cards.value.map((card:any)=>card.value)).toEqual([4,2,3,1,'900719925474.12',2]);
});
it('uses scoped leaders and paid-root orders with independent tab queries and status zero',async()=>{
  const {view,calls}=await mount('Statistics');view.draftGroupStatus.value=3;view.search();await flush();expect(calls.at(-1).url).toBe('/activity/combination-statistics/1/groups');
  view.tab.value='orders';view.changeTab();await flush();view.draftOrderStatus.value=0;view.draftKeyword.value='商品_%';view.search();await flush();expect(calls.at(-1).params).toMatchObject({keyword:'商品_%',status:0,page:1,limit:15});expect(calls.at(-1).params).not.toHaveProperty('combination_id');
});
it('cancels late statistics results across route IDs and tab changes',async()=>{
  const gate=deferred();let hold=true;const {view}=await mount('Statistics',all,c=>c.url==='/activity/combination-statistics/1/orders'&&hold?gate.promise:undefined);
  view.tab.value='orders';view.changeTab();await flush();runtime.routing.route.params.id='2';hold=false;await flush();gate.resolve(envelope({...page([order(99)]),id:1,combination_id:1}));await flush();expect(view.head.value.id).toBe(2);expect(view.orders.value).toEqual([]);expect(view.groups.value[0].combination_id).toBe(2);
});
it('scopes members to a pink leader ID and rejects cross-activity member envelopes',async()=>{
  const {view,calls}=await mount('Members',all,()=>envelope({...page([member()]),group_id:10,combination_id:2,replacement_leader_id:null}),{activityId:1});
  expect(calls[0].url).toBe('/activity/combination-statistics/1/groups/10/members');expect(view.members.value).toEqual([]);expect(view.error.value).toBeTruthy();
});
it('retains global historical cid zero members without widening a fixed activity scope',async()=>{
  const {view}=await mount('Members',all,()=>envelope({...page([member(10,{combination_id:0,issues:['关联活动缺失']})]),group_id:10,combination_id:0,replacement_leader_id:null}));
  expect(view.members.value).toHaveLength(1);expect(view.members.value[0].combination_id).toBe(0);expect(view.error.value).toBe('');
});
it('routes only matching live business order numbers and never database IDs or historical snapshot keys',async()=>{
  const records=[member(),member(11,{uid:0,is_virtual:1}),member(12,{order_deleted:true}),member(13,{detail_available:false,order_id_snapshot:'raw-private'}),member(14,{order_id:'bad/route'})];
  const {view}=await mount('Members',all,()=>envelope({...page(records),group_id:10,combination_id:1,replacement_leader_id:20}));
  records.forEach((_,index)=>view.openOrder(view.members.value[index]));expect(runtime.routing.pushes).toEqual(['/order/wx_ORDER_01']);expect(view.replacement.value).toBe(20);
});
it('does not grant order detail navigation through a statistics or group read permission alone',async()=>{
  const {view}=await mount('Members',['combination_group.view']);expect(view.canOrder(view.members.value[0])).toBe(false);view.openOrder(view.members.value[0]);expect(runtime.routing.pushes).toEqual([]);
});
it('discards a member response after closing or replacing its leader selection',async()=>{
  const gate=deferred();const {view,props}=await mount('Members',all,c=>c.url.includes('/11/')?gate.promise:undefined);
  props.groupId=11;await flush();view.close();gate.resolve(envelope({...page([member(99)]),group_id:11,combination_id:1,replacement_leader_id:null}));await flush();expect(view.members.value).toEqual([]);
});
it('permits statistics order links only with independent order permission and live backend identity',async()=>{
  const {view}=await mount('Statistics');view.tab.value='orders';await view.loadList();view.openOrder(view.orders.value[0]);expect(runtime.routing.pushes).toEqual(['/order/wx_ORDER_01']);view.orders.value[0].deleted=true;view.openOrder(view.orders.value[0]);expect(runtime.routing.pushes).toHaveLength(1);
});
it('projects catalog prices and three raw counts without changing the complete form API',async()=>{
  const {view}=await mount('Catalog');expect(view.list.value[0]).toMatchObject({price:'5.00',ot_price:'19.00',count_people:8,count_people_all:12,count_people_pink:4,people:3});
});
it('allows export-only actors to filter and export without requesting catalog or options',async()=>{
  const {view,calls}=await mount('Catalog',['combination_export.view']);expect(calls).toHaveLength(0);view.draftKeyword.value='拼团';view.search();await view.exportCsv();expect(calls.map(c=>c.url)).toEqual(['/activity/combinations/export']);expect(calls[0].params.keyword).toBe('拼团');expect(downloads).toHaveLength(1);expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local');
});
it('does not grant export through manage and generates no file for unauthorized handlers',async()=>{
  const {view,calls}=await mount('Catalog',['combination.view','combination.manage']);const before=calls.length;await view.exportCsv();expect(calls).toHaveLength(before);expect(downloads).toEqual([]);
});
it('reads beyond the first 1000 rows with one stable snapshot and only then downloads once',async()=>{
  const rows=Array.from({length:1001},(_,n)=>exportRow(n+1));const {view,calls}=await mount('Catalog',all,c=>c.url.endsWith('/export')?envelope(manifest(rows,c.params.page)):undefined);
  await view.exportCsv();const pages=calls.filter(c=>c.url.endsWith('/export'));expect(pages.map(c=>c.params.page)).toEqual([1,2]);expect(pages[1].params.snapshot).toBe('b'.repeat(64));expect(downloads).toHaveLength(1);expect((await downloads[0].text()).split('\r\n')).toHaveLength(1003);
});
it.each(['failure','snapshot','header','bytes','duplicate'])('never downloads partial exports when a later page has %s',async(fault)=>{
  const rows=Array.from({length:1001},(_,n)=>exportRow(n+1));const {view}=await mount('Catalog',all,c=>{
    if(!c.url.endsWith('/export'))return undefined;const data=manifest(rows,c.params.page);if(c.params.page===2){if(fault==='failure')return envelope(null,500);if(fault==='snapshot')data.snapshot='c'.repeat(64);if(fault==='header')data.header[0]='错误';if(fault==='bytes')data.csv_bytes++;if(fault==='duplicate')data.export[0]=rows[0];}return envelope(data);
  });await view.exportCsv();expect(downloads).toEqual([]);expect(view.exportError.value).toBeTruthy();
});
it('cancels late exports on user cancel and ABA identity replacement without a file',async()=>{
  const gate=deferred();let hold=true;const {view}=await mount('Catalog',all,c=>c.url.endsWith('/export')&&hold?gate.promise:undefined);void view.exportCsv();await flush();view.cancelExport(true);gate.resolve(envelope(manifest([exportRow()])));await flush();expect(downloads).toEqual([]);
  const second=deferred();runtime.request.defaults.adapter=async(config:any)=>({config,data:await second.promise,status:200,statusText:'fixture',headers:{}});void view.exportCsv();await flush();login(all,'b',8);browser.dispatchEvent(new Event('admin-session-changed'));login(all);browser.dispatchEvent(new Event('admin-session-changed'));second.resolve(envelope(manifest([exportRow()])));await flush();expect(downloads).toEqual([]);
});
it('creates BOM/CRLF and preserves money, embedded line breaks and protected Unicode formula cells exactly',async()=>{
  const row=exportRow(1,{title:"'=SUM(1)\n中文 \"图\"",price:'900719925474.12'}), data=manifest([row]);runtime.request.defaults.adapter=async(config:any)=>({config,data:envelope(data),status:200,statusText:'fixture',headers:{}});
  const result=await runtime.api.collectCombinationExport({keyword:'',phase:'',status:''},new AbortController().signal,()=>{});expect(result.csv.startsWith('\ufeff')).toBe(true);expect(result.csv.endsWith('\r\n')).toBe(true);expect(result.csv).toContain("900719925474.12");expect(result.csv).toContain("中文 \"\"图\"\"");expect(result.csv).toContain("\n中文");expect(runtime.csv.combinationCsvCell(' \t=1')).toBe('"\' \t=1"');
});
it('rejects unsafe unprotected titles and complete export capacity or byte mismatches',async()=>{
  const invalid=manifest([exportRow(1,{title:' =cmd'})]);runtime.request.defaults.adapter=async(config:any)=>({config,data:envelope(invalid),status:200,statusText:'fixture',headers:{}});await expect(runtime.api.apiCombinationExport({page:1,limit:1000,keyword:'',phase:'',status:''})).rejects.toThrow();
  invalid.export[0].title="' =cmd";invalid.count=100001;await expect(runtime.api.apiCombinationExport({page:1,limit:1000,keyword:'',phase:'',status:''})).rejects.toThrow();
});
