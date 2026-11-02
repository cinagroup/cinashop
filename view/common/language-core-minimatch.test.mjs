// Run through the existing PC/Kefu toolchain gate from the project directory.
// Resolve each package from its real consumer; no Uni node_modules or cache is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve('.'), modules = join(projectRoot, 'node_modules');
const require = createRequire(join(projectRoot, 'package.json'));
const project = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8'));
assert.ok(['cinashop-pc', 'cinashop-kefu-ts'].includes(project.name), 'use the PC or Kefu consumer directory');
const coreManifestPath = require.resolve('@vue/language-core/package.json');
const core = createRequire(coreManifestPath);
const reviewed = {
  minimatch: { version: '11.0.1', integrity: 'sha512-t+Vn6DX4wPCxS23y03C0uhF7S1jpi1GfqPrnlEipCJaA2ykiNbMkVlDutZtmvLfRcUN6R8AYVlzTsQrT4RZoLQ==' },
  'brace-expansion': { version: '5.0.12', integrity: 'sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==' },
  'balanced-match': { version: '4.0.4', integrity: 'sha512-BLrgEcRTwX2o6gGxGOCNyMvGSp35YofuYzw9h1IMTRmKqttAZZVU67bdb9Pr2vUHA8+j3i2tJfjO6C6+4myGTA==' },
  '@isaacs/nonrecursive-glob-match': { version: '1.0.3', integrity: 'sha512-SI7kyKHq4XXDRozw+r9GlRZkia1ZkFrpLW98r2IC2Bpr8YkFGE3fvjzmxCG0x78A++69HmDNrDvSMYBZmHGpKA==' },
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const confined = path => {
  const inside = relative(modules, path);
  assert.ok(inside && inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside), 'resolve inside this consumer node_modules');
  return path;
};
function packageFrom(from, name) {
  const entry = confined(from.resolve(name));
  for (let dir = dirname(entry); dir !== modules; dir = dirname(dir)) {
    confined(dir);
    let metadata;
    try { metadata = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (metadata.name === name) return { entry, dir, metadata, from: createRequire(join(dir, 'package.json')) };
  }
  throw Error('Actual installed package metadata missing: ' + name);
}
function assertReviewedPackage(pkg, name) {
  const key = relative(projectRoot, pkg.dir).split(sep).join('/');
  const entry = lock.packages[key], expected = reviewed[name];
  assert.ok(entry, 'actual installed package must have its own lock record: ' + key);
  assert.equal(pkg.metadata.name, name);
  assert.equal(pkg.metadata.version, expected.version, name + ' actual installed version');
  assert.equal(entry.version, expected.version, key);
  assert.equal(entry.integrity, expected.integrity, key);
  const shortName = name.split('/').at(-1);
  assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${shortName}-${expected.version}.tgz`, key);
}
function verifyOfficialMinimatch(dir) {
  // Reuse the committed full official archive receipt, not an ignored task cache.
  const bytes = readFileSync(new URL('../uniapp-ts/vendor/minimatch-official-source-20261101.json', import.meta.url));
  assert.equal(sha256(bytes), '8e6462b8c95ffc933ecce62e0755870e4d61e06006ee5bc8bc882132b71bb5ec');
  const receipt = JSON.parse(bytes), official = receipt.packages['11.0.1'];
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(official.name, 'minimatch');
  assert.equal(official.version, reviewed.minimatch.version);
  assert.equal(official.integrity, reviewed.minimatch.integrity);
  assert.equal(official.tarball, 'https://registry.npmjs.org/minimatch/-/minimatch-11.0.1.tgz');
  assert.equal(official.archiveSha256, '8e6e370e8cc4d4d0d9e6b041f5ef888dbd9a15b5bdb1957794fe8eef6d60ac62');
  assert.equal(official.files.length, 37);
  const found = [];
  function walk(current, prefix = '') {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      if (!prefix && item.name === 'node_modules') continue;
      const name = prefix ? prefix + '/' + item.name : item.name;
      assert.equal(item.isSymbolicLink(), false, name);
      if (item.isDirectory()) walk(join(current, item.name), name);
      else { assert.equal(item.isFile(), true, name); found.push(name); }
    }
  }
  walk(dir);
  assert.deepEqual(found.sort(), official.files.map(file => file.path).sort(), 'complete official minimatch source file set');
  for (const file of official.files) {
    assert.match(file.path, /^[a-zA-Z0-9_./-]+$/);
    assert.equal(file.path.split('/').includes('..'), false);
    const actual = readFileSync(join(dir, file.path));
    assert.equal(actual.length, file.size, file.path);
    assert.equal(sha256(actual), file.sha256, file.path);
  }
}

test('actual language-core resolves the exact official minimatch11 source and reviewed dependency closure', () => {
  assert.equal(project.overrides.minimatch, undefined, 'retain the consumer-scoped major override');
  assert.equal(project.overrides['@vue/language-core'].minimatch, '11.0.1');
  assert.equal(JSON.parse(readFileSync(coreManifestPath, 'utf8')).version, '2.2.12');
  assert.equal(JSON.parse(readFileSync(coreManifestPath, 'utf8')).dependencies.minimatch, '^9.0.3', 'do not rewrite the original consumer package');
  assert.equal(lock.packages['node_modules/@vue/language-core'].version, '2.2.12');
  assert.equal(lock.packages['node_modules/vue-tsc'].version, '2.2.12');
  const minimatch = packageFrom(core, 'minimatch');
  const brace = packageFrom(minimatch.from, 'brace-expansion');
  const balanced = packageFrom(brace.from, 'balanced-match');
  const nonrecursive = packageFrom(minimatch.from, '@isaacs/nonrecursive-glob-match');
  for (const [name, pkg] of [['minimatch', minimatch], ['brace-expansion', brace], ['balanced-match', balanced], ['@isaacs/nonrecursive-glob-match', nonrecursive]]) assertReviewedPackage(pkg, name);
  assert.deepEqual(minimatch.metadata.dependencies, { '@isaacs/nonrecursive-glob-match': '^1.0.1', 'brace-expansion': '^5.0.12' });
  assert.deepEqual(brace.metadata.dependencies, { 'balanced-match': '^4.0.2' });
  const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith('node_modules/minimatch'));
  assert.ok(copies.length > 0);
  for (const [path, entry] of copies) {
    assert.equal(entry.version, reviewed.minimatch.version, path + ' must not retain the old vulnerable copy');
    assert.equal(entry.integrity, reviewed.minimatch.integrity, path);
    assert.equal(entry.resolved, 'https://registry.npmjs.org/minimatch/-/minimatch-11.0.1.tgz', path);
  }
  assert.equal(typeof core('minimatch').minimatch, 'function');
  verifyOfficialMinimatch(minimatch.dir);
});

test('actual language-core property generation preserves matching and unfiltered named-ABI behavior', () => {
  const CompilerDOM = core('@vue/compiler-dom');
  const { generateElementProps } = core('./lib/codegen/template/elementProps.js');
  const { createTemplateCodegenContext } = core('./lib/codegen/template/context.js');
  const { getDefaultCompilerOptions } = core('./lib/utils/ts.js');
  const { toString } = core('muggle-string');
  const generate = (dataAttributes, htmlAttributes) => {
    const node = CompilerDOM.parse('<Widget data-audit="hidden" keep-kebab="kept" aria-label="aria" />').children[0];
    assert.equal(node.tagType, CompilerDOM.ElementTypes.COMPONENT);
    const options = { edited: false, scriptSetupBindingNames: new Set(),
      vueCompilerOptions: { ...getDefaultCompilerOptions(), dataAttributes, htmlAttributes } };
    const ctx = createTemplateCodegenContext(options);
    return toString([...generateElementProps(options, ctx, node, node.props, true, true, [])]);
  };
  const named = core('minimatch'), original = named.minimatch, calls = [];
  try {
    named.minimatch = (...args) => { calls.push(args.slice(0, 2)); return original(...args); };
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
  } finally { named.minimatch = original; }
});

test('actual consumer minimatch CJS and ESM bound optimizer expansion and retain ordinary matching', async () => {
  const actual = packageFrom(core, 'minimatch');
  const cjs = core('minimatch');
  const esm = await import(pathToFileURL(join(actual.dir, 'dist/esm/index.js')).href);
  for (const named of [cjs, esm]) {
    assert.equal(typeof named.minimatch, 'function');
    const pattern = Array(8).fill('**/../a/b').join('/');
    for (const cap of [32, 64]) assert.equal(new named.Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: cap }).set.length, cap);
    const ordinary = new named.Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2, braceExpandMax: 32 });
    assert.equal(ordinary.set.length, 4);
    assert.equal(ordinary.match('../a/b/../c/d'), true);
    assert.equal(ordinary.match('x/a/b/y/c/d'), true);
    assert.equal(named.minimatch('src/widget.vue', 'src/**/*.vue'), true);
    assert.equal(named.minimatch('src/widget.ts', 'src/**/*.vue'), false);
  }
});
