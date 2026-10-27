const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { createRequire } = require("node:module");
const net = require("node:net");
const { resolve } = require("node:path");
const test = require("node:test");

const DCLOUD = "3.0.0-4020920240930001";
const lock = JSON.parse(readFileSync(resolve(__dirname, "../package-lock.json"), "utf8"));
const locked = (name) => lock.packages[`node_modules/${name}`];

test("locked DCloud H5 CLI selects Express only for SSR and keeps the audited dependency path", () => {
  for (const name of ["@dcloudio/vite-plugin-uni", "express", "qs", "body-parser", "proxy-addr"]) {
    const expected = {
      "@dcloudio/vite-plugin-uni": DCLOUD,
      express: "4.22.2",
      qs: "6.15.3",
      "body-parser": "1.20.9",
      "proxy-addr": "2.0.8",
    }[name];
    assert.equal(locked(name).version, expected, name);
    assert.equal(require(`${name}/package.json`).version, expected, name);
  }
  assert.equal(locked("@dcloudio/vite-plugin-uni").dependencies.express, "^4.17.1");
  assert.equal(locked("express").dependencies.qs, "~6.15.1");
  assert.equal(locked("express").dependencies["proxy-addr"], "~2.0.7");
  assert.equal(locked("body-parser").dependencies.qs, "~6.16.0");

  // Resolve metadata from the real entries without loading either main module:
  // the later DCloud test still proves its original require-cache boundary.
  const fromBodyParser = createRequire(require.resolve("body-parser"));
  const parserQsPackage = fromBodyParser.resolve("qs/package.json");
  assert.equal(parserQsPackage, resolve(__dirname, "../node_modules/body-parser/node_modules/qs/package.json"));
  assert.equal(fromBodyParser("qs/package.json").version, "6.16.1");
  assert.equal(locked("body-parser/node_modules/qs").version, "6.16.1");
  assert.deepEqual(fromBodyParser("qs/package.json").dependencies, locked("body-parser/node_modules/qs").dependencies);
  assert.deepEqual(locked("body-parser/node_modules/qs").dependencies, {
    "es-define-property": "^1.0.1", "side-channel": "^1.1.1",
  });
  assert.equal(locked("body-parser/node_modules/qs").resolved, "https://registry.npmjs.org/qs/-/qs-6.16.1.tgz");
  assert.equal(locked("body-parser/node_modules/qs").integrity,
    "sha512-5Px6J7rfHBAGUhNQ3es4YzcOdBBw0SDcVtThJml4RdnKw4tKs2epA0kPZ+K8X+WiHktT93RHVcQ/3ym5aTCgtg==");
  assert.equal(locked("body-parser").resolved, "https://registry.npmjs.org/body-parser/-/body-parser-1.20.9.tgz");
  assert.equal(locked("body-parser").integrity,
    "sha512-FISIQxV5u91Y9gvuFq3q/tA/qTqLJn3AhRcEvyozyhJTh5OBFFtv827AdHU7Rbyct4r+Ba1/99oFa1Y3yuFsdw==");
  assert.deepEqual(require("body-parser/package.json").dependencies, locked("body-parser").dependencies);
  const fromExpress = createRequire(require.resolve("express"));
  assert.equal(fromExpress.resolve("qs/package.json"), require.resolve("qs/package.json"));
  assert.equal(fromExpress("qs/package.json").version, "6.15.3");
  assert.notEqual(parserQsPackage, fromExpress.resolve("qs/package.json"));

  const cli = readFileSync(require.resolve("@dcloudio/vite-plugin-uni/dist/cli/index.js"), "utf8");
  const action = readFileSync(require.resolve("@dcloudio/vite-plugin-uni/dist/cli/action.js"), "utf8");
  const server = readFileSync(require.resolve("@dcloudio/vite-plugin-uni/dist/cli/server.js"), "utf8");
  const express = readFileSync(require.resolve("express/lib/application.js"), "utf8");
  const utils = readFileSync(require.resolve("express/lib/utils.js"), "utf8");
  assert.match(cli, /\.option\('-ssr',[\s\S]*?default:\s*false/);
  assert.match(action, /options\.ssr\s*\?\s*\(0, server_1\.createSSRServer\)\(options\)\s*:\s*\(0, server_1\.createServer\)\(options\)/);
  assert.match(action, /options\.ssr && options\.platform === 'h5'[\s\S]*?\(0, build_1\.buildSSR\)\(options\)[\s\S]*?:\s*\(0, build_1\.build\)\(options\)/);
  assert.match(server, /require\('express'\)/);
  assert.match(server, /options\.host === undefined \|\| options\.host === true/);
  assert.match(server, /app\.listen\(port, hostname, onSuccess\)/);
  assert.match(express, /this\.set\('query parser', 'extended'\)/);
  assert.match(utils, /function parseExtendedQueryString\(str\)\s*\{\s*return qs\.parse\(str,/);
});

// Each real HTTP case owns a fresh child process and temporary loopback port.
// The helper refuses old body-parser installations and bounds payload and time.
function compressionProbe(kind, encoding, mode, consumer) {
  const child = spawnSync(process.execPath, ["--unhandled-rejections=strict",
    resolve(__dirname, "body-parser-compression-probe.cjs"), kind, encoding, mode, consumer], {
    cwd: resolve(__dirname, ".."), encoding: "utf8", timeout: 10000, maxBuffer: 64 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const result = JSON.parse(child.stdout);
  assert.deepEqual([result.kind, result.encoding, result.mode], [kind, encoding, mode]);
  assert.equal(result.parserVersion, "1.20.9");
  assert.equal(result.ownedHost, "127.0.0.1");
  assert.ok(Number.isInteger(result.port) && result.port > 0);
  assert.ok(result.decodedBodyBytes > 0 && result.decodedBodyBytes < 1024);
  assert.ok(result.requestBodyBytes > 0 && result.requestBodyBytes < 2048);
  assert.equal(result.requestEnded, true);
  assert.equal(result.requestComplete, true);
  assert.equal(result.healthyAfterTrailingDelay, true);
  assert.equal(result.healthStatus, 204);
  assert.equal(result.observationDelayMs, 100);
  assert.equal(result.rawConsumer, consumer === "raw");
  if (consumer === "raw") {
    assert.match(result.rawSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.rawSha256, result.expectedRawSha256);
    assert.equal(result.rawBytes, result.requestBodyBytes);
    assert.ok(result.events.includes("raw-finish"));
  } else {
    assert.equal(result.rawSha256, null);
    assert.equal(result.expectedRawSha256, null);
    assert.equal(result.rawBytes, null);
    assert.equal(result.events.includes("raw-finish"), false);
  }
  const event = name => {
    assert.equal(result.events.filter(item => item === name).length, 1, name);
    return result.events.indexOf(name);
  };
  assert.ok(event("request-end") < event("response-end"));
  assert.ok(event("response-end") < event("health-end"));
  assert.equal(result.parsedBeforeTail, mode === "trailing");
  if (mode === "trailing") {
    assert.ok(event("parser-callback") < event("send-tail"));
    assert.ok(event("send-tail") < event("request-end"));
  } else assert.equal(result.events.includes("send-tail"), false);
  if (mode === "charset") {
    assert.equal(result.errorType, "charset.unsupported");
    assert.equal(result.verifyCalls, 0);
    assert.equal(result.body, null);
  } else {
    assert.equal(result.errorType, null);
    assert.equal(result.verifyCalls, 1);
    assert.deepEqual(result.body, { a: kind === "json" ? 1 : "1", item: { id: "42" }, word: "safe" });
  }
}

for (const kind of ["json", "urlencoded"]) {
  for (const encoding of ["gzip", "deflate"]) {
    test(`patched body-parser ${kind}/${encoding} preserves a second raw consumer`, { timeout: 12000 }, () => {
      compressionProbe(kind, encoding, "normal", "raw");
    });
    test(`patched body-parser ${kind}/${encoding} preserves delayed trailing bytes for a second raw consumer`, { timeout: 12000 }, () => {
      compressionProbe(kind, encoding, "trailing", "raw");
    });
    test(`patched body-parser ${kind}/${encoding} drains delayed trailing bytes without another consumer`, { timeout: 12000 }, () => {
      compressionProbe(kind, encoding, "trailing", "none");
    });
  }
}
test("patched body-parser rejects unsupported charset without consuming the second raw stream", { timeout: 12000 }, () => {
  compressionProbe("json", "gzip", "charset", "raw");
});

test("patched proxy-addr does not trust IPv4 through a malformed mapped subnet", () => {
  const proxyaddr = require("proxy-addr");
  const malformed = proxyaddr.compile("::ffff:10.0.0.0/8");
  const mapped = proxyaddr.compile("::ffff:10.0.0.0/104");
  assert.equal(malformed("203.0.113.9", 0), false);
  assert.equal(malformed("10.1.2.3", 0), false);
  assert.equal(mapped("203.0.113.9", 0), false);
  assert.equal(mapped("10.1.2.3", 0), true);
});

test("current H5 scripts and manifest leave SSR disabled", () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../src/manifest.json"), "utf8"));
  assert.equal(pkg.scripts["dev:h5"], "node scripts/h5-ssr-guard.cjs");
  assert.equal(pkg.scripts["build:h5"], "node scripts/h5-ssr-guard.cjs build");
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (!/^(?:dev|build):/.test(name)) continue;
    assert.doesNotMatch(command, /(?:^|\s)-(?:ssr|-ssr)(?:\s|$)/, name);
  }
  assert.equal(Object.hasOwn(manifest.h5, "ssr"), false);
  for (const name of ["entry-server.js", "entry-server.ts", "entry-server.mjs"]) {
    assert.equal(existsSync(resolve(__dirname, "../src", name)), false, name);
  }
  const viteConfig = readFileSync(resolve(__dirname, "../vite.config.ts"), "utf8");
  assert.match(viteConfig, /host:\s*["']127\.0\.0\.1["']/);
});

test("real DCloud server entrypoints defer Express and pass undefined host in SSR", async () => {
  const expressId = require.resolve("express");
  const qsId = require.resolve("qs");
  const bodyParserId = require.resolve("body-parser");
  const vite = require("vite");
  const dcloud = require("@dcloudio/vite-plugin-uni/dist/cli/server.js");
  const savedViteServer = vite.createServer;
  const savedViteLogger = vite.createLogger;
  const savedHttp = http.request;
  const savedHttps = https.request;
  const savedNetListen = net.Server.prototype.listen;
  const logger = { info() {}, hasWarned: false };
  const socketAttempt = new Error("unexpected socket or HTTP request");
  const stopBeforeVite = new Error("Vite startup intercepted after Express loading");
  const stopBeforeListen = new Error("Express listen intercepted before binding");
  const viteOptions = [];
  const listens = [];
  let ordinaryListen = 0;
  let mode = "ordinary";

  assert.equal(require.cache[expressId], undefined);
  assert.equal(require.cache[qsId], undefined);
  assert.equal(require.cache[bodyParserId], undefined);
  try {
    http.request = https.request = () => { throw socketAttempt; };
    net.Server.prototype.listen = () => { throw socketAttempt; };
    vite.createLogger = () => logger;
    vite.createServer = async (options) => {
      viteOptions.push(options);
      if (mode === "ssr-load-only") throw stopBeforeVite;
      return mode === "ordinary" ? {
        listen: async () => { ordinaryListen++; },
        printUrls() {},
        config: { logger },
      } : {
        middlewares(_req, _res, next) { next(); },
        config: { server: { host: "127.0.0.1", port: 5174 }, base: "/", logger },
      };
    };
    await dcloud.createServer({ platform: "h5" });
    assert.equal(ordinaryListen, 1);
    assert.equal(require.cache[expressId], undefined);
    assert.equal(require.cache[qsId], undefined);
    assert.equal(require.cache[bodyParserId], undefined);

    mode = "ssr-load-only";
    await assert.rejects(dcloud.createSSRServer({ platform: "h5" }), (error) => error === stopBeforeVite);
    assert.ok(require.cache[expressId]);
    assert.ok(require.cache[qsId]);
    assert.ok(require.cache[bodyParserId]);

    const express = require("express");
    const qs = require("qs");
    const savedExpressListen = express.application.listen;
    const savedParse = qs.parse;
    let queryParses = 0;
    try {
      qs.parse = (...args) => { queryParses++; return savedParse(...args); };
      express.application.listen = function (port, host) {
        assert.equal(this.get("query parser"), "extended");
        assert.equal(this.get("trust proxy"), false);
        assert.equal(this.get("trust proxy fn")("::ffff:192.0.2.4", 0), false);
        assert.deepEqual(this.get("query parser fn")("item[id]=42"), { item: { id: "42" } });
        listens.push({ port, host, middleware: this._router.stack.map((layer) => layer.name) });
        throw stopBeforeListen;
      };
      mode = "ssr";
      await assert.rejects(dcloud.createSSRServer({ platform: "h5" }), (error) => error === stopBeforeListen);
      await assert.rejects(dcloud.createSSRServer({ platform: "h5", host: "127.0.0.1" }),
        (error) => error === stopBeforeListen);
      assert.equal(queryParses, 2);
    } finally {
      express.application.listen = savedExpressListen;
      qs.parse = savedParse;
    }
    assert.equal(viteOptions.length, 4);
    for (const options of viteOptions.slice(1)) assert.equal(options.server.middlewareMode, true);
    assert.deepEqual(listens.map(({ port, host }) => ({ port, host })), [
      { port: 5174, host: undefined },
      { port: 5174, host: "127.0.0.1" },
    ]);
    for (const listen of listens) assert.ok(listen.middleware.includes("query"));
  } finally {
    vite.createServer = savedViteServer;
    vite.createLogger = savedViteLogger;
    http.request = savedHttp;
    https.request = savedHttps;
    net.Server.prototype.listen = savedNetListen;
  }
});

test("new qs comma advisory still affects the optional root serializer, while nested body-parser qs is patched", () => {
  const root = require("qs");
  const nested = createRequire(require.resolve("body-parser"))("qs");
  assert.equal(require("qs/package.json").version, "6.15.3");
  assert.equal(createRequire(require.resolve("body-parser"))("qs/package.json").version, "6.16.1");
  for (const encodeValuesOnly of [false, true]) {
    const options = { arrayFormat:"comma", encodeValuesOnly };
    for (const payload of [
      () => JSON.parse('{"a":[{"toString":"x"}]}'),
      () => root.parse('a[0][toString]=x', { allowPrototypes:true }),
      () => root.parse('a[][b]=c', { plainObjects:true }),
    ]) {
      assert.throws(() => root.stringify(payload(), options), TypeError);
      let result;
      assert.doesNotThrow(() => { result = nested.stringify(payload(), options); });
      assert.equal(typeof result, "string");
    }
    assert.equal(root.stringify({a:['x','y']}, options), encodeValuesOnly ? 'a=x,y' : 'a=x%2Cy');
    assert.equal(nested.stringify({a:['x','y']}, options), encodeValuesOnly ? 'a=x,y' : 'a=x%2Cy');
  }
});
