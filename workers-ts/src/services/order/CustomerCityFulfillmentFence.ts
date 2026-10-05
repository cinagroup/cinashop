import { eq,sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { customerCityDeliveryJob,customerCityDeliveryBinding } from '@/models/schema/customer_city_delivery';
import { assertCustomerCityDeliveryReady } from '@/migrations/customerCityDelivery';
import { ValidateException } from '@/utils/errors';

/** Shared fulfillment must honor admitted third-party city effects. All-absent
 * historical installations keep their former semantics; partial/drifted
 * catalogs reject. Caller already owns the financial root lock. NOWAIT avoids
 * reversing the legacy callback's delivery-table -> root lock graph. */
export async function assertNoConflictingCustomerCityJob(tx:DbClient,rootOrderId:number,allowedJobId?:number) {
  const [catalog]=await tx.execute<{installed:number}>(sql`SELECT count(*)::int AS installed FROM pg_class WHERE oid IN(
    to_regclass('public.customer_city_delivery_job'),to_regclass('public.customer_city_delivery_attempt'),to_regclass('public.customer_city_delivery_binding'))`);
  if(catalog?.installed===0)return;
  if(catalog?.installed!==3)throw new ValidateException('同城配送合同安装不完整，请先核对');
  await assertCustomerCityDeliveryReady(tx,false);
  await tx.execute(sql`LOCK TABLE public.store_delivery_order IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  const rows=await tx.select({id:customerCityDeliveryJob.id,status:customerCityDeliveryJob.status,active:customerCityDeliveryBinding.active})
    .from(customerCityDeliveryJob).leftJoin(customerCityDeliveryBinding,eq(customerCityDeliveryBinding.jobId,customerCityDeliveryJob.id))
    .where(eq(customerCityDeliveryJob.rootOrderId,rootOrderId)).limit(501);
  if(rows.length>500)throw new ValidateException('同城配送历史超过核对容量');
  if(rows.some(row=>row.id!==allowedJobId&&(['PENDING','PROCESSING','UNKNOWN'].includes(row.status)||row.status==='ADMITTED'&&row.active===1)))
    throw new ValidateException('订单已有未结同城配送任务，请先恢复原配送结果');
}
