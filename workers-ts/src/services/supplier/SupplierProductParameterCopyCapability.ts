import { and, asc, eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { legacyCategory, storeProduct, storeProductRelation } from '@/models/schema';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { supplierProductParameterInteger, supplierProductParameterRows, supplierProductParameterStored,
  supplierProductParameterRelationsMatch, lockSupplierProductParameterTemplate, type SupplierProductParameterRow } from './SupplierProductParameterBindings';

declare const copyCapabilityBrand: unique symbol;
/** A process-local handle, never a JSON/body flag. Its record is bound to the
 * genuine transaction and a freshly locked complete Supplier source row. */
export interface SupplierProductParameterCopyCapability { readonly [copyCapabilityBrand]: true }
type Product = typeof storeProduct.$inferSelect;
type Relation = typeof storeProductRelation.$inferSelect;
type Template = typeof legacyCategory.$inferSelect;
type Record = { tx: DbClient; supplierId: number; source: Product; relations: Relation[]; template: Template | undefined; rows: SupplierProductParameterRow[] };
const records = new WeakMap<object, Record>();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const conflict = () => new HttpApiException('复制来源参数已变化，请重新载入来源', 409, 409);
function record(capability: unknown): Record {
  const found = capability && typeof capability === 'object' ? records.get(capability) : undefined;
  if (!found) throw new ValidateException('商品参数复制授权无效');
  return found;
}
/** Called only after the complete-save table barriers and the Supplier wrapper's
 * full source MAC admission. Re-reading here closes reliance on caller DTOs. */
export async function captureSupplierProductParameterCopy(tx: DbClient, supplierId: number, source: Product): Promise<SupplierProductParameterCopyCapability | undefined> {
  if (Object.hasOwn(tx, '$client')) throw new ValidateException('参数复制须在已授权事务中执行');
  const [actual] = await tx.select().from(storeProduct).where(and(eq(storeProduct.id, source.id), eq(storeProduct.type, 2), eq(storeProduct.relationId, supplierId)))
    .limit(1).for('share', { noWait: true });
  if (!actual || !same(actual, source)) throw conflict();
  const stored = supplierProductParameterStored(actual.specs);
  // Mature nonempty four-field generic snapshots retain their existing
  // normalizer and bytes. Supplier-authored rows have five fields; a legitimate
  // empty snapshot may also retain its template independently, as PHP allows.
  if (!stored.parsed || !stored.rows.length && actual.specsId === 0) return undefined;
  const parsed: unknown = actual.specs ? JSON.parse(actual.specs) : [];
  const keys = ['id', 'name', 'sort', 'temp_id', 'value'];
  if (!Array.isArray(parsed) || parsed.some(row => !row || typeof row !== 'object' || Array.isArray(row)
    || !same(Object.keys(row).sort(), keys))) return undefined;
  const relations = await tx.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, actual.id), eq(storeProductRelation.type, 6)))
    .orderBy(asc(storeProductRelation.id)).limit(2);
  if (!supplierProductParameterRelationsMatch(actual.specsId, relations)) throw conflict();
  const template = await lockSupplierProductParameterTemplate(tx, supplierId, actual.specsId);
  const capability = Object.freeze({}) as SupplierProductParameterCopyCapability;
  records.set(capability, { tx, supplierId, template: template && { ...template }, source: { ...actual }, relations: relations.map(row => ({ ...row })), rows: stored.rows.map(row => ({ ...row })) });
  return capability;
}
/** Pure normalization still checks the opaque handle and exact source snapshot;
 * it does not turn a serializable mode flag or untrusted row into authority. */
export function supplierProductParameterCopyRows(capability: SupplierProductParameterCopyCapability, template: unknown, value: unknown): SupplierProductParameterRow[] {
  const saved = record(capability), templateId = supplierProductParameterInteger(template);
  const stored = typeof value === 'string' || value === null ? supplierProductParameterStored(value) : undefined;
  if (stored && !stored.parsed) throw conflict();
  const rows = stored ? stored.rows : supplierProductParameterRows(value);
  if (templateId !== saved.source.specsId || !same(rows, saved.rows)) throw conflict();
  return saved.rows.map(row => ({ ...row }));
}
export async function assertSupplierProductParameterCopy(tx: DbClient, capability: SupplierProductParameterCopyCapability,
  owner: { type: number; relationId: number }, targetId: number, template: unknown, value: unknown) {
  const saved = record(capability);
  if (saved.tx !== tx || targetId !== 0 || owner.type !== 2 || owner.relationId !== saved.supplierId) throw new ValidateException('商品参数复制事务或归属无效');
  await assertSupplierProductParameterCopySource(tx, capability);
  return supplierProductParameterCopyRows(capability, template, value);
}
/** Recheck the complete locked source and admitted template after every storage
 * stage, including same-transaction deferred effects. Table/row locks exclude
 * peers, but cannot prevent a trigger from changing this transaction's rows. */
export async function assertSupplierProductParameterCopySource(tx: DbClient, capability: SupplierProductParameterCopyCapability) {
  const saved = record(capability);
  if (saved.tx !== tx) throw new ValidateException('商品参数复制事务无效');
  const [actual] = await tx.select().from(storeProduct).where(eq(storeProduct.id, saved.source.id)).limit(1).for('share', { noWait: true });
  const relations = await tx.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, saved.source.id), eq(storeProductRelation.type, 6)))
    .orderBy(asc(storeProductRelation.id)).limit(2);
  const [template] = saved.source.specsId > 0 ? await tx.select().from(legacyCategory).where(eq(legacyCategory.id, saved.source.specsId))
    .limit(1).for('share', { noWait: true }) : [];
  if (!same(actual, saved.source) || !same(relations, saved.relations) || !same(template, saved.template)) throw conflict();
}
