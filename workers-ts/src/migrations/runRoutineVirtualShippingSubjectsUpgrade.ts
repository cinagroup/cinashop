import { refundSuccessNoticeCommissionedTx } from './refundSuccessNotice';
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import type { RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { captureRuntimeAppCashierOriginReader, type RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';
import { inspectRoutineVirtualShippingSubjects, routineVirtualShippingSubjectsInstallSql } from './routineVirtualShippingSubjects';

type Query = Pick<DbClient, 'execute'>;
export const ROUTINE_VIRTUAL_SHIPPING_SUBJECTS_UPGRADE = 'routine-virtual-shipping-subjects-v1';

/** Copy bounded data before any asynchronous connection/transaction operation.
 * Accessors, coercion and shared nested arrays cannot change commissioning. */
function snapshot<T>(value: T): T {
  let nodes = 0, bytes = 0;
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 256 || depth > 8) throw Error('Bounded plain virtual-shipping declaration required');
    if (v === null || v === undefined || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      bytes += v.length;
      if (v.length > 1024 || bytes > 65536) throw Error('Bounded virtual-shipping declaration strings required');
      return v;
    }
    if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
    if (!v || typeof v !== 'object' || (Array.isArray(v) ? Object.getPrototypeOf(v) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) throw Error('Primitive virtual-shipping declaration fields required');
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      if (v.length > 32 || keys.length !== v.length + 1 || keys.some(k => typeof k !== 'string'
        || k !== 'length' && (!/^(0|[1-9][0-9]*)$/u.test(k) || Number(k) >= v.length)))
        throw Error('Dense bounded virtual-shipping declaration arrays required');
      return Array.from({ length: v.length }, (_, i) => {
        const d = descriptors[String(i)];
        if (!d?.enumerable || !('value' in d)) throw Error('Plain virtual-shipping declaration array required');
        return copy(d.value, depth + 1);
      });
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const k of keys) {
      if (typeof k !== 'string' || !descriptors[k]?.enumerable || !('value' in descriptors[k]))
        throw Error('Data-only virtual-shipping declaration required');
      result[k] = copy(descriptors[k].value, depth + 1);
    }
    return result;
  };
  return copy(value, 0) as T;
}

function captureDeclaration(value: RoutinePaymentRuntimeTarget, peers?: RuntimeGiftPeerDeclarations,
  appReader?: RuntimeAppCashierOriginReaderAddon) {
  const raw = snapshot({ value, ...(peers === undefined ? {} : { peers }), ...(appReader === undefined ? {} : { appReader }) });
  const v = raw.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Explicit virtual-shipping target required');
  const identity = (n: unknown): string => {
    if (typeof n !== 'string') throw Error('Primitive virtual-shipping identity required');
    pricingIdentifier(n); return n;
  };
  if (v.local !== undefined && (!Array.isArray(v.local) || v.local.length > 16)) throw Error('Bounded virtual-shipping local identities required');
  if (v.caseLock && (!Array.isArray(v.caseLock.runtimeRoles) || !v.caseLock.runtimeRoles.length || v.caseLock.runtimeRoles.length > 16))
    throw Error('Explicit bounded virtual-shipping case-lock identities required');
  // Only declared target fields are returned. Fixture/deployment metadata does
  // not become authority or an echoed arbitrary object.
  const target: RoutinePaymentRuntimeTarget = {
    database: identity(v.database), maintenance: identity(v.maintenance), app: identity(v.app), admin: identity(v.admin),
    ...(v.local === undefined ? {} : { local: v.local.map(identity) }),
    ...(v.caseLock ? { caseLock: { owner: identity(v.caseLock.owner), runtimeRoles: v.caseLock.runtimeRoles.map(identity) } } : {}),
  };
  const identities = [target.maintenance, target.app, target.admin, ...(target.local ?? [])];
  if (new Set(identities).size !== identities.length) throw Error('Distinct virtual-shipping runtime identities required');
  if (target.caseLock && (identities.includes(target.caseLock.owner)
    || new Set(target.caseLock.runtimeRoles).size !== target.caseLock.runtimeRoles.length
    || target.caseLock.runtimeRoles.some(role => !target.local?.includes(role)))) throw Error('Explicit local-only virtual-shipping case lock required');
  const capturedPeers = raw.peers === undefined ? undefined : captureRuntimeGiftPeerDeclarations(raw.peers);
  const capturedReader = raw.appReader === undefined ? undefined : captureRuntimeAppCashierOriginReader(raw.appReader);
  const binding = (t: RoutinePaymentRuntimeTarget) => JSON.stringify([t.database, t.maintenance, t.app, t.admin,
    [...(t.local ?? [])].sort(), t.caseLock ? [t.caseLock.owner, [...t.caseLock.runtimeRoles].sort()] : null]);
  if (capturedPeers && binding(capturedPeers.target) !== binding(target)) throw Error('Virtual shipping peers require the exact declared target');
  return { target, peers: capturedPeers, appReader: capturedReader };
}


async function fingerprint(tx: Query) {
  const result: Array<{table: string; rows: number; sha256: string}> = [];
  for (const table of ['order_notification_delivery','store_order_outbox']) {
    const [budget] = await tx.execute<{rows: number; oversized: boolean}>(sql.raw(`SELECT pg_catalog.count(*)::integer AS rows,
      COALESCE(pg_catalog.bool_or(pg_catalog.pg_column_size(t)>1048576),false) AS oversized
      FROM (SELECT * FROM public.${table} LIMIT 10001) t`));
    if (!budget || budget.rows>10000 || budget.oversized) throw Error('Virtual shipping maintenance row budget exceeded');
    const value = table==='order_notification_delivery'
      ? "pg_catalog.to_jsonb(t)||pg_catalog.jsonb_build_object('subject_domain',COALESCE(pg_catalog.to_jsonb(t)->'subject_domain','null'::jsonb),'subject_id',COALESCE(pg_catalog.to_jsonb(t)->'subject_id','null'::jsonb))"
      : 'pg_catalog.to_jsonb(t)';
    const [row] = await tx.execute<{rows: number; sha256: string}>(sql.raw(`SELECT pg_catalog.count(*)::integer AS rows,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((${value})::text,'UTF8')),'hex'),'' ORDER BY t.id),''),'UTF8')),'hex') AS sha256
      FROM public.${table} t`));
    if (!row) throw Error('Virtual shipping maintenance fingerprint unavailable');
    result.push({table,...row});
  }
  return result;
}

/** This forward changes only structural subjects/events. It creates no paid
 * source, approval, provider fact, Queue message, grant or historical intent. */
export async function runRoutineVirtualShippingSubjectsUpgradeInTransaction(tx: Query, declaredTarget: RoutinePaymentRuntimeTarget,
  declaredPeers?: RuntimeGiftPeerDeclarations, declaredReader?: RuntimeAppCashierOriginReaderAddon) {
  if (Object.hasOwn(tx,'$client')) throw Error('Virtual shipping upgrade requires a caller-owned transaction');
  const {target,peers,appReader}=captureDeclaration(declaredTarget,declaredPeers,declaredReader);
  await tx.execute(sql`SELECT pg_catalog.set_config('search_path','public,pg_temp',true),
    pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [context]=await tx.execute<{ready: boolean}>(sql`SELECT pg_catalog.current_database()=${target.database}
    AND current_user=${target.maintenance} AND current_user=session_user AND pg_catalog.current_schema()='public'
    AND r.rolsuper AND r.rolcanlogin AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
    AND pg_catalog.current_setting('server_version_num')::integer/10000=16
    AND pg_catalog.current_setting('transaction_isolation')='read committed' AND pg_catalog.current_setting('transaction_read_only')='off'
    AND pg_catalog.current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE d.defaclrole=r.oid AND d.defaclnamespace IN(0,'public'::regnamespace) AND d.defaclobjtype IN('r','f','S') AND a.grantee<>d.defaclrole)
    AS ready FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if (context?.ready!==true) throw Error('Virtual shipping upgrade requires actual direct PG16 maintenance LOGIN/database');
  for (const key of [731714,731717,731719,731722]) {
    const [gate]=await tx.execute<{locked: boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${key},0) AS locked`);
    if (gate?.locked!==true) throw Error('Virtual shipping commissioning is busy');
  }
  await tx.execute(sql.raw('LOCK TABLE ONLY public.order_notification_delivery, ONLY public.store_order_outbox IN ACCESS EXCLUSIVE MODE NOWAIT'));
  await tx.execute(sql.raw('LOCK TABLE ONLY public.routine_original_payment_evidence, ONLY public.routine_payment_account_policy, ONLY public.routine_payment_account_use, ONLY public.routine_shipping_account_policy, ONLY public.routine_shipping_dispatch, ONLY public.routine_shipping_provider_evidence, ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  const names={maintenance:target.maintenance,app:target.app,admin:target.admin};
  const before=await inspectRoutineVirtualShippingSubjects(tx,names);
  if (before.failures.length || before.state==='partial' || !before.binding) throw Error('Partial or drifted virtual shipping protocol requires review: '+before.failures.join(','));
  const inspect=async()=>({app:await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,'current',peers,appReader),
    admin:await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,'current',peers)});
  const prior=await inspect();
  if (!prior.app.ready||!prior.admin.ready) throw Error('Virtual shipping commissioning requires exact declared runtime profiles');
  const result=(applied: boolean)=>({operation:ROUTINE_VIRTUAL_SHIPPING_SUBJECTS_UPGRADE,applied,target,
    ...(peers?{peers}:{}),...(appReader?{appReader}:{}),state:before.state==='base15'||before.state==='virtual17'?'virtual17' as const:'virtual16' as const});
  if (before.ready) return result(false);
  const preserved=await fingerprint(tx);
  const comments=await tx.execute<{table_name:string;name:string;comment:string|null;comment_literal:string|null}>(sql`SELECT c.relname AS table_name,k.conname AS name,
    pg_catalog.obj_description(k.oid,'pg_constraint') AS comment,pg_catalog.quote_literal(pg_catalog.obj_description(k.oid,'pg_constraint')) AS comment_literal FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
    WHERE (k.conrelid='public.order_notification_delivery'::regclass AND k.conname='ond_subject_ck')
      OR (k.conrelid='public.store_order_outbox'::regclass AND k.conname='soob_event_type_ck')`);
  if (comments.length!==2||comments.some(r=>r.comment!==null&&(typeof r.comment!=='string'||r.comment.length>4096)))
    throw Error('Virtual shipping constraint comments require review');
  await tx.execute(sql.raw(routineVirtualShippingSubjectsInstallSql(before.state==='base15', await refundSuccessNoticeCommissionedTx(tx))));
  for (const row of comments) if (row.comment!==null)
    await tx.execute(sql.raw(`COMMENT ON CONSTRAINT ${pricingIdentifier(row.name)} ON public.${pricingIdentifier(row.table_name)} IS ${row.comment_literal}`));
  const after=await inspectRoutineVirtualShippingSubjects(tx,names),post=await inspect();
  if (!after.ready||!post.app.ready||!post.admin.ready) {
    const codes=(values:readonly string[])=>values.filter(value=>/^[a-zA-Z0-9_.:-]{1,160}$/u.test(value)).slice(0,24).join(',');
    throw Error('Virtual shipping installed catalog/runtime profiles failed verification: catalog='+codes(after.failures)
      +';app='+codes(post.app.failures)+';admin='+codes(post.admin.failures));
  }
  if (JSON.stringify(preserved)!==JSON.stringify(await fingerprint(tx))) throw Error('Virtual shipping business fingerprint changed');
  return result(true);
}
export const installRoutineVirtualShippingSubjectsUpgradeInTransaction=runRoutineVirtualShippingSubjectsUpgradeInTransaction;
export async function runRoutineVirtualShippingSubjectsUpgrade(db: DbClient,target: RoutinePaymentRuntimeTarget,
  peers?: RuntimeGiftPeerDeclarations,appReader?: RuntimeAppCashierOriginReaderAddon) {
  if (!Object.hasOwn(db,'$client')||!db.$client) throw Error('Virtual shipping upgrade requires a root maintenance connection');
  const captured=captureDeclaration(target,peers,appReader);
  return db.transaction(tx=>runRoutineVirtualShippingSubjectsUpgradeInTransaction(tx,captured.target,captured.peers,captured.appReader),
    {isolationLevel:'read committed',accessMode:'read write'});
}
