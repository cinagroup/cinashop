import { peelMessageCenterReportIfPresent,peelMessageCenterSourceIfPresent } from './helpers/messageCenterSourceBinding';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from '../scripts/admin-frontend-api-audit';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { REGISTERED_PAGE_ROUTES as clientRoutes, LEGACY_ROUTE_RULES as clientRules, resolveRegisteredPageRoute as clientResolve } from '../../view/uniapp-ts/src/config/navigation';
import { REGISTERED_PAGE_ROUTES as serverRoutes, LEGACY_ROUTE_RULES as serverRules, resolveRegisteredPageRoute as serverResolve } from '../src/services/content/FabRouteRegistry';
import { reviewedRouteTailSourceBinding as p, reverseReviewedRouteTailSource, peelReviewedRouteTailSourceIfPresent,
  peelReviewedRouteTailRegisteredRoutesIfPresent, peelReviewedRouteTailLegacyRulesIfPresent, readReviewedRouteTailHistoricalFile,
  reverseReviewedRouteTailReport, peelReviewedRouteTailReportForHistoricalAudit, applyReviewedRouteTailReport } from './helpers/reviewedRouteTailSourceBinding';
import { reverseMemberLevelActivationSource, reverseMemberLevelActivationRegisteredRoutes, reverseMemberLevelActivationLegacyRules } from './helpers/memberLevelActivationSourceBinding';

const root = resolve(import.meta.dirname, '../..'), read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const sha = (source: string) => createHash('sha256').update(source).digest('hex');
const blob = (source: string) => createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
const pretty = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const navFiles = ['view/uniapp-ts/src/pages.json', 'view/uniapp-ts/src/config/navigation.ts', 'workers-ts/src/services/content/FabRouteRegistry.ts'];
const pages = {
  '/pages/user/promoterRank': { navigationBarTitleText: '推广人排行', navigationBarBackgroundColor: '#FCCEA4', navigationBarTextStyle: 'black' },
  '/pages/user/commissionRank': { navigationBarTitleText: '佣金排行', navigationBarBackgroundColor: '#1B1311', navigationBarTextStyle: 'white' },
  '/pages/user/promoterOrders': { navigationBarTitleText: '分销订单' }, '/pages/user/promoterPeople': { navigationBarTitleText: '我的推广' },
  '/pages/user/distributionLedgers': { navigationBarTitleText: '佣金记录' },
  '/pages/user/withdrawalApplication': { navigationBarTitleText: '提现', navigationStyle: 'custom' },
  '/pages/user/withdrawalReceipt': { navigationBarTitleText: '提现审核' }, '/pages/user/agentExplanation': { navigationBarTitleText: '分销说明' },
};
const aliases = {
  '/pages/users/promoter_rank/index': '/pages/user/promoterRank', '/pages/users/commission_rank/index': '/pages/user/commissionRank',
  '/pages/users/promoter-order/index': '/pages/user/promoterOrders', '/pages/users/promoter-list/index': '/pages/user/promoterPeople',
  '/pages/users/user_spread_money/index': '/pages/user/distributionLedgers', '/pages/users/user_cash/index': '/pages/user/withdrawalApplication',
  '/pages/users/user_cash/status': '/pages/user/withdrawalReceipt', '/pages/users/user_distribution_info/index': '/pages/user/agentExplanation',
};
let report: ReturnType<typeof buildAdminFrontendApiAuditReport> | undefined;
const currentReport = () => structuredClone(report ??= peelMessageCenterReportIfPresent(buildAdminFrontendApiAuditReport()));

describe('reviewed current route tail retains dated proofs and proves real current coverage', () => {
  it('pins all later source stages, five explicit harness rewires and every prior dated fixture', () => {
    expect(sha(read('workers-ts/test/fixtures/reviewed-route-tail-source-binding-20261028.json'))).toBe('1fd855b397eb496e1d2accca18eeeb96b905d5e7f499657dc785310c2b246d6c');
    expect(p.route_stages.map(stage => [stage.before_count, stage.after_count, stage.added_routes.length, stage.rule_edits.length]))
      .toEqual([[145, 150, 5, 5], [150, 152, 2, 2], [152, 153, 1, 1]]);
    expect(p.harness_sources.map(row => row.file).sort()).toEqual([
      'workers-ts/test/helpers/memberLevelActivationSourceBinding.ts', 'workers-ts/test/helpers/membershipRightsSourceBinding.ts',
      'workers-ts/test/member-level-activation-source-binding.test.ts', 'workers-ts/test/membership-card-activation-source-binding.test.ts',
      'workers-ts/test/membership-rights-source-binding.test.ts',
    ].sort());
    for (const row of p.harness_sources) {
      const actual = read(row.file), before = reverseReviewedRouteTailSource(row.file, actual);
      expect([sha(actual), Buffer.byteLength(actual), blob(actual)]).toEqual([row.after_sha256, row.after_bytes, row.after_git_blob_sha1]);
      expect([sha(before), Buffer.byteLength(before), blob(before)]).toEqual([row.before_sha256, row.before_bytes, row.before_git_blob_sha1]);
      let rebuilt = before; for (const edit of row.edits) rebuilt = rebuilt.replace(edit.before_source, edit.after_source);
      expect(rebuilt).toBe(actual); expect(readReviewedRouteTailHistoricalFile(resolve(root, row.file), 'utf8')).toBe(before);
    }
    expect(p.preserved_dated_fixtures).toHaveLength(15);
    for (const row of p.preserved_dated_fixtures) expect([sha(read(row.file)), Buffer.byteLength(read(row.file))]).toEqual([row.sha256, row.bytes]);
  });

  it('directly verifies actual153-page manifest, both real registries/resolvers and exact8 additive pages/styles/aliases', () => {
    const actual = JSON.parse(read(navFiles[0]!)), before = JSON.parse(reverseReviewedRouteTailSource(navFiles[0]!, read(navFiles[0]!)));
    expect(actual.pages).toHaveLength(153); expect(before.pages).toHaveLength(145);
    expect([...clientRoutes]).toEqual([...serverRoutes]); expect(clientRules).toEqual(serverRules);
    expect([...clientRoutes].sort()).toEqual(actual.pages.map((row: { path: string }) => '/' + row.path).sort());
    expect(actual.pages.filter((row: { path: string }) => !Object.hasOwn(pages, '/' + row.path))).toEqual(before.pages);
    for (const [route, style] of Object.entries(pages)) {
      expect(actual.pages.filter((row: { path: string }) => '/' + row.path === route)).toEqual([{ path: route.slice(1), style }]);
      expect(existsSync(resolve(root, 'view/uniapp-ts/src' + route + '.vue')), route).toBe(true);
      for (const resolver of [clientResolve, serverResolve]) expect(resolver(route)).toBe(route);
    }
    for (const [alias, route] of Object.entries(aliases)) {
      expect(clientRules[alias]).toEqual({ target: route, coverage: 'candidate_covered' });
      for (const resolver of [clientResolve, serverResolve]) {
        expect(resolver(alias)).toBe(route); expect(resolver(alias, 'from=menu')).toBe(route + '?from=menu');
      }
    }
    expect(peelReviewedRouteTailRegisteredRoutesIfPresent(clientRoutes).size).toBe(145);
    const oldRules = peelReviewedRouteTailLegacyRulesIfPresent(clientRules);
    for (const file of navFiles) {
      const actual = read(file), historical = reverseReviewedRouteTailSource(file, actual);
      const proof = p.route_stages[0]!.sources.find(row => row.file === file)!;
      expect([sha(historical), Buffer.byteLength(historical), blob(historical)]).toEqual([proof.before_sha256, proof.before_bytes, proof.before_git_blob_sha1]);
      expect(readReviewedRouteTailHistoricalFile(resolve(root, file), 'utf8')).toBe(historical);
      expect(readReviewedRouteTailHistoricalFile(resolve(root, file))).toEqual(Buffer.from(historical));
      expect(() => readReviewedRouteTailHistoricalFile(resolve(root, file), 'ascii')).toThrow();
    }
    expect(sha(JSON.stringify(oldRules))).toBe(p.route_stages[0]!.before_rules_sha256);
  });

  it('recomputes the complete real report, peels the exact message-source tail and bridges to the711-call dated report', () => {
    const actual = currentReport(), previous = reverseReviewedRouteTailReport(actual), final = p.report_stages.at(-1)!;
    expect([sha(pretty(actual)), Buffer.byteLength(pretty(actual))]).toEqual([final.after_sha256, final.after_bytes]);
    expect(actual.counts).toEqual({ callSites: 711, pathVariants: 749, registered: 749, executable: 749, controlledUnavailable: 0, unregistered: 0, unresolved: 0 });
    expect(actual.frontendSources).toHaveLength(108); expect(actual.backend.registeredRoutes).toHaveLength(1681);
    expect(sha(pretty(previous))).toBe('1ac108158879d83daae4f0d5a70e137db210e23a33040f10a577dada2419bff0');
    expect(applyReviewedRouteTailReport(previous)).toEqual(actual); expect(peelReviewedRouteTailReportForHistoricalAudit(previous)).toEqual(previous);
    for (const source of [{ file: actual.backend.file, sha256: actual.backend.sha256 }, ...actual.backend.rootRouteSources, ...actual.frontendSources])
      expect(sha(peelMessageCenterSourceIfPresent(source.file,read(source.file)).replace(/\r\n?/gu, '\n')), source.file).toBe(source.sha256);
    for (const source of p.current_extra_sources) expect([sha(read(source.file)), Buffer.byteLength(read(source.file))]).toEqual([source.sha256, source.bytes]);
    expect(actual.backend.registeredRoutes.filter(row => row.path.includes('/extract/directory')).map(row => [row.method, row.path, row.handler, row.availability]))
      .toEqual([['GET', '/extract/directory', 'AdminWithdrawalDirectory.directory', 'executable'], ['GET', '/extract/directory/:id/media', 'AdminWithdrawalDirectory.media', 'executable'],
        ['GET', '/api/admin/extract/directory', 'AdminWithdrawalDirectory.directory', 'executable'], ['GET', '/api/admin/extract/directory/:id/media', 'AdminWithdrawalDirectory.media', 'executable']]);
  });

  it('independently proves the2 native-fetch GET entries, all4 literal Admin route guards and closed extract.view permission namespace', () => {
    const source = read('view/admin-ts/src/api/extractDirectory.ts'), tree = ts.createSourceFile('extractDirectory.ts', source, ts.ScriptTarget.Latest, true);
    const functions = new Map<string, ts.FunctionDeclaration>();
    for (const node of tree.statements) if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    const calls = (node: ts.Node, name: string) => { const result: ts.CallExpression[] = [];
      function visit(n: ts.Node) { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) result.push(n); ts.forEachChild(n, visit); }
      visit(node); return result; };
    const fetches = calls(tree, 'fetch'); expect(fetches).toHaveLength(1); expect(fetches[0]!.arguments[0]!.getText(tree)).toBe('path');
    const options = fetches[0]!.arguments[1]!; if (!ts.isObjectLiteralExpression(options)) throw Error('Expected actual literal GET options');
    const method = options.properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(tree) === 'method');
    expect(method && ts.isPropertyAssignment(method) && ts.isStringLiteral(method.initializer) && method.initializer.text).toBe('GET');
    for (const [name, fragments] of [['apiAdminExtractDirectory', ['/adminapi/extract/directory?']], ['apiAdminExtractDirectoryMedia', ['/adminapi/extract/directory/', '/media?revision=']]] as const) {
      const found = calls(functions.get(name)!, 'readOwnedExtractJson'); expect(found).toHaveLength(1);
      const strings: string[] = []; function visit(n: ts.Node) { if (ts.isStringLiteral(n)) strings.push(n.text); ts.forEachChild(n, visit); }
      visit(found[0]!.arguments[0]!); expect(strings).toEqual(fragments);
    }
    // This producer intentionally excludes native fetch from its declared
    // request.get/post/... scope. The explicit proof above covers that boundary.
    expect(currentReport().frontendSources.some(row => row.file === 'view/admin-ts/src/api/extractDirectory.ts')).toBe(false);
    for (const file of ['workers-ts/src/routes/adminapi.ts', 'workers-ts/src/routes/v1/index.ts']) {
      const text = read(file), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), routes: string[][] = [];
      function visit(n: ts.Node) { if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'get'
        && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text.includes('/extract/directory'))
        routes.push(n.arguments.map(value => value.getText(ast))); ts.forEachChild(n, visit); }
      visit(ast); expect(routes).toHaveLength(2);
      for (const row of routes) expect(row.slice(1)).toEqual(['adminAuth', row[0]!.includes('/media') ? 'AdminWithdrawalDirectory.media' : 'AdminWithdrawalDirectory.directory']);
      const guards: string[] = [];
      function guard(n: ts.Node) { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'adminAuth' && n.initializer)
        guards.push(n.initializer.getText(ast)); ts.forEachChild(n, guard); }
      guard(ast); expect(guards).toEqual(['adminRuntimeAuthMiddleware()']);
    }
    const runtime = ts.createSourceFile('admin-runtime-auth.ts', read('workers-ts/src/middleware/admin-runtime-auth.ts'), ts.ScriptTarget.Latest, true);
    expect(calls(runtime, 'adminAuthMiddleware')).toHaveLength(1); expect(calls(runtime, 'authenticate')).toHaveLength(1);
    const authenticate = calls(runtime, 'authenticate')[0]!;
    expect(authenticate.arguments[0]!.getText(runtime)).toBe('c');
    expect(calls(authenticate.arguments[1]!, 'createAdminDatabaseSession')).toHaveLength(1);
    const auth = ts.createSourceFile('admin-auth.ts', read('workers-ts/src/middleware/admin-auth.ts'), ts.ScriptTarget.Latest, true), checks: ts.CallExpression[] = [];
    function permission(n: ts.Node) { if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && n.expression.name.text === 'assertAuthorized') checks.push(n); ts.forEachChild(n, permission); }
    permission(auth); expect(checks).toHaveLength(1);
    expect(checks[0]!.expression.getText(auth)).toBe('new AdminPermissionService(container).assertAuthorized');
    expect(checks[0]!.arguments.map(value => value.getText(auth))).toEqual(['adminInfo', 'c.req.method', 'c.req.routePath']);
    const service = ts.createSourceFile('AdminWithdrawalDirectoryService.ts', read('workers-ts/src/services/admin/AdminWithdrawalDirectoryService.ts'), ts.ScriptTarget.Latest, true);
    const paths: string[] = []; function shared(n: ts.Node) { if (ts.isMethodDeclaration(n) && ['list', 'media'].includes(n.name.getText(service))) {
      const name = n.name.getText(service);
      function visit(node: ts.Node) { if (ts.isCallExpression(node) && node.expression.getText(service) === 'this.read') paths.push(name); ts.forEachChild(node, visit); }
      visit(n);
    } ts.forEachChild(n, shared); } shared(service); expect(paths.sort()).toEqual(['list', 'media']);
    expect(calls(service, 'authorize')).toHaveLength(1);
    for (const prefix of ['/adminapi', '/api/admin']) for (const verb of ['GET', 'HEAD']) {
      for (const suffix of ['', '/1/media', '/2147483647/media']) expect(requiredAdminPermission(verb, prefix + '/extract/directory' + suffix)).toBe('extract.view');
      for (const suffix of ['/0/media', '/2147483648/media', '/1/unknown', '/unknown']) expect(requiredAdminPermission(verb, prefix + '/extract/directory' + suffix)).toBeNull();
    }
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(requiredAdminPermission(verb, '/adminapi/extract/directory/1/media')).toBeNull();
  });

  it.each(navFiles.flatMap(file => ['append', 'crlf', 'neighbor'].map(kind => ({ file, kind }))))('still rejects unknown complete source $file $kind', ({ file, kind }) => {
    const source = read(file), bad = kind === 'append' ? source + '// unknown\n' : kind === 'crlf' ? source.replaceAll('\n', '\r\n') : ' ' + source;
    expect(() => reverseReviewedRouteTailSource(file, bad)).toThrow(); expect(peelReviewedRouteTailSourceIfPresent(file, bad)).toBe(bad);
    expect(() => reverseMemberLevelActivationSource(file, bad)).toThrow();
  });
  it.each(['extra', 'missing', 'neighbor', 'target', 'coverage'])('still rejects unknown actual registry %s', kind => {
    const routes = new Set(clientRoutes), rules = structuredClone(clientRules) as Record<string, { target: string; coverage: string }>;
    if (kind === 'extra') { routes.add('/pages/unknown/index'); rules['/pages/unknown/index'] = { target: '/pages/user/agentExplanation', coverage: 'candidate_covered' }; }
    if (kind === 'missing') { routes.delete('/pages/user/promoterPeople'); delete rules['/pages/users/promoter-list/index']; }
    if (kind === 'neighbor') rules['/pages/annex/vip_paid/index']!.target = '/pages/user/agentExplanation';
    if (kind === 'target') rules['/pages/users/user_cash/index']!.target = '/pages/user/finance';
    if (kind === 'coverage') rules['/pages/users/user_distribution_info/index']!.coverage = 'partial_replacement';
    expect(() => reverseMemberLevelActivationLegacyRules(rules)).toThrow();
    if (['extra', 'missing'].includes(kind)) expect(() => reverseMemberLevelActivationRegisteredRoutes(routes)).toThrow();
  });
  it.each(['count', 'route', 'source', 'line', 'methodology', 'extra'])('still rejects unknown complete report %s', kind => {
    const actual = currentReport();
    if (kind === 'count') actual.counts.registered++;
    if (kind === 'route') actual.backend.registeredRoutes[0]!.handler = 'unreviewed';
    if (kind === 'source') actual.backend.rootRouteSources[0]!.sha256 = '0'.repeat(64);
    if (kind === 'line') actual.backend.registeredRoutes[0]!.line++;
    if (kind === 'methodology') actual.methodology.scope = 'unreviewed';
    if (kind === 'extra') Object.assign(actual, { unreviewed: true });
    expect(() => reverseReviewedRouteTailReport(actual)).toThrow(); expect(peelReviewedRouteTailReportForHistoricalAudit(actual)).toEqual(actual);
  });
});
