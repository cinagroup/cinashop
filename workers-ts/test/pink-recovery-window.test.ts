import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createContainerFromDb } from "../src/lib/di";
import { storeOrder, storeOrderRefund } from "../src/models/schema";
import { pinkCancellationRecoverySnapshot, PINK_CANCELLATION_RECOVERY_SCAN_SIZE } from "../src/services/activity/PinkCancellationRecoveryService";
import { financePostgres } from "./helpers/financePostgres";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";

describe("bounded recovery windows preserve due-row coverage", () => {
  let f: Awaited<ReturnType<typeof financePostgres>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });
  async function fixture(count: number) {
    f = await financePostgres([storeOrder, storeOrderRefund]);
    await f.db.execute(sql`INSERT INTO store_order_refund(id, store_order_id, order_id, apply_type, refund_reason, refund_explain, add_time)
      SELECT n, n, 'pink_cancel_' || n || '_' || n, 1, '用户手动取消拼团', '用户手动取消未成团的拼团订单', 2000
      FROM generate_series(1, ${count}::int) n`);
    return { ...f, container: createContainerFromDb(f.db) };
  }
  it("advances empty recent windows to reach older due rows, without changing the run cutoff", async () => {
    const { db, container } = await fixture(2507);
    await db.execute(sql`UPDATE store_order_refund SET add_time=0 WHERE id > 2500`);
    const allBefore = await db.select().from(storeOrderRefund);
    const first = await pinkCancellationRecoverySnapshot(container, 0, 1060000, null);
    expect(first).toMatchObject({ candidates: [], examined: 1000, nextCursor: 1000, highWater: 2507, hasMore: true });
    const second = await pinkCancellationRecoverySnapshot(container, first.nextCursor, 1060000, first.highWater);
    expect(second).toMatchObject({ candidates: [], examined: 1000, nextCursor: 2000, highWater: 2507, hasMore: true });
    const third = await pinkCancellationRecoverySnapshot(container, second.nextCursor, 1060000, first.highWater);
    expect(third.candidates.map(row => row.id)).toEqual([2501, 2502, 2503, 2504, 2505]);
    expect(third).toMatchObject({ examined: 507, nextCursor: 2505, hasMore: true });
    const last = await pinkCancellationRecoverySnapshot(container, third.nextCursor, 1060000, first.highWater);
    expect(last.candidates.map(row => row.id)).toEqual([2506, 2507]);
    expect(last).toMatchObject({ examined: 2, nextCursor: 2507, hasMore: false });
    expect(await db.select().from(storeOrderRefund)).toEqual(allBefore);
    // Previously recent rows are revisited by a new root with a later cutoff.
    const nextRun = await pinkCancellationRecoverySnapshot(container, 0, 3060000, null);
    expect(nextRun.candidates.map(row => row.id)).toEqual([1, 2, 3, 4, 5]);
  }, 20000);

  it("does not skip the sixth due row even when most of the look-ahead window is recent", async () => {
    const { db, container } = await fixture(2002);
    const expected = [1, 200, 400, 600, 800, 1000, 1001, 1500, 2002];
    await db.execute(sql`UPDATE store_order_refund SET add_time=0 WHERE id IN (1,200,400,600,800,1000,1001,1500,2002)`);
    const seen: number[] = [];
    let cursor = 0, ceiling: number | null = null, pages = 0;
    while (true) {
      if (++pages > 10) throw new Error("Traversal did not converge");
      const page = await pinkCancellationRecoverySnapshot(container, cursor, 1060000, ceiling);
      expect(page.examined).toBeLessThanOrEqual(PINK_CANCELLATION_RECOVERY_SCAN_SIZE);
      seen.push(...page.candidates.map(row => row.id));
      if (pages === 1) expect(page.nextCursor).toBe(800);
      if (!page.hasMore) break;
      expect(page.nextCursor).toBeGreaterThan(cursor);
      cursor = page.nextCursor; ceiling = page.highWater;
    }
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  }, 20000);

  it("freezes the global ceiling and skips large ID gaps without generating numeric-range pages", async () => {
    const { db, container } = await fixture(1);
    await db.execute(sql`UPDATE store_order_refund SET id=2000000000, add_time=0`);
    await db.insert(storeOrderRefund).values({ id: 2147483647, orderId: "ordinary" });
    const before = await pinkCancellationRecoverySnapshot(container, 0, 1060000, 2000000000);
    expect(before).toMatchObject({ examined: 1, nextCursor: 2000000000, highWater: 2000000000, hasMore: false });
    expect(before.candidates.map(row => row.id)).toEqual([2000000000]);
    await db.insert(storeOrderRefund).values({ id: 2000000001, orderId: "pink_cancel_later", applyType: 1,
      refundReason: "用户手动取消拼团", refundExplain: "用户手动取消未成团的拼团订单" });
    expect(await pinkCancellationRecoverySnapshot(container, before.nextCursor, 1060000, before.highWater))
      .toEqual({ candidates: [], examined: 0, nextCursor: 2000000000, highWater: 2000000000, hasMore: false });
    const fresh = await pinkCancellationRecoverySnapshot(container, before.nextCursor, 1060000, null);
    expect(fresh.candidates.map(row => row.id)).toEqual([2000000001]);
    expect(fresh.highWater).toBe(2147483647);
  }, 20000);

  it("converges at an exact full recent window, then returns an empty terminal page", async () => {
    const { container } = await fixture(1000);
    const first = await pinkCancellationRecoverySnapshot(container, 0, 1060000, null);
    expect(first).toMatchObject({ candidates: [], examined: 1000, nextCursor: 1000, hasMore: true });
    expect(await pinkCancellationRecoverySnapshot(container, first.nextCursor, 1060000, first.highWater))
      .toEqual({ candidates: [], examined: 0, nextCursor: 1000, highWater: 1000, hasMore: false });
  }, 20000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))(
    "PG16 keeps the window and due scan on one snapshot while eligibility changes between stages", async () => {
      const { db, container } = await fixture(2);
      await db.execute(sql`UPDATE store_order_refund SET refund_reason='ordinary' WHERE id=1`);
      await withFinancePeers(db, async ([blocker, reader, writer]) => {
        // Only the second-stage query references orders; the ID-only window
        // completes before this real lock barrier. No mocked SQL responses.
        await blocker.exec("BEGIN; LOCK TABLE store_order IN ACCESS EXCLUSIVE MODE");
        const pending = outcome(pinkCancellationRecoverySnapshot(createContainerFromDb(reader.db), 0, 1060000, 2));
        try {
          await waitForFinanceBlock(db, reader.pid, blocker.pid);
          await writer.db.execute(sql`UPDATE store_order_refund SET refund_reason='用户手动取消拼团', add_time=0 WHERE id=1`);
        } finally { await blocker.exec("ROLLBACK"); }
        expect(await pending).toMatchObject({ ok: true, value: {
          candidates: [], examined: 1, nextCursor: 2, highWater: 2, hasMore: false,
        } });
      });
      const nextRun = await pinkCancellationRecoverySnapshot(container, 0, 1060000, 2);
      expect(nextRun.candidates.map(row => row.id)).toEqual([1]);
      expect(nextRun.examined).toBe(2);
    }, 15000);
});
