/** Synthetic closed-MAC history only. Actual SQL money is tested separately. */
import { describe, expect, it } from 'vitest';
import { parseRechargeRefundCallbackEconomicBasis, rechargeRefundCallbackClaimProjection } from '@/services/payment/RechargeRefundCallbackEconomicHistory';
import { parseRechargeRefundCallbackLocalCaptureResult, parseRechargeRefundCallbackSuccessNoticeIntent } from '@/services/payment/RechargeRefundCallbackLocalCaptureCodec';
import { parseRechargeRefundCallbackLocalReleaseResult } from '@/services/payment/RechargeRefundCallbackLocalReleaseCodec';
import { parseRechargeRefundQueryEconomicBasis } from '@/services/payment/RechargeRefundQueryEconomicHistory';
import { parseRechargeRefundLocalCaptureResult } from '@/services/payment/RechargeRefundLocalCaptureCodec';
import { parseRechargeRefundLocalReleaseResult } from '@/services/payment/RechargeRefundLocalReleaseCodec';
import { rechargeCallbackEconomicPureFixture as fixture, callbackEconomicScope as scope, callbackEconomicSigning as env } from './helpers/rechargeCallbackEconomicPure';
import { historyResign } from './helpers/rechargeRefundQueryHistoryPure';
import { operationSourceUuid, sourceClone } from './helpers/rechargeRefundOperationSourcePure';

const obj = (v: unknown) => v as Record<string, unknown>;
describe('distinct complete callback money receipt family', () => {
  for (const gift of [true, false]) for (const count of [1, 2, 3, 64]) {
    it('captures full principal without another wallet debit: gift=' + gift + ', attempts=' + count, () => {
      const f = fixture('SUCCESS', gift, count), h = f.cause(), p = parseRechargeRefundCallbackLocalCaptureResult(env, scope, f.history, f.localCapture(), f.noticeRow());
      expect(p.facts.wallet).toEqual({ beforeCents: -25, afterCents: -25 }); expect(p.facts.flow.priceCents).toBe(-1000);
      expect(p.facts.projection).toEqual({ beforeVersion: count, afterVersion: count + 1, totalAttempts: count });
      expect(p.facts.callback.eventId).toBe(h.observation.eventId); expect(p.facts.callback.approvalId).toBe(h.callback.approval.record_id);
      expect(p.record.caused_by_result_id).toBe(f.history.providerResultId); expect(p.record.attempt_id).toBeNull();
      expect(p.notice.payload.business.postBalanceCents).toBe(gift ? 0 : 150); expect(p.notice.payload.callback).toEqual(p.facts.callback);
      expect(h.history.requestQueryHistory.totalAttempts).toBe(count); expect(Object.hasOwn(h, 'query')).toBe(false);
      const lease = rechargeRefundCallbackClaimProjection(h); expect(lease.status).toBe(count === 1 ? 'SUBMITTING' : 'UNKNOWN');
      expect(lease.totalAttempts).toBe(count); expect(lease.leaseId).toBe(f.history.attempts.at(-1)!.lease_id);
    });
    it('releases exactly the original full hold: gift=' + gift + ', attempts=' + count, () => {
      const f = fixture('CLOSED', gift, count), p = parseRechargeRefundCallbackLocalReleaseResult(env, scope, f.history, f.localRelease());
      expect(p.facts.wallet).toEqual({ beforeCents: 1700, afterCents: gift ? 2850 : 2700 });
      expect(p.facts.bill.numberCents).toBe(gift ? 1150 : 1000); expect(p.facts.recharge.refundAfterCents).toBe(0);
      expect(p.facts.projection).toEqual({ beforeVersion: count, afterVersion: count + 1, totalAttempts: count });
      expect(p.record.caused_by_result_id).toBe(f.history.providerResultId); expect(p.facts.callback.eventType).toBe('REFUND.CLOSED');
    });
  }
  it('keeps ABNORMAL held rather than promoting a valid callback to a terminal money cause', () => {
    expect(() => fixture('ABNORMAL').cause()).toThrow();
  });
  it.each(['request', 'query', 'local', 'absent'])('refuses caller-selected%s as a callback monetary cause', kind => {
    const f = fixture('SUCCESS', true, 2), id = kind === 'request' ? f.history.results[0].result_id : kind === 'query' ? f.history.results[1].result_id
      : kind === 'local' ? f.localCapture().result_id : operationSourceUuid(999);
    expect(() => parseRechargeRefundCallbackEconomicBasis(env, scope, { ...f.history, providerResultId: id })).toThrow();
  });
  it('does not invent held mutable state to close a provider-only basis', () => {
    const f = fixture(); expect(f.cause()).not.toHaveProperty('state'); expect(f.cause()).not.toHaveProperty('capability');
    expect(() => parseRechargeRefundCallbackEconomicBasis(env, scope, { ...f.history, state: { status: 'held' } } as typeof f.history)).toThrow();
  });
  it.each(['local_settlement', 'local_release', 'unknown_source'])('never filters an extra%s row to manufacture a provider universe', source => {
    const f = fixture(), r = historyResign('recharge_refund_result', f.history.results[0], { result_id: operationSourceUuid(998), source });
    expect(() => parseRechargeRefundCallbackEconomicBasis(env, scope, { ...f.history, results: [...f.history.results, r] })).toThrow();
  });
  const fields = ['eventId', 'eventType', 'eventCreatedAt', 'approvalId', 'approvalSignature', 'requestDigest', 'plaintextDigest', 'verifierKey', 'signedAt', 'receivedAt'];
  it.each(fields)('rejects altered callback%s in both local receipt families', field => {
    const a = fixture(), b = fixture('CLOSED'), x = a.captureFacts(), y = b.releaseFacts();
    const value = ['eventCreatedAt', 'signedAt', 'receivedAt'].includes(field) ? 2999 : 'wrong-bound-value';
    expect(() => a.capture(a.captureFacts({ callback: { ...obj(x.callback), [field]: value } }))).toThrow();
    expect(() => b.release(b.releaseFacts(1700, { callback: { ...obj(y.callback), [field]: value } }))).toThrow();
  });
  it.each([
    ['first attempt', (v: Record<string, unknown>) => ({ request: { ...obj(v.request), attemptId: operationSourceUuid(999) } })],
    ['first MAC', (v: Record<string, unknown>) => ({ request: { ...obj(v.request), signature: '0'.repeat(64) } })],
    ['provider result', (v: Record<string, unknown>) => ({ provider: { ...obj(v.provider), resultId: operationSourceUuid(999) } })],
    ['provider receipt time', (v: Record<string, unknown>) => ({ provider: { ...obj(v.provider), receivedAt: 2999 } })],
    ['attempt count', (v: Record<string, unknown>) => ({ projection: { ...obj(v.projection), totalAttempts: 2 } })],
    ['version', (_v: Record<string, unknown>) => ({ projection: { beforeVersion: 2, afterVersion: 3, totalAttempts: 1 } })],
  ] as const)('rejects altered%s without transferring first/query authority', (_name, patch) => {
    const a = fixture(), b = fixture('CLOSED'); expect(() => a.capture(a.captureFacts(patch(a.captureFacts())))).toThrow();
    expect(() => b.release(b.releaseFacts(1700, patch(b.releaseFacts())))).toThrow();
  });
  it.each([0, '2600', 2600.5, null])('rejects unsupported local money clock%j', at => {
    const a = fixture(), b = fixture('CLOSED'), x = a.captureFacts(), y = b.releaseFacts();
    expect(() => a.capture(a.captureFacts({ capturedAt: at, flow: { ...obj(x.flow), addTime: at } }))).toThrow();
    expect(() => b.release(b.releaseFacts(1700, { releasedAt: at, bill: { ...obj(y.bill), addTime: at } }))).toThrow();
  });
  it('cannot debit the current negative wallet again or refund the gift through the provider', () => {
    const f = fixture(); expect(() => f.capture(f.captureFacts({ wallet: { beforeCents: -25, afterCents: -1175 } }))).toThrow();
    expect(() => f.capture(f.captureFacts({ recharge: { ...obj(f.captureFacts().recharge), refundAfterCents: 1150 } }))).toThrow();
  });
  it('returns the whole original hold into a later negative wallet without clamping it', () => {
    const f = fixture('CLOSED'), facts = f.releaseFacts(-1200); expect(f.release(facts).wallet).toEqual({ beforeCents: -1200, afterCents: -50 });
    expect(() => f.release(f.releaseFacts(-1200, { wallet: { beforeCents: -1200, afterCents: 0 } }))).toThrow();
    expect(() => f.release(f.releaseFacts(1700, { wallet: { beforeCents: 1700, afterCents: 1800 } }))).toThrow();
  });
  it('refuses missing first/query/policy rows even when the callback itself authenticates', () => {
    const f = fixture('SUCCESS', true, 3);
    for (const patch of [{ attempts: f.history.attempts.slice(1) }, { attempts: f.history.attempts.filter((_, i) => i !== 1) },
      { policies: f.history.policies.slice(0, -1) }, { results: f.history.results.slice(0, -1) }]) {
      expect(() => parseRechargeRefundCallbackEconomicBasis(env, scope, { ...f.history, ...patch })).toThrow();
    }
  });
  it('retains a genuine signed opposite terminal in the mixed universe instead of taking the latest callback', () => {
    const f = fixture(), cb = f.history.results.at(-1)!, e = obj(cb.evidence), other = historyResign('recharge_refund_result', cb, {
      result_id: operationSourceUuid(998), source_id: 'EV-OPPOSITE', status: 'CLOSED', evidence: { ...e,
        event: { ...obj(e.event), eventId: 'EV-OPPOSITE', eventType: 'REFUND.CLOSED' }, result: { ...obj(e.result), status: 'CLOSED', successTime: 0 } } });
    expect(() => parseRechargeRefundCallbackEconomicBasis(env, scope, { ...f.history, results: [...f.history.results, other] })).toThrow();
  });
  it('keeps original-only and query-only monetary decoders closed to callback rows', () => {
    const a = fixture(), b = fixture('CLOSED');
    const h = (f: ReturnType<typeof fixture>) => ({ operation: f.history.operation, attempt: f.history.attempts[0], approval: f.history.policies[0], providerResult: f.history.results.at(-1) });
    expect(() => parseRechargeRefundLocalCaptureResult(env, scope, h(a), a.localCapture(), a.noticeRow())).toThrow();
    expect(() => parseRechargeRefundLocalReleaseResult(env, scope, h(b), b.localRelease())).toThrow();
    expect(() => parseRechargeRefundQueryEconomicBasis(env, scope, a.history)).toThrow();
  });
  it('authenticates the independent callback notice domain and its physical notice link', () => {
    const f = fixture(), n = f.notice();
    expect(() => parseRechargeRefundCallbackSuccessNoticeIntent(env, scope, f.history, f.captureFacts(), { ...n, callback: { ...n.callback, eventId: 'other' } })).toThrow();
    const row = f.noticeRow(); expect(() => parseRechargeRefundCallbackLocalCaptureResult(env, scope, f.history, f.localCapture(), { ...row, payload: { ...row.payload, signature: '0'.repeat(64) } })).toThrow();
  });
  it('rejects executable history descriptors before observing their values', () => {
    const f = fixture(); let calls = 0; const h = { ...f.history };
    Object.defineProperty(h, 'results', { enumerable: true, get() { calls++; return f.history.results; } });
    expect(() => parseRechargeRefundCallbackEconomicBasis(env, scope, h)).toThrow(); expect(calls).toBe(0);
  });
  it('returns copied frozen facts and enforces the complete database scope', () => {
    const f = fixture(), p = f.capture(sourceClone(f.captureFacts())); expect(Object.isFrozen(p.facts.callback)).toBe(true);
    expect(() => parseRechargeRefundCallbackEconomicBasis(env, { ...scope, financialOid: '9999' }, f.history)).toThrow();
  });
});
