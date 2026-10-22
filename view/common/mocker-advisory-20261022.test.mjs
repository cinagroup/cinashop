import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const appRequire = createRequire(resolve('package.json'));
const vitestRequire = createRequire(appRequire.resolve('vitest/package.json'));
const { interceptorPlugin } = await import(pathToFileURL(vitestRequire.resolve('@vitest/mocker/node')).href);

let serial = 0;
async function manualModule(t, url, factory) {
  const accessor = `__cinashop_mock_control_${serial++}`;
  const handlers = new Map(), calls = [], sent = [];
  const plugin = interceptorPlugin({ globalThisAccessor: JSON.stringify(accessor) });
  await plugin.configureServer({ ws: {
    on: (event, handler) => handlers.set(event, handler),
    send(event, value) {
      sent.push(event);
      if (event === 'vitest:interceptor:resolve') queueMicrotask(() => {
        handlers.get('vitest:interceptor:resolved')({ url: value, keys: Object.keys(factory) });
      });
    },
  } });
  handlers.get('vitest:interceptor:register')({ type: 'manual', raw: 'fixture', id: '/manual-control', url });
  const code = await plugin.load.handler('/manual-control');
  assert.equal(typeof code, 'string');
  assert.ok(sent.includes('vitest:interceptor:register:result'));
  globalThis[accessor] = { getFactoryModule(value) { calls.push(value); return factory; } };
  t.after(() => { delete globalThis[accessor]; delete globalThis.__cinashop_inert_mock_statement; });
  const module = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  return { calls, module, code };
}

test('manual mock registration treats a hostile module URL as a literal', async t => {
  const url = 'x"); globalThis.__cinashop_inert_mock_statement = true; void("';
  const { calls, module } = await manualModule(t, url, { answer: 42 });
  assert.equal(globalThis.__cinashop_inert_mock_statement, undefined, 'registered text cannot become a statement');
  assert.deepEqual(calls, [url]);
  assert.equal(module.answer, 42);
});

test('manual mock export names retain quotes, slashes and newlines as literal keys', async t => {
  const names = ['quote"name', 'back\\slash', 'line\nbreak'];
  const factory = Object.fromEntries(names.map((name, index) => [name, index + 1]));
  const { calls, module } = await manualModule(t, 'fixture:export-control', factory);
  assert.deepEqual(calls, ['fixture:export-control']);
  for (const name of names) assert.equal(module[name], factory[name]);
});

test('ordinary manual mocks preserve default exports and deferred live bindings', async t => {
  let complete;
  const factory = { answer: 42, default: 'INERT_DEFAULT' };
  Object.defineProperty(factory, '__factoryPromise', { value: new Promise(resolveFactory => { complete = resolveFactory; }) });
  const { calls, module } = await manualModule(t, 'fixture:ordinary-control', factory);
  assert.deepEqual(calls, ['fixture:ordinary-control']);
  assert.equal(module.answer, 42); assert.equal(module.default, 'INERT_DEFAULT');
  complete({ answer: 43, default: 'INERT_UPDATED' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(module.answer, 43); assert.equal(module.default, 'INERT_UPDATED');
});

for (const pathname of ['..\\outside.txt', '..\\..\\outside.txt']) {
  test(`redirect policy canonicalizes Windows separator traversal before admission: ${pathname}`, async t => {
    const base = await mkdtemp(join(tmpdir(), 'cinashop-mocker-policy-')), root = join(base, 'project');
    await mkdir(root); await writeFile(join(base, 'outside.txt'), 'INERT_OUTSIDE_MOCK_CONTROL');
    const { createServer } = await import(pathToFileURL(vitestRequire.resolve('vite')).href);
    const server = await createServer({ root, configFile: false, envFile: false, logLevel: 'silent',
      optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false, watch: null, fs: { strict: true, allow: [root] } } });
    t.after(async () => { await server.close(); assert.equal(dirname(root), base); await rm(base, { recursive: true, force: true }); });
    const registered = [], handlers = new Map(), replies = [];
    const registry = { register: event => registered.push(event), getById: () => registered[0] };
    const plugin = interceptorPlugin({ registry });
    await plugin.configureServer({ ...server, ws: { on: (name, handler) => handlers.set(name, handler), send: (...args) => replies.push(args) } });
    await handlers.get('vitest:interceptor:register')({ type: 'redirect', raw: 'fixture', id: '/redirect-control', url: '/redirect-control', redirect: 'audit:' + pathname });
    assert.equal(registered.length, 0, 'a Windows path escape must never enter the file-reading registry');
    assert.deepEqual(replies, [['vitest:interceptor:register:result']]);
    assert.equal(await plugin.load.handler('/redirect-control'), undefined);
  });
}
