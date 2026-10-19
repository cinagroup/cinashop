import { eq, inArray, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { storeOrder, storeOrderCartInfo, storeProductVirtual } from '@/models/schema';
import type { SupplierVirtualEntry, SupplierVirtualReview } from '@/services/supplier/SupplierOrderVirtualReview';
import { supplierOrderGiftIdentityFixture } from './supplierOrderGiftIdentity';

/** Synthetic owned presentation data. Actual registered checkout/delivery and
 * authenticated Customer comparison are separately exercised in the native. */
export async function supplierOrderVirtualReviewFixture() {
  const f = await supplierOrderGiftIdentityFixture();
  try {
    const dialect = new PgDialect(), definition = getTableConfig(storeProductVirtual);
    const columns = definition.columns.map(column => {
      const value = column.default, initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL
        ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
      return `"${column.name}" ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
    });
    await f.exec(`CREATE TABLE public."${definition.name}" (${columns.join(',')})`);
    // PHP's payment job sends the first cart SKU for total_num. Keep its two
    // historical examples single-cart/SKU; only modern100 exercises multi-SKU.
    await f.db.delete(storeOrderCartInfo).where(inArray(storeOrderCartInfo.id, [f.giftIds.legacyGift, f.giftIds.firstGift]));
    await f.db.update(storeOrder).set({ totalNum: 1 }).where(inArray(storeOrder.id, [301, 201]));
    const expectedVirtual = new Map<number, SupplierVirtualReview>(); let cardId = 10001;
    const content = { modern: '冻结固定内容\n下载地址仅作文本：https://example.invalid/local\n  原始尾部空白  ', legacy: '旧固定密钥\n保留旧记录空白  ' };
    for (const [id, mode] of [[100, 'modern_cards'], [201, 'legacy_cards'], [301, 'legacy_content'], [111, 'modern_content']] as const) {
      const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, id));
      const carts = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(storeOrderCartInfo.id);
      const entries: SupplierVirtualEntry[] = [], payload: object[] = [], legacy = mode.startsWith('legacy');
      for (const cart of carts) {
        const previous = JSON.parse(cart.cartInfo!), previousProduct = previous.product ?? previous.productInfo;
        const previousSku = previous.sku ?? previous.productInfo?.attrInfo;
        const labels = { product_id: cart.productId, sku_unique: cart.skuUnique,
          product_name: previousProduct?.storeName ?? previousProduct?.store_name ?? '商品快照', sku: previousSku?.suk ?? cart.skuUnique };
        const disk = mode.endsWith('content') ? legacy ? content.legacy : content.modern.trim() : '';
        const attr = { ...(previousSku ?? {}), disk_info: disk };
        const snapshot = legacy ? { cart_num: cart.cartNum,
          productInfo: { id: cart.productId, store_name: labels.product_name, attrInfo: attr }, attrInfo: { ...attr } }
          : { ...previous, sku: attr };
        await f.db.update(storeOrderCartInfo).set({ productType: 1, cartInfo: JSON.stringify(snapshot) }).where(eq(storeOrderCartInfo.id, cart.id));
        if (mode.endsWith('content')) {
          entries.push({ kind: 'content', ...labels, quantity: cart.cartNum, content: legacy ? '密钥自动发放：' + disk : disk });
          payload.push({ disk_info: disk, product_id: cart.productId, sku_unique: cart.skuUnique, quantity: cart.cartNum });
        } else for (let index = 0; index < cart.cartNum; index++) {
          const cardNo = index === 0 ? '' : `CARD-${id}-${cart.id}-${index}`;
          const cardPwd = `  PASSWORD-${id}-${cart.id}-${index}\n`;
          await f.db.insert(storeProductVirtual).values({ id: cardId++, productId: cart.productId,
            attrUnique: cart.skuUnique, cardNo, cardPwd, uid: order.uid, orderType: 1, orderId: order.orderId });
          entries.push({ kind: 'card', ...labels, quantity: 1, card_no: cardNo, card_pwd: cardPwd });
          payload.push(legacy ? { card_no: cardNo, card_pwd: cardPwd }
            : { card_no: cardNo, card_pwd: cardPwd, product_id: cart.productId, sku_unique: cart.skuUnique });
        }
      }
      const virtualInfo = mode === 'legacy_content' ? JSON.stringify(entries[0].kind === 'content' ? entries[0].content : '') : JSON.stringify(payload);
      await f.db.update(storeOrder).set({ productType: 1, paid: 1, status: 1, deliveryType: 'fictitious', virtualInfo,
        fictitiousContent: '卡密已自动发放，请在订单详情中查看', deliveryName: '', deliveryCode: '', deliveryId: '' }).where(eq(storeOrder.id, id));
      expectedVirtual.set(id, { order_id: id, state: 'recorded', basis: legacy ? 'php_legacy' : 'modern', reason: '', entries });
    }
    await f.db.update(storeOrder).set({ productType: 1, paid: 1, status: 0, deliveryType: '', virtualInfo: '"UNDELIVERED-PRIVATE"' }).where(eq(storeOrder.id, 202));
    await f.db.update(storeOrder).set({ productType: 1, virtualInfo: '"ROOT-PRIVATE"' }).where(eq(storeOrder.id, 200));
    const hiddenCarts = await f.db.select().from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid, [200, 202]));
    for (const cart of hiddenCarts) {
      const snapshot = JSON.parse(cart.cartInfo!); snapshot.sku = { ...snapshot.sku, disk_info: 'UNDELIVERED-OR-ROOT-PRIVATE' };
      await f.db.update(storeOrderCartInfo).set({ productType: 1, cartInfo: JSON.stringify(snapshot) }).where(eq(storeOrderCartInfo.id, cart.id));
    }
    const grantVirtualReader = async (role: string) => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Unowned virtual review reader');
      await f.grantGiftReader(role); await f.exec(`GRANT SELECT ON public.store_product_virtual TO "${role}"`);
    };
    type Peer = Parameters<Parameters<typeof f.withReader>[0]>[0];
    const withReader = <T>(work: (peer: Peer) => Promise<T>) => f.withReader(async peer => { await grantVirtualReader(peer.role); return work(peer); });
    return { ...f, withReader, grantVirtualReader, expectedVirtual, virtualContent: content,
      virtualIds: { modernCards: 100, legacyCards: 201, legacyContent: 301, modernContent: 111, pending: 202, summary: 200 } };
  } catch (error) { await f.close(); throw error; }
}
