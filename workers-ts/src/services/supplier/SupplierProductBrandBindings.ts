import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeBrand, storeProduct, storeProductRelation } from '@/models/schema';
import { HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';

type Product = typeof storeProduct.$inferSelect;
type Relation = typeof storeProductRelation.$inferSelect;
type Brand = Pick<typeof storeBrand.$inferSelect, 'id' | 'pid' | 'storeId' | 'isShow' | 'isDel'>;
const maximum = 2_147_483_647, maximumDepth = 16;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const conflict = () => new HttpApiException('商品品牌或关联已变化，请刷新后重试', 409, 409);

export function supplierProductBrandPath(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > maximumDepth) throw new ValidateException('品牌须为完整的根到当前品牌路径，最多16级且不超过64字符');
  // The actual PHP iView Cascader converts every value to a string. Preserve
  // that canonical decimal wire format without allowing Number coercions.
  const ids = value.map((raw): number => {
    const id = typeof raw === 'string' && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : raw;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || id > maximum) {
      throw new ValidateException('品牌须为完整的根到当前品牌路径，最多16级且不超过64字符');
    }
    return id;
  });
  if (new Set(ids).size !== ids.length || ids.join(',').length > 64) {
    throw new ValidateException('品牌须为完整的根到当前品牌路径，最多16级且不超过64字符');
  }
  return ids;
}
/** Omission never becomes an implicit clear, including trusted old callers. */
export function supplierProductBrandInput(body: Record<string, unknown>): number[] | undefined {
  return Object.hasOwn(body, 'brand_id') && body.brand_id !== undefined ? supplierProductBrandPath(body.brand_id) : undefined;
}
export function supplierProductBrandPathMatches(ids: readonly number[], rows: readonly Brand[]): boolean {
  if (rows.length !== ids.length) return false;
  const byId = new Map(rows.map(row => [row.id, row]));
  return byId.size === ids.length && ids.every((id, index) => {
    const row = byId.get(id);
    return !!row && row.pid === (index ? ids[index - 1] : 0) && row.storeId === 0 && row.isShow === 1 && row.isDel === 0;
  });
}
/** Pins the selected visible platform path, not the Supplier's whole catalog.
 * Stable numeric row order and NOWAIT avoid waiting in reverse writer order. */
export async function lockSupplierProductBrandPath(db: DbClient, ids: readonly number[]) {
  if (!ids.length) return;
  const rows = await db.select({ id: storeBrand.id, pid: storeBrand.pid, storeId: storeBrand.storeId,
    isShow: storeBrand.isShow, isDel: storeBrand.isDel }).from(storeBrand).where(inArray(storeBrand.id, [...ids]))
    .orderBy(asc(storeBrand.id)).for('share', { noWait: true });
  if (!supplierProductBrandPathMatches(ids, rows)) throw new ValidateException('品牌路径不存在、已停用或不属于平台可选目录');
}
export async function readSupplierProductBrandSelection(db: DbClient, product: Pick<Product, 'id' | 'brandId' | 'brandCom'>) {
  let ids: number[] = [], parsed = true;
  try {
    if (product.brandCom !== '' && !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(product.brandCom)) throw Error('Malformed historical path');
    ids = supplierProductBrandPath(product.brandCom === '' ? [] : product.brandCom.split(',').map(Number));
  } catch { parsed = false; }
  const relations = await db.select({ id: storeProductRelation.id, relationId: storeProductRelation.relationId,
    relationPid: storeProductRelation.relationPid, status: storeProductRelation.status }).from(storeProductRelation)
    .where(and(eq(storeProductRelation.productId, product.id), eq(storeProductRelation.type, 2)))
    .orderBy(asc(storeProductRelation.id)).limit(maximumDepth + 1);
  const consistent = parsed && product.brandId === (ids.at(-1) ?? 0) && relations.length === ids.length
    && same(relations.map(row => row.relationId).sort((a, b) => a - b), [...ids].sort((a, b) => a - b))
    && relations.every(row => row.relationPid === 0 && row.status === 1);
  // Empty or malformed old scalar paths never require a new brand SELECT and
  // never prevent unrelated editor fields from being read or saved.
  const rows = ids.length ? await db.select({ id: storeBrand.id, pid: storeBrand.pid, storeId: storeBrand.storeId,
    isShow: storeBrand.isShow, isDel: storeBrand.isDel }).from(storeBrand).where(inArray(storeBrand.id, ids)) : [];
  return { brand_id: ids, brand_selection: { brand_id: product.brandId, brand_com: product.brandCom,
    consistent, available: consistent && supplierProductBrandPathMatches(ids, rows) } };
}

/** Ordinary full saves already own categories and may explicitly own labels;
 * every other historical association must survive a brand edit byte-for-byte. */
export async function readSupplierBrandProtectedRelations(db: DbClient, productId: number, labelsChanged: boolean) {
  const rows = await db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, productId),
    notInArray(storeProductRelation.type, labelsChanged ? [1, 2, 3] : [1, 2]))).orderBy(asc(storeProductRelation.id)).limit(2001);
  if (rows.length > 2000) throw new ServiceUnavailableException('商品历史关联过多，请先核对');
  return rows;
}
/** Only type2 relations and the two brand columns are owned here. The caller
 * supplies its complete expected ordinary-save row, never an HTTP projection. */
export async function replaceSupplierProductBrandBindings(db: DbClient, supplierId: number, productId: number,
  ids: readonly number[], expectedBeforeBrand: Product | undefined, protectedRelations: Relation[], labelsChanged: boolean) {
  const owner = and(eq(storeProduct.id, productId), eq(storeProduct.type, 2), eq(storeProduct.relationId, supplierId), eq(storeProduct.isDel, 0));
  const [before] = await db.select().from(storeProduct).where(owner).for('update', { noWait: true });
  if (!before || before.isShow !== 0 || before.isVerify !== 0 || expectedBeforeBrand && !same(before, expectedBeforeBrand)) throw conflict();
  const expected = { ...before, brandId: ids.at(-1) ?? 0, brandCom: ids.join(',') };
  const updated = await db.update(storeProduct).set({ brandId: expected.brandId, brandCom: expected.brandCom }).where(owner).returning();
  if (updated.length !== 1 || !same(updated[0], expected)) throw conflict();
  const where = and(eq(storeProductRelation.productId, productId), eq(storeProductRelation.type, 2));
  await db.delete(storeProductRelation).where(where);
  const now = Math.floor(Date.now() / 1000), inserted = ids.length ? await db.insert(storeProductRelation).values(ids.map(id => ({
    productId, type: 2, relationId: id, relationPid: 0, status: 1, addTime: now,
  }))).returning() : [];
  if (inserted.length !== ids.length || !same(inserted.map(row => row.relationId), ids)
    || inserted.some(row => row.productId !== productId || row.type !== 2 || row.relationPid !== 0 || row.status !== 1 || row.addTime !== now)) throw conflict();
  await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  const [read] = await db.select().from(storeProduct).where(owner);
  const actual = await db.select().from(storeProductRelation).where(where).orderBy(asc(storeProductRelation.id));
  if (!same(read, expected) || !same(actual, [...inserted].sort((a, b) => a.id - b.id))
    || !same(await readSupplierBrandProtectedRelations(db, productId, labelsChanged), protectedRelations)) throw conflict();
  await lockSupplierProductBrandPath(db, ids);
}
