import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createBargainSelectionFixture } from "./helpers/bargainSelectionFixture";
import { withFinancePeers, waitForFinanceBlock, waitForFinanceClock, outcome } from "./helpers/financePeers";
import { createContainerFromDb } from "../src/lib/di";
import { ActivityJoinService } from "../src/services/activity/ActivityJoinService";
import { storeBargain, storeBargainUser } from "../src/models/schema";

// PGlite is not a substitute for independent PostgreSQL backends. The shared
// helper rejects all but the dedicated loopback finance_test PG16 service and
// proves peer identity/schema/version and distinct, non-reconnected PIDs.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("bargain independent PostgreSQL 16 admission", () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => { f = await createBargainSelectionFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); });

  it("two simultaneous starts create exactly one participation and return its same ID", async () => {
    await f.db.update(storeBargainUser).set({ status: 4 }).where(eq(storeBargainUser.id, 80));
    const before = await f.snapshot();
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('bargain-start:11:40',0))");
      const a = outcome(new ActivityJoinService(createContainerFromDb(first.db)).startBargain(11, 40));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(new ActivityJoinService(createContainerFromDb(second.db)).startBargain(11, 40));
      await waitForFinanceBlock(f.db, second.pid, blocker.pid);
      await blocker.exec("COMMIT");
      const results = await Promise.all([a, b]);
      expect(results[0]).toMatchObject({ ok: true }); expect(results[1]).toEqual(results[0]);
    });
    const after = await f.snapshot();
    expect(after.participations).toHaveLength(before.participations.length + 1);
    expect(after.participations.filter(row => row.uid === 11 && [1, 3].includes(row.status))).toHaveLength(1);
    expect({ ...after, participations: before.participations, sequences: before.sequences }).toEqual(before);
  }, 15_000);

  it("start waiting behind the final actual help reuses the newly completed record", async () => {
    await f.db.update(storeBargain).set({ people: 1 });
    await f.db.update(storeBargainUser).set({ status: 1, price: "0.00" }).where(eq(storeBargainUser.id, 80));
    await withFinancePeers(f.db, async ([blocker, helper, starter]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_bargain_user WHERE id=80 FOR UPDATE");
      const helped = outcome(new ActivityJoinService(createContainerFromDb(helper.db)).helpBargain(11, 80));
      await waitForFinanceBlock(f.db, helper.pid, blocker.pid);
      const started = outcome(new ActivityJoinService(createContainerFromDb(starter.db)).startBargain(11, 40));
      await waitForFinanceBlock(f.db, starter.pid, helper.pid);
      await blocker.exec("COMMIT");
      expect(await helped).toEqual({ ok: true, value: { price: "8.00" } });
      expect(await started).toEqual({ ok: true, value: { id: 80 } });
    });
    const after = await f.snapshot();
    expect(after.participations).toHaveLength(4);
    expect(after.participations.find(row => row.id === 80)).toMatchObject({ status: 3, price: "8.00" });
    expect(after.helps).toHaveLength(1); expect(after.helps[0]).toMatchObject({ bargainUserId: 80, uid: 11, price: "8.00" });
    expect(after.orders).toEqual([]); expect(after.carts).toEqual([]);
  }, 15_000);

  it("does not reuse a row consumed while start was waiting for its row lock", async () => {
    await withFinancePeers(f.db, async ([blocker, starter]) => {
      await blocker.exec("BEGIN; UPDATE store_bargain_user SET status=4 WHERE id=80");
      const pending = outcome(new ActivityJoinService(createContainerFromDb(starter.db)).startBargain(11, 40));
      await waitForFinanceBlock(f.db, starter.pid, blocker.pid);
      await blocker.exec("COMMIT");
      const result = await pending; expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw result.error;
      expect(result.value.id).not.toBe(80);
    });
    const after = await f.snapshot();
    expect(after.participations.find(row => row.id === 80)?.status).toBe(4);
    expect(after.participations.filter(row => row.uid === 11 && [1, 3].includes(row.status))).toHaveLength(1);
  }, 15_000);

  it.each(["advisory", "participant"])("uses wall-clock admission after an observed %s wait, not transaction-start NOW", async target => {
    await withFinancePeers(f.db, async ([blocker, starter]) => {
      const stop = Date.now() + 1000;
      await f.db.update(storeBargain).set({ stopTime: new Date(stop) });
      const before = await f.snapshot();
      await blocker.exec(target === "advisory"
        ? "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('bargain-start:11:40',0))"
        : "BEGIN; SELECT id FROM store_bargain_user WHERE id=80 FOR UPDATE");
      const pending = outcome(new ActivityJoinService(createContainerFromDb(starter.db)).startBargain(11, 40));
      await waitForFinanceBlock(f.db, starter.pid, blocker.pid);
      const [timing] = await f.db.select({ beganBefore: sql<boolean>`extract(epoch from xact_start)*1000 < ${stop}` })
        .from(sql`pg_stat_activity`).where(sql`pid=${starter.pid}`);
      expect(timing.beganBefore).toBe(true);
      await waitForFinanceClock(f.db, stop);
      await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringContaining("不存在") } });
      expect(await f.snapshot()).toEqual(before);
    });
  }, 15_000);

  it("keeps a stricter caller lock timeout, rolls back and can retry after release", async () => {
    const before = await f.snapshot();
    await withFinancePeers(f.db, async ([blocker, starter]) => {
      await starter.exec("SET lock_timeout='500ms'");
      const settings = await starter.exec("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS deadline");
      await blocker.exec("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('bargain-start:11:40',0))");
      const pending = outcome(new ActivityJoinService(createContainerFromDb(starter.db)).startBargain(11, 40));
      await waitForFinanceBlock(f.db, starter.pid, blocker.pid);
      const result = await pending; expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected lock timeout");
      let cause: unknown = result.error;
      while (cause && typeof cause === "object" && "cause" in cause && cause.cause) cause = cause.cause;
      expect(cause).toMatchObject({ code: "55P03" });
      expect(await starter.exec("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS deadline")).toEqual(settings);
      await blocker.exec("COMMIT");
      expect(await new ActivityJoinService(createContainerFromDb(starter.db)).startBargain(11, 40)).toEqual({ id: 80 });
    });
    expect(await f.snapshot()).toEqual(before);
  }, 15_000);

  it("keeps the activity admission rule locked while waiting for the participant", async () => {
    await withFinancePeers(f.db, async ([blocker, starter, editor]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_bargain_user WHERE id=80 FOR UPDATE");
      const pending = outcome(new ActivityJoinService(createContainerFromDb(starter.db)).startBargain(11, 40));
      await waitForFinanceBlock(f.db, starter.pid, blocker.pid);
      const stopped = outcome(editor.db.update(storeBargain).set({ status: 0 }).where(eq(storeBargain.id, 40)));
      await waitForFinanceBlock(f.db, editor.pid, starter.pid);
      await blocker.exec("COMMIT");
      expect(await pending).toEqual({ ok: true, value: { id: 80 } });
      expect(await stopped).toMatchObject({ ok: true });
      await expect(new ActivityJoinService(createContainerFromDb(starter.db)).startBargain(11, 40)).rejects.toThrow(/不存在/);
    });
  }, 15_000);
});
