const { test, assert, path, root, vue, loader, mount, tick, clone, ticket, all } = require('./helpers/diy-list-runtime.cjs');
const file = path.join(root, 'components/content/DiyHotspotEditorCanvas.vue'), util = path.join(root, 'utils/diyEditorialEditor.ts');
function harness(options = {}) {
  const l = loader(), row = l.load(util).newEditorialBlock('hotspot', 10); row.picStyle.url = '/static/test.png'; row.picStyle.list = [{ number: 1, starX: 100, starY: 80, areaWidth: 200, areaHeight: 100, nowImgWidth: 750, link: '/pages/cart/index' }];
  const props = vue.reactive({ block: row, previews: {}, selected: 0, disabled: false, editorKey: 'canvas:2', ...options }), events = [], component = l.load(file).default, base = require('./helpers/diy-list-runtime.cjs'), tree = base.node('root');
  const app = base.renderer.createApp({ setup: () => () => vue.h(component, { ...props, onSelect: value => { events.push(['select', value]); props.selected = value; }, onGeometry: (...args) => events.push(['geometry', ...args]), onSize: value => events.push(['size', value]) }) });
  for (const name of base.elementNames) app.component(name, base.elementStub(name)); app.mount(tree); const state = l.instances.get(file).at(-1), captures = [], releases = [];
  state.surface.getBoundingClientRect = () => ({ left: 20, top: 40, width: 375, height: 250 }); state.surface.setPointerCapture = id => captures.push(id); state.surface.releasePointerCapture = id => releases.push(id);
  let alive = true; return { ...l, tree, props, events, state, captures, releases, load: (width = 750, height = 500) => state.imageSession.load({ currentTarget: { naturalWidth: width, naturalHeight: height } }), unmount() { if (alive) { alive = false; app.unmount(); } } };
}
const event = (x, y, id = 1, button = 0) => ({ clientX: 20 + x / 2, clientY: 40 + y / 2, pointerId: id, button, preventDefault() {} });
const geometries = r => r.events.filter(e => e[0] === 'geometry');
test('actual canvas image load enables natural-size geometry and emits the precise matching reference', async () => {
  const r = harness(); try { assert.equal(r.state.size, null); assert.deepEqual(r.state.areas, []); r.state.beginMove(event(100, 80), 0, false); r.state.pointerEnd(event(120, 100)); assert.deepEqual(geometries(r), []); r.load(); await tick(); assert.deepEqual(r.events.at(-1), ['size', { width: 750, height: 500, reference: '/static/test.png' }]); assert.equal(r.state.designHeight, 500); assert.equal(r.state.areas[0].style.left, `${100 / 750 * 100}%`); }
  finally { r.unmount(); }
});
test('actual pointer handlers draw backwards in 750 design coordinates and ignore other pointers', async () => {
  const r = harness(); try { r.load(); r.state.mode = 'draw'; r.state.beginDraw(event(400, 300)); r.state.pointerMove(event(100, 100, 2)); assert.equal(r.state.draft.width, 0); r.state.pointerMove(event(100, 100)); r.state.pointerEnd(event(100, 100)); assert.deepEqual(geometries(r), [['geometry', -1, { left: 100, top: 100, width: 300, height: 200 }]]); assert.deepEqual(r.captures, [1]); assert.deepEqual(r.releases, [1]); assert.equal(r.state.draft, null); }
  finally { r.unmount(); }
});
test('actual move and resize clamp to loaded image boundaries without mutating imported data', async () => {
  const r = harness(), original = clone(r.props.block); try { r.load(); r.state.beginMove(event(150, 100), 0, false); r.state.pointerMove(event(900, 700)); r.state.pointerEnd(event(900, 700)); assert.deepEqual(geometries(r)[0], ['geometry', 0, { left: 550, top: 400, width: 200, height: 100 }]); r.state.beginMove(event(300, 180), 0, true); r.state.pointerEnd(event(900, 700)); assert.deepEqual(geometries(r)[1], ['geometry', 0, { left: 100, top: 80, width: 650, height: 420 }]); assert.deepEqual(r.props.block, original); }
  finally { r.unmount(); }
});
for (const boundary of ['image', 'editor', 'disabled', 'block', 'hidden', 'selection', 'cancel', 'capture', 'unmount']) test(`pending pointer gesture cannot cross ${boundary}`, async () => {
  const r = harness(); try { r.load(); r.state.beginMove(event(100, 80), 0, false); assert.ok(r.state.draft);
    if (boundary === 'image') r.props.block.picStyle.url = '/static/other.png'; if (boundary === 'editor') r.props.editorKey = 'new'; if (boundary === 'disabled') r.props.disabled = true;
    if (boundary === 'block') r.props.block = clone(r.props.block); if (boundary === 'block') r.props.block.timestamp = 20;
    if (boundary === 'hidden') r.props.block.isHide = true; if (boundary === 'selection') r.props.selected = 1; if (boundary === 'cancel') r.state.cancel();
    if (boundary === 'capture') all(r.tree, n => n.props.onLostpointercapture)[0].props.onLostpointercapture(); if (boundary === 'unmount') r.unmount();
    await tick(); r.state.pointerEnd(event(180, 160)); assert.deepEqual(geometries(r), []); assert.equal(r.state.draft, null);
  } finally { r.unmount(); }
});
for (const boundary of ['image', 'editor', 'disabled', 'unmount']) test(`old native image load/error callbacks cannot cross ${boundary}`, async () => {
  const r = harness(), old = r.state.imageSession; try { if (boundary === 'image') r.props.block.picStyle.url = '/static/replacement.png'; if (boundary === 'editor') r.props.editorKey = 'other'; if (boundary === 'disabled') r.props.disabled = true; if (boundary === 'unmount') r.unmount(); await tick(); old.load({ currentTarget: { naturalWidth: 750, naturalHeight: 500 } }); old.error(); assert.equal(r.state.size, null); assert.equal(r.state.imageState, 'loading'); assert.ok(!r.events.some(e => e[0] === 'size' && e[1])); }
  finally { r.unmount(); }
});
for (const [width, height] of [[0, 500], [750, 0], [NaN, 500], [750, Infinity], [undefined, undefined]]) test(`invalid native image size ${width}x${height} cannot authorize editing`, () => {
  const r = harness(); try { r.state.imageSession.load({ currentTarget: { naturalWidth: width, naturalHeight: height } }); assert.equal(r.state.size, null); assert.equal(r.state.imageState, 'error'); r.state.beginMove(event(100, 80), 0, false); r.state.pointerEnd(event(200, 200)); assert.deepEqual(geometries(r), []); } finally { r.unmount(); }
});
test('selected imported overflow region is visible without discarding others or permitting ordinary additions over 30', async () => {
  const r = harness({ selected: 31 }); try { r.props.block.picStyle.list = Array.from({ length: 32 }, (_, i) => ({ starX: 10 + i, starY: 20, areaWidth: 100, areaHeight: 100, link: '/pages/cart/index' })); r.load(); await tick(); assert.equal(r.state.areas.length, 31); assert.ok(r.state.areas.some(a => a.index === 31)); r.state.mode = 'draw'; r.state.beginDraw(event(100, 100)); r.state.pointerEnd(event(200, 200)); assert.deepEqual(geometries(r), []); assert.equal(r.props.block.picStyle.list.length, 32); }
  finally { r.unmount(); }
});
test('zero-area, secondary-button, outside image, and missing signed preview cannot create geometry', () => {
  const r = harness(); try { r.load(); r.state.mode = 'draw'; r.state.beginDraw(event(50, 50)); r.state.pointerEnd(event(50, 50)); r.state.beginDraw(event(50, 50, 1, 2)); r.state.pointerEnd(event(200, 200)); assert.deepEqual(geometries(r), []); } finally { r.unmount(); }
  const locked = harness(); try { locked.props.block.picStyle.url = '/api/assets/17'; assert.equal(locked.state.image, ''); locked.props.previews['/api/assets/17'] = ticket(18); assert.equal(locked.state.image, ''); locked.props.previews['/api/assets/17'] = ticket(17); assert.equal(locked.state.image, ticket(17)); } finally { locked.unmount(); }
});
