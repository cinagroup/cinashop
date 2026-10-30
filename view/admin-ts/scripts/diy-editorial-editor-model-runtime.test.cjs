const { test, assert, path, fs, root, clone, loader, ticket } = require('./helpers/diy-navigation-runtime.cjs');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const utilFile = path.join(root, 'utils/diyEditorialEditor.ts');
const defaultsFile = path.join(root, 'utils/diyEditorialDefaults.ts');
const model = () => loader().load(utilFile);

test('three complete literal PHP defaults keep every metadata field and immutable source binding', () => {
  // Independent literal contract at PHP 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5.
  // home_news_roll.vue SHA e87f0c1db80d153b72b826c0b57c0ced25b0424adb736ca90c8e5369dc88d0d8;
  // home_hotspot.vue SHA bbbfdad36b04ccd0b0dabc4e9ec65e1d6bd50b9bd4240d9aa232286e5ce9a66c;
  // home_hot.vue SHA 766f936ccd0c88094a60fe423d120d9b23cbfa289d52218f6bdbe29ad0d22ca5.
  // Source AST permits only literals, this.num → 0 and exact news2 require → local PNG.
  const source = ts.createSourceFile(defaultsFile, fs.readFileSync(defaultsFile, 'utf8'), ts.ScriptTarget.Latest, true);
  let literal;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'DIY_EDITORIAL_DEFAULTS') literal = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  function read(node) {
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(property => {
      assert.ok(ts.isPropertyAssignment(property));
      return [property.name.text, read(property.initializer)];
    }));
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(read);
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    assert.fail('Only static PHP-bound literals are permitted');
  }
  const expected = read(literal), u = model();
  const hashes = {
    news: '2e6e12ca6ff36831821c08ee3890a1e0be7a215f70d6b5933421962c69268ec8',
    hotspot: 'ce698853e73d86e7994e939a2ad322b1286cbda828f96a115fe768861d657dde',
    activeParty: '2f5e0e72b23dd89a47751590f473e187ac01500d65438e6d933676c4a85406c3',
  };
  assert.deepEqual(Object.keys(expected), ['news', 'hotspot', 'activeParty']);
  assert.deepEqual(Object.values(expected).map(value => Object.keys(value).length), [32, 14, 10]);
  for (const kind of u.EDITORIAL_NAMES) {
    assert.equal(createHash('sha256').update(JSON.stringify(expected[kind])).digest('hex'), hashes[kind]);
    assert.deepEqual(u.newEditorialBlock(kind, 17), { ...expected[kind], timestamp: 17 });
    const changed = u.newEditorialBlock(kind, 18);
    changed.setUp.tabVal = 1;
    assert.equal(u.newEditorialBlock(kind, 19).setUp.tabVal, 0);
    for (const invalid of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => u.newEditorialBlock(kind, invalid));
  }
  assert.equal(u.newEditorialBlock('news', 0).imgConfig.url, '/static/images/diy/news2.png');
  assert.throws(() => u.newEditorialBlock('follow', 0), /类型/);
});

test('entry discovery preserves duplicates, hidden imports, overflow bodies and every unknown neighbour', () => {
  const u = model(), rows = [null, { name: 'news', timestamp: ' 2e0 ', listConfig: null }, { name: 'unknown', timestamp: -5 }, ...Array.from({ length: 205 }, (_, index) => ({ name: 'titles', timestamp: index })), { name: 'hotspot', timestamp: -2, isHide: 'true', extra: [] }, { name: 'activeParty', timestamp: 'invalid' }, { name: 'news', timestamp: 3 }], original = clone(rows);
  assert.deepEqual(u.editorialEntries(rows).map(row => [row.index, row.kind]), [[208, 'hotspot'], [1, 'news'], [210, 'news'], [209, 'activeParty']]);
  assert.deepEqual(u.editorialDocument(JSON.stringify(rows)), rows);
  assert.deepEqual(rows, original);
});

test('new ordinary editorial blocks insert before independent footer using only rendered body order', () => {
  const u = model(), rows = [{ name: 'titles', timestamp: ' 4.5 ', extra: ['keep'] }, { name: 'unknown', timestamp: Number.MAX_SAFE_INTEGER }, { name: 'pageFoot', timestamp: 900, data: { keep: 0 } }], original = clone(rows);
  for (const kind of u.EDITORIAL_NAMES) {
    const added = u.addEditorialBlock(rows, kind);
    assert.equal(added.selected, 2);
    assert.equal(added.value[2].name, kind);
    assert.equal(added.value[2].timestamp, 5.5);
    assert.deepEqual(added.value.filter(row => row.name !== kind), rows);
    assert.equal(u.addEditorialBlock(added.value, kind).value.filter(row => row.name === kind).length, 2);
    assert.equal(added.value.at(-1).name, 'pageFoot');
    assert.throws(() => u.addEditorialBlock([{ name: 'titles', timestamp: Number.MAX_SAFE_INTEGER }], kind), /排序空间不足/);
  }
  assert.deepEqual(rows, original);
});

test('body moves preserve raw timestamp spellings and exact heterogeneous neighbours', () => {
  const u = model();
  for (const kind of u.EDITORIAL_NAMES) {
    const rows = [{ name: kind, timestamp: ' 3e0 ', imported: { keep: 0 }, isHide: true }, { name: 'unknown', timestamp: 2, extra: [] }, { name: 'goodList', timestamp: ' 1.25 ', extra: { keep: true } }, { name: 'follow', timestamp: 5 }, { name: 'pageFoot', timestamp: 4 }], original = clone(rows);
    const moved = u.moveEditorialBlock(rows, 0, -1);
    assert.equal(moved.selected, 2);
    assert.deepEqual(moved.value[2], { ...rows[0], timestamp: ' 1.25 ' });
    assert.deepEqual(moved.value[0], { ...rows[2], timestamp: ' 3e0 ' });
    for (const index of [1, 3, 4]) assert.deepEqual(moved.value[index], rows[index]);
    assert.deepEqual(rows, original);
    assert.deepEqual(u.moveEditorialBlock(moved.value, 2, 1).value, rows);
  }
});

test('body moves reject header boundaries and tied or malformed orders without mutation', () => {
  const u = model();
  for (const header of ['homeComb', 'headerSerch', 'tabNav']) {
    const rows = [{ name: header, timestamp: 0 }, u.newEditorialBlock('news', 1)], original = clone(rows);
    assert.throws(() => u.moveEditorialBlock(rows, 1, -1), /不能越过/);
    assert.deepEqual(rows, original);
  }
  for (const raw of ['bad', 1]) {
    const rows = [u.newEditorialBlock('hotspot', 1), { name: 'titles', timestamp: raw }], original = clone(rows);
    assert.throws(() => u.moveEditorialBlock(rows, 0, 1), /相同或异常/);
    assert.deepEqual(rows, original);
  }
  assert.throws(() => u.moveEditorialBlock([u.newEditorialBlock('activeParty', 1)], 0, 0), /移动方向/);
  assert.throws(() => u.moveEditorialBlock([{ name: 'unknown' }], 0, 1), /未选择/);
});

test('block deletion removes only the explicitly selected duplicate', () => {
  const u = model(), rows = [{ name: 'news', timestamp: 3, imported: [] }, { name: 'unknown', value: false }, { name: 'news', timestamp: 2, listConfig: null }], original = clone(rows);
  const removed = u.removeEditorialBlock(rows, 0);
  assert.deepEqual(removed, { value: rows.slice(1), selected: 1 });
  assert.deepEqual(rows, original);
  assert.equal(u.removeEditorialBlock(removed.value, 1).selected, -1);
  assert.throws(() => u.removeEditorialBlock(rows, 1), /未选择/);
});

test('all imported items remain visible to author actions beyond public capacities', () => {
  const u = model();
  for (const [kind, limit] of [['news', 10], ['activeParty', 4], ['hotspot', 30]]) {
    const block = u.newEditorialBlock(kind, 0), items = Array.from({ length: limit + 5 }, (_, index) => ({ imported: index, unknown: [false, 0, ''] }));
    items[1] = null;
    u.editorialSet(block, u.itemListPath(kind), clone(items));
    assert.equal(u.editorialItems(block).length, limit + 5);
    const original = clone(block);
    assert.throws(() => u.addEditorialItem(block, 600, 300), /普通新增最多/);
    assert.deepEqual(block, original);
    assert.equal(u.moveEditorialItem(block, limit + 3, 1), limit + 4);
    const moved = clone(items);
    [moved[limit + 3], moved[limit + 4]] = [moved[limit + 4], moved[limit + 3]];
    assert.deepEqual(u.editorialItems(block), moved);
    assert.equal(u.removeEditorialItem(block, limit + 4), limit + 3);
    moved.splice(limit + 4, 1);
    assert.deepEqual(u.editorialItems(block), moved);
  }
});

test('ordinary item additions use fresh static metadata without inheriting imported tail fields', () => {
  const u = model(), news = u.newEditorialBlock('news', 0);
  news.listConfig.list[0].chiild[0].max = 999;
  news.listConfig.list[0].extra = { mustNotCopy: true };
  assert.equal(u.addEditorialItem(news), 1);
  assert.deepEqual(news.listConfig.list[1], { chiild: [{ title: '标题', val: '标题', max: 20, pla: '输入标题' }, { title: '链接', val: '', max: 200, pla: '输入连接' }], show: true });
  const party = u.newEditorialBlock('activeParty', 0);
  assert.throws(() => u.addEditorialItem(party), /最多 4/);
  u.removeEditorialItem(party, 3);
  assert.equal(u.addEditorialItem(party), 3);
  assert.deepEqual(party.menuConfig.list[3], { img: '', info: [{ title: '标题', value: '', tips: '选填，不超过4个字', max: 4 }, { title: '简介', value: '', tips: '选填，不超过20个字', max: 20 }, { title: '链接', value: '', tips: '请输入链接', max: 100 }] });
  assert.equal(party.menuConfig.list[0].info[0].value, '今日推荐');
});

test('hotspot additions require actual loaded dimensions and retain the complete PHP region shape', () => {
  const u = model(), hotspot = u.newEditorialBlock('hotspot', 0), original = clone(hotspot);
  for (const [width, height] of [[undefined, undefined], [0, 200], [200, 0], [NaN, 300], [400, Infinity]]) {
    assert.throws(() => u.addEditorialItem(hotspot, width, height), /实际加载/);
    assert.deepEqual(hotspot, original);
  }
  assert.equal(u.addEditorialItem(hotspot, 600, 300), 0);
  assert.deepEqual(hotspot.picStyle.list[0], { number: 1, starX: 0, starY: 0, areaWidth: 100, areaHeight: 100, nowImgWidth: 750, link: '' });
  assert.equal(u.addEditorialItem(hotspot, 750, 50), 1);
  assert.deepEqual(hotspot.picStyle.list[1], { number: 2, starX: 0, starY: 0, areaWidth: 100, areaHeight: 50, nowImgWidth: 750, link: '' });
});

test('hotspot geometry validates the real image ratio and changes only the four selected coordinates', () => {
  const u = model(), row = { number: '09', starX: ' 2e0 ', starY: 3, areaWidth: 100, areaHeight: 20, nowImgWidth: '750', link: '/pages/index/index', title: 'keep', unknown: [false, 0] };
  const hotspot = { name: 'hotspot', picStyle: { url: '/static/banner.png', list: [row] } };
  const original = clone(hotspot);
  // A 600×300 image is exactly 750×375 in design coordinates.
  for (const rectangle of [{ left: 650, top: 300, width: 101, height: 75 }, { left: 650, top: 300, width: 100, height: 76 }, { left: -1, top: 0, width: 1, height: 1 }, { left: 0, top: 0, width: 0, height: 1 }, { left: 0, top: NaN, width: 1, height: 1 }]) {
    assert.throws(() => u.setHotspotGeometry(hotspot, 0, rectangle, 600, 300), /实际比例边界/);
    assert.deepEqual(hotspot, original);
  }
  u.setHotspotGeometry(hotspot, 0, { left: 650, top: 300, width: 100, height: 75 }, 600, 300);
  assert.deepEqual(hotspot.picStyle.list[0], { ...row, starX: 650, starY: 300, areaWidth: 100, areaHeight: 75 });
  assert.equal(u.validHotspotGeometry({ left: 0, top: 900, width: 750, height: 600 }, 300, 600), true);
  // The public consumer rejects any individual coordinate above one million,
  // even if an extremely tall loaded image would otherwise contain the box.
  assert.equal(u.validHotspotGeometry({ left: 0, top: 1_000_001, width: 100, height: 100 }, 750, 2_000_000), false);
  assert.equal(u.validHotspotGeometry({ left: 0, top: 0, width: 100, height: 1_000_001 }, 750, 2_000_000), false);
  assert.throws(() => u.setHotspotGeometry(hotspot, 1, { left: 0, top: 0, width: 1, height: 1 }, 600, 300), /索引/);
});

test('explicit link edits preserve imported metadata and reject unsafe destinations atomically', () => {
  const u = model(), news = u.newEditorialBlock('news', 0), party = u.newEditorialBlock('activeParty', 0), hotspot = u.newEditorialBlock('hotspot', 0);
  u.addEditorialItem(hotspot, 600, 300);
  for (const [block, index, target] of [[news, 0, ['listConfig', 'list', 0, 'chiild', 1, 'val']], [news, -1, ['linkConfig', 'value']], [party, 2, ['menuConfig', 'list', 2, 'info', 2, 'value']], [hotspot, 0, ['picStyle', 'list', 0, 'link']]]) {
    const expected = clone(block);
    u.editorialSet(expected, target, '/pages/index/index');
    u.setEditorialLink(block, index, '/pages/index/index');
    assert.deepEqual(block, expected);
    const original = clone(block);
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//example.com/path']) assert.throws(() => u.setEditorialLink(block, index, bad), /安全有效/);
    assert.deepEqual(block, original);
  }
  assert.throws(() => u.setEditorialLink(party, -1, '/pages/index/index'), /条目损坏/);
  assert.throws(() => u.setEditorialLink(news, 50, '/pages/index/index'), /条目损坏/);
});

test('explicit image replacement clears regions but ticket renewal for the same asset preserves all region data', () => {
  const u = model(), block = { name: 'hotspot', picStyle: { url: '/api/assets/7', list: [{ number: '05', starX: 1, link: ticket(9), unknown: [] }], unknown: 0 }, extra: false }, regions = clone(block.picStyle.list);
  u.setHotspotImage(block, ticket(7));
  assert.equal(block.picStyle.url, '/api/assets/7');
  assert.deepEqual(block.picStyle.list, regions);
  u.setHotspotImage(block, ticket(8));
  assert.deepEqual(block, { name: 'hotspot', picStyle: { url: '/api/assets/8', list: [], unknown: 0 }, extra: false });
  const original = clone(block);
  assert.throws(() => u.setHotspotImage(block, 'javascript:alert(1)'));
  assert.deepEqual(block, original);
});

test('save canonicalization covers consumed image slots while preserving all dormant tail links and metadata', () => {
  const u = model(), rows = [{ name: 'news', imgConfig: { url: ticket(7), unknown: ticket(8) }, linkConfig: { value: ticket(9) }, listConfig: { list: [{ chiild: [{ val: ticket(10) }, { val: ticket(11) }], show: true }] } }, { name: 'hotspot', picStyle: { url: ticket(12), list: [{ link: ticket(13), starX: ' 2e0 ', unknown: [] }] } }, { name: 'activeParty', titleConfig: { value: 'keep', place: 'preserve', max: 10 }, desConfig: { value: 'keep too', place: 'preserve too', max: 8 }, menuConfig: { maxList: 4, list: Array.from({ length: 7 }, (_, index) => ({ img: ticket(20 + index), info: [{ value: 'title' }, { value: 'description' }, { value: ticket(30 + index) }], unknown: ticket(40 + index) })) } }, { name: 'unknown', imgConfig: { url: ticket(50) } }, { name: 'news', imgConfig: [] }], original = clone(rows);
  const saved = JSON.parse(u.canonicalEditorialValue(JSON.stringify(rows))), expected = clone(rows);
  expected[0].imgConfig.url = '/api/assets/7';
  expected[1].picStyle.url = '/api/assets/12';
  for (let index = 0; index < 4; index++) expected[2].menuConfig.list[index].img = `/api/assets/${20 + index}`;
  assert.deepEqual(saved, expected);
  assert.deepEqual(rows, original);
  assert.equal(u.canonicalEditorialValue('{"legacy":true}'), '{"legacy":true}');
  assert.throws(() => u.canonicalEditorialValue('null'), /不能为 null/);
});

test('previews require current capabilities matching the exact declared media identity', () => {
  const u = model(), rows = [u.newEditorialBlock('news', 0), u.newEditorialBlock('hotspot', 1), u.newEditorialBlock('activeParty', 2)];
  rows[0].imgConfig.url = '/api/assets/7';
  rows[1].picStyle.url = '/api/assets/8';
  rows[2].menuConfig.list = [{ img: '/api/assets/9', link: ticket(30), unknown: [] }, { img: '/static/card.png' }, { img: 'https://example.com/card.png' }, { img: '/api/assets/10' }, { img: '/api/assets/11' }];
  const original = clone(rows), previews = { '/api/assets/7': ticket(7), '/api/assets/8': ticket(9), '/api/assets/9': ticket(9, 1), '/api/assets/10': ticket(10), '/api/assets/11': ticket(11) };
  assert.equal(u.editorialPreviewBlock(rows[0], previews).imgConfig.url, ticket(7));
  assert.equal(u.editorialPreviewBlock(rows[1], previews).picStyle.url, '');
  assert.deepEqual(u.editorialPreviewBlock(rows[2], previews).menuConfig.list, [{ ...rows[2].menuConfig.list[0], img: '' }, { img: '/static/card.png' }, { img: 'https://example.com/card.png' }, { img: ticket(10) }, { img: '/api/assets/11' }]);
  assert.deepEqual(rows, original);
  assert.equal(u.editorialPreviewBlock({ name: 'unknown', imgConfig: { url: '/api/assets/7' } }, previews).imgConfig.url, '/api/assets/7');
});

test('malformed imported structures require explicit JSON repair and no action silently replaces them', () => {
  const u = model();
  for (const [kind, field] of [['news', 'listConfig'], ['hotspot', 'picStyle'], ['activeParty', 'menuConfig']]) for (const container of [null, { list: null }, { list: 7 }, { list: false }]) {
    const block = { name: kind, [field]: container, extra: [false, 0] }, original = clone(block);
    assert.deepEqual(u.editorialItems(block), []);
    assert.throws(() => u.addEditorialItem(block, 600, 300), /结构异常/);
    assert.deepEqual(block, original);
  }
  assert.throws(() => u.editorialDocument('{}'), /JSON 数组/);
  assert.throws(() => u.editorialDocument('[{"name":"news","__proto__":{}}]'), /不安全字段/);
  let nested = {};
  for (let i = 0; i < 66; i++) nested = { keep: nested };
  assert.throws(() => u.editorialDocument(JSON.stringify([{ name: 'news', extra: nested }])), /64 层/);
  const rows = Array.from({ length: 251 }, (_, index) => ({ name: 'news', timestamp: index, extra: [false, 0, ''] }));
  assert.equal(u.editorialDocument(JSON.stringify(rows)).length, rows.length);
});

test('explicit image fields canonicalize asset tickets and reject unsafe URL syntax', () => {
  const u = model();
  assert.equal(u.canonicalEditorialImage(` ${ticket(7)} `), '/api/assets/7');
  assert.equal(u.canonicalEditorialImage('/static/images/banner.png'), '/static/images/banner.png');
  assert.equal(u.canonicalEditorialImage('https://example.com/banner.png'), 'https://example.com/banner.png');
  assert.equal(u.canonicalEditorialImage(''), '');
  for (const raw of ['javascript:alert(1)', 'data:image/png;base64,AA', '//example.com/banner.png', 'http://example.com/banner.png', '/static/a b.png', '/static/a\\b.png', '/static/\u0000.png', `/${'a'.repeat(4096)}`]) assert.throws(() => u.canonicalEditorialImage(raw));
});
