import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { community, communityRelevance, userFriends, systemUserLevel } from "@/models/schema";
import { AttachmentService, userAttachmentScope } from "@/services/system/AttachmentService";
import { CommunityService } from "@/services/community/CommunityService";
import { communityRelationsFixture } from "./communityRelationsFixture";

export async function communityAuthorFixture() {
  const f = await communityRelationsFixture([userFriends, systemUserLevel]);
  const service = new CommunityService(f.container, f.env.APP_KEY);
  const png = new Uint8Array(await readFile(resolve(import.meta.dirname, "../fixtures/community-teal.png")));
  const image = await new AttachmentService(f.container, f.env).uploadImage(userAttachmentScope(11),
    new File([png], "author.png", { type: "image/png" }), 0);
  const video = await new AttachmentService(f.container, f.env).uploadUserVideo(11, f.file());
  const gallery = await service.create(11, { title: "我的图集", content: "待修改的图文", contentType: 1,
    sliderImage: [image.url], topicIds: [9], productIds: [111] }, 0);
  const clip = await service.create(11, { title: "我的视频", content: "视频审核未通过", contentType: 2,
    videoUrl: video.url, image: image.url, topicIds: [10] }, 0);
  await f.db.update(community).set({ isVerify: -1, refusal: "请补充视频说明" }).where(eq(community.id, clip.id));
  const removable = await service.create(11, { title: "可以删除的分享", content: "只删除这一篇", contentType: 1 }, 1);
  const other = await service.create(22, { title: "另一位作者的公开帖子", content: "赞过的作品", contentType: 1 }, 1);
  const comment = await service.addComment(22, { communityId: removable.id, content: "随帖子一起隐藏的评论" });
  await f.db.insert(communityRelevance).values({ leftId: 11, rightId: other.id, type: "community_like" });
  const [collision] = await f.db.insert(community).values({ type: 0, relationId: 11, title: "管理员私有同号记录",
    content: "不属于用户11", contentType: 1, isVerify: 0 }).returning({ id: community.id });
  return { ...f, gallery, clip, removable, other, collision, image, video, comment };
}
