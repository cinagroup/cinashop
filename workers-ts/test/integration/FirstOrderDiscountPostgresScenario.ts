import { count, eq, inArray, sql } from "drizzle-orm";
import {
  storeCart,
  storeCouponIssue,
  storeCouponUser,
  storeOrder,
  storeOrderCartInfo,
  storeProduct,
  storeProductAttrValue,
  systemStore,
  user,
} from "@/models/schema";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
  withTx,
} from "@/lib/di";
import {
  cancelStoreOrder,
  StoreOrderCreateService,
  type CreateOrderParams,
  type StoreOrderCreationRuntime,
} from "@/services/order/StoreOrderCreateService";
import { StoreCartService } from "@/services/order/StoreCartService";

const CLONED_TABLES = [
  "user",
  "system_store",
  "store_cart",
  "store_order",
  "store_order_cart_info",
  "store_order_status",
  "user_bill",
  "store_product",
  "store_product_attr_value",
  "store_coupon_issue",
  "store_coupon_user",
] as const;

const LOCAL_SEQUENCE_TABLES = [
  "store_order",
  "store_order_cart_info",
  "store_order_status",
] as const;

const CONFIG = {
  newcomer_status: "1",
  first_order_status: "1",
  first_order_discount: "90",
  first_order_discount_limit: "15",
  newcomer_limit_status: "1",
  newcomer_limit_time: "7",
} as const;

interface PublicSnapshot {
  users: number;
  carts: number;
  orders: number;
  cartInfos: number;
  statuses: number;
  products: number;
  skus: number;
  couponIssues: number;
  couponUsers: number;
  orderSequence: string | null;
  cartInfoSequence: string | null;
  statusSequence: string | null;
}

interface FixtureIds {
  storeId: number;
  users: [number, number, number, number, number];
  couponIssueId: number;
  couponUserId: number;
  capped: { productId: number; skuId: number; unique: string; carts: [number, number] };
  disqualified: { productId: number; skuId: number; unique: string; carts: [number, number] };
  concurrent: { productId: number; skuId: number; unique: string; carts: [number, number] };
  rollback: { productId: number; skuId: number; unique: string; cartId: number };
}

export interface FirstOrderDiscountPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  public_state_unchanged: boolean;
  capped_coupon_exclusion: {
    preview_first_order_price: string;
    preview_matches_created: boolean;
    first_order_price: string;
    coupon_price: string;
    coupon_id: number;
    pay_price: string;
    snapshot_first_order_price: string;
    snapshot_sum_true_price: string;
    qualification_consumed: boolean;
    coupon_untouched: boolean;
  };
  cancellation_non_restore: {
    qualification_still_consumed: boolean;
    next_first_order_price: string;
    next_coupon_price: string;
    next_pay_price: string;
    coupon_reserved: boolean;
  };
  paid_and_expired_disqualification: {
    paid_history_first_order_price: string;
    expired_first_order_price: string;
    both_full_price: boolean;
  };
  concurrent_single_winner: {
    successes: number;
    discounts: string[];
    exactly_one_discounted: boolean;
    qualification_consumed: boolean;
  };
  rollback_preserves_qualification: {
    business_rejected: boolean;
    qualification_available: boolean;
    cart_unclaimed: boolean;
    orders: number;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PostgreSQL first-order integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_first_order_it_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

function makeFixtureIds(base: number): FixtureIds {
  return {
    storeId: base + 100,
    users: [base + 1, base + 2, base + 3, base + 4, base + 5],
    couponIssueId: base + 200,
    couponUserId: base + 201,
    capped: {
      productId: base + 1_000,
      skuId: base + 2_000,
      unique: "itfo0001",
      carts: [base + 3_000, base + 3_001],
    },
    disqualified: {
      productId: base + 1_001,
      skuId: base + 2_001,
      unique: "itfo0002",
      carts: [base + 3_002, base + 3_003],
    },
    concurrent: {
      productId: base + 1_002,
      skuId: base + 2_002,
      unique: "itfo0003",
      carts: [base + 3_004, base + 3_005],
    },
    rollback: {
      productId: base + 1_003,
      skuId: base + 2_003,
      unique: "itfo0004",
      cartId: base + 3_006,
    },
  };
}

function createRuntime(): StoreOrderCreationRuntime {
  return {
    CONFIG_KV: {
      async get(key: string) {
        const name = key.startsWith("cfg_") ? key.slice(4) : key;
        return CONFIG[name as keyof typeof CONFIG] ?? "0";
      },
      async put() {},
      async delete() {},
    },
    async nextOrderId() {
      const random = new Uint32Array(2);
      crypto.getRandomValues(random);
      return `wxfo${Date.now().toString(36)}${random[0].toString(36)}${random[1].toString(36)}`.slice(0, 32);
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
    await tx.execute(sql`SET LOCAL statement_timeout = '20s'`);
    return fn(createContainerFromDb(tx));
  });
}

async function createOrder(
  db: DbClient,
  schemaName: string,
  params: CreateOrderParams,
): Promise<{ orderId: string; key: string }> {
  return withSchema(db, schemaName, (container) =>
    StoreOrderCreateService.createWithRuntime(container, createRuntime(), params)
  );
}

function params(
  ids: FixtureIds,
  uid: number,
  key: string,
  cartId: number,
  extra: Partial<CreateOrderParams> = {},
): CreateOrderParams {
  return {
    uid,
    key,
    cartIds: [cartId],
    realName: "first order integration",
    userPhone: "13000000000",
    shippingType: 2,
    storeId: ids.storeId,
    userIp: "127.0.0.1",
    ...extra,
  };
}

async function publicSnapshot(db: DbClient): Promise<PublicSnapshot> {
  const rows = await db.$client<PublicSnapshot[]>`
    SELECT
      (SELECT count(*)::integer FROM public."user") AS "users",
      (SELECT count(*)::integer FROM public.store_cart) AS "carts",
      (SELECT count(*)::integer FROM public.store_order) AS "orders",
      (SELECT count(*)::integer FROM public.store_order_cart_info) AS "cartInfos",
      (SELECT count(*)::integer FROM public.store_order_status) AS "statuses",
      (SELECT count(*)::integer FROM public.store_product) AS "products",
      (SELECT count(*)::integer FROM public.store_product_attr_value) AS "skus",
      (SELECT count(*)::integer FROM public.store_coupon_issue) AS "couponIssues",
      (SELECT count(*)::integer FROM public.store_coupon_user) AS "couponUsers",
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_id_seq') AS "orderSequence",
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_cart_info_id_seq') AS "cartInfoSequence",
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_status_id_seq') AS "statusSequence"
  `;
  assertCondition(rows[0], "unable to read public snapshot");
  return rows[0];
}

async function seedFixtures(db: DbClient, schemaName: string, ids: FixtureIds): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await withSchema(db, schemaName, async ({ db: tx }) => {
    await tx.insert(user).values(ids.users.map((uid, index) => ({
      uid,
      account: `first-order-${uid}`.slice(0, 32),
      nickname: `first order user ${index}`,
      addTime: index === 2 ? now - 10 * 86_400 : now,
      lastTime: now,
      isFirstOrder: 0,
      status: 1,
      isDel: 0,
    })));
    await tx.insert(systemStore).values({
      id: ids.storeId,
      name: "first-order integration store",
      isStore: 1,
      isShow: 1,
      isDel: 0,
    });
    await tx.insert(storeProduct).values([
      { id: ids.capped.productId, storeName: "capped", price: "100.00", stock: 10, isShow: 1, isDel: 0 },
      { id: ids.disqualified.productId, storeName: "disqualified", price: "100.00", stock: 5, isShow: 1, isDel: 0 },
      { id: ids.concurrent.productId, storeName: "concurrent", price: "100.00", stock: 4, isShow: 1, isDel: 0 },
      { id: ids.rollback.productId, storeName: "rollback", price: "100.00", stock: 0, isShow: 1, isDel: 0 },
    ]);
    await tx.insert(storeProductAttrValue).values([
      { id: ids.capped.skuId, productId: ids.capped.productId, unique: ids.capped.unique,
        suk: "capped", price: "100.00", cost: "40.00", stock: 10, type: 0 },
      { id: ids.disqualified.skuId, productId: ids.disqualified.productId, unique: ids.disqualified.unique,
        suk: "disqualified", price: "100.00", cost: "40.00", stock: 5, type: 0 },
      { id: ids.concurrent.skuId, productId: ids.concurrent.productId, unique: ids.concurrent.unique,
        suk: "concurrent", price: "100.00", cost: "40.00", stock: 4, type: 0 },
      { id: ids.rollback.skuId, productId: ids.rollback.productId, unique: ids.rollback.unique,
        suk: "rollback", price: "100.00", cost: "40.00", stock: 0, type: 0 },
    ]);
    await tx.insert(storeCart).values([
      { id: ids.capped.carts[0], uid: ids.users[0], productId: ids.capped.productId,
        productAttrUnique: ids.capped.unique, cartNum: 2, type: 0, status: 1, isPay: 0, isDel: 0 },
      { id: ids.capped.carts[1], uid: ids.users[0], productId: ids.capped.productId,
        productAttrUnique: ids.capped.unique, cartNum: 1, type: 0, status: 1, isPay: 0, isDel: 0 },
      { id: ids.disqualified.carts[0], uid: ids.users[1], productId: ids.disqualified.productId,
        productAttrUnique: ids.disqualified.unique, cartNum: 1, type: 0, status: 1, isPay: 0, isDel: 0 },
      { id: ids.disqualified.carts[1], uid: ids.users[2], productId: ids.disqualified.productId,
        productAttrUnique: ids.disqualified.unique, cartNum: 1, type: 0, status: 1, isPay: 0, isDel: 0 },
      { id: ids.concurrent.carts[0], uid: ids.users[3], productId: ids.concurrent.productId,
        productAttrUnique: ids.concurrent.unique, cartNum: 1, type: 0, status: 1, isPay: 0, isDel: 0 },
      { id: ids.concurrent.carts[1], uid: ids.users[3], productId: ids.concurrent.productId,
        productAttrUnique: ids.concurrent.unique, cartNum: 1, type: 0, status: 1, isPay: 0, isDel: 0 },
      { id: ids.rollback.cartId, uid: ids.users[4], productId: ids.rollback.productId,
        productAttrUnique: ids.rollback.unique, cartNum: 1, type: 0, status: 1, isPay: 0, isDel: 0 },
    ]);
    await tx.insert(storeCouponIssue).values({
      id: ids.couponIssueId,
      couponType: 0,
      type: 1,
      couponTitle: "first-order exclusion coupon",
      couponPrice: "5.00",
      useMinPrice: "0.00",
      status: 1,
      isDel: 0,
    });
    await tx.insert(storeCouponUser).values({
      id: ids.couponUserId,
      uid: ids.users[0],
      issueCouponId: ids.couponIssueId,
      couponTitle: "first-order exclusion coupon",
      couponPrice: "5.00",
      useMinPrice: "0.00",
      status: 0,
      isFail: 0,
    });
    await tx.insert(storeOrder).values({
      id: ids.storeId + 900,
      orderId: `wx-paid-history-${ids.users[1]}`.slice(0, 32),
      uid: ids.users[1],
      type: 0,
      paid: 1,
      payPrice: "100.00",
      totalPrice: "100.00",
      unique: `paid-history-${ids.users[1]}`,
      addTime: now - 100,
    });
  });
}

async function runCappedCouponAndCancellation(
  db: DbClient,
  schemaName: string,
  ids: FixtureIds,
) {
  const preview = await withSchema(db, schemaName, (container) =>
    new StoreCartService(container).quoteFirstOrder(
      ids.users[0],
      [ids.capped.carts[0]],
      createRuntime(),
    )
  );
  assertCondition(
    preview.eligible
    && preview.couponExclusive
    && preview.subtotal === "200.00"
    && preview.firstOrderPrice === "15.00",
    "server quote did not match capped PHP pricing",
  );
  const first = await createOrder(db, schemaName, params(
    ids,
    ids.users[0],
    `first-capped-${ids.storeId}`,
    ids.capped.carts[0],
    { couponId: ids.couponUserId },
  ));
  const firstState = await withSchema(db, schemaName, async (container) => {
    const orders = await container.db.select().from(storeOrder)
      .where(eq(storeOrder.orderId, first.orderId)).limit(1);
    const account = await container.db.select({ isFirstOrder: user.isFirstOrder }).from(user)
      .where(eq(user.uid, ids.users[0])).limit(1);
    const coupon = await container.db.select({ status: storeCouponUser.status }).from(storeCouponUser)
      .where(eq(storeCouponUser.id, ids.couponUserId)).limit(1);
    const snapshots = await container.db.select({ cartInfo: storeOrderCartInfo.cartInfo })
      .from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, orders[0]?.id ?? 0)).limit(1);
    assertCondition(orders[0] && account[0] && coupon[0] && snapshots[0], "capped order state missing");
    const snapshot = JSON.parse(snapshots[0].cartInfo ?? "{}") as Record<string, string>;
    assertCondition(
      orders[0].firstOrderPrice === "15.00"
      && orders[0].couponPrice === "0.00"
      && orders[0].couponId === 0
      && orders[0].payPrice === "185.00"
      && snapshot.first_order_price === "15.00"
      && snapshot.sum_true_price === "185.00"
      && account[0].isFirstOrder === 1
      && coupon[0].status === 0,
      "capped first-order pricing or coupon exclusion diverged",
    );
    return {
      preview_first_order_price: preview.firstOrderPrice,
      preview_matches_created: preview.firstOrderPrice === orders[0].firstOrderPrice,
      first_order_price: orders[0].firstOrderPrice,
      coupon_price: orders[0].couponPrice,
      coupon_id: orders[0].couponId,
      pay_price: orders[0].payPrice,
      snapshot_first_order_price: snapshot.first_order_price,
      snapshot_sum_true_price: snapshot.sum_true_price,
      qualification_consumed: account[0].isFirstOrder === 1,
      coupon_untouched: coupon[0].status === 0,
    };
  });

  await withSchema(db, schemaName, (container) =>
    cancelStoreOrder(container, { uid: ids.users[0], orderId: first.orderId })
  );
  const second = await createOrder(db, schemaName, params(
    ids,
    ids.users[0],
    `after-cancel-${ids.storeId}`,
    ids.capped.carts[1],
    { couponId: ids.couponUserId },
  ));
  const cancellationState = await withSchema(db, schemaName, async (container) => {
    const orders = await container.db.select().from(storeOrder)
      .where(eq(storeOrder.orderId, second.orderId)).limit(1);
    const account = await container.db.select({ isFirstOrder: user.isFirstOrder }).from(user)
      .where(eq(user.uid, ids.users[0])).limit(1);
    const coupon = await container.db.select({ status: storeCouponUser.status }).from(storeCouponUser)
      .where(eq(storeCouponUser.id, ids.couponUserId)).limit(1);
    assertCondition(orders[0] && account[0] && coupon[0], "post-cancellation state missing");
    assertCondition(
      account[0].isFirstOrder === 1
      && orders[0].firstOrderPrice === "0.00"
      && orders[0].couponPrice === "5.00"
      && orders[0].payPrice === "95.00"
      && coupon[0].status === 3,
      "cancellation restored qualification or coupon fallback failed",
    );
    return {
      qualification_still_consumed: account[0].isFirstOrder === 1,
      next_first_order_price: orders[0].firstOrderPrice,
      next_coupon_price: orders[0].couponPrice,
      next_pay_price: orders[0].payPrice,
      coupon_reserved: coupon[0].status === 3,
    };
  });
  return { firstState, cancellationState };
}

async function runDisqualification(db: DbClient, schemaName: string, ids: FixtureIds) {
  const [paidHistory, expired] = await Promise.all([
    createOrder(db, schemaName, params(
      ids, ids.users[1], `paid-disqualified-${ids.storeId}`, ids.disqualified.carts[0],
    )),
    createOrder(db, schemaName, params(
      ids, ids.users[2], `expired-disqualified-${ids.storeId}`, ids.disqualified.carts[1],
    )),
  ]);
  return withSchema(db, schemaName, async (container) => {
    const orders = await container.db.select({
      orderId: storeOrder.orderId,
      firstOrderPrice: storeOrder.firstOrderPrice,
      payPrice: storeOrder.payPrice,
    }).from(storeOrder).where(inArray(storeOrder.orderId, [paidHistory.orderId, expired.orderId]));
    const byId = new Map(orders.map((order) => [order.orderId, order]));
    const paidOrder = byId.get(paidHistory.orderId);
    const expiredOrder = byId.get(expired.orderId);
    const bothFullPrice = paidOrder?.firstOrderPrice === "0.00"
      && paidOrder.payPrice === "100.00"
      && expiredOrder?.firstOrderPrice === "0.00"
      && expiredOrder.payPrice === "100.00";
    assertCondition(bothFullPrice, "paid-history or expired user received first-order discount");
    return {
      paid_history_first_order_price: paidOrder?.firstOrderPrice ?? "missing",
      expired_first_order_price: expiredOrder?.firstOrderPrice ?? "missing",
      both_full_price: bothFullPrice,
    };
  });
}

async function runConcurrentSingleWinner(
  firstDb: DbClient,
  secondDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  ids: FixtureIds,
) {
  const keys = [`concurrent-first-a-${ids.storeId}`, `concurrent-first-b-${ids.storeId}`];
  const settled = await Promise.allSettled([
    createOrder(firstDb, schemaName, params(ids, ids.users[3], keys[0], ids.concurrent.carts[0])),
    createOrder(secondDb, schemaName, params(ids, ids.users[3], keys[1], ids.concurrent.carts[1])),
  ]);
  const successes = settled.filter((result) => result.status === "fulfilled").length;
  return withSchema(observerDb, schemaName, async (container) => {
    const orders = await container.db.select({ firstOrderPrice: storeOrder.firstOrderPrice })
      .from(storeOrder).where(inArray(storeOrder.unique, keys));
    const accounts = await container.db.select({ isFirstOrder: user.isFirstOrder }).from(user)
      .where(eq(user.uid, ids.users[3])).limit(1);
    const discounts = orders.map((order) => order.firstOrderPrice).sort();
    const exactlyOneDiscounted = successes === 2
      && discounts.length === 2
      && discounts[0] === "0.00"
      && discounts[1] === "10.00";
    assertCondition(exactlyOneDiscounted, "concurrent carts did not select exactly one discount winner");
    assertCondition(accounts[0]?.isFirstOrder === 1, "concurrent winner did not consume qualification");
    return {
      successes,
      discounts,
      exactly_one_discounted: exactlyOneDiscounted,
      qualification_consumed: accounts[0]?.isFirstOrder === 1,
    };
  });
}

async function runRollback(db: DbClient, schemaName: string, ids: FixtureIds) {
  const key = `rollback-first-${ids.storeId}`;
  let businessRejected = false;
  try {
    await createOrder(db, schemaName, params(ids, ids.users[4], key, ids.rollback.cartId));
  } catch (error) {
    businessRejected = error instanceof Error && error.message.includes("库存不足");
  }
  return withSchema(db, schemaName, async (container) => {
    const [accounts, carts, orderCount] = await Promise.all([
      container.db.select({ isFirstOrder: user.isFirstOrder }).from(user)
        .where(eq(user.uid, ids.users[4])).limit(1),
      container.db.select({ isPay: storeCart.isPay }).from(storeCart)
        .where(eq(storeCart.id, ids.rollback.cartId)).limit(1),
      container.db.select({ value: count() }).from(storeOrder).where(eq(storeOrder.unique, key)),
    ]);
    const qualificationAvailable = accounts[0]?.isFirstOrder === 0;
    const cartUnclaimed = carts[0]?.isPay === 0;
    assertCondition(
      businessRejected && qualificationAvailable && cartUnclaimed && orderCount[0]?.value === 0,
      "failed order left first-order, cart or order side effects",
    );
    return {
      business_rejected: businessRejected,
      qualification_available: qualificationAvailable,
      cart_unclaimed: cartUnclaimed,
      orders: orderCount[0]?.value ?? 0,
    };
  });
}

export async function runFirstOrderDiscountPostgresScenario(
  connectionString: string,
): Promise<FirstOrderDiscountPostgresReport> {
  const schemaName = makeSchemaName();
  const schemaIdentifier = identifier(schemaName);
  const adminDb = createDbFromConnectionString(connectionString, 1);
  const concurrentDbA = createDbFromConnectionString(connectionString, 1);
  const concurrentDbB = createDbFromConnectionString(connectionString, 1);
  const observerDb = createDbFromConnectionString(connectionString, 1);
  const clients = [adminDb.$client, concurrentDbA.$client, concurrentDbB.$client, observerDb.$client];
  let created = false;
  let before: PublicSnapshot | undefined;
  let after: PublicSnapshot | undefined;
  let schemaRemoved = false;
  let report: Omit<FirstOrderDiscountPostgresReport, "schema_removed" | "public_state_unchanged"> | undefined;

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
    const ids = makeFixtureIds(1_200_000_000 + (random[0] % 50_000_000));
    await seedFixtures(adminDb, schemaName, ids);
    const capped = await runCappedCouponAndCancellation(adminDb, schemaName, ids);
    const disqualified = await runDisqualification(adminDb, schemaName, ids);
    const concurrent = await runConcurrentSingleWinner(
      concurrentDbA, concurrentDbB, observerDb, schemaName, ids,
    );
    const rollback = await runRollback(adminDb, schemaName, ids);
    report = {
      server_version: versionRows[0]?.server_version ?? "unknown",
      schema_created: true,
      capped_coupon_exclusion: capped.firstState,
      cancellation_non_restore: capped.cancellationState,
      paid_and_expired_disqualification: disqualified,
      concurrent_single_winner: concurrent,
      rollback_preserves_qualification: rollback,
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
  assertCondition(schemaRemoved, "temporary schema was not removed");
  const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(publicStateUnchanged, "public business rows or sequences changed");
  return {
    ...report,
    schema_removed: schemaRemoved,
    public_state_unchanged: publicStateUnchanged,
  };
}
