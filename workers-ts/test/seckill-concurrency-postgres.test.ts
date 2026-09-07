import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createPcCheckoutQuoteFixture } from "./helpers/pcCheckoutQuoteFixture";
import { withFinancePeers, waitForFinanceBlock, waitForFinanceClock, outcome, type FinancePeer } from "./helpers/financePeers";
import { createContainerFromDb, withTx } from "../src/lib/di";
import { StoreOrderCreateService, type CreateOrderParams } from "../src/services/order/StoreOrderCreateService";
import { StoreCartService } from "../src/services/order/StoreCartService";
import { storeActivity, storeSeckillTime, storeSeckill, storeProductAttrValue, systemStore,
  storeCart, storeOrderCartInfo, storeOrderStatus, printDocument } from "../src/models/schema";

// PGlite cannot prove independent backend locks. CI supplies its dedicated PG16
// service to BOTH unit shards; the exact-coverage gate refuses skipped assertions.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("seckill independent PostgreSQL 16 backends", () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  const params: CreateOrderParams = { uid: 11, key: "concurrent_order", cartIds: [1], type: 1, seckillId: 20,
    shippingType: 2, storeId: 1, realName: "隔离并发样本", userPhone: "00000000000", userIp: "127.0.0.1" };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([storeActivity, storeSeckillTime, storeSeckill, storeOrderCartInfo, storeOrderStatus, printDocument]);
    for (const key of Object.keys(f.config)) f.config[key] = "0";
    await f.db.update(systemStore).set({ isStore: 1 });
    await f.db.update(storeCart).set({ type: 1, activityId: 20 });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 20, type: 1, unique: "qatime01", suk: "红色,大号",
      stock: 7, quota: 6, price: "6.25" });
    const today = Math.floor((Date.now() + 28_800_000) / 86_400_000) * 86_400 - 28_800;
    await f.db.insert(storeActivity).values({ id: 9, type: 1, status: 1, timeId: "4", startDay: today - 86_400, endDay: today + 86_400 });
    await f.db.insert(storeSeckillTime).values({ id: 4, startTime: "0000", endTime: "2400", status: 1 });
    await f.db.insert(storeSeckill).values({ id: 20, productId: 70, activityId: 9, timeId: "4", storeName: "隔离秒杀",
      stock: 7, quota: 6, onceNum: 3, num: 10, status: 1, isShow: 1, isDel: 0 });
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const snapshot = async () => ({ ...await f.snapshot(), children: await f.db.select().from(storeSeckill),
    details: await f.db.select().from(storeOrderCartInfo), statuses: await f.db.select().from(storeOrderStatus),
    prints: await f.db.select().from(printDocument) });
  const create = (peer: FinancePeer, input = params) => StoreOrderCreateService.createWithRuntime(createContainerFromDb(peer.db),
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => `isolated_${input.key}` }, input);
  const oneOrder = async () => {
    const state = await snapshot();
    expect(state.orders).toHaveLength(1); expect(state.details).toHaveLength(1);
    expect(state.orders[0]).toMatchObject({ totalNum: 2, payPrice: "12.50", paid: 0 });
    expect(state.products[0].stock).toBe(6);
    expect(state.skus.find(sku => sku.id === 1)?.stock).toBe(6);
    expect(state.skus.find(sku => sku.id === 2)).toMatchObject({ stock: 5, quota: 4 });
    expect(state.carts.filter(cart => cart.isPay === 1)).toHaveLength(1);
    return state;
  };

  it.each(["parent", "slot"])("rereads a stopped %s after an observed lock wait and rolls back", async target => {
    const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, buyer]) => {
      await blocker.exec("BEGIN");
      if (target === "parent") await blocker.db.update(storeActivity).set({ status: 0 }).where(eq(storeActivity.id, 9));
      else await blocker.db.update(storeSeckillTime).set({ status: 0 }).where(eq(storeSeckillTime.id, 4));
      const pending = outcome(create(buyer));
      await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringMatching(/已停用|有效的启用时段/) } });
    });
    expect(await snapshot()).toEqual(before);
  }, 15_000);

  it.each(["parent", "slot"])("holds the %s admission lock until the actual order transaction commits", async target => {
    await withFinancePeers(f.db, async ([blocker, buyer, editor]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_cart WHERE id=1 FOR UPDATE");
      const pending = outcome(create(buyer));
      await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      const edit = outcome(target === "parent"
        ? editor.db.update(storeActivity).set({ status: 0 }).where(eq(storeActivity.id, 9))
        : editor.db.update(storeSeckillTime).set({ status: 0 }).where(eq(storeSeckillTime.id, 4)));
      await waitForFinanceBlock(f.db, editor.pid, buyer.pid);
      await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: true }); expect(await edit).toMatchObject({ ok: true });
    });
    expect((await oneOrder()).children[0]).toMatchObject({ stock: 5, quota: 4 });
  }, 15_000);

  it("refuses reparenting between discovery and the waited parent lock", async () => {
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    await withFinancePeers(f.db, async ([blocker, buyer]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_activity WHERE id=9 FOR UPDATE");
      const pending = outcome(create(buyer));
      await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      await blocker.db.update(storeSeckill).set({ activityId: 99 }).where(eq(storeSeckill.id, 20));
      await blocker.exec("COMMIT");
      before = await snapshot();
      expect(await pending).toMatchObject({ ok: false, error: { message: "秒杀排期已变化，请重试" } });
    });
    expect(await snapshot()).toEqual(before);
  }, 15_000);

  it("quantity editing waits for an uncommitted real order claim and refuses after commit", async () => {
    await withFinancePeers(f.db, async ([blocker, buyer, editor]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE");
      const pending = outcome(create(buyer));
      await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      const edit = outcome(new StoreCartService(createContainerFromDb(editor.db)).setNum(11, 1, 3));
      await waitForFinanceBlock(f.db, editor.pid, buyer.pid);
      await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: true });
      expect(await edit).toMatchObject({ ok: false, error: { message: expect.stringContaining("已下单") } });
    });
    const state = await oneOrder();
    expect(state.carts[0]).toMatchObject({ cartNum: 2, isPay: 1 });
    expect(state.children[0]).toMatchObject({ stock: 5, quota: 4 });
  }, 15_000);

  it.each(["stock", "total-limit"])("two independently blocked buyers cannot exceed shared %s", async target => {
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 70, productAttrUnique: "qared001", cartNum: 2,
      type: 1, activityId: 20, isNew: 1, status: 1 });
    await f.db.update(storeSeckill).set(target === "stock" ? { stock: 3, quota: 3 } : { num: 3 });
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_activity WHERE id=9 FOR UPDATE");
      const a = outcome(create(first)), b = outcome(create(second, { ...params, key: "second_order", cartIds: [2] }));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      await waitForFinanceBlock(f.db, second.pid, blocker.pid);
      await blocker.exec("COMMIT");
      const results = await Promise.all([a, b]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.find(result => !result.ok)).toMatchObject({ ok: false,
        error: { message: expect.stringMatching(target === "stock" ? /库存不足/ : /总共限购/) } });
    });
    expect((await oneOrder()).children[0]).toMatchObject(target === "stock" ? { stock: 1, quota: 1 } : { stock: 5, quota: 4 });
  }, 15_000);

  it("rechecks the cart CAS after waiting for a real quantity transaction to commit", async () => {
    const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, buyer, editor]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_activity WHERE id=9 FOR UPDATE");
      const pending = outcome(create(buyer));
      await waitForFinanceBlock(f.db, buyer.pid, blocker.pid); // preflight captured quantity=2
      let ready!: () => void, release!: () => void;
      const changed = new Promise<void>(resolve => { ready = resolve; });
      const commit = new Promise<void>(resolve => { release = resolve; });
      const editing = outcome(withTx(createContainerFromDb(editor.db), async tx => {
        // The real quantity service runs in a savepoint. The test's enclosing
        // transaction only prolongs its locks; it does not replace its SQL.
        await new StoreCartService(createContainerFromDb(tx)).setNum(11, 1, 3);
        ready(); await commit;
      }));
      try {
        await Promise.race([changed, editing.then(result => { if (!result.ok) throw result.error; })]);
        await blocker.exec("COMMIT");
        await waitForFinanceBlock(f.db, buyer.pid, editor.pid);
      } finally { release(); }
      expect(await editing).toMatchObject({ ok: true });
      expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringMatching(/已变化|被占用/) } });
    });
    expect(await snapshot()).toEqual({ ...before, carts: before.carts.map(cart => ({ ...cart, cartNum: 3 })) });
  }, 15_000);

  it("same-key retries actually wait on each other and return one committed order", async () => {
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_activity WHERE id=9 FOR UPDATE");
      const a = outcome(create(first));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(create(second));
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      await blocker.exec("COMMIT");
      const results = await Promise.all([a, b]);
      expect(results[0]).toMatchObject({ ok: true }); expect(results[1]).toEqual(results[0]);
    });
    expect((await oneOrder()).children[0]).toMatchObject({ stock: 5, quota: 4 });
  }, 15_000);

  it.each(["order", "quantity"])("a real cart lock wait crossing the database deadline refuses %s", async target => {
    const [clock] = await f.db.select({ now: sql<string>`(extract(epoch from clock_timestamp()) * 1000)::text` })
      .from(sql`(values (1)) as probe(n)`);
    const deadline = Math.floor(Number(clock.now)) + 3_000;
    await f.db.update(storeSeckill).set({ stopTime: new Date(deadline) });
    const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, buyer]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_cart WHERE id=1 FOR UPDATE");
      const pending = outcome<unknown>(target === "order" ? create(buyer)
        : new StoreCartService(createContainerFromDb(buyer.db)).setNum(11, 1, 3));
      await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      await waitForFinanceClock(f.db, deadline + 1);
      await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringMatching(/秒杀已结束|秒杀库存不足/) } });
    });
    expect(await snapshot()).toEqual(before);
  }, 15_000);
});
