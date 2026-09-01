import { describe, expect, it, vi } from "vitest";
import { ActivityService } from "../src/services/activity/ActivityService";

describe("legacy activity-list compatibility", () => {
  it("returns the PHP seckill-index envelope using the Shanghai clock", async () => {
    const service = new ActivityService({
      storeSeckillTimeDao: {
        getAll: vi.fn().mockResolvedValue([
          { id: 1, title: "凌晨", pic: "", describe: "", startTime: "00:00", endTime: "11:59", addTime: 1 },
          { id: 2, title: "下午", pic: "", describe: "", startTime: "12:00", endTime: "17:59", addTime: 2 },
          { id: 3, title: "晚间", pic: "", describe: "", startTime: "18:00", endTime: "23:59", addTime: 3 },
        ]),
      },
      systemConfigDao: {
        getValues: vi.fn().mockResolvedValue({
          seckill_header_banner: "/activity/banner.png",
          site_url: "https://shop.example/",
        }),
      },
    } as never);

    const result = await service.seckillTimes(new Date("2026-09-01T12:30:00.000Z"));

    expect(result).toMatchObject({
      lovely: "https://shop.example/activity/banner.png",
      seckillTimeIndex: 2,
      seckillTime: [
        { start_time: "00:00", end_time: "11:59", status: 0, state: "已结束" },
        { start_time: "12:00", end_time: "17:59", status: 0, state: "已结束" },
        { start_time: "18:00", end_time: "23:59", status: 1, state: "疯抢中" },
      ],
    });
    expect(result.seckillTime[2]?.stop).toBe(
      Math.floor(Date.parse("2026-09-01T23:59:00+08:00") / 1_000),
    );
  });

  it("serializes list rows to the fields consumed by the PHP UniApp and caps pagination", async () => {
    const getByTimeId = vi.fn().mockResolvedValue([{
      id: 11,
      productId: 101,
      activityId: 201,
      storeName: "秒杀商品",
      image: "/seckill.png",
      price: "8.00",
      otPrice: "10.00",
      quota: 25,
      quotaShow: 100,
      freight: 2,
      storeLabelId: "",
    }]);
    const combinationList = vi.fn().mockResolvedValue([{
      id: 12,
      productId: 102,
      storeName: "拼团商品",
      image: "/combination.png",
      price: "9.00",
      otPrice: "12.00",
      people: 3,
      quota: 8,
      quotaShow: 10,
      stock: 8,
    }]);
    const bargainList = vi.fn().mockResolvedValue([{
      id: 13,
      type: 0,
      relationId: 0,
      productId: 103,
      productType: 0,
      storeName: "砍价商品",
      title: "",
      image: "/bargain.png",
      price: "20.00",
      minPrice: "5.00",
      info: "",
      sales: 2,
      stock: 9,
      people: 6,
    }]);
    const integralList = vi.fn().mockResolvedValue([{
      id: 14,
      productId: 104,
      storeName: "积分商品",
      image: "/integral.png",
      integral: 300,
      price: "1.50",
      sales: 4,
      stock: 7,
    }]);
    const service = new ActivityService({
      storeSeckillDao: { getByTimeId },
      storeCombinationDao: { list: combinationList },
      storeBargainDao: { list: bargainList },
      storeIntegralDao: { list: integralList },
    } as never);

    await expect(service.seckillList("3", 0, 999)).resolves.toEqual([expect.objectContaining({
      id: 11,
      product_id: 101,
      title: "秒杀商品",
      price: 8,
      ot_price: 10,
      stock: 25,
      percent: 75,
      discount_num: 8,
    })]);
    await expect(service.combinationList(1, 6)).resolves.toEqual([expect.objectContaining({
      title: "拼团商品",
      product_id: 102,
      product_price: 12,
      pink_count: 2,
    })]);
    await expect(service.bargainList(1, 6)).resolves.toEqual([expect.objectContaining({
      title: "砍价商品",
      product_id: 103,
      min_price: 5,
      ot_price: 20,
    })]);
    await expect(service.integralList(1, 6)).resolves.toEqual([expect.objectContaining({
      title: "积分商品",
      product_id: 104,
      integral: 300,
      price: 1.5,
    })]);
    await service.combinationList(999_999, 50);
    expect(getByTimeId).toHaveBeenCalledWith("3", 1, 50);
    expect(combinationList).toHaveBeenNthCalledWith(1, 1, 6);
    expect(combinationList).toHaveBeenNthCalledWith(2, 201, 50);
    expect(bargainList).toHaveBeenCalledWith(1, 6);
    expect(integralList).toHaveBeenCalledWith(1, 6);
  });
});
