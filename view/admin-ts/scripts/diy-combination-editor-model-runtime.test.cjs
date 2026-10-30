const { test, assert, path, fs, root, clone, loader, ticket } = require('./helpers/diy-navigation-runtime.cjs');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const utilFile = path.join(root, 'utils/diyCombinationEditor.ts'), defaultsFile = path.join(root, 'utils/diyCombinationDefaults.ts');
const model = () => loader().load(utilFile);

test('complete48-key combination default is the fixed PHP literal with only three explicit image substitutions', () => {
  // Fixed PHP8ed2a5b home_pink.vue225–700. No PHP, Vue or require expression executes.
  const tree = ts.createSourceFile(defaultsFile, fs.readFileSync(defaultsFile, 'utf8'), ts.ScriptTarget.Latest, true); let literal;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'DIY_COMBINATION_DEFAULTS') literal = node.initializer; ts.forEachChild(node, visit); } visit(tree);
  function read(node) {
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => { assert.ok(ts.isPropertyAssignment(p)); return [p.name.text, read(p.initializer)]; }));
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(read);
    if (ts.isStringLiteral(node)) return node.text; if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false; if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    assert.fail('Only fixed static default literals are allowed');
  }
  const expected = read(literal), u = model(); assert.equal(Object.keys(expected).length, 48);
  const original = clone(expected); original.imgBgConfig.url = '@PHP_API_ROOT@/statics/images/pinkBg.png'; original.imgConfig.url = '@/assets/images/pink02.png'; original.imgColorConfig.url = '@/assets/images/pink01.png';
  assert.equal(createHash('sha256').update(JSON.stringify(original)).digest('hex'), '8e84d833ef684946fc85f6716f3faabe0719bf78e74eef7d987a14ef28f6aada');
  assert.deepEqual(u.newCombinationBlock(19), { ...expected, timestamp: 19 });
  assert.equal(expected.styleConfig.tabVal, 1); assert.equal(expected.titleConfig.tabVal, 0); assert.equal(expected.goodStyleConfig.tabVal, 0);
  assert.deepEqual(expected.numberConfig, { title: '商品数量', val: 3, min: 1 }); assert.equal(expected.titleTxtConfig.max, 6); assert.equal(expected.rightBntConfig.max, 6);
  assert.equal(expected.titleText.tabList[2].style, 'italic'); assert.equal(expected.isHide, false);
  assert.deepEqual(expected.checkboxInfo.type,[0,1,2,3]); assert.deepEqual(expected.checkboxInfo.list.map(row=>[row.id,row.name]),[[0,'商品名称'],[1,'商品标签'],[2,'商品价格'],[3,'划线价']]); assert.equal(expected.pinkConfig.tabVal,0); assert.equal(expected.goodStyleConfig.tabList.length,4);
  assert.equal(expected.imgBgConfig.url, '/static/images/diy/combination-bg.png'); assert.equal(expected.imgConfig.url, '/static/images/diy/combination-title.png'); assert.equal(expected.imgColorConfig.url, '/static/images/diy/combination-title-alt.png');
});

test('new combination defaults are deep independent full metadata and never introduce saved product selection or arbitrary links', () => {
  const u = model(), first = u.newCombinationBlock(1), second = u.newCombinationBlock(2);
  first.fillet.valList[0].val = 99; first.filletImg.valList[1].val = 99; first.moduleColor.default[1].item = '#000'; first.imgConfig.name = 'changed';
  assert.equal(second.fillet.valList[0].val, 0); assert.equal(second.filletImg.valList[1].val, 0); assert.equal(second.moduleColor.default[1].item, '#fff'); assert.equal(second.imgConfig.name, '标题图片');
  for (const key of ['goodsList', 'productIds', 'selectConfig', 'brandConfig', 'linkConfig']) assert.equal(Object.hasOwn(second, key), false);
  assert.deepEqual(u.COMBINATION_NAMES, ['combination']); assert.deepEqual(u.COMBINATION_IMAGE_SLOTS, ['imgBgConfig', 'imgConfig', 'imgColorConfig']);
  for (const timestamp of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => u.newCombinationBlock(timestamp));
});

test('full imports remain complete and ordered discovery includes hidden duplicate malformed and overflow blocks', () => {
  const u = model(), rows = [{ name: 'unknown', timestamp: -99, raw: [] }, { name: 'combination', timestamp: ' 2e0 ', styleConfig: null }, null,
    ...Array.from({ length: 251 }, (_, i) => ({ name: 'combination', timestamp: i + 3, isHide: true, keep: [false, 0, ''] })), { name: 'combination', timestamp: -2 }, { name: 'combination', timestamp: 'bad' }], original = clone(rows);
  assert.deepEqual(u.combinationDocument(JSON.stringify(rows)), rows); assert.deepEqual(rows, original);
  const entries = u.combinationEntries(rows); assert.equal(entries.length, 254); assert.equal(entries[0].index, 254); assert.equal(entries[1].index, 1); assert.equal(entries.at(-1).index, 255);
  assert.deepEqual(u.COMBINATION_NAMES, ['combination']); assert.equal(u.combinationKind('combination'), 'combination'); assert.equal(u.combinationKind('Combination'), null); assert.equal(u.combinationRecord([]), null);
  assert.equal(u.combinationRead({ x: [false] }, ['x', 0]), false); assert.equal(u.combinationFlag(' TRUE '), true); assert.equal(u.combinationFlag('false'), false); assert.equal(u.combinationText('  原文  '), '  原文  ');
});

test('ordinary component add inserts complete default before any footer and retains all unrelated raw neighbours', () => {
  const u = model(), rows = [{ name: 'titles', timestamp: ' 4.5 ', keep: ['a'] }, { name: 'unknown', timestamp: Number.MAX_SAFE_INTEGER }, { name: 'PageFoot', timestamp: 900, keep: false }], original = clone(rows);
  const first = u.addCombinationBlock(rows); assert.equal(first.selected, 2); assert.equal(first.value[2].timestamp, 5.5); assert.equal(Object.keys(first.value[2]).length, 48);
  assert.deepEqual(first.value.filter(row => row.name !== 'combination'), rows); assert.deepEqual(rows, original);
  const second = u.addCombinationBlock(first.value); assert.equal(second.value.filter(row => row.name === 'combination').length, 2); assert.equal(second.value.at(-1).name, 'PageFoot');
  assert.throws(() => u.addCombinationBlock([{ name: 'titles', timestamp: Number.MAX_SAFE_INTEGER }]), /排序空间不足/);
});

test('component movement follows the whole body order without normalizing imported timestamp spellings', () => {
  const u = model(), rows = [{ name: 'combination', timestamp: ' 2e0 ', keep: [false] }, { name: 'titles', timestamp: '1.0', text: '正文' }, { name: 'unknown', timestamp: -100 }, { name: 'combination', timestamp: 3 }], original = clone(rows);
  const moved = u.moveCombinationBlock(rows, 0, -1); assert.equal(moved.selected, 1); assert.equal(moved.value[1].name, 'combination'); assert.equal(moved.value[1].timestamp, '1.0');
  assert.equal(moved.value[0].timestamp, ' 2e0 '); assert.deepEqual(moved.value[2], rows[2]); assert.deepEqual(rows, original);
  const back = u.moveCombinationBlock(moved.value, 1, 1); assert.deepEqual(back.value, rows); assert.equal(back.selected, 0);
});

test('movement fences headers and footer and refuses ambiguous or missing source intent', () => {
  const u = model();
  for (const header of ['homeComb', 'headerSerch', 'tabNav']) {
    const rows = [{ name: header, timestamp: 1 }, { name: 'combination', timestamp: 2 }], before = clone(rows);
    assert.throws(() => u.moveCombinationBlock(rows, 1, -1)); assert.deepEqual(rows, before);
  }
  for (const rows of [[{ name: 'combination', timestamp: 1 }, { name: 'titles', timestamp: 1 }], [{ name: 'combination' }, { name: 'titles', timestamp: 2 }], [{ name: 'combination', timestamp: 1 }, { name: 'pageFoot', timestamp: 2 }]]) {
    const original = clone(rows); assert.throws(() => u.moveCombinationBlock(rows, 0, 1)); assert.deepEqual(rows, original);
  }
  const rows = [{ name: 'combination', timestamp: 1 }]; for (const [index, direction] of [[-1, 1], [0, 0], [0, .5], [0, -1]]) assert.throws(() => u.moveCombinationBlock(rows, index, direction));
});

test('explicit removal deletes only the selected combination and selects the remaining rendered combination', () => {
  const u = model(), rows = [{ name: 'combination', timestamp: 3, keep: false }, { name: 'unknown', foo: [1] }, { name: 'combination', timestamp: '1' }], before = clone(rows);
  const result = u.removeCombinationBlock(rows, 0); assert.deepEqual(result, { value: [rows[1], rows[2]], selected: 1 }); assert.deepEqual(rows, before);
  assert.equal(u.removeCombinationBlock(result.value, 1).selected, -1); assert.throws(() => u.removeCombinationBlock(rows, 1)); assert.throws(() => u.removeCombinationBlock(rows, -1));
});

test('complete document guards reject nonarrays dangerous keys excessive depth and overbudget input without truncation', () => {
  const u = model(); for (const value of ['null', '{}', 'false', '{', '[{"__proto__":{}}]', '[{"constructor":0}]']) assert.throws(() => u.combinationDocument(value));
  assert.throws(() => u.combinationDocument(JSON.stringify([{ name: 'combination', keep: 'a'.repeat(2_000_001) }])), /2 MB/);
  let nested = 1; for (let i = 0; i < 66; i++) nested = { next: nested }; assert.throws(() => u.combinationDocument(JSON.stringify([nested])), /64/);
});

test('atomic explicit leaf edits preserve complete metadata defaults and every dormant original value', () => {
  const u = model(), block = u.newCombinationBlock(9); block.moduleColor.imported = { keep: [0, false] }; block.unknown = { image: ticket(77), ids: ['001'], raw: null };
  const before = clone(block); assert.equal(u.combinationSet(block, ['moduleColor', 'color', 0, 'item'], '#123456'), true);
  const expected = clone(before); expected.moduleColor.color[0].item = '#123456'; assert.deepEqual(block, expected);
  assert.equal(u.combinationSet(block, ['moduleColor', 'color', 0, 'item'], '#123456'), false);
  assert.equal(u.combinationSet(block, ['unknown', 'raw'], { keep: [false, ''] }), true); assert.deepEqual(block.unknown.raw, { keep: [false, ''] });
});

test('bad imported parents and unsafe paths cannot partially create or replace metadata', () => {
  const u = model();
  for (const block of [{ name: 'combination', moduleColor: null }, { name: 'combination', moduleColor: { color: false } }, { name: 'combination', moduleColor: [] }]) {
    const before = clone(block); assert.throws(() => u.combinationSet(block, ['moduleColor', 'color', 0, 'item'], '#fff')); assert.deepEqual(block, before);
  }
  for (const pathValue of [[], ['__proto__', 'x'], ['constructor'], ['fillet', 'valList', -1], ['fillet', 'valList', .5], ['fillet', 'valList', 100001]]) {
    const block = u.newCombinationBlock(1), before = clone(block); assert.throws(() => u.combinationSet(block, pathValue, 9)); assert.deepEqual(block, before);
  }
  assert.throws(() => u.combinationSet({ name: 'other' }, ['x'], 1));
});

test('metadata safety rejects unsupported JSON values and whole-candidate capacity before mutation', () => {
  const u = model(), block = u.newCombinationBlock(1), before = clone(block), cyclic = {}; cyclic.self = cyclic;
  const getter = {}; Object.defineProperty(getter, 'val', { enumerable: true, get() { throw Error('Must not execute getter'); } });
  const symbol = { [Symbol('x')]: 1 }, sparse = Array(2); sparse[1] = 1;
  for (const value of [undefined, NaN, Infinity, () => 1, 1n, new Date(), cyclic, getter, symbol, sparse, JSON.parse('{"__proto__":1}')]) {
    assert.throws(() => u.combinationSet(block, ['metadata'], value)); assert.deepEqual(block, before);
  }
  assert.throws(() => u.combinationSet(block, ['metadata'], 'a'.repeat(2_000_001)), /2 MB/); assert.deepEqual(block, before);
});

test('numeric display and same-value typed events retain raw zero tiny exponent spacing and oversized spellings', () => {
  const u = model();
  for (const raw of [0, '0', '000', ' 5e-4 ', '003.000', ' 1e2 ', '1e30']) {
    const block = { name: 'combination', length: { val: raw, min: 0, keep: [] } }, before = clone(block);
    assert.equal(u.combinationNumber(raw), Number(raw)); assert.equal(u.setCombinationNumber(block, ['length', 'val'], Number(raw)), false); assert.deepEqual(block, before);
  }
  assert.equal(u.combinationNumber('bad', 6), 6); assert.equal(u.combinationNumber(' ', 6), 6); assert.equal(u.combinationNumber(-1, 6), 6); assert.equal(u.combinationNumber(200, 0, 100), 100);
  const block = { name: 'combination', length: { val: '4', keep: false } }; assert.equal(u.setCombinationNumber(block, ['length', 'val'], 5, 1, 100), true); assert.deepEqual(block.length, { val: 5, keep: false });
  for (const value of ['6', NaN, Infinity, -1, 101]) assert.throws(() => u.setCombinationNumber(block, ['length', 'val'], value, 0, 100));
});

test('new quantity accepts integer1..100 while equal imported out-of-range events remain exact noops', () => {
  const u = model();
  for (const raw of [0, ' 0 ', '5e-4', ' 2e0 ', '003', '1e30']) {
    const block = { name: 'combination', numberConfig: { val: raw, min: 1, keep: [] } }, before = clone(block);
    assert.equal(u.setCombinationCount(block, Number(raw)), false); assert.deepEqual(block, before);
    assert.equal(u.setCombinationCount(block, 17), true); assert.deepEqual(block.numberConfig, { val: 17, min: 1, keep: [] });
  }
  for (const value of [0, -1, .5, 2.5, 101, '6', NaN, Infinity]) { const block = u.newCombinationBlock(1), before = clone(block); assert.throws(() => u.setCombinationCount(block, value), /整数/); assert.deepEqual(block, before); }
  const block = { name: 'combination', numberConfig: null }, before = clone(block); assert.throws(() => u.setCombinationCount(block, 2)); assert.deepEqual(block, before);
});

test('public quantity is the existing TS floor/clamp10000 then min10 and never a saved rewrite or claimed PHP LIMIT', () => {
  const u = model(); for (const [raw, limit] of [[0, 0], ['0', 0], ['5e-4', 0], [' 2.99 ', 2], ['003', 3], [9, 9], [10, 10], ['1e30', 10], [undefined, 6], ['bad', 6]]) assert.equal(u.combinationPublicLimit(raw), limit);
  const block = { name: 'combination', numberConfig: { val: '001000' }, isHide: true, unknown: [ticket(88)] }, before = clone(block); u.combinationPublicLimit(block.numberConfig.val); assert.deepEqual(block, before);
});

test('all three bundled PNGs preserve exact fixed PHP bytes independently on Admin and Uni with original140px title assets', () => {
  const sources = [
    ['combination-bg.png', '6b95e30b67fb853f57b49872dc754d537fbd19cdcc6cb4261ccbebcfa86804bf'],
    ['combination-title.png', 'dad8f41d98720a8964d1a21a280dfa020e8859f0f324a3377799a0910d646b20'],
    ['combination-title-alt.png', '436293d064821e2675d2329ff2f8d35ee6420849ffaaa5e412809082f91213d3'],
  ];
  for (const [name, expected] of sources) {
    const admin = fs.readFileSync(path.join(root, '../public/static/images/diy', name)), uni = fs.readFileSync(path.join(root, '../../uniapp-ts/src/static/images/diy', name));
    assert.equal(createHash('sha256').update(admin).digest('hex'), expected); assert.deepEqual(admin, uni);
  }
  const png=fs.readFileSync(path.join(root,'../public/static/images/diy/combination-title.png'));assert.equal(png.readUInt32BE(16),140);assert.equal(png.readUInt32BE(20),32);
});

test('canonical save touches only three precise combination URL slots across every hidden and overflow component', () => {
  const u = model(), rows = Array.from({ length: 251 }, (_, i) => ({ name: 'combination', timestamp: String(i), isHide: true, styleConfig: { tabVal: 0 }, titleConfig: { tabVal: 1 }, imgBgConfig: { url: ticket(11), image: ticket(91), name: 'metadata' }, imgConfig: { url: ticket(12) }, imgColorConfig: { url: ticket(13) }, productList: [{ image: ticket(21) }], unknown: { url: ticket(22) }, linkConfig: { value: ticket(23) }, numberConfig: { val: '003' } }));
  rows.push({ name: 'other', imgConfig: { url: ticket(99) } }); const before = clone(rows), saved = JSON.parse(u.canonicalCombinationValue(JSON.stringify(rows)));
  const expected = clone(before); for (const row of expected.slice(0, 251)) { row.imgBgConfig.url = '/api/assets/11'; row.imgConfig.url = '/api/assets/12'; row.imgColorConfig.url = '/api/assets/13'; }
  assert.deepEqual(saved, expected); assert.deepEqual(rows, before); assert.deepEqual(u.canonicalCombinationBlock(rows.at(-1)), rows.at(-1)); assert.throws(() => u.canonicalCombinationValue('null'));
});

test('canonical image grammar rejects unsafe explicit selections without rewriting imported external entities unknown metadata or malformed slots', () => {
  const u = model(), row = { name: 'combination', imgBgConfig: { url: 'http://example.com/x.png?keep=1' }, imgConfig: { url: '&#47;api&#47;assets&#47;12?signature=old' }, imgColorConfig: [ticket(13)], other: { url: ticket(14) } }, before = clone(row);
  assert.deepEqual(u.canonicalCombinationBlock(row), before); assert.deepEqual(row, before);
  assert.equal(u.canonicalCombinationImage(' '+ticket(17)+' '), '/api/assets/17'); assert.equal(u.canonicalCombinationImage('/static/images/diy/combination-bg.png'), '/static/images/diy/combination-bg.png'); assert.equal(u.canonicalCombinationImage(''), '');
  for (const raw of ['http://example.com/x.png', '//example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAA', '/a b.png', '/a\\b.png', null, '/'+ 'x'.repeat(4096)]) assert.throws(() => u.canonicalCombinationImage(raw));
  for (const slot of ['imgConfig2','productList',0,null]) { const copy = clone(row); assert.throws(() => u.setCombinationImage(copy, slot, '/safe.png')); assert.deepEqual(copy, row); }
});

test('explicit image choices are narrow atomic edits preserving original metadata and unsafe imported parents', () => {
  const u = model(), row = u.newCombinationBlock(1), before = clone(row); assert.equal(u.setCombinationImage(row, 'imgColorConfig', ticket(18)), true);
  const expected = clone(before); expected.imgColorConfig.url = '/api/assets/18'; assert.deepEqual(row, expected); assert.equal(u.setCombinationImage(row, 'imgColorConfig', ticket(18)), false);
  for (const malformed of [null,[],false,'bad']) { const imported = { name: 'combination', imgConfig: malformed }, original = clone(imported); assert.throws(() => u.setCombinationImage(imported, 'imgConfig', '/a.png')); assert.deepEqual(imported, original); }
});

test('three managed image previews require an exact whole block slot and stable ref capability; saved raw JSON never receives tickets', () => {
  const u = model(), row = u.newCombinationBlock(1); row.imgBgConfig.url = '/api/assets/11'; row.imgConfig.url = '/api/assets/12'; row.imgColorConfig.url = '/api/assets/13'; row.unknown = { image: ticket(77) };
  const before = clone(row), caps = u.COMBINATION_IMAGE_SLOTS.map((slot, i) => ({ ...u.combinationImageScope(row, slot), preview: ticket(i+11) }));
  assert.deepEqual(u.combinationImageScope(row,'imgConfig'), { block: JSON.stringify(row), slot: 'imgConfig', reference: '/api/assets/12' });
  const blank = u.combinationPreviewBlock(row); for (const slot of u.COMBINATION_IMAGE_SLOTS) assert.equal(blank[slot].url, '');
  const preview = u.combinationPreviewBlock(row,caps); for (const [i,slot] of u.COMBINATION_IMAGE_SLOTS.entries()) assert.equal(preview[slot].url,ticket(i+11)); assert.deepEqual(row,before); assert.deepEqual(preview.unknown,before.unknown);
  const saved = u.canonicalCombinationBlock(preview); for (const [i,slot] of u.COMBINATION_IMAGE_SLOTS.entries()) assert.equal(saved[slot].url,`/api/assets/${i+11}`);
});

test('metadata raw reorder replace slot ref swap expired signature and old block capabilities fail closed', () => {
  const u = model(), row = u.newCombinationBlock(1); for(const slot of u.COMBINATION_IMAGE_SLOTS) row[slot].url='/api/assets/11'; const cap = {...u.combinationImageScope(row,'imgConfig'),preview:ticket(11)};
  for(const change of [copy=>{copy.isHide=true;},copy=>{copy.unknown={};},copy=>{copy.imgConfig.url='/api/assets/12';},copy=>{copy.titleConfig.tabVal=1;},copy=>{copy.imgConfig.name='changed';}]) {const copy=clone(row);change(copy);assert.equal(u.combinationPreviewBlock(copy,[cap]).imgConfig.url,'');}
  for(const changed of [{...cap,slot:'imgColorConfig'},{...cap,reference:'/api/assets/12'},{...cap,preview:ticket(12)},{...cap,preview:ticket(11,1)},{...cap,preview:'/api/assets/11'},{...cap,preview:'/api/assets/11?expires=9999999999&signature=bad'}]) assert.equal(u.combinationPreviewBlock(row,[changed]).imgConfig.url,'');
  const reordered = Object.fromEntries(Object.entries(row).reverse()); assert.equal(u.combinationPreviewBlock(reordered,[cap]).imgConfig.url,'');
  const ticketInRaw=clone(row);ticketInRaw.imgConfig.url=ticket(11);assert.equal(u.combinationPreviewBlock(ticketInRaw,[cap]).imgConfig.url,'','Matching canonical ref cannot override a changed complete raw block');
  assert.throws(()=>u.combinationImageScope({name:'other'},'imgConfig'));assert.throws(()=>u.combinationImageScope(row,'image'));
});

test('static and safe external images project without media capabilities and never authorize an unknown or adjacent slot', () => {
  const u=model(),row=u.newCombinationBlock(1),before=clone(row),preview=u.combinationPreviewBlock(row);
  assert.deepEqual(preview,row);row.imgConfig.url='https://images.example.com/title.png';assert.equal(u.combinationPreviewBlock(row).imgConfig.url,row.imgConfig.url);
  row.imgConfig.url=' http://images.example.com/title.png ';assert.equal(u.combinationPreviewBlock(row).imgConfig.url,'https://images.example.com/title.png');assert.equal(row.imgConfig.url,' http://images.example.com/title.png ');row.imgConfig.url='data:image/png;base64,AAA';assert.equal(u.combinationPreviewBlock(row).imgConfig.url,row.imgConfig.url);row.imgConfig.url='data:image/svg+xml;base64,AAA';assert.equal(u.combinationPreviewBlock(row).imgConfig.url,'');
  row.unknown={url:ticket(91)};row.productList=[{image:ticket(92)}];const projected=u.combinationPreviewBlock(row);assert.deepEqual(projected.unknown,row.unknown);assert.deepEqual(projected.productList,row.productList);
  assert.deepEqual(u.combinationPreviewBlock({name:'other',imgConfig:{url:ticket(93)}}),{name:'other',imgConfig:{url:ticket(93)}});assert.deepEqual(model().newCombinationBlock(1),before);
});


test('original numeric0..3 author/public checkbox identities include typed3 but never coerce unknown imports',()=>{
 const u=model(),row=u.newCombinationBlock(1);assert.deepEqual(u.COMBINATION_CHECKBOX_VALUES,[0,1,2,3]);assert.deepEqual(u.combinationChecks(row),[0,1,2,3]);assert.deepEqual(row.checkboxInfo.type,[0,1,2,3]);
 const imported={name:'combination',checkboxInfo:{type:[4,'0',2,3,2,false,{id:1},0,99],list:[{id:0,name:'original'}],keep:false}},before=clone(imported);assert.deepEqual(u.combinationChecks(imported),[2,3,0]);assert.deepEqual(imported,before);assert.deepEqual(u.combinationChecks({name:'combination',checkboxInfo:{type:null}}),[]);
});

test('same checkbox set retains original order duplicate known entries unknown values and all metadata',()=>{
 const u=model(),row={name:'combination',checkboxInfo:{type:[4,'1',2,3,{id:17},0,2,3,false,99],list:[{id:3,name:'原划线价'}],default:[0,1,2,3]}},before=clone(row),original=row.checkboxInfo.type;
 assert.equal(u.setCombinationChecks(row,[0,2,3]),false);assert.strictEqual(row.checkboxInfo.type,original);assert.deepEqual(row,before);assert.equal(u.setCombinationChecks(row,[3,2,0]),false);assert.deepEqual(row,before);
});

test('explicit checkbox changes only selected numeric0..3 and preserves every unrelated entry in original positions',()=>{
 const u=model(),row={name:'combination',checkboxInfo:{type:[4,'1',2,3,{id:17},0,2,3,false,99],list:[{id:3,name:'原划线价'}],default:[0,1,2,3]}},before=clone(row);
 assert.equal(u.setCombinationChecks(row,[0,1,3]),true);const expected=clone(before);expected.checkboxInfo.type=[4,'1',3,{id:17},0,3,false,99,1];assert.deepEqual(row,expected);
 assert.equal(u.setCombinationChecks(row,[]),true);expected.checkboxInfo.type=[4,'1',{id:17},false,99];assert.deepEqual(row,expected);assert.deepEqual(before.checkboxInfo.type,[4,'1',2,3,{id:17},0,2,3,false,99]);
 assert.equal(u.setCombinationChecks(row,[2,3]),true);expected.checkboxInfo.type.push(2,3);assert.deepEqual(row,expected);
});

test('unsafe malformed oversized duplicated and coerced checkbox inputs fail atomically before any getter or raw rewrite',()=>{
 const u=model();for(const input of[undefined,null,{},'0',false,[4],[-1],['0'],[false],[0,0],[0,1,2,3,4],Array(1),[NaN],[Infinity],[[0]],[{id:0}]]){const row=u.newCombinationBlock(1),before=clone(row);assert.throws(()=>u.setCombinationChecks(row,input));assert.deepEqual(row,before);}
 const getter=[];Object.defineProperty(getter,'0',{enumerable:true,get(){throw Error('must not invoke getter');}});getter.length=1;const row=u.newCombinationBlock(1),before=clone(row);assert.throws(()=>u.setCombinationChecks(row,getter),/动态字段/);assert.deepEqual(row,before);
 for(const raw of[null,false,'bad',{}]){const row={name:'combination',checkboxInfo:{type:raw,keep:[]}},before=clone(row);assert.throws(()=>u.setCombinationChecks(row,[1]));assert.deepEqual(row,before);}
 assert.throws(()=>u.setCombinationChecks({name:'other'},[1]));
 const missing={name:'combination',checkboxInfo:{keep:false}};assert.equal(u.setCombinationChecks(missing,[1,3]),true);assert.deepEqual(missing,{name:'combination',checkboxInfo:{keep:false,type:[1,3]}});
});

test('combination activity family never consumes homeComb page-header metadata or authorizes its images',()=>{
 const u=model(),home={name:'homeComb',timestamp:7,checkboxInfo:{type:[0,1,2,3]},imgConfig:{url:ticket(17)},unknown:{keep:false}},before=clone(home);
 assert.equal(u.combinationKind(home.name),null);assert.deepEqual(u.combinationEntries([home,{name:'combination',timestamp:8}]),[{index:1,kind:'combination'}]);assert.deepEqual(u.canonicalCombinationBlock(home),home);assert.deepEqual(u.combinationPreviewBlock(home),home);
 for(const work of[()=>u.combinationSet(home,['opaque'],1),()=>u.setCombinationChecks(home,[0]),()=>u.setCombinationImage(home,'imgConfig','/static/a.png'),()=>u.removeCombinationBlock([home],0),()=>u.combinationImageScope(home,'imgConfig')])assert.throws(work);assert.deepEqual(home,before);
});

test('typed old-price checkbox3 is editable independently without rewriting its imported duplicates or string twin',()=>{
 const u=model(),row={name:'combination',checkboxInfo:{type:[3,'3',3,0],list:[{id:3,name:'原文字'}],unknown:7}};assert.equal(u.setCombinationChecks(row,[0]),true);assert.deepEqual(row.checkboxInfo.type,['3',0]);assert.equal(u.setCombinationChecks(row,[0,3]),true);assert.deepEqual(row.checkboxInfo.type,['3',0,3]);assert.deepEqual(row.checkboxInfo.list,[{id:3,name:'原文字'}]);assert.equal(row.checkboxInfo.unknown,7);
});
