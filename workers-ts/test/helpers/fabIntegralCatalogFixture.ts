/** Owned integral chooser slice. The shared reader fixture installs only real
 * ORM tables and exact existing SELECT grants on independent LOGIN roles. */
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { storeIntegral, storeProduct, systemAdmin, systemMenus, systemRole, systemStore } from '../../src/models/schema';
import { AdminFabLinkCatalogService } from '../../src/services/admin/AdminFabLinkCatalogService';
import { integralProductReadFixture } from './integralProductReadFixture';

export async function fabIntegralCatalogFixture() {
  const f = await integralProductReadFixture({ extraTables: [systemAdmin, systemRole, systemMenus] });
  try {
    await f.db.insert(systemStore).values({ id: 78, name: '隐藏门店', isShow: 0, isDel: 0, isStore: 1 });
    await f.exec('UPDATE public.system_supplier SET is_show=0 WHERE id=89');
    await f.db.insert(storeProduct).values([
      { id: 71, type: 1, relationId: 77, pid: 70, storeName: '门店独立商品', isVerify: 1, stock: 10, image: '/api/assets/41' },
      { id: 72, type: 2, relationId: 88, pid: 70, storeName: '供应商独立商品', isVerify: 1, stock: 10, image: '/api/assets/42' },
      { id: 73, type: 1, relationId: 78, pid: 70, storeName: '隐藏门店商品', isVerify: 1 },
      { id: 74, type: 2, relationId: 89, pid: 70, storeName: '隐藏供应商商品', isVerify: 1 },
      { id: 75, storeName: '隐藏基础商品', isVerify: 1, isShow: 0 },
      { id: 76, storeName: '会员专属商品', isVerify: 1, isVipProduct: 1 },
      { id: 77, storeName: '预售商品', isVerify: 1, isPresaleProduct: 1 },
      { id: 78, storeName: '未审核商品', isVerify: 0 },
      { id: 79, storeName: '删除商品', isVerify: 1, isDel: 1 },
      { id: 80, type: 0, relationId: 88, storeName: '无效平台归属', isVerify: 1 },
      { id: 81, type: 2, relationId: 88, pid: -1, storeName: '无效来源', isVerify: 1 },
      { id: 82, type: 2, relationId: 88, pid: 99999, storeName: '孤儿副本', isVerify: 1 },
    ]);
    await f.db.insert(storeIntegral).values([
      { id: 10, productId: 71, type: 1, relationId: 77, storeName: '门店积分', price: '2.00', stock: 10, quota: 10, image: '/api/assets/41' },
      { id: 11, productId: 72, type: 2, relationId: 88, storeName: '供应商积分', price: '3.00', stock: 10, quota: 10, image: '/api/assets/42' },
      { id: 12, productId: 72, type: 2, relationId: 88, storeName: '外属图片积分', price: '3.00', image: '/api/assets/43' },
      { id: 13, productId: 70, storeName: '已兑完积分', price: '0.00', stock: 0, quota: 0, image: '/api/assets/41' },
      { id: 14, productId: 70, storeName: '损坏摘要积分', price: '-1.00', stock: -1, quota: 3 },
      { id: 15, productId: 70, storeName: '缺失图片积分', price: '1.00', image: '/api/assets/999' },
      { id: 16, productId: 70, storeName: '坏\u0007名称', price: '1.00' },
      { id: 20, productId: 999, storeName: '孤儿积分' },
      { id: 21, productId: 72, storeName: '跨所有者积分' },
      { id: 22, productId: 70, productType: 1, storeName: '错商品类型积分' },
      { id: 23, productId: 75, storeName: '隐藏基础积分' },
      { id: 24, productId: 73, type: 1, relationId: 78, storeName: '隐藏门店积分' },
      { id: 25, productId: 74, type: 2, relationId: 89, storeName: '隐藏供应商积分' },
      { id: 26, productId: 76, storeName: '会员积分' },
      { id: 27, productId: 77, storeName: '预售积分' },
      { id: 28, productId: 78, storeName: '未审核积分' },
      { id: 29, productId: 79, storeName: '删除基础积分' },
      { id: 30, productId: 70, status: 0, storeName: '未发布积分' },
      { id: 31, productId: 70, isShow: 0, storeName: '隐藏活动积分' },
      { id: 32, productId: 70, isDel: 1, storeName: '删除活动积分' },
      { id: 33, productId: 80, type: 0, relationId: 88, storeName: '无效平台归属积分' },
      { id: 34, productId: 81, type: 2, relationId: 88, storeName: '负来源积分' },
      { id: 35, productId: 82, type: 2, relationId: 88, storeName: '孤儿副本积分' },
    ]);
    return { ...f, catalogFor: (db: DbClient = f.db) => new AdminFabLinkCatalogService(createContainerFromDb(db), f.env) };
  } catch (error) { await f.close(); throw error; }
}
