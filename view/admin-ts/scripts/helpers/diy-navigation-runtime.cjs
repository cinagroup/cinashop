const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vue = require('vue');
const sfc = require('@vue/compiler-sfc');
const dom = require('@vue/compiler-dom');

const root = path.resolve(__dirname, '../../src');
const editorFile = path.join(root, 'components/content/DiyNavigationEditor.vue');
const pickerFile = path.join(root, 'pages/activity/SeckillActivityImagePicker.vue');
const pageFile = path.join(root, 'pages/content/DiseList.vue');
const utilFile = path.join(root, 'utils/diyNavigationEditor.ts');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = async () => { await vue.nextTick(); await new Promise(setImmediate); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const ticketExpires = Math.floor(Date.now() / 1000) + 900;
const ticket = (id, expires = ticketExpires) => `/api/assets/${id}?expires=${expires}&signature=${'A'.repeat(43)}`;
const node = tag => ({ tag, props: {}, children: [], parent: null, text: '', style: {} });
const renderer = vue.createRenderer({
  createElement: node,
  createText: text => ({ ...node('#text'), text }),
  createComment: text => ({ ...node('#comment'), text }),
  setText: (n, text) => { n.text = text; },
  setElementText: (n, text) => { n.text = text; n.children = []; },
  parentNode: n => n.parent,
  nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
  patchProp: (n, key, _old, value) => { n.props[key] = value; },
  insert(n, parent, anchor) {
    if (n.parent) { const index = n.parent.children.indexOf(n); if (index >= 0) n.parent.children.splice(index, 1); }
    n.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(n); else parent.children.splice(index, 0, n);
  },
  remove(n) { if (n.parent) { const index = n.parent.children.indexOf(n); if (index >= 0) n.parent.children.splice(index, 1); n.parent = null; } },
});
function all(tree, predicate) { const result = []; function visit(n) { if (predicate(n)) result.push(n); n.children?.forEach(visit); } visit(tree); return result; }
const text = n => n.text + (n.children ?? []).map(text).join('');

// Vue, the actual compiled SFC templates, picker and author utilities run here.
// Element components adapt only their documented props, slots and update events.
function elementStub(name) {
  return vue.defineComponent({ name, inheritAttrs: false, props: ['modelValue', 'disabled', 'label', 'title'], emits: ['update:modelValue'],
    setup(props, { attrs, slots, emit }) { return () => {
      if (name === 'el-table-column' || name === 'el-dialog' && !props.modelValue) return null;
      const tag = name === 'el-button' ? 'button' : name === 'el-input' || name === 'el-input-number' ? 'input' : 'section';
      return vue.h(tag, { ...attrs, disabled: props.disabled, 'data-element': name,
        'data-label': props.label, 'data-title': props.title, modelValue: props.modelValue,
        'onUpdate:modelValue': value => emit('update:modelValue', value),
      }, tag === 'input' ? null : [slots.default?.(), slots.footer?.()]);
    }; },
  });
}
const elementNames = ['el-alert', 'el-button', 'el-select', 'el-option', 'el-form', 'el-form-item', 'el-input', 'el-input-number', 'el-dialog', 'el-pagination', 'el-image', 'el-upload', 'el-table', 'el-table-column', 'el-tag', 'el-switch', 'el-descriptions', 'el-descriptions-item', 'el-divider', 'el-color-picker', 'el-radio', 'el-radio-group', 'el-card', 'el-tooltip'];
function loader(options = {}) {
  const cache = new Map(), instances = new Map(), notices = [], calls = [], galleryCalls = [], categoryCalls = [], uploadCalls = [];
  const actor = options.actor ?? vue.reactive({ token: 'A', userInfo: { id: 11, level: 0 }, uniqueAuth: [] });
  const storage = new Map([['admin_token', 'A'], ['admin_session', 'session-A']]);
  const window = new EventTarget();
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  const gateway = options.gateway ?? { get: async url => { calls.push({ method: 'GET', url }); return { data: [] }; }, post: async (url, body) => { calls.push({ method: 'POST', url, body: clone(body) }); return { data: { id: 2 } }; } };
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    let source = fs.readFileSync(file, 'utf8'), descriptor, script;
    source = options.sourceTransform ? options.sourceTransform(source, file) : source.replace(/\bimport\.meta\.env\.DEV\b/gu, 'false');
    if (file.endsWith('.vue')) { descriptor = sfc.parse(source, { filename: file }).descriptor; script = sfc.compileScript(descriptor, { id: 'navigation-editor-runtime' }); source = script.content; }
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    new Function('require', 'exports', 'window', 'localStorage', output)(name => {
      if (name === 'vue') return vue;
      if (name === 'element-plus') return { ElMessage: { error: value => notices.push(['error', value]), success: value => notices.push(['success', value]), warning: value => notices.push(['warning', value]) }, ElMessageBox: { confirm: async () => {} } };
      if (name === '@/stores/auth') return { useAuthStore: () => actor };
      if (name === '@/utils/auth' && options.actualAuth) return load(path.join(root, 'utils/auth.ts'));
      if (name === '@/utils/auth') return { getToken: () => storage.get('admin_token') ?? null, getAdminSession: () => ({ userInfo: actor.userInfo, uniqueAuth: actor.uniqueAuth }) };
      if (name === '@/utils/request') return { __esModule: true, default: gateway, getData: async promise => (await promise).data };
      if (name === '@/api/attachment') return {
        apiAttachmentCategories: async (signal, params) => { categoryCalls.push({ signal, params }); return (options.categories ?? (async () => ({ list: [] })))(signal, params); },
        apiAttachmentList: async (params, signal) => { galleryCalls.push({ params: clone(params), signal }); return (options.gallery ?? (async () => ({ list: [], count: 0 })))(params, signal); },
        apiAttachmentUpload: async (file, pid, signal) => { uploadCalls.push({ file, pid, signal }); return (options.upload ?? (async () => ({ att_id: 18, url: '/api/assets/18', src: ticket(18) })))(file, pid, signal); },
      };
      // These adjacent editors are not this suite's producer. Keep the footer's
      // real named canonicalizer because actual DiseList.save composes it.
      // Isolate the adjacent view; retain the separate real editorial canonicalizer.
      if (name === '@/components/content/DiyCommunityEditor.vue') return { __esModule: true, default: vue.defineComponent({ setup: () => () => null }) };
      if (name === '@/components/content/DiyCommerceEditor.vue') return { __esModule: true, default: vue.defineComponent({ setup: () => () => null }) };
      if (name === '@/components/content/DiyEditorialEditor.vue') return { __esModule: true, default: vue.defineComponent({ setup: () => () => null }) };
      if (name === '@/components/content/DiyPresentationEditor.vue') return { __esModule: true, default: vue.defineComponent({ setup: () => () => null }) };
      if (name === '@/components/content/DiyFooterEditor.vue') return { __esModule: true, ...load(path.join(root, name.slice(2))), default: vue.defineComponent({ setup: () => () => null }) };
      if (name.startsWith('@/')) return load(path.join(root, name.slice(2)));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name));
      return require(name);
    }, exports, window, localStorage);
    if (descriptor) {
      const component = exports.default, setup = component.setup;
      component.setup = (props, context) => { const state = setup(props, context); const values = instances.get(file) ?? []; values.push(vue.proxyRefs(state)); instances.set(file, values); return state; };
      component.render = new Function('Vue', dom.compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, bindingMetadata: script.bindings }).code)(vue);
    }
    return exports;
  }
  return { load, instances, actor, storage, localStorage, window, notices, calls, galleryCalls, categoryCalls, uploadCalls, componentOverrides: options.componentOverrides };
}
function mount(l, file, props, emit = () => {}) {
  const tree = node('root'), component = l.load(file).default;
  const app = renderer.createApp({ setup: () => () => vue.h(component, { ...props, 'onUpdate:modelValue': value => emit('update:modelValue', value) }) });
  for (const name of elementNames) app.component(name, l.componentOverrides?.[name] ?? elementStub(name));
  app.directive('loading', {});
  app.mount(tree);
  let alive = true;
  return { tree, get state() { return l.instances.get(file).at(-1); },
    get picker() { return l.instances.get(pickerFile)?.at(-1); },
    get linkPicker() { return l.instances.get(path.join(root,'components/content/DiyAuthorLinkPicker.vue'))?.at(-1); },
    unmount() { if (alive) { alive = false; app.unmount(); } },
  };
}

module.exports = { test, assert, fs, path, ts, vue, sfc, dom, root, editorFile, pickerFile, pageFile, utilFile, clone, tick, deferred, ticket, node, renderer, all, text, elementStub, elementNames, loader, mount };
