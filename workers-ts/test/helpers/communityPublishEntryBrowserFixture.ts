import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { community, communityRelevance, communityTopic, communityUser, systemConfig, userFriends } from "@/models/schema";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { communityAuthorFixture } from "./communityAuthorFixture";

/** Synthetic source histories, real application services, JWT, owned PG16 and
 * memory R2. Production migrations, access roles and remote storage are absent. */
export async function communityPublishEntryBrowserFixture() {
  const f = await communityAuthorFixture();
  try {
    await f.db.update(communityTopic).set({ name: "入口话题九" }).where(eq(communityTopic.id, 9));
    await f.db.update(communityTopic).set({ name: "入口话题十" }).where(eq(communityTopic.id, 10));
    await f.db.update(community).set({ title: "入口原始图集", content: "编辑入口保留原照片与关联" }).where(eq(community.id, f.gallery.id));
    await f.db.update(community).set({ title: "入口公开旁观", content: "既有公共帖不允许被发布入口修改" }).where(eq(community.id, f.removable.id));
    const [platform] = await f.db.insert(community).values({ type: 0, relationId: 0, title: "入口平台作品",
      content: "平台编号零不能转换成当前账号", status: 1, isVerify: 1, likeNum: 31, playNum: 32 }).returning();
    const [platformProfile] = await f.db.insert(communityUser).values({ type: 0, relationId: 0,
      nickname: "入口平台资料", communityNum: 1, fansNum: 100, status: 1, isDel: 0 }).returning();
    const spectators = await f.db.insert(communityUser).values([0, 1, 3].flatMap(type => [11, 22].map(relationId => ({
      type, relationId, nickname: `入口异型旁观${type}-${relationId}`, communityNum: 900 + type, likeNum: 800 + relationId,
      followNum: 700, fansNum: 600, status: 1, isDel: 0,
    })))).returning({ id: communityUser.id });
    for (const uid of [11, 22]) await f.db.update(communityUser).set({ communityNum: 1, followNum: 1, fansNum: 1,
      friendNum: 1 }).where(and(eq(communityUser.type, 2), eq(communityUser.relationId, uid)));
    await f.db.insert(userFriends).values({ uid: 11, friendsUid: 22 });
    await f.db.insert(communityRelevance).values([
      { leftId: 11, rightId: 22, type: "community_interest" },
      { leftId: 22, rightId: 11, type: "community_interest" },
    ]);
    const settings = { community_status: "1", community_comment_status: "1", community_comment_add: "1",
      community_verify: "1", community_video_verify: "1", site_name: "入口验收平台", wap_login_logo: "", site_url: '"https://storefront.example.test"' };
    for (const [menuName, value] of Object.entries(settings)) {
      if ((await f.db.select().from(systemConfig).where(eq(systemConfig.menuName, menuName))).length)
        throw Error(`Unexpected pre-existing owned publish setting ${menuName}`);
      await f.db.insert(systemConfig).values({ menuName, value, status: 1 });
    }
    // Prime the real cache reader. A later fixture-only configuration mutation
    // must delete cfg_community_verify, rather than changing SQL underneath it.
    if (await new SystemConfigService(f.container, f.env).get("community_verify") !== "1")
      throw Error("Owned review configuration was not read through the real cache protocol");
    const png = new Uint8Array(await readFile(resolve(import.meta.dirname, "../fixtures/community-teal.png")));
    return { ...f, platform, platformProfile, png,
      chooserPath: resolve(import.meta.dirname, "../fixtures/community-teal.png"),
      protectedProfileIds: [...spectators.map(row => row.id), platformProfile.id],
      protectedPostIds: [platform.id, f.clip.id, f.removable.id, f.other.id, f.collision.id] };
  } catch (error) { await f.close(); throw error; }
}
