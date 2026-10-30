import {createHash} from 'node:crypto';
import {readDeliveryPredecessor as readFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {buildDeliveryPredecessorApiAuditReport as buildAdminFrontendApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {staffSourceBinding as proof,reverseStaffSource,readStaffPredecessor,readStorePredecessor,storeSourceBinding,reverseStoreSource,buildStaffPredecessorApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {STAFF_FIELDS,newStaffValues,staffAction,staffCanonical,staffReceipt,type StaffAction} from '../../view/common/staffAuthor';

const root=resolve(import.meta.dirname,'../..');
const read=(file:string)=>readFileSync(resolve(root,file),'utf8');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const stripImports=(value:string)=>value.replace(/^import[\s\S]*?;\n/gmu,'');
function php(file:string){const row=proof.PHP_sources.find(r=>r.file===file);if(!row)throw Error('Missing complete fixed PHP original: '+file);return row.raw_utf8;}

// These checks supplement real restricted SQL/Hono, installed Vue/native-host,
// built-browser and independent PG16 execution; source assertions are not those
// runtime receipts and do not establish deployment or a real map interaction.
describe('pickup-staff complete author exact source increment and immutable accepted predecessors',()=>{
 for(const row of proof.sources){
  it('pins the complete current image and exact full predecessor '+row.file,()=>{
   const actual=read(row.file);expect(sha(actual)).toBe(row.after_sha256);
   expect(sha(reverseStaffSource(row.file,actual))).toBe(row.before_sha256);
   expect(sha(readStaffPredecessor(resolve(root,row.file)))).toBe(row.before_sha256);
  });
  it('rejects changed bytes and a forged generalized inverse '+row.file,()=>{
   const actual=read(row.file);for(const bad of [actual.slice(1),actual+'\n// unreviewed\n',actual+actual])expect(()=>reverseStaffSource(row.file,bad)).toThrow();
   for(const key of ['before_sha256','after_sha256'] as const){const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)![key]='0'.repeat(64);expect(()=>reverseStaffSource(row.file,actual,forged)).toThrow();}
   for(const key of ['before_line','after_line'] as const){const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)!.edits[0]![key]=2;expect(()=>reverseStaffSource(row.file,actual,forged)).toThrow();}
   const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)!.edits.push({...row.edits[0]!});expect(()=>reverseStaffSource(row.file,actual,forged)).toThrow();
  });
  if(row.file.startsWith('workers-ts/test/')&&row.file.endsWith('.test.ts'))it('retains every prior assertion and negative fixture '+row.file,()=>{
   expect(stripImports(row.edits[0]!.after_source)).toBe(stripImports(row.edits[0]!.before_source));
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
 it('retains mature staff consumers, order execution, user credentials, assets and the original privilege plan',()=>{
  for(const[file,hash]of Object.entries(proof.observed_unchanged))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);
  for(const file of ['workers-ts/src/services/store/StoreOperationsService.ts','workers-ts/src/services/store/StoreManagerScope.ts','workers-ts/src/services/order/CheckoutPickupPolicy.ts',
   'workers-ts/src/services/order/StoreOrderWriteoffService.ts','workers-ts/src/services/system/AttachmentService.ts','workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts',
   'view/admin-ts/src/utils/auth.ts','view/admin-ts/src/utils/request.ts','view/admin-ts/src/stores/auth.ts'])expect(Object.hasOwn(proof.observed_unchanged,file),file).toBe(true);
 });
 it('composes Staff before the immutable Store layer and preserves all25 import-only old source suites',()=>{
  const ports=proof.sources.filter(row=>row.file.startsWith('workers-ts/test/')&&row.file.endsWith('.test.ts'));expect(ports).toHaveLength(25);
  expect(ports.some(r=>r.file==='workers-ts/test/admin-store-source-binding.test.ts')).toBe(true);
  for(const file of ['workers-ts/src/routes/adminapi.ts','workers-ts/src/routes/v1/index.ts','workers-ts/src/controllers/api/v1/AdminStoreController.ts']){
   const before=reverseStaffSource(file,read(file));expect(readStaffPredecessor(resolve(root,file),'utf8')).toBe(before);expect(readStorePredecessor(resolve(root,file),'utf8')).toBe(reverseStoreSource(file,before));
  }
  expect(proof.full_additions.some(r=>r.file==='workers-ts/test/helpers/staffSourceBinding.ts')).toBe(false);expect(sha(proof.previous_report.raw_utf8)).toBe(storeSourceBinding.current_report.sha256);
 });
 it('rejects generalized reversal of unrelated files and never rewrites accepted Store evidence',()=>{
  const raw='unrelated /merchant/store_staff/author source';expect(reverseStaffSource('not/owned.ts',raw)).toBe(raw);
  expect(proof.sources.some(r=>r.file==='workers-ts/test/helpers/storeSourceBinding.ts')).toBe(false);expect(proof.sources.some(r=>r.file==='workers-ts/audit/store-author-source-binding-20261026.json')).toBe(false);
 });
 it('rebuilds actual748 calls/786 variants while retaining every old741/779 object and adding exactly seven wrappers',()=>{
  const current=buildAdminFrontendApiAuditReport(),before=buildStaffPredecessorApiAuditReport(),raw=read(proof.current_report.file);
  expect(JSON.stringify(current,null,2)+'\n').toBe(raw);expect(sha(raw)).toBe(proof.current_report.sha256);
  expect(before.counts).toEqual({callSites:741,pathVariants:779,registered:779,executable:779,controlledUnavailable:0,unregistered:0,unresolved:0});
  expect(current.counts).toEqual({callSites:748,pathVariants:786,registered:786,executable:786,controlledUnavailable:0,unregistered:0,unresolved:0});
  expect(proof.retired_api_calls).toEqual([]);for(const call of before.calls)expect(current.calls).toContainEqual(call);
  expect(current.calls.filter(c=>c.source==='view/admin-ts/src/api/staffAuthor.ts').map(c=>[c.method,c.path])).toEqual([
   ['GET','/merchant/store_staff/author/catalog'],['POST','/merchant/store_staff/author/commit'],['GET','/merchant/store_staff/author/receipt/:param'],['POST','/merchant/store_staff/author/resolve'],
   ['GET','/merchant/store_staff/author/attachment-categories'],['GET','/merchant/store_staff/author/attachment-options'],['GET','/merchant/store_staff/author/users']]);
 });
 it('pins the actual PHP clerk route and six active controls with hidden uid/avatar instead of separate manager credentials',()=>{
  const routes=php('view/admin/src/router/modules/setting.js'),service=php('app/services/store/SystemStoreStaffServices.php');
  expect(routes).toContain('merchant/system_store_staff/index');expect(routes).toContain('@/pages/setting/clerkList/index');
  const start=service.indexOf('    public function createStaffForm('),end=service.indexOf('    public function createForm(',start),form=service.slice(start,end);
  expect(start).toBeGreaterThanOrEqual(0);for(const field of ['image','uid','avatar','store_id','staff_name','phone','verify_status','status'])expect(form).toContain(`'${field}'`);
  expect(form).not.toContain("'password'");expect(form).not.toContain("'is_admin'");expect(form).toContain('商城用户');expect(form).toContain('更换头像');
 });
 it('keeps seven raw stored fields and an explicit selection with no avatar preview or metadata in the payload',()=>{
  expect(STAFF_FIELDS).toEqual(['uid','avatar','store_id','staff_name','phone','verify_status','status']);
  expect(newStaffValues()).toEqual({uid:0,avatar:'',store_id:0,staff_name:'',phone:'',verify_status:1,status:1,user_selection:''});
  const v={...newStaffValues(),uid:11,store_id:20,avatar:'http://legacy.example/avatar.png',verify_status:7,user_selection:'c'.repeat(64)};
  const a:StaffAction={operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation:'create',target_id:0,revision:'a'.repeat(64),payload:v,payload_hash:'b'.repeat(64)};
  expect(staffAction(a,1)).toEqual(a);expect(()=>staffAction({...a,payload:{...v,preview:'/api/assets/1?signature=bad'}},1)).toThrow();
 });
 it('binds the exact domain and original request to a canonical seven-value action',()=>{
  const a:StaffAction={operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation:'update',target_id:20,revision:'a'.repeat(64),payload:{...newStaffValues(),uid:11,store_id:20},payload_hash:'b'.repeat(64)};
  expect(staffCanonical(a)).toEqual({domain:'staff-author-v1',actor_id:1,operation_id:a.operation_id,operation:'update',target_id:20,revision:a.revision,payload:a.payload});
 });
 it('rejects foreign owner, unknown operation, target and unexpected action fields',()=>{
  const a:StaffAction={operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation:'status',target_id:20,revision:'a'.repeat(64),payload:{status:0},payload_hash:'b'.repeat(64)};
  for(const value of [{...a,actor_id:2},{...a,operation:'restore'},{...a,target_id:0},{...a,extra:1}])expect(()=>staffAction(value,1)).toThrow();
 });
 it('accepts only operation-consistent committed receipts before declaring a successful write',()=>{
  const a:StaffAction={operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation:'update',target_id:20,revision:'a'.repeat(64),payload:{...newStaffValues(),uid:11,store_id:20},payload_hash:'b'.repeat(64)}, {payload:_,...meta}=a;
  const result={id:20,created:0,updated:1,count:1,revision:'c'.repeat(64)};expect(staffReceipt({...meta,state:'committed',result},a).state).toBe('committed');
  for(const patch of [{id:21},{created:1},{updated:0}])expect(()=>staffReceipt({...meta,state:'committed',result:{...result,...patch}},a)).toThrow();
 });
 it('distinguishes exact not_applied sealing from unknown or contradictory state',()=>{
  const a:StaffAction={operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation:'delete',target_id:20,revision:'a'.repeat(64),payload:{},payload_hash:'b'.repeat(64)}, {payload:_,...meta}=a;
  const result={id:20,created:0,updated:0,count:0,revision:a.revision};expect(staffReceipt({...meta,state:'not_applied',result},a).state).toBe('not_applied');
  for(const state of ['queued','unknown',''])expect(()=>staffReceipt({...meta,state,result},a)).toThrow();expect(()=>staffReceipt({...meta,state:'not_applied',result:{...result,revision:'c'.repeat(64)}},a)).toThrow();
 });
 it('records live authority and original UUID-before-version owner recovery boundaries',()=>{
  expect(proof.boundaries.authority).toContain('store.manage');expect(proof.boundaries.recovery).toContain('UUID before');expect(proof.boundaries.recovery).toContain('unknown');
  const service=read('workers-ts/src/services/admin/AdminStaffAuthorService.ts');expect(service.indexOf('await this.prior(tx,a)')).toBeLessThan(service.indexOf('a.revision!==before.revision'));
 });
 it('records old consumer compatible lock order without broadening runtime business DML',()=>{
  expect(proof.boundaries.concurrency).toContain('8214001,0');expect(proof.boundaries.concurrency).toContain('731745,1');expect(proof.boundaries.concurrency).toContain('ACCESS EXCLUSIVE NOWAIT');
  expect(proof.boundaries.database).toContain('Admin SELECT/INSERT');
 });
 it('records selected-user row locks and the complete source stamp as evidence rather than authorization',()=>{
  expect(proof.boundaries.selection).toContain('FOR SHARE NOWAIT');expect(proof.boundaries.selection).toContain('xmin');expect(proof.boundaries.selection).toContain('not an authorization token');
  const service=read('workers-ts/src/services/admin/AdminStaffSupportService.ts');expect(service).toContain("domain: 'staff-user-selection-v1'");
 });
 it('records full hidden metadata preservation and explicit raw user256/staff255 handling',()=>{
  expect(proof.boundaries.values).toContain('seven');expect(proof.boundaries.values).toContain('256');expect(proof.boundaries.values).toContain('255');
  expect(proof.boundaries.readback).toContain('full');expect(proof.boundaries.readback).toContain('credential');
 });
 it('records one staff avatar slot with independent platform versus exact current user media ownership',()=>{
  expect(proof.boundaries.assets).toContain('type3');expect(proof.boundaries.assets).toContain('exact');expect(proof.boundaries.assets).toContain('no entity decoding');
  expect(STAFF_FIELDS.filter(field=>field==='avatar')).toHaveLength(1);
 });
 it('records privacy-minimal read-only users and explicit complete SQL pagination instead of a5000-page cap',()=>{
  expect(proof.boundaries.support).toContain('2147483647');expect(proof.boundaries.support).toContain('count/list');expect(proof.boundaries.support).toContain('nickname');expect(proof.boundaries.support).toContain('no phone/account');
 });
 it('records legacy image-object normalization without replaying the original hidden-uid authorization bug',()=>{
  const controller=php('app/controller/admin/v1/merchant/SystemStoreStaff.php');expect(controller).toContain("$data['uid'] = $data['image']['uid']");
  expect(proof.boundaries.legacy).toContain('store_id=0');expect(proof.boundaries.legacy).toContain('conflict');expect(proof.boundaries.legacy).toContain('live');
 });
 it('records actual old consumer native contention and independent addon commissioning as separate runtime evidence',()=>{
  expect(proof.full_additions.some(row=>row.file==='workers-ts/test/admin-staff-native.test.ts')).toBe(true);
  expect(proof.boundaries.native).toContain('independent LOGIN');expect(proof.boundaries.native).toContain('real');expect(proof.boundaries.native).toContain('not deployment');
 });
 it('records loop-local cacheHandlers callbacks, owner journals and explicit whole-source capacity',()=>{
  expect(proof.boundaries.frontend).toContain('cacheHandlers:true');expect(proof.boundaries.frontend).toContain('per-owner UUID');expect(proof.boundaries.frontend).toContain('can_create');
  expect(proof.boundaries.frontend).toContain('raw');
 });
 it('does not claim source evidence as GUI, provider, database deployment or full migration acceptance',()=>{
  expect(proof.boundaries.evidence).toContain('source-only');expect(proof.boundaries.evidence).toContain('not acceptance');expect(proof.boundaries.evidence).toContain('25');
  expect(proof.boundaries.scope).toContain('No delivery');
 });
});
