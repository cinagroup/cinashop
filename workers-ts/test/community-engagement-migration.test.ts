import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { resolveRegisteredPageRoute } from '../../view/uniapp-ts/src/config/navigation';
import { resolveRegisteredPageRoute as resolveServerRoute } from '../src/services/content/FabRouteRegistry';
const { parse, compileTemplate } = createRequire(import.meta.url)('../../view/admin-ts/node_modules/@vue/compiler-sfc') as typeof import('../../view/admin-ts/node_modules/@vue/compiler-sfc');
const read = (name: string) => readFileSync('../view/uniapp-ts/src/' + name, 'utf8');
function source(name: string, override?: string) {
  const parsed = parse(override ?? read(name), { filename: name }); expect(parsed.errors).toEqual([]);
  expect(compileTemplate({ source: parsed.descriptor.template!.content, filename: name, id: 'post-engagement' }).errors).toEqual([]);
  const script = ts.createSourceFile(name + '.ts', parsed.descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
  const nodes: any[] = []; const walk = (node: any) => { nodes.push(node); for (const child of node.children ?? []) walk(child); }; walk(parsed.descriptor.template!.ast);
  return { script, nodes };
}
function actions(name: string, override?: string) {
  const { script, nodes } = source(name, override);
  const imported = script.statements.some(row => ts.isImportDeclaration(row) && ts.isStringLiteral(row.moduleSpecifier)
    && row.moduleSpecifier.text === '@/components/community/CommunityPostActions.vue'
    && row.importClause?.isTypeOnly === false && row.importClause.name?.text === 'CommunityPostActions');
  return imported ? nodes.filter(node => node.tag === 'CommunityPostActions'
    && ['post', 'busy', 'unknown', 'refreshing'].every(key => node.props.some((prop: any) => prop.type === 7 && prop.name === 'bind' && prop.arg?.content === key))
    && ['like', 'share', 'refresh'].every(key => node.props.some((prop: any) => prop.type === 7 && prop.name === 'on' && prop.arg?.content === key && prop.exp?.content.startsWith('engagement.')))).length : 0;
}
function calls(script: ts.SourceFile, fn: string) {
  const result: string[] = [];
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) result.push(node.expression.text); ts.forEachChild(node, visit); };
  for (const statement of script.statements) if (ts.isFunctionDeclaration(statement) && statement.name?.text === fn) visit(statement);
  return result;
}
describe('complete shared post engagement and deliberate visits', () => {
  it('binds actual shared actions on main/workspace cards and detail plus topic/search/video surfaces', () => {
    for (const name of ['pages/discover/index.vue', 'components/community/CommunityDeepLinkFeed.vue']) {
      expect(actions(name)).toBe(3);
      const original = read(name);
      expect(actions(name, original.replace('import CommunityPostActions', 'import type CommunityPostActions'))).toBe(0);
      expect(actions(name, original.replace(/<CommunityPostActions[^>]+\/>/g, '<!-- disconnected actions -->'))).toBe(0);
      expect(original).not.toMatch(/liked\.value = false|apiCommunityLike\(detail\.value/);
    }
    const component = source('components/community/CommunityPostActions.vue');
    expect(component.nodes.some(node => node.tag === 'view' && node.props.some((prop: any) => prop.name === 'on' && prop.arg?.content === 'tap'
      && prop.modifiers.some((modifier: any) => (modifier.content ?? modifier) === 'stop')))).toBe(true);
  });
  it('binds the native small-program share callbacks at actual registered page roots and fixed button IDs', () => {
    const main = source('pages/discover/index.vue').script.getText();
    expect(main).toContain('onShareAppMessage(engagement.miniMessage)'); expect(main).toContain('onShareTimeline(engagement.miniTimeline)');
    for (const name of ['discoverTopic/index', 'discoverSearch/index', 'discoverVideo/index', 'discoverVideo/app']) {
      const script = source('pages/discover/' + name + '.vue').script.getText();
      expect(script).toContain('onShareAppMessage(event => feed.value?.shareMessage(event)');
      expect(script).toContain('onShareTimeline(() => feed.value?.shareTimeline()');
      expect(script).toContain('communityInbound('); expect(script).toContain('communityPageQuery(');
    }
    const panel = source('components/community/CommunitySharePanel.vue');
    expect(panel.nodes.some(node => node.tag === 'button' && node.props.some((prop: any) => prop.type === 6 && prop.name === 'open-type' && prop.value?.content === 'share')
      && node.props.some((prop: any) => prop.type === 7 && prop.arg?.content === 'data-post-id' && prop.exp?.content === 'controller.sharePost.value.id'))).toBe(true);
    expect(panel.script.getText()).toContain('shareReady.value');
  });
  it('separates a deliberate detail visit from media reload and state reconciliation', () => {
    const main = source('pages/discover/index.vue').script;
    expect(calls(main, 'openDetail').filter(name => name === 'apiCommunityVisit')).toHaveLength(1);
    expect(calls(main, 'reloadVideo')).toContain('apiCommunityState'); expect(calls(main, 'reloadVideo')).not.toContain('apiCommunityVisit');
    expect(calls(main, 'publish')).not.toContain('apiCommunityDetail');
    const deep = source('components/community/CommunityDeepLinkFeed.vue').script;
    expect(calls(deep, 'openPost')).toContain('apiCommunityVisit'); expect(calls(deep, 'openVideoComments')).not.toContain('apiCommunityVisit');
    const state = read('composables/useCommunityEngagement.ts'); expect(state).not.toContain('apiCommunityVisit'); expect(state).not.toContain('apiCommunityBrowse');
  });
  it('registers an actual legacy detail bridge that validates identity before local navigation', () => {
    const pages = JSON.parse(read('pages.json')).pages.map((row: { path: string }) => row.path);
    expect(pages).toContain('pages/discover/discoverDetails/index'); expect(pages).toContain('pages/discover/workspace');
    const bridge = source('pages/discover/discoverDetails/index.vue').script.getText();
    expect(bridge).toContain('communityPageQuery('); expect(bridge).toContain('communityInbound('); expect(bridge).toContain('communitySharePath(');
    expect(bridge).toContain('uni.redirectTo({ url: target.value'); expect(bridge).not.toContain('apiCommunityVisit'); expect(bridge).not.toContain('web-view');
    for (const resolve of [resolveRegisteredPageRoute, resolveServerRoute]) {
      expect(resolve('/pages/discover/discoverDetails/index', 'id=31&spid=0')).toBe('/pages/discover/workspace?id=31');
      expect(resolve('/pages/discover/discoverDetails/index', 'id=31&spid=11')).toBe('/pages/discover/workspace?id=31&spid=11');
      expect(resolve('/pages/discover/discoverDetails/index', 'id=31&id=32')).toBe('');
    }
  });
});
