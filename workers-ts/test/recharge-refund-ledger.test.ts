import { describe, expect, it } from 'vitest';
import { authenticateRechargeRefundRecord, captureRechargeRefundRecord, signRechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import type { RechargeRefundScope } from '@/services/payment/RechargeRefundJournalCodec';

const env = { APP_KEY: 'recharge-refund-ledger-local-test-only' };
const scope: RechargeRefundScope = { database: 'refund_test', databaseOid: '16400',
  maintenance: 'owner', maintenanceOid: '17000', app: 'app', appOid: '17001',
  admin: 'admin', adminOid: '17002', financial: 'financial', financialOid: '17003', manager: 'manager', managerOid: '17004' };
const operationId = 'ae2af68d-c416-47b7-9dab-04515cd26df7';
const input = () => ({ operation_id: operationId, admin_id: 7, request_key: 'be2af68d-c416-47b7-9dab-04515cd26df7',
  request_hash: 'a'.repeat(64), recharge_id: 31, buyer_uid: 51, order_no: 'czoriginal', provider: 'wechat',
  payment_profile: 'routine', transaction_id: 'original_transaction', payment_source: { original: { digest: 'b'.repeat(64) }, holdBillId: 12 },
  payment_signature: 'c'.repeat(64), principal_cents: 10000, gift_cents: 1000, reclaim_gift: true, debit_cents: 11000,
  wallet_before: 13000, wallet_after: 2000, admission: 'reserved', out_refund_no: 'CNSCR' + operationId.replaceAll('-', ''), created_at: 1793876000 });

describe('recharge immutable money/source receipts', () => {
  it('authenticates identical PostgreSQL bigint text and authored integer cents', () => {
    const signed = signRechargeRefundRecord(env, scope, 'recharge_refund_operation', input());
    const postgres = { ...signed, principal_cents: '10000', gift_cents: '1000', debit_cents: '11000',
      wallet_before: '13000', wallet_after: '2000', created_at: '1793876000' };
    expect(authenticateRechargeRefundRecord(env, scope, 'recharge_refund_operation', postgres)).toEqual(signed);
  });

  it.each([
    ['admin_id', 8], ['recharge_id', 32], ['buyer_uid', 52], ['order_no', 'czother'], ['transaction_id', 'other_transaction'],
    ['request_key', 'ce2af68d-c416-47b7-9dab-04515cd26df7'], ['request_hash', 'd'.repeat(64)],
    ['provider', 'alipay'], ['payment_profile', 'app'], ['payment_source', { original: {}, holdBillId: 13 }],
    ['payment_signature', 'e'.repeat(64)], ['principal_cents', 9999], ['gift_cents', 0], ['reclaim_gift', false],
    ['debit_cents', 10000], ['wallet_before', 12000], ['wallet_after', 1000], ['admission', 'rejected_insufficient'],
    ['out_refund_no', 'CNSCRanother'], ['created_at', 1793876001],
  ] as const)('does not authenticate an edited %s as the original admission', (key, value) => {
    const signed = signRechargeRefundRecord(env, scope, 'recharge_refund_operation', input());
    expect(() => authenticateRechargeRefundRecord(env, scope, 'recharge_refund_operation', { ...signed, [key]: value })).toThrow();
  });

  it.each(['databaseOid', 'maintenanceOid', 'appOid', 'adminOid', 'financialOid', 'managerOid'] as const)
    ('rejects a receipt copied into a replacement %s', key => {
      const signed = signRechargeRefundRecord(env, scope, 'recharge_refund_operation', input());
      expect(() => authenticateRechargeRefundRecord(env, { ...scope, [key]: '19999' }, 'recharge_refund_operation', signed)).toThrow();
    });

  it('copies nested source before the caller can change its hold bill', () => {
    const raw = input(), signed = signRechargeRefundRecord(env, scope, 'recharge_refund_operation', raw);
    raw.payment_source.holdBillId = 999;
    expect(authenticateRechargeRefundRecord(env, scope, 'recharge_refund_operation', signed).payment_source)
      .toEqual({ original: { digest: 'b'.repeat(64) }, holdBillId: 12 });
    expect(Object.isFrozen(signed.payment_source)).toBe(true);
  });

  it('rejects an accessor without invoking untrusted code', () => {
    let calls = 0;
    const raw = input();
    Object.defineProperty(raw, 'admin_id', { enumerable: true, get: () => { calls++; return 7; } });
    expect(() => signRechargeRefundRecord(env, scope, 'recharge_refund_operation', raw)).toThrow();
    expect(calls).toBe(0);
  });

  it.each(['01', '-0', '1e4', '10000\n', '9007199254740992', 1.1, -0, Number.NaN])
    ('rejects an ambiguous or inexact database cents scalar %s', value => {
      const raw = { ...input(), signature: 'a'.repeat(64), principal_cents: value };
      expect(() => captureRechargeRefundRecord('recharge_refund_operation', raw)).toThrow();
    });

  it('rejects extra, missing and signed-input signature fields', () => {
    expect(() => signRechargeRefundRecord(env, scope, 'recharge_refund_operation', { ...input(), store_order_id: 1 })).toThrow();
    const raw: Record<string, unknown> = input(); delete raw.wallet_after;
    expect(() => signRechargeRefundRecord(env, scope, 'recharge_refund_operation', raw)).toThrow();
    expect(() => signRechargeRefundRecord(env, scope, 'recharge_refund_operation', { ...input(), signature: 'f'.repeat(64) })).toThrow();
  });
});
