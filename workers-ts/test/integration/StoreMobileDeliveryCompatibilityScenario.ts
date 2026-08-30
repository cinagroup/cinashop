import { and, eq, sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
} from "@/lib/di";
import {
  deliveryService,
  storeOrder,
  storeOrderCartInfo,
  systemStore,
  systemStoreStaff,
  user,
} from "@/models/schema";
import {
  parseLegacyDeliveryTimeRange,
  StoreMobileDeliveryService,
} from "@/services/store/StoreMobileDeliveryService";
import { NotFoundException, ValidateException } from "@/utils/errors";

export const STORE_MOBILE_DELIVERY_SCHEMA_PREFIX = "codex_store_mobile_delivery_";
export const STORE_MOBILE_DELIVERY_TABLES = [
  "user",
  "system_store",
  "system_store_staff",
  "delivery_service",
  "store_order",
  "store_order_cart_info",
] as const;

const PRIMARY_KEYS: Record<(typeof STORE_MOBILE_DELIVERY_TABLES)[number], string> = {
  user: "uid",
  system_store: "id",
  system_store_staff: "id",
  delivery_service: "id",
  store_order: "id",
  store_order_cart_info: "id",
};

const IDS = {
  deliveryUser: 1_728_000_001,
  secondDeliveryUser: 1_728_000_002,
  clerkUser: 1_728_000_003,
  store: 1_728_000_101,
  otherStore: 1_728_000_102,
  platformDelivery: 1_728_000_201,
  storeDelivery: 1_728_000_202,
  secondStoreDelivery: 1_728_000_203,
  duplicateStoreDelivery: 1_728_000_204,
  staff: 1_728_000_251,
  duplicateStaff: 1_728_000_252,
  unsentOrder: 1_728_000_301,
  sentOrder: 1_728_000_302,
  unpaidOrder: 1_728_000_303,
  refundedOrder: 1_728_000_304,
  foreignOrder: 1_728_000_305,
  unsentCart: 1_728_000_401,
  malformedCart: 1_728_000_402,
  oversizedCart: 1_728_000_403,
} as const;

interface PublicFingerprint {
  tables: Record<string, { count: string; max_id: string | null; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface StoreMobileDeliveryScenarioReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_before: number;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  assertions: {
    passed: number;
    total: number;
    info_shape: boolean;
    store_scope: boolean;
    statistics: boolean;
    daily_data: boolean;
    unsent_orders: boolean;
    sent_orders: boolean;
    snapshot_projection: boolean;
    delivery_list: boolean;
    duplicate_delivery_fail_closed: boolean;
    duplicate_staff_fail_closed: boolean;
    search_path_isolated: boolean;
    public_unchanged: boolean;
  };
  guarantees: {
    isolated_schema_ddl_and_fixture_dml_executed: true;
    public_schema_ddl_or_dml_executed: false;
    public_business_rows_or_sequences_changed: false;
    single_flight_advisory_lock: true;
    public_fingerprints_are_bounded_read_only_snapshots: true;
    concurrent_public_writes_can_fail_verification: true;
    fingerprints_returned: false;
    business_ids_returned: false;
  };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`STORE-A integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `${STORE_MOBILE_DELIVERY_SCHEMA_PREFIX}${Date.now().toString(36)}_${random[0].toString(36)}`
    .slice(0, 63);
}

async function schemaCount(db: DbClient): Promise<number> {
  const rows = await db.$client<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM pg_namespace
    WHERE starts_with(nspname, ${STORE_MOBILE_DELIVERY_SCHEMA_PREFIX})
  `;
  return Number(rows[0]?.count ?? -1);
}

async function sequenceColumns(db: DbClient, schemaName = "public") {
  return db.$client<Array<{ table_name: string; column_name: string; sequence_name: string }>>`
    SELECT columns.table_name, columns.column_name,
      substring(columns.column_default from 'nextval\\(''([^'']+)''::regclass\\)') AS sequence_name
    FROM information_schema.columns AS columns
    WHERE columns.table_schema = ${schemaName}
      AND columns.table_name IN ${db.$client(STORE_MOBILE_DELIVERY_TABLES)}
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
    for (const table of STORE_MOBILE_DELIVERY_TABLES) {
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
            AND table_name IN ${tx(STORE_MOBILE_DELIVERY_TABLES)}
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
  invariant(serials.length === STORE_MOBILE_DELIVERY_TABLES.length, "unexpected serial-column count");
  invariant(
    serials.every((row) => PRIMARY_KEYS[row.table_name as keyof typeof PRIMARY_KEYS] === row.column_name),
    "unexpected sequence-backed column",
  );
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '45s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of STORE_MOBILE_DELIVERY_TABLES) {
      const name = identifier(table);
      await tx.unsafe(`CREATE TABLE ${schema}.${name} (LIKE public.${name} INCLUDING ALL)`);
    }
    for (const serial of serials) {
      const sequenceBase = serial.sequence_name.split(".").at(-1);
      invariant(sequenceBase, "missing public sequence name");
      const sequence = identifier(sequenceBase);
      const table = identifier(serial.table_name);
      const column = identifier(serial.column_name);
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequence} START WITH 1729000000`);
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

async function seed(container: Container) {
  const range = parseLegacyDeliveryTimeRange("today");
  invariant(range, "today range unavailable");
  const today = range.start + 3_600;
  await container.db.insert(user).values([
    { uid: IDS.deliveryUser, account: "audit-delivery-a", nickname: "配送甲", status: 1, isDel: 0 },
    { uid: IDS.secondDeliveryUser, account: "audit-delivery-b", nickname: "配送乙", status: 1, isDel: 0 },
    { uid: IDS.clerkUser, account: "audit-clerk", nickname: "店员甲", status: 1, isDel: 0 },
  ]);
  await container.db.insert(systemStore).values([
    { id: IDS.store, name: "隔离审计门店", isShow: 1, isDel: 0 },
    { id: IDS.otherStore, name: "无权门店", isShow: 1, isDel: 0 },
  ]);
  await container.db.insert(deliveryService).values([
    {
      id: IDS.platformDelivery, uid: IDS.deliveryUser, type: 0, relationId: 0,
      nickname: "平台配送甲", phone: "13000000001", status: 1, isDel: 0,
    },
    {
      id: IDS.storeDelivery, uid: IDS.deliveryUser, type: 1, relationId: IDS.store,
      nickname: "门店配送甲", phone: "13000000001", status: 1, isDel: 0,
    },
    {
      id: IDS.secondStoreDelivery, uid: IDS.secondDeliveryUser, type: 1, relationId: IDS.store,
      nickname: "门店配送乙", phone: "13000000002", status: 1, isDel: 0,
    },
  ]);
  await container.db.insert(systemStoreStaff).values({
    id: IDS.staff, storeId: IDS.store, uid: IDS.clerkUser,
    account: "audit-clerk", staffName: "店员甲", status: 1, isDel: 0,
  });
  await container.db.insert(storeOrder).values([
    {
      id: IDS.unsentOrder, orderId: "audit-delivery-unsent", unique: "audit-unsent",
      uid: IDS.deliveryUser, storeId: IDS.store, deliveryUid: IDS.deliveryUser,
      realName: "收货人甲", userPhone: "13000000003", userAddress: "隔离地址甲",
      totalNum: 2, totalPrice: "10.25", payPrice: "10.25", paid: 1, status: 2,
      refundStatus: 0, isDel: 0, isSystemDel: 0, addTime: today,
    },
    {
      id: IDS.sentOrder, orderId: "audit-delivery-sent", unique: "audit-sent",
      uid: IDS.deliveryUser, storeId: IDS.store, deliveryUid: IDS.deliveryUser,
      realName: "收货人乙", userPhone: "13000000004", userAddress: "隔离地址乙",
      totalNum: 1, totalPrice: "20.50", payPrice: "20.50", paid: 1, status: 9,
      refundStatus: 3, isDel: 0, isSystemDel: 0, addTime: today + 60,
    },
    {
      id: IDS.unpaidOrder, orderId: "audit-delivery-unpaid", unique: "audit-unpaid",
      uid: IDS.deliveryUser, storeId: IDS.store, deliveryUid: IDS.deliveryUser,
      payPrice: "99.00", paid: 0, status: 2, refundStatus: 0,
      isDel: 0, isSystemDel: 0, addTime: today + 120,
    },
    {
      id: IDS.refundedOrder, orderId: "audit-delivery-refund", unique: "audit-refund",
      uid: IDS.deliveryUser, storeId: IDS.store, deliveryUid: IDS.deliveryUser,
      payPrice: "88.00", paid: 1, status: 2, refundStatus: 1,
      isDel: 0, isSystemDel: 0, addTime: today + 180,
    },
    {
      id: IDS.foreignOrder, orderId: "audit-delivery-foreign", unique: "audit-foreign",
      uid: IDS.secondDeliveryUser, storeId: IDS.store, deliveryUid: IDS.secondDeliveryUser,
      payPrice: "77.00", paid: 1, status: 2, refundStatus: 0,
      isDel: 0, isSystemDel: 0, addTime: today + 240,
    },
  ]);
  await container.db.insert(storeOrderCartInfo).values([
    {
      id: IDS.unsentCart, uid: IDS.deliveryUser, oid: IDS.unsentOrder,
      cartId: "audit-cart-a", unique: "audit-cart-a", productId: 9001, cartNum: 2,
      skuUnique: "audit-blue-xl",
      cartInfo: JSON.stringify({
        productInfo: {
          id: 9001, store_name: "隔离商品", image: "/audit-product.png",
          attrInfo: { suk: "Blue XL", image: "/audit-sku.png", price: "5.13" },
        },
      }),
    },
    {
      id: IDS.malformedCart, uid: IDS.deliveryUser, oid: IDS.sentOrder,
      cartId: "audit-cart-b", unique: "audit-cart-b", productId: 9002, cartNum: 1,
      skuUnique: "audit-malformed", cartInfo: "{private-malformed-sentinel",
    },
    {
      id: IDS.oversizedCart, uid: IDS.deliveryUser, oid: IDS.sentOrder,
      cartId: "audit-cart-c", unique: "audit-cart-c", productId: 9003, cartNum: 1,
      skuUnique: "audit-oversized", cartInfo: `{"secret":"${"x".repeat(270_000)}"}`,
    },
  ]);
}

async function expectError(
  action: () => Promise<unknown>,
  constructor: typeof ValidateException | typeof NotFoundException,
  message: string,
) {
  try {
    await action();
    return false;
  } catch (error) {
    return error instanceof constructor && error.message === message;
  }
}

async function dropSchema(db: DbClient, schemaName: string): Promise<void> {
  invariant(schemaName.startsWith(STORE_MOBILE_DELIVERY_SCHEMA_PREFIX), "cleanup prefix guard failed");
  invariant(/^[a-z_][a-z0-9_]{0,62}$/.test(schemaName), "cleanup identifier guard failed");
  await db.$client.unsafe(`DROP SCHEMA ${identifier(schemaName)} CASCADE`);
}

export async function runStoreMobileDeliveryCompatibilityScenario(
  connectionString: string,
): Promise<StoreMobileDeliveryScenarioReport> {
  const admin = createDbFromConnectionString(connectionString, 2, {
    applicationName: "cinashop_store_mobile_delivery_isolated_admin",
  });
  const runtime = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_store_mobile_delivery_isolated_runtime",
  });
  const lockDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_store_mobile_delivery_isolated_lock",
  });
  const schemaName = makeSchemaName();
  let before!: PublicFingerprint;
  let temporarySchemasBefore = -1;
  let schemaCreated = false;
  let schemaRemoved = false;
  let advisoryLockAcquired = false;
  let serverVersion = "";
  let assertions: StoreMobileDeliveryScenarioReport["assertions"] | undefined;

  try {
    try {
      const locks = await lockDb.$client<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_lock(1728, 8) AS locked
      `;
      advisoryLockAcquired = locks[0]?.locked === true;
      invariant(advisoryLockAcquired, "another isolated STORE-A audit is running");
      const versions = await admin.$client<Array<{ version: string }>>`
        SELECT current_setting('server_version') AS version
      `;
      serverVersion = versions[0]?.version ?? "unknown";
      temporarySchemasBefore = await schemaCount(admin);
      before = await publicFingerprint(admin);
      await setupSchema(admin, schemaName);
      schemaCreated = true;

      const base = await withSchema(runtime, schemaName, async (container) => {
        const resolution = await container.db.execute(sql.raw(`
          SELECT current_setting('search_path') AS configured_path,
            current_schema() AS current_schema,
            (SELECT namespace.nspname FROM pg_class AS relation
              JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE relation.oid = to_regclass('delivery_service')) AS resolved_schema
        `));
        const rows = Array.isArray(resolution)
          ? resolution
          : (resolution as { rows?: Array<Record<string, unknown>> }).rows ?? [];
        const resolved = rows[0] as Record<string, unknown> | undefined;
        await seed(container);
        const service = new StoreMobileDeliveryService(container);
        const info = await service.info(IDS.deliveryUser);
        const statistics = await service.statistics(IDS.deliveryUser, {
          store_id: String(IDS.store), data: "today",
        });
        const dailyData = await service.data(IDS.deliveryUser, {
          store_id: String(IDS.store), data: "today", page: "1", limit: "10",
        });
        const unsent = await service.orders(IDS.deliveryUser, { type: "1", page: "1", limit: "10" });
        const sent = await service.orders(IDS.deliveryUser, { type: "2", page: "1", limit: "10" });
        const deliveryList = await service.deliveryList(IDS.clerkUser, { page: "1", limit: "10" });
        const deniedStore = await expectError(
          () => service.statistics(IDS.deliveryUser, { store_id: String(IDS.otherStore), data: "today" }),
          NotFoundException,
          "配送员不存在或无权访问该门店",
        );
        const sentJson = JSON.stringify(sent);
        return {
          infoShape: info.uid === IDS.deliveryUser && info.type === 0
            && info.store_info.length === 1 && info.store_info[0]?.id === IDS.store,
          storeScope: deniedStore,
          statistics: statistics.unsend === 1 && statistics.send === 1
            && statistics.send_price === "20.50",
          dailyData: dailyData.length === 1 && dailyData[0]?.count === 2
            && dailyData[0]?.price === "30.75",
          unsentOrders: unsent.data.unsend === 1 && unsent.data.send === 1
            && unsent.list.length === 1 && unsent.list[0]?.id === IDS.unsentOrder
            && unsent.list[0]?._info[0]?.cart_info.productInfo.store_name === "隔离商品",
          sentOrders: sent.list.length === 1 && sent.list[0]?.id === IDS.sentOrder
            && sent.list[0]?.cartInfo.length === 2,
          snapshotProjection: sent.list[0]?.cartInfo.every(
            (cart) => cart.productInfo.store_name === "商品快照" && cart.productInfo.image === "",
          ) === true && !sentJson.includes("private-malformed-sentinel") && !sentJson.includes("secret"),
          deliveryList: deliveryList.length === 2
            && deliveryList.every((entry) => entry.status === 1 && entry.nickname.length > 0),
          searchPathIsolated: resolved?.configured_path === `${schemaName}, pg_temp`
            && resolved.current_schema === schemaName && resolved.resolved_schema === schemaName,
        };
      });

      const duplicateDelivery = await withSchema(runtime, schemaName, async (container) => {
        await container.db.insert(deliveryService).values({
          id: IDS.duplicateStoreDelivery, uid: IDS.deliveryUser, type: 1, relationId: IDS.store,
          nickname: "重复配送身份", status: 1, isDel: 0,
        });
        const rejected = await expectError(
          () => new StoreMobileDeliveryService(container).statistics(
            IDS.deliveryUser,
            { store_id: String(IDS.store), data: "today" },
          ),
          ValidateException,
          "配送员门店身份存在重复，请先清理历史数据",
        );
        await container.db.delete(deliveryService).where(eq(deliveryService.id, IDS.duplicateStoreDelivery));
        return rejected;
      });

      const duplicateStaff = await withSchema(runtime, schemaName, async (container) => {
        await container.db.insert(systemStoreStaff).values({
          id: IDS.duplicateStaff, storeId: IDS.store, uid: IDS.clerkUser,
          account: "audit-clerk-duplicate", staffName: "重复店员", status: 1, isDel: 0,
        });
        const rejected = await expectError(
          () => new StoreMobileDeliveryService(container).deliveryList(
            IDS.clerkUser,
            { page: "1", limit: "10" },
          ),
          ValidateException,
          "店员身份存在重复，请先选择明确门店",
        );
        await container.db.delete(systemStoreStaff).where(and(
          eq(systemStoreStaff.id, IDS.duplicateStaff),
          eq(systemStoreStaff.uid, IDS.clerkUser),
        ));
        return rejected;
      });

      assertions = {
        passed: 0,
        total: 12,
        info_shape: base.infoShape,
        store_scope: base.storeScope,
        statistics: base.statistics,
        daily_data: base.dailyData,
        unsent_orders: base.unsentOrders,
        sent_orders: base.sentOrders,
        snapshot_projection: base.snapshotProjection,
        delivery_list: base.deliveryList,
        duplicate_delivery_fail_closed: duplicateDelivery,
        duplicate_staff_fail_closed: duplicateStaff,
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
      if (advisoryLockAcquired) await lockDb.$client`SELECT pg_advisory_unlock(1728, 8)`;
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
        single_flight_advisory_lock: true,
        public_fingerprints_are_bounded_read_only_snapshots: true,
        concurrent_public_writes_can_fail_verification: true,
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
