import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductRelation, systemForm } from '@/models/schema';
import { loadActiveOrderSystemForm } from '@/services/order/OrderSystemFormService';
import { HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';

type Product = typeof storeProduct.$inferSelect;
async function readDefinitionRow(db: DbClient, id: number) {
  const [row] = await db.select({ id: systemForm.id, version: systemForm.version, name: systemForm.name, coverImage: systemForm.coverImage,
    value: sql<string | null>`CASE WHEN octet_length(${systemForm.value}) <= 1000000 THEN ${systemForm.value} ELSE NULL END`,
    defaultValue: sql<string | null>`CASE WHEN octet_length(${systemForm.defaultValue}) <= 1000000 THEN ${systemForm.defaultValue} ELSE NULL END`,
    status: systemForm.status, isDel: systemForm.isDel, updateTime: systemForm.updateTime, addTime: systemForm.addTime,
  }).from(systemForm).where(eq(systemForm.id, id)).limit(1);
  return row;
}
type AdmittedForm = { definition: Awaited<ReturnType<typeof loadActiveOrderSystemForm>>; row: Awaited<ReturnType<typeof readDefinitionRow>> };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const conflict = () => new HttpApiException('商品留言表单或定义已变化，请刷新后重试', 409, 409);
/** Undefined means no author intent. Only a canonical nonnegative int4 may
 * enter the SQL target; arbitrary coercions never become a clear operation. */
export function supplierProductSystemFormInput(body: Record<string, unknown>): number | undefined {
  if (!Object.hasOwn(body, 'system_form_id') || body.system_form_id === undefined) return undefined;
  const raw = body.system_form_id, value = typeof raw === 'string' && /^(?:0|[1-9]\d{0,9})$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 0 || value > 2147483647) {
    throw new ValidateException('自定义留言表单ID须为非负整数');
  }
  return value;
}
/** The shared order parser is authoritative for eligibility. Historical bad
 * definitions remain readable; SQL/transport failures must escape unchanged. */
export async function readSupplierProductSystemFormSelection(db: DbClient, product: Pick<Product, 'systemFormId'>) {
  const id = product.systemFormId;
  let available = id === 0;
  if (id > 0) {
    try { await loadActiveOrderSystemForm(db, id); available = true; }
    catch (error) { if (!(error instanceof ValidateException)) throw error; }
  }
  return { system_form_id: id >= 0 ? id : 0, system_form_selection: { system_form_id: id, available } };
}
export async function lockSupplierProductSystemForm(db: DbClient, id: number): Promise<AdmittedForm | undefined> {
  if (id === 0) return undefined;
  const definition = await loadActiveOrderSystemForm(db, id, true);
  return { definition, row: await readDefinitionRow(db, id) };
}
/** Reparse the actual currently selected definition after later authors and
 * deferred triggers. A SHARE lock only excludes other transactions. */
export async function assertSupplierProductSystemForm(db: DbClient, id: number, admitted: AdmittedForm | undefined) {
  let actual: AdmittedForm | undefined;
  try { actual = await lockSupplierProductSystemForm(db, id); }
  catch (error) { if (error instanceof ValidateException) throw conflict(); throw error; }
  if (!same(actual, admitted)) throw conflict();
}
export async function replaceSupplierProductSystemFormBinding(db: DbClient, supplierId: number, productId: number, id: number,
  admitted: AdmittedForm | undefined, expectedBefore: Product | undefined) {
  const owner = and(eq(storeProduct.id, productId), eq(storeProduct.type, 2), eq(storeProduct.relationId, supplierId), eq(storeProduct.isDel, 0));
  const [before] = await db.select().from(storeProduct).where(owner).for('update', { noWait: true });
  if (!before || before.isShow !== 0 || before.isVerify !== 0 || expectedBefore && !same(before, expectedBefore)) throw conflict();
  // The order template is a global definition. Only its ID belongs to this
  // author; custom_form and system_form_data are never written here.
  const expected = { ...before, systemFormId: id };
  const relationQuery = () => db.select().from(storeProductRelation).where(eq(storeProductRelation.productId, productId)).orderBy(asc(storeProductRelation.id)).limit(2001);
  const relations = await relationQuery();
  if (relations.length > 2000) throw new ServiceUnavailableException('商品关联过多，请先核对');
  await assertSupplierProductSystemForm(db, id, admitted);
  const updated = await db.update(storeProduct).set({ systemFormId: id }).where(owner).returning();
  if (updated.length !== 1 || !same(updated[0], expected)) throw conflict();
  await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  await assertSupplierProductSystemForm(db, id, admitted);
  const [actual] = await db.select().from(storeProduct).where(owner);
  if (!same(actual, expected) || !same(await relationQuery(), relations)) throw conflict();
}
