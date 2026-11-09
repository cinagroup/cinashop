/** Direct-merchant V3 refund notification shape and original-business checks.
 * Parsing JSON (including caller-supplied decrypted JSON) is NOT RSA/AES
 * verification. No route/writer/acknowledgement consumes this pure value yet.
 * Reference: https://pay.weixin.qq.com/doc/v3/merchant/4013071196 (2025-01-02). */
import { Buffer } from 'node:buffer';
import { ServiceUnavailableException } from '@/utils/errors';
import { captureRechargeRefundJson } from './RechargeRefundJournalCodec';
import { captureRechargeRefundCallbackAmount, type RechargeRefundCallbackEventType, type RechargeRefundCallbackStatus } from './RechargeRefundCallbackCodec';

const fail = (): never => { throw new ServiceUnavailableException('充值退款通知参数与原付款不一致'); };
const epoch = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2_147_483_647;
const principal = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 999_999_999_999;
function object(value: unknown): Record<string, unknown> {
  const r = captureRechargeRefundJson(value);
  if (!r || typeof r !== 'object' || Array.isArray(r)) return fail();
  return r as Record<string, unknown>;
}
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0
  && Array.from(v).length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
const token = (v: unknown, max: number): v is string => typeof v === 'string'
  && new RegExp('^[A-Za-z0-9._:-]{1,' + max + '}$', 'u').test(v);

/** Reject Date.parse's calendar rollover, missing zones, fractional seconds
 * and leap seconds. Durable protocol timestamps are exact epoch32 seconds;
 * unsupported time precision must be reviewed, never silently rounded. */
export function rechargeRefundCallbackRfc3339(value: unknown): number {
  if (typeof value !== 'string') return fail();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!m) return fail();
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const oh = Number(m[9] ?? 0), om = Number(m[10] ?? 0);
  if (year < 1970 || year > 2038 || month < 1 || month > 12 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59 || oh > 23 || om > 59) return fail();
  const local = Date.UTC(year, month - 1, day, hour, minute, second), d = new Date(local);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return fail();
  const offset = (oh * 60 + om) * 60 * (m[8] === '-' ? -1 : 1), result = local / 1000 - offset;
  if (!epoch(result)) return fail();
  return result;
}

/** Local finite JSON ceiling is16KiB per envelope/plaintext, intentionally
 * below the provider's maximum ciphertext size. Unknown external JSON fields
 * are copied/bounded before projection; they cannot execute getters/toJSON.
 * A future verifier must digest the exact raw bytes, not this projection. */
export function parseRechargeRefundCallbackEnvelope(input: unknown) {
  const r = object(input), resource = object(r.resource);
  if (!token(r.id, 36) || !['REFUND.SUCCESS', 'REFUND.CLOSED', 'REFUND.ABNORMAL'].includes(String(r.event_type))
    || r.resource_type !== 'encrypt-resource' || !text(r.summary, 64)
    || resource.algorithm !== 'AEAD_AES_256_GCM' || resource.original_type !== 'refund'
    || typeof resource.ciphertext !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(resource.ciphertext)
    || Buffer.from(resource.ciphertext, 'base64').length < 17
    || Buffer.from(resource.ciphertext, 'base64').toString('base64') !== resource.ciphertext
    || !text(resource.nonce, 32) || Buffer.byteLength(resource.nonce, 'utf8') > 32
    || resource.associated_data !== undefined && (typeof resource.associated_data !== 'string'
      || Buffer.byteLength(resource.associated_data, 'utf8') > 16)) return fail();
  return Object.freeze({ eventId: r.id, eventType: r.event_type as RechargeRefundCallbackEventType,
    eventCreatedAt: rechargeRefundCallbackRfc3339(r.create_time), resource: Object.freeze({
      algorithm: 'AEAD_AES_256_GCM' as const, originalType: 'refund' as const, ciphertext: resource.ciphertext,
      nonce: resource.nonce, associatedData: resource.associated_data === undefined ? '' : resource.associated_data as string,
    }) });
}

/** Absence of appid/currency follows the direct-merchant notification schema.
 * If supplied, both must match. The original AppID remains pinned by the
 * authenticated first request plus a separately approved notify credential;
 * current mini-program configuration is never a substitute for that binding. */
export function parseRechargeRefundCallbackPayload(first: unknown,
  rawEnvelope: unknown, rawPlaintext: unknown, receivedAt: number) {
  // Even an internal historical payload is copied before any field access.
  // These checks cannot authenticate the first request; the owning reader
  // must still prove its MAC and physical operation/attempt/policy binding.
  const binding = object(first), q = object(binding.request), account = object(binding.approval);
  if (!epoch(binding.issuedAt) || !token(q.outTradeNo, 32) || !token(q.transactionId, 100) || !token(q.outRefundNo, 64)
    || !principal(q.totalAmount) || q.refundAmount !== q.totalAmount || !token(account.appId, 32)
    || typeof account.merchantId !== 'string' || !/^\d{1,32}$/u.test(account.merchantId)) return fail();
  const envelope = parseRechargeRefundCallbackEnvelope(rawEnvelope), r = object(rawPlaintext), a = object(r.amount);
  if (!epoch(receivedAt) || receivedAt < binding.issuedAt - 1 || envelope.eventCreatedAt < binding.issuedAt - 300
    || envelope.eventCreatedAt > receivedAt + 300 || r.mchid !== account.merchantId
    || r.out_trade_no !== q.outTradeNo || r.transaction_id !== q.transactionId || r.out_refund_no !== q.outRefundNo
    || !token(r.refund_id, 32) || !['SUCCESS', 'CLOSED', 'ABNORMAL'].includes(String(r.refund_status))
    || envelope.eventType !== 'REFUND.' + String(r.refund_status) || !text(r.user_received_account, 64)
    || r.appid !== undefined && r.appid !== account.appId
    || a.currency !== undefined && a.currency !== 'CNY') return fail();
  const amount = captureRechargeRefundCallbackAmount({ total: a.total, refund: a.refund,
    payerTotal: a.payer_total, payerRefund: a.payer_refund }, q.totalAmount);
  let successTime = 0;
  if (r.refund_status === 'SUCCESS') {
    successTime = rechargeRefundCallbackRfc3339(r.success_time);
    if (successTime < binding.issuedAt - 300 || successTime > envelope.eventCreatedAt + 300 || successTime > receivedAt + 300) return fail();
  } else if (r.success_time !== undefined) return fail();
  // Never retain user_received_account or decrypted JSON in a public DTO.
  return Object.freeze({ eventId: envelope.eventId, eventType: envelope.eventType, eventCreatedAt: envelope.eventCreatedAt,
    status: r.refund_status as RechargeRefundCallbackStatus, providerRefundId: r.refund_id, successTime, amount });
}
