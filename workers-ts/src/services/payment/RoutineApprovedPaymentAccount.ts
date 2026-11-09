import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { inspectRoutinePaymentAccountPolicyCatalog, assertRoutinePaymentAccountPolicyInstalledTx,
  assertRoutinePaymentAccountPolicyReadInTx, ROUTINE_PAYMENT_ACCOUNT_POLICY_GATE } from '@/migrations/routinePaymentAccountPolicy';
import { assertRoutineRefundReadInTx,assertRoutineRefundStatusReadTx, inspectRoutineRefundCatalog } from '@/migrations/routineRefund';
import { assertRoutineShippingReadTx, inspectRoutineShippingCatalog } from '@/migrations/routineShipping';
import { assertRoutineSubscriptionReadTx, inspectRoutineSubscriptionCatalog } from '@/migrations/routineSubscription';
import { assertRechargeRefundRuntimeTx, inspectRechargeRefundCatalog } from '@/migrations/rechargeRefund';
import type { RechargeRefundRuntimeRole } from '@/migrations/rechargeRefundContract';
import { inspectRoutineOriginalPaymentEvidenceCatalog } from '@/migrations/routineOriginalPaymentEvidence';
import type { RoutinePaymentRuntimeTarget } from '@/migrations/routinePaymentRuntime';
import { ServiceUnavailableException } from '@/utils/errors';
import { routineEvidenceCanonical, routineEvidenceHmac, parseRoutineProviderObservation } from './RoutineProviderObservation';
import type { PaymentProviderQueryRequest } from './PaymentProviderQuery';
import { parseRoutineOriginalEvidence, type RoutineOriginalEvidence } from './RoutineOriginalPaymentEvidence';

import { parseRoutineApprovedAccountPolicy as account, parseRoutineApprovedQueryPlan as query,
  parseRoutineApprovedAccountJournal as journal, parseRoutineApprovedAuthorization as authorization,
  parseRoutineApprovedUse as use, validateRoutineApprovedAccountHistory,
  type RoutineApprovedScope as Scope, type RoutineApprovedPurpose as Purpose, type RoutineApprovedAccountJournal as Journal,
  type RoutineApprovedAuthorization as Authorization, type RoutineApprovedUse as Use,
  type RoutineAccountPolicy, type RoutineAccountQueryPlan } from './RoutineApprovedPaymentEvidenceCodec';
export type { RoutineAccountPolicy, RoutineAccountQueryPlan } from './RoutineApprovedPaymentEvidenceCodec';

type Signing = Pick<Env, 'APP_KEY'>;
type Runtime = Pick<Env, 'APP_KEY' | 'ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS'>;
export interface RoutineMerchantMaterials {
  ref: string; version: number; appId: string; merchantId: string; serialNo: string;
  apiV3Key: string; privateKey: string; platformPublicKey: string; platformPublicKeyId: string;
}
type Prepared = { readonly account: Journal; readonly query: Journal | null; readonly purpose: Purpose };
const materialsSlot = Symbol('routine.approved.merchant-materials.v1');
const authorizationSlot = Symbol('routine.approved.provider-authorization.v1');
const preparedSlot = Symbol('routine.approved.use-transaction.v1');
type PreparedUse = { authorization: Authorization; readonly [preparedSlot]: DbClient };
const fail = (): never => { throw new ServiceUnavailableException('原账号批准、凭据或查证范围未完整就绪，请维护后重试'); };
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const token = (v: unknown, n = 64): v is string => typeof v === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${n}}$`, 'u').test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const mac = (env: Signing, domain: string, value: unknown) => routineEvidenceHmac(env, 'approved-account-' + domain, value);
const same = (a: unknown, b: unknown) => routineEvidenceCanonical(a) === routineEvidenceCanonical(b);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) if ('value' in d) freeze(d.value);
    Object.freeze(value);
  }
  return value;
}
function equal(a: unknown, b: string) {
  return hex(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail();
  const ds = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(v).length !== keys.length || keys.some(k => !Object.hasOwn(ds, k))
    || Object.entries(ds).some(([k, d]) => !keys.includes(k) || !d.enumerable || !('value' in d))) return fail();
  return v as Record<string, unknown>;
}
function registry(env: Runtime): RoutineMerchantMaterials[] {
  const text = env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 524288) return fail();
  let value: unknown; try { value = JSON.parse(text); } catch { return fail(); }
  const r = object(value, ['format','credentials']);
  if (r.format !== 1 || !Array.isArray(r.credentials) || !r.credentials.length || r.credentials.length > 16) return fail();
  const result = r.credentials.map(value => {
    const c = object(value, ['ref','version','appId','merchantId','serialNo','apiV3Key','privateKey','platformPublicKey','platformPublicKeyId']);
    if (!token(c.ref) || !integer(c.version) || !token(c.appId, 32) || typeof c.merchantId !== 'string' || !/^[0-9]{1,32}$/u.test(c.merchantId)
      || typeof c.serialNo !== 'string' || !/^[A-Fa-f0-9]{1,64}$/u.test(c.serialNo)
      || typeof c.apiV3Key !== 'string' || Buffer.byteLength(c.apiV3Key, 'utf8') !== 32
      || typeof c.privateKey !== 'string' || c.privateKey.length > 8192 || !c.privateKey.includes('PRIVATE KEY-----')
      || typeof c.platformPublicKey !== 'string' || c.platformPublicKey.length > 8192 || !c.platformPublicKey.includes('BEGIN PUBLIC KEY')
      || typeof c.platformPublicKeyId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(c.platformPublicKeyId)) return fail();
    return { ...c } as unknown as RoutineMerchantMaterials;
  });
  if (new Set(result.map(c => `${c.ref}:${c.version}`)).size !== result.length) return fail();
  return result;
}
function resolve(env: Runtime, ref: string, version: number) {
  const materials = registry(env).find(c => c.ref === ref && c.version === version);
  if (!materials) return fail();
  return Object.freeze(materials);
}
/** Maintenance can inspect this public commitment; it is not an approval and
 * never returns merchant secrets. Every material byte and ref version binds. */
export function routinePaymentCredentialCommitment(env: Runtime, ref: string, version: number) {
  if (!token(ref) || !integer(version)) return fail();
  const m = resolve(env, ref, version);
  return Object.freeze({ appId: m.appId, merchantId: m.merchantId, credentialStamp: mac(env, 'materials', m) });
}
/** Pure closed-registry lookup plus all-material commitment equality. This is
 * not account approval, original identity, a dispatch claim or provider authority. */
export function routineCommittedMerchantMaterials(env:Runtime,expected:{appId:string;merchantId:string;
 credentialRef:string;credentialVersion:number;credentialStamp:string}):Readonly<RoutineMerchantMaterials> {
 env={APP_KEY:env.APP_KEY,ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS};
 const r=object(expected,['appId','merchantId','credentialRef','credentialVersion','credentialStamp']);
 if(!token(r.appId,32)||typeof r.merchantId!=='string'||!/^[0-9]{1,32}$/u.test(r.merchantId)
  ||!token(r.credentialRef)||!integer(r.credentialVersion)||!hex(r.credentialStamp))return fail();
 const materials=resolve(env,r.credentialRef,r.credentialVersion);
 if(materials.appId!==r.appId||materials.merchantId!==r.merchantId||!equal(r.credentialStamp,mac(env,'materials',materials)))return fail();
 return materials;
}
async function scope(tx: DbClient): Promise<Scope> {
  const [r] = await tx.execute<Scope>(sql`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS "databaseOid",
    pg_catalog.pg_get_userbyid(c.relowner) AS maintenance,c.relowner::text AS "maintenanceOid"
    FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.routine_payment_account_policy')`);
  if (!r || !token(r.database, 128) || !token(r.maintenance, 128) || !/^[0-9]+$/u.test(r.databaseOid) || !/^[0-9]+$/u.test(r.maintenanceOid)) return fail();
  return r;
}
const querySubject = (env: Signing, orderNo: string) => mac(env,'query-subject',['wechat','routine',orderNo]);
async function history(tx: DbClient, env: Signing, kind: Journal['kind'], subjectId: string, s: Scope): Promise<Journal[]> {
  const rows = await tx.execute(sql`SELECT * FROM public.routine_payment_account_policy
    WHERE kind=${kind} AND subject_id=${subjectId} ORDER BY revision LIMIT 65`);
  if (rows.length > 64 || Buffer.byteLength(JSON.stringify(rows),'utf8') > 1048576) return fail();
  const decoded = Array.from(rows, r => journal(env,r,s));
  validateRoutineApprovedAccountHistory(decoded,kind,subjectId);
  return decoded;
}
async function clock(tx: DbClient) {
  const [r] = await tx.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now`);
  if (!integer(Number(r?.now))) return fail();
  return Number(r.now);
}
function active(value: RoutineAccountPolicy | RoutineAccountQueryPlan, now: number) {
  if (value.state !== 'active' || now < value.validFrom || now >= value.validUntil) return fail();
}
function approved(row: Journal, purpose: Purpose, now: number) {
  if (row.kind !== 'account') return fail();
  const a = row.payload.data as RoutineAccountPolicy; active(a,now);
  if (!a.purposes.includes(purpose)) return fail();
  return a;
}
function prepare(env: Runtime, a: Journal, q: Journal | null, purpose: Purpose, now: number): Prepared {
  const p = approved(a,purpose,now), m = resolve(env,p.credentialRef,p.credentialVersion);
  if (m.appId !== p.appId || m.merchantId !== p.merchantId || !equal(p.credentialStamp,mac(env,'materials',m))) return fail();
  const result = {account:a,query:q,purpose};
  Object.defineProperty(result,materialsSlot,{value:m,enumerable:false});
  return Object.freeze(result);
}
export function routineApprovedAccountMaterials(p: Prepared): Readonly<RoutineMerchantMaterials> {
  const d = Object.getOwnPropertyDescriptor(p,materialsSlot);
  if (!d || !('value' in d)) return fail();
  return d.value as Readonly<RoutineMerchantMaterials>;
}
export async function prepareApprovedRoutineQuery(container: Container, env: Runtime, raw: PaymentProviderQueryRequest): Promise<Prepared|null> {
  // The default reconciler passes its wider leased case object. Only these
  // six provider-request primitives are the approved operation, never lease,
  // attempt or bookkeeping fields from that structurally compatible caller.
  const captured: PaymentProviderQueryRequest = {provider:raw.provider,profile:raw.profile,orderDomain:raw.orderDomain,
    orderNo:raw.orderNo,expectedAmountCents:raw.expectedAmountCents,currency:raw.currency};
  if (captured.profile !== 'routine' || captured.provider !== 'wechat' || /^xx[0-9a-f]{30}$/u.test(captured.orderNo)) return null;
  return withTx(container,async tx => {
    if (!await assertRoutinePaymentAccountPolicyInstalledTx(tx)) return null;
    const s=await scope(tx), rows=await history(tx,env,'query',querySubject(env,captured.orderNo),s), q=rows.at(-1);
    if (!q) return null;
    const plan=q.payload.data as RoutineAccountQueryPlan, now=await clock(tx); active(plan,now);
    if (!same(plan.request,captured)) return fail();
    const a=(await history(tx,env,'account',plan.accountId,s)).at(-1);
    if (!a || a.revision!==plan.accountRevision) return fail();
    return prepare(env,a,q,'query',now);
  });
}
export async function prepareApprovedRoutineNotify(container: Container, env: Runtime, accountId: string): Promise<Prepared> {
  if (!token(accountId)) return fail();
  return withTx(container,async tx => {
    if (!await assertRoutinePaymentAccountPolicyInstalledTx(tx)) return fail();
    const a=(await history(tx,env,'account',accountId,await scope(tx))).at(-1);
    if (!a) return fail();
    return prepare(env,a,null,'notify',await clock(tx));
  });
}
async function recheck(tx: DbClient, env: Runtime, p: Prepared) {
  if (!await assertRoutinePaymentAccountPolicyInstalledTx(tx)) return fail();
  const s=await scope(tx), a=(await history(tx,env,'account',p.account.subject_id,s)).at(-1), now=await clock(tx);
  if (!a || !same(a,p.account)) return fail();
  if (p.query) {
    const q=(await history(tx,env,'query',p.query.subject_id,s)).at(-1);
    if (!q || !same(q,p.query)) return fail();
    const plan=q.payload.data as RoutineAccountQueryPlan; active(plan,now);
    if (plan.accountId!==a.subject_id || plan.accountRevision!==a.revision) return fail();
  }
  return prepare(env,a,p.query,p.purpose,now);
}
export async function assertPreparedRoutineAccount(container: Container, env: Runtime, p: Prepared) {
  await withTx(container,tx=>recheck(tx,env,p));
}
export function attachRoutinePaymentAccountAuthorization<T extends object>(target: T, env: Signing, p: Prepared, value: unknown): T {
  const observation=parseRoutineProviderObservation(env,value), a=p.account.payload.data as RoutineAccountPolicy;
  if (observation.facts.appId!==a.appId || observation.facts.merchantId!==a.merchantId
    || observation.source!==(p.purpose==='query'?'signed_query':'callback')) return fail();
  if (p.query && (p.query.payload.data as RoutineAccountQueryPlan).request.orderNo!==observation.facts.orderNo) return fail();
  const body={format:1 as const,purpose:'routine_approved_provider' as const,account:p.account,query:p.query,observation,issuedAt:Math.floor(Date.now()/1000)};
  Object.defineProperty(target,authorizationSlot,{value:freeze({...body,signature:mac(env,'authorization',body)}),enumerable:false});
  return target;
}
export function routinePaymentAccountAuthorizationOf(target: object): unknown {
  const d=Object.getOwnPropertyDescriptor(target,authorizationSlot); return d && 'value' in d ? d.value : undefined;
}
export function snapshotRoutinePaymentAccountAuthorization(env: Signing, value: unknown): unknown {
  if (value === undefined) return undefined;
  const r=object(value,['format','purpose','account','query','observation','issuedAt','signature']);
  const row=object(r.account,['record_id','kind','subject_id','revision','payload','created_at','signature']);
  const payload=object(row.payload,['format','scope','previousRecordId','data']);
  const s=object(payload.scope,['database','databaseOid','maintenance','maintenanceOid']);
  if (Object.values(s).some(v=>typeof v!=='string')) return fail();
  return authorization(env,value,s as Scope);
}
/** Acquire the account gate BEFORE physical-order/registration locks. This
 * fresh ingress check holds until evidence, use and event commit together. */
export async function prepareRoutineApprovedUseTx(tx: DbClient, env: Runtime, raw: unknown, proof: unknown,
  expectedQuery?: PaymentProviderQueryRequest): Promise<PreparedUse|null> {
  if (raw===undefined) return null;
  if (!await assertRoutinePaymentAccountPolicyInstalledTx(tx)) return fail();
  const a=authorization(env,raw,await scope(tx)), observation=parseRoutineProviderObservation(env,proof), now=await clock(tx);
  if (!same(a.observation,observation) || now<a.issuedAt-60 || now>a.issuedAt+900) return fail();
  if (a.query && expectedQuery && !same((a.query.payload.data as RoutineAccountQueryPlan).request,expectedQuery)) return fail();
  await recheck(tx,env,{account:a.account,query:a.query,purpose:observation.source==='callback'?'notify':'query'});
  return Object.freeze({[preparedSlot]:tx,authorization:a});
}
function scopeMatches(a: Authorization, original: RoutineOriginalEvidence): boolean {
  if (!a.query) return true;
  const plan=a.query.payload.data as RoutineAccountQueryPlan, binding=original.payload.binding;
  return binding.state==='bound' && binding.local.domain===plan.request.orderDomain
    && binding.local.amountCents===plan.request.expectedAmountCents;
}
export async function appendRoutineApprovedUseTx(tx: DbClient, env: Runtime, prepared: PreparedUse|null, original: RoutineOriginalEvidence) {
  if (!prepared) return {scopeMatches:true};
  if (prepared[preparedSlot]!==tx) return fail();
  const a=prepared.authorization, key=mac(env,'use-key',[original.evidence_id,a.account.record_id,a.query?.record_id??'']);
  const payload={format:1 as const,evidenceSignature:original.signature,scopeMatches:scopeMatches(a,original),authorization:a}, created_at=await clock(tx);
  const body={use_id:key,evidence_id:original.evidence_id,payload,created_at};
  // The account shared gate was obtained before the order locks; never take
  // it backwards here. Check the deadline again, not another current-policy read.
  if (created_at<a.issuedAt-60 || created_at>a.issuedAt+900) return fail();
  await tx.execute(sql`INSERT INTO public.routine_payment_account_use(use_id,evidence_id,payload,created_at,signature)
    VALUES(${key},${original.evidence_id},${JSON.stringify(payload)}::text::jsonb,${created_at},${mac(env,'use-record',body)}) ON CONFLICT DO NOTHING`);
  const [saved]=await tx.execute(sql`SELECT * FROM public.routine_payment_account_use WHERE use_id=${key}`);
  return {scopeMatches:use(env,saved,await scope(tx),original).payload.scopeMatches};
}
export async function assertRoutineApprovedUseDeadlineTx(tx: DbClient, prepared: PreparedUse|null) {
  if (!prepared) return;
  if (prepared[preparedSlot]!==tx) return fail();
  const a=prepared.authorization, now=await clock(tx);
  approved(a.account,a.observation.source==='callback'?'notify':'query',now);
  if (a.query) active(a.query.payload.data as RoutineAccountQueryPlan,now);
  const [deadline]=await tx.execute(sql`SELECT clock_timestamp()<=transaction_timestamp()+interval '5 seconds' AS ready`);
  if (now<a.issuedAt-60 || now>a.issuedAt+900 || deadline?.ready!==true) return fail();
}
/** Settlement already owns the business order. Validate durable provenance
 * without a backwards account gate or treating later revocation as a reversal
 * of an accepted payment. Pre-addon/current verifier evidence stays v1. */
export async function assertRoutineApprovedUseTx(tx: DbClient, env: Signing, original: RoutineOriginalEvidence) {
  if (!await assertRoutinePaymentAccountPolicyReadInTx(tx)) return;
  const s=await scope(tx), rows=await tx.execute(sql`SELECT * FROM public.routine_payment_account_use WHERE evidence_id=${original.evidence_id} ORDER BY use_id LIMIT 65`);
  if (rows.length>64 || Buffer.byteLength(JSON.stringify(rows),'utf8')>1048576) return fail();
  for (const raw of rows) {
    const u=use(env,raw,s,original);
    if (!u.payload.scopeMatches) return fail();
    for (const policy of [u.payload.authorization.account,u.payload.authorization.query].filter((v):v is Journal=>!!v)) {
      const [row]=await tx.execute(sql`SELECT * FROM public.routine_payment_account_policy WHERE record_id=${policy.record_id}::uuid`);
      if (!same(journal(env,row,s),policy)) return fail();
    }
  }
}

/** Purpose-specific durable payment provenance reader for real Routine refund
 * App/Financial transactions. It does not broaden the App-only payment guard,
 * read current approval/registry, or authorize any provider operation. All
 * related originals can be checked in one bounded source read, without a gate. */
export async function readRoutineApprovedUsesForRefundTx(tx:DbClient,env:Signing,
 original:RoutineOriginalEvidence|readonly RoutineOriginalEvidence[],statusRead=false) {
 return readRoutineApprovedConsumerUsesTx(tx,env,original,'refund',statusRead);
}
/** App-only shipping provenance, without refund commissioning, a fresh payment
 * gate, current policy or merchant secrets. Called after physical source locks. */
export async function readRoutineApprovedUsesForShippingTx(tx:DbClient,env:Signing,
 original:RoutineOriginalEvidence|readonly RoutineOriginalEvidence[]) {
 return readRoutineApprovedConsumerUsesTx(tx,env,original,'shipping',false);
}
/** App-only subscription source provenance. Historical payment query/notify
 * approval explains an original SUCCESS; it grants no subscription_send,
 * template, receiver, token or provider authority. No fresh lock is acquired. */
export async function readRoutineApprovedUsesForSubscriptionTx(tx:DbClient,env:Signing,
 original:RoutineOriginalEvidence|readonly RoutineOriginalEvidence[]) {
 return readRoutineApprovedConsumerUsesTx(tx,env,original,'subscription',false);
}
/** Recharge financial provenance has its own SQL commissioning. It neither
 * requires physical-goods refund commissioning nor grants refund transport. */
export async function readRoutineApprovedUsesForRechargeRefundTx(tx:DbClient,env:Signing,
 original:RoutineOriginalEvidence|readonly RoutineOriginalEvidence[],role:RechargeRefundRuntimeRole,readOnly=false) {
 return readRoutineApprovedConsumerUsesTx(tx,env,original,'recharge-refund',readOnly,role);
}
async function readRoutineApprovedConsumerUsesTx(tx:DbClient,env:Signing,
 original:RoutineOriginalEvidence|readonly RoutineOriginalEvidence[],consumer:'refund'|'shipping'|'subscription'|'recharge-refund',statusRead:boolean,
 rechargeRole?:RechargeRefundRuntimeRole) {
 env={APP_KEY:env.APP_KEY};
 const originals=(Array.isArray(original)?original:[original]).map(row=>parseRoutineOriginalEvidence(env,row));
 if(!originals.length||originals.length>64||new Set(originals.map(row=>row.evidence_id)).size!==originals.length)return fail();
 if(!await(consumer==='recharge-refund'?assertRechargeRefundRuntimeTx(tx,rechargeRole!,statusRead?'read':'write')
  :consumer==='shipping'?assertRoutineShippingReadTx(tx):consumer==='subscription'?assertRoutineSubscriptionReadTx(tx)
  :statusRead?assertRoutineRefundStatusReadTx(tx):assertRoutineRefundReadInTx(tx)))return fail();
 const consumerCatalog=await(consumer==='recharge-refund'?inspectRechargeRefundCatalog(tx):consumer==='shipping'?inspectRoutineShippingCatalog(tx):consumer==='subscription'
  ?inspectRoutineSubscriptionCatalog(tx):inspectRoutineRefundCatalog(tx)),binding=consumerCatalog.binding;
 const catalog=await inspectRoutinePaymentAccountPolicyCatalog(tx),source=await inspectRoutineOriginalPaymentEvidenceCatalog(tx);
 if(!(consumer==='recharge-refund'?'commissioned'in consumerCatalog&&consumerCatalog.commissioned:'ready'in consumerCatalog&&consumerCatalog.ready)
  ||!binding?.app||!catalog.ready||!source.ready||catalog.binding?.maintenanceOid!==binding.maintenanceOid
  ||source.binding?.maintenanceOid!==binding.maintenanceOid||catalog.binding?.appOid!==binding.appOid||source.binding?.appOid!==binding.appOid)return fail();
 if((consumer==='subscription'||consumer==='recharge-refund')&&(!binding.appOid||catalog.binding?.maintenance!==binding.maintenance
  ||source.binding?.maintenance!==binding.maintenance||catalog.binding?.app!==binding.app||source.binding?.app!==binding.app))return fail();
 const [resolution]=await tx.execute<{ready:boolean}>(sql`SELECT
  pg_catalog.to_regclass('routine_original_payment_evidence')=pg_catalog.to_regclass('public.routine_original_payment_evidence')
  AND pg_catalog.to_regclass('routine_payment_account_policy')=pg_catalog.to_regclass('public.routine_payment_account_policy')
  AND pg_catalog.to_regclass('routine_payment_account_use')=pg_catalog.to_regclass('public.routine_payment_account_use') AS ready`);
 if(resolution?.ready!==true)return fail();
 const s=await scope(tx),rows=await tx.execute(sql`SELECT * FROM public.routine_payment_account_use
  WHERE evidence_id IN (${sql.join(originals.map(row=>sql`${row.evidence_id}`),sql`,`)}) ORDER BY evidence_id,use_id LIMIT 65`);
 if(rows.length>64||Buffer.byteLength(JSON.stringify(rows),'utf8')>1048576)return fail();
 const decoded:Use[]=[];
 const policies=new Map<string,Journal>();
 for(const raw of rows) {
  const match=originals.find(row=>row.evidence_id===raw.evidence_id);if(!match)return fail();
  const u=use(env,raw,s,match);if(!u.payload.scopeMatches)return fail();
  for(const policy of[u.payload.authorization.account,u.payload.authorization.query].filter((v):v is Journal=>!!v)) {
   let saved=policies.get(policy.record_id);
   if(!saved){const[row]=await tx.execute(sql`SELECT * FROM public.routine_payment_account_policy WHERE record_id=${policy.record_id}::uuid`);
    saved=journal(env,row,s);policies.set(policy.record_id,saved);}
   if(!same(saved,policy))return fail();
  }
  decoded.push(u);
 }
 return freeze({uses:decoded,digest:routineEvidenceHmac(env,consumer==='shipping'?'shipping-approved-use-set'
  :consumer==='subscription'?'subscription-approved-use-set':consumer==='recharge-refund'?'recharge-refund-approved-use-set':'refund-approved-use-set',decoded)});
}

/** Explicit owner-only maintenance API. No HTTP route, config adoption, role
 * creation, credential provisioning, identity or historical order mutation. */
export async function appendRoutinePaymentAccountPolicy(db: DbClient, env: Runtime,
  declared: Pick<RoutinePaymentRuntimeTarget,'database'|'maintenance'|'app'|'admin'>,
  input: { operationId: string; expectedRevision: number; kind: 'account'; data: RoutineAccountPolicy }
    | { operationId: string; expectedRevision: number; kind: 'query'; data: RoutineAccountQueryPlan }) {
  env={APP_KEY:env.APP_KEY,ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS};
  const r=object(input,['operationId','expectedRevision','kind','data']), target={database:declared.database,maintenance:declared.maintenance,app:declared.app,admin:declared.admin};
  if (!uuid(r.operationId) || !Number.isSafeInteger(r.expectedRevision) || Number(r.expectedRevision)<0 || Number(r.expectedRevision)>=64
    || r.kind!=='account' && r.kind!=='query' || Object.values(target).some(v=>!token(v,128))) return fail();
  const data=r.kind==='account'?account(r.data):query(r.data), kind=r.kind, operationId=r.operationId, expectedRevision=Number(r.expectedRevision);
  const subject=kind==='account'?(data as RoutineAccountPolicy).accountId:querySubject(env,(data as RoutineAccountQueryPlan).request.orderNo);
  return withTx(createContainerFromDb(db),async tx=>{
    await tx.execute(sql`SELECT
      set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
      set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
      set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
    const [identity]=await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
      AND current_user=session_user AND r.rolsuper AND r.rolcanlogin AND current_schema()='public'
      AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid())
      AND current_setting('server_version_num')::integer/10000=16 AND current_setting('transaction_isolation')='read committed'
      AND current_setting('transaction_read_only')='off' AND current_setting('session_replication_role')='origin' AS ready
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if (identity?.ready!==true) return fail();
    const [gate]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${ROUTINE_PAYMENT_ACCOUNT_POLICY_GATE[0]},${ROUTINE_PAYMENT_ACCOUNT_POLICY_GATE[1]}) AS locked`);
    if (gate?.locked!==true) return fail();
    const catalog=await inspectRoutinePaymentAccountPolicyCatalog(tx,target);
    if (!catalog.ready) return fail();
    const s=await scope(tx), rows=await history(tx,env,kind,subject,s), replay=rows.find(v=>v.record_id===operationId);
    if (replay) {
      if (replay.revision!==expectedRevision+1 || !same(replay.payload.data,data)) return fail();
      return {recordId:replay.record_id,revision:replay.revision,replayed:true};
    }
    const prior=rows.at(-1), now=await clock(tx);
    if ((prior?.revision??0)!==expectedRevision || now>=data.validUntil && data.state==='active') return fail();
    if (kind==='account' && data.state==='active') {
      const a=data as RoutineAccountPolicy, m=routinePaymentCredentialCommitment(env,a.credentialRef,a.credentialVersion);
      if (a.appId!==m.appId || a.merchantId!==m.merchantId || a.credentialStamp!==m.credentialStamp) return fail();
    }
    if (kind==='query' && data.state==='active') {
      const q=data as RoutineAccountQueryPlan, a=(await history(tx,env,'account',q.accountId,s)).at(-1);
      if (!a || a.revision!==q.accountRevision) return fail();
      prepare(env,a,null,'query',now);
    }
    const body={record_id:operationId,kind,subject_id:subject,revision:expectedRevision+1,
      payload:{format:1 as const,scope:s,previousRecordId:prior?.record_id??'',data},created_at:now};
    await tx.execute(sql`INSERT INTO public.routine_payment_account_policy(record_id,kind,subject_id,revision,payload,created_at,signature)
      VALUES(${operationId}::uuid,${kind},${subject},${body.revision},${JSON.stringify(body.payload)}::text::jsonb,${now},${mac(env,'policy',body)})`);
    const [saved]=await tx.execute(sql`SELECT * FROM public.routine_payment_account_policy WHERE record_id=${operationId}::uuid`);
    if (!same(journal(env,saved,s),{...body,signature:mac(env,'policy',body)})) return fail();
    return {recordId:operationId,revision:body.revision,replayed:false};
  });
}
