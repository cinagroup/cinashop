const { test, assert, vue, editorFile, utilFile, clone, tick, all, loader, mount } = require('./helpers/diy-navigation-runtime.cjs');
const { renderToString } = require('@vue/server-renderer');
const { ElInputNumber, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } = require('element-plus');

// The editor and its handlers are the actual compiled SFC. Its lightweight
// renderer exposes the control props without pretending to implement number
// normalization. Pass those exact props/events into the installed component's
// real SSR setup/immediate watch. No handwritten copy of its bounds algorithm.
// SSR does not execute client onMounted/blur/wheel/DOM hooks; the final hidden
// browser must also inspect these imports without interacting with the fields.
function harness(kind, prepare) {
  const l = loader(), util = l.load(utilFile), block = util.newNavigationBlock(kind, 10);
  prepare?.(block, util);
  block.authorExtra = { retain: ['zero', 0, null, {}] };
  const neighbor = { name: 'extension', timestamp: 20, payload: { preserve: true } };
  const props = vue.reactive({ modelValue: JSON.stringify([block, neighbor]), editorKey: 'installed-number:row2', disabled: false, pageId: 2, pagePublished: false });
  const writes = [];
  const mounted = mount(l, editorFile, props, (_name, value) => { writes.push(value); props.modelValue = value; });
  return { ...l, props, util, writes, get state() { return mounted.state; }, tree: mounted.tree,
    value: () => JSON.parse(props.modelValue), unmount: () => mounted.unmount() };
}
function numberControl(r, label) {
  const field = all(r.tree, n => n.props['data-element'] === 'el-form-item' && n.props['data-label'] === label)[0];
  assert.ok(field, `actual SFC form field: ${label}`);
  const input = all(field, n => n.props['data-element'] === 'el-input-number')[0];
  assert.ok(input, `actual SFC input-number: ${label}`);
  assert.equal(typeof input.props['onUpdate:modelValue'], 'function', 'actual parent event binding');
  return input;
}
async function installedControl(input, overrides = {}) {
  const updates = [], parentCalls = [], actualParent = input.props['onUpdate:modelValue'];
  const props = { ...input.props, ...overrides, 'onUpdate:modelValue': value => {
    updates.push(value); parentCalls.push(value); actualParent(value);
  } };
  delete props['data-element']; delete props['data-label']; delete props['data-title'];
  assert.equal(ElInputNumber.name, 'ElInputNumber', 'installed production component, not a stub');
  const app = vue.createSSRApp({ render: () => vue.h(ElInputNumber, props) });
  app.provide(ID_INJECTION_KEY, { prefix: 120, current: 0 });
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  const html = await renderToString(app);
  assert.match(html, /el-input-number/, 'actual installed component rendered');
  await tick();
  return { html, updates, parentCalls, props };
}
async function noNormalization(r, fields) {
  await tick();
  const raw = r.props.modelValue, before = r.value();
  assert.equal(r.writes.length, 0, 'opening actual editor did not materialize a field');
  for (const [label, expected] of fields) {
    const input = numberControl(r, label);
    assert.equal(typeof input.props.modelValue, 'number', `${label}: actual mounted component will receive a number, avoiding its separate onMounted string-coercion branch`);
    assert.equal(input.props.modelValue, expected, `${label}: control displays the original imported number grammar`);
    const run = await installedControl(input);
    assert.deepEqual(run.updates, [], `${label}: installed immediate watcher emitted no normalization`);
    assert.deepEqual(run.parentCalls, [], `${label}: no spurious call into actual parent handler`);
    assert.equal(r.props.modelValue, raw, `${label}: original JSON bytes unchanged`);
    assert.deepEqual(r.value(), before, `${label}: unknown fields and neighbor retained`);
    assert.equal(r.writes.length, 0, `${label}: no author commit`);
  }
}
function custom(geometry) {
  return harness('pictureCube', (b, u) => {
    u.setCubeLayout(b, 11);
    b.picStyle.docPicList = [{ img: '', link: '', doc: clone(geometry), unknown: 'keep-selected-rectangle' }];
    b.picStyle.picList[0] = { image: '', link: '', backup: 'keep-fixed-slot' };
  });
}
const geometryFields = [
  ['startX', '矩形左边距'], ['startY', '矩形上边距'], ['w', '矩形宽度'], ['h', '矩形高度'],
];

test('installed ElInputNumber really emits for the legacy .001 bound through the captured actual parent binding', async () => {
  const r = custom({ startX: 0, startY: 0, w: 0.0005, h: 93.75 });
  try {
    await tick();
    const input = numberControl(r, '矩形宽度'), before = r.value();
    assert.equal(input.props.modelValue, 0.0005);
    const run = await installedControl(input, { min: 0.001, max: 375 });
    assert.deepEqual(run.updates, [0.001], 'real installed immediate modelValue watcher exposes old regression');
    assert.deepEqual(run.parentCalls, [0.001], 'normalization reached the current actual SFC handler');
    // The current parent may independently refuse unsolicited normalization.
    // If it accepts, only its actual selected field may change; this negative
    // control never prescribes that the current parent must remain vulnerable.
    const after = r.value(), expected = clone(before);
    if (r.writes.length) { expected[0].picStyle.docPicList[0].doc.w = 0.001; assert.deepEqual(after, expected); }
    else assert.deepEqual(after, before);
  } finally { r.unmount(); }
});

const geometries = [
  ['positive sub-millipixel width', { startX: 0, startY: 0, w: 0.0005, h: 93.75 }],
  ['positive sub-millipixel height', { startX: 0.125, startY: 0.375, w: 93.625, h: 0.0005 }],
  ['whitespace numeric strings', { startX: ' 12.5 ', startY: ' 0.25 ', w: ' 93.75 ', h: ' 187.5 ' }],
  ['scientific fractional numeric strings', { startX: '1e1', startY: '2.5e-1', w: '9.375e1', h: '1.875e2' }],
  ['finite off-grid imported geometry', { startX: 0.125, startY: 0.375, w: 93.625, h: 187.25 }],
];
for (const [name, geometry] of geometries) test(`actual SFC plus installed number watcher preserves ${name} without author writes`, async () => {
  const r = custom(geometry);
  try {
    assert.ok(r.util.validCubeRectangle(geometry), 'fixture is genuinely accepted by current rectangle contract');
    await noNormalization(r, geometryFields.map(([key, label]) => [label, Number(geometry[key])]));
  } finally { r.unmount(); }
});

for (const duration of [0, 101]) test(`imported header numConfig ${duration} survives installed watcher while ordinary bounds remain an explicit edit policy`, async () => {
  const r = harness('headerSerch', b => { b.numConfig.val = duration; });
  try { await noNormalization(r, [['原作者显示时间（秒）', duration]]); }
  finally { r.unmount(); }
});

test('finite imported padding above ordinary and safe-integer bounds is displayed, preserved, and clamped only in public preview', async () => {
  const r = harness('menus', b => { b.topConfig.val = '1e30'; b.prConfig.val = ' 125.5 '; });
  try {
    await noNormalization(r, [['上内边距（设计 px）', 1e30], ['左右内边距（设计 px）', 125.5]]);
    assert.match(r.util.navigationPreview(r.value()[0]).wrapperStyle.padding, /^100px 100px /, 'consumer projection clamps without writing imports');
    assert.equal(r.value()[0].topConfig.val, '1e30'); assert.equal(r.value()[0].prConfig.val, ' 125.5 ');
  } finally { r.unmount(); }
});

for (const type of [true, ' true ', ' 1 ']) test(`consumer-valid separate radius ${JSON.stringify(type)} reaches all four real controls without normalization`, async () => {
  const r = harness('menus', b => { b.fillet.type = type; b.fillet.valList = [{ val: ' 1.25 ' }, { val: '2e0' }, { val: 3.5 }, { val: ' 4.75 ' }]; });
  try {
    await noNormalization(r, [['组件圆角左上（设计 px）', 1.25], ['组件圆角右上（设计 px）', 2], ['组件圆角右下（设计 px）', 4.75], ['组件圆角左下（设计 px）', 3.5]]);
    assert.equal(r.util.navigationPreview(r.value()[0]).panelStyle.borderRadius, '1.25px 2px 4.75px 3.5px');
    assert.equal(r.value()[0].fillet.type, type, 'imported separate flag spelling is not materialized to1');
  } finally { r.unmount(); }
});
