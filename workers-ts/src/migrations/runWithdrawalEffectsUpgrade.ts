import type postgres from 'postgres';
import type { DbClient } from '../lib/di';
import { inspectWithdrawalReplayUpgrade } from './runWithdrawalReplayUpgrade';

// Fixed DB-007 operation only: external 0131–0133, directly to the final
// superset CHECK. Never replay the intermediate narrower notification CHECKs.
const TABLES = ['capital_flow', 'order_notification_delivery', 'store_order_outbox', 'system_message'] as const;
const EVENTS = ['order.paid', 'order.delivery.notice', 'order.refund.refused.notice',
  'order.second_card.advent.notice', 'order.second_card.expired.notice',
  'withdrawal.approved.notice', 'withdrawal.refused.notice', 'withdrawal.applied.notice', 'withdrawal.staff.refresh'];
const eventDefinition = (count: number) => `CHECK (((event_type)::text = ANY ((ARRAY[${EVENTS.slice(0,count).map(e => `'${e}'::character varying`).join(', ')}])::text[])))`;
const SUBJECT = 'CHECK ((((withdrawal_id IS NULL) AND (order_id IS NOT NULL)) OR ((withdrawal_id IS NOT NULL) AND (withdrawal_id > 0) AND (order_id IS NULL))))';
const INDEXES = {
  cf_event_key_uq: 'CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow USING btree (event_key)',
  ond_withdrawal: 'CREATE INDEX ond_withdrawal ON public.order_notification_delivery USING btree (withdrawal_id, id) WHERE (withdrawal_id IS NOT NULL)',
  smsg_staff_inbox: 'CREATE INDEX smsg_staff_inbox ON public.system_message USING btree (user_id, id) WHERE ((type = 2) AND (status = 1) AND (is_del = 0))',
};
type State = {
  baseSupported: boolean; noEventTriggers: boolean;
  keyPresent: boolean; keyCorrect: boolean; withdrawalPresent: boolean; withdrawalCorrect: boolean;
  orderNullable: boolean; subjectPresent: boolean; subjectCorrect: boolean;
  eventDefinition: string | null; eventValidated: boolean;
  indexes: { name: string; definition: string | null; valid: boolean; ready: boolean }[];
};

async function state(tx: postgres.TransactionSql): Promise<State> {
  const [row] = await tx<{ state: State }[]>`WITH targets AS (
    SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('capital_flow','order_notification_delivery','store_order_outbox','system_message')
  ), columns AS (
    SELECT t.relname,a.*,d.adbin IS NULL AS no_default FROM targets t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped
  ), constraints AS (
    SELECT t.relname,c.*,pg_catalog.pg_get_constraintdef(c.oid) AS definition FROM targets t
    JOIN pg_catalog.pg_constraint c ON c.conrelid=t.oid
  ) SELECT pg_catalog.jsonb_build_object(
    'baseSupported',(SELECT count(*)=4 FROM targets WHERE relkind='r' AND relpersistence='p' AND NOT relrowsecurity AND NOT relforcerowsecurity
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=targets.oid OR inhrelid=targets.oid))
      AND current_setting('server_version_num')::integer/10000=16
      AND (SELECT count(*)=4 FROM columns a WHERE attname='id' AND atttypid='pg_catalog.int4'::regtype AND attgenerated=''
        AND EXISTS(SELECT 1 FROM constraints c WHERE c.conrelid=a.attrelid AND c.contype='p' AND c.convalidated AND c.conkey=ARRAY[a.attnum]))
      AND EXISTS(SELECT 1 FROM columns WHERE relname='order_notification_delivery' AND attname='order_id'
        AND atttypid='pg_catalog.int4'::regtype AND attgenerated='' AND attidentity='' AND no_default)
      AND EXISTS(SELECT 1 FROM columns WHERE relname='store_order_outbox' AND attname='event_type'
        AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=68 AND attnotnull AND attgenerated=''
        AND attcollation=(SELECT typcollation FROM pg_catalog.pg_type WHERE oid='pg_catalog.varchar'::regtype))
      AND (SELECT count(*)=4 FROM columns WHERE relname='system_message' AND attgenerated='' AND (
        (attname='user_id' AND atttypid='pg_catalog.int4'::regtype) OR
        (attname IN ('type','status','is_del') AND atttypid='pg_catalog.int2'::regtype))),
    'noEventTriggers',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D'),
    'keyPresent',EXISTS(SELECT 1 FROM columns WHERE relname='capital_flow' AND attname='event_key'),
    'keyCorrect',EXISTS(SELECT 1 FROM columns WHERE relname='capital_flow' AND attname='event_key'
      AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=132 AND NOT attnotnull AND no_default AND attgenerated='' AND attidentity=''
      AND attcollation=(SELECT typcollation FROM pg_catalog.pg_type WHERE oid='pg_catalog.varchar'::regtype)),
    'withdrawalPresent',EXISTS(SELECT 1 FROM columns WHERE relname='order_notification_delivery' AND attname='withdrawal_id'),
    'withdrawalCorrect',EXISTS(SELECT 1 FROM columns WHERE relname='order_notification_delivery' AND attname='withdrawal_id'
      AND atttypid='pg_catalog.int4'::regtype AND NOT attnotnull AND no_default AND attgenerated='' AND attidentity=''),
    'orderNullable',EXISTS(SELECT 1 FROM columns WHERE relname='order_notification_delivery' AND attname='order_id' AND NOT attnotnull),
    'subjectPresent',EXISTS(SELECT 1 FROM constraints WHERE relname='order_notification_delivery' AND conname='ond_subject_ck'),
    'subjectCorrect',EXISTS(SELECT 1 FROM constraints WHERE relname='order_notification_delivery' AND conname='ond_subject_ck'
      AND contype='c' AND convalidated AND NOT connoinherit AND definition=${SUBJECT}),
    'eventDefinition',(SELECT definition FROM constraints WHERE relname='store_order_outbox' AND conname='soob_event_type_ck'),
    'eventValidated',EXISTS(SELECT 1 FROM constraints WHERE relname='store_order_outbox' AND conname='soob_event_type_ck'
      AND contype='c' AND convalidated AND NOT connoinherit),
    'indexes',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',c.relname,'definition',pg_catalog.pg_get_indexdef(i.indexrelid),
      'valid',i.indisvalid,'ready',i.indisready) ORDER BY c.relname),'[]'::jsonb)
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid WHERE n.nspname='public' AND c.relname IN ('cf_event_key_uq','ond_withdrawal','smsg_staff_inbox'))
  ) AS state`;
  if (!row) throw new Error('Withdrawal effects catalog unavailable');
  return row.state;
}
function supported(s: State): boolean {
  return s.baseSupported && s.noEventTriggers && (!s.keyPresent || s.keyCorrect)
    && (!s.withdrawalPresent || s.withdrawalCorrect) && (!s.subjectPresent || s.subjectCorrect)
    && s.eventValidated && [5,7,8,9].some(n => eventDefinition(n) === s.eventDefinition)
    && s.indexes.every(i => i.valid && i.ready && Object.entries(INDEXES).some(([name,definition]) => name===i.name && definition===i.definition));
}
const ready = (s: State) => supported(s) && s.keyCorrect && s.withdrawalCorrect && s.orderNullable
  && s.subjectCorrect && s.eventDefinition===eventDefinition(9) && s.indexes.length===3;
function validate(s: State) { if (!supported(s)) throw new Error('Withdrawal effects prerequisite drift; no automatic repair'); }
async function configure(tx: postgres.TransactionSql) {
  await tx`SELECT pg_catalog.set_config('search_path','pg_catalog,public,pg_temp',true),
    pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`;
}
async function withinBudget(tx: postgres.TransactionSql) {
  for (const table of TABLES) {
    const [size] = await tx.unsafe<{ rows: number }[]>(`SELECT count(*)::integer AS rows FROM (SELECT 1 FROM public.${table} LIMIT 10001) bounded`);
    if (!size || size.rows>10000) return false;
  }
  return true;
}
async function fingerprint(tx: postgres.TransactionSql) {
  const tables: { table: string; rows: number; sha256: string }[] = [];
  for (const table of TABLES) {
    // Only absent additive fields become SQL-null JSON. Existing values are
    // included, never erased; table names and expressions are closed constants.
    const normalize = table==='capital_flow' ? " || jsonb_build_object('event_key',COALESCE(to_jsonb(t)->'event_key','null'::jsonb))"
      : table==='order_notification_delivery' ? " || jsonb_build_object('withdrawal_id',COALESCE(to_jsonb(t)->'withdrawal_id','null'::jsonb))" : '';
    const [row] = await tx.unsafe<{ rows: number; sha256: string }[]>(`SELECT count(*)::integer AS rows,
      encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to((to_jsonb(t)${normalize})::text,'UTF8')),'hex'),'' ORDER BY t.id),''),'UTF8')),'hex') AS sha256
      FROM public.${table} t`);
    if (!row) throw new Error('Withdrawal effects fingerprint unavailable');
    tables.push({ table, ...row });
  }
  const [summary] = await tx<{ sha256: string }[]>`SELECT encode(sha256(convert_to(${JSON.stringify(tables)},'UTF8')),'hex') AS sha256`;
  return { rows: tables.reduce((sum,t) => sum+t.rows,0), sha256:summary.sha256, tables };
}
async function requireReplay(db: Pick<DbClient,'$client'>) {
  const replay = await inspectWithdrawalReplayUpgrade(db);
  if (!replay.supported || !replay.ready) throw new Error('DB-006 must be complete before DB-007');
}
export async function inspectWithdrawalEffectsUpgrade(db: Pick<DbClient,'$client'>) {
  if (!db.$client) throw new Error('Withdrawal effects inspection requires a root database');
  await requireReplay(db);
  return db.$client.begin('isolation level repeatable read read only',async tx => {
    await configure(tx);
    const catalog = await state(tx);
    const allowed = supported(catalog);
    const budget = allowed && await withinBudget(tx);
    return { supported:allowed,ready:ready(catalog),withinBudget:budget,catalog,fingerprint:budget ? await fingerprint(tx) : null };
  });
}
export async function runWithdrawalEffectsUpgrade(db: Pick<DbClient,'$client'>) {
  if (!db.$client) throw new Error('Withdrawal effects upgrade requires a root database');
  await requireReplay(db);
  return db.$client.begin('isolation level read committed',async tx => {
    await configure(tx);
    validate(await state(tx));
    await tx`LOCK TABLE ONLY public.capital_flow, ONLY public.order_notification_delivery,
      ONLY public.store_order_outbox, ONLY public.system_message IN ACCESS EXCLUSIVE MODE NOWAIT`;
    const initial = await state(tx);
    validate(initial);
    if (!await withinBudget(tx)) throw new Error('Withdrawal effects maintenance row budget exceeded');
    const before = await fingerprint(tx);
    const applied = !ready(initial);
    if (!initial.keyPresent) await tx`ALTER TABLE public.capital_flow ADD COLUMN event_key VARCHAR(128)`;
    if (!initial.withdrawalPresent) await tx`ALTER TABLE public.order_notification_delivery ADD COLUMN withdrawal_id INTEGER`;
    if (!initial.orderNullable) await tx`ALTER TABLE public.order_notification_delivery ALTER COLUMN order_id DROP NOT NULL`;
    if (!initial.subjectPresent) await tx`ALTER TABLE public.order_notification_delivery ADD CONSTRAINT ond_subject_ck CHECK (
      (withdrawal_id IS NULL AND order_id IS NOT NULL) OR (withdrawal_id IS NOT NULL AND withdrawal_id>0 AND order_id IS NULL))`;
    if (initial.eventDefinition!==eventDefinition(9)) {
      await tx`ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck`;
      await tx.unsafe(`ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK (event_type IN (${EVENTS.map(e => `'${e}'`).join(',')}))`);
    }
    for (const [name,definition] of Object.entries(INDEXES)) {
      if (!initial.indexes.some(i => i.name===name)) await tx.unsafe(definition);
    }
    if (!ready(await state(tx))) throw new Error('Withdrawal effects postflight not ready');
    const after = await fingerprint(tx);
    if (JSON.stringify(before)!==JSON.stringify(after)) throw new Error('Withdrawal effects business fingerprint changed');
    return { migration:'0131-0133-withdrawal-effects',applied,ready:true,before,after };
  });
}
