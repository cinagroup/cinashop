const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { resolve } = require("node:path");
const test = require("node:test");

const DCLOUD = "3.0.0-4020920240930001";
const lock = JSON.parse(readFileSync(resolve(__dirname, "../package-lock.json"), "utf8"));
const locked = (name) => lock.packages[`node_modules/${name}`];

test("locked DCloud H5 CLI selects Express only for SSR and keeps the audited dependency path", () => {
  for (const name of ["@dcloudio/vite-plugin-uni", "express", "qs", "body-parser"]) {
    const expected = {
      "@dcloudio/vite-plugin-uni": DCLOUD,
      express: "4.22.2",
      qs: "6.15.3",
      "body-parser": "1.20.6",
    }[name];
    assert.equal(locked(name).version, expected, name);
    assert.equal(require(`${name}/package.json`).version, expected, name);
  }
  assert.equal(locked("@dcloudio/vite-plugin-uni").dependencies.express, "^4.17.1");
  assert.equal(locked("express").dependencies.qs, "~6.15.1");
  assert.equal(locked("body-parser").dependencies.qs, "~6.15.1");

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

test("current H5 scripts and manifest leave SSR disabled", () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../src/manifest.json"), "utf8"));
  assert.equal(pkg.scripts["dev:h5"], "uni");
  assert.equal(pkg.scripts["build:h5"], "uni build");
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
