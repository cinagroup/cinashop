/** Rebuild the exact postgres@3.4.9 CF socket-close backport.
 * No fetch, install, patch of node_modules, SQL, crypto or protocol substitution.
 * The sole local supplement handles writer.close() rejection via error().
 * Upstream PR #1251 has a broad closed-state error guard: this builder preserves
 * that behavior exactly; it does not claim late unknown errors remain visible.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const POSTGRES_CF_CLOSE_BACKPORT = Object.freeze({
  "sourceUrl": "https://registry.npmjs.org/postgres/-/postgres-3.4.9.tgz",
  "sourceSri": "sha512-GD3qdB0x1z9xgFI6cdRD6xu2Sp2WCOEoe3mtnyB5Ee0XrrL5Pe+e4CCnJrRMnL1zYtRDZmQQVbvOttLnKDLnaw==",
  "sourceSha256": "4964056ae6b672361557f738532a20ad29d54cff0b146cb66d67d7155d66761e",
  "originalPolyfillsSha256": "c9bfd7d57f1402676a42c8b6a49386ca18f95ccc687fdaad625f3a3fc7ba3f81",
  "derivedPolyfillsSha256": "d81e886fa473be14d964f6d89b0ca835a166e8759a8dc74c8507d18c95a8c93d",
  "upstreamFileGitBlob": "0594d263ef9b8bf0995d3a0274cf8458ca2cddfe",
  "patchSha256": "f724b5888d530fa395572e4f65b918a660e7fe93bd692c1a29f5f4916fb5876d",
  "derivedSri": "sha512-MHLprJJkwfkOAqCzEOfguKVmLMG0zZJeh0c39Sb2DUKFMRXid7uZTqDIjgJCvy5Dp51WPiuLV18D4kmdbij4bA==",
  "derivedSha256": "c59893d3a0a839b07c2dcbd666adbdd43850b9a288eadbdf04554139c7f4d3d9",
  "upstreamPr": "https://github.com/porsager/postgres/pull/1251",
  "upstreamPrHead": "b0922e4130bfd3b743ae813d3a435d1fc09ca46b",
  "upstreamV4Commit": "06cf284705294a2c5da041d0fbe209462283da6b",
  "upstreamPolyfillsSha256": "4652f1163ff4282dd4fb29f057aea5841e5b1c5ce6a99c75c5d404e22111e8ce",
  "localSupplement": "Route writer.close() rejection through the existing error handler; no other local driver change."
});
const SOURCE_FILES = Object.freeze({
  "package/README.md": {
    "size": 50594,
    "sha256": "036885436fc97f00ec33baabe6d4692dd05fc0c47b977f219b5ba3b89eecb6b1"
  },
  "package/cf/polyfills.js": {
    "size": 5484,
    "sha256": "c9bfd7d57f1402676a42c8b6a49386ca18f95ccc687fdaad625f3a3fc7ba3f81"
  },
  "package/cf/src/bytes.js": {
    "size": 1399,
    "sha256": "368a278367814e80f7ae816e01e202279f3ce38347f2ac465b562ebeb61d84ca"
  },
  "package/cf/src/connection.js": {
    "size": 28845,
    "sha256": "3efad812b825f76708f2e62e8dd00088900206e04afed2dc4b75b9aecd435fa9"
  },
  "package/cf/src/errors.js": {
    "size": 1155,
    "sha256": "85cfbed9a5ab0db41ab8e97b806c881af29807dfe99bc656fdf1a18c1c13b6c6"
  },
  "package/cf/src/index.js": {
    "size": 15504,
    "sha256": "aca9c247b7ddb2aedf90d20ce8e6f52ac6ebd95865056599ca05ed4dab4baad7"
  },
  "package/cf/src/large.js": {
    "size": 2138,
    "sha256": "b02b13cf2b5d435368c7d61989af1692a9965b6edf9b60e1d0bc320ac42f48df"
  },
  "package/cf/src/query.js": {
    "size": 3600,
    "sha256": "67c45a5151032aa46b587abc15381fe4efd97c696e5c1b53082b8161309c4ee2"
  },
  "package/cf/src/queue.js": {
    "size": 541,
    "sha256": "15e6345adb6708bf3b99ad39fc2231c2fb61de5f6cba4b7a7a6be881482a4ec3"
  },
  "package/cf/src/result.js": {
    "size": 416,
    "sha256": "001ff5e0c8d634674f483d07fbcd620a797e3101f842d6c20ca3ace936260465"
  },
  "package/cf/src/subscribe.js": {
    "size": 7663,
    "sha256": "9ce6fd98780e0adff813d13cc03951e5b1c66d602637beb6f9494c40e7b9212e"
  },
  "package/cf/src/types.js": {
    "size": 10972,
    "sha256": "e6c9e8f43272ae853944613560e5eabb15955fd8b2981749e7fa1c9015f370db"
  },
  "package/cjs/package.json": {
    "size": 19,
    "sha256": "fa6944a20ca5e6fbaf98fd202eb8c7004d5b4ab786e36b9ed02ee31dbe196c9f"
  },
  "package/cjs/src/bytes.js": {
    "size": 1364,
    "sha256": "4e13b04c965e8dcc45104091a92318715af96e7f6d820faea9097a014930bc70"
  },
  "package/cjs/src/connection.js": {
    "size": 28747,
    "sha256": "ce6d375809baad79963ef9b3773e6ac757bcf6da2362d4d85482bb14c2c751be"
  },
  "package/cjs/src/errors.js": {
    "size": 1218,
    "sha256": "fad515c5d5e76e0f44e7e4408342301ec4df51517ffdbb836be9942cd48e5a99"
  },
  "package/cjs/src/index.js": {
    "size": 15475,
    "sha256": "d8fea1a5311c47e65004646bc81f57305ac64d48f99004a5b3ca27bcfc6babf8"
  },
  "package/cjs/src/large.js": {
    "size": 2152,
    "sha256": "40b498ca792f3d28b1ce8a99b931cbd9c04c2931366b9fdc93a19083e545b9ff"
  },
  "package/cjs/src/query.js": {
    "size": 3646,
    "sha256": "75ae9c69a1aaf3be4d8d65e4742c36018b89594907b85769e560c2590716c109"
  },
  "package/cjs/src/queue.js": {
    "size": 543,
    "sha256": "7d20fa53a3930be070609d7912ecd14c347df3526805bca2f6cb7eb35d2e62cf"
  },
  "package/cjs/src/result.js": {
    "size": 418,
    "sha256": "84b46a3940d3bd1fbea85e5beb5b7c652f3f1058fec2c6cc5ce351730533ee10"
  },
  "package/cjs/src/subscribe.js": {
    "size": 7638,
    "sha256": "5c6dfb4fa656f814a47749d342daa86a1dbaa9e695f43ac1c7050302c7e91fea"
  },
  "package/cjs/src/types.js": {
    "size": 11476,
    "sha256": "8ba968fc19489cdb670e8fc0d184b942eafa5f3d7a06dca4b165318fcd57e9fb"
  },
  "package/package.json": {
    "size": 1814,
    "sha256": "944d492614959389a5739ef2893bc1830fb773ff042159d9b331d43b2f6792e9"
  },
  "package/src/bytes.js": {
    "size": 1362,
    "sha256": "53b73b5ee2919ab5561229c62a4e2db578f63ca613b795b380c23cb684f2d514"
  },
  "package/src/connection.js": {
    "size": 28690,
    "sha256": "ee3a218d9aa6a6f2887c1a19da50009335fe84c11a5431d5cab72d6bc528632f"
  },
  "package/src/errors.js": {
    "size": 1155,
    "sha256": "85cfbed9a5ab0db41ab8e97b806c881af29807dfe99bc656fdf1a18c1c13b6c6"
  },
  "package/src/index.js": {
    "size": 15428,
    "sha256": "4e21f5733e70d79cffc10d10d4ef01031de4a9ac862210e43f8870029fd103ed"
  },
  "package/src/large.js": {
    "size": 2133,
    "sha256": "05ea787f79cefaf16310f14119fbfd36d2fed0795581b0df1b0e63b591a3ed94"
  },
  "package/src/query.js": {
    "size": 3600,
    "sha256": "67c45a5151032aa46b587abc15381fe4efd97c696e5c1b53082b8161309c4ee2"
  },
  "package/src/queue.js": {
    "size": 541,
    "sha256": "15e6345adb6708bf3b99ad39fc2231c2fb61de5f6cba4b7a7a6be881482a4ec3"
  },
  "package/src/result.js": {
    "size": 416,
    "sha256": "001ff5e0c8d634674f483d07fbcd620a797e3101f842d6c20ca3ace936260465"
  },
  "package/src/subscribe.js": {
    "size": 7626,
    "sha256": "5d0b1ec9705281ed4a60236fe5f65654038bae117845a71d19e35374d34c0cfa"
  },
  "package/src/types.js": {
    "size": 10935,
    "sha256": "1883bd4536eab1c94b9e708d325b13708b0f18ec80020e3a825f34a72f603b81"
  },
  "package/types/index.d.ts": {
    "size": 24766,
    "sha256": "3e9763c4afdadcdca1a4f469ffed3dcbbf5eddfc2aa04b5e588b514e4f57f9f1"
  },
  "package/types/package.json": {
    "size": 56,
    "sha256": "c96411ecdd1bdeeac8096b325a2da3777775cdfb1357046e8e12f60de96274e6"
  },
  "package/types/tsconfig.json": {
    "size": 215,
    "sha256": "6b56b1f0c7a63493b52bbcf977396dcfc5e894b668ebc827d54809b26ffd3301"
  }
});
const PATCHES = Object.freeze([
  [
    "      ? tcp.write(data, () => tcp.raw.close())",
    "      ? tcp.write(data, () => tcp.writer.close())"
  ],
  [
    "      while (({ done, value } = await tcp.reader.read(), !done))\n        tcp.emit('data', Buffer.from(value))",
    "      while (({ done, value } = await tcp.reader.read(), !done))\n        tcp.emit('data', Buffer.from(value))\n      close()"
  ],
  [
    "  async function readFirst() {\n    const { value } = await tcp.reader.read()\n    tcp.emit('data', Buffer.from(value))\n  }",
    "  async function readFirst() {\n    try {\n      const { value } = await tcp.reader.read()\n      tcp.emit('data', Buffer.from(value))\n    } catch (err) {\n      error(err)\n    }\n  }"
  ],
  [
    "  function error(err) {\n    tcp.emit('error', err)\n    tcp.emit('close')\n  }",
    "  function error(err) {\n    if (tcp.readyState === 'closed')\n      return\n\n    tcp.emit('error', err)\n    close()\n  }"
  ]
]);
const LOCAL_PATCHES = Object.freeze([
  [
    "      ? tcp.write(data, () => tcp.writer.close())",
    "      ? tcp.write(data, () => tcp.writer.close().catch(error))"
  ]
]);
const TARGET = 'package/cf/polyfills.js';
const MAX_BYTES = 2 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sri = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');

function field(header, start, width) {
  const bytes = header.subarray(start, start + width);
  const end = bytes.indexOf(0);
  assert(end < 0 || bytes.subarray(end).every(value => value === 0), 'Embedded tar field suffix');
  const value = bytes.subarray(0, end < 0 ? width : end);
  assert(value.every(byte => byte >= 32 && byte <= 126), 'Non-ASCII tar field');
  return value.toString('ascii');
}
function number(header, start, width) {
  const raw = header.subarray(start, start + width).toString('latin1');
  assert(/^[0-7 \0]+$/.test(raw), 'Invalid octal tar field');
  const value = raw.replace(/\0/g, ' ').trim();
  assert(/^[0-7]+$/.test(value), 'Invalid octal tar field');
  const parsed = Number.parseInt(value, 8);
  assert(Number.isSafeInteger(parsed) && parsed >= 0, 'Unsafe tar integer');
  return parsed;
}
function unpack(bytes) {
  assert(bytes.length <= MAX_BYTES, 'Archive input exceeds budget');
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_BYTES });
  assert(tar.length % 512 === 0, 'Truncated tar blocks');
  const files = new Map();
  let offset = 0, terminated = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) {
      assert(tar.length - offset >= 1024 && tar.subarray(offset).every(value => value === 0), 'Invalid tar terminator');
      terminated = true;
      break;
    }
    assert(header[156] === 48, 'Only regular tar files are accepted');
    assert(header.subarray(257, 263).equals(Buffer.from('ustar\0')), 'Expected USTAR header');
    assert(header.subarray(345, 500).every(value => value === 0), 'Tar prefixes are not accepted');
    assert(header.subarray(157, 257).every(value => value === 0), 'Tar links are not accepted');
    const name = field(header, 0, 100), size = number(header, 124, 12);
    assert(Object.hasOwn(SOURCE_FILES, name) && !files.has(name), 'Unexpected or duplicate tar path: ' + name);
    assert(number(header, 100, 8) === 0o644, 'Unexpected file mode: ' + name);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    assert(sum === number(header, 148, 8), 'Invalid tar checksum');
    const begin = offset + 512, end = begin + size, next = begin + Math.ceil(size / 512) * 512;
    assert(size <= MAX_BYTES && next <= tar.length, 'Invalid tar size');
    assert(tar.subarray(end, next).every(value => value === 0), 'Nonzero tar padding');
    files.set(name, Buffer.from(tar.subarray(begin, end)));
    offset = next;
  }
  assert(terminated, 'Missing tar terminator');
  assert.deepEqual([...files.keys()].sort(), Object.keys(SOURCE_FILES).sort(), 'Complete source file set differs');
  return files;
}
function octal(value, width) {
  const encoded = value.toString(8).padStart(width - 1, '0') + '\0';
  assert(encoded.length === width, 'Tar integer overflow');
  return Buffer.from(encoded, 'ascii');
}
function pack(files) {
  const blocks = [];
  for (const name of [...files.keys()].sort()) {
    const bytes = files.get(name), path = Buffer.from(name, 'ascii'), header = Buffer.alloc(512);
    assert(path.length <= 100 && /^[\x20-\x7e]+$/.test(name), 'Noncanonical tar path');
    path.copy(header);
    for (const [start, width, value] of [[100,8,0o644],[108,8,0],[116,8,0],[124,12,bytes.length],[136,12,0],[329,8,0],[337,8,0]])
      octal(value, width).copy(header, start);
    header.fill(32, 148, 156);
    header[156] = 48;
    Buffer.from('ustar\0').copy(header, 257);
    Buffer.from('00').copy(header, 263);
    const checksum = header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ';
    assert(checksum.length === 8, 'Tar checksum overflow');
    Buffer.from(checksum, 'ascii').copy(header, 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Canonical gzip uses stored DEFLATE blocks. Its bytes do not depend on a
 * compressor/zlib version: fixed header, no filename/time, fixed block sizes. */
function gzip(bytes) {
  const blocks = [Buffer.from([31,139,8,0,0,0,0,0,0,255])];
  for (let offset = 0; offset < bytes.length; offset += 65535) {
    const chunk = bytes.subarray(offset, offset + 65535), header = Buffer.alloc(5);
    header[0] = offset + chunk.length === bytes.length ? 1 : 0;
    header.writeUInt16LE(chunk.length, 1);
    header.writeUInt16LE(chunk.length ^ 65535, 3);
    blocks.push(header, chunk);
  }
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(crc32(bytes), 0);
  footer.writeUInt32LE(bytes.length >>> 0, 4);
  blocks.push(footer);
  return Buffer.concat(blocks);
}
/** Verify canonical derived bytes without filesystem access or installation. */
export function verifyPostgresCfCloseBackportArchive(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length <= MAX_BYTES, 'Expected bounded derived archive bytes');
  assert.equal(sri(bytes), POSTGRES_CF_CLOSE_BACKPORT.derivedSri, 'Derived archive SRI differs');
  assert.equal(sha256(bytes), POSTGRES_CF_CLOSE_BACKPORT.derivedSha256, 'Derived archive SHA256 differs');
  const files = unpack(bytes);
  for (const [name, file] of files) {
    if (name === TARGET) {
      assert.equal(sha256(file), POSTGRES_CF_CLOSE_BACKPORT.derivedPolyfillsSha256, 'Derived polyfills SHA256 differs');
    } else {
      assert.equal(file.length, SOURCE_FILES[name].size, 'Non-target file size differs: ' + name);
      assert.equal(sha256(file), SOURCE_FILES[name].sha256, 'Non-target file SHA256 differs: ' + name);
    }
  }
  return files;
}

export function buildPostgresCfCloseBackport(source) {
  assert(Buffer.isBuffer(source) && source.length <= MAX_BYTES, 'Expected bounded source archive bytes');
  assert.equal(sri(source), POSTGRES_CF_CLOSE_BACKPORT.sourceSri, 'Official postgres@3.4.9 SRI mismatch');
  assert.equal(sha256(source), POSTGRES_CF_CLOSE_BACKPORT.sourceSha256, 'Official source SHA256 mismatch');
  const original = unpack(source);
  for (const [name, bytes] of original) {
    assert.equal(bytes.length, SOURCE_FILES[name].size, 'Source size differs: ' + name);
    assert.equal(sha256(bytes), SOURCE_FILES[name].sha256, 'Source file SHA256 differs: ' + name);
  }
  assert.equal(sha256(original.get(TARGET)), POSTGRES_CF_CLOSE_BACKPORT.originalPolyfillsSha256);
  let text = original.get(TARGET).toString('utf8');
  for (const [before, after] of PATCHES) {
    assert.equal(text.split(before).length - 1, 1, 'Expected one exact upstream patch target');
    text = text.replace(before, () => after);
  }
  const upstream = Buffer.from(text);
  assert.equal(sha256(upstream), POSTGRES_CF_CLOSE_BACKPORT.upstreamPolyfillsSha256, 'Upstream-only polyfills SHA256 differs');
  const blob = Buffer.concat([Buffer.from('blob ' + upstream.length + '\0'), upstream]);
  assert.equal(createHash('sha1').update(blob).digest('hex'), POSTGRES_CF_CLOSE_BACKPORT.upstreamFileGitBlob, 'Upstream-only result differs from exact PR head file');
  // Sole local supplement: a rejected half-close must use the existing active
  // error channel, rather than an unobserved callback-returned Promise.
  for (const [before, after] of LOCAL_PATCHES) {
    assert.equal(text.split(before).length - 1, 1, 'Expected one exact local patch target');
    text = text.replace(before, () => after);
  }
  const files = new Map(original);
  files.set(TARGET, Buffer.from(text));
  assert.equal(sha256(files.get(TARGET)), POSTGRES_CF_CLOSE_BACKPORT.derivedPolyfillsSha256, 'Backported polyfills SHA256 differs');
  const output = gzip(pack(files)), unpacked = verifyPostgresCfCloseBackportArchive(output);
  for (const [name, bytes] of unpacked) {
    assert(bytes.equals(files.get(name)), 'Repacked file differs: ' + name);
    if (name !== TARGET) assert(bytes.equals(original.get(name)), 'Non-target source bytes changed: ' + name);
  }
  assert.equal(sri(output), POSTGRES_CF_CLOSE_BACKPORT.derivedSri, 'Canonical derived SRI differs');
  assert.equal(sha256(output), POSTGRES_CF_CLOSE_BACKPORT.derivedSha256, 'Canonical derived SHA256 differs');
  return output;
}
function main() {
  const [source, outputArgument, ...extra] = process.argv.slice(2);
  assert(source && isAbsolute(source) && extra.length === 0,
    'Usage: node scripts/build-postgres-cf-close-backport.mjs /absolute/postgres-3.4.9.tgz [/absolute/output.tgz]');
  assert(!outputArgument || isAbsolute(outputArgument), 'Output path must be absolute');
  const vendor = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor');
  const output = outputArgument ?? resolve(vendor, 'postgres-3.4.9-cf-close.tgz');
  assert(resolve(source) !== resolve(output), 'Original source archive must never be overwritten');
  const patch = readFileSync(resolve(vendor, 'postgres-3.4.9-cf-close.patch'));
  assert.equal(sha256(patch), POSTGRES_CF_CLOSE_BACKPORT.patchSha256, 'Reviewed patch file differs');
  const bytes = buildPostgresCfCloseBackport(readFileSync(source));
  const temporary = output + '.' + process.pid + '.' + randomBytes(8).toString('hex') + '.tmp';
  let ownedTemporary = false;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o644 }); ownedTemporary = true;
    renameSync(temporary, output); ownedTemporary = false;
  } finally { if (ownedTemporary) unlinkSync(temporary); }
  console.log(JSON.stringify({ output, files: Object.keys(SOURCE_FILES).length, changed: TARGET,
    sourceSri: POSTGRES_CF_CLOSE_BACKPORT.sourceSri, derivedSri: sri(bytes), sha256: sha256(bytes) }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
