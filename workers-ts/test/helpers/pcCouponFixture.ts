import { createPcCheckoutQuoteFixture } from "./pcCheckoutQuoteFixture";
import type { PgTable } from "drizzle-orm/pg-core";
import { myCoupons, myCouponCounts } from "../../src/controllers/api/v1/UserActivityController";
import { storeCouponIssue, storeCouponUser, storeCouponProduct, storeOrderCartInfo, storeOrderStatus, printDocument } from "../../src/models/schema";

export async function createPcCouponFixture(extraTables: PgTable[] = []) {
  const fixture = await createPcCheckoutQuoteFixture([storeCouponIssue, storeCouponUser, storeCouponProduct, storeOrderCartInfo, storeOrderStatus, printDocument, ...extraTables]);
  try {
    fixture.config.first_order_status = "0";
    await fixture.db.insert(storeCouponIssue).values([
      { id: 1, couponType: 0, type: 1, couponTitle: "现金券", status: 1 },
      { id: 2, couponType: 0, type: 2, couponTitle: "折扣券", status: 1 },
      { id: 3, couponType: 2, type: 1, productId: "999", couponTitle: "指定商品券", status: 1 },
    ]);
    const now = Date.now();
    const startTime = new Date(now - 86400000), endTime = new Date(now + 86400000);
    await fixture.db.insert(storeCouponUser).values([
      { id: 41, uid: 11, issueCouponId: 1, couponTitle: "满10减5", couponPrice: "5.00", useMinPrice: "10.00", startTime, endTime },
      { id: 42, uid: 11, issueCouponId: 2, couponTitle: "八五折", couponPrice: "85.00", startTime, endTime },
      { id: 43, uid: 11, issueCouponId: 1, couponTitle: "已过期样本", couponPrice: "1.00", endTime: new Date(now - 1000) },
      { id: 44, uid: 11, issueCouponId: 1, couponTitle: "已使用样本", couponPrice: "1.00", status: 1, endTime: new Date(now - 1000) },
      { id: 45, uid: 11, issueCouponId: 1, couponTitle: "占用中样本", couponPrice: "1.00", status: 3, endTime: new Date(now - 1000) },
      { id: 46, uid: 11, issueCouponId: 1, couponTitle: "未来开始样本", couponPrice: "1.00", startTime: new Date(now + 3600000), endTime },
      { id: 47, uid: 11, issueCouponId: 1, couponTitle: "已失效样本", couponPrice: "1.00", isFail: 1 },
      { id: 48, uid: 22, issueCouponId: 1, couponTitle: "其他用户券", couponPrice: "1.00", endTime },
      { id: 49, uid: 11, issueCouponId: 3, couponTitle: "仅限其他商品", couponPrice: "1.00", endTime },
      { id: 50, uid: 11, issueCouponId: 1, couponTitle: "满20减3", couponPrice: "3.00", useMinPrice: "20.00", endTime },
    ]);
    fixture.app.get("/api/coupons/user/num", myCouponCounts);
    fixture.app.get("/api/coupons/user/:types", myCoupons);
    return fixture;
  } catch (error) { await fixture.close(); throw error; }
}
