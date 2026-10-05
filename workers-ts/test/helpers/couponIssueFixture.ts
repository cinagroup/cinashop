import { createContainerFromDb } from '../../src/lib/di';
import { storeBrand } from '../../src/models/schema';
import { COUPON_PRODUCT_SCOPE_FENCE_SQL } from '../../src/migrations/couponProductScopeFence';
import { AdminCouponIssueService } from '../../src/services/admin/AdminCouponIssueService';
import { AdminCouponTemplateService } from '../../src/services/admin/AdminCouponTemplateService';
import { financePostgres } from './financePostgres';
import { couponTemplateSnapshot, couponTemplateTables, seedCouponTemplates } from './couponTemplateFixture';

export const couponIssueBody = (overrides: Record<string, unknown> = {}) => ({
  request_id: crypto.randomUUID(), source_id: 0, source_revision: null, title: '新发行', discount_type: 1,
  scope_type: 0, category: 0, category_id: 0, brand_id: 0, product_ids: [], coupon_price: '5.1', use_min_price: '10',
  valid_days: 7, use_start_time: null, use_end_time: null, start_time: null, end_time: null, receive_type: 1,
  is_permanent: 0, total_count: 5, rule: '凭券购买\n一次使用', status: 1, sort: 0, ...overrides,
});
export async function couponIssueFixture() {
  const f = await financePostgres([...couponTemplateTables, storeBrand], { namespace: 'public' });
  try {
    await f.exec(COUPON_PRODUCT_SCOPE_FENCE_SQL);
    await seedCouponTemplates(f.db);
    await f.db.insert(storeBrand).values([{ id: 4500, brandName: '品牌根', pid: 0, storeId: 0 },
      { id: 4501, brandName: '品牌子', pid: 4500, storeId: 0 }]);
    const container = createContainerFromDb(f.db);
    return { ...f, container, service: new AdminCouponIssueService(container), templates: new AdminCouponTemplateService(container),
      snapshot: () => couponTemplateSnapshot(f.db) };
  } catch (error) { await f.close(); throw error; }
}
