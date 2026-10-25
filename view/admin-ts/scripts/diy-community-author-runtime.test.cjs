const base = require('./helpers/diy-navigation-runtime.cjs');
const { createHash } = require('node:crypto');
const { renderToString } = require('@vue/server-renderer');
const { ElInputNumber, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } = require('element-plus');
const { test, assert, fs, path, root, vue, renderer, node, all, elementNames, elementStub, tick } = base;
const utilFile = path.join(root, 'utils/diyCommunityEditor.ts');
const fieldFile = path.join(root, 'components/content/DiyCommunityFields.vue');
const controlFile = path.join(root, 'utils/diyCommunityControls.ts');
const clone = value => JSON.parse(JSON.stringify(value));
// Independent original PHP8ed2a5b source fixtures, not imports of the producer.
// home_community.vue SHA748f9410bee33dc16f2e59e5a7a7bd4cc67e6f9434d9af789dfcb03d44f97bcc
// c_community.vue SHA6e4250dc590e71a4d0d4137a7924406fca8b3af5791bcfe560cffeef8b5174b6
// Only original this.num ->0 and original require ->same-byte static PNG are substituted.
const phpDefaults = {"cname":"种草社区","name":"community","timestamp":0,"isHide":false,"setUp":{"tabVal":0},"titleLeft":"内容设置","titleHead":"头部设置","titleContent":"内容展示","titleRight":"头部样式","titleVideoStyle":"内容样式","titleCurrency":"通用样式","styleConfig":{"title":"选择风格","tabVal":0,"tabList":[{"name":"左右滑动展示"},{"name":"两列展示（纵向）"}]},"titleConfig":{"title":"标题类型","tabVal":0,"tabList":[{"name":"图片"},{"name":"文字"}]},"imgConfig":{"info":"建议：128px * 32px","url":"/static/images/diy/community.png","type":"code","delType":0,"name":"上传图片"},"titleTxtConfig":{"title":"标题文字","value":"种草社区","place":"请输入标题文字","max":6},"rightBntConfig":{"title":"右侧文字","value":"好物分享","place":"请输入右侧文字","max":6},"numberConfig":{"title":"内容数量","val":3,"min":1},"selectConfig":{"title":"内容话题","activeValue":"","list":[{"activeValue":"","title":""},{"activeValue":"","title":""}]},"headerBgColor":{"title":"背景颜色","name":"headerBgColor","default":[{"item":"#E93323"},{"item":"#FF7931"}],"color":[{"item":"#E93323"},{"item":"#FF7931"}]},"titleText":{"title":"标题文字","tabVal":0,"tabList":[{"name":"加粗","style":"bold"},{"name":"正常","style":"normal"},{"name":"倾斜","style":"italic"}]},"titleColor":{"title":"标题颜色","name":"titleColor","default":[{"item":"#fff"}],"color":[{"item":"#fff"}]},"titleNumber":{"title":"标题字号","val":16,"min":0},"headerBntColor":{"title":"按钮文字","name":"headerBntColor","default":[{"item":"#fff"}],"color":[{"item":"#fff"}]},"bntNumber":{"title":"按钮大小","val":12,"min":0},"videoSpace":{"title":"内容间距","val":20,"min":0},"videoSpace2":{"title":"内容间距","val":10,"min":0},"filletImg":{"title":"内容圆角","type":0,"list":[{"val":"全部","icon":"iconcaozuo-zhengti"},{"val":"单个","icon":"iconcaozuo-bianjiao"}],"valName":"圆角值","val":8,"min":0,"valList":[{"val":0},{"val":0},{"val":0},{"val":0}]},"toneConfig":{"title":"色调","tabVal":0,"tabList":[{"name":"跟随主题风格"},{"name":"自定义"}]},"likeSuccessColor":{"title":"点赞成功","default":[{"item":"#E93323"}],"color":[{"item":"#E93323"}]},"moduleColor":{"title":"组件背景","default":[{"item":"#fff"},{"item":"#fff"}],"color":[{"item":"#fff"},{"item":"#fff"}]},"bottomBgColor":{"title":"底部背景","default":[{"item":"#f5f5f5"}],"color":[{"item":"#f5f5f5"}]},"topConfig":{"title":"上边距","val":0,"min":0},"bottomConfig":{"title":"下边距","val":0,"min":0},"prConfig":{"title":"左右边距","val":10,"min":0},"mbConfig":{"title":"页面上间距","val":0,"min":0},"fillet":{"title":"背景圆角","type":0,"list":[{"val":"全部","icon":"iconcaozuo-zhengti"},{"val":"单个","icon":"iconcaozuo-bianjiao"}],"valName":"圆角值","val":8,"min":0,"valList":[{"val":0},{"val":0},{"val":0},{"val":0}]}};
const phpCases = [{"panel":0,"when":{"styleConfig.tabVal":0,"titleConfig.tabVal":0},"controls":["setUp","titleLeft","styleConfig","titleHead","titleConfig","imgConfig","rightBntConfig","titleContent","numberConfig"]},{"panel":0,"when":{"styleConfig.tabVal":0,"titleConfig.tabVal":1},"controls":["setUp","titleLeft","styleConfig","titleHead","titleConfig","titleTxtConfig","rightBntConfig","titleContent","numberConfig"]},{"panel":0,"when":{"styleConfig.tabVal":1,"titleConfig.tabVal":0},"controls":["setUp","titleLeft","styleConfig","titleHead","titleConfig","imgConfig","rightBntConfig","titleContent","numberConfig","selectConfig"]},{"panel":0,"when":{"styleConfig.tabVal":1,"titleConfig.tabVal":1},"controls":["setUp","titleLeft","styleConfig","titleHead","titleConfig","titleTxtConfig","rightBntConfig","titleContent","numberConfig","selectConfig"]},{"panel":1,"when":{"styleConfig.tabVal":0,"titleConfig.tabVal":0,"toneConfig.tabVal":0},"controls":["setUp","titleRight","headerBgColor","headerBntColor","bntNumber","titleVideoStyle","videoSpace2","filletImg","titleCurrency","moduleColor","bottomBgColor","topConfig","bottomConfig","prConfig","mbConfig","fillet"]},{"panel":1,"when":{"styleConfig.tabVal":0,"titleConfig.tabVal":0,"toneConfig.tabVal":1},"controls":["setUp","titleRight","headerBgColor","headerBntColor","bntNumber","titleVideoStyle","videoSpace2","filletImg","titleCurrency","moduleColor","bottomBgColor","topConfig","bottomConfig","prConfig","mbConfig","fillet"]},{"panel":1,"when":{"styleConfig.tabVal":0,"titleConfig.tabVal":1,"toneConfig.tabVal":0},"controls":["setUp","titleRight","headerBgColor","titleText","titleColor","titleNumber","headerBntColor","bntNumber","titleVideoStyle","videoSpace2","filletImg","titleCurrency","moduleColor","bottomBgColor","topConfig","bottomConfig","prConfig","mbConfig","fillet"]},{"panel":1,"when":{"styleConfig.tabVal":0,"titleConfig.tabVal":1,"toneConfig.tabVal":1},"controls":["setUp","titleRight","headerBgColor","titleText","titleColor","titleNumber","headerBntColor","bntNumber","titleVideoStyle","videoSpace2","filletImg","titleCurrency","moduleColor","bottomBgColor","topConfig","bottomConfig","prConfig","mbConfig","fillet"]},{"panel":1,"when":{"styleConfig.tabVal":1,"titleConfig.tabVal":0,"toneConfig.tabVal":0},"controls":["setUp","titleRight","headerBgColor","headerBntColor","bntNumber","titleVideoStyle","videoSpace","filletImg","toneConfig","titleCurrency","moduleColor","bottomBgColor","topConfig","bottomConfig","prConfig","mbConfig","fillet"]},{"panel":1,"when":{"styleConfig.tabVal":1,"titleConfig.tabVal":0,"toneConfig.tabVal":1},"controls":["setUp","titleRight","headerBgColor","headerBntColor","bntNumber","titleVideoStyle","videoSpace","filletImg","toneConfig","likeSuccessColor","titleCurrency","moduleColor","bottomBgColor","topConfig","bottomConfig","prConfig","mbConfig","fillet"]},{"panel":1,"when":{"styleConfig.tabVal":1,"titleConfig.tabVal":1,"toneConfig.tabVal":0},"controls":["setUp","titleRight","headerBgColor","titleText","titleColor","titleNumber","headerBntColor","bntNumber","titleVideoStyle","videoSpace","filletImg","toneConfig","titleCurrency","moduleColor","bottomBgColor","topConfig","bottomConfig","prConfig","mbConfig","fillet"]},{"panel":1,"when":{"styleConfig.tabVal":1,"titleConfig.tabVal":1,"toneConfig.tabVal":1},"controls":["setUp","titleRight","headerBgColor","titleText","titleColor","titleNumber","headerBntColor","bntNumber","titleVideoStyle","videoSpace","filletImg","toneConfig","likeSuccessColor","titleCurrency","moduleColor","bottomBgColor","topConfig","bottomConfig","prConfig","mbConfig","fillet"]}];
function util() { return base.loader().load(utilFile); }
function block() { return { ...clone(phpDefaults), timestamp: 10 }; }
function fieldHarness(value, options = {}) {
  const l = base.loader(), props = vue.reactive({ block: value }), events = [], slots = [];
  const tree = node('root'), component = l.load(fieldFile).default;
  const app = renderer.createApp({ setup: () => () => vue.h(component, {
    block: props.block, onChange: (path, value) => events.push({ path: clone(path), value }),
  }, options.noSlots ? {} : Object.fromEntries(['image', 'topic'].map(name => [name, scope => {
    slots.push({ name, key: scope.field.key, path: clone(scope.path) });
    return vue.h('span', { 'data-slot': name }, name);
  }]))) });
  for (const name of elementNames) app.component(name, elementStub(name));
  app.mount(tree);
  return { ...l, props, tree, events, slots, unmount: () => app.unmount() };
}
function control(r, key, ordinal = 0) {
  const field = all(r.tree, value => value.props['data-community-field'] === key)[0];
  assert.ok(field, key);
  const value = all(field, value => ['el-input', 'el-input-number', 'el-select', 'el-color-picker'].includes(value.props['data-element']))[ordinal];
  assert.ok(value, key + ' input'); return value;
}
function setupCase(value) {
  const b = block(); b.setUp.tabVal = value.panel;
  for (const [name, v] of Object.entries(value.when)) { const [owner, key] = name.split('.'); b[owner][key] = v; }
  return b;
}

test('constructor binds every original36 default key and clones complete metadata independently', () => {
  const u = util(), value = u.newCommunityBlock('community', 0);
  assert.deepEqual(value, phpDefaults); assert.equal(Object.keys(value).length, 36);
  assert.deepEqual(u.COMMUNITY_NAMES, ['community']); assert.deepEqual(u.communityLabels, { community: '种草社区' });
  assert.equal(u.communityKind('community'), 'community'); for (const other of ['Community', 'follow', '', null]) assert.equal(u.communityKind(other), null);
  value.imgConfig.url = 'changed'; value.selectConfig.list[0].title = 'changed';
  assert.deepEqual(u.newCommunityBlock('community', 0), phpDefaults);
  assert.throws(() => u.newCommunityBlock('follow', 0)); assert.throws(() => u.newCommunityBlock('community', Infinity));
});
test('both header PNGs are the exact128x32 original PHP bytes', () => {
  for (const file of [path.resolve(root, '../public/static/images/diy/community.png'), path.resolve(root, '../../uniapp-ts/src/static/images/diy/community.png')]) {
    const bytes = fs.readFileSync(file); assert.equal(bytes.length, 1886);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), '48785691c5387e98d65dc662913a3fdd3d146db9152b042d51f1f2647c8d8b4c');
    assert.equal(bytes.readUInt32BE(16), 128); assert.equal(bytes.readUInt32BE(20), 32);
  }
});
for (const [index, expected] of phpCases.entries()) test('PHP conditional panel' + index + ' renders exactly its ordered controls through the actual compiled SFC', async () => {
  const b = setupCase(expected), before = clone(b), r = fieldHarness(b);
  try {
    await tick(); const u = r.load(utilFile), controls = r.load(controlFile).communityControlKeys(b);
    assert.deepEqual(controls, expected.controls);
    assert.deepEqual(u.communityFields(b).map(field => field.key), expected.controls.filter(key => key !== 'setUp'));
    assert.deepEqual(all(r.tree, value => value.props['data-community-field']).map(value => value.props['data-community-field']), expected.controls.filter(key => key !== 'setUp'));
    assert.equal(r.slots.some(value => value.name === 'image'), expected.controls.includes('imgConfig'));
    assert.equal(r.slots.some(value => value.name === 'topic'), expected.controls.includes('selectConfig'));
    assert.deepEqual(r.events, []); assert.deepEqual(r.calls, []); assert.deepEqual(b, before);
  } finally { r.unmount(); }
});
test('document reader preserves sparse imports and opaque neighbors without adding any defaults', () => {
  const u = util(), sparse = { name: 'community', timestamp: ' 9 ', opaque: { keep: [null, false, [], {}] } }, other = { name: 'follow', imgConfig: { url: '/api/assets/9?keep' } };
  const value = [other, 0, null, sparse, { name: 'community', timestamp: 2 }];
  assert.deepEqual(u.communityDocument(JSON.stringify(value)), value);
  assert.deepEqual(u.communityEntries(value), [{ index: 4, kind: 'community' }, { index: 3, kind: 'community' }]);
  assert.equal(u.communityRecord([]), null); assert.equal(u.communityRead(sparse, ['missing', 'value']), undefined);
  for (const raw of ['null', '{}', '[]oops', '[{"__proto__":{}}]']) assert.throws(() => u.communityDocument(raw));
});
test('add and duplicate retain overflow topic lists and dormant unknown metadata before the exact footer', () => {
  const u = util(), b = block(); b.selectConfig.list = Array.from({ length: 130 }, (_, i) => ({ title: '导入' + i, activeValue: String(i + 1), unknown: { i } }));
  b.rightBntConfig.value = '完整保留的导入超长文字'; b.unknown = { keep: ['x', [], false] };
  const value = [{ name: 'headerSerch', timestamp: 0 }, b, { name: 'opaque', keep: [] }, { name: 'PageFoot', menuList: [{ keep: true }] }], before = clone(value);
  const copied = u.addCommunityBlock(value, 'community', b), expected = clone(value); expected.splice(3, 0, { ...clone(b), timestamp: 11 });
  assert.deepEqual(copied, { value: expected, selected: 3 }); assert.deepEqual(value, before);
  const added = u.addCommunityBlock(value, 'community'); assert.equal(Object.keys(added.value[3]).length, 36); assert.equal(added.value[3].timestamp, 11);
  copied.value[3].unknown.keep.push('new'); assert.deepEqual(value, before);
  assert.throws(() => u.addCommunityBlock(value, 'community', { name: 'follow' }));
  assert.throws(() => u.addCommunityBlock([{ name: 'community', timestamp: Number.MAX_SAFE_INTEGER }], 'community'));
});
test('move crosses real body neighbors but changes only swapped positions and timestamp ownership', () => {
  const u = util(), b = block(), other = { name: 'news', timestamp: 20, extra: { untouched: [] } }, value = [{ name: 'headerSerch', timestamp: 0 }, b, { name: 'opaque', timestamp: 19 }, other], before = clone(value);
  const moved = u.moveCommunityBlock(value, 1, 1), expected = clone(value);
  expected[1].timestamp = 20; expected[3].timestamp = 10; [expected[1], expected[3]] = [expected[3], expected[1]];
  assert.deepEqual(moved, { value: expected, selected: 3 }); assert.deepEqual(value, before);
  assert.throws(() => u.moveCommunityBlock(value, 1, -1)); assert.throws(() => u.moveCommunityBlock(value, 1, 0));
  assert.throws(() => u.moveCommunityBlock([b, { name: 'news', timestamp: 10 }], 0, 1));
});
test('canonical block changes only the exact header image including published mode, never API rows or topic metadata', () => {
  const u = util(), b = block(); b.imgConfig.url = ' &#47;api&#x2f;assets/7?expires=1&amp;signature=old ';
  b.selectConfig.list = [{ title: '/api/assets/9?keep', activeValue: '4', image: '/api/assets/10?keep' }];
  b.items = [{ image: '/api/assets/11?keep', author_image: '/api/assets/12?keep', sliderImage: ['/api/assets/13?keep'] }]; b.imgConfig.extra = '/api/assets/14?keep';
  const expected = clone(b); expected.imgConfig.url = '/api/assets/7';
  assert.deepEqual(u.communityMediaPaths(b), [['imgConfig', 'url']]); assert.deepEqual(u.communityMediaPaths({ name: 'follow', imgConfig: b.imgConfig }), []);
  assert.deepEqual(u.canonicalCommunityBlock(b), expected); assert.deepEqual(u.canonicalCommunityBlock(b, true), expected); assert.notDeepEqual(b, expected);
  assert.deepEqual(u.canonicalCommunityBlock({ name: 'community', imgConfig: { url: false } }), { name: 'community', imgConfig: { url: false } });
});
test('canonical value preserves all other families and non-array JSON without inventing a community block', () => {
  const u = util(), b = { name: 'community', imgConfig: { url: '/api/assets/7?old' }, opaque: [0, false, []] }, other = { name: 'follow', imgConfig: { url: '/api/assets/8?keep' } };
  assert.deepEqual(JSON.parse(u.canonicalCommunityValue(JSON.stringify([b, other]))), [{ ...b, imgConfig: { url: '/api/assets/7' } }, other]);
  assert.equal(u.canonicalCommunityValue('{"imgConfig":{"url":"/api/assets/9?keep"}}'), '{"imgConfig":{"url":"/api/assets/9?keep"}}');
  assert.throws(() => u.canonicalCommunityValue('null')); assert.throws(() => u.canonicalCommunityValue('['));
});
test('ordinary image identity and preview reuse the actual existing decoder and expiring lease grammar', () => {
  const u = util(), now = Math.floor(Date.now() / 1000), ticket = id => `/api/assets/${id}?expires=${now + 900}&signature=${'A'.repeat(43)}`;
  assert.equal(u.communityImageIdentity('&#47;api/assets/7?old'), '/api/assets/7');
  assert.equal(u.communityImageIdentity('/api/assets/0007?old'), '/api/assets/0007?old');
  assert.equal(u.communityPreviewUrl('/static/images/diy/community.png'), '/static/images/diy/community.png');
  assert.equal(u.communityPreviewUrl('/api/assets/7', ticket(7)), ticket(7)); assert.equal(u.communityPreviewUrl('/api/assets/7', ticket(8)), '');
  assert.equal(u.communityPreviewUrl('/api/assets/7', `/api/assets/7?expires=1&signature=${'A'.repeat(43)}`), '');
});
test('explicit field edits touch only one accepted leaf and never merge defaults into sparse imports', () => {
  const u = util(), sparse = { name: 'community', styleConfig: { tabVal: 1, keep: true }, titleConfig: { tabVal: 1 }, titleTxtConfig: { value: '旧标题', unknown: [] }, opaque: { keep: false } }, before = clone(sparse);
  assert.equal(u.communityFieldPatch(sparse, ['titleTxtConfig', 'value'], '新标题'), true);
  const expected = clone(before); expected.titleTxtConfig.value = '新标题'; assert.deepEqual(sparse, expected);
  assert.equal(u.communityFieldPatch(sparse, ['selectConfig', 'activeValue'], '9'), true); expected.selectConfig = { activeValue: '9' }; assert.deepEqual(sparse, expected);
});
for (const [pathKeys, raw, next] of [
  [['numberConfig','val'], ' 3e0 ', 3], [['numberConfig','val'], '1e30', 1e30], [['numberConfig','val'], '1.25', 1.25],
  [['styleConfig','tabVal'], ' 1e0 ', 1], [['titleConfig','tabVal'], true, 1], [['setUp','tabVal'], ' 1e0 ', 1],
  [['titleNumber','val'], '-2', -2], [['titleNumber','val'], '5e-4', 0.0005], [['fillet','type'], ' true ', 1],
  [['fillet','val'], '1e30', 1e30], [['fillet','valList',2,'val'], ' 0.25 ', 0.25], [['isHide'], ' true ', true],
]) test('same-effective imported value is a byte-preserving no-op at ' + pathKeys.join('.') + ':' + raw, () => {
  const u = util(), b = block(); b.setUp.tabVal = ['numberConfig','styleConfig','titleConfig'].includes(pathKeys[0]) ? 0 : 1; b.titleConfig.tabVal = 1;
  let owner = b; for (const key of pathKeys.slice(0, -1)) owner = owner[key]; owner[pathKeys.at(-1)] = raw;
  const before = clone(b); assert.equal(u.communityFieldPatch(b, pathKeys, next), false); assert.deepEqual(b, before);
});
test('long imported text can be retained and shortened without changing max or dormant metadata', () => {
  const u = util(), b = block(); b.titleConfig.tabVal = 1; b.titleTxtConfig.value = '保留导入长标题和全部元数据'; b.titleTxtConfig.max = 999;
  const before = clone(b); assert.equal(u.communityFieldPatch(b, ['titleTxtConfig','value'], b.titleTxtConfig.value), false); assert.deepEqual(b, before);
  assert.equal(u.communityFieldPatch(b, ['titleTxtConfig','value'], '稍短的导入长标题'), true); assert.equal(b.titleTxtConfig.max, 999);
  const ordinary = block(); ordinary.titleConfig.tabVal = 1; assert.throws(() => u.communityFieldPatch(ordinary, ['titleTxtConfig','value'], '一二三四五六七'));
});
for (const [pathKeys, value] of [
  [['numberConfig','val'],0], [['numberConfig','val'],1.5], [['numberConfig','val'],101], [['numberConfig','val'],Infinity],
  [['titleTxtConfig','value'],'bad\ntext'], [['styleConfig','tabVal'],2], [['titleColor','color',1,'item'],'#123456'],
  [['titleColor','color',0,'item'],'url(javascript:x)'], [['fillet','valList',4,'val'],3], [['fillet','val'],101],
  [['imgConfig','url'],'/api/assets/7'], [['selectConfig','list'],[]], [['selectConfig','activeValue'],'01'],
  [['selectConfig','activeValue'],'2147483648'], [['__proto__','polluted'],true], [['unknown','value'],1],
]) test('invalid or non-authorized leaf rejects atomically: ' + pathKeys.join('.') + ':' + value, () => {
  const u = util(), b = block(); b.styleConfig.tabVal = 1; b.titleConfig.tabVal = 1;
  // Choose the exact panel where the candidate field would otherwise be visible.
  if (['titleColor','fillet'].includes(pathKeys[0])) b.setUp.tabVal = 1;
  const before = clone(b); assert.throws(() => u.communityFieldPatch(b, pathKeys, value)); assert.deepEqual(b, before); assert.equal({}.polluted, undefined);
});
test('dormant fields and malformed ancestors cannot be silently repaired by unrelated edits', () => {
  const u = util(), b = block(), before = clone(b);
  for (const [pathKeys, value] of [[['titleTxtConfig','value'],'隐藏'], [['selectConfig','activeValue'],'9'], [['likeSuccessColor','color',0,'item'],'#000']]) assert.throws(() => u.communityFieldPatch(b, pathKeys, value));
  assert.deepEqual(b, before); b.titleConfig.tabVal = 1; b.titleTxtConfig = 7; const malformed = clone(b);
  assert.throws(() => u.communityFieldPatch(b, ['titleTxtConfig','value'], '修复')); assert.deepEqual(b, malformed);
});
test('explicit topic choices keep complete imported options and do not gain a filter or media path', () => {
  const u = util(), b = block(); b.styleConfig.tabVal = 1; b.selectConfig.list = Array.from({length:130}, (_, i) => ({ activeValue: String(i + 1), title: '旧' + i, unknown: '/api/assets/9?keep' }));
  const before = clone(b); u.communityFieldPatch(b, ['selectConfig','activeValue'], '999'); const expected = clone(before); expected.selectConfig.activeValue = '999';
  assert.deepEqual(b, expected); assert.deepEqual(u.communityMediaPaths(b), [['imgConfig','url']]); u.communityFieldPatch(b, ['selectConfig','activeValue'], ''); assert.deepEqual(b, before);
});
test('actual SFC image/topic slots receive only their exact parent-owned field paths without requests or writes', async () => {
  const b = block(); b.styleConfig.tabVal = 1; const before = clone(b), r = fieldHarness(b);
  try { await tick(); assert.deepEqual(r.slots, [{name:'image',key:'imgConfig',path:['imgConfig','url']},{name:'topic',key:'selectConfig',path:['selectConfig','activeValue']}]); assert.deepEqual(r.events, []); assert.deepEqual(r.calls, []); assert.deepEqual(b, before); }
  finally { r.unmount(); }
});
test('actual SFC emits typed enum/text/topic leaf paths and leaves the imported block unchanged', async () => {
  const b = block(); b.styleConfig.tabVal = 1; b.titleConfig.tabVal = 1; const before = clone(b), r = fieldHarness(b, { noSlots:true });
  try {
    await tick(); control(r,'styleConfig').props['onUpdate:modelValue'](0); control(r,'titleTxtConfig').props['onUpdate:modelValue']('新标题'); control(r,'selectConfig').props['onUpdate:modelValue']('9');
    assert.deepEqual(r.events, [{path:['styleConfig','tabVal'],value:0},{path:['titleTxtConfig','value'],value:'新标题'},{path:['selectConfig','activeValue'],value:'9'}]); assert.deepEqual(b,before);
  } finally { r.unmount(); }
});
test('actual SFC styles emit the selected gradient stop and exact independent corner index', async () => {
  const b = block(); b.setUp.tabVal = 1; b.fillet.type = 1; const before = clone(b), r = fieldHarness(b);
  try {
    await tick(); control(r,'headerBgColor',2).props['onUpdate:modelValue']('#123456'); control(r,'fillet',3).props['onUpdate:modelValue'](7);
    assert.deepEqual(r.events, [{path:['headerBgColor','color',1,'item'],value:'#123456'},{path:['fillet','valList',2,'val'],value:7}]); assert.deepEqual(b,before);
  } finally { r.unmount(); }
});
async function actualNumber(props) {
  const app = vue.createSSRApp({ render: () => vue.h(ElInputNumber, props) });
  app.provide(ID_INJECTION_KEY, {prefix:171,current:0}); app.provide(ZINDEX_INJECTION_KEY,{current:0}); return renderToString(app);
}
test('installed Element numeric inputs never clamp or rewrite imported exponent/negative/over-range values during mount', async () => {
  const b = block(); b.setUp.tabVal = 1; b.titleConfig.tabVal = 1; b.titleNumber.val = '-2'; b.bntNumber.val = '1e30'; b.fillet.val = '5e-4'; const before = clone(b), r = fieldHarness(b);
  try {
    await tick();
    for (const key of ['titleNumber','bntNumber','fillet']) {
      const input = control(r,key,key==='fillet'?1:0), updates = [], props = {...input.props,'onUpdate:modelValue':value=>{updates.push(value);input.props['onUpdate:modelValue'](value);}};
      for (const name of ['data-element','data-label','data-title']) delete props[name]; await actualNumber(props); assert.deepEqual(updates, [], key);
    }
    assert.deepEqual(r.events, []); assert.deepEqual(b,before);
  } finally { r.unmount(); }
});
test('sparse actual SFC remains read-only while showing default projections without filling missing config', async () => {
  const b = {name:'community',styleConfig:{tabVal:1},titleConfig:{tabVal:1},opaque:{keep:[false,[]]}}, before = clone(b), r = fieldHarness(b);
  try { await tick(); assert.deepEqual(r.events, []); assert.deepEqual(b,before); r.props.block = {...b,setUp:{tabVal:1}}; await tick(); assert.deepEqual(r.events, []); assert.deepEqual(b,before); }
  finally { r.unmount(); }
});
