import { eq, sql } from "drizzle-orm";
import type { Env } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
  type DbClient,
} from "@/lib/di";
import {
  deliveryService,
  outAccount,
  outInterface,
  storeOrder,
  storeOrderCartInfo,
  storeOrderRefund,
  storeOrderStatus,
  storePink,
  user,
} from "@/models/schema";
import { OutApiService, type AuthenticatedOutAccount } from "@/services/out/OutApiService";
import { AuthException } from "@/utils/errors";

const CLONED_TABLES = [
  "delivery_service",
  "out_account",
  "out_interface",
  "store_order",
  "store_order_cart_info",
  "store_order_refund",
  "store_order_status",
  "store_pink",
  "user",
] as const;

const PUBLIC_SEQUENCE_NAMES: Record<(typeof CLONED_TABLES)[number], string> = {
  delivery_service: "delivery_service_id_seq",
  out_account: "out_account_id_seq",
  out_interface: "out_interface_id_seq",
  store_order: "store_order_id_seq",
  store_order_cart_info: "store_order_cart_info_id_seq",
  store_order_refund: "store_order_refund_id_seq",
  store_order_status: "store_order_status_id_seq",
  store_pink: "store_pink_id_seq",
  user: "user_uid_seq",
};

const PRIMARY_KEY_COLUMNS: Record<(typeof CLONED_TABLES)[number], string> = {
  delivery_service: "id",
  out_account: "id",
  out_interface: "id",
  store_order: "id",
  store_order_cart_info: "id",
  store_order_refund: "id",
  store_order_status: "id",
  store_pink: "id",
  user: "uid",
};

interface Fingerprint {
  tables: Record<string, { count: string; max_id: string | null; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface OutApiFulfillmentPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  acl: { writes_allowed: number; missing_permission_rejected: boolean };
  delivery: {
    first_changed: boolean;
    replay_idempotent: boolean;
    concurrent_single_write: boolean;
    different_payload_rejected: boolean;
    platform_scope_enforced: boolean;
    supplier_order_supported: boolean;
    business_guards_enforced: boolean;
    forced_express_contract: boolean;
    replay_evidence_rows: number;
    replay_evidence_redacted: boolean;
    rollback_preserved: boolean;
  };
  split_delivery: {
    first_split_created: boolean;
    replay_same_result: boolean;
    replay_after_completion: boolean;
    concurrent_single_split: boolean;
    amount_conserved: boolean;
    quantity_conserved: boolean;
    final_batch_completed: boolean;
    refund_guard_enforced: boolean;
    replay_evidence_rows: number;
    replay_evidence_redacted: boolean;
    rollback_preserved: boolean;
  };
  distribution: {
    first_changed: boolean;
    replay_idempotent: boolean;
    newer_change_applied: boolean;
    delayed_replay_preserved_newer_value: boolean;
    concurrent_single_write: boolean;
    platform_scope_enforced: boolean;
    unshipped_rejected: boolean;
    assigned_courier_authoritative: boolean;
    spoofed_courier_rejected: boolean;
    replay_evidence_rows: number;
    evidence_redacted: boolean;
    rollback_preserved: boolean;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Out API fulfillment integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_out_fulfillment_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function fingerprint(db: DbClient): Promise<Fingerprint> {
  const tables: Fingerprint["tables"] = {};
  for (const table of CLONED_TABLES) {
    const primaryKey = identifier(PRIMARY_KEY_COLUMNS[table]);
    const rows = await db.$client.unsafe<Array<{ count: string; max_id: string | null; digest: string }>>(
      `SELECT count(*)::text AS count,
        max(t.${primaryKey})::text AS max_id,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.${primaryKey}), '')) AS digest
       FROM public.${identifier(table)} t`,
    );
    assertCondition(rows[0], `could not fingerprint public.${table}`);
    tables[table] = rows[0];
  }
  const names = CLONED_TABLES.map((table) => PUBLIC_SEQUENCE_NAMES[table]);
  const rows = await db.$client<{ sequencename: string; last_value: string | null }[]>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = ANY(${names})
    ORDER BY sequencename
  `;
  const values = new Map(rows.map((row) => [row.sequencename, row.last_value]));
  return { tables, sequences: Object.fromEntries(names.map((name) => [name, values.get(name) ?? null])) };
}

async function setupSchema(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of CLONED_TABLES) {
      const tableName = identifier(table);
      const sequence = `${table}_id_seq_it`;
      const primaryKey = identifier(PRIMARY_KEY_COLUMNS[table]);
      await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${identifier(sequence)}`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${tableName} ALTER COLUMN ${primaryKey} SET DEFAULT nextval('${schemaName}.${sequence}'::regclass)`,
      );
    }
  });
}

async function withSchema<T>(
  db: DbClient,
  schemaName: string,
  callback: (container: Container) => Promise<T>,
): Promise<T> {
  return withTx(createContainerFromDb(db), async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schemaName)}`));
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    return callback(createContainerFromDb(tx));
  });
}

function account(): AuthenticatedOutAccount {
  return { id: 1, appid: "out-fulfillment-audit", title: "Out fulfillment audit", rules: [1, 2, 3] };
}

function orderBase(now: number) {
  return {
    uid: 701,
    realName: "隔离发货用户",
    userPhone: "13000000009",
    totalNum: 1,
    totalPrice: "10.00",
    payPrice: "10.00",
    paid: 1,
    status: 0,
    shippingType: 1,
    deliveryType: "",
    refundStatus: 0,
    addTime: now,
    storeId: 0,
    supplierId: 0,
    isDel: 0,
    isSystemDel: 0,
  } as const;
}

async function seed(container: Container): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await container.db.insert(outInterface).values([
    { id: 1, pid: 0, type: 1, name: "订单发货", method: "PUT", url: "/outapi/order/delivery/<order_id>", isDel: 0 },
    { id: 2, pid: 0, type: 1, name: "拆单发货", method: "PUT", url: "/order/split_delivery/:order_id", isDel: 0 },
    { id: 3, pid: 0, type: 1, name: "修改配送", method: "PUT", url: "/order/distribution/:order_id", isDel: 0 },
    { id: 4, pid: 0, type: 1, name: "修改发票", method: "PUT", url: "/order/invoice/:order_id", isDel: 0 },
  ]);
  await container.db.insert(outAccount).values({
    id: 1,
    appid: "out-fulfillment-audit",
    appsecret: "$2b$12$aoFQ1UDRKVgYmPxVsvZp1eGrp07dDT0KroIStvxFZyrf1b1EIylqS",
    title: "Out fulfillment audit",
    status: 1,
    rules: "[1,2,3]",
    isDel: 0,
  });
  const base = orderBase(now);
  const dispatched = {
    ...base,
    status: 1,
    deliveryType: "express",
    deliveryName: "原快递",
    deliveryCode: "OLD",
    deliveryId: "OLD-TRACKING",
  } as const;
  await container.db.insert(storeOrder).values([
    { ...base, id: 1001, orderId: "audit-delivery-first", unique: "out-delivery-first" },
    { ...base, id: 1002, orderId: "audit-delivery-race", unique: "out-delivery-race" },
    { ...base, id: 1003, orderId: "audit-delivery-store", unique: "out-delivery-store", storeId: 9 },
    { ...base, id: 1004, orderId: "audit-delivery-pickup", unique: "out-delivery-pickup", shippingType: 2 },
    { ...base, id: 1005, orderId: "audit-delivery-refund", unique: "out-delivery-refund" },
    { ...base, id: 1006, orderId: "audit-delivery-rollback", unique: "out-delivery-rollback" },
    { ...base, id: 1007, orderId: "audit-delivery-pink", unique: "out-delivery-pink", type: 3, pinkId: 2001 },
    { ...base, id: 1008, orderId: "audit-delivery-supplier", unique: "out-delivery-supplier", supplierId: 9 },
    { ...base, id: 1009, orderId: "audit-delivery-unpaid", unique: "out-delivery-unpaid", paid: 0 },
    { ...base, id: 1101, orderId: "audit-split-first", unique: "out-split-first", totalNum: 3, totalPrice: "30.00", payPrice: "30.00" },
    { ...base, id: 1102, orderId: "audit-split-race", unique: "out-split-race", totalNum: 3, totalPrice: "30.00", payPrice: "30.00" },
    { ...base, id: 1103, orderId: "audit-split-refund", unique: "out-split-refund", totalNum: 3, totalPrice: "30.00", payPrice: "30.00" },
    { ...base, id: 1104, orderId: "audit-split-rollback", unique: "out-split-rollback", totalNum: 3, totalPrice: "30.00", payPrice: "30.00" },
    { ...dispatched, id: 1201, orderId: "audit-distribution-first", unique: "out-distribution-first" },
    { ...dispatched, id: 1202, orderId: "audit-distribution-race", unique: "out-distribution-race" },
    { ...dispatched, id: 1203, orderId: "audit-distribution-store", unique: "out-distribution-store", storeId: 9 },
    { ...base, id: 1204, orderId: "audit-distribution-unshipped", unique: "out-distribution-unshipped" },
    { ...dispatched, id: 1205, orderId: "audit-distribution-rollback", unique: "out-distribution-rollback" },
    {
      ...dispatched,
      id: 1206,
      orderId: "audit-distribution-send",
      unique: "out-distribution-send",
      deliveryType: "send",
      deliveryName: "平台骑手",
      deliveryCode: "",
      deliveryId: "13800000008",
      deliveryUid: 801,
      verifyCode: "123456789012",
    },
  ]);
  await container.db.insert(user).values({
    uid: 801,
    account: "out-distribution-courier",
    nickname: "平台骑手",
    phone: "13800000008",
    status: 1,
    isDel: 0,
  });
  await container.db.insert(deliveryService).values({
    id: 5001,
    uid: 801,
    type: 0,
    relationId: 0,
    nickname: "平台骑手",
    phone: "13800000008",
    status: 1,
    isDel: 0,
    addTime: now,
  });
  await container.db.insert(storePink).values({
    id: 2001,
    uid: 701,
    orderId: "audit-delivery-pink",
    orderIdKey: "out-delivery-pink",
    totalNum: 1,
    totalPrice: "10.00",
    people: 2,
    memberCount: 1,
    status: 1,
    addTime: now,
  });
  await container.db.insert(storeOrderRefund).values([
    {
      id: 3001, storeOrderId: 1005, supplierId: 0, storeId: 0,
      orderId: "audit-delivery-refund-row", uid: 701, applyPrice: "10.00",
      refundPrice: "10.00", refundNum: 1, refundType: 1, isCancel: 0, isDel: 0, addTime: now,
    },
    {
      id: 3002, storeOrderId: 1103, supplierId: 0, storeId: 0,
      orderId: "audit-split-refund-row", uid: 701, applyPrice: "10.00",
      refundPrice: "10.00", refundNum: 1, refundType: 1, isCancel: 0, isDel: 0, addTime: now,
    },
  ]);

  const splitOrders = [1101, 1102, 1103, 1104];
  let id = 4000;
  const carts = splitOrders.flatMap((oid) => {
    const prefix = oid === 1101 ? "first" : oid === 1102 ? "race" : oid === 1103 ? "refund" : "rollback";
    return [
      {
        id: ++id, uid: 701, oid, cartId: `${prefix}-a`, productId: oid,
        cartNum: 2, surplusNum: 2, splitSurplusNum: 2, splitStatus: 0,
        settlePrice: "10.00", cartInfo: JSON.stringify({ truePrice: "10.00", cartNum: 2 }),
        unique: `${prefix}-cart-a`, addTime: now,
      },
      {
        id: ++id, uid: 701, oid, cartId: `${prefix}-b`, productId: oid + 1,
        cartNum: 1, surplusNum: 1, splitSurplusNum: 1, splitStatus: 0,
        settlePrice: "10.00", cartInfo: JSON.stringify({ truePrice: "10.00", cartNum: 1 }),
        unique: `${prefix}-cart-b`, addTime: now,
      },
    ];
  });
  await container.db.insert(storeOrderCartInfo).values(carts);
}

function deliveryBody(id: string) {
  return {
    delivery_name: "顺丰速运",
    delivery_code: "SF",
    delivery_id: id,
    delivery_type: "send",
    fictitious_content: "must-not-be-stored",
  };
}

async function rejects(callback: () => Promise<unknown>): Promise<boolean> {
  try {
    await callback();
    return false;
  } catch {
    return true;
  }
}

async function runAcl(container: Container) {
  return withTx(container, async (tx) => {
    const service = new OutApiService(createContainerFromDb(tx), {} as Env);
    let allowed = 0;
    for (const route of [
      "/order/delivery/{order_id}",
      "/order/split_delivery/{order_id}",
      "/order/distribution/{order_id}",
    ]) {
      await service.assertInterfacePermission(account(), "PUT", route);
      allowed += 1;
    }
    let denied = false;
    try {
      await service.assertInterfacePermission(account(), "PUT", "/order/invoice/{order_id}");
    } catch (error) {
      denied = error instanceof AuthException;
    }
    return { writes_allowed: allowed, missing_permission_rejected: denied };
  });
}

async function runDelivery(container: Container, schemaName: string) {
  const service = new OutApiService(container, {} as Env);
  const identity = account();
  const firstBody = deliveryBody("SF-OUT-FIRST");
  const first = await service.deliverOrder(identity, "audit-delivery-first", firstBody);
  const replay = await service.deliverOrder(identity, "audit-delivery-first", firstBody);
  const differentPayloadRejected = await rejects(() => service.deliverOrder(
    identity,
    "audit-delivery-first",
    deliveryBody("SF-OUT-DIFFERENT"),
  ));
  const concurrent = await Promise.all([
    service.deliverOrder(identity, "audit-delivery-race", deliveryBody("SF-OUT-RACE")),
    service.deliverOrder(identity, "audit-delivery-race", deliveryBody("SF-OUT-RACE")),
  ]);
  const supplier = await service.deliverOrder(
    identity,
    "audit-delivery-supplier",
    deliveryBody("SF-OUT-SUPPLIER"),
  );
  const guardIds = [
    "audit-delivery-store",
    "audit-delivery-pickup",
    "audit-delivery-refund",
    "audit-delivery-unpaid",
    "audit-delivery-pink",
  ];
  const guards = await Promise.all(guardIds.map((id) => rejects(() =>
    service.deliverOrder(identity, id, deliveryBody(`SF-GUARD-${id}`)))));

  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       ADD CONSTRAINT "out_delivery_replay_failure_probe"
       CHECK ("change_type" <> 'out_order_delivery') NOT VALID`,
  ));
  const rollbackFailed = await rejects(() => service.deliverOrder(
    identity,
    "audit-delivery-rollback",
    deliveryBody("SF-OUT-ROLLBACK"),
  ));
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       DROP CONSTRAINT "out_delivery_replay_failure_probe"`,
  ));

  const state = await withTx(container, async (tx) => ({
    orders: await tx.select({
      id: storeOrder.id,
      status: storeOrder.status,
      deliveryType: storeOrder.deliveryType,
      deliveryId: storeOrder.deliveryId,
      fictitiousContent: storeOrder.fictitiousContent,
    }).from(storeOrder).where(sql`${storeOrder.id} BETWEEN 1001 AND 1009`),
    replay: await tx.select().from(storeOrderStatus)
      .where(eq(storeOrderStatus.changeType, "out_order_delivery")),
  }));
  const orders = new Map(state.orders.map((row) => [row.id, row]));
  const replayText = JSON.stringify(state.replay);
  return {
    first_changed: !first.idempotent && orders.get(1001)?.status === 1,
    replay_idempotent: replay.idempotent && replay.delivery_order_id === first.delivery_order_id,
    concurrent_single_write: concurrent.filter((row) => row.idempotent).length === 1
      && concurrent.filter((row) => !row.idempotent).length === 1
      && concurrent[0].delivery_order_id === concurrent[1].delivery_order_id
      && orders.get(1002)?.status === 1,
    different_payload_rejected: differentPayloadRejected,
    platform_scope_enforced: guards[0] && orders.get(1003)?.status === 0,
    supplier_order_supported: !supplier.idempotent && orders.get(1008)?.status === 1,
    business_guards_enforced: guards.slice(1).every(Boolean)
      && [1004, 1005, 1007, 1009].every((id) => orders.get(id)?.status === 0),
    forced_express_contract: orders.get(1001)?.deliveryType === "express"
      && orders.get(1001)?.deliveryId === "SF-OUT-FIRST"
      && orders.get(1001)?.fictitiousContent === "",
    replay_evidence_rows: state.replay.length,
    replay_evidence_redacted: !replayText.includes("SF-OUT")
      && !replayText.includes("顺丰") && !replayText.includes("must-not-be-stored"),
    rollback_preserved: rollbackFailed && orders.get(1006)?.status === 0
      && orders.get(1006)?.deliveryId === "",
  };
}

async function runSplitDelivery(container: Container, schemaName: string) {
  const service = new OutApiService(container, {} as Env);
  const identity = account();
  const firstBody = {
    ...deliveryBody("SF-SPLIT-FIRST"),
    cart_ids: [{ cart_id: "first-a", cart_num: 1 }],
  };
  const first = await service.splitDeliverOrder(identity, "audit-split-first", firstBody);
  const replay = await service.splitDeliverOrder(identity, "audit-split-first", firstBody);
  const raceBody = {
    ...deliveryBody("SF-SPLIT-RACE"),
    cart_ids: [{ cart_id: "race-a", cart_num: 1 }],
  };
  const concurrent = await Promise.all([
    service.splitDeliverOrder(identity, "audit-split-race", raceBody),
    service.splitDeliverOrder(identity, "audit-split-race", raceBody),
  ]);
  const refundRejected = await rejects(() => service.splitDeliverOrder(
    identity,
    "audit-split-refund",
    { ...deliveryBody("SF-SPLIT-REFUND"), cart_ids: [{ cart_id: "refund-a", cart_num: 1 }] },
  ));

  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       ADD CONSTRAINT "out_split_replay_failure_probe"
       CHECK ("change_type" <> 'out_order_split_delivery') NOT VALID`,
  ));
  const rollbackFailed = await rejects(() => service.splitDeliverOrder(
    identity,
    "audit-split-rollback",
    { ...deliveryBody("SF-SPLIT-ROLLBACK"), cart_ids: [{ cart_id: "rollback-a", cart_num: 1 }] },
  ));
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       DROP CONSTRAINT "out_split_replay_failure_probe"`,
  ));

  const pending = await withTx(container, async (tx) => {
    const orderRows = await tx.select({ id: storeOrder.id }).from(storeOrder)
      .where(sql`${storeOrder.pid} = 1101 AND ${storeOrder.status} = 0`);
    const pendingId = orderRows[0]?.id ?? 0;
    const carts = pendingId > 0
      ? await tx.select({ cartId: storeOrderCartInfo.cartId, cartNum: storeOrderCartInfo.cartNum })
        .from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, pendingId))
      : [];
    return { pendingId, carts };
  });
  assertCondition(pending.pendingId > 0 && pending.carts.length > 0, "first split pending child missing");
  const final = await service.splitDeliverOrder(identity, "audit-split-first", {
    ...deliveryBody("SF-SPLIT-FINAL"),
    cart_ids: pending.carts.map((row) => ({ cart_id: row.cartId, cart_num: row.cartNum })),
  });
  const replayAfterCompletion = await service.splitDeliverOrder(
    identity,
    "audit-split-first",
    firstBody,
  );

  const state = await withTx(container, async (tx) => ({
    roots: await tx.select({ id: storeOrder.id, pid: storeOrder.pid, status: storeOrder.status })
      .from(storeOrder).where(sql`${storeOrder.id} BETWEEN 1101 AND 1104`),
    firstChildren: await tx.select({
      id: storeOrder.id,
      status: storeOrder.status,
      totalNum: storeOrder.totalNum,
      totalPrice: storeOrder.totalPrice,
      payPrice: storeOrder.payPrice,
      deliveryType: storeOrder.deliveryType,
      fictitiousContent: storeOrder.fictitiousContent,
    }).from(storeOrder).where(eq(storeOrder.pid, 1101)),
    raceChildren: await tx.select({ id: storeOrder.id }).from(storeOrder)
      .where(eq(storeOrder.pid, 1102)),
    rollbackChildren: await tx.select({ id: storeOrder.id }).from(storeOrder)
      .where(eq(storeOrder.pid, 1104)),
    firstCarts: await tx.select({ oid: storeOrderCartInfo.oid, cartNum: storeOrderCartInfo.cartNum })
      .from(storeOrderCartInfo).where(sql`${storeOrderCartInfo.oid} IN (
        SELECT id FROM store_order WHERE pid = 1101
      )`),
    rollbackCarts: await tx.select({ cartNum: storeOrderCartInfo.cartNum })
      .from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, 1104)),
    replay: await tx.select().from(storeOrderStatus)
      .where(eq(storeOrderStatus.changeType, "out_order_split_delivery")),
  }));
  const roots = new Map(state.roots.map((row) => [row.id, row]));
  const firstTotalPrice = state.firstChildren.reduce((sum, row) => sum + Number(row.totalPrice), 0);
  const firstPayPrice = state.firstChildren.reduce((sum, row) => sum + Number(row.payPrice), 0);
  const firstQuantity = state.firstChildren.reduce((sum, row) => sum + row.totalNum, 0);
  const cartQuantity = state.firstCarts.reduce((sum, row) => sum + row.cartNum, 0);
  const replayText = JSON.stringify(state.replay);
  return {
    first_split_created: first.split && !first.idempotent
      && first.delivery_order_id > 0
      && first.remaining_order_id !== null
      && first.remaining_order_id > 0,
    replay_same_result: replay.idempotent
      && replay.delivery_order_id === first.delivery_order_id
      && replay.remaining_order_id === first.remaining_order_id,
    replay_after_completion: replayAfterCompletion.idempotent
      && replayAfterCompletion.delivery_order_id === first.delivery_order_id,
    concurrent_single_split: concurrent.filter((row) => row.idempotent).length === 1
      && concurrent.filter((row) => !row.idempotent).length === 1
      && concurrent[0].delivery_order_id === concurrent[1].delivery_order_id
      && state.raceChildren.length === 2,
    amount_conserved: state.firstChildren.length === 2
      && firstTotalPrice === 30 && firstPayPrice === 30,
    quantity_conserved: firstQuantity === 3 && cartQuantity === 3,
    final_batch_completed: !final.idempotent && !final.split
      && state.firstChildren.every((row) => row.status === 1)
      && state.firstChildren.every((row) => row.deliveryType === "express")
      && state.firstChildren.every((row) => row.fictitiousContent === ""),
    refund_guard_enforced: refundRejected && roots.get(1103)?.pid === 0
      && roots.get(1103)?.status === 0,
    replay_evidence_rows: state.replay.length,
    replay_evidence_redacted: !replayText.includes("SF-SPLIT")
      && !replayText.includes("顺丰") && !replayText.includes("must-not-be-stored"),
    rollback_preserved: rollbackFailed && roots.get(1104)?.pid === 0
      && roots.get(1104)?.status === 0 && state.rollbackChildren.length === 0
      && state.rollbackCarts.reduce((sum, row) => sum + row.cartNum, 0) === 3,
  };
}

async function runDistribution(container: Container, schemaName: string) {
  const service = new OutApiService(container, {} as Env);
  const identity = account();
  const firstBody = {
    delivery_name: "新快递甲",
    delivery_code: "NEW-A",
    delivery_id: "TRACKING-A",
  };
  const first = await service.updateOrderDistribution(
    identity,
    "audit-distribution-first",
    firstBody,
  );
  const replay = await service.updateOrderDistribution(
    identity,
    "audit-distribution-first",
    firstBody,
  );
  const newerBody = {
    delivery_name: "新快递乙",
    delivery_code: "NEW-B",
    delivery_id: "TRACKING-B",
  };
  const newer = await service.updateOrderDistribution(
    identity,
    "audit-distribution-first",
    newerBody,
  );
  const delayedReplay = await service.updateOrderDistribution(
    identity,
    "audit-distribution-first",
    firstBody,
  );
  const raceBody = {
    delivery_name: "并发快递",
    delivery_code: "RACE",
    delivery_id: "TRACKING-RACE",
  };
  const concurrent = await Promise.all([
    service.updateOrderDistribution(identity, "audit-distribution-race", raceBody),
    service.updateOrderDistribution(identity, "audit-distribution-race", raceBody),
  ]);
  const platformRejected = await rejects(() => service.updateOrderDistribution(
    identity,
    "audit-distribution-store",
    firstBody,
  ));
  const unshippedRejected = await rejects(() => service.updateOrderDistribution(
    identity,
    "audit-distribution-unshipped",
    firstBody,
  ));
  const sendBody = {
    delivery_name: "平台骑手",
    delivery_code: "SEND-CORRECTED",
    delivery_id: "13800000008",
  };
  const send = await service.updateOrderDistribution(
    identity,
    "audit-distribution-send",
    sendBody,
  );
  const spoofRejected = await rejects(() => service.updateOrderDistribution(
    identity,
    "audit-distribution-send",
    { ...sendBody, delivery_name: "伪造骑手", delivery_id: "13800000009" },
  ));

  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       ADD CONSTRAINT "out_distribution_replay_failure_probe"
       CHECK ("change_type" <> 'out_order_distribution') NOT VALID`,
  ));
  const rollbackFailed = await rejects(() => service.updateOrderDistribution(
    identity,
    "audit-distribution-rollback",
    {
      delivery_name: "回滚快递",
      delivery_code: "ROLLBACK",
      delivery_id: "TRACKING-ROLLBACK",
    },
  ));
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       DROP CONSTRAINT "out_distribution_replay_failure_probe"`,
  ));

  const state = await withTx(container, async (tx) => ({
    orders: await tx.select({
      id: storeOrder.id,
      status: storeOrder.status,
      deliveryType: storeOrder.deliveryType,
      deliveryName: storeOrder.deliveryName,
      deliveryCode: storeOrder.deliveryCode,
      deliveryId: storeOrder.deliveryId,
      deliveryUid: storeOrder.deliveryUid,
    }).from(storeOrder).where(sql`${storeOrder.id} BETWEEN 1201 AND 1206`),
    replay: await tx.select().from(storeOrderStatus)
      .where(eq(storeOrderStatus.changeType, "out_order_distribution")),
    changes: await tx.select().from(storeOrderStatus)
      .where(eq(storeOrderStatus.changeType, "distribution")),
  }));
  const orders = new Map(state.orders.map((row) => [row.id, row]));
  const evidenceText = JSON.stringify([...state.replay, ...state.changes]);
  return {
    first_changed: !first.idempotent,
    replay_idempotent: replay.idempotent && replay.id === first.id,
    newer_change_applied: !newer.idempotent,
    delayed_replay_preserved_newer_value: delayedReplay.idempotent
      && orders.get(1201)?.deliveryName === "新快递乙"
      && orders.get(1201)?.deliveryCode === "NEW-B"
      && orders.get(1201)?.deliveryId === "TRACKING-B",
    concurrent_single_write: concurrent.filter((row) => row.idempotent).length === 1
      && concurrent.filter((row) => !row.idempotent).length === 1
      && orders.get(1202)?.deliveryId === "TRACKING-RACE",
    platform_scope_enforced: platformRejected
      && orders.get(1203)?.deliveryId === "OLD-TRACKING",
    unshipped_rejected: unshippedRejected && orders.get(1204)?.status === 0,
    assigned_courier_authoritative: !send.idempotent
      && orders.get(1206)?.deliveryName === "平台骑手"
      && orders.get(1206)?.deliveryId === "13800000008"
      && orders.get(1206)?.deliveryCode === "SEND-CORRECTED"
      && orders.get(1206)?.deliveryUid === 801,
    spoofed_courier_rejected: spoofRejected,
    replay_evidence_rows: state.replay.length,
    evidence_redacted: !evidenceText.includes("TRACKING-")
      && !evidenceText.includes("新快递")
      && !evidenceText.includes("平台骑手")
      && !evidenceText.includes("13800000008")
      && !evidenceText.includes("伪造骑手"),
    rollback_preserved: rollbackFailed
      && orders.get(1205)?.deliveryName === "原快递"
      && orders.get(1205)?.deliveryCode === "OLD"
      && orders.get(1205)?.deliveryId === "OLD-TRACKING",
  };
}

export async function runOutApiFulfillmentPostgresScenario(
  connectionString: string,
): Promise<OutApiFulfillmentPostgresReport> {
  const schemaName = makeSchemaName();
  const schema = identifier(schemaName);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_fulfillment_root",
  });
  const scoped = createDbFromConnectionString(connectionString, 6, {
    searchPath: schemaName,
    applicationName: "cinashop_out_fulfillment_scenario",
  });
  let created = false;
  let removed = false;
  let prefixCount = -1;
  let before: Fingerprint | undefined;
  let after: Fingerprint | undefined;
  let acl: Awaited<ReturnType<typeof runAcl>> | undefined;
  let delivery: Awaited<ReturnType<typeof runDelivery>> | undefined;
  let splitDelivery: Awaited<ReturnType<typeof runSplitDelivery>> | undefined;
  let distribution: Awaited<ReturnType<typeof runDistribution>> | undefined;
  let serverVersion = "unknown";
  try {
    const versions = await root.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    serverVersion = versions[0]?.server_version ?? "unknown";
    before = await fingerprint(root);
    await setupSchema(root, schemaName);
    created = true;
    await withSchema(scoped, schemaName, (container) => seed(container));
    const container = createContainerFromDb(scoped);
    acl = await runAcl(container);
    delivery = await runDelivery(container, schemaName);
    splitDelivery = await runSplitDelivery(container, schemaName);
    distribution = await runDistribution(container, schemaName);
  } finally {
    try {
      if (created) {
        await root.$client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '3s'`;
          await tx`SET LOCAL statement_timeout = '20s'`;
          await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        });
      }
      const state = await root.$client<{ schema_removed: boolean; prefix_count: number }[]>`
        SELECT to_regnamespace(${schemaName}) IS NULL AS schema_removed,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_out_fulfillment_%') AS prefix_count
      `;
      removed = state[0]?.schema_removed === true;
      prefixCount = state[0]?.prefix_count ?? -1;
      after = await fingerprint(root);
    } finally {
      await Promise.all([root.$client.end({ timeout: 1 }), scoped.$client.end({ timeout: 1 })]);
    }
  }

  assertCondition(acl && delivery && splitDelivery && distribution, "scenario report was not produced");
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(acl.writes_allowed === 3 && acl.missing_permission_rejected, "write ACL diverged");
  assertCondition(delivery.first_changed && delivery.replay_idempotent, "delivery replay diverged");
  assertCondition(delivery.concurrent_single_write && delivery.different_payload_rejected, "delivery concurrency diverged");
  assertCondition(delivery.platform_scope_enforced && delivery.supplier_order_supported, "delivery scope diverged");
  assertCondition(delivery.business_guards_enforced && delivery.forced_express_contract, "delivery guards diverged");
  assertCondition(delivery.replay_evidence_rows === 3 && delivery.replay_evidence_redacted, "delivery replay evidence diverged");
  assertCondition(delivery.rollback_preserved, "delivery rollback diverged");
  assertCondition(splitDelivery.first_split_created && splitDelivery.replay_same_result, "split replay diverged");
  assertCondition(splitDelivery.replay_after_completion && splitDelivery.concurrent_single_split, "split concurrency diverged");
  assertCondition(splitDelivery.amount_conserved && splitDelivery.quantity_conserved, "split conservation diverged");
  assertCondition(splitDelivery.final_batch_completed && splitDelivery.refund_guard_enforced, "split completion or refund guard diverged");
  assertCondition(splitDelivery.replay_evidence_rows === 3 && splitDelivery.replay_evidence_redacted, "split replay evidence diverged");
  assertCondition(splitDelivery.rollback_preserved, "split rollback diverged");
  assertCondition(distribution.first_changed && distribution.replay_idempotent, "distribution replay diverged");
  assertCondition(
    distribution.newer_change_applied && distribution.delayed_replay_preserved_newer_value,
    "distribution delayed replay diverged",
  );
  assertCondition(distribution.concurrent_single_write, "distribution concurrency diverged");
  assertCondition(
    distribution.platform_scope_enforced && distribution.unshipped_rejected,
    "distribution scope or state guard diverged",
  );
  assertCondition(
    distribution.assigned_courier_authoritative && distribution.spoofed_courier_rejected,
    "distribution courier authority diverged",
  );
  assertCondition(
    distribution.replay_evidence_rows === 4 && distribution.evidence_redacted,
    "distribution replay evidence diverged",
  );
  assertCondition(distribution.rollback_preserved, "distribution rollback diverged");
  assertCondition(removed && prefixCount === 0, "temporary schema cleanup failed");
  assertCondition(unchanged, "public tables or sequences changed during isolated scenario");

  return {
    server_version: serverVersion,
    schema_created: created,
    schema_removed: removed,
    temporary_schemas_after: prefixCount,
    public_state_unchanged: unchanged,
    acl,
    delivery,
    split_delivery: splitDelivery,
    distribution,
  };
}
