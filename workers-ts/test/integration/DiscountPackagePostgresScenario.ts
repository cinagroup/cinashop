import { and, count, eq, inArray, sql } from "drizzle-orm";
import {
  storeCart,
  storeDiscounts,
  storeDiscountsProducts,
  storeOrder,
  storeOrderCartInfo,
  storeOrderRefund,
  storeOrderStatus,
  storeProduct,
  storeProductAttrValue,
  systemStore,
  user,
} from "@/models/schema";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
  type DbClient,
} from "@/lib/di";
import { StoreDiscountService } from "@/services/activity/StoreDiscountService";
import {
  cancelStoreOrder,
  StoreOrderCreateService,
  type CreateOrderParams,
  type StoreOrderCreationRuntime,
} from "@/services/order/StoreOrderCreateService";
import {
  applyOrderRefund,
  finalizeStoreOrderRefund,
} from "@/services/order/StoreOrderRefundService";
import { ValidateException } from "@/utils/errors";

const CLONED_TABLES = [
  "user",
  "user_bill",
  "user_brokerage",
  "system_store",
  "store_cart",
  "store_order",
  "store_order_cart_info",
  "store_order_invoice",
  "store_order_refund",
  "store_order_status",
  "store_product",
  "store_product_attr_value",
  "store_discounts",
  "store_discounts_products",
] as const;

const LOCAL_SEQUENCE_TABLES = [
  "user_bill",
  "store_cart",
  "store_order",
  "store_order_cart_info",
  "store_order_refund",
  "store_order_status",
] as const;

interface PublicSnapshot {
  users: number;
  carts: number;
  orders: number;
  cart_infos: number;
  refunds: number;
  statuses: number;
  products: number;
  skus: number;
  packages: number;
  package_products: number;
  cart_sequence: string | null;
  order_sequence: string | null;
  cart_info_sequence: string | null;
  refund_sequence: string | null;
  status_sequence: string | null;
  user_bill_sequence: string | null;
}

interface PackageEntryFixture {
  entryId: number;
  productId: number;
  baseSkuId: number;
  packageSkuId: number;
  baseUnique: string;
  packageUnique: string;
  suk: string;
  price: string;
  required: boolean;
}

interface PackageFixture {
  id: number;
  title: string;
  type: number;
  limitNum: number;
  isLimit: number;
  freeShipping: number;
  isSupportRefund: number;
  entries: PackageEntryFixture[];
}

interface FixtureIds {
  storeId: number;
  users: number[];
  fixed: PackageFixture;
  mix: PackageFixture;
  concurrent: PackageFixture;
  rollback: PackageFixture;
  refund: PackageFixture;
  nonRefundable: PackageFixture;
}

export interface DiscountPackagePostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  public_state_unchanged: boolean;
  fixed_order_cancel: {
    total_price: string;
    postage: string;
    activity_id: number;
    snapshot_prices: string[];
    snapshot_entry_ids: number[];
    refund_supported: boolean;
    limit_reserved_once: boolean;
    resources_restored: boolean;
    cancel_status_rows: number;
  };
  mix_validation: {
    missing_required_rejected: boolean;
    minimum_two_rejected: boolean;
    valid_cart_rows: number;
  };
  concurrent_limit: {
    successes: number;
    rejections: number;
    business_rejected: boolean;
    orders: number;
    claimed_carts: number;
    loser_carts_released: number;
    limit_num: number;
    stock_decrements: number;
  };
  forced_failure_rollback: {
    rejected: boolean;
    orders: number;
    claimed_carts: number;
    limit_num: number;
    stock_decrements: number;
  };
  partial_full_refund: {
    partial_limit_held: boolean;
    partial_refund_status: number;
    final_limit_restored_once: boolean;
    fully_refunded: boolean;
    stock_restored: boolean;
    refund_rows: number;
  };
  non_refundable: {
    application_rejected: boolean;
    snapshot_blocked: boolean;
    refund_rows: number;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PostgreSQL discount-package integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_discount_it_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

function skuUnique(prefix: "b" | "p", value: number): string {
  return `${prefix}${value.toString(36).padStart(7, "0").slice(-7)}`;
}

function makePackage(
  base: number,
  offset: number,
  options: {
    title: string;
    type?: number;
    itemCount?: number;
    isLimit?: number;
    limitNum?: number;
    freeShipping?: number;
    isSupportRefund?: number;
    prices?: string[];
  },
): PackageFixture {
  const itemCount = options.itemCount ?? 2;
  const entries = Array.from({ length: itemCount }, (_, index): PackageEntryFixture => {
    const serial = offset * 10 + index + 1;
    return {
      entryId: base + 10_000 + serial,
      productId: base + 20_000 + serial,
      baseSkuId: base + 30_000 + serial,
      packageSkuId: base + 40_000 + serial,
      baseUnique: skuUnique("b", serial),
      packageUnique: skuUnique("p", serial),
      suk: `规格-${offset}-${index + 1}`,
      price: options.prices?.[index] ?? `${index + 5}.00`,
      required: options.type === 1 ? index === 0 : true,
    };
  });
  return {
    id: base + 1_000 + offset,
    title: options.title,
    type: options.type ?? 0,
    limitNum: options.limitNum ?? 0,
    isLimit: options.isLimit ?? 0,
    freeShipping: options.freeShipping ?? 0,
    isSupportRefund: options.isSupportRefund ?? 1,
    entries,
  };
}

function makeFixtureIds(base: number): FixtureIds {
  return {
    storeId: base + 50,
    users: Array.from({ length: 7 }, (_, index) => base + index + 1),
    fixed: makePackage(base, 10, {
      title: "固定套餐审计",
      isLimit: 1,
      limitNum: 2,
      freeShipping: 1,
      prices: ["7.25", "8.50"],
    }),
    mix: makePackage(base, 20, {
      title: "任选套餐审计",
      type: 1,
      itemCount: 3,
      prices: ["3.00", "4.00", "5.00"],
    }),
    concurrent: makePackage(base, 30, {
      title: "并发限额审计",
      isLimit: 1,
      limitNum: 1,
      prices: ["6.00", "7.00"],
    }),
    rollback: makePackage(base, 40, {
      title: "事务回滚审计",
      isLimit: 1,
      limitNum: 1,
      prices: ["8.00", "9.00"],
    }),
    refund: makePackage(base, 50, {
      title: "退款限额审计",
      isLimit: 1,
      limitNum: 1,
      prices: ["4.00", "6.00"],
    }),
    nonRefundable: makePackage(base, 60, {
      title: "不可退款审计",
      isSupportRefund: 0,
      prices: ["2.00", "3.00"],
    }),
  };
}

function createRuntime(): StoreOrderCreationRuntime {
  return {
    CONFIG_KV: {
      async get() {
        return "0";
      },
      async put() {},
      async delete() {},
    },
    async nextOrderId() {
      const random = new Uint32Array(2);
      crypto.getRandomValues(random);
      return `wxdp${Date.now().toString(36)}${random[0].toString(36)}${random[1].toString(36)}`.slice(0, 32);
    },
  };
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
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    return fn(createContainerFromDb(tx));
  });
}

function packageSelections(fixture: PackageFixture, indexes = fixture.entries.map((_, index) => index)) {
  return indexes.map((index) => {
    const entry = fixture.entries[index];
    if (!entry) throw new Error("package fixture entry missing");
    return { entryId: entry.entryId, productId: entry.productId, unique: entry.packageUnique };
  });
}

async function addPackageCarts(
  container: Container,
  uid: number,
  fixture: PackageFixture,
  indexes?: number[],
) {
  return new StoreDiscountService(container).createDirectBuyCarts(
    uid,
    fixture.id,
    packageSelections(fixture, indexes),
  );
}

async function createOrder(
  container: Container,
  params: Omit<CreateOrderParams, "type" | "userIp">,
) {
  return StoreOrderCreateService.createWithRuntime(container, createRuntime(), {
    ...params,
    type: 5,
    userIp: "127.0.0.1",
  });
}

function orderInput(
  ids: FixtureIds,
  uid: number,
  key: string,
  cartIds: number[],
  shippingType: 1 | 2 = 2,
): Omit<CreateOrderParams, "type" | "userIp"> {
  return {
    uid,
    key,
    cartIds,
    realName: "套餐审计",
    userPhone: "13000000000",
    province: shippingType === 1 ? "审计省" : "",
    userAddress: shippingType === 1 ? "隔离 schema" : "",
    shippingType,
    storeId: shippingType === 2 ? ids.storeId : 0,
  };
}

async function publicSnapshot(db: DbClient): Promise<PublicSnapshot> {
  const rows = await db.$client<PublicSnapshot[]>`
    SELECT
      (SELECT count(*)::integer FROM public."user") AS users,
      (SELECT count(*)::integer FROM public.store_cart) AS carts,
      (SELECT count(*)::integer FROM public.store_order) AS orders,
      (SELECT count(*)::integer FROM public.store_order_cart_info) AS cart_infos,
      (SELECT count(*)::integer FROM public.store_order_refund) AS refunds,
      (SELECT count(*)::integer FROM public.store_order_status) AS statuses,
      (SELECT count(*)::integer FROM public.store_product) AS products,
      (SELECT count(*)::integer FROM public.store_product_attr_value) AS skus,
      (SELECT count(*)::integer FROM public.store_discounts) AS packages,
      (SELECT count(*)::integer FROM public.store_discounts_products) AS package_products,
      (SELECT last_value::text FROM pg_sequences WHERE schemaname = 'public' AND sequencename = 'store_cart_id_seq') AS cart_sequence,
      (SELECT last_value::text FROM pg_sequences WHERE schemaname = 'public' AND sequencename = 'store_order_id_seq') AS order_sequence,
      (SELECT last_value::text FROM pg_sequences WHERE schemaname = 'public' AND sequencename = 'store_order_cart_info_id_seq') AS cart_info_sequence,
      (SELECT last_value::text FROM pg_sequences WHERE schemaname = 'public' AND sequencename = 'store_order_refund_id_seq') AS refund_sequence,
      (SELECT last_value::text FROM pg_sequences WHERE schemaname = 'public' AND sequencename = 'store_order_status_id_seq') AS status_sequence,
      (SELECT last_value::text FROM pg_sequences WHERE schemaname = 'public' AND sequencename = 'user_bill_id_seq') AS user_bill_sequence
  `;
  if (!rows[0]) throw new Error("unable to read public discount-package snapshot");
  return rows[0];
}

async function seedFixtures(container: Container, ids: FixtureIds): Promise<void> {
  const packages = [
    ids.fixed,
    ids.mix,
    ids.concurrent,
    ids.rollback,
    ids.refund,
    ids.nonRefundable,
  ];
  await withTx(container, async (tx) => {
    await tx.insert(user).values(ids.users.map((uid, index) => ({
      uid,
      account: `discount-audit-${index}-${uid}`.slice(0, 32),
      nickname: `套餐审计用户${index + 1}`,
      status: 1,
      isDel: 0,
      nowMoney: "0.00",
    })));
    await tx.insert(systemStore).values({
      id: ids.storeId,
      name: "套餐审计自提门店",
      isStore: 1,
      isShow: 1,
      isDel: 0,
    });
    await tx.insert(storeDiscounts).values(packages.map((fixture) => ({
      id: fixture.id,
      title: fixture.title,
      type: fixture.type,
      isLimit: fixture.isLimit,
      limitNum: fixture.limitNum,
      freeShipping: fixture.freeShipping,
      isSupportRefund: fixture.isSupportRefund,
      status: 1,
      isDel: 0,
      isTime: 0,
      startTime: 0,
      stopTime: 0,
    })));
    const allEntries = packages.flatMap((fixture) => fixture.entries.map((entry) => ({
      id: entry.entryId,
      discountId: fixture.id,
      productId: entry.productId,
      productType: 0,
      title: `${fixture.title}-${entry.suk}`,
      image: `https://audit.invalid/${entry.productId}.png`,
      type: entry.required ? 1 : 0,
    })));
    await tx.insert(storeDiscountsProducts).values(allEntries);
    await tx.insert(storeProduct).values(packages.flatMap((fixture) => fixture.entries.map((entry) => ({
      id: entry.productId,
      storeName: `${fixture.title}-${entry.suk}`,
      image: `https://audit.invalid/${entry.productId}.png`,
      price: "20.00",
      otPrice: "25.00",
      stock: 5,
      sales: 0,
      isShow: 1,
      isDel: 0,
      productType: 0,
      freight: 2,
      tempId: 1,
    }))));
    await tx.insert(storeProductAttrValue).values(packages.flatMap((fixture) =>
      fixture.entries.flatMap((entry) => [
        {
          id: entry.baseSkuId,
          productId: entry.productId,
          productType: 0,
          suk: entry.suk,
          unique: entry.baseUnique,
          price: "20.00",
          otPrice: "25.00",
          cost: "1.00",
          stock: 5,
          sumStock: 5,
          sales: 0,
          type: 0,
        },
        {
          id: entry.packageSkuId,
          productId: entry.entryId,
          productType: 0,
          suk: entry.suk,
          unique: entry.packageUnique,
          price: entry.price,
          otPrice: "20.00",
          cost: "1.00",
          stock: 5,
          sumStock: 5,
          sales: 0,
          type: 5,
        },
      ]
    )));
  });
}

async function productState(container: Container, fixture: PackageFixture) {
  const products = await container.db
    .select({ id: storeProduct.id, stock: storeProduct.stock, sales: storeProduct.sales })
    .from(storeProduct)
    .where(inArray(storeProduct.id, fixture.entries.map((entry) => entry.productId)));
  const skus = await container.db
    .select({ id: storeProductAttrValue.id, stock: storeProductAttrValue.stock, sales: storeProductAttrValue.sales })
    .from(storeProductAttrValue)
    .where(inArray(storeProductAttrValue.id, fixture.entries.map((entry) => entry.baseSkuId)));
  return { products, skus };
}

async function runFixedOrderCancel(container: Container, ids: FixtureIds) {
  const carts = await addPackageCarts(container, ids.users[0], ids.fixed);
  const created = await createOrder(container, orderInput(
    ids,
    ids.users[0],
    `fixed-${ids.fixed.id}`,
    carts.cartIds,
    1,
  ));
  const orders = await container.db.select().from(storeOrder)
    .where(eq(storeOrder.orderId, created.orderId)).limit(1);
  const order = orders[0];
  assertCondition(order, "fixed package order disappeared");
  const [snapshots, packageRows] = await Promise.all([
    container.db.select().from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, order.id)).orderBy(storeOrderCartInfo.id),
    container.db.select().from(storeDiscounts)
      .where(eq(storeDiscounts.id, ids.fixed.id)).limit(1),
  ]);
  const parsed = snapshots.map((row) => JSON.parse(row.cartInfo ?? "{}") as {
    sku?: { price?: string };
    discount?: { entryId?: number };
  });
  const prices = parsed.map((row) => String(row.sku?.price ?? ""));
  const entryIds = parsed.map((row) => Number(row.discount?.entryId ?? 0));
  const reservedOnce = packageRows[0]?.limitNum === 1;
  assertCondition(
    order.type === 5 && order.activityId === ids.fixed.id && order.totalPrice === "15.75"
      && order.totalPostage === "0.00" && prices.join(",") === "7.25,8.50"
      && entryIds.join(",") === ids.fixed.entries.map((entry) => entry.entryId).join(",")
      && snapshots.every((row) => row.isSupportRefund === 1) && reservedOnce,
    "fixed package did not persist authoritative price, metadata, shipping or one limit reservation",
  );

  await cancelStoreOrder(container, { uid: ids.users[0], orderId: created.orderId });
  const [afterPackage, afterOrder, afterStock, statuses] = await Promise.all([
    container.db.select().from(storeDiscounts).where(eq(storeDiscounts.id, ids.fixed.id)).limit(1),
    container.db.select().from(storeOrder).where(eq(storeOrder.id, order.id)).limit(1),
    productState(container, ids.fixed),
    container.db.select({ value: count() }).from(storeOrderStatus)
      .where(and(eq(storeOrderStatus.oid, order.id), eq(storeOrderStatus.changeType, "cancel"))),
  ]);
  const restored = afterPackage[0]?.limitNum === 2 && afterOrder[0]?.status === -2
    && afterStock.products.every((row) => row.stock === 5 && row.sales === 0)
    && afterStock.skus.every((row) => row.stock === 5 && row.sales === 0);
  assertCondition(restored, "fixed package cancellation did not restore base stock and one package limit");
  return {
    total_price: order.totalPrice,
    postage: order.totalPostage,
    activity_id: order.activityId,
    snapshot_prices: prices,
    snapshot_entry_ids: entryIds,
    refund_supported: snapshots.every((row) => row.isSupportRefund === 1),
    limit_reserved_once: reservedOnce,
    resources_restored: restored,
    cancel_status_rows: statuses[0]?.value ?? 0,
  };
}

async function runMixValidation(container: Container, ids: FixtureIds) {
  let missingRequired = false;
  let minimumTwo = false;
  try {
    await addPackageCarts(container, ids.users[1], ids.mix, [1, 2]);
  } catch (error) {
    missingRequired = error instanceof ValidateException;
  }
  try {
    await addPackageCarts(container, ids.users[1], ids.mix, [0]);
  } catch (error) {
    minimumTwo = error instanceof ValidateException;
  }
  const carts = await addPackageCarts(container, ids.users[1], ids.mix, [0, 2]);
  assertCondition(missingRequired && minimumTwo && carts.cartIds.length === 2, "mix package selection rules diverged");
  return {
    missing_required_rejected: missingRequired,
    minimum_two_rejected: minimumTwo,
    valid_cart_rows: carts.cartIds.length,
  };
}

async function runConcurrentLimit(
  mainDb: DbClient,
  firstDb: DbClient,
  secondDb: DbClient,
  schemaName: string,
  ids: FixtureIds,
) {
  const firstCarts = await withSchema(mainDb, schemaName, (container) =>
    addPackageCarts(container, ids.users[2], ids.concurrent)
  );
  const secondCarts = await withSchema(mainDb, schemaName, (container) =>
    addPackageCarts(container, ids.users[3], ids.concurrent)
  );
  const results = await Promise.allSettled([
    withSchema(firstDb, schemaName, (container) => createOrder(
      container,
      orderInput(ids, ids.users[2], `concurrent-a-${ids.concurrent.id}`, firstCarts.cartIds),
    )),
    withSchema(secondDb, schemaName, (container) => createOrder(
      container,
      orderInput(ids, ids.users[3], `concurrent-b-${ids.concurrent.id}`, secondCarts.cartIds),
    )),
  ]);
  const successes = results.filter((result) => result.status === "fulfilled").length;
  const rejectedResults = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  return withSchema(mainDb, schemaName, async (container) => {
  const rows = await container.db.select().from(storeOrder)
    .where(and(eq(storeOrder.type, 5), eq(storeOrder.activityId, ids.concurrent.id)));
  const carts = await container.db.select().from(storeCart)
    .where(and(eq(storeCart.type, 5), eq(storeCart.activityId, ids.concurrent.id)));
  const packages = await container.db.select().from(storeDiscounts)
    .where(eq(storeDiscounts.id, ids.concurrent.id)).limit(1);
  const state = await productState(container, ids.concurrent);
  const stockDecrements = state.products.reduce((total, row) => total + (5 - row.stock), 0);
  const claimed = carts.filter((row) => row.isPay === 1).length;
  const released = carts.filter((row) => row.isPay === 0).length;
  const businessRejected = rejectedResults.every((result) => result.reason instanceof ValidateException);
  assertCondition(
    successes === 1 && rejectedResults.length === 1 && businessRejected && rows.length === 1
      && claimed === 2 && released === 2 && packages[0]?.limitNum === 0 && stockDecrements === 2,
    "concurrent one-package limit did not select exactly one winner",
  );
  return {
    successes,
    rejections: rejectedResults.length,
    business_rejected: businessRejected,
    orders: rows.length,
    claimed_carts: claimed,
    loser_carts_released: released,
    limit_num: packages[0]?.limitNum ?? -1,
    stock_decrements: stockDecrements,
  };
  });
}

async function runForcedRollback(container: Container, ids: FixtureIds, schemaName: string) {
  const carts = await addPackageCarts(container, ids.users[4], ids.rollback);
  const schema = identifier(schemaName);
  await container.db.execute(sql.raw(`
    CREATE FUNCTION ${schema}.discount_audit_fail_snapshot() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.uid = ${ids.users[4]} THEN
        RAISE EXCEPTION 'forced discount snapshot failure';
      END IF;
      RETURN NEW;
    END
    $$
  `));
  await container.db.execute(sql.raw(`
    CREATE TRIGGER discount_audit_fail_snapshot
    BEFORE INSERT ON ${schema}.store_order_cart_info
    FOR EACH ROW EXECUTE FUNCTION ${schema}.discount_audit_fail_snapshot()
  `));
  let rejected = false;
  try {
    await createOrder(container, orderInput(
      ids,
      ids.users[4],
      `rollback-${ids.rollback.id}`,
      carts.cartIds,
    ));
  } catch {
    rejected = true;
  }
  await container.db.execute(sql.raw(`DROP TRIGGER discount_audit_fail_snapshot ON ${schema}.store_order_cart_info`));
  await container.db.execute(sql.raw(`DROP FUNCTION ${schema}.discount_audit_fail_snapshot()`));
  const [orders, cartRows, packageRows, state] = await Promise.all([
    container.db.select().from(storeOrder)
      .where(and(eq(storeOrder.type, 5), eq(storeOrder.activityId, ids.rollback.id))),
    container.db.select().from(storeCart).where(inArray(storeCart.id, carts.cartIds)),
    container.db.select().from(storeDiscounts).where(eq(storeDiscounts.id, ids.rollback.id)).limit(1),
    productState(container, ids.rollback),
  ]);
  const stockDecrements = state.products.reduce((total, row) => total + (5 - row.stock), 0);
  const claimed = cartRows.filter((row) => row.isPay === 1).length;
  assertCondition(
    rejected && orders.length === 0 && claimed === 0 && packageRows[0]?.limitNum === 1
      && stockDecrements === 0 && state.skus.every((row) => row.stock === 5),
    "snapshot failure did not roll back order, carts, package limit and base inventory",
  );
  return {
    rejected,
    orders: orders.length,
    claimed_carts: claimed,
    limit_num: packageRows[0]?.limitNum ?? -1,
    stock_decrements: stockDecrements,
  };
}

async function runPartialFullRefund(container: Container, ids: FixtureIds) {
  const carts = await addPackageCarts(container, ids.users[5], ids.refund);
  const created = await createOrder(container, orderInput(
    ids,
    ids.users[5],
    `refund-${ids.refund.id}`,
    carts.cartIds,
  ));
  const orderRows = await container.db.select().from(storeOrder)
    .where(eq(storeOrder.orderId, created.orderId)).limit(1);
  const order = orderRows[0];
  assertCondition(order, "refund package order disappeared");
  await container.db.update(storeOrder).set({ paid: 1, payType: "yue" }).where(eq(storeOrder.id, order.id));

  const first = await applyOrderRefund(container, {
    uid: ids.users[5],
    orderId: created.orderId,
    refundReason: "套餐部分退款审计",
    refundExplain: "随机 schema",
    applyType: 1,
    cartIds: [carts.cartIds[0]],
  });
  await finalizeStoreOrderRefund(container, first.refundId, 1_700_100_001);
  const [partialPackage, partialOrder] = await Promise.all([
    container.db.select().from(storeDiscounts).where(eq(storeDiscounts.id, ids.refund.id)).limit(1),
    container.db.select().from(storeOrder).where(eq(storeOrder.id, order.id)).limit(1),
  ]);

  const second = await applyOrderRefund(container, {
    uid: ids.users[5],
    orderId: created.orderId,
    refundReason: "套餐剩余退款审计",
    refundExplain: "随机 schema",
    applyType: 1,
  });
  await finalizeStoreOrderRefund(container, second.refundId, 1_700_100_002);
  const [finalPackage, finalOrder, state, refundRows] = await Promise.all([
    container.db.select().from(storeDiscounts).where(eq(storeDiscounts.id, ids.refund.id)).limit(1),
    container.db.select().from(storeOrder).where(eq(storeOrder.id, order.id)).limit(1),
    productState(container, ids.refund),
    container.db.select({ value: count() }).from(storeOrderRefund)
      .where(eq(storeOrderRefund.storeOrderId, order.id)),
  ]);
  const stockRestored = state.products.every((row) => row.stock === 5 && row.sales === 0)
    && state.skus.every((row) => row.stock === 5 && row.sales === 0);
  assertCondition(
    partialPackage[0]?.limitNum === 0 && partialOrder[0]?.refundStatus === 3
      && finalPackage[0]?.limitNum === 1 && finalOrder[0]?.refundStatus === 2
      && stockRestored && refundRows[0]?.value === 2,
    "package limit was not held for partial refund or restored exactly once on full refund",
  );
  return {
    partial_limit_held: partialPackage[0]?.limitNum === 0,
    partial_refund_status: partialOrder[0]?.refundStatus ?? -1,
    final_limit_restored_once: finalPackage[0]?.limitNum === 1,
    fully_refunded: finalOrder[0]?.refundStatus === 2,
    stock_restored: stockRestored,
    refund_rows: refundRows[0]?.value ?? 0,
  };
}

async function runNonRefundable(container: Container, ids: FixtureIds) {
  const carts = await addPackageCarts(container, ids.users[6], ids.nonRefundable);
  const created = await createOrder(container, orderInput(
    ids,
    ids.users[6],
    `non-refund-${ids.nonRefundable.id}`,
    carts.cartIds,
  ));
  const orderRows = await container.db.select().from(storeOrder)
    .where(eq(storeOrder.orderId, created.orderId)).limit(1);
  const order = orderRows[0];
  assertCondition(order, "non-refundable package order disappeared");
  await container.db.update(storeOrder).set({ paid: 1, payType: "yue" }).where(eq(storeOrder.id, order.id));
  const snapshots = await container.db.select().from(storeOrderCartInfo)
    .where(eq(storeOrderCartInfo.oid, order.id));
  let rejected = false;
  try {
    await applyOrderRefund(container, {
      uid: ids.users[6],
      orderId: created.orderId,
      refundReason: "不应允许退款",
      refundExplain: "随机 schema",
      applyType: 1,
    });
  } catch (error) {
    rejected = error instanceof ValidateException;
  }
  const refundRows = await container.db.select({ value: count() }).from(storeOrderRefund)
    .where(eq(storeOrderRefund.storeOrderId, order.id));
  const snapshotBlocked = snapshots.length === 2 && snapshots.every((row) => row.isSupportRefund === 0);
  assertCondition(rejected && snapshotBlocked && refundRows[0]?.value === 0, "non-refundable package accepted an application");
  return {
    application_rejected: rejected,
    snapshot_blocked: snapshotBlocked,
    refund_rows: refundRows[0]?.value ?? 0,
  };
}

export async function runDiscountPackagePostgresScenario(
  connectionString: string,
): Promise<DiscountPackagePostgresReport> {
  const schemaName = makeSchemaName();
  const schema = identifier(schemaName);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_discount_package_audit_root",
  });
  const scoped = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_discount_package_audit_main",
  });
  const concurrentA = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_discount_package_audit_a",
  });
  const concurrentB = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_discount_package_audit_b",
  });
  const clients = [root.$client, scoped.$client, concurrentA.$client, concurrentB.$client];
  let created = false;
  let before: PublicSnapshot | undefined;
  let after: PublicSnapshot | undefined;
  let schemaRemoved = false;
  let report: Omit<DiscountPackagePostgresReport, "schema_removed" | "public_state_unchanged"> | undefined;
  try {
    const versionRows = await root.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    before = await publicSnapshot(root);
    await root.$client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '20s'`;
      await tx.unsafe(`CREATE SCHEMA ${schema}`);
      for (const table of CLONED_TABLES) {
        const tableName = identifier(table);
        await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
      }
      for (const table of LOCAL_SEQUENCE_TABLES) {
        const tableName = identifier(table);
        const sequenceName = identifier(`${table}_id_seq_discount_it`);
        await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequenceName}`);
        await tx.unsafe(`ALTER SEQUENCE ${schema}.${sequenceName} OWNED BY ${schema}.${tableName}."id"`);
        await tx.unsafe(
          `ALTER TABLE ${schema}.${tableName} ALTER COLUMN "id" SET DEFAULT nextval('${schemaName}.${table}_id_seq_discount_it'::regclass)`,
        );
      }
    });
    created = true;

    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const ids = makeFixtureIds(1_650_000_000 + (random[0] % 20_000_000));
    await withSchema(scoped, schemaName, (container) => seedFixtures(container, ids));
    const fixedOrderCancel = await withSchema(scoped, schemaName, (container) =>
      runFixedOrderCancel(container, ids)
    );
    const mixValidation = await withSchema(scoped, schemaName, (container) =>
      runMixValidation(container, ids)
    );
    const concurrentLimit = await runConcurrentLimit(
      scoped,
      concurrentA,
      concurrentB,
      schemaName,
      ids,
    );
    const forcedFailureRollback = await withSchema(scoped, schemaName, (container) =>
      runForcedRollback(container, ids, schemaName)
    );
    const partialFullRefund = await withSchema(scoped, schemaName, (container) =>
      runPartialFullRefund(container, ids)
    );
    const nonRefundable = await withSchema(scoped, schemaName, (container) =>
      runNonRefundable(container, ids)
    );
    report = {
      server_version: versionRows[0]?.server_version ?? "unknown",
      schema_created: true,
      fixed_order_cancel: fixedOrderCancel,
      mix_validation: mixValidation,
      concurrent_limit: concurrentLimit,
      forced_failure_rollback: forcedFailureRollback,
      partial_full_refund: partialFullRefund,
      non_refundable: nonRefundable,
    };
  } finally {
    try {
      if (created) {
        await root.$client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '3s'`;
          await tx`SET LOCAL statement_timeout = '20s'`;
          await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        });
      }
      const rows = await root.$client<{ schema_removed: boolean }[]>`
        SELECT to_regnamespace(${schemaName}) IS NULL AS schema_removed
      `;
      schemaRemoved = rows[0]?.schema_removed === true;
      after = await publicSnapshot(root);
    } finally {
      await Promise.all(clients.map((client) => client.end({ timeout: 1 })));
    }
  }
  assertCondition(report, "scenario did not produce a report");
  assertCondition(before && after, "public snapshots are missing");
  assertCondition(schemaRemoved, "temporary integration schema was not removed");
  const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(publicStateUnchanged, "public business rows or sequences changed");
  return { ...report, schema_removed: schemaRemoved, public_state_unchanged: publicStateUnchanged };
}
