const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

const origin = Date.UTC(2026, 9, 22, 3, 0, 0), cacheKey = 'cinashop_diy_page_v1_2';
const version = call => call.url.includes('/diy/diy_version/');
const payload = call => call.url.includes('/diy/get_diy/');
const page = (now, title = '实际素材页面', image = `/api/assets/2?expires=${Math.floor(now / 1000) + 900}&signature=${'A'.repeat(43)}`) => ({
  title, is_show: 1, value: [{ name: 'follow', timestamp: 541, titleConfig: { value: '真实公众号' }, codeConfig: { url: image } }],
});

/** Only the native clock/timer scheduler is controlled. Vue, Pinia, the actual
 * page/host, schema cache, request adapter and API chain run from source. */
async function clock(start = origin) {
  // Let Node initialize its child-process reporter before changing globals.
  // Otherwise the lazily initialized reporter can adopt the fake scheduler
  // and omit every per-case IPC event under the standard --test runner.
  await new Promise(setImmediate);
  const original = { now: Date.now, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  let current = start, sequence = 0;
  const pending = new Map(), history = [];
  Date.now = () => current;
  global.setTimeout = (callback, delay = 0, ...args) => {
    // Leave Node's test reporter and native I/O scheduling intact. Only the
    // actual host's media scheduler is advanced by this local fake clock.
    if (!new Error().stack?.includes('scheduleMediaRefresh')) return original.setTimeout(callback, delay, ...args);
    const timer = { id: ++sequence, due: current + Number(delay), callback: () => callback(...args) };
    pending.set(timer.id, timer); history.push(timer); return timer.id;
  };
  global.clearTimeout = id => { if (!pending.delete(id)) original.clearTimeout(id); };
  return { pending, history, now: () => current,
    advance(milliseconds) {
      current += milliseconds;
      for (const timer of [...pending.values()].sort((a, b) => a.due - b.due)) if (timer.due <= current && pending.delete(timer.id)) timer.callback();
    },
    restore() { Date.now = original.now; global.setTimeout = original.setTimeout; global.clearTimeout = original.clearTimeout; pending.clear(); },
  };
}
function setup(time, { storage = new Map(), send, image, title } = {}) {
  let pages = 0;
  let r;
  try {
    r = runtime({ component: 'pages/diy/detail.vue', storage, send: call => {
      if (send) { const result = send(call); if (result !== undefined) return result; }
      if (version(call)) return { data: { version: 'opaque-stable-version' } };
      if (payload(call)) { pages++; return { data: page(time.now(), title ?? `实际素材页面${pages}`, image) }; }
      return { data: [] };
    } });
  } catch (error) { time.restore(); throw error; }
  const titles = []; r.uni.setNavigationBarTitle = value => titles.push(value.title);
  return { ...r, titles, host: r.checkout.diyHost, pages: () => pages };
}
const schemas = r => r.calls.filter(call => version(call) || payload(call));
const managedOnly = r => assert.ok(r.calls.every(call => version(call) || payload(call)), 'A media lease must never generate a poster, save an album or hydrate a child API');

test('an active actual page force-refreshes media before the 900s signature expires even while the schema version is unchanged', async () => {
  const time = await clock(), r = setup(time);
  try {
    await r.start({ id: '2' }); const first = r.host.page.value.value[0].codeConfig.url;
    assert.equal(r.pages(), 1); assert.equal(time.pending.size, 1); assert.equal([...time.pending.values()][0].due, origin + 840000);
    time.advance(839999); await tick(); assert.equal(r.pages(), 1);
    time.advance(1); await tick(); assert.equal(r.pages(), 2); assert.equal(r.host.available.value, true);
    assert.notEqual(r.host.page.value.value[0].codeConfig.url, first);
    assert.equal(schemas(r).filter(version).length, 4); assert.equal(time.pending.size, 1);
    assert.equal(JSON.parse(r.storage.get(cacheKey)).cachedAt, time.now()); managedOnly(r);
  } finally { r.stop(); time.restore(); }
});

test('a reused cache entry schedules its remaining lease rather than granting a new 840s from adoption', async () => {
  const time = await clock(), cachedAt = origin - 300000;
  const storage = new Map([[cacheKey, JSON.stringify({ data: page(cachedAt, '实际缓存素材'), version: 'opaque-stable-version', cachedAt, versionVerified: true })]]);
  const r = setup(time, { storage });
  try {
    await r.start({ id: '2' }); assert.equal(r.pages(), 0); assert.equal(r.host.page.value.title, '实际缓存素材');
    assert.equal([...time.pending.values()][0].due, cachedAt + 840000);
    time.advance(539999); await tick(); assert.equal(r.pages(), 0);
    time.advance(1); await tick(); assert.equal(r.pages(), 1); assert.equal(r.host.offline.value, false); managedOnly(r);
  } finally { r.stop(); time.restore(); }
});

test('the earliest ticket expiry minus one minute wins over the schema cache age ceiling', async () => {
  const time = await clock(), image = `/api/assets/2?expires=${Math.floor(origin / 1000) + 400}&signature=${'B'.repeat(43)}`, r = setup(time, { image });
  try {
    await r.start({ id: '2' }); assert.equal([...time.pending.values()][0].due, origin + 340000);
    time.advance(339999); await tick(); assert.equal(r.pages(), 1);
  } finally { r.stop(); time.restore(); }
});

for (const boundary of ['onHide', 'onUnload']) test(`${boundary} cancels an adopted media timer and an already queued old callback cannot start work`, async () => {
  const time = await clock(), r = setup(time);
  try {
    await r.start({ id: '2' }); const old = time.history.at(-1), before = r.calls.length;
    r.hooks[boundary](); assert.equal(time.pending.size, 0); old.callback(); time.advance(900000); await tick();
    assert.equal(r.calls.length, before); assert.equal(r.host.available.value, false);
    if (boundary === 'onHide') { r.hooks.onShow(); await tick(); assert.equal(r.pages(), 2); assert.equal(time.pending.size, 1); }
  } finally { r.stop(); time.restore(); }
});

test('an old owner timer cannot replace the later owner schema, title or renewal schedule', async () => {
  const time = await clock(), r = setup(time);
  try {
    await r.start({ id: '2' }); const old = time.history.at(-1);
    r.auth.setLogin('account-22-token', 22); await tick(); assert.equal(time.pending.size, 1);
    const accepted = r.host.page.value, titleCount = r.titles.length, calls = r.calls.length, current = [...time.pending.values()][0];
    assert.notEqual(current.id, old.id); old.callback(); await tick();
    assert.equal(r.calls.length, calls); assert.equal(r.host.page.value, accepted); assert.equal(r.titles.length, titleCount);
    assert.equal([...time.pending.values()][0], current); managedOnly(r);
  } finally { r.stop(); time.restore(); }
});

test('a manual newer reload cancels the old timer and a delayed retired callback cannot trigger another refresh', async () => {
  const time = await clock(), r = setup(time);
  try {
    await r.start({ id: '2' }); const old = time.history.at(-1);
    time.advance(1000); await r.host.reload(true); const calls = r.calls.length;
    assert.equal(r.pages(), 2); assert.equal(time.pending.size, 1); old.callback(); await tick(); assert.equal(r.calls.length, calls);
    assert.equal([...time.pending.values()][0].due, origin + 841000);
  } finally { r.stop(); time.restore(); }
});

test('hide during timer renewal prevents the delayed version from issuing a second-stage payload request', async () => {
  const time = await clock(), wait = deferred(); let hold = false;
  const r = setup(time, { send: call => hold && version(call) ? wait.promise : undefined });
  try {
    await r.start({ id: '2' }); hold = true; time.advance(840000); await tick(); assert.equal(r.pages(), 1);
    r.hooks.onHide(); wait.resolve({ data: { version: 'opaque-stable-version' } }); await tick();
    assert.equal(r.pages(), 1); assert.equal(time.pending.size, 0); assert.equal(r.host.available.value, false); managedOnly(r);
  } finally { wait.resolve({ data: { version: 'opaque-stable-version' } }); r.stop(); time.restore(); }
});

test('a transient renewal failure cannot readopt expired offline media or leave an expired live page active', async () => {
  const time = await clock(); let offline = false;
  const r = setup(time, { send: () => offline ? { transport: 'offline' } : undefined });
  try {
    await r.start({ id: '2' }); offline = true; time.advance(840000); await tick();
    assert.equal(r.pages(), 1); assert.equal(r.host.page.value, null); assert.equal(r.host.available.value, false);
    assert.equal(r.host.phase.value, 'error'); assert.equal(time.pending.size, 0); managedOnly(r);
  } finally { r.stop(); time.restore(); }
});

for (const image of ['/static/logo.png', 'https://public.example/qr.png']) test(`unmanaged ${image} schemas retain the old cache/offline contract without a renewal timer`, async () => {
  const time = await clock(), r = setup(time, { image });
  try {
    await r.start({ id: '2' }); assert.equal(time.pending.size, 0); const calls = r.calls.length;
    time.advance(3600000); await tick(); assert.equal(r.calls.length, calls); assert.equal(r.host.available.value, true); managedOnly(r);
  } finally { r.stop(); time.restore(); }
});
