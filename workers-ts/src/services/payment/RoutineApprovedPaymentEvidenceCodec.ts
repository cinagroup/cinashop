/** Historical approved query/notify provenance only. No registry, latest policy or capability issuance. */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../../env';
import { ServiceUnavailableException } from '../../utils/errors';
import { routineEvidenceCanonical, routineEvidenceHmac, parseRoutineProviderObservation, type RoutineProviderObservation } from './RoutineProviderObservation';
import type { RoutineOriginalEvidence } from './RoutineOriginalPaymentEvidenceCodec';
import type { PaymentProviderQueryRequest } from './PaymentProviderQuery';

type Signing = Pick<Env, 'APP_KEY'>;
export type RoutineApprovedScope = { database: string; databaseOid: string; maintenance: string; maintenanceOid: string };
export type RoutineApprovedPurpose = 'query' | 'notify';
type Scope = RoutineApprovedScope;
type Purpose = RoutineApprovedPurpose;
export interface RoutineAccountPolicy {
  accountId: string; state: 'active' | 'revoked'; appId: string; merchantId: string;
  credentialRef: string; credentialVersion: number; credentialStamp: string;
  purposes: Purpose[]; validFrom: number; validUntil: number;
}
export interface RoutineAccountQueryPlan {
  state: 'active' | 'revoked'; accountId: string; accountRevision: number;
  request: PaymentProviderQueryRequest; validFrom: number; validUntil: number;
}
export type RoutineApprovedAccountJournal = { record_id: string; kind: 'account' | 'query'; subject_id: string; revision: number;
  payload: { format: 1; scope: Scope; previousRecordId: string; data: RoutineAccountPolicy | RoutineAccountQueryPlan };
  created_at: number; signature: string };
export type RoutineApprovedAuthorization = { format: 1; purpose: 'routine_approved_provider'; account: RoutineApprovedAccountJournal; query: RoutineApprovedAccountJournal | null;
  observation: RoutineProviderObservation; issuedAt: number; signature: string };
export type RoutineApprovedUse = { use_id: string; evidence_id: string; payload: { format: 1; evidenceSignature: string; scopeMatches: boolean; authorization: RoutineApprovedAuthorization };
  created_at: number; signature: string };
type Journal = RoutineApprovedAccountJournal;
type Authorization = RoutineApprovedAuthorization;
type Use = RoutineApprovedUse;
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
export function parseRoutineApprovedAccountPolicy(value: unknown): RoutineAccountPolicy {
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
export function parseRoutineApprovedQueryPlan(value: unknown): RoutineAccountQueryPlan {
  const r = object(value, ['state','accountId','accountRevision','request','validFrom','validUntil']), times = interval(r);
  if (!token(r.accountId) || !integer(r.accountRevision)) return fail();
  return { ...times, accountId: r.accountId, accountRevision: r.accountRevision, request: request(r.request) };
}
export function parseRoutineApprovedAccountJournal(env: Signing, value: unknown, expectedScope: Scope): Journal {
  const r = object(value, ['record_id','kind','subject_id','revision','payload','created_at','signature']);
  const p = object(r.payload, ['format','scope','previousRecordId','data']);
  const s = object(p.scope, ['database','databaseOid','maintenance','maintenanceOid']);
  const created = typeof r.created_at === 'string' ? Number(r.created_at) : r.created_at;
  if (!uuid(r.record_id) || r.kind !== 'account' && r.kind !== 'query' || !token(r.subject_id,128) || !integer(r.revision)
    || p.format !== 1 || !same(s,expectedScope) || !integer(created)
    || p.previousRecordId !== '' && !uuid(p.previousRecordId) || !hex(r.signature)) return fail();
  const data = r.kind === 'account' ? parseRoutineApprovedAccountPolicy(p.data) : parseRoutineApprovedQueryPlan(p.data);
  const row: Omit<Journal,'signature'> = { record_id:r.record_id, kind:r.kind, subject_id:r.subject_id, revision:r.revision,
    payload:{ format:1 as const, scope:{...expectedScope}, previousRecordId:p.previousRecordId as string, data }, created_at:created };
  if (!equal(r.signature, mac(env,'policy',row)) || (r.kind === 'account' ? (data as RoutineAccountPolicy).accountId
    : querySubject(env,(data as RoutineAccountQueryPlan).request.orderNo)) !== r.subject_id) return fail();
  return freeze({...row,signature:r.signature});
}
const querySubject = (env: Signing, orderNo: string) => mac(env,'query-subject',['wechat','routine',orderNo]);
function active(value: RoutineAccountPolicy | RoutineAccountQueryPlan, now: number) {
  if (value.state !== 'active' || now < value.validFrom || now >= value.validUntil) return fail();
}
function approved(row: Journal, purpose: Purpose, now: number) {
  if (row.kind !== 'account') return fail();
  const a = row.payload.data as RoutineAccountPolicy; active(a,now);
  if (!a.purposes.includes(purpose)) return fail();
  return a;
}
export function parseRoutineApprovedAuthorization(env: Signing, value: unknown, s: Scope): Authorization {
  const r=object(value,['format','purpose','account','query','observation','issuedAt','signature']);
  const a=parseRoutineApprovedAccountJournal(env,r.account,s), q=r.query===null?null:parseRoutineApprovedAccountJournal(env,r.query,s), o=parseRoutineProviderObservation(env,r.observation);
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
function scopeMatches(a: Authorization, original: RoutineOriginalEvidence): boolean {
  if (!a.query) return true;
  const plan=a.query.payload.data as RoutineAccountQueryPlan, binding=original.payload.binding;
  return binding.state==='bound' && binding.local.domain===plan.request.orderDomain
    && binding.local.amountCents===plan.request.expectedAmountCents;
}
export function parseRoutineApprovedUse(env: Signing, raw: unknown, s: Scope, original: RoutineOriginalEvidence): Use {
  const r=object(raw,['use_id','evidence_id','payload','created_at','signature']), p=object(r.payload,['format','evidenceSignature','scopeMatches','authorization']);
  const a=parseRoutineApprovedAuthorization(env,p.authorization,s), created=typeof r.created_at==='string'?Number(r.created_at):r.created_at;
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
/** Link validation for already authenticated rows, in ascending revision order.
 * This checks one supplied complete chain; it does not discover missing subjects. */
export function validateRoutineApprovedAccountHistory(decoded: readonly RoutineApprovedAccountJournal[], kind: RoutineApprovedAccountJournal['kind'], subjectId: string): void {
  for (let i=0;i<decoded.length;i++) if (decoded[i].kind!==kind || decoded[i].subject_id!==subjectId || decoded[i].revision!==i+1
    || decoded[i].payload.previousRecordId!==(i ? decoded[i-1].record_id : '') || i && decoded[i].created_at < decoded[i-1].created_at) return fail();
}
