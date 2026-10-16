import { expect, it } from 'vitest';
import { supplierPaymentRevision, supplierPaymentHash, assertSupplierPaymentRevision } from '../../src/services/supplier/SupplierOfflinePaymentInput';
import { supplierManualRefundMac, assertSupplierManualRefundRevision } from '../../src/services/supplier/SupplierManualRefundInput';
import { outRequestHash } from '../../src/services/out/OutIdempotency';

it('workerd node crypto and WebCrypto agree on Supplier cash proof bytes while separating payment, refund and live identities', async () => {
  const actor = { id: 21, supplierId: 7, authVersion: '1'.repeat(32), expiresAt: 2_000_000_000 };
  const source = { order_no: 'OwnedFixture', goods: ['中文', 3], amount: '18.75' };
  const key = 'owned-loopback-supplier-cash-runtime-key', bytes = new TextEncoder();
  const canonical = '{"actor_id":21,"auth_version":"' + '1'.repeat(32) + '","source":{"amount":"18.75","goods":["中文",3],"order_no":"OwnedFixture"},"supplier_id":7}';
  const imported = await crypto.subtle.importKey('raw', bytes.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const independent = async (domain: string) => [...new Uint8Array(await crypto.subtle.sign('HMAC', imported, bytes.encode(domain + canonical)))].map(n => n.toString(16).padStart(2, '0')).join('');
  const payment = supplierPaymentRevision(key, actor, source), refund = supplierManualRefundMac(key, source, actor);
  expect(payment).toBe(await independent('cinashop.supplier-offline-payment.revision.v1\0'));
  expect(refund).toBe(await independent('cinashop.supplier-manual-refund.revision.v1\0'));
  expect(payment).not.toBe(refund);
  expect(supplierPaymentHash(source)).toBe(await outRequestHash(source));
  for (const identity of [{ ...actor, id: 22 }, { ...actor, supplierId: 8 }, { ...actor, authVersion: '2'.repeat(32) }]) {
    expect(() => assertSupplierPaymentRevision(payment, supplierPaymentRevision(key, identity, source))).toThrow();
    expect(() => assertSupplierManualRefundRevision(refund, supplierManualRefundMac(key, source, identity))).toThrow();
  }
  expect(() => assertSupplierPaymentRevision(payment, supplierPaymentRevision(key, actor, { ...source, amount: '18.76' }))).toThrow();
  expect(() => assertSupplierManualRefundRevision(refund, supplierManualRefundMac(key, { ...source, amount: '18.76' }, actor))).toThrow();
});
