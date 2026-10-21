import { and, eq } from "drizzle-orm";
import { communityRelevance, communityUser, systemConfig, user, userFriends } from "@/models/schema";
import { communityAuthorFixture } from "./communityAuthorFixture";

/** Synthetic social histories inside the existing owned author/media fixture. */
export async function communityPeopleBrowserFixture() {
  const f = await communityAuthorFixture();
  try {
    const friendIds = Array.from({ length: 21 }, (_, index) => 101 + index);
    await f.db.insert(user).values(friendIds.map(uid => ({ uid, account: `people-${uid}`,
      nickname: `好友作者${uid}`, status: 1, isDel: 0 })));
    for (const uid of [11, 22, ...friendIds]) {
      const rows = await f.db.select().from(communityUser).where(and(eq(communityUser.type, 2), eq(communityUser.relationId, uid)));
      if (rows.length > 1) throw Error("Ambiguous owned social fixture profile");
      const values = { nickname: `规范资料${uid}`, description: `规范作者简介${uid}`, status: uid === 101 ? 0 : 1,
        isDel: 0, communityNum: uid === 11 ? 3 : 1, followNum: uid === 11 ? 2 : uid === 22 ? 1 : 0,
        fansNum: [11, 22, 101].includes(uid) ? 1 : 0, friendNum: uid === 11 ? 22 : uid === 22 ? 1 : 0 };
      if (rows.length) await f.db.update(communityUser).set(values).where(eq(communityUser.id, rows[0].id));
      else await f.db.insert(communityUser).values({ type: 2, relationId: uid, ...values });
    }
    const [platform] = await f.db.insert(communityUser).values({ type: 0, relationId: 0, nickname: "平台规范资料",
      description: "平台可关注作者", communityNum: 9, fansNum: 100, status: 1, isDel: 0 }).returning();
    const spectators = await f.db.insert(communityUser).values([0, 22, 101].flatMap(relationId => [1, 3, ...(relationId ? [0] : [])]
      .map(type => ({ type, relationId, nickname: `异型旁观${type}-${relationId}`, avatar: "", description: "此资料不能冒充规范作者",
        communityNum: 999, followNum: 999, fansNum: 999999, status: 1, isDel: 0 })))).returning();
    // PHP pages friends by community profile ID: 121..102, then 101 and 22.
    await f.db.insert(userFriends).values([...friendIds, 22].map(friendsUid => ({ uid: 11, friendsUid })));
    await f.db.insert(communityRelevance).values([
      { leftId: 11, rightId: 101, type: "community_interest" },
      { leftId: 11, rightId: 22, type: "community_interest" },
      { leftId: 22, rightId: 11, type: "community_interest" },
    ]);
    await f.db.insert(systemConfig).values([
      { menuName: "site_name", value: "规范平台作者", status: 1 },
      { menuName: "wap_login_logo", value: "", status: 1 },
    ]);
    return { ...f, friendIds, platform, spectators,
      actorName: "视频作者11", authorName: "视频作者22", platformName: "规范平台作者",
      firstPageNames: friendIds.slice(1).reverse().map(id => `好友作者${id}`),
      allFriendNames: [...friendIds.slice().reverse().map(id => `好友作者${id}`), "视频作者22"] };
  } catch (error) { await f.close(); throw error; }
}
