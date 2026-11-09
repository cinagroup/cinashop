/** Private actual-App callback verification and independent truth retention.
 * No HTTP route, ACK, Queue, first POST, state, wallet or money author here.
 * The separate HTTP coordinator owns the ACK budget and post-COMMIT enqueue. */
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { Container, DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { rsaVerify } from '@/utils/wechat-crypto';
import { authenticateRechargeRefundRecord, insertRechargeRefundEvidenceTx, signRechargeRefundRecord,
  type RechargeRefundRecord } from './RechargeRefundLedger';
import { captureRechargeRefundJson } from './RechargeRefundJournalCodec';
import { readRechargeRefundCallbackPointTx, type RechargeRefundCallbackPoint } from './RechargeRefundCallbackPoint';
import { readRechargeRoutineRefundAccountPolicyTx } from './RechargeRoutineRefundAccount';
import { parseRechargeRefundCallbackResult, type RechargeRefundCallbackResult, type RechargeRefundCallbackStatus } from './RechargeRefundCallbackCodec';
import { parseRechargeRefundCallbackEnvelope, parseRechargeRefundCallbackPayload } from './RechargeRefundCallbackPayload';
import { rechargeRefundTransportApproval } from './RechargeRefundFirstRequest';
import { requireRechargeRoutineRefundPurpose } from './RechargeRoutineRefundAccountCodec';
import { routineCommittedMerchantMaterials } from './RoutineApprovedPaymentAccount';
import { routineEvidenceCanonical } from './RoutineProviderObservation';

import type { RechargeRefundCallbackBudget } from './RechargeRefundCallbackHttpInput';

type Runtime = Pick<Env, 'APP_KEY' | 'ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS'>;
const fail = (): never => { throw new ServiceUnavailableException('充值退款通知未通过原账号验证或持久回执核对'); };
const same = (a: unknown, b: unknown) => routineEvidenceCanonical(a) === routineEvidenceCanonical(b);
const brand: unique symbol = Symbol('actual-verified-recharge-refund-callback');
export interface VerifiedRechargeRefundCallback {
  readonly operationId: string; readonly eventId: string; readonly status: RechargeRefundCallbackStatus; readonly [brand]: true;
}
export interface RechargeRefundCallbackReceipt {
  readonly operationId: string; readonly eventId: string; readonly resultId: string;
  readonly status: RechargeRefundCallbackStatus; readonly signature: string; readonly replayed: boolean;
}
interface Retained {
  readonly owner: RechargeRefundCallbackService; readonly root: DbClient;
  readonly signing: Pick<Env, 'APP_KEY'>; readonly point: RechargeRefundCallbackPoint;
  readonly parsed: RechargeRefundCallbackResult; readonly row: RechargeRefundRecord;
  readonly budget?: RechargeRefundCallbackBudget;
  inFlight?: Promise<RechargeRefundCallbackReceipt>; receipt?: RechargeRefundCallbackReceipt;
}
const verified = new WeakMap<object, Retained>();
function rootClient(root: DbClient): void {
  const d = Object.getOwnPropertyDescriptor(root, '$client');
  if (!d || !('value' in d) || !d.value || typeof d.value.begin !== 'function') return fail();
}
async function context(tx: DbClient,budget?:RechargeRefundCallbackBudget): Promise<void> {
  const remaining=budget?.remainingMs()??5000;
  await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
  await tx.execute(sql`SELECT
    pg_catalog.set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000),${remaining})::text||'ms',true),
    pg_catalog.set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000),${Math.min(1000,remaining)})::text||'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),${remaining})::text||'ms',true)`);
}
async function clock(tx: DbClient): Promise<number> {
  const [r] = await tx.execute<{ now: string }>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
  const n = Number(r?.now); if (!Number.isSafeInteger(n) || n < 1 || n > 2_147_483_647) return fail(); return n;
}
async function deadline(tx: DbClient,budget?:RechargeRefundCallbackBudget): Promise<void> {
  budget?.check();
  const [r] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.current_setting('role')='none'
    AND pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds' AS ready`);
  if (r?.ready !== true) return fail();
}
function headers(input: unknown) {
  const copied = captureRechargeRefundJson(input);
  const keys = ['wechatpay-timestamp', 'wechatpay-nonce', 'wechatpay-serial', 'wechatpay-signature'];
  if (!copied || typeof copied !== 'object' || Array.isArray(copied) || Reflect.ownKeys(copied).length !== 4
    || keys.some(k => !Object.hasOwn(copied, k))) return fail();
  const r = copied as Record<string, unknown>, timestamp = r['wechatpay-timestamp'], nonce = r['wechatpay-nonce'];
  const serial = r['wechatpay-serial'], signature = r['wechatpay-signature'];
  if (typeof timestamp !== 'string' || !/^[1-9]\d{0,9}$/u.test(timestamp) || Number(timestamp) > 2_147_483_647
    || typeof nonce !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(nonce)
    || typeof serial !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(serial)
    || typeof signature !== 'string' || signature.length > 1024 || !signature
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(signature)
    || Buffer.from(signature, 'base64').toString('base64') !== signature) return fail();
  return Object.freeze({ timestamp, nonce, serial, signature, signedAt: Number(timestamp) });
}
function storedApproval(point: RechargeRefundCallbackPoint, row: RechargeRefundRecord) {
  const e = row.evidence;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return fail();
  const a = (e as Record<string, unknown>).approval;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return fail();
  const id = (a as Record<string, unknown>).recordId, approval = point.policies.find(p => p.record_id === id);
  if (!approval) return fail(); return approval;
}
/** Identical cleartext/event/business facts may be freshly encrypted/signed
 * on redelivery. Keep the original attestation/digests/approval, never rewrite
 * it with a newer observation. Changed cleartext or financial facts reject. */
function sameEvent(a: RechargeRefundCallbackResult, b: RechargeRefundCallbackResult): boolean {
  const fact = (p: RechargeRefundCallbackResult) => ({ operationSignature: p.operation.signature,
    firstAttemptId: p.first.attempt.attempt_id, firstAttemptSignature: p.first.attempt.signature,
    firstRequestHash: p.first.attempt.request_hash, eventId: p.observation.eventId, eventType: p.observation.eventType,
    eventCreatedAt: p.observation.eventCreatedAt, status: p.observation.status, providerRefundId: p.observation.providerRefundId,
    successTime: p.observation.successTime, amount: p.observation.amount, plaintextDigest: p.observation.plaintextDigest });
  return same(a.scope, b.scope) && same(fact(a), fact(b));
}

export class RechargeRefundCallbackService {
  constructor(private readonly container: Container, private readonly env: Runtime, private readonly budget?:RechargeRefundCallbackBudget) {}

  async verify(operationId: unknown, inputHeaders: unknown, inputBody: unknown): Promise<VerifiedRechargeRefundCallback> {
    this.budget?.check();
    const began = performance.now(), h = headers(inputHeaders);
    if (typeof inputBody !== 'string' || !inputBody || Buffer.byteLength(inputBody, 'utf8') > 16_384
      || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(inputBody, 'utf8')) !== inputBody) return fail();
    const rawBody = inputBody, root = this.container.db; rootClient(root);
    const env: Runtime = { APP_KEY: this.env.APP_KEY, ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS: this.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS };
    const prepared = await root.transaction(async raw => {
      const tx = raw as unknown as DbClient; await context(tx,this.budget);
      const point = await readRechargeRefundCallbackPointTx(tx, env, operationId);
      const pair = point.first.payload.approval;
      const approval = await readRechargeRoutineRefundAccountPolicyTx(tx, env,
        { appId: pair.appId, merchantId: pair.merchantId }, 'refund_notify', 'app', 'read');
      const receivedAt = await clock(tx); requireRechargeRoutineRefundPurpose(approval, 'refund_notify', receivedAt);
      if (approval.created_at > receivedAt || !point.policies.some(p => same(p, approval))
        || Math.abs(h.signedAt - receivedAt) > 300) return fail();
      const a = rechargeRefundTransportApproval(approval);
      const materials = routineCommittedMerchantMaterials(env, { appId: a.appId, merchantId: a.merchantId,
        credentialRef: a.credentialRef, credentialVersion: a.credentialVersion, credentialStamp: a.credentialStamp });
      await deadline(tx,this.budget); return { point, approval, receivedAt, materials };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    this.budget?.check();
    // Actual COMMIT must succeed before RSA/AES. This method has no provider I/O.
    try {
      if (this.container.db !== root || this.env.APP_KEY !== env.APP_KEY || h.serial !== prepared.materials.platformPublicKeyId
        || performance.now() - began >= 5000
        || !await rsaVerify(prepared.materials.platformPublicKey, h.timestamp + '\n' + h.nonce + '\n' + rawBody + '\n', h.signature)) return fail();
      const envelope = parseRechargeRefundCallbackEnvelope(JSON.parse(rawBody));
      const encoder = new TextEncoder(), keyBytes = encoder.encode(prepared.materials.apiV3Key);
      if (keyBytes.length !== 32) return fail();
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
      const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encoder.encode(envelope.resource.nonce),
        additionalData: encoder.encode(envelope.resource.associatedData), tagLength: 128 }, key,
      Uint8Array.from(Buffer.from(envelope.resource.ciphertext, 'base64')));
      const plaintext = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(clear);
      const p = parseRechargeRefundCallbackPayload(prepared.point.first.payload, JSON.parse(rawBody), JSON.parse(plaintext), prepared.receivedAt);
      this.budget?.check();
      if (performance.now() - began >= 5000) return fail();
      const first = prepared.point.first, q = first.payload.request;
      const row = signRechargeRefundRecord(env, prepared.point.scope, 'recharge_refund_result', {
        result_id: randomUUID(), operation_id: first.payload.operationId, attempt_id: null, source: 'callback', source_id: p.eventId,
        status: p.status, created_at: prepared.receivedAt, caused_by_result_id: null,
        evidence: { format: 1, purpose: 'recharge-refund-callback-provider-result-v1', scope: prepared.point.scope,
          operationSignature: prepared.point.operation.signature, firstAttemptId: first.attempt.attempt_id,
          firstAttemptSignature: first.attempt.signature, firstRequestHash: first.attempt.request_hash,
          approval: rechargeRefundTransportApproval(prepared.approval), original: { outTradeNo: q.outTradeNo, transactionId: q.transactionId,
            outRefundNo: q.outRefundNo, refundAmount: q.refundAmount, totalAmount: q.totalAmount, currency: 'CNY' },
          event: { eventId: p.eventId, eventType: p.eventType, createdAt: p.eventCreatedAt },
          result: { status: p.status, providerRefundId: p.providerRefundId, successTime: p.successTime, amount: p.amount },
          verification: { requestDigest: createHash('sha256').update(rawBody).digest('hex'),
            plaintextDigest: createHash('sha256').update(new Uint8Array(clear)).digest('hex'),
            verifierKey: h.serial, signedAt: h.signedAt, receivedAt: prepared.receivedAt } },
      });
      const parsed = parseRechargeRefundCallbackResult(env, prepared.point.scope, prepared.point.operation,
        first.attempt, prepared.point.firstApproval, prepared.approval, row);
      const token = Object.freeze({ operationId: first.payload.operationId, eventId: p.eventId, status: p.status, [brand]: true as const });
      verified.set(token, { owner: this, root, signing: { APP_KEY: env.APP_KEY }, point: prepared.point, parsed, row, budget:this.budget });
      return token;
    } catch {
      // JSON/crypto errors can contain cleartext fragments. Never propagate
      // those fragments to a future HTTP/logging boundary.
      return fail();
    }
  }

  persist(token: VerifiedRechargeRefundCallback): Promise<RechargeRefundCallbackReceipt> {
    this.budget?.check();
    const retained = token && typeof token === 'object' ? verified.get(token) : undefined;
    if (!retained || retained.owner !== this || retained.root !== this.container.db || retained.signing.APP_KEY !== this.env.APP_KEY) return Promise.reject(failError());
    if (retained.receipt) return Promise.resolve(retained.receipt);
    if (retained.inFlight) return retained.inFlight;
    const work = persist(retained).then(receipt => { retained.receipt = receipt; return receipt; })
      .finally(() => { retained.inFlight = undefined; });
    retained.inFlight = work; return work;
  }
}
function failError() { return new ServiceUnavailableException('充值退款回调验证能力与原服务不匹配'); }
async function persist(retained: Retained): Promise<RechargeRefundCallbackReceipt> {
  const { root, signing, row, budget } = retained; rootClient(root);
  return root.transaction(async raw => {
    const tx = raw as unknown as DbClient; await context(tx,budget);
    const point = await readRechargeRefundCallbackPointTx(tx, signing, row.operation_id, 'write');
    if (!same(point.scope, retained.point.scope) || !same(point.operation, retained.point.operation)
      || !same(point.first, retained.point.first) || !same(point.firstApproval, retained.point.firstApproval)) return fail();
    const approval = storedApproval(point, row);
    const parsed = parseRechargeRefundCallbackResult(signing, point.scope, point.operation,
      point.first.attempt, point.firstApproval, approval, row);
    if (!same(parsed, retained.parsed)) return fail();
    const hash = createHash('sha256').update('callback\n' + parsed.observation.eventId).digest('hex');
    await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(731733,${Number.parseInt(hash.slice(0, 8), 16) | 0}::integer)`);
    const existing = await tx.execute(sql`SELECT * FROM public.recharge_refund_result
      WHERE (source='callback' AND source_id=${parsed.observation.eventId}) OR result_id=${row.result_id}::uuid LIMIT 3`);
    let saved: RechargeRefundCallbackResult;
    if (existing.length) {
      if (existing.length !== 1) return fail();
      const record = authenticateRechargeRefundRecord(signing, point.scope, 'recharge_refund_result', existing[0]);
      saved = parseRechargeRefundCallbackResult(signing, point.scope, point.operation, point.first.attempt,
        point.firstApproval, storedApproval(point, record), record);
      if (!sameEvent(parsed, saved)) return fail();
    } else {
      const { signature: _, ...unsigned } = row;
      const record = await insertRechargeRefundEvidenceTx(tx, signing, 'app', 'recharge_refund_result', unsigned);
      if (!same(record, row)) return fail(); saved = parsed;
    }
    await deadline(tx,budget);
    return Object.freeze({ operationId: String(saved.record.operation_id), eventId: saved.observation.eventId,
      resultId: String(saved.record.result_id), status: saved.observation.status, signature: String(saved.record.signature), replayed: existing.length === 1 });
  }, { isolationLevel: 'read committed', accessMode: 'read write' });
}
