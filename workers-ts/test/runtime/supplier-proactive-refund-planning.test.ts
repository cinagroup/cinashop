import { expect, it } from 'vitest';
import { supplierProactiveRefundMac, parseSupplierProactiveRefundIntent, assertSupplierProactiveRefundRevision } from '../../src/services/supplier/SupplierProactiveRefundInput';
import { supplierManualRefundMac } from '../../src/services/supplier/SupplierManualRefundInput';
import { outRequestHash } from '../../src/services/out/OutIdempotency';
import { planSupplierProactiveMoneyRefund } from '../../src/services/supplier/SupplierProactiveRefundMoneyPlan';
import { planSupplierProactiveWholeInvoice } from '../../src/services/supplier/SupplierProactiveRefundInvoicePlan';
import { supplierProactiveRefundApplicationNumber } from '../../src/services/supplier/SupplierProactiveRefundIdentity';

it('workerd independently verifies the proactive HMAC domain and freezes intent before asynchronous WebCrypto hashing', async () => {
  const actor = { id: 21, supplierId: 7, authVersion: '1'.repeat(32), expiresAt: 2_000_000_000 };
  const source = { amount: '18.75', order_no: 'OwnedProactiveOrder', goods: ['中文', 3] }, key = 'owned-proactive-workerd-test-key';
  const canonical = '{"actor_id":21,"auth_version":"' + '1'.repeat(32)
    + '","source":{"amount":"18.75","goods":["中文",3],"order_no":"OwnedProactiveOrder"},"supplier_id":7}';
  const bytes = new TextEncoder(), imported = await crypto.subtle.importKey('raw', bytes.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = [...new Uint8Array(await crypto.subtle.sign('HMAC', imported,
    bytes.encode('cinashop.supplier-proactive-refund.revision.v1\0' + canonical)))].map(n => n.toString(16).padStart(2, '0')).join('');
  const revision = supplierProactiveRefundMac(key, source, actor);
  expect(revision).toBe(expected);
  expect(revision).not.toBe(supplierManualRefundMac(key, source, actor));
  expect(() => assertSupplierProactiveRefundRevision(revision, supplierProactiveRefundMac(key, source, { ...actor, supplierId: 8 }))).toThrow();
  const body = { operation_id: '13b48210-1570-4da2-85ee-10ea27b9dc22', revision, refund_price: '7.00', type: 1, cash_returned: true };
  const pending = parseSupplierProactiveRefundIntent(31, body, actor);
  body.refund_price = '11.75'; actor.supplierId = 8;
  const { intent, hash } = await pending;
  expect(intent).toMatchObject({ supplier_id: 7, order_id: 31, refund_price: '7.00' });
  expect(Object.isFrozen(intent)).toBe(true);
  expect(hash).toBe(await outRequestHash(intent));
});

it('workerd keeps BigInt minor units and original whole-ticket value independent from pending provider money', () => {
  const money = planSupplierProactiveMoneyRefund({ paid: '18.75', firstGoodsRefund: '7.00', payType: 'weixin', completions: [],
    payments: [{ operationId: '13b48210-1570-4da2-85ee-10ea27b9dc22', amount: '4.00', status: 'UNKNOWN' }] }, '7.75');
  expect(money).toMatchObject({ refunded: '7.00', provider_reserved: '4.00', available: '7.75', after_refunded: '14.75', after_available: '0.00' });
  const invoice = planSupplierProactiveWholeInvoice({ id: 31, pid: 0, uid: 11, paid: 1, payPrice: '18.75', totalNum: 3 },
    [{ id: 51, oid: 31, uid: 11, cartNum: 3 }], new Map([[51, 3]]),
    { id: 81, orderId: 31, uid: 11, category: 'order', invoiceAmount: '18.75', isPay: 1, isRefund: 0, isDel: 0, isInvoice: 0, invoiceNumber: '' }, '7.00', null);
  expect(invoice).toMatchObject({ goods_quantity: 3, invoice_amount: '18.75', first_refunded: '7.00', unreturned_payment: '11.75' });
  expect(planSupplierProactiveMoneyRefund({ paid: '9999999999.99', firstGoodsRefund: '0.01', payType: 'yue', completions: [], payments: [] },
    '9999999999.98').after_refunded).toBe('9999999999.99');
});

it('workerd preserves every original UUID bit inside the mature32-character financial link', () => {
  const uuid='ffffffff-ffff-4fff-bfff-ffffffffffff';
  const number=supplierProactiveRefundApplicationNumber(2147483647,uuid);
  expect(number.length).toBeLessThanOrEqual(32);
  expect(number).toMatch(/^SR[0-9a-z]+_[A-Za-z0-9_-]{22}$/);
  const separator=number.indexOf('_'),actor=number.slice(2,separator);
  expect(Number.parseInt(actor,36)).toBe(2147483647);
  const raw=atob(number.slice(separator+1).replaceAll('-','+').replaceAll('_','/')+'==');
  expect([...raw].map(byte=>byte.charCodeAt(0).toString(16).padStart(2,'0')).join('')).toBe(uuid.replaceAll('-',''));
  expect(supplierProactiveRefundApplicationNumber(21,uuid)).not.toBe(number);
  expect(supplierProactiveRefundApplicationNumber(2147483647,'ffffffff-ffff-4fff-bfff-fffffffffffe')).not.toBe(number);
});
