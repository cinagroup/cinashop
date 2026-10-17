/** Ledger-only owned fixture. Reader is SELECT-only; writer adds exactly the
 * note column and authority id columns needed for PostgreSQL SHARE locks. */
import {eq} from 'drizzle-orm';
import {systemRole} from '@/models/schema';
import {supplierBillReadFixture} from './supplierBillRead';
export async function supplierFlowReadFixture(options:{manyRows?:number}={}) {
 const f=await supplierBillReadFixture(options);
 try {
  await f.db.update(systemRole).set({rules:'supplier.finance.view,supplier.finance.manage'}).where(eq(systemRole.id,21));
  await f.db.update(systemRole).set({rules:'supplier.finance.view'}).where(eq(systemRole.id,22));
  const withWriter=<T>(work:Parameters<typeof f.withReader<T>>[0])=>f.withReader(async runtime=>{
   await f.exec(`GRANT UPDATE(id) ON public.system_admin,public.system_supplier,public.system_role,public.system_menus TO "${runtime.role}"`);
   await f.exec(`GRANT UPDATE(mark) ON public.supplier_flowing_water TO "${runtime.role}"`);
   return work(runtime);
  });
  return {...f,withWriter};
 }catch(error){await f.close();throw error;}
}
