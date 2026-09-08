import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createBargainSelectionFixture } from "./helpers/bargainSelectionFixture";
import { BargainSkuCatalogService } from "../src/services/activity/BargainSkuCatalogService";
import { storeBargain, storeBargainUser, storeProduct, storeProductAttrValue, user } from "../src/models/schema";
import { normalizeCheckoutQuote, type CheckoutQuoteOptions } from "../../view/pc-ts/src/api/checkoutQuote";
import type { CartItem } from "../../view/pc-ts/src/types/order";

describe("bounded bargain selection catalogue, actual controller and isolated SQL", () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => { f = await createBargainSelectionFixture(); }, 30000);
  afterEach(async () => { await f?.close(); });
  const read = (uid = 11, record?: string, now?: Date) => new BargainSkuCatalogService(f.container).read(uid, "40", record, now);
  const request = (url: string, method = "GET", body?: object, uid = "11") => f.app.request(`/api${url}`, {
    method, headers: { "x-fixture-user": uid, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }, f.env);

  it("returns private no-store projection and keeps public requests free of participant identity or quote promises", async () => {
    const before = await f.snapshot();
    const response = await request("/bargain/detail/40?view=skus&uid=11&vip=1", "GET", undefined, "");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const wire = await response.json() as { status: number; data: Awaited<ReturnType<typeof read>> };
    expect(wire.status).toBe(200);
    expect(wire.data).toMatchObject({ selection_only: true, type: 2, bargain_id: 40, product_id: 70,
      activity_price: "10.00", minimum_price: "2.00", participation: null, can_select: false });
    expect(wire.data.skus.map(sku => [sku.unique, sku.base_unique, sku.max_quantity, sku.catalog_price])).toEqual([
      ["actred40", "qared001", 6, null], ["actblu40", "qablue01", 2, null],
    ]);
    expect(JSON.stringify(wire.data)).not.toMatch(/"(?:uid|nickname|avatar|account|cost|customForm|rule)"/);
    expect(await f.snapshot()).toEqual(before);
  });
  it("interprets actual Worker ready state 3 and participation price instead of arbitrary SKU prices", async () => {
    const before = await f.snapshot(), result = await read();
    expect(result).toMatchObject({ can_select: true, participation: { id: 80, status: 3, state: "ready", original_price: "10.00",
      cut_price: "8.00", current_price: "2.00", remaining_cut: "0.00", catalog_price: "2.00", progress_percent: 100, activity_price_changed: false } });
    expect(result.skus.map(sku => sku.catalog_price)).toEqual(["2.00", "2.00"]);
    expect(await f.snapshot()).toEqual(before);
  });
  it("returns accurate unfinished progress, never a hard-coded minimum 10 percent or purchase permission", async () => {
    await f.setReady(false); const result = await read();
    expect(result).toMatchObject({ can_select: false, participation: { state: "cutting", current_price: "9.00", remaining_cut: "7.00", progress_percent: 12 } });
    await f.db.update(storeBargainUser).set({ price: "0.00" }).where(eq(storeBargainUser.id, 80));
    expect((await read()).participation?.progress_percent).toBe(0);
  });
  it.each([["82", "closed"], ["83", "used"]])("keeps exact owned record %s visible as %s without authorizing selection", async (record, state) => {
    expect(await read(11, record)).toMatchObject({ can_select: false, participation: { id: Number(record), state } });
  });
  it("refuses another owner, anonymous requested IDs, wrong activities, deleted records and namespace aliases", async () => {
    const before = await f.snapshot();
    for (const [uid, record] of [[11, "81"], [0, "80"], [11, "40"], [22, "80"]] as const) {
      await expect(read(uid, record)).rejects.toThrow();
    }
    await f.db.update(storeBargainUser).set({ bargainId: 99 }).where(eq(storeBargainUser.id, 80));
    await expect(read(11, "80")).rejects.toThrow(/当前用户及活动/);
    await f.db.update(storeBargainUser).set({ bargainId: 40, isDel: 1 }).where(eq(storeBargainUser.id, 80));
    await expect(read(11, "80")).rejects.toThrow(/当前用户及活动/);
    await f.db.update(storeBargainUser).set({ isDel: 0 }).where(eq(storeBargainUser.id, 80));
    expect(await f.snapshot()).toEqual(before);
  });
  it("rejects implicit ambiguity but allows an exact owned participation without hiding other states", async () => {
    await f.db.update(storeBargainUser).set({ status: 1 }).where(eq(storeBargainUser.id, 82));
    await expect(read()).rejects.toThrow(/不唯一/);
    expect(await read(11, "80")).toMatchObject({ can_select: true, participation: { id: 80, state: "ready" } });
    expect(await read(11, "82")).toMatchObject({ can_select: false, participation: { id: 82, state: "cutting" } });
    expect((await read(0)).participation).toBeNull();
  });
  it("does not silently restart or expose consumed participation when no live record exists", async () => {
    await f.db.update(storeBargainUser).set({ status: 4 }).where(eq(storeBargainUser.id, 80));
    expect(await read()).toMatchObject({ participation: null, can_select: false });
    expect(await read(11, "80")).toMatchObject({ participation: { state: "used" }, can_select: false });
  });
  it("uses the existing inclusive timestamp window, while rejecting inverted dates", async () => {
    expect((await read(11, undefined, f.startTime)).date_window).toBe("active");
    expect((await read(11, undefined, f.stopTime)).date_window).toBe("active");
    expect(await read(11, undefined, new Date(f.startTime.getTime() - 1))).toMatchObject({ date_window: "future", can_select: false });
    expect(await read(11, undefined, new Date(f.stopTime.getTime() + 1))).toMatchObject({ date_window: "ended", can_select: false });
    await f.db.update(storeBargain).set({ startTime: f.stopTime, stopTime: f.startTime });
    await expect(read()).rejects.toThrow(/日期/);
  });
  it.each([{ isShow: 0 }, { isDel: 1 }, { isVerify: 0 }])("refuses nonvisible base product %j", async change => {
    await f.db.update(storeProduct).set(change).where(eq(storeProduct.id, 70)); await expect(read()).rejects.toThrow(/不可见/);
  });
  it.each([{ status: 0 }, { isDel: 1 }])("refuses disabled or deleted activity %j", async change => {
    await f.db.update(storeBargain).set(change).where(eq(storeBargain.id, 40)); await expect(read()).rejects.toThrow(/不可见/);
  });
  it("derives membership and active status from the principal, never request flags", async () => {
    await f.db.update(storeProduct).set({ isVipProduct: 1 }).where(eq(storeProduct.id, 70));
    await expect(read(0)).rejects.toThrow(/不可见/); await expect(read(22)).rejects.toThrow(/不可见/);
    await expect(read(11)).resolves.toMatchObject({ product_id: 70 });
    await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 11)); await expect(read(11)).rejects.toThrow(/重新登录/);
  });
  it("fails invalid views, duplicate selectors and noncanonical IDs without falling back to raw detail", async () => {
    const before = await f.snapshot();
    for (const query of ["view=oops", "view=skus&view=skus", "bargain_user_id=80", "view=skus&bargain_user_id=80&bargain_user_id=81",
      "view=skus&bargain_user_id=0", "view=skus&bargain_user_id=080", "view=skus&bargain_user_id=1e2"]) {
      expect((await (await request(`/bargain/detail/40?${query}`)).json() as { status: number }).status).toBe(400);
    }
    for (const raw of ["0", "040", "-1", "2147483648", "1e2", "40x", " 40", 40, null]) {
      await expect(new BargainSkuCatalogService(f.container).read(11, raw)).rejects.toThrow();
    }
    expect((await (await request("/bargain/detail/40")).json() as { data: object }).data).not.toHaveProperty("selection_only");
    expect(await f.snapshot()).toEqual(before);
  });
  it("refuses missing, retired and conflicting SKU mappings rather than guessing a base unique", async () => {
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 2));
    await expect(read()).rejects.toThrow(/基础规格/);
    await f.db.update(storeProductAttrValue).set({ isRetired: 0 }).where(eq(storeProductAttrValue.id, 2));
    await f.db.update(storeProductAttrValue).set({ unique: "qablue01" }).where(eq(storeProductAttrValue.id, 3));
    await expect(read()).rejects.toThrow(/标识冲突/);
  });
  it("retains empty and sold-out catalogue states without base-SKU fallback or unsafe selection", async () => {
    await f.db.update(storeBargain).set({ quota: 0 });
    expect(await read()).toMatchObject({ can_select: false, skus: [expect.objectContaining({ max_quantity: 0 }), expect.objectContaining({ max_quantity: 0 })] });
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.type, 2));
    expect(await read()).toMatchObject({ skus: [], can_select: false });
  });
  it.each([{ price: "9.00" }, { bargainPriceMin: "11.00" }, { price: "-1.00" }, { status: 9 }, { status: 3, price: "1.00" }])(
    "refuses inconsistent participation %j", async change => {
      await f.db.update(storeBargainUser).set(change).where(eq(storeBargainUser.id, 80));
      await expect(read(11, "80")).rejects.toThrow(/金额|状态/);
    },
  );
  it.each([0, 2])("bounds SKU set type %s at 500 with overflow detection and rejects duplicate labels", async type => {
    await f.db.insert(storeProductAttrValue).values({ id: 5, productId: 40, type: 2, unique: "dup0040", suk: "红色,大号" });
    await expect(read()).rejects.toThrow(/不唯一/);
    await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.id, 5));
    await f.db.insert(storeProductAttrValue).values(Array.from({ length: 499 }, (_, i) => ({
      id: i + 10, productId: type === 0 ? 70 : 40, type, unique: `x${i}`, suk: `额外${i}`, stock: 1,
    })));
    await expect(read()).rejects.toThrow(/超过500/);
  });
  it("filters unsafe image URLs, never returning credentials or script/data URLs", async () => {
    await f.db.update(storeBargain).set({ image: "https://user:secret@example.test/image" });
    await f.db.update(storeProductAttrValue).set({ image: "javascript:alert(1)" }).where(eq(storeProductAttrValue.type, 2));
    await f.db.update(storeProduct).set({ image: "//other.example/image" }).where(eq(storeProduct.id, 70));
    const result = await read(); expect(result.image).toBe(""); expect(result.skus.every(sku => sku.image === "")).toBe(true);
  });
  it.each(["0", "750ms"])("executes a read-only repeatable snapshot, caps deadlines and restores caller setting %s", async deadline => {
    const settingsSql = sql`SELECT current_setting('transaction_isolation') AS isolation,
      current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS deadline,
      current_setting('idle_in_transaction_session_timeout') AS idle`;
    // The two supported SQL drivers expose execute results as rows or { rows }.
    const rows = (result: unknown) => {
      if (Array.isArray(result)) return result;
      if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) return result.rows;
      throw new Error("Unexpected SQL result shape");
    };
    await f.db.execute(sql`SELECT set_config('statement_timeout', ${deadline}, false),
      set_config('idle_in_transaction_session_timeout', ${deadline}, false)`);
    const before = rows(await f.db.execute(settingsSql));
    const original = f.db.transaction.bind(f.db), observed: unknown[] = [];
    const spy = vi.spyOn(f.db, "transaction").mockImplementation((fn, config) => original(async tx => {
      const result = await fn(tx);
      observed.push(...rows(await tx.execute(settingsSql)));
      return result;
    }, config));
    try { await read(); } finally { spy.mockRestore(); }
    expect(observed).toEqual([{ isolation: "repeatable read", readonly: "on",
      deadline: deadline === "0" ? "5s" : "750ms", idle: deadline === "0" ? "5s" : "750ms" }]);
    expect(rows(await f.db.execute(settingsSql))).toEqual(before);
  });
  it("round-trips real activity SKU to the owner's cart and exact full quote, including mutable activity-price effect", async () => {
    for (const activityPrice of ["10.00", "12.00"]) {
      await f.db.update(storeBargain).set({ price: activityPrice });
      const result = await read(), sku = result.skus[1];
      const add = await (await request("/cart/add", "POST", { productId: 70, activityId: 40, type: 2, unique: sku.unique, cartNum: 2, new: 1 })).json() as { status: number; data: { id: number } };
      expect(add.status).toBe(200);
      const cart = (await (await request(`/cart/list?scope=buy&ids=${add.data.id}`)).json() as { data: CartItem[] }).data;
      const options: CheckoutQuoteOptions = { type: 2, bargainUserId: 80, addressId: 11, shippingType: 1, storeId: 0, couponId: 0, useIntegral: false };
      const before = await f.snapshot();
      const response = await (await request("/order/confirm", "POST", { ...options, cartIds: [add.data.id] })).json() as { status: number; msg: string; data: unknown };
      expect(response.status, response.msg).toBe(200);
      const quote = normalizeCheckoutQuote(response.data, cart, options);
      expect(quote.items[0].quotedUnitPrice).toBe(sku.catalog_price);
      expect(sku.catalog_price).toBe(activityPrice === "10.00" ? "2.00" : "4.00");
      expect(result.participation?.activity_price_changed).toBe(activityPrice !== "10.00");
      const after = await f.snapshot();
      expect({ ...after, kv: before.kv, kvWrites: before.kvWrites }).toEqual(before);
    }
  });
});
