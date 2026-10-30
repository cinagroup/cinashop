const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vue = require('vue');
const pinia = require('pinia');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const { product } = require('./diy-commerce-fixture.cjs');
const root = path.resolve(__dirname, '..'), widget = 'components/diy/DiyPromotionWidget.vue';
const origin = Date.UTC(2026, 9, 25, 3), signature = 'P'.repeat(43);
const asset = (id = 7, expiry = origin + 900000) => `/api/assets/${id}?expires=${Math.floor(expiry / 1000)}&signature=${signature}`;
const copy = value => JSON.parse(JSON.stringify(value));
const tab = (id = 601, extra = {}) => ({ chiild: [{ val: `商品${id}`, max: 4 }, { val: '商品简介', max: 4 }], image: '/static/tab.png', tabVal: 1, goodsList: { ids: [id], list: [] }, numConfig: { val: 2 }, goodsSort: 0, ...extra });
const block = (extra = {}) => ({ name: 'promotionList', timestamp: 101, isHide: false, styleConfig: { tabVal: 4 }, slideConfig: { tabVal: 1 }, cartConfig: { tabVal: 1 }, bntConfig: { tabVal: 0 }, tabConfig: { tabCur: 1, list: [tab(), tab(602)] }, ...extra });
const products = r => r.calls.filter(call => call.url.endsWith('/products'));
const response = call => {
  assert.ok(call.url.endsWith('/products'), `Unexpected I/O ${call.url}`);
  const ids = call.data.ids ? String(call.data.ids).split(',').map(Number) : [601, 602];
  const list = ids.slice(0, Math.min(call.data.limit ?? 100, 2)).map(id => product(id));
  return { data: { list, count: list.length } };
};
function setup({ value = block(), active = true, platform = 'H5', send = response, component = widget, props: extraProps } = {}) {
  const props = vue.reactive(extraProps ?? { block: value, active, headerTop: 0 });
  const r = runtime({ component, props, platform, send });
  return { ...r, props, pinia: pinia.getActivePinia(), c: component === widget ? r.checkout.state : null };
}

/** An owned clock advances real controller timeout callbacks without sleeping.
 * The native request bridge and Vue microtasks remain the shared real loader. */
async function clocked(work) {
  const before = { now: Date.now, window: global.window, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  let now = origin, next = 1;
  const timers = new Map();
  Date.now = () => now;
  global.window = { location: { origin: 'https://owned-promotion.example', hostname: 'owned-promotion.example', search: '' } };
  global.setTimeout = (callback, delay = 0, ...args) => { const id = next++; timers.set(id, { at: now + Number(delay), callback: () => callback(...args) }); return id; };
  global.clearTimeout = id => timers.delete(id);
  const advance = value => { now = value; let turns = 0; for (;;) { const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; assert.ok(++turns < 1000, 'Owned clock runaway'); timers.delete(due[0]); due[1].callback(); } };
  try { await work(advance); }
  finally { Date.now = before.now; global.setTimeout = before.setTimeout; global.clearTimeout = before.clearTimeout; if (before.window === undefined) delete global.window; else global.window = before.window; }
}
function compile(file) {
  const sfc = require('@vue/compiler-sfc'), dom = require('@vue/compiler-dom'), descriptor = sfc.parse(fs.readFileSync(file, 'utf8'), { filename: file }).descriptor;
  const result = dom.compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, bindingMetadata: sfc.compileScript(descriptor, { id: 'promotion-author-real-template' }).bindings, isCustomElement: tag => ['view', 'text', 'image', 'scroll-view'].includes(tag) });
  return new Function('Vue', result.code)(vue);
}
function nodes(tree, predicate) { const found = []; function visit(node) { if (predicate(node)) found.push(node); for (const child of node.children ?? []) visit(child); } visit(tree); return found; }
const css = (tree, name) => nodes(tree, node => String(node.props?.class ?? '').split(' ').includes(name));
const text = node => (node.text ?? '') + (node.children ?? []).map(text).join('');
function fire(node, name, event = { stopPropagation() {} }) { const callback = node?.props?.[name]; assert.ok(callback, `Missing native ${name}`); for (const fn of Array.isArray(callback) ? callback : [callback]) fn(event); }
function mount(r, instances = [{ props: r.props, state: r.checkout }]) {
  const childFile = path.join(root, 'src/components/diy/DiyListWidget.vue'), cardFile = path.join(root, 'src/components/diy/DiyListProductCard.vue');
  const child = r.load(childFile).default, original = child.setup, children = [], measurements = [];
  child.setup = (props, context) => { const state = original(props, context), entry = { props, state: state.state, setup: state, disposed: false }; children.push(entry); vue.onScopeDispose(() => { entry.disposed = true; }); return state; };
  child.render = compile(childFile);
  r.load(cardFile).default.render = compile(cardFile);
  const actual = r.load(path.join(root, 'src', widget)).default, render = compile(path.join(root, 'src', widget));
  const views = instances.map(entry => ({ ...actual, render, setup: () => entry.state }));
  const node = tag => ({ tag, props: {}, children: [], parent: null, text: '' });
  const renderer = vue.createRenderer({ createElement: node, createText: value => ({ ...node('#text'), text: value }), createComment: value => ({ ...node('#comment'), text: value }),
    setText(n, value) { n.text = value; }, setElementText(n, value) { n.text = value; for (const child of n.children) child.parent = null; n.children = []; },
    parentNode: n => n?.parent ?? null,
    nextSibling(n) { if (!n?.parent) return null; const siblings = n.parent.children; return siblings[siblings.indexOf(n) + 1] ?? null; },
    patchProp: (n, key, _old, value) => { n.props[key] = value; },
    insert(n, parent, anchor = null) { if (n.parent) n.parent.children = n.parent.children.filter(child => child !== n); const index = anchor ? parent.children.indexOf(anchor) : -1; n.parent = parent; if (index < 0) parent.children.push(n); else parent.children.splice(index, 0, n); },
    remove(n) { if (n?.parent) { n.parent.children = n.parent.children.filter(child => child !== n); n.parent = null; } },
  });
  r.uni.createSelectorQuery = () => { let instance; const query = { in(value) { instance = value; assert.ok(instance); return query; }, select(selector) { assert.equal(selector, '.diy-list-product'); return query; }, boundingClientRect(callback) { measurements.push({ callback, instance }); return query; }, exec() {} }; return query; };
  const app = renderer.createApp({ setup: () => () => vue.h(vue.Fragment, instances.map((entry, index) => vue.h(views[index], { ...entry.props }))) });
  const warnings = [], errors = [];
  app.config.warnHandler = message => warnings.push(message); app.config.errorHandler = reason => errors.push(reason);
  app.use(r.pinia); const tree = node('root'); app.mount(tree);
  return { app, tree, children, measurements, warnings, errors, current: () => children.filter(entry => !entry.disposed).at(-1),
    assertClean() { assert.deepEqual(errors.map(String), []); assert.deepEqual(warnings, []); },
    unmount() { app.unmount(); child.setup = original; } };
}
function finish(r, m) { try { m?.assertClean(); } finally { m?.unmount(); r.stop(); } }

for (const style of [0, 1, 2, 3, 4]) test(`actual installed Vue style${style} retains the fixed PHP navigation branches and delegated real product cards`, () => clocked(async () => {
  const r = setup({ value: block({ styleConfig: { tabVal: style } }) }), m = mount(r);
  try {
    await tick(); m.assertClean(); assert.equal(products(r).length, 1); assert.equal(m.current().state.loaded.value, true);
    assert.equal(css(m.tree, 'diy-list-widget').length, 1); assert.equal(css(m.tree, 'diy-list-product').length, 1); assert.equal(css(m.tree, 'list-waterfall').length, 1);
    assert.equal(css(m.tree, 'promotion-nav')[0].props.style.top, '0px', 'non-sticky navigation stays in normal flow');
    assert.equal(css(m.tree, 'promotion-description').length, style === 0 ? 2 : 0);
    assert.equal(css(m.tree, 'promotion-line').length, style === 1 || style === 2 ? 2 : 0);
    assert.equal(css(m.tree, 'promotion-image-wrap').length, style === 4 ? 2 : 0);
    const first = css(m.tree, 'promotion-text')[0], second = css(m.tree, 'promotion-text')[1];
    assert.equal(first.props.style.fontSize, ['30rpx', '32rpx', '32rpx', '26rpx', '24rpx'][style]);
    assert.equal(second.props.style.fontSize, ['30rpx', '28rpx', '28rpx', '28rpx', '24rpx'][style]);
    assert.equal(first.props.style.lineHeight, ['42rpx', '44rpx', '44rpx', '48rpx', '40rpx'][style]);
    if (style === 1) assert.equal(first.props.style.color, '#282828');
    if (style >= 3) { assert.equal(first.props.style.color, '#ffffff'); assert.match(first.props.style.background, /^linear-gradient\(90deg,/); }
    if (style === 2) { const line = css(m.tree, 'promotion-line')[0]; assert.equal(line.props.style.width, '64rpx'); assert.equal(line.props.style.border, '4rpx solid transparent'); }
    if (style === 4) { assert.equal(css(m.tree, 'promotion-image-wrap')[0].props.style.width, '104rpx'); assert.equal(nodes(css(m.tree, 'promotion-image-wrap')[0], n => n.tag === 'image')[0].props.style.width, '92rpx'); }
    assert.equal(m.current().state.config.value.imageStyle.borderRadius, '16rpx 16rpx 0 0'); assert.match(text(m.tree), /真实商品601/);
    assert.deepEqual(r.navigations, []); assert.deepEqual(r.calls.filter(call => !call.url.endsWith('/products')), []);
  } finally { finish(r, m); }
}));

test('fixed PHP theme/custom selected colors gradients decorations and raw zero spacing are exact pure projections', () => clocked(async () => {
  const r = setup({ active: false });
  try {
    const normalize = r.load(path.join(root, 'src/utils/diyPromotion.ts')).normalizeDiyPromotion, theme = { theme: '#a11020', gradient: '#eebbcc' };
    for (let style = 0; style < 5; style++) {
      const value = block({ styleConfig: { tabVal: style }, toneConfig: { tabVal: 1 }, decorateColor: { color: [{ item: '#112233' }, { item: '#445566' }] }, decorateColor2: { color: [{ item: '#778899' }] }, textColor2: { color: [{ item: '#abcdef' }] }, topConfig: { val: '0' }, prConfig: { val: '5e-4' }, bottomConfig: { val: ' 2 ' }, mbConfig: { val: 0 } }), before = copy(value);
      const custom = normalize(value, theme), themed = normalize({ ...value, toneConfig: { tabVal: 0 } }, theme);
      assert.equal(custom.activeTextStyle.color, style === 1 ? '#282828' : style >= 3 ? '#ffffff' : '#abcdef');
      assert.equal(themed.activeTextStyle.color, style === 1 ? '#282828' : style >= 3 ? '#ffffff' : '#a11020');
      assert.equal(custom.decorationStyle.background, 'linear-gradient(90deg, #112233 0%, #445566 100%)');
      if (style >= 3) assert.equal(custom.activeTextStyle.background, 'linear-gradient(90deg, #112233 0%, #445566 100%)');
      assert.equal(custom.wrapperStyle.padding, '0rpx 0.001rpx 4rpx'); assert.equal(custom.wrapperStyle.marginTop, '0rpx'); assert.deepEqual(value, before);
    }
    const base = block({ styleConfig: { tabVal: 4 } });
    const original = normalize(base, theme);
    const inert = normalize({ ...base, fillet: { type: 1, val: 99, valList: [{ val: 11 }, { val: 22 }, { val: 33 }, { val: 44 }] }, textColor: { color: [{ item: '#123456' }] }, textColor3: { color: [{ item: '#654321' }] }, decorateColor2: { color: [{ item: '#fedcba' }] } }, theme);
    assert.deepEqual(inert, original, 'Preserved PHP author metadata is not invented as public navigation CSS');
    assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
}));

for (const [source, kind, field, ids] of [[1, 'product', 'ids', [601, '602']], [2, 'brand', 'brand_id', [11, '12']], [3, 'category', 'cate_id', [21, '22']], [4, 'label', 'store_label_id', [31, '32']], [0, 'category', 'cate_id', [41, '42']]]) test(`actual delegated ${kind} source${source} sends its exact selected identities and fixed IDs omit sort`, () => clocked(async () => {
  const configured = tab(601, { tabVal: String(source), goodsSort: 2, goodsList: { ids: source === 1 ? ids : [999] }, brandConfig: { brandVal: source === 2 ? ids : [998] }, selectConfig: { activeValue: source === 0 || source === 3 ? ids : [997] }, goodsLabel: { activeValue: source === 4 ? ids : [996] }, numConfig: { val: ' 7e0 ' } });
  const value = block({ tabConfig: { tabCur: '99', list: [configured] } }), before = copy(value), r = setup({ value }), m = mount(r);
  try {
    await tick(); assert.equal(products(r).length, 1); assert.deepEqual(products(r)[0].data, { page: 1, limit: 7, [field]: ids.join(','), ...(source === 1 ? {} : { priceOrder: 'desc' }) });
    assert.equal(m.current().state.loaded.value, true); assert.equal(m.current().state.error.value, ''); assert.equal(r.c.selectedTab.value, 0); assert.deepEqual(r.props.block, before);
  } finally { finish(r, m); }
}));

test('actual child refuses empty malformed or oversized source vectors without any unscoped product I/O', () => clocked(async () => {
  for (const ids of [[], ['01'], ['1e2'], [{}], Array.from({ length: 101 }, (_, i) => i + 1)]) {
    const value = block({ tabConfig: { list: [tab(601, { goodsList: { ids, list: [{ id: 601 }] } })] } }), before = copy(value), r = setup({ value }), m = mount(r);
    try { await tick(); assert.deepEqual(products(r), []); assert.equal(m.current().state.products.value.length, 0); assert.deepEqual(r.props.block, before); assert.equal(m.current().state.loaded.value, ids.length === 0); }
    finally { finish(r, m); }
  }
}));

for (const [label, source] of [['bad', 'bad'], ['null', null], ['empty', ''], ['object', {}], ['array', []], ['boolean', false]]) test(`actual delegated ${label} source import refuses product I/O instead of falling through to retained category IDs`, () => clocked(async () => {
  const value = block({ tabConfig: { list: [tab(601, { tabVal: source, selectConfig: { activeValue: [29] }, brandConfig: { brandVal: [23] }, goodsLabel: { activeValue: [37] } })] } }), before = copy(value), r = setup({ value }), m = mount(r);
  try {
    await tick(); assert.equal(r.c.ready(), true); assert.equal(m.current().state.config.value.query, null); assert.match(m.current().state.error.value, /商品范围配置无效/);
    assert.equal(m.current().state.loaded.value, false); assert.deepEqual(r.calls, []); assert.equal(css(m.tree, 'diy-list-product').length, 0); assert.deepEqual(r.props.block, before);
  } finally { finish(r, m); }
}));

test('product material fallback is used only when ids is absent/null and preserves imported strings/objects', () => clocked(async () => {
  for (const ids of [undefined, null]) {
    const value = block({ tabConfig: { list: [tab(601, { goodsList: { ...(ids === undefined ? {} : { ids }), list: [{ id: '601', image: asset(99) }, { value: 602 }] } })] } }), before = copy(value), r = setup({ value }), m = mount(r);
    try { await tick(); assert.equal(products(r)[0].data.ids, '601,602'); assert.equal(m.current().state.products.value.length, 2); assert.deepEqual(r.props.block, before); }
    finally { finish(r, m); }
  }
}));

test('public initial selection ignores tabCur and renders first12 while every imported overflow row stays intact', () => clocked(async () => {
  const value = block({ tabConfig: { tabCur: ' 15e0 ', list: Array.from({ length: 16 }, (_, i) => tab(601 + i, { keep: [false, i], numConfig: { val: '002' } })) } }), before = copy(value), r = setup({ value }), m = mount(r);
  try {
    await tick(); assert.equal(r.c.selectedTab.value, 0); assert.equal(r.c.config.value.tabs.length, 12); assert.equal(css(m.tree, 'promotion-tab').length, 12); assert.equal(r.c.config.value.overflow, true);
    r.c.select(15); await tick(); assert.equal(r.c.selectedTab.value, 0); assert.equal(products(r).length, 1); assert.deepEqual(r.props.block, before);
    fire(css(m.tree, 'promotion-tab')[11], 'onTap'); await tick(); assert.equal(r.c.selectedTab.value, 11); assert.equal(products(r).at(-1).data.ids, '612'); assert.equal(r.props.block.tabConfig.list.length, 16); assert.deepEqual(r.props.block, before);
  } finally { finish(r, m); }
}));

test('actual delegated quantity projection preserves zero tiny numeric-string scientific and overflow imports', () => clocked(async () => {
  for (const [raw, quantity] of [[0, 0], ['0', 0], ['5e-4', 0], [' 2e0 ', 2], ['003', 3], [10001, 100], ['bad', 6]]) {
    const value = block({ tabConfig: { list: [tab(601, { numConfig: { val: raw } })] } }), before = copy(value), r = setup({ value }), m = mount(r);
    try { await tick(); assert.equal(m.current().state.config.value.limit, quantity); assert.equal(products(r).length, quantity ? 1 : 0); if (quantity) assert.equal(products(r)[0].data.limit, quantity); assert.deepEqual(r.props.block, before); }
    finally { finish(r, m); }
  }
}));

test('actual compiled HomeRenderer selects promotion coupon points presale independently and leaves no remaining Commerce families', () => clocked(async () => {
  const components = [block(), ...['seckill', 'combination', 'bargain', 'presale', 'pointsMall', 'coupon', 'liveBroadcast'].map((name, i) => ({ name, timestamp: i + 200 }))];
  const r = setup({ component: 'components/diy/DiyHomeRenderer.vue', props: { components, pageActive: false, pageRefreshing: false, microPage: false, scrollTop: 0, loadMoreSignal: 0 } });
  try {
    const file = path.join(root, 'src/components/diy/DiyHomeRenderer.vue'), render = compile(file), state = vue.proxyRefs(r.checkout), context = { ...r.props, ...state };
    const vnode = render.call(context, context, [], r.props, state, {}, {}), found = [];
    function visit(node) { if (Array.isArray(node)) return node.forEach(visit); if (!node || typeof node !== 'object') return; found.push(node); visit(node.children); }
    visit(vnode);const bargain=r.load(path.join(root,'src/components/diy/DiyBargainWidget.vue')).default;const seckill=r.load(path.join(root,'src/components/diy/DiySeckillWidget.vue')).default;const live=r.load(path.join(root,'src/components/diy/DiyLiveBroadcastWidget.vue')).default;
    const promotion = r.load(path.join(root, 'src', widget)).default, commerce = r.load(path.join(root, 'src/components/diy/DiyCommerceWidget.vue')).default;
    const coupon = r.load(path.join(root, 'src/components/diy/DiyCouponWidget.vue')).default, points = r.load(path.join(root, 'src/components/diy/DiyPointsWidget.vue')).default;
    const presale = r.load(path.join(root, 'src/components/diy/DiyPresaleWidget.vue')).default;
    const combination = r.load(path.join(root, 'src/components/diy/DiyCombinationWidget.vue')).default;
    const chosen = found.filter(node => [promotion, coupon, points, presale, combination, live, seckill, bargain, commerce].includes(node.type));
    assert.equal(chosen.length, 8); assert.equal(chosen[0].type, promotion); assert.equal(chosen[0].props.block.name, 'promotionList'); assert.equal(chosen[0].props.active, false);
    assert.deepEqual(chosen.filter(node => node.type === commerce).map(node => node.props.block.name), []);assert.equal(chosen.find(node=>node.props.block.name==='combination').type,combination);assert.equal(r.checkout.isCommerceWidget({name:'combination'}),false);assert.equal(chosen.find(node=>node.props.block.name==='bargain').type,bargain);assert.equal(r.checkout.isCommerceWidget({name:'bargain'}),false);assert.equal(chosen.find(node=>node.props.block.name==='seckill').type,seckill);assert.equal(r.checkout.isCommerceWidget({name:'seckill'}),false);assert.equal(chosen.find(node=>node.props.block.name==='liveBroadcast').type,live);assert.equal(r.checkout.isCommerceWidget({name:'liveBroadcast'}),false);
    assert.equal(chosen.find(node => node.props.block.name === 'presale').type, presale);assert.equal(r.checkout.isCommerceWidget({name:'presale'}),false);
    assert.equal(chosen.find(node => node.props.block.name === 'coupon').type, coupon); assert.equal(chosen.find(node => node.props.block.name === 'pointsMall').type, points);
    assert.equal(r.checkout.isCommerceWidget({ name: 'promotionList' }), false); assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
}));

for (const boundary of ['tab', 'owner', 'token', 'session', 'raw', 'disabled', 'hidden', 'dispose']) test(`real list receipt cannot cross the promotion ${boundary} context`, () => clocked(async () => {
  const pending = deferred(); let count = 0;
  const r = setup({ send: call => ++count === 1 ? pending.promise : response(call) }), m = mount(r);
  try {
    await tick(); assert.equal(products(r).length, 1); const old = m.current(), capturedTab = r.c.tabs.value[1];
    if (boundary === 'tab') fire(css(m.tree, 'promotion-tab')[1], 'onTap');
    else if (boundary === 'owner') r.auth.setLogin('owner22', 22);
    else if (boundary === 'token') r.auth.setLogin('token2', r.auth.uid);
    else if (boundary === 'session') r.auth.setLogin(r.auth.token, r.auth.uid);
    else if (boundary === 'raw') r.props.block = block({ timestamp: 999, tabConfig: { list: [tab(602)] } });
    else if (boundary === 'disabled') r.props.block.isHide = true;
    else if (boundary === 'hidden') r.props.active = false;
    else r.c.dispose();
    await tick(); capturedTab.tap(); capturedTab.failed(); capturedTab.loaded();
    pending.resolve({ data: { list: [product(999)], count: 1 } }); await tick();
    assert.equal(old.state.products.value.some(row => row.id === 999), false); assert.equal(css(m.tree, 'diy-list-product').some(node => node.props['data-product-id'] === 999), false);
    assert.deepEqual(r.navigations, []); assert.deepEqual(r.c.imageFailures.value, {});
    if (['disabled', 'hidden', 'dispose'].includes(boundary)) assert.equal(css(m.tree, 'diy-list-widget').length, 0);
    else { assert.equal(m.current().state.loaded.value, true); assert.ok(m.current().state.products.value.length); }
  } finally { pending.resolve({ data: { list: [], count: 0 } }); finish(r, m); }
}));

test('late failed/finally response cannot overwrite or unlock a newer real selected-list read', () => clocked(async () => {
  const old = deferred(), fresh = deferred(); let count = 0;
  const r = setup({ send: () => ++count === 1 ? old.promise : fresh.promise }), m = mount(r);
  try {
    await tick(); fire(css(m.tree, 'promotion-tab')[1], 'onTap'); await tick(); const selected = m.current(); assert.equal(selected.state.loading.value, true);
    old.resolve({ httpStatus: 503, msg: 'old explicit failure' }); await tick(); assert.equal(selected.state.loading.value, true); assert.equal(selected.state.error.value, '');
    fresh.resolve({ data: { list: [product(602)], count: 1 } }); await tick(); assert.equal(selected.state.products.value[0].id, 602); assert.equal(selected.state.loading.value, false);
  } finally { old.resolve({ data: { list: [], count: 0 } }); fresh.resolve({ data: { list: [], count: 0 } }); finish(r, m); }
}));

test('same-page promotion instances retain independent selected tabs child scopes and delayed responses', () => clocked(async () => {
  const pending = deferred(); let first = true;
  const r = setup({ send: call => first ? (first = false, pending.promise) : response(call) });
  const props2 = vue.reactive({ block: block({ timestamp: 202, tabConfig: { list: [tab(701), tab(702)] } }), active: true, headerTop: 0 });
  const scope = vue.effectScope(), state2 = scope.run(() => r.load(path.join(root, 'src', widget)).default.setup(props2, { expose() {}, emit() {} }));
  const m = mount(r, [{ props: r.props, state: r.checkout }, { props: props2, state: state2 }]);
  try {
    await tick(); assert.equal(products(r).length, 2); assert.equal(state2.state.selectedTab.value, 0); assert.equal(m.children.find(row => row.state.config.value.identity === '202:0').state.products.value[0].id, 701);
    state2.state.select(1); await tick(); assert.equal(state2.state.selectedTab.value, 1); assert.equal(r.c.selectedTab.value, 0); assert.equal(products(r).at(-1).data.ids, '702');
    r.c.dispose(); pending.resolve({ data: { list: [product(999)], count: 1 } }); await tick();
    assert.equal(m.children.some(row => row.state.products.value.some(value => value.id === 999)), false); assert.equal(css(m.tree, 'diy-list-product').some(node => node.props['data-product-id'] === 702), true);
  } finally { pending.resolve({ data: { list: [], count: 0 } }); scope.stop(); finish(r, m); }
}));

for (const platform of ['H5', 'APP-PLUS', 'MP-WEIXIN']) test(`${platform} ticket-only renewal retains selected real child/feed and invalidates old tab native closures`, () => clocked(async () => {
  const value = block(); value.tabConfig.list[0].image = asset(); value.tabConfig.list[1].image = asset(8);
  const r = setup({ value, platform }), m = mount(r);
  try {
    await tick(); fire(css(m.tree, 'promotion-tab')[1], 'onTap'); await tick();
    const selected = m.current(), rows = selected.state.products.value, before = products(r).length, epoch = r.c.epoch.value, fingerprint = r.c.fingerprint.value, old = r.c.tabs.value[0];
    assert.equal(r.c.selectedTab.value, 1); assert.equal(old.current(), true);
    r.props.block = { ...r.props.block, tabConfig: { ...r.props.block.tabConfig, list: r.props.block.tabConfig.list.map((row, i) => ({ ...row, image: asset(i ? 8 : 7, origin + 1800000) })) } };
    await tick(); assert.equal(r.c.selectedTab.value, 1); assert.equal(r.c.epoch.value, epoch); assert.equal(r.c.fingerprint.value, fingerprint); assert.strictEqual(m.current(), selected); assert.strictEqual(m.current().state.products.value, rows); assert.equal(products(r).length, before);
    assert.equal(old.current(), false); old.tap(); old.failed(); old.loaded(); assert.equal(r.c.selectedTab.value, 1); assert.deepEqual(r.c.imageFailures.value, {});
    const current = r.c.tabs.value[1]; current.failed(); assert.equal(r.c.imageFailures.value[1], true); current.loaded(); assert.equal(r.c.imageFailures.value[1], false);
  } finally { finish(r, m); }
}));

test('an unchanged in-flight selected product response survives ticket refresh without a second request', () => clocked(async () => {
  const pending = deferred(), value = block(); value.tabConfig.list[0].image = asset();
  const r = setup({ value, send: () => pending.promise }), m = mount(r);
  try { await tick(); const child = m.current(); r.props.block.tabConfig.list[0].image = asset(7, origin + 1800000); await tick(); assert.equal(products(r).length, 1); assert.strictEqual(m.current(), child); pending.resolve(response({ url: '/products', data: { ids: '601', limit: 2 } })); await tick(); assert.equal(child.state.products.value[0].id, 601); assert.equal(products(r).length, 1); }
  finally { pending.resolve({ data: { list: [], count: 0 } }); finish(r, m); }
}));

test('exact reserved image expiry removes real child/media and retires captured tap/load/error before a fresh lease', () => clocked(async advance => {
  const value = block(); value.tabConfig.list[0].image = asset();
  const r = setup({ value }), m = mount(r);
  try {
    await tick(); const old = r.c.tabs.value[0], oldNode = css(m.tree, 'promotion-tab')[0], image = nodes(oldNode, node => node.tag === 'image')[0], captured = { tap: oldNode.props.onTap, loaded: image.props.onLoad, failed: image.props.onError };
    advance(origin + 839999); assert.equal(r.c.ready(), true); advance(origin + 840000); await tick(); assert.equal(r.c.ready(), false); assert.equal(old.current(), false); assert.equal(css(m.tree, 'diy-list-widget').length, 0); assert.equal(nodes(m.tree, node => node.tag === 'image').length, 0); assert.match(text(m.tree), /授权已失效/);
    captured.tap(); captured.loaded(); captured.failed(); assert.deepEqual(r.c.imageFailures.value, {});
    r.props.block.tabConfig.list[0].image = asset(7, origin + 1800000); await tick(); assert.equal(r.c.ready(), true); assert.equal(m.current().state.loaded.value, true);
    captured.failed(); captured.tap(); assert.deepEqual(r.c.imageFailures.value, {}); assert.deepEqual(r.navigations, []);
  } finally { finish(r, m); }
}));

for (const platform of ['H5', 'APP-PLUS', 'MP-WEIXIN']) test(`${platform} invalid expired duplicate or unsigned authored tab image cannot authorize delegated product reads`, () => clocked(async () => {
  for (const image of ['/api/assets/7', asset(7, origin), asset(7, origin + 60000), asset() + '&expires=1', asset() + '&%73ignature=' + signature, asset().replace(signature, 'x')]) {
    const value = block(); value.tabConfig.list[0].image = image;
    const r = setup({ value, platform }), m = mount(r);
    try { await tick(); assert.equal(r.c.ready(), false); assert.deepEqual(r.calls, []); assert.equal(css(m.tree, 'diy-list-widget').length, 0); assert.equal(nodes(m.tree, node => node.tag === 'image').length, 0); }
    finally { finish(r, m); }
  }
}));

test('every exact dormant/overflow tab image participates in lease while nested business image metadata does not', () => clocked(async () => {
  const value = block({ styleConfig: { tabVal: 0 } }); value.tabConfig.list[0].goodsList.list = [{ id: 601, image: '/api/assets/999' }];
  const r = setup({ value }), m = mount(r);
  try {
    await tick(); assert.equal(r.c.ready(), true); assert.equal(products(r).length, 1);
    r.props.block.tabConfig.list.push(...Array.from({ length: 11 }, (_, i) => tab(i + 700))); r.props.block.tabConfig.list[12].image = '/api/assets/7'; await tick();
    assert.equal(r.c.config.value.tabs.length, 12); assert.equal(r.c.ready(), false); assert.equal(css(m.tree, 'diy-list-widget').length, 0); assert.equal(r.props.block.tabConfig.list.length, 13);
  } finally { finish(r, m); }
}));

for (const platform of ['H5', 'APP-PLUS', 'MP-WEIXIN']) test(`${platform} actual tab image template keeps bundled static sources local and managed capabilities at API authority`, () => clocked(async () => {
  const value = block(); value.tabConfig.list[0].image = '/static/images/diy/title.png'; value.tabConfig.list[1].image = asset(8);
  const r = setup({ value, platform }), m = mount(r);
  try {
    await tick(); const images = css(m.tree, 'promotion-image-wrap').map(wrapper => nodes(wrapper, node => node.tag === 'image')[0]);
    assert.equal(images[0].props.src, '/static/images/diy/title.png');
    assert.equal(images[1].props.src, `${platform === 'H5' ? '' : 'https://cinashop-api.cinagroup.workers.dev'}${asset(8)}`);
    const old = { tap: css(m.tree, 'promotion-tab')[0].props.onTap, failed: images[0].props.onError, loaded: images[0].props.onLoad };
    r.props.block.tabConfig.list[0].image = '/static/images/diy/other.png'; await tick(); old.failed(); old.loaded(); old.tap(); assert.deepEqual(r.c.imageFailures.value, {});
    assert.equal(nodes(css(m.tree, 'promotion-image-wrap')[0], node => node.tag === 'image')[0].props.src, '/static/images/diy/other.png');
  } finally { finish(r, m); }
}));

test('native Mini Program without window or URL global admits the exact head lease and real child response', () => clocked(async () => {
  const beforeWindow = global.window, beforeURL = global.URL; global.window = undefined; global.URL = undefined;
  let r, m;
  try { const value = block(); value.tabConfig.list[0].image = asset(); r = setup({ value, platform: 'MP-WEIXIN' }); m = mount(r); await tick(); assert.equal(r.c.ready(), true); assert.equal(products(r).length, 1); assert.equal(m.current().state.loaded.value, true); }
  finally { if (r) finish(r, m); global.window = beforeWindow; global.URL = beforeURL; }
}));

test('captured old product card tap cannot navigate the new selected tab even when product IDs overlap', () => clocked(async () => {
  const r = setup({ send: call => ({ data: { list: [product(601)], count: 1 } }) }), m = mount(r);
  try {
    await tick(); const oldChild = m.current(), oldTap = css(m.tree, 'diy-list-product')[0].props.onTap;
    fire(css(m.tree, 'promotion-tab')[1], 'onTap'); await tick(); assert.equal(m.current().state.products.value[0].id, 601);
    oldTap(); await tick(); assert.deepEqual(r.navigations, []); assert.equal(oldChild.disposed, true);
    fire(css(m.tree, 'diy-list-product')[0], 'onTap'); await tick(); assert.deepEqual(r.navigations, ['/pages/goods/detail?id=601']);
  } finally { finish(r, m); }
}));

for (const platform of ['H5', 'APP-PLUS', 'MP-WEIXIN']) test(`${platform} A-to-B-to-A tab selection never revives captured original native tap/load/error leases`, () => clocked(async () => {
  const r = setup({ platform }), m = mount(r);
  try {
    await tick(); const first = r.c.tabs.value[0], other = r.c.tabs.value[1], firstNode = css(m.tree, 'promotion-tab')[0], otherNode = css(m.tree, 'promotion-tab')[1];
    const image = nodes(firstNode, node => node.tag === 'image')[0], old = { tap: otherNode.props.onTap, loaded: image.props.onLoad, failed: image.props.onError };
    const originalNativeEpoch = r.c.nativeEpoch.value;
    fire(otherNode, 'onTap'); await tick(); assert.equal(r.c.selectedTab.value, 1); assert.ok(r.c.nativeEpoch.value > originalNativeEpoch); assert.equal(first.current(), false); assert.equal(other.current(), false);
    fire(css(m.tree, 'promotion-tab')[0], 'onTap'); await tick(); assert.equal(r.c.selectedTab.value, 0); assert.equal(first.current(), false); assert.equal(other.current(), false);
    const reads = products(r).length; assert.equal(reads, 3);
    old.failed(); assert.deepEqual(r.c.imageFailures.value, {}); old.loaded(); assert.deepEqual(r.c.imageFailures.value, {}); old.tap(); await tick();
    assert.equal(r.c.selectedTab.value, 0); assert.equal(products(r).length, reads); assert.deepEqual(r.navigations, []);
    const current = r.c.tabs.value[0]; current.failed(); assert.equal(r.c.imageFailures.value[0], true); current.loaded(); assert.equal(r.c.imageFailures.value[0], false);
  } finally { finish(r, m); }
}));

for (const platform of ['H5', 'APP-PLUS', 'MP-WEIXIN']) test(`${platform} actual navigation applies host offsets only while sticky`, () => clocked(async () => {
  const r = setup({ platform }), m = mount(r);
  try {
    await tick(); const nav = () => css(m.tree, 'promotion-nav')[0];
    assert.equal(nav().props.style.top, '0px');
    r.props.headerTop = 23; await tick(); assert.equal(nav().props.style.top, '0px');
    r.props.block.slideConfig.tabVal = 0; await tick();
    assert.equal(nav().props.style.top, 'calc(var(--window-top, 0px) + 23px)');
    assert.ok(String(nav().props.class).includes('sticky'));
    r.props.block.slideConfig.tabVal = 1; await tick();
    assert.equal(nav().props.style.top, '0px'); assert.ok(!String(nav().props.class).includes('sticky'));
  } finally { finish(r, m); }
}));
