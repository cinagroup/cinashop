import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(resolve('package.json'));
const lock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'));
const project = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).name;
const releases = {
  'cinashop-pc': { version: '1.16.2', integrity: 'sha512-/kVP2U8z596Ia0gwFrwyIeo74ta5aVmSeU1FfAUMAmcEP5EP7zydmag3SLiN64NaRKef3lxsq7i/g7ltJQDGow==' },
  'cinashop-uniapp': { version: '1.16.2', integrity: 'sha512-/kVP2U8z596Ia0gwFrwyIeo74ta5aVmSeU1FfAUMAmcEP5EP7zydmag3SLiN64NaRKef3lxsq7i/g7ltJQDGow==' },
};
assert.ok(Object.hasOwn(releases, project), 'review the exact redirect release for this project');
const reviewed = releases[project];

test('every locked redirect client uses the exact official release reviewed for this project', () => {
  const copies = Object.entries(lock.packages).filter(([name]) => name.endsWith('node_modules/follow-redirects'));
  assert.ok(copies.length > 0);
  for (const [name, entry] of copies) {
    assert.equal(entry.version, reviewed.version, name); assert.equal(entry.integrity, reviewed.integrity, name);
    assert.equal(entry.resolved, `https://registry.npmjs.org/follow-redirects/-/follow-redirects-${reviewed.version}.tgz`, name);
  }
  assert.equal(require('follow-redirects/package.json').version, reviewed.version);
});

test('actual redirects strip object and array-form credentials across origins and preserve same-origin headers', async () => {
  const redirect = require('follow-redirects').http;
  const protectedNames = ['Authorization', 'Proxy-Authorization', 'Cookie', 'X-Api^Key', 'X-Token|Secret', 'X-Control-Key'];
  const credentials = Object.fromEntries(protectedNames.map(name => [name, 'inert-test-credential']));
  const collector = createServer((req, res) => { req.resume(); res.end(JSON.stringify(req.headers)); });
  let destination;
  const origin = createServer((req, res) => {
    req.resume();
    if (req.url === '/collect') return res.end(JSON.stringify(req.headers));
    res.writeHead(302, { Location: req.url === '/same' ? '/collect' : destination }); res.end();
  });
  const listen = server => new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const close = server => new Promise(yes => { server.closeAllConnections(); if (server.listening) server.close(yes); else yes(); });
  try {
    await listen(collector); await listen(origin);
    destination = `http://127.0.0.1:${collector.address().port}/collect`;
    // Both adopted 1.16.2 consumers retain credentials only on the same origin,
    // including sensitiveHeaders arrays created in another JavaScript realm.
    for (const crossRealm of [false, true])
      for (const array of [false, true]) for (const sameOrigin of [false, true]) {
      const values = { ...credentials, 'X-Public-Control': 'preserved' };
      const sensitiveHeaders = crossRealm ? runInNewContext(JSON.stringify(protectedNames.slice(3))) : protectedNames.slice(3);
      assert.equal(Array.isArray(sensitiveHeaders), true);
      assert.equal(sensitiveHeaders instanceof Array, !crossRealm);
      const received = await new Promise((yes, no) => {
        const request = redirect.request({ hostname: '127.0.0.1', port: origin.address().port,
          path: sameOrigin ? '/same' : '/cross', headers: array ? Object.entries(values).flat() : values,
          sensitiveHeaders }, response => {
          const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', no);
          response.on('end', () => { try { yes(JSON.parse(Buffer.concat(chunks))); } catch (error) { no(error); } });
        });
        request.on('error', no); request.setTimeout(3000, () => request.destroy(Error('Local redirect probe timed out'))); request.end();
      });
      assert.equal(received['x-public-control'], 'preserved');
      for (const name of protectedNames) assert.equal(received[name.toLowerCase()], sameOrigin ? credentials[name] : undefined,
        `${crossRealm ? 'cross-realm' : 'same-realm'} ${array ? 'array' : 'object'} ${sameOrigin ? 'same' : 'cross'}: ${name}`);
    }
  } finally { await close(origin); await close(collector); }
});
