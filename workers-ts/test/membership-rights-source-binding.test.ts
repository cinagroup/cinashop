import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readMembershipCardActivationHistoricalFile as readFileSync, peelMembershipCardActivationLegacyRules } from './helpers/membershipCardActivationSourceBinding';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from '../scripts/admin-frontend-api-audit';
import { applyEditorialAuthorReport } from './helpers/diyEditorialAuthorSourceBinding';
import { applyCommerceAuthorReport } from './helpers/diyCommerceAuthorSourceBinding';
import { applyCommunityAuthorReport } from './helpers/diyCommunityAuthorSourceBinding';
import { applyAdminUserFilterReport, adminUserFilterSourceBinding as filterProof } from './helpers/adminUserFilterSourceBinding';
import { applyMigrationAuditReport, reverseMigrationAuditReport } from './helpers/migrationAuditFollowupSourceBinding';
import { applyAdminLevelDefinitionReport, reverseAdminLevelDefinitionReport } from './helpers/adminLevelDefinitionSourceBinding';
import { growthRecordsManifest, reverseGrowthRecordsManifest } from './helpers/customerGrowthRecordsManifest';
import { pointsCentreManifest, reversePointsCentreManifest } from './helpers/customerPointsCentreManifest';
import { signCentreManifest, reverseSignCentreManifest } from './helpers/customerSignCentreManifest';
import { reverseRouteSourceFollowup } from './helpers/routeSourceIncrement';
import { membershipRightsSourceBinding as proof, applyMembershipRightsReport, reverseMembershipRightsReport,
  peelMembershipRightsReport, reverseMembershipRightsSource, reverseMembershipRightsHarnessSource,
  reverseMembershipRightsManifest, reverseMembershipRightsRegisteredRoutes, reverseMembershipRightsLegacyRules,
  readMembershipRightsHistoricalFile } from './helpers/membershipRightsSourceBinding';
import { REGISTERED_PAGE_ROUTES as clientRoutes, LEGACY_ROUTE_RULES as activationClientRules, resolveRegisteredPageRoute as clientResolve } from '../../view/uniapp-ts/src/config/navigation';
import { REGISTERED_PAGE_ROUTES as serverRoutes, LEGACY_ROUTE_RULES as activationServerRules, resolveRegisteredPageRoute as serverResolve } from '../src/services/content/FabRouteRegistry';

const clientRules=peelMembershipCardActivationLegacyRules(activationClientRules),serverRules=peelMembershipCardActivationLegacyRules(activationServerRules);

const root=resolve(import.meta.dirname,'../..');
const read=(file:string)=>readFileSync(resolve(root,file),'utf8');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const pretty=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const blob=(source:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
const apiFile='view/admin-ts/src/api/membershipRights.ts',manifestFile='view/uniapp-ts/src/pages.json';
const navFiles=['view/uniapp-ts/src/config/navigation.ts','workers-ts/src/services/content/FabRouteRegistry.ts'];
const sourceFiles=[apiFile,manifestFile,...navFiles,'workers-ts/src/services/content/UserCenterPublicReadService.ts'];
const harnessFiles=['workers-ts/test/helpers/adminLevelDefinitionSourceBinding.ts','workers-ts/test/admin-level-definition-source-binding.test.ts',
  ...['customer-growth-records-migration','customer-points-centre-migration','customer-sign-centre-migration','uniapp-frontend-parity','community-main-feed-frontend','community-publish-entry-migration'].map(name=>`workers-ts/test/${name}.test.ts`)];
const beforeFilter=()=>applyAdminUserFilterReport(applyCommunityAuthorReport(applyCommerceAuthorReport(applyEditorialAuthorReport(JSON.parse(read(filterProof.api_report.base_file))))));
const historical=()=>applyAdminLevelDefinitionReport(applyMigrationAuditReport(beforeFilter()));
let report:ReturnType<typeof buildAdminFrontendApiAuditReport>|undefined;
const current=()=>structuredClone(report??=buildAdminFrontendApiAuditReport());

/** Parse literal AST data without executing reconstructed source or requiring Git history in CI. */
function literal(node:ts.Expression,bindings:ReadonlyMap<string,ts.Expression>,active:ReadonlySet<string>=new Set()):unknown {
  if(ts.isAsExpression(node)||ts.isParenthesizedExpression(node))return literal(node.expression,bindings,active);
  if(ts.isStringLiteral(node))return node.text;
  if(ts.isIdentifier(node)){
    const initializer=bindings.get(node.text);
    if(!initializer||active.has(node.text))throw Error('Expected an acyclic local literal constant');
    return literal(initializer,bindings,new Set([...active,node.text]));
  }
  if(ts.isArrayLiteralExpression(node))return node.elements.map(item=>literal(item as ts.Expression,bindings,active));
  if(ts.isObjectLiteralExpression(node))return Object.fromEntries(node.properties.map(item=>{
    if(!ts.isPropertyAssignment(item)||!item.name||(!ts.isStringLiteral(item.name)&&!ts.isIdentifier(item.name)))throw Error('Expected exact literal property');
    return[item.name.text,literal(item.initializer,bindings,active)];
  }));
  throw Error('Expected exact literal source');
}
function navigation(source:string):{routes:string[];rules:typeof clientRules} {
  const tree=ts.createSourceFile('registry.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  let routes:string[]|undefined,rules:typeof clientRules|undefined;
  const bindings=new Map<string,ts.Expression>();
  for(const statement of tree.statements)if(ts.isVariableStatement(statement)&&(statement.declarationList.flags&ts.NodeFlags.Const)){
    for(const decl of statement.declarationList.declarations)if(ts.isIdentifier(decl.name)&&decl.initializer)bindings.set(decl.name.text,decl.initializer);
  }
  for(const statement of tree.statements)if(ts.isVariableStatement(statement))for(const decl of statement.declarationList.declarations){
    if(!ts.isIdentifier(decl.name)||!decl.initializer)continue;
    if(decl.name.text==='REGISTERED_PAGE_ROUTES'){
      const init=decl.initializer;if(!ts.isNewExpression(init)||init.expression.getText(tree)!=='Set'||init.arguments?.length!==1)throw Error('Expected exact registered Set');
      routes=literal(init.arguments[0]!,bindings) as string[];
    }
    if(decl.name.text==='LEGACY_ROUTE_RULES')rules=literal(decl.initializer,bindings) as typeof clientRules;
  }
  if(!routes||!rules)throw Error('Missing literal navigation inventory');return{routes,rules};
}
function apiCalls(source:string){
  const tree=ts.createSourceFile('membershipRights.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const found:Array<{method:string;path:string;line:number;arguments:number}>=[];
  function visit(node:ts.Node):void {
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.expression.getText(tree)==='request'){
      const first=node.arguments[0];found.push({method:node.expression.name.text,path:first&&ts.isStringLiteral(first)?first.text:first?.getText(tree)??'',line:tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1,arguments:node.arguments.length});
    }
    ts.forEachChild(node,visit);
  }
  visit(tree);return found;
}

describe('exact PHP membership-rights authoring, public page and historical audit increment',()=>{
  it('pins independent predecessor bytes, five real whole-source patches and all immutable dated evidence',()=>{
    expect(sha(read('workers-ts/test/fixtures/membership-rights-source-binding-20261026.json'))).toBe('9d00ae1986e1669e7c19d5ba87642018e9f5debbafb5e0a07bd25f1ebcbba5ab');
    expect(proof.schema).toBe('cinashop.membership-rights-source-binding.v1');
    expect(proof.base_ref).toBe('547b055c9b9e9748a6acb0a81539cc34aae3d2cc');expect(proof.php_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
    expect(proof.sources.map(row=>row.file)).toEqual(sourceFiles);expect(proof.sources.map(row=>row.edits.length)).toEqual([1,1,2,2,1]);
    expect(proof.sources.map(row=>row.before_exists)).toEqual([false,true,true,true,true]);
    expect(proof.sources[0]!.before_bytes).toBe(0);expect(proof.sources[0]!.before_git_blob_sha1).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(proof.sources[0]!.after_sha256).toBe('306019433610c8b1b4c00e78ba93c40ce3f7d2574de359b260792b412cf7314e');
    for(const entry of [...proof.sources,...proof.harness_sources]){
      const actual=read(entry.file),reverse=proof.sources.includes(entry)?reverseMembershipRightsSource:reverseMembershipRightsHarnessSource;
      const before=reverse(entry.file,actual);
      expect(sha(actual),entry.file).toBe(entry.after_sha256);expect(Buffer.byteLength(actual)).toBe(entry.after_bytes);expect(blob(actual)).toBe(entry.after_git_blob_sha1);
      expect(sha(before)).toBe(entry.before_sha256);expect(Buffer.byteLength(before)).toBe(entry.before_bytes);expect(blob(before)).toBe(entry.before_git_blob_sha1);
      let rebuilt=before;for(const edit of entry.edits)rebuilt=rebuilt.replace(edit.before_source,edit.after_source);expect(rebuilt).toBe(actual);
    }
    expect(proof.harness_sources.map(row=>row.file)).toEqual(harnessFiles);expect(proof.harness_sources.map(row=>row.edits.length)).toEqual([2,2,2,1,1,1,1,1]);
    const patch=proof.production_patch;
    expect(sha(patch.unified_diff)).toBe(patch.sha256);expect(Buffer.byteLength(patch.unified_diff)).toBe(patch.bytes);expect(patch.unified_diff.match(/^diff --git /gm)).toHaveLength(5);
    for(const entry of proof.sources){expect(patch.unified_diff).toContain(entry.file);expect(patch.unified_diff).toContain(entry.after_git_blob_sha1);if(entry.before_exists)expect(patch.unified_diff).toContain(entry.before_git_blob_sha1);}
    expect(proof.preserved_files).toHaveLength(21);
    for(const entry of proof.preserved_files){const actual=read(entry.file);expect(sha(actual),entry.file).toBe(entry.sha256);expect(Buffer.byteLength(actual)).toBe(entry.bytes);}
    expect(reverseMembershipRightsSource('unrelated.ts','// unchanged\n')).toBe('// unchanged\n');
    expect(reverseMembershipRightsHarnessSource('unrelated.ts','// unchanged\n')).toBe('// unchanged\n');
  });

  it('parses all four actual Admin requests and independently recomputes the complete 711-call report',()=>{
    expect(apiCalls(read(apiFile))).toEqual([
      {method:'get',path:'/member/right',line:47,arguments:2},
      {method:'post',path:'`/member_right/save/${id}`',line:50,arguments:3},
      {method:'post',path:'`/member_right/save/${id}`',line:53,arguments:3},
      {method:'post',path:'`/member/save/content/${id}`',line:56,arguments:3},
    ]);
    const before=historical(),actual=current(),p=proof.api_report;
    expect(sha(pretty(before))).toBe('022080855cf8133954840763e47742110b84ef1800c0db64d5b59151a61fdab7');expect(Buffer.byteLength(pretty(before))).toBe(644498);
    expect(sha(pretty(actual))).toBe('1ac108158879d83daae4f0d5a70e137db210e23a33040f10a577dada2419bff0');expect(Buffer.byteLength(pretty(actual))).toBe(645939);
    expect(p.operations.map(row=>[row.kind,row.path])).toEqual([
      ['splice',['frontendSources']],['replace',['counts','callSites']],['replace',['counts','pathVariants']],['replace',['counts','registered']],['replace',['counts','executable']],['splice',['calls']],
    ]);
    expect(p.operations[0]).toMatchObject({index:47,before:[],after:[{file:apiFile,sha256:proof.sources[0]!.after_sha256}]});
    expect(p.operations[5]).toMatchObject({index:326,before:[],after:actual.calls.slice(326,330)});
    expect(actual.counts).toEqual({callSites:711,pathVariants:749,registered:749,executable:749,controlledUnavailable:0,unregistered:0,unresolved:0});
    expect(actual.frontendSources).toHaveLength(108);expect(actual.backend.registeredRoutes).toHaveLength(1677);expect(actual.backend).toEqual(before.backend);expect(actual.methodology).toEqual(before.methodology);
    expect(actual.calls.slice(0,326)).toEqual(before.calls.slice(0,326));expect(actual.calls.slice(330)).toEqual(before.calls.slice(326));
    expect(actual.calls.slice(326,330).map(row=>[row.method,row.path,row.matchedHandler,row.availability])).toEqual([
      ['GET','/member/right','AdminPaidMembership.rights','executable'],['POST','/member_right/save/:param','AdminPaidMembership.saveRight','executable'],
      ['POST','/member_right/save/:param','AdminPaidMembership.saveRight','executable'],['POST','/member/save/content/:param','AdminPaidMembership.saveRightContent','executable'],
    ]);
    expect(applyMembershipRightsReport(before)).toEqual(actual);expect(reverseMembershipRightsReport(actual)).toEqual(before);
    expect(applyMembershipRightsReport(reverseMembershipRightsReport(actual))).toEqual(actual);expect(peelMembershipRightsReport(before)).toEqual(before);expect(peelMembershipRightsReport(actual)).toEqual(before);
    // The old level apply still emits the old complete report; both live reverse callers peel this increment first.
    expect(sha(pretty(applyAdminLevelDefinitionReport(applyMigrationAuditReport(beforeFilter()))))).toBe(p.before_sha256);
    expect(reverseAdminLevelDefinitionReport(actual)).toEqual(reverseAdminLevelDefinitionReport(before));expect(reverseMigrationAuditReport(actual)).toEqual(beforeFilter());
  });

  it('reads the actual 142 pages and exact native route/alias inventories before restoring 141→140→139→138 and dated footer hashes',()=>{
    const actual=read(manifestFile),pages=JSON.parse(actual).pages as Array<{path:string}>;
    expect(pages).toHaveLength(142);expect(pages.filter(row=>row.path==='pages/user/vipRights').map(row=>row.path)).toEqual(['pages/user/vipRights']);
    expect(existsSync(resolve(root,'view/uniapp-ts/src/pages/user/vipRights.vue'))).toBe(true);
    const registered=pages.map(row=>'/'+row.path).sort();expect(new Set(registered).size).toBe(142);
    expect([...clientRoutes].sort()).toEqual(registered);expect([...serverRoutes].sort()).toEqual(registered);expect(clientRules).toEqual(serverRules);
    for(const file of navFiles){
      const now=navigation(read(file)),before=navigation(reverseMembershipRightsSource(file,read(file)));
      expect(now.routes).toEqual([...clientRoutes]);expect(now.rules).toEqual(clientRules);
      expect([...reverseMembershipRightsRegisteredRoutes(new Set(now.routes))].sort()).toEqual(before.routes.slice().sort());
      expect(reverseMembershipRightsLegacyRules(now.rules)).toEqual(before.rules);
      expect(now.routes.filter(path=>!before.routes.includes(path))).toEqual([proof.navigation.route]);
      expect(before.rules[proof.navigation.key]).toEqual({target:'/pages/user/vipOpen',coverage:'candidate_covered'});
      expect(now.rules[proof.navigation.key]).toEqual({target:'/pages/user/vipRights',coverage:'candidate_covered'});
      expect(sha(JSON.stringify(before.rules))).toBe('2e5c93836a205f0cab21000bf02e4b445a69d043873d0e00885371a6f4f44668');
    }
    expect(clientResolve(proof.navigation.key,'id=3')).toBe('/pages/user/vipRights?id=3');expect(serverResolve(proof.navigation.key,'id=3')).toBe('/pages/user/vipRights?id=3');
    const m141=reverseMembershipRightsManifest(actual);expect(sha(m141)).toBe(growthRecordsManifest.after_sha256);expect(JSON.parse(m141).pages).toHaveLength(141);
    const m140=reverseGrowthRecordsManifest(m141);expect(sha(m140)).toBe(pointsCentreManifest.after_sha256);expect(JSON.parse(m140).pages).toHaveLength(140);
    const m139=reversePointsCentreManifest(m140);expect(sha(m139)).toBe(signCentreManifest.after_sha256);expect(JSON.parse(m139).pages).toHaveLength(139);
    const m138=reverseSignCentreManifest(m139);expect(sha(m138)).toBe(signCentreManifest.before_sha256);expect(JSON.parse(m138).pages).toHaveLength(138);
    const footer=JSON.parse(read('workers-ts/audit/diy-footer-source-binding-20261022.json')) as {sources:Array<{file:string;before_sha256:string;after_sha256:string;edits:Array<{before_source:string;after_source:string;before_line:number;after_line:number}>}>};
    const footerProof=footer.sources.find(row=>row.file===manifestFile)!;expect(sha(m138)).toBe(footerProof.after_sha256);expect(sha(reverseRouteSourceFollowup(m138,footerProof))).toBe(footerProof.before_sha256);
    expect(readMembershipRightsHistoricalFile(resolve(root,manifestFile),'utf8')).toBe(m141);
    expect(readMembershipRightsHistoricalFile(resolve(root,manifestFile))).toEqual(Buffer.from(m141));
    const preserved=proof.preserved_files[0]!.file;expect(readMembershipRightsHistoricalFile(resolve(root,preserved))).toEqual(readFileSync(resolve(root,preserved)));
  });

  for(const file of [...sourceFiles,...harnessFiles])it.each(['extra','missing','duplicate','newline','same-length','old'] as const)('rejects unreviewed whole-source %s in '+file,kind=>{
    const harness=harnessFiles.includes(file),reverse=harness?reverseMembershipRightsHarnessSource:reverseMembershipRightsSource;
    const entry=(harness?proof.harness_sources:proof.sources).find(row=>row.file===file)!,source=read(file);let changed=source;
    if(kind==='extra')changed+='\n// unreviewed\n';if(kind==='missing')changed=changed.replace(entry.edits[0]!.after_source,'');if(kind==='duplicate')changed+=entry.edits[0]!.after_source;
    if(kind==='newline')changed=changed.replace('\n','\r\n');if(kind==='same-length')changed=changed.replace('a','z');if(kind==='old')changed=reverse(file,source);
    expect(changed).not.toBe(source);expect(()=>reverse(file,changed)).toThrow();
  });

  it.each(['count','source','route','methodology','line','handler','missing','duplicate','extra'] as const)('rejects unrelated complete-report %s in both exact states',kind=>{
    for(const direction of ['before','after'] as const){const value=direction==='before'?historical():current();
      if(kind==='count')value.counts.registered++;if(kind==='source')value.frontendSources[0]!.sha256='0'.repeat(64);if(kind==='route')value.backend.registeredRoutes[0]!.handler='unreviewed';
      if(kind==='methodology')value.methodology.scope='unreviewed';if(kind==='line')value.calls[326]!.line++;if(kind==='handler')value.calls[326]!.matchedHandler='unreviewed';
      if(kind==='missing')value.calls.splice(326,1);if(kind==='duplicate')value.calls.splice(326,0,structuredClone(value.calls[326]!));if(kind==='extra')Object.assign(value,{unreviewed:true});
      expect(()=>peelMembershipRightsReport(value)).toThrow();expect(()=>reverseAdminLevelDefinitionReport(value)).toThrow();expect(()=>reverseMigrationAuditReport(value)).toThrow();
      expect(()=>direction==='before'?applyMembershipRightsReport(value):reverseMembershipRightsReport(value)).toThrow();
    }
  });

  it.each(['source-order','source-missing','source-file','source-hash','source-bytes','source-line','source-literal','harness-hash','operation-order','operation-missing','operation-path','operation-splice','operation-rows','report-hash','report-bytes','base','patch','preserved','navigation','extra'] as const)('rejects forged exact inventory %s',kind=>{
    const binding=structuredClone(proof);
    if(kind==='source-order')binding.sources.reverse();if(kind==='source-missing')binding.sources.pop();if(kind==='source-file')binding.sources[0]!.file='unknown.ts';if(kind==='source-hash')binding.sources[0]!.before_sha256='0'.repeat(64);
    if(kind==='source-bytes')binding.sources[0]!.after_bytes++;if(kind==='source-line')binding.sources[0]!.edits[0]!.after_line++;if(kind==='source-literal')binding.sources[0]!.edits[0]!.before_source+='// unreviewed';
    if(kind==='harness-hash')binding.harness_sources[0]!.after_sha256='0'.repeat(64);if(kind==='operation-order')binding.api_report.operations.reverse();if(kind==='operation-missing')binding.api_report.operations.pop();if(kind==='operation-path')binding.api_report.operations[0]!.path=[];
    const splice=binding.api_report.operations[5];if(splice?.kind==='splice'){if(kind==='operation-splice')splice.index++;if(kind==='operation-rows')splice.after.pop();}
    if(kind==='report-hash')binding.api_report.after_sha256='0'.repeat(64);if(kind==='report-bytes')binding.api_report.before_bytes++;if(kind==='base')binding.base_ref='unknown';if(kind==='patch')binding.production_patch.unified_diff+='\n';
    if(kind==='preserved')binding.preserved_files.pop();if(kind==='navigation')binding.navigation.after_count++;if(kind==='extra')Object.assign(binding,{unknown:true});
    expect(()=>reverseMembershipRightsSource(apiFile,read(apiFile),binding)).toThrow();expect(()=>reverseMembershipRightsHarnessSource(harnessFiles[0]!,read(harnessFiles[0]!),binding)).toThrow();
    expect(()=>reverseMembershipRightsReport(current(),binding)).toThrow();expect(()=>reverseMembershipRightsRegisteredRoutes(clientRoutes,binding)).toThrow();expect(()=>reverseMembershipRightsLegacyRules(clientRules,binding)).toThrow();
  });

  it.each(['extra','missing','alias','unknown-field','old'] as const)('rejects unknown complete navigation inventories: %s',kind=>{
    const routes=new Set(clientRoutes),rules=structuredClone(clientRules) as Record<string,{target:string;coverage:string}>;
    if(kind==='extra')routes.add('/pages/unreviewed');if(kind==='missing')routes.delete('/pages/index/index');if(kind==='old')routes.delete(proof.navigation.route);
    if(kind==='alias')rules[proof.navigation.key]!.target='/pages/user/vipOpen';if(kind==='unknown-field')Object.assign(rules[proof.navigation.key]!,{unknown:true});
    if(['extra','missing','old'].includes(kind))expect(()=>reverseMembershipRightsRegisteredRoutes(routes)).toThrow();else expect(()=>reverseMembershipRightsLegacyRules(rules)).toThrow();
  });
});
