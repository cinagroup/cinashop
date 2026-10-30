import {createHash} from 'node:crypto';
import {readEnsurePredecessor as readFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {buildEnsurePredecessorApiAuditReport as buildAdminFrontendApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {unitSourceBinding as proof,reverseUnitSource,readUnitPredecessor,readGroupPredecessor,groupSourceBinding,reverseGroupSource,buildUnitPredecessorApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {UNIT_FIELDS,newUnitValues,unitAction,unitCanonical,unitReceipt,unitCatalog,unitName,unitSort,type UnitAction} from '../../view/common/unitAuthor';
const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>readFileSync(resolve(root,file),'utf8');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const stripImports=(value:string)=>value.replace(/^import[\s\S]*?;\n/gmu,'');
const permissionTest='workers-ts/test/admin-permission.test.ts',groupPage='view/admin-ts/src/pages/user/UserGroups.vue',mobileTest='view/uniapp-ts/scripts/delivery-workbench-runtime.test.cjs';
const oldPort=(file:string)=>proof.predecessor_readports.includes(file);
function php(file:string){const row=proof.PHP_sources.find(row=>row.file===file);if(!row)throw Error('Missing complete fixed PHP original: '+file);return row.raw_utf8;}
function action(operation:UnitAction['operation']='update'):UnitAction{return{operation_id:'40000000-0000-4000-8000-000000000001',actor_id:1,operation,target_id:operation==='create'?0:20,revision:'a'.repeat(64),payload:operation==='delete'?{}:{name:'原名称',sort:0},payload_hash:'b'.repeat(64)};}
const row=(extra:Record<string,unknown>={})=>({id:1,type:0,relation_id:0,name:'',sort:-32768,status:1,is_del:0,add_time:0,...extra});

// UNIT_FIXED_CASES: 22
// The variable case count is generated from actual sources/additions/PHP/frozen
// records. Existing assertion and negative-fixture bodies are not rewritten.
describe('product-unit recoverable name/sort author and exact immutable source lineage',()=>{
 for(const source of proof.sources){
  it('pins full current and exact whole predecessor '+source.file,()=>{const raw=read(source.file);expect(sha(raw)).toBe(source.after_sha256);expect(sha(reverseUnitSource(source.file,raw))).toBe(source.before_sha256);expect(sha(readUnitPredecessor(resolve(root,source.file)))).toBe(source.before_sha256);});
  it('rejects source drift and generalized or forged inverse '+source.file,()=>{
   const raw=read(source.file);for(const bad of[raw.slice(1),raw+'\n// not reviewed\n',raw+raw])expect(()=>reverseUnitSource(source.file,bad)).toThrow();
   for(const key of['before_sha256','after_sha256']as const){const forged=structuredClone(proof);forged.sources.find(x=>x.file===source.file)![key]='0'.repeat(64);expect(()=>reverseUnitSource(source.file,raw,forged)).toThrow();}
   for(const key of['before_line','after_line']as const){const forged=structuredClone(proof);forged.sources.find(x=>x.file===source.file)!.edits[0]![key]=2;expect(()=>reverseUnitSource(source.file,raw,forged)).toThrow();}
   const forged=structuredClone(proof);forged.sources.find(x=>x.file===source.file)!.edits.push({...source.edits[0]!});expect(()=>reverseUnitSource(source.file,raw,forged)).toThrow();
  });
  if(oldPort(source.file))it('keeps all prior assertions and negative fixtures byte-identical '+source.file,()=>{expect(stripImports(source.edits[0]!.after_source)).toBe(stripImports(source.edits[0]!.before_source));});
  if(source.file===permissionTest)it('adds only the exact Unit original-owner family to the existing permission case',()=>{
   const c=proof.permission_test_extension,before=source.edits[0]!.before_source,after=source.edits[0]!.after_source;expect(c.applied).toBe(true);expect(c.unchanged_case_count).toBe(24);expect(sha(before)).toBe(c.before_sha256);expect(sha(after)).toBe(c.after_sha256);
   expect(after.split(c.added_source)).toHaveLength(2);expect(after.split('  isAdminUnitRecoveryRoute,\n')).toHaveLength(2);expect(after.replace(c.added_source,'').replace('  isAdminUnitRecoveryRoute,\n','')).toBe(before);
   for(const value of['pair("GET", `${prefix}/product/unit/author/receipt/:operationId`)','pair("POST", `${prefix}/product/unit/author/resolve`)'])expect(c.added_source).toContain(value);
  });
 }
 for(const source of proof.full_additions)it('pins complete new file '+source.file,()=>{const raw=readFileSync(resolve(root,source.file));expect(raw.byteLength).toBe(source.bytes);expect(sha(raw)).toBe(source.sha256);});
 for(const source of proof.PHP_sources)it('pins complete fixed PHP source '+source.file,()=>{expect(proof.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');expect(sha(source.raw_utf8)).toBe(source.sha256);expect(new TextEncoder().encode(source.raw_utf8).byteLength).toBe(source.bytes);});
 const frozen=Object.entries(proof.frozen_predecessor_evidence);
 for(let index=0;index<frozen.length;index+=64)it(`preserves accepted predecessor bytes ${index+1}..${Math.min(index+64,frozen.length)}`,()=>{for(const[file,hash]of frozen.slice(index,index+64))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);});
 it('keeps mature Unit CRUD, product and Supplier writers and shared privilege plan unchanged',()=>{
  for(const[file,hash]of Object.entries(proof.observed_unchanged))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);
  for(const file of['workers-ts/src/services/admin/AdminProductUnitService.ts','workers-ts/src/services/product/ProductMetadataService.ts','workers-ts/src/services/product/ProductUnitLifecycle.ts','workers-ts/src/services/product/ProductAssociationService.ts','workers-ts/src/services/supplier/SupplierProductManagementService.ts','workers-ts/src/services/supplier/SupplierProductCopyService.ts','workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts'])expect(Object.hasOwn(proof.observed_unchanged,file)).toBe(true);
 });
 it('composes Unit before Group and adapts28 old source ports without changing their bodies',()=>{
  expect(proof.predecessor_readports).toHaveLength(28);expect(proof.sources.filter(x=>oldPort(x.file))).toHaveLength(28);expect(proof.predecessor_readports).toContain('workers-ts/test/admin-group-source-binding.test.ts');
  for(const file of['workers-ts/src/routes/adminapi.ts','workers-ts/src/routes/v1/index.ts']){const before=reverseUnitSource(file,read(file));expect(readUnitPredecessor(resolve(root,file),'utf8')).toBe(before);expect(readGroupPredecessor(resolve(root,file),'utf8')).toBe(reverseGroupSource(file,before));}
  expect(sha(proof.previous_report.raw_utf8)).toBe(groupSourceBinding.current_report.sha256);
 });
 it('never reverses unrelated data or changes accepted Group proof helper or document',()=>{
  expect(reverseUnitSource('unrelated.ts','unit author text')).toBe('unit author text');expect(Object.keys(proof.frozen_predecessor_evidence)).toHaveLength(1718);
  for(const file of['workers-ts/test/helpers/groupSourceBinding.ts','workers-ts/audit/user-group-author-source-binding-20261026.json','workers-ts/docs/php-ts-user-group-author-20261026.md']){expect(proof.sources.some(x=>x.file===file)).toBe(false);expect(Object.hasOwn(proof.frozen_predecessor_evidence,file)).toBe(true);}
 });
 it('rebuilds actual763/801 and retains759 old callSites and797 variant records including legacy Unit wrappers',()=>{
  const current=buildAdminFrontendApiAuditReport(),before=buildUnitPredecessorApiAuditReport();expect(JSON.stringify(current,null,2)+'\n').toBe(read(proof.current_report.file));expect(sha(read(proof.current_report.file))).toBe(proof.current_report.sha256);
  expect(before.counts).toEqual({callSites:759,pathVariants:797,registered:797,executable:797,controlledUnavailable:0,unregistered:0,unresolved:0});expect(current.counts).toEqual({callSites:763,pathVariants:801,registered:801,executable:801,controlledUnavailable:0,unregistered:0,unresolved:0});
  for(const call of before.calls)expect(current.calls).toContainEqual(call);expect(proof.retired_api_calls).toEqual([]);expect(current.calls.filter(c=>c.source==='view/admin-ts/src/api/productMetadata.ts')).toEqual(before.calls.filter(c=>c.source==='view/admin-ts/src/api/productMetadata.ts'));
  expect(current.calls.filter(c=>c.source==='view/admin-ts/src/api/unitAuthor.ts').map(c=>[c.method,c.path])).toEqual([['GET','/product/unit/author/catalog'],['POST','/product/unit/author/commit'],['GET','/product/unit/author/receipt/:param'],['POST','/product/unit/author/resolve']]);
 });
 it('binds original routed name/sort form15 and original15/page without inventing an icon slot',()=>{
  const router=php('view/admin/src/router/modules/product.js'),parent=/^\s*path: '([^']+)',/mu.exec(router),child=/^\s*path: '(unitList)',([\s\S]*?)component: \(\) => import\('([^']+)'\)/mu.exec(router);
  expect(parent?.[1]).toBe('/admin/product');expect(child?.[1]).toBe('unitList');expect(child?.[3]).toBe('@/pages/product/unitList');expect(child?.[2]).toContain("auth: ['admin-storeProduct-unit']");expect(`${parent?.[1]}/${child?.[1]}`).toBe('/admin/product/unitList');const service=php('app/services/product/product/StoreProductUnitServices.php');for(const value of["FormBuilder::input('name'",'maxlength(15)',"FormBuilder::number('sort'",'->min(0)'])expect(service).toContain(value);
  const page=php('view/admin/src/pages/product/unitList/index.vue');for(const value of['key: "name"','key: "sort"','limit: 15','minWidth: 100'])expect(page).toContain(value);expect(page).not.toContain('key: "icon"');expect(UNIT_FIELDS).toEqual(['name','sort']);
 });
 it('binds only raw name and numeric sort in authored payload and canonical domain order',()=>{
  expect(newUnitValues()).toEqual({name:'',sort:0});const a=action();expect(unitAction(a,1)).toEqual(a);expect(unitCanonical(a)).toEqual({domain:'product-unit-author-v1',actor_id:1,operation_id:a.operation_id,operation:'update',target_id:20,revision:a.revision,payload:{name:'原名称',sort:0}});expect(Object.keys(unitCanonical(a))).toEqual(['domain','actor_id','operation_id','operation','target_id','revision','payload']);
 });
 it('rejects hidden status ownership image and lifecycle fields in the two-value payload',()=>{const a=action();for(const extra of[{status:0},{is_del:1},{type:2},{relation_id:7},{image:'ticket'},{add_time:8}])expect(()=>unitAction({...a,payload:{...a.payload,...extra}},1)).toThrow();});
 it('rejects foreign owner bad operation target and extra envelope without normalizing the request',()=>{const a=action();for(const patch of[{actor_id:2},{operation:'restore'},{target_id:0},{extra:1}])expect(()=>unitAction({...a,...patch},1)).toThrow();});
 it('strictly binds committed and not-applied receipt target counters and original revision',()=>{
  const a=action(),{payload:_,...metadata}=a,result={id:20,created:0,updated:1,count:1,revision:'c'.repeat(64)};expect(unitReceipt({...metadata,state:'committed',result},a).state).toBe('committed');for(const change of[{id:21},{created:1},{updated:0}])expect(()=>unitReceipt({...metadata,state:'committed',result:{...result,...change}},a)).toThrow();
  const no={id:20,created:0,updated:0,count:0,revision:a.revision};expect(unitReceipt({...metadata,state:'not_applied',result:no},a).state).toBe('not_applied');for(const change of[{count:1},{revision:'d'.repeat(64)}])expect(()=>unitReceipt({...metadata,state:'not_applied',result:{...no,...change}},a)).toThrow();
 });
 it('requires a complete eight-value active-platform catalog with no foreign hidden duplicate or lost tail',()=>{
  const c={list:[row()],count:1,revision:'a'.repeat(64),write_ready:true,can_create:false};expect(unitCatalog(c)).toEqual(c);
  for(const change of[{count:2},{list:[row(),row()],count:2},{list:[row({relation_id:2})]},{list:[row({status:0})]},{list:[row({is_del:1})]},{list:[row({extra:true})]},{extra:1},{write_ready:1},{can_create:1}])expect(()=>unitCatalog({...c,...change})).toThrow();
 });
 it('preserves exact historical varchar50 names and limits explicit changed names to15 Unicode',()=>{for(const name of['','  ','\u0000旧\u0085','😀'.repeat(50)])expect(unitName(name,name)).toBe(name);expect(unitName('  '+'😀'.repeat(15)+' ')).toBe('😀'.repeat(15));for(const name of['',' '.repeat(20),'😀'.repeat(16),'坏\u0085值','坏\ud800值'])expect(()=>unitName(name)).toThrow();});
 it('preserves exact historical signed-smallint sorts but rejects new or different negative sorts',()=>{expect(unitSort(-32768,-32768)).toBe(-32768);expect(unitSort(32767)).toBe(32767);for(const value of[-1,-32769,32768,1.5,'01',null])expect(()=>unitSort(value)).toThrow();expect(()=>unitSort(-32767,-32768)).toThrow();});
 it('keeps raw4096 name budget distinct from normalized15 and signed sort semantics',()=>{const name=' '.repeat(100)+'😀'.repeat(15),a=action();expect(unitName(name)).toBe('😀'.repeat(15));expect(unitAction({...a,payload:{name,sort:0}},1).payload.name).toBe(name);expect(()=>unitAction({...a,payload:{name:' '.repeat(4097),sort:0}},1)).toThrow();expect(proof.boundaries.values).toContain('4096');});
 it('records complete private all8 plus xmin CAS without exposing foreign or hidden rows',()=>{for(const value of['all8','every xmin','global private revision','20000/16MiB','can_create','INSERT RETURNING'])expect(proof.boundaries.source).toContain(value);const schema=read('workers-ts/src/models/schema/catalog_templates.ts');expect(schema).toContain('name: varchar("name", { length: 50 })');expect(schema).toContain('sort: smallint("sort")');});
 it('records softdelete of only is_del and global nondeleted-product reference checks',()=>{for(const value of['Softdelete','other7','No status/restore','foreign owners','free text'])expect(proof.boundaries.deletion).toContain(value);const mature=read('workers-ts/src/services/product/ProductMetadataService.ts');expect(mature).toContain('.set({ isDel: 1 })');expect(mature).toContain('eq(storeProduct.unitName, unit.name)');});
 it('checks original UUID before source revision while keeping missing receipts explicitly unknown',()=>{const code=read('workers-ts/src/services/admin/AdminUnitAuthorService.ts'),mutation=code.slice(code.indexOf('  mutate('));expect(mutation.indexOf('await this.prior(tx,action)')).toBeGreaterThanOrEqual(0);expect(mutation.indexOf('await this.prior(tx,action)')).toBeLessThan(mutation.indexOf('action.revision!==before.revision'));for(const value of['UUID before','Missing404','not_applied'])expect(proof.boundaries.recovery).toContain(value);});
 it('records original real product/Supplier lifecycle serialization before new author lock',()=>{for(const value of['731611,0','SHARE ROW EXCLUSIVE NOWAIT','731639,1','FOR UPDATE NOWAIT'])expect(proof.boundaries.concurrency).toContain(value);for(const file of['workers-ts/src/services/product/ProductAssociationService.ts','workers-ts/src/services/supplier/SupplierProductManagementService.ts','workers-ts/src/services/supplier/SupplierProductCopyService.ts'])expect(read(file)).toContain('await lockProductUnitLifecycle(tx)');});
 it('records product permissions original1349 read-only and bounded owner recovery',()=>{for(const value of['product.view','product.manage','Numeric1349','read-only','owner recovery','role-reference'])expect(proof.boundaries.authority).toContain(value);expect(proof.boundaries.scope).toContain('existing CRUD was already migrated');});
 it('records immutable receipt addon and explicit native commissioning without request DDL',()=>{for(const value of['immutable9','Admin SELECT/INSERT','App none','731626,22','no HTTP/startup DDL'])expect(proof.boundaries.receipt).toContain(value);expect(proof.full_additions.some(x=>x.file==='workers-ts/test/admin-unit-author-native.test.ts')).toBe(true);});
 it('records cached native stable name/rawSort active-tab leases and nonsecret sequential journals',()=>{for(const value of['cacheHandlers:true','stable name/rawSort','active ABA','per-owner UUID','hidden tab','changed emits only strict committed'])expect(proof.boundaries.frontend).toContain(value);for(const value of['Original15/page','literal','other four'])expect(proof.boundaries.search).toContain(value);});
 it('keeps old Group frontend5 and maintained mobile39 exact rather than creating a new late basis',()=>{for(const file of[groupPage,'workers-ts/test/admin-user-groups-frontend.test.ts',mobileTest]){expect(proof.sources.some(x=>x.file===file)).toBe(false);expect(sha(read(file))).toBe(proof.observed_unchanged[file]);}expect(proof.baseline).toEqual({file_count:7200,sha256:'abf9418d7fd3f93c479e3fa0de760468ddc9229735dba15ba1191d5cbcd9da23'});expect(proof.boundaries.tests).toContain('remaining24');});
 it('does not turn exact source lineage or next-stage preparation into runtime acceptance',()=>{for(const value of['Source-only','Not acceptance','1718','12 complete'])expect(proof.boundaries.evidence).toContain(value);expect(proof.retired_api_calls).toEqual([]);expect(proof.full_additions.some(x=>x.file==='workers-ts/test/helpers/unitSourceBinding.ts')).toBe(false);});
});
