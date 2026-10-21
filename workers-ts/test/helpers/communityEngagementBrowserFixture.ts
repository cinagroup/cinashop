import { eq, sql } from "drizzle-orm";
import { community, communityRelevance, communityUser, systemConfig } from "@/models/schema";
import { communityAuthorFixture } from "./communityAuthorFixture";

/** Synthetic history only, in the existing process-owned native author/media
 * database. Every request after the initial receipt uses the real application. */
export async function communityEngagementBrowserFixture() {
  const f = await communityAuthorFixture();
  try {
    const mainId = f.removable.id, otherId = f.other.id, videoId = f.clip.id;
    await f.db.update(community).set({ title: "互动验收主帖", content: "主卡片与详情共享点赞和分享状态", sort: 999, star: 5,
      likeNum: 7, playNum: 8, shareNum: 9 }).where(eq(community.id, mainId));
    await f.db.update(community).set({ title: "互动验收次帖", content: "已赞过的另一位作者作品", sort: 998, star: 4,
      likeNum: 4, playNum: 5, shareNum: 6 }).where(eq(community.id, otherId));
    await f.db.update(community).set({ title: "互动验收视频", content: "无id首视频与旧app视频入口", status: 1, isVerify: 1,
      refusal: "", sort: 997, star: 3, likeNum: 2, playNum: 4, shareNum: 3 }).where(eq(community.id, videoId));
    await f.db.update(community).set({ title: "本人待审旁观", content: "私有预览不能点赞分享" }).where(eq(community.id, f.gallery.id));
    await f.db.update(communityUser).set({ likeNum: 30 }).where(sql`${communityUser.type}=2 AND ${communityUser.relationId}=11`);
    await f.db.update(communityUser).set({ likeNum: 17 }).where(sql`${communityUser.type}=2 AND ${communityUser.relationId}=22`);
    const spectators = await f.db.insert(communityUser).values([
      { type: 0, relationId: 0, nickname: "平台身份旁观", likeNum: 91 },
      ...[0, 1, 3].flatMap(type => [11, 22].map(relationId => ({ type, relationId,
        nickname: `异型${type}同号${relationId}`, likeNum: 1000 + type * 100 + relationId }))),
    ]).returning({ id: communityUser.id });
    const [platform] = await f.db.insert(community).values({ type: 0, relationId: 0, title: "平台身份旁观",
      content: "所有互动只允许变更对应的真实作者", status: 1, isVerify: 1, likeNum: 91, playNum: 92, shareNum: 93 }).returning({ id: community.id });
    await f.db.insert(communityRelevance).values({ leftId: mainId, rightId: 9, type: "community_topic" });
    const settings = { community_status: "1", community_comment_status: "1", community_comment_add: "1",
      community_comment_verify: "0", site_name: "互动验收平台", wap_login_logo: "", site_url: '"https://storefront.example.test"' };
    for (const [menuName, value] of Object.entries(settings)) {
      const rows = await f.db.select().from(systemConfig).where(eq(systemConfig.menuName, menuName));
      if (rows.length) throw Error(`Unexpected pre-existing owned engagement setting ${menuName}`);
      await f.db.insert(systemConfig).values({ menuName, value, status: 1 });
    }
    return { ...f, mainId, otherId, videoId, platformId: platform.id,
      protectedProfileIds: spectators.map(row => row.id), protectedPostIds: [platform.id, f.gallery.id, f.collision.id] };
  } catch (error) { await f.close(); throw error; }
}
