const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const http = require('node:http');
const { createRequire } = require('node:module');
const { dirname, join, relative, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');

// Preserve real Vite filesystem/watch behavior and close only this file's
// owned late watchers after the actual server has closed.
const originalWatch = fs.watch, ownedWatchers = new Set(); let closing = false;
fs.watch = function (...args) {
  const watcher = Reflect.apply(originalWatch, this, args);
  if (closing) watcher.close();
  else { ownedWatchers.add(watcher); watcher.once('close', () => ownedWatchers.delete(watcher)); }
  return watcher;
};
test.after(async () => {
  closing = true;
  await Promise.all([...ownedWatchers].map(watcher => { const done = once(watcher, 'close'); watcher.close(); return done; }));
  assert.equal(ownedWatchers.size, 0);
  process.once('beforeExit', () => { fs.watch = originalWatch; });
});
const appRequire = createRequire(resolve('package.json'));
const safePaths = server => { const paths = server.config.safeModulePaths ?? server.moduleGraph.safeModulesPath; assert.ok(paths instanceof Set); return paths; };
const normalize = value => value.replaceAll('\\', '/');
function request(port, path) {
  return new Promise((resolveResponse, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolveResponse({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(10000, () => req.destroy(Error('owned Vite request timed out'))); req.on('error', reject); req.end();
  });
}
async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'cinashop-vite-advisory-')), root = join(base, 'project');
  await mkdir(root); await writeFile(join(root, 'package.json'), '{"type":"module"}');
  // A common gate must exercise this frontend's installation even when no
  // other frontend has node_modules in a fresh matrix job.
  assert.equal(appRequire.resolve('vite/package.json'), resolve('node_modules/vite/package.json'));
  const lock = JSON.parse(fs.readFileSync(resolve('package-lock.json'), 'utf8'));
  assert.equal(appRequire('vite/package.json').version, lock.packages['node_modules/vite'].version);
  const { createServer } = appRequire('vite');
  const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 0, cors: false, hmr: false, watch: null, fs: { strict: true, allow: [root] } }, ...options });
  t.after(async () => { await server.close(); assert.equal(dirname(root), base); await rm(base, { recursive: true, force: true }); });
  return { base, root, server };
}
const inline = '<main>INERT_HTML_CONTROL</main><script type="module">export const control="INERT_MODULE_CONTROL"</script>';
function proxy(html) { const value = /<script\b[^>]*\bsrc="([^"]*html-proxy[^"]*)"/u.exec(html)?.[1]; assert.ok(value, html); return value; }

for (const prefix of ['//', '///']) test(`HTML transform blocks protocol-relative inline module proxy ${prefix}`, { timeout: 30000 }, async t => {
  const { server } = await fixture(t);
  const html = await server.transformIndexHtml(`${prefix}evil.invalid/payload.js?/../../package.json`, inline);
  assert.ok(html.includes('INERT_HTML_CONTROL'));
  assert.doesNotMatch(proxy(html), /^\/\//u);
  assert.match(proxy(html), /^\/(?:@id\/|evil\.invalid\/)/u);
});

test('HTML transform preserves real and virtual local inline module loading', { timeout: 30000 }, async t => {
  const { root, server } = await fixture(t);
  await writeFile(join(root, 'normal.html'), inline);
  await server.listen(); const port = server.httpServer.address().port;
  for (const path of ['/normal.html', '/virtual-page']) {
    const html = await server.transformIndexHtml(path, inline), url = proxy(html);
    assert.doesNotMatch(url, /^\/\//u);
    const result = await request(port, url);
    assert.equal(result.status, 200); assert.ok(result.body.includes('INERT_MODULE_CONTROL'), `${path}: ${result.body}`);
  }
});

test('resolved module identities cannot grant an unrelated absolute host path', { timeout: 30000 }, async t => {
  const { base, root, server } = await fixture(t);
  const outside = join(base, 'outside', 'inert.js'), outsideId = normalize(outside);
  const decoy = join(root, outsideId.replace(/^(?:[A-Z]:)?\//iu, ''));
  await mkdir(dirname(outside), { recursive: true }); await mkdir(dirname(decoy), { recursive: true });
  await writeFile(outside, 'export const secret="INERT_OUTSIDE_HOST_FILE"');
  await writeFile(decoy, 'export const control="INERT_PROJECT_DECOY"');
  await writeFile(join(root, 'entry.js'), `import ${JSON.stringify('./' + normalize(relative(root, decoy)))};export const loaded=true`);
  await server.listen(); const port = server.httpServer.address().port;
  const outsideUrl = '/@fs/' + outsideId.replace(/^\//u, '');
  assert.equal((await request(port, outsideUrl)).status, 403);
  const entry = await request(port, '/entry.js'); assert.equal(entry.status, 200); assert.ok(entry.body.includes('loaded'));
  const denied = await request(port, outsideUrl);
  t.diagnostic(`unrelated host path response=${denied.status}, inert marker=${denied.body.includes('INERT_OUTSIDE_HOST_FILE')}`);
  assert.equal(denied.status, 403);
  assert.equal(safePaths(server).has(outsideId), false);
  assert.equal(safePaths(server).has(normalize(decoy)), true); assert.ok(!denied.body.includes('INERT_OUTSIDE_HOST_FILE'));
  const allowed = await request(port, '/' + normalize(relative(root, decoy)));
  assert.equal(allowed.status, 200); assert.ok(allowed.body.includes('INERT_PROJECT_DECOY'));
  // An explicit source import of the genuine outside file remains trusted;
  // its queried resolved ID must be stored without the query.
  await writeFile(join(root, 'explicit.js'), `import ${JSON.stringify(outsideUrl + '?inert-authorized')};export const explicit=true`);
  assert.equal((await request(port, '/explicit.js')).status, 200);
  assert.equal(safePaths(server).has(outsideId), true);
  const explicit = await request(port, outsideUrl);
  assert.equal(explicit.status, 200); assert.ok(explicit.body.includes('INERT_OUTSIDE_HOST_FILE'));
});

test('safe module projection never admits an unresolved SSR import', { timeout: 30000 }, async t => {
  let entry;
  const unresolved = '/inert-unresolved-safe-module';
  const { root, server } = await fixture(t, { plugins: [{ name: 'inert-unresolved-SSR',
    resolveId(id) { if (id === '/unresolved-entry.js') return entry; },
    load(id) { if (id === entry) return `import ${JSON.stringify(unresolved)};export const ordinary=true`; }
  }] });
  entry = normalize(join(root, 'unresolved-entry.js'));
  const result = await server.transformRequest('/unresolved-entry.js', { ssr: true });
  assert.ok(result?.code.includes('ordinary'));
  assert.ok(result.code.includes(unresolved), 'unresolved SSR import remains available to the runtime resolver');
  assert.equal(safePaths(server).has(unresolved), false);
});

test('deny patterns still block queried files after legitimate imports and normal raw files remain usable', { timeout: 30000 }, async t => {
  const { root, server } = await fixture(t);
  await writeFile(join(root, '.env'), 'INERT_DENIED_ENV_FILE');
  await writeFile(join(root, 'control.txt'), 'INERT_RAW_CONTROL');
  await writeFile(join(root, 'entry.js'), 'import control from "./control.txt?raw";export {control}');
  await server.listen(); const port = server.httpServer.address().port;
  assert.equal((await request(port, '/entry.js')).status, 200);
  for (const query of ['?raw', '?import&raw', '?import&url&inline']) {
    const denied = await request(port, '/.env' + query);
    assert.notEqual(denied.status, 200); assert.ok(!denied.body.includes('INERT_DENIED_ENV_FILE'));
  }
  const control = await request(port, '/control.txt?raw'); assert.equal(control.status, 200); assert.ok(control.body.includes('INERT_RAW_CONTROL'));
});
