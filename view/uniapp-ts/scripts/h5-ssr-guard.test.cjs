"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = resolve(__dirname, "..");
const source = readFileSync(resolve(__dirname, "h5-ssr-guard.cjs"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
const bin = "@dcloudio/vite-plugin-uni/bin/uni.js";

test("repository H5 scripts use the guard and preserve DCloud's locked CLI", () => {
  assert.equal(pkg.scripts["dev:h5"], "node scripts/h5-ssr-guard.cjs");
  assert.equal(pkg.scripts["build:h5"], "node scripts/h5-ssr-guard.cjs build");
  assert.equal(lock.packages["node_modules/@dcloudio/vite-plugin-uni"].bin.uni, "bin/uni.js");
  assert.equal(pkg.scripts["build:mp-weixin"], "uni build -p mp-weixin");
  assert.equal(pkg.scripts["build:app"], "uni build -p app");
});

test("npm H5 entrypoints reject SSR before loading DCloud", () => {
  for (const script of ["dev:h5", "build:h5"]) for (const flag of ["-ssr", "--ssr", "-ssr=true"]) {
    const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "npm.cmd", "run", script, "--", flag]
      : ["run", script, "--", flag];
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, npm_config_update_notifier: "false" },
      windowsHide: true,
    });
    assert.equal(result.error, undefined, `${script} ${flag}: ${result.error}`);
    assert.ok(Number.isInteger(result.status) && result.status !== 0,
      `${script} ${flag}: ${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /H5 SSR mode is disabled for repository-managed scripts/);
  }
});

test("ordinary dev/build arguments reach the same DCloud bin unchanged", () => {
  for (const args of [[], ["build"], ["build", "-p", "h5"]]) {
    const argv = [process.execPath, resolve(__dirname, "h5-ssr-guard.cjs"), ...args];
    const calls = [];
    const processStub = { argv, exitCode: 0 };
    const requireStub = (id) => { calls.push({ id, argv: [...argv] }); };
    requireStub.resolve = (id) => {
      assert.equal(id, bin);
      return resolve(root, "node_modules", "@dcloudio", "vite-plugin-uni", "bin", "uni.js");
    };
    vm.runInNewContext(source, { process: processStub, require: requireStub, console }, { filename: "h5-ssr-guard.cjs" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, requireStub.resolve(bin));
    assert.deepEqual(calls[0].argv.slice(2), args);
    assert.equal(calls[0].argv[1], calls[0].id);
    assert.equal(processStub.exitCode, 0);
  }
});
