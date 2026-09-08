import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createBargainSelectionFixture } from "./helpers/bargainSelectionFixture";
import { outcome, waitForFinanceBlock, withFinancePeers, type FinancePeer } from "./helpers/financePeers";
import { createContainerFromDb } from "../src/lib/di";
import { StoreOrderCreateService, cancelStoreOrder, type CreateOrderParams } from "../src/services/order/StoreOrderCreateService";
import { storeCart, storeBargainUser, systemStore, storeOrderCartInfo, storeOrderStatus, printDocument } from "../src/models/schema";

// Only independent PG16 backends can prove these row-wait/conditional-update races.
// Never replace with PGlite concurrency or inherit production credentials.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("bargain order identity across independent PG16 backends", () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  const params: CreateOrderParams = { uid: 11, key: "bargain_race", cartIds: [10], type: 2, bargainUserId: 80,
    shippingType: 2, storeId: 1, realName: "隔离砍价并发", userPhone: "00000000000", userIp: "127.0.0.1" };
  beforeEach(async () => {
    f = await createBargainSelectionFixture([storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    await f.db.insert(storeCart).values([10, 11].map(id => ({ id, uid: 11, productId: 70,
      productAttrUnique: "qared001", cartNum: 1, type: 2, activityId: 40, isNew: 1, status: 1 })));
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const create = (peer?: FinancePeer, input = params) => StoreOrderCreateService.createWithRuntime(
    peer ? createContainerFromDb(peer.db) : f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => `isolated_${input.key}` }, input);
  const cancel = (peer: FinancePeer) => cancelStoreOrder(createContainerFromDb(peer.db), { uid: 11, orderId: `isolated_${params.key}` });
  const snapshot = async () => {
    const value = await f.snapshot();
    return { ...value, sequences: undefined, carts: value.carts.sort((a, b) => a.id - b.id),
      skus: value.skus.sort((a, b) => a.id - b.id),
      details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id) };
  };

  it("two carts cannot consume one exact participation twice after an observed row wait", async () => {
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_bargain_user WHERE id=80 FOR UPDATE");
      const a = outcome(create(first)); await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(create(second, { ...params, key: "bargain_other", cartIds: [11] }));
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      await blocker.exec("COMMIT");
      expect(await a).toMatchObject({ ok: true }); expect(await b).toMatchObject({ ok: false });
    });
    const state = await snapshot(); expect(state.orders).toHaveLength(1); expect(state.details).toHaveLength(1);
    expect(JSON.parse(state.details[0].cartInfo!).bargainParticipation).toEqual({ version: 1, participantId: 80, activityId: 40, uid: 11 });
    expect(state.bargains[0]).toMatchObject({ stock: 7, quota: 7, sales: 1 });
    expect(state.carts.map(row => row.isPay)).toEqual([1, 0]);
    expect(state.participations.find(row => row.id === 80)?.status).toBe(4);
  }, 15_000);

  it("duplicate cancellation waits on the same order and restores the snapshot participation once", async () => {
    await create();
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_bargain_user WHERE id=80 FOR UPDATE");
      const a = outcome(cancel(first)); await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(cancel(second)); await waitForFinanceBlock(f.db, second.pid, first.pid);
      await blocker.exec("COMMIT");
      expect(await a).toMatchObject({ ok: true }); expect(await b).toMatchObject({ ok: false });
    });
    const state = await snapshot(); expect(state.bargains[0]).toMatchObject({ stock: 8, quota: 8, sales: 0 });
    expect(state.participations.find(row => row.id === 80)?.status).toBe(3);
    expect(state.participations.find(row => row.id === 83)?.status).toBe(4);
    expect(state.statuses.filter(row => row.changeType === "cancel")).toHaveLength(1);
  }, 15_000);

  it("participant ownership changed during cancellation wait causes a full compensation rollback", async () => {
    await create(); const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, canceller]) => {
      await blocker.exec("BEGIN; UPDATE store_bargain_user SET uid=22 WHERE id=80");
      const pending = outcome(cancel(canceller)); await waitForFinanceBlock(f.db, canceller.pid, blocker.pid);
      await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringContaining("状态无法恢复") } });
    });
    const after = await snapshot();
    expect(after).toEqual({ ...before, participations: before.participations.map(row => row.id === 80 ? { ...row, uid: 22 } : row) });
    expect((await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, 80)))[0].status).toBe(4);
  }, 15_000);
});
