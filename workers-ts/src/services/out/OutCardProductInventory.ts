import { and, asc, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrResult, storeProductAttrValue, storeProductStockRecord, storeProductVirtual } from '@/models/schema';
import type { SupplierProductSku } from '@/services/product/ProductSkuInput';
import { VirtualProductInventoryService, virtualInventoryCardUnique } from '@/services/product/VirtualProductInventoryService';
import { md5 } from '@/utils/jwt';
import { ValidateException } from '@/utils/errors';
import type { OutCardImport } from './OutCardProductInput';

type Product = typeof storeProduct.$inferSelect;
type Sku = typeof storeProductAttrValue.$inferSelect;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fail(): never { throw new ValidateException('卡密商品库存、规则或交付记录已变化，请核对后重试'); }

async function cards(tx: DbClient, id: number) {
  const rows = await tx.select({ id: storeProductVirtual.id, productId: storeProductVirtual.productId,
    attrUnique: storeProductVirtual.attrUnique, cardUnique: storeProductVirtual.cardUnique,
    storeId: storeProductVirtual.storeId, orderId: storeProductVirtual.orderId, orderType: storeProductVirtual.orderType,
    uid: storeProductVirtual.uid,
    payloadDigest: sql<string>`md5(octet_length(${storeProductVirtual.cardNo})::text || ':' || ${storeProductVirtual.cardNo}
      || octet_length(${storeProductVirtual.cardPwd})::text || ':' || ${storeProductVirtual.cardPwd})` })
    .from(storeProductVirtual).where(eq(storeProductVirtual.productId, id)).orderBy(asc(storeProductVirtual.id)).limit(10001);
  if (rows.length > 10000) throw new ValidateException('商品卡密记录超过10000项，请先使用库存管理核对');
  return rows;
}
type Card = Awaited<ReturnType<typeof cards>>[number];
async function skus(tx: DbClient, id: number) {
  return tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0)))
    .orderBy(asc(storeProductAttrValue.id));
}
async function records(tx: DbClient, id: number) {
  const rows = await tx.select().from(storeProductStockRecord).where(eq(storeProductStockRecord.productId, id))
    .orderBy(asc(storeProductStockRecord.id)).limit(10001);
  if (rows.length > 10000) throw new ValidateException('商品库存流水超过10000项，请先核对');
  return rows;
}

/** The coordinator holds the virtual-inventory advisory lock and virtual-inventory table
 * barrier. Read only identities/digests; ordinary Out responses never receive credentials. */
export async function admitOutCardProduct(tx: DbClient, product: Product | undefined, current: Sku[], desired: SupplierProductSku[]) {
  if (!product) return [] as Card[];
  const rows = await cards(tx, product.id), bySuk = new Map(current.map(row => [row.suk, row]));
  const active = new Set(current.map(row => row.unique));
  if (rows.some(row => !active.has(row.attrUnique) || row.storeId !== 0) || product.stock !== current.reduce((sum, row) => sum + row.stock, 0)) fail();
  for (const sku of desired) {
    const old = bySuk.get(sku.suk); if (!old) fail();
    const owned = rows.filter(row => row.attrUnique === old.unique);
    if (old.diskInfo?.trim() ? owned.length > 0 : old.stock !== owned.filter(row => row.uid === 0).length) fail();
    if (sku.diskInfo && owned.length) throw new ValidateException('已有卡密的SKU不能切换为固定内容');
    if (!sku.diskInfo && old.diskInfo?.trim() && old.stock !== 0) throw new ValidateException('固定内容SKU须先清空库存才能切换为一次性卡密');
  }
  return rows;
}

export async function finalizeOutCardProduct(tx: DbClient, productId: number, baseline: Card[], current: Sku[],
  assigned: SupplierProductSku[], imports: OutCardImport[], fallbackImage: string, startingStock: number, now: number) {
  const [beforeProduct] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
  const beforeSkus = await skus(tx, productId), beforeRecords = await records(tx, productId);
  if (!beforeProduct || beforeProduct.type !== 0 || beforeProduct.relationId !== 0 || beforeProduct.productType !== 1 ||
    beforeProduct.deliveryType !== '' || beforeProduct.freight !== 2 || beforeProduct.tempId !== 0 || beforeProduct.postage !== '0.00' ||
    beforeProduct.isPostage !== 0 || beforeProduct.stock !== startingStock || (!current.length && beforeRecords.length > 0) || !same(await cards(tx, productId), baseline) ||
    beforeSkus.length !== assigned.length) fail();
  for (const sku of assigned) {
    const row = beforeSkus.find(value => value.unique === sku.unique), old = current.find(value => value.unique === sku.unique);
    if (!row || row.productType !== 1 || row.isRetired !== 0 || row.suk !== sku.suk || row.stock !== sku.stock ||
      row.sumStock !== (old?.sumStock ?? sku.stock) || row.sales !== (old?.sales ?? 0) ||
      row.diskInfo !== sku.diskInfo || row.image !== (sku.image || fallbackImage.slice(0, 128)) ||
      (['price', 'settlePrice', 'cost', 'otPrice', 'vipPrice', 'barCode', 'weight', 'volume', 'brokerage', 'brokerageTwo', 'code'] as const)
        .some(key => row[key] !== sku[key])) fail();
  }
  const inventory = new VirtualProductInventoryService(createContainerFromDb(tx));
  const added = new Map<string, number>();
  for (const item of imports) {
    const sku = assigned.find(row => row.suk === item.suk); if (!sku?.unique || sku.diskInfo) fail();
    const result = await inventory.importCardsInTransaction(tx, { kind: 'admin' }, productId, { attr_unique: sku.unique, cards: item.cards }, { now });
    added.set(sku.unique, result.inserted);
  }
  const afterCards = await cards(tx, productId), afterSkus = await skus(tx, productId), afterRecords = await records(tx, productId);
  const oldCards = new Map(baseline.map(row => [row.id, row]));
  if (baseline.some(old => !same(afterCards.find(row => row.id === old.id), old))) fail();
  const proposed = imports.flatMap(item => {
    const unique = assigned.find(row => row.suk === item.suk)!.unique!;
    return item.cards.map(card => ({ unique, cardUnique: virtualInventoryCardUnique(unique, card),
      digest: md5(`${new TextEncoder().encode(card.cardNo).length}:${card.cardNo}${new TextEncoder().encode(card.cardPwd).length}:${card.cardPwd}`) }));
  });
  if (proposed.some(card => afterCards.filter(row => row.attrUnique === card.unique && row.cardUnique === card.cardUnique && row.payloadDigest === card.digest).length !== 1)) fail();
  const inserted = afterCards.filter(row => !oldCards.has(row.id));
  if (inserted.some(row => row.uid !== 0 || row.storeId !== 0 || row.orderId !== '' || row.orderType !== 1 ||
    !proposed.some(card => card.unique === row.attrUnique && card.cardUnique === row.cardUnique && card.digest === row.payloadDigest)) ||
    inserted.length !== [...added.values()].reduce((sum, value) => sum + value, 0)) fail();
  const expectedSkus = beforeSkus.map(row => ({ ...row, stock: row.stock + (added.get(row.unique) ?? 0), sumStock: row.sumStock + (added.get(row.unique) ?? 0) }));
  if (!same(afterSkus, expectedSkus) || afterSkus.some(row => !row.diskInfo && row.stock !== afterCards.filter(card => card.attrUnique === row.unique && card.uid === 0).length)) fail();
  const oldRecordIds = new Set(beforeRecords.map(row => row.id)), newRecords = afterRecords.filter(row => !oldRecordIds.has(row.id));
  if (beforeRecords.some(old => !same(afterRecords.find(row => row.id === old.id), old)) || newRecords.length !== [...added.values()].filter(value => value > 0).length ||
    newRecords.some(row => row.storeId !== 0 || row.pm !== 1 || row.addTime !== now || row.number !== added.get(row.unique) ||
      row.costPrice !== assigned.find(sku => sku.unique === row.unique)?.cost)) fail();
  const stock = startingStock + inserted.length;
  const expectedProduct = { ...beforeProduct, stock, isSold: stock > 0 ? 0 : 1 };
  const [afterProduct] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
  if (!same(afterProduct, expectedProduct)) fail();
  for (const sku of assigned) sku.stock += added.get(sku.unique!) ?? 0;
  return { stock, changed: inserted.length > 0, assert: async (snapshot: string) => {
    const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
    const results = await tx.select({ result: storeProductAttrResult.result }).from(storeProductAttrResult)
      .where(and(eq(storeProductAttrResult.productId, productId), eq(storeProductAttrResult.type, 0)));
    if (!same(product, expectedProduct) || !same(await skus(tx, productId), expectedSkus) || !same(await cards(tx, productId), afterCards) ||
      !same(await records(tx, productId), afterRecords) || results.length !== 1 || results[0].result !== snapshot) fail();
  } };
}
