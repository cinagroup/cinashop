const { test, assert, path, fs, root, clone, loader, ticket } = require('./helpers/diy-navigation-runtime.cjs');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const utilFile = path.join(root, 'utils/diyFollowEditor.ts');
const defaultsFile = path.join(root, 'utils/diyFollowDefaults.ts');
const model = () => loader().load(utilFile);

test('new follow blocks exactly preserve the statically extracted PHP 8ed2a5b default contract', () => {
  // Independent source contract: z_wechat_attention.vue:73–181 at immutable
  // 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5, source SHA256
  // 8e96a58d3d3cbb2bd8bdbf166838e0f870f4e0d1b4d8d57bee49420d67b79263.
  // Only this.num is bound to zero. No PHP component or source expression runs.
  const source = ts.createSourceFile(defaultsFile, fs.readFileSync(defaultsFile, 'utf8'), ts.ScriptTarget.Latest, true);
  let literal;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'DIY_FOLLOW_DEFAULTS') literal = node.initializer;
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
    assert.fail('Expected a static literal');
  }
  const expected = read(literal), serialized = JSON.stringify(expected);
  assert.equal(Buffer.byteLength(serialized), 1185);
  assert.equal(createHash('sha256').update(serialized).digest('hex'), '1dc548f44c1910c0bfdbebcace10e76c65fb014e4d515b78a8618e0217492c13');
  const u = model(), first = u.newFollowBlock(17), second = u.newFollowBlock(18);
  assert.deepEqual(first, { ...expected, timestamp: 17 });
  first.fillet.valList[0].val = 9;
  assert.equal(second.fillet.valList[0].val, 0);
  assert.equal(u.newFollowBlock(19).fillet.valList[0].val, 0);
  for (const invalid of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => u.newFollowBlock(invalid));
});

test('entry discovery keeps duplicate and late imported follow blocks without merging or rewriting', () => {
  const u = model(), rows = [null, { name: 'follow', timestamp: ' 2e0 ', titleConfig: null }, { name: 'unknown', timestamp: -5 }, ...Array.from({ length: 205 }, (_, index) => ({ name: 'titles', timestamp: index })), { name: 'follow', timestamp: -2, isHide: 'true', extra: [] }, { name: 'follow', timestamp: 'invalid' }];
  const original = clone(rows);
  assert.deepEqual(u.followEntries(rows).map(row => row.index), [208, 1, 209]);
  assert.deepEqual(u.followDocument(JSON.stringify(rows)), rows);
  assert.deepEqual(rows, original);
});

test('add inserts before an independent footer and derives order only from renderable body neighbours', () => {
  const u = model(), rows = [{ name: 'titles', timestamp: ' 4.5 ', extra: ['keep'] }, { name: 'unknown', timestamp: Number.MAX_SAFE_INTEGER }, { name: 'pageFoot', timestamp: 900, data: { keep: 0 } }], original = clone(rows);
  const added = u.addFollowBlock(rows);
  assert.equal(added.selected, 2);
  assert.equal(added.value[2].name, 'follow');
  assert.equal(added.value[2].timestamp, 5.5);
  assert.deepEqual(added.value.filter(row => row.name !== 'follow'), rows);
  assert.deepEqual(rows, original);
  const another = u.addFollowBlock(added.value);
  assert.equal(another.value.filter(row => row.name === 'follow').length, 2);
  assert.equal(another.value.at(-1).name, 'pageFoot');
  assert.throws(() => u.addFollowBlock([{ name: 'titles', timestamp: Number.MAX_SAFE_INTEGER }]), /排序空间不足/);
});

test('move follows complete body timestamp order and preserves raw numeric strings and unknown neighbours', () => {
  const u = model(), rows = [{ name: 'follow', timestamp: ' 3e0 ', titleConfig: { value: '甲', extra: 0 }, isHide: true }, { name: 'unknown', timestamp: 2, extra: [] }, { name: 'goodList', timestamp: ' 1.25 ', extra: { keep: true } }, { name: 'news', timestamp: 5 }, { name: 'pageFoot', timestamp: 4 }], original = clone(rows);
  const moved = u.moveFollowBlock(rows, 0, -1);
  assert.equal(moved.selected, 2);
  assert.deepEqual(moved.value[2], { ...rows[0], timestamp: ' 1.25 ' });
  assert.deepEqual(moved.value[0], { ...rows[2], timestamp: ' 3e0 ' });
  assert.deepEqual(moved.value[1], rows[1]);
  assert.deepEqual(moved.value[3], rows[3]);
  assert.deepEqual(moved.value[4], rows[4]);
  assert.deepEqual(rows, original);
  assert.deepEqual(u.moveFollowBlock(moved.value, 2, 1).value, rows);
});

test('move rejects header boundaries, malformed or tied orders, and unsupported selections atomically', () => {
  const u = model();
  for (const header of ['homeComb', 'headerSerch', 'tabNav']) {
    const rows = [{ name: header, timestamp: 0 }, u.newFollowBlock(1)], original = clone(rows);
    assert.throws(() => u.moveFollowBlock(rows, 1, -1), /不能越过/);
    assert.deepEqual(rows, original);
  }
  for (const raw of ['bad', 1]) {
    const rows = [u.newFollowBlock(1), { name: 'titles', timestamp: raw }], original = clone(rows);
    assert.throws(() => u.moveFollowBlock(rows, 0, 1), /相同或异常/);
    assert.deepEqual(rows, original);
  }
  assert.throws(() => u.moveFollowBlock([u.newFollowBlock(1)], 0, 0), /移动方向/);
  assert.throws(() => u.moveFollowBlock([{ name: 'unknown' }], 0, 1), /未选择/);
  assert.throws(() => u.moveFollowBlock([u.newFollowBlock(1)], 0, -1), /不能越过/);
});

test('delete removes only the selected duplicate and retains every other imported field', () => {
  const u = model(), rows = [{ name: 'follow', timestamp: 3, imported: [] }, { name: 'unknown', value: false }, { name: 'follow', timestamp: 2, titleConfig: null }], original = clone(rows);
  const removed = u.removeFollowBlock(rows, 0);
  assert.deepEqual(removed, { value: rows.slice(1), selected: 1 });
  assert.deepEqual(rows, original);
  assert.equal(u.removeFollowBlock(removed.value, 1).selected, -1);
  assert.throws(() => u.removeFollowBlock(rows, 1), /未选择/);
});

test('explicit per-field editing retains hidden branches, metadata and historical number spellings', () => {
  const u = model(), row = { name: 'follow', timestamp: '2e0', titleConfig: { value: '旧标题', max: 10, unknown: [] }, positionConfig: { tabVal: '01', extra: true }, prConfig: { val: ' 9e0 ' }, fillet: { type: true, val: '101', valList: [{ val: 2 }, { val: 3 }, { val: 4 }, { val: 5 }] }, unknown: { zero: 0 } };
  const expected = clone(row);
  u.followSet(row, ['titleConfig', 'value'], '新标题');
  expected.titleConfig.value = '新标题';
  assert.deepEqual(row, expected);
  assert.equal(u.followRead(row, ['prConfig', 'val']), ' 9e0 ');
  assert.throws(() => u.followSet({ name: 'follow', titleConfig: null }, ['titleConfig', 'value'], 'x'), /结构异常/);
  for (const bad of [['__proto__', 'value'], ['fillet', 'constructor'], ['fillet', -1]]) assert.throws(() => u.followSet(row, bad, 'x'), /字段路径/);
});

test('save canonicalization touches exactly the two named follow image slots', () => {
  const u = model(), rows = [{ name: 'follow', imgConfig: { url: ticket(7), unknown: ticket(8) }, codeConfig: { url: ticket(9) }, linkConfig: { value: ticket(10) }, preview: { url: ticket(11) }, extra: [] }, { name: 'other', imgConfig: { url: ticket(12) } }, { name: 'follow', imgConfig: [], codeConfig: { url: 7 } }], original = clone(rows);
  const saved = JSON.parse(u.canonicalFollowValue(JSON.stringify(rows)));
  assert.equal(saved[0].imgConfig.url, '/api/assets/7');
  assert.equal(saved[0].codeConfig.url, '/api/assets/9');
  for (const key of ['linkConfig', 'preview', 'extra']) assert.deepEqual(saved[0][key], rows[0][key]);
  assert.equal(saved[0].imgConfig.unknown, rows[0].imgConfig.unknown);
  assert.deepEqual(saved.slice(1), rows.slice(1));
  assert.deepEqual(rows, original);
  assert.equal(u.canonicalFollowValue('{"legacy":true}'), '{"legacy":true}');
  assert.throws(() => u.canonicalFollowValue('null'), /不能为 null/);
});

test('preview capabilities must be current and match the exact stored image identity without changing stored values', () => {
  const u = model(), row = { name: 'follow', imgConfig: { url: '/api/assets/7' }, codeConfig: { url: '/api/assets/9' }, extra: { url: ticket(12) } }, original = clone(row);
  const preview = u.followPreviewBlock(row, { '/api/assets/7': ticket(7), '/api/assets/9': ticket(8) });
  assert.equal(preview.imgConfig.url, ticket(7));
  assert.equal(preview.codeConfig.url, '');
  assert.deepEqual(preview.extra, row.extra);
  assert.deepEqual(row, original);
  assert.equal(u.followPreviewBlock(row, { '/api/assets/7': ticket(7, 1) }).imgConfig.url, '');
  assert.equal(u.followPreviewBlock({ name: 'follow', imgConfig: { url: '/static/avatar.png' }, codeConfig: { url: 'https://example.com/qr.png' } }, {}).imgConfig.url, '/static/avatar.png');
  assert.equal(u.followPreviewBlock({ name: 'other', imgConfig: { url: '/api/assets/7' } }, {}).imgConfig.url, '/api/assets/7');
});

test('explicit image editing canonicalizes tickets and rejects unsafe URL syntax', () => {
  const u = model();
  assert.equal(u.canonicalFollowImage(` ${ticket(7)} `), '/api/assets/7');
  assert.equal(u.canonicalFollowImage('/static/images/follow.png'), '/static/images/follow.png');
  assert.equal(u.canonicalFollowImage('https://example.com/follow.png'), 'https://example.com/follow.png');
  assert.equal(u.canonicalFollowImage(''), '');
  for (const raw of ['javascript:alert(1)', 'data:image/png;base64,AA', '//example.com/qr.png', 'http://example.com/qr.png', '/static/a b.png', '/static/a\\b.png', '/static/\u0000.png', `/${'a'.repeat(4096)}`]) assert.throws(() => u.canonicalFollowImage(raw));
});

test('document admission rejects unsafe structures and excessive depth without clipping imported arrays', () => {
  const u = model();
  assert.throws(() => u.followDocument('{}'), /JSON 数组/);
  assert.throws(() => u.followDocument('[{"name":"follow","__proto__":{}}]'), /不安全字段/);
  let nested = {};
  for (let i = 0; i < 66; i++) nested = { keep: nested };
  assert.throws(() => u.followDocument(JSON.stringify([{ name: 'follow', extra: nested }])), /64 层/);
  const rows = Array.from({ length: 251 }, (_, index) => ({ name: 'follow', timestamp: index, extra: [false, 0, ''] }));
  assert.equal(u.followDocument(JSON.stringify(rows)).length, rows.length);
});
