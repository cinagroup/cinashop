import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createPcCheckoutQuoteFixture } from "./pcCheckoutQuoteFixture";
import { combinationList, combinationDetail } from "../../src/controllers/api/v1/UserActivityController";
import { cartAdd, cartList } from "../../src/controllers/api/v1/OrderController";
import { storeCombination, storePink, storeProductAttrValue, storeCart, storeOrder, storeOrderRefund, systemConfig } from "../../src/models/schema";
import type { AppVariables, Env } from "../../src/env";

/** Disposable HTTP/SQL fixture. No production auth, order-create or payment route is mounted. */
export async function createPcCombinationFixture() {
  const f = await createPcCheckoutQuoteFixture([storeCombination, storePink, storeOrderRefund, systemConfig]);
  try {
    for (const key of Object.keys(f.config)) f.config[key] = "0";
    await f.db.delete(storeCart);
    const startTime = new Date(Date.now() - 3_600_000), stopTime = new Date(Date.now() + 3_600_000);
    await f.db.insert(storeCombination).values({ id: 30, productId: 70, storeName: "拼团红蓝双规格", price: "6.25", otPrice: "10.00",
      people: 4, stock: 8, quota: 8, quotaShow: 8, onceNum: 3, num: 6, image: "/api/qa/image.svg", startTime, stopTime, effectiveTime: 1 });
    await f.db.insert(storeProductAttrValue).values([
      { id: 2, productId: 70, type: 0, unique: "qablue01", suk: "蓝色,小号", stock: 2, price: "20.00" },
      { id: 3, productId: 30, type: 3, unique: "actred30", suk: "红色,大号", stock: 7, quota: 6, price: "6.25", otPrice: "10.00" },
      { id: 4, productId: 30, type: 3, unique: "actblu30", suk: "蓝色,小号", stock: 4, quota: 4, price: "8.75", otPrice: "20.00" },
    ]);
    await f.db.insert(storePink).values([
      { id: 400, combinationId: 30, productId: 70, uid: 22, people: 4, memberCount: 999, stopTime, addTime: 10 },
      { id: 401, combinationId: 30, productId: 70, uid: 33, kId: 400, people: 4, stopTime },
    ]);
    await f.db.insert(storeOrder).values({ id: 500, uid: 44, orderId: "isolated-combination-reservation", type: 3,
      activityId: 30, pinkId: 400, paid: 0, status: 0, isDel: 0, totalNum: 3 });
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("container", f.container);
      // Synthetic principal confined to this fixture. The service still reads real user status/membership.
      c.set("uid", c.req.header("Authori-zation") === "Bearer isolated-combination-session" ? 11 : 0);
      await next();
    });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.get("/api/combination/list", combinationList);
    app.get("/api/combination/detail/:id", combinationDetail);
    app.post("/api/cart/add", cartAdd);
    app.get("/api/cart/list", cartList);
    const snapshot = async () => ({ ...await f.snapshot(),
      combinations: await f.db.select().from(storeCombination), pinks: await f.db.select().from(storePink),
      refunds: await f.db.select().from(storeOrderRefund),
      configs: await f.db.select().from(systemConfig), kv: [...f.cache], kvWrites: [...f.writes] });
    return { ...f, app, snapshot,
      setActive: (active: boolean) => f.db.update(storeCombination).set({ status: active ? 1 : 0 }).where(eq(storeCombination.id, 30)),
      clearCarts: () => f.db.delete(storeCart),
    };
  } catch (error) { await f.close(); throw error; }
}
