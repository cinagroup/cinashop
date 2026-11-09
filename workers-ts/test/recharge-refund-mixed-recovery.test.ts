/** Pure routing/MAC comparisons only. Physical and financial owners run in PG16 separately. */
import { describe, expect, it } from 'vitest';
import { decideRechargeRefundMixedRecovery as decide } from '@/services/payment/RechargeRefundMixedRecoveryDecision';
import { parseRechargeRefundQueryEconomicBasis, rechargeRefundQueryEconomicHistoryInput } from '@/services/payment/RechargeRefundQueryEconomicHistory';
import { parseRechargeRefundQueryLocalCaptureResult } from '@/services/payment/RechargeRefundQueryLocalCaptureCodec';
import { parseRechargeRefundQueryLocalReleaseResult } from '@/services/payment/RechargeRefundQueryLocalReleaseCodec';
import { rechargeCallbackEconomicPureFixture } from './helpers/rechargeCallbackEconomicPure';
import { rechargeQueryEconomicPureFixture } from './helpers/rechargeQueryEconomicPure';
import { rechargeLocalCapturePureFixture } from './helpers/rechargeLocalCapturePure';
import { rechargeLocalReleasePureFixture } from './helpers/rechargeLocalReleasePure';
import { rechargeQueryHistoryPureFixture, historyResign } from './helpers/rechargeRefundQueryHistoryPure';
import { appendPureCallback, mixedUniverse, mixedHeldState, mixedTerminalState, mixedScope as scope, mixedSigning as env } from './helpers/rechargeMixedRecoveryPure';
import { operationSourceUuid } from './helpers/rechargeRefundOperationSourcePure';

describe('complete mixed provider recovery without changing receipt families', () => {
  for (const status of ['SUCCESS', 'CLOSED'] as const) for (const count of [1, 2, 3, 64]) for (const gift of [true, false]) {
    it('prefers a genuine callback before another GET: ' + status + ', N=' + count + ', gift=' + gift, () => {
      const f = rechargeCallbackEconomicPureFixture(status, gift, count), u = mixedUniverse(f.history), s = mixedHeldState(u), now = Math.max(2600, s.updated_at + 61);
      const d = decide(u, s, now); expect(d).toEqual({ action: 'settle', operationId: s.operation_id, source: 'callback', status, providerResultId: f.history.providerResultId });
      expect(Object.isFrozen(d)).toBe(true); expect(d).not.toHaveProperty('capability'); expect(u.requestQueryHistory.totalAttempts).toBe(count);
    });
  }
  for (const kind of ['capture', 'release'] as const) for (const count of [1, 2, 64]) {
    it('routes the original callback ' + kind + ' receipt atN' + count, () => {
      const f = rechargeCallbackEconomicPureFixture(kind === 'capture' ? 'SUCCESS' : 'CLOSED', true, count), u = mixedUniverse(f.history);
      const local = kind === 'capture' ? f.localCapture() : f.localRelease(), s = mixedTerminalState(u, local);
      expect(decide(u, s, Math.max(2700, s.updated_at + 1), local)).toMatchObject({ action: 'settle', source: 'callback', providerResultId: local.caused_by_result_id });
    });
  }
  it.each([1, 2, 3])('keeps real wait/query fences when no callback exists atN%s', count => {
    const u = mixedUniverse(rechargeQueryHistoryPureFixture(count)), s = mixedHeldState(u), due = s.next_query_at!;
    expect(decide(u, s, due - 1)).toEqual({ action: 'wait', operationId: s.operation_id, nextQueryAt: due });
    expect(decide(u, s, due)).toEqual({ action: 'query', operationId: s.operation_id });
  });
  it.each([1, 2, 3])('does not settle an ABNORMAL-only callback atN%s', count => {
    const f = rechargeCallbackEconomicPureFixture('ABNORMAL', true, count), u = mixedUniverse(f.history), s = mixedHeldState(u);
    expect(decide(u, s, Math.max(2600, s.updated_at + 61))).toEqual({ action: 'query', operationId: s.operation_id });
  });
  for (const family of ['request', 'query'] as const) for (const kind of ['capture', 'release'] as const) {
    it('keeps existing ' + family + '/' + kind + ' cause after a later consistent callback', () => {
      const f = family === 'query' ? rechargeQueryEconomicPureFixture(kind === 'capture' ? 'SUCCESS' : 'CLOSED')
        : kind === 'capture' ? rechargeLocalCapturePureFixture() : rechargeLocalReleasePureFixture();
      const raw = f.history, input = 'attempts' in raw ? raw : { operation: raw.operation, attempts: [raw.attempt], policies: [raw.approval], results: [raw.providerResult] };
      const local = 'localCapture' in f ? kind === 'capture' ? f.localCapture() : f.localRelease() : f.local();
      const h = appendPureCallback(input, kind === 'capture' ? 'SUCCESS' : 'CLOSED'), u = mixedUniverse(h), s = mixedTerminalState(u, local);
      expect(decide(u, s, 2700, local)).toMatchObject({ action: 'settle', source: family, providerResultId: local.caused_by_result_id });
    });
  }
  it.each(['SUCCESS', 'CLOSED'] as const)('keeps old query %s local MAC bytes and notice domain after a consistent callback', status => {
    const f = rechargeQueryEconomicPureFixture(status), raw = appendPureCallback(f.history, status), input = { ...raw, providerResultId: f.history.providerResultId };
    // The codec input has exactly five descriptor fields; helper-only callback
    // address is deliberately not an extra accepted business field.
    const { callback: _, ...closed } = input;
    const local = status === 'SUCCESS' ? f.localCapture() : f.localRelease();
    const decoded = status === 'SUCCESS' ? parseRechargeRefundQueryLocalCaptureResult(env, scope, closed, local, f.noticeRow())
      : parseRechargeRefundQueryLocalReleaseResult(env, scope, closed, local);
    expect(decoded.record).toEqual(local); expect(decoded.facts.provider.resultId).toBe(f.history.providerResultId);
  });
  it('carries every callback back through the query economic input converter', () => {
    const f = rechargeQueryEconomicPureFixture(), { callback, ...raw } = appendPureCallback(f.history, 'SUCCESS');
    const basis = parseRechargeRefundQueryEconomicBasis(env, scope, { ...raw, providerResultId: f.history.providerResultId });
    expect(basis.providerUniverse.callbacks).toHaveLength(1);
    expect(rechargeRefundQueryEconomicHistoryInput(basis).results).toContainEqual(callback);
    expect(rechargeRefundQueryEconomicHistoryInput(basis).results).toHaveLength(raw.results.length);
  });
  it.each(['other-refund', 'opposite-terminal', 'other-success-time', 'bad-MAC', 'extra-local'])('refuses query settlement with%s callback history', mutation => {
    const f = rechargeQueryEconomicPureFixture(), { callback: _, ...raw } = appendPureCallback(f.history, mutation === 'opposite-terminal' ? 'CLOSED' : 'SUCCESS',
      mutation === 'other-refund' ? { providerRefundId: 'other-refund' } : mutation === 'other-success-time' ? { successTime: 1103 } : {});
    if (mutation === 'bad-MAC') raw.results[raw.results.length - 1] = { ...raw.results.at(-1)!, signature: '0'.repeat(64) };
    if (mutation === 'extra-local') raw.results.push(historyResign('recharge_refund_result', raw.results[0], { result_id: operationSourceUuid(993), source: 'local_release' }));
    expect(() => parseRechargeRefundQueryEconomicBasis(env, scope, { ...raw, providerResultId: f.history.providerResultId })).toThrow();
  });
  it.each(['count', 'version', 'lease', 'fence', 'clock', 'wallet', 'provider', 'local-pointer'])('refuses a forged held%s projection', field => {
    const f = rechargeCallbackEconomicPureFixture(), u = mixedUniverse(f.history), s = mixedHeldState(u);
    const patch = field === 'count' ? { attempt_count: 2 } : field === 'version' ? { version: 2 } : field === 'lease' ? { lease_id: operationSourceUuid(994) }
      : field === 'fence' ? { next_query_at: 2700 } : field === 'clock' ? { updated_at: 2600 } : field === 'wallet' ? { wallet_state: 'captured' }
        : field === 'provider' ? { provider_refund_id: 'unproven' } : { last_result_id: operationSourceUuid(995) };
    expect(() => decide(u, { ...s, ...patch }, 2700)).toThrow();
  });
  it.each([0, 2499, 2147483648, NaN])('refuses unsupported/future-observation database clock%s', now => {
    const u = mixedUniverse(rechargeCallbackEconomicPureFixture().history); expect(() => decide(u, mixedHeldState(u), now)).toThrow();
  });
});
