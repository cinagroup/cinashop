/** Explicit owned PG16 installation and minimum LOGIN admission; no production DDL. */
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {URL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTx,createContainerFromDb} from '@/lib/di';
import {installSupplierExtractApplication,assertSupplierExtractApplicationReady,SUPPLIER_EXTRACT_APPLICATION_SQL} from '@/migrations/supplierExtractApplication';
import {SupplierExtractApplicationService} from '@/services/supplier/SupplierExtractApplicationService';
import {md5} from '@/utils/jwt';
import {supplierExtractApplicationFixture} from './helpers/supplierExtractApplication';
import {supplierExtractReadPassword} from './helpers/supplierExtractRead';
const actor={id:21,supplierId:7,authVersion:md5(supplierExtractReadPassword),expiresAt:2147483647};
const input=(revision:string)=>({operation_id:randomUUID(),revision,extract_type:'bank',money:'10.00',mark:''});
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier0197 independent original application catalog PG16',()=>{
 let f:Awaited<ReturnType<typeof supplierExtractApplicationFixture>>;
 beforeEach(()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('0197 forbids outbound I/O'));});
 afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();await f?.close();}finally{vi.restoreAllMocks();}});
 it('keeps module DDL equal to the independent0197 SQL and installs only through explicit maintenance',async()=>{
  f=await supplierExtractApplicationFixture({catalog:false});expect(readFileSync(new URL('../src/migrations/maintenance/0197_supplier_extract_application.sql',import.meta.url),'utf8')).toBe('-- Explicit independent PG16 maintenance only; never HTTP/startup.\n'+SUPPLIER_EXTRACT_APPLICATION_SQL);
  await f.withApplicant(async runtime=>{const service=new SupplierExtractApplicationService(runtime.container,f.env.APP_KEY),before=await f.snapshot();await expect(service.seed(actor)).rejects.toMatchObject({code:503});expect(await f.snapshot()).toEqual(before);});
  expect(await withTx(createContainerFromDb(f.db),tx=>installSupplierExtractApplication(tx))).toEqual({applied:true});expect(await withTx(createContainerFromDb(f.db),tx=>installSupplierExtractApplication(tx))).toEqual({applied:false});
  await expect(new SupplierExtractApplicationService(createContainerFromDb(f.db),f.env.APP_KEY).seed(actor)).rejects.toMatchObject({code:503});
 });
 it('keeps missing SELECT preflight503 inside an otherwise usable transaction',async()=>{
  f=await supplierExtractApplicationFixture();await f.withLookup(async runtime=>{
   await f.exec(`REVOKE SELECT ON public.supplier_extract_application_operation_v1 FROM "${runtime.role}"`);
   await withTx(runtime.container,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);await expect(assertSupplierExtractApplicationReady(tx,'read')).rejects.toMatchObject({code:503});const[row]=await tx.execute(sql`SELECT 1 AS alive`);expect(row.alive).toBe(1);});
  });
 });
 it('admits SELECT-only seed and original reads but grants no receipt DML sequence or guard EXECUTE',async()=>{
  f=await supplierExtractApplicationFixture();await f.withLookup(async runtime=>{const service=new SupplierExtractApplicationService(runtime.container,f.env.APP_KEY);expect((await service.seed(actor)).available).toBe('735.00');expect((await service.receipt(randomUUID(),actor)).state).toBe('unknown');
   const[rights]=await runtime.db.execute(sql`SELECT has_table_privilege(current_user,'public.supplier_extract_application_operation_v1','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writes,
    has_table_privilege(current_user,'public.supplier_extract','INSERT,UPDATE,DELETE,TRUNCATE') AS application_writes,
    has_sequence_privilege(current_user,'public.supplier_extract_id_seq','USAGE,SELECT,UPDATE') AS sequence,
    has_function_privilege(current_user,'public.supplier_extract_application_guard_v1()','EXECUTE') AS guard`);expect(rights).toEqual({writes:false,application_writes:false,sequence:false,guard:false});
  });
 });
 it('proves applicant only inserts original rows and receipts with auth id-lock qualification',async()=>{
  f=await supplierExtractApplicationFixture();await f.withWriter(async runtime=>{const service=new SupplierExtractApplicationService(runtime.container,f.env.APP_KEY),seed=await service.seed(actor);expect((await service.execute(input(seed.revision),actor)).state).toBe('committed');
   const[rights]=await runtime.db.execute(sql`SELECT has_table_privilege(current_user,'public.supplier_extract_application_operation_v1','SELECT') AND has_table_privilege(current_user,'public.supplier_extract_application_operation_v1','INSERT') AS receipt_append,
    has_table_privilege(current_user,'public.supplier_extract_application_operation_v1','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS receipt_mutation,
    has_table_privilege(current_user,'public.supplier_extract','INSERT') AS application_insert,has_any_column_privilege(current_user,'public.supplier_extract','UPDATE') AS application_update,
    has_column_privilege(current_user,'public.system_role','id','UPDATE') AS role_lock,has_column_privilege(current_user,'public.system_role','rules','UPDATE') AS rules,
    has_column_privilege(current_user,'public.system_admin','pwd','UPDATE') AS password,has_function_privilege(current_user,'public.supplier_extract_application_guard_v1()','EXECUTE') AS guard,
    has_sequence_privilege(current_user,'public.supplier_extract_id_seq','USAGE') AS sequence_usage,has_sequence_privilege(current_user,'public.supplier_extract_id_seq','SELECT,UPDATE') AS sequence_rewrite`);
   expect(rights).toEqual({receipt_append:true,receipt_mutation:false,application_insert:true,application_update:false,role_lock:true,rules:false,password:false,guard:false,sequence_usage:true,sequence_rewrite:false});
  });
 });
 it.each(['operation_insert','application_insert','sequence_usage'])('rejects missing %s before reserving any funds',async missing=>{
  f=await supplierExtractApplicationFixture();await f.withWriter(async runtime=>{const service=new SupplierExtractApplicationService(runtime.container,f.env.APP_KEY),seed=await service.seed(actor),before=await f.snapshot();
   await f.exec(missing==='operation_insert'?`REVOKE INSERT ON public.supplier_extract_application_operation_v1 FROM "${runtime.role}"`:missing==='application_insert'?`REVOKE INSERT ON public.supplier_extract FROM "${runtime.role}"`:`REVOKE USAGE ON SEQUENCE public.supplier_extract_id_seq FROM "${runtime.role}"`);
   await expect(service.execute(input(seed.revision),actor)).rejects.toMatchObject({code:503});expect(await f.snapshot()).toEqual(before);
  });
 });
 it.each(['column','index','guard_acl'])('refuses actual %s drift without repairing or writing through HTTP',async drift=>{
  f=await supplierExtractApplicationFixture();await f.withWriter(async runtime=>{const service=new SupplierExtractApplicationService(runtime.container,f.env.APP_KEY);
   if(drift==='column')await f.exec('ALTER TABLE public.supplier_extract_application_operation_v1 ADD COLUMN surprise text');
   if(drift==='index')await f.exec('CREATE INDEX seao_unknown_index ON public.supplier_extract_application_operation_v1(actor_id)');
   if(drift==='guard_acl')await f.exec('GRANT EXECUTE ON FUNCTION public.supplier_extract_application_guard_v1() TO PUBLIC');
   const before=await f.snapshot();await expect(service.seed(actor)).rejects.toMatchObject({code:503});expect(await f.snapshot()).toEqual(before);
   await expect(withTx(createContainerFromDb(f.db),tx=>installSupplierExtractApplication(tx))).rejects.toThrow();
  });
 });
 it('does not silently recommission a missing grant on an existing catalog',async()=>{
  f=await supplierExtractApplicationFixture();await f.withWriter(async runtime=>{await f.exec(`REVOKE INSERT ON public.supplier_extract_application_operation_v1 FROM "${runtime.role}"`);
   await expect(withTx(createContainerFromDb(f.db),tx=>installSupplierExtractApplication(tx,{runtimeRole:runtime.role}))).rejects.toThrow('grants require review');
   const[rights]=await runtime.db.execute(sql`SELECT has_table_privilege(current_user,'public.supplier_extract_application_operation_v1','INSERT') AS write`);expect(rights.write).toBe(false);
  });
 });
 it('allows an already commissioned safe whole-shop writer without requiring ordinary tables to lose existing rights',async()=>{
  f=await supplierExtractApplicationFixture();await f.withWriter(async runtime=>{await f.exec(`GRANT UPDATE ON public.supplier_extract TO "${runtime.role}"`);const service=new SupplierExtractApplicationService(runtime.container,f.env.APP_KEY),seed=await service.seed(actor);expect((await service.execute(input(seed.revision),actor)).state).toBe('committed');});
 });
 it('makes committed and not_applied evidence immutable even for the owned table maintainer',async()=>{
  f=await supplierExtractApplicationFixture();await f.withWriter(async runtime=>{const service=new SupplierExtractApplicationService(runtime.container,f.env.APP_KEY),uuid=randomUUID();await service.resolve(uuid,actor);const before=await f.snapshot();
   await expect(f.exec(`UPDATE public.supplier_extract_application_operation_v1 SET created_at=created_at+1 WHERE operation_id='${uuid}'::uuid`)).rejects.toMatchObject({code:'42501'});
   await expect(f.exec('DELETE FROM public.supplier_extract_application_operation_v1')).rejects.toMatchObject({code:'42501'});await expect(f.exec('TRUNCATE public.supplier_extract_application_operation_v1')).rejects.toMatchObject({code:'42501'});expect(await f.snapshot()).toEqual(before);
   await expect(runtime.exec(`INSERT INTO public.supplier_extract_application_operation_v1(operation_id,actor_id,supplier_id,extract_id,state,request_hash,intent,source,source_hash,result,result_hash,created_at) VALUES('${randomUUID()}',21,7,NULL,'committed','',NULL,NULL,'',NULL,'',1800000000)`)).rejects.toMatchObject({code:'23514'});expect(await f.snapshot()).toEqual(before);
  });
 });
});
