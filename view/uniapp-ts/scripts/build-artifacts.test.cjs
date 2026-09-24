const assert = require("node:assert/strict");
const { readFileSync, statSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

function artifact(path) {
  assert.ok(statSync(path).isFile(), path);
  assert.ok(statSync(path).size > 0, path);
  return readFileSync(path, "utf8");
}
const pages = JSON.parse(readFileSync("src/pages.json", "utf8")).pages.map(({ path }) => path);

test("H5 build has an HTML entry and nonempty referenced application modules", () => {
  const html = artifact("dist/build/h5/index.html");
  const modules = [...html.matchAll(/<script[^>]*\bsrc="([^"]+\.js)"/g)];
  assert.ok(modules.length > 0);
  const entries = modules.map(([, path]) => artifact(resolve("dist/build/h5", path.replace(/^\//, "")))).join("\n");
  // An old nonempty entry is not proof that newly registered pages were built.
  for (const page of pages) {
    // Uni's first page is registered at '/' with its page path as an alias.
    const route = page === pages[0] ? `path:"/",alias:"/${page}"` : `path:"/${page}"`;
    assert.ok(entries.includes(route), page);
  }
});

test("Weixin build preserves the registered pages and produces page resources", () => {
  const config = JSON.parse(artifact("dist/build/mp-weixin/app.json"));
  assert.deepEqual(config.pages, pages);
  artifact("dist/build/mp-weixin/app.js");
  for (const page of pages) {
    artifact(`dist/build/mp-weixin/${page}.js`);
    artifact(`dist/build/mp-weixin/${page}.wxml`);
  }
});

test("App build produces service, view and manifest resources, not just an exit code", () => {
  const service = artifact("dist/build/app/app-service.js");
  artifact("dist/build/app/app-config-service.js");
  artifact("dist/build/app/__uniappview.html");
  const config = JSON.parse(artifact("dist/build/app/manifest.json"));
  const source = JSON.parse(readFileSync("src/manifest.json", "utf8"));
  assert.equal(config.name, source.name);
  assert.equal(config.id, source.appid); // Blank IDs remain blank; this is NOT a native release gate.
  assert.equal(config.version.name, source.versionName);
  for (const page of pages) assert.ok(service.includes(page), page);
});
