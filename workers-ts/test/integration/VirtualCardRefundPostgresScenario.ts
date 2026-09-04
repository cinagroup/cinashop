import { and, count, eq, sql } from "drizzle-orm";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderRefund,
  storeProductVirtual,
} from "@/models/schema";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
  withTx,
} from "@/lib/di";
import { applyOrderRefund } from "@/services/order/StoreOrderRefundService";
import {
  deliverPaidVirtualOrders,
  parseVirtualDeliveryInfo,
  type VirtualDeliveryOrder,
} from "@/services/order/VirtualProductDeliveryService";

const CLONED_TABLES = [
  "store_order",
  "store_order_cart_info",
  "store_order_refund",
  "store_order_status",
  "store_order_outbox",
  "store_product_virtual",
] as const;

const LOCAL_SEQUENCE_TABLES = [
  "store_order_refund",
  "store_order_status",
  "store_order_outbox",
] as const;

interface PublicSnapshot {
  orders: number;
  cart_infos: number;
  refunds: number;
  statuses: number;
  outbox_rows: number;
  cards: number;
  refund_sequence: string | null;
  status_sequence: string | null;
  outbox_sequence: string | null;
}

export interface VirtualCardProductionInventory {
  active_type1_products: number;
  platform_type1_products: number;
  supplier_type1_products: number;
  type1_skus: number;
  available_cards: number;
  assigned_cards: number;
  type1_order_lines: number;
  type1_orders: number;
  orphan_assigned_cards: number;
}

export interface VirtualCardRefundPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  public_state_unchanged: boolean;
  production_inventory: VirtualCardProductionInventory;
  delivered_card_customer_rejected: boolean;
  admin_goodwill_refund_created: boolean;
  admin_refund_snapshot_has_no_secret: boolean;
  assigned_card_never_recycled: boolean;
  open_refund_blocks_delivery: boolean;
  open_refund_keeps_card_unassigned: boolean;
  partial_refund_delivers_remaining_quantity: boolean;
  fully_refunded_order_not_delivered: boolean;
  fixed_content_customer_refund_created: boolean;
  malformed_snapshot_rejected: boolean;
  return_logistics_rejected: boolean;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PostgreSQL virtual-card refund audit failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_virtual_refund_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function withSchema<T>(
  db: DbClient,
  schemaName: string,
  fn: (container: Container) => Promise<T>,
): Promise<T> {
  const root = createContainerFromDb(db);
  return withTx(root, async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schemaName)}, public`));
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '20s'`);
    return fn(createContainerFromDb(tx));
  });
}

async function publicSnapshot(db: DbClient): Promise<PublicSnapshot> {
  const rows = await db.$client<PublicSnapshot[]>`
    SELECT
      (SELECT count(*)::integer FROM public.store_order) AS orders,
      (SELECT count(*)::integer FROM public.store_order_cart_info) AS cart_infos,
      (SELECT count(*)::integer FROM public.store_order_refund) AS refunds,
      (SELECT count(*)::integer FROM public.store_order_status) AS statuses,
      (SELECT count(*)::integer FROM public.store_order_outbox) AS outbox_rows,
      (SELECT count(*)::integer FROM public.store_product_virtual) AS cards,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_refund_id_seq') AS refund_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_status_id_seq') AS status_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_outbox_id_seq') AS outbox_sequence
  `;
  assertCondition(rows[0], "public snapshot unavailable");
  return rows[0];
}

async function productionInventory(db: DbClient): Promise<VirtualCardProductionInventory> {
  const rows = await db.$client<VirtualCardProductionInventory[]>`
    SELECT
      (SELECT count(*)::integer FROM public.store_product
        WHERE product_type = 1 AND is_del = 0) AS active_type1_products,
      (SELECT count(*)::integer FROM public.store_product
        WHERE product_type = 1 AND type = 0 AND is_del = 0) AS platform_type1_products,
      (SELECT count(*)::integer FROM public.store_product
        WHERE product_type = 1 AND type = 2 AND is_del = 0) AS supplier_type1_products,
      (SELECT count(*)::integer FROM public.store_product_attr_value
        WHERE type = 0 AND product_id IN (
          SELECT id FROM public.store_product WHERE product_type = 1 AND is_del = 0
        )) AS type1_skus,
      (SELECT count(*)::integer FROM public.store_product_virtual WHERE uid = 0) AS available_cards,
      (SELECT count(*)::integer FROM public.store_product_virtual WHERE uid <> 0) AS assigned_cards,
      (SELECT count(*)::integer FROM public.store_order_cart_info WHERE product_type = 1) AS type1_order_lines,
      (SELECT count(*)::integer FROM public.store_order WHERE product_type = 1) AS type1_orders,
      (SELECT count(*)::integer
        FROM public.store_product_virtual card
        WHERE card.uid <> 0 AND NOT EXISTS (
          SELECT 1 FROM public.store_order order_row
          WHERE order_row.order_id = card.order_id AND order_row.uid = card.uid
        )) AS orphan_assigned_cards
  `;
  assertCondition(rows[0], "production inventory summary unavailable");
  return rows[0];
}

function fixture(base: number, offset: number) {
  return {
    uid: base + 100 + offset,
    orderId: base + 200 + offset,
    cartInfoId: base + 300 + offset,
    productId: base + 400 + offset,
    cardId: base + 500 + offset * 3,
    orderNo: `VC${base}${offset}`,
    skuUnique: `VC${String(offset).padStart(6, "0")}`,
  };
}

function deliveryOrder(base: number, offset: number): VirtualDeliveryOrder {
  const item = fixture(base, offset);
  return {
    id: item.orderId,
    uid: item.uid,
    orderId: item.orderNo,
    paid: 1,
    status: offset === 0 || offset === 4 ? 1 : 0,
    isDel: 0,
    isSystemDel: 0,
    productType: 1,
  };
}

async function seedFixtures(db: DbClient, schemaName: string, base: number): Promise<void> {
  await withSchema(db, schemaName, async ({ db: tx }) => {
    const offsets = [0, 1, 2, 3, 4, 5, 6];
    await tx.insert(storeOrder).values(offsets.map((offset) => {
      const item = fixture(base, offset);
      const delivered = offset === 0 || offset === 4;
      return {
        id: item.orderId,
        orderId: item.orderNo,
        unique: `virtual-card-refund-${base}-${offset}`,
        uid: item.uid,
        totalNum: offset === 2 ? 2 : 1,
        totalPrice: offset === 2 ? "20.00" : "10.00",
        payPrice: offset === 2 ? "20.00" : "10.00",
        paid: 1,
        status: delivered ? 1 : 0,
        productType: 1,
        refundStatus: offset === 2 ? 3 : offset === 3 ? 2 : 0,
        deliveryType: delivered ? "fictitious" : "",
        virtualInfo: offset === 0
          ? JSON.stringify([{ card_no: "AUDIT-CARD", card_pwd: "AUDIT-PASSWORD" }])
          : offset === 4
            ? JSON.stringify([{ disk_info: "AUDIT-LICENSE", product_id: item.productId, sku_unique: item.skuUnique, quantity: 1 }])
            : null,
        isDel: 0,
        isSystemDel: 0,
        supplierAllocationStatus: 0,
      };
    }));
    await tx.insert(storeOrderCartInfo).values(offsets.map((offset) => {
      const item = fixture(base, offset);
      return {
        id: item.cartInfoId,
        uid: item.uid,
        oid: item.orderId,
        cartId: String(item.cartInfoId),
        unique: `virtual-refund-cart-${base}-${offset}`,
        productId: item.productId,
        productType: 1,
        skuUnique: item.skuUnique,
        isSupportRefund: 1,
        cartNum: offset === 2 ? 2 : 1,
        refundNum: offset === 2 ? 1 : offset === 3 ? 1 : 0,
        surplusNum: offset === 2 ? 1 : offset === 3 ? 0 : 1,
        splitSurplusNum: offset === 2 ? 1 : offset === 3 ? 0 : 1,
        cartInfo: offset === 5
          ? JSON.stringify({ sku: {} })
          : JSON.stringify({
              sum_true_price: offset === 2 ? "20.00" : "10.00",
              sku: {
                price: "10.00",
                disk_info: offset === 4 ? "AUDIT-LICENSE" : "",
              },
            }),
      };
    }));
    const cardRows: Array<typeof storeProductVirtual.$inferInsert> = [];
    for (const offset of [0, 1, 2, 3, 6]) {
      const item = fixture(base, offset);
      const quantity = offset === 2 ? 2 : 1;
      for (let index = 0; index < quantity; index += 1) {
        cardRows.push({
          id: item.cardId + index,
          productId: item.productId,
          attrUnique: item.skuUnique,
          cardNo: `AUDIT-${offset}-${index}`,
          cardPwd: `AUDIT-PWD-${offset}-${index}`,
          cardUnique: `audit-${base}-${offset}-${index}`.slice(0, 32),
          orderId: offset === 0 ? item.orderNo : "",
          orderType: 1,
          uid: offset === 0 ? item.uid : 0,
        });
      }
    }
    await tx.insert(storeProductVirtual).values(cardRows);
  });
}

function errorIncludes(error: unknown, expected: string): boolean {
  return error instanceof Error && error.message.includes(expected);
}

export async function runVirtualCardRefundPostgresScenario(
  connectionString: string,
): Promise<VirtualCardRefundPostgresReport> {
  const schemaName = makeSchemaName();
  const schema = identifier(schemaName);
  const adminDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_virtual_card_refund_audit",
  });
  let created = false;
  let schemaRemoved = false;
  let before: PublicSnapshot | undefined;
  let after: PublicSnapshot | undefined;
  let report: Omit<VirtualCardRefundPostgresReport, "schema_removed" | "public_state_unchanged"> | undefined;

  try {
    const [versionRows, inventory] = await Promise.all([
      adminDb.$client<{ server_version: string }[]>`
        SELECT current_setting('server_version') AS server_version
      `,
      productionInventory(adminDb),
    ]);
    before = await publicSnapshot(adminDb);
    await adminDb.$client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '20s'`;
      await tx.unsafe(`CREATE SCHEMA ${schema}`);
      for (const table of CLONED_TABLES) {
        const tableName = identifier(table);
        await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
      }
      for (const table of LOCAL_SEQUENCE_TABLES) {
        const tableName = identifier(table);
        const sequenceName = identifier(`${table}_id_seq_it`);
        await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequenceName}`);
        await tx.unsafe(`ALTER SEQUENCE ${schema}.${sequenceName} OWNED BY ${schema}.${tableName}."id"`);
        await tx.unsafe(
          `ALTER TABLE ${schema}.${tableName} ALTER COLUMN "id" SET DEFAULT nextval('${schemaName}.${table}_id_seq_it'::regclass)`,
        );
      }
    });
    created = true;

    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const base = 1_400_000_000 + (random[0] % 20_000_000);
    await seedFixtures(adminDb, schemaName, base);

    let deliveredCustomerRejected = false;
    try {
      const item = fixture(base, 0);
      await withSchema(adminDb, schemaName, (container) => applyOrderRefund(container, {
        uid: item.uid,
        orderId: item.orderNo,
        refundReason: "audit delivered card customer refund",
        refundExplain: "audit",
        applyType: 1,
      }));
    } catch (error) {
      deliveredCustomerRejected = errorIncludes(error, "密钥不可回收");
    }

    const delivered = fixture(base, 0);
    const adminRefund = await withSchema(adminDb, schemaName, (container) => applyOrderRefund(container, {
      uid: delivered.uid,
      orderId: delivered.orderNo,
      refundReason: "audit admin goodwill refund",
      refundExplain: "assigned secret remains non-recyclable",
      applyType: 4,
      privilegedActor: "admin",
      expectedRefundAmountCents: 1_000,
      applicationOrderId: `VCRA${base}`,
      audit: {
        changeType: "admin_refund_apply",
        changeMessage: "生产隔离审计：管理员卡密善意退款",
      },
    }));
    const [adminRefundRows, assignedRows] = await withSchema(adminDb, schemaName, async ({ db: tx }) => Promise.all([
      tx.select({ cartInfo: storeOrderRefund.cartInfo }).from(storeOrderRefund)
        .where(eq(storeOrderRefund.id, adminRefund.refundId)).limit(1),
      tx.select({ uid: storeProductVirtual.uid, orderId: storeProductVirtual.orderId })
        .from(storeProductVirtual).where(eq(storeProductVirtual.id, delivered.cardId)).limit(1),
    ]));
    const adminSnapshot = adminRefundRows[0]?.cartInfo ?? "";

    const open = fixture(base, 1);
    await withSchema(adminDb, schemaName, (container) => applyOrderRefund(container, {
      uid: open.uid,
      orderId: open.orderNo,
      refundReason: "audit open refund",
      refundExplain: "blocks automatic delivery",
      applyType: 1,
    }));
    let openRefundBlocksDelivery = false;
    try {
      await withSchema(adminDb, schemaName, ({ db: tx }) =>
        deliverPaidVirtualOrders(tx, [deliveryOrder(base, 1)], Math.floor(Date.now() / 1000))
      );
    } catch (error) {
      openRefundBlocksDelivery = errorIncludes(error, "进行中的退款申请");
    }
    const openCards = await withSchema(adminDb, schemaName, ({ db: tx }) =>
      tx.select({ value: count() }).from(storeProductVirtual).where(and(
        eq(storeProductVirtual.productId, open.productId),
        eq(storeProductVirtual.uid, 0),
      ))
    );

    const partialDelivery = await withSchema(adminDb, schemaName, ({ db: tx }) =>
      deliverPaidVirtualOrders(tx, [deliveryOrder(base, 2)], Math.floor(Date.now() / 1000))
    );
    const partial = fixture(base, 2);
    const [partialOrders, partialAssigned] = await withSchema(adminDb, schemaName, async ({ db: tx }) => Promise.all([
      tx.select({ virtualInfo: storeOrder.virtualInfo }).from(storeOrder)
        .where(eq(storeOrder.id, partial.orderId)).limit(1),
      tx.select({ value: count() }).from(storeProductVirtual).where(and(
        eq(storeProductVirtual.productId, partial.productId),
        eq(storeProductVirtual.uid, partial.uid),
      )),
    ]));
    const partialInfo = parseVirtualDeliveryInfo(partialOrders[0]?.virtualInfo ?? null);

    const fullDelivery = await withSchema(adminDb, schemaName, ({ db: tx }) =>
      deliverPaidVirtualOrders(tx, [deliveryOrder(base, 3)], Math.floor(Date.now() / 1000))
    );
    const fullyRefunded = fixture(base, 3);
    const fullCards = await withSchema(adminDb, schemaName, ({ db: tx }) =>
      tx.select({ value: count() }).from(storeProductVirtual).where(and(
        eq(storeProductVirtual.productId, fullyRefunded.productId),
        eq(storeProductVirtual.uid, 0),
      ))
    );

    const fixed = fixture(base, 4);
    const fixedRefund = await withSchema(adminDb, schemaName, (container) => applyOrderRefund(container, {
      uid: fixed.uid,
      orderId: fixed.orderNo,
      refundReason: "audit fixed content refund",
      refundExplain: "immutable snapshot allows refund",
      applyType: 1,
    }));

    let malformedRejected = false;
    try {
      const malformed = fixture(base, 5);
      await withSchema(adminDb, schemaName, (container) => applyOrderRefund(container, {
        uid: malformed.uid,
        orderId: malformed.orderNo,
        refundReason: "audit malformed snapshot",
        refundExplain: "must fail closed",
        applyType: 1,
      }));
    } catch (error) {
      malformedRejected = errorIncludes(error, "快照缺失");
    }

    let returnRejected = false;
    try {
      const virtualReturn = fixture(base, 6);
      await withSchema(adminDb, schemaName, (container) => applyOrderRefund(container, {
        uid: virtualReturn.uid,
        orderId: virtualReturn.orderNo,
        refundReason: "audit virtual return logistics",
        refundExplain: "must use refund-only",
        applyType: 2,
      }));
    } catch (error) {
      returnRejected = errorIncludes(error, "仅支持仅退款");
    }

    report = {
      server_version: versionRows[0]?.server_version ?? "unknown",
      schema_created: true,
      production_inventory: inventory,
      delivered_card_customer_rejected: deliveredCustomerRejected,
      admin_goodwill_refund_created: adminRefund.refundId > 0,
      admin_refund_snapshot_has_no_secret:
        Boolean(adminSnapshot) && !adminSnapshot.includes("AUDIT-CARD") && !adminSnapshot.includes("AUDIT-PASSWORD"),
      assigned_card_never_recycled:
        assignedRows[0]?.uid === delivered.uid && assignedRows[0]?.orderId === delivered.orderNo,
      open_refund_blocks_delivery: openRefundBlocksDelivery,
      open_refund_keeps_card_unassigned: Number(openCards[0]?.value ?? 0) === 1,
      partial_refund_delivers_remaining_quantity:
        partialDelivery.deliveredOrders === 1 && partialDelivery.deliveredCards === 1 &&
        Number(partialAssigned[0]?.value ?? 0) === 1 && Array.isArray(partialInfo) && partialInfo.length === 1,
      fully_refunded_order_not_delivered:
        fullDelivery.deliveredOrders === 0 && fullDelivery.deliveredCards === 0 &&
        Number(fullCards[0]?.value ?? 0) === 1,
      fixed_content_customer_refund_created: fixedRefund.refundId > 0,
      malformed_snapshot_rejected: malformedRejected,
      return_logistics_rejected: returnRejected,
    };
    for (const [key, value] of Object.entries(report)) {
      if (typeof value === "boolean") assertCondition(value, `${key} is false`);
    }
  } finally {
    try {
      if (created) {
        await adminDb.$client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '3s'`;
          await tx`SET LOCAL statement_timeout = '20s'`;
          await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        });
      }
      const schemaRows = await adminDb.$client<{ schema_removed: boolean }[]>`
        SELECT to_regnamespace(${schemaName}) IS NULL AS schema_removed
      `;
      schemaRemoved = schemaRows[0]?.schema_removed === true;
      after = await publicSnapshot(adminDb);
    } finally {
      await adminDb.$client.end({ timeout: 1 });
    }
  }

  assertCondition(report, "scenario did not produce a report");
  assertCondition(before && after, "public snapshots are missing");
  assertCondition(schemaRemoved, "temporary schema was not removed");
  const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(publicStateUnchanged, "public rows or sequences changed");
  return {
    ...report,
    schema_removed: schemaRemoved,
    public_state_unchanged: publicStateUnchanged,
  };
}
