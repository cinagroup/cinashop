const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const { basename, dirname, join, relative } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const semver = require('semver');

// GHSA-67mh-4wv8-2f99 applies to esbuild's own serve API, independently of
// Vite's CORS configuration. Exercise each consumer's actual resolution and
// native service, using only fresh inert fixtures and a loopback ephemeral port.
// GHSA-g7r4-m6w7-qqqr is exercised against a sibling inert file outside servedir.
// Its actual Windows filesystem alias is proved only on Windows; Linux also
// exercises the patched HTTP rejection but cannot substitute for native QA.
// This does not claim that DCloud currently calls serve.
const consumers = ['vite', '@dcloudio/uni-cli-shared'];
const services = new Set();
test.after(() => { for (const api of services) api.stop(); });

function request(port, path, headers = {}, method = 'GET', headersOnly = false) {
  return new Promise((done, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, method }, res => {
      if (headersOnly) {
        done({ status: res.statusCode, headers: res.headers });
        res.destroy();
        req.destroy();
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => done({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(10000, () => req.destroy(Error('esbuild fixture request timed out')));
    req.on('error', reject);
    req.end();
  });
}

for (const consumer of consumers) {
  test(`${consumer} resolves an esbuild service that blocks foreign-origin response reads`,
    { timeout: 60000 }, async t => {
      if (process.env.CINASHOP_REQUIRE_WINDOWS_PATH_QA === '1') {
        assert.equal(process.platform, 'win32', 'native Windows evidence requires Windows execution');
      }
      assert.equal(process.env.ESBUILD_BINARY_PATH, undefined,
        'a binary override would mask the consumer-scoped installed dependency');
      const owner = createRequire(require.resolve(`${consumer}/package.json`));
      const entry = owner.resolve('esbuild');
      const packagePath = owner.resolve('esbuild/package.json');
      const packageInfo = owner('esbuild/package.json');
      const api = owner('esbuild');
      services.add(api);
      const binaryOwner = createRequire(entry);
      const platformPackage = `@esbuild/${process.platform}-${process.arch}`;
      const binarySubpath = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
      const binaryPath = binaryOwner.resolve(`${platformPackage}/${binarySubpath}`);
      const binaryPackage = binaryOwner(`${platformPackage}/package.json`);
      const parent = fs.realpathSync(process.cwd());
      const fixture = fs.realpathSync(fs.mkdtempSync(join(parent, '.toolchain-esbuild-serve-')));
      let context;
      t.after(async () => {
        if (context) await context.dispose();
        assert.equal(dirname(fixture), parent);
        assert.match(basename(fixture), /^\.toolchain-esbuild-serve-[A-Za-z0-9]+$/);
        assert.equal(fs.realpathSync(fixture), fixture);
        fs.rmSync(fixture, { recursive: true, force: true });
      });
      const marker = 'INERT_ESBUILD_SERVE_SECURITY_FIXTURE';
      const outsideMarker = 'INERT_ESBUILD_OUTSIDE_SERVEDIR_FIXTURE';
      const servedir = join(fixture, 'public');
      const outside = join(fixture, 'outside-servedir.txt');
      fs.mkdirSync(join(servedir, 'src'), { recursive: true });
      fs.writeFileSync(outside, outsideMarker);
      fs.writeFileSync(join(servedir, 'src', 'inert-fixture.js'),
        `export const inertFixture = ${JSON.stringify(marker)};\n`);
      const buildOptions = {
        absWorkingDir: servedir, entryPoints: ['src/inert-fixture.js'], bundle: true,
        format: 'esm', platform: 'browser', logLevel: 'silent',
      };

      await t.test('resolved package, API, native binary and a real build agree', async () => {
        assert.equal(packageInfo.name, 'esbuild');
        assert.equal(api.version, packageInfo.version);
        assert.equal(binaryPackage.version, packageInfo.version);
        const binary = spawnSync(binaryPath, ['--version'], {
          encoding: 'utf8', windowsHide: true, timeout: 15000,
        });
        assert.ifError(binary.error);
        assert.equal(binary.status, 0, binary.stderr);
        assert.equal(binary.stdout.trim(), packageInfo.version);
        const built = await api.build({ ...buildOptions, write: false,
          outfile: join(fixture, 'build-control.js') });
        assert.deepEqual(built.errors, []);
        assert.equal(built.outputFiles.length, 1);
        assert.ok(built.outputFiles[0].text.includes(marker));
        t.diagnostic(JSON.stringify({ consumer, version: api.version,
          entry: relative(parent, entry), binary: relative(parent, binaryPath),
          platform: process.platform, architecture: process.arch }));
      });
      await t.test('installed version includes both current official esbuild serve fixes', () => {
        assert.ok(semver.gte(packageInfo.version, '0.28.1'),
          `${consumer} must resolve at least 0.28.1 for CORS and Windows servedir fixes`);
      });

      context = await api.context({ ...buildOptions, outfile: join(servedir, 'out', 'bundle.js'),
        sourcemap: 'external', sourcesContent: true });
      const serving = await context.serve({ host: '127.0.0.1', port: 0, servedir });
      const hosts = serving.hosts || (serving.host ? [serving.host] : []);
      assert.deepEqual(hosts, ['127.0.0.1'], 'the native server must bind only the requested loopback host');
      assert.ok(Number.isInteger(serving.port) && serving.port > 0);
      const paths = ['/src/inert-fixture.js', '/out/bundle.js', '/out/bundle.js.map'];
      const sameOrigin = `http://127.0.0.1:${serving.port}`;

      await t.test('ordinary and same-origin source, bundle and source-map reads still work', async () => {
        for (const headers of [{}, { Origin: sameOrigin }]) {
          for (const path of paths) {
            const response = await request(serving.port, path, headers);
            assert.equal(response.status, 200, path);
            assert.ok(response.body.includes(marker), path);
            if (path.endsWith('.map')) {
              const map = JSON.parse(response.body);
              assert.equal(map.version, 3);
              assert.ok(map.sourcesContent.some(source => source.includes(marker)));
            }
          }
        }
      });
      await t.test('foreign and opaque origins receive no permissive CORS on files or preflights', async () => {
        for (const origin of ['https://untrusted.example', 'null']) {
          for (const path of paths) {
            for (const method of ['GET', 'OPTIONS']) {
              const headers = { Origin: origin };
              if (method === 'OPTIONS') headers['Access-Control-Request-Method'] = 'GET';
              const response = await request(serving.port, path, headers, method);
              assert.equal(response.headers['access-control-allow-origin'], undefined,
                `${consumer} ${method} ${path} Origin=${origin}`);
              assert.ok(response.status === 200 || response.status === 204 ||
                (response.status >= 400 && response.status < 500),
              'a server failure must not be accepted as CORS protection');
            }
          }
        }
      });
      await t.test('backslash and encoded paths cannot read the inert sibling outside servedir', async () => {
        assert.equal(fs.readFileSync(outside, 'utf8'), outsideMarker);
        if (process.platform === 'win32') {
          assert.equal(fs.readFileSync(join(servedir, '..\\outside-servedir.txt'), 'utf8'), outsideMarker,
            'prove the Windows backslash path resolves to the real outside fixture');
        }
        const ordinary = await request(serving.port, '/../outside-servedir.txt');
        assert.equal(ordinary.status, 404);
        assert.ok(!ordinary.body.includes(outsideMarker));
        for (const path of ['/..\\outside-servedir.txt', '/..%5coutside-servedir.txt',
          '/..%5Coutside-servedir.txt', '/%2e%2e%5coutside-servedir.txt']) {
          const response = await request(serving.port, path);
          t.diagnostic(JSON.stringify({ consumer, path, platform: process.platform,
            nativeWindowsAliasProved: process.platform === 'win32',
            status: response.status, returnedOutsideMarker: response.body.includes(outsideMarker) }));
          assert.ok(!response.body.includes(outsideMarker), path);
          assert.equal(response.status, 400, 'the official fixed server rejects Windows-style separators');
        }
      });
      await t.test('the real live-reload SSE endpoint also blocks foreign-origin reads', async () => {
        const control = await request(serving.port, '/esbuild',
          { Origin: sameOrigin, Accept: 'text/event-stream' }, 'GET', true);
        assert.equal(control.status, 200);
        assert.match(control.headers['content-type'], /^text\/event-stream\b/);
        for (const origin of ['https://untrusted.example', 'null']) {
          const response = await request(serving.port, '/esbuild',
            { Origin: origin, Accept: 'text/event-stream' }, 'GET', true);
          assert.equal(response.headers['access-control-allow-origin'], undefined,
            `${consumer} SSE Origin=${origin}`);
          assert.ok(response.status === 200 || (response.status >= 400 && response.status < 500));
        }
      });
    });
}
