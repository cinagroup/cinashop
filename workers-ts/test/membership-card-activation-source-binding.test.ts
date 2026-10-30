import { peelReviewedRouteTailReportForHistoricalAudit } from './helpers/reviewedRouteTailSourceBinding';
import { createHash } from 'node:crypto';
import { readMembershipCouponsHistoricalFile as readFileSync, peelMembershipCouponsRegisteredRoutesIfPresent, peelMembershipCouponsLegacyRulesIfPresent } from './helpers/membershipCouponsSourceBinding';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from './helpers/migrationMergeMainReport';
import { membershipCardActivationSourceBinding as proof, reverseMembershipCardActivationSource,
  reverseMembershipCardActivationHarnessSource, peelMembershipCardActivationSource,
  reverseMembershipCardActivationLegacyRules, peelMembershipCardActivationLegacyRules,
  readMembershipCardActivationHistoricalFile } from './helpers/membershipCardActivationSourceBinding';
import { membershipRightsSourceBinding as rights, reverseMembershipRightsSource, reverseMembershipRightsManifest,
  reverseMembershipRightsLegacyRules, applyMembershipRightsReport, reverseMembershipRightsReport } from './helpers/membershipRightsSourceBinding';
import { growthRecordsManifest, reverseGrowthRecordsManifest } from './helpers/customerGrowthRecordsManifest';
import { pointsCentreManifest, reversePointsCentreManifest } from './helpers/customerPointsCentreManifest';
import { signCentreManifest, reverseSignCentreManifest } from './helpers/customerSignCentreManifest';
import { reverseRouteSourceFollowup } from './helpers/routeSourceIncrement';
import { REGISTERED_PAGE_ROUTES as couponsClientRoutes, LEGACY_ROUTE_RULES as couponsClientRules, resolveRegisteredPageRoute as clientResolve } from '../../view/uniapp-ts/src/config/navigation';
import { REGISTERED_PAGE_ROUTES as couponsServerRoutes, LEGACY_ROUTE_RULES as couponsServerRules, resolveRegisteredPageRoute as serverResolve } from '../src/services/content/FabRouteRegistry';

const clientRoutes=peelMembershipCouponsRegisteredRoutesIfPresent(couponsClientRoutes),serverRoutes=peelMembershipCouponsRegisteredRoutesIfPresent(couponsServerRoutes);
const clientRules=peelMembershipCouponsLegacyRulesIfPresent(couponsClientRules),serverRules=peelMembershipCouponsLegacyRulesIfPresent(couponsServerRules);
const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>readFileSync(resolve(root,file),'utf8');
const sha=(source:string|Uint8Array)=>createHash('sha256').update(source).digest('hex');
const blob=(source:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
const pretty=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const sourceFiles=['view/uniapp-ts/src/pages.json','view/uniapp-ts/src/config/navigation.ts','workers-ts/src/services/content/FabRouteRegistry.ts','workers-ts/src/services/content/UserCenterPublicReadService.ts'];
const harnessFiles=['workers-ts/test/helpers/membershipRightsSourceBinding.ts','workers-ts/test/membership-rights-source-binding.test.ts'];
const manifestFile=sourceFiles[0]!,navFiles=sourceFiles.slice(1,3);
type Page={path:string;style?:Record<string,string>};
/** Read only literal declarations; never evaluate source or require old Git/PHP checkouts in CI. */
function literal(node:ts.Expression,bindings:ReadonlyMap<string,ts.Expression>,active:ReadonlySet<string>=new Set()):unknown {
  if(ts.isAsExpression(node)||ts.isParenthesizedExpression(node))return literal(node.expression,bindings,active);
  if(ts.isStringLiteral(node))return node.text;
  if(ts.isIdentifier(node)){
    const initializer=bindings.get(node.text);if(!initializer||active.has(node.text))throw Error('Expected acyclic local literal constant');
    return literal(initializer,bindings,new Set([...active,node.text]));
  }
  if(ts.isArrayLiteralExpression(node))return node.elements.map(item=>literal(item as ts.Expression,bindings,active));
  if(ts.isObjectLiteralExpression(node))return Object.fromEntries(node.properties.map(item=>{
    if(!ts.isPropertyAssignment(item)||(!ts.isStringLiteral(item.name)&&!ts.isIdentifier(item.name)))throw Error('Expected literal property');
    return[item.name.text,literal(item.initializer,bindings,active)];
  }));
  throw Error('Expected exact literal data');
}
function navigation(source:string):{routes:string[];rules:typeof clientRules} {
  const tree=ts.createSourceFile('navigation.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),bindings=new Map<string,ts.Expression>();
  for(const statement of tree.statements)if(ts.isVariableStatement(statement)&&(statement.declarationList.flags&ts.NodeFlags.Const))for(const declaration of statement.declarationList.declarations){
    if(ts.isIdentifier(declaration.name)&&declaration.initializer)bindings.set(declaration.name.text,declaration.initializer);
  }
  const init=bindings.get('REGISTERED_PAGE_ROUTES'),rules=bindings.get('LEGACY_ROUTE_RULES');
  if(!init||!rules||!ts.isNewExpression(init)||init.expression.getText(tree)!=='Set'||init.arguments?.length!==1)throw Error('Expected literal registered Set and rules');
  return{routes:literal(init.arguments[0]!,bindings) as string[],rules:literal(rules,bindings) as typeof clientRules};
}

describe('exact PHP membership-card activation navigation increment and immutable history',()=>{
  it('pins four complete production sources, two exact historical harness rewires and thirty preserved files',()=>{
    expect(sha(read('workers-ts/test/fixtures/membership-card-activation-source-binding-20261026.json'))).toBe('66383437d4f55f432b11211d4f85e31ce2fe713a291988e70c273d913bb8f09c');
    expect(sha(JSON.stringify(proof))).toBe('19b5412fb31ecd369e6ef7596ae28aae5b17455e83e538155b1895767c595eef');
    expect(proof.schema).toBe('cinashop.membership-card-activation-source-binding.v1');expect(proof.base_ref).toBe('d86de83238127ce4722b1e9f26fb220dbf116587');expect(proof.php_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
    expect(proof.sources.map(row=>row.file)).toEqual(sourceFiles);expect(proof.sources.map(row=>row.edits.length)).toEqual([1,1,1,1]);
    expect(proof.harness_sources.map(row=>row.file)).toEqual(harnessFiles);expect(proof.harness_sources.map(row=>row.edits.length)).toEqual([3,2]);
    for(const entry of [...proof.sources,...proof.harness_sources]){
      const actual=read(entry.file),reverse=sourceFiles.includes(entry.file)?reverseMembershipCardActivationSource:reverseMembershipCardActivationHarnessSource;
      expect(sha(actual),entry.file).toBe(entry.after_sha256);expect(Buffer.byteLength(actual)).toBe(entry.after_bytes);expect(blob(actual)).toBe(entry.after_git_blob_sha1);
      const before=reverse(entry.file,actual);expect(sha(before)).toBe(entry.before_sha256);expect(Buffer.byteLength(before)).toBe(entry.before_bytes);expect(blob(before)).toBe(entry.before_git_blob_sha1);expect(entry.before_ref).toBe(proof.base_ref);
      let rebuilt=before;for(const edit of entry.edits){expect(before.split(edit.before_source)).toHaveLength(2);expect(actual.split(edit.after_source)).toHaveLength(2);rebuilt=rebuilt.replace(edit.before_source,edit.after_source);}expect(rebuilt).toBe(actual);
      if(sourceFiles.includes(entry.file)){
        const prior=rights.sources.find(row=>row.file===entry.file)!;expect(entry.before_sha256).toBe(prior.after_sha256);expect(entry.before_git_blob_sha1).toBe(prior.after_git_blob_sha1);expect(entry.before_bytes).toBe(prior.after_bytes);
        expect(peelMembershipCardActivationSource(entry.file,actual)).toBe(before);expect(peelMembershipCardActivationSource(entry.file,before)).toBe(before);
        expect(()=>reverseMembershipCardActivationSource(entry.file,before)).toThrow();
        expect(reverseMembershipRightsSource(entry.file,actual)).toBe(reverseMembershipRightsSource(entry.file,before));
      }
    }
    expect(sha(proof.production_patch.unified_diff)).toBe(proof.production_patch.sha256);expect(Buffer.byteLength(proof.production_patch.unified_diff)).toBe(proof.production_patch.bytes);expect(proof.production_patch.unified_diff.match(/^diff --git /gm)).toHaveLength(4);
    for(const row of proof.sources){expect(proof.production_patch.unified_diff).toContain(row.file);expect(proof.production_patch.unified_diff).toContain(row.before_git_blob_sha1);expect(proof.production_patch.unified_diff).toContain(row.after_git_blob_sha1);}
    expect(proof.preserved_files).toHaveLength(30);expect(new Set(proof.preserved_files.map(row=>row.file)).size).toBe(30);
    for(const row of proof.preserved_files){expect(sha(read(row.file)),row.file).toBe(row.sha256);expect(Buffer.byteLength(read(row.file))).toBe(row.bytes);}
    expect(sha(read('workers-ts/test/fixtures/membership-rights-source-binding-20261026.json'))).toBe('9d00ae1986e1669e7c19d5ba87642018e9f5debbafb5e0a07bd25f1ebcbba5ab');
  });
  it('changes only the existing activation navbar style and retains the exact142→141→140→139→138 manifest chain',()=>{
    const actual=read(manifestFile),current=JSON.parse(actual) as {pages:Page[]},previous=JSON.parse(reverseMembershipCardActivationSource(manifestFile,actual)) as {pages:Page[]};
    expect(current.pages).toHaveLength(142);expect(previous.pages).toHaveLength(142);expect(proof.manifest.count).toBe(142);expect(proof.manifest.file).toBe(manifestFile);
    const before=previous.pages.find(page=>page.path===proof.manifest.route)!,after=current.pages.find(page=>page.path===proof.manifest.route)!;
    expect(before.style).toEqual({navigationBarTitleText:'会员卡激活'});expect(before.style).toEqual(proof.manifest.before_style);
    expect(after.style).toEqual({navigationBarTitleText:'会员卡激活',navigationBarBackgroundColor:'#F3ECE4',navigationBarTextStyle:'black'});expect(after.style).toEqual(proof.manifest.after_style);
    expect(current.pages).toEqual(previous.pages.map(page=>page.path===proof.manifest.route?{...page,style:after.style}:page));
    expect(sha(JSON.stringify(current.pages.map(page=>page.path).sort()))).toBe(proof.manifest.routes_sha256);
    expect([...clientRoutes].sort()).toEqual(current.pages.map(page=>'/'+page.path).sort());expect([...serverRoutes]).toEqual([...clientRoutes]);
    const m141=reverseMembershipRightsManifest(actual);expect(sha(m141)).toBe(growthRecordsManifest.after_sha256);expect(JSON.parse(m141).pages).toHaveLength(141);
    const m140=reverseGrowthRecordsManifest(m141);expect(sha(m140)).toBe(pointsCentreManifest.after_sha256);expect(JSON.parse(m140).pages).toHaveLength(140);
    const m139=reversePointsCentreManifest(m140);expect(sha(m139)).toBe(signCentreManifest.after_sha256);expect(JSON.parse(m139).pages).toHaveLength(139);
    const m138=reverseSignCentreManifest(m139),footer=JSON.parse(read('workers-ts/audit/diy-footer-source-binding-20261022.json')) as {sources:Array<{file:string;before_sha256:string;after_sha256:string;edits:Array<{before_source:string;after_source:string;before_line:number;after_line:number}>}>};
    const footerProof=footer.sources.find(row=>row.file===manifestFile)!;expect(sha(m138)).toBe(footerProof.after_sha256);expect(JSON.parse(m138).pages).toHaveLength(138);expect(sha(reverseRouteSourceFollowup(m138,footerProof))).toBe(footerProof.before_sha256);
  });
  it('parses both actual registries and changes one complete legacy rule while preserving all native routes and historical rules',()=>{
    expect(clientRules).toEqual(serverRules);expect(proof.navigation.key).toBe('/pages/annex/vip_paid_active/index');
    for(const file of navFiles){
      const actual=navigation(read(file)),previous=navigation(reverseMembershipCardActivationSource(file,read(file)));
      expect(actual.routes).toEqual(previous.routes);expect(actual.routes).toEqual([...clientRoutes]);expect(sha(JSON.stringify(actual.routes.slice().sort()))).toBe(proof.navigation.registered_routes_sha256);
      expect(actual.rules).toEqual(clientRules);expect(sha(JSON.stringify(actual.rules))).toBe(proof.navigation.after_rules_sha256);expect(sha(JSON.stringify(previous.rules))).toBe(proof.navigation.before_rules_sha256);expect(proof.navigation.before_rules_sha256).toBe(rights.navigation.after_rules_sha256);
      expect(previous.rules[proof.navigation.key]).toEqual({target:'/pages/user/vipOpen',coverage:'partial_replacement'});expect(actual.rules[proof.navigation.key]).toEqual({target:'/pages/annex/vip_active/index',coverage:'candidate_covered'});
      expect(actual.rules).toEqual({...previous.rules,[proof.navigation.key]:proof.navigation.after_rule});expect(reverseMembershipCardActivationLegacyRules(actual.rules)).toEqual(previous.rules);
      expect(peelMembershipCardActivationLegacyRules(actual.rules)).toEqual(previous.rules);expect(peelMembershipCardActivationLegacyRules(previous.rules)).toEqual(previous.rules);expect(()=>reverseMembershipCardActivationLegacyRules(previous.rules)).toThrow();
      expect(reverseMembershipRightsLegacyRules(actual.rules)).toEqual(reverseMembershipRightsLegacyRules(previous.rules));
    }
    for(const resolver of [clientResolve,serverResolve]){expect(resolver(proof.navigation.key)).toBe('/pages/annex/vip_active/index');expect(resolver(proof.navigation.key,'from=menu')).toBe('/pages/annex/vip_active/index?from=menu');expect(resolver('/pages/annex/vip_active/index')).toBe('/pages/annex/vip_active/index');expect(resolver('/pages/annex/vip_paid_rights/index')).toBe('/pages/user/vipRights');}
  });
  it('reconstructs the historical711-call complete Admin report from the exact reviewed current tail and retains original rights apply/reverse results',()=>{
    const historicalReport=peelReviewedRouteTailReportForHistoricalAudit(buildAdminFrontendApiAuditReport());expect(proof.admin_api_report).toEqual({sha256:'1ac108158879d83daae4f0d5a70e137db210e23a33040f10a577dada2419bff0',bytes:645939,calls:711,variants:749});
    expect(sha(pretty(historicalReport))).toBe(proof.admin_api_report.sha256);expect(Buffer.byteLength(pretty(historicalReport))).toBe(proof.admin_api_report.bytes);expect(historicalReport.counts).toEqual({callSites:711,pathVariants:749,registered:749,executable:749,controlledUnavailable:0,unregistered:0,unresolved:0});
    const before=reverseMembershipRightsReport(historicalReport);expect(sha(pretty(before))).toBe('022080855cf8133954840763e47742110b84ef1800c0db64d5b59151a61fdab7');expect(applyMembershipRightsReport(before)).toEqual(historicalReport);
  });
  it('keeps exact UTF8/Buffer historical reader semantics and unrelated files unchanged',()=>{
    for(const file of sourceFiles){const before=reverseMembershipCardActivationSource(file,read(file)),absolute=resolve(root,file);expect(readMembershipCardActivationHistoricalFile(absolute,'utf8')).toBe(before);expect(readMembershipCardActivationHistoricalFile(absolute)).toEqual(Buffer.from(before));expect(()=>readMembershipCardActivationHistoricalFile(absolute,'ascii')).toThrow();}
    const unrelated='workers-ts/test/fixtures/membership-rights-source-binding-20261026.json';expect(readMembershipCardActivationHistoricalFile(resolve(root,unrelated),'utf8')).toBe(read(unrelated));expect(reverseMembershipCardActivationSource('unrelated.ts','// untouched\n')).toBe('// untouched\n');expect(reverseMembershipCardActivationHarnessSource('unrelated.ts','// untouched\n')).toBe('// untouched\n');expect(peelMembershipCardActivationSource('unrelated.ts','// untouched\n')).toBe('// untouched\n');
  });
  it.each(sourceFiles.flatMap(file=>['append','crlf','neighbor','old-neighbor'].map(kind=>({file,kind}))))('rejects unknown complete source state $file $kind',({file,kind})=>{
    const actual=read(file),before=reverseMembershipCardActivationSource(file,actual),changed=kind==='append'?actual+'// unknown\n':kind==='crlf'?actual.replaceAll('\n','\r\n'):kind==='neighbor'?' '+actual:before+'// unknown predecessor\n';
    expect(()=>reverseMembershipCardActivationSource(file,changed)).toThrow();expect(()=>peelMembershipCardActivationSource(file,changed)).toThrow();expect(()=>reverseMembershipRightsSource(file,changed)).toThrow();
  });
  it.each(harnessFiles.flatMap(file=>['append','crlf','neighbor'].map(kind=>({file,kind}))))('rejects unknown historical harness $file $kind',({file,kind})=>{
    const actual=read(file),changed=kind==='append'?actual+'// unknown\n':kind==='crlf'?actual.replaceAll('\n','\r\n'):' '+actual;expect(()=>reverseMembershipCardActivationHarnessSource(file,changed)).toThrow();
  });
  it.each(['source-order','source-missing','source-hash','source-bytes','source-blob','source-line','source-context','harness-hash','rule-hash','rule-target','page-count','style','report-hash','preserved-hash'])('refuses altered exact fixture %s',kind=>{
    const binding=structuredClone(proof);
    if(kind==='source-order')binding.sources.reverse();if(kind==='source-missing')binding.sources.pop();if(kind==='source-hash')binding.sources[0]!.before_sha256='0'.repeat(64);if(kind==='source-bytes')binding.sources[0]!.after_bytes++;
    if(kind==='source-blob')binding.sources[0]!.after_git_blob_sha1='0'.repeat(40);if(kind==='source-line')binding.sources[0]!.edits[0]!.after_line++;if(kind==='source-context')binding.sources[0]!.edits[0]!.before_source+='// unknown';
    if(kind==='harness-hash')binding.harness_sources[0]!.after_sha256='0'.repeat(64);if(kind==='rule-hash')binding.navigation.after_rules_sha256='0'.repeat(64);if(kind==='rule-target')binding.navigation.after_rule.target='/pages/user/vipOpen';if(kind==='page-count')binding.manifest.count++;
    if(kind==='style')binding.manifest.after_style.navigationBarBackgroundColor='#fff';if(kind==='report-hash')binding.admin_api_report.sha256='0'.repeat(64);if(kind==='preserved-hash')binding.preserved_files[0]!.sha256='0'.repeat(64);
    expect(()=>reverseMembershipCardActivationSource(manifestFile,read(manifestFile),binding)).toThrow();expect(()=>reverseMembershipCardActivationHarnessSource(harnessFiles[0]!,read(harnessFiles[0]!),binding)).toThrow();expect(()=>peelMembershipCardActivationSource(manifestFile,read(manifestFile),binding)).toThrow();expect(()=>reverseMembershipCardActivationLegacyRules(clientRules,binding)).toThrow();expect(()=>peelMembershipCardActivationLegacyRules(clientRules,binding)).toThrow();
  });
  it.each(['extra','missing','neighbor','target','coverage'])('rejects unknown complete legacy rules %s',kind=>{
    const rules=structuredClone(clientRules) as Record<string,{target:string;coverage:string;queryAliases?:Readonly<Record<string,string>>}>;
    if(kind==='extra')rules['/pages/unknown/index']={target:'/pages/annex/vip_active/index',coverage:'candidate_covered'};if(kind==='missing')delete rules[proof.navigation.key];if(kind==='neighbor')rules['/pages/annex/vip_paid/index']!.target='/pages/user/vipRights';if(kind==='target')rules[proof.navigation.key]!.target='/pages/user/vipOpen';if(kind==='coverage')rules[proof.navigation.key]!.coverage='partial_replacement';
    expect(()=>reverseMembershipCardActivationLegacyRules(rules)).toThrow();expect(()=>peelMembershipCardActivationLegacyRules(rules)).toThrow();expect(()=>reverseMembershipRightsLegacyRules(rules)).toThrow();
  });
});
