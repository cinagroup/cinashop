import { describe, expect, it, vi } from "vitest";
import { ActivityService } from "../src/services/activity/ActivityService";

describe("coupon-user migration parity", () => {
  it("records the PHP-compatible acquisition source on new Worker coupons", async () => {
    const values = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 42 }]),
    });
    const issue = {
      id: 7,
      status: 1,
      isDel: 0,
      isPermanent: 1,
      totalCount: 0,
      remainCount: 0,
      receiveLimit: 1,
      receiveType: 1,
      startTime: new Date("2026-01-01T00:00:00Z"),
      endTime: new Date("2027-01-01T00:00:00Z"),
      day: 30,
      couponTitle: "legacy-compatible",
      title: "legacy-compatible",
      couponPrice: "5.00",
      useMinPrice: "10.00",
      type: 2,
    };
    const issueBuilder = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      for: vi.fn().mockResolvedValue([issue]),
    };
    const countBuilder = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ count: 0 }]),
    };
    const select = vi.fn()
      .mockReturnValueOnce(issueBuilder)
      .mockReturnValueOnce(countBuilder);
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ select, insert: vi.fn().mockReturnValue({ values }) }),
    );
    const service = new ActivityService({
      db: { transaction },
    } as never);

    await expect(service.receiveCoupon(9, 7)).resolves.toEqual({ couponUserId: 42 });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 9,
        issueCouponId: 7,
        type: 2,
        receiveSource: "get",
        isFail: 0,
      }),
    );
  });
});
