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
  storeProductLog,
  user,
  userRelation,
} from "@/models/schema";
import { AdminCommunityService } from "@/services/community/AdminCommunityService";
import { CommunityService } from "@/services/community/CommunityService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const CLONED_TABLES = [
  "user",
  "community_user",
  "community",
  "community_comment",
  "community_topic",
  "community_relevance",
  "store_product",
  "store_product_log",
  "user_relation",
] as const;

const PRIMARY_KEYS: Record<(typeof CLONED_TABLES)[number], string> = {
  user: "uid",
  community_user: "id",
  community: "id",
  community_comment: "id",
  community_topic: "id",
  community_relevance: "id",
  store_product: "id",
  store_product_log: "id",
  user_relation: "id",
};

const PRIVATE_SEQUENCE_TABLES = [
  "community_user",
  "community",
  "community_comment",
  "community_topic",
  "community_relevance",
  "store_product_log",
  "user_relation",
] as const;

const IDS = {
  userA: 1_712_000_101,
  userB: 1_712_000_102,
  userC: 1_712_000_103,
  profileA: 1_712_001_101,
  profileB: 1_712_001_102,
  topicA: 1_712_002_101,
  topicB: 1_712_002_102,
  productA: 1_712_003_101,
  productB: 1_712_003_102,
  productC: 1_712_003_103,
  publicPost: 1_712_004_101,
  topicRelation: 1_712_005_101,
  productRelation: 1_712_005_102,
  payLogA: 1_712_006_101,
  payLogB: 1_712_006_102,
  visitLog: 1_712_006_103,
  collectRelation: 1_712_007_101,
} as const;

interface PublicFingerprint {
  tables: Record<string, { count: string; max_id: string | null; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface CommunityClientPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  posts: {
    pending_owner_preview_only: boolean;
    cross_user_edit_rejected: boolean;
    edit_resets_review: boolean;
    filters_exact: boolean;
    like_and_elegant_lists_exact: boolean;
    concurrent_share_exact: boolean;
  };
  comments: {
    nested_reply_shape_exact: boolean;
    list_and_reply_counts_exact: boolean;
    concurrent_like_idempotent: boolean;
    cross_user_delete_rejected: boolean;
    owner_delete_cascade_exact: boolean;
  };
  products: {
    pay_deduplicated: boolean;
    visit_scoped: boolean;
    collect_scoped: boolean;
  };
  topics: {
    visible_counts_exact: boolean;
    persisted_counts_exact: boolean;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Community client integration failed: ${message}`);
}

async function auditStep<T>(stage: string, callback: () => Promise<T>): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Community client integration stage ${stage} failed: ${message}`, { cause: error });
  }
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_community_client_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
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
  const sequenceNames = PRIVATE_SEQUENCE_TABLES.map((table) => `${table}_id_seq`);
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
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequence} START WITH 1910000000`);
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
  await container.db.insert(user).values([
    { uid: IDS.userA, account: "community-client-a", nickname: "客户端用户 A", avatar: "a.svg", status: 1, isDel: 0, addTime: now - 1_000 },
    { uid: IDS.userB, account: "community-client-b", nickname: "客户端用户 B", avatar: "b.svg", status: 1, isDel: 0, addTime: now - 900 },
    { uid: IDS.userC, account: "community-client-c", nickname: "客户端用户 C", avatar: "c.svg", status: 1, isDel: 0, addTime: now - 800 },
  ]);
  await container.db.insert(communityUser).values([
    { id: IDS.profileA, type: 2, relationId: IDS.userA, nickname: "客户端用户 A", avatar: "a.svg", communityNum: 0, status: 1, isDel: 0, addTime: now - 700 },
    { id: IDS.profileB, type: 2, relationId: IDS.userB, nickname: "客户端用户 B", avatar: "b.svg", communityNum: 1, status: 1, isDel: 0, addTime: now - 700 },
  ]);
  await container.db.insert(communityTopic).values([
    { id: IDS.topicA, name: "客户端审计话题 A", sort: 20, useNum: 1, status: 1, isDel: 0, addTime: now - 600 },
    { id: IDS.topicB, name: "客户端审计话题 B", sort: 10, useNum: 0, status: 1, isDel: 0, addTime: now - 500 },
  ]);
  await container.db.insert(storeProduct).values([
    { id: IDS.productA, storeName: "客户端已购商品", keyword: "已购", image: "pay.svg", price: "11.00", isShow: 1, isVerify: 1, isDel: 0, addTime: now - 400 },
    { id: IDS.productB, storeName: "客户端浏览商品", keyword: "浏览", image: "visit.svg", price: "22.00", isShow: 1, isVerify: 1, isDel: 0, addTime: now - 300 },
    { id: IDS.productC, storeName: "客户端收藏商品", keyword: "收藏", image: "collect.svg", price: "33.00", isShow: 1, isVerify: 1, isDel: 0, addTime: now - 200 },
  ]);
  await container.db.insert(community).values({
    id: IDS.publicPost,
    type: 2,
    relationId: IDS.userB,
    contentType: 1,
    title: "用户 B 的公开好物记录",
    content: "客户端筛选审计正文",
    sliderImage: "[]",
    topicId: JSON.stringify([IDS.topicA]),
    productId: JSON.stringify([IDS.productA]),
    status: 1,
    isVerify: 1,
    isDel: 0,
    addTime: now - 100,
  });
  await container.db.insert(communityRelevance).values([
    { id: IDS.topicRelation, leftId: IDS.publicPost, rightId: IDS.topicA, type: "community_topic" },
    { id: IDS.productRelation, leftId: IDS.publicPost, rightId: IDS.productA, type: "community_product" },
  ]);
  await container.db.insert(storeProductLog).values([
    { id: IDS.payLogA, type: "pay", productId: IDS.productA, uid: IDS.userA, payNum: 1, addTime: now - 90 },
    { id: IDS.payLogB, type: "pay", productId: IDS.productA, uid: IDS.userA, payNum: 1, addTime: now - 80 },
    { id: IDS.visitLog, type: "visit", productId: IDS.productB, uid: IDS.userA, visitNum: 1, addTime: now - 70 },
  ]);
  await container.db.insert(userRelation).values({
    id: IDS.collectRelation,
    uid: IDS.userA,
    relationId: IDS.productC,
    type: "collect",
    category: "product",
    addTime: now - 60,
  });
}

async function onePost(container: Container, id: number) {
  return (await container.db.select().from(community).where(eq(community.id, id)).limit(1))[0];
}

async function oneComment(container: Container, id: number) {
  return (await container.db.select().from(communityComment).where(eq(communityComment.id, id)).limit(1))[0];
}

async function runCore(container: Container) {
  const client = new CommunityService(container);
  const admin = new AdminCommunityService(container);
  const pending = await auditStep("pending-create", () => client.create(IDS.userA, {
    title: "用户 A 的待审帖子",
    content: "待审内容",
    contentType: 1,
    sliderImage: ["pending.svg"],
    topicIds: [IDS.topicA],
    productIds: [IDS.productA],
  }, 0));
  const [publicPending, ownerPending] = await Promise.all([
    client.list({ ids: [pending.id] }, 10, undefined),
    client.list({ ids: [pending.id], relation_id: IDS.userA }, 10, IDS.userA),
  ]);
  let otherPreviewRejected = false;
  try {
    await client.detail(pending.id, IDS.userB);
  } catch (error) {
    otherPreviewRejected = error instanceof NotFoundException;
  }
  const ownerDetail = await auditStep("pending-owner-detail", () => client.detail(pending.id, IDS.userA));
  const pendingOwnerPreviewOnly = publicPending.length === 0 && ownerPending.length === 1
    && ownerDetail.id === pending.id && otherPreviewRejected;
  assertCondition(pendingOwnerPreviewOnly, "pending owner preview boundary diverged");

  let crossUserEditRejected = false;
  try {
    await client.update(IDS.userB, pending.id, {
      title: "越权编辑",
      content: "不应写入",
      content_type: 1,
    }, 0);
  } catch (error) {
    crossUserEditRejected = error instanceof ValidateException;
  }
  assertCondition(crossUserEditRejected, "cross-user edit was accepted");

  await auditStep("pending-first-approve", () => admin.setPostVerify(pending.id, { is_verify: 1 }));
  await auditStep("pending-owner-edit", () => client.update(IDS.userA, pending.id, {
    title: "用户 A 编辑后的浏览主题",
    content: "编辑后重新审核",
    content_type: 1,
    slider_image: ["edited.svg"],
    topic_id: [IDS.topicB],
    product_id: [IDS.productB],
  }, 0));
  const editedPending = await onePost(container, pending.id);
  const hiddenAfterEdit = await client.list({ ids: [pending.id] }, 10, undefined);
  const editResetsReview = editedPending?.isVerify === 0 && editedPending.refusal === ""
    && hiddenAfterEdit.length === 0;
  assertCondition(editResetsReview, "user edit did not reset review state");
  await auditStep("pending-second-approve", () => admin.setPostVerify(pending.id, { is_verify: 1 }));

  await container.db.insert(communityRelevance).values({
    leftId: IDS.userA,
    rightId: IDS.userB,
    type: "community_interest",
  });
  const [topicFilter, keywordFilter, ownerFilter, contentFilter, idsFilter, followed] = await auditStep(
    "feed-filters",
    () => Promise.all([
      client.list({ topic_id: IDS.topicB }, 10, undefined),
      client.list({ keyword: "浏览主题" }, 10, undefined),
      client.list({ relation_id: IDS.userA }, 10, IDS.userA),
      client.list({ content_type: 1 }, 10, undefined),
      client.list({ ids: String(pending.id) }, 10, undefined),
      client.list({ is_follow: 1 }, 10, IDS.userA),
    ]),
  );
  const filtersExact = topicFilter.length === 1 && topicFilter[0].id === pending.id
    && keywordFilter.length === 1 && ownerFilter.length === 1
    && contentFilter.length === 2 && idsFilter.length === 1
    && followed.length === 1 && followed[0].id === IDS.publicPost;
  assertCondition(filtersExact, "client feed filters diverged");

  const firstLike = await auditStep("public-post-like", () => client.like(IDS.userA, IDS.publicPost, 1));
  const replayLike = await auditStep("public-post-like-replay", () => client.like(IDS.userA, IDS.publicPost, 1));
  const [liked, elegant] = await Promise.all([
    client.likedPosts(IDS.userA, {}),
    client.elegantPosts(IDS.userA, IDS.productB, {}),
  ]);
  const likeAndElegantListsExact = firstLike.likeNum === 1 && replayLike.likeNum === 1
    && liked.count === 1 && liked.list[0]?.id === IDS.publicPost
    && elegant.count === 1 && elegant.list[0]?.id === pending.id;
  assertCondition(likeAndElegantListsExact, "like/elegant projections diverged");

  const [pay, visit, collect] = await Promise.all([
    client.userProductList(IDS.userA, { type: "pay" }),
    client.userProductList(IDS.userA, { type: "visit" }),
    client.userProductList(IDS.userA, { type: "collect" }),
  ]);
  const payDeduplicated = pay.length === 1 && pay[0]?.product_id === IDS.productA;
  const visitScoped = visit.length === 1 && visit[0]?.product_id === IDS.productB;
  const collectScoped = collect.length === 1 && collect[0]?.product_id === IDS.productC;
  assertCondition(payDeduplicated && visitScoped && collectScoped, "user product sources diverged");

  const top = await auditStep("top-comment", () => client.addComment(IDS.userA, {
    communityId: IDS.publicPost,
    content: "顶级评论",
  }));
  const reply = await auditStep("reply-comment", () => client.addComment(IDS.userB, {
    communityId: IDS.publicPost,
    content: "回复顶级评论",
    replyCommentId: top.id,
  }));
  const nested = await auditStep("nested-comment", () => client.addComment(IDS.userA, {
    communityId: IDS.publicPost,
    content: "回复回复",
    replyCommentId: reply.id,
  }));
  const [topRow, replyRow, nestedRow, topList, replyList] = await Promise.all([
    oneComment(container, top.id),
    oneComment(container, reply.id),
    oneComment(container, nested.id),
    client.commentList(IDS.publicPost, 1, 20, IDS.userA),
    client.commentList(IDS.publicPost, 1, 20, IDS.userA, top.id),
  ]);
  const nestedReplyShapeExact = topRow?.isReply === 1 && replyRow?.isReply === 0
    && replyRow.replyId === top.id && replyRow.commentReplyId === 0
    && nestedRow?.replyId === top.id && nestedRow.commentReplyId === reply.id;
  const listAndReplyCountsExact = topList.count === 1 && replyList.count === 2
    && topRow?.commentNum === 2 && (await onePost(container, IDS.publicPost))?.commentNum === 3;
  assertCondition(nestedReplyShapeExact && listAndReplyCountsExact, "comment thread shape/count diverged");

  const topicA = await client.topicCount(IDS.topicA);
  const topicB = await client.topicCount(IDS.topicB);
  const topicRows = await container.db.select({ id: communityTopic.id, useNum: communityTopic.useNum })
    .from(communityTopic);
  const topicMap = new Map(topicRows.map((row) => [row.id, row.useNum]));
  const visibleCountsExact = topicA.count === 1 && topicB.count === 1;
  const persistedCountsExact = topicMap.get(IDS.topicA) === 1 && topicMap.get(IDS.topicB) === 1;
  assertCondition(visibleCountsExact && persistedCountsExact, "topic counts diverged");

  return {
    pendingId: pending.id,
    topId: top.id,
    replyId: reply.id,
    posts: {
      pending_owner_preview_only: pendingOwnerPreviewOnly,
      cross_user_edit_rejected: crossUserEditRejected,
      edit_resets_review: editResetsReview,
      filters_exact: filtersExact,
      like_and_elegant_lists_exact: likeAndElegantListsExact,
    },
    comments: {
      nested_reply_shape_exact: nestedReplyShapeExact,
      list_and_reply_counts_exact: listAndReplyCountsExact,
    },
    products: {
      pay_deduplicated: payDeduplicated,
      visit_scoped: visitScoped,
      collect_scoped: collectScoped,
    },
    topics: {
      visible_counts_exact: visibleCountsExact,
      persisted_counts_exact: persistedCountsExact,
    },
  };
}

async function runConcurrentShare(dbA: DbClient, dbB: DbClient, schemaName: string): Promise<boolean> {
  const before = await withSchema(dbA, schemaName, async (container) => (await onePost(container, IDS.publicPost))?.shareNum ?? -1);
  await Promise.all([
    withSchema(dbA, schemaName, (container) => new CommunityService(container).share(IDS.publicPost)),
    withSchema(dbB, schemaName, (container) => new CommunityService(container).share(IDS.publicPost)),
  ]);
  return withSchema(dbA, schemaName, async (container) => (await onePost(container, IDS.publicPost))?.shareNum === before + 2);
}

async function runConcurrentCommentLike(
  dbA: DbClient,
  dbB: DbClient,
  schemaName: string,
  commentId: number,
): Promise<boolean> {
  await Promise.all([
    withSchema(dbA, schemaName, (container) => new CommunityService(container).likeComment(IDS.userC, commentId, 1)),
    withSchema(dbB, schemaName, (container) => new CommunityService(container).likeComment(IDS.userC, commentId, 1)),
  ]);
  return withSchema(dbA, schemaName, async (container) => {
    const row = await oneComment(container, commentId);
    const relations = await container.db.select({ id: communityRelevance.id }).from(communityRelevance)
      .where(and(
        eq(communityRelevance.leftId, IDS.userC),
        eq(communityRelevance.rightId, commentId),
        eq(communityRelevance.type, "community_comment_like"),
      ));
    return row?.likeNum === 1 && relations.length === 1;
  });
}

async function runCommentDelete(container: Container, topId: number, replyId: number) {
  const client = new CommunityService(container);
  let crossUserDeleteRejected = false;
  try {
    await client.deleteComment(IDS.userB, topId);
  } catch (error) {
    crossUserDeleteRejected = error instanceof ValidateException;
  }
  assertCondition(crossUserDeleteRejected, "cross-user comment delete was accepted");
  await client.deleteComment(IDS.userA, topId);
  const [top, reply, post, remainingLikes] = await Promise.all([
    oneComment(container, topId),
    oneComment(container, replyId),
    onePost(container, IDS.publicPost),
    container.db.select({ id: communityRelevance.id }).from(communityRelevance)
      .where(and(
        eq(communityRelevance.rightId, replyId),
        eq(communityRelevance.type, "community_comment_like"),
      )),
  ]);
  const ownerDeleteCascadeExact = top?.isDel === 1 && reply?.isDel === 1
    && post?.commentNum === 0 && remainingLikes.length === 0;
  assertCondition(ownerDeleteCascadeExact, "owner comment cascade diverged");
  return {
    cross_user_delete_rejected: crossUserDeleteRejected,
    owner_delete_cascade_exact: ownerDeleteCascadeExact,
  };
}

export async function runCommunityClientPostgresScenario(
  connectionString: string,
): Promise<CommunityClientPostgresReport> {
  const schemaName = makeSchemaName();
  const schema = identifier(schemaName);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_community_client_audit_root",
  });
  const scopedA = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_community_client_audit_a",
  });
  const scopedB = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_community_client_audit_b",
  });
  let created = false;
  let removed = false;
  let before: PublicFingerprint | undefined;
  let after: PublicFingerprint | undefined;
  let temporarySchemasAfter = -1;
  let core: Awaited<ReturnType<typeof runCore>> | undefined;
  let concurrentShareExact = false;
  let concurrentLikeIdempotent = false;
  let deletes: Awaited<ReturnType<typeof runCommentDelete>> | undefined;
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
    concurrentShareExact = await auditStep(
      "concurrent-share",
      () => runConcurrentShare(scopedA, scopedB, schemaName),
    );
    assertCondition(concurrentShareExact, "concurrent share count drifted");
    concurrentLikeIdempotent = await auditStep(
      "concurrent-comment-like",
      () => runConcurrentCommentLike(scopedA, scopedB, schemaName, core!.replyId),
    );
    assertCondition(concurrentLikeIdempotent, "concurrent comment like was not idempotent");
    deletes = await auditStep(
      "comment-delete",
      () => withSchema(scopedA, schemaName, (container) => runCommentDelete(container, core!.topId, core!.replyId)),
    );
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
            WHERE nspname LIKE 'codex_community_client_%') AS prefix_count
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
  assertCondition(core && deletes, "core report was not produced");
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
    posts: { ...core.posts, concurrent_share_exact: concurrentShareExact },
    comments: {
      ...core.comments,
      concurrent_like_idempotent: concurrentLikeIdempotent,
      ...deletes,
    },
    products: core.products,
    topics: core.topics,
  };
}
