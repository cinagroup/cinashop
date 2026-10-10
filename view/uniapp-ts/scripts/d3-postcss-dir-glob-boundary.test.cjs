const assert = require("node:assert/strict");
const {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, isAbsolute, join, relative, resolve, sep } = require("node:path");
const test = require("node:test");

const { injectCssPlugin } = require("@dcloudio/uni-cli-shared");
const fastGlob = require("fast-glob");
const postcss = require("postcss");
const { loadConfigFromFile } = require("vite");
const { createPostcssConfigurationGuard, createPostcssDirBoundary } = require("./postcss-dir-boundary.cjs");

test("actual Vite config keeps the PostCSS boundary last and rejects changed order", async () => {
  const project = resolve(__dirname, "..");
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, join(project, "vite.config.ts"));
  assert.ok(loaded);
  const boundary = loaded.config.css.postcss.plugins.at(-1);
  assert.equal(boundary.postcssPlugin, "cinashop-postcss-dir-boundary");
  const configGuard = loaded.config.plugins.find(plugin => plugin.name === "cinashop:postcss-boundary-configuration");
  assert.ok(configGuard);
  const options = { css: { postcss: { plugins: [boundary, { postcssPlugin: "synthetic-producer" }] } } };
  assert.doesNotThrow(() => configGuard.configResolved(options));
  assert.equal(options.css.postcss.plugins.at(-1), boundary);
  assert.doesNotThrow(() => configGuard.buildStart());
  options.css.postcss.plugins.push({ postcssPlugin: "late-producer" });
  assert.throws(() => configGuard.buildStart(), /must be the last configured PostCSS plugin/);
  assert.throws(() => configGuard.configResolved({ css: { postcss: { plugins: [] } } }),
    /PostCSS boundary is missing or duplicated/);

  const source = join(project, "src", "pages", "behalf", "selection.css");
  const producer = dir => ({
    postcssPlugin: "synthetic-actual-config-producer",
    Once(_root, { result }) {
      result.messages.push({ type: "dir-dependency", plugin: this.postcssPlugin, dir, glob: "*.css" });
    },
  });
  await postcss([producer("."), boundary]).process(".fixture { color: red; }", { from: source });
  await assert.rejects(postcss([producer("../../.."), boundary]).process(".fixture {}", { from: source }),
    /PostCSS dir-dependency directory is outside src/);
});

function fixture(t) {
  const base = realpathSync(tmpdir());
  const root = mkdtempSync(join(base, "cinashop-d3-css-"));
  t.after(() => {
    const actual = realpathSync(root);
    const child = relative(base, actual);
    assert.ok(child && child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child));
    assert.match(basename(actual), /^cinashop-d3-css-/);
    rmSync(actual, { recursive: true, force: true });
  });
  return root;
}

async function transformWithMessage(root, cssFile, dir, glob) {
  const watched = [];
  const producer = {
    postcssPlugin: "isolated-dir-dependency-producer",
    Once(_node, { result }) {
      result.messages.push({ type: "dir-dependency", plugin: this.postcssPlugin, dir, glob });
    },
  };
  const boundary = createPostcssDirBoundary(join(root, "src"));
  const config = {
    root,
    command: "build",
    build: { watch: {} },
    css: { postcss: { plugins: [producer, boundary] } },
    createResolver: () => async () => undefined,
    resolve: { alias: [] },
    logger: { warn() {} },
    plugins: [{ name: "vite:css" }],
  };
  createPostcssConfigurationGuard(boundary).configResolved(config);
  const before = config.plugins[0];
  injectCssPlugin(config); // the same replacement used by the locked MP/App configResolved hooks
  const plugin = config.plugins[0];
  assert.notEqual(plugin, before);
  assert.equal(plugin.name, "vite:css");
  plugin.buildStart();
  const transformed = await plugin.transform.call({ addWatchFile: file => watched.push(file) },
    ".fixture { color: red; }", cssFile);
  assert.match(transformed.code, /color:\s*red/);
  return watched.map(file => realpathSync(file));
}

test("actual locked MP/App CSS injection accepts a flat in-src style glob", async t => {
  const mp = readFileSync(require.resolve("@dcloudio/uni-mp-vite/dist/plugin/configResolved.js"), "utf8");
  const app = readFileSync(require.resolve("@dcloudio/uni-app-vite/dist/plugin/configResolved.js"), "utf8");
  assert.match(mp, /injectCssPlugin\)\(config/);
  assert.match(app, /injectCssPlugin\)\(config/);

  const root = fixture(t);
  const styles = join(root, "src", "styles");
  const outside = join(root, "outside");
  mkdirSync(styles, { recursive: true });
  mkdirSync(outside);
  const cssFile = join(styles, "entry.css");
  const localFile = join(styles, "local.css");
  const outsideFile = join(outside, "marker.txt");
  writeFileSync(cssFile, ".fixture { color: red; }");
  writeFileSync(localFile, ".local { color: blue; }");
  writeFileSync(outsideFile, "isolated fixture only");

  const local = await transformWithMessage(root, cssFile, ".", "*.css");
  assert.ok(local.includes(realpathSync(localFile)));
  assert.ok(!local.includes(realpathSync(outsideFile)));
});

test("actual locked CSS injection rejects outside dirs and broad glob grammar before watch registration", async t => {
  const root = fixture(t);
  const styles = join(root, "src", "styles");
  mkdirSync(styles, { recursive: true });
  mkdirSync(join(root, "outside"));
  const cssFile = join(styles, "entry.css");
  writeFileSync(cssFile, ".fixture { color: red; }");
  writeFileSync(join(root, "outside", "marker.txt"), "isolated fixture only");

  const originalScan = fastGlob.sync;
  let scans = 0;
  fastGlob.sync = (...args) => { scans++; return originalScan(...args); };
  try {
    await assert.rejects(transformWithMessage(root, cssFile, "../..", "*.css"),
      /PostCSS dir-dependency directory is outside src/);
    await assert.rejects(transformWithMessage(root, cssFile, ".", "{*.css,../../outside/*.txt}"),
      /PostCSS dir-dependency glob must be one flat style-file pattern/);
    await assert.rejects(transformWithMessage(root, cssFile, ".", undefined),
      /PostCSS dir-dependency glob must be one flat style-file pattern/);
    assert.equal(scans, 0, "rejected messages never reach DCloud fast-glob");
  } finally {
    fastGlob.sync = originalScan;
  }
});

test("flat style globs reject links before scanning", async t => {
  const root = fixture(t);
  const styles = join(root, "src", "styles");
  mkdirSync(styles, { recursive: true });
  const outside = join(root, "outside");
  mkdirSync(outside);
  const cssFile = join(styles, "entry.css");
  const outsideFile = join(outside, "marker.css");
  writeFileSync(cssFile, ".fixture { color: red; }");
  writeFileSync(outsideFile, ".outside { color: blue; }");
  try {
    symlinkSync(outsideFile, join(styles, "linked.css"), "file");
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    // Windows can create a junction without file-symlink privilege. It still
    // exercises the fail-closed directory-entry check used before any scan.
    try {
      symlinkSync(outside, join(styles, "linked"), "junction");
    } catch (junctionError) {
      if (junctionError.code !== "EPERM") throw junctionError;
      // This isolated Windows checkout uses a read-only node_modules junction.
      // When fixture links are denied, use that preexisting entry to exercise
      // the same directory-entry rejection without creating or changing it.
      const project = resolve(__dirname, "..");
      if (!lstatSync(join(project, "node_modules")).isSymbolicLink()) {
        return t.skip("fixture links are not permitted");
      }
      const boundary = createPostcssDirBoundary(project);
      const producer = {
        postcssPlugin: "isolated-junction-producer",
        Once(_root, { result }) {
          result.messages.push({ type: "dir-dependency", plugin: this.postcssPlugin, dir: "../../..", glob: "*.css" });
        },
      };
      await assert.rejects(postcss([producer, boundary]).process(".fixture {}", {
        from: join(project, "src", "pages", "behalf", "selection.css"),
      }), /PostCSS dir-dependency directory contains a symbolic link/);
      return;
    }
  }
  await assert.rejects(transformWithMessage(root, cssFile, ".", "*.css"),
    /PostCSS dir-dependency directory contains a symbolic link/);

  const nested = join(root, "src", "deep", "styles");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "entry.css"), ".nested { color: red; }");
  const alias = join(root, "src", "linked-depth");
  try {
    symlinkSync(nested, alias, "dir");
  } catch (error) {
    if (error.code === "EPERM") return;
    throw error;
  }
  // The physical CSS file is deeper inside src, but DCloud resolves `../..`
  // against the shallow alias and would scan the project root.
  await assert.rejects(transformWithMessage(root, join(alias, "entry.css"), "../..", "*.css"),
    /PostCSS dir-dependency directory is outside src/);
});
