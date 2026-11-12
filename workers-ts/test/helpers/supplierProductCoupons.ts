import { storeCouponIssue } from '@/models/schema';
import { supplierProductRecommendImageFixture } from './supplierProductRecommendImage';
import type { SupplierProductScheduleRuntime } from './supplierProductSchedule';

/** Only owned tables/LOGINs; no broader production grants or business doubles. */
export async function supplierProductCouponsFixture() {
  const f = await supplierProductRecommendImageFixture();
  try {
    await f.db.insert(storeCouponIssue).values([
      { id: 9101, title: '本地固定窗口赠券', couponTitle: '本地固定窗口赠券', couponPrice: '5.00', useEndTime: new Date('2030-01-01T00:00:00Z') },
      { id: 9102, title: '本地停用赠券', status: 0 }, { id: 9103, title: '已删除实例', isDel: 1 },
      { id: 9104, title: '搜索%_字面值', day: 7 },
    ]);
    const withCouponWriter = <T>(work: (writer: SupplierProductScheduleRuntime) => Promise<T>) => f.withWriter(async writer => {
      await f.exec(`GRANT INSERT,DELETE ON public.store_product_coupon TO "${writer.role}";
        GRANT USAGE ON SEQUENCE public.store_product_coupon_id_seq TO "${writer.role}";
        GRANT UPDATE(id) ON public.store_coupon_issue TO "${writer.role}"`);
      return work(writer);
    });
    return { ...f, withCouponWriter };
  } catch (error) { await f.close(); throw error; }
}
