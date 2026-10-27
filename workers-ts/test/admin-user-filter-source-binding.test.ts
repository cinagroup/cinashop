import { reverseAdminLevelDefinitionSource } from './helpers/adminLevelDefinitionSourceBinding';
import { reverseMigrationAuditSource, reverseMigrationAuditReport } from './helpers/migrationAuditFollowupSourceBinding';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe,expect,it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from '../scripts/admin-frontend-api-audit';
import { applyEditorialAuthorReport } from './helpers/diyEditorialAuthorSourceBinding';
import { applyCommerceAuthorReport } from './helpers/diyCommerceAuthorSourceBinding';
import { applyCommunityAuthorReport } from './helpers/diyCommunityAuthorSourceBinding';
import { assertCommerceImagePreviewReport } from './helpers/diyCommerceImagePreviewSourceBinding';
import { assertCommercePreviewExpiryReport } from './helpers/diyCommercePreviewExpirySourceBinding';
import { assertCommunityPreviewRefreshReport } from './helpers/diyCommunityPreviewRefreshSourceBinding';
import { adminUserFilterSourceBinding as proof,applyAdminUserFilterReport,reverseAdminUserFilterReport,reverseAdminUserFilterSource } from './helpers/adminUserFilterSourceBinding';

const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>readFileSync(resolve(root,file),'utf8'),sha=(source:string)=>createHash('sha256').update(source).digest('hex');
const reportHash=(value:unknown)=>sha(JSON.stringify(value,null,2)+'\n');
const files=['workers-ts/src/routes/adminapi.ts','workers-ts/src/routes/v1/index.ts','view/admin-ts/src/pages/user/UserList.vue','view/admin-ts/src/api/order.ts','workers-ts/src/services/admin/AdminPermissionService.ts'];
const previous=():ReturnType<typeof buildAdminFrontendApiAuditReport>=>applyCommunityAuthorReport(applyCommerceAuthorReport(applyEditorialAuthorReport(JSON.parse(read(proof.api_report.base_file)))));
const ast=(source:string)=>ts.createSourceFile('actual.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function nodes<T extends ts.Node>(input:ts.Node,predicate:(node:ts.Node)=>node is T){const result:T[]=[];function visit(node:ts.Node){if(predicate(node))result.push(node);ts.forEachChild(node,visit);}visit(input);return result;}
/** Parse actual route calls and exact middleware/handler arguments, independently of the inverse. */
function directoryRoutes(source:string,router:string,prefix:string){
 const tree=ast(source),routes=nodes(tree,ts.isCallExpression).filter(call=>ts.isPropertyAccessExpression(call.expression)&&call.expression.expression.getText(tree)===router&&call.arguments[0]&&ts.isStringLiteral(call.arguments[0])&&['filter_options','filter_regions'].some(name=>(call.arguments[0] as ts.StringLiteral).text===prefix+name));
 return routes.map(call=>({method:(call.expression as ts.PropertyAccessExpression).name.text,path:(call.arguments[0] as ts.StringLiteral).text,args:call.arguments.slice(1).map(arg=>arg.getText(tree))}));
}
const routeContract=(prefix:string)=>[{method:'get',path:prefix+'filter_options',args:['adminAuth','AdminCrud.adminUserOptions']},{method:'get',path:prefix+'filter_regions',args:['adminAuth','AdminCrud.adminUserRegions']}];
function apiRequests(source:string){const tree=ast(source);return nodes(tree,ts.isCallExpression).filter(call=>ts.isPropertyAccessExpression(call.expression)&&call.expression.expression.getText(tree)==='request').map(call=>({method:(call.expression as ts.PropertyAccessExpression).name.text,path:call.arguments[0]&&ts.isStringLiteral(call.arguments[0])?call.arguments[0].text:'nonliteral',options:call.arguments[1]?.getText(tree)}));}

describe('complete Admin user-directory additive source and API history boundary',()=>{
 it('pins five historical whole sources after the exact migration inverse and reconstructs their parent byte-for-byte',()=>{
  expect(sha(read('workers-ts/test/fixtures/admin-user-filter-source-binding-20261025.json'))).toBe('54cfe137c143387ef7f0d14f098a7738317ef409e4a45ed299c60c98e3cff3de');expect(proof.base_ref).toBe('330625d39b3988eb37ee73d19fde8e51e14cf625');expect(proof.sources.map(row=>row.file)).toEqual(files);expect(proof.sources.map(row=>row.edits.length)).toEqual([1,1,3,1,1]);
  for(const row of proof.sources){const current=read(row.file),live=reverseMigrationAuditSource(row.file,current),before=reverseAdminUserFilterSource(row.file,current);expect(sha(live)).toBe(row.after_sha256);expect(Buffer.byteLength(live)).toBe(row.after_bytes);expect(sha(before)).toBe(row.before_sha256);expect(Buffer.byteLength(before)).toBe(row.before_bytes);let reconstructed=before;for(const edit of row.edits)reconstructed=reconstructed.replace(edit.before_source,edit.after_source);expect(reconstructed).toBe(live);}
  const untouched='// unchanged sibling bytes\n';expect(reverseAdminUserFilterSource('unrelated.ts',untouched)).toBe(untouched);
 });
 it('preserves every old dated proof/helper/report and binds all new source dependencies',()=>{
  expect(proof.preserved_files).toHaveLength(80);expect(new Set(proof.preserved_files.map(row=>row.file)).size).toBe(80);expect(proof.new_consumer_sources.map(row=>row.file)).toEqual(['workers-ts/src/services/admin/AdminUserListService.ts','workers-ts/src/controllers/api/v1/AdminCrudController.ts','view/admin-ts/src/api/userDirectory.ts','view/admin-ts/src/utils/userDirectoryFilters.ts','view/admin-ts/src/composables/useUserDirectoryOwner.ts','view/admin-ts/src/pages/user/UserDirectoryOptionPicker.vue']);
  for(const row of [...proof.preserved_files,...proof.new_consumer_sources,proof.api_report.builder]){const source=reverseAdminLevelDefinitionSource(row.file,read(row.file));expect(sha(source),row.file).toBe(row.sha256);expect(Buffer.byteLength(source),row.file).toBe(row.bytes);}
  expect(sha(read(proof.api_report.base_file))).toBe(proof.api_report.base_sha256);for(const row of proof.api_report.binding_chain)expect(sha(read(row.file))).toBe(row.sha256);
 });
 for(const file of files)it.each(['extra','duplicate','missing','old','newline','same-size','before-hash','after-hash','before-bytes','after-bytes','before-line','after-line'] as const)('rejects unreviewed source or proof mutation %s in '+file,kind=>{
  const binding=structuredClone(proof),entry=binding.sources.find(row=>row.file===file)!,live=read(file);let source=live;
  if(kind==='extra')source+='\n// unrelated\n';if(kind==='duplicate')source+=entry.edits[0]!.after_source;if(kind==='missing')source=source.replace(entry.edits[0]!.after_source,'');if(kind==='old')source=reverseAdminUserFilterSource(file,source);if(kind==='newline')source=source.replace(/\n/u,'\r\n');if(kind==='same-size')source=source.replace(/a/u,'z');
  if(kind==='before-hash')entry.before_sha256='0'.repeat(64);if(kind==='after-hash')entry.after_sha256='0'.repeat(64);if(kind==='before-bytes')entry.before_bytes++;if(kind==='after-bytes')entry.after_bytes++;if(kind==='before-line')entry.edits[0]!.before_line!++;if(kind==='after-line')entry.edits[0]!.after_line++;
  if(['extra','duplicate','missing','old','newline','same-size'].includes(kind))expect(source).not.toBe(live);expect(()=>reverseAdminUserFilterSource(file,source,binding)).toThrow();
 });
 it.each(['missing','duplicate','order','other-file','extra-edit','old-text','new-text','base-ref','entry-ref'] as const)('rejects forged complete source inventory %s',kind=>{
  const binding=structuredClone(proof);if(kind==='missing')binding.sources.pop();if(kind==='duplicate')binding.sources[1]=structuredClone(binding.sources[0]!);if(kind==='order')binding.sources.reverse();if(kind==='other-file')binding.sources[0]!.file='unreviewed.ts';if(kind==='extra-edit')binding.sources[0]!.edits.push(structuredClone(binding.sources[0]!.edits[0]!));if(kind==='old-text')binding.sources[0]!.edits[0]!.before_source='unknown';if(kind==='new-text')binding.sources[0]!.edits[0]!.after_source='unknown';if(kind==='base-ref')binding.base_ref='unknown';if(kind==='entry-ref')binding.sources[0]!.before_ref='unknown';expect(()=>reverseAdminUserFilterSource(files[0]!,read(files[0]!),binding)).toThrow();
 });
 it('reconstructs the complete historical filter report after the exact current migration report inverse',()=>{
  const before=previous(),current=buildAdminFrontendApiAuditReport(),actual=reverseMigrationAuditReport(current),p=proof.api_report;
  expect(reportHash(before)).toBe('0ed30a0bbf03246a46fa0039fb7975628515fc7b36e743c86cebd5965563d40a');expect(reportHash(actual)).toBe('a99c42f5be30da197bc127a2489a67a3c13cc226246de3279160aa3f18362ab8');expect(applyAdminUserFilterReport(before)).toEqual(actual);expect(reverseAdminUserFilterReport(current)).toEqual(before);expect(actual.counts).toEqual({callSites:706,pathVariants:744,registered:744,executable:744,controlledUnavailable:0,unregistered:0,unresolved:0});expect(actual.frontendSources).toHaveLength(107);expect(actual.backend.registeredRoutes).toHaveLength(1677);expect(p.operations).toHaveLength(14);
  expect(actual.calls.filter(call=>call.source==='view/admin-ts/src/api/userDirectory.ts').map(call=>[call.method,call.path,call.line,call.matchedHandler])).toEqual([['GET','/user/list',48,'AdminCrud.adminUserList'],['GET','/user/filter_options',51,'AdminCrud.adminUserOptions'],['GET','/user/filter_regions',59,'AdminCrud.adminUserRegions']]);
  const rows=actual.backend.registeredRoutes.filter(route=>/\/user\/filter_(options|regions)$/u.test(route.path));expect(rows.map(row=>[row.method,row.path,row.handler])).toEqual([['GET','/user/filter_options','AdminCrud.adminUserOptions'],['GET','/user/filter_regions','AdminCrud.adminUserRegions'],['GET','/api/admin/user/filter_options','AdminCrud.adminUserOptions'],['GET','/api/admin/user/filter_regions','AdminCrud.adminUserRegions']]);
  expect(actual.calls.filter(call=>call.source==='view/admin-ts/src/api/order.ts').map(call=>[call.method,call.path,call.matchedHandler])).toEqual(before.calls.filter(call=>call.source==='view/admin-ts/src/api/order.ts').map(call=>[call.method,call.path,call.matchedHandler]));expect(actual.unregistered).toEqual([]);expect(actual.unresolved).toEqual([]);
  expect(p.operations.filter(op=>op.kind==='line-shift').map(op=>({index:op.index,count:op.count,delta:op.delta}))).toEqual([{index:296,count:652,delta:2},{index:1146,count:527,delta:2}]);expect(Buffer.byteLength(JSON.stringify(before,null,2)+'\n')).toBe(p.before_bytes);expect(Buffer.byteLength(JSON.stringify(actual,null,2)+'\n')).toBe(p.after_bytes);
 });
 it('enters every prior complete image/expiry/report proof only after this exact inverse',()=>{const original=reverseAdminUserFilterReport(buildAdminFrontendApiAuditReport());expect(assertCommerceImagePreviewReport(original)).toBe(original);expect(assertCommercePreviewExpiryReport(original)).toBe(original);expect(assertCommunityPreviewRefreshReport(original)).toBe(original);expect(original).toEqual(previous());});
 it.each(['count','route','call','source','backend','methodology','extra'] as const)('rejects unrelated complete report mutation %s in either direction',kind=>{
  for(const direction of ['before','after']){const input=direction==='before'?previous():buildAdminFrontendApiAuditReport();if(kind==='count')input.counts.registered++;if(kind==='route')input.backend.registeredRoutes[0].handler='unknown';if(kind==='call')input.calls[0].line++;if(kind==='source')input.frontendSources[0].sha256='0'.repeat(64);if(kind==='backend')input.backend.sha256='0'.repeat(64);if(kind==='methodology')input.methodology.scope='unreviewed';if(kind==='extra')Object.assign(input,{unreviewed:true});expect(()=>direction==='before'?applyAdminUserFilterReport(input):reverseAdminUserFilterReport(input)).toThrow();}
 });
 it.each(['missing','duplicate','order','shift-bound','shift-hash','rows','path','input-hash','output-hash'] as const)('rejects forged report operation %s',kind=>{
  const binding=structuredClone(proof),p=binding.api_report;if(kind==='missing')p.operations.pop();if(kind==='duplicate')p.operations.push(structuredClone(p.operations[0]!));if(kind==='order')p.operations.reverse();if(kind==='shift-bound'){const op=p.operations.find(value=>value.kind==='line-shift')!;op.count++;}if(kind==='shift-hash'){const op=p.operations.find(value=>value.kind==='line-shift')!;op.before_sha256='0'.repeat(64);}if(kind==='rows'){const op=p.operations.find(value=>value.kind==='splice')!;op.after=[];}if(kind==='path')p.operations[0]!.path=['unreviewed'];if(kind==='input-hash')p.before_sha256='0'.repeat(64);if(kind==='output-hash')p.after_sha256='0'.repeat(64);expect(()=>applyAdminUserFilterReport(previous(),binding)).toThrow();expect(()=>reverseAdminUserFilterReport(buildAdminFrontendApiAuditReport(),binding)).toThrow();
 });
 it.each([[0,'adminapiRoutes','/user/'],[1,'v1Routes','/admin/user/']] as const)('binds real authenticated directory route calls and rejects handler/gate drift %s',(index,router,prefix)=>{
  const live=read(files[index]!);expect(directoryRoutes(live,router,prefix)).toEqual(routeContract(prefix));const actual=router+'.get("'+prefix+'filter_options", adminAuth, AdminCrud.adminUserOptions);';expect(live).toContain(actual);
  for(const replacement of [actual.replace('adminAuth, ',''),actual.replace('adminUserOptions','adminUserList'),actual.replace('.get(','.post('),actual+'\n'+actual])expect(directoryRoutes(live.replace(actual,replacement),router,prefix)).not.toEqual(routeContract(prefix));
 });
 it('binds actual request paths and AbortSignal transport without adding any write call or changing the legacy balance DTO',()=>{
  const current=apiRequests(read('view/admin-ts/src/api/userDirectory.ts'));expect(current).toEqual([{method:'get',path:'/user/list',options:'{ params: query, signal }'},{method:'get',path:'/user/filter_options',options:'{ params: query, signal }'},{method:'get',path:'/user/filter_regions',options:'{ params: { pid }, signal }'}]);
  const old=reverseAdminUserFilterSource(files[3]!,read(files[3]!)),live=read(files[3]!);const call=(source:string)=>{const tree=ast(source);return nodes(tree,ts.isCallExpression).find(node=>ts.isPropertyAccessExpression(node.expression)&&node.expression.expression.getText(tree)==='request'&&node.expression.name.text==='post'&&node.arguments[0]?.getText(tree).includes('/user/update_other/'))!;};
  const a=call(old),b=call(live);expect(a.arguments[1]!.getText()).toBe(b.arguments[1]!.getText());expect(b.arguments[2]!.getText()).toContain('signal,');expect(b.arguments[2]!.getText()).toContain('"Idempotency-Key": crypto.randomUUID()');expect(apiRequests(read('view/admin-ts/src/api/userDirectory.ts').replace("request.get('/user/list'","request.post('/user/list'"))).not.toEqual(current);
 });
});
