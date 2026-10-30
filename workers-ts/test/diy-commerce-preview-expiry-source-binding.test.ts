import { reverseAdminUserFilterReport } from './helpers/adminUserFilterSourceBinding';
import { createHash } from 'node:crypto';
import {readMainMergePredecessor as readFileSync} from './helpers/migrationMergeSourceBinding';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe,expect,it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from './helpers/migrationMergeMainReport';
import { applyEditorialAuthorReport } from './helpers/diyEditorialAuthorSourceBindingMain';
import { applyCommerceAuthorReport,commerceAuthorSourceBinding } from './helpers/diyCommerceAuthorSourceBinding';
import { applyCommunityAuthorReport } from './helpers/diyCommunityAuthorSourceBindingMain';
import { assertCommerceImagePreviewReport } from './helpers/diyCommerceImagePreviewSourceBinding';
import { assertCommercePreviewExpiryReport,reverseCommercePreviewExpirySource,commercePreviewExpirySourceBinding as proof } from './helpers/diyCommercePreviewExpirySourceBinding';

const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>readFileSync(resolve(root,file),'utf8'),sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const files=['view/admin-ts/src/components/content/DiyCommerceEditor.vue','view/admin-ts/src/api/diyCommerceAuthor.ts'];
const preserved=['workers-ts/test/fixtures/diy-editorial-author-source-binding-20261024.json','workers-ts/test/helpers/diyEditorialAuthorSourceBinding.ts','workers-ts/test/fixtures/diy-commerce-author-source-binding-20261025.json','workers-ts/test/helpers/diyCommerceAuthorSourceBinding.ts','workers-ts/test/fixtures/diy-community-author-source-binding-20261025.json','workers-ts/test/helpers/diyCommunityAuthorSourceBinding.ts','workers-ts/test/fixtures/diy-commerce-image-preview-source-binding-20261025.json','workers-ts/test/helpers/diyCommerceImagePreviewSourceBinding.ts','workers-ts/test/helpers/routeSourceIncrement.ts','workers-ts/audit/admin-frontend-api-contracts.json'];
const ast=(source:string)=>ts.createSourceFile('actual.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function nodes<T extends ts.Node>(input:ts.Node,predicate:(value:ts.Node)=>value is T){const result:T[]=[];function visit(node:ts.Node){if(predicate(node))result.push(node);ts.forEachChild(node,visit);}visit(input);return result;}
function deadlineDeclaration(source=read(files[1]!)){
 const tree=ast(source),found=tree.statements.filter(ts.isFunctionDeclaration).filter(node=>node.name?.text==='commercePreviewDeadline');
 if(found.length!==1)throw Error('Expected one actual exported deadline declaration');return found[0]!.getText(tree);
}
/** Execute the actual declaration, with real URLSearchParams; no replacement URL validator. */
function actualDeadline(source=read(files[1]!)):(preview:Record<string,any>)=>number{
 const exports:Record<string,unknown>={};runInNewContext(ts.transpileModule(deadlineDeclaration(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,URLSearchParams,Date});
 if(typeof exports.commercePreviewDeadline!=='function')throw Error('Actual exported deadline missing');return exports.commercePreviewDeadline as (preview:Record<string,any>)=>number;
}
const {parse}=createRequire(import.meta.url)('../../view/admin-ts/node_modules/@vue/compiler-sfc') as typeof import('../../view/admin-ts/node_modules/@vue/compiler-sfc');
function boundCaller(source:string){
 const parsed=parse(source);if(parsed.errors.length||!parsed.descriptor.scriptSetup)return false;const tree=ast(parsed.descriptor.scriptSetup.content),imports=tree.statements.filter(ts.isImportDeclaration);
 const imported=imports.some(node=>ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text==='@/api/diyCommerceAuthor'&&!node.importClause?.isTypeOnly&&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)&&node.importClause.namedBindings.elements.some(value=>!value.isTypeOnly&&value.name.text==='commercePreviewDeadline'&&(!value.propertyName||value.propertyName.text==='commercePreviewDeadline')));
 const load=nodes(tree,ts.isFunctionDeclaration).find(node=>node.name?.text==='loadContent');if(!imported||!load)return false;
 const calls=nodes(load,ts.isCallExpression),deadlines=calls.filter(call=>ts.isIdentifier(call.expression)&&call.expression.text==='commercePreviewDeadline');if(deadlines.length!==1||deadlines[0]!.arguments.length!==1||deadlines[0]!.arguments[0]!.getText(tree)!=='result')return false;
 const result=nodes(load,ts.isVariableDeclaration).find(node=>node.name.getText(tree)==='result'),adopted=nodes(load,ts.isVariableDeclaration).find(node=>node.name.getText(tree)==='adopted');
 if(!result?.initializer||!ts.isAwaitExpression(result.initializer)||!ts.isCallExpression(result.initializer.expression)||result.initializer.expression.expression.getText(tree)!=='readCommercePreview'||adopted?.initializer?.getText(tree)!=='previewData.value')return false;
 const clear=calls.find(call=>call.expression.getText(tree)==='clearTimeout'&&call.arguments[0]?.getText(tree)==='contentTimer');if(!clear||clear.getStart(tree)>result.getStart(tree))return false;
 const adoption=nodes(load,ts.isBinaryExpression).find(node=>node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&node.left.getText(tree)==='previewData.value'&&node.right.getText(tree)==='result');if(!adoption||adoption.getStart(tree)<deadlines[0]!.getStart(tree))return false;
 return nodes(load,ts.isBinaryExpression).some(node=>node.operatorToken.kind===ts.SyntaxKind.EqualsEqualsEqualsToken&&node.left.getText(tree)==='previewData.value'&&node.right.getText(tree)==='adopted')&&calls.some(call=>call.expression.getText(tree)==='setTimeout'&&call.arguments[0]?.getText(tree)==='expireContent');
}
const expires=2000000060,earliest=2000000005,ticket=(expiry=expires)=>`/api/assets/7?expires=${expiry}&signature=${'A'.repeat(43)}`;
const empty=()=>({cards:[],coupons:[],rooms:[],products:[],slots:[],selectedSlot:0,pink:null}) as Record<string,any>;
const card=()=>({id:1,productId:2,title:'商品?expires=1',image:'',price:'1.00',oldPrice:'2.00',people:0,count:0,stock:1,percent:0,integral:0,status:0});
const label=()=>({id:1,name:'标签&expires=1',color:'#666',background:'#fff',border:'#ddd',icon:''});
const product=()=>({id:1,title:'商品?expires=1',image:'',frameImage:'',price:'1.00',offer:null,sales:0,unit:'件&expires=1',star:'4.5',brand:'品牌?expires=1',labels:[label()]});
const room=()=>({id:1,room_id:2,name:'直播?expires=1',cover_img:'',show_time:'预告&expires=1',anchor_name:'主播?expires=1',anchor_img:'',live_status:101,goods:[{id:3,name:'商品&expires=1',cover_img:'',price:'1.00'}]});
const mediaCases=[
 ['cards[].image',(p:Record<string,any>,url:string)=>{p.cards=[{...card(),image:url}];}],
 ['pink.avatars[]',(p:Record<string,any>,url:string)=>{p.pink={pink_count:1,avatars:[url]};}],
 ['rooms[].cover_img',(p:Record<string,any>,url:string)=>{p.rooms=[{...room(),cover_img:url}];}],
 ['rooms[].anchor_img',(p:Record<string,any>,url:string)=>{p.rooms=[{...room(),anchor_img:url}];}],
 ['rooms[].goods[].cover_img',(p:Record<string,any>,url:string)=>{const r=room();r.goods[0]!.cover_img=url;p.rooms=[r];}],
 ['products[].image',(p:Record<string,any>,url:string)=>{p.products=[{...product(),image:url}];}],
 ['products[].frameImage',(p:Record<string,any>,url:string)=>{p.products=[{...product(),frameImage:url}];}],
 ['products[].labels[].icon',(p:Record<string,any>,url:string)=>{const row=product();row.labels[0]!.icon=url;p.products=[row];}],
] as const;
function textReceipt(){const p=empty();p.cards=[card()];p.products=[product()];p.rooms=[room()];p.slots=[{id:1,start_time:'时段?expires=1',end_time:'时段&expires=1',state:'进行?expires=1',stop:0,status:1}];p.coupons=[{id:1,type:0,coupon_type:1,coupon_title:'券?expires=1',coupon_price:'1.00',use_min_price:'0.00',is_use:false,remain_count:1,receive_limit:1}];return p;}

describe('Commerce preview media-only expiry exact source adjunct',()=>{
 it('pins the exact ordered two complete sources and inverse to each original dated consumer',()=>{
  expect(sha(read('workers-ts/test/fixtures/diy-commerce-preview-expiry-source-binding-20261025.json'))).toBe('dab8be850b69f60557be4121786847f4910bad9ca82940863815500550424295');expect(proof.base_ref).toBe('74cb1125611ea266e165bbeb59e387605d31808d');expect(proof.sources.map(row=>row.file)).toEqual(files);
  for(const row of proof.sources){const source=read(row.file),previous=reverseCommercePreviewExpirySource(row.file,source);expect(sha(source)).toBe(row.after_sha256);expect(Buffer.byteLength(source)).toBe(row.after_bytes);expect(sha(previous)).toBe(row.before_sha256);expect(Buffer.byteLength(previous)).toBe(row.before_bytes);expect(row.before_sha256).toBe(commerceAuthorSourceBinding.consumer_sources.find(item=>item.file===row.file)!.sha256);let reconstructed=previous;for(const edit of row.edits)reconstructed=edit.before_source?reconstructed.replace(edit.before_source,edit.after_source):reconstructed+edit.after_source;expect(reconstructed).toBe(source);}
  expect(proof.sources.map(row=>row.edits.length)).toEqual([2,1]);expect(boundCaller(read(files[0]!))).toBe(true);
 });
 it('retains every dated proof/helper and all existing media parsing dependencies byte-exact',()=>{
  expect(proof.preserved_files.map(row=>row.file)).toEqual(preserved);for(const row of [...proof.preserved_files,...proof.unchanged_dependency_sources]){const source=read(row.file);expect(sha(source),row.file).toBe(row.sha256);expect(Buffer.byteLength(source)).toBe(row.bytes);}
  const opaque='// an untouched sibling\n';expect(reverseCommercePreviewExpirySource('view/admin-ts/src/utils/unrelated.ts',opaque)).toBe(opaque);
 });
 for(const file of files)it.each(['extra','duplicate','missing','legacy','same-size-change','newline','before-hash','after-hash','before-bytes','after-bytes','before-line','after-line'] as const)('rejects any unreviewed source or inverse mutation %s in '+file,kind=>{
  const changed=structuredClone(proof),entry=changed.sources.find(row=>row.file===file)!,original=read(file);let source=original;
  if(kind==='extra')source+='\n// unreviewed\n';if(kind==='duplicate')source+=entry.edits[0]!.after_source;if(kind==='missing')source=source.replace(entry.edits[0]!.after_source,'');if(kind==='legacy')source=reverseCommercePreviewExpirySource(file,source);
  if(kind==='same-size-change')source=source.replace('commercePreviewDeadline','commercePreviewDeadlin0');if(kind==='newline')source=source.replace(/\n/u,'\r\n');
  if(kind==='before-hash')entry.before_sha256='0'.repeat(64);if(kind==='after-hash')entry.after_sha256='0'.repeat(64);if(kind==='before-bytes')entry.before_bytes++;if(kind==='after-bytes')entry.after_bytes++;if(kind==='before-line')entry.edits[0]!.before_line!++;if(kind==='after-line')entry.edits[0]!.after_line++;
  if(['extra','duplicate','missing','legacy','same-size-change','newline'].includes(kind))expect(source).not.toBe(original);expect(()=>reverseCommercePreviewExpirySource(file,source,changed)).toThrow();
 });
 it.each(['missing','duplicate','order','unknown-file','extra-edit','old-text','new-text','base-ref','entry-ref'] as const)('rejects forged exact source inventory %s',kind=>{
  const changed=structuredClone(proof);if(kind==='missing')changed.sources.pop();if(kind==='duplicate')changed.sources[1]=structuredClone(changed.sources[0]!);if(kind==='order')changed.sources.reverse();if(kind==='unknown-file')changed.sources[0]!.file='view/admin-ts/src/unreviewed.ts';if(kind==='extra-edit')changed.sources[0]!.edits.push(structuredClone(changed.sources[0]!.edits[0]!));if(kind==='old-text')changed.sources[0]!.edits[0]!.before_source='unreviewed';if(kind==='new-text')changed.sources[0]!.edits[0]!.after_source='unreviewed';if(kind==='base-ref')changed.base_ref='unknown';if(kind==='entry-ref')changed.sources[0]!.before_ref='unknown';expect(()=>reverseCommercePreviewExpirySource(files[0]!,read(files[0]!),changed)).toThrow();
 });
 it('requires the real typed deadline import/call before adoption and current-object timer guard',()=>{
  const source=read(files[0]!);for(const altered of [source.replace(',commercePreviewDeadline,',','),source.replace('commercePreviewDeadline(result)','Infinity'),source.replace('clearTimeout(contentTimer);contentTimer=undefined;',''),source.replace('previewData.value===adopted','true')]){expect(altered).not.toBe(source);expect(boundCaller(altered)).toBe(false);}
 });
 it('recomputes the complete real API report as zero delta without filtering rows or source files',()=>{
  const p=proof.api_report;expect(sha(read(p.base_file))).toBe(p.base_sha256);for(const row of p.binding_chain)expect(sha(read(row.file))).toBe(row.sha256);
  const expected=applyCommunityAuthorReport(applyCommerceAuthorReport(applyEditorialAuthorReport(JSON.parse(read(p.base_file))))),actual=reverseAdminUserFilterReport(buildAdminFrontendApiAuditReport());expect(assertCommercePreviewExpiryReport(actual)).toBe(actual);expect(assertCommerceImagePreviewReport(actual)).toBe(actual);expect(actual).toEqual(expected);expect(p.changes).toEqual([]);expect(p.after_sha256).toBe(p.before_sha256);
  expect(sha(JSON.stringify(actual,null,2)+'\n')).toBe(p.after_sha256);expect(Buffer.byteLength(JSON.stringify(actual,null,2)+'\n')).toBe(p.pretty_bytes);expect(sha(JSON.stringify(actual)+'\n')).toBe(p.compact_sha256);expect(Buffer.byteLength(JSON.stringify(actual)+'\n')).toBe(p.compact_bytes);expect(actual.counts).toMatchObject({callSites:703,pathVariants:741,registered:741,unregistered:0,unresolved:0});expect(actual.frontendSources).toHaveLength(106);expect(actual.frontendSources.some(row=>files.includes(row.file))).toBe(false);
  for(const kind of ['counts','call','source','backend','methodology']){const changed=structuredClone(actual);if(kind==='counts')changed.counts.registered++;if(kind==='call')changed.calls[0].line++;if(kind==='source')changed.frontendSources[0].sha256='0'.repeat(64);if(kind==='backend')changed.backend.sha256='0'.repeat(64);if(kind==='methodology')changed.methodology.scope='unreviewed';expect(()=>assertCommercePreviewExpiryReport(changed)).toThrow();}
  const changed=structuredClone(proof);changed.api_report.changes.push({unreviewed:true});expect(()=>assertCommercePreviewExpiryReport(actual,changed)).toThrow();
 });
 it('executes the actual deadline with all ordinary text and unrelated metadata expiry markers ignored',()=>{const p=textReceipt();expect(actualDeadline()(p)).toBe(Infinity);expect(actualDeadline()(empty())).toBe(Infinity);});
 for(const [name,place]of mediaCases)it('only a valid platform ticket in the actual declared '+name+' slot supplies its deadline',()=>{
  const p=textReceipt();place(p,ticket());expect(actualDeadline()(p)).toBe(expires*1000);
  for(const value of ['https://foreign.example/a.png?expires=1','/static/image.png?expires=1','/api/assets/7','/api/assets/7?expires=1&signature=x',ticket()+'&expires=1',ticket()+'&%65xpires=1',ticket()+'&%73ignature='+'B'.repeat(43),ticket()+'#fragment']){place(p,value);expect(actualDeadline()(p),name+' '+value).toBe(Infinity);}
 });
 it('includes the final nested label and scans the complete10200-slot budget before returning',()=>{
  const p=empty();p.products=Array.from({length:100},(_,index)=>({...product(),id:index+1,image:ticket(),frameImage:ticket(),labels:Array.from({length:100},(_,n)=>({...label(),id:n+1,icon:ticket()}))}));p.products[99].labels[99].icon=ticket(earliest);expect(actualDeadline()(p)).toBe(earliest*1000);p.products[99].labels.push({...label(),id:101,icon:ticket()});expect(()=>actualDeadline()(p)).toThrow(/容量/u);
 });
 it('does not stop at the first room or first nested goods image',()=>{const p=empty();p.rooms=Array.from({length:50},(_,index)=>({...room(),id:index+1,room_id:index+1,cover_img:ticket(),anchor_img:ticket(),goods:Array.from({length:100},(_,n)=>({id:n+1,name:'商品',cover_img:ticket(),price:'1.00'}))}));p.rooms[49].goods[99].cover_img=ticket(earliest);expect(actualDeadline()(p)).toBe(earliest*1000);});
 it('rejects the old complete-JSON scan counterfactual with the same text-only receipt',()=>{
  const source=read(files[1]!),old="export function commercePreviewDeadline(preview:CommercePreview):number{const expiries=[...JSON.stringify(preview).matchAll(/[?&]expires=(\\d+)/gu)].map(match=>Number(match[1])*1000).filter(Number.isFinite);return expiries.length?Math.min(...expiries):Infinity;}",mutant=source.replace(deadlineDeclaration(source),old);expect(mutant).not.toBe(source);expect(()=>expect(actualDeadline(mutant)(textReceipt())).toBe(Infinity)).toThrow();
 });
});
