import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { legacyCategory, storeProduct, storeProductRelation } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { supplierProductParameterInput, supplierProductParameterStored, type SupplierProductParameterInput } from '@/services/supplier/SupplierProductParameterBindings';
import { assertOutProductRelationFence, type OutProductRelationFence } from './OutProductRelationFence';

type Product = typeof storeProduct.$inferSelect;
type Template = typeof legacyCategory.$inferSelect;
type Relation = typeof storeProductRelation.$inferSelect;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const scope = (id: number, productType: 0 | 3 | 4) => and(eq(storeProduct.id, id), eq(storeProduct.type, 0), eq(storeProduct.relationId, 0), eq(storeProduct.productType, productType), eq(storeProduct.isDel, 0));
export const outProductParameterInput = supplierProductParameterInput;
export const outProductParameterTemplateOwned = (row: Pick<Template, 'type' | 'relationId' | 'group' | 'ownerId'>) =>
  row.type === 0 && row.relationId === 0 && row.group === 3 && row.ownerId === 0;
export const outProductParameterRelationsMatch = (id: number, rows: Array<Pick<Relation, 'relationId' | 'relationPid' | 'status'>>) =>
  Number.isSafeInteger(id) && id >= 0 && id <= 2147483647 && (id === 0 ? rows.length === 0
    : rows.length === 1 && rows[0].relationId === id && rows[0].relationPid === 0 && [0, 1].includes(rows[0].status));
export async function outProductParameterSelection(tx: DbClient, product: Pick<Product, 'id' | 'specsId' | 'specs'>) {
  const stored = supplierProductParameterStored(product.specs);
  const relations = await tx.select({ relationId: storeProductRelation.relationId, relationPid: storeProductRelation.relationPid, status: storeProductRelation.status })
    .from(storeProductRelation).where(and(eq(storeProductRelation.productId, product.id), eq(storeProductRelation.type, 6))).orderBy(asc(storeProductRelation.id)).limit(2);
  const consistent = stored.parsed && outProductParameterRelationsMatch(product.specsId, relations);
  const [template] = product.specsId > 0 ? await tx.select().from(legacyCategory).where(eq(legacyCategory.id, product.specsId)).limit(1) : [];
  return { specs_id: Number.isSafeInteger(product.specsId) && product.specsId >= 0 && product.specsId <= 2147483647 ? product.specsId : 0,
    specs_selection: { specs_id: product.specsId, specs: stored.raw, consistent,
      available: consistent && (product.specsId === 0 || !!template && outProductParameterTemplateOwned(template)), truncated: stored.truncated } };
}
export async function lockOutProductParameterTemplate(tx: DbClient, id: number) {
  const [template] = id > 0 ? await tx.select().from(legacyCategory).where(eq(legacyCategory.id, id)).limit(1).for('share', { noWait: true }) : [];
  if (id > 0 && (!template || !outProductParameterTemplateOwned(template))) throw new ValidateException('参数模板不存在或不属于平台');
  return template;
}
interface Proof { productId: number; input: SupplierProductParameterInput; raw: string; template: Template | undefined; relations: Relation[]; fence: OutProductRelationFence }
export async function replaceOutProductParameterBindings(tx: DbClient, productId: number, input: SupplierProductParameterInput,
  template: Template | undefined, fence: OutProductRelationFence): Promise<Proof> {
  const raw = input.specs.length ? JSON.stringify(input.specs) : '';
  const [product] = await tx.select().from(storeProduct).where(scope(productId, fence.productType)).limit(1);
  if (!product || product.specsId !== input.specs_id || product.specs !== raw) throw new ValidateException('平台商品参数写入结果已变化');
  await tx.delete(storeProductRelation).where(and(eq(storeProductRelation.productId, productId), eq(storeProductRelation.type, 6)));
  const now = Math.floor(Date.now() / 1000), relations = input.specs_id > 0 ? await tx.insert(storeProductRelation).values({
    productId, relationId: input.specs_id, relationPid: 0, type: 6, status: 1, addTime: now,
  }).returning() : [];
  if (relations.length !== (input.specs_id > 0 ? 1 : 0) || relations.some(row => row.productId !== productId || row.relationId !== input.specs_id
    || row.relationPid !== 0 || row.type !== 6 || row.status !== 1 || row.addTime !== now)) throw new ValidateException('平台商品参数关联写入结果已变化');
  const proof = { productId, input, raw, template, relations, fence };
  await assertOutProductParameterBindings(tx, proof); return proof;
}
export async function assertOutProductParameterBindings(tx: DbClient, proof: Proof) {
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  const [product] = await tx.select().from(storeProduct).where(scope(proof.productId, proof.fence.productType)).limit(1);
  const relations = await tx.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, proof.productId), eq(storeProductRelation.type, 6))).orderBy(asc(storeProductRelation.id));
  const [template] = proof.input.specs_id > 0 ? await tx.select().from(legacyCategory).where(eq(legacyCategory.id, proof.input.specs_id)).limit(1) : [];
  if (!product || product.specsId !== proof.input.specs_id || product.specs !== proof.raw || !same(template, proof.template)
    || !same(relations, [...proof.relations].sort((a, b) => a.id - b.id))) throw new ValidateException('平台商品参数或模板已变化');
  await assertOutProductRelationFence(tx, proof.fence);
}
