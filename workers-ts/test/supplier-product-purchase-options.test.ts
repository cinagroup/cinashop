import { describe, expect, it } from 'vitest';
import { supplierProductPurchaseInput, supplierProductPurchasePlan } from '@/services/supplier/SupplierProductPurchaseOptions';
import { productPurchaseEditor, productPurchasePayload } from '../../view/supplier-ts/src/utils/productPurchaseOptions';
import type { storeProduct } from '@/models/schema';
const old = { isVipProduct: 1, isPresaleProduct: 1, presaleStartTime: 100, presaleEndTime: 200, presaleDay: 7 } as typeof storeProduct.$inferSelect;
const read = { version: 1, is_vip_product: 1, is_presale_product: 1, presale_start_time: 100, presale_end_time: 200, presale_day: 7 };
describe('Supplier paid-member qualification and full-payment presale author', () => {
  it('keeps omission distinct from explicit disabled flags', () => {
    expect(supplierProductPurchaseInput({})).toBeUndefined();
    expect(supplierProductPurchaseInput({ is_vip_product: undefined, is_presale_product: undefined })).toBeUndefined();
    const input = supplierProductPurchaseInput({ is_vip_product: 0 })!;
    expect(supplierProductPurchasePlan(input, old)).toMatchObject({ isVipProduct: 0, isPresaleProduct: 1, presaleStartTime: 100, presaleEndTime: 200, authored: false, requireFuture: false });
  });
  it.each([1, '1', true])('accepts legacy member-only input %j', value => expect(supplierProductPurchaseInput({ is_vip_product: value })).toEqual({ isVipProduct: 1 }));
  it.each([null, [], {}, 'yes', 2, -1, 0.5])('rejects invalid member-only input %j', value => expect(() => supplierProductPurchaseInput({ is_vip_product: value })).toThrow('专属'));
  it('normalizes Shanghai and explicit UTC without using the host timezone', () => {
    expect(supplierProductPurchaseInput({ is_presale_product: '1', presale_time: ['2030-01-01 08:00:00', '2030-01-01T01:00:00Z'], presale_day: '7' }))
      .toEqual({ isPresaleProduct: 1, presalePeriod: [1893456000, 1893459600], presaleDay: 7 });
  });
  it.each([{ presale_time: [1] }, { presale_time: null }, { presale_time: ['2030-02-30 08:00:00', 9] }, { presale_day: -1 }, { presale_day: 1.5 }, { is_presale_product: 2 }])('rejects malformed presale intent %j', input => expect(() => supplierProductPurchaseInput(input)).toThrow());
  it('retains a running window for a days-only edit and clears the window only on explicit disable', () => {
    expect(supplierProductPurchasePlan({ presaleDay: 9 }, old)).toMatchObject({ presaleStartTime: 100, presaleEndTime: 200, presaleDay: 9, requireFuture: false });
    expect(supplierProductPurchasePlan({ isPresaleProduct: 0 }, old)).toMatchObject({ isPresaleProduct: 0, presaleStartTime: 0, presaleEndTime: 0, presaleDay: 7 });
    expect(supplierProductPurchasePlan({ presalePeriod: [150, 300] }, old).requireFuture).toBe(true);
    expect(() => supplierProductPurchasePlan({ isPresaleProduct: 1 })).toThrow('起止时间');
    expect(() => supplierProductPurchasePlan({ isPresaleProduct: 0, presalePeriod: [1, 2] }, old)).toThrow('关闭预售');
  });
  it('reads exact versioned state, preserving an already-started schedule on ordinary save', () => {
    const editor = productPurchaseEditor(read); expect(editor).toMatchObject({ ready: true, memberOnly: true, presale: true, days: 7 });
    expect(productPurchasePayload(editor)).toEqual({});
    expect(productPurchasePayload({ ...editor, days: 8, daysChanged: true })).toEqual({ presale_day: 8 });
    expect(productPurchasePayload({ ...editor, memberOnly: false, memberChanged: true })).toEqual({ is_vip_product: 0 });
    expect(productPurchasePayload({ ...editor, presale: false, presaleChanged: true, periodChanged: true })).toEqual({ is_presale_product: 0 });
  });
  it('writes edited Shanghai periods and independent membership intent', () => {
    const editor = { ...productPurchaseEditor(undefined, true), memberOnly: true, memberChanged: true, presale: true, presaleChanged: true,
      periodChanged: true, startsAt: '2030-01-01T08:00:00', endsAt: '2030-01-01T09:00:00', days: 3, daysChanged: true };
    expect(productPurchasePayload(editor)).toEqual({ is_vip_product: 1, is_presale_product: 1, presale_time: [1893456000, 1893459600], presale_day: 3 });
    expect(() => productPurchasePayload({ ...editor, endsAt: '2029-12-31T08:00:00' })).toThrow('不能早于');
  });
  it('disables unknown old state without inventing clear intent', () => {
    const editor = productPurchaseEditor(); expect(editor.ready).toBe(false);
    expect(productPurchasePayload({ ...editor, memberChanged: true, presaleChanged: true })).toEqual({});
    expect(productPurchaseEditor(undefined, true).ready).toBe(true);
    expect(() => productPurchasePayload({ ...productPurchaseEditor(undefined, true), presale: true, presaleChanged: true })).toThrow('完整的起止时间');
  });
  it.each([null, [], {}, { ...read, version: 2 }, { ...read, is_vip_product: '1' }, { ...read, extra: true }, { ...read, presale_day: -1 }, { ...read, presale_end_time: 1 }])('rejects corrupt read state %j', value => expect(() => productPurchaseEditor(value)).toThrow('响应无效'));
});
