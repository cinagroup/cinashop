import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderStatus,
  systemSupplier,
} from "@/models/schema";
import {
  allocateSplitOrderAmounts,
  orderCartUnitWeight,
  reserveChildOrderIds,
} from "@/services/supplier/SupplierFulfillmentService";

type OrderRow = typeof storeOrder.$inferSelect;
type OrderInsert = typeof storeOrder.$inferInsert;
type CartRow = typeof storeOrderCartInfo.$inferSelect;
type CartInsert = typeof storeOrderCartInfo.$inferInsert;

export interface SupplierAllocationCart {
  id: number;
  type: number;
  relationId: number;
  cartNum: number;
  weight: bigint;
}

export interface SupplierAllocationGroup {
  supplierId: number;
  cartIds: number[];
  quantity: number;
  weight: bigint;
}

export interface SupplierAllocationResult {
  paymentOrder: OrderRow;
  fulfillmentOrders: OrderRow[];
  split: boolean;
}

/**
 * 对应 PHP ShareOrderJob 的经营主体判定：Supplier 商品归有效 Supplier，
 * 已关闭/删除的 Supplier 商品回落平台处理；旧快照无归属元数据时沿用订单 Supplier。
 */
export function buildSupplierAllocationPlan(
  carts: readonly SupplierAllocationCart[],
  activeSupplierIds: ReadonlySet<number>,
  fallbackSupplierId = 0,
): SupplierAllocationGroup[] {
  const hasOwnershipMetadata = carts.some(
    (cart) => cart.type === 1 || cart.type === 2 || cart.relationId > 0,
  );
  const legacyFallback =
    !hasOwnershipMetadata &&
    fallbackSupplierId > 0 &&
    activeSupplierIds.has(fallbackSupplierId)
      ? fallbackSupplierId
      : 0;
  const groups = new Map<number, SupplierAllocationGroup>();

  for (const cart of carts) {
    if (!Number.isSafeInteger(cart.id) || cart.id <= 0) throw new Error("订单商品快照 ID 无效");
    if (!Number.isSafeInteger(cart.cartNum) || cart.cartNum <= 0) {
      throw new Error("订单商品数量无效");
    }
    let supplierId = legacyFallback;
    if (!legacyFallback) {
      const supplierOwned = cart.type === 2 || (cart.type === 0 && cart.relationId > 0);
      supplierId =
        supplierOwned && activeSupplierIds.has(cart.relationId) ? cart.relationId : 0;
    }
    const unitWeight = cart.weight > 0n ? cart.weight : 1n;
    const group = groups.get(supplierId) ?? {
      supplierId,
      cartIds: [],
      quantity: 0,
      weight: 0n,
    };
    group.cartIds.push(cart.id);
    group.quantity += cart.cartNum;
    group.weight += unitWeight * BigInt(cart.cartNum);
    groups.set(supplierId, group);
  }

  // PHP 先递归拆 Supplier，最后保留平台商品；固定顺序也避免重试时金额余数漂移。
  const ordered = [...groups.values()];
  return [
    ...ordered.filter((group) => group.supplierId > 0),
    ...ordered.filter((group) => group.supplierId === 0),
  ];
}

function randomKey(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function cloneAllocatedCart(row: CartRow, oid: number): CartInsert {
  const { id: _id, ...base } = row;
  const available = Math.max(row.cartNum - row.refundNum, 0);
  return {
    ...base,
    oid,
    oldCartId: row.oldCartId || row.cartId,
    surplusNum: available,
    splitSurplusNum: available,
    splitStatus: available > 0 ? 0 : 2,
    unique: randomKey(),
  };
}

function allocateGroupAmounts(
  order: OrderRow,
  groups: readonly SupplierAllocationGroup[],
): Partial<OrderInsert>[] {
  let remainingOrder = order;
  let remainingWeight = groups.reduce((sum, group) => sum + group.weight, 0n);
  if (remainingWeight <= 0n) throw new Error("订单分配权重无效");
  return groups.map((group) => {
    const allocation = allocateSplitOrderAmounts(
      remainingOrder,
      group.weight,
      remainingWeight,
    );
    remainingOrder = { ...remainingOrder, ...allocation.remaining };
    remainingWeight -= group.weight;
    return allocation.selected;
  });
}

/**
 * 支付 outbox 事务内执行。调用者先锁 outbox 行，本方法再按
 * advisory lock -> 主单 -> 已有子单 -> 商品快照 -> Supplier 的固定顺序加锁。
 */
export async function allocatePaidOrderBySupplier(
  tx: DbClient,
  orderId: number,
  expectedOrderNo: string,
  now = Math.floor(Date.now() / 1000),
): Promise<SupplierAllocationResult> {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error("订单 ID 无效");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${orderId})`);

  const rootRows = await tx
    .select()
    .from(storeOrder)
    .where(eq(storeOrder.id, orderId))
    .limit(1)
    .for("update");
  const root = rootRows[0];
  if (!root || root.orderId !== expectedOrderNo || root.paid !== 1) {
    throw new Error("outbox 对应订单不存在、单号不匹配或尚未支付");
  }
  if (root.pid > 0) throw new Error("支付 outbox 不能指向拆分子单");

  const existingChildren = await tx
    .select()
    .from(storeOrder)
    .where(eq(storeOrder.pid, root.id))
    .orderBy(asc(storeOrder.id))
    .for("update");
  if (root.pid === -1) {
    if (!existingChildren.length) throw new Error("拆分审计主单缺少履约子单");
    if (root.supplierAllocationStatus !== 2) {
      await tx
        .update(storeOrder)
        .set({ supplierAllocationStatus: 2 })
        .where(eq(storeOrder.id, root.id));
    }
    return { paymentOrder: root, fulfillmentOrders: existingChildren, split: true };
  }
  if (existingChildren.length) throw new Error("未标记拆分的订单已存在履约子单");

  const cartRows = await tx
    .select()
    .from(storeOrderCartInfo)
    .where(eq(storeOrderCartInfo.oid, root.id))
    .orderBy(asc(storeOrderCartInfo.id))
    .for("update");
  if (!cartRows.length) throw new Error("支付订单缺少商品快照，不能分配 Supplier");
  if (new Set(cartRows.map((cart) => cart.cartId)).size !== cartRows.length) {
    throw new Error("支付订单商品快照 ID 重复，不能安全拆分");
  }
  const totalQuantity = cartRows.reduce((sum, cart) => sum + cart.cartNum, 0);
  if (totalQuantity !== root.totalNum) {
    throw new Error("支付订单商品数量与主单不一致，不能安全拆分");
  }

  const candidateSupplierIds = [
    ...new Set(
      cartRows
        .filter((cart) => cart.type === 2 || (cart.type === 0 && cart.relationId > 0))
        .map((cart) => cart.relationId)
        .filter((id) => id > 0),
    ),
  ].sort((a, b) => a - b);
  if (root.supplierId > 0 && !candidateSupplierIds.includes(root.supplierId)) {
    candidateSupplierIds.push(root.supplierId);
    candidateSupplierIds.sort((a, b) => a - b);
  }
  const activeSuppliers = candidateSupplierIds.length
    ? await tx
        .select({ id: systemSupplier.id })
        .from(systemSupplier)
        .where(
          and(
            inArray(systemSupplier.id, candidateSupplierIds),
            eq(systemSupplier.isShow, 1),
            eq(systemSupplier.isDel, 0),
          ),
        )
        .orderBy(asc(systemSupplier.id))
        .for("update")
    : [];
  const activeSupplierIds = new Set(activeSuppliers.map((supplier) => supplier.id));
  const plan = buildSupplierAllocationPlan(
    cartRows.map((cart) => ({
      id: cart.id,
      type: cart.type,
      relationId: cart.relationId,
      cartNum: cart.cartNum,
      weight: orderCartUnitWeight(cart),
    })),
    activeSupplierIds,
    root.supplierId,
  );
  if (!plan.length) throw new Error("支付订单无法生成 Supplier 分配计划");

  if (plan.length === 1) {
    if (root.supplierAllocationStatus === 2 && root.supplierId === plan[0].supplierId) {
      return { paymentOrder: root, fulfillmentOrders: [root], split: false };
    }
    const updated = await tx
      .update(storeOrder)
      .set({
        supplierId: plan[0].supplierId,
        supplierAllocationStatus: 2,
      })
      .where(eq(storeOrder.id, root.id))
      .returning();
    if (!updated[0]) throw new Error("订单 Supplier 归属更新失败");
    await tx.insert(storeOrderStatus).values({
      oid: root.id,
      changeType: "supplier_order_allocated",
      changeMessage:
        plan[0].supplierId > 0 ? "支付后订单已分配给供应商" : "支付后订单由平台履约",
      changeTime: now,
    });
    return { paymentOrder: updated[0], fulfillmentOrders: [updated[0]], split: false };
  }

  if (root.status !== 0 || root.isDel || root.isSystemDel) {
    throw new Error("混合订单状态已变化，不能执行支付后 Supplier 拆分");
  }
  if (cartRows.some((cart) => cart.splitStatus !== 0 || cart.splitSurplusNum <= 0)) {
    throw new Error("混合订单商品已进入其他拆分流程");
  }

  const amounts = allocateGroupAmounts(root, plan);
  const childOrderIds = reserveChildOrderIds(root.orderId, [], plan.length);
  const cartsById = new Map(cartRows.map((cart) => [cart.id, cart]));
  const { id: _rootId, ...rootBase } = root;
  const children: OrderRow[] = [];

  for (let index = 0; index < plan.length; index += 1) {
    const group = plan[index];
    const groupCarts = group.cartIds.map((id) => {
      const row = cartsById.get(id);
      if (!row) throw new Error("Supplier 分配计划引用了不存在的商品快照");
      return row;
    });
    const childRows = await tx
      .insert(storeOrder)
      .values({
        ...rootBase,
        ...amounts[index],
        pid: root.id,
        orderId: childOrderIds[index],
        supplierId: group.supplierId,
        supplierAllocationStatus: 2,
        unique: randomKey(),
        cartId: groupCarts.map((cart) => cart.cartId).join(","),
        totalNum: group.quantity,
      })
      .returning();
    const child = childRows[0];
    if (!child) throw new Error("Supplier 履约子单创建失败");
    await tx
      .insert(storeOrderCartInfo)
      .values(groupCarts.map((cart) => cloneAllocatedCart(cart, child.id)));
    await tx.insert(storeOrderStatus).values({
      oid: child.id,
      changeType: "supplier_split_create_order",
      changeMessage:
        group.supplierId > 0 ? "支付后按供应商自动拆单" : "支付后拆出平台履约订单",
      changeTime: now,
    });
    children.push(child);
  }

  await tx
    .update(storeOrderCartInfo)
    .set({ splitStatus: 2, splitSurplusNum: 0 })
    .where(eq(storeOrderCartInfo.oid, root.id));
  const marked = await tx
    .update(storeOrder)
    .set({ pid: -1, supplierId: 0, supplierAllocationStatus: 2 })
    .where(
      and(
        eq(storeOrder.id, root.id),
        eq(storeOrder.pid, 0),
        eq(storeOrder.paid, 1),
      ),
    )
    .returning({ id: storeOrder.id });
  if (!marked[0]) throw new Error("Supplier 拆分审计主单标记失败");
  await tx.insert(storeOrderStatus).values({
    oid: root.id,
    changeType: "supplier_order_split",
    changeMessage: `支付后已拆分为 ${children.length} 个履约订单`,
    changeTime: now,
  });

  return { paymentOrder: root, fulfillmentOrders: children, split: true };
}
