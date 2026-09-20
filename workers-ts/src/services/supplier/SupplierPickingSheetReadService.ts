import { and, eq, inArray } from 'drizzle-orm';
import type { Container } from '@/lib/di';
import { storeOrder, systemSupplier } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { parseSupplierSnapshot, readSupplierCarts, supplierReadIdentity, supplierReadSnapshot, supplierSnapshotObject } from './SupplierReadSupport';

const MAX_PICKING_SHEET_ORDERS = 10;
export const MAX_PICKING_SNAPSHOT_BYTES = 256 * 1024;
export interface PickingSheetCartSource {
  cartNum: number; skuUnique: string; settlePrice: string; cartInfo: string | null;
}
function pickingText(value: unknown, fallback: string, maximum: number) {
  const normalized = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  return (normalized || fallback).slice(0, maximum);
}
function minor(value: unknown): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') throw new ValidateException('商品快照金额格式错误');
  const text = String(value).trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) throw new ValidateException('商品快照金额格式错误');
  const [whole, fraction = ''] = text.split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (result > 100_000_000_000n) throw new ValidateException('商品快照金额超出范围');
  return result;
}
function money(value: bigint) { return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`; }
function project(row: PickingSheetCartSource, index: number, record: Record<string, unknown> | null) {
  const snapshot = record ?? {}, product = supplierSnapshotObject(snapshot.product), productInfo = supplierSnapshotObject(snapshot.productInfo);
  const sku = supplierSnapshotObject(snapshot.sku), attrInfo = supplierSnapshotObject(productInfo?.attrInfo);
  // PHP legacy snapshots may carry the quantity when the row was initialized to zero.
  const rawQuantity = row.cartNum === 0 ? snapshot.cart_num : row.cartNum;
  if ((typeof rawQuantity !== 'number' && typeof rawQuantity !== 'string') || !/^\d{1,10}$/.test(String(rawQuantity))) {
    throw new ValidateException('商品快照数量错误');
  }
  const quantity = Number(rawQuantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 2_147_483_647) throw new ValidateException('商品快照数量错误');
  // Supplier settlement cost is not the customer's sale price. Missing retail
  // evidence must not become a plausible but incorrect printable amount.
  const unitPrice = minor(snapshot.sum_price ?? sku?.price ?? snapshot.truePrice ?? snapshot.true_price);
  return {
    item: { index, product_name: pickingText(product?.storeName ?? productInfo?.store_name, '商品快照', 256),
      sku: pickingText(sku?.suk ?? attrInfo?.suk ?? row.skuUnique, '默认', 255),
      unit_price: money(unitPrice), quantity, subtotal: money(unitPrice * BigInt(quantity)),
    },
    vipDiscount: minor(snapshot.vip_truePrice ?? snapshot.vip_true_price ?? '0') * BigInt(quantity),
  };
}
export function projectPickingSheetCartItem(row: PickingSheetCartSource, index: number) {
  return project(row, index, parseSupplierSnapshot(row.cartInfo, MAX_PICKING_SNAPSHOT_BYTES)).item;
}
export function normalizeSupplierPickingSheetIds(value: string | undefined): number[] {
  const parts = String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (!parts.length) throw new ValidateException('请选择需要预览的订单');
  if (parts.length > MAX_PICKING_SHEET_ORDERS) throw new ValidateException(`每次最多预览${MAX_PICKING_SHEET_ORDERS}个订单`);
  const ids = parts.map(Number);
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647)) throw new ValidateException('订单ID格式错误');
  if (new Set(ids).size !== ids.length) throw new ValidateException('订单ID不能重复');
  return ids;
}

/** Explicit-ID print/history preview; it does not authorize or reserve shipping. */
export class SupplierPickingSheetReadService {
  constructor(private readonly container: Container) {}
  async read(supplierId: number, ids: number[]) {
    supplierReadIdentity(supplierId);
    if (!ids.length || ids.length > MAX_PICKING_SHEET_ORDERS || new Set(ids).size !== ids.length
      || ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647)) throw new ValidateException('配货单订单范围错误');
    return supplierReadSnapshot(this.container, async db => {
      const orders = await db.select({
        id: storeOrder.id, uid: storeOrder.uid, orderId: storeOrder.orderId,
        realName: storeOrder.realName, userPhone: storeOrder.userPhone, userAddress: storeOrder.userAddress,
        payTime: storeOrder.payTime, payType: storeOrder.payType, payPostage: storeOrder.payPostage,
        couponPrice: storeOrder.couponPrice, deductionPrice: storeOrder.deductionPrice,
        useIntegral: storeOrder.useIntegral, payPrice: storeOrder.payPrice, mark: storeOrder.mark, remark: storeOrder.remark,
      }).from(storeOrder).where(and(inArray(storeOrder.id, ids), eq(storeOrder.supplierId, supplierId), eq(storeOrder.isSystemDel, 0)));
      if (orders.length !== ids.length) throw new NotFoundException('部分订单不存在或不属于当前供应商');
      const carts = await readSupplierCarts(db, supplierId, orders, MAX_PICKING_SNAPSHOT_BYTES);
      const [supplier] = await db.select({ supplierName: systemSupplier.supplierName, phone: systemSupplier.phone,
        address: systemSupplier.address, detailedAddress: systemSupplier.detailedAddress,
      }).from(systemSupplier).where(and(eq(systemSupplier.id, supplierId), eq(systemSupplier.isDel, 0))).limit(1);
      if (!supplier) throw new NotFoundException('供应商不存在');
      const orderById = new Map(orders.map(order => [order.id, order]));
      const groups = new Map<number, typeof carts>();
      for (const cart of carts) { const group = groups.get(cart.oid) ?? []; group.push(cart); groups.set(cart.oid, group); }
      return {
        supplier: { name: pickingText(supplier.supplierName, '供应商', 50), phone: pickingText(supplier.phone, '', 15),
          address: [...new Set([supplier.address, supplier.detailedAddress].map(item => item.trim()).filter(Boolean))].join(' ').slice(0, 510),
        },
        list: ids.map(id => {
          const order = orderById.get(id)!;
          const projectedCarts = (groups.get(id) ?? []).map((cart, index) => project(cart, index + 1, cart.snapshot));
          return { id: order.id, order_id: order.orderId, real_name: order.realName, user_phone: order.userPhone,
            user_address: order.userAddress, pay_time: order.payTime, pay_type: order.payType,
            freight_price: order.payPostage, coupon_price: order.couponPrice,
            vip_true_price: money(projectedCarts.reduce((total, cart) => total + cart.vipDiscount, 0n)),
            deduction_price: order.deductionPrice, use_integral: order.useIntegral, pay_price: order.payPrice,
            mark: order.mark, supplier_remark: order.remark, items: projectedCarts.map(cart => cart.item),
          };
        }),
      };
    });
  }
}
