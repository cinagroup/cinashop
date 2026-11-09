import { describe, expect, it } from 'vitest';
import { parseRechargeRefundJournal, signRechargeRefundJournal, type RechargeRefundScope } from '@/services/payment/RechargeRefundJournalCodec';

const signing = { APP_KEY: '17'.repeat(32) };
const scope: RechargeRefundScope = { database: 'owned_refund_fixture', databaseOid: '41',
  maintenance: 'refund_owner', maintenanceOid: '51', app: 'refund_app', appOid: '52', admin: 'refund_admin', adminOid: '53',
  financial: 'refund_financial', financialOid: '54', manager: 'refund_manager', managerOid: '55' };
const data = () => ({ operationId: '009ef360-9de5-4a26-a1dc-7fbeb626c264', rechargeId: 11,
  principalCents: 10_000, recoverGift: true, originalPayment: { evidenceId: 'a7'.repeat(32) } });
const signed = () => signRechargeRefundJournal(signing, 'operation', scope, data(), 1_000);

describe('recharge refund durable journal authentication', () => {
  it('authenticates a stored round-trip while preserving the captured amount and payment source', () => {
    const record = signed();
    expect(parseRechargeRefundJournal(signing, 'operation', scope, JSON.parse(JSON.stringify(record)))).toEqual(record);
  });
  it('copies and freezes nested values before a caller can mutate a signed operation', () => {
    const source = data(), record = signRechargeRefundJournal(signing, 'operation', scope, source, 1_000);
    source.principalCents = 1; source.originalPayment.evidenceId = 'b8'.repeat(32);
    expect(record.data).toMatchObject({ principalCents: 10_000, originalPayment: { evidenceId: 'a7'.repeat(32) } });
    expect(Object.isFrozen(record.data)).toBe(true);
    expect(Object.isFrozen((record.data as ReturnType<typeof data>).originalPayment)).toBe(true);
  });
  it.each(['attempt','provider-result','local-result','quote'] as const)('does not use an operation signature as %s authority', kind => {
    expect(() => parseRechargeRefundJournal(signing, kind, scope, signed())).toThrow('证据');
  });
  it.each([
    { database: 'copied_database' }, { databaseOid: '42' }, { maintenanceOid: '56' },
    { appOid: '57' }, { adminOid: '58' }, { financial: 'other_financial' }, { managerOid: '59' },
  ])('rejects a copied record in a changed database or runtime ownership scope %#', patch => {
    expect(() => parseRechargeRefundJournal(signing, 'operation', { ...scope, ...patch }, signed())).toThrow('归属');
  });
  it('rejects an amount, original-payment reference, timestamp, signature or signing-key substitution', () => {
    for (const patch of [{ data: { ...data(), principalCents: 1 } }, { createdAt: 1_001 },
      { data: { ...data(), originalPayment: { evidenceId: 'b8'.repeat(32) } } }, { signature: 'a7'.repeat(32) }]) {
      expect(() => parseRechargeRefundJournal(signing, 'operation', scope, { ...signed(), ...patch })).toThrow();
    }
    expect(() => parseRechargeRefundJournal({ APP_KEY: '18'.repeat(32) }, 'operation', scope, signed())).toThrow();
  });
  it('does not expire historical evidence when a send approval later retires', () => {
    expect(parseRechargeRefundJournal(signing, 'operation', scope, signed()).createdAt).toBe(1_000);
  });
  it('does not invoke a getter while creating a durable signature', () => {
    let invoked = false;
    expect(() => signRechargeRefundJournal(signing, 'operation', scope, {
      get principalCents() { invoked = true; return 10_000; },
    }, 1_000)).toThrow();
    expect(invoked).toBe(false);
  });
  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 1.25, Number.MAX_SAFE_INTEGER + 1, -0, new Date(0), new Array(1)])(
    'rejects non-JSON or ambiguous journal input %#', value => {
      expect(() => signRechargeRefundJournal(signing, 'operation', scope, value, 1_000)).toThrow();
    });
  it('rejects cycles, overly deep data, excessive entries and oversized UTF8 input', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const deep = Array.from({ length: 18 }).reduce<unknown>(child => ({ child }), null);
    for (const value of [cycle, deep, Array(513).fill(0), 'é'.repeat(8_193)]) {
      expect(() => signRechargeRefundJournal(signing, 'operation', scope, value, 1_000)).toThrow();
    }
  });
  it('rejects duplicate SQL principal identities and additional envelope fields', () => {
    expect(() => signRechargeRefundJournal(signing, 'operation', { ...scope, financialOid: scope.appOid }, data(), 1_000)).toThrow();
    expect(() => parseRechargeRefundJournal(signing, 'operation', scope, { ...signed(), accepted: true })).toThrow();
  });
});
