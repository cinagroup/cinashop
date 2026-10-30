import {createHash} from 'node:crypto';
import {readMainMergePredecessor as readFileSync} from './helpers/migrationMergeSourceBinding';
import {resolve} from 'node:path';
import ts from 'typescript';
import {describe,expect,it} from 'vitest';
import {buildAdminFrontendApiAuditReport} from './helpers/migrationMergeMainReport';
import {reverseReviewedRouteTailReport} from './helpers/reviewedRouteTailSourceBinding';
import {reverseReviewedAdminSourceTail} from './helpers/reviewedAdminSourceTailBinding';
import {messageCenterSourceBinding as p,peelMessageCenterSourceIfPresent,reverseMessageCenterSource,
  peelMessageCenterHarnessSourceIfPresent,reverseMessageCenterHarnessSource,assertMessageCenterCurrentSource,
  peelMessageCenterReportIfPresent,reverseMessageCenterReport,applyMessageCenterReport} from './helpers/messageCenterSourceBinding';
const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>readFileSync(resolve(root,file),'utf8');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const blob=(s:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const pretty=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const compact=(s:string)=>s.replace(/\s/gu,'');
const routeFile='workers-ts/src/routes/v1/index.ts',controllerFile='workers-ts/src/controllers/api/v1/UserMessageController.ts';
const sourceMeta=(s:string)=>[Buffer.byteLength(s),sha(s),blob(s)];
let report:ReturnType<typeof buildAdminFrontendApiAuditReport>|undefined;
const currentReport=()=>structuredClone(report??=buildAdminFrontendApiAuditReport());
function tree(source:string){return ts.createSourceFile('current.ts',source,ts.ScriptTarget.Latest,true);}
function calls(node:ts.Node,source:ts.SourceFile,callee?:string){const result:ts.CallExpression[]=[];function visit(n:ts.Node){if(ts.isCallExpression(n)&&(!callee||n.expression.getText(source)===callee))result.push(n);ts.forEachChild(n,visit);}visit(node);return result;}
function method(source:ts.SourceFile,name:string){let found:ts.MethodDeclaration|undefined;function visit(node:ts.Node){if(ts.isMethodDeclaration(node)&&node.name.getText(source)===name){expect(found).toBeUndefined();found=node;}ts.forEachChild(node,visit);}visit(source);expect(found).toBeDefined();return found!;}
describe('exact message center CI tail preserves historical proofs and independently binds current consumers',()=>{
 it('seals only two production inverses, seven harness adapters and seven live consumer sources',()=>{
  expect(sha(read('workers-ts/test/fixtures/message-center-ci-source-binding-20261028.json'))).toBe('0fdeee7c06f44c4eeed9c1748a302df2c4a59733e78e48f83ed1eec65d85db3d');
  expect(sha(read('workers-ts/test/helpers/messageCenterSourceBinding.ts'))).toBe('4cff3b2f1f0d9419bd5d09a44efdb90c1de6b02caf3b4eff43835eaa7993af35');
  expect(p.sources.map(r=>r.file)).toEqual([routeFile,controllerFile]);
  expect(p.sources[0]!.edits).toHaveLength(3);expect(p.sources[1]!.edits).toHaveLength(3);
  expect(p.harness_sources).toHaveLength(7);expect(p.current_sources).toHaveLength(7);
  for(const row of p.current_sources){const source=read(row.file);expect(sourceMeta(source)).toEqual([row.bytes,row.sha256,row.git_blob_sha1]);expect(()=>assertMessageCenterCurrentSource(row.file,source)).not.toThrow();}
  for(const row of p.sources){const actual=read(row.file),before=reverseMessageCenterSource(row.file,actual);expect(sourceMeta(actual)).toEqual([row.after_bytes,row.after_sha256,row.after_git_blob_sha1]);expect(sourceMeta(before)).toEqual([row.before_bytes,row.before_sha256,row.before_git_blob_sha1]);let rebuilt=before;for(const edit of row.edits){expect(rebuilt.split(edit.before_source)).toHaveLength(2);rebuilt=rebuilt.replace(edit.before_source,edit.after_source);}expect(rebuilt).toBe(actual);expect(peelMessageCenterSourceIfPresent(row.file,before)).toBe(before);}
  for(const row of p.harness_sources){const actual=read(row.file),before=reverseMessageCenterHarnessSource(row.file,actual);expect(sourceMeta(actual)).toEqual([row.after_bytes,row.after_sha256,row.after_git_blob_sha1]);expect(sourceMeta(before)).toEqual([row.before_bytes,row.before_sha256,row.before_git_blob_sha1]);expect(peelMessageCenterHarnessSourceIfPresent(row.file,before)).toBe(before);}
 });
 it('retains all fifteen dated fixtures and five additional historical authorities byte for byte',()=>{
  expect(p.preserved_dated_fixtures).toHaveLength(20);
  for(const row of p.preserved_dated_fixtures)expect([Buffer.byteLength(read(row.file)),sha(read(row.file))],row.file).toEqual([row.bytes,row.sha256]);
 });
 it('reads actual routes and requires exactly three authenticated GETs with no-store before auth',()=>{
  const source=tree(read(routeFile)),contracts=[['/user/message','UserMessageController.messageCenter'],['/user/message_system/list','UserMessageController.messageList'],['/user/message_system/detail/:id','UserMessageController.messageDetail']];
  const actual=calls(source,source).filter(n=>ts.isPropertyAccessExpression(n.expression)&&n.expression.expression.getText(source)==='v1Routes'&&n.arguments[0]&&ts.isStringLiteral(n.arguments[0])&&contracts.some(r=>r[0]===(n.arguments[0]as ts.StringLiteral).text));
  expect(actual).toHaveLength(3);
  for(const [index,n]of actual.entries()){
   expect(n.expression.getText(source)).toBe('v1Routes.get');expect(n.arguments).toHaveLength(4);
   expect(n.arguments[0]!.getText(source)).toBe(JSON.stringify(contracts[index]![0]));
   expect(compact(n.arguments[2]!.getText(source))).toBe('authMiddleware({force:true})');
   expect(n.arguments[3]!.getText(source)).toBe(contracts[index]![1]);
   const cache=n.arguments[1]!;expect(ts.isArrowFunction(cache)).toBe(true);if(!ts.isArrowFunction(cache))throw Error('cache handler missing');
   expect(cache.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)).toBe(true);
   expect(cache.parameters.map(x=>x.name.getText(source))).toEqual(['c','next']);
   const headers=calls(cache,source,'c.header');expect(headers).toHaveLength(1);expect(headers[0]!.arguments.map(a=>ts.isStringLiteral(a)?a.text:null)).toEqual(['Cache-Control','private, no-store']);
   expect(compact(cache.getText(source)).endsWith('awaitnext();}')).toBe(true);
  }
  const historical=reverseMessageCenterSource(routeFile,read(routeFile));
  expect(()=>reverseReviewedAdminSourceTail(routeFile,historical)).not.toThrow();
 });
 it('independently binds the live visible-message index consumer and consuming-page snapshot',()=>{
  const source=tree(read('workers-ts/src/services/message/MessageCenterService.ts')),center=method(source,'center'),list=method(source,'list');
  const queries=calls(center,source).map(n=>compact(n.getText(source)));
  expect(queries.filter(q=>q==='tx.select().from(systemMessage).where(visibleSystemMessageWhere(actor.uid)).orderBy(desc(systemMessage.addTime),desc(systemMessage.id)).limit(1)')).toHaveLength(1);
  const statements:ts.TaggedTemplateExpression[]=[];function visit(n:ts.Node){if(ts.isTaggedTemplateExpression(n)&&n.tag.getText(source)==='sql')statements.push(n);ts.forEachChild(n,visit);}visit(list);
  expect(statements).toHaveLength(1);const sql=compact(statements[0]!.getText(source));
  for(const fragment of ['WITHvisibleASMATERIALIZED(','FROMpublic.system_messagemWHEREm.status=1ANDm.is_del=0ANDm.typeIN(0,1)ANDm.user_idIN(0,${actor.uid})',
   'pageASMATERIALIZED(','SELECT*FROMvisibleORDERBYadd_timeDESC,idDESCLIMIT${q.limit}OFFSET${(q.page-1)*q.limit}',
   '(SELECTcount(*)::integerFROMvisible)AStotal','(SELECTcount(*)::integerFROMvisibleWHERENOTseen)ASunread',
   'jsonb_agg(to_jsonb(p)ORDERBYp.add_timeDESC,p.idDESC)','r.uid=${actor.uid}ANDr.message_id=m.idANDr.is_read=1'])expect(sql).toContain(fragment);
  const controller=tree(read(controllerFile));for(const[name,target]of[['messageCenter','center'],['messageList','list'],['messageDetail','detail']]){
   const fn=controller.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);expect(fn).toBeDefined();expect(calls(fn!,controller,'service.'+target)).toHaveLength(1);
  }
  expect(read('workers-ts/src/services/message/UserMessageVisibility.ts')).toContain('inArray(systemMessage.type, [0, 1])');
 });
 it('recomputes the complete live API report and reverses only one source SHA scalar',()=>{
  const actual=currentReport(),before=reverseMessageCenterReport(actual),proof=p.api_report;
  expect([sha(pretty(actual)),Buffer.byteLength(pretty(actual))]).toEqual([proof.after_sha256,proof.after_bytes]);
  expect([sha(pretty(before)),Buffer.byteLength(pretty(before))]).toEqual([proof.before_sha256,proof.before_bytes]);
  expect(actual.counts).toEqual(proof.counts);expect(actual.frontendSources).toHaveLength(108);expect(actual.backend.registeredRoutes).toHaveLength(1681);
  const only=structuredClone(before);only.backend.rootRouteSources[2]!.sha256=proof.after;expect(only).toEqual(actual);
  expect(applyMessageCenterReport(before)).toEqual(actual);expect(peelMessageCenterReportIfPresent(actual)).toEqual(before);expect(peelMessageCenterReportIfPresent(before)).toEqual(before);
  expect(sha(pretty(reverseReviewedRouteTailReport(actual)))).toBe('1ac108158879d83daae4f0d5a70e137db210e23a33040f10a577dada2419bff0');
  for(const row of actual.backend.rootRouteSources)expect(sha(read(row.file).replace(/\r\n?/gu,'\n'))).toBe(row.sha256);
 });
 for(const file of[routeFile,controllerFile])it.each(['extra','crlf','same-size','missing-line']as const)('rejects unknown whole source '+file+' %s',kind=>{
  const actual=read(file),changed=kind==='extra'?actual+'//unknown\n':kind==='crlf'?actual.replaceAll('\n','\r\n'):kind==='same-size'?actual.replace('a','z'):actual.replace(/^import[^\n]*\n/mu,'');
  expect(changed).not.toBe(actual);expect(peelMessageCenterSourceIfPresent(file,changed)).toBe(changed);expect(()=>reverseMessageCenterSource(file,changed)).toThrow();expect(()=>assertMessageCenterCurrentSource(file,changed)).toThrow();
 });
 it.each(['hash','bytes','blob','line','edit','duplicate','extra-source','report-path','report-source','report-count']as const)('rejects forged sealed inventory %s',kind=>{
  const bad=structuredClone(p);if(kind==='hash')bad.sources[0]!.after_sha256='0'.repeat(64);if(kind==='bytes')bad.sources[0]!.after_bytes++;if(kind==='blob')bad.sources[0]!.after_git_blob_sha1='0'.repeat(40);if(kind==='line')bad.sources[0]!.edits[0]!.after_line++;if(kind==='edit')bad.sources[0]!.edits[0]!.after_source+=' ';if(kind==='duplicate')bad.sources[0]!.edits.push(structuredClone(bad.sources[0]!.edits[0]!));if(kind==='extra-source')bad.sources.push(structuredClone(bad.sources[0]!));if(kind==='report-path')bad.api_report.path=['backend'];if(kind==='report-source')bad.api_report.after='0'.repeat(64);if(kind==='report-count')bad.api_report.counts.callSites++;
  expect(()=>peelMessageCenterSourceIfPresent(routeFile,read(routeFile),bad)).toThrow();expect(()=>peelMessageCenterReportIfPresent(currentReport(),bad)).toThrow();
 });
 it.each(['count','path','handler','source','line','extra','missing','order','methodology']as const)('refuses unrelated complete report drift %s',kind=>{
  const changed=currentReport();if(kind==='count')changed.counts.callSites++;if(kind==='path')changed.calls[0]!.path+='/unknown';if(kind==='handler')changed.backend.registeredRoutes[0]!.handler='Unknown.handler';if(kind==='source')changed.frontendSources[0]!.sha256='0'.repeat(64);if(kind==='line')changed.calls[0]!.line++;if(kind==='extra')Object.assign(changed,{unreviewed:true});if(kind==='missing')changed.calls.pop();if(kind==='order')changed.calls.reverse();if(kind==='methodology')changed.methodology.scope+='unknown';
  expect(peelMessageCenterReportIfPresent(changed)).toEqual(changed);expect(()=>reverseMessageCenterReport(changed)).toThrow();expect(()=>reverseReviewedRouteTailReport(changed)).toThrow();
 });
});
