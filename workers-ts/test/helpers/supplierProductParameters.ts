import { legacyCategory, storeProductSpecs } from '@/models/schema';
import { supplierProductEnsuresFixture } from './supplierProductEnsures';
import type { SupplierProductScheduleRuntime } from './supplierProductSchedule';
export { supplierProductEnsuresActor as supplierProductParametersActor } from './supplierProductEnsures';
/** New fixture grants are confined to the newly owned database. Catalog row
 * locking uses UPDATE(id); no parameter/catalog content edit is granted. */
export async function supplierProductParametersFixture() {
  const f = await supplierProductEnsuresFixture();
  try {
    await f.db.insert(legacyCategory).values([
      { id: 51, type: 2, relationId: 7, ownerId: 0, group: 3, name: '原有参数模板' },
      { id: 301, type: 0, relationId: 0, ownerId: 0, group: 3, name: '平台基础参数' },
      { id: 302, type: 2, relationId: 7, ownerId: 0, group: 3, name: '本店服装参数' },
      { id: 303, type: 2, relationId: 8, ownerId: 0, group: 3, name: '外店私有参数模板' },
      { id: 304, type: 1, relationId: 7, ownerId: 0, group: 3, name: '门店参数不可借用' },
      { id: 305, type: 2, relationId: 7, ownerId: 0, group: 2, name: '错误参数组' },
      { id: 306, type: 2, relationId: 7, ownerId: 99, group: 3, name: '子级参数不可借用' },
      { id: 307, type: 2, relationId: 7, ownerId: 0, group: 3, name: '目录未过滤显示开关', isShow: 0 },
    ]);
    await f.db.insert(storeProductSpecs).values([
      { id: 511, type: 2, relationId: 7, tempId: 51, name: '材质', value: '棉', sort: 0, status: 1 },
      { id: 311, type: 0, relationId: 0, tempId: 301, name: '材质', value: '棉', sort: 9, status: 1 },
      { id: 312, type: 0, relationId: 0, tempId: 301, name: '产地', value: '中国', sort: 1, status: 1 },
      { id: 321, type: 2, relationId: 7, tempId: 302, name: '尺码', value: 'M', sort: 0, status: 1 },
      { id: 322, type: 2, relationId: 7, tempId: 302, name: '已停用子项', value: '不可种入', status: 0 },
      { id: 331, type: 2, relationId: 8, tempId: 303, name: '外店私有参数名', value: '外店私有参数值', status: 1 },
      { id: 332, type: 2, relationId: 8, tempId: 302, name: '归属错配子项', value: '不可种入', status: 1 },
    ]);
    const withReader = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withReader(async runtime => {
      await f.exec(`GRANT SELECT ON public.category,public.store_product_specs TO "${runtime.role}"`); return work(runtime);
    });
    const withWriter = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withWriter(async runtime => {
      await f.exec(`GRANT SELECT ON public.category,public.store_product_specs TO "${runtime.role}"; GRANT UPDATE(id) ON public.category TO "${runtime.role}"`); return work(runtime);
    });
    return { ...f, withReader, withWriter, templates: { original: 51, platform: 301, own: 302, foreign: 303, wrongType: 304, wrongGroup: 305, nested: 306, hidden: 307 } };
  } catch (error) { await f.close(); throw error; }
}
