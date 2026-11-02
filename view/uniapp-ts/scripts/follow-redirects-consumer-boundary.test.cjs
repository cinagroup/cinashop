'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const H = require('./security-consumer-test-helpers.cjs');
const { sha256, replaceOnce } = require('./security-archive-tools.cjs');

const receiptBytes = fs.readFileSync(path.join(H.project, 'vendor/follow-redirects-official-source-20261101.json'));
assert.equal(sha256(receiptBytes), 'dab79dc6ebfccff6eefe88ba577489a6715fe7e36bf3ad3b65f839dad307a9e6');
const receipt = JSON.parse(receiptBytes);
const fromPhin = Module.createRequire(H.confined(H.from('load-bmfont').resolve('phin/package.json')));
const centraEntry = H.confined(fromPhin.resolve('centra'));
const fromCentra = Module.createRequire(centraEntry);
const entry = H.confined(fromCentra.resolve('follow-redirects'));
const dir = path.dirname(entry);
const fixed = fromCentra('follow-redirects');

test('actual load-bmfont/phin/Centra resolves the complete official follow-redirects1.16.2 package', () => {
  assert.equal(fromPhin('./package.json').version, '3.7.1');
  assert.equal(fromCentra('./package.json').version, '2.7.0');
  const files = receipt.packages['1.16.2'].files;
  assert.deepEqual(fs.readdirSync(dir).sort(), files.map(row => row.path).sort());
  for (const row of files) {
    const bytes = fs.readFileSync(path.join(dir, row.path));
    assert.equal(bytes.length, row.size, row.path);
    assert.equal(sha256(bytes), row.sha256, row.path);
    assert.ok(fs.statSync(path.join(dir, row.path)).isFile());
  }
  const lock = JSON.parse(fs.readFileSync(path.join(H.installRoot, 'package-lock.json')));
  const nodes = Object.entries(lock.packages).filter(([name]) => name.endsWith('/follow-redirects'));
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0][0], 'node_modules/follow-redirects');
  assert.equal(nodes[0][1].version, '1.16.2');
  assert.equal(nodes[0][1].integrity, receipt.packages['1.16.2'].integrity);
  assert.equal(nodes[0][1].resolved, receipt.packages['1.16.2'].tarball);
});

function originalControl() {
  // Reverse only the two official fix fragments, then verify the complete
  // result against the independently downloaded official1.16.1 payload.
  let source = fs.readFileSync(entry, 'utf8');
  source = replaceOnce(source, 'if (!Array.isArray(options.sensitiveHeaders)) {',
    'if (!isArray(options.sensitiveHeaders)) {', 'original array check');
  source = replaceOnce(source, 'function isString(value) {',
    'function isArray(value) {\n  return value instanceof Array;\n}\n\nfunction isString(value) {', 'original helper');
  assert.equal(sha256(Buffer.from(source)), receipt.packages['1.16.1'].files.find(row => row.path === 'index.js').sha256);
  for (const file of ['debug.js', 'http.js', 'https.js']) {
    const old = receipt.packages['1.16.1'].files.find(row => row.path === file);
    assert.equal(sha256(fs.readFileSync(path.join(dir, file))), old.sha256, file);
  }
  const filename = path.join(dir, 'verified-original-control.cjs');
  const control = new Module(filename, module);
  control.filename = filename;
  control.paths = Module._nodeModulePaths(dir);
  control._compile(source, filename);
  return control.exports;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function readHeaders(client, port, route, headers, sensitiveHeaders) {
  return new Promise((resolve, reject) => {
    const req = client.http.get({ hostname: '127.0.0.1', port, path: route,
      headers, sensitiveHeaders, maxRedirects: 2 }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    });
    req.setTimeout(3000, () => req.destroy(new Error('loopback fixture timed out')));
    req.on('error', reject);
  });
}

test('official repair prevents cross-realm credential forwarding and preserves ordinary redirects through real Centra', { timeout: 15000 }, async () => {
  const old = originalControl();
  const echo = (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.headers)); };
  const target = http.createServer(echo);
  const targetPort = await listen(target);
  const source = http.createServer((req, res) => {
    if (req.url === '/done') return echo(req, res);
    res.writeHead(302, { Location: req.url === '/same' ? '/done' : `http://127.0.0.1:${targetPort}/done` });
    res.end();
  });
  try {
    const sourcePort = await listen(source);
    const custom = () => vm.runInNewContext("['X-API-Key']");
    assert.equal(Array.isArray(custom()), true);
    assert.equal(custom() instanceof Array, false);
    const values = { 'X-API-Key': 'synthetic-custom-secret', Authorization: 'synthetic-built-in',
      'Proxy-Authorization': 'synthetic-proxy', Cookie: 'synthetic-cookie', 'X-Harmless': 'retained' };
    for (const form of ['object', 'array']) {
      const headers = () => form === 'object' ? { ...values } : Object.entries(values).flat();
      const leaked = await readHeaders(old, sourcePort, '/cross', headers(), custom());
      assert.equal(leaked['x-api-key'], values['X-API-Key'], 'verified original cross-realm bypass: ' + form);
      const sameRealm = await readHeaders(old, sourcePort, '/cross', headers(), ['X-API-Key']);
      assert.equal(sameRealm['x-api-key'], undefined);
      const repaired = await readHeaders(fixed, sourcePort, '/cross', headers(), custom());
      for (const result of [leaked, sameRealm, repaired]) {
        for (const key of ['authorization', 'proxy-authorization', 'cookie']) assert.equal(result[key], undefined, key);
        assert.equal(result['x-harmless'], 'retained');
      }
      assert.equal(repaired['x-api-key'], undefined, form);
      const local = await readHeaders(fixed, sourcePort, '/same', headers(), custom());
      assert.equal(local['x-api-key'], values['X-API-Key']);
      assert.equal(local.authorization, values.Authorization);
    }
    const response = await fromPhin('centra')(`http://127.0.0.1:${sourcePort}/cross`)
      .followRedirects(2).header(values).option('sensitiveHeaders', custom()).timeout(3000).send();
    assert.equal(response.statusCode, 200);
    const headers = await response.json();
    assert.equal(headers['x-api-key'], undefined);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-harmless'], 'retained');
  } finally {
    await Promise.all([source, target].map(server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  }
});
