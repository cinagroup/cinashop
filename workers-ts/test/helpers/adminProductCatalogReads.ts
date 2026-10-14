import { eq, getTableName } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductCategory, storeProductRelation,
  systemAdmin, systemRole, systemMenus, systemConfig, systemStore, systemSupplier, storeVisit,
  userRelation } from '@/models/schema';
import { AdminProductCatalogReadService } from '@/services/admin/AdminProductCatalogReadService';
import { fictitiousSchema, seedFictitiousReplies, fictitiousActor, fictitiousAttachment } from './adminProductFictitiousReplies';
import { financePostgres } from './financePostgres';

export const catalogReadSchema = { ...fictitiousSchema, systemStore, systemSupplier, storeVisit };
export const catalogReadActor = (id = 120) => fictitiousActor(id);
export const catalogReadMenus = [
  { id: 108, type: 1, authType: 2, apiUrl: 'product/product', methods: 'GET', menuPath: '/admin/product/product', uniqueAuth: 'product-product-index' },
  { id: 192, type: 1, authType: 2, apiUrl: 'product/product/type_header', methods: 'GET', menuPath: '/adminproduct/product/type_header', uniqueAuth: '' },
] as const;
export const catalogReadPageMenu = { id: 2, type: 1, authType: 1, apiUrl: '', methods: '',
  menuPath: '/admin/product/product_list', uniqueAuth: 'admin-store-storeProuduct-index' } as const;
export const catalogReadHeaderNames = ['销售中', '仓库中', '已售罄', '库存预警', '回收站', '待审核', '审核未通过', '强制下架'];
export const catalogReadHeaderTypes = [1, 2, 4, 5, 6, 0, -1, -2];
export const catalogReadDefaultIds = [10, 12, 13, 14, 20, 21, 26, 27, 30];
export const catalogReadStateIds = new Map<number, number[]>([
  [1, catalogReadDefaultIds], [2, [11]], [3, [10, 11, 12, 13, 14, 20, 21, 26, 27, 30]],
  [4, [12, 13]], [5, [14]], [6, [16, 17, 18]], [0, [15]], [-1, [16]], [-2, [17]], [7, [11, 16, 17, 18]],
]);

/** This deliberately differs from the selector fixture: roots include pending,
 * rejected, forced-off/deleted records and SKU/main-stock disagreement. */
export async function seedCatalogReads(db: DbClient) {
  await seedFictitiousReplies(db);
  await db.delete(storeProductRelation); await db.delete(storeProductCategory);
  await db.delete(storeProductAttrValue); await db.delete(storeProduct);
  await db.insert(systemMenus).values([...catalogReadMenus, catalogReadPageMenu,
    { ...catalogReadPageMenu, id: 996 },
    { ...catalogReadMenus[0], id: 998 }, { ...catalogReadMenus[1], id: 997 }]);
  const rules = ['product.view', '108', '192', '998', '997', '579', '580', 'reply.view', 'product.manage', '2', '996'];
  await db.insert(systemRole).values(rules.map((rule, index) => ({ id: 20 + index, rules: rule })));
  await db.insert(systemAdmin).values(rules.map((_rule, index) => ({ id: 120 + index,
    account: `catalog-read-${index}`, pwd: 'reply-fixture-password', level: 1, roles: String(20 + index) })));
  await db.insert(systemConfig).values({ id: 20, menuName: 'store_stock', value: '2' });
  const normal = { isVerify: 1, stock: 9, price: '12.00', storeName: '商品',
    image: 'https://fixture.invalid/catalog.png', sliderImage: '["/uploads/one.png"]' };
  await db.insert(storeProduct).values([
    { ...normal, id: 10, storeName: '平台保温杯', keyword: '钢材关键词', storeInfo: '简介搜索',
      cateId: '2', collect: 999, sales: 7, ficti: 900, sort: 50, barCode: 'main-code', brandId: 5,
      customForm: '{"named":"历史对象表单"}', specs: '{"parameter":"历史对象参数"}' },
    { ...normal, id: 20, type: 2, relationId: 20, storeName: '供应商保温杯', cateId: '2', sort: 20, sales: 3 },
    { ...normal, id: 30, type: 1, relationId: 30, storeName: '门店商品', cateId: '3', sales: 4 },
    { ...normal, id: 11, isShow: 0, storeName: '仓库商品' },
    { ...normal, id: 12, isSold: 1, storeName: '售罄标记正库存' },
    { ...normal, id: 13, stock: 0, storeName: '主表零库存 SKU有货' },
    { ...normal, id: 14, stock: 100, isPolices: 1, storeName: '高库存预警仍匹配' },
    { ...normal, id: 15, isVerify: 0, storeName: '待审核', cateId: '2' },
    { ...normal, id: 16, isVerify: -1, isDel: 1, storeName: '已删除审核未通过' },
    { ...normal, id: 17, isVerify: -2, isDel: 1, storeName: '已删除强制下架' },
    { ...normal, id: 18, isDel: 1, storeName: '已审核回收站' },
    { ...normal, id: 19, pid: 10, type: 2, relationId: 20, storeName: '供应商副本', cateId: '2', sales: 8 },
    { ...normal, id: 21, storeName: '无规格保留NULL' },
    { ...normal, id: 26, type: 2, relationId: 26, storeName: '已删除供应商身份不阻止目录记录' },
    { ...normal, id: 27, type: 1, relationId: 40, storeName: '已删除门店身份不阻止目录记录' },
  ]);
  await db.insert(storeProductAttrValue).values([
    { id: 72, productId: 10, unique: 'catalog1', suk: '普通蓝', stock: 9, type: 0, settlePrice: '6.00' },
    { id: 73, productId: 10, unique: 'retired1', suk: '历史退役', stock: 2, type: 0, isRetired: 1, retiredAt: 100, retiredBy: 101 },
    { id: 74, productId: 10, unique: 'active01', suk: '活动', stock: 500, type: 1, barCode: 'activity-code' },
    { id: 75, productId: 20, unique: 'supfirst', stock: 7, type: 0, settlePrice: '3.00' },
    { id: 76, productId: 20, unique: 'suplast1', stock: 1, type: 0, settlePrice: '8.00' },
    { id: 77, productId: 30, unique: 'storesku', stock: 4, type: 0 },
    { id: 78, productId: 13, unique: 'mainzero', stock: 5, type: 0 },
    // The approved Supplier copy is a legal source catalogue record. A
    // nonpositive product settle_price invokes getSkuArray on this product
    // too; omitting its ordinary SKU would exercise PHP min([]) corruption.
    { id: 79, productId: 19, unique: 'copy-019', stock: 2, type: 0, settlePrice: '4.00' },
  ]);
  await db.insert(storeProductCategory).values([
    { id: 1, cateName: '根分类', isShow: 1 },
    { id: 2, pid: 1, cateName: '子分类', path: '1', level: 1 },
    { id: 3, pid: 4, cateName: '隐藏孩子仍可显示', path: '4', level: 1, isShow: 0 },
    { id: 4, cateName: '隐藏父级不显示', isShow: 0 },
  ]);
  await db.insert(storeProductRelation).values([
    ...[10, 20, 15, 19].map((productId, index) => ({ id: index + 1, type: 1, productId, relationId: 2, relationPid: 1 })),
    { id: 5, type: 1, productId: 30, relationId: 3, relationPid: 4 },
    { id: 6, type: 2, productId: 10, relationId: 5 },
    { id: 7, type: 3, productId: 20, relationId: 6 },
  ]);
  await db.insert(systemSupplier).values([
    { id: 20, adminId: 920, supplierName: '源供应商名称', isShow: 1 },
    { id: 26, adminId: 926, supplierName: '删除名称不显示', isDel: 1 },
  ]);
  await db.insert(systemStore).values([
    { id: 30, name: '源门店名称', isShow: 1 }, { id: 40, name: '删除门店名称不显示', isDel: 1 },
  ]);
  await db.insert(userRelation).values([
    { id: 10, uid: 1, relationId: 10, type: 'collect', category: 'product' },
    { id: 11, uid: 2, relationId: 10, type: 'collect', category: 'product' },
    { id: 12, uid: 1, relationId: 10, type: 'like', category: 'product' },
    { id: 13, uid: 1, relationId: 10, type: 'collect', category: 'seckill' },
  ]);
  await db.insert(storeVisit).values([
    { id: 1, productId: 10, productType: 'product', uid: 1, count: 999 },
    { id: 2, productId: 10, productType: 'product', uid: 2, count: 2 },
    { id: 3, productId: 10, productType: 'seckill', uid: 1, count: 900 },
  ]);
}

export async function seedCatalogPrivatePictures(db: DbClient) {
  const { systemAttachment } = await import('@/models/schema');
  await db.insert(systemAttachment).values({ ...fictitiousAttachment(41), type: 4, relationId: 20,
    name: 'attachments/supplier/20/2026/10/catalog-41.png' });
  await db.update(storeProduct).set({ image: '/api/assets/31', sliderImage: '["/api/assets/31","https://external.invalid/api/assets/31"]' }).where(eq(storeProduct.id, 10));
  await db.update(storeProduct).set({ image: '/api/assets/41', sliderImage: '["/api/assets/41"]' }).where(eq(storeProduct.id, 20));
  await db.update(storeProduct).set({ image: '/api/assets/31', sliderImage: '["/api/assets/31"]' }).where(eq(storeProduct.id, 30));
}
export async function catalogReadFixture(appKey?: string) {
  const f = await financePostgres(Object.values(catalogReadSchema), { namespace: 'public' });
  await seedCatalogReads(f.db); const container = createContainerFromDb(f.db);
  return { ...f, container, service: new AdminProductCatalogReadService(container, appKey) };
}

/** All fixture tables and every persisted column; no selectively ignored
 * timestamps, counters, identity rows, order evidence or audit columns. */
export async function catalogReadSnapshot(db: DbClient) {
  const rows: Record<string, unknown[]> = {};
  for (const [name, table] of Object.entries(catalogReadSchema)) {
    const value = await db.select().from(table);
    rows[name] = [...value].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return rows;
}

/** Timing-only test boundary. Every selected row still comes from its actual
 * PostgreSQL query. Pause after the first main-table count completes, while
 * the real production transaction and its native snapshot remain open. */
export function pauseCatalogCount(db: DbClient, paused: () => Promise<void>): DbClient {
  let seen = false;
  const wrap = (builder: object): object => new Proxy(builder, { get(target, property) {
    if (property === 'then') return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(target).then(async value => { if (!seen) { seen = true; await paused(); } return value; }).then(resolve, reject);
    const value: unknown = Reflect.get(target, property);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => { const next: unknown = Reflect.apply(value, target, args); return next && typeof next === 'object' ? wrap(next) : next; };
  } });
  const transaction = (tx: DbClient): DbClient => new Proxy(tx, { get(target, property) {
    const value: unknown = Reflect.get(target, property);
    if (property === 'select') return (...args: unknown[]) => {
      const selection = Reflect.apply(value as (...args: unknown[]) => object, target, args);
      return new Proxy(selection, { get(builder, method) {
        const call: unknown = Reflect.get(builder, method);
        if (method === 'from') return (table: Parameters<typeof getTableName>[0]) => {
          const query = Reflect.apply(call as (table: unknown) => object, builder, [table]);
          return getTableName(table) === 'store_product' ? wrap(query) : query;
        };
        return typeof call === 'function' ? call.bind(builder) : call;
      } });
    };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return new Proxy(db, { get(target, property) {
    const value: unknown = Reflect.get(target, property);
    if (property === 'transaction') return (work: (tx: DbClient) => Promise<unknown>, ...options: unknown[]) =>
      Reflect.apply(value as (...args: unknown[]) => unknown, target, [(tx: DbClient) => work(transaction(tx)), ...options]);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
