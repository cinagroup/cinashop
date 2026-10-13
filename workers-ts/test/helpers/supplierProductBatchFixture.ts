import { storeProduct, storeProductCategory, storeProductRelation, storeProductAttr, storeProductAttrResult, storeProductAttrValue,
  storeProductDescription, storeProductStockRecord, storeCart, systemAdmin, systemSupplier, systemRole, systemMenus, systemLog,
  systemForm, shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery,
  storeSeckill, storeBargain, storeCombination, storeIntegral, storeDiscountsProducts } from '../../src/models/schema';
import { md5 } from '../../src/utils/jwt';
import type { financePostgres } from './financePostgres';

export const supplierBatchTables = [storeProduct, storeProductCategory, storeProductRelation, storeProductAttr, storeProductAttrResult,
  storeProductAttrValue, storeProductDescription, storeProductStockRecord, storeCart, systemAdmin, systemSupplier, systemRole, systemMenus,
  systemLog, systemForm, shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery,
  storeSeckill, storeBargain, storeCombination, storeIntegral, storeDiscountsProducts];
export const supplierBatchActor = () => ({ id: 21, authVersion: md5(''), expiresAt: Math.floor(Date.now() / 1000) + 300 });
export async function seedSupplierBatch(f: Awaited<ReturnType<typeof financePostgres>>) {
  await f.reset();
  await f.db.insert(systemSupplier).values([{ id: 20, adminId: 29, supplierName: 'current' }, { id: 30, adminId: 39, supplierName: 'other' }]);
  await f.db.insert(systemRole).values([{ id: 21, type: 4, relationId: 20, rules: 'supplier.product.manage' },
    { id: 22, type: 4, relationId: 20, rules: 'supplier.product.view' }, { id: 31, type: 4, relationId: 30, rules: 'supplier.product.manage' }]);
  await f.db.insert(systemAdmin).values([{ id: 21, account: 'batch-manager', adminType: 4, relationId: 20, roles: '21', level: 1 },
    { id: 22, account: 'batch-reader', adminType: 4, relationId: 20, roles: '22', level: 1 },
    { id: 31, account: 'batch-other', adminType: 4, relationId: 30, roles: '31', level: 1 }]);
  await f.db.insert(storeProductCategory).values([{ id: 100, type: 2, relationId: 20, cateName: 'root' },
    { id: 101, type: 2, relationId: 20, cateName: 'child', pid: 100, path: '100', level: 1 },
    { id: 102, type: 2, relationId: 20, cateName: 'grandchild', pid: 101, path: '100,101', level: 2 },
    { id: 110, type: 2, relationId: 20, cateName: 'target' }, { id: 120, type: 2, relationId: 20, cateName: 'hidden', isShow: 0 },
    { id: 200, type: 2, relationId: 30, cateName: 'foreign' }, { id: 300, type: 0, relationId: 0, cateName: 'platform' }]);
  await f.db.insert(storeProduct).values([{ id: 1, type: 2, relationId: 20, storeName: 'physical-alpha', cateId: '101', deliveryType: '1',
    isShow: 1, isVerify: 1, freight: 1, stock: 8, price: '12.00', sales: 3, keyword: 'needle', brandId: 501, addTime: 1786200000 },
    { id: 2, type: 2, relationId: 20, storeName: 'physical-beta', cateId: '102', deliveryType: '1', isShow: 0, isVerify: 1, freight: 1, stock: 7, price: '19.00' },
    { id: 3, type: 2, relationId: 20, productType: 1, storeName: 'card' }, { id: 4, type: 2, relationId: 20, productType: 3, storeName: 'manual' },
    { id: 5, type: 2, relationId: 20, productType: 2, storeName: 'unsupported' }, { id: 6, type: 2, relationId: 20, isDel: 1, storeName: 'recycled' },
    { id: 7, type: 2, relationId: 30, storeName: 'physical-foreign', freight: 1 }, { id: 8, type: 0, relationId: 0, storeName: 'physical-platform' },
    { id: 9, type: 1, relationId: 20, storeName: 'physical-store' }]);
  await f.db.insert(storeProductRelation).values([{ id: 1, productId: 1, type: 1, relationId: 101, relationPid: 100, status: 1 },
    { id: 2, productId: 2, type: 1, relationId: 102, relationPid: 101, status: 0 }, { id: 3, productId: 1, type: 2, relationId: 501 },
    { id: 4, productId: 1, type: 3, relationId: 601 }, { id: 5, productId: 7, type: 1, relationId: 200 }]);
  await f.db.insert(storeProductAttrValue).values({ id: 1, productId: 1, unique: 'batch001', suk: '默认', stock: 8,
    sumStock: 10, sales: 3, price: '12.00', settlePrice: '10.00', barCode: 'SKUNEEDLE' });
  await f.db.insert(systemForm).values([{ id: 50, name: '留言', status: 1, value: JSON.stringify([{ id: 'note', name: 'texts', titleConfig: { value: '留言' } }]) },
    { id: 51, name: 'broken', status: 1, value: 'not-json' }, { id: 52, name: 'inactive', status: 0, value: '[]' }]);
  await f.db.insert(shippingTemplates).values([{ id: 60, name: 'own', ownerType: 2, relationId: 20 },
    { id: 61, name: 'foreign', ownerType: 2, relationId: 30 }, { id: 62, name: 'platform' },
    { id: 63, name: 'inactive', ownerType: 2, relationId: 20, status: 0 }, { id: 64, name: 'deleted', ownerType: 2, relationId: 20, isDel: 1 }]);
  await f.exec("SELECT setval('store_product_relation_id_seq',5,true)");
}
