const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const test = require('node:test');
const builder = require('./build-vite-safety-backport.cjs');
const contract = JSON.parse(readFileSync(builder.CONTRACT_PATH, 'utf8'));
const archive = readFileSync(builder.OUTPUT_PATH);
const entries = builder.readArchive(archive);

test('the canonical archive reverses only three security fixes, official Vite compatibility and the manifest change', () => {
  const proof = builder.verifyDerived(archive, contract);
  assert.equal(proof.fileCount, 31);
  assert.deepEqual(proof.changedFiles, ['package.json', builder.CHUNK]);
  assert.ok(archive.equals(builder.writeArchive(entries)));
  assert.ok(builder.writeArchive(entries).equals(builder.writeArchive(entries)));
  for (const entry of entries.filter(({ name }) => !proof.changedFiles.includes(name))) {
    const upstream = contract.files.find(({ name }) => name === entry.name);
    assert.equal(builder.sha256(entry.bytes), upstream.sha256, entry.name);
  }
  const manifest = JSON.parse(entries.find(({ name }) => name === 'package.json').bytes);
  assert.equal(manifest.name, 'vite');
  assert.equal(manifest.version, '5.4.21');
  assert.equal(manifest.dependencies.esbuild, builder.ESBUILD.version);
  assert.deepEqual(manifest.cinashopSecurityBackport, builder.META);
  assert.equal(manifest.license, 'MIT');
});

function mutate(name, change) {
  return builder.writeArchive(entries.map((entry) => entry.name === name ? change({ ...entry, bytes: Buffer.from(entry.bytes), header: Buffer.from(entry.header) }) : entry));
}
test('tampered code, license, metadata, modes and tar ownership fail closed', () => {
  for (const name of [builder.CHUNK, 'LICENSE.md', 'package.json']) {
    const modified = mutate(name, (entry) => ({ ...entry, bytes: Buffer.concat([entry.bytes, Buffer.from(' ')]) }));
    assert.throws(() => builder.verifyDerived(modified, contract), /changed|drift|metadata/);
  }
  const mode = mutate('LICENSE.md', (entry) => { entry.header.write('0000755\0', 100, 8, 'ascii'); return entry; });
  assert.throws(() => builder.verifyDerived(mode, contract), /Source file changed/);
  const uid = mutate('LICENSE.md', (entry) => { entry.header.write('0000001\0', 108, 8, 'ascii'); return entry; });
  assert.throws(() => builder.verifyDerived(uid, contract), /Source file changed/);
});
test('unsafe tar paths, links, duplicates and missing entries fail closed', () => {
  for (const invalidName of ['../outside', 'package/../outside', 'package/back\\slash']) {
    const modified = mutate('LICENSE.md', (entry) => { entry.header.fill(0, 0, 100); entry.header.write(invalidName, 0, 'ascii'); return entry; });
    assert.throws(() => builder.readArchive(modified), /Unsafe tar path/);
  }
  const link = mutate('LICENSE.md', (entry) => { entry.header[156] = 50; return entry; });
  assert.throws(() => builder.readArchive(link), /Non-regular/);
  assert.throws(() => builder.readArchive(builder.writeArchive([...entries, entries[0]])), /Duplicate/);
  assert.throws(() => builder.readArchive(builder.writeArchive(entries.slice(1))), /file set/);
});
test('incorrect official SRI, source drift and patch reapplication fail closed', () => {
  assert.throws(() => builder.buildArchive(archive, contract), /official Vite archive integrity/);
  assert.throws(() => builder.buildArchive(Buffer.from('not a tarball'), contract), /official Vite archive integrity/);
  const chunk = entries.find(({ name }) => name === builder.CHUNK).bytes.toString('utf8');
  for (const patch of builder.PATCHES) {
    const label = patch.advisory || patch.compatibility;
    assert.equal(chunk.split(patch.after).length, 2, label);
    assert.throws(() => builder.replaceOnce('', patch.before, patch.after, label), /Source drift/);
    assert.throws(() => builder.replaceOnce(patch.before + patch.before, patch.before, patch.after, label), /Source drift/);
  }
  assert.throws(() => builder.assertContract(entries, contract), /Source file changed/);
});
test('npm installs the pinned derived bytes and preserves the DCloud Vite peer', () => {
  const project = resolve(__dirname, '..');
  const manifest = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(project, 'package-lock.json'), 'utf8'));
  const spec = 'file:vendor/vite-5.4.21-safety-backport.tgz';
  assert.equal(manifest.devDependencies.vite, spec);
  assert.equal(lock.packages[''].devDependencies.vite, spec);
  assert.equal(lock.packages['node_modules/vite'].resolved, spec);
  assert.equal(lock.packages['node_modules/vite'].integrity, builder.integrity(archive));
  const installedRoot = resolve(project, 'node_modules/vite');
  for (const entry of entries) assert.ok(readFileSync(resolve(installedRoot, entry.name)).equals(entry.bytes), entry.name);
  const vite = JSON.parse(readFileSync(resolve(installedRoot, 'package.json'), 'utf8'));
  const plugin = require('@dcloudio/vite-plugin-uni/package.json');
  assert.ok(require('semver').satisfies(vite.version, plugin.peerDependencies.vite));
});
test('both actual Vite and DCloud resolution chains use the official fixed esbuild', () => {
  for (const consumer of ['vite', '@dcloudio/uni-cli-shared']) {
    const consumerRequire = createRequire(require.resolve(`${consumer}/package.json`));
    const installed = consumerRequire('esbuild/package.json');
    assert.equal(installed.version, builder.ESBUILD.version, consumer);
    const project = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
    assert.equal(project.overrides[consumer].esbuild, builder.ESBUILD.version, consumer);
  }
  const lock = JSON.parse(readFileSync(resolve(__dirname, '../package-lock.json'), 'utf8'));
  for (const [name, entry] of Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/esbuild$/.test(name))) {
    assert.equal(entry.version, builder.ESBUILD.version, name);
    assert.equal(entry.integrity, builder.ESBUILD.integrity, name);
  }
});
