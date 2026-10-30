const { test, assert, vue, clone, tick, all, kinds, labels, block, harness, controlNode } = require('./helpers/diy-state-runtime.cjs');
const { renderToString } = require('@vue/server-renderer');
const { ElInputNumber, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } = require('element-plus');
async function actualInput(props) { const app = vue.createSSRApp({ render: () => vue.h(ElInputNumber, props) }); app.provide(ID_INJECTION_KEY, { prefix: 124, current: 0 }); app.provide(ZINDEX_INJECTION_KEY, { current: 0 }); return renderToString(app); }
async function noNormalization(r, fields) {
  await tick(); const raw = r.props.modelValue, value = r.value(); assert.deepEqual(r.writes, []);
  for (const [label, expected] of fields) {
    const input = controlNode(r, label); assert.equal(input.props['data-element'], 'el-input-number'); assert.equal(input.props.modelValue, expected);
    const updates = [], handler = input.props['onUpdate:modelValue'], props = { ...input.props, 'onUpdate:modelValue': value => { updates.push(value); handler(value); } };
    for (const key of ['data-element', 'data-label', 'data-title']) delete props[key];
    assert.match(await actualInput(props), /el-input-number/u); await tick(); assert.deepEqual(updates, [], label); assert.equal(r.props.modelValue, raw); assert.deepEqual(r.value(), value); assert.deepEqual(r.writes, []);
  }
}
test('installed ElementPlus immediate normalization control proves a fixed minimum would emit and call the real parent update handler', async () => {
  const b = block('ranking'); b.titleNumber.val = 0.0005; const r = harness([b]); try { await tick(); const input = controlNode(r, '排行榜标题字号'), updates = [], handler = input.props['onUpdate:modelValue']; assert.equal(input.props.modelValue, 0.0005);
    await actualInput({ ...input.props, modelValue: 0.0005, min: 0.001, 'onUpdate:modelValue': value => { updates.push(value); handler(value); } }); await tick(); assert.deepEqual(updates, [0.001]); assert.equal(r.value()[0].titleNumber.val, 0.001); assert.equal(r.writes.length, 1);
  } finally { r.unmount(); }
});
for (const kind of kinds) test(`installed ${kind} tiny/exponent/whitespace/oversize lengths preserve raw JSON through the captured actual-SFC handlers`, async () => {
  const b = block(kind); b.topConfig.val = '1e30'; b.prConfig.val = ' 125.5 '; b.mbConfig.val = '5e-4'; b.bottomConfig.val = ' 2.25 '; const r = harness([b]);
  try { await noNormalization(r, [[labels[kind] + '上边距', 1e30], [labels[kind] + '左右边距', 125.5], [labels[kind] + '组件间距', 0.0005], [labels[kind] + '下边距', 2.25]]);
    const expected = r.value(); r.state.visible(false); await tick(); expected[0].isHide = true; assert.deepEqual(r.value(), expected);
  } finally { r.unmount(); }
});
for (const kind of kinds) test(`installed ${kind} true and string corner flags retain all four tiny/fractional imports in actual source corner order`, async () => {
  for (const flag of [true, ' true ', ' 1 ']) {
    const b = block(kind); b.fillet.type = flag; b.fillet.valList = [{ val: '0.0005' }, { val: ' 2.25 ' }, { val: '3e0' }, { val: 4.75 }];
    if (kind === 'ranking') for (const key of ['filletBg', 'filletImg']) { b[key].type = flag; b[key].valList = clone(b.fillet.valList); }
    const r = harness([b]); try { const fields = (kind === 'ranking' ? ['模块圆角', '榜单圆角（px）', '图片圆角'] : ['模块圆角']).flatMap(label => (['userInfor', 'signIn'].includes(kind) ? ['左上', '右上', '右下', '左下'] : ['左上', '右上', '左下', '右下']).map((corner, index) => [labels[kind] + label + corner, [0.0005, 2.25, 3, 4.75][index]]));
      await noNormalization(r, fields); assert.equal(r.value()[0].fillet.type, flag);
    } finally { r.unmount(); }
  }
});
for (const kind of kinds) test(`installed ${kind} zero101 and numeric-style imports neither invent counters nor normalize dormant data`, async () => {
  const b = block(kind); b.styleConfig.tabVal = '01'; b.topConfig.val = ' 0 '; b.bottomConfig.val = '1.01e2'; b.numConfig = { val: 0, imported: true }; b.numberConfig = { val: 101, imported: true };
  if (kind === 'ranking') { b.titleNumber.val = 0; b.bntNumber.val = 101; } if (kind === 'newVip') { b.spacingConfig.val = 0; b.spacingConfig2.val = 101; }
  const r = harness([b]); try { const extra = kind === 'ranking' ? [['排行榜标题字号', 0], ['排行榜更多字号', 101]] : kind === 'newVip' ? [['新人专区经典优惠券间距', 0], ['新人专区现代优惠券间距', 101]] : [];
    await noNormalization(r, [[labels[kind] + '上边距', 0], [labels[kind] + '下边距', 101], ...extra]); assert.equal(r.value()[0].styleConfig.tabVal, '01'); assert.equal(all(r.tree, node => String(node.props['data-label'] || '').includes('展示数量')).length, 0); assert.deepEqual(r.value()[0].numConfig, b.numConfig); assert.deepEqual(r.value()[0].numberConfig, b.numberConfig);
  } finally { r.unmount(); }
});
