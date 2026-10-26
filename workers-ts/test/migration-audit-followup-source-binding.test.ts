import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from '../scripts/admin-frontend-api-audit';
import { applyEditorialAuthorReport } from './helpers/diyEditorialAuthorSourceBinding';
import { applyCommerceAuthorReport } from './helpers/diyCommerceAuthorSourceBinding';
import { applyCommunityAuthorReport } from './helpers/diyCommunityAuthorSourceBinding';
import { adminUserFilterSourceBinding as original, applyAdminUserFilterReport, reverseAdminUserFilterReport } from './helpers/adminUserFilterSourceBinding';
import { adminUserFilterTestHarnessSourceBinding as originalHarness } from './helpers/adminUserFilterTestHarnessSourceBinding';
import { migrationAuditFollowupSourceBinding as proof, reverseMigrationAuditSource, reverseMigrationAuditHarnessSource, reverseMigrationAuditReport, applyMigrationAuditReport } from './helpers/migrationAuditFollowupSourceBinding';
const root = resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const pretty = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
let builtReport: ReturnType<typeof buildAdminFrontendApiAuditReport> | undefined;
const currentReport = (): ReturnType<typeof buildAdminFrontendApiAuditReport> => structuredClone(builtReport ??= buildAdminFrontendApiAuditReport());
const historical = (): ReturnType<typeof buildAdminFrontendApiAuditReport> => applyAdminUserFilterReport(applyCommunityAuthorReport(applyCommerceAuthorReport(applyEditorialAuthorReport(JSON.parse(read(original.api_report.base_file))))));
const routeContracts = [
 ['get','/integral/list','UserFinanceReadController.integralList'], ['get','/extract/bank','UserFinanceReadController.extractBank'],
 ['post','/spread/order','UserFinanceReadController.spreadOrder'], ['get','/spread/count/:type','UserFinanceReadController.spreadCount'],
 ['get','/brokerage_rank','UserFinanceReadController.brokerageRank'], ['get','/rank','UserFinanceReadController.spreadRank'],
 ['post','/spread/people','UserFinanceController.spreadPeople'], ['get','/spread/commission/:type','UserFinanceController.commissionList'],
 ['get','/user/commission/list/:type','UserFinanceController.commissionItems'], ['post','/extract/cash','UserFinanceController.extractCash'],
];
function actualFinanceRoutes(source: string) {
 const tree = ts.createSourceFile('actual.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
 const result: Array<{method:string;path:string;station:boolean;auth:string;handler:string;line:number}> = [];
 function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(tree) === 'v1Routes'
    && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && routeContracts.some(row => row[1] === (node.arguments[0] as ts.StringLiteral).text)) {
   const station = node.arguments[1]; result.push({method:node.expression.name.text,path:node.arguments[0].text,
    station:!!station && ts.isCallExpression(station) && ts.isIdentifier(station.expression) && station.expression.text === 'stationOpenMiddleware' && station.arguments.length === 0,
    auth:node.arguments[2]?.getText(tree) ?? '',handler:node.arguments[3]?.getText(tree) ?? '',line:tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1});
  }
  ts.forEachChild(node, visit);
 }
 visit(tree);return result;
}
describe('precise followup of reviewed station factories and membership catalogue API history', () => {
 it('pins two complete production sources and restores the exact historical target with no sibling exemption', () => {
  expect(sha(read('workers-ts/test/fixtures/migration-audit-followup-source-binding-20261026.json'))).toBe('0ab82e48ec36dd39aaae6c00ee9ed7c4ae4a9850371e0d4d48c045846e6b1236');
  expect(proof.sources.map(row => row.file)).toEqual(['workers-ts/src/routes/v1/index.ts','view/admin-ts/src/api/membership.ts']);
  expect(proof.sources.map(row => row.edits.length)).toEqual([10,3]);
  for (const entry of proof.sources) {
   const actual = read(entry.file), before = reverseMigrationAuditSource(entry.file, actual);
   expect(sha(actual)).toBe(entry.after_sha256);expect(Buffer.byteLength(actual)).toBe(entry.after_bytes);
   expect(sha(before)).toBe(entry.before_sha256);expect(Buffer.byteLength(before)).toBe(entry.before_bytes);
   let restored = before;for(const edit of entry.edits) restored = restored.replace(edit.before_source,edit.after_source);expect(restored).toBe(actual);
  }
  expect(proof.sources[0]!.before_sha256).toBe(original.sources.find(row => row.file === proof.sources[0]!.file)!.after_sha256);
  expect(reverseMigrationAuditSource('unrelated.ts','// opaque\n')).toBe('// opaque\n');
 });
 it('restores only the changed test helper for the existing immutable harness contract and preserves every older proof byte', () => {
  expect(proof.harness_sources).toHaveLength(1);const entry = proof.harness_sources[0]!;
  expect(entry.file).toBe('workers-ts/test/helpers/adminUserFilterSourceBinding.ts');
  const before = reverseMigrationAuditHarnessSource(entry.file,read(entry.file)), old = originalHarness.unchanged_contract_files.find(row => row.file === entry.file)!;
  expect(sha(before)).toBe(old.sha256);expect(Buffer.byteLength(before)).toBe(old.bytes);expect(entry.before_sha256).toBe('9dfff7cc75d18dde638f012a737f5655423cf2b347ed272888373b70fb882cae');expect(entry.before_bytes).toBe(6796);
  expect(proof.preserved_files).toHaveLength(83);for(const row of proof.preserved_files){const source=read(row.file);expect(sha(source),row.file).toBe(row.sha256);expect(Buffer.byteLength(source),row.file).toBe(row.bytes);}
  for(const row of original.preserved_files)expect(proof.preserved_files).toContainEqual(row);
  expect(reverseMigrationAuditHarnessSource('unrelated.ts','// opaque\n')).toBe('// opaque\n');
 });
 it('proves current real factory invocation and unchanged auth/handler/path/method contracts independently with AST controls', () => {
  const source = read(proof.sources[0]!.file), expected = routeContracts.map((row,index)=>({method:row[0],path:row[1],station:true,auth:'authMiddleware({ force: true })',handler:row[2],line:933+index}));
  expect(actualFinanceRoutes(source)).toEqual(expected);
  for(const changed of [source.replace('"/integral/list", stationOpenMiddleware(),','"/integral/list", stationOpenMiddleware,'),source.replace('"/integral/list", stationOpenMiddleware(),','"/integral/list", stationOpenMiddleware(1),'),source.replace('"/integral/list",','"/integral/list-unreviewed",'),source.replace('UserFinanceReadController.integralList);','UserFinanceReadController.extractBank);')]){expect(changed).not.toBe(source);expect(actualFinanceRoutes(changed)).not.toEqual(expected);}
  const api = read(proof.sources[1]!.file);expect(api).toContain('"/member/ship", { params, signal }');
 });
 it('recomputes the complete real report and bridges only eleven exact scalar changes without altering any API contract or old apply output', () => {
  const before=historical(),actual=currentReport();
  expect(sha(pretty(before))).toBe('a99c42f5be30da197bc127a2489a67a3c13cc226246de3279160aa3f18362ab8');
  expect(sha(pretty(actual))).toBe('0d9bc7d912efd02d8ff5efdafc8bb4b7d7a79962905684d861724d7273d6ea7f');
  expect(pretty(before).length).toBeGreaterThan(0);expect(Buffer.byteLength(pretty(before))).toBe(644215);expect(Buffer.byteLength(pretty(actual))).toBe(644215);
  expect(reverseMigrationAuditReport(actual)).toEqual(before);expect(applyMigrationAuditReport(before)).toEqual(actual);
  expect(applyMigrationAuditReport(reverseMigrationAuditReport(actual))).toEqual(actual);expect(reverseMigrationAuditReport(applyMigrationAuditReport(before))).toEqual(before);
  expect(actual.counts).toEqual(before.counts);expect(actual.counts).toEqual({callSites:706,pathVariants:744,registered:744,executable:744,controlledUnavailable:0,unregistered:0,unresolved:0});
  expect(actual.frontendSources).toHaveLength(107);expect(actual.backend.registeredRoutes).toHaveLength(1677);expect(actual.backend.registeredRoutes).toEqual(before.backend.registeredRoutes);expect(actual.backend.sha256).toBe(before.backend.sha256);
  expect(actual.calls.map(({line: _line,...row})=>row)).toEqual(before.calls.map(({line: _line,...row})=>row));
  const shifted=actual.calls.flatMap((row,index)=>row.line===before.calls[index]!.line?[]:[{index,source:row.source,before:before.calls[index]!.line,after:row.line}]);
  expect(shifted).toEqual([216,226,235,293,303,321,326,334,346].map((line,index)=>({index:316+index,source:'view/admin-ts/src/api/membership.ts',before:line,after:line+4})));
  expect(proof.api_report.operations.map(row=>row.path)).toEqual([['backend','rootRouteSources',2,'sha256'],['frontendSources',46,'sha256'],...Array.from({length:9},(_,index)=>['calls',316+index,'line'])]);
  expect(reverseAdminUserFilterReport(actual)).toEqual(applyCommunityAuthorReport(applyCommerceAuthorReport(applyEditorialAuthorReport(JSON.parse(read(original.api_report.base_file))))));
  expect(sha(pretty(historical()))).toBe(original.api_report.after_sha256);
 });
 for(const family of ['sources','harness_sources'] as const)for(const index of family==='sources'?[0,1]:[0])it.each(['extra','duplicate','missing','old','newline','same-length','before-hash','after-hash','before-bytes','after-bytes','before-line','after-line','literal','file','order'] as const)('rejects '+family+'['+index+'] unreviewed %s',kind=>{
  const binding=structuredClone(proof),entry=binding[family][index]!,live=read(entry.file);let source=live;
  if(kind==='extra')source+='\n// unrelated\n';if(kind==='duplicate')source+=entry.edits[0]!.after_source;if(kind==='missing')source=source.replace(entry.edits[0]!.after_source,'');if(kind==='old')source=(family==='sources'?reverseMigrationAuditSource:reverseMigrationAuditHarnessSource)(entry.file,source);if(kind==='newline')source=source.replace(/\n/u,'\r\n');if(kind==='same-length')source=source.replace(/a/u,'z');
  if(kind==='before-hash')entry.before_sha256='0'.repeat(64);if(kind==='after-hash')entry.after_sha256='0'.repeat(64);if(kind==='before-bytes')entry.before_bytes++;if(kind==='after-bytes')entry.after_bytes++;if(kind==='before-line')entry.edits[0]!.before_line!++;if(kind==='after-line')entry.edits[0]!.after_line++;if(kind==='literal')entry.edits[0]!.before_source+='// unreviewed';if(kind==='file')entry.file='unknown.ts';if(kind==='order')entry.edits.reverse();
  if(['extra','duplicate','missing','old','newline','same-length'].includes(kind))expect(source).not.toBe(live);
  expect(()=>(family==='sources'?reverseMigrationAuditSource:reverseMigrationAuditHarnessSource)(proof[family][index]!.file,source,binding)).toThrow();
 });
 it.each(['count','route','call','path','source','methodology','extra','line'] as const)('rejects unrelated complete report mutation in both directions %s',kind=>{
  for(const direction of ['before','after']){const input=direction==='before'?historical():currentReport();
   if(kind==='count')input.counts.registered++;if(kind==='route')input.backend.registeredRoutes[0]!.handler='unknown';if(kind==='call')input.calls[0]!.method='POST';if(kind==='path')input.calls[0]!.path='/unreviewed';if(kind==='source')input.frontendSources[0]!.sha256='0'.repeat(64);if(kind==='methodology')input.methodology.scope='unreviewed';if(kind==='extra')Object.assign(input,{unreviewed:true});if(kind==='line')input.calls[316]!.line++;
   expect(()=>direction==='before'?applyMigrationAuditReport(input):reverseMigrationAuditReport(input)).toThrow();
  }
 });
 it.each(['missing','duplicate','order','path','scalar','input-hash','output-hash','bytes','base','current','preserved'] as const)('rejects forged whole inventory or report operation %s',kind=>{
  const binding=structuredClone(proof);if(kind==='missing')binding.api_report.operations.pop();if(kind==='duplicate')binding.api_report.operations.push(structuredClone(binding.api_report.operations[0]!));if(kind==='order')binding.api_report.operations.reverse();if(kind==='path')binding.api_report.operations[0]!.path=[];if(kind==='scalar')binding.api_report.operations[0]!.after='unknown';if(kind==='input-hash')binding.api_report.before_sha256='0'.repeat(64);if(kind==='output-hash')binding.api_report.after_sha256='0'.repeat(64);if(kind==='bytes')binding.api_report.before_bytes++;if(kind==='base')binding.base_ref='unknown';if(kind==='current')binding.current_ref='unknown';if(kind==='preserved')binding.preserved_files.pop();
  expect(()=>applyMigrationAuditReport(historical(),binding)).toThrow();expect(()=>reverseMigrationAuditReport(currentReport(),binding)).toThrow();
 });
});
