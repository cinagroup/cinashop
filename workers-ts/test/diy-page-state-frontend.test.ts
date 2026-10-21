import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
const { parse, compileTemplate } = createRequire(import.meta.url)('../../view/uniapp-ts/node_modules/@vue/compiler-sfc') as typeof import('../../view/uniapp-ts/node_modules/@vue/compiler-sfc');
const root = resolve(import.meta.dirname, '../../view/uniapp-ts/src');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const sourceFile = (source: string) => ts.createSourceFile('actual-diy-page.ts', source, ts.ScriptTarget.Latest, true);
function all<T extends ts.Node>(node: ts.Node, predicate: (n: ts.Node) => n is T): T[] {
  const result: T[] = []; const visit = (n: ts.Node) => { if (predicate(n)) result.push(n); ts.forEachChild(n, visit); }; visit(node); return result;
}
function valueImport(source: ts.SourceFile, path: string, name: string) {
  return source.statements.some(n => ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === path
    && n.importClause && !n.importClause.isTypeOnly && (n.importClause.name?.text === name || n.importClause.namedBindings && ts.isNamedImports(n.importClause.namedBindings)
      && n.importClause.namedBindings.elements.some(row => !row.isTypeOnly && row.name.text === name)));
}
const calls = (node: ts.Node, name: string) => all(node, ts.isCallExpression).filter(n => n.expression.getText() === name);
const variable = (node: ts.Node, name: string) => all(node, ts.isVariableDeclaration).find(n => n.name.getText() === name);
const fn = (node: ts.Node, name: string) => all(node, ts.isFunctionDeclaration).find(n => n.name?.text === name);
const equal = (node: ts.Node, left: string, right: string) => all(node, ts.isBinaryExpression).find(n => n.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.left.getText() === left && n.right.getText() === right);
const earlyReturn = (node: ts.Node, condition: string) => all(node, ts.isIfStatement).find(n => n.expression.getText() === condition && ts.isReturnStatement(n.thenStatement));
function sfc(source: string) {
  const parsed = parse(source, { filename: 'ActualDiyRoot.vue' }); expect(parsed.errors).toEqual([]);
  const template = parsed.descriptor.template!; expect(template).toBeTruthy(); expect(parsed.descriptor.scriptSetup).toBeTruthy();
  expect(compileTemplate({ source: template.content, filename: 'ActualDiyRoot.vue', id: 'diy-host-bindings' }).errors).toEqual([]);
  const nodes: any[] = []; const visit = (n: any) => { if (n.type === 1) nodes.push(n); for (const child of n.children ?? []) visit(child); }; visit(template.ast);
  return { script: sourceFile(parsed.descriptor.scriptSetup!.content), nodes };
}
const directive = (node: any, name: string, arg: string, exp: string) => (node.props ?? []).some((p: any) => p.type === 7 && p.name === name && p.arg?.content === arg && p.exp?.content === exp);
function rootBound(source: string, home: boolean) {
  const { script, nodes } = sfc(source), host = variable(script, 'diyHost')?.initializer;
  const adopted = all(script, ts.isVariableDeclaration).find(n => ts.isObjectBindingPattern(n.name) && n.initializer?.getText() === 'diyHost');
  return valueImport(script, '@/composables/useDiyPageHost', 'useDiyPageHost') && valueImport(script, '@/components/diy/DiyHomeRenderer.vue', 'DiyHomeRenderer')
    && !!host && ts.isCallExpression(host) && host.expression.getText() === 'useDiyPageHost'
    && host.arguments[0]?.getText() === (home ? '() => 0' : '() => pageId.value') && host.arguments[1]?.getText() === '() => diyCommunityVisible.value'
    && !!adopted && ts.isObjectBindingPattern(adopted.name) && adopted.name.elements.some(n => n.propertyName?.getText() === 'available' && n.name.getText() === 'diyPageActive')
    && adopted.name.elements.some(n => (n.propertyName?.getText() ?? n.name.getText()) === 'page' && n.name.getText() === (home ? 'diyPage' : 'page'))
    && nodes.some(n => n.tag === 'DiyHomeRenderer' && directive(n, 'bind', 'components', home ? 'diyPage.value' : 'page.value')
      && directive(n, 'bind', 'page-active', 'diyPageActive') && directive(n, 'on', 'closed', 'diyHost.close'));
}
function lifecycleBound(source: string) {
  const { script } = sfc(source), show = calls(script, 'onShow')[0]?.arguments[0], hide = calls(script, 'onHide')[0]?.arguments[0], unload = calls(script, 'onUnload')[0]?.arguments[0];
  if (!show || !hide || !unload || !['onShow', 'onHide', 'onUnload'].every(name => valueImport(script, '@dcloudio/uni-app', name))) return false;
  const guard = all(show, ts.isIfStatement).find(n => n.expression.getText() === '!diyCommunityDisposed');
  return !!guard && !!equal(guard.thenStatement, 'diyCommunityVisible.value', 'true') && !!equal(hide, 'diyCommunityVisible.value', 'false')
    && !!equal(unload, 'diyCommunityDisposed', 'true') && !!equal(unload, 'diyCommunityVisible.value', 'false') && calls(unload, 'diyHost.dispose').length === 1;
}
function microRouteBound(source: string) {
  const { script } = sfc(source), load = calls(script, 'onLoad')[0]?.arguments[0];
  if (!load || !valueImport(script, '@dcloudio/uni-app', 'onLoad')) return false;
  const raw = variable(load, 'raw')?.initializer, id = variable(load, 'id')?.initializer;
  const rejection = all(load, ts.isIfStatement).find(n => n.expression.getText() === '!Number.isSafeInteger(id) || id > 2147483647');
  const adoption = equal(load, 'pageId.value', 'id');
  const allowed = new Set(['Number', 'Number.isSafeInteger', '/^[1-9]\\d{0,9}$/.test']);
  return raw?.getText() === 'options?.id' && !!id && ts.isConditionalExpression(id)
    && id.condition.getText() === 'typeof raw === "string" && /^[1-9]\\d{0,9}$/.test(raw)' && id.whenTrue.getText() === 'Number(raw)' && id.whenFalse.getText() === 'NaN'
    && !!rejection && !!equal(rejection.thenStatement, 'pageId.value', 'null') && !!equal(rejection.thenStatement, 'routeError.value', '"微页面链接无效"')
    && all(rejection.thenStatement, ts.isReturnStatement).length === 1 && !!adoption && rejection.end < adoption.getStart()
    && all(load, ts.isCallExpression).every(call => allowed.has(call.expression.getText()));
}
function reloadBound(source: string) {
  const script = sourceFile(source), reload = fn(script, 'reload'); if (!reload?.body) return false;
  const current = variable(reload, 'current')?.initializer, invoke = calls(reload, 'loadDiyPage')[0];
  const attempt = all(reload, ts.isTryStatement)[0], guards = all(reload, ts.isIfStatement).filter(n => n.expression.getText() === '!current()' && ts.isReturnStatement(n.thenStatement));
  const adoption = equal(reload, 'page.value', 'snapshot.data'), title = calls(reload, 'uni.setNavigationBarTitle')[0];
  const guardedFinally = attempt?.finallyBlock && all(attempt.finallyBlock, ts.isIfStatement).some(n => n.expression.getText() === 'current()' && !!equal(n.thenStatement, 'loading.value', 'false'));
  return valueImport(script, '@/utils/diy', 'loadDiyPage') && !!current && ts.isArrowFunction(current)
    && current.body.getText() === 'visible() && revision === generation && pageId === id() && actor === owner()'
    && !!invoke && invoke.arguments.map(a => a.getText()).join(',') === 'pageId,force,current'
    && guards.length === 2 && !!adoption && guards[0].end < adoption.getStart() && !!title && adoption.end < title.getStart()
    && title.arguments[0]?.getText() === '{ title: page.value.title }' && !!attempt && !!attempt.catchClause
    && guards[1].getStart() > attempt.catchClause.getStart() && !!equal(attempt.catchClause, 'page.value', 'null') && !!guardedFinally;
}
function ownershipBound(source: string) {
  const script = sourceFile(source), host = fn(script, 'useDiyPageHost'); if (!host) return false;
  const owner = variable(host, 'owner')?.initializer, visible = variable(host, 'visible')?.initializer, stop = variable(host, 'stop')?.initializer;
  const dispose = fn(host, 'dispose'), invalidate = fn(host, 'invalidate');
  if (!stop || !ts.isCallExpression(stop) || stop.expression.getText() !== 'watch' || !dispose || !invalidate) return false;
  const callback = stop.arguments[1], options = stop.arguments[2];
  return valueImport(script, '@/stores/auth', 'useAuthStore') && calls(host, 'useAuthStore').length === 1
    && owner?.getText() === '() => `${auth.uid}:${auth.token}:${auth.sessionVersion}`' && visible?.getText() === '() => !disposed && active() && id() !== null'
    && stop.arguments[0]?.getText() === '[id, active, owner]' && !!callback && calls(callback, 'invalidate')[0]?.arguments[0]?.getText() === '!previous || next[0] !== previous[0] || next[2] !== previous[2]'
    && all(callback, ts.isIfStatement).some(n => n.expression.getText() === 'visible()' && calls(n.thenStatement, 'reload').length === 1)
    && options?.getText() === '{ immediate: true, flush: "sync" }'
    && !!equal(dispose, 'disposed', 'true') && calls(dispose, 'stop').length === 1 && calls(dispose, 'invalidate')[0]?.arguments[0]?.getText() === 'true'
    && calls(host, 'onScopeDispose')[0]?.arguments[0]?.getText() === 'dispose'
    && all(invalidate, ts.isIfStatement).some(n => n.expression.getText() === 'clear' && !!equal(n.thenStatement, 'page.value', 'null'));
}
function refreshBound(source: string) {
  const script = sourceFile(source), refresh = fn(script, 'refresh'); if (!refresh) return false;
  const pending = calls(refresh, 'Promise.allSettled')[0], result = variable(refresh, 'adopted')?.initializer;
  const guarded = all(refresh, ts.isIfStatement).find(n => n.expression.getText() === 'adopted && visible() && revision === pullGeneration');
  return !!earlyReturn(refresh, '!visible()') && variable(refresh, 'revision')?.initializer?.getText() === '++pullGeneration'
    && !!pending && calls(pending, 'reload')[0]?.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword && calls(pending, 'additional').length === 1
    && result?.getText() === 'result.status === "fulfilled" && result.value' && !!guarded && calls(guarded.thenStatement, 'uni.stopPullDownRefresh').length === 1;
}
function closureBound(source: string) {
  const script = sourceFile(source), close = fn(script, 'close'); if (!close) return false;
  const guard = earlyReturn(close, '!visible()'), signal = calls(close, 'closeDiyStation')[0], invalidate = calls(close, 'invalidate')[0];
  return valueImport(script, '@/utils/diy', 'closeDiyStation') && !!guard && !!signal && signal.arguments[0]?.getText() === 'message' && guard.end < signal.getStart()
    && !!invalidate && invalidate.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword && signal.end < invalidate.getStart()
    && !!equal(close, 'error.value', 'message') && !!equal(close, 'phase.value', '"closed"');
}
function rootRefreshBound(source: string, home: boolean) {
  const { script, nodes } = sfc(source), pull = calls(script, 'onPullDownRefresh')[0]?.arguments[0];
  if (!pull || !valueImport(script, '@dcloudio/uni-app', 'onPullDownRefresh')) return false;
  const refresh = calls(pull, 'diyHost.refresh')[0]; if (!refresh || refresh.arguments.map(a => a.getText()).join(',') !== (home ? 'load' : '')) return false;
  const handler = home ? 'loadDiy(true)' : 'reload(true)';
  const hasButton = (node: any): boolean => node.tag === 'button' && directive(node, 'on', 'tap', handler) || (node.children ?? []).some(hasButton);
  const condition = (node: any, expression: string) => (node.props ?? []).some((p: any) => p.type === 7 && ['if', 'else-if'].includes(p.name) && p.exp?.content === expression);
  const errorView = nodes.find(n => condition(n, home ? 'diyError' : 'error'));
  const offlineViews = nodes.filter(n => condition(n, home ? 'diyOffline' : 'offline'));
  if (!errorView || !hasButton(errorView) || !offlineViews.length || !offlineViews.every(hasButton)) return false;
  if (home) {
    const action = variable(script, 'loadDiy')?.initializer;
    return !!action && ts.isArrowFunction(action) && calls(action, 'diyHost.reload')[0]?.arguments[0]?.getText() === 'force';
  }
  const retry = all(script, ts.isVariableDeclaration).find(n => ts.isObjectBindingPattern(n.name) && n.initializer?.getText() === 'diyHost' && n.name.elements.some(e => e.name.getText() === 'reload'));
  return !!retry && all(pull, ts.isIfStatement).some(n => n.expression.getText() === 'pageId.value === null'
    && all(n.thenStatement, ts.isIfStatement).some(g => g.expression.getText() === 'diyCommunityVisible.value' && calls(g.thenStatement, 'uni.stopPullDownRefresh').length === 1));
}
function apiLoaderBound(source: string) {
  const script = sourceFile(source), load = fn(script, 'loadDiyPage'); if (!load) return false;
  const guard = all(load, ts.isIfStatement).find(n => n.expression.getText() === '!Number.isSafeInteger(id) || id < 0 || id > 2147483647' && all(n.thenStatement, ts.isThrowStatement).length === 1);
  const initialVersion = variable(load, 'version')?.initializer;
  const version = initialVersion && calls(initialVersion, 'apiDiyVersion')[0], cacheRead = calls(load, 'readCache')[0], page = calls(load, 'apiDiyPage')[0], normalize = calls(load, 'normalizeDiyPage')[0], cache = calls(load, 'writeCache')[0];
  return ['apiDiyPage', 'apiDiyVersion'].every(name => valueImport(script, '@/api/diy', name)) && !!guard && !!version && !!page && !!cacheRead
    && guard.end < version.getStart() && version.end < page.getStart() && guard.end < cacheRead.getStart() && version.arguments[0]?.getText() === 'safeId' && page.arguments[0]?.getText() === 'safeId'
    && !!normalize && normalize.arguments[0]?.getText() === 'raw' && !!cache && normalize.end < cache.getStart();
}
const home = read('pages/index/index.vue'), micro = read('pages/diy/detail.vue'), host = read('composables/useDiyPageHost.ts'), loader = read('utils/diy.ts');
function mutant(check: (s: string) => boolean, source: string, before: string, after: string) {
  expect(source).toContain(before); const changed = source.replace(before, after); expect(changed).not.toBe(source); expect(check(changed)).toBe(false);
}
describe('actual DIY root page state assembly', () => {
  it('connects both actual root SFCs through the value host and available alias into components, visibility and closed events', () => {
    expect(rootBound(home, true)).toBe(true); expect(rootBound(micro, false)).toBe(true);
  });
  it('rejects value-import, invocation, identity, availability and event disconnections in both real templates', () => {
    for (const [source, isHome] of [[home, true], [micro, false]] as const) {
      const check = (s: string) => rootBound(s, isHome);
      mutant(check, source, 'import { useDiyPageHost }', 'import type { useDiyPageHost }');
      mutant(check, source, '= useDiyPageHost(', '= unusedHost(');
      mutant(check, source, isHome ? '() => 0' : '() => pageId.value', '() => 999');
      mutant(check, source, '() => diyCommunityVisible.value', '() => true');
      mutant(check, source, ':components="' + (isHome ? 'diyPage.value' : 'page.value') + '"', ':components="unrelated"');
      mutant(check, source, ':page-active="diyPageActive"', ':page-active="true"');
      mutant(check, source, '@closed="diyHost.close"', '@closed="unrelated"');
    }
  });
  it('binds actual Uni show/hide/unload callbacks and prevents disposed roots from reactivating the shared host', () => {
    for (const source of [home, micro]) {
      expect(lifecycleBound(source)).toBe(true);
      mutant(lifecycleBound, source, 'onShow(() =>', 'unusedOnShow(() =>');
      mutant(lifecycleBound, source, 'if (!diyCommunityDisposed)', 'if (true)');
      mutant(lifecycleBound, source, 'onHide(() => { diyCommunityVisible.value = false;', 'onHide(() => { unrelated.value = false;');
      mutant(lifecycleBound, source, 'diyCommunityDisposed = true;', 'diyCommunityDisposed = false;');
      mutant(lifecycleBound, source, 'diyHost.dispose();', 'unrelated.dispose();');
    }
  });
  it('admits only actual canonical numeric micro ids before all business reads and preserves local invalid-route status', () => {
    expect(microRouteBound(micro)).toBe(true);
    mutant(microRouteBound, micro, '/^[1-9]\\d{0,9}$/', '/^\\d+$/');
    mutant(microRouteBound, micro, 'id > 2147483647', 'id > 999999999999');
    mutant(microRouteBound, micro, 'pageId.value = null; routeError.value', 'pageId.value = id; routeError.value');
    mutant(microRouteBound, micro, 'const raw = options?.id;', 'apiDiyPage(2); const raw = options?.id;');
  });
  it('runs the value-imported loader with the real owner predicate before success/error/title and guarded finally effects', () => {
    expect(reloadBound(host)).toBe(true);
    mutant(reloadBound, host, 'DiyPageLoadError, isDiyEnabled, loadDiyPage', 'DiyPageLoadError, isDiyEnabled, type loadDiyPage');
    mutant(reloadBound, host, 'await loadDiyPage(pageId, force, current)', 'await unusedLoad(pageId, force, current)');
    mutant(reloadBound, host, 'loadDiyPage(pageId, force, current)', 'loadDiyPage(pageId, force, () => true)');
    mutant(reloadBound, host, 'revision === generation', 'true');
    mutant(reloadBound, host, 'actor === owner()', 'true');
    mutant(reloadBound, host, 'if (!current()) return false;', 'if (false) return false;');
    mutant(reloadBound, host, '{ title: page.value.title }', '{ title: "retired title" }');
    mutant(reloadBound, host, 'finally { if (current())', 'finally { if (true)');
  });
  it('ties all owner epochs and active/id watchers to synchronous invalidation, scope disposal and current-only reload', () => {
    expect(ownershipBound(host)).toBe(true);
    mutant(ownershipBound, host, '${auth.uid}:${auth.token}:${auth.sessionVersion}', '${auth.uid}:${auth.token}');
    mutant(ownershipBound, host, '!disposed && active() && id() !== null', '!disposed && id() !== null');
    mutant(ownershipBound, host, 'watch([id, active, owner]', 'watch([id, active]');
    mutant(ownershipBound, host, 'flush: "sync"', 'flush: "post"');
    mutant(ownershipBound, host, 'onScopeDispose(dispose)', 'onScopeDispose(() => {})');
  });
  it('stops native pull indicators only for the actually adopted current visible refresh and runs explicit force', () => {
    expect(refreshBound(host)).toBe(true);
    mutant(refreshBound, host, '[reload(true),', '[reload(false),');
    mutant(refreshBound, host, 'additional?.()', 'unusedAdditional?.()');
    mutant(refreshBound, host, 'result.status === "fulfilled" && result.value', 'true');
    mutant(refreshBound, host, 'adopted && visible() && revision === pullGeneration', 'adopted');
  });
  it('forwards a current child closure into shared schema invalidation and never closes from a hidden root', () => {
    expect(closureBound(host)).toBe(true);
    mutant(closureBound, host, 'import { closeDiyStation,', 'import { type closeDiyStation,');
    mutant(closureBound, host, 'function close(message: string): void {\n    if (!visible()) return;', 'function close(message: string): void {\n    if (false) return;');
    mutant(closureBound, host, 'closeDiyStation(message);', 'unusedClose(message);');
    mutant(closureBound, host, 'closeDiyStation(message); invalidate(true);', 'closeDiyStation(message); invalidate(false);');
  });
  it('binds native pull callbacks and visible retry controls to actual force/reload without detached duplicate loaders', () => {
    expect(rootRefreshBound(home, true)).toBe(true); expect(rootRefreshBound(micro, false)).toBe(true);
    mutant(s => rootRefreshBound(s, true), home, 'diyHost.refresh(load)', 'diyHost.refresh()');
    mutant(s => rootRefreshBound(s, true), home, 'diyHost.reload(force)', 'unusedReload(force)');
    mutant(s => rootRefreshBound(s, false), micro, 'void diyHost.refresh();', 'void unusedRefresh();');
    mutant(s => rootRefreshBound(s, false), micro, '@tap="reload(true)"', '@tap="unusedReload(true)"');
  });
  it('binds the actual loader to both real API value imports and strict local id validation before cache or transport', () => {
    expect(apiLoaderBound(loader)).toBe(true);
    mutant(apiLoaderBound, loader, '  apiDiyPage,', '  type apiDiyPage,');
    mutant(apiLoaderBound, loader, 'await apiDiyVersion(safeId)', 'await unusedVersion(safeId)');
    mutant(apiLoaderBound, loader, 'await apiDiyPage(safeId)', 'await unusedPage(safeId)');
    mutant(apiLoaderBound, loader, '!Number.isSafeInteger(id) || id < 0 || id > 2147483647', 'id < 0');
  });
});
