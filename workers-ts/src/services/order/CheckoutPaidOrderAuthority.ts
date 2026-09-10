import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { BROKERAGE_PAID_ORDER_FENCE_BODY } from '@/migrations/brokeragePaidOrderFence';
import { decimalToCents } from './OrderBrokerageService';

export interface PaidOrderQualification { uid: number; thresholdCents: number; eligible: boolean }

/** Called only after the checkout's order INSERT and sorted user SHARE locks.
 * An installed writer fence plus those held locks protects the subsequent fresh SUM.
 * No cached readiness, DDL, table-wide writer exclusion, or external I/O here.
 * Privileged concurrent function replacement/bypass needs a deployment permission gate.
 */
export async function assertCheckoutPaidOrderQualifications(
  tx: Pick<DbClient, 'select'> & Partial<Pick<DbClient, '$client'>>, expected: PaidOrderQualification[],
): Promise<void> {
  if (!expected.length) return;
  if (tx.$client) throw new ValidateException('累计消费资格复核必须位于建单事务内');
  if (expected.length > 2 || expected.some(row => !Number.isSafeInteger(row.uid) || row.uid <= 0 ||
    !Number.isSafeInteger(row.thresholdCents) || row.thresholdCents < 0)) {
    throw new ValidateException('累计消费资格快照无效');
  }
  const [protocol] = await tx.select({ ready: sql<boolean>`
    current_setting('transaction_isolation') = 'read committed'
    AND current_setting('session_replication_role') IN ('origin','local')
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_class o
      JOIN pg_catalog.pg_class u ON u.oid=pg_catalog.to_regclass('"user"') AND u.relnamespace=o.relnamespace
      JOIN pg_catalog.pg_proc p ON p.pronamespace=o.relnamespace
        AND p.proname='brokerage_paid_order_fence_0150' AND p.pronargs=0
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE o.oid=pg_catalog.to_regclass('store_order')
        AND o.relkind='r' AND u.relkind='r' AND o.relpersistence='p' AND u.relpersistence='p'
        AND NOT o.relispartition AND NOT u.relispartition
        AND NOT o.relrowsecurity AND NOT o.relforcerowsecurity AND NOT u.relrowsecurity AND NOT u.relforcerowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid IN (o.oid,u.oid) OR i.inhparent IN (o.oid,u.oid))
        AND 7=(SELECT count(*) FROM (VALUES
          (o.oid,'uid','integer'::regtype,-1), (o.oid,'pid','integer'::regtype,-1),
          (o.oid,'paid','smallint'::regtype,-1), (o.oid,'is_del','smallint'::regtype,-1),
          (o.oid,'refund_status','smallint'::regtype,-1),
          (o.oid,'pay_price','numeric'::regtype,((12 << 16) | 2)+4), (u.oid,'uid','integer'::regtype,-1)
        ) AS e(table_oid,column_name,type_oid,type_mod)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=e.table_oid AND a.attname=e.column_name
          AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid=e.type_oid AND a.atttypmod=e.type_mod
          AND a.attnotnull AND a.attgenerated='' AND a.attidentity='')
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_attribute a
          ON a.attrelid=c.conrelid AND a.attname='uid' WHERE c.conrelid=u.oid AND c.contype='p'
            AND c.convalidated AND NOT c.condeferrable AND c.conkey=ARRAY[a.attnum]::smallint[])
        AND l.lanname='plpgsql' AND p.prorettype='pg_catalog.trigger'::regtype AND p.prokind='f'
        AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof
        AND p.provolatile='v' AND p.proparallel='u' AND p.proconfig=ARRAY['search_path=pg_catalog']
        AND p.prosrc=${BROKERAGE_PAID_ORDER_FENCE_BODY}
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_locks k WHERE k.pid=pg_backend_pid() AND k.locktype='relation'
          AND k.relation=o.oid AND k.granted AND k.mode IN ('RowExclusiveLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'))
        AND 3=(SELECT count(*) FROM (VALUES
          ('brokerage_paid_insert_0150',4,NULL::name,'brokerage_new'::name),
          ('brokerage_paid_update_0150',16,'brokerage_old'::name,'brokerage_new'::name),
          ('brokerage_paid_delete_0150',8,'brokerage_old'::name,NULL::name)
        ) AS e(name,bits,old_table,new_table)
        JOIN pg_catalog.pg_trigger t ON t.tgrelid=o.oid AND t.tgname=e.name
          AND t.tgfoid=p.oid AND t.tgtype=e.bits AND t.tgenabled='O'
          AND NOT t.tgisinternal AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0
          AND t.tgconstrrelid=0 AND t.tgparentid=0 AND t.tgnargs=0 AND t.tgargs=''::bytea
          AND t.tgqual IS NULL AND t.tgattr=''::int2vector
          AND t.tgoldtable IS NOT DISTINCT FROM e.old_table AND t.tgnewtable IS NOT DISTINCT FROM e.new_table)
    )` }).from(sql`(VALUES (1)) AS paid_order_protocol(n)`);
  if (protocol?.ready !== true) throw new ValidateException('累计消费资格保护尚未就绪，请联系管理员');
  // Separate statements at READ COMMITTED: a writer committed before our user lock
  // must be visible, and any later contribution writer now waits for this checkout.
  for (const facts of expected) {
    const [row] = await tx.select({ total: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::numeric(14,2)` })
      .from(storeOrder).where(and(eq(storeOrder.uid, facts.uid), sql`${storeOrder.pid} <> -1`,
        eq(storeOrder.paid, 1), eq(storeOrder.isDel, 0), inArray(storeOrder.refundStatus, [0, 3])));
    if ((decimalToCents(row?.total ?? '0') > facts.thresholdCents) !== facts.eligible) {
      throw new ValidateException('累计消费分佣资格已变化，请重新确认');
    }
  }
}
