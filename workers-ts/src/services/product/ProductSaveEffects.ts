import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrderOutbox, storeProduct, systemAdmin, systemLog, type StoreOrderOutbox } from '@/models/schema';
import { AdminPermissionService, hasAdminPermission } from '@/services/admin/AdminPermissionService';
import { loadAdminLegacyRoleReferenceHistory } from '@/services/admin/AdminLegacyRoleDeletionProof';
import { parseAdminAuthorityRoleIds } from '@/services/admin/AdminAuthorityWriteService';
import { staffPrincipalName, type StaffPrincipal } from '@/services/notification/StaffNotificationProtocol';
import type { StaffPublisher } from '@/services/notification/StaffNotificationDeliveryService';
import { clearProductRecycleTags, type ProductRecycleEffectsEnvironment } from './ProductRecycleEffects';
import { productStockCacheKeys } from './ProductStockEffects';
import { cacheDelete, getRedis } from '@/utils/cache';

export const PRODUCT_SAVE_EFFECTS_EVENT = 'product.save.effects';
export interface ProductSaveEffectsPayload { productId: number; requestedId: number; auditId: number; warning: boolean }
export interface ProductSaveEffectsEnvironment extends ProductRecycleEffectsEnvironment { STAFF_NOTICE?: StaffPublisher }
const validId = (value: unknown, zero = false): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= 2_147_483_647;
const canonical = (value: unknown): string => JSON.stringify(value, (_, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export function parseProductSaveEffectsPayload(value: unknown): ProductSaveEffectsPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Product save effects payload invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || !validId(row.productId) || !validId(row.requestedId, true)
    || !validId(row.auditId) || typeof row.warning !== 'boolean') throw Error('Product save effects payload invalid');
  return { productId: row.productId, requestedId: row.requestedId, auditId: row.auditId, warning: row.warning };
}
export async function enqueueProductSaveEffects(tx: DbClient, input: ProductSaveEffectsPayload, now: number): Promise<StoreOrderOutbox> {
  const payload = parseProductSaveEffectsPayload(input);
  if (!validId(now, true)) throw Error('Product save effects clock invalid');
  const eventKey = `${PRODUCT_SAVE_EFFECTS_EVENT}:${payload.productId}:${randomUUID()}`;
  const expected = { eventKey, aggregateType: 'product', aggregateId: payload.productId, eventType: PRODUCT_SAVE_EFFECTS_EVENT,
    payload, status: 'PENDING', dispatchCount: 0, attemptCount: 0, replayCount: 0, availableTime: now, leaseUntil: 0,
    leaseToken: '', lastError: '', enqueuedTime: 0, processedTime: 0, addTime: now, updateTime: now };
  const rows = await tx.insert(storeOrderOutbox).values(expected).returning();
  const matches = (row: StoreOrderOutbox | undefined) => !!row && validId(row.id)
    && canonical(row) === canonical({ id: row.id, ...expected });
  if (rows.length !== 1 || !matches(rows[0])) throw Error('Product save effects full receipt inconsistent');
  const [readback] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, rows[0].id)).limit(1);
  if (!matches(readback)) throw Error('Product save effects full readback inconsistent');
  return rows[0];
}
export function productSaveRelationCacheKeys(productId: number): string[] {
  if (!validId(productId)) throw Error('Product save effects product id invalid');
  return ['cate', 'brand', 'product_label', 'user_label', 'ensure', 'specs'].map(type => `cache_product_relation_${type}_${productId}`);
}
/** Dedicated save identity; never masquerades as a stock adjustment/recycle.
 * Providers run only after the verified save transaction has committed. */
export async function deliverProductSaveEffects(container: Container, env: ProductSaveEffectsEnvironment, event: StoreOrderOutbox): Promise<void> {
  const payload = parseProductSaveEffectsPayload(event.payload);
  if (event.eventType !== PRODUCT_SAVE_EFFECTS_EVENT || event.aggregateType !== 'product' || event.aggregateId !== payload.productId
    || !new RegExp(`^product\\.save\\.effects:${payload.productId}:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).test(event.eventKey)) throw Error('Product save effects identity invalid');
  const targets = await withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, payload.productId)).limit(1);
    const [audit] = await tx.select().from(systemLog).where(eq(systemLog.id, payload.auditId)).limit(1);
    if (!product || !audit || audit.type !== 'product_save' || audit.method !== 'POST'
      || audit.path !== `product/product/${payload.requestedId}`) throw Error('Product save effects business source invalid');
    let action: unknown;
    try { action = JSON.parse(audit.action); } catch { throw Error('Product save effects audit invalid'); }
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw Error('Product save effects audit invalid');
    const row = action as Record<string, unknown>;
    if (row.operation !== 'save' || row.productId !== payload.productId || row.requestedId !== payload.requestedId
      || row.warning !== payload.warning) throw Error('Product save effects audit identity invalid');
    if (!payload.warning || product.isPolices !== 1) return [] as StaffPrincipal[];
    const admins = await tx.select().from(systemAdmin).where(and(eq(systemAdmin.adminType, 1), eq(systemAdmin.relationId, 0),
      eq(systemAdmin.status, 1), eq(systemAdmin.isDel, 0))).limit(1001);
    if (admins.length > 1000) throw Error('Product save notification capacity exceeded');
    const permissions = new AdminPermissionService(createContainerFromDb(tx)), targets: StaffPrincipal[] = [];
    for (const admin of admins) {
      if (!Number.isInteger(admin.level) || admin.level < 0 || admin.level > 9) throw Error('Product save notification authority invalid');
      await loadAdminLegacyRoleReferenceHistory(tx, parseAdminAuthorityRoleIds(admin.roles), admin.level);
      if (hasAdminPermission(await permissions.resolveAdminPermissionKeys(admin), 'product.view'))
        targets.push({ audience: 'admin', id: admin.id, scope: 'product_stock' });
    }
    return targets;
  });
  // This helper performs only the proven global product/SKU tag eviction; its
  // recycle delivery/audit parser is deliberately not reused.
  await clearProductRecycleTags(env);
  const relationKeys = productSaveRelationCacheKeys(payload.productId);
  const redis = getRedis(env);
  if (!redis) throw Error('Product save cache binding unavailable');
  const deleted: unknown = await redis.del(...relationKeys.map(key => `${env.REDIS_PREFIX ?? ''}${key}`));
  if (typeof deleted !== 'number' || !Number.isInteger(deleted) || deleted < 0 || deleted > relationKeys.length)
    throw Error('Product save relation cache receipt invalid');
  await Promise.all([...productStockCacheKeys(payload.productId), ...relationKeys].map(key => cacheDelete(key, env)));
  if (!targets.length) return;
  if (!env.STAFF_NOTICE) throw Error('Product save notification binding unavailable');
  for (let index = 0; index < targets.length; index += 5) {
    const results = await Promise.allSettled(targets.slice(index, index + 5).map(target =>
      env.STAFF_NOTICE!.getByName(staffPrincipalName(target)).publish(target, event.eventKey)));
    if (results.some(result => result.status === 'rejected')) throw Error('Product save notification delivery unconfirmed');
  }
}
