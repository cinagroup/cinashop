import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createContainerFromDb, withTx } from "../src/lib/di";
import { createBargainSelectionFixture } from "./helpers/bargainSelectionFixture";
import { StoreOrderCreateService, cancelStoreOrder, type CreateOrderParams } from "../src/services/order/StoreOrderCreateService";
import { readBargainOrderParticipation } from "../src/services/activity/BargainOrderSnapshot";
import { storeBargainUser, storeBargain, storeCart, storeProductAttrValue, storeOrderCartInfo,
  storeOrderStatus, printDocument, systemStore } from "../src/models/schema";

const identity = { version: 1, participantId: 80, activityId: 40, uid: 11 };
const encoded = (value: unknown) => ({ cartInfo: JSON.stringify(value) });
describe("bargain order identity decoding", () => {
  it("allows legacy lookup only when every valid cart lacks the identity field", () => {
    expect(readBargainOrderParticipation([encoded({}), encoded({ sku: { id: 1 } })], 11, 40)).toBeNull();
    expect(readBargainOrderParticipation([encoded({ bargainParticipation: identity }), encoded({ bargainParticipation: identity })], 11, 40)).toEqual(identity);
  });
  it.each([null, [], 0, { ...identity, version: 2 }, { ...identity, participantId: "80" },
    { ...identity, participantId: 0 }, { ...identity, participantId: 2_147_483_648 },
    { ...identity, uid: 22 }, { ...identity, activityId: 41 }])("rejects malformed or mismatched identity %j", value => {
    expect(() => readBargainOrderParticipation([encoded({ bargainParticipation: value })], 11, 40)).toThrow("快照");
  });
  it("rejects mixed, conflicting, empty and malformed cart snapshots", () => {
    for (const rows of [[], [{ cartInfo: null }], [{ cartInfo: "{" }], [encoded(null)], [encoded([])],
      [encoded({ bargainParticipation: identity }), encoded({})],
      [encoded({ bargainParticipation: identity }), encoded({ bargainParticipation: { ...identity, participantId: 83 } })]]) {
      expect(() => readBargainOrderParticipation(rows, 11, 40)).toThrow("快照");
    }
  });
});

describe("actual bargain create/cancel on isolated SQL (no payment/provider)", () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  const params: CreateOrderParams = { uid: 11, key: "bargain_identity", cartIds: [10], type: 2, bargainUserId: 80,
    shippingType: 2, storeId: 1, realName: "隔离砍价测试", userPhone: "00000000000", userIp: "127.0.0.1" };
  beforeEach(async () => {
    f = await createBargainSelectionFixture([storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    await f.db.insert(storeCart).values({ id: 10, uid: 11, productId: 70, productAttrUnique: "qared001",
      cartNum: 1, type: 2, activityId: 40, isNew: 1, status: 1 });
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const create = (input = params, beforeTransaction?: () => Promise<void>) => StoreOrderCreateService.createWithRuntime(f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => { await beforeTransaction?.(); return `isolated_${input.key}`; } }, input);
  const cancel = (key = params.key, uid = 11) => cancelStoreOrder(f.container, { uid, orderId: `isolated_${key}` });
  const snapshot = async () => {
    const state = await f.snapshot();
    // Physical row order changes after UPDATE; sequence allocation is not transactional.
    return { ...state, sequences: undefined,
      carts: state.carts.sort((a, b) => a.id - b.id), skus: state.skus.sort((a, b) => a.id - b.id),
      users: state.users.sort((a, b) => a.uid - b.uid), orders: state.orders.sort((a, b) => a.id - b.id),
      details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
      prints: await f.db.select().from(printDocument) };
  };
  const alterSnapshot = async (value: unknown) => {
    const [row] = await f.db.select().from(storeOrderCartInfo);
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ ...JSON.parse(row.cartInfo!), bargainParticipation: value }) });
  };
  const legacySnapshot = async () => {
    const [row] = await f.db.select().from(storeOrderCartInfo);
    const value = JSON.parse(row.cartInfo!); delete value.bargainParticipation;
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(value) });
  };

  it("stores exact consumed identity and cancels only that participation despite older used rows", async () => {
    const initial = await snapshot();
    await create();
    const created = await snapshot();
    expect(created.orders[0]).toMatchObject({ activityId: 40, type: 2, payPrice: "2.00", paid: 0 });
    expect(JSON.parse(created.details[0].cartInfo!).bargainParticipation).toEqual(identity);
    expect(created.participations.find(row => row.id === 80)?.status).toBe(4);
    expect(created.skus.find(row => row.id === 3)).toMatchObject({ stock: 6, quota: 5, sales: 1 });
    await create(); expect(await snapshot()).toEqual(created);
    await cancel();
    const cancelled = await snapshot();
    expect(cancelled.participations).toEqual(initial.participations);
    expect(cancelled.products).toEqual(initial.products); expect(cancelled.skus).toEqual(initial.skus);
    expect(cancelled.bargains).toEqual(initial.bargains); expect(cancelled.carts).toEqual(initial.carts);
    expect(cancelled.orders[0]).toMatchObject({ status: -2, isDel: 1 });
    expect(cancelled.statuses.filter(row => row.changeType === "cancel")).toHaveLength(1);
    await expect(cancel()).rejects.toThrow("不允许取消");
    expect(await snapshot()).toEqual(cancelled);
  });

  it("binds two actual orders to different participations and preserves a later live participation", async () => {
    await create();
    await f.db.insert(storeBargainUser).values({ id: 90, bargainId: 40, uid: 11, bargainPrice: "10.00", bargainPriceMin: "2.00", price: "8.00", status: 3 });
    await f.db.insert(storeCart).values({ id: 11, uid: 11, productId: 70, productAttrUnique: "qared001",
      cartNum: 1, type: 2, activityId: 40, isNew: 1, status: 1 });
    await create({ ...params, key: "second_participation", cartIds: [11], bargainUserId: 90 });
    await f.db.insert(storeBargainUser).values({ id: 91, bargainId: 40, uid: 11, bargainPrice: "10.00", bargainPriceMin: "2.00", price: "0.00", status: 1 });
    await cancel();
    let state = await snapshot();
    expect(state.participations.find(row => row.id === 80)?.status).toBe(3);
    expect(state.participations.find(row => row.id === 90)?.status).toBe(4);
    expect(state.participations.find(row => row.id === 91)).toMatchObject({ status: 1, price: "0.00" });
    await cancel("second_participation"); state = await snapshot();
    expect(state.participations.find(row => row.id === 90)?.status).toBe(3);
    expect(state.participations.find(row => row.id === 83)?.status).toBe(4);
    expect(state.bargains[0]).toMatchObject({ stock: 8, quota: 8, sales: 0 });
    expect(state.skus.find(row => row.id === 3)).toMatchObject({ stock: 7, quota: 6, sales: 0 });
    // Selection policy with multiple live rows remains a separate open requirement.
  });

  it.each([null, { ...identity, version: 2 }, { ...identity, participantId: "80" },
    { ...identity, participantId: 81 }, { ...identity, uid: 22 }, { ...identity, activityId: 41 }])(
    "does not fall back from invalid new snapshot %j even with one legacy candidate", async value => {
      await create(); await f.db.update(storeBargainUser).set({ status: 2 }).where(eq(storeBargainUser.id, 83));
      await alterSnapshot(value); const before = await snapshot();
      await expect(cancel()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
    });

  it.each([{ uid: 22 }, { bargainId: 41 }, { isDel: 1 }, { status: 3 }])("refuses changed participant identity/state %j without compensation", async values => {
    await create(); await f.db.update(storeBargainUser).set(values).where(eq(storeBargainUser.id, 80));
    const before = await snapshot(); await expect(cancel()).rejects.toThrow("无法唯一定位");
    expect(await snapshot()).toEqual(before);
  });

  it("rejects mixed new/legacy cart snapshots before touching any inventory", async () => {
    await create();
    const [row] = await f.db.select().from(storeOrderCartInfo);
    const value = JSON.parse(row.cartInfo!); delete value.bargainParticipation;
    await f.db.insert(storeOrderCartInfo).values({ ...row, id: row.id + 100,
      unique: "mixed_local_snapshot", cartInfo: JSON.stringify(value) });
    const before = await snapshot(); await expect(cancel()).rejects.toThrow("快照"); expect(await snapshot()).toEqual(before);
  });

  it("keeps unambiguous pre-snapshot orders cancellable, but refuses ambiguous legacy identities", async () => {
    await create(); await legacySnapshot(); const before = await snapshot();
    await expect(cancel()).rejects.toThrow("无法唯一定位"); expect(await snapshot()).toEqual(before);
    await f.db.update(storeBargainUser).set({ status: 2 }).where(eq(storeBargainUser.id, 83));
    await cancel(); expect((await snapshot()).participations.find(row => row.id === 80)?.status).toBe(3);
  });

  it("checks cancellation ownership and rolls all compensation back when activity SKU restoration fails", async () => {
    await create(); let before = await snapshot();
    await expect(cancel(params.key, 22)).rejects.toThrow("订单不存在"); expect(await snapshot()).toEqual(before);
    await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.id, 3)); before = await snapshot();
    await expect(cancel()).rejects.toThrow("活动 SKU 库存无法恢复"); expect(await snapshot()).toEqual(before);
  });

  it.each([{ bargainId: 41 }, { price: "7.00" }, { bargainPrice: "11.00", price: "9.00" }])(
    "rejects participant changes after quote %j and rolls cart/activity reservation back", async values => {
      let before: Awaited<ReturnType<typeof snapshot>>;
      await expect(create(params, async () => {
        await f.db.update(storeBargainUser).set(values).where(eq(storeBargainUser.id, 80)); before = await snapshot();
      })).rejects.toThrow("参与报价已变化");
      expect(await snapshot()).toEqual(before!);
    });

  it.each([
    { cartNum: 2 }, { cartNum: 0 }, { cartNum: -1 }, { productId: 71 },
    { productAttrUnique: "qablue01" }, { productType: 1 }, { activityId: 41 },
    { type: 0 }, { isNew: 0 }, { uid: 22 }, { staffId: 1 }, { touristUid: "another-session" },
    { isPay: 1 }, { isDel: 1 }, { status: 0 },
    { bargainUserId: 90 },
  ])("refuses cart changes after quote %j without consuming inventory or participation", async values => {
    let before: Awaited<ReturnType<typeof snapshot>>;
    await expect(create(params, async () => {
      await f.db.update(storeCart).set(values).where(eq(storeCart.id, 10)); before = await snapshot();
    })).rejects.toThrow("砍价购物车已变化或被占用");
    // The outside writer's update remains; only the failed checkout rolls back.
    expect(await snapshot()).toEqual(before!);
    expect(before!.orders).toHaveLength(0); expect(before!.details).toHaveLength(0);
    expect(before!.participations.find(row => row.id === 80)?.status).toBe(3);
  });

  it("accepts a fresh SKU/quantity quote after refusing the stale cart claim and cancels exact inventory", async () => {
    await expect(create(params, async () => {
      await f.db.update(storeCart).set({ productAttrUnique: "qablue01", cartNum: 2 }).where(eq(storeCart.id, 10));
    })).rejects.toThrow("砍价购物车已变化或被占用");
    const refreshed = await snapshot();
    await create();
    const created = await snapshot();
    expect(created.orders[0]).toMatchObject({ totalNum: 2, payPrice: "4.00", activityId: 40 });
    expect(created.skus.find(row => row.id === 1)).toEqual(refreshed.skus.find(row => row.id === 1));
    expect(created.skus.find(row => row.id === 2)?.stock).toBe(0);
    expect(created.skus.find(row => row.id === 4)).toMatchObject({ stock: 2, quota: 2, sales: 2 });
    expect(JSON.parse(created.details[0].cartInfo!).bargainParticipation).toEqual(identity);
    await cancel();
    const cancelled = await snapshot();
    for (const field of ["carts", "products", "skus", "bargains", "participations"] as const)
      expect(cancelled[field]).toEqual(refreshed[field]);
  });

  it("does not reject non-quote metadata changes and keeps legacy activity/SKU aliases cancellable", async () => {
    await f.db.update(storeCart).set({ productAttrUnique: "actred40" }).where(eq(storeCart.id, 10));
    await create({ ...params, bargainUserId: undefined, bargainId: 40 }, async () => {
      await f.db.update(storeCart).set({ addTime: 123 }).where(eq(storeCart.id, 10));
    });
    const created = await snapshot();
    expect(created.orders[0]).toMatchObject({ payPrice: "2.00", totalNum: 1 });
    expect(created.carts[0]).toMatchObject({ addTime: 123, productAttrUnique: "actred40", isPay: 1 });
    // Completed-key retries must remain idempotent, even if the live cart changes later.
    await f.db.update(storeCart).set({ cartNum: 2 }).where(eq(storeCart.id, 10));
    const retried = await snapshot(); await create(); expect(await snapshot()).toEqual(retried);
    await cancel();
    const cancelled = await snapshot();
    expect(cancelled.skus.find(row => row.id === 3)).toMatchObject({ stock: 7, quota: 6, sales: 0 });
    expect(cancelled.participations.find(row => row.id === 80)?.status).toBe(3);
  });

  it("rolls back participant consumption when a later activity SKU reservation fails", async () => {
    let before: Awaited<ReturnType<typeof snapshot>>;
    await expect(create(params, async () => {
      await f.db.update(storeProductAttrValue).set({ stock: 0 }).where(eq(storeProductAttrValue.id, 3)); before = await snapshot();
    })).rejects.toThrow(); expect(await snapshot()).toEqual(before!);
  });

  it.each(["7.00", "9.00"])("rejects unfinished/over-cut participation (%s) at actual creation", async price => {
    await f.db.update(storeBargainUser).set({ price }).where(eq(storeBargainUser.id, 80));
    const before = await snapshot(); await expect(create()).rejects.toThrow("砍价金额异常"); expect(await snapshot()).toEqual(before);
  });

  it("rechecks activity expiry between quote and transaction without consuming a participation", async () => {
    let before: Awaited<ReturnType<typeof snapshot>>;
    await expect(create(params, async () => {
      await f.db.update(storeBargain).set({ stopTime: new Date(Date.now() - 60_000) }).where(eq(storeBargain.id, 40)); before = await snapshot();
    })).rejects.toThrow("活动库存不足"); expect(await snapshot()).toEqual(before!);
  });

  it.each(["UTC", "Asia/Shanghai", "America/New_York"])("creates with UTC-stored activity dates in a %s SQL session", async timezone => {
    // SET LOCAL and the actual service share one transaction/backend, including on PG16.
    await withTx(f.container, async tx => {
      await tx.execute(sql`SELECT set_config('TimeZone', ${timezone}, true)`);
      await StoreOrderCreateService.createWithRuntime(createContainerFromDb(tx),
        { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => `isolated_${params.key}` }, params);
    });
    expect((await snapshot()).orders[0]).toMatchObject({ payPrice: "2.00", activityId: 40 });
    await cancel(); expect((await snapshot()).bargains[0].stock).toBe(8);
  });
});
