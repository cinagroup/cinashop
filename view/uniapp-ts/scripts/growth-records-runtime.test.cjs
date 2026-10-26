const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
function row(i, extra = {}) {
  const month = i < 25 ? '2026-09' : i < 42 ? '2026-10' : i === 42 ? '2026-09' : i === 43 ? '1969-12' : '';
  return { id: 145 - i, title: '成长明细' + i, number: ['12.75','-2.25','9999999999.99','-9999999999.99','0.00'][i % 5], pm: i % 2,
    add_time: month ? month + (month === '1969-12' ? '-31 23:59:59' : '-01 00:00:00') : '', time_key: month, time: month, ...extra };
}
function page(rows, p = 1) { const list = rows.slice((p - 1) * 20, p * 20); return { list, count: rows.length, time: [...new Set(list.map(r => r.time_key))] }; }
async function start(options = {}) {
  const rows = options.rows ?? Array.from({ length: 45 }, (_, i) => row(i)), traces = [];
  const r = runtime({ feature: 'useGrowthRecords', component: options.component, authenticated: options.authenticated ?? true, send: call => {
    traces.push({ url: call.url, method: call.method, data: structuredClone(call.data) });
    assert.equal(call.url, '/api/user/level/expList'); assert.equal(call.method, 'GET');
    assert.deepEqual(Object.keys(call.data).sort(), ['limit','page']); assert.equal(call.data.limit, 20);
    const override = options.send?.(call); return override === undefined ? { data: page(rows, call.data.page) } : override;
  } });
  await r.start(); return { ...r, rows, traces };
}
test('three pages preserve exact decimals, ID order, unknown dates and first-seen month order across boundaries', async () => {
  const r = await start(), s = r.checkout;
  assert.deepEqual(s.groups.value.map(g => [g.month,g.list.length]), [['2026-09',20]]);
  await s.load(true); assert.deepEqual(s.groups.value.map(g => [g.month,g.list.length]), [['2026-09',25],['2026-10',15]]);
  await s.load(true); assert.deepEqual(s.groups.value.map(g => [g.month,g.list.length]), [['2026-09',26],['2026-10',17],['1969-12',1],['',1]]);
  assert.deepEqual(s.rows.value.map(v => v.id), r.rows.map(v => v.id)); assert.equal(s.rows.value[3].number, '-9999999999.99');
  assert.equal(s.rows.value[43].add_time, '1969-12-31 23:59:59'); assert.equal(s.rows.value[44].add_time, '');
  assert.equal(s.total.value,45); assert.equal(s.hasMore.value,false); await s.load(true);
  assert.deepEqual(r.traces.map(t=>t.data.page),[1,2,3]); assert.deepEqual(r.scrolls,[]); assert.deepEqual(r.modals,[]); r.stop();
});
test('append failure retains records and retries precisely the failed page', async () => {
  let fail=true; const r=await start({send:c=>c.data.page===2&&fail?{transport:'offline'}:undefined}),s=r.checkout;
  await s.load(true); assert.equal(s.rows.value.length,20); assert.match(s.error.value,/offline/);
  r.hooks.onReachBottom(); await tick(); assert.deepEqual(r.traces.map(c=>c.data.page),[1,2]);
  fail=false; s.retry(); await tick(); assert.deepEqual(r.traces.map(c=>c.data.page),[1,2,2]); assert.equal(s.rows.value.length,40); assert.deepEqual(r.scrolls,[]); r.stop();
});
test('refresh failure retains the proven snapshot and retry restarts page one', async () => {
  let fail=false; const r=await start({send:c=>fail?{transport:'offline'}:undefined}),s=r.checkout;
  await s.load(true); assert.deepEqual(r.scrolls,[]); fail=true; await s.load(); assert.deepEqual(r.scrolls,[{scrollTop:0,duration:0}]); assert.equal(s.rows.value.length,40); assert.equal(s.total.value,45); assert.ok(s.error.value);
  fail=false; s.retry(); await tick(); assert.equal(s.rows.value.length,20); assert.deepEqual(r.traces.map(c=>c.data.page),[1,2,1,1]); assert.deepEqual(r.scrolls,[{scrollTop:0,duration:0},{scrollTop:0,duration:0}]); r.stop();
});
test('refresh scrolls to top while already loading and before its actual page-one read; append and reentrant bottom do not scroll or duplicate',async()=>{
  const events=[],r=await start({send:c=>{events.push({kind:'read',page:c.data.page});}}),s=r.checkout;
  assert.deepEqual(r.scrolls,[]);await s.load(true);assert.deepEqual(r.scrolls,[]);assert.equal(s.rows.value.length,40);
  events.length=0;const nativeScroll=r.uni.pageScrollTo;
  r.uni.pageScrollTo=opts=>{assert.equal(s.loading.value,true);events.push({kind:'scroll',...opts});nativeScroll(opts);r.hooks.onReachBottom();};
  await s.load();assert.deepEqual(events,[{kind:'scroll',scrollTop:0,duration:0},{kind:'read',page:1}]);
  assert.deepEqual(r.scrolls,[{scrollTop:0,duration:0}]);assert.deepEqual(r.traces.map(c=>c.data.page),[1,2,1]);assert.equal(s.rows.value.length,20);r.stop();
});
test('initial failure retry and guarded guest/hidden/disposed reads never move the page',async()=>{
  let fail=true;const r=await start({send:()=>fail?{transport:'offline'}:undefined}),s=r.checkout;
  assert.equal(s.loaded.value,false);assert.deepEqual(r.scrolls,[]);fail=false;s.retry();await tick();assert.equal(s.rows.value.length,20);assert.deepEqual(r.scrolls,[]);
  const requests=r.traces.length;r.hooks.onHide();await s.load();assert.equal(r.traces.length,requests);assert.deepEqual(r.scrolls,[]);r.stop();await s.load();assert.deepEqual(r.scrolls,[]);
  const guest=await start({authenticated:false});await guest.checkout.load();assert.deepEqual(guest.scrolls,[]);assert.deepEqual(guest.traces,[]);guest.stop();
});
test('scroll and click share one in-flight append; successful final page stops further reads',async()=>{
  const d=deferred(),r=await start({send:c=>c.data.page===2?d.promise:undefined}),s=r.checkout;
  const pending=s.load(true); r.hooks.onReachBottom(); await s.load(true); assert.equal(r.traces.length,2);
  d.resolve({data:page(r.rows,2)}); await pending; await s.load(true); r.hooks.onReachBottom(); await tick();
  assert.equal(s.rows.value.length,45); assert.deepEqual(r.traces.map(c=>c.data.page),[1,2,3]); r.stop();
});
for(const event of ['onHide','onUnload','owner','renew','logout']) test('late response cannot repopulate after '+event,async()=>{
  const d=deferred(),r=await start({send:()=>d.promise}),s=r.checkout;
  if(event==='owner')r.auth.setLogin('other-token',22);else if(event==='renew')r.auth.setLogin(r.auth.token,r.auth.uid);else if(event==='logout')r.auth.clear();else r.hooks[event]();
  d.resolve({data:page(r.rows)});await tick(); assert.equal(s.loaded.value,false);assert.equal(s.loading.value,false);assert.equal(s.total.value,null);assert.deepEqual(s.rows.value,[]);assert.equal(s.error.value,'');
  assert.deepEqual(r.toasts,[]);assert.deepEqual(r.modals,[]);r.stop();
});
test('hide immediately clears loaded private records and show starts a fresh first page',async()=>{
  const r=await start(),s=r.checkout;await s.load(true);r.hooks.onHide();assert.deepEqual(s.rows.value,[]);assert.equal(s.total.value,null);
  r.hooks.onShow();await tick();assert.equal(s.rows.value.length,20);assert.deepEqual(r.traces.map(c=>c.data.page),[1,2,1]);assert.deepEqual(r.scrolls,[]);r.stop();
});
test('guest performs no private request or automatic navigation; explicit login only while visible',async()=>{
  const r=await start({authenticated:false}),s=r.checkout;assert.deepEqual(r.traces,[]);assert.deepEqual(r.navigations,[]);s.login();assert.deepEqual(r.navigations,['/pages/auth/login']);r.hooks.onHide();s.login();assert.equal(r.navigations.length,1);assert.deepEqual(r.scrolls,[]);r.stop();
});
test('successful empty differs from failed initial request',async()=>{
  const r=await start({rows:[]});assert.equal(r.checkout.loaded.value,true);assert.equal(r.checkout.total.value,0);assert.equal(r.checkout.hasMore.value,false);r.stop();
  const failed=await start({send:()=>({transport:'offline'})});assert.equal(failed.checkout.loaded.value,false);assert.equal(failed.checkout.total.value,null);assert.ok(failed.checkout.error.value);failed.stop();
});
for(const variant of ['overlap','count-change','partial','duplicate','ascending','plural-times','wrong-month','bad-date','numeric-amount','precision','missing-field'])test('invalid append rejects '+variant+' without advancing',async()=>{
  const rows=Array.from({length:45},(_,i)=>row(i)),r=await start({rows,send:c=>{
    if(c.data.page!==2)return;const data=structuredClone(page(rows,2));
    if(variant==='overlap')data.list[0].id=145;
    if(variant==='count-change')data.count++;
    if(variant==='partial')data.list.pop();
    if(variant==='duplicate')data.list[1].id=data.list[0].id;
    if(variant==='ascending')data.list.reverse();
    if(variant==='plural-times'){data.times=data.time;delete data.time;}
    if(variant==='wrong-month')data.time=['2026-01'];
    if(variant==='bad-date')data.list[0].add_time='2026-02-30 00:00:00';
    if(variant==='numeric-amount')data.list[0].number=12.75;
    if(variant==='precision')data.list[0].number='1.234';
    if(variant==='missing-field')delete data.list[0].title;
    return{data};
  }}),s=r.checkout;
  await s.load(true);assert.equal(s.rows.value.length,20);assert.ok(s.error.value);s.retry();await tick();assert.deepEqual(r.traces.map(c=>c.data.page),[1,2,2]);r.stop();
});
test('shared native deadline becomes a visible recoverable error without a modal',async()=>{
  const saved=global.setTimeout,timers=[];global.setTimeout=(fn,ms,...args)=>ms===12000?(timers.push(fn),{synthetic:true}):saved(fn,ms,...args);
  let r;try{r=await start({send:()=>new Promise(()=>{})});assert.equal(timers.length,1);timers[0]();await tick();assert.match(r.checkout.error.value,/超时/);assert.equal(r.checkout.loading.value,false);assert.deepEqual(r.modals,[]);}finally{r?.stop();global.setTimeout=saved;}
});
test('raw signed decimal strings never lose precision or receive doubled signs',async()=>{
  const r=await start({rows:[]}),api=r.load(path.resolve(__dirname,'../src/api/growthRecords.ts'));
  for(const [pm,number,expected]of [[1,'12.75','+12.75'],[0,'12.75','-12.75'],[1,'-2.25','-2.25'],[0,'-2.25','+2.25'],[1,'9999999999.99','+9999999999.99'],[0,'-9999999999.99','+9999999999.99'],[1,'0.00','+0.00'],[0,'0.00','-0.00'],[-1,'1.00','+1.00']])assert.equal(api.growthRecordAmount({pm,number}),expected);
  assert.equal(api.decodeGrowthRecords(page([row(43)])).list[0].add_time,'1969-12-31 23:59:59');r.stop();
});
test('page adapter rejects invalid page bounds before native dispatch',async()=>{
  const r=await start({rows:[]}),api=r.load(path.resolve(__dirname,'../src/api/growthRecords.ts')),scope=api.createGrowthRecordRequests(()=>true),before=r.traces.length;
  for(const p of [0,-1,1.5,1001,Number.NaN,Number.POSITIVE_INFINITY,Number.MAX_SAFE_INTEGER])await assert.rejects(scope.ledger(p));
  assert.equal(r.traces.length,before);scope.abort();r.stop();
});
test('actual SFC setup and template compile with PHP empty art and all recovery states',async()=>{
  const r=await start({component:'pages/user/growthRecords.vue'});assert.equal(r.checkout.s.rows.length,20);assert.equal(r.checkout.s.groups[0].month,'2026-09');r.stop();
  const {parse,compileTemplate}=require('@vue/compiler-sfc'),file=path.resolve(__dirname,'../src/pages/user/growthRecords.vue'),source=fs.readFileSync(file,'utf8'),descriptor=parse(source).descriptor;
  assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:file,id:'growth-ledger'}).errors,[]);
  for(const text of ['暂无经验记录~','日期未记录','时间未记录','没有更多了～','刷新成长值记录','s.retry','/static/php-points/noOrder.gif'])assert.ok(source.includes(text),text);
  assert.doesNotMatch(source,/as any|onMounted|parseFloat|Math\.trunc/);
});
