import {createHash} from 'node:crypto';
import {readStorePredecessor as readFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {buildStorePredecessorApiAuditReport as buildAdminFrontendApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {userLabelSourceBinding as proof,reverseUserLabelSource,readUserLabelPredecessor,readLevelPredecessor,levelSourceBinding,reverseLevelSource,buildUserLabelPredecessorApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {CATEGORY_FIELDS,LABEL_FIELDS,LABEL_OPERATIONS,labelAction,labelCanonical,labelReceipt,type LabelAction} from '../../view/common/labelAuthor';
import {checkedLabelDirectoryCatalog,planLabelDirectoryExport,planLabelDirectoryImport,recoverLabelDirectoryCreate} from '@/services/work/LabelDirectorySyncPlan';

const root=resolve(import.meta.dirname,'../..');
const read=(file:string)=>readFileSync(resolve(root,file),'utf8');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const stripImports=(value:string)=>value.replace(/^import[\s\S]*?;\n/gmu,'');
function between(value:string,start:string,end:string){const a=value.indexOf(start),b=value.indexOf(end,a+start.length);if(a<0||b<0)throw Error(`Missing exact source boundary: ${start} -> ${end}`);return value.slice(a,b);}
function modified(file:string){const row=proof.sources.find(r=>r.file===file);if(!row)throw Error('Missing complete current/predecessor source: '+file);return row;}
function php(file:string){const row=proof.PHP_sources.find(r=>r.file===file);if(!row)throw Error('Missing complete fixed PHP source: '+file);return row.raw_utf8;}
const retiredSource='view/admin-ts/src/pages/label/LabelList.vue';

describe('ordinary user-label/category full author exact sources, durable sync and preserved accepted predecessors',()=>{
 for(const row of proof.sources){
  it('pins complete current source and its exact predecessor '+row.file,()=>{
   const actual=read(row.file);expect(sha(actual)).toBe(row.after_sha256);
   expect(sha(reverseUserLabelSource(row.file,actual))).toBe(row.before_sha256);
   expect(sha(readUserLabelPredecessor(resolve(root,row.file)))).toBe(row.before_sha256);
  });
  it('rejects truncation, suffix, duplicate source and forged exact inverse '+row.file,()=>{
   const actual=read(row.file);for(const bad of [actual.slice(1),actual+'\n// unreviewed\n',actual+actual])expect(()=>reverseUserLabelSource(row.file,bad)).toThrow();
   for(const key of ['before_sha256','after_sha256'] as const){const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)![key]='0'.repeat(64);expect(()=>reverseUserLabelSource(row.file,actual,forged)).toThrow();}
   for(const key of ['before_line','after_line'] as const){const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)!.edits[0]![key]=2;expect(()=>reverseUserLabelSource(row.file,actual,forged)).toThrow();}
   const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)!.edits.push({...row.edits[0]!});expect(()=>reverseUserLabelSource(row.file,actual,forged)).toThrow();
  });
  if(row.file.startsWith('workers-ts/test/')&&row.file.endsWith('.test.ts'))it('retains all old assertions and negative fixtures '+row.file,()=>{
   expect(stripImports(row.edits[0]!.after_source)).toBe(stripImports(row.edits[0]!.before_source));
  });
 }
 for(const row of proof.full_additions)it('pins complete new source '+row.file,()=>{const raw=readFileSync(resolve(root,row.file));expect(raw.byteLength).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);});
 for(const row of proof.PHP_sources)it('pins complete fixed PHP original '+row.file,()=>{
  expect(proof.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');expect(sha(row.raw_utf8)).toBe(row.sha256);expect(new TextEncoder().encode(row.raw_utf8).byteLength).toBe(row.bytes);
 });
 const frozen=Object.entries(proof.frozen_predecessor_evidence);
 for(let start=0;start<frozen.length;start+=64)it(`retains every accepted dated proof, helper and document ${start+1}..${Math.min(start+64,frozen.length)}`,()=>{
  for(const[file,hash]of frozen.slice(start,start+64))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);
 });

 it('retains current C7 authority, mature consumers, pricing, authentication and the original business privilege plan',()=>{
  for(const[file,hash]of Object.entries(proof.observed_unchanged))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);
  for(const file of ['workers-ts/src/services/work/EnterpriseWechatExternalTagProjection.ts','workers-ts/src/services/user/UserSegmentationService.ts',
   'workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts','workers-ts/src/services/admin/AdminAuthorityWriteService.ts',
   'workers-ts/src/middleware/admin-auth.ts','workers-ts/src/middleware/admin-runtime-auth.ts',
   'view/admin-ts/src/utils/auth.ts','view/admin-ts/src/utils/request.ts','view/admin-ts/src/stores/auth.ts',
   'view/admin-ts/src/pages/label/ProductLabelCatalog.vue','view/admin-ts/src/api/productLabelCatalog.ts'])expect(Object.hasOwn(proof.observed_unchanged,file),file).toBe(true);
 });
 it('composes the label inverse outside the immutable accepted Level layer and verifies all 23 old reader ports',()=>{
  for(const file of ['workers-ts/src/routes/adminapi.ts','workers-ts/src/routes/v1/index.ts','workers-ts/src/controllers/api/v1/AdminCrudController.ts',
   'workers-ts/src/services/admin/AdminPermissionService.ts','workers-ts/src/migrations/auditRuntimeBusinessPrivileges.ts','view/admin-ts/src/router/index.ts']){
   const prior=reverseUserLabelSource(file,read(file));expect(readUserLabelPredecessor(resolve(root,file),'utf8')).toBe(prior);
   expect(readLevelPredecessor(resolve(root,file),'utf8')).toBe(reverseLevelSource(file,prior));
  }
  const ports=proof.sources.filter(r=>r.file.startsWith('workers-ts/test/')&&r.file.endsWith('.test.ts'));
  expect(ports).toHaveLength(23);expect(ports.some(r=>r.file==='workers-ts/test/admin-level-source-binding.test.ts')).toBe(true);
  expect(proof.full_additions.some(r=>r.file==='workers-ts/test/helpers/userLabelSourceBinding.ts')).toBe(false);
  expect(proof.frozen_predecessor_evidence['workers-ts/test/helpers/levelSourceBinding.ts']).toBe(sha(read('workers-ts/test/helpers/levelSourceBinding.ts')));
  expect(sha(proof.previous_report.raw_utf8)).toBe(levelSourceBinding.current_report.sha256);
 });
 it('does not generalize a reverse mapping onto unrelated files or rewrite a historical proof',()=>{
  const raw='unrelated /user_label/catalog source';expect(reverseUserLabelSource('unrelated.ts',raw)).toBe(raw);
  expect(proof.sources.some(r=>r.file.endsWith('levelSourceBinding.ts'))).toBe(false);
  expect(proof.sources.some(r=>r.file==='workers-ts/audit/level-author-source-binding-20261026.json')).toBe(false);
 });
 it('rebuilds the actual executable API inventory with the six exact retired calls and five explicit replacements',()=>{
  const current=buildAdminFrontendApiAuditReport(),raw=read(proof.current_report.file),before=buildUserLabelPredecessorApiAuditReport();
  expect(JSON.stringify(current,null,2)+'\n').toBe(raw);expect(sha(raw)).toBe(proof.current_report.sha256);
  expect(before.counts).toEqual({callSites:734,pathVariants:772,registered:772,executable:772,controlledUnavailable:0,unregistered:0,unresolved:0});
  expect(current.counts).toEqual({callSites:733,pathVariants:771,registered:771,executable:771,controlledUnavailable:0,unregistered:0,unresolved:0});
  const retired=before.calls.filter(c=>c.source===retiredSource);expect(proof.retired_api_calls).toEqual(retired);expect(retired).toHaveLength(6);
  expect(retired.map(c=>[c.method,c.path])).toEqual([['GET','/product_label/list'],['POST','/product_label/save'],['DELETE','/product_label/del/:param'],['GET','/user_label/list'],['POST','/user_label/save'],['DELETE','/user_label/del/:param']]);
  expect(current.calls.filter(c=>c.source===retiredSource)).toEqual([]);
  for(const call of before.calls.filter(c=>c.source!==retiredSource))expect(current.calls).toContainEqual(call);
  const added=current.calls.filter(c=>c.source==='view/admin-ts/src/api/labelAuthor.ts');expect(added).toHaveLength(5);
  expect(added.map(c=>[c.method,c.path])).toEqual([['GET','/user_label/catalog'],['POST','/user_label/author/commit'],['GET','/user_label/author/receipt/:param'],['POST','/user_label/author/resolve'],['POST','/user_label/sync/advance']]);
  for(const call of retired)expect(current.backend.registeredRoutes.some(r=>r.method===call.method&&r.path===call.matchedRoute&&r.availability==='executable'),call.path).toBe(true);
 });
 it('binds retirement to the complete former mixed page, reachable mature product author and retained compatibility handlers',()=>{
  const row=modified(retiredSource),before=row.edits[0]!.before_source,after=row.edits[0]!.after_source,router=read('view/admin-ts/src/router/index.ts');
  for(const path of ['/product_label/list','/product_label/save','/product_label/del/','/user_label/list','/user_label/save','/user_label/del/'])expect(before).toContain(path);
  expect(after).not.toMatch(/request\.(?:get|post|put|delete)\(/u);expect(after).toContain('href="/label/products"');
  expect(after).toContain("from '@/api/labelAuthor'");expect(router).toContain('path: "label/products"');expect(router).toContain('@/pages/label/ProductLabelCatalog.vue');
  expect(router).toContain('alias: "/admin/user/label/"');
  for(const file of ['workers-ts/src/routes/adminapi.ts','workers-ts/src/routes/v1/index.ts']){
   const routes=read(file);for(const handler of ['AdminCrud.adminUserLabelList','AdminCrud.adminUserLabelSave','AdminCrud.adminUserLabelDel','AdminCrud.adminProductLabelList','AdminCrud.adminProductLabelSave','AdminCrud.adminProductLabelDel'])expect(routes).toContain(handler);
  }
 });
 it('binds the active PHP cate page, selected-category add, ten-row pagination and live enterprise-sync action',()=>{
  const page=php('view/admin/src/pages/user/label/cate.vue'),userRoutes=php('view/admin/src/router/modules/user.js');
  expect(page).toContain('userLabelAddApi(0,{label_cate:id})');expect(page).toContain('label_cate:');expect(page).toContain('limit: 10');
  expect(page).toContain('userLabeSync()');expect(page).toContain('workLabelSync()');expect(userRoutes).toContain("@/pages/user/label/cate");
  const service=php('app/services/user/label/UserLabelServices.php'),form=between(service,'    public function add(int $id','    /**\n\t * 保存标签表单数据');
  expect([...new Set(Array.from(form.matchAll(/Form::(?:select|input)\('([^']+)'/gu),m=>m[1]))]).toEqual(['label_cate','label_name']);
  const categories=php('app/services/user/label/UserLabelCateServices.php'),categoryForm=between(categories,'    public function labelCateForm(','    /**');
  expect(Array.from(categoryForm.matchAll(/FormBuilder::(?:input|number)\('([^']+)'/gu),m=>m[1])).toEqual(['name','sort']);
  expect(service).toContain("UserLabelJob::dispatchDo('authLabel'");expect(service).toContain('public function addCorpClientLabel(');
  expect(LABEL_FIELDS).toEqual(['name','label_cate','color','sort','status']);expect(CATEGORY_FIELDS).toEqual(['name','sort']);
 });
 it('binds complete platform scope, original extension metadata and atomic all-row readback',()=>{
  const service=read('workers-ts/src/services/admin/AdminUserLabelAuthorService.ts');
  expect(service).toContain('r.type===0&&r.relationId===0');expect(service).toContain('r.ownerId===0&&r.group===0');
  expect(service).toContain('.limit(5001)');expect(service).toContain('.limit(10001)');expect(service).toContain('8*1024*1024');
  expect(service).toContain('before.categories.map(labelPlain)');expect(service).toContain('before.labels.map(labelPlain)');
  expect(service).toContain('Object.entries(values).some(');expect(service).toContain('分类/标签完整写后回读不一致');
  expect(service).toContain('if(v===old)return String(v)');expect(service).toContain("tagId:''");expect(service).toContain('other:null');
  expect(service).not.toContain('AUTO_TAG');expect(service).not.toContain('signAttachment');
 });
 it('binds original UUID before stale-version check and owner recovery independent of manage',()=>{
  const service=read('workers-ts/src/services/admin/AdminUserLabelAuthorService.ts'),mutate=service.slice(service.indexOf(' mutate(v:unknown'));
  expect(mutate.indexOf('await this.events(tx,a)')).toBeGreaterThanOrEqual(0);expect(mutate.indexOf('await this.events(tx,a)')).toBeLessThan(mutate.indexOf('before.revision!==a.revision'));
  expect(service).toContain('this.transaction(actor,true,true');expect(service).toContain('this.transaction(actor,false,true');
  expect(service).toContain('loadAdminProfileActor(tx,actor)');expect(service).toContain('authorizeAdminLegacyProductRead(tx,actor,\'label.view\')');
  expect(service).toContain('loadAdminAuthorityLiveActor(tx,actor,\'label.manage\')');expect(service).toContain('assertAdminLegacyProductReadDeadline(tx,actor)');
  expect(service).toContain('operation_id!==a.operation_id');expect(service).toContain('result.command_id');
 });
 it('binds common authority/table locks, references across all scopes and atomic relation cleanup',()=>{
  const service=read('workers-ts/src/services/admin/AdminUserLabelAuthorService.ts');
  expect(service).toContain('acquireAdminAuthorityWriteBarrier(tx)');expect(service).toContain('LOCK TABLE ONLY public.category,ONLY public.user_label IN ACCESS EXCLUSIVE MODE NOWAIT');
  expect(service).toContain('pg_advisory_xact_lock(731630,1)');expect(service).toContain('ONLY public.store_product IN SHARE ROW EXCLUSIVE MODE NOWAIT');
  expect(service).toContain('before.labels.some(r=>r.labelCate===id)');expect(service).toContain('before.categories.some(r=>r.pid===id)');
  expect(service).toContain('rows.some(r=>!platformLabel(r))');expect(service).toContain('Number(token.trim())');expect(service).toContain('JSON.parse(order.snapshot!)');
  expect(service).toContain("k==='label_id'");expect(service).toContain('eq(userLabelRelation.type,0)');expect(service).toContain('eq(userLabelRelation.relationId,0)');
  expect(read('workers-ts/test/admin-label-native.test.ts')).toContain('new UserSegmentationService(');
  expect(read('workers-ts/test/admin-label-native.test.ts')).toContain('work=consumer.setUserLabels(');
  expect(read('workers-ts/test/admin-label-native.test.ts')).toContain('RowShareLock');
 });
 it('binds the independent immutable append-only event addon without changing business DML grants',()=>{
  const addon=read('workers-ts/src/migrations/adminLabelOperation.ts'),upgrade=read('workers-ts/src/migrations/runAdminLabelUpgrade.ts');
  expect(addon).toContain("app: [], admin: ['SELECT', 'INSERT']");expect(addon).toContain('CREATE TABLE public.admin_label_operation');
  expect(addon).toContain('BEFORE UPDATE OR DELETE');expect(addon).toContain('BEFORE TRUNCATE');expect(addon).toContain('SECURITY INVOKER');
  expect(addon).toContain('pg_try_advisory_xact_lock_shared(731626,17)');expect(addon).toContain('current_user=session_user');
  expect(addon).toContain("'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'");expect(upgrade).toContain('pg_try_advisory_xact_lock(731626,17)');
  expect(upgrade).toContain("isolationLevel: 'read committed'");expect(upgrade).toContain('GRANT SELECT, INSERT ON TABLE public.admin_label_operation');
  expect(upgrade).not.toMatch(/GRANT[^;]*ON (?:TABLE )?public\.(?:category|user_label)\b/u);
 });
 it('binds distinct queued/planned/dispatch/confirmed terminal semantics and durable command anchor',()=>{
  const service=read('workers-ts/src/services/admin/AdminUserLabelAuthorService.ts'),sync=read('workers-ts/src/services/admin/AdminUserLabelSyncService.ts');
  expect(service).toContain('rows.at(-1)');expect(service).toContain("operation_id!==a.operation_id");expect(service).toContain('steps.size!==rows.length');
  expect(service).toContain("dispatch:['confirmed']");expect(service).toContain("confirmed:['planned','committed','stopped']");
  expect(service).toContain("'stopped',events.length");expect(service).toContain('此前批次远端创建已确认');
  expect(sync.indexOf("'dispatch',events.length")).toBeLessThan(sync.indexOf('prepared.provider.corpTagCreate('));
  expect(sync).toContain('recoverLabelDirectoryCreate(');expect(sync).toContain('planLabelDirectoryImport(');expect(sync).toContain('last.operation_id!==prepared.last!.operation_id');
 });
 it('keeps old C7 targeted read and strategy method bytes while adding one independent 1MiB directory read',()=>{
  const row=modified('workers-ts/src/services/work/EnterpriseWechatProviderClient.ts'),before=row.edits[0]!.before_source,after=row.edits[0]!.after_source;
  const end='    });\n  }',method=(s:string,start:string)=>{const a=s.indexOf(start),b=s.indexOf(end,a);if(a<0||b<0)throw Error('Missing provider method');return s.slice(a,b+end.length);};
  expect(method(after,'  async corpTagList(')).toBe(method(before,'  async corpTagList('));expect(method(after,'  async strategyTagList(')).toBe(method(before,'  async strategyTagList('));
  const directory=between(after,'  async corpTagDirectory(', '  /** One explicitly journaled');
  expect(directory).toContain('maxResponseBytes: MAX_RESPONSE_BYTES');expect(directory).toContain('tag_id: [], group_id: []');expect(directory).toContain('method: "POST"');
  const create=between(after,'  async corpTagCreate(','  async strategyTagList(');
  expect(create).toContain('"/cgi-bin/externalcontact/add_corp_tag"');expect(create).toContain('INVALID_ACCESS_TOKEN_CODES.has(code)');expect(create).toContain('"unknown"');
 });
 it('confirms fresh string identities after exact dispatch and rejects same-name preexisting or unrelated remote changes',()=>{
  const local={categories:[{id:10,type:0,relationId:0,ownerId:0,group:0,name:'Customers',sort:5,other:null}],labels:[{id:20,type:0,relationId:0,labelCate:10,name:'VIP',sort:9,tagId:''}]};
  const before=checkedLabelDirectoryCatalog({errcode:0,tag_group:[]}),plan=planLabelDirectoryExport(local,before),command=plan.requests[0]!;
  const raw={errcode:0,tag_group:[{group_id:'et-group',group_name:'Customers',order:5,create_time:1788000000,tag:[{id:'et-tag',name:'VIP',order:9,create_time:1788000000}]}]},after=checkedLabelDirectoryCatalog(raw);
  expect(recoverLabelDirectoryCreate(before,command,after)).toEqual({groupId:'et-group',labels:[{localId:20,remoteId:'et-tag'}],evidence:'new-identities-after-exact-request'});
  expect(planLabelDirectoryImport(local,after).mappings.labels).toEqual([{localId:20,remoteId:'et-tag',groupId:'et-group'}]);
  expect(()=>recoverLabelDirectoryCreate(after,command,after)).toThrow();
  expect(()=>recoverLabelDirectoryCreate(before,command,checkedLabelDirectoryCatalog({...raw,tag_group:[...raw.tag_group,{group_id:'et-extra',group_name:'Extra',order:0,create_time:1788000000,tag:[]}]}))).toThrow();
  expect(()=>checkedLabelDirectoryCatalog({...raw,has_more:false})).toThrow();
 });
 it('binds Queue HMAC before opening Admin SQL and original credential/deadline before every provider stage',()=>{
  const queue=read('workers-ts/src/services/admin/AdminUserLabelSyncQueue.ts'),body=queue.slice(queue.indexOf('export async function dispatchQueuedUserLabelSync'));
  expect(body.indexOf('checked(value,env)')).toBeLessThan(body.indexOf('createAdminDatabaseSession(env)'));expect(body.indexOf("reason:'expired'")).toBeLessThan(body.indexOf('createAdminDatabaseSession(env)'));
  expect(queue).toContain('timingSafeEqual(');expect(queue).toContain('labelActorStamp(env.APP_KEY,md5(row.pwd))');expect(queue).toContain('result.data.actorStamp');expect(queue).toContain('result.data.expiresAt');
  expect(queue).toContain('await session.close()');expect(queue).toContain('r.step===prior');
  const entry=read('workers-ts/src/index.ts');expect(entry).toContain('dispatchQueuedUserLabelSync(msg.body,env)');expect(entry).toContain('msg.retry({delaySeconds:30})');expect(entry).toContain('msg.retry({delaySeconds:60})');
 });
 it('binds both exact authenticated route families, selected-category legacy forms, old id response and owner recovery',()=>{
  for(const[file,prefix]of [['workers-ts/src/routes/adminapi.ts',''],['workers-ts/src/routes/v1/index.ts','/admin']] as const){
   const routes=read(file);for(const[path,handler]of [['/user_label/catalog','catalog'],['/user_label/author/commit','commit'],['/user_label/author/receipt/:operationId','receipt'],['/user_label/author/resolve','resolve'],['/user_label/sync/advance','advance'],['/user/user_label','legacyList'],['/user/synchro/work/label','legacySync']])
    expect(routes).toContain(`"${prefix+path}", adminAuth, UserLabelAuthor.${handler}`);
  }
  const controller=read('workers-ts/src/controllers/api/v1/AdminUserLabelAuthorController.ts');expect(controller).toContain("q.label_cate===''");expect(controller).toContain("['label_cate']");expect(controller).toContain('query.label_cate??0');expect(controller).toContain('{id:result.result.id}');
  const crud=read('workers-ts/src/controllers/api/v1/AdminCrudController.ts');for(const name of ['modernList','save','remove'])expect(crud).toContain(`import('./AdminUserLabelAuthorController')).${name}(c)`);
  const permissions=read('workers-ts/src/services/admin/AdminPermissionService.ts');expect(permissions).toContain('isAdminUserLabelRecoveryRoute(method,routePath)');expect(permissions).toContain("return 'label.manage'");
 });
 it('validates local terminal receipts separately from queued sync before removing the original journal',()=>{
  expect(LABEL_OPERATIONS).toEqual(['label_create','label_update','label_delete','category_create','category_update','category_delete','sync']);
  const a:LabelAction={operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation:'label_update',target_id:20,revision:'a'.repeat(64),payload:{name:'N',label_cate:10,color:'#336699',sort:0,status:1},payload_hash:'b'.repeat(64)};
  expect(labelAction(a,1)).toEqual(a);expect(labelCanonical(a)).toMatchObject({domain:'user-label-author-v1',actor_id:1,payload:a.payload});
  const{payload:_,...meta}=a,result={id:20,created:0,updated:1,count:1,revision:'c'.repeat(64),message:'已完成'};
  expect(labelReceipt({...meta,state:'committed',step:0,result},a).state).toBe('committed');
  for(const bad of [{...result,id:21},{...result,created:1},{...result,updated:0}])expect(()=>labelReceipt({...meta,state:'committed',step:0,result:bad},a)).toThrow();
  expect(()=>labelReceipt({...meta,state:'queued',step:0,result},a)).toThrow();
  expect(()=>labelReceipt({...meta,state:'not_applied',step:0,result:{...result,updated:0,count:0,revision:a.revision}}, {...a,actor_id:2})).toThrow();
 });
 it('binds stable local-loop native callbacks, revision ABA and nonsecret per-owner UUID journal before dispatch',()=>{
  const page=read(retiredSource),state=read('view/admin-ts/src/utils/userLabelState.ts');
  for(const value of ['v-for="screen in screens"','v-for="item in rows"','v-for="editor in editors"','v-for="field in editor.fields"','v-for="confirmation in confirmations"'])expect(page).toContain(value);
  expect(page).toContain('cinashop_user_label_pending_v1_');expect(page).toContain("window.addEventListener('storage'");expect(page).toContain("window.removeEventListener('storage'");
  expect(page).toContain("watch(()=>route.fullPath,schedule,{flush:'sync'})");expect(page).toContain('generation++;model.dispose()');
  expect(state).toContain('e.version++');expect(state).toContain('source===state.source');expect(state).toContain('requests.forEach(c=>c.abort())');
  expect(state.indexOf('deps.persist(s.actor,a)')).toBeLessThan(state.lastIndexOf('void run(a)'));expect(state).toContain('r.step===previous');
  expect(state).toContain('deps.persist(s.actor,null,a)');expect(page).not.toContain('frameImage');
 });
});
