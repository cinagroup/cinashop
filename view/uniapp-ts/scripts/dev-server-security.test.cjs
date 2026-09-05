const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const http = require("node:http");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");
const https = require("node:https");

// DCloud's CLI otherwise POSTs device/app/build metadata during configResolved.
const previousCI = process.env.CI;
process.env.CI = "1";
test.after(() => {
  if (previousCI === undefined) delete process.env.CI;
  else process.env.CI = previousCI;
});

test("the actual DCloud update checker is disabled in the isolated test process", async () => {
  const originalRequest = https.request;
  let requests = 0;
  https.request = () => { requests++; throw new Error("Unexpected vendor update request"); };
  try {
    const { checkUpdate } = require("@dcloudio/uni-cli-shared/dist/checkUpdate.js");
    await checkUpdate({ inputDir: process.cwd(), compilerVersion: "4.29", versionType: "r" });
    assert.equal(requests, 0);
  } finally {
    https.request = originalRequest;
  }
});

test("Vite 5 patch stays within the installed DCloud peer contract", () => {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const plugin = require("@dcloudio/vite-plugin-uni/package.json");
  const vite = require("vite/package.json");
  assert.equal(vite.version, lock.packages["node_modules/vite"].version);
  assert.ok(require("semver").satisfies(vite.version, ">=5.4.21 <6"));
  assert.ok(require("semver").satisfies(vite.version, plugin.peerDependencies.vite));
  // This is a scoped 5.x patch gate, NOT a claim that Vite 5 has no advisories.
});

function request(port, path, headers = {}, method = "GET") {
  return new Promise((resolveResponse, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers, method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => { chunks.push(chunk); });
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolveResponse({ status: res.statusCode, headers: res.headers, body: bytes.toString("utf8"), bytes });
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function upgrade(port, origin, token) {
  return new Promise((resolveResult, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/${token ? `?token=${token}` : ""}`, "vite-hmr", {
      origin, handshakeTimeout: 5000,
    });
    socket.on("error", reject);
    socket.on("unexpected-response", (_req, res) => {
      res.resume();
      socket.terminate();
      resolveResult(res.statusCode);
    });
    socket.on("open", () => { socket.close(); resolveResult(101); });
  });
}

test("actual UniApp H5 configuration preserves local development boundaries", { timeout: 90_000 }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "cinashop-uni-dev-security-"));
  const marker = "INERT_OUTSIDE_UNIAPP_FIXTURE";
  const outside = join(fixture, "outside.txt");
  await writeFile(outside, marker);
  t.after(() => rm(fixture, { recursive: true, force: true })); // Only this freshly created fixture.
  const deniedFixture = await mkdtemp(join(process.cwd(), ".toolchain-fixture-"));
  const denied = join(deniedFixture, "denied.pem");
  await writeFile(denied, marker);
  t.after(() => rm(deniedFixture, { recursive: true, force: true }));
  const api = http.createServer((req, res) => {
    assert.equal(req.url, "/api/toolchain-control");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: 200, data: "local-proxy-control" }));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  t.after(() => new Promise((done) => api.close(done)));
  process.env.CINASHOP_API_PROXY_TARGET = `http://127.0.0.1:${api.address().port}`;
  const { initEnv } = require("@dcloudio/vite-plugin-uni/dist/cli/utils.js");
  initEnv("dev", { platform: "h5" });
  const { createServer } = require("vite");
  const server = await createServer({
    root: process.cwd(), configFile: resolve("vite.config.ts"),
    server: { port: 0 }, logLevel: "silent",
  });
  t.after(() => server.close());
  // Assert BEFORE listening: a config regression must not expose the test server.
  assert.equal(server.config.server.host, "127.0.0.1");
  assert.equal(server.config.server.cors, false);
  assert.equal(server.config.server.fs.strict, true);
  assert.deepEqual(server.config.server.fs.allow.map((path) => resolve(path)), [process.cwd()]);
  assert.notEqual(server.config.server.allowedHosts, true);
  assert.notEqual(server.config.legacy?.skipWebSocketTokenCheck, true);
  assert.equal(server.config.server.proxy["/api"].target, process.env.CINASHOP_API_PROXY_TARGET);
  await server.listen();
  const address = server.httpServer.address();
  assert.equal(address.address, "127.0.0.1");
  const port = address.port;

  await t.test("HTML, UniApp static assets, modules and same-origin API proxy still work", async () => {
    const page = await request(port, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /@vite\/client/);
    const logo = await request(port, "/static/logo.png");
    assert.equal(logo.status, 200);
    assert.match(logo.headers["content-type"], /^image\/png\b/);
    assert.deepEqual(logo.bytes, readFileSync("src/static/logo.png"));
    const module = await request(port, "/src/main.ts");
    assert.equal(module.status, 200);
    assert.match(module.body, /createSSRApp/);
    const response = await request(port, "/api/toolchain-control");
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).data, "local-proxy-control");
  });
  await t.test("foreign GET/OPTIONS cannot read source through permissive CORS", async () => {
    for (const origin of ["https://untrusted.example", "null"]) {
      for (const method of ["GET", "OPTIONS"]) {
        const response = await request(port, "/src/main.ts", { Origin: origin, "Access-Control-Request-Method": "GET" }, method);
        assert.equal(response.headers["access-control-allow-origin"], undefined);
      }
    }
  });
  await t.test("untrusted Host and tokenless browser WebSockets are rejected; authenticated HMR works", async () => {
    assert.equal((await request(port, "/", { Host: "untrusted.example" })).status, 403);
    for (const origin of ["https://untrusted.example", "null"]) {
      assert.equal(await upgrade(port, origin), 400);
    }
    assert.equal(await upgrade(port, `http://127.0.0.1:${port}`, server.config.webSocketToken), 101);
  });
  await t.test("ordinary and encoded outside-root file reads do not return the synthetic marker", async () => {
    const normalized = outside.replaceAll("\\", "/");
    for (const path of [`/@fs/${normalized}`, `/@fs/${normalized}?raw`, `/@fs/${normalized.replaceAll("/", "%2F")}`]) {
      const response = await request(port, path);
      assert.ok(!response.body.includes(marker), path);
      if (response.status === 200) {
        // Encoded non-files may fall back to the SPA shell; never accept file data.
        assert.match(response.headers["content-type"], /text\/html/, path);
        assert.match(response.body, /@vite\/client/, path);
      } else {
        assert.ok([403, 404].includes(response.status), path);
      }
    }
  });
  await t.test("denied in-root file stays private for plain, raw and import query forms", async () => {
    const normalized = denied.replaceAll("\\", "/");
    for (const suffix of ["", "?raw", "?import&raw", "?raw??", "?import&inline=1"]) {
      const response = await request(port, `/@fs/${normalized}${suffix}`);
      assert.equal(response.status, 403);
      assert.ok(!response.body.includes(marker));
    }
  });
});
