import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { createContainerFromDb } from "@/lib/di";
import { community, communityRelevance, communityUser, systemConfig, systemUserLevel, user, userFriends } from "@/models/schema";
import { CommunitySocialService } from "@/services/community/CommunitySocialService";
import { financePostgres, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from "./helpers/financePostgres";
import { runCommunitySocialPostgresScenario } from "./integration/CommunitySocialPostgresScenario";

// Real PG16 verifies the correlated visibility predicates and native writes.
// Each test resets only this process's owned disposable fixture.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("native social author identity contract", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, service: CommunitySocialService;
  beforeAll(async () => {
    f = await financePostgres([user, communityUser, communityRelevance, community, userFriends, systemConfig, systemUserLevel], { namespace: "public" });
    service = new CommunitySocialService(createContainerFromDb(f.db));
  }, 30000);
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(user).values([11, 22, 33, 44, 55, 66].map(uid => ({
      uid, account: `social-${uid}`, nickname: `真实用户${uid}`, avatar: `account-${uid}.svg`,
      status: uid === 44 ? 0 : 1, isDel: uid === 55 ? 1 : 0,
    })));
    await f.db.insert(communityUser).values([
      { id: 101, type: 0, relationId: 0, nickname: "平台原资料", description: "平台简介", communityNum: 2, fansNum: 3, status: 1 },
      { id: 111, type: 2, relationId: 11, nickname: "旧昵称11", communityNum: 1, status: 1 },
      { id: 122, type: 2, relationId: 22, nickname: "旧昵称22", description: "真实简介22", communityNum: 2, fansNum: 5, status: 1 },
      { id: 133, type: 2, relationId: 33, nickname: "旧昵称33", communityNum: 1, fansNum: 7, status: 1 },
      { id: 144, type: 2, relationId: 44, communityNum: 9, fansNum: 999, status: 1 },
      { id: 155, type: 2, relationId: 55, communityNum: 9, fansNum: 999, status: 1 },
      { id: 177, type: 3, relationId: 77, nickname: "无账户虚拟作者", communityNum: 9, fansNum: 9999, status: 1 },
      { id: 188, type: 0, relationId: 88, nickname: "非规范平台作者", communityNum: 9, fansNum: 9999, status: 1 },
      { id: 199, type: 2, relationId: 0, nickname: "错误用户零", communityNum: 9, fansNum: 9999, status: 1 },
      { id: 200, type: 1, relationId: 0, nickname: "同号门店零", communityNum: 9, fansNum: 9999, status: 1 },
      { id: 201, type: 3, relationId: 0, nickname: "同号虚拟零", communityNum: 9, fansNum: 9999, status: 1 },
    ]);
    await f.db.insert(systemConfig).values([
      { menuName: "site_name", value: "规范平台", status: 1 },
      { menuName: "wap_login_logo", value: "platform.svg", status: 1 },
    ]);
  });

  const profiles = () => f.db.select().from(communityUser).orderBy(asc(communityUser.id));
  const snapshot = async () => ({
    profiles: await profiles(),
    relations: await f.db.select().from(communityRelevance).orderBy(asc(communityRelevance.id)),
    accounts: await f.db.select().from(user).orderBy(asc(user.uid)),
    friends: await f.db.select().from(userFriends).orderBy(asc(userFriends.id)),
    posts: await f.db.select().from(community).orderBy(asc(community.id)),
  });

  it("retains the complete existing isolated-schema social scenario and its concurrent/idempotent write contracts", async () => {
    const target = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
    const [identity] = await f.db.execute<{ database: string }>(sql`SELECT current_database() AS database`);
    if (!identity || !ownsFinanceFixtureTarget(identity.database, "public", target.href)) {
      throw Error("Social scenario requires this process's owned public fixture");
    }
    target.pathname = "/" + identity.database;
    const report = await runCommunitySocialPostgresScenario(target.href);
    expect(report).toMatchObject({
      schema_created: true, schema_removed: true, temporary_schemas_after: 0, public_state_unchanged: true,
      profile: { platform_profile_selected: true, description_persisted: true },
      follows: { replay_idempotent: true, mutual_flags: true, lists_deduplicated: true,
        unfollow_idempotent: true, historical_duplicates_removed: true,
        concurrent_insert_singleton: true, self_follow_rejected: true },
      discovery: { referral_friends: 2, actual_friend_flags: true, unread_before_browse: true,
        read_after_browse: true, browse_relation_rows: 1, play_count_delta: 2 },
      integrity: { missing_profile_materialized: true, duplicate_profile_rejected: true },
    });
  }, 30000);

  it.each([0, 1, 3])("ignores a newer type%s profile with the real author's numeric ID in every projection and follow write", async type => {
    await f.db.insert(communityUser).values({ id: 1000, type, relationId: 22, nickname: "同号异型作者",
      description: "不可冒充真实作者", communityNum: 99, fansNum: 99999, status: 1 });
    await f.db.insert(userFriends).values({ uid: 11, friendsUid: 22 });
    const before = await snapshot();
    const person = await service.profile(22, 11);
    expect(person).toMatchObject({ id: 122, type: 2, relation_id: 22, author: "真实用户22",
      author_image: "account-22.svg", desc: "真实简介22", fans_num: 5, community_num: 2 });
    expect((await service.friendList(11, 1, 20))[0]).toMatchObject({ id: 122, type: 2, relation_id: 22 });
    expect((await service.recommendations(11, 1, 20)).find(row => row.relation_id === 22)).toMatchObject({ id: 122, type: 2, fans_num: 5 });
    expect(await snapshot()).toEqual(before);
    expect(await service.setInterest(11, 22, 1)).toEqual({ status: 1, is_follow: 1, is_fans: 0 });
    expect(await service.setInterest(11, 22, 1)).toEqual({ status: 1, is_follow: 1, is_fans: 0 });
    expect(await profiles()).toEqual(before.profiles.map(row => row.id === 111 ? { ...row, followNum: 1 }
      : row.id === 122 ? { ...row, fansNum: 6 } : row));
    expect((await service.followList(11, "follow", 1, 20))[0]).toMatchObject({ id: 122, type: 2, fans_num: 6, is_follow: 1 });
    expect((await service.followList(22, "fans", 1, 20))[0]).toMatchObject({ id: 111, type: 2, relation_id: 11, is_fans: 1 });
    expect((await service.recommendations(11, 1, 20)).some(row => row.relation_id === 22)).toBe(false);
    const after = await snapshot();
    expect(after.relations).toHaveLength(1);
    expect(after.relations[0]).toMatchObject({ leftId: 11, rightId: 22, type: "community_interest" });
    expect({ ...after, profiles: before.profiles, relations: before.relations }).toEqual(before);
  });

  it("keeps platform zero separate from every colliding type and has no account fallback when its canonical profile is absent", async () => {
    const before = await snapshot();
    expect(await service.profile(0, 11)).toMatchObject({ id: 101, type: 0, relation_id: 0, author: "规范平台",
      author_image: "platform.svg", desc: "平台简介", community_num: 2, fans_num: 3 });
    await service.setInterest(11, 0, 1);
    expect((await service.followList(11, "follow", 1, 20))[0]).toMatchObject({ id: 101, type: 0, relation_id: 0, fans_num: 4 });
    expect(await profiles()).toEqual(before.profiles.map(row => row.id === 111 ? { ...row, followNum: 1 }
      : row.id === 101 ? { ...row, fansNum: 4 } : row));
    await service.setInterest(11, 0, 0);
    expect(await snapshot()).toEqual(before);
    await f.db.delete(communityUser).where(eq(communityUser.id, 101));
    await f.db.insert(communityRelevance).values([
      { leftId: 11, rightId: 0, type: "community_interest" },
      { leftId: 11, rightId: 22, type: "community_interest" },
    ]);
    const absent = await snapshot();
    await expect(service.profile(0, 11)).rejects.toThrow("用户不存在");
    await expect(service.setInterest(11, 0, 1)).rejects.toThrow("平台社区资料不存在");
    expect((await service.followList(11, "follow", 1, 1)).map(row => row.relation_id)).toEqual([22]);
    expect(await snapshot()).toEqual(absent);
  });

  it("paginates recommendations using the latest canonical profile's own eligibility and counters", async () => {
    await f.db.insert(user).values({ uid: 88, account: "social-88", nickname: "真实用户88", status: 1 });
    await f.db.insert(communityUser).values([
      { id: 1000, type: 3, relationId: 22, communityNum: 99, fansNum: 99999, status: 1 },
      { id: 1001, type: 0, relationId: 33, communityNum: 99, fansNum: 99999, status: 1 },
      { id: 1002, type: 1, relationId: 66, communityNum: 99, fansNum: 99999, status: 1 },
      { id: 1003, type: 2, relationId: 33, communityNum: 99, fansNum: 99999, status: 0 },
      { id: 1004, type: 2, relationId: 88, communityNum: 99, fansNum: 99999, status: 1 },
      { id: 1005, type: 2, relationId: 88, communityNum: 0, fansNum: 99999, status: 1 },
      { id: 1006, type: 2, relationId: 22, communityNum: 99, fansNum: 99999, status: 1, isDel: 1 },
    ]);
    const before = await snapshot();
    const first = await service.recommendations(11, 1, 1), second = await service.recommendations(11, 2, 1);
    expect(first).toHaveLength(1); expect(second).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: 122, type: 2, relation_id: 22, fans_num: 5 });
    expect(second[0]).toMatchObject({ id: 101, type: 0, relation_id: 0, fans_num: 3 });
    expect(await service.recommendations(11, 3, 1)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("filters unavailable follow/fan/friend identities before logical deduplication and page offsets", async () => {
    await f.db.insert(communityRelevance).values([
      ...[22, 33, 77, 44, 55, -9].map((id, index) => ({ id: 10 + index, leftId: 11, rightId: id, type: "community_interest" })),
      { id: 16, leftId: 11, rightId: 22, type: "community_interest" },
      ...[22, 33, 77, 44, 55, -9].map((id, index) => ({ id: 30 + index, leftId: id, rightId: 11, type: "community_interest" })),
    ]);
    await f.db.insert(userFriends).values([
      ...[22, 33, 77, 44, 55, -9].map((id, index) => ({ id: 10 + index, uid: 11, friendsUid: id })),
      { id: 9, uid: 22, friendsUid: 11 },
    ]);
    const before = await snapshot();
    for (const kind of ["follow", "fans"] as const) {
      const expected = kind === "follow" ? [22, 33] : [33, 22];
      expect((await service.followList(11, kind, 1, 1)).map(row => row.relation_id)).toEqual([expected[0]]);
      expect((await service.followList(11, kind, 2, 1)).map(row => row.relation_id)).toEqual([expected[1]]);
      expect(await service.followList(11, kind, 3, 1)).toEqual([]);
    }
    expect((await service.friendList(11, 1, 1)).map(row => row.relation_id)).toEqual([33]);
    expect((await service.friendList(11, 2, 1)).map(row => row.relation_id)).toEqual([22]);
    expect(await service.friendList(11, 3, 1)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("retains the active account fallback without reading or changing colliding or deleted profiles", async () => {
    await f.db.insert(communityUser).values([
      { id: 1000, type: 3, relationId: 66, nickname: "同号虚拟66", fansNum: 99999, communityNum: 99, status: 1 },
      { id: 1001, type: 2, relationId: 66, nickname: "已删除资料66", fansNum: 99999, communityNum: 99, status: 1, isDel: 1 },
    ]);
    await f.db.insert(userFriends).values({ uid: 11, friendsUid: 66 });
    await f.db.insert(communityRelevance).values({ leftId: 66, rightId: 11, type: "community_interest" });
    const before = await snapshot();
    expect(await service.profile(66, 11)).toMatchObject({ id: 0, type: 2, relation_id: 66, author: "真实用户66",
      author_image: "account-66.svg", desc: "", fans_num: 0, community_num: 0, is_fans: 1 });
    expect((await service.friendList(11, 1, 20))[0]).toMatchObject({ id: 0, type: 2, relation_id: 66 });
    expect((await service.followList(11, "fans", 1, 20))[0]).toMatchObject({ id: 0, type: 2, relation_id: 66 });
    expect((await service.recommendations(11, 1, 20)).some(row => row.relation_id === 66)).toBe(false);
    await expect(service.profile(77, 11)).rejects.toThrow("用户不存在");
    await expect(service.setInterest(11, 77, 1)).rejects.toThrow("用户不存在");
    expect(await snapshot()).toEqual(before);
    expect(await service.setInterest(11, 66, 1)).toEqual({ status: 1, is_follow: 1, is_fans: 1 });
    const after = await profiles(), created = after.filter(row => row.type === 2 && row.relationId === 66 && row.isDel === 0);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ nickname: "真实用户66", fansNum: 1, followNum: 0 });
    expect(after.filter(row => row.id !== created[0].id)).toEqual(before.profiles.map(row => row.id === 111 ? { ...row, followNum: 1 } : row));
    expect(await service.profile(66, 11)).toMatchObject({ id: created[0].id, type: 2, relation_id: 66, fans_num: 1, is_follow: 1 });
  });

  it("orders friends by the latest canonical community profile as PHP does and bounds pages before projecting rows", async () => {
    // Edge order deliberately disagrees with profile order. Missing profiles
    // retain the existing active-account fallback after real profile rows.
    await f.db.insert(userFriends).values([
      { id: 1, uid: 11, friendsUid: 33 },
      { id: 2, uid: 11, friendsUid: 22 },
      { id: 3, uid: 66, friendsUid: 11 },
      { id: 4, uid: 22, friendsUid: 11 },
      { id: 5, uid: 11, friendsUid: 11 },
      { id: 6, uid: 11, friendsUid: 0 },
    ]);
    const before = await snapshot();
    expect((await service.friendList(11, 1, 1)).map(row => row.relation_id)).toEqual([33]);
    expect((await service.friendList(11, 2, 1)).map(row => row.relation_id)).toEqual([22]);
    expect((await service.friendList(11, 3, 1)).map(row => row.relation_id)).toEqual([66]);
    expect(await service.friendList(11, 4, 1)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps disabled but readable canonical community profiles in relation lists without recommending them", async () => {
    await f.db.update(communityUser).set({ status: 0 }).where(eq(communityUser.id, 122));
    await f.db.insert(communityUser).values({ id: 1000, type: 3, relationId: 22, communityNum: 99, fansNum: 99999, status: 1 });
    await f.db.insert(communityRelevance).values([
      { leftId: 11, rightId: 22, type: "community_interest" },
      { leftId: 22, rightId: 11, type: "community_interest" },
    ]);
    await f.db.insert(userFriends).values({ uid: 11, friendsUid: 22 });
    const before = await snapshot();
    expect(await service.profile(22, 11)).toMatchObject({ id: 122, type: 2, status: 0 });
    expect((await service.followList(11, "follow", 1, 20))[0]).toMatchObject({ id: 122, status: 0, is_follow: 1, is_fans: 1 });
    expect((await service.followList(11, "fans", 1, 20))[0]).toMatchObject({ id: 122, status: 0 });
    expect((await service.friendList(11, 1, 20))[0]).toMatchObject({ id: 122, status: 0 });
    expect((await service.recommendations(33, 1, 20)).some(row => row.relation_id === 22)).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps duplicate canonical profile rejection and rolls back every business row instead of repairing ambiguity", async () => {
    await f.db.insert(communityUser).values([
      { id: 1000, type: 2, relationId: 22, nickname: "重复真实资料", description: "最新真实简介", status: 1 },
      { id: 1001, type: 0, relationId: 0, nickname: "重复平台资料", status: 1 },
    ]);
    const before = await snapshot();
    expect(await service.profile(22, 11)).toMatchObject({ id: 1000, type: 2, desc: "最新真实简介" });
    await expect(service.setInterest(11, 22, 1)).rejects.toThrow("社区用户资料存在重复");
    await expect(service.setInterest(11, 0, 1)).rejects.toThrow("平台社区资料存在重复");
    expect(await snapshot()).toEqual(before);
  });

  it("does not let unavailable follows fill the highlight cap or use an unrelated typed author's unread post", async () => {
    await f.db.insert(communityUser).values([
      { id: 1000, type: 3, relationId: 22, nickname: "异型22", status: 1 },
      ...Array.from({ length: 12 }, (_, i) => ({ id: 1100 + i, type: 3, relationId: 100 + i, nickname: `虚拟${i}`, status: 1 })),
    ]);
    await f.db.insert(community).values([
      { id: 220, type: 2, relationId: 22, title: "真实作者帖子", addTime: 100, status: 1, isVerify: 1 },
      { id: 999, type: 3, relationId: 22, title: "异型作者新帖子", addTime: 2000, status: 1, isVerify: 1 },
    ]);
    await f.db.insert(communityRelevance).values([
      { id: 1, leftId: 11, rightId: 22, type: "community_interest" },
      ...Array.from({ length: 12 }, (_, i) => ({ id: 10 + i, leftId: 11, rightId: 100 + i, type: "community_interest" })),
      { id: 100, leftId: 11, rightId: 220, type: "community_browse" },
    ]);
    const before = await snapshot();
    expect(await service.followHighlights(11)).toEqual([{ author: "真实用户22", author_image: "account-22.svg", relation_id: 22, is_new: 0 }]);
    expect(await snapshot()).toEqual(before);
  });
});
