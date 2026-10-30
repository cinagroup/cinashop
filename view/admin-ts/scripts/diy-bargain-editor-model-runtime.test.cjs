const { test, assert, path, fs, root, clone, loader, ticket } = require('./helpers/diy-navigation-runtime.cjs');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const utilFile = path.join(root, 'utils/diyBargainEditor.ts'), defaultsFile = path.join(root, 'utils/diyBargainDefaults.ts');
const model = () => loader().load(utilFile);

test('complete51-key bargain default is the fixed PHP literal with only three explicit image substitutions', () => {
  // Fixed PHP8ed2a5b home_bargain.vue194–709. No PHP, Vue or require expression executes.
  const tree = ts.createSourceFile(defaultsFile, fs.readFileSync(defaultsFile, 'utf8'), ts.ScriptTarget.Latest, true); let literal;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'DIY_BARGAIN_DEFAULTS') literal = node.initializer; ts.forEachChild(node, visit); } visit(tree);
  function read(node) {
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => { assert.ok(ts.isPropertyAssignment(p)); return [p.name.text, read(p.initializer)]; }));
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(read);
    if (ts.isStringLiteral(node)) return node.text; if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false; if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    assert.fail('Only fixed static default literals are allowed');
  }
  const expected = read(literal), u = model(); assert.equal(Object.keys(expected).length, 51);
  const original = clone(expected); original.imgBgConfig.url = '@PHP_API_ROOT@/statics/images/bargainBg.png'; original.imgConfig.url = '@/assets/images/bargain02.png'; original.imgColorConfig.url = '@/assets/images/bargain01.png';
  assert.equal(createHash('sha256').update(JSON.stringify(original)).digest('hex'), '6af7de586515514fc8e97fd8d624aa73f3e35b88a02ab01aeecdfd08647cd117');
  assert.deepEqual(u.newBargainBlock(19), { ...expected, timestamp: 19 });
  assert.equal(expected.styleConfig.tabVal, 1); assert.equal(expected.titleConfig.tabVal, 0); assert.equal(expected.goodStyleConfig.tabVal, 0);
  assert.deepEqual(expected.numberConfig, { title: '商品数量', val: 3, min: 1 }); assert.equal(expected.titleTxtConfig.max, 6); assert.equal(expected.rightBntConfig.max, 6);
  assert.equal(expected.titleText.tabList[2].style, 'italic'); assert.equal(expected.isHide, false);
  assert.deepEqual(expected.checkboxInfo.type,[0,1,2,3]); assert.deepEqual(expected.checkboxInfo.list.map(row=>[row.id,row.name]),[[0,'商品名称'],[1,'参与人数'],[2,'商品价格'],[3,'划线价']]); assert.equal(expected.bargainConfig.tabVal,0); assert.equal(expected.goodStyleConfig.tabList.length,4);
  assert.equal(expected.tipTxtConfig.value,'低至0元免费拿'); assert.equal(expected.tipTxtConfig.max,15); assert.equal(expected.imgConfig.info,'建议：140px * 32px'); assert.equal(expected.imgColorConfig.info,'建议：140px * 32px'); assert.equal(expected.joinBgColor.name,'progressColor'); assert.equal(expected.joinNumColor2.color[0].item,'#fff');
  assert.equal(expected.imgBgConfig.url, '/static/images/diy/bargain-bg.png'); assert.equal(expected.imgConfig.url, '/static/images/diy/bargain-title.png'); assert.equal(expected.imgColorConfig.url, '/static/images/diy/bargain-title-alt.png');
});

test('new bargain defaults are deep independent full metadata and never introduce saved product selection or arbitrary links', () => {
  const u = model(), first = u.newBargainBlock(1), second = u.newBargainBlock(2);
  first.fillet.valList[0].val = 99; first.filletImg.valList[1].val = 99; first.moduleColor.default[1].item = '#000'; first.imgConfig.name = 'changed';
  assert.equal(second.fillet.valList[0].val, 0); assert.equal(second.filletImg.valList[1].val, 0); assert.equal(second.moduleColor.default[1].item, '#fff'); assert.equal(second.imgConfig.name, '标题图片');
  for (const key of ['goodsList', 'productIds', 'selectConfig', 'brandConfig', 'linkConfig']) assert.equal(Object.hasOwn(second, key), false);
  assert.deepEqual(u.BARGAIN_NAMES, ['bargain']); assert.deepEqual(u.BARGAIN_IMAGE_SLOTS, ['imgBgConfig', 'imgConfig', 'imgColorConfig']);
  for (const timestamp of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => u.newBargainBlock(timestamp));
});

test('full imports remain complete and ordered discovery includes hidden duplicate malformed and overflow blocks', () => {
  const u = model(), rows = [{ name: 'unknown', timestamp: -99, raw: [] }, { name: 'bargain', timestamp: ' 2e0 ', styleConfig: null }, null,
    ...Array.from({ length: 251 }, (_, i) => ({ name: 'bargain', timestamp: i + 3, isHide: true, keep: [false, 0, ''] })), { name: 'bargain', timestamp: -2 }, { name: 'bargain', timestamp: 'bad' }], original = clone(rows);
  assert.deepEqual(u.bargainDocument(JSON.stringify(rows)), rows); assert.deepEqual(rows, original);
  const entries = u.bargainEntries(rows); assert.equal(entries.length, 254); assert.equal(entries[0].index, 254); assert.equal(entries[1].index, 1); assert.equal(entries.at(-1).index, 255);
  assert.deepEqual(u.BARGAIN_NAMES, ['bargain']); assert.equal(u.bargainKind('bargain'), 'bargain'); assert.equal(u.bargainKind('Bargain'), null); assert.equal(u.bargainRecord([]), null);
  assert.equal(u.bargainRead({ x: [false] }, ['x', 0]), false); assert.equal(u.bargainFlag(' TRUE '), true); assert.equal(u.bargainFlag('false'), false); assert.equal(u.bargainText('  原文  '), '  原文  ');
});

test('ordinary component add inserts complete default before any footer and retains all unrelated raw neighbours', () => {
  const u = model(), rows = [{ name: 'titles', timestamp: ' 4.5 ', keep: ['a'] }, { name: 'unknown', timestamp: Number.MAX_SAFE_INTEGER }, { name: 'PageFoot', timestamp: 900, keep: false }], original = clone(rows);
  const first = u.addBargainBlock(rows); assert.equal(first.selected, 2); assert.equal(first.value[2].timestamp, 5.5); assert.equal(Object.keys(first.value[2]).length, 51);
  assert.deepEqual(first.value.filter(row => row.name !== 'bargain'), rows); assert.deepEqual(rows, original);
  const second = u.addBargainBlock(first.value); assert.equal(second.value.filter(row => row.name === 'bargain').length, 2); assert.equal(second.value.at(-1).name, 'PageFoot');
  assert.throws(() => u.addBargainBlock([{ name: 'titles', timestamp: Number.MAX_SAFE_INTEGER }]), /排序空间不足/);
});

test('component movement follows the whole body order without normalizing imported timestamp spellings', () => {
  const u = model(), rows = [{ name: 'bargain', timestamp: ' 2e0 ', keep: [false] }, { name: 'titles', timestamp: '1.0', text: '正文' }, { name: 'unknown', timestamp: -100 }, { name: 'bargain', timestamp: 3 }], original = clone(rows);
  const moved = u.moveBargainBlock(rows, 0, -1); assert.equal(moved.selected, 1); assert.equal(moved.value[1].name, 'bargain'); assert.equal(moved.value[1].timestamp, '1.0');
  assert.equal(moved.value[0].timestamp, ' 2e0 '); assert.deepEqual(moved.value[2], rows[2]); assert.deepEqual(rows, original);
  const back = u.moveBargainBlock(moved.value, 1, 1); assert.deepEqual(back.value, rows); assert.equal(back.selected, 0);
});

test('movement fences headers and footer and refuses ambiguous or missing source intent', () => {
  const u = model();
  for (const header of ['homeComb', 'headerSerch', 'tabNav']) {
    const rows = [{ name: header, timestamp: 1 }, { name: 'bargain', timestamp: 2 }], before = clone(rows);
    assert.throws(() => u.moveBargainBlock(rows, 1, -1)); assert.deepEqual(rows, before);
  }
  for (const rows of [[{ name: 'bargain', timestamp: 1 }, { name: 'titles', timestamp: 1 }], [{ name: 'bargain' }, { name: 'titles', timestamp: 2 }], [{ name: 'bargain', timestamp: 1 }, { name: 'pageFoot', timestamp: 2 }]]) {
    const original = clone(rows); assert.throws(() => u.moveBargainBlock(rows, 0, 1)); assert.deepEqual(rows, original);
  }
  const rows = [{ name: 'bargain', timestamp: 1 }]; for (const [index, direction] of [[-1, 1], [0, 0], [0, .5], [0, -1]]) assert.throws(() => u.moveBargainBlock(rows, index, direction));
});

test('explicit removal deletes only the selected bargain and selects the remaining rendered bargain', () => {
  const u = model(), rows = [{ name: 'bargain', timestamp: 3, keep: false }, { name: 'unknown', foo: [1] }, { name: 'bargain', timestamp: '1' }], before = clone(rows);
  const result = u.removeBargainBlock(rows, 0); assert.deepEqual(result, { value: [rows[1], rows[2]], selected: 1 }); assert.deepEqual(rows, before);
  assert.equal(u.removeBargainBlock(result.value, 1).selected, -1); assert.throws(() => u.removeBargainBlock(rows, 1)); assert.throws(() => u.removeBargainBlock(rows, -1));
});

test('complete document guards reject nonarrays dangerous keys excessive depth and overbudget input without truncation', () => {
  const u = model(); for (const value of ['null', '{}', 'false', '{', '[{"__proto__":{}}]', '[{"constructor":0}]']) assert.throws(() => u.bargainDocument(value));
  assert.throws(() => u.bargainDocument(JSON.stringify([{ name: 'bargain', keep: 'a'.repeat(2_000_001) }])), /2 MB/);
  let nested = 1; for (let i = 0; i < 66; i++) nested = { next: nested }; assert.throws(() => u.bargainDocument(JSON.stringify([nested])), /64/);
});

test('atomic explicit leaf edits preserve complete metadata defaults and every dormant original value', () => {
  const u = model(), block = u.newBargainBlock(9); block.moduleColor.imported = { keep: [0, false] }; block.unknown = { image: ticket(77), ids: ['001'], raw: null };
  const before = clone(block); assert.equal(u.bargainSet(block, ['moduleColor', 'color', 0, 'item'], '#123456'), true);
  const expected = clone(before); expected.moduleColor.color[0].item = '#123456'; assert.deepEqual(block, expected);
  assert.equal(u.bargainSet(block, ['moduleColor', 'color', 0, 'item'], '#123456'), false);
  assert.equal(u.bargainSet(block, ['unknown', 'raw'], { keep: [false, ''] }), true); assert.deepEqual(block.unknown.raw, { keep: [false, ''] });
});

test('bad imported parents and unsafe paths cannot partially create or replace metadata', () => {
  const u = model();
  for (const block of [{ name: 'bargain', moduleColor: null }, { name: 'bargain', moduleColor: { color: false } }, { name: 'bargain', moduleColor: [] }]) {
    const before = clone(block); assert.throws(() => u.bargainSet(block, ['moduleColor', 'color', 0, 'item'], '#fff')); assert.deepEqual(block, before);
  }
  for (const pathValue of [[], ['__proto__', 'x'], ['constructor'], ['fillet', 'valList', -1], ['fillet', 'valList', .5], ['fillet', 'valList', 100001]]) {
    const block = u.newBargainBlock(1), before = clone(block); assert.throws(() => u.bargainSet(block, pathValue, 9)); assert.deepEqual(block, before);
  }
  assert.throws(() => u.bargainSet({ name: 'other' }, ['x'], 1));
});

test('metadata safety rejects unsupported JSON values and whole-candidate capacity before mutation', () => {
  const u = model(), block = u.newBargainBlock(1), before = clone(block), cyclic = {}; cyclic.self = cyclic;
  const getter = {}; Object.defineProperty(getter, 'val', { enumerable: true, get() { throw Error('Must not execute getter'); } });
  const symbol = { [Symbol('x')]: 1 }, sparse = Array(2); sparse[1] = 1;
  for (const value of [undefined, NaN, Infinity, () => 1, 1n, new Date(), cyclic, getter, symbol, sparse, JSON.parse('{"__proto__":1}')]) {
    assert.throws(() => u.bargainSet(block, ['metadata'], value)); assert.deepEqual(block, before);
  }
  assert.throws(() => u.bargainSet(block, ['metadata'], 'a'.repeat(2_000_001)), /2 MB/); assert.deepEqual(block, before);
});

test('numeric display and same-value typed events retain raw zero tiny exponent spacing and oversized spellings', () => {
  const u = model();
  for (const raw of [0, '0', '000', ' 5e-4 ', '003.000', ' 1e2 ', '1e30']) {
    const block = { name: 'bargain', length: { val: raw, min: 0, keep: [] } }, before = clone(block);
    assert.equal(u.bargainNumber(raw), Number(raw)); assert.equal(u.setBargainNumber(block, ['length', 'val'], Number(raw)), false); assert.deepEqual(block, before);
  }
  assert.equal(u.bargainNumber('bad', 6), 6); assert.equal(u.bargainNumber(' ', 6), 6); assert.equal(u.bargainNumber(-1, 6), 6); assert.equal(u.bargainNumber(200, 0, 100), 100);
  const block = { name: 'bargain', length: { val: '4', keep: false } }; assert.equal(u.setBargainNumber(block, ['length', 'val'], 5, 1, 100), true); assert.deepEqual(block.length, { val: 5, keep: false });
  for (const value of ['6', NaN, Infinity, -1, 101]) assert.throws(() => u.setBargainNumber(block, ['length', 'val'], value, 0, 100));
});

test('new quantity accepts integer1..100 while equal imported out-of-range events remain exact noops', () => {
  const u = model();
  for (const raw of [0, ' 0 ', '5e-4', ' 2e0 ', '003', '1e30']) {
    const block = { name: 'bargain', numberConfig: { val: raw, min: 1, keep: [] } }, before = clone(block);
    assert.equal(u.setBargainCount(block, Number(raw)), false); assert.deepEqual(block, before);
    assert.equal(u.setBargainCount(block, 17), true); assert.deepEqual(block.numberConfig, { val: 17, min: 1, keep: [] });
  }
  for (const value of [0, -1, .5, 2.5, 101, '6', NaN, Infinity]) { const block = u.newBargainBlock(1), before = clone(block); assert.throws(() => u.setBargainCount(block, value), /整数/); assert.deepEqual(block, before); }
  const block = { name: 'bargain', numberConfig: null }, before = clone(block); assert.throws(() => u.setBargainCount(block, 2)); assert.deepEqual(block, before);
});

test('public quantity is the existing TS floor/clamp10000 then min10 and never a saved rewrite or claimed PHP LIMIT', () => {
  const u = model(); for (const [raw, limit] of [[0, 0], ['0', 0], ['5e-4', 0], [' 2.99 ', 2], ['003', 3], [9, 9], [10, 10], ['1e30', 10], [undefined, 6], ['bad', 6]]) assert.equal(u.bargainPublicLimit(raw), limit);
  const block = { name: 'bargain', numberConfig: { val: '001000' }, isHide: true, unknown: [ticket(88)] }, before = clone(block); u.bargainPublicLimit(block.numberConfig.val); assert.deepEqual(block, before);
});

test('all three bundled PNGs preserve exact fixed PHP bytes independently on Admin and Uni with original140px title assets', () => {
  const sources = [
    ['bargain-bg.png', '26006d4b73f24ebde7437dc73ab80bb583c20882d8d956a68f034238521a2c76'],
    ['bargain-title.png', '7f0205406a3785e52bf75374f9f655d33fffbd6c06c9b758af63bb59782f2aea'],
    ['bargain-title-alt.png', '45299a139ab0a3dad07d69d0f5403d41b5fedcb8782c097f425984cb8f519509'],
  ];
  for (const [name, expected] of sources) {
    const admin = fs.readFileSync(path.join(root, '../public/static/images/diy', name)), uni = fs.readFileSync(path.join(root, '../../uniapp-ts/src/static/images/diy', name));
    assert.equal(createHash('sha256').update(admin).digest('hex'), expected); assert.deepEqual(admin, uni);
  }
  const png=fs.readFileSync(path.join(root,'../public/static/images/diy/bargain-title.png'));assert.equal(png.readUInt32BE(16),140);assert.equal(png.readUInt32BE(20),32);
});

test('canonical save touches only three precise bargain URL slots across every hidden and overflow component', () => {
  const u = model(), rows = Array.from({ length: 251 }, (_, i) => ({ name: 'bargain', timestamp: String(i), isHide: true, styleConfig: { tabVal: 0 }, titleConfig: { tabVal: 1 }, imgBgConfig: { url: ticket(11), image: ticket(91), name: 'metadata' }, imgConfig: { url: ticket(12) }, imgColorConfig: { url: ticket(13) }, productList: [{ image: ticket(21) }], unknown: { url: ticket(22) }, linkConfig: { value: ticket(23) }, numberConfig: { val: '003' } }));
  rows.push({ name: 'other', imgConfig: { url: ticket(99) } }); const before = clone(rows), saved = JSON.parse(u.canonicalBargainValue(JSON.stringify(rows)));
  const expected = clone(before); for (const row of expected.slice(0, 251)) { row.imgBgConfig.url = '/api/assets/11'; row.imgConfig.url = '/api/assets/12'; row.imgColorConfig.url = '/api/assets/13'; }
  assert.deepEqual(saved, expected); assert.deepEqual(rows, before); assert.deepEqual(u.canonicalBargainBlock(rows.at(-1)), rows.at(-1)); assert.throws(() => u.canonicalBargainValue('null'));
});

test('canonical image grammar rejects unsafe explicit selections without rewriting imported external entities unknown metadata or malformed slots', () => {
  const u = model(), row = { name: 'bargain', imgBgConfig: { url: 'http://example.com/x.png?keep=1' }, imgConfig: { url: '&#47;api&#47;assets&#47;12?signature=old' }, imgColorConfig: [ticket(13)], other: { url: ticket(14) } }, before = clone(row);
  assert.deepEqual(u.canonicalBargainBlock(row), before); assert.deepEqual(row, before);
  assert.equal(u.canonicalBargainImage(' '+ticket(17)+' '), '/api/assets/17'); assert.equal(u.canonicalBargainImage('/static/images/diy/bargain-bg.png'), '/static/images/diy/bargain-bg.png'); assert.equal(u.canonicalBargainImage(''), '');
  for (const raw of ['http://example.com/x.png', '//example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAA', '/a b.png', '/a\\b.png', null, '/'+ 'x'.repeat(4096)]) assert.throws(() => u.canonicalBargainImage(raw));
  for (const slot of ['imgConfig2','productList',0,null]) { const copy = clone(row); assert.throws(() => u.setBargainImage(copy, slot, '/safe.png')); assert.deepEqual(copy, row); }
});

test('explicit image choices are narrow atomic edits preserving original metadata and unsafe imported parents', () => {
  const u = model(), row = u.newBargainBlock(1), before = clone(row); assert.equal(u.setBargainImage(row, 'imgColorConfig', ticket(18)), true);
  const expected = clone(before); expected.imgColorConfig.url = '/api/assets/18'; assert.deepEqual(row, expected); assert.equal(u.setBargainImage(row, 'imgColorConfig', ticket(18)), false);
  for (const malformed of [null,[],false,'bad']) { const imported = { name: 'bargain', imgConfig: malformed }, original = clone(imported); assert.throws(() => u.setBargainImage(imported, 'imgConfig', '/a.png')); assert.deepEqual(imported, original); }
});

test('three managed image previews require an exact whole block slot and stable ref capability; saved raw JSON never receives tickets', () => {
  const u = model(), row = u.newBargainBlock(1); row.imgBgConfig.url = '/api/assets/11'; row.imgConfig.url = '/api/assets/12'; row.imgColorConfig.url = '/api/assets/13'; row.unknown = { image: ticket(77) };
  const before = clone(row), caps = u.BARGAIN_IMAGE_SLOTS.map((slot, i) => ({ ...u.bargainImageScope(row, slot), preview: ticket(i+11) }));
  assert.deepEqual(u.bargainImageScope(row,'imgConfig'), { block: JSON.stringify(row), slot: 'imgConfig', reference: '/api/assets/12' });
  const blank = u.bargainPreviewBlock(row); for (const slot of u.BARGAIN_IMAGE_SLOTS) assert.equal(blank[slot].url, '');
  const preview = u.bargainPreviewBlock(row,caps); for (const [i,slot] of u.BARGAIN_IMAGE_SLOTS.entries()) assert.equal(preview[slot].url,ticket(i+11)); assert.deepEqual(row,before); assert.deepEqual(preview.unknown,before.unknown);
  const saved = u.canonicalBargainBlock(preview); for (const [i,slot] of u.BARGAIN_IMAGE_SLOTS.entries()) assert.equal(saved[slot].url,`/api/assets/${i+11}`);
});

test('metadata raw reorder replace slot ref swap expired signature and old block capabilities fail closed', () => {
  const u = model(), row = u.newBargainBlock(1); for(const slot of u.BARGAIN_IMAGE_SLOTS) row[slot].url='/api/assets/11'; const cap = {...u.bargainImageScope(row,'imgConfig'),preview:ticket(11)};
  for(const change of [copy=>{copy.isHide=true;},copy=>{copy.unknown={};},copy=>{copy.imgConfig.url='/api/assets/12';},copy=>{copy.titleConfig.tabVal=1;},copy=>{copy.imgConfig.name='changed';}]) {const copy=clone(row);change(copy);assert.equal(u.bargainPreviewBlock(copy,[cap]).imgConfig.url,'');}
  for(const changed of [{...cap,slot:'imgColorConfig'},{...cap,reference:'/api/assets/12'},{...cap,preview:ticket(12)},{...cap,preview:ticket(11,1)},{...cap,preview:'/api/assets/11'},{...cap,preview:'/api/assets/11?expires=9999999999&signature=bad'}]) assert.equal(u.bargainPreviewBlock(row,[changed]).imgConfig.url,'');
  const reordered = Object.fromEntries(Object.entries(row).reverse()); assert.equal(u.bargainPreviewBlock(reordered,[cap]).imgConfig.url,'');
  const ticketInRaw=clone(row);ticketInRaw.imgConfig.url=ticket(11);assert.equal(u.bargainPreviewBlock(ticketInRaw,[cap]).imgConfig.url,'','Matching canonical ref cannot override a changed complete raw block');
  assert.throws(()=>u.bargainImageScope({name:'other'},'imgConfig'));assert.throws(()=>u.bargainImageScope(row,'image'));
});

test('static and safe external images project without media capabilities and never authorize an unknown or adjacent slot', () => {
  const u=model(),row=u.newBargainBlock(1),before=clone(row),preview=u.bargainPreviewBlock(row);
  assert.deepEqual(preview,row);row.imgConfig.url='https://images.example.com/title.png';assert.equal(u.bargainPreviewBlock(row).imgConfig.url,row.imgConfig.url);
  row.imgConfig.url=' http://images.example.com/title.png ';assert.equal(u.bargainPreviewBlock(row).imgConfig.url,'https://images.example.com/title.png');assert.equal(row.imgConfig.url,' http://images.example.com/title.png ');row.imgConfig.url='data:image/png;base64,AAA';assert.equal(u.bargainPreviewBlock(row).imgConfig.url,row.imgConfig.url);row.imgConfig.url='data:image/svg+xml;base64,AAA';assert.equal(u.bargainPreviewBlock(row).imgConfig.url,'');
  row.unknown={url:ticket(91)};row.productList=[{image:ticket(92)}];const projected=u.bargainPreviewBlock(row);assert.deepEqual(projected.unknown,row.unknown);assert.deepEqual(projected.productList,row.productList);
  assert.deepEqual(u.bargainPreviewBlock({name:'other',imgConfig:{url:ticket(93)}}),{name:'other',imgConfig:{url:ticket(93)}});assert.deepEqual(model().newBargainBlock(1),before);
});


test('original numeric0..3 author/public checkbox identities include typed3 but never coerce unknown imports',()=>{
 const u=model(),row=u.newBargainBlock(1);assert.deepEqual(u.BARGAIN_CHECKBOX_VALUES,[0,1,2,3]);assert.deepEqual(u.bargainChecks(row),[0,1,2,3]);assert.deepEqual(row.checkboxInfo.type,[0,1,2,3]);
 const imported={name:'bargain',checkboxInfo:{type:[4,'0',2,3,2,false,{id:1},0,99],list:[{id:0,name:'original'}],keep:false}},before=clone(imported);assert.deepEqual(u.bargainChecks(imported),[2,3,0]);assert.deepEqual(imported,before);assert.deepEqual(u.bargainChecks({name:'bargain',checkboxInfo:{type:null}}),[]);
});

test('same checkbox set retains original order duplicate known entries unknown values and all metadata',()=>{
 const u=model(),row={name:'bargain',checkboxInfo:{type:[4,'1',2,3,{id:17},0,2,3,false,99],list:[{id:3,name:'原划线价'}],default:[0,1,2,3]}},before=clone(row),original=row.checkboxInfo.type;
 assert.equal(u.setBargainChecks(row,[0,2,3]),false);assert.strictEqual(row.checkboxInfo.type,original);assert.deepEqual(row,before);assert.equal(u.setBargainChecks(row,[3,2,0]),false);assert.deepEqual(row,before);
});

test('explicit checkbox changes only selected numeric0..3 and preserves every unrelated entry in original positions',()=>{
 const u=model(),row={name:'bargain',checkboxInfo:{type:[4,'1',2,3,{id:17},0,2,3,false,99],list:[{id:3,name:'原划线价'}],default:[0,1,2,3]}},before=clone(row);
 assert.equal(u.setBargainChecks(row,[0,1,3]),true);const expected=clone(before);expected.checkboxInfo.type=[4,'1',3,{id:17},0,3,false,99,1];assert.deepEqual(row,expected);
 assert.equal(u.setBargainChecks(row,[]),true);expected.checkboxInfo.type=[4,'1',{id:17},false,99];assert.deepEqual(row,expected);assert.deepEqual(before.checkboxInfo.type,[4,'1',2,3,{id:17},0,2,3,false,99]);
 assert.equal(u.setBargainChecks(row,[2,3]),true);expected.checkboxInfo.type.push(2,3);assert.deepEqual(row,expected);
});

test('unsafe malformed oversized duplicated and coerced checkbox inputs fail atomically before any getter or raw rewrite',()=>{
 const u=model();for(const input of[undefined,null,{},'0',false,[4],[-1],['0'],[false],[0,0],[0,1,2,3,4],Array(1),[NaN],[Infinity],[[0]],[{id:0}]]){const row=u.newBargainBlock(1),before=clone(row);assert.throws(()=>u.setBargainChecks(row,input));assert.deepEqual(row,before);}
 const getter=[];Object.defineProperty(getter,'0',{enumerable:true,get(){throw Error('must not invoke getter');}});getter.length=1;const row=u.newBargainBlock(1),before=clone(row);assert.throws(()=>u.setBargainChecks(row,getter),/动态字段/);assert.deepEqual(row,before);
 for(const raw of[null,false,'bad',{}]){const row={name:'bargain',checkboxInfo:{type:raw,keep:[]}},before=clone(row);assert.throws(()=>u.setBargainChecks(row,[1]));assert.deepEqual(row,before);}
 assert.throws(()=>u.setBargainChecks({name:'other'},[1]));
 const missing={name:'bargain',checkboxInfo:{keep:false}};assert.equal(u.setBargainChecks(missing,[1,3]),true);assert.deepEqual(missing,{name:'bargain',checkboxInfo:{keep:false,type:[1,3]}});
});

test('bargain activity family never consumes homeComb page-header metadata or authorizes its images',()=>{
 const u=model(),home={name:'homeComb',timestamp:7,checkboxInfo:{type:[0,1,2,3]},imgConfig:{url:ticket(17)},unknown:{keep:false}},before=clone(home);
 assert.equal(u.bargainKind(home.name),null);assert.deepEqual(u.bargainEntries([home,{name:'bargain',timestamp:8}]),[{index:1,kind:'bargain'}]);assert.deepEqual(u.canonicalBargainBlock(home),home);assert.deepEqual(u.bargainPreviewBlock(home),home);
 for(const work of[()=>u.bargainSet(home,['opaque'],1),()=>u.setBargainChecks(home,[0]),()=>u.setBargainImage(home,'imgConfig','/static/a.png'),()=>u.removeBargainBlock([home],0),()=>u.bargainImageScope(home,'imgConfig')])assert.throws(work);assert.deepEqual(home,before);
});

test('typed old-price checkbox3 is editable independently without rewriting its imported duplicates or string twin',()=>{
 const u=model(),row={name:'bargain',checkboxInfo:{type:[3,'3',3,0],list:[{id:3,name:'原文字'}],unknown:7}};assert.equal(u.setBargainChecks(row,[0]),true);assert.deepEqual(row.checkboxInfo.type,['3',0]);assert.equal(u.setBargainChecks(row,[0,3]),true);assert.deepEqual(row.checkboxInfo.type,['3',0,3]);assert.deepEqual(row.checkboxInfo.list,[{id:3,name:'原文字'}]);assert.equal(row.checkboxInfo.unknown,7);
});
