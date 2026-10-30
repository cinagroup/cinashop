const { test, assert, path, fs, root, clone, loader, ticket } = require('./helpers/diy-navigation-runtime.cjs');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const utilFile = path.join(root, 'utils/diySeckillEditor.ts'), defaultsFile = path.join(root, 'utils/diySeckillDefaults.ts');
const model = () => loader().load(utilFile);

test('complete53-key seckill default is the fixed PHP literal with only three explicit image substitutions', () => {
  // Fixed PHP8ed2a5b home_seckill.vue229–792. No PHP, Vue or require expression executes.
  const tree = ts.createSourceFile(defaultsFile, fs.readFileSync(defaultsFile, 'utf8'), ts.ScriptTarget.Latest, true); let literal;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'DIY_SECKILL_DEFAULTS') literal = node.initializer; ts.forEachChild(node, visit); } visit(tree);
  function read(node) {
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => { assert.ok(ts.isPropertyAssignment(p)); return [p.name.text, read(p.initializer)]; }));
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(read);
    if (ts.isStringLiteral(node)) return node.text; if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false; if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    assert.fail('Only fixed static default literals are allowed');
  }
  const expected = read(literal), u = model(); assert.equal(Object.keys(expected).length, 53);
  const original = clone(expected); original.imgBgConfig.url = '@PHP_API_ROOT@/statics/images/seckillBg.png'; original.imgConfig.url = '@/assets/images/seckill02.png'; original.imgColorConfig.url = '@/assets/images/seckill01.png';
  assert.equal(createHash('sha256').update(JSON.stringify(original)).digest('hex'), '1585380fd914c59c16da9de5ad7c978006dfaaead80ff6013b01ff6ccf0daa20');
  assert.deepEqual(u.newSeckillBlock(19), { ...expected, timestamp: 19 });
  assert.equal(expected.styleConfig.tabVal, 1); assert.equal(expected.titleConfig.tabVal, 0); assert.equal(expected.goodStyleConfig.tabVal, 0);
  assert.deepEqual(expected.numberConfig, { title: '商品数量', val: 3, min: 1 }); assert.equal(expected.titleTxtConfig.max, 6); assert.equal(expected.rightBntConfig.max, 6);
  assert.equal(expected.titleText.tabList[2].style, 'italic'); assert.equal(expected.isHide, false);
  assert.deepEqual(expected.checkboxInfo.type,[0,1,2,3]); assert.deepEqual(expected.checkboxInfo.list.map(row=>[row.id,row.name]),[[0,'商品名称'],[1,'秒杀进度'],[2,'商品价格'],[3,'划线价']]); assert.equal(expected.seckillConfig.tabVal,0); assert.equal(expected.goodStyleConfig.tabList.length,4);
  assert.equal(expected.titleTxtConfig.value,'限时秒杀'); assert.equal(expected.imgConfig.info,'建议：154px * 32px'); assert.equal(expected.imgColorConfig.info,'建议：154px * 32px'); assert.equal(expected.progressTxtColor.name,'progressTxtColor'); assert.equal(expected.numberBgColor2.color[0].item,'#E93323');
  assert.equal(expected.imgBgConfig.url, '/static/images/diy/seckill-bg.png'); assert.equal(expected.imgConfig.url, '/static/images/diy/seckill-title.png'); assert.equal(expected.imgColorConfig.url, '/static/images/diy/seckill-title-alt.png');
});

test('new seckill defaults are deep independent full metadata and never introduce saved product selection or arbitrary links', () => {
  const u = model(), first = u.newSeckillBlock(1), second = u.newSeckillBlock(2);
  first.fillet.valList[0].val = 99; first.filletImg.valList[1].val = 99; first.moduleColor.default[1].item = '#000'; first.imgConfig.name = 'changed';
  assert.equal(second.fillet.valList[0].val, 0); assert.equal(second.filletImg.valList[1].val, 0); assert.equal(second.moduleColor.default[1].item, '#fff'); assert.equal(second.imgConfig.name, '标题图片');
  for (const key of ['goodsList', 'productIds', 'selectConfig', 'brandConfig', 'linkConfig']) assert.equal(Object.hasOwn(second, key), false);
  assert.deepEqual(u.SECKILL_NAMES, ['seckill']); assert.deepEqual(u.SECKILL_IMAGE_SLOTS, ['imgBgConfig', 'imgConfig', 'imgColorConfig']);
  for (const timestamp of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => u.newSeckillBlock(timestamp));
});

test('full imports remain complete and ordered discovery includes hidden duplicate malformed and overflow blocks', () => {
  const u = model(), rows = [{ name: 'unknown', timestamp: -99, raw: [] }, { name: 'seckill', timestamp: ' 2e0 ', styleConfig: null }, null,
    ...Array.from({ length: 251 }, (_, i) => ({ name: 'seckill', timestamp: i + 3, isHide: true, keep: [false, 0, ''] })), { name: 'seckill', timestamp: -2 }, { name: 'seckill', timestamp: 'bad' }], original = clone(rows);
  assert.deepEqual(u.seckillDocument(JSON.stringify(rows)), rows); assert.deepEqual(rows, original);
  const entries = u.seckillEntries(rows); assert.equal(entries.length, 254); assert.equal(entries[0].index, 254); assert.equal(entries[1].index, 1); assert.equal(entries.at(-1).index, 255);
  assert.deepEqual(u.SECKILL_NAMES, ['seckill']); assert.equal(u.seckillKind('seckill'), 'seckill'); assert.equal(u.seckillKind('Seckill'), null); assert.equal(u.seckillRecord([]), null);
  assert.equal(u.seckillRead({ x: [false] }, ['x', 0]), false); assert.equal(u.seckillFlag(' TRUE '), true); assert.equal(u.seckillFlag('false'), false); assert.equal(u.seckillText('  原文  '), '  原文  ');
});

test('ordinary component add inserts complete default before any footer and retains all unrelated raw neighbours', () => {
  const u = model(), rows = [{ name: 'titles', timestamp: ' 4.5 ', keep: ['a'] }, { name: 'unknown', timestamp: Number.MAX_SAFE_INTEGER }, { name: 'PageFoot', timestamp: 900, keep: false }], original = clone(rows);
  const first = u.addSeckillBlock(rows); assert.equal(first.selected, 2); assert.equal(first.value[2].timestamp, 5.5); assert.equal(Object.keys(first.value[2]).length, 53);
  assert.deepEqual(first.value.filter(row => row.name !== 'seckill'), rows); assert.deepEqual(rows, original);
  const second = u.addSeckillBlock(first.value); assert.equal(second.value.filter(row => row.name === 'seckill').length, 2); assert.equal(second.value.at(-1).name, 'PageFoot');
  assert.throws(() => u.addSeckillBlock([{ name: 'titles', timestamp: Number.MAX_SAFE_INTEGER }]), /排序空间不足/);
});

test('component movement follows the whole body order without normalizing imported timestamp spellings', () => {
  const u = model(), rows = [{ name: 'seckill', timestamp: ' 2e0 ', keep: [false] }, { name: 'titles', timestamp: '1.0', text: '正文' }, { name: 'unknown', timestamp: -100 }, { name: 'seckill', timestamp: 3 }], original = clone(rows);
  const moved = u.moveSeckillBlock(rows, 0, -1); assert.equal(moved.selected, 1); assert.equal(moved.value[1].name, 'seckill'); assert.equal(moved.value[1].timestamp, '1.0');
  assert.equal(moved.value[0].timestamp, ' 2e0 '); assert.deepEqual(moved.value[2], rows[2]); assert.deepEqual(rows, original);
  const back = u.moveSeckillBlock(moved.value, 1, 1); assert.deepEqual(back.value, rows); assert.equal(back.selected, 0);
});

test('movement fences headers and footer and refuses ambiguous or missing source intent', () => {
  const u = model();
  for (const header of ['homeComb', 'headerSerch', 'tabNav']) {
    const rows = [{ name: header, timestamp: 1 }, { name: 'seckill', timestamp: 2 }], before = clone(rows);
    assert.throws(() => u.moveSeckillBlock(rows, 1, -1)); assert.deepEqual(rows, before);
  }
  for (const rows of [[{ name: 'seckill', timestamp: 1 }, { name: 'titles', timestamp: 1 }], [{ name: 'seckill' }, { name: 'titles', timestamp: 2 }], [{ name: 'seckill', timestamp: 1 }, { name: 'pageFoot', timestamp: 2 }]]) {
    const original = clone(rows); assert.throws(() => u.moveSeckillBlock(rows, 0, 1)); assert.deepEqual(rows, original);
  }
  const rows = [{ name: 'seckill', timestamp: 1 }]; for (const [index, direction] of [[-1, 1], [0, 0], [0, .5], [0, -1]]) assert.throws(() => u.moveSeckillBlock(rows, index, direction));
});

test('explicit removal deletes only the selected seckill and selects the remaining rendered seckill', () => {
  const u = model(), rows = [{ name: 'seckill', timestamp: 3, keep: false }, { name: 'unknown', foo: [1] }, { name: 'seckill', timestamp: '1' }], before = clone(rows);
  const result = u.removeSeckillBlock(rows, 0); assert.deepEqual(result, { value: [rows[1], rows[2]], selected: 1 }); assert.deepEqual(rows, before);
  assert.equal(u.removeSeckillBlock(result.value, 1).selected, -1); assert.throws(() => u.removeSeckillBlock(rows, 1)); assert.throws(() => u.removeSeckillBlock(rows, -1));
});

test('complete document guards reject nonarrays dangerous keys excessive depth and overbudget input without truncation', () => {
  const u = model(); for (const value of ['null', '{}', 'false', '{', '[{"__proto__":{}}]', '[{"constructor":0}]']) assert.throws(() => u.seckillDocument(value));
  assert.throws(() => u.seckillDocument(JSON.stringify([{ name: 'seckill', keep: 'a'.repeat(2_000_001) }])), /2 MB/);
  let nested = 1; for (let i = 0; i < 66; i++) nested = { next: nested }; assert.throws(() => u.seckillDocument(JSON.stringify([nested])), /64/);
});

test('atomic explicit leaf edits preserve complete metadata defaults and every dormant original value', () => {
  const u = model(), block = u.newSeckillBlock(9); block.moduleColor.imported = { keep: [0, false] }; block.unknown = { image: ticket(77), ids: ['001'], raw: null };
  const before = clone(block); assert.equal(u.seckillSet(block, ['moduleColor', 'color', 0, 'item'], '#123456'), true);
  const expected = clone(before); expected.moduleColor.color[0].item = '#123456'; assert.deepEqual(block, expected);
  assert.equal(u.seckillSet(block, ['moduleColor', 'color', 0, 'item'], '#123456'), false);
  assert.equal(u.seckillSet(block, ['unknown', 'raw'], { keep: [false, ''] }), true); assert.deepEqual(block.unknown.raw, { keep: [false, ''] });
});

test('bad imported parents and unsafe paths cannot partially create or replace metadata', () => {
  const u = model();
  for (const block of [{ name: 'seckill', moduleColor: null }, { name: 'seckill', moduleColor: { color: false } }, { name: 'seckill', moduleColor: [] }]) {
    const before = clone(block); assert.throws(() => u.seckillSet(block, ['moduleColor', 'color', 0, 'item'], '#fff')); assert.deepEqual(block, before);
  }
  for (const pathValue of [[], ['__proto__', 'x'], ['constructor'], ['fillet', 'valList', -1], ['fillet', 'valList', .5], ['fillet', 'valList', 100001]]) {
    const block = u.newSeckillBlock(1), before = clone(block); assert.throws(() => u.seckillSet(block, pathValue, 9)); assert.deepEqual(block, before);
  }
  assert.throws(() => u.seckillSet({ name: 'other' }, ['x'], 1));
});

test('metadata safety rejects unsupported JSON values and whole-candidate capacity before mutation', () => {
  const u = model(), block = u.newSeckillBlock(1), before = clone(block), cyclic = {}; cyclic.self = cyclic;
  const getter = {}; Object.defineProperty(getter, 'val', { enumerable: true, get() { throw Error('Must not execute getter'); } });
  const symbol = { [Symbol('x')]: 1 }, sparse = Array(2); sparse[1] = 1;
  for (const value of [undefined, NaN, Infinity, () => 1, 1n, new Date(), cyclic, getter, symbol, sparse, JSON.parse('{"__proto__":1}')]) {
    assert.throws(() => u.seckillSet(block, ['metadata'], value)); assert.deepEqual(block, before);
  }
  assert.throws(() => u.seckillSet(block, ['metadata'], 'a'.repeat(2_000_001)), /2 MB/); assert.deepEqual(block, before);
});

test('numeric display and same-value typed events retain raw zero tiny exponent spacing and oversized spellings', () => {
  const u = model();
  for (const raw of [0, '0', '000', ' 5e-4 ', '003.000', ' 1e2 ', '1e30']) {
    const block = { name: 'seckill', length: { val: raw, min: 0, keep: [] } }, before = clone(block);
    assert.equal(u.seckillNumber(raw), Number(raw)); assert.equal(u.setSeckillNumber(block, ['length', 'val'], Number(raw)), false); assert.deepEqual(block, before);
  }
  assert.equal(u.seckillNumber('bad', 6), 6); assert.equal(u.seckillNumber(' ', 6), 6); assert.equal(u.seckillNumber(-1, 6), 6); assert.equal(u.seckillNumber(200, 0, 100), 100);
  const block = { name: 'seckill', length: { val: '4', keep: false } }; assert.equal(u.setSeckillNumber(block, ['length', 'val'], 5, 1, 100), true); assert.deepEqual(block.length, { val: 5, keep: false });
  for (const value of ['6', NaN, Infinity, -1, 101]) assert.throws(() => u.setSeckillNumber(block, ['length', 'val'], value, 0, 100));
});

test('new quantity accepts integer1..100 while equal imported out-of-range events remain exact noops', () => {
  const u = model();
  for (const raw of [0, ' 0 ', '5e-4', ' 2e0 ', '003', '1e30']) {
    const block = { name: 'seckill', numberConfig: { val: raw, min: 1, keep: [] } }, before = clone(block);
    assert.equal(u.setSeckillCount(block, Number(raw)), false); assert.deepEqual(block, before);
    assert.equal(u.setSeckillCount(block, 17), true); assert.deepEqual(block.numberConfig, { val: 17, min: 1, keep: [] });
  }
  for (const value of [0, -1, .5, 2.5, 101, '6', NaN, Infinity]) { const block = u.newSeckillBlock(1), before = clone(block); assert.throws(() => u.setSeckillCount(block, value), /整数/); assert.deepEqual(block, before); }
  const block = { name: 'seckill', numberConfig: null }, before = clone(block); assert.throws(() => u.setSeckillCount(block, 2)); assert.deepEqual(block, before);
});

test('public quantity is the existing TS floor/clamp10000 then min10 and never a saved rewrite or claimed PHP LIMIT', () => {
  const u = model(); for (const [raw, limit] of [[0, 0], ['0', 0], ['5e-4', 0], [' 2.99 ', 2], ['003', 3], [9, 9], [10, 10], ['1e30', 10], [undefined, 6], ['bad', 6]]) assert.equal(u.seckillPublicLimit(raw), limit);
  const block = { name: 'seckill', numberConfig: { val: '001000' }, isHide: true, unknown: [ticket(88)] }, before = clone(block); u.seckillPublicLimit(block.numberConfig.val); assert.deepEqual(block, before);
});

test('all three bundled PNGs preserve exact fixed PHP bytes independently on Admin and Uni with original154px title assets', () => {
  const sources = [
    ['seckill-bg.png', '3fe120cae5fc77d695f278287ccee3d443aa754c31121e9e4ef3b9eb20df06e9'],
    ['seckill-title.png', 'da308c25e644803f8dd2dc48a816a5f362bd91047d6db17ffae6c2186d35cd43'],
    ['seckill-title-alt.png', '1105e53f2687407575e02f0b25d478336cde1cbf26a947f6b98b5e4f85f76c56'],
  ];
  for (const [name, expected] of sources) {
    const admin = fs.readFileSync(path.join(root, '../public/static/images/diy', name)), uni = fs.readFileSync(path.join(root, '../../uniapp-ts/src/static/images/diy', name));
    assert.equal(createHash('sha256').update(admin).digest('hex'), expected); assert.deepEqual(admin, uni);
  }
  const png=fs.readFileSync(path.join(root,'../public/static/images/diy/seckill-title.png'));assert.equal(png.readUInt32BE(16),154);assert.equal(png.readUInt32BE(20),32);
});

test('canonical save touches only three precise seckill URL slots across every hidden and overflow component', () => {
  const u = model(), rows = Array.from({ length: 251 }, (_, i) => ({ name: 'seckill', timestamp: String(i), isHide: true, styleConfig: { tabVal: 0 }, titleConfig: { tabVal: 1 }, imgBgConfig: { url: ticket(11), image: ticket(91), name: 'metadata' }, imgConfig: { url: ticket(12) }, imgColorConfig: { url: ticket(13) }, productList: [{ image: ticket(21) }], unknown: { url: ticket(22) }, linkConfig: { value: ticket(23) }, numberConfig: { val: '003' } }));
  rows.push({ name: 'other', imgConfig: { url: ticket(99) } }); const before = clone(rows), saved = JSON.parse(u.canonicalSeckillValue(JSON.stringify(rows)));
  const expected = clone(before); for (const row of expected.slice(0, 251)) { row.imgBgConfig.url = '/api/assets/11'; row.imgConfig.url = '/api/assets/12'; row.imgColorConfig.url = '/api/assets/13'; }
  assert.deepEqual(saved, expected); assert.deepEqual(rows, before); assert.deepEqual(u.canonicalSeckillBlock(rows.at(-1)), rows.at(-1)); assert.throws(() => u.canonicalSeckillValue('null'));
});

test('canonical image grammar rejects unsafe explicit selections without rewriting imported external entities unknown metadata or malformed slots', () => {
  const u = model(), row = { name: 'seckill', imgBgConfig: { url: 'http://example.com/x.png?keep=1' }, imgConfig: { url: '&#47;api&#47;assets&#47;12?signature=old' }, imgColorConfig: [ticket(13)], other: { url: ticket(14) } }, before = clone(row);
  assert.deepEqual(u.canonicalSeckillBlock(row), before); assert.deepEqual(row, before);
  assert.equal(u.canonicalSeckillImage(' '+ticket(17)+' '), '/api/assets/17'); assert.equal(u.canonicalSeckillImage('/static/images/diy/seckill-bg.png'), '/static/images/diy/seckill-bg.png'); assert.equal(u.canonicalSeckillImage(''), '');
  for (const raw of ['http://example.com/x.png', '//example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAA', '/a b.png', '/a\\b.png', null, '/'+ 'x'.repeat(4096)]) assert.throws(() => u.canonicalSeckillImage(raw));
  for (const slot of ['imgConfig2','productList',0,null]) { const copy = clone(row); assert.throws(() => u.setSeckillImage(copy, slot, '/safe.png')); assert.deepEqual(copy, row); }
});

test('explicit image choices are narrow atomic edits preserving original metadata and unsafe imported parents', () => {
  const u = model(), row = u.newSeckillBlock(1), before = clone(row); assert.equal(u.setSeckillImage(row, 'imgColorConfig', ticket(18)), true);
  const expected = clone(before); expected.imgColorConfig.url = '/api/assets/18'; assert.deepEqual(row, expected); assert.equal(u.setSeckillImage(row, 'imgColorConfig', ticket(18)), false);
  for (const malformed of [null,[],false,'bad']) { const imported = { name: 'seckill', imgConfig: malformed }, original = clone(imported); assert.throws(() => u.setSeckillImage(imported, 'imgConfig', '/a.png')); assert.deepEqual(imported, original); }
});

test('three managed image previews require an exact whole block slot and stable ref capability; saved raw JSON never receives tickets', () => {
  const u = model(), row = u.newSeckillBlock(1); row.imgBgConfig.url = '/api/assets/11'; row.imgConfig.url = '/api/assets/12'; row.imgColorConfig.url = '/api/assets/13'; row.unknown = { image: ticket(77) };
  const before = clone(row), caps = u.SECKILL_IMAGE_SLOTS.map((slot, i) => ({ ...u.seckillImageScope(row, slot), preview: ticket(i+11) }));
  assert.deepEqual(u.seckillImageScope(row,'imgConfig'), { block: JSON.stringify(row), slot: 'imgConfig', reference: '/api/assets/12' });
  const blank = u.seckillPreviewBlock(row); for (const slot of u.SECKILL_IMAGE_SLOTS) assert.equal(blank[slot].url, '');
  const preview = u.seckillPreviewBlock(row,caps); for (const [i,slot] of u.SECKILL_IMAGE_SLOTS.entries()) assert.equal(preview[slot].url,ticket(i+11)); assert.deepEqual(row,before); assert.deepEqual(preview.unknown,before.unknown);
  const saved = u.canonicalSeckillBlock(preview); for (const [i,slot] of u.SECKILL_IMAGE_SLOTS.entries()) assert.equal(saved[slot].url,`/api/assets/${i+11}`);
});

test('metadata raw reorder replace slot ref swap expired signature and old block capabilities fail closed', () => {
  const u = model(), row = u.newSeckillBlock(1); for(const slot of u.SECKILL_IMAGE_SLOTS) row[slot].url='/api/assets/11'; const cap = {...u.seckillImageScope(row,'imgConfig'),preview:ticket(11)};
  for(const change of [copy=>{copy.isHide=true;},copy=>{copy.unknown={};},copy=>{copy.imgConfig.url='/api/assets/12';},copy=>{copy.titleConfig.tabVal=1;},copy=>{copy.imgConfig.name='changed';}]) {const copy=clone(row);change(copy);assert.equal(u.seckillPreviewBlock(copy,[cap]).imgConfig.url,'');}
  for(const changed of [{...cap,slot:'imgColorConfig'},{...cap,reference:'/api/assets/12'},{...cap,preview:ticket(12)},{...cap,preview:ticket(11,1)},{...cap,preview:'/api/assets/11'},{...cap,preview:'/api/assets/11?expires=9999999999&signature=bad'}]) assert.equal(u.seckillPreviewBlock(row,[changed]).imgConfig.url,'');
  const reordered = Object.fromEntries(Object.entries(row).reverse()); assert.equal(u.seckillPreviewBlock(reordered,[cap]).imgConfig.url,'');
  const ticketInRaw=clone(row);ticketInRaw.imgConfig.url=ticket(11);assert.equal(u.seckillPreviewBlock(ticketInRaw,[cap]).imgConfig.url,'','Matching canonical ref cannot override a changed complete raw block');
  assert.throws(()=>u.seckillImageScope({name:'other'},'imgConfig'));assert.throws(()=>u.seckillImageScope(row,'image'));
});

test('static and safe external images project without media capabilities and never authorize an unknown or adjacent slot', () => {
  const u=model(),row=u.newSeckillBlock(1),before=clone(row),preview=u.seckillPreviewBlock(row);
  assert.deepEqual(preview,row);row.imgConfig.url='https://images.example.com/title.png';assert.equal(u.seckillPreviewBlock(row).imgConfig.url,row.imgConfig.url);
  row.imgConfig.url=' http://images.example.com/title.png ';assert.equal(u.seckillPreviewBlock(row).imgConfig.url,'https://images.example.com/title.png');assert.equal(row.imgConfig.url,' http://images.example.com/title.png ');row.imgConfig.url='data:image/png;base64,AAA';assert.equal(u.seckillPreviewBlock(row).imgConfig.url,row.imgConfig.url);row.imgConfig.url='data:image/svg+xml;base64,AAA';assert.equal(u.seckillPreviewBlock(row).imgConfig.url,'');
  row.unknown={url:ticket(91)};row.productList=[{image:ticket(92)}];const projected=u.seckillPreviewBlock(row);assert.deepEqual(projected.unknown,row.unknown);assert.deepEqual(projected.productList,row.productList);
  assert.deepEqual(u.seckillPreviewBlock({name:'other',imgConfig:{url:ticket(93)}}),{name:'other',imgConfig:{url:ticket(93)}});assert.deepEqual(model().newSeckillBlock(1),before);
});


test('original numeric0..3 author/public checkbox identities include typed3 but never coerce unknown imports',()=>{
 const u=model(),row=u.newSeckillBlock(1);assert.deepEqual(u.SECKILL_CHECKBOX_VALUES,[0,1,2,3]);assert.deepEqual(u.seckillChecks(row),[0,1,2,3]);assert.deepEqual(row.checkboxInfo.type,[0,1,2,3]);
 const imported={name:'seckill',checkboxInfo:{type:[4,'0',2,3,2,false,{id:1},0,99],list:[{id:0,name:'original'}],keep:false}},before=clone(imported);assert.deepEqual(u.seckillChecks(imported),[2,3,0]);assert.deepEqual(imported,before);assert.deepEqual(u.seckillChecks({name:'seckill',checkboxInfo:{type:null}}),[]);
});

test('same checkbox set retains original order duplicate known entries unknown values and all metadata',()=>{
 const u=model(),row={name:'seckill',checkboxInfo:{type:[4,'1',2,3,{id:17},0,2,3,false,99],list:[{id:3,name:'原划线价'}],default:[0,1,2,3]}},before=clone(row),original=row.checkboxInfo.type;
 assert.equal(u.setSeckillChecks(row,[0,2,3]),false);assert.strictEqual(row.checkboxInfo.type,original);assert.deepEqual(row,before);assert.equal(u.setSeckillChecks(row,[3,2,0]),false);assert.deepEqual(row,before);
});

test('explicit checkbox changes only selected numeric0..3 and preserves every unrelated entry in original positions',()=>{
 const u=model(),row={name:'seckill',checkboxInfo:{type:[4,'1',2,3,{id:17},0,2,3,false,99],list:[{id:3,name:'原划线价'}],default:[0,1,2,3]}},before=clone(row);
 assert.equal(u.setSeckillChecks(row,[0,1,3]),true);const expected=clone(before);expected.checkboxInfo.type=[4,'1',3,{id:17},0,3,false,99,1];assert.deepEqual(row,expected);
 assert.equal(u.setSeckillChecks(row,[]),true);expected.checkboxInfo.type=[4,'1',{id:17},false,99];assert.deepEqual(row,expected);assert.deepEqual(before.checkboxInfo.type,[4,'1',2,3,{id:17},0,2,3,false,99]);
 assert.equal(u.setSeckillChecks(row,[2,3]),true);expected.checkboxInfo.type.push(2,3);assert.deepEqual(row,expected);
});

test('unsafe malformed oversized duplicated and coerced checkbox inputs fail atomically before any getter or raw rewrite',()=>{
 const u=model();for(const input of[undefined,null,{},'0',false,[4],[-1],['0'],[false],[0,0],[0,1,2,3,4],Array(1),[NaN],[Infinity],[[0]],[{id:0}]]){const row=u.newSeckillBlock(1),before=clone(row);assert.throws(()=>u.setSeckillChecks(row,input));assert.deepEqual(row,before);}
 const getter=[];Object.defineProperty(getter,'0',{enumerable:true,get(){throw Error('must not invoke getter');}});getter.length=1;const row=u.newSeckillBlock(1),before=clone(row);assert.throws(()=>u.setSeckillChecks(row,getter),/动态字段/);assert.deepEqual(row,before);
 for(const raw of[null,false,'bad',{}]){const row={name:'seckill',checkboxInfo:{type:raw,keep:[]}},before=clone(row);assert.throws(()=>u.setSeckillChecks(row,[1]));assert.deepEqual(row,before);}
 assert.throws(()=>u.setSeckillChecks({name:'other'},[1]));
 const missing={name:'seckill',checkboxInfo:{keep:false}};assert.equal(u.setSeckillChecks(missing,[1,3]),true);assert.deepEqual(missing,{name:'seckill',checkboxInfo:{keep:false,type:[1,3]}});
});

test('seckill activity family never consumes homeComb page-header metadata or authorizes its images',()=>{
 const u=model(),home={name:'homeComb',timestamp:7,checkboxInfo:{type:[0,1,2,3]},imgConfig:{url:ticket(17)},unknown:{keep:false}},before=clone(home);
 assert.equal(u.seckillKind(home.name),null);assert.deepEqual(u.seckillEntries([home,{name:'seckill',timestamp:8}]),[{index:1,kind:'seckill'}]);assert.deepEqual(u.canonicalSeckillBlock(home),home);assert.deepEqual(u.seckillPreviewBlock(home),home);
 for(const work of[()=>u.seckillSet(home,['opaque'],1),()=>u.setSeckillChecks(home,[0]),()=>u.setSeckillImage(home,'imgConfig','/static/a.png'),()=>u.removeSeckillBlock([home],0),()=>u.seckillImageScope(home,'imgConfig')])assert.throws(work);assert.deepEqual(home,before);
});

test('typed old-price checkbox3 is editable independently without rewriting its imported duplicates or string twin',()=>{
 const u=model(),row={name:'seckill',checkboxInfo:{type:[3,'3',3,0],list:[{id:3,name:'原文字'}],unknown:7}};assert.equal(u.setSeckillChecks(row,[0]),true);assert.deepEqual(row.checkboxInfo.type,['3',0]);assert.equal(u.setSeckillChecks(row,[0,3]),true);assert.deepEqual(row.checkboxInfo.type,['3',0,3]);assert.deepEqual(row.checkboxInfo.list,[{id:3,name:'原文字'}]);assert.equal(row.checkboxInfo.unknown,7);
});


test('bundled lightning and shandian keep original bytes and remain outside all three authored image scopes',()=>{
 const sources=[['seckill-lightning.png','05c8380d3b4bcd43563d264956e2f7f2138605ec28963dd727813131d273cc64',34,34],['seckill-shandian.png','b08750e7abad8d1291d1b050a1e2c40ef780cdbdf38f6a18ace8e47f91f62c2b',24,44]];
 for(const[name,sha,width,height]of sources){const a=fs.readFileSync(path.join(root,'../public/static/images/diy',name)),b=fs.readFileSync(path.join(root,'../../uniapp-ts/src/static/images/diy',name));assert.deepEqual(a,b);assert.equal(createHash('sha256').update(a).digest('hex'),sha);assert.equal(a.readUInt32BE(16),width);assert.equal(a.readUInt32BE(20),height);}
 const u=model(),row=u.newSeckillBlock(1);row.activity_image=ticket(61);row.activityId=301;row.progressIcon=ticket(62);const saved=u.canonicalSeckillBlock(row);assert.equal(saved.activity_image,ticket(61));assert.equal(saved.progressIcon,ticket(62));assert.throws(()=>u.seckillImageScope(row,'activity_image'));assert.deepEqual(u.SECKILL_IMAGE_SLOTS,['imgBgConfig','imgConfig','imgColorConfig']);
});
