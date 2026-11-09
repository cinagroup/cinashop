import { RECHARGE_REFUND_NOTICE_EVENT } from './rechargeRefundNoticeContract';
import {RECHARGE_PAID_EVENTS} from './rechargePaidNoticeContract';
/** Explicit 0200 buyer payment notice commissioning. The historical CHECK and
 * prior standalone SQL remain immutable; the finite successors preserve all addons. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { PRODUCT_SAVE_EFFECTS_EVENTS } from './productSaveEffects';
import { MEMBERSHIP_PAID_EVENTS } from './membershipPaidNoticeContract';
export const PAID_NOTICE_EVENT = 'order.pay.success.notice';
/** Bound even the first catalog-routing read. This changes only transaction
 * time budgets, preserves stricter callers and grants no maintenance authority. */
export const NOTICE_MAINTENANCE_BUDGET_SQL = String.raw`SELECT pg_catalog.set_config('statement_timeout',
 LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
 pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
 pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);`;
const REFUND = 'order.refund.success.notice', WRITEOFF = 'order.writeoff.notice', PRICE = 'order.price.revision';
const VIRTUAL = ['recharge.paid.shipping','membership.paid.shipping'] as const;
export interface PaidNoticeGeneration { readonly price:boolean; readonly virtual:boolean; readonly paid:boolean;
  readonly membership?:boolean; readonly recharge?:boolean; readonly rechargeRefundNotice?:boolean;
  readonly addons:readonly string[]; readonly events:readonly string[]; readonly definition:string }
const definition=(events:readonly string[])=>`CHECK (((event_type)::text = ANY ((ARRAY[${events.map(e=>`'${e}'::character varying`).join(', ')}])::text[])))`;
export const PAID_NOTICE_GENERATIONS:readonly PaidNoticeGeneration[]=Object.freeze([false,true].flatMap(virtual=>[false,true].flatMap(price=>
  [[],[REFUND],[WRITEOFF],[REFUND,WRITEOFF],[WRITEOFF,REFUND]].flatMap(addons=>[false,true].map(paid=>{
    const events=Object.freeze([...PRODUCT_SAVE_EFFECTS_EVENTS,...(price?[PRICE]:[]),...(virtual?VIRTUAL:[]),...addons,...(paid?[PAID_NOTICE_EVENT]:[])]);
    return Object.freeze({price,virtual,paid,addons:Object.freeze([...addons]),events,definition:definition(events)});
  })))));
/** Membership requires the formally installed domain columns. Existing forty
 * generations and standalone 0200 SQL keep their byte-identical definitions. */
export const MEMBERSHIP_PAID_NOTICE_GENERATIONS:readonly PaidNoticeGeneration[]=Object.freeze(PAID_NOTICE_GENERATIONS.filter(g=>g.virtual).map(g=>{
  const events=Object.freeze([...g.events,...MEMBERSHIP_PAID_EVENTS]);
  return Object.freeze({...g,membership:true,events,definition:definition(events)});
}));
export const RECHARGE_PAID_NOTICE_GENERATIONS:readonly PaidNoticeGeneration[]=Object.freeze(MEMBERSHIP_PAID_NOTICE_GENERATIONS.map(g=>{const events=Object.freeze([...g.events,...RECHARGE_PAID_EVENTS]);return Object.freeze({...g,recharge:true,events,definition:definition(events)});}));
/** Exactly twenty descendants; the eighty predecessors retain their exact objects and SQL definitions. */
export const RECHARGE_REFUND_NOTICE_GENERATIONS:readonly PaidNoticeGeneration[]=Object.freeze(RECHARGE_PAID_NOTICE_GENERATIONS.map(g=>{
  const events=Object.freeze([...g.events,RECHARGE_REFUND_NOTICE_EVENT]);
  return Object.freeze({...g,rechargeRefundNotice:true,events,definition:definition(events)});
}));
export function paidNoticeEventGeneration(value:unknown):PaidNoticeGeneration|null {
  return typeof value==='string'?[...PAID_NOTICE_GENERATIONS,...MEMBERSHIP_PAID_NOTICE_GENERATIONS,...RECHARGE_PAID_NOTICE_GENERATIONS,...RECHARGE_REFUND_NOTICE_GENERATIONS].find(g=>g.definition===value)??null:null;
}
export function normalizePaidNoticeEventDefinition(value:unknown):unknown {
  const g=paidNoticeEventGeneration(value);return g&&(g.paid||g.membership||g.recharge)?definition(g.events.filter(e=>e!==PAID_NOTICE_EVENT&&!MEMBERSHIP_PAID_EVENTS.includes(e)&&!RECHARGE_PAID_EVENTS.includes(e)&&e!==RECHARGE_REFUND_NOTICE_EVENT)):value;
}
export const PAID_NOTICE_CATALOG_SQL = String.raw`SELECT pg_catalog.pg_get_constraintdef(k.oid,false) AS definition,
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
/** Internal closed successors for older installers. Only exact paid-notice
 * successors can enter their addon branches; a raced unknown catalog is rejected
 * again under the same ACCESS EXCLUSIVE lock. The optional virtual guard is
 * fixed trusted SQL supplied by the Supplier wrapper, never input. */
export function paidNoticeAddonUpgradeSql(addon: 'paid' | 'writeoff' | 'refund' | 'price' | 'membership' | 'recharge' | 'recharge-refund', virtualGuard = '', includeMembership = false, includeRecharge = false, includeRechargeRefundNotice = false): string {
  if (includeRechargeRefundNotice && (!includeMembership || !includeRecharge) || addon==='recharge-refund' && !includeRechargeRefundNotice)
    throw Error('Recharge refund notice requires explicit complete recharge successor opt-in');
  const all = includeRechargeRefundNotice ? [...PAID_NOTICE_GENERATIONS,...MEMBERSHIP_PAID_NOTICE_GENERATIONS,...RECHARGE_PAID_NOTICE_GENERATIONS,...RECHARGE_REFUND_NOTICE_GENERATIONS] : includeRecharge ? [...PAID_NOTICE_GENERATIONS,...MEMBERSHIP_PAID_NOTICE_GENERATIONS,...RECHARGE_PAID_NOTICE_GENERATIONS] : includeMembership ? [...PAID_NOTICE_GENERATIONS,...MEMBERSHIP_PAID_NOTICE_GENERATIONS] : PAID_NOTICE_GENERATIONS;
  const sources = addon==='recharge-refund' ? all.filter(g=>g.recharge) : addon==='recharge' ? all.filter(g=>g.membership) : addon === 'membership' ? all.filter(g=>g.virtual) : addon === 'paid' ? all : all.filter(g => g.paid || g.membership);
  const cases = sources.map(generation => {
    const enabled = addon==='recharge-refund' ? generation.rechargeRefundNotice===true : addon==='recharge' ? generation.recharge===true : addon === 'membership' ? generation.membership===true : addon === 'price' ? generation.price : addon === 'paid' ? generation.paid : generation.addons.includes(addon === 'refund' ? REFUND : WRITEOFF);
    const refundTail = generation.rechargeRefundNotice ? [RECHARGE_REFUND_NOTICE_EVENT] : [];
    const memberTail = [...(generation.membership ? MEMBERSHIP_PAID_EVENTS : []),...(generation.recharge?RECHARGE_PAID_EVENTS:[]),...refundTail];
    const events = addon==='recharge-refund' ? [...generation.events.filter(e=>e!==RECHARGE_REFUND_NOTICE_EVENT),RECHARGE_REFUND_NOTICE_EVENT]
      : addon==='recharge' ? [...generation.events.filter(e=>!RECHARGE_PAID_EVENTS.includes(e)&&e!==RECHARGE_REFUND_NOTICE_EVENT),...RECHARGE_PAID_EVENTS,...refundTail]
      : addon === 'membership' ? [...generation.events.filter(e=>!MEMBERSHIP_PAID_EVENTS.includes(e)&&!RECHARGE_PAID_EVENTS.includes(e)&&e!==RECHARGE_REFUND_NOTICE_EVENT),...MEMBERSHIP_PAID_EVENTS,...(generation.recharge?RECHARGE_PAID_EVENTS:[]),...refundTail]
      : addon === 'price'
      ? [...PRODUCT_SAVE_EFFECTS_EVENTS, PRICE, ...(generation.virtual ? VIRTUAL : []), ...generation.addons, ...(generation.paid ? [PAID_NOTICE_EVENT] : []),...memberTail]
      : [...generation.events.filter(event => event !== PAID_NOTICE_EVENT&&!MEMBERSHIP_PAID_EVENTS.includes(event)&&!RECHARGE_PAID_EVENTS.includes(event)&&event!==RECHARGE_REFUND_NOTICE_EVENT),
        ...(addon === 'paid' ? [] : [addon === 'refund' ? REFUND : WRITEOFF]),
        ...(addon === 'paid'||generation.paid ? [PAID_NOTICE_EVENT] : []),...memberTail];
    return ` WHEN ${literal(generation.definition)} THEN already_enabled:=${enabled}; virtual_subjects:=${generation.virtual}; events:=${literal(events.map(literal).join(','))};`;
  }).join('\n');
  return `-- Explicit bounded ${addon} event commissioning; no business DML or grants.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SELECT pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
 pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
 pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);
DO $paid_notice_successor$
DECLARE d text; safe boolean; old_comment text; events text; already_enabled boolean; virtual_subjects boolean;
 row_count integer; byte_count bigint; oversized boolean; virtual_catalog record;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed'
   OR pg_catalog.current_setting('transaction_read_only')<>'off'
   OR pg_catalog.current_setting('session_replication_role')<>'origin'
   OR current_user<>session_user OR pg_catalog.current_schema()<>'pg_catalog'
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
     WHERE c.oid=pg_catalog.to_regclass('public.store_order_outbox') AND r.rolname=current_user AND r.rolcanlogin) THEN
   RAISE EXCEPTION 'Paid notice requires direct PG16 owner maintenance';
 END IF;
 LOCK TABLE ONLY public.store_order_outbox IN ACCESS EXCLUSIVE MODE NOWAIT;
 SELECT q.definition,q.safe INTO d,safe FROM (${PAID_NOTICE_CATALOG_SQL}) q;
 IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Paid notice outbox catalog drift'; END IF;
 CASE d
${cases}
 ELSE RAISE EXCEPTION 'Paid notice predecessor drift; no automatic repair';
 END CASE;
${virtualGuard}
 IF already_enabled THEN RETURN; END IF;
 SELECT pg_catalog.obj_description(oid,'pg_constraint') INTO old_comment FROM pg_catalog.pg_constraint
  WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck';
 IF pg_catalog.octet_length(old_comment)>4096 THEN RAISE EXCEPTION 'Paid notice constraint comment budget exceeded'; END IF;
 SELECT count(*)::integer,COALESCE(sum(pg_column_size(t)),0),COALESCE(bool_or(pg_column_size(t)>1048576),false)
  INTO row_count,byte_count,oversized FROM (SELECT * FROM public.store_order_outbox LIMIT 10001) t;
 IF row_count>10000 OR byte_count>16777216 OR oversized THEN RAISE EXCEPTION 'Paid notice outbox maintenance row budget exceeded'; END IF;
 ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck;
 EXECUTE 'ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type IN ('||events||'))';
 IF old_comment IS NOT NULL THEN EXECUTE pg_catalog.format('COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS %L',old_comment); END IF;
END
$paid_notice_successor$;
`;
}
export const PAID_NOTICE_SQL=paidNoticeAddonUpgradeSql('paid');
/** Only an exact commissioned public catalog can admit new payment events.
 * No public catalog, or an exact pre-0200 generation, remains inactive. This
 * preserves private historical fixtures without commissioning their schemas. */
export async function paidNoticeCommissionedTx(tx:Pick<DbClient,'execute'>):Promise<boolean>{
  const rows=await tx.execute<{definition:string;safe:boolean}>(sql.raw(PAID_NOTICE_CATALOG_SQL));
  if(rows.length===0)return false;
  const g=rows.length===1?paidNoticeEventGeneration(rows[0].definition):null;
  if(g&&!g.paid)return false;
  const historical=PRODUCT_SAVE_EFFECTS_EVENTS.slice(0,13);
  if(rows.length===1&&[3,5,7,8,9,10,11,12,13].some(n=>rows[0].definition===definition(historical.slice(0,n))))return false;
  if(g?.paid&&rows[0].safe===true)return true;
  throw new ServiceUnavailableException('付款成功通知数据库合同发生漂移');
}
export async function runPaidNoticeUpgrade(db:Pick<DbClient,'$client'>):Promise<void>{
  if(!db.$client)throw Error('Paid notice upgrade requires a root database');
  await db.$client.begin('isolation level read committed',async tx=>{
    await tx.unsafe(NOTICE_MAINTENANCE_BUDGET_SQL);
    const rows=await tx.unsafe(PAID_NOTICE_CATALOG_SQL);
    const generation=rows.length===1?paidNoticeEventGeneration(rows[0].definition):null;
    if(generation?.rechargeRefundNotice)await (await import('./rechargeRefundNotice')).assertRechargeRefundNoticeActivePairUnsafeTx(tx);
    await tx.unsafe(generation?.membership
      ?paidNoticeAddonUpgradeSql('paid','',true,generation.recharge===true,generation.rechargeRefundNotice===true):PAID_NOTICE_SQL);
  });
}
