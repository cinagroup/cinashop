import { createContainerFromDb } from '@/lib/di';
import { storeBrand, storeProduct, storeProductRelation } from '@/models/schema';
import { eq } from 'drizzle-orm';
import { supplierProductScheduleFixture, supplierProductScheduleActor, type SupplierProductScheduleRuntime } from './supplierProductSchedule';
export { supplierProductScheduleActor as supplierProductBrandActor } from './supplierProductSchedule';
export async function supplierProductBrandFixture() {
  const f = await supplierProductScheduleFixture();
  try {
    await f.db.insert(storeBrand).values([
      { id: 101, brandName: '平台根甲' }, { id: 102, brandName: '平台子甲', pid: 101 }, { id: 103, brandName: '平台孙甲', pid: 102 },
      { id: 104, brandName: '平台根乙' }, { id: 105, brandName: '平台子乙', pid: 104 },
      { id: 106, brandName: '隐藏品牌', isShow: 0 }, { id: 107, brandName: '删除品牌', isDel: 1 },
      { id: 108, brandName: '门店品牌', storeId: 7 }, { id: 109, brandName: '孤儿品牌', pid: 999 },
      { id: 110, brandName: '隐藏根子', pid: 106 },
    ]);
    await f.db.update(storeProduct).set({ brandId: 102, brandCom: '101,102', ensureId: '41', specsId: 51,
      specs: '[{"name":"材质","value":"棉"}]', labelId: '61', commandWord: '原样保留', systemFormId: 71 }).where(eq(storeProduct.id, 80));
    await f.db.insert(storeProductRelation).values([
      { productId: 80, type: 2, relationId: 101, status: 1 }, { productId: 80, type: 2, relationId: 102, status: 1 },
      { productId: 80, type: 3, relationId: 31, status: 0 }, { productId: 80, type: 4, relationId: 61, status: 1 },
      { productId: 80, type: 5, relationId: 41, status: 1 }, { productId: 80, type: 6, relationId: 51, status: 1 },
    ]);
    const withReader = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withReader(async runtime => {
      await f.exec(`GRANT SELECT ON public.store_brand,public.store_product_ensure TO "${runtime.role}"`); return work(runtime);
    });
    const withWriter = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withWriter(async runtime => {
      await f.exec(`GRANT SELECT ON public.store_brand,public.store_product_ensure TO "${runtime.role}"; GRANT UPDATE(id) ON public.store_brand TO "${runtime.role}"`);
      return work(runtime);
    });
    return { ...f, withReader, withWriter, actor: supplierProductScheduleActor(),
      container: createContainerFromDb(f.db), brands: { root: 101, child: 102, grandchild: 103, otherRoot: 104, otherChild: 105 } };
  } catch (error) { await f.close(); throw error; }
}
