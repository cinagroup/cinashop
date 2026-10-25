const { test, assert, fs, path, root, vue, clone, loader, utilFile, projectionFile, defaults, kinds, block } = require('./helpers/diy-state-runtime.cjs');
const { createHash } = require('node:crypto');
const { runtime } = require('../../uniapp-ts/scripts/uni-store-runtime.cjs');
for (const kind of kinds) test(`complete ${kind} ordinary default equals every immutable Worker fixture field and returns independent objects`, () => {
  const u = loader().load(utilFile), expected = clone(defaults[kind]); expected.timestamp = 37;
  assert.deepEqual(u.newStateBlock(kind, 37), expected); assert.deepEqual(u.newStateBlock(kind, 0), defaults[kind]);
  const changed = u.newStateBlock(kind, 37); changed.fillet.valList[0].val = 9; changed.styleConfig.tabVal = 7;
  assert.deepEqual(u.newStateBlock(kind, 0), defaults[kind]);
  assert.equal(Object.keys(defaults[kind]).length, { userInfor: 22, newVip: 37, signIn: 22, ranking: 33 }[kind]);
  assert.equal(defaults[kind].styleConfig.tabVal, ['userInfor', 'newVip'].includes(kind) ? 1 : 0);
});
function candidate(kind, style, variant) {
  const b = block(kind); b.styleConfig.tabVal = style;
  if (variant !== 'ordinary') {
    for (const [key, field] of Object.entries(b)) {
      if (Array.isArray(field?.color)) field.color.forEach((item, index) => { item.item = index ? '#abcdef' : '#123456'; });
      if (key.startsWith('tone')) field.tabVal = 1;
    }
    b.checkboxInfo = { type: kind === 'userInfor' ? [0, 1, 2, 3, 4, 5, 101, '2', 2] : [0, 1, 2, 101, '2'] };
    b.titleConfig = { tabVal: 1 }; b.titleText = { tabVal: 2 }; b.titleTxtConfig = { value: '超过六字的导入榜单标题' }; b.rightBntConfig = { value: '超过六字的导入按钮' };
    b.logoConfig = { url: '/static/actual-avatar.png' }; b.imgConfig = { url: '/static/images/diy/ranking.png' };
    for (const key of ['topConfig', 'bottomConfig', 'prConfig', 'mbConfig', 'titleNumber', 'bntNumber', 'spacingConfig', 'spacingConfig2']) b[key] = { val: 12.5, dormant: true };
    for (const key of ['fillet', 'filletBg', 'filletImg']) b[key] = { type: 1, val: 7, valList: [1, 2, 3, 4].map(val => ({ val })) };
  }
  if (variant === 'imported') {
    b.styleConfig.tabVal = style ? '1e0' : ' 0 '; b.toneConfig = { tabVal: '01' }; b.toneCouponConfig = { tabVal: ' 0 ' }; b.toneGoodsConfig = { tabVal: '1e0' };
    for (const key of ['fillet', 'filletBg', 'filletImg']) { b[key].type = true; b[key].valList = [{ val: '5e-4' }, { val: ' 2.25 ' }, { val: '3e0' }, { val: 4.75 }]; }
    b.topConfig.val = '1e30'; b.prConfig.val = ' 125.5 '; b.titleNumber.val = 0; b.bntNumber.val = 101; b.spacingConfig.val = '0.0005';
  }
  return b;
}
for (const kind of kinds) for (const style of [0, 1]) for (const variant of ['ordinary', 'authored', 'imported']) test(`entire Admin ${kind} style${style} ${variant} projection equals independently installed actual Uni normalizer without rewriting imports`, () => {
  const l = loader(), projection = l.load(projectionFile), b = candidate(kind, style, variant), before = clone(b);
  const r = runtime({ component: 'components/diy/DiyStateWidget.vue', props: vue.reactive({ block: b, active: false }), platform: 'H5', send: () => { throw Error('Inactive independent projection must not fetch'); } });
  try {
    const actual = r.checkout.c.config.value, author = projection.normalizeDiyStateWidget(b, projection.statePreviewTheme);
    assert.deepEqual(author, actual); assert.deepEqual(b, before); assert.deepEqual(r.calls, []);
    assert.ok(Object.keys(author).length > 30); assert.equal(author.style, style); assert.equal(author.kind, kind);
  } finally { r.stop(); }
});
for (const kind of kinds) test(`${kind} Number-style enum and hidden/corner flag grammar stay identical to Uni without inventing a default count`, () => {
  const l = loader(), projection = l.load(projectionFile), b = block(kind), r = runtime({ component: 'components/diy/DiyStateWidget.vue', props: vue.reactive({ block: b, active: false }), platform: 'H5', send: () => { throw Error('No I/O'); } });
  try {
    const actual = r.load(path.resolve(root, '../../uniapp-ts/src/utils/diyStateWidget.ts'));
    for (const raw of [0, 1, 2, -1, '01', ' 1 ', '1e0', true, false, null, [], {}, 'bad']) {
      const value = block(kind); value.styleConfig.tabVal = raw; value.toneConfig.tabVal = raw; value.isHide = raw; value.fillet.type = raw;
      const before = clone(value); assert.deepEqual(projection.normalizeDiyStateWidget(value, projection.statePreviewTheme), actual.normalizeDiyStateWidget(value, projection.statePreviewTheme)); assert.deepEqual(value, before);
    }
    if (kind === 'signIn' || kind === 'ranking') assert.equal(Object.hasOwn(defaults[kind].styleConfig, 'count'), false);
    assert.equal(Object.hasOwn(defaults[kind], 'numberConfig'), false); assert.equal(Object.hasOwn(defaults[kind], 'numConfig'), false);
  } finally { r.stop(); }
});
test('both actual migrated ranking PNG files retain original2798bytes/SHA/IHDR102x32 and Admin51x16 versus Uni102x32rpx headers', () => {
  const files = [path.resolve(root, '../public/static/images/diy/ranking.png'), path.resolve(root, '../../uniapp-ts/src/static/images/diy/ranking.png')];
  const bytes = files.map(file => fs.readFileSync(file)); assert.deepEqual(bytes[0], bytes[1]); assert.equal(bytes[0].length, 2798);
  assert.equal(createHash('sha256').update(bytes[0]).digest('hex'), 'a755aa0a42b7028d5e9938d8b63fa66d2274ea83260ffe4616b5fcf2d2d62667'); assert.equal(bytes[0].readUInt32BE(16), 102); assert.equal(bytes[0].readUInt32BE(20), 32);
  assert.equal(defaults.ranking.imgConfig.url, '/static/images/diy/ranking.png');
  const admin = fs.readFileSync(path.join(root, 'components/content/DiyStatePreview.vue'), 'utf8'), uni = fs.readFileSync(path.resolve(root, '../../uniapp-ts/src/components/diy/DiyStateWidget.vue'), 'utf8');
  assert.match(admin, /\.rank-title-image\{width:51px;height:16px;/u); assert.match(uni, /\.diy-state-title-image\{width:102rpx;height:32rpx/u);
});
