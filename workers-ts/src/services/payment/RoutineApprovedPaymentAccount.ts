import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { inspectRoutinePaymentAccountPolicyCatalog, assertRoutinePaymentAccountPolicyInstalledTx,
  assertRoutinePaymentAccountPolicyReadInTx, ROUTINE_PAYMENT_ACCOUNT_POLICY_GATE } from '@/migrations/routinePaymentAccountPolicy';
import type { RoutinePaymentRuntimeTarget } from '@/migrations/routinePaymentRuntime';
import { ServiceUnavailableException } from '@/utils/errors';
import { routineEvidenceCanonical, routineEvidenceHmac, parseRoutineProviderObservation,
  type RoutineProviderObservation } from './RoutineProviderObservation';
import type { PaymentProviderQueryRequest } from './PaymentProviderQuery';
import type { RoutineOriginalEvidence } from './RoutineOriginalPaymentEvidence';

type Signing = Pick<Env, 'APP_KEY'>;
type Runtime = Pick<Env, 'APP_KEY' | 'ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS'>;
type Scope = { database: string; databaseOid: string; maintenance: string; maintenanceOid: string };
type Purpose = 'query' | 'notify';
export interface RoutineMerchantMaterials {
  ref: string; version: number; appId: string; merchantId: string; serialNo: string;
  apiV3Key: string; privateKey: string; platformPublicKey: string; platformPublicKeyId: string;
}
export interface RoutineAccountPolicy {
  accountId: string; state: 'active' | 'revoked'; appId: string; merchantId: string;
  credentialRef: string; credentialVersion: number; credentialStamp: string;
  purposes: Purpose[]; validFrom: number; validUntil: number;
}
export interface RoutineAccountQueryPlan {
  state: 'active' | 'revoked'; accountId: string; accountRevision: number;
  request: PaymentProviderQueryRequest; validFrom: number; validUntil: number;
}
type Journal = { record_id: string; kind: 'account' | 'query'; subject_id: string; revision: number;
  payload: { format: 1; scope: Scope; previousRecordId: string; data: RoutineAccountPolicy | RoutineAccountQueryPlan };
  created_at: number; signature: string };
type Prepared = { readonly account: Journal; readonly query: Journal | null; readonly purpose: Purpose };
type Authorization = { format: 1; purpose: 'routine_approved_provider'; account: Journal; query: Journal | null;
  observation: RoutineProviderObservation; issuedAt: number; signature: string };
type Use = { use_id: string; evidence_id: string; payload: { format: 1; evidenceSignature: string; scopeMatches: boolean; authorization: Authorization };
  created_at: number; signature: string };
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
function interval(r: Record<string, unknown>): {state:'active'|'revoked';validFrom:number;validUntil:number} {
  if (!integer(r.validFrom) || !integer(r.validUntil) || r.validUntil <= r.validFrom
    || r.validUntil - r.validFrom > 366 * 86400 || r.state !== 'active' && r.state !== 'revoked') return fail();
  return { state: r.state, validFrom: r.validFrom, validUntil: r.validUntil };
}
function account(value: unknown): RoutineAccountPolicy {
  const r = object(value, ['accountId','state','appId','merchantId','credentialRef','credentialVersion','credentialStamp','purposes','validFrom','validUntil']);
  const times = interval(r);
  if (!token(r.accountId) || !token(r.appId, 32) || typeof r.merchantId !== 'string' || !/^[0-9]{1,32}$/u.test(r.merchantId)
    || !token(r.credentialRef) || !integer(r.credentialVersion) || !hex(r.credentialStamp) || !Array.isArray(r.purposes)
    || !r.purposes.length || r.purposes.length > 2 || r.purposes.some(p => p !== 'query' && p !== 'notify')
    || new Set(r.purposes).size !== r.purposes.length) return fail();
  return { accountId: r.accountId, ...times, appId: r.appId, merchantId: r.merchantId,
    credentialRef: r.credentialRef, credentialVersion: r.credentialVersion, credentialStamp: r.credentialStamp,
    purposes: [...r.purposes].sort() as Purpose[] };
}
function request(value: unknown): PaymentProviderQueryRequest {
  const r = object(value, ['provider','profile','orderDomain','orderNo','expectedAmountCents','currency']);
  if (r.provider !== 'wechat' || r.profile !== 'routine' || typeof r.orderDomain !== 'string' || !['store_order','recharge','membership'].includes(r.orderDomain)
    || !token(r.orderNo) || r.orderNo.length < 2 || /^xx[0-9a-f]{30}$/u.test(r.orderNo)
    || !integer(r.expectedAmountCents) || r.currency !== 'CNY') return fail();
  return { provider: 'wechat', profile: 'routine', orderDomain: r.orderDomain as PaymentProviderQueryRequest['orderDomain'],
    orderNo: r.orderNo, expectedAmountCents: r.expectedAmountCents, currency: 'CNY' };
}
function query(value: unknown): RoutineAccountQueryPlan {
  const r = object(value, ['state','accountId','accountRevision','request','validFrom','validUntil']), times = interval(r);
  if (!token(r.accountId) || !integer(r.accountRevision)) return fail();
  return { ...times, accountId: r.accountId, accountRevision: r.accountRevision, request: request(r.request) };
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
async function scope(tx: DbClient): Promise<Scope> {
  const [r] = await tx.execute<Scope>(sql`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS "databaseOid",
    pg_catalog.pg_get_userbyid(c.relowner) AS maintenance,c.relowner::text AS "maintenanceOid"
    FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.routine_payment_account_policy')`);
  if (!r || !token(r.database, 128) || !token(r.maintenance, 128) || !/^[0-9]+$/u.test(r.databaseOid) || !/^[0-9]+$/u.test(r.maintenanceOid)) return fail();
  return r;
}
function journal(env: Signing, value: unknown, expectedScope: Scope): Journal {
  const r = object(value, ['record_id','kind','subject_id','revision','payload','created_at','signature']);
  const p = object(r.payload, ['format','scope','previousRecordId','data']);
  const s = object(p.scope, ['database','databaseOid','maintenance','maintenanceOid']);
  const created = typeof r.created_at === 'string' ? Number(r.created_at) : r.created_at;
  if (!uuid(r.record_id) || r.kind !== 'account' && r.kind !== 'query' || !token(r.subject_id,128) || !integer(r.revision)
    || p.format !== 1 || !same(s,expectedScope) || !integer(created)
    || p.previousRecordId !== '' && !uuid(p.previousRecordId) || !hex(r.signature)) return fail();
  const data = r.kind === 'account' ? account(p.data) : query(p.data);
  const row: Omit<Journal,'signature'> = { record_id:r.record_id, kind:r.kind, subject_id:r.subject_id, revision:r.revision,
    payload:{ format:1 as const, scope:{...expectedScope}, previousRecordId:p.previousRecordId as string, data }, created_at:created };
  if (!equal(r.signature, mac(env,'policy',row)) || (r.kind === 'account' ? (data as RoutineAccountPolicy).accountId
    : querySubject(env,(data as RoutineAccountQueryPlan).request.orderNo)) !== r.subject_id) return fail();
  return freeze({...row,signature:r.signature});
}
const querySubject = (env: Signing, orderNo: string) => mac(env,'query-subject',['wechat','routine',orderNo]);
async function history(tx: DbClient, env: Signing, kind: Journal['kind'], subjectId: string, s: Scope): Promise<Journal[]> {
  const rows = await tx.execute(sql`SELECT * FROM public.routine_payment_account_policy
    WHERE kind=${kind} AND subject_id=${subjectId} ORDER BY revision LIMIT 65`);
  if (rows.length > 64 || Buffer.byteLength(JSON.stringify(rows),'utf8') > 1048576) return fail();
  const decoded = Array.from(rows, r => journal(env,r,s));
  for (let i=0;i<decoded.length;i++) if (decoded[i].kind!==kind || decoded[i].subject_id!==subjectId || decoded[i].revision!==i+1
    || decoded[i].payload.previousRecordId!==(i ? decoded[i-1].record_id : '') || i && decoded[i].created_at < decoded[i-1].created_at) return fail();
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
function authorization(env: Signing, value: unknown, s: Scope): Authorization {
  const r=object(value,['format','purpose','account','query','observation','issuedAt','signature']);
  const a=journal(env,r.account,s), q=r.query===null?null:journal(env,r.query,s), o=parseRoutineProviderObservation(env,r.observation);
  if (r.format!==1 || r.purpose!=='routine_approved_provider' || !integer(r.issuedAt) || a.kind!=='account'
    || q && q.kind!=='query' || !hex(r.signature)) return fail();
  const data=a.payload.data as RoutineAccountPolicy, purpose=o.source==='callback'?'notify':'query';
  approved(a,purpose,r.issuedAt);
  if (data.appId!==o.facts.appId || data.merchantId!==o.facts.merchantId || (purpose==='query')!==!!q) return fail();
  if (q) {
    const plan=q.payload.data as RoutineAccountQueryPlan; active(plan,r.issuedAt);
    if (plan.accountId!==a.subject_id || plan.accountRevision!==a.revision || plan.request.orderNo!==o.facts.orderNo) return fail();
  }
  const body={format:1 as const,purpose:'routine_approved_provider' as const,account:a,query:q,observation:o,issuedAt:r.issuedAt};
  if (!equal(r.signature,mac(env,'authorization',body))) return fail();
  return freeze({...body,signature:r.signature});
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
function use(env: Signing, raw: unknown, s: Scope, original: RoutineOriginalEvidence): Use {
  const r=object(raw,['use_id','evidence_id','payload','created_at','signature']), p=object(r.payload,['format','evidenceSignature','scopeMatches','authorization']);
  const a=authorization(env,p.authorization,s), created=typeof r.created_at==='string'?Number(r.created_at):r.created_at;
  const expected=mac(env,'use-key',[original.evidence_id,a.account.record_id,a.query?.record_id??'']);
  const body={use_id:r.use_id,evidence_id:r.evidence_id,payload:{format:1 as const,evidenceSignature:p.evidenceSignature,scopeMatches:p.scopeMatches,authorization:a},created_at:created};
  if (!hex(r.use_id) || r.use_id!==expected || r.evidence_id!==original.evidence_id || p.format!==1
    || p.evidenceSignature!==original.signature || !same(a.observation.facts,original.payload.observation.facts)
    || typeof p.scopeMatches!=='boolean' || p.scopeMatches!==scopeMatches(a,original)
    || a.observation.source!==original.source || a.observation.sourceId!==original.source_id || !integer(created)
    || created<a.issuedAt-60 || created>a.issuedAt+900 || !equal(r.signature,mac(env,'use-record',body))) return fail();
  return {use_id:r.use_id,evidence_id:original.evidence_id,payload:{format:1,evidenceSignature:original.signature,
    scopeMatches:p.scopeMatches,authorization:a},created_at:created,signature:r.signature as string};
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
