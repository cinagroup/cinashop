import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const manifestPath = resolve("package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const lock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8"));
const require = createRequire(manifestPath);

test("all locked Nano ID copies meet the published 3.x advisory patch level", () => {
  const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith("node_modules/nanoid"));
  assert.ok(copies.length > 0);
  for (const [path, pkg] of copies) {
    const [major, minor, patch] = pkg.version.split(".").map(Number);
    assert.ok(major === 3 && (minor > 3 || (minor === 3 && patch >= 18)), `${path}: review Nano ID ${pkg.version}`);
  }
});

test("Nano ID covered zero/negative and regular-size cases pass across module variants", () => {
  const probe = fileURLToPath(new URL("./nanoid-behavior-probe.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [probe, dirname(require.resolve("nanoid/package.json"))], {
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { entries: 11, coveredZeroAndNegativeCasesTerminate: true, coveredRegularIdsPreserved: true });
});

test("the actual PostCSS fixed-size caller preserves anonymous CSS parsing", () => {
  const postcss = require("postcss");
  const css = ".toolchain-control { color: red }";
  const parsed = postcss.parse(css);
  assert.equal(parsed.toString(), css);
  assert.match(parsed.first.source.input.id, /^<input css [\w-]{6}>$/);
});

if (manifest.name === "cinashop-kefu-ts") {
  test("Kefu has no vulnerable Vitest or nested Vite/esbuild copies", () => {
    assert.equal(manifest.devDependencies.vitest, "3.2.6");
    assert.equal(lock.packages["node_modules/vitest"].version, "3.2.6");
    for (const [path, pkg] of Object.entries(lock.packages)) {
      const [major, minor, patch] = (pkg.version ?? "").split(".").map(Number);
      if (path.endsWith("node_modules/vite")) assert.ok(major > 6 || (major === 6 && (minor > 4 || (minor === 4 && patch >= 3))), path);
      if (path.endsWith("node_modules/esbuild")) assert.ok(major > 0 || minor >= 25, path);
    }
  });

  test("Vitest API defaults deny network write/exec and preserve local opt-in workflows", async () => {
    const { resolveApiServerConfig } = await import(pathToFileURL(require.resolve("vitest/node")).href);
    for (const host of [true, "0.0.0.0", "::", "192.0.2.1"]) {
      const api = resolveApiServerConfig({ api: { host } }, 51204);
      assert.equal(api.allowWrite, false, `write on ${host}`);
      assert.equal(api.allowExec, false, `exec on ${host}`);
    }
    const disabled = resolveApiServerConfig({ api: false }, 51204);
    assert.equal(disabled.middlewareMode, true);
    assert.equal(disabled.port, undefined);
    for (const host of ["localhost", "127.0.0.1"]) {
      const local = resolveApiServerConfig({ api: { host } }, 51204);
      assert.equal(local.allowWrite, true);
      assert.equal(local.allowExec, true);
    }
  });

  test("published Vitest RPC handlers enforce write/exec flags and registered-file reads", async () => {
    const chunks = resolve(dirname(require.resolve("vitest/package.json")), "dist/chunks");
    const apiFile = readdirSync(chunks).find((file) => file.startsWith("cli-api.") && file.endsWith(".js"));
    assert.ok(apiFile, "review the API extraction when upgrading Vitest");
    const source = readFileSync(resolve(chunks, apiFile), "utf8");
    const startMarker = "const rpc = createBirpc({";
    const start = source.indexOf(startMarker);
    const end = source.indexOf("\n\t\t}, {\n\t\t\tpost:", start);
    assert.ok(start >= 0 && end > start, "published RPC method boundary changed");
    const methods = source.slice(start + "const rpc = createBirpc(".length, end) + "\n}";
    const makeRpc = new Function("ctx", "existsSync", "promises", `return (${methods})`);
    for (const allowWrite of [false, true]) for (const allowExec of [false, true]) {
      const counts = { write: 0, execute: 0, snapshot: 0 };
      const file = "/fixture/registered.test.ts";
      const ctx = {
        config: { api: { allowWrite, allowExec } },
        state: { filesMap: new Map([[file, {}]]) },
        rerunFiles: async () => { counts.execute++; },
        rerunTask: async () => { counts.execute++; },
        updateSnapshot: async () => { counts.snapshot++; },
      };
      // The real handler bodies run; filesystem and execution sinks are inert fixtures.
      const rpc = makeRpc(ctx, (path) => path === file, {
        readFile: async () => "registered fixture", writeFile: async () => { counts.write++; },
      });
      assert.equal(await rpc.readTestFile("/outside/unregistered.ts"), null);
      assert.equal(await rpc.readTestFile(file), "registered fixture");
      await assert.rejects(rpc.saveTestFile("/outside/unregistered.ts", "inert"), /not registered/);
      await rpc.saveTestFile(file, "inert");
      await rpc.rerun([file]);
      await rpc.rerunTask("fixture-task");
      await rpc.updateSnapshot();
      assert.deepEqual(counts, { write: Number(allowWrite), execute: allowExec ? 2 : 0, snapshot: Number(allowWrite && allowExec) });
    }
  });
}
