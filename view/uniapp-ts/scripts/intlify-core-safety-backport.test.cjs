'use strict';
// Real seven-distribution core consumers and DCloud's retained native ESM runtime.
// These finite controls do not replace DCloud build/browser/AST/HTML-sink validation.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module'), assert = require('node:assert/strict'), { pathToFileURL } = require('node:url'), { test } = require('node:test');
const B = require('./build-intlify-core-safety-backport.cjs');
const H = require('./security-consumer-test-helpers.cjs'); H.denyNetwork();
const raw = fs.readFileSync(path.join(H.project, 'vendor/intlify-core-base-9.1.9-mixed-escape-backport.tgz'));
const fixedEntries = B.readArchive(raw), originalEntries = B.reverseDerived(raw);
const fromDCloud = H.from('@dcloudio/uni-cli-shared'), coreEntry = H.confined(fromDCloud.resolve('@intlify/core-base'));
H.verifyInstalled(H.packageDir(coreEntry), fixedEntries);
const lock = JSON.parse(fs.readFileSync(path.join(H.installRoot, 'package-lock.json')));
assert.ok(!Object.keys(lock.packages).some(k => /(^|\/)node_modules\/vue-i18n$/.test(k)), 'removed unused root vue-i18n package returned');
assert.equal(lock.packages['node_modules/@intlify/core-base'].version, '9.1.9');
assert.equal(lock.packages['node_modules/@intlify/core-base'].integrity, B.CONTRACT.derived.integrity);
process.env.NODE_ENV = 'production';
Object.assign(globalThis, { __VUE_I18N_FULL_INSTALL__: true, __VUE_I18N_LEGACY_API__: true, __VUE_I18N_PROD_DEVTOOLS__: false, __INTLIFY_PROD_DEVTOOLS__: false });
function context(core, escape = true) {
  return core.createCoreContext({ locale: 'en', fallbackLocale: 'en', warnHtmlMessage: false, escapeParameter: escape, messageCompiler: core.compileToFunction,
    messages: { en: { mixed: '{0} / {name}', named: '{name}', plain: 'Hello', list: 'Count {0}', data: '{one} / {two}' } } });
}
async function loadDistribution(root, file) {
  const p = path.join(root, file);
  if (file.includes('.cjs.')) return require(p);
  if (file.includes('.global')) {
    const sandbox = { console: { warn() {}, error: console.error, log() {} }, process: { env: { NODE_ENV: 'production' } } };
    vm.createContext(sandbox); vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: p, timeout: 3000 }); return sandbox.IntlifyCoreBase;
  }
  const copy = path.join(root, path.basename(file) + '.mjs'), bytes = fs.readFileSync(p);
  fs.writeFileSync(copy, bytes, { flag: 'wx', mode: 0o600 }); assert.equal(B.sha256(fs.readFileSync(copy)), B.sha256(bytes));
  return import(pathToFileURL(copy).href);
}
test('all7 published distributions reproduce original mixed bypass and preserve finite translation controls after repair', async () => {
  const temp = H.temp('intlify-distributions');
  try {
    const source = path.join(temp, 'source'), candidate = path.join(temp, 'candidate');
    H.writePackage(source, originalEntries); H.writePackage(candidate, fixedEntries);
    for (const root of [source, candidate]) fs.symlinkSync(H.modules, path.join(root, 'node_modules'), 'dir');
    assert.equal(B.CONTRACT.patches.length, 7);
    for (const { file } of B.CONTRACT.patches) {
      const old = await loadDistribution(source, file), fixed = await loadDistribution(candidate, file), a = context(old), b = context(fixed);
      assert.equal(old.translate(a, 'mixed', ['<b>list</b>'], { named: { name: '<b>named</b>' } }), '&lt;b&gt;list&lt;/b&gt; / <b>named</b>', file + ' original bypass');
      const list = Object.freeze(['<b>list</b>']), named = Object.freeze({ name: '<b>named</b>' });
      assert.equal(fixed.translate(b, 'mixed', list, { named }), '&lt;b&gt;list&lt;/b&gt; / &lt;b&gt;named&lt;/b&gt;');
      assert.equal(fixed.translate(b, 'mixed', named, { list }), '&lt;b&gt;list&lt;/b&gt; / &lt;b&gt;named&lt;/b&gt;');
      assert.equal(list[0], '<b>list</b>'); assert.equal(named.name, '<b>named</b>');
      const caller = { name: '<b>x</b>' }, oldCaller = { name: '<b>x</b>' };
      assert.equal(old.translate(a, 'named', oldCaller), '&lt;b&gt;x&lt;/b&gt;'); assert.equal(oldCaller.name, '&lt;b&gt;x&lt;/b&gt;');
      assert.equal(fixed.translate(b, 'named', caller), '&lt;b&gt;x&lt;/b&gt;'); assert.equal(fixed.translate(b, 'named', caller), '&lt;b&gt;x&lt;/b&gt;'); assert.equal(caller.name, '<b>x</b>');
      for (const [key, ...args] of [['plain'], ['list', [3]], ['named', { name: 'Cina' }], ['mixed', ['a'], { named: { name: 'b' } }], ['mixed', { name: 'b' }, { list: ['a'] }], ['data', { one: 0, two: false }]]) assert.equal(fixed.translate(b, key, ...args), old.translate(a, key, ...args));
      assert.equal(fixed.translate(context(fixed, false), 'mixed', ['<b>a</b>'], { named: { name: '<b>b</b>' } }), old.translate(context(old, false), 'mixed', ['<b>a</b>'], { named: { name: '<b>b</b>' } }));
      assert.deepEqual(Object.keys(fixed).sort(), Object.keys(old).sort());
      for (const key of Object.keys(old)) assert.equal(typeof fixed[key], typeof old[key], file + ':' + key);
      assert.equal(a.version, '9.1.9'); assert.equal(b.version, a.version);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('actual DCloud private runtime preserves20 core symbols/compiler and normal behavior with repaired mixed escaping', async () => {
  const bindingRaw = fs.readFileSync(path.join(H.project, 'vendor/intlify-dcloud-runtime-source.json'));
  assert.equal(B.sha256(bindingRaw), '4d35346cc02214617a6f4bc7953fb397ea4a2e1106f87f51b7a23d810274dd80', 'pinned DCloud runtime binding');
  const binding = JSON.parse(bindingRaw), packageBytes = fs.readFileSync(H.confined(path.join(H.modules, binding.package_name, 'package.json')));
  assert.equal(B.sha256(packageBytes), binding.package_json_sha256);
  const node = lock.packages['node_modules/' + binding.package_name]; assert.deepEqual(node, binding.DCloud_locked_node);
  const runtimePath = H.confined(path.join(H.installRoot, binding.relative_path)), runtimeBytes = fs.readFileSync(runtimePath);
  assert.equal(runtimeBytes.length, binding.bytes); assert.equal(B.sha256(runtimeBytes), binding.sha256);
  assert.ok(runtimeBytes.toString('utf8').includes(binding.custom_compiler_fragment));
  assert.equal(B.sha256(Buffer.from(binding.custom_compiler_fragment)), binding.custom_compiler_utf8_sha256);
  assert.equal(binding.core_import_symbols.length, 20);
  const temp = H.temp('dcloud-core-runtime');
  async function load(label, original) {
    const work = path.join(temp, label); fs.mkdirSync(work, { mode: 0o700 });
    if (original) {
      const ownModules = path.join(work, 'node_modules'), scope = path.join(ownModules, '@intlify'); fs.mkdirSync(scope, { recursive: true });
      H.writePackage(path.join(scope, 'core-base'), originalEntries);
      const dependencies = JSON.parse(originalEntries.find(e => e.name === 'package.json').bytes).dependencies;
      assert.equal(Object.keys(dependencies).length, 6, 'all original core dependencies remain available to the control');
      for (const [name, version] of Object.entries(dependencies)) {
        assert.ok(name.startsWith('@intlify/')); assert.equal(version, '9.1.9');
        const installed = H.confined(path.join(H.modules, name)), pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json')));
        assert.equal(pkg.name, name); assert.equal(pkg.version, version);
        fs.symlinkSync(installed, path.join(scope, name.slice('@intlify/'.length)), 'dir');
      }
      const nativeImports = [...runtimeBytes.toString('utf8').matchAll(/^import .* from '([^']+)';\r?$/gm)].map(m => m[1]).sort();
      assert.deepEqual(nativeImports, ['@intlify/core-base', '@intlify/shared', '@intlify/vue-devtools', '@vue/devtools-api', 'vue']);
      for (const name of ['vue', '@vue/devtools-api']) {
        const link = path.join(ownModules, name); fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(H.confined(path.join(H.modules, name)), link, 'dir');
      }
    } else fs.symlinkSync(H.modules, path.join(work, 'node_modules'), 'dir');
    const copied = path.join(work, 'dcloud-runtime.mjs'); fs.writeFileSync(copied, runtimeBytes, { flag: 'wx', mode: 0o600 });
    assert.ok(fs.readFileSync(copied).equals(runtimeBytes), 'native ESM uses same raw bytes, filename only');
    const req = Module.createRequire(path.join(work, 'anchor.cjs')), core = req('@intlify/core-base');
    const symbolTypes = Object.fromEntries(binding.core_import_symbols.map(key => { assert.ok(key in core, key); return [key, typeof core[key]]; }));
    const ns = await import(pathToFileURL(copied).href); assert.equal(ns.VERSION, '9.1.9');
    const message = (...parts) => ctx => ctx.normalize(parts.map(p => typeof p === 'function' ? p(ctx) : p));
    const messages = { en: { literal: 'literal text', template: 'Hello {name} {0}', named: message('Hello ', c => c.interpolate(c.named('name'))), list: message('Count ', c => c.interpolate(c.list(0))), mixed: message(c => c.interpolate(c.list(0)), '|', c => c.interpolate(c.named('name'))), fallback: 'fallback text' }, fr: { literal: 'texte literal' } };
    const i18n = ns.createI18n({ legacy: false, locale: 'en', fallbackLocale: 'en', messages, escapeParameter: true, missingWarn: false, fallbackWarn: false, warnHtmlMessage: false });
    const t = i18n.global.t, normal = { literal: t('literal'), customCompiler: t('template', { name: 'Alice' }), named: t('named', { name: 'CinaShop' }), list: t('list', [7]), number: i18n.global.n(1234.5, { useGrouping: false }), date: i18n.global.d(0, { timeZone: 'UTC', year: 'numeric' }) };
    assert.equal(normal.literal, 'literal text'); assert.equal(normal.customCompiler, 'Hello {name} {0}', 'DCloud compiler remains literal ctx.normalize([source])'); assert.equal(normal.named, 'Hello CinaShop'); assert.equal(normal.list, 'Count 7');
    i18n.global.locale.value = 'fr'; normal.localeSwitched = t('literal'); normal.fallback = t('fallback'); assert.equal(normal.localeSwitched, 'texte literal'); assert.equal(normal.fallback, 'fallback text'); i18n.global.locale.value = 'en';
    const named = { name: '<b>N</b>' }, mixed = t('mixed', ['<i>L</i>'], { named });
    assert.equal(mixed, original ? '&lt;i&gt;L&lt;/i&gt;|<b>N</b>' : '&lt;i&gt;L&lt;/i&gt;|&lt;b&gt;N&lt;/b&gt;'); assert.equal(named.name, '<b>N</b>');
    const caller = { name: '<b>N</b>' }; assert.equal(t('named', caller), 'Hello &lt;b&gt;N&lt;/b&gt;'); assert.equal(caller.name, original ? '&lt;b&gt;N&lt;/b&gt;' : '<b>N</b>');
    if (!original) { const frozen = Object.freeze({ name: '<b>N</b>' }); assert.equal(t('mixed', Object.freeze(['<i>L</i>']), { named: frozen }), '&lt;i&gt;L&lt;/i&gt;|&lt;b&gt;N&lt;/b&gt;'); assert.equal(frozen.name, '<b>N</b>'); }
    return { normal, symbolTypes, exports: Object.keys(ns).sort() };
  }
  try {
    const original = await load('verified-original-core-control', true), candidate = await load('actual-installed-core', false);
    assert.deepEqual(candidate.normal, original.normal); assert.deepEqual(candidate.symbolTypes, original.symbolTypes); assert.deepEqual(candidate.exports, original.exports);
    assert.equal(H.confined(fromDCloud.resolve('@intlify/core-base')), coreEntry);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
