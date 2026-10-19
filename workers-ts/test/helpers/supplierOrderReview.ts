import { eq, inArray, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { storeOrder, storeOrderCartInfo, storeOrderInvoice, systemAttachment } from '@/models/schema';
import { supplierOrderFiltersFixture } from './supplierOrderFilters';

export const supplierReviewForm = () => [
  { id: 'requirements', name: 'texts', titleConfig: { value: '收货要求' }, value: '请保留原包装\n工作日配送' },
  { id: 'date', name: 'dateranges', titleConfig: { value: '预约日期' }, value: ['2026-10-20', '2026-10-21'] },
  { id: 'photo', name: 'uploadPicture', titleConfig: { value: '客户上传凭证' }, value: ['/api/assets/31', '/api/assets/32'] },
];
export const supplierReviewLine = (quantity = 2) => ({ financial_version: 'checkout-line-finance-v1', cart_num: quantity,
  product: { id: 70, storeName: '冻结核对商品' }, sku: { suk: '冻结红色,S', code: 'FROZEN-CODE', barCode: 'FROZEN-BAR',
    price: '30.00', cost: '2.00', settlePrice: '2.50' } });

/** Synthetic owned PG only. Existing App/JWT and independent SELECT-only LOGIN;
 * Buyer/seed writes are maintenance and are not production authorization proof. */
export async function supplierOrderReviewFixture() {
  const f = await supplierOrderFiltersFixture();
  try {
    const dialect = new PgDialect();
    // Detail now reads the actual frozen invoice record, even when absent.
    // Install its real ORM shape; missing tables/permissions must not fake none.
    for (const table of [systemAttachment, storeOrderInvoice]) {
      const definition = getTableConfig(table), columns = definition.columns.map(column => {
        const value = column.default, initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public."${definition.name}" (${columns.join(',')})`);
    }
    await f.db.insert(systemAttachment).values([{ attId: 31, type: 3, relationId: 11, moduleType: 3, fileType: 1, imageType: 8,
      name: 'attachments/owned-order-review.png', attDir: '/api/assets/31', sattDir: '/api/assets/31', attType: 'image/png' },
    { attId: 32, type: 3, relationId: 12, moduleType: 3, fileType: 1, imageType: 8,
      name: 'attachments/foreign-order-review.png', attDir: '/api/assets/32', sattDir: '/api/assets/32', attType: 'image/png' }]);
    const customForm = JSON.stringify(supplierReviewForm());
    await f.db.update(storeOrder).set({ realName: '冻结收货人', userPhone: '13800138000',
      userAddress: '冻结省市区地址 旧小区12号', mark: '买家冻结备注：请勿放驿站', remark: '供应商内部备注',
      totalNum: 2, totalPrice: '60.00', totalPostage: '3.00', payPostage: '3.00', payPrice: '63.00',
      cost: '4.00', customForm }).where(inArray(storeOrder.id, [100, 200]));
    await f.db.update(storeOrderCartInfo).set({ cartNum: 2, settlePrice: '2.50', cartInfo: JSON.stringify(supplierReviewLine()) }).where(eq(storeOrderCartInfo.id, 1001));
    await f.db.update(storeOrder).set({ totalNum: 2, totalPostage: '0.00', payPostage: '0.00' }).where(eq(storeOrder.id, 111));
    await f.db.insert(storeOrderCartInfo).values({ id: 1111, oid: 111, uid: 11, type: 2, relationId: 7, productId: 70,
      skuUnique: 'tracksku', cartId: '1111', cartNum: 2, settlePrice: '0.00', cartInfo: JSON.stringify({
        financial_version: 'checkout-line-finance-v1', cart_num: 2, product: { id: 70, storeName: '现代零结算商品' },
        sku: { suk: '默认', price: '0.00' } }) });
    await f.db.insert(storeOrderCartInfo).values([200, 201, 202, 301].map((id, index) => ({ id: 2001 + index, oid: id, uid: 11,
      type: 2, relationId: 7, productId: 70, skuUnique: 'tracksku', cartId: String(2001 + index),
      cartNum: id === 200 ? 2 : 1, settlePrice: '2.50', cartInfo: JSON.stringify(supplierReviewLine(999)) })));
    await f.db.update(storeOrder).set({ customForm, realName: '冻结子单收货人', userAddress: '冻结子单地址',
      totalNum: 1, totalPrice: '30.00', totalPostage: '1.50', payPostage: '1.50', payPrice: '31.50' })
      .where(inArray(storeOrder.id, [201, 202, 301]));
    const r2Reads: string[] = [], png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    Object.assign(f.env, { ASSETS_BUCKET: { get: async (key: string) => {
      r2Reads.push(key); if (key !== 'attachments/owned-order-review.png') return null;
      return { body: png, size: png.length, etag: 'owned-order-review-image', httpEtag: '"owned-order-review-image"',
        httpMetadata: { contentType: 'image/png' }, writeHttpMetadata: (headers: Headers) => { headers.set('Content-Type', 'image/png'); } };
    } } });
    const grantReviewReader = async (role: string) => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Unowned order review LOGIN');
      await f.grantReader(role); await f.exec(`GRANT SELECT ON public.system_attachment,public.store_order_invoice TO "${role}"`);
    };
    type Peer = Parameters<Parameters<typeof f.withReader>[0]>[0];
    const withReader = <T>(work: (peer: Peer) => Promise<T>) => f.withReader(async peer => { await grantReviewReader(peer.role); return work(peer); });
    return { ...f, withReader, grantReviewReader, r2Reads,
      images: { owned: 31, foreign: 32, ownedPath: '/api/assets/31', ownedKey: 'attachments/owned-order-review.png' },
      expectedReview: { name: '冻结收货人', address: '冻结省市区地址 旧小区12号', mark: '买家冻结备注：请勿放驿站',
        quantity: 2, settlementUnit: '2.50', itemsTotal: '5.00', postage: '3.00', total: '8.00', payPrice: '63.00' } };
  } catch (error) { await f.close(); throw error; }
}
