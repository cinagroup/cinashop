const assert = require('node:assert/strict');
const fs = require('node:fs');
const { once } = require('node:events');
const http = require('node:http');
const { basename, dirname, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { assertDefaultViteFsAllow } = require('./vite-fs-allow-test-helper.cjs');

// Exercise the installed Vite/DCloud middleware. UNC filesystem probes are
// intercepted before any network access; normal local probes are unchanged.
// The test never starts an editor or contacts a share.
const previousCI = process.env.CI;
const previousProxy = process.env.CINASHOP_API_PROXY_TARGET;
process.env.CI = '1';
process.env.CINASHOP_API_PROXY_TARGET = 'http://127.0.0.1:1';
const originalWatch = fs.watch;
const watchers = new Set();
let closing = false;
fs.watch = function (...args) {
  const watcher = Reflect.apply(originalWatch, this, args);
  if (closing) watcher.close();
  else { watchers.add(watcher); watcher.once('close', () => watchers.delete(watcher)); }
  return watcher;
};
test.after(async () => {
  closing = true;
  await Promise.all([...watchers].map(watcher => {
    const closed = once(watcher, 'close'); watcher.close(); return closed;
  }));
  assert.equal(watchers.size, 0);
  process.once('beforeExit', () => { fs.watch = originalWatch; });
  for (const [name, value] of [['CI', previousCI], ['CINASHOP_API_PROXY_TARGET', previousProxy]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function request(port, path) {
  return new Promise((done, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path }, res => {
      const chunks = []; res.on('data', data => chunks.push(data));
      res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(10000, () => req.destroy(Error('request timed out')));
    req.on('error', reject); req.end();
  });
}

function nativeShortBasename(file) {
  const command = String.raw`
Add-Type -TypeDefinition @'
using System.Text;
using System.Runtime.InteropServices;
public static class ViteFixtureShortPath {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern uint GetShortPathName(string name, StringBuilder result, uint length);
}
'@;
$output=[System.Text.StringBuilder]::new(4096);
$n=[ViteFixtureShortPath]::GetShortPathName($env:VITE_QA_LONG_FILE,$output,4096);
if($n -eq 0){exit 1}; [System.IO.Path]::GetFileName($output.ToString())`;
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, VITE_QA_LONG_FILE: file },
  });
  assert.equal(child.status, 0, child.error?.message || child.stderr || 'native short-path lookup failed');
  const name = child.stdout.trim();
  assert.ok(name.includes('~'), 'NTFS must create a real short alias for this fixture; no simulated alias is accepted');
  assert.equal(basename(name), name);
  return name;
}

test('actual Vite rejects alternate private file names and editor UNC probes', { timeout: 90000 }, async t => {
  if (process.env.CINASHOP_REQUIRE_WINDOWS_PATH_QA === '1') {
    assert.equal(process.platform, 'win32', 'native Windows evidence requires Windows execution');
  }
  t.diagnostic(JSON.stringify({ platform: process.platform,
    scope: process.platform === 'win32' ? 'shared and native NTFS/editor cases' : 'shared authorization only; native Windows cases are not executed' }));
  const parent = fs.realpathSync(process.cwd());
  const temporary = fs.realpathSync(fs.mkdtempSync(join(parent, '.toolchain-vite-win-path-')));
  const marker = 'INERT_PRIVATE_VITE_WINDOWS_PATH_MARKER';
  const permitted = join(temporary, 'allowed.txt');
  const denied = join(temporary, 'private-long-ntfs-stream-test.pem');
  const hidden = join(temporary, '.env.private-long-shortname-marker');
  for (const file of [permitted, denied, hidden]) fs.writeFileSync(file, marker);
  let server;
  t.after(async () => {
    if (server) await server.close();
    assert.equal(dirname(temporary), parent);
    assert.match(basename(temporary), /^\.toolchain-vite-win-path-[A-Za-z0-9]+$/);
    assert.equal(fs.realpathSync(temporary), temporary);
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const { initEnv } = require('@dcloudio/vite-plugin-uni/dist/cli/utils.js');
  initEnv('dev', { platform: 'h5' });
  const { createServer, isFileServingAllowed } = await import('vite');
  server = await createServer({ root: process.cwd(), configFile: resolve('vite.config.ts'),
    server: { port: 0 }, logLevel: 'silent' });
  assert.equal(server.config.server.host, '127.0.0.1');
  assert.equal(server.config.server.fs.strict, true);
  assert.equal(server.config.server.cors, false);
  assertDefaultViteFsAllow(server.config.server.fs.allow, process.cwd());
  assert.equal(server.config.server.proxy['/api'].target, 'http://127.0.0.1:1');
  await server.listen();
  const address = server.httpServer.address();
  assert.equal(address.address, '127.0.0.1');
  const port = address.port;
  const fsUrl = file => `/@fs/${file.replaceAll('\\', '/')}`;
  await t.test('permitted files are served while both ordinary private paths are denied', async () => {
    const permittedResponse = await request(port, fsUrl(permitted));
    assert.equal(permittedResponse.status, 200);
    assert.equal(permittedResponse.body, marker);
    for (const file of [denied, hidden]) {
      const response = await request(port, fsUrl(file));
      assert.equal(response.status, 403);
      assert.ok(!response.body.includes(marker));
    }
  });
  await t.test('a non-drive colon cannot bypass the genuine Vite file authorization function', () => {
    assert.equal(isFileServingAllowed(fsUrl(`${denied}::$DATA`), server), false);
    assert.equal(isFileServingAllowed(fsUrl(permitted), server), true);
  });
  if (process.platform === 'win32') {
    await t.test('a real NTFS default data stream cannot bypass the private PEM path', async () => {
      const alternate = `${denied}::$DATA`;
      assert.equal(fs.readFileSync(alternate, 'utf8'), marker, 'prove the filesystem alias resolves to the same fixture');
      const response = await request(port, fsUrl(alternate));
      t.diagnostic(JSON.stringify({ status: response.status, returnedMarker: response.body.includes(marker) }));
      assert.ok(!response.body.includes(marker));
      assert.ok([403, 404].includes(response.status));
    });
    await t.test('a native NTFS 8.3 basename cannot bypass a private env path', async () => {
      const alternate = join(temporary, nativeShortBasename(hidden));
      assert.equal(fs.readFileSync(alternate, 'utf8'), marker, 'prove the native short alias reads the same fixture');
      const response = await request(port, fsUrl(alternate));
      t.diagnostic(JSON.stringify({ nativeAlias: true, status: response.status, returnedMarker: response.body.includes(marker) }));
      assert.ok(!response.body.includes(marker));
      assert.ok([403, 404].includes(response.status));
    });
    await t.test('embedded launch-editor rejects both UNC forms before a filesystem probe', async () => {
      const existsSync = fs.existsSync;
      let networkProbes = 0, localProbes = 0;
      fs.existsSync = function (file) {
        if (typeof file === 'string' && /^(?:\\\\|\/\/)/u.test(file)) {
          networkProbes++;
          return false; // Never forward UNC paths to the OS or a network share.
        }
        if (typeof file === 'string' && file.endsWith('inert-editor-control-missing.ts')) localProbes++;
        return Reflect.apply(existsSync, this, arguments);
      };
      try {
        const missing = join(temporary, 'inert-editor-control-missing.ts');
        assert.equal((await request(port, `/__open-in-editor?file=${encodeURIComponent(missing)}`)).status, 200);
        assert.ok(localProbes > 0, 'positive control reaches the real embedded editor middleware');
        for (const file of ['\\\\inert-vite-editor.invalid\\share\\missing.ts', '//inert-vite-editor.invalid/share/missing.ts']) {
          assert.equal((await request(port, `/__open-in-editor?file=${encodeURIComponent(file)}`)).status, 200);
        }
        t.diagnostic(JSON.stringify({ networkProbes, localProbes }));
        assert.equal(networkProbes, 0, 'the embedded editor must reject UNC before existsSync');
      } finally { fs.existsSync = existsSync; }
    });
  }
});
