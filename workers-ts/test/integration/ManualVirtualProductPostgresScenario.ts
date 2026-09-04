import { eq, inArray, sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
  withTx,
} from "@/lib/di";
import {
  orderWaybillJob,
  storeOrder,
  storeOrderCartInfo,
  storeOrderOutbox,
  storeOrderRefund,
  storeOrderStatus,
} from "@/models/schema";
import { customerVisibleManualVirtualContent } from "@/services/order/StoreOrderCreateService";
import { applyOrderRefund } from "@/services/order/StoreOrderRefundService";
import {
  normalizeSupplierDeliveryInput,
  SupplierFulfillmentService,
} from "@/services/supplier/SupplierFulfillmentService";

const PREFIX = "codex_manual_virtual_";
const TABLES = [
  "store_order",
  "store_order_cart_info",
  "store_order_refund",
  "store_order_status",
  "store_order_outbox",
  "order_waybill_job",
] as const;
const SERIAL_COLUMNS: Partial<Record<(typeof TABLES)[number], string>> = {
  store_order: "id",
  store_order_cart_info: "id",
  store_order_refund: "id",
  store_order_status: "id",
  store_order_outbox: "id",
  order_waybill_job: "id",
};

interface Fingerprint {
  tables: Record<string, { rows: number; digest: string }>;
  sequences: Record<string, string | null>;
}

function assertCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`manual virtual production scenario failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function schemaName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${PREFIX}${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function fingerprint(db: DbClient): Promise<Fingerprint> {
  const tables: Fingerprint["tables"] = {};
  const sequences: Fingerprint["sequences"] = {};
  for (const table of TABLES) {
    const rows = await db.$client.unsafe<Array<{ rows: number; digest: string }>>(`
      SELECT count(*)::integer AS rows,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY to_jsonb(t)::text), '')) AS digest
      FROM public.${identifier(table)} t
    `);
    tables[table] = rows[0] ?? { rows: 0, digest: "" };
    const serialColumn = SERIAL_COLUMNS[table];
    if (!serialColumn) continue;
    const sequenceRows = await db.$client<Array<{ sequence_name: string | null }>>`
      SELECT pg_get_serial_sequence(${`public.${table}`}, ${serialColumn}) AS sequence_name
    `;
    const sequenceName = sequenceRows[0]?.sequence_name?.split(".").at(-1) ?? null;
    if (!sequenceName) {
      sequences[table] = null;
      continue;
    }
    const values = await db.$client<Array<{ value: string | null }>>`
      SELECT last_value::text AS value FROM pg_sequences
      WHERE schemaname = 'public' AND sequencename = ${sequenceName}
    `;
    sequences[table] = values[0]?.value ?? null;
  }
  return { tables, sequences };
}

async function provision(db: DbClient, schema: string): Promise<void> {
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${identifier(schema)}`);
    for (const table of TABLES) {
      await tx.unsafe(
        `CREATE TABLE ${identifier(schema)}.${identifier(table)} `
        + `(LIKE public.${identifier(table)} INCLUDING ALL)`,
      );
      const serialColumn = SERIAL_COLUMNS[table];
      if (!serialColumn) continue;
      const sequence = `${table}_audit_seq`;
      await tx.unsafe(`CREATE SEQUENCE ${identifier(schema)}.${identifier(sequence)}`);
      await tx.unsafe(
        `ALTER SEQUENCE ${identifier(schema)}.${identifier(sequence)} `
        + `OWNED BY ${identifier(schema)}.${identifier(table)}.${identifier(serialColumn)}`,
      );
      await tx.unsafe(
        `ALTER TABLE ${identifier(schema)}.${identifier(table)} ALTER COLUMN ${identifier(serialColumn)} `
        + `SET DEFAULT nextval('${schema}.${sequence}'::regclass)`,
      );
    }
  });
}

async function rejected(promise: Promise<unknown>, expected: string): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes(expected);
  }
}

async function seed(container: Container, base: number) {
  const now = Math.floor(Date.now() / 1_000);
  const ids = {
    delivered: base + 1,
    split: base + 2,
    manualExpress: base + 3,
    physicalVirtual: base + 4,
    cardManual: base + 5,
    secondCardManual: base + 6,
    refundable: base + 7,
    notRefundable: base + 8,
  };
  const common = {
    uid: base + 100,
    supplierId: 77,
    storeId: 0,
    paid: 1,
    status: 0,
    shippingType: 1,
    totalNum: 1,
    totalPrice: "29.90",
    payPrice: "29.90",
    realName: "生产隔离虚拟商品用户",
    userPhone: "13800000000",
    userAddress: "production isolated schema only",
    isDel: 0,
    isSystemDel: 0,
    addTime: now,
  } as const;
  await container.db.insert(storeOrder).values([
    { ...common, id: ids.delivered, orderId: `MV${ids.delivered}`, unique: `mv-${ids.delivered}`, productType: 3 },
    { ...common, id: ids.split, orderId: `MV${ids.split}`, unique: `mv-${ids.split}`, productType: 3 },
    { ...common, id: ids.manualExpress, orderId: `MV${ids.manualExpress}`, unique: `mv-${ids.manualExpress}`, productType: 3 },
    { ...common, id: ids.physicalVirtual, orderId: `MV${ids.physicalVirtual}`, unique: `mv-${ids.physicalVirtual}`, productType: 0 },
    { ...common, id: ids.cardManual, orderId: `MV${ids.cardManual}`, unique: `mv-${ids.cardManual}`, productType: 1 },
    { ...common, id: ids.secondCardManual, orderId: `MV${ids.secondCardManual}`, unique: `mv-${ids.secondCardManual}`, productType: 4 },
    { ...common, id: ids.refundable, orderId: `MV${ids.refundable}`, unique: `mv-${ids.refundable}`, productType: 3 },
    { ...common, id: ids.notRefundable, orderId: `MV${ids.notRefundable}`, unique: `mv-${ids.notRefundable}`, productType: 3 },
  ]);
  const productTypes = [3, 3, 3, 0, 1, 4, 3, 3];
  await container.db.insert(storeOrderCartInfo).values(Object.values(ids).map((oid, index) => ({
    uid: common.uid,
    oid,
    cartId: String(base + 1_000 + index),
    productId: base + 500 + index,
    productType: productTypes[index],
    cartNum: 1,
    surplusNum: 1,
    splitSurplusNum: 1,
    skuUnique: `MVSKU${index + 1}`,
    unique: `mvcart-row-${index + 1}`,
    isSupportRefund: oid === ids.notRefundable ? 0 : 1,
    cartInfo: JSON.stringify({ productInfo: { store_name: `隔离商品${index + 1}` } }),
    addTime: now,
  })));
  return ids;
}

async function runScenario(container: Container, base: number) {
  const scoped = <T>(callback: (current: Container) => Promise<T>) =>
    withTx(container, async (tx) => callback(createContainerFromDb(tx)));
  const ids = await scoped((current) => seed(current, base));
  const fulfillment = new SupplierFulfillmentService(container, {
    CONFIG_KV: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    } as unknown as KVNamespace,
  });
  const content = "下载地址：https://downloads.example/audit\n提取码：CINA";
  const virtualInput = normalizeSupplierDeliveryInput({
    delivery_type: "fictitious",
    fictitious_content: content,
  });
  const expressInput = normalizeSupplierDeliveryInput({
    delivery_type: "express",
    delivery_name: "Audit Express",
    delivery_code: "AUDIT",
    delivery_id: "TRACK-001",
  });
  const emptyContentRejected = rejected(
    Promise.resolve().then(() => normalizeSupplierDeliveryInput({ delivery_type: "fictitious" })),
    "fictitious_content不能为空",
  );
  const before = await scoped((current) => current.db.select().from(storeOrder)
    .where(eq(storeOrder.id, ids.delivered)).limit(1));
  assertCondition(before[0], "manual virtual fixture missing");
  const contentHiddenBeforeDelivery = customerVisibleManualVirtualContent(before[0]) === "";
  const replay = {
    accountId: 901,
    requestHash: "a".repeat(64),
    changeType: "out_order_delivery" as const,
  };

  const delivered = await fulfillment.deliver(77, ids.delivered, virtualInput, { replay });
  const replayed = await fulfillment.deliver(77, ids.delivered, virtualInput, { replay });
  const splitRejected = await rejected(
    fulfillment.splitDelivery(
      77,
      ids.split,
      virtualInput,
      [{ cartId: String(base + 1_001), cartNum: 1 }],
    ),
    "手工虚拟商品不支持拆分发货",
  );
  const manualExpressRejected = await rejected(
    fulfillment.deliver(77, ids.manualExpress, expressInput),
    "手工虚拟商品只能使用虚拟交付",
  );
  const physicalVirtualRejected = await rejected(
    fulfillment.deliver(77, ids.physicalVirtual, virtualInput),
    "实物商品不能使用虚拟交付",
  );
  const cardManualRejected = await rejected(
    fulfillment.deliver(77, ids.cardManual, virtualInput),
    "卡密商品由支付任务自动交付",
  );
  const secondCardManualRejected = await rejected(
    fulfillment.deliver(77, ids.secondCardManual, expressInput),
    "次卡商品必须使用到店核销",
  );
  const crossTenantRejected = await rejected(
    fulfillment.deliver(78, ids.split, virtualInput),
    "订单不存在或不属于当前供应商",
  );
  const refundableOrder = `MV${ids.refundable}`;
  const refund = await scoped((current) => applyOrderRefund(current, {
    uid: base + 100,
    orderId: refundableOrder,
    applyType: 1,
    refundReason: "生产隔离手工虚拟商品退款",
    refundExplain: "",
    applicationOrderId: `manual-virtual-refund-${base}`,
  }));
  const refundReplay = await scoped((current) => applyOrderRefund(current, {
    uid: base + 100,
    orderId: refundableOrder,
    applyType: 1,
    refundReason: "生产隔离手工虚拟商品退款",
    refundExplain: "",
    applicationOrderId: `manual-virtual-refund-${base}`,
  }));
  const nonRefundableRejected = await rejected(
    scoped((current) => applyOrderRefund(current, {
      uid: base + 100,
      orderId: `MV${ids.notRefundable}`,
      applyType: 1,
      refundReason: "不支持退款商品应拒绝",
      refundExplain: "",
      applicationOrderId: `manual-virtual-no-refund-${base}`,
    })),
    "订单包含不支持退款的商品",
  );

  const [orders, statuses, outboxes, carts, refunds, waybillJobs] = await scoped(
    (current) => Promise.all([
      current.db.select().from(storeOrder).where(inArray(storeOrder.id, Object.values(ids))),
      current.db.select().from(storeOrderStatus),
      current.db.select().from(storeOrderOutbox),
      current.db.select().from(storeOrderCartInfo),
      current.db.select({ count: sql<number>`count(*)::int` }).from(storeOrderRefund),
      current.db.select({ count: sql<number>`count(*)::int` }).from(orderWaybillJob),
    ]),
  );
  const deliveredOrder = orders.find((order) => order.id === ids.delivered);
  assertCondition(deliveredOrder, "delivered order readback missing");
  const untouched = orders.filter((order) => order.id !== ids.delivered);
  const deliveryStatus = statuses.find((status) => status.changeType === "delivery_fictitious");
  const replayStatus = statuses.find((status) => status.changeType === "out_order_delivery");
  const outbox = outboxes[0];

  return {
    delivery_result_verified:
      !delivered.split && delivered.order_id === ids.delivered && delivered.idempotent === false,
    replay_idempotent:
      replayed.idempotent && replayed.order_id === ids.delivered && outboxes.length === 1,
    persisted_manual_delivery:
      deliveredOrder.status === 1
      && deliveredOrder.productType === 3
      && deliveredOrder.deliveryType === "fictitious"
      && deliveredOrder.fictitiousContent === content,
    customer_content_hidden_before_delivery: contentHiddenBeforeDelivery,
    customer_content_visible_after_delivery:
      customerVisibleManualVirtualContent(deliveredOrder) === content,
    legacy_status_event_verified:
      deliveryStatus?.oid === ids.delivered
      && deliveryStatus.changeMessage.includes(content)
      && replayStatus?.oid === ids.delivered,
    immutable_outbox_verified:
      outbox?.aggregateId === ids.delivered
      && outbox.eventType === "order.delivery.notice"
      && outbox.eventKey === `order.delivery.notice:${ids.delivered}`,
    content_excluded_from_notification_payload:
      outbox !== undefined && !JSON.stringify(outbox.payload).includes(content),
    empty_content_rejected: await emptyContentRejected,
    split_rejected: splitRejected,
    manual_express_rejected: manualExpressRejected,
    physical_virtual_rejected: physicalVirtualRejected,
    card_manual_rejected: cardManualRejected,
    second_card_manual_rejected: secondCardManualRejected,
    cross_tenant_rejected: crossTenantRejected,
    refundable_application_verified: refund.refundId > 0,
    refund_application_idempotent: refundReplay.refundId === refund.refundId,
    non_refundable_application_rejected: nonRefundableRejected,
    rejected_orders_unchanged:
      untouched.length === 7
      && untouched.every((order) => order.status === 0 && !order.deliveryType && !order.fictitiousContent),
    fixture_cart_rows: carts.length,
    fixture_refund_rows: refunds[0]?.count ?? -1,
    fixture_waybill_jobs: waybillJobs[0]?.count ?? -1,
  };
}

export async function runManualVirtualProductPostgresScenario(connectionString: string) {
  const schema = schemaName();
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_manual_virtual_root",
  });
  let before: Fingerprint | undefined;
  let scenario: Awaited<ReturnType<typeof runScenario>> | undefined;
  let created = false;
  let removed = false;
  let temporarySchemasAfter = -1;
  try {
    before = await fingerprint(root);
    await provision(root, schema);
    created = true;
    const isolated = createDbFromConnectionString(connectionString, 2, {
      searchPath: schema,
      applicationName: "cinashop_manual_virtual_isolated",
    });
    try {
      scenario = await runScenario(
        createContainerFromDb(isolated),
        1_700_000_000 + Date.now() % 10_000_000,
      );
    } finally {
      await isolated.$client.end({ timeout: 1 });
    }
  } finally {
    if (created) {
      await root.$client.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '3s'`;
        await tx`SET LOCAL statement_timeout = '30s'`;
        await tx.unsafe(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`);
      });
    }
    const state = await root.$client<Array<{ removed: boolean; count: number }>>`
      SELECT to_regnamespace(${schema}) IS NULL AS removed,
        (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE ${`${PREFIX}%`}) AS count
    `;
    removed = state[0]?.removed === true;
    temporarySchemasAfter = state[0]?.count ?? -1;
    const after = await fingerprint(root);
    assertCondition(JSON.stringify(before) === JSON.stringify(after), "public state changed");
    await root.$client.end({ timeout: 1 });
  }
  assertCondition(scenario, "scenario result missing");
  const expected = [
    "delivery_result_verified",
    "replay_idempotent",
    "persisted_manual_delivery",
    "customer_content_hidden_before_delivery",
    "customer_content_visible_after_delivery",
    "legacy_status_event_verified",
    "immutable_outbox_verified",
    "content_excluded_from_notification_payload",
    "empty_content_rejected",
    "split_rejected",
    "manual_express_rejected",
    "physical_virtual_rejected",
    "card_manual_rejected",
    "second_card_manual_rejected",
    "cross_tenant_rejected",
    "refundable_application_verified",
    "refund_application_idempotent",
    "non_refundable_application_rejected",
    "rejected_orders_unchanged",
  ];
  const failed = expected.filter((key) => scenario?.[key as keyof typeof scenario] !== true);
  assertCondition(failed.length === 0, `assertions failed: ${failed.join(", ")}`);
  assertCondition(scenario.fixture_cart_rows === 8, "fixture cart rows diverged");
  assertCondition(scenario.fixture_refund_rows === 1, "refund rows diverged");
  assertCondition(scenario.fixture_waybill_jobs === 0, "unexpected waybill jobs");
  assertCondition(removed && temporarySchemasAfter === 0, "temporary schema cleanup failed");
  return {
    schema_created: created,
    schema_removed: removed,
    temporary_schemas_after: temporarySchemasAfter,
    public_state_unchanged: true,
    scenario,
  };
}
