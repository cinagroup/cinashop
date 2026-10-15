import { eq } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductStockRecord, storeOrder, storeOrderCartInfo, storeOrderOutbox,
  systemAdmin, systemRole, systemMenus, systemLog, systemConfig, systemAttachment } from '@/models/schema';
import { AdminProductStockService } from '@/services/admin/AdminProductStockService';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './financePostgres';

export const stockSchema = { storeProduct, storeProductAttrValue, storeProductStockRecord, storeOrder, storeOrderCartInfo, storeOrderOutbox,
  systemAdmin, systemRole, systemMenus, systemLog, systemConfig, systemAttachment };
export const stockActor = (id = 101) => ({ id, authVersion: md5('stock-fixture-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
export const stockBody = (stock = 3, pm: 0 | 1 = 1, unique = 'stock001') => ({ attrs: [{ unique, stock, pm }] });
export async function seedStocks(db: DbClient) {
  await db.insert(systemRole).values([
    { id: 1, rules: 'product.manage' }, { id: 2, rules: 'product.view' }, { id: 3, rules: 'reply.manage' },
    { id: 4, rules: '2' }, { id: 5, rules: '999' }, { id: 6, rules: '105' }, { id: 7, rules: '193' }, { id: 8, rules: '630' },
  ]);
  await db.insert(systemAdmin).values(Array.from({ length: 10 }, (_, index) => ({ id: 100 + index, account: `stock-${100 + index}`, pwd: 'stock-fixture-password', level: index === 0 ? 0 : 1,
    roles: index > 0 && index < 9 ? String(index) : '', ...(index === 9 ? { adminType: 2, relationId: 9 } : {}) })));
  await db.insert(systemMenus).values([
    { id: 2, type: 1, authType: 1, apiUrl: '', methods: '', menuPath: '/admin/product/product_list', uniqueAuth: 'admin-store-storeProuduct-index' },
    { id: 105, type: 1, authType: 2, apiUrl: 'product/product/<id>', methods: 'POST', menuPath: '/admin/product/save', uniqueAuth: 'product-save' },
    { id: 193, type: 1, authType: 2, apiUrl: 'product/product/list', methods: 'GET', menuPath: '/adminproduct/product/list', uniqueAuth: '' },
    { id: 630, type: 1, authType: 2, apiUrl: 'product/product/attrs/<id>/<type>', methods: 'GET', menuPath: '', uniqueAuth: '' },
    // The source installer has no such one-id stock tuple. Copying this shape
    // into an arbitrary numeric row must never create a stock grant.
    { id: 999, type: 1, authType: 2, apiUrl: 'product/product/saveStocks/<id>', methods: 'PUT', menuPath: '', uniqueAuth: '' },
  ]);
  await db.insert(systemConfig).values([{ id: 1, menuName: 'store_stock', value: '3' }, { id: 2, menuName: 'erp_open', value: '0' }]);
  await db.insert(storeProduct).values([
    { id: 10, storeName: '平台库存商品', stock: 10, price: '12.00', sales: 7, specType: 1, isVerify: 1 },
    { id: 20, storeName: '供应商库存商品', type: 2, relationId: 20, stock: 20, isVerify: 1 },
    { id: 30, storeName: '门店库存商品', type: 1, relationId: 30, stock: 30, isVerify: 1 },
    { id: 40, storeName: '回收站待审核商品', isDel: 1, isVerify: 0, isShow: 0, stock: 5 },
    { id: 50, storeName: '实际卡密商品', productType: 1, stock: 5 },
    { id: 60, storeName: '异常归属商品', type: 0, relationId: 99, stock: 5 },
  ]);
  await db.insert(storeProductAttrValue).values([
    { id: 11, productId: 10, unique: 'stock001', suk: '蓝色', stock: 10, sumStock: 10, sales: 2, price: '12.00', cost: '1.25', image: '/uploads/blue.png', barCode: 'SKU条码', code: 'SKU编码', diskInfo: 'unexpected fixture secret' },
    { id: 12, productId: 10, unique: 'stock002', suk: '红色', stock: 4, sumStock: 6, price: '13.00', cost: '2.00' },
    { id: 13, productId: 10, unique: 'old00001', suk: '退役规格', stock: 2, sumStock: 2, isRetired: 1, retiredAt: 100, retiredBy: 101, retireReason: 'fixture retired' },
    { id: 14, productId: 10, unique: 'seckill1', suk: '活动规格', type: 1, stock: 0, sumStock: 0 },
    { id: 21, productId: 20, unique: 'supply01', stock: 20, sumStock: 20, cost: '3.00' },
    { id: 31, productId: 30, unique: 'stores01', stock: 30, sumStock: 30 },
    { id: 41, productId: 40, unique: 'deleted1', stock: 5, sumStock: 5 },
    { id: 51, productId: 50, unique: 'virtual1', productType: 1, stock: 5, sumStock: 5, diskInfo: 'fixture card password' },
    { id: 61, productId: 60, unique: 'malform1', stock: 5, sumStock: 5 },
    { id: 91, productId: 999, unique: 'orphan01', stock: 1, sumStock: 1, image: '/api/assets/31', diskInfo: 'orphan secret' },
  ]);
  await db.insert(storeProductStockRecord).values({ id: 1, productId: 10, unique: 'stock001', number: 1, pm: 1, addTime: 100, costPrice: '1.25' });
  await db.insert(storeOrder).values({ id: 70, uid: 1, orderId: 'stock-unrelated-order', paid: 1, status: 2, payPrice: '12.00' });
  await db.insert(storeOrderCartInfo).values({ id: 71, uid: 1, oid: 70, productId: 10, skuUnique: 'stock001', cartNum: 1 });
}
export async function resetStockSequences(exec: (sql: string) => Promise<unknown>) {
  for (const table of ['store_product_stock_record', 'system_log', 'store_order_outbox']) await exec(`SELECT setval(pg_get_serial_sequence('${table}','id'),1000,false)`);
}
export async function stockSnapshot(db: DbClient): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [name, table] of Object.entries(stockSchema)) {
    const rows = await db.select().from(table); result[name] = rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
export async function stockFixture() {
  const fixture = await financePostgres(Object.values(stockSchema), { namespace: 'public' });
  await seedStocks(fixture.db); await resetStockSequences(fixture.exec);
  const container = createContainerFromDb(fixture.db);
  return { ...fixture, container, service: new AdminProductStockService(container, 'stock-fixture-app-key') };
}
export async function stockRows(db: DbClient, product = 10) {
  const [parent] = await db.select().from(storeProduct).where(eq(storeProduct.id, product));
  const skus = await db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, product));
  return { parent, skus };
}
