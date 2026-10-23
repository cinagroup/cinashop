const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vue = require('vue');
const sfc = require('@vue/compiler-sfc');
const dom = require('@vue/compiler-dom');

const root = path.resolve(__dirname, '../src');
const editorFile = path.join(root, 'components/content/DiyPageSettingsEditor.vue');
const pickerFile = path.join(root, 'pages/activity/SeckillActivityImagePicker.vue');
const pageFile = path.join(root, 'pages/content/DiseList.vue');
const utilFile = path.join(root, 'utils/diyPageSettingsEditor.ts');
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
const elementNames = ['el-alert', 'el-button', 'el-select', 'el-option', 'el-form', 'el-form-item', 'el-input', 'el-input-number', 'el-dialog', 'el-pagination', 'el-image', 'el-upload', 'el-table', 'el-table-column', 'el-tag', 'el-switch', 'el-descriptions', 'el-descriptions-item', 'el-divider', 'el-card', 'el-tooltip', 'el-color-picker'];
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
    if (file.endsWith('.vue')) { descriptor = sfc.parse(source, { filename: file }).descriptor; script = sfc.compileScript(descriptor, { id: 'page-settings-editor-runtime' }); source = script.content; }
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
      if (name === '@/components/content/DiyCustomerServiceEditor.vue') return { __esModule: true, default: vue.defineComponent({ setup: () => () => null }) };
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
const helper = () => loader().load(utilFile);
function settings(extra = {}) { return {is_show: 1, is_bg_color: 1, color_picker: '#123456', is_bg_pic: 1, bg_pic: '/api/assets/18', bg_tab_val: 0, ...extra}; }
function harness(extra = {}, options = {}) {
  const l = loader(options), props = vue.reactive({modelValue: settings(extra), editorKey: 'A:row2', contextValue: '[{"name":"unknown","preserve":true}]', pageTitle: '原页面标题', pageId: 2, pagePublished: true, disabled: false, ...options.props}), emits = [];
  const m = mount(l, editorFile, props, (event, value) => {emits.push({event, value: clone(value)}); props.modelValue = value;});
  return {...l, ...m, get state() { return m.state; }, get picker() { return m.picker; }, props, emits};
}
function control(r, label, type = 'el-switch') { const field = all(r.tree, node => node.props['data-element'] === 'el-form-item' && node.props['data-label'] === label)[0]; assert.ok(field, label); const input = all(field, node => node.props['data-element'] === type)[0]; assert.ok(input, type); return value => input.props['onUpdate:modelValue'](value); }
const image = (id = 18) => ({att_id: id, canonical_url: `/api/assets/${id}`, att_dir: ticket(id), satt_dir: ticket(id), real_name: `背景${id}`, file_type: 1});

test('actual page settings template mounts all typed controls and leaves raw author values untouched', async () => {
  const r = harness(); try { await tick(); assert.match(text(r.tree), /页面状态与首页启用分别设置/); for (const label of ['页面显示', '使用背景色', '使用背景图']) assert.equal(typeof control(r, label), 'function'); assert.equal(typeof control(r, '背景图模式', 'el-select'), 'function'); assert.equal(r.state.previewStyle.backgroundColor, '#123456'); assert.equal(r.state.previewStyle.backgroundImage, undefined); assert.equal(r.emits.length, 0); } finally { r.unmount(); }
  for (const file of [editorFile, pageFile]) { const descriptor = sfc.parse(fs.readFileSync(file, 'utf8'), {filename: file}).descriptor, script = sfc.compileScript(descriptor, {id: 'page-settings-template'}); assert.deepEqual(sfc.compileTemplate({source: descriptor.template.content, filename: file, id: 'page-settings-template', compilerOptions: {bindingMetadata: script.bindings}}).errors, []); }
});
test('actual independent flag controls retain image, colour and mode when turned off and on', async () => {
  const r = harness({bg_pic: '/static/background.png'}); try { control(r, '使用背景色')(0); await tick(); control(r, '使用背景图')(0); await tick(); assert.deepEqual(r.state.previewStyle, {}); assert.equal(r.props.modelValue.bg_pic, '/static/background.png'); assert.equal(r.props.modelValue.color_picker, '#123456'); control(r, '使用背景色')(1); await tick(); control(r, '使用背景图')(1); await tick(); assert.equal(r.state.previewStyle.backgroundColor, '#123456'); assert.equal(r.state.previewStyle.backgroundImage, 'url("/static/background.png")'); control(r, '页面显示')(0); await tick(); assert.deepEqual(r.state.previewStyle, {}); } finally { r.unmount(); }
});
for (const [mode, size, repeat] of [[0, '100%', 'no-repeat'], [1, '100%', 'repeat'], [2, '100% 100%', 'no-repeat']]) test(`actual background mode control ${mode} projects the PHP preview`, async () => {
  const r = harness({bg_pic: '/static/landscape.png'}); try { control(r, '背景图模式', 'el-select')(mode); await tick(); assert.equal(r.state.previewStyle.backgroundSize, size); assert.equal(r.state.previewStyle.backgroundRepeat, repeat); assert.equal(r.props.modelValue.bg_tab_val, mode); } finally { r.unmount(); }
});
test('primitive setters reject invalid flags/modes and new-page publishing without losing imports', async () => {
  const r = harness(), before = clone(r.props.modelValue); try { for (const value of [false, '1', {}, [], NaN, -1, 3]) { r.state.setFlag('is_show', value); r.state.setFlag('is_bg_pic', value); r.state.setMode(value); } assert.deepEqual(r.props.modelValue, before); r.props.pageId = 0; await tick(); r.state.setFlag('is_show', 1); assert.equal(r.emits.length, 0); } finally { r.unmount(); }
});
test('metadata patch sends only explicit edits and canonicalizes a copied local ticket before the storage bound', () => {
  const h = helper(), original = settings(), current = {...original, bg_pic: ticket(19) + '&padding=' + 'x'.repeat(300), bg_tab_val: 2}; assert.deepEqual(h.pageSettingsPatch(original, current), {bg_pic: '/api/assets/19', bg_tab_val: 2}); assert.deepEqual(h.pageSettingsPatch(original, {...original}), {}); assert.deepEqual(h.pageSettingsPatch(null, h.newDiyPageSettings()), h.newDiyPageSettings()); assert.equal(current.bg_pic.includes('signature='), true);
  for (const value of ['javascript:bad', '//foreign.test/pic', '/static/a b.png', '/static/a\\b.png', 'https://foreign.test/' + 'x'.repeat(256)]) assert.throws(() => h.pageSettingsReference(value)); assert.equal(h.pageSettingsReference('https://foreign.test' + ticket(19)), 'https://foreign.test' + ticket(19));
});
test('invalid partial colour is editable for normal typing but cannot be submitted or painted', async () => {
  const r = harness(), h = helper(); try { control(r, '页面背景色', 'el-input')('#1'); await tick(); assert.equal(r.props.modelValue.color_picker, '#1'); assert.equal(r.state.previewStyle.backgroundColor, undefined); assert.throws(() => h.pageSettingsPatch(settings(), r.props.modelValue)); control(r, '页面背景色', 'el-input')('#112233'); await tick(); assert.equal(r.state.previewStyle.backgroundColor, '#112233'); assert.deepEqual(h.pageSettingsPatch(settings(), r.props.modelValue), {color_picker: '#112233'}); } finally { r.unmount(); }
});
test('actual gallery selection stores a stable background and admits its same-reference preview after parent v-model updates', async () => {
  const r = harness({}, {categories: async () => ({list: [{id: 3, name: '背景'}]}), gallery: async () => ({list: [image()], count: 1})}); try { await r.picker.open(); assert.deepEqual(r.galleryCalls[0].params, {page: 1, limit: 20, pid: 0, name: '', file_type: 1}); r.picker.choose(image()); await tick(); assert.equal(r.props.modelValue.bg_pic, '/api/assets/18'); assert.equal(r.state.preview, ticket(18)); assert.equal(r.state.previewStyle.backgroundImage, `url("${ticket(18)}")`); assert.equal(r.picker.visible, false); assert.equal(r.props.contextValue, '[{"name":"unknown","preserve":true}]'); } finally { r.unmount(); }
});
test('actual gallery upload remains a separate existing permission and does not select the uploaded file implicitly', async () => {
  const actor = vue.reactive({token: 'A', userInfo: {id: 11, level: 1}, uniqueAuth: ['dise.manage', 'attachment.view']}), r = harness({}, {actor, gallery: async () => ({list: [image()], count: 1})}); try { await r.picker.open(); assert.equal(r.picker.canUpload, false); await r.picker.upload({file: {type: 'image/png', size: 12}}); assert.equal(r.uploadCalls.length, 0); actor.uniqueAuth.push('attachment.manage'); await tick(); await r.picker.open(); const file = {type: 'image/png', size: 12}; await r.picker.upload({file}); assert.equal(r.uploadCalls[0].file, file); assert.equal(r.uploadCalls[0].signal.aborted, false); assert.equal(r.emits.length, 0); } finally { r.unmount(); }
});
for (const boundary of ['context', 'editor', 'page', 'title', 'disabled', 'session', 'close']) test(`old actual background gallery callback cannot cross ${boundary}`, async () => {
  const r = harness(), old = r.state.mediaSession, before = clone(r.props.modelValue); try { if (boundary === 'context') r.props.contextValue = '[]'; if (boundary === 'editor') r.props.editorKey = 'B'; if (boundary === 'page') r.props.pageId = 3; if (boundary === 'title') r.props.pageTitle = '新标题'; if (boundary === 'disabled') r.props.disabled = true; if (boundary === 'session') {r.storage.set('admin_session', 'B'); r.window.dispatchEvent(new Event('admin-session-changed'));} if (boundary === 'close') r.unmount(); await tick(); await old.choose('/api/assets/19', ticket(19)); assert.deepEqual(r.props.modelValue, before); assert.equal(r.emits.length, 0); assert.equal(r.state.preview, ''); } finally { r.unmount(); }
});
test('published background preview is a no-store anonymous GET matching all six row fields and cannot rewrite author data', async () => {
  const r = harness(), old = global.fetch, calls = [], before = clone(r.props.modelValue); try { global.fetch = async (url, options) => {calls.push({url, options}); return {ok: true, json: async () => ({status: 200, data: {...settings(), bg_pic: ticket(18)}})};}; await r.state.loadPreview(); assert.equal(calls[0].url, '/api/diy/get_diy/2'); assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.cache, 'no-store'); assert.equal(calls[0].options.headers, undefined); assert.equal(r.state.preview, ticket(18)); assert.deepEqual(r.props.modelValue, before); assert.equal(r.emits.length, 0); } finally { global.fetch = old; r.unmount(); }
});
for (const boundary of ['context', 'editor', 'page', 'disabled', 'session', 'close']) test(`late public background capability cannot cross ${boundary}`, async () => {
  const r = harness(), old = global.fetch, wait = deferred(); let signal; try { global.fetch = async (_url, options) => {signal = options.signal; return wait.promise;}; const pending = r.state.loadPreview(); await tick(); if (boundary === 'context') r.props.contextValue = '[]'; if (boundary === 'editor') r.props.editorKey = 'B'; if (boundary === 'page') r.props.pageId = 3; if (boundary === 'disabled') r.props.disabled = true; if (boundary === 'session') {r.storage.set('admin_session', 'B'); r.window.dispatchEvent(new Event('admin-session-changed'));} if (boundary === 'close') r.unmount(); await tick(); assert.equal(signal.aborted, true); wait.resolve({ok: true, json: async () => ({status: 200, data: {...settings(), bg_pic: ticket(18)}})}); await pending; assert.equal(r.state.preview, ''); assert.equal(r.state.previewLoading, false); assert.equal(r.emits.length, 0); } finally {wait.resolve({ok: false, json: async () => ({})}); global.fetch = old; r.unmount();}
});
test('closed, unpublished, mismatched and wrong-asset public responses never grant a preview or author mutation', async () => {
  const old = global.fetch; try { for (const kind of ['closed', 'unpublished', 'mismatch', 'wrong-asset', 'unsigned']) { const r = harness(); try { if (kind === 'unpublished') {r.props.pagePublished = false; await tick();} let calls = 0; global.fetch = async () => {calls++; return {ok: true, json: async () => ({status: kind === 'closed' ? 410010 : 200, data: {...settings(), bg_pic: kind === 'wrong-asset' ? ticket(19) : kind === 'unsigned' ? '/api/assets/18' : ticket(18), bg_tab_val: kind === 'mismatch' ? 2 : 0}})};}; await r.state.loadPreview(); assert.equal(calls, kind === 'unpublished' ? 0 : 1); assert.equal(r.state.preview, ''); assert.equal(r.emits.length, 0); } finally {r.unmount();} } } finally {global.fetch = old;}
});
function row(extra = {}) { return {id: 2, name: '作者页', title: '原标题', value: '[ {"name":"extension", "timestamp":"0009", "url":"/api/assets/99?keep=1"} ]', content: 'independent raw content', status: 1, type: 1, template_name: 'default', is_diy: 1, version: 'old', ...settings(), ...extra}; }
function pageHarness() { const writes = [], l = loader({gateway: {get: async () => ({data: []}), post: async (url, body) => {writes.push({url, body: clone(body)}); return {data: {id: 2, version: 'new'}};}}}), m = mount(l, pageFile, vue.reactive({})); return {...l, ...m, get state() {return m.state;}, writes}; }
test('actual DiseList appearance-only save submits exact changed metadata while preserving long imported title/value/content byte contracts', async () => {
  const r = pageHarness(), source = row({title: ' 导入长标题'.repeat(14) + ' '}); try { r.state.openForm(source); await tick(); const editor = r.instances.get(editorFile).at(-1); editor.setMode(2); await tick(); editor.setImage(ticket(19)); await tick(); await r.state.save(); assert.equal(r.writes.length, 1); assert.deepEqual(r.writes[0], {url: '/dise/save', body: {id: 2, bg_pic: '/api/assets/19', bg_tab_val: 2}}); assert.equal(r.state.form.title, source.title); assert.equal(r.state.form.content, source.content); assert.deepEqual(JSON.parse(r.state.form.value), JSON.parse(source.value)); assert.equal(r.state.importedTitleLength, source.title.length); } finally {r.unmount();}
});
test('actual DiseList combines a changed component document with independently changed row settings without immutable fields', async () => {
  const r = pageHarness(), source = row(); try {r.state.openForm(source); await tick(); r.instances.get(editorFile).at(-1).setFlag('is_bg_pic', 0); await tick(); r.state.form.value = '[{"name":"extension","changed":true}]'; await r.state.save(); const body = r.writes[0].body; assert.equal(body.is_bg_pic, 0); assert.deepEqual(JSON.parse(body.value), [{name: 'extension', changed: true}]); assert.equal(body.content, source.content); for (const key of ['type', 'template_name', 'is_diy', 'bg_pic', 'is_show']) assert.equal(Object.hasOwn(body, key), false); } finally {r.unmount();}
});
test('actual new page retains safe create defaults and sends valid row settings without an activation shortcut', async () => {
  const r = pageHarness(); try {r.state.openForm(); await tick(); r.state.form.name = '新页面'; const editor = r.instances.get(editorFile).at(-1); editor.setFlag('is_show', 1); await tick(); await r.state.save(); const body = r.writes[0].body; assert.equal(body.create_kind, 'diy_page'); assert.equal(body.status, 0); assert.equal(body.is_show, 0); assert.equal(body.bg_pic, ''); assert.equal(body.bg_tab_val, 0); assert.equal(body.color_picker, '#f5f5f5'); for (const key of ['type', 'is_diy', 'template_name']) assert.equal(Object.hasOwn(body, key), false); } finally {r.unmount();}
});
test('new metadata validator matches finite picker colours, exact local IDs and Unicode column character bounds', () => {
  const h = helper(); for (const color of ['rgba(1,2,3,2)', 'rgb(256,0,0)', 'hsl(10,101%,40%)', 'rgb(10%,2,3)', '#abcde']) {assert.equal(h.pageSettingsColor(color), ''); assert.throws(() => h.pageSettingsPatch(settings(), settings({color_picker: color})));}
  for (const color of ['rgba(1,2,3,.5)', 'hsl(-20,50%,40%)', '#abcd', '#aabbccdd']) assert.equal(h.pageSettingsColor(color), color);
  for (const reference of ['/api/assets/0', '/api/assets/7suffix', 'https://user:pass@images.test/a.png', '/static/a".png', '/api/assets/%37']) assert.throws(() => h.pageSettingsReference(reference));
  const exact = '/static/' + '😀'.repeat(248); assert.equal([...exact].length, 256); assert.equal(h.pageSettingsReference(exact), exact); assert.throws(() => h.pageSettingsReference(exact + '图'));
});
for (const background of [false, true]) test(`actual title ${background ? 'and background' : 'only'} edit submits metadata without rewriting untouched value/content/status`, async () => {
  const r = pageHarness(), source = row(); try {r.state.openForm(source); await tick(); r.state.form.title = '实际新标题'; if (background) {r.instances.get(editorFile).at(-1).setMode(2); await tick();} await r.state.save(); assert.deepEqual(r.writes[0].body, {id: 2, title: '实际新标题', ...(background ? {bg_tab_val: 2} : {})}); assert.equal(r.state.form.content, source.content); assert.deepEqual(JSON.parse(r.state.form.value), JSON.parse(source.value));} finally {r.unmount();}
});
test('an explicit public refusal revokes an earlier gallery background capability without changing the canonical form', async () => {
  const original = global.fetch; try { for (const kind of ['closed', 'owner-revoked', 'expired']) {const r = harness(); try {await r.state.mediaSession.choose('/api/assets/18', ticket(18)); await tick(); assert.ok(r.state.previewStyle.backgroundImage); const before = clone(r.props.modelValue); global.fetch = async () => ({ok: true, json: async () => kind === 'closed' ? {status: 410010} : {status: 200, data: {...settings(), bg_pic: kind === 'expired' ? ticket(18, 1) : ''}}}); await r.state.loadPreview(); assert.equal(r.state.preview, ''); assert.equal(r.state.previewStyle.backgroundImage, undefined); assert.deepEqual(r.props.modelValue, before); assert.ok(r.state.error);} finally {r.unmount();}} } finally {global.fetch = original;}
});
test('an imported signed managed URL cannot bypass an explicit gallery or successful public preview admission', async () => {
  const r = harness({bg_pic: ticket(18)}), original = global.fetch; try {assert.equal(r.state.previewStyle.backgroundImage, undefined); global.fetch = async () => ({ok: true, json: async () => ({status: 200, data: {...settings(), bg_pic: ticket(18)}})}); await r.state.loadPreview(); assert.equal(r.state.previewStyle.backgroundImage, `url("${ticket(18)}")`); assert.equal(r.props.modelValue.bg_pic, ticket(18));} finally {global.fetch = original; r.unmount();}
});
test('starting a new public preview withdraws its earlier capability throughout the pending read', async () => {
  const r = harness(), original = global.fetch, wait = deferred(); try {await r.state.mediaSession.choose('/api/assets/18', ticket(18)); await tick(); assert.ok(r.state.previewStyle.backgroundImage); global.fetch = async () => wait.promise; const pending = r.state.loadPreview(); assert.equal(r.state.previewStyle.backgroundImage, undefined); wait.resolve({ok: true, json: async () => ({status: 200, data: {...settings(), bg_pic: ticket(18)}})}); await pending; assert.equal(r.state.previewStyle.backgroundImage, `url("${ticket(18)}")`);} finally {wait.resolve({ok: false, json: async () => ({})}); global.fetch = original; r.unmount();}
});
