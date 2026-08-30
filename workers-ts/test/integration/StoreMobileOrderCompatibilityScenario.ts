import { and, eq, sql } from "drizzle-orm";
import type { Env } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
} from "@/lib/di";
import {
  deliveryService,
  expressCompany,
  storeConfig,
  storeCouponIssue,
  storeOrder,
  storeOrderCartInfo,
  storeOrderPromotions,
  storeOrderRefund,
  storePink,
  storeService,
  storeServiceRecord,
  systemConfig,
  systemStore,
  systemStoreStaff,
  user,
} from "@/models/schema";
import { StoreMobileOrderService } from "@/services/store/StoreMobileOrderService";
import { NotFoundException, ValidateException } from "@/utils/errors";

export const STORE_MOBILE_ORDER_SCHEMA_PREFIX = "codex_store_mobile_order_";
export const STORE_MOBILE_ORDER_TABLES = [
  "user",
  "system_store",
  "system_store_staff",
  "delivery_service",
  "store_service",
  "store_service_record",
  "store_order",
  "store_order_cart_info",
  "store_order_refund",
  "store_order_status",
  "store_order_promotions",
  "store_coupon_issue",
  "store_pink",
  "store_config",
  "system_config",
  "express_company",
  "order_waybill_job",
  "store_order_outbox",
] as const;

const PRIMARY_KEYS: Record<(typeof STORE_MOBILE_ORDER_TABLES)[number], string> = {
  user: "uid",
  system_store: "id",
  system_store_staff: "id",
  delivery_service: "id",
  store_service: "id",
  store_service_record: "id",
  store_order: "id",
  store_order_cart_info: "id",
  store_order_refund: "id",
  store_order_status: "id",
  store_order_promotions: "id",
  store_coupon_issue: "id",
  store_pink: "id",
  store_config: "id",
  system_config: "id",
  express_company: "id",
  order_waybill_job: "id",
  store_order_outbox: "id",
};

const IDS = {
  clerkUid: 1_829_000_001,
  deliveryUid: 1_829_000_002,
  customerUid: 1_829_000_003,
  kefuUid: 1_829_000_004,
  store: 1_829_000_101,
  foreignStore: 1_829_000_102,
  staff: 1_829_000_201,
  duplicateStaff: 1_829_000_202,
  platformDelivery: 1_829_000_211,
  storeDelivery: 1_829_000_212,
  kefu: 1_829_000_221,
  conversation: 1_829_000_222,
  detailOrder: 1_829_000_301,
  refundOrder: 1_829_000_302,
  deliveryWriteoffOrder: 1_829_000_303,
  kefuWriteoffOrder: 1_829_000_304,
  splitOrder: 1_829_000_305,
  foreignOrder: 1_829_000_306,
  detailCart: 1_829_000_401,
  refundCart: 1_829_000_402,
  deliveryWriteoffCart: 1_829_000_403,
  kefuWriteoffCart: 1_829_000_404,
  splitCartA: 1_829_000_405,
  splitCartB: 1_829_000_406,
  foreignCart: 1_829_000_407,
  refund: 1_829_000_501,
  pink: 1_829_000_601,
  coupon: 1_829_000_602,
  promotion: 1_829_000_603,
  express: 1_829_000_604,
} as const;

interface PublicFingerprint {
  tables: Record<string, { count: string; max_id: string | null; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface StoreMobileOrderScenarioReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_before: number;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  assertions: {
    passed: number;
    total: number;
    order_detail_contract: boolean;
    refund_detail_contract: boolean;
    delivery_info_contract: boolean;
    store_idor_closed: boolean;
    delivery_writeoff_contract: boolean;
    kefu_conversation_bound: boolean;
    auth_zero_rejected: boolean;
    split_delivery_committed: boolean;
    split_audit_and_outbox: boolean;
    duplicate_staff_fail_closed: boolean;
    search_path_isolated: boolean;
    public_unchanged: boolean;
  };
  guarantees: {
    isolated_schema_ddl_and_fixture_dml_executed: true;
    public_schema_ddl_or_dml_executed: false;
    public_business_rows_or_sequences_changed: false;
    production_reads_are_bounded_aggregates: true;
    single_flight_advisory_lock: true;
    fingerprints_returned: false;
    business_ids_returned: false;
  };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`STORE-B integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `${STORE_MOBILE_ORDER_SCHEMA_PREFIX}${Date.now().toString(36)}_${random[0].toString(36)}`
    .slice(0, 63);
}

function auditEnv(): Env {
  const values = new Map<string, string>();
  return {
    CONFIG_KV: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value); },
      delete: async (key: string) => { values.delete(key); },
    },
  } as unknown as Env;
}

async function schemaCount(db: DbClient): Promise<number> {
  const rows = await db.$client<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM pg_namespace
    WHERE starts_with(nspname, ${STORE_MOBILE_ORDER_SCHEMA_PREFIX})
  `;
  return Number(rows[0]?.count ?? -1);
}

async function sequenceColumns(db: DbClient, schemaName = "public") {
  return db.$client<Array<{ table_name: string; column_name: string; sequence_name: string }>>`
    SELECT columns.table_name, columns.column_name,
      substring(columns.column_default from 'nextval\\(''([^'']+)''::regclass\\)') AS sequence_name
    FROM information_schema.columns AS columns
    WHERE columns.table_schema = ${schemaName}
      AND columns.table_name IN ${db.$client(STORE_MOBILE_ORDER_TABLES)}
      AND columns.column_default LIKE 'nextval(%'
    ORDER BY columns.table_name, columns.column_name
  `;
}

async function publicFingerprint(db: DbClient): Promise<PublicFingerprint> {
  return db.$client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx`SET LOCAL search_path TO public, pg_temp`;
    await tx`SET LOCAL lock_timeout = '2s'`;
    await tx`SET LOCAL statement_timeout = '45s'`;
    const tables: PublicFingerprint["tables"] = {};
    for (const table of STORE_MOBILE_ORDER_TABLES) {
      const name = identifier(table);
      const key = identifier(PRIMARY_KEYS[table]);
      const rows = await tx.unsafe<Array<{ count: string; max_id: string | null; digest: string }>>(
        `SELECT count(*)::text AS count, max(source.${key})::text AS max_id,
          md5(COALESCE(sum(hashtextextended(to_jsonb(source)::text, 0)::numeric)::text, '')) AS digest
         FROM public.${name} AS source`,
      );
      invariant(rows[0], `could not fingerprint public.${table}`);
      tables[table] = rows[0];
    }
    const sequences = await tx<Array<{ name: string; last_value: string | null }>>`
      SELECT sequencename AS name, last_value::text
      FROM pg_sequences
      WHERE schemaname = 'public'
        AND sequencename IN (
          SELECT replace(substring(column_default from 'nextval\\(''([^'']+)''::regclass\\)'), 'public.', '')
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ${tx(STORE_MOBILE_ORDER_TABLES)}
            AND column_default LIKE 'nextval(%'
        )
      ORDER BY sequencename
    `;
    return { tables, sequences: Object.fromEntries(sequences.map((row) => [row.name, row.last_value])) };
  });
}

async function setupSchema(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  const serials = await sequenceColumns(db);
  invariant(serials.length === STORE_MOBILE_ORDER_TABLES.length, "unexpected serial-column count");
  invariant(
    serials.every((row) => PRIMARY_KEYS[row.table_name as keyof typeof PRIMARY_KEYS] === row.column_name),
    "unexpected sequence-backed column",
  );
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '45s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of STORE_MOBILE_ORDER_TABLES) {
      const name = identifier(table);
      await tx.unsafe(`CREATE TABLE ${schema}.${name} (LIKE public.${name} INCLUDING ALL)`);
    }
    for (const serial of serials) {
      const sequenceBase = serial.sequence_name.split(".").at(-1);
      invariant(sequenceBase, "missing public sequence name");
      const sequence = identifier(sequenceBase);
      const table = identifier(serial.table_name);
      const column = identifier(serial.column_name);
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequence} START WITH 1830000000`);
      await tx.unsafe(`ALTER SEQUENCE ${schema}.${sequence} OWNED BY ${schema}.${table}.${column}`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${table} ALTER COLUMN ${column} `
        + `SET DEFAULT nextval('${schemaName}.${sequenceBase}'::regclass)`,
      );
    }
  });
}

async function withSchema<T>(
  db: DbClient,
  schemaName: string,
  callback: (container: Container) => Promise<T>,
): Promise<T> {
  const schema = identifier(schemaName);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DbClient;
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${schema}, pg_temp`));
    await tx.execute(sql.raw("SET LOCAL TIME ZONE 'UTC'"));
    await tx.execute(sql.raw("SET LOCAL lock_timeout = '5s'"));
    await tx.execute(sql.raw("SET LOCAL statement_timeout = '45s'"));
    return callback(createContainerFromDb(tx));
  });
}

function cartSnapshot(name: string, price: string) {
  return JSON.stringify({
    truePrice: price,
    vip_truePrice: "0.10",
    productInfo: {
      store_name: name,
      image: `/${name}.png`,
      attrInfo: { suk: "默认", image: `/${name}-sku.png`, price },
    },
  });
}

async function seed(container: Container) {
  const now = Math.floor(Date.now() / 1_000) - 60;
  await container.db.insert(user).values([
    { uid: IDS.clerkUid, account: "store-b-clerk", nickname: "审计店员", status: 1, isDel: 0 },
    { uid: IDS.deliveryUid, account: "store-b-delivery", nickname: "审计配送", status: 1, isDel: 0 },
    {
      uid: IDS.customerUid, account: "store-b-customer", nickname: "审计客户",
      barCode: "store-b-user-code", status: 1, isDel: 0,
    },
    { uid: IDS.kefuUid, account: "store-b-kefu", nickname: "审计客服", status: 1, isDel: 0 },
  ]);
  await container.db.insert(systemStore).values([
    {
      id: IDS.store, name: "STORE-B隔离门店", phone: "13000000001",
      address: "隔离区", detailedAddress: "一号", isStore: 1, isShow: 1, isDel: 0,
    },
    { id: IDS.foreignStore, name: "无权门店", isStore: 1, isShow: 1, isDel: 0 },
  ]);
  await container.db.insert(systemStoreStaff).values({
    id: IDS.staff,
    storeId: IDS.store,
    uid: IDS.clerkUid,
    account: "store-b-clerk",
    staffName: "审计店员",
    verifyStatus: 1,
    status: 1,
    isDel: 0,
  });
  await container.db.insert(deliveryService).values([
    {
      id: IDS.platformDelivery, uid: IDS.deliveryUid, type: 0, relationId: 0,
      nickname: "平台配送", phone: "13000000002", status: 1, isDel: 0,
    },
    {
      id: IDS.storeDelivery, uid: IDS.deliveryUid, type: 1, relationId: IDS.store,
      nickname: "门店配送", phone: "13000000002", status: 1, isDel: 0,
    },
  ]);
  await container.db.insert(storeService).values({
    id: IDS.kefu,
    uid: IDS.kefuUid,
    account: "store-b-kefu",
    nickname: "审计客服",
    customer: 1,
    status: 1,
    accountStatus: 1,
    isDel: 0,
  });
  await container.db.insert(storeServiceRecord).values({
    id: IDS.conversation,
    userId: IDS.kefuUid,
    toUid: IDS.customerUid,
    nickname: "审计客户",
    isTourist: 0,
    addTime: now,
    updateTime: now,
  });
  await container.db.insert(systemConfig).values([
    { menuName: "city_delivery_status", value: "1", status: 1 },
    { menuName: "self_delivery_status", value: "1", status: 1 },
    { menuName: "dada_delivery_status", value: "0", status: 1 },
    { menuName: "uu_delivery_status", value: "0", status: 1 },
  ]);
  await container.db.insert(storeConfig).values([
    { type: 1, relationId: IDS.store, keyName: "store_config_export_open", value: "1", addTime: now },
    { type: 1, relationId: IDS.store, keyName: "store_config_export_id", value: "\"SF\"", addTime: now },
    { type: 1, relationId: IDS.store, keyName: "store_config_export_temp_id", value: "\"tpl-a\"", addTime: now },
    { type: 1, relationId: IDS.store, keyName: "store_config_export_to_name", value: "\"审计发件人\"", addTime: now },
    { type: 1, relationId: IDS.store, keyName: "store_config_export_to_tel", value: "\"13000000001\"", addTime: now },
    { type: 1, relationId: IDS.store, keyName: "store_config_export_to_address", value: "\"隔离发件地址\"", addTime: now },
  ]);
  await container.db.insert(storePink).values({
    id: IDS.pink,
    uid: IDS.customerUid,
    orderId: "store-b-detail",
    status: 2,
    addTime: now,
  });
  await container.db.insert(storeCouponIssue).values({
    id: IDS.coupon,
    couponTitle: "审计赠券",
    status: 1,
    isDel: 0,
    addTime: now,
  });
  await container.db.insert(expressCompany).values({
    id: IDS.express,
    code: "SF",
    name: "顺丰",
    isShow: 1,
    status: 1,
  });
  await container.db.insert(storeOrder).values([
    {
      id: IDS.detailOrder, orderId: "store-b-detail", unique: "store-b-detail",
      uid: IDS.customerUid, storeId: IDS.store, type: 3, pinkId: IDS.pink,
      realName: "详情客户", userPhone: "13000000003", userAddress: "详情地址",
      totalNum: 1, totalPrice: "10.00", payPrice: "10.00", paid: 1, status: 1,
      refundStatus: 0, shippingType: 1, giveCoupon: String(IDS.coupon), giveIntegral: 2,
      payType: "weixin", payTime: now, addTime: now, isDel: 0, isSystemDel: 0,
    },
    {
      id: IDS.refundOrder, orderId: "store-b-refund", unique: "store-b-refund",
      uid: IDS.customerUid, storeId: IDS.store, realName: "退款客户",
      userPhone: "13000000004", userAddress: "退款地址", totalNum: 1,
      totalPrice: "20.00", payPrice: "20.00", paid: 1, status: 1,
      refundStatus: 1, refundType: 4, shippingType: 1, payType: "weixin",
      payTime: now, addTime: now, isDel: 0, isSystemDel: 0,
    },
    {
      id: IDS.deliveryWriteoffOrder, orderId: "store-b-delivery-write", unique: "store-b-delivery-write",
      uid: IDS.customerUid, storeId: IDS.store, deliveryUid: IDS.deliveryUid,
      deliveryType: "send", shippingType: 3, verifyCode: "112233445566",
      realName: "配送核销客户", userPhone: "13000000005", totalNum: 1,
      totalPrice: "5.00", payPrice: "5.00", paid: 1, status: 1,
      refundStatus: 0, payTime: now, addTime: now, isDel: 0, isSystemDel: 0,
    },
    {
      id: IDS.kefuWriteoffOrder, orderId: "store-b-kefu-write", unique: "store-b-kefu-write",
      uid: IDS.customerUid, storeId: IDS.store, shippingType: 2, verifyCode: "223344556677",
      realName: "客服核销客户", userPhone: "13000000006", totalNum: 1,
      totalPrice: "6.00", payPrice: "6.00", paid: 1, status: 0,
      refundStatus: 0, payTime: now, addTime: now, isDel: 0, isSystemDel: 0,
    },
    {
      id: IDS.splitOrder, orderId: "store-b-split", unique: "store-b-split",
      uid: IDS.customerUid, storeId: IDS.store, supplierId: 0, shippingType: 1,
      realName: "拆单客户", userPhone: "13000000007", userAddress: "拆单地址",
      cartId: "split-a,split-b", totalNum: 3, totalPrice: "30.00", payPrice: "30.00",
      paid: 1, status: 0, refundStatus: 0, payType: "weixin",
      payTime: now, addTime: now, isDel: 0, isSystemDel: 0,
    },
    {
      id: IDS.foreignOrder, orderId: "store-b-foreign", unique: "store-b-foreign",
      uid: IDS.customerUid, storeId: IDS.foreignStore, totalNum: 1,
      totalPrice: "1.00", payPrice: "1.00", paid: 1, status: 0,
      refundStatus: 0, addTime: now, isDel: 0, isSystemDel: 0,
    },
  ]);
  await container.db.insert(storeOrderCartInfo).values([
    {
      id: IDS.detailCart, uid: IDS.customerUid, oid: IDS.detailOrder,
      cartId: "detail-cart", unique: "detail-cart", productId: 1, cartNum: 1,
      surplusNum: 1, splitSurplusNum: 1, cartInfo: cartSnapshot("详情商品", "10.00"),
    },
    {
      id: IDS.refundCart, uid: IDS.customerUid, oid: IDS.refundOrder,
      cartId: "refund-cart", unique: "refund-cart", productId: 2, cartNum: 1,
      surplusNum: 1, splitSurplusNum: 1, cartInfo: cartSnapshot("退款商品", "20.00"),
    },
    {
      id: IDS.deliveryWriteoffCart, uid: IDS.customerUid, oid: IDS.deliveryWriteoffOrder,
      cartId: "delivery-write-cart", unique: "delivery-write-cart", productId: 3,
      cartNum: 1, writeTimes: 1, writeSurplusTimes: 1, surplusNum: 1,
      cartInfo: cartSnapshot("配送核销商品", "5.00"),
    },
    {
      id: IDS.kefuWriteoffCart, uid: IDS.customerUid, oid: IDS.kefuWriteoffOrder,
      cartId: "kefu-write-cart", unique: "kefu-write-cart", productId: 4,
      cartNum: 1, writeTimes: 1, writeSurplusTimes: 1, surplusNum: 1,
      cartInfo: cartSnapshot("客服核销商品", "6.00"),
    },
    {
      id: IDS.splitCartA, uid: IDS.customerUid, oid: IDS.splitOrder,
      cartId: "split-a", unique: "split-a", productId: 5, cartNum: 2,
      surplusNum: 2, splitSurplusNum: 2, splitStatus: 0, cartInfo: cartSnapshot("拆单商品甲", "10.00"),
    },
    {
      id: IDS.splitCartB, uid: IDS.customerUid, oid: IDS.splitOrder,
      cartId: "split-b", unique: "split-b", productId: 6, cartNum: 1,
      surplusNum: 1, splitSurplusNum: 1, splitStatus: 0, cartInfo: cartSnapshot("拆单商品乙", "10.00"),
    },
    {
      id: IDS.foreignCart, uid: IDS.customerUid, oid: IDS.foreignOrder,
      cartId: "foreign-cart", unique: "foreign-cart", productId: 7, cartNum: 1,
      surplusNum: 1, splitSurplusNum: 1, cartInfo: cartSnapshot("无权商品", "1.00"),
    },
  ]);
  await container.db.insert(storeOrderRefund).values({
    id: IDS.refund,
    storeOrderId: IDS.refundOrder,
    storeId: IDS.store,
    orderId: "store-b-refund-record",
    uid: IDS.customerUid,
    applyType: 2,
    applyPrice: "20.00",
    refundType: 4,
    refundNum: 1,
    refundPrice: "20.00",
    refundReason: "隔离审计",
    cartInfo: JSON.stringify([{ id: IDS.refundCart, cart_id: "refund-cart" }]),
    addTime: now,
    isCancel: 0,
    isDel: 0,
  });
  await container.db.insert(storeOrderPromotions).values({
    id: IDS.promotion,
    oid: IDS.detailOrder,
    uid: IDS.customerUid,
    promotionsId: 1,
    productId: 1,
    promotionsPrice: "1.00",
    addTime: now,
  });
}

async function expectError(
  action: () => Promise<unknown>,
  constructor: typeof ValidateException | typeof NotFoundException,
  messageIncludes: string,
) {
  try {
    await action();
    return false;
  } catch (error) {
    return error instanceof constructor && error.message.includes(messageIncludes);
  }
}

async function dropSchema(db: DbClient, schemaName: string): Promise<void> {
  invariant(schemaName.startsWith(STORE_MOBILE_ORDER_SCHEMA_PREFIX), "cleanup prefix guard failed");
  invariant(/^[a-z_][a-z0-9_]{0,62}$/.test(schemaName), "cleanup identifier guard failed");
  await db.$client.unsafe(`DROP SCHEMA ${identifier(schemaName)} CASCADE`);
}

export async function runStoreMobileOrderCompatibilityScenario(
  connectionString: string,
): Promise<StoreMobileOrderScenarioReport> {
  const admin = createDbFromConnectionString(connectionString, 2, {
    applicationName: "cinashop_store_mobile_order_isolated_admin",
  });
  const runtime = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_store_mobile_order_isolated_runtime",
  });
  const lockDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_store_mobile_order_isolated_lock",
  });
  const schemaName = makeSchemaName();
  let before!: PublicFingerprint;
  let temporarySchemasBefore = -1;
  let schemaCreated = false;
  let schemaRemoved = false;
  let advisoryLockAcquired = false;
  let serverVersion = "";
  let assertions: StoreMobileOrderScenarioReport["assertions"] | undefined;

  try {
    try {
      const locks = await lockDb.$client<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_lock(1829, 8) AS locked
      `;
      advisoryLockAcquired = locks[0]?.locked === true;
      invariant(advisoryLockAcquired, "another isolated STORE-B audit is running");
      const versions = await admin.$client<Array<{ version: string }>>`
        SELECT current_setting('server_version') AS version
      `;
      serverVersion = versions[0]?.version ?? "unknown";
      temporarySchemasBefore = await schemaCount(admin);
      before = await publicFingerprint(admin);
      await setupSchema(admin, schemaName);
      schemaCreated = true;
      await withSchema(runtime, schemaName, seed);

      const base = await withSchema(runtime, schemaName, async (container) => {
        const env = auditEnv();
        const service = new StoreMobileOrderService(container, env);
        const resolution = await container.db.execute(sql.raw(`
          SELECT current_setting('search_path') AS configured_path,
            current_schema() AS current_schema,
            (SELECT namespace.nspname FROM pg_class AS relation
              JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE relation.oid = to_regclass('store_order')) AS resolved_schema
        `));
        const resolutionRows = Array.isArray(resolution)
          ? resolution
          : (resolution as { rows?: Array<Record<string, unknown>> }).rows ?? [];
        const resolved = resolutionRows[0] as Record<string, unknown> | undefined;
        const detail = await service.orderDetail(IDS.clerkUid, IDS.detailOrder);
        const refund = await service.refundDetail(IDS.clerkUid, IDS.refund);
        const delivery = await service.deliveryInfo(IDS.clerkUid, "store-b-detail");
        const foreignDenied = await expectError(
          () => service.orderDetail(IDS.clerkUid, IDS.foreignOrder),
          NotFoundException,
          "不属于当前门店",
        );
        const deliveryLookup = await service.writeoffInfo(
          IDS.deliveryUid,
          2,
          "112233445566",
        );
        const deliveryCart = await service.writeoffCartInfo(
          IDS.deliveryUid,
          2,
          IDS.deliveryWriteoffOrder,
        );
        const kefuLookup = await service.writeoffInfo(IDS.kefuUid, 1, "223344556677");
        await container.db.delete(storeServiceRecord).where(eq(storeServiceRecord.id, IDS.conversation));
        const conversationDenied = await expectError(
          () => service.writeoffInfo(IDS.kefuUid, 1, "223344556677"),
          NotFoundException,
          "不属于当前会话",
        );
        const authZeroRejected = await expectError(
          () => service.writeoffCartInfo(IDS.kefuUid, 0, IDS.kefuWriteoffOrder),
          ValidateException,
          "仅支持客服或配送员",
        );
        const split = await service.splitDelivery(IDS.clerkUid, IDS.splitOrder, {
          type: 1,
          express_record_type: 1,
          delivery_name: "顺丰",
          delivery_code: "SF",
          delivery_id: "SF-STORE-B",
          cart_ids: [{ cart_id: "split-a", cart_num: 1 }],
        });
        const [root, children, audits, outbox] = await Promise.all([
          container.db.select({ pid: storeOrder.pid }).from(storeOrder)
            .where(eq(storeOrder.id, IDS.splitOrder)).limit(1),
          container.db.select({ id: storeOrder.id, status: storeOrder.status }).from(storeOrder)
            .where(eq(storeOrder.pid, IDS.splitOrder)),
          container.db.execute(sql`
            SELECT count(*)::int AS count FROM store_order_status
            WHERE oid = ${IDS.splitOrder} AND change_type = 'store_staff_split_delivery'
          `),
          container.db.execute(sql`
            SELECT count(*)::int AS count FROM store_order_outbox
            WHERE event_type = 'order.delivery.notice'
          `),
        ]);
        const auditRows = Array.isArray(audits)
          ? audits
          : (audits as { rows?: Array<Record<string, unknown>> }).rows ?? [];
        const outboxRows = Array.isArray(outbox)
          ? outbox
          : (outbox as { rows?: Array<Record<string, unknown>> }).rows ?? [];
        await container.db.insert(systemStoreStaff).values({
          id: IDS.duplicateStaff,
          storeId: IDS.store,
          uid: IDS.clerkUid,
          account: "store-b-clerk-duplicate",
          staffName: "重复店员",
          verifyStatus: 1,
          status: 1,
          isDel: 0,
        });
        const duplicateStaffDenied = await expectError(
          () => service.orderDetail(IDS.clerkUid, IDS.detailOrder),
          ValidateException,
          "身份存在重复",
        );
        await container.db.delete(systemStoreStaff).where(and(
          eq(systemStoreStaff.id, IDS.duplicateStaff),
          eq(systemStoreStaff.uid, IDS.clerkUid),
        ));
        return {
          orderDetailContract: detail.id === IDS.detailOrder
            && detail.cartInfo.length === 1
            && detail.cartInfo[0]?.productInfo.store_name === "详情商品"
            && detail.give_coupon[0]?.coupon_title === "审计赠券"
            && detail.pinkStatus === 2
            && detail.store?.id === IDS.store,
          refundDetailContract: refund.id === IDS.refund
            && refund.store_order_sn === "store-b-refund"
            && refund.cartInfo.length === 1
            && refund.express_list[0]?.code === "SF",
          deliveryInfoContract: delivery.id === IDS.detailOrder
            && delivery.config_export_id === "SF"
            && delivery.express_temp_id === "tpl-a"
            && delivery.self_delivery_status === true
            && delivery.nickname === "审计客户",
          storeIdorClosed: foreignDenied,
          deliveryWriteoffContract: deliveryLookup.length === 1
            && deliveryLookup[0]?.id === IDS.deliveryWriteoffOrder
            && deliveryCart.cart_info[0]?.surplus_num === 1,
          kefuConversationBound: kefuLookup.length === 1 && conversationDenied,
          authZeroRejected,
          splitDeliveryCommitted: split.split === true
            && root[0]?.pid === -1
            && children.length === 2
            && children.filter((row) => row.status === 1).length === 1
            && children.filter((row) => row.status === 0).length === 1,
          splitAuditAndOutbox: Number(auditRows[0]?.count ?? 0) === 1
            && Number(outboxRows[0]?.count ?? 0) === 1,
          duplicateStaffFailClosed: duplicateStaffDenied,
          searchPathIsolated: resolved?.configured_path === `${schemaName}, pg_temp`
            && resolved.current_schema === schemaName
            && resolved.resolved_schema === schemaName,
        };
      });

      assertions = {
        passed: 0,
        total: 12,
        order_detail_contract: base.orderDetailContract,
        refund_detail_contract: base.refundDetailContract,
        delivery_info_contract: base.deliveryInfoContract,
        store_idor_closed: base.storeIdorClosed,
        delivery_writeoff_contract: base.deliveryWriteoffContract,
        kefu_conversation_bound: base.kefuConversationBound,
        auth_zero_rejected: base.authZeroRejected,
        split_delivery_committed: base.splitDeliveryCommitted,
        split_audit_and_outbox: base.splitAuditAndOutbox,
        duplicate_staff_fail_closed: base.duplicateStaffFailClosed,
        search_path_isolated: base.searchPathIsolated,
        public_unchanged: false,
      };
      const failed = Object.entries(assertions)
        .filter(([key]) => !["passed", "total", "public_unchanged"].includes(key))
        .filter(([, value]) => value !== true)
        .map(([key]) => key);
      invariant(failed.length === 0, `isolated service assertions failed: ${failed.join(",")}`);
    } finally {
      if (schemaCreated) {
        await dropSchema(admin, schemaName);
        schemaRemoved = true;
      }
      if (advisoryLockAcquired) await lockDb.$client`SELECT pg_advisory_unlock(1829, 8)`;
    }

    const after = await publicFingerprint(admin);
    const temporarySchemasAfter = await schemaCount(admin);
    const publicUnchanged = JSON.stringify(before) === JSON.stringify(after);
    invariant(publicUnchanged, "public rows or sequences changed during isolated audit");
    invariant(temporarySchemasAfter === temporarySchemasBefore, "temporary schema cleanup drifted");
    invariant(assertions, "isolated assertions were not produced");
    assertions.public_unchanged = publicUnchanged;
    assertions.passed = Object.entries(assertions)
      .filter(([key]) => !["passed", "total"].includes(key))
      .filter(([, value]) => value === true).length;
    invariant(assertions.passed === assertions.total, "assertion count mismatch");
    return {
      server_version: serverVersion,
      schema_created: schemaCreated,
      schema_removed: schemaRemoved,
      temporary_schemas_before: temporarySchemasBefore,
      temporary_schemas_after: temporarySchemasAfter,
      public_state_unchanged: publicUnchanged,
      assertions,
      guarantees: {
        isolated_schema_ddl_and_fixture_dml_executed: true,
        public_schema_ddl_or_dml_executed: false,
        public_business_rows_or_sequences_changed: false,
        production_reads_are_bounded_aggregates: true,
        single_flight_advisory_lock: true,
        fingerprints_returned: false,
        business_ids_returned: false,
      },
    };
  } finally {
    await Promise.allSettled([
      admin.$client.end({ timeout: 5 }),
      runtime.$client.end({ timeout: 5 }),
      lockDb.$client.end({ timeout: 5 }),
    ]);
  }
}
