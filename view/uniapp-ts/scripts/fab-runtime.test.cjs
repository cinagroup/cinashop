const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vue = require('vue');
const root = path.resolve(__dirname, '..', 'src');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let n = 0; n < 6; n++) { await vue.nextTick(); await new Promise(setImmediate); } };
const configuration = (style = 1, overrides = {}) => ({ is_show: 1, index: style, shifting: 0, main_ago_image: style === 4 ? '' : '/api/assets/42?sig=preview', main_after_image: style === 3 ? '/api/assets/43?sig=preview' : '', button: Array.from({ length: 3 }, (_, n) => ({ img: '/static/' + n + '.png', url: n === 0 ? '/pages/goods/goods_list/index?q=1' : n === 1 ? 'https://external.test/a?x=%20' : 'packageA/detail?x=1@APPID=wxABCDEF0123456789' })), ...overrides });
function preprocess(source, platform) {
  const active = [true];
  return source.split('\n').filter(line => {
    const match = /\/\/\s*#(ifdef|ifndef|endif)\s*(.*)/u.exec(line);
    if (!match) return active.at(-1);
    if (match[1] === 'endif') active.pop();
    else { const allowed = match[2].split(/\s*\|\|\s*/u).some(value => value === platform || value === 'MP' && platform === 'MP-WEIXIN'); active.push(active.at(-1) && (match[1] === 'ifndef' ? !allowed : allowed)); }
    return false;
  }).join('\n');
}
function runtime(send = () => configuration(), platform = 'H5', windowInfo = {}) {
  const mounted = [], unmounted = [], hooks = {}, events = new Map(), nativeEvents = new Map(), cache = new Map(), calls = [], toasts = [], navigations = [], opened = [], mini = [];
  const env = {
    getSystemInfoSync: () => ({ windowHeight: 844, windowWidth: 390, ...windowInfo }),
    createSelectorQuery: () => ({ select() { return this; }, boundingClientRect(callback) { callback({ height: 149 }); return this; }, exec() {} }),
    $on: (name, fn) => nativeEvents.set(name, fn), $off: name => nativeEvents.delete(name), onWindowResize: fn => nativeEvents.set('resize', fn), offWindowResize: () => nativeEvents.delete('resize'),
    showToast: opts => toasts.push(opts.title), switchTab: opts => navigations.push({ type: 'tab', ...opts }), navigateTo: opts => navigations.push({ type: 'page', ...opts }), navigateBack: opts => navigations.push({ type: 'back', ...opts }),
    navigateToMiniProgram: opts => mini.push(opts),
  };
  const win = { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name), open: (...args) => { opened.push(args); return { opener: 'initial' }; } };
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    let source = preprocess(readFileSync(file, 'utf8'), platform);
    if (file.endsWith('.vue')) { const { parse, compileScript } = require('@vue/compiler-sfc'); source = compileScript(parse(source, { filename: file }).descriptor, { id: 'fab-component-runtime' }).content; }
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    new Function('require', 'exports', 'uni', 'window', output)(id => {
      if (id === 'vue') return { ...vue, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmounted.push(fn) };
      if (id === '@dcloudio/uni-app') return { onPageScroll: fn => hooks.scroll = fn, onLoad: fn => hooks.load = fn };
      if (id === '@/utils/request') return { http: { get: (url, data, options) => { calls.push({ url, data, options }); return Promise.resolve().then(() => send(calls.at(-1))); } } };
      if (id.startsWith('@/')) return load(path.join(root, id.slice(2)));
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
      throw Error('Unexpected dependency ' + id);
    }, exports, env, win);
    return exports;
  }
  const effect = vue.effectScope();
  const helper = load(path.join(root, 'utils/fab.ts'));
  const component = effect.run(() => load(path.join(root, 'components/diy/DiySuspendedNavigation.vue')).default.setup({}, { expose() {} }));
  return { component, helper, load, env, events, nativeEvents, calls, toasts, navigations, opened, mini, hooks, async start() { for (const fn of mounted) await fn(); await tick(); }, stop() { for (const fn of unmounted) fn(); effect.stop(); } };
}

test('actual optional API/cache reads anonymous safe projection and keeps payload display independent of row flags', async () => {
  const r = runtime(); try { await r.start(); assert.equal(r.calls.length, 1); assert.equal(r.calls[0].url, 'diy/get_suspended'); assert.equal(r.calls[0].options.noAuth, true); assert.equal(r.component.config.value.is_show, 1); assert.equal(r.component.config.value.button.length, 3); } finally { r.stop(); }
});
test('all four style main-image semantics and arc points are distinct without filtering unavailable slots', () => {
  const r = runtime(); try { const h = r.helper;
    for (let style = 1; style <= 4; style++) { const parsed = h.parseFabConfig(configuration(style)); assert.equal(parsed.index, style); assert.equal(parsed.main_after_image, style === 3 ? '/api/assets/43?sig=preview' : ''); assert.equal(parsed.main_ago_image, style === 4 ? '' : '/api/assets/42?sig=preview'); }
    const unavailable = configuration(3, { button: [{ img: '//evil.test/a', url: '' }, ...configuration(3).button.slice(1)] }); const parsed = h.parseFabConfig(unavailable); assert.equal(parsed.button.length, 3); assert.deepEqual(parsed.button[0], { img: '', url: '' });
    assert.equal(h.fabArc(3, 1).left, -100); assert.equal(h.fabArc(4, 1).top, -50); assert.equal(h.fabArc(5, 2).left, -106);
    assert.equal(h.parseFabConfig(configuration(3, { button: [] })), null); assert.equal(h.parseFabConfig(configuration(1, { shifting: 101 })), null);
  } finally { r.stop(); }
});
test('0 and 100 clamp measured height within content viewport, including H5 header/tabbar offsets', async () => {
  const r = runtime(); try { const h = r.helper; assert.equal(h.fabCentre(0, 844, 149), 74.5); assert.equal(h.fabCentre(100, 844, 149), 769.5); assert.equal(h.fabCentre(50, 844, 280), 422); assert.equal(h.fabCentre(0, 844, 1000), 422); assert.equal(h.fabCentre(100, 844, 149, -200), 74.5); } finally { r.stop(); }
  const content = { windowHeight: 750, windowWidth: 390, windowTop: 44, windowBottom: 50 }, h5 = runtime(() => configuration(1), 'H5', content), mp = runtime(() => configuration(1), 'MP-WEIXIN', content);
  try { await h5.start(); await mp.start(); const c = h5.component;
    assert.equal(Number.parseFloat(c.positionStyle.value.top) - c.measured.value / 2, 44);
    c.config.value.shifting = 100;
    assert.equal(Number.parseFloat(c.positionStyle.value.top) + c.measured.value / 2, 794);
    c.measured.value = 300; c.config.value.shifting = 0;
    assert.equal(Number.parseFloat(c.positionStyle.value.top) - c.measured.value / 2, 44);
    c.config.value.shifting = 100;
    assert.equal(Number.parseFloat(c.positionStyle.value.top) + c.measured.value / 2, 794);
    assert.equal(Number.parseFloat(mp.component.positionStyle.value.top) - mp.component.measured.value / 2, 0);
  } finally { h5.stop(); mp.stop(); }
});
test('component opens, drags without accidental toggle, and touchcancel permits subsequent scroll collapse', async () => {
  const r = runtime(() => configuration(3)); try { await r.start(); r.component.toggle(); assert.equal(r.component.opened.value, true); r.component.touchStart({ touches: [{ clientY: 100 }] }); r.component.touchMove({ touches: [{ clientY: 600 }] }); assert.ok(r.component.dragged.value > 500); r.component.touchEnd(); r.component.toggle(); assert.equal(r.component.opened.value, true); r.component.collapse(); assert.equal(r.component.opened.value, false); r.component.touchStart({ touches: [{ clientY: 100 }] }); r.component.touchEnd(); r.hooks.scroll(); assert.equal(r.component.opened.value, false); } finally { r.stop(); }
});
test('style2 page scroll closes and half-hides; reopening restores visible control', async () => {
  const r = runtime(() => configuration(2)); try { await r.start(); r.component.toggle(); assert.equal(r.component.opened.value, true); r.events.get('scroll')(); assert.equal(r.component.opened.value, false); assert.equal(r.component.hidden.value, true); r.component.toggle(); assert.equal(r.component.hidden.value, false); } finally { r.stop(); }
});
test('actual link actions adapt legacy routes, use tab navigation, and open HTTP(S) with opener isolation', () => {
  const r = runtime(); try { const h = r.helper; h.openFabLink('/pages/goods/goods_list/index?q=white%20shirt'); h.openFabLink('/pages/order_addcart/order_addcart'); assert.equal(r.navigations[0].url, '/pages/goods/list?q=white%20shirt'); assert.equal(r.navigations[1].type, 'tab'); h.openFabLink('http://external.test/a?x=%20'); assert.deepEqual(r.opened[0], ['http://external.test/a?x=%20', '_blank', 'noopener,noreferrer']); assert.equal(h.openFabLink('/pages/unknown/index'), false); assert.match(r.toasts.at(-1), /尚未登记/); } finally { r.stop(); }
});
test('mini-program independent path roundtrips; H5 reports boundary while MP invokes real SDK', () => {
  const h5 = runtime(), mp = runtime(undefined, 'MP-WEIXIN'), value = 'packageA/detail/index?x=1@APPID=wxABCDEF0123456789';
  try { assert.deepEqual(h5.helper.resolveFabLink(value), { kind: 'mini', path: 'packageA/detail/index?x=1', appId: 'wxABCDEF0123456789' }); assert.equal(h5.helper.openFabLink(value), false); assert.match(h5.toasts.at(-1), /不支持/); assert.equal(mp.helper.openFabLink(value), true); assert.equal(mp.mini[0].path, 'packageA/detail/index?x=1'); assert.equal(mp.mini[0].appId, 'wxABCDEF0123456789'); } finally { h5.stop(); mp.stop(); }
});
test('unsafe decoded and credential addresses cannot navigate or load images; external package dot segments are refused', () => {
  const r = runtime(); try {
    for (const value of ['javascript:x', '//evil.test', 'https:evil.test', 'https://u:p@evil.test', '/a/..//evil.test', '/pages/index/index%250a', 'https://external.test/a%255c', 'a/../b@APPID=wx0123456789abcdef', 'pkg/页@APPID=wx0123456789abcdef']) assert.equal(r.helper.resolveFabLink(value), null, value);
    assert.equal(r.helper.fabImagePreview('https://cdn.test/My%20Banner.png'), 'https://cdn.test/My%20Banner.png'); assert.equal(r.helper.fabImagePreview('/api/assets/42?sig=preview'), '/api/assets/42?sig=preview'); assert.equal(r.helper.fabImagePreview('//evil.test/a'), '');
  } finally { r.stop(); }
});
test('webview validates URL again at entry and only one query transport decode can reveal HTTP(S)', () => {
  const r = runtime(); try { const h = r.helper; assert.equal(h.fabWebViewUrl(encodeURIComponent('https://external.test/a?q=%20')), 'https://external.test/a?q=%20'); assert.equal(h.fabWebViewUrl('http://external.test/a'), 'http://external.test/a'); for (const input of [undefined, 'javascript:x', '//evil.test/a', 'https://u:p@evil.test', encodeURIComponent(encodeURIComponent('https://external.test'))]) assert.equal(h.fabWebViewUrl(input), ''); } finally { r.stop(); }
});
test('unknown public outcome never fabricates controls and cache invalidation fences old responses', async () => {
  const gate = deferred(); let calls = 0; const r = runtime(() => ++calls === 1 ? gate.promise : configuration(4));
  try { const mod = r.load(path.join(root, 'utils/diySuspended.ts')); const old = mod.loadDiySuspendedConfig(); await tick(); mod.invalidateDiySuspendedConfig(); const next = mod.loadDiySuspendedConfig(); gate.resolve(configuration(1)); assert.equal(await old, null); assert.equal((await next).index, 4); assert.equal((await mod.loadDiySuspendedConfig()).index, 4); assert.equal(calls, 2); } finally { r.stop(); }
});
test('unmounted component cannot show late response and removes native/window handlers', async () => {
  const gate = deferred(), r = runtime(() => gate.promise); const run = r.start(); await tick(); r.stop(); gate.resolve(configuration()); await run; assert.equal(r.component.config.value, null); assert.equal(r.events.size, 0); assert.equal(r.nativeEvents.size, 0);
});
test('API failure remains optional and a subsequent read can recover without caching the failure', async () => {
  let fail = true; const r = runtime(() => { if (fail) throw Error('offline'); return configuration(3); });
  try { await r.start(); assert.equal(r.component.config.value, null); fail = false; const mod = r.load(path.join(root, 'utils/diySuspended.ts')); assert.equal((await mod.loadDiySuspendedConfig()).index, 3); assert.equal(r.calls.length, 2); } finally { r.stop(); }
});

