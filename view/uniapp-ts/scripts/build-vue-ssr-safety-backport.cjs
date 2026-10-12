'use strict';
// Exact official Vue 3.4.21 bytes, preserving the DCloud runtime/peer version.
// The sole code change is upstream a2b40db: reject CR in SSR attribute names.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const archiveTools = require('./build-vite-safety-backport.cjs');
const COMMIT = 'a2b40db9a83b36ed9da3a16403cf8f040262d73f';
const ADVISORY = 'GHSA-g2v6-rqmx-r4w6';
const BEFORE = '/[>/="\'\\u0009\\u000a\\u000c\\u0020]/';
const AFTER = '/[>/="\'\\u0009\\u000a\\u000c\\u000d\\u0020]/';
const PACKAGES = Object.freeze([
  { name: '@vue/shared', version: '3.4.21', stem: 'vue-shared-3.4.21',
    url: 'https://registry.npmjs.org/@vue/shared/-/shared-3.4.21.tgz',
    integrity: 'sha512-PuJe7vDIi6VYSinuEbUIQgMIRZGgM8e4R+G+/dQTk0X1NEdvgvvgv7m+rfmDH1gZzyA1OjjoWskvHlfRNfQf3g==',
    patchedFiles: ['dist/shared.cjs.js', 'dist/shared.cjs.prod.js', 'dist/shared.esm-bundler.js'] },
  { name: '@vue/server-renderer', version: '3.4.21', stem: 'vue-server-renderer-3.4.21',
    url: 'https://registry.npmjs.org/@vue/server-renderer/-/server-renderer-3.4.21.tgz',
    integrity: 'sha512-aV1gXyKSN6Rz+6kZ6kr5+Ll14YzmIbeuWe7ryJl5muJ4uwSwY/aStXTixx76TwkZFJLm1aAlA/HSWEJ4EyiMkg==',
    patchedFiles: ['dist/server-renderer.esm-browser.js', 'dist/server-renderer.esm-browser.prod.js'] }
]);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
const replaceOnce = archiveTools.replaceOnce;
const writeArchive = archiveTools.writeArchive;
function octal(header, offset, length) {
  const value = header.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(value)) throw Error('Invalid tar numeric field');
  return parseInt(value, 8);
}
function readArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 4 * 1024 * 1024) throw Error('Invalid Vue archive size');
  const tar = zlib.gunzipSync(bytes, { maxOutputLength: 4 * 1024 * 1024 });
  if (tar.length % 512) throw Error('Truncated tar');
  const entries = [], names = new Set(); let offset = 0, terminated = false;
  while (offset + 512 <= tar.length) {
    const header = Buffer.from(tar.subarray(offset, offset + 512));
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every(byte => byte === 0)) throw Error('Invalid tar terminator');
      terminated = true; break;
    }
    const expectedChecksum = octal(header, 148, 8);
    const actualChecksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (expectedChecksum !== actualChecksum) throw Error('Invalid tar checksum');
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix || !rawName.startsWith('package/') || /\\/.test(rawName) || rawName.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Unsafe tar path');
    const name = rawName.slice(8);
    if (names.has(name)) throw Error('Duplicate tar path'); names.add(name);
    if ((header[156] !== 0 && header[156] !== 48) || !header.subarray(157, 257).every(byte => byte === 0)) throw Error('Non-regular or linked tar entry');
    const size = octal(header, 124, 12), mode = octal(header, 100, 8);
    const end = offset + 512 + size, paddedEnd = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || paddedEnd > tar.length || !tar.subarray(end, paddedEnd).every(byte => byte === 0)) throw Error('Invalid tar payload');
    entries.push({ name, mode, header, bytes: Buffer.from(tar.subarray(offset + 512, end)) }); offset = paddedEnd;
  }
  if (!terminated || !entries.length) throw Error('Unexpected Vue file set');
  return entries;
}
function sourceIdentity(config) { return { name: config.name, version: config.version, url: config.url, integrity: config.integrity }; }
function metadata(config) {
  return { format: 1, source: sourceIdentity(config), advisory: ADVISORY, commit: COMMIT,
    change: 'Add U+000D to the existing unsafe SSR attribute-name character class only.',
    patchedFiles: config.patchedFiles, retainedVersion: '3.4.21',
    support: 'Project-maintained exact official fix backport; the npm Registry version advisory still applies to the retained version label.' };
}
function marker(config) { return ',\n  "cinashopSecurityBackport": ' + JSON.stringify(metadata(config), null, 2).replace(/\n/g, '\n  '); }
function patchEntries(entries, config) {
  return entries.map(entry => {
    let text = entry.bytes.toString('utf8');
    if (config.patchedFiles.includes(entry.name)) text = replaceOnce(text, BEFORE, AFTER, entry.name);
    else if (entry.name === 'package.json') {
      const parsed = JSON.parse(text);
      if (parsed.name !== config.name || parsed.version !== config.version || Object.hasOwn(parsed, 'cinashopSecurityBackport')) throw Error('Upstream package identity changed');
      const at = text.lastIndexOf('\n}');
      if (at < 0 || !/^\n?$/u.test(text.slice(at + 2))) throw Error('Manifest terminator drift');
      text = text.slice(0, at) + marker(config) + text.slice(at);
    } else return entry;
    return { ...entry, bytes: Buffer.from(text) };
  });
}
function makeContract(source, config) {
  if (integrity(source) !== config.integrity) throw Error('Unexpected official Vue archive integrity');
  const entries = readArchive(source);
  const names = new Set(entries.map(entry => entry.name));
  if (!names.has('package.json') || !names.has('LICENSE') || config.patchedFiles.some(name => !names.has(name))) throw Error('Official required file set changed');
  return { source: sourceIdentity(config), sourceArchiveSha256: sha256(source), fileCount: entries.length,
    normalizedTarHeaderFields: 'Only tar size/checksum fields are canonicalized by the existing deterministic archive writer.',
    files: entries.map(entry => ({ name: entry.name, mode: entry.mode, bytes: entry.bytes.length, sha256: sha256(entry.bytes), canonicalHeaderSha256: sha256(archiveTools.headerFor(entry)) })) };
}
function assertContract(entries, contract, config) {
  if (JSON.stringify(contract.source) !== JSON.stringify(sourceIdentity(config)) || contract.fileCount !== contract.files.length || entries.length !== contract.fileCount) throw Error('Unexpected source contract');
  const expected = new Map(contract.files.map(file => [file.name, file]));
  if (expected.size !== entries.length) throw Error('Unexpected source file set');
  for (const entry of entries) {
    const file = expected.get(entry.name);
    if (!file || file.mode !== entry.mode || file.bytes !== entry.bytes.length || file.sha256 !== sha256(entry.bytes) || file.canonicalHeaderSha256 !== sha256(archiveTools.headerFor(entry))) throw Error('Source file changed: ' + entry.name);
  }
}
function verifyDerived(archive, contract, config) {
  const entries = readArchive(archive);
  const reversed = entries.map(entry => {
    let text = entry.bytes.toString('utf8');
    if (config.patchedFiles.includes(entry.name)) text = replaceOnce(text, AFTER, BEFORE, 'reverse ' + entry.name);
    else if (entry.name === 'package.json') text = replaceOnce(text, marker(config), '', 'reverse manifest metadata');
    else return entry;
    return { ...entry, bytes: Buffer.from(text) };
  });
  assertContract(reversed, contract, config);
  if (!archive.equals(writeArchive(patchEntries(reversed, config)))) throw Error('Non-canonical derived archive');
  return { fileCount: entries.length, changedFiles: ['package.json', ...config.patchedFiles], integrity: integrity(archive) };
}
function buildArchive(source, contract, config) {
  if (integrity(source) !== config.integrity || sha256(source) !== contract.sourceArchiveSha256) throw Error('Unexpected official Vue archive integrity');
  const entries = readArchive(source); assertContract(entries, contract, config);
  const archive = writeArchive(patchEntries(entries, config)); verifyDerived(archive, contract, config); return archive;
}
const vendor = path.resolve(__dirname, '../vendor');
module.exports = { PACKAGES, COMMIT, ADVISORY, BEFORE, AFTER, sha256, integrity, readArchive, writeArchive, makeContract, metadata, marker, patchEntries, assertContract, verifyDerived, buildArchive, vendor };
if (require.main === module) {
  if (process.argv.length !== 4) throw Error('Usage: node build-vue-ssr-safety-backport.cjs official-shared.tgz official-server-renderer.tgz');
  const rows = PACKAGES.map((config, i) => {
    const source = fs.readFileSync(path.resolve(process.argv[i + 2])), contract = makeContract(source, config);
    const archive = buildArchive(source, contract, config);
    const contractPath = path.join(vendor, config.stem + '-source.json'), output = path.join(vendor, config.stem + '-safety-backport.tgz');
    fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2) + '\n', { flag: 'wx' });
    fs.writeFileSync(output, archive, { flag: 'wx' });
    return { name: config.name, output, contractPath, bytes: archive.length, ...verifyDerived(archive, contract, config) };
  });
  console.log(JSON.stringify({ source: 'official-npm', rows }));
}
