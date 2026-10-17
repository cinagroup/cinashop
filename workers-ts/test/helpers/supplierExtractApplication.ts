/** Original-key withdrawal fixtures. These are owned synthetic ledger balances,
 * not bank payments. Runtime role cannot change an admitted extract or a receipt. */
import {eq,sql} from 'drizzle-orm';
import {systemSupplier} from '@/models/schema';
import {withTx,createContainerFromDb,type Container} from '@/lib/di';
import type {SequenceRunnerPeer} from './kefuSequenceRunnerDatabase';
export type SupplierExtractApplicationRuntime=SequenceRunnerPeer&{role:string;connectionString:string;container:Container};
import {installSupplierExtractApplication} from '@/migrations/supplierExtractApplication';
import {supplierExtractReadFixture} from './supplierExtractRead';
export async function supplierExtractApplicationFixture(options:{catalog?:boolean}={}) {
 const f=await supplierExtractReadFixture();
 try {
  await f.db.update(systemSupplier).set({bankCode:'0000622200099999',bankAddress:'本机申请开户行',alipayAccount:'owned-apply-alipay',alipayQrcodeUrl:'/owned-media/application-alipay.png',wechat:'owned-apply-wx',wechatQrcodeUrl:'/owned-media/application-weixin.png'}).where(eq(systemSupplier.id,7));
  await f.exec("SELECT setval(pg_get_serial_sequence('public.supplier_extract','id'),(SELECT max(id)+1 FROM public.supplier_extract),false)");
  if(options.catalog!==false)await withTx(createContainerFromDb(f.db),async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);await installSupplierExtractApplication(tx);});
  const withApplicant=<T>(work:(runtime:SupplierExtractApplicationRuntime)=>Promise<T>)=>f.withReader(async runtime=>{
   await f.exec(`GRANT INSERT ON public.supplier_extract TO "${runtime.role}"; GRANT USAGE ON SEQUENCE public.supplier_extract_id_seq TO "${runtime.role}"; GRANT UPDATE(id) ON public.system_admin,public.system_supplier,public.system_role,public.system_menus TO "${runtime.role}"`);
   if(options.catalog!==false)await f.exec(`GRANT SELECT,INSERT ON public.supplier_extract_application_operation_v1 TO "${runtime.role}"`);
   return work(runtime);
  });
  const withLookup=<T>(work:(runtime:SupplierExtractApplicationRuntime)=>Promise<T>)=>f.withReader(async runtime=>{if(options.catalog!==false)await f.exec(`GRANT SELECT ON public.supplier_extract_application_operation_v1 TO "${runtime.role}"`);return work(runtime);});
  const snapshot=async()=>({...await f.snapshot(),...(options.catalog===false?{}:{supplier_extract_application_operation_v1:await f.exec('SELECT to_jsonb(t) AS row FROM public.supplier_extract_application_operation_v1 t ORDER BY operation_id')})});
  const sequence=()=>f.exec('SELECT last_value,is_called FROM public.supplier_extract_id_seq');
  return{...f,withApplicant,withWriter:withApplicant,withLookup,snapshot,sequence};
 }catch(error){await f.close();throw error;}
}
