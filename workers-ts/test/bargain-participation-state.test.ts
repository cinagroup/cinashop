import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createBargainSelectionFixture } from "./helpers/bargainSelectionFixture";
import { ActivityJoinService } from "../src/services/activity/ActivityJoinService";
import { BargainSkuCatalogService } from "../src/services/activity/BargainSkuCatalogService";
import { isBargainParticipationReady } from "../src/services/activity/BargainParticipationState";
import { StoreCartService } from "../src/services/order/StoreCartService";
import { storeBargain, storeBargainUser } from "../src/models/schema";

describe("bargain participation state consistency on isolated SQL", () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => { f = await createBargainSelectionFixture(); }, 30_000);
  afterEach(async () => { vi.useRealTimers(); await f?.close(); });
  const join = () => new ActivityJoinService(f.container);
  const cart = () => new StoreCartService(f.container, f.env);
  const add = () => cart().add({ uid: 11, productId: 70, activityId: 40, type: 2, unique: "actred40", cartNum: 1, isNew: 1 });
  const own = async () => (await join().myBargains(11)).find(row => row.id === 80)!;

  it("runs actual start/list controllers with owner scope, no-store and unchanged legacy field names", async () => {
    const before = await f.snapshot();
    for (const body of [{ bargain_id: 40 }, { bargainId: 40, uid: 22 }]) {
      const response = await f.app.request("/api/bargain/start", { method: "POST",
        headers: { "x-fixture-user": "11", "Content-Type": "application/json" }, body: JSON.stringify(body) }, f.env);
      expect(await response.json()).toMatchObject({ status: 200, data: { id: 80 } });
    }
    const response = await f.app.request("/api/bargain/user/list?uid=22", { headers: { "x-fixture-user": "11" } }, f.env);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const wire = await response.json() as { data: Array<{ id: number; bargain_id: number; residue_price: string; pay_status: boolean }> };
    expect(wire.data.map(row => row.id)).toEqual([83, 82, 80]);
    expect(wire.data[2]).toMatchObject({ id: 80, bargain_id: 40, residue_price: "2.00", pay_status: true });
    expect(wire.data[0].pay_status).toBe(false);
    const anonymous = await f.app.request("/api/bargain/user/list?uid=11", {}, f.env);
    expect(await anonymous.json()).not.toMatchObject({ status: 200 });
    expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
    expect(await f.snapshot()).toEqual(before);
  });

  it.each([1, 3])("reuses the sole live state %s without changing rows or advancing sequences", async status => {
    await f.db.update(storeBargainUser).set({ status }).where(eq(storeBargainUser.id, 80));
    const before = await f.snapshot();
    for (let i = 0; i < 3; i++) expect(await join().startBargain(11, 40)).toEqual({ id: 80 });
    expect(await f.snapshot()).toEqual(before);
  });
  it("creates one new participation after only closed/used rows and reuses it on retry", async () => {
    await f.db.update(storeBargainUser).set({ status: 4 }).where(eq(storeBargainUser.id, 80));
    const before = await f.snapshot(), created = await join().startBargain(11, 40);
    expect(created.id).not.toBe(80); expect(await join().startBargain(11, 40)).toEqual(created);
    const after = await f.snapshot();
    expect(after.participations).toHaveLength(before.participations.length + 1);
    expect(after.participations.find(row => row.id === created.id)).toMatchObject({ uid: 11, bargainId: 40, status: 1,
      bargainPrice: "10.00", bargainPriceMin: "2.00", price: "0.00", isDel: 0 });
    expect(after.participations.filter(row => row.id !== created.id)).toEqual(before.participations);
    expect({ ...after, participations: before.participations, sequences: before.sequences }).toEqual(before);
  });
  it("rejects implicit duplicates while preserving an existing binding and exact paginated selection", async () => {
    const added = await add();
    await f.db.update(storeBargainUser).set({ status: 3, price: "8.00" }).where(eq(storeBargainUser.id, 82));
    const before = await f.snapshot();
    await expect(join().startBargain(11, 40)).rejects.toThrow(/不唯一/);
    expect(await new BargainSkuCatalogService(f.container).read(11, "40", "80")).toMatchObject({ can_select: true, participation: { id: 80 } });
    await expect(add()).rejects.toThrow(/不唯一/);
    expect(await cart().list(11, { mode: "buy", ids: [added.id] })).toMatchObject([{ id: added.id, bargainUserId: 80, isValid: true }]);
    expect(await cart().list(11)).toMatchObject([{ id: added.id, isValid: true }]);
    expect((await join().myBargains(11, 3, 1))[0]).toMatchObject({ id: 80, pay_status: true });
    expect(await f.snapshot()).toEqual(before);
  });
  it.each([
    [1, "1.00", false], [1, "8.00", true], [3, "8.00", true],
    [2, "8.00", false], [4, "8.00", false], [3, "1.00", false], [1, "9.00", false], [1, "-1.00", false],
  ] as const)("agrees on readiness for state %s / cut %s", async (status, price, ready) => {
    await f.db.update(storeBargainUser).set({ status, price }).where(eq(storeBargainUser.id, 80));
    const before = await f.snapshot();
    if (price.startsWith("-")) await expect(own()).rejects.toThrow(/金额/);
    else expect((await own()).pay_status).toBe(ready);
    if (ready) {
      expect((await new BargainSkuCatalogService(f.container).read(11, "40", "80")).can_select).toBe(true);
      expect(await add()).toHaveProperty("id");
    } else {
      await expect(add()).rejects.toThrow();
      expect(await f.snapshot()).toEqual(before);
    }
  });
  it.each([{ status: 0 }, { isDel: 1 }, { startTime: new Date("2099-01-01") }, { stopTime: new Date("2000-01-01") }])(
    "does not offer purchase or start for unavailable activity %j", async change => {
      await f.db.update(storeBargain).set(change).where(eq(storeBargain.id, 40));
      const before = await f.snapshot();
      expect((await own()).pay_status).toBe(false);
      await expect(join().startBargain(11, 40)).rejects.toThrow(/不存在/);
      await expect(add()).rejects.toThrow();
      expect(await f.snapshot()).toEqual(before);
    },
  );
  it("marks expired live rows closed for display, preserves consumed state and never writes expiry", async () => {
    await f.db.update(storeBargain).set({ stopTime: new Date("2000-01-01") });
    const before = await f.snapshot(), listed = await join().myBargains(11);
    expect(listed.find(row => row.id === 80)).toMatchObject({ status: 2, pay_status: false });
    expect(listed.find(row => row.id === 83)).toMatchObject({ status: 4, pay_status: false });
    expect(await f.snapshot()).toEqual(before);
  });
  it("does not reinterpret UTC activity timestamps in a non-UTC database session", async () => {
    for (const zone of ["UTC", "Asia/Shanghai", "America/New_York"]) {
      await f.db.execute(sql`SELECT set_config('TimeZone', ${zone}, false)`);
      expect(await join().startBargain(11, 40)).toEqual({ id: 80 });
      expect((await own()).pay_status).toBe(true);
    }
  });
  it("keeps both timestamp endpoints inclusive without exposing internal selection columns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const time of [f.startTime, f.stopTime]) {
      vi.setSystemTime(time); expect((await own()).pay_status).toBe(true);
    }
    vi.setSystemTime(new Date(f.stopTime.getTime() + 1)); expect((await own()).pay_status).toBe(false);
    expect(await own()).not.toHaveProperty("liveCount"); expect(await own()).not.toHaveProperty("activityStatus");
  });
  it("scopes list and restart to the actual owner and ignores soft-deleted duplicates", async () => {
    await f.db.update(storeBargainUser).set({ status: 3, price: "8.00", isDel: 1 }).where(eq(storeBargainUser.id, 82));
    const before = await f.snapshot();
    expect(await join().startBargain(22, 40)).toEqual({ id: 81 });
    expect(await join().startBargain(11, 40)).toEqual({ id: 80 });
    expect((await own()).pay_status).toBe(true);
    expect((await join().myBargains(22)).map(row => row.id)).toEqual([81]);
    expect(await f.snapshot()).toEqual(before);
  });
  it("retains cancellation rules: owner can cancel cutting only, not ready/used/foreign records", async () => {
    const before = await f.snapshot();
    for (const id of [80, 81, 83]) await expect(join().cancelBargain(11, { id })).rejects.toThrow(/状态/);
    expect(await f.snapshot()).toEqual(before);
    await f.setReady(false); await join().cancelBargain(11, { id: 80 });
    expect((await f.snapshot()).participations.find(row => row.id === 80)).toMatchObject({ status: 2, isDel: 1 });
    await expect(join().cancelBargain(11, { id: 80 })).rejects.toThrow(/状态/);
  });
  it("restores local transaction settings on successful reuse and duplicate rejection", async () => {
    const settings = () => f.db.select({ isolation: sql<string>`current_setting('transaction_isolation')`,
      deadline: sql<string>`current_setting('statement_timeout')`, idle: sql<string>`current_setting('idle_in_transaction_session_timeout')`,
      lock: sql<string>`current_setting('lock_timeout')` }).from(sql`(values (1)) as probe(n)`);
    const before = await settings(); await join().startBargain(11, 40); expect(await settings()).toEqual(before);
    await f.db.update(storeBargainUser).set({ status: 1 }).where(eq(storeBargainUser.id, 82));
    await expect(join().startBargain(11, 40)).rejects.toThrow(/不唯一/); expect(await settings()).toEqual(before);
  });
});

describe("strict participation readiness", () => {
  it("rejects malformed money and unknown states without treating them as zero", () => {
    const ready = { status: 3, bargainPrice: "10.00", bargainPriceMin: "2.00", price: "8.00" };
    for (const patch of [{ status: 0 }, { status: 4 }, { bargainPrice: "bad" }, { bargainPriceMin: "11.00" },
      { price: "8" }, { price: "8e0" }, { price: "8.001" }, { price: "-1.00" }, { bargainPrice: "10000000000.00" }]) {
      expect(isBargainParticipationReady({ ...ready, ...patch })).toBe(false);
    }
    expect(isBargainParticipationReady({ status: 1, bargainPrice: "0.00", bargainPriceMin: "0.00", price: "0.00" })).toBe(true);
  });
});
