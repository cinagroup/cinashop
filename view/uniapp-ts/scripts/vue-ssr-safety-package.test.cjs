'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module'), vm = require('node:vm'), { spawnSync } = require('node:child_process');
const test = require('node:test'), builder = require('./build-vue-ssr-safety-backport.cjs');
const project = path.resolve(__dirname, '..'), req = createRequire(path.join(project, 'package.json'));
const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json')));
const lock = JSON.parse(fs.readFileSync(path.join(project, 'package-lock.json')));
const artifacts = builder.PACKAGES.map(config => ({ config,
  contract: JSON.parse(fs.readFileSync(path.join(builder.vendor, config.stem + '-source.json'))),
  archive: fs.readFileSync(path.join(builder.vendor, config.stem + '-safety-backport.tgz')) }));
function executeCjs(body, importer) {
  const module = { exports: {} };
  vm.runInNewContext(body.toString('utf8'), { module, exports: module.exports, require: importer, console, process }, { timeout: 1000 });
  return module.exports;
}
function reverseEntries(artifact) {
  return builder.readArchive(artifact.archive).map(entry => {
    let text = entry.bytes.toString('utf8');
    if (artifact.config.patchedFiles.includes(entry.name)) text = text.replace(builder.AFTER, builder.BEFORE);
    else if (entry.name === 'package.json') text = text.replace(builder.marker(artifact.config), '');
    else return entry;
    return { ...entry, bytes: Buffer.from(text) };
  });
}
function entry(entries, name) { const selected = entries.find(row => row.name === name); assert.ok(selected, name); return selected; }

test('both Vue archives reverse exactly the official CR fix and keep all other file/header bytes', () => {
  for (const artifact of artifacts) {
    const { config, archive, contract } = artifact, proof = builder.verifyDerived(archive, contract, config);
    assert.deepEqual(proof.changedFiles, ['package.json', ...config.patchedFiles]);
    assert.equal(proof.fileCount, config.name === '@vue/shared' ? 8 : 10);
    assert.ok(builder.writeArchive(builder.readArchive(archive)).equals(archive));
    const parsed = JSON.parse(entry(builder.readArchive(archive), 'package.json').bytes);
    assert.equal(parsed.name, config.name); assert.equal(parsed.version, '3.4.21'); assert.equal(parsed.license, 'MIT');
    assert.deepEqual(parsed.cinashopSecurityBackport, builder.metadata(config));
    assert.equal(parsed.cinashopSecurityBackport.commit, 'a2b40db9a83b36ed9da3a16403cf8f040262d73f');
    builder.assertContract(reverseEntries(artifact), contract, config);
  }
});

test('tampered source, license, metadata, tar ownership, duplicates and links fail closed', () => {
  for (const artifact of artifacts) {
    const entries = builder.readArchive(artifact.archive), mutate = (name, change) => builder.writeArchive(entries.map(row => row.name === name ? change({ ...row, header: Buffer.from(row.header), bytes: Buffer.from(row.bytes) }) : row));
    for (const name of ['package.json', 'LICENSE', artifact.config.patchedFiles[0]]) {
      const changed = mutate(name, row => ({ ...row, bytes: Buffer.concat([row.bytes, Buffer.from(' ')]) }));
      assert.throws(() => builder.verifyDerived(changed, artifact.contract, artifact.config), /changed|drift|metadata|Non-canonical/);
    }
    const ownership = mutate('LICENSE', row => { row.header.write('0000001\0', 108, 8, 'ascii'); return row; });
    assert.throws(() => builder.verifyDerived(ownership, artifact.contract, artifact.config), /Source file changed/);
    const link = mutate('LICENSE', row => { row.header[156] = 50; return row; });
    assert.throws(() => builder.readArchive(link), /linked|Non-regular/);
    assert.throws(() => builder.readArchive(builder.writeArchive([...entries, entries[0]])), /Duplicate/);
    const traversal = mutate('LICENSE', row => { row.header.fill(0, 0, 100); row.header.write('package/../outside', 0, 'ascii'); return row; });
    assert.throws(() => builder.readArchive(traversal), /Unsafe tar path/);
    assert.throws(() => builder.verifyDerived(builder.writeArchive(entries.slice(1)), artifact.contract, artifact.config), /contract|file set|changed/);
    assert.throws(() => builder.buildArchive(artifact.archive, artifact.contract, artifact.config), /official Vue archive integrity/);
  }
});

test('real original Vue 3.4.21 SSR reproduces the negative and the derived CJS rejects only unsafe keys', () => {
  const shared = artifacts[0], renderer = artifacts[1];
  const originalShared = executeCjs(entry(reverseEntries(shared), 'dist/shared.cjs.js').bytes, req);
  const originalRenderer = executeCjs(entry(reverseEntries(renderer), 'dist/server-renderer.cjs.js').bytes, name => name === '@vue/shared' ? originalShared : req(name));
  const props = { id: 'safe', ['x\rautofocus\ronfocus']: 'inert-marker' };
  assert.equal(originalRenderer.ssrRenderAttrs(props), ' id="safe" x\rautofocus\ronfocus="inert-marker"');
  assert.equal(originalShared.isSSRSafeAttrName('x\rautofocus\ronfocus'), true);
  for (const mode of ['js', 'prod.js']) {
    const fixedShared = executeCjs(entry(builder.readArchive(shared.archive), 'dist/shared.cjs.' + mode).bytes, req);
    const fixedRenderer = executeCjs(entry(builder.readArchive(renderer.archive), 'dist/server-renderer.cjs.' + mode).bytes, name => name === '@vue/shared' ? fixedShared : req(name));
    assert.equal(fixedRenderer.ssrRenderAttrs(props), ' id="safe"');
    assert.equal(fixedRenderer.ssrRenderAttrs({ title: '<&"', id: 'safe' }), originalRenderer.ssrRenderAttrs({ title: '<&"', id: 'safe' }));
    for (const separator of ['\t', '\n', '\f', '\r', ' ']) assert.equal(fixedRenderer.ssrRenderAttrs({ ['x' + separator + 'onfocus']: 'inert-marker' }), '');
  }
});

test('shared ESM and both standalone SSR browser formats execute the same official CR rejection', async () => {
  const sharedSource = entry(builder.readArchive(artifacts[0].archive), 'dist/shared.esm-bundler.js').bytes;
  const shared = await import('data:text/javascript;base64,' + sharedSource.toString('base64'));
  assert.equal(shared.isSSRSafeAttrName('x\rautofocus\ronfocus'), false);
  assert.equal(shared.isSSRSafeAttrName('data-safe'), true);
  for (const file of artifacts[1].config.patchedFiles) {
    const bytes = entry(builder.readArchive(artifacts[1].archive), file).bytes;
    const renderer = await import('data:text/javascript;base64,' + bytes.toString('base64'));
    assert.equal(renderer.ssrRenderAttrs({ id: 'safe', ['x\rautofocus\ronfocus']: 'inert-marker' }), ' id="safe"');
    assert.equal(renderer.ssrRenderAttrs({ title: '<&"' }), ' title="&lt;&amp;&quot;"');
  }
});

test('actual installation keeps the DCloud 3.4.21 root and resolves every paired renderer to fixed bytes', () => {
  assert.equal(manifest.dependencies.vue, '3.4.21');
  assert.equal(req('vue/package.json').version, '3.4.21');
  assert.equal(req('@vue/compiler-sfc/package.json').version, '3.4.21');
  const actual = req('@vue/server-renderer');
  assert.equal(actual.ssrRenderAttrs({ id: 'safe', ['x\rautofocus\ronfocus']: 'inert-marker' }), ' id="safe"');
  for (const artifact of artifacts) {
    const spec = 'file:vendor/' + artifact.config.stem + '-safety-backport.tgz';
    assert.equal(manifest.dependencies[artifact.config.name], spec);
    assert.equal(manifest.overrides[artifact.config.name + '@3.4.21'], undefined);
    const installed = path.dirname(req.resolve(artifact.config.name + '/package.json'));
    for (const row of builder.readArchive(artifact.archive)) assert.ok(fs.readFileSync(path.join(installed, row.name)).equals(row.bytes), row.name);
    const packageLock = lock.packages['node_modules/' + artifact.config.name];
    assert.equal(packageLock.version, '3.4.21'); assert.equal(packageLock.integrity, builder.integrity(artifact.archive));
  }
  const nested = createRequire(req.resolve('@dcloudio/uni-h5/package.json'));
  assert.equal(nested('vue/package.json').version, '3.5.42');
  const nestedVue = createRequire(nested.resolve('vue/package.json'));
  assert.equal(nestedVue('@vue/server-renderer/package.json').version, '3.5.42');
  assert.equal(nestedVue('@vue/server-renderer').ssrRenderAttrs({ id: 'safe', ['x\rautofocus\ronfocus']: 'inert-marker' }), ' id="safe"');
  for (const [name, pkg] of Object.entries(lock.packages).filter(([name]) => name.endsWith('node_modules/@vue/shared'))) {
    assert.ok(pkg.version === '3.4.21' || pkg.version === '3.5.42', name);
    if (pkg.version === '3.4.21') assert.equal(pkg.integrity, builder.integrity(artifacts[0].archive), name);
    else assert.equal(pkg.integrity, 'sha512-2rPxex1jQf4jvl9MOHl6YaXCPcrNqz/FstMOEh3QWY+/OME9nQTvl9WYeCwhW7AFjaR0SnngZGlp/wkR6rkI6g==', name);
  }
  for (const [name, pkg] of Object.entries(lock.packages).filter(([name]) => name.endsWith('node_modules/@vue/server-renderer'))) {
    assert.ok(pkg.version === '3.4.21' || pkg.version === '3.5.42', name);
    if (pkg.version === '3.4.21') assert.equal(pkg.integrity, builder.integrity(artifacts[1].archive), name);
    else assert.equal(pkg.integrity, 'sha512-2++5dUyYS4gvo7xQXSECUDhB7TS0aOl5SeVfC5qSq1Jgfhjvegw1zqhwTIR3imZ+QYPJQw9gfcFvXGAjGZ7ajQ==', name);
  }
});

test('all actual Uni source-map-js copies are official 1.2.2 and its offset amplification cases terminate', () => {
  for (const [name, pkg] of Object.entries(lock.packages).filter(([name]) => name.endsWith('node_modules/source-map-js'))) {
    assert.equal(pkg.version, '1.2.2', name);
    assert.equal(pkg.integrity, 'sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==', name);
  }
  const probe = function (root) {
    const assert = require('node:assert/strict'), { SourceMapConsumer, SourceNode } = require(root);
    const flat = { version: 3, sources: ['a.js'], sourcesContent: ['a'], names: [], mappings: 'AAAA' };
    const indexed = (line, column, map = flat) => ({ version: 3, sections: [{ offset: { line, column }, map }] });
    for (const value of [-1, Infinity, NaN, '1', 0.5, 9007199254740992]) {
      assert.throws(() => new SourceMapConsumer(indexed(value, 0)), /non-negative integers/);
      assert.throws(() => new SourceMapConsumer(indexed(0, value)), /non-negative integers/);
    }
    assert.throws(() => new SourceMapConsumer(indexed(10000001, 0)), /must not exceed/);
    assert.throws(() => new SourceMapConsumer(indexed(6000000, 0, indexed(6000000, 0))), /including offsets of nested sections/);
    const code = 'var x;\n', node = SourceNode.fromStringWithSourceMap(code, new SourceMapConsumer(indexed(10000000, 0)));
    assert.equal(node.toString(), code); assert.ok(node.children.length < 10);
    let deep = flat; for (let i = 0; i < 40; i++) deep = indexed(0, 0, deep);
    assert.equal(SourceNode.fromStringWithSourceMap(code, new SourceMapConsumer(deep)).toString(), code);
  };
  const result = spawnSync(process.execPath, ['-e', '(' + probe.toString() + ')(process.argv[1])', path.dirname(req.resolve('source-map-js/package.json'))], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr);
});
