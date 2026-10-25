import { reverseCommerceAuthorSource, reverseCommerceAuthorReport } from './helpers/diyCommerceAuthorSourceBinding';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from '../scripts/admin-frontend-api-audit';
import { applyEditorialAuthorReport, editorialAuthorSourceBinding as proof, reverseEditorialAuthorSource } from './helpers/diyEditorialAuthorSourceBinding';
const { parse } = createRequire(import.meta.url)('../../view/admin-ts/node_modules/@vue/compiler-sfc') as typeof import('../../view/admin-ts/node_modules/@vue/compiler-sfc');
const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>reverseCommerceAuthorSource(file,readFileSync(resolve(root,file),'utf8')),sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const reportHash=(value:unknown)=>sha(JSON.stringify(value,null,2)+'\n');
const previousRaw=read(proof.previous_report.file),previous=JSON.parse(previousRaw),source=read(proof.source.file);
const ast=(source:string)=>ts.createSourceFile('actual.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function all<T extends ts.Node>(node:ts.Node,predicate:(value:ts.Node)=>value is T):T[]{const result:T[]=[];const visit=(value:ts.Node)=>{if(predicate(value))result.push(value);ts.forEachChild(value,visit);};visit(node);return result;}
function imported(file:ts.SourceFile,module:string,name:string){return file.statements.some(node=>ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text===module&&node.importClause&&!node.importClause.isTypeOnly&&(node.importClause.name?.text===name||node.importClause.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)&&node.importClause.namedBindings.elements.some(item=>!item.isTypeOnly&&item.name.text===name)));}
function sfc(source:string){const parsed=parse(source);if(parsed.errors.length||!parsed.descriptor.template?.ast||!parsed.descriptor.scriptSetup)return null;const nodes:any[]=[];const visit=(node:any)=>{if(node.type===1)nodes.push(node);for(const child of node.children??[])visit(child);};visit(parsed.descriptor.template.ast);return{script:ast(parsed.descriptor.scriptSetup.content),nodes};}
const bind=(node:any,name:string,value:string)=>node.props.some((p:any)=>p.type===7&&p.name==='bind'&&p.arg?.content===name&&p.exp?.content===value);
const event=(node:any,name:string,value:string)=>node.props.some((p:any)=>p.type===7&&p.name==='on'&&p.arg?.content===name&&p.exp?.content===value);
function pageBound(source:string){const parsed=sfc(source);if(!parsed||!imported(parsed.script,'@/components/content/DiyEditorialEditor.vue','DiyEditorialEditor')||!imported(parsed.script,'@/utils/diyEditorialEditor','canonicalEditorialValue'))return false;
  const editors=parsed.nodes.filter(node=>node.tag==='DiyEditorialEditor');if(editors.length!==1)return false;const editor=editors[0];
  if(!editor.props.some((p:any)=>p.type===7&&p.name==='model'&&p.exp?.content==='form.value')||!bind(editor,'editor-key','`${editorIdentity}:${form.id}:${editorEpoch}`')||!bind(editor,'page-id','form.id')||!bind(editor,'page-published','persistedPublished')||!bind(editor,'disabled','submitting || !formVisible || !sessionReady'))return false;
  const canonical=all(parsed.script,ts.isFunctionDeclaration).find(node=>node.name?.text==='canonicalJson');if(!canonical)return false;
  const calls=all(canonical,ts.isCallExpression).filter(node=>ts.isIdentifier(node.expression)&&node.expression.text==='canonicalEditorialValue');
  return calls.length===1&&calls[0]!.arguments.length===1&&ts.isCallExpression(calls[0]!.arguments[0]!)&&calls[0]!.arguments[0]!.expression.getText(parsed.script)==='canonicalStateValue';
}
function authorBound(source:string){const parsed=sfc(source);if(!parsed)return false;
  if(![['./DiyNewsAuthorFields.vue','DiyNewsAuthorFields'],['./DiyHotspotAuthorCanvas.vue','DiyHotspotAuthorCanvas'],['./DiyEditorialPreview.vue','DiyEditorialPreview'],['@/utils/diyEditorialDefaults','DIY_EDITORIAL_DEFAULTS']].every(([module,name])=>imported(parsed.script,module!,name!)))return false;
  const news=parsed.nodes.find(node=>node.tag==='DiyNewsAuthorFields'),canvas=parsed.nodes.find(node=>node.tag==='DiyHotspotAuthorCanvas');
  if(!news||!bind(news,'block','block')||!bind(news,'disabled','!canEdit')||!event(news,'change','setLeaf')||!canvas||!bind(canvas,'allowed','canvasSession.allowed')||!bind(canvas,'disabled','!canEdit')||!event(canvas,'create','canvasSession.create')||!event(canvas,'rect','canvasSession.rect'))return false;
  const calls=all(parsed.script,ts.isCallExpression).filter(node=>ts.isIdentifier(node.expression)&&node.expression.text==='fetch');if(calls.length!==1)return false;const call=calls[0]!,url=call.arguments[0],options=call.arguments[1];
  if(!url||!ts.isTemplateExpression(url)||url.head.text!=='/api/diy/get_diy/'||url.templateSpans.length!==1||url.templateSpans[0]!.expression.getText(parsed.script)!=='id'||!options||!ts.isObjectLiteralExpression(options))return false;
  const entries=Object.fromEntries(options.properties.flatMap(node=>ts.isPropertyAssignment(node)?[[node.name.getText(parsed.script),node.initializer.getText(parsed.script)]]:[]));
  return entries.method==="'GET'"&&entries.credentials==="'omit'"&&entries.cache==="'no-store'"&&entries.signal==='controller.signal';
}
function defaultsBound(source:string){const file=ast(source);if(!imported(file,'./diyEditorialDefaults','DIY_EDITORIAL_DEFAULTS'))return false;const fn=all(file,ts.isFunctionDeclaration).find(node=>node.name?.text==='newEditorialBlock');if(!fn)return false;
  return all(fn,ts.isSpreadAssignment).some(node=>ts.isCallExpression(node.expression)&&node.expression.expression.getText(file)==='structuredClone'&&node.expression.arguments.length===1&&node.expression.arguments[0]!.getText(file)==='DIY_EDITORIAL_DEFAULTS[kind]');
}
function actualDefaults(){const file=ast(read('view/admin-ts/src/utils/diyEditorialDefaults.ts')),definition=all(file,ts.isVariableDeclaration).find(node=>node.name.getText(file)==='DIY_EDITORIAL_DEFAULTS');let value=definition?.initializer;if(value&&ts.isAsExpression(value))value=value.expression;if(!value||!ts.isObjectLiteralExpression(value))throw Error('Editorial defaults must remain one complete JSON-compatible literal');return JSON.parse(value.getText(file));}

describe('exact editorial parent integration retains every dated source and API contract',()=>{
  it('pins the small delta fixture, complete current parent and byte-exact preceding source/report',()=>{
    expect(sha(read('workers-ts/test/fixtures/diy-editorial-author-source-binding-20261024.json'))).toBe('0493954cc32eb582ba5944cc7e803ef7e043d030d0455b5ccb63999a2744d2e9');
    expect(proof.source.file).toBe('view/admin-ts/src/pages/content/DiseList.vue');expect(proof.source.edits).toHaveLength(3);
    expect(proof.source.edits.map(row=>row.before_source==='')).toEqual([true,true,false]);
    expect(sha(source)).toBe(proof.source.after_sha256);expect(sha(reverseEditorialAuthorSource(proof.source.file,source))).toBe(proof.source.before_sha256);
    expect(sha(previousRaw)).toBe('0976eef03520486e92df2ed4b40814463fe62d0d0b5f0a66fe9e87c1af7359dd');expect(proof.previous_report.sha256).toBe(sha(previousRaw));
    expect(Object.hasOwn(proof.previous_report,'raw_utf8')).toBe(false);
  });
  it.each(['extra-line','duplicate-edit','missing-render','missing-wrapper','before-hash','after-hash','after-location','before-location'] as const)('rejects unreviewed source/proof %s before any historical inverse',kind=>{
    const changed=structuredClone(proof);let candidate=source;
    if(kind==='extra-line')candidate+='\n// unreviewed\n';if(kind==='duplicate-edit')candidate+=changed.source.edits[0]!.after_source;if(kind==='missing-render')candidate=candidate.replace(changed.source.edits[0]!.after_source,'');if(kind==='missing-wrapper')candidate=candidate.replace('return canonicalEditorialValue(canonicalStateValue','return canonicalStateValue');if(kind==='before-hash')changed.source.before_sha256='0'.repeat(64);if(kind==='after-hash')changed.source.after_sha256='0'.repeat(64);if(kind==='after-location')changed.source.edits[0]!.after_line++;if(kind==='before-location')changed.source.edits[2]!.before_line!++;
    expect(()=>reverseEditorialAuthorSource(proof.source.file,candidate,changed)).toThrow();
  });
  it('does not transform any sibling file or silently forgive an extra production-source edit',()=>{
    const untouched='// opaque unchanged sibling\n';expect(reverseEditorialAuthorSource('view/admin-ts/src/utils/unrelated.ts',untouched)).toBe(untouched);
    expect(proof.consumer_sources.map(row=>row.file)).toEqual(['view/admin-ts/src/components/content/DiyEditorialEditor.vue','view/admin-ts/src/components/content/DiyHotspotAuthorCanvas.vue','view/admin-ts/src/components/content/DiyNewsAuthorFields.vue','view/admin-ts/src/utils/diyEditorialEditor.ts','view/admin-ts/src/utils/diyEditorialDefaults.ts','view/admin-ts/src/utils/diyNewsAuthorFields.ts','view/admin-ts/src/utils/diyEditorialProjection.ts','view/uniapp-ts/src/utils/diyEditorialConfig.ts']);
    for(const row of proof.consumer_sources){expect(sha(read(row.file))).toBe(row.sha256);expect(sha(read(row.file)+'\n// unreviewed\n')).not.toBe(row.sha256);}
  });
  it('reconstructs the whole freshly built report using one source hash and three existing call shifts only',()=>{
    const actual=reverseCommerceAuthorReport(buildAdminFrontendApiAuditReport()),expected=applyEditorialAuthorReport(previous);expect(actual).toEqual(expected);expect(reportHash(actual)).toBe(proof.current_report.sha256);expect(sha(JSON.stringify(actual)+'\n')).toBe(proof.current_report.raw_capture.sha256);expect(Buffer.byteLength(JSON.stringify(actual)+'\n')).toBe(proof.current_report.raw_capture.bytes);
    expect(actual.counts).toEqual(previous.counts);expect(actual.counts).toMatchObject({callSites:703,pathVariants:741,registered:741,executable:741,unregistered:0,unresolved:0});expect(actual.backend).toEqual(previous.backend);expect(actual.methodology).toEqual(previous.methodology);
    expect(proof.report_changes.map(row=>row.array)).toEqual(['frontendSources','calls','calls','calls']);
    for(const change of proof.report_changes){expect(change.after.file??change.after.source).toBe(proof.source.file);const before={...change.before},after={...change.after};if(change.array==='calls'){expect(after.line).toBe(Number(before.line)+3);delete before.line;delete after.line;}else{delete before.sha256;delete after.sha256;}expect(after).toEqual(before);}
    expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);
  });
  it.each(['counts','backend','methodology','old-call','old-source'] as const)('rejects changed complete report predecessor %s',kind=>{
    const changed=structuredClone(previous);if(kind==='counts')changed.counts.registered++;if(kind==='backend')changed.backend.sha256='0'.repeat(64);if(kind==='methodology')changed.methodology.scope='unreviewed';if(kind==='old-call')changed.calls[0].line++;if(kind==='old-source')changed.frontendSources[0].sha256='0'.repeat(64);expect(()=>applyEditorialAuthorReport(changed)).toThrow();
  });
  it.each(['missing-row','duplicate-row','before-row','after-row','array','index','before-hash','after-hash'] as const)('rejects altered exact report delta %s',kind=>{
    const changed=structuredClone(proof);if(kind==='missing-row')changed.report_changes.pop();if(kind==='duplicate-row')changed.report_changes.push(structuredClone(changed.report_changes[0]!));if(kind==='before-row')changed.report_changes[1]!.before.line=0;if(kind==='after-row')changed.report_changes[1]!.after.line=0;if(kind==='array')changed.report_changes[0]!.array='unreviewed' as 'calls';if(kind==='index')changed.report_changes[0]!.index=-1;if(kind==='before-hash')changed.previous_report.sha256='0'.repeat(64);if(kind==='after-hash')changed.current_report.sha256='0'.repeat(64);expect(()=>applyEditorialAuthorReport(previous,changed)).toThrow();
  });
  it('binds the live full56 defaults to the actual new-block producer and independent fixed PHP fixture',()=>{
    expect(sha(read(proof.defaults_fixture.file))).toBe('bb3240a618e9e8b798e26e75bb538474b18fd3091184bc2c362034a907879ace');
    const defaults=actualDefaults();expect(defaults).toEqual(JSON.parse(read(proof.defaults_fixture.file)));expect(Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,Object.keys(value as object).length]))).toEqual({news:32,hotspot:14,activeParty:10});
    const utility=read('view/admin-ts/src/utils/diyEditorialEditor.ts');expect(defaultsBound(utility)).toBe(true);expect(defaultsBound(utility.replace('structuredClone(DIY_EDITORIAL_DEFAULTS[kind])','{}'))).toBe(false);
  });
  it('binds actual page v-model/session/readonly inputs and canonical save composition to the new parent',()=>{
    expect(pageBound(source)).toBe(true);
    for(const changed of [source.replace(':disabled="submitting || !formVisible || !sessionReady" /></el-form-item>\n        <el-form-item label="内容排版"',':disabled="false" /></el-form-item>\n        <el-form-item label="内容排版"'),source.replace('return canonicalEditorialValue(canonicalStateValue','return canonicalStateValue'),source.replace(':page-published="persistedPublished" :disabled="submitting || !formVisible || !sessionReady" /></el-form-item>\n        <el-form-item label="内容排版"',':page-published="true" :disabled="submitting || !formVisible || !sessionReady" /></el-form-item>\n        <el-form-item label="内容排版"')]){expect(changed).not.toBe(source);expect(pageBound(changed)).toBe(false);}
  });
  it('binds the parent content/canvas/default consumers and its explicit public GET outside the historical request extractor',()=>{
    const parent=read('view/admin-ts/src/components/content/DiyEditorialEditor.vue');expect(authorBound(parent)).toBe(true);
    for(const changed of [parent.replace(':allowed="canvasSession.allowed"',':allowed="()=>true"'),parent.replace('@change="setLeaf"','@change="()=>{}"'),parent.replace("method:'GET'","method:'POST'"),parent.replace("credentials:'omit'","credentials:'include'")]){expect(changed).not.toBe(parent);expect(authorBound(changed)).toBe(false);}
  });
  for(const tone of [0,1]) it(`actual Admin and Uni title tone${tone} preserve PHP theme-solid versus custom two-stop behavior for all six themes`,()=>{
    const require=createRequire(import.meta.url),admin=require('../../view/admin-ts/scripts/helpers/diy-navigation-runtime.cjs').loader();
    const input=JSON.parse(read(proof.defaults_fixture.file)).news;input.titleConfig.tabVal=1;input.toneConfig.tabVal=tone;input.titleColor.color=[{item:'#654321'}];input.titleBgColor.color=[{item:'#102030'},{item:'#a0b0c0'}];const before=structuredClone(input);
    const uni=require('../../view/uniapp-ts/scripts/uni-store-runtime.cjs').runtime({component:'components/diy/DiyEditorialWidget.vue',props:{block:input,active:false},platform:'H5',send:()=>{throw Error('Inactive source projection must not request');}});
    try{const author=admin.load(resolve(root,'view/admin-ts/src/utils/diyEditorialProjection.ts')),consumer=uni.load(resolve(root,'view/uniapp-ts/src/utils/diyEditorialConfig.ts')),themes=admin.load(resolve(root,'view/common/theme.ts')).THEME_PRESETS;
      expect(themes).toHaveLength(6);for(const theme of themes){const expected=tone===0?{color:'#ffffff',background:theme.theme}:{color:'#654321',background:'linear-gradient(90deg, #102030 0%, #a0b0c0 100%)'};expect(author.normalizeDiyEditorial(input,theme).tickerTitleStyle).toEqual(expected);expect(consumer.normalizeDiyEditorial(input,theme).tickerTitleStyle).toEqual(expected);}
      expect(input).toEqual(before);expect(uni.calls).toEqual([]);
    }finally{uni.stop();}
  });

});
