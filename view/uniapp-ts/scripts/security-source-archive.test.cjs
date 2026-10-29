'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { test } = require('node:test'), { gunzipSync } = require('node:zlib');
const A = require('./security-archive-tools.cjs');
const cases = [
  ['Jest', require('./build-jest-deepmerge-safety-backport.cjs'), 'jest-config-27.5.1-deepmerge-safety-backport.tgz'],
  ['Intlify', require('./build-intlify-core-safety-backport.cjs'), 'intlify-core-base-9.1.9-mixed-escape-backport.tgz'],
];
function repairChecksum(tar, offset) {
  const h = tar.subarray(offset, offset + 512); h.fill(32, 148, 156);
  h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
}
for (const [label, builder, file] of cases) {
  const raw = fs.readFileSync(path.resolve(__dirname, '../vendor', file));
  test(label + ' complete derived archive reverses to exact official files and canonical bytes', () => {
    const result = builder.verifyDerived(raw); assert.equal(result.sha256, builder.CONTRACT.derived.archiveSha256);
    const original = builder.reverseDerived(raw); A.assertFiles(original, builder.CONTRACT.source, false);
    assert.equal(original.length, builder.CONTRACT.source.fileCount);
    const entries = A.readArchive(raw), expected = new Set(builder.CONTRACT.allowedChangedOriginalFiles);
    const originalMap = new Map(original.map(e => [e.name, e]));
    for (const e of entries) if (!expected.has(e.name) && originalMap.has(e.name)) assert.ok(e.bytes.equals(originalMap.get(e.name).bytes), 'unrelated file changed: ' + e.name);
    assert.ok(entries.find(e => e.name === 'LICENSE').bytes.equals(originalMap.get('LICENSE').bytes));
    assert.throws(() => builder.verifyDerived(Buffer.concat([raw, Buffer.from([0])])));
    assert.throws(() => builder.verifyDerived(raw.subarray(0, raw.length - 1)));
    assert.throws(() => builder.buildArchive(Buffer.alloc(512), Buffer.alloc(512)));
  });
  for (const mutation of ['checksum', 'path traversal', 'absolute path', 'backslash path', 'duplicate path', 'symlink', 'ownership', 'mode', 'payload', 'missing EOA', 'nonzero tail']) test(label + ' rejects archive ' + mutation, () => {
    let tar = Buffer.from(gunzipSync(raw));
    const firstSize = Number.parseInt(tar.subarray(124, 136).toString('ascii'), 8), second = 512 + Math.ceil(firstSize / 512) * 512;
    const setName = (at, value) => { tar.fill(0, at, at + 100); tar.write(value, at, 100, 'ascii'); repairChecksum(tar, at); };
    if (mutation === 'checksum') tar[0] ^= 1;
    if (mutation === 'path traversal') setName(0, 'package/../outside');
    if (mutation === 'absolute path') setName(0, '/package/outside');
    if (mutation === 'backslash path') setName(0, 'package/a\\b');
    if (mutation === 'duplicate path') setName(second, tar.subarray(0, 100).toString('ascii').split('\0')[0]);
    if (mutation === 'symlink') { tar[156] = 50; tar.write('outside', 157, 'ascii'); repairChecksum(tar, 0); }
    if (mutation === 'ownership') { tar.write('0000001\0', 108, 8, 'ascii'); repairChecksum(tar, 0); }
    if (mutation === 'mode') { tar.write('0000755\0', 100, 8, 'ascii'); repairChecksum(tar, 0); }
    if (mutation === 'payload') tar[512] ^= 1;
    if (mutation === 'missing EOA') { const entries = A.readArchive(raw); const dataBytes = entries.reduce((n, e) => n + 512 + Math.ceil(e.bytes.length / 512) * 512, 0); tar = tar.subarray(0, dataBytes); }
    if (mutation === 'nonzero tail') tar[tar.length - 1] = 1;
    const changed = A.deterministicGzip(tar); assert.throws(() => builder.verifyDerived(changed));
    if (!['payload'].includes(mutation)) assert.throws(() => A.readArchive(changed));
  });
}
