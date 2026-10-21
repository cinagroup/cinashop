import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createApp } from "@/app";
import { createContainerFromDb, createDbFromConnectionString, withTx, type Container, type DbClient } from "@/lib/di";
import type { Env } from "@/env";
import { community, communityComment, communityRelevance, communityTopic, communityUser,
  storeProduct, storeProductLog, systemAttachment, systemAttachmentCategory, systemConfig, systemUserLevel,
  user, userFriends, userRelation } from "@/models/schema";
import { CommunityService } from "@/services/community/CommunityService";
import { CommunitySocialService } from "@/services/community/CommunitySocialService";
import { AdminCommunityService } from "@/services/community/AdminCommunityService";
import { R2_IMAGE_TYPE } from "@/services/system/AttachmentService";
import { advanceRateWindows, type RateLimitPolicy, type RateWindow } from "@/services/out/OutRateLimitPolicy";
import { createToken, md5 } from "@/utils/jwt";
import { financePostgres, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from "./helpers/financePostgres";
import { runCommunityClientPostgresScenario } from "./integration/CommunityClientPostgresScenario";
import { runCommunitySocialPostgresScenario } from "./integration/CommunitySocialPostgresScenario";

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(),
  createContainer: () => { if (!wiring.container) throw Error("Missing owned engagement SQL"); return wiring.container; },
}));
type Row = Record<string, any>;
type Snapshot = Record<string, Row[]>;
const stable = (value: unknown) => JSON.stringify(value, (_key, part) => part && typeof part === "object" && !Array.isArray(part)
  ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);
const sorted = (value: Snapshot): Snapshot => Object.fromEntries(Object.entries(value).map(([key, rows]) =>
  [key, rows.slice().sort((a, b) => stable(a).localeCompare(stable(b)))]));

// Native row locks, independent sessions and real serial sequences. This ORM
// fixture intentionally does not stand in for production indexes/FKs/ACLs.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("native post engagement and exact read-only state", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, aDb: DbClient, bDb: DbClient;
  let container: Container, service: CommunityService, a: CommunityService, b: CommunityService;
  let env: Env, token: string, otherToken: string, ownedUrl: string, aPid: number, bPid: number;
  const cache = new Map<string, string>(), rateStates = new Map<string, Record<string, RateWindow>>();
  const tables = ["community", "community_comment", "community_relevance", "community_topic", "community_user",
    "store_product", "store_product_log", "system_attachment", "system_attachment_category", "system_config",
    "system_user_level", "user", "user_friends", "user_relation"];
  const app = createApp();
  beforeAll(async () => {
    f = await financePostgres([community, communityComment, communityRelevance, communityTopic, communityUser,
      storeProduct, storeProductLog, systemAttachment, systemAttachmentCategory, systemConfig, systemUserLevel,
      user, userFriends, userRelation], { namespace: "public" });
    container = createContainerFromDb(f.db); wiring.container = container; service = new CommunityService(container);
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
    const [identity] = await f.db.execute<{ database: string }>(sql`SELECT current_database() AS database`);
    if (!identity || !ownsFinanceFixtureTarget(identity.database, "public", base.href)) throw Error("Unowned engagement peer target");
    base.pathname = `/${identity.database}`; ownedUrl = base.href;
    aDb = createDbFromConnectionString(ownedUrl, 1, { searchPath: "public", applicationName: "community_engagement_a" });
    bDb = createDbFromConnectionString(ownedUrl, 1, { searchPath: "public", applicationName: "community_engagement_b" });
    a = new CommunityService(createContainerFromDb(aDb)); b = new CommunityService(createContainerFromDb(bDb));
    env = { APP_KEY: "owned-community-engagement-fixture", NODE_ENV: "test", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "",
      CONFIG_KV: { get: async (key: string) => cache.get(key) ?? null, put: async (key: string, value: string) => { cache.set(key, value); },
        delete: async (key: string) => { cache.delete(key); } },
      ASSETS_BUCKET: { get: vi.fn(async () => null), put: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
      ORDER_QUEUE: { send: vi.fn(async () => {}) },
      TOKEN_BUCKET: { getByName: (name: string) => ({ consumeRateLimit: async (policies: RateLimitPolicy[], seconds: number) => {
        const next = advanceRateWindows(rateStates.get(name) ?? {}, policies, Date.now(), seconds);
        rateStates.set(name, next.windows); return next.decision;
      } }) },
    } as unknown as Env;
    token = (await createToken(11, "api", md5("synthetic-engagement-password"), env.APP_KEY)).token;
    otherToken = (await createToken(22, "api", md5("synthetic-engagement-password"), env.APP_KEY)).token;
  }, 30_000);
  afterAll(async () => {
    wiring.container = undefined;
    await Promise.all([aDb?.$client.end({ timeout: 5 }), bDb?.$client.end({ timeout: 5 })]);
    await f?.close();
  });
  beforeEach(async () => {
    await f.reset(); cache.clear(); rateStates.clear();
    aPid = (await aDb.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid;
    bPid = (await bDb.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid;
    expect(aPid).not.toBe(bPid);
    await f.db.insert(user).values([11, 22, 33].map(uid => ({ uid, account: `engagement-${uid}`,
      nickname: `真实作者${uid}`, avatar: `real-${uid}.svg`, pwd: "synthetic-engagement-password", status: 1, isDel: 0 })));
    await f.db.insert(communityUser).values([
      { id: 100, type: 0, relationId: 0, nickname: "平台", likeNum: 30 },
      { id: 110, type: 2, relationId: 11, likeNum: 0 }, { id: 220, type: 2, relationId: 22, likeNum: 17 },
      { id: 330, type: 1, relationId: 22, nickname: "门店22", likeNum: 101 },
      { id: 440, type: 3, relationId: 22, nickname: "虚拟22", likeNum: 202 },
      { id: 550, type: 0, relationId: 22, nickname: "异型平台22", likeNum: 303 },
      { id: 601, type: 1, relationId: 0, likeNum: 999 }, { id: 602, type: 3, relationId: 0, likeNum: 999 },
      { id: 603, type: 2, relationId: 0, likeNum: 999 },
    ]);
    await f.db.insert(community).values([
      { id: 1, type: 2, relationId: 22, title: "公开帖", content: "完整互动", status: 1, isVerify: 1,
        likeNum: 7, playNum: 8, shareNum: 9, commentNum: 4 },
      { id: 2, type: 2, relationId: 11, title: "本人私有帖", status: 0, isVerify: 0, playNum: 5 },
      { id: 3, type: 0, relationId: 0, title: "平台帖", status: 1, isVerify: 1, likeNum: 2 },
      { id: 4, type: 1, relationId: 22, title: "门店帖", status: 1, isVerify: 1, likeNum: 2 },
      { id: 5, type: 3, relationId: 22, title: "虚拟帖", status: 1, isVerify: 1, likeNum: 2 },
      { id: 6, type: 2, relationId: 22, title: "删除帖", status: 1, isVerify: 1, isDel: 1 },
    ]);
    await f.db.insert(communityTopic).values({ id: 9, name: "真实话题", status: 1 });
    await f.db.insert(storeProduct).values({ id: 111, storeName: "真实关联商品", price: "12.34", isShow: 1, isVerify: 1 });
    await f.db.insert(communityRelevance).values([
      { id: 101, leftId: 1, rightId: 9, type: "community_topic" },
      { id: 102, leftId: 1, rightId: 111, type: "community_product" },
      { id: 103, leftId: 33, rightId: 22, type: "community_interest" },
    ]);
    await f.db.insert(systemConfig).values({ menuName: "site_url", value: '"https://shop.example.test"', status: 1 });
  });

  async function snapshot(db: DbClient = f.db): Promise<Snapshot> {
    const result: Snapshot = {};
    for (const name of tables) {
      const rows = await db.execute<{ row: Row }>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t`);
      result[name] = rows.map(row => row.row);
    }
    result.__sequences = await db.execute(sql`SELECT sequencename AS name, last_value::text AS last FROM pg_sequences
      WHERE schemaname = 'public' ORDER BY sequencename`);
    return sorted(result);
  }
  const post = (state: Snapshot, id = 1) => state.community.find(row => row.id === id)!;
  const profile = (state: Snapshot, id = 220) => state.community_user.find(row => row.id === id)!;
  function advance(wanted: Snapshot, table: string, id: number) {
    const name = `${table}_id_seq`, sequence = wanted.__sequences.find(row => row.name === name)!;
    expect(sequence).toBeDefined(); expect(id).toBe(sequence.last === null ? 1 : Number(sequence.last) + 1);
    wanted.__sequences = wanted.__sequences.map(row => row.name === name ? { ...row, last: String(id) } : row);
  }
  const relations = (state: Snapshot, type: string, actor = 11, id = 1) => state.community_relevance
    .filter(row => row.type === type && row.left_id === actor && row.right_id === id);
  function expectedLike(before: Snapshot, after: Snapshot, status: 0 | 1, actor = 11, id = 1) {
    const wanted = structuredClone(before), item = post(before, id), old = relations(before, "community_like", actor, id);
    const next = relations(after, "community_like", actor, id), delta = status === 1 && !old.length ? 1 : status === 0 && old.length ? -1 : 0;
    if (!delta) { expect(after).toEqual(before); return; }
    if (status === 1) {
      expect(next).toHaveLength(1); expect(next[0]).toEqual({ id: next[0].id, type: "community_like", left_id: actor, right_id: id });
      advance(wanted, "community_relevance", next[0].id); wanted.community_relevance.push(next[0]);
    } else { expect(next).toEqual([]); wanted.community_relevance = wanted.community_relevance.filter(row => !old.some(edge => edge.id === row.id)); }
    wanted.community = wanted.community.map(row => row.id === id ? { ...row, like_num: Math.max(0, item.like_num + delta) } : row);
    wanted.community_user = wanted.community_user.map(row => row.type === item.type && row.relation_id === item.relation_id && row.is_del === 0
      ? { ...row, like_num: Math.max(0, row.like_num + delta) } : row);
    expect(after).toEqual(sorted(wanted));
  }
  function expectedBrowse(before: Snapshot, after: Snapshot, actor?: number, id = 1, visits = 1) {
    const wanted = structuredClone(before);
    wanted.community = wanted.community.map(row => row.id === id ? { ...row, play_num: row.play_num + visits } : row);
    if (actor) {
      const old = relations(before, "community_browse", actor, id), next = relations(after, "community_browse", actor, id);
      expect(next).toHaveLength(1);
      if (!old.length) {
        expect(next[0]).toEqual({ id: next[0].id, type: "community_browse", left_id: actor, right_id: id });
        advance(wanted, "community_relevance", next[0].id); wanted.community_relevance.push(next[0]);
      }
    }
    expect(after).toEqual(sorted(wanted));
  }
  async function http(path: string, options: { method?: string; body?: unknown; viewer?: "actor" | "other" | "bad" } = {}) {
    const response = await app.request(`/api/community/${path}`, { method: options.method ?? "GET",
      headers: { "Content-Type": "application/json", ...(options.viewer ? { "Authori-zation": `Bearer ${options.viewer === "actor" ? token : options.viewer === "other" ? otherToken : "invalid-fixture-token"}` } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }, env);
    return { response, body: await response.json() as Row };
  }

  it("retains the entire old Client scenario, including concurrent shares, likes and owner cascades, without changing owned public state", async () => {
    const before = await snapshot(), report = await runCommunityClientPostgresScenario(ownedUrl);
    expect(report).toMatchObject({ schema_created: true, schema_removed: true, temporary_schemas_after: 0, public_state_unchanged: true,
      posts: { pending_owner_preview_only: true, cross_user_edit_rejected: true, edit_resets_review: true,
        filters_exact: true, like_and_elegant_lists_exact: true, concurrent_share_exact: true },
      comments: { nested_reply_shape_exact: true, list_and_reply_counts_exact: true, concurrent_like_idempotent: true,
        cross_user_delete_rejected: true, owner_delete_cascade_exact: true },
      products: { pay_deduplicated: true, visit_scoped: true, collect_scoped: true },
      topics: { visible_counts_exact: true, persisted_counts_exact: true } });
    expect(await snapshot()).toEqual(before);
  }, 30_000);
  it("retains the entire old Social scenario including per-visit browse semantics and singleton viewer relation", async () => {
    const before = await snapshot(), report = await runCommunitySocialPostgresScenario(ownedUrl);
    expect(report).toMatchObject({ schema_created: true, schema_removed: true, temporary_schemas_after: 0, public_state_unchanged: true,
      profile: { platform_profile_selected: true, description_persisted: true },
      follows: { replay_idempotent: true, mutual_flags: true, lists_deduplicated: true, unfollow_idempotent: true,
        historical_duplicates_removed: true, concurrent_insert_singleton: true, self_follow_rejected: true },
      discovery: { referral_friends: 2, actual_friend_flags: true, unread_before_browse: true,
        read_after_browse: true, browse_relation_rows: 1, play_count_delta: 2 },
      integrity: { missing_profile_materialized: true, duplicate_profile_rejected: true } });
    expect(await snapshot()).toEqual(before);
  }, 30_000);
  it("reads the complete exact post metadata repeatedly without any row or sequence mutation", async () => {
    const before = await snapshot();
    for (const viewer of [undefined, 11, 22]) {
      const data = await service.state(1, viewer);
      expect(data).toMatchObject({ id: 1, type: 2, relationId: 22, author: "真实作者22", author_image: "real-22.svg",
        likeNum: 7, like_num: 7, playNum: 8, play_num: 8, shareNum: 9, share_num: 9, commentNum: 4, comment_num: 4,
        isLike: 0, is_like: 0, is_self: viewer === 22 ? 1 : 0, topic_id: [9], product_id: [111],
        topic: [{ id: 9, name: "真实话题" }], product: [{ id: 111, store_name: "真实关联商品", image: "", price: "12.34" }] });
    }
    await service.state(1, 11); expect(await snapshot()).toEqual(before);
  });
  it("returns the same owned signed media fields as detail without persisting signatures or changing stored references", async () => {
    await f.db.insert(systemAttachment).values([50, 51].map((attId, i) => ({ attId, type: 3, moduleType: 3, relationId: 22,
      fileType: i ? 2 : 1, imageType: R2_IMAGE_TYPE, attType: i ? "video/mp4" : "image/png",
      name: `attachments/user/22/state-${attId}`, attDir: `/api/assets/${attId}`, sattDir: `/api/assets/${attId}` })));
    await f.db.update(community).set({ image: "/api/assets/50", sliderImage: '["/api/assets/50"]', videoUrl: "/api/assets/51", contentType: 2 })
      .where(eq(community.id, 1));
    const before = await snapshot(), data = await new CommunityService(container, env.APP_KEY).state(1, 11);
    expect(data).toMatchObject({ image_reference: "/api/assets/50", slider_image_references: ["/api/assets/50"], video_reference: "/api/assets/51" });
    for (const value of [data.image, data.sliderImage[0], data.videoUrl]) expect(value).toContain("signature=");
    expect(await snapshot()).toEqual(before);
  });
  it.each([0, -1, -2])("keeps an own isVerify=%s preview readable but denies anonymous, foreign and same-number typed owners", async isVerify => {
    await f.db.update(community).set({ isVerify }).where(eq(community.id, 2));
    const before = await snapshot(); expect((await service.state(2, 11)).id).toBe(2);
    for (const uid of [undefined, 22, 33]) await expect(service.state(2, uid)).rejects.toThrow("帖子不存在");
    for (const type of [0, 1, 3]) {
      await f.db.update(community).set({ type }).where(eq(community.id, 2));
      const own = await snapshot(); await expect(service.state(2, 11)).rejects.toThrow("帖子不存在"); expect(await snapshot()).toEqual(own);
    }
    await f.db.update(community).set({ type: 2 }).where(eq(community.id, 2)); expect(await snapshot()).toEqual(before);
  });
  it("rejects malformed, overflowing, missing and deleted exact state targets without any write", async () => {
    const before = await snapshot();
    for (const id of [0, -1, 1.5, NaN, Infinity, 2_147_483_648, 6, 999]) await expect(service.state(id, 11)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it("serves optional-auth state with current viewer flags, configured normalized frontend site URL and no-store", async () => {
    await service.like(11, 1, 1); const before = await snapshot();
    for (const viewer of [undefined, "actor", "other", "bad"] as const) {
      const { response, body } = await http("state/1", { viewer });
      expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(body.status).toBe(200); expect(body.data).toMatchObject({ id: 1, likeNum: 8, isLike: viewer === "actor" ? 1 : 0,
        site_url: "https://shop.example.test", playNum: 8, shareNum: 9 });
    }
    expect((await http("state/2", { viewer: "actor" })).body.status).toBe(200);
    expect((await http("state/2", { viewer: "other" })).body.status).not.toBe(200);
    expect((await http("state/2")).body.status).not.toBe(200);
    expect((await http("state/2", { viewer: "bad" })).body.status).not.toBe(200); expect(await snapshot()).toEqual(before);
  });
  it("keeps new and PHP post-like HTTP aliases authenticated, explicit and idempotent", async () => {
    const initial = await snapshot();
    for (const path of ["like/1", "community_like/1"]) {
      expect((await http(path, { method: "POST", body: { status: 1 } })).body.status).not.toBe(200);
      expect((await http(path, { method: "POST", body: { status: 1 }, viewer: "bad" })).body.status).not.toBe(200);
    }
    expect(await snapshot()).toEqual(initial);
    const first = await http("community_like/1", { method: "POST", body: { status: 1 }, viewer: "actor" });
    expect(first.body.data).toEqual({ likeNum: 8, status: 1 }); const liked = await snapshot(); expectedLike(initial, liked, 1);
    expect((await http("like/1", { method: "POST", body: { status: 1 }, viewer: "actor" })).body.data).toEqual(first.body.data);
    expect(await snapshot()).toEqual(liked);
    expect((await http("like/1", { method: "POST", body: { status: 0 }, viewer: "actor" })).body.data).toEqual({ likeNum: 7, status: 0 });
    expectedLike(liked, await snapshot(), 0);
  });
  it("keeps authenticated legacy share GET a noncached atomic write and denies public or invalid-token callers", async () => {
    const before = await snapshot();
    for (const viewer of [undefined, "bad"] as const) expect((await http("share/1", { viewer })).body.status).not.toBe(200);
    expect(await snapshot()).toEqual(before);
    const result = await http("share/1", { viewer: "actor" }); expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect(result.body.data).toEqual({ shareNum: 10 }); const wanted = structuredClone(before);
    wanted.community = wanted.community.map(row => row.id === 1 ? { ...row, share_num: 10 } : row); expect(await snapshot()).toEqual(sorted(wanted));
    const detail = await http("detail/1", { viewer: "actor" }); expect(detail.response.headers.get("Cache-Control")).toBe("no-store");
    expect(detail.body.data).toMatchObject({ site_url: "https://shop.example.test", shareNum: 10, playNum: 9 });
    const afterVisit = await snapshot(); expectedBrowse(sorted(wanted), afterVisit, 11);
    const state = await http("state/1", { viewer: "actor" }); expect(state.body.data).toEqual(detail.body.data);
    expect(await snapshot()).toEqual(afterVisit);
  });
  it("returns an empty site URL when no frontend site is configured, never substituting the API origin", async () => {
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName, "site_url")); cache.delete("cfg_site_url");
    const before = await snapshot(), response = await http("state/1", { viewer: "actor" });
    expect(response.body.data.site_url).toBe(""); expect(await snapshot()).toEqual(before);
  });
  it("retains optional-auth legacy browse PUT, counts every public visit and denies even the private post owner", async () => {
    let before = await snapshot();
    for (const [viewer, count] of [[undefined, 9], ["actor", 10], ["bad", 11]] as const) {
      const result = await http("browse/1", { method: "PUT", viewer });
      expect(result.body.status).toBe(200); expect(result.body.data).toBeNull();
      const after = await snapshot(); expect(post(after).play_num).toBe(count);
      expectedBrowse(before, after, viewer === "actor" ? 11 : undefined); before = after;
    }
    expect((await http("browse/2", { method: "PUT", viewer: "actor" })).body.status).not.toBe(200);
    expect(await snapshot()).toEqual(before);
  });
  it("uses explicit like/unlike state, preserves historical counters and makes both desired replays zero-change", async () => {
    const before = await snapshot(); expect(await service.like(11, 1, 0)).toEqual({ likeNum: 7, status: 0 }); expect(await snapshot()).toEqual(before);
    expect(await service.like(11, 1, 1)).toEqual({ likeNum: 8, status: 1 }); const liked = await snapshot(); expectedLike(before, liked, 1);
    expect(await service.like(11, 1, 1)).toEqual({ likeNum: 8, status: 1 }); expect(await snapshot()).toEqual(liked);
    expect(await service.like(11, 1, 0)).toEqual({ likeNum: 7, status: 0 }); const unliked = await snapshot(); expectedLike(liked, unliked, 0);
    expect(await service.like(11, 1, 0)).toEqual({ likeNum: 7, status: 0 }); expect(await snapshot()).toEqual(unliked);
  });
  it.each([[0, 3, 100], [1, 4, 330], [2, 1, 220], [3, 5, 440]])(
    "updates only exact author type%s for post%s and profile%s while preserving numeric-ID collisions", async (_type, id, profileId) => {
      const before = await snapshot(); await a.like(11, id, 1); const after = await snapshot(); expectedLike(before, after, 1, 11, id);
      expect(profile(after, profileId).like_num).toBe(profile(before, profileId).like_num + 1);
      expect(after.community_user.filter(row => row.id !== profileId)).toEqual(before.community_user.filter(row => row.id !== profileId));
      await b.like(11, id, 0); expectedLike(after, await snapshot(), 0, 11, id);
    },
  );
  it("preserves the existing same-canonical multi-profile update and never materializes a missing or deleted profile", async () => {
    await f.db.insert(communityUser).values({ id: 221, type: 2, relationId: 22, likeNum: 99 });
    const before = await snapshot(); await service.like(11, 1, 1); const after = await snapshot(); expectedLike(before, after, 1);
    expect(profile(after, 220).like_num).toBe(18); expect(profile(after, 221).like_num).toBe(100);
    await service.like(11, 1, 0); await f.db.delete(communityUser).where(eq(communityUser.id, 220));
    await f.db.update(communityUser).set({ isDel: 1 }).where(eq(communityUser.id, 221));
    const missing = await snapshot(); await service.like(11, 1, 1); expectedLike(missing, await snapshot(), 1);
    expect((await snapshot()).community_user).toEqual(missing.community_user);
  });
  it("removes every historical duplicate like edge on unlike but decrements post and typed author only once", async () => {
    await f.db.insert(communityRelevance).values([201, 202, 203].map(id => ({ id, leftId: 11, rightId: 1, type: "community_like" })));
    const before = await snapshot(); expect(await service.like(11, 1, 0)).toEqual({ likeNum: 6, status: 0 });
    expectedLike(before, await snapshot(), 0); expect((await service.state(1, 11)).isLike).toBe(0);
  });
  it("clamps historical zero post and typed-author counters when removing an existing like, including its replay", async () => {
    await f.db.update(community).set({ likeNum: 0 }).where(eq(community.id, 1));
    await f.db.update(communityUser).set({ likeNum: 0 }).where(eq(communityUser.id, 220));
    await f.db.insert(communityRelevance).values({ id: 201, leftId: 11, rightId: 1, type: "community_like" });
    const before = await snapshot(); expect(await service.like(11, 1, 0)).toEqual({ likeNum: 0, status: 0 });
    const after = await snapshot(); expectedLike(before, after, 0);
    expect(await service.like(11, 1, 0)).toEqual({ likeNum: 0, status: 0 }); expect(await snapshot()).toEqual(after);
  });
  it("keeps concurrent same-actor likes and unlikes singleton across genuinely independent sessions", async () => {
    const before = await snapshot();
    expect(await Promise.all([a.like(11, 1, 1), b.like(11, 1, 1)])).toEqual([{ likeNum: 8, status: 1 }, { likeNum: 8, status: 1 }]);
    const liked = await snapshot(); expectedLike(before, liked, 1);
    expect(await Promise.all([a.like(11, 1, 0), b.like(11, 1, 0)])).toEqual([{ likeNum: 7, status: 0 }, { likeNum: 7, status: 0 }]);
    expectedLike(liked, await snapshot(), 0);
  });
  it("keeps independent actors on different posts of the same typed author from losing aggregate counter updates", async () => {
    await f.db.insert(community).values({ id: 7, type: 2, relationId: 22, title: "同作者另一帖", status: 1, isVerify: 1, likeNum: 5 });
    const before = await snapshot();
    expect(await Promise.all([a.like(11, 1, 1), b.like(33, 7, 1)])).toEqual([{ likeNum: 8, status: 1 }, { likeNum: 6, status: 1 }]);
    const after = await snapshot(), wanted = structuredClone(before);
    const added = after.community_relevance.filter(row => row.type === "community_like").sort((x, y) => x.id - y.id);
    expect(added.map(row => [row.left_id, row.right_id]).sort((x, y) => x[0] - y[0])).toEqual([[11, 1], [33, 7]]);
    for (const edge of added) { advance(wanted, "community_relevance", edge.id); wanted.community_relevance.push(edge); }
    wanted.community = wanted.community.map(row => row.id === 1 || row.id === 7 ? { ...row, like_num: row.like_num + 1 } : row);
    wanted.community_user = wanted.community_user.map(row => row.id === 220 ? { ...row, like_num: row.like_num + 2 } : row);
    expect(after).toEqual(sorted(wanted));
    expect(await Promise.all([a.like(11, 1, 0), b.like(33, 7, 0)])).toEqual([{ likeNum: 7, status: 0 }, { likeNum: 5, status: 0 }]);
    const unliked = structuredClone(before); unliked.__sequences = wanted.__sequences;
    expect(await snapshot()).toEqual(sorted(unliked));
  });
  async function waitBlocked(blockedPid: number, blockerPid: number) {
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      const [row] = await f.db.execute<{ blocked: boolean }>(sql`SELECT ${blockerPid} = ANY(pg_blocking_pids(${blockedPid})) AS blocked`);
      if (row?.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error("Expected independent backend did not enter the owned lock wait");
  }
  it.each([0, 1] as const)("serializes a competing opposite desired state after committed status%s", async first => {
    if (first === 0) await service.like(11, 1, 1);
    let unlock!: () => void, ready!: () => void;
    const hold = new Promise<void>(resolve => { unlock = resolve; }), entered = new Promise<void>(resolve => { ready = resolve; });
    let committed!: Snapshot;
    const leading = withTx(createContainerFromDb(aDb), async tx => {
      await new CommunityService(createContainerFromDb(tx)).like(11, 1, first); committed = await snapshot(tx); ready(); await hold;
    });
    await Promise.race([entered, leading.then(() => { throw Error("Leading operation did not hold its transaction"); })]);
    const next: 0 | 1 = first === 1 ? 0 : 1, follower = Promise.allSettled([b.like(11, 1, next)]);
    let waitError: unknown; try { await waitBlocked(bPid, aPid); } catch (error) { waitError = error; } finally { unlock(); }
    await leading; const result = await follower; if (waitError) throw waitError;
    expect(result[0].status).toBe("fulfilled"); expectedLike(committed, await snapshot(), next);
  });
  it.each([{ label: "hidden", values: { status: 0 } }, { label: "pending", values: { isVerify: 0 } },
    { label: "deleted", values: { isDel: 1 } }])("denies all public engagement writes for a $label parent without counter/sequence changes", async ({ values }) => {
    await f.db.update(community).set(values).where(eq(community.id, 1)); const before = await snapshot();
    for (const status of [0, 1]) await expect(service.like(11, 1, status)).rejects.toThrow("帖子不存在");
    await expect(service.share(1)).rejects.toThrow("帖子不存在");
    await expect(new CommunitySocialService(container).recordBrowse(1, 11)).rejects.toThrow("帖子不存在");
    await expect(service.state(1, 11)).rejects.toThrow("帖子不存在"); expect(await snapshot()).toEqual(before);
  });
  it.each((["hide", "review", "delete"] as const).flatMap(action =>
    (["state", "like", "share"] as const).map(operation => ({ action, operation }))))(
    "rechecks committed Admin $action after a real independent $operation lock wait", async ({ action, operation }) => {
    let unlock!: () => void, ready!: () => void, committed!: Snapshot;
    const hold = new Promise<void>(resolve => { unlock = resolve; }), entered = new Promise<void>(resolve => { ready = resolve; });
    const moderator = withTx(createContainerFromDb(aDb), async tx => {
      const admin = new AdminCommunityService(createContainerFromDb(tx));
      if (action === "hide") await admin.setPostStatus(1, 0);
      else if (action === "review") await admin.setPostVerify(1, { is_verify: 0 });
      else await admin.deletePost(1);
      committed = await snapshot(tx); ready(); await hold;
    });
    await Promise.race([entered, moderator.then(() => { throw Error("Moderator did not hold its transaction"); })]);
    const waiting = Promise.allSettled([operation === 'like' ? b.like(11, 1, 1) : operation === 'share' ? b.share(1) : b.state(1, 11)]);
    let waitError: unknown; try { await waitBlocked(bPid, aPid); } catch (error) { waitError = error; } finally { unlock(); }
    await moderator; const result = await waiting; if (waitError) throw waitError;
    expect(result.map(row => row.status)).toEqual(["rejected"]); expect(await snapshot()).toEqual(committed);
  });
  it("makes state wait for an in-progress real like and then returns matching committed count/flag without an extra mutation", async () => {
    let unlock!: () => void, ready!: () => void, committed!: Snapshot;
    const hold = new Promise<void>(resolve => { unlock = resolve; }), entered = new Promise<void>(resolve => { ready = resolve; });
    const writer = withTx(createContainerFromDb(aDb), async tx => {
      await new CommunityService(createContainerFromDb(tx)).like(11, 1, 1); committed = await snapshot(tx); ready(); await hold;
    });
    await Promise.race([entered, writer.then(() => { throw Error("Writer did not hold its transaction"); })]);
    const read = Promise.allSettled([b.state(1, 11)]);
    let waitError: unknown; try { await waitBlocked(bPid, aPid); } catch (error) { waitError = error; } finally { unlock(); }
    await writer; const result = await read; if (waitError) throw waitError;
    expect(result[0].status).toBe("fulfilled"); if (result[0].status === "fulfilled") expect(result[0].value).toMatchObject({ likeNum: 8, isLike: 1 });
    expect(await snapshot()).toEqual(committed);
  });
  it("holds its shared post lock across the real formatting queries so an in-progress state cannot mix a later like flag with an older count", async () => {
    let unlock!: () => void, ready!: () => void;
    const hold = new Promise<void>(resolve => { unlock = resolve; }), entered = new Promise<void>(resolve => { ready = resolve; });
    const target = a as unknown as { formatPosts: (...args: any[]) => Promise<any> }, original = target.formatPosts.bind(a);
    const formatting = vi.spyOn(target, "formatPosts").mockImplementation(async (...args) => { ready(); await hold; return original(...args); });
    const before = await snapshot(), read = a.state(1, 11);
    try {
      await Promise.race([entered, read.then(() => { throw Error("State completed before its guarded projection"); })]);
      const writing = Promise.allSettled([b.like(11, 1, 1)]);
      let waitError: unknown; try { await waitBlocked(bPid, aPid); } catch (error) { waitError = error; } finally { unlock(); }
      expect(await read).toMatchObject({ likeNum: 7, isLike: 0 }); const result = await writing; if (waitError) throw waitError;
      expect(result[0].status).toBe("fulfilled"); expectedLike(before, await snapshot(), 1);
    } finally { unlock(); formatting.mockRestore(); }
  });
  it("records each public detail exactly once, never adds a second browse for subsequent state refresh and keeps one viewer relation", async () => {
    const before = await snapshot(), anonymous = await service.detail(1); expect(anonymous.playNum).toBe(9);
    const first = await snapshot(); expectedBrowse(before, first);
    expect((await service.detail(1, 11)).playNum).toBe(10); const second = await snapshot(); expectedBrowse(first, second, 11);
    expect((await service.detail(1, 11)).playNum).toBe(11); const third = await snapshot(); expectedBrowse(second, third, 11);
    expect((await service.state(1, 11)).playNum).toBe(11); expect(await snapshot()).toEqual(third);
  });
  it("retains own private detail preview without any browse row/counter/sequence and rejects foreign preview", async () => {
    const before = await snapshot(); expect((await service.detail(2, 11)).playNum).toBe(5);
    await expect(service.detail(2, 22)).rejects.toThrow("帖子不存在"); expect(await snapshot()).toEqual(before);
  });
  it("keeps concurrent detail and legacy browse visits atomic without introducing a lock-order deadlock", async () => {
    const before = await snapshot(), browse = new CommunitySocialService(createContainerFromDb(bDb));
    const result = await Promise.all([a.detail(1, 11), browse.recordBrowse(1, 11)]);
    expect(new Set([result[0].playNum, result[1].play_num])).toEqual(new Set([9, 10]));
    expectedBrowse(before, await snapshot(), 11, 1, 2);
  });
  it("keeps two independent share intents atomic while readonly state and other counters remain untouched", async () => {
    const before = await snapshot(), result = await Promise.all([a.share(1), b.share(1)]);
    expect(result.map(row => row.shareNum).sort((x, y) => x - y)).toEqual([10, 11]);
    const wanted = structuredClone(before); wanted.community = wanted.community.map(row => row.id === 1 ? { ...row, share_num: 11 } : row);
    expect(await snapshot()).toEqual(sorted(wanted)); expect((await service.state(1, 11)).shareNum).toBe(11);
    expect(await snapshot()).toEqual(sorted(wanted));
  });
});
