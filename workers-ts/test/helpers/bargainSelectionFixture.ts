import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createPcCheckoutQuoteFixture } from "./pcCheckoutQuoteFixture";
import { bargainDetail } from "../../src/controllers/api/v1/UserActivityController";
import { startBargain, myBargains, cancelBargain } from "../../src/controllers/api/v1/ActivityJoinController";
import { cartAdd, cartList, orderConfirm, orderComputed } from "../../src/controllers/api/v1/OrderController";
import { storeBargain, storeBargainUser, storeBargainUserHelp, storeProductAttr, storeProductAttrResult, storeProductAttrValue, storeProductDescription, storeCart, user } from "../../src/models/schema";
import type { AppVariables, Env } from "../../src/env";

/** Owned SQL fixture using the existing PGlite / dedicated loopback PG16 guard.
 * Auth and KV are isolated substitutes. No order-create/payment route is mounted.
 */
export async function createBargainSelectionFixture(extraTables: PgTable[] = []) {
  const f = await createPcCheckoutQuoteFixture([storeBargain, storeBargainUser, storeBargainUserHelp, storeProductAttr, storeProductAttrResult, storeProductDescription, ...extraTables]);
  try {
    for (const key of Object.keys(f.config)) f.config[key] = "0";
    await f.db.delete(storeCart);
    await f.db.insert(storeProductAttr).values([
      { productId: 70, type: 0, attrName: '颜色', attrValues: '红色,蓝色' },
      { productId: 70, type: 0, attrName: '尺码', attrValues: '大号,小号' },
    ]);
    // Catalog visibility uses the stored isMoneyLevel flag, not isEverLevel.
    await f.db.update(user).set({ isMoneyLevel: 1 }).where(eq(user.uid, 11));
    const startTime = new Date(Date.now() - 3_600_000), stopTime = new Date(Date.now() + 3_600_000);
    await f.db.insert(user).values({ uid: 22, account: "other-local-owner", nickname: "另一隔离用户" });
    await f.db.insert(storeBargain).values({ id: 40, productId: 70, title: "砍价真实规格目录", price: "10.00", minPrice: "2.00",
      people: 2, stock: 8, quota: 8, image: "/api/qa/image.svg", startTime, stopTime, freight: 1 });
    await f.db.insert(storeProductAttrValue).values([
      { id: 2, productId: 70, type: 0, unique: "qablue01", suk: "蓝色,小号", stock: 2, price: "20.00" },
      { id: 3, productId: 40, type: 2, unique: "actred40", suk: "红色,大号", stock: 7, quota: 6, price: "777.00", otPrice: "888.00" },
      { id: 4, productId: 40, type: 2, unique: "actblu40", suk: "蓝色,小号", stock: 4, quota: 4, price: "999.00", otPrice: "999.00" },
    ]);
    // Explicit fixture IDs must not collide with the next real admin SKU insert.
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'), (SELECT max(id) FROM store_product_attr_value), true)");
    await f.db.insert(storeBargainUser).values([
      { id: 80, bargainId: 40, uid: 11, bargainPrice: "10.00", bargainPriceMin: "2.00", price: "8.00", status: 3 },
      { id: 81, bargainId: 40, uid: 22, bargainPrice: "10.00", bargainPriceMin: "2.00", price: "1.00", status: 1 },
      { id: 82, bargainId: 40, uid: 11, bargainPrice: "10.00", bargainPriceMin: "2.00", price: "2.00", status: 2 },
      { id: 83, bargainId: 40, uid: 11, bargainPrice: "10.00", bargainPriceMin: "2.00", price: "8.00", status: 4 },
    ]);
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("container", f.container);
      c.set("uid", c.req.header("x-fixture-user") === "11" ? 11 : c.req.header("x-fixture-user") === "22" ? 22 : 0);
      await next();
    });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.get("/api/bargain/detail/:id", bargainDetail);
    app.post("/api/bargain/start", startBargain);
    app.get("/api/bargain/user/list", myBargains);
    app.post("/api/bargain/user/cancel", cancelBargain);
    app.post("/api/cart/add", cartAdd); app.get("/api/cart/list", cartList);
    app.post("/api/order/confirm", orderConfirm); app.post("/api/order/computed/:key", orderComputed);
    const snapshot = async () => ({ ...await f.snapshot(),
      bargains: await f.db.select().from(storeBargain).orderBy(storeBargain.id),
      participations: await f.db.select().from(storeBargainUser).orderBy(storeBargainUser.id),
      helps: await f.db.select().from(storeBargainUserHelp).orderBy(storeBargainUserHelp.id),
      sequences: await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`),
      kv: [...f.cache], kvWrites: [...f.writes] });
    return { ...f, app, snapshot, startTime, stopTime,
      setReady: (ready: boolean) => f.db.update(storeBargainUser).set({ status: ready ? 3 : 1, price: ready ? "8.00" : "1.00" }).where(eq(storeBargainUser.id, 80)),
    };
  } catch (error) { await f.close(); throw error; }
}
