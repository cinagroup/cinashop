import { describe, expect, it } from 'vitest';
import { planSupplierProactiveWholeInvoice as plan } from '@/services/supplier/SupplierProactiveRefundInvoicePlan';
import type { ManualInvoiceDisposition } from '@/services/order/InvoiceManualRedNoteEvidence';

const order = () => ({ id: 31, pid: 0, uid: 11, paid: 1, payPrice: '18.75', totalNum: 3 });
const carts = () => [{ id: 51, oid: 31, uid: 11, cartNum: 1 }, { id: 52, oid: 31, uid: 11, cartNum: 2 }];
const selections = () => new Map([[51, 1], [52, 2]]);
const invoice = () => ({ id: 81, orderId: 31, uid: 11, category: 'order', invoiceAmount: '18.75', isPay: 1,
  isRefund: 0, isDel: 0, isInvoice: 0, invoiceNumber: '' });
const coverage = (): ManualInvoiceDisposition => ({ version: 'invoice-manual-disposition-v1', coverage_hash: 'a'.repeat(64), coverage_count: 1,
  invoice_ids: [81], review_ids: ['13b48210-1570-4da2-85ee-10ea27b9dc22'] });

describe('whole-goods invoice amount and the independent remaining money', () => {
  it('keeps the original18.75 invoice disposition whole when the first actual refund is only7.00', () => {
    const result = plan(order(), carts(), selections(), invoice(), '7.00', null);
    expect(result).toEqual({ version: 'supplier-proactive-whole-invoice-plan-v1', source_order_id: 31, payment_order_id: 31,
      invoice_id: 81, goods_quantity: 3, invoice_amount: '18.75', first_refunded: '7.00', unreturned_payment: '11.75',
      disposition: 'cancel-unissued', manual_disposition: null });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('retains full original manual coverage and does not imply a new7.00 tax-provider red note', () => {
    const manual = coverage(), original = invoice(); original.isInvoice = 1; original.invoiceNumber = '真实原票编号';
    const result = plan(order(), carts(), selections(), original, '7.00', manual);
    manual.invoice_ids[0] = 999; manual.review_ids.length = 0;
    expect(result).toMatchObject({ invoice_amount: '18.75', first_refunded: '7.00', unreturned_payment: '11.75', disposition: 'whole-manual-red',
      manual_disposition: { invoice_ids: [81], review_ids: ['13b48210-1570-4da2-85ee-10ea27b9dc22'] } });
    expect(Object.isFrozen(result.manual_disposition?.review_ids)).toBe(true);
  });
  it('covers the exact full-money and genuine zero-price boundaries', () => {
    expect(plan(order(), carts(), selections(), invoice(), '18.75', null).unreturned_payment).toBe('0.00');
    expect(plan({ ...order(), uid: 0, payPrice: '0.00' }, carts().map(row => ({ ...row, uid: 0 })), selections(),
      { ...invoice(), uid: 0, invoiceAmount: '0.00' }, '0.00', null)).toMatchObject({ invoice_amount: '0.00', unreturned_payment: '0.00' });
    expect(() => plan(order(), carts(), selections(), invoice(), '0.00', null)).toThrow();
  });
  it('retains a genuine older manual-review UUID instead of imposing the new operation UUIDv4 rule on historical evidence', () => {
    const historical = { ...coverage(), review_ids: ['13b48210-1570-1da2-85ee-10ea27b9dc22'] };
    expect(plan(order(), carts(), selections(), { ...invoice(), isInvoice: 1 }, '7.00', historical).manual_disposition?.review_ids)
      .toEqual(historical.review_ids);
  });
  it('preserves the actual payment root of an allocated child without moving a root invoice onto the child', () => {
    expect(plan({ ...order(), pid: 9 }, carts(), selections(), invoice(), '7.00', null).payment_order_id).toBe(9);
    expect(() => plan({ ...order(), pid: 9 }, carts(), selections(), { ...invoice(), orderId: 9 }, '7.00', null)).toThrow();
  });
  it.each([{ isInvoice: 1 }, { invoiceNumber: '原PHP已开票编号' }])('requires whole-ticket coverage for actual issued facts %j', issued => {
    expect(() => plan(order(), carts(), selections(), { ...invoice(), ...issued }, '7.00', null)).toThrow('真实全额红冲');
    expect(() => plan(order(), carts(), selections(), { ...invoice(), ...issued }, '7.00', { ...coverage(), invoice_ids: [99] })).toThrow();
  });
  it.each([{ orderId: 99 }, { uid: 12 }, { category: 'other' }, { invoiceAmount: '7.00' }, { invoiceAmount: '18.74' },
    { isPay: 0 }, { isRefund: 1 }, { isDel: 1 }, { isInvoice: 2 }])('rejects another invoice identity, amount or lifecycle %j', patch => {
    expect(() => plan(order(), carts(), selections(), { ...invoice(), ...patch }, '7.00', null)).toThrow();
  });
  it('does not let a partial or manufactured quantity selection cancel a full original invoice', () => {
    expect(() => plan(order(), carts(), new Map([[51, 1]]), invoice(), '7.00', null)).toThrow();
    expect(() => plan(order(), carts(), new Map([[51, 1], [52, 1]]), invoice(), '7.00', null)).toThrow();
    expect(() => plan(order(), [carts()[0], carts()[0]], selections(), invoice(), '7.00', null)).toThrow();
    expect(() => plan(order(), carts().map(row => ({ ...row, oid: 32 })), selections(), invoice(), '7.00', null)).toThrow();
    expect(() => plan(order(), carts().map(row => ({ ...row, uid: 12 })), selections(), invoice(), '7.00', null)).toThrow();
    expect(() => plan({ ...order(), totalNum: 4 }, carts(), selections(), invoice(), '7.00', null)).toThrow();
  });
  it('rejects malformed manual coverage instead of turning a flag into verification authority', () => {
    for (const manual of [{ ...coverage(), coverage_hash: 'wrong' }, { ...coverage(), coverage_count: 2 },
      { ...coverage(), review_ids: ['not-a-real-uuid'] }, { ...coverage(), invoice_ids: [81, 81] },
      { ...coverage(), coverage_count: 2, review_ids: [...coverage().review_ids, ...coverage().review_ids] }]) {
      expect(() => plan(order(), carts(), selections(), invoice(), '7.00', manual)).toThrow();
    }
  });
  it.each(['18.76', '-0.01', '7.001', '7.0', '07.00', '7e0'])('rejects inconsistent or rounded cash %s', amount => {
    expect(() => plan(order(), carts(), selections(), invoice(), amount, null)).toThrow();
  });
  it('rejects unpaid/audit-root identities and unbounded histories', () => {
    expect(() => plan({ ...order(), paid: 0 }, carts(), selections(), invoice(), '7.00', null)).toThrow();
    expect(() => plan({ ...order(), pid: -1 }, carts(), selections(), invoice(), '7.00', null)).toThrow();
    expect(() => plan(order(), Array(201).fill(carts()[0]), selections(), invoice(), '7.00', null)).toThrow();
  });
});
