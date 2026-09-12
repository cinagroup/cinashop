import type postgres from 'postgres';
import type { DbClient } from '../lib/di';
import { createHash } from 'node:crypto';
import { auditReleasePrerequisiteCatalog, type ReleasePrerequisiteCatalog } from './auditReleasePrerequisiteCatalog';
import { PINK_RECOVERY_INDEX_SQL } from './pinkRecoveryIndex';
import { FOREIGN_KEY_CHILD_INDEX_SQL } from './foreignKeyChildIndexes';
import { WORK_CONTACT_CLIENT_INDEX_SQL } from './workContactClientIndex';
import { BARGAIN_CART_PARTICIPATION_SQL } from './bargainCartParticipation';
import { BROKERAGE_PAID_ORDER_FENCE_SQL, BROKERAGE_PAID_ORDER_FENCE_BODY } from './brokeragePaidOrderFence';
import { COUPON_PRODUCT_SCOPE_FENCE_SQL, COUPON_PRODUCT_SCOPE_FENCE_BODY } from './couponProductScopeFence';

// Existing, independently tested additive contracts only. No runAll, historical
// seed, row repair, reset, GRANT/REVOKE, or user-selectable SQL/schema.
const TABLES = ['payment_reconciliation_case','store_cart','store_coupon_issue','store_coupon_product',
  'store_order','store_order_refund','store_product_reply','user','work_contact_action_outbox'] as const;
const STEPS = [PINK_RECOVERY_INDEX_SQL,FOREIGN_KEY_CHILD_INDEX_SQL,WORK_CONTACT_CLIENT_INDEX_SQL,
  BARGAIN_CART_PARTICIPATION_SQL,BROKERAGE_PAID_ORDER_FENCE_SQL,COUPON_PRODUCT_SCOPE_FENCE_SQL];
function ready(c: ReleasePrerequisiteCatalog, includePaidFence: boolean) {
  return c.indexes.every(i=>i.exists && i.valid && i.ready && !i.truncated)
    && c.columns.some(a=>a.table==='store_cart' && a.name==='bargain_user_id' && a.exists && a.type==='integer'
      && a.notNull && a.defaultHash===createHash('md5').update('0').digest('hex'))
    && c.constraints.some(a=>a.name==='sc_bargain_participation_ck' && a.validated
      && a.definition==='CHECK (((bargain_user_id >= 0) AND ((type = 2) OR (bargain_user_id = 0))))')
    && c.functions.length===2 && c.functions.filter(f=>includePaidFence || f.name!=='brokerage_paid_order_fence_0150').every(f=>f.exists && !f.securityDefiner && f.sourceHash===createHash('md5')
      .update(f.name==='brokerage_paid_order_fence_0150' ? BROKERAGE_PAID_ORDER_FENCE_BODY : COUPON_PRODUCT_SCOPE_FENCE_BODY).digest('hex'))
    && c.triggers.length===6 && c.triggers.filter(t=>includePaidFence || t.table!=='store_order').every(t=>t.exists && t.enabled==='O' && !t.truncated);
}
async function configure(tx: postgres.TransactionSql) {
  await tx`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`;
}
async function baseSupported(tx: postgres.TransactionSql) {
  const [s]=await tx<{ ok:boolean }[]>`SELECT (SELECT count(*)=9 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY(${[...TABLES]}::text[]) AND c.relkind='r' AND c.relpersistence='p'
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    AND current_setting('server_version_num')::integer/10000=16 AS ok`;
  return s.ok;
}
async function withinBudget(tx: postgres.TransactionSql) {
  for (const table of TABLES) {
    const [s]=await tx.unsafe<{ rows:number }[]>(`SELECT count(*)::integer AS rows FROM (SELECT 1 FROM public."${table}" LIMIT 10001) b`);
    if (s.rows>10000) return false;
  }
  return true;
}
async function fingerprint(tx: postgres.TransactionSql) {
  const tables: { table:string;rows:number;sha256:string }[]=[];
  for (const table of TABLES) {
    const normalize=table==='store_cart' ? " || jsonb_build_object('bargain_user_id',COALESCE(to_jsonb(t)->'bargain_user_id','0'::jsonb))" : '';
    const [s]=await tx.unsafe<{ rows:number;sha256:string }[]>(`SELECT count(*)::integer AS rows,
      encode(sha256(convert_to(COALESCE(string_agg(h,'' ORDER BY h),''),'UTF8')),'hex') AS sha256
      FROM (SELECT encode(sha256(convert_to((to_jsonb(t)${normalize})::text,'UTF8')),'hex') AS h FROM public."${table}" t) hashes`);
    tables.push({ table,...s });
  }
  return { rows:tables.reduce((n,t)=>n+t.rows,0),sha256:createHash('sha256').update(JSON.stringify(tables)).digest('hex'),tables };
}
export async function inspectTestReleaseSchemaUpgrade(db: Pick<DbClient,'$client'>, includePaidFence=true) {
  if (!db.$client) throw new Error('Root database required');
  const catalog=await auditReleasePrerequisiteCatalog(db);
  return db.$client.begin('isolation level repeatable read read only',async tx=>{
    await configure(tx);
    const supported=await baseSupported(tx);
    const budget=supported && await withinBudget(tx);
    const [diagnostics]=supported ? await tx`SELECT
      (SELECT count(*)::integer FROM public.store_order o LEFT JOIN public."user" u ON u.uid=o.uid
        WHERE o.uid>0 AND o.pid<>-1 AND o.paid=1 AND o.is_del=0 AND o.refund_status IN (0,3) AND o.pay_price<>0 AND u.uid IS NULL) AS dangling_paid_users,
      (SELECT count(*)::integer FROM public.store_coupon_product r LEFT JOIN public.store_coupon_issue t ON t.id=r.coupon_id WHERE t.id IS NULL) AS dangling_coupon_templates,
      (SELECT jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull)
        ORDER BY c.relname,a.attname) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
        AND ((c.relname='store_order_refund' AND a.attname IN ('id','add_time','is_cancel','is_del','apply_type','refund_type','refund_reason','refund_explain','order_id'))
          OR (c.relname='payment_reconciliation_case' AND a.attname='callback_event_id')
          OR (c.relname='store_product_reply' AND a.attname='order_cart_info_id')
          OR (c.relname='work_contact_action_outbox' AND a.attname IN ('corp_id','client_id'))
          OR (c.relname='store_cart' AND a.attname='type')
          OR (c.relname='store_order' AND a.attname IN ('uid','pid','paid','is_del','refund_status','pay_price')))) AS operand_columns` : [];
    return { supported,ready:supported && ready(catalog,includePaidFence),withinBudget:budget,catalog,excluded:includePaidFence ? [] : ['0150-brokerage-paid-order-fence'],diagnostics:diagnostics ?? null,fingerprint:budget ? await fingerprint(tx) : null };
  });
}
export async function runTestReleaseSchemaUpgrade(db: Pick<DbClient,'$client'>, includePaidFence=true) {
  if (!db.$client) throw new Error('Root database required');
  return db.$client.begin('isolation level read committed',async tx=>{
    await configure(tx);
    if (!await baseSupported(tx)) throw new Error('Test release schema prerequisite drift');
    await tx.unsafe(`LOCK TABLE ${TABLES.map(t=>`ONLY public."${t}"`).join(',')} IN ACCESS EXCLUSIVE MODE NOWAIT`);
    if (!await baseSupported(tx) || !await withinBudget(tx)) throw new Error('Test release schema target or row budget unsupported');
    const before=await fingerprint(tx);
    const [count]=await tx<{ n:number }[]>`SELECT (
      (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
        AND c.relname IN ('sor_pink_recovery_scan','prc_callback_event','spr_order_cart_info','wcao_client_ref'))
      +(SELECT count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.store_cart'::regclass AND a.attname='bargain_user_id' AND NOT a.attisdropped)
      +(SELECT count(*) FROM pg_catalog.pg_constraint WHERE conrelid='public.store_cart'::regclass AND conname='sc_bargain_participation_ck')
      +(SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.pronargs=0
        AND p.proname IN ('brokerage_paid_order_fence_0150','coupon_product_scope_fence_0151') AND (${includePaidFence} OR p.proname='coupon_product_scope_fence_0151'))
      +(SELECT count(*) FROM pg_catalog.pg_trigger WHERE (${includePaidFence} AND tgrelid='public.store_order'::regclass AND tgname IN ('brokerage_paid_insert_0150','brokerage_paid_update_0150','brokerage_paid_delete_0150'))
        OR (tgrelid='public.store_coupon_product'::regclass AND tgname IN ('coupon_product_insert_0151','coupon_product_update_0151','coupon_product_delete_0151')))
      )::integer AS n`;
    // Every existing contract validates exact metadata even on its no-op path.
    for (const [index,step] of STEPS.entries()) {
      if (includePaidFence || index!==4) await tx.unsafe(step);
    }
    const after=await fingerprint(tx);
    if (JSON.stringify(before)!==JSON.stringify(after)) throw new Error('Test release schema business fingerprint changed');
    return { migration:includePaidFence ? '0146-0151-test-release-schema' : '0146-0149-0151-test-release-core-schema',
      excluded:includePaidFence ? [] : ['0150-brokerage-paid-order-fence'],applied:count.n!==(includePaidFence ? 14 : 10),ready:true,before,after };
  });
}
