import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
const { parse, compileTemplate } = createRequire(import.meta.url)('../../view/uniapp-ts/node_modules/@vue/compiler-sfc') as typeof import('../../view/uniapp-ts/node_modules/@vue/compiler-sfc');
const root = resolve(import.meta.dirname, '../../view/uniapp-ts/src');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');
const tree = (source: string) => ts.createSourceFile('actual.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const printer = ts.createPrinter({ removeComments: true });
const text = (node: ts.Node, file: ts.SourceFile) => printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/\s/gu, '');
function all<T extends ts.Node>(node: ts.Node, predicate: (value: ts.Node) => value is T): T[] {
  const result: T[] = []; const visit = (value: ts.Node) => { if (predicate(value)) result.push(value); ts.forEachChild(value, visit); }; visit(node); return result;
}
const fn = (file: ts.SourceFile, name: string) => all(file, ts.isFunctionDeclaration).find(node => node.name?.text === name);
const variable = (node: ts.Node, name: string, file: ts.SourceFile) => all(node, ts.isVariableDeclaration).find(value => text(value.name, file) === name)?.initializer;
const calls = (node: ts.Node, name: string, file: ts.SourceFile) => all(node, ts.isCallExpression).filter(value => text(value.expression, file) === name);
function imported(file: ts.SourceFile, module: string, name: string) {
  return file.statements.some(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === module && node.importClause && !node.importClause.isTypeOnly
    && (node.importClause.name?.text === name || node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.some(value => !value.isTypeOnly && value.name.text === name)));
}
function sfc(source: string) {
  const result = parse(source); if (result.errors.length || !result.descriptor.template?.ast || !result.descriptor.scriptSetup) return null;
  if (compileTemplate({ source: result.descriptor.template.content, filename: 'actual.vue', id: 'editorial-boundaries' }).errors.length) return null;
  const nodes: any[] = []; const visit = (node: any) => { if (node.type === 1) nodes.push(node); for (const child of node.children ?? []) visit(child); }; visit(result.descriptor.template.ast);
  return { nodes, script: tree(result.descriptor.scriptSetup.content) };
}
const bind = (node: any, key: string, value: string) => node.props.some((prop: any) => prop.type === 7 && prop.name === 'bind' && prop.arg?.content === key && prop.exp?.content === value);
const event = (node: any, key: string, value: string) => node.props.some((prop: any) => prop.type === 7 && prop.name === 'on' && prop.arg?.content === key && prop.exp?.content === value);
function expression(node: any, name: string) { return node.props.find((prop: any) => prop.type === 7 && prop.name === name)?.exp?.content.replace(/\s/gu, ''); }
function owner(file: ts.SourceFile, name: string) {
  const value = variable(file, name, file); if (!value || !ts.isArrowFunction(value) || !ts.isTemplateExpression(value.body)) return false;
  return ['auth.uid', 'auth.token', 'auth.sessionVersion'].every(member => all(value.body, ts.isPropertyAccessExpression).some(node => text(node, file) === member));
}
function ready(file: ts.SourceFile) {
  const value = variable(file, 'ready', file); if (!value || !ts.isArrowFunction(value)) return false;
  const code = text(value.body, file); return code.includes('!disposed&&active()&&config.value.enabled') && calls(value.body, 'active', file).length === 1;
}
function lease(file: ts.SourceFile, editorial = false) {
  const value = fn(file, 'lease'), returned = value?.body?.statements.find(ts.isReturnStatement)?.expression;
  if (!returned || !ts.isArrowFunction(returned)) return false;
  const code = text(returned.body, file);
  return ['ready()', editorial ? 'epoch.value===generation' : 'epoch===generation', editorial ? 'actor()===owner' : 'actor===owner()', 'key===fingerprint.value'].every(term => code.includes(term)
    || term === 'key===fingerprint.value' && code.includes('fingerprint.value===key'));
}
function returnedCall(file: ts.SourceFile, name: string, property: string, expected: string) {
  const value = fn(file, name)?.body?.statements.find(ts.isReturnStatement)?.expression;
  if (!value || !ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some(node => ts.isPropertyAssignment(node) && text(node.name, file) === property && text(node.initializer, file) === expected);
}
function guardedAssignment(node: ts.BinaryExpression, file: ts.SourceFile) {
  const statement = node.parent;
  return ts.isExpressionStatement(statement) && ts.isBlock(statement.parent) && statement.parent.statements.some(before => before.end <= statement.getStart(file) && ts.isIfStatement(before)
    && text(before.expression, file) === '!current()' && ts.isReturnStatement(before.thenStatement));
}
function rendererBound(source: string) {
  const result = sfc(source); if (!result) return false;
  return [['DiyListWidget', "block.name==='goodList'||block.name==='articleList'"], ['DiyEditorialWidget', 'isEditorialWidget(block)']].every(([name, condition]) => imported(result.script, `./${name}.vue`, name!)
    && result.nodes.some(node => node.tag === name && expression(node, 'else-if') === condition && bind(node, 'block', 'block') && bind(node, 'active', 'pageActive')));
}
function widgetBound(source: string, kind: 'List' | 'Editorial') {
  const result = sfc(source), name = `useDiy${kind}Widget`; if (!result || !imported(result.script, `@/composables/${name}`, name)) return false;
  const call = calls(result.script, name, result.script)[0];
  if (!call || call.arguments.map(node => text(node, result.script)).join(',') !== '()=>props.block,()=>props.active') return false;
  if (kind === 'List') {
    const cards = result.nodes.filter(node => node.tag === 'DiyListProductCard');
    return cards.length === 2 && cards.every(node => bind(node, 'product', 'product') && bind(node, 'config', 'config') && bind(node, 'allowed', 'state.lease()') && event(node, 'open', 'openProduct') && event(node, 'action', 'productAction'))
      && result.nodes.some(node => event(node, 'tap', 'openArticle(article.id)')) && result.nodes.some(node => event(node, 'tap', 'load'));
  }
  return ['news', 'hotspot', 'follow', 'activeParty'].every(name => result.nodes.some(node => ['if', 'else-if'].some(condition => expression(node, condition)?.includes(`config.kind==='${name}'`))))
    && ['showFollowCode', 'saveFollowCode', 'previewFollowPoster', 'closeFollow', 'dismissFollow'].every(action => result.nodes.some(node => event(node, 'tap', action)))
    && result.nodes.some(node => node.tag === 'DiyHotspotCanvas' && bind(node, 'image', 'config.hotspotImage') && bind(node, 'areas', 'config.hotspotAreas') && bind(node, 'allowed', 'state.lease()'));
}
function listOwnerBound(source: string) {
  const file = tree(source), load = fn(file, 'load'), dispose = fn(file, 'dispose');
  if (!load || !dispose || !owner(file, 'owner') || !ready(file) || !lease(file) || !imported(file, '@/stores/auth', 'useAuthStore')) return false;
  if (!['readDiyListProducts', 'readDiyListArticles'].every(name => imported(file, '@/utils/diyListData', name) && calls(load, name, file).length === 1)) return false;
  const assignments = all(load, ts.isBinaryExpression).filter(node => node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ['products.value', 'articles.value'].includes(text(node.left, file)));
  const watch = calls(file, 'watch', file).find(node => node.arguments[0] && text(node.arguments[0], file) === '[fingerprint,owner,active]');
  return assignments.length === 2 && assignments.every(node => guardedAssignment(node, file)) && !!watch && /flush:['"]sync['"]/u.test(text(watch, file))
    && ['stop', 'clear'].every(name => calls(dispose, name, file).length === 1) && calls(file, 'onScopeDispose', file).some(node => node.arguments[0] && text(node.arguments[0], file) === 'dispose');
}
function listScopeBound(source: string) {
  const file = tree(source), value = fn(file, 'normalizeDiyList'); if (!value) return false;
  const selected = variable(value, 'selected', file), code = selected ? text(selected, file) : '';
  const query = all(value, ts.isBinaryExpression).find(node => text(node.left, file) === 'query' && node.operatorToken.kind === ts.SyntaxKind.EqualsToken);
  return !!query && ['goodsList', 'brandList', 'classList', 'goodsLabel'].every(key => code.includes(`listChild(block,${JSON.stringify(key)})`) || code.includes(`listChild(block,'${key}')`))
    && calls(selected!, 'selectedIds', file).length === 4 && ['ids', 'brand_id', 'cate_id', 'store_label_id'].every(key => all(query.right, ts.isPropertyAssignment).some(node => text(node.name, file) === key))
    && text(query.parent.parent, file).includes('selected.length&&limit>0');
}
function projectionBound(source: string) {
  const file = tree(source), products = fn(file, 'checkedDiyListProducts'), articles = fn(file, 'checkedDiyArticles'); if (!products || !articles) return false;
  const frame = variable(products, 'frame', file), articleReturn = all(articles, ts.isReturnStatement).find(node => node.expression && ts.isObjectLiteralExpression(node.expression));
  return imported(file, './diyCommerceData', 'checkedPromotionProducts') && calls(products, 'checkedPromotionProducts', file).length === 1 && !!frame && calls(frame, 'Array.isArray', file).length === 1
    && text(frame, file).includes('raw.activity_frame.length===0') && calls(products, 'safeDiyImageUrl', file).length === 2
    && calls(products, 'safeDiyImageUrl', file).some(node => node.arguments[0] && text(node.arguments[0], file) === 'product.image')
    && calls(articles, 'Array.isArray', file).length >= 2 && calls(articles, 'seen.has', file).length === 1 && !!articleReturn
    && ['visit', 'likes', 'add_time', 'image_input'].every(key => all(articleReturn, ts.isPropertyAssignment).some(node => text(node.name, file) === key) || all(articleReturn, ts.isShorthandPropertyAssignment).some(node => text(node.name, file) === key));
}
function waterfallBound(source: string) {
  const result = sfc(source); if (!result) return false;
  const measure = fn(result.script, 'measure'), dispose = calls(result.script, 'onScopeDispose', result.script)[0]; if (!measure || !dispose) return false;
  return calls(measure, 'uni.createSelectorQuery', result.script).length === 1 && all(measure, ts.isCallExpression).some(node => ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'in' && node.arguments[0] && text(node.arguments[0], result.script) === 'instance.proxy')
    && all(measure, ts.isCallExpression).some(node => ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'select' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '.diy-list-product')
    && text(measure, result.script).includes('alive&&allowed()&&props.product.id===id') && calls(measure, 'emit', result.script).some(node => node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'measured')
    && text(dispose, result.script).includes('alive=false');
}
function explicitFollowBound(source: string) {
  const file = tree(source), action = fn(file, 'imageAction'), dispose = fn(file, 'dispose'); if (!action || !dispose || !owner(file, 'actor') || !ready(file) || !lease(file, true)) return false;
  if (!imported(file, '@/api/legacyShare', 'apiFollowPoster') || !imported(file, '@/utils/shareImage', 'readableShareImage') || !imported(file, '@/utils/diyEditorialMediaLease', 'diyEditorialMediaCacheUsable')) return false;
  const poster = calls(file, 'apiFollowPoster', file), sourceValue = variable(action, 'source', file), fileValue = variable(action, 'file', file);
  const save = calls(action, 'uni.saveImageToPhotosAlbum', file)[0];
  const awaitedSave = save && all(action, ts.isAwaitExpression).some(node => node.getStart(file) <= save.getStart(file) && node.end >= save.end);
  return poster.length === 1 && poster[0]!.getStart(file) > action.getStart(file) && poster[0]!.end < action.end && !!sourceValue && text(sourceValue, file) === 'poster?awaitapiFollowPoster():code'
    && !!fileValue && calls(fileValue, 'readableShareImage', file).length === 1 && !!awaitedSave && text(action, file).includes('if(!current())return;')
    && returnedCall(file, 'useDiyEditorialWidget', 'previewFollowPoster', '()=>imageAction(true)') && returnedCall(file, 'useDiyEditorialWidget', 'saveFollowCode', '()=>imageAction(false)')
    && calls(file, 'watch', file).some(node => node.arguments[0] && text(node.arguments[0], file) === '[fingerprint,actor,active]' && node.arguments[1] && text(node.arguments[1], file) === 'reset')
    && ['stop', 'stopDialog', 'reset'].every(name => calls(dispose, name, file).length === 1);
}
function mediaLeaseBound(hostSource: string, cacheSource: string) {
  const host = tree(hostSource), cache = tree(cacheSource), schedule = fn(host, 'scheduleMediaRefresh'), reload = fn(host, 'reload'), invalidate = fn(host, 'invalidate'), load = fn(cache, 'loadDiyPage');
  return !!schedule && !!reload && !!invalidate && !!load && imported(host, '@/utils/diyEditorialMediaLease', 'diyEditorialMediaDeadline')
    && calls(schedule, 'diyEditorialMediaDeadline', host).length === 1 && calls(schedule, 'setTimeout', host).length === 1
    && text(schedule, host).includes('timerEpoch!==mediaTimerEpoch||!current()') && calls(reload, 'scheduleMediaRefresh', host).some(node => node.arguments.map(value => text(value, host)).join(',') === 'snapshot.data,snapshot.cachedAt,current')
    && calls(invalidate, 'cancelMediaTimer', host).length === 1 && imported(cache, './diyEditorialMediaLease', 'diyEditorialMediaCacheUsable') && calls(load, 'diyEditorialMediaCacheUsable', cache).length === 3;
}
function removeOwnedCall(source: string, owner: string, name: string): string {
  const file = tree(source), scope = fn(file, owner), call = scope && calls(scope, name, file)[0];
  if (!call) throw Error(`Missing actual ${owner}.${name}`);
  return source.slice(0, call.getStart(file)) + 'unrelated()' + source.slice(call.end);
}
const actual = {
  renderer: read('components/diy/DiyHomeRenderer.vue'), list: read('components/diy/DiyListWidget.vue'), card: read('components/diy/DiyListProductCard.vue'),
  listOwner: read('composables/useDiyListWidget.ts'), listConfig: read('utils/diyListConfig.ts'), data: read('utils/diyListData.ts'),
  editorial: read('components/diy/DiyEditorialWidget.vue'), editorialOwner: read('composables/useDiyEditorialWidget.ts'),
  host: read('composables/useDiyPageHost.ts'), cache: read('utils/diy.ts'),
};

describe('six-component DIY editorial actual frontend boundaries', () => {
  it('mounts both extracted real children with the authored block and root visibility owner', () => {
    expect(rendererBound(actual.renderer)).toBe(true);
    for (const mutant of [actual.renderer.replace('import DiyListWidget from', 'import type DiyListWidget from'), actual.renderer.replaceAll(':active="pageActive"', ':active="true"'), actual.renderer.replaceAll(':block="block"', ':block="other"'), actual.renderer.replace('isEditorialWidget(block)', 'unrelated(block)')]) expect(rendererBound(mutant)).toBe(false);
  });
  it('binds live native list and editorial actions to their real block/active composables', () => {
    for (const [name, kind] of [['list', 'List'], ['editorial', 'Editorial']] as const) {
      expect(widgetBound(actual[name], kind)).toBe(true);
      for (const mutant of [actual[name].replace('()=>props.active', '()=>true'), actual[name].replace(`import { useDiy${kind}Widget }`, `import type { useDiy${kind}Widget }`), `<template><!-- ${actual[name]} --></template>`]) expect(widgetBound(mutant, kind)).toBe(false);
    }
    expect(widgetBound(actual.list.replaceAll(':allowed="state.lease()"', ':allowed="()=>true"'), 'List')).toBe(false);
    expect(widgetBound(actual.editorial.replace('@tap="previewFollowPoster"', '@tap="unrelated"'), 'Editorial')).toBe(false);
  });
  it('adopts each independently loaded real list only under its complete owner/config/active generation', () => {
    expect(listOwnerBound(actual.listOwner)).toBe(true);
    for (const mutant of [actual.listOwner.replace('auth.sessionVersion', '0'), actual.listOwner.replace('actor === owner()', 'true'), actual.listOwner.replace('epoch === generation', 'true'), actual.listOwner.replace('key === fingerprint.value', 'true'), actual.listOwner.replace('!disposed && active()', '!disposed && true'), actual.listOwner.replaceAll('if (!current()) return;', 'if (false) return;'), actual.listOwner.replace('[fingerprint, owner, active]', '[fingerprint, owner]'), actual.listOwner.replace('onScopeDispose(dispose)', 'unrelated(dispose)')]) expect(listOwnerBound(mutant)).toBe(false);
  });
  it('keeps all four actual product scopes and rejects detached or broadened scope projection', () => {
    expect(listScopeBound(actual.listConfig)).toBe(true);
    for (const [before, after] of [["selectedIds(listChild(block, 'brandList').brandVal)", '[]'], ["{ store_label_id: selected.join(',') }", '{}'], ['selected.length && limit > 0', 'true']]) {
      expect(actual.listConfig).toContain(before); expect(listScopeBound(actual.listConfig.replace(before!, after!))).toBe(false);
    }
  });
  it('accepts the real no-frame array contract while retaining strict product and article DTO projection', () => {
    expect(projectionBound(actual.data)).toBe(true);
    for (const mutant of [actual.data.replace('checkedPromotionProducts(value, limit)', 'unrelated(value, limit)'), actual.data.replace('raw.activity_frame.length === 0', 'true'), actual.data.replace('seen.has(id)', 'false'), actual.data.replaceAll('safeDiyImageUrl(frame.image)', 'frame.image'), actual.data.replaceAll('safeDiyImageUrl(product.image)', 'product.image')]) expect(projectionBound(mutant)).toBe(false);
  });
  it('measures inside each actual product card scope with an instance owner lease and disposal fence', () => {
    expect(waterfallBound(actual.card)).toBe(true);
    for (const mutant of [actual.card.replace('.in(instance.proxy)', '.in(other)'), actual.card.replace(".select('.diy-list-product')", ".selectAll('.diy-list-product')"), actual.card.replace('alive&&allowed()', 'alive&&true'), actual.card.replace("emit('measured'", "emit('unrelated'"), actual.card.replace('alive=false', 'alive=true')]) expect(waterfallBound(mutant)).toBe(false);
  });
  it('generates follow resources only through the explicit action and awaits native save completion under dialog ownership', () => {
    expect(explicitFollowBound(actual.editorialOwner)).toBe(true);
    for (const mutant of [actual.editorialOwner.replace('auth.token', "'ignored'"), actual.editorialOwner.replace('epoch.value === generation', 'true'), actual.editorialOwner.replace('fingerprint.value === key', 'true'), actual.editorialOwner.replace('poster ? await apiFollowPoster() : code', 'await apiFollowPoster()'), actual.editorialOwner.replace('else await new Promise<void>', 'else new Promise<void>'), actual.editorialOwner.replace('()=>imageAction(true)', '()=>unrelated(true)').replace('() => imageAction(true)', '() => unrelated(true)'), actual.editorialOwner.replace('[fingerprint, actor, active]', '[fingerprint, actor]'), actual.editorialOwner.replace('import { apiFollowPoster }', 'import type { apiFollowPoster }')]) expect(explicitFollowBound(mutant)).toBe(false);
  });
  it('connects active page renewal to snapshot media deadlines and refuses expired cache and offline reuse', () => {
    expect(mediaLeaseBound(actual.host, actual.cache)).toBe(true);
    for (const mutant of [actual.host.replace('scheduleMediaRefresh(snapshot.data, snapshot.cachedAt, current)', 'scheduleMediaRefresh(snapshot.data, Date.now(), current)'), actual.host.replace('timerEpoch !== mediaTimerEpoch || !current()', 'false'), removeOwnedCall(actual.host, 'invalidate', 'cancelMediaTimer')]) expect(mediaLeaseBound(mutant, actual.cache)).toBe(false);
    expect(mediaLeaseBound(actual.host, actual.cache.replaceAll('diyEditorialMediaCacheUsable(cached.data, cached.cachedAt)', 'true'))).toBe(false);
  });
});
