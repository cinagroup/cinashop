import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { AttachmentService } from "@/services/system/AttachmentService";
import { CommunityService } from "@/services/community/CommunityService";
import { community, systemAttachment, user } from "@/models/schema";
import { validateCustomerVideo } from "@/services/system/CustomerVideoPolicy";
import { communityVideoFixture } from "./helpers/communityVideoFixture";
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(),
  createContainer: () => { if (!wiring.container) throw Error("Missing owned video SQL"); return wiring.container; },
}));
describe("owned community MP4 upload, moderation and playback", () => {
  let f: Awaited<ReturnType<typeof communityVideoFixture>>;
  const app = createApp();
  beforeAll(async () => { f = await communityVideoFixture(); wiring.container = f.container; }, 30000);
  afterAll(async () => { wiring.container = undefined; await f?.close(); });
  async function upload(file = f.file(), token = f.token, field = "file", extra?: [string, string | File]) {
    const form = new FormData(); form.append(field, file);
    if (field !== "file") form.append("filename", field);
    if (extra) form.append(...extra);
    const raw = new Response(form), bytes = await raw.arrayBuffer();
    const headers = new Headers(raw.headers); headers.set("content-length", String(bytes.byteLength));
    if (token) headers.set("Authori-zation", `Bearer ${token}`);
    return app.request("/api/upload/video", { method: "POST", headers, body: bytes }, f.env);
  }
  it("actual App/JWT accepts PHP's filename field, persists canonical ownership and streams signed ranges", async () => {
    const response = await upload(f.file(), f.token, "clip"), body = await response.json() as any;
    expect(body.status).toBe(200); expect(body.msg).toBe("视频上传成功!");
    const row = (await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, body.data.att_id)))[0];
    expect(row).toMatchObject({ type: 3, moduleType: 3, fileType: 2, relationId: 11, imageType: 8, attDir: body.data.url });
    expect(row.attType.trim()).toBe("video/mp4"); expect(body.data.url).not.toContain("signature");
    expect(body.data.src).toContain("signature=");
    const read = await app.request(body.data.src, { headers: { Range: "bytes=0-31" } }, f.env);
    expect(read.status).toBe(206); expect(read.headers.get("Content-Range")).toBe(`bytes 0-31/${f.mp4.length}`);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(f.mp4.slice(0, 32));
    expect(read.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await app.request(body.data.url, {}, f.env)).status).toBe(404);
  });
  it("new videos require current ownership; pending posts remain author-only and public reads use refreshed signatures", async () => {
    const media = await new AttachmentService(f.container, f.env).uploadUserVideo(11, f.file());
    const svc = new CommunityService(f.container, f.env.APP_KEY);
    const post = await svc.create(11, { title: "", contentType: 2, content: "视频正文", videoUrl: media.url, topicIds: [9] }, 0);
    const stored = (await f.db.select().from(community).where(eq(community.id, post.id)))[0];
    expect(stored.videoUrl).toBe(media.url); expect(stored.isVerify).toBe(0);
    await expect(svc.detail(post.id, 22)).rejects.toThrow();
    const preview = await svc.detail(post.id, 11); expect(preview.videoUrl).toContain("signature=");
    expect(preview.video_reference).toBe(media.url);
    await expect(svc.create(22, { title: "", contentType: 2, content: "越权", videoUrl: media.url }, 1)).rejects.toThrow("不属于");
    await expect(svc.create(11, { title: "", contentType: 2, content: "外部", videoUrl: "https://example.test/video.mp4" }, 1)).rejects.toThrow("先上传");
    await expect(svc.create(11, { title: "", contentType: 2, content: "签名", videoUrl: media.src }, 1)).rejects.toThrow();
    await f.db.update(community).set({ isVerify: 1 }).where(eq(community.id, post.id));
    expect((await svc.detail(post.id, 22)).videoUrl).toContain("signature=");
    await f.db.update(systemAttachment).set({ relationId: 22 }).where(eq(systemAttachment.attId, media.att_id));
    expect((await svc.detail(post.id, 11)).videoUrl).toBe("");
  });
  it("rejects unauthenticated, multiple-file and arbitrary multipart fields without storing objects", async () => {
    const count = f.objects.size;
    for (const response of [await upload(f.file(), ""), await upload(f.file(), f.token, "file", ["pid", "77"]), await upload(f.file(), f.token, "file", ["file", f.file()])]) {
      expect((await response.json() as any).status).not.toBe(200);
    }
    expect(f.objects.size).toBe(count);
  });
  it("validates MIME, container brands, truncation and the 50 MiB boundary before R2", async () => {
    await expect(validateCustomerVideo(f.file())).resolves.toBeUndefined();
    const broken = f.mp4.slice();
    const boxSize = new DataView(broken.buffer).getUint32(0);
    for (let i = 8; i < boxSize; i += 4) broken.set(new TextEncoder().encode("heic"), i);
    for (const file of [new File([broken], "heic.mp4"), new File([f.mp4], "x.mp4", { type: "text/html" }),
      new File([f.mp4.slice(0, 48)], "cut.mp4"), new File(["<script>alert(1)</script>"], "fake.mp4")]) {
      await expect(validateCustomerVideo(file)).rejects.toThrow();
    }
    const oversized = f.file(); Object.defineProperty(oversized, "size", { value: 50 * 1024 * 1024 + 1 });
    await expect(validateCustomerVideo(oversized)).rejects.toThrow("50 MiB");
  });
  it("rechecks account status after R2 and cleans only its failed upload", async () => {
    const before = [...f.objects.keys()];
    f.onPut(async () => { await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 11)); });
    try { await expect(new AttachmentService(f.container, f.env).uploadUserVideo(11, f.file())).rejects.toThrow("用户状态"); }
    finally { f.onPut(); await f.db.update(user).set({ status: 1 }).where(eq(user.uid, 11)); }
    expect([...f.objects.keys()]).toEqual(before);
  });
  it("image and video share the account budget and reject before multipart/R2", async () => {
    f.counts.set("user-upload:11", 100); const before = f.bucket.put.mock.calls.length;
    for (const path of ["/api/upload/image", "/api/assets/upload/image", "/api/upload/video"]) {
      const response = await app.request(path, { method: "POST", headers: { "Authori-zation": `Bearer ${f.token}` }, body: "invalid" }, f.env);
      expect(response.status).toBe(429);
    }
    expect(f.bucket.put).toHaveBeenCalledTimes(before);
    f.counts.delete("user-upload:11");
  });
});
