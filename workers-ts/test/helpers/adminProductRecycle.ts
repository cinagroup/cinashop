import { eq } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeCart, storeOrderOutbox, storeProduct, storeProductAttrValue, storeProductRelation, systemAdmin, systemLog, systemMenus, systemRole } from '@/models/schema';
import { AdminProductRecycleService, type AdminProductRecycleEffects } from '@/services/admin/AdminProductRecycleService';
import { financePostgres } from './financePostgres';
import { moderationSchema, moderationSnapshot, seedModeration } from './adminProductModeration';
import { resetStockSequences, stockActor } from './adminProductStocks';

export const recycleSchema = moderationSchema;
export const recycleActor = stockActor;
export const recycleSnapshot = moderationSnapshot;
export async function seedRecycle(db: DbClient) {
  await seedModeration(db);
  await db.update(storeProduct).set({ isShow: 1, isVerify: 1, autoOnTime: 1700000000 }).where(eq(storeProduct.id, 10));
  await db.update(storeProduct).set({ isDel: 1, isVerify: -1, isShow: 1 }).where(eq(storeProduct.id, 100));
  await db.insert(storeProduct).values([
    { id: 102, pid: 10, type: 2, relationId: 0, isDel: 0, isShow: 2, isVerify: -2, storeName: '直接子商品任意归属' },
    { id: 103, pid: 100, type: 0, isDel: 0, isShow: 1, isVerify: 1, storeName: '孙商品不传播' },
    { id: 110, type: 1, relationId: 0, isVerify: 1, isShow: 2, storeName: '无默认门店也成功' },
    { id: 111, type: 1, relationId: -3, isVerify: -1, storeName: '异常门店归属仍沿用源合同' },
  ]);
  await db.insert(storeProductAttrValue).values({ id: 401, productId: 100, unique: 'child001', stock: 8, price: '9.50', settlePrice: '2.00', diskInfo: 'child private bytes' });
  await db.insert(storeCart).values([
    { id: 206, uid: 4, productId: 100, productAttrUnique: 'child001', status: 7, isPay: 1, isDel: 1 },
    { id: 207, uid: 5, productId: 10, productAttrUnique: 'stock001', status: -2, isNew: 1 },
  ]);
  await db.insert(storeProductRelation).values({ id: 203, productId: 100, type: 2, relationId: 77, status: 3 });
  await db.insert(systemLog).values({ id: 2, storeId: 9, merchantId: 8, adminName: '历史管理员', ip: '127.0.0.2', adminId: 100, path: 'product/product/10', page: '历史回收', method: 'DELETE', type: 'legacy_delete', action: 'immutable historical audit', addTime: 101 });
  await db.insert(storeOrderOutbox).values({ id: 1, eventKey: 'prior-product-event', aggregateType: 'product', aggregateId: 10, eventType: 'product.stock.effects', payload: { productId: 10, auditId: 2, warning: false }, addTime: 101, updateTime: 102 });
  const claims = [
    { id: 169, type: 1, authType: 2, apiUrl: 'product/product/<id>', methods: 'DELETE', menuPath: '', uniqueAuth: '' },
    { id: 620, type: 1, authType: 2, apiUrl: 'product/product/<id>', methods: 'GET', menuPath: '', uniqueAuth: '' },
    { id: 1510, type: 1, authType: 2, apiUrl: 'product/product/<id>', methods: 'DELETE', menuPath: '', uniqueAuth: '' },
    { id: 1511, type: 1, authType: 2, apiUrl: 'product/product/<id>', methods: 'GET', menuPath: '', uniqueAuth: 'product.manage' },
    { id: 1512, type: 1, authType: 2, apiUrl: 'home/header', methods: 'GET', menuPath: '/adminproduct/product/<id>', uniqueAuth: 'product.manage' },
    { id: 1513, type: 2, authType: 2, apiUrl: 'product/product/<id>', methods: 'DELETE', menuPath: '', uniqueAuth: 'product.manage' },
    { id: 1514, type: 1, authType: 1, apiUrl: 'product/product/<id>', methods: 'DELETE', menuPath: '', uniqueAuth: 'product.manage' },
  ];
  await db.insert(systemMenus).values(claims);
  await db.insert(systemRole).values(claims.map((row, index) => ({ id: 1500 + index, rules: String(row.id) })));
  await db.insert(systemAdmin).values(claims.map((_, index) => ({ id: 200 + index, account: `recycle-${200 + index}`, pwd: 'stock-fixture-password', level: 1, roles: String(1500 + index) })));
}
export async function recycleFixture(effects?: AdminProductRecycleEffects) {
  const f = await financePostgres(Object.values(recycleSchema), { namespace: 'public' });
  await seedRecycle(f.db); await resetStockSequences(f.exec);
  const container = createContainerFromDb(f.db);
  return { ...f, container, service: new AdminProductRecycleService(container, effects) };
}
