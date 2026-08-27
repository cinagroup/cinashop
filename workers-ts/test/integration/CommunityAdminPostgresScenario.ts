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
  communityComment,
  communityRelevance,
  communityTopic,
  communityUser,
  storeProduct,
  user,
} from "@/models/schema";
import { AdminCommunityService } from "@/services/community/AdminCommunityService";
import { CommunityService } from "@/services/community/CommunityService";
import { ValidateException } from "@/utils/errors";

const CLONED_TABLES = [
  "user",
  "community_user",
  "community",
  "community_comment",
  "community_topic",
  "community_relevance",
  "store_product",
] as const;

const PRIMARY_KEYS: Record<(typeof CLONED_TABLES)[number], string> = {
  user: "uid",
  community_user: "id",
  community: "id",
  community_comment: "id",
  community_topic: "id",
  community_relevance: "id",
  store_product: "id",
};

const PRIVATE_SEQUENCE_TABLES = [
  "community_user",
  "community",
  "community_comment",
  "community_topic",
  "community_relevance",
] as const;

const IDS = {
  user: 1_702_000_101,
  existingPost: 1_702_001_101,
  topicA: 1_702_002_101,
  topicB: 1_702_002_102,
  product: 1_702_003_101,
  profile: 1_702_004_101,
  relation: 1_702_005_101,
} as const;

interface PublicFingerprint {
  tables: Record<string, { count: string; max_id: string | null; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface CommunityAdminPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  posts: {
    platform_created: boolean;
    user_ownership_preserved: boolean;
    profile_count_tracks_moderation: boolean;
    invalid_product_rolled_back: boolean;
    delete_cascade_complete: boolean;
  };
  topics: {
    duplicate_rejected: boolean;
    flags_persisted: boolean;
    counts_exact: boolean;
  };
  comments: {
    user_comment_is_top_level: boolean;
    reply_and_virtual_counted: boolean;
    moderation_counts_exact: boolean;
    top_delete_cascades: boolean;
    like_relations_cleaned: boolean;
    concurrent_count_exact: boolean;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Community admin integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_community_admin_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
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
    for (const table of PRIVATE_SEQUENCE_TABLES) {
      const sequence = identifier(`${table}_id_seq`);
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequence} START WITH 1900000000`);
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
  await container.db.insert(user).values({
    uid: IDS.user,
    account: "community-admin-audit-user",
    nickname: "社区运营审计用户",
    avatar: "audit-user.svg",
    status: 1,
    isDel: 0,
    addTime: now - 500,
  });
  await container.db.insert(communityUser).values({
    id: IDS.profile,
    type: 2,
    relationId: IDS.user,
    nickname: "旧用户资料",
    avatar: "old-user.svg",
    communityNum: 1,
    status: 1,
    isDel: 0,
    addTime: now - 500,
  });
  await container.db.insert(communityTopic).values([
    {
      id: IDS.topicA,
      name: "运营审计话题 A",
      sort: 20,
      isRecommend: 1,
      useNum: 1,
      status: 1,
      isDel: 0,
      addTime: now - 400,
    },
    {
      id: IDS.topicB,
      name: "运营审计话题 B",
      sort: 10,
      isRecommend: 0,
      useNum: 0,
      status: 1,
      isDel: 0,
      addTime: now - 300,
    },
  ]);
  await container.db.insert(storeProduct).values({
    id: IDS.product,
    storeName: "社区审计商品",
    image: "audit-product.svg",
    status: undefined,
    isShow: 1,
    isVerify: 1,
    isDel: 0,
    addTime: now - 200,
  } as typeof storeProduct.$inferInsert);
  await container.db.insert(community).values({
    id: IDS.existingPost,
    type: 2,
    relationId: IDS.user,
    contentType: 1,
    title: "用户原始帖子",
    content: "迁移隔离数据",
    sliderImage: "[]",
    topicId: JSON.stringify([IDS.topicA]),
    productId: "[]",
    status: 1,
    isVerify: 1,
    isDel: 0,
    addTime: now - 100,
  });
  await container.db.insert(communityRelevance).values({
    id: IDS.relation,
    leftId: IDS.existingPost,
    rightId: IDS.topicA,
    type: "community_topic",
  });
}

async function onePost(container: Container, id: number) {
  return (await container.db.select().from(community).where(eq(community.id, id)).limit(1))[0];
}

async function oneTopic(container: Container, id: number) {
  return (await container.db.select().from(communityTopic).where(eq(communityTopic.id, id)).limit(1))[0];
}

async function oneComment(container: Container, id: number) {
  return (await container.db.select().from(communityComment).where(eq(communityComment.id, id)).limit(1))[0];
}

async function profileCount(container: Container, type: number, relationId: number) {
  const rows = await container.db.select({ communityNum: communityUser.communityNum }).from(communityUser)
    .where(and(eq(communityUser.type, type), eq(communityUser.relationId, relationId), eq(communityUser.isDel, 0)));
  assertCondition(rows.length === 1, `expected one profile for ${type}/${relationId}`);
  return rows[0].communityNum;
}

async function runCore(container: Container) {
  const admin = new AdminCommunityService(container);

  let duplicateRejected = false;
  try {
    await admin.saveTopic(0, { name: "运营审计话题 A", status: 1 });
  } catch (error) {
    duplicateRejected = error instanceof ValidateException;
  }
  assertCondition(duplicateRejected, "duplicate topic name was accepted");
  await admin.setTopicRecommend(IDS.topicB, 1);
  await admin.setTopicStatus(IDS.topicB, 0);
  await admin.setTopicStatus(IDS.topicB, 1);
  const topicBAfterFlags = await oneTopic(container, IDS.topicB);
  const flagsPersisted = topicBAfterFlags?.isRecommend === 1 && topicBAfterFlags.status === 1;
  assertCondition(flagsPersisted, "topic flags did not persist");

  const platform = await admin.savePost(0, {
    content_type: 1,
    title: "平台运营内容",
    content: "生产 PostgreSQL 隔离验证",
    slider_image: ["audit-platform.svg"],
    topic_id: [IDS.topicA, IDS.topicB],
    product_id: [IDS.product],
    status: 1,
    is_recommend: 1,
    star: 5,
  });
  const platformRow = await onePost(container, platform.id);
  const platformCreated = platformRow?.type === 0 && platformRow.relationId === 0
    && await profileCount(container, 0, 0) === 1;
  assertCondition(platformCreated, "platform post ownership/profile projection diverged");

  await admin.savePost(IDS.existingPost, {
    title: "用户帖子由运营编辑",
    topic_id: [IDS.topicB],
  });
  const editedUserPost = await onePost(container, IDS.existingPost);
  const ownershipPreserved = editedUserPost?.type === 2 && editedUserPost.relationId === IDS.user;
  assertCondition(ownershipPreserved, "editing converted a user post to platform ownership");
  const topicAAfterEdit = await oneTopic(container, IDS.topicA);
  const topicBAfterEdit = await oneTopic(container, IDS.topicB);
  const topicCountsExact = topicAAfterEdit?.useNum === 1 && topicBAfterEdit?.useNum === 2;
  assertCondition(topicCountsExact, "topic usage counts drifted after post edit");

  await admin.setPostStatus(IDS.existingPost, 0);
  const hiddenCount = await profileCount(container, 2, IDS.user);
  await admin.setPostStatus(IDS.existingPost, 1);
  await admin.setPostVerify(IDS.existingPost, { is_verify: -1, refusal: "审计拒绝" });
  const rejectedCount = await profileCount(container, 2, IDS.user);
  await admin.setPostVerify(IDS.existingPost, { is_verify: 1 });
  const approvedCount = await profileCount(container, 2, IDS.user);
  const profileCountTracksModeration = hiddenCount === 0 && rejectedCount === 0 && approvedCount === 1;
  assertCondition(profileCountTracksModeration, "author visible post count did not track moderation");

  const userComment = await admin.addUserComment(IDS.user, IDS.existingPost, "用户顶级评论");
  const userCommentRow = await oneComment(container, userComment.id);
  const userCommentIsTopLevel = userCommentRow?.type === 2 && userCommentRow.isReply === 1;
  assertCondition(userCommentIsTopLevel, "user comment was not stored as a top-level row");
  const reply = await admin.replyComment(userComment.id, { content: "平台运营回复" }, "127.0.0.1");
  const virtual = await admin.saveFictitiousComment({
    community_id: IDS.existingPost,
    type: 3,
    nickname: "审计体验官",
    avatar: "virtual.svg",
    content: "虚拟评论",
  });
  const postAfterComments = await onePost(container, IDS.existingPost);
  const parentAfterReply = await oneComment(container, userComment.id);
  const replyAndVirtualCounted = postAfterComments?.commentNum === 3 && parentAfterReply?.commentNum === 1;
  assertCondition(replyAndVirtualCounted, "reply or virtual comment count did not converge");

  await admin.setCommentStatus(virtual.id, 0);
  const hiddenVirtualCount = (await onePost(container, IDS.existingPost))?.commentNum;
  await admin.setCommentStatus(virtual.id, 1);
  await admin.setCommentVerify(userComment.id, { is_verify: -1 });
  const rejectedParentCount = (await onePost(container, IDS.existingPost))?.commentNum;
  await admin.setCommentVerify(userComment.id, { is_verify: 1 });
  const restoredCount = (await onePost(container, IDS.existingPost))?.commentNum;
  const moderationCountsExact = hiddenVirtualCount === 2 && rejectedParentCount === 2 && restoredCount === 3;
  assertCondition(moderationCountsExact, "comment moderation did not recompute visible counts");

  await container.db.insert(communityRelevance).values({
    leftId: IDS.user,
    rightId: userComment.id,
    type: "community_comment_like",
  });
  await admin.deleteComment(userComment.id);
  const deletedParent = await oneComment(container, userComment.id);
  const deletedReply = await oneComment(container, reply.id);
  const remainingCommentLike = await container.db.select({ id: communityRelevance.id }).from(communityRelevance)
    .where(and(eq(communityRelevance.rightId, userComment.id), eq(communityRelevance.type, "community_comment_like")));
  const topDeleteCascades = deletedParent?.isDel === 1 && deletedReply?.isDel === 1
    && (await onePost(container, IDS.existingPost))?.commentNum === 1;
  const likeRelationsCleaned = remainingCommentLike.length === 0;
  assertCondition(topDeleteCascades && likeRelationsCleaned, "top comment cascade or like cleanup diverged");

  const beforeInvalid = {
    posts: (await container.db.select({ id: community.id }).from(community)).length,
    relations: (await container.db.select({ id: communityRelevance.id }).from(communityRelevance)).length,
    topicA: (await oneTopic(container, IDS.topicA))?.useNum,
    platform: await profileCount(container, 0, 0),
  };
  let invalidRejected = false;
  try {
    await admin.savePost(0, {
      title: "不应写入",
      topic_id: [IDS.topicA],
      product_id: [2_000_000_001],
    });
  } catch (error) {
    invalidRejected = error instanceof ValidateException;
  }
  const afterInvalid = {
    posts: (await container.db.select({ id: community.id }).from(community)).length,
    relations: (await container.db.select({ id: communityRelevance.id }).from(communityRelevance)).length,
    topicA: (await oneTopic(container, IDS.topicA))?.useNum,
    platform: await profileCount(container, 0, 0),
  };
  const invalidProductRolledBack = invalidRejected && JSON.stringify(beforeInvalid) === JSON.stringify(afterInvalid);
  assertCondition(invalidProductRolledBack, "invalid product reference left partial post state");

  await admin.deletePost(IDS.existingPost);
  const deletedPost = await onePost(container, IDS.existingPost);
  const activeComments = await container.db.select({ id: communityComment.id }).from(communityComment)
    .where(and(eq(communityComment.communityId, IDS.existingPost), eq(communityComment.isDel, 0)));
  const postRelations = await container.db.select({ id: communityRelevance.id }).from(communityRelevance)
    .where(eq(communityRelevance.leftId, IDS.existingPost));
  const deleteCascadeComplete = deletedPost?.isDel === 1 && activeComments.length === 0
    && postRelations.length === 0 && await profileCount(container, 2, IDS.user) === 0;
  assertCondition(deleteCascadeComplete, "post delete cascade/profile correction diverged");
  const finalTopicB = await oneTopic(container, IDS.topicB);
  assertCondition(finalTopicB?.useNum === 1, "topic count did not converge after post deletion");

  return {
    platformId: platform.id,
    posts: {
      platform_created: platformCreated,
      user_ownership_preserved: ownershipPreserved,
      profile_count_tracks_moderation: profileCountTracksModeration,
      invalid_product_rolled_back: invalidProductRolledBack,
      delete_cascade_complete: deleteCascadeComplete,
    },
    topics: {
      duplicate_rejected: duplicateRejected,
      flags_persisted: flagsPersisted,
      counts_exact: topicCountsExact && finalTopicB?.useNum === 1,
    },
    comments: {
      user_comment_is_top_level: userCommentIsTopLevel,
      reply_and_virtual_counted: replyAndVirtualCounted,
      moderation_counts_exact: moderationCountsExact,
      top_delete_cascades: topDeleteCascades,
      like_relations_cleaned: likeRelationsCleaned,
    },
  };
}

async function runConcurrentComments(dbA: DbClient, dbB: DbClient, schemaName: string, platformId: number) {
  await Promise.all([
    withSchema(dbA, schemaName, (container) => new CommunityService(container)
      .addComment(IDS.user, { communityId: platformId, content: "并发评论 A" })),
    withSchema(dbB, schemaName, (container) => new CommunityService(container)
      .addComment(IDS.user, { communityId: platformId, content: "并发评论 B" })),
  ]);
  return withSchema(dbA, schemaName, async (container) => {
    const post = await onePost(container, platformId);
    const comments = await container.db.select({ id: communityComment.id }).from(communityComment)
      .where(and(
        eq(communityComment.communityId, platformId),
        eq(communityComment.isDel, 0),
        eq(communityComment.isShow, 1),
        eq(communityComment.isVerify, 1),
      ));
    return post?.commentNum === 2 && comments.length === 2;
  });
}

export async function runCommunityAdminPostgresScenario(
  connectionString: string,
): Promise<CommunityAdminPostgresReport> {
  const schemaName = makeSchemaName();
  const schema = identifier(schemaName);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_community_admin_audit_root",
  });
  const scopedA = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_community_admin_audit_a",
  });
  const scopedB = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_community_admin_audit_b",
  });
  let created = false;
  let removed = false;
  let before: PublicFingerprint | undefined;
  let after: PublicFingerprint | undefined;
  let temporarySchemasAfter = -1;
  let core: Awaited<ReturnType<typeof runCore>> | undefined;
  let concurrentCountExact = false;
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
    concurrentCountExact = await runConcurrentComments(scopedA, scopedB, schemaName, core.platformId);
    assertCondition(concurrentCountExact, "concurrent top-level comments drifted post count");
    await withSchema(scopedA, schemaName, async (container) => {
      await new AdminCommunityService(container).deletePost(core!.platformId);
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
            WHERE nspname LIKE 'codex_community_admin_%') AS prefix_count
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
    posts: core.posts,
    topics: core.topics,
    comments: { ...core.comments, concurrent_count_exact: concurrentCountExact },
  };
}
