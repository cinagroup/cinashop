import { and, eq, sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
  type DbClient,
} from "@/lib/di";
import {
  community,
  communityRelevance,
  communityUser,
  systemConfig,
  systemUserLevel,
  user,
  userFriends,
} from "@/models/schema";
import { CommunitySocialService } from "@/services/community/CommunitySocialService";
import { ValidateException } from "@/utils/errors";

const CLONED_TABLES = [
  "user",
  "community_user",
  "community_relevance",
  "community",
  "user_friends",
  "system_config",
  "system_user_level",
] as const;

const PRIMARY_KEYS: Record<(typeof CLONED_TABLES)[number], string> = {
  user: "uid",
  community_user: "id",
  community_relevance: "id",
  community: "id",
  user_friends: "id",
  system_config: "id",
  system_user_level: "id",
};

const IDS = {
  level: 1_701_000_001,
  alice: 1_701_000_101,
  bob: 1_701_000_102,
  carol: 1_701_000_103,
  disabled: 1_701_000_104,
  bobPost: 1_701_001_102,
  carolPost: 1_701_001_103,
} as const;

interface PublicFingerprint {
  tables: Record<string, { count: string; max_id: string | null; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface CommunitySocialPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  profile: {
    level_name: string;
    vip_status: number;
    platform_profile_selected: boolean;
    description_persisted: boolean;
  };
  follows: {
    replay_idempotent: boolean;
    mutual_flags: boolean;
    lists_deduplicated: boolean;
    unfollow_idempotent: boolean;
    historical_duplicates_removed: boolean;
    concurrent_insert_singleton: boolean;
    self_follow_rejected: boolean;
  };
  discovery: {
    referral_friends: number;
    actual_friend_flags: boolean;
    recommendation_ids: number[];
    unread_before_browse: boolean;
    read_after_browse: boolean;
    browse_relation_rows: number;
    play_count_delta: number;
  };
  integrity: {
    missing_profile_materialized: boolean;
    duplicate_profile_rejected: boolean;
    final_relation_rows: number;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Community social integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_community_social_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function publicFingerprint(db: DbClient): Promise<PublicFingerprint> {
  const tables: PublicFingerprint["tables"] = {};
  for (const table of CLONED_TABLES) {
    const name = identifier(table);
    const key = identifier(PRIMARY_KEYS[table]);
    const rows = await db.$client.unsafe<Array<{
      count: string;
      max_id: string | null;
      digest: string;
    }>>(
      `SELECT count(*)::text AS count,
        max(t.${key})::text AS max_id,
        md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) AS digest
       FROM public.${name} t WHERE random() >= 0`,
    );
    assertCondition(rows[0], `could not fingerprint public.${table}`);
    tables[table] = rows[0];
  }
  const sequenceNames = CLONED_TABLES.map((table) => `${table}_${PRIMARY_KEYS[table]}_seq`);
  const rows = await db.$client<{ sequencename: string; last_value: string | null }[]>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = ANY(${sequenceNames})
    ORDER BY sequencename
  `;
  const byName = new Map(rows.map((row) => [row.sequencename, row.last_value]));
  return {
    tables,
    sequences: Object.fromEntries(sequenceNames.map((name) => [name, byName.get(name) ?? null])),
  };
}

async function setupSchema(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of CLONED_TABLES) {
      const name = identifier(table);
      await tx.unsafe(`CREATE TABLE ${schema}.${name} (LIKE public.${name} INCLUDING ALL)`);
    }
    for (const table of ["community_user", "community_relevance"] as const) {
      const sequence = identifier(`${table}_id_seq`);
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequence} START WITH 1800000000`);
      await tx.unsafe(`ALTER SEQUENCE ${schema}.${sequence} OWNED BY ${schema}.${identifier(table)}."id"`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${identifier(table)} ALTER COLUMN "id" `
        + `SET DEFAULT nextval('${schemaName}.${table}_id_seq'::regclass)`,
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

async function seed(container: Container): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await container.db.insert(systemConfig).values([
    { id: 1_701_010_001, menuName: "site_name", value: "CinaShop 社区", status: 1 },
    { id: 1_701_010_002, menuName: "wap_login_logo", value: "audit-logo.svg", status: 1 },
    { id: 1_701_010_003, menuName: "member_func_status", value: "1", status: 1 },
    { id: 1_701_010_004, menuName: "member_card_status", value: "1", status: 1 },
  ]);
  await container.db.insert(systemUserLevel).values({
    id: IDS.level,
    name: "社区审计会员",
    grade: 3,
    isShow: 1,
    isDel: 0,
  });
  await container.db.insert(user).values([
    {
      uid: IDS.alice,
      account: "community-audit-alice",
      nickname: "Alice 审计",
      avatar: "alice.svg",
      status: 1,
      isDel: 0,
      addTime: now - 400,
    },
    {
      uid: IDS.bob,
      account: "community-audit-bob",
      nickname: "Bob 审计",
      avatar: "bob.svg",
      status: 1,
      isDel: 0,
      level: IDS.level,
      isMoneyLevel: 1,
      overdueTime: now + 86_400,
      addTime: now - 300,
    },
    {
      uid: IDS.carol,
      account: "community-audit-carol",
      nickname: "Carol 审计",
      avatar: "carol.svg",
      status: 1,
      isDel: 0,
      addTime: now - 200,
    },
    {
      uid: IDS.disabled,
      account: "community-audit-disabled",
      nickname: "Disabled 审计",
      avatar: "disabled.svg",
      status: 0,
      isDel: 0,
      addTime: now - 100,
    },
  ]);
  await container.db.insert(communityUser).values([
    {
      id: 1_701_020_001,
      type: 0,
      relationId: 0,
      nickname: "旧平台资料",
      avatar: "old-platform.svg",
      communityNum: 0,
      status: 1,
      isDel: 0,
      addTime: now - 500,
    },
    {
      id: 1_701_020_002,
      type: 1,
      relationId: 0,
      nickname: "脏门店资料",
      avatar: "dirty-store.svg",
      communityNum: 0,
      status: 1,
      isDel: 0,
      addTime: now - 450,
    },
    {
      id: 1_701_020_102,
      type: 2,
      relationId: IDS.bob,
      nickname: "Bob 旧资料",
      avatar: "bob-old.svg",
      communityNum: 1,
      fansNum: 0,
      status: 1,
      isDel: 0,
      addTime: now - 300,
    },
    {
      id: 1_701_020_103,
      type: 2,
      relationId: IDS.carol,
      nickname: "Carol 旧资料",
      avatar: "carol-old.svg",
      communityNum: 1,
      fansNum: 9,
      status: 1,
      isDel: 0,
      addTime: now - 200,
    },
    {
      id: 1_701_020_104,
      type: 2,
      relationId: IDS.disabled,
      nickname: "Disabled 旧资料",
      avatar: "disabled-old.svg",
      communityNum: 1,
      fansNum: 99,
      status: 1,
      isDel: 0,
      addTime: now - 100,
    },
  ]);
  await container.db.insert(community).values([
    {
      id: IDS.bobPost,
      type: 2,
      relationId: IDS.bob,
      contentType: 1,
      title: "Bob 审计帖子",
      content: "隔离 schema",
      playNum: 7,
      status: 1,
      isVerify: 1,
      isDel: 0,
      addTime: now - 30,
    },
    {
      id: IDS.carolPost,
      type: 2,
      relationId: IDS.carol,
      contentType: 1,
      title: "Carol 审计帖子",
      content: "隔离 schema",
      playNum: 3,
      status: 1,
      isVerify: 1,
      isDel: 0,
      addTime: now - 20,
    },
  ]);
  await container.db.insert(userFriends).values([
    { id: 1_701_030_001, uid: IDS.alice, friendsUid: IDS.bob, addTime: now - 30 },
    { id: 1_701_030_002, uid: IDS.bob, friendsUid: IDS.alice, addTime: now - 20 },
    { id: 1_701_030_003, uid: IDS.alice, friendsUid: IDS.carol, addTime: now - 10 },
  ]);
}

async function relationCount(container: Container, leftId: number, rightId: number, type = "community_interest") {
  const rows = await container.db.select({ id: communityRelevance.id })
    .from(communityRelevance)
    .where(and(
      eq(communityRelevance.leftId, leftId),
      eq(communityRelevance.rightId, rightId),
      eq(communityRelevance.type, type),
    ));
  return rows.length;
}

async function profileCounters(container: Container, relationId: number) {
  const rows = await container.db.select({
    id: communityUser.id,
    followNum: communityUser.followNum,
    fansNum: communityUser.fansNum,
    description: communityUser.description,
  }).from(communityUser).where(and(
    eq(communityUser.type, relationId === 0 ? 0 : 2),
    eq(communityUser.relationId, relationId),
    eq(communityUser.isDel, 0),
  ));
  assertCondition(rows.length === 1, `expected one active profile for relation ${relationId}`);
  return rows[0];
}

async function runCore(container: Container) {
  const service = new CommunitySocialService(container);
  const bobProfile = await service.profile(IDS.bob, IDS.alice);
  assertCondition(bobProfile.level_name === "社区审计会员", "member level projection diverged");
  assertCondition(bobProfile.vip_status === 1, "paid membership projection diverged");
  const platformProfile = await service.profile(0, IDS.alice);
  assertCondition(
    platformProfile.author === "CinaShop 社区" && platformProfile.type === 0,
    "platform profile did not ignore a newer non-platform relation_id=0 row",
  );

  const firstFollow = await service.setInterest(IDS.alice, IDS.bob, 1);
  const countersAfterFirst = {
    alice: await profileCounters(container, IDS.alice),
    bob: await profileCounters(container, IDS.bob),
  };
  const replayFollow = await service.setInterest(IDS.alice, IDS.bob, 1);
  const countersAfterReplay = {
    alice: await profileCounters(container, IDS.alice),
    bob: await profileCounters(container, IDS.bob),
  };
  const replayIdempotent = await relationCount(container, IDS.alice, IDS.bob) === 1
    && countersAfterFirst.alice.followNum === countersAfterReplay.alice.followNum
    && countersAfterFirst.bob.fansNum === countersAfterReplay.bob.fansNum;
  assertCondition(firstFollow.is_follow === 1 && replayFollow.is_follow === 1 && replayIdempotent,
    "follow replay drifted relation rows or counters");

  const reverse = await service.setInterest(IDS.bob, IDS.alice, 1);
  const mutual = await service.profile(IDS.bob, IDS.alice);
  const mutualFlags = reverse.is_fans === 1 && mutual.is_follow === 1 && mutual.is_fans === 1;
  assertCondition(mutualFlags, "mutual follow flags diverged");

  const [followList, fansList, friends, recommendations, beforeHighlights] = await Promise.all([
    service.followList(IDS.alice, "follow", 1, 100),
    service.followList(IDS.alice, "fans", 1, 100),
    service.friendList(IDS.alice, 1, 100),
    service.recommendations(IDS.alice, 1, 100),
    service.followHighlights(IDS.alice),
  ]);
  const listsDeduplicated = followList.length === 1 && followList[0]?.relation_id === IDS.bob
    && fansList.length === 1 && fansList[0]?.relation_id === IDS.bob;
  assertCondition(listsDeduplicated, "follow or fan list failed logical deduplication");
  const friendById = new Map(friends.map((entry) => [entry.relation_id, entry]));
  const actualFriendFlags = friendById.get(IDS.bob)?.is_follow === 1
    && friendById.get(IDS.bob)?.is_fans === 1
    && friendById.get(IDS.carol)?.is_follow === 0;
  assertCondition(friends.length === 2 && actualFriendFlags, "referral friend list or flags diverged");
  const recommendationIds = recommendations.map((entry) => entry.relation_id);
  assertCondition(
    recommendationIds.length === 1 && recommendationIds[0] === IDS.carol,
    "recommendations did not exclude self, followed, or disabled users before pagination",
  );
  const unreadBeforeBrowse = beforeHighlights.some(
    (entry) => entry.relation_id === IDS.bob && entry.is_new === 1,
  );
  assertCondition(unreadBeforeBrowse, "follow highlight was not unread before browse");

  const firstBrowse = await service.recordBrowse(IDS.bobPost, IDS.alice);
  const afterHighlights = await service.followHighlights(IDS.alice);
  const secondBrowse = await service.recordBrowse(IDS.bobPost, IDS.alice);
  const readAfterBrowse = afterHighlights.some(
    (entry) => entry.relation_id === IDS.bob && entry.is_new === 0,
  );
  const browseRows = await relationCount(container, IDS.alice, IDS.bobPost, "community_browse");
  assertCondition(readAfterBrowse && browseRows === 1, "browse marker was not idempotent or highlight stayed unread");
  assertCondition(firstBrowse.play_num === 8 && secondBrowse.play_num === 9, "play counter did not advance per view");

  const description = await service.updateDescription(IDS.alice, "迁移审计资料");
  const aliceProfile = await service.profile(IDS.alice, IDS.alice);
  const descriptionPersisted = description.desc === "迁移审计资料"
    && aliceProfile.desc === "迁移审计资料" && aliceProfile.is_self === 1;
  assertCondition(descriptionPersisted, "description update or self projection diverged");

  const platformFollow = await service.setInterest(IDS.alice, 0, 1);
  const platformCounters = await profileCounters(container, 0);
  await service.setInterest(IDS.alice, 0, 0);
  assertCondition(platformFollow.is_follow === 1 && platformCounters.fansNum === 1,
    "platform follow targeted the wrong relation_id=0 profile");

  await service.setInterest(IDS.alice, IDS.bob, 0);
  const afterUnfollow = {
    alice: await profileCounters(container, IDS.alice),
    bob: await profileCounters(container, IDS.bob),
  };
  await service.setInterest(IDS.alice, IDS.bob, 0);
  const afterUnfollowReplay = {
    alice: await profileCounters(container, IDS.alice),
    bob: await profileCounters(container, IDS.bob),
  };
  const unfollowIdempotent = await relationCount(container, IDS.alice, IDS.bob) === 0
    && afterUnfollow.alice.followNum === afterUnfollowReplay.alice.followNum
    && afterUnfollow.bob.fansNum === afterUnfollowReplay.bob.fansNum
    && await relationCount(container, IDS.bob, IDS.alice) === 1;
  assertCondition(unfollowIdempotent, "unfollow replay drifted counters or removed reverse relation");

  await container.db.insert(communityRelevance).values([
    { leftId: IDS.alice, rightId: IDS.carol, type: "community_interest" },
    { leftId: IDS.alice, rightId: IDS.carol, type: "community_interest" },
  ]);
  const aliceBeforeDuplicateRemoval = await profileCounters(container, IDS.alice);
  const carolBeforeDuplicateRemoval = await profileCounters(container, IDS.carol);
  await container.db.update(communityUser).set({
    followNum: aliceBeforeDuplicateRemoval.followNum + 1,
  }).where(eq(communityUser.id, aliceBeforeDuplicateRemoval.id));
  await container.db.update(communityUser).set({
    fansNum: carolBeforeDuplicateRemoval.fansNum + 1,
  }).where(eq(communityUser.id, carolBeforeDuplicateRemoval.id));
  await service.setInterest(IDS.alice, IDS.carol, 0);
  const aliceAfterDuplicateRemoval = await profileCounters(container, IDS.alice);
  const carolAfterDuplicateRemoval = await profileCounters(container, IDS.carol);
  const historicalDuplicatesRemoved = await relationCount(container, IDS.alice, IDS.carol) === 0
    && aliceAfterDuplicateRemoval.followNum === aliceBeforeDuplicateRemoval.followNum
    && carolAfterDuplicateRemoval.fansNum === carolBeforeDuplicateRemoval.fansNum;
  assertCondition(historicalDuplicatesRemoved, "historical duplicate edges were not removed logically once");

  let selfFollowRejected = false;
  try {
    await service.setInterest(IDS.alice, IDS.alice, 1);
  } catch (error) {
    selfFollowRejected = error instanceof ValidateException;
  }
  assertCondition(selfFollowRejected, "self follow was accepted");

  return {
    profile: {
      level_name: bobProfile.level_name,
      vip_status: bobProfile.vip_status,
      platform_profile_selected: platformProfile.type === 0,
      description_persisted: descriptionPersisted,
    },
    follows: {
      replay_idempotent: replayIdempotent,
      mutual_flags: mutualFlags,
      lists_deduplicated: listsDeduplicated,
      unfollow_idempotent: unfollowIdempotent,
      historical_duplicates_removed: historicalDuplicatesRemoved,
      self_follow_rejected: selfFollowRejected,
    },
    discovery: {
      referral_friends: friends.length,
      actual_friend_flags: actualFriendFlags,
      recommendation_ids: recommendationIds,
      unread_before_browse: unreadBeforeBrowse,
      read_after_browse: readAfterBrowse,
      browse_relation_rows: browseRows,
      play_count_delta: secondBrowse.play_num - 7,
    },
    integrity: {
      missing_profile_materialized: aliceProfile.id > 0,
    },
  };
}

async function runConcurrentFollow(dbA: DbClient, dbB: DbClient, schemaName: string) {
  const before = await withSchema(dbA, schemaName, async (container) => ({
    carol: await profileCounters(container, IDS.carol),
    bob: await profileCounters(container, IDS.bob),
  }));
  await Promise.all([
    withSchema(dbA, schemaName, (container) => new CommunitySocialService(container)
      .setInterest(IDS.carol, IDS.bob, 1)),
    withSchema(dbB, schemaName, (container) => new CommunitySocialService(container)
      .setInterest(IDS.carol, IDS.bob, 1)),
  ]);
  return withSchema(dbA, schemaName, async (container) => {
    const after = {
      carol: await profileCounters(container, IDS.carol),
      bob: await profileCounters(container, IDS.bob),
    };
    return await relationCount(container, IDS.carol, IDS.bob) === 1
      && after.carol.followNum === before.carol.followNum + 1
      && after.bob.fansNum === before.bob.fansNum + 1;
  });
}

async function runDuplicateProfileGuard(db: DbClient, schemaName: string) {
  return withSchema(db, schemaName, async (container) => {
    const current = await profileCounters(container, IDS.alice);
    await container.db.insert(communityUser).values({
      type: 2,
      relationId: IDS.alice,
      nickname: "Alice 重复资料",
      avatar: "duplicate.svg",
      description: current.description,
      status: 1,
      isDel: 0,
      addTime: Math.floor(Date.now() / 1_000),
    });
    let rejected = false;
    try {
      await new CommunitySocialService(container).updateDescription(IDS.alice, "不应写入");
    } catch (error) {
      rejected = error instanceof ValidateException;
    }
    assertCondition(rejected, "duplicate active profile was accepted for mutation");
    return rejected;
  });
}

export async function runCommunitySocialPostgresScenario(
  connectionString: string,
): Promise<CommunitySocialPostgresReport> {
  const schemaName = makeSchemaName();
  const schema = identifier(schemaName);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_community_social_audit_root",
  });
  const scopedA = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_community_social_audit_a",
  });
  const scopedB = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_community_social_audit_b",
  });
  let created = false;
  let removed = false;
  let before: PublicFingerprint | undefined;
  let after: PublicFingerprint | undefined;
  let temporarySchemasAfter = -1;
  let core: Awaited<ReturnType<typeof runCore>> | undefined;
  let concurrentInsertSingleton = false;
  let duplicateProfileRejected = false;
  let finalRelationRows = -1;
  let serverVersion = "unknown";
  try {
    const versions = await root.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    serverVersion = versions[0]?.server_version ?? "unknown";
    before = await publicFingerprint(root);
    await setupSchema(root, schemaName);
    created = true;
    await withSchema(scopedA, schemaName, seed);
    core = await withSchema(scopedA, schemaName, runCore);
    concurrentInsertSingleton = await runConcurrentFollow(scopedA, scopedB, schemaName);
    assertCondition(concurrentInsertSingleton, "concurrent follow inserted duplicates or drifted counters");
    duplicateProfileRejected = await runDuplicateProfileGuard(scopedA, schemaName);
    finalRelationRows = await withSchema(scopedA, schemaName, async (container) => {
      const rows = await container.db.select({ id: communityRelevance.id }).from(communityRelevance);
      return rows.length;
    });
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
          (SELECT count(*)::int FROM pg_namespace
            WHERE nspname LIKE 'codex_community_social_%') AS prefix_count
      `;
      removed = state[0]?.schema_removed === true;
      temporarySchemasAfter = state[0]?.prefix_count ?? -1;
      after = await publicFingerprint(root);
    } finally {
      await Promise.all([
        root.$client.end({ timeout: 1 }),
        scopedA.$client.end({ timeout: 1 }),
        scopedB.$client.end({ timeout: 1 }),
      ]);
    }
  }
  assertCondition(core, "core report was not produced");
  const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(removed, "temporary schema was not removed");
  assertCondition(temporarySchemasAfter === 0, "temporary schema prefix has leftovers");
  assertCondition(publicStateUnchanged, "public tables or sequences changed during isolated scenario");
  return {
    server_version: serverVersion,
    schema_created: created,
    schema_removed: removed,
    temporary_schemas_after: temporarySchemasAfter,
    public_state_unchanged: publicStateUnchanged,
    profile: core.profile,
    follows: {
      ...core.follows,
      concurrent_insert_singleton: concurrentInsertSingleton,
    },
    discovery: core.discovery,
    integrity: {
      ...core.integrity,
      duplicate_profile_rejected: duplicateProfileRejected,
      final_relation_rows: finalRelationRows,
    },
  };
}
