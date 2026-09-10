import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createPcCheckoutQuoteFixture } from "./helpers/pcCheckoutQuoteFixture";
import { withFinancePeers, waitForFinanceBlock, outcome } from "./helpers/financePeers";
import { createContainerFromDb } from "../src/lib/di";
import type { ScheduledMaintenanceMessage } from "../src/env";
import { ActivityJoinService } from "../src/services/activity/ActivityJoinService";
import { PinkCancellationRecoveryService } from "../src/services/activity/PinkCancellationRecoveryService";
import { PinkCancellationStatusService } from "../src/services/activity/PinkCancellationStatusService";
import { StoreOrderRefundService } from "../src/services/order/StoreOrderRefundService";
import { ScheduledMaintenanceService, createScheduledRunMessages, isScheduledMaintenanceMessage } from "../src/services/order/ScheduledMaintenanceService";
import { prepareOrderQueueDeadLetter } from "../src/services/order/OrderQueueDeadLetterService";
import { WechatPayService } from "../src/services/wechat/WechatPayService";
import { storeCombination, storePink, storeOrder, storeOrderCartInfo, storeOrderStatus, storeOrderRefund,
  storeOrderRefundPayment, storeOrderInvoice, userBrokerage, storeProductAttrValue, user } from "../src/models/schema";

describe("scheduled original pink cancellation recovery through actual SQL", () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let run: ScheduledMaintenanceMessage;
  const send = vi.fn().mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([storeCombination, storePink, storeOrderCartInfo, storeOrderStatus,
      storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    send.mockClear();
    f.env.ORDER_QUEUE = { send, sendBatch: vi.fn().mockResolvedValue({ metadata: { metrics: {} } }),
      metrics: vi.fn().mockResolvedValue({ backlogCount: 0, backlogBytes: 0 }) };
    run = createScheduledRunMessages(Date.now()).find(m => m.job === "pink_cancellation_recovery")!;
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("External network prohibited in isolated test"));
    vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await f.db.insert(storeCombination).values({ id: 30, productId: 70, storeName: "Isolated background refund", people: 4,
      price: "6.25", stock: 7, quota: 7, sales: 1 });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 30, type: 3, unique: "actred30", suk: "红色,大号", stock: 7, quota: 7, sales: 1, price: "6.25" });
    await f.db.insert(storePink).values({ id: 400, uid: 11, orderId: "isolated-paid-leader", orderIdKey: "500",
      combinationId: 30, productId: 70, people: 4, memberCount: 1, stopTime: sql`NOW() + INTERVAL '1 day'` });
    await f.db.insert(storeOrder).values({ id: 500, uid: 11, orderId: "isolated-paid-leader", type: 3, activityId: 30,
      pinkId: 400, paid: 1, payType: "yue", totalNum: 1, payPrice: "6.25" });
    await f.db.insert(storeOrderCartInfo).values({ id: 1, uid: 11, oid: 500, cartId: "1", productId: 70, skuUnique: "qared001", cartNum: 1,
      cartInfo: JSON.stringify({ truePrice: "6.25", sku: { id: 1 }, activitySku: { id: 2 } }) });
  }, 30_000);
  afterEach(async () => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); await f?.close(); });
  const cancel = () => new ActivityJoinService(f.container, f.env).removePink(11, 400, 30);
  const age = () => f.db.update(storeOrderRefund).set({ addTime: Math.floor(run.scheduledAt / 1000) - 300 });
  const recover = () => new ScheduledMaintenanceService(f.container, f.env).processMaintenance(run);
  const snapshot = async () => ({ ...await f.snapshot(), refunds: await f.db.select().from(storeOrderRefund),
    payments: await f.db.select().from(storeOrderRefundPayment), pinks: await f.db.select().from(storePink),
    details: await f.db.select().from(storeOrderCartInfo), combinations: await f.db.select().from(storeCombination),
    statuses: await f.db.select().from(storeOrderStatus) });
  async function acceptWithoutExecution() {
    const stop = vi.spyOn(StoreOrderRefundService.prototype, "agreeRefund").mockRejectedValueOnce(new Error("process interrupted after durable application"));
    await expect(cancel()).rejects.toThrow("process interrupted"); stop.mockRestore(); await age();
    return (await f.db.select().from(storeOrderRefund))[0];
  }

  it("cron, validator and DLQ replay preserve a serializable standalone recovery root", () => {
    expect(isScheduledMaintenanceMessage(run)).toBe(true);
    expect(prepareOrderQueueDeadLetter(run)).toMatchObject({ replayPolicy: "ALLOW", replayMessage: run });
    expect(structuredClone(run)).toEqual(run);
    expect(Object.keys(run).sort()).toEqual(["action", "cursor", "job", "runId", "scheduledAt", "threshold"]);
  });

  it("recovers a genuinely accepted application without any browser/user retry or payment ledger, once", async () => {
    const receipt = await acceptWithoutExecution();
    expect((await snapshot()).payments).toHaveLength(0);
    await f.db.update(storePink).set({ stopTime: new Date(0), status: 3 });
    expect(await recover()).toMatchObject({ checked: 1, completed: 1, errors: 0, pending: 0 });
    const after = await snapshot(); expect(after.users[0].nowMoney).toBe("6.25");
    expect(after.refunds).toHaveLength(1); expect(after.refunds[0]).toMatchObject({ id: receipt.id, refundType: 6 });
    expect(after.bills.filter(r => r.type === "pay_product_refund")).toHaveLength(1);
    expect(await recover()).toMatchObject({ checked: 0, completed: 0 }); expect(await snapshot()).toEqual(after);
  });

  it("retries rolled-back balance compensation on the next root after the data fault is repaired", async () => {
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ sku: { id: 999 }, activitySku: { id: 2 } }) });
    await expect(cancel()).rejects.toThrow(); await age(); const before = await snapshot();
    expect(await recover()).toMatchObject({ checked: 1, errors: 1 }); expect(await snapshot()).toEqual(before);
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ sku: { id: 1 }, activitySku: { id: 2 } }) });
    expect(await recover()).toMatchObject({ completed: 1, errors: 0 });
    expect((await snapshot()).refunds).toHaveLength(1);
  });

  it("creates the first provider request only for an existing accepted cancellation and later queries the same number", async () => {
    await f.db.update(storeOrder).set({ payType: "weixin" }); const accepted = await acceptWithoutExecution();
    const request = vi.spyOn(WechatPayService.prototype, "requestRefund").mockResolvedValue({ status: "PROCESSING" });
    const query = vi.spyOn(WechatPayService.prototype, "queryRefund").mockResolvedValue({ status: "SUCCESS" });
    expect(await recover()).toMatchObject({ checked: 1, pending: 1, completed: 0 });
    expect(request).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled();
    expect(await recover()).toMatchObject({ completed: 1 }); expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toEqual(request.mock.calls[0][0]);
    expect(query.mock.calls[0][0].outRefundNo).toBe(`CNSR${accepted.id}`);
    const after = await snapshot(); await recover(); expect(await snapshot()).toEqual(after);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("finalizes persisted provider SUCCESS without re-requesting or querying the channel", async () => {
    await f.db.update(storeOrder).set({ payType: "weixin" }); await acceptWithoutExecution();
    vi.spyOn(WechatPayService.prototype, "requestRefund").mockResolvedValue({ status: "PROCESSING" });
    await recover(); await f.db.update(storeOrderRefundPayment).set({ providerStatus: "SUCCESS" });
    const query = vi.spyOn(WechatPayService.prototype, "queryRefund");
    expect(await recover()).toMatchObject({ completed: 1 }); expect(query).not.toHaveBeenCalled();
    expect(WechatPayService.prototype.requestRefund).toHaveBeenCalledTimes(1);
  });

  it("unknown transport preserves the application for a later background-only recovery", async () => {
    await f.db.update(storeOrder).set({ payType: "weixin" }); await acceptWithoutExecution();
    const request = vi.spyOn(WechatPayService.prototype, "requestRefund").mockRejectedValue(new Error("isolated uncertain transport"));
    expect(await recover()).toMatchObject({ errors: 1 });
    expect((await f.db.select().from(storeOrderRefundPayment))[0].providerStatus).toBe("UNKNOWN");
    const query = vi.spyOn(WechatPayService.prototype, "queryRefund").mockResolvedValue({ status: "SUCCESS" });
    expect(await recover()).toMatchObject({ completed: 1 }); expect(request).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(["CLOSED", "ABNORMAL", "FAILED"])("does not automatically re-open terminal provider %s", async providerStatus => {
    await f.db.update(storeOrder).set({ payType: "weixin" }); const receipt = await acceptWithoutExecution();
    await f.db.insert(storeOrderRefundPayment).values({ refundId: receipt.id, storeOrderId: 500, provider: "wechat", outRefundNo: `CNSR${receipt.id}`,
      requestAmount: 625, totalAmount: 625, providerStatus });
    const before = await snapshot(); expect(await recover()).toMatchObject({ attention: 1, completed: 0 }); expect(await snapshot()).toEqual(before);
  });

  it("active REQUESTING lease cannot send another request", async () => {
    await f.db.update(storeOrder).set({ payType: "weixin" }); const receipt = await acceptWithoutExecution();
    await f.db.insert(storeOrderRefundPayment).values({ refundId: receipt.id, storeOrderId: 500, provider: "wechat", outRefundNo: `CNSR${receipt.id}`,
      requestAmount: 625, totalAmount: 625, providerStatus: "REQUESTING", requestTime: Math.floor(Date.now()/1000) });
    const before = await snapshot(); expect(await recover()).toMatchObject({ pending: 1, completed: 0 }); expect(await snapshot()).toEqual(before);
  });

  it.each(["CREATED", "REQUESTING"])("recovers stranded %s with the same immutable provider number", async providerStatus => {
    await f.db.update(storeOrder).set({ payType: "weixin" }); const receipt = await acceptWithoutExecution();
    await f.db.insert(storeOrderRefundPayment).values({ refundId: receipt.id, storeOrderId: 500, provider: "wechat", outRefundNo: `CNSR${receipt.id}`,
      requestAmount: 625, totalAmount: 625, providerStatus, requestTime: 1 });
    const request = vi.spyOn(WechatPayService.prototype, "requestRefund").mockResolvedValue({ status: "SUCCESS" });
    const query = vi.spyOn(WechatPayService.prototype, "queryRefund").mockResolvedValue({ status: "NOT_FOUND" });
    expect(await recover()).toMatchObject({ completed: 1, errors: 0 });
    expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0][0].outRefundNo).toBe(`CNSR${receipt.id}`);
    expect(query).toHaveBeenCalledTimes(providerStatus === "REQUESTING" ? 1 : 0);
    if (providerStatus === "REQUESTING") expect(query.mock.calls[0][0]).toEqual(request.mock.calls[0][0]);
  });

  it("a newly accepted application is left to the initiating HTTP request for sixty seconds", async () => {
    await acceptWithoutExecution(); await f.db.update(storeOrderRefund).set({ addTime: Math.floor(run.scheduledAt/1000) });
    const before = await snapshot(); expect(await recover()).toMatchObject({ checked: 0 }); expect(await snapshot()).toEqual(before);
    await age(); expect(await recover()).toMatchObject({ completed: 1 });
  });

  it.each([{ isCancel: 1 }, { isDel: 1 }, { refundType: 3 }, { refundReason: "ordinary customer after-sales" }, { applyType: 2 }, { orderId: "ordinary-refund" }])(
    "never auto-approves excluded or ordinary after-sales %j", async patch => {
      await acceptWithoutExecution(); await f.db.update(storeOrderRefund).set(patch);
      const before = await snapshot(); expect(await recover()).toMatchObject({ checked: 0 }); expect(await snapshot()).toEqual(before);
    });

  it.each([{ uid: 22 }, { refundPrice: "1.00" }, { refundNum: 2 }, { orderId: "pink_cancel_401_500" }])(
    "holds inconsistent original application for attention without compensation %j", async patch => {
      await acceptWithoutExecution(); await f.db.update(storeOrderRefund).set(patch);
      const before = await snapshot(); const result = await recover();
      expect(Number(result.attention) + Number(result.errors)).toBe(1); expect(result.completed).toBe(0); expect(await snapshot()).toEqual(before);
    });

  it("duplicate dedicated applications fail closed", async () => {
    const receipt = await acceptWithoutExecution(); await f.db.insert(storeOrderRefund).values({ ...receipt, id: receipt.id + 1 });
    const before = await snapshot(); expect(await recover()).toMatchObject({ checked: 2, attention: 2 }); expect(await snapshot()).toEqual(before);
  });

  it("deletion between receipt read and execution cannot create a replacement application", async () => {
    const receipt = await acceptWithoutExecution();
    const read = PinkCancellationStatusService.prototype.read;
    vi.spyOn(PinkCancellationStatusService.prototype, "read").mockImplementationOnce(async function(this: PinkCancellationStatusService, uid, id, cid) {
      const result = await read.call(this, uid, id, cid); await f.db.delete(storeOrderRefund).where(eq(storeOrderRefund.id, receipt.id)); return result;
    });
    const apply = vi.spyOn(StoreOrderRefundService.prototype, "applyRefund");
    expect(await recover()).toMatchObject({ errors: 1, completed: 0 }); expect(apply).not.toHaveBeenCalled();
    const after = await snapshot(); expect(after.refunds).toHaveLength(0); expect(after.users[0].nowMoney).toBe("0.00");
  });

  it.each([{ refundReason: "changed to ordinary after-sales" }, { refundNum: 2 }, { isCancel: 1 }])(
    "rechecks the same application under the core lock after readback: %j", async patch => {
      const receipt = await acceptWithoutExecution(); const read = PinkCancellationStatusService.prototype.read;
      vi.spyOn(PinkCancellationStatusService.prototype, "read").mockImplementationOnce(async function(this: PinkCancellationStatusService, uid, id, cid) {
        const result = await read.call(this, uid, id, cid); await f.db.update(storeOrderRefund).set(patch).where(eq(storeOrderRefund.id, receipt.id)); return result;
      });
      expect(await recover()).toMatchObject({ errors: 1, completed: 0 });
      const after = await snapshot(); expect(after.users[0].nowMoney).toBe("0.00"); expect(after.payments).toHaveLength(0);
      expect(after.refunds).toHaveLength(1); expect(after.orders[0].refundStatus).toBe(0);
    });

  it("poison rows do not starve later IDs; the continuation keeps a frozen high-water and survives send failure", async () => {
    const real = await acceptWithoutExecution(); await f.db.update(storeOrderRefund).set({ id: 10 }).where(eq(storeOrderRefund.id, real.id));
    await f.db.insert(storeOrderRefund).values(Array.from({ length: 5 }, (_, i) => ({ ...real, id: i + 1, storeOrderId: 900 + i, orderId: `pink_cancel_900_${900+i}` })));
    send.mockRejectedValueOnce(new Error("Queue unavailable")); await expect(recover()).rejects.toThrow("Queue unavailable");
    const page = await recover(); expect(page).toMatchObject({ checked: 5, attention: 5, nextCursor: 5, highWater: 10, hasMore: true });
    const continuation = send.mock.calls.at(-1)![0] as ScheduledMaintenanceMessage;
    expect(continuation).toEqual({ ...run, cursor: 5, threshold: 10 });
    await f.db.insert(storeOrderRefund).values({ ...real, id: 11, storeOrderId: 999, orderId: "pink_cancel_999_999" });
    expect(await new ScheduledMaintenanceService(f.container, f.env).processMaintenance(continuation)).toMatchObject({ checked: 1, completed: 1, highWater: 10 });
    expect(await recover()).toMatchObject({ checked: 5, attention: 5, highWater: 11 });
    const next = send.mock.calls.at(-1)![0] as ScheduledMaintenanceMessage;
    expect(await new ScheduledMaintenanceService(f.container, f.env).processMaintenance(next)).toMatchObject({ checked: 1, attention: 1 });
  });

  it("replays an empty recent window after send failure, then refunds the genuinely accepted tail application once", async () => {
    const real = await acceptWithoutExecution();
    await f.db.update(storeOrderRefund).set({ id: 2001 }).where(eq(storeOrderRefund.id, real.id));
    await f.db.execute(sql`INSERT INTO store_order_refund
      (id, store_order_id, order_id, apply_type, refund_reason, refund_explain, add_time)
      SELECT n, n+10000, 'pink_cancel_recent_' || n, 1, '用户手动取消拼团', '用户手动取消未成团的拼团订单',
        ${Math.floor(run.scheduledAt / 1000)} FROM generate_series(1, 1000) n`);
    const before = await snapshot();
    send.mockRejectedValueOnce(new Error("Queue unavailable after empty window"));
    await expect(recover()).rejects.toThrow("Queue unavailable");
    expect(await snapshot()).toEqual(before);
    expect(await recover()).toMatchObject({ checked: 0, examined: 1000, nextCursor: 1000, highWater: 2001, hasMore: true });
    expect(await snapshot()).toEqual(before);
    const continuation: ScheduledMaintenanceMessage = { ...run, cursor: 1000, threshold: 2001 };
    expect(send.mock.calls.at(-1)![0]).toEqual(continuation);
    const service = new ScheduledMaintenanceService(f.container, f.env);
    expect(await service.processMaintenance(continuation)).toMatchObject({ checked: 1, completed: 1, errors: 0, hasMore: false });
    const after = await snapshot();
    expect(after.users[0].nowMoney).toBe("6.25");
    expect(after.bills.filter(row => row.type === "pay_product_refund")).toHaveLength(1);
    expect(after.refunds.find(row => row.id === 2001)?.refundType).toBe(6);
    expect(after.refunds.filter(row => row.id <= 1000).every(row => row.refundType === 0)).toBe(true);
    expect(await service.processMaintenance(continuation)).toMatchObject({ checked: 0 });
    expect(await snapshot()).toEqual(after);
  }, 20000);

  it("rejects invalid pagination before any execution and emits no private identifiers in recovery logs", async () => {
    const service = new PinkCancellationRecoveryService(f.container, f.env);
    for (const args of [[-1, run.scheduledAt, null], [0, 0, null], [0, run.scheduledAt, -1], [NaN, run.scheduledAt, null]] as const)
      await expect(service.recoverPage(args[0], args[1], args[2])).rejects.toThrow();
    await acceptWithoutExecution(); await f.db.update(user).set({ status: 0 }); await recover();
    const logs = [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls];
    expect(logs.length).toBeGreaterThan(0);
    const encoded = JSON.stringify(logs); expect(encoded).not.toMatch(/isolated-paid-leader|pink_cancel_400_500|token|uid|refundId|orderId/);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("overlapping background and HTTP recovery serialize on real independent PG16 backends", async () => {
    await acceptWithoutExecution();
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR UPDATE');
      const a = outcome(new PinkCancellationRecoveryService(createContainerFromDb(first.db), f.env).recoverPage(0, run.scheduledAt, null));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(new ActivityJoinService(createContainerFromDb(second.db), f.env).removePink(11, 400, 30));
      await waitForFinanceBlock(f.db, second.pid, first.pid); await blocker.exec("COMMIT");
      expect(await a).toMatchObject({ ok: true, value: { completed: 1, errors: 0 } });
      expect(await b).toMatchObject({ ok: true, value: { completed: true } });
    });
    const after = await snapshot(); expect(after.users[0].nowMoney).toBe("6.25");
    expect(after.bills.filter(r => r.type === "pay_product_refund")).toHaveLength(1); expect(after.refunds).toHaveLength(1);
  }, 15_000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("overlapping workers do not duplicate a live provider request or retain SQL locks over network I/O", async () => {
    await f.db.update(storeOrder).set({ payType: "weixin" }); await acceptWithoutExecution();
    await withFinancePeers(f.db, async ([probe, first, second]) => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const request = vi.spyOn(WechatPayService.prototype, "requestRefund").mockImplementation(async () => { await gate; return { status: "SUCCESS" }; });
      const a = outcome(new PinkCancellationRecoveryService(createContainerFromDb(first.db), f.env).recoverPage(0, run.scheduledAt, null));
      try {
        await vi.waitUntil(() => request.mock.calls.length === 1, { timeout: 4000 });
        await probe.exec('BEGIN; SELECT id FROM store_order_refund FOR UPDATE NOWAIT; SELECT id FROM store_order WHERE id=500 FOR UPDATE NOWAIT; SELECT id FROM store_pink WHERE id=400 FOR UPDATE NOWAIT; SELECT uid FROM "user" WHERE uid=11 FOR UPDATE NOWAIT; COMMIT');
        const b = await new PinkCancellationRecoveryService(createContainerFromDb(second.db), f.env).recoverPage(0, run.scheduledAt, null);
        expect(b).toMatchObject({ pending: 1, completed: 0, errors: 0 }); expect(request).toHaveBeenCalledTimes(1);
      } finally { release(); }
      expect(await a).toMatchObject({ ok: true, value: { completed: 1, errors: 0 } });
    });
    expect((await snapshot()).refunds[0].refundType).toBe(6);
  }, 15_000);
});
