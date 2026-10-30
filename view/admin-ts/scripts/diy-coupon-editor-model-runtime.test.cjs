const { test, assert, path, fs, root, clone, loader, ticket } = require('./helpers/diy-navigation-runtime.cjs');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const utilFile = path.join(root, 'utils/diyCouponEditor.ts'), defaultsFile = path.join(root, 'utils/diyCouponDefaults.ts');
const model = () => loader().load(utilFile);

test('complete24-key coupon default is exactly the fixed PHP literal without execution or hidden default omission', () => {
  // PHP8ed2a5b home_coupon.vue:203–380; raw SHA aec344597c104f7f03772cdf83dc35c912b340964d8dfeb29fa307d06dab793d.
  // Only timestamp this.num→0. No media/config/LIMIT substitution exists.
  const tree = ts.createSourceFile(defaultsFile, fs.readFileSync(defaultsFile, 'utf8'), ts.ScriptTarget.Latest, true); let literal;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'DIY_COUPON_DEFAULTS') literal = node.initializer; ts.forEachChild(node, visit); } visit(tree);
  function read(node) {
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => { assert.ok(ts.isPropertyAssignment(p)); return [p.name.text, read(p.initializer)]; }));
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(read);
    if (ts.isStringLiteral(node)) return node.text; if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false; if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    assert.fail('Only fixed static default literals are allowed');
  }
  const expected = read(literal), u = model(); assert.equal(Object.keys(expected).length, 24);
  assert.equal(createHash('sha256').update(JSON.stringify(expected)).digest('hex'), '4ad457fc9475b96a9c1ab87fc9c87b0b1918cada7740d16e42cd3725dfbfffc6');
  assert.deepEqual(u.newCouponBlock(19), { ...expected, timestamp: 19 });
  assert.deepEqual(expected.numberConfig, { title: '展示数量', val: 5, min: 1 });
  assert.deepEqual(expected.spacingConfig, { title: '优惠券间距', val: 6, min: 0 });
  assert.deepEqual(expected.styleConfig, { title: '选择风格', tabVal: 0, type: 'coupon' });
  assert.equal(expected.fillet.val, 8); assert.deepEqual(expected.fillet.valList, Array.from({ length: 4 }, () => ({ val: 0 })));
  assert.equal(expected.prConfig.val, 10); assert.equal(expected.isHide, false);
  assert.deepEqual(expected.bntBgColor.color, [{ item: '#FF7931' }, { item: '#E93323' }]);
});

test('new defaults are independent deep copies and contain no authored media or selected coupon identity', () => {
  const u = model(), first = u.newCouponBlock(1), second = u.newCouponBlock(2);
  first.fillet.valList[0].val = 99; first.bntBgColor.default[1].item = '#000';
  assert.equal(second.fillet.valList[0].val, 0); assert.equal(second.bntBgColor.default[1].item, '#E93323');
  for (const key of ['imgConfig', 'image', 'couponIds', 'selectConfig', 'goodsList']) assert.equal(Object.hasOwn(second, key), false);
  assert.equal(u.canonicalCouponBlock, undefined); assert.equal(u.canonicalCouponValue, undefined);
  for (const timestamp of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => u.newCouponBlock(timestamp));
});

test('full imports remain complete and ordered discovery includes hidden duplicate malformed and overflow blocks', () => {
  const u = model(), rows = [{ name: 'unknown', timestamp: -99, raw: [] }, { name: 'coupon', timestamp: ' 2e0 ', styleConfig: null }, null,
    ...Array.from({ length: 251 }, (_, i) => ({ name: 'coupon', timestamp: i + 3, isHide: true, keep: [false, 0, ''] })), { name: 'coupon', timestamp: -2 }, { name: 'coupon', timestamp: 'bad' }], original = clone(rows);
  assert.deepEqual(u.couponDocument(JSON.stringify(rows)), rows); assert.deepEqual(rows, original);
  const entries = u.couponEntries(rows); assert.equal(entries.length, 254); assert.equal(entries[0].index, 254); assert.equal(entries[1].index, 1); assert.equal(entries.at(-1).index, 255);
  assert.deepEqual(u.COUPON_NAMES, ['coupon']); assert.equal(u.couponKind('coupon'), 'coupon'); assert.equal(u.couponKind('Coupon'), null); assert.equal(u.couponRecord([]), null);
  assert.equal(u.couponRead({ x: [false] }, ['x', 0]), false); assert.equal(u.couponFlag(' TRUE '), true); assert.equal(u.couponFlag('false'), false); assert.equal(u.couponText('  原文  '), '  原文  ');
});

test('ordinary component add inserts complete default before any footer and retains all unrelated raw neighbours', () => {
  const u = model(), rows = [{ name: 'titles', timestamp: ' 4.5 ', keep: ['a'] }, { name: 'unknown', timestamp: Number.MAX_SAFE_INTEGER }, { name: 'PageFoot', timestamp: 900, keep: false }], original = clone(rows);
  const first = u.addCouponBlock(rows); assert.equal(first.selected, 2); assert.equal(first.value[2].timestamp, 5.5); assert.equal(Object.keys(first.value[2]).length, 24);
  assert.deepEqual(first.value.filter(row => row.name !== 'coupon'), rows); assert.deepEqual(rows, original);
  const second = u.addCouponBlock(first.value); assert.equal(second.value.filter(row => row.name === 'coupon').length, 2); assert.equal(second.value.at(-1).name, 'PageFoot');
  assert.throws(() => u.addCouponBlock([{ name: 'titles', timestamp: Number.MAX_SAFE_INTEGER }]), /排序空间不足/);
});

test('component movement follows the whole body order without normalizing imported timestamp spellings', () => {
  const u = model(), rows = [{ name: 'coupon', timestamp: ' 2e0 ', keep: [false] }, { name: 'titles', timestamp: '1.0', text: '正文' }, { name: 'unknown', timestamp: -100 }, { name: 'coupon', timestamp: 3 }], original = clone(rows);
  const moved = u.moveCouponBlock(rows, 0, -1); assert.equal(moved.selected, 1); assert.equal(moved.value[1].name, 'coupon'); assert.equal(moved.value[1].timestamp, '1.0');
  assert.equal(moved.value[0].timestamp, ' 2e0 '); assert.deepEqual(moved.value[2], rows[2]); assert.deepEqual(rows, original);
  const back = u.moveCouponBlock(moved.value, 1, 1); assert.deepEqual(back.value, rows); assert.equal(back.selected, 0);
});

test('movement fences headers and footer and refuses ambiguous or missing source intent', () => {
  const u = model();
  for (const header of ['homeComb', 'headerSerch', 'tabNav']) {
    const rows = [{ name: header, timestamp: 1 }, { name: 'coupon', timestamp: 2 }], before = clone(rows);
    assert.throws(() => u.moveCouponBlock(rows, 1, -1)); assert.deepEqual(rows, before);
  }
  for (const rows of [[{ name: 'coupon', timestamp: 1 }, { name: 'titles', timestamp: 1 }], [{ name: 'coupon' }, { name: 'titles', timestamp: 2 }], [{ name: 'coupon', timestamp: 1 }, { name: 'pageFoot', timestamp: 2 }]]) {
    const original = clone(rows); assert.throws(() => u.moveCouponBlock(rows, 0, 1)); assert.deepEqual(rows, original);
  }
  const rows = [{ name: 'coupon', timestamp: 1 }]; for (const [index, direction] of [[-1, 1], [0, 0], [0, .5], [0, -1]]) assert.throws(() => u.moveCouponBlock(rows, index, direction));
});

test('explicit removal deletes only the selected coupon and selects the remaining rendered coupon', () => {
  const u = model(), rows = [{ name: 'coupon', timestamp: 3, keep: false }, { name: 'unknown', foo: [1] }, { name: 'coupon', timestamp: '1' }], before = clone(rows);
  const result = u.removeCouponBlock(rows, 0); assert.deepEqual(result, { value: [rows[1], rows[2]], selected: 1 }); assert.deepEqual(rows, before);
  assert.equal(u.removeCouponBlock(result.value, 1).selected, -1); assert.throws(() => u.removeCouponBlock(rows, 1)); assert.throws(() => u.removeCouponBlock(rows, -1));
});

test('complete document guards reject nonarrays dangerous keys excessive depth and overbudget input without truncation', () => {
  const u = model(); for (const value of ['null', '{}', 'false', '{', '[{"__proto__":{}}]', '[{"constructor":0}]']) assert.throws(() => u.couponDocument(value));
  assert.throws(() => u.couponDocument(JSON.stringify([{ name: 'coupon', keep: 'a'.repeat(2_000_001) }])), /2 MB/);
  let nested = 1; for (let i = 0; i < 66; i++) nested = { next: nested }; assert.throws(() => u.couponDocument(JSON.stringify([nested])), /64/);
});

test('atomic explicit leaf edits preserve complete metadata defaults and every dormant original value', () => {
  const u = model(), block = u.newCouponBlock(9); block.couponBgColor.imported = { keep: [0, false] }; block.unknown = { image: ticket(77), ids: ['001'], raw: null };
  const before = clone(block); assert.equal(u.couponSet(block, ['couponBgColor', 'color', 0, 'item'], '#123456'), true);
  const expected = clone(before); expected.couponBgColor.color[0].item = '#123456'; assert.deepEqual(block, expected);
  assert.equal(u.couponSet(block, ['couponBgColor', 'color', 0, 'item'], '#123456'), false);
  assert.equal(u.couponSet(block, ['unknown', 'raw'], { keep: [false, ''] }), true); assert.deepEqual(block.unknown.raw, { keep: [false, ''] });
});

test('bad imported parents and unsafe paths cannot partially create or replace metadata', () => {
  const u = model();
  for (const block of [{ name: 'coupon', couponBgColor: null }, { name: 'coupon', couponBgColor: { color: false } }, { name: 'coupon', couponBgColor: [] }]) {
    const before = clone(block); assert.throws(() => u.couponSet(block, ['couponBgColor', 'color', 0, 'item'], '#fff')); assert.deepEqual(block, before);
  }
  for (const pathValue of [[], ['__proto__', 'x'], ['constructor'], ['fillet', 'valList', -1], ['fillet', 'valList', .5], ['fillet', 'valList', 100001]]) {
    const block = u.newCouponBlock(1), before = clone(block); assert.throws(() => u.couponSet(block, pathValue, 9)); assert.deepEqual(block, before);
  }
  assert.throws(() => u.couponSet({ name: 'other' }, ['x'], 1));
});

test('metadata safety rejects unsupported JSON values and whole-candidate capacity before mutation', () => {
  const u = model(), block = u.newCouponBlock(1), before = clone(block), cyclic = {}; cyclic.self = cyclic;
  const getter = {}; Object.defineProperty(getter, 'val', { enumerable: true, get() { throw Error('Must not execute getter'); } });
  const symbol = { [Symbol('x')]: 1 }, sparse = Array(2); sparse[1] = 1;
  for (const value of [undefined, NaN, Infinity, () => 1, 1n, new Date(), cyclic, getter, symbol, sparse, JSON.parse('{"__proto__":1}')]) {
    assert.throws(() => u.couponSet(block, ['metadata'], value)); assert.deepEqual(block, before);
  }
  assert.throws(() => u.couponSet(block, ['metadata'], 'a'.repeat(2_000_001)), /2 MB/); assert.deepEqual(block, before);
});

test('numeric display and same-value typed events retain raw zero tiny exponent spacing and oversized spellings', () => {
  const u = model();
  for (const raw of [0, '0', '000', ' 5e-4 ', '003.000', ' 1e2 ', '1e30']) {
    const block = { name: 'coupon', length: { val: raw, min: 0, keep: [] } }, before = clone(block);
    assert.equal(u.couponNumber(raw), Number(raw)); assert.equal(u.setCouponNumber(block, ['length', 'val'], Number(raw)), false); assert.deepEqual(block, before);
  }
  assert.equal(u.couponNumber('bad', 6), 6); assert.equal(u.couponNumber(' ', 6), 6); assert.equal(u.couponNumber(-1, 6), 6); assert.equal(u.couponNumber(200, 0, 100), 100);
  const block = { name: 'coupon', length: { val: '4', keep: false } }; assert.equal(u.setCouponNumber(block, ['length', 'val'], 5, 1, 100), true); assert.deepEqual(block.length, { val: 5, keep: false });
  for (const value of ['6', NaN, Infinity, -1, 101]) assert.throws(() => u.setCouponNumber(block, ['length', 'val'], value, 0, 100));
});

test('new quantity accepts integer1..100 while equal imported out-of-range events remain exact noops', () => {
  const u = model();
  for (const raw of [0, ' 0 ', '5e-4', ' 2e0 ', '003', '1e30']) {
    const block = { name: 'coupon', numberConfig: { val: raw, min: 1, keep: [] } }, before = clone(block);
    assert.equal(u.setCouponCount(block, Number(raw)), false); assert.deepEqual(block, before);
    assert.equal(u.setCouponCount(block, 17), true); assert.deepEqual(block.numberConfig, { val: 17, min: 1, keep: [] });
  }
  for (const value of [0, -1, .5, 2.5, 101, '6', NaN, Infinity]) { const block = u.newCouponBlock(1), before = clone(block); assert.throws(() => u.setCouponCount(block, value), /整数/); assert.deepEqual(block, before); }
  const block = { name: 'coupon', numberConfig: null }, before = clone(block); assert.throws(() => u.setCouponCount(block, 2)); assert.deepEqual(block, before);
});

test('public quantity is the existing TS floor/clamp10000 then min10 and never a saved rewrite or claimed PHP LIMIT', () => {
  const u = model(); for (const [raw, limit] of [[0, 0], ['0', 0], ['5e-4', 0], [' 2.99 ', 2], ['003', 3], [9, 9], [10, 10], ['1e30', 10], [undefined, 6], ['bad', 6]]) assert.equal(u.couponPublicLimit(raw), limit);
  const block = { name: 'coupon', numberConfig: { val: '001000' }, isHide: true, unknown: [ticket(88)] }, before = clone(block); u.couponPublicLimit(block.numberConfig.val); assert.deepEqual(block, before);
});

test('no metadata image slot or public coupon data gains canonicalization or implicit selected-coupon semantics', () => {
  const u = model(), raw = [{ name: 'coupon', imgConfig: { url: ticket(18) }, couponList: [{ id: 7, image: ticket(19), price: '12.00' }], unknown: [ticket(20)], numberConfig: { val: '0' } }, { name: 'other', url: ticket(21) }], before = clone(raw);
  const parsed = u.couponDocument(JSON.stringify(raw)); assert.deepEqual(parsed, raw); u.couponEntries(parsed); u.couponPublicLimit(parsed[0].numberConfig.val); assert.deepEqual(parsed, before); assert.deepEqual(raw, before);
  u.couponSet(parsed[0], ['isHide'], false); const expected = clone(before); expected[0].isHide = false; assert.deepEqual(parsed, expected);
});
