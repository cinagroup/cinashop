const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const http = require("node:http");
const { dirname, join, relative, resolve } = require("node:path");
const test = require("node:test");
const { assertDefaultViteFsAllow } = require("./vite-fs-allow-test-helper.cjs");

// Keep real filesystem access and watcher behavior. Vite 5 may register a
// watcher after close(); close that owned late handle so this process drains.
const originalWatch = fs.watch;
const ownedWatchers = new Set();
let closingWatchers = false;
fs.watch = function (...args) {
  const watcher = Reflect.apply(originalWatch, this, args);
  if (closingWatchers) watcher.close();
  else {
    ownedWatchers.add(watcher);
    watcher.once("close", () => ownedWatchers.delete(watcher));
  }
  return watcher;
};
test.after(async () => {
  closingWatchers = true;
  await Promise.all([...ownedWatchers].map((watcher) => {
    const closed = once(watcher, "close");
    watcher.close();
    return closed;
  }));
  assert.equal(ownedWatchers.size, 0);
  process.once("beforeExit", () => { fs.watch = originalWatch; });
});

const previousCI = process.env.CI;
const previousProxy = process.env.CINASHOP_API_PROXY_TARGET;
// DCloud otherwise posts build/device metadata from its update checker.
process.env.CI = "1";
test.after(() => {
  if (previousCI === undefined) delete process.env.CI;
  else process.env.CI = previousCI;
  if (previousProxy === undefined) delete process.env.CINASHOP_API_PROXY_TARGET;
  else process.env.CINASHOP_API_PROXY_TARGET = previousProxy;
});

function request(port, path) {
  // Pass request-target directly: URL() would normalize the ../ payload away.
  return new Promise((resolveResponse, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path }, (res) => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolveResponse({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

const normalized = path => path.replaceAll("\\", "/");
function assertPrivateMapNotServed(response, marker) {
  assert.ok(!response.body.includes(marker), "optimized map response exposed an inert private-file marker");
  if (response.status === 200) {
    // H5 may fall back to its public SPA shell after the optimizer rejects the
    // path. Require that actual shell, rather than accepting any empty/error map.
    assert.match(response.headers["content-type"], /text\/html/u);
    assert.match(response.body, /@vite\/client/u);
  } else {
    assert.ok([403, 404].includes(response.status), `unexpected map response status ${response.status}`);
  }
}
const sourceMap = marker => JSON.stringify({
  version: 3, file: "inert.js", sources: ["inert.ts"],
  sourcesContent: [marker], names: [], mappings: "",
});

test("real UniApp optimized-dependency maps respect fs allow and deny", { timeout: 90_000 }, async (t) => {
  const root = process.cwd();
  // A sibling stays on the same volume and outside the actual frontend root.
  // Both files are fresh inert maps; no existing source or credential is read.
  const outsideFixture = await mkdtemp(join(dirname(root), ".vite-map-outside-"));
  const deniedFixture = await mkdtemp(join(root, ".toolchain-map-fixture-"));
  const outsideMap = join(outsideFixture, "inert.map");
  const deniedMap = join(deniedFixture, ".env.map");
  const outsideMarker = "INERT_OUTSIDE_VITE_MAP_ALLOW_FIXTURE";
  const deniedMarker = "INERT_IN_ROOT_VITE_MAP_DENY_FIXTURE";
  let server;
  let api;
  t.after(async () => {
    await server?.close();
    if (api?.listening) await new Promise(done => api.close(done));
    // Verify the exact fresh targets before recursive fixture cleanup.
    assert.equal(dirname(resolve(outsideFixture)), dirname(root));
    assert.equal(dirname(resolve(deniedFixture)), root);
    await rm(outsideFixture, { recursive: true, force: true });
    await rm(deniedFixture, { recursive: true, force: true });
  });
  await writeFile(outsideMap, sourceMap(outsideMarker));
  await writeFile(deniedMap, sourceMap(deniedMarker));

  api = http.createServer((req, res) => {
    assert.equal(req.url, "/api/map-security-control");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: 200, data: "isolated-local-proxy" }));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  process.env.CINASHOP_API_PROXY_TARGET = `http://127.0.0.1:${api.address().port}`;
  const { initEnv } = require("@dcloudio/vite-plugin-uni/dist/cli/utils.js");
  initEnv("dev", { platform: "h5" });
  const { createServer } = require("vite");
  server = await createServer({
    root, configFile: resolve("vite.config.ts"),
    server: { port: 0 }, logLevel: "silent",
  });
  // Validate the resolved real DCloud/Vite configuration before listening.
  assert.equal(server.config.server.host, "127.0.0.1");
  assert.equal(server.config.server.cors, false);
  assert.equal(server.config.server.fs.strict, true);
  assertDefaultViteFsAllow(server.config.server.fs.allow, root);
  assert.equal(server.config.server.proxy["/api"].target, process.env.CINASHOP_API_PROXY_TARGET);
  await server.listen();
  const address = server.httpServer.address();
  assert.equal(address.address, "127.0.0.1");
  const port = address.port;

  // Derive the actual optimizer prefix, rather than assuming a fixed cacheDir.
  const cacheDir = resolve(server.config.cacheDir);
  const cacheRelative = normalized(relative(root, cacheDir));
  const prefix = cacheRelative.startsWith("../")
    ? `/@fs/${normalized(cacheDir).replace(/^\//, "")}`
    : `/${cacheRelative}`;
  const mapTraversal = file => `${prefix}/deps/${normalized(relative(join(cacheDir, "deps"), file))}`;
  for (const file of [outsideMap, deniedMap]) {
    assert.equal(resolve(cacheDir, "deps", relative(join(cacheDir, "deps"), file)), file);
    assert.ok(normalized(relative(join(cacheDir, "deps"), file)).startsWith("../"));
  }
  t.diagnostic(`Vite ${require("vite/package.json").version}; actual optimized-dependency prefix ${prefix}`);

  await t.test("normal UniApp module and the isolated API proxy remain usable", async () => {
    const module = await request(port, "/src/main.ts");
    assert.equal(module.status, 200);
    assert.match(module.body, /createSSRApp/);
    const control = await request(port, "/api/map-security-control");
    assert.equal(control.status, 200);
    assert.equal(JSON.parse(control.body).data, "isolated-local-proxy");
  });
  await t.test("outside-root map blocked directly is also blocked through optimized-deps traversal", async () => {
    const direct = await request(port, `/@fs/${normalized(outsideMap)}`);
    assert.equal(direct.status, 403);
    assert.ok(!direct.body.includes(outsideMarker));
    const traversed = await request(port, mapTraversal(outsideMap));
    t.diagnostic(`outside map: direct=${direct.status}, optimized traversal=${traversed.status}, marker=${traversed.body.includes(outsideMarker)}`);
    assertPrivateMapNotServed(traversed, outsideMarker);
  });
  await t.test("in-root .env.map denied directly is also denied through optimized-deps traversal", async () => {
    const direct = await request(port, `/@fs/${normalized(deniedMap)}`);
    assert.equal(direct.status, 403);
    assert.ok(!direct.body.includes(deniedMarker));
    const traversed = await request(port, mapTraversal(deniedMap));
    t.diagnostic(`denied map: direct=${direct.status}, optimized traversal=${traversed.status}, marker=${traversed.body.includes(deniedMarker)}`);
    assertPrivateMapNotServed(traversed, deniedMarker);
  });
});
