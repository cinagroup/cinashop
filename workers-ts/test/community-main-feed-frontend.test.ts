import { reversePointsCentreManifest } from './helpers/customerPointsCentreManifest';
import { reverseSignCentreManifest } from './helpers/customerSignCentreManifest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseCommunityWorkspaceEntry } from '../../view/common/communityRoute';
import { REGISTERED_PAGE_ROUTES, resolveRegisteredPageRoute } from '../../view/uniapp-ts/src/config/navigation';
import { REGISTERED_PAGE_ROUTES as serverPages, resolveRegisteredPageRoute as serverResolve } from '../src/services/content/FabRouteRegistry';
const { parse, compileTemplate } = createRequire(import.meta.url)('../../view/uniapp-ts/node_modules/@vue/compiler-sfc') as typeof import('../../view/uniapp-ts/node_modules/@vue/compiler-sfc');
const root = resolve(import.meta.dirname, '../../view/uniapp-ts/src');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const mainFile = 'pages/discover/index.vue', viewerFile = 'components/community/CommunityFeaturedViewer.vue';
function all<T extends ts.Node>(node: ts.Node, guard: (node: ts.Node) => node is T): T[] {
  const result: T[] = []; const visit = (next: ts.Node) => { if (guard(next)) result.push(next); ts.forEachChild(next, visit); }; visit(node); return result;
}
const tree = (source: string) => ts.createSourceFile('actual.ts', source, ts.ScriptTarget.Latest, true);
function imported(script: ts.SourceFile, module: string, name: string) {
  return script.statements.some(row => ts.isImportDeclaration(row) && ts.isStringLiteral(row.moduleSpecifier) && row.moduleSpecifier.text === module
    && row.importClause && !row.importClause.isTypeOnly && (row.importClause.name?.text === name || row.importClause.namedBindings
      && ts.isNamedImports(row.importClause.namedBindings) && row.importClause.namedBindings.elements.some(value => !value.isTypeOnly && value.name.text === name)));
}
function sfc(file: string, source = read(file)) {
  const parsed = parse(source, { filename: file });
  if (parsed.errors.length || !parsed.descriptor.scriptSetup || !parsed.descriptor.template) throw Error('Invalid actual SFC');
  const compiled = compileTemplate({ source: parsed.descriptor.template.content, filename: file, id: 'main-feed-binding' });
  if (compiled.errors.length) throw Error('Invalid actual template');
  const elements: any[] = []; const visit = (node: any) => { if (node.type === 1) elements.push(node); for (const child of node.children ?? []) visit(child); };
  visit(parsed.descriptor.template.ast);
  return { script: tree(parsed.descriptor.scriptSetup.content), elements };
}
const calls = (scope: ts.Node, script: ts.SourceFile) => all(scope, ts.isCallExpression).map(call => call.expression.getText(script));
function fn(script: ts.SourceFile, name: string) { return all(script, ts.isFunctionDeclaration).find(value => value.name?.text === name); }
function handler(elements: any[], expression: string) {
  return elements.some(element => element.props.some((prop: any) => prop.type === 7 && prop.name === 'on' && prop.arg?.content === 'tap' && prop.exp?.content === expression));
}
function hasMainBindings(source = read(mainFile)) {
  const { script, elements } = sfc(mainFile, source);
  const change = fn(script, 'changeFeedTab'), refresh = fn(script, 'refreshFeed');
  const home = all(script, ts.isVariableDeclaration).find(node => ts.isIdentifier(node.name) && node.name.text === 'home');
  return imported(script, '@/composables/useCommunityHomeFeed', 'useCommunityHomeFeed')
    && home?.initializer && ts.isCallExpression(home.initializer) && home.initializer.expression.getText(script) === 'useCommunityHomeFeed'
    && handler(elements, 'changeFeedTab(item.key)') && handler(elements, 'home.selectTopic(topic.id)') && handler(elements, 'home.selectTopic(null)')
    && handler(elements, 'home.loadMore') && handler(elements, 'refreshFeed')
    && Boolean(change && calls(change, script).includes('home.changeTab')) && Boolean(refresh && calls(refresh, script).includes('home.refresh'))
    && imported(script, '@dcloudio/uni-app', 'onReachBottom') && imported(script, '@dcloudio/uni-app', 'onPullDownRefresh')
    && all(script, ts.isCallExpression).some(call => call.expression.getText(script) === 'onReachBottom' && calls(call, script).includes('home.loadMore'))
    && all(script, ts.isCallExpression).some(call => call.expression.getText(script) === 'onPullDownRefresh'
      && calls(call, script).includes('refreshFeed') && calls(call, script).includes('uni.stopPullDownRefresh'));
}
function hasAtomicPaging(source = read('composables/useCommunityHomeFeed.ts')) {
  const script = tree(source), load = fn(script, 'loadMore'); if (!load) return false;
  const callNodes = all(load, ts.isCallExpression);
  const list = callNodes.find(call => call.expression.getText(script) === 'apiCommunityList');
  const validation = callNodes.find(call => call.expression.getText(script) === 'checkedCommunityPost');
  const adopt = callNodes.find(call => call.expression.getText(script) === 'engagement.adopt');
  const enclosingBlock = (node: ts.Node): ts.Block | undefined => {
    let parent = node.parent;
    while (parent && !ts.isBlock(parent)) parent = parent.parent;
    return parent && ts.isBlock(parent) ? parent : undefined;
  };
  // Bind the successful receipt block, excluding the guest's earlier terminal return.
  const receiptBlock = adopt ? enclosingBlock(adopt) : undefined;
  const pageWrites = all(load, ts.isBinaryExpression).filter(row => row.left.getText(script) === 'page.value' && row.operatorToken.kind === ts.SyntaxKind.EqualsToken);
  const pageWrite = pageWrites.length === 1 ? pageWrites[0] : undefined;
  const terminations = all(load, ts.isBinaryExpression).filter(row => row.left.getText(script) === 'finished.value'
    && row.operatorToken.kind === ts.SyntaxKind.EqualsToken && enclosingBlock(row) === receiptBlock
    && pageWrite && row.getStart(script) > pageWrite.getStart(script));
  const termination = terminations.length === 1 ? terminations[0] : undefined;
  const scope = list?.arguments[2]?.getText(script) ?? '';
  return Boolean(list && validation && adopt && pageWrite && termination && imported(script, '@/api/community', 'checkedCommunityPost')
    && list.arguments[0]?.getText(script) === 'next' && list.arguments[1]?.getText(script) === 'PAGE_SIZE'
    && scope.includes("requestedTab === 'following' ? 1 : 0") && scope.includes("requestedTab === 'discover'")
    && validation.getStart(script) < adopt.getStart(script) && adopt.getStart(script) < pageWrite.getStart(script)
    && termination.right.getText(script).includes('rows.length < PAGE_SIZE') && termination.right.getText(script).includes('next >= LAST_PAGE')
    && calls(load, script).includes('current') && source.includes('const PAGE_SIZE = 10, LAST_PAGE = 1001'));
}
function featuredBinding(source = read(viewerFile)) {
  const { script, elements } = sfc(viewerFile, source), swipe = fn(script, 'swipe');
  const actualSwipe = swipe && all(swipe, ts.isIfStatement).some(conditional => conditional.expression.getText(script).includes("event.detail.source === 'touch'")
    && conditional.expression.getText(script).includes('!props.viewer.detached.value') && calls(conditional.thenStatement, script).includes('props.viewer.activate'));
  return Boolean(actualSwipe && imported(script, './CommunityPostActions.vue', 'CommunityPostActions') && imported(script, './CommunityComments.vue', 'CommunityComments')
    && elements.some(node => node.tag === 'swiper' && node.props.some((prop: any) => prop.name === 'on' && prop.arg?.content === 'change' && prop.exp?.content === 'swipe'))
    && elements.some(node => node.tag === 'CommunityPostActions') && elements.some(node => node.tag === 'CommunityComments')
    && handler(elements, 'viewer.step(1)') && handler(elements, 'viewer.refreshState'));
}
function pureLegacy(source = read('pages/discoverIndex/index.vue')) {
  const { script } = sfc('pages/discoverIndex/index.vue', source);
  const imports = script.statements.filter(ts.isImportDeclaration).map(row => ts.isStringLiteral(row.moduleSpecifier) ? row.moduleSpecifier.text : '');
  const callback = all(script, ts.isCallExpression).find(row => row.expression.getText(script) === 'onLoad')?.arguments[0];
  const open = fn(script, 'open'); if (!callback || !open) return false;
  const path = all(callback, ts.isBinaryExpression).find(row => row.left.getText(script) === 'target.value' && ts.isStringLiteral(row.right));
  return imported(script, '@/utils/communityShare', 'communityPageQuery') && imported(script, '@dcloudio/uni-app', 'onLoad')
    && imported(script, '@dcloudio/uni-app', 'onUnload') && imports.every(value => !/api\/|Availability|Engagement/.test(value))
    && calls(callback, script).includes('communityPageQuery') && calls(callback, script).includes('open')
    && path?.right.getText(script) === "'/pages/discover/index'" && calls(open, script).includes('uni.switchTab')
    && !calls(script, script).some(value => /^apiCommunity|^http\./.test(value));
}

describe('complete community main feed frontend wiring', () => {
  it('connects all three real tab/topic/pagination/refresh controls to value-imported implementations', () => {
    expect(hasMainBindings()).toBe(true);
    const source = read(mainFile);
    for (const mutant of [source.replace('@tap="changeFeedTab(item.key)"', '@tap="unrelated(item.key)"'),
      source.replace('import { useCommunityHomeFeed,', 'import { type useCommunityHomeFeed,'),
      source.replace('home.changeTab(tab)', 'unrelated.changeTab(tab)'), source.replace('home.refresh()', 'unrelated.refresh()'),
      source.replace('void home.loadMore(); });', 'void unrelated.loadMore(); });')]) expect(hasMainBindings(mutant)).toBe(false);
  });
  it('validates every raw row before any adoption or page advance and terminates by raw size at the exact client cap', () => {
    expect(hasAtomicPaging()).toBe(true); const source = read('composables/useCommunityHomeFeed.ts');
    expect(hasAtomicPaging(source.replace("requestedTab === 'following' ? 1 : 0", '0'))).toBe(false);
    expect(hasAtomicPaging(source.replace('rows.length < PAGE_SIZE', 'posts.value.length < PAGE_SIZE'))).toBe(false);
    expect(hasAtomicPaging(source.replace('rows.forEach(row => checkedCommunityPost(row, row.id));', 'page.value = next; rows.forEach(row => checkedCommunityPost(row, row.id));'))).toBe(false);
    expect(hasAtomicPaging(source.replace('type CommunityPost,', 'type CommunityPost,' ).replace('checkedCommunityPost, communityPreviewMode', 'type checkedCommunityPost, communityPreviewMode'))).toBe(false);
  });
  it('preserves default discovery and all modes while guests cannot call protected following helpers', () => {
    const script = tree(read('composables/useCommunityHomeFeed.ts'));
    const loadFollowing = fn(script, 'loadFollowing')!, loadMore = fn(script, 'loadMore')!;
    expect(script.getText()).toContain("ref<CommunityFeedTab>('discover')");
    expect(script.getText()).toContain("{ key: 'following', label: '关注' }"); expect(script.getText()).toContain("{ key: 'featured', label: '精选' }");
    expect(all(loadFollowing, ts.isIfStatement)[0].expression.getText(script)).toContain('!loggedIn.value');
    expect(all(loadMore, ts.isIfStatement).some(row => row.expression.getText(script).includes("tab.value === 'following' && !loggedIn.value")
      && row.thenStatement.getText(script).includes('return'))).toBe(true);
    expect(calls(loadFollowing, script)).toEqual(expect.arrayContaining(['apiCommunityFollowHighlights', 'apiCommunityRecommendations']));
    expect(read(mainFile)).toContain('已达1001页浏览范围');
  });
  it('renders bounded recommendation previews but opens their real complete detail/video route', () => {
    const { script, elements } = sfc(mainFile), preview = fn(script, 'openRecommendation')!;
    expect(handler(elements, 'home.follow(person)')).toBe(true); expect(handler(elements, 'openRecommendation(preview)')).toBe(true);
    expect(calls(preview, script)).toEqual(expect.arrayContaining(['uni.navigateTo', 'communitySharePath', 'openDetail']));
    expect(calls(preview, script)).not.toContain('engagement.adopt');
    const social = tree(read('composables/useCommunityHomeFeed.ts')), metadata = fn(social, 'loadFollowing')!;
    expect(metadata.getText(social)).toContain('row.community.length > 3'); expect(metadata.getText(social)).toContain('post.relation_id !== row.relation_id');
    const follow = fn(social, 'follow')!, reconcile = fn(social, 'reconcileFollow')!;
    expect(calls(follow, social)).toContain('apiCommunitySetInterest'); expect(calls(reconcile, social)).toContain('apiCommunityProfile');
    for (const operation of [follow, reconcile]) expect(operation.getText(social)).toContain('current(refreshed, actor)');
    expect(read('composables/useCommunityHomeFeed.ts')).toContain('new WeakMap<object');
  });
  it('binds the actual mixed viewer to real touch activations and shared comments, like and sharing', () => {
    expect(featuredBinding()).toBe(true); const source = read(viewerFile);
    for (const mutant of [source.replace("event.detail.source === 'touch'", 'true'),
      source.replace('import CommunityPostActions', 'import type CommunityPostActions'),
      source.replace('@change="swipe"', '@change="unrelated"'), source.replace('props.viewer.activate(event.detail.current)', 'unrelated(event.detail.current)')]) expect(featuredBinding(mutant)).toBe(false);
    const main = sfc(mainFile); expect(imported(main.script, '@/components/community/CommunityFeaturedViewer.vue', 'CommunityFeaturedViewer')).toBe(true);
    expect(main.elements.filter(row => row.tag === 'CommunityFeaturedViewer')).toHaveLength(1);
    expect(source).toContain(':data-active-post-id="viewer.active.value?.id || 0"');
    expect(source).toContain('class="featured-current-title"'); expect(source).toContain('已只读恢复此前精选');
  });
  it('keeps deliberate feature visits in activation and state recovery independent of list membership', () => {
    const script = tree(read('composables/useCommunityFeatured.ts'));
    expect(imported(script, '@/api/community', 'apiCommunityVisit')).toBe(true); expect(imported(script, '@/api/community', 'apiCommunityState')).toBe(true);
    expect(calls(fn(script, 'activate')!, script).filter(name => name === 'apiCommunityVisit')).toHaveLength(1);
    expect(calls(fn(script, 'refreshState')!, script)).toContain('apiCommunityState');
    expect(calls(fn(script, 'refreshState')!, script)).not.toContain('apiCommunityVisit');
    const main = sfc(mainFile); expect(calls(fn(main.script, 'recoverCommunity')!, main.script)).toContain('featured.refreshState');
    expect(calls(fn(main.script, 'recoverCommunity')!, main.script)).not.toContain('featured.activate');
    expect(script.getText()).toContain('detached.value && active.value ? [active.value] : posts.value');
    expect(fn(script, 'step')!.getText(script)).toContain('requestedId.value !== selected');
  });
  it('uses a local App canonical mixed feed with no remote viewer or credential propagation', () => {
    const { script } = sfc(mainFile), change = fn(script, 'changeFeedTab')!;
    expect(change.getText(script)).toContain("typeof plus !== 'undefined'");
    expect(change.getText(script)).toContain("'/pages/discover/workspace?feed=featured'");
    expect(change.getText(script)).not.toMatch(/web-view|https?:\/\/|encodeURIComponent\(.*token/);
    expect(parseCommunityWorkspaceEntry({feed:'featured'})).toEqual({kind:'feed',tab:'featured'});
    expect(parseCommunityWorkspaceEntry({})).toEqual({kind:'feed'});
    for (const input of [{feed:'1'},{feed:'featured',id:'31'},{feed:'featured',post_id:'31',post_type:'1'},
      {feed:'featured',author_id:'self'},{feed:'featured',publish:'1'},{feed:'featured',topic_id:'9'},{feed:['featured']}, {feed:'featured',edit_id:'31'}])
      expect(() => parseCommunityWorkspaceEntry(input)).toThrow();
  });
  it('registers the exact old main bridge and both real pull-refresh roots while preserving the reviewed138-page manifest before exact sign/points additions', () => {
    const raw = read('pages.json'), previous = reverseSignCentreManifest(reversePointsCentreManifest(raw));
    const manifest = JSON.parse(raw) as {pages:Array<{path:string;style?:{enablePullDownRefresh?:boolean}}>};
    const historical = (JSON.parse(previous) as typeof manifest).pages.map(row=>'/'+row.path);
    const pages = manifest.pages.map(row=>'/'+row.path); expect(historical).toHaveLength(138); expect(new Set(historical).size).toBe(138);
    expect(pages).toHaveLength(historical.length + 2); expect(new Set(pages).size).toBe(pages.length);
    expect([...REGISTERED_PAGE_ROUTES].sort()).toEqual(pages.slice().sort()); expect([...serverPages].sort()).toEqual(pages.slice().sort());
    expect(pages).toContain('/pages/discoverIndex/index');
    for (const path of ['pages/discover/index','pages/discover/workspace']) expect(manifest.pages.find(row=>row.path===path)?.style?.enablePullDownRefresh).toBe(true);
    for (const resolve of [resolveRegisteredPageRoute,serverResolve]) {
      expect(resolve('/pages/discoverIndex/index')).toBe('/pages/discover/index');
      expect(resolve('/pages/discover/workspace','feed=featured')).toBe('/pages/discover/workspace?feed=featured');
    }
  });
  it('keeps the old main bridge pure and rejects disconnected or type-only parser mutations', () => {
    expect(pureLegacy()).toBe(true); const original = read('pages/discoverIndex/index.vue');
    expect(pureLegacy(original.replace('import { communityPageQuery }','import type { communityPageQuery }'))).toBe(false);
    expect(pureLegacy(original.replace('communityPageQuery(input ?? {})','unrelated(input ?? {})'))).toBe(false);
    expect(pureLegacy(original.replace('uni.switchTab({','uni.navigateTo({'))).toBe(false);
    expect(pureLegacy(original.replace("'/pages/discover/index'","'https://example.test/'"))).toBe(false);
    expect(original).toContain("!['token', 'uid', 'spid'].includes(key)");
  });
  it('retains availability synchronization, owner and hide fences in both feed projections', () => {
    for (const name of ['HomeFeed','Featured']) {
      const script = tree(read(`composables/useCommunity${name}.ts`));
      expect(imported(script,'@/utils/communityAvailability','useCommunityAvailability')).toBe(true);
      expect(all(script,ts.isCallExpression).some(call=>call.expression.getText(script)==='watch' && call.arguments[0]?.getText(script)==='availability.closed'
        && call.arguments[2]?.getText(script).includes("flush: 'sync'"))).toBe(true);
      expect(calls(script,script)).toContain('onHide'); expect(calls(script,script)).toContain('onUnload'); expect(calls(script,script)).toContain('onScopeDispose');
      expect(script.getText()).toContain('auth.sessionVersion');
    }
  });
});
