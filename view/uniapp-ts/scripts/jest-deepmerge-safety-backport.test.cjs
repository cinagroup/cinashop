'use strict';
// Finite source/installed-consumer regressions. No Jest test runner, build or service.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module'), assert = require('node:assert/strict'), { test } = require('node:test');
const B = require('./build-jest-deepmerge-safety-backport.cjs');
const H = require('./security-consumer-test-helpers.cjs'); H.denyNetwork();
const archive = fs.readFileSync(path.join(H.project, 'vendor/jest-config-27.5.1-deepmerge-safety-backport.tgz'));
const fixedEntries = B.readArchive(archive), originalEntries = B.reverseDerived(archive);
const fixedHelper = fixedEntries.find(e => e.name === B.CONTRACT.helper.file).bytes;
const originalCore = B.verifyHelper(fixedHelper);
function compileCore(bytes, filename) { const m = new Module(filename, module); m.filename = filename; m.paths = []; m._compile(bytes.toString('utf8'), filename); return m.exports; }
const originalMerge = compileCore(originalCore, path.join(__dirname, 'verified-official-deepmerge.cjs'));
const candidateDir = H.packageDir(H.from('@jest/core').resolve('jest-config'));
H.verifyInstalled(candidateDir, fixedEntries);
for (const owner of ['@jest/core', 'jest-cli']) assert.equal(H.packageDir(H.from(owner).resolve('jest-config')), candidateDir, 'real ' + owner + ' consumer selects retained source fork');
const lock = JSON.parse(fs.readFileSync(path.join(H.installRoot, 'package-lock.json')));
assert.ok(!Object.keys(lock.packages).some(k => /(^|\/)node_modules\/deepmerge$/.test(k)), 'deepmerge node returned to lock');
assert.equal(lock.packages['node_modules/jest-config'].integrity, B.CONTRACT.derived.integrity);
const patchedMerge = require(path.join(candidateDir, B.CONTRACT.helper.file));
const attacks = [
  ['null-prototype target', () => [Object.assign(Object.create(null), { debug: false }), JSON.parse('{"__proto__":{"isAdmin":true},"verbose":true}')], x => x],
  ['null placeholder', () => [{ session: null }, JSON.parse('{"session":{"__proto__":{"isAdmin":true},"active":true}}')], x => x.session],
  ['primitive placeholder', () => [{ session: 0 }, JSON.parse('{"session":{"__proto__":{"isAdmin":true},"active":true}}')], x => x.session],
  ['own proto on target', () => [JSON.parse('{"__proto__":{"isAdmin":true},"debug":false}'), { verbose: true }], x => x],
];
test('official deepmerge core reproduces returned-object poisoning; actual installed local helper blocks both copies', () => {
  const keys = Reflect.ownKeys(Object.prototype);
  for (const [name, args, pick] of attacks) {
    const before = pick(originalMerge(...args())), after = pick(patchedMerge(...args()));
    assert.equal(before.isAdmin, true, name); assert.equal(Object.hasOwn(before, 'isAdmin'), false);
    assert.equal(after.isAdmin, undefined, name); assert.equal(Object.getPrototypeOf(after), Object.prototype);
    assert.equal(Object.hasOwn(after, '__proto__'), false); assert.equal(JSON.stringify(after), JSON.stringify(before));
  }
  assert.equal(({}).isAdmin, undefined); assert.deepEqual(Reflect.ownKeys(Object.prototype), keys);
});
test('unchanged merge options, lists, symbols, ordinary constructor/prototype data and caller identity', () => {
  const controls = [
    m => m({ nested: { a: 1 }, list: [1] }, { nested: { b: 2 }, list: [2] }),
    m => m({ list: [1] }, { list: [2] }, { arrayMerge: (_a, b) => b }),
    m => m({ item: { a: 1 } }, { item: { b: 2 } }, { customMerge: key => key === 'item' ? (a, b) => ({ a, b }) : undefined }),
    m => m.all([{ a: 1 }, { b: 2 }]),
    m => m(Object.create(null), JSON.parse('{"constructor":{"prototype":{"ordinary":true}},"prototype":{"ordinary":2}}')),
  ];
  for (const control of controls) assert.deepEqual(control(patchedMerge), control(originalMerge));
  for (const merge of [originalMerge, patchedMerge]) {
    const nested = { a: 1 }, symbol = Symbol('ordinary'), date = new Date(123), re = /x/i;
    const input = Object.freeze({ nested, date, re, [symbol]: { b: 2 } });
    assert.equal(merge({}, input, { clone: false }).nested, nested);
    const out = merge({}, input); assert.notEqual(out.nested, nested); assert.equal(out.date, date); assert.equal(out.re, re); assert.deepEqual(out[symbol], { b: 2 });
    assert.deepEqual(input.nested, { a: 1 }); assert.throws(() => merge.all('invalid'), /first argument should be an array/);
  }
});
test('real installed Jest normalize:6 poison cases,3 full ordinary options and18 raw derived names', async () => {
  const temp = H.temp('jest-normalize-security'), originalDir = path.join(temp, 'official-jest');
  H.writePackage(originalDir, originalEntries); fs.symlinkSync(H.modules, path.join(originalDir, 'node_modules'), 'dir');
  const savedLoad = Module._load, loads = [], globalKeys = Reflect.ownKeys(Object.prototype); let side = 'load';
  Module._load = function(request, parent, ...rest) {
    if (request === 'deepmerge' || request === './deepmerge-safety.cjs') {
      loads.push({ side, request, parent: parent.filename });
      if (request === 'deepmerge') { assert.ok(H.under(originalDir, parent.filename), 'external deepmerge requested outside official control'); return originalMerge; }
    }
    return savedLoad.call(this, request, parent, ...rest);
  };
  try {
    const original = require(path.join(originalDir, 'build/normalize.js')).default;
    const candidate = require(path.join(candidateDir, 'build/normalize.js')).default;
    const names = [];
    async function normalize(fn, label, n, preset, globals) {
      side = label; const folder = path.join(temp, label + '-' + n), configPath = path.join(folder, 'jest.config.cjs');
      fs.mkdirSync(path.join(folder, 'preset'), { recursive: true }); fs.symlinkSync(H.modules, path.join(folder, 'node_modules'), 'dir');
      fs.writeFileSync(path.join(folder, 'preset/jest-preset.js'), 'module.exports={globals:' + preset + '};\n', { flag: 'wx' });
      const result = await fn({ rootDir: folder, preset: './preset/jest-preset.js', globals, transform: {} }, { _: [], $0: 'security-regression', runInBand: true }, configPath);
      const expected = crypto.createHash('md5').update(folder).update(configPath).update(String(Infinity)).digest('hex');
      assert.equal(result.options.name, expected); names.push({ label, folder, configPath, projectIndex: 'Infinity', actual: result.options.name, expected });
      return { folder, options: result.options };
    }
    const json = JSON.parse, cases = [
      ['Object.assign(Object.create(null),{safe:1})', () => json('{"__proto__":{"isAdmin":true},"ordinary":2}'), x => x],
      ['JSON.parse(\'{"__proto__":{"isAdmin":true},"safe":1}\')', () => ({ ordinary: 2 }), x => x],
      ['({session:null,safe:1})', () => json('{"session":{"__proto__":{"isAdmin":true},"ordinary":2}}'), x => x.session],
      ['({session:undefined,safe:1})', () => json('{"session":{"__proto__":{"isAdmin":true},"ordinary":2}}'), x => x.session],
      ['({session:0,safe:1})', () => json('{"session":{"__proto__":{"isAdmin":true},"ordinary":2}}'), x => x.session],
      ['({session:JSON.parse(\'{"__proto__":{"isAdmin":true},"safe":1}\')})', () => ({ session: { ordinary: 2 } }), x => x.session],
    ];
    let n = 0;
    for (const [preset, make, pick] of cases) {
      const a = await normalize(original, 'official', n, preset, make()), b = await normalize(candidate, 'candidate', n++, preset, make());
      const before = pick(a.options.globals), after = pick(b.options.globals);
      assert.equal(before.isAdmin, true, 'official normalize must exercise the original bug');
      assert.equal(after.isAdmin, undefined); assert.equal(Object.getPrototypeOf(after), Object.prototype); assert.equal(Object.hasOwn(after, '__proto__'), false);
      assert.equal(JSON.stringify(b.options.globals), JSON.stringify(a.options.globals), 'legitimate enumerable globals preserved');
    }
    function canonical(v, folder) {
      if (typeof v === 'string') {
        if (v === folder || v.startsWith(folder + path.sep)) return '<fixture>/' + path.relative(folder, v).split(path.sep).join('/');
        if (v.startsWith(H.installRoot + path.sep)) return '<install>/' + path.relative(H.installRoot, v).split(path.sep).join('/');
        return v;
      }
      if (Array.isArray(v)) return v.map(x => canonical(x, folder));
      return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canonical(x, folder)])) : v;
    }
    for (const [preset, make] of [
      ['({nested:{fixed:1,override:"preset"},list:["preset"]})', () => ({ nested: { override: 'project', fresh: 2 }, list: ['project'] })],
      ['Object.create(null)', () => json('{"constructor":{"prototype":{"ordinary":true}},"prototype":{"ordinary":2}}')],
      ['({tree:Object.assign(Object.create(null),{x:1})})', () => ({ tree: { y: 2 } })],
    ]) {
      const a = await normalize(original, 'official', n, preset, make()), b = await normalize(candidate, 'candidate', n++, preset, make());
      for (const key of ['runner', 'testEnvironment', 'testRunner', 'testSequencer']) {
        assert.equal(H.confined(a.options[key]), H.confined(b.options[key]), 'actual module path stable: ' + key);
        assert.ok(fs.readFileSync(a.options[key]).equals(fs.readFileSync(b.options[key])));
      }
      assert.deepEqual(canonical({ ...b.options, name: '<verified fixture-derived name>' }, b.folder), canonical({ ...a.options, name: '<verified fixture-derived name>' }, a.folder));
    }
    assert.equal(n, 9); assert.equal(names.length, 18);
    assert.ok(loads.some(x => x.side === 'candidate' && x.request === './deepmerge-safety.cjs'));
    assert.ok(loads.some(x => x.side === 'official' && x.request === 'deepmerge'));
    assert.ok(loads.filter(x => x.request === 'deepmerge').every(x => H.under(originalDir, x.parent)));
    assert.deepEqual(Reflect.ownKeys(Object.prototype), globalKeys); assert.equal(({}).isAdmin, undefined);
  } finally { Module._load = savedLoad; fs.rmSync(temp, { recursive: true, force: true }); }
});
