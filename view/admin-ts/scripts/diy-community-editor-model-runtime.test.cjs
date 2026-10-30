const { test, assert, path, fs, root, clone, loader, ticket } = require('./helpers/diy-navigation-runtime.cjs');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const utilFile = path.join(root, 'utils/diyCommunityEditor.ts');
const defaultsFile = path.join(root, 'utils/diyCommunityDefaults.ts');
const model = () => loader().load(utilFile);

test('complete literal community defaults retain all 36 PHP keys and every nested metadata field', () => {
  // Independently checked immutable PHP ref 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5.
  // home_community.vue:142–427 raw SHA256 748f9410bee33dc16f2e59e5a7a7bd4cc67e6f9434d9af789dfcb03d44f97bcc.
  // Whitelisted static bindings only: this.num → 0; exact community.png require → copied local PNG.
  const tree = ts.createSourceFile(defaultsFile, fs.readFileSync(defaultsFile, 'utf8'), ts.ScriptTarget.Latest, true);
  let literal;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'DIY_COMMUNITY_DEFAULTS') literal = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(tree);
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
  const expected = read(literal).community, u = model();
  assert.equal(Object.keys(expected).length, 36);
  assert.equal(createHash('sha256').update(JSON.stringify(expected)).digest('hex'), '02be08a3bd63da9147cf65db1a1c56ae474be297b7b1971ea46b28efc8e32b6d');
  assert.deepEqual(u.newCommunityBlock(17), { ...expected, timestamp: 17 });
  assert.deepEqual(expected.selectConfig, { title: '内容话题', activeValue: '', list: [{ activeValue: '', title: '' }, { activeValue: '', title: '' }] });
  assert.equal(expected.imgConfig.url, '/static/images/diy/community.png');
  assert.equal(expected.titleTxtConfig.max, 6);
  assert.equal(expected.rightBntConfig.max, 6);
  assert.equal(expected.videoSpace.val, 20);
  assert.equal(expected.videoSpace2.val, 10);
  const changed = u.newCommunityBlock(18);
  changed.selectConfig.list[0].title = 'explicit';
  changed.filletImg.valList[3].val = 99;
  assert.equal(u.newCommunityBlock(19).selectConfig.list[0].title, '');
  assert.equal(u.newCommunityBlock(19).filletImg.valList[3].val, 0);
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => u.newCommunityBlock(value));
});

test('both newly bound PNGs are the exact original 128 by 32 PHP asset bytes', () => {
  const admin = fs.readFileSync(path.resolve(root, '../public/static/images/diy/community.png'));
  const uni = fs.readFileSync(path.resolve(root, '../../uniapp-ts/src/static/images/diy/community.png'));
  assert.deepEqual(admin, uni);
  assert.equal(admin.length, 1886);
  assert.equal(admin.readUInt32BE(16), 128);
  assert.equal(admin.readUInt32BE(20), 32);
  assert.equal(createHash('sha256').update(admin).digest('hex'), '48785691c5387e98d65dc662913a3fdd3d146db9152b042d51f1f2647c8d8b4c');
});

test('discovery preserves duplicate hidden malformed and overflow imports without applying defaults', () => {
  const u = model(), rows = [null, { name: 'community', timestamp: ' 2e0 ', selectConfig: null }, { name: 'unknown', timestamp: -5 }, ...Array.from({ length: 251 }, (_, index) => ({ name: 'community', timestamp: index + 3, isHide: true, keep: [false, 0, ''] })), { name: 'community', timestamp: -2, extra: [] }, { name: 'community', timestamp: 'bad' }], original = clone(rows);
  assert.equal(u.communityEntries(rows).length, 254);
  assert.equal(u.communityEntries(rows)[0].index, 254);
  assert.equal(u.communityEntries(rows)[1].index, 1);
  assert.equal(u.communityEntries(rows).at(-1).index, 255);
  assert.deepEqual(u.communityDocument(JSON.stringify(rows)), rows);
  assert.deepEqual(rows, original);
  assert.deepEqual(u.COMMUNITY_NAMES, ['community']);
  assert.equal(u.communityKind('Community'), null);
  assert.equal(u.communityKind('community'), 'community');
});

test('ordinary adds insert complete new blocks before footer while preserving every neighbour', () => {
  const u = model(), rows = [{ name: 'titles', timestamp: ' 4.5 ', keep: ['a'] }, { name: 'unknown', timestamp: Number.MAX_SAFE_INTEGER }, { name: 'pageFoot', timestamp: 900, keep: false }], original = clone(rows);
  const first = u.addCommunityBlock(rows);
  assert.equal(first.selected, 2);
  assert.equal(first.value[2].timestamp, 5.5);
  assert.equal(Object.keys(first.value[2]).length, 36);
  assert.deepEqual(first.value.filter(row => row.name !== 'community'), rows);
  const second = u.addCommunityBlock(first.value);
  assert.equal(second.value.filter(row => row.name === 'community').length, 2);
  assert.equal(second.value.at(-1).name, 'pageFoot');
  assert.deepEqual(rows, original);
  assert.throws(() => u.addCommunityBlock([{ name: 'titles', timestamp: Number.MAX_SAFE_INTEGER }]), /排序空间不足/);
});

test('moves follow heterogeneous timestamp order and retain original string spellings', () => {
  const u = model(), rows = [{ name: 'community', timestamp: ' 3e0 ', numberConfig: { val: '003.0' }, keep: [] }, { name: 'unknown', timestamp: 2 }, { name: 'goodList', timestamp: ' 1.25 ', keep: false }, { name: 'follow', timestamp: 5 }, { name: 'pageFoot', timestamp: 4 }], original = clone(rows);
  const moved = u.moveCommunityBlock(rows, 0, -1);
  assert.equal(moved.selected, 2);
  assert.deepEqual(moved.value[2], { ...rows[0], timestamp: ' 1.25 ' });
  assert.deepEqual(moved.value[0], { ...rows[2], timestamp: ' 3e0 ' });
  for (const index of [1, 3, 4]) assert.deepEqual(moved.value[index], rows[index]);
  assert.deepEqual(u.moveCommunityBlock(moved.value, 2, 1).value, rows);
  assert.deepEqual(rows, original);
});

test('moves refuse header boundaries tied orders and malformed orders atomically', () => {
  const u = model();
  for (const name of ['homeComb', 'headerSerch', 'tabNav']) {
    const rows = [{ name, timestamp: 0 }, u.newCommunityBlock(1)], original = clone(rows);
    assert.throws(() => u.moveCommunityBlock(rows, 1, -1), /不能越过/);
    assert.deepEqual(rows, original);
  }
  for (const timestamp of [1, 'bad', undefined]) {
    const rows = [u.newCommunityBlock(1), { name: 'titles', timestamp }], original = structuredClone(rows);
    assert.throws(() => u.moveCommunityBlock(rows, 0, 1), /相同或异常/);
    assert.deepEqual(rows, original);
  }
  assert.throws(() => u.moveCommunityBlock([u.newCommunityBlock(1)], 0, 0), /移动方向/);
  assert.throws(() => u.moveCommunityBlock([{ name: 'news' }], 0, 1), /未选择/);
});

test('deletion removes only the explicitly selected community duplicate', () => {
  const u = model(), rows = [{ name: 'community', timestamp: 3, keep: [] }, { name: 'unknown', imgConfig: null }, { name: 'community', timestamp: 2, selectConfig: null }], original = clone(rows);
  const result = u.removeCommunityBlock(rows, 0);
  assert.deepEqual(result, { value: rows.slice(1), selected: 1 });
  assert.equal(u.removeCommunityBlock(result.value, 1).selected, -1);
  assert.deepEqual(rows, original);
  assert.throws(() => u.removeCommunityBlock(rows, 1), /未选择/);
});

test('number projection has no implicit author cap and never rewrites imported data', () => {
  const u = model(), block = { name: 'community', numberConfig: { val: ' 2.5e2 ', keep: false } }, original = clone(block);
  assert.equal(u.communityNumber(block.numberConfig.val), 250);
  assert.equal(u.communityNumber(block.numberConfig.val, 3, 100), 100);
  for (const value of ['', ' ', 'bad', false, null, NaN, Infinity, -1]) assert.equal(u.communityNumber(value, 7), 7);
  assert.deepEqual(block, original);
});

test('same numeric events retain exact imported spellings on all scalar and corner paths', () => {
  const u = model(), block = { name: 'community', numberConfig: { val: '003.0', min: 1 }, titleNumber: { val: ' 2e1 ', keep: [] }, filletImg: { type: '1', valList: [{ val: ' 1e0 ' }, { val: '02' }, { val: '3.0' }, { val: 4 }] }, selectConfig: { activeValue: '007', list: [] }, keep: false }, original = clone(block);
  assert.equal(u.setCommunityNumber(block, ['numberConfig', 'val'], 3, 1, 100), false);
  assert.equal(u.setCommunityNumber(block, ['titleNumber', 'val'], 20), false);
  for (let index = 0; index < 4; index++) assert.equal(u.setCommunityNumber(block, ['filletImg', 'valList', index, 'val'], index + 1), false);
  assert.deepEqual(block, original);
  assert.equal(u.setCommunityNumber(block, ['titleNumber', 'val'], 21), true);
  assert.deepEqual(block, { ...original, titleNumber: { ...original.titleNumber, val: 21 } });
});

test('invalid typed numeric edits and broken parents never partially change imports', () => {
  const u = model(), block = { name: 'community', numberConfig: { val: '003', min: 1 }, fillet: null, keep: [] }, original = clone(block);
  for (const value of ['3', false, null, NaN, Infinity, -1, 101]) {
    assert.throws(() => u.setCommunityNumber(block, ['numberConfig', 'val'], value, 1, 100), /有效数字/);
    assert.deepEqual(block, original);
  }
  assert.throws(() => u.setCommunityNumber(block, ['fillet', 'val'], 7), /结构异常/);
  assert.deepEqual(block, original);
});

test('explicit leaf setters preserve unknown fields and validate the whole edit before mutation', () => {
  const u = model(), block = { name: 'community', imgConfig: { url: '/static/a.png', keep: false }, titleTxtConfig: { value: 'a', extra: [1] }, selectConfig: { list: ['imported'] }, keep: [] }, original = clone(block);
  assert.equal(u.communitySet(block, ['titleTxtConfig', 'value'], 'a'), false);
  assert.equal(u.communitySet(block, ['titleTxtConfig', 'value'], 'a much longer imported title'), true);
  assert.deepEqual(block, { ...original, titleTxtConfig: { ...original.titleTxtConfig, value: 'a much longer imported title' } });
  const updated = clone(block);
  for (const path of [[], ['__proto__', 'polluted'], ['constructor', 'prototype', 'x'], ['selectConfig', 'list', -1]]) assert.throws(() => u.communitySet(block, path, 'bad'));
  for (const value of [undefined, NaN, Infinity, () => 1, new Date()]) assert.throws(() => u.communitySet(block, ['titleTxtConfig', 'value'], value));
  assert.deepEqual(block, updated);
  assert.equal({}.polluted, undefined);
});

test('topic metadata edits preserve number or string identities and never manufacture filter or links', () => {
  const u = model(), block = { name: 'community', selectConfig: { title: '内容话题', activeValue: ' 007 ', list: [{ activeValue: 7, title: 'topic', extra: [] }], keep: false }, numberConfig: { val: '003' }, imgConfig: { url: ticket(12) }, extra: { keep: true } }, original = clone(block);
  assert.equal(u.setCommunityTopicMetadata(block, { activeValue: ' 007 ' }), false);
  assert.deepEqual(block, original);
  assert.equal(u.setCommunityTopicMetadata(block, { activeValue: 7 }), true);
  assert.strictEqual(block.selectConfig.activeValue, 7);
  assert.deepEqual(block, { ...original, selectConfig: { ...original.selectConfig, activeValue: 7 } });
  assert.equal(u.setCommunityTopicMetadata(block, { activeValue: '007' }), true);
  assert.strictEqual(block.selectConfig.activeValue, '007');
  assert.equal(u.setCommunityTopicMetadata(block, {}), false);
  for (const key of ['topic_id', 'filters', 'link', 'navigation']) assert.equal(Object.hasOwn(block, key), false);
});

test('explicit topic-list editing retains overflow malformed rows and arbitrary safe metadata exactly', () => {
  const u = model(), block = { name: 'community', selectConfig: { activeValue: 7, title: 'topics', keep: ticket(50), list: [] } };
  const list = [null, 5, 'imported', ...Array.from({ length: 251 }, (_, index) => ({ activeValue: index % 2 ? String(index) : index, title: `topic${index}`, img: ticket(index + 1), unknown: [false, 0, ''] }))], expected = clone(list);
  assert.equal(u.setCommunityTopicMetadata(block, { activeValue: ' 2e0 ', list }), true);
  assert.deepEqual(block.selectConfig, { activeValue: ' 2e0 ', title: 'topics', keep: ticket(50), list: expected });
  list[3].title = 'mutated caller';
  assert.deepEqual(block.selectConfig.list, expected);
  assert.equal(block.selectConfig.list.length, 254);
  assert.equal(u.setCommunityTopicMetadata(block, { list: clone(expected) }), false);
});

test('combined topic metadata patches are atomic for invalid lists values and prototype keys', () => {
  const u = model(), block = { name: 'community', selectConfig: { title: 'topics', activeValue: '003', list: [{ title: 'keep', activeValue: 3 }], extra: [] }, keep: false }, original = clone(block);
  const sparse = Array(2); sparse[0] = 'keep'; sparse.extra = 'not an index';
  const getter = {}; Object.defineProperty(getter, 'title', { enumerable: true, get() { throw Error('getter must not execute'); } });
  const invalid = [
    { activeValue: 8, list: null }, { activeValue: 8, list: {} }, { activeValue: NaN }, { activeValue: true }, { activeValue: [] }, { activeValue: undefined },
    { activeValue: 8, list: [undefined] }, { activeValue: 8, list: [new Date()] }, { activeValue: 8, list: [getter] }, { activeValue: 8, list: sparse },
    JSON.parse('{"activeValue":8,"list":[{"__proto__":{"x":1}}]}'), { activeValue: 8, topic_id: 8 }, Object.create({ activeValue: 8 }),
  ];
  for (const patch of invalid) {
    assert.throws(() => u.setCommunityTopicMetadata(block, patch));
    assert.deepEqual(block, original);
  }
  for (const value of [null, false, 0, []]) {
    const broken = { name: 'community', selectConfig: value, keep: [] }, old = clone(broken);
    assert.throws(() => u.setCommunityTopicMetadata(broken, { activeValue: 7 }), /结构异常/);
    assert.deepEqual(broken, old);
  }
  assert.throws(() => u.setCommunityTopicMetadata({ name: 'news' }, { activeValue: 7 }), /未选择/);
  assert.equal({}.x, undefined);
});

test('topic metadata edits do not fill omitted defaults or repair malformed untouched option lists', () => {
  const u = model(), missing = { name: 'community', keep: false };
  assert.equal(u.setCommunityTopicMetadata(missing, { activeValue: 7 }), true);
  assert.deepEqual(missing, { name: 'community', keep: false, selectConfig: { activeValue: 7 } });
  const malformed = { name: 'community', selectConfig: { activeValue: 0, list: null, keep: [] } };
  u.setCommunityTopicMetadata(malformed, { activeValue: '' });
  assert.deepEqual(malformed, { name: 'community', selectConfig: { activeValue: '', list: null, keep: [] } });
});

test('save canonicalizes only imgConfig.url and preserves all topic and unrelated media metadata', () => {
  const u = model(), rows = [{ name: 'community', imgConfig: { url: ticket(7), type: 'code', extra: ticket(8) }, selectConfig: { activeValue: '003', list: [{ activeValue: 3, title: ticket(9), img: ticket(10) }] }, rightBntConfig: { value: ticket(11) }, image: ticket(12), list: [{ image: ticket(13) }], extra: false }, { name: 'community', imgConfig: null, keep: [] }, { name: 'unknown', imgConfig: { url: ticket(14) } }, ...Array.from({ length: 251 }, (_, index) => ({ name: 'community', imgConfig: { url: ticket(index + 20) }, selectConfig: { activeValue: index } }))], original = clone(rows), expected = clone(rows);
  expected[0].imgConfig.url = '/api/assets/7';
  for (let index = 3; index < expected.length; index++) expected[index].imgConfig.url = `/api/assets/${index + 17}`;
  assert.deepEqual(JSON.parse(u.canonicalCommunityValue(JSON.stringify(rows))), expected);
  assert.deepEqual(rows, original);
  assert.equal(u.canonicalCommunityValue('{"legacy":true}'), '{"legacy":true}');
  assert.throws(() => u.canonicalCommunityValue('null'), /不能为 null/);
});

test('explicit image selection canonicalizes tickets and rejects unsafe syntax without touching metadata', () => {
  const u = model();
  assert.equal(u.canonicalCommunityImage(` ${ticket(7)} `), '/api/assets/7');
  assert.equal(u.canonicalCommunityImage('/static/images/diy/community.png'), '/static/images/diy/community.png');
  assert.equal(u.canonicalCommunityImage('https://example.com/banner.png'), 'https://example.com/banner.png');
  assert.equal(u.canonicalCommunityImage(''), '');
  for (const value of ['javascript:alert(1)', 'data:image/png;base64,AA', '//example.com/x', 'http://example.com/x', '/static/a b.png', '/static/a\\b.png', '/static/\u0000.png', `/${'a'.repeat(4096)}`]) assert.throws(() => u.canonicalCommunityImage(value));
});

test('preview capabilities must match the sole exact stored image identity and remain fresh', () => {
  const u = model(), block = { name: 'community', imgConfig: { url: '/api/assets/7', keep: ticket(8) }, selectConfig: { activeValue: ticket(9), list: [] } }, original = clone(block);
  assert.equal(u.communityPreviewBlock(block, { '/api/assets/7': ticket(7) }).imgConfig.url, ticket(7));
  for (const value of [ticket(8), ticket(7, 1), '/api/assets/7', '', 'javascript:alert(1)']) assert.equal(u.communityPreviewBlock(block, { '/api/assets/7': value }).imgConfig.url, '');
  assert.deepEqual(u.communityPreviewBlock(block, {}).selectConfig, original.selectConfig);
  assert.deepEqual(block, original);
  for (const reference of ['/static/images/diy/community.png', 'https://example.com/title.png']) assert.equal(u.communityPreviewBlock({ name: 'community', imgConfig: { url: reference } }, {}).imgConfig.url, reference);
  const other = { name: 'unknown', imgConfig: { url: '/api/assets/7' } };
  assert.deepEqual(u.communityPreviewBlock(other, {}), other);
});

test('complete-document guards reject unsafe depth and oversized data without clipping imported blocks', () => {
  const u = model();
  assert.throws(() => u.communityDocument('{}'), /JSON 数组/);
  assert.throws(() => u.communityDocument('[{"name":"community","__proto__":{}}]'), /不安全字段/);
  let nested = {};
  for (let index = 0; index < 66; index++) nested = { keep: nested };
  assert.throws(() => u.communityDocument(JSON.stringify([{ name: 'community', nested }])), /64 层/);
  assert.throws(() => u.communityDocument(JSON.stringify([{ name: 'community', keep: 'a'.repeat(2_000_001) }])), /超过 2 MB/);
  const block = { name: 'community', selectConfig: { activeValue: '003', keep: false } }, original = clone(block);
  assert.throws(() => u.setCommunityTopicMetadata(block, { activeValue: 8, list: [nested] }), /64 层/);
  assert.deepEqual(block, original);
});
