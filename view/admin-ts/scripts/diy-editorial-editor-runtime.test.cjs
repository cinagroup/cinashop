const base = require('./helpers/diy-list-runtime.cjs');
const { test, assert, path, root, vue, loader, mount, tick, clone, deferred, ticket, all, text } = base;
const editor = path.join(root, 'components/content/DiyEditorialEditor.vue');
const preview = path.join(root, 'components/content/DiyEditorialPreview.vue');
const canvas = path.join(root, 'components/content/DiyHotspotEditorCanvas.vue');
const util = path.join(root, 'utils/diyEditorialEditor.ts');
const projection = path.join(root, 'utils/diyEditorialProjection.ts');
function block(kind = 'news', timestamp = 10) { return { ...loader().load(util).newEditorialBlock(kind, timestamp), unknown: { keep: [0, false, ''], url: ticket(99) } }; }
function harness(value = [block()], options = {}) {
  const l = loader(options), props = vue.reactive({ modelValue: JSON.stringify(value), editorKey: 'editorial:2', disabled: false, pageId: 2, pagePublished: true, ...options.props }), writes = [];
  const m = mount(l, editor, props, (_event, value) => { writes.push(value); props.modelValue = value; });
  return { ...l, ...m, props, writes, value: () => JSON.parse(props.modelValue) };
}
function control(r, label) {
  const field = all(r.tree, n => n.props['data-element'] === 'el-form-item' && n.props['data-label'] === label)[0]; assert.ok(field, label);
  const found = all(field, n => ['el-select', 'el-input', 'el-input-number', 'el-color-picker', 'el-switch'].includes(n.props['data-element']) && typeof n.props['onUpdate:modelValue'] === 'function')[0]; assert.ok(found, label); return found;
}
async function update(r, label, value) { control(r, label).props['onUpdate:modelValue'](value); await tick(); }
const imagePath = kind => kind === 'news' ? ['imgConfig', 'url'] : kind === 'hotspot' ? ['picStyle', 'url'] : ['menuConfig', 'list', 0, 'img'];
function setImage(row, kind, value) { const keys = imagePath(kind); for (const key of keys.slice(0, -1)) row = row[key]; row[keys.at(-1)] = value; }
for (const kind of ['news', 'hotspot', 'activeParty']) test(`real ${kind} editor preserves complete imports until an explicit leaf edit`, async () => {
  const source = block(kind), neighbor = { name: 'unknown', content: [null, false], url: ticket(44) }; source.mbConfig.val = '125';
  const r = harness([source, neighbor]); try {
    assert.equal(r.writes.length, 0); assert.deepEqual(r.value(), [source, neighbor]);
    assert.equal(control(r, '组件上间距（设计 px）').props.modelValue, 125);
    await update(r, '组件上间距（设计 px）', 6); await update(r, '公告与活动组件显示', false);
    const expected = clone(source); expected.mbConfig.val = 6; expected.isHide = true; assert.deepEqual(r.value(), [expected, neighbor]);
    assert.match(text(r.tree), /此组件已隐藏/);
  } finally { r.unmount(); }
});
test('real news controls retain every metadata field, numeric strings, and asymmetric corners', async () => {
  const row = block(); row.titleTxtConfig.value = '完整导入长标题仍然可以编辑'; row.mbConfig.val = '0'; row.fillet.val = '0'; row.styleConfig.tabVal = '0'; const r = harness([row]);
  try {
    await update(r, '组件上间距（设计 px）', 0); await update(r, '公告风格', 0); await update(r, '公告与热区全部圆角', 0); assert.equal(r.writes.length, 0);
    await update(r, '公告风格', 1); await update(r, '公告标题类型', 0); await update(r, '公告滚动方式', 1); await update(r, '公告更多按钮', 1); await update(r, '公告色调', 1);
    await update(r, '公告标题背景结束色', '#abc123'); await update(r, '公告与热区圆角方式', 1); await update(r, '公告与热区左下圆角', 13);
    await update(r, '公告条目文字', '迁移后的公告'); await update(r, '公告条目显示', false);
    const saved = r.value()[0]; assert.equal(saved.titleTxtConfig.value, row.titleTxtConfig.value); assert.equal(saved.titleBgColor.color[1].item, '#abc123'); assert.equal(saved.fillet.valList[2].val, 13);
    assert.equal(saved.listConfig.list[0].chiild[0].val, '迁移后的公告'); assert.equal(saved.listConfig.list[0].show, false);
    assert.deepEqual(saved.unknown, row.unknown); assert.equal(saved.listConfig.list[0].chiild[0].title, row.listConfig.list[0].chiild[0].title);
    for (const bad of [null, undefined, NaN, Infinity, -1, '4', 101]) r.state.setLength('mbConfig', bad);
    assert.equal(r.value()[0].mbConfig.val, '0');
  } finally { r.unmount(); }
});
test('real party controls edit title, badge, each card and authored gradient without fabricating commerce data', async () => {
  const row = block('activeParty'), r = harness([row]); try {
    await update(r, '活动促销标题', '本周活动'); await update(r, '活动促销简介', '限时参与'); await update(r, '活动卡片标题', '新品'); await update(r, '活动卡片简介', '发现新品');
    await update(r, '活动主题色', '#113355'); await update(r, '活动标签渐变结束色', '#ffeeaa');
    const saved = r.value()[0]; assert.equal(saved.titleConfig.value, '本周活动'); assert.equal(saved.desConfig.value, '限时参与');
    assert.equal(saved.menuConfig.list[0].info[0].value, '新品'); assert.equal(saved.menuConfig.list[0].info[1].value, '发现新品'); assert.equal(saved.bgColor.color[1].item, '#ffeeaa');
    assert.deepEqual(saved.titleConfig.place, row.titleConfig.place); assert.deepEqual(saved.menuConfig.list[0].info[0].place, row.menuConfig.list[0].info[0].place); assert.deepEqual(r.calls, []);
  } finally { r.unmount(); }
});
for (const [kind, count] of [['news', 12], ['activeParty', 6], ['hotspot', 32]]) test(`all ${count} imported ${kind} entries remain selectable, sortable and removable beyond consumer limit`, async () => {
  const row = block(kind), l = loader(), model = l.load(util), list = []; for (let i = 0; i < count; i++) list.push({ ...model.newEditorialItem(kind, i, 750, 750), marker: i });
  if (kind === 'news') row.listConfig.list = list; else if (kind === 'activeParty') row.menuConfig.list = list; else row.picStyle.list = list;
  const r = harness([row]); try {
    assert.equal(r.state.items.length, count); assert.match(text(r.tree), new RegExp(`完整保留 ${count}`)); assert.equal(r.writes.length, 0);
    r.state.selectItem(count - 1); await tick(); r.state.itemLinkSession.choose({ url: '/pages/cart/index' }); await tick();
    assert.equal(r.state.items[count - 1].marker, count - 1);
    const linked = r.state.items[count - 1]; assert.equal(kind === 'news' ? linked.chiild[1].val : kind === 'activeParty' ? linked.info[2].value : linked.link, '/pages/cart/index');
    r.state.moveItem(-1); await tick(); assert.equal(r.state.items[count - 2].marker, count - 1);
    r.state.addItem(); await tick(); assert.equal(r.state.items.length, count); r.state.removeItem(); await tick(); assert.equal(r.state.items.length, count - 1);
    assert.ok(r.state.items.some(item => item.marker === 0));
  } finally { r.unmount(); }
});
test('three families can be added, sorted and removed alongside unrecognized blocks', async () => {
  const unknown = { name: 'unknown', deep: { a: false } }, r = harness([unknown]); try {
    for (const kind of ['news', 'hotspot', 'activeParty']) { r.state.addKind = kind; r.state.add(); await tick(); }
    assert.deepEqual(r.value().map(row => row.name), ['unknown', 'news', 'hotspot', 'activeParty']);
    r.state.move(-1); await tick(); assert.deepEqual(r.value().map(row => row.name), ['unknown', 'news', 'activeParty', 'hotspot']);
    r.state.remove(); await tick(); assert.deepEqual(r.value().map(row => row.name), ['unknown', 'news', 'hotspot']); assert.deepEqual(r.value()[0], unknown);
  } finally { r.unmount(); }
});
for (const kind of ['news', 'hotspot', 'activeParty']) test(`media choice for ${kind} stores only the exact stable reference and keeps admitted preview through own edits`, async () => {
  const r = harness([block(kind)]); try {
    await r.state.mediaSession.choose('/api/assets/17', ticket(18)); assert.equal(r.writes.length, 0);
    await r.state.mediaSession.choose('/api/assets/17', ticket(17)); await tick(); assert.equal(r.state.imageReference, '/api/assets/17'); assert.equal(r.state.previews['/api/assets/17'], ticket(17));
    await update(r, '组件上间距（设计 px）', 12); assert.equal(r.state.previews['/api/assets/17'], ticket(17)); assert.equal(r.value()[0].unknown.url, ticket(99));
    assert.equal(r.state.imageReference.includes('?'), false); r.state.clearImage(); await tick(); assert.equal(r.state.imageReference, ''); assert.deepEqual(r.state.previews, {});
  } finally { r.unmount(); }
});
for (const boundary of ['block', 'item', 'json', 'editor', 'page', 'publication', 'disabled', 'account', 'storage', 'unmount']) test(`retained image and link callbacks cannot cross ${boundary}`, async () => {
  const r = harness([block('activeParty'), block('activeParty', 20)]), media = r.state.mediaSession, link = r.state.itemLinkSession;
  try {
    if (boundary === 'block') r.state.select(1); if (boundary === 'item') r.state.selectItem(1); if (boundary === 'json') r.props.modelValue = JSON.stringify([block('news', 30)]);
    if (boundary === 'editor') r.props.editorKey = 'reopened'; if (boundary === 'page') r.props.pageId = 3; if (boundary === 'publication') r.props.pagePublished = false;
    if (boundary === 'disabled') r.props.disabled = true; if (boundary === 'account') r.actor.token = 'B'; if (boundary === 'storage') r.storage.set('admin_session', 'new-session'); if (boundary === 'unmount') r.unmount();
    await tick(); const expected = r.props.modelValue; await media.choose('/api/assets/17', ticket(17)); link.choose({ url: '/pages/cart/index' }); await tick(); assert.equal(r.props.modelValue, expected); assert.deepEqual(r.state.previews, {});
  } finally { r.unmount(); }
});
for (const event of ['admin-session-changed', 'admin-auth-expired', 'storage']) test(`queued parent media receipt cannot regain capability after ${event}`, async () => {
  const l = loader(), value = vue.ref(JSON.stringify([block()])), tree = base.node('root'), component = l.load(editor).default;
  const app = base.renderer.createApp({ setup: () => () => vue.h(component, { modelValue: value.value, editorKey: 'queued-editorial', pageId: 2, pagePublished: true, 'onUpdate:modelValue': next => { value.value = next; } }) });
  for (const name of base.elementNames) app.component(name, base.elementStub(name)); app.directive('loading', {}); app.mount(tree);
  try { const state = l.instances.get(editor).at(-1), task = state.mediaSession.choose('/api/assets/17', ticket(17)); l.window.dispatchEvent(new Event(event)); await task; await tick(); assert.equal(JSON.parse(value.value)[0].imgConfig.url, '/api/assets/17'); assert.deepEqual(state.previews, {}); }
  finally { app.unmount(); }
});
test('ordinary asynchronous v-model propagation admits a new exact preview and retains both party card capabilities', async () => {
  const l = loader(), value = vue.ref(JSON.stringify([block('activeParty')])), tree = base.node('root'), component = l.load(editor).default;
  const app = base.renderer.createApp({ setup: () => () => vue.h(component, { modelValue: value.value, editorKey: 'queued-success', 'onUpdate:modelValue': next => { value.value = next; } }) });
  for (const name of base.elementNames) app.component(name, base.elementStub(name)); app.directive('loading', {}); app.mount(tree);
  try { const state = l.instances.get(editor).at(-1); await state.mediaSession.choose('/api/assets/17', ticket(17)); await tick(); state.selectItem(1); await tick(); await state.mediaSession.choose('/api/assets/18', ticket(18)); await tick(); assert.deepEqual(state.previews, { '/api/assets/17': ticket(17), '/api/assets/18': ticket(18) }); assert.equal(JSON.parse(value.value)[0].menuConfig.list[1].img, '/api/assets/18'); }
  finally { app.unmount(); }
});
test('hotspot geometry requires the real matching image; same image preview renewal retains all regions, replacement clears them', async () => {
  const row = block('hotspot'); row.picStyle.url = '/api/assets/17'; row.picStyle.list = [{ number: 1, starX: 10, starY: 20, areaWidth: 100, areaHeight: 80, nowImgWidth: 750, link: '/pages/cart/index', extra: true }]; const r = harness([row]);
  try {
    r.state.applyGeometry(0, { left: 20, top: 30, width: 120, height: 90 }); assert.equal(r.writes.length, 0);
    await r.state.mediaSession.choose('/api/assets/17', ticket(17)); await tick(); r.state.acceptSize({ width: 750, height: 500, reference: '/api/assets/99' }); assert.equal(r.state.imageSize, null);
    const state = r.instances.get(canvas).at(-1); state.imageSession.load({ currentTarget: { naturalWidth: 750, naturalHeight: 500 } }); await tick();
    assert.equal(r.state.imageSize.height, 500); r.state.applyGeometry(0, { left: 30, top: 40, width: 120, height: 90 }); await tick();
    assert.equal(r.value()[0].picStyle.list[0].starX, 30); assert.equal(r.value()[0].picStyle.list[0].extra, true); assert.equal(r.state.previews['/api/assets/17'], ticket(17)); assert.equal(r.state.imageSize.height, 500);
    await r.state.mediaSession.choose('/api/assets/17', ticket(17)); await tick(); assert.equal(r.state.items.length, 1);
    await r.state.mediaSession.choose('/api/assets/18', ticket(18)); await tick(); assert.deepEqual(r.state.items, []); assert.equal(r.state.imageSize, null);
  } finally { r.unmount(); }
});
for (const boundary of ['json', 'admin-session-changed', 'admin-auth-expired', 'storage']) test(`same public hotspot image reacquires dimensions and rejects old native callbacks after ${boundary}`, async () => {
  const row = block('hotspot'); row.picStyle.url = '/static/test.png'; row.picStyle.list = [{ number: 1, starX: 10, starY: 20, areaWidth: 100, areaHeight: 80, nowImgWidth: 750, link: '/pages/cart/index' }]; const r = harness([row]);
  try {
    const c = r.instances.get(canvas).at(-1); c.imageSession.load({ currentTarget: { naturalWidth: 750, naturalHeight: 500 } }); await tick(); assert.equal(r.state.imageSize.height, 500);
    const old = c.imageSession, key = r.state.canvasKey;
    if (boundary === 'json') { const replacement = clone(row); replacement.picStyle.list[0].starX = 25; r.props.modelValue = JSON.stringify([replacement]); } else r.window.dispatchEvent(new Event(boundary));
    await tick(); assert.notEqual(r.state.canvasKey, key); assert.equal(r.state.imageSize, null); assert.equal(c.size, null);
    old.load({ currentTarget: { naturalWidth: 99, naturalHeight: 1 } }); assert.equal(r.state.imageSize, null); assert.equal(c.size, null);
    c.imageSession.load({ currentTarget: { naturalWidth: 750, naturalHeight: 500 } }); await tick(); assert.equal(r.state.imageSize.height, 500);
    r.state.applyGeometry(0, { left: 50, top: 60, width: 110, height: 90 }); await tick(); assert.equal(r.value()[0].picStyle.list[0].starX, 50); assert.equal(r.value()[0].picStyle.list[0].starY, 60); assert.equal(r.state.imageSize.height, 500);
  } finally { r.unmount(); }
});
for (const kind of ['news', 'hotspot', 'activeParty']) test(`anonymous published ${kind} media matches the whole saved component and leaves author JSON intact`, async () => {
  const row = block(kind); setImage(row, kind, '/api/assets/17'); const r = harness([row]), old = global.fetch, calls = [];
  try {
    const published = clone(row); setImage(published, kind, ticket(17)); if (kind === 'activeParty') for (const key of ['titleConfig', 'desConfig']) { delete published[key].max; delete published[key].place; }
    global.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ status: 200, data: { value: [published] } }) }; };
    await r.state.loadSavedMedia(); await tick(); assert.equal(r.state.error, ''); assert.equal(r.state.previews['/api/assets/17'], ticket(17)); assert.deepEqual(r.value(), [row]); assert.equal(r.writes.length, 0);
    assert.equal(calls[0].url, '/api/diy/get_diy/2'); assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.headers, undefined);
  } finally { global.fetch = old; r.unmount(); }
});
test('published party matching strips exactly the four PHP author metadata fields and rejects other changes', async () => {
  const row = block('activeParty'); row.menuConfig.list[0].img = '/api/assets/17'; const r = harness([row]), old = global.fetch;
  try {
    const published = clone(row); published.menuConfig.list[0].img = ticket(17); for (const key of ['titleConfig', 'desConfig']) { delete published[key].place; delete published[key].max; }
    published.menuConfig.list[0].info[0].place = 'changed';
    global.fetch = async () => ({ ok: true, json: async () => ({ status: 200, data: { value: [published] } }) }); await r.state.loadSavedMedia(); assert.match(r.state.error, /与已发布配置不同/); assert.deepEqual(r.state.previews, {}); assert.equal(r.writes.length, 0);
  } finally { global.fetch = old; r.unmount(); }
});
for (const boundary of ['item', 'block', 'json', 'page', 'publication', 'disabled', 'account', 'session', 'unmount']) test(`late editorial public media read is aborted and discarded on ${boundary}`, async () => {
  const row = block('activeParty'); row.menuConfig.list[0].img = '/api/assets/17'; const r = harness([row, block('news', 20)]), old = global.fetch, gate = deferred(); let signal;
  try {
    global.fetch = async (_url, options) => { signal = options.signal; return gate.promise; }; const task = r.state.loadSavedMedia(); await tick();
    if (boundary === 'item') r.state.selectItem(1); if (boundary === 'block') r.state.select(1); if (boundary === 'json') r.props.modelValue = JSON.stringify([block()]);
    if (boundary === 'page') r.props.pageId = 3; if (boundary === 'publication') r.props.pagePublished = false; if (boundary === 'disabled') r.props.disabled = true;
    if (boundary === 'account') r.actor.token = 'B'; if (boundary === 'session') r.window.dispatchEvent(new Event('admin-session-changed')); if (boundary === 'unmount') r.unmount();
    await tick(); assert.equal(signal.aborted, true); const published = clone(row); published.menuConfig.list[0].img = ticket(17); gate.resolve({ ok: true, json: async () => ({ status: 200, data: { value: [published] } }) }); await task;
    assert.deepEqual(r.state.previews, {}); assert.equal(r.state.mediaLoading, false); assert.equal(r.state.error, ''); assert.equal(r.writes.length, 0);
  } finally { global.fetch = old; r.unmount(); }
});
test('dise operator may edit text without attachment rights and retained callbacks cannot write after role removal', async () => {
  const actor = vue.reactive({ token: 'A', userInfo: { id: 11, level: 1 }, uniqueAuth: ['dise.manage'] }), r = harness(undefined, { actor });
  try { assert.equal(r.state.canEdit, true); assert.equal(r.state.canChooseMedia, false); await r.state.mediaSession.choose('/api/assets/17', ticket(17)); assert.equal(r.writes.length, 0); r.state.setText('titleTxtConfig', '权限'); await tick(); assert.equal(r.value()[0].titleTxtConfig.value, '权限'); actor.uniqueAuth = []; const expected = r.props.modelValue; r.state.setText('titleTxtConfig', '禁止'); r.state.add(); r.state.remove(); assert.equal(r.props.modelValue, expected); }
  finally { r.unmount(); }
});
test('actual DiseList save canonicalizes only explicit editorial media slots and preserves content and imported rows', async () => {
  const rows = ['news', 'hotspot', 'activeParty'].map(kind => { const row = block(kind); setImage(row, kind, ticket(17)); return row; });
  rows[2].menuConfig.list.push({ img: ticket(18), arbitrary: true }); const writes = [], l = loader({ gateway: { get: async () => ({ data: [] }), post: async (url, body) => { writes.push({ url, body: clone(body) }); return { data: { id: 2 } }; } } });
  require('node:events').setMaxListeners(32, l.window); // All adjacent authors listen to this page-scoped browser EventTarget.
  const m = mount(l, base.pageFile, {});
  try { m.state.openForm({ id: 2, name: '公告活动页面', title: '标题', value: JSON.stringify(rows), content: 'independent', status: 1, is_show: 1 }); await m.state.save(); assert.equal(writes.length, 1); assert.equal(writes[0].url, '/dise/save'); assert.equal(writes[0].body.content, 'independent'); const saved = JSON.parse(writes[0].body.value); assert.equal(saved[0].imgConfig.url, '/api/assets/17'); assert.equal(saved[1].picStyle.url, '/api/assets/17'); assert.equal(saved[2].menuConfig.list[0].img, '/api/assets/17'); assert.equal(saved[2].menuConfig.list.at(-1).img, '/api/assets/18'); assert.equal(saved[0].unknown.url, ticket(99)); }
  finally { m.unmount(); }
});
const { runtime } = require('../../uniapp-ts/scripts/uni-store-runtime.cjs'), uniVue = require('../../uniapp-ts/node_modules/vue');
for (const kind of ['news', 'activeParty', 'hotspot']) for (const variant of ['default', 'custom', 'corners', 'numeric-import', 'public-images']) test(`${kind} projection agrees with actual inactive Uni consumer for ${variant}`, () => {
  const b = block(kind); if (variant === 'custom') { b.toneConfig = { tabVal: 1 }; b.titleColor = { color: [{ item: '#123456' }] }; }
  if (variant === 'corners') b.fillet = { type: 'true', valList: [1, 2, 3, 4].map(val => ({ val })) };
  if (variant === 'numeric-import') { b.prConfig = { val: '125' }; b.mbConfig.val = '1e-3'; b.fillet = { val: '120' }; }
  if (variant === 'public-images') setImage(b, kind, 'http://images.example/cover.png');
  const r = runtime({ component: 'components/diy/DiyEditorialWidget.vue', props: uniVue.reactive({ block: b, active: false }), platform: 'H5', send: () => { throw Error('inactive must not read'); } });
  try {
    const actual = r.checkout.state.config.value, projected = loader().load(projection).normalizeDiyEditorialPreview(b), px = loader().load(projection).editorialPixels;
    for (const key of ['newsListStyle', 'horizontalNews', 'titleImage', 'titleText', 'showMore', 'moreText', 'partyTitle', 'partyBadge', 'hotspotImage']) assert.deepEqual(projected[key], actual[key], key);
    assert.deepEqual(projected.newsItems.map(({ index, ...row }) => row), actual.newsItems); assert.deepEqual(projected.partyItems.map(({ index, ...row }) => row), actual.partyItems); assert.deepEqual(projected.hotspotAreas, actual.hotspotAreas);
    for (const key of ['outerStyle', 'cardStyle', 'radiusStyle', 'titleStyle', 'tickerTitleStyle', 'newsTextStyle', 'buttonStyle', 'partyStyle', 'partyTitleStyle', 'partyBadgeStyle']) assert.deepEqual(px(projected[key]), px(actual[key]), key);
    assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
});
test('readonly hotspot preview renders actual padding, margin, corners and clipped valid areas after its native image loads', async () => {
  const row = block('hotspot'); row.picStyle.url = '/static/test.png'; row.topConfig.val = 10; row.bottomConfig.val = 12; row.prConfig.val = 8; row.mbConfig.val = 6; row.fillet = { type: 1, valList: [1, 2, 3, 4].map(val => ({ val })) };
  row.picStyle.list = [{ starX: 700, starY: 450, areaWidth: 100, areaHeight: 100, link: '/pages/cart/index' }, { starX: 10, starY: 10, areaWidth: 20, areaHeight: 20, link: 'javascript:bad' }, { starX: 20, starY: 600, areaWidth: 20, areaHeight: 20, link: '/pages/cart/index' }];
  const l = loader(), props = vue.reactive({ block: row, editorKey: 'readonly:2' }), m = mount(l, preview, props);
  try {
    assert.equal(m.state.hotspotAreas.length, 0); m.state.hotspotImageSession.load({ currentTarget: { naturalWidth: 750, naturalHeight: 500 } }); await tick();
    assert.deepEqual(m.state.hotspotAreas[0].style, { left: `${700 / 750 * 100}%`, top: '90%', width: `${50 / 750 * 100}%`, height: '10%' }); assert.equal(m.state.hotspotAreas.length, 1);
    const wrapper = all(m.tree, n => n.props.style?.padding === '10px 8px 12px')[0]; assert.ok(wrapper); assert.equal(wrapper.props.style.marginTop, '6px');
    assert.ok(all(m.tree, n => n.props.style?.borderRadius === '1px 2px 4px 3px').length);
    const area = all(m.tree, n => n.props['aria-label'] === '只读热区 1')[0]; assert.ok(area); assert.ok(area.props.disabled === true || area.props.disabled === ''); assert.equal(area.props.onClick, undefined); assert.equal(l.calls.length, 0);
    assert.deepEqual(props.block.picStyle.list, row.picStyle.list);
  } finally { m.unmount(); }
});
for (const boundary of ['source', 'editor', 'hidden', 'unmount']) test(`readonly hotspot image callback cannot cross ${boundary}`, async () => {
  const row = block('hotspot'); row.picStyle.url = '/static/test.png'; const l = loader(), props = vue.reactive({ block: row, editorKey: 'old' }), m = mount(l, preview, props), old = m.state.hotspotImageSession;
  try { if (boundary === 'source') props.block.picStyle.url = '/static/other.png'; if (boundary === 'editor') props.editorKey = 'new'; if (boundary === 'hidden') props.block.isHide = true; if (boundary === 'unmount') m.unmount(); await tick(); old.load({ currentTarget: { naturalWidth: 750, naturalHeight: 500 } }); assert.equal(m.state.imageSize, null); }
  finally { m.unmount(); }
});
