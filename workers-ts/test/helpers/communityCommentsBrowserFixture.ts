import { eq, sql } from "drizzle-orm";
import { community, communityComment, communityRelevance, systemConfig } from "@/models/schema";
import { communityAuthorFixture } from "./communityAuthorFixture";

/** Fixed synthetic thread histories inside the existing process-owned native
 * author/media fixture. No shared schema or production binding is used. */
export async function communityCommentsBrowserFixture() {
  const f = await communityAuthorFixture();
  try {
    const mainId = f.removable.id, otherId = f.other.id, videoId = f.clip.id;
    await f.db.update(community).set({ title: "评论验收主帖", content: "实际评论与回复的主帖", sort: 999, star: 5 })
      .where(eq(community.id, mainId));
    await f.db.update(community).set({ title: "评论验收次帖", content: "切换后仅显示这一帖的评论" }).where(eq(community.id, otherId));
    await f.db.update(community).set({ title: "评论验收视频", content: "两个视频路由共用真实评论组件",
      status: 1, isVerify: 1, refusal: "" }).where(eq(community.id, videoId));
    await f.db.delete(communityComment);
    const names = new Map([[1011, "分页回复根"], [1010, "本人隐藏根"], [1009, "平台根"],
      [1008, "级联删除根"], [1007, "本人隐藏保留根"], [1001, "第一页之外根"]]);
    const root = (id: number, extra: Partial<typeof communityComment.$inferInsert> = {}) => ({
      id, communityId: mainId, uid: id === 1011 ? 22 : id === 1009 ? 0 : 11,
      type: id === 1009 ? 0 : 2, content: names.get(id) ?? `主帖根${id}`,
      isReply: 1, replyId: 0, isVerify: 1, isShow: [1010, 1007].includes(id) ? 0 : 1,
      isDel: 0, addTime: 100, ...extra,
    });
    const reply = (id: number, replyId: number, content: string, extra: Partial<typeof communityComment.$inferInsert> = {}) => ({
      ...root(id), content, type: 2, uid: 11, isReply: 0, replyId, replyUid: replyId === 1011 ? 22 : 11,
      isShow: 1, ...extra,
    });
    await f.db.insert(communityComment).values([
      ...Array.from({ length: 13 }, (_, i) => root(1001 + i, { commentNum: i === 10 ? 12 : i === 7 ? 2 : 0 })),
      ...Array.from({ length: 12 }, (_, i) => reply(2001 + i, 1011, `分页子回复${2001 + i}`)),
      reply(2101, 1010, "本人隐藏子回复", { isShow: 0 }),
      reply(2201, 1008, "级联子回复一", { likeNum: 1 }),
      reply(2202, 1008, "级联子回复二", { uid: 22, likeNum: 1 }),
      reply(2301, 1007, "本人隐藏保留子回复", { isShow: 0 }),
      root(1100, { uid: 22, content: "其他账号隐藏根", isShow: 0 }),
      root(1101, { type: 3, uid: 11, nickname: "异型隐藏旁观", content: "异型隐藏旁观", isShow: 0 }),
      root(1102, { uid: 11, content: "预存待审旁观", isVerify: 0 }),
      root(3001, { communityId: otherId, uid: 22, content: "次帖独立评论" }),
      root(4001, { communityId: videoId, content: "视频入口评论" }),
    ]);
    await f.db.insert(communityRelevance).values([
      { id: 5000, leftId: 22, rightId: 2201, type: "community_comment_like" },
      { id: 5001, leftId: 11, rightId: 2202, type: "community_comment_like" },
    ]);
    for (const name of ["community_comment", "community_relevance"] as const) {
      await f.db.execute(sql`SELECT setval(pg_get_serial_sequence(${name}, 'id'),
        (SELECT max(id) FROM ${sql.identifier(name)}), true)`);
    }
    await f.db.update(community).set({ commentNum: 25 }).where(eq(community.id, mainId));
    await f.db.update(community).set({ commentNum: 1 }).where(eq(community.id, otherId));
    await f.db.update(community).set({ commentNum: 1 }).where(eq(community.id, videoId));
    const settings = { community_status: "1", community_comment_status: "1", community_comment_add: "1",
      community_comment_verify: "0", site_name: "验收平台", wap_login_logo: "" };
    for (const [menuName, value] of Object.entries(settings)) {
      const rows = await f.db.select().from(systemConfig).where(eq(systemConfig.menuName, menuName));
      if (rows.length) throw Error(`Unexpected pre-existing owned setting ${menuName}`);
      await f.db.insert(systemConfig).values({ menuName, value, status: 1 });
    }
    return { ...f, mainId, otherId, videoId, names: Object.fromEntries(names),
      initialRootContents: Array.from({ length: 10 }, (_, i) => names.get(1013 - i) ?? `主帖根${1013 - i}`),
      protectedCommentIds: [1007, 2301, 1100, 1101, 1102, 3001, 4001] };
  } catch (error) { await f.close(); throw error; }
}
