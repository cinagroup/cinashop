import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { CommunityService } from "@/services/community/CommunityService";
import { community, communityComment, communityRelevance, communityUser } from "@/models/schema";
import { communityAuthorFixture } from "./helpers/communityAuthorFixture";
import { resolveCommunityPageRoute } from "../../view/common/communityRoute";
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(),
  createContainer: () => { if (!wiring.container) throw Error("Missing owned author SQL"); return wiring.container; },
}));
describe("community author workspace", () => {
  let f: Awaited<ReturnType<typeof communityAuthorFixture>>;
  const app = createApp();
  beforeAll(async () => { f = await communityAuthorFixture(); wiring.container = f.container; }, 30000);
  afterAll(async () => { wiring.container = undefined; await f?.close(); });
  const request = async (path: string, method = "GET", body?: unknown, token?: string) => (await app.request(`/api/${path}`, {
    method, headers: { "Authori-zation": `Bearer ${token ?? f.token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, f.env)).json() as Promise<any>;
  it("owner preview never includes a private administrator post with the same numeric author ID", async () => {
    const own = await request("community/list?relation_id=11");
    expect(own.status).toBe(200);
    expect(own.data.map((r: any) => r.id).sort()).toEqual([f.gallery.id, f.clip.id, f.removable.id].sort());
    expect((await request("community/list?relation_id=11&author_type=2", "GET", undefined, f.otherToken)).data.map((r: any) => r.id)).toEqual([f.removable.id]);
    expect((await request("community/list?relation_id=11&author_type=0")).data).toEqual([]);
    expect((await request("community/list?relation_id=11&author_type=9")).status).not.toBe(200);
    expect((await request(`community/detail/${f.collision.id}`)).status).not.toBe(200);
  });
  it("reads self-only liked posts, updates only the actor description, and supports platform author ID zero without listing everyone", async () => {
    const profile = await request("community/user_info/11");
    expect(profile.data).toMatchObject({ relation_id: 11, type: 2, is_self: 1 });
    expect((await request("community/like_list")).data.list.map((r: any) => r.id)).toEqual([f.other.id]);
    expect((await request("community/like_list", "GET", undefined, f.otherToken)).data.list).toEqual([]);
    expect((await request("community/update_desc", "POST", { desc: "我的社区简介", uid: 22 })).status).toBe(200);
    expect((await request("community/user_info/11")).data.desc).toBe("我的社区简介");
    expect((await request("community/user_info/22")).data.desc).toBe("");
    await f.db.insert(communityUser).values({ type: 0, relationId: 0, nickname: "平台" });
    expect((await request("community/list?relation_id=0&author_type=0")).data).toEqual([]);
  });
  it("edits the original gallery and video under moderation without persisting signed previews or cloning a post", async () => {
    const before = await f.db.select().from(community);
    const gallery = await request(`community/community_update/${f.gallery.id}`, "POST", { title: "", content: "已修改图集", content_type: 1,
      image: f.image.url, slider_image: [f.image.url], video_url: "", topic_id: [], product_id: [] });
    expect(gallery.status, gallery.msg).toBe(200); expect(gallery.data.id).toBe(f.gallery.id);
    const clip = await request(`community/community_update/${f.clip.id}`, "POST", { title: "修改视频", content: "已补充视频说明",
      content_type: 2, image: f.image.url, video_url: f.video.url, slider_image: [], topic_id: [10], product_id: [] });
    expect(clip.status, clip.msg).toBe(200);
    const rows = await f.db.select().from(community); expect(rows).toHaveLength(before.length);
    expect(rows.find(r => r.id === f.clip.id)).toMatchObject({ isVerify: 0, refusal: "", videoUrl: f.video.url, image: f.image.url });
    const detail = await new CommunityService(f.container, f.env.APP_KEY).detail(f.gallery.id, 11);
    expect(detail.image_reference).toBe(f.image.url); expect(detail.image).toContain("signature=");
    expect(detail.topic_id).toEqual([]); expect(detail.product_id).toEqual([]);
  });
  it("rejects foreign edits/deletes and invalid private media without changing posts or associations", async () => {
    const before = await f.db.select().from(community), associations = await f.db.select().from(communityRelevance);
    for (const id of [f.other.id, f.collision.id]) {
      expect((await request(`community/community_update/${id}`, "POST", { content: "拒绝" })).status).not.toBe(200);
      expect((await request(`community_delete/${id}`, "DELETE")).status).not.toBe(200);
    }
    expect((await request(`community/community_update/${f.gallery.id}`, "POST", { image: f.image.src, slider_image: [f.image.src] })).status).not.toBe(200);
    expect(await f.db.select().from(community)).toEqual(before);
    expect(await f.db.select().from(communityRelevance)).toEqual(associations);
  });
  it("deletes exactly the owned post and cascades comment visibility while preserving every other post", async () => {
    const before = await f.db.select().from(community);
    const result = await request(`community_delete/${f.removable.id}`, "DELETE"); expect(result.status).toBe(200);
    const after = await f.db.select().from(community);
    expect(after.filter(r => r.id !== f.removable.id)).toEqual(before.filter(r => r.id !== f.removable.id));
    expect(after.find(r => r.id === f.removable.id)?.isDel).toBe(1);
    expect((await f.db.select().from(communityComment).where(eq(communityComment.id, f.comment.id)))[0]).toMatchObject({ isDel: 1, isShow: 0 });
    expect((await request(`community/detail/${f.removable.id}`)).status).not.toBe(200);
  });
});
describe("legacy community author and edit links", () => {
  it("keeps author IDs distinct from post edit IDs and drops unrelated query data", () => {
    expect(resolveCommunityPageRoute("/pages/discover/discoverUser/index", "id=11&token=SECRET")).toBe("/pages/discover/workspace?author_id=11");
    expect(resolveCommunityPageRoute("/pages/discover/discoverUser/index", "")).toBe("/pages/discover/workspace?author_id=self");
    expect(resolveCommunityPageRoute("/pages/discover/discoverCreate/index", "id=31&topic_id=9")).toBe("/pages/discover/workspace?publish=1&edit_id=31");
    expect(resolveCommunityPageRoute("/pages/discover/discoverCreate/index", "topic_id=9")).toBe("/pages/discover/workspace?publish=1&topic_id=9");
    expect(resolveCommunityPageRoute("/pages/discover/discoverCreate/index", "")).toBe("/pages/discover/workspace?publish=1");
    for (const query of ["id=0", "id=31&id=32", "id=../1", "id=%", "id=2147483648"]) {
      expect(resolveCommunityPageRoute("/pages/discover/discoverCreate/index", query)).toBe("");
    }
  });
});
