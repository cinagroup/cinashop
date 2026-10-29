'use strict';
// Bounded, extract-free archive support for the two pinned security source contracts.
// The USTAR/gzip writer intentionally matches the existing Python source archives.
const crypto = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const LIMIT = 16 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
function fail(message) { throw new Error(message); }
function replaceOnce(text, before, after, label) {
  if (!before || text.split(before).length !== 2) fail('Source drift or repeated patch: ' + label);
  return text.replace(before, after);
}
function textField(header, offset, size) {
  const field = header.subarray(offset, offset + size), end = field.indexOf(0);
  if (end >= 0 && !field.subarray(end).every(byte => byte === 0)) fail('Nonzero tar string suffix');
  const bytes = end < 0 ? field : field.subarray(0, end);
  if (bytes.some(byte => byte > 127)) fail('Non-ASCII tar field');
  return bytes.toString('ascii');
}
function octal(header, offset, size, allowEmpty = false) {
  const bytes = header.subarray(offset, offset + size);
  if (bytes.some(byte => byte > 127)) fail('Unsupported binary tar numeric field');
  const field = bytes.toString('ascii'), at = field.indexOf('\0');
  if (at >= 0 && !/^[\0 ]*$/.test(field.slice(at))) fail('Invalid tar numeric suffix');
  const text = (at < 0 ? field : field.slice(0, at)).trim();
  if (!text) { if (allowEmpty) return 0; fail('Missing tar numeric field'); }
  if (!/^[0-7]+$/.test(text)) fail('Invalid tar numeric field');
  const number = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(number) || number < 0) fail('Unsafe tar numeric value');
  return number;
}
function safeName(name) {
  if (!name || !/^[A-Za-z0-9_./-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') || Buffer.byteLength('package/' + name) >= 100) fail('Unsafe tar path');
}
function readArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMIT) fail('Invalid archive size');
  const tar = gunzipSync(bytes, { maxOutputLength: LIMIT });
  if (tar.length % 512) fail('Truncated tar');
  const entries = [], seen = new Set(); let offset = 0, terminated = false;
  while (offset + 512 <= tar.length) {
    const header = Buffer.from(tar.subarray(offset, offset + 512));
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every(byte => byte === 0)) fail('Invalid tar terminator');
      terminated = true; break;
    }
    const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (octal(header, 148, 8) !== actual) fail('Invalid tar checksum');
    if (!header.subarray(257, 265).equals(Buffer.from('ustar\0' + '00', 'ascii'))) fail('Unsupported tar format');
    const path = textField(header, 0, 100);
    if (!path.startsWith('package/')) fail('Unsafe tar prefix');
    const name = path.slice(8); safeName(name);
    if (textField(header, 345, 155) || seen.has(name)) fail('Duplicate or prefixed tar path');
    seen.add(name);
    if (header[156] !== 48 || !header.subarray(157, 257).every(byte => byte === 0)) fail('Non-regular or linked tar entry');
    const mode = octal(header, 100, 8), uid = octal(header, 108, 8, true), gid = octal(header, 116, 8, true);
    const mtime = octal(header, 136, 12), uname = textField(header, 265, 32), gname = textField(header, 297, 32);
    if (mode !== 0o644 || uid !== 0 || gid !== 0 || uname || gname || octal(header, 329, 8, true) || octal(header, 337, 8, true) || !header.subarray(500).every(byte => byte === 0)) fail('Unexpected tar mode/ownership/device fields');
    const size = octal(header, 124, 12), end = offset + 512 + size, paddedEnd = offset + 512 + Math.ceil(size / 512) * 512;
    if (end > tar.length || paddedEnd > tar.length || !tar.subarray(end, paddedEnd).every(byte => byte === 0)) fail('Invalid tar payload');
    entries.push({ name, mode, uid, gid, mtime, uname, gname, header, bytes: Buffer.from(tar.subarray(offset + 512, end)) });
    if (entries.length > 64) fail('Unexpected archive file count');
    offset = paddedEnd;
  }
  if (!terminated || !entries.length) fail('Unexpected archive file set');
  return entries;
}
function canonicalHeader(entry) {
  safeName(entry.name);
  if (entry.mode !== 0o644 || !Buffer.isBuffer(entry.bytes)) fail('Unexpected canonical entry');
  const h = Buffer.alloc(512), field = (value, at, size) => {
    const text = value.toString(8).padStart(size - 1, '0') + '\0';
    if (text.length !== size) fail('Canonical tar value overflow');
    h.write(text, at, size, 'ascii');
  };
  h.write('package/' + entry.name, 0, 100, 'ascii');
  field(entry.mode, 100, 8); field(0, 108, 8); field(0, 116, 8);
  field(entry.bytes.length, 124, 12); field(0, 136, 12);
  h.fill(32, 148, 156); h[156] = 48; h.write('ustar\0' + '00', 257, 8, 'ascii');
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}
function deterministicGzip(tar) {
  if (!Buffer.isBuffer(tar) || !tar.length || tar.length > LIMIT) fail('Invalid canonical tar size');
  let crc = 0xffffffff;
  for (const byte of tar) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const chunks = [Buffer.from([31,139,8,0,0,0,0,0,0,255])];
  for (let at = 0; at < tar.length; at += 65535) {
    const count = Math.min(65535, tar.length - at), h = Buffer.alloc(5);
    h[0] = at + count === tar.length ? 1 : 0; h.writeUInt16LE(count, 1); h.writeUInt16LE(count ^ 0xffff, 3);
    chunks.push(h, tar.subarray(at, at + count));
  }
  const footer = Buffer.alloc(8); footer.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 0); footer.writeUInt32LE(tar.length >>> 0, 4);
  return Buffer.concat([...chunks, footer]);
}
function writeArchive(entries) {
  const chunks = [], seen = new Set(); let length = 0;
  for (const entry of entries.slice().sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (seen.has(entry.name)) fail('Duplicate canonical path'); seen.add(entry.name);
    const h = canonicalHeader(entry), padding = Buffer.alloc((512 - entry.bytes.length % 512) % 512);
    length += 512 + entry.bytes.length + padding.length;
    if (length > LIMIT - 1024) fail('Canonical tar too large');
    chunks.push(h, entry.bytes, padding);
  }
  if (!entries.length || entries.length > 64) fail('Unexpected canonical file count');
  const tail = 1024 + (10240 - (length + 1024) % 10240) % 10240;
  return deterministicGzip(Buffer.concat([...chunks, Buffer.alloc(tail)]));
}
function assertFiles(entries, record, rawHeaders = true) {
  if (entries.length !== record.fileCount || record.files.length !== record.fileCount) fail('Unexpected complete file set');
  const expected = new Map(record.files.map(row => [row.name, row]));
  if (expected.size !== entries.length || new Set(entries.map(row => row.name)).size !== entries.length) fail('Duplicate contract/source path');
  for (const entry of entries) {
    const row = expected.get(entry.name);
    if (!row || entry.mode !== row.mode || entry.bytes.length !== row.bytes || sha256(entry.bytes) !== row.sha256 || sha256(canonicalHeader(entry)) !== row.canonicalHeaderSha256) fail('Source file or mode changed: ' + entry.name);
    if (rawHeaders && (sha256(entry.header) !== row.sourceHeaderSha256 || entry.uid !== row.uid || entry.gid !== row.gid || entry.mtime !== row.mtime || entry.uname !== row.uname || entry.gname !== row.gname)) fail('Source header/ownership changed: ' + entry.name);
  }
}
function assertArchive(bytes, record) {
  if (sha256(bytes) !== record.sha256 || integrity(bytes) !== record.integrity) fail('Unexpected official archive SHA/SRI');
  const entries = readArchive(bytes); assertFiles(entries, record); return entries;
}
module.exports = { LIMIT, sha256, integrity, replaceOnce, readArchive, canonicalHeader, deterministicGzip, writeArchive, assertFiles, assertArchive };
