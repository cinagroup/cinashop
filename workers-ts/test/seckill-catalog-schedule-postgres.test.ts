import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { financePostgres } from "./helpers/financePostgres";
import { storeActivity, storeSeckill, storeSeckillTime } from "../src/models/schema";
import { StoreSeckillDao, StoreSeckillTimeDao } from "../src/dao/activity/ActivityDaos";
import { ActivityService } from "../src/services/activity/ActivityService";
import { createContainerFromDb } from "../src/lib/di";
import { canBrowseSeckillSlot, loadSeckillSchedule } from "../src/services/activity/SeckillScheduleService";

const day = (date: string) => Date.parse(`${date}T00:00:00+08:00`) / 1000;
const time = (clock = "09:00:00", date = "2026-09-07") => new Date(`${date}T${clock}+08:00`);
describe("seckill catalogue SQL matches purchase schedule before pagination", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, dao: StoreSeckillDao;
  beforeAll(async () => { f = await financePostgres([storeActivity, storeSeckill, storeSeckillTime]); dao = new StoreSeckillDao(f.db); }, 30_000);
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(storeActivity).values({ id: 9, type: 1, status: 1, startDay: day("2026-09-07"), endDay: day("2026-09-08"), timeId: "4,8" });
    await f.db.insert(storeSeckill).values({ id: 20, productId: 70, activityId: 9, timeId: "4,8", storeName: "排期样本" });
    await f.db.insert(storeSeckillTime).values([{ id: 4, status: 1, startTime: "0800", endTime: "10:00" },
      { id: 8, status: 1, startTime: "18:00", endTime: "2000" }]);
  });
  async function compare(now = time()) {
    const snapshot = await loadSeckillSchedule(f.db, 20);
    for (const id of [4, 8]) {
      const rows = await dao.getByTimeId(String(id), 1, 10, now);
      expect(rows.map(row => row.id)).toEqual(canBrowseSeckillSlot(snapshot, id, now) ? [20] : []);
    }
  }
  function indexService() {
    const container = createContainerFromDb(f.db);
    // Banner configuration is unrelated; slot reads still execute the actual bounded DAO.
    container.systemConfigDao.getValues = async () => ({});
    return new ActivityService(container);
  }
  it("sorts mixed clock formats numerically, breaks ties by ID and uses exclusive session ends", async () => {
    await f.db.insert(storeSeckillTime).values([
      { id: 2, startTime: "0800", endTime: "1000", status: 1 },
      { id: 3, startTime: "09:00", endTime: "11:00", status: 1 },
      { id: 5, startTime: "0000", endTime: "2400", status: 0 },
    ]);
    const service = indexService();
    const before = await service.seckillTimes(time("07:59:59.999"));
    expect(before.seckillTime.map(slot => slot.id)).toEqual([2, 4, 3, 8]);
    expect(before.seckillTimeIndex).toBe(0);
    const result = await service.seckillTimes(time("10:00:00"));
    expect(result.seckillTime.map(slot => slot.status)).toEqual([0, 0, 1, 2]);
    expect(result.seckillTimeIndex).toBe(2);
    expect(result.seckillTime[0]).toMatchObject({ start_time: "08:00", end_time: "10:00", stop: time("10:00:00").getTime() / 1000 });
  });
  it("keeps malformed sessions disabled and projects 24:00 as next Shanghai midnight", async () => {
    await f.db.update(storeSeckillTime).set({ startTime: "broken" }).where(eq(storeSeckillTime.id, 4));
    await f.db.update(storeSeckillTime).set({ startTime: "1800", endTime: "2400" }).where(eq(storeSeckillTime.id, 8));
    const result = await indexService().seckillTimes(time("23:59:59.999"));
    expect(result.seckillTimeIndex).toBe(0);
    expect(result.seckillTime[0]).toMatchObject({ id: 8, end_time: "24:00", status: 1, stop: day("2026-09-08") });
    expect(result.seckillTime[1]).toMatchObject({ id: 4, start_time: "", state: "配置不可用", status: 0, stop: 0 });
    await f.db.delete(storeSeckillTime).where(eq(storeSeckillTime.id, 8));
    expect((await indexService().seckillTimes(time())).seckillTimeIndex).toBe(-1);
  });
  it("returns all 1000 enabled slots but explicitly refuses overflow instead of truncating the index", async () => {
    await f.db.delete(storeSeckillTime);
    await f.db.insert(storeSeckillTime).values(Array.from({ length: 1002 }, (_, i) => ({ id: i + 1,
      status: i < 1000 ? 1 : 0, startTime: "0800", endTime: "1000" })));
    expect((await indexService().seckillTimes(time())).seckillTime).toHaveLength(1000);
    await f.db.update(storeSeckillTime).set({ status: 1 });
    expect(await new StoreSeckillTimeDao(f.db).getAll()).toHaveLength(1001);
    await expect(indexService().seckillTimes(time())).rejects.toThrow("超过1000项");
  });
  it("lists today's upcoming and past sessions, without treating their visibility as permission to buy now", async () => {
    for (const clock of ["07:59:59", "08:00:00", "10:00:00", "19:00:00", "20:00:00"]) {
      await compare(time(clock));
      expect((await dao.getByTimeId("8", 1, 10, time(clock))).map(row => row.id)).toEqual([20]);
    }
  });
  it.each([
    { status: 0 }, { isDel: 1 }, { type: 2 }, { timeId: "8" }, { timeId: "12" }, { timeId: null },
    { startDay: 0 }, { endDay: day("2026-09-06") }, { endDay: day("2026-09-08") + 1 },
    { startDay: day("2026-09-08") },
  ])("matches pure policy for parent mutation %j", async change => {
    await f.db.update(storeActivity).set(change); await compare();
  });
  it.each([
    { status: 0 }, { isShow: 0 }, { isDel: 1 }, { activityId: 99 }, { activityId: 0 },
    { startTime: time("12:00:00") }, { stopTime: time("08:30:00") },
    { startTime: time("09:00:00"), stopTime: time("00:00:00") },
    { timeId: "8" }, { timeId: " 4,\t8\u00a0" }, { timeId: "\ufeff4\u3000,8" },
    { timeId: "4,2147483648" }, { timeId: "4,9999999999" }, { timeId: "4,x" }, { timeId: "4," },
    { timeId: "04" }, { timeId: "" }, { timeId: "1".repeat(1025) },
    { timeId: Array(64).fill("4").join(",") }, { timeId: Array(65).fill("4").join(",") },
  ])("matches pure policy and safely rejects casts for child mutation %j", async change => {
    await f.db.update(storeSeckill).set(change); await compare();
  });
  it.each([
    { status: 0 }, { startTime: "bad" }, { startTime: "2200", endTime: "0200" },
    { startTime: "0800", endTime: "0800" }, { startTime: "0000", endTime: "2400" },
    { startTime: "24:00", endTime: "2400" }, { startTime: "0800", endTime: "2460" },
    { startTime: "0800\n" }, { endTime: "2000\r\n" }, { endTime: "20:00\u2028" },
  ])("matches enabled and malformed linked slot policy %j", async change => {
    await f.db.update(storeSeckillTime).set(change).where(eq(storeSeckillTime.id, 8)); await compare();
  });
  it("does not authorize missing parents/slots, and does not let unlinked bad slots poison valid activities", async () => {
    await f.db.insert(storeSeckillTime).values({ id: 12, status: 1, startTime: "invalid", endTime: "invalid" }); await compare();
    expect(await dao.getByTimeId("4", 1, 10, time())).toHaveLength(1);
    await f.db.delete(storeSeckillTime).where(eq(storeSeckillTime.id, 8)); await compare();
    await f.db.delete(storeActivity); await compare();
  });
  it("honors inclusive legacy final day and precise endpoints independently of the database timezone", async () => {
    await f.db.update(storeSeckill).set({ stopTime: time("00:00:00", "2026-09-08") });
    await compare(time("19:00:00", "2026-09-08"));
    expect(await dao.getByTimeId("8", 1, 10, time("19:00:00", "2026-09-08"))).toHaveLength(1);
    await compare(time("00:00:00", "2026-09-09"));
    await f.db.update(storeSeckill).set({ stopTime: time("09:15:00") });
    await compare(time("09:15:00")); await compare(time("09:15:00.001"));
    await f.db.transaction(async tx => {
      await tx.execute((await import("drizzle-orm")).sql`SET LOCAL TIME ZONE 'America/Los_Angeles'`);
      const alternate = new StoreSeckillDao(tx);
      expect(await alternate.getByTimeId("4", 1, 10, time("09:15:00"))).toHaveLength(1);
      expect(await alternate.getByTimeId("8", 1, 10, time("09:15:00"))).toHaveLength(0); // Requested slot cannot fit before precise end.
    });
  });
  it("filters before LIMIT/OFFSET and uses ID to break equal-sort ties across complete pages", async () => {
    await f.db.delete(storeSeckill);
    await f.db.insert(storeSeckill).values(Array.from({ length: 125 }, (_, i) => ({ id: i + 1, activityId: i < 25 ? 9 : 99,
      timeId: "4", sort: i < 25 ? 1 : 100, productId: 70 })));
    const pages = [];
    for (let page = 1; page <= 4; page++) pages.push(await dao.getByTimeId("4", page, 10, time()));
    expect(pages.map(page => page.length)).toEqual([10, 10, 5, 0]);
    expect(pages.flat().map(row => row.id)).toEqual(Array.from({ length: 25 }, (_, i) => 25 - i));
  });
  it("rejects invalid requested IDs and clocks instead of silently returning an empty page", async () => {
    for (const id of ["", "0", "01", "4,8", "0800", "4 OR 1=1", "2147483648", "4\n", "4\r", "4\u2028"]) await expect(dao.getByTimeId(id, 1, 10, time())).rejects.toThrow("参数无效");
    await expect(dao.getByTimeId("4", 1, 10, new Date(NaN))).rejects.toThrow("参数无效");
  });
});
