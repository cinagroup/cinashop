import { storeProductEnsure, storeProductLabel, legacyCategory } from '@/models/schema';
import { supplierProductBrandFixture } from './supplierProductBrand';
import type { SupplierProductScheduleRuntime } from './supplierProductSchedule';
export { supplierProductBrandActor as supplierProductEnsuresActor } from './supplierProductBrand';
export async function supplierProductEnsuresFixture() {
  const f = await supplierProductBrandFixture();
  try {
    await f.db.insert(storeProductEnsure).values([
      { id: 41, type: 2, relationId: 7, name: '原有本店保障', image: '', desc: '原有保障说明', status: 1 },
      { id: 201, type: 0, relationId: 0, name: '平台七天保障', image: '', desc: '平台保障说明', status: 1 },
      { id: 202, type: 2, relationId: 7, name: '本店品质保障', image: '', desc: '自有保障说明', status: 1 },
      { id: 203, type: 2, relationId: 8, name: '外店私有名称不得泄露', image: '', status: 1 },
      { id: 204, type: 1, relationId: 7, name: '门店保障不得借用', image: '', status: 1 },
      { id: 205, type: 0, relationId: 0, name: '已停用平台保障', image: '', status: 0 },
    ]);
    await f.db.insert(legacyCategory).values({ id: 501, type: 2, relationId: 7, ownerId: 0, group: 2, name: '本店商品标签组', isShow: 1 });
    await f.db.insert(storeProductLabel).values({ id: 31, type: 2, relationId: 7, labelCate: 501, labelName: '原有标签', status: 1, isShow: 1 });
    const withWriter = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withWriter(async runtime => {
      await f.exec(`GRANT UPDATE(id) ON public.store_product_ensure,public.store_product_label,public.category,public.store_product_relation TO "${runtime.role}";
        GRANT SELECT ON public.store_product_label,public.category TO "${runtime.role}"`);
      return work(runtime);
    });
    return { ...f, withWriter, ensures: { original: 41, platform: 201, own: 202, foreign: 203, wrongType: 204, disabled: 205 } };
  } catch (error) { await f.close(); throw error; }
}
