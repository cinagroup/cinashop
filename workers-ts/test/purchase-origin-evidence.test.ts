import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { verifyPurchaseOriginEvidence } from '@/services/order/PurchaseOriginEvidence';

const scope = { orderId: 12, buyerId: 11 };
const value = () => ({ version: 'purchase-origin-v1', ...scope, orderType: 6, totalNum: 3, usedPoints: 50,
  lines: [{ rowId: 21, cartId: '1', productId: 70, skuId: 31, skuUnique: 'sku1', quantity: 1, usedPoints: 50 },
    { rowId: 22, cartId: '2', productId: 70, skuId: 32, skuUnique: 'sku2', quantity: 2, usedPoints: 0 }] });
describe('original purchase evidence projections', () => {
  it('requires capture in the public adapter, before final admission, not in the readonly quote adapter', () => {
    const source = readFileSync(new URL('../src/services/order/StoreOrderCreateService.ts', import.meta.url), 'utf8');
    const publicAdapter = source.slice(source.indexOf('  async createOrder('), source.indexOf('  async quoteOrder('));
    const quoteAdapter = source.slice(source.indexOf('  async quoteOrder('), source.indexOf('  static createWithRuntime('));
    expect(publicAdapter).toContain('requirePurchaseOrigin: true');
    expect(quoteAdapter).not.toContain('requirePurchaseOrigin');
    const capture = source.indexOf('await recordPurchaseOriginEvidence(tx, { orderId: order.id, buyerId: uid })');
    expect(capture).toBeGreaterThan(source.indexOf('下单时先占用优惠券'));
    expect(capture).toBeLessThan(source.indexOf('const finalPresaleWindow'));
    expect(source.match(/await recordPurchaseOriginEvidence\(/g)).toHaveLength(1);
  });
  it('retains multiple original SKU lines, product identity, and exact points', () => {
    expect(verifyPurchaseOriginEvidence(value(), scope)).toEqual(value());
  });
  it.each([{ orderId: 13 }, { buyerId: 22 }, { version: 'unknown' }, { orderType: 9 }, { totalNum: 2 },
    { totalNum: 0 }, { usedPoints: 49 }, { usedPoints: 50.1 }, { lines: [] }, { lines: null }])('rejects envelope drift %j', patch => {
    expect(() => verifyPurchaseOriginEvidence({ ...value(), ...patch }, scope)).toThrow();
  });
  it.each([{ rowId: 22 }, { rowId: 0 }, { cartId: '2' }, { cartId: '01' }, { cartId: '2147483648' },
    { productId: 0 }, { skuId: 0 }, { skuUnique: 'x'.repeat(256) }, { quantity: 2 }, { quantity: 0 },
    { quantity: 32768 }, { usedPoints: -1 }, { usedPoints: '50' }, { customerPhone: 'NOT-RETAINED' }])('rejects line drift %j', patch => {
    const row = value(); Object.assign(row.lines[0], patch);
    expect(() => verifyPurchaseOriginEvidence(row, scope)).toThrow();
  });
  it('supports guest identity zero without treating it as a named member quota', () => {
    const guest = { ...scope, buyerId: 0 };
    expect(verifyPurchaseOriginEvidence({ ...value(), ...guest }, guest).buyerId).toBe(0);
  });
  it('rejects over 200 lines before processing them', () => {
    expect(() => verifyPurchaseOriginEvidence({ ...value(), lines: Array(201).fill(value().lines[0]) }, scope)).toThrow();
  });
  it('requires integer identities even when a forged envelope agrees', () => {
    const wrong = { orderId: 12, buyerId: -1 };
    expect(() => verifyPurchaseOriginEvidence({ ...value(), ...wrong }, wrong)).toThrow();
  });
});
