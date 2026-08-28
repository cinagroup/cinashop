import { asc, eq, sql } from "drizzle-orm";
import type { Env } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
  type DbClient,
} from "@/lib/di";
import {
  luckLottery,
  luckPrize,
  outCouponWriteReplay,
  outInterface,
  storeCouponIssue,
  storeCouponIssueUser,
  storeCouponProduct,
  storeCouponUser,
  storeProduct,
  storeProductCategory,
  storeProductCoupon,
  storePromotions,
  systemConfig,
} from "@/models/schema";
import { MigrationService } from "@/services/MigrationService";
import { OutApiService, type AuthenticatedOutAccount } from "@/services/out/OutApiService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const PUBLIC_TABLES = [
  "out_interface",
  "store_coupon_issue",
  "store_coupon_user",
  "store_coupon_issue_user",
  "store_coupon_product",
  "store_product_coupon",
  "store_product",
  "store_product_category",
  "store_brand",
  "luck_lottery",
  "luck_prize",
  "store_promotions",
  "store_promotions_auxiliary",
  "system_config",
] as const;

const SERIAL_KEYS: Partial<Record<(typeof PUBLIC_TABLES)[number], string>> = {
  out_interface: "id",
  store_coupon_issue: "id",
  store_coupon_user: "id",
  store_product_coupon: "id",
  store_product: "id",
  store_product_category: "id",
  store_brand: "id",
  luck_lottery: "id",
  luck_prize: "id",
  store_promotions: "id",
  store_promotions_auxiliary: "id",
  system_config: "id",
};

const PUBLIC_SEQUENCES = Object.entries(SERIAL_KEYS).map(([table, key]) => `${table}_${key}_seq`);

type Fingerprint = {
  tables: Record<string, { count: string; digest: string }>;
  sequences: Record<string, string | null>;
};

export interface OutApiCouponPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  coupon_acl_routes_allowed: boolean;
  create_concurrent_single_coupon: boolean;
  create_replay_converged: boolean;
  create_key_conflict_rejected: boolean;
  cross_tenant_scope_rejected: boolean;
  strict_contract_rejections_passed: boolean;
  php_column_mapping_preserved: boolean;
  status_concurrent_and_replayed: boolean;
  invalid_enable_rejected: boolean;
  list_contract_and_send_filter_restored: boolean;
  active_product_grant_delete_blocked: boolean;
  active_lottery_delete_blocked: boolean;
  active_promotion_delete_blocked: boolean;
  active_newcomer_delete_blocked: boolean;
  delete_preserved_issued_scope: boolean;
  delete_replay_converged: boolean;
  delete_rollback_atomic: boolean;
  replay_ledger_content_free: boolean;
  replay_observation: {
    coupon_ids: number[];
    replay_rows: number;
    preserved_scope_rows: number;
    issued_rows: number;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Out coupon integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_out_coupon_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

export async function fingerprintOutCouponPublicState(db: DbClient): Promise<Fingerprint> {
  const tables: Fingerprint["tables"] = {};
  for (const table of PUBLIC_TABLES) {
    const rows = await db.$client.unsafe<Array<{ count: string; digest: string }>>(
      `SELECT count(*)::text AS count,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest
       FROM public.${identifier(table)} t`,
    );
    assertCondition(rows[0], `could not fingerprint public.${table}`);
    tables[table] = rows[0];
  }
  const sequenceRows = await db.$client<Array<{ sequencename: string; last_value: string | null }>>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = ANY(${PUBLIC_SEQUENCES})
    ORDER BY sequencename
  `;
  const map = new Map(sequenceRows.map((row) => [row.sequencename, row.last_value]));
  return {
    tables,
    sequences: Object.fromEntries(PUBLIC_SEQUENCES.map((name) => [name, map.get(name) ?? null])),
  };
}

async function setupSchema(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  const replaySql = new MigrationService(createContainerFromDb(db))
    .outCouponWriteReplayMigrationSqlForVerification();
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of PUBLIC_TABLES) {
      const tableName = identifier(table);
      await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
      const key = SERIAL_KEYS[table];
      if (!key) continue;
      const sequenceName = `${table}_${key}_seq_it`;
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${identifier(sequenceName)}`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${tableName} ALTER COLUMN ${identifier(key)} SET DEFAULT nextval('${schemaName}.${sequenceName}'::regclass)`,
      );
    }
    await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
    await tx.unsafe(replaySql);
  });
}

async function seed(container: Container): Promise<void> {
  await withTx(container, async (tx) => {
    await tx.insert(outInterface).values([
      { id: 900, type: 1, name: "新增优惠券", method: "POST", url: "/outapi/coupon", isDel: 0 },
      { id: 901, type: 1, name: "修改优惠券状态", method: "PUT", url: "/coupon/status/:id/:status", isDel: 0 },
      { id: 902, type: 1, name: "删除优惠券", method: "DELETE", url: "/coupon/<id>", isDel: 0 },
    ]);
    await tx.insert(storeProductCategory).values({
      id: 100,
      pid: 0,
      type: 0,
      relationId: 0,
      cateName: "平台分类",
      path: "",
      level: 0,
      isShow: 1,
      addTime: 1,
    });
    await tx.insert(storeProduct).values({
      id: 200,
      type: 0,
      relationId: 0,
      productType: 0,
      storeName: "平台实物商品",
      image: "/product.png",
      sliderImage: "[\"/product.png\"]",
      price: "50.00",
      stock: 10,
      isShow: 1,
      isVerify: 1,
      isDel: 0,
      addTime: 1,
    });
    await tx.insert(storeCouponIssue).values([
      {
        id: 300,
        couponType: 2,
        couponTitle: "已发行商品券",
        title: "已发行商品券",
        type: 1,
        couponPrice: "5.00",
        useMinPrice: "20.00",
        productId: "200",
        legacyProductIds: "200",
        totalCount: 10,
        remainCount: 9,
        receiveLimit: 1,
        receiveType: 1,
        day: 0,
        isPermanent: 0,
        useStartTime: new Date("2029-01-01T00:00:00.000Z"),
        useEndTime: new Date("2030-01-01T00:00:00.000Z"),
        status: 1,
        addTime: 1,
      },
      {
        id: 301,
        couponType: 0,
        couponTitle: "过期关闭券",
        title: "过期关闭券",
        type: 1,
        couponPrice: "5.00",
        useMinPrice: "20.00",
        totalCount: 10,
        remainCount: 10,
        receiveType: 1,
        day: 0,
        isPermanent: 0,
        useStartTime: new Date("2020-01-01T00:00:00.000Z"),
        useEndTime: new Date("2021-01-01T00:00:00.000Z"),
        status: 0,
        addTime: 1,
      },
      {
        id: 302,
        couponType: 0,
        couponTitle: "活动引用券",
        title: "活动引用券",
        type: 1,
        couponPrice: "5.00",
        useMinPrice: "20.00",
        totalCount: 0,
        remainCount: 0,
        receiveType: 3,
        day: 30,
        isPermanent: 1,
        status: 1,
        addTime: 1,
      },
    ]);
    await tx.insert(storeCouponProduct).values({ couponId: 300, productId: 200 });
    await tx.insert(storeCouponUser).values({
      id: 400,
      uid: 1,
      issueCouponId: 300,
      couponTitle: "已发行商品券",
      couponPrice: "5.00",
      useMinPrice: "20.00",
      status: 1,
      startTime: new Date("2029-01-01T00:00:00.000Z"),
      endTime: new Date("2030-01-01T00:00:00.000Z"),
      type: 1,
      receiveTime: 1,
      receiveSource: "get",
    });
    await tx.insert(storeCouponIssueUser).values({ uid: 1, issueCouponId: 300, addTime: 1 });
  });
}

const IDENTITY: AuthenticatedOutAccount = {
  id: 7,
  appid: "out-coupon-audit",
  title: "Out coupon audit",
  rules: [900, 901, 902],
};
const TEST_ENV = {} as Env;

function fixedCoupon(overrides: Record<string, unknown> = {}) {
  return {
    coupon_title: "Out 平台商品券",
    coupon_price: "10.00",
    use_min_price: "50.00",
    coupon_time: 0,
    start_use_time: "2029-01-01 00:00:00",
    end_use_time: "2030-01-01 00:00:00",
    start_time: "2028-01-01 00:00:00",
    end_time: "2028-12-31 23:59:59",
    receive_type: 1,
    is_permanent: 0,
    total_count: 100,
    product_id: [200],
    category_id: [],
    type: 2,
    sort: 5,
    status: 0,
    coupon_type: 1,
    ...overrides,
  };
}

function giftCoupon(overrides: Record<string, unknown> = {}) {
  return {
    coupon_title: "Out 赠送折扣券",
    coupon_price: "85.00",
    use_min_price: "0.00",
    coupon_time: 30,
    receive_type: 3,
    is_permanent: 0,
    total_count: 999,
    product_id: "",
    category_id: [],
    type: 0,
    sort: 6,
    status: 1,
    coupon_type: 2,
    ...overrides,
  };
}

async function rejected(callback: () => Promise<unknown>, kind = ValidateException): Promise<boolean> {
  try {
    await callback();
    return false;
  } catch (error) {
    return error instanceof kind;
  }
}

async function rejectedByDatabase(callback: () => Promise<unknown>): Promise<boolean> {
  try {
    await callback();
    return false;
  } catch (error) {
    return error instanceof Error && !(error instanceof ValidateException) && !(error instanceof NotFoundException);
  }
}

async function runScenario(container: Container) {
  const invoke = <T>(callback: (service: OutApiService) => Promise<T>): Promise<T> =>
    callback(new OutApiService(container, TEST_ENV));
  const invokeRead = <T>(callback: (service: OutApiService) => Promise<T>): Promise<T> =>
    withTx(container, async (tx) => callback(new OutApiService(createContainerFromDb(tx), TEST_ENV)));
  const scopedDb = <T>(callback: (tx: DbClient) => Promise<T>): Promise<T> => withTx(container, callback);

  let allowed = 0;
  for (const [method, route] of [
    ["POST", "/coupon"],
    ["PUT", "/coupon/status/{id}/{status}"],
    ["DELETE", "/coupon/{id}"],
  ] as const) {
    await invokeRead((service) => service.assertInterfacePermission(IDENTITY, method, route));
    allowed++;
  }

  const createKey = "11111111-1111-4111-8111-111111111111";
  const concurrent = await Promise.all([
    invoke((service) => service.createCoupon(IDENTITY, fixedCoupon(), createKey)),
    invoke((service) => service.createCoupon(IDENTITY, fixedCoupon(), createKey)),
  ]);
  const couponId = concurrent[0].id;
  const createReplay = await invoke((service) => service.createCoupon(IDENTITY, fixedCoupon(), createKey));
  const createConflict = await rejected(() => invoke((service) => service.createCoupon(
    IDENTITY,
    fixedCoupon({ coupon_title: "冲突标题" }),
    createKey,
  )));
  const crossTenant = await rejected(() => invoke((service) => service.createCoupon(
    IDENTITY,
    fixedCoupon({ product_id: [999] }),
    "22222222-2222-4222-8222-222222222222",
  )), NotFoundException);
  const strictRejected = (await rejected(() => invoke((service) => service.createCoupon(
    IDENTITY,
    fixedCoupon({ coupon_type: 2, coupon_price: "100.01" }),
    "33333333-3333-4333-8333-333333333333",
  )))) && (await rejected(() => invoke((service) => service.createCoupon(
    IDENTITY,
    fixedCoupon({ end_use_time: 0 }),
    "44444444-4444-4444-8444-444444444444",
  )))) && (await rejected(() => invoke((service) => service.createCoupon(
    IDENTITY,
    fixedCoupon({ brand_id: 8 }),
    "55555555-5555-4555-8555-555555555555",
  ))));

  const gift = await invoke((service) => service.createCoupon(
    IDENTITY,
    giftCoupon(),
    "66666666-6666-4666-8666-666666666666",
  ));
  const createdState = await scopedDb((tx) => tx.select().from(storeCouponIssue)
    .where(eq(storeCouponIssue.id, couponId)).limit(1));
  const giftState = await scopedDb((tx) => tx.select().from(storeCouponIssue)
    .where(eq(storeCouponIssue.id, gift.id)).limit(1));
  const createdScope = await scopedDb((tx) => tx.select().from(storeCouponProduct)
    .where(eq(storeCouponProduct.couponId, couponId)));

  const statusKey = "77777777-7777-4777-8777-777777777777";
  const statusConcurrent = await Promise.all([
    invoke((service) => service.setCouponStatus(IDENTITY, couponId, 1, statusKey)),
    invoke((service) => service.setCouponStatus(IDENTITY, couponId, 1, statusKey)),
  ]);
  const statusReplay = await invoke((service) => service.setCouponStatus(IDENTITY, couponId, 1, statusKey));
  const invalidEnable = await rejected(() => invoke((service) => service.setCouponStatus(
    IDENTITY,
    301,
    1,
    "88888888-8888-4888-8888-888888888888",
  )));

  const list = await invokeRead((service) => service.couponList({
    coupon_type: "2",
    type: "send",
    limit: "20",
  }));
  const giftListRow = list.list
    .map((row) => row as Record<string, unknown>)
    .find((row) => row.id === gift.id);

  const conflictKey = "99999999-9999-4999-8999-999999999999";
  await scopedDb((tx) => tx.insert(storeProductCoupon)
    .values({ productId: 200, issueCouponId: 302, addTime: 1 }));
  const productConflict = await rejected(() => invoke((service) => service.deleteCoupon(IDENTITY, 302, conflictKey)));
  await scopedDb((tx) => tx.delete(storeProductCoupon).where(eq(storeProductCoupon.issueCouponId, 302)));

  await scopedDb(async (tx) => {
    await tx.insert(luckLottery).values({
      id: 500,
      name: "优惠券抽奖",
      status: 1,
      isDel: 0,
      startTime: 1,
      endTime: 2_000_000_000,
      addTime: 1,
    });
    await tx.insert(luckPrize).values({
      id: 501,
      lotteryId: 500,
      type: 5,
      name: "优惠券",
      couponId: 302,
      status: 1,
      isDel: 0,
      addTime: 1,
    });
  });
  const lotteryConflict = await rejected(() => invoke((service) => service.deleteCoupon(IDENTITY, 302, conflictKey)));
  await scopedDb((tx) => tx.update(luckPrize).set({ isDel: 1 }).where(eq(luckPrize.id, 501)));

  await scopedDb((tx) => tx.insert(storePromotions).values({
    id: 600,
    name: "赠券促销",
    giveCouponId: "1,302,9",
    status: 1,
    isDel: 0,
    startTime: 1,
    stopTime: 2_000_000_000,
    addTime: 1,
  }));
  const promotionConflict = await rejected(() => invoke((service) => service.deleteCoupon(IDENTITY, 302, conflictKey)));
  await scopedDb((tx) => tx.update(storePromotions).set({ isDel: 1 })
    .where(eq(storePromotions.id, 600)));

  await scopedDb((tx) => tx.insert(systemConfig).values([
    { isStore: 0, menuName: "newcomer_status", value: "1", status: 1 },
    { isStore: 0, menuName: "register_coupon_status", value: "1", status: 1 },
    { isStore: 0, menuName: "register_give_coupon", value: "[302]", status: 1 },
  ]));
  const newcomerConflict = await rejected(() => invoke((service) => service.deleteCoupon(IDENTITY, 302, conflictKey)));
  await scopedDb((tx) => tx.update(systemConfig).set({ value: "0" })
    .where(eq(systemConfig.menuName, "register_coupon_status")));
  await invoke((service) => service.deleteCoupon(IDENTITY, 302, conflictKey));

  await scopedDb(async (tx) => {
    await tx.insert(storeCouponUser).values({
      uid: 2,
      issueCouponId: couponId,
      couponTitle: "Out 平台商品券",
      couponPrice: "10.00",
      useMinPrice: "50.00",
      status: 0,
      startTime: new Date("2029-01-01T00:00:00.000Z"),
      endTime: new Date("2030-01-01T00:00:00.000Z"),
      type: 1,
      receiveTime: 1,
      receiveSource: "get",
    });
    await tx.insert(storeCouponIssueUser).values({ uid: 2, issueCouponId: couponId, addTime: 1 });
  });
  const deleteKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const deleted = await invoke((service) => service.deleteCoupon(IDENTITY, couponId, deleteKey));
  const deleteReplay = await invoke((service) => service.deleteCoupon(IDENTITY, couponId, deleteKey));
  const deletedIssue = await scopedDb((tx) => tx.select().from(storeCouponIssue)
    .where(eq(storeCouponIssue.id, couponId)).limit(1));
  const preservedScope = await scopedDb((tx) => tx.select().from(storeCouponProduct)
    .where(eq(storeCouponProduct.couponId, couponId)));
  const preservedUsers = await scopedDb((tx) => tx.select().from(storeCouponUser)
    .where(eq(storeCouponUser.issueCouponId, couponId)));

  await scopedDb((tx) => tx.execute(sql.raw(
    'ALTER TABLE "out_coupon_write_replay" ADD CONSTRAINT "out_coupon_replay_failure_probe" '
      + 'CHECK ("request_key" <> \'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\') NOT VALID',
  )));
  const rollbackRejected = await rejectedByDatabase(() => invoke((service) => service.deleteCoupon(
    IDENTITY,
    gift.id,
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  )));
  await scopedDb((tx) => tx.execute(sql.raw(
    'ALTER TABLE "out_coupon_write_replay" DROP CONSTRAINT "out_coupon_replay_failure_probe"',
  )));
  const rollbackIssue = await scopedDb((tx) => tx.select().from(storeCouponIssue)
    .where(eq(storeCouponIssue.id, gift.id)).limit(1));
  const failedReplay = await scopedDb((tx) => tx.select().from(outCouponWriteReplay)
    .where(eq(outCouponWriteReplay.requestKey, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")));

  const ledger = await scopedDb((tx) => tx.select().from(outCouponWriteReplay)
    .orderBy(asc(outCouponWriteReplay.id)));
  const serializedLedger = JSON.stringify(ledger);

  return {
    coupon_acl_routes_allowed: allowed === 3,
    create_concurrent_single_coupon: concurrent[0].id === concurrent[1].id
      && concurrent.filter((row) => row.idempotent).length === 1,
    create_replay_converged: createReplay.id === couponId && createReplay.idempotent,
    create_key_conflict_rejected: createConflict,
    cross_tenant_scope_rejected: crossTenant,
    strict_contract_rejections_passed: strictRejected,
    php_column_mapping_preserved: createdState[0]?.couponType === 2
      && createdState[0]?.type === 1 && createdState[0]?.legacyProductIds === "200"
      && createdScope.length === 1 && createdScope[0]?.productId === 200
      && giftState[0]?.couponType === 0 && giftState[0]?.type === 2
      && giftState[0]?.couponPrice === "85.00" && giftState[0]?.isPermanent === 1
      && giftState[0]?.totalCount === 0 && giftState[0]?.remainCount === 0,
    status_concurrent_and_replayed: statusConcurrent.filter((row) => row.idempotent).length === 1
      && statusConcurrent.every((row) => row.status === 1) && statusReplay.idempotent,
    invalid_enable_rejected: invalidEnable,
    list_contract_and_send_filter_restored: list.count === 1 && giftListRow?.type === 0
      && giftListRow?.coupon_type === 2 && giftListRow?.coupon_time === "30天"
      && giftListRow?.start_use_time === 0 && giftListRow?.end_use_time === 0
      && !("legacy_product_ids" in giftListRow)
      && !("use_start_time" in giftListRow),
    active_product_grant_delete_blocked: productConflict,
    active_lottery_delete_blocked: lotteryConflict,
    active_promotion_delete_blocked: promotionConflict,
    active_newcomer_delete_blocked: newcomerConflict,
    delete_preserved_issued_scope: !deleted.idempotent && deleted.status === -1
      && deleted.preserved_usage.issued_rows === 1 && deleted.preserved_usage.used_rows === 0
      && deletedIssue[0]?.isDel === 1 && deletedIssue[0]?.status === -1
      && preservedScope.length === 1 && preservedUsers.length === 1,
    delete_replay_converged: deleteReplay.idempotent && deleteReplay.status === -1
      && deleteReplay.preserved_usage.issued_rows === 1,
    delete_rollback_atomic: rollbackRejected && rollbackIssue[0]?.isDel === 0
      && rollbackIssue[0]?.status === 1 && failedReplay.length === 0,
    replay_ledger_content_free: ledger.length === 5
      && ledger.every((row) => /^[0-9a-f]{64}$/.test(row.requestHash))
      && !serializedLedger.includes("Out 平台商品券")
      && !serializedLedger.includes("85.00"),
    replay_observation: {
      coupon_ids: [couponId, gift.id],
      replay_rows: ledger.length,
      preserved_scope_rows: preservedScope.length,
      issued_rows: preservedUsers.length,
    },
  };
}

export async function runOutApiCouponPostgresScenario(
  connectionString: string,
): Promise<OutApiCouponPostgresReport> {
  const schemaName = makeSchemaName();
  const schema = identifier(schemaName);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_coupon_root",
  });
  const scoped = createDbFromConnectionString(connectionString, 4, {
    searchPath: schemaName,
    applicationName: "cinashop_out_coupon_scenario",
  });
  let created = false;
  let removed = false;
  let prefixCount = -1;
  let before: Fingerprint | undefined;
  let after: Fingerprint | undefined;
  let result: Awaited<ReturnType<typeof runScenario>> | undefined;
  let serverVersion = "unknown";
  try {
    const versions = await root.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    serverVersion = versions[0]?.server_version ?? "unknown";
    before = await fingerprintOutCouponPublicState(root);
    await setupSchema(root, schemaName);
    created = true;
    const scopedContainer = createContainerFromDb(scoped);
    await seed(scopedContainer);
    result = await runScenario(scopedContainer);
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
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_out_coupon_%') AS prefix_count
      `;
      removed = state[0]?.schema_removed === true;
      prefixCount = state[0]?.prefix_count ?? -1;
      after = await fingerprintOutCouponPublicState(root);
    } finally {
      await Promise.all([root.$client.end({ timeout: 1 }), scoped.$client.end({ timeout: 1 })]);
    }
  }

  assertCondition(result, "scenario report was not produced");
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  for (const [name, passed] of Object.entries(result)) {
    if (name === "replay_observation") continue;
    assertCondition(passed, `${name} did not pass; replay=${JSON.stringify(result.replay_observation)}`);
  }
  assertCondition(removed && prefixCount === 0, "temporary schema cleanup failed");
  assertCondition(unchanged, "public coupon/activity tables or sequences changed");
  return {
    server_version: serverVersion,
    schema_created: created,
    schema_removed: removed,
    temporary_schemas_after: prefixCount,
    public_state_unchanged: unchanged,
    ...result,
  };
}
