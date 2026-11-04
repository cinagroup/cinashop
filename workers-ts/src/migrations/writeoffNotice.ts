/** Independent explicit 0199 successor. Historical bootstrap/SQL stay fixed.
 * The finite family below is shared with older readers without importing the
 * refund module (which imports this normalizer in the opposite direction). */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { PRODUCT_SAVE_EFFECTS_EVENTS } from './productSaveEffects';
import { normalizePaidNoticeEventDefinition, paidNoticeEventGeneration, paidNoticeAddonUpgradeSql, NOTICE_MAINTENANCE_BUDGET_SQL } from './paidNotice';

export const WRITEOFF_NOTICE_EVENT = 'order.writeoff.notice';
const REFUND_EVENT = 'order.refund.success.notice';
const PRICE_EVENT = 'order.price.revision';
const VIRTUAL_EVENTS = ['recharge.paid.shipping', 'membership.paid.shipping'] as const;
export interface WriteoffNoticeEventGeneration {
  readonly price: boolean; readonly virtual: boolean;
  readonly addons: readonly string[]; readonly events: readonly string[]; readonly definition: string;
}
const definition = (events: readonly string[]) => `CHECK (((event_type)::text = ANY ((ARRAY[${events.map(event => `'${event}'::character varying`).join(', ')}])::text[])))`;
/** Only the reviewed 14/15/virtual16/virtual17 bases and explicit independent
 * refund/writeoff tails. No parser, substring inference, reordering or repair. */
export const WRITEOFF_NOTICE_EVENT_GENERATIONS: readonly WriteoffNoticeEventGeneration[] = Object.freeze(
  [false, true].flatMap(virtual => [false, true].flatMap(price =>
    [[], [REFUND_EVENT], [WRITEOFF_NOTICE_EVENT], [REFUND_EVENT, WRITEOFF_NOTICE_EVENT], [WRITEOFF_NOTICE_EVENT, REFUND_EVENT]]
      .map(addons => {
        const events = Object.freeze([...PRODUCT_SAVE_EFFECTS_EVENTS, ...(price ? [PRICE_EVENT] : []),
          ...(virtual ? VIRTUAL_EVENTS : []), ...addons]);
        return Object.freeze({ price, virtual, addons: Object.freeze(addons), events, definition: definition(events) });
      }))));
export const WRITEOFF_NOTICE_PREDECESSORS = Object.freeze(WRITEOFF_NOTICE_EVENT_GENERATIONS
  .filter(generation => !generation.addons.includes(WRITEOFF_NOTICE_EVENT)).map(generation => generation.definition));
export const WRITEOFF_NOTICE_SUCCESSORS = Object.freeze(WRITEOFF_NOTICE_EVENT_GENERATIONS
  .filter(generation => generation.addons.includes(WRITEOFF_NOTICE_EVENT)).map(generation => generation.definition));
export function writeoffNoticeEventGeneration(value: unknown): WriteoffNoticeEventGeneration | null {
  return typeof value === 'string' ? WRITEOFF_NOTICE_EVENT_GENERATIONS.find(generation => generation.definition === value) ?? null : null;
}
/** Normalize only exact finite successors, retaining refund commissioning.
 * Unknown input is returned unchanged so every older closed reader rejects it. */
export function normalizeWriteoffNoticeEventDefinition(value: unknown): unknown {
  value = normalizePaidNoticeEventDefinition(value);
  const generation = writeoffNoticeEventGeneration(value);
  return generation?.addons.includes(WRITEOFF_NOTICE_EVENT)
    ? definition(generation.events.filter(event => event !== WRITEOFF_NOTICE_EVENT)) : value;
}
const historicalEvents = PRODUCT_SAVE_EFFECTS_EVENTS.slice(0, 13);
const INACTIVE_HISTORICAL = Object.freeze([3, 5, 7, 8, 9, 10, 11, 12, 13]
  .map(count => definition(historicalEvents.slice(0, count))));
export const WRITEOFF_NOTICE_CATALOG_SQL = String.raw`SELECT pg_catalog.pg_get_constraintdef(k.oid,false) AS definition,
  k.contype='c' AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
  AND NOT k.connoinherit AND k.conislocal AND k.coninhcount=0 AND k.conkey=ARRAY[a.attnum]::smallint[]
  AND a.atttypid='pg_catalog.varchar'::regtype AND a.atttypmod=68 AND a.attnotnull
  AND a.attgenerated='' AND a.attidentity='' AND NOT a.atthasdef AND NOT a.attisdropped
  AND a.attcollation='pg_catalog."default"'::regcollation
  AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND c.reloptions IS NULL
  AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
  AND pg_catalog.to_regclass('store_order_outbox')=c.oid
  AND pg_catalog.current_setting('server_version_num')::integer/10000=16
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS safe
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_constraint k ON k.conrelid=c.oid AND k.conname='soob_event_type_ck'
 JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='event_type'
 WHERE c.oid=pg_catalog.to_regclass('public.store_order_outbox')`;
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
/** Internal closed successors for older installers. Only the 12 exact new
 * writeoff generations can enter their addon branches; a raced unknown catalog
 * is rejected again under the same ACCESS EXCLUSIVE lock. The optional virtual
 * guard is fixed trusted SQL supplied by the Supplier wrapper, never input. */
export function writeoffNoticeAddonUpgradeSql(addon: 'writeoff' | 'refund' | 'price', virtualGuard = ''): string {
  const sources = addon === 'writeoff' ? WRITEOFF_NOTICE_EVENT_GENERATIONS
    : WRITEOFF_NOTICE_EVENT_GENERATIONS.filter(generation => generation.addons.includes(WRITEOFF_NOTICE_EVENT));
  const cases = sources.map(generation => {
    const enabled = addon === 'price' ? generation.price : generation.addons.includes(addon === 'refund' ? REFUND_EVENT : WRITEOFF_NOTICE_EVENT);
    const events = addon === 'price'
      ? [...PRODUCT_SAVE_EFFECTS_EVENTS, PRICE_EVENT, ...(generation.virtual ? VIRTUAL_EVENTS : []), ...generation.addons]
      : [...generation.events, addon === 'refund' ? REFUND_EVENT : WRITEOFF_NOTICE_EVENT];
    return ` WHEN ${literal(generation.definition)} THEN already_enabled:=${enabled}; virtual_subjects:=${generation.virtual}; events:=${literal(events.map(literal).join(','))};`;
  }).join('\n');
  return `-- Explicit bounded ${addon} event commissioning; no business DML or grants.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SELECT pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
 pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
 pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);
DO $writeoff_notice_successor$
DECLARE d text; safe boolean; old_comment text; events text; already_enabled boolean; virtual_subjects boolean;
 row_count integer; byte_count bigint; oversized boolean; virtual_catalog record;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed'
   OR pg_catalog.current_setting('transaction_read_only')<>'off'
   OR pg_catalog.current_setting('session_replication_role')<>'origin'
   OR current_user<>session_user OR pg_catalog.current_schema()<>'pg_catalog'
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
     WHERE c.oid=pg_catalog.to_regclass('public.store_order_outbox') AND r.rolname=current_user AND r.rolcanlogin) THEN
   RAISE EXCEPTION 'Writeoff notice requires direct PG16 owner maintenance';
 END IF;
 LOCK TABLE ONLY public.store_order_outbox IN ACCESS EXCLUSIVE MODE NOWAIT;
 SELECT q.definition,q.safe INTO d,safe FROM (${WRITEOFF_NOTICE_CATALOG_SQL}) q;
 IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Writeoff notice outbox catalog drift'; END IF;
 CASE d
${cases}
 ELSE RAISE EXCEPTION 'Writeoff notice predecessor drift; no automatic repair';
 END CASE;
${virtualGuard}
 IF already_enabled THEN RETURN; END IF;
 SELECT pg_catalog.obj_description(oid,'pg_constraint') INTO old_comment FROM pg_catalog.pg_constraint
  WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck';
 IF pg_catalog.octet_length(old_comment)>4096 THEN RAISE EXCEPTION 'Writeoff notice constraint comment budget exceeded'; END IF;
 SELECT count(*)::integer,COALESCE(sum(pg_column_size(t)),0),COALESCE(bool_or(pg_column_size(t)>1048576),false)
  INTO row_count,byte_count,oversized FROM (SELECT * FROM public.store_order_outbox LIMIT 10001) t;
 IF row_count>10000 OR byte_count>16777216 OR oversized THEN RAISE EXCEPTION 'Writeoff notice outbox maintenance row budget exceeded'; END IF;
 ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck;
 EXECUTE 'ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type IN ('||events||'))';
 IF old_comment IS NOT NULL THEN EXECUTE pg_catalog.format('COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS %L',old_comment); END IF;
END
$writeoff_notice_successor$;
`;
}
export const WRITEOFF_NOTICE_SQL = writeoffNoticeAddonUpgradeSql('writeoff');
export const WRITEOFF_NOTICE_REFUND_SUCCESS_SQL = writeoffNoticeAddonUpgradeSql('refund');
/** SELECT-only; known old generations are inactive, partial/unknown fail closed. */
export async function writeoffNoticeCommissionedTx(tx: Pick<DbClient, 'execute'>): Promise<boolean> {
  const rows = await tx.execute<{ definition: string; safe: boolean }>(sql.raw(WRITEOFF_NOTICE_CATALOG_SQL));
  if (rows.length !== 1 || rows[0].safe !== true) throw new ServiceUnavailableException('核销成功通知数据库合同尚未就绪');
  const generation = writeoffNoticeEventGeneration(normalizePaidNoticeEventDefinition(rows[0].definition));
  if (generation) return generation.addons.includes(WRITEOFF_NOTICE_EVENT);
  if (INACTIVE_HISTORICAL.includes(rows[0].definition)) return false;
  throw new ServiceUnavailableException('核销成功通知数据库合同发生漂移');
}
export async function runWriteoffNoticeUpgrade(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Writeoff notice upgrade requires a root database');
  await db.$client.begin('isolation level read committed', async tx => {
    await tx.unsafe(NOTICE_MAINTENANCE_BUDGET_SQL);
    const [row] = await tx.unsafe<{ definition: string }[]>(WRITEOFF_NOTICE_CATALOG_SQL);
    await tx.unsafe(paidNoticeEventGeneration(row?.definition)?.paid ? paidNoticeAddonUpgradeSql('writeoff') : WRITEOFF_NOTICE_SQL);
  });
}
