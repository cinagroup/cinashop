const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vue = require('vue');
const pinia = require('pinia');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const root = path.resolve(__dirname, '..'), widget = 'components/diy/DiyCouponWidget.vue', card = 'components/diy/DiyCouponCard.vue';
const copy = value => JSON.parse(JSON.stringify(value));
const block = (extra = {}) => ({ name: 'coupon', timestamp: 101, isHide: false, styleConfig: { tabVal: 0 }, toneConfig: { tabVal: 0 }, numberConfig: { val: 5 }, spacingConfig: { val: 6 }, fillet: { type: 0, val: 8 }, ...extra });
const coupon = (id = 901, extra = {}) => ({ id, type: 0, coupon_type: 1, coupon_title: `当前公开券${id}`, coupon_price: '5.00', use_min_price: '0.00', is_use: false, remain_count: 8, receive_limit: 1, ...extra });
const receipt = rows => ({ data: { list: rows, count: [rows.length, 0, 0, 0] } });
const readCalls = r => r.calls.filter(call => call.url.endsWith('/v2/coupons'));
const claimCalls = r => r.calls.filter(call => call.url.endsWith('/coupon/receive'));
const journalKey = (uid = 11, id = 901) => `cinashop_diy_coupon_claim_v1_${uid}_${id}`;
const journal = (uid = 11, id = 901, state = 'unknown') => JSON.stringify({ version: 1, actor: uid, issue: id, attempt: '1700000000000:1', state, couponUserId: state === 'acknowledged' ? 3001 : null });
function setup({ value = block(), active = true, platform = 'H5', send, authenticated = true, storage = new Map(), rows = [coupon()] } = {}) {
  const props = vue.reactive({ block: value, active });
  const answer = call => { if (call.url.endsWith('/v2/coupons')) return receipt(rows.slice(0, call.data.limit)); if (call.url.endsWith('/coupon/receive')) return { data: { couponUserId: 3001 } }; throw Error(`Unexpected coupon I/O ${call.url}`); };
  // Bootstrap only the pure Card setup in the shared real module/Pinia loader.
  // The Widget/controller are then genuinely mounted under Vue below, so app
  // unmount owns their real onScopeDispose hooks and captured native leases.
  const loaded = runtime({ component: card, props: {}, platform, authenticated, storage, send: send ?? answer });
  const r = { ...loaded, props, pinia: pinia.getActivePinia() };
  Object.defineProperties(r, { c: { get: () => r.checkout.state }, entries: { get: () => r.checkout.entries.value }, actions: { get: () => r.checkout.actions.value }, view: { get: () => r.checkout.view.value } });
  return r;
}
function compile(file) {
  const sfc = require('@vue/compiler-sfc'), dom = require('@vue/compiler-dom'), descriptor = sfc.parse(fs.readFileSync(file, 'utf8'), { filename: file }).descriptor;
  return new Function('Vue', dom.compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, bindingMetadata: sfc.compileScript(descriptor, { id: 'coupon-author-real-template' }).bindings, isCustomElement: tag => ['view', 'text', 'image', 'scroll-view'].includes(tag) }).code)(vue);
}
function nodes(tree, predicate) { const found = []; function visit(node) { if (predicate(node)) found.push(node); for (const child of node.children ?? []) visit(child); } visit(tree); return found; }
const css = (tree, name) => nodes(tree, node => String(node.props?.class ?? '').split(' ').includes(name));
const text = node => (node.text ?? '') + (node.children ?? []).map(text).join('');
function fire(node, key = 'onTap') { const fn = node?.props?.[key]; assert.ok(fn, `Missing real native ${key}`); for (const callback of Array.isArray(fn) ? fn : [fn]) callback({ stopPropagation() {} }); }
function mount(r, propsList = [r.props]) {
  const file = path.join(root, 'src', widget), actual = r.load(file).default, original = actual.setup, instances = [];
  actual.setup = (props, context) => { const state = original(props, context), instance = { props, state, disposed: false }; instances.push(instance); if (instances.length === 1) r.checkout = state; vue.onScopeDispose(() => { instance.disposed = true; }); return state; };
  actual.render = compile(file); r.load(path.join(root, 'src', card)).default.render = compile(path.join(root, 'src', card));
  const node = tag => ({ tag, props: {}, children: [], parent: null, text: '' });
  const renderer = vue.createRenderer({ createElement: node, createText: value => ({ ...node('#text'), text: value }), createComment: value => ({ ...node('#comment'), text: value }),
    setText(n, value) { n.text = value; }, setElementText(n, value) { n.text = value; for (const child of n.children) child.parent = null; n.children = []; },
    parentNode: n => n?.parent ?? null, nextSibling(n) { if (!n?.parent) return null; const siblings = n.parent.children; return siblings[siblings.indexOf(n) + 1] ?? null; }, patchProp: (n, key, _old, value) => { n.props[key] = value; },
    insert(n, parent, anchor = null) { if (n.parent) n.parent.children = n.parent.children.filter(child => child !== n); const index = anchor ? parent.children.indexOf(anchor) : -1; n.parent = parent; if (index < 0) parent.children.push(n); else parent.children.splice(index, 0, n); },
    remove(n) { if (n?.parent) { n.parent.children = n.parent.children.filter(child => child !== n); n.parent = null; } },
  });
  const app = renderer.createApp({ setup: () => () => vue.h(vue.Fragment, propsList.map((props, index) => vue.h(actual, { ...props, key: index }))) });
  const warnings = [], errors = []; app.config.warnHandler = value => warnings.push(value); app.config.errorHandler = value => errors.push(value); app.use(r.pinia); const tree = node('root'); app.mount(tree); let alive = true;
  return { app, tree, instances, assertClean() { assert.deepEqual(warnings, []); assert.deepEqual(errors.map(String), []); }, unmount() { if (alive) { alive = false; app.unmount(); actual.setup = original; } } };
}
function finish(r, m) { try { m?.assertClean(); } finally { m?.unmount(); r.stop(); } }

for (const style of [0, 1, 2, 3, 4]) test(`real installed Vue coupon style${style} renders the original PHP card dimensions branches and seven real rows`, async () => {
  const value = block({ styleConfig: { tabVal: style }, numberConfig: { val: 7 }, spacingConfig: { val: 19 } }), before = copy(value);
  const r = setup({ value, rows: Array.from({ length: 7 }, (_, index) => coupon(index + 901, { type: index % 4, coupon_type: index % 2 + 1, coupon_price: index % 2 ? '85.00' : '5.00', use_min_price: index % 2 ? '20.00' : '0.00' })) }), m = mount(r);
  try {
    await tick(); assert.equal(r.c.loaded.value, true); assert.equal(r.c.error.value, ''); assert.equal(readCalls(r).length, 1); assert.deepEqual(readCalls(r)[0].data, { page: 1, limit: 7 });
    const cards = css(m.tree, 'coupon-card'); assert.equal(cards.length, 7, 'Public style3 has no Admin-demo four-item cutoff');
    assert.equal(cards[0].props.style.width, ['156rpx', '204rpx', '274rpx', '140rpx', '228rpx'][style]); assert.equal(cards[0].props.style.height, ['156rpx', '232rpx', '150rpx', '132rpx', '108rpx'][style]);
    assert.equal(cards[0].props.style.marginRight, style === 3 ? '38rpx' : '12rpx');
    assert.equal(css(m.tree, 'coupon-scope').length, style === 1 || style === 3 ? 7 : 0); assert.equal(css(m.tree, 'coupon-card-inner').length, style === 2 ? 7 : 0);
    assert.equal(css(m.tree, 'coupon-notch-top').length, style === 2 ? 7 : 0); assert.equal(css(m.tree, 'coupon-notch-bottom').length, style === 2 ? 7 : 0); assert.equal(css(m.tree, 'coupon-curve').length, style === 0 ? 7 : 0);
    assert.equal(css(m.tree, 'coupon-claim').length, style === 3 ? 0 : 7); assert.equal(css(m.tree, 'coupon-station').length, style === 3 ? 1 : 0);
    if (style === 3) { assert.equal(css(m.tree, 'coupon-station')[0].props.style.width, '296rpx'); assert.equal(css(m.tree, 'coupon-content')[0].props.style.padding, '20rpx 296rpx 20rpx 20rpx'); assert.equal(css(m.tree, 'coupon-centre')[0].props.style.width, '160rpx'); }
    if (style === 0) { assert.equal(css(m.tree, 'coupon-card-copy')[0].props.style.margin, '-20rpx auto 0'); assert.equal(css(m.tree, 'coupon-card-copy')[0].props.style.width, '144rpx'); assert.equal(css(m.tree, 'coupon-claim')[0].props.style.height, '76rpx'); }
    if (style === 1) { assert.equal(css(m.tree, 'coupon-claim')[0].props.style.width, '136rpx'); assert.equal(css(m.tree, 'coupon-claim')[0].props.style.height, '48rpx'); }
    if (style === 2) { assert.equal(css(m.tree, 'coupon-notch-top')[0].props.style.width, '16rpx'); assert.match(css(m.tree, 'coupon-divider')[0].props.style.borderLeft, /^1rpx dashed /); assert.equal(css(m.tree, 'coupon-claim')[0].props.style.width, '74rpx'); }
    if (style === 4) { assert.match(css(m.tree, 'coupon-card-copy')[0].props.style.background, /^radial-gradient\(circle at left 54rpx,/); assert.equal(css(m.tree, 'coupon-claim')[0].props.style.width, '56rpx'); }
    assert.match(text(m.tree), /8\.5折/); assert.match(text(m.tree), /无门槛券/); assert.match(text(m.tree), /满20\.00可用/); assert.equal(nodes(m.tree, node => node.tag === 'image').length, 0);
    assert.deepEqual(r.props.block, before); assert.deepEqual(claimCalls(r), []); assert.deepEqual(r.navigations, []);
  } finally { finish(r, m); }
});

for (const style of [0, 1, 2, 3, 4]) test(`PHP style${style} theme/custom colors use the active template including inline style4 condition override`, async () => {
  const r = setup({ active: false }), m = mount(r);
  try {
    const { couponPresentation } = r.load(path.join(root, '../common/diyCoupon.ts')), safeColor = r.load(path.join(root, 'src/utils/diy.ts')).safeDiyColor;
    const theme = { theme: '#a11020', gradient: '#eebbcc', priceColor: '#990000' }, value = block({ styleConfig: { tabVal: style }, toneConfig: { tabVal: 1 }, couponMoneyColor: { color: [{ item: '#123456' }] }, couponBgColor: { color: [{ item: '#654321' }] }, bntBgColor: { color: [{ item: '#112233' }, { item: '#445566' }] }, moduleColor: { color: [{ item: '#abcdef' }, { item: '#fedcba' }] }, moduleColor2: { color: [{ item: '#fefefe' }] } }), before = copy(value);
    const custom = couponPresentation(value, theme, safeColor), themed = couponPresentation({ ...value, toneConfig: { tabVal: 0 } }, theme, safeColor);
    assert.equal(custom.moneyStyle.color, '#123456'); assert.equal(themed.moneyStyle.color, '#a11020', 'PHP follows theme, not separate priceColor');
    assert.equal(custom.panelStyle.background, style === 1 ? 'linear-gradient(90deg, #abcdef 0%, #fedcba 100%)' : '#fefefe');
    assert.equal(custom.conditionStyle.color, style === 0 ? '#999999' : style === 3 ? '#333333' : '#123456');
    if (style === 2) { assert.equal(custom.actionStyle.background, 'transparent'); assert.equal(custom.actionStyle.color, '#123456'); }
    else if (style < 2) { assert.equal(custom.actionStyle.background, 'linear-gradient(180deg, #112233 0%, #445566 100%)'); assert.equal(themed.actionStyle.background, 'linear-gradient(90deg, #a11020 0%, #eebbcc 100%)'); }
    if (style === 0) assert.equal(custom.itemStyle.background, '#654321');
    if (style === 3) { assert.equal(custom.contentStyle.background, '#654321'); assert.equal(custom.nameStyle.color, '#123456'); assert.equal(custom.stationStyle.background, 'linear-gradient(180deg, #112233 0%, #445566 100%)'); assert.equal(themed.stationStyle.background, 'linear-gradient(0deg, #a11020 0%, #eebbcc 100%)'); }
    if (style === 4) { assert.equal(custom.itemStyle.background, 'linear-gradient(180deg, #112233 0%, #445566 100%)'); assert.equal(themed.itemStyle.background, 'linear-gradient(0deg, #a11020 0%, #eebbcc 100%)'); }
    assert.deepEqual(value, before); assert.deepEqual(r.calls, []);
  } finally { finish(r, m); }
});

test('raw zero/tiny spacing and nonsymmetric PHP corner0/1/3/2 geometry remain pure and complete', async () => {
  const value = block({ topConfig: { val: '0' }, prConfig: { val: '5e-4' }, bottomConfig: { val: ' 2 ' }, mbConfig: { val: 0 }, fillet: { type: 1, valList: [1, 2, 3, 4].map(val => ({ val })) }, unknown: { image: '/api/assets/99', opaque: [false] } }), before = copy(value), r = setup({ value }), m = mount(r);
  try { await tick(); assert.equal(r.view.wrapperStyle.padding, '0rpx 0.001rpx 4rpx'); assert.equal(r.view.wrapperStyle.marginTop, '0rpx'); assert.equal(r.view.panelStyle.borderRadius, '2rpx 4rpx 8rpx 6rpx'); assert.deepEqual(r.props.block, before); assert.equal(r.calls.length, 1); }
  finally { finish(r, m); }
});

for (const [raw, quantity] of [[0, 0], ['0', 0], ['5e-4', 0], [' 2.99 ', 2], ['003', 3], [10, 10], ['1e30', 10], ['bad', 6], [undefined, 6]]) test(`real coupon quantity ${String(raw)} keeps raw imports and projects only the existing TS bounded read`, async () => {
  const value = block({ numberConfig: raw === undefined ? {} : { val: raw }, keep: [false, 0, ''] }), before = copy(value), r = setup({ value }), m = mount(r);
  try { await tick(); assert.equal(r.view.limit, quantity); assert.equal(r.c.config.value.limit, quantity); assert.equal(readCalls(r).length, quantity ? 1 : 0); if (quantity) assert.equal(readCalls(r)[0].data.limit, quantity); else { assert.equal(r.c.loaded.value, true); assert.match(text(m.tree), /暂无可展示/); } assert.deepEqual(r.props.block, before); assert.deepEqual(claimCalls(r), []); }
  finally { finish(r, m); }
});

test('compiled HomeRenderer chooses coupon promotion points presale independently and retains exactly no Commerce families', async () => {
  const components = [block(), { name: 'promotionList', timestamp: 102 }, ...['bargain', 'combination', 'liveBroadcast', 'seckill', 'presale', 'pointsMall'].map((name, index) => ({ name, timestamp: 200 + index }))];
  const props = vue.reactive({ components, pageActive: false, pageRefreshing: false, microPage: false, scrollTop: 0, loadMoreSignal: 0 }), r = runtime({ component: 'components/diy/DiyHomeRenderer.vue', props, platform: 'H5', send: () => { throw Error('No inactive root I/O'); } });
  try {
    const file = path.join(root, 'src/components/diy/DiyHomeRenderer.vue'), render = compile(file), bindings = vue.proxyRefs(r.checkout), context = { ...props, ...bindings }, tree = render.call(context, context, [], props, bindings, {}, {}), found = [];
    function visit(node) { if (Array.isArray(node)) return node.forEach(visit); if (!node || typeof node !== 'object') return; found.push(node); visit(node.children); } visit(tree);const bargain=r.load(path.join(root,'src/components/diy/DiyBargainWidget.vue')).default;const seckill=r.load(path.join(root,'src/components/diy/DiySeckillWidget.vue')).default;const live=r.load(path.join(root,'src/components/diy/DiyLiveBroadcastWidget.vue')).default;
    const couponType = r.load(path.join(root, 'src', widget)).default, promotion = r.load(path.join(root, 'src/components/diy/DiyPromotionWidget.vue')).default, commerce = r.load(path.join(root, 'src/components/diy/DiyCommerceWidget.vue')).default;
    const points = r.load(path.join(root, 'src/components/diy/DiyPointsWidget.vue')).default;
    const presale = r.load(path.join(root, 'src/components/diy/DiyPresaleWidget.vue')).default;
    const combination = r.load(path.join(root, 'src/components/diy/DiyCombinationWidget.vue')).default;
    const selected = found.filter(node => [couponType, promotion, points, presale, combination, live, seckill, bargain, commerce].includes(node.type)); assert.equal(selected.length, 8); assert.equal(selected[0].type, couponType); assert.equal(selected[0].props.active, false); assert.equal(selected[1].type, promotion);
    assert.deepEqual(selected.filter(node => node.type === commerce).map(node => node.props.block.name), []);assert.equal(selected.find(node=>node.props.block.name==='combination').type,combination);assert.equal(r.checkout.isCommerceWidget({name:'combination'}),false);assert.equal(selected.find(node=>node.props.block.name==='bargain').type,bargain);assert.equal(r.checkout.isCommerceWidget({name:'bargain'}),false);assert.equal(selected.find(node=>node.props.block.name==='seckill').type,seckill);assert.equal(r.checkout.isCommerceWidget({name:'seckill'}),false);assert.equal(selected.find(node=>node.props.block.name==='liveBroadcast').type,live);assert.equal(r.checkout.isCommerceWidget({name:'liveBroadcast'}),false);
    assert.equal(selected.find(node => node.props.block.name === 'presale').type, presale);assert.equal(r.checkout.isCommerceWidget({name:'presale'}),false);
    assert.equal(selected.find(node => node.props.block.name === 'pointsMall').type, points);
    assert.equal(r.checkout.isCommerceWidget({ name: 'coupon' }), false); assert.equal(r.checkout.isCommerceWidget({ name: 'promotionList' }), false); assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
});

for (const platform of ['H5', 'APP-PLUS', 'MP-WEIXIN']) test(`${platform} real guest coupon tap navigates to login without a claim or journal write`, async () => {
  const r = setup({ authenticated: false, platform }), m = mount(r);
  try { await tick(); assert.equal(r.c.loaded.value, true); fire(css(m.tree, 'coupon-claim')[0]); await tick(); assert.deepEqual(claimCalls(r), []); assert.deepEqual(r.navigations, ['/pages/auth/login']); assert.equal([...r.storage.keys()].some(key => key.startsWith('cinashop_diy_coupon_claim_v1_')), false); }
  finally { finish(r, m); }
});

test('real logged-in claim persists unknown before POST acknowledges once and disables repeated native taps', async () => {
  const pending = deferred(); const r = setup({ send: call => call.url.endsWith('/coupon/receive') ? pending.promise : receipt([coupon()]) }), m = mount(r);
  try {
    await tick(); const oldTap = css(m.tree, 'coupon-claim')[0].props.onTap; oldTap();
    assert.equal(JSON.parse(r.storage.get(journalKey())).state, 'unknown'); assert.equal(claimCalls(r).length, 1); assert.deepEqual(claimCalls(r)[0].data, { id: 901 });
    oldTap(); await tick(); assert.equal(claimCalls(r).length, 1); assert.equal(css(m.tree, 'coupon-claim')[0].props.disabled, true);
    pending.resolve({ data: { couponUserId: 3001 } }); await tick(); assert.equal(r.c.coupons.value[0].is_use, true); assert.equal(JSON.parse(r.storage.get(journalKey())).state, 'acknowledged'); assert.equal(JSON.parse(r.storage.get(journalKey())).couponUserId, 3001);
    assert.match(text(css(m.tree, 'coupon-claim')[0]), /已领取/); oldTap(); fire(css(m.tree, 'coupon-claim')[0]); await tick(); assert.equal(claimCalls(r).length, 1); assert.equal(r.toasts.filter(row => row.title === '领取成功').length, 1);
  } finally { pending.resolve({ data: { couponUserId: 3001 } }); finish(r, m); }
});

for (const state of [true, 2]) test(`public coupon state${state} cannot be claimed even by dispatching its real disabled native handler`, async () => {
  const value = coupon(901, { is_use: state, ...(state === true ? { used: { id: 80, cid: 901, uid: 11 } } : {}) }), r = setup({ rows: [value] }), m = mount(r);
  try { await tick(); assert.equal(r.c.loaded.value, true); const button = css(m.tree, 'coupon-claim')[0]; assert.equal(button.props.disabled, true); assert.match(text(button), state === true ? /已领取/ : /已过期/); fire(button); await tick(); assert.deepEqual(claimCalls(r), []); assert.equal(r.storage.has(journalKey()), false); }
  finally { finish(r, m); }
});

test('uncertain transport claim stays locked across clicks and remount and read-only reconciliation can establish ownership', async () => {
  let owned = false; const storage = new Map();
  const send = call => call.url.endsWith('/coupon/receive') ? { transport: 'uncertain receipt' } : receipt([coupon(901, owned ? { is_use: true, used: { id: 80, cid: 901, uid: 11 } } : {})]);
  const r = setup({ storage, send }), m = mount(r);
  try {
    await tick(); fire(css(m.tree, 'coupon-claim')[0]); await tick(); assert.equal(JSON.parse(storage.get(journalKey())).state, 'unknown'); assert.match(r.c.claimNotice.value, /尚未确认/); assert.equal(claimCalls(r).length, 1);
    fire(css(m.tree, 'coupon-claim')[0]); await tick(); assert.equal(claimCalls(r).length, 1); assert.match(text(css(m.tree, 'coupon-claim')[0]), /待核对/); assert.equal(css(m.tree, 'coupon-reconcile').length, 1);
    owned = true; fire(css(m.tree, 'coupon-reconcile')[0]); await tick(); assert.equal(readCalls(r).length, 2); assert.equal(claimCalls(r).length, 1); assert.equal(JSON.parse(storage.get(journalKey())).state, 'owned'); assert.match(text(css(m.tree, 'coupon-claim')[0]), /已领取/);
  } finally { finish(r, m); }
  const again = setup({ storage, send }), mounted = mount(again);
  try { await tick(); assert.equal(claimCalls(again).length, 0); fire(css(mounted.tree, 'coupon-claim')[0]); await tick(); assert.equal(claimCalls(again).length, 0); assert.equal(JSON.parse(storage.get(journalKey())).state, 'owned'); }
  finally { finish(again, mounted); }
});

test('existing unknown and malformed journals never auto-replay and the wallet remains a current navigation action', async () => {
  for (const stored of [journal(), '{malformed']) {
    const storage = new Map([[journalKey(), stored]]), r = setup({ storage }), m = mount(r);
    try { await tick(); assert.deepEqual(claimCalls(r), []); assert.equal(css(m.tree, 'coupon-claim')[0].props.disabled, true); fire(css(m.tree, 'coupon-claim')[0]); await tick(); assert.deepEqual(claimCalls(r), []); assert.equal(storage.get(journalKey()), stored); assert.match(text(css(m.tree, 'coupon-claim')[0]), stored.startsWith('{malformed') ? /恢复资料异常/ : /待核对/); fire(css(m.tree, 'coupon-wallet')[0]); await tick(); assert.deepEqual(r.navigations, ['/pages/user/couponCenter']); }
    finally { finish(r, m); }
  }
});

test('initial loaded station and refresh buttons stay current after real read state transitions', async () => {
  const r = setup({ value: block({ styleConfig: { tabVal: 3 } }) }), m = mount(r);
  try { await tick(); assert.equal(readCalls(r).length, 1); fire(css(m.tree, 'coupon-centre')[0]); await tick(); assert.deepEqual(r.navigations, ['/pages/user/couponCenter']); fire(css(m.tree, 'coupon-refresh')[0]); await tick(); assert.equal(readCalls(r).length, 2); assert.equal(r.c.loaded.value, true); fire(css(m.tree, 'coupon-centre')[0]); await tick(); assert.equal(r.navigations.length, 2); assert.deepEqual(claimCalls(r), []); }
  finally { finish(r, m); }
});

test('real failed read keeps an explicit retry button and rejects a malformed duplicate tail before any partial cards', async () => {
  let phase = 0; const r = setup({ send: () => phase === 0 ? { httpStatus: 503, msg: 'explicit read failure' } : phase === 1 ? receipt([coupon(), coupon()]) : receipt([coupon()]) }), m = mount(r);
  try { await tick(); assert.equal(r.c.loaded.value, false); assert.match(text(m.tree), /explicit read failure/); assert.equal(css(m.tree, 'coupon-card').length, 0); assert.equal(readCalls(r).length, 1);
    phase = 1; fire(css(m.tree, 'coupon-refresh')[0]); await tick(); assert.equal(r.c.loaded.value, false); assert.equal(css(m.tree, 'coupon-card').length, 0); assert.match(r.c.error.value, /重复/);
    phase = 2; fire(css(m.tree, 'coupon-refresh')[0]); await tick(); assert.equal(r.c.loaded.value, true); assert.equal(css(m.tree, 'coupon-card').length, 1); assert.equal(readCalls(r).length, 3); assert.deepEqual(claimCalls(r), []);
  } finally { finish(r, m); }
});

async function crossBoundary(boundary, r, m) {
  if (boundary === 'account') r.auth.setLogin('owner22', 22);
  else if (boundary === 'accountABA') { const uid = r.auth.uid; r.auth.uid = 22; await tick(); r.auth.uid = uid; }
  else if (boundary === 'session') r.auth.setLogin(r.auth.token, r.auth.uid);
  else if (boundary === 'config') r.props.block.numberConfig.val = 3;
  else if (boundary === 'rawABA') { const original = copy(r.props.block); r.props.block = { ...original, extra: true }; await tick(); r.props.block = original; }
  else if (boundary === 'activeABA') { r.props.active = false; await tick(); r.props.active = true; }
  else if (boundary === 'disabled') r.props.block.isHide = true;
  else if (boundary === 'hidden') r.props.active = false;
  else if (boundary === 'reloadSameID') fire(css(m.tree, 'coupon-refresh')[0]);
  else if (boundary === 'dispose') r.c.dispose();
  else if (boundary === 'unmount') m.unmount();
  else assert.fail('Unknown boundary ' + boundary);
  await tick();
}
for (const boundary of ['account', 'accountABA', 'session', 'config', 'rawABA', 'activeABA', 'disabled', 'hidden', 'reloadSameID', 'dispose', 'unmount']) test(`captured real coupon claim/read/reconcile/wallet native callbacks cannot cross ${boundary}`, async () => {
  const storage = new Map([[journalKey(11, 902), journal(11, 902)]]), r = setup({ storage, value: block({ numberConfig: { val: 2 } }), rows: [coupon(), coupon(902)] }), m = mount(r);
  try {
    await tick(); const captured = ['coupon-claim', 'coupon-refresh', 'coupon-reconcile', 'coupon-wallet'].map(name => { const n = css(m.tree, name)[0]; assert.ok(n, name); return n.props.onTap; });
    await crossBoundary(boundary, r, m); const calls = r.calls.length, before = [...storage.entries()];
    for (const callback of captured) callback(); await tick(); assert.equal(r.calls.length, calls); assert.deepEqual(claimCalls(r), []); assert.deepEqual(r.navigations, []); assert.deepEqual([...storage.entries()], before); assert.equal(storage.has(journalKey(22, 901)), false);
    if (boundary === 'unmount') assert.equal(m.instances[0].disposed, true);
  } finally { finish(r, m); }
});

for (const boundary of ['account', 'accountABA', 'config', 'rawABA', 'activeABA', 'reloadSameID', 'unmount']) test(`captured real shared coupon station native tap cannot navigate after ${boundary}`, async () => {
  const r = setup({ value: block({ styleConfig: { tabVal: 3 } }) }), m = mount(r);
  try { await tick(); const old = css(m.tree, 'coupon-centre')[0].props.onTap; await crossBoundary(boundary, r, m); const reads = readCalls(r).length; old(); await tick(); assert.deepEqual(r.navigations, []); assert.equal(readCalls(r).length, reads); assert.deepEqual(claimCalls(r), []);
    if (!['unmount'].includes(boundary)) { fire(css(m.tree, 'coupon-centre')[0]); await tick(); assert.deepEqual(r.navigations, ['/pages/user/couponCenter']); }
  } finally { finish(r, m); }
});

for (const boundary of ['account', 'config', 'activeABA', 'hidden', 'unmount']) test(`a real pending coupon list receipt cannot adopt old material after ${boundary}`, async () => {
  const wait = deferred(); let first = true; const r = setup({ send: () => first ? (first = false, wait.promise) : receipt([coupon(902)]) }), m = mount(r);
  try { await tick(); assert.equal(r.c.loading.value, true); await crossBoundary(boundary, r, m); wait.resolve(receipt([coupon(999)])); await tick(); assert.equal(r.c.coupons.value.some(row => row.id === 999), false); assert.equal(css(m.tree, 'coupon-card').some(node => node.props['data-coupon-id'] === 999), false); assert.deepEqual(claimCalls(r), []); assert.deepEqual(r.navigations, []); }
  finally { wait.resolve(receipt([])); finish(r, m); }
});

test('late failed/finally coupon read cannot release a newer current-owner loading state', async () => {
  const old = deferred(), fresh = deferred(); let count = 0; const r = setup({ send: () => ++count === 1 ? old.promise : fresh.promise }), m = mount(r);
  try { await tick(); r.auth.setLogin('owner22', 22); await tick(); assert.equal(readCalls(r).length, 2); old.resolve({ httpStatus: 503, msg: 'late failure' }); await tick(); assert.equal(r.c.loading.value, true); assert.equal(r.c.error.value, ''); fresh.resolve(receipt([coupon(902)])); await tick(); assert.equal(r.c.loading.value, false); assert.equal(r.c.coupons.value[0].id, 902); assert.equal(css(m.tree, 'coupon-card').length, 1); }
  finally { old.resolve(receipt([])); fresh.resolve(receipt([])); finish(r, m); }
});

for (const boundary of ['account', 'config', 'hidden', 'unmount']) test(`an already dispatched claim keeps recovery authority but never feeds back or writes a new-owner claim after ${boundary}`, async () => {
  const pending = deferred(), r = setup({ send: call => call.url.endsWith('/coupon/receive') ? pending.promise : receipt([coupon()]) }), m = mount(r);
  try {
    await tick(); fire(css(m.tree, 'coupon-claim')[0]); await tick(); assert.equal(claimCalls(r).length, 1); assert.equal(JSON.parse(r.storage.get(journalKey())).state, 'unknown');
    await crossBoundary(boundary, r, m); pending.resolve({ data: { couponUserId: 3001 } }); await tick();
    assert.equal(claimCalls(r).length, 1); assert.equal(r.storage.has(journalKey(22)), false); assert.equal(r.c.claimNotice.value, ''); assert.equal(r.toasts.filter(value => value.title === '领取成功').length, 0);
    if (boundary === 'account') assert.equal(JSON.parse(r.storage.get(journalKey())).state, 'unknown', 'The existing request rejects stale owner before acknowledging');
    else assert.equal(JSON.parse(r.storage.get(journalKey())).state, 'acknowledged', 'A definite receipt for an already sent same-owner POST remains recoverable');
  } finally { pending.resolve({ data: { couponUserId: 3001 } }); finish(r, m); }
});

test('explicit server rollback unlocks a new intentional retry without an automatic or journal-driven claim replay', async () => {
  let reject = true; const r = setup({ send: call => call.url.endsWith('/coupon/receive') ? reject ? { status: 400, httpStatus: 200, msg: '已回滚' } : { data: { couponUserId: 3002 } } : receipt([coupon()]) }), m = mount(r);
  try { await tick(); fire(css(m.tree, 'coupon-claim')[0]); await tick(); assert.equal(claimCalls(r).length, 1); assert.equal(r.storage.has(journalKey()), false); assert.match(r.c.claimNotice.value, /已回滚/); await tick(); assert.equal(claimCalls(r).length, 1); reject = false; fire(css(m.tree, 'coupon-claim')[0]); await tick(); assert.equal(claimCalls(r).length, 2); assert.equal(JSON.parse(r.storage.get(journalKey())).couponUserId, 3002); }
  finally { finish(r, m); }
});

test('two actual mounted instances share only the existing owner/issue journal and cannot duplicate a pending claim', async () => {
  const pending = deferred(), r = setup({ send: call => call.url.endsWith('/coupon/receive') ? pending.promise : receipt([coupon()]) });
  const secondProps = vue.reactive({ block: block({ timestamp: 202, styleConfig: { tabVal: 4 } }), active: true }), m = mount(r, [r.props, secondProps]);
  try { await tick(); assert.equal(readCalls(r).length, 2); assert.equal(m.instances.length, 2); assert.notStrictEqual(m.instances[0].state.state, m.instances[1].state.state);
    const buttons = css(m.tree, 'coupon-claim'), first = buttons[0].props.onTap, second = buttons[1].props.onTap; first(); second(); await tick(); assert.equal(claimCalls(r).length, 1); assert.ok(css(m.tree, 'coupon-claim').every(node => node.props.disabled));
    pending.resolve({ data: { couponUserId: 3001 } }); await tick(); assert.equal(claimCalls(r).length, 1); assert.equal(JSON.parse(r.storage.get(journalKey())).state, 'acknowledged');
    assert.ok(css(m.tree, 'coupon-claim').every(node => /已领取/.test(text(node))));
  } finally { pending.resolve({ data: { couponUserId: 3001 } }); finish(r, m); }
});

for (const platform of ['H5', 'APP-PLUS', 'MP-WEIXIN']) test(`${platform} real coupon/widget/claim runs without window or URL globals and never invents image media slots`, async () => {
  const original = { window: global.window, URL: global.URL }; global.window = undefined; global.URL = undefined; let r, m;
  try {
    const value = block({ imgConfig: { url: '/api/assets/99' }, image: '/static/images/unknown.png', extra: ['/api/assets/100?expires=1&signature=old'] }), before = copy(value); r = setup({ platform, value }); m = mount(r);
    await tick(); assert.equal(r.c.loaded.value, true); assert.equal(nodes(m.tree, node => node.tag === 'image').length, 0); assert.deepEqual(r.props.block, before); assert.equal(readCalls(r)[0].url, `${platform === 'H5' ? '' : 'https://cinashop-api.cinagroup.workers.dev'}/api/v2/coupons`);
    fire(css(m.tree, 'coupon-claim')[0]); await tick(); assert.equal(claimCalls(r).length, 1); assert.equal(JSON.parse(r.storage.get(journalKey())).state, 'acknowledged');
  } finally { if (r) finish(r, m); if (original.window === undefined) delete global.window; else global.window = original.window; if (original.URL === undefined) delete global.URL; else global.URL = original.URL; }
});
