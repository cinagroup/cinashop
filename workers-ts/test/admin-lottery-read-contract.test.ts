import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContainerFromDb } from "@/lib/di";
import { luckLottery, luckLotteryRecord, luckPrize, user } from "@/models/schema";
import { LotteryAdminService } from "@/services/activity/LotteryAdminService";
import { financePostgres } from "./helpers/financePostgres";

const NOW = Math.floor(Date.parse("2026-09-28T10:00:00Z") / 1000);

describe("legacy Admin lottery list and record read contract", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let service: LotteryAdminService;

  beforeEach(async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    fixture = await financePostgres([luckLottery, luckPrize, luckLotteryRecord, user]);
    service = new LotteryAdminService(createContainerFromDb(fixture.db));
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture?.close();
  }, 30_000);

  async function activities() {
    await fixture.db.insert(luckLottery).values([
      { id: 1, name: "未来积分", factor: 1, status: 1, startTime: NOW + 1, endTime: NOW + 100, addTime: 10 },
      { id: 2, name: "刚刚开始", factor: 1, status: 1, startTime: NOW, endTime: NOW + 100, addTime: 20 },
      { id: 3, name: "刚好结束", factor: 1, status: 1, startTime: NOW - 100, endTime: NOW, addTime: 30 },
      { id: 4, name: "已经结束", factor: 2, status: 1, startTime: NOW - 100, endTime: NOW - 1, addTime: 40 },
      { id: 5, name: "人工下架", factor: 1, status: 0, startTime: NOW - 100, endTime: NOW + 100, addTime: 50 },
      { id: 6, name: "不限定时段", factor: 5, status: 1, startTime: 0, endTime: 0, addTime: 60 },
      { id: 7, name: "软删历史", factor: 1, status: 1, startTime: NOW - 100, endTime: NOW + 100, isDel: 1, addTime: 70 },
    ]);
  }

  it("uses the legacy phase boundaries, 15-row page and batched raw/distinct participation metrics", async () => {
    await activities();
    await fixture.db.insert(luckLotteryRecord).values([
      { id: 101, lotteryId: 2, uid: 11, type: 1, addTime: NOW },
      { id: 102, lotteryId: 2, uid: 11, type: 2, addTime: NOW },
      { id: 103, lotteryId: 2, uid: 12, type: 2, addTime: NOW },
      { id: 104, lotteryId: 2, uid: 0, type: 1, addTime: NOW },
      { id: 105, lotteryId: 3, uid: 20, type: 3, addTime: NOW },
    ]);
    const all = await service.list({});
    expect(all).toMatchObject({ count: 6, page: 1, limit: 15 });
    expect(all.list.map(row => row.id)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(all.list.find(row => row.id === 2)).toMatchObject({
      time_status: 1, lottery_status: "进行中", lottery_type: "积分",
      lottery_all: 4, lottery_people: 3, lottery_win: 2,
    });
    expect(all.list.find(row => row.id === 3)).toMatchObject({ lottery_all: 1, lottery_people: 1, lottery_win: 1 });
    expect(all.list.find(row => row.id === 1)).toMatchObject({ lottery_all: 0, lottery_people: 0, lottery_win: 0 });
    expect(all.list.find(row => row.id === 5)).toMatchObject({ time_status: 2, lottery_status: "已结束" });
    expect((await service.list({ start_status: "0" })).list.map(row => row.id)).toEqual([1]);
    expect((await service.list({ start_status: "1" })).list.map(row => row.id)).toEqual([6, 3, 2]);
    expect((await service.list({ start_status: "-1" })).list.map(row => row.id)).toEqual([5, 4]);
    expect((await service.list({ start_status: "-1", status: "1" })).list.map(row => row.id)).toEqual([4]);
    expect((await service.list({ name: "2" })).list.map(row => row.id)).toEqual([2]);
    await fixture.db.insert(luckLottery).values(Array.from({ length: 13 }, (_, i) => ({
      id: i + 20, name: `填充${i}`, factor: 1, status: 1, startTime: NOW + 1, endTime: NOW + 100, addTime: 80 + i,
    })));
    expect((await service.list({})).list).toHaveLength(15);
    expect((await service.list({ page: "2" })).list).toHaveLength(4);
  });

  it("rejects malformed list filters rather than broadening a scoped read", async () => {
    for (const query of [
      { start_status: "2" }, { factor: "NaN" }, { status: "-1" },
      { page: "0" }, { limit: "101" }, { name: "a".repeat(101) },
    ]) await expect(service.list(query)).rejects.toThrow();
  });

  it("keeps an open-ended historical activity in the same stage as its displayed label", async () => {
    await fixture.db.insert(luckLottery).values({
      id: 8, name: "旧开放结束时间", factor: 2, status: 1,
      startTime: NOW - 100, endTime: 0, addTime: 80,
    });
    expect((await service.list({})).list[0]).toMatchObject({ id: 8, time_status: 1 });
    expect((await service.list({ start_status: "1" })).list.map(row => row.id)).toEqual([8]);
    expect((await service.list({ start_status: "-1" })).list).toEqual([]);
  });

  it("paginates all historical wins with stable timestamp/ID order and redacts address and phone", async () => {
    await activities();
    await fixture.db.insert(user).values({ uid: 11, nickname: "测试用户", phone: "13900000011", realName: "私密姓名" });
    await fixture.db.insert(luckPrize).values({ id: 100, lotteryId: 2, type: 6, name: "已改名的商品", image: "/old.png" });
    await fixture.db.insert(luckLotteryRecord).values([
      { id: 1, lotteryId: 2, prizeId: 100, uid: 11, type: 6, addTime: NOW,
        prizeInfo: JSON.stringify({ type: 6, name: "获奖时商品", image: "/snapshot.png" }),
        receiveInfo: JSON.stringify({ name: "私密收货人", phone: "13800000000", address: "私密地址" }),
        deliverInfo: JSON.stringify({ mark: "已核对", deliver_name: "顺丰", deliver_number: "SF123" }) },
      { id: 2, lotteryId: 999, prizeId: 999, uid: 999, type: 4, addTime: NOW },
      { id: 3, lotteryId: 2, prizeId: 100, uid: 11, type: 1, addTime: NOW },
      ...Array.from({ length: 16 }, (_, i) => ({ id: i + 4, lotteryId: 2, prizeId: 100, uid: 11, type: 2, addTime: NOW - 1 })),
    ]);
    const first = await service.records({});
    expect(first).toMatchObject({ count: 18, page: 1, limit: 15 });
    expect(first.list.map(row => row.id)).toEqual([2, 1, ...Array.from({ length: 13 }, (_, i) => 19 - i)]);
    expect((await service.records({ page: "2" })).list.map(row => row.id)).toEqual([6, 5, 4]);
    expect(first.list[0]).toMatchObject({ user: { uid: 999, nickname: "用户已注销" }, lottery: null });
    expect(first.list[1]).toMatchObject({ prize: { name: "获奖时商品" }, deliver_info: { mark: "已核对" } });
    expect(first.list[1].deliver_info).not.toHaveProperty("deliver_number");
    expect((await service.recordDetail(1)).deliver_info).toMatchObject({ deliver_name: "顺丰", deliver_number: "SF123", mark: "已核对" });
    for (const result of [first.list[1], await service.recordDetail(1)]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("13800000000");
      expect(serialized).not.toContain("13900000011");
      expect(serialized).not.toContain("私密姓名");
      expect(serialized).not.toContain("私密地址");
      expect(serialized).not.toContain("receive_info");
      expect(serialized).not.toContain("receiveInfo");
    }
  });

  it("filters by activity/factor/prize/user/date and rejects conflicting path and query IDs", async () => {
    await activities();
    await fixture.db.insert(user).values({ uid: 11, nickname: "筛选用户", phone: "13900000011", realName: "测试真名" });
    await fixture.db.insert(luckPrize).values({ id: 100, lotteryId: 2, type: 6, name: "红色商品", image: "/prize.png" });
    await fixture.db.insert(luckLotteryRecord).values([
      { id: 1, lotteryId: 2, prizeId: 100, uid: 11, type: 6, addTime: NOW - 1, isReceive: 1, isDeliver: 0 },
      { id: 2, lotteryId: 3, prizeId: 100, uid: 11, type: 2, addTime: NOW, isReceive: 0, isDeliver: 1 },
      { id: 3, lotteryId: 4, prizeId: 100, uid: 11, type: 6, addTime: NOW + 1, isReceive: 1, isDeliver: 1 },
      { id: 4, lotteryId: 999, prizeId: 999, uid: 999, type: 6, addTime: NOW + 2 },
    ]);
    const ids = async (query: Record<string, string>, path?: number) => (await service.records(query, path)).list.map(row => row.id);
    expect(await ids({ factor: "1" })).toEqual([2, 1]);
    expect(await ids({ type: "6" })).toEqual([4, 3, 1]);
    expect(await ids({ lottery_id: "2" }, 2)).toEqual([1]);
    expect(await ids({ keyword: "筛选用户" })).toEqual([3, 2, 1]);
    expect(await ids({ keyword: "13900000011" })).toEqual([3, 2, 1]);
    expect(await ids({ keyword: "红色商品" })).toEqual([3, 2, 1]);
    expect(await ids({ start_time: String(NOW), end_time: String(NOW + 1) })).toEqual([3, 2]);
    expect(await ids({ is_receive: "1", is_deliver: "1" })).toEqual([3]);
    expect(await ids({ keyword: "%" })).toEqual([]);
    await expect(service.records({ lottery_id: "3" }, 2)).rejects.toThrow("活动ID与路径不一致");
    await expect(service.records({ end_time: String(NOW - 1), start_time: String(NOW) })).rejects.toThrow("时间范围无效");
    for (const query of [{ type: "10" }, { factor: "6" }, { is_receive: "2" }, { limit: "0" }, { keyword: "a".repeat(101) }]) {
      await expect(service.records(query)).rejects.toThrow();
    }
  });
});
