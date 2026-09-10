import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeCouponIssue, storeCouponProduct } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { COUPON_PRODUCT_SCOPE_FENCE_BODY } from '@/migrations/couponProductScopeFence';

export type CouponAuthorityTransaction = Pick<DbClient, 'select'> & Partial<Pick<DbClient, 'execute' | '$client'>>;

/** Must precede the parent row lock and a separate, fresh relation-set SELECT.
 * These relation locks permit ordinary DML; they prevent TRUNCATE and table DDL
 * from passing the subsequent read. Readiness is neither cached nor installed here.
 * Privileged function replacement and other sessions' replica bypass still require
 * the deployment/role gate; a catalog snapshot cannot constrain administrators.
 */
export async function lockCheckoutCouponRelationProtocol(tx: CouponAuthorityTransaction): Promise<void> {
  if (tx.$client || !tx.execute) throw new ValidateException('优惠券关系复核必须位于建单事务内');
  await tx.execute(sql`LOCK TABLE ONLY ${storeCouponProduct} IN ACCESS SHARE MODE NOWAIT`);
  // FOR SHARE NOWAIT does not bound its implicit relation lock. Explicit LOCK
  // ROW SHARE would require a table-wide write privilege (column UPDATE is not
  // enough). Acquire that same mode with a zero-row locking SELECT instead,
  // bounding only this acquisition to 1 ms and restoring the caller's timeout.
  // On failure the owning transaction rolls back; do not mask 55P03 by trying
  // to restore settings with another SQL command in an aborted transaction.
  const [settings] = await tx.select({ timeout: sql<string>`pg_catalog.current_setting('lock_timeout')` })
    .from(sql`(VALUES (1)) AS coupon_lock_settings(n)`);
  if (!settings) throw new ValidateException('优惠券关系事务设置不可用');
  await tx.execute(sql`SELECT pg_catalog.set_config('lock_timeout','1ms',true)`);
  await tx.select({ id: storeCouponIssue.id }).from(storeCouponIssue).where(sql`false`).for('share', { noWait: true });
  await tx.execute(sql`SELECT pg_catalog.set_config('lock_timeout',${settings.timeout},true)`);
  const [protocol] = await tx.select({ ready: sql<boolean>`
    pg_catalog.current_setting('transaction_isolation') = 'read committed'
    AND pg_catalog.current_setting('session_replication_role') IN ('origin','local')
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_class r
      JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('store_coupon_issue') AND c.relnamespace=r.relnamespace
      JOIN pg_catalog.pg_proc p ON p.pronamespace=r.relnamespace AND p.proname='coupon_product_scope_fence_0151' AND p.pronargs=0
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE r.oid=pg_catalog.to_regclass('store_coupon_product')
        AND r.relkind='r' AND c.relkind='r' AND r.relpersistence='p' AND c.relpersistence='p'
        AND NOT r.relispartition AND NOT c.relispartition
        AND NOT r.relrowsecurity AND NOT r.relforcerowsecurity AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid IN (r.oid,c.oid) OR i.inhparent IN (r.oid,c.oid))
        AND 3=(SELECT count(*) FROM (VALUES (r.oid,'coupon_id'),(r.oid,'product_id'),(c.oid,'id')) AS e(table_oid,column_name)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=e.table_oid AND a.attname=e.column_name
            AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid='pg_catalog.int4'::regtype AND a.atttypmod=-1
            AND a.attnotnull AND a.attgenerated='' AND a.attidentity='')
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_attribute a
          ON a.attrelid=k.conrelid AND a.attname='id' WHERE k.conrelid=c.oid AND k.contype='p'
            AND k.convalidated AND NOT k.condeferrable AND k.conkey=ARRAY[a.attnum]::smallint[])
        AND l.lanname='plpgsql' AND p.prorettype='pg_catalog.trigger'::regtype AND p.prokind='f'
        AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset
        AND p.provolatile='v' AND p.proparallel='u' AND p.proconfig=ARRAY['search_path=pg_catalog']
        AND p.prosrc=${COUPON_PRODUCT_SCOPE_FENCE_BODY}
        AND 3=(SELECT count(*) FROM (VALUES
          ('coupon_product_insert_0151',4,NULL::name,'coupon_scope_new'::name),
          ('coupon_product_update_0151',16,'coupon_scope_old'::name,'coupon_scope_new'::name),
          ('coupon_product_delete_0151',8,'coupon_scope_old'::name,NULL::name)
        ) AS e(name,bits,old_table,new_table)
        JOIN pg_catalog.pg_trigger t ON t.tgrelid=r.oid AND t.tgname=e.name
          AND t.tgfoid=p.oid AND t.tgtype=e.bits AND t.tgenabled='O'
          AND NOT t.tgisinternal AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0
          AND t.tgconstrrelid=0 AND t.tgparentid=0 AND t.tgnargs=0 AND t.tgargs=''::bytea
          AND t.tgqual IS NULL AND t.tgattr=''::int2vector
          AND t.tgoldtable IS NOT DISTINCT FROM e.old_table AND t.tgnewtable IS NOT DISTINCT FROM e.new_table)
    )` }).from(sql`(VALUES (1)) AS coupon_relation_protocol(n)`);
  if (protocol?.ready !== true) throw new ValidateException('优惠券关系保护尚未就绪，请联系管理员');
}
