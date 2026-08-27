import { count, eq, inArray, sql } from "drizzle-orm";
import {
  storeBargain,
  storeBargainUser,
  storeCart,
  storeCombination,
  storeIntegral,
  storeOrder,
  storeOrderCartInfo,
  storeOrderStatus,
  storeProduct,
  storeProductAttrValue,
  storeSeckill,
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
  "store_seckill",
  "store_bargain",
  "store_bargain_user",
  "store_combination",
  "store_pink",
  "store_integral",
] as const;

const LOCAL_SEQUENCE_TABLES = [
  "store_order",
  "store_order_cart_info",
  "store_order_status",
] as const;

interface PublicSnapshot {
  users: number;
  stores: number;
  carts: number;
  orders: number;
  cart_infos: number;
  statuses: number;
  products: number;
  skus: number;
  seckills: number;
  bargains: number;
  bargain_users: number;
  combinations: number;
  pinks: number;
  integrals: number;
  order_sequence: string | null;
  cart_info_sequence: string | null;
  status_sequence: string | null;
}

export interface StoreOrderCreatePostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  public_state_unchanged: boolean;
  same_cart_claim: {
    successes: number;
    rejections: number;
    business_rejected: boolean;
    orders: number;
    stock_decrements: number;
  };
  concurrent_idempotence: {
    successes: number;
    same_order_id: boolean;
    orders: number;
    claimed_carts: number;
    stock_decrements: number;
    overlap_delay_observed: boolean;
  };
  stock_oversell_guard: {
    successes: number;
    rejections: number;
    business_rejected: boolean;
    orders: number;
    claimed_carts: number;
    product_stock: number;
    sku_stock: number;
  };
  seckill_reservation_cancel: {
    successes: number;
    rejections: number;
    business_rejected: boolean;
    loser_cart_rolled_back: boolean;
    resources_restored: boolean;
    cancel_status_rows: number;
  };
  bargain_reservation_cancel: {
    bargain_user_restored: boolean;
    resources_restored: boolean;
    cancel_status_rows: number;
  };
  combination_reservation_cancel: {
    resources_restored: boolean;
    cancel_status_rows: number;
  };
  integral_reservation_cancel: {
    order_cash_price: string;
    order_integral: number;
    authoritative_snapshot: boolean;
    resources_restored: boolean;
    cancel_status_rows: number;
  };
}

interface FixtureIds {
  storeId: number;
  users: number[];
  sameCart: { productId: number; skuId: number; cartId: number; skuUnique: string };
  idempotent: { productId: number; skuId: number; cartIds: [number, number]; skuUnique: string };
  oversell: { productId: number; skuId: number; cartIds: [number, number]; skuUnique: string };
  seckill: {
    productId: number;
    skuId: number;
    cartIds: [number, number];
    skuUnique: string;
    activityId: number;
  };
  bargain: {
    productId: number;
    skuId: number;
    cartId: number;
    skuUnique: string;
    activityId: number;
    bargainUserId: number;
  };
  combination: {
    productId: number;
    skuId: number;
    cartId: number;
    skuUnique: string;
    activityId: number;
  };
  integral: {
    productId: number;
    skuId: number;
    activitySkuId: number;
    cartId: number;
    skuUnique: string;
    activitySkuUnique: string;
    activityId: number;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PostgreSQL create-order integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_create_order_it_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

function makeFixtureIds(base: number): FixtureIds {
  return {
    storeId: base + 100,
    users: [base + 1, base + 2, base + 3, base + 4, base + 5, base + 6, base + 7],
    sameCart: {
      productId: base + 1_000,
      skuId: base + 2_000,
      cartId: base + 3_000,
      skuUnique: "itcr0001",
    },
    idempotent: {
      productId: base + 1_001,
      skuId: base + 2_001,
      cartIds: [base + 3_001, base + 3_002],
      skuUnique: "itcr0002",
    },
    oversell: {
      productId: base + 1_002,
      skuId: base + 2_002,
      cartIds: [base + 3_003, base + 3_004],
      skuUnique: "itcr0003",
    },
    seckill: {
      productId: base + 1_003,
      skuId: base + 2_003,
      cartIds: [base + 3_005, base + 3_006],
      skuUnique: "itcr0004",
      activityId: base + 5_003,
    },
    bargain: {
      productId: base + 1_004,
      skuId: base + 2_004,
      cartId: base + 3_007,
      skuUnique: "itcr0005",
      activityId: base + 5_004,
      bargainUserId: base + 6_004,
    },
    combination: {
      productId: base + 1_005,
      skuId: base + 2_005,
      cartId: base + 3_008,
      skuUnique: "itcr0006",
      activityId: base + 5_005,
    },
    integral: {
      productId: base + 1_006,
      skuId: base + 2_006,
      activitySkuId: base + 2_007,
      cartId: base + 3_009,
      skuUnique: "itcr0007",
      activitySkuUnique: "itcr0407",
      activityId: base + 5_006,
    },
  };
}

function createRuntime(): StoreOrderCreationRuntime {
  return {
    CONFIG_KV: {
      async get() {
        // Disable optional brokerage/config branches without reading public system_config.
        return "0";
      },
      async put() {},
      async delete() {},
    },
    async nextOrderId() {
      const random = new Uint32Array(2);
      crypto.getRandomValues(random);
      return `wxit${Date.now().toString(36)}${random[0].toString(36)}${random[1].toString(36)}`.slice(0, 32);
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

function orderParams(
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
    realName: "PostgreSQL integration",
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
      (SELECT count(*)::integer FROM public."user") AS users,
      (SELECT count(*)::integer FROM public.system_store) AS stores,
      (SELECT count(*)::integer FROM public.store_cart) AS carts,
      (SELECT count(*)::integer FROM public.store_order) AS orders,
      (SELECT count(*)::integer FROM public.store_order_cart_info) AS cart_infos,
      (SELECT count(*)::integer FROM public.store_order_status) AS statuses,
      (SELECT count(*)::integer FROM public.store_product) AS products,
      (SELECT count(*)::integer FROM public.store_product_attr_value) AS skus,
      (SELECT count(*)::integer FROM public.store_seckill) AS seckills,
      (SELECT count(*)::integer FROM public.store_bargain) AS bargains,
      (SELECT count(*)::integer FROM public.store_bargain_user) AS bargain_users,
      (SELECT count(*)::integer FROM public.store_combination) AS combinations,
      (SELECT count(*)::integer FROM public.store_pink) AS pinks,
      (SELECT count(*)::integer FROM public.store_integral) AS integrals,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_id_seq') AS order_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_cart_info_id_seq') AS cart_info_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_status_id_seq') AS status_sequence
  `;
  const row = rows[0];
  if (!row) throw new Error("unable to read public PostgreSQL snapshot");
  return row;
}

async function seedFixtures(db: DbClient, schemaName: string, ids: FixtureIds): Promise<void> {
  await withSchema(db, schemaName, async ({ db: tx }) => {
    await tx.insert(user).values(ids.users.map((uid, index) => ({
      uid,
      account: `create-it-${uid}`.slice(0, 32),
      nickname: `create user ${index}`,
      status: 1,
      isDel: 0,
      integral: index === 6 ? 100 : 0,
    })));
    await tx.insert(systemStore).values({
      id: ids.storeId,
      name: "create-order integration store",
      isStore: 1,
      isShow: 1,
      isDel: 0,
    });

    const products = [
      [ids.sameCart.productId, 5, "same cart"],
      [ids.idempotent.productId, 4, "idempotent"],
      [ids.oversell.productId, 1, "oversell"],
      [ids.seckill.productId, 2, "seckill"],
      [ids.bargain.productId, 1, "bargain"],
      [ids.combination.productId, 1, "combination"],
      [ids.integral.productId, 2, "integral"],
    ] as const;
    await tx.insert(storeProduct).values(products.map(([id, stock, name]) => ({
      id,
      storeName: `create-order ${name}`,
      price: "10.00",
      stock,
      sales: 0,
      isShow: 1,
      isDel: 0,
      systemFormId: 0,
    })));
    const skus = [
      [ids.sameCart.skuId, ids.sameCart.productId, ids.sameCart.skuUnique, 5],
      [ids.idempotent.skuId, ids.idempotent.productId, ids.idempotent.skuUnique, 4],
      [ids.oversell.skuId, ids.oversell.productId, ids.oversell.skuUnique, 1],
      [ids.seckill.skuId, ids.seckill.productId, ids.seckill.skuUnique, 2],
      [ids.bargain.skuId, ids.bargain.productId, ids.bargain.skuUnique, 1],
      [ids.combination.skuId, ids.combination.productId, ids.combination.skuUnique, 1],
      [ids.integral.skuId, ids.integral.productId, ids.integral.skuUnique, 2],
    ] as const;
    await tx.insert(storeProductAttrValue).values(skus.map(([id, productId, unique, stock]) => ({
      id,
      productId,
      suk: `sku-${id}`,
      unique,
      price: "10.00",
      cost: "4.00",
      stock,
      sales: 0,
      type: 0,
    })));
    await tx.insert(storeProductAttrValue).values({
      id: ids.integral.activitySkuId,
      productId: ids.integral.activityId,
      productType: 0,
      suk: `sku-${ids.integral.skuId}`,
      unique: ids.integral.activitySkuUnique,
      price: "3.50",
      integral: 30,
      cost: "4.00",
      stock: 2,
      quota: 2,
      quotaShow: 2,
      sales: 0,
      type: 4,
    });

    await tx.insert(storeCart).values([
      { id: ids.sameCart.cartId, uid: ids.users[0], productId: ids.sameCart.productId,
        productAttrUnique: ids.sameCart.skuUnique, cartNum: 1, type: 0, status: 1, isPay: 0, isDel: 0 },
      { id: ids.idempotent.cartIds[0], uid: ids.users[0], productId: ids.idempotent.productId,
        productAttrUnique: ids.idempotent.skuUnique, cartNum: 1, type: 0, status: 1, isPay: 0, isDel: 0 },
      { id: ids.idempotent.cartIds[1], uid: ids.users[0], productId: ids.idempotent.productId,
        productAttrUnique: ids.idempotent.skuUnique, cartNum: 1, type: 0, status: 1, isPay: 0, isDel: 0 },
      { id: ids.oversell.cartIds[0], uid: ids.users[1], productId: ids.oversell.productId,
        productAttrUnique: ids.oversell.skuUnique, cartNum: 1, type: 0, status: 1, isPay: 0, isDel: 0 },
      { id: ids.oversell.cartIds[1], uid: ids.users[2], productId: ids.oversell.productId,
        productAttrUnique: ids.oversell.skuUnique, cartNum: 1, type: 0, status: 1, isPay: 0, isDel: 0 },
      { id: ids.seckill.cartIds[0], uid: ids.users[3], productId: ids.seckill.productId,
        productAttrUnique: ids.seckill.skuUnique, cartNum: 1, type: 1, activityId: ids.seckill.activityId,
        status: 1, isPay: 0, isDel: 0 },
      { id: ids.seckill.cartIds[1], uid: ids.users[4], productId: ids.seckill.productId,
        productAttrUnique: ids.seckill.skuUnique, cartNum: 1, type: 1, activityId: ids.seckill.activityId,
        status: 1, isPay: 0, isDel: 0 },
      { id: ids.bargain.cartId, uid: ids.users[0], productId: ids.bargain.productId,
        productAttrUnique: ids.bargain.skuUnique, cartNum: 1, type: 2, activityId: ids.bargain.activityId,
        status: 1, isPay: 0, isDel: 0 },
      { id: ids.combination.cartId, uid: ids.users[5], productId: ids.combination.productId,
        productAttrUnique: ids.combination.skuUnique, cartNum: 1, type: 3,
        activityId: ids.combination.activityId, status: 1, isPay: 0, isDel: 0 },
      { id: ids.integral.cartId, uid: ids.users[6], productId: ids.integral.productId,
        productAttrUnique: ids.integral.skuUnique, cartNum: 1, type: 4,
        activityId: ids.integral.activityId, status: 1, isPay: 0, isDel: 0 },
    ]);

    await tx.insert(storeSeckill).values({
      id: ids.seckill.activityId,
      productId: ids.seckill.productId,
      storeName: "create-order seckill",
      price: "6.00",
      num: 99,
      quota: 1,
      stock: 1,
      sales: 0,
      status: 1,
      isShow: 1,
      isDel: 0,
      systemFormId: 0,
    });
    await tx.insert(storeBargain).values({
      id: ids.bargain.activityId,
      productId: ids.bargain.productId,
      storeName: "create-order bargain",
      price: "10.00",
      minPrice: "5.00",
      quota: 1,
      stock: 1,
      sales: 0,
      status: 1,
      isDel: 0,
      systemFormId: 0,
    });
    await tx.insert(storeBargainUser).values({
      id: ids.bargain.bargainUserId,
      uid: ids.users[0],
      bargainId: ids.bargain.activityId,
      bargainPrice: "10.00",
      bargainPriceMin: "5.00",
      price: "5.00",
      status: 3,
      isDel: 0,
    });
    await tx.insert(storeCombination).values({
      id: ids.combination.activityId,
      productId: ids.combination.productId,
      storeName: "create-order combination",
      price: "6.00",
      people: 2,
      quota: 1,
      stock: 1,
      sales: 0,
      status: 1,
      isShow: 1,
      isDel: 0,
      systemFormId: 0,
    });
    await tx.insert(storeIntegral).values({
      id: ids.integral.activityId,
      productId: ids.integral.productId,
      storeName: "create-order integral",
      price: "3.50",
      integral: 30,
      quota: 2,
      quotaShow: 2,
      stock: 2,
      sales: 0,
      num: 2,
      onceNum: 1,
      freight: 1,
      status: 1,
      isShow: 1,
      isDel: 0,
      systemFormId: 0,
    });
  });
}

async function productState(container: Container, productId: number, skuId: number) {
  const [products, skus] = await Promise.all([
    container.db.select({ stock: storeProduct.stock, sales: storeProduct.sales })
      .from(storeProduct).where(eq(storeProduct.id, productId)).limit(1),
    container.db.select({ stock: storeProductAttrValue.stock, sales: storeProductAttrValue.sales })
      .from(storeProductAttrValue).where(eq(storeProductAttrValue.id, skuId)).limit(1),
  ]);
  assertCondition(products[0] && skus[0], "fixture product or SKU disappeared");
  return { product: products[0], sku: skus[0] };
}

function rejectionMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function runSameCartClaim(
  firstDb: DbClient,
  secondDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  ids: FixtureIds,
) {
  const keys = [`same-cart-a-${ids.storeId}`, `same-cart-b-${ids.storeId}`];
  const settled = await Promise.allSettled([
    createOrder(firstDb, schemaName, orderParams(ids, ids.users[0], keys[0], ids.sameCart.cartId)),
    createOrder(secondDb, schemaName, orderParams(ids, ids.users[0], keys[1], ids.sameCart.cartId)),
  ]);
  const successes = settled.filter((result) => result.status === "fulfilled").length;
  const rejected = settled.filter((result) => result.status === "rejected");
  const businessRejected = rejected.every((result) =>
    rejectionMessage(result.reason).includes("购物车商品")
  );
  return withSchema(observerDb, schemaName, async (container) => {
    const [orders, state] = await Promise.all([
      container.db.select({ value: count() }).from(storeOrder).where(inArray(storeOrder.unique, keys)),
      productState(container, ids.sameCart.productId, ids.sameCart.skuId),
    ]);
    assertCondition(successes === 1 && rejected.length === 1, "same cart was not claimed exactly once");
    assertCondition(businessRejected, "same-cart loser was not rejected as a business conflict");
    assertCondition(orders[0]?.value === 1, "same cart created duplicate orders");
    assertCondition(state.product.stock === 4 && state.sku.stock === 4, "same cart decremented stock more than once");
    return {
      successes,
      rejections: rejected.length,
      business_rejected: businessRejected,
      orders: orders[0]?.value ?? 0,
      stock_decrements: 5 - state.product.stock,
    };
  });
}

async function runConcurrentIdempotence(
  adminDb: DbClient,
  firstDb: DbClient,
  secondDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  ids: FixtureIds,
) {
  const schema = identifier(schemaName);
  const key = `idempotent-${ids.storeId}`;
  const functionName = identifier("delay_idempotent_insert_it");
  const triggerName = identifier("delay_idempotent_insert_it");
  await withSchema(adminDb, schemaName, async ({ db }) => {
    await db.execute(sql.raw(`
      CREATE FUNCTION ${schema}.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."unique" = '${key}' THEN
          PERFORM pg_sleep(0.5);
        END IF;
        RETURN NEW;
      END;
      $$
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON ${schema}.${identifier("store_order")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}.${functionName}()
    `));
  });
  const started = Date.now();
  const settled = await Promise.allSettled([
    createOrder(firstDb, schemaName, orderParams(ids, ids.users[0], key, ids.idempotent.cartIds[0])),
    createOrder(secondDb, schemaName, orderParams(ids, ids.users[0], key, ids.idempotent.cartIds[1])),
  ]);
  const elapsed = Date.now() - started;
  await withSchema(adminDb, schemaName, async ({ db }) => {
    await db.execute(sql.raw(`DROP TRIGGER ${triggerName} ON ${schema}.${identifier("store_order")}`));
    await db.execute(sql.raw(`DROP FUNCTION ${schema}.${functionName}()`));
  });
  const fulfilled = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  return withSchema(observerDb, schemaName, async (container) => {
    const [orders, carts, state] = await Promise.all([
      container.db.select({ value: count() }).from(storeOrder).where(eq(storeOrder.unique, key)),
      container.db.select({ isPay: storeCart.isPay }).from(storeCart)
        .where(inArray(storeCart.id, ids.idempotent.cartIds)),
      productState(container, ids.idempotent.productId, ids.idempotent.skuId),
    ]);
    const sameOrderId = fulfilled.length === 2 && fulfilled[0].orderId === fulfilled[1].orderId;
    const claimedCarts = carts.filter((cart) => cart.isPay === 1).length;
    assertCondition(fulfilled.length === 2 && sameOrderId, "same key did not return the same order twice");
    assertCondition(orders[0]?.value === 1, "same key inserted duplicate orders");
    assertCondition(claimedCarts === 1, "same key claimed more than the winning cart");
    assertCondition(state.product.stock === 3 && state.sku.stock === 3, "same key decremented stock more than once");
    assertCondition(elapsed >= 450, "idempotence overlap trigger did not run");
    return {
      successes: fulfilled.length,
      same_order_id: sameOrderId,
      orders: orders[0]?.value ?? 0,
      claimed_carts: claimedCarts,
      stock_decrements: 4 - state.product.stock,
      overlap_delay_observed: elapsed >= 450,
    };
  });
}

async function runStockOversellGuard(
  firstDb: DbClient,
  secondDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  ids: FixtureIds,
) {
  const keys = [`oversell-a-${ids.storeId}`, `oversell-b-${ids.storeId}`];
  const settled = await Promise.allSettled([
    createOrder(firstDb, schemaName, orderParams(ids, ids.users[1], keys[0], ids.oversell.cartIds[0])),
    createOrder(secondDb, schemaName, orderParams(ids, ids.users[2], keys[1], ids.oversell.cartIds[1])),
  ]);
  const successes = settled.filter((result) => result.status === "fulfilled").length;
  const rejected = settled.filter((result) => result.status === "rejected");
  const businessRejected = rejected.every((result) => rejectionMessage(result.reason).includes("库存不足"));
  return withSchema(observerDb, schemaName, async (container) => {
    const [orders, carts, state] = await Promise.all([
      container.db.select({ value: count() }).from(storeOrder).where(inArray(storeOrder.unique, keys)),
      container.db.select({ isPay: storeCart.isPay }).from(storeCart)
        .where(inArray(storeCart.id, ids.oversell.cartIds)),
      productState(container, ids.oversell.productId, ids.oversell.skuId),
    ]);
    const claimedCarts = carts.filter((cart) => cart.isPay === 1).length;
    assertCondition(successes === 1 && rejected.length === 1, "stock guard did not choose one winner");
    assertCondition(businessRejected, "oversell loser was not rejected as insufficient stock");
    assertCondition(orders[0]?.value === 1 && claimedCarts === 1, "oversell rollback left order/cart side effects");
    assertCondition(state.product.stock === 0 && state.sku.stock === 0, "oversell guard produced negative or inconsistent stock");
    return {
      successes,
      rejections: rejected.length,
      business_rejected: businessRejected,
      orders: orders[0]?.value ?? 0,
      claimed_carts: claimedCarts,
      product_stock: state.product.stock,
      sku_stock: state.sku.stock,
    };
  });
}

async function runSeckillReservationCancel(
  firstDb: DbClient,
  secondDb: DbClient,
  adminDb: DbClient,
  schemaName: string,
  ids: FixtureIds,
) {
  const attempts = [
    { uid: ids.users[3], cartId: ids.seckill.cartIds[0], key: `seckill-a-${ids.storeId}` },
    { uid: ids.users[4], cartId: ids.seckill.cartIds[1], key: `seckill-b-${ids.storeId}` },
  ];
  const settled = await Promise.allSettled(attempts.map((attempt, index) =>
    createOrder(index === 0 ? firstDb : secondDb, schemaName, orderParams(
      ids,
      attempt.uid,
      attempt.key,
      attempt.cartId,
      { type: 1, seckillId: ids.seckill.activityId },
    ))
  ));
  const winnerIndex = settled.findIndex((result) => result.status === "fulfilled");
  const rejected = settled.filter((result) => result.status === "rejected");
  assertCondition(winnerIndex >= 0 && rejected.length === 1, "seckill reservation did not choose one winner");
  const winner = settled[winnerIndex];
  assertCondition(winner.status === "fulfilled", "seckill winner result missing");
  const businessRejected = rejected.every((result) => rejectionMessage(result.reason).includes("秒杀库存不足"));
  const loserCartId = attempts[winnerIndex === 0 ? 1 : 0].cartId;
  await withSchema(adminDb, schemaName, (container) =>
    cancelStoreOrder(container, { uid: attempts[winnerIndex].uid, orderId: winner.value.orderId })
  );
  return withSchema(adminDb, schemaName, async (container) => {
    const [activities, loserCarts, state, orders] = await Promise.all([
      container.db.select({ quota: storeSeckill.quota, stock: storeSeckill.stock, sales: storeSeckill.sales })
        .from(storeSeckill).where(eq(storeSeckill.id, ids.seckill.activityId)).limit(1),
      container.db.select({ isPay: storeCart.isPay }).from(storeCart).where(eq(storeCart.id, loserCartId)).limit(1),
      productState(container, ids.seckill.productId, ids.seckill.skuId),
      container.db.select({ id: storeOrder.id }).from(storeOrder).where(eq(storeOrder.orderId, winner.value.orderId)).limit(1),
    ]);
    assertCondition(activities[0] && orders[0], "seckill state disappeared");
    const statusRows = await container.db.select({ value: count() }).from(storeOrderStatus)
      .where(eq(storeOrderStatus.oid, orders[0].id));
    const restored = activities[0].quota === 1 && activities[0].stock === 1 && activities[0].sales === 0
      && state.product.stock === 2 && state.product.sales === 0
      && state.sku.stock === 2 && state.sku.sales === 0;
    assertCondition(businessRejected, "seckill loser was not rejected by the activity guard");
    assertCondition(loserCarts[0]?.isPay === 0, "seckill loser cart claim was not rolled back");
    assertCondition(restored, "seckill cancellation did not restore all stock");
    assertCondition(statusRows[0]?.value === 1, "seckill cancellation status evidence missing");
    return {
      successes: 1,
      rejections: rejected.length,
      business_rejected: businessRejected,
      loser_cart_rolled_back: loserCarts[0]?.isPay === 0,
      resources_restored: restored,
      cancel_status_rows: statusRows[0]?.value ?? 0,
    };
  });
}

async function runBargainReservationCancel(
  db: DbClient,
  schemaName: string,
  ids: FixtureIds,
) {
  const result = await createOrder(db, schemaName, orderParams(
    ids,
    ids.users[0],
    `bargain-${ids.storeId}`,
    ids.bargain.cartId,
    { type: 2, bargainUserId: ids.bargain.bargainUserId },
  ));
  await withSchema(db, schemaName, (container) =>
    cancelStoreOrder(container, { uid: ids.users[0], orderId: result.orderId })
  );
  return withSchema(db, schemaName, async (container) => {
    const [activities, participants, state, orders] = await Promise.all([
      container.db.select({ quota: storeBargain.quota, stock: storeBargain.stock, sales: storeBargain.sales })
        .from(storeBargain).where(eq(storeBargain.id, ids.bargain.activityId)).limit(1),
      container.db.select({ status: storeBargainUser.status }).from(storeBargainUser)
        .where(eq(storeBargainUser.id, ids.bargain.bargainUserId)).limit(1),
      productState(container, ids.bargain.productId, ids.bargain.skuId),
      container.db.select({ id: storeOrder.id }).from(storeOrder).where(eq(storeOrder.orderId, result.orderId)).limit(1),
    ]);
    assertCondition(activities[0] && participants[0] && orders[0], "bargain state disappeared");
    const statusRows = await container.db.select({ value: count() }).from(storeOrderStatus)
      .where(eq(storeOrderStatus.oid, orders[0].id));
    const restored = activities[0].quota === 1 && activities[0].stock === 1 && activities[0].sales === 0
      && state.product.stock === 1 && state.product.sales === 0
      && state.sku.stock === 1 && state.sku.sales === 0;
    assertCondition(participants[0].status === 3, "bargain participant was not restored to purchasable state");
    assertCondition(restored, "bargain cancellation did not restore all stock");
    assertCondition(statusRows[0]?.value === 1, "bargain cancellation status evidence missing");
    return {
      bargain_user_restored: participants[0].status === 3,
      resources_restored: restored,
      cancel_status_rows: statusRows[0]?.value ?? 0,
    };
  });
}

async function runCombinationReservationCancel(
  db: DbClient,
  schemaName: string,
  ids: FixtureIds,
) {
  const result = await createOrder(db, schemaName, orderParams(
    ids,
    ids.users[5],
    `combination-${ids.storeId}`,
    ids.combination.cartId,
    { type: 3, combinationId: ids.combination.activityId, pinkId: 0 },
  ));
  await withSchema(db, schemaName, (container) =>
    cancelStoreOrder(container, { uid: ids.users[5], orderId: result.orderId })
  );
  return withSchema(db, schemaName, async (container) => {
    const [activities, state, orders] = await Promise.all([
      container.db.select({ quota: storeCombination.quota, stock: storeCombination.stock, sales: storeCombination.sales })
        .from(storeCombination).where(eq(storeCombination.id, ids.combination.activityId)).limit(1),
      productState(container, ids.combination.productId, ids.combination.skuId),
      container.db.select({ id: storeOrder.id }).from(storeOrder).where(eq(storeOrder.orderId, result.orderId)).limit(1),
    ]);
    assertCondition(activities[0] && orders[0], "combination state disappeared");
    const statusRows = await container.db.select({ value: count() }).from(storeOrderStatus)
      .where(eq(storeOrderStatus.oid, orders[0].id));
    const restored = activities[0].quota === 1 && activities[0].stock === 1 && activities[0].sales === 0
      && state.product.stock === 1 && state.product.sales === 0
      && state.sku.stock === 1 && state.sku.sales === 0;
    assertCondition(restored, "combination cancellation did not restore all stock");
    assertCondition(statusRows[0]?.value === 1, "combination cancellation status evidence missing");
    return {
      resources_restored: restored,
      cancel_status_rows: statusRows[0]?.value ?? 0,
    };
  });
}

async function runIntegralReservationCancel(
  db: DbClient,
  schemaName: string,
  ids: FixtureIds,
) {
  const result = await createOrder(db, schemaName, orderParams(
    ids,
    ids.users[6],
    `integral-${ids.storeId}`,
    ids.integral.cartId,
    { type: 4 },
  ));
  const beforeCancel = await withSchema(db, schemaName, async (container) => {
    const [orders, activities, activitySkus, state] = await Promise.all([
      container.db.select().from(storeOrder).where(eq(storeOrder.orderId, result.orderId)).limit(1),
      container.db.select().from(storeIntegral).where(eq(storeIntegral.id, ids.integral.activityId)).limit(1),
      container.db.select().from(storeProductAttrValue)
        .where(eq(storeProductAttrValue.id, ids.integral.activitySkuId)).limit(1),
      productState(container, ids.integral.productId, ids.integral.skuId),
    ]);
    const order = orders[0];
    assertCondition(order && activities[0] && activitySkus[0], "integral order state disappeared");
    const cartRows = await container.db.select().from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, order.id)).limit(1);
    const snapshot = JSON.parse(cartRows[0]?.cartInfo ?? "{}") as {
      product?: { activityId?: number };
      activitySku?: { id?: number; integral?: number };
    };
    const authoritativeSnapshot = snapshot.product?.activityId === ids.integral.activityId
      && snapshot.activitySku?.id === ids.integral.activitySkuId
      && snapshot.activitySku?.integral === 30;
    assertCondition(
      order.type === 4
      && order.activityId === ids.integral.activityId
      && order.payPrice === "3.50"
      && order.payIntegral === 30
      && activities[0].stock === 1
      && activities[0].quota === 1
      && activitySkus[0].stock === 1
      && activitySkus[0].quota === 1
      && state.product.stock === 1
      && state.sku.stock === 1
      && authoritativeSnapshot,
      "integral order did not reserve authoritative price, points and inventory",
    );
    return { order, authoritativeSnapshot };
  });

  await withSchema(db, schemaName, (container) =>
    cancelStoreOrder(container, { uid: ids.users[6], orderId: result.orderId })
  );
  return withSchema(db, schemaName, async (container) => {
    const [activities, activitySkus, state, statusRows] = await Promise.all([
      container.db.select().from(storeIntegral).where(eq(storeIntegral.id, ids.integral.activityId)).limit(1),
      container.db.select().from(storeProductAttrValue)
        .where(eq(storeProductAttrValue.id, ids.integral.activitySkuId)).limit(1),
      productState(container, ids.integral.productId, ids.integral.skuId),
      container.db.select({ value: count() }).from(storeOrderStatus)
        .where(eq(storeOrderStatus.oid, beforeCancel.order.id)),
    ]);
    assertCondition(activities[0] && activitySkus[0], "integral inventory disappeared after cancellation");
    const resourcesRestored = activities[0].stock === 2
      && activities[0].quota === 2
      && activities[0].sales === 0
      && activitySkus[0].stock === 2
      && activitySkus[0].quota === 2
      && activitySkus[0].sales === 0
      && state.product.stock === 2
      && state.product.sales === 0
      && state.sku.stock === 2
      && state.sku.sales === 0;
    assertCondition(resourcesRestored, "integral cancellation did not restore all three inventory layers");
    assertCondition(statusRows[0]?.value === 1, "integral cancellation status evidence missing");
    return {
      order_cash_price: beforeCancel.order.payPrice,
      order_integral: beforeCancel.order.payIntegral,
      authoritative_snapshot: beforeCancel.authoritativeSnapshot,
      resources_restored: resourcesRestored,
      cancel_status_rows: statusRows[0]?.value ?? 0,
    };
  });
}

export async function runStoreOrderCreatePostgresScenario(
  connectionString: string,
): Promise<StoreOrderCreatePostgresReport> {
  const schemaName = makeSchemaName();
  const schemaIdentifier = identifier(schemaName);
  const adminDb = createDbFromConnectionString(connectionString, 1);
  const concurrentDbA = createDbFromConnectionString(connectionString, 1);
  const concurrentDbB = createDbFromConnectionString(connectionString, 1);
  const observerDb = createDbFromConnectionString(connectionString, 1);
  const clients = [adminDb.$client, concurrentDbA.$client, concurrentDbB.$client, observerDb.$client];
  let created = false;
  let report: Omit<StoreOrderCreatePostgresReport, "schema_removed" | "public_state_unchanged"> | undefined;
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
    const ids = makeFixtureIds(1_300_000_000 + (random[0] % 30_000_000));
    await seedFixtures(adminDb, schemaName, ids);
    const sameCartClaim = await runSameCartClaim(
      concurrentDbA, concurrentDbB, observerDb, schemaName, ids,
    );
    const concurrentIdempotence = await runConcurrentIdempotence(
      adminDb, concurrentDbA, concurrentDbB, observerDb, schemaName, ids,
    );
    const stockOversellGuard = await runStockOversellGuard(
      concurrentDbA, concurrentDbB, observerDb, schemaName, ids,
    );
    const seckillReservationCancel = await runSeckillReservationCancel(
      concurrentDbA, concurrentDbB, adminDb, schemaName, ids,
    );
    const bargainReservationCancel = await runBargainReservationCancel(adminDb, schemaName, ids);
    const combinationReservationCancel = await runCombinationReservationCancel(adminDb, schemaName, ids);
    const integralReservationCancel = await runIntegralReservationCancel(adminDb, schemaName, ids);
    report = {
      server_version: versionRows[0]?.server_version ?? "unknown",
      schema_created: true,
      same_cart_claim: sameCartClaim,
      concurrent_idempotence: concurrentIdempotence,
      stock_oversell_guard: stockOversellGuard,
      seckill_reservation_cancel: seckillReservationCancel,
      bargain_reservation_cancel: bargainReservationCancel,
      combination_reservation_cancel: combinationReservationCancel,
      integral_reservation_cancel: integralReservationCancel,
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
