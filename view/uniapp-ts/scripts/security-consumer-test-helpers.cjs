'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module'), assert = require('node:assert/strict');
const { sha256 } = require('./security-archive-tools.cjs');
const project = path.resolve(__dirname, '..');
const installRoot = fs.realpathSync(process.env.CINASHOP_SECURITY_INSTALL_ROOT || project);
const modules = fs.realpathSync(path.join(installRoot, 'node_modules'));
const under = (base, name) => name === base || name.startsWith(base + path.sep);
function confined(name) {
  const real = fs.realpathSync(name); assert.ok(under(modules, real), 'consumer escaped actual install: ' + name); return real;
}
function from(owner) {
  const pkg = confined(path.join(modules, owner, 'package.json'));
  assert.equal(JSON.parse(fs.readFileSync(pkg)).name, owner); return Module.createRequire(pkg);
}
function packageDir(entry) {
  let dir = path.dirname(confined(entry));
  while (under(modules, dir)) { if (fs.existsSync(path.join(dir, 'package.json'))) return dir; dir = path.dirname(dir); }
  throw Error('Package metadata missing');
}
function verifyInstalled(dir, entries) {
  const expected = new Map(entries.map(e => [e.name, e])); const names = [];
  function walk(p, rel = '') {
    for (const d of fs.readdirSync(p, { withFileTypes: true })) {
      if (!rel && d.name === 'node_modules') continue;
      const name = rel ? rel + '/' + d.name : d.name, file = path.join(p, d.name);
      assert.ok(!d.isSymbolicLink(), 'installed source symlink forbidden');
      if (d.isDirectory()) walk(file, name); else { assert.ok(d.isFile()); names.push(name); }
    }
  }
  walk(dir); assert.deepEqual(names.sort(), [...expected.keys()].sort(), 'complete installed package file set');
  const value = process.env.CINASHOP_SECURITY_INSTALL_UMASK;
  assert.ok(value === undefined || /^[0-7]{1,3}$/.test(value), 'explicit install umask must be octal');
  const mask = value === undefined ? process.umask() : Number.parseInt(value, 8);
  for (const [name, e] of expected) {
    const p = path.join(dir, name), bytes = fs.readFileSync(p);
    assert.equal(bytes.length, e.bytes.length, name); assert.equal(sha256(bytes), sha256(e.bytes), name);
    assert.equal(fs.statSync(p).mode & 0o777, e.mode & ~mask, 'tar_mode & ~installer_umask: ' + name);
  }
}
function writePackage(dir, entries) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const e of entries) { const p = path.join(dir, e.name); fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 }); fs.writeFileSync(p, e.bytes, { flag: 'wx', mode: 0o600 }); }
}
function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), 'cinashop-' + prefix + '-')); }
function denyNetwork() {
  const fail = () => { throw Error('Network/listen forbidden by finite security consumer regression'); };
  for (const n of ['node:http', 'node:https']) { const x = require(n); x.request = x.get = fail; }
  const net = require('node:net'); net.connect = net.createConnection = net.Server.prototype.listen = fail;
  require('node:dgram').createSocket = fail; globalThis.fetch = fail;
}
module.exports = { project, installRoot, modules, under, confined, from, packageDir, verifyInstalled, writePackage, temp, denyNetwork };
