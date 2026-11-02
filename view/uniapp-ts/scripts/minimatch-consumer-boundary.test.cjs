'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const H = require('./security-consumer-test-helpers.cjs');

// These are finite source/consumer checks. No registry, listener or provider is
// needed to establish either dependency API boundary.
H.denyNetwork();

const receiptPath = path.join(__dirname, '../vendor/minimatch-official-source-20261101.json');
const receiptBytes = fs.readFileSync(receiptPath);
const receipt = JSON.parse(receiptBytes);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const lock = JSON.parse(fs.readFileSync(path.join(H.installRoot, 'package-lock.json'), 'utf8'));
const projectPackage = JSON.parse(fs.readFileSync(path.join(H.installRoot, 'package.json'), 'utf8'));
const expected = {
  '3.1.5': {
    files: 4,
    integrity: 'sha512-VgjWUsnnT6n+NUk6eZq77zeFdpW2LWDzP6zFGrCbHXiYNul5Dzqk2HHQ5uFH2DNW5Xbp8+jVzaeNt94ssEEl4w==',
    archiveSha256: 'd81817ecf72de3c8c5d3724407752d943c9e1a42af5c437d9cb923be8a72c648',
  },
  '11.0.1': {
    files: 37,
    integrity: 'sha512-t+Vn6DX4wPCxS23y03C0uhF7S1jpi1GfqPrnlEipCJaA2ykiNbMkVlDutZtmvLfRcUN6R8AYVlzTsQrT4RZoLQ==',
    archiveSha256: '8e6e370e8cc4d4d0d9e6b041f5ef888dbd9a15b5bdb1957794fe8eef6d60ac62',
  },
};

function packageDirectory(entry, name) {
  let dir = path.dirname(H.confined(entry));
  while (H.under(H.modules, dir)) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest)).name === name) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Actual installed package metadata missing: ' + name);
}

function minimatchFrom(requireFrom) {
  const entry = requireFrom.resolve('minimatch');
  const dir = packageDirectory(entry, 'minimatch');
  return { entry, dir, requireFrom: createRequire(path.join(dir, 'package.json')),
    manifest: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))) };
}

function modernConsumers() {
  return [
    ...['@dcloudio/uni-cli-shared', '@dcloudio/vite-plugin-uni'].map(owner => {
      const pluginEntry = H.from(owner).resolve('unplugin-auto-import/vite');
      const pluginDir = packageDirectory(pluginEntry, 'unplugin-auto-import');
      const requireFrom = createRequire(path.join(pluginDir, 'package.json'));
      return { label: owner + ' / unplugin-auto-import', pluginDir, pluginEntry, requireFrom,
        minimatch: minimatchFrom(requireFrom) };
    }),
    { label: '@vue/language-core', requireFrom: H.from('@vue/language-core'),
      minimatch: minimatchFrom(H.from('@vue/language-core')) },
  ];
}

function verifyOfficialInstalled(dir, version) {
  const contract = receipt.packages[version];
  const found = [];
  const walk = (current, prefix = '') => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      // Dependencies are independently installed packages, not source archive files.
      if (!prefix && item.name === 'node_modules') continue;
      const relative = prefix ? prefix + '/' + item.name : item.name;
      const filename = path.join(current, item.name);
      assert.equal(item.isSymbolicLink(), false, relative + ' must be a physical source file');
      if (item.isDirectory()) walk(filename, relative);
      else {
        assert.equal(item.isFile(), true, relative);
        found.push(relative);
      }
    }
  };
  walk(dir);
  assert.deepEqual(found.sort(), contract.files.map(file => file.path).sort(), 'complete official package file set');
  const mask = process.env.CINASHOP_SECURITY_INSTALL_UMASK;
  assert.ok(mask === undefined || /^[0-7]{1,3}$/.test(mask));
  const installMask = mask === undefined ? process.umask() : Number.parseInt(mask, 8);
  for (const file of contract.files) {
    assert.match(file.path, /^[a-zA-Z0-9_./-]+$/);
    assert.equal(file.path.split('/').includes('..'), false);
    const filename = path.join(dir, file.path);
    const bytes = fs.readFileSync(filename);
    assert.equal(bytes.length, file.size, file.path);
    assert.equal(sha256(bytes), file.sha256, file.path);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(filename).mode & 0o777, file.mode & ~installMask, file.path + ' official file mode');
    }
  }
  const key = path.relative(H.installRoot, dir).replaceAll(path.sep, '/');
  const locked = lock.packages[key];
  assert.ok(locked, 'installed source must be represented in the actual lock: ' + key);
  assert.equal(locked.version, version, key);
  assert.equal(locked.integrity, expected[version].integrity, key);
  // Keep the historical root lock location while proving all four installed
  // files and its SRI equal the separately captured official source archive.
  assert.equal(locked.resolved, version === '3.1.5'
    ? 'https://registry.npmmirror.com/minimatch/-/minimatch-3.1.5.tgz'
    : contract.tarball, key);
}

test('official minimatch receipts retain the complete reviewed 3.x and 11.x source identities', () => {
  assert.equal(sha256(receiptBytes), '8e6462b8c95ffc933ecce62e0755870e4d61e06006ee5bc8bc882132b71bb5ec');
  assert.equal(receipt.schemaVersion, 1);
  assert.deepEqual(Object.keys(receipt.packages).sort(), ['11.0.1', '3.1.5']);
  for (const [version, pinned] of Object.entries(expected)) {
    const item = receipt.packages[version];
    assert.equal(item.name, 'minimatch');
    assert.equal(item.version, version);
    assert.equal(item.tarball, `https://registry.npmjs.org/minimatch/-/minimatch-${version}.tgz`);
    assert.equal(item.integrity, pinned.integrity);
    assert.equal(item.archiveSha256, pinned.archiveSha256);
    assert.equal(item.files.length, pinned.files);
    assert.equal(new Set(item.files.map(file => file.path)).size, pinned.files);
  }
});

test('only named-API consumers move to official 11.x while Glob and TestExclude retain callable 3.x', () => {
  assert.equal(projectPackage.overrides.minimatch, undefined, 'a global major override breaks callable consumers');
  assert.equal(projectPackage.overrides['unplugin-auto-import'].minimatch, '11.0.1');
  assert.equal(projectPackage.overrides['@vue/language-core'].minimatch, '11.0.1');
  const verified = new Set();
  for (const consumer of modernConsumers()) {
    assert.equal(consumer.minimatch.manifest.version, '11.0.1', consumer.label);
    assert.notEqual(consumer.minimatch.dir, path.join(H.modules, 'minimatch'), consumer.label);
    assert.equal(typeof consumer.requireFrom('minimatch').minimatch, 'function', consumer.label);
    assert.deepEqual(consumer.minimatch.manifest.engines, { node: '18 || 20 || >=22' });
    assert.deepEqual(consumer.minimatch.manifest.dependencies,
      { 'brace-expansion': '^5.0.12', '@isaacs/nonrecursive-glob-match': '^1.0.1' });
    if (!verified.has(consumer.minimatch.dir)) {
      verifyOfficialInstalled(consumer.minimatch.dir, '11.0.1');
      verified.add(consumer.minimatch.dir);
    }
  }
  for (const owner of ['glob', 'test-exclude']) {
    const from = H.from(owner), actual = minimatchFrom(from);
    assert.equal(actual.dir, path.join(H.modules, 'minimatch'), owner);
    assert.equal(actual.manifest.version, '3.1.5', owner);
    assert.equal(typeof from('minimatch'), 'function', owner);
    assert.deepEqual(actual.manifest.dependencies, { 'brace-expansion': '^1.1.7' });
    verifyOfficialInstalled(actual.dir, '3.1.5');
  }
  const minimatchNodes = Object.entries(lock.packages).filter(([name]) => name.endsWith('/minimatch'));
  assert.deepEqual(minimatchNodes.map(([name]) => name).sort(), [
    'node_modules/@dcloudio/uni-cli-shared/node_modules/minimatch',
    'node_modules/@dcloudio/vite-plugin-uni/node_modules/minimatch',
    'node_modules/@vue/language-core/node_modules/minimatch',
    'node_modules/minimatch',
  ]);
  for (const [name, item] of minimatchNodes) {
    assert.ok(Object.hasOwn(expected, item.version), name + ' unexpected minimatch family');
    assert.equal(item.integrity, expected[item.version].integrity, name);
  }
});

test('unchanged four-file minimatch3 source lacks the advisory optimization mechanism', () => {
  const legacy = H.from('glob')('minimatch');
  const source = fs.readFileSync(path.join(H.modules, 'minimatch/minimatch.js'), 'utf8');
  for (const marker of ['firstPhasePreProcess', 'secondPhasePreProcess', 'optimizationLevel', 'braceExpandMax']) {
    assert.equal(source.includes(marker), false, marker + ' is absent from exact official3 source');
    assert.equal(legacy.Minimatch.prototype[marker], undefined, marker);
  }
  assert.equal(typeof legacy, 'function');
  assert.equal(typeof legacy.Minimatch, 'function');
  assert.equal(legacy.GLOBSTAR, legacy.Minimatch.GLOBSTAR);
  const finitePattern = Array(32).fill('**/../a/b').join('/');
  assert.equal(new legacy.Minimatch(finitePattern, { optimizationLevel: 2 }).set.length, 1);
  assert.equal(legacy('src/a.js', 'src/**/*.js'), true);
  assert.equal(legacy('src/.a.js', 'src/**/*.js'), false);
});

test('actual Glob7 and TestExclude6 retain sync, async, ignore, dot and callable matching behavior', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cinashop-minimatch-legacy-'));
  try {
    for (const name of ['src/a.js', 'src/nested/b.js', 'src/.hidden.js', 'src/a.txt', 'node_modules/pkg/dep.js']) {
      const file = path.join(fixture, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'export const fixture = true;\n');
    }
    const glob = H.from('glob')('./glob.js');
    const options = { cwd: fixture, nodir: true };
    assert.deepEqual(glob.sync('src/**/*.js', options).sort(), ['src/a.js', 'src/nested/b.js']);
    assert.deepEqual(await new Promise((resolve, reject) => glob('src/**/*.js', options,
      (error, result) => error ? reject(error) : resolve(result.sort()))), ['src/a.js', 'src/nested/b.js']);
    assert.deepEqual(glob.sync('src/**/*.js', { ...options, ignore: ['src/nested/**'], dot: true }).sort(),
      ['src/.hidden.js', 'src/a.js']);
    assert.deepEqual(glob.sync('missing-*.js', { ...options, nonull: true }), ['missing-*.js']);
    assert.equal(glob.hasMagic('src/**/*.js'), true);
    assert.equal(glob.hasMagic('src/a.js'), false);
    const TestExclude = H.from('test-exclude')('./index.js');
    const exclude = new TestExclude({ cwd: fixture, include: ['src/**/*.js'],
      exclude: ['src/nested/**'], excludeNodeModules: true });
    assert.equal(exclude.shouldInstrument(path.join(fixture, 'src/a.js')), true);
    assert.equal(exclude.shouldInstrument(path.join(fixture, 'src/.hidden.js')), true);
    assert.equal(exclude.shouldInstrument(path.join(fixture, 'src/nested/b.js')), false);
    assert.equal(exclude.shouldInstrument(path.join(fixture, 'node_modules/pkg/dep.js')), false);
    assert.equal(exclude.shouldInstrument(path.join(path.dirname(fixture), 'outside.js')), false);
    assert.deepEqual(exclude.globSync().sort(), ['src/.hidden.js', 'src/a.js']);
    assert.deepEqual((await exclude.glob()).sort(), ['src/.hidden.js', 'src/a.js']);
    const negated = new TestExclude({ cwd: fixture, include: ['src/**/*.js'],
      exclude: ['src/**', '!src/nested/b.js'] });
    assert.equal(negated.shouldInstrument(path.join(fixture, 'src/nested/b.js')), true);
    assert.equal(negated.shouldInstrument(path.join(fixture, 'src/a.js')), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

for (const owner of ['@dcloudio/uni-cli-shared', '@dcloudio/vite-plugin-uni']) {
  for (const mode of ['require', 'import']) {
    test(`actual ${owner} auto-import ${mode} hot-update hook matches dirs and Windows slashes with minimatch11`, async () => {
      const consumer = modernConsumers().find(item => item.label.startsWith(owner + ' /'));
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cinashop-minimatch-unplugin-'));
      try {
        const importsDir = path.join(fixture, 'imports'), source = path.join(importsDir, 'helpers.ts');
        fs.mkdirSync(importsDir);
        fs.writeFileSync(source, 'export const phaseInitial = 1;\n');
        const factory = mode === 'require' ? consumer.requireFrom('unplugin-auto-import/vite')
          : (await import(pathToFileURL(path.join(consumer.pluginDir, 'dist/vite.js')).href)).default;
        const plugin = factory({ dts: false, imports: [], dirs: [importsDir], eslintrc: { enabled: false } });
        assert.equal(plugin.name, 'unplugin-auto-import');
        assert.equal(typeof plugin.handleHotUpdate, 'function');
        await plugin.buildStart();
        const transform = name => plugin.transform(`const value = ${name};`, path.join(fixture, 'entry.ts'));
        const initial = await transform('phaseInitial');
        assert.match(initial.code, /import\s*\{\s*phaseInitial\s*\}/);
        assert.match(initial.code, /imports\/helpers/);
        fs.writeFileSync(source, 'export const phaseAfterNegative = 2;\n');
        await plugin.handleHotUpdate({ file: path.join(fixture, 'other/outside.ts') });
        assert.equal(await transform('phaseAfterNegative'), undefined, 'outside dirs must not trigger a rescan');
        await plugin.handleHotUpdate({ file: source });
        assert.match((await transform('phaseAfterNegative')).code, /import\s*\{\s*phaseAfterNegative\s*\}/);
        fs.writeFileSync(source, 'export const phaseAfterWindows = 3;\n');
        await plugin.handleHotUpdate({ file: source.replaceAll('/', '\\') });
        assert.match((await transform('phaseAfterWindows')).code, /import\s*\{\s*phaseAfterWindows\s*\}/);
        await plugin.buildEnd();
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    });
  }
}

test('actual Vue language-core template property generation uses scoped minimatch11 named matching', () => {
  const from = H.from('@vue/language-core');
  const CompilerDOM = from('@vue/compiler-dom');
  const { generateElementProps } = from('./lib/codegen/template/elementProps.js');
  const { createTemplateCodegenContext } = from('./lib/codegen/template/context.js');
  const { getDefaultCompilerOptions } = from('./lib/utils/ts.js');
  const { toString } = from('muggle-string');
  const generate = (dataAttributes, htmlAttributes) => {
    const template = '<Widget data-audit="hidden" keep-kebab="kept" aria-label="aria" />';
    const node = CompilerDOM.parse(template).children[0];
    assert.equal(node.tagType, CompilerDOM.ElementTypes.COMPONENT);
    const options = { edited: false, scriptSetupBindingNames: new Set(),
      vueCompilerOptions: { ...getDefaultCompilerOptions(), dataAttributes, htmlAttributes } };
    const ctx = createTemplateCodegenContext(options);
    return toString([...generateElementProps(options, ctx, node, node.props, true, true, [])]);
  };
  const named = from('minimatch'), original = named.minimatch, calls = [];
  try {
    named.minimatch = (...args) => {
      calls.push(args.slice(0, 2));
      return original(...args);
    };
    const selected = generate(['data-*'], ['aria-*']);
    assert.doesNotMatch(selected, /dataAudit|data-audit/);
    assert.match(selected, /keepKebab/);
    assert.match(selected, /aria-label/);
    assert.doesNotMatch(selected, /ariaLabel/);
    assert.ok(calls.some(([name, pattern]) => name === 'data-audit' && pattern === 'data-*'));
    assert.ok(calls.some(([name, pattern]) => name === 'aria-label' && pattern === 'aria-*'));
    const unfiltered = generate([], []);
    assert.match(unfiltered, /dataAudit/);
    assert.match(unfiltered, /ariaLabel/);
  } finally {
    named.minimatch = original;
  }
});

test('published minimatch11 CJS and ESM APIs bound optimizer expansion with only 32/64 patterns', async () => {
  const consumer = modernConsumers()[0];
  const cjs = consumer.requireFrom('minimatch');
  const esm = await import(pathToFileURL(path.join(consumer.minimatch.dir, 'dist/esm/index.js')).href);
  for (const named of [cjs, esm]) {
    assert.equal(typeof named.minimatch, 'function');
    const pattern = Array(8).fill('**/../a/b').join('/');
    for (const cap of [32, 64]) {
      const instance = new named.Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: cap });
      assert.equal(instance.set.length, cap);
    }
    const ordinary = new named.Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2, braceExpandMax: 32 });
    assert.equal(ordinary.set.length, 4);
    assert.equal(ordinary.match('../a/b/../c/d'), true);
    assert.equal(ordinary.match('x/a/b/y/c/d'), true);
    assert.equal(named.minimatch('src/widget.vue', 'src/**/*.vue'), true);
    assert.equal(named.minimatch('src/widget.ts', 'src/**/*.vue'), false);
  }
});
