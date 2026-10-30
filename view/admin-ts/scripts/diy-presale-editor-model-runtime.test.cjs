const { test, assert, path, fs, root, clone, loader, ticket } = require('./helpers/diy-navigation-runtime.cjs');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const utilFile = path.join(root, 'utils/diyPresaleEditor.ts'), defaultsFile = path.join(root, 'utils/diyPresaleDefaults.ts');
const model = () => loader().load(utilFile);

test('complete48-key presale default is the fixed PHP literal with only three explicit image substitutions', () => {
  // Fixed PHP8ed2a5b home_presale.vue193–656. No PHP, Vue or require expression executes.
  const tree = ts.createSourceFile(defaultsFile, fs.readFileSync(defaultsFile, 'utf8'), ts.ScriptTarget.Latest, true); let literal;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'DIY_PRESALE_DEFAULTS') literal = node.initializer; ts.forEachChild(node, visit); } visit(tree);
  function read(node) {
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => { assert.ok(ts.isPropertyAssignment(p)); return [p.name.text, read(p.initializer)]; }));
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(read);
    if (ts.isStringLiteral(node)) return node.text; if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false; if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    assert.fail('Only fixed static default literals are allowed');
  }
  const expected = read(literal), u = model(); assert.equal(Object.keys(expected).length, 48);
  const original = clone(expected); original.imgBgConfig.url = '@PHP_API_ROOT@/statics/images/presaleBg.png'; original.imgConfig.url = '@/assets/images/presale02.png'; original.imgColorConfig.url = '@/assets/images/presale01.png';
  assert.equal(createHash('sha256').update(JSON.stringify(original)).digest('hex'), 'df0ecc891e16518f6bd3c2a9326920606ebf91ddb362f71f533164a22b6647fb');
  assert.deepEqual(u.newPresaleBlock(19), { ...expected, timestamp: 19 });
  assert.equal(expected.styleConfig.tabVal, 1); assert.equal(expected.titleConfig.tabVal, 0); assert.equal(expected.goodStyleConfig.tabVal, 0);
  assert.deepEqual(expected.numberConfig, { title: '商品数量', val: 3, min: 1 }); assert.equal(expected.titleTxtConfig.max, 6); assert.equal(expected.rightBntConfig.max, 6);
  assert.equal(expected.titleText.tabList[2].style, 'italic'); assert.equal(expected.isHide, false);
  assert.deepEqual(expected.checkboxInfo.type,[0,1,2]); assert.deepEqual(expected.checkboxInfo.list.map(row=>[row.id,row.name]),[[0,'商品名称'],[1,'预售价格'],[2,'划线价']]); assert.equal(expected.presaleConfig.tabVal,0); assert.equal(expected.goodStyleConfig.tabList.length,4);
  assert.equal(expected.imgBgConfig.url, '/static/images/diy/presale-bg.png'); assert.equal(expected.imgConfig.url, '/static/images/diy/presale-title.png'); assert.equal(expected.imgColorConfig.url, '/static/images/diy/presale-title-alt.png');
});

test('new presale defaults are deep independent full metadata and never introduce saved product selection or arbitrary links', () => {
  const u = model(), first = u.newPresaleBlock(1), second = u.newPresaleBlock(2);
  first.fillet.valList[0].val = 99; first.filletImg.valList[1].val = 99; first.moduleColor.default[1].item = '#000'; first.imgConfig.name = 'changed';
  assert.equal(second.fillet.valList[0].val, 0); assert.equal(second.filletImg.valList[1].val, 0); assert.equal(second.moduleColor.default[1].item, '#fff'); assert.equal(second.imgConfig.name, '标题图片');
  for (const key of ['goodsList', 'productIds', 'selectConfig', 'brandConfig', 'linkConfig']) assert.equal(Object.hasOwn(second, key), false);
  assert.deepEqual(u.PRESALE_NAMES, ['presale']); assert.deepEqual(u.PRESALE_IMAGE_SLOTS, ['imgBgConfig', 'imgConfig', 'imgColorConfig']);
  for (const timestamp of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => u.newPresaleBlock(timestamp));
});

test('full imports remain complete and ordered discovery includes hidden duplicate malformed and overflow blocks', () => {
  const u = model(), rows = [{ name: 'unknown', timestamp: -99, raw: [] }, { name: 'presale', timestamp: ' 2e0 ', styleConfig: null }, null,
    ...Array.from({ length: 251 }, (_, i) => ({ name: 'presale', timestamp: i + 3, isHide: true, keep: [false, 0, ''] })), { name: 'presale', timestamp: -2 }, { name: 'presale', timestamp: 'bad' }], original = clone(rows);
  assert.deepEqual(u.presaleDocument(JSON.stringify(rows)), rows); assert.deepEqual(rows, original);
  const entries = u.presaleEntries(rows); assert.equal(entries.length, 254); assert.equal(entries[0].index, 254); assert.equal(entries[1].index, 1); assert.equal(entries.at(-1).index, 255);
  assert.deepEqual(u.PRESALE_NAMES, ['presale']); assert.equal(u.presaleKind('presale'), 'presale'); assert.equal(u.presaleKind('Presale'), null); assert.equal(u.presaleRecord([]), null);
  assert.equal(u.presaleRead({ x: [false] }, ['x', 0]), false); assert.equal(u.presaleFlag(' TRUE '), true); assert.equal(u.presaleFlag('false'), false); assert.equal(u.presaleText('  原文  '), '  原文  ');
});

test('ordinary component add inserts complete default before any footer and retains all unrelated raw neighbours', () => {
  const u = model(), rows = [{ name: 'titles', timestamp: ' 4.5 ', keep: ['a'] }, { name: 'unknown', timestamp: Number.MAX_SAFE_INTEGER }, { name: 'PageFoot', timestamp: 900, keep: false }], original = clone(rows);
  const first = u.addPresaleBlock(rows); assert.equal(first.selected, 2); assert.equal(first.value[2].timestamp, 5.5); assert.equal(Object.keys(first.value[2]).length, 48);
  assert.deepEqual(first.value.filter(row => row.name !== 'presale'), rows); assert.deepEqual(rows, original);
  const second = u.addPresaleBlock(first.value); assert.equal(second.value.filter(row => row.name === 'presale').length, 2); assert.equal(second.value.at(-1).name, 'PageFoot');
  assert.throws(() => u.addPresaleBlock([{ name: 'titles', timestamp: Number.MAX_SAFE_INTEGER }]), /排序空间不足/);
});

test('component movement follows the whole body order without normalizing imported timestamp spellings', () => {
  const u = model(), rows = [{ name: 'presale', timestamp: ' 2e0 ', keep: [false] }, { name: 'titles', timestamp: '1.0', text: '正文' }, { name: 'unknown', timestamp: -100 }, { name: 'presale', timestamp: 3 }], original = clone(rows);
  const moved = u.movePresaleBlock(rows, 0, -1); assert.equal(moved.selected, 1); assert.equal(moved.value[1].name, 'presale'); assert.equal(moved.value[1].timestamp, '1.0');
  assert.equal(moved.value[0].timestamp, ' 2e0 '); assert.deepEqual(moved.value[2], rows[2]); assert.deepEqual(rows, original);
  const back = u.movePresaleBlock(moved.value, 1, 1); assert.deepEqual(back.value, rows); assert.equal(back.selected, 0);
});

test('movement fences headers and footer and refuses ambiguous or missing source intent', () => {
  const u = model();
  for (const header of ['homeComb', 'headerSerch', 'tabNav']) {
    const rows = [{ name: header, timestamp: 1 }, { name: 'presale', timestamp: 2 }], before = clone(rows);
    assert.throws(() => u.movePresaleBlock(rows, 1, -1)); assert.deepEqual(rows, before);
  }
  for (const rows of [[{ name: 'presale', timestamp: 1 }, { name: 'titles', timestamp: 1 }], [{ name: 'presale' }, { name: 'titles', timestamp: 2 }], [{ name: 'presale', timestamp: 1 }, { name: 'pageFoot', timestamp: 2 }]]) {
    const original = clone(rows); assert.throws(() => u.movePresaleBlock(rows, 0, 1)); assert.deepEqual(rows, original);
  }
  const rows = [{ name: 'presale', timestamp: 1 }]; for (const [index, direction] of [[-1, 1], [0, 0], [0, .5], [0, -1]]) assert.throws(() => u.movePresaleBlock(rows, index, direction));
});

test('explicit removal deletes only the selected presale and selects the remaining rendered presale', () => {
  const u = model(), rows = [{ name: 'presale', timestamp: 3, keep: false }, { name: 'unknown', foo: [1] }, { name: 'presale', timestamp: '1' }], before = clone(rows);
  const result = u.removePresaleBlock(rows, 0); assert.deepEqual(result, { value: [rows[1], rows[2]], selected: 1 }); assert.deepEqual(rows, before);
  assert.equal(u.removePresaleBlock(result.value, 1).selected, -1); assert.throws(() => u.removePresaleBlock(rows, 1)); assert.throws(() => u.removePresaleBlock(rows, -1));
});

test('complete document guards reject nonarrays dangerous keys excessive depth and overbudget input without truncation', () => {
  const u = model(); for (const value of ['null', '{}', 'false', '{', '[{"__proto__":{}}]', '[{"constructor":0}]']) assert.throws(() => u.presaleDocument(value));
  assert.throws(() => u.presaleDocument(JSON.stringify([{ name: 'presale', keep: 'a'.repeat(2_000_001) }])), /2 MB/);
  let nested = 1; for (let i = 0; i < 66; i++) nested = { next: nested }; assert.throws(() => u.presaleDocument(JSON.stringify([nested])), /64/);
});

test('atomic explicit leaf edits preserve complete metadata defaults and every dormant original value', () => {
  const u = model(), block = u.newPresaleBlock(9); block.moduleColor.imported = { keep: [0, false] }; block.unknown = { image: ticket(77), ids: ['001'], raw: null };
  const before = clone(block); assert.equal(u.presaleSet(block, ['moduleColor', 'color', 0, 'item'], '#123456'), true);
  const expected = clone(before); expected.moduleColor.color[0].item = '#123456'; assert.deepEqual(block, expected);
  assert.equal(u.presaleSet(block, ['moduleColor', 'color', 0, 'item'], '#123456'), false);
  assert.equal(u.presaleSet(block, ['unknown', 'raw'], { keep: [false, ''] }), true); assert.deepEqual(block.unknown.raw, { keep: [false, ''] });
});

test('bad imported parents and unsafe paths cannot partially create or replace metadata', () => {
  const u = model();
  for (const block of [{ name: 'presale', moduleColor: null }, { name: 'presale', moduleColor: { color: false } }, { name: 'presale', moduleColor: [] }]) {
    const before = clone(block); assert.throws(() => u.presaleSet(block, ['moduleColor', 'color', 0, 'item'], '#fff')); assert.deepEqual(block, before);
  }
  for (const pathValue of [[], ['__proto__', 'x'], ['constructor'], ['fillet', 'valList', -1], ['fillet', 'valList', .5], ['fillet', 'valList', 100001]]) {
    const block = u.newPresaleBlock(1), before = clone(block); assert.throws(() => u.presaleSet(block, pathValue, 9)); assert.deepEqual(block, before);
  }
  assert.throws(() => u.presaleSet({ name: 'other' }, ['x'], 1));
});

test('metadata safety rejects unsupported JSON values and whole-candidate capacity before mutation', () => {
  const u = model(), block = u.newPresaleBlock(1), before = clone(block), cyclic = {}; cyclic.self = cyclic;
  const getter = {}; Object.defineProperty(getter, 'val', { enumerable: true, get() { throw Error('Must not execute getter'); } });
  const symbol = { [Symbol('x')]: 1 }, sparse = Array(2); sparse[1] = 1;
  for (const value of [undefined, NaN, Infinity, () => 1, 1n, new Date(), cyclic, getter, symbol, sparse, JSON.parse('{"__proto__":1}')]) {
    assert.throws(() => u.presaleSet(block, ['metadata'], value)); assert.deepEqual(block, before);
  }
  assert.throws(() => u.presaleSet(block, ['metadata'], 'a'.repeat(2_000_001)), /2 MB/); assert.deepEqual(block, before);
});

test('numeric display and same-value typed events retain raw zero tiny exponent spacing and oversized spellings', () => {
  const u = model();
  for (const raw of [0, '0', '000', ' 5e-4 ', '003.000', ' 1e2 ', '1e30']) {
    const block = { name: 'presale', length: { val: raw, min: 0, keep: [] } }, before = clone(block);
    assert.equal(u.presaleNumber(raw), Number(raw)); assert.equal(u.setPresaleNumber(block, ['length', 'val'], Number(raw)), false); assert.deepEqual(block, before);
  }
  assert.equal(u.presaleNumber('bad', 6), 6); assert.equal(u.presaleNumber(' ', 6), 6); assert.equal(u.presaleNumber(-1, 6), 6); assert.equal(u.presaleNumber(200, 0, 100), 100);
  const block = { name: 'presale', length: { val: '4', keep: false } }; assert.equal(u.setPresaleNumber(block, ['length', 'val'], 5, 1, 100), true); assert.deepEqual(block.length, { val: 5, keep: false });
  for (const value of ['6', NaN, Infinity, -1, 101]) assert.throws(() => u.setPresaleNumber(block, ['length', 'val'], value, 0, 100));
});

test('new quantity accepts integer1..100 while equal imported out-of-range events remain exact noops', () => {
  const u = model();
  for (const raw of [0, ' 0 ', '5e-4', ' 2e0 ', '003', '1e30']) {
    const block = { name: 'presale', numberConfig: { val: raw, min: 1, keep: [] } }, before = clone(block);
    assert.equal(u.setPresaleCount(block, Number(raw)), false); assert.deepEqual(block, before);
    assert.equal(u.setPresaleCount(block, 17), true); assert.deepEqual(block.numberConfig, { val: 17, min: 1, keep: [] });
  }
  for (const value of [0, -1, .5, 2.5, 101, '6', NaN, Infinity]) { const block = u.newPresaleBlock(1), before = clone(block); assert.throws(() => u.setPresaleCount(block, value), /整数/); assert.deepEqual(block, before); }
  const block = { name: 'presale', numberConfig: null }, before = clone(block); assert.throws(() => u.setPresaleCount(block, 2)); assert.deepEqual(block, before);
});

test('public quantity is the existing TS floor/clamp10000 then min10 and never a saved rewrite or claimed PHP LIMIT', () => {
  const u = model(); for (const [raw, limit] of [[0, 0], ['0', 0], ['5e-4', 0], [' 2.99 ', 2], ['003', 3], [9, 9], [10, 10], ['1e30', 10], [undefined, 6], ['bad', 6]]) assert.equal(u.presalePublicLimit(raw), limit);
  const block = { name: 'presale', numberConfig: { val: '001000' }, isHide: true, unknown: [ticket(88)] }, before = clone(block); u.presalePublicLimit(block.numberConfig.val); assert.deepEqual(block, before);
});

test('all four bundled PNGs preserve exact fixed PHP bytes independently on Admin and Uni, with icon outside authored defaults', () => {
  const sources = [
    ['presale-bg.png', '13bf2d6bfc6ebbdfe2c7981b61fefa3db1755d8112094f9a0804ece7693d730e'],
    ['presale-title.png', 'bcdff400fba8ad7e1436a0874e6c319253c16e566c887ed227a2131ade0db7ac'],
    ['presale-title-alt.png', 'd5ef072254794e45c47d6335a09da76e8ea4057c17a87648a8f3de12d52f9237'],
    ['presale-flash.png', 'f03c40e6005d5c820f263c63133146796b19378a0694eba5a998ed3d0652a4c9'],
  ];
  for (const [name, expected] of sources) {
    const admin = fs.readFileSync(path.join(root, '../public/static/images/diy', name)), uni = fs.readFileSync(path.join(root, '../../uniapp-ts/src/static/images/diy', name));
    assert.equal(createHash('sha256').update(admin).digest('hex'), expected); assert.deepEqual(admin, uni);
  }
  assert.equal(JSON.stringify(model().newPresaleBlock(1)).includes('presale-flash.png'), false);
});

test('canonical save touches only three precise presale URL slots across every hidden and overflow component', () => {
  const u = model(), rows = Array.from({ length: 251 }, (_, i) => ({ name: 'presale', timestamp: String(i), isHide: true, styleConfig: { tabVal: 0 }, titleConfig: { tabVal: 1 }, imgBgConfig: { url: ticket(11), image: ticket(91), name: 'metadata' }, imgConfig: { url: ticket(12) }, imgColorConfig: { url: ticket(13) }, productList: [{ image: ticket(21) }], unknown: { url: ticket(22) }, linkConfig: { value: ticket(23) }, numberConfig: { val: '003' } }));
  rows.push({ name: 'other', imgConfig: { url: ticket(99) } }); const before = clone(rows), saved = JSON.parse(u.canonicalPresaleValue(JSON.stringify(rows)));
  const expected = clone(before); for (const row of expected.slice(0, 251)) { row.imgBgConfig.url = '/api/assets/11'; row.imgConfig.url = '/api/assets/12'; row.imgColorConfig.url = '/api/assets/13'; }
  assert.deepEqual(saved, expected); assert.deepEqual(rows, before); assert.deepEqual(u.canonicalPresaleBlock(rows.at(-1)), rows.at(-1)); assert.throws(() => u.canonicalPresaleValue('null'));
});

test('canonical image grammar rejects unsafe explicit selections without rewriting imported external entities unknown metadata or malformed slots', () => {
  const u = model(), row = { name: 'presale', imgBgConfig: { url: 'http://example.com/x.png?keep=1' }, imgConfig: { url: '&#47;api&#47;assets&#47;12?signature=old' }, imgColorConfig: [ticket(13)], other: { url: ticket(14) } }, before = clone(row);
  assert.deepEqual(u.canonicalPresaleBlock(row), before); assert.deepEqual(row, before);
  assert.equal(u.canonicalPresaleImage(' '+ticket(17)+' '), '/api/assets/17'); assert.equal(u.canonicalPresaleImage('/static/images/diy/presale-bg.png'), '/static/images/diy/presale-bg.png'); assert.equal(u.canonicalPresaleImage(''), '');
  for (const raw of ['http://example.com/x.png', '//example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAA', '/a b.png', '/a\\b.png', null, '/'+ 'x'.repeat(4096)]) assert.throws(() => u.canonicalPresaleImage(raw));
  for (const slot of ['imgColorConfig','productList',0,null]) { const copy = clone(row); assert.throws(() => u.setPresaleImage(copy, slot, '/safe.png')); assert.deepEqual(copy, row); }
});

test('explicit image choices are narrow atomic edits preserving original metadata and unsafe imported parents', () => {
  const u = model(), row = u.newPresaleBlock(1), before = clone(row); assert.equal(u.setPresaleImage(row, 'imgColorConfig', ticket(18)), true);
  const expected = clone(before); expected.imgColorConfig.url = '/api/assets/18'; assert.deepEqual(row, expected); assert.equal(u.setPresaleImage(row, 'imgColorConfig', ticket(18)), false);
  for (const malformed of [null,[],false,'bad']) { const imported = { name: 'presale', imgConfig: malformed }, original = clone(imported); assert.throws(() => u.setPresaleImage(imported, 'imgConfig', '/a.png')); assert.deepEqual(imported, original); }
});

test('three managed image previews require an exact whole block slot and stable ref capability; saved raw JSON never receives tickets', () => {
  const u = model(), row = u.newPresaleBlock(1); row.imgBgConfig.url = '/api/assets/11'; row.imgConfig.url = '/api/assets/12'; row.imgColorConfig.url = '/api/assets/13'; row.unknown = { image: ticket(77) };
  const before = clone(row), caps = u.PRESALE_IMAGE_SLOTS.map((slot, i) => ({ ...u.presaleImageScope(row, slot), preview: ticket(i+11) }));
  assert.deepEqual(u.presaleImageScope(row,'imgConfig'), { block: JSON.stringify(row), slot: 'imgConfig', reference: '/api/assets/12' });
  const blank = u.presalePreviewBlock(row); for (const slot of u.PRESALE_IMAGE_SLOTS) assert.equal(blank[slot].url, '');
  const preview = u.presalePreviewBlock(row,caps); for (const [i,slot] of u.PRESALE_IMAGE_SLOTS.entries()) assert.equal(preview[slot].url,ticket(i+11)); assert.deepEqual(row,before); assert.deepEqual(preview.unknown,before.unknown);
  const saved = u.canonicalPresaleBlock(preview); for (const [i,slot] of u.PRESALE_IMAGE_SLOTS.entries()) assert.equal(saved[slot].url,`/api/assets/${i+11}`);
});

test('metadata raw reorder replace slot ref swap expired signature and old block capabilities fail closed', () => {
  const u = model(), row = u.newPresaleBlock(1); for(const slot of u.PRESALE_IMAGE_SLOTS) row[slot].url='/api/assets/11'; const cap = {...u.presaleImageScope(row,'imgConfig'),preview:ticket(11)};
  for(const change of [copy=>{copy.isHide=true;},copy=>{copy.unknown={};},copy=>{copy.imgConfig.url='/api/assets/12';},copy=>{copy.titleConfig.tabVal=1;},copy=>{copy.imgConfig.name='changed';}]) {const copy=clone(row);change(copy);assert.equal(u.presalePreviewBlock(copy,[cap]).imgConfig.url,'');}
  for(const changed of [{...cap,slot:'imgColorConfig'},{...cap,reference:'/api/assets/12'},{...cap,preview:ticket(12)},{...cap,preview:ticket(11,1)},{...cap,preview:'/api/assets/11'},{...cap,preview:'/api/assets/11?expires=9999999999&signature=bad'}]) assert.equal(u.presalePreviewBlock(row,[changed]).imgConfig.url,'');
  const reordered = Object.fromEntries(Object.entries(row).reverse()); assert.equal(u.presalePreviewBlock(reordered,[cap]).imgConfig.url,'');
  const ticketInRaw=clone(row);ticketInRaw.imgConfig.url=ticket(11);assert.equal(u.presalePreviewBlock(ticketInRaw,[cap]).imgConfig.url,'','Matching canonical ref cannot override a changed complete raw block');
  assert.throws(()=>u.presaleImageScope({name:'other'},'imgConfig'));assert.throws(()=>u.presaleImageScope(row,'image'));
});

test('static and safe external images project without media capabilities and never authorize an unknown or adjacent slot', () => {
  const u=model(),row=u.newPresaleBlock(1),before=clone(row),preview=u.presalePreviewBlock(row);
  assert.deepEqual(preview,row);row.imgConfig.url='https://images.example.com/title.png';assert.equal(u.presalePreviewBlock(row).imgConfig.url,row.imgConfig.url);
  row.imgConfig.url=' http://images.example.com/title.png ';assert.equal(u.presalePreviewBlock(row).imgConfig.url,'https://images.example.com/title.png');assert.equal(row.imgConfig.url,' http://images.example.com/title.png ');row.imgConfig.url='data:image/png;base64,AAA';assert.equal(u.presalePreviewBlock(row).imgConfig.url,row.imgConfig.url);row.imgConfig.url='data:image/svg+xml;base64,AAA';assert.equal(u.presalePreviewBlock(row).imgConfig.url,'');
  row.unknown={url:ticket(91)};row.productList=[{image:ticket(92)}];const projected=u.presalePreviewBlock(row);assert.deepEqual(projected.unknown,row.unknown);assert.deepEqual(projected.productList,row.productList);
  assert.deepEqual(u.presalePreviewBlock({name:'other',imgConfig:{url:ticket(93)}}),{name:'other',imgConfig:{url:ticket(93)}});assert.deepEqual(model().newPresaleBlock(1),before);
});


test('checkbox display retains original author0/1/2 identities and never translates to public0/2/3',()=>{
 const u=model(),row=u.newPresaleBlock(1);assert.deepEqual(u.PRESALE_CHECKBOX_VALUES,[0,1,2]);assert.deepEqual(u.presaleChecks(row),[0,1,2]);assert.deepEqual(row.checkboxInfo.type,[0,1,2]);
 const imported={name:'presale',checkboxInfo:{type:[3,'0',2,2,false,{id:1},0,99],list:[{id:0,name:'original'}],keep:false}},before=clone(imported);assert.deepEqual(u.presaleChecks(imported),[2,0]);assert.deepEqual(imported,before);assert.deepEqual(u.presaleChecks({name:'presale',checkboxInfo:{type:null}}),[]);
});

test('same checkbox set keeps exact duplicates unknown entries order and original metadata rather than accepting UI reorder',()=>{
 const u=model(),row={name:'presale',checkboxInfo:{type:[3,'1',2,{id:17},0,2,false,99],list:[{id:2,name:'原划线价'}],default:[0,1,2]}},before=clone(row),original=row.checkboxInfo.type;
 assert.equal(u.setPresaleChecks(row,[0,2]),false);assert.strictEqual(row.checkboxInfo.type,original);assert.deepEqual(row,before);assert.equal(u.setPresaleChecks(row,[2,0]),false);assert.deepEqual(row,before);
});

test('explicit checkbox changes remove only unchecked known numbers and append new originals while preserving actual-public3 strings and objects',()=>{
 const u=model(),row={name:'presale',checkboxInfo:{type:[3,'1',2,{id:17},0,2,false,99],list:[{id:2,name:'原划线价'}],default:[0,1,2]}},before=clone(row);
 assert.equal(u.setPresaleChecks(row,[0,1]),true);const expected=clone(before);expected.checkboxInfo.type=[3,'1',{id:17},0,false,99,1];assert.deepEqual(row,expected);
 assert.equal(u.setPresaleChecks(row,[]),true);expected.checkboxInfo.type=[3,'1',{id:17},false,99];assert.deepEqual(row,expected);assert.deepEqual(before.checkboxInfo.type,[3,'1',2,{id:17},0,2,false,99]);
 assert.equal(u.setPresaleChecks(row,[2]),true);expected.checkboxInfo.type.push(2);assert.deepEqual(row,expected);
});

test('checkbox setter rejects unsafe requested identities and malformed raw parents atomically without dropping unknown values',()=>{
 const u=model();for(const input of[undefined,null,{},'0',false,[3],[-1],['0'],[false],[0,0],[0,1,2,3],Array(1),[NaN],[Infinity],[[0]],[{id:0}]]){const row=u.newPresaleBlock(1),before=clone(row);assert.throws(()=>u.setPresaleChecks(row,input));assert.deepEqual(row,before);}
 const getter=[];Object.defineProperty(getter,'0',{enumerable:true,get(){throw Error('must not invoke getter');}});getter.length=1;const row=u.newPresaleBlock(1),before=clone(row);assert.throws(()=>u.setPresaleChecks(row,getter),/动态字段/);assert.deepEqual(row,before);
 for(const raw of[null,false,'bad',{}]){const row={name:'presale',checkboxInfo:{type:raw,keep:[]}},before=clone(row);assert.throws(()=>u.setPresaleChecks(row,[1]));assert.deepEqual(row,before);}
 assert.throws(()=>u.setPresaleChecks({name:'other'},[1]));
 const missing={name:'presale',checkboxInfo:{keep:false}};assert.equal(u.setPresaleChecks(missing,[1]),true);assert.deepEqual(missing,{name:'presale',checkboxInfo:{keep:false,type:[1]}});
});
