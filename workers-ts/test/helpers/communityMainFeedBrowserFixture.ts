import { and, eq } from "drizzle-orm";
import { community, communityRelevance, communityUser, systemConfig } from "@/models/schema";
import { communityEngagementBrowserFixture } from "./communityEngagementBrowserFixture";

/** Explicit historical seed only; all subsequent reads and intents use createApp. */
export async function communityMainFeedBrowserFixture() {
  const f = await communityEngagementBrowserFixture();
  try {
    await f.db.update(community).set({ title: "分页图文01", content: "主列表第一条与精选共享互动状态", star: 100, status: 1, isVerify: 1,
      image: f.image.url, sliderImage: JSON.stringify([f.image.url]), contentType: 1 }).where(eq(community.id, f.mainId));
    await f.db.update(community).set({ title: "分页视频02", content: "精选第二条真实视频", star: 99, status: 1, isVerify: 1 }).where(eq(community.id, f.videoId));
    await f.db.update(community).set({ status: 0 }).where(eq(community.id, f.otherId));
    await f.db.update(community).set({ status: 0 }).where(eq(community.id, f.platformId));
    const extra = await f.db.insert(community).values(Array.from({ length: 19 }, (_,i) => ({ type: 2, relationId: 22,
      title: `分页图文${String(i+3).padStart(2,"0")}`, content: `第${i+3}条实际分页内容`, contentType: 1,
      status: 1, isVerify: 1, star: 98-i, addTime: 4000+i, likeNum: i, playNum: 10+i }))).returning({ id: community.id });
    await f.db.insert(communityRelevance).values(extra.map((row,i) => ({ leftId: row.id, rightId: i%2===0 ? 9 : 10, type: "community_topic" })));
    await f.db.update(communityUser).set({ communityNum: 2 }).where(and(eq(communityUser.type,2),eq(communityUser.relationId,11)));
    await f.db.update(communityUser).set({ communityNum: 19, status: 1 }).where(and(eq(communityUser.type,2),eq(communityUser.relationId,22)));
    await f.db.insert(systemConfig).values({ menuName: "station_open", value: "1" });
    const orderedIds = [f.mainId,f.videoId,...extra.map(row=>row.id)];
    return { ...f, orderedIds, followingIds: extra.map(row=>row.id),
      topicIds: orderedIds.filter((_,i)=>i%2===0), previewId: extra[0].id };
  } catch (reason) { await f.close(); throw reason; }
}
