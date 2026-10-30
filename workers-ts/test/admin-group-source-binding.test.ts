import {createHash} from 'node:crypto';
import {readUnitPredecessor as readFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {buildUnitPredecessorApiAuditReport as buildAdminFrontendApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {groupSourceBinding as proof,reverseGroupSource,readGroupPredecessor,readDeliveryPredecessor,deliverySourceBinding,reverseDeliverySource,buildGroupPredecessorApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {GROUP_FIELDS,newGroupValues,groupAction,groupCanonical,groupReceipt,groupCatalog,groupName,type GroupAction} from '../../view/common/groupAuthor';
const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>readFileSync(resolve(root,file),'utf8');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const stripImports=(value:string)=>value.replace(/^import[\s\S]*?;\n/gmu,'');
const permissionTest='workers-ts/test/admin-permission.test.ts',frontendTest='workers-ts/test/admin-user-groups-frontend.test.ts';
const mobileTest='view/uniapp-ts/scripts/delivery-workbench-runtime.test.cjs';
const oldPorts=(file:string)=>file.startsWith('workers-ts/test/')&&file.endsWith('.test.ts')&&file!==permissionTest&&file!==frontendTest;
function php(file:string){const row=proof.PHP_sources.find(row=>row.file===file);if(!row)throw Error('Missing complete fixed PHP original: '+file);return row.raw_utf8;}
function frontendCases(value:string){const entries=[...value.matchAll(/^it\((['"])(.*?)\1,/gmu)];return entries.map((m,i)=>({title:m[2]!,source:value.slice(m.index,entries[i+1]?.index??value.length)}));}
function action(operation:GroupAction['operation']='update'):GroupAction{return {operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation,target_id:operation==='create'?0:20,revision:'a'.repeat(64),payload:operation==='delete'?{}:{group_name:'原名称'},payload_hash:'b'.repeat(64)};}

describe('mall user-group incremental recoverable author and exact immutable source lineage',()=>{
 for(const row of proof.sources){
  it('pins full current and whole exact predecessor '+row.file,()=>{const raw=read(row.file);expect(sha(raw)).toBe(row.after_sha256);expect(sha(reverseGroupSource(row.file,raw))).toBe(row.before_sha256);expect(sha(readGroupPredecessor(resolve(root,row.file)))).toBe(row.before_sha256);});
  it('rejects changed source and generalized/forged inverse '+row.file,()=>{
   const raw=read(row.file);for(const bad of [raw.slice(1),raw+'\n// unreviewed\n',raw+raw])expect(()=>reverseGroupSource(row.file,bad)).toThrow();
   for(const key of ['before_sha256','after_sha256'] as const){const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)![key]='0'.repeat(64);expect(()=>reverseGroupSource(row.file,raw,forged)).toThrow();}
   for(const key of ['before_line','after_line'] as const){const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)!.edits[0]![key]=2;expect(()=>reverseGroupSource(row.file,raw,forged)).toThrow();}
   const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)!.edits.push({...row.edits[0]!});expect(()=>reverseGroupSource(row.file,raw,forged)).toThrow();
  });
  if(oldPorts(row.file))it('keeps prior assertions and negative fixtures exact '+row.file,()=>{expect(stripImports(row.edits[0]!.after_source)).toBe(stripImports(row.edits[0]!.before_source));});
  if(row.file===permissionTest)it('only extends the existing owner contract case by the exact Group family and import',()=>{
   const change=proof.permission_test_extension;expect(change.file).toBe(row.file);expect(change.unchanged_case_count).toBe(24);
   const before=row.edits[0]!.before_source,after=row.edits[0]!.after_source;expect(sha(before)).toBe(change.before_sha256);expect(sha(after)).toBe(change.after_sha256);
   expect(after.split(change.added_source)).toHaveLength(2);expect(after.split('  isAdminGroupRecoveryRoute,\n')).toHaveLength(2);
   expect(after.replace(change.added_source,'').replace('  isAdminGroupRecoveryRoute,\n','')).toBe(before);
   for(const text of ['pair("GET", `${prefix}/user/group/author/receipt/:operationId`)','pair("POST", `${prefix}/user/group/author/resolve`)'])expect(change.added_source).toContain(text);
  });
  if(row.file===frontendTest)it('preserves all five previous behavioral purposes through the real current native template protocol',()=>{
   const change=proof.frontend_test_maintenance,before=frontendCases(row.edits[0]!.before_source),after=frontendCases(row.edits[0]!.after_source);
   expect(change.file).toBe(row.file);expect(change.case_count).toBe(5);expect(change.counts_as_new).toBe(false);expect(before).toHaveLength(5);expect(after).toHaveLength(5);
   expect(after.map(c=>c.title)).toEqual(before.map(c=>c.title));expect(change.cases.map(c=>c.title)).toEqual(before.map(c=>c.title));
   for(let i=0;i<5;i++){const c=change.cases[i]!;expect(c.purpose).not.toBe('');expect(sha(before[i]!.source)).toBe(c.before_sha256);expect(sha(after[i]!.source)).toBe(c.after_sha256);expect(c.negative_mappings.length).toBeGreaterThan(0);for(const m of c.negative_mappings){expect(before[i]!.source).toContain(m.before);expect(after[i]!.source).toContain(m.after);}}
   expect(row.edits[0]!.after_source).toContain('helpers/group-author-runtime.cjs');expect(row.edits[0]!.after_source).not.toContain('return () => null');
  });
 }
 for(const row of proof.full_additions)it('pins complete new file '+row.file,()=>{const raw=readFileSync(resolve(root,row.file));expect(raw.byteLength).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);});
 for(const row of proof.PHP_sources)it('pins complete fixed PHP source '+row.file,()=>{expect(proof.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');expect(sha(row.raw_utf8)).toBe(row.sha256);expect(new TextEncoder().encode(row.raw_utf8).byteLength).toBe(row.bytes);});
 const frozen=Object.entries(proof.frozen_predecessor_evidence);
 for(let index=0;index<frozen.length;index+=64)it(`preserves accepted predecessor bytes ${index+1}..${Math.min(index+64,frozen.length)}`,()=>{for(const[file,hash]of frozen.slice(index,index+64))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);});
 it('keeps original CRUD, user assignment and authority/privilege sources byte-identical',()=>{
  for(const[file,hash]of Object.entries(proof.observed_unchanged))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);
  for(const file of ['workers-ts/src/services/admin/AdminUserGroupService.ts','workers-ts/src/controllers/api/v1/AdminUserGroupController.ts','workers-ts/src/services/user/UserSegmentationService.ts','workers-ts/src/services/user/MobileUserManagementCore.ts','workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts'])expect(Object.hasOwn(proof.observed_unchanged,file)).toBe(true);
 });
 it('composes Group before Delivery and keeps27 source suites import-only',()=>{
  expect(proof.sources.filter(row=>oldPorts(row.file))).toHaveLength(27);expect(proof.sources.some(r=>r.file==='workers-ts/test/admin-delivery-source-binding.test.ts')).toBe(true);
  for(const file of ['workers-ts/src/routes/adminapi.ts','workers-ts/src/routes/v1/index.ts']){const before=reverseGroupSource(file,read(file));expect(readGroupPredecessor(resolve(root,file),'utf8')).toBe(before);expect(readDeliveryPredecessor(resolve(root,file),'utf8')).toBe(reverseDeliverySource(file,before));}
  expect(sha(proof.previous_report.raw_utf8)).toBe(deliverySourceBinding.current_report.sha256);expect(proof.full_additions.some(row=>row.file==='workers-ts/test/helpers/groupSourceBinding.ts')).toBe(false);
 });
 it('never reverses an unowned file or modifies old accepted Delivery proof/helper/doc',()=>{
  expect(reverseGroupSource('unrelated.ts','unrelated group text')).toBe('unrelated group text');
  for(const file of ['workers-ts/test/helpers/deliverySourceBinding.ts','workers-ts/audit/delivery-author-source-binding-20261026.json','workers-ts/docs/php-ts-delivery-author-20261026.md'])expect(proof.sources.some(r=>r.file===file)).toBe(false);expect(Object.keys(proof.frozen_predecessor_evidence)).toHaveLength(1715);
 });
 it('rebuilds actual759/797 while retaining all755 prior call objects and three old wrappers',()=>{
  const current=buildAdminFrontendApiAuditReport(),before=buildGroupPredecessorApiAuditReport();expect(JSON.stringify(current,null,2)+'\n').toBe(read(proof.current_report.file));expect(sha(read(proof.current_report.file))).toBe(proof.current_report.sha256);
  expect(before.counts).toEqual({callSites:755,pathVariants:793,registered:793,executable:793,controlledUnavailable:0,unregistered:0,unresolved:0});expect(current.counts).toEqual({callSites:759,pathVariants:797,registered:797,executable:797,controlledUnavailable:0,unregistered:0,unresolved:0});
  for(const call of before.calls)expect(current.calls).toContainEqual(call);expect(proof.retired_api_calls).toEqual([]);
  expect(current.calls.filter(c=>c.source==='view/admin-ts/src/api/userGroups.ts')).toEqual(before.calls.filter(c=>c.source==='view/admin-ts/src/api/userGroups.ts'));
  expect(current.calls.filter(c=>c.source==='view/admin-ts/src/api/groupAuthor.ts').map(c=>[c.method,c.path])).toEqual([['GET','/user/group/author/catalog'],['POST','/user/group/author/commit'],['GET','/user/group/author/receipt/:param'],['POST','/user/group/author/resolve']]);
 });
 it('binds the original routed single-name form and recognizes the old unused icon slot as unauthored',()=>{
  expect(php('view/admin/src/router/modules/user.js')).toContain("path: '/admin/user/group'");const service=php('app/services/user/group/UserGroupServices.php');expect(service).toContain("Form::input('group_name'");expect(service).toContain("Form::hidden('id'");expect(service).toContain('maxlength(20)');expect(GROUP_FIELDS).toEqual(['group_name']);
  const page=php('view/admin/src/pages/user/group/index.vue');expect(page).toContain("key: 'group_name'");expect(page).toContain('limit: 10');expect(page).not.toContain("key: 'icon'");
 });
 it('keeps only raw name in the authored payload and rejects new metadata',()=>{
  expect(newGroupValues()).toEqual({group_name:''});const a=action();expect(groupAction(a,1)).toEqual(a);for(const patch of [{image:'ticket'},{sort:1},{status:1},{pid:2}])expect(()=>groupAction({...a,payload:{...a.payload,...patch}},1)).toThrow();
 });
 it('binds the exact raw-name canonical domain and property order',()=>{const a=action();expect(groupCanonical(a)).toEqual({domain:'user-group-author-v1',actor_id:1,operation_id:a.operation_id,operation:'update',target_id:20,revision:a.revision,payload:{group_name:'原名称'}});expect(Object.keys(groupCanonical(a))).toEqual(['domain','actor_id','operation_id','operation','target_id','revision','payload']);});
 it('rejects foreign actor, unknown operation, wrong target and extra envelope',()=>{const a=action();for(const x of [{...a,actor_id:2},{...a,operation:'show'},{...a,target_id:0},{...a,extra:true}])expect(()=>groupAction(x,1)).toThrow();});
 it('strictly binds committed and not-applied result targets, counters and original revision',()=>{
  const a=action(),{payload:_,...metadata}=a,result={id:20,created:0,updated:1,count:1,revision:'c'.repeat(64)};expect(groupReceipt({...metadata,state:'committed',result},a).state).toBe('committed');
  for(const patch of [{id:21},{created:1},{updated:0}])expect(()=>groupReceipt({...metadata,state:'committed',result:{...result,...patch}},a)).toThrow();const no={id:20,created:0,updated:0,count:0,revision:a.revision};expect(groupReceipt({...metadata,state:'not_applied',result:no},a).state).toBe('not_applied');for(const patch of [{count:1},{revision:'d'.repeat(64)}])expect(()=>groupReceipt({...metadata,state:'not_applied',result:{...no,...patch}},a)).toThrow();
 });
 it('requires a complete catalog without duplicate, missing tail, extra values or unknown readiness',()=>{
  const c={list:[{id:1,group_name:''}],count:1,revision:'a'.repeat(64),write_ready:true};expect(groupCatalog(c)).toEqual(c);for(const patch of [{count:2},{list:[...c.list,...c.list],count:2},{extra:1},{write_ready:1},{list:[{id:1,group_name:'😀'.repeat(65)}]}])expect(()=>groupCatalog({...c,...patch})).toThrow();
 });
 it('preserves exact historical names but rejects changed C0/C1 or malformed Unicode',()=>{for(const name of ['','  ','\u0000旧\u0085'])expect(groupName(name,name)).toBe(name);expect(groupName('😀'.repeat(64))).toBe('😀'.repeat(64));for(const name of ['',' '.repeat(20),'😀'.repeat(65),'坏\u0085值','坏\ud800值'])expect(()=>groupName(name)).toThrow();});
 it('separates raw4096 signed budget from normalized64 Unicode and old form20',()=>{const name=' '.repeat(100)+'😀'.repeat(64);expect(groupName(name)).toBe('😀'.repeat(64));expect(groupAction({...action(),payload:{group_name:name}},1).payload.group_name).toBe(name);expect(()=>groupAction({...action(),payload:{group_name:' '.repeat(4097)}},1)).toThrow();expect(proof.boundaries.values).toContain('4096');});
 it('checks an exact prior UUID before source version while preserving unknown receipt semantics',()=>{const service=read('workers-ts/src/services/admin/AdminGroupAuthorService.ts'),mutation=service.slice(service.indexOf('  mutate('));expect(mutation.indexOf('await this.prior(tx,action)')).toBeGreaterThanOrEqual(0);expect(mutation.indexOf('await this.prior(tx,action)')).toBeLessThan(mutation.indexOf('action.revision!==before.revision'));for(const text of ['UUID before','Missing404','not_applied'])expect(proof.boundaries.recovery).toContain(text);});
 it('records actual old writer/assignment fences without altering consumers',()=>{for(const value of ['731621,0','SHARE ROW EXCLUSIVE NOWAIT','731638,1','FOR UPDATE NOWAIT','KEY SHARE'])expect(proof.boundaries.concurrency).toContain(value);const old=read('workers-ts/src/services/user/UserSegmentationService.ts');expect(old).toContain('.for("key share")');expect(old).toContain('async assignGroup(');});
 it('records live read/manage and owner recovery rather than an expanded user writer',()=>{for(const value of ['user.view','user.manage','Recovery','role-reference'])expect(proof.boundaries.authority).toContain(value);expect(proof.boundaries.scope).toContain('Existing CRUD was already migrated');});
 it('records the independent immutable receipt addon and explicit native commissioning boundary',()=>{for(const value of ['immutable9','Admin SELECT/INSERT','731626,21','no HTTP/startup DDL'])expect(proof.boundaries.receipt).toContain(value);expect(proof.full_additions.some(row=>row.file==='workers-ts/test/admin-group-author-native.test.ts')).toBe(true);});
 it('records native cached event leases, stable input and sequential nonsecret UUID journals',()=>{for(const value of ['cacheHandlers:true','stable name input','per-owner UUID','ABA','abort'])expect(proof.boundaries.frontend).toContain(value);expect(proof.boundaries.search).toContain('client10/page');});
 it('discloses existing frontend5 maintenance separately from new tests and immutable source ports',()=>{for(const value of ['Twenty-seven','other24','old5 not new','No predecessor page'])expect(proof.boundaries.tests).toContain(value);expect(proof.frontend_test_maintenance.counts_as_new).toBe(false);});
 it('keeps mobile39 true turn-start bytes frozen and old late-before evidence only in Delivery',()=>{expect(proof.sources.some(row=>row.file===mobileTest)).toBe(false);expect(sha(read(mobileTest))).toBe(proof.observed_unchanged[mobileTest]);expect(proof.baseline).toEqual({file_count:7181,sha256:'23d29222853cf64cfe1491893cc4dc11b5cca73ca05fab664967ebace9028ae9'});for(const value of ['mobile39','No new mobile','previous Delivery late-before'])expect(proof.boundaries.mobile).toContain(value);});
 it('does not present source evidence or preparation as runtime acceptance or complete migration',()=>{for(const value of ['Source-only','Not acceptance','1715','11 complete'])expect(proof.boundaries.evidence).toContain(value);expect(proof.boundaries.scope).toContain('Existing CRUD');expect(proof.retired_api_calls).toEqual([]);});
});
