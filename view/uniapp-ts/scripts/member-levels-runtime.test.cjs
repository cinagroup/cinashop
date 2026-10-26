const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const overview = (n = 3, extra = {}) => ({ actor_uid: 11, enabled: true, level_active: true,
  preview_only: n === 0 ? false : false, current_level_id: n ? 101 : 0, current_grade: n ? 1 : null, exp: '42.75',
  levels: Array.from({ length: n }, (_, i) => ({ id: 101 + i, name: ['白银','黄金','铂金'][i] || '等级' + (i + 1), grade: i + 1,
    discount: '90.00', exp_num: i * 100, lack_exp_num: String(Math.max(0, Math.trunc(i * 100 - 42.75))), color: '#684314',
    icon: '', image: '', is_forever: 1 })), task: { sign_count: 7, sign: '10', order: '1.125', invite: '25', sign_enabled: true }, ...extra });
async function start(options = {}) {
  const traces = [];
  const r = runtime({ feature: 'useMemberLevels', authenticated: options.authenticated ?? true, component: options.component,
    send: c => { const trace = { path: c.url, method: c.method, data: structuredClone(c.data), auth: c.header['Authori-zation'] }; traces.push(trace);
      assert.equal(c.method, 'GET'); assert.ok(['/api/user/level/detection','/api/user/level/info'].includes(c.url));
      assert.deepEqual(c.data, c.url.endsWith('info') ? { overview: 1 } : {});
      const result = options.send?.(c); if (result !== undefined) return result;
      return { data: c.url.endsWith('detection') ? true : { overview: options.data ?? overview() } };
    } });
  await r.start(); return { ...r, traces };
}
const paths = r => r.traces.map(v => v.path.split('/').at(-1));
test('entry confirms detection before overview; manual refresh and return only read without replaying eligibility', async () => {
  const d = deferred(), r = await start({ send: c => c.url.endsWith('detection') ? d.promise : undefined }), s = r.checkout;
  assert.deepEqual(paths(r), ['detection']); assert.equal(s.checking.value, true); assert.equal(s.overview.value, null);
  d.resolve({ data: true }); await tick(); assert.deepEqual(paths(r), ['detection','info']); assert.equal(s.overview.value.exp, '42.75');
  assert.equal(s.selectedId.value, 101); s.select(103); await s.load(); assert.equal(s.selectedId.value, 103);
  r.hooks.onHide(); assert.equal(s.overview.value, null); assert.equal(s.selectedId.value, 0);
  r.hooks.onShow(); await tick(); assert.deepEqual(paths(r), ['detection','info','info','info']); assert.equal(s.selectedId.value, 101);
  assert.deepEqual(r.modals, []); r.stop();
});
test('uncertain detection continues an info read, never retries automatically, and offers an explicit serialized retry', async () => {
  let fail = true; const r = await start({ send: c => c.url.endsWith('detection') && fail ? { transport: 'lost response' } : undefined }), s = r.checkout;
  assert.deepEqual(paths(r), ['detection','info']); assert.match(s.checkNotice.value, /结果未确认/); assert.equal(s.error.value, '');
  await s.load(); r.hooks.onHide(); r.hooks.onShow(); await tick(); assert.deepEqual(paths(r), ['detection','info','info','info']); assert.match(s.checkNotice.value, /未确认/);
  fail = false; await s.recheck(); assert.deepEqual(paths(r), ['detection','info','info','info','detection','info']); assert.equal(s.checkNotice.value, ''); r.stop();
});
test('in-flight timeout is an unknown write outcome and permits the follow-up read without a modal', async () => {
  const saved = global.setTimeout, timers = []; global.setTimeout = (fn, ms, ...args) => ms === 12000 ? (timers.push(fn), { nativeDeadline: true }) : saved(fn, ms, ...args);
  let r; try { r = await start({ send: c => c.url.endsWith('detection') ? new Promise(() => {}) : undefined }); assert.equal(timers.length, 1); timers[0](); await tick();
    assert.deepEqual(paths(r), ['detection','info']); assert.match(r.checkout.checkNotice.value, /未确认/); assert.equal(r.checkout.overview.value.actor_uid, 11); assert.deepEqual(r.modals, []);
  } finally { r?.stop(); global.setTimeout = saved; }
});
for (const event of ['onHide','onUnload','logout','owner','renew']) test('late detection never chains old-owner info after ' + event, async () => {
  const d = deferred(), r = await start({ send: c => c.url.endsWith('detection') ? d.promise : undefined }), s = r.checkout;
  if (event === 'logout') r.auth.clear(); else if (event === 'owner') r.auth.setLogin('other', 22); else if (event === 'renew') r.auth.setLogin(r.auth.token, 11); else r.hooks[event]();
  assert.equal(s.overview.value, null); d.resolve({ data: true }); await tick();
  const oldInfo = r.traces.filter(t => t.path.endsWith('info') && t.auth === 'Bearer synthetic-local-token');
  assert.equal(oldInfo.length, event === 'renew' ? 1 : 0); // A new epoch may issue its own new detection/info.
  if (event === 'owner') { assert.equal(s.overview.value, null); assert.match(s.error.value, /不完整/); }
  assert.deepEqual(r.modals, []); r.stop();
});
test('hiding an unconfirmed request does not automatically replay it on return', async () => {
  const d = deferred(), r = await start({ send: c => c.url.endsWith('detection') ? d.promise : undefined });
  r.hooks.onHide(); r.hooks.onShow(); await tick(); assert.deepEqual(paths(r), ['detection','info']); assert.match(r.checkout.checkNotice.value, /未确认/);
  d.resolve({ data: true }); await tick(); assert.deepEqual(paths(r), ['detection','info']); r.stop();
});
test('synchronous owner changes clear loaded private state and load exactly one fresh complete auth tuple', async () => {
  const r = await start({ send: c => c.url.endsWith('info') ? { data: { overview: overview(1, { actor_uid: c.header['Authori-zation'] === 'Bearer other' ? 22 : 11 }) } } : undefined }), s = r.checkout;
  r.auth.setLogin('other', 22); assert.equal(s.overview.value, null); assert.equal(s.selectedId.value, 0); await tick();
  assert.deepEqual(paths(r), ['detection','info','detection','info']); assert.equal(s.overview.value.actor_uid, 22); assert.equal(r.traces[2].auth, 'Bearer other'); r.stop();
});
test('late info cannot restore private cards after logout', async () => {
  const d = deferred(), r = await start({ send: c => c.url.endsWith('info') ? d.promise : undefined }); r.auth.clear(); d.resolve({ data: { overview: overview() } }); await tick();
  assert.equal(r.checkout.overview.value, null); assert.equal(r.checkout.error.value, ''); assert.equal(r.checkout.loading.value, false); r.stop();
});
test('guest makes no request or automatic navigation; explicit login only while visible', async () => {
  const r = await start({ authenticated: false }), s = r.checkout; assert.deepEqual(paths(r), []); assert.deepEqual(r.navigations, []); await s.recheck(); await s.load();
  s.login(); r.hooks.onHide(); s.login(); s.openTask('order'); assert.deepEqual(r.navigations, ['/pages/auth/login']); assert.deepEqual(paths(r), []); r.stop();
});
for (const n of [0,1,5,6,12]) test('complete ' + n + '-level catalogue selects current ID, swipe and step without truncation', async () => {
  const r = await start({ data: overview(n) }), s = r.checkout; assert.equal(s.levels.value.length, n); assert.equal(s.selectedId.value, n ? 101 : 0);
  if (n) { s.swipe({ detail: { current: n - 1 } }); assert.equal(s.selectedId.value, 100 + n); assert.equal(s.selectedIndex.value, n - 1); s.select(101); assert.equal(s.selectedIndex.value, 0); s.select(999); s.swipe({ detail: { current: -1 } }); assert.equal(s.selectedId.value, 101); }
  r.stop();
});
test('preview and missing actual grant never claim a current membership', async () => {
  const data = overview(3, { level_active: false, current_level_id: 0, current_grade: null, preview_only: true }), r = await start({ data }), s = r.checkout;
  assert.equal(s.selectedId.value, 101); assert.deepEqual(s.levels.value.map(s.state), ['等级预览','等级预览','等级预览']); r.stop();
  const current = await start({ data: overview(3, { current_level_id: 102, current_grade: 2 }) }); assert.deepEqual(current.checkout.levels.value.map(current.checkout.state), ['已解锁','当前等级','待解锁']); current.stop();
});
test('refresh errors retain a proven same-owner snapshot and ID, successful catalogue removal resets selection', async () => {
  let failure = false, data = overview(); const r = await start({ send: c => c.url.endsWith('info') ? failure ? { transport: 'offline' } : { data: { overview: data } } : undefined }), s = r.checkout;
  s.select(103); failure = true; await s.load(); assert.equal(s.selectedId.value, 103); assert.equal(s.levels.value.length, 3); assert.match(s.error.value, /offline/);
  failure = false; data = overview(1); await s.load(); assert.equal(s.selectedId.value, 101); assert.equal(s.error.value, ''); r.stop();
});
test('tasks navigate to actual sign/category/spread pages using their correct native action and never award anything', async () => {
  const r = await start(), native = []; r.uni.navigateTo = o => native.push(['navigateTo', o.url]); r.uni.switchTab = o => native.push(['switchTab', o.url]);
  for (const key of ['sign','order','invite']) r.checkout.openTask(key);
  assert.deepEqual(native, [['navigateTo','/pages/user/sign'],['switchTab','/pages/goods/cate'],['navigateTo','/pages/user/spread']]); assert.deepEqual(paths(r), ['detection','info']);
  r.checkout.overview.value.task.sign_enabled = false; r.checkout.openTask('sign'); r.hooks.onHide(); r.checkout.openTask('order'); assert.equal(native.length, 3); r.stop();
});
test('disabled feature preserves own exp while exposing neither cards nor executable tasks', async () => {
  const data = overview(0, { enabled: false, task: { sign_count: 0, sign: '', order: '', invite: '', sign_enabled: false } }), r = await start({ data });
  assert.equal(r.checkout.overview.value.exp, '42.75'); r.checkout.openTask('order'); assert.deepEqual(r.navigations, []); r.stop();
});
test('PHP scale-zero gap produces43 percent, exact discount rendering and bounded zero/negative thresholds', async () => {
  const r = await start(), api = r.load(path.resolve(__dirname,'../src/api/memberLevels.ts')), l = overview().levels[1];
  assert.equal(api.memberLevelProgress(l), 43); assert.equal(api.memberLevelProgress({ ...l, exp_num: 0, lack_exp_num: '0' }), 100);
  assert.equal(api.memberLevelProgress({ ...l, exp_num: 0, lack_exp_num: '42' }), 0); assert.equal(api.memberLevelProgress({ ...l, exp_num: -1, lack_exp_num: '1' }), 0);
  for (const [discount, expected] of [['100.00','10'],['90.00','9'],['99.99','9.999'],['0.00','0'],['80.50','8.05']]) assert.equal(api.memberLevelDiscount({ discount }), expected);
  r.stop();
});
for (const variant of ['owner','id-zero','duplicate','unsorted','current-grade','fake-current','false-preview','missing-field','numeric-exp','precision','negative-gap','task-count','task-array','over-capacity']) test('strict opted overview rejects ' + variant, async () => {
  const data = overview();
  if (variant === 'owner') data.actor_uid = 22;
  if (variant === 'id-zero') data.levels[0].id = 0;
  if (variant === 'duplicate') data.levels[1].id = data.levels[0].id;
  if (variant === 'unsorted') data.levels.reverse();
  if (variant === 'current-grade') data.current_grade = 3;
  if (variant === 'fake-current') data.level_active = false;
  if (variant === 'false-preview') data.preview_only = true;
  if (variant === 'missing-field') delete data.task.invite;
  if (variant === 'numeric-exp') data.exp = 42.75;
  if (variant === 'precision') data.exp = '42.755';
  if (variant === 'negative-gap') data.levels[0].lack_exp_num = '-1';
  if (variant === 'task-count') data.task.sign_count = -1;
  if (variant === 'task-array') data.task = [];
  if (variant === 'over-capacity') data.levels = Array.from({length:1001},(_,i)=>({...data.levels[0],id:i+1,grade:i}));
  const r = await start({ data }); assert.equal(r.checkout.overview.value, null); assert.match(r.checkout.error.value, /不完整/); assert.deepEqual(paths(r), ['detection','info']); r.stop();
});
test('server-resolved images remain image sources and hostile URLs/colors fall back without CSS execution', async () => {
  const r = await start(), api = r.load(path.resolve(__dirname,'../src/api/memberLevels.ts'));
  for (const bad of ['javascript:alert(1)','data:image/svg+xml,x','//evil.invalid/a.png','https://u:p@a.invalid/a.png','/\\evil/a.png','/%2f%2fevil/a.png','https://a.invalid/a\nb.png','/%25252f%25252fevil']) assert.equal(api.memberLevelImage(bad), '', bad);
  for (const good of ['/static/php-level/userVip1.png','https://a.invalid/a.png','/api/assets/1?expires=123&signature=a']) assert.equal(api.memberLevelImage(good), good);
  for (const bad of ['red;position:fixed','url(https://evil)','rgb(999,1,1)','rgba(1,2,3,9)','rgb(1,2,3,.5)']) assert.equal(api.memberLevelColor(bad), '');
  for (const good of ['#abc','#123456','rgb(1,2,255)','rgba(1,2,3,0.5)']) assert.equal(api.memberLevelColor(good), good);
  const data = overview(); data.levels[0].icon = '//evil'; data.levels[0].color = 'url(x)'; assert.equal(api.decodeMemberOverview({ overview:data },11).levels[0].icon,''); assert.equal(api.decodeMemberOverview({ overview:data },11).levels[0].color,''); r.stop();
});
test('canonical signed media renews only info before expiry, preserves selected card and isolates a failed slot', async () => {
  const saved = global.setTimeout, timers = [], now = Date.now(), expires = Math.floor(now/1000) + 3600;
  global.setTimeout = (fn, ms, ...args) => ms > 12000 ? (timers.push({ fn, ms }), { mediaDeadline:true }) : saved(fn, ms, ...args);
  let r; try { const data = overview(); data.levels[0].icon = '/api/assets/25?expires=' + expires + '&signature=' + 'a'.repeat(43);
    r = await start({ data }); const s = r.checkout; assert.equal(timers.length,1); assert.ok(timers[0].ms > 3500000); s.select(103); timers[0].fn(); await tick();
    assert.deepEqual(paths(r), ['detection','info','info']); assert.equal(s.selectedId.value,103); assert.equal(s.mediaUnavailable.value,false); s.imageFailed(101,'icon'); assert.equal(s.image(s.levels.value[0],'icon'),'');
    r.hooks.onHide(); timers.at(-1).fn(); await tick(); assert.deepEqual(paths(r),['detection','info','info']);
  } finally { r?.stop(); global.setTimeout = saved; }
});
test('expired or malformed tickets do not create an infinite refresh loop', async () => {
  const data = overview(); data.levels[0].image='/api/assets/1?expires=1&signature='+'a'.repeat(43); const r=await start({data});
  assert.equal(r.checkout.mediaUnavailable.value,true); assert.equal(r.checkout.image(r.checkout.levels.value[0],'image'),''); assert.deepEqual(paths(r),['detection','info']);
  const api=r.load(path.resolve(__dirname,'../src/api/memberLevels.ts')); assert.equal(api.memberLevelMediaDeadline({...data,levels:[{...data.levels[0],image:'/api/assets/1?expires=1&expires=2&signature=x'}]},1234),1234);r.stop();
});
test('actual page setup compiles with its real lifecycle, original art, one growth navigator and explicit preview states',async()=>{
  const r=await start({component:'pages/user/level.vue'});assert.equal(r.checkout.s.levels.length,3);assert.equal(r.checkout.s.selectedId,101);r.stop();
  const {parse,compileTemplate}=require('@vue/compiler-sfc'),file=path.resolve(__dirname,'../src/pages/user/level.vue'),source=fs.readFileSync(file,'utf8'),descriptor=parse(source).descriptor;
  assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:file,id:'member-level'}).errors,[]);
  assert.equal((source.match(/url="\/pages\/user\/growthRecords"/g)||[]).length,1);
  for(const text of ['会员特权','快速升级技巧','等级预览','scroll-into-view','/static/php-level/user-vip-qd.png','s.swipe','s.recheck'])assert.ok(source.includes(text),text);
  assert.doesNotMatch(source,/as any|onMounted|\ud83d\udd12|user\/level\/activate/);
  const manifest=JSON.parse(fs.readFileSync(path.resolve(__dirname,'fixtures/level-overview-original-assets-20261026.json'),'utf8'));
  const {createHash}=require('node:crypto');for(const a of manifest.assets){const bytes=fs.readFileSync(path.resolve(__dirname,'../../..',a.target));assert.equal(bytes.length,a.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),a.sha256);}
});

test('a failed manual refresh reinstalls retained image expiry; an automatic failure at that deadline hides old tickets without a loop',async()=>{
  const nativeTimeout=global.setTimeout,nativeNow=Date.now,timers=[];let now=nativeNow(),fail=false,r;const expires=Math.floor(now/1000)+3600;
  Date.now=()=>now;global.setTimeout=(fn,ms,...args)=>ms>12000?(timers.push({fn,ms}),{mediaDeadline:true}):nativeTimeout(fn,ms,...args);
  try{const data=overview();data.levels[0].icon='/api/assets/25?expires='+expires+'&signature='+'a'.repeat(43);
    r=await start({data,send:c=>fail&&c.url.endsWith('info')?{transport:'offline'}:undefined});const s=r.checkout;assert.equal(timers.length,1);
    fail=true;await s.load();assert.equal(timers.length,2);assert.equal(s.mediaUnavailable.value,false);assert.match(s.error.value,/offline/);
    now=expires*1000+1;timers[1].fn();await tick();assert.equal(s.mediaUnavailable.value,true);assert.equal(s.image(s.levels.value[0],'icon'),'');
    assert.deepEqual(paths(r),['detection','info','info','info']);assert.equal(timers.length,2);assert.equal(s.levels.value.length,3);
  }finally{r?.stop();global.setTimeout=nativeTimeout;Date.now=nativeNow;}
});
test('a manual refresh that fails across expiry immediately suppresses the retained signed image',async()=>{
  const nativeTimeout=global.setTimeout,nativeNow=Date.now,timers=[],d=deferred();let now=nativeNow(),fail=false,r;const expires=Math.floor(now/1000)+3600;
  Date.now=()=>now;global.setTimeout=(fn,ms,...args)=>ms>12000?(timers.push({fn,ms}),{mediaDeadline:true}):nativeTimeout(fn,ms,...args);
  try{const data=overview();data.levels[0].image='/api/assets/26?expires='+expires+'&signature='+'b'.repeat(43);
    r=await start({data,send:c=>fail&&c.url.endsWith('info')?d.promise:undefined});fail=true;const pending=r.checkout.load();await tick();
    now=expires*1000+1000;d.resolve({transport:'offline'});await pending;
    assert.equal(r.checkout.mediaUnavailable.value,true);assert.equal(r.checkout.image(r.checkout.levels.value[0],'image'),'');assert.equal(timers.length,1);
    assert.deepEqual(paths(r),['detection','info','info']);assert.equal(r.checkout.selectedId.value,101);
  }finally{r?.stop();global.setTimeout=nativeTimeout;Date.now=nativeNow;}
});
