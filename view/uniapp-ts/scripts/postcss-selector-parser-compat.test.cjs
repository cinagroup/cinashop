const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { join, dirname } = require('node:path');
const postcss = require('postcss');

const root = join(__dirname, '..');
const consumers = [
  '@dcloudio/uni-cli-shared',
  '@dcloudio/uni-h5',
  '@dcloudio/uni-app-plus',
  'postcss-modules-local-by-default',
  'postcss-modules-scope',
];

test('every installed DCloud and CSS-module consumer resolves the patched selector parser', () => {
  for (const consumer of consumers) {
    const manifest = require.resolve(`${consumer}/package.json`, { paths: [root] });
    const parserManifest = createRequire(manifest).resolve('postcss-selector-parser/package.json');
    assert.equal(require(parserManifest).version, '7.1.6', `${consumer}: ${parserManifest}`);
  }
});

test('DCloud scoped selectors keep the pre-upgrade deep, slot and global rewrites', () => {
  const sharedManifest = require.resolve('@dcloudio/uni-cli-shared/package.json', { paths: [root] });
  const scopedPlugin = require(join(dirname(sharedManifest), 'dist/postcss/plugins/stylePluginScoped.js')).default;
  const cases = [
    { input: '.foo >>> .bar { color: red }', expected: '.foo .bar { color: red }' },
    { input: '::v-slotted(.bar) { color: red }', expected: '.bar { color: red }' },
    { input: '::v-global(.bar) { color: red }', expected: '.bar { color: red }' },
    { input: 'svg|a { color: red }', expected: 'svg|a { color: red }' },
  ];
  for (const { input, expected } of cases) {
    assert.equal(postcss([scopedPlugin()]).process(input, { from: undefined }).css, expected, input);
  }

  const vueSfcScoped = { postcssPlugin: 'vue-sfc-scoped' };
  assert.equal(
    postcss([vueSfcScoped, scopedPlugin()]).process('.foo >>> .bar { color: red }', { from: undefined }).css,
    '.foo :deep(.bar) { color: red }',
  );
});

test('DCloud uni-app tag rewrites keep H5, App and Baidu selector output', () => {
  const sharedManifest = require.resolve('@dcloudio/uni-cli-shared/package.json', { paths: [root] });
  const uniAppPlugin = require(join(dirname(sharedManifest), 'dist/postcss/plugins/uniapp.js')).default;
  const input = 'page, view, navigator { background-color: red; width: 10rpx }';
  const expected = {
    h5: 'uni-page-body, uni-view, uni-navigator { background-color: red; width: 0.3125rem }\nbody { background-color: red }',
    app: 'body, uni-view, uni-navigator { background-color: red; width: 0.3125rem }',
    'mp-baidu': 'page, view, nav { background-color: red; width: 0.3125rem }',
  };
  const priorPlatform = process.env.UNI_PLATFORM;
  try {
    for (const [platform, output] of Object.entries(expected)) {
      process.env.UNI_PLATFORM = platform;
      assert.equal(postcss([uniAppPlugin()]).process(input, { from: undefined }).css, output, platform);
    }
  } finally {
    if (priorPlatform === undefined) delete process.env.UNI_PLATFORM;
    else process.env.UNI_PLATFORM = priorPlatform;
  }
});
