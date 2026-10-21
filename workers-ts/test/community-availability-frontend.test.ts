import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { communityClosedResponse, communityCertainRejection } from '../../view/common/communityAvailability';
const { parse, compileTemplate } = createRequire(import.meta.url)('../../view/uniapp-ts/node_modules/@vue/compiler-sfc') as typeof import('../../view/uniapp-ts/node_modules/@vue/compiler-sfc');
const root = resolve(import.meta.dirname, '../../view/uniapp-ts/src');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
function nodes<T extends ts.Node>(node: ts.Node, predicate: (value: ts.Node) => value is T): T[] {
  const result: T[] = []; const visit = (next: ts.Node) => { if (predicate(next)) result.push(next); ts.forEachChild(next, visit); };
  visit(node); return result;
}
function valueImport(file: ts.SourceFile, module: string, name: string) {
  return file.statements.some(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === module
    && node.importClause && !node.importClause.isTypeOnly && (node.importClause.name?.text === name || node.importClause.namedBindings
      && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.some(binding => !binding.isTypeOnly && binding.name.text === name)));
}
function checkedRoot(file: string, override?: string) {
  const { descriptor, errors } = parse(override ?? read(file), { filename: file });
  if (errors.length || !descriptor.scriptSetup || !descriptor.template) return false;
  const tree = ts.createSourceFile(file, descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true);
  const compiled = compileTemplate({ source: descriptor.template.content, filename: file, id: 'community-availability' });
  if (compiled.errors.length) return false;
  const elements: Array<{ tag: string; props: Array<{ type: number; name: string; arg?: { content: string }; exp?: { content: string } }> }> = [];
  const visit = (node: any) => { if (node.type === 1) elements.push(node); for (const child of node.children ?? []) visit(child); };
  visit(descriptor.template.ast);
  const component = elements.filter(node => node.tag === 'CommunityAvailability');
  return valueImport(tree, '@/components/community/CommunityAvailability.vue', 'CommunityAvailability')
    && valueImport(tree, '@/utils/communityAvailability', 'useCommunityAvailability') && component.length === 1
    && ['closed', 'checking', 'message'].every(name => component[0].props.some(prop => prop.type === 7 && prop.name === 'bind'
      && prop.arg?.content === name && prop.exp?.content === `availability.${name}.value`))
    && component[0].props.some(prop => prop.type === 7 && prop.name === 'on' && prop.arg?.content === 'retry' && prop.exp?.content === 'recoverCommunity')
    && nodes(tree, ts.isFunctionDeclaration).some(fn => fn.name?.text === 'recoverCommunity'
      && nodes(fn, ts.isCallExpression).some(call => call.expression.getText(tree) === 'availability.refresh'));
}
function disconnectRecovery(file: string, source: string): string {
  const block = parse(source, { filename: file }).descriptor.scriptSetup;
  if (!block) throw Error('Missing actual recovery script');
  const tree = ts.createSourceFile(file, block.content, ts.ScriptTarget.Latest, true);
  const recovery = nodes(tree, ts.isFunctionDeclaration).find(fn => fn.name?.text === 'recoverCommunity');
  if (!recovery) throw Error('Missing actual recovery handler');
  const calls = nodes(recovery, ts.isCallExpression).filter(call => call.expression.getText(tree) === 'availability.refresh');
  expect(calls).toHaveLength(1);
  const expression = calls[0].expression;
  const start = block.loc.start.offset + expression.getStart(tree), end = block.loc.start.offset + expression.end;
  expect(source.slice(start, end)).toBe('availability.refresh');
  return source.slice(0, start) + 'Promise.resolve' + source.slice(end);
}

describe('community availability frontend boundary', () => {
  it('classifies only the precise closure business code and refuses every server-failure certainty', () => {
    for (const httpStatus of [undefined, 200, 400, 499]) {
      expect(communityClosedResponse({ status: 410010, httpStatus })).toBe(true);
      expect(communityCertainRejection({ status: 410010, httpStatus })).toBe(true);
    }
    for (const httpStatus of [500, 502, 503]) {
      expect(communityClosedResponse({ status: 410010, httpStatus })).toBe(false);
      expect(communityCertainRejection({ status: 410010, httpStatus })).toBe(false);
      expect(communityCertainRejection({ status: 400, httpStatus })).toBe(false);
    }
    for (const status of [undefined, 200, 410000, 410001, 410002, 503]) expect(communityClosedResponse({ status })).toBe(false);
  });

  it.each(['pages/discover/index.vue', 'pages/discover/people.vue', 'components/community/CommunityDeepLinkFeed.vue'])(
    'binds the actual %s banner, reactive state and explicit recovery handler', file => {
      expect(checkedRoot(file)).toBe(true);
      const source = read(file);
      expect(checkedRoot(file, source.replace('@retry="recoverCommunity"', '@retry="load"'))).toBe(false);
      expect(checkedRoot(file, source.replace('import CommunityAvailability from', 'import type CommunityAvailability from'))).toBe(false);
      expect(checkedRoot(file, disconnectRecovery(file, source))).toBe(false);
    });

  it('routes the actual community API through the guarded facade while retaining config and state endpoints', () => {
    const tree = ts.createSourceFile('community.ts', read('api/community.ts'), ts.ScriptTarget.Latest, true);
    expect(valueImport(tree, '@/utils/communityAvailability', 'http')).toBe(true);
    expect(tree.statements.some(row => ts.isImportDeclaration(row) && ts.isStringLiteral(row.moduleSpecifier)
      && row.moduleSpecifier.text === '@/utils/request')).toBe(false);
    expect(nodes(tree, ts.isCallExpression).filter(call => call.expression.getText(tree) === 'http.get')
      .some(call => ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === '/community/config')).toBe(true);
    expect(read('utils/communityAvailability.ts')).toContain("method !== 'GET' || /^\\/community\\/(?:detail|share)\\//.test(url)");
  });

  it('binds every existing community model to a real synchronous close subscription', () => {
    for (const name of ['HomeFeed', 'Author', 'People', 'DeepLink', 'Publish', 'Relations', 'Comments', 'Engagement']) {
      const file = read(`composables/useCommunity${name}.ts`);
      const tree = ts.createSourceFile(name + '.ts', file, ts.ScriptTarget.Latest, true);
      expect(valueImport(tree, '@/utils/communityAvailability', 'useCommunityAvailability'), name).toBe(true);
      expect(nodes(tree, ts.isCallExpression).some(call => call.expression.getText(tree) === 'watch'
        && call.arguments[0]?.getText(tree) === 'availability.closed' && call.arguments[1] && ts.isArrowFunction(call.arguments[1])
        && call.arguments[2]?.getText(tree).includes("flush: 'sync'")), name).toBe(true);
    }
  });

  it('keeps raw redirects local and leaves the shopper login-code contract unchanged', () => {
    const legacy = read('composables/useCommunityLegacyEntry.ts');
    expect(legacy).not.toContain('communityAvailability'); expect(legacy).not.toContain('apiCommunity');
    expect(read('utils/request.ts')).toContain('[410000, 410001, 410002].includes(body.status)');
    expect(read('utils/request.ts')).not.toContain('410010');
  });
});
