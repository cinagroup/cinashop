import type postgres from 'postgres';
import type { DbClient } from '../lib/di';

const EXPECTED_INDEX = "CREATE UNIQUE INDEX ue_request_replay_uq ON public.user_extract USING btree (uid, request_key) WHERE ((request_key)::text <> ''::text)";
const DDL = `ALTER TABLE public.user_extract
  ADD COLUMN IF NOT EXISTS request_key VARCHAR(96) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS request_hash VARCHAR(64) DEFAULT '' NOT NULL;
ALTER TABLE public.user_extract ALTER COLUMN wechat TYPE VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS ue_request_replay_uq
  ON public.user_extract (uid, request_key) WHERE request_key <> '';`;

type State = {
  supportedTable: boolean; noEventTriggers: boolean; idAndUid: boolean;
  wechatWidth: number | null; keyPresent: boolean; keyCorrect: boolean;
  hashPresent: boolean; hashCorrect: boolean; indexPresent: boolean; indexCorrect: boolean;
};

async function state(tx: postgres.TransactionSql): Promise<State> {
  const [row] = await tx<{ state: State }[]>`WITH target AS (
    SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='user_extract'
  ), columns AS (
    SELECT a.*,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expr
    FROM target t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attnum>0 AND NOT a.attisdropped
  ), replay_index AS (
    SELECT c.oid,i.indisvalid,i.indisready,pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid WHERE n.nspname='public' AND c.relname='ue_request_replay_uq'
  ) SELECT pg_catalog.jsonb_build_object(
    'supportedTable',EXISTS(SELECT 1 FROM target t WHERE relkind='r' AND relpersistence='p'
      AND NOT relrowsecurity AND NOT relforcerowsecurity
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=t.oid OR inhrelid=t.oid)),
    'noEventTriggers',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D'),
    'idAndUid',(SELECT count(*)=2 FROM columns WHERE attname IN ('id','uid') AND atttypid='pg_catalog.int4'::regtype AND attgenerated='')
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint p JOIN columns a ON a.attrelid=p.conrelid
        WHERE p.contype='p' AND a.attname='id' AND p.conkey=ARRAY[a.attnum] AND p.convalidated),
    'wechatWidth',(SELECT atttypmod-4 FROM columns WHERE attname='wechat' AND atttypid='pg_catalog.varchar'::regtype AND attgenerated=''),
    'keyPresent',EXISTS(SELECT 1 FROM columns WHERE attname='request_key'),
    'hashPresent',EXISTS(SELECT 1 FROM columns WHERE attname='request_hash'),
    'keyCorrect',EXISTS(SELECT 1 FROM columns WHERE attname='request_key' AND atttypid='pg_catalog.varchar'::regtype
      AND atttypmod=100 AND attnotnull AND attgenerated='' AND attidentity=''
      AND attcollation=(SELECT typcollation FROM pg_catalog.pg_type WHERE oid='pg_catalog.varchar'::regtype)
      AND default_expr=${"''::character varying"}),
    'hashCorrect',EXISTS(SELECT 1 FROM columns WHERE attname='request_hash' AND atttypid='pg_catalog.varchar'::regtype
      AND atttypmod=68 AND attnotnull AND attgenerated='' AND attidentity=''
      AND attcollation=(SELECT typcollation FROM pg_catalog.pg_type WHERE oid='pg_catalog.varchar'::regtype)
      AND default_expr=${"''::character varying"}),
    'indexPresent',EXISTS(SELECT 1 FROM replay_index),
    'indexCorrect',EXISTS(SELECT 1 FROM replay_index WHERE indisvalid AND indisready AND definition=${EXPECTED_INDEX})
  ) AS state`;
  if (!row) throw new Error('Withdrawal replay catalog unavailable');
  return row.state;
}

function validate(value: State): void {
  if (!value.supportedTable || !value.noEventTriggers || !value.idAndUid
    || value.wechatWidth === null || value.wechatWidth < 1 || value.wechatWidth > 64
    || (value.keyPresent && !value.keyCorrect) || (value.hashPresent && !value.hashCorrect)
    || (value.indexPresent && !value.indexCorrect)) {
    throw new Error('Withdrawal replay prerequisite drift; no automatic repair');
  }
}
const ready = (s: State) => s.wechatWidth === 64 && s.keyCorrect && s.hashCorrect && s.indexCorrect;

async function configure(tx: postgres.TransactionSql) {
  await tx`SELECT
    pg_catalog.set_config('search_path','pg_catalog,public,pg_temp',true),
    pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    pg_catalog.set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`;
}

/** Independent read-only pre/postflight; unsupported metadata is reported, never repaired. */
export async function inspectWithdrawalReplayUpgrade(db: Pick<DbClient, '$client'>) {
  if (!db.$client) throw new Error('Withdrawal replay inspection requires a root database');
  return db.$client.begin('isolation level repeatable read read only', async tx => {
    await configure(tx);
    const catalog = await state(tx);
    let supported = true;
    try { validate(catalog); } catch { supported = false; }
    if (!supported) return { supported, ready:false, withinBudget:false, catalog, fingerprint:null };
    const [size] = await tx<{ rows:number }[]>`SELECT count(*)::integer AS rows FROM (SELECT 1 FROM public.user_extract LIMIT 10001) bounded`;
    const withinBudget = Boolean(size && size.rows <= 10000);
    return { supported, ready:ready(catalog), withinBudget, catalog, fingerprint:withinBudget ? await fingerprint(tx) : null };
  });
}

async function fingerprint(tx: postgres.TransactionSql) {
  const [row] = await tx<{ rows: number; sha256: string }[]>`SELECT count(*)::integer AS rows,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(string_agg(
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((to_jsonb(u) || jsonb_build_object(
        'request_key',COALESCE(to_jsonb(u)->'request_key','""'::jsonb),
        'request_hash',COALESCE(to_jsonb(u)->'request_hash','""'::jsonb)))::text,'UTF8')),'hex'),
      '' ORDER BY u.id),''),'UTF8')),'hex') AS sha256 FROM public.user_extract u`;
  if (!row) throw new Error('Withdrawal replay fingerprint unavailable');
  return row;
}

/** Explicit DB-006 maintenance operation, public.user_extract only.
 * No application/startup invocation, business DML, history replay or role edits.
 * This short-window executor refuses >10,000 rows (not a business limit); such
 * a target needs a separately sized maintenance plan, never partial migration.
 * Leave additive schema in place when rolling back app code; do not DROP keys.
 */
export async function runWithdrawalReplayUpgrade(db: Pick<DbClient, '$client'>) {
  if (!db.$client) throw new Error('Withdrawal replay upgrade requires a root database');
  return db.$client.begin('isolation level read committed', async tx => {
    await configure(tx);
    // Reject broad/unsupported targets before asking for a table lock, then
    // re-read under the lock so concurrent DDL cannot invalidate that decision.
    validate(await state(tx));
    await tx`LOCK TABLE ONLY public.user_extract IN ACCESS EXCLUSIVE MODE NOWAIT`;
    const beforeState = await state(tx);
    validate(beforeState);
    const [size] = await tx<{ rows: number }[]>`SELECT count(*)::integer AS rows FROM (SELECT 1 FROM public.user_extract LIMIT 10001) bounded`;
    if (!size || size.rows > 10000) throw new Error('Withdrawal replay maintenance row budget exceeded');
    const before = await fingerprint(tx);
    const applied = !ready(beforeState);
    if (applied) await tx.unsafe(DDL);
    const afterState = await state(tx);
    validate(afterState);
    if (!ready(afterState)) throw new Error('Withdrawal replay postflight not ready');
    const after = await fingerprint(tx);
    if (before.rows !== after.rows || before.sha256 !== after.sha256) throw new Error('Withdrawal replay business fingerprint changed');
    return { migration: '0130-user-withdrawal-replay', applied, ready: true, before, after };
  });
}
