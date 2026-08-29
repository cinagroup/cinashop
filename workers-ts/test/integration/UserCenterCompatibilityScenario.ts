import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import type { Env } from "../../src/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
} from "../../src/lib/di";
import { USER_CENTER_COMPATIBILITY_INDEX_SQL } from "../../src/migrations/userCenterCompatibility";
import {
  cityArea,
  storeProduct,
  storeProductLog,
  systemConfig,
  systemSignReward,
  user as userTable,
  userAddress,
  userBill,
  userRelation,
  userSign,
  video,
} from "../../src/models/schema";
import { UserCenterService } from "../../src/services/user/UserCenterService";
import { UserCollectCompatibilityService } from "../../src/services/user/UserCollectCompatibilityService";
import { UserSignCompatibilityService } from "../../src/services/user/UserSignCompatibilityService";

const SCHEMA_PREFIX = "codex_user_center_";
const PUBLIC_TABLES = [
  { name: "city_area", identity: "id" },
  { name: "store_product", identity: "id" },
  { name: "store_product_log", identity: "id" },
  { name: "store_product_relation", identity: "id" },
  { name: "store_promotions", identity: "id" },
  { name: "system_config", identity: "id" },
  { name: "system_sign_reward", identity: "id" },
  { name: "user", identity: "uid" },
  { name: "user_address", identity: "id" },
  { name: "user_bill", identity: "id" },
  { name: "user_relation", identity: "id" },
  { name: "user_sign", identity: "id" },
  { name: "video", identity: "id" },
] as const;

interface PublicFingerprint {
  table: string;
  rows: string;
  fingerprint: string;
}

interface SafetySnapshot {
  publicTables: PublicFingerprint[];
  temporarySchemas: number;
}

interface ScenarioSummary {
  address: {
    ownerIsolation: boolean;
    cityPathValidated: boolean;
    concurrentDefaultSerialized: boolean;
  };
  collect: {
    productIdempotent: boolean;
    productCountersAndLogs: boolean;
    productCompatibilityKeys: boolean;
    videoIdempotent: boolean;
    videoCompatibilityKeys: boolean;
  };
  sign: {
    readContracts: boolean;
    reminderWrite: boolean;
    concurrentDailyWriteSerialized: boolean;
    databaseDayUniqueness: boolean;
    rewardLedgerConsistent: boolean;
  };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`isolated user-center assertion failed: ${message}`);
}

function quoteIdentifier(value: string): string {
  invariant(/^[a-z_][a-z0-9_]{0,62}$/.test(value), "unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function fingerprintSql(): string {
  return PUBLIC_TABLES.map(({ name }) => {
    const table = quoteIdentifier(name);
    return `
      SELECT '${name}'::text AS table_name,
             COUNT(*)::text AS row_count,
             md5(COALESCE(string_agg(row_hash, '|' ORDER BY row_hash), '')) AS fingerprint
      FROM (
        SELECT md5(to_jsonb(source_row)::text) AS row_hash
        FROM public.${table} AS source_row
      ) AS row_hashes`;
  }).join(" UNION ALL ");
}

async function safetySnapshot(
  client: ReturnType<typeof postgres>,
): Promise<SafetySnapshot> {
  return client.begin(async (tx) => {
    await tx`SET LOCAL search_path TO public`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    const rawFingerprints = await tx.unsafe(fingerprintSql());
    const schemaRows = await tx<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM pg_namespace
      WHERE starts_with(nspname, ${SCHEMA_PREFIX})
    `;
    return {
      publicTables: rawFingerprints.map((row) => ({
        table: String(row.table_name),
        rows: String(row.row_count),
        fingerprint: String(row.fingerprint),
      })).sort((left, right) => left.table.localeCompare(right.table)),
      temporarySchemas: Number(schemaRows[0]?.count ?? -1),
    };
  });
}

function sameFingerprints(
  left: readonly PublicFingerprint[],
  right: readonly PublicFingerprint[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function createIsolatedSchema(
  client: ReturnType<typeof postgres>,
  schemaName: string,
): Promise<void> {
  const schema = quoteIdentifier(schemaName);
  await client.begin(async (tx) => {
    await tx`SET LOCAL search_path TO public`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const { name, identity } of PUBLIC_TABLES) {
      const table = quoteIdentifier(name);
      const identityColumn = quoteIdentifier(identity);
      await tx.unsafe(
        `CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`,
      );
      // LIKE INCLUDING DEFAULTS copies a serial nextval expression that can
      // still reference public.<table>_id_seq. Give every clone a local
      // identity sequence before any fixture or service write is allowed.
      await tx.unsafe(
        `ALTER TABLE ${schema}.${table} ALTER COLUMN ${identityColumn} DROP IDENTITY IF EXISTS`,
      );
      await tx.unsafe(
        `ALTER TABLE ${schema}.${table} ALTER COLUMN ${identityColumn} DROP DEFAULT`,
      );
      await tx.unsafe(
        `ALTER TABLE ${schema}.${table} ALTER COLUMN ${identityColumn} ADD GENERATED BY DEFAULT AS IDENTITY`,
      );
    }
    await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
    await tx.unsafe(USER_CENTER_COMPATIBILITY_INDEX_SQL);
  });
}

async function dropIsolatedSchema(
  client: ReturnType<typeof postgres>,
  schemaName: string,
): Promise<void> {
  const schema = quoteIdentifier(schemaName);
  await client.begin(async (tx) => {
    await tx`SET LOCAL search_path TO public`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });
}

async function rejected(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}

async function countRows(
  tx: DbClient,
  table: typeof userRelation | typeof userSign | typeof userBill | typeof storeProductLog,
): Promise<number> {
  const rows = await tx.select({ count: sql<number>`COUNT(*)::int` }).from(table);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Hyperdrive does not guarantee that a PostgreSQL startup `options` search
 * path reaches every pooled backend. Pin it inside every top-level
 * transaction instead. Containers built from this transaction create nested
 * Drizzle transactions as savepoints, which inherit the SET LOCAL value.
 */
async function withIsolatedTransaction<T>(
  db: DbClient,
  schemaName: string,
  action: (tx: DbClient) => Promise<T>,
): Promise<T> {
  const schema = quoteIdentifier(schemaName);
  return db.transaction(async (rawTx) => {
    // Drizzle transactions expose the full query/transaction surface but omit
    // the root `$client` marker from their type. Attach the same underlying
    // client so createContainerFromDb receives an honest DbClient without an
    // unsafe double assertion; nested transactions remain real savepoints.
    const tx: DbClient = Object.assign(rawTx, { $client: db.$client });
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${schema}`));
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    const current = await tx.execute(sql<{ schema_name: string }>`
      SELECT current_schema() AS schema_name
    `);
    invariant(current[0]?.schema_name === schemaName, "transaction search_path was not pinned");
    return action(tx);
  });
}

async function seedFixture(db: DbClient, schemaName: string): Promise<void> {
  await withIsolatedTransaction(db, schemaName, async (tx) => {
    await tx.insert(userTable).values([
      {
        uid: 910_001,
        account: "codex_audit_owner",
        nickname: "Audit Owner",
        phone: "13900000001",
        integral: 10,
        status: 1,
        isDel: 0,
        level: 0,
        isMoneyLevel: 0,
        isEverLevel: 0,
      },
      {
        uid: 910_002,
        account: "codex_audit_other",
        nickname: "Audit Other",
        phone: "13900000002",
        integral: 0,
        status: 1,
        isDel: 0,
      },
    ]);
    await tx.insert(cityArea).values([
      { id: 920_001, path: "/", parentId: 0, type: "province", name: "审计省", level: 1 },
      { id: 920_002, path: "/920001/", parentId: 920_001, type: "city", name: "审计市", level: 2 },
      { id: 920_003, path: "/920001/920002/", parentId: 920_002, type: "district", name: "审计区", level: 3 },
    ]);
    await tx.insert(storeProduct).values([
      {
        id: 930_001,
        storeName: "Visible isolated product",
        image: "/audit/visible.png",
        price: "19.90",
        vipPrice: "17.90",
        otPrice: "29.90",
        stock: 20,
        isShow: 1,
        isDel: 0,
        isVerify: 1,
        pid: 0,
        isVipProduct: 0,
        storeLabelId: "",
      },
      {
        id: 930_002,
        storeName: "Unavailable isolated product",
        image: "/audit/unavailable.png",
        price: "9.90",
        vipPrice: "0.00",
        otPrice: "12.90",
        stock: 0,
        isShow: 0,
        isDel: 0,
        isVerify: 1,
        pid: 0,
        isVipProduct: 0,
        storeLabelId: "",
      },
    ]);
    await tx.insert(video).values({
      id: 940_001,
      image: "/audit/video.png",
      desc: "Isolated video",
      videoUrl: "/audit/video.mp4",
      likeNum: 4,
      isShow: 1,
      isVerify: 1,
      isDel: 0,
    });
    await tx.insert(systemConfig).values([
      { id: 950_001, isStore: 0, menuName: "sign_status", value: "1", sort: 1, status: 1 },
      { id: 950_002, isStore: 0, menuName: "sign_mode", value: "1", sort: 1, status: 1 },
      { id: 950_003, isStore: 0, menuName: "sign_give_point", value: "3", sort: 1, status: 1 },
      { id: 950_004, isStore: 0, menuName: "sign_give_exp", value: "0", sort: 1, status: 1 },
      { id: 950_005, isStore: 0, menuName: "member_func_status", value: "0", sort: 1, status: 1 },
      { id: 950_006, isStore: 0, menuName: "member_card_status", value: "0", sort: 1, status: 1 },
      { id: 950_007, isStore: 0, menuName: "sign_remind", value: "1", sort: 1, status: 1 },
      { id: 950_008, isStore: 0, menuName: "integral_effective_status", value: "0", sort: 1, status: 1 },
      { id: 950_009, isStore: 0, menuName: "store_brokerage_statu", value: "0", sort: 1, status: 1 },
      { id: 950_010, isStore: 0, menuName: "video_func_status", value: "1", sort: 1, status: 1 },
      { id: 950_011, isStore: 0, menuName: "site_name", value: "Isolated Shop", sort: 1, status: 1 },
      { id: 950_012, isStore: 0, menuName: "wap_login_logo", value: "/audit/logo.png", sort: 1, status: 1 },
    ]);
    await tx.insert(systemSignReward).values([
      { id: 960_001, type: 0, days: 2, point: 7, exp: 0 },
      { id: 960_002, type: 1, days: 2, point: 9, exp: 0 },
    ]);
  });
}

async function exerciseAddress(
  db: DbClient,
  schemaName: string,
): Promise<ScenarioSummary["address"]> {
  const useService = <T>(
    action: (service: UserCenterService, tx: DbClient) => Promise<T>,
  ) => withIsolatedTransaction(db, schemaName, async (tx) => action(
    new UserCenterService(createContainerFromDb(tx)),
    tx,
  ));
  const base = {
    realName: "隔离审计用户",
    phone: "13900000001",
    province: "审计省",
    city: "审计市",
    district: "审计区",
    detail: "审计路 1 号",
    cityId: 920_003,
  };
  const first = await useService((service) => service.addressSave(
    910_001,
    { ...base, isDefault: 1 },
  ));
  const second = await useService((service) => service.addressSave(910_001, {
    ...base,
    detail: "审计路 2 号",
    isDefault: 0,
  }));
  const mismatchRejected = await rejected(() => useService((service) => service.addressSave(910_001, {
    ...base,
    cityId: 920_002,
    detail: "不应写入",
  })));
  const incompletePathRejected = await rejected(() => useService((service) => service.addressSave(910_001, {
    ...base,
    district: "不存在的审计区",
    cityId: 0,
    detail: "不应写入",
  })));
  const foreignReadRejected = await rejected(() => useService(
    (service) => service.addressDetail(910_002, first),
  ));
  const foreignDefaultRejected = await rejected(() => useService(
    (service) => service.addressSetDefault(910_002, first),
  ));

  // Each branch owns a distinct top-level transaction/connection. The nested
  // service transaction is a savepoint, so this still exercises advisory-lock
  // serialization rather than serializing in the harness.
  await Promise.all([
    useService((service) => service.addressSetDefault(910_001, first)),
    useService((service) => service.addressSetDefault(910_001, second)),
  ]);
  const addresses = await withIsolatedTransaction(db, schemaName, (tx) => tx.select({
      id: userAddress.id,
      cityId: userAddress.cityId,
      isDefault: userAddress.isDefault,
    }).from(userAddress).where(and(
      eq(userAddress.uid, 910_001),
      eq(userAddress.isDel, 0),
    )));
  const detail = await useService((service) => service.addressDetail(910_001, first));
  const cityList = Array.isArray(detail.city_list) ? detail.city_list : [];
  const ownerIsolation = foreignReadRejected && foreignDefaultRejected;
  const cityPathValidated = mismatchRejected
    && incompletePathRejected
    && addresses.every((row) => row.cityId === 920_003)
    && cityList.length === 3;
  const concurrentDefaultSerialized = addresses.length === 2
    && addresses.filter((row) => row.isDefault === 1).length === 1;
  invariant(ownerIsolation, "address owner isolation");
  invariant(cityPathValidated, "address city hierarchy validation");
  invariant(concurrentDefaultSerialized, "concurrent default address serialization");
  return { ownerIsolation, cityPathValidated, concurrentDefaultSerialized };
}

function stablePromotionKeys(item: Record<string, unknown> | undefined): boolean {
  return Boolean(item)
    && Object.hasOwn(item!, "promotions")
    && typeof item!.promotions === "object"
    && item!.promotions !== null
    && !Array.isArray(item!.promotions)
    && Object.hasOwn(item!, "activity_frame")
    && Object.hasOwn(item!, "activity_background");
}

async function exerciseCollect(
  db: DbClient,
  schemaName: string,
  env: Env,
): Promise<ScenarioSummary["collect"]> {
  const useCenter = <T>(action: (service: UserCenterService) => Promise<T>) => (
    withIsolatedTransaction(db, schemaName, (tx) => action(
      new UserCenterService(createContainerFromDb(tx)),
    ))
  );
  const useCompatibility = <T>(
    action: (service: UserCollectCompatibilityService) => Promise<T>,
  ) => withIsolatedTransaction(db, schemaName, (tx) => action(
    new UserCollectCompatibilityService(createContainerFromDb(tx), env),
  ));

  const productAdds = await Promise.all([
    useCenter((service) => service.collectAdd(910_001, [930_001, 930_002], "product")),
    useCenter((service) => service.collectAdd(910_001, [930_001, 930_002], "product")),
  ]);
  const productState = await withIsolatedTransaction(db, schemaName, async (tx) => ({
    rows: await tx.select({ id: storeProduct.id, collect: storeProduct.collect })
      .from(storeProduct)
      .where(inArray(storeProduct.id, [930_001, 930_002])),
    relations: await countRows(tx, userRelation),
    logs: await countRows(tx, storeProductLog),
  }));
  const productPage = await useCompatibility(
    (service) => service.list(910_001, 1, 10, "product"),
  );
  const productItems = productPage.list as Record<string, unknown>[];
  const productById = new Map(productItems.map((item) => [Number(item.product_id), item]));
  const productIdempotent = productAdds.reduce((sum, value) => sum + value, 0) === 2
    && productState.relations === 2;
  const productCountersAndLogs = productState.rows.length === 2
    && productState.rows.every((row) => row.collect === 1)
    && productState.logs === 2;
  const productCompatibilityKeys = productPage.count === 2
    && productItems.length === 2
    && productById.get(930_001)?.is_fail === 0
    && productById.get(930_002)?.is_fail === 1
    && stablePromotionKeys(productById.get(930_001))
    && stablePromotionKeys(productById.get(930_002));
  invariant(productIdempotent, "product collect conflict idempotency");
  invariant(productCountersAndLogs, "product collect counters and logs");
  invariant(productCompatibilityKeys, "product collect compatibility projection");

  await Promise.all([
    useCenter((service) => service.collectDel(910_001, [930_001, 930_002], "product")),
    useCenter((service) => service.collectDel(910_001, [930_001, 930_002], "product")),
  ]);
  const productDeleteState = await withIsolatedTransaction(db, schemaName, async (tx) => ({
    rows: await tx.select({ collect: storeProduct.collect })
      .from(storeProduct)
      .where(inArray(storeProduct.id, [930_001, 930_002])),
    relations: await countRows(tx, userRelation),
    logs: await countRows(tx, storeProductLog),
  }));
  invariant(productDeleteState.relations === 0, "product collect delete idempotency");
  invariant(
    productDeleteState.rows.every((row) => row.collect === 0),
    "product counters after delete",
  );
  invariant(productDeleteState.logs === 2, "product add evidence remains append-only");

  const videoAdds = await Promise.all([
    useCenter((service) => service.collectAdd(910_001, [940_001], "video")),
    useCenter((service) => service.collectAdd(910_001, [940_001], "video")),
  ]);
  const videoPage = await useCompatibility(
    (service) => service.list(910_001, 1, 10, "video"),
  );
  const videoItems = videoPage.list as Record<string, unknown>[];
  const videoBeforeDelete = await withIsolatedTransaction(db, schemaName, (tx) => tx
    .select({ collect: video.collectNum })
    .from(video)
    .where(eq(video.id, 940_001)));
  const videoIdempotent = videoAdds.reduce((sum, value) => sum + value, 0) === 1
    && videoPage.count === 1
    && videoBeforeDelete[0]?.collect === 1;
  const videoCompatibilityKeys = videoItems.length === 1
    && videoItems[0]?.video_id === 940_001
    && videoItems[0]?.site_name === "Isolated Shop"
    && videoItems[0]?.wap_login_logo === "/audit/logo.png";
  invariant(videoIdempotent, "video collect conflict idempotency and counter");
  invariant(videoCompatibilityKeys, "video collect compatibility projection");
  await Promise.all([
    useCenter((service) => service.collectDel(910_001, [940_001], "video")),
    useCenter((service) => service.collectDel(910_001, [940_001], "video")),
  ]);
  const videoDeleteState = await withIsolatedTransaction(db, schemaName, async (tx) => ({
    rows: await tx.select({ collect: video.collectNum })
      .from(video)
      .where(eq(video.id, 940_001)),
    relations: await countRows(tx, userRelation),
  }));
  invariant(videoDeleteState.relations === 0, "video collect delete idempotency");
  invariant(videoDeleteState.rows[0]?.collect === 0, "video counter after delete");
  return {
    productIdempotent,
    productCountersAndLogs,
    productCompatibilityKeys,
    videoIdempotent,
    videoCompatibilityKeys,
  };
}

async function exerciseSign(
  db: DbClient,
  schemaName: string,
): Promise<ScenarioSummary["sign"]> {
  const useCenter = <T>(action: (service: UserCenterService) => Promise<T>) => (
    withIsolatedTransaction(db, schemaName, (tx) => action(
      new UserCenterService(createContainerFromDb(tx)),
    ))
  );
  const useCompatibility = <T>(
    action: (service: UserSignCompatibilityService) => Promise<T>,
  ) => withIsolatedTransaction(db, schemaName, (tx) => action(
    new UserSignCompatibilityService(createContainerFromDb(tx)),
  ));
  const [statusBefore, configBefore] = await Promise.all([
    useCenter((service) => service.signStatus(910_001)),
    useCompatibility((service) => service.config(910_001)),
  ]);
  const readContracts = statusBefore.enabled
    && statusBefore.signedToday === false
    && statusBefore.integral === 3
    && configBefore.signStatus === 1
    && configBefore.checkSign === false
    && configBefore.signData.sign_point === 3;
  invariant(readContracts, "pre-sign read contracts");

  await useCompatibility((service) => service.setRemind(910_001, 1));
  const configAfterRemind = await useCompatibility((service) => service.config(910_001));
  const reminderWrite = configAfterRemind.signRemindStatus === 1
    && await rejected(() => useCompatibility((service) => service.setRemind(999_999, 1)));
  invariant(reminderWrite, "sign reminder owner-bound write");

  const writes = await Promise.allSettled([
    useCenter((service) => service.sign(910_001)),
    useCenter((service) => service.sign(910_001)),
  ]);
  const fulfilled = writes.filter((result) => result.status === "fulfilled");
  const rejectedWrites = writes.filter((result) => result.status === "rejected");
  const concurrentDailyWriteSerialized = fulfilled.length === 1
    && rejectedWrites.length === 1
    && fulfilled[0]?.status === "fulfilled"
    && fulfilled[0].value.point === 3;
  invariant(concurrentDailyWriteSerialized, "concurrent daily sign serialization");

  const nowLocal = new Date(Date.now() + 8 * 60 * 60 * 1_000);
  const month = `${nowLocal.getUTCFullYear()}-${nowLocal.getUTCMonth() + 1}`;
  const [list, months, calendar, userInfo, ledger] = await Promise.all([
    useCompatibility((service) => service.list(910_001, 1, 10)),
    useCompatibility((service) => service.month(910_001, 1, 8)),
    useCompatibility((service) => service.calendar(910_001, month)),
    useCompatibility((service) => service.user(
      910_001,
      { sign: true, integral: true, all: true },
    )),
    withIsolatedTransaction(db, schemaName, async (tx) => ({
      accounts: await tx.select({ integral: userTable.integral, signNum: userTable.signNum })
        .from(userTable)
        .where(eq(userTable.uid, 910_001)),
      signs: await countRows(tx, userSign),
      signTimes: await tx.select({ addTime: userSign.addTime })
        .from(userSign)
        .where(eq(userSign.uid, 910_001)),
      bills: await countRows(tx, userBill),
    })),
  ]);
  const rewardLedgerConsistent = ledger.accounts[0]?.integral === 13
    && ledger.accounts[0]?.signNum === 1
    && ledger.signs === 1
    && ledger.bills === 1;
  const postReadContracts = list.length === 1
    && typeof list[0]?.add_time === "string"
    && months.length === 1
    && months[0]?.list.length === 1
    && calendar.checkSign === true
    && calendar.signList.some((item) => item.is_sign === true)
    && userInfo.sum_sgin_day === 1
    && userInfo.is_day_sgin === true
    && userInfo.sum_integral === 3;
  invariant(rewardLedgerConsistent, "sign reward account and ledger consistency");
  invariant(postReadContracts, "post-sign list/month/calendar/user contracts");
  const awardedAt = ledger.signTimes[0]?.addTime ?? 0;
  const shanghaiDayStart = Math.floor((awardedAt + 28_800) / 86_400) * 86_400 - 28_800;
  const alternateSameDayTime = awardedAt === shanghaiDayStart ? awardedAt + 1 : shanghaiDayStart;
  const databaseDayUniqueness = await rejected(() => withIsolatedTransaction(
    db,
    schemaName,
    (tx) => tx.insert(userSign).values({
      uid: 910_001,
      addTime: alternateSameDayTime,
    }),
  ));
  invariant(databaseDayUniqueness, "database Shanghai-day sign uniqueness");
  return {
    readContracts: readContracts && postReadContracts,
    reminderWrite,
    concurrentDailyWriteSerialized,
    databaseDayUniqueness,
    rewardLedgerConsistent,
  };
}

async function exerciseScenario(
  db: DbClient,
  schemaName: string,
  env: Env,
): Promise<ScenarioSummary> {
  await seedFixture(db, schemaName);
  return {
    address: await exerciseAddress(db, schemaName),
    collect: await exerciseCollect(db, schemaName, env),
    sign: await exerciseSign(db, schemaName),
  };
}

/**
 * Run write-capable compatibility checks only inside a cryptographically
 * random PostgreSQL schema. Public business tables are fingerprinted before
 * and after, and cleanup invariants are evaluated even when a service call
 * throws, so a failed scenario cannot silently leave audit state behind.
 */
export async function runUserCenterCompatibilityScenario(
  connectionString: string,
  env: Env,
) {
  const schemaName = `${SCHEMA_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(connectionString, {
    max: 2,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_user_center_isolated_audit" },
  });
  let db: DbClient | undefined;
  let result: ScenarioSummary | undefined;
  let scenarioFailure: unknown;
  let cleanupFailure: unknown;
  try {
    const before = await safetySnapshot(admin);
    try {
      await createIsolatedSchema(admin, schemaName);
      db = createDbFromConnectionString(connectionString, 5, {
        applicationName: "cinashop_user_center_isolated_services",
      });
      result = await exerciseScenario(db, schemaName, env);
    } catch (error) {
      scenarioFailure = error;
    } finally {
      if (db) {
        try {
          await db.$client.end({ timeout: 1 });
        } catch (error) {
          cleanupFailure = error;
        }
      }
      try {
        await dropIsolatedSchema(admin, schemaName);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }

    const after = await safetySnapshot(admin);
    invariant(
      sameFingerprints(before.publicTables, after.publicTables),
      "public related table fingerprints changed",
    );
    invariant(
      before.temporarySchemas === after.temporarySchemas,
      "temporary schema count changed",
    );
    if (cleanupFailure) throw cleanupFailure;
    if (scenarioFailure) throw scenarioFailure;
    invariant(result, "scenario did not produce a result");
    return {
      passed: true,
      assertions: result,
      safety: {
        searchPathPinned: true,
        searchPathMode: "explicit SET LOCAL in every top-level transaction",
        publicTablesFingerprinted: before.publicTables.length,
        publicRowsUnchanged: true,
        temporarySchemaCountUnchanged: true,
        isolatedSchemaDropped: true,
        fixtureDataReturned: false,
      },
    };
  } finally {
    await admin.end({ timeout: 1 });
  }
}
