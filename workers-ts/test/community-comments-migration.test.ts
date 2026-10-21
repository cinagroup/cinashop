import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
const { parse, compileTemplate } = createRequire(import.meta.url)('../../view/admin-ts/node_modules/@vue/compiler-sfc') as typeof import('../../view/admin-ts/node_modules/@vue/compiler-sfc');
const read = (path: string) => readFileSync('../view/uniapp-ts/src/' + path, 'utf8');
function tree(source: string, name: string) {
  const parsed = parse(source, { filename: name });
  expect(parsed.errors).toEqual([]);
  expect(compileTemplate({ source: parsed.descriptor.template!.content, filename: name, id: 'comments-contract' }).errors).toEqual([]);
  const script = ts.createSourceFile(name + '.ts', parsed.descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
  const nodes: Array<NonNullable<typeof parsed.descriptor.template>['ast']> = [];
  const walk = (node: any) => { nodes.push(node); for (const child of node.children ?? []) walk(child); };
  walk(parsed.descriptor.template!.ast);
  return { script, nodes: nodes as any[] };
}
function imports(script: ts.SourceFile, local: string, module: string) {
  return script.statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === module && statement.importClause?.isTypeOnly === false && statement.importClause.name?.text === local);
}
function sharedBinding(source: string, name: string) {
  const parsed = tree(source, name);
  return imports(parsed.script, 'CommunityComments', '@/components/community/CommunityComments.vue') && parsed.nodes.some(node => node.tag === 'CommunityComments'
    && ['post-id', 'total', 'writable'].every(name => node.props.some((prop: any) => prop.type === 7 && prop.name === 'bind' && prop.arg?.content === name))
    && node.props.some((prop: any) => prop.type === 7 && prop.name === 'on' && prop.arg?.content === 'count' && prop.exp?.content === 'updateCommentCount'));
}
describe('shared complete community comment surfaces', () => {
  it('main community and deep-link detail use the real imported component and authoritative count event', () => {
    for (const file of ['pages/discover/index.vue', 'components/community/CommunityDeepLinkFeed.vue']) {
      const source = read(file);
      expect(sharedBinding(source, file)).toBe(true);
      expect(source).not.toMatch(/\bapiCommentList\b|\bapiCommentSave\b|async function sendComment/);
      expect(source).toContain('detail.value?.id !== value.postId');
      expect(sharedBinding(source.replace(/<CommunityComments[^>]+\/>/, '<!-- CommunityComments -->'), file)).toBe(false);
      expect(sharedBinding(source.replace('import CommunityComments', 'import type CommunityComments'), file)).toBe(false);
    }
  });
  it('actual comment template binds reply, like, owned deletion and manual reconciliation to shared state', () => {
    const source = read('components/community/CommunityComments.vue'), parsed = tree(source, 'CommunityComments.vue');
    const taps = parsed.nodes.flatMap(node => node.props ?? []).filter((prop: any) => prop.type === 7 && prop.name === 'on' && prop.arg?.content === 'tap').map((prop: any) => prop.exp?.content);
    for (const event of ['refresh()', 'submit', 'replyTo(row)', 'toggleLike(row)', 'requestDelete(row)', 'cancelDelete', 'confirmDelete', 'toggleReplies(root)', 'moreReplies(root.id)']) expect(taps).toContain(event);
    expect(parsed.nodes.some(node => node.tag === 'textarea' && node.props.some((prop: any) => prop.type === 7 && prop.name === 'model' && prop.exp?.content === 'text'))).toBe(true);
    expect(source).toContain('watch(thread.countUpdate');
    expect(source).toContain('shown(root) && shown(row)');
    expect(source).not.toContain('showModal');
  });
  it('registered workspace, topic, search and both video shells reach the same thread with a visible video action', () => {
    const pages = JSON.parse(readFileSync('../view/uniapp-ts/src/pages.json', 'utf8')).pages.map((row: { path: string }) => row.path);
    for (const path of ['pages/discover/workspace', 'pages/discover/discoverTopic/index', 'pages/discover/discoverSearch/index', 'pages/discover/discoverVideo/index', 'pages/discover/discoverVideo/app']) expect(pages).toContain(path);
    const workspace = parse(read('pages/discover/workspace.vue'), { filename: 'workspace.vue' });
    expect(workspace.errors).toEqual([]);
    const alias = ts.createSourceFile('workspace.ts', workspace.descriptor.script!.content, ts.ScriptTarget.Latest, true);
    expect(imports(alias, 'CommunityWorkspace', './index.vue')).toBe(true);
    for (const [file, mode] of [['discoverTopic/index', 'topic'], ['discoverSearch/index', 'search'], ['discoverVideo/index', 'video'], ['discoverVideo/app', 'video']]) {
      const parsed = tree(read('pages/discover/' + file + '.vue'), file);
      expect(parsed.nodes.some(node => node.tag === 'CommunityDeepLinkFeed' && node.props.some((prop: any) => prop.type === 6 && prop.name === 'mode' && prop.value?.content === mode))).toBe(true);
    }
    expect(tree(read('components/community/CommunityDeepLinkFeed.vue'), 'feed').nodes.some(node => node.tag === 'button' && node.props.some((prop: any) => prop.type === 7 && prop.name === 'on' && prop.exp?.content === 'openVideoComments'))).toBe(true);
  });
});
