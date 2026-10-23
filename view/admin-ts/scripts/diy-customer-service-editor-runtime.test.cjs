const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vue = require('vue');
const sfc = require('@vue/compiler-sfc');
const dom = require('@vue/compiler-dom');

const root = path.resolve(__dirname, '../src');
const editorFile = path.join(root, 'components/content/DiyCustomerServiceEditor.vue');
const pickerFile = path.join(root, 'pages/activity/SeckillActivityImagePicker.vue');
const pageFile = path.join(root, 'pages/content/DiseList.vue');
const utilFile = path.join(root, 'utils/diyCustomerServiceEditor.ts');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = async () => { await vue.nextTick(); await new Promise(setImmediate); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const ticketExpires = Math.floor(Date.now() / 1000) + 900;
const ticket = (id, expires = ticketExpires) => `/api/assets/${id}?expires=${expires}&signature=${'A'.repeat(43)}`;
const node = tag => ({ tag, props: {}, children: [], parent: null, text: '' });
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
const elementNames = ['el-alert', 'el-button', 'el-select', 'el-option', 'el-form', 'el-form-item', 'el-input', 'el-input-number', 'el-dialog', 'el-pagination', 'el-image', 'el-upload', 'el-table', 'el-table-column', 'el-tag', 'el-switch', 'el-descriptions', 'el-descriptions-item', 'el-divider', 'el-card', 'el-tooltip'];
function loader(options = {}) {
  const cache = new Map(), instances = new Map(), notices = [], calls = [], galleryCalls = [], categoryCalls = [], uploadCalls = [];
  const actor = options.actor ?? vue.reactive({ token: 'A', userInfo: { id: 11, level: 0 }, uniqueAuth: [] });
  const storage = new Map([['admin_token', 'A'], ['admin_session', 'session-A']]);
  const window = new EventTarget();
  const gateway = options.gateway ?? { get: async url => { calls.push({ method: 'GET', url }); return { data: [] }; }, post: async (url, body) => { calls.push({ method: 'POST', url, body: clone(body) }); return { data: { id: 2 } }; } };
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    let source = fs.readFileSync(file, 'utf8'), descriptor, script;
    if (file.endsWith('.vue')) { descriptor = sfc.parse(source, { filename: file }).descriptor; script = sfc.compileScript(descriptor, { id: 'customer-editor-runtime' }); source = script.content; }
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    new Function('require', 'exports', 'window', 'localStorage', output)(name => {
      if (name === 'vue') return vue;
      if (name === 'element-plus') return { ElMessage: { error: value => notices.push(['error', value]), success: value => notices.push(['success', value]), warning: value => notices.push(['warning', value]) }, ElMessageBox: { confirm: async () => {} } };
      if (name === '@/stores/auth') return { useAuthStore: () => actor };
      if (name === '@/utils/auth') return { getToken: () => storage.get('admin_token') ?? null, getAdminSession: () => ({ userInfo: actor.userInfo, uniqueAuth: actor.uniqueAuth }) };
      if (name === '@/utils/request') return { __esModule: true, default: gateway, getData: async promise => (await promise).data };
      if (name === '@/api/attachment') return {
        apiAttachmentCategories: async (signal, params) => { categoryCalls.push({ signal, params }); return (options.categories ?? (async () => ({ list: [] })))(signal, params); },
        apiAttachmentList: async (params, signal) => { galleryCalls.push({ params: clone(params), signal }); return (options.gallery ?? (async () => ({ list: [], count: 0 })))(params, signal); },
        apiAttachmentUpload: async (file, pid, signal) => { uploadCalls.push({ file, pid, signal }); return (options.upload ?? (async () => ({ att_id: 18, url: '/api/assets/18', src: ticket(18) })))(file, pid, signal); },
      };
      // These adjacent editors are not this suite's producer. Keep the footer's
      // real named canonicalizer because actual DiseList.save composes it.
      if (name === '@/components/content/DiyPresentationEditor.vue') return { __esModule: true, default: vue.defineComponent({ setup: () => () => null }) };
      if (name === '@/components/content/DiyFooterEditor.vue') return { __esModule: true, ...load(path.join(root, name.slice(2))), default: vue.defineComponent({ setup: () => () => null }) };
      if (name.startsWith('@/')) return load(path.join(root, name.slice(2)));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name));
      return require(name);
    }, exports, window, { getItem: key => storage.get(key) ?? null });
    if (descriptor) {
      const component = exports.default, setup = component.setup;
      component.setup = (props, context) => { const state = setup(props, context); const values = instances.get(file) ?? []; values.push(vue.proxyRefs(state)); instances.set(file, values); return state; };
      component.render = new Function('Vue', dom.compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, bindingMetadata: script.bindings }).code)(vue);
    }
    return exports;
  }
  return { load, instances, actor, storage, window, notices, calls, galleryCalls, categoryCalls, uploadCalls };
}
function mount(l, file, props, emit = () => {}) {
  const tree = node('root'), component = l.load(file).default;
  const app = renderer.createApp({ setup: () => () => vue.h(component, { ...props, 'onUpdate:modelValue': value => emit('update:modelValue', value) }) });
  for (const name of elementNames) app.component(name, elementStub(name));
  app.directive('loading', {});
  app.mount(tree);
  let alive = true;
  return { tree, get state() { return l.instances.get(file).at(-1); },
    get picker() { return l.instances.get(pickerFile)?.at(-1); },
    unmount() { if (alive) { alive = false; app.unmount(); } },
  };
}
function service(timestamp = 10) { return { name: 'customerService', cname: '原作者按钮', timestamp, isHide: false, setUp: { tabVal: 0, unknown: 'keep' }, buttonConfig: { tabVal: 0, metadata: 1 }, locationConfig: { tabVal: 1, metadata: 2 }, topConfig: { val: 0, min: 0, metadata: 3 }, logoConfig: { url: '/api/assets/18', link: '/pages/user/index?from=A&B', metadata: 4 }, routine_contact_type: 91, unknown: { preserve: true } }; }
function blocks() { return [service(), { name: 'other', timestamp: 15, url: ticket(99), nested: { untouched: true } }, { name: 'titles', timestamp: 20, titleConfig: { value: '原标题' } }, { name: 'pageFoot', timestamp: 900, menuList: [] }]; }
function harness(value = blocks(), options = {}) {
  const l = loader(options), props = vue.reactive({ modelValue: JSON.stringify(value), editorKey: 'A:row2', disabled: false, pageId: 2, pagePublished: true, ...options.props }), emits = [];
  const mounted = mount(l, editorFile, props, (name, value) => { emits.push({ name, value }); props.modelValue = value; });
  return { ...l, ...mounted, get state() { return mounted.state; }, get picker() { return mounted.picker; }, props, emits, value: () => JSON.parse(props.modelValue) };
}
function control(r, label) { const field = all(r.tree, n => n.props['data-element'] === 'el-form-item' && n.props['data-label'] === label)[0]; assert.ok(field, `actual field ${label}`); const input = all(field, n => ['el-select', 'el-input-number', 'el-input'].includes(n.props['data-element']))[0]; assert.ok(input, `actual input ${label}`); return value => input.props['onUpdate:modelValue'](value); }
function click(r, caption) { const button = all(r.tree, n => n.tag === 'button' && text(n) === caption)[0]; assert.ok(button, `actual button ${caption}`); assert.equal(!!button.props.disabled, false); button.props.onClick(); }
const image = (id = 18) => ({ att_id: id, canonical_url: `/api/assets/${id}`, att_dir: ticket(id), satt_dir: ticket(id), real_name: `图标${id}`, file_type: 1 });

test('actual customer and DiseList templates compile and mounted typed fields render the current preview', async () => {
  const r = harness(); try { await tick(); assert.match(text(r.tree), /页面悬浮按钮/); for (const label of ['组件显示', '按钮跳转', '显示位置', '初始上下偏移（%）', '图标稳定地址', '页面链接']) assert.equal(typeof control(r, label), 'function'); const preview = all(r.tree, n => n.props.class === 'preview-button')[0]; assert.deepEqual(preview.props.style, { top: '30%', left: 'auto', right: '10px' }); assert.equal(r.state.preview, ''); } finally { r.unmount(); }
  for (const file of [editorFile, pageFile]) { const parsed = sfc.parse(fs.readFileSync(file, 'utf8'), { filename: file }); assert.deepEqual(parsed.errors, []); const script = sfc.compileScript(parsed.descriptor, { id: 'customer-template-proof' }); assert.deepEqual(sfc.compileTemplate({ source: parsed.descriptor.template.content, filename: file, id: 'customer-template-proof', compilerOptions: { bindingMetadata: script.bindings } }).errors, []); }
});

test('actual typed update events patch only selected fields and retain the full array, unknown metadata and independent neighbours', async () => {
  const r = harness(); try { const before = r.value(); control(r, '按钮跳转')(1); await tick(); control(r, '显示位置')(0); await tick(); control(r, '初始上下偏移（%）')(42); await tick(); control(r, '页面链接')('/pages/annex/special/index?id=2'); await tick(); control(r, '组件显示')(false); await tick(); const expected = clone(before); expected[0].buttonConfig.tabVal = 1; expected[0].locationConfig.tabVal = 0; expected[0].topConfig.val = 42; expected[0].logoConfig.link = '/pages/annex/special/index?id=2'; expected[0].isHide = true; assert.deepEqual(r.value(), expected); assert.equal(all(r.tree, n => n.props.class === 'preview-button').length, 0); } finally { r.unmount(); }
});

test('number0 and string0 retain actual PHP truthiness and raw imported author values without an implicit rewrite', async () => {
  const value = [service(), service(20)]; for (const key of ['buttonConfig', 'locationConfig']) { value[0][key].tabVal = 0; value[1][key].tabVal = '0'; } value[1].topConfig.val = '0'; const r = harness(value); try { const before = r.props.modelValue; assert.deepEqual([r.state.project.value.service, r.state.project.value.right, r.state.project.value.topPercent], [false, false, 30]); r.state.select(1); await tick(); assert.deepEqual([r.state.project.value.service, r.state.project.value.right, r.state.project.value.topPercent], [true, true, 0]); assert.equal(r.state.offset, 0); assert.deepEqual(all(r.tree, n => n.props.class === 'preview-button')[0].props.style, { top: '0%', left: 'auto', right: '10px' }); assert.equal(r.props.modelValue, before); assert.equal(r.emits.length, 0); } finally { r.unmount(); }
});

test('invalid typed inputs never patch JSON and imported invalid fields surface an explicit projection error', async () => {
  const r = harness(); try { const before = r.props.modelValue; for (const value of [false, '1', -1, 2, NaN]) { r.state.setMode(value); r.state.setSide(value); } for (const value of ['20', -1, 81, Infinity, NaN]) r.state.setOffset(value); r.state.setVisible('false'); r.state.setLink('x'.repeat(2049)); for (const value of ['javascript:alert(1)', '//foreign.test/a.png', '/static/a b.png', '/static/a\\b.png', 'https://test/' + 'x'.repeat(4096)]) assert.equal(r.state.setLogo(value), false); assert.equal(r.props.modelValue, before); const invalid = blocks(); invalid[0].topConfig.val = '01'; r.props.modelValue = JSON.stringify(invalid); await tick(); assert.ok(r.state.project.error); assert.equal(r.emits.length, 0); } finally { r.unmount(); }
});

test('adding defaults and removing the selected family item preserve every unrelated row', async () => {
  const other = [{ name: 'other', timestamp: 12, extension: ['keep'] }, { name: 'pageFoot', timestamp: 900, menuList: [] }], r = harness(other); try { await tick(); click(r, '添加页面悬浮按钮'); await tick(); const value = r.value(); assert.deepEqual(value.slice(0, 2), other); assert.deepEqual(value[2], r.load(path.resolve(root, '../../common/diyCustomerService.ts')).newDiyCustomerService(901)); assert.equal(r.state.selected, 2); click(r, '删除当前悬浮按钮'); await tick(); assert.deepEqual(r.value(), other); } finally { r.unmount(); }
});

test('within-family ordering crosses unknown gaps while preserving their positions and timestamps', async () => {
  const a = service(10), b = service(40), unknown = { name: 'extension', timestamp: 25, payload: [1, 2] }, footer = { name: 'pageFoot', timestamp: 100, menuList: [] }, r = harness([a, unknown, b, footer]); try { r.state.select(2); await tick(); click(r, '在本族中上移'); await tick(); const expectedA = clone(a), expectedB = clone(b); expectedA.timestamp = 40; expectedB.timestamp = 10; assert.deepEqual(r.value(), [expectedB, unknown, expectedA, footer]); assert.equal(r.state.selected, 0); r.state.remove(); await tick(); assert.deepEqual(r.value(), [unknown, expectedA, footer]); } finally { r.unmount(); }
});

test('imported tails beyond200 and primitive bystanders stay complete during an explicit field patch', async () => {
  const before = [...Array.from({ length: 205 }, (_, index) => ({ name: 'unknown', timestamp: index, extension: index })), null, 'raw', service(300)], r = harness(before); try { r.state.setOffset(11); await tick(); assert.equal(r.value().length, 208); assert.deepEqual(r.value().slice(0, 207), before.slice(0, 207)); assert.equal(r.value()[207].topConfig.val, 11); } finally { r.unmount(); }
});

test('malformed or over-budget documents reject atomically rather than clipping or rebuilding author content', async () => {
  const r = harness(); try { for (const raw of ['null', '{}', '[', JSON.stringify([{ name: 'other', text: '中'.repeat(666_667) }])]) { r.props.modelValue = raw; await tick(); assert.ok(r.state.parsed.error); const before = r.props.modelValue; r.state.add(); r.state.setOffset(4); assert.equal(r.props.modelValue, before); } const deep = {}; let cursor = deep; for (let index = 0; index < 65; index++) cursor = cursor.next = {}; r.props.modelValue = JSON.stringify([deep]); await tick(); assert.match(r.state.parsed.error, /64/); assert.equal(r.emits.length, 0); } finally { r.unmount(); }
});

test('stable URL edits canonicalize only local image tickets, never links or unrelated references', async () => {
  const r = harness(); try { const before = r.value(); assert.equal(r.state.setLogo(' ' + ticket(19) + ' '), true); await tick(); const expected = clone(before); expected[0].logoConfig.url = '/api/assets/19'; assert.deepEqual(r.value(), expected); assert.equal(r.state.preview, ''); r.state.setLogo('https://images.example.test/icon.png?version=1'); await tick(); assert.equal(r.state.preview, 'https://images.example.test/icon.png?version=1'); r.state.setLogo('/static/logo.png'); await tick(); assert.equal(r.state.preview, '/static/logo.png'); } finally { r.unmount(); }
});

test('real image picker sends exact image category/list filters and chooses canonical storage with a separate same-reference preview', async () => {
  const r = harness(blocks(), { categories: async () => ({ list: [{ id: 7, name: '页面图标' }] }), gallery: async () => ({ list: [image()], count: 1 }) }); try { await r.picker.open(); assert.equal(r.categoryCalls.length, 1); assert.deepEqual(r.galleryCalls[0].params, { page: 1, limit: 20, pid: 0, name: '', file_type: 1 }); r.picker.pid = 7; r.picker.name = ' 图标 '; await r.picker.load(2); assert.deepEqual(r.galleryCalls[1].params, { page: 2, limit: 20, pid: 7, name: '图标', file_type: 1 }); r.picker.choose({ ...image(), att_id: 99 }); assert.equal(r.emits.length, 0); r.picker.choose(image()); await tick(); assert.equal(r.value()[0].logoConfig.url, '/api/assets/18'); assert.equal(r.state.preview, ticket(18)); assert.equal(r.picker.visible, false); assert.equal(r.props.modelValue.includes('signature='), true); assert.equal(r.value()[0].logoConfig.url.includes('signature='), false); } finally { r.unmount(); }
});

test('existing image upload adapter receives actual file/folder/signal and rereads the real list without inventing an image selection', async () => {
  const r = harness(blocks(), { gallery: async () => ({ list: [image()], count: 1 }) }); try { await r.picker.open(); r.picker.pid = 7; const file = { type: 'image/png', size: 25, name: 'owned.png' }; await r.picker.upload({ file }); assert.equal(r.uploadCalls.length, 1); assert.equal(r.uploadCalls[0].file, file); assert.equal(r.uploadCalls[0].pid, 7); assert.equal(r.uploadCalls[0].signal.aborted, false); assert.equal(r.galleryCalls.length, 2); assert.equal(r.emits.length, 0); assert.ok(r.notices.some(([kind]) => kind === 'success')); } finally { r.unmount(); }
});

test('page edit permission, image view permission and upload permission remain separate actual picker gates', async () => {
  const actor = vue.reactive({ token: 'A', userInfo: { id: 11, level: 1 }, uniqueAuth: ['dise.manage'] }), r = harness(blocks(), { actor }); try { assert.equal(r.state.canEdit, true); assert.equal(r.state.canChooseMedia, false); await r.picker.open(); assert.equal(r.galleryCalls.length, 0); r.state.mediaSession.choose('/api/assets/19', ticket(19)); assert.equal(r.emits.length, 0); actor.uniqueAuth.push('attachment.view'); await tick(); assert.equal(r.picker.canChoose, true); assert.equal(r.picker.canUpload, false); await r.picker.open(); assert.equal(r.galleryCalls.length, 1); await r.picker.upload({ file: { type: 'image/png', size: 4 } }); assert.equal(r.uploadCalls.length, 0); actor.uniqueAuth = ['dise.view']; await tick(); const before = r.props.modelValue; r.state.setOffset(5); r.state.add(); assert.equal(r.props.modelValue, before); assert.equal(r.state.canEdit, false); } finally { r.unmount(); }
});

test('mismatched, expired and malformed tickets never become the preview for another canonical image', async () => {
  const r = harness(); try { for (const signed of [ticket(99), ticket(18, 1), ticket(18) + '&expires=9999999999', 'https://foreign.test' + ticket(18), '/api/assets/18']) { r.state.mediaSession.choose('/api/assets/18', signed); await tick(); assert.equal(r.state.preview, ''); assert.deepEqual(r.state.previews, {}); } r.state.mediaSession.choose('/api/assets/18', ticket(18)); await tick(); assert.equal(r.state.preview, ticket(18)); assert.equal(r.value()[0].logoConfig.url, '/api/assets/18'); } finally { r.unmount(); }
});

for (const boundary of ['selection', 'editor', 'session', 'disabled', 'close']) test(`old real media choice cannot cross ${boundary}`, async () => {
  const r = harness([service(), service(20)]); try { const old = r.state.mediaSession, before = r.props.modelValue; if (boundary === 'selection') r.state.select(1); if (boundary === 'editor') r.props.editorKey = 'B:replacement'; if (boundary === 'session') { r.storage.set('admin_session', 'B'); r.window.dispatchEvent(new Event('admin-session-changed')); } if (boundary === 'disabled') r.props.disabled = true; if (boundary === 'close') r.unmount(); await tick(); old.choose('/api/assets/99', ticket(99)); assert.equal(r.props.modelValue, before); assert.equal(r.emits.length, 0); assert.deepEqual(r.state.previews, {}); } finally { r.unmount(); }
});

for (const boundary of ['session', 'disabled', 'close']) test(`delayed actual gallery result cannot cross ${boundary}`, async () => {
  const gate = deferred(), r = harness(blocks(), { gallery: () => gate.promise }); try { const picker = r.picker, pending = picker.open(); await tick(); assert.equal(r.galleryCalls.length, 1); if (boundary === 'session') { r.storage.set('admin_session', 'B'); r.window.dispatchEvent(new Event('admin-session-changed')); } if (boundary === 'disabled') r.props.disabled = true; if (boundary === 'close') r.unmount(); await tick(); assert.equal(r.galleryCalls[0].signal.aborted, true); gate.resolve({ list: [image()], count: 1 }); await pending; assert.deepEqual(picker.items, []); assert.equal(picker.visible, false); assert.equal(r.emits.length, 0); } finally { gate.resolve({ list: [], count: 0 }); r.unmount(); }
});

test('published public preview uses only exact unauthenticated no-store GET and never rewrites canonical author JSON', async () => {
  const r = harness(), original = global.fetch, calls = []; try { const before = r.props.modelValue, published = clone(r.value()[0]); published.logoConfig.url = ticket(18); published.routine_contact_type = 1; global.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ status: 200, data: { value: [published] } }) }; }; await r.state.loadPreview(); await tick(); assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/diy/get_diy/2'); assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.cache, 'no-store'); assert.equal(calls[0].options.headers, undefined); assert.equal(r.state.preview, ticket(18)); assert.equal(r.state.error, ''); assert.equal(r.props.modelValue, before); assert.equal(r.emits.length, 0); const img = all(r.tree, n => n.tag === 'img')[0]; assert.equal(img.props.src, ticket(18)); } finally { global.fetch = original; r.unmount(); }
});

test('unpublished, closed, mismatching, denied and bad-ticket responses cannot grant edit rights or a public preview', async () => {
  const original = global.fetch; try { for (const mode of ['unpublished', 'closed', 'changed', 'denied', 'expired', 'network']) { const r = harness(), before = r.props.modelValue; try { let calls = 0; const published = clone(r.value()[0]); published.logoConfig.url = mode === 'expired' ? ticket(18, 1) : ticket(18); if (mode === 'changed') published.logoConfig.link = '/pages/other'; if (mode === 'unpublished') r.props.pagePublished = false; if (mode === 'denied') r.actor.uniqueAuth = [], r.actor.userInfo.level = 1; await tick(); global.fetch = async () => { calls++; if (mode === 'network') throw Error('offline'); return { ok: true, json: async () => mode === 'closed' ? { status: 410010 } : { status: 200, data: { value: [published] } } }; }; await r.state.loadPreview(); assert.equal(calls, ['unpublished', 'denied'].includes(mode) ? 0 : 1, mode); assert.equal(r.state.preview, '', mode); assert.deepEqual(r.state.previews, {}); assert.equal(r.props.modelValue, before); assert.equal(r.emits.length, 0); if (!['unpublished', 'denied'].includes(mode)) assert.ok(r.state.error, mode); } finally { r.unmount(); } } } finally { global.fetch = original; }
});

for (const boundary of ['selection', 'json', 'editor', 'session', 'disabled', 'close']) test(`late published public preview cannot cross ${boundary}`, async () => {
  const gate = deferred(), r = harness([service(), service(20)]), original = global.fetch; try { let signal; const published = clone(r.value()[0]); published.logoConfig.url = ticket(18); global.fetch = async (_url, options) => { signal = options.signal; return gate.promise; }; const pending = r.state.loadPreview(); await tick(); if (boundary === 'selection') r.state.select(1); if (boundary === 'json') r.props.modelValue = JSON.stringify([service(30)]); if (boundary === 'editor') r.props.editorKey = 'B'; if (boundary === 'session') { r.storage.set('admin_session', 'B'); r.window.dispatchEvent(new Event('admin-session-changed')); } if (boundary === 'disabled') r.props.disabled = true; if (boundary === 'close') r.unmount(); await tick(); assert.equal(signal.aborted, true); gate.resolve({ ok: true, json: async () => ({ status: 200, data: { value: [published] } }) }); await pending; assert.deepEqual(r.state.previews, {}); assert.equal(r.state.preview, ''); assert.equal(r.state.previewLoading, false); assert.equal(r.emits.length, 0); } finally { gate.resolve({ ok: false, json: async () => ({}) }); global.fetch = original; r.unmount(); }
});

test('actual DiseList save canonicalizes only customer logo and retains link, unknown blocks, independent content and immutable metadata', async () => {
  const writes = [], l = loader({ gateway: { get: async () => ({ data: [] }), post: async (url, body) => { writes.push({ url, body: clone(body) }); return { data: { id: 2, version: 'saved' } }; } } }), props = vue.reactive({}), m = mount(l, pageFile, props), value = blocks(); value[0].logoConfig.url = ticket(18); value[0].logoConfig.link = ticket(99); const content = '{"independent":"' + ticket(77) + '"}'; try { m.state.openForm({ id: 2, name: '作者页面', title: '客服页', value: JSON.stringify(value), content, status: 1, type: 1, template_name: 'default', is_diy: 1, is_show: 1, version: 'old', add_time: 100, update_time: 200 }); await tick(); const nested = l.instances.get(editorFile).at(-1); nested.setOffset(38); await tick(); await m.state.save(); assert.equal(writes.length, 1); assert.equal(writes[0].url, '/dise/save'); assert.deepEqual(Object.keys(writes[0].body).sort(), ['content', 'id', 'name', 'status', 'title', 'value']); const expected = clone(value); expected[0].logoConfig.url = '/api/assets/18'; expected[0].topConfig.val = 38; assert.deepEqual(JSON.parse(writes[0].body.value), expected); assert.equal(writes[0].body.content, content); assert.equal(m.state.form.type, 1); assert.equal(m.state.form.templateName, 'default'); assert.equal(m.state.form.isDiy, 1); assert.ok(l.notices.some(([kind]) => kind === 'success')); } finally { m.unmount(); }
});

test('canonical save helper leaves foreign media, neighbour tickets and independent arbitrary JSON fields intact', () => {
  const l = loader(), helper = l.load(utilFile), value = blocks(); value[0].logoConfig.url = ticket(18); value[0].logoConfig.link = ticket(99); value.push({ name: 'customerService', logoConfig: { url: 'https://foreign.test' + ticket(18), link: ticket(88) } }); const expected = clone(value); expected[0].logoConfig.url = '/api/assets/18'; assert.deepEqual(JSON.parse(helper.canonicalCustomerServiceValue(JSON.stringify(value))), expected); assert.throws(() => helper.canonicalCustomerServiceValue('null')); assert.throws(() => helper.customerServiceDocument('{}')); });
