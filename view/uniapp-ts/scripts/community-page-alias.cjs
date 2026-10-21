const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');
const { parse } = require('@vue/compiler-sfc');

function runtimePage(source, filename) {
  const parsed = parse(source, { filename });
  if (parsed.errors.length) throw Error('Invalid community page SFC');
  const { script, scriptSetup } = parsed.descriptor;
  if (script && scriptSetup && script.lang !== scriptSetup.lang) throw Error('Community page script languages differ');
  for (const block of [script, scriptSetup]) {
    if (!block) continue;
    if (block.src || block.lang !== undefined && !['js', 'ts'].includes(block.lang)) throw Error('Unsupported community page script');
    const tree = ts.createSourceFile(filename + '.ts', block.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (tree.parseDiagnostics.length) throw Error('Invalid community page script');
  }
  return parsed.descriptor;
}

// This is source composition before Vue/DCloud compile the registered page ID.
// A component wrapper would change where page lifecycle hooks are registered;
// a JS re-export alone cannot emit an MP template for the alias page.
function createCommunityPageAliasPlugin(sourceRoot) {
  const alias = resolve(sourceRoot, 'pages/discover/workspace.vue');
  const target = resolve(sourceRoot, 'pages/discover/index.vue');
  const normalized = value => value.replace(/\\/g, '/');
  return {
    name: 'cinashop:community-page-alias',
    enforce: 'pre',
    transform(source, id) {
      if (id.includes('?') || normalized(id) !== normalized(alias)) return null;
      const descriptor = runtimePage(source, alias), script = descriptor.script;
      if (descriptor.template || !script || descriptor.scriptSetup || descriptor.styles.length || descriptor.customBlocks.length
        || Object.keys(script.attrs).some(key => key !== 'lang')) throw Error('Unreviewed community page alias');
      const tree = ts.createSourceFile(alias + '.ts', script.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const [binding, exported] = tree.statements;
      if (tree.statements.length !== 2 || !ts.isImportDeclaration(binding) || !ts.isStringLiteral(binding.moduleSpecifier)
        || binding.moduleSpecifier.text !== './index.vue' || binding.attributes || !binding.importClause?.name
        || binding.importClause.isTypeOnly || binding.importClause.namedBindings
        || !ts.isExportAssignment(exported) || exported.isExportEquals || !ts.isIdentifier(exported.expression)
        || exported.expression.text !== binding.importClause.name.text) throw Error('Unreviewed community page alias import/export');
      this.addWatchFile(target);
      const delegated = readFileSync(target, 'utf8'), page = runtimePage(delegated, target);
      if (!page.template?.content.trim() || page.template.src || page.template.lang && page.template.lang !== 'html') {
        throw Error('Community page alias requires a real local template');
      }
      // Both fixed files share a directory, so every relative import and style
      // URL retains its meaning. Setup/hooks/template/style remain the page root.
      return { code: delegated, map: { mappings: '' } };
    },
    handleHotUpdate(context) {
      if (![alias, target].some(file => normalized(context.file) === normalized(file))) return;
      // Vue's HMR descriptor reads the on-disk alias, whereas its main compiler
      // receives expanded source. Reload to keep those two descriptor caches
      // consistent when either source changes during local development.
      // Vite invalidates the changed file before hooks, but this source-level
      // dependency has no runtime import edge from target back to alias.
      const seen = new Set();
      for (const file of [alias, target]) {
        for (const module of context.server.moduleGraph.getModulesByFile(normalized(file)) ?? []) {
          context.server.moduleGraph.invalidateModule(module, seen, context.timestamp, true);
        }
      }
      context.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}

// The locked DCloud isAppVue helper also matches this legacy nested app.vue,
// so its normal MP using-components plugin skips this registered page. Reuse
// that plugin's official processing steps for this one compiled Weixin page.
// H5/App, the real src/App.vue and every other MP page stay on their own path.
function createCommunityVideoAppPagePlugin(sourceRoot, platform = process.env.UNI_PLATFORM) {
  const normalized = value => value.replace(/\\/g, '/');
  // Vite's resolved virtual script/template IDs use forward slashes on Windows
  // too; descriptor cache keys must use the same form in all three branches.
  const page = normalized(resolve(sourceRoot, 'pages/discover/discoverVideo/app.vue'));
  let config, processed = false;
  const normalizeName = name => name.startsWith('wx-') ? name.replace('wx-', 'weixin-') : name;
  return {
    name: 'cinashop:community-video-app-components',
    enforce: 'post',
    apply: () => platform === 'mp-weixin',
    configResolved(value) { config = value; },
    async transform(source, id) {
      if (platform !== 'mp-weixin') return null;
      const cli = require('@dcloudio/uni-cli-shared');
      const { filename, query } = cli.parseVueRequest(id);
      if (normalized(filename) !== normalized(page)
        || query.vue && !['script', 'template'].includes(query.type)
        || id.includes('?') && !query.vue) return null;
      const { dynamicImport } = require('@dcloudio/uni-mp-vite/dist/plugins/usingComponents.js');
      const resolver = async (request, importer, options) => {
        const uts = cli.resolveUTSModule(request, importer || sourceRoot);
        return this.resolve(uts || request, importer, options);
      };
      const ast = cli.parseProgram(source, id, {});
      let descriptor;
      // Like the official plugin, handle both inline and external compiled
      // script/template modules. Their loading order must not decide JSON.
      if (query.vue) {
        this.addWatchFile(page);
        if (query.type === 'script') {
          descriptor = await cli.parseScriptDescriptor(page, ast, { resolve: resolver, isExternal: true });
          cli.updateMiniProgramComponentsByScriptFilename(page, sourceRoot, normalizeName);
        } else {
          descriptor = await cli.parseTemplateDescriptor(page, ast, { resolve: resolver, isExternal: true });
          cli.updateMiniProgramComponentsByTemplateFilename(page, sourceRoot, normalizeName);
        }
      } else {
        processed = true;
        descriptor = await cli.parseMainDescriptor(page, ast, resolver);
        // Same normalizer as the locked Weixin compiler (uni.compiler.js).
        cli.updateMiniProgramComponentsByMainFilename(page, sourceRoot, normalizeName);
      }
      return cli.transformDynamicImports(source, descriptor.imports, {
        id, sourceMap: cli.withSourcemap(config), dynamicImport,
      });
    },
    generateBundle() {
      if (platform !== 'mp-weixin' || !processed) return;
      const components = require('@dcloudio/uni-cli-shared').findUsingComponents('pages/discover/discoverVideo/app');
      if (components?.['theme-page'] !== '/components/ThemePage'
        || components?.['community-deep-link-feed'] !== '/components/community/CommunityDeepLinkFeed') {
        throw Error('Community video page component bindings are missing or changed');
      }
    },
  };
}

module.exports = { createCommunityPageAliasPlugin, createCommunityVideoAppPagePlugin };
