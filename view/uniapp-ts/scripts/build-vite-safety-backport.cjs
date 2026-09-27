// Exact, offline derivation from the official Vite 5.4.21 npm archive.
// No extract/install step and no dependency on a platform tar/gzip executable.
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { gunzipSync } = require('node:zlib');

const SOURCE = Object.freeze({
  name: 'vite', version: '5.4.21',
  url: 'https://registry.npmjs.org/vite/-/vite-5.4.21.tgz',
  integrity: 'sha512-o5a9xKjbtuhY6Bi5S3+HvbRERmouabWbyUcpXXUA1u+GNUKoROi9byOJ8M0nHbHYHkYICiMlqxkg1KkYmm25Sw=='
});
const ESBUILD = Object.freeze({ version: '0.28.2',
  url: 'https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz',
  integrity: 'sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA==' });
const CHUNK = 'dist/node/chunks/dep-BK3b2jBa.js';
const PATCHES = Object.freeze([
  {
    advisory: 'GHSA-4w7w-66w2-5vf9',
    commit: 'ca4da5d1fb45c9cfdce606aa30825095791b164b',
    before: '          const sourcemapPath = url.startsWith(FS_PREFIX) ? fsPathFromId(url) : normalizePath$3(path$n.resolve(server.config.root, url.slice(1)));\n          try {',
    after: '          const sourcemapPath = url.startsWith(FS_PREFIX) ? fsPathFromId(url) : normalizePath$3(path$n.resolve(server.config.root, url.slice(1)));\n          // Backport: resolved maps must remain inside the optimized deps directory.\n          if (!depsOptimizer.isOptimizedDepFile(sourcemapPath)) {\n            return next();\n          }\n          try {'
  },
  {
    advisory: 'GHSA-v6wh-96g9-6wx3',
    commit: '8fed5cf540c0d475266787f52072f258478cd42f',
    before: '  const { lineNumber, columnNumber } = parsed;\n\n  if (!fs$4.existsSync(fileName)) {',
    after: String.raw`  const { lineNumber, columnNumber } = parsed;

  // Backport launch-editor 2.14.1: reject UNC paths before any filesystem probe.
  if (process.platform === 'win32' && path$5.resolve(fileName).startsWith('\\')) {
    return wrapErrorCallback(typeof specifiedEditor === 'function' ? specifiedEditor : onErrorCallback)(
      fileName,
      'UNC paths are not supported on Windows to avoid security issues. ' +
        'See https://github.com/vitejs/launch-editor/tree/main/packages/launch-editor#unc-paths-on-windows for details.'
    )
  }

  if (!fs$4.existsSync(fileName)) {`
  },
  {
    advisory: 'GHSA-fx2h-pf6j-xcff',
    commit: '96b0c10162e9c55485d922db2cfc6b8227cbc176',
    before: 'function isFileLoadingAllowed(server, filePath) {\n  const { fs } = server.config.server;\n  if (!fs.strict) return true;\n',
    after: 'function isFileLoadingAllowed(server, filePath) {\n  const { fs } = server.config.server;\n  if (!fs.strict) return true;\n  // Backport: reject Windows 8.3 aliases and colon aliases before allow/deny checks.\n  if (isWindows && filePath.includes("~")) return false;\n  const hasDriveLetter = isWindows && /^[A-Z]:/i.test(filePath);\n  const hasColon = (hasDriveLetter ? filePath.slice(2) : filePath).includes(":");\n  if (hasColon) return false;\n'
  },
  {
    compatibility: 'Vite PR #22346 target detection',
    commit: '5ab51c0f76f0896175e02ad797c1f5fe116d02f4',
    before: 'function resolveEsbuildTranspileOptions(config, format) {',
    after: String.raw`const destructuringBugRE = /^(safari|ios)(\d+)(?:\.(\d+))?$/;

// Workaround for https://github.com/evanw/esbuild/issues/4436
// Safari 10 through 14.0.x and ios 10 through 14.4 have a bug related to destructuring.
// So esbuild 0.27.7+ treats those browsers as not supporting destructuring.
// However, because esbuild does not support lowering destructuring, it errors when it encounters it.
// Since it was not lowered in old Vite versions, we set destructuring: true to revert to the old behavior.
// This means the end users using those Safari versions will encounter the bug,
// but at least it won't cause a complete build failure.
// If the user wants to avoid that, they can use Vite v8 + plugin-legacy.
function needsDestructuringSupportedWorkaround(target) {
  if (!target) return false;
  const targets = Array.isArray(target) ? target : [target];
  for (const t of targets) {
    const match = destructuringBugRE.exec(t);
    if (!match) continue;
    const major = Number(match[2]);
    if (major < 10) continue;
    if (major < 14) return true;
    if (major > 14) continue;
    const minor = match[3] ? Number(match[3]) : 0;
    const requiredMinor = match[1] === 'safari' ? 1 : 5;
    if (minor < requiredMinor) return true;
  }
  return false;
}

function resolveEsbuildTranspileOptions(config, format) {`
  },
  {
    compatibility: 'Vite PR #22346 supported-feature merge',
    commit: '5ab51c0f76f0896175e02ad797c1f5fe116d02f4',
    before: '    format: rollupToEsbuildFormatMap[format],\n    supported: {\n      ...defaultEsbuildSupported,\n      ...esbuildOptions.supported\n    }',
    after: '    format: rollupToEsbuildFormatMap[format],\n    supported: {\n      ...defaultEsbuildSupported,\n      ...(needsDestructuringSupportedWorkaround(target) ? { destructuring: true } : null),\n      ...esbuildOptions.supported\n    }'
  }
]);
const patchLabel = (patch) => patch.advisory || patch.compatibility;
const META = Object.freeze({
  format: 1, source: SOURCE, esbuild: ESBUILD,
  patches: PATCHES.map(({ advisory, compatibility, commit }) => advisory ? { advisory, commit } : { compatibility, commit }),
  launchEditorAdaptation: 'Use the existing optional-callback/overload wrapper before existsSync; preserve normal local-path behavior.',
  support: 'Project-maintained backport; Vite 5 is outside upstream security support.'
});
const CONTRACT_PATH = resolve(__dirname, '../vendor/vite-5.4.21-source.json');
const OUTPUT_PATH = resolve(__dirname, '../vendor/vite-5.4.21-safety-backport.tgz');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
function replaceOnce(text, before, after, label) {
  if (text.split(before).length !== 2) throw new Error(`Source drift or repeated patch: ${label}`);
  return text.replace(before, after);
}
function octal(header, offset, length, label) {
  const value = header.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(value)) throw new Error(`Invalid tar ${label}`);
  return parseInt(value, 8);
}
function readArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024) throw new Error('Invalid archive size');
  const tar = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
  if (tar.length % 512) throw new Error('Truncated tar');
  const entries = [], seen = new Set();
  let offset = 0, terminated = false;
  while (offset + 512 <= tar.length) {
    const header = Buffer.from(tar.subarray(offset, offset + 512));
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every((byte) => byte === 0)) throw new Error('Invalid tar terminator');
      terminated = true;
      break;
    }
    const recorded = octal(header, 148, 8, 'checksum');
    const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (recorded !== actual) throw new Error('Invalid tar checksum');
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix || !rawName.startsWith('package/') || /\\/.test(rawName) || rawName.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Unsafe tar path');
    const name = rawName.slice(8);
    if (seen.has(name)) throw new Error('Duplicate tar path');
    seen.add(name);
    if (header[156] !== 0 && header[156] !== 48) throw new Error('Non-regular tar entry');
    if (!header.subarray(157, 257).every((byte) => byte === 0)) throw new Error('Tar link is forbidden');
    const size = octal(header, 124, 12, 'size'), mode = octal(header, 100, 8, 'mode');
    const end = offset + 512 + size, paddedEnd = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || paddedEnd > tar.length || !tar.subarray(end, paddedEnd).every((byte) => byte === 0)) throw new Error('Invalid tar payload');
    entries.push({ name, mode, header, bytes: Buffer.from(tar.subarray(offset + 512, end)) });
    offset = paddedEnd;
  }
  if (!terminated || entries.length !== 31) throw new Error('Unexpected Vite file set');
  return entries;
}
function assertContract(entries, contract) {
  if (JSON.stringify(contract.source) !== JSON.stringify(SOURCE) || contract.files.length !== 31) throw new Error('Unexpected source contract');
  const expected = new Map(contract.files.map((file) => [file.name, file]));
  if (expected.size !== 31 || entries.length !== 31) throw new Error('Unexpected file set');
  for (const entry of entries) {
    const file = expected.get(entry.name);
    if (!file || entry.mode !== file.mode || entry.bytes.length !== file.size || sha256(entry.bytes) !== file.sha256 || sha256(headerFor(entry)) !== file.headerSha256) throw new Error(`Source file changed: ${entry.name}`);
  }
}
function patchManifest(original) {
  const parsed = JSON.parse(original);
  if (parsed.name !== SOURCE.name || parsed.version !== SOURCE.version || parsed.dependencies?.esbuild !== '^0.21.3' || Object.hasOwn(parsed, 'cinashopSecurityBackport')) throw new Error('Unexpected upstream manifest');
  const dependency = replaceOnce(original, '"esbuild": "^0.21.3"', `"esbuild": "${ESBUILD.version}"`, 'esbuild manifest');
  if (!dependency.endsWith('\n}')) throw new Error('Manifest terminator drift');
  return dependency.slice(0, -2) + ',\n  "cinashopSecurityBackport": ' + JSON.stringify(META, null, 2).replace(/\n/g, '\n  ') + '\n}';
}
function patchEntries(entries) {
  return entries.map((entry) => {
    let bytes = entry.bytes;
    if (entry.name === CHUNK) {
      let text = bytes.toString('utf8');
      for (const patch of PATCHES) text = replaceOnce(text, patch.before, patch.after, patchLabel(patch));
      bytes = Buffer.from(text);
    } else if (entry.name === 'package.json') bytes = Buffer.from(patchManifest(bytes.toString('utf8')));
    return { ...entry, bytes };
  });
}
// Stored DEFLATE blocks make the gzip bytes independent of zlib version/OS.
function deterministicGzip(tar) {
  let crc = 0xffffffff;
  for (const byte of tar) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const blocks = [Buffer.from([31, 139, 8, 0, 0, 0, 0, 0, 0, 255])];
  for (let offset = 0; offset < tar.length; offset += 65535) {
    const size = Math.min(65535, tar.length - offset), header = Buffer.alloc(5);
    header[0] = offset + size === tar.length ? 1 : 0;
    header.writeUInt16LE(size, 1); header.writeUInt16LE(size ^ 0xffff, 3);
    blocks.push(header, tar.subarray(offset, offset + size));
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 0); trailer.writeUInt32LE(tar.length >>> 0, 4);
  return Buffer.concat([...blocks, trailer]);
}
function headerFor(entry) {
  const header = Buffer.from(entry.header);
  header.write(entry.bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}
function writeArchive(entries) {
  const chunks = [];
  for (const entry of entries) chunks.push(headerFor(entry), entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
  return deterministicGzip(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function buildArchive(source, contract) {
  if (integrity(source) !== SOURCE.integrity) throw new Error('Unexpected official Vite archive integrity');
  const entries = readArchive(source);
  assertContract(entries, contract);
  const archive = writeArchive(patchEntries(entries));
  verifyDerived(archive, contract);
  return archive;
}
function verifyDerived(archive, contract) {
  const entries = readArchive(archive);
  const original = entries.map((entry) => {
    let text = entry.bytes.toString('utf8');
    if (entry.name === CHUNK) for (const patch of PATCHES.slice().reverse()) text = replaceOnce(text, patch.after, patch.before, `reverse ${patchLabel(patch)}`);
    else if (entry.name === 'package.json') {
      const marker = ',\n  "cinashopSecurityBackport": ' + JSON.stringify(META, null, 2).replace(/\n/g, '\n  ') + '\n}';
      if (!text.endsWith(marker) || text.split(marker).length !== 2) throw new Error('Derived metadata changed');
      text = replaceOnce(text.slice(0, -marker.length) + '\n}', `"esbuild": "${ESBUILD.version}"`, '"esbuild": "^0.21.3"', 'reverse manifest');
    } else return entry;
    return { ...entry, bytes: Buffer.from(text) };
  });
  assertContract(original, contract);
  if (!archive.equals(writeArchive(patchEntries(original)))) throw new Error('Non-canonical derived archive');
  return { fileCount: entries.length, changedFiles: ['package.json', CHUNK], integrity: integrity(archive) };
}
module.exports = { SOURCE, ESBUILD, META, PATCHES, CHUNK, CONTRACT_PATH, OUTPUT_PATH, integrity, sha256, headerFor, readArchive, writeArchive, replaceOnce, assertContract, patchEntries, buildArchive, verifyDerived };
if (require.main === module) {
  const archivePath = process.argv[2] && resolve(process.argv[2]);
  if (!archivePath) throw new Error('Usage: node scripts/build-vite-safety-backport.cjs <official-vite-5.4.21.tgz>');
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
  const archive = buildArchive(readFileSync(archivePath), contract);
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, archive);
  process.stdout.write(JSON.stringify({ sourceIntegrity: SOURCE.integrity, ...verifyDerived(archive, contract), bytes: archive.length, output: OUTPUT_PATH }) + '\n');
}
