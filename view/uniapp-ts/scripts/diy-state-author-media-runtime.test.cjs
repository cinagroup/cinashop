const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vue = require('vue');
const { runtime, tick } = require('./uni-store-runtime.cjs');

const origin = Date.UTC(2026, 9, 24, 2), signature = 's'.repeat(43), key = 'cinashop_diy_page_v1_0';
const kinds = ['userInfor', 'ranking'];
const field = kind => kind === 'userInfor' ? 'logoConfig' : 'imgConfig';
const asset = (expires = origin + 900000, id = 7) => `/api/assets/${id}?expires=${Math.floor(expires / 1000)}&signature=${signature}`;
const block = (kind, url = asset()) => ({ name: kind, timestamp: 101, styleConfig: { tabVal: 0 }, [field(kind)]: { url, link: '/pages/user/index', retained: { zero: 0, list: [] } } });
const page = (kind, url = asset()) => ({ title: '状态作者素材页', is_show: 1, value: [block(kind, url)] });
function setup(send = () => ({ data: [] }), { storage = new Map(), platform = 'H5' } = {}) {
  const props = vue.reactive({ block: block('userInfor', '/static/logo.png'), active: false });
  const r = runtime({ component: 'components/diy/DiyStateWidget.vue', props, send, storage, platform });
  return { ...r, props, m: r.load(path.join(__dirname, '../src/utils/diyEditorialMediaLease.ts')), d: r.load(path.join(__dirname, '../src/utils/diy.ts')) };
}
async function withClock(fn) {
  await new Promise(setImmediate); const previous = Date.now; let now = origin; Date.now = () => now;
  try { await fn(() => now, value => { now = value; }); } finally { Date.now = previous; }
}

for (const kind of kinds) test(`${kind} exact image slot applies the earliest ticket expiry, minute reserve and original840-second cache ceiling`, () => withClock(async () => {
  const r = setup(); try {
    const p = page(kind), before = JSON.stringify(p);
    assert.equal(r.m.diyEditorialMediaDeadline(p, origin, origin), origin + 840000);
    assert.equal(r.m.diyEditorialMediaCacheUsable(p, origin, origin + 839999), true);
    assert.equal(r.m.diyEditorialMediaCacheUsable(p, origin, origin + 840000), false);
    assert.equal(r.m.diyEditorialMediaDeadline(page(kind, asset(origin + 100000)), origin, origin), origin + 40000);
    assert.equal(r.m.diyEditorialMediaDeadline(page(kind, asset(origin + 1800000)), origin, origin), origin + 840000);
    assert.equal(JSON.stringify(p), before); assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
}));

for (const kind of kinds) test(`${kind} expired, unsigned, malformed, duplicate or encoded-duplicate query parameters fail closed without mutating the page`, () => withClock(async () => {
  const r = setup(); try {
    for (const url of ['/api/assets/7', asset(origin - 1), asset(origin + 60000), asset().replace('&signature=' + signature, ''),
      asset() + '&expires=1792800000', asset() + '&%65xpires=1792800000', asset() + '&signature=' + signature,
      asset().replace('signature=' + signature, 'signature=x'), asset().replace('expires=', 'expires=%ZZ'), asset().replace('signature=', 'signature=%ZZ')]) {
      const p = page(kind, url), before = JSON.stringify(p); assert.equal(r.m.diyEditorialMediaCacheUsable(p, origin, origin), false, url); assert.equal(JSON.stringify(p), before);
    }
    for (const cachedAt of [0, NaN, Infinity, origin + 1, origin - 840000]) assert.equal(r.m.diyEditorialMediaCacheUsable(page(kind), cachedAt, origin), false);
  } finally { r.stop(); }
}));

for (const kind of kinds) test(`${kind} current API authority and H5 origin are managed while foreign or lookalike URLs retain their authored query`, () => withClock(async () => {
  const previousWindow = global.window; global.window = { location: { origin: 'https://owned-state-h5.example' } };
  const r = setup(undefined, { platform: 'MP-WEIXIN' }); try {
    const api = r.load(path.join(__dirname, '../src/utils/request.ts')).API_BASE; assert.equal(api, 'https://cinashop-api.cinagroup.workers.dev');
    for (const prefix of ['', api, global.window.location.origin]) assert.equal(r.m.diyEditorialMediaCacheUsable(page(kind, prefix + asset(origin - 1)), origin, origin), false);
    for (const url of ['https://foreign.example' + asset(origin - 1), api + '.evil.example' + asset(origin - 1), '/api/assets/07?expires=1&signature=x', '/&#97;pi/assets/7?expires=1&signature=x', '/static/images/diy/ranking.png']) {
      const p = page(kind, url), fingerprint = r.m.diyAuthoredPageFingerprint(p.value); assert.equal(r.m.diyEditorialMediaDeadline(p, origin, origin), Infinity);
      const copy = structuredClone(p.value); copy[0][field(kind)].url += '&retained=1'; assert.notEqual(r.m.diyAuthoredPageFingerprint(copy), fingerprint);
    }
    const p = page(kind, asset() + '&unused=retained'); assert.equal(r.m.diyEditorialMediaDeadline(p, origin, origin), origin + 840000);
    assert.deepEqual(r.calls, []);
  } finally { r.stop(); if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
}));

test('only exact state image fields gain media authority; newVip/signIn, case lookalikes, account/product data, wrong slots, content and neighbors remain opaque', () => withClock(async () => {
  const r = setup(); try {
    const stale = asset(origin - 1), value = [
      { ...block('userInfor', '/static/logo.png'), imgConfig: { url: stale }, avatar: stale, userInfo: { avatar: stale }, preview: stale },
      { ...block('ranking', '/static/images/diy/ranking.png'), logoConfig: { url: stale }, productList: [{ image: stale }], titleConfig: { url: stale } },
      ...['newVip', 'signIn', 'UserInfor', 'Ranking', 'unsupported-state'].map(name => ({ name, logoConfig: { url: stale }, imgConfig: { url: stale }, nested: block('userInfor', stale) })),
    ], p = { value, content: stale, metadata: { logoConfig: { url: stale } } }, original = JSON.stringify(p);
    assert.equal(r.m.diyEditorialMediaDeadline(p, origin, origin), Infinity); const fingerprint = r.m.diyAuthoredPageFingerprint(value);
    for (const change of [v => { v[0].logoConfig.link = asset(); }, v => { v[0].avatar = asset(); }, v => { v[1].productList[0].image = asset(); }, v => { v[2].logoConfig.url = asset(); }, v => { v[6].nested.logoConfig.url = asset(); }]) {
      const copy = structuredClone(value); change(copy); assert.notEqual(r.m.diyAuthoredPageFingerprint(copy), fingerprint);
    }
    assert.equal(JSON.stringify(p), original); assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
}));

for (const kind of kinds) test(`${kind} authored intent ignores transport ticket renewal only; IDs, order, links, external URLs and dormant fields remain significant`, () => withClock(async () => {
  const r = setup(); try {
    const value = [block(kind), { ...block(kind, asset(origin + 800000, 8)), timestamp: 102, isHide: true }], original = JSON.stringify(value), fingerprint = r.m.diyAuthoredPageFingerprint(value);
    const renewal = structuredClone(value); renewal[0][field(kind)].url = asset(origin + 1800000); renewal[1][field(kind)].url = asset(origin + 1600000, 8);
    assert.equal(r.m.diyAuthoredPageFingerprint(renewal), fingerprint);
    for (const change of [v => { v[0][field(kind)].url = asset(origin + 900000, 9); }, v => v.reverse(), v => { v[0][field(kind)].link = asset(); },
      v => { v[0][field(kind)].retained.zero = 1; }, v => { v[0].styleConfig.tabVal = 1; }, v => { v[0][field(kind)].url = 'https://foreign.example' + asset(); }]) {
      const copy = structuredClone(value); change(copy); assert.notEqual(r.m.diyAuthoredPageFingerprint(copy), fingerprint);
    }
    // Hidden imports remain part of the existing media/intent scan. This does
    // not confer permission to any action or change state-widget loaders.
    renewal[1][field(kind)].url = asset(origin - 1, 8); assert.equal(r.m.diyEditorialMediaCacheUsable({ value: renewal }, origin, origin), false);
    assert.equal(JSON.stringify(value), original);
  } finally { r.stop(); }
}));

test('mixed duplicate state slots choose the earliest image lease and preserve complete allowed2500 ordinary-media scanning', () => withClock(async () => {
  const r = setup(); try {
    const p = { value: [block('userInfor'), block('ranking', asset(origin + 300000, 8)), { ...block('userInfor', asset(origin + 200000, 9)), timestamp: 103 }] };
    assert.equal(r.m.diyEditorialMediaDeadline(p, origin, origin), origin + 140000);
    const full = { value: [{ name: 'swipers', swiperConfig: { list: Array.from({ length: 2499 }, (_, index) => ({ img: '/static/logo.png', index })) } }, block('ranking', asset(origin - 1))] }, before = JSON.stringify(full);
    assert.equal(r.m.diyEditorialMediaCacheUsable(full, origin, origin), false); assert.equal(full.value[0].swiperConfig.list.length, 2499); assert.equal(JSON.stringify(full), before);
  } finally { r.stop(); }
}));

for (const kind of kinds) test(`${kind} preserves the existing first200-body window and independent full-footer scan`, () => withClock(async () => {
  const r = setup(); try {
    const body = Array.from({ length: 200 }, (_, index) => ({ name: 'titles', timestamp: index, titleConfig: { value: '保留正文' } })); body[199] = block(kind, asset(origin - 1));
    assert.equal(r.m.diyEditorialMediaCacheUsable({ value: body }, origin, origin), false);
    const outside = [...body.slice(0, 199), { name: 'titles', timestamp: 199 }, block(kind, asset(origin - 1))], before = JSON.stringify(outside);
    assert.equal(r.m.diyEditorialMediaDeadline({ value: outside }, origin, origin), Infinity);
    const fingerprint = r.m.diyAuthoredPageFingerprint(outside), renewedOutside = structuredClone(outside); renewedOutside[200][field(kind)].url = asset(); assert.notEqual(r.m.diyAuthoredPageFingerprint(renewedOutside), fingerprint);
    outside.push({ name: 'pageFoot', menuList: [{ imgList: ['/static/logo.png', asset(origin - 1), '/api/assets/999'] }] });
    assert.equal(r.m.diyEditorialMediaCacheUsable({ value: outside }, origin, origin), false); assert.equal(JSON.stringify(outside.slice(0, 201)), before);
  } finally { r.stop(); }
}));

for (const kind of kinds) test(`${kind} same opaque version reuses fresh transport and renews expired tickets through the actual cache/request adapters`, () => withClock(async () => {
  for (const stale of [false, true]) {
    const cached = page(kind, asset(stale ? origin - 1 : origin + 900000)), storage = new Map([[key, JSON.stringify({ data: cached, version: 'same', versionVerified: true, cachedAt: origin - 1000 })]]),
      r = setup(call => call.url.includes('/diy_version/') ? { data: { version: 'same' } } : { data: page(kind, asset(origin + 1800000)) }, { storage });
    try {
      const result = await r.d.loadDiyPage(0); assert.equal(result.source, stale ? 'network' : 'cache'); assert.equal(r.calls.filter(call => call.url.includes('/get_diy/')).length, stale ? 1 : 0);
      assert.equal(result.data.value[0][field(kind)].url, asset(stale ? origin + 1800000 : origin + 900000));
      assert.equal(JSON.parse(storage.get(key)).data.value[0][field(kind)].url, result.data.value[0][field(kind)].url);
      assert.equal(r.m.diyAuthoredPageFingerprint(result.data.value), r.m.diyAuthoredPageFingerprint(cached.value));
      assert.ok(r.calls.every(call => /\/api\/diy\/(?:get_diy|diy_version)\/0$/u.test(call.url))); assert.equal(r.navigations.length, 0);
    } finally { r.stop(); }
  }
}));

for (const kind of kinds) test(`${kind} offline fallback admits only still-fresh public media and an unsigned network response cannot replace a valid cached schema`, () => withClock(async () => {
  for (const stale of [false, true]) {
    const storage = new Map([[key, JSON.stringify({ data: page(kind, asset(stale ? origin - 1 : origin + 900000)), version: 'same', versionVerified: true, cachedAt: origin - 1000 })]]), r = setup(() => ({ transport: 'owned offline' }), { storage });
    try { if (stale) await assert.rejects(r.d.loadDiyPage(0)); else assert.equal((await r.d.loadDiyPage(0)).source, 'offline'); assert.equal(r.calls.length, 1); } finally { r.stop(); }
  }
  const original = JSON.stringify({ data: page(kind), version: 'old', versionVerified: true, cachedAt: origin - 1000 }), storage = new Map([[key, original]]), r = setup(call => call.url.includes('/diy_version/') ? { data: { version: 'new' } } : { data: page(kind, '/api/assets/7') }, { storage });
  try { await assert.rejects(r.d.loadDiyPage(0), error => error.kind === 'invalid'); assert.equal(storage.get(key), original); } finally { r.stop(); }
}));

test('an expired authored avatar neither grants nor revokes actual member actions, account checks or protected data authority', () => withClock(async () => {
  const props = vue.reactive({ block: { ...block('userInfor', asset(origin - 1)), checkboxInfo: { type: [0, 1, 2] } }, active: true });
  const r = runtime({ component: 'components/diy/DiyStateWidget.vue', props, authenticated: false, platform: 'H5', send: () => { throw Error('Guest member author image must start no protected I/O'); } });
  try {
    await tick(); const m = r.load(path.join(__dirname, '../src/utils/diyEditorialMediaLease.ts')); assert.equal(m.diyEditorialMediaCacheUsable({ value: [props.block] }, origin, origin), false);
    assert.equal(r.checkout.c.loaded.value, true); r.checkout.c.openMember('profile'); assert.deepEqual(r.navigations, ['/pages/auth/login']);
    r.checkout.c.openMember('unknown-author-avatar'); assert.equal(r.navigations.length, 1); assert.equal(r.auth.isLoggedIn, false); assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
}));
