import { asc, count, eq, inArray, sql } from "drizzle-orm";
import {
  storePink,
  storeOrder,
  storeOrderCartInfo,
  storeOrderInvoice,
  storeOrderRefund,
  storeOrderRefundPayment,
  storeOrderStatus,
  storeProduct,
  storeProductAttrValue,
  supplierFlowingWater,
  supplierTransactions,
  user as userTable,
  userBill,
  userBrokerage,
} from "@/models/schema";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
  withTx,
} from "@/lib/di";
import {
  applyOrderRefund,
  finalizeStoreOrderRefund,
  type RefundFinalizationOutcome,
} from "@/services/order/StoreOrderRefundService";
import { ScheduledMaintenanceService } from "@/services/order/ScheduledMaintenanceService";
import type {
  Env,
  OrderMessage,
  PinkTimeoutMessage,
  ScheduledMaintenanceMessage,
} from "@/env";

const CLONED_TABLES = [
  "user",
  "user_bill",
  "user_brokerage",
  "supplier_flowing_water",
  "supplier_transactions",
  "store_pink",
  "store_order",
  "store_order_cart_info",
  "store_order_invoice",
  "store_order_refund",
  "store_order_refund_payment",
  "store_order_status",
  "store_product",
  "store_product_attr_value",
] as const;

const LOCAL_SEQUENCE_TABLES = [
  "user_bill",
  "user_brokerage",
  "supplier_flowing_water",
  "supplier_transactions",
  "store_pink",
  "store_order_refund",
  "store_order_status",
] as const;

interface PublicSnapshot {
  users: number;
  user_bills: number;
  brokerages: number;
  supplier_flows: number;
  supplier_transactions: number;
  pinks: number;
  orders: number;
  cart_infos: number;
  invoices: number;
  refunds: number;
  refund_payments: number;
  statuses: number;
  products: number;
  skus: number;
  user_bill_sequence: string | null;
  user_brokerage_sequence: string | null;
  supplier_flow_sequence: string | null;
  supplier_transaction_sequence: string | null;
  pink_sequence: string | null;
  refund_sequence: string | null;
  status_sequence: string | null;
}

export interface StoreOrderRefundPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  public_state_unchanged: boolean;
  duplicate_balance_refund: {
    completed: number;
    already_completed: number;
    balance: string;
    bill_rows: number;
    status_rows: number;
    stock_restored_once: boolean;
  };
  balance_failure_atomicity: {
    failure_rolled_back: boolean;
    retry_completed: boolean;
    balance: string;
    bill_rows: number;
    status_rows: number;
    stock_restored_once: boolean;
  };
  cumulative_over_refund_race: {
    completed: number;
    rejected: number;
    business_rejected: boolean;
    cumulative_refund: string;
    balance: string;
    bill_rows: number;
  };
  cumulative_exact_refund_race: {
    completed: number;
    cumulative_refund: string;
    fully_refunded: boolean;
    balance: string;
    bill_rows: number;
  };
  pure_integral_refund: {
    first_completed: boolean;
    replay_converged: boolean;
    partial_integral: number;
    partial_refund_status: number;
    fully_refunded: boolean;
    final_integral: number;
    returned_integral: number;
    bill_rows: number;
  };
  provider_amount_binding: {
    mismatch_rolled_back: boolean;
    retry_completed: boolean;
    cumulative_refund: string;
    status_rows: number;
  };
  cumulative_compensation_invariants: {
    failure_rolled_back: boolean;
    completed: number;
    balance: string;
    integral: number;
    returned_integral: string;
    reversed_grant_points: number;
    returned_used_points: number;
    brokerage_balance: string;
    brokerage_reversed: string;
    supplier_reversed: string;
    supplier_refund_rows: number;
    supplier_refund_deltas: string[];
    pink_member_refunded: boolean;
    pink_active_members: number;
  };
  pink_leader_refund_promotion: {
    completed: boolean;
    refunded_leader: boolean;
    promoted_leader_id: number;
    promoted_member_count: number;
    followers_reparented: boolean;
    member_orders_relinked: boolean;
  };
  pink_timeout_redelivery_recovery: {
    scan_enqueued_failed_groups: number;
    concurrent_deliveries: number;
    group_orders_refunded: number;
    group_refund_rows: number;
    group_bill_rows: number;
    replay_converged: boolean;
    partial_refund_rows: number;
    partial_refund_amounts: string[];
    partial_refund_cart_ids: number[];
    partial_balance: string;
    completed_groups_left_in_scan: number;
  };
}

interface RefundFixtureState {
  balance: string;
  integral: number;
  backIntegral: string;
  orderRefundPrice: string;
  orderRefundStatus: number;
  refundTypes: number[];
  refundedPrices: string[];
  billRows: number;
  statusRows: number;
  invoiceRefunded: number;
  productStock: number | null;
  productSales: number | null;
  skuStock: number | null;
  skuSales: number | null;
}

interface CompensationState extends RefundFixtureState {
  reversedGrantPoints: number;
  returnedUsedPoints: number;
  brokerageBalance: string;
  brokerageReversed: string;
  brokerageOneReversed: string;
  brokerageStaffReversed: string;
  brokerageRefundRows: number;
  supplierReversed: string;
  supplierRefundRows: number;
  supplierRefundDeltas: string[];
  supplierTransactionRows: number;
  pinkMemberIsRefund: number;
  pinkMemberStatus: number;
  pinkLeaderMemberCount: number;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PostgreSQL refund integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_refund_it_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

function ids(base: number, offset: number) {
  return {
    uid: base + 100 + offset,
    productId: base + 200 + offset,
    skuId: base + 300 + offset,
    cartId: base + 400 + offset,
    cartInfoId: base + 500 + offset,
    orderId: base + 600 + offset,
    invoiceId: base + 700 + offset,
    refundA: base + 800 + offset * 2,
    refundB: base + 801 + offset * 2,
    refundC: base + 10_000 + offset,
    paymentId: base + 900 + offset,
    orderNo: `RF${base}${offset}`,
  };
}

function compensationIds(base: number) {
  return {
    receiverUid: base + 1_005,
    supplierId: base + 2_005,
    pinkLeaderId: base + 20_050,
    pinkMemberId: base + 20_051,
    pinkOtherMemberId: base + 20_052,
    pinkLeaderUid: base + 30_050,
    pinkOtherMemberUid: base + 30_052,
    promotionLeaderId: base + 20_060,
    promotionNextLeaderId: base + 20_061,
    promotionOtherMemberId: base + 20_062,
  };
}

function timeoutIds(base: number) {
  return {
    failedLeaderId: base + 20_070,
    failedMemberId: base + 20_071,
    partialLeaderId: base + 20_080,
    failedCombinationId: base + 50_070,
    partialCombinationId: base + 50_080,
    partialSecondCartId: base + 100_011,
    partialSecondCartInfoId: base + 110_011,
  };
}

function pureIntegralIds(base: number) {
  return {
    secondCartId: base + 100_012,
    secondCartInfoId: base + 110_012,
  };
}

function decimalCents(value: string | number): number {
  const normalized = String(value);
  const [whole = "0", fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
  if (!Number.isSafeInteger(cents)) throw new Error("invalid integration money value");
  return cents;
}

function decimalAmount(cents: number): string {
  assertCondition(Number.isSafeInteger(cents) && cents >= 0, "invalid integration cents");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function skuUnique(offset: number): string {
  return String(70_000_000 + offset);
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
    await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
    return fn(createContainerFromDb(tx));
  });
}

async function publicSnapshot(db: DbClient): Promise<PublicSnapshot> {
  const rows = await db.$client<PublicSnapshot[]>`
    SELECT
      (SELECT count(*)::integer FROM public."user") AS users,
      (SELECT count(*)::integer FROM public.user_bill) AS user_bills,
      (SELECT count(*)::integer FROM public.user_brokerage) AS brokerages,
      (SELECT count(*)::integer FROM public.supplier_flowing_water) AS supplier_flows,
      (SELECT count(*)::integer FROM public.supplier_transactions) AS supplier_transactions,
      (SELECT count(*)::integer FROM public.store_pink) AS pinks,
      (SELECT count(*)::integer FROM public.store_order) AS orders,
      (SELECT count(*)::integer FROM public.store_order_cart_info) AS cart_infos,
      (SELECT count(*)::integer FROM public.store_order_invoice) AS invoices,
      (SELECT count(*)::integer FROM public.store_order_refund) AS refunds,
      (SELECT count(*)::integer FROM public.store_order_refund_payment) AS refund_payments,
      (SELECT count(*)::integer FROM public.store_order_status) AS statuses,
      (SELECT count(*)::integer FROM public.store_product) AS products,
      (SELECT count(*)::integer FROM public.store_product_attr_value) AS skus,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'user_bill_id_seq') AS user_bill_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'user_brokerage_id_seq') AS user_brokerage_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'supplier_flowing_water_id_seq') AS supplier_flow_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'supplier_transactions_id_seq') AS supplier_transaction_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_pink_id_seq') AS pink_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_refund_id_seq') AS refund_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_status_id_seq') AS status_sequence
  `;
  const row = rows[0];
  if (!row) throw new Error("unable to read public PostgreSQL refund snapshot");
  return row;
}

async function seedFixtures(db: DbClient, schemaName: string, base: number): Promise<void> {
  await withSchema(db, schemaName, async (container) => {
    const tx = container.db;
    const offsets = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const compensation = compensationIds(base);
    const timeout = timeoutIds(base);
    await tx.insert(userTable).values([...offsets.map((offset) => {
      const fixture = ids(base, offset);
      return {
        uid: fixture.uid,
        account: `refund-${base}-${offset}`.slice(0, 32),
        nowMoney: "0.00",
        brokeragePrice: "0.00",
        integral: offset === 5 ? 20 : offset === 12 ? 40 : 0,
        status: 1,
        isDel: 0,
      };
    }), {
      uid: compensation.receiverUid,
      account: `refund-broker-${base}`.slice(0, 32),
      nowMoney: "0.00",
      brokeragePrice: "0.12",
      integral: 0,
      status: 1,
      isDel: 0,
    }]);
    await tx.insert(storeOrder).values(offsets.map((offset) => {
      const fixture = ids(base, offset);
      return {
        id: fixture.orderId,
        type: offset === 12 ? 4 : [5, 6, 7, 8, 9, 10, 11].includes(offset) ? 3 : 0,
        activityId: [9, 10].includes(offset)
          ? timeout.failedCombinationId
          : offset === 11
            ? timeout.partialCombinationId
            : 0,
        orderId: fixture.orderNo,
        unique: `refund-${base}-${offset}`,
        uid: fixture.uid,
        cartId: offset < 2 ? String(fixture.cartId) : "",
        totalNum: offset < 2 || [9, 10].includes(offset) ? 1 : 2,
        totalPrice: offset === 12 ? "0.00" : "10.00",
        payPrice: offset === 12 ? "0.00" : "10.00",
        payIntegral: offset === 12 ? 60 : 0,
        useIntegral: offset === 5 ? "5.00" : "0.00",
        spreadUid: offset === 5 ? compensation.receiverUid : 0,
        supplierId: offset === 5 ? compensation.supplierId : 0,
        pinkId: offset === 5
          ? compensation.pinkLeaderId
          : [6, 7, 8].includes(offset)
            ? compensation.promotionLeaderId
            : [9, 10].includes(offset)
              ? timeout.failedLeaderId
              : offset === 11
                ? timeout.partialLeaderId
                : 0,
        paid: 1,
        payType: offset === 12 ? "integral" : offset === 4 ? "weixin" : "yue",
        status: offset < 2 ? 0 : 1,
        productType: offset === 12 ? 2 : 0,
        refundStatus: [7, 8].includes(offset) ? 0 : 1,
        refundType: 0,
        refundPrice: "0.00",
        isDel: 0,
        isSystemDel: 0,
        supplierAllocationStatus: 0,
      };
    }));
    await tx.insert(storeOrderInvoice).values(offsets.map((offset) => {
      const fixture = ids(base, offset);
      return {
        id: fixture.invoiceId,
        uid: fixture.uid,
        orderId: fixture.orderId,
        name: `refund invoice ${offset}`,
        isPay: 1,
        isRefund: 0,
        isDel: 0,
      };
    }));
    await tx.insert(storeProduct).values([0, 1].map((offset) => {
      const fixture = ids(base, offset);
      return {
        id: fixture.productId,
        storeName: `refund product ${offset}`,
        stock: 9,
        sales: 1,
      };
    }));
    await tx.insert(storeProductAttrValue).values([0, 1].map((offset) => {
      const fixture = ids(base, offset);
      return {
        id: fixture.skuId,
        productId: fixture.productId,
        suk: `refund-sku-${offset}`,
        unique: skuUnique(offset),
        stock: 9,
        sales: 1,
      };
    }));
    const cartInfoRows: Array<typeof storeOrderCartInfo.$inferInsert> = [0, 1, 9, 10, 11, 12].map((offset) => {
      const fixture = ids(base, offset);
      return {
        id: fixture.cartInfoId,
        uid: fixture.uid,
        oid: fixture.orderId,
        cartId: String(fixture.cartId),
        unique: `refund-cart-${base}-${offset}`,
        productId: fixture.productId,
        skuUnique: skuUnique(offset),
        productType: offset === 12 ? 2 : 0,
        cartNum: 1,
        surplusNum: 1,
        splitSurplusNum: 1,
        cartInfo: JSON.stringify({ sku: { id: fixture.skuId } }),
      };
    });
    cartInfoRows.push({
      id: timeout.partialSecondCartInfoId,
      uid: ids(base, 11).uid,
      oid: ids(base, 11).orderId,
      cartId: String(timeout.partialSecondCartId),
      unique: `refund-cart-${base}-11b`,
      productId: ids(base, 11).productId,
      skuUnique: "",
      cartNum: 1,
      surplusNum: 1,
      splitSurplusNum: 1,
      cartInfo: JSON.stringify({ line: "second" }),
    });
    const pureIntegral = pureIntegralIds(base);
    cartInfoRows.push({
      id: pureIntegral.secondCartInfoId,
      uid: ids(base, 12).uid,
      oid: ids(base, 12).orderId,
      cartId: String(pureIntegral.secondCartId),
      unique: `refund-cart-${base}-12b`,
      productId: ids(base, 12).productId,
      productType: 2,
      skuUnique: "",
      cartNum: 1,
      surplusNum: 1,
      splitSurplusNum: 1,
      cartInfo: JSON.stringify({ line: "pure-integral-second" }),
    });
    await tx.insert(storeOrderCartInfo).values(cartInfoRows);

    const refundRows: Array<typeof storeOrderRefund.$inferInsert> = [];
    const addRefund = (
      offset: number,
      id: number,
      amount: string,
      suffix: string,
      withCart = false,
      legacyCartSnapshot = false,
    ) => {
      const fixture = ids(base, offset);
      refundRows.push({
        id,
        storeOrderId: fixture.orderId,
        orderId: `RR${base}${offset}${suffix}`,
        uid: fixture.uid,
        applyType: 1,
        applyPrice: amount,
        refundType: 0,
        refundNum: withCart ? 1 : 0,
        refundPrice: amount,
        refundedPrice: "0.00",
        refundReason: "integration refund",
        cartInfo: withCart
          ? JSON.stringify(
              legacyCartSnapshot
                ? [{ id: fixture.cartId, cart_num: 1, truePrice: amount }]
                : { cartIds: [fixture.cartId] },
            )
          : null,
        isCancel: 0,
        isDel: 0,
      });
    };
    addRefund(0, ids(base, 0).refundA, "4.00", "A", true);
    addRefund(1, ids(base, 1).refundA, "4.00", "A", true);
    addRefund(2, ids(base, 2).refundA, "6.00", "A");
    addRefund(2, ids(base, 2).refundB, "6.00", "B");
    addRefund(3, ids(base, 3).refundA, "4.00", "A");
    addRefund(3, ids(base, 3).refundB, "6.00", "B");
    addRefund(4, ids(base, 4).refundA, "7.00", "A");
    addRefund(5, ids(base, 5).refundA, "3.33", "A");
    addRefund(5, ids(base, 5).refundB, "3.33", "B");
    addRefund(5, ids(base, 5).refundC, "3.34", "C");
    addRefund(6, ids(base, 6).refundA, "10.00", "A");
    addRefund(11, ids(base, 11).refundA, "3.00", "A", true, true);
    await tx.insert(storeOrderRefund).values(refundRows);

    const provider = ids(base, 4);
    await tx.insert(storeOrderRefundPayment).values({
      id: provider.paymentId,
      refundId: provider.refundA,
      storeOrderId: provider.orderId,
      provider: "wechat",
      outRefundNo: `CNSR${provider.refundA}`,
      providerStatus: "SUCCESS",
      requestAmount: 500,
      totalAmount: 1000,
      successTime: 1_700_000_000,
      addTime: 1_700_000_000,
      updateTime: 1_700_000_000,
    });

    const cumulative = ids(base, 5);
    await tx.insert(userBill).values({
      uid: cumulative.uid,
      linkId: String(cumulative.orderId),
      pm: 1,
      title: "integration reward grant",
      category: "integral",
      type: "gain",
      eventKey: "pay_give_integral",
      number: "7",
      balance: "20",
      status: 1,
      addTime: 1_699_999_900,
    });
    await tx.insert(userBrokerage).values([{
      uid: compensation.receiverUid,
      linkId: String(cumulative.orderId),
      pm: 1,
      title: "integration one brokerage",
      category: "one_brokerage",
      type: "one_brokerage",
      number: "0.05",
      balance: "0.05",
      status: 1,
      take: 1,
      addTime: 1_699_999_901,
    }, {
      uid: compensation.receiverUid,
      linkId: String(cumulative.orderId),
      pm: 1,
      title: "integration staff brokerage",
      category: "staff_brokerage",
      type: "staff_brokerage",
      number: "0.07",
      balance: "0.12",
      status: 1,
      take: 1,
      addTime: 1_699_999_902,
    }]);
    await tx.insert(supplierFlowingWater).values({
      supplierId: compensation.supplierId,
      uid: cumulative.uid,
      orderId: `S${cumulative.orderNo}`,
      linkId: cumulative.orderNo,
      pm: 1,
      number: "0.05",
      type: 1,
      payType: "yue",
      payPrice: "10.00",
      totalPrice: "10.00",
      status: 1,
      finishTime: 1_699_999_903,
      tradeTime: 1_699_999_903,
      addTime: 1_699_999_903,
    });
    await tx.insert(storePink).values([{
      id: compensation.pinkLeaderId,
      uid: compensation.pinkLeaderUid,
      orderId: `PL${base}`,
      orderIdKey: String(base + 40_050),
      totalNum: 1,
      totalPrice: "10.00",
      combinationId: base + 50_050,
      productId: base + 60_050,
      kId: 0,
      people: 3,
      memberCount: 3,
      status: 2,
      stopTime: new Date(1_700_100_000 * 1000),
      addTime: 1_699_999_800,
    }, {
      id: compensation.pinkMemberId,
      uid: cumulative.uid,
      orderId: cumulative.orderNo,
      orderIdKey: String(cumulative.orderId),
      totalNum: 1,
      totalPrice: "10.00",
      combinationId: base + 50_050,
      productId: base + 60_050,
      kId: compensation.pinkLeaderId,
      people: 3,
      memberCount: 0,
      status: 2,
      stopTime: new Date(1_700_100_000 * 1000),
      addTime: 1_699_999_801,
    }, {
      id: compensation.pinkOtherMemberId,
      uid: compensation.pinkOtherMemberUid,
      orderId: `PM${base}`,
      orderIdKey: String(base + 40_052),
      totalNum: 1,
      totalPrice: "10.00",
      combinationId: base + 50_050,
      productId: base + 60_050,
      kId: compensation.pinkLeaderId,
      people: 3,
      memberCount: 0,
      status: 2,
      stopTime: new Date(1_700_100_000 * 1000),
      addTime: 1_699_999_802,
    }, {
      id: compensation.promotionLeaderId,
      uid: ids(base, 6).uid,
      orderId: ids(base, 6).orderNo,
      orderIdKey: String(ids(base, 6).orderId),
      totalNum: 1,
      totalPrice: "10.00",
      combinationId: base + 50_060,
      productId: base + 60_060,
      kId: 0,
      people: 3,
      memberCount: 3,
      status: 2,
      stopTime: new Date(1_700_200_000 * 1000),
      addTime: 1_699_999_810,
    }, {
      id: compensation.promotionNextLeaderId,
      uid: ids(base, 7).uid,
      orderId: ids(base, 7).orderNo,
      orderIdKey: String(ids(base, 7).orderId),
      totalNum: 1,
      totalPrice: "10.00",
      combinationId: base + 50_060,
      productId: base + 60_060,
      kId: compensation.promotionLeaderId,
      people: 3,
      memberCount: 0,
      status: 2,
      stopTime: new Date(1_700_200_000 * 1000),
      addTime: 1_699_999_811,
    }, {
      id: compensation.promotionOtherMemberId,
      uid: ids(base, 8).uid,
      orderId: ids(base, 8).orderNo,
      orderIdKey: String(ids(base, 8).orderId),
      totalNum: 1,
      totalPrice: "10.00",
      combinationId: base + 50_060,
      productId: base + 60_060,
      kId: compensation.promotionLeaderId,
      people: 3,
      memberCount: 0,
      status: 2,
      stopTime: new Date(1_700_200_000 * 1000),
      addTime: 1_699_999_812,
    }, {
      id: timeout.failedLeaderId,
      uid: ids(base, 9).uid,
      orderId: ids(base, 9).orderNo,
      orderIdKey: String(ids(base, 9).orderId),
      totalNum: 1,
      totalPrice: "10.00",
      combinationId: timeout.failedCombinationId,
      productId: base + 60_070,
      kId: 0,
      people: 3,
      memberCount: 2,
      status: 3,
      stopTime: new Date(1_700_250_000 * 1000),
      addTime: 1_699_999_820,
    }, {
      id: timeout.failedMemberId,
      uid: ids(base, 10).uid,
      orderId: ids(base, 10).orderNo,
      orderIdKey: String(ids(base, 10).orderId),
      totalNum: 1,
      totalPrice: "10.00",
      combinationId: timeout.failedCombinationId,
      productId: base + 60_070,
      kId: timeout.failedLeaderId,
      people: 3,
      memberCount: 0,
      status: 3,
      stopTime: new Date(1_700_250_000 * 1000),
      addTime: 1_699_999_821,
    }, {
      id: timeout.partialLeaderId,
      uid: ids(base, 11).uid,
      orderId: ids(base, 11).orderNo,
      orderIdKey: String(ids(base, 11).orderId),
      totalNum: 2,
      totalPrice: "10.00",
      combinationId: timeout.partialCombinationId,
      productId: base + 60_080,
      kId: 0,
      people: 2,
      memberCount: 1,
      status: 3,
      stopTime: new Date(1_700_250_000 * 1000),
      addTime: 1_699_999_830,
    }]);
  });
}

async function readFixtureState(
  container: Container,
  base: number,
  offset: number,
): Promise<RefundFixtureState> {
  const fixture = ids(base, offset);
  const [users, orders, refunds, bills, statuses, invoices, products, skus] = await Promise.all([
    container.db.select().from(userTable).where(eq(userTable.uid, fixture.uid)).limit(1),
    container.db.select().from(storeOrder).where(eq(storeOrder.id, fixture.orderId)).limit(1),
    container.db.select().from(storeOrderRefund)
      .where(eq(storeOrderRefund.storeOrderId, fixture.orderId))
      .orderBy(asc(storeOrderRefund.id)),
    container.db.select({ value: count() }).from(userBill)
      .where(eq(userBill.uid, fixture.uid)),
    container.db.select({ value: count() }).from(storeOrderStatus)
      .where(eq(storeOrderStatus.oid, fixture.orderId)),
    container.db.select().from(storeOrderInvoice)
      .where(eq(storeOrderInvoice.orderId, fixture.orderId)).limit(1),
    container.db.select().from(storeProduct)
      .where(eq(storeProduct.id, fixture.productId)).limit(1),
    container.db.select().from(storeProductAttrValue)
      .where(eq(storeProductAttrValue.id, fixture.skuId)).limit(1),
  ]);
  const account = users[0];
  const order = orders[0];
  const invoice = invoices[0];
  assertCondition(account && order && invoice, `fixture ${offset} is incomplete`);
  return {
    balance: account.nowMoney,
    integral: account.integral,
    backIntegral: order.backIntegral,
    orderRefundPrice: order.refundPrice,
    orderRefundStatus: order.refundStatus,
    refundTypes: refunds.map((refund) => refund.refundType),
    refundedPrices: refunds.map((refund) => refund.refundedPrice),
    billRows: Number(bills[0]?.value ?? 0),
    statusRows: Number(statuses[0]?.value ?? 0),
    invoiceRefunded: invoice.isRefund,
    productStock: products[0]?.stock ?? null,
    productSales: products[0]?.sales ?? null,
    skuStock: skus[0]?.stock ?? null,
    skuSales: skus[0]?.sales ?? null,
  };
}

async function readCompensationState(
  container: Container,
  base: number,
): Promise<CompensationState> {
  const fixture = ids(base, 5);
  const compensation = compensationIds(base);
  const baseState = await readFixtureState(container, base, 5);
  const [bills, receiverRows, brokerageRows, supplierRows, transactionRows, memberRows, leaderRows] = await Promise.all([
    container.db.select().from(userBill).where(eq(userBill.uid, fixture.uid)).orderBy(asc(userBill.id)),
    container.db.select().from(userTable).where(eq(userTable.uid, compensation.receiverUid)).limit(1),
    container.db.select().from(userBrokerage)
      .where(eq(userBrokerage.linkId, String(fixture.orderId)))
      .orderBy(asc(userBrokerage.id)),
    container.db.select().from(supplierFlowingWater)
      .where(eq(supplierFlowingWater.linkId, fixture.orderNo))
      .orderBy(asc(supplierFlowingWater.id)),
    container.db.select().from(supplierTransactions)
      .where(eq(supplierTransactions.linkId, fixture.orderNo))
      .orderBy(asc(supplierTransactions.id)),
    container.db.select().from(storePink)
      .where(eq(storePink.id, compensation.pinkMemberId)).limit(1),
    container.db.select().from(storePink)
      .where(eq(storePink.id, compensation.pinkLeaderId)).limit(1),
  ]);
  const receiver = receiverRows[0];
  const member = memberRows[0];
  const leader = leaderRows[0];
  assertCondition(receiver && member && leader, "cumulative compensation fixture is incomplete");
  const sumMoney = (values: Array<string | number>) =>
    decimalAmount(values.reduce<number>((sum, value) => sum + decimalCents(value), 0));
  const reversedGrantPoints = bills
    .filter((bill) => bill.pm === 0 && bill.eventKey === "integral_refund")
    .reduce((sum, bill) => sum + decimalCents(bill.number) / 100, 0);
  const returnedUsedPoints = bills
    .filter((bill) => bill.pm === 1 && bill.type === "pay_product_integral_back")
    .reduce((sum, bill) => sum + decimalCents(bill.number) / 100, 0);
  const brokerageRefunds = brokerageRows.filter((row) => row.pm === 0 && row.type === "refund");
  const supplierRefunds = supplierRows.filter((row) => row.pm === 0 && row.type === 2);
  return {
    ...baseState,
    reversedGrantPoints,
    returnedUsedPoints,
    brokerageBalance: receiver.brokeragePrice,
    brokerageReversed: sumMoney(brokerageRefunds.map((row) => row.number)),
    brokerageOneReversed: sumMoney(
      brokerageRefunds.filter((row) => row.sourceType === "one_brokerage").map((row) => row.number),
    ),
    brokerageStaffReversed: sumMoney(
      brokerageRefunds.filter((row) => row.sourceType === "staff_brokerage").map((row) => row.number),
    ),
    brokerageRefundRows: brokerageRefunds.length,
    supplierReversed: sumMoney(supplierRefunds.map((row) => row.number)),
    supplierRefundRows: supplierRefunds.length,
    supplierRefundDeltas: supplierRefunds.map((row) => row.number),
    supplierTransactionRows: transactionRows.filter((row) => row.pm === 0 && row.type === 2).length,
    pinkMemberIsRefund: member.isRefund,
    pinkMemberStatus: member.status,
    pinkLeaderMemberCount: leader.memberCount,
  };
}

async function runDuplicateBalanceRefund(
  firstDb: DbClient,
  secondDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  base: number,
) {
  const refundId = ids(base, 0).refundA;
  const run = (db: DbClient) => withSchema(db, schemaName, (container) =>
    finalizeStoreOrderRefund(container, refundId, 1_700_000_100));
  const results = await Promise.all([run(firstDb), run(secondDb)]);
  const completed = results.filter((result) => result === "completed").length;
  const alreadyCompleted = results.filter((result) => result === "already-completed").length;
  assertCondition(completed === 1 && alreadyCompleted === 1, "duplicate balance refund did not converge idempotently");
  return withSchema(observerDb, schemaName, async (container) => {
    const state = await readFixtureState(container, base, 0);
    const stockRestoredOnce = state.productStock === 10 && state.productSales === 0
      && state.skuStock === 10 && state.skuSales === 0;
    assertCondition(
      state.balance === "4.00"
      && state.orderRefundPrice === "4.00"
      && state.refundTypes[0] === 6
      && state.billRows === 1
      && state.statusRows === 1
      && stockRestoredOnce,
      "duplicate balance refund wrote side effects more than once",
    );
    return {
      completed,
      already_completed: alreadyCompleted,
      balance: state.balance,
      bill_rows: state.billRows,
      status_rows: state.statusRows,
      stock_restored_once: stockRestoredOnce,
    };
  });
}

async function runBalanceFailureAtomicity(
  db: DbClient,
  schemaName: string,
  base: number,
) {
  const schemaIdentifier = identifier(schemaName);
  const refundId = ids(base, 1).refundA;
  await withSchema(db, schemaName, async (container) => {
    await container.db.execute(sql.raw(
      `CREATE FUNCTION ${schemaIdentifier}.fail_refund_bill() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'integration refund bill failure'; END $$`,
    ));
    await container.db.execute(sql.raw(
      `CREATE TRIGGER fail_refund_bill BEFORE INSERT ON ${schemaIdentifier}.user_bill FOR EACH ROW WHEN (NEW.type = 'pay_product_refund') EXECUTE FUNCTION ${schemaIdentifier}.fail_refund_bill()`,
    ));
  });

  let failure: unknown;
  try {
    await withSchema(db, schemaName, (container) =>
      finalizeStoreOrderRefund(container, refundId, 1_700_000_200));
  } catch (error) {
    failure = error;
  }
  assertCondition(failure instanceof Error && /integration refund bill failure/.test(failure.message), "forced balance refund failure was not observed");
  const rolledBack = await withSchema(db, schemaName, async (container) => {
    const state = await readFixtureState(container, base, 1);
    return state.balance === "0.00"
      && state.orderRefundPrice === "0.00"
      && state.refundTypes[0] === 0
      && state.refundedPrices[0] === "0.00"
      && state.billRows === 0
      && state.statusRows === 0
      && state.invoiceRefunded === 0
      && state.productStock === 9
      && state.productSales === 1
      && state.skuStock === 9
      && state.skuSales === 1;
  });
  assertCondition(rolledBack, "balance refund failure did not roll back every side effect");

  await withSchema(db, schemaName, async (container) => {
    await container.db.execute(sql.raw(`DROP TRIGGER fail_refund_bill ON ${schemaIdentifier}.user_bill`));
    await container.db.execute(sql.raw(`DROP FUNCTION ${schemaIdentifier}.fail_refund_bill()`));
  });
  const retry = await withSchema(db, schemaName, (container) =>
    finalizeStoreOrderRefund(container, refundId, 1_700_000_201));
  assertCondition(retry === "completed", "balance refund retry did not complete");
  return withSchema(db, schemaName, async (container) => {
    const state = await readFixtureState(container, base, 1);
    const stockRestoredOnce = state.productStock === 10 && state.productSales === 0
      && state.skuStock === 10 && state.skuSales === 0;
    assertCondition(
      state.balance === "4.00" && state.billRows === 1 && state.statusRows === 1 && stockRestoredOnce,
      "balance refund retry wrote inconsistent evidence",
    );
    return {
      failure_rolled_back: rolledBack,
      retry_completed: retry === "completed",
      balance: state.balance,
      bill_rows: state.billRows,
      status_rows: state.statusRows,
      stock_restored_once: stockRestoredOnce,
    };
  });
}

async function runCumulativeOverRefundRace(
  firstDb: DbClient,
  secondDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  base: number,
) {
  const fixture = ids(base, 2);
  const results = await Promise.allSettled([
    withSchema(firstDb, schemaName, (container) => finalizeStoreOrderRefund(container, fixture.refundA, 1_700_000_300)),
    withSchema(secondDb, schemaName, (container) => finalizeStoreOrderRefund(container, fixture.refundB, 1_700_000_301)),
  ]);
  const fulfilled = results.filter((result): result is PromiseFulfilledResult<RefundFinalizationOutcome> => result.status === "fulfilled");
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  const businessRejected = rejected.length === 1
    && rejected[0].reason instanceof Error
    && /累计退款金额超过订单实付金额/.test(rejected[0].reason.message)
    && !/lock timeout|deadlock|canceling statement/i.test(rejected[0].reason.message);
  assertCondition(fulfilled.length === 1 && fulfilled[0].value === "completed" && businessRejected, "over-refund race did not produce one business rejection");
  return withSchema(observerDb, schemaName, async (container) => {
    const state = await readFixtureState(container, base, 2);
    assertCondition(
      state.balance === "6.00"
      && state.orderRefundPrice === "6.00"
      && state.refundTypes.filter((type) => type === 6).length === 1
      && state.billRows === 1,
      "over-refund race exceeded the paid amount",
    );
    return {
      completed: fulfilled.length,
      rejected: rejected.length,
      business_rejected: businessRejected,
      cumulative_refund: state.orderRefundPrice,
      balance: state.balance,
      bill_rows: state.billRows,
    };
  });
}

async function runCumulativeExactRefundRace(
  firstDb: DbClient,
  secondDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  base: number,
) {
  const fixture = ids(base, 3);
  const results = await Promise.all([
    withSchema(firstDb, schemaName, (container) => finalizeStoreOrderRefund(container, fixture.refundA, 1_700_000_400)),
    withSchema(secondDb, schemaName, (container) => finalizeStoreOrderRefund(container, fixture.refundB, 1_700_000_401)),
  ]);
  assertCondition(results.every((result) => result === "completed"), "exact cumulative refunds did not both complete");
  return withSchema(observerDb, schemaName, async (container) => {
    const state = await readFixtureState(container, base, 3);
    const fullyRefunded = state.orderRefundStatus === 2;
    assertCondition(
      state.balance === "10.00"
      && state.orderRefundPrice === "10.00"
      && fullyRefunded
      && state.refundTypes.every((type) => type === 6)
      && state.billRows === 2,
      "exact cumulative refunds did not preserve the paid total",
    );
    return {
      completed: results.length,
      cumulative_refund: state.orderRefundPrice,
      fully_refunded: fullyRefunded,
      balance: state.balance,
      bill_rows: state.billRows,
    };
  });
}

async function readPureIntegralRefundState(
  db: DbClient,
  schemaName: string,
  base: number,
  refundIds: number[],
) {
  const fixture = ids(base, 12);
  return withSchema(db, schemaName, async (container) => {
    const [accounts, orders, refunds, bills] = await Promise.all([
      container.db.select({ integral: userTable.integral })
        .from(userTable)
        .where(eq(userTable.uid, fixture.uid))
        .limit(1),
      container.db.select({ refundStatus: storeOrder.refundStatus, refundPrice: storeOrder.refundPrice })
        .from(storeOrder)
        .where(eq(storeOrder.id, fixture.orderId))
        .limit(1),
      container.db.select({ refundType: storeOrderRefund.refundType })
        .from(storeOrderRefund)
        .where(inArray(storeOrderRefund.id, refundIds))
        .orderBy(asc(storeOrderRefund.id)),
      container.db.select({ number: userBill.number })
        .from(userBill)
        .where(
          sql`${userBill.uid} = ${fixture.uid}
            AND ${userBill.linkId} = ${String(fixture.orderId)}
            AND ${userBill.type} = 'order_integral_refund'
            AND ${userBill.pm} = 1
            AND ${userBill.status} = 1`,
        )
        .orderBy(asc(userBill.id)),
    ]);
    return {
      integral: accounts[0]?.integral ?? -1,
      refundStatus: orders[0]?.refundStatus ?? -1,
      refundPrice: orders[0]?.refundPrice ?? "missing",
      refundTypes: refunds.map((row) => row.refundType),
      returnedIntegral: bills.reduce((sum, row) => sum + Number(row.number), 0),
      billRows: bills.length,
    };
  });
}

async function runPureIntegralRefund(db: DbClient, schemaName: string, base: number) {
  const fixture = ids(base, 12);
  const pureIntegral = pureIntegralIds(base);
  const firstApplication = await withSchema(db, schemaName, (container) =>
    applyOrderRefund(container, {
      uid: fixture.uid,
      orderId: fixture.orderNo,
      refundReason: "pure integral partial refund A",
      refundExplain: "production PostgreSQL isolated audit",
      applyType: 1,
      cartIds: [fixture.cartId],
    }));
  const first = await withSchema(db, schemaName, (container) =>
    finalizeStoreOrderRefund(container, firstApplication.refundId, 1_700_000_450));
  const partial = await readPureIntegralRefundState(
    db,
    schemaName,
    base,
    [firstApplication.refundId],
  );
  assertCondition(
    first === "completed"
      && partial.integral === 70
      && partial.refundStatus === 3
      && partial.refundPrice === "0.00"
      && partial.returnedIntegral === 30
      && partial.billRows === 1,
    "pure integral partial refund did not return points by quantity",
  );

  const secondApplication = await withSchema(db, schemaName, (container) =>
    applyOrderRefund(container, {
      uid: fixture.uid,
      orderId: fixture.orderNo,
      refundReason: "pure integral partial refund B",
      refundExplain: "production PostgreSQL isolated audit",
      applyType: 1,
      cartIds: [pureIntegral.secondCartId],
    }));
  const second = await withSchema(db, schemaName, (container) =>
    finalizeStoreOrderRefund(container, secondApplication.refundId, 1_700_000_451));
  const replay = await withSchema(db, schemaName, (container) =>
    finalizeStoreOrderRefund(container, firstApplication.refundId, 1_700_000_452));
  const final = await readPureIntegralRefundState(
    db,
    schemaName,
    base,
    [firstApplication.refundId, secondApplication.refundId],
  );
  const fullyRefunded = final.refundStatus === 2;
  assertCondition(
    second === "completed"
      && replay === "already-completed"
      && fullyRefunded
      && final.integral === 100
      && final.refundPrice === "0.00"
      && final.refundTypes.every((type) => type === 6)
      && final.returnedIntegral === 60
      && final.billRows === 2,
    "pure integral full refund or replay invariant drifted",
  );
  return {
    first_completed: first === "completed",
    replay_converged: replay === "already-completed",
    partial_integral: partial.integral,
    partial_refund_status: partial.refundStatus,
    fully_refunded: fullyRefunded,
    final_integral: final.integral,
    returned_integral: final.returnedIntegral,
    bill_rows: final.billRows,
  };
}

async function runProviderAmountBinding(db: DbClient, schemaName: string, base: number) {
  const fixture = ids(base, 4);
  let mismatch: unknown;
  try {
    await withSchema(db, schemaName, (container) =>
      finalizeStoreOrderRefund(container, fixture.refundA, 1_700_000_500));
  } catch (error) {
    mismatch = error;
  }
  assertCondition(mismatch instanceof Error && /退款金额与支付渠道确认金额不一致/.test(mismatch.message), "provider amount mismatch was not rejected");
  const mismatchRolledBack = await withSchema(db, schemaName, async (container) => {
    const state = await readFixtureState(container, base, 4);
    return state.orderRefundPrice === "0.00"
      && state.refundTypes[0] === 0
      && state.statusRows === 0
      && state.invoiceRefunded === 0;
  });
  assertCondition(mismatchRolledBack, "provider amount mismatch changed refund business state");

  await withSchema(db, schemaName, async (container) => {
    await container.db.update(storeOrderRefund)
      .set({ refundPrice: "5.00" })
      .where(eq(storeOrderRefund.id, fixture.refundA));
  });
  const retry = await withSchema(db, schemaName, (container) =>
    finalizeStoreOrderRefund(container, fixture.refundA, 1_700_000_501));
  assertCondition(retry === "completed", "provider amount retry did not complete");
  return withSchema(db, schemaName, async (container) => {
    const state = await readFixtureState(container, base, 4);
    assertCondition(
      state.balance === "0.00"
      && state.orderRefundPrice === "5.00"
      && state.statusRows === 1,
      "provider amount retry wrote inconsistent business state",
    );
    return {
      mismatch_rolled_back: mismatchRolledBack,
      retry_completed: retry === "completed",
      cumulative_refund: state.orderRefundPrice,
      status_rows: state.statusRows,
    };
  });
}

async function runCumulativeCompensationInvariants(
  db: DbClient,
  schemaName: string,
  base: number,
) {
  const schemaIdentifier = identifier(schemaName);
  const fixture = ids(base, 5);
  const compensation = compensationIds(base);
  await withSchema(db, schemaName, async (container) => {
    await container.db.execute(sql.raw(
      `CREATE FUNCTION ${schemaIdentifier}.fail_supplier_refund_transaction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'integration supplier transaction failure'; END $$`,
    ));
    await container.db.execute(sql.raw(
      `CREATE TRIGGER fail_supplier_refund_transaction BEFORE INSERT ON ${schemaIdentifier}.supplier_transactions FOR EACH ROW WHEN (NEW.type = 2) EXECUTE FUNCTION ${schemaIdentifier}.fail_supplier_refund_transaction()`,
    ));
  });

  let failure: unknown;
  try {
    await withSchema(db, schemaName, (container) =>
      finalizeStoreOrderRefund(container, fixture.refundA, 1_700_000_600));
  } catch (error) {
    failure = error;
  }
  assertCondition(
    failure instanceof Error && /integration supplier transaction failure/.test(failure.message),
    "forced cumulative compensation failure was not observed",
  );
  const rolledBack = await withSchema(db, schemaName, async (container) => {
    const state = await readCompensationState(container, base);
    return state.balance === "0.00"
      && state.integral === 20
      && state.backIntegral === "0.00"
      && state.orderRefundPrice === "0.00"
      && state.refundTypes.every((type) => type === 0)
      && state.refundedPrices.every((price) => price === "0.00")
      && state.billRows === 1
      && state.statusRows === 0
      && state.invoiceRefunded === 0
      && state.reversedGrantPoints === 0
      && state.returnedUsedPoints === 0
      && state.brokerageBalance === "0.12"
      && state.brokerageRefundRows === 0
      && state.supplierRefundRows === 0
      && state.supplierTransactionRows === 0
      && state.pinkMemberIsRefund === 0
      && state.pinkMemberStatus === 2
      && state.pinkLeaderMemberCount === 3;
  });
  assertCondition(rolledBack, "cumulative compensation failure did not roll back every ledger");

  await withSchema(db, schemaName, async (container) => {
    await container.db.execute(sql.raw(
      `DROP TRIGGER fail_supplier_refund_transaction ON ${schemaIdentifier}.supplier_transactions`,
    ));
    await container.db.execute(sql.raw(`DROP FUNCTION ${schemaIdentifier}.fail_supplier_refund_transaction()`));
  });
  const results = [] as RefundFinalizationOutcome[];
  for (const [index, refundId] of [fixture.refundA, fixture.refundB, fixture.refundC].entries()) {
    results.push(await withSchema(db, schemaName, (container) =>
      finalizeStoreOrderRefund(container, refundId, 1_700_000_601 + index)));
  }
  assertCondition(results.every((result) => result === "completed"), "cumulative compensation refunds did not complete");

  return withSchema(db, schemaName, async (container) => {
    const state = await readCompensationState(container, base);
    const pinkMemberRefunded = state.pinkMemberIsRefund === compensation.pinkLeaderId
      && state.pinkMemberStatus === 3;
    assertCondition(
      state.balance === "10.00"
      && state.integral === 18
      && state.backIntegral === "5.00"
      && state.orderRefundPrice === "10.00"
      && state.orderRefundStatus === 2
      && state.refundTypes.every((type) => type === 6)
      && state.refundedPrices.join(",") === "3.33,3.33,3.34"
      && state.billRows === 10
      && state.statusRows === 3
      && state.invoiceRefunded === 1
      && state.reversedGrantPoints === 7
      && state.returnedUsedPoints === 5
      && state.brokerageBalance === "0.00"
      && state.brokerageReversed === "0.12"
      && state.brokerageOneReversed === "0.05"
      && state.brokerageStaffReversed === "0.07"
      && state.brokerageRefundRows === 6
      && state.supplierReversed === "0.05"
      && state.supplierRefundRows === 3
      && state.supplierRefundDeltas.join(",") === "0.02,0.01,0.02"
      && state.supplierTransactionRows === 3
      && pinkMemberRefunded
      && state.pinkLeaderMemberCount === 2,
      "cumulative reward, brokerage, supplier, or pink invariant drifted",
    );
    return {
      failure_rolled_back: rolledBack,
      completed: results.length,
      balance: state.balance,
      integral: state.integral,
      returned_integral: state.backIntegral,
      reversed_grant_points: state.reversedGrantPoints,
      returned_used_points: state.returnedUsedPoints,
      brokerage_balance: state.brokerageBalance,
      brokerage_reversed: state.brokerageReversed,
      supplier_reversed: state.supplierReversed,
      supplier_refund_rows: state.supplierRefundRows,
      supplier_refund_deltas: state.supplierRefundDeltas,
      pink_member_refunded: pinkMemberRefunded,
      pink_active_members: state.pinkLeaderMemberCount,
    };
  });
}

async function runPinkLeaderRefundPromotion(
  db: DbClient,
  schemaName: string,
  base: number,
) {
  const fixture = ids(base, 6);
  const firstMemberOrder = ids(base, 7);
  const otherMemberOrder = ids(base, 8);
  const compensation = compensationIds(base);
  const result = await withSchema(db, schemaName, (container) =>
    finalizeStoreOrderRefund(container, fixture.refundA, 1_700_000_700));
  assertCondition(result === "completed", "pink leader full refund did not complete");
  return withSchema(db, schemaName, async (container) => {
    const [leaderRows, nextLeaderRows, otherMemberRows, memberOrderRows] = await Promise.all([
      container.db.select().from(storePink)
        .where(eq(storePink.id, compensation.promotionLeaderId)).limit(1),
      container.db.select().from(storePink)
        .where(eq(storePink.id, compensation.promotionNextLeaderId)).limit(1),
      container.db.select().from(storePink)
        .where(eq(storePink.id, compensation.promotionOtherMemberId)).limit(1),
      container.db.select({ id: storeOrder.id, pinkId: storeOrder.pinkId })
        .from(storeOrder)
        .where(sql`${storeOrder.id} IN (${firstMemberOrder.orderId}, ${otherMemberOrder.orderId})`)
        .orderBy(asc(storeOrder.id)),
    ]);
    const leader = leaderRows[0];
    const nextLeader = nextLeaderRows[0];
    const otherMember = otherMemberRows[0];
    assertCondition(leader && nextLeader && otherMember, "pink leader promotion fixture is incomplete");
    const refundedLeader = leader.status === 3
      && leader.isRefund === compensation.promotionLeaderId;
    const followersReparented = nextLeader.kId === 0
      && nextLeader.status === 2
      && nextLeader.memberCount === 2
      && otherMember.kId === compensation.promotionNextLeaderId
      && otherMember.status === 2;
    const memberOrdersRelinked = memberOrderRows.length === 2
      && memberOrderRows.every((order) => order.pinkId === compensation.promotionNextLeaderId);
    assertCondition(
      refundedLeader && followersReparented && memberOrdersRelinked,
      "pink leader refund did not promote and relink the surviving group",
    );
    return {
      completed: result === "completed",
      refunded_leader: refundedLeader,
      promoted_leader_id: nextLeader.id,
      promoted_member_count: nextLeader.memberCount,
      followers_reparented: followersReparented,
      member_orders_relinked: memberOrdersRelinked,
    };
  });
}

function captureQueueEnv(messages: OrderMessage[]): Env {
  return {
    ORDER_QUEUE: {
      async sendBatch(batch: Array<{ body: OrderMessage }>) {
        messages.push(...batch.map((item) => item.body));
      },
    },
  } as unknown as Env;
}

function pinkScanMessage(scheduledAt: number): ScheduledMaintenanceMessage {
  return {
    action: "runScheduledMaintenance",
    job: "pink_timeout",
    runId: `scheduled:${scheduledAt}`,
    scheduledAt,
    cursor: 0,
    threshold: null,
  };
}

function refundCartIds(snapshot: string | null): number[] {
  if (!snapshot) return [];
  const parsed = JSON.parse(snapshot) as unknown;
  const values = Array.isArray(parsed)
    ? parsed
    : parsed !== null
        && typeof parsed === "object"
        && Array.isArray((parsed as { cartIds?: unknown }).cartIds)
      ? (parsed as { cartIds: unknown[] }).cartIds
      : [];
  return values.map((item) => {
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return Number(record.cartId ?? record.cart_id ?? record.id);
    }
    return Number(item);
  });
}

async function runPinkTimeoutRedeliveryRecovery(
  dbA: DbClient,
  dbB: DbClient,
  adminDb: DbClient,
  schemaName: string,
  base: number,
) {
  const timeout = timeoutIds(base);
  const scheduledAt = 1_700_300_000_000;
  const initialMessages: OrderMessage[] = [];
  const scanResult = await withSchema(adminDb, schemaName, (container) =>
    new ScheduledMaintenanceService(container, captureQueueEnv(initialMessages))
      .processMaintenance(pinkScanMessage(scheduledAt)));
  const timeoutMessages = initialMessages.filter(
    (message): message is PinkTimeoutMessage => message.action === "processPinkTimeout",
  );
  const targetMessages = timeoutMessages.filter(
    (message) => [timeout.failedLeaderId, timeout.partialLeaderId].includes(message.pinkId),
  );
  assertCondition(
    typeof scanResult.candidates === "number"
      && scanResult.candidates >= targetMessages.length
      && targetMessages.length === 2,
    "failed groups were not rediscovered by the scheduled scan",
  );

  const failedMessage = targetMessages.find(
    (message) => message.pinkId === timeout.failedLeaderId,
  );
  const partialMessage = targetMessages.find(
    (message) => message.pinkId === timeout.partialLeaderId,
  );
  assertCondition(failedMessage && partialMessage, "pink timeout queue messages are incomplete");
  const concurrentResults = await Promise.all([
    withSchema(dbA, schemaName, (container) =>
      new ScheduledMaintenanceService(container, captureQueueEnv([]))
        .processPinkTimeout(failedMessage)),
    withSchema(dbB, schemaName, (container) =>
      new ScheduledMaintenanceService(container, captureQueueEnv([]))
        .processPinkTimeout(failedMessage)),
  ]);
  assertCondition(
    concurrentResults.every((result) => result.expired === true && result.orders === 2),
    "duplicate pink timeout deliveries did not converge on the failed group",
  );

  await withSchema(adminDb, schemaName, (container) =>
    new ScheduledMaintenanceService(container, captureQueueEnv([]))
      .processPinkTimeout(partialMessage));
  const beforeReplay = await withSchema(adminDb, schemaName, async (container) => {
    const [refunds, bills] = await Promise.all([
      container.db.select({ value: count() }).from(storeOrderRefund)
        .where(inArray(storeOrderRefund.storeOrderId, [ids(base, 9).orderId, ids(base, 10).orderId])),
      container.db.select({ value: count() }).from(userBill)
        .where(inArray(userBill.uid, [ids(base, 9).uid, ids(base, 10).uid])),
    ]);
    return { refunds: Number(refunds[0]?.value ?? 0), bills: Number(bills[0]?.value ?? 0) };
  });
  await withSchema(adminDb, schemaName, (container) =>
    new ScheduledMaintenanceService(container, captureQueueEnv([]))
      .processPinkTimeout(failedMessage));
  const afterReplay = await withSchema(adminDb, schemaName, async (container) => {
    const [refunds, bills] = await Promise.all([
      container.db.select({ value: count() }).from(storeOrderRefund)
        .where(inArray(storeOrderRefund.storeOrderId, [ids(base, 9).orderId, ids(base, 10).orderId])),
      container.db.select({ value: count() }).from(userBill)
        .where(inArray(userBill.uid, [ids(base, 9).uid, ids(base, 10).uid])),
    ]);
    return { refunds: Number(refunds[0]?.value ?? 0), bills: Number(bills[0]?.value ?? 0) };
  });

  const completedMessages: OrderMessage[] = [];
  await withSchema(adminDb, schemaName, (container) =>
    new ScheduledMaintenanceService(container, captureQueueEnv(completedMessages))
      .processMaintenance(pinkScanMessage(scheduledAt)));
  const completedGroupsLeft = completedMessages.filter(
    (message) => message.action === "processPinkTimeout"
      && [timeout.failedLeaderId, timeout.partialLeaderId].includes(message.pinkId),
  ).length;

  return withSchema(adminDb, schemaName, async (container) => {
    const groupOrderIds = [ids(base, 9).orderId, ids(base, 10).orderId];
    const groupUids = [ids(base, 9).uid, ids(base, 10).uid];
    const partial = ids(base, 11);
    const [groupOrders, groupUsers, groupRefunds, groupBills, partialOrders, partialUsers, partialRefunds] =
      await Promise.all([
        container.db.select().from(storeOrder).where(inArray(storeOrder.id, groupOrderIds)),
        container.db.select().from(userTable).where(inArray(userTable.uid, groupUids)),
        container.db.select().from(storeOrderRefund)
          .where(inArray(storeOrderRefund.storeOrderId, groupOrderIds)),
        container.db.select({ value: count() }).from(userBill)
          .where(inArray(userBill.uid, groupUids)),
        container.db.select().from(storeOrder).where(eq(storeOrder.id, partial.orderId)).limit(1),
        container.db.select().from(userTable).where(eq(userTable.uid, partial.uid)).limit(1),
        container.db.select().from(storeOrderRefund)
          .where(eq(storeOrderRefund.storeOrderId, partial.orderId)),
      ]);
    const partialAmounts = partialRefunds
      .map((refund) => refund.refundedPrice)
      .sort((left, right) => decimalCents(left) - decimalCents(right));
    const partialCartIds = partialRefunds
      .flatMap((refund) => refundCartIds(refund.cartInfo))
      .sort((left, right) => left - right);
    const replayConverged = beforeReplay.refunds === afterReplay.refunds
      && beforeReplay.bills === afterReplay.bills
      && afterReplay.refunds === 2
      && afterReplay.bills === 2;
    assertCondition(
      groupOrders.length === 2
      && groupOrders.every((order) => order.refundStatus === 2 && order.refundPrice === "10.00")
      && groupUsers.length === 2
      && groupUsers.every((user) => user.nowMoney === "10.00")
      && groupRefunds.length === 2
      && groupRefunds.every((refund) => refund.refundType === 6 && refund.refundedPrice === "10.00")
      && Number(groupBills[0]?.value ?? 0) === 2
      && replayConverged,
      "multi-member failed group was not refunded exactly once under duplicate delivery",
    );
    assertCondition(
      partialOrders[0]?.refundStatus === 2
      && partialOrders[0]?.refundPrice === "10.00"
      && partialUsers[0]?.nowMoney === "10.00"
      && partialRefunds.length === 2
      && partialRefunds.every((refund) => refund.refundType === 6)
      && partialAmounts.join(",") === "3.00,7.00"
      && partialCartIds.join(",") === `${partial.cartId},${timeout.partialSecondCartId}`,
      "pre-existing partial refund did not preserve cart snapshots and fill the exact remainder",
    );
    assertCondition(completedGroupsLeft === 0, "fully refunded failed groups remained scan candidates");
    return {
      scan_enqueued_failed_groups: targetMessages.length,
      concurrent_deliveries: concurrentResults.length,
      group_orders_refunded: groupOrders.length,
      group_refund_rows: groupRefunds.length,
      group_bill_rows: Number(groupBills[0]?.value ?? 0),
      replay_converged: replayConverged,
      partial_refund_rows: partialRefunds.length,
      partial_refund_amounts: partialAmounts,
      partial_refund_cart_ids: partialCartIds,
      partial_balance: partialUsers[0]?.nowMoney ?? "missing",
      completed_groups_left_in_scan: completedGroupsLeft,
    };
  });
}

export async function runStoreOrderRefundPostgresScenario(
  connectionString: string,
): Promise<StoreOrderRefundPostgresReport> {
  const schemaName = makeSchemaName();
  const schemaIdentifier = identifier(schemaName);
  const adminDb = createDbFromConnectionString(connectionString, 1);
  const concurrentDbA = createDbFromConnectionString(connectionString, 1);
  const concurrentDbB = createDbFromConnectionString(connectionString, 1);
  const clients = [adminDb.$client, concurrentDbA.$client, concurrentDbB.$client];
  let created = false;
  let report: Omit<StoreOrderRefundPostgresReport, "schema_removed" | "public_state_unchanged"> | undefined;
  let before: PublicSnapshot | undefined;
  let after: PublicSnapshot | undefined;
  let schemaRemoved = false;

  try {
    const versionRows = await adminDb.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    before = await publicSnapshot(adminDb);
    await adminDb.$client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '20s'`;
      await tx.unsafe(`CREATE SCHEMA ${schemaIdentifier}`);
      for (const table of CLONED_TABLES) {
        const tableIdentifier = identifier(table);
        await tx.unsafe(
          `CREATE TABLE ${schemaIdentifier}.${tableIdentifier} (LIKE public.${tableIdentifier} INCLUDING ALL)`,
        );
      }
      for (const table of LOCAL_SEQUENCE_TABLES) {
        const tableIdentifier = identifier(table);
        const sequenceIdentifier = identifier(`${table}_id_seq_it`);
        await tx.unsafe(`CREATE SEQUENCE ${schemaIdentifier}.${sequenceIdentifier}`);
        await tx.unsafe(
          `ALTER SEQUENCE ${schemaIdentifier}.${sequenceIdentifier} OWNED BY ${schemaIdentifier}.${tableIdentifier}."id"`,
        );
        await tx.unsafe(
          `ALTER TABLE ${schemaIdentifier}.${tableIdentifier} ALTER COLUMN "id" SET DEFAULT nextval('${schemaName}.${table}_id_seq_it'::regclass)`,
        );
      }
    });
    created = true;

    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const base = 1_200_000_000 + (random[0] % 50_000_000);
    await seedFixtures(adminDb, schemaName, base);
    const duplicateBalanceRefund = await runDuplicateBalanceRefund(
      concurrentDbA,
      concurrentDbB,
      adminDb,
      schemaName,
      base,
    );
    const balanceFailureAtomicity = await runBalanceFailureAtomicity(adminDb, schemaName, base);
    const cumulativeOverRefundRace = await runCumulativeOverRefundRace(
      concurrentDbA,
      concurrentDbB,
      adminDb,
      schemaName,
      base,
    );
    const cumulativeExactRefundRace = await runCumulativeExactRefundRace(
      concurrentDbA,
      concurrentDbB,
      adminDb,
      schemaName,
      base,
    );
    const pureIntegralRefund = await runPureIntegralRefund(adminDb, schemaName, base);
    const providerAmountBinding = await runProviderAmountBinding(adminDb, schemaName, base);
    const cumulativeCompensationInvariants = await runCumulativeCompensationInvariants(
      adminDb,
      schemaName,
      base,
    );
    const pinkLeaderRefundPromotion = await runPinkLeaderRefundPromotion(
      adminDb,
      schemaName,
      base,
    );
    const pinkTimeoutRedeliveryRecovery = await runPinkTimeoutRedeliveryRecovery(
      concurrentDbA,
      concurrentDbB,
      adminDb,
      schemaName,
      base,
    );
    report = {
      server_version: versionRows[0]?.server_version ?? "unknown",
      schema_created: true,
      duplicate_balance_refund: duplicateBalanceRefund,
      balance_failure_atomicity: balanceFailureAtomicity,
      cumulative_over_refund_race: cumulativeOverRefundRace,
      cumulative_exact_refund_race: cumulativeExactRefundRace,
      pure_integral_refund: pureIntegralRefund,
      provider_amount_binding: providerAmountBinding,
      cumulative_compensation_invariants: cumulativeCompensationInvariants,
      pink_leader_refund_promotion: pinkLeaderRefundPromotion,
      pink_timeout_redelivery_recovery: pinkTimeoutRedeliveryRecovery,
    };
  } finally {
    try {
      if (created) {
        await adminDb.$client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '3s'`;
          await tx`SET LOCAL statement_timeout = '20s'`;
          await tx.unsafe(`DROP SCHEMA ${schemaIdentifier} CASCADE`);
        });
      }
      const schemaRows = await adminDb.$client<{ schema_removed: boolean }[]>`
        SELECT to_regnamespace(${schemaName}) IS NULL AS schema_removed
      `;
      schemaRemoved = schemaRows[0]?.schema_removed === true;
      after = await publicSnapshot(adminDb);
    } finally {
      await Promise.all(clients.map((client) => client.end({ timeout: 1 })));
    }
  }

  assertCondition(report, "scenario did not produce a report");
  assertCondition(before && after, "public snapshots are missing");
  assertCondition(schemaRemoved, "temporary integration schema was not removed");
  const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(publicStateUnchanged, "public business rows or sequences changed");
  return {
    ...report,
    schema_removed: schemaRemoved,
    public_state_unchanged: publicStateUnchanged,
  };
}
