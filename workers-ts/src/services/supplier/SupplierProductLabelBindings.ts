import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { legacyCategory, storeProduct, storeProductLabel, storeProductRelation } from '@/models/schema';
import { normalizeProductAssociationIds } from '@/services/product/ProductAssociationService';
import { HttpApiException, NotFoundException, ValidateException } from '@/utils/errors';

const conflict = () => new HttpApiException('商品标签已变化，请刷新后重试', 409, 409);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function labelSelection(value: unknown): number[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.trim() ? value.split(',') : [] : value === null || value === undefined ? [] : [value];
  if (entries.length > 100) throw new ValidateException('商品标签不能超过100项');
  if (entries.some(entry => (typeof entry !== 'number' && (typeof entry !== 'string' || !/^[1-9]\d*$/.test(entry.trim())))
    || !Number.isSafeInteger(Number(entry)) || Number(entry) <= 0 || Number(entry) > 2_147_483_647)) throw new ValidateException('商品标签格式错误');
  return normalizeProductAssociationIds(entries, '商品标签', 100);
}
function supplierOwner(supplierId: number) {
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0 || supplierId > 2_147_483_647) throw new ValidateException('供应商身份无效');
}
export function supplierProductLabelInput(body: Record<string, unknown>): number[] | undefined {
  const keys = ['store_label_id', 'labelIds'].filter(key => Object.hasOwn(body, key));
  if (!keys.length) return undefined;
  const ids = keys.map(key => labelSelection(body[key]));
  if (ids.length > 1 && !same(ids[0], ids[1])) throw new ValidateException('商品标签参数冲突');
  return ids[0];
}

/** Binding and deletion meet on the same real label row, including legacy
 * Supplier labels assigned to a platform group by the first-party form. */
export async function assertSupplierProductLabelBindings(db: DbClient, supplierId: number, values: number[]) {
  supplierOwner(supplierId);
  const ids = labelSelection(values).sort((a, b) => a - b);
  if (!ids.length) return [];
  const labels = await db.select().from(storeProductLabel).where(and(inArray(storeProductLabel.id, ids),
    eq(storeProductLabel.status, 1), eq(storeProductLabel.isShow, 1), or(
      and(eq(storeProductLabel.type, 0), eq(storeProductLabel.relationId, 0)),
      and(eq(storeProductLabel.type, 2), eq(storeProductLabel.relationId, supplierId)),
    ))).orderBy(asc(storeProductLabel.id)).for('share', { noWait: true });
  if (!same(labels.map(row => row.id), ids)) throw new ValidateException('商品标签不存在、不可用或不属于当前供应商');
  const groups = await db.select().from(legacyCategory).where(and(
    inArray(legacyCategory.id, [...new Set(labels.map(row => row.labelCate))]),
    eq(legacyCategory.ownerId, 0), eq(legacyCategory.group, 2), eq(legacyCategory.isShow, 1), or(
      and(eq(legacyCategory.type, 0), eq(legacyCategory.relationId, 0)),
      and(eq(legacyCategory.type, 2), eq(legacyCategory.relationId, supplierId)),
    ))).orderBy(asc(legacyCategory.id)).for('share', { noWait: true });
  const byId = new Map(groups.map(row => [row.id, row]));
  if (labels.some(label => {
    const group = byId.get(label.labelCate);
    return !group || (group.type === 2 && (label.type !== 2 || label.relationId !== supplierId));
  })) throw new ValidateException('商品标签组不可用或不属于当前供应商');
  return labels;
}

/** Call in the existing product/SKU transaction after its owner row is locked.
 * Omission never enters this function; an explicit empty selection clears it. */
export async function replaceSupplierProductLabelBindings(db: DbClient, supplierId: number, productId: number, values: number[]) {
  supplierOwner(supplierId);
  if (!Number.isSafeInteger(productId) || productId <= 0 || productId > 2_147_483_647) throw new ValidateException('商品ID错误');
  const ids = labelSelection(values);
  await assertSupplierProductLabelBindings(db, supplierId, ids);
  const owner = and(eq(storeProduct.id, productId), eq(storeProduct.type, 2),
    eq(storeProduct.relationId, supplierId), eq(storeProduct.isDel, 0));
  const [previous] = await db.select().from(storeProduct).where(owner).for('update', { noWait: true });
  if (!previous) throw new NotFoundException('商品不存在或不属于当前供应商');
  const where = and(eq(storeProductRelation.productId, productId), eq(storeProductRelation.type, 3));
  const relations = await db.select().from(storeProductRelation).where(where)
    .orderBy(asc(storeProductRelation.id)).for('update', { noWait: true });
  if (relations.length > 100 || new Set(relations.map(row => row.relationId)).size !== relations.length) throw conflict();
  const wanted = new Set(ids), existing = new Set(relations.map(row => row.relationId));
  const removed = relations.filter(row => !wanted.has(row.relationId));
  if (removed.length) {
    const result = await db.delete(storeProductRelation).where(inArray(storeProductRelation.id, removed.map(row => row.id))).returning();
    if (!same(result.sort((a, b) => a.id - b.id), removed)) throw conflict();
  }
  const added = ids.filter(id => !existing.has(id));
  const now = Math.floor(Date.now() / 1000);
  const inserted = added.length ? await db.insert(storeProductRelation).values(added.map(id => ({
    productId, type: 3, relationId: id, relationPid: 0, status: previous.isShow, addTime: now,
  }))).returning() : [];
  if (inserted.length !== added.length || inserted.some(row => row.productId !== productId || row.type !== 3 ||
    row.relationPid !== 0 || row.status !== previous.isShow || row.addTime !== now) ||
    !same(inserted.map(row => row.relationId).sort((a, b) => a - b), [...added].sort((a, b) => a - b))) throw conflict();
  const expectedProduct = { ...previous, storeLabelId: ids.join(',') };
  const updated = await db.update(storeProduct).set({ storeLabelId: expectedProduct.storeLabelId }).where(owner).returning();
  if (updated.length !== 1 || !same(updated[0], expectedProduct)) throw conflict();
  const expected = [...relations.filter(row => wanted.has(row.relationId)), ...inserted].sort((a, b) => a.id - b.id);
  const actual = await db.select().from(storeProductRelation).where(where).orderBy(asc(storeProductRelation.id));
  const [product] = await db.select().from(storeProduct).where(owner);
  if (!same(actual, expected) || !same(product, expectedProduct)) throw conflict();
}
