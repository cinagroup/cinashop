const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const test = require("node:test");
const { isIntlifyModule, inspectRuntimeGraph, runtimeI18nAudit } = require("./runtime-i18n-audit.cjs");

test("inventory recognizes package, vendored, virtual and external Intlify representations", () => {
  for (const id of ["vue-i18n", "vue-i18n/dist/runtime.js", "@intlify/core-base", "/app/node_modules/vue-i18n/dist/index.js", "C:\\app\\node_modules\\@intlify\\shared\\index.js", "\0/app/node_modules/@dcloudio/uni-cli-shared/lib/vue-i18n/dist/runtime.js?commonjs-proxy"]) {
    assert.equal(isIntlifyModule(id), true, id);
  }
  for (const id of ["vue", "@vue/shared", "/app/node_modules/@dcloudio/uni-i18n/dist/uni-i18n.es.js", "/app/src/i18n.ts"]) {
    assert.equal(isIntlifyModule(id), false, id);
  }
});

test("inventory does not hide external or loaded-but-tree-shaken Intlify consumers", () => {
  const ids = ["/app/src/main.ts", "@intlify/core-base", "/app/node_modules/vue-i18n/dist/index.js"];
  const context = {
    getModuleIds: () => ids,
    getModuleInfo: (id) => ({ isEntry: id === ids[0], isExternal: id === ids[1] }),
  };
  const result = inspectRuntimeGraph(context, { "main.js": { type: "chunk", modules: { [ids[0]]: { renderedLength: 10 } } } }, "/app");
  assert.equal(result.hasMain, true);
  assert.equal(result.intlify.length, 2);
  assert.deepEqual(result.externals, [ids[1]]);
  assert.throws(() => inspectRuntimeGraph({ ...context, getModuleInfo: () => null }, {}, "/app"), /Missing Rollup/);
  const windowsId = "C:/app/src/main.ts";
  const windows = inspectRuntimeGraph({ getModuleIds: () => [windowsId], getModuleInfo: () => ({ isEntry: true }) }, {}, "C:\\app");
  assert.deepEqual(windows.entries, ["src/main.ts"]);
  const assetOnly = inspectRuntimeGraph({ getModuleIds: () => [], getModuleInfo: () => null }, {
    "app-renderjs.js": { type: "asset", fileName: "app-renderjs.js", source: "minified" },
    "app-wxs.js": { type: "asset", fileName: "app-wxs.js", source: "minified" },
    "main.css": { type: "asset", fileName: "main.css", source: "" },
  }, "/app");
  assert.deepEqual(assetOnly.separateScriptModules, []);
  assert.deepEqual(assetOnly.separateScriptAssets, ["app-renderjs.js", "app-wxs.js"]);
});

test("real Rollup generation fails when a new external Intlify consumer enters the graph", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "cinashop-i18n-negative-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const previousCI = process.env.CI;
  const previousReport = process.env.CINASHOP_RUNTIME_I18N_REPORT;
  process.env.CI = "1";
  process.env.CINASHOP_RUNTIME_I18N_REPORT = join(fixture, "negative.jsonl");
  t.after(() => {
    if (previousCI === undefined) delete process.env.CI; else process.env.CI = previousCI;
    if (previousReport === undefined) delete process.env.CINASHOP_RUNTIME_I18N_REPORT;
    else process.env.CINASHOP_RUNTIME_I18N_REPORT = previousReport;
  });
  const audit = runtimeI18nAudit();
  audit.configResolved({ root: fixture });
  const build = await require("rollup").rollup({
    input: "virtual:audit-entry", external: ["@intlify/core-base"],
    plugins: [{ name: "inert-audit-input", resolveId: (id) => id === "virtual:audit-entry" ? id : null,
      load: (id) => id === "virtual:audit-entry" ? "import { translate } from '@intlify/core-base'; export default translate;" : null }, audit],
  });
  t.after(() => build.close());
  await assert.rejects(build.generate({ format: "es" }), /reopen TEST-004D3A/);
  assert.deepEqual(JSON.parse(readFileSync(join(fixture, "negative.jsonl"), "utf8")).intlify, ["@intlify/core-base"]);
});

for (const type of ["renderjs", "wxs"]) {
  test(`real DCloud ${type} independent bundling cannot bypass the audit`, async (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "cinashop-i18n-separate-"));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const env = { CI: "1", CINASHOP_RUNTIME_I18N_REPORT: join(fixture, "negative.jsonl"), UNI_INPUT_DIR: resolve("src") };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    const entry = resolve("src/main.ts").replaceAll("\\", "/");
    // Virtual source only: esbuild resolves installed dependencies, but no file is
    // created in src and neither this generated script nor Intlify is executed.
    const separate = resolve("src/audit-only-in-memory.vue").replaceAll("\\", "/") + `?vue&type=${type}&name=audit`;
    const compiler = require("@dcloudio/uni-app-vite/dist/vue/plugins/renderjs").uniRenderjsPlugin();
    compiler.config({ build: {} });
    compiler.configResolved({ isProduction: type === "wxs" }); // Also cover minified output.
    const audit = runtimeI18nAudit();
    audit.configResolved({ root: process.cwd() });
    let observed;
    const build = await require("rollup").rollup({
      input: entry,
      plugins: [{ name: "inert-separate-script-input", resolveId: (id) => [entry, separate].includes(id) ? id : null,
        load: (id) => id === entry ? `import install from ${JSON.stringify(separate)}; export default install;`
          : id === separate ? "import { createI18n } from 'vue-i18n'; window.__auditCreateI18n = createI18n; export default {};" : null },
        compiler,
        { name: "observe-real-separate-asset", generateBundle(_options, bundle) {
          observed = inspectRuntimeGraph(this, bundle, process.cwd());
          const asset = bundle[`app-${type}.js`];
          assert.equal(asset.type, "asset");
          assert.ok(asset.source.length > 1_000);
          if (type === "renderjs") assert.match(asset.source, /@intlify/);
        } }, audit],
    });
    t.after(() => build.close());
    await assert.rejects(build.generate({ format: "es" }), /Separately compiled.*reopen TEST-004D3A/);
    // The former check would pass despite bundled Intlify: its imports are no
    // longer in Rollup. Detect the independent pipeline, not minifiable strings.
    assert.equal(observed.hasMain, true);
    assert.deepEqual(observed.intlify, []);
    assert.deepEqual(observed.separateScriptModules, [`src/audit-only-in-memory.vue?vue&type=${type}&name=audit`]);
    assert.deepEqual(observed.separateScriptAssets, [`app-${type}.js`]);
    const report = JSON.parse(readFileSync(env.CINASHOP_RUNTIME_I18N_REPORT, "utf8"));
    assert.deepEqual(report.separateScriptAssets, observed.separateScriptAssets);
  });
}

test("actual DCloud formatter preserves literal dotted keys, parameters and locale switching", () => {
  const { initVueI18n } = require("@dcloudio/uni-i18n");
  const marker = "cinashop_i18n_boundary_marker";
  assert.equal(Object.hasOwn(Object.prototype, marker), false);
  const runtime = initVueI18n("en", {
    en: { "greeting.name": "Hello {name}", amount: "Count {0}", [`__proto__.${marker}`]: "literal", [`constructor.prototype.${marker}`]: "also-literal" },
    "zh-Hans": { "greeting.name": "你好 {name}" },
  });
  assert.equal(runtime.t("greeting.name", { name: "CinaShop" }), "Hello CinaShop");
  assert.equal(runtime.t("amount", [3]), "Count 3");
  assert.equal(runtime.t(`__proto__.${marker}`), "literal");
  assert.equal(runtime.t(`constructor.prototype.${marker}`), "also-literal");
  assert.equal(Object.hasOwn(Object.prototype, marker), false);
  runtime.setLocale("zh-CN");
  assert.equal(runtime.getLocale(), "zh-Hans");
  assert.equal(runtime.t("greeting.name", { name: "CinaShop" }), "你好 CinaShop");
  // DCloud's formatter is not an HTML sanitizer; this is not an HTML sink test.
});

function runCli(platform, output, report) {
  const packagePath = require.resolve("@dcloudio/vite-plugin-uni/package.json");
  const cli = join(dirname(packagePath), require(packagePath).bin.uni);
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli, "build", "-p", platform, "--config", "vite.runtime-audit.config.ts", "--outDir", output], {
      cwd: process.cwd(), windowsHide: true,
      env: { ...process.env, CI: "1", CINASHOP_API_PROXY_TARGET: "http://127.0.0.1:9", CINASHOP_RUNTIME_I18N_REPORT: report,
        UNI_INPUT_DIR: resolve("src"), VITE_ROOT_DIR: process.cwd(), UNI_OUTPUT_DIR: output,
        UNI_APP_X: "", UNI_COMPILER: "", UNI_RENDERER: "", UNI_COMPILE_TARGET: "", UNI_AUTOMATOR_WS_ENDPOINT: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const collect = (chunk) => { log = (log + chunk).slice(-40_000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill(), 150_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`UniApp ${platform} audit build failed (${code}/${signal})\n${log}`));
      else resolveResult();
    });
  });
}

function nonempty(path) {
  assert.ok(statSync(path).isFile() && statSync(path).size > 0, path);
  return readFileSync(path);
}

for (const platform of ["h5", "mp-weixin", "app"]) {
  test(`actual ${platform} CLI build keeps Intlify out of its audited business graph`, { timeout: 180_000 }, async (t) => {
    const temporary = mkdtempSync(join(tmpdir(), "cinashop-i18n-build-"));
    t.after(() => rmSync(temporary, { recursive: true, force: true })); // Only this newly created build fixture.
    const output = join(temporary, platform);
    const report = join(temporary, "inventory.jsonl");
    await runCli(platform, output, report);
    const records = readFileSync(report, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.map((r) => r.compiler).sort(), platform === "app" ? ["nvue", "vue"] : ["default"]);
    for (const record of records) {
      assert.equal(record.platform, platform);
      assert.ok(record.chunks > 0 && record.loadedModules > 0 && record.entries.length > 0);
      assert.deepEqual(record.intlify, []);
      assert.deepEqual(record.separateScriptModules, []);
      assert.deepEqual(record.separateScriptAssets, []);
      if (record.compiler !== "nvue") assert.equal(record.hasMain, true);
      assert.deepEqual(record.externals, record.compiler === "vue" ? ["@vue/shared", "vue"] : []);
    }
    const copied = [];
    if (platform === "app") {
      nonempty(join(output, "app-service.js"));
      nonempty(join(output, "__uniappview.html"));
      const manifest = JSON.parse(nonempty(join(output, "manifest.json")));
      assert.equal(manifest.name, require("../src/manifest.json").name);
      const template = join(dirname(require.resolve("@dcloudio/uni-app-vite/package.json")), "lib/template");
      const files = readdirSync(template).filter((file) => file !== "__uniappview.html");
      const sources = files.map((file) => [file, join(template, file)]);
      sources.push(["uni-app-view.umd.js", require.resolve("@dcloudio/uni-app-plus/dist/uni-app-view.umd.js")]);
      for (const [file, source] of sources) {
        const bytes = nonempty(join(output, file));
        assert.deepEqual(bytes, readFileSync(source), file);
        copied.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
      // Exact provenance is NOT proof of arbitrary prebundled/native code safety.
    } else {
      nonempty(join(output, platform === "h5" ? "index.html" : "app.js"));
      assert.ok(records[0].dcloudI18n.some((module) => module.renderedLength > 0));
    }
    console.log(JSON.stringify({ runtimeI18nAudit: platform, records, copied,
      excluded: platform === "app" ? ["native-device-Vue", "APK/IPA", "prebundled-code-not-module-graph"] : [] }));
  });
}
