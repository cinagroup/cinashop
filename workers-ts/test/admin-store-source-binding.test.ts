import {createHash} from 'node:crypto';
import {readStaffPredecessor as readFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {buildStaffPredecessorApiAuditReport as buildAdminFrontendApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {storeSourceBinding as proof,reverseStoreSource,readStorePredecessor,readUserLabelPredecessor,userLabelSourceBinding,reverseUserLabelSource,buildStorePredecessorApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {STORE_FIELDS,newStoreValues,storeAction,storeCanonical,storeReceipt,type StoreAction} from '../../view/common/storeAuthor';

const root=resolve(import.meta.dirname,'../..');
const read=(file:string)=>readFileSync(resolve(root,file),'utf8');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const stripImports=(value:string)=>value.replace(/^import[\s\S]*?;\n/gmu,'');
function php(file:string){const row=proof.PHP_sources.find(r=>r.file===file);if(!row)throw Error('Missing complete fixed PHP original: '+file);return row.raw_utf8;}

// These checks supplement real restricted SQL/Hono, installed Vue/native-host,
// built-browser and independent PG16 execution; source assertions are not those
// runtime receipts and do not establish deployment or a real map interaction.
describe('pickup-store complete author exact source increment and immutable accepted predecessors',()=>{
 for(const row of proof.sources){
  it('pins the complete current image and exact full predecessor '+row.file,()=>{
   const actual=read(row.file);expect(sha(actual)).toBe(row.after_sha256);
   expect(sha(reverseStoreSource(row.file,actual))).toBe(row.before_sha256);
   expect(sha(readStorePredecessor(resolve(root,row.file)))).toBe(row.before_sha256);
  });
  it('rejects changed bytes and a forged generalized inverse '+row.file,()=>{
   const actual=read(row.file);for(const bad of [actual.slice(1),actual+'\n// unreviewed\n',actual+actual])expect(()=>reverseStoreSource(row.file,bad)).toThrow();
   for(const key of ['before_sha256','after_sha256'] as const){const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)![key]='0'.repeat(64);expect(()=>reverseStoreSource(row.file,actual,forged)).toThrow();}
   for(const key of ['before_line','after_line'] as const){const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)!.edits[0]![key]=2;expect(()=>reverseStoreSource(row.file,actual,forged)).toThrow();}
   const forged=structuredClone(proof);forged.sources.find(r=>r.file===row.file)!.edits.push({...row.edits[0]!});expect(()=>reverseStoreSource(row.file,actual,forged)).toThrow();
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

 it('retains mature checkout, store-manager, credential, attachment and business privilege implementations',()=>{
  for(const[file,hash]of Object.entries(proof.observed_unchanged))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);
  for(const file of ['workers-ts/src/services/order/CheckoutPickupPolicy.ts','workers-ts/src/services/order/StoreOrderCreateService.ts',
   'workers-ts/src/services/store/StoreManagerScope.ts','workers-ts/src/services/store/StoreOperationsService.ts',
   'workers-ts/src/services/system/AttachmentService.ts','workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts',
   'workers-ts/src/services/admin/AdminAuthorityWriteService.ts','workers-ts/src/middleware/admin-auth.ts',
   'workers-ts/src/middleware/admin-runtime-auth.ts','view/admin-ts/src/utils/auth.ts','view/admin-ts/src/utils/request.ts',
   'view/admin-ts/src/stores/auth.ts','view/admin-ts/src/api/store.ts'])expect(Object.hasOwn(proof.observed_unchanged,file),file).toBe(true);
 });
 it('composes the Store inverse outside Label and keeps exactly 24 import-only predecessor read ports',()=>{
  for(const file of ['workers-ts/src/routes/adminapi.ts','workers-ts/src/routes/v1/index.ts','workers-ts/src/controllers/api/v1/AdminStoreController.ts',
   'workers-ts/src/services/admin/AdminPermissionService.ts','workers-ts/src/migrations/auditRuntimeBusinessPrivileges.ts']){
   const prior=reverseStoreSource(file,read(file));expect(readStorePredecessor(resolve(root,file),'utf8')).toBe(prior);
   expect(readUserLabelPredecessor(resolve(root,file),'utf8')).toBe(reverseUserLabelSource(file,prior));
  }
  const ports=proof.sources.filter(r=>r.file.startsWith('workers-ts/test/')&&r.file.endsWith('.test.ts'));
  expect(ports).toHaveLength(24);expect(ports.some(r=>r.file==='workers-ts/test/admin-user-label-source-binding.test.ts')).toBe(true);
  expect(proof.full_additions.some(r=>r.file==='workers-ts/test/helpers/storeSourceBinding.ts')).toBe(false);
  expect(proof.frozen_predecessor_evidence['workers-ts/test/helpers/userLabelSourceBinding.ts']).toBe(sha(read('workers-ts/test/helpers/userLabelSourceBinding.ts')));
  expect(sha(proof.previous_report.raw_utf8)).toBe(userLabelSourceBinding.current_report.sha256);
 });
 it('does not apply an inverse to an unrelated source or edit any earlier proof/helper',()=>{
  const raw='unrelated /merchant/store/author source';expect(reverseStoreSource('unrelated.ts',raw)).toBe(raw);
  expect(proof.sources.some(r=>r.file.endsWith('userLabelSourceBinding.ts'))).toBe(false);
  expect(proof.sources.some(r=>r.file==='workers-ts/audit/user-label-author-source-binding-20261026.json')).toBe(false);
 });
 it('rebuilds the actual inventory with eight new executable wrappers and every predecessor call unchanged',()=>{
  const current=buildAdminFrontendApiAuditReport(),raw=read(proof.current_report.file),before=buildStorePredecessorApiAuditReport();
  expect(JSON.stringify(current,null,2)+'\n').toBe(raw);expect(sha(raw)).toBe(proof.current_report.sha256);
  expect(before.counts).toEqual({callSites:733,pathVariants:771,registered:771,executable:771,controlledUnavailable:0,unregistered:0,unresolved:0});
  expect(current.counts).toEqual({callSites:741,pathVariants:779,registered:779,executable:779,controlledUnavailable:0,unregistered:0,unresolved:0});
  expect(proof.retired_api_calls).toEqual([]);for(const call of before.calls)expect(current.calls).toContainEqual(call);
  const added=current.calls.filter(c=>c.source==='view/admin-ts/src/api/storeAuthor.ts');expect(added).toHaveLength(8);
  expect(added.map(c=>[c.method,c.path])).toEqual([['GET','/merchant/store/author/catalog'],['POST','/merchant/store/author/commit'],
   ['GET','/merchant/store/author/receipt/:param'],['POST','/merchant/store/author/resolve'],['GET','/merchant/store/author/attachment-categories'],
   ['GET','/merchant/store/author/attachment-options'],['GET','/merchant/store/author/regions'],['GET','/merchant/store/author/map-config']]);
 });
 it('binds the routed PHP component and active time/name-path/image/map controls rather than commented validity UI',()=>{
  const page=php('view/admin/src/components/systemStore/index.vue'),list=php('view/admin/src/pages/setting/storeList/index.vue');
  expect(list).toContain('@/components/systemStore');
  for(const field of ['name','introduction','phone','address','detailed_address','day_time','image','latlng'])expect(page).toContain(`formItem.${field}`);
  expect(page).toContain('type="timerange"');expect(page).toContain('format="HH:mm:ss"');expect(page).toContain('<!--<DatePicker');
  expect(page).toContain('selectedData.map(o => o.label)');expect(page).toContain('this.formItem.image = pc.att_dir');
  expect(page).toContain('https://apis.map.qq.com/tools/locpicker?type=1&key=${keys}&referer=myapp');
  expect(page).toContain("loc.module === 'locationPicker'");expect(page).toContain("data.latlng.lat + ',' + data.latlng.lng");
 });
 it('keeps the twelve current values, raw history and strict terminal receipt meanings',()=>{
  expect(STORE_FIELDS).toEqual(['name','introduction','phone','address','detailed_address','latitude','longitude','day_time','image','valid_range','is_show','is_store']);
  const a:StoreAction={operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation:'update',target_id:20,revision:'a'.repeat(64),payload:{...newStoreValues(),name:'N',valid_range:-7,is_show:2},payload_hash:'b'.repeat(64)};
  expect(storeAction(a,1)).toEqual(a);expect(storeCanonical(a)).toMatchObject({domain:'store-author-v1',actor_id:1,payload:a.payload});
  const {payload:_,...meta}=a,result={id:20,created:0,updated:1,count:1,revision:'c'.repeat(64)};
  expect(storeReceipt({...meta,state:'committed',result},a).state).toBe('committed');
  for(const bad of [{...result,id:21},{...result,created:1},{...result,updated:0}])expect(()=>storeReceipt({...meta,state:'committed',result:bad},a)).toThrow();
  expect(storeReceipt({...meta,state:'not_applied',result:{id:20,created:0,updated:0,count:0,revision:a.revision}},a).state).toBe('not_applied');
  expect(()=>storeReceipt({...meta,state:'not_applied',result},a)).toThrow();expect(()=>storeReceipt({...meta,state:'queued',result},a)).toThrow();
 });
 it('binds live read/write authority, established ERP lock order and complete store/staff serialization',()=>{
  const service=read('workers-ts/src/services/admin/AdminStoreAuthorService.ts');
  expect(service).toContain('acquireAdminAuthorityWriteBarrier(tx)');expect(service).toContain("loadAdminAuthorityLiveActor(tx,a,'store.manage')");
  expect(service).toContain("authorizeAdminLegacyProductRead(tx,a,'store.view')");expect(service).toContain('assertAdminLegacyProductReadDeadline(tx,a)');
  const erp=service.indexOf('pg_try_advisory_xact_lock(731745,1)'),store=service.indexOf('LOCK TABLE ONLY public.system_store IN ACCESS EXCLUSIVE MODE NOWAIT');
  expect(erp).toBeGreaterThanOrEqual(0);expect(erp).toBeLessThan(store);expect(service).toContain('LOCK TABLE ONLY public.system_store_staff IN SHARE ROW EXCLUSIVE MODE NOWAIT');
  expect(service).toContain('pg_advisory_xact_lock(731631,1)');expect(service).toContain('LOCK TABLE ONLY public.store_order IN SHARE ROW EXCLUSIVE MODE NOWAIT');
 });
 it('binds both explicit schema profiles and complete write readback without installing a city forward at request time',()=>{
  const service=read('workers-ts/src/services/admin/AdminStoreAuthorService.ts');
  expect(service).toContain('FROM pg_attribute');expect(service).toContain("names.includes('city_shop_id')");expect(service).toContain("names.includes('business')");
  expect(service).toContain('city!==business');expect(service).toContain("profile:profile.city?'customer-city':'base'");expect(service).toContain('before.profile.projection');
  expect(service).toContain('INSERT INTO public.system_store');expect(service).toContain('RETURNING ${sql.join(');
  expect(service).toContain('Object.entries(insert).some(');expect(service).toContain('before.rows.map(');expect(service).toContain('before.staff.map(');
  expect(service).toContain('after.rows.map(');expect(service).toContain('after.staff.map(');expect(service).toContain('完整写后回读不一致');
  expect(service).toContain('.limit(5001)');expect(service).toContain('.limit(20001)');expect(service).toContain('8*1024*1024');
  expect(service).not.toContain('ALTER TABLE');expect(service).not.toContain('runAdminStoreUpgrade');
 });
 it('binds UUID recovery before source revision, irreversible not-applied and retained legacy adapters',()=>{
  const service=read('workers-ts/src/services/admin/AdminStoreAuthorService.ts'),mutate=service.slice(service.indexOf(' mutate(value:unknown'));
  expect(mutate.indexOf('await this.prior(tx,a)')).toBeLessThan(mutate.indexOf('a.revision!==before.revision'));
  expect(service).toContain('this.transaction(actor,true,true');expect(service).toContain('this.transaction(a,false,true');expect(service).toContain('loadAdminProfileActor(tx,a)');
  expect(service).toContain("prior.state!=='committed'");expect(service).toContain("'not_applied',{id:a.target_id,created:0,updated:0,count:0,revision:a.revision}");
  expect(service).toContain("inArray(storeOrder.status,[0,1,5])");expect(service).toContain('expected.get(id)!.isShow=0');expect(service).toContain('restoring?{isDel}:{isDel,isShow:0}');
  expect(service).toContain('const readonly=');expect(service).toContain('未显示的提货点元数据不可修改');
  const controller=read('workers-ts/src/controllers/api/v1/AdminStoreController.ts');for(const method of ['legacyList','legacyHeader','legacyDetail','legacySave','legacyShow','legacyDelete','legacyOptions'])expect(controller).toContain(`)).${method}(c)`);
 });
 it('binds dedicated store.manage support reads and a complete validated region directory',()=>{
  const support=read('workers-ts/src/services/admin/AdminStoreSupportService.ts');
  expect(support).toContain("'store.manage'");expect(support).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');expect(support).toContain('assertAdminLegacyProductReadDeadline(tx, actor)');
  expect(support).toContain('checkedStoreRegionDirectory');expect(support).toContain('REGION_CAPACITY = 10000');expect(support).toContain('.limit(REGION_CAPACITY + 1)');expect(support).toContain('inArray(cityArea.level, [1, 2, 3])');
  expect(support).toContain('tengxun_map_key');expect(support).toContain('https://apis.map.qq.com');expect(support).toContain('/tools/locpicker');
  expect(support).not.toContain('SystemConfigService');expect(support).not.toContain('fetch(');
 });
 it('authorizes only image and separately projects both existing public business images with present metadata',()=>{
  const policy=read('workers-ts/src/services/store/StoreAssetPolicy.ts'),consumer=read('workers-ts/src/services/system/PublicLocationStoreService.ts');
  expect(policy).toContain('if (old !== null && old === next) return');expect(policy).toContain('row.path === `/api/assets/${row.id}`');
  expect(policy).toContain("query.for('share', { noWait: true })");expect(policy).toContain('publicProductPictures(db, canonical.map(');
  expect(policy).toContain('row => displayReference(row.image)');expect(policy).not.toContain('row.oblong');expect(policy).not.toContain('decodeURIComponent');expect(policy).not.toContain('fetch(');
  expect(consumer).toContain('rows.flatMap(row => [{ image: row.image }, { image: row.oblongImage }])');
  expect(consumer).toContain('renderStoreImageReferences(this.env.APP_KEY, references)');
  expect(STORE_FIELDS).not.toContain('oblong_image');
 });
 it('binds the immutable append-only addon and explicit PG16 installation without widening business grants',()=>{
  const addon=read('workers-ts/src/migrations/adminStoreOperation.ts'),upgrade=read('workers-ts/src/migrations/runAdminStoreUpgrade.ts');
  expect(addon).toContain("app: [], admin: ['SELECT', 'INSERT']");expect(addon).toContain('CREATE TABLE public.admin_store_operation');
  expect(addon).toContain("'create','update','show','delete','restore'");expect(addon).toContain('BEFORE UPDATE OR DELETE');expect(addon).toContain('BEFORE TRUNCATE');expect(addon).toContain('SECURITY INVOKER');
  expect(addon).toContain('pg_try_advisory_xact_lock_shared(731626,18)');expect(addon).toContain('current_user=session_user');
  expect(upgrade).toContain('pg_try_advisory_xact_lock(731626,18)');expect(upgrade).toContain("isolationLevel: 'read committed'");expect(upgrade).toContain('GRANT SELECT, INSERT ON TABLE public.admin_store_operation');
  expect(upgrade).not.toMatch(/GRANT[^;]*ON (?:TABLE )?public\.system_store\b/u);
 });
 it('binds strict per-owner UUID journals before I/O and late context guards around receipt restoration',()=>{
  const page=read('view/admin-ts/src/pages/operations/StoreCatalogAuthor.vue'),state=read('view/admin-ts/src/utils/storeAuthorState.ts');
  expect(page).toContain('cinashop_store_pending_v1_');expect(page).toContain('localStorage.length');expect(page).toContain('localStorage.key(');
  expect(page).toContain("window.addEventListener('storage'");expect(page).toContain("window.removeEventListener('storage'");
  expect(state.indexOf('deps.persist(s.actor, a)')).toBeLessThan(state.lastIndexOf('void run(a)'));expect(state).toContain('deps.persist(s.actor, null, a)');
  expect(state).toContain('await restore(s); if (current(s)) await load()');expect(state).toContain("if (receipt.state === 'committed') deps.changed?.()");
  expect(state).toContain('JSON.stringify(state.pending) !== JSON.stringify(a)');expect(state).toContain('state.retryReady = !resolve && status(e) === 404');
 });
 it('binds stable scoped native callbacks, input revisions and actor/tab/route/unmount retirement',()=>{
  const page=read('view/admin-ts/src/pages/operations/StoreCatalogAuthor.vue'),state=read('view/admin-ts/src/utils/storeAuthorState.ts');
  for(const fragment of ['v-for="screen in screens"','v-for="item in rows"','v-for="editor in editors"','v-for="field in editor.fields"','v-for="map in maps"','v-for="confirmation in confirmations"'])expect(page).toContain(fragment);
  expect(page).toContain('props.active');expect(page).toContain('onBeforeUnmount(');expect(page).toContain('model.dispose()');expect(page).toContain('route.fullPath');expect(page).toContain("name === 'login'");
  expect(state).toContain('state.epoch++');expect(state).toContain('requests.forEach(c => c.abort())');expect(state).toContain('e.version++');expect(state).toContain('source === state.source');
  expect(state).toContain('e.version !== version');expect(state).toContain('JSON.stringify(row) === raw');
 });
 it('requires the live iframe identity, exact official origin and explicit candidate confirmation',()=>{
  const page=read('view/admin-ts/src/pages/operations/StoreCatalogAuthor.vue'),state=read('view/admin-ts/src/utils/storeAuthorState.ts');
  expect(page).toContain('frames.get(control.key)?.contentWindow');expect(page).toContain('removeMessage(); frames.clear()');expect(page).toContain(':key="map.key"');
  expect(state).toContain('nonce: crypto.randomUUID()');expect(state).toContain('event.origin !== MAP_ORIGIN || event.source !== frameWindow');
  expect(state).toContain(".module !== 'locationPicker'");expect(state).toContain('!Number.isFinite(lat)');expect(state).toContain('Math.abs(lat) > 90 || Math.abs(lng) > 180');
  expect(state).toContain('m.candidate = { lat, lng }; m.version++');expect(state).toContain('candidate && selected === m.version');expect(state).toContain('e.draft.latitude = decimal(candidate.lat)');
  expect(state).not.toContain('event.data.nonce');expect(state).not.toContain('window.parent');
 });
 it('preserves raw second-level clock history and named natural region leaves until an explicit edit',()=>{
  const state=read('view/admin-ts/src/utils/storeAuthorState.ts'),service=read('workers-ts/src/services/admin/AdminStoreAuthorService.ts');
  expect(state).toContain('originalTimes(row?.day_time');expect(state).toContain('e.timeDirty = true');expect(state).toContain('`${start} - ${end}`');expect(state).not.toContain('new Date(');
  expect(state).toContain("e.draft.address = path.map(row => row.name).join(',')");expect(state).toContain('selection === r.version');
  expect(service).toContain("const path=v.address.split(',')");expect(service).toContain('regions.some(r=>r.pid===parent)');expect(service).toContain("if(changed('day_time'))");
 });
 it('binds both authenticated route families, support ACL and the parent store tab without retiring old consumers',()=>{
  for(const[file,prefix]of [['workers-ts/src/routes/adminapi.ts',''],['workers-ts/src/routes/v1/index.ts','/admin']] as const){
   const routes=read(file);for(const[path,handler]of [['catalog','catalog'],['commit','commit'],['receipt/:operationId','receipt'],['resolve','resolve'],['attachment-categories','attachmentCategories'],['attachment-options','attachmentOptions'],['regions','regions'],['map-config','mapConfig']])expect(routes).toContain(`"${prefix}/merchant/store/author/${path}", adminAuth, StoreAuthor.${handler}`);
   expect(routes).toContain(`"${prefix}/merchant/store/address", adminAuth, StoreAuthor.legacyAddress`);
  }
  const permission=read('workers-ts/src/services/admin/AdminPermissionService.ts');expect(permission).toContain('isAdminStoreRecoveryRoute(method,routePath)');expect(permission).toContain("return 'store.manage'");
  const parent=read('view/admin-ts/src/pages/operations/StoreOperations.vue');expect(parent).toContain('<StoreCatalogAuthor :active="activeTab === \'stores\'" @changed="refreshStoreReferences"');
  expect(read('workers-ts/package.json')).toContain('test/admin-store-source-binding.test.ts');expect(read('view/admin-ts/package.json')).toContain('scripts/store-author-page-runtime.test.cjs');
  expect(read('.github/workflows/workers-runtime-linux.yml')).toContain('npm run test:store-author');
 });
 it('binds actual old checkout SQL contention and separate base/current native schema evidence',()=>{
  const native=read('workers-ts/test/admin-store-native.test.ts');
  expect(native).toContain('lockCheckoutPickupStore(pauseFirstStoreRead(');expect(native).toContain("mode='RowShareLock'");expect(native).toContain('await tx.insert(storeOrder).values(');
  expect(native).toContain('readStoreManagerIdentities(app.db, uid)');expect(native).toContain('for (const status of [0, 1, 5])');
  expect(native).toContain('getTableColumns(systemStore)');expect(native).toContain('expect(await optionalShape()).toEqual([])');
  const base=native.indexOf("const recycleAction = await intent('delete', id)"),current=native.indexOf('ALTER TABLE public.system_store ADD COLUMN city_shop_id');expect(base).toBeGreaterThanOrEqual(0);expect(base).toBeLessThan(current);
  expect(native).toContain('owned_store_city_failure');expect(native).toContain('currentStable');expect(native).toContain('pg_advisory_xact_lock(731745,1)');
 });
});
