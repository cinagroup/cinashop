import { and, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery,
  storeProduct, storeSeckill, storeBargain, storeCombination, storeIntegral, storeDiscountsProducts } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { boundShippingTemplateTransaction, shippingTemplateIds, type ShippingTemplateBinding } from '../order/ShippingTemplateSnapshot';

/** Preserve the original exception unless this operation encountered a real
 * PostgreSQL lock refusal. No retry of stale inputs and no SQL detail in errors. */
export async function shippingLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('运费模板正在更新，请稍后重试');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}

/** Admission must run inside the caller's transaction before persisting a new
 * reference. The source product/owner must already be locked by that writer.
 * SHARE (not KEY SHARE) excludes soft retirement and owner changes; NOWAIT
 * prevents waiting backwards against template editors. Locks last to commit.
 * This application protocol does not replace the pending direct-SQL guard.
 */
export async function lockShippingTemplateBindings(tx: DbClient, bindings: readonly ShippingTemplateBinding[]) {
  if (bindings.length > 500) throw new ValidateException('运费模板引用批次过大');
  for (const binding of bindings) {
    if (!Number.isSafeInteger(binding.tempId) || binding.tempId < 0 || binding.tempId > 2_147_483_647 ||
      !Number.isInteger(binding.freight)) throw new ValidateException('运费模板引用参数无效');
  }
  const ids = shippingTemplateIds(bindings);
  if (!ids.length) return;
  await boundShippingTemplateTransaction(tx);
  const rows = await shippingLifecycleLock(() => tx.select({ id: shippingTemplates.id, ownerType: shippingTemplates.ownerType,
    relationId: shippingTemplates.relationId, status: shippingTemplates.status, isDel: shippingTemplates.isDel })
    .from(shippingTemplates).where(inArray(shippingTemplates.id, ids)).orderBy(shippingTemplates.id).for('share', { noWait: true }));
  for (const binding of bindings) {
    const id = shippingTemplateIds([binding])[0];
    if (!id) continue;
    const parent = rows.find(row => row.id === id);
    if (!parent || parent.isDel !== 0 || parent.status !== 1) throw new ValidateException('运费模板不存在或已停用');
    if (![0, 1, 2].includes(binding.ownerType) || !Number.isSafeInteger(binding.relationId) ||
      (binding.ownerType === 0 ? binding.relationId !== 0 : binding.relationId <= 0) ||
      parent.ownerType !== binding.ownerType || parent.relationId !== binding.relationId) {
      throw new ValidateException('运费模板不属于商品所属方');
    }
  }
}

/** Legacy activity forms preserve shipping columns but can change productId.
 * Revalidate the retained template against the newly locked source owner. */
export async function lockActivityShippingSource(tx: DbClient, productId: number, shipping: { tempId: number; freight: number }) {
  if (!shippingTemplateIds([{ ...shipping, ownerType: 0, relationId: 0 }]).length) return;
  const [source] = await shippingLifecycleLock(() => tx.select({ type: storeProduct.type, relationId: storeProduct.relationId })
    .from(storeProduct).where(eq(storeProduct.id, productId)).limit(1).for('share', { noWait: true }));
  if (!source) throw new ValidateException('运费模板引用的源商品不存在');
  await lockShippingTemplateBindings(tx, [{ ...shipping, ownerType: source.type, relationId: source.relationId }]);
}

/** Caller holds the parent write lock. A separate RC statement sees bindings
 * committed while that lock was awaited. Never take product/activity row locks
 * here: doing so would invert writers' product -> template order. Retained rows
 * count until explicitly unbound, regardless of lifecycle or owner flags.
 */
export async function assertShippingTemplateUnreferenced(tx: DbClient, id: number) {
  await boundShippingTemplateTransaction(tx);
  await tx.execute(sql`SET LOCAL row_security = off`);
  const reference = (temp: SQLWrapper, freight: SQLWrapper) =>
    sql`(${temp} = ${id} OR (${temp} <= 0 AND ${freight} NOT IN (1,2) AND ${id} = 1))`;
  const [row] = await tx.select({ used: sql<boolean>`
    EXISTS(SELECT 1 FROM ${storeProduct} WHERE ${reference(storeProduct.tempId, storeProduct.freight)}) OR
    EXISTS(SELECT 1 FROM ${storeSeckill} WHERE ${reference(storeSeckill.tempId, storeSeckill.freight)}) OR
    EXISTS(SELECT 1 FROM ${storeBargain} WHERE ${reference(storeBargain.tempId, storeBargain.freight)}) OR
    EXISTS(SELECT 1 FROM ${storeCombination} WHERE ${reference(storeCombination.tempId, storeCombination.freight)}) OR
    EXISTS(SELECT 1 FROM ${storeIntegral} WHERE ${reference(storeIntegral.tempId, storeIntegral.freight)}) OR
    EXISTS(SELECT 1 FROM ${storeDiscountsProducts} WHERE ${storeDiscountsProducts.tempId} = ${id})`
  }).from(sql`(VALUES(1)) shipping_references(n)`);
  if (!row || row.used !== false) throw new ValidateException('运费模板仍被商品或活动引用，请先解除引用');
}

export async function retireShippingTemplate(container: Container, id: number, supplierId?: number): Promise<void> {
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw new ValidateException('运费模板ID错误');
  if (supplierId !== undefined && (!Number.isSafeInteger(supplierId) || supplierId <= 0)) throw new ValidateException('供应商ID错误');
  await shippingLifecycleLock(() => withTx(container, async tx => {
    await boundShippingTemplateTransaction(tx);
    const scope = and(eq(shippingTemplates.id, id), supplierId === undefined ? undefined :
      and(eq(shippingTemplates.ownerType, 2), eq(shippingTemplates.relationId, supplierId)));
    const [parent] = await tx.select({ id: shippingTemplates.id, isDel: shippingTemplates.isDel })
      .from(shippingTemplates).where(scope).limit(1).for('no key update');
    if (!parent) throw new NotFoundException('运费模板不存在或不属于当前所属方');
    if (parent.isDel === 1) return; // Repeat deletion is idempotent, never restores or rewrites references.
    await assertShippingTemplateUnreferenced(tx, id);
    // Preserve each established rule-retention contract; never rewrite orders or
    // automatically assign referenced products to default template 1.
    if (supplierId !== undefined) {
      await tx.delete(shippingTemplatesRegion).where(eq(shippingTemplatesRegion.templateId, id));
      await tx.delete(shippingTemplatesFree).where(eq(shippingTemplatesFree.tempId, id));
      await tx.delete(shippingTemplatesNoDelivery).where(eq(shippingTemplatesNoDelivery.tempId, id));
    }
    await tx.update(shippingTemplates).set(supplierId === undefined ? { isDel: 1 } : { isDel: 1, status: 0 }).where(scope);
  }));
}
