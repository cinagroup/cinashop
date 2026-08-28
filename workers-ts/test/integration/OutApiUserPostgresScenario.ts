import { and, eq, sql } from "drizzle-orm";
import type { Env } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
  type DbClient,
} from "@/lib/di";
import {
  communityUser,
  outInterface,
  outUserWriteReplay,
  systemUserLevel,
  user,
  userBill,
  userFriends,
  userGroup,
  userLabel,
  userLabelRelation,
  userLevel,
  userMoney,
  userSpread,
  wechatUser,
} from "@/models/schema";
import { MigrationService } from "@/services/MigrationService";
import { OutApiService, type AuthenticatedOutAccount } from "@/services/out/OutApiService";

const PUBLIC_TABLES = [
  "out_interface",
  "user",
  "user_money",
  "user_bill",
  "user_group",
  "user_label",
  "user_label_relation",
  "system_user_level",
  "user_level",
  "user_spread",
  "user_friends",
  "community_user",
  "wechat_user",
] as const;

const SERIAL_KEYS: Record<(typeof PUBLIC_TABLES)[number], string> = {
  out_interface: "id",
  user: "uid",
  user_money: "id",
  user_bill: "id",
  user_group: "id",
  user_label: "id",
  user_label_relation: "id",
  system_user_level: "id",
  user_level: "id",
  user_spread: "id",
  user_friends: "id",
  community_user: "id",
  wechat_user: "id",
};

const PUBLIC_SEQUENCES = Object.entries(SERIAL_KEYS)
  .map(([table, key]) => `${table}_${key}_seq`);

type Fingerprint = {
  tables: Record<string, { count: string; digest: string }>;
  sequences: Record<string, string | null>;
};

export interface OutApiUserPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  user_acl_routes_allowed: boolean;
  unauthorized_route_rejected: boolean;
  create_concurrent_single_user: boolean;
  create_replay_converged: boolean;
  create_key_conflict_rejected: boolean;
  duplicate_phone_rejected: boolean;
  create_side_effects_atomic: boolean;
  password_not_empty_or_plaintext: boolean;
  partial_update_preserved_omitted_fields: boolean;
  profile_relations_and_level_updated: boolean;
  duplicate_phone_update_rejected: boolean;
  spread_cycle_rejected: boolean;
  spread_rebind_atomic: boolean;
  give_concurrent_single_ledgers: boolean;
  give_replay_converged: boolean;
  give_key_conflict_rejected: boolean;
  overdraft_clamped_non_negative: boolean;
  update_finance_failure_rolled_back: boolean;
  replay_ledger_content_free: boolean;
  database_uniqueness_guards_hold: boolean;
  observation: {
    synthetic_users: number;
    replay_rows: number;
    money_ledgers: number;
    integral_ledgers: number;
    spread_history_rows: number;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Out user integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_out_user_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

export async function fingerprintOutUserPublicState(db: DbClient): Promise<Fingerprint> {
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
  const ddl = new MigrationService(createContainerFromDb(db))
    .outUserWriteReplayMigrationSqlForVerification();
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of PUBLIC_TABLES) {
      const tableName = identifier(table);
      await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
      const key = SERIAL_KEYS[table];
      const sequenceName = `${table}_${key}_seq_it`;
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${identifier(sequenceName)}`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${tableName} ALTER COLUMN ${identifier(key)} SET DEFAULT nextval('${schemaName}.${sequenceName}'::regclass)`,
      );
    }
    await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
    await tx.unsafe(ddl);
  });
}

const TEST_ENV = {
  APP_KEY: "out-user-isolated-integration-key",
  CONFIG_KV: {
    async get(key: string) {
      return key === "cfg_h5_avatar" ? "" : "0";
    },
    async put() {},
    async delete() {},
  },
} as unknown as Env;

const IDENTITY: AuthenticatedOutAccount = {
  id: 77,
  appid: "isolated-out-user",
  title: "isolated user audit",
  rules: [950, 951, 952],
};

async function seed(container: Container): Promise<void> {
  await withTx(container, async (tx) => {
    await tx.insert(outInterface).values([
      { id: 950, type: 1, name: "新增用户", method: "POST", url: "/user", isDel: 0 },
      { id: 951, type: 1, name: "更新用户", method: "PUT", url: "/user/{uid}", isDel: 0 },
      { id: 952, type: 1, name: "赠送用户", method: "PUT", url: "/user/give/{uid}", isDel: 0 },
    ]);
    await tx.insert(userGroup).values({ id: 10, groupName: "隔离测试分组" });
    await tx.insert(userLabel).values([
      { id: 20, type: 0, relationId: 0, name: "标签一", status: 1 },
      { id: 21, type: 0, relationId: 0, name: "标签二", status: 1 },
      { id: 22, type: 1, relationId: 9, name: "跨租户标签", status: 1 },
    ]);
    await tx.insert(systemUserLevel).values({
      id: 30,
      name: "隔离等级",
      grade: 2,
      discount: "90.00",
      expNum: 500,
      isForever: 1,
      isDel: 0,
    });
    await tx.insert(user).values([
      {
        uid: 100,
        account: "13800000100",
        phone: "13800000100",
        pwd: "a".repeat(32),
        nickname: "父级一",
        status: 1,
        spreadCount: 1,
        divisionId: 10,
        agentId: 11,
        staffId: 12,
        addTime: 1,
      },
      {
        uid: 101,
        account: "13800000101",
        phone: "13800000101",
        pwd: "b".repeat(32),
        realName: "更新前姓名",
        nickname: "目标用户",
        mark: "preserve-me",
        nowMoney: "10.00",
        integral: 100,
        status: 1,
        spreadUid: 100,
        spreadTime: 1,
        spreadCount: 1,
        divisionId: 10,
        agentId: 11,
        staffId: 12,
        addTime: 1,
      },
      {
        uid: 102,
        account: "13800000102",
        phone: "13800000102",
        pwd: "c".repeat(32),
        nickname: "下级",
        status: 1,
        spreadUid: 101,
        spreadTime: 1,
        addTime: 1,
      },
      {
        uid: 103,
        account: "13800000103",
        phone: "13800000103",
        pwd: "d".repeat(32),
        nickname: "父级二",
        status: 1,
        divisionId: 20,
        agentId: 21,
        staffId: 22,
        addTime: 1,
      },
    ]);
    await tx.insert(wechatUser).values({
      id: 200,
      uid: 101,
      openid: "isolated-openid-101",
      nickname: "目标用户",
      sex: 0,
      addTime: 1,
    });
  });
}

async function rejected(callback: () => Promise<unknown>): Promise<boolean> {
  try {
    await callback();
    return false;
  } catch {
    return true;
  }
}

async function runScenario(container: Container): Promise<Omit<OutApiUserPostgresReport,
  "server_version" | "schema_created" | "schema_removed" | "temporary_schemas_after" | "public_state_unchanged">> {
  const invoke = <T>(callback: (service: OutApiService) => Promise<T>): Promise<T> =>
    withTx(container, async (tx) => callback(new OutApiService(createContainerFromDb(tx), TEST_ENV)));
  const scopedDb = <T>(callback: (tx: DbClient) => Promise<T>): Promise<T> => withTx(container, callback);

  let allowed = 0;
  for (const [method, route] of [
    ["POST", "/user"],
    ["PUT", "/user/{uid}"],
    ["PUT", "/user/give/{uid}"],
  ] as const) {
    await invoke((service) => service.assertInterfacePermission(IDENTITY, method, route));
    allowed++;
  }
  const unauthorizedRouteRejected = await rejected(() => invoke((service) =>
    service.assertInterfacePermission(IDENTITY, "POST", "/coupon")));

  const createKey = "11111111-1111-4111-8111-111111111111";
  const createBody = {
    phone: "13800000104",
    real_name: "隔离新增用户",
    pwd: "safe-password",
    true_pwd: "safe-password",
    label_id: [20],
    group_id: 10,
    level: 30,
    status: 1,
  };
  const created = await Promise.all([
    invoke((service) => service.createUser(IDENTITY, createBody, createKey)),
    invoke((service) => service.createUser(IDENTITY, createBody, createKey)),
  ]);
  const createdUid = created[0].uid;
  const createReplay = await invoke((service) => service.createUser(IDENTITY, createBody, createKey));
  const createConflict = await rejected(() => invoke((service) => service.createUser(
    IDENTITY,
    { ...createBody, real_name: "冲突名称" },
    createKey,
  )));
  const duplicatePhone = await rejected(() => invoke((service) => service.createUser(
    IDENTITY,
    { phone: createBody.phone, real_name: "重复手机号" },
    "12121212-1212-4212-8212-121212121212",
  )));
  const createdRows = await scopedDb((tx) => tx.select().from(user).where(eq(user.phone, createBody.phone)));
  const createdReplayRows = await scopedDb((tx) => tx.select().from(outUserWriteReplay).where(and(
    eq(outUserWriteReplay.operation, "user_create"),
    eq(outUserWriteReplay.requestKey, createKey),
  )));
  const createdCommunities = await scopedDb((tx) => tx.select().from(communityUser)
    .where(and(eq(communityUser.type, 2), eq(communityUser.relationId, createdUid))));
  const createdLabels = await scopedDb((tx) => tx.select().from(userLabelRelation)
    .where(eq(userLabelRelation.uid, createdUid)));
  const createdLevels = await scopedDb((tx) => tx.select().from(userLevel)
    .where(and(eq(userLevel.uid, createdUid), eq(userLevel.status, 1), eq(userLevel.isDel, 0))));

  const partialKey = "22222222-2222-4222-8222-222222222222";
  await invoke((service) => service.updateUser(IDENTITY, 101, { real_name: "只更新姓名" }, partialKey));
  const afterPartial = (await scopedDb((tx) => tx.select().from(user).where(eq(user.uid, 101)).limit(1)))[0];

  const profileKey = "33333333-3333-4333-8333-333333333333";
  await invoke((service) => service.updateUser(IDENTITY, 101, {
    phone: "13800000111",
    label_id: [20, 21],
    group_id: 10,
    level: 30,
    sex: 2,
    addres: "隔离地址",
  }, profileKey));
  const profileState = (await scopedDb((tx) => tx.select().from(user).where(eq(user.uid, 101)).limit(1)))[0];
  const profileLabels = await scopedDb((tx) => tx.select().from(userLabelRelation)
    .where(and(eq(userLabelRelation.uid, 101), eq(userLabelRelation.type, 0), eq(userLabelRelation.relationId, 0))));
  const profileLevel = await scopedDb((tx) => tx.select().from(userLevel)
    .where(and(eq(userLevel.uid, 101), eq(userLevel.status, 1), eq(userLevel.isDel, 0))));
  const profileWechat = (await scopedDb((tx) => tx.select().from(wechatUser)
    .where(eq(wechatUser.uid, 101)).limit(1)))[0];
  const duplicatePhoneUpdate = await rejected(() => invoke((service) => service.updateUser(
    IDENTITY,
    101,
    { phone: "13800000100" },
    "34343434-3434-4434-8434-343434343434",
  )));

  const spreadCycle = await rejected(() => invoke((service) => service.updateUser(
    IDENTITY,
    101,
    { spread_uid: 102 },
    "44444444-4444-4444-8444-444444444444",
  )));
  await invoke((service) => service.updateUser(
    IDENTITY,
    101,
    { spread_uid: 0 },
    "45454545-4545-4545-8545-454545454545",
  ));
  await invoke((service) => service.updateUser(
    IDENTITY,
    101,
    { spread_uid: 103 },
    "46464646-4646-4646-8646-464646464646",
  ));
  const spreadUsers = await scopedDb((tx) => tx.select({
    uid: user.uid,
    spreadUid: user.spreadUid,
    spreadCount: user.spreadCount,
    divisionId: user.divisionId,
    agentId: user.agentId,
    staffId: user.staffId,
  }).from(user).where(sql`${user.uid} IN (100, 101, 103)`).orderBy(user.uid));
  const spreadHistory = await scopedDb((tx) => tx.select().from(userSpread)
    .where(and(eq(userSpread.uid, 101), eq(userSpread.spreadUid, 103))));
  const friendships = await scopedDb((tx) => tx.select().from(userFriends)
    .where(and(eq(userFriends.uid, 101), eq(userFriends.friendsUid, 103))));

  const giveKey = "55555555-5555-4555-8555-555555555555";
  const giveBody = {
    money_status: 1,
    money: "2.50",
    integration_status: 1,
    integration: 50,
  };
  const given = await Promise.all([
    invoke((service) => service.giveUser(IDENTITY, 101, giveBody, giveKey)),
    invoke((service) => service.giveUser(IDENTITY, 101, giveBody, giveKey)),
  ]);
  const giveReplay = await invoke((service) => service.giveUser(IDENTITY, 101, giveBody, giveKey));
  const giveConflict = await rejected(() => invoke((service) => service.giveUser(
    IDENTITY,
    101,
    { ...giveBody, money: "3.00" },
    giveKey,
  )));
  const giveLinkId = giveKey.replaceAll("-", "");
  const afterGive = (await scopedDb((tx) => tx.select().from(user).where(eq(user.uid, 101)).limit(1)))[0];
  const giveMoney = await scopedDb((tx) => tx.select().from(userMoney)
    .where(and(eq(userMoney.uid, 101), eq(userMoney.linkId, giveLinkId))));
  const giveIntegral = await scopedDb((tx) => tx.select().from(userBill)
    .where(and(eq(userBill.uid, 101), eq(userBill.linkId, giveLinkId))));

  const subtractKey = "66666666-6666-4666-8666-666666666666";
  const subtract = await invoke((service) => service.giveUser(IDENTITY, 101, {
    money_status: 2,
    money: "999.00",
    integration_status: 2,
    integration: 999,
  }, subtractKey));
  const afterSubtract = (await scopedDb((tx) => tx.select().from(user).where(eq(user.uid, 101)).limit(1)))[0];
  const subtractMoney = (await scopedDb((tx) => tx.select().from(userMoney)
    .where(eq(userMoney.id, subtract.money_ledger_id)).limit(1)))[0];
  const subtractIntegral = (await scopedDb((tx) => tx.select().from(userBill)
    .where(eq(userBill.id, subtract.integral_ledger_id)).limit(1)))[0];

  const rollbackKey = "77777777-7777-4777-8777-777777777777";
  await scopedDb((tx) => tx.execute(sql.raw(
    'ALTER TABLE "user_money" ADD CONSTRAINT "out_user_finance_failure_probe" '
      + "CHECK (type <> 'system_add') NOT VALID",
  )));
  const rollbackRejected = await rejected(() => invoke((service) => service.updateUser(
    IDENTITY,
    101,
    {
      real_name: "必须回滚",
      money_status: 1,
      money: "1.00",
      integration_status: 0,
      integration: 0,
    },
    rollbackKey,
  )));
  await scopedDb((tx) => tx.execute(sql.raw(
    'ALTER TABLE "user_money" DROP CONSTRAINT "out_user_finance_failure_probe"',
  )));
  const afterRollback = (await scopedDb((tx) => tx.select().from(user).where(eq(user.uid, 101)).limit(1)))[0];
  const rollbackReplay = await scopedDb((tx) => tx.select().from(outUserWriteReplay)
    .where(eq(outUserWriteReplay.requestKey, rollbackKey)));

  const replayRows = await scopedDb((tx) => tx.select().from(outUserWriteReplay));
  const replayColumns = await scopedDb(async (tx) => {
    const rows = await tx.execute<{ column_name: string }>(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'out_user_write_replay'
      ORDER BY ordinal_position
    `);
    return [...rows].map((row) => row.column_name);
  });
  const duplicatePhones = await scopedDb((tx) => tx.execute<{ count: number }>(sql`
    SELECT count(*)::integer AS count FROM (
      SELECT phone FROM "user"
      WHERE is_del = 0 AND delete_time IS NULL AND phone <> ''
      GROUP BY phone HAVING count(*) > 1
    ) duplicates
  `));
  const duplicateMoneyEvidence = await scopedDb((tx) => tx.execute<{ count: number }>(sql`
    SELECT count(*)::integer AS count FROM (
      SELECT uid, link_id, type FROM user_money
      WHERE link_id ~ '^[0-9a-f]{32}$' AND type IN ('system_add', 'system_sub')
      GROUP BY uid, link_id, type HAVING count(*) > 1
    ) duplicates
  `));
  const duplicateIntegralEvidence = await scopedDb((tx) => tx.execute<{ count: number }>(sql`
    SELECT count(*)::integer AS count FROM (
      SELECT uid, link_id, event_key FROM user_bill
      WHERE link_id ~ '^[0-9a-f]{32}$'
        AND event_key IN ('out_system_add_integral', 'out_system_sub_integral')
      GROUP BY uid, link_id, event_key HAVING count(*) > 1
    ) duplicates
  `));
  const allMoney = await scopedDb((tx) => tx.select().from(userMoney));
  const allIntegral = await scopedDb((tx) => tx.select().from(userBill));
  const allUsers = await scopedDb((tx) => tx.select({ uid: user.uid }).from(user));

  const createConcurrentSingleUser = created[0].uid === created[1].uid
    && createdRows.length === 1 && createdReplayRows.length === 1;
  const createReplayConverged = createReplay.idempotent === true && createReplay.uid === createdUid;
  const createSideEffectsAtomic = createdCommunities.length === 1
    && createdLabels.length === 1 && createdLevels.length === 1
    && createdRows[0]?.isFirstOrder === -1 && createdRows[0]?.isNewcomer === -1;
  const passwordSafe = Boolean(createdRows[0]
    && createdRows[0].pwd.length === 32
    && createdRows[0].pwd !== createBody.pwd
    && createdRows[0].pwd !== "");
  const partialPreserved = afterPartial?.realName === "只更新姓名"
    && afterPartial.phone === "13800000101" && afterPartial.mark === "preserve-me";
  const profileUpdated = profileState?.phone === "13800000111"
    && profileState.account === "13800000111" && profileState.groupId === 10
    && profileState.level === 30 && profileState.addres === "隔离地址"
    && profileLabels.map((row) => row.labelId).sort().join(",") === "20,21"
    && profileLevel.length === 1 && profileWechat?.sex === 2;
  const spreadRebound = spreadUsers.length === 3
    && spreadUsers[0].spreadCount === 0
    && spreadUsers[1].spreadUid === 103
    && spreadUsers[1].divisionId === 20
    && spreadUsers[1].agentId === 21
    && spreadUsers[1].staffId === 22
    && spreadUsers[2].spreadCount === 1
    && spreadHistory.length === 1 && friendships.length === 1;
  const giveSingle = given[0].uid === given[1].uid
    && [given[0].idempotent, given[1].idempotent].filter(Boolean).length === 1
    && giveMoney.length === 1 && giveIntegral.length === 1
    && afterGive?.nowMoney === "12.50" && afterGive.integral === 150;
  const overdraftClamped = afterSubtract?.nowMoney === "0.00" && afterSubtract.integral === 0
    && subtractMoney?.number === "12.50" && subtractMoney.balance === "0.00"
    && subtractIntegral?.number === "150.00" && subtractIntegral.balance === "0.00";
  const rollbackAtomic = rollbackRejected && afterRollback?.realName === "只更新姓名"
    && afterRollback.nowMoney === "0.00" && rollbackReplay.length === 0;
  const contentFreeColumns = replayColumns.join(",") === [
    "id",
    "out_account_id",
    "operation",
    "request_key",
    "request_hash",
    "user_id",
    "money_ledger_id",
    "integral_ledger_id",
    "add_time",
  ].join(",") && !JSON.stringify(replayRows).includes("1380000")
    && !JSON.stringify(replayRows).includes("隔离");
  const uniquenessHolds = Number(duplicatePhones[0]?.count ?? -1) === 0
    && Number(duplicateMoneyEvidence[0]?.count ?? -1) === 0
    && Number(duplicateIntegralEvidence[0]?.count ?? -1) === 0;

  for (const [value, label] of [
    [allowed === 3, "ACL routes"],
    [unauthorizedRouteRejected, "unauthorized route"],
    [createConcurrentSingleUser, "concurrent create"],
    [createReplayConverged, "create replay"],
    [createConflict, "create key conflict"],
    [duplicatePhone, "duplicate phone"],
    [createSideEffectsAtomic, "create side effects"],
    [passwordSafe, "password storage"],
    [partialPreserved, "partial update"],
    [profileUpdated, "profile relations"],
    [duplicatePhoneUpdate, "duplicate phone update"],
    [spreadCycle, "spread cycle"],
    [spreadRebound, "spread rebind"],
    [giveSingle, "concurrent give"],
    [giveReplay.idempotent === true, "give replay"],
    [giveConflict, "give key conflict"],
    [overdraftClamped, "overdraft clamp"],
    [rollbackAtomic, "finance rollback"],
    [contentFreeColumns, "content-free replay"],
    [uniquenessHolds, "database uniqueness"],
  ] as const) assertCondition(value, label);

  return {
    user_acl_routes_allowed: allowed === 3,
    unauthorized_route_rejected: unauthorizedRouteRejected,
    create_concurrent_single_user: createConcurrentSingleUser,
    create_replay_converged: createReplayConverged,
    create_key_conflict_rejected: createConflict,
    duplicate_phone_rejected: duplicatePhone,
    create_side_effects_atomic: createSideEffectsAtomic,
    password_not_empty_or_plaintext: passwordSafe,
    partial_update_preserved_omitted_fields: partialPreserved,
    profile_relations_and_level_updated: profileUpdated,
    duplicate_phone_update_rejected: duplicatePhoneUpdate,
    spread_cycle_rejected: spreadCycle,
    spread_rebind_atomic: spreadRebound,
    give_concurrent_single_ledgers: giveSingle,
    give_replay_converged: giveReplay.idempotent === true,
    give_key_conflict_rejected: giveConflict,
    overdraft_clamped_non_negative: overdraftClamped,
    update_finance_failure_rolled_back: rollbackAtomic,
    replay_ledger_content_free: contentFreeColumns,
    database_uniqueness_guards_hold: uniquenessHolds,
    observation: {
      synthetic_users: allUsers.length,
      replay_rows: replayRows.length,
      money_ledgers: allMoney.length,
      integral_ledgers: allIntegral.length,
      spread_history_rows: spreadHistory.length,
    },
  };
}

export async function runOutApiUserPostgresScenario(
  connectionString: string,
): Promise<OutApiUserPostgresReport> {
  const schemaName = makeSchemaName();
  const publicDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_user_public_fingerprint",
  });
  const before = await fingerprintOutUserPublicState(publicDb);
  await setupSchema(publicDb, schemaName);
  const versionRows = await publicDb.$client<Array<{ server_version: string }>>`
    SELECT current_setting('server_version') AS server_version
  `;
  await publicDb.$client.end({ timeout: 1 });

  let scenario: Awaited<ReturnType<typeof runScenario>> | undefined;
  let scenarioError: unknown;
  const scoped = createDbFromConnectionString(connectionString, 4, {
    searchPath: schemaName,
    applicationName: "cinashop_out_user_isolated_scenario",
  });
  try {
    const container = createContainerFromDb(scoped);
    await seed(container);
    scenario = await runScenario(container);
  } catch (error) {
    scenarioError = error;
  } finally {
    await scoped.$client.end({ timeout: 1 });
  }

  const cleanupDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_user_schema_cleanup",
  });
  let schemaRemoved = false;
  let after: Fingerprint;
  let temporarySchemasAfter = -1;
  try {
    await cleanupDb.$client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx.unsafe(`DROP SCHEMA ${identifier(schemaName)} CASCADE`);
    });
    schemaRemoved = true;
    after = await fingerprintOutUserPublicState(cleanupDb);
    const temporary = await cleanupDb.$client<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM pg_namespace WHERE nspname LIKE 'codex_out_user_%'
    `;
    temporarySchemasAfter = Number(temporary[0]?.count ?? -1);
  } finally {
    await cleanupDb.$client.end({ timeout: 1 });
  }
  if (scenarioError) throw scenarioError;
  assertCondition(scenario, "scenario did not complete");
  const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after!);
  assertCondition(schemaRemoved, "schema cleanup");
  assertCondition(temporarySchemasAfter === 0, "temporary schema cleanup");
  assertCondition(publicStateUnchanged, "public state changed");
  return {
    server_version: versionRows[0]?.server_version ?? "unknown",
    schema_created: true,
    schema_removed: schemaRemoved,
    temporary_schemas_after: temporarySchemasAfter,
    public_state_unchanged: publicStateUnchanged,
    ...scenario,
  };
}
