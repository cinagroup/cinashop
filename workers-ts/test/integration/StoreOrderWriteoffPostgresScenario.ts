import { count, eq, sql } from "drizzle-orm";
import {
  deliveryService,
  storeOrder,
  storeOrderCartInfo,
  storeOrderOutbox,
  storeProduct,
  storeProductAttrValue,
  storeOrderRefund,
  storeOrderWriteoff,
  storePink,
  systemStore,
  systemStoreStaff,
  user,
} from "@/models/schema";
import type { Env } from "@/env";
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
import { activatePaidSecondCardValidity } from "@/services/order/SecondCardValidityService";
import { SecondCardReminderService } from "@/services/order/SecondCardReminderService";
import { ProductAssociationService } from "@/services/product/ProductAssociationService";
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
  "store_order_outbox",
  "store_pink",
  "store_order_status",
  "supplier_flowing_water",
  "store_product",
  "store_product_relation",
  "store_product_rule",
  "store_product_attr",
  "store_product_attr_result",
  "store_product_attr_value",
  "system_log",
] as const;

const LOCAL_SEQUENCE_TABLES = [
  "store_order_refund",
  "store_order_writeoff",
  "store_order_outbox",
  "store_order_status",
  "store_product",
  "store_product_relation",
  "store_product_rule",
  "store_product_attr",
  "store_product_attr_result",
  "store_product_attr_value",
  "system_log",
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
  outboxes: number;
  statuses: number;
  users: number;
  stores: number;
  staff: number;
  deliveries: number;
  products: number;
  product_skus: number;
  product_rules: number;
  system_logs: number;
  refund_sequence: string | null;
  writeoff_sequence: string | null;
  outbox_sequence: string | null;
  status_sequence: string | null;
  product_sequence: string | null;
  product_sku_sequence: string | null;
  product_rule_sequence: string | null;
  system_log_sequence: string | null;
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
  second_card: {
    product_created: boolean;
    product_updated: boolean;
    single_sku_persisted: boolean;
    pickup_policy_persisted: boolean;
    validity_activated_at_payment: boolean;
    partial_writeoff_verified: boolean;
    repeated_code_rejected: boolean;
    completed_writeoff_verified: boolean;
    expired_rejected: boolean;
    unauthorized_store_rejected: boolean;
    unused_refund_allowed: boolean;
    consumed_refund_rejected: boolean;
    reminder_staged: boolean;
    reminder_replay_idempotent: boolean;
    reminder_queue_payload_opaque: boolean;
    immutable_writeoff_rows: number;
  };
}

export interface SecondCardProductPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  public_state_unchanged: boolean;
  second_card: StoreOrderWriteoffPostgresReport["second_card"];
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
      (SELECT count(*)::integer FROM public.store_order_outbox) AS outboxes,
      (SELECT count(*)::integer FROM public.store_order_status) AS statuses,
      (SELECT count(*)::integer FROM public."user") AS users,
      (SELECT count(*)::integer FROM public.system_store) AS stores,
      (SELECT count(*)::integer FROM public.system_store_staff) AS staff,
      (SELECT count(*)::integer FROM public.delivery_service) AS deliveries,
      (SELECT count(*)::integer FROM public.store_product) AS products,
      (SELECT count(*)::integer FROM public.store_product_attr_value) AS product_skus,
      (SELECT count(*)::integer FROM public.store_product_rule) AS product_rules,
      (SELECT count(*)::integer FROM public.system_log) AS system_logs,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_refund_id_seq') AS refund_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_writeoff_id_seq') AS writeoff_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_outbox_id_seq') AS outbox_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_order_status_id_seq') AS status_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_product_id_seq') AS product_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_product_attr_value_id_seq') AS product_sku_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'store_product_rule_id_seq') AS product_rule_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'system_log_id_seq') AS system_log_sequence
  `;
  const row = rows[0];
  if (!row) throw new Error("unable to read public PostgreSQL snapshot");
  return row;
}

async function seedFixtures(db: DbClient, schemaName: string, base: number): Promise<void> {
  await withSchema(db, schemaName, async (container) => {
    const tx = container.db;
    const now = Math.floor(Date.now() / 1_000);
    const customerUid = base + 1;
    const staffUid = base + 2;
    const deliveryUid = base + 3;
    const wrongDeliveryUid = base + 4;
    const conflictStaffUid = base + 5;
    const conflictDeliveryUid = base + 6;
    const otherStoreStaffUid = base + 7;
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
      { uid: otherStoreStaffUid, account: `itos${base}`, nickname: "integration other-store staff", phone: "13800000008" },
    ]);
    await tx.insert(systemStore).values([
      {
        id: storeId,
        name: "integration pickup store",
        phone: "13800000005",
        isShow: 1,
        isStore: 1,
        isDel: 0,
      },
      {
        id: base + 11,
        name: "integration other pickup store",
        phone: "13800000009",
        isShow: 1,
        isStore: 1,
        isDel: 0,
      },
    ]);
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
      {
        id: base + 23,
        storeId: base + 11,
        uid: otherStoreStaffUid,
        account: `otherstaff${base}`,
        phone: "13800000008",
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
      order(10, {
        shippingType: 2,
        storeId,
        status: 0,
        productType: 4,
        payTime: now - 60,
        verifyCode: verifyCode(base + 110),
        totalNum: 3,
        totalPrice: "30.00",
        payPrice: "30.00",
      }),
      order(11, {
        shippingType: 2,
        storeId,
        status: 0,
        productType: 4,
        payTime: now - 172_800,
        verifyCode: verifyCode(base + 111),
      }),
      order(12, {
        shippingType: 2,
        storeId,
        status: 0,
        productType: 4,
        payTime: now - 60,
        verifyCode: verifyCode(base + 112),
      }),
      order(13, {
        shippingType: 2,
        storeId,
        status: 0,
        productType: 4,
        payTime: now - 60,
        verifyCode: verifyCode(base + 113),
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
      cartId: String(base + 400 + offset),
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
      {
        ...cart(10, 10, 3),
        productType: 4,
        writeStart: 0,
        writeEnd: 0,
        cartInfo: JSON.stringify({
          sku: {
            price: "10.00",
            write_valid: 2,
            write_days: 7,
            write_start: 0,
            write_end: 0,
          },
          productInfo: { store_name: "生产隔离次卡" },
        }),
      },
      {
        ...cart(11, 11, 1),
        productType: 4,
        writeStart: now - 172_800,
        writeEnd: now - 1,
        cartInfo: JSON.stringify({
          sku: { price: "10.00", write_valid: 3, write_start: now - 172_800, write_end: now - 1 },
        }),
      },
      {
        ...cart(12, 12, 1),
        productType: 4,
        writeStart: now - 60,
        writeEnd: now + 604_800,
        cartInfo: JSON.stringify({ sku: { price: "10.00", write_valid: 3 } }),
      },
      {
        ...cart(13, 13, 1),
        productType: 4,
        writeStart: now - 60,
        writeEnd: now + 604_800,
        cartInfo: JSON.stringify({ sku: { price: "10.00", write_valid: 3 } }),
      },
    ]);
  });
}

function service(container: Container): StoreOrderWriteoffService {
  return new StoreOrderWriteoffService(container, TEST_CONFIG_ENV);
}

function secondCardProductPayload(
  validity: { write_valid: 2; write_days: number } | { write_valid: 3; write_start: number; write_end: number },
  unique?: string,
) {
  return {
    product_type: 4,
    store_name: "生产隔离次卡商品",
    store_info: "仅用于隔离 schema 的次卡创建编辑审计",
    cate_id: [],
    brand_id: [],
    store_label_id: [],
    ensure_id: [],
    specs_id: 0,
    specs: [],
    spec_type: 0,
    items: [],
    attrs: [{
      unique,
      price: "30.00",
      settle_price: "20.00",
      cost: "18.00",
      ot_price: "35.00",
      vip_price: "28.00",
      stock: 100,
      brokerage: "0.00",
      brokerage_two: "0.00",
      write_times: 3,
      ...validity,
    }],
    freight: 3,
    postage: "9.90",
    temp_id: 999,
    is_postage: 1,
    is_support_refund: 1,
  };
}

async function runSecondCardProductLifecycle(db: DbClient, schemaName: string) {
  return withSchema(db, schemaName, async (container) => {
    const editor = new ProductAssociationService(container);
    const actor = { id: 901, name: "second-card-audit", ip: "127.0.0.1" };
    const created = await editor.save(
      0,
      secondCardProductPayload({ write_valid: 2, write_days: 7 }),
      actor,
    );
    const createdSkus = await container.db.select().from(storeProductAttrValue)
      .where(eq(storeProductAttrValue.productId, created.id));
    assertCondition(createdSkus.length === 1, "second-card creation must persist exactly one SKU");
    const skuUnique = createdSkus[0].unique;
    const now = Math.floor(Date.now() / 1_000);
    const updated = await editor.save(
      created.id,
      secondCardProductPayload({ write_valid: 3, write_start: now, write_end: now + 604_800 }, skuUnique),
      actor,
    );
    const [products, updatedSkus] = await Promise.all([
      container.db.select().from(storeProduct).where(eq(storeProduct.id, created.id)).limit(1),
      container.db.select().from(storeProductAttrValue)
        .where(eq(storeProductAttrValue.productId, created.id)),
    ]);
    const product = products[0];
    const sku = updatedSkus[0];
    assertCondition(product?.productType === 4, "second-card product type was not persisted");
    assertCondition(product.deliveryType === "2" && product.freight === 1 && product.postage === "0.00",
      "second-card product must be forced to pickup fulfillment");
    assertCondition(updatedSkus.length === 1 && sku.unique === skuUnique,
      "second-card edit must preserve the single SKU identity");
    assertCondition(
      sku.writeTimes === 3
      && sku.writeValid === 3
      && sku.writeDays === 0
      && sku.writeStart === now
      && sku.writeEnd === now + 604_800,
      "second-card validity edit did not round-trip",
    );
    return {
      product_created: created.associations_verified && created.sku_verified,
      product_updated: updated.sku_verified,
      single_sku_persisted: updatedSkus.length === 1 && sku.unique === skuUnique,
      pickup_policy_persisted:
        product.deliveryType === "2"
        && product.freight === 1
        && product.tempId === 0
        && product.isPostage === 0,
    };
  });
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

async function runSecondCardLifecycle(db: DbClient, schemaName: string, base: number) {
  const product = await runSecondCardProductLifecycle(db, schemaName);
  const staff: WriteoffActor = { kind: "staff", uid: base + 2 };
  const activeOrderId = base + 110;
  const activeCartId = base + 210;
  const activeCode = verifyCode(activeOrderId);
  const paidAt = Math.floor(Date.now() / 1_000) - 60;
  const activation = await withSchema(db, schemaName, async (container) => {
    const result = await activatePaidSecondCardValidity(
      container.db,
      [{ id: activeOrderId, paid: 1 }],
      paidAt,
    );
    const rows = await container.db.select().from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.id, activeCartId)).limit(1);
    return {
      result,
      row: rows[0],
    };
  });
  assertCondition(
    activation.result.matched === 1
    && activation.result.changed === 1
    && activation.row?.writeStart === paidAt
    && activation.row.writeEnd === paidAt + 7 * 86_400,
    "second-card validity must activate from the payment timestamp",
  );

  const unusedRefund = await withSchema(db, schemaName, (container) =>
    applyOrderRefund(container, {
      uid: base + 1,
      orderId: `IT${base}12`,
      refundReason: "未核销次卡允许退款",
      refundExplain: "production isolated schema",
      applyType: 1,
      applicationOrderId: `second-card-unused-refund-${base}`,
    })
  );
  const unauthorizedMessage = await expectRejected(
    () => withSchema(db, schemaName, (container) => service(container).execute(
      { kind: "staff", uid: base + 7 },
      { code: verifyCode(base + 113) },
    )),
    "other-store second-card writeoff",
  );
  const expiredMessage = await expectRejected(
    () => withSchema(db, schemaName, (container) => service(container).execute(
      staff,
      { code: verifyCode(base + 111) },
    )),
    "expired second-card writeoff",
  );

  const reminder = await withSchema(db, schemaName, async (container) => {
    const now = Math.floor(Date.now() / 1_000);
    const writeEnd = now + 1_800;
    await container.db.update(storeOrderCartInfo).set({
      writeStart: now - 60,
      writeEnd,
      isAdventSms: 0,
    }).where(eq(storeOrderCartInfo.id, base + 213));
    const queued: unknown[] = [];
    const env = {
      CONFIG_KV: {
        get: async (key: string) => key === "cfg_reminder_deadline_second_card_time" ? "1" : "",
        put: async () => undefined,
        delete: async () => undefined,
      },
      ORDER_QUEUE: {
        sendBatch: async (messages: Array<{ body: unknown }>) => {
          queued.push(...messages.map((item) => item.body));
        },
      },
    } as unknown as Env;
    const service = new SecondCardReminderService(container, env, () => now * 1_000);
    const scheduledAt = now * 1_000;
    const message = {
      action: "processSecondCardReminder" as const,
      job: "reminder_unverified_remind" as const,
      runId: `scheduled:${scheduledAt}`,
      scheduledAt,
      cartInfoId: base + 213,
      orderId: base + 113,
      writeEnd,
      kind: "advent" as const,
    };
    const first = await service.processMessage(message);
    const replay = await service.processMessage(message);
    const outboxes = await container.db.select().from(storeOrderOutbox)
      .where(eq(storeOrderOutbox.aggregateId, base + 113));
    return { first, replay, queued, outboxes };
  });
  const reminderSerialized = JSON.stringify({
    queue: reminder.queued,
    payloads: reminder.outboxes.map((item) => item.payload),
  });
  assertCondition(
    reminder.first === "staged"
    && reminder.replay === "already-staged"
    && reminder.queued.length === 1
    && reminder.outboxes.length === 1,
    "second-card reminder must stage and dispatch exactly once",
  );
  assertCondition(
    !/1380000000|尊敬的顾客|生产隔离次卡/.test(reminderSerialized),
    "second-card reminder queue/outbox payload must remain opaque and bounded",
  );

  const partial = await withSchema(db, schemaName, async (container) => {
    const preview = await service(container).info(staff, activeCode);
    const result = await service(container).execute(staff, {
      code: activeCode,
      items: [{ orderCartId: activeCartId, quantity: 1 }],
    });
    const rows = await container.db.select().from(storeOrder)
      .where(eq(storeOrder.id, activeOrderId)).limit(1);
    return { preview, result, nextCode: rows[0]?.verifyCode ?? "" };
  });
  assertCondition(
    partial.preview.product_type === 4
    && partial.preview.shipping_type === 2
    && partial.preview.write_times === 3
    && partial.result.completed === false
    && /^\d{12}$/.test(partial.nextCode)
    && partial.nextCode !== activeCode,
    "second-card partial pickup writeoff did not preserve its policy",
  );
  const repeatedMessage = await expectRejected(
    () => withSchema(db, schemaName, (container) => service(container).info(staff, activeCode)),
    "repeated second-card code",
  );
  const consumedRefundMessage = await expectRejected(
    () => withSchema(db, schemaName, (container) => applyOrderRefund(container, {
      uid: base + 1,
      orderId: `IT${base}10`,
      refundReason: "已核销次卡必须拒绝退款",
      refundExplain: "production isolated schema",
      applyType: 1,
      applicationOrderId: `second-card-consumed-refund-${base}`,
    })),
    "consumed second-card refund",
  );
  const completed = await withSchema(db, schemaName, async (container) => {
    const result = await service(container).execute(staff, {
      code: partial.nextCode,
      items: [{ orderCartId: activeCartId, quantity: 2 }],
    });
    const [orders, carts, audits] = await Promise.all([
      container.db.select().from(storeOrder).where(eq(storeOrder.id, activeOrderId)).limit(1),
      container.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, activeCartId)).limit(1),
      container.db.select().from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid, activeOrderId)),
    ]);
    return { result, order: orders[0], cart: carts[0], audits };
  });
  assertCondition(
    completed.result.completed
    && completed.order?.status === 2
    && completed.order.verifyCode === ""
    && completed.cart?.writeSurplusTimes === 0
    && completed.cart.isWriteoff === 1
    && completed.audits.length === 2,
    "second-card completion did not persist the terminal state and immutable evidence",
  );
  return {
    ...product,
    validity_activated_at_payment: true,
    partial_writeoff_verified: true,
    repeated_code_rejected: repeatedMessage.length > 0,
    completed_writeoff_verified: true,
    expired_rejected: expiredMessage.includes("超过可核销时间"),
    unauthorized_store_rejected: /核销员|核销订单不存在/.test(unauthorizedMessage),
    unused_refund_allowed: unusedRefund.refundId > 0,
    consumed_refund_rejected: consumedRefundMessage.includes("已有核销记录"),
    reminder_staged: reminder.first === "staged",
    reminder_replay_idempotent: reminder.replay === "already-staged",
    reminder_queue_payload_opaque: reminder.queued.length === 1,
    immutable_writeoff_rows: completed.audits.length,
  };
}

/** Single-client production audit for the type-4 lifecycle; concurrency is audited separately. */
export async function runSecondCardProductPostgresScenario(
  connectionString: string,
): Promise<SecondCardProductPostgresReport> {
  const schemaName = makeSchemaName();
  const schemaIdentifier = identifier(schemaName);
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_second_card_product_audit",
  });
  let created = false;
  let removed = false;
  let before: PublicSnapshot | undefined;
  let after: PublicSnapshot | undefined;
  let secondCard: StoreOrderWriteoffPostgresReport["second_card"] | undefined;
  let serverVersion = "unknown";
  try {
    const versions = await db.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    serverVersion = versions[0]?.server_version ?? "unknown";
    before = await publicSnapshot(db);
    await db.$client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '30s'`;
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
          `ALTER TABLE ${schemaIdentifier}.${tableIdentifier} ALTER COLUMN "id" `
          + `SET DEFAULT nextval('${schemaName}.${table}_id_seq_it'::regclass)`,
        );
      }
    });
    created = true;
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const base = 1_000_000_000 + (random[0] % 50_000_000);
    await seedFixtures(db, schemaName, base);
    secondCard = await runSecondCardLifecycle(db, schemaName, base);
  } finally {
    try {
      if (created) {
        await db.$client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '3s'`;
          await tx`SET LOCAL statement_timeout = '30s'`;
          await tx.unsafe(`DROP SCHEMA IF EXISTS ${schemaIdentifier} CASCADE`);
        });
      }
      const rows = await db.$client<{ schema_removed: boolean }[]>`
        SELECT to_regnamespace(${schemaName}) IS NULL AS schema_removed
      `;
      removed = rows[0]?.schema_removed === true;
      after = await publicSnapshot(db);
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  }
  assertCondition(secondCard, "second-card scenario did not produce a report");
  assertCondition(before && after, "second-card public snapshots are missing");
  assertCondition(removed, "second-card temporary integration schema was not removed");
  const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(publicStateUnchanged, "second-card audit changed public business rows or sequences");
  return {
    server_version: serverVersion,
    schema_created: created,
    schema_removed: removed,
    public_state_unchanged: publicStateUnchanged,
    second_card: secondCard,
  };
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
    const secondCard = await runSecondCardLifecycle(adminDb, schemaName, base);
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
      second_card: secondCard,
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
