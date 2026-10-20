import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { AttachmentService, userAttachmentScope } from "@/services/system/AttachmentService";
import { CommunityService } from "@/services/community/CommunityService";
import { community, systemAttachment } from "@/models/schema";
import { communityVideoFixture } from "./helpers/communityVideoFixture";
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(),
  createContainer: () => { if (!wiring.container) throw Error("Missing owned image SQL"); return wiring.container; },
}));
describe("community private gallery and video covers", () => {
  let f: Awaited<ReturnType<typeof communityVideoFixture>>, png: Uint8Array;
  const app = createApp();
  beforeAll(async () => { f = await communityVideoFixture(); wiring.container = f.container;
    png = new Uint8Array(await readFile(resolve(import.meta.dirname, "fixtures/community-teal.png"))); }, 30000);
  afterAll(async () => { wiring.container = undefined; await f?.close(); });
  const image = () => new File([png], "teal.png", { type: "image/png" });
  const svc = () => new CommunityService(f.container, f.env.APP_KEY);
  const upload = (uid = 11) => new AttachmentService(f.container, f.env).uploadImage(userAttachmentScope(uid), image(), 0);
  it("actual image upload and post HTTP routes persist canonical references and sign author-only gallery previews", async () => {
    const form = new FormData(); form.append("file", image()); form.append("pid", "0");
    const raw = new Response(form), body = await raw.arrayBuffer(), headers = new Headers(raw.headers);
    headers.set("content-length", String(body.byteLength)); headers.set("Authori-zation", `Bearer ${f.token}`);
    const response = await app.request("/api/upload/image", { method: "POST", headers, body }, f.env);
    const media = await response.json() as any; expect(media.status, media.msg).toBe(200);
    const request = await app.request("/api/community_save", { method: "POST", headers: { "Authori-zation": `Bearer ${f.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "照片分享", content_type: 1, image: media.data.url, slider_image: [media.data.url] }) }, f.env);
    const result = await request.json() as any; expect(result.status).toBe(200);
    const stored = (await f.db.select().from(community).where(eq(community.id, result.data.id)))[0];
    expect(stored).toMatchObject({ image: media.data.url, sliderImage: JSON.stringify([media.data.url]), isVerify: 0 });
    await expect(svc().detail(stored.id, 22)).rejects.toThrow();
    const detail = await svc().detail(stored.id, 11);
    expect(detail.image).toContain("signature="); expect(detail.sliderImage).toEqual([detail.image]);
    expect(detail.image_reference).toBe(media.data.url); expect(detail.slider_image_references).toEqual([media.data.url]);
    const read = await app.request(detail.image, {}, f.env);
    expect(read.status).toBe(200); expect(new Uint8Array(await read.arrayBuffer())).toEqual(png);
    expect((await app.request(media.data.url, {}, f.env)).status).toBe(404);
    await f.db.update(community).set({ isVerify: 1 }).where(eq(community.id, stored.id));
    expect((await svc().detail(stored.id, 22)).sliderImage[0]).toContain("signature=");
  });
  it("stores ordered galleries and a separate video cover without turning them into video references", async () => {
    const first = await upload(), second = await upload(), video = await new AttachmentService(f.container, f.env).uploadUserVideo(11, f.file());
    const post = await svc().create(11, { title: "", content: "有封面的视频", contentType: 2, image: second.url, videoUrl: video.url }, 1);
    const detail = await svc().detail(post.id, 11);
    expect(detail.image_reference).toBe(second.url); expect(detail.video_reference).toBe(video.url);
    expect(detail.image).toContain(second.url + "?"); expect(detail.videoUrl).toContain(video.url + "?");
    const album = await svc().create(11, { title: "", content: "顺序", contentType: 1, sliderImage: [second.url, first.url] }, 1);
    expect((await svc().detail(album.id, 11)).slider_image_references).toEqual([second.url, first.url]);
  });
  it("rejects other-user, signed, missing, video and cross-scope references without changing a post", async () => {
    const own = await upload(), other = await upload(22), video = await new AttachmentService(f.container, f.env).uploadUserVideo(11, f.file());
    const post = await svc().create(11, { title: "", content: "保留", contentType: 1, sliderImage: [own.url] }, 1);
    const before = await f.db.select().from(community).where(eq(community.id, post.id));
    for (const ref of [other.url, own.src, "/api/assets/99999999", video.url]) {
      await expect(svc().update(11, post.id, { image: ref, slider_image: [ref] }, 1)).rejects.toThrow();
      expect(await f.db.select().from(community).where(eq(community.id, post.id))).toEqual(before);
    }
    await f.db.update(systemAttachment).set({ moduleType: 4 }).where(eq(systemAttachment.attId, own.att_id));
    await expect(svc().update(11, post.id, { title: "拒绝" }, 1)).rejects.toThrow("不属于");
    const dirty = await svc().detail(post.id, 11); expect(dirty.image).toBe(""); expect(dirty.sliderImage).toEqual([]);
  });
  it("retains existing remote image contracts and never signs malformed private references from dirty historical rows", async () => {
    const post = await svc().create(11, { title: "", content: "历史 CDN", contentType: 1, image: "https://example.test/old.png", sliderImage: ["https://example.test/old.png"] }, 1);
    expect((await svc().detail(post.id, 11)).image).toBe("https://example.test/old.png");
    await svc().update(11, post.id, { content: "继续编辑" }, 1);
    await f.db.update(community).set({ image: "/api/assets/1?signature=old", sliderImage: JSON.stringify(["/api/assets/01", "https://example.test/old.png"]) }).where(eq(community.id, post.id));
    const dirty = await svc().detail(post.id, 11); expect(dirty.image).toBe(""); expect(dirty.sliderImage).toEqual(["https://example.test/old.png"]);
  });
});
