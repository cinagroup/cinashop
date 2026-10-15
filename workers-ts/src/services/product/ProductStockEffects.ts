import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrderOutbox, storeProduct, systemAdmin, systemLog, type StoreOrderOutbox } from '@/models/schema';
import { AdminPermissionService, hasAdminPermission } from '@/services/admin/AdminPermissionService';
import { loadAdminLegacyRoleReferenceHistory } from '@/services/admin/AdminLegacyRoleDeletionProof';
import { parseAdminAuthorityRoleIds } from '@/services/admin/AdminAuthorityWriteService';
import { staffPrincipalName, type StaffPrincipal } from '@/services/notification/StaffNotificationProtocol';
import type { StaffPublisher } from '@/services/notification/StaffNotificationDeliveryService';
import { cacheDelete, type RedisEnv } from '@/utils/cache';

export const PRODUCT_STOCK_EFFECTS_EVENT = 'product.stock.effects';
export interface ProductStockEffectsPayload { productId: number; auditId: number; warning: boolean }
export interface ProductStockEffectsEnvironment extends RedisEnv { STAFF_NOTICE?: StaffPublisher }
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
function canonical(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, ordered(value)])) : item;
  return JSON.stringify(ordered(value));
}
export function parseProductStockEffectsPayload(value: unknown): ProductStockEffectsPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Stock effects payload invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || !positive(row.productId) || !positive(row.auditId) || typeof row.warning !== 'boolean') throw Error('Stock effects payload invalid');
  return { productId: row.productId, auditId: row.auditId, warning: row.warning };
}
export function productStockCacheKeys(productId: number): string[] {
  if (!positive(productId)) throw Error('Stock effects product id invalid');
  // Current TS detail reads have no assembled cache. These are explicit legacy
  // cleanup keys, including ordinary PHP SKU/detail keys, not a Redis KEYS scan.
  return [...Array.from({ length: 8 }, (_, type) => type ? `product_info_${productId}_${type}` : `product_info_${productId}`),
    `attr_${productId}_0_0`, `attr_${productId}_0_${productId}`, `attr_value_${productId}_0`, `attr_sku_${productId}_0`];
}
/** Intent, inventory and moderation audit commit together. A new adjustment
 * gets a new event key; transport retries remain distinct relative writes. */
export async function enqueueProductStockEffects(tx: DbClient, input: ProductStockEffectsPayload, now: number): Promise<StoreOrderOutbox> {
  const payload = parseProductStockEffectsPayload(input);
  if (!Number.isSafeInteger(now) || now < 0 || now > 2_147_483_647) throw Error('Stock effects clock invalid');
  const eventKey = `${PRODUCT_STOCK_EFFECTS_EVENT}:${payload.productId}:${randomUUID()}`;
  const rows = await tx.insert(storeOrderOutbox).values({ eventKey, aggregateType: 'product', aggregateId: payload.productId,
    eventType: PRODUCT_STOCK_EFFECTS_EVENT, payload, status: 'PENDING', availableTime: now, addTime: now, updateTime: now }).returning();
  const row = rows[0];
  const expected = { eventKey, aggregateType: 'product', aggregateId: payload.productId, eventType: PRODUCT_STOCK_EFFECTS_EVENT,
    payload, status: 'PENDING', dispatchCount: 0, attemptCount: 0, replayCount: 0, availableTime: now, leaseUntil: 0, leaseToken: '',
    lastError: '', enqueuedTime: 0, processedTime: 0, addTime: now, updateTime: now };
  const matches = (value: StoreOrderOutbox | undefined) => !!value && positive(value.id) && Object.keys(value).length === Object.keys(expected).length + 1
    && Object.entries(expected).every(([key, wanted]) => canonical(value[key as keyof typeof expected]) === canonical(wanted));
  if (rows.length !== 1 || !matches(row)) throw Error('Stock effects intent full receipt inconsistent');
  const [readBack] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, row.id)).limit(1);
  if (!matches(readBack)) throw Error('Stock effects intent full readback inconsistent');
  return row;
}
/** Existing Queue leases/retry scanner calls this outside all inventory locks.
 * Missing provider bindings and partial RPC failures keep the intent retryable. */
export async function deliverProductStockEffects(container: Container, env: ProductStockEffectsEnvironment, event: StoreOrderOutbox): Promise<void> {
  const payload = parseProductStockEffectsPayload(event.payload);
  if (event.eventType !== PRODUCT_STOCK_EFFECTS_EVENT || event.aggregateType !== 'product' || event.aggregateId !== payload.productId
    || !new RegExp(`^product\\.stock\\.effects:${payload.productId}:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).test(event.eventKey)) throw Error('Stock effects event identity invalid');
  const targets = await withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, payload.productId)).limit(1);
    const [audit] = await tx.select().from(systemLog).where(eq(systemLog.id, payload.auditId)).limit(1);
    if (!product || !audit || audit.type !== 'product_stock_adjustment' || audit.method !== 'PUT' || audit.path !== `product/product/saveStocks/${payload.productId}`) throw Error('Stock effects business source invalid');
    let action: unknown;
    try { action = JSON.parse(audit.action); } catch { throw Error('Stock effects audit action invalid'); }
    if (!action || typeof action !== 'object' || (action as Record<string, unknown>).productId !== payload.productId
      || (action as Record<string, unknown>).operation !== 'saveStocks') throw Error('Stock effects audit identity invalid');
    // A recovered product does not receive a stale warning. Cache cleanup still runs.
    if (!payload.warning || product.isPolices !== 1) return [] as StaffPrincipal[];
    const admins = await tx.select().from(systemAdmin).where(and(eq(systemAdmin.adminType, 1), eq(systemAdmin.relationId, 0), eq(systemAdmin.status, 1), eq(systemAdmin.isDel, 0))).limit(1001);
    if (admins.length > 1000) throw Error('Stock notification target capacity exceeded');
    const permissions = new AdminPermissionService(createContainerFromDb(tx)), result: StaffPrincipal[] = [];
    for (const admin of admins) {
      if (!Number.isInteger(admin.level) || admin.level < 0 || admin.level > 9) throw Error('Stock notification target authority invalid');
      await loadAdminLegacyRoleReferenceHistory(tx, parseAdminAuthorityRoleIds(admin.roles), admin.level);
      const keys = await permissions.resolveAdminPermissionKeys(admin);
      if (hasAdminPermission(keys, 'product.view')) result.push({ audience: 'admin', id: admin.id, scope: 'product_stock' });
    }
    return result;
  });
  await Promise.all(productStockCacheKeys(payload.productId).map(key => cacheDelete(key, env)));
  if (!targets.length) return;
  if (!env.STAFF_NOTICE) throw Error('Stock realtime notification binding unavailable');
  for (let start = 0; start < targets.length; start += 5) {
    const results = await Promise.allSettled(targets.slice(start, start + 5).map(target => env.STAFF_NOTICE!.getByName(staffPrincipalName(target)).publish(target, event.eventKey)));
    if (results.some(result => result.status === 'rejected')) throw Error('Stock realtime notification delivery unconfirmed');
  }
}
