import { count, eq, sql } from "drizzle-orm";
import {
  deliveryService,
  storeOrder,
  storeOrderCartInfo,
  storeOrderRefund,
  storeOrderWriteoff,
  storePink,
  systemStore,
  systemStoreStaff,
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
  StoreOrderWriteoffService,
  type WriteoffActor,
} from "@/services/order/StoreOrderWriteoffService";
import { completeOrderReceipt } from "@/services/order/OrderBrokerageService";
import { applyOrderRefund } from "@/services/order/StoreOrderRefundService";
import type { SystemConfigEnv } from "@/services/system/SystemConfigService";

const CLONED_TABLES = [
  "user",
  "system_store",
  "system_store_staff",
  "delivery_service",
  "store_order",
  "store_order_cart_info",
  "store_order_refund",
  "store_order_writeoff",
  "store_pink",
  "store_order_status",
  "supplier_flowing_water",
] as const;

const LOCAL_SEQUENCE_TABLES = [
  "store_order_refund",
  "store_order_writeoff",
  "store_order_status",
] as const;

const CONFIG_VALUES: Record<string, string> = {
  extract_time: "0",
  brokerage_func_status: "0",
  store_brokerage_statu: "1",
  store_brokerage_price: "0",
  order_give_integral: "0",
  member_func_status: "0",
  order_give_exp: "0",
  member_card_status: "0",
};

const TEST_CONFIG_ENV: SystemConfigEnv = {
  CONFIG_KV: {
    async get(key) {
      const name = key.startsWith("cfg_") ? key.slice(4) : key;
      return CONFIG_VALUES[name] ?? "";
    },
    async put() {
      throw new Error("integration config cache must remain read-only");
    },
    async delete() {
      throw new Error("integration config cache must remain read-only");
    },
  },
};

interface PublicSnapshot {
  orders: number;
  carts: number;
  refunds: number;
  writeoffs: number;
  statuses: number;
  users: number;
  stores: number;
  staff: number;
  deliveries: number;
  refund_sequence: string | null;
  writeoff_sequence: string | null;
  status_sequence: string | null;
}

export interface StoreOrderWriteoffPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  public_state_unchanged: boolean;
  pickup: {
    preview_masked: boolean;
    partial_status: number;
    code_rotated: boolean;
    completed_status: number;
    writeoff_rows: number;
    staff_recorded: boolean;
  };
  delivery: {
    wrong_actor_rejected: boolean;
    completed_status: number;
    delivery_recorded: boolean;
    immutable_row_staff_id: number;
  };
  concurrency: {
    successes: number;
    rejections: number;
    writeoff_rows: number;
    completed_status: number;
  };
  receipt_guard: {
    delivery_rejected: boolean;
    pickup_rejected: boolean;
    express_completed: boolean;
  };
  identity_guards: {
    staff_conflict_reported: boolean;
    staff_conflict_rejected: boolean;
    delivery_conflict_reported: boolean;
    delivery_conflict_rejected: boolean;
  };
  pink_guard: {
    unformed_rejected: boolean;
    completed_after_formed: boolean;
    completed_status: number;
  };
  refund_race: {
    successes: number;
    rejections: number;
    winner: "refund" | "writeoff";
    loser_business_rejected: boolean;
    refund_rows: number;
    writeoff_rows: number;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PostgreSQL writeoff integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_writeoff_it_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

function verifyCode(seed: number): string {
  return String(seed).padStart(12, "0").slice(-12);
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
      (SELECT count(*)::integer FROM public.store_order) AS orders,
      (SELECT count(*)::integer FROM public.store_order_cart_info) AS carts,
      (SELECT count(*)::integer FROM public.store_order_refund) AS refunds,
      (SELECT count(*)::integer FROM public.store_order_writeoff) AS writeoffs,
      (SELECT count(*)::integer FROM public.store_order_status) AS statuses,
      (SELECT count(*)::integer FROM public."user") AS users,
      (SELECT count(*)::integer FROM public.system_store) AS stores,
      (SELECT count(*)::integer FROM public.system_store_staff) AS staff,
      (SELECT count(*)::integer FROM public.delivery_service) AS deliveries,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_refund_id_seq') AS refund_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_writeoff_id_seq') AS writeoff_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_status_id_seq') AS status_sequence
  `;
  const row = rows[0];
  if (!row) throw new Error("unable to read public PostgreSQL snapshot");
  return row;
}

async function seedFixtures(db: DbClient, schemaName: string, base: number): Promise<void> {
  await withSchema(db, schemaName, async (container) => {
    const tx = container.db;
    const customerUid = base + 1;
    const staffUid = base + 2;
    const deliveryUid = base + 3;
    const wrongDeliveryUid = base + 4;
    const conflictStaffUid = base + 5;
    const conflictDeliveryUid = base + 6;
    const storeId = base + 10;
    const staffId = base + 20;
    const deliveryId = base + 30;
    const wrongDeliveryId = base + 31;
    await tx.insert(user).values([
      { uid: customerUid, account: `itc${base}`, nickname: "integration customer", phone: "13800000001" },
      { uid: staffUid, account: `its${base}`, nickname: "integration staff", phone: "13800000002" },
      { uid: deliveryUid, account: `itd${base}`, nickname: "integration delivery", phone: "13800000003" },
      { uid: wrongDeliveryUid, account: `itw${base}`, nickname: "integration wrong delivery", phone: "13800000004" },
      { uid: conflictStaffUid, account: `itcs${base}`, nickname: "integration duplicate staff", phone: "13800000006" },
      { uid: conflictDeliveryUid, account: `itcd${base}`, nickname: "integration duplicate delivery", phone: "13800000007" },
    ]);
    await tx.insert(systemStore).values({
      id: storeId,
      name: "integration pickup store",
      phone: "13800000005",
      isShow: 1,
      isStore: 1,
      isDel: 0,
    });
    await tx.insert(systemStoreStaff).values([
      {
        id: staffId,
        storeId,
        uid: staffUid,
        account: `staff${base}`,
        phone: "13800000002",
        verifyStatus: 1,
        status: 1,
        isDel: 0,
      },
      {
        id: base + 21,
        storeId,
        uid: conflictStaffUid,
        account: `staffa${base}`,
        phone: "13800000006",
        verifyStatus: 1,
        status: 1,
        isDel: 0,
      },
      {
        id: base + 22,
        storeId,
        uid: conflictStaffUid,
        account: `staffb${base}`,
        phone: "13800000006",
        verifyStatus: 1,
        status: 1,
        isDel: 0,
      },
    ]);
    await tx.insert(deliveryService).values([
      {
        id: deliveryId,
        uid: deliveryUid,
        type: 0,
        relationId: 0,
        nickname: "integration delivery",
        phone: "13800000003",
        status: 1,
        isDel: 0,
      },
      {
        id: wrongDeliveryId,
        uid: wrongDeliveryUid,
        type: 0,
        relationId: 0,
        nickname: "integration wrong delivery",
        phone: "13800000004",
        status: 1,
        isDel: 0,
      },
      {
        id: base + 32,
        uid: conflictDeliveryUid,
        type: 0,
        relationId: 0,
        nickname: "integration duplicate delivery A",
        phone: "13800000007",
        status: 1,
        isDel: 0,
      },
      {
        id: base + 33,
        uid: conflictDeliveryUid,
        type: 0,
        relationId: 0,
        nickname: "integration duplicate delivery B",
        phone: "13800000007",
        status: 1,
        isDel: 0,
      },
    ]);

    await tx.insert(storePink).values({
      id: base + 500,
      uid: customerUid,
      orderId: `IT${base}8`,
      totalNum: 1,
      totalPrice: "10.00",
      people: 2,
      memberCount: 1,
      status: 1,
    });

    const order = (
      offset: number,
      values: Partial<typeof storeOrder.$inferInsert>,
    ): typeof storeOrder.$inferInsert => ({
      id: base + 100 + offset,
      orderId: `IT${base}${offset}`,
      unique: `integration-${base}-${offset}`,
      uid: customerUid,
      realName: "integration customer",
      userPhone: "13800000001",
      paid: 1,
      status: 1,
      totalNum: 1,
      totalPrice: "10.00",
      payPrice: "10.00",
      refundStatus: 0,
      supplierAllocationStatus: 0,
      isDel: 0,
      isSystemDel: 0,
      ...values,
    });
    await tx.insert(storeOrder).values([
      order(0, {
        shippingType: 2,
        storeId,
        status: 0,
        verifyCode: verifyCode(base + 100),
        totalNum: 2,
        totalPrice: "20.00",
        payPrice: "20.00",
      }),
      order(1, {
        shippingType: 1,
        deliveryType: "send",
        deliveryUid,
        verifyCode: verifyCode(base + 101),
      }),
      order(2, {
        shippingType: 3,
        deliveryType: "send",
        deliveryUid,
        verifyCode: verifyCode(base + 102),
      }),
      order(3, {
        shippingType: 1,
        deliveryType: "send",
        deliveryUid,
        verifyCode: verifyCode(base + 103),
      }),
      order(4, {
        shippingType: 2,
        storeId,
        verifyCode: verifyCode(base + 104),
      }),
      order(5, {
        shippingType: 1,
        deliveryType: "express",
        verifyCode: "",
      }),
      order(6, {
        shippingType: 2,
        storeId,
        status: 0,
        verifyCode: verifyCode(base + 106),
      }),
      order(7, {
        shippingType: 1,
        deliveryType: "send",
        deliveryUid: conflictDeliveryUid,
        verifyCode: verifyCode(base + 107),
      }),
      order(8, {
        shippingType: 2,
        storeId,
        status: 0,
        type: 3,
        pinkId: base + 500,
        verifyCode: verifyCode(base + 108),
      }),
      order(9, {
        shippingType: 2,
        storeId,
        status: 0,
        verifyCode: verifyCode(base + 109),
      }),
    ]);

    const cart = (
      offset: number,
      orderOffset: number,
      quantity: number,
    ): typeof storeOrderCartInfo.$inferInsert => ({
      id: base + 200 + offset,
      uid: customerUid,
      oid: base + 100 + orderOffset,
      cartId: `ITC${base}${offset}`,
      unique: `it-cart-${base}-${offset}`,
      productId: base + 300 + offset,
      cartNum: quantity,
      surplusNum: quantity,
      writeTimes: quantity,
      writeSurplusTimes: quantity,
      cartInfo: JSON.stringify({ sku: { price: "10.00" } }),
    });
    await tx.insert(storeOrderCartInfo).values([
      cart(0, 0, 2),
      cart(1, 1, 1),
      cart(2, 2, 1),
      cart(6, 6, 1),
      cart(7, 7, 1),
      cart(8, 8, 1),
      cart(9, 9, 1),
    ]);
  });
}

function service(container: Container): StoreOrderWriteoffService {
  return new StoreOrderWriteoffService(container, TEST_CONFIG_ENV);
}

async function runPickup(db: DbClient, schemaName: string, base: number) {
  const staff: WriteoffActor = { kind: "staff", uid: base + 2 };
  const oldCode = verifyCode(base + 100);
  const first = await withSchema(db, schemaName, async (container) => {
    const writeoff = service(container);
    const preview = await writeoff.info(staff, oldCode);
    const result = await writeoff.execute(staff, {
      code: oldCode,
      items: [{ orderCartId: base + 200, quantity: 1 }],
    });
    const [orderRow, cartRow] = await Promise.all([
      container.db.select().from(storeOrder).where(eq(storeOrder.id, base + 100)).limit(1),
      container.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, base + 200)).limit(1),
    ]);
    assertCondition(orderRow[0]?.status === 5, "partial pickup must set status=5");
    assertCondition(cartRow[0]?.writeSurplusTimes === 1, "partial pickup must decrement remaining quantity");
    assertCondition(cartRow[0]?.staffId === base + 20, "partial pickup must record staff identity");
    assertCondition(orderRow[0].verifyCode !== oldCode, "partial pickup must rotate code");
    assertCondition(/^\d{12}$/.test(orderRow[0].verifyCode), "rotated code must be 12 digits");
    await expectRejected(() => writeoff.info(staff, oldCode), "rotated pickup code");
    assertCondition(preview.user_phone === "138****0001", "preview must mask the customer phone");
    return {
      previewMasked: preview.user_phone === "138****0001",
      result,
      nextCode: orderRow[0].verifyCode,
    };
  });
  assertCondition(first.result.completed === false, "partial pickup result must be incomplete");

  return withSchema(db, schemaName, async (container) => {
    const result = await service(container).execute(staff, {
      code: first.nextCode,
      items: [{ orderCartId: base + 200, quantity: 1 }],
    });
    const [orderRow, cartRow, writeoffCount] = await Promise.all([
      container.db.select().from(storeOrder).where(eq(storeOrder.id, base + 100)).limit(1),
      container.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, base + 200)).limit(1),
      container.db.select({ value: count() }).from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid, base + 100)),
    ]);
    assertCondition(result.completed === true && orderRow[0]?.status === 2, "pickup must complete on final quantity");
    assertCondition(orderRow[0].verifyCode === "", "completed pickup must clear code");
    assertCondition(cartRow[0]?.isWriteoff === 1 && cartRow[0].writeSurplusTimes === 0, "pickup cart must be fully written off");
    assertCondition(writeoffCount[0]?.value === 2, "pickup must keep one immutable row per consumption");
    return {
      preview_masked: first.previewMasked,
      partial_status: first.result.status,
      code_rotated: first.nextCode !== oldCode,
      completed_status: result.status,
      writeoff_rows: writeoffCount[0].value,
      staff_recorded: cartRow[0].staffId === base + 20,
    };
  });
}

async function runDelivery(db: DbClient, schemaName: string, base: number) {
  const code = verifyCode(base + 101);
  const wrongActor: WriteoffActor = { kind: "delivery", uid: base + 4 };
  const actor: WriteoffActor = { kind: "delivery", uid: base + 3 };
  const wrongMessage = await withSchema(db, schemaName, async (container) =>
    expectRejected(() => service(container).execute(wrongActor, { code }), "wrong delivery actor"),
  );
  assertCondition(wrongMessage.length > 0, "wrong actor rejection must have a message");

  return withSchema(db, schemaName, async (container) => {
    const result = await service(container).execute(actor, { code });
    const [orderRow, cartRow, auditRows] = await Promise.all([
      container.db.select().from(storeOrder).where(eq(storeOrder.id, base + 101)).limit(1),
      container.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, base + 201)).limit(1),
      container.db.select().from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid, base + 101)),
    ]);
    assertCondition(result.completed === true && orderRow[0]?.status === 2, "delivery must complete");
    assertCondition(cartRow[0]?.deliveryId === base + 30, "delivery cart must record delivery identity");
    assertCondition(orderRow[0].clerkId === base + 3, "delivery order must record actor uid");
    assertCondition(auditRows.length === 1 && auditRows[0].staffId === 0, "legacy immutable row must not forge staff id");
    return {
      wrong_actor_rejected: true,
      completed_status: result.status,
      delivery_recorded: true,
      immutable_row_staff_id: auditRows[0].staffId,
    };
  });
}

async function runConcurrency(
  firstDb: DbClient,
  secondDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  base: number,
) {
  const actor: WriteoffActor = { kind: "delivery", uid: base + 3 };
  const code = verifyCode(base + 102);
  const run = (db: DbClient) => withSchema(db, schemaName, (container) =>
    service(container).execute(actor, { code }),
  );
  const outcomes = await Promise.allSettled([run(firstDb), run(secondDb)]);
  const successes = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
  const rejections = outcomes.filter((outcome) => outcome.status === "rejected").length;
  assertCondition(successes === 1 && rejections === 1, "concurrent writeoff must have exactly one winner");

  return withSchema(observerDb, schemaName, async (container) => {
    const [orderRow, writeoffCount] = await Promise.all([
      container.db.select().from(storeOrder).where(eq(storeOrder.id, base + 102)).limit(1),
      container.db.select({ value: count() }).from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid, base + 102)),
    ]);
    assertCondition(orderRow[0]?.status === 2, "concurrent winner must complete order");
    assertCondition(writeoffCount[0]?.value === 1, "concurrency must not duplicate immutable writeoff rows");
    return {
      successes,
      rejections,
      writeoff_rows: writeoffCount[0].value,
      completed_status: orderRow[0].status,
    };
  });
}

async function runReceiptGuard(db: DbClient, schemaName: string, base: number) {
  return withSchema(db, schemaName, async (container) => {
    const deliveryRejected = !(await completeOrderReceipt(container, TEST_CONFIG_ENV, {
      orderId: base + 103,
      actor: "user",
      actorId: base + 1,
      message: "integration delivery bypass",
    }));
    const pickupRejected = !(await completeOrderReceipt(container, TEST_CONFIG_ENV, {
      orderId: base + 104,
      actor: "scheduled",
      message: "integration pickup bypass",
    }));
    const expressCompleted = await completeOrderReceipt(container, TEST_CONFIG_ENV, {
      orderId: base + 105,
      actor: "scheduled",
      message: "integration ordinary receipt",
    });
    const rows = await container.db
      .select({ id: storeOrder.id, status: storeOrder.status })
      .from(storeOrder)
      .where(eq(storeOrder.uid, base + 1));
    const byId = new Map(rows.map((row) => [row.id, row.status]));
    assertCondition(deliveryRejected && byId.get(base + 103) === 1, "shared receipt must reject delivery writeoff order");
    assertCondition(pickupRejected && byId.get(base + 104) === 1, "shared receipt must reject pickup order");
    assertCondition(expressCompleted && byId.get(base + 105) === 2, "ordinary express receipt must remain available");
    return {
      delivery_rejected: deliveryRejected,
      pickup_rejected: pickupRejected,
      express_completed: expressCompleted,
    };
  });
}

async function runIdentityGuards(db: DbClient, schemaName: string, base: number) {
  return withSchema(db, schemaName, async (container) => {
    const writeoff = service(container);
    const [staffProfile, deliveryProfile] = await Promise.all([
      writeoff.operatorProfile(base + 5),
      writeoff.operatorProfile(base + 6),
    ]);
    const staffConflictReported = staffProfile.staff_stores.some(
      (row) => row.store_id === base + 10 && row.identity_conflict,
    );
    const deliveryConflictReported = deliveryProfile.delivery_identity_conflict
      && deliveryProfile.delivery === null;
    assertCondition(staffConflictReported, "duplicate staff identity must be reported");
    assertCondition(deliveryConflictReported, "duplicate delivery identity must be reported");

    const staffMessage = await expectRejected(
      () => writeoff.execute(
        { kind: "staff", uid: base + 5 },
        { code: verifyCode(base + 106) },
      ),
      "duplicate staff identity",
    );
    const deliveryMessage = await expectRejected(
      () => writeoff.execute(
        { kind: "delivery", uid: base + 6 },
        { code: verifyCode(base + 107) },
      ),
      "duplicate delivery identity",
    );
    const [staffAudits, deliveryAudits] = await Promise.all([
      container.db.select({ value: count() }).from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid, base + 106)),
      container.db.select({ value: count() }).from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid, base + 107)),
    ]);
    assertCondition(staffMessage.includes("有效核销员"), "duplicate staff must fail at the identity guard");
    assertCondition(deliveryMessage.includes("身份存在重复"), "duplicate delivery must fail at the identity guard");
    assertCondition(staffAudits[0]?.value === 0, "duplicate staff must not create writeoff evidence");
    assertCondition(deliveryAudits[0]?.value === 0, "duplicate delivery must not create writeoff evidence");
    return {
      staff_conflict_reported: staffConflictReported,
      staff_conflict_rejected: true,
      delivery_conflict_reported: deliveryConflictReported,
      delivery_conflict_rejected: true,
    };
  });
}

async function runPinkGuard(db: DbClient, schemaName: string, base: number) {
  const actor: WriteoffActor = { kind: "staff", uid: base + 2 };
  const code = verifyCode(base + 108);
  const rejection = await withSchema(db, schemaName, async (container) => {
    const message = await expectRejected(
      () => service(container).execute(actor, { code }),
      "unformed combination writeoff",
    );
    const [cartRows, auditRows] = await Promise.all([
      container.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, base + 208)).limit(1),
      container.db.select({ value: count() }).from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid, base + 108)),
    ]);
    assertCondition(message.includes("拼团尚未成功"), "unformed combination must fail at the group guard");
    assertCondition(cartRows[0]?.writeSurplusTimes === 1, "unformed group rejection must preserve cart quantity");
    assertCondition(auditRows[0]?.value === 0, "unformed group rejection must not write audit rows");
    return true;
  });

  return withSchema(db, schemaName, async (container) => {
    await container.db
      .update(storePink)
      .set({ status: 2, memberCount: 2 })
      .where(eq(storePink.id, base + 500));
    const result = await service(container).execute(actor, { code });
    const [orderRows, auditRows] = await Promise.all([
      container.db.select().from(storeOrder).where(eq(storeOrder.id, base + 108)).limit(1),
      container.db.select({ value: count() }).from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid, base + 108)),
    ]);
    assertCondition(result.completed && orderRows[0]?.status === 2, "formed combination must become writeoff eligible");
    assertCondition(auditRows[0]?.value === 1, "formed combination completion must create one audit row");
    return {
      unformed_rejected: rejection,
      completed_after_formed: result.completed,
      completed_status: result.status,
    };
  });
}

async function runRefundRace(
  writeoffDb: DbClient,
  refundDb: DbClient,
  observerDb: DbClient,
  schemaName: string,
  base: number,
) {
  const writeoff = withSchema(writeoffDb, schemaName, async (container) => {
    await service(container).execute(
      { kind: "staff", uid: base + 2 },
      { code: verifyCode(base + 109) },
    );
    return "writeoff" as const;
  });
  const refund = withSchema(refundDb, schemaName, async (container) => {
    await applyOrderRefund(container, {
      uid: base + 1,
      orderId: `IT${base}9`,
      refundReason: "integration concurrency",
      refundExplain: "race with writeoff",
      applyType: 1,
    });
    return "refund" as const;
  });
  const outcomes = await Promise.allSettled([writeoff, refund]);
  const successes = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
  const rejections = outcomes.filter((outcome) => outcome.status === "rejected").length;
  const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
  const loser = outcomes.find((outcome) => outcome.status === "rejected");
  assertCondition(successes === 1 && rejections === 1, "refund/writeoff race must have exactly one winner");
  assertCondition(winner?.status === "fulfilled", "refund/writeoff race winner is missing");
  assertCondition(loser?.status === "rejected" && loser.reason instanceof Error, "refund/writeoff loser is missing");
  const loserBusinessRejected = /售后|核销/.test(loser.reason.message)
    && !/lock timeout|deadlock|canceling statement/i.test(loser.reason.message);
  assertCondition(loserBusinessRejected, "refund/writeoff loser must be rejected by a business invariant");

  return withSchema(observerDb, schemaName, async (container) => {
    const [orderRows, cartRows, refundRows, writeoffRows] = await Promise.all([
      container.db.select().from(storeOrder).where(eq(storeOrder.id, base + 109)).limit(1),
      container.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, base + 209)).limit(1),
      container.db.select({ value: count() }).from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId, base + 109)),
      container.db.select({ value: count() }).from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid, base + 109)),
    ]);
    const refundCount = refundRows[0]?.value ?? -1;
    const writeoffCount = writeoffRows[0]?.value ?? -1;
    assertCondition(refundCount + writeoffCount === 1, "refund/writeoff race must persist exactly one outcome");
    if (winner.value === "writeoff") {
      assertCondition(orderRows[0]?.status === 2, "writeoff winner must complete the order");
      assertCondition(cartRows[0]?.writeSurplusTimes === 0, "writeoff winner must consume the cart");
      assertCondition(refundCount === 0 && writeoffCount === 1, "writeoff winner must exclude refund creation");
    } else {
      assertCondition(orderRows[0]?.status === 0, "refund winner must leave pickup pending");
      assertCondition(cartRows[0]?.writeSurplusTimes === 1, "refund winner must preserve the cart");
      assertCondition(refundCount === 1 && writeoffCount === 0, "refund winner must exclude writeoff creation");
    }
    return {
      successes,
      rejections,
      winner: winner.value,
      loser_business_rejected: loserBusinessRejected,
      refund_rows: refundCount,
      writeoff_rows: writeoffCount,
    };
  });
}

export async function runStoreOrderWriteoffPostgresScenario(
  connectionString: string,
): Promise<StoreOrderWriteoffPostgresReport> {
  const schemaName = makeSchemaName();
  const schemaIdentifier = identifier(schemaName);
  const adminDb = createDbFromConnectionString(connectionString, 1);
  const concurrentDbA = createDbFromConnectionString(connectionString, 1);
  const concurrentDbB = createDbFromConnectionString(connectionString, 1);
  const clients = [adminDb.$client, concurrentDbA.$client, concurrentDbB.$client];
  let created = false;
  let report: Omit<StoreOrderWriteoffPostgresReport, "schema_removed" | "public_state_unchanged"> | undefined;
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
    const pickup = await runPickup(adminDb, schemaName, base);
    const delivery = await runDelivery(adminDb, schemaName, base);
    const concurrency = await runConcurrency(
      concurrentDbA,
      concurrentDbB,
      adminDb,
      schemaName,
      base,
    );
    const receiptGuard = await runReceiptGuard(adminDb, schemaName, base);
    const identityGuards = await runIdentityGuards(adminDb, schemaName, base);
    const pinkGuard = await runPinkGuard(adminDb, schemaName, base);
    const refundRace = await runRefundRace(
      concurrentDbA,
      concurrentDbB,
      adminDb,
      schemaName,
      base,
    );
    report = {
      server_version: versionRows[0]?.server_version ?? "unknown",
      schema_created: true,
      pickup,
      delivery,
      concurrency,
      receipt_guard: receiptGuard,
      identity_guards: identityGuards,
      pink_guard: pinkGuard,
      refund_race: refundRace,
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
