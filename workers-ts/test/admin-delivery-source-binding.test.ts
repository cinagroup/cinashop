import {createHash} from 'node:crypto';
import {readGroupPredecessor as readFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {buildGroupPredecessorApiAuditReport as buildAdminFrontendApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {deliverySourceBinding as proof,reverseDeliverySource,readDeliveryPredecessor,readStaffPredecessor,staffSourceBinding,reverseStaffSource,buildDeliveryPredecessorApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {DELIVERY_FIELDS,newDeliveryValues,deliveryAction,deliveryCanonical,deliveryReceipt,type DeliveryAction} from '../../view/common/deliveryAuthor';

const root=resolve(import.meta.dirname,'../..');
const read=(file:string)=>readFileSync(resolve(root,file),'utf8');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const stripImports=(value:string)=>value.replace(/^import[\s\S]*?;\n/gmu,'');
const permissionTest='workers-ts/test/admin-permission.test.ts';
const mobileTest='view/uniapp-ts/scripts/delivery-workbench-runtime.test.cjs';
function permissionFragments(value:string){
 const first='  it("covers every route guarded by adminAuth in both compatibility surfaces",',following="  it('limits video recovery",last='  it("publishes a unique view permission for every menu group",';
 for(const marker of [first,following,last])if(value.split(marker).length!==2)throw Error('Permission maintenance anchors must be unique');
 const a=value.indexOf(first),b=value.indexOf(following,a),c=value.indexOf(last,b),d=value.indexOf('\n  });',c)+'\n  });'.length;
 if(!(0<=a&&a<b&&b<c&&c<d))throw Error('Invalid permission maintenance bounds');
 return {cases:[value.slice(a,b),value.slice(c,d)],rest:stripImports(value.slice(0,a)+'__TWO_TARGETED_ASSERTIONS_1__\n'+value.slice(b,c)+'__TWO_TARGETED_ASSERTIONS_2__'+value.slice(d))};
}
function mobileFragments(value:string){
 const first="test('delivery registration preserves all original 104 pages and startup page',",following="test('anonymous sends no authenticated delivery request'",last="test('legacy staff branch retains genuine staff API while late confirmation cannot execute delivery legacy body',";
 for(const marker of [first,following,last])if(value.split(marker).length!==2)throw Error('Mobile maintenance anchors must be unique');
 const a=value.indexOf(first),b=value.indexOf(following,a),c=value.indexOf(last,b);
 if(!(a<b&&b<c)||value.slice(c).split('\ntest(').length!==1)throw Error('Invalid two mobile maintenance bounds');
 return {cases:[value.slice(a,b),value.slice(c)],rest:value.slice(0,a)+'__MOBILE_CASE_1__\n'+value.slice(b,c)+'__MOBILE_CASE_2__\n'};
}
function php(file:string){const row=proof.PHP_sources.find(r=>r.file===file);if(!row)throw Error('Missing complete fixed PHP original: '+file);return row.raw_utf8;}

// These checks supplement real restricted SQL/Hono, installed Vue/native-host,
// built-browser and independent PG16 execution; source assertions are not those
// runtime receipts and do not establish deployment or real provider validation.
describe('platform delivery complete author exact source increment and immutable accepted predecessors',()=>{
 for(const row of proof.sources){
  it('pins the complete current image and exact full predecessor '+row.file,()=>{
   const actual=read(row.file);expect(sha(actual)).toBe(row.after_sha256);
   expect(sha(reverseDeliverySource(row.file,actual))).toBe(row.before_sha256);
   expect(sha(readDeliveryPredecessor(resolve(root,row.file)))).toBe(row.before_sha256);
  });
  it('rejects changed bytes and a forged generalized inverse '+row.file,()=>{
   const actual=read(row.file);for(const bad of [actual.slice(1),actual+'\n// unreviewed\n',actual+actual])expect(()=>reverseDeliverySource(row.file,bad)).toThrow();
   for(const key of ['before_sha256','after_sha256'] as const){const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)![key]='0'.repeat(64);expect(()=>reverseDeliverySource(row.file,actual,forged)).toThrow();}
   for(const key of ['before_line','after_line'] as const){const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)!.edits[0]![key]=2;expect(()=>reverseDeliverySource(row.file,actual,forged)).toThrow();}
   const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)!.edits.push({...row.edits[0]!});expect(()=>reverseDeliverySource(row.file,actual,forged)).toThrow();
  });
  if(row.file.startsWith('workers-ts/test/')&&row.file.endsWith('.test.ts')&&row.file!==permissionTest)it('retains every prior assertion and negative fixture '+row.file,()=>{
   expect(stripImports(row.edits[0]!.after_source)).toBe(stripImports(row.edits[0]!.before_source));
  });
  if(row.file===permissionTest)it('limits runtime permission maintenance to two already-failing generic assertions and retains the other23 cases',()=>{
   const before=permissionFragments(row.edits[0]!.before_source),after=permissionFragments(row.edits[0]!.after_source);
   expect(before.rest).toBe(after.rest);expect(proof.runtime_test_maintenance).toHaveLength(1);
   const change=proof.runtime_test_maintenance[0]!;expect(change.file).toBe(permissionTest);expect(change.unchanged_case_count).toBe(23);expect(sha(before.rest)).toBe(change.unchanged_source_sha256);
   expect(change.maintained_cases.map(c=>c.title)).toEqual(['covers every route guarded by adminAuth in both compatibility surfaces','publishes a unique view permission for every menu group']);
   for(let i=0;i<2;i++){expect(sha(before.cases[i]!)).toBe(change.maintained_cases[i]!.before_sha256);expect(sha(after.cases[i]!)).toBe(change.maintained_cases[i]!.after_sha256);expect(before.cases[i]).not.toBe(after.cases[i]);}
   expect(sha(change.baseline_receipt.raw_utf8)).toBe(change.baseline_receipt.sha256);
   const result=JSON.parse(change.baseline_receipt.raw_utf8) as {numTotalTests:number;numPassedTests:number;numFailedTests:number;testResults:Array<{assertionResults:Array<{title:string;status:string}>}>};
   expect([result.numTotalTests,result.numPassedTests,result.numFailedTests]).toEqual([25,23,2]);
   expect(result.testResults.flatMap(r=>r.assertionResults.filter(a=>a.status==='failed').map(a=>a.title)).sort()).toEqual(change.maintained_cases.map(c=>c.title).sort());
  });
  if(row.file===mobileTest)it('discloses the late mobile before image and retains37 cases plus unchanged production/helpers and dated104/108 registration evidence',()=>{
   const before=mobileFragments(row.edits[0]!.before_source),after=mobileFragments(row.edits[0]!.after_source);
   expect(before.rest).toBe(after.rest);expect(proof.mobile_test_maintenance).toHaveLength(1);
   const change=proof.mobile_test_maintenance[0]!;expect(change.file).toBe(mobileTest);expect(change.unchanged_case_count).toBe(37);
   expect(row.before_basis).toBe('late pre-test-maintenance capture; no mobile production edit');expect(change.before_basis).toBe(row.before_basis);expect(sha(before.rest)).toBe(change.unchanged_source_sha256);
   expect(change.maintained_cases.map(c=>c.title)).toEqual(['delivery registration preserves all original 104 pages and startup page','legacy staff branch retains genuine staff API while late confirmation cannot execute delivery legacy body']);
   for(let i=0;i<2;i++){expect(sha(before.cases[i]!)).toBe(change.maintained_cases[i]!.before_sha256);expect(sha(after.cases[i]!)).toBe(change.maintained_cases[i]!.after_sha256);expect(before.cases[i]).not.toBe(after.cases[i]);}
   expect(sha(change.capture_manifest.raw_utf8)).toBe(change.capture_manifest.sha256);expect(row.before_capture_manifest_sha256).toBe(change.capture_manifest.sha256);
   const capture=JSON.parse(change.capture_manifest.raw_utf8) as {basis:string;sources:Array<{path:string;sha256:string}>};expect(capture.basis).toBe('captured after delivery implementation but before mobile runtime test maintenance; mobile production not edited by this batch');expect(capture.sources).toHaveLength(778);
   for(const input of capture.sources)if(input.path!==mobileTest)expect(sha(readFileSync(resolve(root,input.path))),input.path).toBe(input.sha256);else expect(input.sha256).toBe(row.before_sha256);
   expect(sha(change.baseline_receipt.raw_utf8)).toBe(change.baseline_receipt.sha256);for(const pattern of [/ℹ tests 39\b/u,/ℹ pass 37\b/u,/ℹ fail 2\b/u,/ENOENT/u])expect(change.baseline_receipt.raw_utf8).toMatch(pattern);
   expect(change.registration_evidence.map(e=>e.route_count)).toEqual([104,108]);
   const routes=change.registration_evidence.map(e=>{const raw=read(e.file);expect(sha(raw)).toBe(e.sha256);const hosts=(JSON.parse(raw) as {currentThemeHosts:{hosts:Array<{route:string}>}}).currentThemeHosts.hosts;expect(hosts).toHaveLength(e.route_count);expect(new Set(hosts.map(h=>h.route)).size).toBe(e.route_count);return hosts.map(h=>h.route);});
   for(const route of routes[0]!)expect(routes[1]).toContain(route);expect(routes[1]!.filter(p=>!routes[0]!.includes(p)).sort()).toEqual(['/pages/delivery/index','/pages/delivery/orderDetail','/pages/delivery/scanDetail','/pages/delivery/scanning'].sort());
  });
 }
 for(const row of proof.full_additions)it('pins the complete new file '+row.file,()=>{const raw=readFileSync(resolve(root,row.file));expect(raw.byteLength).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);});
 for(const row of proof.PHP_sources)it('pins the complete fixed PHP source '+row.file,()=>{
  expect(proof.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');expect(sha(row.raw_utf8)).toBe(row.sha256);expect(new TextEncoder().encode(row.raw_utf8).byteLength).toBe(row.bytes);
 });
 const frozen=Object.entries(proof.frozen_predecessor_evidence);
 for(let start=0;start<frozen.length;start+=64)it(`preserves every accepted dated proof, helper and document ${start+1}..${Math.min(start+64,frozen.length)}`,()=>{
  for(const[file,hash]of frozen.slice(start,start+64))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);
 });
 it('preserves established delivery consumers, Staff implementations and the original business privilege plan',()=>{
  for(const[file,hash]of Object.entries(proof.observed_unchanged))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);
  for(const file of ['workers-ts/src/services/store/DeliveryPrincipalScope.ts','workers-ts/src/services/store/DeliveryReadService.ts','workers-ts/src/services/store/DeliveryOrderWriteoffService.ts','workers-ts/src/services/store/StoreMobileDeliveryService.ts','workers-ts/src/services/store/StaffAvatarPolicy.ts','workers-ts/src/services/admin/AdminStaffSupportService.ts','workers-ts/test/staff-avatar-policy.test.ts','workers-ts/test/admin-staff-support.test.ts','workers-ts/src/services/admin/AdminStaffAuthorService.ts','workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts','view/admin-ts/src/utils/request.ts'])expect(Object.hasOwn(proof.observed_unchanged,file),file).toBe(true);
 });
 it('composes Delivery before immutable Staff and keeps26 old suites import-only',()=>{
  const ports=proof.sources.filter(r=>r.file.startsWith('workers-ts/test/')&&r.file.endsWith('.test.ts')&&r.file!==permissionTest);expect(ports).toHaveLength(26);
  expect(ports.some(r=>r.file==='workers-ts/test/admin-staff-source-binding.test.ts')).toBe(true);
  for(const file of ['workers-ts/src/routes/adminapi.ts','workers-ts/src/routes/v1/index.ts','workers-ts/src/controllers/api/v1/AdminStoreController.ts']){
   const before=reverseDeliverySource(file,read(file));expect(readDeliveryPredecessor(resolve(root,file),'utf8')).toBe(before);expect(readStaffPredecessor(resolve(root,file),'utf8')).toBe(reverseStaffSource(file,before));
  }
  expect(proof.full_additions.some(r=>r.file==='workers-ts/test/helpers/deliverySourceBinding.ts')).toBe(false);expect(sha(proof.previous_report.raw_utf8)).toBe(staffSourceBinding.current_report.sha256);
 });
 it('never generalizes inverse text or rewrites accepted Staff evidence',()=>{
  const raw='unrelated delivery author source';expect(reverseDeliverySource('not/owned.ts',raw)).toBe(raw);
  for(const f of ['workers-ts/test/helpers/staffSourceBinding.ts','workers-ts/audit/staff-author-source-binding-20261026.json','workers-ts/docs/php-ts-staff-author-20261026.md'])expect(proof.sources.some(r=>r.file===f)).toBe(false);
 });
 it('rebuilds actual755 calls/793 variants and retains all748/786 predecessor objects plus seven wrappers',()=>{
  const current=buildAdminFrontendApiAuditReport(),before=buildDeliveryPredecessorApiAuditReport(),raw=read(proof.current_report.file);
  expect(JSON.stringify(current,null,2)+'\n').toBe(raw);expect(sha(raw)).toBe(proof.current_report.sha256);
  expect(before.counts).toEqual({callSites:748,pathVariants:786,registered:786,executable:786,controlledUnavailable:0,unregistered:0,unresolved:0});
  expect(current.counts).toEqual({callSites:755,pathVariants:793,registered:793,executable:793,controlledUnavailable:0,unregistered:0,unresolved:0});
  expect(proof.retired_api_calls).toEqual([]);for(const call of before.calls)expect(current.calls).toContainEqual(call);
  expect(current.calls.filter(c=>c.source==='view/admin-ts/src/api/deliveryAuthor.ts').map(c=>[c.method,c.path])).toEqual([
   ['GET','/order/delivery/author/catalog'],['POST','/order/delivery/author/commit'],['GET','/order/delivery/author/receipt/:param'],['POST','/order/delivery/author/resolve'],['GET','/order/delivery/author/attachment-categories'],['GET','/order/delivery/author/attachment-options'],['GET','/order/delivery/author/users']]);
 });
 it('pins original routed platform page and four create controls with hidden UID/avatar but immutable edit UID',()=>{
  expect(php('view/admin/src/router/modules/setting.js')).toContain("path: 'delivery_service/index'");
  expect(php('view/admin/src/pages/setting/deliveryService/index.vue')).toContain('$modalForm(orderDeliveryAdd())');
  const service=php('app/services/store/DeliveryServiceServices.php'),start=service.indexOf('    public function createServiceForm('),end=service.indexOf('    public function create()',start),form=service.slice(start,end);
  expect(start).toBeGreaterThanOrEqual(0);for(const key of ['image','uid','avatar','nickname','phone','status'])expect(form).toContain(`'${key}'`);
  const edit=form.slice(form.indexOf('if ($formData)'),form.indexOf('} else'));expect(edit).toContain("'avatar'");expect(edit).not.toContain("'uid'");
 });
 it('keeps exactly five raw stored values and excludes previews/hidden scope from authored payload',()=>{
  expect(DELIVERY_FIELDS).toEqual(['uid','avatar','nickname','phone','status']);expect(newDeliveryValues()).toEqual({uid:0,avatar:'',nickname:'',phone:'',status:1,user_selection:''});
  const v={...newDeliveryValues(),uid:11,avatar:'http://legacy.test/a.png',status:7},a:DeliveryAction={operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation:'create',target_id:0,revision:'a'.repeat(64),payload:v,payload_hash:'b'.repeat(64)};
  expect(deliveryAction(a,1)).toEqual(a);for(const extra of [{avatar_preview:'signed'},{type:1},{relation_id:1}])expect(()=>deliveryAction({...a,payload:{...v,...extra}},1)).toThrow();
 });
 it('binds the precise platform-delivery-author-v1 canonical request domain',()=>{
  const a:DeliveryAction={operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation:'update',target_id:20,revision:'a'.repeat(64),payload:{...newDeliveryValues(),uid:11},payload_hash:'b'.repeat(64)};
  expect(deliveryCanonical(a)).toEqual({domain:'platform-delivery-author-v1',actor_id:1,operation_id:a.operation_id,operation:'update',target_id:20,revision:a.revision,payload:a.payload});
 });
 it('rejects foreign actor, unknown operation, wrong target and extra envelope fields',()=>{
  const a:DeliveryAction={operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation:'status',target_id:20,revision:'a'.repeat(64),payload:{status:0},payload_hash:'b'.repeat(64)};
  for(const value of [{...a,actor_id:2},{...a,operation:'dispatch'},{...a,target_id:0},{...a,extra:1}])expect(()=>deliveryAction(value,1)).toThrow();
 });
 it('requires committed target and counters to agree with the original operation',()=>{
  const a:DeliveryAction={operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation:'update',target_id:20,revision:'a'.repeat(64),payload:{...newDeliveryValues(),uid:11},payload_hash:'b'.repeat(64)},{payload:_,...meta}=a,result={id:20,created:0,updated:1,count:1,revision:'c'.repeat(64)};
  expect(deliveryReceipt({...meta,state:'committed',result},a).state).toBe('committed');for(const patch of [{id:21},{created:1},{updated:0}])expect(()=>deliveryReceipt({...meta,state:'committed',result:{...result,...patch}},a)).toThrow();
 });
 it('distinguishes exact not_applied from missing/unknown/contradictory outcomes',()=>{
  const a:DeliveryAction={operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation:'delete',target_id:20,revision:'a'.repeat(64),payload:{},payload_hash:'b'.repeat(64)},{payload:_,...meta}=a,result={id:20,created:0,updated:0,count:0,revision:a.revision};
  expect(deliveryReceipt({...meta,state:'not_applied',result},a).state).toBe('not_applied');for(const state of ['queued','unknown',''])expect(()=>deliveryReceipt({...meta,state,result},a)).toThrow();expect(()=>deliveryReceipt({...meta,state:'not_applied',result:{...result,count:1}},a)).toThrow();
 });
 it('records live order authority and original UUID-before-version owner recovery',()=>{
  expect(proof.boundaries.authority).toContain('order.manage');expect(proof.boundaries.recovery).toContain('UUID before');expect(proof.boundaries.recovery).toContain('unknown');
  const service=read('workers-ts/src/services/admin/AdminDeliveryAuthorService.ts'),mutation=service.slice(service.indexOf(' mutate('));expect(mutation.indexOf('await this.prior(tx,a)')).toBeGreaterThanOrEqual(0);expect(mutation.indexOf('await this.prior(tx,a)')).toBeLessThan(mutation.indexOf('a.revision!==before.revision'));
 });
 it('records established identity lock/fence order with no widened business grants',()=>{
  for(const text of ['8214002,0','SHARE ROW EXCLUSIVE NOWAIT','731633,1'])expect(proof.boundaries.concurrency).toContain(text);expect(proof.boundaries.database).toContain('Admin SELECT/INSERT');
 });
 it('records selected-user phone and xmin as source evidence, never standalone authorization',()=>{
  for(const text of ['FOR SHARE NOWAIT','phone','xmin','not an authorization token'])expect(proof.boundaries.selection).toContain(text);expect(read('workers-ts/src/services/admin/AdminDeliverySupportService.ts')).toContain("domain: 'delivery-user-selection-v1'");
 });
 it('records historical raw values, immutable edit UID, mobile fallback and full all-scope readback',()=>{
  for(const text of ['five','immutable','250','256'])expect(proof.boundaries.values).toContain(text);for(const text of ['full','ten','foreign'])expect(proof.boundaries.readback).toContain(text);
 });
 it('records exactly one avatar slot with independent platform or exact-current-user ownership',()=>{
  for(const text of ['type3','exact','no entity decoding'])expect(proof.boundaries.assets).toContain(text);expect(DELIVERY_FIELDS.filter(k=>k==='avatar')).toHaveLength(1);
 });
 it('records complete RR/count-list pagination and old assigned-user exclusion without truncating modern users',()=>{
  for(const text of ['2147483647','count/list','phone','NOT EXISTS','default modern'])expect(proof.boundaries.support).toContain(text);
 });
 it('records strict legacy image/UID conflict handling and bounded LIKE instead of input regex',()=>{
  expect(php('app/controller/admin/v1/order/DeliveryService.php')).toContain("$data['uid'] = $data['image']['uid']");for(const text of ['conflict','immutable','Bounded LIKE'])expect(proof.boundaries.legacy).toContain(text);
 });
 it('records independent native consumer contention and explicit addon commissioning separately from source evidence',()=>{
  expect(proof.full_additions.some(r=>r.file==='workers-ts/test/admin-delivery-native.test.ts')).toBe(true);for(const text of ['independent LOGIN','real','not deployment'])expect(proof.boundaries.native).toContain(text);
 });
 it('records native cached callback retirement, original per-owner UUID journals and capacity guards',()=>{
  for(const text of ['cacheHandlers:true','per-owner UUID','raw','can_create'])expect(proof.boundaries.frontend).toContain(text);
 });
 it('does not claim source evidence, next-scout or controlled GUI as complete migration or deployment',()=>{
  for(const text of ['source-only','not acceptance','26'])expect(proof.boundaries.evidence).toContain(text);expect(proof.boundaries.scope).toContain('No clerk');expect(proof.boundaries.scope).toContain('money');
  for(const text of ['two generic','other23','POST-only'])expect(proof.boundaries.evidence).toContain(text);
 });
});
