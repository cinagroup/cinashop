/** Independent 0193 owner maintenance. No bootstrap, rows, roles or grants. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { PRODUCT_SAVE_EFFECTS_EVENTS } from './productSaveEffects';
export const SUPPLIER_ORDER_PRICE_REVISION_EVENTS = [...PRODUCT_SAVE_EFFECTS_EVENTS, 'order.price.revision'] as const;
export const SUPPLIER_ORDER_PRICE_REVISION_CHECK_DEFINITION = `CHECK (((event_type)::text = ANY ((ARRAY[${SUPPLIER_ORDER_PRICE_REVISION_EVENTS.map(event => `'${event}'::character varying`).join(', ')}])::text[])))`;
export const SUPPLIER_ORDER_PRICE_REVISION_SQL = String.raw`-- Expand only the known event whitelist. No business rows, roles or privileges change.
-- Existing databases must use this standalone upgrade, never the full bootstrap.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SELECT set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
  set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true);
DO $supplier_order_price_revision_outbox$
DECLARE
  current_definition text;
  existing_comment text;
  row_count integer;
BEGIN
  IF current_setting('server_version_num')::integer/10000<>16 OR current_setting('session_replication_role')<>'origin'
    OR current_user<>session_user OR current_schema()<>'pg_catalog' THEN
    RAISE EXCEPTION 'Supplier order price revision requires explicit direct PG16 maintenance';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.store_order_outbox')
      AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid))
    OR EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Supplier order price revision outbox prerequisite drift; no automatic repair';
  END IF;
  LOCK TABLE ONLY public.store_order_outbox IN ACCESS EXCLUSIVE MODE NOWAIT;
  SELECT pg_get_constraintdef(c.oid),obj_description(c.oid,'pg_constraint') INTO current_definition,existing_comment
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='event_type'
    WHERE c.conrelid='public.store_order_outbox'::regclass AND c.conname='soob_event_type_ck'
      AND c.contype='c' AND c.convalidated AND NOT c.connoinherit AND c.conislocal AND c.coninhcount=0
      AND c.conkey=ARRAY[a.attnum]::smallint[] AND a.atttypid='varchar'::regtype AND a.atttypmod=68
      AND a.attnotnull AND a.attgenerated='' AND a.attidentity='' AND NOT a.atthasdef
      AND a.attcollation='pg_catalog."default"'::regcollation AND NOT a.attisdropped;
  IF current_definition = 'CHECK (((event_type)::text = ANY ((ARRAY[''order.paid''::character varying, ''order.delivery.notice''::character varying, ''order.refund.refused.notice''::character varying, ''order.second_card.advent.notice''::character varying, ''order.second_card.expired.notice''::character varying, ''withdrawal.approved.notice''::character varying, ''withdrawal.refused.notice''::character varying, ''withdrawal.applied.notice''::character varying, ''withdrawal.staff.refresh''::character varying, ''order.presale.fulfillment''::character varying, ''order.pink.success.notice''::character varying, ''product.stock.effects''::character varying, ''product.recycle.effects''::character varying, ''product.save.effects''::character varying, ''order.price.revision''::character varying])::text[])))' THEN
    RETURN;
  END IF;
  IF current_definition IS DISTINCT FROM 'CHECK (((event_type)::text = ANY ((ARRAY[''order.paid''::character varying, ''order.delivery.notice''::character varying, ''order.refund.refused.notice''::character varying, ''order.second_card.advent.notice''::character varying, ''order.second_card.expired.notice''::character varying, ''withdrawal.approved.notice''::character varying, ''withdrawal.refused.notice''::character varying, ''withdrawal.applied.notice''::character varying, ''withdrawal.staff.refresh''::character varying, ''order.presale.fulfillment''::character varying, ''order.pink.success.notice''::character varying, ''product.stock.effects''::character varying, ''product.recycle.effects''::character varying, ''product.save.effects''::character varying])::text[])))' THEN
    RAISE EXCEPTION 'Supplier order price revision outbox event CHECK drift; no automatic repair';
  END IF;
  SELECT count(*) INTO row_count FROM (SELECT 1 FROM public.store_order_outbox LIMIT 10001) bounded;
  IF row_count>10000 THEN RAISE EXCEPTION 'Supplier order price revision outbox maintenance row budget exceeded'; END IF;
  ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck;
  ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK (
    event_type IN ('order.paid', 'order.delivery.notice', 'order.refund.refused.notice', 'order.second_card.advent.notice', 'order.second_card.expired.notice', 'withdrawal.approved.notice', 'withdrawal.refused.notice', 'withdrawal.applied.notice', 'withdrawal.staff.refresh', 'order.presale.fulfillment', 'order.pink.success.notice', 'product.stock.effects', 'product.recycle.effects', 'product.save.effects', 'order.price.revision')
  );
  IF existing_comment IS NOT NULL THEN
    EXECUTE format('COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS %L',existing_comment);
  END IF;
END
$supplier_order_price_revision_outbox$;
`;
export async function installSupplierOrderPriceRevision(tx: Pick<DbClient, 'execute'>): Promise<void> {
  await tx.execute(sql.raw(SUPPLIER_ORDER_PRICE_REVISION_SQL));
}
export async function runSupplierOrderPriceRevision(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Supplier order price revision maintenance requires a root database');
  await db.$client.begin('isolation level read committed', async tx => { await tx.unsafe(SUPPLIER_ORDER_PRICE_REVISION_SQL); });
}
/** SELECT-only catalog gate. HTTP never repairs an event whitelist. */
export async function assertSupplierOrderPriceRevisionReady(tx: Pick<DbClient, 'execute'>): Promise<void> {
  // Hold a real relation read lock while proving its catalog in this transaction.
  await tx.execute(sql`SELECT event_key FROM public.store_order_outbox LIMIT 0`);
  const [row] = await tx.execute(sql`SELECT
    current_user=session_user AND current_schema()='public'
      AND current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported,
    pg_get_constraintdef(k.oid) AS definition,
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)
      AND k.contype='c' AND k.convalidated AND NOT k.connoinherit AND k.conislocal AND k.coninhcount=0
      AND k.conkey=ARRAY[a.attnum]::smallint[] AND a.atttypid='varchar'::regtype AND a.atttypmod=68
      AND a.attnotnull AND a.attgenerated='' AND a.attidentity='' AND NOT a.atthasdef
      AND a.attcollation='pg_catalog."default"'::regcollation AND NOT a.attisdropped AS safe
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
      JOIN pg_catalog.pg_constraint k ON k.conrelid=c.oid AND k.conname='soob_event_type_ck'
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='event_type'
    WHERE c.relname='store_order_outbox'`);
  if (!row || row.supported!==true || row.safe!==true || row.definition!==SUPPLIER_ORDER_PRICE_REVISION_CHECK_DEFINITION)
    throw new ServiceUnavailableException('订单改价通知维护协议尚未就绪');
}
