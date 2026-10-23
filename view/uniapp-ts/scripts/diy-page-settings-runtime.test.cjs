const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
const {runtime, tick, deferred} = require('./uni-store-runtime.cjs');
const root = path.resolve(__dirname, '../src'), epoch = 1792700000000;
const ticket = (at = epoch, id = 7) => `/api/assets/${id}?expires=${Math.floor(at / 1000) + 900}&signature=${'A'.repeat(43)}`;
const page = (extra = {}) => ({title: '原宿主标题', is_show: 1, is_bg_color: 1, color_picker: '#123456', is_bg_pic: 1, bg_pic: ticket(), bg_tab_val: 0, value: [], ...extra});
const version = call => call.url.includes('/diy_version/'), payload = call => call.url.includes('/get_diy/');
function setup(send, component = 'pages/diy/detail.vue', storage = new Map()) {
  const r = runtime({component, storage, send: send ?? (call => version(call) ? {data: {version: 'same'}} : payload(call) ? {data: page()} : {data: []})});
  const titles = []; r.uni.setNavigationBarTitle = value => titles.push(value.title);
  return {...r, titles, d: r.load(path.join(root, 'utils/diy.ts')), lease: r.load(path.join(root, 'utils/diyEditorialMediaLease.ts'))};
}
async function clock(fn) {
  const original = {now: Date.now, set: global.setTimeout, clear: global.clearTimeout};
  let now = epoch, sequence = 100000; const timers = new Map();
  Date.now = () => now;
  global.setTimeout = (callback, delay, ...args) => {
    if (Number(delay) < 60_000) return original.set(callback, delay, ...args);
    const id = ++sequence; timers.set(id, {at: now + Number(delay), fn: () => callback(...args)}); return id;
  };
  global.clearTimeout = id => { if (!timers.delete(id)) original.clear(id); };
  try { await fn({timers, advance: async delta => { now += delta; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await tick(); }, now: () => now}); }
  finally { Date.now = original.now; global.setTimeout = original.set; global.clearTimeout = original.clear; timers.clear(); }
}
for (const [mode, size, repeat] of [[0, '100%', 'no-repeat'], [1, '100%', 'repeat'], [2, '100% 100%', 'no-repeat']]) test(`actual row appearance matches PHP image mode ${mode}`, () => clock(async () => {
  const r = setup(); try { const input = page({bg_tab_val: mode}), before = JSON.stringify(input); assert.deepEqual(r.d.diyPageStyle(input), {backgroundColor: '#123456', backgroundImage: `url("${ticket()}")`, backgroundSize: size, backgroundRepeat: repeat}); assert.equal(JSON.stringify(input), before); assert.equal(r.d.diyPageStyle(page({bg_tab_val: String(mode)})).backgroundSize, size); } finally { r.stop(); }
}));
for (const [color, image] of [[0, 0], [0, 1], [1, 0], [1, 1]]) test(`independent row toggles ${color}/${image} retain their stored values`, () => clock(async () => {
  const r = setup(); try { const input = page({is_bg_color: color, is_bg_pic: image}), before = JSON.stringify(input), style = r.d.diyPageStyle(input); assert.equal(!!style.backgroundColor, !!color); assert.equal(!!style.backgroundImage, !!image); assert.equal(JSON.stringify(input), before); assert.deepEqual(r.d.diyPageStyle(input, false), {}); assert.deepEqual(r.d.diyPageStyle({...input, is_show: 0}), {}); } finally { r.stop(); }
}));
for (const bad of ['/api/assets/7', ticket(epoch - 900000), ticket() + '&expires=9999999999', 'javascript:alert(1)', '//foreign.test/a.png', '/static/a\\b.png']) test(`unsafe or unavailable row background is never painted ${bad.slice(0, 35)}`, () => clock(async () => {
  const r = setup(); try { assert.equal(r.d.diyPageStyle(page({bg_pic: bad})).backgroundImage, undefined); assert.equal(r.d.diyPageStyle(page({bg_pic: bad})).backgroundColor, '#123456'); } finally { r.stop(); }
}));
test('background-only pages enter the same bounded media lease without a component array', () => clock(async () => {
  const r = setup(); try { for (const value of [[], undefined, {}]) { const row = page({value}); assert.equal(r.lease.diyEditorialMediaDeadline(row, epoch), epoch + 840000); assert.equal(r.lease.diyEditorialMediaCacheUsable(row, epoch, epoch + 840000), false); } } finally { r.stop(); }
}));
test('only the enabled visible top-level bg_pic is a background capability slot', () => clock(async () => {
  const r = setup(); try { for (const row of [page({is_bg_pic: 0}), page({is_show: 0}), page({bg_pic: '/static/background.png'}), page({bg_pic: 'https://foreign.test/api/assets/7'})]) assert.equal(r.lease.diyEditorialMediaDeadline(row, 1), Infinity); const row = page({value: [{name: 'unknown', bg_pic: '/api/assets/99'}], cover_image: '/api/assets/8', content: '/api/assets/9'}); assert.equal(r.lease.diyEditorialMediaDeadline(row, epoch), epoch + 840000); row.bg_pic = '/api/assets/7'; assert.equal(r.lease.diyEditorialMediaDeadline(row, epoch), 0); } finally { r.stop(); }
}));
for (const stale of [false, true]) test(`actual equal-version cache ${stale ? 'renews expired' : 'reuses fresh'} background-only tickets`, () => clock(async () => {
  const stored = JSON.stringify({data: page({bg_pic: stale ? ticket(epoch - 900000) : ticket()}), version: 'same', cachedAt: epoch - 1000, versionVerified: true}), storage = new Map([['cinashop_diy_page_v1_2', stored]]), r = setup(undefined, undefined, storage);
  try { const result = await r.d.loadDiyPage(2); assert.equal(result.source, stale ? 'network' : 'cache'); assert.equal(r.calls.filter(payload).length, stale ? 1 : 0); assert.equal(result.data.bg_pic, ticket()); } finally { r.stop(); }
}));
test('expired background cannot be admitted offline or overwrite an already valid cache from an unsigned response', () => clock(async () => {
  const stored = data => JSON.stringify({data, version: 'old', cachedAt: epoch - 1000, versionVerified: true});
  const stale = setup(() => ({transport: 'offline'}), undefined, new Map([['cinashop_diy_page_v1_2', stored(page({bg_pic: ticket(epoch - 900000)}))]]));
  try { await assert.rejects(stale.d.loadDiyPage(2)); } finally { stale.stop(); }
  const original = stored(page()), r = setup(call => version(call) ? {data: {version: 'new'}} : {data: page({bg_pic: '/api/assets/7'})}, undefined, new Map([['cinashop_diy_page_v1_2', original]]));
  try { await assert.rejects(r.d.loadDiyPage(2), error => error.kind === 'invalid'); assert.equal(r.storage.get('cinashop_diy_page_v1_2'), original); } finally { r.stop(); }
}));
for (const component of ['pages/index/index.vue', 'pages/diy/detail.vue']) {
  const home = component.includes('/index/'), style = r => home ? r.checkout.diyStyle.value : r.checkout.pageStyle.value;
  test(`actual ${component} binds accepted appearance and revokes it on hide/show/unload`, () => clock(async () => {
    const r = setup(undefined, component); try { await r.start({id: '2'}); assert.equal(style(r).backgroundColor, '#123456'); assert.equal(style(r).backgroundSize, '100%'); assert.equal(r.checkout.diyHost.appearanceAvailable.value, true); r.hooks.onHide(); assert.deepEqual(style(r), {}); r.hooks.onShow(); await tick(); assert.equal(style(r).backgroundColor, '#123456'); r.hooks.onUnload(); assert.deepEqual(style(r), {}); assert.equal(r.checkout.diyHost.page.value, null); } finally { r.stop(); }
  }));
  test(`actual ${component} removes expired passive paint during a pending refresh without destroying the retained renderer`, () => clock(async ({advance, now}) => {
    let delay = false; const wait = deferred(), r = setup(call => delay && version(call) ? wait.promise : version(call) ? {data: {version: 'same'}} : payload(call) ? {data: page({bg_pic: ticket(now())})} : {data: []}, component);
    try { await r.start({id: '2'}); const accepted = r.checkout.diyHost.page.value; delay = true; const pending = r.checkout.diyHost.reload(true); await tick(); assert.equal(r.checkout.diyHost.page.value, accepted); assert.equal(style(r).backgroundColor, '#123456'); await advance(840000); assert.equal(r.checkout.diyHost.page.value, accepted); assert.equal(r.checkout.diyHost.refreshing.value, true); assert.equal(r.checkout.diyHost.appearanceAvailable.value, false); assert.deepEqual(style(r), {}); wait.resolve({data: {version: 'same'}}); await pending; await tick(); assert.equal(style(r).backgroundImage, `url("${ticket(now())}")`); assert.equal(r.checkout.diyHost.appearanceAvailable.value, true); } finally { wait.resolve({data: {version: 'same'}}); r.stop(); }
  }));
  for (const boundary of ['uid', 'session', 'closed']) test(`actual ${component} late appearance cannot cross ${boundary}`, () => clock(async () => {
    let delay = false; const wait = deferred(), r = setup(call => delay && version(call) ? wait.promise : version(call) ? {data: {version: 'same'}} : payload(call) ? {data: page()} : {data: []}, component);
    try { await r.start({id: '2'}); delay = true; const pending = r.checkout.diyHost.reload(true); await tick(); if (boundary === 'uid') r.auth.uid = 22; else if (boundary === 'session') r.auth.sessionVersion++; else r.d.closeDiyStation('已关闭'); assert.deepEqual(style(r), {}); if (boundary !== 'closed') r.hooks.onHide(); wait.resolve({data: {version: 'same'}}); await pending; await tick(); assert.deepEqual(style(r), {}); } finally { wait.resolve({data: {version: 'same'}}); r.stop(); }
  }));
  test(`actual ${component} new background acceptance revokes its former paint timer`, () => clock(async ({advance, timers, now}) => {
    let current = page(); const r = setup(call => version(call) ? {data: {version: 'same'}} : payload(call) ? {data: current} : {data: []}, component);
    try { await r.start({id: '2'}); const old = [...timers.values()]; await advance(300000); current = page({bg_pic: ticket(now(), 8), bg_tab_val: 2}); await r.checkout.diyHost.reload(true); assert.equal(style(r).backgroundSize, '100% 100%'); for (const timer of old) timer.fn(); await tick(); assert.equal(r.checkout.diyHost.appearanceAvailable.value, true); assert.equal(style(r).backgroundImage, `url("${ticket(now(), 8)}")`); } finally { r.stop(); }
  }));
}
test('standalone micro route replacement removes its former background before the next page arrives', () => clock(async () => {
  let delay = false; const wait = deferred(), r = setup(call => delay && version(call) ? wait.promise : version(call) ? {data: {version: 'same'}} : payload(call) ? {data: page()} : {data: []});
  try { await r.start({id: '2'}); delay = true; r.hooks.onLoad({id: '3'}); assert.deepEqual(r.checkout.pageStyle.value, {}); r.hooks.onHide(); wait.resolve({data: {version: 'same'}}); await tick(); assert.deepEqual(r.checkout.pageStyle.value, {}); } finally { wait.resolve({data: {version: 'same'}}); r.stop(); }
}));
test('both actual page surfaces use the installed Uni viewport offsets and remain width bounded', () => {
  for (const file of ['pages/index/index.vue', 'pages/diy/detail.vue']) { const source = fs.readFileSync(path.join(root, file), 'utf8'); const descriptor = require('@vue/compiler-sfc').parse(source).descriptor; const style = descriptor.styles.map(style => style.content).join('\n'); assert.match(style, /min-height:\s*calc\(100vh - var\(--window-top, 0px\) - var\(--window-bottom, 0px\)\)/); assert.match(style, /width: 100%/); }
});
