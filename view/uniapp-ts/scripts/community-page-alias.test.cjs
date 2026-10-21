const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const sfc = require('@vue/compiler-sfc');
const { createCommunityPageAliasPlugin, createCommunityVideoAppPagePlugin } = require('./community-page-alias.cjs');

const sourceRoot = path.resolve(__dirname, '../src');
const alias = '<script lang="ts">import Page from "./index.vue"; export default Page;</script>';
const page = '<template><ThemePage><view>{{ title }}</view></ThemePage></template>\n'
  + '<script setup lang="ts">import ThemePage from "@/components/ThemePage.vue";'
  + 'import { onLoad, onShow, onHide, onUnload } from "@dcloudio/uni-app";'
  + 'const title="Actual page";onLoad(query=>query);onShow(()=>{});onHide(()=>{});onUnload(()=>{});</script>\n'
  + '<style scoped>.page{color:var(--view-theme)}</style>';
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'community-page-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const aliasFile = path.join(root, 'pages/discover/workspace.vue'), target = path.join(root, 'pages/discover/index.vue');
  mkdirSync(path.dirname(aliasFile), { recursive: true }); writeFileSync(aliasFile, alias); writeFileSync(target, page);
  const plugin = createCommunityPageAliasPlugin(root), watched = [];
  const transform = (text = alias, id = aliasFile) => plugin.transform.call({ addWatchFile: file => watched.push(file) }, text, id);
  return { root, aliasFile, target, plugin, watched, transform };
}

test('the actual Vite configuration registers the imported source composer before uni', () => {
  const source = readFileSync(path.resolve(__dirname, '../vite.config.ts'), 'utf8');
  const tree = ts.createSourceFile('vite.config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(tree.parseDiagnostics.length, 0);
  const imported = tree.statements.find(statement => ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === './scripts/community-page-alias.cjs');
  assert.ok(imported && imported.importClause && !imported.importClause.isTypeOnly);
  const bindings = imported.importClause.namedBindings;
  assert.ok(bindings && ts.isNamedImports(bindings));
  const binding = bindings.elements.find(element => (element.propertyName ?? element.name).text === 'createCommunityPageAliasPlugin');
  assert.ok(binding && !binding.isTypeOnly);
  const exported = tree.statements.find(statement => ts.isExportAssignment(statement));
  assert.ok(exported && ts.isCallExpression(exported.expression));
  const config = exported.expression.arguments[0]; assert.ok(ts.isObjectLiteralExpression(config));
  const plugins = config.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(tree) === 'plugins');
  assert.ok(plugins && ts.isArrayLiteralExpression(plugins.initializer));
  const calls = plugins.initializer.elements;
  assert.ok(ts.isCallExpression(calls[0]) && ts.isIdentifier(calls[0].expression));
  assert.equal(calls[0].expression.text, binding.name.text);
  assert.equal(calls[0].arguments[0].getText(tree), 'resolve(__dirname, "src")');
  assert.ok(ts.isCallExpression(calls[1]) && ts.isIdentifier(calls[1].expression));
  assert.equal(calls[1].expression.text, 'uni');
  const videoBinding = bindings.elements.find(element => (element.propertyName ?? element.name).text === 'createCommunityVideoAppPagePlugin');
  assert.ok(videoBinding && !videoBinding.isTypeOnly);
  assert.ok(ts.isCallExpression(calls[2]) && ts.isIdentifier(calls[2].expression));
  assert.equal(calls[2].expression.text, videoBinding.name.text);
  assert.equal(calls[2].arguments[0].getText(tree), 'resolve(__dirname, "src")');
  assert.equal(createCommunityPageAliasPlugin(sourceRoot).enforce, 'pre');
});

test('the actual workspace composes the complete current SFC at its own page ID without a component wrapper', () => {
  const plugin = createCommunityPageAliasPlugin(sourceRoot), watched = [];
  const aliasFile = path.join(sourceRoot, 'pages/discover/workspace.vue'), target = path.join(sourceRoot, 'pages/discover/index.vue');
  const result = plugin.transform.call({ addWatchFile: file => watched.push(file) }, readFileSync(aliasFile, 'utf8'), aliasFile);
  assert.equal(result.code, readFileSync(target, 'utf8')); assert.deepEqual(watched, [target]);
  const parsed = sfc.parse(result.code, { filename: aliasFile }); assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.descriptor.template.content.includes('<ThemePage>'));
  assert.ok(parsed.descriptor.styles.some(style => style.scoped));
  const script = sfc.compileScript(parsed.descriptor, { id: 'registered-workspace-page' }).content;
  for (const hook of ['onLoad(', 'onShow(', 'onHide(', 'onUnload(']) assert.ok(script.includes(hook), hook);
  assert.deepEqual(sfc.compileTemplate({ source: parsed.descriptor.template.content, filename: aliasFile, id: 'registered-workspace-page' }).errors, []);
});

test('only the fixed raw page transforms; template/style virtual requests and unrelated pages stay with their compiler', t => {
  const f = fixture(t);
  for (const id of [f.target, path.join(f.root, 'pages/discover/other.vue'), f.aliasFile + '?vue&type=template',
    f.aliasFile + '?vue&type=style&index=0', '\0' + f.aliasFile]) assert.equal(f.transform(alias, id), null, id);
  assert.deepEqual(f.watched, []);
  assert.equal(f.transform().code, page);
});

test('default runtime imports and the same exported identifier are mandatory, with no other SFC blocks or expressions', t => {
  const f = fixture(t);
  for (const valid of [alias, alias.replace('lang="ts"', 'lang="js"'), alias.replace(' lang="ts"', ''),
    alias.replaceAll('Page', 'RenamedPage'), alias.replace('; ', ';\r\n')]) assert.equal(f.transform(valid).code, page);
  const invalid = [
    alias.replace('import Page', 'import type Page'), alias.replace('import Page', 'import { Page }'),
    alias.replace('./index.vue', './other.vue'), alias.replace('export default Page', 'export default Other'),
    alias.replace('export default Page', 'export default { ...Page }'), alias.replace('export default Page', 'export default (()=>Page)()'),
    alias.replace('export default Page', 'export = Page'), alias.replace('</script>', 'console.log(Page);</script>'),
    alias.replace('import Page', '/* import Page'), alias.replace('lang="ts"', 'lang="tsx"'),
    alias.replace('lang="ts"', 'src="./index.vue"'), alias.replace('lang="ts"', 'context="module"'),
    alias + '<template><view /></template>', alias + '<style>.extra{color:red}</style>',
    alias + '<script setup>const extra=1</script>', alias + '<docs>extra</docs>',
  ];
  for (const text of invalid) assert.throws(() => f.transform(text), undefined, text);
});

test('missing cyclic empty or broken delegated sources cannot silently compile an empty page', t => {
  const f = fixture(t);
  rmSync(f.target); assert.throws(() => f.transform(), /ENOENT/);
  for (const target of ['', alias, '<script>export default {</script>', '<template><view></template>',
    page.replace('lang="ts"', 'lang="coffee"'), page + '<script lang="js">export default {}</script>',
    '<template src="./other.html"></template>', '<template></template>']) {
    writeFileSync(f.target, target); assert.throws(() => f.transform(), undefined, target);
  }
});

test('target edits are read afresh and both source files invalidate actual Vite module caches before a full reload', async t => {
  const f = fixture(t);
  assert.equal(f.transform().code, page);
  const next = page.replace('Actual page', 'Updated actual page'); writeFileSync(f.target, next);
  assert.equal(f.transform().code, next);
  const { createServer } = await import('vite');
  // Vite 5 does not publicly export its ModuleGraph constructor. Obtain the
  // real graph through an isolated middleware server without listening or
  // loading this application's config/plugins/builds.
  const server = await createServer({ root: f.root, configFile: false, envFile: false, logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, hmr: false } });
  t.after(() => server.close());
  const graph = server.moduleGraph, normalized = file => file.replace(/\\/g, '/');
  const aliasModule = await graph.ensureEntryFromUrl(normalized(f.aliasFile));
  const styleModule = await graph.ensureEntryFromUrl(normalized(f.aliasFile) + '?vue&type=style&index=0&lang.css');
  const targetModule = await graph.ensureEntryFromUrl(normalized(f.target));
  const unrelated = await graph.ensureEntryFromUrl(normalized(path.join(f.root, 'unrelated.vue')));
  const events = [], context = file => ({ file, timestamp: 5000, server: { moduleGraph: graph, ws: { send: value => {
    for (const module of [aliasModule, styleModule, targetModule]) {
      assert.equal(module.transformResult, null); assert.equal(module.ssrTransformResult, null);
      assert.equal(module.lastHMRTimestamp, 5000);
    }
    assert.equal(unrelated.transformResult.code, 'unrelated'); events.push(value);
  } } } });
  unrelated.transformResult = { code: 'unrelated', etag: 'unrelated' };
  assert.equal(f.plugin.handleHotUpdate(context(path.join(f.root, 'unrelated.vue'))), undefined);
  assert.deepEqual(events, []);
  for (const file of [f.aliasFile, f.target]) {
    for (const module of [aliasModule, styleModule, targetModule]) {
      module.transformResult = { code: 'stale', etag: 'stale-' + module.id };
      module.ssrTransformResult = { code: 'stale-ssr' };
    }
    assert.deepEqual(f.plugin.handleHotUpdate(context(file)), []);
  }
  assert.deepEqual(events, [{ type: 'full-reload' }, { type: 'full-reload' }]);
});

test('the reserved-name repair applies only to the fixed configured Weixin page and leaves the real App and other targets untouched', async t => {
  const f = fixture(t), pageFile = path.join(f.root, 'pages/discover/discoverVideo/app.vue');
  for (const platform of ['h5', 'app', 'app-plus', 'mp-alipay']) {
    const plugin = createCommunityVideoAppPagePlugin(f.root, platform);
    assert.equal(plugin.apply(), false);
    assert.equal(await plugin.transform.call({}, 'not compiled JS', pageFile), null);
  }
  const plugin = createCommunityVideoAppPagePlugin(f.root, 'mp-weixin');
  assert.equal(plugin.apply(), true); assert.equal(plugin.enforce, 'post');
  for (const file of [path.join(f.root, 'App.vue'), path.join(f.root, 'app.vue'),
    path.join(f.root, 'pages/other/app.vue'), path.join(f.root, 'pages/discover/discoverVideo/index.vue'),
    pageFile + '?vue&type=style&index=0', pageFile + '?unknown=script']) {
    assert.equal(await plugin.transform.call({}, 'not compiled JS', file), null, file);
  }
});

test('official DCloud processing derives matching JSON bindings and virtual component imports without changing App classification', async t => {
  const f = fixture(t), cli = require('@dcloudio/uni-cli-shared');
  const { parseVirtualComponentPath } = require('@dcloudio/uni-mp-vite/dist/plugins/entry.js');
  const initialClassifier = cli.isAppVue, rootApp = path.join(f.root, 'App.vue');
  const previousInput = process.env.UNI_INPUT_DIR;
  process.env.UNI_INPUT_DIR = f.root;
  t.after(() => { if (previousInput === undefined) delete process.env.UNI_INPUT_DIR; else process.env.UNI_INPUT_DIR = previousInput; });
  const appBefore = JSON.stringify(cli.findJsonFile('app'));
  const normalized = file => file.replace(/\\/g, '/');
  const pageFile = path.join(f.root, 'pages/discover/discoverVideo/app.vue');
  const components = { ThemePage: path.join(f.root, 'components/ThemePage.vue'),
    CommunityDeepLinkFeed: path.join(f.root, 'components/community/CommunityDeepLinkFeed.vue') };
  for (const file of Object.values(components)) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, '<template><view /></template>'); }
  assert.equal(typeof cli.BINDING_COMPONENTS, 'string');
  const metadata = { 'theme-page': { name: 'ThemePage', type: 'setup-const' },
    'community-deep-link-feed': { name: 'CommunityDeepLinkFeed', type: 'setup-const' } };
  // The documented compiler metadata boundary is consumed by the real
  // parseMainDescriptor/update.../transformDynamicImports implementation.
  const source = 'import ThemePage from "@/components/ThemePage.vue";\n'
    + 'import CommunityDeepLinkFeed from "@/components/community/CommunityDeepLinkFeed.vue";\n'
    + `const ${cli.BINDING_COMPONENTS} = ${JSON.stringify(JSON.stringify(metadata))};\n`
    + 'export default {setup(){return {}}};';
  const plugin = createCommunityVideoAppPagePlugin(f.root, 'mp-weixin');
  plugin.configResolved({ command: 'build', build: { sourcemap: false } });
  const context = { async resolve(request) {
    const name = Object.keys(components).find(name => request.endsWith('/' + name + '.vue'));
    return name ? { id: normalized(components[name]) } : null;
  } };
  const result = await plugin.transform.call(context, source, pageFile);
  plugin.generateBundle();
  assert.deepEqual(cli.findUsingComponents('pages/discover/discoverVideo/app'), {
    'theme-page': '/components/ThemePage', 'community-deep-link-feed': '/components/community/CommunityDeepLinkFeed',
  });
  assert.equal(result.code.includes('import ThemePage from'), false);
  const imports = [...result.code.matchAll(/uniComponent:\/\/[^'"]+/g)].map(match => normalized(parseVirtualComponentPath(match[0]))).sort();
  assert.deepEqual(imports, Object.values(components).map(normalized).sort());
  assert.equal(JSON.stringify(cli.findJsonFile('app')), appBefore);
  assert.equal(cli.isAppVue, initialClassifier); assert.equal(cli.isAppVue(rootApp), true); assert.equal(cli.isAppVue(pageFile), true);
  await plugin.transform.call({ resolve: async () => null }, source, pageFile);
  assert.throws(() => plugin.generateBundle(), /component bindings are missing or changed/);
});

test('external compiled script and template modules produce the same bindings in either loading order', async t => {
  const cli = require('@dcloudio/uni-cli-shared'), previousInput = process.env.UNI_INPUT_DIR;
  t.after(() => { if (previousInput === undefined) delete process.env.UNI_INPUT_DIR; else process.env.UNI_INPUT_DIR = previousInput; });
  for (const order of [['script', 'template'], ['template', 'script']]) {
    const f = fixture(t), file = path.join(f.root, 'pages/discover/discoverVideo/app.vue');
    process.env.UNI_INPUT_DIR = f.root;
    cli.addMiniProgramUsingComponents('pages/discover/discoverVideo/app', {});
    const normalized = value => value.replace(/\\/g, '/');
    const plugin = createCommunityVideoAppPagePlugin(f.root, 'mp-weixin');
    plugin.configResolved({ command: 'build', build: { sourcemap: false } });
    const watched = [], context = { addWatchFile: value => watched.push(value), async resolve(request) {
      if (request.startsWith('./app.vue?')) return { id: normalized(file) + request.slice(request.indexOf('?')) };
      if (request.startsWith('@/components/')) return { id: normalized(path.join(f.root, request.slice(2))) };
      return null;
    } };
    await plugin.transform.call(context, 'import Page from "./app.vue?vue&type=script";'
      + 'import {render} from "./app.vue?vue&type=template";export default Page;', file);
    assert.throws(() => plugin.generateBundle(), /component bindings are missing or changed/);
    const blocks = {
      script: 'import ThemePage from "@/components/ThemePage.vue";'
        + 'import CommunityDeepLinkFeed from "@/components/community/CommunityDeepLinkFeed.vue";'
        + 'export default {components:{ThemePage,CommunityDeepLinkFeed}};',
      template: `const ${cli.BINDING_COMPONENTS}=${JSON.stringify(JSON.stringify({
        'theme-page': { name: 'ThemePage', type: 'unknown' },
        'community-deep-link-feed': { name: 'CommunityDeepLinkFeed', type: 'unknown' },
      }))};export function render(){return null;}`,
    };
    for (const [index, type] of order.entries()) {
      await plugin.transform.call(context, blocks[type], normalized(file) + '?vue&type=' + type);
      if (index === 0) assert.throws(() => plugin.generateBundle(), /component bindings are missing or changed/);
    }
    plugin.generateBundle();
    assert.deepEqual(cli.findUsingComponents('pages/discover/discoverVideo/app'), {
      'theme-page': '/components/ThemePage', 'community-deep-link-feed': '/components/community/CommunityDeepLinkFeed',
    });
    assert.deepEqual(watched, [normalized(file), normalized(file)]);
  }
});
