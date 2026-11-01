import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { PRODUCT_SAVE_EFFECTS_EVENTS } from './productSaveEffects';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import type { RoutineShippingNames, RoutineShippingCatalog } from './routineShipping';

type Query = Pick<DbClient, 'execute'>;
export const ROUTINE_VIRTUAL_SHIPPING_SUBJECTS_GATE = [731722, 0] as const;
export const ROUTINE_VIRTUAL_SHIPPING_MARK = 'paid_virtual_shipping';
export const ROUTINE_VIRTUAL_SHIPPING_EVENTS = ['recharge.paid.shipping', 'membership.paid.shipping'] as const;
export const ROUTINE_VIRTUAL_SHIPPING_BASE_EVENTS = [...PRODUCT_SAVE_EFFECTS_EVENTS] as const;
export const ROUTINE_VIRTUAL_SHIPPING_PRICE_EVENTS = [...PRODUCT_SAVE_EFFECTS_EVENTS, 'order.price.revision'] as const;
export const routineVirtualShippingEventDefinition = (priceRevision: boolean, virtual = true): string => {
  const events = [...(priceRevision ? ROUTINE_VIRTUAL_SHIPPING_PRICE_EVENTS : ROUTINE_VIRTUAL_SHIPPING_BASE_EVENTS),
    ...(virtual ? ROUTINE_VIRTUAL_SHIPPING_EVENTS : [])];
  return `CHECK (((event_type)::text = ANY ((ARRAY[${events.map(e => `'${e}'::character varying`).join(', ')}])::text[])))`;
};
export const ROUTINE_VIRTUAL_SHIPPING_OLD_SUBJECT = 'CHECK ((((withdrawal_id IS NULL) AND (order_id IS NOT NULL)) OR ((withdrawal_id IS NOT NULL) AND (withdrawal_id > 0) AND (order_id IS NULL))))';
const and = (...parts: string[]) => '(' + parts.join(' AND ') + ')';
const or = (...parts: string[]) => '(' + parts.join(' OR ') + ')';
export const ROUTINE_VIRTUAL_SHIPPING_SUBJECT_DEFINITION = 'CHECK (' + or(
  and('(subject_domain IS NULL)', '(subject_id IS NULL)', or(
    and('(withdrawal_id IS NULL)', '(order_id IS NOT NULL)'),
    and('(withdrawal_id IS NOT NULL)', '(withdrawal_id > 0)', '(order_id IS NULL)'))),
  and('(subject_domain IS NOT NULL)', '(subject_id IS NOT NULL)',
    "((subject_domain)::text = ANY ((ARRAY['recharge'::character varying, 'membership'::character varying])::text[]))",
    '(subject_id > 0)', '(order_id IS NULL)', '(withdrawal_id IS NULL)',
    "((channel)::text = 'wechat_shipping'::text)", "((notice_mark)::text = 'paid_virtual_shipping'::text)",
    "((event_key)::text = (((subject_domain)::text || '.paid.shipping:'::text) || (subject_id)::text))")) + ')';
export const ROUTINE_VIRTUAL_SHIPPING_SUBJECT_CHECK_SQL = `CHECK (
  (subject_domain IS NULL AND subject_id IS NULL AND
    ((withdrawal_id IS NULL AND order_id IS NOT NULL) OR (withdrawal_id IS NOT NULL AND withdrawal_id>0 AND order_id IS NULL)))
  OR (subject_domain IS NOT NULL AND subject_id IS NOT NULL AND subject_domain IN ('recharge','membership')
    AND subject_id>0 AND order_id IS NULL AND withdrawal_id IS NULL
    AND channel='wechat_shipping' AND notice_mark='paid_virtual_shipping'
    AND event_key=subject_domain::text || '.paid.shipping:'::text || subject_id::text)
)`;
export const ROUTINE_VIRTUAL_SHIPPING_INDEX = 'CREATE INDEX ond_virtual_subject ON public.order_notification_delivery USING btree (subject_domain, subject_id, id) WHERE (subject_domain IS NOT NULL)';
export function routineVirtualShippingSubjectsInstallSql(priceRevision: boolean): string {
  const events = [...(priceRevision ? ROUTINE_VIRTUAL_SHIPPING_PRICE_EVENTS : ROUTINE_VIRTUAL_SHIPPING_BASE_EVENTS), ...ROUTINE_VIRTUAL_SHIPPING_EVENTS];
  return `ALTER TABLE public.order_notification_delivery ADD COLUMN subject_domain varchar(16), ADD COLUMN subject_id integer;
ALTER TABLE public.order_notification_delivery DROP CONSTRAINT ond_subject_ck;
ALTER TABLE public.order_notification_delivery ADD CONSTRAINT ond_subject_ck ${ROUTINE_VIRTUAL_SHIPPING_SUBJECT_CHECK_SQL};
${ROUTINE_VIRTUAL_SHIPPING_INDEX};
ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck;
ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type IN (${events.map(e => `'${e}'`).join(',')}));`;
}

export type RoutineVirtualShippingSubjectsState = 'base14' | 'base15' | 'virtual16' | 'virtual17' | 'partial';
export interface RoutineVirtualShippingSubjectsStructure {
  present: boolean; ready: boolean; state: RoutineVirtualShippingSubjectsState; failures: string[];
  maintenance: string | null; maintenanceOid: string | null;
}
export interface RoutineVirtualShippingSubjectsCatalog extends RoutineVirtualShippingSubjectsStructure {
  binding: RoutineShippingCatalog['binding'];
}
/** Shared by the direct postgres.js legacy inspector. No business rows, grants,
 * advisory locks, full profile recursion or dynamically selected identifiers. */
export const ROUTINE_VIRTUAL_SHIPPING_STRUCTURE_SQL = `WITH
 targets AS (SELECT c.* FROM pg_catalog.pg_class c WHERE c.oid IN
   (pg_catalog.to_regclass('public.order_notification_delivery'),pg_catalog.to_regclass('public.store_order_outbox'))),
 attrs AS (SELECT c.relname,a.*,d.oid AS default_oid FROM targets c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
   LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped),
 checks AS (SELECT c.relname,k.*,pg_catalog.pg_get_constraintdef(k.oid,false) AS definition
   FROM targets c JOIN pg_catalog.pg_constraint k ON k.conrelid=c.oid),
 named_index AS (SELECT c.*,i.indrelid,i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indisexclusion,i.indexprs,i.indnkeyatts,i.indnatts,
   i.indclass,i.indcollation,i.indoption,
   pg_catalog.pg_get_indexdef(c.oid) AS definition FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
   WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'ond_virtual%')
 SELECT
 (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
   AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.reloptions IS NULL
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)) FROM targets c)
   AND (SELECT pg_catalog.count(DISTINCT relowner)=1 FROM targets)
   AND EXISTS(SELECT 1 FROM targets c JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE r.rolsuper AND r.rolcanlogin)
   AND pg_catalog.current_setting('server_version_num')::integer/10000=16
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
   AND (SELECT pg_catalog.count(*)=2 FROM attrs a WHERE attname='id' AND atttypid='pg_catalog.int4'::regtype AND attnotnull
     AND attgenerated='' AND attidentity='' AND EXISTS(SELECT 1 FROM checks k WHERE k.conrelid=a.attrelid AND k.contype='p'
       AND k.convalidated AND k.conkey=ARRAY[a.attnum]::smallint[])) AS safe,
 (SELECT pg_catalog.pg_get_userbyid(relowner) FROM targets WHERE relname='order_notification_delivery') AS maintenance,
 (SELECT relowner::text FROM targets WHERE relname='order_notification_delivery') AS maintenance_oid,
 (SELECT pg_catalog.count(*)=7 FROM attrs WHERE attgenerated='' AND attidentity='' AND default_oid IS NULL
   AND (atttypid<>'pg_catalog.varchar'::regtype OR attcollation='pg_catalog."default"'::regcollation) AND (
   (relname='order_notification_delivery' AND attname IN('order_id','withdrawal_id') AND atttypid='pg_catalog.int4'::regtype AND NOT attnotnull) OR
   (relname='order_notification_delivery' AND attname='event_key' AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=132 AND attnotnull) OR
   (relname='order_notification_delivery' AND attname='channel' AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=36 AND attnotnull) OR
   (relname='order_notification_delivery' AND attname='notice_mark' AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=54 AND attnotnull) OR
   (relname='store_order_outbox' AND attname='event_type' AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=68 AND attnotnull) OR
   (relname='store_order_outbox' AND attname='event_key' AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=132 AND attnotnull))) AS core,
 (SELECT pg_catalog.count(*) FROM attrs WHERE relname='order_notification_delivery' AND attname LIKE 'subject_%')::integer AS subject_columns,
 (SELECT pg_catalog.count(*)=2 FROM attrs WHERE relname='order_notification_delivery' AND NOT attnotnull
   AND attgenerated='' AND attidentity='' AND default_oid IS NULL AND attacl IS NULL AND (
    (attname='subject_domain' AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=20 AND attcollation='pg_catalog."default"'::regcollation) OR
    (attname='subject_id' AND atttypid='pg_catalog.int4'::regtype))) AS columns_ready,
 (SELECT definition FROM checks WHERE relname='order_notification_delivery' AND conname='ond_subject_ck') AS subject_definition,
 (SELECT contype='c' AND convalidated AND NOT condeferrable AND NOT condeferred AND NOT connoinherit AND conislocal AND coninhcount=0
   FROM checks WHERE relname='order_notification_delivery' AND conname='ond_subject_ck') AS subject_safe,
 (SELECT definition FROM checks WHERE relname='store_order_outbox' AND conname='soob_event_type_ck') AS event_definition,
 (SELECT contype='c' AND convalidated AND NOT condeferrable AND NOT condeferred AND NOT connoinherit AND conislocal AND coninhcount=0
   AND conkey=ARRAY[(SELECT attnum FROM attrs WHERE relname='store_order_outbox' AND attname='event_type')]::smallint[]
   FROM checks WHERE relname='store_order_outbox' AND conname='soob_event_type_ck') AS event_safe,
 (SELECT pg_catalog.count(*) FROM named_index)::integer AS indexes,
 (SELECT pg_catalog.count(*)=1 AND pg_catalog.bool_and(relname='ond_virtual_subject' AND relkind='i' AND relpersistence='p'
   AND relowner=(SELECT relowner FROM targets WHERE relname='order_notification_delivery') AND relacl IS NULL AND reloptions IS NULL
   AND indrelid=pg_catalog.to_regclass('public.order_notification_delivery') AND indisvalid AND indisready AND indislive
   AND NOT indisunique AND NOT indisexclusion AND indexprs IS NULL AND indnkeyatts=3 AND indnatts=3
   AND relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
   AND indclass[0]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='text_ops'
     AND opcmethod=relam AND opcintype='pg_catalog.text'::regtype AND opcdefault AND opckeytype=0)
   AND indclass[1]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='int4_ops'
     AND opcmethod=relam AND opcintype='pg_catalog.int4'::regtype AND opcdefault AND opckeytype=0)
   AND indclass[2]=indclass[1]
   AND indcollation[0]='pg_catalog."default"'::regcollation AND indcollation[1]=0 AND indcollation[2]=0
   AND indoption::text='0 0 0'
   AND definition='${ROUTINE_VIRTUAL_SHIPPING_INDEX}') FROM named_index) AS index_ready`;

/** Exact classification is also used by DB-007 and Supplier's successor port. */
export function classifyRoutineVirtualShippingSubjects(row: Record<string, unknown> | undefined): RoutineVirtualShippingSubjectsStructure {
  const failures: string[] = [];
  const require = (name: string, condition: boolean) => { if (!condition) failures.push(name); };
  require('tables', row?.safe === true); require('core_columns', row?.core === true);
  require('subject_constraint', row?.subject_safe === true); require('event_constraint', row?.event_safe === true);
  const base = row?.event_definition === routineVirtualShippingEventDefinition(false, false) ? 'base14'
    : row?.event_definition === routineVirtualShippingEventDefinition(true, false) ? 'base15' : null;
  const successor = row?.event_definition === routineVirtualShippingEventDefinition(false) ? 'virtual16'
    : row?.event_definition === routineVirtualShippingEventDefinition(true) ? 'virtual17' : null;
  const old = !!base && row?.subject_columns === 0 && row.indexes === 0 && row.subject_definition === ROUTINE_VIRTUAL_SHIPPING_OLD_SUBJECT;
  const complete = !!successor && row?.subject_columns === 2 && row.columns_ready === true
    && row.indexes === 1 && row.index_ready === true && row.subject_definition === ROUTINE_VIRTUAL_SHIPPING_SUBJECT_DEFINITION;
  if (!old) {
    require('successor_events', successor !== null);
    require('subject_columns', row?.subject_columns === 2);
    require('subject_column_shape', row?.columns_ready === true);
    require('subject_index_count', row?.indexes === 1);
    require('subject_index_shape', row?.index_ready === true);
    require('subject_definition', row?.subject_definition === ROUTINE_VIRTUAL_SHIPPING_SUBJECT_DEFINITION);
  }
  require('joint_subject_event', old || complete);
  const maintenance = typeof row?.maintenance === 'string' ? row.maintenance : null;
  const maintenanceOid = typeof row?.maintenance_oid === 'string' && /^[0-9]+$/u.test(row.maintenance_oid) ? row.maintenance_oid : null;
  require('owner', maintenance !== null && maintenanceOid !== null);
  return { present: !old || failures.length > 0, ready: complete && failures.length === 0,
    state: failures.length ? 'partial' : old ? base! : successor!, failures, maintenance, maintenanceOid };
}
export async function inspectRoutineVirtualShippingSubjectsStructure(tx: Query): Promise<RoutineVirtualShippingSubjectsStructure> {
  try { return classifyRoutineVirtualShippingSubjects((await tx.execute(sql.raw(ROUTINE_VIRTUAL_SHIPPING_STRUCTURE_SQL)))[0]); }
  catch { return { present: true, ready: false, state: 'partial', failures: ['catalog_query'], maintenance: null, maintenanceOid: null }; }
}
export async function inspectRoutineVirtualShippingSubjects(tx: Query, names?: RoutineShippingNames): Promise<RoutineVirtualShippingSubjectsCatalog> {
  let captured: RoutineShippingNames | undefined;
  if (names) {
    try {
      if (![Object.prototype,null].includes(Object.getPrototypeOf(names))) throw Error();
      const keys=Reflect.ownKeys(names),values: Record<string,string>={};
      if (keys.some(k=>typeof k!=='string'||!['maintenance','app','admin'].includes(k))) throw Error();
      for (const key of keys) {
        const d=Object.getOwnPropertyDescriptor(names,key)!;
        if (!d.enumerable||!('value' in d)||typeof d.value!=='string') throw Error();
        pricingIdentifier(d.value); values[String(key)]=d.value;
      }
      if (!values.maintenance||!values.app||new Set(Object.values(values)).size!==Object.keys(values).length) throw Error();
      captured={maintenance:values.maintenance,app:values.app,...(values.admin?{admin:values.admin}:{})};
    } catch { return {present:true,ready:false,state:'partial',binding:null,failures:['binding'],maintenance:null,maintenanceOid:null}; }
  }
  const structure = await inspectRoutineVirtualShippingSubjectsStructure(tx);
  // Supplier/DB007 import the structural leaf during module initialization.
  // Resolve App authority only at this purpose-specific async boundary.
  const {inspectRoutineShippingCatalog}=await import('./routineShipping');
  const shipping = await inspectRoutineShippingCatalog(tx, captured), binding = shipping.binding;
  if (!shipping.ready || !binding?.app || !binding.appOid || structure.maintenanceOid !== binding.maintenanceOid)
    return { ...structure, ready: false, binding: null, failures: [...structure.failures, 'source_binding'] };
  return { ...structure, binding };
}
/** Inactive legacy author still proves the canonical base App. Optional
 * payment/shipping storage is not a prerequisite to existing financial work;
 * a present partial namespace is never treated as absence. No business rows,
 * HMAC material, provider authority or writes are returned by this branch. */
async function assertInactiveLegacyStage(tx: Query, structure: RoutineVirtualShippingSubjectsStructure): Promise<void> {
  if (!structure.maintenance || !structure.maintenanceOid || structure.present
    || structure.state!=='base14'&&structure.state!=='base15') throw Error();
  const [candidate]=await tx.execute<{role:string}>(sql`SELECT current_user AS role`);
  if(typeof candidate?.role!=='string')throw Error();
  const {inspectRoutineRefundActorPrincipals}=await import('./routineRefundActorPrincipals');
  const principals=await inspectRoutineRefundActorPrincipals(tx,{maintenance:structure.maintenance,app:candidate.role}),b=principals.binding;
  if(!principals.ready||!b||b.maintenanceOid!==structure.maintenanceOid)throw Error();
  const [actual]=await tx.execute<{ready:boolean}>(sql`SELECT current_user=${b.app} AND current_user=session_user
    AND r.oid=${b.appOid}::oid AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
    AND pg_catalog.current_database()=${b.database}
    AND (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())=${b.databaseOid}
    AND pg_catalog.current_setting('server_version_num')::integer/10000=16
    AND pg_catalog.current_setting('transaction_isolation')='read committed' AND pg_catalog.current_setting('transaction_read_only')='off'
    AND pg_catalog.current_setting('session_replication_role')='origin' AND pg_catalog.current_schema()='public'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o') AS ready
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if(actual?.ready!==true)throw Error();
  const names={maintenance:b.maintenance,app:b.app,admin:b.admin};
  const {inspectRoutineOriginalPaymentEvidenceCatalog}=await import('./routineOriginalPaymentEvidence');
  const {inspectRoutinePaymentAccountPolicyCatalog}=await import('./routinePaymentAccountPolicy');
  const {inspectRoutineShippingCatalog}=await import('./routineShipping');
  for(const catalog of [await inspectRoutineOriginalPaymentEvidenceCatalog(tx,names),
    await inspectRoutinePaymentAccountPolicyCatalog(tx,names),await inspectRoutineShippingCatalog(tx,names)]){
    if(!catalog.present){if(catalog.failures.length)throw Error();continue;}
    const binding=catalog.binding;
    if(!catalog.ready||!binding||binding.maintenance!==b.maintenance||binding.maintenanceOid!==b.maintenanceOid
      ||binding.app!==b.app||binding.appOid!==b.appOid
      ||'admin'in binding&&binding.admin!==null&&binding.admin!==b.admin
      ||'adminOid'in binding&&binding.adminOid!==null&&binding.adminOid!==b.adminOid)throw Error();
  }
}
async function assertRuntime(tx: Query, stage: boolean): Promise<boolean> {
  try {
    if(stage){
      if(Object.hasOwn(tx,'$client'))throw Error();
      await tx.execute(sql`SELECT
        pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
        pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
        pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
      for(const namespace of[731714,731717,731719,731722]){
        const [gate]=await tx.execute<{locked:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(${namespace},0) AS locked`);
        if(gate?.locked!==true)throw Error();
      }
      const structure=await inspectRoutineVirtualShippingSubjectsStructure(tx);
      const [resolution]=await tx.execute<{ready:boolean}>(sql`SELECT
        pg_catalog.to_regclass('order_notification_delivery')=pg_catalog.to_regclass('public.order_notification_delivery')
        AND pg_catalog.to_regclass('store_order_outbox')=pg_catalog.to_regclass('public.store_order_outbox')
        AND NOT EXISTS(SELECT 1 FROM(VALUES('routine_original_payment_evidence'),('routine_payment_account_policy'),('routine_payment_account_use'),
          ('routine_shipping_account_policy'),('routine_shipping_dispatch'),('routine_shipping_provider_evidence')) n(name)
          WHERE pg_catalog.to_regclass(n.name) IS DISTINCT FROM pg_catalog.to_regclass('public.'||n.name)) AS ready`);
      if(resolution?.ready!==true||structure.state==='partial')throw Error();
      if(!structure.present){await assertInactiveLegacyStage(tx,structure);return false;}
    }
    const {assertRoutineShippingReadTx,assertRoutineShippingReadyTx}=await import('./routineShipping');
    const shipping = await (stage ? assertRoutineShippingReadyTx(tx) : assertRoutineShippingReadTx(tx));
    const structure = await inspectRoutineVirtualShippingSubjectsStructure(tx);
    const [resolution] = await tx.execute(sql`SELECT
      pg_catalog.to_regclass('order_notification_delivery')=pg_catalog.to_regclass('public.order_notification_delivery')
      AND pg_catalog.to_regclass('store_order_outbox')=pg_catalog.to_regclass('public.store_order_outbox') AS ready`);
    if (resolution?.ready !== true || structure.state === 'partial') throw Error();
    if (!structure.present) return false;
    if (!shipping || !(await inspectRoutineVirtualShippingSubjects(tx)).ready) throw Error();
    return true;
  } catch { throw new ServiceUnavailableException('充值会员原账号发货主体协议或运行权限尚未就绪'); }
}
/** Fresh financial author. All maintenance gates are try-only, even if the
 * caller has already stabilized its physical recharge/member source. */
export const assertRoutineVirtualShippingSubjectsStageTx = (tx: Query): Promise<boolean> => assertRuntime(tx, true);
export const assertRoutineVirtualShippingSubjectsReadyTx = assertRoutineVirtualShippingSubjectsStageTx;
/** Historical source/receipt reads add no new advisory lock. */
export const assertRoutineVirtualShippingSubjectsReadTx = (tx: Query): Promise<boolean> => assertRuntime(tx, false);
