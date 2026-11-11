import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductEnsure, storeProductRelation } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { supplierProductEnsureStored } from '@/services/supplier/SupplierProductEnsureBindings';
import { assertOutProductRelationFence, type OutProductRelationFence } from './OutProductRelationFence';

type Product = typeof storeProduct.$inferSelect;
type Ensure = typeof storeProductEnsure.$inferSelect;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const platform = (row: Ensure) => row.type === 0 && row.relationId === 0;
const scope = (id: number, productType: 0 | 3 | 4) => and(eq(storeProduct.id, id), eq(storeProduct.type, 0),
  eq(storeProduct.relationId, 0), eq(storeProduct.productType, productType), eq(storeProduct.isDel, 0));

export async function outProductEnsureSelection(tx: DbClient, product: Pick<Product, 'id' | 'ensureId'>) {
  const stored = supplierProductEnsureStored(product.ensureId);
  const relations = await tx.select({ relationId: storeProductRelation.relationId,
    relationPid: storeProductRelation.relationPid, status: storeProductRelation.status }).from(storeProductRelation)
    .where(and(eq(storeProductRelation.productId, product.id), eq(storeProductRelation.type, 5)))
    .orderBy(asc(storeProductRelation.id)).limit(201);
  const consistent = stored.parsed && relations.length === stored.ids.length
    && same(relations.map(row => row.relationId).sort((a, b) => a - b), [...stored.ids].sort((a, b) => a - b))
    && relations.every(row => row.relationPid === 0 && [0, 1].includes(row.status));
  const rows = stored.ids.length ? await tx.select().from(storeProductEnsure).where(inArray(storeProductEnsure.id, stored.ids)) : [];
  const byId = new Map(rows.map(row => [row.id, row]));
  const retained = consistent ? stored.ids.filter(id => { const row = byId.get(id); return !!row && platform(row) && row.status === 0; }) : [];
  return { ensure_id: stored.ids, ensure_selection: { ensure_id: stored.raw, consistent,
    available: consistent && stored.ids.every(id => { const row = byId.get(id); return !!row && platform(row) && row.status === 1; }),
    retained_ids: retained, truncated: stored.truncated } };
}

/** Locks the actual catalog rows used by Admin status/delete, in stable order.
 * A disabled service may only survive an already-consistent stored selection. */
export async function lockOutProductEnsures(tx: DbClient, ids: readonly number[], previous: Product | undefined) {
  const rows = ids.length ? await tx.select().from(storeProductEnsure).where(inArray(storeProductEnsure.id, [...ids]))
    .orderBy(asc(storeProductEnsure.id)).for('share', { noWait: true }) : [];
  const retained = previous && rows.some(row => row.status !== 1)
    ? (await outProductEnsureSelection(tx, previous)).ensure_selection.retained_ids : [];
  if (rows.length !== ids.length || rows.some(row => !platform(row) || row.status !== 1 && !retained.includes(row.id)))
    throw new ValidateException('保障服务不存在、不属于平台或已停用，不能新绑定');
  return rows;
}

export interface OutProductEnsureProof {
  productId: number;
  ensureId: string;
  ids: readonly number[];
  catalog: Ensure[];
  relations: Array<typeof storeProductRelation.$inferSelect>;
  fence: OutProductRelationFence;
}
export async function replaceOutProductEnsureBindings(tx: DbClient, productId: number, ids: readonly number[],
  catalog: Ensure[], fence: OutProductRelationFence): Promise<OutProductEnsureProof> {
  const [product] = await tx.select().from(storeProduct).where(scope(productId, fence.productType)).limit(1);
  if (!product || product.ensureId !== ids.join(',')) throw new ValidateException('平台商品保障写入结果已变化');
  await tx.delete(storeProductRelation).where(and(eq(storeProductRelation.productId, productId), eq(storeProductRelation.type, 5)));
  const now = Math.floor(Date.now() / 1000);
  const relations = ids.length ? await tx.insert(storeProductRelation).values(ids.map(relationId => ({
    productId, relationId, relationPid: 0, type: 5, status: 1, addTime: now,
  }))).returning() : [];
  if (relations.length !== ids.length || !same(relations.map(row => row.relationId), ids)
    || relations.some(row => row.productId !== productId || row.relationPid !== 0 || row.type !== 5 || row.status !== 1 || row.addTime !== now))
    throw new ValidateException('平台商品保障关联写入结果已变化');
  const proof = { productId, ensureId: ids.join(','), ids: [...ids], catalog, relations, fence };
  await assertOutProductEnsureBindings(tx, proof);
  return proof;
}
export async function assertOutProductEnsureBindings(tx: DbClient, proof: OutProductEnsureProof) {
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  const [product] = await tx.select().from(storeProduct).where(scope(proof.productId, proof.fence.productType)).limit(1);
  const relations = await tx.select().from(storeProductRelation).where(and(
    eq(storeProductRelation.productId, proof.productId), eq(storeProductRelation.type, 5),
  )).orderBy(asc(storeProductRelation.id));
  const catalog = proof.ids.length ? await tx.select().from(storeProductEnsure).where(inArray(storeProductEnsure.id, [...proof.ids]))
    .orderBy(asc(storeProductEnsure.id)) : [];
  if (!product || product.ensureId !== proof.ensureId || !same(relations, [...proof.relations].sort((a, b) => a.id - b.id))
    || !same(catalog, proof.catalog)) throw new ValidateException('平台商品保障或目录已变化');
  await assertOutProductRelationFence(tx, proof.fence);
}
