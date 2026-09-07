import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createPcCheckoutQuoteFixture } from "./helpers/pcCheckoutQuoteFixture";
import { storeProduct, storeProductAttrValue, storeProductRelation, userRelation, storeVisit, storeProductLog } from "../src/models/schema";
import { detail } from "../src/controllers/api/v1/ProductController";
import { normalizeMobileGoods } from "../../view/uniapp-ts/src/api/productDetail";

describe("UniApp selected SKU display contract from real product detail SQL", () => {
  it("retains independent member/original/regular prices and zero stock without writing business state", async () => {
    const f = await createPcCheckoutQuoteFixture([storeProductRelation, userRelation, storeVisit, storeProductLog]);
    try {
      f.app.get("/api/product/detail/:id", detail);
      await f.db.update(storeProduct).set({ vipPrice: "0.00", otPrice: "99.00" }).where(eq(storeProduct.id, 70));
      await f.db.update(storeProductAttrValue).set({ otPrice: "12.00" }).where(eq(storeProductAttrValue.id, 1));
      await f.db.insert(storeProductAttrValue).values([
        { id: 2, productId: 70, unique: "qablue02", suk: "蓝色,小号", price: "20.00", otPrice: "25.00", vipPrice: "18.00", stock: 2 },
        { id: 3, productId: 70, unique: "qaempty3", suk: "售罄", price: "30.00", otPrice: "35.00", vipPrice: "0.00", stock: 0 },
      ]);
      const before = await f.snapshot(); const pending: Promise<unknown>[] = [];
      const response = await f.app.fetch(new Request("http://localhost/api/product/detail/70", { headers: { "x-fixture-user": "11" } }), f.env,
        { waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {}, props: {} });
      await Promise.all(pending);
      const body = await response.json() as { status: number; msg: string; data: unknown };
      expect(body.status, body.msg).toBe(200);
      const goods = normalizeMobileGoods(body.data);
      expect(goods.vip_price).toBe("0.00"); expect(goods.ot_price).toBe("99.00");
      expect(goods.skus).toEqual([
        { unique: "qared001", suk: "红色,大号", price: "10.00", ot_price: "12.00", vip_price: "9.00", stock: 8 },
        { unique: "qablue02", suk: "蓝色,小号", price: "20.00", ot_price: "25.00", vip_price: "18.00", stock: 2 },
        { unique: "qaempty3", suk: "售罄", price: "30.00", ot_price: "35.00", vip_price: "0.00", stock: 0 },
      ]);
      expect(await f.snapshot()).toEqual(before); expect(f.writes).toEqual([]);
      // Product detail intentionally records analytics, exclusively in this disposable database.
      expect(await f.db.select().from(storeVisit)).toHaveLength(1);
      expect(await f.db.select().from(storeProductLog)).toHaveLength(1);
    } finally { await f.close(); }
  });
});
