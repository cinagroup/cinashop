'use strict';
// Exact offline source derivation; retains Jest identity and the reviewed v2 tgz bytes.
const fs = require('node:fs'), path = require('node:path');
const A = require('./security-archive-tools.cjs');
const CONTRACT_PATH = path.resolve(__dirname, '../vendor/jest-config-27.5.1-source.json');
const CONTRACT_SHA256 = 'a37b25669c2b5a39da0a6485a3dd82dc5d85e1ccb204c3d547bf8588e17a2d15';
const rawContract = fs.readFileSync(CONTRACT_PATH);
if (A.sha256(rawContract) !== CONTRACT_SHA256) throw Error('Jest source contract changed');
const CONTRACT = JSON.parse(rawContract);
const assertContract = c => { if (A.sha256(Buffer.from(JSON.stringify(c, null, 2) + '\n')) !== CONTRACT_SHA256) throw Error('Jest source contract object changed'); };
function patchCore(bytes, reverse = false) {
  let text = bytes.toString('utf8');
  for (const p of (reverse ? CONTRACT.corePatches.slice().reverse() : CONTRACT.corePatches)) text = A.replaceOnce(text, reverse ? p.after : p.before, reverse ? p.before : p.after, 'deepmerge CJS copy guard');
  const result = Buffer.from(text);
  if (A.sha256(result) !== (reverse ? CONTRACT.helper.originalCoreSha256 : CONTRACT.helper.fixedCoreSha256)) throw Error('Deepmerge core hash mismatch');
  return result;
}
function makeHelper(componentEntries) {
  A.assertFiles(componentEntries, CONTRACT.component);
  const files = new Map(componentEntries.map(e => [e.name, e]));
  const license = files.get('license.txt').bytes;
  if (A.sha256(license) !== CONTRACT.helper.originalLicenseSha256 || license.includes(Buffer.from('*/'))) throw Error('Deepmerge MIT license drift');
  const prefix = Buffer.concat([Buffer.from('/*\nVendored deepmerge 4.3.1 with reviewed __proto__ assignment guards.\n'), license, Buffer.from('*/\n')]);
  if (!prefix.equals(Buffer.from(CONTRACT.helper.prefixUtf8))) throw Error('Deepmerge license wrapper drift');
  const helper = Buffer.concat([prefix, patchCore(files.get('dist/cjs.js').bytes)]);
  if (A.sha256(helper) !== CONTRACT.helper.fixedHelperSha256) throw Error('Complete helper hash mismatch');
  return helper;
}
function verifyHelper(bytes) {
  const prefix = Buffer.from(CONTRACT.helper.prefixUtf8);
  if (A.sha256(bytes) !== CONTRACT.helper.fixedHelperSha256 || !bytes.subarray(0, prefix.length).equals(prefix)) throw Error('Complete helper/license changed');
  return patchCore(bytes.subarray(prefix.length), true);
}
function patchManifest(bytes) {
  const original = bytes.toString('utf8');
  if (original !== CONTRACT.manifest.beforeUtf8) throw Error('Original Jest manifest changed');
  const parsed = JSON.parse(original);
  if (parsed.name !== 'jest-config' || parsed.version !== '27.5.1' || parsed.license !== 'MIT' || parsed.dependencies.deepmerge !== '^4.2.2' || Object.hasOwn(parsed, 'cinashopSecurityBackport')) throw Error('Original Jest identity/dependency changed');
  delete parsed.dependencies.deepmerge;
  parsed.cinashopSecurityBackport = CONTRACT.manifest.metadata;
  const result = JSON.stringify(parsed, null, 2) + '\n';
  if (result !== CONTRACT.manifest.afterUtf8) throw Error('Jest metadata or remaining API/dependencies changed');
  return Buffer.from(result);
}
function patchEntries(entries, helper) {
  return [...entries.map(e => {
    let bytes = e.bytes;
    if (e.name === CONTRACT.normalizePatch.file) bytes = Buffer.from(A.replaceOnce(bytes.toString('utf8'), CONTRACT.normalizePatch.before, CONTRACT.normalizePatch.after, 'sole normalize require'));
    else if (e.name === 'package.json') bytes = patchManifest(bytes);
    return { ...e, bytes };
  }), { name: CONTRACT.helper.file, mode: 0o644, bytes: helper }];
}
function reverseDerived(archive, contract = CONTRACT) {
  assertContract(contract);
  if (A.sha256(archive) !== contract.derived.archiveSha256 || A.integrity(archive) !== contract.derived.integrity || archive.length !== contract.derived.bytes) throw Error('Unexpected complete derived Jest archive');
  const entries = A.readArchive(archive); A.assertFiles(entries, contract.derived);
  const helper = entries.find(e => e.name === contract.helper.file); verifyHelper(helper.bytes);
  const original = entries.filter(e => e.name !== contract.helper.file).map(e => {
    let bytes = e.bytes;
    if (e.name === contract.normalizePatch.file) bytes = Buffer.from(A.replaceOnce(bytes.toString('utf8'), contract.normalizePatch.after, contract.normalizePatch.before, 'reverse sole normalize require'));
    else if (e.name === 'package.json') bytes = Buffer.from(A.replaceOnce(bytes.toString('utf8'), contract.manifest.afterUtf8, contract.manifest.beforeUtf8, 'reverse exact Jest manifest'));
    return { ...e, bytes };
  });
  A.assertFiles(original, contract.source, false);
  if (!archive.equals(A.writeArchive(patchEntries(original, helper.bytes)))) throw Error('Non-canonical Jest tar/gzip bytes');
  return original;
}
function verifyDerived(archive, contract = CONTRACT) {
  reverseDerived(archive, contract);
  return { fileCount: 35, changedOriginalFiles: contract.allowedChangedOriginalFiles, addedFiles: contract.allowedNewFiles, sha256: A.sha256(archive), integrity: A.integrity(archive) };
}
function buildArchive(jestArchive, deepmergeArchive, contract = CONTRACT) {
  assertContract(contract);
  const original = A.assertArchive(jestArchive, contract.source), component = A.assertArchive(deepmergeArchive, contract.component);
  const archive = A.writeArchive(patchEntries(original, makeHelper(component)));
  verifyDerived(archive, contract); return archive;
}
module.exports = { CONTRACT, CONTRACT_PATH, CONTRACT_SHA256, patchCore, makeHelper, verifyHelper, patchManifest, patchEntries, reverseDerived, verifyDerived, buildArchive, ...A };
if (require.main === module) {
  if (process.argv.length !== 5) throw Error('Usage: node build-jest-deepmerge-safety-backport.cjs official-jest-config-27.5.1.tgz official-deepmerge-4.3.1.tgz NEW-output.tgz');
  const archive = buildArchive(fs.readFileSync(path.resolve(process.argv[2])), fs.readFileSync(path.resolve(process.argv[3])));
  const output = path.resolve(process.argv[4]); fs.writeFileSync(output, archive, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, bytes: archive.length, ...verifyDerived(archive) }));
}
