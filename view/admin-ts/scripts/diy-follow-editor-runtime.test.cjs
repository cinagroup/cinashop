const base = require('./helpers/diy-list-runtime.cjs');
const { test, assert, path, root, vue, loader, mount, tick, clone, deferred, ticket, all, text } = base;
const editor = path.join(root, 'components/content/DiyFollowEditor.vue');
const preview = path.join(root, 'components/content/DiyFollowPreview.vue');
const util = path.join(root, 'utils/diyFollowEditor.ts');
const projection = path.join(root, 'utils/diyFollowProjection.ts');
function block(timestamp = 10) { return { ...loader().load(util).newFollowBlock(timestamp), extra: { zero: 0, empty: [] } }; }
function harness(value = [block()], options = {}) {
  const l = loader(options), props = vue.reactive({ modelValue: JSON.stringify(value), editorKey: 'follow:2', disabled: false, pageId: 2, pagePublished: true, ...options.props }), writes = [];
  const m = mount(l, editor, props, (_event, value) => { writes.push(value); props.modelValue = value; });
  return { ...l, ...m, props, writes, value: () => JSON.parse(props.modelValue) };
}
function control(r, label) {
  const field = all(r.tree, n => n.props['data-element'] === 'el-form-item' && n.props['data-label'] === label)[0];
  assert.ok(field, label);
  const found = all(field, n => ['el-select', 'el-input', 'el-input-number', 'el-color-picker', 'el-switch'].includes(n.props['data-element']) && typeof n.props['onUpdate:modelValue'] === 'function')[0]; assert.ok(found, label); return found;
}
async function update(r, label, value) { control(r, label).props['onUpdate:modelValue'](value); await tick(); }
test('real compiled editor fields change only explicit leaves and retain imported metadata and neighbors', async () => {
  const source = [block(), { name: 'unknown', signature: ticket(99), list: [0, false] }]; source[0].titleConfig.value = '导入的完整长标题超过十字仍然保留'; source[0].prConfig.val = '125';
  const r = harness(source);
  try {
    assert.deepEqual(r.value(), source); assert.equal(r.writes.length, 0);
    await update(r, '关注按钮颜色', '#123456'); await update(r, '关注背景结束色', '#abcdef');
    await update(r, '旧版展示位置', 1); await update(r, '关注背景圆角方式', 1); await update(r, '关注背景左下圆角', 7);
    await update(r, '页面上间距（设计 px）', 9);
    const saved = r.value()[0]; assert.equal(saved.titleConfig.value, source[0].titleConfig.value); assert.equal(saved.prConfig.val, '125');
    assert.equal(saved.themeColor.color[0].item, '#123456'); assert.equal(saved.bgColor.color[1].item, '#abcdef'); assert.equal(saved.positionConfig.tabVal, 1);
    assert.equal(saved.fillet.valList[3].val, 7); assert.equal(saved.mbConfig.val, 9); assert.deepEqual(r.value()[1], source[1]); assert.deepEqual(saved.extra, source[0].extra);
  } finally { r.unmount(); }
});
test('zero and numeric-string imports do not write on unchanged control events; out-of-range edits remain explicit', async () => {
  const source = block(); source.mbConfig.val = '0'; source.fillet.val = '0'; source.positionConfig.tabVal = '0'; const r = harness([source]);
  try {
    await update(r, '页面上间距（设计 px）', 0); await update(r, '关注背景圆角', 0); await update(r, '旧版展示位置', 0);
    for (const bad of [undefined, null, '5', NaN, Infinity, -1, 101]) r.state.setLength('mbConfig', bad);
    assert.equal(r.writes.length, 0); assert.deepEqual(r.value(), [source]);
    await update(r, '关注组件显示', false); assert.equal(r.value()[0].isHide, true); assert.match(text(r.tree), /此组件已隐藏/);
  } finally { r.unmount(); }
});
test('real image picker callbacks bind exact media identity and store stable references for both independent slots', async () => {
  const r = harness(); try {
    await r.state.mediaSessions.imgConfig.choose('/api/assets/17', ticket(18)); assert.equal(r.writes.length, 0);
    await r.state.mediaSessions.imgConfig.choose('/api/assets/17', ticket(17)); await tick();
    assert.equal(r.value()[0].imgConfig.url, '/api/assets/17'); assert.equal(r.state.previews['/api/assets/17'], ticket(17));
    await r.state.mediaSessions.codeConfig.choose('/api/assets/18', ticket(18)); await tick();
    assert.equal(r.value()[0].codeConfig.url, '/api/assets/18'); assert.ok(!r.props.modelValue.includes('signature='));
    assert.equal(r.instances.get(preview).at(-1).config.image, ticket(17));
    assert.equal(r.instances.get(preview).at(-1).config.code, ticket(18));
    r.state.clearImage('codeConfig'); await tick(); assert.equal(r.value()[0].codeConfig.url, ''); assert.equal(r.value()[0].imgConfig.url, '/api/assets/17');
  } finally { r.unmount(); }
});
test('real parent v-model render applies its queued props update before a newly chosen media preview is admitted', async () => {
  const l = loader(), value = vue.ref(JSON.stringify([block()])), tree = base.node('root'), component = l.load(editor).default;
  const app = base.renderer.createApp({ setup: () => () => vue.h(component, { modelValue: value.value, editorKey: 'queued-parent', pageId: 2, pagePublished: true, 'onUpdate:modelValue': next => { value.value = next; } }) });
  for (const name of base.elementNames) app.component(name, base.elementStub(name)); app.directive('loading', {}); app.mount(tree);
  try { const state = l.instances.get(editor).at(-1); await state.mediaSessions.imgConfig.choose('/api/assets/17', ticket(17)); await tick(); assert.equal(JSON.parse(value.value)[0].imgConfig.url, '/api/assets/17'); assert.equal(state.previews['/api/assets/17'], ticket(17)); }
  finally { app.unmount(); }
});
test('real queued parent keeps both exact media capabilities and rejects callbacks from the earlier document', async () => {
  const l = loader(), value = vue.ref(JSON.stringify([block()])), tree = base.node('root'), component = l.load(editor).default, writes = [];
  const app = base.renderer.createApp({ setup: () => () => vue.h(component, { modelValue: value.value, editorKey: 'queued-dual-parent', pageId: 2, pagePublished: true, 'onUpdate:modelValue': next => { writes.push(next); value.value = next; } }) });
  for (const name of base.elementNames) app.component(name, base.elementStub(name)); app.directive('loading', {}); app.mount(tree);
  try {
    const state = l.instances.get(editor).at(-1), oldCode = state.mediaSessions.codeConfig;
    await state.mediaSessions.imgConfig.choose('/api/assets/17', ticket(17)); await tick();
    await oldCode.choose('/api/assets/99', ticket(99)); await tick();
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(value.value)[0].codeConfig.url, '');
    await state.mediaSessions.codeConfig.choose('/api/assets/18', ticket(18)); await tick();
    assert.equal(writes.length, 2);
    const saved = JSON.parse(value.value)[0], displayed = l.instances.get(preview).at(-1).config;
    assert.equal(saved.imgConfig.url, '/api/assets/17'); assert.equal(saved.codeConfig.url, '/api/assets/18');
    assert.equal(displayed.image, ticket(17)); assert.equal(displayed.code, ticket(18));
    assert.deepEqual(state.previews, { '/api/assets/17': ticket(17), '/api/assets/18': ticket(18) });
    assert.ok(!value.value.includes('signature='));
    const staleImage = state.mediaSessions.imgConfig, replaced = clone(saved); replaced.imgConfig.url = '/api/assets/19'; value.value = JSON.stringify([replaced]); await tick();
    await staleImage.choose('/api/assets/20', ticket(20)); await tick();
    assert.equal(writes.length, 2); assert.equal(JSON.parse(value.value)[0].imgConfig.url, '/api/assets/19'); assert.deepEqual(state.previews, {});
  } finally { app.unmount(); }
});
for (const event of ['admin-session-changed', 'admin-auth-expired', 'storage']) test(`media receipt waiting on real parent propagation cannot restore capability after ${event}`, async () => {
  const l = loader(), value = vue.ref(JSON.stringify([block()])), tree = base.node('root'), component = l.load(editor).default;
  const app = base.renderer.createApp({ setup: () => () => vue.h(component, { modelValue: value.value, editorKey: 'queued-receipt-parent', pageId: 2, pagePublished: true, 'onUpdate:modelValue': next => { value.value = next; } }) });
  for (const name of base.elementNames) app.component(name, base.elementStub(name)); app.directive('loading', {}); app.mount(tree);
  try {
    const state = l.instances.get(editor).at(-1), task = state.mediaSessions.imgConfig.choose('/api/assets/17', ticket(17));
    assert.equal(JSON.parse(value.value)[0].imgConfig.url, '/api/assets/17');
    l.window.dispatchEvent(new Event(event));
    await task; await tick();
    assert.deepEqual(state.previews, {});
    assert.equal(l.instances.get(preview).at(-1).config.image, '');
    assert.ok(!value.value.includes('signature='));
  } finally { app.unmount(); }
});
for (const boundary of ['component', 'json', 'editor', 'disabled', 'session', 'unmount']) test(`old media choice cannot cross ${boundary}`, async () => {
  const r = harness([block(), block(20)]), old = r.state.mediaSessions.imgConfig;
  try {
    if (boundary === 'component') r.state.select(1);
    if (boundary === 'json') r.props.modelValue = JSON.stringify([block(30)]);
    if (boundary === 'editor') r.props.editorKey = 'replacement';
    if (boundary === 'disabled') r.props.disabled = true;
    if (boundary === 'session') r.storage.set('admin_session', 'replaced-same-token');
    if (boundary === 'unmount') r.unmount();
    await tick();
    const expected = r.props.modelValue; await old.choose('/api/assets/18', ticket(18)); await tick(); assert.equal(r.props.modelValue, expected); assert.deepEqual(r.state.previews, {});
  } finally { r.unmount(); }
});
test('published media read is anonymous, matches the complete saved component, and leaves author JSON unchanged', async () => {
  const source = block(); source.imgConfig.url = '/api/assets/17'; source.codeConfig.url = '/api/assets/18'; const r = harness([source]), old = global.fetch, calls = [];
  try {
    global.fetch = async (url, options) => { calls.push({ url, options }); const row = clone(source); row.imgConfig.url = ticket(17); row.codeConfig.url = ticket(18); return { ok: true, json: async () => ({ status: 200, data: { value: [row] } }) }; };
    await r.state.loadSavedMedia(); await tick(); assert.equal(r.state.error, ''); assert.deepEqual(r.value(), [source]); assert.equal(r.writes.length, 0);
    assert.equal(calls[0].url, '/api/diy/get_diy/2'); assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.headers, undefined);
    assert.equal(r.state.previews['/api/assets/17'], ticket(17)); assert.equal(r.state.previews['/api/assets/18'], ticket(18));
    const actions = all(r.tree, n => n.tag === 'button' && text(n) === '关注'); assert.equal(actions.length, 1); assert.ok(actions.every(n => n.props.disabled === true || n.props.disabled === ''));
  } finally { global.fetch = old; r.unmount(); }
});
for (const boundary of ['component', 'json', 'page', 'publication', 'disabled', 'account', 'unmount']) test(`late published media read is aborted and discarded after ${boundary}`, async () => {
  const source = block(); source.codeConfig.url = '/api/assets/18'; const r = harness([source, block(20)]), gate = deferred(), old = global.fetch; let signal;
  try {
    global.fetch = async (_url, options) => { signal = options.signal; return gate.promise; }; const task = r.state.loadSavedMedia(); await tick();
    if (boundary === 'component') r.state.select(1);
    if (boundary === 'json') r.props.modelValue = JSON.stringify([block(30)]);
    if (boundary === 'page') r.props.pageId = 3;
    if (boundary === 'publication') r.props.pagePublished = false;
    if (boundary === 'disabled') r.props.disabled = true;
    if (boundary === 'account') r.actor.token = 'B';
    if (boundary === 'unmount') r.unmount();
    await tick();
    assert.equal(signal.aborted, true); gate.resolve({ ok: true, json: async () => ({ status: 200, data: { value: [{ ...source, codeConfig: { ...source.codeConfig, url: ticket(18) } }] } }) }); await task;
    assert.deepEqual(r.state.previews, {}); assert.equal(r.state.error, ''); assert.equal(r.state.mediaLoading, false); assert.equal(r.writes.length, 0);
  } finally { global.fetch = old; r.unmount(); }
});
test('replaced complete config, closed responses and failed reads never grant media capability or trigger writes', async () => {
  const old = global.fetch;
  try { for (const mode of ['changed', 'closed', 'network']) {
    const r = harness(); try {
      global.fetch = async () => { if (mode === 'network') throw Error('network'); return { ok: true, json: async () => mode === 'closed' ? { status: 410010 } : { status: 200, data: { value: [{ ...block(), extra: 'changed' }] } } }; };
      await r.state.loadSavedMedia(); assert.ok(r.state.error); assert.deepEqual(r.state.previews, {}); assert.equal(r.writes.length, 0); assert.deepEqual(r.calls, []);
    } finally { r.unmount(); }
  } } finally { global.fetch = old; }
});
test('dise-only operator edits text without attachment rights; read-only identity cannot mutate from retained callbacks', async () => {
  const actor = vue.reactive({ token: 'A', userInfo: { id: 11, level: 1 }, uniqueAuth: ['dise.manage'] }), r = harness(undefined, { actor });
  try {
    assert.equal(r.state.canEdit, true); assert.equal(r.state.canChooseMedia, false); await r.state.mediaSessions.imgConfig.choose('/api/assets/18', ticket(18)); assert.equal(r.writes.length, 0);
    r.state.setTitle('新标题'); assert.equal(r.value()[0].titleConfig.value, '新标题'); actor.uniqueAuth = []; const expected = r.props.modelValue; r.state.setTitle('禁止'); r.state.add(); r.state.remove(); assert.equal(r.props.modelValue, expected);
  } finally { r.unmount(); }
});
test('actual DiseList save canonicalizes only follow image slots and keeps independent content and immutable metadata', async () => {
  const source = block(); source.imgConfig.url = ticket(17); source.codeConfig.url = ticket(18); source.extra.url = ticket(99);
  const writes = [], l = loader({ gateway: { get: async () => ({ data: [] }), post: async (url, body) => { writes.push({ url, body: clone(body) }); return { data: { id: 2 } }; } } }), m = mount(l, base.pageFile, {});
  try {
    m.state.openForm({ id: 2, name: '关注页面', title: '标题', value: JSON.stringify([source]), content: 'independent', status: 1, type: 1, template_name: 'default', is_diy: 1, is_show: 1 }); await m.state.save();
    assert.equal(writes.length, 1); assert.equal(writes[0].url, '/dise/save'); assert.equal(writes[0].body.content, 'independent');
    const saved = JSON.parse(writes[0].body.value)[0]; assert.equal(saved.imgConfig.url, '/api/assets/17'); assert.equal(saved.codeConfig.url, '/api/assets/18'); assert.equal(saved.extra.url, ticket(99)); assert.equal(writes[0].body.type, undefined);
  } finally { m.unmount(); }
});
const { runtime } = require('../../uniapp-ts/scripts/uni-store-runtime.cjs');
const uniVue = require('../../uniapp-ts/node_modules/vue');
for (const variant of ['default', 'corners', 'small-corners', 'tone', 'malformed', 'numeric-import']) test(`preview matches actual inactive Uni follow consumer for ${variant}`, () => {
  const b = block(); b.imgConfig.url = ticket(17); b.codeConfig.url = ticket(18);
  if (variant === 'corners') b.fillet = { type: 'true', valList: [1, 2, 3, 4].map(val => ({ val })) };
  if (variant === 'small-corners') b.fillet = { type: 1, valList: [5e-8, '3e-7', .5, 1].map(val => ({ val })) };
  if (variant === 'tone') b.toneConfig = { tabVal: '0' };
  if (variant === 'malformed') { b.bgColor.color[0].item = 'url(javascript:bad)'; b.themeColor.color[0].item = 'bad'; b.mbConfig.val = 'bad'; }
  if (variant === 'numeric-import') { b.prConfig.val = '125'; b.mbConfig.val = '1e-3'; b.fillet.val = '120'; b.titleConfig.value = '  保留导入标题  '; }
  const r = runtime({ component: 'components/diy/DiyEditorialWidget.vue', props: uniVue.reactive({ block: b, active: false }), platform: 'H5', send: () => { throw Error('inactive must not read'); } });
  try {
    const actual = r.checkout.state.config.value, projected = loader().load(projection).normalizeDiyFollowPreview(b);
    assert.equal(projected.title, actual.followTitle); assert.equal(projected.image, actual.followImage); assert.equal(projected.code, actual.followCode);
    const px = style => Object.fromEntries(Object.entries(style).filter(([key]) => !key.startsWith('--')).map(([key, value]) => [key, value.replace(/([\d.e+-]+)rpx/gu, (_, n) => `${Number(n) / 2}px`)]));
    assert.deepEqual(projected.wrapperStyle, px(actual.followWrapStyle)); assert.deepEqual(projected.cardStyle, px(actual.followCardStyle)); assert.deepEqual(projected.buttonStyle, actual.followButtonStyle); assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
});
