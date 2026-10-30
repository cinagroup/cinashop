const B = require('./helpers/diy-list-runtime.cjs');
const { test, assert, path, root, vue, loader, mount, tick, clone, deferred, ticket, all, renderer, node, elementNames, elementStub } = B;
const editor = path.join(root, 'components/content/DiyEditorialEditor.vue');
const canvas = path.join(root, 'components/content/DiyHotspotEditorCanvas.vue');
const modelFile = path.join(root, 'utils/diyEditorialEditor.ts');
const projectionFile = path.join(root, 'utils/diyEditorialProjection.ts');
const model = () => loader().load(modelFile);
const block = (kind, timestamp = 10) => ({ ...model().newEditorialBlock(kind, timestamp), unknown: { zero: 0, false: false, list: [] } });

function harness(rows, extra = {}) {
  const l = loader(extra), props = vue.reactive({ modelValue: JSON.stringify(rows), editorKey: 'editorial:2', pageId: 2, pagePublished: true, disabled: false, ...extra.props }), writes = [];
  require('node:events').setMaxListeners(32, l.window);
  const mounted = mount(l, editor, props, (_event, value) => { writes.push(value); props.modelValue = value; });
  return { ...l, ...mounted, props, writes, value: () => JSON.parse(props.modelValue) };
}

for (const kind of ['news', 'hotspot', 'activeParty']) test(`${kind} mount and unchanged number/visibility events keep raw spellings and all imported fields`, async () => {
  const first = block(kind);
  first.timestamp = ' 2e0 '; first.mbConfig.val = ' 9e0 '; first.isHide = '0';
  if (first.fillet) { first.fillet.type = '0'; first.fillet.val = '0'; first.prConfig.val = '125'; }
  if (kind === 'news') first.styleConfig.tabVal = '01';
  const rows = [first, { name: 'unknown', timestamp: 999, content: [false, 0, null] }], r = harness(rows);
  try {
    await tick();
    assert.deepEqual(r.value(), rows); assert.deepEqual(r.writes, []);
    r.state.setLength('mbConfig', 9); r.state.setVisible(true);
    if (kind !== 'activeParty') { r.state.setRadiusType(0); r.state.setRadius(-1, 0); }
    if (kind === 'news') r.state.setEnum('styleConfig', 1);
    await tick();
    assert.deepEqual(r.writes, []); assert.deepEqual(r.value(), rows);
    r.state.setLength('mbConfig', 10);
    await tick();
    const expected = clone(rows); expected[0].mbConfig.val = 10;
    assert.deepEqual(r.value(), expected); assert.equal(r.writes.length, 1);
  } finally { r.unmount(); }
});

test('published activeParty identity removes exactly four top-level author metadata fields', () => {
  const value = block('activeParty'), original = clone(value), u = loader().load(projectionFile);
  value.menuConfig.list[0].img = ticket(7);
  value.menuConfig.list[0].info[0].unknown = { max: 90, place: 'retain' };
  const expected = clone(value);
  expected.menuConfig.list[0].img = '/api/assets/7';
  for (const key of ['titleConfig', 'desConfig']) { delete expected[key].place; delete expected[key].max; }
  assert.deepEqual(JSON.parse(u.publishedEditorialIdentity(value)), expected);
  assert.equal(value.titleConfig.place, original.titleConfig.place);
  assert.equal(value.titleConfig.max, original.titleConfig.max);
  assert.deepEqual(value.menuConfig.list[0].info[0].unknown, { max: 90, place: 'retain' });
});

function publishedParty(value) {
  const copy = clone(value);
  for (const key of ['titleConfig', 'desConfig']) { delete copy[key].place; delete copy[key].max; }
  copy.menuConfig.list[0].img = ticket(7);
  return copy;
}

test('real saved-media read admits exact public activeParty metadata projection without rewriting raw author data', async () => {
  const value = block('activeParty'); value.menuConfig.list[0].img = '/api/assets/7';
  const oldFetch = global.fetch, requests = [];
  global.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ status: 200, data: { value: [publishedParty(value)] } }) }; };
  const r = harness([value]);
  try {
    await r.state.loadSavedMedia(); await tick();
    assert.equal(r.state.error, ''); assert.equal(r.state.previews['/api/assets/7'], ticket(7));
    assert.deepEqual(r.writes, []); assert.deepEqual(r.value(), [value]);
    assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/diy/get_diy/2');
    assert.equal(requests[0].options.method, 'GET'); assert.equal(requests[0].options.credentials, 'omit'); assert.equal(requests[0].options.cache, 'no-store');
  } finally { r.unmount(); global.fetch = oldFetch; }
});

for (const mutation of ['nested-max', 'title-label', 'subtitle-value', 'timestamp', 'card-link', 'unknown']) test(`public activeParty ${mutation} drift cannot be hidden by the four metadata removals`, async () => {
  const value = block('activeParty'); value.menuConfig.list[0].img = '/api/assets/7';
  const remote = publishedParty(value);
  if (mutation === 'nested-max') remote.menuConfig.list[0].info[0].max++;
  if (mutation === 'title-label') remote.titleConfig.title = 'changed';
  if (mutation === 'subtitle-value') remote.desConfig.value = 'changed';
  if (mutation === 'timestamp') remote.timestamp++;
  if (mutation === 'card-link') remote.menuConfig.list[0].info[2].value = '/pages/cart/index';
  if (mutation === 'unknown') delete remote.unknown;
  const oldFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ status: 200, data: { value: [remote] } }) });
  const r = harness([value]);
  try {
    await r.state.loadSavedMedia(); await tick();
    assert.match(r.state.error, /与已发布配置不同/); assert.deepEqual(r.state.previews, {});
    assert.deepEqual(r.value(), [value]); assert.deepEqual(r.writes, []);
  } finally { r.unmount(); global.fetch = oldFetch; }
});

/** Real Vue parent propagation leaves the child's model prop unchanged until render flush. */
function parent(rows) {
  const l = loader(), raw = vue.ref(JSON.stringify(rows)), disabled = vue.ref(false), writes = [], tree = node('root');
  require('node:events').setMaxListeners(32, l.window);
  const component = l.load(editor).default;
  const app = renderer.createApp({ setup: () => () => vue.h(component, { modelValue: raw.value, editorKey: 'parent:2', pageId: 2, pagePublished: true, disabled: disabled.value, 'onUpdate:modelValue': value => { writes.push(value); raw.value = value; } }) });
  for (const name of [...elementNames, 'el-checkbox']) app.component(name, elementStub(name));
  app.directive('loading', {}); app.mount(tree);
  return { ...l, raw, disabled, writes, tree, get state() { return l.instances.get(editor).at(-1); }, unmount: () => app.unmount() };
}

test('two real parent v-model image receipts preserve both exact attachment capabilities', async () => {
  const value = block('activeParty'), r = parent([value]);
  try {
    await r.state.mediaSession.choose('/api/assets/7', ticket(7)); await tick();
    r.state.selectItem(1); await tick();
    await r.state.mediaSession.choose('/api/assets/8', ticket(8)); await tick();
    const saved = JSON.parse(r.raw.value)[0];
    assert.equal(saved.menuConfig.list[0].img, '/api/assets/7'); assert.equal(saved.menuConfig.list[1].img, '/api/assets/8');
    assert.equal(r.state.previews['/api/assets/7'], ticket(7)); assert.equal(r.state.previews['/api/assets/8'], ticket(8));
    assert.equal(r.writes.length, 2);
    const images = all(r.tree, n => n.tag === 'img').map(n => n.props.src);
    assert.ok(images.includes(ticket(7))); assert.ok(images.includes(ticket(8)));
  } finally { r.unmount(); }
});

for (const transition of ['actor', 'disabled', 'session-event', 'item']) test(`a parent-propagation image receipt cannot paint after ${transition}`, async () => {
  const r = parent([block('activeParty')]);
  try {
    const pending = r.state.mediaSession.choose('/api/assets/7', ticket(7));
    if (transition === 'actor') r.actor.token = 'changed-owner';
    if (transition === 'disabled') r.disabled.value = true;
    if (transition === 'session-event') r.window.dispatchEvent(new Event('admin-session-changed'));
    if (transition === 'item') r.state.selectItem(1);
    await pending; await tick();
    assert.deepEqual(r.state.previews, {});
    assert.equal(JSON.parse(r.raw.value)[0].menuConfig.list[0].img, '/api/assets/7');
  } finally { r.unmount(); }
});

function canvasHarness(value = block('hotspot'), extra = {}) {
  const l = loader(), props = vue.reactive({ block: value, previews: {}, selected: 0, disabled: false, editorKey: 'canvas:2', ...extra }), events = [], tree = node('root');
  const app = renderer.createApp({ setup: () => () => vue.h(l.load(canvas).default, { ...props, onSelect: index => { events.push(['select', index]); props.selected = index; }, onSize: size => events.push(['size', size]), onGeometry: (index, rectangle) => events.push(['geometry', index, clone(rectangle)]) }) });
  for (const name of elementNames) app.component(name, elementStub(name));
  app.mount(tree);
  const state = () => l.instances.get(canvas).at(-1);
  const captures = [];
  const surface = () => all(tree, n => n.tag === 'div' && String(n.props.class).split(' ').includes('canvas'))[0];
  const prepare = () => { const target = surface(); assert.ok(target); target.getBoundingClientRect = () => ({ left: 10, top: 20, width: 375, height: 187.5 }); target.setPointerCapture = id => captures.push(['set', id]); target.releasePointerCapture = id => captures.push(['release', id]); return target; };
  return { ...l, props, events, tree, captures, get state() { return state(); }, surface, prepare,
    image: () => all(tree, n => n.tag === 'img')[0],
    unmount: () => app.unmount() };
}
const dispatch = (target, name, event) => { const handler = Object.entries(target.props).find(([key]) => key.toLowerCase() === 'on' + name.toLowerCase())?.[1]; assert.equal(typeof handler, 'function', name); handler(event); };
const pointer = (x, y, id = 1) => ({ clientX: 10 + x / 2, clientY: 20 + y / 2, pointerId: id, button: 0, preventDefault() {}, stopPropagation() {} });
const load = (r, width = 600, height = 300) => dispatch(r.image(), 'load', { currentTarget: { naturalWidth: width, naturalHeight: height } });

test('native pointer draw waits for actual image dimensions and emits 750-design geometry without rewriting source', async () => {
  const value = block('hotspot'); value.picStyle.url = '/static/hot.png';
  const r = canvasHarness(value);
  try {
    const surface = r.prepare(); r.state.mode = 'draw';
    dispatch(surface, 'pointerdown', pointer(100, 100)); dispatch(surface, 'pointerup', pointer(300, 200));
    assert.equal(r.events.some(e => e[0] === 'geometry'), false);
    load(r); await tick();
    dispatch(surface, 'pointerdown', pointer(100, 100)); dispatch(surface, 'pointermove', pointer(300, 200)); dispatch(surface, 'pointerup', pointer(300, 200));
    assert.deepEqual(r.events.find(e => e[0] === 'geometry'), ['geometry', -1, { left: 100, top: 100, width: 200, height: 100 }]);
    assert.deepEqual(r.props.block, value); assert.deepEqual(r.captures, [['set', 1], ['release', 1]]);
  } finally { r.unmount(); }
});

test('reverse-direction pointer draw and foreign pointer IDs retain exact geometry ownership', async () => {
  const value = block('hotspot'); value.picStyle.url = '/static/hot.png';
  const r = canvasHarness(value);
  try {
    const surface = r.prepare(); load(r); await tick(); r.state.mode = 'draw';
    dispatch(surface, 'pointerdown', pointer(300, 200, 7)); dispatch(surface, 'pointermove', pointer(700, 350, 8)); dispatch(surface, 'pointerup', pointer(700, 350, 8));
    assert.equal(r.events.some(e => e[0] === 'geometry'), false);
    dispatch(surface, 'pointerup', pointer(100, 100, 7));
    assert.deepEqual(r.events.find(e => e[0] === 'geometry'), ['geometry', -1, { left: 100, top: 100, width: 200, height: 100 }]);
  } finally { r.unmount(); }
});

for (const transition of ['image', 'owner', 'disabled', 'unmount']) test(`stale hotspot image load/error callbacks cannot cross ${transition}`, async () => {
  const value = block('hotspot'); value.picStyle.url = '/static/old.png';
  const r = canvasHarness(value);
  let stopped = false;
  try {
    const oldLoad = r.image().props.onLoad, oldError = r.image().props.onError;
    if (transition === 'image') r.props.block = { ...value, picStyle: { ...value.picStyle, url: '/static/new.png' } };
    if (transition === 'owner') r.props.editorKey = 'new-owner';
    if (transition === 'disabled') r.props.disabled = true;
    if (transition === 'unmount') { r.unmount(); stopped = true; }
    await tick();
    const before = clone(r.events);
    oldLoad({ currentTarget: { naturalWidth: 600, naturalHeight: 900 } }); oldError();
    assert.deepEqual(r.events, before);
    assert.equal(r.state.size, null);
    if (!stopped && transition !== 'disabled') {
      load(r, 600, 300); await tick();
      const after = clone(r.events); oldError();
      assert.deepEqual(r.events, after); assert.deepEqual(r.state.size, { width: 600, height: 300 });
    }
  } finally { if (!stopped) r.unmount(); }
});

test('same-asset hotspot ticket renewal revokes old image measurements and preserves all imported regions', async () => {
  const value = block('hotspot'); value.picStyle = { url: '/api/assets/7', list: [{ number: '09', starX: ' 2e0 ', starY: 10, areaWidth: 40, areaHeight: 20, link: '/pages/article/list', unknown: [] }] };
  const r = canvasHarness(value, { previews: { '/api/assets/7': ticket(7) } });
  try {
    const oldLoad = r.image().props.onLoad; load(r); await tick();
    const renewed = ticket(7).replace('signature=', 'signature=B');
    r.props.previews = { '/api/assets/7': renewed }; await tick();
    assert.equal(r.state.size, null);
    const before = clone(r.events); oldLoad({ currentTarget: { naturalWidth: 600, naturalHeight: 800 } });
    assert.deepEqual(r.events, before); assert.deepEqual(r.props.block, value);
    load(r, 600, 300); await tick();
    assert.deepEqual(r.state.size, { width: 600, height: 300 }); assert.deepEqual(r.props.block, value);
  } finally { r.unmount(); }
});
