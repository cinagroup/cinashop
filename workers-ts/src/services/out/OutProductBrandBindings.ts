import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeBrand, storeProduct, storeProductRelation } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { supplierProductBrandPath, supplierProductBrandPathMatches } from '@/services/supplier/SupplierProductBrandBindings';
import { assertOutProductRelationFence, type OutProductRelationFence } from './OutProductRelationFence';

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const scope = (id: number, productType: 0 | 1 | 2 | 3 | 4) => and(eq(storeProduct.id, id), eq(storeProduct.type, 0),
  eq(storeProduct.relationId, 0), eq(storeProduct.productType, productType), eq(storeProduct.isDel, 0));

export interface OutProductBrandProof {
  productId: number;
  brandId: number;
  brandCom: string;
  ids: readonly number[];
  relations: Array<typeof storeProductRelation.$inferSelect>;
  fence: OutProductRelationFence;
}

export async function replaceOutProductBrandBindings(tx: DbClient, productId: number,
  ids: readonly number[], fence: OutProductRelationFence) {
  const [product] = await tx.select().from(storeProduct).where(scope(productId, fence.productType)).limit(1);
  if (!product || product.brandId !== (ids.at(-1) ?? 0) || product.brandCom !== ids.join(','))
    throw new ValidateException('平台商品品牌写入结果已变化');
  const where = and(eq(storeProductRelation.productId, productId), eq(storeProductRelation.type, 2));
  await tx.delete(storeProductRelation).where(where);
  const now = Math.floor(Date.now() / 1000);
  const inserted = ids.length ? await tx.insert(storeProductRelation).values(ids.map(id => ({
    productId, relationId: id, relationPid: 0, type: 2, status: 1, addTime: now,
  }))).returning() : [];
  if (inserted.length !== ids.length || !same(inserted.map(row => row.relationId), ids)
    || inserted.some(row => row.productId !== productId || row.type !== 2 || row.relationPid !== 0
      || row.status !== 1 || row.addTime !== now)) throw new ValidateException('平台商品品牌关联写入结果已变化');
  const proof: OutProductBrandProof = { productId, brandId: product.brandId, brandCom: product.brandCom,
    ids: [...ids], relations: inserted, fence };
  await assertOutProductBrandBindings(tx, proof);
  return proof;
}

/** Repeat after the final ledger INSERT as well as immediately after authoring:
 * successful receipt triggers must not invalidate the evidence being committed. */
export async function assertOutProductBrandBindings(tx: DbClient, proof: OutProductBrandProof) {
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  const [read] = await tx.select().from(storeProduct).where(scope(proof.productId, proof.fence.productType)).limit(1);
  const actual = await tx.select().from(storeProductRelation).where(and(
    eq(storeProductRelation.productId, proof.productId), eq(storeProductRelation.type, 2),
  )).orderBy(asc(storeProductRelation.id));
  if (!read || read.brandId !== proof.brandId || read.brandCom !== proof.brandCom
    || !same(actual, [...proof.relations].sort((a, b) => a.id - b.id)))
    throw new ValidateException('平台商品品牌或历史关联已变化');
  await assertOutProductRelationFence(tx, proof.fence);
}

/** Reads the stored path without inferring a new path from today's catalog. */
export async function outProductBrandSelection(tx: DbClient,
  product: Pick<typeof storeProduct.$inferSelect, 'id' | 'brandId' | 'brandCom'>) {
  let ids: number[] = [], parsed = true;
  try {
    if (product.brandCom !== '' && !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(product.brandCom)) throw Error('Malformed stored brand path');
    ids = supplierProductBrandPath(product.brandCom === '' ? [] : product.brandCom.split(','));
  } catch { parsed = false; }
  const relations = await tx.select({ id: storeProductRelation.id, relationId: storeProductRelation.relationId,
    relationPid: storeProductRelation.relationPid, status: storeProductRelation.status }).from(storeProductRelation)
    .where(and(eq(storeProductRelation.productId, product.id), eq(storeProductRelation.type, 2)))
    .orderBy(asc(storeProductRelation.id)).limit(17);
  const consistent = parsed && product.brandId === (ids.at(-1) ?? 0) && relations.length === ids.length
    && same(relations.map(row => row.relationId).sort((a, b) => a - b), [...ids].sort((a, b) => a - b))
    && relations.every(row => row.relationPid === 0 && [0, 1].includes(row.status));
  const brands = ids.length ? await tx.select({ id: storeBrand.id, pid: storeBrand.pid, storeId: storeBrand.storeId,
    isShow: storeBrand.isShow, isDel: storeBrand.isDel }).from(storeBrand).where(inArray(storeBrand.id, ids)) : [];
  return { brand_id: ids, brand_selection: { brand_id: product.brandId, brand_com: product.brandCom,
    consistent, available: consistent && supplierProductBrandPathMatches(ids, brands) } };
}
