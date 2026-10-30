import { reverseAdminUserFilterReport } from './helpers/adminUserFilterSourceBinding';
import { reverseCommunityPreviewRefreshSource } from './helpers/diyCommunityPreviewRefreshSourceBinding';
import {readMainMergePredecessor as readFileSync} from './helpers/migrationMergeSourceBinding';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from './helpers/migrationMergeMainReport';
import { applyEditorialAuthorReport } from './helpers/diyEditorialAuthorSourceBindingMain';
import { applyCommerceAuthorReport, commerceAuthorSourceBinding } from './helpers/diyCommerceAuthorSourceBinding';
import { applyCommunityAuthorReport, reverseCommunityAuthorReport, reverseCommunityAuthorSource, communityAuthorSourceBinding as proof } from './helpers/diyCommunityAuthorSourceBindingMain';
const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>reverseCommunityPreviewRefreshSource(file,readFileSync(resolve(root,file),'utf8')),sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const reportHash=(value:unknown)=>sha(JSON.stringify(value,null,2)+'\n');
const previous=applyCommerceAuthorReport(applyEditorialAuthorReport(JSON.parse(read(proof.previous_report.base_file))));
const {parse}=createRequire(import.meta.url)('../../view/admin-ts/node_modules/@vue/compiler-sfc') as typeof import('../../view/admin-ts/node_modules/@vue/compiler-sfc');
const ast=(source:string)=>ts.createSourceFile('live.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function nodes<T extends ts.Node>(root:ts.Node,predicate:(node:ts.Node)=>node is T){const result:T[]=[];function walk(node:ts.Node){if(predicate(node))result.push(node);ts.forEachChild(node,walk);}walk(root);return result;}
function literal(file:string,name:string){const tree=ast(read(file)),declaration=nodes(tree,ts.isVariableDeclaration).find(node=>node.name.getText(tree)===name);let value=declaration?.initializer;while(value&&(ts.isAsExpression(value)||ts.isParenthesizedExpression(value)||ts.isSatisfiesExpression(value)))value=value.expression;if(!value||!ts.isObjectLiteralExpression(value))throw Error('Expected complete JSON-compatible object');return JSON.parse(value.getText(tree));}
function pageBound(input:string){
 const parsed=parse(input),descriptor=parsed.descriptor;if(parsed.errors.length||!descriptor.template?.ast||!descriptor.scriptSetup)return false;
 const file=ast(descriptor.scriptSetup.content),imports=file.statements.filter(ts.isImportDeclaration);
 const imported=(module:string,name:string)=>imports.some(node=>ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text===module&&!node.importClause?.isTypeOnly&&(node.importClause?.name?.text===name||node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)&&node.importClause.namedBindings.elements.some(item=>!item.isTypeOnly&&item.name.text===name)));
 if(!imported('@/components/content/DiyCommunityEditor.vue','DiyCommunityEditor')||!imported('@/utils/diyCommunityEditor','canonicalCommunityValue'))return false;
 const elements:any[]=[];function visit(node:any){if(node.type===1)elements.push(node);for(const child of node.children??[])visit(child);}visit(descriptor.template.ast);
 const editors=elements.filter(node=>node.tag==='DiyCommunityEditor');if(editors.length!==1)return false;const editor=editors[0];
 if(!editor.props.some((p:any)=>p.type===7&&p.name==='model'&&p.exp?.content==='form.value'))return false;
 for(const[key,value]of[['editor-key','`${editorIdentity}:${form.id}:${editorEpoch}`'],['page-id','form.id'],['page-published','persistedPublished'],['disabled','submitting || !formVisible || !sessionReady']])if(!editor.props.some((p:any)=>p.type===7&&p.name==='bind'&&p.arg?.content===key&&p.exp?.content===value))return false;
 const canonical=nodes(file,ts.isFunctionDeclaration).find(node=>node.name?.text==='canonicalJson'),save=nodes(file,ts.isFunctionDeclaration).find(node=>node.name?.text==='save');if(!canonical||!save)return false;
 const wrappers=nodes(canonical,ts.isCallExpression).filter(node=>ts.isIdentifier(node.expression)&&node.expression.text==='canonicalCommunityValue');
 if(wrappers.length!==1||wrappers[0]!.arguments.length!==1||!ts.isCallExpression(wrappers[0]!.arguments[0]!)||wrappers[0]!.arguments[0]!.expression.getText(file)!=='canonicalCommerceValue')return false;
 if(!nodes(canonical,ts.isReturnStatement).some(node=>node.expression===wrappers[0]))return false;
 const value=nodes(save,ts.isVariableDeclaration).find(node=>ts.isIdentifier(node.name)&&node.name.text==='value');
 if(!value?.initializer||!ts.isCallExpression(value.initializer)||value.initializer.expression.getText(file)!=='canonicalJson'||value.initializer.arguments.length!==1||value.initializer.arguments[0]!.getText(file)!=='form.value')return false;
 const payload=nodes(save,ts.isVariableDeclaration).find(node=>ts.isIdentifier(node.name)&&node.name.text==='payload');
 if(!payload||nodes(payload,ts.isShorthandPropertyAssignment).filter(node=>node.name.text==='value').length!==2)return false;
 return nodes(save,ts.isCallExpression).filter(node=>node.expression.getText(file)==='request.post'&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text==='/dise/save'&&node.arguments[1]?.getText(file)==='payload').length===1;
}
function actualControls(source:string,when:Record<string,number>,panel:number):unknown{
 const tree=ast(read('view/admin-ts/src/utils/diyNavigationEditor.ts')),declaration=nodes(tree,ts.isVariableDeclaration).find(node=>node.name.getText(tree)==='navRead');
 if(!declaration||!ts.isVariableDeclarationList(declaration.parent)||!ts.isVariableStatement(declaration.parent.parent)||declaration.parent.declarations.length!==1)throw Error('Actual navRead declaration missing');
 const compile=(value:string)=>ts.transpileModule(value,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const navigation:Record<string,unknown>={},exports:Record<string,unknown>={};
 runInNewContext(compile(declaration.parent.parent.getText(tree)),{exports:navigation});
 runInNewContext(compile(source),{exports,require:(name:string)=>{if(name!=='./diyNavigationEditor')throw Error('Unexpected community control dependency');return navigation;}});
 if(typeof exports.communityControlKeys!=='function')throw Error('Actual community controls export missing');
 const block=structuredClone(JSON.parse(read(proof.defaults_fixture.file)).community) as Record<string,unknown>;
 (block.setUp as Record<string,unknown>).tabVal=panel;
 for(const[path,value]of Object.entries(when)){const[owner,key]=path.split('.');(block[owner!] as Record<string,unknown>)[key!]=value;}
 return Reflect.apply(exports.communityControlKeys,undefined,[block]);
}
function allCasesMatch(source:string){try{const matrix=JSON.parse(read(proof.condition_fixture.file));return matrix.families[0].methods.every((method:any)=>method.cases.every((row:any)=>JSON.stringify(actualControls(source,row.when,Number(method.name==='getRComStyle')))===JSON.stringify(row.controls)));}catch{return false;}}

describe('complete community author source and additive dated-history binding',()=>{
 it('pins all three exact source boundaries before any older inverse and preserves all old fixtures',()=>{
  expect(sha(read('workers-ts/test/fixtures/diy-community-author-source-binding-20261025.json'))).toBe('536ddbfcf36f8860717b226712311fc6ff41a2feb95b753097a576e15cfdcb86');
  expect(proof.php_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');expect(proof.sources.map(row=>[row.file,row.edits.length])).toEqual([['view/admin-ts/src/pages/content/DiseList.vue',3],['workers-ts/src/services/content/DiyEditorialMediaPolicy.ts',4],['view/uniapp-ts/src/utils/diyEditorialMediaLease.ts',1]]);
  for(const row of proof.sources){expect(sha(read(row.file))).toBe(row.after_sha256);expect(sha(reverseCommunityAuthorSource(row.file,read(row.file)))).toBe(row.before_sha256);}
  expect(proof.sources[0]!.before_sha256).toBe(commerceAuthorSourceBinding.source.after_sha256);
  for(const row of proof.sources.slice(1))expect(commerceAuthorSourceBinding.consumer_sources.find(item=>item.file===row.file)?.sha256).toBe(row.before_sha256);
  expect(sha(read(proof.previous_report.base_file))).toBe(proof.previous_report.base_sha256);for(const row of proof.previous_report.binding_chain)expect(sha(read(row.file))).toBe(row.sha256);
  expect(reportHash(previous)).toBe(proof.previous_report.sha256);expect(Object.hasOwn(proof.previous_report,'raw_utf8')).toBe(false);
 });
 for(const entry of proof.sources)it.each(['extra','duplicate','missing','before-hash','after-hash','before-line','after-line'] as const)('rejects exact source boundary mutation %s at '+entry.file,kind=>{
  const changed=structuredClone(proof),row=changed.sources.find(item=>item.file===entry.file)!;let source=read(entry.file);
  if(kind==='extra')source+='\n// unrelated source\n';if(kind==='duplicate')source+=row.edits[0]!.after_source;if(kind==='missing')source=source.replace(row.edits[0]!.after_source,'');
  if(kind==='before-hash')row.before_sha256='0'.repeat(64);if(kind==='after-hash')row.after_sha256='0'.repeat(64);if(kind==='after-line')row.edits[0]!.after_line++;
  if(kind==='before-line'){const edit=row.edits.find(item=>item.before_source)!;expect(edit).toBeDefined();edit.before_line!++;}
  expect(()=>reverseCommunityAuthorSource(entry.file,source,changed)).toThrow();
 });
 it('rejects forged source inventories and leaves every unrelated file exact',()=>{
  const opaque='// unchanged sibling\n';expect(reverseCommunityAuthorSource('view/admin-ts/src/utils/unrelated.ts',opaque)).toBe(opaque);
  for(const kind of ['missing','duplicate','other']){const changed=structuredClone(proof);if(kind==='missing')changed.sources.pop();if(kind==='duplicate')changed.sources[1]=structuredClone(changed.sources[0]!);if(kind==='other')changed.sources[0]!.file='view/admin-ts/src/utils/unrelated.ts';expect(()=>reverseCommunityAuthorSource(proof.sources[0]!.file,read(proof.sources[0]!.file),changed)).toThrow();}
 });
 it('binds the entire14-source current producer/consumer manifest without exempting any source body',()=>{
  expect(proof.consumer_sources).toHaveLength(14);expect(new Set(proof.consumer_sources.map(row=>row.file)).size).toBe(14);
  for(const row of proof.consumer_sources){expect(sha(read(row.file)),row.file).toBe(row.sha256);expect(sha(read(row.file)+'\n// unreviewed\n')).not.toBe(row.sha256);}
 });
 it('reconstructs the complete report with exactly one parent hash and three existing call-line shifts',()=>{
  const actual=reverseAdminUserFilterReport(buildAdminFrontendApiAuditReport());expect(applyCommunityAuthorReport(previous)).toEqual(actual);expect(reverseCommunityAuthorReport(actual)).toEqual(previous);expect(reportHash(actual)).toBe(proof.current_report.sha256);
  const captured=proof.current_report.raw_capture.serialization==='JSON.stringify(report, null, 2) + newline'?JSON.stringify(actual,null,2)+'\n':JSON.stringify(actual)+'\n';expect(sha(captured)).toBe(proof.current_report.raw_capture.sha256);expect(Buffer.byteLength(captured)).toBe(proof.current_report.raw_capture.bytes);
  expect(sha(JSON.stringify(actual)+'\n')).toBe(proof.current_report.compact.sha256);expect(Buffer.byteLength(JSON.stringify(actual)+'\n')).toBe(proof.current_report.compact.bytes);
  expect(proof.report_changes).toHaveLength(4);for(const row of proof.report_changes){const before={...row.before},after={...row.after};if(row.array==='calls'){expect(after.line).toBe(Number(before.line)+3);delete before.line;delete after.line;}else{delete before.sha256;delete after.sha256;}expect(after).toEqual(before);}
  expect(actual.counts).toMatchObject({callSites:703,pathVariants:741,registered:741,unregistered:0,unresolved:0});expect(actual.frontendSources).toHaveLength(106);
 });
 it.each(['missing','duplicate','index','array','before-row','after-row','before-hash','after-hash'] as const)('rejects forged report delta %s',kind=>{
  const changed=structuredClone(proof);if(kind==='missing')changed.report_changes.pop();if(kind==='duplicate')changed.report_changes.push(structuredClone(changed.report_changes[0]!));if(kind==='index')changed.report_changes[0]!.index=-1;if(kind==='array')changed.report_changes[0]!.array='unreviewed' as 'calls';if(kind==='before-row')changed.report_changes[1]!.before.line=0;if(kind==='after-row')changed.report_changes[1]!.after.line=0;if(kind==='before-hash')changed.previous_report.sha256='0'.repeat(64);if(kind==='after-hash')changed.current_report.sha256='0'.repeat(64);expect(()=>applyCommunityAuthorReport(previous,changed)).toThrow();
 });
 it.each(['counts','backend','methodology','call','source'] as const)('rejects unrelated complete report mutation %s',kind=>{const input=structuredClone(previous);if(kind==='counts')input.counts.registered++;if(kind==='backend')input.backend.sha256='0'.repeat(64);if(kind==='methodology')input.methodology.scope='unreviewed';if(kind==='call')input.calls[0].line++;if(kind==='source')input.frontendSources[0].sha256='0'.repeat(64);expect(()=>applyCommunityAuthorReport(input)).toThrow();const current=applyCommunityAuthorReport(previous);current.calls[0].line++;expect(()=>reverseCommunityAuthorReport(current)).toThrow();});
 it('binds all36 nested default fields and the actual fresh-block producer to the fixed PHP source',()=>{
  expect(sha(read(proof.defaults_fixture.file))).toBe(proof.defaults_fixture.sha256);expect(proof.defaults_fixture.top_level_keys).toBe(36);
  const expected=JSON.parse(read(proof.defaults_fixture.file)),actual=literal('view/admin-ts/src/utils/diyCommunityDefaults.ts','DIY_COMMUNITY_DEFAULTS');expect(actual).toEqual(expected);expect(Object.keys(actual.community)).toHaveLength(36);
  expect(proof.php_sources.find(row=>row.path==='view/admin/src/components/mobilePage/home_community.vue')?.sha256).toBe('748f9410bee33dc16f2e59e5a7a7bd4cc67e6f9434d9af789dfcb03d44f97bcc');
  const file=ast(read('view/admin-ts/src/utils/diyCommunityEditor.ts')),producer=nodes(file,ts.isFunctionDeclaration).find(node=>node.name?.text==='newCommunityBlock');expect(producer).toBeDefined();expect(nodes(producer!,ts.isCallExpression).some(call=>call.expression.getText(file)==='structuredClone'&&call.arguments[0]?.getText(file)==='DIY_COMMUNITY_DEFAULTS[kind]')).toBe(true);
  expect(proof.default_bindings).toHaveLength(2);for(const binding of proof.default_bindings){let value:any=expected;for(const key of binding.path)value=value[key];expect(value).toBe(binding.literal);}
 });
 it('executes all12 original PHP conditional branches with exact axes/order using the actual control module and navRead',()=>{
  expect(sha(read(proof.condition_fixture.file))).toBe(proof.condition_fixture.sha256);expect(proof.condition_fixture.php_method_cases).toBe(12);
  const matrix=JSON.parse(read(proof.condition_fixture.file));expect(matrix.source.sha256).toBe('6e4250dc590e71a4d0d4137a7924406fca8b3af5791bcfe560cffeef8b5174b6');let count=0;
  for(const method of matrix.families[0].methods)for(const row of method.cases){expect(actualControls(read('view/admin-ts/src/utils/diyCommunityControls.ts'),row.when,Number(method.name==='getRComStyle'))).toEqual(row.controls);count++;}expect(count).toBe(12);
 });
 it('rejects missing topic/custom control and inverted layout/title conditions through all actual PHP cases',()=>{
  const source=read('view/admin-ts/src/utils/diyCommunityControls.ts');expect(allCasesMatch(source)).toBe(true);
  for(const changed of [source.replace("['selectConfig']","['unrelated']"),source.replace("['likeSuccessColor']","[]"),source.replace("['styleConfig', 'tabVal']","['titleConfig', 'tabVal']"),source.replace("title ? 'titleTxtConfig' : 'imgConfig'","title ? 'imgConfig' : 'titleTxtConfig'")]){expect(changed).not.toBe(source);expect(allCasesMatch(changed)).toBe(false);}
 });
 it('binds the exact original PHP header PNG at both real local asset paths',()=>{expect(proof.assets).toHaveLength(1);const asset=proof.assets[0]!;expect(asset.php_ref).toBe(proof.php_ref);expect(asset.public_path).toBe('/static/images/diy/community.png');expect(asset.php_path).toBe('view/admin/src/assets/images/community.png');expect(asset.sha256).toBe('48785691c5387e98d65dc662913a3fdd3d146db9152b042d51f1f2647c8d8b4c');for(const file of[asset.admin_file,asset.uni_file]){const bytes=readFileSync(resolve(root,file));expect(bytes.length).toBe(1886);expect(sha(bytes)).toBe(asset.sha256);const dimensions=new DataView(Uint8Array.from(bytes).buffer);expect([dimensions.getUint32(16),dimensions.getUint32(20)]).toEqual([128,32]);}});
 it('requires the real mounted v-model/owner/page/permissions and canonical result in actual save payloads',()=>{
  const source=read(proof.sources[0]!.file),render=proof.sources[0]!.edits[0]!.after_source;expect(pageBound(source)).toBe(true);
  for(const changed of[source.replace(render,render.replace('v-model="form.value"','v-model="form.content"')),source.replace(render,render.replace(':disabled="submitting || !formVisible || !sessionReady"',':disabled="false"')),source.replace(render,render.replace(':editor-key="`${editorIdentity}:${form.id}:${editorEpoch}`"',':editor-key="`fixed`"')),source.replace(render,render.replace(':page-published="persistedPublished"',':page-published="true"')),source.replace("import DiyCommunityEditor from", "import type DiyCommunityEditor from"),source.replace('return canonicalCommunityValue(canonicalCommerceValue','return canonicalCommerceValue'),source.replace('const value = canonicalJson(form.value);','const value = form.value;'),source.replace('        value,','        value: form.content,')]){expect(changed).not.toBe(source);expect(pageBound(changed)).toBe(false);}
 });
});
