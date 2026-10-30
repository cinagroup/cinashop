const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { createRequire } = require('node:module');
const repository = path.resolve(__dirname, '../../..'), installed = createRequire(path.join(repository, 'view/admin-ts/package.json'));
const ts = installed('typescript'), vue = installed('vue'), sfc = installed('@vue/compiler-sfc'), dom = installed('@vue/compiler-dom');
const OLD = 'wx0000000000000000', FRESH = 'wx1111111111111111';
// Native Vue v-model directives use the element's DOM event/property contract
// even with a custom renderer. Keep those real directives active in this host.
if (typeof globalThis.Document === 'undefined') globalThis.Document = class Document {};
if (typeof globalThis.ShadowRoot === 'undefined') globalThis.ShadowRoot = class ShadowRoot {};
const tick = async () => { for (let i = 0; i < 5; i++) { await vue.nextTick(); await new Promise(setImmediate); } };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function all(node, predicate) { return [...(predicate(node) ? [node] : []), ...(node.children ?? []).flatMap(child => all(child, predicate))]; }
function text(node) { return node.tag === '#comment' ? '' : (node.text ?? '') + (node.children ?? []).map(text).join(''); }

// Both real SFC script/template pairs and real session generation modules run
// in a Vue renderer. Only API transport, router and auth publication are seams.
function runtime(audience, options = {}) {
  const pc = audience === 'pc', root = path.join(repository, pc ? 'view/pc-ts/src' : 'view/kefu-ts/src');
  const selected = path.join(root, pc ? 'pages/auth/Login.vue' : 'pages/LoginPage.vue');
  const cache = new Map(), calls = [], redirects = [], assigned = [], applied = [], warnings = [], errors = [], messages = [], storage = new Map(), writes = [];
  let bindings, alive = true, session;
  const sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, String(value)); writes.push({ key, value: String(value) }); }, removeItem: key => storage.delete(key) };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const window = new EventTarget(); window.location = { origin: 'https://shop.example.test', assign: url => assigned.push(url) };
  const route = vue.reactive({ path: '/login', query: options.query ?? {}, hash: '' });
  const router = { replace: value => { redirects.push(value); return options.replace ? options.replace(value) : Promise.resolve(); } };
  const state = async () => { calls.push({ type: 'state' }); return options.state ? options.state() : { state: 'owned-state', appid: FRESH, expires_in: 900 }; };
  const login = async (code, state) => { calls.push({ type: 'login', code, state }); return options.login ? options.login() : { token: 'owned-new-token', exp_time: 1799999999, kefuInfo: { id: 88, uid: 77 } }; };
  const auth = { applyLogin: value => { applied.push(value); if (pc) session.setAuth(value.token, 77); else { sessionStorage.setItem(session.KEFU_TOKEN_KEY, value.token); session.announceKefuSessionChange(); } }, login: async () => {}, mobileLogin: async () => {} };
  const api = { apiPcAppConfig: async () => ({ appid: OLD }), apiCreatePcOauthState: state, apiPcWechatAuth: login,
    apiCreatePcScanChallenge: async () => { throw Error('Uncontrolled scan transport'); }, apiPollPcScanChallenge: async () => { throw Error('Uncontrolled poll transport'); }, apiRequestCode: async () => {} };
  const kefuApi = { config: async () => ({ appid: OLD }), createOauthState: state, wechatLogin: login,
    createScanChallenge: api.apiCreatePcScanChallenge, pollScanChallenge: api.apiPollPcScanChallenge };
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts'; if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports); let input = fs.readFileSync(file, 'utf8'), descriptor, script;
    if (file.endsWith('.vue')) { descriptor = sfc.parse(input, { filename: file }).descriptor; script = sfc.compileScript(descriptor, { id: 'open-real-login' }); input = script.content; }
    input = input.replace(/import\.meta\.env\.VITE_SCAN_LOGIN_URL/g, 'undefined');
    const output = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    new Function('require', 'exports', 'window', 'sessionStorage', 'localStorage', output)(name => {
      if (name === 'vue') return vue;
      if (name === 'vue-router') return { useRoute: () => route, useRouter: () => router };
      if (name === 'qrcode') return { toDataURL: async () => 'owned-qr' };
      if (name === 'element-plus') return { ElMessage: { error: value => messages.push(value), success() {}, warning() {} } };
      if (name === '@/api/auth') return api;
      if (name === '@/api/kefu') return { kefuApi };
      if (name === '@/stores/auth') return { useAuthStore: () => auth };
      if (name === '@/composables/smsChallenge') return { requestSmsChallenge: async () => 'owned-sms' };
      if (name.endsWith('UiIcon.vue')) return { __esModule: true, default: { name: 'ControlledUiIcon', render: () => vue.h('i') } };
      if (name.startsWith('@/')) return load(path.join(root, name.slice(2)));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name));
      throw Error('Unexpected login dependency ' + name);
    }, exports, window, sessionStorage, localStorage);
    if (descriptor) {
      const component = exports.default, setup = component.setup;
      component.setup = (props, ctx) => { const values = setup(props, ctx); bindings = vue.proxyRefs(values); return values; };
      const compiled = dom.compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, cacheHandlers: true, bindingMetadata: script.bindings, expressionPlugins: ['typescript'] });
      component.render = new Function('Vue', ts.transpileModule(compiled.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(vue);
    }
    return exports;
  }
  session = load(path.join(root, pc ? 'utils/auth.ts' : 'services/session.ts'));
  const documentRoot = new Document(); documentRoot.activeElement = null;
  const tree = { tag: 'root', children: [], props: {} };
  const node = (tag, value = '') => Object.assign(new EventTarget(), {
    tag, tagName: tag.toUpperCase(), text: value, children: [], props: {}, parent: null,
    value: '', defaultValue: '', type: 'text', composing: false, ownerDocument: documentRoot,
    getRootNode() { return documentRoot; },
    getAttribute(name) { return this.props[name] ?? null; },
    setAttribute(name, value) { this.props[name] = String(value); },
    removeAttribute(name) { delete this.props[name]; },
  });
  const renderer = vue.createRenderer({
    createElement: tag => node(tag), createText: value => node('#text', value), createComment: value => node('#comment', value),
    setText: (n, value) => { n.text = value; }, setElementText: (n, value) => { n.text = value; n.children = []; },
    parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
    patchProp: (n, key, _old, value) => { n.props[key] = value; if (['value', 'type', 'checked', 'disabled', 'readOnly'].includes(key)) n[key] = value; },
    insert(n, parent, anchor = null) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(n); else parent.children.splice(index, 0, n); },
    remove(n) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; },
  });
  const app = renderer.createApp(load(selected).default);
  app.config.warnHandler = value => warnings.push(value); app.config.errorHandler = value => errors.push(value);
  for (const name of ['ElAlert', 'ElTabs', 'ElTabPane', 'ElForm', 'ElFormItem', 'ElInput', 'ElButton', 'RouterLink']) {
    app.component(name, { inheritAttrs: false, setup: (_, context) => () => vue.h(name === 'ElButton' ? 'button' : name === 'ElInput' ? 'input' : 'div', context.attrs, context.slots.default?.()) });
  }
  app.mount(tree);
  return { tree, calls, redirects, assigned, applied, warnings, errors, messages, storage, writes, route, session,
    get bindings() { return bindings; },
    changeSession(token = 'other-token') { if (pc) session.setAuth(token, 99); else { sessionStorage.setItem(session.KEFU_TOKEN_KEY, token); session.announceKefuSessionChange(); } },
    unmount() { if (alive) { alive = false; app.unmount(); } },
    async clickWechat() { const button = all(tree, n => n.tag === 'button' && text(n).includes('微信开放平台登录'))[0]; assert.ok(button); assert.ok(!button.props.disabled); button.props.onClick(); await tick(); },
  };
}

for (const audience of ['pc', 'kefu']) {
  function scenario(name, run) { test(audience + ': ' + name, async t => {
    const instances = [], mount = async options => { const r = runtime(audience, options); instances.push(r); await tick(); return r; };
    t.after(async () => { for (const r of instances) { r.unmount(); await tick(); assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []); } });
    await run(mount);
  }); }
  scenario('actual button uses state-bound fresh AppID rather than older public bootstrap', async mount => {
    const r = await mount();
    if (audience === 'kefu') {
      const input = all(r.tree, node => node.tag === 'input' && node.props.name === 'account')[0];
      assert.ok(input); input.value = 'owned-native-model'; input.dispatchEvent(new Event('input')); await tick();
      assert.equal(r.bindings.account, 'owned-native-model');
    }
    await r.clickWechat(); assert.equal(r.assigned.length, 1);
    const url = new URL(r.assigned[0]); assert.equal(url.origin, 'https://open.weixin.qq.com'); assert.equal(url.pathname, '/connect/qrconnect');
    assert.equal(url.searchParams.get('appid'), FRESH); assert.equal(url.searchParams.get('state'), 'owned-state');
    assert.equal(url.searchParams.get('scope'), 'snsapi_login'); assert.equal(url.searchParams.get('redirect_uri'), 'https://shop.example.test/login');
    assert.ok(!JSON.stringify(r.writes).includes('secret'));
  });
  for (const replacement of ['unmount', 'different token', 'same token event']) {
    scenario('late state cannot redirect after ' + replacement, async mount => {
      const gate = deferred(), r = await mount({ state: () => gate.promise });
      if (replacement === 'same token event') r.changeSession('same-token');
      await r.clickWechat(); assert.equal(r.calls.length, 1);
      if (replacement === 'unmount') r.unmount(); else r.changeSession(replacement === 'same token event' ? 'same-token' : 'different-token');
      const before = r.writes.length; gate.resolve({ state: 'late-state', appid: FRESH }); await tick();
      assert.deepEqual(r.assigned, []); assert.equal(r.writes.length, before); assert.deepEqual(r.applied, []);
    });
    scenario('late OAuth bearer cannot overwrite session after ' + replacement, async mount => {
      const gate = deferred(), r = await mount({ query: { code: 'owned-code', state: 'owned-state' }, login: () => gate.promise });
      assert.equal(r.calls.filter(call => call.type === 'login').length, 1);
      assert.deepEqual(r.redirects[0], { path: '/login', query: {}, hash: '' });
      if (replacement === 'same token event') r.changeSession('same-token');
      if (replacement === 'unmount') r.unmount(); else r.changeSession(replacement === 'same token event' ? 'same-token' : 'different-token');
      gate.resolve({ token: 'late-owned-token', exp_time: 1799999999 }); await tick();
      assert.deepEqual(r.applied, []); assert.equal(r.redirects.length, 1); assert.ok(![...r.storage.values()].includes('late-owned-token'));
    });
  }
  scenario('session change during router cleanup prevents even starting OAuth exchange', async mount => {
    const gate = deferred(), r = await mount({ query: { code: 'owned-code', state: 'owned-state' }, replace: () => gate.promise });
    r.changeSession(); gate.resolve(); await tick(); assert.equal(r.calls.filter(call => call.type === 'login').length, 0);
  });
  scenario('current successful callback publishes exactly once and clears credentials from route before exchange', async mount => {
    const r = await mount({ query: { code: 'owned-code', state: 'owned-state', redirect: audience === 'pc' ? '/user/order?x=1#owned' : '/workbench?x=1#owned' } });
    assert.equal(r.applied.length, 1); assert.equal(r.applied[0].token, 'owned-new-token'); assert.equal(r.calls.filter(call => call.type === 'login').length, 1);
    assert.ok(!('code' in r.redirects[0].query)); assert.ok(!('state' in r.redirects[0].query));
    assert.equal(r.redirects[1], audience === 'pc' ? '/user/order?x=1#owned' : '/workbench?x=1#owned');
  });
  scenario('invalid or failed state response stays local and offers retry', async mount => {
    let calls = 0; const r = await mount({ state: async () => { calls++; if (calls === 1) return { state: 'bad', appid: 'wx123456' }; return { state: 'retry', appid: FRESH }; } });
    await r.clickWechat(); assert.deepEqual(r.assigned, []); await r.clickWechat(); assert.equal(r.assigned.length, 1);
  });
}
