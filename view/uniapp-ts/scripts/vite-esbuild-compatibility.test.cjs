const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { resolve } = require('node:path');

// Exercise the installed Vite build pipeline, including its real native esbuild.
// No output files, network requests, Babel lowering, or browser target changes.
const root = resolve(__dirname, '..');
const entry = resolve(root, '.toolchain-vite-compatibility-entry.js').replace(/\\/g, '/');
const virtualEntry = '\0cinashop-esbuild-compatibility';
async function compile(source, target, esbuild) {
  const { build } = await import('vite');
  const result = await build({
    root, configFile: false, publicDir: false, logLevel: 'silent', esbuild,
    plugins: [{
      name: 'cinashop-esbuild-compatibility-fixture',
      resolveId(id) { if (id.replace(/\\/g, '/') === entry) return virtualEntry; },
      load(id) { if (id === virtualEntry) return source; },
    }],
    build: {
      target, minify: false, write: false, emptyOutDir: false,
      lib: { entry, formats: ['cjs'] },
    },
  });
  const bundles = Array.isArray(result) ? result : [result];
  const chunks = bundles.flatMap(item => item.output).filter(item => item.type === 'chunk');
  assert.equal(chunks.length, 1);
  return chunks[0].code;
}
function nativeResult(source) {
  return vm.runInNewContext(source.replace(/^export /gm, '') + '\nJSON.stringify(run());', {}, { timeout: 1000 });
}
function compiledResult(code) {
  const module = { exports: {} };
  return vm.runInNewContext(code + '\nJSON.stringify(module.exports.run());',
    { module, exports: module.exports }, { timeout: 1000 });
}

test('the official Vite workaround accepts the existing affected Safari and iOS targets', async t => {
  const source = 'export function run([a,b]) { return [a,b]; }';
  for (const target of ['safari10', 'safari12.1', 'safari14.0', 'ios10', 'ios12.2', 'ios14', 'ios14.4', ['chrome87', 'safari14']]) {
    await t.test(JSON.stringify(target), async () => {
      const code = await compile(source, target);
      assert.match(code, /run/);
    });
  }
});
test('the workaround leaves Safari 9 unsupported instead of granting a blanket feature exemption', async () => {
  await assert.rejects(compile('export function run([a,b]) { return [a,b]; }', 'safari9'),
    /Transforming destructuring/);
});
test('an explicit unsupported-destructuring setting still overrides the official automatic workaround', async () => {
  await assert.rejects(compile('export function run([a,b]) { return [a,b]; }', 'safari14',
    { supported: { destructuring: false } }), /Transforming destructuring/);
});

const counterexamples = [
  ['iterator steps and default initialization remain interleaved', `export function run() {
    const events = []; let index = 0;
    const iterable = { [Symbol.iterator]() { return {
      next() { events.push('next' + index); return { done: false, value: index++ === 0 ? undefined : 2 }; },
      return() { events.push('close'); return { done: true }; }
    }; } };
    const [a = (events.push('default'), 1), b] = iterable;
    return { events, values: [a,b] };
  }`],
  ['an array own iterator is honored and closed', `export function run() {
    const events = []; const value = [1,2];
    value[Symbol.iterator] = function* () { events.push('custom'); try { yield 9; yield 8; yield 7; } finally { events.push('close'); } };
    const [a,b] = value;
    return { events, values: [a,b] };
  }`],
  ['a throwing first default closes the iterator before another step', `export function run() {
    const events = []; let index = 0;
    const iterable = { [Symbol.iterator]() { return {
      next() { events.push('next' + index); return { done: false, value: index++ === 0 ? undefined : 2 }; },
      return() { events.push('close'); return { done: true }; }
    }; } };
    const throwingDefault = () => { events.push('throw'); throw Error('default'); };
    try { const [a = throwingDefault(), b] = iterable; } catch (error) { events.push(error.message); }
    return { events };
  }`],
];
for (const [name, source] of counterexamples) {
  test(name, async () => {
    const code = await compile(source, ['chrome87', 'edge88', 'es2020', 'firefox78', 'safari14']);
    assert.equal(compiledResult(code), nativeResult(source));
  });
}
