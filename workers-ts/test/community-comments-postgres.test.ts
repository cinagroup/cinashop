import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { createContainerFromDb, withTx, type DbClient } from "@/lib/di";
import {
  community, communityComment, communityRelevance, communityTopic, communityUser,
  storeProduct, storeProductLog, systemConfig, user, userRelation,
} from "@/models/schema";
import { CommunityService } from "@/services/community/CommunityService";
import { AdminCommunityService } from "@/services/community/AdminCommunityService";
import { canReadCommunityPost } from "@/services/community/CommunityPostAccess";
import { financePostgres, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from "./helpers/financePostgres";
import { runCommunityClientPostgresScenario } from "./integration/CommunityClientPostgresScenario";

// These cases require real PG16 row/advisory locks and independent sessions.
// The coordinator creates a process-owned database; no shared public tables or
// sequences are used, including by the complete older integration scenario.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("native complete community comment threads", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let service: CommunityService, admin: AdminCommunityService;
  const tableNames = ["community", "community_comment", "community_relevance", "community_topic", "community_user",
    "store_product", "store_product_log", "system_config", "user", "user_relation"] as const;
  beforeAll(async () => {
    f = await financePostgres([community, communityComment, communityRelevance, communityTopic, communityUser,
      storeProduct, storeProductLog, systemConfig, user, userRelation], { namespace: "public" });
    const container = createContainerFromDb(f.db);
    service = new CommunityService(container);
    admin = new AdminCommunityService(container);
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(user).values([11, 22, 33].map(uid => ({ uid, account: `comments-${uid}`,
      nickname: `真实作者${uid}`, avatar: `real-${uid}.svg`, status: 1, isDel: 0 })));
    await f.db.insert(communityUser).values([11, 22, 33].map(uid => ({ type: 2, relationId: uid, status: 1 })));
    await f.db.insert(community).values([
      { id: 1, type: 2, relationId: 11, contentType: 1, title: "公开帖一", status: 1, isVerify: 1 },
      { id: 2, type: 2, relationId: 22, contentType: 1, title: "公开帖二", status: 1, isVerify: 1 },
      { id: 3, type: 2, relationId: 11, contentType: 1, title: "本人待审帖", status: 0, isVerify: 0 },
    ]);
    await f.db.insert(systemConfig).values([
      { menuName: "site_name", value: "配置平台", status: 1 },
      { menuName: "wap_login_logo", value: "configured-platform.svg", status: 1 },
    ]);
  });

  const comments = () => f.db.select().from(communityComment).orderBy(asc(communityComment.id));
  const post = async (id = 1) => (await f.db.select().from(community).where(eq(community.id, id)))[0]!;
  const receipt = async (db: DbClient = f.db) => {
    const tables: Record<string, unknown> = {};
    for (const table of tableNames) {
      tables[table] = await db.execute(sql.raw(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM "${table}" t`));
    }
    return { tables, sequences: await db.execute(sql`SELECT sequencename, last_value::text FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename`) };
  };
  const seed = async (values: Array<typeof communityComment.$inferInsert>) => f.db.insert(communityComment).values(values);
  const root = (id: number, extra: Partial<typeof communityComment.$inferInsert> = {}) => ({
    id, communityId: 1, uid: 11, type: 2, content: `根${id}`, isReply: 1,
    isShow: 1, isVerify: 1, isDel: 0, replyId: 0, addTime: 100, ...extra,
  });
  const child = (id: number, rootId: number, extra: Partial<typeof communityComment.$inferInsert> = {}) => ({
    ...root(id, extra), isReply: 0, replyId: rootId, replyUid: 11,
  });
  const add = (content: string, replyCommentId = 0, uid = 11, isVerify: 0 | 1 = 1) =>
    service.addComment(uid, { communityId: 1, content, replyCommentId, isVerify });

  it("retains the complete older client scenario, its public table/sequence receipt, concurrency and deletion assertions", async () => {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
    const [identity] = await f.db.execute<{ database: string }>(sql`SELECT current_database() AS database`);
    if (!identity || !ownsFinanceFixtureTarget(identity.database, "public", base.href)) throw Error("Unowned comment scenario target");
    base.pathname = `/${identity.database}`;
    const before = await receipt();
    const report = await runCommunityClientPostgresScenario(base.href);
    expect(report).toMatchObject({ schema_created: true, schema_removed: true, temporary_schemas_after: 0,
      public_state_unchanged: true,
      posts: { pending_owner_preview_only: true, cross_user_edit_rejected: true, edit_resets_review: true,
        filters_exact: true, like_and_elegant_lists_exact: true, concurrent_share_exact: true },
      comments: { nested_reply_shape_exact: true, list_and_reply_counts_exact: true, concurrent_like_idempotent: true,
        cross_user_delete_rejected: true, owner_delete_cascade_exact: true },
      products: { pay_deduplicated: true, visit_scoped: true, collect_scoped: true },
      topics: { visible_counts_exact: true, persisted_counts_exact: true } });
    expect(await receipt()).toEqual(before);
  }, 30_000);

  it("paginates readable roots newest first before offsets while distinguishing root, reply and public post totals", async () => {
    await seed([root(10), root(11, { uid: 22 }), root(12, { isShow: 0 }),
      root(13, { uid: 22, isShow: 0 }), root(14, { type: 3, isShow: 0 }), root(15, { type: 1, isShow: 0 }),
      root(16, { isVerify: 0 }), root(17, { isDel: 1 }), root(18, { isVerify: -1 }),
      child(20, 10), child(21, 10, { uid: 22 }), child(22, 10, { isShow: 0 }),
      child(23, 10, { uid: 22, isShow: 0 }), child(24, 10, { isVerify: 0 })]);
    await f.db.update(community).set({ commentNum: 4 }).where(eq(community.id, 1));
    const before = await receipt();
    for (const [page, expected] of [[1, 12], [2, 11], [3, 10]] as const) {
      const result = await service.commentList(1, page, 1, 11);
      expect(result).toMatchObject({ count: 3, post_comment_num: 4 });
      expect(result.list.map(row => row.id)).toEqual([expected]);
    }
    expect((await service.commentList(1, 1, 20)).list.map(row => row.id)).toEqual([11, 10]);
    expect((await service.commentList(1, 1, 20, 22)).list.map(row => row.id)).toEqual([13, 11, 10]);
    const first = await service.commentList(1, 1, 2, 11, 10), second = await service.commentList(1, 2, 2, 11, 10);
    expect(first.list.map(row => row.id)).toEqual([20, 21]);
    expect(second.list.map(row => row.id)).toEqual([22]);
    expect(first).toMatchObject({ count: 3, post_comment_num: 4 });
    expect((await service.commentList(1, 3, 2, 11, 10)).list).toEqual([]);
    expect((await service.commentList(1, 1, 20, 11)).list.find(row => row.id === 10)?.reply_count).toBe(3);
    expect(await receipt()).toEqual(before);
  });

  it("keeps own hidden-only replies expandable despite zero persisted public reply count", async () => {
    await seed([root(10), child(20, 10, { isShow: 0 }), child(21, 10, { isShow: 0, uid: 22 })]);
    const before = await receipt();
    expect((await service.commentList(1, 1, 10, 11)).list[0]).toMatchObject({ comment_num: 0, reply_count: 1 });
    expect((await service.commentList(1, 1, 10)).list[0]).toMatchObject({ comment_num: 0, reply_count: 0 });
    expect((await service.commentList(1, 1, 10, 11, 10)).list.map(row => row.id)).toEqual([20]);
    expect((await service.commentList(1, 1, 10, 22, 10)).list.map(row => row.id)).toEqual([21]);
    expect(await receipt()).toEqual(before);
  });

  it("reads an approved own hidden root without exposing its thread to anonymous, foreign or colliding typed viewers", async () => {
    await seed([root(10, { isShow: 0 }), child(20, 10, { uid: 22 })]);
    const before = await receipt();
    expect((await service.commentList(1, 1, 10, 11, 10)).list.map(row => row.id)).toEqual([20]);
    for (const uid of [undefined, 22, 33]) await expect(service.commentList(1, 1, 10, uid, 10)).rejects.toThrow("上级评论");
    for (const type of [0, 1, 3]) {
      await f.db.update(communityComment).set({ type }).where(eq(communityComment.id, 10));
      await expect(service.commentList(1, 1, 10, 11, 10)).rejects.toThrow("上级评论");
    }
    await f.db.update(communityComment).set({ type: 2 }).where(eq(communityComment.id, 10));
    expect(await receipt()).toEqual(before);
  });

  it("shares detail access without recording browse and only grants nonpublic preview to the exact real post owner", async () => {
    await seed([root(10, { communityId: 3 })]);
    const before = await receipt();
    expect((await service.commentList(3, 1, 10, 11)).list.map(row => row.id)).toEqual([10]);
    for (const uid of [undefined, 22, 33]) await expect(service.commentList(3, 1, 10, uid)).rejects.toThrow("帖子不存在");
    for (const type of [0, 1, 3]) {
      await f.db.update(community).set({ type }).where(eq(community.id, 3));
      expect(canReadCommunityPost(await post(3), 11)).toBe(false);
      await expect(service.commentList(3, 1, 10, 11)).rejects.toThrow("帖子不存在");
    }
    await f.db.update(community).set({ type: 2 }).where(eq(community.id, 3));
    expect(await receipt()).toEqual(before);
    await f.db.update(community).set({ isDel: 1 }).where(eq(community.id, 3));
    await expect(service.commentList(3, 1, 10, 11)).rejects.toThrow("帖子不存在");
  });

  it.each([
    { label: "unapproved", values: { isVerify: 0 } }, { label: "rejected", values: { isVerify: -1 } },
    { label: "deleted", values: { isDel: 1 } }, { label: "child-as-root", values: { isReply: 0 } },
    { label: "malformed-root", values: { replyId: 99 } }, { label: "cross-post", values: { communityId: 2 } },
  ])("rejects a $label reply root before reading rows or counts", async ({ values }) => {
    await seed([root(10, values), child(20, 10)]);
    const before = await receipt();
    await expect(service.commentList(1, 1, 10, 11, 10)).rejects.toThrow("上级评论");
    expect(await receipt()).toEqual(before);
  });

  it("rejects every malformed explicit reply id rather than silently returning the root list", async () => {
    await seed([root(10)]);
    const before = await receipt();
    for (const id of [-1, 1.5, NaN, Infinity, 2_147_483_648, "", "1.0", "x", null, true, []]) {
      await expect(service.commentList(1, 1, 10, 11, id)).rejects.toThrow("回复评论参数错误");
    }
    expect((await service.commentList(1, 2_147_483_647, 100, 11, "0")).list).toEqual([]);
    expect(await receipt()).toEqual(before);
  });

  it("hydrates real reply targets independently of the source type, platform zero and stored virtual/store identities", async () => {
    await seed([root(10, { uid: 22 }), root(11, { uid: 0, type: 0 }),
      root(12, { uid: 22, type: 3, nickname: "虚拟22", avatar: "virtual.svg" }),
      root(13, { uid: 22, type: 1, nickname: "门店22", avatar: "store.svg" }),
      child(20, 10, { uid: 0, type: 0 }), child(21, 10, { uid: 0, type: 3, nickname: "虚拟评论", commentReplyId: 20 }),
      child(22, 11), child(23, 12), child(24, 13), child(25, 10, { commentReplyId: 999, commentReplyUid: 22 }),
      root(30, { communityId: 2, uid: 22 }), child(26, 10, { commentReplyId: 30, commentReplyUid: 22 })]);
    const before = await receipt();
    const replies = (await service.commentList(1, 1, 20, 11, 10)).list;
    expect(replies.find(row => row.id === 20)).toMatchObject({ author: "配置平台", author_image: "configured-platform.svg",
      comment_author: "真实作者22", comment_author_image: "real-22.svg", comment_author_type: 2, comment_author_uid: 22 });
    expect(replies.find(row => row.id === 21)).toMatchObject({ author: "虚拟评论", comment_author: "配置平台",
      comment_author_image: "configured-platform.svg", comment_author_type: 0, comment_author_uid: 0 });
    expect((await service.commentList(1, 1, 10, 11, 11)).list[0]).toMatchObject({ comment_author: "配置平台", comment_author_uid: 0 });
    expect((await service.commentList(1, 1, 10, 11, 12)).list[0]).toMatchObject({ comment_author: "虚拟22", comment_author_type: 3 });
    expect((await service.commentList(1, 1, 10, 11, 13)).list[0]).toMatchObject({ comment_author: "门店22", comment_author_type: 1 });
    for (const id of [25, 26]) expect(replies.find(row => row.id === id)).toMatchObject({ comment_author: "",
      comment_author_type: null, comment_author_uid: null });
    expect(await receipt()).toEqual(before);
  });

  it("saves exact top/root/child ids and gives authoritative public totals and pending moderation feedback", async () => {
    const top = await add("顶层");
    expect(top).toEqual({ id: expect.any(Number), is_verify: 1, post_comment_num: 1 });
    const reply = await add("回复根", top.id, 22), nested = await add("回复子", reply.id, 33);
    expect(reply.post_comment_num).toBe(2); expect(nested.post_comment_num).toBe(3);
    const rows = await comments();
    expect(rows[0]).toMatchObject({ isReply: 1, replyId: 0, replyUid: 0, commentReplyId: 0, commentReplyUid: 0 });
    expect(rows[1]).toMatchObject({ isReply: 0, replyId: top.id, replyUid: 11, commentReplyId: 0, commentReplyUid: 0 });
    expect(rows[2]).toMatchObject({ isReply: 0, replyId: top.id, replyUid: 11, commentReplyId: reply.id, commentReplyUid: 22 });
    const pending = await add("待审", top.id, 11, 0);
    expect(pending).toEqual({ id: expect.any(Number), is_verify: 0, post_comment_num: 3 });
    expect((await service.commentList(1, 1, 10, 11, top.id)).list.map(row => row.id)).toEqual([reply.id, nested.id]);
    expect((await service.commentList(1, 1, 10, 11)).list[0]).toMatchObject({ comment_num: 2, reply_count: 2 });
    await admin.setCommentVerify(pending.id, { is_verify: 1 });
    expect((await post()).commentNum).toBe(4);
    expect((await service.commentList(1, 1, 10, 11, top.id)).count).toBe(3);
  });

  it("rejects malformed, missing, foreign, hidden and unapproved save targets without insert sequence movement", async () => {
    await seed([root(10), root(11, { communityId: 2 }), root(12, { isShow: 0 }), root(13, { isVerify: 0 }),
      root(14, { isDel: 1 }), root(15, { isReply: 0, replyId: 0 }), root(16, { replyId: 10 })]);
    const before = await receipt();
    for (const target of [-1, 1.5, NaN, 999, 11, 12, 13, 14, 15, 16]) await expect(add("不能写入", target)).rejects.toThrow();
    for (const content of ["", " ", "x".repeat(1001), "bad\u0001text"]) await expect(add(content)).rejects.toThrow();
    await expect(service.addComment(11, { communityId: 3, content: "预览不允许写入" })).rejects.toThrow("不可评论");
    expect(await receipt()).toEqual(before);
  });

  it.each([
    { label: "hidden", values: { isShow: 0 } }, { label: "pending", values: { isVerify: 0 } },
    { label: "deleted", values: { isDel: 1 } }, { label: "not-root", values: { isReply: 0 } },
    { label: "cross-post", values: { communityId: 2 } },
  ])("rejects nested saves and child likes under a $label root even when the child remains public", async ({ values }) => {
    await seed([root(10, values), child(20, 10)]);
    const before = await receipt();
    await expect(add("不可回复", 20, 22)).rejects.toThrow("上级评论");
    await expect(service.likeComment(22, 20, 1)).rejects.toThrow("上级评论");
    expect(await receipt()).toEqual(before);
  });

  it("keeps desired-state comment likes idempotent across sessions and removes historical duplicate relations on unlike", async () => {
    await seed([root(10), child(20, 10)]);
    const [a, b] = await Promise.all([service.likeComment(22, 20, 1), service.likeComment(22, 20, 1)]);
    expect(a).toEqual({ likeNum: 1, status: 1 }); expect(b).toEqual(a);
    expect(await service.likeComment(22, 20, 1)).toEqual(a);
    await f.db.insert(communityRelevance).values({ leftId: 22, rightId: 20, type: "community_comment_like" });
    expect(await service.likeComment(22, 20, 0)).toEqual({ likeNum: 0, status: 0 });
    expect(await service.likeComment(22, 20, 0)).toEqual({ likeNum: 0, status: 0 });
    expect(await f.db.select().from(communityRelevance).where(eq(communityRelevance.type, "community_comment_like"))).toEqual([]);
    expect((await comments()).find(row => row.id === 20)?.likeNum).toBe(0);
  });

  it("revalidates the public parent for both like statuses even for its exact owner preview", async () => {
    await seed([root(10, { communityId: 3 }), root(11, { isShow: 0 }), root(12, { isVerify: 0 })]);
    const before = await receipt();
    for (const id of [10, 11, 12]) for (const status of [0, 1]) await expect(service.likeComment(11, id, status)).rejects.toThrow();
    expect(await receipt()).toEqual(before);
  });

  it("preserves own hidden deletion, exact typed ownership, sibling survival and root cascade with authoritative public totals", async () => {
    const top = await add("顶层"), a = await add("子一", top.id), b = await add("子二", top.id, 22);
    await service.likeComment(33, a.id, 1); await service.likeComment(33, b.id, 1);
    await admin.setCommentStatus(a.id, 0);
    expect((await post()).commentNum).toBe(2);
    const beforeDenied = await receipt();
    await expect(service.deleteComment(22, top.id)).rejects.toThrow("自己的评论");
    await f.db.update(communityComment).set({ type: 3 }).where(eq(communityComment.id, a.id));
    await expect(service.deleteComment(11, a.id)).rejects.toThrow("自己的评论");
    await f.db.update(communityComment).set({ type: 2 }).where(eq(communityComment.id, a.id));
    expect(await receipt()).toEqual(beforeDenied);
    await service.deleteComment(11, a.id);
    expect((await comments()).find(row => row.id === b.id)).toMatchObject({ isDel: 0, likeNum: 1 });
    expect((await post()).commentNum).toBe(2);
    await admin.setCommentStatus(top.id, 0);
    await admin.setPostStatus(1, 0);
    await service.deleteComment(11, top.id);
    expect((await comments()).every(row => row.isDel === 1)).toBe(true);
    expect((await post()).commentNum).toBe(0);
    expect(await f.db.select().from(communityRelevance).where(eq(communityRelevance.type, "community_comment_like"))).toEqual([]);
  });

  // This polls a real owned-database lock wait, rather than relying on sleeps
  // to claim that moderation beat the competing request.
  async function waitForPostWaiter() {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const [row] = await f.db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 17349 AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
      if ((row?.count ?? 0) > 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error("Competing request did not wait on the owned post lifecycle lock");
  }

  it.each(["hide-root", "review-root", "delete-root", "hide-post"] as const)(
    "serializes %s before competing nested save and like, then rejects inaccessible reads",
    async action => {
      await seed([root(10), child(20, 10, { uid: 22 })]);
      let release!: () => void, locked!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { locked = resolve; });
      let expected: Awaited<ReturnType<typeof receipt>>;
      const moderator = withTx(createContainerFromDb(f.db), async tx => {
        const scoped = new AdminCommunityService(createContainerFromDb(tx));
        if (action === "hide-root") await scoped.setCommentStatus(10, 0);
        else if (action === "review-root") await scoped.setCommentVerify(10, { is_verify: 0 });
        else if (action === "delete-root") await scoped.deleteComment(10);
        else await scoped.setPostStatus(1, 0);
        expected = await receipt(tx);
        locked(); await held;
      });
      await Promise.race([ready, moderator.then(() => { throw Error("Moderator completed before exposing its held lock"); })]);
      const writes = Promise.allSettled([add("竞争回复", 20, 33), service.likeComment(33, 20, 1)]);
      let waitError: unknown;
      try { await waitForPostWaiter(); } catch (error) { waitError = error; } finally { release(); }
      await moderator;
      const outcomes = await writes;
      if (waitError) throw waitError;
      expect(outcomes.map(result => result.status)).toEqual(["rejected", "rejected"]);
      await expect(service.commentList(1, 1, 10, 33, 10)).rejects.toThrow();
      // The committed moderation is the sole mutation. A rejected insert must
      // not consume its serial; a rejected like must not create a relation.
      const after = await receipt();
      expect(after).toEqual(expected!);
      expect(await f.db.select().from(communityRelevance).where(and(eq(communityRelevance.type, "community_comment_like"), eq(communityRelevance.leftId, 33)))).toEqual([]);
      expect((await comments()).some(row => row.content === "竞争回复")).toBe(false);
    },
  );

  it("makes a concurrent thread reader wait for actual root moderation and rejects the newly hidden root without side effects", async () => {
    await seed([root(10), child(20, 10, { uid: 22 })]);
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    let expected: Awaited<ReturnType<typeof receipt>>;
    const moderator = withTx(createContainerFromDb(f.db), async tx => {
      await new AdminCommunityService(createContainerFromDb(tx)).setCommentStatus(10, 0);
      expected = await receipt(tx); locked(); await held;
    });
    await Promise.race([ready, moderator.then(() => { throw Error("Moderator completed before exposing its held lock"); })]);
    const read = Promise.allSettled([service.commentList(1, 1, 10, 33, 10)]);
    let waitError: unknown;
    try { await waitForPostWaiter(); } catch (error) { waitError = error; } finally { release(); }
    await moderator;
    const outcomes = await read;
    if (waitError) throw waitError;
    expect(outcomes[0]?.status).toBe("rejected");
    expect(await receipt()).toEqual(expected!);
  });
});
