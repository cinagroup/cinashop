import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { financePostgres } from "./helpers/financePostgres";
import { createContainerFromDb } from "../src/lib/di";
import { storeCart, storeProduct, storeProductAttrValue } from "../src/models/schema";
import { StoreCartService } from "../src/services/order/StoreCartService";
import { cartAdd, cartList, cartCount } from "../src/controllers/api/v1/OrderController";
import type { AppVariables, Env } from "../src/env";

// Real DAO/service/controller execution on disposable PGlite (or the explicitly
// allowlisted CI PG16 helper). No production URL, provider, login or order call.
describe("FE-002E direct purchase cart isolation", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let service: StoreCartService;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  const input = { uid: 11, productId: 701, unique: "real-red", cartNum: 2 };

  beforeAll(async () => {
    fixture = await financePostgres([storeProduct, storeProductAttrValue, storeCart]);
    const container = createContainerFromDb(fixture.db);
    service = new StoreCartService(container);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("uid", 11); c.set("container", container); await next(); });
    app.post("/cart/add", cartAdd);
    app.get("/cart/list", cartList);
    app.get("/cart/count", cartCount);
  });
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(storeProduct).values({ id: 701, storeName: "隔离商品", price: "19.90",
      stock: 20, isShow: 1, isVerify: 1, isDel: 0 });
    await fixture.db.insert(storeProductAttrValue).values({ id: 901, productId: 701,
      unique: "real-red", suk: "红色,大号", price: "19.90", stock: 8, type: 0 });
  });

  it("keeps direct quantities separate from existing normal carts and other direct buys", async () => {
    const normal = await service.add({ ...input, cartNum: 4 });
    const direct = await service.add({ ...input, isNew: 1 });
    const another = await service.add({ ...input, cartNum: 1, isNew: 1 });
    expect(new Set([normal.id, direct.id, another.id]).size).toBe(3);
    expect(await service.add({ ...input, cartNum: 1 })).toEqual({ id: normal.id, cartNum: 5 });
    expect(await service.list(11, { mode: "cart" })).toMatchObject([{ id: normal.id, cartNum: 5, isNew: 0 }]);
    expect(await service.list(11, { mode: "buy", ids: [another.id, direct.id] })).toMatchObject([
      { id: another.id, cartNum: 1, isNew: 1 }, { id: direct.id, cartNum: 2, isNew: 1 },
    ]);
    expect(await service.list(11)).toHaveLength(3); // Explicitly retained legacy unscoped contract.
    expect(await (await app.request("/cart/count?scope=cart")).json()).toMatchObject({ status: 200, data: { count: 1 } });
    expect(await (await app.request("/cart/count")).json()).toMatchObject({ status: 200, data: { count: 3 } });
  });

  it("never merges a normal add into a direct row created first", async () => {
    const direct = await service.add({ ...input, isNew: 1 });
    const normal = await service.add(input);
    expect(normal.id).not.toBe(direct.id);
    expect(await service.list(11, { mode: "buy", ids: [direct.id] })).toMatchObject([{ cartNum: 2 }]);
  });

  it("does not merge an invalid normal cart", async () => {
    const previous = await service.add(input);
    await fixture.db.update(storeCart).set({ status: 0 }).where(eq(storeCart.id, previous.id));
    expect((await service.add(input)).id).not.toBe(previous.id);
  });

  it("rejects the entire direct set for foreign, regular, missing, paid or deleted rows", async () => {
    const own = await service.add({ ...input, isNew: 1 });
    const foreign = await service.add({ ...input, uid: 12, isNew: 1 });
    const normal = await service.add(input);
    const paid = await service.add({ ...input, isNew: 1 });
    const deleted = await service.add({ ...input, isNew: 1 });
    await fixture.db.update(storeCart).set({ isPay: 1 }).where(eq(storeCart.id, paid.id));
    await fixture.db.update(storeCart).set({ isDel: 1 }).where(eq(storeCart.id, deleted.id));
    for (const id of [foreign.id, normal.id, paid.id, deleted.id, 999999]) {
      await expect(service.list(11, { mode: "buy", ids: [own.id, id] })).rejects.toThrow();
    }
  });

  it("rejects empty, duplicate, noninteger, unsafe and oversized ID sets", async () => {
    for (const ids of [[], [1, 1], [0], [-1], [1.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 1],
      Array.from({ length: 101 }, (_, i) => i + 1)]) {
      await expect(service.list(11, { mode: "buy", ids })).rejects.toThrow();
    }
  });

  it("rechecks quantity, SKU existence and product availability before direct display", async () => {
    const direct = await service.add({ ...input, isNew: 1 });
    await fixture.db.update(storeProductAttrValue).set({ stock: 1 }).where(eq(storeProductAttrValue.id, 901));
    await expect(service.list(11, { mode: "buy", ids: [direct.id] })).rejects.toThrow();
    await fixture.db.update(storeProductAttrValue).set({ stock: 8, isRetired: 1 }).where(eq(storeProductAttrValue.id, 901));
    await expect(service.list(11, { mode: "buy", ids: [direct.id] })).rejects.toThrow();
    await fixture.db.update(storeProductAttrValue).set({ isRetired: 0 }).where(eq(storeProductAttrValue.id, 901));
    await fixture.db.update(storeProduct).set({ isShow: 0 }).where(eq(storeProduct.id, 701));
    await expect(service.list(11, { mode: "buy", ids: [direct.id] })).rejects.toThrow();
  });

  it("rejects unknown SKU, overstock, zero/fractional quantity and invalid purchase flags without writes", async () => {
    for (const delta of [{ unique: "sku00701" }, { cartNum: 9 }, { cartNum: 0 }, { cartNum: 1.5 },
      { isNew: 2 }, { isNew: Number.NaN }]) {
      await expect(service.add({ ...input, ...delta })).rejects.toThrow();
    }
    expect(await service.list(11)).toEqual([]);
  });

  it("executes v1 aliases, response IDs and explicit read scopes through the controller", async () => {
    for (const flag of ["new", "is_new", "isNew"]) {
      const response = await app.request("/cart/add", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: 701, uniqueId: "real-red", cartNum: 2, [flag]: "1" }) });
      const body = await response.json<{ status: number; data: { id: number; cartId: number; cartNum: number } }>();
      expect(body.status).toBe(200);
      expect(body.data.cartId).toBe(body.data.id);
      const listed = await (await app.request(`/cart/list?scope=buy&ids=${body.data.id}`)).json<{ status: number; data: unknown[] }>();
      expect(listed.status).toBe(200);
      expect(listed.data).toMatchObject([{ id: body.data.id, cartNum: 2, isNew: 1 }]);
    }
    expect(await (await app.request("/cart/list?scope=cart")).json()).toMatchObject({ status: 200, data: [] });
  });

  it("fails closed for malformed scopes and flags at the HTTP boundary", async () => {
    for (const query of ["scope=buy", "scope=buy&ids=", "scope=buy&ids=1,bad", "scope=buy&ids=1,1",
      "scope=buy&ids=0", "scope=buy&ids=1.5", "scope=cart&ids=1", "ids=1", "scope=anything"]) {
      const body = await (await app.request(`/cart/list?${query}`)).json<{ status: number }>();
      expect(body.status).not.toBe(200);
    }
    for (const value of [2, -1, true, [], {}, "invalid"]) {
      const body = await (await app.request("/cart/add", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: 701, unique: "real-red", new: value }) })).json<{ status: number }>();
      expect(body.status).not.toBe(200);
    }
    expect(await service.list(11)).toEqual([]);
  });
});
