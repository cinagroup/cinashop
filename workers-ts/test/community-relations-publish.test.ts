import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { CommunityService } from "@/services/community/CommunityService";
import { community, communityRelevance, communityTopic, storeProduct } from "@/models/schema";
import { communityRelationsFixture } from "./helpers/communityRelationsFixture";
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(),
  createContainer: () => { if (!wiring.container) throw Error("Missing owned relation SQL"); return wiring.container; },
}));
describe("community publication relations", () => {
  let f: Awaited<ReturnType<typeof communityRelationsFixture>>;
  const app = createApp();
  beforeAll(async () => { f = await communityRelationsFixture(); wiring.container = f.container; }, 30000);
  afterAll(async () => { wiring.container = undefined; await f?.close(); });
  const svc = () => new CommunityService(f.container, f.env.APP_KEY);
  const get = async (query: string, token?: string) => (await app.request(`/api/community/product_list?${query}`, {
    headers: token ? { "Authori-zation": `Bearer ${token}` } : {},
  }, f.env)).json() as Promise<any>;
  it("actual JWT endpoint scopes all three sources, hides unavailable products and paginates deduplicated history", async () => {
    expect((await get("type=pay")).data).toEqual([]);
    const first = await get("type=pay&limit=10", f.token), second = await get("type=pay&limit=10&page=2", f.token);
    expect(first.status).toBe(200);
    expect(first.data.map((r: any) => r.product_id)).toEqual([111,110,109,108,107,106,105,104,103,102]);
    expect(second.data.map((r: any) => r.product_id)).toEqual([101]);
    expect((await get("type=collect", f.token)).data.map((r: any) => r.product_id)).toEqual([201]);
    expect((await get("type=visit", f.token)).data.map((r: any) => r.product_id)).toEqual([301]);
    expect((await get("type=pay", f.otherToken)).data.map((r: any) => r.product_id)).toEqual([401]);
  });
  it("searches product name or keyword and rejects invalid sources and excessive offsets", async () => {
    expect((await get("type=pay&keyword=111", f.token)).data.map((r: any) => r.product_id)).toEqual([111]);
    expect((await get("type=pay&keyword=" + encodeURIComponent(" 家居 ") + "&limit=100", f.token)).data).toHaveLength(11);
    expect((await get("type=collect&keyword=111", f.token)).data).toEqual([]);
    await expect(svc().userProductList(11, { type: "all" })).rejects.toThrow("来源");
    await expect(svc().userProductList(11, { page: 1002, limit: 10 })).rejects.toThrow("分页");
  });
  it("actual publication persists relation IDs and exposes only active current relations in the detail DTO", async () => {
    const response = await app.request("/api/community_save", { method: "POST",
      headers: { "Authori-zation": `Bearer ${f.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "有关联的分享", content_type: 1, topic_id: [9,10], product_id: [111,201,301] }),
    }, f.env);
    const result = await response.json() as any; expect(result.status, result.msg).toBe(200);
    const detail = await svc().detail(result.data.id, 11);
    expect(detail.topic.map(t => t!.id).sort()).toEqual([10,9].sort());
    expect(detail.product.map(p => p!.id).sort()).toEqual([111,201,301]);
    expect(detail.product.find(p => p!.id === 201)).toMatchObject({ store_name: "收藏茶杯", price: "29.00" });
    await f.db.update(communityTopic).set({ status: 0 }).where(eq(communityTopic.id, 10));
    await f.db.update(storeProduct).set({ isShow: 0 }).where(eq(storeProduct.id, 201));
    const retired = await svc().detail(result.data.id, 11);
    expect(retired.topic.map(t => t!.id)).toEqual([9]);
    expect(retired.product.map(p => p!.id)).toEqual([111,301]);
    expect(retired.topic_id.sort()).toEqual([10,9].sort()); expect(retired.product_id.sort()).toEqual([111,201,301]);
  });
  it("invalid or retired references roll back new publication and preserve existing posts on update", async () => {
    const post = await svc().create(11, { title: "", content: "保留原帖", contentType: 1, topicIds: [9], productIds: [111] }, 1);
    const before = await f.db.select().from(community);
    const relations = await f.db.select().from(communityRelevance);
    for (const productId of [402,403,404,999]) {
      await expect(svc().create(11, { title: "", content: "拒绝", contentType: 1, productIds: [productId] }, 1)).rejects.toThrow();
      await expect(svc().update(11, post.id, { product_id: [productId] }, 1)).rejects.toThrow();
    }
    await expect(svc().create(11, { title: "", content: "拒绝", contentType: 1, topicIds: [10] }, 1)).rejects.toThrow();
    expect(await f.db.select().from(community)).toEqual(before);
    expect(await f.db.select().from(communityRelevance)).toEqual(relations);
  });
});
