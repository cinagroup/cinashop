import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.cwd();
const require = createRequire(resolve(root, 'package.json'));
const vitestRequire = createRequire(require.resolve('vitest/package.json'));

test('every locked Vitest and mocker copy is on the reviewed 4.1.11 patch line', () => {
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  for (const name of ['vitest', '@vitest/mocker']) {
    const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`));
    assert.ok(copies.length > 0, name);
    for (const [path, pkg] of copies) assert.equal(pkg.version, '4.1.11', path);
  }
});

// Actual plugin registration + load hooks and Vite file policy. No socket is exposed.
// Only the positive control reads the local, non-secret tsconfig.json.
for (const scenario of [
  { name: 'opaque parent traversal', redirect: 'audit:../outside-audit.txt', allowed: false },
  { name: 'opaque deeper traversal', redirect: 'audit:../../outside-audit.txt', allowed: false },
  { name: 'explicitly denied in-root manifest', redirect: 'http://audit.invalid/package.json', allowed: false },
  { name: 'allowed in-root module', redirect: 'http://audit.invalid/tsconfig.json', allowed: true },
]) test(`redirect mock respects file policy: ${scenario.name}`, async () => {
  const { createServer } = await import(pathToFileURL(vitestRequire.resolve('vite')).href);
  const { interceptorPlugin } = await import(pathToFileURL(vitestRequire.resolve('@vitest/mocker/node')).href);
  const server = await createServer({ root, configFile: false, envFile: false, logLevel: 'silent', plugins: [],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null, fs: { strict: true, allow: [root], deny: ['**/package.json'] } } });
  const handlers = new Map(), registered = [], replies = [];
  const registry = { register: event => registered.push(event), getById: () => registered[0], delete() {}, clear() {}, add() {} };
  const plugin = interceptorPlugin({ registry });
  try {
    await plugin.configureServer({ ...server, ws: { on: (name, handler) => handlers.set(name, handler), send: (...args) => replies.push(args) } });
    const handler = handlers.get('vitest:interceptor:register');
    assert.equal(typeof handler, 'function');
    let error;
    try { await handler({ type: 'redirect', id: '/fixture/mock', url: '/fixture/mock', raw: 'fixture', redirect: scenario.redirect }); }
    catch (value) { error = value; }
    if (scenario.allowed) {
      assert.equal(error, undefined);
      assert.equal(registered.length, 1);
      assert.equal(await plugin.load.handler('/fixture/mock'), readFileSync(resolve(root, 'tsconfig.json'), 'utf8'));
    } else {
      assert.equal(registered.length, 0, 'unsafe target must not reach the readable mock registry');
      // Upstream acknowledges the request but deliberately leaves the registry empty.
      assert.equal(error, undefined);
      assert.deepEqual(replies, [['vitest:interceptor:register:result']]);
      assert.equal(await plugin.load.handler('/fixture/mock'), undefined);
    }
  } finally { await server.close(); }
});
