const { appendFileSync } = require("node:fs");

function isIntlifyModule(id) {
  const normalized = id.replaceAll("\\", "/");
  return /(?:^|[/:\0])(?:@intlify\/|vue-i18n(?:[/?.]|$))/.test(normalized);
}

function inspectRuntimeGraph(context, bundle, root) {
  const ids = [...context.getModuleIds()];
  const info = (id) => {
    const value = context.getModuleInfo(id);
    if (!value) throw new Error("Missing Rollup module information; re-audit the collector");
    return value;
  };
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
  const label = (id) => {
    const normalized = id.replaceAll("\\", "/");
    return normalized.startsWith(normalizedRoot + "/") ? normalized.slice(normalizedRoot.length + 1) : normalized;
  };
  const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
  const rendered = new Map();
  for (const chunk of chunks) for (const [id, value] of Object.entries(chunk.modules)) {
    rendered.set(id, (rendered.get(id) || 0) + value.renderedLength);
  }
  return {
    chunks: chunks.length,
    loadedModules: ids.length,
    chunkModuleEntries: rendered.size,
    entries: ids.filter((id) => info(id).isEntry).map(label).sort(),
    hasMain: ids.some((id) => /\/src\/main\.ts(?:\?|$)/.test(id.replaceAll("\\", "/"))),
    // Include loaded-but-tree-shaken and external imports: a new consumer needs review.
    intlify: ids.filter(isIntlifyModule).map(label).sort(),
    // DCloud bundles these scripts with a separate esbuild invocation, leaving
    // only installation stubs in Rollup. Their dependencies need a fresh audit.
    separateScriptModules: ids.filter((id) => /[?&]type=(?:renderjs|wxs)(?:&|$)/.test(id)).map(label).sort(),
    separateScriptAssets: Object.values(bundle).filter((item) => item.type === "asset" && /(?:^|\/)app-(?:renderjs|wxs)\.js$/.test(item.fileName))
      .map((item) => item.fileName).sort(),
    externals: ids.filter((id) => info(id).isExternal).map(label).sort(),
    dcloudI18n: [...rendered].filter(([id]) => /\/@dcloudio\/uni-i18n\//.test(id.replaceAll("\\", "/")))
      .map(([id, renderedLength]) => ({ id: label(id), renderedLength })),
  };
}

function runtimeI18nAudit() {
  const report = process.env.CINASHOP_RUNTIME_I18N_REPORT;
  if (process.env.CI !== "1" || !report) throw new Error("Use npm run test:runtime-i18n for isolated audit builds");
  let root;
  return {
    name: "cinashop-runtime-i18n-audit",
    apply: "build",
    configResolved(config) { root = config.root; },
    generateBundle(_options, bundle) {
      const inventory = {
        platform: process.env.UNI_PLATFORM,
        compiler: process.env.UNI_COMPILER || "default",
        ...inspectRuntimeGraph(this, bundle, root),
      };
      appendFileSync(report, JSON.stringify(inventory) + "\n");
      if (inventory.intlify.length) this.error("Intlify entered the runtime graph; reopen TEST-004D3A before accepting this build");
      if (inventory.separateScriptModules.length || inventory.separateScriptAssets.length) {
        this.error("Separately compiled renderjs/wxs entered the build; reopen TEST-004D3A to audit its independent dependency graph");
      }
    },
  };
}

module.exports = { isIntlifyModule, inspectRuntimeGraph, runtimeI18nAudit };
