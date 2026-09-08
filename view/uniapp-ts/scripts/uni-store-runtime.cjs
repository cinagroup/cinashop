const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vue = require('vue');
const pinia = require('pinia');
const root = path.resolve(__dirname, '..');
const tick = async () => { for (let i = 0; i < 8; i++) { await vue.nextTick(); await new Promise(setImmediate); } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Real Vue reactivity, Pinia stores, request layer, API adapters and the selected composable.
// Only native lifecycle/I/O is replaced. Platform preprocessing is covered by the three builds, not this loader.
function runtime({ storage = new Map(), send, navigationFails = false, feature = 'useCheckout', component } = {}) {
  const hooks = {}, calls = [], navigations = [], toasts = [], cache = new Map();
  const uni = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    navigateTo: opts => navigations.push(opts.url), redirectTo: opts => { navigations.push(opts.url); if (navigationFails) opts.fail(new Error('navigation failed')); else opts.success(); },
    showToast: opts => toasts.push(opts), switchTab: opts => navigations.push(opts.url),
    request: call => { calls.push(structuredClone({ url: call.url, data: call.data })); Promise.resolve().then(() => send(call)).then(result => {
      if (result?.transport) call.fail({ errMsg: result.transport });
      else call.success({ statusCode: result?.httpStatus ?? 200, header: result?.headers ?? {}, data: { status: result?.status ?? 200, msg: result?.msg ?? 'ok', data: result?.data } });
    }).catch(error => call.fail({ errMsg: error.message })); },
  };
  const lifecycle = Object.fromEntries(['onLoad', 'onShow', 'onHide', 'onUnload', 'onShareAppMessage'].map(name => [name, fn => { hooks[name] = fn; }]));
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file);
    assert.ok(existsSync(file), file);
    const exports = {}; cache.set(file, exports);
    let source = readFileSync(file, 'utf8');
    if (file.endsWith('.vue')) {
      const { parse, compileScript } = require('@vue/compiler-sfc');
      source = compileScript(parse(source, { filename: file }).descriptor, { id: 'actual-page-runtime' }).content;
    }
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    new Function('require', 'exports', 'uni', output)(id => {
      if (id === 'vue') return vue; if (id === 'pinia') return pinia; if (id === '@dcloudio/uni-app') return lifecycle;
      if (id.startsWith('@/')) return load(path.join(root, 'src', id.slice(2)));
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
      throw new Error(`Unreplaced dependency: ${id}`);
    }, exports, uni);
    return exports;
  }
  pinia.setActivePinia(pinia.createPinia());
  const auth = load(path.join(root, 'src/stores/auth.ts')).useAuthStore();
  if (!auth.isLoggedIn) auth.setLogin('synthetic-local-token', 11);
  const scope = vue.effectScope();
  const checkout = scope.run(() => component
    ? load(path.join(root, 'src', component)).default.setup({}, { expose() {} })
    : load(path.join(root, 'src/composables', feature + '.ts'))[feature]());
  return { checkout, auth, storage, calls, navigations, toasts, hooks, load, uni,
    async start(query = { mode: 'buy', cartId: '1' }) { await hooks.onLoad?.(query); hooks.onShow?.(); await tick(); },
    stop() { hooks.onUnload?.(); scope.stop(); },
  };
}

module.exports = { runtime, tick, deferred };
