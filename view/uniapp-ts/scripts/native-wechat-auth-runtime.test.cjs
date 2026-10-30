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
const configured = () => ({ 'app-plus': { modules: { OAuth: {} }, distribute: { sdkConfigs: {
  oauth: { weixin: { appid: APP } }, payment: { weixin: { appid: APP } },
} } } });
const tick = async () => { for (let i = 0; i < 10; i++) { await vue.nextTick(); await new Promise(setImmediate); } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function host({ component, send = () => ({ data: {} }), manifest = configured(), platform = 'APP-PLUS', nativeEntry, sharedStorage, sharedPinia, autoLookup = true, serviceChange = {} } = {}) {
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
  const authorizations = [], lookups = [];
  const service = { id: 'weixin', nativeClient: true, extra: {},
    authorize(success, fail, options) { authorizations.push({ success, fail, options }); }, ...serviceChange };
  const plusRuntime = { oauth: { getServices(success, fail) { lookups.push({ success, fail }); if (autoLookup) success([service]); } } };
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file);
    if (nativeEntry && file === path.join(root, 'src/utils/nativeWechatAuthorizeEntry.ts')) return nativeEntry;
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
      source = compileScript(parse(source, { filename: file }).descriptor, { id: 'native-auth-page' }).content;
    }
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    new Function('require', 'exports', 'uni', 'plus', output)(id => {
      if (id === 'vue') return { ...vue, onMounted: callback => mounted.push(callback), onUnmounted: callback => unmounted.push(callback) };
      if (id === 'pinia') return pinia;
      if (id === '@dcloudio/uni-app') return Object.fromEntries(['onLoad', 'onShow', 'onHide', 'onUnload'].map(name => [name, callback => addHook(name, callback)]));
      if (id.startsWith('@/')) return load(path.join(root, 'src', id.slice(2)));
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
      if (id.startsWith('qrcode-terminal/')) return require(id);
      throw Error('Unreplaced dependency: ' + id);
    }, exports, uni, plusRuntime);
    return exports;
  }
  const activePinia = sharedPinia ?? pinia.createPinia(); pinia.setActivePinia(activePinia);
  const auth = load(path.join(root, 'src/stores/auth.ts')).useAuthStore(); if (!sharedPinia) auth.setLogin('owned-original-token', 11);
  const scope = vue.effectScope();
  const page = component ? scope.run(() => load(path.join(root, 'src', component)).default.setup({}, { expose() {} })) : null;
  return { page, auth, uni, calls, sdk, toasts, navigations, hooks, storage, authorizations, lookups, service, activePinia,
    module: name => load(path.join(root, 'src/utils', name + '.ts')),
    async start(query = { orderId: 'owned_order' }) { for (const callback of mounted) callback(); hooks.onLoad?.(query); hooks.onShow?.(); await tick(); },
    unmount() { for (const callback of unmounted) callback(); scope.stop(); },
    stop() { hooks.onUnload?.(); for (const callback of unmounted) callback(); scope.stop(); },
  };
}


const STATE = '6505a17e-0c61-4eb2-9563-45f62b149d35', KEY = '6505a17e-0c61-4eb2-9563-45f62b149d36';
const VERIFIER = 'a'.repeat(64), CODE = 'OwnedNativeCode_123';
const challenge = (change = {}) => ({ state: STATE, verifier: VERIFIER, appId: APP, expiresIn: 300, ...change });
const issued = (change = {}) => ({ token: 'owned.server.signature', uid: 22, exp_time: Math.floor(Date.now() / 1000) + 3600, ...change });
function loginHost(options = {}) {
  return host({ component: 'pages/auth/login.vue', ...options, send: call => {
    if (options.override) { const result = options.override(call); if (result !== undefined) return result; }
    if (call.url.endsWith('/wechat/app_auth/state')) return { data: challenge() };
    if (call.url.endsWith('/wechat/app_auth/phone')) return { data: issued() };
    if (call.url.endsWith('/wechat/app_auth')) return { data: issued() };
    if (call.url.endsWith('/verify_code')) return { data: { key: 'human_challenge', expire_time: 5, site_key: 'public_site', action: 'sms_send', challenge_url: 'https://owned.example/captcha' } };
    if (call.url.endsWith('/verify_code/status')) return { data: { verified: true, expires_in: 60 } };
    if (call.url.endsWith('/register/verify')) return { data: { queued: true, expires_in: 60 } };
    throw Error('Unmapped auth host route');
  } });
}
const completeCalls = r => r.calls.filter(call => call.url.endsWith('/wechat/app_auth'));
const succeed = r => r.authorizations[0].success({ code: CODE, state: STATE });

test('actual APP login sends detached top-level code/state/verifier and stores the server UID without decoding JWT identity', async () => {
  const r = loginHost(); try {
    await r.start(); const pending = r.page.handleNativeLogin(); await tick();
    assert.deepEqual(r.authorizations[0].options, { scope: 'snsapi_userinfo', state: STATE, appid: APP });
    assert.equal(completeCalls(r).length, 0); assert.equal(r.auth.uid, 11);
    r.authorizations[0].success({ code: CODE, state: STATE, authResult: { openid: 'untrusted', access_token: 'never_forward' }, userInfo: { uid: 999 } });
    await pending; assert.equal(r.auth.uid, 22); assert.equal(r.auth.token, 'owned.server.signature');
    assert.deepEqual(completeCalls(r)[0].data, { code: CODE, state: STATE, verifier: VERIFIER });
    assert.equal(completeCalls(r)[0].header.Authorization, undefined);
    assert.equal(r.storage.get('uni_uid'), 22);
    const persisted = JSON.stringify([...r.storage]); assert.doesNotMatch(persisted, /OwnedNativeCode|never_forward|aaaaaaaa|6505a17e/);
  } finally { r.stop(); }
});
test('actual APP authorization survives the WeChat background hop and waits for its own onShow before completion POST', async () => {
  const r = loginHost(); try {
    await r.start(); const pending = r.page.handleNativeLogin(); await tick(); r.hooks.onHide(); succeed(r); await tick();
    assert.equal(completeCalls(r).length, 0); assert.equal(r.auth.uid, 11);
    r.hooks.onShow(); await pending; assert.equal(completeCalls(r).length, 1); assert.equal(r.auth.uid, 22);
  } finally { r.stop(); }
});
for (const ending of ['cancel', 'owner-ABA', 'unload', 'unmount'])
  test(`actual APP login rejects a late native callback after ${ending}`, async () => {
    const r = loginHost(); try {
      await r.start(); const pending = r.page.handleNativeLogin(); await tick();
      if (ending === 'cancel') r.page.cancelNativeLogin();
      if (ending === 'owner-ABA') { const token = r.auth.token; r.auth.setLogin('other_owner', 99); r.auth.setLogin(token, 11); }
      if (ending === 'unload') r.hooks.onUnload();
      if (ending === 'unmount') r.unmount();
      const notices = r.toasts.length, token = r.auth.token; succeed(r); await pending;
      assert.equal(completeCalls(r).length, 0); assert.equal(r.toasts.length, notices); assert.equal(r.auth.token, token);
    } finally { r.stop(); }
  });
for (const stage of ['challenge', 'services', 'complete'])
  test(`actual APP login retires a delayed ${stage} phase onHide without a late login or SDK launch`, async () => {
    const response = deferred();
    const r = loginHost({ autoLookup: stage !== 'services', override: call =>
      stage === 'challenge' && call.url.endsWith('/wechat/app_auth/state') || stage === 'complete' && call.url.endsWith('/wechat/app_auth') ? response.promise : undefined });
    let pending;
    try {
      await r.start(); pending = r.page.handleNativeLogin(); await tick();
      if (stage === 'complete') { succeed(r); await tick(); }
      r.hooks.onHide(); const notices = r.toasts.length;
      if (stage === 'services') r.lookups[0].success([r.service]);
      else response.resolve({ data: stage === 'challenge' ? challenge() : issued() });
      await pending; assert.equal(r.auth.uid, 11); assert.equal(r.toasts.length, notices);
      if (stage !== 'complete') assert.equal(r.authorizations.length, 0);
    } finally { response.resolve({ status: 400 }); if (pending) await pending; r.stop(); }
  });
for (const [label, event] of [
  ['wrong state', { code: CODE, state: STATE + 'wrong' }], ['missing state', { code: CODE }],
  ['nested authResult only', { target: { authResult: { code: CODE, state: STATE } } }],
  ['numeric code', { code: 123, state: STATE }], ['empty code', { code: '', state: STATE }],
  ['oversize code', { code: 'x'.repeat(513), state: STATE }], ['control code', { code: 'private\ncode', state: STATE }],
]) test(`actual APP controller rejects ${label} before backend completion`, async () => {
  const r = loginHost(); try {
    await r.start(); const pending = r.page.handleNativeLogin(); await tick(); r.authorizations[0].success(event); await pending;
    assert.equal(completeCalls(r).length, 0); assert.equal(r.auth.uid, 11);
    assert.ok(!r.toasts.some(toast => toast.title.includes(CODE)));
  } finally { r.stop(); }
});
for (const [label, change] of [
  ['another packaged App', { appId: 'foreign_app' }], ['bad state', { state: 'not_state' }],
  ['bad verifier', { verifier: 'not_verifier' }], ['zero TTL', { expiresIn: 0 }], ['large TTL', { expiresIn: 901 }],
  ['untrusted extra field', { openid: 'never_accept' }],
]) test(`actual APP controller rejects a challenge with ${label} before SDK`, async () => {
  const r = loginHost({ override: call => call.url.endsWith('/wechat/app_auth/state') ? { data: challenge(change) } : undefined });
  try { await r.start(); await r.page.handleNativeLogin(); assert.equal(r.authorizations.length, 0); assert.equal(completeCalls(r).length, 0); }
  finally { r.stop(); }
});
for (const change of [{ uid: '22' }, { uid: 0 }, { exp_time: 1 }, { token: 'not.a.jwt.with.more.parts' }, { openid: 'untrusted' }])
  test(`actual APP controller rejects malformed server identity ${JSON.stringify(change)} without publishing`, async () => {
    const r = loginHost({ override: call => call.url.endsWith('/wechat/app_auth') ? { data: issued(change) } : undefined });
    try { await r.start(); const pending = r.page.handleNativeLogin(); await tick(); succeed(r); await pending; assert.equal(r.auth.uid, 11); }
    finally { r.stop(); }
  });
test('actual APP double tap reserves before state POST and launches one native authorization', async () => {
  const r = loginHost(); try {
    await r.start(); const pending = r.page.handleNativeLogin(); r.page.handleNativeLogin(); await tick();
    assert.equal(r.calls.filter(call => call.url.endsWith('/wechat/app_auth/state')).length, 1); assert.equal(r.authorizations.length, 1);
    succeed(r); await pending;
  } finally { r.stop(); }
});
test('duplicate service lookup and SDK callbacks cannot open another SDK or complete twice', async () => {
  const r = loginHost(); try {
    await r.start(); const pending = r.page.handleNativeLogin(); await tick();
    r.lookups[0].success([r.service]); r.lookups[0].fail({ message: 'old failure' }); assert.equal(r.authorizations.length, 1);
    succeed(r); r.authorizations[0].fail({ message: 'old failure' }); await pending;
    assert.equal(completeCalls(r).length, 1); assert.equal(r.auth.uid, 22);
  } finally { r.stop(); }
});
for (const ending of ['cancel', 'fail', 'unreadable']) test(`native ${ending} error is sanitized and never becomes a login`, async () => {
  const r = loginHost(); try {
    await r.start(); const pending = r.page.handleNativeLogin(); await tick();
    const event = ending === 'cancel' ? { code: -2, message: CODE } : ending === 'fail' ? { code: 1, message: VERIFIER }
      : new Proxy({}, { getOwnPropertyDescriptor() { throw Error(CODE); } });
    r.authorizations[0].fail(event); await pending; assert.equal(completeCalls(r).length, 0); assert.equal(r.auth.uid, 11);
    assert.doesNotMatch(JSON.stringify(r.toasts), /OwnedNativeCode|aaaaaaaa/);
  } finally { r.stop(); }
});
for (const serviceChange of [{ nativeClient: false }, { id: 'other_provider' }, { authorize: undefined }])
  test(`native unsupported service ${JSON.stringify(serviceChange)} cannot complete`, async () => {
    const r = loginHost({ serviceChange }); try { await r.start(); await r.page.handleNativeLogin(); assert.equal(r.authorizations.length, 0); assert.equal(completeCalls(r).length, 0); }
    finally { r.stop(); }
  });
test('native callback with conflicting documented extra.state is rejected without a fallback', async () => {
  const r = loginHost({ serviceChange: { extra: { state: 'other_state' } } }); try {
    await r.start(); const pending = r.page.handleNativeLogin(); await tick(); succeed(r); await pending;
    assert.equal(completeCalls(r).length, 0);
  } finally { r.stop(); }
});
test('missing public OAuth package configuration fails before state POST', async () => {
  const r = loginHost({ manifest: {} }); try { await r.start(); await r.page.handleNativeLogin(); assert.equal(r.calls.length, 0); assert.equal(r.authorizations.length, 0); }
  finally { r.stop(); }
});
test('actual APP phone continuation keeps native and human challenge keys separate through hide/show', async () => {
  const r = loginHost({ override: call => call.url.endsWith('/wechat/app_auth') ? { data: { need_phone: true, key: KEY, expiresIn: 300 } } : undefined });
  let sms;
  try {
    await r.start(); const login = r.page.handleNativeLogin(); await tick(); succeed(r); await login;
    assert.equal(r.auth.uid, 11); assert.equal(r.page.nativePhoneRequired.value, true);
    r.page.nativePhone.value = '13800138000'; sms = r.page.sendNativePhoneCode(); await tick();
    assert.equal(r.calls.find(call => call.url.endsWith('/verify_code')).data.type, 'social_binding');
    r.hooks.onHide(); await r.module('smsChallenge').confirmPendingSmsChallenge('human_challenge'); await tick();
    assert.equal(r.calls.filter(call => call.url.endsWith('/register/verify')).length, 0);
    r.hooks.onShow(); await sms;
    assert.deepEqual(r.calls.find(call => call.url.endsWith('/register/verify')).data, { phone: '13800138000', type: 'social_binding', key: 'human_challenge' });
    r.page.nativeCaptcha.value = '123456'; await r.page.completeNativePhoneLogin();
    assert.deepEqual(r.calls.find(call => call.url.endsWith('/wechat/app_auth/phone')).data, { key: KEY, verifier: VERIFIER, phone: '13800138000', captcha: '123456' });
    assert.equal(r.auth.uid, 22); assert.doesNotMatch(JSON.stringify([...r.storage]), /aaaaaaaa|6505a17e|123456/);
  } finally { await r.module('smsChallenge').confirmPendingSmsChallenge('human_challenge'); if (sms) await sms; r.stop(); }
});
for (const ending of ['owner-ABA', 'cancel', 'unload'])
  test(`native phone continuation cannot issue or send SMS after ${ending}`, async () => {
    const r = loginHost({ override: call => call.url.endsWith('/wechat/app_auth') ? { data: { need_phone: true, key: KEY, expiresIn: 300 } } : undefined });
    let sms;
    try {
      await r.start(); const login = r.page.handleNativeLogin(); await tick(); succeed(r); await login;
      r.page.nativePhone.value = '13800138000'; sms = r.page.sendNativePhoneCode(); await tick();
      if (ending === 'owner-ABA') { const token = r.auth.token; r.auth.setLogin('other', 99); r.auth.setLogin(token, 11); }
      if (ending === 'cancel') r.page.cancelNativeLogin();
      if (ending === 'unload') r.hooks.onUnload();
      await r.module('smsChallenge').confirmPendingSmsChallenge('human_challenge'); await sms;
      assert.equal(r.calls.filter(call => call.url.endsWith('/register/verify')).length, 0);
      assert.equal(r.calls.filter(call => call.url.endsWith('/wechat/app_auth/phone')).length, 0); assert.equal(r.auth.uid, 11);
    } finally { await r.module('smsChallenge').confirmPendingSmsChallenge('human_challenge'); if (sms) await sms; r.stop(); }
  });
test('MP controller import path retains existing login and does not import native authorization', async () => {
  const r = loginHost({ platform: 'MP-WEIXIN', manifest: {} }); try {
    await r.start(); assert.equal(r.page.handleNativeLogin, undefined); assert.equal(r.calls.length, 0);
    assert.equal(r.page.mode.value, 'password');
  } finally { r.stop(); }
});

for (const stage of ['state', 'services', 'sdk'])
  test(`two actual login instances share one native lease before another state POST during ${stage}`, async () => {
    const sharedStorage = new Map(), sdkHost = host({ sharedStorage, autoLookup: stage !== 'services' });
    const nativeEntry = sdkHost.module('nativeWechatAuthorizeEntry'), response = deferred();
    const common = { nativeEntry, sharedStorage, sharedPinia: sdkHost.activePinia };
    const first = loginHost({ ...common, override: call => stage === 'state' && call.url.endsWith('/wechat/app_auth/state') ? response.promise : undefined });
    const second = loginHost(common); let pending;
    try {
      await first.start(); pending = first.page.handleNativeLogin(); await tick();
      assert.equal(first.calls.filter(call => call.url.endsWith('/wechat/app_auth/state')).length, 1);
      await second.start(); await second.page.handleNativeLogin();
      assert.equal(second.calls.length, 0);
      assert.equal(sdkHost.authorizations.length, stage === 'sdk' ? 1 : 0);
      if (stage === 'state') { response.resolve({ data: challenge() }); await tick(); }
      if (stage === 'services') sdkHost.lookups[0].success([sdkHost.service]);
      assert.equal(sdkHost.authorizations.length, 1);
      sdkHost.authorizations[0].success({ code: CODE, state: STATE }); await pending;
      assert.equal(first.auth, second.auth); assert.equal(first.auth.uid, 22);
      const next = nativeEntry.reserveNativeWechatAuthorize(() => true);
      sdkHost.authorizations[0].success({ code: CODE, state: STATE }); sdkHost.authorizations[0].fail({ message: 'old cancel' });
      assert.throws(() => nativeEntry.reserveNativeWechatAuthorize(() => true), { kind: 'busy' }); next.release();
    } finally {
      response.resolve({ status: 400 }); sdkHost.authorizations.forEach(call => call.fail({ message: 'fixture closed' }));
      if (pending) await pending; first.stop(); second.stop(); sdkHost.stop();
    }
  });
