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
const rFor = send => runtime({ component, send });
test('actual level page reads current owner, next level and all five enabled task metrics', async () => {
  const r = rFor(call => call.url.endsWith('/level_list') ? { data: data() } : { data: tasks(Number(call.data.id)) });
  try { await r.start(); assert.equal(r.checkout.snapshot.value.user.uid, 11); assert.equal(r.checkout.selectedId.value, 2); assert.equal(r.checkout.tasks.value.list.length, 5); assert.equal(r.checkout.finishedCount.value, 0); assert.equal(r.checkout.tasks.value.speedAll, 40); assert.deepEqual(r.calls.map(call => call.url), ['/api/v2/agent/level_list', '/api/v2/agent/level_task_list']); r.checkout.selectLevel({ detail: { value: '0' } }); await tick(); assert.equal(r.checkout.selectedId.value, 1); assert.equal(r.checkout.tasks.value.list[0].level_id, 1); } finally { r.stop(); }
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
  try { await r.start(); assert.equal(r.checkout.snapshot.value.enabled, false); assert.equal(r.checkout.snapshot.value.user, null); assert.equal(r.checkout.tasks.value, null); assert.equal(r.calls.length, 1); } finally { r.stop(); }
});
test('empty enabled task set is retained as no tasks without treating zero tasks as completed upgrade', async () => {
  const r = rFor(call => call.url.endsWith('/level_list') ? { data: data({ level_list: [level(1, { sum_task: 0 })], next_level: null }) } : { data: { list: [], speedAll: 0 } });
  try { await r.start(); assert.equal(r.checkout.tasks.value.list.length, 0); assert.equal(r.checkout.tasks.value.speedAll, 0); assert.equal(r.checkout.finishedCount.value, 0); } finally { r.stop(); }
});
test('invite and browse actions navigate to real registered pages without a client upgrade mutation', async () => {
  const r = rFor(call => call.url.endsWith('/level_list') ? { data: data() } : { data: tasks() });
  try { await r.start(); r.checkout.act(r.checkout.tasks.value.list[0]); r.checkout.act(r.checkout.tasks.value.list[1]); r.checkout.act(r.checkout.tasks.value.list[3]); assert.deepEqual(r.navigations, ['/pages/user/spread', '/pages/goods/list', '/pages/user/spread']); assert.equal(r.calls.length, 2); assert.equal(api(r).distributionTaskAction(99), null); } finally { r.stop(); }
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
