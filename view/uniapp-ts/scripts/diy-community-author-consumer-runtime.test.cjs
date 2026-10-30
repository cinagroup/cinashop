const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vue = require('vue');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const root = path.resolve(__dirname, '..'), widget = 'components/diy/DiyCommunityWidget.vue', cardFile = path.join(root, 'src/components/diy/DiyCommunityCard.vue');
const origin = Date.UTC(2026, 9, 25, 3), signature = 'C'.repeat(43);
const asset = (id = 7, expiry = origin + 900000) => `/api/assets/${id}?expires=${Math.floor(expiry / 1000)}&signature=${signature}`;
const block = (extra = {}) => ({ name: 'community', timestamp: 101, numberConfig: { val: 8 }, styleConfig: { tabVal: 0 }, titleConfig: { tabVal: 0 }, imgConfig: { url: '/static/images/diy/community.png' }, ...extra });
const post = (id = 1, extra = {}) => ({ id, type: 0, relationId: 0, contentType: 1, title: `真实帖子${id}`, content: '正文', image: `/static/post${id}.png`, sliderImage: [`/static/post${id}.png`], author: '平台', author_image: '/static/author.png', likeNum: 7, commentNum: 0, playNum: 0, shareNum: 0, isLike: 0, status: 1, is_verify: 1, addTime: 100, ...extra });
const config = { community_status: 1, community_comment_status: 1, community_comment_add: 1 };
const response = call => ({ data: call.url.endsWith('/config') ? config : Array.from({ length: call.data.limit }, (_, index) => post(index + 1)) });
function setup({ platform = 'H5', value = block(), active = true, send = response } = {}) {
  const props = vue.reactive({ block: value, active }), r = runtime({ component: widget, props, send, platform });
  return { ...r, props, c: r.checkout.controller };
}
async function clocked(work) {
  const previous = Date.now, previousWindow = global.window; let now = origin;
  Date.now = () => now; global.window = { location: { origin: 'https://owned-community.example', hostname: 'owned-community.example', search: '' } };
  try { await work(value => { now = value; }); } finally { Date.now = previous; if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
}
const lists = r => r.calls.filter(call => call.url.endsWith('/community/list'));

for (const platform of ['H5', 'APP-PLUS', 'MP-WEIXIN']) test(`${platform} precise PHP styles keep italic normal, direct image corners and fixed white columns`, () => clocked(async () => {
  const r = setup({ platform, active: false });
  try {
    const n = r.load(path.join(root, 'src/utils/diyCommunity.ts')).normalizeDiyCommunity;
    const source = block({ titleText: { tabVal: 2 }, titleNumber: { val: 19 }, filletImg: { type: 1, valList: [1, 2, 3, 4].map(val => ({ val })) }, fillet: { type: 1, valList: [1, 2, 3, 4].map(val => ({ val })) }, moduleColor: { color: [{ item: '#123456' }, { item: '#654321' }] }, videoSpace: { val: 99 }, videoSpace2: { val: 13 } });
    const horizontal = n(source), columns = n({ ...source, styleConfig: { tabVal: 1 } });
    assert.equal(horizontal.titleStyle.fontWeight, 'normal'); assert.equal(horizontal.titleStyle.fontStyle, 'italic');
    assert.equal(horizontal.titleStyle.fontSize, '38rpx'); assert.equal(horizontal.imageStyle.borderRadius, '2rpx 4rpx 6rpx 8rpx');
    assert.equal(horizontal.panelStyle.borderRadius, '2rpx 4rpx 8rpx 6rpx');
    assert.match(horizontal.listStyle.background, /#123456.*#654321/); assert.equal(horizontal.listStyle.gap, '26rpx'); assert.equal(horizontal.listStyle.paddingRight, '26rpx');
    assert.deepEqual(columns.listStyle, { background: '#ffffff', columnGap: '20rpx' });
    assert.equal(columns.imageStyle.borderRadius, '16rpx 16rpx 0 0');
    assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
}));

for (const platform of ['H5', 'APP-PLUS', 'MP-WEIXIN']) test(`${platform} expired unsigned malformed or duplicate header tickets forbid feed and media authority`, () => clocked(async () => {
  for (const source of ['/api/assets/7', asset(7, origin), asset(7, origin + 60000), asset() + '&expires=1', asset() + '&%73ignature=' + signature, asset().replace('signature=' + signature, 'signature=x')]) {
    const r = setup({ platform, value: block({ imgConfig: { url: source } }) });
    try {
      await tick(); assert.equal(r.c.ready(), false); assert.deepEqual(r.calls, []); assert.equal(r.c.media('/static/post.png'), '');
      r.c.openMore(); r.c.openPost(post()); assert.deepEqual(r.navigations, []);
    } finally { r.stop(); }
  }
}));

for (const platform of ['H5', 'APP-PLUS', 'MP-WEIXIN']) test(`${platform} renewed header tickets keep semantic intent and loaded feed while retiring old native callbacks`, () => clocked(async () => {
  const r = setup({ platform, value: block({ imgConfig: { url: asset() } }) });
  try {
    await tick(); const fingerprint = r.c.fingerprint.value, rows = r.c.rows.value, before = r.calls.length, old = r.checkout.header.value;
    assert.equal(r.c.ready(), true); assert.equal(lists(r).length, 1); assert.equal(old.current(), true);
    r.props.block = { ...r.props.block, imgConfig: { url: asset(7, origin + 1800000) } };
    await tick(); assert.equal(r.c.fingerprint.value, fingerprint); assert.strictEqual(r.c.rows.value, rows); assert.equal(r.calls.length, before);
    assert.equal(old.current(), false); old.failed(); assert.equal(r.checkout.headerFailed.value, false); old.more(); assert.deepEqual(r.navigations, []);
    r.checkout.header.value.failed(); assert.equal(r.checkout.headerFailed.value, true);
    r.checkout.header.value.loaded(); assert.equal(r.checkout.headerFailed.value, false);
    r.checkout.header.value.more(); assert.deepEqual(r.navigations, ['/pages/discover/index']);
  } finally { r.stop(); }
}));

test('ticket renewal during an in-flight feed admits the unchanged public response without a second list read', () => clocked(async () => {
  const pending = deferred(), r = setup({ value: block({ imgConfig: { url: asset() } }), send: call => call.url.endsWith('/community/list') ? pending.promise : response(call) });
  try {
    await tick(); assert.equal(lists(r).length, 1);
    r.props.block.imgConfig.url = asset(7, origin + 1800000); await tick(); assert.equal(lists(r).length, 1);
    pending.resolve({ data: [post()] }); await tick(); assert.equal(r.c.rows.value.length, 1); assert.equal(r.c.loading.value, false); assert.equal(lists(r).length, 1);
  } finally { pending.resolve({ data: [] }); r.stop(); }
}));

test('at the exact reserved deadline header render inputs media access taps and native leases expire together', () => clocked(async setNow => {
  const r = setup({ value: block({ imgConfig: { url: asset() } }) });
  try {
    await tick(); const old = r.checkout.header.value, before = r.calls.length;
    setNow(origin + 839999); assert.equal(old.current(), true);
    setNow(origin + 840000); assert.equal(r.c.ready(), false); assert.equal(old.current(), false); assert.equal(r.c.media(asset()), '');
    old.more(); old.failed(); assert.deepEqual(r.navigations, []); assert.equal(r.checkout.headerFailed.value, false);
    r.props.block.imgConfig.url = asset(7, origin + 1800000); await tick();
    assert.equal(r.c.ready(), true); assert.equal(r.calls.length, before); assert.equal(r.c.rows.value.length, 8); assert.equal(old.current(), false);
  } finally { r.stop(); }
}));

test('a native Mini Program with no window or URL global still uses the exact header lease safely', () => clocked(async () => {
  const oldWindow = global.window, oldURL = global.URL; global.window = undefined; global.URL = undefined;
  const r = setup({ platform: 'MP-WEIXIN', value: block({ imgConfig: { url: asset() } }) });
  try { await tick(); assert.equal(r.c.ready(), true); assert.equal(r.c.rows.value.length, 8); }
  finally { r.stop(); global.window = oldWindow; global.URL = oldURL; }
}));

for (const boundary of ['owner', 'token', 'session', 'config', 'hide', 'disabled', 'availability', 'dispose']) test(`captured header and post native leases cannot revive after ${boundary}`, () => clocked(async () => {
  const r = setup();
  try {
    await tick(); const old = r.checkout.header.value, slot = r.checkout.slots.value[0], capture = slot.allowed;
    assert.equal(capture(), true);
    if (boundary === 'owner') r.auth.setLogin('owner2', 22);
    else if (boundary === 'token') r.auth.setLogin('token2', 11);
    else if (boundary === 'session') r.auth.setLogin(r.auth.token, r.auth.uid);
    else if (boundary === 'config') r.props.block = block({ titleTxtConfig: { value: 'new title' } });
    else if (boundary === 'hide') r.props.active = false;
    else if (boundary === 'disabled') r.props.block.isHide = true;
    else if (boundary === 'availability') r.c.availability.close('社区暂未开放');
    else r.c.dispose();
    await tick(); assert.equal(capture(), false); assert.equal(old.current(), false);
    old.more(); old.failed(); assert.deepEqual(r.navigations, []); assert.equal(r.checkout.headerFailed.value, false);
  } finally { r.stop(); }
}));

test('dormant topic metadata and column-unused style values neither change public read scope nor refetch feed', () => clocked(async () => {
  const r = setup({ value: block({ styleConfig: { tabVal: 1 }, selectConfig: { activeValue: '9' }, videoSpace: { val: 20 }, videoSpace2: { val: 10 }, toneConfig: { tabVal: 0 } }) });
  try {
    await tick(); const fingerprint = r.c.fingerprint.value, before = r.calls.length;
    r.props.block.selectConfig.activeValue = 12; r.props.block.videoSpace.val = 99; r.props.block.videoSpace2.val = 55; r.props.block.toneConfig.tabVal = 1;
    await tick(); assert.equal(r.c.fingerprint.value, fingerprint); assert.equal(r.calls.length, before);
    assert.deepEqual(lists(r)[0].data, { page: 1, limit: 8, is_follow: 0 });
  } finally { r.stop(); }
}));

test('measured two-column flow preserves the entire PHP tail and changes only its shorter-column placement', () => clocked(async () => {
  for (const count of [1, 2, 3, 7, 8, 9, 100]) {
    const r = setup({ value: block({ styleConfig: { tabVal: 1 }, numberConfig: { val: count } }) });
    try {
      await tick(); const original = JSON.stringify(r.c.rows.value), current = r.c.lease();
      r.c.adoptMeasurement({ id: 1, height: 1000, current });
      for (const row of r.c.rows.value.slice(1)) r.c.adoptMeasurement({ id: row.id, height: 10, current });
      const columns = r.c.columns.value.map(column => column.map(row => row.id)), flattened = columns.flat();
      assert.equal(flattened.length, count); assert.equal(new Set(flattened).size, count); assert.deepEqual([...flattened].sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i + 1));
      assert.equal(JSON.stringify(r.c.rows.value), original);
      if (count === 3) assert.deepEqual(columns, [[1, 3], [2]]);
      if (count === 7) assert.deepEqual(columns, [[1, 3, 5, 7], [2, 4, 6]]);
      if (count === 8) assert.deepEqual(columns, [[1, 3, 5, 7], [2, 4, 6, 8]]);
      if (count === 9) assert.deepEqual(columns, [[1, 3, 5, 7], [2, 4, 6, 8, 9]]);
      assert.equal(r.calls.length, 2);
    } finally { r.stop(); }
  }
}));

test('foreign stale or invalid native measurements cannot modify the active column map', () => clocked(async () => {
  const r = setup({ value: block({ styleConfig: { tabVal: 1 } }) });
  try {
    await tick(); const current = r.c.lease();
    for (const row of [{ id: 999, height: 9 }, { id: 1, height: NaN }, { id: 1, height: 0 }, { id: 1, height: 1000001 }]) r.c.adoptMeasurement({ ...row, current });
    assert.equal(r.c.heights.value.size, 0);
    r.c.adoptMeasurement({ id: 1, height: 100, current }); assert.equal(r.c.heights.value.get(1), 100);
    r.props.active = false; r.c.adoptMeasurement({ id: 1, height: 900, current }); assert.equal(r.c.heights.value.size, 0);
  } finally { r.stop(); }
}));

function compileTemplate(file) {
  const sfc = require('@vue/compiler-sfc'), compiler = require('@vue/compiler-dom'), descriptor = sfc.parse(fs.readFileSync(file, 'utf8'), { filename: file }).descriptor;
  return new Function('Vue', compiler.compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, bindingMetadata: sfc.compileScript(descriptor, { id: 'community-author-parity' }).bindings,
    isCustomElement: tag => ['view', 'text', 'image', 'button', 'scroll-view'].includes(tag) }).code)(vue);
}
async function markup(r) {
  const file = path.join(root, 'src', widget), actual = r.load(file).default;
  r.load(cardFile).default.render = compileTemplate(cardFile);
  const app = vue.createSSRApp({ props: actual.props, render: compileTemplate(file), setup: () => r.checkout }, { ...r.props });
  app.use(require('pinia').getActivePinia()); return require('@vue/server-renderer').renderToString(app);
}

for (const layout of ['horizontal', 'columns']) test(`actual ${layout} templates keep PHP display branches and every returned public post`, () => clocked(async () => {
  const r = setup({ value: block({ styleConfig: { tabVal: layout === 'columns' ? 1 : 0 }, numberConfig: { val: 3 } }), send: call => ({ data: call.url.endsWith('/config') ? config : [post(1, { isLike: 1 }), post(2), post(3)] }) });
  try {
    await tick(); const html = await markup(r);
    for (const id of [1, 2, 3]) assert.match(html, new RegExp(`data-post-id="${id}"`));
    if (layout === 'horizontal') { assert.doesNotMatch(html, /class="diy-community-likes|class="diy-community-media-type|class="diy-community-player/); assert.doesNotMatch(html, /class="diy-community-column"/); }
    else { assert.match(html, /class="diy-community-likes/); assert.equal(html.includes('♥ 7'), true); assert.equal(html.includes('♡ 7'), true); assert.match(html, /column-gap:20rpx/); assert.match(html, /border-radius:16rpx 16rpx 0 0/); assert.equal((html.match(/class="diy-community-column"/g) || []).length, 2); }
  } finally { r.stop(); }
}));

test('actual expired-header template contains neither managed images post cards nor active More button', () => clocked(async () => {
  const r = setup({ value: block({ imgConfig: { url: asset(7, origin - 1) } }) });
  try { await tick(); const html = await markup(r); assert.doesNotMatch(html, /data-post-id=|<image|diy-community-more/); assert.match(html, /授权已失效/); assert.deepEqual(r.calls, []); }
  finally { r.stop(); }
}));

function mountCard(r, props) {
  const callbacks = [], events = [], actual = r.load(cardFile).default, original = actual.setup; let state;
  actual.setup = (values, context) => { state = original(values, context); return state; };
  actual.render = compileTemplate(cardFile);
  const node = tag => ({ tag, props: {}, children: [], parent: null });
  const renderer = vue.createRenderer({ createElement: node, createText: text => ({ ...node('#text'), text }), createComment: text => ({ ...node('#comment'), text }),
    setText: (n, text) => { n.text = text; }, setElementText: (n, text) => { n.text = text; for (const child of n.children) child.parent = null; n.children = []; }, parentNode: n => n?.parent ?? null,
    nextSibling(n) { if (!n?.parent) return null; const siblings = n.parent.children; return siblings[siblings.indexOf(n) + 1] ?? null; },
    patchProp: (n, key, _old, value) => { n.props[key] = value; },
    insert(n, parent, anchor = null) { if (n.parent) n.parent.children = n.parent.children.filter(child => child !== n); const index = anchor ? parent.children.indexOf(anchor) : -1; n.parent = parent; if (index < 0) parent.children.push(n); else parent.children.splice(index, 0, n); },
    remove(n) { if (n?.parent) { n.parent.children = n.parent.children.filter(child => child !== n); n.parent = null; } } });
  r.uni.createSelectorQuery = () => { const query = { in(instance) { assert.ok(instance); return query; }, select(selector) { assert.equal(selector, '.diy-community-card'); return query; }, boundingClientRect(callback) { callbacks.push(callback); return query; }, exec() {} }; return query; };
  const app = renderer.createApp({ setup: () => () => vue.h(actual, { ...props, onOpen: post => events.push({ type: 'open', post }), onMeasured: row => events.push({ type: 'measured', row }) }) });
  const tree = node('root'); app.mount(tree);
  return { tree, get state() { return state; }, callbacks, events, unmount: () => app.unmount() };
}

test('actual card source replacement invalidates old load error tap and query callbacks before new events apply', () => clocked(async () => {
  const r = setup({ active: false }), props = vue.reactive({ post: post(), layout: 'columns', imageStyle: { borderRadius: '16rpx 16rpx 0 0' }, image: '/static/a.png', avatar: '/static/author.png', allowed: () => true }), c = mountCard(r, props);
  try {
    await tick(); const old = c.state.native.value, query = c.callbacks[0], count = c.callbacks.length;
    props.image = '/static/b.png'; await tick();
    old.failed(); old.avatarFailed(); old.loaded(); old.tap(); query({ height: 999 }); await tick();
    assert.equal(c.state.imageFailed.value, false); assert.equal(c.state.avatarFailed.value, false); assert.deepEqual(c.events, []);
    assert.equal(c.callbacks.length, count + 1);
    c.state.native.value.failed(); assert.equal(c.state.imageFailed.value, true); c.state.native.value.tap(); await tick();
    assert.equal(c.events.some(event => event.type === 'open'), true);
    c.callbacks.at(-1)({ height: 123 }); assert.equal(c.events.at(-1).row.height, 123);
  } finally { c.unmount(); r.stop(); }
}));

for (const change of ['identity', 'avatar', 'lease', 'layout', 'dispose']) test(`actual native card callbacks cannot outlive their original ${change}`, () => clocked(async () => {
  const r = setup({ active: false }), props = vue.reactive({ post: post(), layout: 'columns', imageStyle: {}, image: '/static/a.png', avatar: '/static/author.png', allowed: () => true }), c = mountCard(r, props);
  let unmounted = false;
  try {
    await tick(); const old = c.state.native.value, query = c.callbacks[0];
    if (change === 'identity') props.post = post(2);
    else if (change === 'avatar') props.avatar = '/static/other.png';
    else if (change === 'lease') props.allowed = () => false;
    else if (change === 'layout') props.layout = 'horizontal';
    else { c.unmount(); unmounted = true; }
    await tick(); old.failed(); old.avatarFailed(); old.loaded(); old.tap(); query({ height: 999 }); await tick();
    assert.deepEqual(c.events, []); assert.equal(c.state.imageFailed.value, false); assert.equal(c.state.avatarFailed.value, false);
  } finally { if (!unmounted) c.unmount(); r.stop(); }
}));

test('PHP first tail follows column counts; only the second tail changes with measured heights', () => clocked(async () => {
  const r = setup({ value: block({ styleConfig: { tabVal: 1 } }) });
  try {
    await tick(); const current = r.c.lease();
    for (const row of r.c.rows.value) r.c.adoptMeasurement({ id: row.id, height: row.id === 2 ? 1000 : 10, current });
    assert.deepEqual(r.c.columns.value.map(column => column.map(row => row.id)), [[1, 3, 5, 7, 8], [2, 4, 6]]);
    r.c.adoptMeasurement({ id: 1, height: 2000, current });
    assert.deepEqual(r.c.columns.value.map(column => column.map(row => row.id)), [[1, 3, 5, 7], [2, 4, 6, 8]]);
  } finally { r.stop(); }
}));

test('actual byline template stops column author/like bubbling without writes and retains horizontal card navigation', () => clocked(async () => {
  const r = setup({ active: false }), props = vue.reactive({ post: post(), layout: 'columns', imageStyle: {}, image: '/static/a.png', avatar: '/static/author.png', allowed: () => true }), c = mountCard(r, props);
  const findByline = () => { const pending = [c.tree]; while (pending.length) { const next = pending.pop(); if (String(next.props.class).split(' ').includes('diy-community-byline')) return next; pending.push(...next.children); } };
  try {
    await tick(); let stops = 0;
    findByline().props.onTap({ stopPropagation() { stops++; } });
    assert.equal(stops, 1); assert.deepEqual(c.events, []); assert.deepEqual(r.calls, []);
    props.layout = 'horizontal'; await tick();
    findByline().props.onTap({ stopPropagation() { stops++; } });
    assert.equal(stops, 2); assert.equal(c.events.length, 1); assert.equal(c.events[0].type, 'open'); assert.deepEqual(r.calls, []);
  } finally { c.unmount(); r.stop(); }
}));

for (const platform of ['H5', 'APP-PLUS', 'MP-WEIXIN']) test(`${platform} actual header template keeps bundled static paths local while managed asset sources use API authority`, () => clocked(async () => {
  const r = setup({ platform });
  try {
    await tick(); assert.equal(r.c.mediaTitle(), '/static/images/diy/community.png');
    let html = await markup(r); assert.match(html, /class="diy-community-title-image"[^>]*src="\/static\/images\/diy\/community\.png"/);
    const api = r.load(path.join(root, 'src/utils/request.ts')).API_BASE;
    r.props.block.imgConfig.url = asset(); await tick();
    assert.equal(r.c.mediaTitle(), api + asset()); html = await markup(r);
    assert.equal(html.includes(`src="${api + asset().replaceAll('&', '&amp;')}"`), true);
  } finally { r.stop(); }
}));
