import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductEnsure, storeProductRelation } from '@/models/schema';
import { HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
type Product = typeof storeProduct.$inferSelect;
type Relation = typeof storeProductRelation.$inferSelect;
type Ensure = typeof storeProductEnsure.$inferSelect;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const conflict = () => new HttpApiException('商品保障或关联已变化，请刷新后重试', 409, 409);
const owned = (row: Ensure, supplierId: number) => row.type === 0 && row.relationId === 0 || row.type === 2 && row.relationId === supplierId;
export function supplierProductEnsureIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 200) throw new ValidateException('保障服务须为最多200个编号的数组');
  const ids = value.map((raw): number => {
    const id = typeof raw === 'string' && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : raw;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new ValidateException('保障服务编号格式错误');
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new ValidateException('保障服务编号不能重复');
  return ids;
}
export function supplierProductEnsureInput(body: Record<string, unknown>): number[] | undefined {
  return Object.hasOwn(body, 'ensure_id') && body.ensure_id !== undefined ? supplierProductEnsureIds(body.ensure_id) : undefined;
}
export function supplierProductEnsureStored(raw: string | null) {
  const points = raw === null ? [] : [...raw.slice(0, 8194)], truncated = points.length > 4096;
  const display = raw === null ? null : truncated ? points.slice(0, 4096).join('') : raw;
  let ids: number[] = [], parsed = !truncated;
  try {
    if (truncated || raw !== null && raw !== '' && !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw)) throw Error('Invalid historical ensure CSV');
    ids = supplierProductEnsureIds(raw === null || raw === '' ? [] : raw.split(','));
  } catch { parsed = false; }
  return { ids, raw: display, parsed, truncated };
}
export async function readSupplierProductEnsureSelection(db: DbClient, supplierId: number, product: Pick<Product, 'id' | 'ensureId'>) {
  const stored = supplierProductEnsureStored(product.ensureId);
  const relations = await db.select({ relationId: storeProductRelation.relationId, relationPid: storeProductRelation.relationPid, status: storeProductRelation.status })
    .from(storeProductRelation).where(and(eq(storeProductRelation.productId, product.id), eq(storeProductRelation.type, 5)))
    .orderBy(asc(storeProductRelation.id)).limit(201);
  const consistent = stored.parsed && relations.length === stored.ids.length
    && same(relations.map(row => row.relationId).sort((a, b) => a - b), [...stored.ids].sort((a, b) => a - b))
    && relations.every(row => row.relationPid === 0 && row.status === 1);
  const rows = stored.ids.length ? await db.select().from(storeProductEnsure).where(inArray(storeProductEnsure.id, stored.ids)) : [];
  const byId = new Map(rows.map(row => [row.id, row]));
  return { ensure_id: stored.ids, ensure_selection: { ensure_id: stored.raw, consistent,
    available: consistent && stored.ids.every(id => { const row = byId.get(id); return !!row && owned(row, supplierId) && row.status === 1; }),
    retained_ids: consistent ? stored.ids.filter(id => { const row = byId.get(id); return !!row && owned(row, supplierId) && row.status !== 1; }) : [],
    truncated: stored.truncated } };
}
export async function lockSupplierProductEnsures(db: DbClient, supplierId: number, ids: readonly number[], previous: Product | undefined) {
  const rows = ids.length ? await db.select().from(storeProductEnsure).where(inArray(storeProductEnsure.id, [...ids]))
    .orderBy(asc(storeProductEnsure.id)).for('share', { noWait: true }) : [];
  const retained = previous ? (await readSupplierProductEnsureSelection(db, supplierId, previous)).ensure_selection.retained_ids : [];
  if (rows.length !== ids.length || rows.some(row => !owned(row, supplierId) || row.status !== 1 && !retained.includes(row.id))) {
    throw new ValidateException('保障服务不存在、不属于当前供应商或已停用，不能新绑定');
  }
  return rows;
}
export async function readSupplierEnsureProtectedRelations(db: DbClient, productId: number, labelsChanged: boolean) {
  const rows = await db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, productId),
    notInArray(storeProductRelation.type, labelsChanged ? [1, 3, 5] : [1, 5]))).orderBy(asc(storeProductRelation.id)).limit(2001);
  if (rows.length > 2000) throw new ServiceUnavailableException('商品历史关联过多，请先核对');
  return rows;
}
/** Explicit ensure writes settle deferred constraints before their complete
 * receipt, as brand writes do. Omitted legacy writes never call this helper. */
export async function replaceSupplierProductEnsureBindings(db: DbClient, supplierId: number, productId: number, ids: readonly number[],
  admitted: Ensure[], expectedBefore: Product | undefined, protectedRelations: Relation[], labelsChanged: boolean) {
  const owner = and(eq(storeProduct.id, productId), eq(storeProduct.type, 2), eq(storeProduct.relationId, supplierId), eq(storeProduct.isDel, 0));
  const [before] = await db.select().from(storeProduct).where(owner).for('update', { noWait: true });
  if (!before || before.isShow !== 0 || before.isVerify !== 0 || expectedBefore && !same(before, expectedBefore)) throw conflict();
  const expected = { ...before, ensureId: ids.join(',') };
  const changed = await db.update(storeProduct).set({ ensureId: expected.ensureId }).where(owner).returning();
  if (changed.length !== 1 || !same(changed[0], expected)) throw conflict();
  const where = and(eq(storeProductRelation.productId, productId), eq(storeProductRelation.type, 5));
  await db.delete(storeProductRelation).where(where);
  const now = Math.floor(Date.now() / 1000), inserted = ids.length ? await db.insert(storeProductRelation).values(ids.map(relationId => ({
    productId, type: 5, relationId, relationPid: 0, status: 1, addTime: now,
  }))).returning() : [];
  if (inserted.length !== ids.length || !same(inserted.map(row => row.relationId), ids)
    || inserted.some(row => row.productId !== productId || row.type !== 5 || row.relationPid !== 0 || row.status !== 1 || row.addTime !== now)) throw conflict();
  await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  const [actual] = await db.select().from(storeProduct).where(owner);
  const relations = await db.select().from(storeProductRelation).where(where).orderBy(asc(storeProductRelation.id));
  const current = ids.length ? await db.select().from(storeProductEnsure).where(inArray(storeProductEnsure.id, [...ids])).orderBy(asc(storeProductEnsure.id)) : [];
  if (!same(actual, expected) || !same(relations, [...inserted].sort((a, b) => a.id - b.id)) || !same(current, admitted)
    || !same(await readSupplierEnsureProtectedRelations(db, productId, labelsChanged), protectedRelations)) throw conflict();
}
