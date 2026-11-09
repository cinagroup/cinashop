/** Synthetic authenticated provider universes only. No physical rows or funds. */
import { describe, expect, it } from 'vitest';
import { parseRechargeRefundCallbackProviderUniverse } from '@/services/payment/RechargeRefundCallbackHistoryCodec';
import { parseRechargeRefundProviderHistory } from '@/services/payment/RechargeRefundQueryHistoryCodec';
import { signRechargeRoutineRefundAccountJournal } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import type { RechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { callbackScope as scope, callbackSigning as env, rechargeRefundCallbackPureFixture } from './helpers/rechargeRefundCallbackPure';
import { historyResign, rechargeQueryHistoryPureFixture } from './helpers/rechargeRefundQueryHistoryPure';
import { operationSourceUuid } from './helpers/rechargeRefundOperationSourcePure';
type Fixture = ReturnType<typeof rechargeRefundCallbackPureFixture>;
const read = (f: Fixture, results: unknown = [...f.history.results, f.result()], policies: unknown = f.policies,
  attempts: unknown = f.history.attempts) =>
  parseRechargeRefundCallbackProviderUniverse(env, scope, f.history.operation, attempts, policies, results);
function callback(f: Fixture, id: number, status = f.evidence.result.status, providerRefundId = f.evidence.result.providerRefundId,
  successTime = status === 'SUCCESS' ? 1102 : 0): RechargeRefundRecord {
  const eventId = 'EV-SYNTHETIC-' + id;
  return f.result({ event: { ...f.evidence.event, eventId, eventType: 'REFUND.' + status },
    result: { ...f.evidence.result, status, providerRefundId, successTime } },
  { result_id: operationSourceUuid(id), source_id: eventId, status });
}
function queryAt(row: RechargeRefundRecord, observedAt: number): RechargeRefundRecord {
  const e = row.evidence as Record<string, unknown>;
  return historyResign('recharge_refund_result', row, { created_at: observedAt,
    evidence: { ...e, verification: { ...e.verification as object, observedAt } } });
}

describe('complete mixed recharge refund provider universe', () => {
  it.each(['SUCCESS', 'CLOSED', 'ABNORMAL'] as const)('decodes every %s callback without inventing an attempt or money proof', status => {
    const f = rechargeRefundCallbackPureFixture(status), h = read(f);
    expect(h.callbacks.length).toBe(1); expect(h.requestQueryHistory.totalAttempts).toBe(2);
    expect(h.providerResultCount).toBe(3); expect(h.callbacks[0].record.attempt_id).toBeNull();
    expect(h.disposition).toBe(status === 'ABNORMAL' ? 'unresolved' : 'terminal_evidence');
    expect(Object.hasOwn(h, 'state')).toBe(false); expect(Object.hasOwn(h, 'capability')).toBe(false);
    expect(Object.hasOwn(h, 'attempts')).toBe(false); expect(Object.isFrozen(h.callbacks)).toBe(true);
  });
  it('keeps the current query-only reader closed to callback rows until a dedicated runtime owner is implemented', () => {
    const f = rechargeRefundCallbackPureFixture();
    expect(() => parseRechargeRefundProviderHistory(env, scope, f.history.operation, f.history.attempts,
      f.policies, [...f.history.results, f.result()])).toThrow();
    expect(read(f).callbacks[0].record.source).toBe('callback');
  });
  it.each([1, 2, 3, 64])('retains all%s actual-attempt addresses while adding an independent callback', count => {
    const f = rechargeRefundCallbackPureFixture('SUCCESS', count), h = read(f);
    expect(h.requestQueryHistory.totalAttempts).toBe(count); expect(h.requestQueryHistory.queryAttempts).toBe(count - 1);
    expect(h.providerResultCount).toBe(count + 1); expect(h.requestQueryHistory.requestAttempts).toBe(1);
  });
  it('preserves the POST/GET universe unchanged when no callback exists', () => {
    const f = rechargeRefundCallbackPureFixture(), h = read(f, f.history.results);
    expect(h.requestQueryHistory).toEqual(parseRechargeRefundProviderHistory(env, scope, f.history.operation,
      f.history.attempts, f.policies, f.history.results));
    expect(h.callbacks).toEqual([]); expect(h.disposition).toBe('unresolved');
  });
  it('keeps unanswered POST/GET attempts while a callback supplies terminal evidence', () => {
    const f = rechargeRefundCallbackPureFixture(), h = read(f, [f.result()]);
    expect(h.requestQueryHistory.results).toEqual([]); expect(h.requestQueryHistory.totalAttempts).toBe(2);
    expect(h.disposition).toBe('terminal_evidence');
  });
  it.each(['SUCCESS', 'CLOSED'] as const)('retains consistent repeated %s facts with distinct genuine event addresses', status => {
    const f = rechargeRefundCallbackPureFixture(status), results = [...f.history.results, callback(f, 601), callback(f, 602)];
    for (const rows of [results, [...results].reverse()]) {
      const h = read(f, rows); expect(h.callbacks).toHaveLength(2); expect(h.providerResultCount).toBe(4);
      expect(h.disposition).toBe('terminal_evidence');
    }
  });
  it.each([
    ['callback SUCCESS then CLOSED', 'SUCCESS', 'CLOSED'], ['callback CLOSED then SUCCESS', 'CLOSED', 'SUCCESS'],
  ] as const)('retains %s as manual review in either persistence order', (_, first, second) => {
    const f = rechargeRefundCallbackPureFixture(first), results = [...f.history.results, callback(f, 601, first), callback(f, 602, second)];
    for (const rows of [results, [...results].reverse()]) {
      const h = read(f, rows); expect(h.disposition).toBe('manual_review'); expect(h.callbacks).toHaveLength(2);
    }
  });
  it('does not choose a latest callback when provider refund IDs differ', () => {
    const f = rechargeRefundCallbackPureFixture(), results = [...f.history.results, callback(f, 601), callback(f, 602, 'SUCCESS', 'different_refund')];
    const h = read(f, results); expect(h.providerRefundIds).toHaveLength(2); expect(h.disposition).toBe('manual_review');
    expect(read(f, [...results].reverse()).disposition).toBe('manual_review');
  });
  it('requires manual review for inconsistent successful provider timestamps', () => {
    const f = rechargeRefundCallbackPureFixture();
    expect(read(f, [...f.history.results, callback(f, 601), callback(f, 602, 'SUCCESS', 'synthetic_callback_refund', 1103)]).disposition)
      .toBe('manual_review');
  });
  it.each(['SUCCESS', 'CLOSED'] as const)('closes consistent query/callback %s without reinterpreting the callback as GET', status => {
    const f = rechargeRefundCallbackPureFixture(status), q = rechargeQueryHistoryPureFixture(2, [status]);
    const h = read(f, [...q.results, callback(f, 601, status, 'synthetic_query_refund')]);
    expect(h.disposition).toBe('terminal_evidence'); expect(h.requestQueryHistory.results.at(-1)?.record.source).toBe('query');
    expect(h.callbacks[0].record.source).toBe('callback'); expect(h.callbacks[0].record.attempt_id).toBeNull();
  });
  it.each(['SUCCESS', 'CLOSED'] as const)('does not let query %s hide the opposite callback terminal', queryStatus => {
    const callbackStatus = queryStatus === 'SUCCESS' ? 'CLOSED' : 'SUCCESS';
    const f = rechargeRefundCallbackPureFixture(callbackStatus), q = rechargeQueryHistoryPureFixture(2, [queryStatus]);
    const results = [...q.results, callback(f, 601, callbackStatus, 'synthetic_query_refund')];
    for (const rows of [results, [...results].reverse()]) expect(read(f, rows).disposition).toBe('manual_review');
  });
  it('includes provider IDs from nonterminal query results in the complete conflict check', () => {
    const f = rechargeRefundCallbackPureFixture(), q = rechargeQueryHistoryPureFixture(2, ['PROCESSING']);
    expect(read(f, [...q.results, f.result()]).disposition).toBe('manual_review');
    expect(read(f, [...q.results, callback(f, 601, 'SUCCESS', 'synthetic_query_refund')]).disposition).toBe('terminal_evidence');
  });
  it('retains a strictly older NOT_FOUND before a positive callback', () => {
    const f = rechargeRefundCallbackPureFixture(), q = rechargeQueryHistoryPureFixture(2, ['NOT_FOUND']);
    const h = read(f, [...q.results, f.result()]); expect(h.disposition).toBe('terminal_evidence');
    expect(h.requestQueryHistory.results.at(-1)?.observation.status).toBe('NOT_FOUND'); expect(h.providerResultCount).toBe(3);
  });
  it.each([2501, 2502])('retains equal/later NOT_FOUND at%s as contradiction regardless of ordinal/order', at => {
    const f = rechargeRefundCallbackPureFixture(), q = rechargeQueryHistoryPureFixture(2, ['NOT_FOUND']);
    const results = [q.results[0], queryAt(q.results[1], at), f.result()];
    for (const rows of [results, [...results].reverse()]) {
      const h = read(f, rows); expect(h.disposition).toBe('manual_review'); expect(h.providerResultCount).toBe(3);
    }
  });
  it('does not let later callbacks erase an existing POST/GET contradiction', () => {
    const f = rechargeRefundCallbackPureFixture(), q = rechargeQueryHistoryPureFixture(2, ['NOT_FOUND'], 'SUCCESS');
    expect(read(f, [...q.results, callback(f, 601, 'SUCCESS', 'refund_contract_1')]).disposition).toBe('manual_review');
  });
  it('recognizes consistent first-response and callback evidence without requiring a query', () => {
    const f = rechargeRefundCallbackPureFixture('SUCCESS', 1), q = rechargeQueryHistoryPureFixture(1, [], 'SUCCESS');
    expect(read(f, [...q.results, callback(f, 601, 'SUCCESS', 'refund_contract_1')]).disposition).toBe('terminal_evidence');
  });
  it('retains previously approved callback truth after a later revocation', () => {
    const f = rechargeRefundCallbackPureFixture(), a = f.approval;
    const revoked = signRechargeRoutineRefundAccountJournal(env, scope, { record_id: operationSourceUuid(603), account_id: a.account_id,
      revision: a.revision + 1, payload: { ...a.payload, previousRecordId: a.record_id, data: { ...a.payload.data, state: 'revoked' } }, created_at: 3000 });
    expect(read(f, [...f.history.results, f.result()], [...f.policies, revoked]).disposition).toBe('terminal_evidence');
  });
  it.each(['missing notify approval', 'missing first approval', 'missing middle query approval', 'reordered approval history'])('rejects %s rather than supplying a partial universe', kind => {
    const f = rechargeRefundCallbackPureFixture(), policies = kind === 'missing notify approval' ? f.policies.slice(0, -1)
      : kind === 'missing first approval' ? f.policies.slice(1)
      : kind === 'missing middle query approval' ? f.policies.filter((_, i) => i !== 1) : [...f.policies].reverse();
    expect(() => read(f, [...f.history.results, f.result()], policies)).toThrow();
  });
  it.each(['missing first', 'missing middle', 'reordered', 'duplicate'])('rejects %s attempts even with signed terminal callbacks', kind => {
    const f = rechargeRefundCallbackPureFixture('SUCCESS', 3), attempts = kind === 'missing first' ? f.history.attempts.slice(1)
      : kind === 'missing middle' ? f.history.attempts.filter((_, i) => i !== 1)
      : kind === 'reordered' ? [...f.history.attempts].reverse() : [...f.history.attempts, f.history.attempts[2]];
    expect(() => read(f, [...f.history.results, f.result()], f.policies, attempts)).toThrow();
  });
  it.each(['local_cancel', 'local_settlement', 'local_release', 'future_source'])('never filters unsupported%s from the provider universe', source => {
    const f = rechargeRefundCallbackPureFixture(), raw = historyResign('recharge_refund_result', f.result(), { source });
    expect(() => read(f, [...f.history.results, raw])).toThrow();
  });
  it('does not filter an invalid callback just because request/query evidence is sufficient', () => {
    const f = rechargeRefundCallbackPureFixture(), q = rechargeQueryHistoryPureFixture(2, ['SUCCESS']);
    const invalid = f.result({ firstAttemptSignature: '0'.repeat(64) });
    expect(() => read(f, [...q.results, invalid])).toThrow();
  });
  it.each(['duplicate result UUID', 'duplicate event ID', 'cross-family result UUID'])('rejects%s across the full universe', kind => {
    const f = rechargeRefundCallbackPureFixture(), r = f.result();
    const other = kind === 'duplicate result UUID' ? callback(f, 502)
      : kind === 'duplicate event ID' ? historyResign('recharge_refund_result', r, { result_id: operationSourceUuid(604) })
      : historyResign('recharge_refund_result', r, { result_id: f.history.results[0].result_id });
    expect(() => read(f, [...f.history.results, r, other])).toThrow();
  });
  it('applies the128 result bound to the combined provider universe, not separately to each family', () => {
    const f = rechargeRefundCallbackPureFixture('SUCCESS', 1);
    const rows = [...f.history.results, ...Array.from({ length: 127 }, (_, i) => callback(f, 700 + i))];
    expect(read(f, rows).providerResultCount).toBe(128);
    expect(() => read(f, [...rows, callback(f, 900)])).toThrow();
  });
  it('does not execute caller-owned array getters before authentication', () => {
    const f = rechargeRefundCallbackPureFixture(); let calls = 0;
    const rows: unknown[] = [f.result()]; Object.defineProperty(rows, '0', { enumerable: true, get() { calls++; throw Error('executed'); } });
    expect(() => read(f, rows)).toThrow(); expect(calls).toBe(0);
  });
  it.each(['sparse', 'extra property', 'symbol', 'wrong prototype'])('rejects%s result arrays', kind => {
    const f = rechargeRefundCallbackPureFixture(); const rows = [f.result()];
    if (kind === 'sparse') delete rows[0];
    if (kind === 'extra property') Object.defineProperty(rows, 'extra', { value: true });
    if (kind === 'symbol') Object.defineProperty(rows, Symbol('authority'), { value: true });
    if (kind === 'wrong prototype') Object.setPrototypeOf(rows, null);
    expect(() => read(f, rows)).toThrow();
  });
});
