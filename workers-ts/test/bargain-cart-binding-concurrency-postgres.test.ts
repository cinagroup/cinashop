import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createBargainSelectionFixture } from "./helpers/bargainSelectionFixture";
import { outcome, waitForFinanceBlock, withFinancePeers, type FinancePeer } from "./helpers/financePeers";
import { createContainerFromDb } from "../src/lib/di";
import { StoreCartService } from "../src/services/order/StoreCartService";
import { StoreOrderCreateService } from "../src/services/order/StoreOrderCreateService";
import { storeCart, storeBargainUser, storeOrderCartInfo, storeOrderStatus, printDocument, systemStore } from "../src/models/schema";

// Actual independent PG16 connections; no production credentials or PGlite race substitute.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("bargain cart binding independent PG16 admission", () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => {
    f = await createBargainSelectionFixture([storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    await f.db.insert(storeBargainUser).values({ id: 90, uid: 11, bargainId: 40,
      bargainPrice: "10.00", bargainPriceMin: "4.00", price: "6.00", status: 3 });
  }, 30000);
  afterEach(async () => { await f?.close(); });
  const add = (peer?: FinancePeer, participant = 80) => new StoreCartService(peer ? createContainerFromDb(peer.db) : f.container).add({
    uid: 11, productId: 70, type: 2, activityId: 40, unique: "actred40", cartNum: 1, isNew: 0, bargainUserId: participant,
  });

  it.each([80, 90])("serializes concurrent adds for participation 80 / %s without losing or crossing quantity", async participant => {
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec("BEGIN; SELECT pg_advisory_xact_lock(1128354388,11)");
      const a = outcome(add(first, 80)); await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(add(second, participant)); await waitForFinanceBlock(f.db, second.pid, blocker.pid);
      await blocker.exec("COMMIT");
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra).toMatchObject({ ok: true }); expect(rb).toMatchObject({ ok: true });
      if (!ra.ok || !rb.ok) throw new Error("Both cart admissions must succeed");
      expect(ra.value.id === rb.value.id).toBe(participant === 80);
    });
    const carts = await f.db.select().from(storeCart).orderBy(storeCart.bargainUserId);
    expect(carts.map(row => [row.bargainUserId, row.cartNum])).toEqual(participant === 80 ? [[80, 2]] : [[80, 1], [90, 1]]);
    expect((await f.snapshot()).orders).toHaveLength(0);
    expect((await f.snapshot()).bargains[0]).toMatchObject({ stock: 8, quota: 8, sales: 0 });
  }, 15000);

  it("does not deadlock or merge into a cart consumed by a real concurrent checkout", async () => {
    const cart = await add();
    await withFinancePeers(f.db, async ([blocker, buyer, adder]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE");
      const purchase = outcome(StoreOrderCreateService.createWithRuntime(createContainerFromDb(buyer.db), {
        CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => "binding_merge_race_order",
      }, { uid: 11, key: "binding_merge_race", cartIds: [cart.id], type: 2, shippingType: 2, storeId: 1,
        realName: "隔离并发", userPhone: "00000000000", userIp: "127.0.0.1" }));
      await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      // READ COMMITTED preflight sees the old cart and ready participation.
      // It must wait at guarded cart UPDATE, never hold a participation lock
      // while waiting for checkout's cart claim (which would reverse lock order).
      const addition = outcome(add(adder)); await waitForFinanceBlock(f.db, adder.pid, buyer.pid);
      await blocker.exec("COMMIT");
      expect(await purchase).toMatchObject({ ok: true });
      expect(await addition).toMatchObject({ ok: false, error: { message: expect.stringContaining("砍价购物车已变化或被占用") } });
    });
    const state = await f.snapshot();
    expect(state.carts).toHaveLength(1);
    expect(state.carts[0]).toMatchObject({ bargainUserId: 80, cartNum: 1, isPay: 1 });
    expect(state.orders).toHaveLength(1); expect(state.orders[0]).toMatchObject({ totalNum: 1, payPrice: "2.00" });
    expect(state.participations.find(row => row.id === 80)?.status).toBe(4);
    expect(state.participations.find(row => row.id === 90)?.status).toBe(3);
    expect(state.bargains[0]).toMatchObject({ stock: 7, quota: 7, sales: 1 });
    expect(state.skus.find(row => row.id === 1)).toMatchObject({ stock: 7, sales: 1 });
  }, 15000);
});
