import { describe, expect, it } from 'vitest';
import { rechargeRefundNextAction, rechargeRefundTransition, rechargeRefundCancelBeforePost, type RechargeRefundDispatchClock,
  type RechargeRefundProviderStatus } from '@/services/payment/RechargeRefundStateMachine';

const held = { status: 'UNKNOWN', walletState: 'held' } as const;
const clock = (): RechargeRefundDispatchClock => ({ ...held, requestAttempts: 1, leaseUntil: 0, nextQueryAt: 0 });

describe('recharge refund reservation and provider uncertainty', () => {
  it('admits only the first request and resolves a missing response by querying', () => {
    expect(rechargeRefundNextAction({ ...clock(), status: 'RESERVED', requestAttempts: 0 }, 1_000)).toBe('request');
    for (const status of ['RESERVED','SUBMITTING','PROCESSING','UNKNOWN'] as const) {
      expect(rechargeRefundNextAction({ ...clock(), status }, 1_000)).toBe('query');
    }
  });
  it('waits for a live request lease or scheduled query without posting again', () => {
    expect(rechargeRefundNextAction({ ...clock(), leaseUntil: 1_001 }, 1_000)).toBe('wait');
    expect(rechargeRefundNextAction({ ...clock(), nextQueryAt: 1_001 }, 1_000)).toBe('wait');
    expect(rechargeRefundNextAction({ ...clock(), leaseUntil: 1_000 }, 1_000)).toBe('query');
  });
  it('stops a corrupt multiple-request history and a processing state with no original request', () => {
    expect(() => rechargeRefundNextAction({ ...clock(), requestAttempts: 2 }, 1_000)).toThrow('人工核对');
    expect(() => rechargeRefundNextAction({ ...clock(), requestAttempts: 0 }, 1_000)).toThrow('人工核对');
  });
  it('captures a successful refund once, without another wallet debit or later release', () => {
    const success = rechargeRefundTransition(held, { source: 'query', status: 'SUCCESS', definitiveRequestRejection: false });
    expect(success).toEqual({ status: 'SUCCEEDED', walletState: 'captured', walletAction: 'capture' });
    expect(rechargeRefundTransition(success, { source: 'callback', status: 'SUCCESS', definitiveRequestRejection: false }).walletAction).toBe('none');
    expect(rechargeRefundTransition(success, { source: 'query', status: 'CLOSED', definitiveRequestRejection: false }))
      .toEqual({ status: 'SUCCEEDED', walletState: 'captured', walletAction: 'none' });
  });
  it.each(['NOT_FOUND','ABNORMAL','UNKNOWN','FAILED'] as RechargeRefundProviderStatus[])(
    'keeps the reservation after a query result %s because it does not prove permanent nonpayment', status => {
      expect(rechargeRefundTransition(held, { source: 'query', status, definitiveRequestRejection: false }))
        .toEqual({ status: 'UNKNOWN', walletState: 'held', walletAction: 'none' });
    });
  it('retains a processing refund reservation', () => {
    expect(rechargeRefundTransition(held, { source: 'request', status: 'PROCESSING', definitiveRequestRejection: false }))
      .toEqual({ status: 'PROCESSING', walletState: 'held', walletAction: 'none' });
  });
  it('releases only an authenticated permanent closure or the sole POST definitive rejection', () => {
    expect(rechargeRefundTransition(held, { source: 'query', status: 'CLOSED', definitiveRequestRejection: false }))
      .toEqual({ status: 'FAILED', walletState: 'released', walletAction: 'release' });
    expect(rechargeRefundTransition(held, { source: 'request', status: 'FAILED', definitiveRequestRejection: true }))
      .toEqual({ status: 'FAILED', walletState: 'released', walletAction: 'release' });
  });
  it('cannot promote a negative query to the original POST rejection', () => {
    expect(() => rechargeRefundTransition(held, { source: 'query', status: 'FAILED', definitiveRequestRejection: true })).toThrow();
    expect(() => rechargeRefundTransition(held, { source: 'request', status: 'UNKNOWN', definitiveRequestRejection: true })).toThrow();
  });
  it('does not debit the wallet again if a success contradicts an already released reservation', () => {
    const released = { status: 'FAILED', walletState: 'released' } as const;
    expect(() => rechargeRefundTransition(released, { source: 'callback', status: 'SUCCESS', definitiveRequestRejection: false })).toThrow('人工核对');
    expect(rechargeRefundNextAction({ ...clock(), ...released }, 1_000)).toBe('none');
  });
  it('rejects a successful state whose money projection still says held', () => {
    expect(() => rechargeRefundTransition({ status: 'SUCCEEDED', walletState: 'held' },
      { source: 'request', status: 'SUCCESS', definitiveRequestRejection: false })).toThrow();
  });
  it('can release a locally cancelled reservation only before the first POST was claimed', () => {
    expect(rechargeRefundCancelBeforePost({ ...clock(), status: 'RESERVED', requestAttempts: 0 }))
      .toEqual({ status: 'FAILED', walletState: 'released', walletAction: 'release' });
    expect(() => rechargeRefundCancelBeforePost({ ...clock(), status: 'RESERVED' })).toThrow();
  });
  it.each(['SUBMITTING','PROCESSING','UNKNOWN'] as const)('never calls %s a safe local cancellation', status => {
    expect(() => rechargeRefundCancelBeforePost({ ...clock(), status })).toThrow('人工核对');
  });
});
