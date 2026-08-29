import { and, count, eq, sql } from "drizzle-orm";
import {
  storeCart,
  storeOrder,
  storeOrderCartInfo,
  storeOrderInvoice,
  storeOrderOutbox,
  storeOrderStatus,
  storeProduct,
  storeProductAttrValue,
  user as userTable,
  userBill,
} from "@/models/schema";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
  withTx,
} from "@/lib/di";
import { cancelStoreOrder } from "@/services/order/StoreOrderCreateService";
import {
  applyStoreOrderBalancePayment,
  applyStoreOrderPayment,
  PayType,
  type StoreOrderPaymentOutcome,
} from "@/services/order/StoreOrderPayService";

const CLONED_TABLES = [
  "user",
  "user_bill",
  "store_cart",
  "store_order",
  "store_order_cart_info",
  "store_product",
  "store_product_attr_value",
  "store_seckill",
  "store_order_status",
  "store_order_outbox",
  "store_order_invoice",
] as const;

const LOCAL_SEQUENCE_TABLES = [
  "user_bill",
  "store_order_status",
  "store_order_outbox",
] as const;

interface PublicSnapshot {
  users: number;
  user_bills: number;
  carts: number;
  orders: number;
  cart_infos: number;
  products: number;
  skus: number;
  statuses: number;
  outboxes: number;
  invoices: number;
  user_bill_sequence: string | null;
  status_sequence: string | null;
  outbox_sequence: string | null;
}

export interface StoreOrderPaymentCancelPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  public_state_unchanged: boolean;
  atomic_cancel: {
    status_failure_rolled_back: boolean;
    completed_after_retry: boolean;
    stock_restored: boolean;
    status_rows: number;
  };
  double_cancel: {
    successes: number;
    rejections: number;
    business_rejected: boolean;
    stock_restored_once: boolean;
    status_rows: number;
  };
  payment_cancel_race: {
    winner: "payment" | "cancel";
    payment_outcome: StoreOrderPaymentOutcome;
    cancel_outcome: "cancelled" | "rejected";
    loser_business_rejected: boolean;
    outbox_rows: number;
    status_rows: number;
  };
  payment_idempotence: {
    paid_transitions: number;
    already_paid: number;
    conflicting_trade_rejected: boolean;
    outbox_rows: number;
    invoice_paid: boolean;
  };
  payment_outbox_atomicity: {
    outbox_failure_rolled_back: boolean;
    paid_after_retry: boolean;
    outbox_rows: number;
  };
  balance_idempotence: {
    paid_transitions: number;
    already_paid: number;
    balance: string;
    bill_rows: number;
    outbox_rows: number;
  };
  balance_insufficient: {
    business_rejected: boolean;
    balance_unchanged: boolean;
    order_unchanged: boolean;
  };
  balance_outbox_atomicity: {
    outbox_failure_rolled_back: boolean;
    balance_after_retry: string;
    bill_rows: number;
    outbox_rows: number;
  };
  balance_cancel_race: {
    winner: "payment" | "cancel";
    payment_outcome: StoreOrderPaymentOutcome;
    cancel_outcome: "cancelled" | "rejected";
    loser_business_rejected: boolean;
    balance: string;
    bill_rows: number;
    outbox_rows: number;
    status_rows: number;
  };
  zero_balance_payment: {
    paid: boolean;
    balance_unchanged: boolean;
    bill_rows: number;
    outbox_rows: number;
  };
  integral_balance_payment: {
    paid_transitions: number;
    already_paid: number;
    balance: string;
    integral: number;
    balance_bill_rows: number;
    integral_bill_rows: number;
    outbox_rows: number;
  };
  integral_insufficient: {
    business_rejected: boolean;
    funds_unchanged: boolean;
    order_unchanged: boolean;
  };
  retired_activity_order: {
    payment_rejected: boolean;
    funds_unchanged: boolean;
    cancelled: boolean;
    base_inventory_restored: boolean;
    audit_status_written: boolean;
  };
}

interface FixtureState {
  paid: number;
  status: number;
  isDel: number;
  tradeNo: string;
  productStock: number;
  productSales: number;
  skuStock: number;
  skuSales: number;
  cartIsPay: number;
  statusRows: number;
  outboxRows: number;
  invoicePaid: number | null;
}

interface BalanceFixtureState extends FixtureState {
  balance: string;
  billRows: number;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PostgreSQL payment/cancel integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_pay_cancel_it_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function expectRejected(fn: () => Promise<unknown>, label: string): Promise<string> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  assertCondition(caught instanceof Error, `${label} should reject`);
  return caught.message;
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
      (SELECT count(*)::integer FROM public.store_cart) AS carts,
      (SELECT count(*)::integer FROM public.store_order) AS orders,
      (SELECT count(*)::integer FROM public.store_order_cart_info) AS cart_infos,
      (SELECT count(*)::integer FROM public.store_product) AS products,
      (SELECT count(*)::integer FROM public.store_product_attr_value) AS skus,
      (SELECT count(*)::integer FROM public.store_order_status) AS statuses,
      (SELECT count(*)::integer FROM public.store_order_outbox) AS outboxes,
      (SELECT count(*)::integer FROM public.store_order_invoice) AS invoices,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'user_bill_id_seq') AS user_bill_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_status_id_seq') AS status_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_outbox_id_seq') AS outbox_sequence
  `;
  const row = rows[0];
  if (!row) throw new Error("unable to read public PostgreSQL snapshot");
  return row;
}

function fixtureIds(base: number, offset: number) {
  return {
    productId: base + 300 + offset,
    skuId: base + 400 + offset,
    cartId: base + 500 + offset,
    orderId: base + 600 + offset,
    cartInfoId: base + 700 + offset,
    invoiceId: base + 800 + offset,
    orderNo: `PC${base}${offset}`,
  };
}

function fixtureUid(base: number, offset: number): number {
  return offset < 5 ? base + 1 : base + 100 + offset;
}

async function seedFixtures(db: DbClient, schemaName: string, base: number): Promise<void> {
  await withSchema(db, schemaName, async (container) => {
    const tx = container.db;
    const offsets = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    await tx.insert(userTable).values([
      { uid: base + 1, account: `payment-${base}`.slice(0, 32), nowMoney: "0.00", status: 1, isDel: 0 },
      ...[5, 6, 7, 8, 9, 10, 11, 12].map((offset) => ({
        uid: fixtureUid(base, offset),
        account: `balance-${base}-${offset}`.slice(0, 32),
        nowMoney: offset === 6 ? "5.00" : offset === 9 ? "0.00" : "20.00",
        integral: [10, 11].includes(offset) ? 100 : 0,
        status: 1,
        isDel: 0,
      })),
    ]);
    await tx.insert(storeProduct).values(offsets.map((offset) => {
      const ids = fixtureIds(base, offset);
      return {
        id: ids.productId,
        storeName: `payment cancel product ${offset}`,
        stock: 9,
        sales: 1,
      };
    }));
    await tx.insert(storeProductAttrValue).values(offsets.map((offset) => {
      const ids = fixtureIds(base, offset);
      return {
        id: ids.skuId,
        productId: ids.productId,
        suk: `sku-${offset}`,
        unique: String(10_000_000 + offset),
        stock: 9,
        sales: 1,
      };
    }));
    await tx.insert(storeCart).values(offsets.map((offset) => {
      const ids = fixtureIds(base, offset);
      return {
        id: ids.cartId,
        uid: fixtureUid(base, offset),
        type: offset === 12 ? 1 : 0,
        productId: ids.productId,
        activityId: offset === 12 ? base + 9_000 : 0,
        productAttrUnique: String(10_000_000 + offset),
        cartNum: 1,
        isPay: 1,
        isDel: 0,
        status: 1,
      };
    }));
    await tx.insert(storeOrder).values(offsets.map((offset) => {
      const ids = fixtureIds(base, offset);
      return {
        id: ids.orderId,
        orderId: ids.orderNo,
        unique: `payment-cancel-${base}-${offset}`,
        uid: fixtureUid(base, offset),
        cartId: String(ids.cartId),
        totalNum: 1,
        totalPrice: "10.00",
        payPrice: offset === 9 ? "0.00" : "10.00",
        payIntegral: offset === 10 ? 40 : offset === 11 ? 200 : 0,
        paid: 0,
        status: 0,
        isDel: 0,
        isSystemDel: 0,
        supplierAllocationStatus: 0,
        type: offset === 12 ? 1 : 0,
        activityId: offset === 12 ? base + 9_000 : 0,
      };
    }));
    await tx.insert(storeOrderCartInfo).values(offsets.map((offset) => {
      const ids = fixtureIds(base, offset);
      return {
        id: ids.cartInfoId,
        uid: fixtureUid(base, offset),
        oid: ids.orderId,
        cartId: String(ids.cartId),
        unique: `pc-cart-${base}-${offset}`,
        productId: ids.productId,
        skuUnique: String(10_000_000 + offset),
        cartNum: 1,
        surplusNum: 1,
        splitSurplusNum: 1,
        cartInfo: JSON.stringify(offset === 12
          ? {
              product: { id: ids.productId, activityId: base + 9_000 },
              sku: {
                id: ids.skuId,
                unique: String(10_000_000 + offset),
                suk: `sku-${offset}`,
                price: "10.00",
              },
            }
          : { sku: { id: ids.skuId } }),
      };
    }));
    await tx.insert(storeOrderInvoice).values([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((offset) => {
      const ids = fixtureIds(base, offset);
      return {
        id: ids.invoiceId,
        uid: fixtureUid(base, offset),
        orderId: ids.orderId,
        name: `payment cancel invoice ${offset}`,
        isPay: 0,
        isDel: 0,
      };
    }));
  });
}

async function readFixtureState(
  container: Container,
  base: number,
  offset: number,
): Promise<FixtureState> {
  const ids = fixtureIds(base, offset);
  const [orders, products, skus, carts, statuses, outboxes, invoices] = await Promise.all([
    container.db.select().from(storeOrder).where(eq(storeOrder.id, ids.orderId)).limit(1),
    container.db.select().from(storeProduct).where(eq(storeProduct.id, ids.productId)).limit(1),
    container.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, ids.skuId)).limit(1),
    container.db.select().from(storeCart).where(eq(storeCart.id, ids.cartId)).limit(1),
    container.db.select({ value: count() }).from(storeOrderStatus).where(eq(storeOrderStatus.oid, ids.orderId)),
    container.db.select({ value: count() }).from(storeOrderOutbox).where(eq(storeOrderOutbox.aggregateId, ids.orderId)),
    container.db.select().from(storeOrderInvoice).where(eq(storeOrderInvoice.orderId, ids.orderId)).limit(1),
  ]);
  const order = orders[0];
  const product = products[0];
  const sku = skus[0];
  const cart = carts[0];
  assertCondition(order && product && sku && cart, `fixture ${offset} is incomplete`);
  return {
    paid: order.paid,
    status: order.status,
    isDel: order.isDel,
    tradeNo: order.tradeNo,
    productStock: product.stock,
    productSales: product.sales,
    skuStock: sku.stock,
    skuSales: sku.sales,
    cartIsPay: cart.isPay,
    statusRows: statuses[0]?.value ?? -1,
    outboxRows: outboxes[0]?.value ?? -1,
    invoicePaid: invoices[0]?.isPay ?? null,
  };
}

async function readBalanceFixtureState(
  container: Container,
  base: number,
  offset: number,
): Promise<BalanceFixtureState> {
  const ids = fixtureIds(base, offset);
  const [state, users, bills] = await Promise.all([
    readFixtureState(container, base, offset),
    container.db
      .select({ nowMoney: userTable.nowMoney })
      .from(userTable)
      .where(eq(userTable.uid, fixtureUid(base, offset)))
      .limit(1),
    container.db
      .select({ value: count() })
      .from(userBill)
      .where(and(
        eq(userBill.uid, fixtureUid(base, offset)),
        eq(userBill.linkId, ids.orderNo),
        eq(userBill.category, "now_money"),
        eq(userBill.type, "pay_product"),
      )),
  ]);
  assertCondition(users[0], `balance fixture ${offset} user is missing`);
  return {
    ...state,
    balance: String(users[0].nowMoney),
    billRows: bills[0]?.value ?? -1,
  };
}

function assertReservedState(state: FixtureState, label: string): void {
  assertCondition(state.paid === 0 && state.status === 0 && state.isDel === 0, `${label} order changed`);
  assertCondition(state.productStock === 9 && state.productSales === 1, `${label} product reservation changed`);
  assertCondition(state.skuStock === 9 && state.skuSales === 1, `${label} SKU reservation changed`);
  assertCondition(state.cartIsPay === 1, `${label} cart claim changed`);
}

function assertCancelledState(state: FixtureState, label: string): void {
  assertCondition(state.paid === 0 && state.status === -2 && state.isDel === 1, `${label} order not cancelled`);
  assertCondition(state.productStock === 10 && state.productSales === 0, `${label} product not restored exactly once`);
  assertCondition(state.skuStock === 10 && state.skuSales === 0, `${label} SKU not restored exactly once`);
  assertCondition(state.cartIsPay === 0, `${label} cart claim not released`);
}

async function runAtomicCancel(db: DbClient, schemaName: string, base: number) {
  const schema = identifier(schemaName);
  const trigger = identifier("reject_cancel_status_it");
  const fn = identifier("reject_cancel_status_it");
  return withSchema(db, schemaName, async (container) => {
    await container.db.execute(sql.raw(`
      CREATE FUNCTION ${schema}.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.change_type = 'cancel' THEN
          RAISE EXCEPTION 'integration cancel status failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `));
    await container.db.execute(sql.raw(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT ON ${schema}.${identifier("store_order_status")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}.${fn}()
    `));

    const ids = fixtureIds(base, 0);
    const message = await expectRejected(
      () => cancelStoreOrder(container, { uid: base + 1, orderId: ids.orderNo }),
      "cancel status failure",
    );
    assertCondition(message.includes("integration cancel status failure"), "cancel trigger failure was not observed");
    const rolledBack = await readFixtureState(container, base, 0);
    assertReservedState(rolledBack, "failed atomic cancel");
    assertCondition(rolledBack.statusRows === 0, "failed atomic cancel wrote a status row");

    await container.db.execute(sql.raw(`DROP TRIGGER ${trigger} ON ${schema}.${identifier("store_order_status")}`));
    await container.db.execute(sql.raw(`DROP FUNCTION ${schema}.${fn}()`));
    await cancelStoreOrder(container, { uid: base + 1, orderId: ids.orderNo });
    const completed = await readFixtureState(container, base, 0);
    assertCancelledState(completed, "retried atomic cancel");
    assertCondition(completed.statusRows === 1, "successful cancel must write one status row");
    return {
      status_failure_rolled_back: true,
      completed_after_retry: true,
      stock_restored: completed.productStock === 10 && completed.skuStock === 10,
      status_rows: completed.statusRows,
    };
  });
}

async function runDoubleCancel(
  firstDb: DbClient,
  secondDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  base: number,
) {
  const ids = fixtureIds(base, 1);
  const run = (db: DbClient) => withSchema(db, schemaName, (container) =>
    cancelStoreOrder(container, { uid: base + 1, orderId: ids.orderNo }),
  );
  const outcomes = await Promise.allSettled([run(firstDb), run(secondDb)]);
  const successes = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assertCondition(successes === 1 && rejected?.status === "rejected", "double cancel must have exactly one winner");
  assertCondition(rejected.reason instanceof Error, "double cancel rejection is missing");
  const businessRejected = /订单状态不允许取消|订单已被处理/.test(rejected.reason.message)
    && !/lock timeout|deadlock|canceling statement/i.test(rejected.reason.message);
  assertCondition(businessRejected, "double cancel loser must fail at a business guard");

  return withSchema(observerDb, schemaName, async (container) => {
    const state = await readFixtureState(container, base, 1);
    assertCancelledState(state, "double cancel");
    assertCondition(state.statusRows === 1, "double cancel must write one status row");
    return {
      successes,
      rejections: 1,
      business_rejected: businessRejected,
      stock_restored_once: state.productStock === 10 && state.skuStock === 10,
      status_rows: state.statusRows,
    };
  });
}

async function runPaymentCancelRace(
  paymentDb: DbClient,
  cancelDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  base: number,
) {
  const ids = fixtureIds(base, 2);
  const payment = withSchema(paymentDb, schemaName, (container) =>
    applyStoreOrderPayment(container, {
      orderId: ids.orderId,
      payType: PayType.WEIXIN,
      tradeNo: `race-${base}`,
    }),
  );
  const cancellation = withSchema(cancelDb, schemaName, async (container) => {
    await cancelStoreOrder(container, { uid: base + 1, orderId: ids.orderNo });
    return "cancelled" as const;
  });
  const [paymentResult, cancelResult] = await Promise.allSettled([payment, cancellation]);
  assertCondition(paymentResult.status === "fulfilled", "payment race result is missing");
  const paymentOutcome = paymentResult.value.outcome;
  const cancelOutcome: "cancelled" | "rejected" = cancelResult.status === "fulfilled"
    ? "cancelled"
    : "rejected";
  const paymentWon = paymentOutcome === "paid";
  const cancelWon = paymentOutcome === "not-payable" && cancelOutcome === "cancelled";
  assertCondition(
    (paymentWon && cancelOutcome === "rejected") || cancelWon,
    "payment/cancel race must have exactly one winner",
  );
  let loserBusinessRejected = cancelWon;
  if (paymentWon) {
    assertCondition(cancelResult.status === "rejected" && cancelResult.reason instanceof Error, "cancel loser is missing");
    loserBusinessRejected = /已支付订单不能取消|订单状态不允许取消/.test(cancelResult.reason.message)
      && !/lock timeout|deadlock|canceling statement/i.test(cancelResult.reason.message);
  }
  assertCondition(loserBusinessRejected, "payment/cancel loser must fail at a business guard");

  return withSchema(observerDb, schemaName, async (container) => {
    const state = await readFixtureState(container, base, 2);
    if (paymentWon) {
      assertCondition(state.paid === 1 && state.status === 0 && state.isDel === 0, "payment winner not persisted");
      assertCondition(state.productStock === 9 && state.skuStock === 9 && state.cartIsPay === 1, "payment winner restored stock");
      assertCondition(state.outboxRows === 1 && state.statusRows === 0, "payment winner evidence mismatch");
      assertCondition(state.invoicePaid === 1, "payment winner did not mark invoice paid");
    } else {
      assertCancelledState(state, "cancel winner");
      assertCondition(state.outboxRows === 0 && state.statusRows === 1, "cancel winner evidence mismatch");
      assertCondition(state.invoicePaid === 0, "cancel winner marked invoice paid");
    }
    return {
      winner: paymentWon ? "payment" as const : "cancel" as const,
      payment_outcome: paymentOutcome,
      cancel_outcome: cancelOutcome,
      loser_business_rejected: loserBusinessRejected,
      outbox_rows: state.outboxRows,
      status_rows: state.statusRows,
    };
  });
}

async function runPaymentIdempotence(
  firstDb: DbClient,
  secondDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  base: number,
) {
  const ids = fixtureIds(base, 3);
  const tradeNo = `idem-${base}`;
  const run = (db: DbClient) => withSchema(db, schemaName, (container) =>
    applyStoreOrderPayment(container, {
      orderId: ids.orderId,
      payType: PayType.ALIPAY,
      tradeNo,
    }),
  );
  const results = await Promise.all([
    run(firstDb),
    run(secondDb),
  ]);
  const paidTransitions = results.filter((result) => result.outcome === "paid").length;
  const alreadyPaid = results.filter((result) => result.outcome === "already-paid").length;
  assertCondition(paidTransitions === 1 && alreadyPaid === 1, "duplicate callbacks must have one paid transition");
  const conflictingTradeRejected = await expectRejected(
    () => withSchema(secondDb, schemaName, (container) => applyStoreOrderPayment(container, {
      orderId: ids.orderId,
      payType: PayType.ALIPAY,
      tradeNo: `idem-conflict-${base}`,
    })),
    "conflicting payment callback",
  );
  assertCondition(
    /已入账交易不匹配/.test(conflictingTradeRejected),
    "conflicting payment callback was not rejected",
  );

  return withSchema(observerDb, schemaName, async (container) => {
    const state = await readFixtureState(container, base, 3);
    assertCondition(state.paid === 1 && state.outboxRows === 1, "duplicate callbacks persisted duplicate outcomes");
    assertCondition(state.invoicePaid === 1, "duplicate callbacks did not mark invoice paid");
    assertCondition(
      state.tradeNo === tradeNo,
      "duplicate callbacks did not preserve the winning trade number",
    );
    return {
      paid_transitions: paidTransitions,
      already_paid: alreadyPaid,
      conflicting_trade_rejected: true,
      outbox_rows: state.outboxRows,
      invoice_paid: state.invoicePaid === 1,
    };
  });
}

async function runPaymentOutboxAtomicity(db: DbClient, schemaName: string, base: number) {
  const schema = identifier(schemaName);
  const trigger = identifier("reject_paid_outbox_it");
  const fn = identifier("reject_paid_outbox_it");
  const ids = fixtureIds(base, 4);
  return withSchema(db, schemaName, async (container) => {
    await container.db.execute(sql.raw(`
      CREATE FUNCTION ${schema}.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.aggregate_id = ${ids.orderId} THEN
          RAISE EXCEPTION 'integration paid outbox failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `));
    await container.db.execute(sql.raw(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT ON ${schema}.${identifier("store_order_outbox")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}.${fn}()
    `));
    const message = await expectRejected(
      () => applyStoreOrderPayment(container, {
        orderId: ids.orderId,
        payType: PayType.WEIXIN,
        tradeNo: `rollback-${base}`,
      }),
      "payment outbox failure",
    );
    assertCondition(message.includes("integration paid outbox failure"), "outbox trigger failure was not observed");
    const rolledBack = await readFixtureState(container, base, 4);
    assertReservedState(rolledBack, "failed payment outbox");
    assertCondition(rolledBack.outboxRows === 0 && rolledBack.invoicePaid === 0, "failed payment outbox left side effects");

    await container.db.execute(sql.raw(`DROP TRIGGER ${trigger} ON ${schema}.${identifier("store_order_outbox")}`));
    await container.db.execute(sql.raw(`DROP FUNCTION ${schema}.${fn}()`));
    const retried = await applyStoreOrderPayment(container, {
      orderId: ids.orderId,
      payType: PayType.WEIXIN,
      tradeNo: `retry-${base}`,
    });
    assertCondition(retried.outcome === "paid", "payment did not succeed after outbox recovery");
    const completed = await readFixtureState(container, base, 4);
    assertCondition(completed.paid === 1 && completed.outboxRows === 1, "retried payment evidence mismatch");
    return {
      outbox_failure_rolled_back: true,
      paid_after_retry: true,
      outbox_rows: completed.outboxRows,
    };
  });
}

async function runBalanceIdempotence(
  firstDb: DbClient,
  secondDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  base: number,
) {
  const ids = fixtureIds(base, 5);
  const uid = fixtureUid(base, 5);
  const run = (db: DbClient) => withSchema(db, schemaName, (container) =>
    applyStoreOrderBalancePayment(container, { uid, orderId: ids.orderNo }),
  );
  const results = await Promise.all([run(firstDb), run(secondDb)]);
  const paidTransitions = results.filter((result) => result.outcome === "paid").length;
  const alreadyPaid = results.filter((result) => result.outcome === "already-paid").length;
  assertCondition(
    paidTransitions === 1 && alreadyPaid === 1,
    "duplicate balance payments must debit exactly once",
  );

  return withSchema(observerDb, schemaName, async (container) => {
    const state = await readBalanceFixtureState(container, base, 5);
    assertCondition(state.paid === 1 && state.invoicePaid === 1, "balance payment was not persisted");
    assertCondition(state.balance === "10.00", "duplicate balance payment debited the wrong amount");
    assertCondition(state.billRows === 1 && state.outboxRows === 1, "duplicate balance payment duplicated evidence");
    return {
      paid_transitions: paidTransitions,
      already_paid: alreadyPaid,
      balance: state.balance,
      bill_rows: state.billRows,
      outbox_rows: state.outboxRows,
    };
  });
}

async function runBalanceInsufficient(db: DbClient, schemaName: string, base: number) {
  const ids = fixtureIds(base, 6);
  const uid = fixtureUid(base, 6);
  const message = await expectRejected(
    () => withSchema(db, schemaName, (container) =>
      applyStoreOrderBalancePayment(container, { uid, orderId: ids.orderNo }),
    ),
    "insufficient balance",
  );
  const businessRejected = message.includes("余额不足")
    && !/lock timeout|deadlock|canceling statement/i.test(message);
  assertCondition(businessRejected, "insufficient balance was not rejected by a business guard");
  return withSchema(db, schemaName, async (container) => {
    const state = await readBalanceFixtureState(container, base, 6);
    const balanceUnchanged = state.balance === "5.00" && state.billRows === 0;
    const orderUnchanged = state.paid === 0 && state.invoicePaid === 0 && state.outboxRows === 0;
    assertCondition(balanceUnchanged && orderUnchanged, "insufficient balance left partial payment state");
    return {
      business_rejected: businessRejected,
      balance_unchanged: balanceUnchanged,
      order_unchanged: orderUnchanged,
    };
  });
}

async function runBalanceOutboxAtomicity(db: DbClient, schemaName: string, base: number) {
  const schema = identifier(schemaName);
  const trigger = identifier("reject_balance_outbox_it");
  const fn = identifier("reject_balance_outbox_it");
  const ids = fixtureIds(base, 7);
  const uid = fixtureUid(base, 7);
  return withSchema(db, schemaName, async (container) => {
    await container.db.execute(sql.raw(`
      CREATE FUNCTION ${schema}.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.aggregate_id = ${ids.orderId} THEN
          RAISE EXCEPTION 'integration balance outbox failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `));
    await container.db.execute(sql.raw(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT ON ${schema}.${identifier("store_order_outbox")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}.${fn}()
    `));
    const message = await expectRejected(
      () => applyStoreOrderBalancePayment(container, { uid, orderId: ids.orderNo }),
      "balance outbox failure",
    );
    assertCondition(message.includes("integration balance outbox failure"), "balance outbox trigger failure was not observed");
    const rolledBack = await readBalanceFixtureState(container, base, 7);
    assertCondition(
      rolledBack.balance === "20.00"
      && rolledBack.billRows === 0
      && rolledBack.paid === 0
      && rolledBack.invoicePaid === 0
      && rolledBack.outboxRows === 0,
      "balance outbox failure did not roll back every write",
    );

    await container.db.execute(sql.raw(`DROP TRIGGER ${trigger} ON ${schema}.${identifier("store_order_outbox")}`));
    await container.db.execute(sql.raw(`DROP FUNCTION ${schema}.${fn}()`));
    const retried = await applyStoreOrderBalancePayment(container, { uid, orderId: ids.orderNo });
    assertCondition(retried.outcome === "paid", "balance payment did not succeed after outbox recovery");
    const completed = await readBalanceFixtureState(container, base, 7);
    assertCondition(
      completed.balance === "10.00"
      && completed.billRows === 1
      && completed.paid === 1
      && completed.invoicePaid === 1
      && completed.outboxRows === 1,
      "retried balance payment evidence mismatch",
    );
    return {
      outbox_failure_rolled_back: true,
      balance_after_retry: completed.balance,
      bill_rows: completed.billRows,
      outbox_rows: completed.outboxRows,
    };
  });
}

async function runBalanceCancelRace(
  paymentDb: DbClient,
  cancelDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  base: number,
) {
  const ids = fixtureIds(base, 8);
  const uid = fixtureUid(base, 8);
  const payment = withSchema(paymentDb, schemaName, (container) =>
    applyStoreOrderBalancePayment(container, { uid, orderId: ids.orderNo }),
  );
  const cancellation = withSchema(cancelDb, schemaName, async (container) => {
    await cancelStoreOrder(container, { uid, orderId: ids.orderNo });
    return "cancelled" as const;
  });
  const [paymentResult, cancelResult] = await Promise.allSettled([payment, cancellation]);
  assertCondition(paymentResult.status === "fulfilled", "balance/cancel payment result is missing");
  const paymentOutcome = paymentResult.value.outcome;
  const cancelOutcome: "cancelled" | "rejected" = cancelResult.status === "fulfilled"
    ? "cancelled"
    : "rejected";
  const paymentWon = paymentOutcome === "paid";
  const cancelWon = paymentOutcome === "not-payable" && cancelOutcome === "cancelled";
  assertCondition(
    (paymentWon && cancelOutcome === "rejected") || cancelWon,
    "balance/cancel race must have exactly one winner",
  );
  let loserBusinessRejected = cancelWon;
  if (paymentWon) {
    assertCondition(cancelResult.status === "rejected" && cancelResult.reason instanceof Error, "balance/cancel loser is missing");
    loserBusinessRejected = /已支付订单不能取消|订单状态不允许取消/.test(cancelResult.reason.message)
      && !/lock timeout|deadlock|canceling statement/i.test(cancelResult.reason.message);
  }
  assertCondition(loserBusinessRejected, "balance/cancel loser did not fail at a business guard");

  return withSchema(observerDb, schemaName, async (container) => {
    const state = await readBalanceFixtureState(container, base, 8);
    if (paymentWon) {
      assertCondition(
        state.paid === 1
        && state.balance === "10.00"
        && state.billRows === 1
        && state.outboxRows === 1
        && state.statusRows === 0,
        "balance winner state is inconsistent",
      );
    } else {
      assertCancelledState(state, "balance cancel winner");
      assertCondition(
        state.balance === "20.00"
        && state.billRows === 0
        && state.outboxRows === 0
        && state.statusRows === 1,
        "cancel winner touched user funds",
      );
    }
    return {
      winner: paymentWon ? "payment" as const : "cancel" as const,
      payment_outcome: paymentOutcome,
      cancel_outcome: cancelOutcome,
      loser_business_rejected: loserBusinessRejected,
      balance: state.balance,
      bill_rows: state.billRows,
      outbox_rows: state.outboxRows,
      status_rows: state.statusRows,
    };
  });
}

async function runZeroBalancePayment(db: DbClient, schemaName: string, base: number) {
  const ids = fixtureIds(base, 9);
  const uid = fixtureUid(base, 9);
  const result = await withSchema(db, schemaName, (container) =>
    applyStoreOrderBalancePayment(container, { uid, orderId: ids.orderNo }),
  );
  assertCondition(result.outcome === "paid", "zero-value balance order was not paid");
  return withSchema(db, schemaName, async (container) => {
    const state = await readBalanceFixtureState(container, base, 9);
    const balanceUnchanged = state.balance === "0.00";
    assertCondition(
      state.paid === 1
      && state.invoicePaid === 1
      && balanceUnchanged
      && state.billRows === 0
      && state.outboxRows === 1,
      "zero-value balance payment wrote inconsistent evidence",
    );
    return {
      paid: state.paid === 1,
      balance_unchanged: balanceUnchanged,
      bill_rows: state.billRows,
      outbox_rows: state.outboxRows,
    };
  });
}

async function readIntegralPaymentState(
  container: Container,
  base: number,
  offset: number,
) {
  const ids = fixtureIds(base, offset);
  const uid = fixtureUid(base, offset);
  const [state, users, integralBills] = await Promise.all([
    readBalanceFixtureState(container, base, offset),
    container.db
      .select({ integral: userTable.integral })
      .from(userTable)
      .where(eq(userTable.uid, uid))
      .limit(1),
    container.db
      .select({ value: count() })
      .from(userBill)
      .where(
        and(
          eq(userBill.uid, uid),
          eq(userBill.linkId, String(ids.orderId)),
          eq(userBill.category, "integral"),
          eq(userBill.type, "storeIntegral_use_integral"),
        ),
      ),
  ]);
  assertCondition(users[0], `integral payment fixture ${offset} user is missing`);
  return {
    ...state,
    integral: users[0].integral,
    integralBillRows: integralBills[0]?.value ?? -1,
  };
}

async function runIntegralBalancePayment(
  firstDb: DbClient,
  secondDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  base: number,
) {
  const ids = fixtureIds(base, 10);
  const uid = fixtureUid(base, 10);
  const run = (db: DbClient) => withSchema(db, schemaName, (container) =>
    applyStoreOrderBalancePayment(container, { uid, orderId: ids.orderNo }),
  );
  const results = await Promise.all([run(firstDb), run(secondDb)]);
  const paidTransitions = results.filter((result) => result.outcome === "paid").length;
  const alreadyPaid = results.filter((result) => result.outcome === "already-paid").length;
  assertCondition(
    paidTransitions === 1 && alreadyPaid === 1,
    "duplicate integral balance payments must debit money and points exactly once",
  );
  return withSchema(observerDb, schemaName, async (container) => {
    const state = await readIntegralPaymentState(container, base, 10);
    assertCondition(
      state.paid === 1
      && state.balance === "10.00"
      && state.integral === 60
      && state.billRows === 1
      && state.integralBillRows === 1
      && state.outboxRows === 1,
      "integral balance payment wrote inconsistent evidence",
    );
    return {
      paid_transitions: paidTransitions,
      already_paid: alreadyPaid,
      balance: state.balance,
      integral: state.integral,
      balance_bill_rows: state.billRows,
      integral_bill_rows: state.integralBillRows,
      outbox_rows: state.outboxRows,
    };
  });
}

async function runIntegralInsufficient(db: DbClient, schemaName: string, base: number) {
  const ids = fixtureIds(base, 11);
  const uid = fixtureUid(base, 11);
  const message = await expectRejected(
    () => withSchema(db, schemaName, (container) =>
      applyStoreOrderBalancePayment(container, { uid, orderId: ids.orderNo }),
    ),
    "insufficient required integral",
  );
  const businessRejected = message.includes("积分不足")
    && !/lock timeout|deadlock|canceling statement/i.test(message);
  assertCondition(businessRejected, "insufficient required integral was not rejected by a business guard");
  return withSchema(db, schemaName, async (container) => {
    const state = await readIntegralPaymentState(container, base, 11);
    const fundsUnchanged = state.balance === "20.00"
      && state.integral === 100
      && state.billRows === 0
      && state.integralBillRows === 0;
    const orderUnchanged = state.paid === 0 && state.invoicePaid === 0 && state.outboxRows === 0;
    assertCondition(fundsUnchanged && orderUnchanged, "insufficient integral left partial payment state");
    return {
      business_rejected: businessRejected,
      funds_unchanged: fundsUnchanged,
      order_unchanged: orderUnchanged,
    };
  });
}

async function runRetiredActivityOrderDisposition(
  db: DbClient,
  schemaName: string,
  base: number,
) {
  const ids = fixtureIds(base, 12);
  const uid = fixtureUid(base, 12);
  const rejection = await withSchema(db, schemaName, async (container) => expectRejected(
    () => applyStoreOrderBalancePayment(container, { uid, orderId: ids.orderNo }),
    "retired activity payment",
  ));
  const paymentRejected = /历史活动订单数据不完整/.test(rejection)
    && !/lock timeout|deadlock|canceling statement/i.test(rejection);
  assertCondition(paymentRejected, "retired activity payment did not fail at the evidence guard");

  const beforeCancel = await withSchema(db, schemaName, (container) =>
    readBalanceFixtureState(container, base, 12));
  const fundsUnchanged = beforeCancel.balance === "20.00"
    && beforeCancel.billRows === 0
    && beforeCancel.paid === 0
    && beforeCancel.outboxRows === 0;
  assertCondition(fundsUnchanged, "retired activity payment touched funds or order state");

  await withSchema(db, schemaName, (container) =>
    cancelStoreOrder(container, { uid, orderId: ids.orderNo }));
  return withSchema(db, schemaName, async (container) => {
    const [state, statuses] = await Promise.all([
      readBalanceFixtureState(container, base, 12),
      container.db.select({ message: storeOrderStatus.changeMessage })
        .from(storeOrderStatus)
        .where(and(
          eq(storeOrderStatus.oid, ids.orderId),
          eq(storeOrderStatus.changeType, "cancel"),
        )),
    ]);
    assertCancelledState(state, "retired activity cancel");
    const auditStatusWritten = statuses.length === 1
      && statuses[0]?.message === "用户取消历史失效活动订单并恢复现存占用资源";
    assertCondition(auditStatusWritten, "retired activity cancellation audit status is missing");
    return {
      payment_rejected: paymentRejected,
      funds_unchanged: fundsUnchanged,
      cancelled: state.status === -2 && state.isDel === 1,
      base_inventory_restored: state.productStock === 10 && state.skuStock === 10,
      audit_status_written: auditStatusWritten,
    };
  });
}

export async function runStoreOrderPaymentCancelPostgresScenario(
  connectionString: string,
): Promise<StoreOrderPaymentCancelPostgresReport> {
  const schemaName = makeSchemaName();
  const schemaIdentifier = identifier(schemaName);
  const adminDb = createDbFromConnectionString(connectionString, 1);
  const concurrentDbA = createDbFromConnectionString(connectionString, 1);
  const concurrentDbB = createDbFromConnectionString(connectionString, 1);
  const clients = [adminDb.$client, concurrentDbA.$client, concurrentDbB.$client];
  let created = false;
  let report: Omit<StoreOrderPaymentCancelPostgresReport, "schema_removed" | "public_state_unchanged"> | undefined;
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
    const base = 1_000_000_000 + (random[0] % 50_000_000);
    await seedFixtures(adminDb, schemaName, base);
    const atomicCancel = await runAtomicCancel(adminDb, schemaName, base);
    const doubleCancel = await runDoubleCancel(
      concurrentDbA,
      concurrentDbB,
      adminDb,
      schemaName,
      base,
    );
    const paymentCancelRace = await runPaymentCancelRace(
      concurrentDbA,
      concurrentDbB,
      adminDb,
      schemaName,
      base,
    );
    const paymentIdempotence = await runPaymentIdempotence(
      concurrentDbA,
      concurrentDbB,
      adminDb,
      schemaName,
      base,
    );
    const paymentOutboxAtomicity = await runPaymentOutboxAtomicity(adminDb, schemaName, base);
    const balanceIdempotence = await runBalanceIdempotence(
      concurrentDbA,
      concurrentDbB,
      adminDb,
      schemaName,
      base,
    );
    const balanceInsufficient = await runBalanceInsufficient(adminDb, schemaName, base);
    const balanceOutboxAtomicity = await runBalanceOutboxAtomicity(adminDb, schemaName, base);
    const balanceCancelRace = await runBalanceCancelRace(
      concurrentDbA,
      concurrentDbB,
      adminDb,
      schemaName,
      base,
    );
    const zeroBalancePayment = await runZeroBalancePayment(adminDb, schemaName, base);
    const integralBalancePayment = await runIntegralBalancePayment(
      concurrentDbA,
      concurrentDbB,
      adminDb,
      schemaName,
      base,
    );
    const integralInsufficient = await runIntegralInsufficient(adminDb, schemaName, base);
    const retiredActivityOrder = await runRetiredActivityOrderDisposition(
      adminDb,
      schemaName,
      base,
    );
    report = {
      server_version: versionRows[0]?.server_version ?? "unknown",
      schema_created: true,
      atomic_cancel: atomicCancel,
      double_cancel: doubleCancel,
      payment_cancel_race: paymentCancelRace,
      payment_idempotence: paymentIdempotence,
      payment_outbox_atomicity: paymentOutboxAtomicity,
      balance_idempotence: balanceIdempotence,
      balance_insufficient: balanceInsufficient,
      balance_outbox_atomicity: balanceOutboxAtomicity,
      balance_cancel_race: balanceCancelRace,
      zero_balance_payment: zeroBalancePayment,
      integral_balance_payment: integralBalancePayment,
      integral_insufficient: integralInsufficient,
      retired_activity_order: retiredActivityOrder,
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
