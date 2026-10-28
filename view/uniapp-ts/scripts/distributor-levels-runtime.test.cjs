const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const component = 'pages/users/user_distribution_level/index.vue';
const level = (id, overrides = {}) => ({ id, name: `等级${id}`, grade: id, image: '/api/assets/42?sig=preview', color: '#345', one_brokerage: 10, two_brokerage: 5, status: 1, sum_task: 5, ...overrides });
const data = (overrides = {}) => ({ user: { uid: 11, nickname: 'Alice', avatar: '', brokerage_price: '42.50', agent_level: 1, spread_count: 2 }, level_list: [level(1), level(2)], level_info: level(1), current_grade: 1, next_level: level(2), ...overrides });
const task = (id, overrides = {}) => ({ id, level_id: 2, name: `任务${id}`, type: id, number: 5, desc: '任务说明', sort: id, status: 1, is_must: 9, finish: 0, task_type_title: '还需3人', speed: 40, new_number: 2, image: '', ...overrides });
const tasks = (levelId = 2, overrides = {}) => ({ list: Array.from({ length: 5 }, (_, i) => task(i + 1, { level_id: levelId })), speedAll: 40, ...overrides });
const api = r => r.load(path.join(__dirname, '../src/api/distributorLevels.ts'));
const rFor = send => { let r; r = runtime({ component, send: call => call.url.endsWith('/product/hot') ? { data: { owner_uid: r.auth.uid, page: call.data.page, limit: 10, list: [] } } : send(call) }); return r; };
const levelCalls = r => r.calls.filter(call => !call.url.endsWith('/product/hot'));
test('actual level page reads current owner, next level and all five enabled task metrics', async () => {
  const r = rFor(call => call.url.endsWith('/level_list') ? { data: data() } : { data: tasks(Number(call.data.id)) });
  try { await r.start(); assert.equal(r.checkout.snapshot.value.user.uid, 11); assert.equal(r.checkout.selectedId.value, 2); assert.equal(r.checkout.tasks.value.list.length, 5); assert.equal(r.checkout.finishedCount.value, 0); assert.equal(r.checkout.tasks.value.speedAll, 40); assert.deepEqual(levelCalls(r).map(call => call.url), ['/api/v2/agent/level_list', '/api/v2/agent/level_task_list']); r.checkout.selectLevel({ detail: { value: '0' } }); await tick(); assert.equal(r.checkout.selectedId.value, 1); assert.equal(r.checkout.tasks.value.list[0].level_id, 1); } finally { r.stop(); }
});
test('gifted hidden level remains visible; already granted tasks use server completion instead of client recomputation', async () => {
  const r = rFor(call => call.url.endsWith('/level_list') ? { data: data({ user: { ...data().user, agent_level: 7 }, level_info: level(7, { status: 0 }), current_grade: 7, next_level: null }) } : { data: tasks(Number(call.data.id), { list: [task(1, { level_id: Number(call.data.id), finish: 1, speed: 100, new_number: 5 })], speedAll: 100 }) });
  try { await r.start(); assert.equal(r.checkout.snapshot.value.level_info.id, 7); assert.equal(r.checkout.snapshot.value.current_grade, 7); assert.equal(r.checkout.finishedCount.value, 1); assert.equal(r.checkout.tasks.value.speedAll, 100); } finally { r.stop(); }
});
test('deleted granted configuration preserves rank and identifier with empty current projection', async () => {
  const r = rFor(call => call.url.endsWith('/level_list') ? { data: data({ user: { ...data().user, agent_level: 7 }, level_info: { sum_task: 0, finish_task: 0 }, current_grade: 7, next_level: null }) } : { data: tasks(Number(call.data.id)) });
  try { await r.start(); assert.equal(r.checkout.snapshot.value.level_info, null); assert.equal(r.checkout.snapshot.value.user.agent_level, 7); assert.equal(r.checkout.snapshot.value.current_grade, 7); } finally { r.stop(); }
});
test('disabled service uses legacy empty arrays and exposes no fabricated user or progress', async () => {
  const r = rFor(() => ({ data: [] }));
  try { await r.start(); assert.equal(r.checkout.snapshot.value.enabled, false); assert.equal(r.checkout.snapshot.value.user, null); assert.equal(r.checkout.tasks.value, null); assert.equal(levelCalls(r).length, 1); } finally { r.stop(); }
});
test('empty enabled task set is retained as no tasks without treating zero tasks as completed upgrade', async () => {
  const r = rFor(call => call.url.endsWith('/level_list') ? { data: data({ level_list: [level(1, { sum_task: 0 })], next_level: null }) } : { data: { list: [], speedAll: 0 } });
  try { await r.start(); assert.equal(r.checkout.tasks.value.list.length, 0); assert.equal(r.checkout.tasks.value.speedAll, 0); assert.equal(r.checkout.finishedCount.value, 0); } finally { r.stop(); }
});
test('invite and browse actions navigate to real registered pages without a client upgrade mutation', async () => {
  const r = rFor(call => call.url.endsWith('/level_list') ? { data: data() } : { data: tasks() });
  try { await r.start(); r.checkout.act(r.checkout.tasks.value.list[0]); r.checkout.act(r.checkout.tasks.value.list[1]); r.checkout.act(r.checkout.tasks.value.list[3]); assert.deepEqual(r.navigations, ['/pages/user/spread', '/pages/goods/list', '/pages/user/spread']); assert.equal(levelCalls(r).length, 2); assert.equal(api(r).distributionTaskAction(99), null); } finally { r.stop(); }
});
test('owner mismatch, foreign task parent, duplicate records and invalid progress are rejected', () => {
  const r = rFor(() => ({ data: [] }));
  try { const mod = api(r); assert.throws(() => mod.parseDistributionSnapshot(data(), 22)); assert.throws(() => mod.parseDistributionSnapshot(data({ level_list: [level(1), level(1)] }), 11)); assert.throws(() => mod.parseDistributionTasks(tasks(7), 2)); assert.throws(() => mod.parseDistributionTasks(tasks(2, { speedAll: 101 }), 2)); assert.throws(() => mod.parseDistributionTasks({ list: [task(1, { speed: NaN })], speedAll: 0 }, 2)); } finally { r.stop(); }
});
test('image previews and colors permit signed rendering while rejecting unsafe CSS and decoded address layers', () => {
  const r = rFor(() => ({ data: [] }));
  try { const mod = api(r); assert.equal(mod.distributionImage('/api/assets/42?sig=preview'), '/api/assets/42?sig=preview'); assert.equal(mod.distributionImage('https://cdn.test/My%20Card.png'), 'https://cdn.test/My%20Card.png'); for (const value of ['//evil.test/a', 'javascript:x', '/a/..//evil.test', '/a%255cb', 'https://u:p@cdn.test/a']) assert.equal(mod.distributionImage(value), ''); assert.equal(mod.distributionColor('rgba(1,2,3,0.5)'), 'rgba(1,2,3,0.5)'); assert.equal(mod.distributionColor('url(javascript:x)'), ''); } finally { r.stop(); }
});
test('same-owner failed refresh preserves last snapshot with an explicit error and freezes activity actions', async () => {
  let fail = false;
  const r = rFor(call => fail ? { transport: 'network down' } : call.url.endsWith('/level_list') ? { data: data() } : { data: tasks() });
  try { await r.start(); fail = true; await r.checkout.load(); assert.equal(r.checkout.snapshot.value.user.nickname, 'Alice'); assert.equal(r.checkout.tasks.value.list.length, 5); assert.match(r.checkout.error.value, /network down/); r.checkout.act(r.checkout.tasks.value.list[0]); assert.equal(r.navigations.length, 0); } finally { r.stop(); }
});
test('late level response cannot populate a switched account and logout clears all previous content', async () => {
  const old = deferred(); let reads = 0;
  const r = rFor(call => call.url.endsWith('/level_list') ? ++reads === 1 ? old.promise : { data: data({ user: { ...data().user, uid: 22, nickname: 'Bob' } }) } : { data: tasks() });
  try { await r.start(); r.auth.setLogin('second-owner', 22); await tick(); old.resolve({ data: data() }); await tick(); assert.equal(r.checkout.snapshot.value.user.uid, 22); assert.equal(r.checkout.snapshot.value.user.nickname, 'Bob'); r.auth.clear(); await tick(); assert.equal(r.checkout.snapshot.value, null); assert.equal(r.checkout.tasks.value, null); assert.equal(r.checkout.loading.value, false); } finally { r.stop(); }
});
test('late task response after hiding a page cannot overwrite its next visible load', async () => {
  const old = deferred(); let reads = 0;
  const r = rFor(call => call.url.endsWith('/level_list') ? { data: data() } : ++reads === 1 ? old.promise : { data: tasks(2, { list: [task(1, { name: '新进度', finish: 1, speed: 100 })], speedAll: 100 }) });
  try { await r.start(); assert.equal(r.checkout.taskLoading.value, true); r.hooks.onHide(); r.hooks.onShow(); await tick(); old.resolve({ data: tasks() }); await tick(); assert.equal(r.checkout.tasks.value.list[0].name, '新进度'); assert.equal(r.checkout.taskLoading.value, false); } finally { r.stop(); }
});
test('old route resolves to real level page and finance entry navigates there while member level stays separate', () => {
  const r = rFor(() => ({ data: [] }));
  try { const navigation = r.load(path.join(__dirname, '../src/config/navigation.ts')); assert.ok(navigation.REGISTERED_PAGE_ROUTES.has('/pages/users/user_distribution_level/index')); assert.equal(navigation.LEGACY_ROUTE_RULES['/pages/users/user_distribution_level/index'].target, '/pages/users/user_distribution_level/index'); const pages = JSON.parse(readFileSync(path.join(__dirname, '../src/pages.json'), 'utf8')); assert.ok(pages.pages.some(page => page.path === 'pages/users/user_distribution_level/index')); assert.ok(pages.pages.some(page => page.path === 'pages/user/level')); const finance = readFileSync(path.join(__dirname, '../src/pages/user/finance.vue'), 'utf8'); assert.match(finance, /@tap="openDistributionLevel"/); assert.match(finance, /navigateTo\(\{ url: '\/pages\/users\/user_distribution_level\/index' \}\)/); } finally { r.stop(); }
});
const product=(id,extra={})=>({id,store_name:'商品'+id,brand_name:'测试品牌',price:'12.30',is_vip:0,vip_price:'0.00',price_type:'',image_source:'https://images.example/'+id+'.png',image:'https://images.example/'+id+'.png',activity_frame:[],store_label:[],is_presale_product:0,activity:'0,1,2,3',recommendation_target:{version:1,product_id:id,kind:'product',id,ends_at:null},...extra});
const hotData=(owner,page,list)=>({owner_uid:owner,page,limit:10,list:list??Array.from({length:page===3?2:10},(_,i)=>product(page*10+i))});
const hotCalls=r=>r.calls.filter(c=>c.url.endsWith('/product/hot'));
async function integrated(options={}){let r;const traces=[];r=runtime({component,authenticated:options.authenticated??true,platform:options.platform,send:call=>{
 traces.push({url:call.url,method:call.method,data:call.data,token:call.header['Authori-zation']});
 const custom=options.send?.(call,r);if(custom!==undefined)return custom;
 if(call.url.endsWith('/level_list'))return{data:data({user:{...data().user,uid:r.auth.uid},...options.snapshot})};
 if(call.url.endsWith('/level_task_list'))return{data:tasks(Number(call.data.id))};
 assert.equal(call.url,'/api/product/hot');assert.deepEqual(call.data,{view:'member_level',page:call.data.page,limit:10});
 return{data:hotData(r.auth.uid,call.data.page,options.products?.(call.data.page))};
 }});await r.start();return Object.assign(r,{traces});}
test('actual distribution page enables an independent10/10/2 hot feed without shopping detection, overview or mutations',async()=>{
 const r=await integrated();try{const s=r.checkout.recommendations;assert.equal(s.items.length,10);await s.load(true);r.hooks.onReachBottom();await tick();assert.equal(s.items.length,22);assert.equal(s.page,3);assert.equal(s.hasMore,false);r.hooks.onReachBottom();await tick();assert.deepEqual(hotCalls(r).map(c=>c.data.page),[1,2,3]);assert.equal(levelCalls(r).length,2);assert.ok(r.traces.every(c=>c.method==='GET'&&!/level\/(?:info|detection)/u.test(c.url)));assert.deepEqual(r.modals,[]);}finally{r.stop();}
});
test('hot failure retries same next page and does not reread evaluator levels or task progress',async()=>{
 let fail=true;const r=await integrated({send:c=>c.data.page===2&&fail?{transport:'offline'}:undefined});try{const s=r.checkout.recommendations;await s.load(true);assert.equal(s.page,1);assert.equal(s.items.length,10);assert.match(s.error,/offline/);r.hooks.onReachBottom();await tick();fail=false;await s.retry();assert.equal(s.page,2);assert.deepEqual(hotCalls(r).map(c=>c.data.page),[1,2,2]);assert.equal(levelCalls(r).length,2);}finally{r.stop();}
});
test('recommendation duplicate page is rejected atomically, with refresh independent of selected task',async()=>{
 const r=await integrated({products:p=>p===2?[product(10)]:undefined});try{const s=r.checkout.recommendations;await s.load(true);assert.match(s.error,/分页已变化/);assert.equal(s.items.length,10);assert.equal(s.page,1);await s.refresh();assert.equal(s.error,'');assert.equal(r.checkout.selectedId.value,2);assert.equal(levelCalls(r).length,2);}finally{r.stop();}
});
test('level failure preserves same-owner task data and does not break an independently loaded feed',async()=>{
 let fail=false;const r=await integrated({send:c=>fail&&c.url.endsWith('/level_list')?{transport:'level offline'}:undefined});try{fail=true;await r.checkout.load();assert.match(r.checkout.error.value,/level offline/);assert.equal(r.checkout.tasks.value.list.length,5);await r.checkout.recommendations.load(true);assert.equal(r.checkout.recommendations.items.length,20);r.checkout.act(r.checkout.tasks.value.list[0]);assert.equal(r.navigations.length,0);}finally{r.stop();}
});
test('pending hot read does not block a selected-level task refresh',async()=>{
 const held=deferred();const r=await integrated({send:c=>c.url.endsWith('/product/hot')?held.promise:undefined});try{assert.equal(r.checkout.recommendations.loading,true);r.checkout.selectLevel({detail:{value:0}});await tick();assert.equal(r.checkout.tasks.value.list[0].level_id,1);assert.equal(r.checkout.taskLoading.value,false);held.resolve({data:hotData(11,1,[])});await tick();assert.equal(r.checkout.recommendations.loading,false);}finally{r.stop();}
});
for(const variant of ['guest','disabled'])test(variant+' never reads the hot feed or shopping member APIs',async()=>{
 const r=await integrated(variant==='guest'?{authenticated:false}:{send:c=>c.url.endsWith('/level_list')?{data:[]}:undefined});try{assert.equal(hotCalls(r).length,0);assert.equal(r.checkout.recommendations.items.length,0);if(variant==='guest')assert.equal(r.calls.length,0);}finally{r.stop();}
});
for(const event of ['onHide','onUnload','logout','owner','renew'])test('actual integrated page clears both owner projections and rejects late hot delivery after '+event,async()=>{
 const held=deferred();let first=true;const r=await integrated({send:c=>c.url.endsWith('/product/hot')&&first?(first=false,held.promise):undefined});try{
 if(event==='owner')r.auth.setLogin('other',22);else if(event==='renew')r.auth.setLogin(r.auth.token,11);else if(event==='logout')r.auth.clear();else r.hooks[event]();
 held.resolve({data:hotData(11,1,[product(999)])});await tick();assert.ok(!r.checkout.recommendations.items.some(p=>p.id===999));
 if(['onHide','onUnload','logout'].includes(event)){assert.equal(r.checkout.snapshot.value,null);assert.equal(r.checkout.tasks.value,null);assert.equal(r.checkout.recommendations.items.length,0);}
 if(event==='owner'){assert.equal(r.checkout.snapshot.value.user.uid,22);assert.equal(hotCalls(r).length,2);}
 }finally{r.stop();}
});
test('persisted storage drift during a real pending evaluator response switches owner before displaying data',async()=>{
 const held=deferred();let first=true;const r=await integrated({send:c=>c.url.endsWith('/level_list')&&first?(first=false,held.promise):undefined});try{
 r.storage.set('uni_token','other');r.storage.set('uni_uid',22);held.resolve({data:data()});await tick();assert.equal(r.auth.uid,22);assert.equal(r.checkout.snapshot.value.user.uid,22);assert.equal(r.checkout.recommendations.items[0].id,10);assert.equal(r.checkout.loading.value,false);
 }finally{r.stop();}
});
test('H5 focus reconciles persisted account drift and clears both projections without a confirmation',async()=>{
 const listeners=new Map(),previous=global.window;global.window={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
 const r=await integrated();try{r.storage.set('uni_token','other');r.storage.set('uni_uid',22);listeners.get('focus')();await tick();assert.equal(r.auth.uid,22);assert.equal(r.checkout.snapshot.value.user.uid,22);assert.equal(r.checkout.recommendations.items.length,10);assert.deepEqual(r.modals,[]);r.hooks.onHide();assert.equal(listeners.size,0);}finally{r.stop();global.window=previous;}
});
test('storage removal freezes actions and clears all private data when focus returns',async()=>{
 const listeners=new Map(),previous=global.window;global.window={addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:n=>listeners.delete(n)};const r=await integrated();try{const task=r.checkout.tasks.value.list[0];r.storage.clear();r.checkout.act(task);r.checkout.recommendations.openProduct(10);assert.equal(r.navigations.length,0);listeners.get('storage')();await tick();assert.equal(r.checkout.snapshot.value,null);assert.equal(r.checkout.recommendations.items.length,0);assert.equal(r.auth.isLoggedIn,false);}finally{r.stop();global.window=previous;}
});
test('exact local installer badge paths map to the bundled package while custom configured image stays authoritative',async()=>{
 const r=await integrated({snapshot:{level_list:[level(1),level(2,{image:'/uploads/system/agent_level_2.png'})],next_level:level(2,{image:'/uploads/system/agent_level_2.png'})}});try{assert.equal(r.checkout.badge.value.src,'/static/php-distribution-level/agent_level_2.png');r.checkout.badge.value.error();assert.equal(r.checkout.badge.value.src,'');assert.equal(levelCalls(r).length,2);await r.checkout.load();assert.equal(r.checkout.badge.value.src,'/static/php-distribution-level/agent_level_2.png');}finally{r.stop();}
});
for(const platform of ['H5','MP-WEIXIN','APP-PLUS'])test('signed badge and avatar map API origin with stale callback isolation on '+platform,async()=>{
 const src='/api/assets/41?expires='+String(Math.floor(Date.now()/1000)+3600)+'&signature='+'a'.repeat(43),r=await integrated({platform,snapshot:{user:{...data().user,avatar:src},level_list:[level(1),level(2,{image:src})],next_level:level(2,{image:src})}});try{
 const prefix=platform==='H5'?'':'https://cinashop-api.cinagroup.workers.dev';assert.equal(r.checkout.badge.value.src,prefix+src);assert.equal(r.checkout.avatar.value.src,prefix+src);const old=r.checkout.badge.value;await r.checkout.load();old.error();assert.equal(r.checkout.badge.value.src,prefix+src);r.checkout.badge.value.error();assert.equal(r.checkout.badge.value.src,'');assert.equal(r.checkout.avatar.value.src,'');assert.equal(levelCalls(r).length,4);
 }finally{r.stop();}
});
test('expired signature remains a placeholder with no automatic evaluation GET and custom unsigned asset never downgrades',async()=>{
 const src='/api/assets/41?expires=1000000000&signature='+'a'.repeat(43),r=await integrated({snapshot:{level_list:[level(1),level(2,{image:src})],next_level:level(2,{image:src})}});try{assert.equal(r.checkout.badge.value.src,'');assert.equal(r.checkout.mediaExpired.value,true);await tick();assert.equal(levelCalls(r).length,2);}finally{r.stop();}
 const u=await integrated({snapshot:{level_list:[level(1),level(2,{image:'/api/assets/41'})],next_level:level(2,{image:'/api/assets/41'})}});try{assert.equal(u.checkout.badge.value.src,'');assert.equal(u.checkout.mediaExpired.value,false);assert.equal(levelCalls(u).length,2);}finally{u.stop();}
});
test('ordinary and activity recommendation targets remain real navigation paths with no extra evaluator read',async()=>{
 const r=await integrated({products:()=>[product(10),product(11,{activity:'1,0,2,3',recommendation_target:{version:1,product_id:11,kind:'seckill',id:7001,ends_at:new Date(Date.now()+3600000).toISOString()}})]});try{r.checkout.recommendations.openProduct(10);assert.deepEqual(r.navigations,['/pages/goods/detail?id=10']);r.hooks.onHide();r.hooks.onShow();await tick();r.checkout.recommendations.openProduct(11);assert.equal(r.navigations.at(-1),'/pages/activity/seckillDetail?id=7001');assert.ok(r.traces.every(c=>c.method==='GET'));}finally{r.stop();}
});
test('page uses PHP-sized avatar/floating badge, two benefit columns, server task progress and recommendation title',()=>{
 const source=readFileSync(path.join(__dirname,'../src',component),'utf8'),{parse,compileTemplate}=require('@vue/compiler-sfc'),descriptor=parse(source).descriptor;
 const result=compileTemplate({id:'distribution-template',source:descriptor.template.content,filename:component});assert.deepEqual(result.errors,[]);
 for(const token of ['class="avatar"','class="level-badge"','class="level-grow-wrap"','class="section-bd"','task.speed','task.new_number','猜你喜欢'])assert.ok(source.includes(token),token);
 assert.ok(!source.includes('is_must'));assert.ok(!source.includes('background-image"'));const manifest=require('../src/static/php-distribution-level/provenance.json');assert.equal(manifest.assets.length,5);for(const row of manifest.assets){assert.equal(row.tracked_at_php_ref,false);const bytes=readFileSync(path.join(__dirname,'../../..',row.destination));assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),row.sha256);}
});
test('actual distributor media lease expires in place without re-evaluating GET and requires explicit reread',async()=>{
 const realTimeout=global.setTimeout,realNow=Date.now;let lease,leaseTimer;
 global.setTimeout=(fn,ms,...args)=>{const timer=realTimeout(fn,ms,...args);if(ms>100000&&ms<121000){lease=fn;leaseTimer=timer;}return timer;};
 const now=realNow(),expires=Math.floor(now/1000)+120,src='/api/assets/41?expires='+expires+'&signature='+'a'.repeat(43);
 let r;try{r=await integrated({snapshot:{level_list:[level(1),level(2,{image:src})],next_level:level(2,{image:src})}});assert.equal(typeof lease,'function');assert.equal(r.checkout.badge.value.src,src);const count=levelCalls(r).length;
  Date.now=()=>expires*1000+1;clearTimeout(leaseTimer);lease();await tick();assert.equal(r.checkout.badge.value.src,'');assert.equal(r.checkout.mediaExpired.value,true);assert.equal(levelCalls(r).length,count);
  Date.now=realNow;await r.checkout.load();assert.equal(r.checkout.badge.value.src,src);assert.equal(levelCalls(r).length,count+2);
 }finally{Date.now=realNow;global.setTimeout=realTimeout;clearTimeout(leaseTimer);r?.stop();}
});
