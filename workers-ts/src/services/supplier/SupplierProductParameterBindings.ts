import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { legacyCategory, storeProduct, storeProductRelation } from '@/models/schema';
import { HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';

type Product = typeof storeProduct.$inferSelect;
type Relation = typeof storeProductRelation.$inferSelect;
type Template = typeof legacyCategory.$inferSelect;
export interface SupplierProductParameterRow { id: number; temp_id: number; name: string; value: string; sort: number }
export interface SupplierProductParameterInput { specs_id: number; specs: SupplierProductParameterRow[] }
export const SUPPLIER_PARAMETER_RAW_POINTS = 1_048_576;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const conflict = () => new HttpApiException('商品参数或关联已变化，请刷新后重试', 409, 409);
export function supplierProductParameterInteger(raw: unknown, signed = false): number {
  const pattern = signed ? /^(?:0|[1-9]\d{0,9}|-[1-9]\d{0,9})$/ : /^(?:0|[1-9]\d{0,9})$/;
  const value = typeof raw === 'string' && pattern.test(raw) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)
    || value < (signed ? -2147483648 : 0) || value > 2147483647) throw new ValidateException('商品参数整数格式错误');
  return value;
}
/** PHP intersects each row with these five keys. Catalog owner/status metadata
 * never grants write authority and is deliberately discarded. Text is checked
 * for blank UI input, but stored verbatim as the PHP server does. */
export function supplierProductParameterRows(value: unknown): SupplierProductParameterRow[] {
  if (!Array.isArray(value) || value.length > 100) throw new ValidateException('商品参数须为最多100行的数组');
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ValidateException('商品参数行格式错误');
    const row = entry as Record<string, unknown>;
    const text = (raw: unknown) => {
      if (typeof raw !== 'string' || !raw.trim() || raw === '0' || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(raw) || [...raw].length > 255) throw new ValidateException('参数名称和值须为非空文本且不超过255个字符');
      return raw;
    };
    return { id: supplierProductParameterInteger(row.id === undefined ? 0 : row.id),
      temp_id: supplierProductParameterInteger(row.temp_id === undefined ? 0 : row.temp_id),
      name: text(row.name), value: text(row.value), sort: supplierProductParameterInteger(row.sort === undefined ? 0 : row.sort, true) };
  });
}
export function supplierProductParameterInput(body: Record<string, unknown>): SupplierProductParameterInput | undefined {
  const hasId = Object.hasOwn(body, 'specs_id') && body.specs_id !== undefined;
  const hasRows = Object.hasOwn(body, 'specs') && body.specs !== undefined;
  if (!hasId && !hasRows) return undefined;
  if (!hasId || !hasRows) throw new ValidateException('商品参数模板和参数须同时提交');
  return { specs_id: supplierProductParameterInteger(body.specs_id), specs: supplierProductParameterRows(body.specs) };
}
export function supplierProductParameterStored(raw: string | null) {
  const points = raw === null ? [] : [...raw.slice(0, 2 * SUPPLIER_PARAMETER_RAW_POINTS + 2)];
  const truncated = points.length > SUPPLIER_PARAMETER_RAW_POINTS;
  const display = raw === null ? null : truncated ? points.slice(0, SUPPLIER_PARAMETER_RAW_POINTS).join('') : raw;
  let rows: SupplierProductParameterRow[] = [], parsed = !truncated;
  try { if (truncated) throw Error('Truncated parameter snapshot'); rows = supplierProductParameterRows(raw === null || raw === '' ? [] : JSON.parse(raw)); }
  catch { parsed = false; }
  return { rows, raw: display, parsed, truncated };
}
export const supplierProductParameterTemplateOwned = (row: Pick<Template, 'type' | 'relationId' | 'group' | 'ownerId'>, supplierId: number) =>
  row.group === 3 && row.ownerId === 0 && (row.type === 0 && row.relationId === 0 || row.type === 2 && row.relationId === supplierId);
export function supplierProductParameterRelationsMatch(specsId: number, rows: Array<Pick<Relation, 'relationId' | 'relationPid' | 'status'>>) {
  return specsId === 0 ? rows.length === 0 : rows.length === 1 && rows[0].relationId === specsId && rows[0].relationPid === 0 && rows[0].status === 1;
}
export async function readSupplierProductParameterSelection(db: DbClient, supplierId: number, product: Pick<Product, 'id' | 'specsId' | 'specs'>) {
  const stored = supplierProductParameterStored(product.specs);
  const relations = await db.select({ relationId: storeProductRelation.relationId, relationPid: storeProductRelation.relationPid, status: storeProductRelation.status })
    .from(storeProductRelation).where(and(eq(storeProductRelation.productId, product.id), eq(storeProductRelation.type, 6))).orderBy(asc(storeProductRelation.id)).limit(2);
  const consistent = stored.parsed && Number.isSafeInteger(product.specsId) && product.specsId >= 0 && product.specsId <= 2147483647
    && supplierProductParameterRelationsMatch(product.specsId, relations);
  const [template] = product.specsId > 0 ? await db.select().from(legacyCategory).where(eq(legacyCategory.id, product.specsId)).limit(1) : [];
  const projectedId = Number.isSafeInteger(product.specsId) && product.specsId >= 0 && product.specsId <= 2147483647 ? product.specsId : 0;
  return { specs_id: projectedId, specs: stored.rows, specs_selection: { specs_id: product.specsId, specs: stored.raw, consistent,
    available: consistent && (product.specsId === 0 || !!template && supplierProductParameterTemplateOwned(template, supplierId)), truncated: stored.truncated } };
}
export async function lockSupplierProductParameterTemplate(db: DbClient, supplierId: number, specsId: number) {
  const [template] = specsId > 0 ? await db.select().from(legacyCategory).where(eq(legacyCategory.id, specsId)).limit(1).for('share', { noWait: true }) : [];
  if (specsId > 0 && (!template || !supplierProductParameterTemplateOwned(template, supplierId))) throw new ValidateException('参数模板不存在或不属于当前供应商');
  return template;
}
// Reuse after every later author in the ordinary save coordinator. Locks
// exclude other sessions, but same-transaction triggers may still change a
// previously admitted template while an ensure or brand write is executing.
export async function assertSupplierProductParameterTemplate(db: DbClient, specsId: number, admitted: Template | undefined) {
  const [current] = specsId > 0 ? await db.select().from(legacyCategory).where(eq(legacyCategory.id, specsId)) : [];
  if (!same(current, admitted)) throw conflict();
}
export async function readSupplierParameterProtectedRelations(db: DbClient, productId: number, labelsChanged: boolean) {
  const rows = await db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, productId),
    notInArray(storeProductRelation.type, labelsChanged ? [1, 3, 6] : [1, 6]))).orderBy(asc(storeProductRelation.id)).limit(2001);
  if (rows.length > 2000) throw new ServiceUnavailableException('商品历史关联过多，请先核对');
  return rows;
}
/** Explicit writes settle deferred constraints before their complete receipt.
 * Requests omitting both fields never enter this boundary. */
export async function replaceSupplierProductParameterBindings(db: DbClient, supplierId: number, productId: number, input: SupplierProductParameterInput,
  admitted: Template | undefined, expectedBefore: Product | undefined, protectedRelations: Relation[], labelsChanged: boolean) {
  const owner = and(eq(storeProduct.id, productId), eq(storeProduct.type, 2), eq(storeProduct.relationId, supplierId), eq(storeProduct.isDel, 0));
  const [before] = await db.select().from(storeProduct).where(owner).for('update', { noWait: true });
  if (!before || before.isShow !== 0 || before.isVerify !== 0 || expectedBefore && !same(before, expectedBefore)) throw conflict();
  const expected = { ...before, specsId: input.specs_id, specs: input.specs.length ? JSON.stringify(input.specs) : '' };
  const changed = await db.update(storeProduct).set({ specsId: expected.specsId, specs: expected.specs }).where(owner).returning();
  if (changed.length !== 1 || !same(changed[0], expected)) throw conflict();
  const where = and(eq(storeProductRelation.productId, productId), eq(storeProductRelation.type, 6));
  await db.delete(storeProductRelation).where(where);
  const now = Math.floor(Date.now() / 1000), inserted = input.specs_id > 0 ? await db.insert(storeProductRelation).values({
    productId, type: 6, relationId: input.specs_id, relationPid: 0, status: 1, addTime: now,
  }).returning() : [];
  if (inserted.length !== (input.specs_id > 0 ? 1 : 0) || inserted.some(row => row.productId !== productId || row.type !== 6
    || row.relationId !== input.specs_id || row.relationPid !== 0 || row.status !== 1 || row.addTime !== now)) throw conflict();
  await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  const [actual] = await db.select().from(storeProduct).where(owner);
  const relations = await db.select().from(storeProductRelation).where(where).orderBy(asc(storeProductRelation.id));
  await assertSupplierProductParameterTemplate(db, input.specs_id, admitted);
  if (!same(actual, expected) || !same(relations, inserted)
    || !same(await readSupplierParameterProtectedRelations(db, productId, labelsChanged), protectedRelations)) throw conflict();
}
