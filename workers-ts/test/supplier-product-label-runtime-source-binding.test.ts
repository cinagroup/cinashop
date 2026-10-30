import {createHash} from 'node:crypto';
import {readBargainRecordsPredecessor as readFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {bargainRecordsPredecessorExecFileSync as execFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {buildBargainRecordsPredecessorApiAuditReport as buildAdminFrontendApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {supplierProductLabelRuntimeSourceBinding as bound,reverseSupplierProductLabelRuntimeSource,reverseSupplierProductLabelRuntimePredecessorPublication,
 readSupplierProductLabelRuntimePredecessor,readProductLabelAuthorPredecessor,readHotwordPredecessor,
 productLabelAuthorSourceBinding,reverseProductLabelAuthorSource,reverseProductLabelAuthorPredecessorPublication,
 reverseHotwordSource,reverseHotwordPredecessorPublication,
 buildSupplierProductLabelRuntimePredecessorApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {supplierProductLabelCapabilityBody,supplierProductLabelOwnerGrantSql,SUPPLIER_PRODUCT_LABEL_CAPABILITY_SIGNATURE,SUPPLIER_PRODUCT_LABEL_CAPABILITY_GATE} from '../src/migrations/supplierProductLabelCapability';
import {parseSupplierProductLabelInput} from '../src/services/supplier/SupplierProductLabelInput';

const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>readFileSync(resolve(root,file),'utf8');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
type Image={file:string;before_source:string;after_source:string;before_sha256:string;after_sha256:string};
type Origin={file:string;sha256:string;raw_utf8:string};
type Case={file:string;title:string;fullName:string;before_body:string;after_body:string;before_body_sha256:string;after_body_sha256:string;fixture_declaration_edits:Array<{before:string;after:string}>};
const proof=bound as typeof bound&{
 baseline_manifest:Origin;predecessor_receipt:Origin;controlled_source_manifest:Array<{path:string;sha256:string;bytes:number}>;generated_outputs_observation:Origin;
 publication_outputs_excluded:string[];generated_outputs_excluded_prefixes:string[];
 legacy_test_maintenance:{legacy_supplier:{case_identity_counts:Record<string,number>;cases:Case[];files:Image[];metadata:Origin};adjacent_platform:Image&{metadata:Origin;case_count_changed:number}};
};
const stripImports=(source:string)=>source.replace(/^import[\s\S]*?;\n/gmu,'');
function portAfter(file:string,source:string){
 let result=source.replace(/^import[\s\S]*?;\n/gmu,entry=>entry.replace(/(from\s*['"])\.\/helpers\/productLabelAuthorSourceBinding(['"])/gu,'$1./helpers/supplierProductLabelRuntimeSourceBinding$2'));
 if(file.endsWith('/admin-product-label-author-source-binding.test.ts')){
  result=result.replace(/^import \{readFileSync\} from 'node:fs';$/mu,"import {readSupplierProductLabelRuntimePredecessor as readFileSync} from './helpers/supplierProductLabelRuntimeSourceBinding';")
   .replace(/^import \{buildAdminFrontendApiAuditReport\} from '\.\.\/scripts\/admin-frontend-api-audit';$/mu,"import {buildSupplierProductLabelRuntimePredecessorApiAuditReport as buildAdminFrontendApiAuditReport} from './helpers/supplierProductLabelRuntimeSourceBinding';");
 }
 return result;
}

describe('Supplier label current App full-byte increment; evidence is not runtime acceptance',()=>{
 for(const source of proof.sources){
  it('pins complete current and accepted ProductLabel bytes '+source.file,()=>{const raw=read(source.file);expect(sha(raw)).toBe(source.after_sha256);expect(sha(reverseSupplierProductLabelRuntimeSource(source.file,raw))).toBe(source.before_sha256);expect(readSupplierProductLabelRuntimePredecessor(resolve(root,source.file),'utf8')).toBe(source.edits[0]!.before_source);});
  it('refuses altered current and forged whole-file inverse '+source.file,()=>{const raw=read(source.file);for(const bad of[raw.slice(1),raw+'\n// drift\n',raw+raw])expect(()=>reverseSupplierProductLabelRuntimeSource(source.file,bad)).toThrow();for(const key of['before_sha256','after_sha256']as const){const forged={...proof,sources:proof.sources.map(row=>row===source?{...row,[key]:'0'.repeat(64)}:row)};expect(()=>reverseSupplierProductLabelRuntimeSource(source.file,raw,forged)).toThrow();}const forged={...proof,sources:proof.sources.map(row=>row===source?{...row,edits:row.edits.map(edit=>({...edit,before_line:2}))}:row)};expect(()=>reverseSupplierProductLabelRuntimeSource(source.file,raw,forged)).toThrow();});
  if(proof.predecessor_readports.includes(source.file))it('retains exact old source body and negative fixtures '+source.file,()=>{const edit=source.edits[0]!;expect(stripImports(edit.after_source)).toBe(stripImports(edit.before_source));expect(edit.after_source).toBe(portAfter(source.file,edit.before_source));for(const entry of edit.after_source.match(/^import[\s\S]*?;\n/gmu)??[])expect(entry).not.toMatch(/from\s*['"]\.\/helpers\/productLabelAuthorSourceBinding['"]/u);});
 }
 for(const file of proof.full_additions)it('pins full new source without inventing predecessor '+file.file,()=>{const raw=readFileSync(resolve(root,file.file));expect(raw.byteLength).toBe(file.bytes);expect(sha(raw)).toBe(file.sha256);expect(proof.sources.some(row=>row.file===file.file)).toBe(false);});
 for(const file of proof.PHP_sources)it('pins full fixed Supplier PHP blob '+file.file,()=>{expect(Buffer.byteLength(file.raw_utf8)).toBe(file.bytes);expect(sha(file.raw_utf8)).toBe(file.sha256);expect(file.git_blob).toMatch(/^[a-f0-9]{40}$/u);expect(proof.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');});
 const frozen=Object.entries(proof.frozen_predecessor_evidence);for(let i=0;i<frozen.length;i+=64)it('retains immutable predecessor bytes chunk '+i,()=>{for(const[file,hash]of frozen.slice(i,i+64))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);});

 // FIXED_SEMANTIC_CASES: static declarations below are counted by the publisher.
 it('partitions true8023 before and all controlled changed/additional files with no missing or duplicated image',()=>{
  expect(proof.baseline).toEqual({file_count:8023,sha256:'bb3ed62246c18ebf0702b36f400d8101f247e9f6e73bfa6af397d3ff9a72d1e9'});
  expect(sha(proof.baseline_manifest.raw_utf8)).toBe(proof.baseline.sha256);
  const before=JSON.parse(proof.baseline_manifest.raw_utf8)as Array<{path:string;sha256:string;bytes:number}>,byName=new Map(before.map(row=>[row.path,row]));expect(byName.size).toBe(8023);
  const inventory=execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0');
  const controlled=(file:string)=>!!file&&!proof.publication_outputs_excluded.includes(file)&&!proof.generated_outputs_excluded_prefixes.some(prefix=>file.startsWith(prefix));
  const paths=[...new Set([...inventory,...before.map(row=>row.path)])].filter(controlled).sort();
  expect(proof.controlled_source_manifest.map(row=>row.path)).toEqual(paths);
  const modified:string[]=[],added:string[]=[];
  for(const row of proof.controlled_source_manifest){const raw=readFileSync(resolve(root,row.path));expect(raw.byteLength).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);if(!byName.has(row.path))added.push(row.path);else if(byName.get(row.path)!.sha256!==row.sha256)modified.push(row.path);}
  expect(proof.sources.map(row=>row.file)).toEqual(modified);expect(proof.full_additions.map(row=>row.file)).toEqual(added);
  expect(new Set(proof.sources.map(row=>row.file)).size).toBe(proof.sources.length);expect(new Set(proof.full_additions.map(row=>row.file)).size).toBe(proof.full_additions.length);
 });
 it('retains1736 immutable predecessor files and all34 import-only old suites including original ProductLabel raw reader and builder',()=>{
  expect(frozen).toHaveLength(1736);expect(proof.predecessor_readports).toHaveLength(34);expect(new Set(proof.predecessor_readports).size).toBe(34);
  expect([...proof.predecessor_readports].sort()).toEqual([...productLabelAuthorSourceBinding.predecessor_readports,'workers-ts/test/admin-product-label-author-source-binding.test.ts'].sort());
  for(const file of['workers-ts/audit/product-label-author-source-binding-20261027.json','workers-ts/test/helpers/productLabelAuthorSourceBinding.ts','workers-ts/docs/php-ts-product-label-author-20261027.md']){expect(sha(readFileSync(resolve(root,file)))).toBe(proof.frozen_predecessor_evidence[file]);expect(proof.sources.some(row=>row.file===file)).toBe(false);}
  const port=proof.sources.find(row=>row.file.endsWith('/admin-product-label-author-source-binding.test.ts'))!.edits[0]!;
  expect(port.after_source).toContain('readSupplierProductLabelRuntimePredecessor as readFileSync');expect(port.after_source).toContain('buildSupplierProductLabelRuntimePredecessorApiAuditReport as buildAdminFrontendApiAuditReport');expect(stripImports(port.after_source)).toBe(stripImports(port.before_source));
 });
 it('binds complete physical label publication images and five full manifest or receipt origins without trimming ledgers',()=>{
  expect(proof.predecessor_publication.map(row=>row.file)).toEqual(['MIGRATION_AUDIT.md','MIGRATION_CHECKLIST.md']);const origins=proof.predecessor_publication_origins;
  expect(Object.keys(origins).sort()).toEqual(['product_label_validation_manifest','product_label_before_manifest','product_label_accepted_manifest','supplier_label_before_manifest','product_label_receipt'].sort());
  for(const origin of Object.values(origins)){expect(sha(origin.raw_utf8)).toBe(origin.sha256);expect(readFileSync(origin.file,'utf8')).toBe(origin.raw_utf8);}
  const receipt=JSON.parse(origins.product_label_receipt!.raw_utf8)as {status:string;counts:{source:number};input_manifest_sha256:string;current_source_manifest_sha256:string};expect(receipt.status).toBe('accepted');expect(receipt.counts.source).toBe(4493);expect(receipt.input_manifest_sha256).toBe(proof.baseline.sha256);expect(receipt.current_source_manifest_sha256).toBe(origins.product_label_validation_manifest!.sha256);
  for(const bridge of proof.predecessor_publication){expect(sha(bridge.accepted_source)).toBe(bridge.accepted_sha256);expect(sha(bridge.validation_source)).toBe(bridge.validation_sha256);expect(readFileSync(bridge.accepted_origin,'utf8')).toBe(bridge.accepted_source);expect(readFileSync(bridge.validation_origin,'utf8')).toBe(bridge.validation_source);expect(bridge.validation_origin).toContain('/hotword-author-20261027/inputs/');
   for(const key of['product_label_validation_manifest','product_label_before_manifest']){const row=(JSON.parse(origins[key]!.raw_utf8)as Array<{path:string;sha256:string;bytes:number}>).find(row=>row.path===bridge.file)!;expect(row.sha256).toBe(bridge.validation_sha256);expect(row.bytes).toBe(Buffer.byteLength(bridge.validation_source));}
   for(const key of['product_label_accepted_manifest','supplier_label_before_manifest']){const row=(JSON.parse(origins[key]!.raw_utf8)as Array<{path:string;sha256:string;bytes:number}>).find(row=>row.path===bridge.file)!;expect(row.sha256).toBe(bridge.accepted_sha256);expect(row.bytes).toBe(Buffer.byteLength(bridge.accepted_source));}
  }
 });
 it('rejects nonexact publication bytes and forged bridge hashes while composing each immutable validation layer',()=>{
  for(const bridge of proof.predecessor_publication){expect(reverseSupplierProductLabelRuntimePredecessorPublication(bridge.file,bridge.accepted_source)).toBe(bridge.validation_source);for(const bad of[bridge.accepted_source+'\n',bridge.accepted_source.slice(1),bridge.validation_source])expect(()=>reverseSupplierProductLabelRuntimePredecessorPublication(bridge.file,bad)).toThrow();for(const key of['accepted_sha256','validation_sha256']as const){const forged={...proof,predecessor_publication:proof.predecessor_publication.map(row=>row===bridge?{...row,[key]:'0'.repeat(64)}:row)};expect(()=>reverseSupplierProductLabelRuntimePredecessorPublication(bridge.file,bridge.accepted_source,forged)).toThrow();}
   const current=read(bridge.file),labelValidation=reverseSupplierProductLabelRuntimePredecessorPublication(bridge.file,reverseSupplierProductLabelRuntimeSource(bridge.file,current));expect(readSupplierProductLabelRuntimePredecessor(resolve(root,bridge.file),'utf8')).toBe(labelValidation);
   const hotwordValidation=reverseProductLabelAuthorPredecessorPublication(bridge.file,reverseProductLabelAuthorSource(bridge.file,labelValidation));expect(readProductLabelAuthorPredecessor(resolve(root,bridge.file),'utf8')).toBe(hotwordValidation);
   const parameterValidation=reverseHotwordPredecessorPublication(bridge.file,reverseHotwordSource(bridge.file,hotwordValidation));expect(readHotwordPredecessor(resolve(root,bridge.file),'utf8')).toBe(parameterValidation);
  }expect(reverseSupplierProductLabelRuntimeSource('unrelated','plain')).toBe('plain');
 });
 it('runs current789 callSites827 variants before keeping every exact report byte and predecessor call object',()=>{
  const current=buildAdminFrontendApiAuditReport(),previous=buildSupplierProductLabelRuntimePredecessorApiAuditReport();expect(JSON.stringify(current,null,2)+'\n').toBe(read(proof.current_report.file));expect(sha(proof.previous_report.raw_utf8)).toBe(proof.current_report.sha256);expect(proof.previous_report.raw_utf8).toBe(read(proof.current_report.file));expect(current).toEqual(previous);expect(current.counts).toEqual({callSites:789,pathVariants:827,registered:827,executable:827,controlledUnavailable:0,unregistered:0,unresolved:0});expect(proof.retired_api_calls).toEqual([]);
 });
 it('keeps all prior frontend public selection binding and privilege plan bytes unchanged for a backend-only closure',()=>{
  for(const[file,hash]of Object.entries(proof.observed_unchanged))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);
  for(const file of['workers-ts/src/services/admin/AdminProductLabelService.ts','workers-ts/src/services/product/PublicProductLabelData.ts','workers-ts/src/services/product/ProductAssociationService.ts','workers-ts/src/services/supplier/SupplierProductLabelBindings.ts','workers-ts/src/services/supplier/SupplierProductLabelInput.ts','workers-ts/src/services/supplier/SupplierPermissionService.ts','workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts','view/admin-ts/src/pages/label/ProductLabelAuthor.vue','view/uniapp-ts/src/composables/useGoodsSearch.ts'])expect(Object.hasOwn(proof.observed_unchanged,file),file).toBe(true);
  expect(Object.hasOwn(proof.observed_unchanged,'workers-ts/src/services/supplier/SupplierProductLabelService.ts')).toBe(false);expect(proof.boundaries.observed).toContain('No GUI/build rerun');
  const observation=proof.generated_outputs_observation;expect(sha(observation.raw_utf8)).toBe(observation.sha256);expect(readFileSync(observation.file,'utf8')).toBe(observation.raw_utf8);const generated=JSON.parse(observation.raw_utf8)as {basis:string;files:Array<{path:string;bytes:number;sha256:string}>};expect(generated.basis).toContain('never a manufactured turn-start before');for(const row of generated.files){const raw=readFileSync(resolve(root,row.path));expect(raw.byteLength).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);}
 });
 it('pins18 complete fixed originals and preserves the routed Supplier two-value contract without restoring dead Admin features',()=>{
  expect(proof.PHP_sources).toHaveLength(18);const php=(suffix:string)=>proof.PHP_sources.find(row=>row.file.endsWith(suffix))!.raw_utf8;
  const routes=php('route/supplier.php');expect(routes).toContain('StoreProductLabel');expect(routes).not.toContain('StoreProductLabel/batch');
  expect(parseSupplierProductLabelInput({label_cate:1,label_name:'🧭'.repeat(20)})).toEqual({labelCate:1,labelName:'🧭'.repeat(20),expectedRevision:undefined});expect(()=>parseSupplierProductLabelInput({label_cate:1,label_name:'标签',is_show:0})).toThrow();expect(proof.boundaries.scope).toContain('no new Supplier status/show/batch/group author');
 });
 it('fixes one five-argument source-defined capability and exact two-value or empty-delete payload shapes',()=>{
  expect(SUPPLIER_PRODUCT_LABEL_CAPABILITY_SIGNATURE).toBe('public.supplier_product_label_mutate_v1(jsonb,text,integer,jsonb,jsonb)');const body=supplierProductLabelCapabilityBody('owned_app');
  expect(body).toContain("p_operation NOT IN('create','update','delete')");expect(body).toContain("ARRAY['label_cate','label_name']");expect(body).toContain("p_payload<>'{}'::jsonb");expect(body).toContain("pg_catalog.to_jsonb(v_before) IS DISTINCT FROM p_expected");expect(body).toContain('v_actual IS DISTINCT FROM v_wanted');expect(body).toContain("SET label_cate=v_group_id,label_name=v_name");
  const port=read('workers-ts/src/services/supplier/SupplierProductLabelWriteCapability.ts');expect(port).toContain('await assertSupplierProductLabelCapabilityReady(db)');expect(port).toContain('public.supplier_product_label_mutate_v1');expect(port).not.toMatch(/db\.(insert|update|delete)\(/u);expect(port.indexOf('JSON.stringify(payload)')).toBeLessThan(port.indexOf('await assertSupplierProductLabelCapabilityReady'));
 });
 it('derives live primary roles and menus twice after the owner fence with no supplied authorization boolean or wildcard expansion',()=>{
  const body=supplierProductLabelCapabilityBody('owned_app');expect(SUPPLIER_PRODUCT_LABEL_CAPABILITY_GATE).toEqual([731626,28]);expect(body).toContain('pg_advisory_xact_lock(731737,v_supplier_id)');expect(body).toContain('FOR v_phase IN 1..2 LOOP');expect(body).toContain('v_supplier.admin_id=v_admin.id');expect(body).toContain('md5(v_admin.pwd)');expect(body).toContain('pg_catalog.cardinality(v_active_tokens)>512');expect(body).toContain("v_manage:='supplier.product.manage'=ANY(v_active_tokens)");expect(body).toContain('v_authority_before IS DISTINCT FROM v_authority_now');expect(body).toContain('ORDER BY id FOR SHARE NOWAIT');
  const service=read('workers-ts/src/services/supplier/SupplierProductLabelService.ts');expect(service).toContain('mutateSupplierProductLabel');expect(service).not.toContain('db.insert(storeProductLabel)');expect(service).not.toContain('db.delete(storeProductLabel)');
 });
 it('grants only a precreated restricted function owner and App EXECUTE with no App label DML or auxiliary or sequence escape',()=>{
  const owner=supplierProductLabelOwnerGrantSql('owned_owner').join('\n');expect(owner).toContain('GRANT DELETE ON public.store_product_label TO "owned_owner"');expect(owner).toContain('GRANT SELECT("label_id") ON public."store_product_label_auxiliary"');expect(owner).toContain('GRANT UPDATE("label_cate","label_name")');
  const installer=read('workers-ts/src/migrations/runSupplierProductLabelUpgrade.ts');expect(installer).not.toContain('CREATE ROLE');expect(installer).toContain('precreated empty restricted NOLOGIN');expect(installer).toContain('GRANT EXECUTE ON FUNCTION');expect(installer).toContain('REVOKE ALL ON FUNCTION');expect(installer).not.toContain('GRANT INSERT ON');
  const cap=read('workers-ts/src/migrations/supplierProductLabelCapability.ts');for(const text of['o.rolcanlogin','o.rolinherit','o.rolbypassrls','a.is_grantable','p.prosrc','p.proargnames','pg_catalog.pg_get_expr','public.store_product_label_auxiliary','public.store_product_label_id_seq'])expect(cap).toContain(text);
  const coexist=read('workers-ts/src/migrations/adminProductLabelOperation.ts');expect(coexist).toContain('inspectSupplierProductLabelCapability');expect(coexist).toContain('ownerOid');expect(proof.boundaries.schema_and_ACL).toContain('no App direct read or unreviewed owner exception');
 });
 it('retains private relation auxiliary and conservative CSV deletion checks after forced deferred effects and exact audit reread',()=>{
  const body=supplierProductLabelCapabilityBody('owned_app');for(const text of['public.store_product_relation','public.store_product_label_auxiliary','p.store_label_id','v_audit IS DISTINCT FROM v_audit_wanted','SET CONSTRAINTS ALL IMMEDIATE','v_read IS DISTINCT FROM v_audit_wanted','v_read IS DISTINCT FROM v_group_before'])expect(body).toContain(text);
  expect(body.lastIndexOf('FROM public.store_product_label_auxiliary')).toBeGreaterThan(body.indexOf('SET CONSTRAINTS ALL IMMEDIATE'));expect(body).toContain("'supplier_product_label'");expect(body).toContain("'供应商商品标签管理'");
 });
 it('fully discloses original23 maintained identities and only two dangerous trigger declaration inverses with no old implementation substitute',()=>{
  const m=proof.legacy_test_maintenance.legacy_supplier;expect(m.case_identity_counts).toEqual({HTTP_maintained:14,native_maintained:9,new_cases:0});expect(m.cases).toHaveLength(23);let declarations=0;
  for(const image of m.files){expect(sha(image.before_source)).toBe(image.before_sha256);expect(sha(image.after_source)).toBe(image.after_sha256);expect(read(image.file)).toBe(image.after_source);}
  for(const c of m.cases){expect(sha(c.before_body)).toBe(c.before_body_sha256);expect(sha(c.after_body)).toBe(c.after_body_sha256);expect(read(c.file)).toContain(c.after_body);let restored=c.after_body;for(const edit of c.fixture_declaration_edits){declarations++;expect(edit.after).toContain('SECURITY DEFINER');expect(edit.after).toContain('REVOKE ALL');restored=restored.replace(edit.after,()=>edit.before);}expect(restored).toBe(c.before_body);}expect(declarations).toBe(2);
  const adjacent=proof.legacy_test_maintenance.adjacent_platform;expect(adjacent.case_count_changed).toBe(0);expect(sha(adjacent.before_source)).toBe(adjacent.before_sha256);expect(sha(adjacent.after_source)).toBe(adjacent.after_sha256);expect(read(adjacent.file)).toBe(adjacent.after_source);
 });
 it('distinguishes actual current independent LOGINs from the narrower old fixture and proves deferred faults can really execute',()=>{
  const current=read('workers-ts/test/supplier-product-label-runtime-native.test.ts'),extra=read('workers-ts/test/supplier-product-label-capability-native.test.ts'),old=read('workers-ts/test/helpers/supplierProductLabelCapabilityFixture.ts');
  for(const text of['runRuntimeBusinessCommissioning','createApp()','HYPERDRIVE','runSupplierProductLabelUpgrade'])expect(current).toContain(text);for(const text of['interruptedAfterFinalGrant','installedInsideTransaction','tsPermissionProbe','sqlPermissionProbe','DEFERRABLE INITIALLY DEFERRED','owned_supplier_label_probe','not.toContain(\'42501\')'])expect(extra).toContain(text);expect(old).toContain('Deliberately narrower');expect(old).toContain('No production installer/current-profile acceptance claim');expect(old).not.toContain('GRANT SELECT ON ALL TABLES');
 });
 it('admits the exact new definer only in current shared-shop pricing recognition while isolated scopes and the fixed privilege plan remain frozen',()=>{
  const pricing=read('workers-ts/src/migrations/checkoutPricingLock.ts'),auditor=read('workers-ts/src/migrations/auditRuntimeBusinessPrivileges.ts');expect(pricing).toContain('inspectSupplierProductLabelCapability');expect(auditor).toContain('inspectSupplierProductLabelCapability');expect(auditor).toContain('functionOid');expect(sha(read('workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts'))).toBe(proof.observed_unchanged['workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts']);expect(proof.boundaries.locks).toContain('shared-shop, never isolated/customer');
 });
 it('records backend-only scope without fabricated runtime acceptance additional frontend values or a new receipt protocol',()=>{
  expect(proof.boundaries.evidence).toContain('Source proof is not runtime/GUI/native acceptance');expect(proof.boundaries.evidence).toContain('4493');expect(proof.boundaries.scope).toContain('Exactly label_cate and label_name');expect(proof.boundaries.capability).toContain('no App catalog INSERT/UPDATE/DELETE');expect(proof.boundaries.legacy_tests).toContain('not a whole');expect(Object.hasOwn(proof,'source_binding_maintenance')).toBe(false);
 });
});
