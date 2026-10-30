import { reverseMigrationAuditHarnessSource } from './helpers/migrationAuditFollowupSourceBinding';
import { createHash } from 'node:crypto';
import {readMainMergePredecessor as readFileSync} from './helpers/migrationMergeSourceBinding';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe,expect,it } from 'vitest';
import { communityPreviewRefreshSourceBinding as old } from './helpers/diyCommunityPreviewRefreshSourceBinding';
import { adminUserFilterSourceBinding as production } from './helpers/adminUserFilterSourceBinding';
import { adminUserFilterTestHarnessSourceBinding as proof,reverseAdminUserFilterTestHarnessSource } from './helpers/adminUserFilterTestHarnessSourceBinding';
const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>readFileSync(resolve(root,file),'utf8'),sha=(source:string)=>createHash('sha256').update(source).digest('hex');
const files=['workers-ts/test/diy-commerce-author-source-binding.test.ts','workers-ts/test/diy-commerce-preview-expiry-source-binding.test.ts'];
const e6='workers-ts/test/diy-community-preview-refresh-source-binding.test.ts';
/** Actual E6 read must peel the reviewed test delta around its raw filesystem read. */
function boundRead(source:string):boolean{
 const tree=ts.createSourceFile('e6.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),name='reverseAdminUserFilterTestHarnessSource';
 const imported=tree.statements.filter(ts.isImportDeclaration).some(node=>ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text==='./helpers/adminUserFilterTestHarnessSourceBinding'&&!node.importClause?.isTypeOnly&&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)&&node.importClause.namedBindings.elements.some(item=>!item.isTypeOnly&&item.name.text===name&&(!item.propertyName||item.propertyName.text===name)));
 if(!imported)return false;const found:ts.VariableDeclaration[]=[];function visit(node:ts.Node){if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==='read')found.push(node);ts.forEachChild(node,visit);}visit(tree);
 if(found.length!==1)return false;const fn=found[0]!.initializer;if(!fn||!ts.isArrowFunction(fn)||!ts.isCallExpression(fn.body)||fn.body.expression.getText(tree)!==name||fn.body.arguments.length!==2||fn.body.arguments[0]!.getText(tree)!=='file')return false;
 const raw=fn.body.arguments[1]!;return ts.isCallExpression(raw)&&raw.expression.getText(tree)==='readFileSync'&&raw.arguments.length===2&&raw.arguments[0]!.getText(tree)==='resolve(root,file)'&&ts.isStringLiteral(raw.arguments[1]!)&&raw.arguments[1]!.text==='utf8';
}
describe('Admin user-filter exact test-harness adjunct for immutable E6 history',()=>{
 it('pins exactly two later imports/report wrappers and restores the original E6 preserved bytes',()=>{
  expect(sha(read('workers-ts/test/fixtures/admin-user-filter-test-harness-source-binding-20261025.json'))).toBe('003db31800bcaec20f3ec571b64384e6173738860aa235a20c4087be3d7f9c2e');expect(proof.sources.map(row=>row.file)).toEqual(files);
  for(const entry of proof.sources){const actual=read(entry.file),historical=reverseAdminUserFilterTestHarnessSource(entry.file,actual),original=old.preserved_files.find(row=>row.file===entry.file)!;expect(original).toBeDefined();expect(entry.edits).toHaveLength(2);expect(entry.edits[0]!.before_source).toBe('');expect(entry.edits[0]!.after_source).toBe("import { reverseAdminUserFilterReport } from './helpers/adminUserFilterSourceBinding';\n");expect(entry.edits[1]!.before_source).toBe('buildAdminFrontendApiAuditReport()');expect(entry.edits[1]!.after_source).toBe('reverseAdminUserFilterReport(buildAdminFrontendApiAuditReport())');expect(sha(actual)).toBe(entry.after_sha256);expect(Buffer.byteLength(actual)).toBe(entry.after_bytes);expect(sha(historical)).toBe(entry.before_sha256);expect(sha(historical)).toBe(original.sha256);expect(Buffer.byteLength(historical)).toBe(original.bytes);expect(entry.before_bytes).toBe(original.bytes);expect(entry.edits[0]!.after_source+historical.replace(entry.edits[1]!.before_source,entry.edits[1]!.after_source)).toBe(actual);}
 });
 it('keeps all E6 and80old proof bytes and reconstructs the historical production adjunct after the exact migration harness inverse',()=>{
  for(const row of [...old.preserved_files,...old.unchanged_dependency_sources]){const actual=reverseAdminUserFilterTestHarnessSource(row.file,read(row.file));expect(sha(actual),row.file).toBe(row.sha256);expect(Buffer.byteLength(actual),row.file).toBe(row.bytes);}
  for(const row of [...proof.unchanged_contract_files,...production.preserved_files]){const actual=reverseMigrationAuditHarnessSource(row.file,read(row.file));expect(sha(actual),row.file).toBe(row.sha256);expect(Buffer.byteLength(actual),row.file).toBe(row.bytes);}
  expect(proof.unchanged_contract_files.map(row=>row.file)).toEqual(['workers-ts/test/fixtures/diy-community-preview-refresh-source-binding-20261025.json','workers-ts/test/helpers/diyCommunityPreviewRefreshSourceBinding.ts','workers-ts/test/fixtures/admin-user-filter-source-binding-20261025.json','workers-ts/test/helpers/adminUserFilterSourceBinding.ts']);
  // E6's own new read adapter is not recursively inserted into its old preserved manifest.
  expect(old.preserved_files.some(row=>row.file===e6)).toBe(false);expect(proof.sources.some(row=>row.file===e6)).toBe(false);expect(reverseAdminUserFilterTestHarnessSource(e6,read(e6))).toBe(read(e6));expect(boundRead(read(e6))).toBe(true);
  expect(reverseAdminUserFilterTestHarnessSource('unrelated.ts','opaque\n')).toBe('opaque\n');
 });
 for(const file of files)it.each(['extra','duplicate','missing-import','wrong-report','old','newline','before-hash','after-hash','before-bytes','after-bytes','before-line','after-line'] as const)('rejects unreviewed %s in '+file,kind=>{
  const binding=structuredClone(proof),entry=binding.sources.find(row=>row.file===file)!,original=read(file);let source=original;
  if(kind==='extra')source+='\n// unknown\n';if(kind==='duplicate')source+=entry.edits[0]!.after_source;if(kind==='missing-import')source=source.replace(entry.edits[0]!.after_source,'');if(kind==='wrong-report')source=source.replace('reverseAdminUserFilterReport(buildAdminFrontendApiAuditReport())','buildAdminFrontendApiAuditReport()');if(kind==='old')source=reverseAdminUserFilterTestHarnessSource(file,source);if(kind==='newline')source=source.replace(/\n/u,'\r\n');
  if(kind==='before-hash')entry.before_sha256='0'.repeat(64);if(kind==='after-hash')entry.after_sha256='0'.repeat(64);if(kind==='before-bytes')entry.before_bytes++;if(kind==='after-bytes')entry.after_bytes++;if(kind==='before-line')entry.edits[1]!.before_line!++;if(kind==='after-line')entry.edits[1]!.after_line++;
  if(['extra','duplicate','missing-import','wrong-report','old','newline'].includes(kind))expect(source).not.toBe(original);expect(()=>reverseAdminUserFilterTestHarnessSource(file,source,binding)).toThrow();
 });
 it.each(['missing','duplicate','order','self','app','new-text','old-text','base-ref','entry-ref'] as const)('rejects forged exact test inventory %s',kind=>{
  const binding=structuredClone(proof);if(kind==='missing')binding.sources.pop();if(kind==='duplicate')binding.sources[1]=structuredClone(binding.sources[0]!);if(kind==='order')binding.sources.reverse();if(kind==='self')binding.sources[0]!.file=e6;if(kind==='app')binding.sources[0]!.file=production.sources[0]!.file;if(kind==='new-text')binding.sources[0]!.edits[0]!.after_source+='// unknown';if(kind==='old-text')binding.sources[0]!.edits[1]!.before_source='unknown';if(kind==='base-ref')binding.base_ref='unknown';if(kind==='entry-ref')binding.sources[0]!.before_ref='unknown';expect(()=>reverseAdminUserFilterTestHarnessSource(files[0]!,read(files[0]!),binding)).toThrow();
 });
 it('requires the real E6 import and raw-read wrapper instead of weakening the original preserved checks',()=>{
  const source=read(e6);expect(boundRead(source)).toBe(true);for(const changed of [source.replace('import { reverseAdminUserFilterTestHarnessSource }','import type { reverseAdminUserFilterTestHarnessSource }'),source.replace("read=(file:string)=>reverseAdminUserFilterTestHarnessSource(file,readFileSync(resolve(root,file),'utf8'))","read=(file:string)=>readFileSync(resolve(root,file),'utf8')"),source.replace("reverseAdminUserFilterTestHarnessSource(file,readFileSync(resolve(root,file),'utf8'))","reverseAdminUserFilterTestHarnessSource('unrelated',readFileSync(resolve(root,file),'utf8'))")]){expect(changed).not.toBe(source);expect(boundRead(changed)).toBe(false);}
 });
});
