const assert = require("node:assert/strict");
const { readFileSync, readdirSync, mkdtempSync, realpathSync, rmSync } = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { tmpdir } = require("node:os");
const { basename, dirname, extname, join, resolve } = require("node:path");
const test = require("node:test");
const QRCode = require("qrcode-terminal/vendor/QRCode");
const levels = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");
const Jimp = require("jimp");
const { isAutomatorQrModule, inspectRuntimeGraph, runtimeI18nAudit } = require("./runtime-i18n-audit.cjs");

const DCLOUD = "3.0.0-4020920240930001";
const lock = JSON.parse(readFileSync(resolve(__dirname, "../package-lock.json"), "utf8"));
const locked = (name) => lock.packages[`node_modules/${name}`];
const QR_ADAPTER = "@dcloudio/uni-mp-weixin/lib/uni.automator.js";
const decoderMarkers = /(?:@dcloudio[\\/]uni-automator|@jimp[\\/]|(?:^|[\\/"'])\s*(?:jimp|jpeg-js|phin|qrcode-reader)(?:[\\/"']|$)|Tool\.enableRemoteDebug)/m;

function* filesUnder(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

function qrImage(value) {
  const qr = new QRCode(0, levels.H);
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const scale = 8;
  const quiet = 4;
  const image = new Jimp((count + quiet * 2) * scale, (count + quiet * 2) * scale, 0xffffffff);
  for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) {
    if (!qr.isDark(y, x)) continue;
    for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) {
      image.setPixelColor(0x000000ff, (x + quiet) * scale + xx, (y + quiet) * scale + yy);
    }
  }
  return image;
}

test("locked Weixin automator QR path and decoder versions remain explicit", () => {
  assert.equal(locked("@dcloudio/uni-automator").version, DCLOUD);
  assert.equal(locked("@dcloudio/uni-mp-weixin").version, DCLOUD);
  assert.equal(locked("@dcloudio/uni-mp-weixin").dependencies.jimp, "^0.10.1");
  assert.equal(locked("jimp").version, "0.10.3");
  assert.equal(locked("@jimp/core").version, "0.10.3");
  assert.equal(locked("@jimp/core").dependencies.phin, "^2.9.1");
  assert.equal(locked("@jimp/jpeg").version, "0.10.3");
  assert.equal(locked("@jimp/jpeg").dependencies["jpeg-js"], "^0.3.4");
  assert.equal(locked("jpeg-js").version, "0.3.7");
  assert.equal(locked("phin").version, "2.9.3");
  assert.equal(locked("load-bmfont/node_modules/phin").version, "3.7.1");
  for (const [name, version] of [["@dcloudio/uni-automator", DCLOUD], ["@dcloudio/uni-mp-weixin", DCLOUD],
    ["jimp", "0.10.3"], ["@jimp/core", "0.10.3"], ["@jimp/jpeg", "0.10.3"],
    ["jpeg-js", "0.3.7"], ["phin", "2.9.3"]]) {
    assert.equal(require(`${name}/package.json`).version, version, name);
  }
  const program = readFileSync(require.resolve("@dcloudio/uni-automator/dist/index.js"), "utf8");
  const weixin = readFileSync(require.resolve(QR_ADAPTER), "utf8");
  assert.match(program, /async remote\([^)]*\)/);
  assert.match(program, /this\.toolApi\.enableRemoteDebug\(/);
  assert.match(weixin, /"Tool\.enableRemoteDebug":\{reflect:async/);
  assert.match(weixin, /require\("jimp"\)\.read\(t\)/);
  assert.match(weixin, /s\.decode\(o\.bitmap\)/);
});

test("real Weixin adapter decodes synthetic PNG and JPEG QR bytes without HTTP", async () => {
  const value = "https://example.invalid/automator-qr-synthetic";
  const image = qrImage(value);
  const adapter = require(QR_ADAPTER).adapter["Tool.enableRemoteDebug"];
  const savedHttp = http.request;
  const savedHttps = https.request;
  let networkCalls = 0;
  http.request = https.request = () => { networkCalls++; throw new Error("QR adapter attempted a network request"); };
  try {
    for (const mime of [Jimp.MIME_PNG, Jimp.MIME_JPEG]) {
      const bytes = await image.getBufferAsync(mime);
      let toolCalls = 0;
      const result = await adapter.reflect(async (method, params, bypass) => {
        toolCalls++;
        assert.equal(method, "Tool.enableRemoteDebug");
        assert.deepEqual(params, { auto: false });
        assert.equal(bypass, false);
        return { qrCode: bytes.toString("base64") };
      }, { auto: false });
      assert.equal(result.qrCode, value, mime);
      assert.equal(toolCalls, 1, mime);
    }
    assert.equal(networkCalls, 0);
  } finally {
    http.request = savedHttp;
    https.request = savedHttps;
  }
});

test("current source does not invoke the optional automator remote path", () => {
  const sourceDirs = [resolve(__dirname, "../src"), resolve(__dirname, "../functions"), __dirname];
  let checked = 0;
  for (const dir of sourceDirs) for (const path of filesUnder(dir)) {
    // The Jest dependency audit intentionally loads the Node-only automator package.
    if (path === __filename || basename(path) === "jest-jsdom-once-boundary.test.cjs" || !/[.](?:js|cjs|mjs|ts|tsx|vue)$/.test(path)) continue;
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /@dcloudio\/uni-automator|uni\.automator(?:\.js)?|Tool\.enableRemoteDebug|\.remote\s*\(/, path);
    checked++;
  }
  for (const config of ["vite.config.ts", "vite.runtime-audit.config.ts", "vitest.config.ts"]) {
    const vite = readFileSync(resolve(__dirname, `../${config}`), "utf8");
    assert.doesNotMatch(vite, /@dcloudio\/uni-automator|UNI_AUTOMATOR_(?:HOST|PORT|WS_ENDPOINT)|--auto(?:Host|Port)/, config);
  }
  assert.ok(checked > 100);
});

test("ordinary H5, Weixin and App build resources omit the Node-only decoder chain", () => {
  for (const platform of ["h5", "mp-weixin", "app"]) {
    const dir = resolve(__dirname, `../dist/build/${platform}`);
    let checked = 0;
    for (const path of filesUnder(dir)) {
      if (![".js", ".mjs", ".cjs", ".html"].includes(extname(path))) continue;
      assert.doesNotMatch(readFileSync(path, "utf8"), decoderMarkers, path);
      checked++;
    }
    assert.ok(checked > 0, platform);
  }
});

test("runtime graph gate recognizes external and tree-shaken QR dependencies", (t) => {
  for (const id of ["jimp", "@jimp/jpeg", "jpeg-js", "phin", "qrcode-reader",
    "@dcloudio/uni-automator", "C:\\app\\node_modules\\@dcloudio\\uni-mp-weixin\\lib\\uni.automator.js",
    "\0jimp?commonjs-proxy"]) assert.equal(isAutomatorQrModule(id), true, id);
  for (const id of ["@dcloudio/uni-mp-weixin/dist/uni.compiler.js", "qrcode-terminal", "@dcloudio/uni-i18n"])
    assert.equal(isAutomatorQrModule(id), false, id);
  const ids = ["/app/src/main.ts", "@jimp/jpeg"];
  const context = {
    getModuleIds: () => ids,
    getModuleInfo: (id) => ({ isEntry: id === ids[0], isExternal: id === ids[1] }),
    error: (message) => { throw new Error(message); },
  };
  const bundle = { "main.js": { type: "chunk", modules: { [ids[0]]: { renderedLength: 10 } } } };
  assert.deepEqual(inspectRuntimeGraph(context, bundle, "/app").automatorQr, ["@jimp/jpeg"]);
  const base = realpathSync(tmpdir());
  const temporary = mkdtempSync(join(base, "cinashop-qr-audit-"));
  t.after(() => {
    const actual = realpathSync(temporary);
    assert.equal(dirname(actual), base);
    assert.match(basename(actual), /^cinashop-qr-audit-/);
    rmSync(actual, { recursive: true, force: true });
  });
  const savedCI = process.env.CI;
  const savedReport = process.env.CINASHOP_RUNTIME_I18N_REPORT;
  process.env.CI = "1";
  process.env.CINASHOP_RUNTIME_I18N_REPORT = join(temporary, "report.jsonl");
  try {
    const audit = runtimeI18nAudit();
    audit.configResolved({ root: "/app" });
    assert.throws(() => audit.generateBundle.call(context, {}, bundle), /reopen TEST-004D3/);
  } finally {
    if (savedCI === undefined) delete process.env.CI; else process.env.CI = savedCI;
    if (savedReport === undefined) delete process.env.CINASHOP_RUNTIME_I18N_REPORT;
    else process.env.CINASHOP_RUNTIME_I18N_REPORT = savedReport;
  }
});
