import type { PickingSheetResult } from '@/types';

const invalid = () => new Error('配货单数据不完整或与所选订单不一致，请重新加载核对');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || value.length > max) throw invalid();
  return value;
}
function integer(value: unknown, min = 0, max = 2_147_483_647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid();
  return value;
}
function money(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,30}(?:\.\d{1,2})?$/.test(value)) throw invalid();
  return value;
}
function cents(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
/** Keep cents exact even for a large valid quantity subtotal. No Number coercion. */
export function formatPickingMoney(value: string): string {
  const [whole, fraction = ''] = money(value).split('.');
  return `¥${whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0')}`;
}
export function parsePickingOrderIds(value: unknown): number[] {
  if (typeof value !== 'string') throw new Error('请选择需要预览的订单');
  const parts = value.split(',').map(item => item.trim()).filter(Boolean);
  if (!parts.length) throw new Error('请选择需要预览的订单');
  if (parts.length > 10) throw new Error('每次最多预览10个订单');
  const ids = parts.map(Number);
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647)) throw new Error('订单ID格式错误');
  if (new Set(ids).size !== ids.length) throw new Error('订单ID不能重复');
  return ids;
}
/** Validate the complete receipt before showing any printable customer data.
 * This is response consistency, not a replacement for server authorization. */
export function parsePickingSheets(value: unknown, ids: readonly number[]): PickingSheetResult {
  if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length) throw invalid();
  ids.forEach(id => integer(id, 1));
  const result = object(value), supplier = object(result.supplier);
  if (!Array.isArray(result.list) || result.list.length !== ids.length) throw invalid();
  let count = 0;
  const list = result.list.map((value, orderIndex) => {
    const row = object(value), id = integer(row.id, 1), orderId = text(row.order_id, 64);
    if (id !== ids[orderIndex] || !orderId.trim() || !Array.isArray(row.items)) throw invalid();
    count += row.items.length;
    if (count > 200) throw invalid();
    const items = row.items.map((value, itemIndex) => {
      const item = object(value), index = integer(item.index, 1, 200), quantity = integer(item.quantity, 1);
      const unitPrice = money(item.unit_price), subtotal = money(item.subtotal);
      if (index !== itemIndex + 1 || cents(unitPrice) * BigInt(quantity) !== cents(subtotal)) throw invalid();
      return { index, product_name: text(item.product_name, 256), sku: text(item.sku, 255),
        unit_price: unitPrice, quantity, subtotal };
    });
    return { id, order_id: orderId, real_name: text(row.real_name), user_phone: text(row.user_phone),
      user_address: text(row.user_address), pay_time: integer(row.pay_time), pay_type: text(row.pay_type, 32),
      freight_price: money(row.freight_price), coupon_price: money(row.coupon_price), vip_true_price: money(row.vip_true_price),
      deduction_price: money(row.deduction_price), use_integral: money(row.use_integral), pay_price: money(row.pay_price),
      mark: text(row.mark), supplier_remark: text(row.supplier_remark), items };
  });
  return { supplier: { name: text(supplier.name, 50), phone: text(supplier.phone, 15), address: text(supplier.address, 510) }, list };
}
