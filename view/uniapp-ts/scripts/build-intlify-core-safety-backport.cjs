'use strict';
// Exact patches to all seven published9.1.9 JS distributions, not a TS rebuild.
// Package identity/version/dependencies/index/types/MIT remain original bytes.
const fs = require('node:fs'), path = require('node:path');
const A = require('./security-archive-tools.cjs');
const CONTRACT_PATH = path.resolve(__dirname, '../vendor/intlify-core-base-9.1.9-source.json');
const CONTRACT_SHA256 = '3cfa77d693f397239771b90307bb92d63a897a48d51c889c75e689f4d4033131';
const rawContract = fs.readFileSync(CONTRACT_PATH);
if (A.sha256(rawContract) !== CONTRACT_SHA256) throw Error('Intlify source contract changed');
const CONTRACT = JSON.parse(rawContract);
const assertContract = c => { if (A.sha256(Buffer.from(JSON.stringify(c, null, 2) + '\n')) !== CONTRACT_SHA256) throw Error('Intlify source contract object changed'); };
function patchEntries(entries, reverse = false) {
  return entries.map(e => {
    const p = CONTRACT.patches.find(p => p.file === e.name);
    return p ? { ...e, bytes: Buffer.from(A.replaceOnce(e.bytes.toString('utf8'), reverse ? p.after : p.before, reverse ? p.before : p.after, (reverse ? 'reverse ' : '') + e.name)) } : e;
  });
}
function assertIdentity(entries) {
  const manifest = entries.find(e => e.name === 'package.json');
  const pkg = JSON.parse(manifest.bytes);
  if (pkg.name !== '@intlify/core-base' || pkg.version !== '9.1.9' || pkg.license !== 'MIT' || Object.hasOwn(pkg, 'cinashopSecurityBackport')) throw Error('Original Intlify package identity changed');
}
function reverseDerived(archive, contract = CONTRACT) {
  assertContract(contract);
  if (A.sha256(archive) !== contract.derived.archiveSha256 || A.integrity(archive) !== contract.derived.integrity || archive.length !== contract.derived.bytes) throw Error('Unexpected complete derived Intlify archive');
  const entries = A.readArchive(archive); A.assertFiles(entries, contract.derived); assertIdentity(entries);
  const original = patchEntries(entries, true); A.assertFiles(original, contract.source, false);
  if (!archive.equals(A.writeArchive(patchEntries(original)))) throw Error('Non-canonical Intlify tar/gzip bytes');
  return original;
}
function verifyDerived(archive, contract = CONTRACT) {
  reverseDerived(archive, contract);
  return { fileCount: 12, patchedPublishedDistributions: contract.allowedChangedOriginalFiles, directlyPatchedNotTSRebuilt: true, sha256: A.sha256(archive), integrity: A.integrity(archive) };
}
function buildArchive(source, contract = CONTRACT) {
  assertContract(contract);
  const original = A.assertArchive(source, contract.source); assertIdentity(original);
  const archive = A.writeArchive(patchEntries(original)); verifyDerived(archive, contract); return archive;
}
module.exports = { CONTRACT, CONTRACT_PATH, CONTRACT_SHA256, patchEntries, reverseDerived, verifyDerived, buildArchive, ...A };
if (require.main === module) {
  if (process.argv.length !== 4) throw Error('Usage: node build-intlify-core-safety-backport.cjs official-core-base-9.1.9.tgz NEW-output.tgz');
  const archive = buildArchive(fs.readFileSync(path.resolve(process.argv[2])));
  const output = path.resolve(process.argv[3]); fs.writeFileSync(output, archive, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, bytes: archive.length, ...verifyDerived(archive) }));
}
