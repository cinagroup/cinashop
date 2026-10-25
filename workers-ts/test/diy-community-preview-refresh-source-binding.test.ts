import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe,expect,it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from '../scripts/admin-frontend-api-audit';
import { applyEditorialAuthorReport } from './helpers/diyEditorialAuthorSourceBinding';
import { applyCommerceAuthorReport } from './helpers/diyCommerceAuthorSourceBinding';
import { applyCommunityAuthorReport,communityAuthorSourceBinding } from './helpers/diyCommunityAuthorSourceBinding';
import { assertCommerceImagePreviewReport } from './helpers/diyCommerceImagePreviewSourceBinding';
import { assertCommercePreviewExpiryReport } from './helpers/diyCommercePreviewExpirySourceBinding';
import { assertCommunityPreviewRefreshReport,reverseCommunityPreviewRefreshSource,communityPreviewRefreshSourceBinding as proof } from './helpers/diyCommunityPreviewRefreshSourceBinding';
const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>readFileSync(resolve(root,file),'utf8'),sha=(source:string)=>createHash('sha256').update(source).digest('hex');
const file='view/admin-ts/src/components/content/DiyCommunityEditor.vue';
const {parse}=createRequire(import.meta.url)('../../view/admin-ts/node_modules/@vue/compiler-sfc') as typeof import('../../view/admin-ts/node_modules/@vue/compiler-sfc');
const ast=(source:string)=>ts.createSourceFile('actual.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function nodes<T extends ts.Node>(input:ts.Node,predicate:(node:ts.Node)=>node is T){const result:T[]=[];function visit(node:ts.Node){if(predicate(node))result.push(node);ts.forEachChild(node,visit);}visit(input);return result;}
function boundRefresh(source:string){
 const parsed=parse(source);if(parsed.errors.length||!parsed.descriptor.scriptSetup)return false;const tree=ast(parsed.descriptor.scriptSetup.content),imports=tree.statements.filter(ts.isImportDeclaration);
 const imported=(name:string)=>imports.some(node=>ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text==='@/api/diyCommunityAuthor'&&!node.importClause?.isTypeOnly&&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)&&node.importClause.namedBindings.elements.some(value=>!value.isTypeOnly&&value.name.text===name&&(!value.propertyName||value.propertyName.text===name)));
 if(!imported('readCommunityPreview')||!imported('communityPreviewDeadline'))return false;
 const load=nodes(tree,ts.isFunctionDeclaration).find(node=>node.name?.text==='loadContent');if(!load)return false;
 const declarations=nodes(load,ts.isVariableDeclaration),result=declarations.find(node=>node.name.getText(tree)==='result'),deadline=declarations.find(node=>node.name.getText(tree)==='deadline'),adopted=declarations.find(node=>node.name.getText(tree)==='adopted'),expire=declarations.find(node=>node.name.getText(tree)==='expireContent');
 if(!result?.initializer||!ts.isAwaitExpression(result.initializer)||!ts.isCallExpression(result.initializer.expression)||result.initializer.expression.expression.getText(tree)!=='readCommunityPreview')return false;
 if(!deadline?.initializer||!ts.isCallExpression(deadline.initializer)||deadline.initializer.expression.getText(tree)!=='communityPreviewDeadline'||deadline.initializer.arguments.length!==1||deadline.initializer.arguments[0]?.getText(tree)!=='result')return false;
 const calls=nodes(load,ts.isCallExpression),clears=calls.filter(call=>call.expression.getText(tree)==='clearTimeout'&&call.arguments.length===1&&call.arguments[0]!.getText(tree)==='contentTimer');if(clears.length!==1||clears[0]!.getStart(tree)>=result.getStart(tree))return false;
 const binaries=nodes(load,ts.isBinaryExpression),unset=binaries.find(node=>node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&node.left.getText(tree)==='contentTimer'&&node.right.getText(tree)==='undefined'),adoption=binaries.find(node=>node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&node.left.getText(tree)==='previewData.value'&&node.right.getText(tree)==='result');
 if(!unset||unset.getStart(tree)<=clears[0]!.getStart(tree)||unset.getStart(tree)>=result.getStart(tree)||!adoption||adoption.getStart(tree)<=deadline.getStart(tree)||adopted?.initializer?.getText(tree)!=='previewData.value'||adopted.getStart(tree)<=adoption.getStart(tree))return false;
 if(!expire?.initializer||!ts.isArrowFunction(expire.initializer)||!ts.isBlock(expire.initializer.body))return false;const conditions=nodes(expire.initializer.body,ts.isIfStatement);if(conditions.length!==1)return false;
 const condition=conditions[0]!.expression;if(!ts.isBinaryExpression(condition)||condition.operatorToken.kind!==ts.SyntaxKind.AmpersandAmpersandToken)return false;
 const current=condition.left,identity=condition.right;if(!ts.isCallExpression(current)||current.expression.getText(tree)!=='current'||current.arguments.length!==1||current.arguments[0]!.getText(tree)!=='issued'||!ts.isBinaryExpression(identity)||identity.operatorToken.kind!==ts.SyntaxKind.EqualsEqualsEqualsToken||identity.left.getText(tree)!=='previewData.value'||identity.right.getText(tree)!=='adopted')return false;
 const timers=calls.filter(call=>call.expression.getText(tree)==='setTimeout');if(timers.length!==1||timers[0]!.arguments[0]?.getText(tree)!=='expireContent')return false;
 let parent:ts.Node|undefined=timers[0]!.parent;while(parent&&parent!==load&&!ts.isIfStatement(parent))parent=parent.parent;
 return !!parent&&ts.isIfStatement(parent)&&parent.expression.getText(tree)==='Number.isFinite(deadline)';
}

describe('Community preview refresh exact single-source adjunct',()=>{
 it('pins the complete before/after source,exact3line edit and original Community consumer bytes',()=>{
  expect(sha(read('workers-ts/test/fixtures/diy-community-preview-refresh-source-binding-20261025.json'))).toBe('03a598b2543c08939b1d37b6f182de5573f27d62abf349a83f0222f33fe25d13');expect(proof.base_ref).toBe('6dd4db7a4fccb574134a7a19f64386c22f09e73c');expect(proof.sources).toHaveLength(1);const entry=proof.sources[0]!,source=read(file),before=reverseCommunityPreviewRefreshSource(file,source);expect(entry.file).toBe(file);expect(entry.before_sha256).toBe('3f950f26f70377ebe43743691acd650bb0e7f6645dbd96a51182a2bb77b802d0');expect(entry.after_sha256).toBe('be38fc0a7814671f80aa82b710113cd633dfeb55d9ca25c94f9e7bc6fa036b79');expect(entry.before_bytes).toBe(18448);expect(entry.after_bytes).toBe(18589);expect(sha(source)).toBe(entry.after_sha256);expect(Buffer.byteLength(source)).toBe(entry.after_bytes);expect(sha(before)).toBe(entry.before_sha256);expect(Buffer.byteLength(before)).toBe(entry.before_bytes);expect(entry.before_sha256).toBe(communityAuthorSourceBinding.consumer_sources.find(row=>row.file===file)!.sha256);
  expect(entry.edits).toHaveLength(1);const edit=entry.edits[0]!;expect(edit.before_line).toBe(58);expect(edit.after_line).toBe(58);expect(edit.before_source.split('\n')).toHaveLength(4);expect(edit.after_source.split('\n')).toHaveLength(4);expect(before.replace(edit.before_source,edit.after_source)).toBe(source);expect(before.split(edit.before_source)).toHaveLength(2);expect(source.split(edit.after_source)).toHaveLength(2);
  const old=parse(before).descriptor,current=parse(source).descriptor;expect(current.template?.content).toBe(old.template?.content);expect(current.styles.map(row=>row.content)).toEqual(old.styles.map(row=>row.content));expect(boundRefresh(before)).toBe(false);expect(boundRefresh(source)).toBe(true);
 });
 it('preserves every dated proof,all8E5commit files and the complete unchanged dependency list',()=>{
  expect(proof.preserved_files).toHaveLength(18);expect(new Set(proof.preserved_files.map(row=>row.file)).size).toBe(18);expect(proof.unchanged_dependency_sources).toHaveLength(20);
  for(const row of [...proof.preserved_files,...proof.unchanged_dependency_sources]){const source=read(row.file);expect(sha(source),row.file).toBe(row.sha256);expect(Buffer.byteLength(source)).toBe(row.bytes);}
  const opaque='// exact unknown sibling\n';expect(reverseCommunityPreviewRefreshSource('view/admin-ts/src/utils/unrelated.ts',opaque)).toBe(opaque);
 });
 it.each(['extra','duplicate','missing','old','same-size-edit','newline','before-hash','after-hash','before-bytes','after-bytes','before-line','after-line'] as const)('rejects any unreviewed source or inverse mutation %s',kind=>{
  const changed=structuredClone(proof),entry=changed.sources[0]!,original=read(file);let source=original;
  if(kind==='extra')source+='\n// extra unreviewed source\n';if(kind==='duplicate')source+=entry.edits[0]!.after_source;if(kind==='missing')source=source.replace(entry.edits[0]!.after_source,'');if(kind==='old')source=reverseCommunityPreviewRefreshSource(file,source);if(kind==='same-size-edit')source=source.replace('const adopted=previewData.value','const adopted=previewData.valu0');if(kind==='newline')source=source.replace(/\n/u,'\r\n');
  if(kind==='before-hash')entry.before_sha256='0'.repeat(64);if(kind==='after-hash')entry.after_sha256='0'.repeat(64);if(kind==='before-bytes')entry.before_bytes++;if(kind==='after-bytes')entry.after_bytes++;if(kind==='before-line')entry.edits[0]!.before_line!++;if(kind==='after-line')entry.edits[0]!.after_line++;
  if(['extra','duplicate','missing','old','same-size-edit','newline'].includes(kind))expect(source).not.toBe(original);expect(()=>reverseCommunityPreviewRefreshSource(file,source,changed)).toThrow();
 });
 it.each(['missing-source','duplicate-source','other-file','extra-edit','before-text','after-text','base-ref','entry-ref'] as const)('rejects forged single-source inventory %s',kind=>{
  const changed=structuredClone(proof);if(kind==='missing-source')changed.sources=[];if(kind==='duplicate-source')changed.sources.push(structuredClone(changed.sources[0]!));if(kind==='other-file')changed.sources[0]!.file='view/admin-ts/src/unreviewed.ts';if(kind==='extra-edit')changed.sources[0]!.edits.push(structuredClone(changed.sources[0]!.edits[0]!));if(kind==='before-text')changed.sources[0]!.edits[0]!.before_source='unreviewed';if(kind==='after-text')changed.sources[0]!.edits[0]!.after_source='unreviewed';if(kind==='base-ref')changed.base_ref='other';if(kind==='entry-ref')changed.sources[0]!.before_ref='other';expect(()=>reverseCommunityPreviewRefreshSource(file,read(file),changed)).toThrow();
 });
 it('requires actual early timer cancellation,deadline-before-adoption,the Vue-ref proxy and the conjunctive current/object fence',()=>{
  const source=read(file);expect(boundRefresh(source)).toBe(true);
  for(const modified of [source.replace('readCommunityPreview,communityPreviewDeadline,','readCommunityPreview,'),source.replace('clearTimeout(contentTimer);contentTimer=undefined;',''),source.replace('contentTimer=undefined;const issued','const issued'),source.replace('const deadline=communityPreviewDeadline(result);previewData.value=result;','previewData.value=result;const deadline=communityPreviewDeadline(result);'),source.replace('communityPreviewDeadline(result)','Infinity'),source.replace('const adopted=previewData.value','const adopted=result'),source.replace('current(issued)&&previewData.value===adopted','current(issued)'),source.replace('current(issued)&&previewData.value===adopted','previewData.value===adopted'),source.replace('current(issued)&&previewData.value===adopted','true||current(issued)&&previewData.value===adopted'),source.replace('setTimeout(expireContent,','setTimeout(()=>{},'),source.replace('Number.isFinite(deadline)','true')]){expect(modified).not.toBe(source);expect(boundRefresh(modified)).toBe(false);}
 });
 it('recomputes the entire real API report as zero delta through both existing display/expiry proof gates',()=>{
  const p=proof.api_report;expect(sha(read(p.base_file))).toBe(p.base_sha256);for(const row of p.binding_chain)expect(sha(read(row.file))).toBe(row.sha256);
  const expected=applyCommunityAuthorReport(applyCommerceAuthorReport(applyEditorialAuthorReport(JSON.parse(read(p.base_file))))),actual=buildAdminFrontendApiAuditReport();expect(actual).toEqual(expected);expect(assertCommerceImagePreviewReport(actual)).toBe(actual);expect(assertCommercePreviewExpiryReport(actual)).toBe(actual);expect(assertCommunityPreviewRefreshReport(actual)).toBe(actual);expect(p.changes).toEqual([]);expect(p.before_sha256).toBe(p.after_sha256);expect(sha(JSON.stringify(actual,null,2)+'\n')).toBe(p.after_sha256);expect(Buffer.byteLength(JSON.stringify(actual,null,2)+'\n')).toBe(p.pretty_bytes);expect(sha(JSON.stringify(actual)+'\n')).toBe(p.compact_sha256);expect(Buffer.byteLength(JSON.stringify(actual)+'\n')).toBe(p.compact_bytes);expect(actual.counts).toMatchObject({callSites:703,pathVariants:741,registered:741,unregistered:0,unresolved:0});expect(actual.frontendSources).toHaveLength(106);expect(actual.frontendSources.some(row=>row.file===file)).toBe(false);
  for(const kind of ['counts','call','source','backend','methodology']){const changed=structuredClone(actual);if(kind==='counts')changed.counts.registered++;if(kind==='call')changed.calls[0].line++;if(kind==='source')changed.frontendSources[0].sha256='0'.repeat(64);if(kind==='backend')changed.backend.sha256='0'.repeat(64);if(kind==='methodology')changed.methodology.scope='unreviewed';expect(()=>assertCommunityPreviewRefreshReport(changed)).toThrow();}
  const changed=structuredClone(proof);changed.api_report.changes.push({unreviewed:true});expect(()=>assertCommunityPreviewRefreshReport(actual,changed)).toThrow();
 });
});
