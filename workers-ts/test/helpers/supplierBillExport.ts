/** Reuse the existing isolated SELECT-only ledger fixture, adding only actual
 * app permissions. No payment/refund facts or database write grants. */
import {eq} from 'drizzle-orm';
import {systemRole} from '@/models/schema';
import {supplierBillReadFixture} from './supplierBillRead';
export async function supplierBillExportFixture(options:{manyRows?:number}={}) {
 const f=await supplierBillReadFixture(options);
 try {
  await f.db.update(systemRole).set({rules:'supplier.finance.view,supplier.finance.manage'}).where(eq(systemRole.id,21));
  await f.db.update(systemRole).set({rules:'supplier.finance.view'}).where(eq(systemRole.id,22));
  await f.db.update(systemRole).set({rules:'supplier.finance.view,supplier.finance.manage'}).where(eq(systemRole.id,31));
  return f;
 }catch(error){await f.close();throw error;}
}
