import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createContainerFromDb } from "../src/lib/di";
import { cancelStoreOrder, StoreOrderCreateService } from "../src/services/order/StoreOrderCreateService";
import {
  storeActivity, storeCart, storeOrder, storeOrderCartInfo, storeOrderStatus,
  storeProduct, storeProductAttrValue, storeSeckill, storeSeckillTime, printDocument, storeOrderOutbox,
} from "../src/models/schema";
import { createPcCheckoutQuoteFixture } from "./helpers/pcCheckoutQuoteFixture";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))(
  "historical seckill compensation against ordinary multi-line checkout on PostgreSQL 16", () => {
    let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
    let gatedCheckoutSkuId: number;

    const ordinaryInput = {
      uid: 11, key: "ordinary_two_sku", cartIds: [2, 3], type: 0,
      shippingType: 1, addressId: 11, cityId: 101,
      realName: "Isolated buyer", userPhone: "00000000000", userIp: "127.0.0.1",
    };
    const runtime = () => ({
      CONFIG_KV: f.env.CONFIG_KV,
      nextOrderId: async () => "isolated_ordinary_multi",
    });

    const state = async () => ({
      base: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id),
      products: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      children: await f.db.select().from(storeSeckill).orderBy(storeSeckill.id),
      orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
      lines: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      carts: await f.db.select().from(storeCart).orderBy(storeCart.id),
      statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
    });

    beforeEach(async () => {
      f = await createPcCheckoutQuoteFixture([
        storeActivity, storeSeckillTime, storeSeckill, storeOrderStatus, printDocument, storeOrderOutbox,
      ]);
      await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, "0"])));
      await f.db.insert(storeProductAttrValue).values({
        id: 4, productId: 70, type: 0, unique: "qablue01", suk: "蓝色,大号",
        stock: 7, sales: 1, price: "10.00",
      });
      await f.db.update(storeProductAttrValue).set({ stock: 7, sales: 1 })
        .where(eq(storeProductAttrValue.id, 1));
      await f.db.update(storeProduct).set({ stock: 6, sales: 2 })
        .where(eq(storeProduct.id, 70));
      await f.db.insert(storeCart).values([
        { id: 2, uid: 11, productId: 70, productAttrUnique: "qared001",
          cartNum: 1, type: 0, isNew: 1, status: 1 },
        { id: 3, uid: 11, productId: 70, productAttrUnique: "qablue01",
          cartNum: 1, type: 0, isNew: 1, status: 1 },
      ]);
      const checkoutCarts = await f.container.storeCartDao.getByIds(ordinaryInput.cartIds);
      expect(checkoutCarts).toHaveLength(2);
      expect(new Set(checkoutCarts.map(cart => cart.productAttrUnique)))
        .toEqual(new Set(["qared001", "qablue01"]));
      gatedCheckoutSkuId = checkoutCarts[0].productAttrUnique === "qared001" ? 1 : 4;
      const oppositeSkuId = gatedCheckoutSkuId === 1 ? 4 : 1;
      const skuFacts = (id: number) => id === 1
        ? { baseId: 1, activityId: 5, unique: "qared001", activityUnique: "qared020", suk: "红色,大号" }
        : { baseId: 4, activityId: 6, unique: "qablue01", activityUnique: "qablue20", suk: "蓝色,大号" };
      const historicalLines = [skuFacts(oppositeSkuId), skuFacts(gatedCheckoutSkuId)];

      const today = Math.floor((Date.now() + 28_800_000) / 86_400_000) * 86_400 - 28_800;
      await f.db.insert(storeActivity).values({
        id: 9, type: 1, status: 1, timeId: "4",
        startDay: today - 86_400, endDay: today + 86_400,
      });
      await f.db.insert(storeSeckillTime).values({
        id: 4, startTime: "0000", endTime: "2400", status: 1,
      });
      await f.db.insert(storeSeckill).values({
        id: 20, productId: 70, activityId: 9, timeId: "4",
        storeName: "Historical multi-line order", stock: 6, quota: 6, sales: 2,
        onceNum: 3, num: 10, status: 1, isShow: 1, isDel: 0,
      });
      await f.db.insert(storeProductAttrValue).values(historicalLines.map(line => ({
        id: line.activityId, productId: 20, type: 1, unique: line.activityUnique,
        suk: line.suk, stock: 6, quota: 6, sales: 1, price: "6.25",
      })));
      await f.db.insert(storeCart).values(historicalLines.map((line, index) => ({
        id: 10 + index, uid: 11, productId: 70, productAttrUnique: line.unique,
        cartNum: 1, type: 1, activityId: 20, isNew: 1, status: 1, isPay: 1,
      })));
      await f.db.insert(storeOrder).values({
        id: 500, uid: 11, orderId: "isolated_legacy_multi", type: 1, activityId: 20,
        cartId: "10,11", totalNum: 2, totalPrice: "12.50", payPrice: "12.50",
        useIntegral: "0.00", paid: 0, status: 0, isDel: 0,
      });
      await f.db.insert(storeOrderCartInfo).values(historicalLines.map((line, index) => ({
        id: 10 + index, oid: 500, uid: 11, cartId: String(10 + index), productId: 70,
        skuUnique: line.unique, cartNum: 1, splitSurplusNum: 1, surplusNum: 1,
        cartInfo: JSON.stringify({
          sku: { id: line.baseId }, activitySku: { id: line.activityId },
        }),
      })));

      // Only the real ordinary checkout's selected stock decrement enters this
      // test-only gate. The AFTER trigger runs while PostgreSQL still holds its
      // SKU row lock; no service inventory operation is replaced.
      await f.exec("CREATE FUNCTION ordinary_checkout_sku_gate() RETURNS trigger " +
        "LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(8102, 15); " +
        "RETURN NEW; END $$");
      await f.exec("CREATE TRIGGER ordinary_checkout_sku_gate " +
        "AFTER UPDATE ON store_product_attr_value FOR EACH ROW " +
        "WHEN (OLD.id = " + gatedCheckoutSkuId + " AND NEW.stock < OLD.stock) " +
        "EXECUTE FUNCTION ordinary_checkout_sku_gate()");
    }, 30_000);

    afterEach(async () => { await f?.close(); });

    it("returns 409 while ordinary checkout holds both SKUs, rolls back, and retries original identities", async () => {
      const before = await state();
      await withFinancePeers(f.db, async ([holder, buyer, canceller]) => {
        await holder.exec("BEGIN; SELECT pg_advisory_xact_lock(8102, 15)");
        let held = true;
        let buying: Promise<unknown> | undefined;
        try {
          buying = outcome(StoreOrderCreateService.createWithRuntime(
            createContainerFromDb(buyer.db), runtime(), ordinaryInput,
          ));
          await waitForFinanceBlock(f.db, buyer.pid, holder.pid);

          // Probe the actual checkout lock footprint at this barrier. Both
          // base SKUs may already be held before the chosen UPDATE trigger
          // fires. Savepoints recover from 55P03 without releasing the
          // holder's earlier advisory lock.
          const probeSku = async (id: number) => {
            await holder.exec("SAVEPOINT ordinary_sku_probe");
            try {
              return await outcome(holder.exec(
                "SELECT id FROM store_product_attr_value WHERE id = " + id + " FOR UPDATE NOWAIT",
              ));
            } finally {
              await holder.exec("ROLLBACK TO SAVEPOINT ordinary_sku_probe");
              await holder.exec("RELEASE SAVEPOINT ordinary_sku_probe");
            }
          };
          const gatedProbe = await probeSku(gatedCheckoutSkuId);
          expect(gatedProbe).toMatchObject({ ok: false, error: { code: "55P03" } });
          const oppositeSkuId = gatedCheckoutSkuId === 1 ? 4 : 1;
          const oppositeProbe = await probeSku(oppositeSkuId);
          expect(oppositeProbe).toMatchObject({ ok: false, error: { code: "55P03" } });
          await waitForFinanceBlock(f.db, buyer.pid, holder.pid);

          const cancelStarted = performance.now();
          const busy = await outcome(cancelStoreOrder(
            createContainerFromDb(canceller.db),
            { uid: 11, orderId: "isolated_legacy_multi" },
          ));
          // The peers have an 8-second lock timeout; a 409 after that timeout
          // would not prove the compensation prelock used NOWAIT.
          expect(performance.now() - cancelStarted).toBeLessThan(4_000);
          expect(busy).toMatchObject({
            ok: false, error: { code: 409, httpStatus: 409 },
          });
          expect(await state()).toEqual(before);
          await waitForFinanceBlock(f.db, buyer.pid, holder.pid);

          await holder.exec("COMMIT");
          held = false;
          const purchased = await buying;
          expect(purchased).toMatchObject({
            ok: true, value: { orderId: "isolated_ordinary_multi", key: ordinaryInput.key },
          });
        } finally {
          if (held) await holder.exec("ROLLBACK");
          if (buying) await buying;
        }

        // Both operations retain their original identity after the conflict.
        const replay = await StoreOrderCreateService.createWithRuntime(
          createContainerFromDb(buyer.db), runtime(), ordinaryInput,
        );
        expect(replay).toMatchObject({
          orderId: "isolated_ordinary_multi", key: ordinaryInput.key,
        });
        await cancelStoreOrder(createContainerFromDb(canceller.db),
          { uid: 11, orderId: "isolated_legacy_multi" });
      });

      const after = await state();
      expect(after.base.find(row => row.id === 1)).toMatchObject({ stock: 7, sales: 1 });
      expect(after.base.find(row => row.id === 4)).toMatchObject({ stock: 7, sales: 1 });
      expect(after.base.find(row => row.id === 5)).toMatchObject({ stock: 7, quota: 7, sales: 0 });
      expect(after.base.find(row => row.id === 6)).toMatchObject({ stock: 7, quota: 7, sales: 0 });
      expect(after.products.find(row => row.id === 70)).toMatchObject({ stock: 6, sales: 2 });
      expect(after.children.find(row => row.id === 20)).toMatchObject({
        stock: 8, quota: 8, sales: 0,
      });
      expect(after.orders.filter(row => row.orderId === "isolated_ordinary_multi"))
        .toMatchObject([{ uid: 11, type: 0, paid: 0, status: 0, isDel: 0 }]);
      expect(after.orders.find(row => row.orderId === "isolated_legacy_multi"))
        .toMatchObject({ uid: 11, type: 1, status: -2, isDel: 1 });
      expect(after.lines.filter(row => row.oid === 500)).toHaveLength(2);
      const ordinaryOrder = after.orders.find(row => row.orderId === "isolated_ordinary_multi");
      expect(ordinaryOrder).toBeDefined();
      expect(after.lines.filter(row => row.oid === ordinaryOrder!.id)).toHaveLength(2);
      expect(after.carts.filter(row => [2, 3].includes(row.id)).map(row => row.isPay))
        .toEqual([1, 1]);
      expect(after.carts.filter(row => [10, 11].includes(row.id)).map(row => row.isPay))
        .toEqual([0, 0]);
      expect(after.statuses.filter(row => row.changeType === "cancel")).toHaveLength(1);
      await expect(cancelStoreOrder(f.container,
        { uid: 11, orderId: "isolated_legacy_multi" })).rejects.toThrow();
      expect(await state()).toEqual(after);
    }, 30_000);
  },
);
