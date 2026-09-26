const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");
const test = require("node:test");
const { inspectRuntimeGraph, isJestJsdomOnceModule, runtimeI18nAudit } = require("./runtime-i18n-audit.cjs");

const root = resolve(__dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const locked = (name) => lock.packages[`node_modules/${name}`];
const versions = {
  "@dcloudio/uni-automator": "3.0.0-4020920240930001",
  jest: "27.0.4",
  "jest-cli": "27.5.1",
  "jest-config": "27.5.1",
  "jest-runner": "27.5.1",
  "jest-environment-jsdom": "27.5.1",
  "jest-environment-node": "27.5.1",
  jsdom: "16.7.0",
  "http-proxy-agent": "4.0.1",
  "@tootallnate/once": "1.1.2",
};

function* filesUnder(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(file);
    else if (entry.isFile()) yield file;
  }
}

function nodeProbe(code, args = []) {
  const result = spawnSync(process.execPath, ["-e", code, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CI: "1", UNI_AUTOMATOR_WS_ENDPOINT: "" },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
}

test("locked automator peer → Jest → jsdom → HTTP proxy agent → scoped once path", () => {
  for (const [name, version] of Object.entries(versions)) {
    assert.equal(locked(name)?.version, version, `lock: ${name}`);
    const installed = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
    assert.equal(installed.version, version, `installed: ${name}`);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.devDependencies["@dcloudio/uni-automator"], versions["@dcloudio/uni-automator"]);
  assert.equal(locked("@dcloudio/uni-automator").peerDependencies.jest, versions.jest);
  assert.equal(locked("@dcloudio/uni-automator").peerDependencies["jest-environment-node"], versions["jest-environment-node"]);
  assert.equal(locked("jest").dependencies["jest-cli"], "^27.0.4");
  assert.equal(locked("jest-cli").dependencies["jest-config"], "^27.5.1");
  assert.equal(locked("jest-config").dependencies["jest-environment-jsdom"], "^27.5.1");
  assert.equal(locked("jest-runner").dependencies["jest-environment-jsdom"], "^27.5.1");
  assert.equal(locked("jest-environment-jsdom").dependencies.jsdom, "^16.6.0");
  assert.equal(locked("jsdom").dependencies["http-proxy-agent"], "^4.0.1");
  assert.equal(locked("http-proxy-agent").dependencies["@tootallnate/once"], "1");

  const env = readFileSync(join(root, "node_modules/jest-environment-jsdom/build/index.js"), "utf8");
  const agents = readFileSync(join(root, "node_modules/jsdom/lib/jsdom/living/helpers/agent-factory.js"), "utf8");
  const proxy = readFileSync(join(root, "node_modules/http-proxy-agent/dist/agent.js"), "utf8");
  assert.match(env, /new \(_jsdom\(\)\.JSDOM\)/);
  assert.match(env, /runScripts: 'dangerously'/);
  assert.match(agents, /require\("http-proxy-agent"\)/);
  assert.match(agents, /if \(proxy\)\s*\{/);
  assert.match(proxy, /require\("@tootallnate\/once"\)/);
  assert.match(proxy, /once_1\.default\(socket, 'connect'\)/);
});

test("current scripts and actual Jest configuration use Node tests, without jsdom opt-in", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(Object.hasOwn(pkg, "jest"), false);
  assert.match(pkg.scripts["test:toolchain"], /^node --test /);
  for (const [name, command] of Object.entries(pkg.scripts)) {
    assert.doesNotMatch(command, /(?:^|[\s;&|])(?:npx\s+|npm\s+exec\s+)?jest(?:\.cmd|[\\/]|(?=$|[\s;&|]))/i, name);
    if (name !== "test:jest-jsdom-once") {
      assert.doesNotMatch(command, /(?:@tootallnate\/once|jest-environment-jsdom|\bjsdom\b)/, name);
    }
  }
  for (const file of ["jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.ts", "jest.config.json"]) {
    assert.equal(existsSync(join(root, file)), false, file);
  }
  const importOfChain = /(?:\brequire\s*\(\s*|\bfrom\s+|\bimport\s*(?:\(\s*)?)["'`](?:@jest\/|jest(?:-[\w-]+)?(?:["'`/]|$)|jsdom(?:["'`/]|$)|http-proxy-agent(?:["'`/]|$)|@tootallnate\/once(?:["'`/]|$))/m;
  for (const dir of [join(root, "src"), join(root, "functions"), join(root, "scripts")]) {
    for (const file of filesUnder(dir)) {
      if (file === __filename || !/[.](?:js|cjs|mjs|ts|tsx|vue)$/.test(file)) continue;
      assert.doesNotMatch(readFileSync(file, "utf8"), importOfChain, file);
    }
  }
  for (const name of ["vite.config.ts", "vite.runtime-audit.config.ts"]) {
    assert.doesNotMatch(readFileSync(join(root, name), "utf8"), importOfChain, name);
  }
  const config = JSON.parse(nodeProbe(`
    const forbid = () => { throw new Error("network access forbidden in Jest config audit"); };
    require("node:http").request = require("node:http").get = forbid;
    require("node:https").request = require("node:https").get = forbid;
    require("node:net").connect = require("node:net").createConnection = forbid;
    const path = require("node:path");
    const cli = path.join(path.dirname(require.resolve("jest/package.json")), "bin/jest.js");
    process.argv = [process.execPath, cli, "--showConfig"];
    require(cli);
  `));
  assert.equal(config.configs.length, 1);
  assert.equal(config.configs[0].testEnvironment, require.resolve("jest-environment-node"));
  assert.deepEqual(config.configs[0].testEnvironmentOptions, {});
});

test("real Uni CLI module load omits Jest chain; direct jsdom import is detected", () => {
  const probe = `
    const path = require("node:path");
    const forbid = () => { throw new Error("network access forbidden in CLI audit"); };
    require("node:http").request = require("node:http").get = forbid;
    require("node:https").request = require("node:https").get = forbid;
    require("node:net").connect = require("node:net").createConnection = forbid;
    const packages = ${JSON.stringify(Object.keys(versions).filter((name) => name !== "@dcloudio/uni-automator"))};
    const hit = name => Object.keys(require.cache).some(file =>
      file.includes(path.sep + "node_modules" + path.sep + name.split("/").join(path.sep) + path.sep));
    const report = () => console.log("CINASHOP_JEST_CHAIN=" + JSON.stringify(packages.filter(hit)));
    if (process.argv[1] === "control") {
      require("jsdom");
      report();
    } else {
      require("@dcloudio/uni-automator");
      require("@dcloudio/vite-plugin-uni");
      process.on("exit", report);
      process.argv = [process.execPath, "uni", "--help"];
      require("@dcloudio/vite-plugin-uni/dist/cli/index.js");
    }
  `;
  const markers = (output) => output.split(/\r?\n/).filter((line) => line.startsWith("CINASHOP_JEST_CHAIN="))
    .map((line) => JSON.parse(line.slice("CINASHOP_JEST_CHAIN=".length)));
  assert.deepEqual(markers(nodeProbe(probe, ["normal"])), [[]]);
  assert.deepEqual(markers(nodeProbe(probe, ["control"])), [["jsdom", "http-proxy-agent", "@tootallnate/once"]]);
});

test("runtime graph blocks external and tree-shaken Jest/jsdom/once modules", async (t) => {
  for (const id of ["jest", "jest-cli", "@jest/core", "jest-environment-jsdom", "jsdom", "http-proxy-agent",
    "@tootallnate/once", "C:\\app\\node_modules\\jsdom\\lib\\api.js", "\0@tootallnate/once?commonjs-proxy"]) {
    assert.equal(isJestJsdomOnceModule(id), true, id);
  }
  for (const id of ["once", "qrcode-terminal", "@dcloudio/uni-automator", "jestful"])
    assert.equal(isJestJsdomOnceModule(id), false, id);
  const ids = ["/app/src/main.ts", "@tootallnate/once"];
  const context = {
    getModuleIds: () => ids,
    getModuleInfo: (id) => ({ isEntry: id === ids[0], isExternal: id === ids[1] }),
  };
  const bundle = { "main.js": { type: "chunk", modules: { [ids[0]]: { renderedLength: 10 } } } };
  assert.deepEqual(inspectRuntimeGraph(context, bundle, "/app").jestJsdomOnce, ["@tootallnate/once"]);

  const tempRoot = realpathSync(tmpdir());
  const temporary = mkdtempSync(join(tempRoot, "cinashop-jest-audit-"));
  t.after(() => {
    const actual = realpathSync(temporary);
    assert.equal(dirname(actual), tempRoot);
    assert.match(basename(actual), /^cinashop-jest-audit-/);
    rmSync(actual, { recursive: true, force: true });
  });
  const priorCI = process.env.CI;
  const priorReport = process.env.CINASHOP_RUNTIME_I18N_REPORT;
  process.env.CI = "1";
  process.env.CINASHOP_RUNTIME_I18N_REPORT = join(temporary, "report.jsonl");
  t.after(() => {
    if (priorCI === undefined) delete process.env.CI; else process.env.CI = priorCI;
    if (priorReport === undefined) delete process.env.CINASHOP_RUNTIME_I18N_REPORT;
    else process.env.CINASHOP_RUNTIME_I18N_REPORT = priorReport;
  });
  const audit = runtimeI18nAudit();
  audit.configResolved({ root: "/app" });
  const build = await require("rollup").rollup({
    input: "virtual:audit-entry",
    external: ["jsdom"],
    plugins: [{
      name: "in-memory-entry",
      resolveId: (id) => id === "virtual:audit-entry" ? id : null,
      load: (id) => id === "virtual:audit-entry" ? "import { JSDOM } from 'jsdom'; export default JSDOM;" : null,
    }, audit],
  });
  t.after(() => build.close());
  await assert.rejects(build.generate({ format: "es" }), /Jest\/jsdom\/once.*reopen TEST-004D3/);
  const [record] = readFileSync(join(temporary, "report.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(record.jestJsdomOnce, ["jsdom"]);
});
