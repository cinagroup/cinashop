import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTx } from "../src/lib/di";
import { parseCombinationList } from "../../view/common/combinationPurchase";
import { createPcCombinationFixture } from "./helpers/pcCombinationFixture";
import { CombinationSkuCatalogService } from "../src/services/activity/CombinationSkuCatalogService";
import { reservePinkJoin } from "../src/services/activity/PinkLifecycleService";
import { resolveLegacyActivitySkuPair } from "../src/services/activity/ActivityOrderSkuService";
import { storeCombination, storePink, storeProduct, storeProductAttrValue, storeCart, storeOrder, user } from "../src/models/schema";

describe("read-only combination selection catalogue on disposable SQL", () => {
  let f: Awaited<ReturnType<typeof createPcCombinationFixture>>;
  let service: CombinationSkuCatalogService;
  beforeEach(async () => { f = await createPcCombinationFixture(); service = new CombinationSkuCatalogService(f.container); }, 30_000);
  afterEach(async () => { await f?.close(); });
  const read = (uid = 0, pinkId?: string) => service.read(uid, "30", pinkId);
  const request = (query = "view=skus", authenticated = false) => f.app.request(`/api/combination/detail/30?${query}`,
    authenticated ? { headers: { "Authori-zation": "Bearer isolated-combination-session" } } : undefined, f.env);

  it("paginates tied activity sorts deterministically through real list HTTP", async () => {
    await f.db.insert(storeCombination).values(Array.from({ length: 20 }, (_, index) => ({
      id: 31 + index, productId: 70, storeName: `分页拼团${31 + index}`, price: "6.25", people: 4,
    })));
    const list = async (page: number) => {
      const response = await f.app.request(`/api/combination/list?page=${page}&limit=20`, undefined, f.env);
      const body = await response.json();
      if (!body || typeof body !== "object" || !("status" in body) || !("data" in body)) throw new Error("Invalid list envelope");
      expect(body.status).toBe(200);
      return parseCombinationList(body.data).map(row => row.id);
    };
    const before = await f.snapshot();
    expect(await list(1)).toEqual(Array.from({ length: 20 }, (_, index) => 50 - index));
    expect(await list(2)).toEqual([30]);
    expect(await list(1)).toEqual(Array.from({ length: 20 }, (_, index) => 50 - index));
    expect(await list(3)).toEqual([]);
    expect(await f.snapshot()).toEqual(before);
    await f.db.update(storeCombination).set({ sort: 1 }).where(eq(storeCombination.id, 30));
    expect((await list(1))[0]).toBe(30);
    expect(await list(2)).toEqual([31]);
  });

  it("keeps all three ID namespaces distinct, limits stock/quantity and batches six anonymous queries without writes", async () => {
    const before = await f.snapshot(), queries = vi.spyOn(f.db, "select"), auth = vi.spyOn(f.container.userDao, "findForAuth");
    let result: Awaited<ReturnType<typeof read>>;
    try { result = await read(); expect(queries).toHaveBeenCalledTimes(6); expect(auth).not.toHaveBeenCalled(); }
    finally { queries.mockRestore(); auth.mockRestore(); }
    expect(result!).toMatchObject({ selection_only: true, type: 3, combination_id: 30, product_id: 70,
      title: "拼团红蓝双规格", people: 4, once_limit: 3, total_limit: 6, date_window: "active", requested_group: null,
      start_time: expect.any(String), stop_time: expect.any(String),
      skus: [
        { unique: "actred30", base_unique: "qared001", suk: "红色,大号", catalog_price: "6.25", ot_price: "10.00", stock: 6, max_quantity: 3 },
        { unique: "actblu30", base_unique: "qablue01", suk: "蓝色,小号", catalog_price: "8.75", ot_price: "20.00", stock: 2, max_quantity: 2 },
      ], groups: [{ id: 400, combination_id: 30, required_people: 4, active_people: 2, reserved_people: 1,
        available_places: 1, already_joined: false, has_pending_order: false, stop_time: expect.any(String) }] });
    expect(JSON.stringify(result!)).not.toMatch(/cost|brokerage|quotaShow|memberCount|nickname|avatar|uid|orderId|account/);
    expect(await f.snapshot()).toEqual(before);
  });

  it("serves private no-store over the real HTTP controller, ignores forged identity, and keeps legacy detail", async () => {
    const before = await f.snapshot(), response = await request("view=skus&pink_id=400&uid=22&vip=1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({ status: 200, data: { combination_id: 30, product_id: 70, requested_group: { id: 400, already_joined: false } } });
    expect(await f.snapshot()).toEqual(before);
    expect(await (await request("")).json()).toMatchObject({ status: 200, data: { id: 30, productId: 70 } });
  });

  it("rejects malformed IDs, duplicate/unknown views or group parameters before SQL", async () => {
    const queries = vi.spyOn(f.db, "select"), auth = vi.spyOn(f.container.userDao, "findForAuth");
    try {
      for (const raw of [undefined, null, 30, "", "0", "-1", "030", " 30", "30 ", "3e1", "30.0", "2147483648", "1 OR 1=1", "1".repeat(1000)]) {
        await expect(service.read(11, raw)).rejects.toThrow("ID无效");
        if (raw !== undefined) await expect(service.read(11, "30", raw)).rejects.toThrow("ID无效");
      }
      for (const uid of [-1, NaN, 1.5]) await expect(service.read(uid, "30")).rejects.toThrow("参数无效");
      for (const query of ["view=unknown", "view=", "view=skus&view=skus", "pink_id=400", "view=skus&pink_id=", "view=skus&pink_id=0", "view=skus&pink_id=400&pink_id=401"]) {
        const response = await request(query);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toMatchObject({ status: 400, data: null });
      }
      expect(queries).not.toHaveBeenCalled(); expect(auth).not.toHaveBeenCalled();
    } finally { queries.mockRestore(); auth.mockRestore(); }
  });

  it("uses current authenticated membership and rejects revoked or removed principals", async () => {
    await f.db.update(storeProduct).set({ isVipProduct: 1 });
    await expect(read()).rejects.toThrow("不可见"); await expect(read(11)).rejects.toThrow("不可见");
    await f.db.update(user).set({ isMoneyLevel: 1 });
    expect(await (await request("view=skus", true)).json()).toMatchObject({ status: 200 });
    await f.db.update(user).set({ isMoneyLevel: 0 }); await expect(read(11)).rejects.toThrow("不可见");
    await f.db.update(user).set({ status: 0 }); await expect(read(11)).rejects.toThrow("重新登录");
    await f.db.delete(user); await expect(read(11)).rejects.toThrow("重新登录");
  });

  it("hides disabled/deleted/missing activities and hidden/deleted/unapproved base products", async () => {
    for (const change of [{ status: 0 }, { isShow: 0 }, { isDel: 1 }, { productId: 99 }]) {
      await f.db.update(storeCombination).set({ status: 1, isShow: 1, isDel: 0, productId: 70, ...change });
      await expect(read()).rejects.toThrow("不可见");
    }
    await f.db.update(storeCombination).set({ productId: 70 });
    for (const change of [{ isShow: 0 }, { isDel: 1 }, { isVerify: 0 }, { isVerify: -2 }]) {
      await f.db.update(storeProduct).set({ isShow: 1, isDel: 0, isVerify: 1, ...change });
      await expect(read()).rejects.toThrow("不可见");
    }
    await expect(service.read(0, "400")).rejects.toThrow("不可见");
  });

  it("preserves exact inclusive activity endpoints without seckill whole-day expansion", async () => {
    const startTime = new Date("2026-09-08T00:00:00Z"), stopTime = new Date("2026-09-08T01:00:00Z");
    await f.db.update(storeCombination).set({ startTime, stopTime });
    for (const [offset, state] of [[-1, "future"], [0, "active"], [3_600_000, "active"], [3_600_001, "ended"]] as const) {
      expect(await service.read(0, "30", undefined, new Date(startTime.getTime() + offset))).toMatchObject({ date_window: state });
    }
    await f.db.update(storeCombination).set({ stopTime: startTime });
    expect(await service.read(0, "30", undefined, startTime)).toMatchObject({ date_window: "active" });
    expect(await service.read(0, "30", undefined, new Date(startTime.getTime() + 1))).toMatchObject({ date_window: "ended" });
    await f.db.update(storeCombination).set({ stopTime: new Date(startTime.getTime() - 1) });
    await expect(read()).rejects.toThrow("日期配置无效");
    await f.db.update(storeCombination).set({ startTime: null, stopTime: null });
    expect(await read()).toMatchObject({ date_window: "active", start_time: null, stop_time: null });
  });

  it("only exposes active type-3 activity SKUs and type-0 base mappings", async () => {
    await f.db.insert(storeProductAttrValue).values([
      { id: 5, productId: 30, type: 1, unique: "actred30", suk: "红色,大号" },
      { id: 6, productId: 31, type: 3, unique: "actred30", suk: "红色,大号" },
      { id: 7, productId: 30, type: 3, unique: "actred30", suk: "红色,大号", isRetired: 1 },
      { id: 8, productId: 70, type: 0, unique: "qared001", suk: "红色,大号", isRetired: 1 },
    ]);
    expect((await read()).skus.map(sku => sku.unique)).toEqual(["actred30", "actblu30"]);
  });

  it.each([
    [30, 3, "actred30", "另一规格"], [30, 3, "otheract", "红色,大号"],
    [70, 0, "qared001", "另一规格"], [70, 0, "othrbase", "红色,大号"],
  ])("rejects duplicate unique or suk within product %i type %i", async (productId, type, unique, suk) => {
    await f.db.insert(storeProductAttrValue).values({ id: 5, productId, type, unique, suk });
    await expect(read()).rejects.toThrow("不唯一");
  });

  it("rejects ambiguous cross-namespace keys and missing/retired/whitespace mappings", async () => {
    await f.db.update(storeProductAttrValue).set({ unique: "qablue01" }).where(eq(storeProductAttrValue.id, 3));
    await expect(read()).rejects.toThrow("标识冲突");
    await f.db.update(storeProductAttrValue).set({ unique: "qared001" }).where(eq(storeProductAttrValue.id, 3));
    expect((await read()).skus[0]).toMatchObject({ unique: "qared001", base_unique: "qared001" });
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
    await expect(read()).rejects.toThrow("缺少有效基础规格");
    await f.db.update(storeProductAttrValue).set({ isRetired: 0, suk: " 红色,大号 " }).where(eq(storeProductAttrValue.id, 1));
    await expect(read()).rejects.toThrow("名称配置无效");
  });

  it("preserves empty and sold-out catalogues and applies all inventory/limit ceilings", async () => {
    await f.db.update(storeProductAttrValue).set({ stock: 0 }).where(eq(storeProductAttrValue.id, 4));
    expect((await read()).skus[1]).toMatchObject({ stock: 0, max_quantity: 0 });
    for (const [stock, quota, baseStock, expected] of [[2, 8, 8, 2], [8, 1, 8, 1], [8, 8, 0, 0]]) {
      await f.db.update(storeCombination).set({ stock, quota }); await f.db.update(storeProduct).set({ stock: baseStock });
      expect((await read()).skus[0].stock).toBe(expected);
    }
    await f.db.update(storeCombination).set({ stock: 8, quota: 8, onceNum: 4, num: 2 });
    await f.db.update(storeProduct).set({ stock: 8 });
    expect((await read()).skus[0]).toMatchObject({ stock: 6, max_quantity: 2 });
    expect(await read()).not.toHaveProperty("remaining_limit");
    await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.type, 3));
    expect((await read()).skus).toEqual([]);
  });

  it("rejects bad price, stock, limits and group size; preserves legitimate zero prices", async () => {
    for (const price of ["0.00", "9999999999.99"]) {
      await f.db.update(storeProductAttrValue).set({ price }).where(eq(storeProductAttrValue.id, 3));
      expect((await read()).skus[0].catalog_price).toBe(price);
    }
    await f.db.update(storeProductAttrValue).set({ price: "-0.01" }).where(eq(storeProductAttrValue.id, 3));
    await expect(read()).rejects.toThrow("价格配置无效");
    await f.db.update(storeProductAttrValue).set({ price: "6.25", stock: -1 }).where(eq(storeProductAttrValue.id, 3));
    await expect(read()).rejects.toThrow("库存配置无效");
    await f.db.update(storeProductAttrValue).set({ stock: 7, quota: -1 }).where(eq(storeProductAttrValue.id, 3));
    await expect(read()).rejects.toThrow("库存配置无效");
    await f.db.update(storeProductAttrValue).set({ quota: 6 }).where(eq(storeProductAttrValue.id, 3));
    for (const change of [{ onceNum: 0 }, { num: -1 }, { people: 0 }]) {
      await f.db.update(storeCombination).set({ onceNum: 3, num: 6, people: 4, ...change });
      await expect(read()).rejects.toThrow("配置无效");
    }
  });

  it.each(["activity", "base"])("rejects %s overflow at 501 active SKUs", async scope => {
    await f.db.insert(storeProductAttrValue).values(Array.from({ length: 499 }, (_, index) => ({
      id: index + 10, productId: scope === "activity" ? 30 : 70, type: scope === "activity" ? 3 : 0,
      unique: `extra${String(index).padStart(3, "0")}`, suk: `额外规格${index}`,
    })));
    await expect(read()).rejects.toThrow("超过500项");
  });

  it("counts valid real members and pending orders exactly like reservePinkJoin, never cached counts or quantities", async () => {
    await f.db.insert(storePink).values([
      { id: 402, combinationId: 999, kId: 400, uid: 77, status: 2 }, // linked rows follow the transactional predicate
      { id: 403, combinationId: 30, kId: 400, uid: 11, status: 3 },
      { id: 404, combinationId: 30, kId: 400, uid: 11, isRefund: 1 },
    ]);
    await f.db.insert(storeOrder).values([
      { id: 501, uid: 11, type: 3, pinkId: 400, paid: 1 },
      { id: 502, uid: 11, type: 3, pinkId: 400, status: -1 },
      { id: 503, uid: 11, type: 3, pinkId: 400, isDel: 1 },
      { id: 504, uid: 11, type: 0, pinkId: 400 },
      { id: 505, uid: 11, type: 3, pinkId: 999 },
    ]);
    const before = await f.snapshot();
    expect((await read(11, "400")).requested_group).toMatchObject({ active_people: 3, reserved_people: 1,
      available_places: 0, already_joined: false, has_pending_order: false });
    await expect(withTx(f.container, tx => reservePinkJoin(tx, { uid: 11, leaderId: 400, combinationId: 30 }))).rejects.toThrow("已满");
    expect(await f.snapshot()).toEqual(before);
  });

  it("returns full, already-joined and own-pending requested groups rather than silently choosing open-group", async () => {
    await f.db.update(storePink).set({ uid: 11 }).where(eq(storePink.id, 401));
    const joined = (await read(11, "400")).requested_group;
    expect(joined).toMatchObject({ id: 400, already_joined: true, available_places: 1, has_pending_order: false });
    await expect(withTx(f.container, tx => reservePinkJoin(tx, { uid: 11, leaderId: 400, combinationId: 30 }))).rejects.toThrow("已参加");
    await f.db.update(storePink).set({ uid: 33 }).where(eq(storePink.id, 401));
    await f.db.update(storeOrder).set({ uid: 11 }).where(eq(storeOrder.id, 500));
    expect((await read(11, "400")).requested_group).toMatchObject({ id: 400, already_joined: false, has_pending_order: true });
    await expect(withTx(f.container, tx => reservePinkJoin(tx, { uid: 11, leaderId: 400, combinationId: 30 }))).rejects.toThrow("待支付");
    await f.db.update(storePink).set({ people: 1 }).where(eq(storePink.id, 400));
    expect((await read(11, "400")).requested_group).toMatchObject({ available_places: 0, has_pending_order: true });
    expect((await read(0, "400")).requested_group).toMatchObject({ already_joined: false, has_pending_order: false });
  });

  it("rejects missing, member, foreign, refunded, completed and expired requested leader IDs", async () => {
    for (const raw of ["30", "70", "401", "999"]) await expect(read(11, raw)).rejects.toThrow("指定拼团");
    for (const change of [{ combinationId: 31 }, { kId: 12 }, { isRefund: 9 }, { status: 2 }, { status: 3 }, { stopTime: new Date(0) }]) {
      await f.db.update(storePink).set({ combinationId: 30, kId: 0, isRefund: 0, status: 1, stopTime: new Date(Date.now() + 60_000), ...change }).where(eq(storePink.id, 400));
      await expect(read(11, "400")).rejects.toThrow("指定拼团");
      expect((await read()).groups).toEqual([]);
    }
    const now = new Date();
    await f.db.update(storePink).set({ stopTime: now }).where(eq(storePink.id, 400));
    await expect(service.read(11, "30", "400", now)).rejects.toThrow("指定拼团");
    await f.db.update(storePink).set({ stopTime: null }).where(eq(storePink.id, 400));
    expect((await read(11, "400")).requested_group).toMatchObject({ stop_time: null });
  });

  it("limits suggestions to five and aggregates a separately requested sixth leader consistently", async () => {
    await f.db.insert(storePink).values(Array.from({ length: 7 }, (_, index) => ({
      id: 410 + index, combinationId: 30, productId: 70, uid: 80 + index, people: 2, addTime: 20,
    })));
    const result = await read(11, "400");
    expect(result.groups.map(group => group.id)).toEqual([416, 415, 414, 413, 412]);
    expect(result.requested_group).toMatchObject({ id: 400, active_people: 2, reserved_people: 1 });
    const included = await read(11, "416");
    expect(included.requested_group).toEqual(included.groups[0]);
  });

  it("submits the activity SKU through real cart HTTP and persists the corresponding base SKU without stock/order writes", async () => {
    const detail = await read(11, "400"), sku = detail.skus[1];
    const pair = await resolveLegacyActivitySkuPair(f.db, { activityId: detail.combination_id, productId: detail.product_id, type: 3, unique: sku.unique });
    expect(pair.baseSku.unique).toBe("qablue01");
    const before = await f.snapshot();
    const response = await f.app.request("/api/cart/add", { method: "POST", headers: {
      "content-type": "application/json", "Authori-zation": "Bearer isolated-combination-session",
    }, body: JSON.stringify({ productId: detail.product_id, activityId: detail.combination_id, type: 3,
      unique: sku.unique, cartNum: 2, new: 1 }) }, f.env);
    expect(await response.json()).toMatchObject({ status: 200, data: { cartId: expect.any(Number) } });
    expect(await f.db.select().from(storeCart)).toMatchObject([{ uid: 11, productId: 70, activityId: 30,
      type: 3, productAttrUnique: "qablue01", cartNum: 2, isNew: 1 }]);
    const after = await f.snapshot();
    expect({ ...after, carts: before.carts }).toEqual(before);
    expect((await read(11, "400")).requested_group).toEqual(detail.requested_group);
  });
});
