/** Real TS/Vue/Pinia/API controllers; only native lifecycle, manifest test
 * identity and transport callbacks are replaced. No binary/provider claim. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vue = require('vue');
const pinia = require('pinia');
const root = path.resolve(__dirname, '..');
const APP = 'owned_native_app';
const packet = (change = {}) => ({ appid: APP, partnerid: '1900000101', prepayid: 'owned_prepay_id',
  package: 'Sign=WXPay', noncestr: 'OwnedNonce123', timestamp: '1793000000', sign: 'A'.repeat(340) + 'AA==',
  prepay_id: 'owned_prepay_id', signType: 'RSA', ...change });
const configured = () => ({ 'app-plus': { modules: { Payment: {} }, distribute: { sdkConfigs: {
  payment: { weixin: { appid: APP } }, oauth: { weixin: { appid: APP } },
} } } });
const tick = async () => { for (let i = 0; i < 10; i++) { await vue.nextTick(); await new Promise(setImmediate); } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function host({ component, send = () => ({ data: {} }), manifest = configured(), platform = 'APP-PLUS', nativeEntry, sharedStorage } = {}) {
  const cache = new Map(), hooks = {}, mounted = [], unmounted = [], calls = [], sdk = [], toasts = [], navigations = [], storage = sharedStorage ?? new Map();
  const addHook = (name, callback) => { const previous = hooks[name]; hooks[name] = (...args) => { previous?.(...args); return callback(...args); }; };
  const uni = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    showToast: value => toasts.push(value), requestPayment: value => sdk.push(value),
    navigateTo: value => navigations.push(value.url), redirectTo: value => navigations.push(value.url),
    showModal: value => value.success?.({ confirm: true }),
    request: value => {
      calls.push({ url: value.url, method: value.method, data: structuredClone(vue.toRaw(value.data)), header: { ...value.header } });
      Promise.resolve().then(() => send(value)).then(result => {
        if (result?.transport) value.fail({ errMsg: result.transport });
        else value.success({ statusCode: result?.httpStatus ?? 200, header: {},
          data: { status: result?.status ?? 200, msg: result?.msg ?? 'ok', data: result?.data } });
      }).catch(error => value.fail({ errMsg: error.message }));
    },
  };
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file);
    if (nativeEntry && file === path.join(root, 'src/utils/nativeWechatPaymentEntry.ts')) return nativeEntry;
    if (file === path.join(root, 'src/manifest.json')) { cache.set(file, manifest); return manifest; }
    const exports = {}; cache.set(file, exports);
    const active = [true], names = new Set([platform, ...(platform === 'MP-WEIXIN' ? ['MP'] : [])]);
    let source = readFileSync(file, 'utf8').split('\n').filter(line => {
      const directive = /(?:\/\/|<!--)\s*#(ifdef|ifndef|endif)\s*([^\n]*?)(?:-->)?\s*$/.exec(line);
      if (directive) {
        if (directive[1] === 'endif') { assert.ok(active.length > 1); active.pop(); }
        else { const matches = directive[2].split('||').some(name => names.has(name.trim())); active.push(active.at(-1) && (directive[1] === 'ifdef' ? matches : !matches)); }
        return false;
      }
      return active.at(-1);
    }).join('\n');
    assert.equal(active.length, 1, file);
    if (file.endsWith('.vue')) {
      const { parse, compileScript } = require('@vue/compiler-sfc');
      source = compileScript(parse(source, { filename: file }).descriptor, { id: 'native-payment-page' }).content;
    }
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    new Function('require', 'exports', 'uni', output)(id => {
      if (id === 'vue') return { ...vue, onMounted: callback => mounted.push(callback), onUnmounted: callback => unmounted.push(callback) };
      if (id === 'pinia') return pinia;
      if (id === '@dcloudio/uni-app') return Object.fromEntries(['onLoad', 'onShow', 'onHide', 'onUnload'].map(name => [name, callback => addHook(name, callback)]));
      if (id.startsWith('@/')) return load(path.join(root, 'src', id.slice(2)));
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
      if (id.startsWith('qrcode-terminal/')) return require(id);
      throw Error('Unreplaced dependency: ' + id);
    }, exports, uni);
    return exports;
  }
  const activePinia = pinia.createPinia(); pinia.setActivePinia(activePinia);
  const auth = load(path.join(root, 'src/stores/auth.ts')).useAuthStore(); auth.setLogin('owned-original-token', 11);
  const scope = vue.effectScope();
  const page = component ? scope.run(() => load(path.join(root, 'src', component)).default.setup({}, { expose() {} })) : null;
  return { page, auth, uni, calls, sdk, toasts, navigations, hooks, storage,
    module: name => load(path.join(root, 'src/utils', name + '.ts')),
    async start(query = { orderId: 'owned_order' }) { for (const callback of mounted) callback(); hooks.onLoad?.(query); hooks.onShow?.(); await tick(); },
    unmount() { for (const callback of unmounted) callback(); scope.stop(); },
    stop() { hooks.onUnload?.(); for (const callback of unmounted) callback(); scope.stop(); },
  };
}

test('native projection detaches exactly seven wire fields and preserves their signed bytes', () => {
  const r = host(); try {
    const input = packet(), result = r.module('nativeWechatPayment').checkedNativeWechatOrderInfo(input, APP);
    assert.deepEqual(Object.keys(result).sort(), ['appid', 'noncestr', 'package', 'partnerid', 'prepayid', 'sign', 'timestamp']);
    for (const name of Object.keys(result)) assert.equal(result[name], input[name]);
    input.prepayid = 'mutated'; assert.equal(result.prepayid, 'owned_prepay_id');
    const emptyExtras = packet(); delete emptyExtras.prepay_id; delete emptyExtras.signType;
    assert.deepEqual(r.module('nativeWechatPayment').checkedNativeWechatOrderInfo(emptyExtras, APP), result);
  } finally { r.stop(); }
});
for (const [label, change] of [
  ['other App', { appid: 'other_app' }], ['merchant type', { partnerid: 1900000101 }], ['merchant punctuation', { partnerid: '19-1' }],
  ['long prepay', { prepayid: 'A'.repeat(65) }], ['JSAPI package', { package: 'prepay_id=owned_prepay_id' }],
  ['empty nonce', { noncestr: '' }], ['camelcase mixed', { nonceStr: 'foreign' }], ['numeric timestamp', { timestamp: 1793000000 }],
  ['zero timestamp', { timestamp: '0' }], ['fraction timestamp', { timestamp: '1.5' }], ['unsafe timestamp', { timestamp: '9999999999999999' }],
  ['invalid signature', { sign: '<private>' }], ['prepay alias conflict', { prepay_id: 'other_prepay' }], ['algorithm conflict', { signType: 'MD5' }],
  ['provider credentials', { appsecret: 'must_never_enter_sdk' }],
]) test(`native projection rejects ${label} before SDK`, async () => {
  const r = host(); try {
    await assert.rejects(r.module('nativeWechatPaymentEntry').requestNativeWechatPayment(packet(change), () => true), { kind: 'invalid' });
    assert.equal(r.sdk.length, 0);
  } finally { r.stop(); }
});
for (const value of [null, [], 'not-json-object', Object.create({ appid: APP })]) test(`native projection rejects a non-JSON record ${String(value)}`, () => {
  const r = host(); try { assert.throws(() => r.module('nativeWechatPayment').checkedNativeWechatOrderInfo(value, APP)); }
  finally { r.stop(); }
});
for (const form of ['hidden-unknown', 'hidden-required', 'undefined-getter', 'real-getter', 'symbol', 'missing-own'])
  test(`native projection rejects ${form} without evaluating an accessor`, () => {
    const r = host(); let touched = 0;
    try {
      const value = packet();
      if (form === 'hidden-unknown') Object.defineProperty(value, 'privateKey', { value: 'never-read', enumerable: false });
      if (form === 'hidden-required') Object.defineProperty(value, 'timestamp', { value: value.timestamp, enumerable: false });
      if (form === 'undefined-getter') Object.defineProperty(value, 'timestamp', { get: undefined, enumerable: true });
      if (form === 'real-getter') Object.defineProperty(value, 'timestamp', { get() { touched++; return '1793000000'; }, enumerable: true });
      if (form === 'symbol') value[Symbol('unknown')] = 'never-forward';
      if (form === 'missing-own') delete value.sign;
      assert.throws(() => r.module('nativeWechatPayment').checkedNativeWechatOrderInfo(value, APP), { kind: 'invalid' });
      assert.equal(touched, 0);
    } finally { r.stop(); }
  });
test('native callback adapter retains one lease across owner loss and ignores old duplicate callbacks', async () => {
  const r = host(); try {
    const { requestNativeWechatPayment: pay } = r.module('nativeWechatPaymentEntry');
    let current = true;
    const first = pay(packet(), () => current); const rejected = assert.rejects(first, { kind: 'stale' });
    current = false;
    await assert.rejects(pay(packet(), () => true), { kind: 'busy' }); assert.equal(r.sdk.length, 1);
    r.sdk[0].success(); await rejected;
    const second = pay(packet(), () => true); assert.equal(r.sdk.length, 2);
    r.sdk[0].fail({ errMsg: 'old cancel' });
    await assert.rejects(pay(packet(), () => true), { kind: 'busy' });
    r.sdk[1].success(); await second;
  } finally { r.stop(); }
});
for (const outcome of ['cancel', 'failure', 'throw']) test(`native ${outcome} is sanitized and never resolves as submitted`, async () => {
  const r = host(); try {
    const create = r.module('nativeWechatPayment').createNativeWechatPayment;
    const pay = create(options => { if (outcome === 'throw') throw Error('private provider payload');
      options.fail({ errMsg: outcome === 'cancel' ? 'requestPayment:fail cancel' : 'private provider payload' }); });
    await assert.rejects(pay(packet(), APP, () => true), error => {
      assert.equal(error.kind, outcome === 'cancel' ? 'cancelled' : 'failed');
      assert.doesNotMatch(error.message, /private|payload/); return true;
    });
  } finally { r.stop(); }
});
for (const [label, change] of [
  ['missing all SDK configuration', {}],
  ['missing Payment module', { 'app-plus': { modules: {}, distribute: { sdkConfigs: { payment: { weixin: { appid: APP } } } } } }],
  ['different configured OAuth identity', { 'app-plus': { modules: { Payment: {} }, distribute: { sdkConfigs: {
    payment: { weixin: { appid: APP } }, oauth: { weixin: { appid: 'other_oauth_app' } },
  } } } }],
]) test(`native preflight rejects ${label}`, () => {
  const r = host({ manifest: change }); try { assert.throws(() => r.module('nativeWechatPaymentEntry').assertNativeWechatPaymentAvailable(), { kind: 'unconfigured' }); }
  finally { r.stop(); }
});

const methods = { weixin: { enabled: true, reason: '' }, yue: { enabled: false, reason: 'not selected' },
  alipay: { enabled: false, reason: 'not selected' }, offline: { enabled: false, reason: 'not selected' } };
const order = (paid = 0) => ({ orderId: 'owned_order', uid: 11, paid, payPrice: '10.00', totalPrice: '10.00', status: 0, type: 0,
  pid: 0, supplierAllocationStatus: 0, productType: 0, cartInfo: [], customForm: [] });
const cashier = (type = 'order', paid = false) => ({ type, order_id: 'owned_order', paid, payable: true, payable_reason: '', zero_pay: false,
  pay_price: '10.00', now_money: '20.00', integral: 0, pay_integral: 0, methods });
const home = (paid = false) => ({ member_rights: [], member_type: [{ id: 1, type: 'month', pre_price: '10.00', is_label: 1 }],
  is_get_free: { title: '', vip_day: 0, is_record: 0, user_info: { now_money: '20.00', is_ever_level: 0, is_money_level: paid ? 1 : 0, overdue_time: 0 } }, member_explain: '' });
const scenarios = [
  { name: 'detail', component: 'pages/order/detail.vue', submit: page => page.pay(), paymentPath: '/order/pay' },
  { name: 'recharge', component: 'pages/user/recharge.vue', submit: page => page.submit(), paymentPath: '/recharge/pay' },
  { name: 'membership', component: 'pages/user/vipOpen.vue', submit: page => page.submit(), paymentPath: '/user/member/card/pay' },
];
function pageHost(scenario, options = {}) {
  let afterSdk = false;
  const r = host({ component: scenario.component, manifest: options.manifest, platform: options.platform,
    nativeEntry: options.nativeEntry, sharedStorage: options.sharedStorage,
    send: call => {
      if (options.override) { const result = options.override(call, afterSdk); if (result !== undefined) return result; }
      if (call.url.endsWith('/payment/readiness')) return { data: methods };
      if (call.url.endsWith(scenario.paymentPath)) return { data: { order_id: 'owned_order', paid: false, pay_type: 'weixin', pay_mode: 'app', jsConfig: packet() } };
      if (call.url.includes('/order/detail/')) return { data: order(afterSdk ? 1 : 0) };
      if (call.url.includes('/order/cashier/')) return { data: cashier(call.url.split('/').at(-1), afterSdk) };
      if (call.url.endsWith('/recharge/recharge')) return { data: { orderId: 'owned_order', price: '10.00' } };
      if (call.url.endsWith('/recharge/index')) return { data: { recharge_quota: [], recharge_attention: [], user_extract_balance_status: 0 } };
      if (call.url.endsWith('/user/info')) return { data: { now_money: afterSdk ? '30.00' : '20.00', brokerage_price: '0.00' } };
      if (call.url.endsWith('/user/member/card/index')) return { data: home(afterSdk) };
      if (call.url.endsWith('/user/member/card/create')) return { data: { order_id: 'owned_order', paid: false, pay_price: '10.00' } };
      throw Error('Unmapped native page request ' + call.url);
    } });
  return { ...r, paidOnServer() { afterSdk = true; } };
}
for (const scenario of scenarios) test(`${scenario.name} actual APP controller preflights missing configuration before any create or pay POST`, async () => {
  const r = pageHost(scenario, { manifest: {} }); try {
    await r.start(); await scenario.submit(r.page);
    assert.equal(r.calls.filter(call => call.method === 'POST').length, 0); assert.equal(r.sdk.length, 0);
    assert.match(r.page.actionError?.value ?? r.toasts.at(-1)?.title ?? '', /配置|安装包/);
  } finally { r.stop(); }
});
for (const scenario of scenarios) test(`${scenario.name} actual APP controller passes seven lowercase fields and waits for a server result after SDK success`, async () => {
  const confirmation = deferred(); let hold = false;
  const r = pageHost(scenario, { override: call => {
    if (hold && ((scenario.name === 'detail' && call.url.includes('/order/detail/'))
      || (scenario.name === 'recharge' && call.url.includes('/order/cashier/'))
      || (scenario.name === 'membership' && call.url.endsWith('/user/member/card/index')))) return confirmation.promise;
  } });
  try {
    await r.start(); const pending = scenario.submit(r.page); await tick();
    assert.equal(r.sdk.length, 1); const native = r.sdk[0]; assert.equal(native.provider, 'wxpay');
    const paymentRequest = r.calls.find(call => call.url.endsWith(scenario.paymentPath));
    assert.equal(paymentRequest.data.from, 'app'); assert.equal(paymentRequest.header['Form-type'], 'app');
    assert.deepEqual(Object.keys(native.orderInfo).sort(), ['appid', 'noncestr', 'package', 'partnerid', 'prepayid', 'sign', 'timestamp']);
    assert.equal(Object.hasOwn(native, 'timeStamp'), false); assert.equal(native.orderInfo.appid, APP);
    await scenario.submit(r.page); assert.equal(r.sdk.length, 1);
    hold = true; native.success(); await tick();
    assert.ok(!r.toasts.some(value => /到账|开通成功|领取成功/.test(value.title)));
    if (scenario.name === 'detail') { assert.equal(r.page.order.value.paid, 0); assert.equal(r.navigations.length, 0); }
    if (scenario.name === 'membership') assert.equal(r.page.home.value.is_get_free.user_info.is_money_level, 0);
    r.paidOnServer(); confirmation.resolve({ data: scenario.name === 'detail' ? order(1)
      : scenario.name === 'recharge' ? cashier('recharge', true) : home(true) });
    await pending;
    if (scenario.name === 'detail') assert.ok(r.navigations.some(url => url.includes('/pages/order/payResult')));
    if (scenario.name === 'recharge') assert.ok(r.toasts.some(value => value.title === '充值到账'));
    if (scenario.name === 'membership') assert.equal(r.page.home.value.is_get_free.user_info.is_money_level, 1);
  } finally { confirmation.resolve({ status: 400, msg: 'fixture closed' }); r.stop(); }
});
for (const scenario of scenarios) test(`${scenario.name} rejects another order response before SDK even when the native signature packet is otherwise valid`, async () => {
  const r = pageHost(scenario, { override: call => call.url.endsWith(scenario.paymentPath)
    ? { data: { order_id: 'foreign_order', paid: false, pay_type: 'weixin', pay_mode: 'app', jsConfig: packet() } } : undefined });
  try { await r.start(); await scenario.submit(r.page); assert.equal(r.sdk.length, 0);
    assert.match(r.page.actionError?.value ?? r.toasts.at(-1)?.title ?? '', /不一致/);
  } finally { r.stop(); }
});
for (const scenario of scenarios) for (const pay_mode of ['jsapi', undefined])
  test(`${scenario.name} rejects wrong or absent declared native mode ${String(pay_mode)} before SDK`, async () => {
    const r = pageHost(scenario, { override: call => call.url.endsWith(scenario.paymentPath)
      ? { data: { order_id: 'owned_order', paid: false, pay_type: 'weixin', pay_mode, jsConfig: packet() } } : undefined });
    try { await r.start(); await scenario.submit(r.page); assert.equal(r.sdk.length, 0);
      assert.match(r.page.actionError?.value ?? r.toasts.at(-1)?.title ?? '', /渠道|不一致/);
    } finally { r.stop(); }
  });
for (const scenario of scenarios) for (const ending of ['owner-ABA', 'hide', 'unload', 'unmount'])
  test(`${scenario.name} ignores a delayed APP SDK completion after ${ending}`, async () => {
    const r = pageHost(scenario); try {
      await r.start(); const pending = scenario.submit(r.page); await tick(); assert.equal(r.sdk.length, 1);
      if (ending === 'owner-ABA') { const token = r.auth.token; r.auth.setLogin('new-owner', 22); r.auth.setLogin(token, 11); }
      else if (ending === 'hide') r.hooks.onHide();
      else if (ending === 'unload') r.hooks.onUnload();
      else r.unmount();
      const count = r.calls.length, notices = r.toasts.length, navigation = r.navigations.length;
      r.sdk[0].success(); await pending; await tick();
      assert.equal(r.calls.length, count); assert.equal(r.toasts.length, notices); assert.equal(r.navigations.length, navigation);
    } finally { r.stop(); }
  });
for (const scenario of scenarios) test(`${scenario.name} cancellation never starts a server-paid refresh or success UI`, async () => {
  const r = pageHost(scenario); try {
    await r.start(); const pending = scenario.submit(r.page); await tick(); assert.equal(r.sdk.length, 1);
    const count = r.calls.length; r.sdk[0].fail({ errMsg: 'requestPayment:fail cancel' }); await pending;
    assert.equal(r.calls.length, count); assert.ok(!r.toasts.some(value => /到账|开通成功|领取成功/.test(value.title)));
    assert.match(r.page.actionError?.value ?? r.toasts.at(-1)?.title ?? '', /取消/);
  } finally { r.stop(); }
});
for (const scenario of scenarios) test(`${scenario.name} hide and show resumes from server truth while its old SDK callback remains retired`, async () => {
  const r = pageHost(scenario); try {
    await r.start(); const pending = scenario.submit(r.page); await tick(); assert.equal(r.sdk.length, 1);
    r.hooks.onHide(); r.paidOnServer(); r.hooks.onShow(); await tick();
    if (scenario.name === 'detail') assert.equal(r.page.order.value.paid, 1);
    if (scenario.name === 'recharge') { assert.equal(r.storage.has('cinashop_pending_recharge'), false); assert.equal(r.page.balance.value, '20.00'); }
    if (scenario.name === 'membership') assert.equal(r.page.home.value.is_get_free.user_info.is_money_level, 1);
    const count = r.calls.length, notices = r.toasts.length, navigation = r.navigations.length;
    r.sdk[0].success(); await pending; await tick();
    assert.equal(r.calls.length, count); assert.equal(r.toasts.length, notices); assert.equal(r.navigations.length, navigation);
  } finally { r.stop(); }
});
for (const ending of ['owner-ABA', 'hide-show', 'replacement-pending'])
  test(`recharge onShow retains the corresponding pending journal and ignores an old paid recovery after ${ending}`, async () => {
    const old = deferred(); let reads = 0;
    const r = pageHost(scenarios[1], { override: call => {
      if (call.url.includes('/order/cashier/')) return ++reads === 1 ? old.promise : { data: cashier('recharge', false) };
    } });
    try {
      r.storage.set('cinashop_pending_recharge', 'owned_order'); await r.start();
      if (ending === 'owner-ABA') { const token = r.auth.token; r.auth.setLogin('new-owner', 22); r.auth.setLogin(token, 11); }
      else if (ending === 'hide-show') { r.hooks.onHide(); r.hooks.onShow(); await tick(); }
      else r.storage.set('cinashop_pending_recharge', 'replacement_order');
      const before = r.page.balance.value, notices = r.toasts.length;
      old.resolve({ data: { ...cashier('recharge', true), now_money: '999.00' } }); await tick();
      assert.equal(r.page.balance.value, before); assert.equal(r.toasts.length, notices);
      assert.equal(r.storage.get('cinashop_pending_recharge'), ending === 'replacement-pending' ? 'replacement_order' : 'owned_order');
    } finally { old.resolve({ status: 400 }); r.stop(); }
  });
for (const change of [{ type: 'order' }, { order_id: 'foreign_order' }, { paid: 1 }, { now_money: 'NaN' }, { now_money: '99999999999999.00' }])
  test(`recharge recovery rejects a foreign or malformed cashier ${JSON.stringify(change)}`, async () => {
    const r = pageHost(scenarios[1], { override: call => call.url.includes('/order/cashier/')
      ? { data: { ...cashier('recharge', true), ...change } } : undefined });
    try {
      r.storage.set('cinashop_pending_recharge', 'owned_order'); await r.start();
      assert.equal(r.storage.get('cinashop_pending_recharge'), 'owned_order');
      assert.ok(!r.toasts.some(value => value.title === '充值到账'));
      assert.equal(r.page.balance.value, '20.00');
    } finally { r.stop(); }
  });
for (const ending of ['owner-ABA', 'hide'])
  test(`membership fresh load discards a late entitlement after ${ending} without toast or a follow-up readiness read`, async () => {
    const old = deferred(); let hold = false;
    const r = pageHost(scenarios[2], { override: call => hold && call.url.endsWith('/user/member/card/index') ? old.promise : undefined });
    try {
      await r.start(); hold = true; const pending = r.page.load(r.page.captureNativePaymentView()); await tick();
      if (ending === 'owner-ABA') { const token = r.auth.token; r.auth.setLogin('new-member-owner', 22); r.auth.setLogin(token, 11); }
      else r.hooks.onHide();
      const count = r.calls.length, notices = r.toasts.length;
      old.resolve({ data: home(true) }); await pending; await tick();
      assert.equal(r.page.home.value.is_get_free.user_info.is_money_level, 0);
      assert.equal(r.calls.length, count); assert.equal(r.toasts.length, notices);
    } finally { old.resolve({ status: 400 }); r.stop(); }
  });
test('recharge late balance read cannot update the hidden native page', async () => {
  const old = deferred(); let hold = false;
  const r = pageHost(scenarios[1], { override: call => hold && call.url.endsWith('/user/info') ? old.promise : undefined });
  try {
    await r.start(); hold = true; const pending = r.page.loadBalance(r.page.captureNativePaymentView()); await tick();
    r.hooks.onHide(); old.resolve({ data: { now_money: '999.00', brokerage_price: '999.00' } }); await pending;
    assert.equal(r.page.balance.value, '20.00'); assert.equal(r.page.brokerageBalance.value, '0.00');
  } finally { old.resolve({ status: 400 }); r.stop(); }
});
test('recharge paid polling never removes a replacement pending journal', async () => {
  const confirmed = deferred(); let hold = false;
  const r = pageHost(scenarios[1], { override: call => hold && call.url.includes('/order/cashier/') ? confirmed.promise : undefined });
  try {
    await r.start(); const pending = r.page.submit(); await tick(); assert.equal(r.sdk.length, 1);
    hold = true; r.sdk[0].success(); await tick(); r.storage.set('cinashop_pending_recharge', 'replacement_order');
    confirmed.resolve({ data: cashier('recharge', true) }); await pending;
    assert.equal(r.storage.get('cinashop_pending_recharge'), 'replacement_order');
    assert.ok(r.toasts.some(value => value.title === '充值到账'));
  } finally { confirmed.resolve({ status: 400 }); r.stop(); }
});
test('native-only entry is absent from the mini-program controller import path and retains JSAPI fields', async () => {
  const r = pageHost(scenarios[0], { platform: 'MP-WEIXIN', manifest: {}, override: call => call.url.endsWith('/order/pay')
    ? { data: { order_id: 'owned_order', paid: false, pay_type: 'weixin', pay_mode: 'jsapi',
      jsConfig: { timeStamp: '1793000000', nonceStr: 'original_mp_nonce', package: 'prepay_id=mp', signType: 'RSA', paySign: 'original_mp_sign' } } } : undefined });
  try {
    await r.start(); const pending = r.page.pay(); await tick(); assert.equal(r.sdk.length, 1);
    assert.equal(r.sdk[0].timeStamp, '1793000000'); assert.equal(r.sdk[0].paySign, 'original_mp_sign');
    assert.equal(Object.hasOwn(r.sdk[0], 'orderInfo'), false);
    r.paidOnServer(); r.sdk[0].success(); await pending;
  } finally { r.stop(); }
});


// Each pair mounts two actual page controllers with independent HTTP hosts but
// the same actual native entry and global Uni storage, as in one installed app.
for (const firstScenario of scenarios) for (const secondScenario of scenarios)
  for (const stage of ['http', 'sdk', 'sdk-hidden'])
    test(`${firstScenario.name} blocks ${secondScenario.name} before its first HTTP mutation while the shared native attempt is in ${stage}`, async () => {
      const sdkHost = host(), nativeEntry = sdkHost.module('nativeWechatPaymentEntry'), sharedStorage = new Map();
      const response = deferred();
      const initialPath = firstScenario.name === 'detail' ? firstScenario.paymentPath
        : firstScenario.name === 'recharge' ? '/recharge/recharge' : '/user/member/card/create';
      const first = pageHost(firstScenario, { nativeEntry, sharedStorage, override: call =>
        stage === 'http' && call.method === 'POST' && call.url.endsWith(initialPath) ? response.promise : undefined });
      const second = pageHost(secondScenario, { nativeEntry, sharedStorage });
      let pending;
      try {
        await first.start(); pending = firstScenario.submit(first.page); await tick();
        assert.equal(first.calls.filter(call => call.method === 'POST').length, stage === 'http' || firstScenario.name === 'detail' ? 1 : 2);
        assert.equal(sdkHost.sdk.length, stage === 'http' ? 0 : 1);
        if (stage === 'sdk-hidden') first.hooks.onHide();
        if (!sharedStorage.has('cinashop_pending_recharge')) sharedStorage.set('cinashop_pending_recharge', 'previous_owned_order');
        const journal = sharedStorage.get('cinashop_pending_recharge');
        await second.start(); await secondScenario.submit(second.page); await tick();
        assert.equal(second.calls.filter(call => call.method === 'POST').length, 0);
        assert.equal(sdkHost.sdk.length, stage === 'http' ? 0 : 1);
        assert.equal(sharedStorage.get('cinashop_pending_recharge'), journal);
        assert.match(second.page.actionError?.value ?? second.toasts.at(-1)?.title ?? '', /处理中/);
        if (stage === 'http') {
          response.resolve({ data: firstScenario.name === 'detail'
            ? { order_id: 'owned_order', paid: false, pay_type: 'weixin', pay_mode: 'app', jsConfig: packet() }
            : firstScenario.name === 'recharge' ? { orderId: 'owned_order', price: '10.00' }
              : { order_id: 'owned_order', paid: false, pay_price: '10.00' } });
          await tick();
        }
        assert.equal(sdkHost.sdk.length, 1);
        first.paidOnServer(); sdkHost.sdk[0].success(); await pending;
        const next = nativeEntry.reserveNativeWechatPayment(() => true); next.release();
      } finally {
        response.resolve({ status: 400, msg: 'fixture closed' });
        sdkHost.sdk.forEach(call => call.fail({ errMsg: 'fixture closed' }));
        if (pending) await pending;
        first.stop(); second.stop(); sdkHost.stop();
      }
    });

test('a pre-SDK reservation and idempotent release cannot unlock a later native attempt', async () => {
  const r = host(); try {
    const entry = r.module('nativeWechatPaymentEntry');
    const first = entry.reserveNativeWechatPayment(() => true);
    assert.throws(() => entry.reserveNativeWechatPayment(() => true), { kind: 'busy' });
    assert.equal(r.sdk.length, 0); first.release();
    const second = entry.reserveNativeWechatPayment(() => true); first.release();
    assert.throws(() => entry.reserveNativeWechatPayment(() => true), { kind: 'busy' });
    await assert.rejects(first.request(packet()), { kind: 'stale' });
    second.release();
    const third = entry.reserveNativeWechatPayment(() => true); third.release();
  } finally { r.stop(); }
});
test('release after SDK entry and an old duplicate callback cannot unlock the current native attempt', async () => {
  const r = host(); try {
    const entry = r.module('nativeWechatPaymentEntry'), first = entry.reserveNativeWechatPayment(() => true);
    const pending = first.request(packet()); first.release();
    assert.throws(() => entry.reserveNativeWechatPayment(() => true), { kind: 'busy' });
    await assert.rejects(first.request(packet()), { kind: 'stale' });
    r.sdk[0].success(); await pending;
    const second = entry.reserveNativeWechatPayment(() => true); r.sdk[0].fail({ errMsg: 'old cancel' }); first.release();
    assert.throws(() => entry.reserveNativeWechatPayment(() => true), { kind: 'busy' }); second.release();
  } finally { r.stop(); }
});
test('a stale pre-SDK attempt releases its reservation without invoking native code', async () => {
  const r = host(); try {
    const entry = r.module('nativeWechatPaymentEntry'); let current = true;
    const first = entry.reserveNativeWechatPayment(() => current); current = false;
    await assert.rejects(first.request(packet()), { kind: 'stale' }); assert.equal(r.sdk.length, 0);
    const second = entry.reserveNativeWechatPayment(() => true); second.release();
  } finally { r.stop(); }
});
test('invalid native data releases only its own unstarted reservation', async () => {
  const r = host(); try {
    const entry = r.module('nativeWechatPaymentEntry'), first = entry.reserveNativeWechatPayment(() => true);
    await assert.rejects(first.request(packet({ appid: 'foreign_app' })), { kind: 'invalid' });
    assert.equal(r.sdk.length, 0); const second = entry.reserveNativeWechatPayment(() => true); first.release();
    assert.throws(() => entry.reserveNativeWechatPayment(() => true), { kind: 'busy' }); second.release();
  } finally { r.stop(); }
});
for (const scenario of scenarios) for (const ending of ['http-rejected', 'view-retired-before-sdk'])
  test(`${scenario.name} releases the shared reservation after ${ending} without entering the SDK`, async () => {
    const sdkHost = host(), nativeEntry = sdkHost.module('nativeWechatPaymentEntry'), response = deferred();
    const initialPath = scenario.name === 'detail' ? scenario.paymentPath
      : scenario.name === 'recharge' ? '/recharge/recharge' : '/user/member/card/create';
    const r = pageHost(scenario, { nativeEntry, override: call => call.method === 'POST' && call.url.endsWith(initialPath) ? response.promise : undefined });
    let pending;
    try {
      await r.start(); pending = scenario.submit(r.page); await tick();
      assert.throws(() => nativeEntry.reserveNativeWechatPayment(() => true), { kind: 'busy' });
      if (ending === 'http-rejected') response.resolve({ status: 400, msg: 'request rejected' });
      else {
        r.hooks.onHide(); response.resolve({ data: scenario.name === 'detail'
          ? { order_id: 'owned_order', paid: false, pay_type: 'weixin', pay_mode: 'app', jsConfig: packet() }
          : scenario.name === 'recharge' ? { orderId: 'owned_order', price: '10.00' }
            : { order_id: 'owned_order', paid: false, pay_price: '10.00' } });
      }
      await pending; assert.equal(sdkHost.sdk.length, 0);
      const next = nativeEntry.reserveNativeWechatPayment(() => true); next.release();
    } finally { response.resolve({ status: 400 }); if (pending) await pending; r.stop(); sdkHost.stop(); }
  });
