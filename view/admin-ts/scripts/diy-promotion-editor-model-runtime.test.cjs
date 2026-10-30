const { test, assert, path, fs, root, clone, loader, ticket } = require('./helpers/diy-navigation-runtime.cjs');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const utilFile = path.join(root, 'utils/diyPromotionEditor.ts');
const defaultsFile = path.join(root, 'utils/diyPromotionDefaults.ts');
const model = () => loader().load(utilFile);
const tab = (u, block, index = 0) => u.promotionTabs(block)[index];
const withSource = (u, source) => {
  const block = u.newPromotionBlock(1); tab(u, block).tabVal = source; return block;
};

test('complete promotion literal keeps all 30 PHP default keys and independent full tab metadata', () => {
  // Immutable PHP 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5 home_product.vue:133–426.
  // Raw source SHA c6e6a1525a6e8a6640ba5458ff1bc2a8eb6c2bb9f09d392b77de3735c58debf3.
  // Only this.num → 0, no PHP/Vue/require evaluation. PHP c_promotion:341–374
  // copy-last/localStorage behavior is deliberately replaced by this fresh full default.
  const source = fs.readFileSync(defaultsFile, 'utf8'), tree = ts.createSourceFile(defaultsFile, source, ts.ScriptTarget.Latest, true);
  let literal;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'DIY_PROMOTION_DEFAULTS') literal = node.initializer; ts.forEachChild(node, visit); }
  visit(tree);
  function read(node) {
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(property => { assert.ok(ts.isPropertyAssignment(property)); return [property.name.text, read(property.initializer)]; }));
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(read);
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    assert.fail('Only fixed PHP-bound literals are permitted');
  }
  const expected = read(literal), u = model();
  assert.equal(Object.keys(expected).length, 30);
  assert.equal(createHash('sha256').update(JSON.stringify(expected)).digest('hex'), '56836da289757873d8b7d95ebf3ff65df4c445980d0646434a2804178352be90');
  assert.deepEqual(u.newPromotionBlock(17), { ...expected, timestamp: 17 });
  assert.deepEqual(u.newPromotionTab(), expected.tabConfig.list[0]);
  assert.deepEqual(expected.tabConfig.list[0], {
    chiild: [{ title: '标题', val: '首发新品', max: 4, pla: '选填，不超过四个字' }, { title: '简介', val: '最新出炉', max: 4, pla: '选填，不超过四个字' }],
    image: '', tabVal: 1, brandConfig: { brandVal: [] }, selectConfig: { activeValue: [] }, goodsLabel: { activeValue: [], list: [] }, goodsSort: 0, numConfig: { val: 6 }, goodsList: { max: 20, list: [] }, productList: { list: [] },
  });
  const changed = u.newPromotionBlock(18); changed.tabConfig.list[0].chiild[0].val = 'changed'; changed.fillet.valList[3].val = 9;
  assert.equal(u.newPromotionBlock(19).tabConfig.list[0].chiild[0].val, '首发新品');
  assert.equal(u.newPromotionBlock(19).fillet.valList[3].val, 0);
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => u.newPromotionBlock(value));
});

test('discovery and read helpers preserve hidden duplicate malformed unknown and overflow imports', () => {
  const u = model(), tabs = Array.from({ length: 20 }, (_, i) => ({ tabVal: i ? '0' : 1, chiild: null, image: '', keep: [false, 0, ''], goodsList: { ids: Array.from({ length: 123 }, (_, n) => String(n + 1)), list: [] } }));
  tabs.push(null, 5, { tabVal: 1, image: [], extra: [] });
  const rows = [null, { name: 'unknown', timestamp: -9 }, { name: 'promotionList', timestamp: ' 2e0 ', isHide: true, tabConfig: { tabCur: '19', list: tabs } }, { name: 'promotionList', timestamp: -2 }, { name: 'promotionList', timestamp: 'bad' }], original = clone(rows);
  assert.deepEqual(u.promotionEntries(rows), [{ index: 3, kind: 'promotionList' }, { index: 2, kind: 'promotionList' }, { index: 4, kind: 'promotionList' }]);
  assert.deepEqual(u.promotionDocument(JSON.stringify(rows)), rows);
  assert.equal(u.promotionTabs(rows[2]).length, 23);
  assert.equal(u.promotionSelections(tabs[0], 'product').length, 123);
  assert.deepEqual(rows, original);
  assert.deepEqual(u.PROMOTION_NAMES, ['promotionList']);
  assert.equal(u.promotionKind('PromotionList'), null);
  assert.equal(u.promotionKind('promotionList'), 'promotionList');
  assert.deepEqual(u.promotionTabs({ name: 'unknown', tabConfig: { list: tabs } }), []);
});

test('component creation inserts before the footer and observes heterogeneous body timestamps only', () => {
  const u = model(), rows = [{ name: 'titles', timestamp: ' 4.5 ', keep: ['a'] }, { name: 'unknown', timestamp: Number.MAX_SAFE_INTEGER }, { name: 'pageFoot', timestamp: 900, keep: false }], original = clone(rows);
  const added = u.addPromotionBlock(rows);
  assert.equal(added.selected, 2); assert.equal(added.value[2].timestamp, 5.5);
  assert.equal(Object.keys(added.value[2]).length, 30);
  assert.deepEqual(added.value.filter(row => row.name !== 'promotionList'), rows);
  assert.deepEqual(rows, original);
  assert.throws(() => u.addPromotionBlock([{ name: 'titles', timestamp: Number.MAX_SAFE_INTEGER }]), /排序空间不足/);
});

test('component movement uses rendered body order and preserves string timestamp spellings', () => {
  const u = model(), rows = [{ name: 'promotionList', timestamp: ' 3e0 ', extra: [] }, { name: 'unknown', timestamp: 2 }, { name: 'community', timestamp: ' 1.25 ', keep: false }, { name: 'follow', timestamp: 5 }, { name: 'pageFoot', timestamp: 4 }], original = clone(rows);
  const moved = u.movePromotionBlock(rows, 0, -1);
  assert.equal(moved.selected, 2);
  assert.deepEqual(moved.value[2], { ...rows[0], timestamp: ' 1.25 ' });
  assert.deepEqual(moved.value[0], { ...rows[2], timestamp: ' 3e0 ' });
  assert.deepEqual(u.movePromotionBlock(moved.value, 2, 1).value, rows);
  assert.deepEqual(rows, original);
});

test('component move/delete guard boundaries and never mutate rejected source documents', () => {
  const u = model();
  for (const name of ['homeComb', 'headerSerch', 'tabNav']) {
    const rows = [{ name, timestamp: 0 }, u.newPromotionBlock(1)], original = clone(rows);
    assert.throws(() => u.movePromotionBlock(rows, 1, -1), /不能越过/); assert.deepEqual(rows, original);
  }
  for (const timestamp of [1, 'bad', undefined]) {
    const rows = [u.newPromotionBlock(1), { name: 'titles', timestamp }], original = structuredClone(rows);
    assert.throws(() => u.movePromotionBlock(rows, 0, 1)); assert.deepEqual(rows, original);
  }
  const rows = [u.newPromotionBlock(1), { name: 'titles', timestamp: 2 }, u.newPromotionBlock(3)];
  assert.deepEqual(u.removePromotionBlock(rows, 0), { value: rows.slice(1), selected: 1 });
  assert.throws(() => u.removePromotionBlock(rows, 1));
  for (const direction of [0, 2, -2, NaN]) assert.throws(() => u.movePromotionBlock(rows, 0, direction));
});

test('fresh tab creation continues beyond the public twelve-tab display bound with full metadata', () => {
  const u = model(), block = u.newPromotionBlock(1);
  tab(u, block).brandConfig.brandVal = ['9']; tab(u, block).image = '/api/assets/77'; tab(u, block).private = { keep: 'last imported row' };
  for (let i = 1; i < 16; i++) assert.equal(u.addPromotionTab(block), i);
  assert.equal(block.tabConfig.list.length, 16);
  assert.equal(block.tabConfig.tabCur, 15);
  for (const row of block.tabConfig.list.slice(1)) assert.deepEqual(row, u.newPromotionTab());
  assert.deepEqual(block.tabConfig.list[0].brandConfig.brandVal, ['9']);
  assert.equal(block.tabConfig.list[0].image, '/api/assets/77');
});

test('tab selection and movement preserve raw equal indices and all dormant/overflow rows', () => {
  const u = model(), block = u.newPromotionBlock(1);
  block.tabConfig.list = Array.from({ length: 16 }, (_, i) => ({ marker: i, tabVal: '0', unknown: [false, '', i] }));
  block.tabConfig.tabCur = ' 1.5e1 '; block.tabConfig.keep = { 'x': [] };
  const original = clone(block);
  assert.equal(u.selectPromotionTab(block, 15), false); assert.deepEqual(block, original);
  assert.equal(u.movePromotionTab(block, 15, -1), 14);
  assert.equal(block.tabConfig.list[14].marker, 15); assert.equal(block.tabConfig.list[15].marker, 14);
  assert.deepEqual(block.tabConfig.keep, original.tabConfig.keep);
  assert.equal(u.removePromotionTab(block, 14), 14);
  assert.equal(block.tabConfig.list.length, 15);
  assert.equal(block.tabConfig.list[14].marker, 14);
  assert.deepEqual(block.tabConfig.list.slice(0, 14), original.tabConfig.list.slice(0, 14));
});

test('malformed imported tab rows can be removed/reordered without merging defaults', () => {
  const u = model(), block = { name: 'promotionList', tabConfig: { list: [null, { tabVal: 1, keep: [] }, 'bad'], keep: false } };
  assert.equal(u.movePromotionTab(block, 2, -1), 1);
  assert.deepEqual(block.tabConfig.list, [null, 'bad', { tabVal: 1, keep: [] }]);
  assert.equal(u.removePromotionTab(block, 0), 0);
  assert.equal(u.removePromotionTab(block, 0), 0);
  assert.equal(u.removePromotionTab(block, 0), -1);
  assert.deepEqual(block, { name: 'promotionList', tabConfig: { list: [], keep: false, tabCur: 0 } });
});

test('tab operations reject malformed parents invalid indices and oversized changes atomically', () => {
  const u = model();
  for (const block of [{ name: 'promotionList', tabConfig: null }, { name: 'promotionList', tabConfig: { list: false } }, { name: 'unknown', tabConfig: { list: [] } }]) {
    const original = clone(block); assert.throws(() => u.addPromotionTab(block)); assert.deepEqual(block, original);
  }
  const block = u.newPromotionBlock(1), original = clone(block);
  for (const fn of [() => u.removePromotionTab(block, -1), () => u.movePromotionTab(block, 0, 0), () => u.movePromotionTab(block, 0, 1), () => u.selectPromotionTab(block, .5)]) { assert.throws(fn); assert.deepEqual(block, original); }
  const huge = { name: 'promotionList', keep: 'a'.repeat(2_000_001), tabConfig: { list: [] } }, before = clone(huge);
  assert.throws(() => u.addPromotionTab(huge), /2 MB/); assert.deepEqual(huge, before);
});

test('source zero stays category semantics while source changes preserve every sibling source', () => {
  const u = model(), block = withSource(u, '0'), row = tab(u, block);
  Object.assign(row, { goodsList: { ids: ['1'], list: [{ id: '1', image: ticket(1) }] }, brandConfig: { brandVal: ['2'], keep: false }, selectConfig: { activeValue: ['3'] }, goodsLabel: { activeValue: ['4'], list: [{ id: '4', label_name: '标签' }] }, keep: [] });
  const original = clone(block);
  assert.equal(u.promotionScope(row), 'category'); assert.equal(u.setPromotionSource(block, 0, 0), false); assert.deepEqual(block, original);
  for (const [source, kind] of [[1, 'product'], [2, 'brand'], [3, 'category'], [4, 'label']]) {
    assert.equal(u.setPromotionSource(block, 0, source), true); assert.equal(u.promotionScope(tab(u, block)), kind);
    for (const key of ['goodsList', 'brandConfig', 'selectConfig', 'goodsLabel', 'keep']) assert.deepEqual(tab(u, block)[key], original.tabConfig.list[0][key]);
  }
  assert.equal(tab(u, block).tabVal, 4); // Only the explicit active source changes; material values remain exact.
  for (const value of [-1, 5, .5, NaN]) assert.throws(() => u.setPromotionSource(block, 0, value));
  assert.equal(u.promotionScope({ tabVal: 'bad' }), null);
});

test('numeric events never normalize equal imported scientific spaced or zero values', () => {
  const u = model();
  for (const raw of ['000', ' 5e-4 ', '003.000', ' 1e2 ', 0, 1000]) {
    const block = { name: 'promotionList', count: { val: raw, keep: [] } }, original = clone(block), number = Number(raw);
    assert.equal(u.promotionNumber(raw), number); assert.equal(u.setPromotionNumber(block, ['count', 'val'], number), false); assert.deepEqual(block, original);
  }
  const block = { name: 'promotionList', count: { val: '4', keep: false } };
  assert.equal(u.setPromotionNumber(block, ['count', 'val'], 5, 1, 100), true); assert.deepEqual(block.count, { val: 5, keep: false });
  for (const value of ['6', NaN, Infinity, -1, 101]) assert.throws(() => u.setPromotionNumber(block, ['count', 'val'], value, 0, 100));
});

test('product directory selection writes only narrow identity and updates ids/list atomically', () => {
  const u = model(), block = u.newPromotionBlock(1), row = tab(u, block);
  row.goodsList.keep = [false]; row.productList = { list: [{ image: ticket(91), price: 'private preview' }] };
  assert.equal(u.choosePromotionSelection(block, 0, { kind: 'product', id: 7, name: '真实商品' }), true);
  assert.deepEqual(tab(u, block).goodsList, { max: 20, list: [{ id: 7, store_name: '真实商品' }], keep: [false], ids: [7] });
  assert.deepEqual(tab(u, block).productList, row.productList);
  const before = clone(block); assert.equal(u.choosePromotionSelection(block, 0, { kind: 'product', id: 7, name: '不同目录名称' }), false); assert.deepEqual(block, before);
});

test('product fallback list can be explicitly adopted without changing raw ID strings or metadata', () => {
  const u = model(), block = withSource(u, 1), row = tab(u, block);
  row.goodsList = { list: [{ id: '7', store_name: '旧名', image: ticket(71), extra: [] }, { value: '8', keep: false }], keep: 9 };
  const old = clone(row.goodsList);
  assert.equal(u.choosePromotionSelection(block, 0, { kind: 'product', id: 9, name: '新增' }), true);
  assert.deepEqual(tab(u, block).goodsList.ids, ['7', '8', 9]);
  assert.deepEqual(tab(u, block).goodsList.list.slice(0, 2), old.list);
  assert.deepEqual(tab(u, block).goodsList.list[2], { id: 9, store_name: '新增' });
  assert.equal(tab(u, block).goodsList.keep, 9);
});

test('present empty product ids override fallback material until explicit user choice', () => {
  const u = model(), block = withSource(u, 1), row = tab(u, block);
  row.goodsList = { ids: [], list: [{ id: 7, image: ticket(7), extra: [] }], keep: false };
  assert.deepEqual(u.promotionSelections(row, 'product'), []);
  assert.equal(u.choosePromotionSelection(block, 0, { kind: 'product', id: 8, name: '新选' }), true);
  assert.deepEqual(tab(u, block).goodsList.ids, [8]);
  assert.deepEqual(tab(u, block).goodsList.list, [{ id: 7, image: ticket(7), extra: [] }, { id: 8, store_name: '新选' }]);
});

test('brand and category explicit choices keep flat IDs and retain raw imported spellings', () => {
  const u = model();
  for (const [source, kind, key, leaf] of [[2, 'brand', 'brandConfig', 'brandVal'], [0, 'category', 'selectConfig', 'activeValue']]) {
    const block = withSource(u, source); tab(u, block)[key] = { [leaf]: ['7'], keep: [false] };
    assert.equal(u.choosePromotionSelection(block, 0, { kind, id: 8, name: '新选择' }), true);
    assert.deepEqual(tab(u, block)[key], { [leaf]: ['7', 8], keep: [false] });
    assert.equal(tab(u, block).tabVal, source);
    assert.equal(u.movePromotionSelection(block, 0, kind, 1, -1), 0);
    assert.deepEqual(tab(u, block)[key][leaf], [8, '7']);
    assert.equal(u.removePromotionSelection(block, 0, kind, 0), 0);
    assert.deepEqual(tab(u, block)[key][leaf], ['7']);
  }
});

test('label selection atomically maintains activeValue/list and keeps untouched metadata', () => {
  const u = model(), block = withSource(u, 4);
  tab(u, block).goodsLabel = { activeValue: ['7'], list: [{ id: '7', label_name: '原标签', image: ticket(70), keep: false }, { opaque: [1] }], keep: [] };
  assert.equal(u.choosePromotionSelection(block, 0, { kind: 'label', id: 8, name: '新标签' }), true);
  assert.deepEqual(tab(u, block).goodsLabel.activeValue, ['7', 8]);
  assert.deepEqual(tab(u, block).goodsLabel.list[2], { id: 8, label_name: '新标签' });
  u.movePromotionSelection(block, 0, 'label', 1, -1);
  assert.deepEqual(tab(u, block).goodsLabel.list, [{ id: 8, label_name: '新标签' }, { opaque: [1] }, { id: '7', label_name: '原标签', image: ticket(70), keep: false }]);
  u.removePromotionSelection(block, 0, 'label', 0);
  assert.deepEqual(tab(u, block).goodsLabel, { activeValue: ['7'], list: [{ opaque: [1] }, { id: '7', label_name: '原标签', image: ticket(70), keep: false }], keep: [] });
});

test('ordinary selection limit is100 while imported excess remains removable and reorderable', () => {
  const u = model(), block = withSource(u, 1);
  tab(u, block).goodsList = { ids: Array.from({ length: 123 }, (_, i) => String(i + 1)), list: Array.from({ length: 123 }, (_, i) => ({ id: String(i + 1), extra: [i], image: ticket(i + 1) })), keep: false };
  const before = clone(block);
  assert.throws(() => u.choosePromotionSelection(block, 0, { kind: 'product', id: 999, name: '超过预算' }), /100项/); assert.deepEqual(block, before);
  assert.equal(u.choosePromotionSelection(block, 0, { kind: 'product', id: 123, name: '重复' }), false); assert.deepEqual(block, before);
  u.movePromotionSelection(block, 0, 'product', 122, -1);
  assert.equal(tab(u, block).goodsList.ids.length, 123);
  assert.deepEqual(tab(u, block).goodsList.ids.slice(0, 121), before.tabConfig.list[0].goodsList.ids.slice(0, 121));
  u.removePromotionSelection(block, 0, 'product', 121);
  assert.equal(tab(u, block).goodsList.ids.length, 122); assert.equal(tab(u, block).goodsList.list.length, 122);
  assert.deepEqual(tab(u, block).goodsList.list.at(-1), before.tabConfig.list[0].goodsList.list[121]);
  assert.equal(tab(u, block).goodsList.keep, false);
});

test('100th explicit identity is allowed and101st fails without partially changing either array', () => {
  const u = model(), block = withSource(u, 4);
  tab(u, block).goodsLabel = { activeValue: Array.from({ length: 99 }, (_, i) => i + 1), list: [], keep: 0 };
  assert.equal(u.choosePromotionSelection(block, 0, { kind: 'label', id: 100, name: '第100项' }), true);
  const before = clone(block);
  assert.throws(() => u.choosePromotionSelection(block, 0, { kind: 'label', id: 101, name: '第101项' }), /100项/);
  assert.deepEqual(block, before);
});

test('selection reorder/remove preserve unmatched unknown material and only affect matched occurrences', () => {
  const u = model(), block = withSource(u, 1);
  tab(u, block).goodsList = { ids: ['7', 8, '7', { malformed: true }], list: [{ id: '7', keep: 'first' }, { unknown: [false] }, { id: 8, keep: 'eight' }, { id: '7', keep: 'second' }, { id: 99, keep: 'unmatched' }] };
  u.movePromotionSelection(block, 0, 'product', 0, 1);
  assert.deepEqual(tab(u, block).goodsList.list, [{ id: 8, keep: 'eight' }, { unknown: [false] }, { id: '7', keep: 'first' }, { id: '7', keep: 'second' }, { id: 99, keep: 'unmatched' }]);
  u.removePromotionSelection(block, 0, 'product', 2);
  assert.deepEqual(tab(u, block).goodsList.ids, [8, '7', { malformed: true }]);
  assert.deepEqual(tab(u, block).goodsList.list, [{ id: 8, keep: 'eight' }, { unknown: [false] }, { id: '7', keep: 'first' }, { id: 99, keep: 'unmatched' }]);
  u.removePromotionSelection(block, 0, 'product', 2);
  assert.deepEqual(tab(u, block).goodsList.ids, [8, '7']);
  assert.equal(tab(u, block).goodsList.list.length, 4);
});

test('fallback list reorder and invalid-row removal explicitly create matching ids without losing metadata', () => {
  const u = model(), block = withSource(u, 1);
  tab(u, block).goodsList = { ids: null, list: [{ id: '7', image: ticket(7), keep: false }, { id: 8, value: '99', keep: [] }], max: '20' };
  u.movePromotionSelection(block, 0, 'product', 1, -1);
  assert.deepEqual(tab(u, block).goodsList.ids, [8, '7']); assert.deepEqual(tab(u, block).goodsList.list[0], { id: 8, value: '99', keep: [] });
  assert.equal(tab(u, block).goodsList.max, '20');
  const malformed = withSource(u, 1); tab(u, malformed).goodsList.list = [{ bad: true }, { id: '7', keep: ticket(7) }];
  u.removePromotionSelection(malformed, 0, 'product', 0);
  assert.deepEqual(tab(u, malformed).goodsList.ids, ['7']); assert.deepEqual(tab(u, malformed).goodsList.list, [{ id: '7', keep: ticket(7) }]);
});

test('missing counterpart rows are never synthesized or used to repair unrelated material order', () => {
  const u = model(), block = withSource(u, 1);
  tab(u, block).goodsList = { ids: [2, 3, 1], list: [{ id: 1, keep: 'first' }, { opaque: [] }, { id: 2, keep: 'last' }] };
  const before = clone(tab(u, block).goodsList.list);
  u.movePromotionSelection(block, 0, 'product', 1, -1);
  assert.deepEqual(tab(u, block).goodsList.ids, [3, 2, 1]); assert.deepEqual(tab(u, block).goodsList.list, before);
  u.removePromotionSelection(block, 0, 'product', 0);
  assert.deepEqual(tab(u, block).goodsList.list, before);
});

test('rejected directory choices and malformed material never partially update current selection', () => {
  const u = model();
  for (const kind of ['product', 'label']) {
    const block = withSource(u, kind === 'product' ? 1 : 4), key = kind === 'product' ? 'goodsList' : 'goodsLabel', leaf = kind === 'product' ? 'ids' : 'activeValue';
    tab(u, block)[key] = { [leaf]: ['7'], list: null, keep: false }; const before = clone(block);
    assert.throws(() => u.choosePromotionSelection(block, 0, { kind, id: 8, name: '新增' })); assert.deepEqual(block, before);
  }
  const block = u.newPromotionBlock(1), before = clone(block);
  for (const choice of [null, {}, { kind: 'label', id: 7, name: '错来源' }, { kind: 'product', id: '7', name: '字符串新ID' }, { kind: 'product', id: 0, name: '错误' }, { kind: 'product', id: 7, name: '' }, { kind: 'product', id: 7, name: 'a\u0000b' }, { kind: 'product', id: 7, name: '商品', image_preview: ticket(7) }, { kind: 'product', id: 7, name: '商品', price: '1.00' }, { kind: '__proto__', id: 7, name: '无效' }]) {
    assert.throws(() => u.choosePromotionSelection(block, 0, choice)); assert.deepEqual(block, before);
  }
  for (const fn of [() => u.removePromotionSelection(block, 0, 'brand', 0), () => u.movePromotionSelection(block, 0, 'product', 0, 1), () => u.choosePromotionSelection(block, 9, { kind: 'product', id: 8, name: '迟到' })]) { assert.throws(fn); assert.deepEqual(block, before); }
});

test('explicit clearing repairs only chosen arrays and preserves dormant sources and parent metadata', () => {
  const u = model(), block = withSource(u, 1), row = tab(u, block);
  row.goodsList = { ids: 'bad', list: null, max: '20', keep: [false] }; row.brandConfig = { brandVal: ['8'] };
  assert.equal(u.clearPromotionSelection(block, 0, 'product'), true);
  assert.deepEqual(tab(u, block).goodsList, { ids: [], list: [], max: '20', keep: [false] });
  assert.deepEqual(tab(u, block).brandConfig, { brandVal: ['8'] });
  assert.equal(u.clearPromotionSelection(block, 0, 'product'), false);
  tab(u, block).goodsList = null; const before = clone(block);
  assert.throws(() => u.clearPromotionSelection(block, 0, 'product')); assert.deepEqual(block, before);
});

test('generic metadata setters validate complete payload before one mutation', () => {
  const u = model(), block = u.newPromotionBlock(1), before = clone(block);
  const getter = {}; Object.defineProperty(getter, 'x', { enumerable: true, get() { throw Error('getter must not run'); } });
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, () => {}, new Date(), [1, , 2], getter, cycle, JSON.parse('{"constructor":1}')]) { assert.throws(() => u.promotionSet(block, ['custom'], value)); assert.deepEqual(block, before); }
  assert.throws(() => u.promotionSet(block, ['__proto__', 'x'], 1)); assert.deepEqual(block, before);
  assert.equal(u.promotionSet(block, ['custom'], { raw: ['0', false, null], keep: [] }), true);
  const after = clone(block); assert.equal(u.promotionSet(block, ['custom'], { raw: ['0', false, null], keep: [] }), false); assert.deepEqual(block, after);
  block.tabConfig = false; const bad = clone(block);
  assert.throws(() => u.promotionSet(block, ['tabConfig', 'list'], [])); assert.deepEqual(block, bad);
});

test('complete document limits reject unsafe oversized/deep metadata without clipping', () => {
  const u = model();
  assert.throws(() => u.promotionDocument('{}'), /JSON 数组/);
  assert.throws(() => u.promotionDocument('[{"name":"promotionList","__proto__":{}}]'), /不安全字段/);
  let nested = {}; for (let i = 0; i < 66; i++) nested = { nested };
  assert.throws(() => u.promotionDocument(JSON.stringify([{ name: 'promotionList', nested }])), /64 层/);
  const block = u.newPromotionBlock(1), before = clone(block);
  assert.throws(() => u.promotionSet(block, ['metadata'], nested), /64 层/); assert.deepEqual(block, before);
  assert.throws(() => u.promotionSet(block, ['metadata'], 'a'.repeat(2_000_001)), /2 MB/); assert.deepEqual(block, before);
});

test('canonical save touches every exact tab image including overflow and no metadata lookalike', () => {
  const u = model(), block = { name: 'promotionList', tabConfig: { list: Array.from({ length: 16 }, (_, i) => ({ tabVal: i ? 1 : 0, image: ticket(i + 1), goodsList: { list: [{ id: i + 1, image: ticket(99) }] }, unknown: { image: ticket(88) } })), keep: { image: ticket(77) } }, image: ticket(66), keep: false }, before = clone(block);
  const saved = u.canonicalPromotionBlock(block);
  assert.deepEqual(saved.tabConfig.list.map(row => row.image), Array.from({ length: 16 }, (_, i) => `/api/assets/${i + 1}`));
  for (let i = 0; i < 16; i++) { assert.deepEqual(saved.tabConfig.list[i].goodsList, before.tabConfig.list[i].goodsList); assert.deepEqual(saved.tabConfig.list[i].unknown, before.tabConfig.list[i].unknown); }
  assert.equal(saved.image, ticket(66)); assert.deepEqual(saved.tabConfig.keep, before.tabConfig.keep); assert.deepEqual(block, before);
  const other = { name: 'unknown', tabConfig: { list: [{ image: ticket(7) }] } };
  assert.deepEqual(JSON.parse(u.canonicalPromotionValue(JSON.stringify([other, block])))[0], other);
  assert.throws(() => u.canonicalPromotionValue('null')); assert.equal(u.canonicalPromotionValue('{}'), '{}');
});

test('explicit raster setter stores stable asset identity without touching selection or ticket metadata', () => {
  const u = model(), block = u.newPromotionBlock(1); tab(u, block).goodsList = { ids: ['7'], list: [{ id: 7, image: ticket(7), keep: [] }] };
  assert.equal(u.setPromotionImage(block, 0, ` ${ticket(8)} `), true);
  assert.equal(tab(u, block).image, '/api/assets/8'); assert.equal(tab(u, block).goodsList.list[0].image, ticket(7));
  assert.equal(u.setPromotionImage(block, 0, '/api/assets/8'), false);
  for (const value of ['javascript:alert(1)', 'data:image/png;base64,AA', '//example.com/x', 'http://example.com/x', '/static/a b.png', '/static/a\\b.png', `/${'a'.repeat(4096)}`]) assert.throws(() => u.canonicalPromotionImage(value));
  for (const value of ['/static/images/diy/title.png', 'https://example.com/title.png', '']) assert.equal(u.canonicalPromotionImage(value), value);
});

test('managed image capability binds the exact whole block tab index whole tab and asset', () => {
  const u = model(), block = u.newPromotionBlock(1); tab(u, block).image = '/api/assets/7'; u.addPromotionTab(block); tab(u, block, 1).image = '/api/assets/7';
  const scope = u.promotionImageScope(block, 0), capability = { ...scope, preview: ticket(7) }, before = clone(block);
  assert.equal(u.promotionPreviewBlock(block, [capability]).tabConfig.list[0].image, ticket(7));
  assert.equal(u.promotionPreviewBlock(block, [capability]).tabConfig.list[1].image, '');
  for (const changed of [{ ...capability, block: scope.block + ' ' }, { ...capability, tabIndex: 1 }, { ...capability, tab: scope.tab + ' ' }, { ...capability, reference: '/api/assets/8' }, { ...capability, preview: ticket(8) }, { ...capability, preview: ticket(7, 1) }, { ...capability, preview: '/api/assets/7' }]) assert.equal(u.promotionPreviewBlock(block, [changed]).tabConfig.list[0].image, '');
  assert.deepEqual(block, before);
});

test('old image capabilities fail after other metadata raw ticket source or tab order changes', () => {
  const u = model(), block = u.newPromotionBlock(1); tab(u, block).image = ticket(7); u.addPromotionTab(block); tab(u, block, 1).image = ticket(8);
  const capability = { ...u.promotionImageScope(block, 0), preview: ticket(7) };
  assert.equal(u.promotionPreviewBlock(block).tabConfig.list[0].image, ''); // Inline old ticket alone is not approval.
  for (const mutate of [b => { b.unknown = false; }, b => { b.tabConfig.list[0].keep = []; }, b => { b.tabConfig.list[0].image = ticket(7, Math.floor(Date.now() / 1000) + 1000); }, b => { b.tabConfig.list.reverse(); }, b => { b.tabConfig.list[0].tabVal = 2; }]) {
    const changed = clone(block); mutate(changed); assert.equal(u.promotionPreviewBlock(changed, [capability]).tabConfig.list[0].image, '');
  }
  const publicBlock = { name: 'promotionList', tabConfig: { list: [{ image: '/static/a.png' }, { image: 'https://example.com/a.png' }, null, { image: 3 }] } };
  assert.deepEqual(u.promotionPreviewBlock(publicBlock), publicBlock);
});

test('selection identity display and raw query paths distinguish every source without mutation', () => {
  const u = model(), row = { goodsList: { ids: ['7'], list: [{ id: 7, store_name: '旧商品', image: ticket(7) }] }, goodsLabel: { activeValue: ['8'], list: [{ id: '8', label_name: '旧标签' }] } }, before = clone(row);
  assert.deepEqual(['product', 'brand', 'category', 'label'].map(kind => u.promotionSelectionPath(kind)), [['goodsList', 'ids'], ['brandConfig', 'brandVal'], ['selectConfig', 'activeValue'], ['goodsLabel', 'activeValue']]);
  assert.equal(u.promotionStoredName(row, 'product', '7'), '旧商品'); assert.equal(u.promotionStoredName(row, 'label', '8'), '旧标签'); assert.equal(u.promotionStoredName(row, 'brand', 9), '已存目标 #9');
  assert.match(u.promotionStoredName(row, 'category', { invalid: true }), /无效导入项/);
  for (const raw of [0, -1, '007', '1e2', '', ' 7 ', 2147483648, Infinity]) assert.equal(u.promotionIdentity(raw), null);
  for (const raw of [7, '7', { id: '7' }, { value: 7 }]) assert.equal(u.promotionSelectionId(raw), 7);
  assert.deepEqual(row, before);
});
