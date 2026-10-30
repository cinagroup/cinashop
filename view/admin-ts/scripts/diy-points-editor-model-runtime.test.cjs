const { test, assert, path, fs, root, clone, loader, ticket } = require('./helpers/diy-navigation-runtime.cjs');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const utilFile = path.join(root, 'utils/diyPointsEditor.ts'), defaultsFile = path.join(root, 'utils/diyPointsDefaults.ts');
const model = () => loader().load(utilFile);

test('complete44-key points default is the fixed PHP literal with only three explicit image substitutions', () => {
  // Fixed PHP8ed2a5b points_mall.vue132–549. No PHP, Vue or require expression executes.
  const tree = ts.createSourceFile(defaultsFile, fs.readFileSync(defaultsFile, 'utf8'), ts.ScriptTarget.Latest, true); let literal;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'DIY_POINTS_DEFAULTS') literal = node.initializer; ts.forEachChild(node, visit); } visit(tree);
  function read(node) {
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => { assert.ok(ts.isPropertyAssignment(p)); return [p.name.text, read(p.initializer)]; }));
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(read);
    if (ts.isStringLiteral(node)) return node.text; if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false; if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    assert.fail('Only fixed static default literals are allowed');
  }
  const expected = read(literal), u = model(); assert.equal(Object.keys(expected).length, 44);
  const original = clone(expected); original.imgBgConfig.url = '@PHP_API_ROOT@/statics/images/pointsBg.png'; original.imgConfig.url = '@/assets/images/points01.png'; original.imgConfig2.url = '@/assets/images/points02.png';
  assert.equal(createHash('sha256').update(JSON.stringify(original)).digest('hex'), 'e4d210829d08b1e1428a766f50982115c7d847beacdfc1d5a6be6569173e22ad');
  assert.deepEqual(u.newPointsBlock(19), { ...expected, timestamp: 19 });
  assert.equal(expected.styleConfig.tabVal, 1); assert.equal(expected.titleConfig.tabVal, 0); assert.equal(expected.goodStyleConfig.tabVal, 0);
  assert.deepEqual(expected.numberConfig, { title: '商品数量', val: 3, min: 1 }); assert.equal(expected.titleTxtConfig.max, 10); assert.equal(expected.rightBntConfig.max, 6);
  assert.equal(expected.titleText.tabList[2].style, 'italic'); assert.equal(expected.moduleColor2.name, 'moduleColor'); assert.equal(expected.isHide, false);
  assert.equal(expected.imgBgConfig.url, '/static/images/diy/points-bg.png'); assert.equal(expected.imgConfig.url, '/static/images/diy/points-title.png'); assert.equal(expected.imgConfig2.url, '/static/images/diy/points-title-alt.png');
});

test('new points defaults are deep independent full metadata and never introduce saved product selection or arbitrary links', () => {
  const u = model(), first = u.newPointsBlock(1), second = u.newPointsBlock(2);
  first.fillet.valList[0].val = 99; first.filletImg.valList[1].val = 99; first.moduleColor.default[1].item = '#000'; first.imgConfig.name = 'changed';
  assert.equal(second.fillet.valList[0].val, 0); assert.equal(second.filletImg.valList[1].val, 0); assert.equal(second.moduleColor.default[1].item, '#E93323'); assert.equal(second.imgConfig.name, '标题图片');
  for (const key of ['goodsList', 'productIds', 'selectConfig', 'brandConfig', 'linkConfig']) assert.equal(Object.hasOwn(second, key), false);
  assert.deepEqual(u.POINTS_NAMES, ['pointsMall']); assert.deepEqual(u.POINTS_IMAGE_SLOTS, ['imgBgConfig', 'imgConfig', 'imgConfig2']);
  for (const timestamp of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => u.newPointsBlock(timestamp));
});

test('full imports remain complete and ordered discovery includes hidden duplicate malformed and overflow blocks', () => {
  const u = model(), rows = [{ name: 'unknown', timestamp: -99, raw: [] }, { name: 'pointsMall', timestamp: ' 2e0 ', styleConfig: null }, null,
    ...Array.from({ length: 251 }, (_, i) => ({ name: 'pointsMall', timestamp: i + 3, isHide: true, keep: [false, 0, ''] })), { name: 'pointsMall', timestamp: -2 }, { name: 'pointsMall', timestamp: 'bad' }], original = clone(rows);
  assert.deepEqual(u.pointsDocument(JSON.stringify(rows)), rows); assert.deepEqual(rows, original);
  const entries = u.pointsEntries(rows); assert.equal(entries.length, 254); assert.equal(entries[0].index, 254); assert.equal(entries[1].index, 1); assert.equal(entries.at(-1).index, 255);
  assert.deepEqual(u.POINTS_NAMES, ['pointsMall']); assert.equal(u.pointsKind('pointsMall'), 'pointsMall'); assert.equal(u.pointsKind('Points'), null); assert.equal(u.pointsRecord([]), null);
  assert.equal(u.pointsRead({ x: [false] }, ['x', 0]), false); assert.equal(u.pointsFlag(' TRUE '), true); assert.equal(u.pointsFlag('false'), false); assert.equal(u.pointsText('  原文  '), '  原文  ');
});

test('ordinary component add inserts complete default before any footer and retains all unrelated raw neighbours', () => {
  const u = model(), rows = [{ name: 'titles', timestamp: ' 4.5 ', keep: ['a'] }, { name: 'unknown', timestamp: Number.MAX_SAFE_INTEGER }, { name: 'PageFoot', timestamp: 900, keep: false }], original = clone(rows);
  const first = u.addPointsBlock(rows); assert.equal(first.selected, 2); assert.equal(first.value[2].timestamp, 5.5); assert.equal(Object.keys(first.value[2]).length, 44);
  assert.deepEqual(first.value.filter(row => row.name !== 'pointsMall'), rows); assert.deepEqual(rows, original);
  const second = u.addPointsBlock(first.value); assert.equal(second.value.filter(row => row.name === 'pointsMall').length, 2); assert.equal(second.value.at(-1).name, 'PageFoot');
  assert.throws(() => u.addPointsBlock([{ name: 'titles', timestamp: Number.MAX_SAFE_INTEGER }]), /排序空间不足/);
});

test('component movement follows the whole body order without normalizing imported timestamp spellings', () => {
  const u = model(), rows = [{ name: 'pointsMall', timestamp: ' 2e0 ', keep: [false] }, { name: 'titles', timestamp: '1.0', text: '正文' }, { name: 'unknown', timestamp: -100 }, { name: 'pointsMall', timestamp: 3 }], original = clone(rows);
  const moved = u.movePointsBlock(rows, 0, -1); assert.equal(moved.selected, 1); assert.equal(moved.value[1].name, 'pointsMall'); assert.equal(moved.value[1].timestamp, '1.0');
  assert.equal(moved.value[0].timestamp, ' 2e0 '); assert.deepEqual(moved.value[2], rows[2]); assert.deepEqual(rows, original);
  const back = u.movePointsBlock(moved.value, 1, 1); assert.deepEqual(back.value, rows); assert.equal(back.selected, 0);
});

test('movement fences headers and footer and refuses ambiguous or missing source intent', () => {
  const u = model();
  for (const header of ['homeComb', 'headerSerch', 'tabNav']) {
    const rows = [{ name: header, timestamp: 1 }, { name: 'pointsMall', timestamp: 2 }], before = clone(rows);
    assert.throws(() => u.movePointsBlock(rows, 1, -1)); assert.deepEqual(rows, before);
  }
  for (const rows of [[{ name: 'pointsMall', timestamp: 1 }, { name: 'titles', timestamp: 1 }], [{ name: 'pointsMall' }, { name: 'titles', timestamp: 2 }], [{ name: 'pointsMall', timestamp: 1 }, { name: 'pageFoot', timestamp: 2 }]]) {
    const original = clone(rows); assert.throws(() => u.movePointsBlock(rows, 0, 1)); assert.deepEqual(rows, original);
  }
  const rows = [{ name: 'pointsMall', timestamp: 1 }]; for (const [index, direction] of [[-1, 1], [0, 0], [0, .5], [0, -1]]) assert.throws(() => u.movePointsBlock(rows, index, direction));
});

test('explicit removal deletes only the selected points and selects the remaining rendered points', () => {
  const u = model(), rows = [{ name: 'pointsMall', timestamp: 3, keep: false }, { name: 'unknown', foo: [1] }, { name: 'pointsMall', timestamp: '1' }], before = clone(rows);
  const result = u.removePointsBlock(rows, 0); assert.deepEqual(result, { value: [rows[1], rows[2]], selected: 1 }); assert.deepEqual(rows, before);
  assert.equal(u.removePointsBlock(result.value, 1).selected, -1); assert.throws(() => u.removePointsBlock(rows, 1)); assert.throws(() => u.removePointsBlock(rows, -1));
});

test('complete document guards reject nonarrays dangerous keys excessive depth and overbudget input without truncation', () => {
  const u = model(); for (const value of ['null', '{}', 'false', '{', '[{"__proto__":{}}]', '[{"constructor":0}]']) assert.throws(() => u.pointsDocument(value));
  assert.throws(() => u.pointsDocument(JSON.stringify([{ name: 'pointsMall', keep: 'a'.repeat(2_000_001) }])), /2 MB/);
  let nested = 1; for (let i = 0; i < 66; i++) nested = { next: nested }; assert.throws(() => u.pointsDocument(JSON.stringify([nested])), /64/);
});

test('atomic explicit leaf edits preserve complete metadata defaults and every dormant original value', () => {
  const u = model(), block = u.newPointsBlock(9); block.moduleColor.imported = { keep: [0, false] }; block.unknown = { image: ticket(77), ids: ['001'], raw: null };
  const before = clone(block); assert.equal(u.pointsSet(block, ['moduleColor', 'color', 0, 'item'], '#123456'), true);
  const expected = clone(before); expected.moduleColor.color[0].item = '#123456'; assert.deepEqual(block, expected);
  assert.equal(u.pointsSet(block, ['moduleColor', 'color', 0, 'item'], '#123456'), false);
  assert.equal(u.pointsSet(block, ['unknown', 'raw'], { keep: [false, ''] }), true); assert.deepEqual(block.unknown.raw, { keep: [false, ''] });
});

test('bad imported parents and unsafe paths cannot partially create or replace metadata', () => {
  const u = model();
  for (const block of [{ name: 'pointsMall', moduleColor: null }, { name: 'pointsMall', moduleColor: { color: false } }, { name: 'pointsMall', moduleColor: [] }]) {
    const before = clone(block); assert.throws(() => u.pointsSet(block, ['moduleColor', 'color', 0, 'item'], '#fff')); assert.deepEqual(block, before);
  }
  for (const pathValue of [[], ['__proto__', 'x'], ['constructor'], ['fillet', 'valList', -1], ['fillet', 'valList', .5], ['fillet', 'valList', 100001]]) {
    const block = u.newPointsBlock(1), before = clone(block); assert.throws(() => u.pointsSet(block, pathValue, 9)); assert.deepEqual(block, before);
  }
  assert.throws(() => u.pointsSet({ name: 'other' }, ['x'], 1));
});

test('metadata safety rejects unsupported JSON values and whole-candidate capacity before mutation', () => {
  const u = model(), block = u.newPointsBlock(1), before = clone(block), cyclic = {}; cyclic.self = cyclic;
  const getter = {}; Object.defineProperty(getter, 'val', { enumerable: true, get() { throw Error('Must not execute getter'); } });
  const symbol = { [Symbol('x')]: 1 }, sparse = Array(2); sparse[1] = 1;
  for (const value of [undefined, NaN, Infinity, () => 1, 1n, new Date(), cyclic, getter, symbol, sparse, JSON.parse('{"__proto__":1}')]) {
    assert.throws(() => u.pointsSet(block, ['metadata'], value)); assert.deepEqual(block, before);
  }
  assert.throws(() => u.pointsSet(block, ['metadata'], 'a'.repeat(2_000_001)), /2 MB/); assert.deepEqual(block, before);
});

test('numeric display and same-value typed events retain raw zero tiny exponent spacing and oversized spellings', () => {
  const u = model();
  for (const raw of [0, '0', '000', ' 5e-4 ', '003.000', ' 1e2 ', '1e30']) {
    const block = { name: 'pointsMall', length: { val: raw, min: 0, keep: [] } }, before = clone(block);
    assert.equal(u.pointsNumber(raw), Number(raw)); assert.equal(u.setPointsNumber(block, ['length', 'val'], Number(raw)), false); assert.deepEqual(block, before);
  }
  assert.equal(u.pointsNumber('bad', 6), 6); assert.equal(u.pointsNumber(' ', 6), 6); assert.equal(u.pointsNumber(-1, 6), 6); assert.equal(u.pointsNumber(200, 0, 100), 100);
  const block = { name: 'pointsMall', length: { val: '4', keep: false } }; assert.equal(u.setPointsNumber(block, ['length', 'val'], 5, 1, 100), true); assert.deepEqual(block.length, { val: 5, keep: false });
  for (const value of ['6', NaN, Infinity, -1, 101]) assert.throws(() => u.setPointsNumber(block, ['length', 'val'], value, 0, 100));
});

test('new quantity accepts integer1..100 while equal imported out-of-range events remain exact noops', () => {
  const u = model();
  for (const raw of [0, ' 0 ', '5e-4', ' 2e0 ', '003', '1e30']) {
    const block = { name: 'pointsMall', numberConfig: { val: raw, min: 1, keep: [] } }, before = clone(block);
    assert.equal(u.setPointsCount(block, Number(raw)), false); assert.deepEqual(block, before);
    assert.equal(u.setPointsCount(block, 17), true); assert.deepEqual(block.numberConfig, { val: 17, min: 1, keep: [] });
  }
  for (const value of [0, -1, .5, 2.5, 101, '6', NaN, Infinity]) { const block = u.newPointsBlock(1), before = clone(block); assert.throws(() => u.setPointsCount(block, value), /整数/); assert.deepEqual(block, before); }
  const block = { name: 'pointsMall', numberConfig: null }, before = clone(block); assert.throws(() => u.setPointsCount(block, 2)); assert.deepEqual(block, before);
});

test('public quantity is the existing TS floor/clamp10000 then min10 and never a saved rewrite or claimed PHP LIMIT', () => {
  const u = model(); for (const [raw, limit] of [[0, 0], ['0', 0], ['5e-4', 0], [' 2.99 ', 2], ['003', 3], [9, 9], [10, 10], ['1e30', 10], [undefined, 6], ['bad', 6]]) assert.equal(u.pointsPublicLimit(raw), limit);
  const block = { name: 'pointsMall', numberConfig: { val: '001000' }, isHide: true, unknown: [ticket(88)] }, before = clone(block); u.pointsPublicLimit(block.numberConfig.val); assert.deepEqual(block, before);
});

test('all four bundled PNGs preserve exact fixed PHP bytes independently on Admin and Uni, with icon outside authored defaults', () => {
  const sources = [
    ['points-bg.png', 'f091108145214600a2ce57a7837147675b0bb590848088f5fb7d84d43fbdbd7f'],
    ['points-title.png', 'c010c32a90caaa85a5603acb8e2711f8628c2bc0486ec130658aa1b58cb5aa2a'],
    ['points-title-alt.png', 'f762f3bf6d887ead5283f94327693f76afd71c9cd662ee3c5e73f79b8e660ddd'],
    ['points-icon.png', '878811dad1f6760dd07500fa94f95f1dc9bb632ba5680c43e7797038c24b485d'],
  ];
  for (const [name, expected] of sources) {
    const admin = fs.readFileSync(path.join(root, '../public/static/images/diy', name)), uni = fs.readFileSync(path.join(root, '../../uniapp-ts/src/static/images/diy', name));
    assert.equal(createHash('sha256').update(admin).digest('hex'), expected); assert.deepEqual(admin, uni);
  }
  assert.equal(JSON.stringify(model().newPointsBlock(1)).includes('points-icon.png'), false);
});

test('canonical save touches only three precise points URL slots across every hidden and overflow component', () => {
  const u = model(), rows = Array.from({ length: 251 }, (_, i) => ({ name: 'pointsMall', timestamp: String(i), isHide: true, styleConfig: { tabVal: 0 }, titleConfig: { tabVal: 1 }, imgBgConfig: { url: ticket(11), image: ticket(91), name: 'metadata' }, imgConfig: { url: ticket(12) }, imgConfig2: { url: ticket(13) }, productList: [{ image: ticket(21) }], unknown: { url: ticket(22) }, linkConfig: { value: ticket(23) }, numberConfig: { val: '003' } }));
  rows.push({ name: 'other', imgConfig: { url: ticket(99) } }); const before = clone(rows), saved = JSON.parse(u.canonicalPointsValue(JSON.stringify(rows)));
  const expected = clone(before); for (const row of expected.slice(0, 251)) { row.imgBgConfig.url = '/api/assets/11'; row.imgConfig.url = '/api/assets/12'; row.imgConfig2.url = '/api/assets/13'; }
  assert.deepEqual(saved, expected); assert.deepEqual(rows, before); assert.deepEqual(u.canonicalPointsBlock(rows.at(-1)), rows.at(-1)); assert.throws(() => u.canonicalPointsValue('null'));
});

test('canonical image grammar rejects unsafe explicit selections without rewriting imported external entities unknown metadata or malformed slots', () => {
  const u = model(), row = { name: 'pointsMall', imgBgConfig: { url: 'http://example.com/x.png?keep=1' }, imgConfig: { url: '&#47;api&#47;assets&#47;12?signature=old' }, imgConfig2: [ticket(13)], other: { url: ticket(14) } }, before = clone(row);
  assert.deepEqual(u.canonicalPointsBlock(row), before); assert.deepEqual(row, before);
  assert.equal(u.canonicalPointsImage(' '+ticket(17)+' '), '/api/assets/17'); assert.equal(u.canonicalPointsImage('/static/images/diy/points-bg.png'), '/static/images/diy/points-bg.png'); assert.equal(u.canonicalPointsImage(''), '');
  for (const raw of ['http://example.com/x.png', '//example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAA', '/a b.png', '/a\\b.png', null, '/'+ 'x'.repeat(4096)]) assert.throws(() => u.canonicalPointsImage(raw));
  for (const slot of ['imgColorConfig','productList',0,null]) { const copy = clone(row); assert.throws(() => u.setPointsImage(copy, slot, '/safe.png')); assert.deepEqual(copy, row); }
});

test('explicit image choices are narrow atomic edits preserving original metadata and unsafe imported parents', () => {
  const u = model(), row = u.newPointsBlock(1), before = clone(row); assert.equal(u.setPointsImage(row, 'imgConfig2', ticket(18)), true);
  const expected = clone(before); expected.imgConfig2.url = '/api/assets/18'; assert.deepEqual(row, expected); assert.equal(u.setPointsImage(row, 'imgConfig2', ticket(18)), false);
  for (const malformed of [null,[],false,'bad']) { const imported = { name: 'pointsMall', imgConfig: malformed }, original = clone(imported); assert.throws(() => u.setPointsImage(imported, 'imgConfig', '/a.png')); assert.deepEqual(imported, original); }
});

test('three managed image previews require an exact whole block slot and stable ref capability; saved raw JSON never receives tickets', () => {
  const u = model(), row = u.newPointsBlock(1); row.imgBgConfig.url = '/api/assets/11'; row.imgConfig.url = '/api/assets/12'; row.imgConfig2.url = '/api/assets/13'; row.unknown = { image: ticket(77) };
  const before = clone(row), caps = u.POINTS_IMAGE_SLOTS.map((slot, i) => ({ ...u.pointsImageScope(row, slot), preview: ticket(i+11) }));
  assert.deepEqual(u.pointsImageScope(row,'imgConfig'), { block: JSON.stringify(row), slot: 'imgConfig', reference: '/api/assets/12' });
  const blank = u.pointsPreviewBlock(row); for (const slot of u.POINTS_IMAGE_SLOTS) assert.equal(blank[slot].url, '');
  const preview = u.pointsPreviewBlock(row,caps); for (const [i,slot] of u.POINTS_IMAGE_SLOTS.entries()) assert.equal(preview[slot].url,ticket(i+11)); assert.deepEqual(row,before); assert.deepEqual(preview.unknown,before.unknown);
  const saved = u.canonicalPointsBlock(preview); for (const [i,slot] of u.POINTS_IMAGE_SLOTS.entries()) assert.equal(saved[slot].url,`/api/assets/${i+11}`);
});

test('metadata raw reorder replace slot ref swap expired signature and old block capabilities fail closed', () => {
  const u = model(), row = u.newPointsBlock(1); for(const slot of u.POINTS_IMAGE_SLOTS) row[slot].url='/api/assets/11'; const cap = {...u.pointsImageScope(row,'imgConfig'),preview:ticket(11)};
  for(const change of [copy=>{copy.isHide=true;},copy=>{copy.unknown={};},copy=>{copy.imgConfig.url='/api/assets/12';},copy=>{copy.titleConfig.tabVal=1;},copy=>{copy.imgConfig.name='changed';}]) {const copy=clone(row);change(copy);assert.equal(u.pointsPreviewBlock(copy,[cap]).imgConfig.url,'');}
  for(const changed of [{...cap,slot:'imgConfig2'},{...cap,reference:'/api/assets/12'},{...cap,preview:ticket(12)},{...cap,preview:ticket(11,1)},{...cap,preview:'/api/assets/11'},{...cap,preview:'/api/assets/11?expires=9999999999&signature=bad'}]) assert.equal(u.pointsPreviewBlock(row,[changed]).imgConfig.url,'');
  const reordered = Object.fromEntries(Object.entries(row).reverse()); assert.equal(u.pointsPreviewBlock(reordered,[cap]).imgConfig.url,'');
  const ticketInRaw=clone(row);ticketInRaw.imgConfig.url=ticket(11);assert.equal(u.pointsPreviewBlock(ticketInRaw,[cap]).imgConfig.url,'','Matching canonical ref cannot override a changed complete raw block');
  assert.throws(()=>u.pointsImageScope({name:'other'},'imgConfig'));assert.throws(()=>u.pointsImageScope(row,'image'));
});

test('static and safe external images project without media capabilities and never authorize an unknown or adjacent slot', () => {
  const u=model(),row=u.newPointsBlock(1),before=clone(row),preview=u.pointsPreviewBlock(row);
  assert.deepEqual(preview,row);row.imgConfig.url='https://images.example.com/title.png';assert.equal(u.pointsPreviewBlock(row).imgConfig.url,row.imgConfig.url);
  row.imgConfig.url=' http://images.example.com/title.png ';assert.equal(u.pointsPreviewBlock(row).imgConfig.url,'https://images.example.com/title.png');assert.equal(row.imgConfig.url,' http://images.example.com/title.png ');row.imgConfig.url='data:image/png;base64,AAA';assert.equal(u.pointsPreviewBlock(row).imgConfig.url,row.imgConfig.url);row.imgConfig.url='data:image/svg+xml;base64,AAA';assert.equal(u.pointsPreviewBlock(row).imgConfig.url,'');
  row.unknown={url:ticket(91)};row.productList=[{image:ticket(92)}];const projected=u.pointsPreviewBlock(row);assert.deepEqual(projected.unknown,row.unknown);assert.deepEqual(projected.productList,row.productList);
  assert.deepEqual(u.pointsPreviewBlock({name:'other',imgConfig:{url:ticket(93)}}),{name:'other',imgConfig:{url:ticket(93)}});assert.deepEqual(model().newPointsBlock(1),before);
});
