import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const require = createRequire(resolve('package.json'));
const lock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'));
const integrity = 'sha512-FNvFGzoMLWmE6Yj9spb/zjd7yiNCHiAW9/Tg9CXrQ8wuu32HtlJOwWO11OJafl5FfY3DxTdQ0vj42zU1kvv5jg==';

test('every locked redirect client uses the official 1.16.1 credential-stripping fix', () => {
  const copies = Object.entries(lock.packages).filter(([name]) => name.endsWith('node_modules/follow-redirects'));
  assert.ok(copies.length > 0);
  for (const [name, entry] of copies) {
    assert.equal(entry.version, '1.16.1', name); assert.equal(entry.integrity, integrity, name);
    assert.equal(entry.resolved, 'https://registry.npmjs.org/follow-redirects/-/follow-redirects-1.16.1.tgz', name);
  }
  assert.equal(require('follow-redirects/package.json').version, '1.16.1');
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
    for (const array of [false, true]) for (const sameOrigin of [false, true]) {
      const values = { ...credentials, 'X-Public-Control': 'preserved' };
      const received = await new Promise((yes, no) => {
        const request = redirect.request({ hostname: '127.0.0.1', port: origin.address().port,
          path: sameOrigin ? '/same' : '/cross', headers: array ? Object.entries(values).flat() : values,
          sensitiveHeaders: protectedNames.slice(3) }, response => {
          const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', no);
          response.on('end', () => { try { yes(JSON.parse(Buffer.concat(chunks))); } catch (error) { no(error); } });
        });
        request.on('error', no); request.setTimeout(3000, () => request.destroy(Error('Local redirect probe timed out'))); request.end();
      });
      assert.equal(received['x-public-control'], 'preserved');
      for (const name of protectedNames) assert.equal(received[name.toLowerCase()], sameOrigin ? credentials[name] : undefined,
        `${array ? 'array' : 'object'} ${sameOrigin ? 'same' : 'cross'}: ${name}`);
    }
  } finally { await close(origin); await close(collector); }
});
